---
name: review-swarm
description: Run clean-room multi-agent loops across Claude/Gemini/Codex/OpenCode/Kimi with strict review-contract checks, fallback policy, and convergence gates.
---

# Review Swarm (multi-backend)

This skill provides a reusable clean-room swarm harness for independent reviewers/analysts.

Core capabilities:
- Run **N agents** with `run_multi_task.py`.
- Mix backends: OpenCode, Claude CLI, Codex CLI, Gemini CLI, Kimi CLI.
- Enforce strict review output contract (optional).
- Opt-in two-phase commit-then-review protocol (`--two-phase`).
- Apply fallback policy when a target backend fails/returns invalid output.
- Record deterministic artifacts (`trace.jsonl`, `meta.json`, outputs).
- Gate on convergence (optional Jaccard similarity).

## Canonical entrypoint

Use `scripts/bin/run_multi_task.py` for all new workflows.

Primary public skill name: `review-swarm`.
Use `review-swarm` consistently in documentation and automation references.

## Requirements

Install runner skills for any backends you plan to use:
- `opencode-cli-runner` (for OpenCode backend)
- `claude-cli-runner` (for `claude/...` models)
- `codex-cli-runner` (for `codex/...` models)
- `gemini-cli-runner` (for `gemini/...` models)
- `kimi-cli-runner` (for `kimi/...` models)

CLIs should be available in `PATH` according to the chosen backends.

## Host-aware execution (your own family runs native; quality first)

`run_multi_task.py` shells out to CLIs — that is for CROSS-family reviewers: the families you list in
`--models` should be families OTHER than the one you (the driving agent) run as, so every reviewer is
genuinely independent of you. Your own family reviews natively in-host, not through its own CLI — never list
your own family in `--models` just to aggregate. Host capabilities VARY; gate on what your host exposes:

- **Single-family review → keep it in-host, not via that family's CLI.** If you only need YOUR family's
  reviewer (no cross-family swarm aggregation), run it in-host: use a native child-agent/sub-agent
  primitive if your host has one (your host's sub-agent / Agent-Task mechanism; OpenCode subagents), else run it inline
  in your own loop — don't `claude exec` a model you are already running as (latency, separate
  auth/session, context loss). Plain Claude Desktop / the Gemini CLI may have no sub-agent primitive →
  inline.
- **Cross-family swarm → all reviewers go through `run_multi_task.py` (honest caveat).** Its convergence
  / contract aggregation is computed over the runner's OWN output files, so a natively-run same-family
  reviewer would not be in the swarm. Getting one unified multi-backend verdict therefore means your own
  family also goes through its CLI here — that hop is the price of in-process aggregation. Use the swarm
  when you need cross-MODEL review; do single-family reviews natively.
- **Reasoning effort scales with review difficulty — quality first, not token thrift.** High-stakes,
  cross-package, or security-sensitive reviews warrant maximum thinking (extended thinking / high–xhigh
  reasoning effort / a stronger model); trivial diffs do not. Never accept a missed defect to save tokens.
- For a long/expensive swarm, prefer a steerable **background task chip** (e.g. your host's spawn-task / sub-agent launch)
  the user can inspect and adjust mid-run, when the host supports one; otherwise run inline and
  checkpoint. Capability varies by host — degrade gracefully.

## Quick start (multi-agent)

```bash
python3 scripts/bin/run_multi_task.py \
  --out-dir /tmp/multi_review \
  --system /path/to/system.md \
  --prompt /path/to/task.md \
  --agents 3
```

## Quick start (cross-family review: families other than your own)

The swarm exists to add reviewers from model families OTHER than the one you run as. List only the OTHER
families in `--models`; run your own family natively in-host (see Host-aware execution above). Choose the
list by your host — currently wired backends are `claude/...`, `codex/...`, `gemini/...`, `kimi/...`, and any OpenCode
`provider/model` (e.g. `zhipuai-coding-plan/glm-5.2` for GLM):

- From a **Claude** host → `codex/...`, `gemini/...`, `zhipuai-coding-plan/glm-5.2` (not `claude/...`).
- From a **Codex** host → `claude/...`, `gemini/...`, `zhipuai-coding-plan/glm-5.2` (not `codex/...`).
- From an **OpenCode/GLM** host → `claude/...`, `codex/...`, `gemini/...` (not the OpenCode lane).

Example, driven from a Claude host (three non-Claude reviewers):

```bash
python3 scripts/bin/run_multi_task.py \
  --out-dir /tmp/cross_family_review \
  --system /path/to/reviewer_system.md \
  --prompt /path/to/packet.md \
  --models codex/default,gemini/default,zhipuai-coding-plan/glm-5.2 \
  --check-review-contract
```

## Backend overrides

`run_multi_task.py` supports per-backend overrides:
- `--backend-prompt backend=/path/to/prompt`
- `--backend-prompt @/path/to/overrides.json` (batch mode)
- `--backend-system backend=/path/to/system` or `backend=none`
- `--backend-output backend=relative_or_absolute_path`
- `--backend-tool-mode backend=mode`
- `--timeout-secs N`

Notes:
- These flags are repeatable.
- `--backend-prompt @json` supports:
  - shorthand prompt map: `{"gemini": "/path/to/gemini_prompt.txt"}`
  - batch object: `{"prompt": {...}, "system": {...}, "output": {...}}`
- Relative `--backend-output` paths are resolved under `--out-dir`.
- `claude=none` for `--backend-system` is rejected (Claude runner requires a system prompt file).
- For a single run, `--backend-output` does not allow one path for repeated same-backend agents (to avoid output clobbering).
- `--timeout-secs` is a per-backend hard timeout. Default: `900` seconds. Use `0` to disable.
- `--backend-tool-mode` is explicit and backend-specific:
  - `claude=none|review`
  - `gemini=none|review`
  - `opencode=none|workspace`

## Reviewer Tool Modes

Default behavior is explicit:
- Claude, Gemini, and OpenCode now receive an explicit tool mode from `review-swarm`.
- The default mode is `none` for all three backends.
- Tool access must be opted into per backend with `--backend-tool-mode`.

Reviewer-safe modes:
- `claude=review`: maps to a read-only built-in tool profile (`Read,Glob,Grep`).
- `gemini=review`: maps to Gemini CLI `--approval-mode plan` plus local CLI execution (`--no-proxy-first`), sandboxing, and `--extensions none`, which is Gemini's read-only review path.
- When Gemini is in `review` mode and `--gemini-cli-home` was not explicitly set, `review-swarm` now synthesizes an isolated `GEMINI_CLI_HOME` under the run output directory and writes a minimal user settings file there (`mcpServers={}`, `mcp.allowed=[]`) to avoid inheriting reviewer-external user MCP state by default.
- Gemini `review` is a headless review path, not the same interaction mode as the Gemini TUI `/mcp` session. If this path emits MCP discovery noise or does not yield a usable source-grounded verdict on a large packet, prefer a same-model rerun with an embedded-source packet and `gemini=none` rather than assuming TUI MCP health guarantees headless review stability.

OpenCode caveat:
- `opencode=workspace` explicitly grants workspace visibility by passing `--workspace-dir`.
- For formal workspace reviews, prefer OpenCode's official headless-server flow (`opencode serve` + `opencode run --attach ...`) rather than relying only on repeated direct `run --dir ...` cold starts.
- Current `opencode run` CLI does not expose a built-in read-only tool allowlist comparable to Claude/Gemini, so `workspace` is explicit workspace access, not a hard no-mutation guarantee.
- For `opencode=workspace`, prefer workspace-relative file paths in prompts/packets. Large prompts that enumerate absolute workspace paths or globs can push the model into `external_directory` permission requests even when the repo itself is mounted as the workspace.
- Treat `OpenCode workspace` and `OpenCode embedded-source` as two different review roles:
  - `workspace`: packet-challenge / discovery reviewer. Best when blast radius or hidden front-door / consumer drift is still uncertain.
  - `none` + embedded-source packet: verdict-normalization / formal gate reviewer. Best when scope is already narrowed and you need a stable closeout artifact.
- Do not treat an OpenCode workspace pass as "failed" just because the output includes exploratory text or lacks a clean final JSON block. If it still contains source-grounded, current-worktree findings, keep that review signal and only rerun same-model to normalize the gate artifact.
- For formal reviewer use, prefer Claude/Gemini for source-grounded read-only review guarantees; treat OpenCode workspace mode as discovery-strong but gate-fragile, and reserve embedded-source OpenCode passes for final formal-verdict stabilization once packet scope is adequate.
- When packet scope touches public/package/CLI/workflow/default-entry surfaces, also follow the `Front-door Surface Audit` requirement in `AGENTS.md`; runner setup does not replace packet widening.

### Execution adversary (mandatory for correctness-critical / method-precondition reviews)

A read-only review is a *static read*; it cannot confirm a runtime property. When a review must establish
that a method's load-bearing precondition actually holds — an operator identity (commutation with a
projector/symmetrizer, Hermiticity, self-adjointness, idempotency, unitarity, variational/Galerkin-subspace
invariance), a numerical invariant, or a true-operator eigen-residual — at least **one reviewer must take an
"execution adversary" role**: load the artifact and *execute* the disconfirming test at the **production
scale/configuration**, not statically read the code. Give that reviewer real execution access (a host-native
sub-agent with run/Bash, or a sandbox that can execute), and record in `meta.json` whether each reviewer
**executed vs. only read** the precondition checks. A swarm in which *no* reviewer executed the precondition
is a **static-only** swarm and must be labeled as such — it does **not** count as a precondition pass. (A
static read can certify code shape; only execution at the production scale can certify that a discretized /
implemented property actually holds — a property can read as correct and still fail numerically above the
minimal size.)

### Source-fidelity reviewer (mandatory for transcription / source-extraction artifacts)

A **source-extraction / transcription note** — a deep-read / knowledge-base note that transcribes
equations, numeric values, source locators, and term-by-term mappings onto a consuming artifact from a
primary source — is a **valid gate target**, not a gate-exempt "reading task." Its primary observable is
**fidelity to the source**, so the review is a different shape from a code/design review: at least **one
cross-model-family reviewer must do a LITERAL, line-by-line comparison of the note against the primary
source with "do not trust the note."** Loose semantic agreement is insufficient — transcription drift (a
flipped sign, a dropped magnitude factor, a transposed digit, a stale locator, or a stale mapping to the
consuming artifact) reads as plausible and is caught only by literal comparison. Reviewer model-family
diversity materially strengthens this gate: a same-family looser read tends to pass exactly the defects it
is meant to catch.

Give that reviewer the **persisted primary source** (the exact bytes that were transcribed), not the note
alone, plus the transcription/extraction failure checklist (`research-integrity` → *Extraction /
transcription fidelity*, items (a)–(g)). Record in `meta.json` whether a literal cross-family source
comparison was performed; a swarm that only read the note, or stayed within one model family, is **not** a
fidelity pass and must be labeled as such.

### Artifact-integration reviewer (for rendered research artifacts)

When a workflow turns source-read notes into a rendered artifact — for example an interactive literature
graph, slide deck, dashboard, or browsable note bundle — include at least one reviewer whose task is to
inspect the **current rendered artifact and its source files**, not merely the synthesis prose. This reviewer
checks integration failures that source-fidelity review alone cannot see: broken relative links, missing
images, unrendered math, non-clickable connected references, stale note paths, layout collisions, and a
renderer that displays placeholders or filenames instead of the intended evidence.

Write reusable workflows in terms of reviewer roles and capabilities, not specific model names. A concrete
run may choose particular models, but the skill or project contract should say "independent cross-model
artifact reviewer" or "source-fidelity reviewer" unless a user explicitly pins a model for that run.
After any artifact fix, rerun the reviewers on the fixed artifact before calling convergence.

### Reference-reproduction reviewer (mandatory for "matches / reproduces a published value" claims)

A claim that a result **reproduces / matches / agrees with a published reference value** is a *quantitative*
claim a static read cannot certify — reading the prose only confirms the prose. When a packet asserts such a
match, at least **one reviewer must take a "reference-reproduction" role** and cover two distinct dimensions
that a correctness / methodology / honesty review routinely passes over:

- **D1 — recompute and compare.** **Compute the claimed observable on a comparable state / regime /
  configuration and compare to the published number numerically** — do not accept a qualitative "same order
  of magnitude / same sign / right scale" assertion, and do not accept the citation as if citing the source
  proved the match. Compare **term by term** where the claim is term-level (a net total can agree while
  individual contributions are suppressed or sign-flipped). **An order-of-magnitude same-direction
  discrepancy, or a sign reversal, is a BLOCKING finding, not a pass.** Give this reviewer real execution
  access (a host-native sub-agent with run/Bash, or an executing sandbox) when the comparison requires
  computation.
- **D2 — the independent cross-check did not silently lapse.** Confirm that any cross-validation evaluates
  the *same* model by a different route. A structurally **different-model** engine, or a check valid only in
  a degenerate / limit regime, must be **labeled as a different-model / limit-regime comparison, not
  presented as validation**; and when no apples-to-apples independent check is feasible, the **absence is
  recorded as an explicit stated limitation** rather than an established cross-check being allowed to
  silently disappear.

Record in `meta.json` whether a reviewer **computed-and-compared vs. only read** the match assertion; a
swarm in which *no* reviewer recomputed the claimed observable on the comparable state is a **static-only**
swarm for that claim and must be labeled as such — it does **not** count as a reference-match pass.
Cross-model-family diversity strengthens this gate. Pair it with `numerical-reliability-gate` **G8** (the
compute-and-compare gate, returning `reference_mismatch` on an order-of-magnitude or sign gap) and the
`research-integrity` *Reference-reproduction fidelity* dimensions.

## Model selection

- `--agents N`: rotate through available OpenCode config models.
- `--models a,b,c`: explicit model specs.
- `--model default`: one OpenCode agent, CLI default model.
- Mixed backends supported: `claude/...`, `codex/...`, `gemini/...`, `kimi/...`, OpenCode `provider/model`.

### Default-model policy (hard rule)

When model is omitted or set to `default`, **do not inject historical model names**.
Always delegate to each backend CLI's configured default model.

This rule applies to all backends:
- OpenCode
- Claude CLI
- Codex CLI
- Gemini CLI
- Kimi CLI

## Fallback policy

Fallback can be enabled for target backends (default target: `gemini`):

- `--fallback-mode off` (default)
- `--fallback-mode ask` (exit code `4`, asks for rerun decision)
- `--fallback-mode auto` (tries `--fallback-order`, default `codex,claude`)

Example:

```bash
python3 scripts/bin/run_multi_task.py \
  --out-dir /tmp/cross_family_review \
  --system /path/to/system.md \
  --prompt /path/to/prompt.md \
  --models codex/default,gemini/default,zhipuai-coding-plan/glm-5.2 \
  --check-review-contract \
  --fallback-mode auto \
  --fallback-order codex,claude
```

## Prompt-size guardrail (optional)

- `--max-prompt-bytes N` or `--max-prompt-chars N`
- `--max-prompt-overflow fail|truncate`

When enabled, guardrails apply to global inputs and backend override inputs.

## Convergence check

```bash
python3 scripts/bin/run_multi_task.py \
  --out-dir /tmp/multi_review \
  --system /path/to/system.md \
  --prompt /path/to/task.md \
  --models codex/default,gemini/default,zhipuai-coding-plan/glm-5.2 \
  --check-convergence \
  --convergence-threshold 0.8
```

### Re-review after every fix (gate-loop discipline)

Convergence is a property of the **reviewers' agreement on the current artifact**, never a
self-pronouncement after applying a fix. The gate loop is review → fix → **re-run the independent
reviewers on the fixed artifact** → repeat, and it converges only when the reviewers themselves return
clean. Re-review after **every** correction round, including ones that look trivial or single-line: a fix
can introduce a **new** defect — a corrected transcription line that silently drops a magnitude factor, or
a refactor that re-breaks an invariant — that exists only after the fix and is caught only by the next
independent round. Skipping the confirmation round because the change "obviously" closed the finding is the
failure mode this rule exists to stop. The leader integrates and decides, but does **not** declare
convergence in place of the reviewers.

## Contract checking (informational)

`--check-review-contract` validates output format compliance and records results in `meta.json`.
**Contract failures are informational only** — they never trigger fallback. Content matters more than format.

If you want models to output a specific format, include format instructions in your system/user prompt.

Standalone checker:

```bash
python3 scripts/bin/check_review_output_contract.py /tmp/dual_review/claude_output.md
```

Contract auto-detects output format:
- **Markdown**: `VERDICT: READY/NOT_READY` first line + required headers (`## Blockers`, etc.)
- **JSON**: Valid JSON object with `blocking_issues` (array), `verdict` (`PASS`/`FAIL`), `summary`

JSON outputs wrapped in markdown code fences (`` ```json ... ``` ``) are automatically unwrapped.

## Two-phase review protocol (opt-in)

Default reviews are single-phase: each reviewer sees the full packet (diff included) in one
call. `--two-phase` adds an opt-in commit-then-review protocol for formal reviews where two
documented multi-agent failure modes matter: a reviewer improvising its evaluation standard
only after seeing the diff, and persuasive phase-2 prose substituting for the standard it
would have committed to up front. **Single-phase behavior is completely unchanged when the
flag is absent.**

When to use: formal review of high-risk or irreversible public-surface changes —
cross-package contract changes, default-entry behavior, anything where the project already
requires independent formal review. Routine incremental diffs do not need it.

How it works:

1. **Phase 1 — criteria commitment.** Each reviewer receives a scope packet only — change
   title, intent, and the changed-file list, with the diff deliberately withheld
   (`--scope-prompt` file, prepared by the caller). The reviewer must declare the review
   criteria it commits to: exactly one block wrapped in `<review_criteria>` /
   `</review_criteria>` sentinel lines, containing a JSON object with a non-empty
   `categories` array (each entry: a `name` plus a one-sentence `blocking_criteria`) and a
   `severity_scale` sentence.
2. **Phase 2 — review per committed criteria.** The same reviewer is called again with the
   full diff packet (the normal `--prompt` / per-backend override) plus its own phase-1
   criteria block, verbatim. Every BLOCKING finding must carry a declared category:
   a `[<category>]` bullet prefix under `## Blockers` in Markdown output, or a `category`
   field / `[<category>]` string prefix on `blocking_issues` entries in JSON output.
3. **Criteria revision.** If the diff reveals a problem class outside the declared
   categories, the reviewer may add a category only with an explicit revision declaration:
   a `CRITERIA_REVISION: <category>: <one-line reason>` line in Markdown output, or a
   `criteria_revisions` array entry (`category` + `reason`) in JSON output. The machine
   check verifies the declaration exists and is well-formed; judging whether the reason is
   any good stays with the synthesis agent.

Conformance is machine-checked after phase 2 (same code path as
`check_review_output_contract.py --two-phase PHASE1_FILE PHASE2_FILE`): a BLOCKING finding
whose category is neither declared nor covered by a revision declaration is a conformance
failure. Like the single-phase contract check, **conformance failures are informational** —
recorded per agent in `meta.json` under `two_phase` (`conformance_ok`,
`conformance_errors`), never a fallback trigger. Phase-1 failures are different: if the
phase-1 call fails or returns no parseable criteria block, phase 2 is skipped and the agent
is marked failed (`phase1_command_failed`, `phase1_empty_output`, or
`phase1_criteria_invalid`); rerun that reviewer same-model.

```bash
python3 scripts/bin/run_multi_task.py \
  --out-dir /tmp/formal_review \
  --system /path/to/reviewer_system.md \
  --scope-prompt /path/to/scope_packet.md \
  --prompt /path/to/diff_packet.md \
  --models codex/default,gemini/default,zhipuai-coding-plan/glm-5.2 \
  --two-phase \
  --check-review-contract
```

Notes:
- The scope packet must not contain the diff; keeping it to the change title, intent, and
  changed-file list is the caller's responsibility.
- `--scope-prompt` is global (no per-backend override); per-backend `--backend-prompt`
  overrides apply to the phase-2 diff packet as usual.
- `--two-phase` rejects `--fallback-mode ask|auto`: silently substituting a different
  backend mid-protocol would break the commitment chain. Use a same-model rerun instead.
- Two-phase is a per-invocation CLI opt-in only; it is deliberately not settable from the
  project config file, so a config can never silently flip a default run into two-phase.
- In Markdown phase-2 output, findings under `## Blockers` must be bullets. Untagged
  indented lines are continuations of the bullet above; an indented bullet that itself
  carries a `[<category>]` tag counts as a finding (nesting is not an evasion channel);
  column-0 prose other than a no-blocker placeholder is flagged as unstructured content.
- Phase transcripts stay auditable: composite prompts live under `{out-dir}/two_phase/`,
  phase-1 outputs sit next to the final outputs with a `.phase1` suffix (both paths are
  cleared of stale files from previous runs at the start of a two-phase run).

## Outputs

- `{out-dir}/agent_*_*.txt` (or backend output override paths)
- `{out-dir}/trace.jsonl`
- `{out-dir}/meta.json`
- With `--two-phase`: `{out-dir}/two_phase/` (composite phase prompts) and `*.phase1.*`
  phase-1 outputs next to the final outputs.

## Runner parity notes

### System prompt delivery

All backends now receive the system prompt by default. However, the delivery mechanism differs:

| Runner | Delivery | True system role? |
|--------|----------|-------------------|
| claude-cli-runner | `--system-prompt` native arg | Yes |
| codex-cli-runner | Merged into stdin (`=== System Instructions ===` + `=== Task ===`) | No — prepended to user message |
| gemini-cli-runner | Concatenated into stdin (`system + \n\n + prompt`) | No — prepended to stdin |
| opencode-cli-runner | Concatenated into stdin (same as gemini) | No — prepended to stdin |
| kimi-cli-runner | `--system-prompt-file` prepended to the prompt file | No — prepended to user message |

Only Claude CLI uses a true system role with elevated priority. The other four runners prepend the system prompt as a user-message prefix. This is a CLI limitation, not a bug.

### File access

| Runner | File access | Notes |
|--------|-------------|-------|
| Codex | `--sandbox read-only` | Can browse the codebase |
| Gemini | Default headless Gemini CLI mode | Review-safe tool access is opt-in via `--backend-tool-mode gemini=review` |
| Claude | `--tools` parameter | Review-safe tool access is opt-in via `--backend-tool-mode claude=review` |
| OpenCode | Workspace exposure is explicit | `--backend-tool-mode opencode=workspace` exposes the workspace, but not with a hard read-only allowlist |

### Implications for review weight

- Codex reviews may reference specific files/lines thanks to sandbox access — treat as higher-confidence for implementation details.
- Gemini reviews now default to standard headless mode unless review-safe tools are explicitly enabled.
- Claude reviews now default to no built-in tools unless review-safe tools are explicitly enabled.
- OpenCode reviews default to isolated, prompt-driven runs unless workspace access is explicitly enabled.
- System prompt parity ensures all backends share the same review criteria (BLOCKING/HIGH/LOW taxonomy, output format).

## Skill name note

Use `review-swarm` as the canonical external name.
Use `review-swarm` consistently during migration and in new integrations.
