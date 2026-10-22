---
name: research-integrity
description: AI failure-mode checklist (M1-M8) for research agents. Generic across domains. Walk M1-M7 at the moments work becomes durable — you just finished a derivation or computation and are about to write conclusions, fold a number or claim into the plan or contract, check off a task-board item, make a milestone closeout commit, hand off, assemble submission material, or claim a result is final — and, in projects using the engine's approval flow, before requesting an A1-A5 approval gate. Walk M8 before starting each heavy or production computation or hand-building a reusable computational method. M2 (hallucinated_citation) also fires at write time for any durable text that carries a citation or an attribution sentence — notes, lecture material, reading lists, notebooks, overviews — not only at project lifecycle events.
---

# Research Integrity (M1-M8)

This skill is a **prompt-level discipline**, not an MCP server or a CLI.
It is the agent's own pre-flight checklist for catching eight recurring
AI research failure modes before a computation begins, before the work
crosses an approval boundary, or before it gets folded into durable
project artifacts.

The skill does not replace the machine-enforced gates that already live
in the control plane (`nullius` A1–A5 approval gates,
`HARNESS_INVOCATION_REQUIRED` anchor gate, `quality_compile`,
`quality_originality`, and convergence gates). It is the agent-side
check that runs **before** those gates fire — so the gate hearing is
fair and the durable record actually reflects work that was done.

## When to use

Run M1–M7 immediately before any of these moments. These are observable
file events — none of them requires the engine's approval flow to be
active, so a project that never calls `nullius approve` still hits
every trigger below:

- Folding a new number, claim, or result into
  `research_plan.md#Current Status` or the `research_contract.md`
  claims table.
- Checking off a task-board item whose output later work will build
  on — the item that makes a claim, interface, or result durable, not
  each sub-step or remediation retry inside it; sub-steps inherit the
  walk owed at their parent boundary, and a walk already recorded for
  a boundary is not re-owed for intermediate patches that create no
  new durable claim.
- A milestone closeout commit.
- Promoting or superseding the current main research report.
- Marking a `research-team` cycle as converged, or acting on a
  convergence gate that reports the cycle converged.
- Assembling submission material, or handing off to another agent or
  human via the `research-harness` "Fold Results Back" step.
- Requesting `nullius final-conclusions` on a run.
- Posting a draft to `research-writer` or invoking a `referee-review`
  pass.
- Calling `nullius approve <approval_id>` for an A1, A2, A3, A4, or
  A5 gate, in projects that use the engine's approval flow.

M8 has a distinct trigger: run it **before starting each new heavy or
production computation, or hand-building a reusable numerical method,
solver, quadrature, or robust primitive**. Unlike M1–M7, this trigger fires
before the work, not at a durable boundary: re-scan the upstream toolkit
and every sibling or related project for a reusable implementation first.

You may run a smaller subset earlier (for example M2/M4 during a
literature pull, the **Extraction / transcription fidelity** check
when you transcribe a source into a deep-read / extraction note, or the
**Reference-reproduction fidelity** check when a result starts claiming
to match a published value) and a fuller pass at the boundary. The
M1–M7 boundary pass is non-optional. M8 is separately non-optional
whenever its pre-computation trigger fires.

## Boundary walk and focused reading

At every M1–M7 boundary, judge **each** mode for applicability; read and perform every applicable mode's minimum disconfirming checks before crossing. If applicability is unclear, read that mode rather than skipping it. The table routes the walk; it does not replace the checks or turn mandatory gates into optional advice.

| Mode | Question that selects the detail | Required reference when applicable |
| --- | --- | --- |
| M1 implementation_bug_passing_self_review | Does code or an interface support the claim? Search for a counterexample to a load-bearing implementation assumption. | [m1-implementation.md](references/m1-implementation.md "nullius-guidance") |
| M2 hallucinated_citation | Does durable text cite or attribute work? Verify displayed citation identity and source support separately **at write time**. | [m2-citations.md](references/m2-citations.md "nullius-guidance") |
| M3 hallucinated_measurement_or_result | Does a cited number enter the result? Open its exact table/equation/figure and applicable canonical database. | [m3-numeric-sources.md](references/m3-numeric-sources.md "nullius-guidance") |
| M4 shortcut_reliance | Is a relationship, influence, priority or community claim made about literature? Check the appropriate citation graph. | [m4-literature-relations.md](references/m4-literature-relations.md "nullius-guidance") |
| M5 bug_as_insight | Is a computed feature being accepted as a result? Reproduce and perturb it; verify method-precondition residuals at the exact result configuration. | [m5-results-and-preconditions.md](references/m5-results-and-preconditions.md "nullius-guidance") |
| M6 methodology_fabrication | Does a method narrative claim a step executed? Bind each step to actual code/command and execution evidence. | [m6-method-evidence.md](references/m6-method-evidence.md "nullius-guidance") |
| M7 frame_lock | Is the conclusion still controlled by the original framing? Test the opposing or null framing. | [m7-framing.md](references/m7-framing.md "nullius-guidance") |
| M8 reinvention_over_available_reuse | Before each heavy/production computation or reusable-method build, inspect upstream and sibling implementations at architecture level. | [m8-reuse.md](references/m8-reuse.md "nullius-guidance") |

An active team cycle narrows only the M5 sweep/branch and M6 method-binding checks explicitly covered by its capsule. **M5b production-configuration precondition checks have no in-cycle exemption.** A smaller-scale pass, clean reproduction or convergence declaration cannot establish a production precondition.

- **Before recording, approving or closing a boundary**, read [boundary-recording.md](references/boundary-recording.md "nullius-guidance"). Record modes, actual disconfirming evidence and per-mode inapplicability reasons; consolidated wording is allowed. Failed checks stop the boundary, then only affected modes are re-walked after the fix. Keep narrative detail and the required machine receipt distinct; the current machine receipt accepts M1–M7 only, so record M8 in narrative. Approval-flow and conversational/file-mode decisions keep their specified receipts.
- **Before notebook closeout**, read [notebook-closeout.md](references/notebook-closeout.md "nullius-guidance"). Structural links and accepted current full-text content review are separate requirements. Missing, partial, unavailable, stale or capacity-unverified evidence does not pass. The M1–M7 self-check cannot issue its own content-review verdict, and semantic review does not establish scientific truth.
- **For scope, provider routing or overlap with other gates**, read [scope-and-integration.md](references/scope-and-integration.md "nullius-guidance") and [adjacent-skills-and-domain-routing.md](references/adjacent-skills-and-domain-routing.md "nullius-guidance"). This discipline is generic and supplements existing gates. Route evidence by the cited work and quantity, not by a tool package name; unsupported provider coverage is not a failed scientific check.

Read [`references/transcription-fidelity.md`](references/transcription-fidelity.md) when you transcribe a source into a deep-read or extraction note, restate a source's equations, values or conventions, or review such a note (the `Extraction / transcription fidelity` section and its failure checklist, moved there verbatim).

Read [`references/numerical-claim-checks.md`](references/numerical-claim-checks.md) when a result starts claiming to match a published value, an upstream fix changes results already recorded, a claim is defended as validated, or a heuristic fast path is accepted (the `Reference-reproduction fidelity`, `Post-correction impact accounting`, `Validation-chain validity` and `Accelerated / heuristic fast-path honesty` sections, moved there verbatim).
