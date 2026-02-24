# knowledge_graph/ (Claim DAG + Evidence)

Project: <PROJECT_NAME>

This directory structures *what we believe* into a Claim DAG and registers reproducible outputs as Evidence (an evidence manifest).

Minimal file set (MVP):

- `claims.jsonl`: one claim per line (JSON object)
- `edges.jsonl`: one edge per line (claim↔claim dependency/support/competition/contradiction)
- `evidence_manifest.jsonl`: one evidence item per line (JSON object; points to artifact paths, literature anchors, etc.)

Relation to the execution layer (Trajectory):

- `team/trajectory_index.json` records per-run tag outputs and gate status
- `claims.jsonl.linked_trajectories` links claims to run tags

## Recommended workflow (minimum viable)

1. Use `mechanisms/00_pre_task_clarifier.md` to lock the profile and DoD
2. Add 1–3 core claims to `claims.jsonl` (status `draft` or `active`)
3. Register this run’s outputs (derivations/figures/tables/code outputs/literature excerpts) to `evidence_manifest.jsonl`
4. Use `edges.jsonl` to make dependencies and competing hypotheses explicit (prefer forks over oral convergence)
5. (Optional gate) enable Claim DAG validation in `research_team_config.json` (e.g. `features.claim_graph_gate=true`)

## Visualization (optional)

- After convergence, `knowledge_graph/claim_graph.dot` may be generated.
- If Graphviz is installed, `claim_graph.png` or `claim_graph.svg` may be generated.
- Toggles: `claim_graph_render.enabled`; formats: `claim_graph_render.format = png/svg/both/dot`.
- Readability: `claim_graph_render.max_label` (0 = no truncation); `claim_graph_render.wrap_width`.
- Convention:
  - In `edges.jsonl`, `type:"requires"` means “source depends on target (target is a prerequisite)”.
  - `type:"supersedes"` means “source replaces target”.
  - For workflow-forward readability, rendering may display these as `target -> source` and label them as `enables` / `superseded by`.
  - Other edge types render in their original direction.

## Modeling tips (make the graph represent the real decision tree)

- Do not only encode “milestone results”. Also encode key **risks/decisions** as claims (e.g., numerical instability, PV prescription choice, competing tail models).
- Use `fork/competitor/contradicts/supersedes` edge types to represent branching alternatives and falsification paths instead of stuffing everything into one long claim text.

## Gates (optional, deterministic)

When enabled, these scripts run in the `run_team_cycle.sh` preflight phase:

- `check_claim_graph.py`: validate `claims.jsonl` + `edges.jsonl` schema and consistency
- `check_evidence_manifest.py`: validate `evidence_manifest.jsonl` schema (optionally check local path existence)
- `check_claim_trajectory_link.py`: ensure `linked_trajectories` tags exist in `team/trajectory_index.json`

All gates are deterministic: clear CLI, defined inputs/outputs, defined exit codes, and fixable error messages.

