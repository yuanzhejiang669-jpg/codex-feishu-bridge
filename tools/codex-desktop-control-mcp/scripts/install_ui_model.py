from __future__ import annotations

import argparse
import hashlib
import os
import shutil
import sys
import tempfile
import urllib.request
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_OUTPUT_DIR = Path(os.environ.get('CODEX_DESKTOP_CONTROL_OUTPUT_DIR', Path.cwd() / '.context' / 'desktop-control')).expanduser().resolve()
DEFAULT_MODEL_PATH = Path(os.environ.get('CODEX_DESKTOP_CONTROL_UI_MODEL_PATH', DEFAULT_OUTPUT_DIR / 'weights' / 'icon_detect' / 'model.pt')).expanduser().resolve()


def is_relative_to(path: Path, parent: Path) -> bool:
    try:
        path.relative_to(parent)
        return True
    except ValueError:
        return False


def sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open('rb') as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b''):
            h.update(chunk)
    return h.hexdigest()


def fetch_source(source: str, temp_dir: Path) -> Path:
    if source.startswith(('http://', 'https://')):
        target = temp_dir / 'downloaded-model.pt'
        with urllib.request.urlopen(source, timeout=120) as response:
            with target.open('wb') as handle:
                shutil.copyfileobj(response, handle)
        return target
    local = Path(source).expanduser().resolve()
    if not local.is_file():
        raise FileNotFoundError(f'source model does not exist: {local}')
    return local


def main() -> int:
    parser = argparse.ArgumentParser(description='Install the Codex Desktop Control UI detection model.')
    parser.add_argument('--source', default=os.environ.get('CODEX_DESKTOP_CONTROL_UI_MODEL_SOURCE'), help='Local .pt path or http(s) URL. Also read from CODEX_DESKTOP_CONTROL_UI_MODEL_SOURCE.')
    parser.add_argument('--sha256', default=os.environ.get('CODEX_DESKTOP_CONTROL_UI_MODEL_SHA256'), help='Optional expected SHA-256. Also read from CODEX_DESKTOP_CONTROL_UI_MODEL_SHA256.')
    parser.add_argument('--target', default=str(DEFAULT_MODEL_PATH), help='Target model path. Defaults to CODEX_DESKTOP_CONTROL_UI_MODEL_PATH or output weights/icon_detect/model.pt.')
    args = parser.parse_args()

    if not args.source:
        parser.error('--source or CODEX_DESKTOP_CONTROL_UI_MODEL_SOURCE is required')

    target = Path(args.target).expanduser().resolve()
    weights_root = (DEFAULT_OUTPUT_DIR / 'weights').resolve()
    if not is_relative_to(target, weights_root):
        raise ValueError(f'target must be inside weights dir: {weights_root}')

    with tempfile.TemporaryDirectory(prefix='codex-desktop-ui-model-') as tmp:
        source_path = fetch_source(args.source, Path(tmp))
        actual = sha256(source_path)
        if args.sha256 and actual.lower() != args.sha256.lower():
            raise ValueError(f'sha256 mismatch: expected {args.sha256}, got {actual}')
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source_path, target)

    print(f'OK installed UI model: {target}')
    print(f'sha256={sha256(target)}')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
