# Orchestrator interaction (CLI/Web: canonical lifecycle + read-only diagnostics)

Goal: upgrade an “agent = a pile of scripts” into an interactive automation assistant, with a UX close to Codex CLI:
- always query status (`status`)
- pause/resume (`pause`/`resume`)
- force-stop at high-risk points and wait for approval (`approve`)
- every step is auditable and rollbackable via artifacts

All commands below assume you are inside a real scaffolded project root (or you pass `--project-root <dir>`). The package repo `packages/hep-autoresearch/` is the development home of the tool, not the project root you operate on day to day.

Chinese version (legacy / detailed notes): `docs/ORCHESTRATOR_INTERACTION.zh.md`.

## 1) CLI commands (CLI-first)

Current front-door truth:
- canonical root lifecycle is `autoresearch init|status|approve|pause|resume|export`
- canonical bounded computation is `autoresearch run --workflow-id computation`
- installable `hep-autoresearch` / `hepar` / `hep-autopilot` keep only `run` on the public shell, and that `run` is just a compatibility pointer
- installable `hepar run` remains as a compatibility shell command, but public workflow ids are now empty
- Exact installable public command inventory: `run`.
- direct root lifecycle/approval mutations such as `start`, `checkpoint`, `request-approval`, and `reject` are retired from the installable shell and no longer belong to the current internal full-parser command inventory
- deleted support wrappers `approvals`, `report`, `logs`, `context`, `smoke-test`, `propose`, `skill-propose`, and `migrate` no longer exist on the parser; their durable authority lives in lower-level toolkit/test surfaces
- remaining internal support launcher residue is only `literature-gap`
- retired-public support helpers `method-design`, `run-card`, and `branch` remain on the internal full parser only and are no longer the live `internal_support_commands` bucket

Suggested command families (conceptual; the concrete authority above is the current truth):
- `init`: initialize your chosen project directory as a project root (scaffold missing docs/KB/specs; create `.autoresearch/` state + ledger)
- `run`: bounded computation lives on `autoresearch run --workflow-id computation`; installable `hepar run` is now a compatibility prompt surface and does not expose public workflow ids
- `status`: show current run state (steps, artifacts, pending approvals, budget usage)
- `pause`: pause the run (write stop files or update state)
- `resume`: continue
- `approve <approval_id>`: approve a pending action (A1–A5)
- `export`: export a run bundle (offline review/sharing)
- the remaining internal support launcher residue is `literature-gap`; retired-public maintainer helpers such as `branch`, `run-card`, and `method-design` remain on the full parser only and are not installable public-shell truth

## 2) Approval packet requirements

Gate timing comes from `docs/APPROVAL_GATES.md` / `docs/APPROVAL_GATES.zh.md` (A1–A5) and can be overridden by config (`specs/approval_policy.schema.json`).

When a gate triggers, the Orchestrator must write a **reviewable approval packet** containing at least:
- category (A1–A5)
- purpose / expected benefit (1–3 sentences)
- plan (what will be done; minimal steps)
- budget (network calls, max runtime, compute/parallelism, data size)
- risks (what could go wrong / biases / failure modes)
- artifacts (what will be produced; paths)
- rollback (how to undo / recover)
- run-card references:
  - `artifacts/runs/<run_id>/run_card.json`
  - `run_card_sha256` (bind approval → run intent; SHA256 of canonical JSON payload, not `sha256sum` of the on-disk bytes)
- plan references:
  - `plan_md_path` (deterministic view)
  - `state.json#/plan` (SSOT pointer)
  - plan step ID(s) the approval applies to

No execution may continue until approval is explicitly resolved on the canonical lifecycle surface.

## 3) State persistence (must be resumable)

The Orchestrator must persist state so runs can resume after crashes/interrupts:
- `run_id` / `tag`
- `workflow_id`
- current step, completed steps, next step
- `pending_approval` (approval_id + packet summary)
- budgets (network calls, runtime)
- artifact pointers (manifest/summary/analysis, diffs, compile logs, etc.)

Recommended storage:
- `.autoresearch/state.json` (hidden runtime state)
- `.autoresearch/ledger.jsonl` (append-only event log)

State contract: `docs/ORCHESTRATOR_STATE.md` (EN) / `docs/ORCHESTRATOR_STATE.zh.md` (Chinese).

## 4) pause/resume: two mechanisms

Support both:
1) explicit commands (`pause`/`resume`) that update state
2) stop files as a universal fallback:
   - `.pause` pause
   - `.stop` stop

## 5) Web entry (later)

Web UI should not change the contract, only the presentation:
- status dashboard (step/logs/artifacts)
- diff / compile log previews

Current implementation note:
- `src/hep_autoresearch/web/app.py` is now a read-only diagnostics panel (`status` + `logs`) and points operators back to `autoresearch` for lifecycle actions

## 6) Acceptance criteria (milestone-ready)

Even without “full-auto success”, require:
- can start a workflow and create run state
- can enter `awaiting_approval` and wait for human input
- can pause/resume and recover after interruption
- writes key artifacts and `status` can point to them

## 7) Long jobs + async approvals (realistic research)

For jobs expected > 1 hour (or batch-queued):
- periodic checkpoints (default every 15 min; configurable)
- async `approve`: human can approve later; approval is queued and consumed at the gate
- `status` shows last checkpoint and estimated remaining time (if available)
- if no checkpoint update for > 2× interval: alert and pause subsequent actions

## 8) Handoffs (multi-user collaboration)

Support “handoff without losing reproducibility”:
- `handoff --to <user>`: write a handoff record (current state, pending approvals, budgets, key artifact pointers, reason)

## 9) Watchdog (avoid silent long-job failures)

Provide a watchdog (script/daemon/cron):
- monitor `.autoresearch/state.json` mtime
- if status is `running` but stale beyond timeout: alert and trigger pause (or create `.pause`)
