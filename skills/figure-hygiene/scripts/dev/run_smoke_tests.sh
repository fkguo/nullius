#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_DIR="$(cd "${SCRIPT_DIR}/../.." && pwd)"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "${TMP_DIR}"' EXIT

QA="${SKILL_DIR}/scripts/bin/figure_qa.py"

if ! python3 -c "import matplotlib" >/dev/null 2>&1; then
  echo "figure-hygiene smoke tests skipped: matplotlib not installed" >&2
  exit 0
fi

expect_exit() {
  local expected="$1"
  shift
  local out_file="${TMP_DIR}/last.out"
  local code=0
  python3 "${QA}" "$@" >"${out_file}" 2>&1 || code=$?
  if [ "${code}" -ne "${expected}" ]; then
    echo "expected exit ${expected}, got ${code} for: figure_qa $*" >&2
    cat "${out_file}" >&2
    exit 1
  fi
}

expect_output_matching() {
  local expected="$1"
  if ! grep -F "${expected}" "${TMP_DIR}/last.out" >/dev/null; then
    echo "expected output to contain: ${expected}" >&2
    cat "${TMP_DIR}/last.out" >&2
    exit 1
  fi
}

cat >"${TMP_DIR}/clean_figure.py" <<'PY'
import matplotlib.pyplot as plt

fig, ax = plt.subplots(figsize=(4.5, 3.2))
ax.plot([0, 1, 2, 3], [0.1, 0.9, 2.1, 4.2], marker="o", label="series one")
ax.plot([0, 1, 2, 3], [0.0, 0.5, 1.1, 1.9], marker="s", label="series two")
ax.set_xlabel("input value")
ax.set_ylabel("measured quantity")
ax.set_title("Output grows with input")
ax.margins(0.08)
ax.legend(loc="upper left", frameon=False)
fig.tight_layout()
PY

cat >"${TMP_DIR}/overlap_figure.py" <<'PY'
import matplotlib.pyplot as plt

fig, ax = plt.subplots(figsize=(4, 3))
ax.plot([0, 1], [0, 1])
ax.text(0.5, 0.5, "first annotation", transform=ax.transAxes)
ax.text(0.5, 0.5, "second annotation", transform=ax.transAxes)
fig.tight_layout()
PY

cat >"${TMP_DIR}/out_of_bounds_figure.py" <<'PY'
import matplotlib.pyplot as plt

fig, ax = plt.subplots(figsize=(4, 3))
ax.plot([0, 1], [0, 1])
fig.text(0.98, 0.5, "label pushed outside the canvas edge")
fig.tight_layout()
PY

cat >"${TMP_DIR}/no_figure.py" <<'PY'
import matplotlib.pyplot as plt

fig, ax = plt.subplots()
ax.plot([0, 1], [0, 1])
plt.close("all")
PY

# Clean figure passes and emits per-panel crops.
expect_exit 0 --script "${TMP_DIR}/clean_figure.py" --crops-dir "${TMP_DIR}/crops"
expect_output_matching "geometric check clean"
if ! ls "${TMP_DIR}/crops/"*panel*.png >/dev/null 2>&1; then
  echo "expected at least one panel crop PNG in ${TMP_DIR}/crops" >&2
  exit 1
fi

# Coincident annotations are a text-overlap finding.
expect_exit 1 --script "${TMP_DIR}/overlap_figure.py"
expect_output_matching "text-overlaps-text"

# Text extending past the canvas is an out-of-bounds finding.
expect_exit 1 --script "${TMP_DIR}/out_of_bounds_figure.py"
expect_output_matching "text-out-of-bounds"

# A script that closes its figures cannot be checked.
expect_exit 2 --script "${TMP_DIR}/no_figure.py"
expect_output_matching "left no open figures"

# JSON mode reports the same findings machine-readably.
expect_exit 1 --script "${TMP_DIR}/overlap_figure.py" --json
expect_output_matching '"kind": "text-overlaps-text"'

echo "figure-hygiene smoke tests passed"
