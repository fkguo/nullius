---
name: review-swarm
description: Use when a result, manuscript, derivation, or diff needs independent review. Runs clean-room multi-agent review loops across Claude/Gemini/Codex/OpenCode/Kimi with strict review-contract checks, fallback policy, and convergence gates.
---

# Review Swarm

Use this skill for independent review of a result, manuscript, derivation or diff. New multi-reviewer work uses `scripts/bin/run_multi_task.py`; a single advisory reviewer uses `scripts/bin/review_one.py`, which delegates to that same launcher. Resolve commands and code paths from this skill directory. The canonical public skill name is `review-swarm`.

## Mandatory boundaries

- Match the review investment to the artifact. Result-bearing, public-surface and irreversible artifacts warrant a second seat; cross-family review is preferred, not universally required. Internal implementation work closes on an independent single-family review plus local tests, never the author's tests alone. Record honest degradation and each independence axis.
- A completed seat must be successful, contract-valid, uncontaminated and supported by exact identity evidence. Different routes or aliases do not establish different model families. Roster availability cannot substitute for completed quorum. Native reviewers stay outside launcher aggregation unless deliberately executed through its configured runner.
- Give reviewers the material and neutral question, without prior verdicts or the author's initial judgment. Sealed derivation/recomputation receives only frozen raw inputs, persists its result and terminates before the candidate-visible comparison. Tool mode, ambient context, operator instructions and actual post-fallback execution affect independence; absence of a contamination flag is no attestation.
- Acceptance requires zero BLOCKING findings, HIGH findings fixed or attached to their named acceptance point, and every LOW dispositioned. Apply the stricter grade when schemes overlap. Batch fixes and obtain independent confirmation on the current artifact; default maximum is five candidate review rounds, then narrow or escalate. Lexical Jaccard similarity is not scientific acceptance.
- A verdict applies only to its frozen inputs. Require `FRESH` immediately before folding; changed bytes invalidate acceptance. A malformed delivery is unfinished delivery: bounded same-model normalization first, then documented fallback or honest unavailability. The leader cannot transcribe it into a valid vote. Missing, partial, unchecked, unavailable or stale evidence never counts as acceptance.
- Static reading does not certify runtime preconditions, numerical reproduction or load-bearing structural claims. Use the applicable executing / candidate-withheld roles below and record what each check could falsify. A well-formed report or signed runtime capture proves neither provider truth nor scientific correctness.

## Read only the relevant procedure

Read each applicable reference **before** the named operation. References retain the detailed binding contracts and executable examples.

| Operation | Required reading |
| --- | --- |
| Select panel size, decide whether a second seat is owed, or scope an internal diff | [review-scope.md](references/review-scope.md "nullius-guidance") |
| Choose native versus CLI seats, establish identity/family quorum, or degrade an unavailable roster | [execution-and-identity.md](references/execution-and-identity.md "nullius-guidance") |
| Launch multiple seats or interpret convergence similarity | [launcher-invocation.md](references/launcher-invocation.md "nullius-guidance") |
| Launch one reviewer or assemble a source-extraction packet | [single-reviewer-invocation.md](references/single-reviewer-invocation.md "nullius-guidance") and applicable [review-one-flags.md](references/review-one-flags.md) |
| Fix, confirm, reuse or fold a verdict | [gate-loop-and-freshness.md](references/gate-loop-and-freshness.md "nullius-guidance") and [delivery-and-runtime-evidence.md](references/delivery-and-runtime-evidence.md "nullius-guidance") |
| Establish current full-notebook acceptance | [notebook-content-review.md](references/notebook-content-review.md "nullius-guidance"); whole current original text and dependencies are always required, including confirmation |
| Establish a method precondition or runtime invariant | [execution-adversary.md](references/execution-adversary.md "nullius-guidance"); execute at the result's production configuration |
| Transcribe or extract source material | [source-fidelity-review.md](references/source-fidelity-review.md "nullius-guidance"); candidate-withheld extraction precedes comparison, including source/correction provenance and visual PDF checks when applicable |
| Review rendered artifacts, claim a published-value match, or certify a load-bearing structural claim | [result-and-artifact-roles.md](references/result-and-artifact-roles.md "nullius-guidance"); choose every applicable role, not only one |
| Dispatch any independent reviewer, especially a sealed derivation or recomputation | [reviewer-isolation.md](references/reviewer-isolation.md "nullius-guidance") |
| Select model defaults, handle failures or override runner tools/prompts/deadlines | [model-selection.md](references/model-selection.md "nullius-guidance"), then [fallback-and-outages.md](references/fallback-and-outages.md) or [backend-overrides-and-tool-modes.md](references/backend-overrides-and-tool-modes.md) as applicable |
| Request opt-in criteria-first `--two-phase` review | [two-phase-protocol.md](references/two-phase-protocol.md); this does not seal a derivation |
| Locate outputs or compare runner delivery capabilities | [outputs-and-runner-parity.md](references/outputs-and-runner-parity.md) |

For a single correctness reviewer, after reading the applicable scope, identity and isolation contracts:

```bash
python3 scripts/bin/review_one.py \
  --model codex/default \
  --artifact /path/to/notes.md \
  --role correctness
```

Omitted/default model selections use the backend's configured default; never inject a historical model name. This one-seat result remains advisory where the artifact warrants another seat.
