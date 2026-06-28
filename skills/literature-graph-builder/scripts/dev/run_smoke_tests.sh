#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_DIR="$(cd "${SCRIPT_DIR}/../.." && pwd)"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "${TMP_DIR}"' EXIT

mkdir -p "${TMP_DIR}/notes/papers" "${TMP_DIR}/figures/paper-a" "${TMP_DIR}/sources/paper-a"
printf '# Paper A\n\nSubstantive note.\n' >"${TMP_DIR}/notes/papers/paper-a.md"
printf 'fake image bytes\n' >"${TMP_DIR}/figures/paper-a/result.png"
printf '%s\n' '%PDF-1.4' >"${TMP_DIR}/sources/paper-a/result.pdf"

cat >"${TMP_DIR}/graph.json" <<'JSON'
{
  "version": "literature_graph_v1",
  "nodes": [
    {
      "id": "paper-a",
      "label": "Paper A",
      "kind": "paper",
      "note_path": "notes/papers/paper-a.md",
      "source_uris": ["https://example.org/paper-a"]
    },
    {
      "id": "method-a",
      "label": "Method A",
      "kind": "method",
      "note_path": "notes/papers/paper-a.md"
    }
  ],
  "edges": [
    {
      "source": "paper-a",
      "target": "method-a",
      "relation": "uses-method",
      "evidence": "Paper A applies Method A.",
      "note_path": "notes/papers/paper-a.md",
      "locator": "Section 2"
    }
  ],
  "figures": [
    {
      "node_id": "paper-a",
      "path": "figures/paper-a/result.png",
      "caption": "Representative result.",
      "source_path": "sources/paper-a/result.pdf",
      "locator": "Figure 1",
      "note_path": "notes/papers/paper-a.md"
    }
  ]
}
JSON

python3 "${SKILL_DIR}/scripts/bin/validate_literature_graph.py" --graph "${TMP_DIR}/graph.json" --project-root "${TMP_DIR}"

cat >"${TMP_DIR}/bad.json" <<'JSON'
{
  "version": "literature_graph_v1",
  "nodes": [
    {
      "id": "paper-a",
      "label": "Paper A",
      "kind": "paper",
      "note_path": "/tmp/not-portable.md"
    }
  ],
  "edges": [
    {
      "source": "paper-a",
      "target": "missing-node",
      "relation": "decorative"
    }
  ],
  "figures": [
    {
      "node_id": "paper-a",
      "path": "figures/paper-a/source.eps",
      "caption": "Bad source figure."
    }
  ]
}
JSON

if python3 "${SKILL_DIR}/scripts/bin/validate_literature_graph.py" --graph "${TMP_DIR}/bad.json" --project-root "${TMP_DIR}"; then
  echo "expected bad graph validation to fail" >&2
  exit 1
fi

echo "[ok] literature-graph-builder smoke tests passed"
