#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_ROOT="$(cd "${SCRIPT_DIR}/../../.." && pwd)"

SCAFFOLD="${SKILL_ROOT}/scripts/bin/scaffold_research_workflow.sh"
CHECK="${SKILL_ROOT}/scripts/bin/check_md_double_backslash.sh"
FIX="${SKILL_ROOT}/scripts/bin/fix_markdown_double_backslash_math.py"

if [[ ! -f "${SCAFFOLD}" || ! -f "${CHECK}" || ! -f "${FIX}" ]]; then
  echo "ERROR: missing required scripts under: ${SKILL_ROOT}" >&2
  exit 2
fi

tmp_root="$(mktemp -d)"
trap 'rm -rf "${tmp_root}"' EXIT

echo "[smoke] tmp_root=${tmp_root}"

bash "${SCAFFOLD}" --root "${tmp_root}/proj" --project "SmokeDoubleBackslash" --profile "mixed" >/dev/null 2>&1

# Introduce the common bug inside math regions.
cat >>"${tmp_root}/proj/research_contract.md" <<'EOF'

<!-- SMOKE_DOUBLE_BACKSLASH_START -->
Inline math: $\\Delta = 1$, $k^\\* = 0$.
$$
\\gamma_{\\rm lin} = 2
$$
<!-- SMOKE_DOUBLE_BACKSLASH_END -->
EOF

set +e
bash "${CHECK}" --root "${tmp_root}/proj" --fail >/dev/null 2>&1
code=$?
set -e
if [[ $code -eq 0 ]]; then
  echo "ERROR: expected double-backslash check to fail before fix" >&2
  exit 1
fi

python3 "${FIX}" --root "${tmp_root}/proj" --in-place >/dev/null

bash "${CHECK}" --root "${tmp_root}/proj" --fail >/dev/null 2>&1

echo "[ok] double-backslash fix smoke test passed"

