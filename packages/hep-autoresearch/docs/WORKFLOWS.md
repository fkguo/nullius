# Workflows

Chinese version: `docs/WORKFLOWS.zh.md`.

English workflow specs live under `workflows/`:

## Naming boundary

- Current user-facing workflow names are semantic: `ingest`, `reproduce`, `computation`, `draft`, `paper_reviser`, `revision`, `derivation_check`.
- Do not introduce new `W1`/`W2`/`W3`/`W4` labels in active docs, scripts, tests, eval suffixes, or runtime payloads.
- Historical compatibility surfaces may still retain legacy `W*` labels where they identify archived schema enums or old compatibility fixtures; treat those as historical records, not naming guidance.
- Eval case numeric prefixes such as `E4`, `E6`, `E14` remain stable IDs; only the semantic suffixes should be normalized.

- `workflows/README.md`
- `workflows/C1_literature_gap.md`
- `workflows/C2_method_design.md`
- `workflows/ingest.md`
- `workflows/reproduce.md`
- `workflows/computation.md`
- `workflows/draft.md`
- `workflows/paper_reviser.md`
- `workflows/revision.md`
- `workflows/derivation_check.md`

## Orchestrator operations (CLI)

### `hepar doctor` (entrypoints + MCP)

- Default behavior:
  - runs `entrypoint_discovery` first (checks `hepar` + `hep-autoresearch` on `PATH`)
  - then runs MCP connectivity/tool checks (`.mcp.json` + `hep_health`)
- Entrypoint check is shell-aware (`zsh` / `bash` / `fish` / `unknown`) and reports whether the current session appears to be in a virtual environment.
- Entrypoint failures are warnings by default.

Flags:

- `--strict-entrypoints`: treat missing `hepar` / `hep-autoresearch` entrypoints as error (non-zero exit).
- `--json`: output JSON for `entrypoint_discovery` only (offline PATH diagnostics; skips MCP checks).
- `--entrypoints-only`: text-mode entrypoint diagnostics only (skip MCP checks).
- `--allow-missing-mcp-config`: if `.mcp.json` is missing, print warning + hints and return success.
  - Useful for first-time local/offline setup.
  - Redundant when `--entrypoints-only` is already set.

Init scaffolds a starter template:
- `.mcp.json.example` (valid JSON, tracked)
- `.mcp.json` remains local/ignored by git.

### `hepar status` (revision display-layer reconcile)

- For `paper_reviser`, status reads `artifacts/runs/<RUN_ID>/paper_reviser/manifest.json#steps` to show substeps:
  - `A/B/C/D/E/APPLY`
- If manifest indicates completion but `.autoresearch/state.json` is stale, status shows reconciled view:
  - text mode: `run_status: completed [reconciled]`
  - json mode (`hepar status --json`): includes `"reconciled": true`
- `status` reconcile is display-layer only; it does not write back to `.autoresearch/state.json`.
- If manifest is missing/corrupt or `steps` schema is malformed, status falls back to state and emits structured warnings.

### Adapter gate resolution mode

- Adapter run-card supports optional `gate_resolution_mode`:
  - `union` (default), `policy_only`, `run_card_only`
- Resolution details are persisted to adapter `manifest.json` as:
  - `gate_resolution_mode`
  - `gate_resolution_trace`
- For `run_card_only + required_gates=[]`, CLI warns loudly (stderr + trace). Use `--strict-gate-resolution` to upgrade this to a hard error.

## Safe cleanup (two-phase)

Use `scripts/safe_cleanup.py` for any scaffold/runtime cleanup. Do not run broad `rm -rf` directly.

1) Dry run + manifest:

```bash
python3 scripts/safe_cleanup.py --mode scaffold --out-manifest artifacts/safe_cleanup/manifest.json
```

2) Apply from reviewed manifest:

```bash
python3 scripts/safe_cleanup.py --apply --manifest artifacts/safe_cleanup/manifest.json --yes
```

Protected-by-default top-level paths include:
- `knowledge_base/`
- `references/`
- `src/`, `scripts/`, `tests/`, `docs/`, `.git/`

To intentionally delete a protected target, you must explicitly allow it (and document rationale):

```bash
python3 scripts/safe_cleanup.py --path references --allow-protected references --out-manifest artifacts/safe_cleanup/protected.json
python3 scripts/safe_cleanup.py --apply --manifest artifacts/safe_cleanup/protected.json --allow-protected references --yes
```

## Update local `hepar` CLI

Use the one-liner updater from repo root:

```bash
bash scripts/update_hepar.sh
```

Notes:
- Uses editable install: `python3 -m pip install --user -e .`
- Forwards any extra pip flags, e.g.:

```bash
bash scripts/update_hepar.sh --upgrade
```
