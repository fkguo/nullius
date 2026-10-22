Command, script and asset paths in this reference are relative to the `review-swarm` skill directory. Markdown links are relative to this reference. Cross-section names follow the routes in [SKILL.md](../SKILL.md).

### Execution adversary (mandatory for correctness-critical / method-precondition reviews)

A read-only review is a *static read*; it cannot confirm a runtime property. When a review must establish
that a method's load-bearing precondition actually holds — an operator identity (commutation with a
projector/symmetrizer, Hermiticity, self-adjointness, idempotency, unitarity, variational/Galerkin-subspace
invariance), a numerical invariant, or a true-operator eigen-residual — at least **one reviewer must take an
"execution adversary" role**: load the artifact and *execute* the disconfirming test at the **production
scale/configuration**, not statically read the code. Give that reviewer real execution access (a host-native
sub-agent with run/Bash, or a sandbox that can execute), and record in `meta.json` whether each reviewer
**executed vs. only read** the precondition checks. A swarm in which *no* reviewer executed the precondition
is a **static-only** swarm and must be labeled as such — it does **not** count as a precondition pass. (A
static read can certify code shape; only execution at the production scale can certify that a discretized /
implemented property actually holds — a property can read as correct and still fail numerically above the
minimal size.)
