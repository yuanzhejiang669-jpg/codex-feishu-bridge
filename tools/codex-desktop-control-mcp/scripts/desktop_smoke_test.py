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
    require(self_check.get("ok") is True, json.dumps(self_check, ensure_ascii=False, indent=2))

    wait_result = server.codex_desktop_control_wait_for_text("__codex_unlikely_text__", timeout_ms=0)
    require(wait_result.get("ok") is False and "text not found" in wait_result.get("error", ""), f"unexpected wait result: {wait_result}")

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
