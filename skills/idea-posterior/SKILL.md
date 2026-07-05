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
only. All three scripts below enforce the same check and print this install
recipe when the executable is missing or mismatched.

After creating a package, run `gaia sdk` inside it once and read the generated
`gaia-sdk/CHEATSHEET.md`: it is the authoritative statement reference for the
pinned version, including the Lindley–Jeffreys section referenced below.

## Admission gate — before any graph is built

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

## Sub-criterion decomposition

The worth of an admitted idea decomposes into five sub-criteria. Each becomes
one claim in the graph; each names its evidence sources so that every update
has a place to point.

| Sub-criterion | Question it answers | Evidence sources |
|---|---|---|
| `tension_resolution` | How far does the idea resolve an anchored open tension? Conceptual and structural tensions carry the same weight as numerical ones: incompatible frameworks, an approximation in use without justification, a missing mechanism. | tensions section of the literature survey artifact (`literature_survey_v1`) |
| `downstream_reach` | How long is the chain of downstream problems the idea feeds, and how broad is its generality — how many phenomenon domains does it unify or apply to? Breadth is a first-class dimension, rewarded non-linearly through the grade-promotion rule below. Frameworks with the generality of relativity or quantum mechanics serve only to calibrate the top of the breadth scale. | idea card claims, each with `support_type` and `evidence_uris` |
| `mechanism_insight` | How much new, testable mechanistic understanding does the idea supply? | idea card claims; survey artifact |
| `testability_timing` | Can the idea be tested, and is the verification window open now — data, tools, and comparison points available on a relevant horizon? | idea card claims |
| `verification_cost` | Is the first decisive check cheap and bounded? Only the belief-relevant part enters the graph: evidence that the check is cheap raises feasibility belief. The budget decision itself stays outside. | the idea card's `minimal_compute_plan` field; trial computation artifacts |

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

- **Every number carries an anchor note.** The `rationale` of every
  `observe()` and `infer()` ends with `anchor: <artifact reference or
  resolvable URI>`. Review asks one question of every number: what does this
  trace to? A number whose anchor cannot be produced or does not survive
  `claim-grounding` is deleted — not adjusted, deleted — and the affected
  claim falls back to MaxEnt (Gaia's default when no prior or evidence
  binds). MaxEnt is the correct failure mode: honest ignorance beats
  fabricated precision.

- **Grade promotion for breadth.** A `downstream_reach` update may use the
  strong grade (ratio 30) only when the reach claim has anchored impact
  chains in at least three independent phenomenon domains, each domain
  anchored separately. Single-domain reach uses the weak or substantial
  grade. Counting domains means counting anchors, one per domain — an
  unanchored domain does not count.

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
  lives at `<project_root>/ideas/gaia/<idea_slug>-gaia/` in the external
  research project. `gaia build init` creates a nested git repository inside
  the package directory, so packages must never be created inside a
  development repository; the tool repository holds only the skeleton
  template and test fixtures.

- **The top-level claim is named `worth` and gets no prior.** The module
  variable name must be `worth` (extraction keys on that label). Do not
  `register_prior` it — or any claim — unless a genuine external prior
  exists. A `register_prior` justification follows the same anchor
  discipline as every other number: it ends with `anchor: <artifact
  reference or resolvable URI>`, and a prior whose anchor fails review is
  deleted so the claim reverts to MaxEnt. No prior means MaxEnt, by design.

- **Standard wiring per sub-criterion.** Anchored facts enter as
  `observe()`; an `infer()` updates the sub-criterion claim from each
  observation with a graded likelihood pair; a second `infer()` updates
  `worth` from the sub-criterion. Enter each piece of evidence once — if two
  observations share a cause, model the cause as one claim and connect it
  once (the CHEATSHEET's double-counting rule).

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
  moves because evidence moved.

## Absorbing pairwise tournament results

Tournament execution is external; a finished match arrives as a
`pairwise_match_v1` artifact with a match identifier and a panel verdict.
Absorb it into both contestants' graphs:

```python
match_win = observe(
    "The idea won its pairwise match against a rival idea under the "
    "committed judging criteria.",
    rationale="anchor: pairwise_match_v1 <match_id> at <artifact path>",
)
infer(
    match_win,
    hypothesis=worth,
    p_e_given_h=0.90, p_e_given_not_h=0.09,   # unanimous verdict: substantial
    rationale=(
        "Unanimous panel verdict under committed criteria. "
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
- The `rationale` must cite the match artifact path and end with
  `anchor: pairwise_match_v1 <match_id>`; a match result with no artifact
  reference is not absorbable.

## Workflow: three scripts

The scripts under `scripts/` do the mechanical part; judgment — what to
claim, which grade, which anchor — stays with the author. All are standard
library only and drive Gaia or the RPC caller as subprocesses; all print a
readable diagnosis (including the pinned install recipe) when a stage fails.

1. **Generate the package skeleton.**

   ```bash
   python3 scripts/gaia_package_scaffold.py \
     --slug my-idea --dest <project_root>/ideas/gaia
   ```

   Runs `gaia build init my-idea-gaia` in the destination and writes the
   skeleton module: a `worth` claim plus the five sub-criterion claims, with
   comment guidance restating the likelihood grades, the anchor-note format,
   and the pairwise-exclusivity rule. The skeleton compiles as generated
   (all claims MaxEnt, no evidence). Refuses to overwrite an existing
   package.

2. **Run inference and extract the posterior.**

   ```bash
   python3 scripts/run_infer_and_extract.py \
     --package <project_root>/ideas/gaia/my-idea-gaia
   ```

   Runs `gaia build compile`, `gaia build check`, `gaia run infer`, then
   parses `.gaia/beliefs.json` (the entry labelled `worth`) and
   `.gaia/ir.json` (observation supports, one per `observe()` statement) and
   prints:

   ```json
   {
     "value": 0.8499,
     "evidence_count": 2,
     "gaia_package_ref": "/abs/path/to/my-idea-gaia#sha256:..."
   }
   ```

   `gaia_package_ref` embeds the IR hash, so the reference pins the exact
   compiled graph the posterior came from; a later re-run on a changed graph
   yields a visibly different reference.

3. **Write the posterior back to the idea store.**

   ```bash
   python3 scripts/run_infer_and_extract.py --package <pkg> |
   python3 scripts/posterior_writeback.py \
     --campaign-id <campaign> --node-id <node> \
     --store-root <store_root> \
     --idea-rpc <repo>/packages/idea-engine/bin/idea-rpc.mjs
   ```

   Sends `{"method": "node.set_posterior", "params": {campaign_id, node_id,
   idempotency_key, posterior}, "store_root": ...}` on stdin to the
   idea-engine thin RPC caller and fails loudly on an error response. The
   idempotency key is a deterministic digest of campaign, node, package
   reference, value, and evidence count: retrying the same write is a no-op,
   while any real change produces a new key.

## Review: audit anchors, not scores

A graph review never argues with the posterior directly; it attacks the
inputs.

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
     `claim-grounding` when in doubt)?
  3. Were both conditionals thought about — `p_e_given_h` *and*
     `p_e_given_not_h`? A grade chosen by imagining only the
     hypothesis-true world is not a considered grade.
- Any number that fails these questions is deleted and the claim reverts to
  MaxEnt; then inference is re-run and the posterior re-extracted. Review
  outcomes change graphs, not narratives.

## Activation conditions

Some admitted ideas depend on something that does not exist yet: a tool
reaching readiness, a dataset being released, a project stage arriving, a
trial computation finishing. Do not build a speculative full graph for these.
Record an activation condition on the idea instead and leave it in the
waiting state:

```json
{
  "activation_condition": {
    "condition_type": "tool_readiness | data_release | stage_reached | trial_computation_done",
    "description": "what must become true, stated so a third party can check it",
    "check_hint": "where or how to check, e.g. an artifact path or release page"
  }
}
```

When the condition is met, run the admission gate (if not already passed),
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
