# Idea Islands Dashboard (v1)

NOT_FOR_CITATION

Generated at (UTC): 2026-02-17T00:17:49Z

Registry: `artifacts/islands/idea_island_registry_v1.json`
Progress stream: `artifacts/islands/idea_island_progress_v1.jsonl`

## Islands

| island_id | status | title | last_event (ts,type) | current_status | next_actions (top3) |
|---|---|---|---|---|---|
| island-positivity-kernels | IN_PROGRESS | Positivity-kernel bootstrap for pion GFFs (mainline) | 2026-02-16T23:00:46Z ARTIFACT_ADDED | IN_PROGRESS | Integrate the dispersion-coupled SOCP mainline results (v18 grid200 full-interior + residual audit) into the report with an explicit robustness envelope (cross-solver spread + constraint residuals) and reproduction commands.; Sync the GitHub Project board card body with the newest mainline artifacts (v18 run + robustness summaries) and store preflight+postupdate snapshots in idea-generator review bundles.; Close the normalization/mapping loop: derive an auditable map from the GTB D0 form-factor objects (j_T=T^{++} projection / 2^{++} partial wave) to the pion GFF A^pi(t) convention used in the report; encode at least one regression check (A^pi(0)=1, projector factors). |
| island-subtractions-scan | PLANNED | Subtraction/normalization sensitivity scan (parallel island) | 2026-02-16T00:00:00Z NOTE | PLANNED | From seed papers, enumerate which subtractions/normalizations are fixed vs. assumed, and extract any recommended ranges/priors.; Define a minimal scan grid that is laptop-feasible and covers plausible ranges.; Decide what output summary becomes an auditable artifact (tables + plots + logs). |
| island-ecosystem-benchmarks | IN_PROGRESS | Ecosystem benchmarks + external positivity constraints (pion GFFs) | 2026-02-16T13:46:40Z ARTIFACT_ADDED | IN_PROGRESS | Integrate the first benchmark overlay (lattice monopole fit from arXiv:2307.11707) into the report with an explicit note that it is a benchmark-only sanity check (no lattice constraints used).; Extend benchmark coverage with at least one additional pion-only reference curve family (e.g., meson-dominance fits arXiv:2405.07815 / 2411.10354), keeping coupled-channel items flagged as out-of-scope for execution.; Translate at least one additional external positivity-style input into a machine-checkable constraint candidate (or record it as a failed approach with evidence), e.g., D-term mechanical-stability inequalities or other EMT density sign constraints discussed in 2412.00848. |
