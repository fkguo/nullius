# research-team skill

Milestone-based research workflow for theory + computation projects with
reproducible artifacts, independent LLM cross-checks (default: Member A + Member B),
and a strict convergence gate. Optional sidecar reviewers can be added as a small
reviewer swarm.

## Quick start

Use this workflow when the project selects formal independent-member milestone
acceptance. Ordinary research and useful bounded native delegation stay with the
primary host agent through [research-harness](../research-harness/SKILL.md).
Calling a subagent does not require team scaffolding or an A/B cycle.

This skill is designed to be driven by a tool-using LLM agent. The commands below
are what the agent runs; you can also run them manually for reproducibility and
debugging.
Commands below use `SKILL_DIR` so they stay portable across install locations.

1) Prepare the selected workflow's assets, reusing them when already present:

```bash
SKILL_DIR="${SKILL_DIR:-$(for r in "${CLAUDE_CONFIG_DIR:-$HOME/.claude}" "${CODEX_HOME:-$HOME/.codex}" "$HOME/.config/opencode" "$HOME/.kimi-code"; do [ -d "$r/skills/research-team" ] && echo "$r/skills/research-team" && break; done || true)}"
bash "${SKILL_DIR}/scripts/bin/scaffold_research_workflow.sh" \
  --root /path/to/project \
  --project "My Project" \
  --full
```

Use an external project root for real work. Public `research-team` scaffold / contract-refresh / team-cycle flows now fail closed if the project root or real-project intermediate outputs resolve back into the nullius development repo checkout.

If the project will actually use the HEP provider bundle, add `--with-hep-provider`; otherwise the default full scaffold stays host-local and does not precreate `.hep/` or enable the HEP workspace gate.

2) Fill the project goal, milestone scope and contract for the actual task. Keep derivations in `research_notebook.md`, then refresh / maintain the machine-facing `research_contract.md`.

3) Run deterministic preflight from the external project root:

```bash
cd /path/to/project

SKILL_DIR="${SKILL_DIR:-$(for r in "${CLAUDE_CONFIG_DIR:-$HOME/.claude}" "${CODEX_HOME:-$HOME/.codex}" "$HOME/.config/opencode" "$HOME/.kimi-code"; do [ -d "$r/skills/research-team" ] && echo "$r/skills/research-team" && break; done || true)}"
bash "${SKILL_DIR}/scripts/bin/run_team_cycle.sh" \
  --tag 20260502T023000Z-m0-topic \
  --notes research_contract.md \
  --out-dir artifacts \
  --member-a-system prompts/_system_member_a.txt \
  --member-b-system prompts/_system_member_b.txt \
  --auto-tag \
  --preflight-only
```

The resolved `<base>-rN` tag is the parent project-local `run_id`. New team
and draft payloads use `artifacts/runs/<tag>/research_team/`; origin stamps
belong to `artifacts/runs/<tag>/`. `--out-dir` is the project artifacts
folder. Executor evidence and navigation pointers do not grant scientific acceptance.

Preflight prepares the candidate and packet; it does not execute reviewers or
accept results. The default `host_native` setting cannot execute members through
this shell script. For the current formal `full_access` route, explicitly select
supported CLI runners and retain the required runtime observations; follow
[Execute a selected cycle](references/usage_guide.md#execute-a-selected-cycle).
Native reports alone do not provide that evidence. An already applicable
`packet_only` cycle establishes report consistency with zero independent execution
confirmations; lowering a required `full_access` configuration does not satisfy it.
Optional: configure non-blocking sidecar reviewers via `sidecar_review` (single) or `sidecar_reviews` (list) in `research_team_config.json`; scaffolded configs keep them disabled unless you opt in explicitly.

## Requirements

- bash, python3
- julia (recommended)
- rg (optional)
- An explicitly selected supported model CLI for current formal `full_access`
  execution; deterministic preflight does not require a model CLI.

## Docs

See:
- `SKILL.md` for the full workflow, gates, and templates.
- `references/usage_guide.md` for the full usage manual (English).
- `references/usage_guide.zh.md` for the Chinese usage manual (human-oriented).
- `RUNBOOK.md` for gate failure diagnosis + rerun commands.
- `FULL_VALIDATION_CONTRACT.md` for the validation definition and acceptance criteria.
- `references/kb_index.md` for the KB index exporter (English).

## Repository layout

- `scripts/bin/`: entrypoints and orchestrators
- `scripts/gates/`: deterministic gate scripts
- `scripts/lib/`: shared helpers used by scripts
- `scripts/scaffold/`: project scaffold helpers
- local maintainer-only development utilities were moved out of the public repo; user-facing workflow authority stays on `scripts/bin/`, `scripts/gates/`, `scripts/lib/`, and `scripts/scaffold/`
- `scripts/validation/`: deterministic full-contract harness
- `assets/`: templates copied into projects
- `references/`: supporting docs

All newly generated managed project runs use `artifacts/runs/<run_id>/`; team and draft executor payloads live in `research_team/` beneath that run. Origin stamps bind the parent run. Historical `team/runs/<run_id>/` remains read-only evidence: status, run listing, index links and export retain its original location, stamps, validity rulings and result references. Reads do not migrate or rewrite it, and `init --runtime-only` reconnects without moving evidence. Unreadable historical locations are reported as unavailable without blocking unrelated readable runs. Duplicate IDs are reported as ambiguous; bare-ID reads refuse ambiguity, and new execution cannot reuse any historical ID. Stamping, backfill, staging, execution and resume cannot write historical run payloads. Use a distinct ID under `artifacts/runs/` for new work. The `inventory_run_relocation.py --fixture-root <anonymous-fixture> --source-manifest <hash-manifest>` helper only inventories pinned fixture bytes, references, collisions and unresolved bindings; it has no apply mode. Independent reviewer snapshots omit every run's executor payload and all workspace trees, retain production artifacts, and allow only each member's own declared output prefix. Historical reports/adjudications remain coordinator evidence. `team/LATEST*.md` and `artifacts/LATEST.md` are navigation pointers.

The generic scaffold creates `project_index.md`; the team helper updates only executor-local latest pointers and requires `nullius init` when the root index is missing. Selected-result and derived-block writers share a short path lock, reread their inputs, and make at most three attempts when edits are detected while preserving human bytes, mode and EOL outside their marked region. Arbitrary writers that ignore the lock remain outside its guarantee. Generic run counts do not interpret execution round limits; the Python executor resolver and suffix gate own those settings.
