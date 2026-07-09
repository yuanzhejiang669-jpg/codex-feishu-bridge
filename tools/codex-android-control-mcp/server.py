from __future__ import annotations

import base64
import os
import re
import shutil
import subprocess
import time
import xml.etree.ElementTree as ET
from pathlib import Path
from typing import Any

from mcp.server.fastmcp import FastMCP

mcp = FastMCP('codex-android-control')

DEFAULT_OUTPUT_DIR = Path(os.environ.get('CODEX_ANDROID_CONTROL_OUTPUT_DIR', Path.cwd() / '.context' / 'android-control')).expanduser().resolve()
ADB_PATH = os.environ.get('CODEX_ANDROID_CONTROL_ADB_PATH') or shutil.which('adb') or 'adb'
MAX_SHELL_OUTPUT_CHARS = 12000
DEVICE_SHELL_META_RE = re.compile(r'''[;&|<>`$(){}\[\]*?~#'"\\\n\r]''')


def _is_relative_to(path: Path, parent: Path) -> bool:
    try:
        path.relative_to(parent)
        return True
    except ValueError:
        return False


def _resolve_output_path(path: str | None, default_name: str, suffix: str) -> Path:
    DEFAULT_OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    if path:
        candidate = Path(path).expanduser()
        if not candidate.is_absolute():
            candidate = DEFAULT_OUTPUT_DIR / candidate
        resolved = candidate.resolve()
    else:
        safe = re.sub(r'[^A-Za-z0-9_.-]+', '_', default_name).strip('_') or 'android_output'
        resolved = (DEFAULT_OUTPUT_DIR / f'{safe}{suffix}').resolve()
    if not resolved.suffix:
        resolved = resolved.with_suffix(suffix)
    if not _is_relative_to(resolved, DEFAULT_OUTPUT_DIR):
        raise ValueError(f'path must be inside output_dir: {DEFAULT_OUTPUT_DIR}')
    resolved.parent.mkdir(parents=True, exist_ok=True)
    return resolved


def _adb_base(serial: str | None = None) -> list[str]:
    cmd = [ADB_PATH]
    if serial:
        cmd.extend(['-s', serial])
    return cmd


def _run_adb(args: list[str], *, serial: str | None = None, timeout: float = 20, text: bool = True) -> subprocess.CompletedProcess:
    return subprocess.run(
        [*_adb_base(serial), *args],
        capture_output=True,
        text=text,
        timeout=timeout,
        check=False,
    )


def _adb_available() -> bool:
    try:
        result = _run_adb(['version'], timeout=5)
        return result.returncode == 0
    except Exception:
        return False


def _error_from_completed(result: subprocess.CompletedProcess, code: str = 'adb_error') -> dict[str, Any]:
    stdout = result.stdout if isinstance(result.stdout, str) else ''
    stderr = result.stderr if isinstance(result.stderr, str) else ''
    return {'ok': False, 'error': {'code': code, 'stdout': stdout[-2000:], 'stderr': stderr[-2000:], 'returncode': result.returncode}}


def _adb_not_found_error() -> dict[str, Any]:
    return {'ok': False, 'error': {'code': 'adb_not_found', 'message': f'adb not found: {ADB_PATH}'}}


def _contains_device_shell_meta(value: str) -> bool:
    return bool(DEVICE_SHELL_META_RE.search(value))


def _parse_devices(output: str) -> list[dict[str, Any]]:
    devices = []
    for line in output.splitlines()[1:]:
        line = line.strip()
        if not line:
            continue
        parts = line.split()
        serial = parts[0]
        state = parts[1] if len(parts) > 1 else 'unknown'
        details = {}
        for part in parts[2:]:
            if ':' in part:
                key, value = part.split(':', 1)
                details[key] = value
        devices.append({'serial': serial, 'state': state, 'details': details})
    return devices


def _parse_bounds(bounds: str) -> dict[str, Any]:
    points = re.findall(r'\[(\d+),(\d+)\]', bounds or '')
    if len(points) != 2:
        return {'bounds': bounds, 'rect': None, 'center': None}
    left, top = int(points[0][0]), int(points[0][1])
    right, bottom = int(points[1][0]), int(points[1][1])
    return {'bounds': bounds, 'rect': [left, top, right, bottom], 'center': [(left + right) // 2, (top + bottom) // 2]}


def _parse_ui_xml(xml_text: str, keyword: str | None = None, clickable_only: bool = False, raw: bool = False) -> list[dict[str, Any]]:
    root = ET.fromstring(xml_text)
    nodes: list[dict[str, Any]] = []
    needle = keyword.lower() if keyword else None
    for index, node in enumerate(root.iter('node')):
        package = node.get('package', '')
        if 'termux' in package.lower():
            continue
        text = node.get('text', '')
        desc = node.get('content-desc', '')
        resource_id = node.get('resource-id', '')
        class_name = node.get('class', '').split('.')[-1]
        clickable = node.get('clickable') == 'true'
        enabled = node.get('enabled') != 'false'
        focused = node.get('focused') == 'true'
        selected = node.get('selected') == 'true'
        editable = class_name == 'EditText' or node.get('editable') == 'true'
        label = text or desc or resource_id.split('/')[-1]
        if not label and not clickable and not raw:
            continue
        if clickable_only and not clickable:
            continue
        haystack = ' '.join([text, desc, resource_id, class_name]).lower()
        if needle and needle not in haystack:
            continue
        geometry = _parse_bounds(node.get('bounds', ''))
        nodes.append({
            'index': index,
            'text': text,
            'content_desc': desc,
            'label': label,
            'clickable': clickable,
            'enabled': enabled,
            'focused': focused,
            'selected': selected,
            'edit': editable,
            'class': class_name,
            'resource_id': resource_id,
            'package': package,
            **geometry,
        })
    return nodes


def _dump_ui_xml(serial: str | None = None, timeout: float = 20) -> str:
    if not _adb_available():
        raise FileNotFoundError(f'adb not found: {ADB_PATH}')
    remote_path = '/sdcard/window_dump.xml'
    _run_adb(['shell', 'rm', '-f', remote_path], serial=serial, timeout=timeout)
    dump = _run_adb(['shell', 'uiautomator', 'dump', '--compressed', remote_path], serial=serial, timeout=timeout)
    combined = f'{dump.stdout}\n{dump.stderr}'.lower()
    if dump.returncode != 0 or 'dumped' not in combined:
        raise RuntimeError(f'ui dump failed: stdout={dump.stdout[-1000:]} stderr={dump.stderr[-1000:]}')
    read = _run_adb(['exec-out', 'cat', remote_path], serial=serial, timeout=timeout, text=True)
    if read.returncode != 0 or not read.stdout.strip().startswith('<?xml'):
        raise RuntimeError(f'ui xml read failed: stdout={read.stdout[-1000:]} stderr={read.stderr[-1000:]}')
    return read.stdout


@mcp.tool()
def codex_android_control_status() -> dict[str, Any]:
    available = _adb_available()
    version = None
    if available:
        result = _run_adb(['version'], timeout=5)
        version = result.stdout.strip().splitlines()
    return {'ok': True, 'adb_path': ADB_PATH, 'adb_available': available, 'version': version, 'output_dir': str(DEFAULT_OUTPUT_DIR)}


@mcp.tool()
def codex_android_control_devices() -> dict[str, Any]:
    try:
        result = _run_adb(['devices', '-l'], timeout=10)
        if result.returncode != 0:
            return _error_from_completed(result)
        return {'ok': True, 'devices': _parse_devices(result.stdout), 'raw': result.stdout}
    except FileNotFoundError:
        return _adb_not_found_error()
    except Exception as exc:
        return {'ok': False, 'error': {'code': 'adb_exception', 'message': str(exc)}}


@mcp.tool()
def codex_android_control_connect(host: str, port: int = 5555) -> dict[str, Any]:
    if not re.fullmatch(r'[A-Za-z0-9_.:-]+', host):
        return {'ok': False, 'error': {'code': 'invalid_host', 'message': 'host contains unsupported characters'}}
    if port < 1 or port > 65535:
        return {'ok': False, 'error': {'code': 'invalid_port', 'message': 'port must be 1..65535'}}
    try:
        result = _run_adb(['connect', f'{host}:{port}'], timeout=20)
        if result.returncode != 0:
            return _error_from_completed(result)
        return {'ok': True, 'stdout': result.stdout.strip(), 'stderr': result.stderr.strip()}
    except FileNotFoundError:
        return _adb_not_found_error()
    except Exception as exc:
        return {'ok': False, 'error': {'code': 'adb_exception', 'message': str(exc)}}


@mcp.tool()
def codex_android_control_disconnect(serial: str | None = None) -> dict[str, Any]:
    args = ['disconnect'] + ([serial] if serial else [])
    try:
        result = _run_adb(args, timeout=15)
        if result.returncode != 0:
            return _error_from_completed(result)
        return {'ok': True, 'stdout': result.stdout.strip(), 'stderr': result.stderr.strip()}
    except FileNotFoundError:
        return _adb_not_found_error()
    except Exception as exc:
        return {'ok': False, 'error': {'code': 'adb_exception', 'message': str(exc)}}


@mcp.tool()
def codex_android_control_screenshot(serial: str | None = None, path: str | None = None, include_data: bool = False) -> dict[str, Any]:
    try:
        result = _run_adb(['exec-out', 'screencap', '-p'], serial=serial, timeout=20, text=False)
        if result.returncode != 0 or not result.stdout:
            return {'ok': False, 'error': {'code': 'screenshot_failed', 'stderr': result.stderr.decode(errors='replace') if isinstance(result.stderr, bytes) else str(result.stderr), 'returncode': result.returncode}}
        out = _resolve_output_path(path, 'android_screenshot', '.png')
        out.write_bytes(result.stdout)
        payload = {'ok': True, 'path': str(out), 'bytes': len(result.stdout), 'serial': serial}
        if include_data:
            payload['data_base64'] = base64.b64encode(result.stdout).decode('ascii')
        return payload
    except FileNotFoundError:
        return _adb_not_found_error()
    except Exception as exc:
        return {'ok': False, 'error': {'code': 'adb_exception', 'message': str(exc)}}


@mcp.tool()
def codex_android_control_dump_ui(serial: str | None = None, path: str | None = None) -> dict[str, Any]:
    try:
        xml_text = _dump_ui_xml(serial=serial)
        out = _resolve_output_path(path, 'android_ui', '.xml')
        out.write_text(xml_text, encoding='utf-8')
        return {'ok': True, 'path': str(out), 'length': len(xml_text), 'serial': serial}
    except FileNotFoundError:
        return _adb_not_found_error()
    except Exception as exc:
        return {'ok': False, 'error': {'code': 'ui_dump_failed', 'message': str(exc)}}


@mcp.tool()
def codex_android_control_ui(
    serial: str | None = None,
    keyword: str | None = None,
    clickable_only: bool = False,
    raw: bool = False,
    limit: int = 200,
) -> dict[str, Any]:
    if limit < 1 or limit > 1000:
        return {'ok': False, 'error': {'code': 'invalid_limit', 'message': 'limit must be 1..1000'}}
    try:
        xml_text = _dump_ui_xml(serial=serial)
        nodes = _parse_ui_xml(xml_text, keyword=keyword, clickable_only=clickable_only, raw=raw)
        return {'ok': True, 'count': len(nodes), 'nodes': nodes[:limit], 'truncated': len(nodes) > limit, 'serial': serial}
    except FileNotFoundError:
        return _adb_not_found_error()
    except Exception as exc:
        return {'ok': False, 'error': {'code': 'ui_parse_failed', 'message': str(exc)}}


@mcp.tool()
def codex_android_control_tap(x: int, y: int, serial: str | None = None) -> dict[str, Any]:
    if x < 0 or y < 0:
        return {'ok': False, 'error': {'code': 'invalid_coordinates', 'message': 'x/y must be >= 0'}}
    try:
        result = _run_adb(['shell', 'input', 'tap', str(int(x)), str(int(y))], serial=serial, timeout=10)
        if result.returncode != 0:
            return _error_from_completed(result)
        return {'ok': True, 'x': x, 'y': y, 'serial': serial}
    except FileNotFoundError:
        return _adb_not_found_error()
    except Exception as exc:
        return {'ok': False, 'error': {'code': 'adb_exception', 'message': str(exc)}}


@mcp.tool()
def codex_android_control_swipe(
    x1: int,
    y1: int,
    x2: int,
    y2: int,
    duration_ms: int = 300,
    serial: str | None = None,
) -> dict[str, Any]:
    if min(x1, y1, x2, y2) < 0:
        return {'ok': False, 'error': {'code': 'invalid_coordinates', 'message': 'coordinates must be >= 0'}}
    duration_ms = max(0, min(int(duration_ms), 10000))
    try:
        result = _run_adb(['shell', 'input', 'swipe', str(x1), str(y1), str(x2), str(y2), str(duration_ms)], serial=serial, timeout=15)
        if result.returncode != 0:
            return _error_from_completed(result)
        return {'ok': True, 'start': [x1, y1], 'end': [x2, y2], 'duration_ms': duration_ms, 'serial': serial}
    except FileNotFoundError:
        return _adb_not_found_error()
    except Exception as exc:
        return {'ok': False, 'error': {'code': 'adb_exception', 'message': str(exc)}}


@mcp.tool()
def codex_android_control_input_text(text: str, serial: str | None = None) -> dict[str, Any]:
    if not text:
        return {'ok': False, 'error': {'code': 'empty_text', 'message': 'text must be non-empty'}}
    if _contains_device_shell_meta(text):
        return {'ok': False, 'error': {'code': 'unsupported_text', 'message': 'text contains characters unsupported by adb input text'}}
    escaped = text.replace('%', '%25').replace(' ', '%s')
    try:
        result = _run_adb(['shell', 'input', 'text', escaped], serial=serial, timeout=15)
        if result.returncode != 0:
            return _error_from_completed(result)
        return {'ok': True, 'length': len(text), 'serial': serial}
    except FileNotFoundError:
        return _adb_not_found_error()
    except Exception as exc:
        return {'ok': False, 'error': {'code': 'adb_exception', 'message': str(exc)}}


@mcp.tool()
def codex_android_control_keyevent(keycode: str, serial: str | None = None) -> dict[str, Any]:
    if not re.fullmatch(r'[A-Za-z0-9_]+', keycode):
        return {'ok': False, 'error': {'code': 'invalid_keycode', 'message': 'keycode must be alphanumeric or underscore'}}
    try:
        result = _run_adb(['shell', 'input', 'keyevent', keycode], serial=serial, timeout=10)
        if result.returncode != 0:
            return _error_from_completed(result)
        return {'ok': True, 'keycode': keycode, 'serial': serial}
    except FileNotFoundError:
        return _adb_not_found_error()
    except Exception as exc:
        return {'ok': False, 'error': {'code': 'adb_exception', 'message': str(exc)}}


@mcp.tool()
def codex_android_control_shell(serial: str | None = None, command: list[str] | None = None, timeout_seconds: float = 20) -> dict[str, Any]:
    if not command:
        return {'ok': False, 'error': {'code': 'missing_command', 'message': 'provide command as a list of shell arguments'}}
    allowed_commands: dict[str, list[int]] = {
        'getprop': [0, 1],
        'wm': [1],
        'dumpsys': [1],
    }
    allowed_wm = {'size', 'density'}
    allowed_dumpsys = {'battery', 'display', 'input_method', 'package', 'window'}
    executable = command[0]
    if executable not in allowed_commands or len(command) - 1 not in allowed_commands[executable]:
        return {'ok': False, 'error': {'code': 'command_not_allowed', 'message': 'allowed commands: getprop [key], wm size|density, dumpsys battery|display|input_method|package|window'}}
    if any(_contains_device_shell_meta(part) for part in command):
        return {'ok': False, 'error': {'code': 'unsupported_command_chars', 'message': 'command contains unsupported shell metacharacters'}}
    if executable == 'wm' and command[1] not in allowed_wm:
        return {'ok': False, 'error': {'code': 'command_not_allowed', 'message': 'wm only allows size or density'}}
    if executable == 'dumpsys' and command[1] not in allowed_dumpsys:
        return {'ok': False, 'error': {'code': 'command_not_allowed', 'message': 'dumpsys target is not allowed'}}
    if any(len(part) > 120 for part in command):
        return {'ok': False, 'error': {'code': 'command_too_large', 'message': 'command arguments are too long'}}
    timeout_seconds = max(1, min(float(timeout_seconds), 30))
    try:
        result = _run_adb(['shell', *command], serial=serial, timeout=timeout_seconds)
        if result.returncode != 0:
            return _error_from_completed(result)
        return {
            'ok': True,
            'stdout': result.stdout[:MAX_SHELL_OUTPUT_CHARS],
            'stderr': result.stderr[:MAX_SHELL_OUTPUT_CHARS],
            'truncated': len(result.stdout) > MAX_SHELL_OUTPUT_CHARS or len(result.stderr) > MAX_SHELL_OUTPUT_CHARS,
            'returncode': result.returncode,
            'serial': serial,
        }
    except FileNotFoundError:
        return _adb_not_found_error()
    except Exception as exc:
        return {'ok': False, 'error': {'code': 'adb_exception', 'message': str(exc)}}


if __name__ == '__main__':
    mcp.run()
