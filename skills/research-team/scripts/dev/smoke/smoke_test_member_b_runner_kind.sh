#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_ROOT="$(cd "${SCRIPT_DIR}/../../.." && pwd)"
BIN_DIR="${SKILL_ROOT}/scripts/bin"

tmp_root="$(mktemp -d)"
cleanup() { rm -rf "${tmp_root}"; }
trap cleanup EXIT

echo "[smoke] tmp_root=${tmp_root}"

tag="M3-r1"

echo "[setup] scaffold + demo milestone"
bash "${BIN_DIR}/scaffold_research_workflow.sh" --root "${tmp_root}" --project "SmokeMemberBRunnerKind" --profile "mixed" >/dev/null 2>&1
bash "${BIN_DIR}/generate_demo_milestone.sh" --root "${tmp_root}" --tag "${tag}" >/dev/null 2>&1

echo "[setup] relax non-essential gates for deterministic smoke test"
python3 - <<PY
import json
from pathlib import Path

p = Path("${tmp_root}") / "research_team_config.json"
d = json.loads(p.read_text(encoding="utf-8", errors="replace"))
d["review_access_mode"] = "packet_only"

d.setdefault("features", {})
for k in (
    "agents_anchor_gate",
    "notebook_integrity_gate",
    "research_plan_gate",
    "milestone_dod_gate",
    "packet_completeness_gate",
    "problem_framing_snapshot_gate",
    "knowledge_layers_gate",
    "references_gate",
):
    d["features"][k] = False

d["plan_tracking"] = {
    "enabled": False,
    "require_task_board": False,
    "require_progress_log": False,
    "log_on_fail": False,
}

p.write_text(json.dumps(d, indent=2, sort_keys=True) + "\n", encoding="utf-8")
PY

echo "[setup] approve project_charter.md (required by project_charter_gate)"
python3 - "${tmp_root}/project_charter.md" <<'PY'
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
    "Primary goal: smoke — validate Member B runner-kind selection + fallback",
    text,
    flags=re.MULTILINE,
)
text = re.sub(
    r"^Validation goal\(s\):\s*.*$",
    "Validation goal(s): smoke — run_team_cycle reaches convergence gate under member_b.runner_kind overrides",
    text,
    flags=re.MULTILINE,
)

text = re.sub(
    r"^\s*-\s*\(fill; e\.g\..*\)\s*$",
    "- Do not block the workflow when gemini CLI is unavailable; fall back to claude.",
    text,
    flags=re.MULTILINE,
)

# Replace the three template commitments with concrete demo links.
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
    "- Toolkit: Member B runner-kind selection + fallback",
    text,
    flags=re.MULTILINE,
)

path.write_text(text, encoding="utf-8")
print("patched:", path)
PY

echo "[setup] alternate Member B Claude system prompt"
cat >"${tmp_root}/prompts/_system_member_b_claude.txt" <<'TXT'
You are Member B (Claude runner fallback prompt).
TXT

cat >"${tmp_root}/stub_member_a.sh" <<'SH'
#!/usr/bin/env bash
set -euo pipefail

out=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --out) out="$2"; shift 2 ;;
    --model|--system-prompt-file|--prompt-file|--tools|--max-retries|--sleep-secs) shift 2 ;;
    *) shift ;;
  esac
done

if [[ -z "${out}" ]]; then
  echo "stub_member_a: missing --out" >&2
  exit 2
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
exit 0
SH
chmod +x "${tmp_root}/stub_member_a.sh"

cat >"${tmp_root}/stub_member_b_claude.sh" <<'SH'
#!/usr/bin/env bash
set -euo pipefail

out=""
sys=""
prompt=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --out) out="$2"; shift 2 ;;
    --system-prompt-file) sys="$2"; shift 2 ;;
    --prompt-file) prompt="$2"; shift 2 ;;
    --model|--tools|--max-retries|--sleep-secs) shift 2 ;;
    *) shift ;;
  esac
done

if [[ -z "${out}" ]]; then
  echo "stub_member_b_claude: missing --out" >&2
  exit 2
fi
if [[ -z "${sys}" || -z "${prompt}" ]]; then
  echo "stub_member_b_claude: expected --system-prompt-file and --prompt-file" >&2
  exit 3
fi
if [[ "${sys}" != *prompts/_system_member_b_claude.txt ]]; then
  echo "stub_member_b_claude: expected alt system prompt; got: ${sys}" >&2
  exit 4
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
exit 0
SH
chmod +x "${tmp_root}/stub_member_b_claude.sh"

echo "[test1] CLI: --member-b-runner-kind claude + --member-b-system-claude uses claude-style args"
log1="${tmp_root}/run_member_b_cli_kind.log"
set +e
(
  cd "${tmp_root}"
  bash "${BIN_DIR}/run_team_cycle.sh" \
    --tag "${tag}" \
    --notes research_contract.md \
    --out-dir team_cli_kind \
    --member-a-system prompts/_system_member_a.txt \
    --member-b-system prompts/_system_member_b.txt \
    --member-a-runner "${tmp_root}/stub_member_a.sh" \
    --member-b-runner-kind claude \
    --member-b-system-claude prompts/_system_member_b_claude.txt \
    --member-b-runner "${tmp_root}/stub_member_b_claude.sh" \
    --no-sidecar
) >"${log1}" 2>&1
code1=$?
set -e
if [[ ${code1} -ne 0 ]]; then
  echo "[fail] test1 expected success; got exit=${code1} and log:" >&2
  sed -n '1,260p' "${log1}" >&2 || true
  exit 1
fi
if ! grep -nF "[gate] running convergence gate" "${log1}" >/dev/null 2>&1; then
  echo "[fail] expected convergence gate log in ${log1}; got:" >&2
  sed -n '1,240p' "${log1}" >&2 || true
  exit 1
fi
echo "[ok] CLI runner-kind=claude path ok"

echo "[test2] config: member_b.runner_kind=claude + member_b.claude_system_prompt works without CLI flags"
python3 - <<PY
import json
from pathlib import Path

p = Path("${tmp_root}") / "research_team_config.json"
d = json.loads(p.read_text(encoding="utf-8", errors="replace"))
d.setdefault("member_b", {})
d["member_b"]["runner_kind"] = "claude"
d["member_b"]["claude_system_prompt"] = "prompts/_system_member_b_claude.txt"
p.write_text(json.dumps(d, indent=2, sort_keys=True) + "\n", encoding="utf-8")
PY
log2="${tmp_root}/run_member_b_config_kind.log"
set +e
(
  cd "${tmp_root}"
  bash "${BIN_DIR}/run_team_cycle.sh" \
    --tag "${tag}" \
    --notes research_contract.md \
    --out-dir team_config_kind \
    --member-a-system prompts/_system_member_a.txt \
    --member-b-system prompts/_system_member_b.txt \
    --member-a-runner "${tmp_root}/stub_member_a.sh" \
    --member-b-runner "${tmp_root}/stub_member_b_claude.sh" \
    --no-sidecar
) >"${log2}" 2>&1
code2=$?
set -e
if [[ ${code2} -ne 0 ]]; then
  echo "[fail] test2 expected success; got exit=${code2} and log:" >&2
  sed -n '1,260p' "${log2}" >&2 || true
  exit 1
fi
if ! grep -nF "[gate] running convergence gate" "${log2}" >/dev/null 2>&1; then
  echo "[fail] expected convergence gate log in ${log2}; got:" >&2
  sed -n '1,240p' "${log2}" >&2 || true
  exit 1
fi
echo "[ok] config runner-kind=claude path ok"

echo "[test3] fallback: gemini unhealthy -> member-b falls back to claude (no runner overrides)"
python3 - <<PY
import json
from pathlib import Path

p = Path("${tmp_root}") / "research_team_config.json"
d = json.loads(p.read_text(encoding="utf-8", errors="replace"))
d.setdefault("member_b", {})
d["member_b"]["runner_kind"] = "gemini"
d["member_b"].pop("claude_system_prompt", None)
# Keep this smoke deterministic even if global fallback defaults change.
d["member_b"]["fallback_order"] = "claude,codex"
p.write_text(json.dumps(d, indent=2, sort_keys=True) + "\n", encoding="utf-8")
PY
cat >"${tmp_root}/scripts/run_claude.sh" <<'SH'
#!/usr/bin/env bash
set -euo pipefail

out=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --out) out="$2"; shift 2 ;;
    --model|--system-prompt-file|--prompt-file|--tools|--max-retries|--sleep-secs) shift 2 ;;
    *) shift ;;
  esac
done

if [[ -z "${out}" ]]; then
  echo "stub project run_claude: missing --out" >&2
  exit 2
fi

cat >"${out}" <<'MD'
# Stub Report

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
exit 0
SH
chmod +x "${tmp_root}/scripts/run_claude.sh"

mkdir -p "${tmp_root}/fakebin"
cat >"${tmp_root}/fakebin/gemini" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
echo '{"response": ""}'
exit 0
SH
chmod +x "${tmp_root}/fakebin/gemini"

log3="${tmp_root}/run_member_b_fallback.log"
set +e
(
  cd "${tmp_root}"
  PATH="${tmp_root}/fakebin:${PATH}" bash "${BIN_DIR}/run_team_cycle.sh" \
    --tag "${tag}" \
    --notes research_contract.md \
    --out-dir team_fallback \
    --member-a-system prompts/_system_member_a.txt \
    --member-b-system prompts/_system_member_b.txt \
    --member-b-fallback-order claude,codex \
    --member-a-runner "${tmp_root}/stub_member_a.sh" \
    --no-sidecar
) >"${log3}" 2>&1
code3=$?
set -e
if [[ ${code3} -ne 0 ]]; then
  echo "[fail] test3 expected success; got exit=${code3} and log:" >&2
  sed -n '1,320p' "${log3}" >&2 || true
  exit 1
fi
if ! grep -nF "falling back to claude for member-b" "${log3}" >/dev/null 2>&1; then
  echo "[fail] expected fallback warning in ${log3}; got:" >&2
  sed -n '1,260p' "${log3}" >&2 || true
  exit 1
fi
if ! grep -nF "[info] member-b runner-kind=claude" "${log3}" >/dev/null 2>&1; then
  echo "[fail] expected resolved runner-kind info in ${log3}; got:" >&2
  sed -n '1,260p' "${log3}" >&2 || true
  exit 1
fi
if ! grep -nF "[gate] running convergence gate" "${log3}" >/dev/null 2>&1; then
  echo "[fail] expected convergence gate log in ${log3}; got:" >&2
  sed -n '1,260p' "${log3}" >&2 || true
  exit 1
fi
echo "[ok] fallback path ok"

echo "[ok] Member B runner-kind smoke tests passed"
