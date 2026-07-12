import json
import tempfile
import unittest
from pathlib import Path

import tavily_router_core as core


class TavilyRouterTests(unittest.TestCase):
    def test_default_paths_use_codex_mcp_data(self):
        root = Path.home() / "Documents" / "Codex" / "mcp-data"
        self.assertEqual(core.DEFAULT_POOL_PATH, root / "key-pools" / "tavily-key-pool.json")
        self.assertEqual(core.DEFAULT_STATE_PATH, root / "state" / "tavily-router-state.json")

    def test_load_pool_and_initialize_state(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            pool_path = root / "pool.json"
            pool_path.write_text(json.dumps({"keys": [{"alias": "one", "api_key": "secret", "enabled": True}]}), encoding="utf-8")
            router = core.TavilyRouter(pool_path, root / "state.json")
            pool = router._load_pool()
            state = router._load_state(pool)
            self.assertEqual(list(pool), ["one"])
            self.assertEqual(state["order"], ["one"])


if __name__ == "__main__":
    unittest.main()
