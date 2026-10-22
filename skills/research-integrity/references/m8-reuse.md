Command, script and asset paths in this reference are relative to the `research-integrity` skill directory. Markdown links are relative to this reference. Cross-section names follow the routes in [SKILL.md](../SKILL.md).

### M8: reinvention_over_available_reuse

**Definition.** Hand-building — or brute-forcing — a numerical method, solver,
quadrature, robust primitive, or analysis that the project's own upstream toolkit,
or a sibling / related project, already provides in a more robust or efficient
form, because the toolkit and siblings were not re-scanned before the work
started. A long project inherits its dependencies at one moment; those
dependencies keep evolving, and the project drifts into reimplementing what
upstream now offers.

**Signs.**
- About to write a new numerical kernel, quadrature, contour, root-finder, or
  fitting routine "from scratch" for a heavy / production computation.
- The project is built on a shared toolkit with its own commit history since the
  code was inherited, but there has been no recent reuse-scan of it.
- A recurring numerical difficulty (an instability, slowness, an artifact) is
  being patched locally, when it is a generic problem the toolkit or a sibling
  project has likely already solved.
- Sibling / related projects solve the same class of problem and have not been
  checked.
- A delegation brief named prior art, but for one or more named assets the
  implementation has no call sites and no pre-implementation deviation record.

**Minimum disconfirming check.** BEFORE each heavy / production computation, or
before building any reusable computational method, grep the upstream toolkit's
source AND every sibling / related project for the capability: by function name,
by the problem it solves, and by the sibling's own calls into the toolkit.
A name-level grep alone is not the scan: its first deliverable is the
architecture-level answer — how each prior source solved the same end-to-end
problem, in which files / functions / methods, and whether that architecture
transfers — recorded per source as an adopt-or-reject verdict with measured
reasons. This is
a **per-heavy-computation / per-method-build gate**, not a once-at-project-start or
merely periodic check: the trigger is "I am about to start a heavy or production
computation, or build a reusable computational method." Then reuse the existing
robust / efficient implementation, or record explicitly why it does not fit before
hand-rolling. When a sibling project already solves the same class of
computational problem, prefer adapting its proven approach over a fresh
implementation.

**Reviewer-side check.** If the work under review was dispatched with a
brief that named prior art, verify, for each named asset, that the
implementation's call sites — or the approved pre-implementation deviation
record — exist **before** assessing results. A deviation justification first
written after the replacement exists is post-hoc self-justification by an
invested party; require an independent clean-room review of it before
folding in any of the replacement's results. The dispatch-side contract is
the `research-team` *Reuse-or-deviate gate*.

**Tools that help.** A cross-repo grep of the toolkit `src/` and the sibling
repos; the `julia-perf` skill (efficient-code reuse); a reuse-vs-build multi-modal
sweep before building. Not machine-enforceable — it is an explicit pre-flight
step; the `research-team` *Reuse-or-deviate gate* makes the reuse-or-record
obligation reviewable at convergence.
