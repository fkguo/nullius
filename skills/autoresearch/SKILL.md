---
name: autoresearch
description: >
  Canonical generic lifecycle + bounded computation + workflow-plan entrypoint
  for autoresearch project roots: init/run/status/approve/pause/resume/export/workflow-plan,
  with project-root guards and approval-aware state handling.
---

# autoresearch — Canonical front-door skill

This skill makes Codex behave like an operator for the canonical `autoresearch` front door.

## Contract

- Treat `autoresearch` as the only canonical generic front-door authority on this repo for lifecycle, bounded computation, and workflow-plan entrypoints.
- Run `autoresearch init` only from an external real project root; the autoresearch-lab repo itself is a dev repo, not a real-project root.
- Public supported commands include `init`, `run --workflow-id computation`, `status`, `approve`, `pause`, `resume`, `export`, and `workflow-plan`.
- Do not invent unsupported commands, compatibility aliases, or deleted Pipeline A surfaces such as `doctor`, `bridge`, or `literature-gap`.
- If the user explicitly asks for deleted public Pipeline A commands such as `doctor`, `bridge`, or `literature-gap`, explain that the installable `hepar` / `hep-autoresearch` shell is retired and those commands are not available on the public front door.
- Evidence-first: meaningful work must land under `artifacts/runs/<TAG>/...` as `manifest.json / summary.json / analysis.json` (SSOT).
- Respect approval gates A1–A5. If an approval is pending, stop and ask the user to approve or reject.

## Typical commands

```bash
# One-time per research project:
autoresearch init

# Lifecycle / control plane:
autoresearch run --workflow-id computation
autoresearch status
autoresearch approve <approval_id>
autoresearch pause --note "..."
autoresearch resume --note "..."
autoresearch export --run-id <TAG>
autoresearch workflow-plan --recipe literature_to_evidence
```

## Boundary

If the user asks for a deleted public command that is not available on `autoresearch`, do not silently fall back or fabricate compatibility wrappers. Keep the generic authority on `autoresearch`, and state clearly that the public `hepar` / `hep-autoresearch` shell is retired.
