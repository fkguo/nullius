#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_DIR="$(cd "${SCRIPT_DIR}/../.." && pwd)"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "${TMP_DIR}"' EXIT

QA="${SKILL_DIR}/scripts/bin/figure_qa.py"
PROVENANCE_QA="${SKILL_DIR}/scripts/bin/check_series_provenance.py"

# --- series-provenance gate (no matplotlib dependency: runs on every machine) ---
expect_prov_exit() {
  local expected="$1"
  shift
  local out_file="${TMP_DIR}/prov_last.out"
  local code=0
  python3 "${PROVENANCE_QA}" "$@" >"${out_file}" 2>&1 || code=$?
  if [ "${code}" -ne "${expected}" ]; then
    echo "expected exit ${expected}, got ${code} for: check_series_provenance $*" >&2
    cat "${out_file}" >&2
    exit 1
  fi
}

HASH_A="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
HASH_B="bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"

cat >"${TMP_DIR}/series_clean.csv" <<CSV
series_id,evaluator_fingerprint,connected,x,y
one,${HASH_A},true,0,1
one,${HASH_A},true,1,2
two,sha256:${HASH_B},true,0,3
two,${HASH_A},false,1,4
CSV

cat >"${TMP_DIR}/series_mixed.csv" <<CSV
series_id,evaluator_fingerprint,x,y
one,${HASH_A},0,1
one,${HASH_B},1,2
CSV

cat >"${TMP_DIR}/series_missing.csv" <<CSV
series_id,evaluator_fingerprint,x,y
one,${HASH_A},0,1
one,,1,2
CSV

# Duplicate headers must be a usage error, not a silent pass: DictReader keeps
# the LAST duplicate column, so a mixed first column could otherwise hide.
cat >"${TMP_DIR}/series_dup_header.csv" <<CSV
series_id,evaluator_fingerprint,evaluator_fingerprint
one,${HASH_A},${HASH_B}
one,${HASH_B},${HASH_B}
CSV

# An unrecognized connected-column value must not silently exempt the row.
cat >"${TMP_DIR}/series_bad_connected.csv" <<CSV
series_id,evaluator_fingerprint,connected
one,${HASH_A},ture
CSV

cat >"${TMP_DIR}/series_no_fp_col.csv" <<CSV
series_id,x,y
one,0,1
CSV

expect_prov_exit 0 --data "${TMP_DIR}/series_clean.csv" --connected-column connected
grep -F "series provenance clean" "${TMP_DIR}/prov_last.out" >/dev/null

expect_prov_exit 1 --data "${TMP_DIR}/series_mixed.csv"
grep -F "mixed-fingerprints" "${TMP_DIR}/prov_last.out" >/dev/null

expect_prov_exit 1 --data "${TMP_DIR}/series_missing.csv"
grep -F "missing-fingerprint" "${TMP_DIR}/prov_last.out" >/dev/null

expect_prov_exit 2 --data "${TMP_DIR}/series_dup_header.csv"
grep -F "duplicate column header" "${TMP_DIR}/prov_last.out" >/dev/null

expect_prov_exit 2 --data "${TMP_DIR}/series_bad_connected.csv" --connected-column connected
grep -F "unrecognized" "${TMP_DIR}/prov_last.out" >/dev/null

expect_prov_exit 2 --data "${TMP_DIR}/series_no_fp_col.csv"
grep -F "missing required column" "${TMP_DIR}/prov_last.out" >/dev/null

expect_prov_exit 2 --data "${TMP_DIR}/does_not_exist.csv"

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
