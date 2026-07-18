from __future__ import annotations

import hashlib
from pathlib import Path
from typing import Any


def error_code(error: Any) -> str:
    message = str(error)
    lower = message.lower()
    if 'accessibility permission' in lower or 'privacy & security' in lower or 'not authorized' in lower:
        return 'PERMISSION_DENIED'
    if 'no matching window' in lower or 'window has empty bounds' in lower:
        return 'WINDOW_NOT_FOUND'
    if 'coordinates outside virtual screen bounds' in lower:
        return 'COORD_OUT_OF_BOUNDS'
    if 'image_path' in lower or 'path must be inside output_dir' in lower or 'does not exist' in lower:
        return 'FILE_ERROR'
    if 'uiautomation' in lower or 'uia' in lower:
        return 'UIA_UNAVAILABLE'
    if 'rapidocr' in lower or 'ocr' in lower:
        return 'OCR_UNAVAILABLE'
    if 'ui detection model' in lower or 'model.pt' in lower:
        return 'UI_MODEL_MISSING'
    if 'clipboard' in lower:
        return 'CLIPBOARD_UNAVAILABLE'
    if 'timeout' in lower or 'timed out' in lower:
        return 'TIMEOUT'
    if 'unsupported key' in lower or 'must ' in lower or 'provide ' in lower or 'query must' in lower:
        return 'VALIDATION_ERROR'
    return 'TOOL_ERROR'


def fail(error: Any, code: str | None = None, **extra: Any) -> dict[str, Any]:
    return {'ok': False, 'code': code or error_code(error), 'error': str(error), **extra}


def file_sha256(path: Path) -> str | None:
    try:
        h = hashlib.sha256()
        with path.open('rb') as handle:
            for chunk in iter(lambda: handle.read(1024 * 1024), b''):
                h.update(chunk)
        return h.hexdigest()
    except Exception:
        return None


def ui_model_install_payload(model_path: Path, script_path: Path) -> dict[str, Any]:
    return {
        'model_path': str(model_path),
        'exists': model_path.is_file(),
        'sha256': file_sha256(model_path) if model_path.is_file() else None,
        'source_env': 'CODEX_DESKTOP_CONTROL_UI_MODEL_SOURCE',
        'sha256_env': 'CODEX_DESKTOP_CONTROL_UI_MODEL_SHA256',
        'install_script': str(script_path),
        'install_command': f'python "{script_path}" --source <url-or-local-model.pt>',
    }
