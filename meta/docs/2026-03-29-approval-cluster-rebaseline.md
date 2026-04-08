# Approval Cluster Rebaseline (2026-03-29)

This note is the checked-in, source-grounded audit support for the 2026-03-29 approval-cluster governance lane. Its purpose is to replace stale “pending from zero” wording for `NEW-02`, `NEW-03`, `NEW-04`, and `M-22` with today’s live-source truth.

## Scope

Audited live surfaces:

- `meta/schemas/gate_spec_v1.schema.json`
- `packages/shared/src/gate-registry.ts`
- `packages/shared/src/__tests__/gate-registry.test.ts`
- `meta/schemas/approval_packet_v1.schema.json`
- `packages/orchestrator/src/orch-tools/run-read-model.ts`
- `packages/orchestrator/src/orch-tools/approval.ts`
- `packages/orchestrator/src/computation/approval.ts`
- `packages/hep-autoresearch/src/hep_autoresearch/toolkit/approval_packet.py`
- `packages/hep-autoresearch/src/hep_autoresearch/orchestrator_cli.py`
- `packages/hep-autoresearch/src/hep_autoresearch/toolkit/report_renderer.py`
- `packages/hep-autoresearch/tests/test_approval_packet.py`
- `packages/hep-autoresearch/tests/test_report_renderer.py`

## Truth Map

| Item | Today truth | Source-grounded basis | Residual gap |
|---|---|---|---|
| `NEW-02` | Done | `approval_packet.py` already renders/writes `packet_short.md`, `packet.md`, `approval_packet_v1.json`; `_request_approval()` calls `write_trio(...)`; tests lock short/full/json behavior and short-packet line cap | No reopen needed for trio generation itself. Any future Python retirement / TS unification is a different bounded slice. |
| `NEW-03` | Done | `cmd_approvals_show` is live in `orchestrator_cli.py`; parser wiring is live; tests cover `short`, `full`, `json`, empty/no-match/error cases | TS orchestrator has read/list consumers, not a direct `show` CLI replacement. |
| `NEW-04` | Done | `report_renderer.py` already renders Markdown/LaTeX from run artifacts; CLI wiring is live; tests cover summaries, headline numbers, audit pointers, and TeX output | Current live shape is a minimal inline renderer with artifact-reference tables, not the template-heavy shape originally sketched in plan prose. |
| `M-22` | Pending, partially landed | `gate_spec_v1` schema is live; `packages/shared/src/gate-registry.ts` exports generic `GateSpec` entries plus `getGateSpec` / `validateGates`; tests lock taxonomy/fail-closed/audit-required invariants | Non-test cross-component consumers are still sparse. The remaining work is rollout/mapping completeness, not schema/registry creation. |

## Authority Boundary

Today’s approval/report authority is intentionally split:

- Python legacy front-door authority:
  - `packages/hep-autoresearch/src/hep_autoresearch/toolkit/approval_packet.py`
  - `packages/hep-autoresearch/src/hep_autoresearch/orchestrator_cli.py`
  - `packages/hep-autoresearch/src/hep_autoresearch/toolkit/report_renderer.py`
  - This is the only live generic surface for approval trio rendering, `approvals show`, and `report render`.

- TS orchestrator bounded approval authority:
  - `packages/orchestrator/src/computation/approval.ts` already writes a bounded A3 trio using the same artifact names.
  - `packages/orchestrator/src/orch-tools/run-read-model.ts` and `packages/orchestrator/src/orch-tools/approval.ts` already consume `approval_packet_v1.json` for list/approve/reject flows.
  - This is not yet a full replacement for the Python legacy `approvals show` / `report render` surfaces.

- Shared GateSpec substrate:
  - `meta/schemas/gate_spec_v1.schema.json`
  - `packages/shared/src/gate-registry.ts`
  - `packages/shared/src/__tests__/gate-registry.test.ts`
  - The substrate is live, but the broad “all components map to GateSpec v1” rollout is not yet complete.

## Key Evidence

- `NEW-02` live trio:
  - `packages/hep-autoresearch/src/hep_autoresearch/toolkit/approval_packet.py` documents the three-artifact contract and implements `write_trio(...)`.
  - `packages/hep-autoresearch/src/hep_autoresearch/orchestrator_cli.py` imports `write_trio` and uses it in the approval request path.
  - `packages/hep-autoresearch/tests/test_approval_packet.py` verifies trio creation, short-packet line cap, JSON fields, and CLI output modes.

- `NEW-03` live CLI:
  - `packages/hep-autoresearch/src/hep_autoresearch/orchestrator_cli.py` defines `cmd_approvals_show`.
  - The same file wires the parser defaults for `approvals show`.
  - `packages/hep-autoresearch/tests/test_approval_packet.py` covers `short` / `full` / `json`, plus empty/no-match/malformed packet behavior.

- `NEW-04` live report renderer:
  - `packages/hep-autoresearch/src/hep_autoresearch/toolkit/report_renderer.py` defines `collect_run_result`, `render_md`, and `render_tex`.
  - `packages/hep-autoresearch/src/hep_autoresearch/orchestrator_cli.py` defines `cmd_report_render`.
  - `packages/hep-autoresearch/tests/test_report_renderer.py` covers summary extraction, headline numbers, audit pointers, SHA256 completeness, and LaTeX output.

- `M-22` partial live substrate:
  - `meta/schemas/gate_spec_v1.schema.json` already locks generic gate taxonomy and a default `fail-closed` posture.
  - `packages/shared/src/gate-registry.ts` already exports provider-neutral gate entries and helpers.
  - `packages/shared/src/__tests__/gate-registry.test.ts` locks uniqueness, taxonomy, fail-closed posture, and audit-required invariants.
  - Consumer usage remains sparse enough that this is not yet a truthful “all components mapped” closeout.

## Residual Bounded Follow-up

1. Keep `M-22` open only for cross-component consumer/mapping rollout and explicit authority adoption beyond the registry/test surface. The next slice should be tracked via live source/tests and current front-door status docs, not deleted prompt-path authority.
2. If/when Python legacy retirement or TS front-door repointing resumes, treat generic trio/show/report replacement as a separate bounded migration slice. Do not retroactively claim the current bounded TS A3 support already finished that work.
3. Do not reopen this cluster into a runtime rewrite: the governance correction here is about truthful status mapping, not about rebuilding approval/report infrastructure from scratch.
