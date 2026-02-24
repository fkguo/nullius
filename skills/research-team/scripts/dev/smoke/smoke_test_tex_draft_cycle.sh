#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_ROOT="$(cd "${SCRIPT_DIR}/../../.." && pwd)"

GATE="${SKILL_ROOT}/scripts/gates/check_tex_draft_preflight.py"
DRAFT_CYCLE="${SKILL_ROOT}/scripts/bin/run_draft_cycle.sh"

tmp="$(mktemp -d)"
cleanup() { rm -rf "${tmp}"; }
trap cleanup EXIT

cd "${tmp}"

cat > research_team_config.json <<'EOF'
{
  "version": 1,
  "mode": "generic",
  "profile": "mixed",
  "features": {}
}
EOF

mkdir -p knowledge_base/literature
mkdir -p prompts
cat > prompts/README.md <<'EOF'
# prompts/README.md
(stub for smoke test)
EOF

echo "[test1] missing bib key -> FAIL (exit 1)"
cat > main.tex <<'EOF'
\documentclass{article}
\begin{document}
\section{Alpha}
We cite a missing key: \cite{MissingKey}.
\end{document}
EOF

cat > references.bib <<'EOF'
@article{PresentKey,
  title = {Present},
  author = {A},
  year = {2024}
}
EOF

set +e
python3 "${GATE}" --tex main.tex --bib references.bib >/tmp/smoke_tex_draft_gate_out1.txt 2>&1
code=$?
set -e
if [[ "${code}" -eq 0 ]]; then
  echo "[fail] expected non-zero exit for missing bib key" >&2
  cat /tmp/smoke_tex_draft_gate_out1.txt >&2 || true
  exit 1
fi

echo "[test2] pass with WARN (missing label/fig/KB) and packet contains substantive slices"
cat > main.tex <<'EOF'
\documentclass{article}
\begin{document}
\section{Alpha}
We describe our method. \cite{Key1}
We take the data from NNOline and add a uniform error model; see \cite{Key1}.
\begin{algorithm}
\caption{Algo}
\label{alg:one}
\end{algorithm}

\section{Beta}
Results include a figure: \includegraphics{figs/plot}
\cite{Key2}

\section{Gamma}
Physical interpretation and discussion.
We refer to Eq.~\eqref{eq:missing}.
\end{document}
EOF

cat > references.bib <<'EOF'
@article{Key1,
  title = {K1},
  author = {A},
  year = {2024}
}
@article{Key2,
  title = {K2},
  author = {B},
  year = {2024}
}
EOF

cat > knowledge_base/literature/Key1.md <<'EOF'
# Key1
- Source: (stub)
EOF

mkdir -p team

bash "${DRAFT_CYCLE}" --tag D0-r1 --tex main.tex --bib references.bib --out-dir team --preflight-only >/tmp/smoke_tex_draft_cycle_out2.txt 2>&1

run_dir_r1="team/runs/D0-r1"
packet_r1="${run_dir_r1}/D0-r1_draft_packet.md"
preflight_r1="${run_dir_r1}/D0-r1_draft_preflight.md"

if [[ ! -f "${packet_r1}" ]]; then
  echo "[fail] expected packet output missing: ${packet_r1}" >&2
  cat /tmp/smoke_tex_draft_cycle_out2.txt >&2 || true
  exit 1
fi
if [[ ! -f "${preflight_r1}" ]]; then
  echo "[fail] expected preflight report missing: ${preflight_r1}" >&2
  cat /tmp/smoke_tex_draft_cycle_out2.txt >&2 || true
  exit 1
fi

echo "[test2b] packet includes clickable links to preflight artifacts"
if ! grep -nF -- "- Preflight report: [D0-r1_draft_preflight.md](D0-r1_draft_preflight.md)" "${packet_r1}" >/dev/null 2>&1; then
  echo "[fail] expected preflight report link missing from packet" >&2
  sed -n '1,120p' "${packet_r1}" >&2 || true
  exit 1
fi
if ! grep -nF -- "- Preflight structure map (JSON): [D0-r1_draft_structure.json](D0-r1_draft_structure.json)" "${packet_r1}" >/dev/null 2>&1; then
  echo "[fail] expected preflight JSON link missing from packet" >&2
  sed -n '1,120p' "${packet_r1}" >&2 || true
  exit 1
fi
if ! grep -nF -- "- Prompt files README: [prompts/README.md](../../../prompts/README.md)" "${packet_r1}" >/dev/null 2>&1; then
  echo "[fail] expected prompts README link missing from packet" >&2
  sed -n '1,140p' "${packet_r1}" >&2 || true
  exit 1
fi

echo "[test2c] packet includes deterministic provenance/uncertainty risk scan"
if ! grep -nF -- "## Provenance / Uncertainty Risk Scan (Deterministic; Heuristic)" "${packet_r1}" >/dev/null 2>&1; then
  echo "[fail] expected risk scan section missing from packet" >&2
  sed -n '1,200p' "${packet_r1}" >&2 || true
  exit 1
fi
if ! grep -nF -- "- Provenance-like hits: 1" "${packet_r1}" >/dev/null 2>&1; then
  echo "[fail] expected exactly 1 provenance-like hit in packet risk scan" >&2
  sed -n '1,220p' "${packet_r1}" >&2 || true
  exit 1
fi
if ! grep -nF -- "- Uncertainty/weighting hits: 1" "${packet_r1}" >/dev/null 2>&1; then
  echo "[fail] expected exactly 1 uncertainty/weighting hit in packet risk scan" >&2
  sed -n '1,220p' "${packet_r1}" >&2 || true
  exit 1
fi
if ! grep -nE -- "NNOline.*inline cite keys: Key1" "${packet_r1}" >/dev/null 2>&1; then
  echo "[fail] expected risk scan hit line (NNOline + inline cite keys) missing from packet" >&2
  sed -n '1,260p' "${packet_r1}" >&2 || true
  exit 1
fi

if ! grep -nF "Slice 1: Alpha" "${packet_r1}" >/dev/null 2>&1; then
  echo "[fail] expected focus slice for Alpha not found in packet" >&2
  sed -n '1,220p' "${packet_r1}" >&2 || true
  exit 1
fi
if ! grep -nF "Slice 2: Beta" "${packet_r1}" >/dev/null 2>&1; then
  echo "[fail] expected focus slice for Beta not found in packet" >&2
  sed -n '1,220p' "${packet_r1}" >&2 || true
  exit 1
fi
if ! grep -nF "Slice 3: Gamma" "${packet_r1}" >/dev/null 2>&1; then
  echo "[fail] expected focus slice for Gamma not found in packet" >&2
  sed -n '1,220p' "${packet_r1}" >&2 || true
  exit 1
fi

echo "[test3] \\\\graphicspath resolves includegraphics (no missing-figure WARN)"
mkdir -p figs
: > figs/plot.png
cat > main.tex <<'EOF'
\documentclass{article}
\usepackage{graphicx}
\graphicspath{{figs/}}
\begin{document}
\section{Results}\label{sec:results}
See Sec.~\ref{sec:results}. \includegraphics{plot} \cite{Key1}
\end{document}
EOF

bash "${DRAFT_CYCLE}" --tag D0-r2 --tex main.tex --bib references.bib --out-dir team --preflight-only >/tmp/smoke_tex_draft_cycle_out3.txt 2>&1

preflight_r2="team/runs/D0-r2/D0-r2_draft_preflight.md"
if ! grep -nF -- "- Missing figures: 0" "${preflight_r2}" >/dev/null 2>&1; then
  echo "[fail] expected no missing figures when using \\\\graphicspath" >&2
  sed -n '1,120p' "${preflight_r2}" >&2 || true
  exit 1
fi

echo "[test4] full draft cycle with A/B/Leader + convergence gate (stub runners) -> PASS"
cat > stub_claude_draft.sh <<'SH'
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
  echo "stub_claude_draft: missing --out" >&2
  exit 2
fi

mkdir -p "$(dirname "${out}")"

if [[ "${RESEARCH_TEAM_STUB_DRAFT_CONTRACT_ERROR:-0}" == "1" ]]; then
  cat >"${out}" <<'MD'
## Blocking Issues (Must Fix)
- (Sec. 1): intentionally malformed report (missing blocking count line) to test exit=2 propagation

## Minimal Fix List
1. (Sec. 1): restore the required `Blocking issues count: N` line.

## Verdict
Verdict: needs revision
Rationale: contract violation test case
MD
  exit 0
fi

if [[ "${RESEARCH_TEAM_STUB_DRAFT_NEEDS_REVISION:-0}" == "1" ]]; then
  cat >"${out}" <<'MD'
## Blocking Issues (Must Fix)
- (Sec. 2, Eq. (1)): sign error; fix normalization and update downstream text (Correctness-Blocking)

## Minimal Fix List
1. (Sec. 2, Eq. (1)): flip the sign and propagate to Eq. (3).

## Verdict
Verdict: needs revision
Blocking issues count: 1
Rationale: correctness-blocking issue present
MD
  exit 0
fi

cat >"${out}" <<'MD'
## Blocking Issues (Must Fix)
(none)

## Minimal Fix List
1. (Sec. 1): tighten definitions (non-blocking).

## Verdict
Verdict: ready for review cycle
Blocking issues count: 0
Rationale: no correctness-blocking issues found in the packet excerpts
MD
exit 0
SH
chmod +x stub_claude_draft.sh

cat > stub_gemini_draft.sh <<'SH'
#!/usr/bin/env bash
set -euo pipefail

out=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --out) out="$2"; shift 2 ;;
    --model|--output-format|--prompt-file) shift 2 ;;
    *) shift ;;
  esac
done

if [[ -z "${out}" ]]; then
  echo "stub_gemini_draft: missing --out" >&2
  exit 2
fi

mkdir -p "$(dirname "${out}")"

if [[ "${RESEARCH_TEAM_STUB_DRAFT_NEEDS_REVISION:-0}" == "1" ]]; then
  cat >"${out}" <<'MD'
## Blocking Evidence Gaps
- (Fig. 1): referenced but missing file; results interpretation not verifiable

## Minimal Fix List
1. (Fig. 1): add the figure source and ensure it is included via \includegraphics.

## Verdict
Verdict: needs revision
Blocking issues count: 1
Rationale: blocking evidence gap
MD
  exit 0
fi

cat >"${out}" <<'MD'
## Blocking Evidence Gaps
(none)

## Minimal Fix List
1. (Intro): add one paragraph to scope the novelty (non-blocking).

## Verdict
Verdict: ready for review cycle
Blocking issues count: 0
Rationale: evidence sufficient for this review slice
MD
exit 0
SH
chmod +x stub_gemini_draft.sh

cat > prompts/_system_draft_member_a.txt <<'EOF'
(stub)
EOF
cat > prompts/_system_draft_member_b.txt <<'EOF'
(stub)
EOF
cat > prompts/_system_draft_member_c_leader.txt <<'EOF'
(stub)
EOF

log4="/tmp/smoke_tex_draft_cycle_out4.txt"
(
  bash "${DRAFT_CYCLE}" \
    --tag D0-r3 \
    --tex main.tex \
    --bib references.bib \
    --out-dir team \
    --member-a-system prompts/_system_draft_member_a.txt \
    --member-b-system prompts/_system_draft_member_b.txt \
    --member-c-system prompts/_system_draft_member_c_leader.txt \
    --member-a-runner "${tmp}/stub_claude_draft.sh" \
    --member-b-runner "${tmp}/stub_gemini_draft.sh" \
    --member-c-runner "${tmp}/stub_claude_draft.sh" \
    --require-convergence
) >"${log4}" 2>&1

if ! grep -nF "[gate] running draft convergence gate" "${log4}" >/dev/null 2>&1; then
  echo "[fail] expected draft convergence gate log in ${log4}; got:" >&2
  sed -n '1,240p' "${log4}" >&2 || true
  exit 1
fi

run_dir_r3="team/runs/D0-r3"
if [[ ! -f "${run_dir_r3}/D0-r3_draft_member_a.md" ]]; then
  echo "[fail] expected draft member A report missing" >&2
  exit 1
fi
if [[ ! -f "${run_dir_r3}/D0-r3_draft_member_b.md" ]]; then
  echo "[fail] expected draft member B report missing" >&2
  exit 1
fi
if [[ ! -f "${run_dir_r3}/D0-r3_draft_member_c_leader.md" ]]; then
  echo "[fail] expected draft leader report missing" >&2
  exit 1
fi
if [[ ! -f "${run_dir_r3}/D0-r3_draft_convergence_log.md" ]]; then
  echo "[fail] expected draft convergence log missing" >&2
  exit 1
fi
if [[ ! -f "${run_dir_r3}/D0-r3_draft_converged_summary.md" ]]; then
  echo "[fail] expected draft converged summary missing" >&2
  exit 1
fi

echo "[test5] non-converged draft should exit non-zero and still write convergence artifacts"
log5="/tmp/smoke_tex_draft_cycle_out5.txt"
set +e
(
  RESEARCH_TEAM_STUB_DRAFT_NEEDS_REVISION=1 bash "${DRAFT_CYCLE}" \
    --tag D0-r4 \
    --tex main.tex \
    --bib references.bib \
    --out-dir team \
    --member-a-system prompts/_system_draft_member_a.txt \
    --member-b-system prompts/_system_draft_member_b.txt \
    --member-c-system prompts/_system_draft_member_c_leader.txt \
    --member-a-runner "${tmp}/stub_claude_draft.sh" \
    --member-b-runner "${tmp}/stub_gemini_draft.sh" \
    --member-c-runner "${tmp}/stub_claude_draft.sh" \
    --require-convergence
) >"${log5}" 2>&1
code5=$?
set -e

if [[ "${code5}" -eq 0 ]]; then
  echo "[fail] expected non-zero exit for not_converged draft run" >&2
  sed -n '1,220p' "${log5}" >&2 || true
  exit 1
fi

run_dir_r4="team/runs/D0-r4"
if [[ ! -f "${run_dir_r4}/D0-r4_draft_convergence_log.md" ]]; then
  echo "[fail] expected convergence log for failed run missing" >&2
  exit 1
fi
if [[ ! -f "${run_dir_r4}/D0-r4_draft_converged_summary.md" ]]; then
  echo "[fail] expected converged summary (status not_converged) for failed run missing" >&2
  exit 1
fi

echo "[test6] contract violation should exit 2 and still write convergence artifacts"
log6="/tmp/smoke_tex_draft_cycle_out6.txt"
set +e
(
  RESEARCH_TEAM_STUB_DRAFT_CONTRACT_ERROR=1 bash "${DRAFT_CYCLE}" \
    --tag D0-r5 \
    --tex main.tex \
    --bib references.bib \
    --out-dir team \
    --member-a-system prompts/_system_draft_member_a.txt \
    --member-b-system prompts/_system_draft_member_b.txt \
    --member-c-system prompts/_system_draft_member_c_leader.txt \
    --member-a-runner "${tmp}/stub_claude_draft.sh" \
    --member-b-runner "${tmp}/stub_gemini_draft.sh" \
    --member-c-runner "${tmp}/stub_claude_draft.sh" \
    --require-convergence
) >"${log6}" 2>&1
code6=$?
set -e

if [[ "${code6}" -ne 2 ]]; then
  echo "[fail] expected exit 2 for contract violation; got ${code6}" >&2
  sed -n '1,240p' "${log6}" >&2 || true
  exit 1
fi

run_dir_r5="team/runs/D0-r5"
if [[ ! -f "${run_dir_r5}/D0-r5_draft_convergence_log.md" ]]; then
  echo "[fail] expected convergence log for contract error run missing" >&2
  exit 1
fi
if [[ ! -f "${run_dir_r5}/D0-r5_draft_converged_summary.md" ]]; then
  echo "[fail] expected converged summary (status parse_error) for contract error run missing" >&2
  exit 1
fi

echo "[ok] smoke TeX draft cycle passed"
