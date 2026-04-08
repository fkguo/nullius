# Autoresearch-Lab Coordinator-Lane Overlay

> **Date**: 2026-03-30
> **Status**: Historical overlay reference (non-authoritative for current public front door)
> **Role**: `autoresearch-lab`-specific constraints layered on top of the external Codex lane orchestration skill

## Canonical Split

The reusable lane/coordinator automation is no longer canonical inside this repo.

- Canonical reusable automation skill: `~/.codex/skills/codex-lane-orchestration/`
- Canonical reusable protocol reference: `~/.codex/skills/codex-lane-orchestration/references/thread-lane-protocol.md`
- Canonical runtime state root: `~/.codex/lane-orchestration/`
- Current project profile: `~/.codex/lane-orchestration/profiles/autoresearch-lab.yaml`

This repo keeps only the project-specific overlay: human review boundaries and `autoresearch-lab` workflow expectations. Maintainer-local prompt/plan artifacts are intentionally outside the public authority surface.

## Boundary For This Repo

### External layer owns

- thread/turn orchestration through Codex public app-server APIs
- `watch`, `reconcile`, `launch-lane`, `status`, and `prove` command behavior
- heartbeat/checkpoint ingestion mechanics
- reusable worktree bootstrap / validation workspace preparation / lane status aggregation
- daemon/runtime logs and reconciler state under `~/.codex/lane-orchestration/`

### Repo-internal truth still owns

- root governance and hard rules in `AGENTS.md`
- `meta/ECOSYSTEM_DEV_CONTRACT.md`
- `docs/ARCHITECTURE.md`
- `docs/PROJECT_STATUS.md`
- `meta/front_door_authority_map_v1.json`
- project code, tests, schemas, contracts, and closeout truth

### Repo-internal implementation truth still owns

- checked-in source/tests/schemas under `packages/*`, `meta/schemas/*`, and related acceptance tests
- public front-door docs (`README.md`, `docs/README_zh.md`, `docs/QUICKSTART.md`, `docs/ARCHITECTURE.md`, `docs/PROJECT_STATUS.md`, `docs/URI_REGISTRY.md`)
- checked-in long-lived architecture conclusions in `.serena/memories/architecture-decisions.md`

Those items are not external skill-runtime state and must stay in repo.

## Required Checkpoints For Autoresearch-Lab

This project still recognizes only these four lane→coordinator checkpoints:

- `plan_approval_needed`
- `blocker_decision_needed`
- `version_control_authorization_needed`
- `merge_decision_needed`

The external skill may automate packet ingestion and coordinator turn startup, but it must not invent new project-level checkpoint classes for this repo.

## Project-Specific Review Meaning

### `plan_approval_needed`

For `autoresearch-lab`, this remains the substantive first checkpoint for any real implementation lane. The lane should point to checked-in public authority (source/tests/schemas/front-door docs) whenever the scope is durable, cross-package, governance-touching, or likely to be reread later.

### `blocker_decision_needed`

Use only when the lane truly needs a substantive human decision. Routine bookkeeping, normal reruns, and ordinary in-lane normalization should not be escalated here.

### `version_control_authorization_needed`

For this repo, this means the lane has already completed implementation, acceptance, review, self-review, and tracker/plan sync, but still lacks human authorization for version-control actions. This is still not `merge_ready`.

### `merge_decision_needed`

For this repo, this is valid only after the merge candidate is already committed, the worktree is clean, and the applicable review/rebase checks for that committed head are satisfied.

## Project-Specific Artifact Placement

- Durable implementation authority stays in checked-in source/tests/schemas/front-door docs
- Maintainer-local planning/queueing/parallelization notes are not public authority
- Runtime heartbeat/checkpoint JSON, daemon logs, and lane intermediate state must stay outside the repo under `~/.codex/lane-orchestration/`

Do not move canonical project truth (code/tests/schemas/public docs) into external skill runtime state.

## Current Profile Defaults

The current external profile for this repo is `~/.codex/lane-orchestration/profiles/autoresearch-lab.yaml`.

Current default bindings are:

- `repo_root = <autoresearch-lab-repo-root>`
- `heartbeat_relpath = .tmp/lane-status`
- `checkpoint_relpath = .tmp/lane-checkpoints`
- `worktree_root = <worktree-parent-root>`

If these bindings change, update the external profile first. Only update this overlay if the project-level meaning of the workflow changes.

## Migration Note

Historical generic lane/coordinator automation should be treated as externalized. This repo no longer acts as the canonical home for reusable bootstrap/status/checkpoint automation; it only records how `autoresearch-lab` constrains and interprets that external layer.
