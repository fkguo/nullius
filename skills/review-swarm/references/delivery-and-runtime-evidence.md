Command, script and asset paths in this reference are relative to the `review-swarm` skill directory. Markdown links are relative to this reference. Cross-section names follow the routes in [SKILL.md](../SKILL.md).

## Contract checking (delivery shape)

`--check-review-contract` validates output format compliance and records results in `meta.json`.
Contract failures never trigger backend fallback and never mark the lane failed — content
matters more than format, and the output is always retained. They DO withhold the lane from
convergence/credit aggregation (`excluded_contract_invalid` in the convergence record, and no
dual-review comparison seat): an unfinished delivery cannot occupy a seat. The remedy is the
disposition rule below, never silent exclusion.

If you want models to output a specific format, include format instructions in your system/user prompt.

### Malformed delivery ≠ rejected opinion (disposition rule)

A failed contract check means the reviewer has not finished **delivering** — never that the
review's substance was weighed and found wanting. The contract validates delivery shape
(parseable verdict line, the fixed severity homes, archivability against the next round);
it has no opinion about the reasoning inside. Dispose of a contract-invalid review in
exactly one way:

- **Rerun same-model with the missing pieces named** (the runner records them in
  `contract_errors` and a `contract_remedy` hint). The reviewer already did the reading;
  re-emitting in contract shape is one cheap round. The [Gemini and OpenCode caveats](backend-overrides-and-tool-modes.md)
  are instances of this rule, not backend-specific allowances.
- **Never record a hybrid terminal state.** "Format-invalid but substantively supportive"
  must not enter a convergence count, a formal status line, or a closeout packet — not as
  a downgraded vote, not as a qualified-consensus footnote. Convergence counts
  contract-valid verdicts only; every other seat is either rerun until valid or honestly
  recorded as "this seat delivered no valid review". Once same-model rerun attempts are
  exhausted (bounded by your retry budget), the leader applies the fallback policy exactly
  as for any other failed seat — substitution or honest degradation; the runner itself
  never auto-falls-back on contract grounds. The invalid output is retained for diagnosis.
- **The inverse also holds.** Contract-valid says nothing about substance: a well-formed
  placeholder verdict is still rejected by the substantive checks (blank/short-output
  detection, source-grounding requirements).

The failure mode this rule closes: a reviewer reads the material, reaches a grounded
verdict, misses required sections — and the leader "honestly downgrades" it to a
format-disqualified side opinion, excluded from convergence yet still cited. That inverts
substance-over-format twice: the substance is discarded where it counts (the gate) and
kept where it cannot be checked (the prose). Rerun the seat; count only what is both
contract-valid and substantively grounded.

Standalone checker:

```bash
python3 scripts/bin/check_review_output_contract.py /tmp/dual_review/claude_output.md
```

Contract auto-detects output format:
- **Markdown**: `VERDICT: READY/NOT_READY` first line + required headers (`## Blockers`, `## High-severity`, `## Non-blocking`, etc.) — the three severity buckets give every grade of the canonical ladder a fixed home
- **JSON**: Valid JSON object with `blocking_issues` (array), `verdict` (`PASS`/`FAIL`), `summary`

JSON outputs wrapped in markdown code fences (`` ```json ... ``` ``) are automatically unwrapped.

Read [`references/two-phase-protocol.md`](two-phase-protocol.md) when a review is run with the opt-in `--two-phase` protocol or declared review criteria (the `Two-phase review protocol` section, moved there verbatim).

Read [`references/outputs-and-runner-parity.md`](outputs-and-runner-parity.md) when locating a review's output files or weighing how the backends differ in system-prompt delivery and file access (the `Outputs` and `Runner parity notes` sections, moved there verbatim).

## Skill name note

Use `review-swarm` as the canonical external name.
Use `review-swarm` consistently during migration and in new integrations.

Capacity evidence requires an adjacent runtime observation of the actual successful invocation, including requests that fit the conservative byte bound. The local runtime binds the complete original request, actual report locator, working directory and captured bytes using its host authority; recalculating project artifact hashes cannot create that observation. Verification trusts the runtime and owning OS account, and does not authenticate provider truth or scientific correctness. Historical unsigned records remain readable, but cannot supply new capacity acceptance; they are never retrospectively signed.

Runtime observations bind the actual report location, so copying signed capture bytes cannot authenticate a new invocation elsewhere. Member episodes freeze every observed file into durable original storage before publication; successful workspace cleanup preserves subsequent verification. Records lacking these bindings remain readable and unavailable for new acceptance.

Member origin trusts the configured runner and owning host runtime: the complete runner bytes are recorded, but no runner allowlist or provider attestation is claimed. Offline or injected host execution establishes a local process/callable observation; actual provider capacity evidence requires the corresponding CLI capture. The canonical team cycle performs a postflight source assessment and a separate fresh assessment at the final consumer; both use the configured assessor request/execution budgets.

The owning account can read the authority key, including code executed by a member under that account; this authenticates against non-executing artifact tampering, not hostile same-account code. No OS sandbox or provider attestation is supplied.

The configured token window is frozen before the original reviewer subprocess starts and bound into its authenticated runtime observation. Changing historical window metadata cannot admit that receipt. Older observations without this policy remain readable and require a fresh execution for capacity acceptance.
