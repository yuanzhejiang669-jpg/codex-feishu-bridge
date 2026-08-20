from __future__ import annotations

import json
import os
import queue
import subprocess
import sys
import threading
import time
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[1]


def require(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)


def start_reader(stream, output: queue.Queue[str]) -> None:
    for line in iter(stream.readline, ''):
        output.put(line)


def parse_tool_payload(result: dict[str, Any]) -> dict[str, Any]:
    if isinstance(result.get('structuredContent'), dict):
        return result['structuredContent']
    content = result.get('content') or []
    for item in content:
        if item.get('type') != 'text':
            continue
        text = item.get('text') or '{}'
        try:
            return json.loads(text)
        except json.JSONDecodeError:
            return {'text': text}
    return {}


def main() -> None:
    env = os.environ.copy()
    env.setdefault('CODEX_DESKTOP_CONTROL_OUTPUT_DIR', str(Path.home() / '.codex' / 'tmp' / 'desktop-control'))
    child = subprocess.Popen(
        [sys.executable, 'server.py'],
        cwd=ROOT,
        env=env,
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        encoding='utf-8',
        errors='replace',
        bufsize=1,
    )
    stdout_lines: queue.Queue[str] = queue.Queue()
    stderr_lines: queue.Queue[str] = queue.Queue()
    threading.Thread(target=start_reader, args=(child.stdout, stdout_lines), daemon=True).start()
    threading.Thread(target=start_reader, args=(child.stderr, stderr_lines), daemon=True).start()
    next_id = 1

    def send(message: dict[str, Any]) -> None:
        assert child.stdin is not None
        child.stdin.write(json.dumps(message, ensure_ascii=False) + '\n')
        child.stdin.flush()

    def request(method: str, params: dict[str, Any] | None = None, timeout: float = 20.0) -> dict[str, Any]:
        nonlocal next_id
        request_id = next_id
        next_id += 1
        send({'jsonrpc': '2.0', 'id': request_id, 'method': method, 'params': params or {}})
        deadline = time.time() + timeout
        while time.time() < deadline:
            try:
                line = stdout_lines.get(timeout=0.1)
            except queue.Empty:
                if child.poll() is not None:
                    stderr = ''.join(list(stderr_lines.queue))
                    raise RuntimeError(f'server exited with {child.returncode}: {stderr}')
                continue
            try:
                message = json.loads(line)
            except json.JSONDecodeError:
                continue
            if message.get('id') != request_id:
                continue
            if 'error' in message:
                raise RuntimeError(json.dumps(message['error'], ensure_ascii=False))
            return message.get('result') or {}
        stderr = ''.join(list(stderr_lines.queue))
        raise TimeoutError(f'timed out waiting for {method}; stderr={stderr}')

    try:
        initialized = request('initialize', {
            'protocolVersion': '2024-11-05',
            'capabilities': {},
            'clientInfo': {'name': 'desktop-protocol-smoke-test', 'version': '0.1.0'},
        })
        require(initialized.get('serverInfo', {}).get('name') == 'codex-desktop-control', f'unexpected initialize result: {initialized}')
        send({'jsonrpc': '2.0', 'method': 'notifications/initialized', 'params': {}})

        listed = request('tools/list', {})
        listed_tools = listed.get('tools', [])
        names = [tool.get('name') for tool in listed_tools]
        missing_descriptions = [tool.get('name') for tool in listed_tools if not str(tool.get('description') or '').strip()]
        require(not missing_descriptions, f'tools missing descriptions: {missing_descriptions}')
        for required in [
            'codex_desktop_control_status',
            'codex_desktop_control_self_check',
            'codex_desktop_control_wait_for_text',
            'codex_desktop_control_click_and_wait_text',
            'codex_desktop_control_detect_ui_elements',
            'codex_desktop_control_paste_text',
            'codex_desktop_control_uia_status',
            'codex_desktop_control_uia_find',
            'codex_desktop_control_uia_tree',
            'codex_desktop_control_uia_click',
            'codex_desktop_control_mouse_button',
            'codex_desktop_control_move_mouse',
            'codex_desktop_control_scroll',
            'codex_desktop_control_drag',
            'codex_desktop_control_press_key',
            'codex_desktop_control_type_text',
            'codex_desktop_control_observe',
            'codex_desktop_control_workflow',
        ]:
            require(required in names, f'missing tool {required}; tools={names}')

        status = parse_tool_payload(request('tools/call', {'name': 'codex_desktop_control_status', 'arguments': {}}))
        require(status.get('ok') is True, f'status failed: {status}')
        require(status.get('ui_detection', {}).get('install', {}).get('install_script'), f'missing UI model install diagnostics: {status}')
        require('VALIDATION_ERROR' in status.get('error_codes', []), f'missing stable error code inventory: {status.get("error_codes")}')

        self_check = parse_tool_payload(request('tools/call', {'name': 'codex_desktop_control_self_check', 'arguments': {}}, timeout=90.0))
        if self_check.get('ok') is not True:
            clipboard = self_check.get('checks', {}).get('clipboard', {})
            other_checks = ['status', 'uia', 'windows', 'screenshot', 'visual_fallback']
            locked_clipboard_only = clipboard.get('ok') is False and all(self_check.get('checks', {}).get(name, {}).get('ok') is True for name in other_checks)
            require(locked_clipboard_only, json.dumps(self_check, ensure_ascii=False, indent=2))

        uia_status = parse_tool_payload(request('tools/call', {'name': 'codex_desktop_control_uia_status', 'arguments': {}}))
        require(uia_status.get('ok') is True and 'available' in uia_status, f'uia_status failed: {uia_status}')
        uia_tree = parse_tool_payload(request('tools/call', {'name': 'codex_desktop_control_uia_tree', 'arguments': {'max_depth': 0}}))
        if uia_status.get('available'):
            require(uia_tree.get('ok') is True and isinstance(uia_tree.get('tree'), dict), f'uia_tree failed: {uia_tree}')

        invalid = parse_tool_payload(request('tools/call', {'name': 'codex_desktop_control_wait_for_text', 'arguments': {'query': ''}}))
        require(invalid.get('code') == 'VALIDATION_ERROR', f'invalid wait_for_text did not return a stable code: {invalid}')

        invalid_workflow = parse_tool_payload(request('tools/call', {'name': 'codex_desktop_control_workflow', 'arguments': {'steps': []}}))
        require(invalid_workflow.get('code') == 'VALIDATION_ERROR', f'invalid workflow did not return a stable code: {invalid_workflow}')

        print(f'OK: {len(names)} desktop tools listed and protocol calls succeeded.')
    finally:
        child.kill()
        try:
            child.wait(timeout=5)
        except subprocess.TimeoutExpired:
            pass


if __name__ == '__main__':
    main()
