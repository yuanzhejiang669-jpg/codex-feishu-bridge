from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from mcp.server.fastmcp import FastMCP


TOOLS_ROOT = Path(__file__).resolve().parents[1]
if str(TOOLS_ROOT) not in sys.path:
    sys.path.insert(0, str(TOOLS_ROOT))

from router_file_lock import interprocess_file_lock


MCP_DATA_ROOT = Path.home() / "Documents" / "Codex" / "mcp-data"
DEFAULT_POOL_PATH = MCP_DATA_ROOT / "key-pools" / "firecrawl-key-pool.json"
DEFAULT_STATE_PATH = MCP_DATA_ROOT / "state" / "firecrawl-router-state.json"

POOL_PATH = Path(os.environ.get("FIRECRAWL_KEY_POOL_PATH", str(DEFAULT_POOL_PATH)))
STATE_PATH = Path(os.environ.get("FIRECRAWL_ROUTER_STATE_PATH", str(DEFAULT_STATE_PATH)))

mcp = FastMCP("firecrawl-router")
STATE_LOCK = threading.RLock()


def read_json(path: Path, fallback: Any) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8-sig"))
    except Exception:
        return fallback


def write_json(path: Path, data: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile("w", encoding="utf-8", delete=False,
                                     dir=path.parent, suffix=".tmp") as tmp:
        json.dump(data, tmp, ensure_ascii=False, indent=2)
        tmp.flush()
        os.fsync(tmp.fileno())
        temp_name = tmp.name
    os.replace(temp_name, path)


def now() -> float:
    return time.time()


def load_pool() -> dict[str, Any]:
    pool = read_json(POOL_PATH, {})
    keys = pool.get("keys") if isinstance(pool, dict) else []
    if not isinstance(keys, list):
        keys = []
    return {
        "version": pool.get("version", 1) if isinstance(pool, dict) else 1,
        "rotation_policy": pool.get("rotation_policy", {}) if isinstance(pool, dict) else {},
        "keys": keys,
    }


def load_state() -> dict[str, Any]:
    state = read_json(STATE_PATH, {})
    if not isinstance(state, dict):
        state = {}
    state.setdefault("cursor", 0)
    state.setdefault("keys", {})
    return state


def save_state(state: dict[str, Any]) -> None:
    with STATE_LOCK, interprocess_file_lock(STATE_PATH):
        write_json(STATE_PATH, state)


def state_snapshot() -> dict[str, Any]:
    with STATE_LOCK, interprocess_file_lock(STATE_PATH):
        return load_state()


def mutate_state(mutate: Any) -> Any:
    with STATE_LOCK, interprocess_file_lock(STATE_PATH):
        state = load_state()
        result = mutate(state)
        write_json(STATE_PATH, state)
        return result


def key_records() -> list[dict[str, Any]]:
    result: list[dict[str, Any]] = []
    for index, item in enumerate(load_pool().get("keys", [])):
        if not isinstance(item, dict) or not item.get("enabled", True):
            continue
        api_key = str(item.get("api_key") or "").strip()
        if api_key:
            result.append({"index": index, "alias": str(item.get("alias") or f"key-{index + 1}"), "api_key": api_key})
    for position, record in enumerate(result):
        record["position"] = position
    return result


def sanitize(text: str) -> str:
    clean = str(text or "")
    for record in key_records():
        clean = clean.replace(record["api_key"], "[REDACTED]")
    clean = re.sub(r"(?i)(authorization\s*[:=]\s*bearer\s+)\S+", r"\1[REDACTED]", clean)
    clean = re.sub(r"(?i)(api[_-]?key\s*[:=]\s*)\S+", r"\1[REDACTED]", clean)
    clean = re.sub(r"\bfc-[A-Za-z0-9_-]{8,}\b", "[REDACTED]", clean)
    return clean[-1200:]


def classify_error(output: str, exit_code: int) -> str:
    if exit_code == 0:
        return "ok"
    text = output.lower()
    if re.search(r"(?:http(?: status)?\s*)?429|rate[ -]?limit|too many requests", text):
        return "rate_limit"
    if re.search(r"(?:http(?: status)?\s*)?402|payment required|billing.*(?:failed|required)|past due", text):
        return "payment"
    if re.search(r"(?:http(?: status)?\s*)?(?:401|403)|unauthori[sz]ed|invalid api key|not authenticated|forbidden", text):
        return "auth"
    if re.search(r"insufficient (?:team )?credits?|credits? (?:exhausted|depleted)|quota (?:exceeded|exhausted)|out of credits?", text):
        return "credits_exhausted"
    if re.search(r"(?:http(?: status)?\s*)?5\d\d|timed? out|timeout|econnreset|econnrefused|temporary|network error|socket hang up", text):
        return "transient"
    return "transient"


def policy_seconds(name: str, default: int) -> int:
    env_names = {
        "rate_limit_cooldown_seconds": "FIRECRAWL_RATE_LIMIT_COOLDOWN_SECONDS",
        "transient_error_cooldown_seconds": "FIRECRAWL_TRANSIENT_ERROR_COOLDOWN_SECONDS",
        "credits_error_fallback_cooldown_seconds": "FIRECRAWL_CREDITS_FALLBACK_COOLDOWN_SECONDS",
        "auth_error_cooldown_seconds": "FIRECRAWL_AUTH_ERROR_COOLDOWN_SECONDS",
        "payment_error_cooldown_seconds": "FIRECRAWL_PAYMENT_ERROR_COOLDOWN_SECONDS",
    }
    value = load_pool().get("rotation_policy", {}).get(name, os.environ.get(env_names.get(name, ""), default))
    try:
        return max(0, int(value))
    except (TypeError, ValueError):
        return default


def parse_timestamp(value: Any) -> float | None:
    if isinstance(value, (int, float)):
        return float(value / 1000 if value > 10_000_000_000 else value)
    if isinstance(value, str) and value.strip():
        try:
            return datetime.fromisoformat(value.strip().replace("Z", "+00:00")).timestamp()
        except ValueError:
            return None
    return None


def find_value(data: Any, names: set[str]) -> Any:
    if isinstance(data, dict):
        for key, value in data.items():
            if key.lower() in names:
                return value
        for value in data.values():
            found = find_value(value, names)
            if found is not None:
                return found
    elif isinstance(data, list):
        for value in data:
            found = find_value(value, names)
            if found is not None:
                return found
    return None


def query_credit_usage(record: dict[str, Any], timeout: int = 20) -> dict[str, Any]:
    executable = shutil.which("firecrawl")
    if not executable:
        return {"ok": False, "error": "firecrawl CLI not found"}
    try:
        completed = subprocess.run(
            [executable, "credit-usage", "--json", "--api-key", record["api_key"]],
            text=True, encoding="utf-8", errors="replace", stdout=subprocess.PIPE,
            stderr=subprocess.PIPE, timeout=timeout, check=False,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        return {"ok": False, "error": sanitize(str(exc))}
    combined = (completed.stdout or "") + "\n" + (completed.stderr or "")
    if completed.returncode != 0:
        return {"ok": False, "exitCode": completed.returncode, "error": sanitize(completed.stderr or completed.stdout)}
    try:
        data = json.loads((completed.stdout or "").strip())
    except (TypeError, json.JSONDecodeError):
        return {"ok": False, "exitCode": completed.returncode, "error": sanitize(combined or "invalid credit-usage response")}
    return {
        "ok": True,
        "remainingCredits": find_value(data, {"remainingcredits", "remaining_credits"}),
        "planCredits": find_value(data, {"plancredits", "plan_credits"}),
        "billingPeriodEnd": find_value(data, {"billingperiodend", "billing_period_end"}),
    }


def retry_after_seconds(detail: str) -> int | None:
    match = re.search(r"(?i)retry-after\s*[:=]\s*(\d+)", detail or "")
    return int(match.group(1)) if match else None


def cooldown_until(category: str, record: dict[str, Any], detail: str = "") -> tuple[float, dict[str, Any] | None]:
    current = now()
    if category == "rate_limit":
        seconds = retry_after_seconds(detail)
        return current + (seconds if seconds is not None else policy_seconds("rate_limit_cooldown_seconds", 180)), None
    if category == "transient":
        return current + policy_seconds("transient_error_cooldown_seconds", 30), None
    if category == "credits_exhausted":
        usage = query_credit_usage(record)
        period_end = parse_timestamp(usage.get("billingPeriodEnd")) if usage.get("ok") else None
        if period_end and period_end > current:
            return period_end + 60, usage
        fallback = policy_seconds("credits_error_fallback_cooldown_seconds",
                                  policy_seconds("quota_error_cooldown_seconds", 21600))
        return current + fallback, usage
    if category in {"auth", "payment"}:
        return current + policy_seconds(f"{category}_error_cooldown_seconds", 86400), None
    return current, None


def eligible_keys(state: dict[str, Any]) -> tuple[list[dict[str, Any]], float | None]:
    records = key_records()
    if not records:
        raise RuntimeError(f"No enabled Firecrawl keys in pool: {POOL_PATH}")
    current = now()
    eligible = [r for r in records if float(state.get("keys", {}).get(r["alias"], {}).get("cooldown_until", 0) or 0) <= current]
    if eligible:
        return eligible, None
    return [], min(float(state.get("keys", {}).get(r["alias"], {}).get("cooldown_until", 0) or 0) for r in records)


def run_firecrawl(args: list[str], timeout: int = 120) -> dict[str, Any]:
    return _run_firecrawl_locked(args, timeout=timeout)


def _run_firecrawl_locked(args: list[str], timeout: int = 120) -> dict[str, Any]:
    executable = shutil.which("firecrawl")
    if not executable:
        raise RuntimeError("firecrawl CLI not found. Install with: npm install -g firecrawl-cli")
    records = key_records()
    def reserve_order(state: dict[str, Any]) -> tuple[list[dict[str, Any]], float | None]:
        keys, next_retry_at = eligible_keys(state)
        if not keys:
            return [], next_retry_at
        start_index = int(state.get("cursor", 0) or 0) % len(records)
        full_order = records[start_index:] + records[:start_index]
        eligible_aliases = {record["alias"] for record in keys}
        ordered = [record for record in full_order if record["alias"] in eligible_aliases]
        if ordered:
            state["cursor"] = (int(ordered[0]["position"]) + 1) % max(1, len(records))
        return ordered, next_retry_at
    ordered, next_retry_at = mutate_state(reserve_order)
    if not ordered:
        return {"ok": False, "used_key_alias": "", "attempts": [], "stdout": "", "stderr": "All keys are cooling down", "next_retry_at": next_retry_at}
    attempts: list[dict[str, Any]] = []
    for offset, record in enumerate(ordered):
        try:
            completed = subprocess.run(
                [executable, *args, "--api-key", record["api_key"]], text=True, encoding="utf-8",
                errors="replace", stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=timeout, check=False,
            )
            stdout, stderr, exit_code = completed.stdout or "", completed.stderr or "", completed.returncode
            category = classify_error(stderr + "\n" + stdout, exit_code)
        except subprocess.TimeoutExpired as exc:
            stdout = exc.stdout.decode("utf-8", errors="replace") if isinstance(exc.stdout, bytes) else (exc.stdout or "")
            stderr = exc.stderr.decode("utf-8", errors="replace") if isinstance(exc.stderr, bytes) else (exc.stderr or "")
            stderr = f"{stderr}\nfirecrawl CLI timed out after {timeout} seconds".strip()
            exit_code, category = -1, "transient"
        except OSError as exc:
            stdout, stderr, exit_code, category = "", str(exc), -1, "transient"
        attempt = {"alias": record["alias"], "exitCode": exit_code, "reason": category, "stderrTail": sanitize(stderr)}
        attempts.append(attempt)
        def record_attempt(state: dict[str, Any]) -> None:
            key_state = state.setdefault("keys", {}).setdefault(record["alias"], {})
            key_state.update({"last_used_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "last_exit_code": exit_code, "last_reason": category, "last_error_tail": sanitize(stderr)})
            if exit_code == 0:
                key_state["cooldown_until"] = 0
                key_state.pop("credit_status", None)
                state["cursor"] = (int(record["position"]) + 1) % max(1, len(records))
                return
            key_state["cooldown_until"], usage = cooldown_until(category, record, stderr + "\n" + stdout)
            if usage is not None:
                key_state["credit_status"] = usage
        mutate_state(record_attempt)
        if exit_code == 0:
            return {"ok": True, "used_key_alias": record["alias"], "attempts": attempts, "stdout": stdout, "stderr": sanitize(stderr), "next_retry_at": None}
    final_state = state_snapshot()
    next_retry = min(float(final_state.get("keys", {}).get(r["alias"], {}).get("cooldown_until", 0) or 0) for r in ordered)
    return {"ok": False, "used_key_alias": "", "attempts": attempts, "stdout": "", "stderr": attempts[-1]["stderrTail"] if attempts else "", "next_retry_at": next_retry}


def parse_output(text: str) -> Any:
    stripped = text.strip()
    if not stripped:
        return ""
    try:
        return json.loads(stripped)
    except Exception:
        return stripped


def tool_result(result: dict[str, Any]) -> dict[str, Any]:
    return {"ok": result["ok"], "used_key_alias": result["used_key_alias"], "attempts": result["attempts"], "data": parse_output(result["stdout"]), "stderr": result["stderr"], "next_retry_at": result.get("next_retry_at")}


@mcp.tool()
def firecrawl_scrape(url: str, formats: str = "markdown", only_main_content: bool = False, wait_for_ms: int = 0, max_age_ms: int = 0) -> dict[str, Any]:
    args = ["scrape", url, "--format", formats, "--json"]
    if only_main_content:
        args.append("--only-main-content")
    if wait_for_ms > 0:
        args.extend(["--wait-for", str(wait_for_ms)])
    if max_age_ms > 0:
        args.extend(["--max-age", str(max_age_ms)])
    return tool_result(run_firecrawl(args))


@mcp.tool()
def firecrawl_search(query: str, limit: int = 5, sources: str = "web", country: str = "US", scrape: bool = False) -> dict[str, Any]:
    args = ["search", query, "--limit", str(limit), "--sources", sources, "--country", country, "--json"]
    if scrape:
        args.append("--scrape")
    return tool_result(run_firecrawl(args))


@mcp.tool()
def firecrawl_map(url: str, limit: int = 20, search: str = "", include_subdomains: bool = False) -> dict[str, Any]:
    args = ["map", url, "--wait", "--limit", str(limit), "--json"]
    if search:
        args.extend(["--search", search])
    if include_subdomains:
        args.append("--include-subdomains")
    return tool_result(run_firecrawl(args))


@mcp.tool()
def firecrawl_pool_status() -> dict[str, Any]:
    state, records, current = state_snapshot(), key_records(), now()
    keys = []
    for record in records:
        key_state = state.get("keys", {}).get(record["alias"], {})
        usage = query_credit_usage(record)
        item = {
            "alias": record["alias"],
            "cooldown_seconds_remaining": max(0, int(float(key_state.get("cooldown_until", 0) or 0) - current)),
            "last_reason": key_state.get("last_reason", ""), "last_exit_code": key_state.get("last_exit_code"),
            "credit_status_ok": usage.get("ok", False),
        }
        if usage.get("ok"):
            item.update({key: usage.get(key) for key in ("remainingCredits", "planCredits", "billingPeriodEnd")})
        else:
            item["credit_status_error"] = usage.get("error", "status query failed")
        keys.append(item)
    return {"pool_path": str(POOL_PATH), "state_path": str(STATE_PATH), "enabled_key_count": len(records), "keys": keys}


if __name__ == "__main__":
    mcp.run()
