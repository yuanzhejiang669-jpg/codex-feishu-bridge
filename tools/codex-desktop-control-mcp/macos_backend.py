from __future__ import annotations

import os
import subprocess
import tempfile
import time
from pathlib import Path
from typing import Any


RECORD_SEPARATOR = chr(30)
FIELD_SEPARATOR = chr(31)


def _run(command: list[str], *, input_text: str | None = None, timeout: float = 15.0) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        command,
        input=input_text,
        capture_output=True,
        text=True,
        encoding='utf-8',
        errors='replace',
        timeout=timeout,
        check=True,
    )


def _osascript(script: str, args: list[str] | None = None, timeout: float = 15.0) -> str:
    completed = _run(['/usr/bin/osascript', '-', *(args or [])], input_text=script, timeout=timeout)
    return completed.stdout.strip()


def accessibility_status() -> dict[str, Any]:
    try:
        enabled = _osascript('tell application "System Events" to return UI elements enabled').lower() == 'true'
        return {
            'ok': True,
            'available': enabled,
            'backend': 'macos-system-events',
            'reason': None if enabled else 'Allow the controlling Python process under System Settings > Privacy & Security > Accessibility.',
        }
    except Exception as exc:
        return {'ok': True, 'available': False, 'backend': 'macos-system-events', 'reason': str(exc)}


def screen_info() -> dict[str, Any]:
    raw = _osascript('tell application "Finder" to return bounds of window of desktop')
    values = [int(float(value.strip())) for value in raw.split(',')]
    if len(values) != 4:
        raise RuntimeError(f'unexpected desktop bounds: {raw}')
    left, top, right, bottom = values
    width = right - left
    height = bottom - top
    return {
        'primary_width': width,
        'primary_height': height,
        'primary_physical_width': width,
        'primary_physical_height': height,
        'physical_width': width,
        'physical_height': height,
        'virtual_left': left,
        'virtual_top': top,
        'virtual_right': right,
        'virtual_bottom': bottom,
        'virtual_width': width,
        'virtual_height': height,
        'dpi_aware': True,
        'coordinate_system': 'macos_screen_points',
    }


_WINDOW_SCRIPT = r'''
on cleanText(valueText)
    set valueText to valueText as text
    set AppleScript's text item delimiters to {tab, return, linefeed, ASCII character 30, ASCII character 31}
    set parts to text items of valueText
    set AppleScript's text item delimiters to " "
    set valueText to parts as text
    set AppleScript's text item delimiters to ""
    return valueText
end cleanText

on run argv
    set visibleOnly to item 1 of argv is "1"
    set outputText to ""
    tell application "System Events"
        repeat with processItem in application processes
            try
                if background only of processItem is false and ((visible of processItem is true) or not visibleOnly) then
                    set processId to unix id of processItem
                    set processName to my cleanText(name of processItem)
                    set windowIndex to 0
                    repeat with windowItem in windows of processItem
                        set windowIndex to windowIndex + 1
                        try
                            set windowName to my cleanText(name of windowItem)
                            set windowPosition to position of windowItem
                            set windowSize to size of windowItem
                            set outputText to outputText & (processId as text) & (ASCII character 31) & processName & (ASCII character 31) & (windowIndex as text) & (ASCII character 31) & windowName & (ASCII character 31) & ((item 1 of windowPosition) as text) & (ASCII character 31) & ((item 2 of windowPosition) as text) & (ASCII character 31) & ((item 1 of windowSize) as text) & (ASCII character 31) & ((item 2 of windowSize) as text) & (ASCII character 30)
                        end try
                    end repeat
                end if
            end try
        end repeat
    end tell
    return outputText
end run
'''


def list_windows(title_contains: str | None = None, visible_only: bool = True) -> list[dict[str, Any]]:
    permission = accessibility_status()
    if not permission.get('available'):
        raise PermissionError(permission.get('reason') or 'macOS Accessibility permission is required')
    raw = _osascript(_WINDOW_SCRIPT, ['1' if visible_only else '0'])
    needle = title_contains.lower() if title_contains else None
    windows: list[dict[str, Any]] = []
    for record in raw.split(RECORD_SEPARATOR):
        if not record.strip():
            continue
        fields = record.split(FIELD_SEPARATOR)
        if len(fields) != 8:
            continue
        process_id, process_name, window_index, title, left, top, width, height = fields
        if needle and needle not in title.lower():
            continue
        pid = int(process_id)
        index = int(window_index)
        x = int(float(left))
        y = int(float(top))
        w = int(float(width))
        h = int(float(height))
        windows.append({
            'hwnd': pid * 10000 + index,
            'pid': pid,
            'window_index': index,
            'process': process_name,
            'title': title,
            'rect': [x, y, x + w, y + h],
            'width': w,
            'height': h,
            'coordinate_system': 'macos_screen_points',
        })
    return windows


def resolve_window(hwnd: int) -> dict[str, Any]:
    for window in list_windows(visible_only=False):
        if int(window['hwnd']) == int(hwnd):
            return window
    raise ValueError('no matching window found')


def activate_window(hwnd: int) -> dict[str, Any]:
    window = resolve_window(hwnd)
    script = r'''
on run argv
    set targetPid to item 1 of argv as integer
    set targetIndex to item 2 of argv as integer
    tell application "System Events"
        set targetProcess to first application process whose unix id is targetPid
        set frontmost of targetProcess to true
        try
            perform action "AXRaise" of window targetIndex of targetProcess
        end try
    end tell
end run
'''
    _osascript(script, [str(window['pid']), str(window['window_index'])])
    time.sleep(0.2)
    refreshed = resolve_window(hwnd)
    return {
        'ok': True,
        'hwnd': refreshed['hwnd'],
        'title': refreshed['title'],
        'rect': refreshed['rect'],
        'coordinate_system': 'macos_screen_points',
    }


def foreground_window_info() -> dict[str, Any]:
    script = r'''
tell application "System Events"
    set frontProcess to first application process whose frontmost is true
    set processId to unix id of frontProcess
    set processName to name of frontProcess
    try
        set frontWindow to first window of frontProcess
        set windowName to name of frontWindow
        set windowPosition to position of frontWindow
        set windowSize to size of frontWindow
        return (processId as text) & (ASCII character 31) & processName & (ASCII character 31) & windowName & (ASCII character 31) & ((item 1 of windowPosition) as text) & (ASCII character 31) & ((item 2 of windowPosition) as text) & (ASCII character 31) & ((item 1 of windowSize) as text) & (ASCII character 31) & ((item 2 of windowSize) as text)
    on error
        return (processId as text) & (ASCII character 31) & processName
    end try
end tell
'''
    fields = _osascript(script).split(FIELD_SEPARATOR)
    if len(fields) < 2:
        return {'hwnd': None, 'title': '', 'rect': None}
    pid = int(fields[0])
    if len(fields) != 7:
        return {'hwnd': pid * 10000 + 1, 'pid': pid, 'process': fields[1], 'title': '', 'rect': None}
    left, top, width, height = [int(float(value)) for value in fields[3:7]]
    return {
        'hwnd': pid * 10000 + 1,
        'pid': pid,
        'process': fields[1],
        'title': fields[2],
        'rect': [left, top, left + width, top + height],
    }


def _capture_region(rect: tuple[int, int, int, int] | None):
    from PIL import Image

    descriptor, temp_name = tempfile.mkstemp(prefix='codex-desktop-control-', suffix='.png')
    os.close(descriptor)
    temp = Path(temp_name)
    try:
        command = ['/usr/sbin/screencapture', '-x', '-t', 'png']
        expected_size = None
        if rect is not None:
            left, top, right, bottom = rect
            width = right - left
            height = bottom - top
            if width <= 0 or height <= 0:
                raise ValueError('capture region has empty bounds')
            command.extend(['-R', f'{left},{top},{width},{height}'])
            expected_size = (width, height)
        command.append(str(temp))
        _run(command, timeout=20.0)
        with Image.open(temp) as opened:
            image = opened.convert('RGB').copy()
        if expected_size and image.size != expected_size:
            image = image.resize(expected_size)
        return image
    finally:
        temp.unlink(missing_ok=True)


def capture_screen(rect: tuple[int, int, int, int] | None = None):
    if rect is not None:
        return _capture_region(rect)
    screen = screen_info()
    expected_size = (int(screen['virtual_width']), int(screen['virtual_height']))
    image = _capture_region(None)
    if image.size != expected_size:
        image = image.resize(expected_size)
    return image


def capture_window(hwnd: int, client_area: bool = False):
    del client_area
    window = resolve_window(hwnd)
    return _capture_region(tuple(int(value) for value in window['rect']))


def click(x: int, y: int) -> None:
    script = r'''
on run argv
    set clickX to item 1 of argv as integer
    set clickY to item 2 of argv as integer
    tell application "System Events" to click at {clickX, clickY}
end run
'''
    _osascript(script, [str(x), str(y)])


_KEY_CODES = {
    'backspace': 51,
    'delete': 51,
    'del': 51,
    'tab': 48,
    'enter': 36,
    'return': 36,
    'esc': 53,
    'escape': 53,
    'space': 49,
    'page_up': 116,
    'page_down': 121,
    'end': 119,
    'home': 115,
    'left': 123,
    'right': 124,
    'down': 125,
    'up': 126,
}


def send_hotkey(keys: list[str], delay_seconds: float = 0.02) -> None:
    del delay_seconds
    modifiers: list[str] = []
    regular: list[str] = []
    modifier_map = {
        'command': 'command down',
        'cmd': 'command down',
        'meta': 'command down',
        'win': 'command down',
        'ctrl': 'control down',
        'control': 'control down',
        'alt': 'option down',
        'option': 'option down',
        'shift': 'shift down',
    }
    for key in keys:
        normalized = key.strip().lower()
        if not normalized:
            continue
        if normalized in modifier_map:
            modifiers.append(modifier_map[normalized])
        else:
            regular.append(normalized)
    if len(regular) != 1:
        raise ValueError('provide exactly one non-modifier key')
    target = regular[0]
    using = f' using {{{", ".join(modifiers)}}}' if modifiers else ''
    if target in _KEY_CODES:
        action = f'key code {_KEY_CODES[target]}{using}'
    elif len(target) == 1:
        escaped = target.replace('\\', '\\\\').replace('"', '\\"')
        action = f'keystroke "{escaped}"{using}'
    elif target.startswith('f') and target[1:].isdigit() and 1 <= int(target[1:]) <= 20:
        function_codes = {1: 122, 2: 120, 3: 99, 4: 118, 5: 96, 6: 97, 7: 98, 8: 100, 9: 101, 10: 109, 11: 103, 12: 111}
        if int(target[1:]) not in function_codes:
            raise ValueError(f'unsupported key: {target}')
        action = f'key code {function_codes[int(target[1:])]}{using}'
    else:
        raise ValueError(f'unsupported key: {target}')
    _osascript(f'tell application "System Events" to {action}')


def clipboard_read_text() -> dict[str, Any]:
    completed = subprocess.run(
        ['/usr/bin/pbpaste'],
        capture_output=True,
        timeout=5.0,
    )
    if completed.returncode != 0:
        return {'ok': False, 'text': None, 'error': completed.stderr.decode('utf-8', errors='replace')}
    return {'ok': True, 'text': completed.stdout.decode('utf-8', errors='replace')}


def clipboard_write_text(text: str) -> None:
    completed = subprocess.run(
        ['/usr/bin/pbcopy'],
        input=text.encode('utf-8'),
        capture_output=True,
        timeout=5.0,
    )
    if completed.returncode != 0:
        raise RuntimeError(completed.stderr.decode('utf-8', errors='replace') or 'pbcopy failed')
