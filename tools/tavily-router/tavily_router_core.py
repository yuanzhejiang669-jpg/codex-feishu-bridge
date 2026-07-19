from __future__ import annotations

import json
import os
import sys
import tempfile
import threading
import urllib.error
import urllib.request
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any


TOOLS_ROOT = Path(__file__).resolve().parents[1]
if str(TOOLS_ROOT) not in sys.path:
    sys.path.insert(0, str(TOOLS_ROOT))

from router_file_lock import interprocess_file_lock


TAVILY_URL = "https://api.tavily.com/search"
TAVILY_USAGE_URL = "https://api.tavily.com/usage"
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
        self._lock = threading.RLock()

    def search(self, *, query: str, search_depth: str = "advanced", max_results: int = 5,
               include_answer: bool = True, include_raw_content: bool = False,
               include_images: bool = False, timeout: float = 30.0) -> dict[str, Any]:
        query = query.strip()
        if not query:
            raise ValueError("query is required")
        if search_depth not in {"basic", "advanced"}:
            raise ValueError("search_depth must be 'basic' or 'advanced'")
        if max_results < 1:
            raise ValueError("max_results must be at least 1")
        pool = self._load_pool()
        payload = {"query": query, "search_depth": search_depth, "max_results": max_results,
                   "include_answer": include_answer, "include_raw_content": include_raw_content,
                   "include_images": include_images}
        tried: list[dict[str, Any]] = []
        attempted: set[str] = set()
        while len(attempted) < len(pool):
            alias = self._take_next_alias(pool, attempted)
            if alias is None:
                break
            attempted.add(alias)
            key = pool[alias]
            try:
                body = self._perform_request(key.api_key, payload=payload, timeout=timeout)
                self._mutate_state(pool, lambda state: self._mark_success(state, alias))
                return {"results": body.get("results", body), "raw_response": body,
                        "used_key_alias": alias, "attempts": tried + [{"alias": alias, "status": "success"}]}
            except urllib.error.HTTPError as exc:
                error_body = exc.read().decode("utf-8", errors="replace")
                category = self._categorize_http_error(exc.code, error_body)
                retry_after = self._retry_after_seconds(exc.headers)
                tried.append({"alias": alias, "status": category, "http_status": exc.code,
                              "retry_after_seconds": retry_after, "detail": error_body})
                self._mutate_state(pool, lambda state: self._mark_failure(
                    state, alias, category=category, detail=error_body,
                    retry_after_seconds=retry_after))
                if category in {"quota_exhausted", "rate_limited", "auth_error", "transient_error"}:
                    continue
                raise TavilyRouterError(f"Tavily request failed for {alias}: HTTP {exc.code}: {error_body}") from exc
            except Exception as exc:
                detail = str(exc)
                tried.append({"alias": alias, "status": "transient_error", "detail": detail})
                self._mutate_state(pool, lambda state: self._mark_failure(
                    state, alias, category="transient_error", detail=detail))
        if not tried:
            raise TavilyNoAvailableKeyError("No enabled Tavily keys are currently available in the pool.")
        raise TavilyNoAvailableKeyError(json.dumps({"error": "All Tavily keys failed", "attempts": tried}, ensure_ascii=False))

    def pool_status(self, *, refresh: bool = False, refresh_limit: int = 10,
                    timeout: float = 20.0) -> dict[str, Any]:
        """Return cached pool health and optionally refresh a bounded number of stale usage records."""
        pool = self._load_pool()
        state = self._state_snapshot(pool)
        refresh_attempts: list[dict[str, Any]] = []
        if refresh:
            limit = max(1, min(int(refresh_limit), 10))
            stale = [alias for alias in state["order"] if pool[alias].enabled and pool[alias].api_key
                     and self._usage_is_stale(state["key_status"][alias])]
            for alias in stale[:limit]:
                try:
                    usage = self._perform_usage_request(pool[alias].api_key, timeout=timeout)
                    self._mutate_state(pool, lambda current, alias=alias, usage=usage:
                                       self._record_usage(current, alias, usage))
                    refresh_attempts.append({"alias": alias, "status": "success"})
                except urllib.error.HTTPError as exc:
                    body = exc.read().decode("utf-8", errors="replace")
                    category = self._categorize_http_error(exc.code, body)
                    refresh_attempts.append({"alias": alias, "status": category,
                                             "http_status": exc.code,
                                             "retry_after_seconds": self._retry_after_seconds(exc.headers)})
                    if exc.code == 429:
                        break
                except Exception as exc:
                    refresh_attempts.append({"alias": alias, "status": "transient_error",
                                             "detail": str(exc)[:500]})
            state = self._state_snapshot(pool)
            current = datetime.now(timezone.utc)
            keys = []
            for alias in state["order"]:
                entry, status = pool[alias], state["key_status"][alias]
                if not entry.enabled or not entry.api_key:
                    continue
                cooldown = self._parse_iso(status.get("cooldown_until"))
                usage = status.get("usage") if isinstance(status.get("usage"), dict) else {}
                keys.append({"alias": alias, "last_result": status.get("last_result", "unknown"),
                             "cooldown_seconds_remaining": max(0, int((cooldown - current).total_seconds())) if cooldown else 0,
                             "usage_checked_at": usage.get("checked_at"), "current_plan": usage.get("current_plan"),
                             "plan_usage": usage.get("plan_usage"), "plan_limit": usage.get("plan_limit"),
                             "remaining_credits": usage.get("remaining_credits")})
            known_remaining = [item["remaining_credits"] for item in keys
                               if isinstance(item.get("remaining_credits"), (int, float))]
            return {"enabled_key_count": len(keys), "known_usage_key_count": len(known_remaining),
                    "known_remaining_credits": int(sum(known_remaining)), "keys": keys,
                    "refresh_attempts": refresh_attempts}

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

    def _take_next_alias(self, pool: dict[str, KeyEntry], attempted: set[str]) -> str | None:
        def take(state: dict[str, Any]) -> str | None:
            aliases = [alias for alias in self._ordered_available_aliases(pool, state) if alias not in attempted]
            if not aliases:
                return None
            alias = aliases[0]
            self._move_to_end(state["order"], alias)
            return alias
        return self._mutate_state(pool, take)

    def _state_snapshot(self, pool: dict[str, KeyEntry]) -> dict[str, Any]:
        return self._mutate_state(pool, lambda state: state.copy())

    def _mutate_state(self, pool: dict[str, KeyEntry], mutate: Any) -> Any:
        with self._lock, interprocess_file_lock(self.state_path):
            state = self._load_state(pool)
            self._reset_state_for_new_period_if_needed(state)
            result = mutate(state)
            self._write_state(state)
            return result

    def _perform_request(self, api_key: str, *, payload: dict[str, Any], timeout: float) -> dict[str, Any]:
        req = urllib.request.Request(TAVILY_URL, data=json.dumps(payload).encode("utf-8"),
                                     headers={"Content-Type": "application/json", "Authorization": f"Bearer {api_key}",
                                              "Accept": "application/json"}, method="POST")
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read().decode("utf-8"))

    def _perform_usage_request(self, api_key: str, *, timeout: float) -> dict[str, Any]:
        req = urllib.request.Request(TAVILY_USAGE_URL,
                                     headers={"Authorization": f"Bearer {api_key}", "Accept": "application/json"},
                                     method="GET")
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read().decode("utf-8"))

    def _categorize_http_error(self, status_code: int, error_body: str) -> str:
        body_upper = error_body.upper()
        quota_markers = ("USAGE_LIMIT_EXCEEDED", "QUOTA EXCEEDED", "QUOTA_EXCEEDED",
                         "OUT OF CREDITS", "CREDITS EXHAUSTED")
        if status_code in {402, 432} or any(marker in body_upper for marker in quota_markers):
            return "quota_exhausted"
        if status_code == 429:
            return "rate_limited"
        if status_code in {401, 403}:
            return "auth_error"
        if status_code >= 500:
            return "transient_error"
        return "http_error"

    def _mark_success(self, state: dict[str, Any], alias: str) -> None:
        state["key_status"][alias].update({"last_result": "success", "last_success_at": self._now_iso(),
                                            "last_error": None, "last_error_at": None, "cooldown_until": None})

    def _mark_failure(self, state: dict[str, Any], alias: str, *, category: str, detail: str,
                      retry_after_seconds: int | None = None) -> None:
        state["key_status"][alias].update({"last_result": category, "last_error": detail[:2000],
                                            "last_error_at": self._now_iso(),
                                            "cooldown_until": self._cooldown_for_category(
                                                category, retry_after_seconds=retry_after_seconds)})
        self._move_to_end(state["order"], alias)

    def _cooldown_for_category(self, category: str, *, retry_after_seconds: int | None = None) -> str | None:
        now = datetime.now(timezone.utc)
        if category == "quota_exhausted":
            return self._next_period_start_iso()
        if category == "rate_limited":
            seconds = retry_after_seconds if retry_after_seconds is not None else self._policy_seconds(
                "rate_limit_cooldown_seconds", 60)
            return (now + timedelta(seconds=max(1, seconds))).isoformat()
        if category == "auth_error":
            return (now + timedelta(seconds=self._policy_seconds("auth_error_cooldown_seconds", 259200))).isoformat()
        if category == "transient_error":
            return (now + timedelta(seconds=self._policy_seconds("transient_error_cooldown_seconds", 60))).isoformat()
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
                               "last_error": None, "last_error_at": None, "usage": None})

    def _save_state(self, state: dict[str, Any]) -> None:
        with self._lock, interprocess_file_lock(self.state_path):
            self._write_state(state)

    def _write_state(self, state: dict[str, Any]) -> None:
        self.state_path.parent.mkdir(parents=True, exist_ok=True)
        with tempfile.NamedTemporaryFile("w", encoding="utf-8", delete=False,
                                         dir=self.state_path.parent, suffix=".tmp") as tmp:
            json.dump(state, tmp, ensure_ascii=False, indent=2)
            tmp.flush()
            os.fsync(tmp.fileno())
            temp_name = tmp.name
        os.replace(temp_name, self.state_path)

    def _current_period(self) -> str:
        now = datetime.now(timezone.utc)
        return f"{now.year:04d}-{now.month:02d}"

    def _next_period_start_iso(self) -> str:
        now = datetime.now(timezone.utc)
        next_month = datetime(now.year + 1, 1, 1, tzinfo=timezone.utc) if now.month == 12 else datetime(now.year, now.month + 1, 1, tzinfo=timezone.utc)
        return next_month.isoformat()

    def _now_iso(self) -> str:
        return datetime.now(timezone.utc).isoformat()

    def _empty_status(self) -> dict[str, Any]:
        return {"last_result": "unknown", "cooldown_until": None, "last_error": None,
                "last_error_at": None, "last_success_at": None, "usage": None}

    def _record_usage(self, state: dict[str, Any], alias: str, response: dict[str, Any]) -> None:
        account = response.get("account") if isinstance(response, dict) else None
        if not isinstance(account, dict):
            raise TavilyRouterError("Tavily usage response did not contain account data")
        limit, used = account.get("plan_limit"), account.get("plan_usage")
        remaining = int(limit) - int(used or 0) if limit is not None else None
        state["key_status"][alias]["usage"] = {
            "checked_at": self._now_iso(), "current_plan": account.get("current_plan"),
            "plan_usage": used, "plan_limit": limit, "remaining_credits": remaining,
        }
        if remaining is not None and remaining <= 0:
            self._mark_failure(state, alias, category="quota_exhausted", detail="usage endpoint reports no credits")

    def _usage_is_stale(self, status: dict[str, Any]) -> bool:
        usage = status.get("usage") if isinstance(status.get("usage"), dict) else {}
        checked = self._parse_iso(usage.get("checked_at"))
        ttl = self._policy_seconds("usage_cache_ttl_seconds", 900)
        return checked is None or (datetime.now(timezone.utc) - checked).total_seconds() >= ttl

    def _policy_seconds(self, name: str, default: int) -> int:
        try:
            data = json.loads(self.pool_path.read_text(encoding="utf-8"))
            value = data.get("rotation_policy", {}).get(name, default)
            return max(0, int(value))
        except (OSError, TypeError, ValueError, json.JSONDecodeError):
            return default

    @staticmethod
    def _retry_after_seconds(headers: Any) -> int | None:
        if headers is None:
            return None
        value = headers.get("Retry-After")
        try:
            return max(0, int(value)) if value is not None else None
        except (TypeError, ValueError):
            return None

    @staticmethod
    def _parse_iso(value: Any) -> datetime | None:
        if not isinstance(value, str) or not value:
            return None
        try:
            return datetime.fromisoformat(value.replace("Z", "+00:00"))
        except ValueError:
            return None

    @staticmethod
    def _move_to_end(ordered_aliases: list[str], alias: str) -> None:
        if alias in ordered_aliases:
            ordered_aliases.remove(alias)
        ordered_aliases.append(alias)
