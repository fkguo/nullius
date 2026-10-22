Command, script and asset paths in this reference are relative to the `review-swarm` skill directory. Markdown links are relative to this reference. Cross-section names follow the routes in [SKILL.md](../SKILL.md).

### Artifact-integration reviewer (for rendered research artifacts)

When a workflow turns source-read notes into a rendered artifact — for example an interactive literature
graph, slide deck, dashboard, or browsable note bundle — include at least one reviewer whose task is to
inspect the **current rendered artifact and its source files**, not merely the synthesis prose. This reviewer
checks integration failures that source-fidelity review alone cannot see: broken relative links, missing
images, unrendered math, non-clickable connected references, stale note paths, layout collisions, and a
renderer that displays placeholders or filenames instead of the intended evidence.

Write reusable workflows in terms of reviewer roles and capabilities, not specific model names. A concrete
run may choose particular models, but the skill or project contract should say "independent cross-model
artifact reviewer" or "source-fidelity reviewer" unless a user explicitly pins a model for that run.
After any artifact fix, rerun the reviewers on the fixed artifact before calling convergence
(the confirmation round follows the [gate-loop discipline](gate-loop-and-freshness.md): delta-scoped by default,
severity-graded, one round per fix batch).

### Reference-reproduction reviewer (mandatory for "matches / reproduces a published value" claims)

A claim that a result **reproduces / matches / agrees with a published reference value** is a *quantitative*
claim a static read cannot certify — reading the prose only confirms the prose. When a packet asserts such a
match, at least **one reviewer must take a "reference-reproduction" role** and cover three distinct dimensions
that a correctness / methodology / honesty review routinely passes over:

- **D1 — recompute and compare.** **Compute the claimed observable on a comparable state / regime /
  configuration and compare to the published number numerically** — do not accept a qualitative "same order
  of magnitude / same sign / right scale" assertion, and do not accept the citation as if citing the source
  proved the match. Compare **term by term** where the claim is term-level (a net total can agree while
  individual contributions are suppressed or sign-flipped). **An order-of-magnitude same-direction
  discrepancy, or a sign reversal, is a BLOCKING finding, not a pass.** Give this reviewer real execution
  access (a host-native sub-agent with run/Bash, or an executing sandbox) when the comparison requires
  computation.
- **D2 — the independent cross-check did not silently lapse.** Confirm that any cross-validation evaluates
  the *same* model with independently constructed and executed checks. Record the actual method and shared-failure risks. A structurally **different-model** engine, or a check valid only in
  a degenerate / limit regime, must be **labeled as a different-model / limit-regime comparison, not
  presented as validation**; and when no apples-to-apples independent check is feasible, the **absence is
  recorded as an explicit stated limitation** rather than an established cross-check being allowed to
  silently disappear.
- **D3 — the transcription axis was gated (when the source's own prescription is claimed).** When the
  packet claims the source's *own prescription* was solved or reproduced, confirm it demonstrates that the
  model being solved IS the source's — the frame-map / elementwise-identity / as-printed-run evidence
  defined by the `research-integrity` *Reference-reproduction fidelity* D3 dimension and
  `numerical-reliability-gate` G2's shared-model-definition clause. Internal convergence and cross-method
  agreement cannot certify this (every internal route shares the model definition), so such a reproduction
  claim with an ungated transcription axis is unverified regardless of how well the numbers agree. A
  comparison that does not assert the source's prescription owes no frame map — a different-model
  comparison is covered by D2's labeling, and a comparison against measured/experimental data is a
  measurement comparison, not a model reproduction.

Record in `meta.json` whether a reviewer **computed-and-compared vs. only read** the match assertion; a
swarm in which *no* reviewer recomputed the claimed observable on the comparable state is a **static-only**
swarm for that claim and must be labeled as such — it does **not** count as a reference-match pass.
Cross-model-family diversity strengthens this gate. Pair it with `numerical-reliability-gate` **G8** (the
compute-and-compare gate, returning `reference_mismatch` on an order-of-magnitude or sign gap) and the
`research-integrity` *Reference-reproduction fidelity* dimensions.

### Independent-recomputation reviewer (mandatory for load-bearing structural claims)

A cross-family review that only re-reads evidence supplied by the claimant is an **argument audit**, not a
verification: its "confirm" can sit entirely inside the claimant's blind spot, because the supplied
evidence may probe the wrong axis altogether. The reference-reproduction reviewer above is the special
case where a published number anchors the check; the general contract covers any **load-bearing
structural claim** — a claim about what a computed object *is* (its shape, degeneracy structure, scaling,
sign structure, convergence behavior) on which downstream conclusions rest. For such a claim, at least
at least two evidence lanes must independently construct or derive and execute the check,
receiving **only the problem statement and the raw inputs** — never the claimant's answer, evidence selection, or initial judgment. Same or similar sound methods may count; method diversity, model-family diversity, execution independence and input independence are separate dimensions. An explicit project shared-failure risk may require a different mechanism that tests that risk. Record in `meta.json`
**which axis the independent recomputation actually probed** (what it could have falsified); a
recomputation whose probed axis does not intersect the claim's load-bearing axis leaves the swarm
static-only for that claim, and it must be labeled as such rather than counted as a verification pass.
