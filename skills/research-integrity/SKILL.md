---
name: research-integrity
description: Pre-approval AI failure-mode checklist (M1-M7) for research agents. Generic across domains. Walk this before requesting an A1-A5 approval gate, before folding a result into durable project artifacts, before handoff, and before claiming a result is final.
---

# Research Integrity (M1-M7)

This skill is a **prompt-level discipline**, not an MCP server or a CLI.
It is the agent's own pre-flight checklist for catching seven recurring
AI research failure modes before the work crosses an approval boundary
or gets folded into durable project artifacts.

The skill does not replace the machine-enforced gates that already live
in the control plane (`autoresearch` A1–A5 approval gates,
`HARNESS_INVOCATION_REQUIRED` anchor gate, `quality_compile`,
`quality_originality`, and convergence gates). It is the agent-side
check that runs **before** those gates fire — so the gate hearing is
fair and the durable record actually reflects work that was done.

## When to use

Run M1–M7 immediately before any of:

- Calling `autoresearch approve <approval_id>` for an A1, A2, A3, A4, or
  A5 gate.
- Folding a result into `research_contract.md` or
  `research_plan.md#Current Status`.
- Handing off to another agent or human via the `research-harness`
  "Fold Results Back" step.
- Marking a `research-team` cycle as converged.
- Requesting `autoresearch final-conclusions` on a run.
- Posting a draft to `research-writer` or invoking a `referee-review`
  pass.

You may run a smaller subset earlier (for example M2/M4 during a
literature pull) and a fuller pass at the boundary. The boundary pass
is non-optional.

## What this skill is NOT

- Not a substitute for the citation and reference graph verification
  that provider MCP tools perform (`inspire_*`, `openalex_*`,
  `arxiv_*`, `pdg_*`, `hepdata_*`). Those are the **evidence** tools;
  this is the **discipline** that decides which evidence calls are
  required per boundary crossing and verifies they were made.
- Not a re-implementation of any provider tool. When a mode below
  lists tool names under "Required evidence calls", those names point
  at existing MCP capabilities; the skill does not duplicate their
  logic, it only mandates when to call them.
- Not a structured artifact. There is no `integrity_report.json` schema.
  The check result is recorded inline in the response or notebook entry
  next to the boundary-crossing action.
- Not domain-specific. Each mode is genuinely domain-neutral. Resolver
  and graph tools are routed **by discipline of the cited work**, not
  by which MCP package they live in. The package name is not a domain
  label — for example, `inspire_validate_bibliography` lives in
  `hep-mcp` but its default mode audits *non-INSPIRE* entries, and
  `inspire_resolve_citekey` takes an INSPIRE `recid` (not a citekey
  string) and only resolves entries already in INSPIRE-HEP. Always
  consult the tool's actual schema and handler before reasoning about
  its scope.
- Not a replacement for human review. It is a stricter version of the
  agent's own self-review that biases toward finding the failure mode
  rather than confirming the work is fine.

## The seven modes

### M1: implementation_bug_passing_self_review

**Definition.** A coding error that the agent reviewed and judged
clean, because the review used the same broken mental model as the
implementation. The bug is invisible to the author and visible to a
fresh reader.

**Signs.**
- "Self-review: looks correct." with no specific counter-hypothesis
  attempted.
- Tests pass, but were written by the same agent that wrote the bug.
- Recent diff deleted code that "looked unused," and the symptom
  appeared after.
- The agent's mental model of the function and the code's actual
  behavior have not been independently re-derived.

**Minimum disconfirming check.** Pick one load-bearing assumption made
in the code (e.g. "this branch is only reached when X is set", "this
loop iterates over already-deduplicated entries") and search the
codebase for a counterexample. If you cannot construct one, that itself
is a signal worth flagging in the response.

**Tools that help.**
- `git diff` against the prior known-good commit — sometimes the bug
  is the recent deletion.
- A fresh subagent or peer model running an adversarial review of the
  diff in isolation.
- Call-graph tracing — grep for call sites, or a code-intelligence tool
  if one is available — to surface invariants you may have forgotten existed.
- `pnpm -r build` and the targeted package's `vitest` / `pytest` —
  type-checking and tests catch a subset of M1, but they do not
  substitute for the disconfirming check.

### M2: hallucinated_citation

**Definition.** A citation made without verifying that the paper
exists with the cited identifier, by the cited authors, in the cited
venue, in the cited year, with the cited claim.

**Signs.**
- Citation key looks like a templated `{Authors}{Year}{Topic}` slug
  but no resolver call appears in the transcript.
- "I'm pretty sure paper X says Y" with no provider lookup backing it.
- Citation count, h-index, review status, or seminal-paper claim with
  no provider tool call.
- Bibliography assembled from web-search snippets alone, never
  cross-checked against a bibliography auditor.
- A BibTeX entry like `Vaswani2017Attention` or `Smith:2023abc` is
  accepted as proof the paper exists, with no DOI, arXiv ID, or
  provider-graph resolution actually performed.

**Minimum disconfirming check.** Route by the **discipline of the
cited work**, not by tool name:

1. **Find the paper.** Use the resolver whose underlying data covers
   the cited work's discipline. If you do not know the discipline,
   prefer the broadest provider first.
   - Any DOI →  `openalex_get(id="<doi>")` (cross-domain;
     OpenAlex indexes ~240M works including HEP, ML, condensed
     matter, biomedicine, etc.).
   - Any arXiv ID → `arxiv_get_metadata` or `arxiv_search` (every
     arXiv category; not HEP-only).
   - HEP paper without DOI/arXiv → `inspire_search`
     (INSPIRE-HEP database; HEP-bound by data).
   - Other discipline (ML / cond-mat / biomed / etc.) without
     DOI/arXiv → `openalex_search` by title+author.
   - Anything still missing → `crossref` skill as cross-domain
     fallback (non-arXiv non-OpenAlex).

2. **Verify the cited claim against the paper itself**, not its
   abstract or third-party summary.
   - Any arXiv preprint (any field) → `arxiv_paper_source`.
   - HEP paper that you want INSPIRE/DOI URL enrichment for →
     `inspire_paper_source` (handler internally resolves to arXiv,
     so it also works for any arXiv-resolvable identifier; the
     extra value over `arxiv_paper_source` is INSPIRE-side
     metadata enrichment).
   - Anything else (non-arXiv) → `openalex_get` content payload,
     or `pdf-mcp` parser on the downloaded PDF.

3. **HEP-only optional finishing step.** Once the paper is confirmed
   in INSPIRE and you have an INSPIRE `recid`, you may call
   `inspire_resolve_citekey({recid})` to get the canonical INSPIRE
   Texkey and BibTeX. **This tool takes a `recid`, not a citekey
   string**; it does not verify that an existing bibtex key is real.
   It is irrelevant for non-HEP citations because non-HEP papers are
   not in INSPIRE. There is no inverse `citekey → recid` lookup tool
   either; if you only hold a BibTeX key, extract a DOI / arXiv ID
   from the citation context and resolve via step 1, or use
   `inspire_search` with `texkeys:<key>`.

4. **Bulk bibliography hygiene.** Use
   `inspire_validate_bibliography` — despite the name, its default
   mode (`scope='manual_only'`, `validate_against_inspire=false`)
   audits *non-INSPIRE* entries for **locatability** only: each
   entry must carry a DOI, an arXiv ID, or a complete
   journal+volume+pages tuple, otherwise the tool emits a
   `missing_locator` warning. It does **not** check BibTeX syntax
   or author plausibility — pair it with a separate BibTeX
   linter if you need those. INSPIRE cross-validation is an
   optional opt-in mode (`validate_against_inspire=true`). Apply
   the default locatability audit to bibliographies of any
   discipline.

**Required evidence calls.** At least one resolver per cited paper
(routed as above), and at least one content-verify call per cited
*claim* (not per paper — a single paper can support many claims, but
each claim's textual ground must be opened).

**INSPIRE Texkey is INSPIRE-specific.** An entry like `Smith:2023abc`
is the canonical citekey convention inside INSPIRE-HEP. BibTeX entries
for non-HEP papers do not use this convention and cannot be resolved
through INSPIRE; do not treat a missing INSPIRE record as evidence the
citation is fake when the cited work is outside HEP.

### M3: hallucinated_measurement_or_result

**Definition.** A numerical value — particle mass, branching fraction,
cross section, fit parameter, benchmark accuracy, sample size,
p-value, simulation parameter — cited without verifying it against
the cited source's actual table, equation, or figure.

**Signs.**
- Value looks "about right" from memory; uncertainty is absent or
  stated with the wrong number of significant digits.
- A cited measurement does not name the specific table, equation, or
  figure it came from in the source.
- The cited work has a canonical reference database for this kind of
  quantity but no call to that database appears in the transcript
  (HEP particle property → no `pdg_*` call; HEP experiment data point
  → no `hepdata_*` call; ML benchmark accuracy → no version-pinned
  dataset reference + metric definition lookup).
- Two papers' results are compared in prose but never aligned through
  a measurement-conflict check.

**Minimum disconfirming check.** The general rule is **domain-neutral**:
for each cited numeric value, open the specific table, equation, or
figure in the source and quote the value plus its uncertainty exactly.
The *additional* check depends on whether the cited work's discipline
has a canonical reference database:

- **HEP particle properties** (mass, lifetime, branching fraction,
  decay width, etc.) → verify against the current PDG record via
  `pdg_get` / `pdg_get_measurements` / `pdg_get_property`, and
  record the PDG year/edition that was checked.
- **HEP experiment data points** (cross sections, asymmetries, etc.
  with HEPData submissions) → fetch the table via `hepdata_get_table`
  and confirm the cited number matches the entry exactly.
- **ML / DL benchmark results** → verify against the cited paper's
  specific dataset version, metric definition, evaluation split, and
  hyperparameter table. There is no centralized canonical reference;
  the paper's own §experiments / §results section *is* the canonical
  source.
- **Astrophysics / cosmology observations** → verify against the
  cited survey release version (e.g. DR-N), the calibration pipeline
  version, and the specific catalogue table — the survey
  documentation, not a third-party summary, is the canonical source.
- **Condensed-matter / chemistry / biology / etc.** → trace to the
  paper's specific table or figure; if a community database exists
  (PDB, ICSD, etc.) verify against it. Treat third-party reviews as
  candidates, not authority.

**Cross-paper tension detection.** When two HEP papers' results are
compared, `inspire_detect_measurement_conflicts` and
`hep_project_compare_measurements` are the HEP-specific tools. For
non-HEP comparisons the discipline check is the same general rule:
align units, methodology, and uncertainty conventions before claiming
agreement or tension.

**Required evidence calls.** For each cited numeric value: the
content-fetch call appropriate to the paper's discipline (see M2),
plus the canonical-database call if one applies to that quantity's
class. PDG / HEPData calls are *only* required when the quantity is
in their scope; not having one for an ML benchmark is correct, not a
gap.

### M4: shortcut_reliance

**Definition.** A relationship claim about papers — "X cites Y", "Y is
a review of Z", "this is the seminal paper on Q", "field W mostly
disagrees with claim V" — made without consulting the citation or
reference graph.

**Signs.**
- "Most papers in this area cite X." with no citation-graph call.
- "Y is the standard reference." with no review-classification call.
- "Z built directly on W's work." with no chronological +
  citation-edge check.
- "These two communities cite each other heavily." with no
  network-analysis call.

**Minimum disconfirming check.** For each relationship claim, trace
the edge in the citation graph. Web-search snippets are candidates,
not authorities; they may be derivative summaries of derivative
summaries. The graph itself is the authority. Route graph queries by
the **discipline of the papers in the relationship**, not by tool
name. As in M2, prefer the broadest provider first and fall back to
a discipline-specific graph only when it adds something the broad
provider cannot:

- **Cross-domain default graph** → OpenAlex. Use
  `openalex_citations` / `openalex_references` for direct edges and
  `openalex_search` + `openalex_filter` for typed queries. This is
  the right starting point for non-HEP literature (ML, biomed,
  cond-mat, math, social science, etc.) and is also a usable
  fallback for HEP papers indexed in OpenAlex.

- **HEP-specialised graph** → INSPIRE. When both endpoints of the
  relationship are HEP papers (e.g. `hep-ph`, `hep-th`, `hep-ex`,
  `hep-lat`, lattice QCD, HEP collaborations, phenomenology), the
  INSPIRE citation graph is denser and carries HEP-specific
  metadata that OpenAlex lacks. Use
  `inspire_literature(mode=get_citations)` /
  `(mode=get_references)`, `inspire_find_connections`,
  `inspire_network_analysis`, `inspire_classify_reviews`,
  `inspire_analyze_citation_stance`. `inspire_classify_reviews`
  operates on INSPIRE-resident papers; treat its judgments as
  authoritative only for relationships fully inside HEP.

- **Cross-discipline relationship** (HEP paper cited by an ML
  paper, biomed paper using statistical methods from physics, etc.)
  → query both graphs and reconcile. `inspire_find_crossover_topics`
  is useful when the *HEP side* of the crossover is the focus; for
  the reverse direction (non-HEP discipline finding HEP-adjacent
  work) OpenAlex network queries are typically more complete.

**Required evidence calls.** At least one citation-graph call per
relationship claim, routed to the appropriate graph by the
discipline rule above. A graph call to the wrong provider (e.g.
asking INSPIRE about a NeurIPS ML paper that is not in INSPIRE) is
not a check — it is a guaranteed miss.

### M5: bug_as_insight

**In-cycle exemption.** If you are inside an active `research-team`
cycle and the Reproducibility Capsule (specifically section
"G) Sweep semantics / parameter dependence") has been filled and
the convergence gate has accepted this milestone, the per-boundary
M5 walk reduces to: *verify the capsule's G/H sections are filled
and validated for this milestone, and verify the cited finding falls
under the capsule's declared sweep / branch coverage*. Do not
duplicate the perturbation work the capsule already locked in. If
you are *not* in a research-team cycle, or the capsule does not
cover the cited observable, perform the full check below.
**This exemption covers ONLY sweep/branch coverage (§G/§H); it does
NOT cover method-validity preconditions.** M5b below is performed in
full **regardless of the cycle** and is **never** discharged by a
gate pass alone: the capsule's §J records the precondition residual,
but M5b independently confirms it was actually measured at the
PRODUCTION configuration (a concrete residual + command/artifact +
matching config), not self-asserted. (Never let an exemption defer to
a gate that may not have run the check at the production scale.)

**Definition.** Treating an artifact of a code bug, numerical
instability, plotting mistake, or unit error as a genuine scientific
result. The agent reports the artifact as the finding instead of
investigating its source.

**Signs.**
- Unexpected feature in output and the response says "this is
  interesting" without first ruling out a code-side cause.
- Effect disappears or reverses sign when a parameter unrelated to
  the physics is changed (random seed, batch size, numerical
  tolerance, mesh resolution, integration order).
- Effect cannot be reproduced from a clean checkout with the
  recorded seeds and config.
- The "finding" coincides with a recent code change that touched the
  observable.

**Minimum disconfirming check.** Reproduce the alleged finding from a
clean checkout under the same seeds and parameters recorded in
`artifacts/runs/<run_id>/`. If reproducible, perturb one numerical
knob (tolerance, precision, mesh size, integration order, sample
size, domain size / number of sites / grid parity / periodic-wrap
regime) and verify the effect persists in the expected direction. If
the effect comes and goes, the code is the first hypothesis to
investigate.

**M5b: precondition_as_validity (no in-cycle exemption).** If the
result comes from a method whose validity rests on a structural
property of the operator/method — an operator commuting with a
projector/symmetrizer, Hermiticity, self-adjointness, idempotency,
unitarity, a variational/Galerkin subspace being invariant under the
operator — you MUST evaluate that property's disconfirming residual
**at the exact scale/configuration that produced the headline
number**, regardless of the in-cycle exemption and regardless of how
clean the reproduction is. A precondition-violating result is
perfectly reproducible from a clean checkout and survives
knob-perturbation, so the M5 reproduce-and-perturb check passes it;
only the precondition residual *at the production scale* exposes it.
For a projected/effective eigenvalue report the true-operator
residual `‖Oψ − λψ‖/‖Oψ‖`, not merely that ψ has the assumed
symmetry. A precondition verified only at a smaller/cheaper scale
than the result is NOT verified.

**Tools that help.**
- `autoresearch run` with explicit `run_id` for reproducibility.
- `research-team` Reproducibility Capsule (mandatory section of
  `research_contract.md`).
- `hep-calc` skill for symbolic re-derivation when an analytic
  cross-check is available.
- `git bisect` when the symptom postdates a known-clean reference
  point.

### M6: methodology_fabrication

**In-cycle exemption.** If you are inside an active `research-team`
cycle and the Reproducibility Capsule has bound this milestone's
method steps to artifact pointers under `artifacts/runs/<run_id>/`
(the capsule mandate), the per-boundary M6 walk reduces to:
*verify the capsule's method-to-artifact bindings cover the
boundary-crossing claim*. Do not re-trace bindings the capsule
already locked in. If you are outside a research-team cycle or the
claim crosses a method step that is not in the capsule's binding
list, perform the full check below.

**Definition.** Describing an experimental protocol, derivation, or
training procedure that did not actually run in the form described.
The method section reads cleanly but the code, configs, or run
artifacts do not back it.

**Signs.**
- "We used X-method with Y-cutoff" but no committed file imports
  X-method or sets Y-cutoff.
- Hyperparameter list is plausible but no run artifact records those
  exact values.
- Method step is described in `research_notebook.md` but no
  `artifacts/runs/<run_id>/` entry shows it.
- Two methodology versions exist in the project history and the
  drafted text describes the merged one that never actually executed.

**Minimum disconfirming check.** For each methodology step in the
work crossing the boundary, produce the exact code path or command,
plus the run artifact under `artifacts/runs/<run_id>/` that records
its execution. If the step is not in the artifact, it did not happen.

**Tools that help.** `autoresearch run` with explicit `run_id`,
the `artifacts/runs/<run_id>/` manifest, `research-team`
Reproducibility Capsule, `hep_export_paper_scaffold` for evidence
binding between manuscript claims and run artifacts.

### M7: frame_lock

**Definition.** Continuing to interpret a result through the initial
framing of the question even after evidence has accumulated that
would fit a different framing better. The agent's reasoning never
crosses the framing boundary; new findings are made to fit the
existing story.

**Signs.**
- Every new finding "confirms" the original hypothesis.
- Anomalies described as noise without testing the alternative they
  would support.
- The agent's wording mirrors the original prompt's wording too
  closely; no reformulation has occurred.
- A result that contradicts the framing is described as a "minor
  caveat" rather than as a load-bearing observation.

**Minimum disconfirming check.** State the result one more time using
the *opposing* framing — switch sign of the effect, swap the role of
the proposed cause and the proposed consequence, or try the null
hypothesis as if it were the working hypothesis. If the opposing
framing sounds equally natural, the framing is not load-bearing —
proceed. If the opposing framing makes the result *disappear* or
contradicts a different observation, you may be frame-locked.

**Tools that help.** None machine-enforceable; this is an explicit
prose step. `research-harness` recovery is a good moment to perform
it, by re-reading `research_contract.md` and
`research_plan.md#Current Status` with fresh eyes after the M1–M6
material checks have been completed.

## Pre-approval ritual

Walk the modes most relevant to the gate before invoking
`autoresearch approve <approval_id>`. The check is owed to the next
agent who will read the durable record, not to the current task's
deadline.

| Gate | Scope | Modes that bite most often |
| --- | --- | --- |
| A1 | mass_search (literature pool definition) | M2, M4 |
| A2 | code_changes (implementation diff) | M1, M5 |
| A3 | compute_runs (numerical result acceptance) | M3, M5, M6 |
| A4 | paper_edits (manuscript text) | M2, M3, M4, M7 |
| A5 | final_conclusions (project closeout) | All seven |

For A5 specifically, run the full M1–M7 pass and record the check
result inline in the conclusion artifact rather than as a separate
file.

## Integration with adjacent skills

- `research-harness` is the project-state recovery and routing skill.
  It is where M7 (frame_lock) reset typically happens: re-read
  `research_contract.md` and `research_plan.md#Current Status` with
  fresh eyes. The `HARNESS_INVOCATION_REQUIRED` anchor gate enforced
  in every `*-mcp` dispatcher ensures tool calls cannot proceed without
  re-anchoring; this skill's M7 step is the human-facing complement.
- `research-team` enforces M5 and M6 mechanically via the
  Reproducibility Capsule contract in `research_contract.md`. Inside
  an active research-team cycle, M5 and M6 are partly covered by
  the cycle's convergence gate; this skill's job there is the
  M1–M4 and M7 angles.
- `markdown-hygiene` should run before any check that relies on
  Markdown math being rendered correctly, otherwise numeric
  quotations may be misread during the M3 check.
- `referee-review` runs the integrity check from the *reviewer* side
  with a strict verdict contract. If a draft is heading to
  `referee-review`, run M1–M7 first so the reviewer's BLOCKING
  findings are not symptoms the author could have caught.
- `paper-reviser` is the right surface for acting on M2/M3/M4/M7
  findings that surface during late-stage drafting.
- `claim-grounding` is the active execution of the M2/M3 obligations.
  Where this skill mandates *that* citations and cited numbers be checked
  against their sources, `claim-grounding` is the generic, domain-routed
  way to *do* it: for each cited claim it fetches the source and records a
  span-backed verdict in a `claim_grounding_report_v1` artifact, and a
  `substantiated` verdict that carries no verbatim source quote is
  mechanically downgraded. It stays a generic skill plus a
  `@autoresearch/shared` contract — not a `hep-mcp` tool — consistent with
  the criterion below.

## HEP-specific augmentation (future, out of scope here)

This generic skill stays domain-neutral. Future machine checks may
belong inside `@autoresearch/hep-mcp` — but only when the check is
**genuinely HEP-bound by its core contract**, not merely because it
involves a tool whose name contains `hep`, `inspire`, or `pdg`.

**Criterion for whether a check is truly HEP-bound** (judge by what
the check *does*, not by the package it would live in):

- A PDG-drift check that compares a cited mass / branching fraction
  against the current PDG record and flags excess deviation **is**
  HEP-bound — PDG only tracks HEP particle properties, no equivalent
  exists in other disciplines.
- A FeynRules / FeynArts model consistency check **is** HEP-bound —
  the underlying QFT model formalism is HEP-specific.
- A lattice ensemble metadata check (action, $\beta$, $a$, $V$,
  sea-quark content) **is** HEP-bound — the ensemble metadata
  schema is lattice-QCD-specific.
- A generic "verify each cited number against its source table"
  check is **not** HEP-bound — every discipline has tables and
  numbers; this belongs in this skill (M3), not in `hep-mcp`.
- A generic "verify each cited paper resolves to a real record"
  check is **not** HEP-bound — `inspire_validate_bibliography`'s
  default mode already audits non-INSPIRE entries for locatability,
  and OpenAlex / arXiv resolvers are cross-domain by data. This
  belongs in this skill (M2), not as a new `hep-mcp` tool.

If a candidate future tool fails the criterion, it does not become
HEP-bound by being implemented inside `hep-mcp`; it stays a generic
discipline obligation, captured here as a mode rather than as a tool.

PDG-drift is the leading HEP-bound candidate tracked separately for
future work, not part of this skill's initial scope.

## Recording the check

For the *narrative* record — read by the next agent or human — record
the check inline in the response or notebook entry, in the order:

1. Which modes you checked, by `Mx` number.
2. For each checked mode: the specific disconfirming check you ran
   and what it returned. Quote tool calls and their results where the
   check is provider-graph-backed.
3. Modes you explicitly judged not applicable, with a one-sentence
   reason.

For the *machine* record that gates `autoresearch approve` (see below),
run `autoresearch integrity-record` after the narrative is written:

```bash
autoresearch integrity-record \
  --approval-id <approval_id> \
  --modes M3,M5,M6 \
  --notes "<terse summary of what was checked and the headline finding>" \
  --skip M1:no\ code\ change,M2:no\ new\ citations
```

`--modes` is the comma-separated list of `Mx` you actually walked.
`--skip` is an optional comma-separated list of `Mx:reason` for modes
you judged not applicable. `--notes` is short prose (max 500 chars) —
durable detail still belongs in the narrative record above; the
receipt is just the boundary-time machine artifact.

The receipt is appended to `.autoresearch/integrity_log.jsonl` and
checked by `autoresearch approve <approval_id>` (and the `orch_run_approve`
MCP tool) before granting. Without a matching receipt the approval
fails closed with `INTEGRITY_RECEIPT_REQUIRED`. This is the same
fail-closed pattern as the `HARNESS_INVOCATION_REQUIRED` anchor gate —
the *existence* of the receipt is machine-enforced, the *content* of
your check is your judgment.

Skip semantics for environments that need to bypass the gate (e.g.
historical project replay): `AUTORESEARCH_INTEGRITY_VERIFY=skip`.
`NODE_ENV=test` skips by default to keep existing test suites green.

## Recovery from a caught failure

If a check surfaces a failure, do not cross the boundary. Fix it,
then re-walk the affected modes only. Re-run `autoresearch
integrity-record` for the same `approval_id` — the latest receipt
wins, the prior entry stays in the JSONL for audit. The fix gets a
brief note in the narrative record so the next reader can see what
was caught and what was changed.

The integrity check is owed to the next agent who will read your
work — including future-you in a new conversation — not to the
current task's deadline.
