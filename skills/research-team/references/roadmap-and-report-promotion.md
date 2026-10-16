# Research team: roadmap dependency-map and main report promotion

## Plan-summary / milestone-handoff: roadmap dependency-map

At a **plan-summary or milestone-handoff moment** (communicating a multi-phase
plan to a stakeholder, closing out a milestone, or handing off), produce a
**roadmap dependency-map** from `assets/roadmap_dependency_map_template.md`. It is
a one-page planning view with five parts: (1) a roadmap summary table (per
milestone/lane: status · effort estimate with uncertainty · resource/compute
cost · upstream deps · unlocks); (2) a milestone/lane dependency graph where node
fill encodes status and edge type encodes dependency kind (solid = hard "unlocks";
dashed = soft "feeds into"), with the critical path marked; (3) a binding-constraint
callout (the single hardest resource/feasibility limit, with its scaling); (4) a
critical-path recommendation (minimal ordered chain + what is parallelizable +
"later upgrade ≠ prerequisite"); (5) honest estimate discipline (numbers are
estimates with stated uncertainty, distinct from measurements).

Render the graph through the `nullius graph --kind roadmap --spec <roadmap.json>`
front door (consumes the `@nullius/shared/graph-viz` engine: always writes DOT;
optional PNG/SVG only if Graphviz is installed). This is a **planning** view and is
intentionally **distinct from the Claim DAG** (`knowledge_graph/`, which encodes
*what we believe* — claims + evidence): it reuses the Claim DAG's rendering
conventions but shares no input files and must not be conflated with it.

## Main research report promotion

The roadmap map, member reports, convergence summaries, checkpoint notes, and
closeout briefs are coordination or review artifacts. None is the main
research report. Machine manifests and receipts bind execution but likewise do
not replace the human-readable scientific account.

When a converged milestone is promoted into the project's main report, copy
the canonical project template to a new stable path under `reports/` and fill
the complete narrative contract. Register its SHA-256 and any supersession in
`project_index.md#Main research report`; update the old and new registry rows
in both directions and switch the single current pointer. Registered report
bytes are immutable. Run `nullius report-validate` before calling the
promotion complete. Structural validation checks the contract shape,
human-readable links, replay classification, hashes, and supersession chain;
it does not decide whether the scientific narrative is sufficient.
