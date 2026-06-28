#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_DIR="$(cd "${SCRIPT_DIR}/../.." && pwd)"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "${TMP_DIR}"' EXIT

expect_fail_matching() {
  local graph_file="$1"
  local expected="$2"
  local out_file="${TMP_DIR}/$(basename "${graph_file}").err"
  if python3 "${SKILL_DIR}/scripts/bin/validate_literature_graph.py" --graph "${graph_file}" --project-root "${TMP_DIR}" 2>"${out_file}"; then
    echo "expected ${graph_file} validation to fail" >&2
    exit 1
  fi
  if ! grep -F "${expected}" "${out_file}" >/dev/null; then
    echo "expected ${graph_file} error output to contain: ${expected}" >&2
    cat "${out_file}" >&2
    exit 1
  fi
}

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

expect_fail_matching "${TMP_DIR}/bad.json" "target references missing node id"
expect_fail_matching "${TMP_DIR}/bad.json" "note_path must not be an absolute path"
expect_fail_matching "${TMP_DIR}/bad.json" "non-renderable EPS/PS source"

cat >"${TMP_DIR}/bad-file-url.json" <<'JSON'
{
  "version": "literature_graph_v1",
  "nodes": [
    {
      "id": "paper-a",
      "label": "Paper A",
      "kind": "paper",
      "note_path": "file:///tmp/not-portable.md"
    }
  ],
  "edges": []
}
JSON
expect_fail_matching "${TMP_DIR}/bad-file-url.json" "must not use a file:// URL"

cat >"${TMP_DIR}/bad-source-uri.json" <<'JSON'
{
  "version": "literature_graph_v1",
  "nodes": [
    {
      "id": "paper-a",
      "label": "Paper A",
      "kind": "paper",
      "note_path": "notes/papers/paper-a.md"
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
      "source_uri": 42
    }
  ]
}
JSON
expect_fail_matching "${TMP_DIR}/bad-source-uri.json" "source_uri must be a non-empty string"

cat >"${TMP_DIR}/bad-source-uri-file.json" <<'JSON'
{
  "version": "literature_graph_v1",
  "nodes": [
    {
      "id": "paper-a",
      "label": "Paper A",
      "kind": "paper",
      "note_path": "notes/papers/paper-a.md",
      "source_uris": ["file:///tmp/not-portable.pdf"]
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
      "source_uri": "file:///tmp/not-portable.pdf"
    }
  ]
}
JSON
expect_fail_matching "${TMP_DIR}/bad-source-uri-file.json" "source_uri must not use a file:// URL"

cat >"${TMP_DIR}/bad-source-uri-local-paths.json" <<'JSON'
{
  "version": "literature_graph_v1",
  "nodes": [
    {
      "id": "paper-a",
      "label": "Paper A",
      "kind": "paper",
      "note_path": "notes/papers/paper-a.md"
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
      "source_uri": "/Users/example/private/source.pdf"
    },
    {
      "source": "method-a",
      "target": "paper-a",
      "relation": "source-support",
      "source_uris": ["../outside/source.pdf"]
    }
  ]
}
JSON
expect_fail_matching "${TMP_DIR}/bad-source-uri-local-paths.json" "source_uri must not be an absolute path"
expect_fail_matching "${TMP_DIR}/bad-source-uri-local-paths.json" "source_uri must not escape the project root"

cat >"${TMP_DIR}/bad-version.json" <<'JSON'
{
  "version": 1,
  "nodes": [
    {
      "id": "paper-a",
      "label": "Paper A",
      "kind": "paper",
      "note_path": "notes/papers/paper-a.md"
    }
  ],
  "edges": []
}
JSON
expect_fail_matching "${TMP_DIR}/bad-version.json" "version must be 'literature_graph_v1'"

echo "[ok] literature-graph-builder smoke tests passed"
