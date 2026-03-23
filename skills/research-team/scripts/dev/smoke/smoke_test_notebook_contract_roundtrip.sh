#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_ROOT="$(cd "${SCRIPT_DIR}/../../.." && pwd)"
BIN_DIR="${SKILL_ROOT}/scripts/bin"

tmp_root="$(mktemp -d)"
trap 'rm -rf "${tmp_root}"' EXIT

proj="${tmp_root}/proj"
bash "${BIN_DIR}/scaffold_research_workflow.sh" --root "${proj}" --project "Roundtrip" --profile "mixed" >/dev/null

cat >>"${proj}/research_notebook.md" <<'EOF'

## Results

- Roundtrip result is visible here.

## References

- [DemoRef](knowledge_base/literature/demo.md)
EOF

python3 "${BIN_DIR}/refresh_research_contract.py" --root "${proj}" >/dev/null

if ! rg -nF -- "Source notebook: [research_notebook.md](research_notebook.md)" "${proj}/research_contract.md" >/dev/null; then
  echo "ERROR: contract sync block missing source notebook marker" >&2
  exit 1
fi
if ! rg -nF -- "- Results" "${proj}/research_contract.md" >/dev/null; then
  echo "ERROR: contract sync block missing notebook section summary" >&2
  exit 1
fi
if ! rg -nF -- "- [DemoRef](knowledge_base/literature/demo.md)" "${proj}/research_contract.md" >/dev/null; then
  echo "ERROR: contract sync block missing notebook references" >&2
  exit 1
fi

echo "[ok] notebook contract roundtrip smoke test passed"
