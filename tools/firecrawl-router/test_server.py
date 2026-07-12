import importlib.util
import json
import subprocess
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch


SPEC = importlib.util.spec_from_file_location("firecrawl_router", Path(__file__).with_name("server.py"))
router = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(router)


class FirecrawlRouterTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        root = Path(self.temp.name)
        router.POOL_PATH = root / "pool.json"
        router.STATE_PATH = root / "state.json"
        router.POOL_PATH.write_text(json.dumps({"rotation_policy": {"rate_limit_cooldown_seconds": 120, "transient_error_cooldown_seconds": 10}, "keys": [{"alias": "one", "api_key": "fc-secret-value"}, {"alias": "two", "api_key": "fc-other-secret"}]}))

    def tearDown(self):
        self.temp.cleanup()

    def test_error_classification(self):
        cases = [("HTTP 429 rate limit", "rate_limit"), ("insufficient credits", "credits_exhausted"), ("401 invalid api key", "auth"), ("402 payment required", "payment"), ("HTTP 503", "transient")]
        for output, expected in cases:
            self.assertEqual(router.classify_error(output, 1), expected)
        self.assertEqual(router.classify_error("", 0), "ok")

    def test_default_paths_use_codex_mcp_data(self):
        root = Path.home() / "Documents" / "Codex" / "mcp-data"
        self.assertEqual(router.DEFAULT_POOL_PATH, root / "key-pools" / "firecrawl-key-pool.json")
        self.assertEqual(router.DEFAULT_STATE_PATH, root / "state" / "firecrawl-router-state.json")

    def test_all_cooling_does_not_run(self):
        router.save_state({"cursor": 0, "keys": {"one": {"cooldown_until": 2000}, "two": {"cooldown_until": 3000}}})
        with patch.object(router, "now", return_value=1000), patch.object(router.shutil, "which", return_value="firecrawl"), patch.object(router.subprocess, "run") as run:
            result = router.run_firecrawl(["scrape", "https://example.com"])
        self.assertFalse(result["ok"])
        self.assertEqual(result["next_retry_at"], 2000)
        run.assert_not_called()

    def test_success_clears_stale_cooldown(self):
        router.save_state({"cursor": 0, "keys": {"one": {"cooldown_until": 900}}})
        completed = SimpleNamespace(returncode=0, stdout='{"ok":true}', stderr="")
        with patch.object(router, "now", return_value=1000), patch.object(router.shutil, "which", return_value="firecrawl"), patch.object(router.subprocess, "run", return_value=completed):
            self.assertTrue(router.run_firecrawl(["scrape", "https://example.com"])["ok"])
        self.assertEqual(router.load_state()["keys"]["one"]["cooldown_until"], 0)

    def test_credit_period_controls_cooldown(self):
        with patch.object(router, "now", return_value=1000), patch.object(router, "query_credit_usage", return_value={"ok": True, "billingPeriodEnd": 5000}):
            until, _ = router.cooldown_until("credits_exhausted", router.key_records()[0])
        self.assertEqual(until, 5060)

    def test_short_cooldowns_follow_policy(self):
        with patch.object(router, "now", return_value=1000):
            rate_until, _ = router.cooldown_until("rate_limit", router.key_records()[0])
            transient_until, _ = router.cooldown_until("transient", router.key_records()[0])
        self.assertEqual(rate_until, 1120)
        self.assertEqual(transient_until, 1010)

    def test_pool_status_degrades_per_key(self):
        statuses = [{"ok": True, "remainingCredits": 8, "planCredits": 10, "billingPeriodEnd": "2030-01-01T00:00:00Z"}, {"ok": False, "error": "timeout"}]
        with patch.object(router, "query_credit_usage", side_effect=statuses):
            result = router.firecrawl_pool_status()
        self.assertEqual(result["enabled_key_count"], 2)
        self.assertEqual(result["keys"][0]["remainingCredits"], 8)
        self.assertFalse(result["keys"][1]["credit_status_ok"])

    def test_diagnostics_never_leak_keys(self):
        completed = SimpleNamespace(returncode=1, stdout="", stderr="HTTP 429 api_key=fc-secret-value Authorization: Bearer token-value")
        with patch.object(router, "now", return_value=1000), patch.object(router.shutil, "which", return_value="firecrawl"), patch.object(router.subprocess, "run", return_value=completed):
            result = router.run_firecrawl(["scrape", "https://example.com"])
        serialized = json.dumps(result) + router.STATE_PATH.read_text()
        self.assertNotIn("fc-secret-value", serialized)
        self.assertNotIn("token-value", serialized)


if __name__ == "__main__":
    unittest.main()
