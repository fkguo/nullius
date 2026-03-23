---
name: hepar
description: >
  Use the hep-autoresearch (hepar) orchestrator as the control plane for evidence-first research runs:
  init/status/run/approve/pause/resume/export, with artifacts + approval gates.
---

# hepar (hep-autoresearch) — Codex launcher skill

This skill makes Codex behave like an operator for the `hep-autoresearch` CLI (alias: `hepar`).

## Contract

- Treat `hep-autoresearch` as the control plane; prefer running the CLI over ad-hoc manual steps.
- Run `hep-autoresearch init` only from an external research project root; the autoresearch-lab repo itself is a dev repo, not a real-project root.
- Evidence-first: meaningful work must land under `artifacts/runs/<TAG>/...` as `manifest.json / summary.json / analysis.json` (SSOT).
- Respect approval gates A1–A5. If an approval is pending, stop and ask the user to approve or reject.
- If the CLI is not available, stop and help the user install/activate it (do not “pretend” it ran).

## Typical commands

```bash
# One-time per research project:
hep-autoresearch init

# Anytime:
hep-autoresearch status
hep-autoresearch run --run-id <TAG> --workflow-id <WID> [args...]
hep-autoresearch pause --note "..."
hep-autoresearch resume --note "..."
hep-autoresearch export --run-id <TAG>
```

## Approval loop

```bash
hep-autoresearch status   # read pending_approval.approval_id
hep-autoresearch approve <approval_id>
```

## Session Protocol

For research session flow (stage identification, tool recommendations, transition hints),
see `meta/protocols/session_protocol_v1.md`.

Maintainer note: repo-internal regression/self-evolution remains a separate maintainer workflow and should use explicit maintainer fixtures (for example `init --runtime-only` in dev/test harnesses), not the normal real-project quickstart.
