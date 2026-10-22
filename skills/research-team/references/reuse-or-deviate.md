Command, script and asset paths in this reference are relative to the `research-team` skill directory. Markdown links are relative to this reference. Cross-section names follow the routes in [SKILL.md](../SKILL.md).

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
[*Prior-art binding* contract](execution-origin-contracts.md)). A deviation record first written
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

Read [`references/roadmap-and-report-promotion.md`](roadmap-and-report-promotion.md) when producing a plan-summary or milestone-handoff roadmap dependency-map, or promoting a converged milestone into the main research report (the roadmap dependency-map and main-report-promotion sections, moved there verbatim).
