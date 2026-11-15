# research-team — Full Usage Guide (English)

This is the English manual for the `research-team` skill.

For the Chinese manual (human-oriented; Chinese), see:
- `references/usage_guide.zh.md`

## Overview

This skill turns an ad-hoc theory+computation project into a reproducible “team workflow”:
- A milestone plan with explicit deliverables and acceptance tests
- A complete derivation notebook (no hand-waving) linked to code/results
- Reproducibility artifacts (manifests, summaries, analysis outputs)
- A formal two-member cross-check loop (Member A + Member B) with evidence requirements determined by the project's review access mode
- Optional sidecar reviewers (a small reviewer swarm) for specialized audits (e.g. numerics-only) without blocking the main convergence gate

Agent-first: this workflow is designed to be executed by a tool-using agent (Codex/Claude/Gemini). Humans provide goals, review outputs, and approve decisions.

Keep the host agent responsible for the research question, main analysis and delivery. Ordinary bounded assistance can use native subagents under the existing [delegation budgets](delegation-budgets.md); it does not require a formal team cycle, full scaffold or preflight. Use the [research-harness](../../research-harness/SKILL.md) loop for that work. Select the formal A/B workflow when the project's milestone acceptance needs it.

## Requirements

Required:
- `bash`, `python3`

Recommended:
- `julia` (default numerics language in this skill’s conventions)
- `rg` (ripgrep) for faster scanning (optional; gates fall back to slower methods)

Execution capabilities depend on the selected work:

- Host-native subagents can provide bounded assistance and applicable packet-only reviews.
- The current formal `full_access` producer uses explicitly selected `codex`, `claude` or `gemini` CLI runners, with the required runtime observations and an available source assessor. Deterministic preflight does not require a model CLI.

## Prepare a selected A/B cycle

Use these steps only after selecting a formal cycle. Reuse an existing project's assets and contract; scaffold only when setting up that workflow. Commands use `SKILL_DIR` so they stay portable across install locations.

1) Environment check:

```bash
SKILL_DIR="${SKILL_DIR:-$(for r in "${CLAUDE_CONFIG_DIR:-$HOME/.claude}" "${CODEX_HOME:-$HOME/.codex}" "$HOME/.config/opencode" "$HOME/.kimi-code"; do [ -d "$r/skills/research-team" ] && echo "$r/skills/research-team" && break; done || true)}"
bash "${SKILL_DIR}/scripts/bin/check_environment.sh"
```

2) Scaffold a project:

```bash
SKILL_DIR="${SKILL_DIR:-$(for r in "${CLAUDE_CONFIG_DIR:-$HOME/.claude}" "${CODEX_HOME:-$HOME/.codex}" "$HOME/.config/opencode" "$HOME/.kimi-code"; do [ -d "$r/skills/research-team" ] && echo "$r/skills/research-team" && break; done || true)}"
bash "${SKILL_DIR}/scripts/bin/scaffold_research_workflow.sh" \
  --root /path/to/project \
  --project "My Project" \
  --profile mixed \
  --full
```

Use an external project root for real work. Public `research-team` scaffold / contract-refresh / team-cycle flows now fail closed if the project root or real-project intermediate outputs resolve back into the nullius development repo checkout.

The full scaffold supplies `prompts/_system_member_a.txt`, `prompts/_system_member_b.txt` and the runner assets used below. The default scaffold stays minimal. Fill the project goal, milestone scope and contract with the actual task before preflight; a template project is not a ready candidate.

3) Run deterministic preflight:

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

Preflight runs the configured deterministic gates and returns before member execution, including with the default `host_native` setting. It creates the parent run, stamps its origin when a project-local launcher is available, and writes `team_packet_<tag>.txt` inside the run's `research_team/` directory. Successful preflight prepares a candidate; it does not accept results or grant a member verdict.

Keep the explicit tag for development retries. If you choose `--auto-tag`, use its resolved `<base>-rN` as the parent project-local `run_id`. New team
and draft packets, logs, checkpoints and workspaces live in
`artifacts/runs/<tag>/research_team/`; the parent run holds its origin stamp.
`--out-dir` must resolve to the project artifacts directory. Evidence may be
cited there; execution receipts and navigation pointers do not grant scientific acceptance.
Do not use bare UUIDs or `run_<uuid>` as human-facing research tags.

## Execute a selected cycle

For formal `full_access` acceptance, use the existing runtime-observed member producer with supported CLI runners. The default config's `host_native` assignment does not give the shell script a native subagent API. For example, after explicitly choosing Codex CLI for both members:

```bash
bash "${SKILL_DIR}/scripts/bin/check_environment.sh" --require-codex
bash "${SKILL_DIR}/scripts/bin/run_team_cycle.sh" \
  --tag 20260502-m0-r001-topic-r1 \
  --notes research_contract.md \
  --out-dir artifacts \
  --member-a-system prompts/_system_member_a.txt \
  --member-b-system prompts/_system_member_b.txt \
  --member-a-runner-kind codex \
  --member-b-runner-kind codex
```

Member A supports `codex|claude`; Member B supports `codex|claude|gemini`. Choose available configured runners explicitly; the script does not switch providers automatically. Select an available source assessor through `INDEPENDENCE_ASSESSOR_SPEC` (default `claude/opus`) and its configured request budgets before a `full_access` cycle. Original member construction, execution and report binding remain required; see [member_transport.md](member_transport.md). Native Markdown reports or reconstructed evidence JSON cannot substitute for those observations, and lowering an existing `full_access` requirement to `packet_only` cannot satisfy it.

For a cycle whose actual scope and configuration already use `packet_only`, native A/B reviewers can follow the scaffolded member prompts and prepared packet. Preserve their original reports as `<tag>_member_a.md` and `<tag>_member_b.md` in `artifacts/runs/<tag>/research_team/`. The existing `scripts/gates/check_team_convergence.py` accepts `--member-a`, `--member-b`, `--workflow-mode`, `--notes`, `--tag`, `--project-root` and `--out-json`; use the cycle's actual sweep requirement (`--require-sweep` or `--no-require-sweep`). Packet-only convergence is report consistency, with `independent_confirmations=0`, not independent executing reproduction.

After the members return, apply the existing [convergence and registration](convergence-registration.md) and [notebook acceptance](notebook-content-acceptance.md) requirements before adopting the milestone's results. If a required execution route is unavailable, retain the work, state which acceptance is pending, and continue only work that does not depend on it. Do not present bounded native assistance or a preflight-only run as formal milestone acceptance.

## Deterministic preflight-only (no external LLM calls)

To run all deterministic gates without calling any external LLMs (this mode also does not require network access):

```bash
SKILL_DIR="${SKILL_DIR:-$(for r in "${CLAUDE_CONFIG_DIR:-$HOME/.claude}" "${CODEX_HOME:-$HOME/.codex}" "$HOME/.config/opencode" "$HOME/.kimi-code"; do [ -d "$r/skills/research-team" ] && echo "$r/skills/research-team" && break; done || true)}"
bash "${SKILL_DIR}/scripts/bin/run_team_cycle.sh" \
  --tag 20260502-m0-r001-topic-r1 \
  --notes research_contract.md \
  --out-dir artifacts \
  --member-a-system prompts/_system_member_a.txt \
  --member-b-system prompts/_system_member_b.txt \
  --preflight-only
```

If a deterministic gate fails, fix the minimal root cause (docs/artifacts/config) and rerun `--preflight-only` within the same run until the deterministic gates pass — that iteration is development work, not a reviewed cycle. Mint a new resolved tag (e.g. `20260502-m0-r001-topic-r2`) only when re-entering the reviewed convergence cycle with a new candidate (see the retry-regime and verification-granularity contracts in SKILL.md).
Keep `--out-dir` on the real-project side as well; do not route real-project outputs back into the skill repo checkout.

## Review access modes (packet_only vs full_access)

Configured in `research_team_config.json`:
- `review_access_mode=packet_only`: reviewers must use only the team packet (offline/portable review; legacy mode).
- `review_access_mode=full_access`: reviewers still have no direct tools; they request file reads / command runs / network fetches via a leader-run proxy. Every access is logged to `artifacts/runs/<tag>/research_team/member_{a,b}_evidence.json` and enforced by deterministic gates.

Independent confirmation requires at least two evidence lanes independently constructed or derived and executed from a neutral question and raw inputs. Record method diversity, model-family diversity, execution independence and input independence separately. Same or similar methods, the same algorithm name, matching hashes or shared legitimate libraries do not by themselves disqualify a lane. Agent names, seeds, reworded prompts, copied answers and simple reruns of the original implementation do not establish independence. Different methods with contaminated input framing still fail. A fresh assessor must substantively inspect the actual steps, method preconditions, known defects and diagnostic power with exact source spans and reasons; a self-filled no-defect checkbox is insufficient. Missing, rejected, stale or non-diagnostic evidence does not count. Keep an explicit project-specific different-method risk requirement when that requirement tests a known shared failure mode. In full_access mode, the final convergence consumer invokes the reproduction gate once with `--assessor-model MODEL`; the gate observes a fresh successful source-assessor invocation bound to the complete original source/input/execution closure. Calling the reproduction gate separately still requires its own fresh invocation. Each invocation preserves a distinct `assessments/<id>/assessment.json`. Imported JSON cannot supply current execution authority. The gate requires two accepted lanes and emits `independent_confirmations` plus `confirmation_refs`; explicit `independent_reproduction.requires_method_diversity` and `method_diversity_risk` remain additional assessed conditions. Declared tested-kernel call-through fails; shared utilities alone require assessment rather than automatic rejection.

Configure complete source-assessor request budgets in `research_team_config.json` under `independent_reproduction`:

```json
{
  "independent_reproduction": {
    "assessor_context_tokens": 1000000,
    "assessor_context_bytes": 800000,
    "assessor_timeout_secs": 1200
  }
}
```

These values are explicit caller configuration; choose a window supported by the selected executor/provider. They do not introspect or guarantee provider capacity. Defaults are 200,000 tokens, a conservative derived byte allowance (`null`), and 1200 seconds. Timeout must be an integer from 1 to 1200 seconds. The complete source/input/execution originals remain required; insufficient capacity, unavailable capture or compaction refuses acceptance without truncation. Existing generated projects keep their configuration; edit the project configuration explicitly when a different budget is needed.

A successful enabled `full_access` cycle dispatches one fresh source-assessor invocation at the final convergence consumer with these budgets. Postflight retains deterministic evidence, clean-room and isolation checks; consultation is advisory until final acceptance. Report failure or early stop grants no independent confirmation and spends no assessor call. Each later eligible acceptance attempt executes a fresh assessor and retains its original evidence; no prior verdict is reused. Allow one assessor timeout in addition to member execution. The final consumer preserves the complete diagnostic `independent_reproduction_gate.json` when it invokes the gate, but accepts only the current subprocess output and exit status, never an imported diagnostic file.

The current source-assessor route accepts required source, raw inputs and command outputs as strict UTF-8. Binary or invalid UTF-8 originals are preserved but remain unavailable for a new text-route confirmation. Member proxy defaults are 20,000 characters per file read and 12,000 per command output; increase `--max-file-chars` or `--max-cmd-output-chars` before requesting larger complete material. A visibility shortfall refuses the episode.

In `full_access`, submit complete independently constructed source through `files_written` entries containing `path`, `content` and `purpose`. The proxy writes exact UTF-8 bytes only inside the member’s `independent/` prefix before executing literal commands, and binds source snapshots/hash/size to the original model output in `original_transport.construction_refs`. Differing existing source is never overwritten. Each own-prefix code file must match a complete original model-output string; preseeded code without that match cannot count even if an examiner marks it independent. Shared libraries outside that prefix remain subject to source assessment.

Select neutral reproduction input with the team-cycle `--reproduction-packet` option or `independent_reproduction.blind_packet` configuration. The selected route becomes the member writer’s ordinary `--packet` input. A route name does not prove blindness: the source assessor must examine the complete original packet, every actual read, command input and final-stage input for prior answers or author judgments.

Third-party validation (offline):
- `python3 "${SKILL_DIR:-$(for r in "${CLAUDE_CONFIG_DIR:-$HOME/.claude}" "${CODEX_HOME:-$HOME/.codex}" "$HOME/.config/opencode" "$HOME/.kimi-code"; do [ -d "$r/skills/research-team" ] && echo "$r/skills/research-team" && break; done || true)}/scripts/bin/validate_evidence.py" artifacts/runs/<tag>/research_team/member_a_evidence.json`

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

The canonical team cycle selects its source assessor with `INDEPENDENCE_ASSESSOR_SPEC` (default `claude/opus`); direct gates accept `--assessor-model`. Shared project-source locators require explicit assessment using each member's own constructed source. Invalid or ambiguous configuration cannot downgrade the final consumer to report-only comparison.
