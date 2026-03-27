# KB Index JSON (Deterministic / L1 Export)

This repository includes a deterministic (L1) exporter that builds a stable JSON index over the project's `knowledge_base/` layers:

- `knowledge_base/literature/` → `layer="Library"`
- `knowledge_base/methodology_traces/` → `layer="Methodology"`
- `knowledge_base/priors/` → `layer="Priors"`

The exporter is **local-only** (filesystem + hashing): it does not call LLMs and does not do network fetch/search. This keeps the index stable, auditable, and cheap to run in CI.

Important scope note: networked research (literature discovery, metadata lookup, open-source code search) remains a normal part of the overall workflow, but it should write its outcomes into `knowledge_base/` (and optionally `references/`) so this exporter can index them deterministically.

Non-goals:
- No LLM calls (ever).
- Not a literature crawler/downloader (belongs in project-leader tooling or the orchestrator).
- No orchestration/state machines/approvals/evaluation logic (belongs in `hep-autoresearch`).

## CLI

Commands below use `SKILL_DIR` so they stay portable across install locations.

```bash
SKILL_DIR="${SKILL_DIR:-${CODEX_HOME:-$HOME/.codex}/skills/research-team}"
python3 "${SKILL_DIR}/scripts/bin/kb_export.py" kb-index \
  --project-root /path/to/project
```

Default output path:
- `/path/to/project/knowledge_base/kb_index.json`

Override output path:

```bash
SKILL_DIR="${SKILL_DIR:-${CODEX_HOME:-$HOME/.codex}/skills/research-team}"
python3 "${SKILL_DIR}/scripts/bin/kb_export.py" kb-index \
  --project-root /path/to/project \
  --out /tmp/kb_index.json
```

## Output fields (v1, minimal contract)

Top-level:
- `version` (integer): `1`
- `kb_root` (string): `"knowledge_base"`
- `entries` (array): per-file records

Per entry (minimum):
- `layer` (string): `Library | Methodology | Priors`
- `refkey` (string): from `RefKey: ...` if present; fallback to filename stem
- `title` (string): first Markdown `# ...` title if present (prefixes like `KB note:` are stripped); fallback to filename stem
- `path` (string): project-relative path to the KB file (e.g. `knowledge_base/literature/demo.md`)
- `links` (object): URL lists grouped as `inspire`, `arxiv`, `doi`, `other`
- `evidence_paths` (array): project-relative evidence pointers (always includes `path`; additionally includes detected `references/...` / `refs/...` paths; also adds `references/arxiv_src/<arxiv_id>/` when present)
- `mtime_ns` (int): file mtime (nanoseconds)
- `sha256` (string): SHA-256 hash of the file

## JSON Schema

The schema is shipped with the skill:
- `scripts/schemas/kb_index.schema.json`

## Validation (local)

```bash
SKILL_DIR="${SKILL_DIR:-${CODEX_HOME:-$HOME/.codex}/skills/research-team}"
python3 "${SKILL_DIR}/scripts/bin/validate_kb_index.py" \
  /path/to/project/knowledge_base/kb_index.json
```

Notes:
- If `jsonschema` is installed, the validator will use it to validate against the shipped JSON Schema.
- If `jsonschema` is not installed, it falls back to a built-in minimal validator that checks required fields and types.

## Acceptance test (fixture)

```bash
mkdir -p /tmp/rt_proj/knowledge_base/literature

cat > /tmp/rt_proj/knowledge_base/literature/demo.md <<'MD'

# Demo

RefKey: demo-1
Links:

- arXiv: https://arxiv.org/abs/1234.5678
MD

SKILL_DIR="${SKILL_DIR:-${CODEX_HOME:-$HOME/.codex}/skills/research-team}"
python3 "${SKILL_DIR}/scripts/bin/kb_export.py" kb-index \
  --project-root /tmp/rt_proj \
  --out /tmp/kb_index.json

python3 -c 'import json; print(sorted(json.load(open("/tmp/kb_index.json")).keys()))'
python3 "${SKILL_DIR}/scripts/bin/validate_kb_index.py" /tmp/kb_index.json

# Determinism check (byte-identical output)
python3 "${SKILL_DIR}/scripts/bin/kb_export.py" kb-index \
  --project-root /tmp/rt_proj \
  --out /tmp/kb_index_2.json
cmp -s /tmp/kb_index.json /tmp/kb_index_2.json && echo "byte-identical: yes"
```

## Suggested `hep-autoresearch` integration

Treat `knowledge_base/kb_index.json` as an **evidence bundle index** input (alongside team packets and artifact manifests). The orchestrator should:

- validate the JSON against `scripts/schemas/kb_index.schema.json`
- use `entries[].evidence_paths` (and/or `entries[].path`) to locate local evidence files (Markdown/TeX snapshots, etc.)
- ingest selected evidence content into its retrieval/ranking/audit pipeline

This exporter only builds a deterministic index; it deliberately avoids duplicating orchestrator responsibilities.

## Determinism & change detection

- Same on-disk inputs ⇒ byte-identical JSON output (stable ordering + stable hashing).
- Changes in source files are reflected via `mtime_ns` and `sha256`.
