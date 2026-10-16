---
name: research-team
description: "Use when a research milestone (theory or computation) needs executed, reproducible work whose results are independently reviewed before being trusted. Milestone-based research-team workflow for theory+computation projects with reproducible artifacts, independent parallel workstreams (default: host-native subagents; configurable), and a strict convergence gate."
---

# Research Team (Lean Entry)

This is the **trigger-loaded** entry for the `research-team` skill.
For the full manual (English), see `references/usage_guide.md`.
For the Chinese manual (human-oriented), see `references/usage_guide.zh.md`.
For the KB index exporter docs (English), see `references/kb_index.md`.

## When to use

Use `research-team` when you want a project workflow with:
- deterministic preflight gates (fail-fast),
- a human research memo (`research_notebook.md`) plus a machine contract (`research_contract.md`),
- reproducible artifacts (manifests/summaries/figures),
- and a strict 2-member convergence loop (Member A + Member B).

## Workflow authority boundary

- Generic literature workflow authority does **not** live inside `research-team`; it lives in the checked-in `literature-workflows` workflow-pack (`packages/literature-workflows/recipes/` + session protocol) and the checked-in public stateful `nullius workflow-plan` front door.
- `research-team` consumes that authority during prework / KB building and later evidence-oriented stages; it should not redefine provider-neutral literature workflow truth.
- `scripts/bin/literature_fetch.py` is a source-adapter helper for INSPIRE/arXiv/Crossref/DataCite/GitHub/DOI and local KB preparation; when it needs workflow truth, it must call the checked-in front door or lower-level consumer path rather than restating recipe semantics locally.
- When a literature pull is too shallow (KB notes left metadata-only, no cross-paper synthesis), the `deep-literature-review` skill is the right surface: it consumes the same recipes, deep-reads sources to fill this skill's KB note template (with locators), synthesizes consensus/tensions/gaps into a checkable `literature_survey_v1`, and hands the extracted claims to `claim-grounding`.

## Non-negotiable contracts (fail-fast)

- **Strict convergence, severity-graded**: if either member reports mismatch/fail/needs revision, you must fix and rerun until converged (or explicitly narrow/kill as `SCOPE`/`MATCHING`). Review findings carry a severity grade, and only the top grade blocks by itself:
  - **Blocking**: the finding changes a recorded result, invalidates a verification claim, breaks input identity / target-value isolation / origin traceability, is a mismatch/fail inside the declared reproduction scope, or is a Major Gap inside the declared scope (a load-bearing item that cannot be verified from the packet, or required evidence that is missing). Convergence requires every blocking finding fixed and re-reviewed.
  - **Non-blocking** (hardening beyond the declared scope, mutation-style test-strengthening ideas, style): reported under Minor Issues, never flipping the verdict by itself. Each non-blocking finding gets an explicit disposition in the adjudication — fix now, attach to a named later acceptance point, or discard with a stated reason — never a silent drop and never an undated "later". This is machine-enforced at the fold boundary: the convergence result carries per-member `minor_issues_count`, and `scripts/gates/check_adjudication_completeness.py` fails closed when a converged cycle's recorded minor issues lack completed disposition rows in the adjudication — run it before folding a converged cycle's results into the durable record.
  - A reviewer whose only findings are non-blocking reports `ready` with the findings listed for disposition; reporting `needs revision` on non-blocking findings alone is a grading error, not extra rigor.
- **Symbolic claims route through `derivation-verify`**: when a converging milestone rests on a symbolic / derivation claim (a closed form, an identity, a sign/branch choice), the independent confirmation for that claim is at least two independent blind re-derivations via [`derivation-verify`](../derivation-verify/SKILL.md) — reviewer agreement that a written derivation "looks right" is not independent confirmation. Computed numbers route through `numerical-reliability-gate`, the sibling gate.
- **Result registration at convergence (mandatory where the project has a
  nullius launcher)**: milestone convergence is when "which result is
  current" changes, so the convergence deliverable includes updating the
  project's traceability record, not only producing the new numbers:
  - a converged headline result gets a row in the results registry
    (`nullius result set-current <result_id> --run <run_id> ...` in
    `project_index.md`) — selection is the research judgment just made at
    adjudication, so record it while it is being made;
  - every run the new result replaces is superseded on the validity ledger
    with the reason (`nullius trace supersede <old_run> --by <new_run>
    --reason ...`); a run found wrong rather than replaced is voided. This
    is what later makes "which of these hundreds of runs still count"
    answerable by a machine instead of by archaeology;
  - rewritten memo sections carry a fresh version stamp
    (`<!-- written-against: <commit> -->` at the section end), so the
    per-section staleness check keeps discriminating current prose from
    holdover prose;
  - before folding, `nullius current` must answer cleanly for the affected
    result chain — no defective registry rows, no stale stamped sections
    citing the milestone's runs — or the residual is named in the
    adjudication with a disposition, same as any non-blocking finding.
  - This contract is machine-enforced at the fold boundary: the adjudication
    template carries a `Result registration` declaration section, and
    `scripts/gates/check_convergence_registration.py` fails closed when a
    converged cycle's declaration is missing, malformed, or does not match
    the project's traceability record — run it alongside
    `check_adjudication_completeness.py` before folding. A declared fact
    that is not on the record is a refusal, not a warning. The same gate
    refuses when the notebook's machine-maintained current-state block is
    present but OUT OF SYNC with its canonical render (a present block
    claims currency; refresh with `nullius notebook sync`), and when a
    section this fold declares rewritten still links a superseded/void run
    as live-looking prose with no acknowledgment (a visible superseded/void
    word in the citing paragraph or list item, a link to the replacement
    run anywhere in the section, or a declared log-role section all count). A MISSING block never refuses a fold — it
    is named as advisory by `nullius status --json` until adopted.
- **Notebook split**: `research_notebook.md` is the human entry; `research_contract.md` is the machine-stable gate surface.
- **Memo discipline (mandatory)**: `research_notebook.md` is a self-contained research memo organized like a paper — connected prose with complete derivations, computations, and analysis — not a change log. Its quality bar: a colleague in the field could read it alone (no runs, no plan) and come away with the project's full current understanding, able to re-derive every load-bearing result. It updates by **rewriting the affected sections into a self-consistent whole**, never by appending stage fragments ("this milestone changed X"); dated progress belongs to `research_plan.md` and `artifacts/runs/<run_id>/`, revision history to git. A milestone does not converge while the memo still describes the pre-milestone understanding: rewriting the affected memo sections is part of the milestone's deliverable, checked in the convergence review like any other artifact.
- **Result-to-memo structure**: a declared headline result must link its registered artifact from a declared rewritten human `##` section. The fold gate reads `notebook.result_links` from `nullius current --json`; `Rewritten sections: none`, an automatic results table, comments, or code examples cannot satisfy this. Direct inline and explicit reference links are supported; use a direct artifact link even when a topic note gives extended detail. This is navigation only; retired historical records remain readable, and every current result participates in the final unscoped structural check.
- **Whole-notebook content review**: finish the notebook and refresh its automatic block, then execute `nullius notebook review --model claude/opus` with repeated `--dependency <project-relative-path>` for required supporting files. The existing review-swarm launcher executes bounded calls with a default hard 1200-second timeout (`--timeout-secs <N>` overrides it) and no automatic reviewer retry. Freeze SHA-256 of the complete UTF-8 notebook, automatic block included, and declared dependency bytes, including uncommitted edits. Commit and section stamps cannot replace byte identity. Require source-anchored reasons on derivation completeness, logic, notation, definitions, assumptions and conventions plus coverage of every section; neither an author assessment nor links, tables, formula counts or checklists supply a verdict. The reviewer receives the material and question without an expected verdict or the writer's initial judgment. A delta-only review cannot satisfy whole-notebook coverage.
- **Current content acceptance at fold**: require `notebook.content_review` to be accepted for the current full notebook and dependencies, identically in file and engine mode. `nullius notebook check --json` reports `structure` and `content_review` separately; `--result` scopes links alone, while `--structure-only` success cannot grant closeout. Missing, partial, failed, unavailable, invalid or stale review is not acceptance. Any changed input bytes require a new full-text review; old reports remain readable. This supporting semantic evidence reuses verification subject/check-run/verdict/coverage and `ArtifactRef`, not decisive computation validation. It does not prove scientific truth; record single-reviewer limits on model, method and input independence and retain all claim-specific checks.

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

- **Reproducibility Capsule (mandatory)**: `research_contract.md` must include a filled capsule block (between `<!-- REPRO_CAPSULE_START -->` and `<!-- REPRO_CAPSULE_END -->`).
- **Sweep semantics (mandatory)**: capsule must include `### G) Sweep semantics / parameter dependence (MANDATORY)` (even if “no sweep”: declare baseline + held-fixed constants).
- **Branch semantics (mandatory when applicable)**: capsule must include `### H) Branch Semantics / Multi-root Contract (MANDATORY)`; if multi-root quantities exist (multiple solutions/branches), you must declare branches/assignment/outputs/invariants/diagnostics.
- **Method-validity preconditions (capsule `### J`; mandatory whenever a recorded result depends on an implemented / discretized / projected / effective method precondition — *novel or textbook alike*; otherwise the section must state `not applicable: <reason>`)**: when a result's validity rests on an operator/structural identity — an operator commuting with a projector/symmetrizer, Hermiticity, self-adjointness, idempotency, unitarity, positivity, or a variational/Galerkin subspace being invariant under the operator — the capsule's `### J) Method-validity preconditions` section must (i) **name** the identity/property, (ii) give a **disconfirming residual** (non-zero iff the property fails), and (iii) report that residual **at the exact configuration that produced the headline number** (not only at the smallest/cheapest setting; if scale-invariance is itself claimed, add a residual scan across settings). For any eigenvalue/variational result from a projected or effective operator, report the **true-operator residual** `‖Oψ − λψ‖ / ‖Oψ‖` (with a documented norm; guard a near-zero denominator with a fixed scale) and the variance — not merely that ψ has the right symmetry. *A precondition verified only at a smaller/cheaper setting than the result is NOT verified* — discretization/finite-size artifacts (aliasing, grid parity, periodic wrapping) typically appear only above the minimal size. Backed by a fail-fast: `check_reproducibility_capsule.py` requires §J (filled or an explicit `not applicable: …`) when `require_method_precondition` is enabled — so "MANDATORY" is enforced, not advisory. The novelty of the *domain result* is irrelevant; what matters is that the *implemented operator* carries the precondition.
- **Cross-check resolution honesty (mandatory)**: a cross-check whose tolerance/resolution is coarser than the discrepancy it must detect is **non-diagnostic**, not a pass. For every cross-check, record explicitly *what it cannot resolve* (e.g. an order-unity / scheme-ambiguous agreement cannot certify a finer absolute value, and cannot detect a non-variational shift smaller than its bracket). Never mark such a check "passed" for a property finer than its resolution. The same honesty applies **before** a proposed discriminator/test is executed: the proposer first computes its **discriminating power** — the expected signal against the degenerate background / confounders (a broad feature probed through a window narrower than the feature, or a smooth monotone factor compared against any smooth background, is background-degenerate). A test whose expected signal is not cleanly separable from its confounders is non-diagnostic before it runs: neither its positive nor its negative outcome may be cited as evidence, and executing it wastes budget. Reviewers check that every cited test carried this power estimate.
- **Scope-qualified confidence (mandatory)**: every confidence label on a *computed / implemented / discretized* result ("machine-precise", "converged", "verification-grade", "exact") must carry the scale/configuration at which it was established; an unqualified label next to a headline produced at a *different* configuration is a defect, not shorthand. For a purely *symbolic / continuum / analytic* claim the qualifier is the scope itself — label it "symbolic/continuum only" (no numerical scale needed), and never let that be read as covering a discretization/implementation.
- **Falsification gate, not agreement gate**: convergence requires, per precondition above, *the smallest test that could falsify it* plus evidence that test was actually run **at the production configuration**. Reviewer agreement on a derivation, or any check whose outcome was guaranteed before running it, does not substitute for executing the production-scale falsifiers.
- **A process-compliance violation quarantines evidence; it never destroys computation.** When a completed computation is found to have violated a process rule — a blindness/visibility breach, a wrong workspace mode, a missing pre-registration — the produced numbers are demoted to a **quarantined lead**: excluded from seals, promotions, acceptance comparisons, and convergence votes (default not-passing), and barred from steering the redo (a candidate-hidden rerun must not see them). The computation itself is preserved under the violation record. Once a compliant rerun or re-derivation completes independently, the quarantined values serve as a post-hoc cross-check — agreement corroborates, disagreement is a tracing target. Voiding paid-for computation outright buys no additional rigor: the violation is cured by the compliant redo, while the destroyed record could still have caught a defect in it.
- **Reference reproduction (mandatory whenever a recorded result claims to reproduce / match a published value)**: a claim that a result *reproduces / matches / agrees with* a published reference value is earned by **computing the claimed observable on a comparable state / regime / configuration and comparing to the published number numerically** — not by a qualitative "same scale / same sign" assertion and not by citing the source. Compare **term by term** where the claim is term-level (a net total can agree while individual contributions are suppressed or sign-flipped); an **order-of-magnitude same-direction discrepancy, or a sign reversal, is a finding, not convergence**. Independently: any established cross-validation must not **silently lapse** — a structurally *different-model* engine, or a check valid only in a degenerate / limit regime, is labeled as a different-model / limit-regime comparison, never presented as validation, and the absence of an apples-to-apples independent check is recorded as an explicit limitation. And when the claim is that the source's *own prescription* was solved, the transcription axis is additionally gated — a frame-map elementwise identity over the transcription plus an as-printed run of the source's prescription (`numerical-reliability-gate` **G2**'s shared-model-definition clause). Routed to `numerical-reliability-gate` **G8** and the `review-swarm` reference-reproduction reviewer; the failure modes are catalogued in `research-integrity` (*Reference-reproduction fidelity*).
- **Independent confirmation and reproduction (mandatory for load-bearing claims).** Independent confirmation requires at least two evidence lanes independently constructed or derived and executed from a neutral question and raw inputs. Record method diversity, model-family diversity, execution independence and input independence separately. Same or similar methods, the same algorithm name, matching hashes or shared legitimate libraries do not by themselves disqualify a lane. Agent names, seeds, reworded prompts, copied answers and simple reruns of the original implementation do not establish independence. Different methods with contaminated input framing still fail. A fresh assessor must substantively inspect the actual steps, method preconditions, known defects and diagnostic power with exact source spans and reasons; a self-filled no-defect checkbox is insufficient. Missing, rejected, stale or non-diagnostic evidence does not count. Keep an explicit project-specific different-method risk requirement when that requirement tests a known shared failure mode. In full_access mode, the reproduction gate and final convergence consumer must themselves observe a fresh successful source-assessor call (`--assessor-model MODEL`); imported assessor JSON cannot grant current execution authority. Complete command-input closure includes local Python relative imports; unresolved dynamic imports are unavailable. Configure additional method-risk conditions with `independent_reproduction.requires_method_diversity` and `method_diversity_risk`.
- **Reproduction independence (mandatory for full-access confirmation).** `SHARED_KERNEL_INHERITANCE`
  identifies a shared project-computation risk, not independent confirmation. A declared kernel under
  test cannot supply its own independent reproduction. A legitimate shared library still requires a
  fresh source-grounded risk disposition using both members' own constructed computation sources;
  copied sources or reruns do not count. When checks disagree, trace the first divergence through the
  original equations, inputs and computations; never settle a disagreement by majority vote.
- **Re-reading is not recomputation (mandatory for load-bearing structural claims).** Re-reading claimant-selected evidence is an argument audit, not a verification; it can preserve the claimant's blind spot when the supplied evidence probes the wrong axis. Use the `review-swarm` independent-recomputation reviewer with only the problem statement and raw inputs, never the claimant's answer, evidence selection, or initial judgment. Require actual independently constructed and executed checks, and record which axis the recomputation actually probed. Same or similar sound methods may count under the independent-confirmation conditions above; an explicit shared-failure risk can additionally require a different mechanism.
- **Source-grounded reproduction consumer.** In enabled `full_access` cycles, `assess_independent_reproduction.py` runs a fresh source assessor through the existing launcher, once, to inspect the exact member source/evidence closure. `check_independent_reproduction.py` binds that assessment to current SHA-256 inputs and requires two assessed independent evidence lanes; shared-source identity is a risk locator, while declared tested-kernel call-through remains rejected. `check_team_convergence.py` rechecks that gate before convergence and carries `independent_confirmations` and `confirmation_refs` into its durable receipt. A nonempty Independent Derivation section is not that evidence. Failed or missing assessor output remains unavailable. The default assessor is `claude/opus`; `INDEPENDENCE_ASSESSOR_SPEC` selects an available configured model, without granting independence merely by family.
- **Prior-art binding (mandatory when a delegation brief names prior art)**: when the dispatch brief for the work under review named prior art — an upstream toolkit routine, a sibling project's implementation of the same end-to-end problem, a published method — the reviewer verifies that, for each named asset, the implementation's call sites or the approved pre-implementation deviation record exist **before** assessing results (see *Reuse-or-deviate gate* below); an implementation carrying neither does not converge.
- **Pointer lint (mandatory)**: code pointers in the notebook must be resolvable under the configured `pointer_lint.strategy`.
- **No unrecorded retries — but two distinct retry regimes**: when a gate fails, stop, apply the minimal fix, and record the retry. Which regime applies depends on what failed:
  - **Development iteration stays inside one run.** Deterministic-gate failures, build errors, and diagnostic runs are fixed and re-tried within the same run/tag (`--preflight-only` reruns deterministic gates at zero reviewer cost; log the attempts in the run dir). Minting a fresh tag, contract, and packet for every such fix is the recorded anti-pattern that multiplies run directories without adding verification.
  - **A new cycle tag (`M2-r2`, `M2-r3`, ...) marks re-entry into the reviewed convergence cycle** — a new candidate going back to the members — not each intermediate fix that produced it. Batch every known blocking fix into the next candidate rather than cycling one finding at a time.
  - **Bounded rounds**: cap reviewed rounds per tag family (config `bounded_rounds.max_per_tag_family`, default 5; machine-enforced at preflight). Hitting the cap forces the narrowing rule — narrow the candidate's scope, reduce the claim's strength, explicitly classify as `SCOPE`/`MATCHING`, or take the blocking question to the project owner — instead of another full round; a narrowed candidate continues under a new base tag.
- **Run artifact identity**: the canonical project artifact root for
  lifecycle and compute runs is `artifacts/runs/<run_id>/`. Use a safe,
  sortable, readable `run_id`, preferably
  `<YYYYMMDD>-<milestone>-r<NNN>-<slug>[-rK]` (date + milestone + a
  milestone-global ordinal + a short topic slug; the optional trailing `-rK`
  is the reviewed-round suffix). The exact time of day does not belong in the
  directory name — machine truth (precise timestamp, commit, dirty state)
  lives in the run's origin stamp, and sub-day precision in names measured as
  unreliable in practice. The older
  `<YYYYMMDDTHHMMSSZ>-<milestone>-<short-topic>-rN` shape stays valid for
  existing runs. Team and draft payloads live in `artifacts/runs/<tag>/research_team/`;
  the tag is the same parent run identity. Packets, checkpoints, reports and
  logs are executor evidence; the parent run holds the origin stamp.
- **Stamp the run at creation (mandatory where the project has a nullius
  launcher)**: immediately after creating `artifacts/runs/<run_id>/`, run
  `nullius trace stamp <run_id>` from the project root. The stamp binds the
  run to the exact code state that will produce its results (commit, snapshot
  of uncommitted tracked edits, untracked-file caveats) — recorded at run
  time, when the binding is exact, instead of reconstructed later, when it
  can only be a heuristic alignment. A run created without a stamp stays
  usable but its origin degrades to timeline guesswork; treat a missing
  stamp on a result-bearing run as a review finding.
- **Tag relation**: with `--auto-tag`, pass a meaningful base tag such as
  `20260502T023000Z-m3-branch-scan`; the resolved `<base>-rN` is the
  research-team cycle tag and may be used as the control-plane `run_id` for
  that reviewed cycle. Do not use bare UUIDs or `run_<uuid>` as human-facing
  research tags.

For member construction in `full_access`, use the audited `files_written` request channel with `path`, complete UTF-8 `content` and `purpose`, followed by literal commands to execute the member’s program. Writes are restricted to that member’s `independent/` prefix and bound through `original_transport.construction_refs` to the raw original model output, complete source bytes, SHA-256 and byte size. Identical bytes may be reused with `created=false`; differing originals are never overwritten. Every own-prefix code source must match a whole original model-emitted source string, including nested JSON or a complete fenced body. A generic I/O carrier may preserve that origin; preseeded code, substring matches and examiner booleans cannot substitute for it. Shared legitimate libraries outside the construction prefix remain assessment inputs. See [member invocation evidence](references/member_transport.md).

Select neutral reproduction input with the team-cycle `--reproduction-packet` option or `independent_reproduction.blind_packet` configuration. The selected route becomes the member writer’s ordinary `--packet` input. A route name does not prove blindness: the source assessor must examine the complete original packet, every actual read, command input and final-stage input for prior answers or author judgments.

## Verification granularity: the reviewed unit is a milestone candidate

The full lifecycle — frozen inputs, member review pair, convergence gate, adjudication — reviews **one milestone candidate**: a stable interface version or a scientific result. It does not review each patch, refactor, fixture, or internal helper on the way there. Running the complete lifecycle per micro-patch is the documented failure mode this section exists to stop: it multiplies contracts, packets, review documents, and run directories by the patch count while adding no verification power, because the same checks re-run on nearly identical inputs.

Work toward a candidate moves through three phases:

1. **Bounded development.** The implementer iterates freely inside the delegation's time box: diagnostic runs, targeted tests, and build fixes are legitimate development work, not budgeted "attempts" (an attempt is a deliberate re-entry into the delivered task — see the `research-harness` attempt semantics). Contracting development down to zero diagnostic invocations or a single measured test execution applies frozen-acceptance discipline to the wrong phase; the acceptance-time single measured run belongs to the frozen candidate, not to the implementation work that produced it.
2. **Stabilization.** Merge every known blocking fix into one candidate, run the full local test surface once, and freeze the candidate's identity (input and code hashes). One stabilization pass per batch of findings — not one per finding.
3. **Acceptance.** The frozen candidate gets its review pair — the member cycle, plus the fresh-checkout independent reproduction check where the project has opted into one. Opt-in status covers only that fresh-checkout rerun: the production-scale falsifiers, method-precondition residuals, and independent recomputation that the non-negotiable contracts above require for load-bearing claims remain mandatory regardless. Findings are severity-graded per the strict-convergence contract above; the fix batch re-enters at stabilization and the confirmation round reviews the exact delta from the reviewed baseline unless an escalation trigger fires (changed formulas or assumptions, changed data model or global invariants, changed origin-traceability roots, or a reviewer requests the full artifact).

Whole-notebook content acceptance is an exception to delta-only confirmation:
`nullius notebook review` always covers the full current notebook and dependencies,
including when only one section changed. Its supporting semantic verdict does
not replace the milestone's independent derivation or numerical verification.

Placement rules complete the picture:

- **Independence spend follows the result, not the plumbing.** Host-native dual review at milestone scope is the default. Cross-model review, independent executing reproduction, and blind re-derivation are reserved for result-bearing surfaces: headline claims, public contracts, the derivations and numbers conclusions rest on. Internal writers, fixtures, launchers, and schema plumbing stabilize under local tests and the ordinary member cycle. A same-input, same-machine rerun of the identical frozen test is a recovery/reproduction check — it earns no independent-verification credit and should not be a standing per-round requirement.
- **Constructibility before refinement.** Before a design document or interface plan enters its
  **first** refinement review (not merely once the loop has become multi-round), run the cheapest
  probe that its **central object is actually constructible from the already-accepted inputs**, and
  make the probe auditable: persist (i) the constructibility proposition being tested, (ii) the
  identities (hashes) of the accepted inputs it draws on, (iii) the minimal witness produced —
  even a crude instance — and (iv) the pass criterion the witness met. A design refined through
  many review rounds and only then discovered to rest on an unconstructible object forfeits every
  one of those rounds; when the probe fails, dispatch the missing prerequisite work (a derivation,
  a data object, an upstream decision — whatever the probe named as absent) and park the design
  loop until it lands; entering a second review round with no recorded probe is the loop's own
  fail-closed refusal condition.
- **Reviews enumerate; they do not serialize.** A reviewer reports every finding it can establish in the round, severity-graded. Stopping at the first decisive counterexample turns an N-finding backlog into N full rounds; the existing leader early-stop (two CHALLENGED step verdicts) remains the only sanctioned early exit, because it abandons a doomed round rather than truncating a viable one.
- **Reviewer unavailability is a dispatch failure, not a review round.** When a reviewer seat cannot run — backend unavailable, credential or tooling failure, no verdict returned — the round did not happen: re-enter the **same** cycle tag with the runner's `--resume` path, or reroute that seat to a fallback runner/model. Resume reuses each seat whose prior output satisfies its mode's reuse predicate — a nonempty report, plus the nonempty evidence file for full-access seats — and re-dispatches every other seat; so when a failed seat left a partial or verdict-less report behind, move that file aside (never delete it) before resuming, or resume would skip the seat as "completed" on its garbage output (removing the report alone forces re-dispatch in every mode); the runner also performs a health-aware resume for verdict-bearing member seats — a nonempty report failing the verdict health check is moved aside automatically (never deleted) and the seat re-dispatches; sidecar consultations carry no verdict contract and reuse on nonemptiness, and the manual move-aside remains the fallback on older checkouts. An unavailability event never advances the round suffix and never consumes a bounded round (`bounded_rounds.max_per_tag_family`): the partially-completed run directory is the same round's record resumed in place, not a new round's packet, and an unavailability note is never a verdict record. Two consecutive unavailability events on the same seat are an environment blocker to surface to the project owner — not a license to keep opening new rounds against a dead seat, each paying full packet cost to record that nothing happened.
- **Stall detection: the stall clock counts scientific objects, not run types.** At every coordination moment, the coordinator asks when the last new scientific object landed — a new number, derivation, figure, code capability, or an explicitly decided narrowing — **anywhere in the project**: the clock ticks across every run root (the canonical lifecycle root, the reviewer-cycle root, and any project-specific run surface) and every run or round type together, and it resets only when such an object lands. Alternating derivation-labelled and review-labelled runs does not reset it, and migrating packet cycles into a different run root does not reset it — process artifacts (contracts, reviews, adjudications, re-hashes, re-frozen documents) are not progress wherever they are minted. Three consecutive runs or rounds without a new scientific object, counted across all roots together, is a stall, and **another round is not an allowed response to a stall**: the coordinator must consolidate (batch everything open into one stabilized candidate), narrow the scope, re-plan the decomposition, execute the already-prepared step when the prepared-execution-first rule below names one, or put the blocking question to the project owner. Review-round counters never appear as progress in the plan's status: progress is stated in terms of the scientific object that advanced, and a status whose "next step" is only another review of the same candidate is the stall signature to look for.
- **Prepared-execution-first closure.** When a milestone's closure is blocked on exactly one already-prepared execution — the comparison, analysis, or computation is implemented and self-tested but has never been run against its real target — the next dispatch is that execution, before any new derivation, review, or design lane opens. An unexecuted prepared step is the cheapest possible scientific advance in the plan, and every round spent around it reviews a state the execution would change. The only sanctioned deferral is a named blocking gate recorded in the plan that forbids the run; then resolving that gate is the only allowed next lane. Either way the plan's next-step row states the execution or the named gate — never another review of the unchanged candidate.

## Quick Start (3 commands)

> Commands below stay install-location-portable by resolving the skill via `SKILL_DIR`, with a host-neutral fallback that probes known agent skill homes (`~/.claude`, `~/.codex`, `~/.config/opencode`, `~/.kimi-code`). These paths are portable skill-discovery locations across different agent hosts, not a menu of host options — the same skill installs and runs under any of them.

1) Environment check (optional flags shown). The CLI runner backends (Codex / Claude / Gemini) are interchangeable options — pick whichever you have; `--require-codex` below is only one example, not a default or preferred backend:

```bash
SKILL_DIR="${SKILL_DIR:-$(for r in "${CLAUDE_CONFIG_DIR:-$HOME/.claude}" "${CODEX_HOME:-$HOME/.codex}" "$HOME/.config/opencode" "$HOME/.kimi-code"; do [ -d "$r/skills/research-team" ] && echo "$r/skills/research-team" && break; done || true)}"
# e.g. require an explicit Codex CLI runner:
bash "${SKILL_DIR}/scripts/bin/check_environment.sh" --require-codex
# or (if you explicitly want A=Claude, B=Gemini):
# bash "${SKILL_DIR}/scripts/bin/check_environment.sh" --require-claude --require-gemini
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
Use `--full` when you want those research-team host-local assets immediately; the default scaffold stays minimal.
The public scaffold and contract-refresh entrypoints now run in `real_project` mode: use an external project root, and keep real-project run/intermediate outputs outside the nullius development repo. Internal maintainer fixtures remain a lower-level contract mode only, not part of the public workflow.

3) Run a team cycle from the project root:

```bash
cd /path/to/project

SKILL_DIR="${SKILL_DIR:-$(for r in "${CLAUDE_CONFIG_DIR:-$HOME/.claude}" "${CODEX_HOME:-$HOME/.codex}" "$HOME/.config/opencode" "$HOME/.kimi-code"; do [ -d "$r/skills/research-team" ] && echo "$r/skills/research-team" && break; done || true)}"
bash "${SKILL_DIR}/scripts/bin/run_team_cycle.sh" \
  --tag 20260502T023000Z-m0-topic --auto-tag \
  --notes research_contract.md \
  --out-dir artifacts \
  --member-a-system prompts/_system_member_a.txt \
  --member-b-system prompts/_system_member_b.txt
```

Tip: add `--preflight-only` to run deterministic gates without calling external LLMs.
By default, Member A and Member B should be assigned through the current host agent's official subagent mechanism with config-derived reasoning depth. `run_team_cycle.sh` keeps CLI compatibility runners for shell-only environments; use `--member-a-runner-kind` / `--member-b-runner-kind` or `research_team_config.json` only when you explicitly want a provider-specific CLI runner.
`--out-dir` must resolve to the project's `artifacts` directory; unsupported
output overrides refuse before directory creation. Team and draft payloads
live in `artifacts/runs/<tag>/research_team/`. A present project-local launcher
must accept the parent origin stamp before cycle work; a missing launcher is
reported as unstamped. Conflicting origin never silently rebinds the run.

Read [`references/workspace-disk-policy.md`](references/workspace-disk-policy.md) when a team cycle leaves per-member workspaces on disk, disk space must be reclaimed, or an unattended loop needs a pruning schedule (the `Workspace disk policy` block, moved there verbatim).

## Capabilities index (discoverability)

- **Team cycle (core)**: `scripts/bin/run_team_cycle.sh` (preflight → A/B → convergence).
- **Draft (TeX) review cycle**: `scripts/bin/run_draft_cycle.sh` (TeX-source-first; optional 3-party convergence).
- **Autopilot**: `scripts/bin/run_autopilot.sh` (plan autofill + loop coordinator; uses `scripts/bin/autopilot_loop.py`).
- **Packet build only**: `scripts/bin/build_team_packet.py`, `scripts/bin/build_draft_packet.py`.
- **Literature fetch (INSPIRE/arXiv/Crossref/DataCite/DOI/GitHub)**: `scripts/bin/literature_fetch.py` (project-leader source-adapter helper for prework/KB building; reviewers must not use network).
  - Read [`references/capabilities-detail.md`](references/capabilities-detail.md) when running `literature_fetch.py` or maintaining the literature query and saturation records (the sub-bullets of the literature-fetch entry, moved there verbatim).
- **Derive the contract's notebook-sync block**: `scripts/bin/refresh_research_contract.py --root /path/to/project`. It writes the derived block to `artifacts/research_contract_block.proposed.md` and **does not modify `research_contract.md` at all** — merge what is right into the contract's sync block by hand.
  - Read [`references/capabilities-detail.md`](references/capabilities-detail.md) when running `refresh_research_contract.py` or reasoning about the derived notebook-sync block (the sub-bullets of the contract-block entry, moved there verbatim).
- **Export a portable bundle**: `scripts/bin/export_paper_bundle.sh` (wrapper) / `scripts/bin/export_paper_bundle.py`.
- **KB index export (deterministic/L1)**: `scripts/bin/kb_export.py` + `scripts/bin/validate_kb_index.py` + `scripts/schemas/kb_index.schema.json`.
- **Demo generation**: `scripts/bin/generate_demo_milestone.sh`.
- **Project kickstart prompt**: `scripts/bin/generate_project_start_prompt.py`.
- **Deterministic hygiene tools** (as needed): `scripts/bin/fix_markdown_*`, `scripts/bin/fix_bibtex_revtex4_2.py`, `scripts/bin/upgrade_reference_anchors.py`; use the standalone `markdown-hygiene` skill for manual Markdown math/TOC cleanup outside a team-cycle preflight.
- **Claim DAG & evidence** (optional): render via `nullius graph --kind claims` (the domain-neutral `@nullius/shared/graph-viz` front door; auto-rendered best-effort to `knowledge_graph/` at convergence when an `nullius` CLI is reachable) + gates under `scripts/gates/`.
- **Roadmap dependency-map (plan-summary / milestone-handoff)**: `assets/roadmap_dependency_map_template.md` + `nullius graph --kind roadmap` (a *planning* view of milestones/lanes; complements — does not replace — the Claim DAG, see below).
- **Exploration stage debt helper**: `scripts/bin/exploration_debt_dashboard.py`.
- **Scaffold pruning (move/archive optional files)**: `scripts/bin/prune_optional_scaffold.py`.
- **Environment snapshot**: `scripts/bin/capture_env_snapshot.sh`.
- **Executor navigation and progress**: `scripts/bin/update_project_map.py`, `scripts/bin/update_research_plan_progress.py`, `scripts/bin/update_trajectory_index.py`.
- **Main research report promotion**: the canonical domain-neutral template
  and registry live in the `project-contracts` scaffold under
  `reports/main_research_report_template.md` and
  `project_index.md#Main research report`; validate promotion with
  `nullius report-validate`. This skill consumes that authority and does not
  carry a second template.
- Read [`references/capabilities-detail.md`](references/capabilities-detail.md) when looking for a secondary utility (autofill, tag helpers, claim gates, post-run helpers, diagnostics, adjudication, member review) (the secondary-utilities entry, moved there verbatim).

Read [`references/parallel-worktree-lanes.md`](references/parallel-worktree-lanes.md) when independent workstreams run as separate git worktrees or branches driven by separate agents (the section on judgment-point stops and merge authority, moved there verbatim).

## Delegation budgets and weight tiers: the record matches the risk

A delegated executing agent's default drift is to refine precision
indefinitely and to expand scope on its own initiative; a delegation without
explicit budgets is drift by construction. So every **full-tier** delegated
computation or verification workstream (a lane, a compute job, a
result-bearing verification pass handed to another agent — the tier rule
below decides) gets a **budget contract** written by the coordinator
**before dispatch** — one JSON file per delegation under
`team/delegations/`, from `assets/delegation_budget_contract_template.json`
(`delegation_budget_contract_v1`).

**Delegation weight tiers — the packet matches the risk, not the ritual.**
Not every dispatch pays the full pre-dispatch freeze. A delegation is
**full-tier** — this budget contract plus the freeze-then-hash input
discipline — exactly when it executes computation, produces a result a
durable claim will rest on, or depends on blindness / frozen inputs for its
evidential value. Every other dispatch — a read-only analysis, a review-only
reading pass, a consultation — is **light-tier**: it records one
append-only line in `team/delegations/LEDGER.md`
(date | delegation id | seat | one-line workstream | outcome reference)
and mints no contract file, no frozen packet, and no per-dispatch budget
gate. The boundary is risk-anchored, not effort-anchored: anything that
could change a recorded number or seal a claim is full-tier by definition,
and when in doubt, full tier. Review seats are already bounded by the
review-cycle machinery (bounded rounds, severity grading, adjudication
dispositions); wrapping a second frozen packet around a bounded review pays
full dispatch cost to duplicate an existing brake — the measured signature
of that duplication is a run ledger where packet files outnumber and outweigh
the scientific objects produced. With tiers in force,
`delegation_budget.required=true` on a milestone asserts that at least one
**full-tier** delegation is expected there; light-tier ledger lines never
satisfy it, and a milestone dispatching only light-tier work leaves it
unset.

Required field groups of the full-tier contract, all machine-checked:

- **`tolerance_ceiling`** — choose exactly one machine-checked stopping form,
  always with a one-line `anchor_note` stating which task requirement derives
  it (what the result is *for*, never what the method can achieve):
  - **Numeric** (backward-compatible default): omit `mode`, or set
    `mode: "numeric"`; provide a finite positive `value` and no `predicate`.
    Reaching that ceiling means **stop**. Numeric zero remains invalid.
  - **Exact predicate**: set `mode: "exact_predicate"`; provide a non-empty
    one-line `predicate` naming the exact equality / boolean condition that
    ends the task, and omit `value`. Use this for exact-only work that has no
    approximation tolerance; never fabricate a positive tolerance or encode
    exactness as numeric zero.
  The two forms are mutually exclusive. Unknown modes, missing or multiline
  predicates, and contracts carrying fields from both forms fail closed.
  This ceiling is the delegation-side form of the `numerical-reliability-gate`
  G0 required accuracy: derive it the same way, and an undelegated result-bearing
  number still owes G0 through that gate.
- **`time_box`** — a hard wall-clock budget for the workstream, sized the
  way the memory estimate is, in one of two machine-checked forms. A box
  sized by guess is the recorded way a complex task is killed before it can
  finish, and a budget death only teaches the real need one wasted run
  later. **Measured** (`basis: "measured"`, required when the contract
  declares `launches_full_scale_computation: true`): `unit_seconds` is the
  wall clock of a single-unit dry run made before the full launch, `units`
  is how many units the workstream runs, and `seconds` must be at least
  `unit_seconds × units` (leave margin above that floor; the gate refuses a
  box below it as `TIME_BOX_BELOW_MEASURED_NEED`). **Declared**
  (`basis: "declared"`): a short workstream that launches no full-scale
  computation gives a one-line `note` instead, together with the explicit
  top-level declaration `launches_full_scale_computation: false` (absent
  fails closed); the two forms are mutually exclusive. When the box expires while
  the run is still advancing (checkpoint rows still landing), the
  coordinator may extend it, as a contract amendment carrying `retry_of`
  with `exhausted_budget: "time_box_seconds"`, `kind:
  "advancing_extension"`, the projected need from the measured rate as
  `measured_requirement`, and the measurement as `progress`
  (`elapsed_seconds`, `completed_units`, `total_units`, an `earlier`
  observation showing the completed count grew, the `row` of each
  observation — 1-based physical line numbers in the `probe_log`, one
  observation per line, the earlier row immediately before the current one
  (`EXTENSION_ROWS_NOT_ADJACENT` otherwise) — and `previous_extension_row`,
  the current row the previous extension used, 0 for the first: both rows
  must come after it (`EXTENSION_OBSERVATIONS_NOT_FRESH`), so an extension
  cannot reuse the observations an earlier one already used). The projected need
  is the larger of the whole-run rate (elapsed × total ÷ completed) and the
  latest interval's rate (elapsed + remaining units × the time per unit
  between the two observations), so a run that slowed down is not cut short
  again. Every time-box re-budget names its kind and records its
  progress with work remaining; a run wrapped up at its deadline is
  re-dispatched with `kind: "rebudget_after_wrap_up"`. The gate recomputes
  the projection (`TIME_BOX_RETRY_BELOW_PROGRESS`), refuses an extension
  whose observations show no advance (`EXTENSION_NOT_ADVANCING`) or do not
  name the probe log and both rows in order
  (`MISSING_EXTENSION_PROBE_REFERENCE` — the gate does not open the log;
  a reviewer checks the rows against it) and applies
  the existing strict-exceedance check. What the gate cannot see: whether
  the two observations are the last checks before the deadline (the
  coordinator attests it; a reviewer confirms it from the probe log), and
  whether `previous_extension_row` is the row the previous extension really
  used (it reads one contract revision, so the value is the coordinator's
  record; it catches an extension that reuses old observations, not a false
  entry). There is no fixed number of extensions; a run that has stopped
  advancing is wrapped up instead.
- **`max_attempts`** — a cap on "one last attempt" retries; exhausting it
  means wrap up, not retry. Attempts count deliberate re-entries into the
  delivered task (the `research-harness` attempt semantics), **not**
  individual diagnostic invocations, build fixes, targeted test runs, or
  diagnostic-scale parameter tuning inside the time box — those are ordinary
  development iteration and are bounded by the time box alone. A full-scale
  relaunch of the delivered task with revised parameters is a deliberate
  re-entry and consumes an attempt. Choose a value in the 3–5 band by default;
  reserve `1` for genuinely one-shot frozen-acceptance executions, and never
  write a development-phase contract that forbids diagnostics outright.
- **`scope_negative_list`** — expansions the executor must **not** undertake
  on its own initiative (e.g. infrastructure rewrites, building a full test
  suite beyond the delegated checks, third-party benchmarking).
- **`peak_memory_estimate`** — sized to the workstream, in one of two
  machine-checked forms. When the workstream launches a computation whose
  scale could threaten memory (a long or production-scale job), the estimate
  is **measured**: peak resident-set size from a **single-unit dry run before
  the full launch**, plus the explicit heap cap the full run is launched with
  (estimating wall-clock alone is not a resource estimate). For a short,
  bounded workstream that launches no such computation (a quick verification
  pass, a symbolic or review-only task), a **declared cap** is the honest
  form: `mode: "declared_cap"` with the heap cap and a one-line `basis`
  stating why a dry-run measurement is not warranted. Measuring the RSS of an
  unrelated command to satisfy the field is exactly the empty formality the
  declared form exists to remove. The eligibility choice is an auditable
  declaration, never an unstated assumption: a declared-cap contract **must**
  carry `launches_full_scale_computation: false` at the top level (absent or
  null fails closed; `true` together with the declared-cap form is
  machine-rejected as contradictory). Measured-form contracts may carry the
  same field optionally.

Two further blocks are optional in shape but **mandatory in the named
situations**, and machine-checked whenever present:

- **`independence_requirement`** — mandatory whenever the acceptance
  criterion for the delegated work demands two or more independent routes /
  confirmations (blind re-derivations, independent recomputation). Declare
  `routes_required` (what acceptance needs), `routes_budgeted_here` (what
  this delegation's budget is sized for), `per_route_seconds_floor` (the
  declared minimum wall-clock one route needs), optionally
  `routes_execution` (`"sequential"` — the conservative default when absent
  — or `"concurrent"`; unknown values fail closed), and — exactly when
  `routes_budgeted_here < routes_required` — a one-line
  `remaining_routes_source` naming the delegation(s) or planned dispatch
  that covers the rest. The gate cross-checks **joint satisfiability**
  (`INDEPENDENCE_BUDGET_UNSATISFIABLE`): sequential routes stack their
  floors inside the time box, concurrent routes share the wall clock but
  the box must still fit one full per-route floor. This closes a
  self-defeating freeze pattern: an acceptance target requiring N
  independent routes frozen over a budget that admits fewer cannot converge
  **by construction** — the budget, not the science, dictates the "not
  converged" verdict, the inadmissible attempt contributes nothing, and the
  same work is re-dispatched to hit the same wall. Freeze the acceptance
  criterion and the budget that can satisfy it together, or do not freeze.
- **`retry_of`** — mandatory on any contract or amendment that re-dispatches
  work whose previous contract ended by budget exhaustion. Declare
  `supersedes` (the previous contract revision / delegation id),
  `exhausted_budget` (`time_box_seconds` | `max_attempts` | `heap_limit_mb`
  | `unit_ceiling` | `other`), `measured_requirement` (the **measured** need
  in that dimension — a finite positive number for time / heap in the same
  units; a number or one line otherwise), and a one-line `adjustment_note`
  deriving the new budget from the measurement (for exhausted attempts: what
  changed in the approach — more identical attempts is not an adjustment).
  The gate cross-checks (`RETRY_BUDGET_BELOW_MEASURED_NEED`) that the
  matching budget field — `time_box.seconds`, `heap_limit_mb`, or
  `max_attempts` — **strictly exceeds** a numeric `measured_requirement`,
  because a budget-boundary death measures a **censored lower bound**: the
  run was cut at the boundary with work remaining, the true need lies above
  the measured value, and equality is the exhausted number with a stamp on
  it. An attempts retry that keeps its cap because the *approach* changed
  states that change as a one-line `measured_requirement` instead of a
  number; dimensions without a matching contract field (`unit_ceiling`,
  `other`) validate shape only, with the old and new ceiling values named
  in `adjustment_note`. Re-dispatching after a budget death with an
  unchanged numeric budget is forbidden — with or without a recorded
  shortfall: **one measured re-budget decision,
  never a chain of identical exhaustions** — every boundary death whose
  partial output was discarded and whose successor got the same budget pays
  the full dispatch cost to learn nothing.

The check is fail-closed and machine-judged
(`scripts/gates/check_delegation_budget.py`, machine verdict
`delegation_budget_gate_result_v1`): a contract
missing any required field, still carrying an unfilled template placeholder,
or using an unknown contract version does **not** pass. `run_team_cycle.sh`
validates every contract present at preflight in every project stage (no
exploration downgrade); set `delegation_budget.required=true` in the team
config when a milestone dispatches **full-tier** delegated workstreams
(execution / claim-bearing results / blindness-dependent — the tier rule
above), so a run with no full-tier contract also fails
(`NO_CONTRACTS_FOUND`); a milestone dispatching only light-tier work leaves
the flag unset — its ledger lines are deliberately not contracts.

Directory hygiene keeps `required` meaningful: the configured delegations
directory (`delegation_budget.delegations_dir`, scanned non-recursively)
holds only the contracts of **active** delegations; when a delegation
completes, archive its contract with the run or review record it governed,
so a stale contract can never satisfy `required=true` in place of the
missing new one. And set `required=true` per milestone that actually
dispatches **full-tier** delegations (or pass `--require` when invoking the
gate script directly), not as a standing flag — a
standing `true` over a clean directory rejects every cycle of a milestone
that delegates nothing or delegates only light-tier work.

When a budget is exhausted, the workstream **wraps up from the atomic
results already flushed to disk — it never voids the batch** — and abandoned
approaches go into the failed-approaches ledger (`failed_approaches_v1`);
both semantics are specified in the `research-harness` skill's long-running
compute jobs contract, which is where a delegated long job's checkpointing,
deadline, and resume behavior live.

## Reuse-or-deviate gate: a brief that names prior art binds the implementation

Reuse instructions that live only in prose do not survive delegation: an
executor satisfies the acceptance gates, not the prose around them, and
rewriting from scratch is cheaper for an agent than understanding foreign
code — so the default failure mode is a silent pivot to bespoke code, with
an inapplicability justification written only afterwards by the same
invested party. When a delegation brief names prior art (an upstream
toolkit routine, a sibling project's implementation of the same
end-to-end problem, a published method), the named assets bind the
implementation. Before any implementation commit, the executor commits,
for each named asset, exactly one of:

- **call-site evidence** — file and line showing the named asset consumed
  by the implementation; or
- **a deviation record** — measured, code-level reasons the named asset's
  mathematical model does not apply here, plus the proposed replacement —
  then a **stop for coordinator approval before the replacement is
  written**.

An implementation commit carrying neither is rejected at review (the
*Prior-art binding* contract above). A deviation record first written
after the replacement already exists is post-hoc self-justification by an
invested party: it does not satisfy this gate, and none of the
replacement's results are folded in until an independent clean-room
review has examined the deviation claim.

**Architecture-first reuse scan.** The first deliverable of any reuse
scan is the architecture-level answer: for each named prior source, how
it solved the same end-to-end problem — named files, functions, methods —
and an adopt-or-reject verdict with measured reasons per source. A grep
for a routine name is not a reuse scan. `research-integrity` M8 carries
the matching pre-computation trigger.

Read [`references/roadmap-and-report-promotion.md`](references/roadmap-and-report-promotion.md) when producing a plan-summary or milestone-handoff roadmap dependency-map, or promoting a converged milestone into the main research report (the roadmap dependency-map and main-report-promotion sections, moved there verbatim).

## Deep dive (read only when needed)

- Full manual (English): `references/usage_guide.md`
- Chinese manual (human-oriented): `references/usage_guide.zh.md`
- KB index exporter (English): `references/kb_index.md`
- Troubleshooting / rerun recipes: `RUNBOOK.md`
- Gate contract notes: `FULL_VALIDATION_CONTRACT.md`
- Artifact contract: `references/artifact_contract.md`

Read [`references/run-layout.md`](references/run-layout.md) when locating run payloads or historical run evidence, working with the project index and run index, or checking what the source-assessor packet embeds (the closing run-layout paragraphs, moved there verbatim).
