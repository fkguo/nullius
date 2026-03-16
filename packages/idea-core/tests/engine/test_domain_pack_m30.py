from __future__ import annotations

import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from idea_core.contracts.validate import DEFAULT_CONTRACT_DIR
from idea_core.engine.domain_pack import DomainPackAssets, DomainPackDescriptor, DomainPackIndex
from idea_core.engine.operators import OperatorOutput
from idea_core.engine.coordinator import IdeaCoreService, RpcError
from idea_core.engine.retrieval import build_default_librarian_recipe_book


class _TaggedOperator:
    def __init__(self, tag: str) -> None:
        self.operator_id = f"{tag}.operator"
        self.operator_family = "TaggedOperator"
        self.backend_id = f"{tag}.backend"

    def run(self, context, *, parent_node):  # type: ignore[no-untyped-def]
        return OperatorOutput(
            operator_id=self.operator_id,
            operator_family=self.operator_family,
            backend_id=self.backend_id,
            rationale_title=f"{self.operator_id} rationale",
            rationale="Deterministic test operator output for M3.0.",
            thesis_statement=f"{self.operator_id} thesis",
            hypothesis=f"{self.operator_id} hypothesis with the current observable set",
            claim_text=f"{self.operator_id} claim",
            trace_inputs={"parent_node_id": context.parent_node_id},
            trace_params={"tag": self.operator_id},
            evidence_uris_used=["https://example.org/domain-pack-test"],
        )


def _make_domain_pack_descriptor(
    *,
    pack_id: str,
    operator_tag: str,
    load_counter: dict[str, int],
    domain_prefixes: tuple[str, ...] = ("hep-",),
    load_delay_s: float = 0.0,
) -> DomainPackDescriptor:
    def _loader() -> DomainPackAssets:
        if load_delay_s > 0:
            time.sleep(load_delay_s)
        load_counter[pack_id] += 1
        return DomainPackAssets(
            pack_id=pack_id,
            domain_prefixes=domain_prefixes,
            abstract_problem_registry={
                "entries": [
                    {
                        "abstract_problem_type": "optimization",
                        "description": f"Optimization baseline for {pack_id}.",
                        "known_solution_families": [f"{pack_id}.solver"],
                        "prerequisite_checklist": ["objective is defined"],
                        "reference_uris": ["https://example.org/optimization"],
                    }
                ]
            },
            search_operators=(_TaggedOperator(operator_tag),),
            librarian_recipes=build_default_librarian_recipe_book(),
        )

    return DomainPackDescriptor(
        pack_id=pack_id,
        domain_prefixes=domain_prefixes,
        description=f"Test domain pack {pack_id}",
        loader=_loader,
    )


def _make_service(tmp_path: Path, index: DomainPackIndex) -> IdeaCoreService:
    return IdeaCoreService(
        data_dir=tmp_path / "runs",
        contract_dir=DEFAULT_CONTRACT_DIR,
        domain_pack_index=index,
    )


def _init_campaign(
    service: IdeaCoreService,
    *,
    idempotency_key: str,
    domain: str = "hep-ph",
    extensions: dict | None = None,
) -> str:
    charter = {
        "campaign_name": "m3.0-domain-pack-fixture",
        "domain": domain,
        "scope": "m3.0 domain pack fixture scope",
        "approval_gate_ref": "gate://a0.1",
    }
    if extensions is not None:
        charter["extensions"] = extensions

    result = service.handle(
        "campaign.init",
        {
            "charter": charter,
            "seed_pack": {"seeds": [{"seed_type": "text", "content": "seed-a"}]},
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


def test_domain_pack_matches_domain_prefix_without_hep_global_default(tmp_path: Path) -> None:
    load_counter = {"hep.alpha": 0, "math.alpha": 0}
    index = DomainPackIndex(
        (
            _make_domain_pack_descriptor(
                pack_id="hep.alpha",
                operator_tag="alpha",
                load_counter=load_counter,
                domain_prefixes=("hep-",),
            ),
            _make_domain_pack_descriptor(
                pack_id="math.alpha",
                operator_tag="math",
                load_counter=load_counter,
                domain_prefixes=("math-",),
            ),
        )
    )
    service = _make_service(tmp_path, index)

    campaign_id = _init_campaign(
        service,
        idempotency_key="m3.0-domain-prefix-init",
        domain="math-topology",
    )

    assert load_counter == {"hep.alpha": 0, "math.alpha": 1}
    campaign = service.store.load_campaign(campaign_id)
    assert campaign is not None
    assert campaign["domain_pack"]["pack_id"] == "math.alpha"

    seed_node_id = next(iter(service.store.load_nodes(campaign_id).keys()))
    seed_node = service.handle("node.get", {"campaign_id": campaign_id, "node_id": seed_node_id})
    assert "candidate_formalisms" not in seed_node["idea_card"]


def test_non_hep_domain_pack_runtime_uses_explicit_non_hep_retrieval(tmp_path: Path) -> None:
    load_counter = {"math.alpha": 0}
    index = DomainPackIndex(
        (
            _make_domain_pack_descriptor(
                pack_id="math.alpha",
                operator_tag="math",
                load_counter=load_counter,
                domain_prefixes=("math-",),
            ),
        )
    )
    service = _make_service(tmp_path, index)
    campaign_id = _init_campaign(
        service,
        idempotency_key="m3.0-non-hep-runtime",
        domain="math-topology",
    )

    step_result = service.handle(
        "search.step",
        {
            "campaign_id": campaign_id,
            "n_steps": 1,
            "idempotency_key": "m3.0-non-hep-runtime-step",
        },
    )

    nodes_artifact = service.store.load_artifact_from_ref(step_result["new_nodes_artifact_ref"])
    packet = service.store.load_artifact_from_ref(nodes_artifact["operator_events"][0]["evidence_packet_ref"])
    providers = [recipe["provider"] for recipe in packet["recipes"]]
    recipe_ids = [recipe["recipe_id"] for recipe in packet["recipes"]]

    assert providers == ["GENERIC_LITERATURE", "GENERIC_EVIDENCE"]
    assert not any(provider in {"INSPIRE", "PDG"} for provider in providers)
    assert not any("hep" in recipe_id for recipe_id in recipe_ids)


def test_domain_pack_lazy_loads_only_selected_pack_and_reuses_cache(tmp_path: Path) -> None:
    load_counter = {"hep.alpha": 0, "hep.beta": 0}
    index = DomainPackIndex(
        (
            _make_domain_pack_descriptor(
                pack_id="hep.alpha",
                operator_tag="alpha",
                load_counter=load_counter,
            ),
            _make_domain_pack_descriptor(
                pack_id="hep.beta",
                operator_tag="beta",
                load_counter=load_counter,
            ),
        )
    )
    service = _make_service(tmp_path, index)

    assert load_counter == {"hep.alpha": 0, "hep.beta": 0}

    campaign_id = _init_campaign(
        service,
        idempotency_key="m3.0-lazy-pack-init",
        extensions={"enable_domain_packs": ["hep.beta"]},
    )
    assert load_counter == {"hep.alpha": 0, "hep.beta": 1}

    seed_node_id = next(iter(service.store.load_nodes(campaign_id).keys()))
    seed_node = service.handle("node.get", {"campaign_id": campaign_id, "node_id": seed_node_id})
    assert "candidate_formalisms" not in seed_node["idea_card"]

    first_step = service.handle(
        "search.step",
        {
            "campaign_id": campaign_id,
            "n_steps": 1,
            "idempotency_key": "m3.0-lazy-pack-step-1",
        },
    )
    first_node = service.handle(
        "node.get",
        {"campaign_id": campaign_id, "node_id": first_step["new_node_ids"][0]},
    )
    assert first_node["operator_id"] == "beta.operator"

    service.handle(
        "search.step",
        {
            "campaign_id": campaign_id,
            "n_steps": 1,
            "idempotency_key": "m3.0-lazy-pack-step-2",
        },
    )
    assert load_counter == {"hep.alpha": 0, "hep.beta": 1}


def test_domain_pack_disable_all_fails_campaign_init(tmp_path: Path) -> None:
    load_counter = {"hep.alpha": 0}
    index = DomainPackIndex(
        (
            _make_domain_pack_descriptor(
                pack_id="hep.alpha",
                operator_tag="alpha",
                load_counter=load_counter,
            ),
        )
    )
    service = _make_service(tmp_path, index)

    try:
        _init_campaign(
            service,
            idempotency_key="m3.0-disable-all-init",
            extensions={"disable_domain_packs": ["hep.alpha"]},
        )
        assert False, "expected RpcError"
    except RpcError as exc:
        assert exc.code == -32002
        assert exc.message == "schema_validation_failed"
        assert exc.data["reason"] == "schema_invalid"
        assert "domain pack candidates are empty" in exc.data["details"]["message"]


def test_domain_pack_requires_matching_domain_when_no_pack_is_enabled(tmp_path: Path) -> None:
    load_counter = {"hep.alpha": 0}
    index = DomainPackIndex(
        (
            _make_domain_pack_descriptor(
                pack_id="hep.alpha",
                operator_tag="alpha",
                load_counter=load_counter,
            ),
        )
    )
    service = _make_service(tmp_path, index)

    try:
        _init_campaign(
            service,
            idempotency_key="m3.0-no-domain-match",
            domain="math-topology",
        )
        assert False, "expected RpcError"
    except RpcError as exc:
        assert exc.code == -32002
        assert exc.message == "schema_validation_failed"
        assert exc.data["reason"] == "schema_invalid"
        assert "no domain pack available for domain: math-topology" in exc.data["details"]["message"]


def test_domain_pack_selects_explicit_domain_pack_id(tmp_path: Path) -> None:
    load_counter = {"hep.alpha": 0, "hep.beta": 0}
    index = DomainPackIndex(
        (
            _make_domain_pack_descriptor(
                pack_id="hep.alpha",
                operator_tag="alpha",
                load_counter=load_counter,
            ),
            _make_domain_pack_descriptor(
                pack_id="hep.beta",
                operator_tag="beta",
                load_counter=load_counter,
            ),
        )
    )
    service = _make_service(tmp_path, index)

    campaign_id = _init_campaign(
        service,
        idempotency_key="m3.0-explicit-pack-init",
        extensions={
            "enable_domain_packs": ["hep.alpha", "hep.beta"],
            "domain_pack_id": "hep.alpha",
        },
    )

    assert load_counter == {"hep.alpha": 1, "hep.beta": 0}
    seed_node_id = next(iter(service.store.load_nodes(campaign_id).keys()))
    seed_node = service.handle("node.get", {"campaign_id": campaign_id, "node_id": seed_node_id})
    assert "candidate_formalisms" not in seed_node["idea_card"]


def test_domain_pack_disable_overrides_requested_pack_id(tmp_path: Path) -> None:
    load_counter = {"hep.alpha": 0, "hep.beta": 0}
    index = DomainPackIndex(
        (
            _make_domain_pack_descriptor(
                pack_id="hep.alpha",
                operator_tag="alpha",
                load_counter=load_counter,
            ),
            _make_domain_pack_descriptor(
                pack_id="hep.beta",
                operator_tag="beta",
                load_counter=load_counter,
            ),
        )
    )
    service = _make_service(tmp_path, index)

    try:
        _init_campaign(
            service,
            idempotency_key="m3.0-disable-requested-pack",
            extensions={
                "enable_domain_packs": ["hep.alpha", "hep.beta"],
                "disable_domain_packs": ["hep.alpha"],
                "domain_pack_id": "hep.alpha",
            },
        )
        assert False, "expected RpcError"
    except RpcError as exc:
        assert exc.code == -32002
        assert exc.message == "schema_validation_failed"
        assert exc.data["reason"] == "schema_invalid"
        assert "requested domain_pack_id not enabled: hep.alpha" in exc.data["details"]["message"]


def test_domain_pack_index_load_is_thread_safe(tmp_path: Path) -> None:
    load_counter = {"hep.alpha": 0}
    descriptor = _make_domain_pack_descriptor(
        pack_id="hep.alpha",
        operator_tag="alpha",
        load_counter=load_counter,
        load_delay_s=0.02,
    )
    index = DomainPackIndex((descriptor,))

    def _load() -> DomainPackAssets:
        return index.load("hep.alpha")

    with ThreadPoolExecutor(max_workers=12) as executor:
        results = list(executor.map(lambda _: _load(), range(24)))

    assert load_counter["hep.alpha"] == 1
    first = results[0]
    assert all(asset is first for asset in results)


def test_search_step_fails_if_campaign_domain_pack_metadata_missing(tmp_path: Path) -> None:
    load_counter = {"hep.alpha": 0}
    index = DomainPackIndex(
        (
            _make_domain_pack_descriptor(
                pack_id="hep.alpha",
                operator_tag="alpha",
                load_counter=load_counter,
            ),
        )
    )
    service = _make_service(tmp_path, index)
    campaign_id = _init_campaign(
        service,
        idempotency_key="m3.0-metadata-missing-init",
        extensions={"domain_pack_id": "hep.alpha"},
    )

    campaign = service.store.load_campaign(campaign_id)
    assert campaign is not None
    campaign.pop("domain_pack", None)
    service.store.save_campaign(campaign)

    try:
        service.handle(
            "search.step",
            {
                "campaign_id": campaign_id,
                "n_steps": 1,
                "idempotency_key": "m3.0-metadata-missing-step",
            },
        )
        assert False, "expected RpcError"
    except RpcError as exc:
        assert exc.code == -32002
        assert exc.message == "schema_validation_failed"
        assert exc.data["reason"] == "schema_invalid"
        assert "campaign missing domain_pack metadata" in exc.data["details"]["message"]
