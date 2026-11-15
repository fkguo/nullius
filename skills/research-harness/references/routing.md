# Route The Work

Read the section relevant to the current operation. Commands and script paths are relative to the installed `research-harness` skill directory unless an external project root is specified.

## Route The Work

- The primary agent owns the research question, central reasoning and synthesis.
  Use the current host directly; isolated runners remain tools for scoped work
  and independent verification. Do not delegate merely to satisfy a role count
  or ask the user to manage routine tool selection and record keeping.
- Clarify the current question and the next useful action in the existing plan.
  Use a durable brainstorming recipe when comparing research directions needs it:
  ```bash
  nullius workflow-plan --recipe research_brainstorm
  ```
- Use host-native bounded delegation when it helps the current question. Invoke
  `research-team` when the project adopts its formal independent-member milestone
  and convergence workflow; keep that boundary explicit.
- If a compute environment, tool build, or documented invocation is new, rebuilt, or reconfigured, pass the three-layer readiness validation (see [compute readiness](compute-readiness.md)) before routing real work onto it.
- If the task is Markdown formatting, Markdown math escaping, generated TOC LaTeX cleanup, link/citation clickability, or pre-handoff note hygiene, invoke `markdown-hygiene` first, then rerun the relevant project gate.
- If developing or auditing a Julia computational package, use [`julia-package`](../../julia-package/SKILL.md) for its API, numerical contracts and package lifecycle; combine with `julia-perf` for kernels and performance claims.
- For scientific sources, use the available original-file access and the relevant
  provider capabilities. `hep-mcp` supplies physics metadata, sources and citation
  graphs. Route fixed-source reading, reference resolution and literature surveys
  by the claims being made in the [literature workflow](literature-workflow.md).
  A fixed-paper question does not automatically require a field-wide survey;
  claims about the literature's coverage or relationships still need that evidence.
- If the task is lifecycle, verification, approval, pause/resume, final conclusions, or export, keep it on `nullius`.

**Verification dispatch by result type.** This uses the same event → workflow vocabulary as the trigger table the scaffolded `AGENTS.md` carries (extended here with two harness-local rows, literature survey and prose; the integrity boundary lives in [closeout](closeout.md)). Perform the required checks when the result appears. If a named skill is not installed, read its requirements and use available capabilities to execute the same checks where the project permits it. Unknown requirements, unavailable execution or missing evidence leave the result unverified. This does not replace a required executable gate, evidence format or approval, or authorize claiming that an unavailable tool ran.

Verify a load-bearing definition, formula, branch or numerical conclusion before
dependent work relies on it. Independent checks can run in parallel with work
that does not rely on the unverified result. Preserve blocked or unfinished work
in a [continuation checkpoint](task-context.md#preserve-work-without-accepting-it);
the checkpoint cannot provide scientific acceptance or override an approval.

| Result type | The moment | Verification workflow |
|---|---|---|
| Symbolic derivation | derived a formula, closed form, identity, or a sign/branch/boundary choice that later work will rely on | [`derivation-verify`](../../derivation-verify/SKILL.md) |
| Numerical result | a computed number **that a conclusion or durable artifact will rest on** is about to be trusted, compared, or folded in — a number whose only consumer is a test, a fixture, or internal tooling is covered by ordinary tests, not this gate (a diagnostic that establishes a headline claim's convergence is result-bearing, not exempt) | [`numerical-reliability-gate`](../../numerical-reliability-gate/SKILL.md) |
| Citation-backed claim | wrote citation-backed claims (introduction, related work, discussion) | [`claim-grounding`](../../claim-grounding/SKILL.md) |
| Bibliography | freezing a bibliography, or admitting papers into a core reading set | [`citation-triangulation`](../../citation-triangulation/SKILL.md) |
| Literature survey | a survey feels thin, or before writing an introduction / related-work section | [`deep-literature-review`](../../deep-literature-review/SKILL.md) |
| Data figure | finalized a data or results figure (once per generating script) | [`figure-hygiene`](../../figure-hygiene/SKILL.md) |
| Schematic diagram | drew or revised a schematic, process, or geometry diagram | [`physics-diagrams`](../../physics-diagrams/SKILL.md) |
| Performance claim | claimed a speedup or performance regression, or wrote performance-critical numerical code | [`julia-perf`](../../julia-perf/SKILL.md) (language-scoped; use an equivalent gate for other languages) |
| Julia package change | created or changed a computational package's public API, dependency, supported representation, tests or documentation | [`julia-package`](../../julia-package/SKILL.md), with `julia-perf` for kernels; package checks do not replace numerical-result acceptance |
| Independent review | a result-bearing surface needs independent review: a headline result, manuscript, load-bearing derivation, public contract, or an irreversible change — internal scaffolding diffs (writers, fixtures, launchers, schema plumbing) close on local tests plus a single reviewer, not a cross-model panel; an implementation never closes on its author's own tests alone | [`review-swarm`](../../review-swarm/SKILL.md) |
| Prose / notes | Markdown math, TOC, links, or note hygiene before a handoff or gate | [`markdown-hygiene`](../../markdown-hygiene/SKILL.md) |

Do not invent compatibility commands or fallback entrypoints. Keep lifecycle work on `nullius` and route executor or provider work to the relevant skill/tool layer.

Provider search exports and other research outputs go into a caller-chosen
`output_dir` inside the external project; downloads and caches remain in the
provider's data root. Run identity and lifecycle records stay with `nullius`.
Use `project_index.md#Main research report` and `nullius report-validate` for the
current report entry and its structural promotion gate.
