---
name: research-team
description: "Use when a project selects a formal A/B milestone review and convergence cycle, or needs the team's delegation and evidence contracts. Provides reproducible artifacts, deterministic preflight, and strict result acceptance; ordinary host-native research assistance stays in the host-led research loop."
---

# Research Team (Lean Entry)

This is the **trigger-loaded** entry for the `research-team` skill.
For the full manual (English), see `references/usage_guide.md`.
For the Chinese manual (human-oriented), see `references/usage_guide.zh.md`.
For the KB index exporter docs (English), see `references/kb_index.md`.

## When to use

Keep the host agent responsible for the research question, main analysis, evidence integration and delivery. For ordinary bounded assistance, use the host's native subagents and the applicable delegation budgets below; continue the [research-harness](../research-harness/SKILL.md) loop. A useful delegation does not by itself require full team assets, team preflight or an A/B convergence cycle.

Select the formal team cycle when the project's milestone acceptance calls for:

- deterministic preflight gates (fail-fast),
- a human research memo (`research_notebook.md`) plus a machine contract (`research_contract.md`),
- reproducible artifacts (manifests/summaries/figures),
- and a strict 2-member convergence loop (Member A + Member B).

## Workflow authority boundary

- Generic literature workflow authority does **not** live inside `research-team`; it lives in the checked-in `literature-workflows` workflow-pack (`packages/literature-workflows/recipes/` + session protocol) and the checked-in public stateful `nullius workflow-plan` front door.
- `research-team` consumes that authority during prework / KB building and later evidence-oriented stages; it should not redefine provider-neutral literature workflow truth.
- `scripts/bin/literature_fetch.py` is a source-adapter helper for INSPIRE/arXiv/Crossref/DataCite/GitHub/DOI and local KB preparation; when it needs workflow truth, it must call the checked-in front door or lower-level consumer path rather than restating recipe semantics locally.
- When a literature pull is too shallow (KB notes left metadata-only, no cross-paper synthesis), the `deep-literature-review` skill is the right surface: it consumes the same recipes, deep-reads sources to fill this skill's KB note template (with locators), synthesizes consensus/tensions/gaps into a checkable `literature_survey_v1`, and hands the extracted claims to `claim-grounding`.

## Mandatory boundaries and task routing

Choose only the references required by the action below; read them **before** that action. Their detailed requirements remain binding. Commands and code paths resolve from this skill directory. Do not load the full manuals to discover a single operation.

- **Before dispatching or re-entering a team cycle**, read [candidate-cycle.md](references/candidate-cycle.md "nullius-guidance"), [convergence-registration.md](references/convergence-registration.md "nullius-guidance") and [execution-origin-contracts.md](references/execution-origin-contracts.md "nullius-guidance"). Review one stabilized milestone candidate, batch fixes, use bounded rounds and record retries. Unavailable reviewers supply no verdict; a stalled loop must consolidate, narrow, execute a prepared step or escalate. Convergence, adjudication dispositions, result registration, run stamps and original member-construction evidence remain mandatory.
- **Before delegating work**, read [delegation-budgets.md](references/delegation-budgets.md "nullius-guidance"). Computation, claim-bearing or blindness-dependent work is full-tier: freeze the required budget and inputs before dispatch. Read-only analysis and review-only consultation use the light-tier ledger. Respect task-derived stopping accuracy, time box, attempt cap, scope exclusions, memory and independence-route budgets; budget exhaustion preserves atomic results and never authorizes an identical unmeasured retry.
- **For a result-bearing candidate**, read [scientific-evidence-contracts.md](references/scientific-evidence-contracts.md "nullius-guidance"). Fill the reproducibility capsule, including sweep/branch semantics and method preconditions. Run diagnostic falsifiers at the actual result configuration; non-diagnostic checks never pass. Symbolic claims require blind re-derivations via `derivation-verify`; computed numbers require `numerical-reliability-gate`. Load-bearing confirmation requires independently constructed and executed evidence lanes with method, model-family, execution and input independence recorded separately. Shared-kernel call-through, copied answers and self-assessment cannot supply confirmation. Process violations quarantine evidence and preserve it for diagnosis.
- **When rewriting or closing the human notebook**, read [notebook-content-acceptance.md](references/notebook-content-acceptance.md "nullius-guidance"). Rewrite affected sections into a coherent research memo; every headline result links its registered artifact from a declared rewritten human section. Require the full current notebook and dependency bytes to receive accepted content review in addition to structural checks. Missing, unavailable, partial, stale or capacity-unverified review cannot close out. A delta review, automatic table, self-check or missing launcher grants no exception; semantic acceptance does not establish scientific truth.
- **When a delegation names prior art**, read [reuse-or-deviate.md](references/reuse-or-deviate.md "nullius-guidance") before implementation or result assessment. Reuse the named asset or obtain coordinator approval for a measured deviation before writing its replacement; a post-hoc justification does not satisfy the gate.
- **For a specific helper**, read [capabilities-index.md](references/capabilities-index.md "nullius-guidance"), then only its linked detail. For separate worktree lanes, read [parallel-worktree-lanes.md](references/parallel-worktree-lanes.md); for roadmap or report promotion, read [roadmap-and-report-promotion.md](references/roadmap-and-report-promotion.md).

## Prepare a selected A/B cycle

Use these steps after selecting a formal cycle. Reuse an existing project's assets and contract; scaffold only when setting up that workflow, then fill its goal, milestone scope and contract with the actual research task before preflight.

> Commands below stay install-location-portable by resolving the skill via `SKILL_DIR`, with a host-neutral fallback that probes known agent skill homes (`~/.claude`, `~/.codex`, `~/.config/opencode`, `~/.kimi-code`). These paths are portable skill-discovery locations across different agent hosts, not a menu of host options — the same skill installs and runs under any of them.

1) Check the deterministic prerequisites. No model CLI is required for preflight:

```bash
SKILL_DIR="${SKILL_DIR:-$(for r in "${CLAUDE_CONFIG_DIR:-$HOME/.claude}" "${CODEX_HOME:-$HOME/.codex}" "$HOME/.config/opencode" "$HOME/.kimi-code"; do [ -d "$r/skills/research-team" ] && echo "$r/skills/research-team" && break; done || true)}"
bash "${SKILL_DIR}/scripts/bin/check_environment.sh"
```

2) Scaffold the workflow into a project repo:

```bash
SKILL_DIR="${SKILL_DIR:-$(for r in "${CLAUDE_CONFIG_DIR:-$HOME/.claude}" "${CODEX_HOME:-$HOME/.codex}" "$HOME/.config/opencode" "$HOME/.kimi-code"; do [ -d "$r/skills/research-team" ] && echo "$r/skills/research-team" && break; done || true)}"
bash "${SKILL_DIR}/scripts/bin/scaffold_research_workflow.sh" \
  --root /path/to/project \
  --project "My Project" \
  --profile mixed \
  --full
```

Scaffold creates `prompts/_system_member_a.txt` and `prompts/_system_member_b.txt` (note the leading underscore; they are copied from the skill assets `system_member_a.txt` / `system_member_b.txt`).
Use `--full` for this selected team workflow's prompts and runner assets; the default project scaffold stays minimal.
The public scaffold and contract-refresh entrypoints now run in `real_project` mode: use an external project root, and keep real-project run/intermediate outputs outside the nullius development repo. Internal maintainer fixtures remain a lower-level contract mode only, not part of the public workflow.

3) Prepare the candidate with deterministic preflight from the project root:

```bash
cd /path/to/project

SKILL_DIR="${SKILL_DIR:-$(for r in "${CLAUDE_CONFIG_DIR:-$HOME/.claude}" "${CODEX_HOME:-$HOME/.codex}" "$HOME/.config/opencode" "$HOME/.kimi-code"; do [ -d "$r/skills/research-team" ] && echo "$r/skills/research-team" && break; done || true)}"
bash "${SKILL_DIR}/scripts/bin/run_team_cycle.sh" \
  --tag 20260502-m0-r001-topic-r1 \
  --notes research_contract.md \
  --out-dir artifacts \
  --member-a-system prompts/_system_member_a.txt \
  --member-b-system prompts/_system_member_b.txt \
  --preflight-only
```

This runs the configured deterministic gates, creates the parent run and its packet, and returns before member execution, including with the default `host_native` setting. A successful preflight is preparation, not a review verdict. Keep its tag for development retries; if using `--auto-tag`, use the resolved tag printed by the script.
`--out-dir` must resolve to the project's `artifacts` directory; unsupported
output overrides refuse before directory creation. Team and draft payloads
live in `artifacts/runs/<tag>/research_team/`. A present project-local launcher
must accept the parent origin stamp before cycle work; a missing launcher is
reported as unstamped. Conflicting origin never silently rebinds the run.

## Execute and accept the selected cycle

Choose the execution route that can supply the evidence the project actually requires. The current `full_access` route requires supported CLI runners and runtime-observed member execution; see the [explicit runner example](references/usage_guide.md#execute-a-selected-cycle) and [member transport contract](references/member_transport.md). The shell script cannot spawn host-native subagents. Native Markdown reports alone cannot satisfy this formal gate, and switching a required `full_access` cycle to `packet_only` does not satisfy its acceptance conditions.

For an already applicable `packet_only` cycle, native A/B reviewers may use the existing member prompts and packet, with no tool-execution claims. Its convergence check establishes report consistency only, with zero independent execution confirmations. After member work, follow the existing convergence, adjudication, result-registration and notebook acceptance contracts above. If a required runner or evidence route is unavailable, preserve the completed work and name the pending acceptance; do not claim convergence or keep retrying unchanged inputs.

Read [`references/workspace-disk-policy.md`](references/workspace-disk-policy.md) when a team cycle leaves per-member workspaces on disk, disk space must be reclaimed, or an unattended loop needs a pruning schedule (the `Workspace disk policy` block, moved there verbatim).

## Deep dive (read only when needed)

- Full manual (English): `references/usage_guide.md`
- Chinese manual (human-oriented): `references/usage_guide.zh.md`
- KB index exporter (English): `references/kb_index.md`
- Troubleshooting / rerun recipes: `RUNBOOK.md`
- Gate contract notes: `FULL_VALIDATION_CONTRACT.md`
- Artifact contract: `references/artifact_contract.md`

Read [`references/run-layout.md`](references/run-layout.md) when locating run payloads or historical run evidence, working with the project index and run index, or checking what the source-assessor packet embeds (the closing run-layout paragraphs, moved there verbatim).
