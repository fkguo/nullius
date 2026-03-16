from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass
from typing import Any, Protocol

from idea_core.engine.store import EngineStore
from idea_core.engine.utils import payload_hash, utc_now_iso

from .control_plane import HeparControlPlaneStore, TeamPlan, WorkOrder, WorkResult


class RuntimeExecutor(Protocol):
    def execute_work_order(self, work_order: WorkOrder, *, role_message: str) -> WorkResult: ...


@dataclass(frozen=True)
class _PlannedRole:
    index: int
    stage: int
    role_id: str
    role_spec: dict[str, Any]


class TeamRoleOrchestrator:
    """M4.4 orchestration runner for Team/Role execution and merge-back artifacts."""

    def __init__(
        self,
        *,
        control_plane_store: HeparControlPlaneStore,
        runtime_executor: RuntimeExecutor,
        idea_store: EngineStore,
    ) -> None:
        self.control_plane_store = control_plane_store
        self.runtime_executor = runtime_executor
        self.idea_store = idea_store

    @staticmethod
    def _dedupe(values: list[str]) -> list[str]:
        seen: set[str] = set()
        out: list[str] = []
        for value in values:
            if value in seen:
                continue
            seen.add(value)
            out.append(value)
        return out

    @staticmethod
    def _role_stage(role_spec: dict[str, Any]) -> int:
        raw = role_spec.get("stage", 0)
        try:
            return int(raw)
        except (TypeError, ValueError):
            return 0

    @staticmethod
    def _safe_name(value: str) -> str:
        return (
            value.replace("/", "_")
            .replace("\\", "_")
            .replace(" ", "_")
            .replace(":", "_")
        )

    def _plan_roles(self, team_plan: TeamPlan) -> list[_PlannedRole]:
        planned: list[_PlannedRole] = []
        for index, role_spec in enumerate(team_plan.roles):
            role_id = str(role_spec.get("role_id", "")).strip()
            if not role_id:
                raise ValueError(f"team_plan role[{index}] missing role_id")
            planned.append(
                _PlannedRole(
                    index=index,
                    stage=self._role_stage(role_spec),
                    role_id=role_id,
                    role_spec=role_spec,
                )
            )
        return planned

    def _build_work_order(
        self,
        *,
        team_plan: TeamPlan,
        role: _PlannedRole,
        campaign_id: str,
        idea_id: str,
        island_id: str,
        node_id: str,
        input_artifacts: list[str],
        output_schema_ref: str,
        tool_policy: dict[str, Any],
        budget: dict[str, Any],
        deadline: str,
        priority: str,
    ) -> WorkOrder:
        work_key = self._safe_name(f"{team_plan.team_id}-{node_id}-{role.index:03d}-{role.role_id}")
        return WorkOrder(
            work_id=work_key,
            campaign_id=campaign_id,
            idea_id=idea_id,
            island_id=island_id,
            role_id=role.role_id,
            input_artifacts=input_artifacts,
            output_schema_ref=output_schema_ref,
            tool_policy=tool_policy,
            budget=budget,
            idempotency_key=f"{team_plan.team_id}:{node_id}:{role.index}:{role.role_id}",
            deadline=deadline,
            priority=priority,
        )

    def _execute_role(self, *, work_order: WorkOrder, role_message: str) -> WorkResult:
        try:
            return self.runtime_executor.execute_work_order(work_order, role_message=role_message)
        except Exception as exc:  # CONTRACT-EXEMPT: NEW-R03b fail-closed runtime boundary for executor bugs
            self.control_plane_store.append_ledger_event(
                "team_orchestration.role_failed",
                work_id=work_order.work_id,
                role_id=work_order.role_id,
                error_type=type(exc).__name__,
                error_message=str(exc),
            )
            return WorkResult(
                work_id=work_order.work_id,
                status="failed",
                outputs=[],
                summary=f"{type(exc).__name__}: {exc}",
                provenance={"runtime": "orchestrator_error", "role": work_order.role_id},
            )

    def _execute_parallel(
        self,
        *,
        planned_roles: list[tuple[_PlannedRole, WorkOrder, str]],
    ) -> list[tuple[_PlannedRole, WorkResult]]:
        if not planned_roles:
            return []
        by_index: dict[int, tuple[_PlannedRole, WorkResult]] = {}
        with ThreadPoolExecutor(max_workers=max(1, len(planned_roles))) as pool:
            futures = {
                pool.submit(self._execute_role, work_order=work_order, role_message=role_message): planned_role
                for planned_role, work_order, role_message in planned_roles
            }
            for future in as_completed(futures):
                planned_role = futures[future]
                by_index[planned_role.index] = (planned_role, future.result())
        return [by_index[idx] for idx in sorted(by_index.keys())]

    def _execute_sequential(
        self,
        *,
        planned_roles: list[tuple[_PlannedRole, WorkOrder, str]],
    ) -> list[tuple[_PlannedRole, WorkResult]]:
        results: list[tuple[_PlannedRole, WorkResult]] = []
        for planned_role, work_order, role_message in planned_roles:
            results.append(
                (
                    planned_role,
                    self._execute_role(work_order=work_order, role_message=role_message),
                )
            )
        return results

    def run_team_plan(
        self,
        *,
        team_plan: TeamPlan,
        campaign_id: str,
        idea_id: str,
        island_id: str,
        node_id: str,
        input_artifacts: list[str],
        role_messages: dict[str, str],
        tool_policy: dict[str, Any],
        budget: dict[str, Any],
        deadline: str,
        priority: str = "medium",
        output_schema_ref: str = "schema://work-result-v1",
    ) -> dict[str, Any]:
        plan_record = self.control_plane_store.register_team_plan(team_plan)
        self.control_plane_store.append_ledger_event(
            "team_orchestration.started",
            team_id=team_plan.team_id,
            campaign_id=campaign_id,
            node_id=node_id,
            coordination_policy=team_plan.coordination_policy,
            clean_room=team_plan.clean_room,
            team_plan_ref=plan_record["artifact_ref"],
            team_plan_hash=plan_record["artifact_hash"],
        )

        planned_roles = self._plan_roles(team_plan)
        base_inputs = self._dedupe([str(uri) for uri in input_artifacts])
        role_results: list[tuple[_PlannedRole, WorkResult]] = []
        shared_outputs: list[str] = []
        blocked_stage: int | None = None
        stage_gate_policy = str(team_plan.merge_policy.get("stage_gate", "all_must_succeed"))

        def build_role_input(role: _PlannedRole, inherited_outputs: list[str]) -> list[str]:
            role_inputs = [str(uri) for uri in role.role_spec.get("input_artifacts", [])]
            if team_plan.clean_room:
                return self._dedupe(base_inputs + role_inputs)
            return self._dedupe(base_inputs + role_inputs + inherited_outputs)

        if team_plan.coordination_policy == "parallel":
            parallel_roles = [
                (
                    role,
                    self._build_work_order(
                        team_plan=team_plan,
                        role=role,
                        campaign_id=campaign_id,
                        idea_id=idea_id,
                        island_id=island_id,
                        node_id=node_id,
                        input_artifacts=build_role_input(role, shared_outputs),
                        output_schema_ref=output_schema_ref,
                        tool_policy=tool_policy,
                        budget=budget,
                        deadline=deadline,
                        priority=priority,
                    ),
                    str(role_messages.get(role.role_id, f"run role {role.role_id}")),
                )
                for role in planned_roles
            ]
            role_results.extend(self._execute_parallel(planned_roles=parallel_roles))
        elif team_plan.coordination_policy == "sequential":
            for role in planned_roles:
                work_order = self._build_work_order(
                    team_plan=team_plan,
                    role=role,
                    campaign_id=campaign_id,
                    idea_id=idea_id,
                    island_id=island_id,
                    node_id=node_id,
                    input_artifacts=build_role_input(role, shared_outputs),
                    output_schema_ref=output_schema_ref,
                    tool_policy=tool_policy,
                    budget=budget,
                    deadline=deadline,
                    priority=priority,
                )
                role_result = self._execute_role(
                    work_order=work_order,
                    role_message=str(role_messages.get(role.role_id, f"run role {role.role_id}")),
                )
                role_results.append((role, role_result))
                if not team_plan.clean_room:
                    shared_outputs = self._dedupe(shared_outputs + [str(uri) for uri in role_result.outputs])
        else:  # stage_gated
            stages = sorted({role.stage for role in planned_roles})
            for stage in stages:
                stage_roles = [role for role in planned_roles if role.stage == stage]
                inherited_outputs = list(shared_outputs)
                staged = [
                    (
                        role,
                        self._build_work_order(
                            team_plan=team_plan,
                            role=role,
                            campaign_id=campaign_id,
                            idea_id=idea_id,
                            island_id=island_id,
                            node_id=node_id,
                            input_artifacts=build_role_input(role, inherited_outputs),
                            output_schema_ref=output_schema_ref,
                            tool_policy=tool_policy,
                            budget=budget,
                            deadline=deadline,
                            priority=priority,
                        ),
                        str(role_messages.get(role.role_id, f"run role {role.role_id}")),
                    )
                    for role in stage_roles
                ]
                stage_results = self._execute_parallel(planned_roles=staged)
                role_results.extend(stage_results)
                if not team_plan.clean_room:
                    for _, stage_result in stage_results:
                        shared_outputs = self._dedupe(shared_outputs + [str(uri) for uri in stage_result.outputs])
                if stage_gate_policy == "all_must_succeed" and any(result.status != "ok" for _, result in stage_results):
                    blocked_stage = stage
                    self.control_plane_store.append_ledger_event(
                        "team_orchestration.stage_blocked",
                        team_id=team_plan.team_id,
                        campaign_id=campaign_id,
                        node_id=node_id,
                        stage=stage,
                        gate_policy=stage_gate_policy,
                    )
                    break

        role_result_payload: list[dict[str, Any]] = []
        for role, role_result in role_results:
            role_result_payload.append(
                {
                    "role_id": role.role_id,
                    "stage": role.stage,
                    "work_id": role_result.work_id,
                    "status": role_result.status,
                    "summary": role_result.summary,
                    "outputs": list(role_result.outputs),
                    "provenance": role_result.provenance,
                }
            )

        if blocked_stage is not None:
            orchestration_status = "blocked"
        elif role_result_payload and all(result["status"] == "ok" for result in role_result_payload):
            orchestration_status = "ok"
        elif role_result_payload:
            orchestration_status = "failed"
        else:
            orchestration_status = "failed"

        merged_payload = {
            "team_id": team_plan.team_id,
            "campaign_id": campaign_id,
            "idea_id": idea_id,
            "node_id": node_id,
            "coordination_policy": team_plan.coordination_policy,
            "clean_room": team_plan.clean_room,
            "merge_policy": team_plan.merge_policy,
            "status": orchestration_status,
            "blocked_stage": blocked_stage,
            "role_results": role_result_payload,
            "generated_at": utc_now_iso(),
        }
        merged_name = self._safe_name(f"{team_plan.team_id}-{node_id}-team-review.json")
        merged_ref = self.idea_store.write_artifact(
            campaign_id,
            "team_reviews",
            merged_name,
            merged_payload,
        )

        self.control_plane_store.append_ledger_event(
            "team_orchestration.merged",
            team_id=team_plan.team_id,
            campaign_id=campaign_id,
            node_id=node_id,
            merged_artifact_ref=merged_ref,
            merged_artifact_hash=payload_hash(merged_payload),
            role_count=len(role_result_payload),
            blocked_stage=blocked_stage,
            status=orchestration_status,
        )
        self.control_plane_store.append_ledger_event(
            "team_orchestration.completed",
            team_id=team_plan.team_id,
            campaign_id=campaign_id,
            node_id=node_id,
            status=orchestration_status,
            role_count=len(role_result_payload),
            merged_artifact_ref=merged_ref,
        )

        return {
            "team_id": team_plan.team_id,
            "campaign_id": campaign_id,
            "idea_id": idea_id,
            "node_id": node_id,
            "status": orchestration_status,
            "blocked_stage": blocked_stage,
            "coordination_policy": team_plan.coordination_policy,
            "merged_artifact_ref": merged_ref,
            "role_results": role_result_payload,
        }
