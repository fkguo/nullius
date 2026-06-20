# Roadmap Dependency Map (Template)

Plan: <PLAN_OR_PROJECT_NAME>
Last updated: <YYYY-MM-DD>

A **plan-summary / milestone-handoff** view: it summarizes a multi-phase plan so a
stakeholder can see, in one place, *where the work stands, what gates what, what
caps feasibility, and the shortest route to the goal*. Fill it at a plan-summary
or milestone-handoff moment; it is a communication artifact, not a working tracker.

> **What this is NOT.** This is a *planning* view (milestones/lanes + dependency
> structure). It is **not** the Claim DAG in `knowledge_graph/` (claims + evidence,
> *what we believe*), and it does not replace `research_plan.md` (the working
> milestone plan) or `project_index.md` (navigation). It reuses the Claim DAG's
> *rendering conventions* on purpose, but the two graphs are complementary and
> share no input files — do not conflate them.

There are five parts; keep all five.

---

## 1. Roadmap summary table

One row per milestone/lane. Effort and cost are **estimates with stated
uncertainty**, in the plan's own work-unit — never silently presented as
measurements (see Part 5).

> The `id`s, effort/cost values, and scaling expressions below are **illustrative
> generic placeholders** — `Milestone A/B`, `Lane X`, and generic compute units
> (memory / wall-clock / number-of-runs / a complexity such as `O(N)` in problem
> size `N`). Replace them with your plan's own milestones and its own work-unit;
> do not read them as a prescribed resource profile.

| id   | status      | effort estimate (own work-unit, ± uncertainty) | resource / compute cost            | upstream deps | unlocks (downstream) |
|------|-------------|------------------------------------------------|------------------------------------|---------------|----------------------|
| M_A  | done        | ~2 units (±50%)                                | peak mem ~`O(N)`; 1 short run      | —             | M_B                  |
| M_B  | in_progress | ~4 units (±60%)                                | ~1 long run; wall-clock hours      | M_A; (L_X)    | M_C                  |
| L_X  | candidate   | ~1 unit (rough)                                | negligible                         | —             | M_B (feeds into)     |
| M_C  | todo        | ~3 units (±70%)                                | ~`R` runs at production scale      | M_B           | M_D; **GOAL**        |
| M_D  | deferred    | ~2 units (rough)                               | as M_C                             | M_C           | —                    |

Status vocabulary: `done` · `in_progress` · `todo` · `deferred` · `candidate`.
- `done` — completed and accepted.
- `in_progress` — actively being worked.
- `todo` — committed, not started.
- `deferred` — intentionally postponed (a later upgrade, not a prerequisite).
- `candidate` — proposed but not yet committed (optional / may be dropped).

---

## 2. Milestone / lane dependency graph

**Node fill encodes status** (legend below). **Edge type encodes dependency kind:**
**SOLID = hard dependency ("unlocks")**; **DASHED = soft "feeds into" / optional
enhancement.** The **critical path** is marked explicitly. Reader's one-line key:
*node fill = status; solid edge = unlocks (hard); dashed edge = feeds into (soft);
heavy red outline / heavy edge = critical path; double-octagon = goal.* (The rendered
graph carries a compact `Legend` cluster keyed by node status + edge kind; the goal
node (double-octagon) and the critical path (heavy red border / edge) read directly
off the graph itself rather than as separate legend swatches.)

### Zero-tool view (edge list — readable with no renderer)

```
M_A --unlocks--> M_B        [critical]
M_B --unlocks--> M_C        [critical]   (M_C = GOAL)
L_X --feeds into--> M_B     (optional enhancement; candidate)
M_C --feeds into--> M_D     (later upgrade; deferred)

critical path: M_A -> M_B -> M_C
```

### Machine spec (consumed by the renderer)

Save as e.g. `roadmap_graph.json`. `critical: true` marks critical nodes/edges;
`goal` names the goal node. Status/kind aliases (e.g. `complete`, `depends_on`)
are normalized.

```json
{
  "title": "Roadmap dependency map (<PLAN_OR_PROJECT_NAME>)",
  "goal": "M_C",
  "nodes": [
    {"id": "M_A", "label": "Milestone A", "status": "done",        "effort": "~2 units (±50%)", "cost": "peak mem ~O(N)", "critical": true},
    {"id": "M_B", "label": "Milestone B", "status": "in_progress", "effort": "~4 units (±60%)", "cost": "~1 long run",    "critical": true},
    {"id": "L_X", "label": "Lane X",      "status": "candidate",   "effort": "~1 unit (rough)"},
    {"id": "M_C", "label": "Milestone C", "status": "todo",        "effort": "~3 units (±70%)", "critical": true},
    {"id": "M_D", "label": "Milestone D", "status": "deferred"}
  ],
  "edges": [
    {"from": "M_A", "to": "M_B", "kind": "unlocks",    "critical": true},
    {"from": "M_B", "to": "M_C", "kind": "unlocks",    "critical": true},
    {"from": "L_X", "to": "M_B", "kind": "feeds_into"},
    {"from": "M_C", "to": "M_D", "kind": "feeds_into"}
  ]
}
```

### Render it (renderer-agnostic; no hard dependency on any viz tool)

```bash
# Renders through the autoresearch graph front door (consumes the domain-neutral
# @autoresearch/shared/graph-viz engine). Always writes <out-dir>/roadmap.dot (the
# portable source of truth; reads as text / pastes into any DOT viewer):
autoresearch graph --kind roadmap --spec roadmap_graph.json --out-dir .
# Optional raster/vector — only if Graphviz 'dot' is installed:
autoresearch graph --kind roadmap --spec roadmap_graph.json --out-dir . --format svg
```

The DOT is the portable source of truth. If a **host visualization capability**
is available (an SVG/diagram widget), it can render the same DOT — but that is a
host capability, not part of this toolchain, so nothing here depends on it.

Convention excerpt (what the renderer emits — node fill by status, solid vs
dashed edges, critical highlight):

```dot
"M_A" [label="M_A\nMilestone A", shape=box, style=filled, fillcolor="#e8f5e9", color="#b71c1c", penwidth=2.4, peripheries=2];  // done + critical
"L_X" [label="L_X\nLane X", shape=box, style="dashed,filled", fillcolor="#ede7f6", color="#5e35b1"];                          // candidate
"M_A" -> "M_B" [label="unlocks", penwidth=2.2, color="#b71c1c"];   // hard dep, on critical path (solid)
"L_X" -> "M_B" [label="feeds into", style=dashed, color="#8e8e8e"];   // soft / optional
```

---

## 3. Binding-constraint callout

Name the **single hardest resource/feasibility limit** that caps what is
achievable, with its scaling/threshold, so feasibility is grounded rather than
hand-waved. Exactly one primary constraint; note runners-up only if they bind
nearby.

> **Binding constraint:** `<resource>` scales as `<… e.g. ~ N^2 in problem size>`,
> so at the production setting `<X>` it reaches `<threshold/limit, e.g. ~G GB peak
> memory / ~H wall-clock hours per run>`. This caps `<which milestone(s)>` at
> `<what is feasible>`; going beyond needs `<the specific relief — more memory, a
> cheaper method, a smaller production setting>`. Everything downstream inherits
> this ceiling.

State it as an estimate with its basis (a measured pilot run, a scaling argument,
or a rough guess) — not as a guaranteed number.

---

## 4. Critical-path recommendation

- **Minimal ordered chain to the goal:** `M_A -> M_B -> M_C` (the goal is `M_C`).
  This is the shortest sequence of **hard dependencies**; nothing off this chain
  shortens it.
- **Parallelizable / off the critical path:** `L_X` (a candidate enhancement that
  *feeds into* `M_B` but does not gate it) can run in parallel or be dropped
  without delaying the goal.
- **Later upgrade ≠ prerequisite:** `M_D` is `deferred` — it depends on `M_C` and
  improves the result but is **not** required to reach the goal. Do not let a
  "nice-to-have later upgrade" masquerade as a blocker.

How to identify the critical path: take the longest chain of **solid (hard /
"unlocks")** edges that ends at the goal; soft "feeds into" edges and `candidate`
/ `deferred` nodes are off it by definition unless they become hard dependencies.

---

## 5. Honest estimate discipline

- Every effort and resource number above is an **estimate with stated
  uncertainty**, in the plan's own work-unit — not a measurement.
- **Distinguish an estimate from a measurement.** If a number came from an actual
  run, say so and cite it; if it is a projection or a guess, mark it (`±`, `rough`,
  `~`) and name its basis.
- Prefer ranges or `±` bands over false-precision point values.
- Update the table and the spec as estimates are replaced by measurements; a
  number that has been measured should stop wearing an uncertainty band and should
  point to its evidence.

---

<!-- Provenance: distilled from communicating a multi-phase research plan to a
     stakeholder. Keep this template domain-neutral — all examples are generic
     placeholders (Milestone A/B, Lane X, <resource>); never bind it to a concrete
     project, field, system, or variable. -->
