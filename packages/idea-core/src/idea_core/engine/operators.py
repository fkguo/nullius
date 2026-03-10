from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Protocol, runtime_checkable


@dataclass(frozen=True)
class OperatorContext:
    campaign_id: str
    step_id: str
    tick: int
    island_id: str
    parent_node_id: str


@dataclass(frozen=True)
class OperatorOutput:
    operator_id: str
    operator_family: str
    backend_id: str
    rationale_title: str
    rationale: str
    thesis_statement: str
    hypothesis: str
    claim_text: str
    trace_inputs: dict[str, Any]
    trace_params: dict[str, Any]
    evidence_uris_used: list[str]


@runtime_checkable
class SearchOperator(Protocol):
    operator_id: str
    operator_family: str
    backend_id: str

    def run(self, context: OperatorContext, *, parent_node: dict[str, Any]) -> OperatorOutput:
        ...


def _parent_rationale(node: dict[str, Any]) -> str:
    rationale = node.get("rationale_draft", {})
    text = rationale.get("rationale")
    if isinstance(text, str) and text:
        return text
    return "seed rationale"


def _parent_title(node: dict[str, Any]) -> str:
    rationale = node.get("rationale_draft", {})
    text = rationale.get("title")
    if isinstance(text, str) and text:
        return text
    return "Untitled seed"


class DummyExpandBridgeOperator:
    operator_id = "dummy.expand.bridge"
    operator_family = "DummyExpand"
    backend_id = "dummy.backend.alpha"

    def run(self, context: OperatorContext, *, parent_node: dict[str, Any]) -> OperatorOutput:
        parent_title = _parent_title(parent_node)
        parent_rationale = _parent_rationale(parent_node)
        return OperatorOutput(
            operator_id=self.operator_id,
            operator_family=self.operator_family,
            backend_id=self.backend_id,
            rationale_title=f"Bridge expansion of {parent_title}",
            rationale=(
                "Bridge operator deterministically expands a parent rationale into a nearby "
                f"variant for island {context.island_id}: {parent_rationale}"
            ),
            thesis_statement=(
                "Use a bridge-style perturbation to extend the parent hypothesis while "
                "preserving baseline assumptions."
            ),
            hypothesis=(
                f"Bridge expansion tick-{context.tick} remains testable with the current "
                "observable set."
            ),
            claim_text=(
                "Bridge expansion predicts a measurable shift relative to the parent "
                "baseline under the same observable set."
            ),
            trace_inputs={
                "parent_node_id": context.parent_node_id,
                "step_id": context.step_id,
                "tick": context.tick,
                "style": "bridge",
            },
            trace_params={
                "deterministic_policy": "round_robin_v1",
                "template_version": "bridge-v1",
                "backend_id": self.backend_id,
            },
            evidence_uris_used=["https://example.org/dummy/bridge"],
        )


class DummyConstraintShiftOperator:
    operator_id = "dummy.constraint.shift"
    operator_family = "DummyConstraint"
    backend_id = "dummy.backend.beta"

    def run(self, context: OperatorContext, *, parent_node: dict[str, Any]) -> OperatorOutput:
        parent_title = _parent_title(parent_node)
        parent_rationale = _parent_rationale(parent_node)
        return OperatorOutput(
            operator_id=self.operator_id,
            operator_family=self.operator_family,
            backend_id=self.backend_id,
            rationale_title=f"Constraint shift from {parent_title}",
            rationale=(
                "Constraint-shift operator deterministically perturbs one assumption in "
                f"island {context.island_id} while retaining auditability: {parent_rationale}"
            ),
            thesis_statement=(
                "Shift one boundary condition to probe robustness and identify a sharper "
                "kill criterion."
            ),
            hypothesis=(
                f"Constraint shift tick-{context.tick} yields a separable outcome under the "
                "current observable plan."
            ),
            claim_text=(
                "Constraint shift predicts a failure boundary that should appear before "
                "the bridge expansion regime."
            ),
            trace_inputs={
                "parent_node_id": context.parent_node_id,
                "step_id": context.step_id,
                "tick": context.tick,
                "style": "constraint_shift",
            },
            trace_params={
                "deterministic_policy": "round_robin_v1",
                "template_version": "constraint-v1",
                "backend_id": self.backend_id,
            },
            evidence_uris_used=["https://example.org/dummy/constraint-shift"],
        )


def default_search_operators() -> tuple[SearchOperator, ...]:
    return (
        DummyExpandBridgeOperator(),
        DummyConstraintShiftOperator(),
    )


class HepAnomalyAbductionOperator:
    operator_id = "hep.anomaly_abduction.v1"
    operator_family = "AnomalyAbduction"
    backend_id = "hep.operator.backend.anomaly"

    def run(self, context: OperatorContext, *, parent_node: dict[str, Any]) -> OperatorOutput:
        parent_title = _parent_title(parent_node)
        parent_rationale = _parent_rationale(parent_node)
        return OperatorOutput(
            operator_id=self.operator_id,
            operator_family=self.operator_family,
            backend_id=self.backend_id,
            rationale_title=f"Anomaly abduction from {parent_title}",
            rationale=(
                "Treat the parent node as an observed tension/anomaly and abduct a minimal, "
                f"auditable explanation in island {context.island_id}. Parent: {parent_rationale}"
            ),
            thesis_statement=(
                "If an anomaly is real, propose the smallest structural change that explains it "
                "and yields a crisp kill criterion."
            ),
            hypothesis=(
                f"Anomaly-abduction tick-{context.tick} implies a correlated signature "
                "that remains testable with the current observable set."
            ),
            claim_text=(
                "A minimal explanatory mechanism should predict at least one correlated observable "
                "that was not used to motivate the anomaly."
            ),
            trace_inputs={
                "parent_node_id": context.parent_node_id,
                "step_id": context.step_id,
                "tick": context.tick,
                "style": "anomaly_abduction",
                "island_id": context.island_id,
            },
            trace_params={
                "deterministic_policy": "island_index_v1",
                "template_version": "anomaly-abduction-v1",
                "backend_id": self.backend_id,
            },
            evidence_uris_used=["urn:hepar:operator-template:anomaly-abduction-v1"],
        )


class HepSymmetryOperator:
    operator_id = "hep.symmetry_operator.v1"
    operator_family = "SymmetryOperator"
    backend_id = "hep.operator.backend.symmetry"

    def run(self, context: OperatorContext, *, parent_node: dict[str, Any]) -> OperatorOutput:
        parent_title = _parent_title(parent_node)
        parent_rationale = _parent_rationale(parent_node)
        return OperatorOutput(
            operator_id=self.operator_id,
            operator_family=self.operator_family,
            backend_id=self.backend_id,
            rationale_title=f"Symmetry-based reformulation of {parent_title}",
            rationale=(
                "Generate a symmetry-motivated variant that compresses the hypothesis into a "
                f"cleaner invariance statement for island {context.island_id}. Parent: {parent_rationale}"
            ),
            thesis_statement=(
                "Symmetry constraints often dictate the allowed operators/couplings; leverage "
                "this to prune the hypothesis space early."
            ),
            hypothesis=(
                f"Symmetry operator tick-{context.tick} yields a selection rule that should hold "
                "if the hypothesis is internally consistent."
            ),
            claim_text=(
                "A candidate symmetry (exact or approximate) implies at least one forbidden/allowed "
                "transition pattern that can be used as a hard kill criterion."
            ),
            trace_inputs={
                "parent_node_id": context.parent_node_id,
                "step_id": context.step_id,
                "tick": context.tick,
                "style": "symmetry",
                "island_id": context.island_id,
            },
            trace_params={
                "deterministic_policy": "island_index_v1",
                "template_version": "symmetry-v1",
                "backend_id": self.backend_id,
            },
            evidence_uris_used=["urn:hepar:operator-template:symmetry-v1"],
        )


class HepLimitExplorerOperator:
    operator_id = "hep.limit_explorer.v1"
    operator_family = "LimitExplorer"
    backend_id = "hep.operator.backend.limit"

    def run(self, context: OperatorContext, *, parent_node: dict[str, Any]) -> OperatorOutput:
        parent_title = _parent_title(parent_node)
        parent_rationale = _parent_rationale(parent_node)
        return OperatorOutput(
            operator_id=self.operator_id,
            operator_family=self.operator_family,
            backend_id=self.backend_id,
            rationale_title=f"Limit exploration around {parent_title}",
            rationale=(
                "Probe a controlled limit (decoupling, large-N, soft/collinear, etc.) to "
                f"extract a robust prediction for island {context.island_id}. Parent: {parent_rationale}"
            ),
            thesis_statement=(
                "Well-chosen limits expose invariants and consistency conditions that should survive "
                "model details."
            ),
            hypothesis=(
                f"Limit explorer tick-{context.tick} predicts a scaling relation that can be checked "
                "with a lightweight consistency computation."
            ),
            claim_text=(
                "In an appropriate limit, the hypothesis should reduce to a known baseline or "
                "produce a distinctive scaling law; otherwise it is likely inconsistent."
            ),
            trace_inputs={
                "parent_node_id": context.parent_node_id,
                "step_id": context.step_id,
                "tick": context.tick,
                "style": "limit_explorer",
                "island_id": context.island_id,
            },
            trace_params={
                "deterministic_policy": "island_index_v1",
                "template_version": "limit-explorer-v1",
                "backend_id": self.backend_id,
            },
            evidence_uris_used=["urn:hepar:operator-template:limit-explorer-v1"],
        )


def hep_operator_families_m32() -> tuple[SearchOperator, ...]:
    # Stable operator ordering matters for deterministic island-index selection.
    return (
        HepAnomalyAbductionOperator(),
        HepSymmetryOperator(),
        HepLimitExplorerOperator(),
    )
