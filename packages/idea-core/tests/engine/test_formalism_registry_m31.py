from __future__ import annotations

from pathlib import Path

from idea_core.contracts.validate import DEFAULT_CONTRACT_DIR
from idea_core.engine.coordinator import IdeaCoreService
from idea_core.engine.default_domain_pack import DEFAULT_DOMAIN_PACK_ID
from idea_core.engine.domain_pack import DomainPackAssets, DomainPackDescriptor, DomainPackIndex
from idea_core.engine.operators import OperatorOutput
from idea_core.engine.retrieval import build_default_librarian_recipe_book


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
            hypothesis="M3.1 noop hypothesis remains testable with primary_outcome",
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
        "campaign_name": "m3.1-formalism-boundary",
        "domain": "hep-ph",
        "scope": "m3.1 formalism boundary test scope",
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


def test_builtin_pack_campaign_init_no_longer_persists_formalism_registry(tmp_path: Path) -> None:
    service = _make_service(tmp_path)
    campaign_id = _campaign_init(service, idempotency_key="m3.1-default-pack")

    campaign = service.store.load_campaign(campaign_id)
    assert campaign is not None
    assert campaign["domain_pack"]["pack_id"] == DEFAULT_DOMAIN_PACK_ID
    assert "formalism_registry" not in campaign

    seed_node_id = next(iter(service.store.load_nodes(campaign_id).keys()))
    seed_node = service.handle("node.get", {"campaign_id": campaign_id, "node_id": seed_node_id})
    assert "candidate_formalisms" not in seed_node["idea_card"]


def test_campaign_init_succeeds_with_pack_without_formalism_authority(tmp_path: Path) -> None:
    descriptor = DomainPackDescriptor(
        pack_id="hep.minimal-pack",
        domain_prefixes=("hep-",),
        description="M3.1 minimal pack without formalism authority",
        loader=lambda: DomainPackAssets(
            pack_id="hep.minimal-pack",
            domain_prefixes=("hep-",),
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
            librarian_recipes=build_default_librarian_recipe_book(),
        ),
    )
    service = _make_service(tmp_path, domain_pack_index=DomainPackIndex((descriptor,)))
    campaign_id = _campaign_init(
        service,
        idempotency_key="m3.1-minimal-pack",
        extensions={"enable_domain_packs": ["hep.minimal-pack"]},
    )

    campaign = service.store.load_campaign(campaign_id)
    assert campaign is not None
    assert campaign["domain_pack"]["pack_id"] == "hep.minimal-pack"
    assert "formalism_registry" not in campaign
