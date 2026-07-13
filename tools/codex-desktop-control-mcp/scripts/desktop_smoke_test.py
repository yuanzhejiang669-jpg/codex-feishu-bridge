from __future__ import annotations

import json
import os
import sys
import tempfile
from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

os.environ.setdefault("CODEX_DESKTOP_CONTROL_OUTPUT_DIR", str(Path(tempfile.gettempdir()) / "codex-desktop-control-smoke"))

import server  # noqa: E402


def require(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)


def main() -> None:
    status = server.codex_desktop_control_status()
    require(status.get("ok") is True, f"status failed: {status}")
    require(status.get("screen", {}).get("virtual_width", 0) > 0, f"invalid screen info: {status.get('screen')}")

    self_check = server.codex_desktop_control_self_check()
    if self_check.get("ok") is not True:
        clipboard = self_check.get("checks", {}).get("clipboard", {})
        other_checks = ["status", "uia", "windows", "screenshot", "visual_fallback"]
        locked_clipboard_only = clipboard.get("ok") is False and all(self_check.get("checks", {}).get(name, {}).get("ok") is True for name in other_checks)
        require(locked_clipboard_only, json.dumps(self_check, ensure_ascii=False, indent=2))

    wait_result = server.codex_desktop_control_wait_for_text("__codex_unlikely_text__", timeout_ms=0)
    require(wait_result.get("ok") is False and "text not found" in wait_result.get("error", ""), f"unexpected wait result: {wait_result}")

    original_ocr_payload = server._ocr_payload
    try:
        server._ocr_payload = lambda **_kwargs: {
            "ok": True,
            "origin": [0.0, 0.0],
            "coordinate_space": "image_pixels",
            "source": {"type": "synthetic"},
            "text": "Save\nSave As",
            "details": [
                {"text": "Save", "bbox": [[0, 0], [20, 0], [20, 10], [0, 10]]},
                {"text": "Save As", "bbox": [[0, 20], [40, 20], [40, 30], [0, 30]]},
            ],
        }
        exact_match = server._find_text_payload("Save", exact=True)
        partial_match = server._find_text_payload("save", exact=False)
        require(exact_match.get("count") == 1 and exact_match["matches"][0]["text"] == "Save", f"exact OCR match was not equality: {exact_match}")
        require(partial_match.get("count") == 2, f"substring OCR match regressed: {partial_match}")
    finally:
        server._ocr_payload = original_ocr_payload

    class FakeClipboard:
        def EmptyClipboard(self):
            pass

        def SetClipboardText(self, _text, _format):
            pass

        def CloseClipboard(self):
            pass

    class FakeWin32Con:
        CF_UNICODETEXT = 13

    fake_clipboard = FakeClipboard()
    restore_calls = []
    originals = {
        "import_win32": server._import_win32,
        "open_clipboard": server._open_clipboard_with_retry,
        "snapshot": server._clipboard_snapshot,
        "restore": server._restore_clipboard_snapshot,
        "hotkey": server._send_hotkey,
    }
    try:
        server._import_win32 = lambda: (object(), FakeWin32Con(), object(), object(), fake_clipboard, object())
        server._open_clipboard_with_retry = lambda: None
        server._clipboard_snapshot = lambda _clipboard, _con: {"formats": [{"format": 13, "data": "original"}]}
        server._restore_clipboard_snapshot = lambda _clipboard, snapshot: restore_calls.append(snapshot) or {"ok": True, "restored": True}
        server._send_hotkey = lambda _keys: (_ for _ in ()).throw(RuntimeError("synthetic hotkey failure"))
        failed_paste = server.codex_desktop_control_paste_text("temporary", restore_delay_ms=0)
        require(failed_paste.get("ok") is False, f"synthetic paste failure unexpectedly succeeded: {failed_paste}")
        require(len(restore_calls) == 1, f"clipboard was not restored after hotkey failure: {failed_paste}")
        require(failed_paste.get("clipboard_restore", {}).get("ok") is True, f"restore result missing from failure payload: {failed_paste}")
    finally:
        server._import_win32 = originals["import_win32"]
        server._open_clipboard_with_retry = originals["open_clipboard"]
        server._clipboard_snapshot = originals["snapshot"]
        server._restore_clipboard_snapshot = originals["restore"]
        server._send_hotkey = originals["hotkey"]

    if self_check.get("desktop_available"):
        verified = server.codex_desktop_control_hotkey(keys=[], verify_after=True, verify_bbox=[0, 0, 320, 200])
        require(verified.get("ok") is True, f"hotkey verification failed: {verified}")
        require(verified.get("verification", {}).get("ok") is True, f"post-action verification failed: {verified}")

    synthetic = server.DEFAULT_OUTPUT_DIR / f"desktop_smoke_synthetic_ui_{os.getpid()}.png"
    synthetic.parent.mkdir(parents=True, exist_ok=True)
    image = Image.new("RGB", (360, 220), "white")
    draw = ImageDraw.Draw(image)
    draw.rectangle([30, 30, 330, 80], outline="black", width=3)
    draw.rectangle([220, 140, 330, 190], outline="black", fill="#eeeeee", width=3)
    draw.text((245, 157), "OK", fill="black")
    image.save(synthetic)

    detect_result = server.codex_desktop_control_detect_ui_elements(image_path=str(synthetic), include_ocr=False)
    require(detect_result.get("ok") is True, f"detect_ui_elements should degrade gracefully: {detect_result}")
    if not status.get("ui_detection", {}).get("enabled"):
        require(detect_result.get("detector") == "visual_fallback", f"expected visual fallback detector: {detect_result}")
        require(detect_result.get("count", 0) > 0, f"visual fallback found no candidates: {detect_result}")

    print("OK: desktop control status and self-check succeeded.")
    if self_check.get("warnings"):
        print("WARNINGS:")
        for warning in self_check["warnings"]:
            print(f"- {warning}")


if __name__ == "__main__":
    main()
