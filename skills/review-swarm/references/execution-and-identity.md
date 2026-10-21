Command, script and asset paths in this reference are relative to the `review-swarm` skill directory. Markdown links are relative to this reference. Cross-section names follow the routes in [SKILL.md](../SKILL.md).


# Review Swarm (multi-backend)

This skill provides a reusable clean-room swarm harness for independent reviewers/analysts.

Core capabilities:
- Run **N agents** with `run_multi_task.py`.
- One-command **single-reviewer** entry with `review_one.py` (advisory; packet auto-assembled).
- Mix backends: OpenCode, Claude CLI, Codex CLI, Gemini CLI, Kimi CLI.
- Enforce strict review output contract (optional).
- Opt-in two-phase commit-then-review protocol (`--two-phase`).
- Apply fallback policy when a target backend fails/returns invalid output.
- Retry empty-output runs and report unreachable backends (`unavailable_backends`) so
  a degraded run reads as a backend outage, never as review disagreement.
- Record deterministic artifacts (`trace.jsonl`, `meta.json`, outputs).
- Gate on convergence (optional Jaccard similarity).

## Canonical entrypoint

Use `scripts/bin/run_multi_task.py` for all new multi-reviewer workflows, and
`scripts/bin/review_one.py` for a one-command single-reviewer pass (it delegates
into `run_multi_task.py` — one orchestration path).

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

`run_multi_task.py` shells out to CLIs. Select reviewer models using identity evidence; a different
route does not establish a different family or independent inputs. Same-family reviews normally run
natively in-host. Host capabilities vary; gate on what your host exposes:

- **Single-family review → keep it in-host, not via that family's CLI.** If you only need YOUR family's
  reviewer (no cross-family swarm aggregation), run it in-host: use a native child-agent/sub-agent
  primitive if your host has one (your host's sub-agent / Agent-Task mechanism; OpenCode subagents), else run it inline
  in your own loop — don't `claude exec` a model you are already running as (latency, separate
  auth/session, context loss). Plain Claude Desktop / the Gemini CLI may have no sub-agent primitive →
  inline.
- **Aggregation includes only launcher-executed reviewers.** Its convergence and contract checks use
  the launcher's own output files. Keep native reviewers' reports separate; do not inject their files
  as completed launcher seats. If every intended seat must appear in one launcher report, execute those
  seats through its configured CLI runners, including a same-family CLI seat when necessary. That seat
  still needs exact identity evidence and supplies no additional family diversity.
- **Reasoning effort scales with review difficulty — quality first, not token thrift.** High-stakes,
  cross-package, or security-sensitive reviews warrant maximum thinking (extended thinking / high–xhigh
  reasoning effort / a stronger model); trivial diffs do not. Never accept a missed defect to save tokens.
- For a long/expensive swarm, prefer a steerable **background task chip** (e.g. your host's spawn-task / sub-agent launch)
  the user can inspect and adjust mid-run, when the host supports one; otherwise run inline and
  checkpoint. Capability varies by host — degrade gracefully.

## Agents file and honest degradation (below the cross-family minimum)

A machine may carry a third-party agents file (project level `.nullius/agents.json`, else user level
`~/.nullius/agents.json`; format and discovery order in the repository page docs/AGENTS_FILE.md)
mapping model families to execution routes and model strings. When one is present,
`run_multi_task.py` accepts `family:<name>` and `family:<name>:<tier>` model specs and resolves them
through the file. `meta.json` separates machine roster availability from completed eligible review
participation. Only a successful, contract-checked, uncontaminated delivery with exact identity evidence
counts toward the completed quorum; failed, partial, contract-invalid and unchecked deliveries do not.
A missing file still permits explicit model specs, but leaves their family evidence unknown.

The launcher records availability and participation separately; the degradation decision is yours
(the agent driving this skill):

- If the file declares fewer usable families than its cross-family minimum, or a `family:` request
  fails because that family is declared unavailable or its runner executable is absent, do NOT
  substitute another family and do NOT silently shrink the review. Follow the file's policy value
  (native subagents): run the review as a panel of your host's own subagents — multiple instances
  with distinct review perspectives (correctness, numerics, portability, ...).
- Label the outcome honestly in whatever you hand back: state the independence level (single-family)
  and list the absent families, so a degraded round is never mistaken for a cross-family one.
  Single-model agreement is the floor; cross-family agreement is the ceiling.
- A family configured with a native runner runs in-host and stays outside this launcher's aggregation
  (see Host-aware execution above).

## Identity and completed quorum

Each lane records the requested model spec, resolved dispatch route/model argument, separately reported
CLI model identity (or `null`) and named `family_evidence`. A resolved alias is not a provider identity.
Exact agents-file model mappings are declared evidence, not independent provider attestation. Unmatched
identities and provider-prefix guesses remain `unknown`; a successful fallback replaces the resolved
route/model and reported identity. Two different CLI routes never establish two model families.

`independence.participating_families`, `completed_eligible_count` and `below_minimum` describe completed
eligible participation. `declared_available_families` and `machine_below_minimum` describe roster/executable
availability. Neither can supply missing completed seats. `diversity` uses named family evidence;
`route_diversity` describes routes only. A useful terminal delivery can remain family-unknown.

`independence_evidence` keeps model-family evidence, tool exposure, input framing and method independence
separate. Unmarked input framing and method independence remain `not_machine_verified`; absence of a
contamination flag is not proof of clean inputs. Capture artifacts live beneath the seat's output prefix
in `OUT.attempts/run.*`; do not include them in a peer packet or workspace. Caller-owned workspace/read-path
membranes must deny peer and prior review payloads. Read-only built-in tools alone are not an OS filesystem
sandbox, so unrestricted browsing cannot attest isolation of private capture files.
