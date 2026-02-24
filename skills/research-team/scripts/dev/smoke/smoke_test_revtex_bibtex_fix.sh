#!/usr/bin/env bash
set -euo pipefail

# Smoke test for revtex4-2 BibTeX hygiene fixer (journal="" for @article without journal).

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_ROOT="$(cd "${SCRIPT_DIR}/../../.." && pwd)"
FIX="${SKILL_ROOT}/scripts/bin/fix_bibtex_revtex4_2.py"

tmp_root="$(mktemp -d)"
cleanup() { rm -rf "${tmp_root}"; }
trap cleanup EXIT

echo "[smoke] tmp_root=${tmp_root}"

cat > "${tmp_root}/refs.bib" <<'BIB'
@article{NoJournalKey,
  author = {A. Author},
  title = {No journal field},
  year = {2026}
}

@article{HasJournalKey,
  author = {B. Author},
  title = {Has journal field},
  journal = {Phys. Rev. C},
  year = {2026}
}

@misc{MiscKey,
  title = {Misc entry},
  year = {2026}
}
BIB

set +e
python3 "${FIX}" --bib "${tmp_root}/refs.bib" >/dev/null 2>&1
code=$?
set -e
if [[ ${code} -eq 0 ]]; then
  echo "[fail] expected check-mode to report missing journal (exit 1)" >&2
  exit 1
fi

python3 "${FIX}" --bib "${tmp_root}/refs.bib" --in-place >/dev/null 2>&1

if ! grep -nF 'journal = ""' "${tmp_root}/refs.bib" >/dev/null 2>&1; then
  echo "[fail] expected inserted journal=\"\" in refs.bib" >&2
  sed -n '1,120p' "${tmp_root}/refs.bib" >&2 || true
  exit 1
fi
if ! grep -nF 'journal = {Phys. Rev. C}' "${tmp_root}/refs.bib" >/dev/null 2>&1; then
  echo "[fail] expected existing journal field to remain intact" >&2
  sed -n '1,160p' "${tmp_root}/refs.bib" >&2 || true
  exit 1
fi

python3 "${FIX}" --bib "${tmp_root}/refs.bib" >/dev/null 2>&1

echo "[ok] revtex4-2 bibtex fix smoke test passed"

