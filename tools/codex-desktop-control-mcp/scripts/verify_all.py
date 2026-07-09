from __future__ import annotations

import subprocess
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def run(label: str, args: list[str]) -> None:
    print(f'== {label} ==')
    completed = subprocess.run(args, cwd=ROOT, text=True)
    if completed.returncode != 0:
        raise SystemExit(completed.returncode)


def main() -> int:
    python = sys.executable
    run('protocol smoke', [python, 'scripts/desktop_protocol_smoke_test.py'])
    run('desktop smoke', [python, 'scripts/desktop_smoke_test.py'])
    run('notepad e2e', [python, 'scripts/desktop_notepad_e2e_test.py'])
    run('ui model installer help', [python, 'scripts/install_ui_model.py', '--help'])
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
