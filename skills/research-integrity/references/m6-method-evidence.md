Command, script and asset paths in this reference are relative to the `research-integrity` skill directory. Markdown links are relative to this reference. Cross-section names follow the routes in [SKILL.md](../SKILL.md).

### M6: methodology_fabrication

**In-cycle exemption.** If you are inside an active `research-team`
cycle and the Reproducibility Capsule has bound this milestone's
method steps to artifact pointers under `artifacts/runs/<run_id>/`
(the capsule mandate), the per-boundary M6 walk reduces to:
*verify the capsule's method-to-artifact bindings cover the
boundary-crossing claim*. Do not re-trace bindings the capsule
already locked in. If you are outside a research-team cycle or the
claim crosses a method step that is not in the capsule's binding
list, perform the full check below.

**Definition.** Describing an experimental protocol, derivation, or
training procedure that did not actually run in the form described.
The method section reads cleanly but the code, configs, or run
artifacts do not back it.

**Signs.**
- "We used X-method with Y-cutoff" but no committed file imports
  X-method or sets Y-cutoff.
- Hyperparameter list is plausible but no run artifact records those
  exact values.
- Method step is described in `research_notebook.md` but no
  `artifacts/runs/<run_id>/` entry shows it.
- Two methodology versions exist in the project history and the
  drafted text describes the merged one that never actually executed.

**Minimum disconfirming check.** For each methodology step in the
work crossing the boundary, produce the exact code path or command,
plus the run artifact under `artifacts/runs/<run_id>/` that records
its execution. If the step is not in the artifact, it did not happen.

**Tools that help.** `nullius run` with explicit `run_id`,
the `artifacts/runs/<run_id>/` manifest, `research-team`
Reproducibility Capsule, and an evidence-binding/export step linking
manuscript claims to `artifacts/runs/<run_id>/`.
