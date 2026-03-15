# research-team — Full Usage Guide (English)

This is the English manual for the `research-team` skill.

For the Chinese manual (human-oriented; Chinese), see:
- `references/usage_guide.zh.md`

## Overview

This skill turns an ad-hoc theory+computation project into a reproducible “team workflow”:
- A milestone plan with explicit deliverables and acceptance tests
- A complete derivation notebook (no hand-waving) linked to code/results
- Reproducibility artifacts (manifests, summaries, analysis outputs)
- A two-member cross-check loop (Member A + Member B; default: Claude + Gemini, but runner-agnostic) where both independently replicate derivations and computations
- Optional sidecar reviewers (a small reviewer swarm) for specialized audits (e.g. numerics-only) without blocking the main convergence gate

Agent-first: this workflow is designed to be executed by a tool-using agent (Codex/Claude/Gemini). Humans provide goals, review outputs, and approve decisions.

## Requirements

Required:
- `bash`, `python3`

Recommended:
- `julia` (default numerics language in this skill’s conventions)
- `rg` (ripgrep) for faster scanning (optional; gates fall back to slower methods)

Optional (only for live multi-review runs; deterministic preflight does not require them):
- `claude` CLI
- `gemini` CLI

## Quick start (3 commands)

1) Environment check:

```bash
bash ~/.codex/skills/research-team/scripts/bin/check_environment.sh --require-claude
# or (A=Claude, B=Gemini):
# bash ~/.codex/skills/research-team/scripts/bin/check_environment.sh --require-claude --require-gemini
```

2) Scaffold a project:

```bash
bash ~/.codex/skills/research-team/scripts/bin/scaffold_research_workflow.sh \
  --root /path/to/project \
  --project "My Project" \
  --profile mixed
```

3) Run a team cycle:

```bash
cd /path/to/project

bash ~/.codex/skills/research-team/scripts/bin/run_team_cycle.sh \
  --tag M0-r1 \
  --notes research_contract.md \
  --out-dir team \
  --member-a-system prompts/_system_member_a.txt \
  --member-b-system prompts/_system_member_b.txt \
  --auto-tag
```

## Deterministic preflight-only (no external LLM calls)

To run all deterministic gates without calling any external LLMs (this mode also does not require network access):

```bash
bash ~/.codex/skills/research-team/scripts/bin/run_team_cycle.sh \
  --tag M0-r1 \
  --notes research_contract.md \
  --out-dir team \
  --member-a-system prompts/_system_member_a.txt \
  --member-b-system prompts/_system_member_b.txt \
  --preflight-only
```

If a gate fails, fix the minimal root cause (docs/artifacts/config), then rerun with a new tag (e.g. `M0-r2`).

## Review access modes (packet_only vs full_access)

Configured in `research_team_config.json`:
- `review_access_mode=packet_only`: reviewers must use only the team packet (offline/portable review; legacy mode).
- `review_access_mode=full_access`: reviewers still have no direct tools; they request file reads / command runs / network fetches via a leader-run proxy. Every access is logged to `team/runs/<tag>/member_{a,b}_evidence.json` and enforced by deterministic gates.

Third-party validation (offline):
- `python3 ~/.codex/skills/research-team/scripts/bin/validate_evidence.py team/runs/<tag>/member_a_evidence.json`

## Knowledge base (3 layers)

Projects use a three-layer knowledge base under `knowledge_base/`:
- `knowledge_base/literature/`: notes/excerpts from external sources (papers, docs, code)
- `knowledge_base/methodology_traces/`: method selection + reproducibility traces (commands, outputs, limits)
- `knowledge_base/priors/`: conventions and fixed assumptions (notation, units, normalizations)

Tip: keep the first Markdown H1 (`# ...`) meaningful and include a line `RefKey: <key>` near the top; these are used by downstream tooling.

## KB index JSON (deterministic / L1 export)

For a deterministic, offline JSON index over the 3 KB layers (for downstream retrieval and change detection), see:
- `references/kb_index.md`

## Where to look when something fails

- Rerun recipes and gate diagnosis: `RUNBOOK.md`
- Skill entrypoint (short): `SKILL.md`
- Chinese extended manual: `references/usage_guide.zh.md`
