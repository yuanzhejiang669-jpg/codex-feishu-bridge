from __future__ import annotations

import os
import shutil
import subprocess
import tempfile
import time
from pathlib import Path
from typing import Any


YDOTOOL_SOCKET = os.environ.get("YDOTOOL_SOCKET", "/run/ydotoold/socket")
YDOTOOL = os.environ.get("CODEX_DESKTOP_CONTROL_YDOTOOL", "/usr/local/bin/ydotool")


def _run(args: list[str], *, input_text: str | None = None, timeout: float = 15) -> subprocess.CompletedProcess[str]:
    env = {**os.environ, "YDOTOOL_SOCKET": YDOTOOL_SOCKET}
    return subprocess.run(
        args,
        input=input_text,
        text=True,
        capture_output=True,
        timeout=timeout,
        check=True,
        env=env,
    )


def _require(command: str) -> str:
    resolved = command if Path(command).is_file() else shutil.which(command)
    if not resolved:
        raise RuntimeError(f"required Linux desktop command is unavailable: {command}")
    return str(resolved)


def capture_screen(bbox=None):
    from PIL import Image

    screenshot = _require("gnome-screenshot")
    with tempfile.NamedTemporaryFile(prefix="codex-desktop-", suffix=".png", delete=False) as handle:
        target = Path(handle.name)
    try:
        _run([screenshot, "-f", str(target)], timeout=20)
        with Image.open(target) as opened:
            image = opened.convert("RGB").copy()
        if bbox is not None:
            image = image.crop(tuple(int(value) for value in bbox))
        return image
    finally:
        target.unlink(missing_ok=True)


def screen_info() -> dict[str, Any]:
    image = capture_screen()
    return {
        "primary_width": image.width,
        "primary_height": image.height,
        "primary_physical_width": image.width,
        "primary_physical_height": image.height,
        "physical_width": image.width,
        "physical_height": image.height,
        "virtual_left": 0,
        "virtual_top": 0,
        "virtual_right": image.width,
        "virtual_bottom": image.height,
        "virtual_width": image.width,
        "virtual_height": image.height,
        "dpi_aware": True,
        "coordinate_system": "virtual_screen_physical_pixels",
        "session": "wayland" if os.environ.get("WAYLAND_DISPLAY") else "x11",
    }


def list_windows(title_contains: str | None = None, visible_only: bool = True) -> list[dict[str, Any]]:
    del visible_only
    wmctrl = _require("wmctrl")
    try:
        output = _run([wmctrl, "-lG"], timeout=5).stdout
    except subprocess.CalledProcessError:
        return []
    windows = []
    for line in output.splitlines():
        parts = line.split(None, 7)
        if len(parts) < 8:
            continue
        raw_handle, _desktop, x, y, width, height, _host, title = parts
        if title_contains and title_contains.lower() not in title.lower():
            continue
        left, top, window_width, window_height = int(x), int(y), int(width), int(height)
        windows.append({
            "hwnd": int(raw_handle, 16),
            "title": title,
            "rect": [left, top, left + window_width, top + window_height],
            "width": window_width,
            "height": window_height,
            "coordinate_system": "virtual_screen_physical_pixels",
            "backend": "wmctrl-xwayland",
        })
    return windows


def resolve_window(hwnd: int) -> dict[str, Any]:
    for window in list_windows():
        if int(window["hwnd"]) == int(hwnd):
            return window
    raise ValueError("no matching window found")


def capture_window(hwnd: int, client_area: bool = False):
    del client_area
    window = resolve_window(hwnd)
    return capture_screen(window["rect"])


def activate_window(hwnd: int) -> dict[str, Any]:
    window = resolve_window(hwnd)
    _run([_require("wmctrl"), "-ia", f"0x{int(hwnd):x}"], timeout=5)
    time.sleep(0.2)
    return {"ok": True, **window}


def foreground_window_info() -> dict[str, Any]:
    try:
        output = _run([_require("xprop"), "-root", "_NET_ACTIVE_WINDOW"], timeout=5).stdout
        raw = output.rsplit(" ", 1)[-1].strip()
        if raw in {"0x0", "0"}:
            return {"hwnd": None, "title": "", "rect": None}
        return resolve_window(int(raw, 16))
    except Exception as exc:
        return {"hwnd": None, "title": "", "rect": None, "reason": str(exc)}


def _ydotool(*args: str, input_text: str | None = None) -> None:
    if not Path(YDOTOOL_SOCKET).exists():
        raise RuntimeError(f"ydotool socket is unavailable: {YDOTOOL_SOCKET}")
    _run([_require(YDOTOOL), *args], input_text=input_text, timeout=20)


def move_mouse(x: int, y: int, duration_ms: int = 0) -> None:
    if duration_ms > 0:
        time.sleep(min(int(duration_ms), 5000) / 1000.0)
    # ydotool's virtual device cannot observe movement from a physical mouse, so its
    # --absolute position drifts after normal user input. Clamp at the desktop origin
    # first, then move by physical pixels to obtain a repeatable screen coordinate.
    _ydotool("mousemove", "-x", "-10000", "-y", "-10000")
    time.sleep(0.1)
    _ydotool("mousemove", "-x", str(int(x)), "-y", str(int(y)))
    time.sleep(0.1)


def mouse_button(x: int, y: int, *, button: str = "left", action: str = "click", clicks: int = 1) -> None:
    move_mouse(x, y)
    base = {"left": 0x00, "right": 0x01, "middle": 0x02}[button]
    prefix = {"down": 0x40, "up": 0x80, "click": 0xC0}[action]
    encoded = hex(prefix | base)
    for _ in range(max(1, int(clicks))):
        _ydotool("click", encoded)


def click(x: int, y: int) -> None:
    mouse_button(x, y)


def scroll(delta_y: int, delta_x: int = 0) -> None:
    _ydotool("mousemove", "--wheel", "-x", str(int(delta_x)), "-y", str(int(delta_y)))


def drag(start_x: int, start_y: int, end_x: int, end_y: int, *, duration_ms: int = 400, button: str = "left") -> None:
    move_mouse(start_x, start_y)
    mouse_button(start_x, start_y, button=button, action="down")
    try:
        steps = max(2, min(30, int(duration_ms) // 25 if duration_ms else 2))
        for index in range(1, steps + 1):
            ratio = index / steps
            move_mouse(
                round(start_x + (end_x - start_x) * ratio),
                round(start_y + (end_y - start_y) * ratio),
            )
            if duration_ms > 0:
                time.sleep(duration_ms / steps / 1000.0)
    finally:
        mouse_button(end_x, end_y, button=button, action="up")


KEY_CODES = {
    "esc": 1, "escape": 1, "backspace": 14, "tab": 15, "enter": 28,
    "ctrl": 29, "control": 29, "shift": 42, "alt": 56, "space": 57,
    "home": 102, "up": 103, "page_up": 104, "left": 105, "right": 106,
    "end": 107, "down": 108, "page_down": 109, "insert": 110, "ins": 110,
    "delete": 111, "del": 111, "win": 125, "command": 125,
}
KEY_CODES.update({str(value): code for value, code in zip(range(1, 10), range(2, 11))})
KEY_CODES.update({"0": 11})
for letters, start in (("qwertyuiop", 16), ("asdfghjkl", 30), ("zxcvbnm", 44)):
    KEY_CODES.update({letter: start + index for index, letter in enumerate(letters)})
KEY_CODES.update({f"f{index}": (58 + index if index <= 10 else 76 + index) for index in range(1, 13)})


def send_hotkey(keys: list[str], delay_seconds: float = 0.02) -> None:
    codes = []
    for key in keys:
        normalized = str(key).strip().lower()
        if normalized not in KEY_CODES:
            raise ValueError(f"unsupported key: {key}")
        codes.append(KEY_CODES[normalized])
    events = [f"{code}:1" for code in codes]
    events.extend(f"{code}:0" for code in reversed(codes))
    _ydotool("key", "--key-delay", str(max(0, round(delay_seconds * 1000))), *events)


def type_text(text: str, interval_ms: int = 0) -> None:
    _ydotool("type", "--key-delay", str(max(0, int(interval_ms))), "--file=-", input_text=text)


def clipboard_read_text() -> dict[str, Any]:
    try:
        completed = subprocess.run(
            [_require("wl-paste"), "--no-newline"],
            text=True,
            capture_output=True,
            timeout=5,
            check=False,
            env={**os.environ, "YDOTOOL_SOCKET": YDOTOOL_SOCKET},
        )
        if completed.returncode not in {0, 1}:
            raise RuntimeError(completed.stderr.strip() or f"wl-paste exited with {completed.returncode}")
        value = completed.stdout
        return {"ok": True, "text": value}
    except Exception as exc:
        return {"ok": False, "error": str(exc), "text": ""}


def clipboard_write_text(text: str) -> None:
    process = subprocess.Popen(
        [_require("wl-copy")],
        stdin=subprocess.PIPE,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        text=True,
        start_new_session=True,
        env={**os.environ, "YDOTOOL_SOCKET": YDOTOOL_SOCKET},
    )
    try:
        process.communicate(text, timeout=5)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait(timeout=2)
        raise RuntimeError("wl-copy did not accept clipboard text within 5 seconds")
    if process.returncode != 0:
        raise RuntimeError(f"wl-copy exited with {process.returncode}")


def backend_status() -> dict[str, Any]:
    commands = {
        "gnome-screenshot": shutil.which("gnome-screenshot"),
        "wmctrl": shutil.which("wmctrl"),
        "xprop": shutil.which("xprop"),
        "wl-copy": shutil.which("wl-copy"),
        "wl-paste": shutil.which("wl-paste"),
        "ydotool": YDOTOOL if Path(YDOTOOL).is_file() else None,
    }
    return {
        "available": all(commands.values()) and os.access(YDOTOOL_SOCKET, os.R_OK | os.W_OK),
        "commands": commands,
        "ydotool_socket": YDOTOOL_SOCKET,
        "ydotool_socket_accessible": os.access(YDOTOOL_SOCKET, os.R_OK | os.W_OK),
        "display": os.environ.get("DISPLAY"),
        "wayland_display": os.environ.get("WAYLAND_DISPLAY"),
        "semantic_backend": None,
        "window_backend": "wmctrl-xwayland",
        "limitations": ["native Wayland windows may not be enumerable; screenshot, OCR, clipboard, and coordinate input remain available"],
    }
