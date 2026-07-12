from __future__ import annotations

import json
import os
import tempfile
import threading
import urllib.error
import urllib.request
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any


TAVILY_URL = "https://api.tavily.com/search"
MCP_DATA_ROOT = Path.home() / "Documents" / "Codex" / "mcp-data"
DEFAULT_POOL_PATH = Path(os.environ.get("TAVILY_KEY_POOL_PATH", str(MCP_DATA_ROOT / "key-pools" / "tavily-key-pool.json")))
DEFAULT_STATE_PATH = Path(os.environ.get("TAVILY_ROUTER_STATE_PATH", str(MCP_DATA_ROOT / "state" / "tavily-router-state.json")))


class TavilyRouterError(RuntimeError):
    pass


class TavilyNoAvailableKeyError(TavilyRouterError):
    pass


@dataclass(slots=True)
class KeyEntry:
    alias: str
    api_key: str
    enabled: bool
    notes: str = ""


class TavilyRouter:
    def __init__(self, pool_path: Path | str | None = None, state_path: Path | str | None = None):
        self.pool_path = Path(pool_path) if pool_path else DEFAULT_POOL_PATH
        self.state_path = Path(state_path) if state_path else DEFAULT_STATE_PATH
        self._lock = threading.Lock()

    def search(self, *, query: str, search_depth: str = "advanced", max_results: int = 5,
               include_answer: bool = True, include_raw_content: bool = False,
               include_images: bool = False, timeout: float = 30.0) -> dict[str, Any]:
        query = query.strip()
        if not query:
            raise ValueError("query is required")
        pool = self._load_pool()
        state = self._load_state(pool)
        self._reset_state_for_new_period_if_needed(state)
        payload = {"query": query, "search_depth": search_depth, "max_results": max_results,
                   "include_answer": include_answer, "include_raw_content": include_raw_content,
                   "include_images": include_images}
        tried: list[dict[str, Any]] = []
        aliases = self._ordered_available_aliases(pool, state)
        if not aliases:
            raise TavilyNoAvailableKeyError("No enabled Tavily keys are currently available in the pool.")
        for alias in aliases:
            key = pool[alias]
            try:
                body = self._perform_request(key.api_key, payload=payload, timeout=timeout)
                self._mark_success(state, alias)
                self._save_state(state)
                return {"results": body.get("results", body), "raw_response": body,
                        "used_key_alias": alias, "attempts": tried + [{"alias": alias, "status": "success"}]}
            except urllib.error.HTTPError as exc:
                error_body = exc.read().decode("utf-8", errors="replace")
                category = self._categorize_http_error(exc.code, error_body)
                tried.append({"alias": alias, "status": category, "http_status": exc.code, "detail": error_body})
                self._mark_failure(state, alias, category=category, detail=error_body)
                self._save_state(state)
                if category in {"quota_exhausted", "auth_error", "transient_error"}:
                    continue
                raise TavilyRouterError(f"Tavily request failed for {alias}: HTTP {exc.code}: {error_body}") from exc
            except Exception as exc:
                detail = str(exc)
                tried.append({"alias": alias, "status": "transient_error", "detail": detail})
                self._mark_failure(state, alias, category="transient_error", detail=detail)
                self._save_state(state)
        raise TavilyNoAvailableKeyError(json.dumps({"error": "All Tavily keys failed", "attempts": tried}, ensure_ascii=False))

    def _load_pool(self) -> dict[str, KeyEntry]:
        data = json.loads(self.pool_path.read_text(encoding="utf-8"))
        return {str(item["alias"]): KeyEntry(alias=str(item["alias"]), api_key=str(item["api_key"]).strip(),
                                               enabled=bool(item.get("enabled", True)), notes=str(item.get("notes", "")))
                for item in data.get("keys", [])}

    def _load_state(self, pool: dict[str, KeyEntry]) -> dict[str, Any]:
        state = json.loads(self.state_path.read_text(encoding="utf-8")) if self.state_path.exists() else {
            "version": 1, "quota_period": self._current_period(), "order": [], "key_status": {}}
        order = [alias for alias in state.get("order", []) if alias in pool]
        order.extend(alias for alias in pool if alias not in order)
        state["order"] = order
        key_status = state.setdefault("key_status", {})
        for alias in pool:
            key_status.setdefault(alias, self._empty_status())
        for alias in list(key_status):
            if alias not in pool:
                del key_status[alias]
        state.setdefault("quota_period", self._current_period())
        return state

    def _ordered_available_aliases(self, pool: dict[str, KeyEntry], state: dict[str, Any]) -> list[str]:
        return [alias for alias in state["order"] if pool[alias].enabled and pool[alias].api_key
                and self._is_key_available_now(state["key_status"][alias], quota_period=state.get("quota_period"))]

    def _perform_request(self, api_key: str, *, payload: dict[str, Any], timeout: float) -> dict[str, Any]:
        req = urllib.request.Request(TAVILY_URL, data=json.dumps(payload).encode("utf-8"),
                                     headers={"Content-Type": "application/json", "Authorization": f"Bearer {api_key}",
                                              "Accept": "application/json"}, method="POST")
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read().decode("utf-8"))

    def _categorize_http_error(self, status_code: int, error_body: str) -> str:
        body_upper = error_body.upper()
        if "USAGE_LIMIT_EXCEEDED" in body_upper or "QUOTA" in body_upper or status_code in {402, 429, 432}:
            return "quota_exhausted"
        if status_code in {401, 403}:
            return "auth_error"
        if status_code >= 500:
            return "transient_error"
        return "http_error"

    def _mark_success(self, state: dict[str, Any], alias: str) -> None:
        state["key_status"][alias].update({"last_result": "success", "last_success_at": self._now_iso(),
                                            "last_error": None, "last_error_at": None, "cooldown_until": None})

    def _mark_failure(self, state: dict[str, Any], alias: str, *, category: str, detail: str) -> None:
        state["key_status"][alias].update({"last_result": category, "last_error": detail[:2000],
                                            "last_error_at": self._now_iso(),
                                            "cooldown_until": self._cooldown_for_category(category)})
        self._move_to_end(state["order"], alias)

    def _cooldown_for_category(self, category: str) -> str | None:
        now = datetime.now(UTC)
        if category == "quota_exhausted":
            return self._next_period_start_iso()
        if category == "auth_error":
            return (now + timedelta(days=3)).isoformat()
        if category == "transient_error":
            return (now + timedelta(minutes=1)).isoformat()
        return None

    def _is_key_available_now(self, status: dict[str, Any], *, quota_period: str | None) -> bool:
        if status.get("last_result") == "quota_exhausted" and quota_period == self._current_period():
            return False
        cooldown_until = status.get("cooldown_until")
        return not cooldown_until or cooldown_until <= self._now_iso()

    def _reset_state_for_new_period_if_needed(self, state: dict[str, Any]) -> None:
        current = self._current_period()
        if state.get("quota_period") == current:
            return
        state["quota_period"] = current
        for status in state["key_status"].values():
            if status.get("last_result") == "quota_exhausted":
                status.update({"last_result": "unknown", "cooldown_until": None,
                               "last_error": None, "last_error_at": None})

    def _save_state(self, state: dict[str, Any]) -> None:
        with self._lock:
            self.state_path.parent.mkdir(parents=True, exist_ok=True)
            with tempfile.NamedTemporaryFile("w", encoding="utf-8", delete=False,
                                             dir=self.state_path.parent, suffix=".tmp") as tmp:
                json.dump(state, tmp, ensure_ascii=False, indent=2)
                tmp.flush()
                os.fsync(tmp.fileno())
                temp_name = tmp.name
            os.replace(temp_name, self.state_path)

    def _current_period(self) -> str:
        now = datetime.now(UTC)
        return f"{now.year:04d}-{now.month:02d}"

    def _next_period_start_iso(self) -> str:
        now = datetime.now(UTC)
        next_month = datetime(now.year + 1, 1, 1, tzinfo=UTC) if now.month == 12 else datetime(now.year, now.month + 1, 1, tzinfo=UTC)
        return next_month.isoformat()

    def _now_iso(self) -> str:
        return datetime.now(UTC).isoformat()

    def _empty_status(self) -> dict[str, Any]:
        return {"last_result": "unknown", "cooldown_until": None, "last_error": None,
                "last_error_at": None, "last_success_at": None}

    @staticmethod
    def _move_to_end(ordered_aliases: list[str], alias: str) -> None:
        if alias in ordered_aliases:
            ordered_aliases.remove(alias)
        ordered_aliases.append(alias)
