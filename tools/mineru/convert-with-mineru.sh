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

[[ -f "$input_path" || -d "$input_path" ]] || { echo "Input not found: $input_path" >&2; exit 2; }
[[ -x "$mineru_bin" ]] || { echo "MinerU executable not found: $mineru_bin" >&2; exit 2; }
[[ "$method" =~ ^(auto|txt|ocr)$ ]] || { echo "Unsupported method: $method" >&2; exit 2; }
[[ "$language" =~ ^(ch|en)$ ]] || { echo "Unsupported language: $language" >&2; exit 2; }

mkdir -p "$output_dir"
args=("$mineru_bin" -p "$input_path" -o "$output_dir" -b pipeline -m "$method")
if [[ "$language" != "en" ]]; then
  args+=(-l "$language")
fi
exec "${args[@]}"
