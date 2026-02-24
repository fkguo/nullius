#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "${ROOT_DIR}"

tmp_root="$(mktemp -d)"
trap 'rm -rf "${tmp_root}"' EXIT

echo "[smoke] help: dl_lab_scaffold.py"
python3 scripts/bin/dl_lab_scaffold.py --help >/dev/null

echo "[smoke] scaffold: fixture project"
proj="${tmp_root}/dl_proj"
python3 scripts/bin/dl_lab_scaffold.py --out "${proj}" --name "smoke-proj" >/dev/null

test -f "${proj}/README.md"
test -f "${proj}/Draft_Derivation.md"
test -d "${proj}/knowledge_base"
test -d "${proj}/artifacts/runs"
test -f "${proj}/scripts/make_artifacts.py"

echo "[smoke] artifacts: demo run"
python3 "${proj}/scripts/make_artifacts.py" --tag M0-demo >/dev/null
test -f "${proj}/artifacts/runs/M0-demo/analysis.json"
test -f "${proj}/artifacts/runs/M0-demo/manifest.json"
test -f "${proj}/artifacts/runs/M0-demo/summary.json"
test -f "${proj}/artifacts/runs/M0-demo/checkpoints/best.json"

echo "[smoke] toy_run: CPU example"
toy="${tmp_root}/toy_run"
python3 examples/toy_run.py --out-dir "${toy}" --seed 0 >/dev/null
test -f "${toy}/manifest.json"
test -f "${toy}/summary.json"
test -f "${toy}/analysis.json"
python3 - "${toy}" <<'PY'
import json
import sys
from pathlib import Path

run_dir = Path(sys.argv[1])
summary = json.loads((run_dir / "summary.json").read_text(encoding="utf-8"))
assert isinstance(summary.get("metrics"), dict)
for key in ("val_loss_best", "val_accuracy_best", "best_epoch"):
    assert key in summary["metrics"], key
PY

echo "[smoke] ok"
