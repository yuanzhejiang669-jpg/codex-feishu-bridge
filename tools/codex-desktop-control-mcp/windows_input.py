from __future__ import annotations

import time
from ctypes import Structure, Union, byref, c_size_t, c_ubyte, c_ulong, c_ushort, sizeof, windll

import win32api
import win32con


_BUTTONS = {
    'left': (win32con.MOUSEEVENTF_LEFTDOWN, win32con.MOUSEEVENTF_LEFTUP),
    'right': (win32con.MOUSEEVENTF_RIGHTDOWN, win32con.MOUSEEVENTF_RIGHTUP),
    'middle': (win32con.MOUSEEVENTF_MIDDLEDOWN, win32con.MOUSEEVENTF_MIDDLEUP),
}


def move_mouse(x: int, y: int, *, duration_ms: int = 0) -> None:
    start_x, start_y = win32api.GetCursorPos()
    steps = max(1, min(120, int(duration_ms) // 16))
    for index in range(1, steps + 1):
        ratio = index / steps
        target_x = round(start_x + (x - start_x) * ratio)
        target_y = round(start_y + (y - start_y) * ratio)
        win32api.SetCursorPos((target_x, target_y))
        if duration_ms > 0:
            time.sleep(duration_ms / 1000.0 / steps)


def mouse_button(x: int, y: int, *, button: str = 'left', action: str = 'click', clicks: int = 1) -> None:
    if button not in _BUTTONS:
        raise ValueError(f'unsupported mouse button: {button}')
    down, up = _BUTTONS[button]
    move_mouse(x, y)
    if action == 'down':
        win32api.mouse_event(down, 0, 0)
        return
    if action == 'up':
        win32api.mouse_event(up, 0, 0)
        return
    if action != 'click':
        raise ValueError(f'unsupported mouse action: {action}')
    for _ in range(max(1, int(clicks))):
        win32api.mouse_event(down, 0, 0)
        time.sleep(0.04)
        win32api.mouse_event(up, 0, 0)
        time.sleep(0.05)


def scroll(delta_y: int, delta_x: int = 0) -> None:
    if delta_y:
        win32api.mouse_event(win32con.MOUSEEVENTF_WHEEL, 0, 0, int(delta_y))
    if delta_x:
        horizontal = getattr(win32con, 'MOUSEEVENTF_HWHEEL', 0x01000)
        win32api.mouse_event(horizontal, 0, 0, int(delta_x))


def drag(start_x: int, start_y: int, end_x: int, end_y: int, *, duration_ms: int = 400, button: str = 'left') -> None:
    if button not in _BUTTONS:
        raise ValueError(f'unsupported mouse button: {button}')
    down, up = _BUTTONS[button]
    move_mouse(start_x, start_y)
    win32api.mouse_event(down, 0, 0)
    try:
        move_mouse(end_x, end_y, duration_ms=duration_ms)
    finally:
        win32api.mouse_event(up, 0, 0)


class _KeyboardInput(Structure):
    _fields_ = [
        ('virtual_key', c_ushort),
        ('scan_code', c_ushort),
        ('flags', c_ulong),
        ('time', c_ulong),
        ('extra_info', c_size_t),
    ]


class _InputUnion(Union):
    _fields_ = [('keyboard', _KeyboardInput), ('_padding', c_ubyte * 32)]


class _Input(Structure):
    _fields_ = [('type', c_ulong), ('data', _InputUnion)]


def _send_unicode_unit(unit: int, key_up: bool) -> None:
    flags = 0x0004 | (0x0002 if key_up else 0)
    event = _Input(type=1, data=_InputUnion(keyboard=_KeyboardInput(0, unit, flags, 0, 0)))
    sent = windll.user32.SendInput(1, byref(event), sizeof(_Input))
    if sent != 1:
        raise RuntimeError('SendInput failed while typing Unicode text')


def type_text(text: str, *, interval_ms: int = 0) -> None:
    units = text.encode('utf-16-le')
    for offset in range(0, len(units), 2):
        unit = int.from_bytes(units[offset:offset + 2], 'little')
        _send_unicode_unit(unit, False)
        _send_unicode_unit(unit, True)
        if interval_ms > 0:
            time.sleep(interval_ms / 1000.0)
