#!/usr/bin/env bash
set -euo pipefail

# Smoke test: deterministic auto-fill scripts must NOT introduce backticked file/KB pointers
# that violate the Markdown link hygiene gate.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_ROOT="$(cd "${SCRIPT_DIR}/../../.." && pwd)"
BIN_DIR="${SKILL_ROOT}/scripts/bin"
GATE="${SKILL_ROOT}/scripts/gates/check_markdown_link_hygiene.py"

tmp_root="$(mktemp -d)"
cleanup() { rm -rf "${tmp_root}"; }
trap cleanup EXIT

echo "[smoke] tmp_root=${tmp_root}"

bash "${BIN_DIR}/scaffold_research_workflow.sh" --root "${tmp_root}" --project "SmokeAutofillLinkHygiene" --profile "mixed" >/dev/null 2>&1

python3 - "${tmp_root}/research_team_config.json" <<'PY'
from __future__ import annotations

import json
import sys
from pathlib import Path

p = Path(sys.argv[1])
d = json.loads(p.read_text(encoding="utf-8", errors="replace"))
d.setdefault("features", {})
d["features"]["markdown_link_hygiene_gate"] = True
p.write_text(json.dumps(d, indent=2, sort_keys=True) + "\n", encoding="utf-8")
PY

python3 "${BIN_DIR}/auto_fill_prework.py" --root "${tmp_root}" --deterministic >/dev/null 2>&1
python3 "${BIN_DIR}/auto_fill_research_plan.py" --root "${tmp_root}" --deterministic >/dev/null 2>&1

python3 "${GATE}" --notes "${tmp_root}/Draft_Derivation.md" >/dev/null 2>&1

echo "[ok] autofill outputs satisfy markdown link hygiene gate"

