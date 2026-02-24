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
    "status_uri": "hep://runs/<run_id>/manifest",
    "polling": {
      "strategy": "manifest_resource",
      "resource_uri": "hep://runs/<run_id>/manifest",
      "terminal_statuses": ["done", "failed"]
    }
  }
}
```

## Semantics

- `job` is a bridge-level orchestration hint, not the canonical evidence payload.
- Canonical outputs remain run artifacts + `hep://...` resources.
- Error semantics remain fail-fast (`INVALID_PARAMS` + actionable `next_actions`).

## Client Guidance

1. Read `job.status_uri` (`hep://runs/<run_id>/manifest`) for authoritative step/artifact progress.
2. Stop polling only when status reaches `done` or `failed`.
3. Never infer scientific quality from polling status; quality gates are verifier/coverage/grounding checks.
