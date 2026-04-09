---
name: autoresearch
description: >
  Canonical generic lifecycle entrypoint for autoresearch project roots:
  init/status/approve/pause/resume/export, with project-root guards and approval-aware state handling.
---

# autoresearch — Canonical lifecycle skill

This skill makes Codex behave like an operator for the canonical `autoresearch` lifecycle CLI.

## Contract

- Treat `autoresearch` as the only generic lifecycle entrypoint authority on this repo for `init/status/approve/pause/resume/export`.
- Run `autoresearch init` only from an external real project root; the autoresearch-lab repo itself is a dev repo, not a real-project root.
- `autoresearch` is intentionally lifecycle-only in this batch. Do not invent `autoresearch run`, `autoresearch doctor`, `autoresearch bridge`, or hidden aliases.
- If the user explicitly asks for deleted public Pipeline A commands such as `doctor`, `bridge`, or `literature-gap`, explain that the installable `hepar` / `hep-autoresearch` shell is retired and those commands are not available on the public front door.
- Evidence-first: meaningful work must land under `artifacts/runs/<TAG>/...` as `manifest.json / summary.json / analysis.json` (SSOT).
- Respect approval gates A1–A5. If an approval is pending, stop and ask the user to approve or reject.

## Typical commands

```bash
# One-time per research project:
autoresearch init

# Lifecycle:
autoresearch status
autoresearch approve <approval_id>
autoresearch pause --note "..."
autoresearch resume --note "..."
autoresearch export --run-id <TAG>
```

## Boundary

If the user asks for a deleted public command that is not available on `autoresearch`, do not silently fall back or fabricate compatibility wrappers. Keep the generic authority on `autoresearch`, and state clearly that the public `hepar` / `hep-autoresearch` shell is retired.
