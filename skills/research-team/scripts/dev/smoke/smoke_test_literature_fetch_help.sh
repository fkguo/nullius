#!/usr/bin/env bash
set -euo pipefail

# Smoke test: literature_fetch.py CLI exposes Crossref/DOI subcommands.
# (Deterministic: does not hit network.)

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_ROOT="$(cd "${SCRIPT_DIR}/../../.." && pwd)"

out="$(python3 "${SKILL_ROOT}/scripts/bin/literature_fetch.py" -h 2>&1 || true)"

for needle in "inspire-bibtex" "crossref-search" "crossref-get" "datacite-search" "datacite-get" "doi-bibtex"; do
  if ! printf '%s\n' "${out}" | grep -F "${needle}" >/dev/null 2>&1; then
    echo "[smoke][fail] expected '${needle}' in literature_fetch.py -h output" >&2
    printf '%s\n' "${out}" | sed -n '1,120p' >&2
    exit 1
  fi
done

echo "[smoke][ok] literature_fetch.py exposes crossref/datacite/doi commands"

exit 0
