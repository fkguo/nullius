---
name: hepar
description: >
  Legacy Pipeline A launcher for explicit hepar/hep-autoresearch sessions.
  Canonical generic lifecycle entrypoint is now `autoresearch`; use this skill only for unrepointed legacy surfaces.
---

# hepar (hep-autoresearch) — Codex launcher skill

This skill is for the transitional `hep-autoresearch` CLI (alias: `hepar`), not the long-term generic entrypoint.

## Contract

- Treat `autoresearch` as the canonical generic lifecycle entrypoint for `init/status/approve/pause/resume/export`.
- Use `hepar` / `hep-autoresearch` only when the user explicitly requests the legacy Pipeline A surface or needs unrepointed commands such as `run`, `doctor`, or `bridge`.
- Do not present `hepar` / `hep-autoresearch` as the default long-term control plane.
- If a task can be completed on `autoresearch`, prefer that canonical surface instead of the legacy names.
- Evidence-first: meaningful work must land under `artifacts/runs/<TAG>/...` as `manifest.json / summary.json / analysis.json` (SSOT).
- Respect approval gates A1–A5. If an approval is pending, stop and ask the user to approve or reject.
- If the CLI is not available, stop and help the user install/activate it (do not “pretend” it ran).

## Typical commands

```bash
# Canonical lifecycle entrypoint:
autoresearch init
autoresearch status
autoresearch approve <approval_id>
autoresearch pause --note "..."
autoresearch resume --note "..."
autoresearch export --run-id <TAG>

# Legacy Pipeline A surface (still transitional for unrepointed commands):
hep-autoresearch run --run-id <TAG> --workflow-id <WID> [args...]
hep-autoresearch doctor --json
hep-autoresearch bridge --run-id <TAG>
```

## Approval loop

```bash
autoresearch status   # read pending_approval.approval_id
autoresearch approve <approval_id>
```

## Session Protocol

For research session flow (stage identification, tool recommendations, transition hints),
see `meta/protocols/session_protocol_v1.md`.

Maintainer note: repo-internal regression/self-evolution remains a separate maintainer workflow and should use explicit maintainer fixtures (for example `init --runtime-only` in dev/test harnesses), not the normal real-project quickstart.
