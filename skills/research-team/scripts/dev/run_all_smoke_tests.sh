#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
REPO_ROOT="$(cd "${SKILL_ROOT}/../.." && pwd)"

cd "${REPO_ROOT}"

python3 -m pytest \
  skills/research-team/tests/test_build_draft_packet_semantic_selection.py \
  skills/research-team/tests/test_convergence_gate.py \
  skills/research-team/tests/test_convergence_gate_json.py \
  skills/research-team/tests/test_notebook_integrity_gate.py \
  skills/research-team/tests/test_packet_redaction.py \
  skills/research-team/tests/test_run_artifact_identity.py \
  skills/research-team/tests/test_semantic_packet_curator.py
