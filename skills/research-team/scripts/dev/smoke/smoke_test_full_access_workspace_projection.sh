#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_ROOT="$(cd "${SCRIPT_DIR}/../../.." && pwd)"
BIN_DIR="${SKILL_ROOT}/scripts/bin"

tmp_root="$(mktemp -d)"
cleanup() { rm -rf "${tmp_root}"; }
trap cleanup EXIT

echo "[smoke] tmp_root=${tmp_root}"

tag="M4-r1"
run_dir="${tmp_root}/team_full_access/runs/${tag}"

echo "[setup] scaffold + demo milestone"
bash "${BIN_DIR}/scaffold_research_workflow.sh" --root "${tmp_root}" --project "SmokeFullAccessWorkspace" --profile "mixed" >/dev/null 2>&1
bash "${BIN_DIR}/generate_demo_milestone.sh" --root "${tmp_root}" --tag "${tag}" >/dev/null 2>&1

echo "[setup] enable full_access gates and relax unrelated gates"
python3 - "${tmp_root}/research_team_config.json" <<'PY'
from __future__ import annotations

import json
import sys
from pathlib import Path

path = Path(sys.argv[1])
cfg = json.loads(path.read_text(encoding="utf-8", errors="replace"))
cfg["review_access_mode"] = "full_access"
features = cfg.setdefault("features", {})
for key in (
    "agents_anchor_gate",
    "knowledge_layers_gate",
    "milestone_dod_gate",
    "notebook_integrity_gate",
    "packet_completeness_gate",
    "problem_framing_snapshot_gate",
    "references_gate",
    "research_plan_gate",
):
    features[key] = False
for key in (
    "clean_room_gate",
    "evidence_schema_gate",
    "independent_reproduction_gate",
    "logic_isolation_gate",
):
    features[key] = True
cfg["plan_tracking"] = {
    "enabled": False,
    "require_task_board": False,
    "require_progress_log": False,
    "log_on_fail": False,
}
path.write_text(json.dumps(cfg, indent=2, sort_keys=True) + "\n", encoding="utf-8")
PY

echo "[setup] approve PROJECT_CHARTER.md"
python3 - "${tmp_root}/PROJECT_CHARTER.md" <<'PY'
from __future__ import annotations

import re
import sys
from datetime import date
from pathlib import Path

path = Path(sys.argv[1])
text = path.read_text(encoding="utf-8", errors="replace").replace("\r\n", "\n").replace("\r", "\n")
today = date.today().isoformat()
text = re.sub(r"^Status:\s*DRAFT\b.*$", "Status: APPROVED", text, flags=re.MULTILINE)
text = re.sub(r"^Created:\s*.*$", f"Created: {today}", text, flags=re.MULTILINE)
text = re.sub(r"^Last updated:\s*.*$", f"Last updated: {today}", text, flags=re.MULTILINE)
text = re.sub(
    r"^Primary goal:\s*.*$",
    "Primary goal: smoke — validate full_access workspace projection against the real project tree",
    text,
    flags=re.MULTILINE,
)
text = re.sub(
    r"^Validation goal\(s\):\s*.*$",
    "Validation goal(s): smoke — file reads resolve project-relative paths and independent outputs sync back into artifacts/",
    text,
    flags=re.MULTILINE,
)
text = re.sub(
    r"^\s*-\s*\(fill; e\.g\..*\)\s*$",
    "- Do not regress the default full_access runtime into an empty workspace that breaks project-relative requests.",
    text,
    flags=re.MULTILINE,
)
text = re.sub(
    r"^\s*-\s*\(fill; KB:.*$",
    "- KB: [Bezanson2017](knowledge_base/literature/bezanson2017_julia.md) — demo literature note",
    text,
    flags=re.MULTILINE,
)
text = re.sub(
    r"^\s*-\s*\(fill; Method:.*$",
    "- Method: [demo_trace](knowledge_base/methodology_traces/demo_trace.md) — demo methodology trace",
    text,
    flags=re.MULTILINE,
)
text = re.sub(
    r"^\s*-\s*\(fill; Toolkit:.*$",
    "- Toolkit: projected full_access workspaces + independent reproduction artifacts",
    text,
    flags=re.MULTILINE,
)
path.write_text(text, encoding="utf-8")
PY

mkdir -p "${tmp_root}/shared_utils" "${tmp_root}/tools"
cat >"${tmp_root}/shared_utils/__init__.py" <<'PY'
# smoke helper package
PY
cat >"${tmp_root}/tools/__init__.py" <<'PY'
# smoke tool package
PY
cat >"${tmp_root}/shared_utils/num.py" <<'PY'
def helper() -> int:
    return 7
PY
cat >"${tmp_root}/tools/member_a_workspace_repro.py" <<'PY'
from __future__ import annotations

from pathlib import Path
import sys

import shared_utils.num

tag = sys.argv[1].strip()
base = Path("artifacts") / tag / "member_a" / "independent"
base.mkdir(parents=True, exist_ok=True)
(base / "independent_repro.py").write_text("import shared_utils.num\n", encoding="utf-8")
(base / "member_a_workspace.txt").write_text(f"member_a={shared_utils.num.helper()}\n", encoding="utf-8")
PY
cat >"${tmp_root}/tools/member_b_workspace_repro.py" <<'PY'
from __future__ import annotations

from pathlib import Path
import sys

import shared_utils.num

tag = sys.argv[1].strip()
base = Path("artifacts") / tag / "member_b" / "independent"
base.mkdir(parents=True, exist_ok=True)
(base / "independent_repro.py").write_text("import shared_utils.num\n", encoding="utf-8")
(base / "member_b_workspace.txt").write_text(f"member_b={shared_utils.num.helper()}\n", encoding="utf-8")
PY

cat >"${tmp_root}/stub_member_a.sh" <<'SH'
#!/usr/bin/env bash
set -euo pipefail

out=""
prompt=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --out) out="$2"; shift 2 ;;
    --prompt-file) prompt="$2"; shift 2 ;;
    --model|--system-prompt-file|--tools|--max-retries|--sleep-secs) shift 2 ;;
    *) shift ;;
  esac
done
[[ -n "${out}" ]] || { echo "stub_member_a: missing --out" >&2; exit 2; }
if [[ -n "${prompt}" && -f "${prompt}" ]] && grep -Eq '^MODE: REQUESTS_ONLY$' "${prompt}"; then
  python3 - "${out}" "${prompt}" <<'PY'
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

out_path = Path(sys.argv[1])
prompt_path = Path(sys.argv[2])
text = prompt_path.read_text(encoding="utf-8", errors="replace")
tag = re.search(r"^Tag:\s*(.+)$", text, re.MULTILINE).group(1).strip()
payload = {
    "files_read": [{"path": "Draft_Derivation.md", "anchor_or_line": "1", "purpose": "inspect notebook context"}],
    "commands_run": [{
        "command": f"python3 -m tools.member_a_workspace_repro {tag}",
        "cwd": ".",
        "purpose": "create synced independent outputs inside the projected workspace",
        "timeout_secs": 60,
        "expected_outputs": [
            f"artifacts/{tag}/member_a/independent/independent_repro.py",
            f"artifacts/{tag}/member_a/independent/member_a_workspace.txt",
        ],
    }],
    "network_queries": [],
}
out_path.write_text(json.dumps(payload), encoding="utf-8")
PY
  exit 0
fi
cat >"${out}" <<'MD'
# Member A Report

| Check | Result |
|---|---|
| Derivation replication | pass |
| Computation replication | pass |

## Derivation Replication
Comparison: match

## Computation Replication
Comparison: match

## Sweep Semantics / Parameter Dependence
Consistency verdict: pass

## Verdict
ready for next milestone
MD
SH
chmod +x "${tmp_root}/stub_member_a.sh"

cat >"${tmp_root}/stub_member_b.sh" <<'SH'
#!/usr/bin/env bash
set -euo pipefail

out=""
prompt=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --out) out="$2"; shift 2 ;;
    --prompt-file) prompt="$2"; shift 2 ;;
    --model|--output-format|--system-prompt-file) shift 2 ;;
    *) shift ;;
  esac
done
[[ -n "${out}" ]] || { echo "stub_member_b: missing --out" >&2; exit 2; }
if [[ -n "${prompt}" && -f "${prompt}" ]] && grep -Eq '^MODE: REQUESTS_ONLY$' "${prompt}"; then
  python3 - "${out}" "${prompt}" <<'PY'
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

out_path = Path(sys.argv[1])
prompt_path = Path(sys.argv[2])
text = prompt_path.read_text(encoding="utf-8", errors="replace")
tag = re.search(r"^Tag:\s*(.+)$", text, re.MULTILINE).group(1).strip()
payload = {
    "files_read": [{"path": "PROJECT_CHARTER.md", "anchor_or_line": "1", "purpose": "confirm the declared validation scope"}],
    "commands_run": [{
        "command": f"python3 -m tools.member_b_workspace_repro {tag}",
        "cwd": ".",
        "purpose": "create synced independent outputs inside the projected workspace",
        "timeout_secs": 60,
        "expected_outputs": [
            f"artifacts/{tag}/member_b/independent/independent_repro.py",
            f"artifacts/{tag}/member_b/independent/member_b_workspace.txt",
        ],
    }],
    "network_queries": [],
}
out_path.write_text(json.dumps(payload), encoding="utf-8")
PY
  exit 0
fi
cat >"${out}" <<'MD'
# Member B Report

| Check | Result |
|---|---|
| Derivation replication | pass |
| Computation replication | pass |

## Derivation Replication
Comparison: match

## Computation Replication
Comparison: match

## Sweep Semantics / Parameter Dependence
Consistency verdict: pass

## Verdict
ready for next milestone
MD
SH
chmod +x "${tmp_root}/stub_member_b.sh"

echo "[test] run full_access cycle with projected workspaces"
log="${tmp_root}/full_access_workspace_projection.log"
set +e
(
  cd "${tmp_root}"
  bash "${BIN_DIR}/run_team_cycle.sh" \
    --tag "${tag}" \
    --notes Draft_Derivation.md \
    --out-dir team_full_access \
    --member-a-system prompts/_system_member_a.txt \
    --member-b-system prompts/_system_member_b.txt \
    --member-a-runner "${tmp_root}/stub_member_a.sh" \
    --member-b-runner "${tmp_root}/stub_member_b.sh" \
    --no-sidecar
) >"${log}" 2>&1
code=$?
set -e
if [[ ${code} -ne 0 ]]; then
  echo "[fail] run_team_cycle exited with ${code}; log follows:" >&2
  sed -n '1,260p' "${log}" >&2 || true
  exit 1
fi

python3 - "${tmp_root}" "${tag}" "${run_dir}" <<'PY'
from __future__ import annotations

import json
import sys
from pathlib import Path

root = Path(sys.argv[1])
tag = sys.argv[2]
run_dir = Path(sys.argv[3])

def load(name: str) -> dict:
    return json.loads((run_dir / f"{name}_evidence.json").read_text(encoding="utf-8", errors="replace"))

for member, note_path, out_name in (
    ("member_a", "Draft_Derivation.md", "member_a_workspace.txt"),
    ("member_b", "PROJECT_CHARTER.md", "member_b_workspace.txt"),
):
    evidence = load(member)
    files_read = evidence.get("files_read", [])
    assert files_read and files_read[0]["path"] == note_path, files_read
    assert not files_read[0]["path"].startswith("/"), files_read[0]["path"]
    outputs = {item["path"] for item in evidence.get("outputs_produced", []) if isinstance(item, dict)}
    want = {
        f"artifacts/{tag}/{member}/independent/independent_repro.py",
        f"artifacts/{tag}/{member}/independent/{out_name}",
    }
    assert want.issubset(outputs), outputs
    results = (run_dir / member / "full_access_results.md").read_text(encoding="utf-8", errors="replace")
    assert "exit=0" in results, results
    assert note_path in results, results
    assert "(error)" not in results, results
    artifact_dir = root / "artifacts" / tag / member / "independent"
    assert (artifact_dir / "independent_repro.py").is_file(), artifact_dir
    assert (artifact_dir / out_name).is_file(), artifact_dir
PY

echo "[ok] full_access workspace projection smoke test passed"
