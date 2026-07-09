from __future__ import annotations

import os
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
TEMP_ROOT = Path(tempfile.mkdtemp(prefix='codex-desktop-control-notepad-'))
os.environ['CODEX_DESKTOP_CONTROL_OUTPUT_DIR'] = str(TEMP_ROOT / 'output')
sys.path.insert(0, str(ROOT))

import server  # noqa: E402


def require(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)


def wait_for_window(title_contains: str, timeout: float = 10.0) -> dict:
    deadline = time.time() + timeout
    last = None
    while time.time() < deadline:
        last = server.codex_desktop_control_list_windows(title_contains=title_contains)
        if last.get('ok') and last.get('count', 0) > 0:
            return last['windows'][0]
        time.sleep(0.25)
    raise TimeoutError(f'window not found for {title_contains}: {last}')


def main() -> None:
    fixture = TEMP_ROOT / 'desktop_control_fixture.txt'
    fixture.write_text('Desktop fixture ready\n', encoding='utf-8')
    proc = subprocess.Popen(['notepad.exe', str(fixture)])
    try:
        window = wait_for_window(fixture.name)
        activated = server.codex_desktop_control_activate_window(hwnd=window['hwnd'])
        require(activated.get('ok'), f'activate failed: {activated}')

        pasted = server.codex_desktop_control_paste_text(
            text='\nE2E_OK\n',
            activate_title_contains=fixture.name,
            verify_text='E2E_OK',
            verify_timeout_ms=8000,
            restore_clipboard=True,
        )
        require(pasted.get('ok'), f'paste/verify failed: {pasted}')

        screenshot = server.codex_desktop_control_screenshot(
            title_contains=fixture.name,
            path='notepad_e2e.png',
        )
        require(screenshot.get('ok') and Path(screenshot['path']).is_file(), f'screenshot failed: {screenshot}')

        print('OK: Notepad E2E covered window activation, paste, OCR verification, and screenshot.')
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()
        shutil.rmtree(TEMP_ROOT, ignore_errors=True)


if __name__ == '__main__':
    main()
