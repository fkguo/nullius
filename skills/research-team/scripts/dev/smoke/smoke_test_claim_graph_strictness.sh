#!/usr/bin/env bash
set -euo pipefail

# Smoke test for claim-graph dependency/edge consistency strictness:
# - default profiles: mismatch is WARN-only (exit 0)
# - profile=toolkit_extraction: mismatch is ERROR (exit 1)

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_ROOT="$(cd "${SCRIPT_DIR}/../../.." && pwd)"
GATES_DIR="${SKILL_ROOT}/scripts/gates"

tmp_root="$(mktemp -d)"
cleanup() { rm -rf "${tmp_root}"; }
trap cleanup EXIT

echo "[smoke] tmp_root=${tmp_root}"
cd "${tmp_root}"

cat > research_contract.md <<'EOF'
<!-- REPRO_CAPSULE_START -->
- Milestone kind: computational
<!-- REPRO_CAPSULE_END -->
EOF

mkdir -p knowledge_graph
cat > knowledge_graph/claims.jsonl <<'JSONL'
{"id":"CLM-001","statement":"demo: CLM-001 depends on CLM-002","profile":"mixed","status":"draft","confidence":0.5,"dependencies":["CLM-002"],"supports_evidence":[],"contradicts_evidence":[],"kill_criteria":[],"linked_trajectories":[],"owner":"smoke","tags":["smoke"],"created_at":"2026-01-18T00:00:00Z","updated_at":"2026-01-18T00:00:00Z"}
{"id":"CLM-002","statement":"demo: dependency target exists","profile":"mixed","status":"draft","confidence":0.5,"dependencies":[],"supports_evidence":[],"contradicts_evidence":[],"kill_criteria":[],"linked_trajectories":[],"owner":"smoke","tags":["smoke"],"created_at":"2026-01-18T00:00:00Z","updated_at":"2026-01-18T00:00:00Z"}
JSONL

# Intentionally omit the corresponding requires edge.
printf '\n' > knowledge_graph/edges.jsonl

cat > research_team_config.json <<'EOF'
{
  "version": 1,
  "mode": "theory_numerics",
  "profile": "mixed",
  "features": {
    "claim_graph_gate": true
  },
  "claim_graph": { "base_dir": "knowledge_graph" }
}
EOF

echo "[test1] default profile (mixed): mismatch is WARN-only (PASS)"
set +e
python3 "${GATES_DIR}/check_claim_graph.py" --notes research_contract.md > smoke_claim_strict_out1.txt 2>&1
code=$?
set -e
if [[ $code -ne 0 ]]; then
  echo "[fail] expected exit 0 for warn-only mismatch; got:" >&2
  sed -n '1,220p' smoke_claim_strict_out1.txt >&2
  exit 1
fi
if ! grep -nF "missing requires edge" smoke_claim_strict_out1.txt >/dev/null 2>&1; then
  echo "[fail] expected warning about missing requires edge; got:" >&2
  sed -n '1,220p' smoke_claim_strict_out1.txt >&2
  exit 1
fi

cat > research_team_config.json <<'EOF'
{
  "version": 1,
  "mode": "theory_numerics",
  "profile": "toolkit_extraction",
  "features": {
    "claim_graph_gate": true
  },
  "claim_graph": { "base_dir": "knowledge_graph" }
}
EOF

echo "[test2] profile=toolkit_extraction: mismatch is ERROR (FAIL)"
set +e
python3 "${GATES_DIR}/check_claim_graph.py" --notes research_contract.md > smoke_claim_strict_out2.txt 2>&1
code=$?
set -e
if [[ $code -eq 0 ]]; then
  echo "[fail] expected non-zero exit for strict mismatch; got:" >&2
  sed -n '1,220p' smoke_claim_strict_out2.txt >&2
  exit 1
fi
if ! grep -nF "ERROR:" smoke_claim_strict_out2.txt >/dev/null 2>&1; then
  echo "[fail] expected ERROR-level issue; got:" >&2
  sed -n '1,220p' smoke_claim_strict_out2.txt >&2
  exit 1
fi
if ! grep -nF "missing requires edge" smoke_claim_strict_out2.txt >/dev/null 2>&1; then
  echo "[fail] expected error about missing requires edge; got:" >&2
  sed -n '1,220p' smoke_claim_strict_out2.txt >&2
  exit 1
fi

echo "[test3] profile=toolkit_extraction + consistent requires edge (PASS)"
cat > knowledge_graph/edges.jsonl <<'JSONL'
{"id":"EDG-001","type":"requires","source":"CLM-001","target":"CLM-002"}
JSONL

set +e
python3 "${GATES_DIR}/check_claim_graph.py" --notes research_contract.md > smoke_claim_strict_out3.txt 2>&1
code=$?
set -e
if [[ $code -ne 0 ]]; then
  echo "[fail] expected exit 0 for consistent graph in strict mode; got:" >&2
  sed -n '1,220p' smoke_claim_strict_out3.txt >&2
  exit 1
fi

echo "[ok] claim graph strictness smoke tests passed"
