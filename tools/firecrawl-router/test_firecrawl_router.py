from __future__ import annotations

import importlib.util
import json
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch


MODULE_PATH = Path(__file__).with_name("server.py")
SPEC = importlib.util.spec_from_file_location("firecrawl_router_server", MODULE_PATH)
server = importlib.util.module_from_spec(SPEC)
assert SPEC and SPEC.loader
SPEC.loader.exec_module(server)


class FirecrawlRouterTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        root = Path(self.temp_dir.name)
        server.POOL_PATH = root / "pool.json"
        server.STATE_PATH = root / "state.json"
        server.POOL_PATH.write_text(json.dumps({
            "rotation_policy": {"transient_error_cooldown_seconds": 30},
            "keys": [
                {"alias": "a", "api_key": "fc-a", "enabled": True},
                {"alias": "b", "api_key": "fc-b", "enabled": True},
            ],
        }), encoding="utf-8")

    def tearDown(self) -> None:
        self.temp_dir.cleanup()

    def test_error_categories_distinguish_rate_and_credits(self) -> None:
        self.assertEqual("rate_limit", server.classify_error("HTTP 429 too many requests", 1))
        self.assertEqual("credits_exhausted", server.classify_error("credits exhausted", 1))
        self.assertEqual(75, server.retry_after_seconds("Retry-After: 75"))

    def test_timeout_rotates_to_next_key(self) -> None:
        timeout = subprocess.TimeoutExpired(cmd="firecrawl", timeout=2)
        success = subprocess.CompletedProcess(args=["firecrawl"], returncode=0,
                                              stdout='{"data":"ok"}', stderr="")
        with patch.object(server.shutil, "which", return_value="firecrawl"), \
                patch.object(server.subprocess, "run", side_effect=[timeout, success]):
            result = server.run_firecrawl(["scrape", "https://example.com"], timeout=2)
        self.assertTrue(result["ok"])
        self.assertEqual("b", result["used_key_alias"])
        self.assertEqual(["transient", "ok"], [attempt["reason"] for attempt in result["attempts"]])
        state = json.loads(server.STATE_PATH.read_text(encoding="utf-8"))
        self.assertGreater(state["keys"]["a"]["cooldown_until"], server.now())

    def test_state_write_is_atomic_and_readable(self) -> None:
        server.save_state({"cursor": 1, "keys": {"a": {"last_reason": "ok"}}})
        self.assertEqual(1, server.load_state()["cursor"])
        self.assertFalse(list(server.STATE_PATH.parent.glob("*.tmp")))


if __name__ == "__main__":
    unittest.main()
