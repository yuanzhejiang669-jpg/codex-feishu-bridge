from __future__ import annotations

import base64
import importlib.util
import io
import math
import os
import re
import sys
import time
from pathlib import Path
from typing import Any

from mcp.server.fastmcp import FastMCP

from diagnostics import fail as _fail
from diagnostics import ui_model_install_payload as _build_ui_model_install_payload
from workflow_runtime import compare_images as _compare_images
from workflow_runtime import execute_workflow as _execute_workflow

IS_MACOS = sys.platform == 'darwin'
if IS_MACOS:
    import macos_backend as _macos
else:
    import windows_input as _windows_input

mcp = FastMCP('codex-desktop-control')

try:
    import numpy as _NUMPY
except Exception as _numpy_exc:
    _NUMPY = None
    _NUMPY_IMPORT_ERROR = _numpy_exc
else:
    _NUMPY_IMPORT_ERROR = None

for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding='utf-8', errors='replace')
    except Exception:
        pass


def _module_available(module: str) -> bool:
    return importlib.util.find_spec(module) is not None


def _get_numpy():
    if _NUMPY is None:
        raise ImportError(f'numpy is not available: {_NUMPY_IMPORT_ERROR}')
    return _NUMPY


def _set_process_dpi_awareness() -> bool:
    try:
        from ctypes import windll

        try:
            return windll.shcore.SetProcessDpiAwareness(2) == 0
        except Exception:
            return bool(windll.user32.SetProcessDPIAware())
    except Exception:
        return False


DPI_AWARE = _set_process_dpi_awareness()
DEFAULT_OUTPUT_DIR = Path(os.environ.get('CODEX_DESKTOP_CONTROL_OUTPUT_DIR', Path.cwd() / '.context' / 'desktop-control')).expanduser().resolve()
DEFAULT_UI_MODEL_PATH = Path(os.environ.get('CODEX_DESKTOP_CONTROL_UI_MODEL_PATH', DEFAULT_OUTPUT_DIR / 'weights' / 'icon_detect' / 'model.pt')).expanduser().resolve()
_RAPID_ENGINE = None
_YOLO_MODELS: dict[str, Any] = {}
MAX_OCR_PIXELS = 12_000_000
UIA_OPTIONAL_MODULES = ('uiautomation', 'pywinauto', 'comtypes')


def _ui_model_install_payload() -> dict[str, Any]:
    script = Path(__file__).resolve().parent / 'scripts' / 'install_ui_model.py'
    return _build_ui_model_install_payload(DEFAULT_UI_MODEL_PATH, script)


def _import_pil():
    from PIL import Image, ImageGrab

    return Image, ImageGrab


def _import_win32():
    import win32api
    import win32con
    import win32gui
    import win32ui
    import win32clipboard
    from ctypes import windll

    return win32api, win32con, win32gui, win32ui, win32clipboard, windll


def _get_screen_info() -> dict[str, Any]:
    if IS_MACOS:
        return _macos.screen_info()
    win32api, win32con, _win32gui, _win32ui, _clip, windll = _import_win32()
    from ctypes import c_int, c_void_p

    get_dc = windll.user32.GetDC
    get_dc.argtypes = [c_void_p]
    get_dc.restype = c_void_p
    release_dc = windll.user32.ReleaseDC
    release_dc.argtypes = [c_void_p, c_void_p]
    release_dc.restype = c_int
    get_device_caps = windll.gdi32.GetDeviceCaps
    get_device_caps.argtypes = [c_void_p, c_int]
    get_device_caps.restype = c_int

    hdc = get_dc(None)
    if not hdc:
        raise RuntimeError('GetDC failed for the primary display')
    try:
        primary_physical_width = get_device_caps(hdc, 118)
        primary_physical_height = get_device_caps(hdc, 117)
    finally:
        release_dc(None, hdc)
    primary_width = win32api.GetSystemMetrics(win32con.SM_CXSCREEN)
    primary_height = win32api.GetSystemMetrics(win32con.SM_CYSCREEN)
    virtual_left = win32api.GetSystemMetrics(getattr(win32con, 'SM_XVIRTUALSCREEN', 76))
    virtual_top = win32api.GetSystemMetrics(getattr(win32con, 'SM_YVIRTUALSCREEN', 77))
    virtual_width = win32api.GetSystemMetrics(getattr(win32con, 'SM_CXVIRTUALSCREEN', 78))
    virtual_height = win32api.GetSystemMetrics(getattr(win32con, 'SM_CYVIRTUALSCREEN', 79))
    return {
        'primary_width': primary_width,
        'primary_height': primary_height,
        'primary_physical_width': primary_physical_width,
        'primary_physical_height': primary_physical_height,
        'physical_width': virtual_width,
        'physical_height': virtual_height,
        'virtual_left': virtual_left,
        'virtual_top': virtual_top,
        'virtual_right': virtual_left + virtual_width,
        'virtual_bottom': virtual_top + virtual_height,
        'virtual_width': virtual_width,
        'virtual_height': virtual_height,
        'dpi_aware': DPI_AWARE,
        'coordinate_system': 'virtual_screen_physical_pixels',
    }


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
        safe = re.sub(r'[^A-Za-z0-9_.-]+', '_', default_name).strip('_') or 'capture'
        resolved = (DEFAULT_OUTPUT_DIR / f'{safe}{suffix}').resolve()
    if not resolved.suffix:
        resolved = resolved.with_suffix(suffix)
    if not _is_relative_to(resolved, DEFAULT_OUTPUT_DIR):
        raise ValueError(f'path must be inside output_dir: {DEFAULT_OUTPUT_DIR}')
    resolved.parent.mkdir(parents=True, exist_ok=True)
    return resolved


def _resolve_input_path(path: str) -> Path:
    candidate = Path(path).expanduser()
    if not candidate.is_absolute():
        candidate = DEFAULT_OUTPUT_DIR / candidate
    resolved = candidate.resolve()
    if not _is_relative_to(resolved, DEFAULT_OUTPUT_DIR):
        raise ValueError(f'image_path must be inside output_dir: {DEFAULT_OUTPUT_DIR}')
    if not resolved.is_file():
        raise ValueError(f'image_path does not exist: {resolved}')
    return resolved


def _resolve_model_path() -> Path:
    resolved = DEFAULT_UI_MODEL_PATH
    if not _is_relative_to(resolved, DEFAULT_OUTPUT_DIR / 'weights'):
        raise ValueError(f'UI detection model must be inside weights dir: {DEFAULT_OUTPUT_DIR / "weights"}')
    if not resolved.is_file():
        raise ValueError(f'UI detection model not found: {resolved}')
    return resolved


def _image_to_payload(img, *, include_data: bool, path: str | None, format: str, default_name: str = 'capture') -> dict[str, Any]:
    fmt = 'PNG' if format.lower() == 'png' else 'JPEG'
    suffix = '.png' if fmt == 'PNG' else '.jpg'
    out = _resolve_output_path(path, default_name, suffix)
    img.save(out, format=fmt)
    data = None
    if include_data:
        buffer = io.BytesIO()
        img.save(buffer, format=fmt)
        data = base64.b64encode(buffer.getvalue()).decode('ascii')
    return {
        'ok': True,
        'width': img.width,
        'height': img.height,
        'path': str(out),
        'format': format.lower(),
        'data_base64': data,
        'coordinate_system': _get_screen_info()['coordinate_system'],
    }


def _normalize_bbox(bbox: list[int] | tuple[int, int, int, int] | None):
    if bbox is None:
        return None
    if len(bbox) != 4:
        raise ValueError('bbox must contain [left, top, right, bottom]')
    left, top, right, bottom = tuple(int(v) for v in bbox)
    if right <= left or bottom <= top:
        raise ValueError('bbox right/bottom must be greater than left/top')
    return left, top, right, bottom


def _is_probably_blank_image(img) -> bool:
    try:
        from PIL import ImageStat

        sample = img.convert('L')
        sample.thumbnail((96, 96))
        stat = ImageStat.Stat(sample)
        extrema = stat.extrema[0]
        return (extrema[1] - extrema[0]) <= 2 and stat.stddev[0] <= 1.0
    except Exception:
        return False


def _image_diagnostics(img) -> dict[str, Any]:
    try:
        from PIL import ImageStat

        sample = img.convert('L')
        sample.thumbnail((96, 96))
        stat = ImageStat.Stat(sample)
        extrema = stat.extrema[0]
        return {
            'probably_blank': (extrema[1] - extrema[0]) <= 2 and stat.stddev[0] <= 1.0,
            'luma_extrema': [float(extrema[0]), float(extrema[1])],
            'luma_stddev': float(stat.stddev[0]),
        }
    except Exception as exc:
        return {'error': str(exc)}


def _trace_self_check(label: str) -> None:
    if not os.environ.get('CODEX_DESKTOP_CONTROL_TRACE_SELF_CHECK'):
        return
    try:
        DEFAULT_OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
        with (DEFAULT_OUTPUT_DIR / 'self_check_trace.log').open('a', encoding='utf-8') as handle:
            handle.write(f'{time.time():.3f} {label}\n')
    except Exception:
        pass


def _client_rect_on_screen(hwnd: int) -> tuple[int, int, int, int]:
    if IS_MACOS:
        return tuple(int(value) for value in _macos.resolve_window(hwnd)['rect'])
    _api, _con, win32gui, _ui, _clip, _windll = _import_win32()
    left, top = win32gui.ClientToScreen(hwnd, (0, 0))
    _client_left, _client_top, width, height = win32gui.GetClientRect(hwnd)
    return left, top, left + width, top + height


def _capture_window(hwnd: int, client_area: bool = False):
    if IS_MACOS:
        return _macos.capture_window(hwnd, client_area=client_area)
    Image, ImageGrab = _import_pil()
    _win32api, _win32con, win32gui, win32ui, _clip, windll = _import_win32()
    window_left, window_top, window_right, window_bottom = win32gui.GetWindowRect(hwnd)
    left, top, right, bottom = _client_rect_on_screen(hwnd) if client_area else (window_left, window_top, window_right, window_bottom)
    width, height = window_right - window_left, window_bottom - window_top
    if width <= 0 or height <= 0:
        raise ValueError('window has empty bounds')
    hwnd_dc = win32gui.GetWindowDC(hwnd)
    mfc_dc = win32ui.CreateDCFromHandle(hwnd_dc)
    save_dc = mfc_dc.CreateCompatibleDC()
    bitmap = win32ui.CreateBitmap()
    try:
        bitmap.CreateCompatibleBitmap(mfc_dc, width, height)
        save_dc.SelectObject(bitmap)
        ok = windll.user32.PrintWindow(hwnd, save_dc.GetSafeHdc(), 3)
        if not ok:
            return ImageGrab.grab(bbox=(left, top, right, bottom))
        bmpinfo = bitmap.GetInfo()
        bmpstr = bitmap.GetBitmapBits(True)
        img = Image.frombuffer('RGB', (bmpinfo['bmWidth'], bmpinfo['bmHeight']), bmpstr, 'raw', 'BGRX', 0, 1)
        if client_area:
            crop_box = (
                max(0, left - window_left),
                max(0, top - window_top),
                min(img.width, right - window_left),
                min(img.height, bottom - window_top),
            )
            img = img.crop(crop_box)
        if _is_probably_blank_image(img):
            return ImageGrab.grab(bbox=(left, top, right, bottom))
        return img
    finally:
        win32gui.DeleteObject(bitmap.GetHandle())
        save_dc.DeleteDC()
        mfc_dc.DeleteDC()
        win32gui.ReleaseDC(hwnd, hwnd_dc)


def _capture_screen(bbox=None):
    if IS_MACOS:
        return _macos.capture_screen(bbox)
    _Image, ImageGrab = _import_pil()
    if bbox is not None:
        return ImageGrab.grab(bbox=bbox, all_screens=True)
    screen = _get_screen_info()
    return ImageGrab.grab(
        bbox=(screen['virtual_left'], screen['virtual_top'], screen['virtual_right'], screen['virtual_bottom']),
        all_screens=True,
    )


def _window_matches(title: str, title_contains: str | None) -> bool:
    if not title_contains:
        return True
    return title_contains.lower() in title.lower()


def _list_windows(title_contains: str | None = None, visible_only: bool = True) -> list[dict[str, Any]]:
    if IS_MACOS:
        return _macos.list_windows(title_contains=title_contains, visible_only=visible_only)
    _api, _con, win32gui, _ui, _clip, _windll = _import_win32()
    windows: list[dict[str, Any]] = []

    def callback(hwnd, _extra):
        if visible_only and not win32gui.IsWindowVisible(hwnd):
            return
        title = win32gui.GetWindowText(hwnd)
        if not title or not _window_matches(title, title_contains):
            return
        left, top, right, bottom = win32gui.GetWindowRect(hwnd)
        windows.append({
            'hwnd': int(hwnd),
            'title': title,
            'rect': [left, top, right, bottom],
            'width': right - left,
            'height': bottom - top,
            'coordinate_system': 'virtual_screen_physical_pixels',
        })

    win32gui.EnumWindows(callback, None)
    return windows


def _resolve_hwnd(hwnd: int | None = None, title_contains: str | None = None) -> int:
    if hwnd:
        return int(hwnd)
    matches = _list_windows(title_contains=title_contains, visible_only=True)
    if not matches:
        raise ValueError('no matching window found')
    return int(matches[0]['hwnd'])


def _activate(hwnd: int) -> dict[str, Any]:
    if IS_MACOS:
        return _macos.activate_window(hwnd)
    win32api, _con, win32gui, _ui, _clip, windll = _import_win32()
    if win32gui.IsIconic(hwnd):
        win32gui.ShowWindow(hwnd, 9)
    else:
        win32gui.ShowWindow(hwnd, 5)
    time.sleep(0.1)
    last_error = None
    try:
        win32gui.SetForegroundWindow(hwnd)
    except Exception as exc:
        last_error = exc
        try:
            foreground = win32gui.GetForegroundWindow()
            current_thread = win32api.GetCurrentThreadId()
            target_thread = windll.user32.GetWindowThreadProcessId(hwnd, None)
            foreground_thread = windll.user32.GetWindowThreadProcessId(foreground, None) if foreground else 0
            if target_thread:
                windll.user32.AttachThreadInput(current_thread, target_thread, True)
            if foreground_thread:
                windll.user32.AttachThreadInput(current_thread, foreground_thread, True)
            try:
                win32gui.BringWindowToTop(hwnd)
                win32gui.SetForegroundWindow(hwnd)
            finally:
                if foreground_thread:
                    windll.user32.AttachThreadInput(current_thread, foreground_thread, False)
                if target_thread:
                    windll.user32.AttachThreadInput(current_thread, target_thread, False)
        except Exception as fallback_exc:
            raise RuntimeError(f'failed to activate window: {fallback_exc}; initial error: {last_error}') from fallback_exc
    time.sleep(0.2)
    title = win32gui.GetWindowText(hwnd)
    rect = list(win32gui.GetWindowRect(hwnd))
    return {'ok': True, 'hwnd': int(hwnd), 'title': title, 'rect': rect, 'coordinate_system': 'virtual_screen_physical_pixels'}


def _foreground_window_info() -> dict[str, Any]:
    if IS_MACOS:
        return _macos.foreground_window_info()
    _api, _con, win32gui, _ui, _clip, _windll = _import_win32()
    hwnd = win32gui.GetForegroundWindow()
    if not hwnd:
        return {'hwnd': None, 'title': '', 'rect': None}
    return {
        'hwnd': int(hwnd),
        'title': win32gui.GetWindowText(hwnd),
        'rect': list(win32gui.GetWindowRect(hwnd)),
    }


def _get_rapid_ocr():
    global _RAPID_ENGINE
    if _RAPID_ENGINE is None:
        from rapidocr_onnxruntime import RapidOCR

        _RAPID_ENGINE = RapidOCR()
    return _RAPID_ENGINE


def _get_yolo_model():
    resolved = str(_resolve_model_path())
    from ultralytics import YOLO

    if resolved not in _YOLO_MODELS:
        _YOLO_MODELS[resolved] = YOLO(resolved)
    return _YOLO_MODELS[resolved], resolved


def _ocr_image(img, enhance: bool = False) -> dict[str, Any]:
    from PIL import ImageEnhance
    np = _get_numpy()

    scale = 1.0
    if enhance:
        target_scale = 3.0
        if img.width * img.height * target_scale * target_scale > MAX_OCR_PIXELS:
            target_scale = max(1.0, math.sqrt(MAX_OCR_PIXELS / max(1, img.width * img.height)))
        scale = target_scale
        img = ImageEnhance.Contrast(img).enhance(3.0)
        if scale > 1.0:
            img = img.resize((int(img.width * scale), int(img.height * scale)))
    result, _elapsed = _get_rapid_ocr()(np.array(img))
    if not result:
        return {'text': '', 'lines': [], 'details': []}
    details = []
    lines = []
    for item in result:
        bbox, text, conf = item
        text = re.sub(r'(?<=[一-鿿])\s+(?=[一-鿿])', '', str(text))
        points = [[float(point[0]) / scale, float(point[1]) / scale] for point in bbox]
        lines.append(text)
        details.append({'bbox': points, 'text': text, 'confidence': float(conf)})
    return {'text': '\n'.join(lines), 'lines': lines, 'details': details}


def _get_bbox_geometry(points: list[list[float]]) -> dict[str, Any]:
    xs = [float(point[0]) for point in points]
    ys = [float(point[1]) for point in points]
    return {
        'bbox': [[min(xs), min(ys)], [max(xs), min(ys)], [max(xs), max(ys)], [min(xs), max(ys)]],
        'rect': [min(xs), min(ys), max(xs), max(ys)],
        'center': [sum(xs) / len(xs), sum(ys) / len(ys)],
    }


def _to_screen_geometry(geometry: dict[str, Any], origin: list[float], coordinate_space: str) -> dict[str, Any]:
    if coordinate_space != 'virtual_screen_physical_pixels':
        return {'screen_center': None, 'screen_bbox': None, 'screen_rect': None}
    screen_bbox = [[origin[0] + float(point[0]), origin[1] + float(point[1])] for point in geometry['bbox']]
    screen_rect = [
        origin[0] + float(geometry['rect'][0]),
        origin[1] + float(geometry['rect'][1]),
        origin[0] + float(geometry['rect'][2]),
        origin[1] + float(geometry['rect'][3]),
    ]
    screen_center = [origin[0] + float(geometry['center'][0]), origin[1] + float(geometry['center'][1])]
    return {'screen_center': screen_center, 'screen_bbox': screen_bbox, 'screen_rect': screen_rect}


def _dilate_mask(mask, iterations: int = 2):
    np = _get_numpy()

    result = mask
    for _ in range(max(0, iterations)):
        padded = np.pad(result, 1, mode='constant', constant_values=False)
        result = (
            padded[1:-1, 1:-1]
            | padded[:-2, 1:-1]
            | padded[2:, 1:-1]
            | padded[1:-1, :-2]
            | padded[1:-1, 2:]
            | padded[:-2, :-2]
            | padded[:-2, 2:]
            | padded[2:, :-2]
            | padded[2:, 2:]
        )
    return result


def _detect_visual_ui_candidates(img, conf_threshold: float = 0.25, max_candidates: int = 80) -> list[dict[str, Any]]:
    np = _get_numpy()

    if img.width <= 0 or img.height <= 0:
        return []
    max_dim = max(img.width, img.height)
    scale = min(1.0, 900.0 / float(max_dim))
    work = img.convert('L')
    if scale < 1.0:
        work = work.resize((max(1, int(img.width * scale)), max(1, int(img.height * scale))))

    arr = np.asarray(work, dtype=np.int16)
    gx = np.abs(arr[:, 1:] - arr[:, :-1])
    gy = np.abs(arr[1:, :] - arr[:-1, :])
    edge = np.zeros_like(arr, dtype=np.int16)
    edge[:, 1:] = np.maximum(edge[:, 1:], gx)
    edge[1:, :] = np.maximum(edge[1:, :], gy)

    mask = None
    for percentile in (88, 92, 96):
        threshold = max(12, float(np.percentile(edge, percentile)))
        candidate = edge >= threshold
        density = float(candidate.mean()) if candidate.size else 0.0
        mask = candidate
        if density <= 0.18:
            break
    if mask is None or not mask.any():
        return []

    mask = _dilate_mask(mask, iterations=2)
    height, width = mask.shape
    visited = np.zeros_like(mask, dtype=bool)
    detections: list[dict[str, Any]] = []
    min_area = max(24, int(width * height * 0.00012))
    max_area = max(min_area + 1, int(width * height * 0.25))

    for y in range(height):
        xs = np.flatnonzero(mask[y] & ~visited[y])
        for start_x in xs:
            if visited[y, start_x] or not mask[y, start_x]:
                continue
            stack = [(int(start_x), int(y))]
            visited[y, start_x] = True
            min_x = max_x = int(start_x)
            min_y = max_y = int(y)
            area = 0
            while stack:
                x, yy = stack.pop()
                area += 1
                if x < min_x:
                    min_x = x
                elif x > max_x:
                    max_x = x
                if yy < min_y:
                    min_y = yy
                elif yy > max_y:
                    max_y = yy
                for nx, ny in ((x - 1, yy), (x + 1, yy), (x, yy - 1), (x, yy + 1)):
                    if nx < 0 or ny < 0 or nx >= width or ny >= height:
                        continue
                    if visited[ny, nx] or not mask[ny, nx]:
                        continue
                    visited[ny, nx] = True
                    stack.append((nx, ny))

            box_w = max_x - min_x + 1
            box_h = max_y - min_y + 1
            if area < min_area or area > max_area or box_w < 8 or box_h < 6:
                continue
            aspect = box_w / max(1, box_h)
            if aspect > 25 or aspect < 0.04:
                continue
            fill_ratio = area / max(1, box_w * box_h)
            confidence = max(0.25, min(0.95, 0.25 + fill_ratio))
            if confidence < conf_threshold:
                continue
            inv_scale = 1.0 / scale
            x1 = float(min_x) * inv_scale
            y1 = float(min_y) * inv_scale
            x2 = float(max_x + 1) * inv_scale
            y2 = float(max_y + 1) * inv_scale
            geometry = _get_bbox_geometry([[x1, y1], [x2, y1], [x2, y2], [x1, y2]])
            detections.append({
                **geometry,
                'confidence': float(confidence),
                'class': 'visual_region',
                'detector': 'visual_fallback',
                'area': int(area),
            })

    detections.sort(key=lambda item: (item['confidence'], (item['rect'][2] - item['rect'][0]) * (item['rect'][3] - item['rect'][1])), reverse=True)
    return detections[:max_candidates]


def _capture_source(
    *,
    image_path: str | None = None,
    hwnd: int | None = None,
    title_contains: str | None = None,
    bbox: list[int] | None = None,
    client_area: bool = False,
):
    if image_path:
        Image, _ImageGrab = _import_pil()
        resolved = _resolve_input_path(image_path)
        with Image.open(resolved) as opened:
            img = opened.convert('RGB').copy()
        return img, [0.0, 0.0], 'image_pixels', {'type': 'image_path', 'path': str(resolved)}
    if hwnd or title_contains:
        resolved = _resolve_hwnd(hwnd=hwnd, title_contains=title_contains)
        if IS_MACOS:
            left, top, right, bottom = _macos.resolve_window(resolved)['rect']
        else:
            _api, _con, win32gui, _ui, _clip, _windll = _import_win32()
            left, top, right, bottom = _client_rect_on_screen(resolved) if client_area else win32gui.GetWindowRect(resolved)
        return _capture_window(resolved, client_area=client_area), [float(left), float(top)], _get_screen_info()['coordinate_system'], {
            'type': 'window',
            'hwnd': int(resolved),
            'rect': [left, top, right, bottom],
            'client_area': bool(client_area),
        }
    normalized = _normalize_bbox(bbox)
    screen = _get_screen_info()
    origin = [float(normalized[0]), float(normalized[1])] if normalized else [float(screen['virtual_left']), float(screen['virtual_top'])]
    return _capture_screen(normalized), origin, screen['coordinate_system'], {'type': 'screen', 'bbox': list(normalized) if normalized else None}


def _send_hotkey(keys: list[str], delay_seconds: float = 0.02) -> None:
    if IS_MACOS:
        _macos.send_hotkey(keys, delay_seconds=delay_seconds)
        return
    win32api, win32con, _gui, _ui, _clip, _windll = _import_win32()
    key_map = {
        'backspace': 0x08, 'tab': 0x09, 'enter': 0x0D, 'shift': 0x10, 'ctrl': 0x11,
        'control': 0x11, 'alt': 0x12, 'esc': 0x1B, 'escape': 0x1B, 'space': 0x20,
        'page_up': 0x21, 'page_down': 0x22, 'end': 0x23, 'home': 0x24,
        'left': 0x25, 'up': 0x26, 'right': 0x27, 'down': 0x28, 'insert': 0x2D,
        'ins': 0x2D, 'delete': 0x2E, 'del': 0x2E, 'win': 0x5B,
    }
    for i in range(1, 25):
        key_map[f'f{i}'] = 0x6F + i
    for char in '0123456789abcdefghijklmnopqrstuvwxyz':
        key_map[char] = ord(char.upper())
    codes = []
    for key in keys:
        normalized = key.strip().lower()
        if not normalized:
            continue
        if normalized not in key_map:
            raise ValueError(f'unsupported key: {key}')
        codes.append(key_map[normalized])
    pressed = []
    try:
        for code in codes:
            win32api.keybd_event(code, 0, 0, 0)
            pressed.append(code)
            time.sleep(delay_seconds)
    finally:
        for code in reversed(pressed):
            win32api.keybd_event(code, 0, win32con.KEYEVENTF_KEYUP, 0)
            time.sleep(delay_seconds)


def _open_clipboard_with_retry(retries: int = 10, delay_seconds: float = 0.05) -> None:
    _api, _con, _gui, _ui, win32clipboard, _windll = _import_win32()
    last_error = None
    for _ in range(retries):
        try:
            win32clipboard.OpenClipboard()
            return
        except Exception as exc:
            last_error = exc
            time.sleep(delay_seconds)
    raise RuntimeError(f'failed to open clipboard: {last_error}')



def _clipboard_snapshot(win32clipboard, win32con) -> dict[str, Any]:
    snapshot: dict[str, Any] = {'ok': True, 'formats': [], 'unsupported_formats': [], 'error': None}
    try:
        fmt = 0
        while True:
            fmt = win32clipboard.EnumClipboardFormats(fmt)
            if not fmt:
                break
            if fmt in {win32con.CF_UNICODETEXT, win32con.CF_TEXT}:
                try:
                    snapshot['formats'].append({'format': int(fmt), 'data': win32clipboard.GetClipboardData(fmt)})
                except Exception as exc:
                    snapshot['unsupported_formats'].append({'format': int(fmt), 'error': str(exc)})
            else:
                snapshot['unsupported_formats'].append({'format': int(fmt)})
    except Exception as exc:
        snapshot['ok'] = False
        snapshot['error'] = str(exc)
    return snapshot


def _restore_clipboard_snapshot(win32clipboard, snapshot: dict[str, Any] | None) -> dict[str, Any]:
    if not snapshot:
        return _fail('clipboard snapshot was not captured', 'CLIPBOARD_UNAVAILABLE')
    if not snapshot.get('ok'):
        return _fail(snapshot.get('error') or 'clipboard snapshot failed', 'CLIPBOARD_UNAVAILABLE')
    formats = snapshot.get('formats') or []
    unsupported = snapshot.get('unsupported_formats') or []
    if not formats and unsupported:
        return {
            'ok': False,
            'error': 'original clipboard contained unsupported non-text formats and cannot be restored safely',
            'unsupported_format_count': len(unsupported),
        }
    _api, _con, _gui, _ui, win32clipboard_mod, _windll = _import_win32()
    _open_clipboard_with_retry()
    try:
        win32clipboard_mod.EmptyClipboard()
        for item in formats:
            win32clipboard_mod.SetClipboardData(int(item['format']), item.get('data'))
    finally:
        win32clipboard_mod.CloseClipboard()
    return {
        'ok': True,
        'restored_format_count': len(formats),
        'unsupported_format_count': len(unsupported),
    }


def _uia_status_payload() -> dict[str, Any]:
    if IS_MACOS:
        accessibility = _macos.accessibility_status()
        return {
            'ok': True,
            'available': bool(accessibility.get('available')),
            'backend': 'macos-accessibility',
            'accessibility_permission': bool(accessibility.get('available')),
            'reason': accessibility.get('reason'),
            'fallbacks': ['ocr', 'visual_fallback', 'coordinate_actions'],
        }
    modules = {name: _module_available(name) for name in UIA_OPTIONAL_MODULES}
    if not modules.get('uiautomation'):
        return {
            'ok': True,
            'available': False,
            'backend': None,
            'modules': modules,
            'reason': 'uiautomation package is not installed',
            'fallbacks': ['ocr', 'visual_fallback', 'coordinate_actions'],
        }
    try:
        import uiautomation as auto

        root = auto.GetRootControl()
        return {
            'ok': True,
            'available': True,
            'backend': 'uiautomation',
            'modules': modules,
            'root': _uia_control_payload(root, depth=0),
        }
    except Exception as exc:
        return {
            'ok': True,
            'available': False,
            'backend': 'uiautomation',
            'modules': modules,
            'reason': str(exc),
            'fallbacks': ['ocr', 'visual_fallback', 'coordinate_actions'],
        }


def _get_uia_backend():
    if not _module_available('uiautomation'):
        raise RuntimeError('uiautomation package is not installed')
    import uiautomation as auto

    return auto


def _uia_rect(rect) -> list[float] | None:
    if not rect:
        return None
    try:
        return [float(rect.left), float(rect.top), float(rect.right), float(rect.bottom)]
    except Exception:
        try:
            values = list(rect)
            if len(values) >= 4:
                return [float(values[0]), float(values[1]), float(values[2]), float(values[3])]
        except Exception:
            return None
    return None


def _uia_control_payload(control, depth: int) -> dict[str, Any]:
    def safe_attr(name: str, default=None):
        try:
            return getattr(control, name)
        except Exception:
            return default

    rect = _uia_rect(safe_attr('BoundingRectangle'))
    center = None
    if rect:
        center = [(rect[0] + rect[2]) / 2.0, (rect[1] + rect[3]) / 2.0]
    return {
        'depth': depth,
        'name': safe_attr('Name', '') or '',
        'automation_id': safe_attr('AutomationId', '') or '',
        'class_name': safe_attr('ClassName', '') or '',
        'control_type': safe_attr('ControlTypeName', '') or '',
        'native_window_handle': int(safe_attr('NativeWindowHandle', 0) or 0),
        'rect': rect,
        'center': center,
        'coordinate_system': 'virtual_screen_physical_pixels' if center else None,
    }


def _uia_control_children(control) -> list[Any]:
    try:
        return list(control.GetChildren())
    except Exception:
        return []


def _uia_root(hwnd: int | None = None, title_contains: str | None = None):
    auto = _get_uia_backend()
    if hwnd:
        return auto.ControlFromHandle(int(hwnd))
    if title_contains:
        return auto.ControlFromHandle(_resolve_hwnd(title_contains=title_contains))
    return auto.GetRootControl()


def _matches_uia_payload(
    payload: dict[str, Any],
    *,
    query: str | None = None,
    name_contains: str | None = None,
    automation_id: str | None = None,
    class_name: str | None = None,
    control_type: str | None = None,
    exact: bool = False,
) -> bool:
    def match_field(value: str, expected: str | None) -> bool:
        if not expected:
            return True
        hay = str(value or '')
        return hay == expected if exact else expected.lower() in hay.lower()

    if query:
        haystack = ' '.join(str(payload.get(key, '')) for key in ('name', 'automation_id', 'class_name', 'control_type'))
        if exact:
            if haystack != query:
                return False
        elif query.lower() not in haystack.lower():
            return False
    return (
        match_field(payload.get('name', ''), name_contains)
        and match_field(payload.get('automation_id', ''), automation_id)
        and match_field(payload.get('class_name', ''), class_name)
        and match_field(payload.get('control_type', ''), control_type)
    )


def _macos_uia_find(
    *,
    query: str | None = None,
    name_contains: str | None = None,
    automation_id: str | None = None,
    class_name: str | None = None,
    control_type: str | None = None,
    hwnd: int | None = None,
    title_contains: str | None = None,
    exact: bool = False,
    limit: int = 50,
) -> tuple[int, list[dict[str, Any]]]:
    resolved = _resolve_hwnd(hwnd=hwnd, title_contains=title_contains)
    scan_limit = max(50, min(500, int(limit) * 10))
    elements = _macos.accessibility_elements(resolved, limit=scan_limit)
    found = [
        item for item in elements
        if _matches_uia_payload(
            item,
            query=query,
            name_contains=name_contains,
            automation_id=automation_id,
            class_name=class_name,
            control_type=control_type,
            exact=exact,
        )
    ]
    return resolved, found[:max(1, min(int(limit), 200))]


def _uia_find_controls(
    *,
    query: str | None = None,
    name_contains: str | None = None,
    automation_id: str | None = None,
    class_name: str | None = None,
    control_type: str | None = None,
    hwnd: int | None = None,
    title_contains: str | None = None,
    exact: bool = False,
    max_depth: int = 4,
    limit: int = 50,
) -> list[dict[str, Any]]:
    root = _uia_root(hwnd=hwnd, title_contains=title_contains)
    limit = max(1, min(int(limit), 200))
    max_depth = max(0, min(int(max_depth), 12))
    found: list[dict[str, Any]] = []
    queue: list[tuple[Any, int]] = [(root, 0)]
    while queue and len(found) < limit:
        control, depth = queue.pop(0)
        payload = _uia_control_payload(control, depth=depth)
        if _matches_uia_payload(
            payload,
            query=query,
            name_contains=name_contains,
            automation_id=automation_id,
            class_name=class_name,
            control_type=control_type,
            exact=exact,
        ):
            found.append({'control': control, 'payload': payload})
        if depth < max_depth:
            for child in _uia_control_children(control):
                queue.append((child, depth + 1))
    return found


def _uia_tree_payload(control, depth: int, max_depth: int, limit_state: dict[str, int]) -> dict[str, Any]:
    payload = _uia_control_payload(control, depth=depth)
    if depth >= max_depth or limit_state['remaining'] <= 0:
        payload['children'] = []
        return payload
    children = []
    for child in _uia_control_children(control):
        if limit_state['remaining'] <= 0:
            break
        limit_state['remaining'] -= 1
        children.append(_uia_tree_payload(child, depth + 1, max_depth, limit_state))
    payload['children'] = children
    return payload


def _uia_click_control(control) -> dict[str, Any]:
    try:
        control.Click()
        return {'ok': True, 'method': 'uia_click'}
    except Exception as exc:
        payload = _uia_control_payload(control, depth=0)
        center = payload.get('center')
        if not center:
            return _fail(f'UIA click failed and no center is available: {exc}', 'UIA_UNAVAILABLE')
        fallback = _click_payload(center[0], center[1])
        return {'ok': bool(fallback.get('ok')), 'method': 'coordinate_fallback', 'uia_error': str(exc), 'fallback': fallback}


def _post_action_verification(
    *,
    bbox: list[int] | None = None,
    query: str | None = None,
    delay_seconds: float = 0.2,
    enhance: bool = False,
) -> dict[str, Any]:
    time.sleep(max(0.0, float(delay_seconds)))
    normalized = _normalize_bbox(bbox)
    img = _capture_screen(normalized)
    result: dict[str, Any] = {
        'ok': True,
        'source': {'type': 'screen', 'bbox': list(normalized) if normalized else None},
        'width': img.width,
        'height': img.height,
        'image': _image_diagnostics(img),
    }
    try:
        result['foreground'] = _foreground_window_info()
    except Exception as exc:
        result['foreground'] = {'error': str(exc)}
    if query:
        ocr = _ocr_image(img, enhance=enhance)
        result['ocr_text'] = ocr.get('text', '')
        result['query'] = query
        result['query_found'] = query.lower() in result['ocr_text'].lower()
    return result


def _status_payload() -> dict[str, Any]:
    dependencies: dict[str, bool] = {}
    dependency_modules = [
        ('pillow', 'PIL'),
        ('rapidocr_onnxruntime', 'rapidocr_onnxruntime'),
        ('ultralytics', 'ultralytics'),
        ('torch', 'torch'),
    ]
    if not IS_MACOS:
        dependency_modules.append(('pywin32', 'win32gui'))
    for name, module in dependency_modules:
        dependencies[name] = _module_available(module)
    dependencies['numpy'] = _NUMPY is not None
    if not IS_MACOS:
        for module in UIA_OPTIONAL_MODULES:
            dependencies[module] = _module_available(module)
    try:
        screen = _get_screen_info()
    except Exception as exc:
        screen = {'error': str(exc)}
    return {
        'ok': True,
        'platform': sys.platform,
        'dependencies': dependencies,
        'screen': screen,
        'output_dir': str(DEFAULT_OUTPUT_DIR),
        'ui_detection': {
            'model_path': str(DEFAULT_UI_MODEL_PATH),
            'model_exists': DEFAULT_UI_MODEL_PATH.is_file(),
            'enabled': dependencies.get('ultralytics', False) and DEFAULT_UI_MODEL_PATH.is_file(),
            'install': _ui_model_install_payload(),
        },
        'clipboard': {
            'restore_text_formats_supported': True,
            'restore_non_text_formats_supported': False,
        },
        'permissions': _macos.accessibility_status() if IS_MACOS else None,
        'uia': _uia_status_payload(),
        'error_codes': [
            'VALIDATION_ERROR',
            'WINDOW_NOT_FOUND',
            'COORD_OUT_OF_BOUNDS',
            'FILE_ERROR',
            'UIA_UNAVAILABLE',
            'OCR_UNAVAILABLE',
            'UI_MODEL_MISSING',
            'CLIPBOARD_UNAVAILABLE',
            'PERMISSION_DENIED',
            'TIMEOUT',
            'TOOL_ERROR',
        ],
    }


@mcp.tool()
def codex_desktop_control_status() -> dict[str, Any]:
    """Report desktop-control availability, screen geometry, optional UI/OCR backends, output paths, and stable error codes. Call this before a desktop workflow."""
    return _status_payload()


@mcp.tool()
def codex_desktop_control_ui_status() -> dict[str, Any]:
    """Report visual UI detector and OCR readiness, including model installation guidance when the optional detector is unavailable."""
    try:
        has_ultralytics = _module_available('ultralytics')
        return {
            'ok': True,
            'ultralytics': has_ultralytics,
            'model_path': str(DEFAULT_UI_MODEL_PATH),
            'model_exists': DEFAULT_UI_MODEL_PATH.is_file(),
            'enabled': has_ultralytics and DEFAULT_UI_MODEL_PATH.is_file(),
            'loaded_models': list(_YOLO_MODELS.keys()),
        }
    except Exception as exc:
        return _fail(exc)


@mcp.tool()
def codex_desktop_control_uia_status() -> dict[str, Any]:
    """Report semantic UI automation availability through Windows UIA or macOS Accessibility."""
    return _uia_status_payload()


@mcp.tool()
def codex_desktop_control_uia_find(
    query: str | None = None,
    name_contains: str | None = None,
    automation_id: str | None = None,
    class_name: str | None = None,
    control_type: str | None = None,
    hwnd: int | None = None,
    title_contains: str | None = None,
    exact: bool = False,
    max_depth: int = 4,
    limit: int = 50,
) -> dict[str, Any]:
    """Find native UIA controls in a window.

    Use hwnd or title_contains to select a window; name, automation_id, and control_type filter controls. exact=true requires complete field equality, while false uses case-insensitive substring matching. max_depth and limit bound traversal. Returned rectangles use physical screen coordinates.
    """
    if not any([query, name_contains, automation_id, class_name, control_type]):
        return _fail('provide query, name_contains, automation_id, class_name, or control_type', 'VALIDATION_ERROR')
    try:
        if IS_MACOS:
            _resolved, found = _macos_uia_find(
                query=query, name_contains=name_contains, automation_id=automation_id,
                class_name=class_name, control_type=control_type, hwnd=hwnd,
                title_contains=title_contains, exact=exact, limit=limit,
            )
            return {'ok': True, 'backend': 'macos-accessibility', 'count': len(found), 'matches': found}
        found = _uia_find_controls(
            query=query,
            name_contains=name_contains,
            automation_id=automation_id,
            class_name=class_name,
            control_type=control_type,
            hwnd=hwnd,
            title_contains=title_contains,
            exact=exact,
            max_depth=max_depth,
            limit=limit,
        )
        return {
            'ok': True,
            'backend': 'uiautomation',
            'count': len(found),
            'matches': [item['payload'] for item in found],
        }
    except Exception as exc:
        status = _uia_status_payload()
        return _fail(exc, uia=status)


@mcp.tool()
def codex_desktop_control_uia_tree(
    hwnd: int | None = None,
    title_contains: str | None = None,
    max_depth: int = 2,
    limit: int = 80,
) -> dict[str, Any]:
    """Return a bounded native UIA control tree for a selected window. Select by hwnd or title_contains; max_depth and limit cap traversal size."""
    try:
        if IS_MACOS:
            resolved = _resolve_hwnd(hwnd=hwnd, title_contains=title_contains)
            elements = _macos.accessibility_elements(resolved, limit=limit)
            window = _macos.resolve_window(resolved)
            root = {
                'depth': 0,
                'name': window.get('title', ''),
                'control_type': 'AXWindow',
                'rect': window.get('rect'),
                'coordinate_system': 'macos_screen_points',
                'children': elements,
            }
            return {'ok': True, 'backend': 'macos-accessibility', 'tree': root, 'truncated': len(elements) >= int(limit)}
        root = _uia_root(hwnd=hwnd, title_contains=title_contains)
        max_depth = max(0, min(int(max_depth), 8))
        limit_state = {'remaining': max(0, min(int(limit), 500))}
        return {
            'ok': True,
            'backend': 'uiautomation',
            'tree': _uia_tree_payload(root, 0, max_depth, limit_state),
            'truncated': limit_state['remaining'] <= 0,
        }
    except Exception as exc:
        status = _uia_status_payload()
        return _fail(exc, uia=status)


@mcp.tool()
def codex_desktop_control_uia_click(
    query: str | None = None,
    name_contains: str | None = None,
    automation_id: str | None = None,
    class_name: str | None = None,
    control_type: str | None = None,
    hwnd: int | None = None,
    title_contains: str | None = None,
    exact: bool = False,
    index: int = 0,
    max_depth: int = 4,
    verify_after: bool = False,
    verify_bbox: list[int] | None = None,
    verify_delay_ms: int = 200,
) -> dict[str, Any]:
    """Find and invoke or click one native UIA control.

    Filters match codex_desktop_control_uia_find; exact=true requires complete equality. index selects among matches. Prefer invoke=true for buttons and use verify_after to capture post-action evidence.
    """
    if not any([query, name_contains, automation_id, class_name, control_type]):
        return _fail('provide query, name_contains, automation_id, class_name, or control_type', 'VALIDATION_ERROR')
    try:
        if IS_MACOS:
            resolved, found = _macos_uia_find(
                query=query, name_contains=name_contains, automation_id=automation_id,
                class_name=class_name, control_type=control_type, hwnd=hwnd,
                title_contains=title_contains, exact=exact, limit=max(1, int(index) + 1),
            )
            if not found:
                return _fail('no matching Accessibility control found', 'UIA_UNAVAILABLE')
            selected = found[max(0, min(int(index), len(found) - 1))]
            clicked = _macos.accessibility_press(resolved, selected['accessibility_index'])
            result: dict[str, Any] = {'ok': bool(clicked.get('ok')), 'selected': selected, 'click': clicked}
            if verify_after:
                result['verification'] = _post_action_verification(
                    bbox=verify_bbox,
                    delay_seconds=float(verify_delay_ms) / 1000.0,
                )
            return result
        found = _uia_find_controls(
            query=query,
            name_contains=name_contains,
            automation_id=automation_id,
            class_name=class_name,
            control_type=control_type,
            hwnd=hwnd,
            title_contains=title_contains,
            exact=exact,
            max_depth=max_depth,
            limit=max(1, int(index) + 1),
        )
        if not found:
            return _fail('no matching UIA control found', 'UIA_UNAVAILABLE')
        selected = found[max(0, min(int(index), len(found) - 1))]
        clicked = _uia_click_control(selected['control'])
        result: dict[str, Any] = {'ok': bool(clicked.get('ok')), 'selected': selected['payload'], 'click': clicked}
        if verify_after:
            result['verification'] = _post_action_verification(
                bbox=verify_bbox,
                delay_seconds=float(verify_delay_ms) / 1000.0,
            )
        return result
    except Exception as exc:
        status = _uia_status_payload()
        return _fail(exc, uia=status)


@mcp.tool()
def codex_desktop_control_self_check() -> dict[str, Any]:
    """Run non-destructive capture, clipboard, OCR, UIA, and output-path diagnostics. Use this when status is insufficient or a desktop tool is failing."""
    _trace_self_check('start')
    checks: dict[str, Any] = {}
    warnings: list[str] = []
    try:
        checks['status'] = _status_payload()
        if not checks['status'].get('ui_detection', {}).get('enabled'):
            install = checks['status'].get('ui_detection', {}).get('install', {})
            warnings.append(f'UI detection model is not installed; visual fallback, OCR, and coordinates remain available. Install command: {install.get("install_command")}')
        checks['uia'] = checks['status'].get('uia') or _uia_status_payload()
        if not checks['uia'].get('available'):
            if IS_MACOS:
                warnings.append('macOS semantic Accessibility-tree controls are unavailable; window, screenshot, OCR, visual, and coordinate tools remain available.')
            else:
                warnings.append('UI Automation semantic controls are not available; install the optional uiautomation package to enable name/AutomationId/control-type actions.')
    except Exception as exc:
        checks['status'] = _fail(exc)
    _trace_self_check('status')
    try:
        windows = _list_windows(visible_only=True)
        checks['windows'] = {'ok': True, 'count': len(windows), 'foreground': _foreground_window_info()}
    except Exception as exc:
        checks['windows'] = _fail(exc)
    _trace_self_check('windows')
    try:
        screen = _get_screen_info()
        left = int(screen['virtual_left'])
        top = int(screen['virtual_top'])
        right = min(int(screen['virtual_right']), left + 320)
        bottom = min(int(screen['virtual_bottom']), top + 200)
        img = _capture_screen((left, top, right, bottom))
        checks['screenshot'] = {'ok': True, 'width': img.width, 'height': img.height, **_image_diagnostics(img)}
        if checks['screenshot'].get('probably_blank'):
            warnings.append('Small screen sample appears blank; desktop may be locked, covered, or unavailable.')
    except Exception as exc:
        checks['screenshot'] = {'ok': False, 'error': str(exc)}
    _trace_self_check('screenshot')
    try:
        Image, _ImageGrab = _import_pil()
        from PIL import ImageDraw

        sample = Image.new('RGB', (240, 140), 'white')
        draw = ImageDraw.Draw(sample)
        draw.rectangle([20, 20, 220, 58], outline='black', width=3)
        draw.rectangle([150, 88, 220, 120], outline='black', fill='#eeeeee', width=3)
        detections = _detect_visual_ui_candidates(sample, conf_threshold=0.25, max_candidates=10)
        checks['visual_fallback'] = {
            'ok': len(detections) > 0,
            'count': len(detections),
        }
        if not detections:
            warnings.append('Visual fallback UI detection returned no candidates on a synthetic sample.')
    except Exception as exc:
        checks['visual_fallback'] = {'ok': False, 'error': str(exc)}
        warnings.append('Visual fallback UI detection is not currently available.')
    _trace_self_check('visual_fallback')
    try:
        if IS_MACOS:
            clipboard = _macos.clipboard_read_text()
            if not clipboard.get('ok'):
                raise RuntimeError(clipboard.get('error') or 'clipboard is not readable')
        else:
            _api, _con, _gui, _ui, win32clipboard, _windll = _import_win32()
            _open_clipboard_with_retry(retries=3, delay_seconds=0.03)
            win32clipboard.CloseClipboard()
        checks['clipboard'] = {'ok': True}
    except Exception as exc:
        checks['clipboard'] = {'ok': False, 'error': str(exc)}
        warnings.append('Clipboard is not currently available.')
    _trace_self_check('clipboard')
    desktop_available = bool(checks.get('windows', {}).get('ok') and checks.get('screenshot', {}).get('ok'))
    if not desktop_available:
        warnings.append('Desktop capture is not currently available in this session; window, screenshot, and coordinate actions may fail until the interactive desktop is accessible.')
    hard_checks = ['status', 'clipboard'] if IS_MACOS else ['status', 'visual_fallback', 'clipboard']
    ok = all(checks.get(name, {}).get('ok', False) for name in hard_checks)
    _trace_self_check('return')
    return {'ok': ok, 'desktop_available': desktop_available, 'warnings': warnings, 'checks': checks}


@mcp.tool()
def codex_desktop_control_list_windows(title_contains: str | None = None, visible_only: bool = True) -> dict[str, Any]:
    """List top-level desktop windows. title_contains is a case-insensitive title filter; visible_only excludes hidden windows by default. Returns stable run-local hwnd identifiers for later calls."""
    try:
        windows = _list_windows(title_contains=title_contains, visible_only=visible_only)
        return {'ok': True, 'count': len(windows), 'windows': windows[:200]}
    except Exception as exc:
        return _fail(exc)


@mcp.tool()
def codex_desktop_control_activate_window(hwnd: int | None = None, title_contains: str | None = None) -> dict[str, Any]:
    """Bring one top-level window to the foreground. Select it by exact hwnd or a case-insensitive title substring; hwnd is preferred when known."""
    try:
        return _activate(_resolve_hwnd(hwnd=hwnd, title_contains=title_contains))
    except Exception as exc:
        return _fail(exc)


@mcp.tool()
def codex_desktop_control_screenshot(
    path: str | None = None,
    hwnd: int | None = None,
    title_contains: str | None = None,
    bbox: list[int] | None = None,
    include_data: bool = False,
    format: str = 'png',
    client_area: bool = False,
) -> dict[str, Any]:
    """Capture the virtual desktop, a physical-pixel bbox, or a selected window.

    Select a window with hwnd/title_contains and optionally client_area=true. path must be inside CODEX_DESKTOP_CONTROL_OUTPUT_DIR; include_data embeds image bytes and can make responses large.
    """
    if format.lower() not in {'png', 'jpeg', 'jpg'}:
        return _fail('format must be png or jpeg', 'VALIDATION_ERROR')
    fmt = 'jpeg' if format.lower() == 'jpg' else format.lower()
    try:
        if hwnd or title_contains:
            resolved = _resolve_hwnd(hwnd=hwnd, title_contains=title_contains)
            img = _capture_window(resolved, client_area=client_area)
            default_name = f'window_{resolved}'
        else:
            img = _capture_screen(_normalize_bbox(bbox))
            default_name = 'screen'
        return _image_to_payload(img, include_data=include_data, path=path, format=fmt, default_name=default_name)
    except Exception as exc:
        return _fail(exc)


@mcp.tool()
def codex_desktop_control_observe(
    before_image_path: str | None = None,
    hwnd: int | None = None,
    title_contains: str | None = None,
    bbox: list[int] | None = None,
    client_area: bool = False,
    threshold: int = 12,
    path: str | None = None,
) -> dict[str, Any]:
    """Capture current desktop state and optionally compare it with a prior screenshot created under the configured output directory."""
    try:
        current, origin, coordinate_space, source = _capture_source(
            hwnd=hwnd, title_contains=title_contains, bbox=bbox, client_area=client_area,
        )
        snapshot_path = path or f'observe_{time.time_ns()}.png'
        snapshot = _image_to_payload(current, include_data=False, path=snapshot_path, format='png', default_name='observe')
        result: dict[str, Any] = {
            'ok': True,
            'source': source,
            'origin': origin,
            'coordinate_space': coordinate_space,
            'snapshot': snapshot,
            'image': _image_diagnostics(current),
        }
        if before_image_path:
            before, _before_origin, _before_space, before_source = _capture_source(image_path=before_image_path)
            result['before_source'] = before_source
            result['difference'] = _compare_images(before, current, threshold=threshold)
        return result
    except Exception as exc:
        return _fail(exc)


def _workflow_dispatch(action: str, arguments: dict[str, Any]) -> dict[str, Any]:
    normalized = action.strip().lower()
    prefix = 'codex_desktop_control_'
    if normalized.startswith(prefix):
        normalized = normalized[len(prefix):]
    actions = {
        'activate_window': codex_desktop_control_activate_window,
        'screenshot': codex_desktop_control_screenshot,
        'observe': codex_desktop_control_observe,
        'uia_click': codex_desktop_control_uia_click,
        'click': codex_desktop_control_click,
        'mouse_button': codex_desktop_control_mouse_button,
        'move_mouse': codex_desktop_control_move_mouse,
        'scroll': codex_desktop_control_scroll,
        'drag': codex_desktop_control_drag,
        'hotkey': codex_desktop_control_hotkey,
        'press_key': codex_desktop_control_press_key,
        'type_text': codex_desktop_control_type_text,
        'paste_text': codex_desktop_control_paste_text,
        'find_text': codex_desktop_control_find_text,
        'wait_for_text': codex_desktop_control_wait_for_text,
        'click_and_wait_text': codex_desktop_control_click_and_wait_text,
    }
    if normalized == 'sleep':
        duration_ms = max(0, min(int(arguments.get('duration_ms', 0)), 60_000))
        time.sleep(duration_ms / 1000.0)
        return {'ok': True, 'duration_ms': duration_ms}
    target = actions.get(normalized)
    if target is None:
        return _fail(f'unsupported workflow action: {action}', 'VALIDATION_ERROR', supported_actions=sorted([*actions, 'sleep']))
    return target(**arguments)


@mcp.tool()
def codex_desktop_control_workflow(
    steps: list[dict[str, Any]],
    continue_on_error: bool = False,
    observe_changes: bool = False,
    observe_bbox: list[int] | None = None,
    change_threshold: int = 12,
) -> dict[str, Any]:
    """Execute up to 50 desktop actions in order in one MCP call. Steps are unrestricted existing actions; failures stop the workflow unless continue_on_error=true."""
    try:
        before = _capture_screen(_normalize_bbox(observe_bbox)) if observe_changes else None
        result = _execute_workflow(steps, _workflow_dispatch, continue_on_error=continue_on_error)
        if before is not None:
            after = _capture_screen(_normalize_bbox(observe_bbox))
            result['difference'] = _compare_images(before, after, threshold=change_threshold)
        return result
    except ValueError as exc:
        return _fail(exc, 'VALIDATION_ERROR')
    except Exception as exc:
        return _fail(exc)


def _ocr_payload(
    image_path: str | None = None,
    hwnd: int | None = None,
    title_contains: str | None = None,
    bbox: list[int] | None = None,
    enhance: bool = False,
    client_area: bool = False,
) -> dict[str, Any]:
    try:
        img, origin, coordinate_space, source = _capture_source(
            image_path=image_path,
            hwnd=hwnd,
            title_contains=title_contains,
            bbox=bbox,
            client_area=client_area,
        )
        return {'ok': True, 'origin': origin, 'coordinate_space': coordinate_space, 'source': source, **_ocr_image(img, enhance=enhance)}
    except Exception as exc:
        return _fail(exc)


@mcp.tool()
def codex_desktop_control_ocr(
    image_path: str | None = None,
    hwnd: int | None = None,
    title_contains: str | None = None,
    bbox: list[int] | None = None,
    enhance: bool = False,
    client_area: bool = False,
) -> dict[str, Any]:
    """Run OCR on an image file, physical-pixel screen bbox, or selected window. Returns text plus per-line boxes and coordinate-space metadata; enhance may improve low-contrast text at extra cost."""
    return _ocr_payload(image_path=image_path, hwnd=hwnd, title_contains=title_contains, bbox=bbox, enhance=enhance, client_area=client_area)


def _find_text_payload(
    query: str,
    image_path: str | None = None,
    hwnd: int | None = None,
    title_contains: str | None = None,
    bbox: list[int] | None = None,
    exact: bool = False,
    enhance: bool = False,
    client_area: bool = False,
) -> dict[str, Any]:
    if not query.strip():
        return _fail('query must be non-empty', 'VALIDATION_ERROR')
    try:
        ocr = _ocr_payload(
            image_path=image_path,
            hwnd=hwnd,
            title_contains=title_contains,
            bbox=bbox,
            enhance=enhance,
            client_area=client_area,
        )
        if not ocr.get('ok'):
            return ocr
        needle = query if exact else query.lower()
        origin = ocr.get('origin') or [0.0, 0.0]
        coordinate_space = ocr.get('coordinate_space')
        matches = []
        for detail in ocr.get('details', []):
            text = detail.get('text', '')
            haystack = text if exact else text.lower()
            matched = haystack == needle if exact else needle in haystack
            if matched:
                points = detail.get('bbox') or []
                xs = [float(point[0]) for point in points] if points else []
                ys = [float(point[1]) for point in points] if points else []
                center = [sum(xs) / len(xs), sum(ys) / len(ys)] if xs and ys else None
                screen_center = None
                screen_bbox = None
                if coordinate_space == 'virtual_screen_physical_pixels' and center:
                    screen_center = [origin[0] + center[0], origin[1] + center[1]]
                    screen_bbox = [[origin[0] + float(point[0]), origin[1] + float(point[1])] for point in points]
                matches.append({**detail, 'center': center, 'screen_center': screen_center, 'screen_bbox': screen_bbox})
        return {
            'ok': True,
            'query': query,
            'count': len(matches),
            'matches': matches,
            'text': ocr.get('text', ''),
            'origin': origin,
            'coordinate_space': coordinate_space,
            'source': ocr.get('source'),
        }
    except Exception as exc:
        return _fail(exc)


@mcp.tool()
def codex_desktop_control_find_text(
    query: str,
    image_path: str | None = None,
    hwnd: int | None = None,
    title_contains: str | None = None,
    bbox: list[int] | None = None,
    exact: bool = False,
    enhance: bool = False,
    client_area: bool = False,
) -> dict[str, Any]:
    """Locate OCR text in an image, screen bbox, or selected window.

    exact=true requires a complete case-sensitive OCR line match; false uses case-insensitive substring matching. Returned screen_center coordinates are physical virtual-screen pixels suitable for click tools.
    """
    return _find_text_payload(
        query=query,
        image_path=image_path,
        hwnd=hwnd,
        title_contains=title_contains,
        bbox=bbox,
        exact=exact,
        enhance=enhance,
        client_area=client_area,
    )


def _wait_for_text(
    query: str,
    *,
    image_path: str | None = None,
    hwnd: int | None = None,
    title_contains: str | None = None,
    bbox: list[int] | None = None,
    exact: bool = False,
    enhance: bool = False,
    client_area: bool = False,
    timeout_ms: int = 3000,
    interval_ms: int = 250,
) -> dict[str, Any]:
    started = time.time()
    last = None
    while (time.time() - started) * 1000 <= max(0, timeout_ms):
        last = _find_text_payload(
            query=query,
            image_path=image_path,
            hwnd=hwnd,
            title_contains=title_contains,
            bbox=bbox,
            exact=exact,
            enhance=enhance,
            client_area=client_area,
        )
        if last.get('ok') and last.get('count', 0) > 0:
            return {'ok': True, 'elapsed_ms': int((time.time() - started) * 1000), 'result': last}
        time.sleep(max(50, interval_ms) / 1000)
    return _fail(f'text not found before timeout: {query}', 'TIMEOUT', elapsed_ms=int((time.time() - started) * 1000), last_result=last)


@mcp.tool()
def codex_desktop_control_wait_for_text(
    query: str,
    image_path: str | None = None,
    hwnd: int | None = None,
    title_contains: str | None = None,
    bbox: list[int] | None = None,
    exact: bool = False,
    enhance: bool = False,
    client_area: bool = False,
    timeout_ms: int = 3000,
    interval_ms: int = 250,
) -> dict[str, Any]:
    """Poll OCR until text appears or timeout_ms expires. Matching follows find_text; interval_ms controls polling frequency and exact=true requires a complete case-sensitive line match."""
    if not query.strip():
        return _fail('query must be non-empty', 'VALIDATION_ERROR')
    try:
        return _wait_for_text(
            query,
            image_path=image_path,
            hwnd=hwnd,
            title_contains=title_contains,
            bbox=bbox,
            exact=exact,
            enhance=enhance,
            client_area=client_area,
            timeout_ms=timeout_ms,
            interval_ms=interval_ms,
        )
    except Exception as exc:
        return _fail(exc)


@mcp.tool()
def codex_desktop_control_detect_ui_elements(
    image_path: str | None = None,
    hwnd: int | None = None,
    title_contains: str | None = None,
    bbox: list[int] | None = None,
    conf_threshold: float = 0.25,
    include_ocr: bool = True,
    annotate_path: str | None = None,
    client_area: bool = False,
) -> dict[str, Any]:
    """Detect visual UI candidates and optionally OCR text in an image, screen bbox, or window. conf_threshold is 0..1; annotate_path writes marked output under the configured output root."""
    try:
        if conf_threshold < 0 or conf_threshold > 1:
            return _fail('conf_threshold must be between 0 and 1', 'VALIDATION_ERROR')
        model = None
        resolved_model = str(DEFAULT_UI_MODEL_PATH)
        model_error = None
        try:
            model, resolved_model = _get_yolo_model()
        except Exception as exc:
            model_error = str(exc)
        img, origin, coordinate_space, source = _capture_source(
            image_path=image_path,
            hwnd=hwnd,
            title_contains=title_contains,
            bbox=bbox,
            client_area=client_area,
        )
        detections = []
        detector = 'yolo'
        if model is not None:
            results = model(img, conf=conf_threshold, verbose=False)
            for result in results:
                boxes = getattr(result, 'boxes', None)
                if boxes is None:
                    continue
                for box in boxes:
                    x1, y1, x2, y2 = [float(v) for v in box.xyxy[0].cpu().tolist()]
                    geometry = _get_bbox_geometry([[x1, y1], [x2, y1], [x2, y2], [x1, y2]])
                    detections.append({
                        **geometry,
                        **_to_screen_geometry(geometry, origin, coordinate_space),
                        'confidence': float(box.conf[0]),
                        'class': int(box.cls[0]),
                        'detector': 'yolo',
                    })
        else:
            detector = 'visual_fallback'
            for det in _detect_visual_ui_candidates(img, conf_threshold=conf_threshold):
                det.update(_to_screen_geometry(det, origin, coordinate_space))
                detections.append(det)
        ocr = None
        if include_ocr:
            ocr = {'ok': True, **_ocr_image(img)}
            for detail in ocr.get('details', []):
                geometry = _get_bbox_geometry(detail['bbox'])
                detail.update(geometry)
                detail.update(_to_screen_geometry(geometry, origin, coordinate_space))
        annotation = None
        if annotate_path:
            Image, _ImageGrab = _import_pil()
            from PIL import ImageDraw

            annotated = img.copy()
            draw = ImageDraw.Draw(annotated)
            for det in detections:
                left, top, right, bottom = det['rect']
                draw.rectangle([left, top, right, bottom], outline='red', width=2)
                draw.text((left, max(0, top - 12)), f"{det['confidence']:.2f}", fill='red')
            if ocr:
                for detail in ocr.get('details', []):
                    geometry = _get_bbox_geometry(detail['bbox'])
                    points = [(point[0], point[1]) for point in geometry['bbox']]
                    draw.line(points + [points[0]], fill='blue', width=1)
            annotation = _image_to_payload(annotated, include_data=False, path=annotate_path, format='png', default_name='ui_detect')
        return {
            'ok': True,
            'model_path': resolved_model,
            'model_available': model is not None,
            'detector': detector,
            'warning': f'UI detection model unavailable; returned visual fallback plus OCR result: {model_error}' if model_error else None,
            'source': source,
            'origin': origin,
            'coordinate_space': coordinate_space,
            'count': len(detections),
            'detections': detections,
            'ocr': ocr,
            'annotation': annotation,
        }
    except Exception as exc:
        return _fail(exc, model_path=str(DEFAULT_UI_MODEL_PATH), model_install=_ui_model_install_payload())


def _screen_point(x: float, y: float) -> tuple[int, int, dict[str, Any]]:
    screen = _get_screen_info()
    ix = int(round(x))
    iy = int(round(y))
    if ix < screen['virtual_left'] or iy < screen['virtual_top'] or ix >= screen['virtual_right'] or iy >= screen['virtual_bottom']:
        raise ValueError(f'coordinates outside virtual screen bounds: ({ix}, {iy})')
    return ix, iy, screen


def _activate_if_requested(title_contains: str | None) -> None:
    if title_contains:
        _activate(_resolve_hwnd(title_contains=title_contains))


def _mouse_button_payload(
    x: float,
    y: float,
    *,
    button: str = 'left',
    action: str = 'click',
    clicks: int = 1,
    activate_title_contains: str | None = None,
) -> dict[str, Any]:
    try:
        _activate_if_requested(activate_title_contains)
        ix, iy, screen = _screen_point(x, y)
        normalized_button = str(button).lower()
        normalized_action = str(action).lower()
        if normalized_button not in {'left', 'right', 'middle'}:
            return _fail('button must be left, right, or middle', 'VALIDATION_ERROR')
        if normalized_action not in {'click', 'down', 'up'}:
            return _fail('action must be click, down, or up', 'VALIDATION_ERROR')
        if IS_MACOS:
            _macos.mouse_button(ix, iy, button=normalized_button, action=normalized_action, clicks=clicks)
        else:
            _windows_input.mouse_button(ix, iy, button=normalized_button, action=normalized_action, clicks=clicks)
        return {
            'ok': True, 'x': ix, 'y': iy, 'button': normalized_button,
            'action': normalized_action, 'clicks': max(1, int(clicks)),
            'coordinate_system': screen['coordinate_system'],
        }
    except ValueError as exc:
        code = 'COORD_OUT_OF_BOUNDS' if 'outside virtual screen bounds' in str(exc) else 'VALIDATION_ERROR'
        return _fail(exc, code)
    except Exception as exc:
        return _fail(exc)


def _click_payload(
    x: float,
    y: float,
    activate_title_contains: str | None = None,
    verify_after: bool = False,
    verify_bbox: list[int] | None = None,
    verify_delay_ms: int = 200,
) -> dict[str, Any]:
    try:
        if IS_MACOS:
            _activate_if_requested(activate_title_contains)
            ix, iy, screen = _screen_point(x, y)
            _macos.click(ix, iy)
            result = {'ok': True, 'x': ix, 'y': iy, 'coordinate_system': screen['coordinate_system']}
        else:
            result = _mouse_button_payload(
                x, y, button='left', action='click', clicks=1,
                activate_title_contains=activate_title_contains,
            )
        if not result.get('ok'):
            return result
        if verify_after:
            result['verification'] = _post_action_verification(
                bbox=verify_bbox,
                delay_seconds=float(verify_delay_ms) / 1000.0,
            )
        return result
    except Exception as exc:
        return _fail(exc)


@mcp.tool()
def codex_desktop_control_click(
    x: float,
    y: float,
    activate_title_contains: str | None = None,
    verify_after: bool = False,
    verify_bbox: list[int] | None = None,
    verify_delay_ms: int = 200,
) -> dict[str, Any]:
    """Left-click physical virtual-screen coordinates x,y. Optionally activate a window title first; verify_after captures bounded post-action visual evidence."""
    return _click_payload(
        x=x,
        y=y,
        activate_title_contains=activate_title_contains,
        verify_after=verify_after,
        verify_bbox=verify_bbox,
        verify_delay_ms=verify_delay_ms,
    )


@mcp.tool()
def codex_desktop_control_mouse_button(
    x: float,
    y: float,
    button: str = 'left',
    action: str = 'click',
    clicks: int = 1,
    activate_title_contains: str | None = None,
) -> dict[str, Any]:
    """Click, press, or release the left, right, or middle mouse button at physical screen coordinates. No confirmation or application restriction is added."""
    return _mouse_button_payload(
        x, y, button=button, action=action, clicks=clicks,
        activate_title_contains=activate_title_contains,
    )


@mcp.tool()
def codex_desktop_control_move_mouse(
    x: float,
    y: float,
    duration_ms: int = 0,
    activate_title_contains: str | None = None,
) -> dict[str, Any]:
    """Move the pointer to physical screen coordinates, optionally animating the move over duration_ms."""
    try:
        _activate_if_requested(activate_title_contains)
        ix, iy, screen = _screen_point(x, y)
        if IS_MACOS:
            _macos.move_mouse(ix, iy, duration_ms=max(0, int(duration_ms)))
        else:
            _windows_input.move_mouse(ix, iy, duration_ms=max(0, int(duration_ms)))
        return {'ok': True, 'x': ix, 'y': iy, 'duration_ms': max(0, int(duration_ms)), 'coordinate_system': screen['coordinate_system']}
    except ValueError as exc:
        code = 'COORD_OUT_OF_BOUNDS' if 'outside virtual screen bounds' in str(exc) else 'VALIDATION_ERROR'
        return _fail(exc, code)
    except Exception as exc:
        return _fail(exc)


@mcp.tool()
def codex_desktop_control_scroll(
    delta_y: int,
    delta_x: int = 0,
    x: float | None = None,
    y: float | None = None,
    activate_title_contains: str | None = None,
) -> dict[str, Any]:
    """Scroll vertically and/or horizontally. Positive delta_y scrolls up; negative scrolls down. Optional x,y first position the pointer."""
    try:
        _activate_if_requested(activate_title_contains)
        if (x is None) != (y is None):
            return _fail('x and y must be provided together', 'VALIDATION_ERROR')
        if x is not None and y is not None:
            ix, iy, _screen = _screen_point(x, y)
            if IS_MACOS:
                _macos.move_mouse(ix, iy)
            else:
                _windows_input.move_mouse(ix, iy)
        if IS_MACOS:
            _macos.scroll(int(delta_y), int(delta_x))
        else:
            _windows_input.scroll(int(delta_y), int(delta_x))
        return {'ok': True, 'delta_y': int(delta_y), 'delta_x': int(delta_x), 'x': x, 'y': y}
    except ValueError as exc:
        code = 'COORD_OUT_OF_BOUNDS' if 'outside virtual screen bounds' in str(exc) else 'VALIDATION_ERROR'
        return _fail(exc, code)
    except Exception as exc:
        return _fail(exc)


@mcp.tool()
def codex_desktop_control_drag(
    start_x: float,
    start_y: float,
    end_x: float,
    end_y: float,
    duration_ms: int = 400,
    button: str = 'left',
    activate_title_contains: str | None = None,
) -> dict[str, Any]:
    """Drag directly between two physical screen points with the selected mouse button."""
    try:
        _activate_if_requested(activate_title_contains)
        sx, sy, screen = _screen_point(start_x, start_y)
        ex, ey, _screen = _screen_point(end_x, end_y)
        normalized_button = str(button).lower()
        if normalized_button not in {'left', 'right', 'middle'}:
            return _fail('button must be left, right, or middle', 'VALIDATION_ERROR')
        if IS_MACOS:
            _macos.drag(sx, sy, ex, ey, duration_ms=max(0, int(duration_ms)), button=normalized_button)
        else:
            _windows_input.drag(sx, sy, ex, ey, duration_ms=max(0, int(duration_ms)), button=normalized_button)
        return {
            'ok': True, 'start': [sx, sy], 'end': [ex, ey], 'button': normalized_button,
            'duration_ms': max(0, int(duration_ms)), 'coordinate_system': screen['coordinate_system'],
        }
    except ValueError as exc:
        code = 'COORD_OUT_OF_BOUNDS' if 'outside virtual screen bounds' in str(exc) else 'VALIDATION_ERROR'
        return _fail(exc, code)
    except Exception as exc:
        return _fail(exc)


@mcp.tool()
def codex_desktop_control_click_and_wait_text(
    x: float,
    y: float,
    expected_text: str,
    activate_title_contains: str | None = None,
    hwnd: int | None = None,
    title_contains: str | None = None,
    bbox: list[int] | None = None,
    exact: bool = False,
    enhance: bool = False,
    timeout_ms: int = 3000,
    interval_ms: int = 250,
) -> dict[str, Any]:
    """Click physical virtual-screen coordinates, then poll OCR for expected_text. Use bbox/window selectors to narrow verification; exact=true requires a complete case-sensitive OCR line match."""
    clicked = _click_payload(x=x, y=y, activate_title_contains=activate_title_contains)
    if not clicked.get('ok'):
        return _fail(clicked.get('error') or 'click failed', clicked.get('code'), click=clicked)
    verified = _wait_for_text(
        expected_text,
        hwnd=hwnd,
        title_contains=title_contains,
        bbox=bbox,
        exact=exact,
        enhance=enhance,
        timeout_ms=timeout_ms,
        interval_ms=interval_ms,
    )
    return {'ok': bool(verified.get('ok')), 'click': clicked, 'verification': verified}


@mcp.tool()
def codex_desktop_control_double_click(
    x: float,
    y: float,
    activate_title_contains: str | None = None,
    verify_after: bool = False,
    verify_bbox: list[int] | None = None,
    verify_delay_ms: int = 200,
) -> dict[str, Any]:
    """Double-click physical virtual-screen coordinates. Optionally activate a window first and capture post-action verification evidence."""
    first = _click_payload(x=x, y=y, activate_title_contains=activate_title_contains)
    if not first.get('ok'):
        return first
    time.sleep(0.05)
    second = _click_payload(x=x, y=y)
    result: dict[str, Any] = {'ok': bool(second.get('ok')), 'x': x, 'y': y, 'coordinate_system': _get_screen_info()['coordinate_system'], 'second': second}
    if verify_after:
        result['verification'] = _post_action_verification(
            bbox=verify_bbox,
            delay_seconds=float(verify_delay_ms) / 1000.0,
        )
    return result


@mcp.tool()
def codex_desktop_control_hotkey(
    keys: list[str],
    activate_title_contains: str | None = None,
    verify_after: bool = False,
    verify_bbox: list[int] | None = None,
    verify_delay_ms: int = 200,
) -> dict[str, Any]:
    """Send a key chord to the foreground or selected window. Use command on macOS and ctrl on Windows for platform-native shortcuts; verify_after captures visual evidence."""
    try:
        if activate_title_contains:
            _activate(_resolve_hwnd(title_contains=activate_title_contains))
        _send_hotkey(keys)
        result: dict[str, Any] = {'ok': True, 'keys': keys}
        if verify_after:
            result['verification'] = _post_action_verification(
                bbox=verify_bbox,
                delay_seconds=float(verify_delay_ms) / 1000.0,
            )
        return result
    except Exception as exc:
        return _fail(exc)


@mcp.tool()
def codex_desktop_control_press_key(
    key: str,
    presses: int = 1,
    interval_ms: int = 50,
    activate_title_contains: str | None = None,
) -> dict[str, Any]:
    """Press one supported key repeatedly. This is direct input and does not add confirmation or policy checks."""
    try:
        _activate_if_requested(activate_title_contains)
        count = max(1, min(int(presses), 1000))
        for index in range(count):
            _send_hotkey([key])
            if index + 1 < count and interval_ms > 0:
                time.sleep(int(interval_ms) / 1000.0)
        return {'ok': True, 'key': key, 'presses': count, 'interval_ms': max(0, int(interval_ms))}
    except Exception as exc:
        return _fail(exc)


@mcp.tool()
def codex_desktop_control_type_text(
    text: str,
    interval_ms: int = 0,
    activate_title_contains: str | None = None,
) -> dict[str, Any]:
    """Type Unicode text directly into the focused control, optionally pausing between characters. Unlike paste_text, this does not use the clipboard."""
    try:
        _activate_if_requested(activate_title_contains)
        if IS_MACOS:
            if interval_ms > 0:
                for char in text:
                    _macos.type_text(char)
                    time.sleep(int(interval_ms) / 1000.0)
            else:
                _macos.type_text(text)
        else:
            _windows_input.type_text(text, interval_ms=max(0, int(interval_ms)))
        return {'ok': True, 'length': len(text), 'interval_ms': max(0, int(interval_ms)), 'method': 'direct_unicode_input'}
    except Exception as exc:
        return _fail(exc)


@mcp.tool()
def codex_desktop_control_paste_text(
    text: str,
    activate_title_contains: str | None = None,
    verify_text: str | None = None,
    verify_title_contains: str | None = None,
    verify_bbox: list[int] | None = None,
    verify_timeout_ms: int = 3000,
    verify_after: bool = False,
    verify_delay_ms: int = 200,
    restore_clipboard: bool = True,
    restore_delay_ms: int = 200,
) -> dict[str, Any]:
    """Paste Unicode text through the native clipboard and platform paste shortcut.

    Optionally activate a target window. restore_clipboard=true restores the prior clipboard even when paste or verification fails. verify_text polls OCR; verify_after captures post-action evidence.
    """
    clipboard_snapshot = None
    win32clipboard = None
    result: dict[str, Any] | None = None
    try:
        if activate_title_contains:
            _activate(_resolve_hwnd(title_contains=activate_title_contains))
        if IS_MACOS:
            if restore_clipboard:
                clipboard_snapshot = _macos.clipboard_read_text()
            _macos.clipboard_write_text(text)
        else:
            _api, win32con, _gui, _ui, win32clipboard, _windll = _import_win32()
            _open_clipboard_with_retry()
            try:
                if restore_clipboard:
                    clipboard_snapshot = _clipboard_snapshot(win32clipboard, win32con)
                win32clipboard.EmptyClipboard()
                win32clipboard.SetClipboardText(text, win32con.CF_UNICODETEXT)
            finally:
                win32clipboard.CloseClipboard()
        result = {'ok': True, 'length': len(text), 'clipboard_restore_requested': bool(restore_clipboard)}
        _send_hotkey(['command', 'v'] if IS_MACOS else ['ctrl', 'v'])
        if verify_after:
            result['post_action'] = _post_action_verification(
                bbox=verify_bbox,
                query=verify_text,
                delay_seconds=float(verify_delay_ms) / 1000.0,
            )
        if verify_text:
            result['verification'] = _wait_for_text(
                verify_text,
                title_contains=verify_title_contains or activate_title_contains,
                bbox=verify_bbox,
                timeout_ms=verify_timeout_ms,
            )
            result['ok'] = bool(result['verification'].get('ok'))
        return result
    except Exception as exc:
        result = _fail(exc)
        return result
    finally:
        if restore_clipboard and clipboard_snapshot is not None:
            time.sleep(max(0, int(restore_delay_ms)) / 1000.0)
            try:
                if IS_MACOS:
                    if clipboard_snapshot.get('ok'):
                        _macos.clipboard_write_text(clipboard_snapshot.get('text') or '')
                        restored = {'ok': True, 'restored_format_count': 1}
                    else:
                        restored = _fail(clipboard_snapshot.get('error') or 'clipboard snapshot failed', 'CLIPBOARD_RESTORE_FAILED')
                elif win32clipboard is not None:
                    restored = _restore_clipboard_snapshot(win32clipboard, clipboard_snapshot)
                else:
                    restored = _fail('clipboard backend unavailable', 'CLIPBOARD_RESTORE_FAILED')
            except Exception as exc:
                restored = _fail(exc, 'CLIPBOARD_RESTORE_FAILED')
            if result is not None:
                result['clipboard_restore'] = restored


if __name__ == '__main__':
    mcp.run()
