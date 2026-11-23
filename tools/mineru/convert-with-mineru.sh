#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 1 || $# -gt 4 ]]; then
  echo "Usage: $0 INPUT [OUTPUT_DIR] [auto|txt|ocr] [ch|en]" >&2
  exit 2
fi

input_path=$1
output_dir=${2:-"${HOME}/Documents/MinerU-Outputs"}
method=${3:-auto}
language=${4:-ch}
mineru_root=${MINERU_ROOT:-"${HOME}/Codex/tools/mineru"}
mineru_bin="${mineru_root}/.venv/bin/mineru"
if [[ ! -x "$mineru_bin" && -x "${mineru_root}/.venv/Scripts/mineru.exe" ]]; then
  mineru_bin="${mineru_root}/.venv/Scripts/mineru.exe"
fi

[[ -f "$input_path" || -d "$input_path" ]] || { echo "Input not found: $input_path" >&2; exit 2; }
if [[ ! -x "$mineru_bin" ]]; then
  echo "MinerU executable not found under MINERU_ROOT=${mineru_root} (checked .venv/bin/mineru and .venv/Scripts/mineru.exe)." >&2
  echo "Set MINERU_ROOT to your local MinerU directory; on Windows prefer python <mineru-skill>/scripts/convert.py --mineru-root <dir>." >&2
  exit 2
fi
[[ "$method" =~ ^(auto|txt|ocr)$ ]] || { echo "Unsupported method: $method" >&2; exit 2; }
[[ "$language" =~ ^(ch|en)$ ]] || { echo "Unsupported language: $language" >&2; exit 2; }

mkdir -p "$output_dir"
args=("$mineru_bin" -p "$input_path" -o "$output_dir" -b pipeline -m "$method")
if [[ "$language" != "en" ]]; then
  args+=(-l "$language")
fi
exec "${args[@]}"
