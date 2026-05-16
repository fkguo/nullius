# Skill↔MCP Bridge Contract

This document defines the bridge contract between skill orchestrators and MCP tool calls.

## Scope

- Applies to run-scoped `hep_*` responses that include `run_id`.
- Goal: unify long-task orchestration semantics across direct MCP clients and skill wrappers.

## Job Envelope (Phase 4.10)

For successful run-scoped responses, dispatcher attaches:

```json
{
  "job": {
    "version": 1,
    "job_id": "<run_id>",
    "status": "created|running|done|failed|unknown",
    "manifest_path": "<HEP_DATA_DIR>/runs/<run_id>/manifest.json",
    "polling": {
      "strategy": "manifest_file",
      "manifest_path": "<HEP_DATA_DIR>/runs/<run_id>/manifest.json",
      "terminal_statuses": ["done", "failed"]
    }
  }
}
```

## Semantics

- `job` is a bridge-level orchestration hint, not the canonical evidence payload.
- Canonical outputs remain run artifacts on disk under the configured data root.
- The bridge contract uses local manifest file paths, not MCP resource pointers.
- Error semantics remain fail-fast (`INVALID_PARAMS` + actionable `next_actions`).

## Client Guidance

1. Prefer the manifest file under the configured data root (`runs/<run_id>/manifest.json`) for authoritative step/artifact progress when filesystem access is available.
2. Stop polling only when status reaches `done` or `failed`.
3. Never infer scientific quality from polling status; quality gates are verifier/coverage/grounding checks.
