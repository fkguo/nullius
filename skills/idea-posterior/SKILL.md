---
name: idea-posterior
description: "Turn a research idea into an auditable posterior: run an admission gate before any graph is built, decompose the idea into five source-grounded sub-criteria, encode them as a Gaia argument graph (gaia-lang, pinned 0.5.0a4), run exact inference, and write the posterior back to the idea store. Enforces a parameter honesty discipline — three fixed likelihood grades on the Jeffreys evidence scale, a mandatory anchor note on every number, MaxEnt fallback when an anchor fails review — plus pairwise expansion for mutual exclusivity, tournament-result absorption, revival by appending evidence, and review that audits anchors rather than scores. Use when admitting an idea into a tracked portfolio, when new evidence (literature, trial computation, tournament result) should move an idea's posterior, or when auditing why a posterior is what it is."
---

# Idea Posterior

Use this skill to hold beliefs about research ideas in an inspectable form:
every idea worth tracking gets one Gaia argument graph whose top-level claim is
"this idea merits sustained verification effort", whose structure records the
argument, and whose exact-inference posterior is written back to the idea
store. The point is not the number itself but the audit trail behind it: every
probability in the graph traces to an anchored source or is absent by design.

Beliefs and decisions are separate layers. The graph holds beliefs; budget
allocation, tournament execution, and portfolio scheduling read the posterior
but live outside the graph and outside this skill.

## Scope and boundaries

- **Gaia owns the belief layer only**: argument structure, posterior
  computation, and absorption of new evidence including tournament results.
- The admission decision procedure (below) runs before any graph exists; its
  verdict is recorded as an artifact, not as graph content.
- Whether a cited source actually supports a claimed statement is verified
  with the `claim-grounding` skill; this skill consumes those verdicts as
  anchors and does not re-implement source verification.
- Numbers from trial computations enter the graph only after the existing
  numerical disciplines have passed: `numerical-reliability-gate` for
  numerical soundness and the independent reproduction check taught by
  `research-harness`. This skill does not re-teach either.
- Resource allocation and match scheduling are portfolio-scheduler concerns;
  this skill only defines how a finished match result updates belief.

## Installation and version pin

Gaia is pinned to an exact version. Upgrading is an explicit, reviewed action,
never a side effect of environment drift.

```bash
uv venv .gaia-venv --python 3.12
uv pip install --python .gaia-venv/bin/python gaia-lang==0.5.0a4
.gaia-venv/bin/gaia --version   # first line must report 0.5.0a4 — stop if not
```

If the version check reports anything but `0.5.0a4`, stop and say so; the
skill's statement forms and parsing points are validated against this version
only. The Gaia-driving scripts below enforce the same check and print this
install recipe when the executable is missing or mismatched.

After creating a package, run `gaia sdk` inside it once and read the generated
`gaia-sdk/CHEATSHEET.md`: it is the authoritative statement reference for the
pinned version, including the Lindley–Jeffreys section referenced below.

### Optional static browser renderer

The posterior does not depend on presentation rendering. A browser-readable
`docs/detailed-reasoning.html` additionally uses established generation-time
tools: [Pandoc](https://pandoc.org/) parses Markdown and emits native MathML;
[Mermaid CLI](https://github.com/mermaid-js/mermaid-cli) renders each
Pandoc-identified `mermaid` block to static SVG; pinned
[nh3](https://github.com/messense/nh3) sanitizes the resulting HTML through
the Rust Ammonia library. The renderer carries the exact nh3 dependency in
PEP 723 metadata, and [uv](https://docs.astral.sh/uv/guides/scripts/) creates
that isolated environment automatically. uv is the bootstrapper; Pandoc and
Mermaid CLI are the only host presentation renderers. Install uv, Pandoc, and
`mmdc`, then verify the self-bootstrapping entry point:

```bash
uv run --script scripts/render_detailed_reasoning.py --help
pandoc --version
mmdc --version
```

The page begins with an evidence-to-conclusion view reconstructed from the
compiled IR: concrete recorded evidence, the authored likelihood rationale,
the structural criterion or intermediate claim being updated, and the unique
exported conclusion. Lowering paths appear before supporting paths. Generic
criterion sentences remain legal as structural hypotheses, but the page never
uses them as their own explanation. Any retained Gaia diagram is labelled a
generative probability-model graph: its arrows run from hypothesis to possible
evidence, not in the reader's evidence-flow direction.

The validated toolchain is uv 0.6.3, Pandoc 3.6.4, Mermaid CLI 11.9.0, and
nh3 0.3.6. The renderer records fixed tool names and normalized version tokens
in its manifest, never version-banner text or resolved executable paths. No
hash or tool metadata appears in the reader-facing page. uv, Pandoc, and
Mermaid CLI are optional external subprocesses, not bundled or linked into
nullius; the output page contains no runtime library or CDN dependency. Their
checked licenses are uv
[MIT](https://github.com/astral-sh/uv/blob/0.6.3/LICENSE-MIT) or
[Apache-2.0](https://github.com/astral-sh/uv/blob/0.6.3/LICENSE-APACHE),
[Pandoc GPL-2.0-or-later](https://github.com/jgm/pandoc/blob/3.6.4/COPYING.md),
[Mermaid CLI MIT](https://github.com/mermaid-js/mermaid-cli/blob/11.9.0/LICENSE),
and [nh3 MIT](https://github.com/messense/nh3/blob/v0.3.6/LICENSE). Generated
bytes can vary across browser-render tool versions, so byte identity is
claimed only for the same inputs and recorded toolchain, not across machines
with different versions.

### Moving between machines (synced projects)

Research projects are routinely synced across machines; everything this
skill writes is designed to survive that, provided one rule is respected:
**environments are machine-local, references are project-relative.**

- `gaia_package_ref` values are `project://` references resolved against
  the project root, so posteriors in the idea store stay auditable on
  every machine the project lands on. If a reference does not resolve
  (the package was moved or deleted after the write), re-run
  `run_infer_and_extract.py` on the package to produce a fresh posterior
  and reference — the `#sha256:` pin tells you whether the graph is still
  the same one.
- Virtual environments must NOT ride the sync: `.gaia-venv/` and each
  package's `.venv/` contain machine-specific binaries. Exclude them from
  the sync tool, and rebuild on the new machine: the recipe above
  recreates `.gaia-venv`; a package's own environment re-syncs
  automatically from its pinned `pyproject.toml` on the next gaia run (or
  explicitly with `uv sync --python 3.12` inside the package).
- If the project is also a git repository, prefer syncing it as a
  repository (push/pull) over letting a file-level sync service copy
  `.git/` — concurrent file-sync of repository internals can corrupt
  them.

## Admission gate — before any graph is built

No idea enters this skill from generation as allocation-ready. Generation can
only produce candidates; posterior construction starts from independently
checked close-prior evidence, not from a generator score.

Not every idea deserves a graph. An idea is admitted only if it clears at
least one of the four routes below. Judge the routes on recorded evidence, not
on enthusiasm; each route names what counts as its anchor.

1. **Resolves an anchored open problem or tension.** The problem or tension
   must already be recorded in a survey artifact or stated explicitly in a
   citable source. The anchor is that recorded statement; "everyone knows
   this is open" does not qualify.

2. **Supplies a new mechanistic understanding.** The idea states a testable
   mechanism — what drives what, through which pathway — rather than
   re-describing a known result in new words. The anchor is what the
   mechanism explains or newly predicts, stated concretely enough to check.

3. **Provides a new computational or solution method.** Two obligations,
   both required. First, an impact chain: a list of currently uncomputable or
   impractical quantities the method would unlock, each item anchored in the
   literature as genuinely out of reach today. Second, the size of the
   advance must be supported by a trial computation or a complexity argument;
   a verbal claim of speedup or reach is not admissible evidence.

4. **Proposes a new theoretical framework or formulation.** Two obligations,
   both required, and checked at admission time. The equivalence obligation:
   the framework must reproduce results already established in the framework
   it would replace or generalize — reproduce them now, not promise to. The
   generative obligation: at least one object, question, or computation that
   the old framework cannot naturally express or carry out must be exhibited
   as expressible and workable in the new one; a trial demonstration
   suffices. Missing either obligation, the idea is classified as
   repackaging and is not admitted.

Not admissible on any route: fitting a small amount of data with functions of
no assigned meaning — no mechanism, no new prediction, free parameters traded
for goodness of fit. Parsimony (how many phenomena are explained and predicted
per free parameter) is a useful supporting signal in close calls, but it is a
signal, not a doctrine.

Record the verdict as a `gate_result` in the idea's artifact directory:

```json
{
  "artifact": "gate_result_v1",
  "idea_slug": "example-idea",
  "verdict": "passed",
  "route": "open_problem | mechanism | method | framework",
  "anchors": [
    {"statement": "what the anchor establishes",
     "reference": "survey artifact section or citable source"}
  ],
  "rejection_reason": null,
  "date": "YYYY-MM-DD"
}
```

Framework-route ideas may enter with a low initial posterior. Both
obligations are still checked at the gate — equivalence by actual
reproduction, the generative obligation by its trial demonstration. What
accumulates afterwards is *further* generative evidence beyond that first
demonstration, entering as appended observations (see revival semantics
below). Admission says the idea deserves a graph, not that the graph starts
high; an idea with neither reproduction nor a trial demonstration is not a
low-posterior admit, it is a rejection.

## Close-prior literature gate — before posterior or portfolio scoring

Before building or updating a Gaia graph, before running `node.set_posterior`,
and before any portfolio surface may treat the idea as allocation guidance, the
idea must have a `literature_survey_v1` or equivalent close-prior artifact and
a close-prior matrix. If either artifact is missing, stop: the idea is still a
candidate or reconnaissance item, not posterior-ready.

The survey must show snowball discovery, not a one-shot topic search:

- `seed_search`
- `backward_references`
- `forward_citations`
- `critique_specific_search`

Every expansion round records `expansion_candidates_screened` and
`new_core_papers`. `saturated` is legal only when the final measured round did
real screening and admitted zero new core papers; if the final round still adds
core papers, or no real expansion round was measured, the status is
`coverage_incomplete`.

Every close-prior/core paper must be source-first and machine-readable:
`read_status` is one of `full_text_read`, `section_read`, `metadata_only`, or
`unavailable`; source links, read locators, and read sections are recorded; the
citation identity is triangulated across at least two independent providers
with verdict `consistent`; and the deep-read summary has a source-fidelity
audit with status `pass`. For `full_text_read`, the minimum checked regions are
introduction, formalism/method, results/discussion, and conclusion/outlook.
`metadata_only` and `unavailable` entries cannot anchor Gaia likelihoods.

Subagent literature audits are allowed only as discovery/synthesis input. The
main coordinator must verify source links, identity triangulation, source form,
quoted spans, locators, and summary fidelity before any extracted proposition
can become a graph anchor.

Gaia input is proposition-level, not paper-level. The allowed chain is:
deep-read paper -> extracted proposition -> claim-grounding quote and locator
-> mapped sub-criterion anchor -> `observe()` or `infer()` rationale. A paper,
paper count, provider metadata record, or subagent summary cannot directly
"count as a score."

Negative novelty claims ("no existing work does X") need reviewer gating:
close-prior matrix, critique-search record, closest-hit same-scope exclusion
reasons, and an independent reviewer check of the search terms plus the top
close priors' discussion/conclusion sections. Without that gate, write only
"not found in incomplete search" and do not use the claim as strong evidence.

If a later close-prior audit finds important missed prior work, take the idea
out of current guidance in the store: either move the node to `needs_refresh`
via `node.set_lifecycle` (the immediate coarse gate — ranking and allocation
read the lifecycle state first), or re-run `node.set_posterior` with status
`stale`/`provisional`, which makes the engine derive `needs_refresh` itself.
Historical posterior records remain audit history, but they are not current
allocation guidance until the graph is rebuilt and `node.set_posterior` is run
again with a `current` result.

## Sub-criterion decomposition

The worth of an admitted idea decomposes into five sub-criteria. Each becomes
one claim in the graph; each names its evidence sources so that every update
has a place to point.

| Sub-criterion | Question it answers | Evidence sources |
|---|---|---|
| `tension_resolution` | How far does the idea resolve an anchored open tension? Conceptual and structural tensions carry the same weight as numerical ones: incompatible frameworks, an approximation in use without justification, a missing mechanism. | tensions section of the literature survey artifact (`literature_survey_v1`) |
| `downstream_reach` | How long is the chain of downstream problems the idea feeds, and how broad is its generality — how many phenomenon domains does it unify or apply to? Breadth is a first-class dimension, rewarded non-linearly through the grade-promotion rule below; the top of the breadth scale is reserved for frameworks whose generality spans essentially every domain of a discipline. | idea card claims, each with `support_type` and `evidence_uris` |
| `mechanism_insight` | How much new, testable mechanistic understanding does the idea supply? | idea card claims; survey artifact |
| `testability_timing` | Can the idea be tested, and is the verification window open now — data, tools, and comparison points available on a relevant horizon? | idea card claims |
| `verification_cost` | Does a bounded, decisive first check exist? Only the belief-relevant part enters the graph: evidence that such a check exists raises feasibility belief. The budget decision itself stays outside. | the idea card's `minimal_compute_plan` field; trial computation artifacts |

**A tension is anchored by the literature that engages it, not by machinery
that assumes it.** `tension_resolution` is graded off the tensions section of a
real `literature_survey_v1` that surfaces both the strongest existing
*statement* of the tension and the strongest existing *challenge or competing
resolution* — the prior work that already argues, quantifies, or disputes it. A
single citable source may supply the *statement* half, but it never excuses the
challenge search: the competing or critical prior work is searched either way,
and when a diligent search finds none, that null result is recorded explicitly
and the tension is graded at the weakest grade — an unengaged tension is not a
substantiated one. Method or formalism papers that merely exhibit the apparatus
the idea reasons about are evidence for `mechanism_insight`, not anchors for
`tension_resolution`: they show the machinery exists, not that the tension is
real and open.

Two obligations remain separate. The literature establishes that a tension
exists and is relevant enough for admission; it does not establish that the
proposed idea resolves it. A raising likelihood into `tension_resolution`
requires idea-specific resolution evidence: a derived mechanism that closes
the stated gap, an executed test that discriminates the competing accounts, or
an explicitly scoped demonstrated partial resolution. Its rationale includes
one machine-readable clause before the anchor:
`resolution_evidence: mechanism`,
`resolution_evidence: discriminating_test`, or
`resolution_evidence: demonstrated_partial_resolution`. A proposed test or
compute plan may support `testability_timing` or `verification_cost`; until it
is executed and bears on resolution, it cannot raise `tension_resolution`.

## Parameter honesty discipline

This section is where the method stands or falls. A posterior computed from
invented numbers is worse than no posterior: it looks like knowledge.

- **Anchored facts are hard observations.** Anything already established by a
  survey artifact, a grounded claim verdict, or a passed trial computation
  enters as `observe()`, which pins the fact near certainty. Never soften an
  anchored fact into a guessed probability.

- **Soft inference uses exactly three likelihood grades.** Every `infer()`
  uses one of three fixed conditional-probability pairs, aligned with the
  Jeffreys evidence scale (Jeffreys 1961, *Theory of Probability*; modern
  treatment in Kass & Raftery 1995, "Bayes Factors", JASA 90:773):

  | Grade | Likelihood ratio | `p_e_given_h` | `p_e_given_not_h` |
  |---|---|---|---|
  | weak | 3 | 0.75 | 0.25 |
  | substantial | 10 | 0.90 | 0.09 |
  | strong | 30 | 0.90 | 0.03 |

  To let evidence lower a hypothesis, swap the two numbers of the grade —
  updates are symmetric in strength whichever direction they push. Free-hand
  decimals ("0.85 feels right") are forbidden; if none of the three grades
  fits, the evidence is probably not understood well enough to enter yet.
  The grades are written as **literal numbers** at the statement, never
  routed through variables or helper functions: literality is what makes
  the graph auditable line by line, and the extraction script refuses
  statements whose grade or note it cannot read as a literal.

- **Every number carries an anchor note.** The `rationale` of every
  `observe()` and `infer()` ends with `anchor: <artifact reference or
  resolvable URI>`. Review asks one question of every number: what does this
  trace to? A number whose anchor cannot be produced or does not survive
  `claim-grounding` is deleted — not adjusted, deleted — and the affected
  claim falls back to MaxEnt (Gaia's default when no prior or evidence
  binds). MaxEnt is the correct failure mode: honest ignorance beats
  fabricated precision.

  Every `observe()` rationale also declares exactly one stable
  `evidence_family: <token>` and one `correlation_model: single` before its
  anchor. The family identifies the underlying calculation, dataset, sample,
  literature claim-chain, or other evidence-producing source—not the wording
  of the observation. Gaia 0.5.0a4 multiplies separate `infer()` likelihoods;
  routing correlated observations through one shared claim does not encode a
  joint distribution and therefore does not make the votes independent. A
  family may have at most one observation on one likelihood-bearing path to
  `worth`. Completely redundant or correlated material is merged into one
  composite observed fact with one authored likelihood update. Repeated family
  labels are allowed only on disconnected source notes that cannot change
  the exported posterior.

  An `infer()` rationale also carries substantive authored prose before the
  trailing anchor, introduced by the explicit sentinel
  `reader_reasoning: <why the evidence changes the hypothesis>`.
  `rationale="anchor: ..."`, criterion text alone, and prose without that
  authorship sentinel are refused. The rationale contract is structural:
  authors may state criteria in the language appropriate to the idea, while
  the marked rationale records why the evidence changes that criterion at the
  selected likelihood grade. Separately, the six exact scaffold axis
  sentences are authoring placeholders and are refused if left unchanged.

- **Grade promotion for breadth.** A `downstream_reach` update may use the
  strong grade (ratio 30) only when the reach claim has anchored impact
  chains in at least three independent phenomenon domains, each domain
  anchored separately. Single-domain reach uses the weak or substantial
  grade. Counting domains means counting anchors, one per domain — an
  unanchored domain does not count. A raising strong-grade
  `downstream_reach` update must carry the domain list in its rationale as
  a machine-checkable clause, `domains: <one>; <two>; <three>` (three or
  more entries, `;` or `|` separated), before the trailing anchor note;
  the extraction script refuses a raising strong reach update without it.
  Whether the listed domains are genuinely independent and genuinely
  anchored stays a review question.

- **Utility and cost never enter the graph.** Beliefs and decisions are
  separate layers. No quantity of money, hours, or hardware ever appears in
  the graph — not as a claim, not in a rationale, not as a likelihood
  choice. What the `verification_cost` claim holds is a *belief about a
  fact*: that a bounded, decisive first check exists, anchored by a written
  compute plan or a passed trial run. The budget decision that consumes the
  posterior happens downstream, outside the graph. Test for violations by
  asking: does this statement give a *reason to prefer* the idea (utility —
  out), or *evidence that a checkable fact is true* (belief — in)?

- **Lindley–Jeffreys trap.** Testing a point hypothesis against a diffuse
  alternative manufactures enormous Bayes factors — a single observation
  driving a posterior above 0.99 or below 0.01 is the symptom. Match the
  level of commitment on both sides of every comparison (point against
  point, composite against composite) unless the theory genuinely demands a
  point value. The pinned CHEATSHEET carries a section on this trap; follow
  it whenever a distribution-level comparison enters a graph.

## Graph construction rules

- **One idea, one package, outside the tool repository.** Each idea's graph
  lives at `<project_root>/argument-graphs/<idea_slug>-gaia/` in the external
  research project — a directory for the reasoning graphs, kept distinct from
  the engine's `idea-store/` (which holds the idea nodes and their posteriors).
  Packages must never be created inside a development repository; the tool
  repository holds only the skeleton template and test fixtures.
  `gaia build init` creates a nested git repository inside the package; the
  scaffold removes that fresh, zero-commit repository so the research
  project's own version control can track the package. A pre-existing
  package with real git history is a different matter: absorb it into the
  project deliberately (move its history or accept the loss explicitly) —
  never delete a non-empty repository automatically.

- **The top-level claim is named and exported as `worth`, and gets no prior.**
  The package module must declare `__all__ = ["worth"]`; after compilation,
  `worth` must be the sole knowledge node marked `exported`. This is checked by
  extraction, both renderers, and writeback. A package with an empty or
  different `__all__` is refused with a migration command instead of producing
  an unmarked conclusion. The module variable name must be `worth` (extraction
  keys on that label). Do not
  `register_prior` it — or any claim — unless a genuine external prior
  exists. A `register_prior` justification follows the same anchor
  discipline as every other number: it ends with `anchor: <artifact
  reference or resolvable URI>`, and a prior whose anchor fails review is
  deleted so the claim reverts to MaxEnt. No prior means MaxEnt, by design.

- **Reader roles are explicit metadata, not prose matching.** The scaffold
  marks `worth` with `reader_role="conclusion"` and its five structural
  criteria with `reader_role="criterion"`. Existing scientifically sound
  packages without these markers remain readable as long as they carry
  substantive infer rationales; the renderer labels their intermediate nodes
  conservatively. Role detection does not inspect prose. Independently, each
  of the six reasoning claims must state an idea-specific research proposition:
  extraction, rendering, reporting, and writeback reject empty claims and the
  scaffold's exact generic axis sentences. This prevents a comparison-axis
  definition from being presented as the explanation of an idea's score.

- **Standard wiring per sub-criterion.** Anchored facts enter as
  `observe()`; an `infer()` updates the sub-criterion claim from each
  observation with a graded likelihood pair; a second `infer()` updates
  `worth` from the sub-criterion. Enter each piece of evidence once. If one
  source bears on several criteria, do not give it several scored paths: state
  the combined consequence in one composite observation and route it through
  one criterion path. Gaia 0.5.0a4 has no correlated-likelihood factor that
  would make several paths safe.

  Copying one observation into several observed nodes does not create
  independent evidence, and routing one observed node through several claims
  still duplicates its effect on `worth`. The extractor groups observations
  by their authored `evidence_family` rather than by prose or path strings and
  refuses either form of parallel worth-connected likelihood update. During
  review, compare family ids and anchors across criteria; assigning different
  ids to paraphrases of one source is a contract violation, not a route around
  the gate.

- **Mutual exclusivity is pairwise.** In gaia-lang 0.5.0a4, `exclusive()`
  takes exactly two claims; three or more raises `TypeError`. Expand mutual
  exclusivity over n rival hypotheses into all pairwise `exclusive()` calls.
  This is a recorded upstream limitation (see the issue log section).

- **Trial computation evidence.** A small-scale feasibility or
  order-of-magnitude result enters as `observe()` only after passing the
  existing numerical disciplines (`numerical-reliability-gate`; independent
  reproduction check from `research-harness`). Its anchor names the passed
  computation artifact. An unchecked number does not enter the graph, however
  encouraging it looks.

- **Revival is just new evidence.** When new literature, a passed trial
  computation, or a tournament result arrives for a dormant idea, append the
  corresponding `observe()` and `infer()` statements, re-run inference, and
  write the posterior back. No revival approval step exists; the posterior
  moves because evidence moved. One store mechanic: if the node was archived,
  first move it back into the machine via `node.set_lifecycle` — to
  `needs_refresh` when it carries a posterior history, to `candidate` when it
  never had one (the engine enforces exactly this split, and forbids jumping
  from the archive straight to `admitted`) — then the fresh writeback
  re-admits it through the normal derivation.

## Absorbing pairwise tournament results

Tournament execution is external; a finished match arrives as a
`pairwise_match_v1` artifact with a match identifier and a panel verdict.
Absorb it into both contestants' graphs:

```python
match_win = observe(
    "The idea won its pairwise match against a rival idea under the "
    "committed judging criteria.",
    rationale=(
        "evidence_family: pairwise-match-id; correlation_model: single; "
        "anchor: pairwise_match_v1 <match_id> at <artifact path>"
    ),
)
infer(
    match_win,
    hypothesis=worth,
    p_e_given_h=0.90, p_e_given_not_h=0.09,   # unanimous verdict: substantial
    rationale=(
        "reader_reasoning: A unanimous panel verdict under committed "
        "criteria raises worth. "
        "anchor: pairwise_match_v1 <match_id> at <artifact path>"
    ),
)
```

- **Unanimous verdicts** (all judges one way, e.g. 4-0 or 3-0) use the
  substantial grade (ratio 10).
- **Split verdicts** (e.g. 3-1 or 2-1) use the weak grade (ratio 3).
- **Ties** produce no update at all.
- **Symmetry.** The loser's graph absorbs the same match with the same grade
  in the lowering direction (swap the two conditional probabilities). A win
  raises, a loss lowers, with equal strength.
- The `rationale` must carry `reader_reasoning:`, cite the match artifact path, and end with
  `anchor: pairwise_match_v1 <match_id>`; a match result with no artifact
  reference is not absorbable.

## Workflow: three scripts

The scripts under `scripts/` do the mechanical part; judgment — what to
claim, which grade, which anchor — stays with the author. The inference and
writeback path is standard-library-only and drives Gaia or the RPC caller as
subprocesses. The optional detailed-page renderer uses the presentation
dependencies listed above. Every script prints a readable diagnosis when a
stage fails.

1. **Generate the package skeleton.**

   ```bash
   python3 scripts/gaia_package_scaffold.py \
     --slug my-idea --dest <project_root>/argument-graphs
   ```

   Runs `gaia build init my-idea-gaia` in the destination and writes the
   skeleton module: a `worth` claim plus the five sub-criterion claims, with
   comment guidance restating the likelihood grades, the anchor-note format,
   and the pairwise-exclusivity rule. The skeleton compiles as generated
   (all claims MaxEnt, no evidence). Refuses to overwrite an existing
   package. The freshly generated package is then hardened: the
   zero-commit nested git repository from `gaia build init` is removed,
   and the generated environment pins are retargeted to
   `gaia-lang==0.5.0a4` / Python 3.12 (gaia's own template still writes
   `>=0.4.4` / 3.13 — a recipe observed to break silently in the field);
   the init-time package venv is dropped so the next gaia run re-syncs it
   from the corrected pins.

2. **Run inference and extract the posterior.**

   ```bash
   python3 scripts/run_infer_and_extract.py \
     --package <project_root>/argument-graphs/my-idea-gaia
   ```

   First runs a static discipline scan over the authored modules. A
   statement passes only when the scan can *prove* it follows the
   discipline: probability pairs must be literal numbers in the three
   grades; rationales and `register_prior` justifications must be literal
   strings ending with an `anchor: <reference>` note; a raising
   strong-grade `downstream_reach` update must carry its `domains:`
   clause; statement names are resolved through import aliases, and
   referencing a statement name without calling it (assignment aliasing,
   passing it around) is itself a violation. Anything unprovable —
   non-literal grades, notes, or prior values, wrapper indirection — is a
   violation, not a pass (better to reject a sound graph than to pass an
   unsound one), and the script refuses to extract a posterior.
   `--allow-discipline-warnings` downgrades violations as an explicit,
   logged exception for deliberate exploration, but the extracted
   reference is then prefixed `exploration-only:` and the writeback
   script refuses to store it. What the scan does and does not promise is
   stated plainly under "Scan boundary" below; deliberately obfuscated
   authoring is review's business, and review stays the authority on
   substance either way. Then runs `gaia build compile`, verifies that `worth`
   is the unique exported conclusion, runs `gaia build check`,
   `gaia run infer`, and — unless `--no-render` — renders a viewable graph
   after inference: an interactive single-file `argument-graph.html` built
   by the sibling `render_argument_graph.py` (no external dependency; open
   it in a browser). Every card on that page carries the node's full
   statement — short variable labels appear only as card headers — and each
   `infer` is drawn as an arrow from the evidence into the claim it updates:
   solid blue when it raises belief, dashed warm red when it lowers it, line
   width and a weak/substantial/strong chip showing the likelihood ratio.
   Clicking a card opens the statement, posterior, likelihoods P(e|h) and
   P(e|not h), rationale, and source anchors. HTTP(S) anchors and existing
   in-project Markdown anchors become links; project-root-relative artifact
   paths are rewritten relative to the graph page, while missing, escaping,
   non-Markdown, and engine references remain plain text. The run also emits a static
   `starmap.svg` when Graphviz is on `PATH`, Gaia's exact
   `docs/detailed-reasoning.md`, and — when the optional browser-render
   dependencies are present — a self-contained
   `docs/detailed-reasoning.html`. Its first section follows observed evidence
   through the authored likelihood rationales and criterion updates into
   `worth`; direct and indirect lowering paths are rendered alongside support.
   Pandoc supplies Markdown structure and
   MathML; Mermaid CLI runs once per Pandoc-identified Mermaid code block
   under strict security and its static SVG is embedded as an image data URI;
   source raw HTML is removed from the Pandoc AST and the final fragment is
   sanitized by nh3. Ordinary relative and HTTP(S) links survive, while
   active URL schemes, event handlers, and scripts do not. No browser-side
   renderer, server, CDN, or network request is needed when the page is opened
   directly as a local file. Gaia 0.5.0a4 can legitimately emit no Mermaid
   block when a package has one ordered module and one exported conclusion.
   In that zero-diagram case only, the renderer reconstructs Gaia's raw
   generative graph from the already validated compiled IR, marks the unique
   exported root, and states the premise/background arrow semantics. Unknown
   references or malformed graph records fail closed. If Gaia emitted any
   Mermaid block, the renderer preserves that source path and continues to
   require exactly one exported-root marker across the upstream diagrams.

   The interactive graph has one visible-probability formatter: three decimal
   places on the initial canvas and in every JavaScript-created tooltip or
   detail panel. The page embeds
   `argument_graph_reader_surface_contract_v1`, which names the initial canvas,
   edge tooltip, node detail panel, and expanded legend as covered reader
   states. The contract also inventories the current button and form-control
   IDs. The current renderer has no filter control; browser acceptance compares
   the live control inventory with that contract, so adding a control requires
   the contract and event-driven coverage to name every filtered state before
   the new control is accepted. The same rule applies to any future expandable
   reader text.

   Static source or initial-DOM inspection is only a quick drift check. It
   cannot support a claim that all visible values comply, because click,
   pointer, filter, and expansion handlers can create new text after load.
   Acceptance therefore executes the generated page in a browser, triggers a
   node click, edge tooltip, and legend expansion, and checks the resulting
   visible text against the embedded formatter contract. A different renderer
   is outside this renderer's evidence: its validator must provide equivalent
   interaction-state evidence or fail closed rather than inheriting this
   page's result.

   Each card's detail panel links to the exact case-preserving node fragment
   in the HTML page. The renderer accepts only Gaia's explicit empty anchor
   immediately preceding the matching node heading; missing, duplicated, or
   mismatched anchors fail closed, so a later same-named human heading cannot
   move the target. The link is generation-bound by
   `docs/detailed-reasoning.manifest.json`, which carries deterministic
   SHA-256 digests of the current `.gaia/beliefs.json`, the exact compiled
   `.gaia/ir.json`, the exact Markdown bytes, and the generated HTML bytes.
   `render_argument_graph.py` independently recomputes all four; missing,
   malformed, stale, unreadable,
   or escaping artifacts produce no `doc_href`. The HTML is installed first
   and the manifest last, so a crash can leave only an unverifiable page,
   never an authorized stale one. Rendering
   never gates the posterior — a render failure is reported and skipped. It
   then parses `.gaia/beliefs.json` (the entry labelled
   `worth`) and `.gaia/ir.json` (observation supports, one per
   `observe()` statement), and prints:

   ```json
   {
     "value": 0.8499,
     "evidence_count": 2,
     "gaia_package_ref": "project://argument-graphs/my-idea-gaia#sha256:..."
   }
   ```

   `run_infer_and_extract.py` performs the browser-render order automatically.
   If `detailed-reasoning.md` is intentionally edited or enriched later, use
   the standalone renderer and preserve this order:

   ```bash
   uv run --script scripts/render_detailed_reasoning.py --package <package>
   python3 scripts/render_argument_graph.py \
     --package <package> --project-root <project_root>
   ```

   In words: edit or sync Markdown, regenerate detailed HTML and its manifest,
   then regenerate the argument graph. An edited Markdown file immediately
   invalidates the old HTML link; callers never hand-write a checksum or
   manifest. Missing uv, Pandoc, or Mermaid CLI, a failed PEP 723 environment,
   or any failed rendering stage removes or withholds the HTML authority, so
   the argument graph remains usable but exposes no broken deep-dive link.

   `gaia_package_ref` is machine-portable by construction: research
   projects sync across machines, so the reference names the package
   RELATIVE to the project root — the nearest ancestor containing
   `.nullius/`, or an explicit `--project-root` — never as this machine's
   absolute path (path segments are percent-encoded; the form satisfies
   the engine's URI typing of this field). The `#sha256:` fragment is the
   SHA-256 digest of the exact `.gaia/ir.json` bytes. It deliberately does not
   reuse Gaia 0.5.0a4's internal `ir_hash`: that upstream hash does not change
   when an exported marker changes. Hashing the complete compiled artifact
   binds graph structure and exported-root metadata in one reference. A later
   recompile that changes either yields a visibly different reference.

   **Migration for packages and references created before this contract:** set
   `__all__ = ["worth"]` in the package module, replace all six scaffold claim
   sentences with idea-specific research propositions, prefix every substantive
   literal `infer()` explanation with `reader_reasoning:`, and add
   `evidence_family` plus `correlation_model` declarations to every
   `observe()` rationale before its trailing anchor. Merge every correlated or
   redundant family into one composite observation and one likelihood-bearing
   path, then re-run
   `run_infer_and_extract.py`. Old references used Gaia's
   narrower internal hash and are intentionally rejected by current
   writeback; re-extraction emits the complete-artifact pin and refreshes the
   render bindings.

3. **Write the posterior back to the idea store.**

   ```bash
   python3 scripts/run_infer_and_extract.py --package <pkg> |
   python3 scripts/posterior_writeback.py \
     --campaign-id <campaign> --node-id <node> \
     --store-root <store_root> \
     --literature-survey-json <artifact_dir>/literature_survey_v1.json \
     --close-prior-matrix-json <artifact_dir>/close_prior_matrix.json \
     --posterior-report-md <artifact_dir>/posterior_report_v1.md \
     --idea-rpc <repo>/packages/idea-engine/bin/idea-rpc.mjs
   ```

   Sends `{"method": "node.set_posterior", "params": {campaign_id, node_id,
   idempotency_key, posterior, literature_coverage}, "store_root": ...}` on
   stdin to the idea-engine thin RPC caller and fails loudly on an error
   response.

   The engine enforces the idea lifecycle machine around this write. A node
   fresh from seed import or generation sits in `candidate`, where posterior
   writes are rejected — declare the review first, so admission has a logged,
   timestamped start in the store:

   ```bash
   echo '{"method":"node.set_lifecycle","params":{"campaign_id":"<campaign>",
     "node_id":"<node>","idempotency_key":"<key>",
     "lifecycle_state":"admission_review"},"store_root":"<store_root>"}' \
     | node <repo>/packages/idea-engine/bin/idea-rpc.mjs
   ```

   After a legal write the engine moves the lifecycle itself: a `current`
   posterior yields `admitted` (the only state strict ranking and allocation
   sample), anything else yields `needs_refresh`. Never set those two states
   by hand around a writeback — the derivation is the single writer that
   keeps lifecycle and stored posterior consistent. If the admission gate
   instead finds named evidence missing, record it on the node as
   `admission_blocked` with an `activation_condition` (kind
   `required_evidence`) rather than leaving the review open. Before anything is sent, `posterior_writeback.py` runs the
   close-prior validator over the survey, matrix, and report. It refuses a
   missing close-prior matrix, missing critique search, one-sided
   above-weakest `tension_resolution`, metadata-only Gaia anchors,
   untriangulated core-paper identity, failed source-fidelity audit, or a
   `coverage_incomplete` result that claims current/allocation-eligible status.
   `coverage_incomplete` may be written only as provisional guidance; it can be
   allocation eligible only when `--allow-exploratory-allocation` is passed and
   the matrix declares the allocation exploratory.

   The matrix and compiled graph are checked together. A singular
   `tension_resolution.grade` must equal the actual raising likelihood grade
   targeting that criterion in `.gaia/ir.json`. When several raising updates
   target it, `grade` records the strongest and
   `raising_likelihood_grades` records the exact multiset; a missing, weaker,
   stronger, or incomplete declaration is refused. Matrix
   `posterior_status` describes readiness for the write being attempted, not
   pre-rebuild history: `stale` cannot enter current writeback even when
   coverage is saturated and `allocation_eligible` is false. Rebuild the
   matrix and graph, then declare the resulting readiness state.

   The `project://` reference is also verified against the project on disk: it
   must resolve under the project root (the
   nearest ancestor of `--store-root` containing `.nullius/`, or an
   explicit `--project-root`) and its `#sha256:` pin must match the exact bytes
   of the package's current `.gaia/ir.json`; the same check requires `worth` to
   remain its unique exported conclusion. A reference nobody could follow, or
   one whose graph changed after extraction, is refused with the refresh
   command (re-run `run_infer_and_extract.py`) instead of being archived
   into the store. The idempotency key is a deterministic digest of
   campaign, node, package reference, value, and evidence count: retrying
   the same write is a no-op, while any real change produces a new key.
   Two consequences of that default are surfaced rather than left silent:

   - When the posterior is identical to an **earlier** write (for example,
     restoring a node to a previous state after intervening revisions), the
     key collides with that write's key and the store **replays** the
     archived response — no new revision is created. The script detects
     this via the response's `idempotency.is_replay` and warns on stderr
     instead of reporting a fresh write.
   - When a fresh revision is the intent despite identical content, pass
     `--new-write`, which mints a unique key for the invocation. To retry
     that specific write after a failure, reuse the key it printed via
     `--idempotency-key` rather than repeating `--new-write`.

## Report — `posterior_report_v1`

The scripts above produce the machine artifacts; the human-facing summary is
`posterior_report_v1.md` in the idea's artifact directory. Its job is to make
the posterior *auditable at a glance*: it states the admission verdict and
route, each sub-criterion's grade and its anchor, and the final posterior with
its `gaia_package_ref`. Display the posterior value rounded to three decimals
for humans, while the exact machine value remains in JSON artifacts and the
idea-store snapshot. When the render step produced one, it also links the
viewable argument graph (`argument-graph.html`) so a reader can open the
graph the posterior came from. That page shows every statement in full and
each update's direction and strength, so it doubles as a reading surface for
a human weighing the idea — but the durable decision record (what raises the
posterior, what lowers it, what evidence is still required) belongs in this
report and in the portfolio status report below, which travel with the
project and survive re-renders.

The report must include a close-prior matrix. For every close prior, list the
reference/link, read status, source link, locator, same-scope status, supported
sub-propositions, weakened novelty claims, identity-triangulation verdict,
source-fidelity audit status, and whether the posterior should be marked
stale/provisional. The matrix also records critique-search queries and top
hits, same-scope exclusion reasons for closest hits, and reviewer notes for
negative novelty claims. Missing matrix, missing critique search, or missing
reviewer gate means the report is provisional and cannot support allocation
eligibility.

**Every anchor in the report is rendered as a link, not bare text.** An anchor
earns its place only if a reader can reach it in one click:

- A resolvable URI (a literature record, preprint, DOI, or dataset record) is
  written as a Markdown link to that URI — carried through verbatim from the
  grounding report's `evidence_uris`, never downgraded to a plain identifier
  string.
- Repo-local artifact links are written as Markdown targets that resolve from
  the report file's own directory, never as absolute local paths or local-file
  URLs. Do not hand-write project-root-looking targets such as
  `ideas/gaia/<slug>-gaia/argument-graph.html` inside a report stored under
  `artifacts/<campaign>/`: standard Markdown will resolve that as
  `artifacts/<campaign>/ideas/...`. Let the normalizer compute the correct
  report-relative target, such as
  `../../ideas/gaia/<slug>-gaia/argument-graph.html`
  from `artifacts/<campaign>/posterior_report_v1.md`, or `posterior.json` for
  a sibling artifact in the same directory. The posterior's `gaia_package_ref`
  keeps its `project://...#sha256:` pin intact in machine artifacts — the pin
  is what ties the reference to the exact compiled graph — while the human
  Markdown link is just the click target.
- Bare or backticked local file paths and literature identifiers in reports are
  not allowed as plain text. File mentions must be Markdown links; arXiv, DOI,
  and INSPIRE recid mentions must link to their source records. Use fenced code
  blocks only for commands or literal snippets, not as a way to present a report
  artifact/source path.
- Before committing or sharing a Codex-readable report, normalize the
  human-facing posterior display and repo-local links with:

  ```bash
  python3 skills/idea-posterior/scripts/normalize_report_posteriors.py \
    <report.md>
  python3 skills/idea-posterior/scripts/normalize_report_links.py \
    --project-root <project_root> <report.md>
  ```
  Use the same command with `--check` in gates or writeback preflight; it fails
  if a local Markdown link is still unnormalized, broken, absolute-local, or
  otherwise not clickable from the report file's location.
- The `anchor: <...>` notes echoed into the report follow the same rule: a
  resolvable reference inside an anchor note is a link.

A report that names a source or artifact without a link has failed its one job
— the reachability question below cannot then be answered without the very
re-search the report existed to save.

## Portfolio status report — one page across all ideas

Per-idea posterior reports answer "why is this idea's posterior what it is";
the portfolio question — *which idea deserves the next unit of effort, and
what is holding each one back* — needs one page across all nodes. Build it
from the campaign store instead of hand-maintaining a status table that must
be rewritten every time evidence lands:

```bash
python3 skills/idea-posterior/scripts/build_portfolio_status_report.py \
  --nodes <idea-store>/campaigns/<campaign_id>/nodes_latest.json \
  --project-root <project_root> \
  --out-md artifacts/<campaign>/portfolio_status_report_v1.md \
  --out-json artifacts/<campaign>/portfolio_status_report_v1.json
```

Per node it renders: lifecycle state, literature-coverage status, the store
posterior (three decimals for humans; exact machine values in the JSON
artifact), a relative link to the graph page, and — read directly from the
compiled graph — the top support and top lowering drivers, each with its
signed strength and the author's recorded reasoning. Two disciplines are
built in:

- **Score families stay separate.** The table shows the store posterior with
  its recorded status; nodes without a written-back posterior show a
  placeholder, never a triage number promoted into the posterior column.
- **Stale posteriors are flagged, not trusted.** When the graph's current
  root belief no longer equals the stored posterior, the row is flagged: the
  stored value is historical evidence, not allocation guidance, until the
  posterior is re-extracted and written back.

Run the same two normalizers on this report as on posterior reports, and
check deterministic Markdown hygiene (math escaping, link portability) with
the markdown-hygiene skill before committing or handing the report to
another host.

## Review: audit anchors, not scores

A graph review never argues with the posterior directly; it attacks the
inputs. The extraction script's static scan stops mechanical slips
(off-grade pairs, missing trailing anchor notes) before a posterior can be
extracted at all; everything it cannot decide statically it hands to the
reviewer.

**Scan boundary.** The static scan is a review aid, not a security
boundary. It is designed to catch accidental and casual discipline breaks —
an off-grade likelihood pair, a missing anchor note, a grade written through
a variable, a statement aliased and called indirectly, a strong-grade
`downstream_reach` update missing its domain list — including the near
variants of those (an alias built from a module attribute such as
`i = lang.infer`, a reach claim identified by its `title="downstream_reach"`
rather than its variable name, a domains clause pushed inside the trailing
anchor note). It does **not** promise to catch deliberately obfuscated
authoring: code that hides a statement behind `exec`/`eval`, computed or
dynamically built attribute names, a wrapper re-bound through a non-Load
context, or runtime dispatch can defeat any static reader and is out of the
scan's guarantee by design. Those cases are the human reviewer's
responsibility, backed by version-controlled history. Chasing ever-deeper
static evasions is unbounded and is not attempted; the scan is held to the
accidental-and-casual bar above, and substance — whether an anchor is true,
a grade appropriate, a set of domains genuinely independent — is always the
reviewer's call.

- Run `gaia review calibration`: it ranks claims by the shift between prior
  and posterior. Large-shift claims are where wrong grades do the most
  damage — question them first. Observed claims sit near zero shift because
  observation pins them; that is expected, not suspicious.
- Run `gaia review package` for structural findings (unsupported strategies,
  statements with no recorded justification) and fix what it reports.
- For every `infer()`, the reviewer asks three questions:
  1. What justifies this likelihood grade — why this grade and not the one
     below it?
  2. Is the anchor reachable — does the cited artifact or URI exist, and
     does its content actually establish the stated fact (route through
     `claim-grounding` when in doubt)? In `posterior_report_v1` the anchor
     must be a rendered link, not a bare identifier: a reference the reader
     cannot click through is not a reachable anchor.
  3. Were both conditionals thought about — `p_e_given_h` *and*
     `p_e_given_not_h`? A grade chosen by imagining only the
     hypothesis-true world is not a considered grade.
- For every raising `tension_resolution` update, the reviewer checks the
  declared `resolution_evidence` class against the anchored content. A source
  that only documents the open tension discharges admission relevance, not
  resolution; an unexecuted plan discharges neither full nor partial
  resolution.
- Across criteria, the reviewer groups observations by statement, anchor, and
  causal origin. Repeated or paraphrased copies of one fact are traced to one
  shared source and are not accepted as independent updates.
- Any number that fails these questions is deleted and the claim reverts to
  MaxEnt; then inference is re-run and the posterior re-extracted. Review
  outcomes change graphs, not narratives.
- For a `tension_resolution` update graded above the weakest grade, the
  reviewer confirms the survey engaged the critique — its tensions section
  surfaces a genuine challenge or competing resolution, not only papers that
  assume or apply the idea. A one-sided pool (all confirming, none contesting)
  is `coverage_incomplete`: only an actual challenge or competing resolution
  supports a grade above weakest; a documented null result records the debt but
  the tension stays at the weakest grade. This is a reviewer judgement by
  design — one-sidedness cannot be decided by a survey's shape alone, so no
  machine field stands in for reading the pool.

## Activation conditions

Some ideas depend on something that does not exist yet: a tool reaching
readiness, a dataset being released, a project stage arriving, a trial
computation finishing. Do not build a speculative full graph for these. Park
the node in `waiting_activation` via `node.set_lifecycle` with the condition
recorded on it (the engine requires the condition for this state and clears
it on exit):

```json
{
  "activation_condition": {
    "kind": "tool_readiness | data_release | stage_reached | exploratory_computation | other",
    "description": "what must become true, stated so a third party can check it",
    "satisfied": false
  }
}
```

Distinguish this from `admission_blocked`: waiting is about the external
world (nothing to do but wait and check), while blocked means the admission
gate named evidence that WORK must produce (kind `required_evidence`). When
the condition is met, the activation monitor in `idea-allocation` prints the
engine-legal return transition (a waiting node with no posterior returns to
`candidate`; with a current, coverage-eligible posterior to `admitted`;
otherwise to `needs_refresh` — a satisfied blocked node re-enters
`admission_review`). Then run the admission gate (if not already passed),
build the graph, and proceed normally. Monitoring activation conditions is
the portfolio scheduler's job, not this skill's; this skill only defines the
judgment and the record format.

## Gaia issue log

Gaia is pinned and pre-release; defects and limitations surface during use.
Every one found while following this skill is recorded in the maintainer
issue log (default: `~/.nullius-dev/trackers/gaia-issues.md`) as a table row:
date, symptom, minimal reproduction, affected workstream, workaround, status.
The mainline work continues on the documented workaround; escalation of
blocking defects follows the process note at the top of that file. Known at
pin time: `exclusive()` accepts exactly two claims (TypeError with three or
more), worked around by pairwise expansion as specified above.
