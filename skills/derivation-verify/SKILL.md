---
name: derivation-verify
description: "Use the moment you have just derived a formula, closed form, identity, estimator, bound, or sign/branch choice that later work will rely on — before folding it into durable artifacts. Convergence-gate harness for DERIVATION-heavy results in ANY field (closed forms, integrals/sums, algebraic/operator/logical identities, probabilities/estimators, asymptotic/complexity bounds, sign/branch/boundary choices). For each atomic claim it runs >=2 INDEPENDENT blind re-derivations, an adversarial comparator that clusters them by MATHEMATICAL equivalence, and a tie-break loop that adds fresh independent derivations until >=2 agree — emitting an auditable verification matrix. Backend-agnostic contract with TWO executors: a Claude/Workflow-native one (same-model, fast) and a CLI multi-backend one (Claude/Codex/Gemini/OpenCode/Kimi) that assesses independent execution/input/construction and reports method/model diversity separately. Sibling to `review-swarm` (which REVIEWS an artifact); this one RE-DERIVES the answer."
---

# Derivation Verify

A reusable convergence gate for the question *"is this derived result actually correct, independently?"*
It enforces the standing rule: **every derivation needs >=2 independent verifications; iterate every
disagreement to convergence; the leader never self-declares convergence.**

## When to use

Use when you have a **derivation result** in **any field** to certify and you want independent
confirmation + disagreement iteration. The skill is domain-neutral — only the caller-supplied `context`
and `statement` carry the domain. Example claim types (illustrative, not a fixed list):
- a closed form / integral / sum (e.g. a loop integral `A(q)=arctan(q/2m)/2q`, or a combinatorial sum),
- an algebraic / operator / logical identity; a sign, branch, or boundary-case choice,
- a probability or estimator (e.g. an MLE / variance), an asymptotic or complexity bound (e.g. `Θ(n log n)`),
- a transform, a limiting value, or a numeric anchor.

Each is phrased as an **atomic claim**: a thing to **DERIVE BLIND** (the answer is NOT given to the
deriver) and report in a fixed canonical format.

## When NOT to use (use a sibling instead)

- **Reviewing an existing artifact** (a diff, a draft, a manuscript) against a contract → use
  [`review-swarm`](../review-swarm/SKILL.md) (clean-room reviewers, review-contract, Jaccard convergence).
  *Different verb:* review-swarm **critiques an artifact**; derivation-verify **re-derives the answer N
  ways and reconciles by mathematical equivalence** (not text similarity).
- **A source-extraction / transcription fidelity check** — does a deep-read / extraction note faithfully
  transcribe equations, numeric values, locators, and mappings from its **primary source**? → NOT a blind
  re-derivation: the answer is not re-derived, it is **compared against an external source**. Route it to
  [`review-swarm`](../review-swarm/SKILL.md)'s cross-model-family literal source-comparison reviewer (with
  the `research-integrity` *Extraction / transcription fidelity* checklist). derivation-verify reconciles
  independent re-derivations by mathematical equivalence; it does not check a note against the bytes it was
  copied from. A derivation can be internally correct while starting from the same mistranscribed source
  formula, so do not give independent derivation lanes a candidate note or expected correction as an
  unexamined premise.
- **A suspected source typo with no published correction uses both skills, in order.** First use
  `review-swarm` source extraction/fidelity to freeze the exact `PRINTED_FORM`; do not repair it.
  Then formulate a derivation claim from the quantity's definitions, domain, conventions, and neighboring
  premises, withholding both the disputed printed expression and every proposed replacement from at least
  two blind independent lanes. Exclude every later equation, summary, numerical target, or constraint
  whose derivation depends on the disputed item; feeding a downstream consequence back as a premise is a
  circular confirmation, not an independent derivation. Only after the lane outputs are frozen may the comparator test them against
  the printed form and proposed corrections. If the lanes converge uniquely to an expression that matches
  neither the printed form nor an existing proposal, register that expression as a fresh
  `PROPOSED_CORRECTION` and subject it to the same counterchecks; do not adopt it silently. A converged unique result supports the scientific status
  `independently_supported_correction`, not `published_correction` or
  `author_confirmed_correction`. If the lanes do not converge uniquely, return
  `unresolved_source_error` and do not choose a downstream formula by majority or convenience.
- **A full milestone research cycle** with drafts/gates → use [`research-team`](../research-team/SKILL.md).
- **A "the discretized / implemented operator preserves property P" or "method precondition X holds at
  scale S" claim** → NOT a symbolic-derivation claim, and it **cannot** be settled by blind re-derivation:
  a correct symbolic/continuum identity does not certify that its discrete or implemented realization
  preserves it. Route such claims to the **numerical method-precondition gate**
  ([`numerical-reliability-gate`](../numerical-reliability-gate/SKILL.md) G7) and/or the `research-team`
  §J capsule, which test the disconfirming residual **at the production scale/config**. derivation-verify
  certifies the abstract identity; it does **not** certify the realization.

## Whole-notebook review is a separate requirement

`nullius notebook review --model claude/opus` reviews the entire current human notebook:
derivation completeness, logic, notation, definitions, assumptions and conventions,
with source-anchored reasons and full coverage of every section. It freezes the
complete UTF-8 notebook (including its automatic block) and required declared
dependencies by actual-byte SHA-256, including uncommitted edits. Changed bytes
make the review stale. Its supporting semantic verdict is not a blind
re-derivation or decisive computation validation and does not prove scientific
truth; a single reviewer leaves explicit limits on independence.

A passing derivation matrix does not establish that the whole notebook explains
its assumptions or every load-bearing step. Conversely, an accepted prose review
does not replace this skill's independent re-derivations. Links, automatic tables,
formula counts, checklists and author self-assessment establish neither requirement.
`nullius notebook check` requires structural navigation and current accepted
full-text review in file and engine mode; `--result` scopes only links and
`--structure-only` establishes navigation alone. Missing, partial, failed,
unavailable, invalid or stale content review never passes; history stays readable.

Valid UTF-8 text remains text regardless of size; Markdown links are discovered
recursively. Binary or invalid UTF-8 linked files are immutable `opaque_links`
snapshots and hash locators, not read evidence. Every opaque path/hash needs a
specific `opaque_sources` assessment; a required unread source prevents acceptance.
Notebook and explicit dependencies require strict UTF-8 and LF or CRLF endings.

The complete material is frozen before review. Storage (`--snapshot-bytes`,
default 512 MiB; `--max-files`, default 256) is separate from each request's
`--context-bytes` and configured backend `--context-tokens` window (default
200,000 tokens, with instruction/output reserves). Default request bytes use a
conservative token upper bound. A larger explicit byte packet requires captured
backend token usage when that bound exceeds the window; missing capacity evidence,
observed backend compaction or delivery failure supplies no acceptance.

Larger materials use original UTF-8 intervals with adjacent original context,
followed by a joint audit receiving the COMPLETE original notebook and text
dependencies. All intervals and the joint audit must be complete and fresh;
selected quotations or summaries cannot replace this original input. The default
execution budget is 1200 seconds and 64 calls (`--timeout-secs`, `--max-batches`),
with one attempt per call and no automatic retry. Shortfalls expose total frozen
material, pending intervals and joint scope, the reason and a resumable command.
An unfinished intake reports discovered material and incomplete dependency
enumeration. `--resume <run-id>` creates a new run, revalidates original receipts
and material identity, retains explicit dependencies and storage budgets, and
never rewrites old evidence. If the full joint input does not fit the backend,
raise an available backend's request budget or leave the review incomplete.
Only tool mode `none` is accepted. Multiple batches are one semantic review;
they do not establish independent confirmations or a cross-family quorum.

Converged folds invoke the same unscoped `nullius notebook check --json` required
for final file closeout. `none` declarations and a missing launcher grant no
exception. `--result` is a scoped structural diagnostic; it cannot substitute for
the full default check, whose structural scope includes every current result.

## The contract and execution

Independent confirmation requires at least two evidence lanes independently constructed or derived and executed from a neutral question and raw inputs. Record method diversity, model-family diversity, execution independence and input independence separately. Same or similar methods, the same algorithm name, matching hashes or shared legitimate libraries do not by themselves disqualify a lane. Agent names, seeds, reworded prompts, copied answers and simple reruns of the original implementation do not establish independence. Different methods with contaminated input framing still fail. A fresh assessor must substantively inspect the actual steps, method preconditions, known defects and diagnostic power with exact source spans and reasons; a self-filled no-defect checkbox is insufficient. Missing, rejected, stale or non-diagnostic evidence does not count. Keep an explicit project-specific different-method risk requirement when that requirement tests a known shared failure mode.

Inputs retain `context`, `max_iter` and atomic `claims` with `id`, `statement`, `report_format`, `method0` and `method1`. The two method hints may be the same or similar. The caller audits the shared premises for answer contamination; no prior answer or downstream consequence is shown to any derivation lane, including tie-break rounds. A claim may explicitly set `requires_method_diversity: true` and describe `method_diversity_risk` for a project-specific shared failure. The condition consumes fresh examiner `method_risk_assessments` with literal approval of substantively distinct actual mechanisms, the concrete risk, actual method analysis and source anchors from both lanes; differently named hints cannot satisfy it.

Executor 1 is `workflows/derivation_verify.js` through the host Workflow tool. Executor 2 is `scripts/run_multi_backend.py`, using the existing review-swarm launcher. A single available backend can execute two fresh blind lanes. Native Workflow confirmations require actual in-host calls observed by that executor. Python externally supplied `native_derivations` are unavailable for confirmation: author transport fields, success flags and hashes cannot establish an observed invocation or suppress available CLI executions. No validated external capture authority is supported. Serialized receipts remain readable but cannot recreate runtime observation authority. Each CLI invocation uses a fresh directory; default records persist beside the requested matrix output, or beside the claims file when writing to stdout. Available diversity remains a reported limitation.

```bash
python3 skills/derivation-verify/scripts/run_multi_backend.py \
  --claims claims.json --backends claude/opus --comparator claude/opus --out matrix.json
```

Each lane returns complete `derivation` text without a sentence limit; `derivation_summary` is optional navigation only. The comparator receives all original steps, complete runtime-observed requests and raw outputs, successful invocation records and any captured original tool records. Missing original material or failed invocation cannot count. A fresh comparator supplies `independence_assessments` for every lane: input/execution/construction independence, observed method, method applicability, diagnostic power, unresolved defects, and exact spans plus substantive reasons for each axis. Construction, applicability and diagnostic evidence must quote the complete original `derivation_context` (the structured `derivation` body when no additional assistant text exists); only input and execution evidence may quote the full `assessment_source` transport closure. These are examiner judgments bound to observed work, not the lane author's approval. Only assessed lanes count toward the agreeing cluster. `independent_confirmations >= 2` is required; method and family diversity are separate output fields. CAS may establish mathematical equivalence between assessed forms, but does not bypass the provenance/applicability assessment or prove scientific truth. Both CAS and LLM agreement additionally require the adjudicator's recomputation to agree; symbolic equality cannot override an explicit adjudicator veto. Failed/missing assessments leave the claim unconverged.

The Native matrix retains every original claim, including unavailable failed rows with zero confirmations and an explicit `failure_reason`; `total_claims` counts the original scope and failed ids remain in `unconverged`. The matrix retains complete `derivation_records` and reports `independence_evidence`, `independent_confirmations`, `cross_family_confirmations`, `verification`, `families`, iteration count, answer and outliers. Cross-family count is descriptive rather than an automatic acceptance floor. The complete lane packet is bound to the current comparison; changed original material invalidates it. A comparator panel requires joint majority support for its cluster, assessment and any explicit method-risk assessment; unavailable lanes/reviewers are not confirmations. See [the contract](references/contract.md) and offline tests under `tests/`.

An accepted comparison must enumerate at least two eligible indices and report their exact cardinality. Its published answer must represent that adjudicated cluster. CAS equality cannot accept an empty, singleton or different cluster, override a veto, or publish another cluster's answer. Inconclusive and contradictory cardinalities leave zero accepted confirmations.

Derivation comparator requests preserve every original lane and use `--context-bytes` and `--context-tokens` in the Python CLI, or `context_bytes` and `context_tokens` in Native args. The default token window is 200000 with separate protocol/output reserves. Python CLI comparisons require the current successful capture observation, exact request/report/cwd, and observed usage or a conservative bound; detected compaction refuses. Native and injected host protocols enforce conservative complete-input/output bounds and explicitly report provider token usage, authenticated CLI capture and compaction witnesses unavailable. A configured window is not provider capability introspection.
