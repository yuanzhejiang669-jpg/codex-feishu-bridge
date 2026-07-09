from __future__ import annotations

import json
import os
import shutil
import subprocess
import time
from pathlib import Path
from typing import Any

from mcp.server.fastmcp import FastMCP


DEFAULT_POOL_PATH = Path.home() / ".proma" / "firecrawl-key-pool.json"
DEFAULT_STATE_PATH = Path.home() / ".proma" / "firecrawl-router-state.json"

POOL_PATH = Path(os.environ.get("FIRECRAWL_KEY_POOL_PATH", str(DEFAULT_POOL_PATH)))
STATE_PATH = Path(os.environ.get("FIRECRAWL_ROUTER_STATE_PATH", str(DEFAULT_STATE_PATH)))

mcp = FastMCP("firecrawl-router")


def read_json(path: Path, fallback: Any) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8-sig"))
    except Exception:
        return fallback


def write_json(path: Path, data: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")


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
    write_json(STATE_PATH, state)


def key_records() -> list[dict[str, Any]]:
    pool = load_pool()
    result: list[dict[str, Any]] = []
    for index, item in enumerate(pool.get("keys", [])):
        if not isinstance(item, dict) or not item.get("enabled", True):
            continue
        api_key = str(item.get("api_key") or "").strip()
        if not api_key:
            continue
        result.append(
            {
                "index": index,
                "alias": str(item.get("alias") or f"key-{index + 1}"),
                "api_key": api_key,
            }
        )
    return result


def cooldown_for_error(stderr: str, exit_code: int) -> tuple[str, int]:
    if exit_code == 0:
        return "ok", 0
    text = stderr.lower()
    policy = load_pool().get("rotation_policy", {})
    quota_seconds = int(policy.get("quota_error_cooldown_seconds", 259200))
    transient_seconds = int(policy.get("transient_error_cooldown_seconds", 60))
    if "rate limit" in text or "quota" in text or "credit" in text or "payment" in text:
        return "quota", quota_seconds
    if "unauthorized" in text or "invalid api key" in text or "not authenticated" in text or "forbidden" in text:
        return "auth", quota_seconds
    if exit_code != 0:
        return "transient", transient_seconds
    return "ok", 0


def eligible_keys(state: dict[str, Any]) -> list[dict[str, Any]]:
    records = key_records()
    if not records:
        raise RuntimeError(f"No enabled Firecrawl keys in pool: {POOL_PATH}")
    current = now()
    eligible: list[dict[str, Any]] = []
    for record in records:
        key_state = state.get("keys", {}).get(record["alias"], {})
        if float(key_state.get("cooldown_until", 0) or 0) <= current:
            eligible.append(record)
    return eligible or records


def run_firecrawl(args: list[str], timeout: int = 120) -> dict[str, Any]:
    executable = shutil.which("firecrawl")
    if not executable:
        raise RuntimeError("firecrawl CLI not found. Install with: npm install -g firecrawl-cli")

    state = load_state()
    keys = eligible_keys(state)
    start_index = int(state.get("cursor", 0) or 0) % len(keys)
    ordered = keys[start_index:] + keys[:start_index]
    attempts: list[dict[str, Any]] = []

    for offset, record in enumerate(ordered):
        command = [executable, *args, "--api-key", record["api_key"]]
        completed = subprocess.run(
            command,
            text=True,
            encoding="utf-8",
            errors="replace",
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=timeout,
            check=False,
        )
        stdout = completed.stdout or ""
        stderr = completed.stderr or ""
        reason, cooldown_seconds = cooldown_for_error(stderr + "\n" + stdout, completed.returncode)
        attempt = {
            "alias": record["alias"],
            "exitCode": completed.returncode,
            "reason": reason,
            "stderrTail": stderr[-1200:],
        }
        attempts.append(attempt)
        key_state = state.setdefault("keys", {}).setdefault(record["alias"], {})
        key_state["last_used_at"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        key_state["last_exit_code"] = completed.returncode
        key_state["last_reason"] = reason
        if completed.returncode == 0:
            key_state["cooldown_until"] = 0
            state["cursor"] = (start_index + offset + 1) % max(1, len(keys))
            save_state(state)
            return {
                "ok": True,
                "used_key_alias": record["alias"],
                "attempts": attempts,
                "stdout": stdout,
                "stderr": stderr,
            }
        if cooldown_seconds:
            key_state["cooldown_until"] = now() + cooldown_seconds
        save_state(state)

    return {
        "ok": False,
        "used_key_alias": "",
        "attempts": attempts,
        "stdout": "",
        "stderr": attempts[-1]["stderrTail"] if attempts else "",
    }


def parse_output(text: str) -> Any:
    stripped = text.strip()
    if not stripped:
        return ""
    try:
        return json.loads(stripped)
    except Exception:
        return stripped


@mcp.tool()
def firecrawl_scrape(
    url: str,
    formats: str = "markdown",
    only_main_content: bool = False,
    wait_for_ms: int = 0,
    max_age_ms: int = 0,
) -> dict[str, Any]:
    args = ["scrape", url, "--format", formats, "--json"]
    if only_main_content:
        args.append("--only-main-content")
    if wait_for_ms > 0:
        args.extend(["--wait-for", str(wait_for_ms)])
    if max_age_ms > 0:
        args.extend(["--max-age", str(max_age_ms)])
    result = run_firecrawl(args)
    return {
        "ok": result["ok"],
        "used_key_alias": result["used_key_alias"],
        "attempts": result["attempts"],
        "data": parse_output(result["stdout"]),
        "stderr": result["stderr"][-1200:],
    }


@mcp.tool()
def firecrawl_search(
    query: str,
    limit: int = 5,
    sources: str = "web",
    country: str = "US",
    scrape: bool = False,
) -> dict[str, Any]:
    args = ["search", query, "--limit", str(limit), "--sources", sources, "--country", country, "--json"]
    if scrape:
        args.append("--scrape")
    result = run_firecrawl(args)
    return {
        "ok": result["ok"],
        "used_key_alias": result["used_key_alias"],
        "attempts": result["attempts"],
        "data": parse_output(result["stdout"]),
        "stderr": result["stderr"][-1200:],
    }


@mcp.tool()
def firecrawl_map(
    url: str,
    limit: int = 20,
    search: str = "",
    include_subdomains: bool = False,
) -> dict[str, Any]:
    args = ["map", url, "--wait", "--limit", str(limit), "--json"]
    if search:
        args.extend(["--search", search])
    if include_subdomains:
        args.append("--include-subdomains")
    result = run_firecrawl(args)
    return {
        "ok": result["ok"],
        "used_key_alias": result["used_key_alias"],
        "attempts": result["attempts"],
        "data": parse_output(result["stdout"]),
        "stderr": result["stderr"][-1200:],
    }


@mcp.tool()
def firecrawl_pool_status() -> dict[str, Any]:
    state = load_state()
    records = key_records()
    current = now()
    return {
        "pool_path": str(POOL_PATH),
        "state_path": str(STATE_PATH),
        "enabled_key_count": len(records),
        "keys": [
            {
                "alias": record["alias"],
                "cooldown_seconds_remaining": max(
                    0,
                    int(float(state.get("keys", {}).get(record["alias"], {}).get("cooldown_until", 0) or 0) - current),
                ),
                "last_reason": state.get("keys", {}).get(record["alias"], {}).get("last_reason", ""),
                "last_exit_code": state.get("keys", {}).get(record["alias"], {}).get("last_exit_code", None),
            }
            for record in records
        ],
    }


if __name__ == "__main__":
    mcp.run()
