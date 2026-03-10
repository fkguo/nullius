from __future__ import annotations

from pathlib import Path

from idea_core.contracts.validate import DEFAULT_CONTRACT_DIR
from idea_core.engine.domain_pack import DomainPackAssets, DomainPackDescriptor, DomainPackIndex
from idea_core.engine.operators import OperatorOutput
from idea_core.engine.coordinator import IdeaCoreService, RpcError


class _NoopOperator:
    operator_id = "m3.1.noop"
    operator_family = "M31Noop"
    backend_id = "m3.1.backend"

    def run(self, context, *, parent_node):  # type: ignore[no-untyped-def]
        return OperatorOutput(
            operator_id=self.operator_id,
            operator_family=self.operator_family,
            backend_id=self.backend_id,
            rationale_title="M3.1 noop rationale",
            rationale="No-op operator output used by M3.1 tests.",
            thesis_statement="M3.1 noop thesis",
            hypothesis=f"M3.1 noop hypothesis in {context.formalism_id}",
            claim_text="M3.1 noop claim",
            trace_inputs={"parent_node_id": context.parent_node_id},
            trace_params={"mode": "noop"},
            evidence_uris_used=["https://example.org/m31/noop"],
        )


def _make_service(
    tmp_path: Path,
    *,
    domain_pack_index: DomainPackIndex | None = None,
) -> IdeaCoreService:
    return IdeaCoreService(
        data_dir=tmp_path / "runs",
        contract_dir=DEFAULT_CONTRACT_DIR,
        domain_pack_index=domain_pack_index,
    )


def _campaign_init(service: IdeaCoreService, *, idempotency_key: str, extensions: dict | None = None) -> str:
    charter = {
        "campaign_name": "m3.1-formalism-registry",
        "domain": "hep-ph",
        "scope": "m3.1 formalism registry test scope",
        "approval_gate_ref": "gate://a0.1",
    }
    if extensions is not None:
        charter["extensions"] = extensions

    result = service.handle(
        "campaign.init",
        {
            "charter": charter,
            "seed_pack": {"seeds": [{"seed_type": "text", "content": "seed-m31"}]},
            "budget": {
                "max_tokens": 100000,
                "max_cost_usd": 100.0,
                "max_wall_clock_s": 100000,
                "max_steps": 50,
            },
            "idempotency_key": idempotency_key,
        },
    )
    return result["campaign_id"]


def test_hep_bootstrap_pack_has_minimal_formalism_registry_set(tmp_path: Path) -> None:
    service = _make_service(tmp_path)
    campaign_id = _campaign_init(service, idempotency_key="m3.1-default-registry")

    campaign = service.store.load_campaign(campaign_id)
    assert campaign is not None
    assert campaign["domain_pack"]["pack_id"] == "hep.bootstrap"

    formalism_ids = [
        entry["formalism_id"]
        for entry in campaign.get("formalism_registry", {}).get("entries", [])
    ]
    assert {"hep/toy", "hep/eft", "hep/lattice"}.issubset(set(formalism_ids))


def test_campaign_init_fails_when_effective_formalism_registry_is_empty(tmp_path: Path) -> None:
    descriptor = DomainPackDescriptor(
        pack_id="hep.empty-formalisms",
        domain_prefixes=("hep-",),
        description="M3.1 empty formalism registry test pack",
        loader=lambda: DomainPackAssets(
            pack_id="hep.empty-formalisms",
            domain_prefixes=("hep-",),
            formalism_registry={"entries": []},
            abstract_problem_registry={
                "entries": [
                    {
                        "abstract_problem_type": "optimization",
                        "description": "default optimization",
                        "known_solution_families": ["baseline"],
                        "prerequisite_checklist": ["objective is defined"],
                        "reference_uris": ["https://example.org/optimization"],
                    }
                ]
            },
            search_operators=(_NoopOperator(),),
        ),
    )
    service = _make_service(tmp_path, domain_pack_index=DomainPackIndex((descriptor,)))

    try:
        _campaign_init(
            service,
            idempotency_key="m3.1-empty-registry",
            extensions={"enable_domain_packs": ["hep.empty-formalisms"]},
        )
        assert False, "expected RpcError"
    except RpcError as exc:
        assert exc.code == -32002
        assert exc.message == "schema_validation_failed"
        assert exc.data["reason"] == "schema_invalid"
        assert "effective formalism registry must be non-empty" in exc.data["details"]["message"]
