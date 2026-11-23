import importlib.util
import json
import os
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

    def test_command_resolution_prefers_script_and_explicit_node(self):
        script = Path(self.temp.name) / "firecrawl.mjs"
        script.write_text("", encoding="utf-8")
        with patch.dict(os.environ, {"FIRECRAWL_CLI_SCRIPT": str(script), "FIRECRAWL_NODE_PATH": "explicit-node"}):
            with patch.object(router.shutil, "which") as which:
                self.assertEqual(["explicit-node", str(script)], router.firecrawl_command())
                which.assert_not_called()
            with patch.dict(os.environ, {"FIRECRAWL_NODE_PATH": ""}), patch.object(router.shutil, "which", return_value="path-node"):
                self.assertEqual(["path-node", str(script)], router.firecrawl_command())
            with patch.dict(os.environ, {"FIRECRAWL_NODE_PATH": ""}), patch.object(router.shutil, "which", return_value=None):
                self.assertIsNone(router.firecrawl_command())
        with patch.dict(os.environ, {"FIRECRAWL_CLI_SCRIPT": str(script) + ".missing"}):
            self.assertIsNone(router.firecrawl_command())
        with patch.dict(os.environ, {"FIRECRAWL_CLI_SCRIPT": "", "FIRECRAWL_NODE_PATH": ""}), patch.object(router.shutil, "which", return_value="firecrawl-bin"):
            self.assertEqual(["firecrawl-bin"], router.firecrawl_command())

    def test_api_keys_are_only_in_child_environment(self):
        record = router.key_records()[0]
        with patch.object(router, "firecrawl_command", return_value=["node", "fixture.mjs"]):
            with patch.object(router.subprocess, "run", return_value=SimpleNamespace(returncode=0, stdout='{"remainingCredits":10}', stderr="")) as run:
                self.assertTrue(router.query_credit_usage(record)["ok"])
                self.assertTrue(router.run_firecrawl(["search", "fixture"])["ok"])
        for call in run.call_args_list:
            self.assertEqual(record["api_key"], call.kwargs["env"]["FIRECRAWL_API_KEY"])
            self.assertNotIn(record["api_key"], call.args[0])
            self.assertNotIn("--api-key", call.args[0])
            self.assertEqual(["node", "fixture.mjs"], call.args[0][:2])

    def test_success_output_is_sanitized_before_returning_data(self):
        record = router.key_records()[0]
        completed = SimpleNamespace(returncode=0, stdout=json.dumps({"token": record["api_key"]}), stderr="")
        with patch.object(router, "firecrawl_command", return_value=["fixture"]), patch.object(router.subprocess, "run", return_value=completed):
            result = router.run_firecrawl(["search", "fixture"])
        self.assertNotIn(record["api_key"], result["stdout"])
        self.assertIn("[REDACTED]", result["stdout"])

    def test_large_success_json_is_sanitized_without_truncation(self):
        record = router.key_records()[0]
        payload = {"success": True, "data": {"markdown": "A" * 3200, "leaked": record["api_key"]}}
        big_json = json.dumps(payload)
        self.assertGreater(len(big_json), 3000)
        completed = SimpleNamespace(returncode=0, stdout=big_json, stderr="")
        with patch.object(router, "firecrawl_command", return_value=["fixture"]), patch.object(router.subprocess, "run", return_value=completed):
            result = router.tool_result(router.run_firecrawl(["scrape", "https://example.invalid"]))
        self.assertTrue(result["ok"])
        self.assertIsInstance(result["data"], dict)
        self.assertEqual(len(result["data"]["data"]["markdown"]), 3200)
        self.assertEqual(result["data"]["data"]["leaked"], "[REDACTED]")
        self.assertNotIn(record["api_key"], json.dumps(result))

    def test_all_error_paths_redact_disabled_environment_and_token_patterns(self):
        pool = json.loads(router.POOL_PATH.read_text())
        pool["keys"].append({"alias": "disabled", "api_key": "disabled-pool-secret", "enabled": False})
        router.POOL_PATH.write_text(json.dumps(pool), encoding="utf-8")
        secrets = ["fc-secret-value", "fc-other-secret", "disabled-pool-secret", "environment-secret",
                   "fc-leak123456", "tvly-leak123456", "tok1", "tok2", "tok3", "tok4", "caller-secret"]
        detail = " ".join(secrets[:6]) + " Authorization: Bearer tok1 Bearer tok2 FIRECRAWL_API_KEY=tok3 --api-key tok4 caller-secret"
        for kind in ["stderr", "oserror", "timeout", "invalid-json"]:
            with self.subTest(kind=kind):
                router.STATE_PATH.unlink(missing_ok=True)
                value = SimpleNamespace(returncode=0 if kind == "invalid-json" else 1, stdout=detail, stderr="" if kind == "invalid-json" else detail)
                failure = OSError(detail) if kind == "oserror" else subprocess.TimeoutExpired("fixture", 1, output=detail, stderr=detail) if kind == "timeout" else None
                with patch.dict(os.environ, {"FIRECRAWL_API_KEY": "environment-secret"}), patch.object(router, "firecrawl_command", return_value=["fixture"]):
                    with patch.object(router.subprocess, "run", return_value=value, side_effect=failure):
                        usage = router.query_credit_usage({"api_key": "caller-secret"})
                        output = json.dumps(usage)
                        if kind != "invalid-json":
                            # The caller secret is outside the active pool; each record must explicitly redact its own credential.
                            output += router.sanitize(detail, extra_secrets=("caller-secret",))
                            result = router.run_firecrawl(["search", "fixture"])
                            output += json.dumps(result) + router.STATE_PATH.read_text(encoding="utf-8")
                for secret in secrets:
                    if secret != "caller-secret" or kind == "invalid-json":
                        self.assertNotIn(secret, output)
                self.assertNotIn("caller-secret", json.dumps(usage))
                self.assertIn("[REDACTED]", output)


if __name__ == "__main__":
    unittest.main()
