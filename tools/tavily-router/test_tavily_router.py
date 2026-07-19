from __future__ import annotations

import json
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import patch

from tavily_router_core import TavilyRouter


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
