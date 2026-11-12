#!/bin/sh
set -eu
cd "$(dirname "$0")"
if command -v uv >/dev/null 2>&1; then
  if [ ! -x .venv/bin/python ]; then uv venv --python 3.12 .venv; fi
  uv pip install --python .venv/bin/python -r requirements-ai.txt
else
  if [ ! -x .venv/bin/python ]; then python3 -m venv .venv; fi
  .venv/bin/python -m pip install -r requirements-ai.txt
fi
.venv/bin/python -c 'from huggingface_hub import snapshot_download; snapshot_download("LiquidAI/d1-2B", revision="652f920e544ea37f81e4b0ce89b81d4ed0da90b1")'
mkdir -p models
YOLO_CONFIG_DIR=.cache/ultralytics .venv/bin/python -c 'from ultralytics import YOLO, settings; settings.update({"sync": False}); YOLO("models/yolo11s.pt")'
echo 'Ready. Start local inference with: .venv/bin/python server.py'
