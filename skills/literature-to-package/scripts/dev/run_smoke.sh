#!/usr/bin/env bash
set -euo pipefail

# Offline smoke for the literature-to-package phase gates: the full behavior
# test suite plus a --help sanity call. No network, no CAS, no external CLIs.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
REPO_ROOT="$(cd "${SKILL_ROOT}/../.." && pwd)"

cd "${REPO_ROOT}"

python3 "${SKILL_ROOT}/scripts/gates/check_phase.py" --help > /dev/null

python3 -m pytest "${SKILL_ROOT}/tests/test_phase_gates.py" -q
