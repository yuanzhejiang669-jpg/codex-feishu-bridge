from __future__ import annotations

import json
import importlib.util
import io
import os
import tempfile
import unittest
import urllib.error
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import patch

from tavily_router_core import TavilyRouter, TavilyRouterError


class TavilyRouterTest(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        root = Path(self.temp_dir.name)
        self.pool_path = root / "pool.json"
        self.state_path = root / "state.json"
        self.pool_path.write_text(json.dumps({
            "rotation_policy": {
                "rate_limit_cooldown_seconds": 60,
                "transient_error_cooldown_seconds": 30,
                "usage_cache_ttl_seconds": 900,
            },
            "keys": [
                {"alias": "a", "api_key": "key-a", "enabled": True},
                {"alias": "b", "api_key": "key-b", "enabled": True},
            ],
        }), encoding="utf-8")
        self.router = TavilyRouter(self.pool_path, self.state_path)

    def tearDown(self) -> None:
        self.temp_dir.cleanup()

    def test_rate_limit_is_not_quota_exhaustion(self) -> None:
        self.assertEqual("rate_limited", self.router._categorize_http_error(429, "too many requests"))
        self.assertEqual("quota_exhausted", self.router._categorize_http_error(429, "USAGE_LIMIT_EXCEEDED"))
        cooldown = self.router._cooldown_for_category("rate_limited", retry_after_seconds=3)
        delta = datetime.fromisoformat(cooldown) - datetime.now(timezone.utc)
        self.assertGreater(delta.total_seconds(), 1)
        self.assertLessEqual(delta.total_seconds(), 3)

    def test_search_respects_basic_depth_and_rotates_after_success(self) -> None:
        captured = {}

        def perform(api_key, *, payload, timeout):
            captured.update(payload)
            return {"results": [{"url": "https://example.com"}]}

        with patch.object(self.router, "_perform_request", side_effect=perform):
            result = self.router.search(query="example", search_depth="basic")
        self.assertEqual("basic", captured["search_depth"])
        self.assertEqual("a", result["used_key_alias"])
        state = json.loads(self.state_path.read_text(encoding="utf-8"))
        self.assertEqual(["b", "a"], state["order"])

    def test_pool_status_refreshes_bounded_usage(self) -> None:
        response = {"account": {"current_plan": "Researcher", "plan_usage": 900, "plan_limit": 1000}}
        with patch.object(self.router, "_perform_usage_request", return_value=response) as mocked:
            status = self.router.pool_status(refresh=True, refresh_limit=1)
        self.assertEqual(1, mocked.call_count)
        self.assertEqual(1, status["known_usage_key_count"])
        self.assertEqual(100, status["known_remaining_credits"])

    def test_cached_status_returns_without_usage_request(self) -> None:
        with patch.object(self.router, "_perform_usage_request") as request:
            result = self.router.pool_status(refresh=False)
        request.assert_not_called()
        self.assertIsInstance(result, dict)
        self.assertEqual(2, result["enabled_key_count"])
        self.assertEqual([], result["refresh_attempts"])

    def test_all_error_paths_redact_pool_environment_and_token_patterns(self) -> None:
        pool = json.loads(self.pool_path.read_text(encoding="utf-8"))
        pool["keys"].append({"alias": "disabled", "api_key": "disabled-pool-secret", "enabled": False})
        self.pool_path.write_text(json.dumps(pool), encoding="utf-8")
        secrets = ["key-a", "key-b", "disabled-pool-secret", "environment-secret",
                   "tvly-leak123456", "fc-leak123456", "tok1", "tok2", "tok3", "tok4"]
        detail = " ".join(secrets[:6]) + " Authorization: Bearer tok1 Bearer tok2 TAVILY_API_KEY=tok3 --api-key tok4"
        for kind in ["http", "generic", "refresh"]:
            with self.subTest(kind=kind):
                self.state_path.unlink(missing_ok=True)
                failure = urllib.error.HTTPError("https://example.invalid", 400, "bad request", {}, io.BytesIO(detail.encode())) if kind == "http" else RuntimeError(detail)
                with patch.dict(os.environ, {"TAVILY_API_KEY": "environment-secret"}):
                    if kind == "refresh":
                        with patch.object(self.router, "_perform_usage_request", side_effect=failure):
                            result = self.router.pool_status(refresh=True)
                        output = json.dumps(result)
                        self.assertEqual(2, len(result["refresh_attempts"]))
                    else:
                        with patch.object(self.router, "_perform_request", side_effect=failure):
                            with self.assertRaises(TavilyRouterError) as caught:
                                self.router.search(query="fixture")
                        output = str(caught.exception)
                    output += self.state_path.read_text(encoding="utf-8")
                for secret in secrets:
                    self.assertNotIn(secret, output)
                self.assertIn("[REDACTED]", output)

    def test_server_exports_the_shared_sanitizer(self) -> None:
        spec = importlib.util.spec_from_file_location("tavily_mcp_server_fixture", Path(__file__).with_name("server.py"))
        server = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(server)
        self.assertEqual("Bearer [REDACTED]", server.sanitize("Bearer opaque-value"))

    def test_usage_exhaustion_removes_key_from_available_set(self) -> None:
        response = {"account": {"current_plan": "Researcher", "plan_usage": 1000, "plan_limit": 1000}}
        with patch.object(self.router, "_perform_usage_request", return_value=response):
            self.router.pool_status(refresh=True, refresh_limit=1)
        pool = self.router._load_pool()
        state = self.router._load_state(pool)
        self.assertEqual("quota_exhausted", state["key_status"]["a"]["last_result"])
        self.assertEqual(["b"], self.router._ordered_available_aliases(pool, state))


if __name__ == "__main__":
    unittest.main()
