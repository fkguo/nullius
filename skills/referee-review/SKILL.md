---
name: referee-review
description: Obtain an independent referee-style assessment of a scientific manuscript through a host reviewer or review-swarm. Read the actual manuscript and original evidence, identify substantive defects and missing checks, and preserve the review's scope and limitations.
---

# Referee Review

The independent reviewer reads and judges the science. The author or primary
agent supplies the research question and actual materials, then responds to the
findings. This skill is a procedure for that work; it has no report generator or
automatic scientific verdict.

## Arrange the review

1. **State the task.** Identify the current manuscript, the scientific question,
   the requested review scope and any journal or audience requirements. For an
   initial review, provide the full manuscript and included sections. For a
   revision, identify the reviewed baseline and exact changes, with the full
   affected argument and dependencies available. A diff or summary alone cannot
   establish that the paper's reasoning is sound.
2. **Provide the original materials.** Give the reviewer readable source
   passages, bibliography records, derivations, data, code and execution records
   needed for the claims under review. A filename, abstract, author-written
   summary or assertion of a passed check is only a locator or claim. The
   reviewer must inspect the actual content. Check rendered pages when equations
   or figures depend on PDF/image interpretation. If necessary evidence cannot
   be read, record the affected claim and limitation; do not infer support.
3. **Delegate independently.** Use an independent host agent with access to the
   materials, following the scope and isolation rules in
   [review-swarm](../review-swarm/SKILL.md). Give a neutral question, without the
   author's preferred verdict or prior reviewers' conclusions. A different
   provider is not by itself evidence of independence. If an independent
   reviewer is unavailable, report that the scientific review is unavailable;
   an author self-check does not replace it.

For a CLI review, use the existing `review-swarm` launcher and its documented
roles, rather than a separate referee executor. Read the
[single-reviewer procedure](../review-swarm/references/single-reviewer-invocation.md)
and [input flags](../review-swarm/references/review-one-flags.md) before using
`review-swarm/scripts/bin/review_one.py`; use the
[multi-reviewer procedure](../review-swarm/references/launcher-invocation.md)
when the scope calls for multiple seats. Supply the current manuscript as the
artifact and the necessary original material as source/context inputs for the
selected roles. A single advisory seat does not satisfy a scope that requires a
second independent seat. Native host reviewers follow the same scientific
requirements but are not counted as launcher executions unless actually run
through that launcher.

A copy install includes `codex-cli-runner` for the `codex/default` correctness
example in `review-swarm`; the Codex CLI must also be available on `PATH`.
For another CLI backend, install its matching runner skill and client before
selecting it. Native host reviewers remain available without a CLI client.

## Read, challenge and verify

The reviewer should:

- Reconstruct the actual claim, assumptions, definitions and argument from the
  manuscript; look for counterexamples, omitted regimes, inconsistent
  conventions and conclusions stronger than the evidence.
- Check citation-backed statements against the original sources using
  [claim-grounding](../claim-grounding/SKILL.md). Identify what the source does
  and does not support. Use the available source tools to obtain missing
  evidence when the task permits; if access is restricted or unavailable, make
  concrete evidence requests and keep the affected judgment unresolved.
- Distinguish argument review from independent confirmation. A load-bearing
  formula requires the applicable [derivation-verify](../derivation-verify/SKILL.md)
  work; a computed quantity requires the applicable
  [numerical-reliability-gate](../numerical-reliability-gate/SKILL.md) checks.
  Candidate-withheld derivation or recomputation starts from a neutral question
  and raw inputs before comparison with the author's result. Reading the
  author's calculation again cannot stand in for executing that work.
- Anchor every substantive finding to precise manuscript and evidence
  locations, explain its effect on the argument, and state what check or change
  would resolve it. Preserve disagreements and missing evidence rather than
  choosing a favorable interpretation to produce a completed review.

The author applies [research-integrity](../research-integrity/SKILL.md) at its
specified review/adoption boundaries and records the checks in the form required
by the current project. Author pre-flight does not discharge independent review;
reviewers still report any defects they find. Do not create a synthetic approval
just to record a draft review.

## Return and use the assessment

Write a source-grounded review that identifies the reviewed manuscript/version,
the scope and material actually read, substantive findings and their evidence,
missing checks, and a qualified recommendation. Separate blocking scientific
issues from editorial suggestions. An unread dependency or unperformed check
must remain explicit; a well-formed report does not establish that the review
occurred or that a result is correct.

When using `review-swarm`, preserve its reviewer output, input manifest, runtime
records and freshness result. Its deterministic checks establish material
binding, execution and output-contract conditions; they do not infer scientific
correctness from headings, keywords, file existence or an exit code. The
scientific assessment must come from the actual independent reviewer. For host
review, retain the actual delegated assessment and material references through
the host's existing records; never invent CLI capture or model identity.

The primary agent reads the findings, performs the required work, edits the real
manuscript and obtains confirmation on changed claims before relying on the
review. Apply the project's result-specific acceptance requirements separately.
Use [paper-reviser](../paper-reviser/SKILL.md) for tracked manuscript revisions
and [research-writer](../research-writer/SKILL.md) for writing and delivery.

Previously saved review files remain historical artifacts: keep their original
bytes, provenance and status, and continue to read, link or export them. Their
labels alone do not establish an independent scientific review or current
acceptance. There is no command here to regenerate a scientific verdict from a
packet's structure.
