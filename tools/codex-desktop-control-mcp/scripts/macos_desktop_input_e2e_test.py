from __future__ import annotations

import json
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

import server  # noqa: E402


def require(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)


def main() -> None:
    require(sys.platform == 'darwin', 'this E2E test only runs on macOS')
    listed = server.codex_desktop_control_list_windows()
    require(listed.get('ok') is True and listed.get('windows'), f'no controllable windows: {listed}')
    windows = listed['windows']
    selected = next(
        (window for window in windows if window.get('process') in {'System Settings', 'System Preferences'}),
        windows[0],
    )
    activated = server.codex_desktop_control_activate_window(hwnd=selected['hwnd'])
    require(activated.get('ok') is True, f'window activation failed: {activated}')

    left, top, right, _bottom = [int(value) for value in activated['rect']]
    click_x = left + max(40, (right - left) // 2)
    click_y = top + 12
    clicked = server.codex_desktop_control_click(click_x, click_y)
    require(clicked.get('ok') is True, f'title-bar click failed: {clicked}')

    hotkey = server.codex_desktop_control_hotkey(['esc'])
    require(hotkey.get('ok') is True, f'keyboard event failed: {hotkey}')
    print(json.dumps({
        'ok': True,
        'window': {'process': selected.get('process'), 'title': selected.get('title'), 'rect': activated.get('rect')},
        'click': {'x': click_x, 'y': click_y},
        'hotkey': ['esc'],
    }, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
