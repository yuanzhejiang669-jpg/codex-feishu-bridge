from __future__ import annotations

import json
import os
import sys
import tempfile
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

output_dir = Path(tempfile.gettempdir()) / 'codex-desktop-control-macos-smoke'
os.environ['CODEX_DESKTOP_CONTROL_OUTPUT_DIR'] = str(output_dir)

import server  # noqa: E402


def require(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)


def main() -> None:
    require(sys.platform == 'darwin', 'this smoke test only runs on macOS')
    status = server.codex_desktop_control_status()
    require(status.get('ok') is True, f'status failed: {status}')
    require(status.get('platform') == 'darwin', f'unexpected platform: {status.get("platform")}')
    require(status.get('screen', {}).get('virtual_width', 0) > 0, f'invalid screen: {status.get("screen")}')

    self_check = server.codex_desktop_control_self_check()
    checks = self_check.get('checks', {})
    require(checks.get('clipboard', {}).get('ok') is True, f'clipboard failed: {checks.get("clipboard")}')
    require(checks.get('screenshot', {}).get('ok') is True, f'screenshot failed: {checks.get("screenshot")}')
    require(checks.get('windows', {}).get('ok') is True, f'window discovery failed: {checks.get("windows")}')

    windows = server.codex_desktop_control_list_windows()
    require(windows.get('ok') is True, f'list_windows failed: {windows}')

    screenshot_path = output_dir / 'macos-smoke.png'
    try:
        screenshot = server.codex_desktop_control_screenshot(path=screenshot_path.name)
        require(screenshot.get('ok') is True, f'screenshot tool failed: {screenshot}')
        require(screenshot_path.is_file() and screenshot_path.stat().st_size > 0, f'screenshot file is invalid: {screenshot_path}')
    finally:
        screenshot_path.unlink(missing_ok=True)
        try:
            output_dir.rmdir()
        except OSError:
            pass

    accessibility = status.get('permissions') or {}
    summary = {
        'ok': True,
        'screen': status.get('screen'),
        'window_count': windows.get('count'),
        'accessibility_permission': accessibility.get('available'),
        'screen_recording': checks.get('screenshot', {}).get('ok'),
        'clipboard': checks.get('clipboard', {}).get('ok'),
        'warnings': self_check.get('warnings', []),
    }
    print(json.dumps(summary, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
