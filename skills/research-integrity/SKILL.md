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
  this is the **discipline** that asks whether the evidence was
  actually consulted.
- Not a structured artifact. There is no `integrity_report.json` schema.
  The check result is recorded inline in the response or notebook entry
  next to the boundary-crossing action.
- Not domain-specific. Every mode is named in domain-neutral terms.
  HEP is the current most-mature domain and most examples below use HEP
  tooling, but each mode applies in any research domain.
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
- `gitnexus_impact` and `gitnexus_context` to surface call sites and
  invariants you may have forgotten existed.
- `pnpm -r build` and the targeted package's `vitest` / `pytest` —
  type-checking and tests catch a subset of M1, but they do not
  substitute for the disconfirming check.

### M2: hallucinated_citation

**Definition.** A citation made without verifying that the paper
exists with the cited identifier, by the cited authors, in the cited
venue, in the cited year, with the cited claim.

**Signs.**
- Citation key looks like a templated `{Authors}{Year}{Topic}` slug
  but no resolver call (`inspire_resolve_citekey`, `inspire_search`,
  `openalex_search`, etc.) appears in the transcript.
- "I'm pretty sure paper X says Y" with no `inspire_*`, `openalex_*`,
  or `arxiv_*` call backing it.
- Citation count, h-index, review status, or seminal-paper claim with
  no provider tool call.
- Bibliography assembled from web-search snippets alone, never
  cross-checked against `inspire_resolve_citekey` or
  `inspire_validate_bibliography`.

**Minimum disconfirming check.** For each non-trivial citation in the
work crossing the boundary, run at least one of:
`inspire_resolve_citekey`, `inspire_search`, `openalex_search`, or
`arxiv_search`. The identifier must round-trip to a real record.
Then verify the cited claim against the paper itself via
`inspire_paper_source`, `arxiv_paper_source`, `arxiv_get_metadata`, or
the corresponding `openalex_get` content payload. Where bibliographies
are involved, use `inspire_validate_bibliography` to catch malformed
or non-resolvable entries in bulk.

**Tools that help.** `hep-mcp` `inspire_*` family for INSPIRE-indexed
HEP literature; `openalex_*` family for cross-domain; `arxiv_*` family
for preprints. The `crossref` skill is the fallback for non-HEP /
non-arXiv literature.

### M3: hallucinated_measurement_or_result

**Definition.** A numerical value — particle mass, branching fraction,
cross section, fit parameter, benchmark accuracy, sample size,
p-value, simulation parameter — cited without verifying it against
the cited source's actual table, equation, or figure.

**Signs.**
- Value looks "about right" from memory; uncertainty is absent or
  stated with the wrong number of significant digits.
- HEP-specific: a PDG-tracked quantity (particle mass, lifetime,
  branching fraction, etc.) is cited but no `pdg_*` call appears in
  the transcript.
- A cited measurement does not name the specific table or figure it
  came from.
- Two papers' results are compared in prose but never aligned through
  `inspire_detect_measurement_conflicts` or
  `hep_project_compare_measurements`.

**Minimum disconfirming check.** For each cited numeric value, open the
specific table, equation, or figure that contains it. Quote the value
and its uncertainty exactly. If the source is PDG-tracked, verify
against the current PDG record via `pdg_get` /
`pdg_get_measurements` and record the PDG year/edition that was
checked. For HEPData submissions, fetch the table via
`hepdata_get_table`.

**Tools that help.**
- `pdg_get`, `pdg_get_measurements`, `pdg_find_particle`,
  `pdg_get_property`, `pdg_batch` for PDG-tracked quantities.
- `hepdata_get_table`, `hepdata_get_record`, `hepdata_search` for
  HEPData submissions.
- `inspire_paper_source` + the `pdf-mcp` parser for arbitrary paper
  content extraction.
- `inspire_detect_measurement_conflicts` for cross-paper tension
  detection.

### M4: shortcut_reliance

**Definition.** A relationship claim about papers — "X cites Y", "Y is
a review of Z", "this is the seminal paper on Q", "field W mostly
disagrees with claim V" — made without consulting the citation or
reference graph.

**Signs.**
- "Most papers in this area cite X." (no
  `inspire_literature(mode=get_citations)` or `openalex_citations`
  call.)
- "Y is the standard reference." (no review-classification call.)
- "Z built directly on W's work." (no chronological + citation-edge
  check.)
- "These two communities cite each other heavily." (no
  `inspire_network_analysis` or `inspire_find_crossover_topics`
  call.)

**Minimum disconfirming check.** For each relationship claim, trace
the edge in the citation graph. Web-search snippets are candidates,
not authorities; they may be derivative summaries of derivative
summaries. The graph itself is the authority.

**Tools that help.** `inspire_literature` (modes `get_references` and
`get_citations`), `inspire_find_connections`,
`inspire_network_analysis`, `inspire_classify_reviews`,
`inspire_analyze_citation_stance`, `openalex_references`,
`openalex_citations`. For broader cross-domain mapping,
`inspire_find_crossover_topics`.

### M5: bug_as_insight

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
size) and verify the effect persists in the expected direction. If
the effect comes and goes, the code is the first hypothesis to
investigate.

**Tools that help.**
- `autoresearch run` with explicit `run_id` for reproducibility.
- `research-team` Reproducibility Capsule (mandatory section of
  `research_contract.md`).
- `hep-calc` skill for symbolic re-derivation when an analytic
  cross-check is available.
- `git bisect` when the symptom postdates a known-clean reference
  point.

### M6: methodology_fabrication

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

## HEP-specific augmentation (future, out of scope here)

This generic skill stays domain-neutral. HEP-specific machine checks
that genuinely require HEP domain authority — for example a single
PDG-drift check that flags PDG-tracked quantities whose cited value
in a draft deviates from the current PDG record beyond combined
uncertainty — belong as a single tool in `@autoresearch/hep-mcp` and
are callable from this skill via the host. That tool is not part of
this skill's initial scope and is tracked separately as future work.

The split is deliberate: M3 itself is generic (any cited numeric
value should be traced to its source), and only the PDG-drift
heuristic is HEP-bound. Putting the heuristic in `hep-mcp` and the
discipline in this skill keeps both surfaces honest about what they
are.

## Recording the check

Do not invent a new schema. Record the check inline in the response
or notebook entry, in the order:

1. Which modes you checked, by `Mx` number.
2. For each checked mode: the specific disconfirming check you ran
   and what it returned. Quote tool calls and their results where the
   check is provider-graph-backed.
3. Modes you explicitly judged not applicable, with a one-sentence
   reason.

If a check surfaces a failure, do not cross the boundary. Fix it,
then re-check the affected modes only. The fix gets a brief note in
the same record so the next agent can see what was caught and what
was changed.

The integrity check is owed to the next agent who will read your
work — including future-you in a new conversation — not to the
current task's deadline.
