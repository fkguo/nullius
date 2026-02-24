#!/usr/bin/env bash
set -euo pipefail

# Smoke test: literature_fetch.py supports --allow-stub to proceed when network fetch fails.
# Deterministic: does not hit network (uses missing fixtures to force failure).

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_ROOT="$(cd "${SCRIPT_DIR}/../../.." && pwd)"
BIN_DIR="${SKILL_ROOT}/scripts/bin"
FETCH="${BIN_DIR}/literature_fetch.py"

tmp_root="$(mktemp -d)"
cleanup() { rm -rf "${tmp_root}"; }
trap cleanup EXIT

echo "[smoke] tmp_root=${tmp_root}"

mkdir -p "${tmp_root}/proj"
bash "${BIN_DIR}/scaffold_research_workflow.sh" --root "${tmp_root}/proj" --project "SmokeAllowStub" --profile "mixed" >/dev/null 2>&1

mkdir -p "${tmp_root}/fixtures_empty"

set +e
RESEARCH_TEAM_HTTP_FIXTURES="${tmp_root}/fixtures_empty" \
python3 "${FETCH}" inspire-get --recid 9999999 --write-note --allow-stub --kb-dir "${tmp_root}/proj/knowledge_base/literature" >"${tmp_root}/out.txt" 2>&1
code=$?
set -e

if [[ ${code} -ne 0 ]]; then
  echo "[fail] expected allow-stub run to exit 0; got code=${code} output:" >&2
  sed -n '1,200p' "${tmp_root}/out.txt" >&2 || true
  exit 1
fi

note="${tmp_root}/proj/knowledge_base/literature/recid-9999999.md"
if [[ ! -f "${note}" ]]; then
  echo "[fail] expected stub KB note to be written: ${note}" >&2
  ls -la "${tmp_root}/proj/knowledge_base/literature" >&2 || true
  exit 1
fi

if ! grep -nF "Fetch error:" "${note}" >/dev/null 2>&1; then
  echo "[fail] expected stub note to include Fetch error; got:" >&2
  sed -n '1,80p' "${note}" >&2 || true
  exit 1
fi

if ! grep -nF "Authors: UNKNOWN" "${note}" >/dev/null 2>&1; then
  echo "[fail] expected stub note to contain Authors: UNKNOWN; got:" >&2
  sed -n '1,80p' "${note}" >&2 || true
  exit 1
fi

if ! grep -nF "Reference entry (paste into Draft_Derivation.md" "${tmp_root}/out.txt" >/dev/null 2>&1; then
  echo "[fail] expected reference entry hint in output; got:" >&2
  sed -n '1,120p' "${tmp_root}/out.txt" >&2 || true
  exit 1
fi

echo "[ok] literature_fetch.py --allow-stub smoke test passed"

