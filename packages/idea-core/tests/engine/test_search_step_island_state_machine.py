from __future__ import annotations

from pathlib import Path

from idea_core.contracts.validate import DEFAULT_CONTRACT_DIR
from idea_core.engine.coordinator import IdeaCoreService, RpcError


def make_service(tmp_path: Path) -> IdeaCoreService:
    return IdeaCoreService(data_dir=tmp_path / "runs", contract_dir=DEFAULT_CONTRACT_DIR)


def init_campaign(service: IdeaCoreService, *, max_steps: int) -> str:
    result = service.handle(
        "campaign.init",
        {
            "charter": {
                "campaign_name": "search-step-state-machine-fixture",
                "domain": "hep-ph",
                "scope": "m2.5 island transition fixture",
                "approval_gate_ref": "gate://a0.1",
            },
            "seed_pack": {
                "seeds": [
                    {"seed_type": "text", "content": "seed-a"},
                    {"seed_type": "text", "content": "seed-b"},
                ]
            },
            "budget": {
                "max_tokens": 100000,
                "max_cost_usd": 100.0,
                "max_wall_clock_s": 100000,
                "max_steps": max_steps,
            },
            "idempotency_key": f"init-max-steps-{max_steps}",
        },
    )
    return result["campaign_id"]


def test_search_step_reaches_stagnant_then_repopulated_and_status_matches(tmp_path: Path) -> None:
    service = make_service(tmp_path)
    campaign_id = init_campaign(service, max_steps=20)

    stagnant = service.handle(
        "search.step",
        {
            "campaign_id": campaign_id,
            "n_steps": 3,
            "idempotency_key": "search-stagnant",
        },
    )
    # Expected path with STAGNATION_PATIENCE_STEPS=2:
    # tick 1: SEEDING -> EXPLORING (counter=0)
    # tick 2: EXPLORING -> EXPLORING (counter=1)
    # tick 3: EXPLORING -> STAGNANT (counter=2)
    assert stagnant["n_steps_executed"] == 3
    assert stagnant["budget_snapshot"]["steps_used"] == 3
    island_after_stagnant = stagnant["island_states"][0]
    assert island_after_stagnant["state"] == "STAGNANT"
    assert island_after_stagnant["stagnation_counter"] == 2
    assert island_after_stagnant["repopulation_count"] == 0
    assert island_after_stagnant["population_size"] == 5

    stagnant_status = service.handle("campaign.status", {"campaign_id": campaign_id})
    assert stagnant_status["island_states"] == stagnant["island_states"]

    repopulated = service.handle(
        "search.step",
        {
            "campaign_id": campaign_id,
            "n_steps": 1,
            "idempotency_key": "search-repopulated",
        },
    )
    assert repopulated["n_steps_executed"] == 1
    island_after_repopulate = repopulated["island_states"][0]
    assert island_after_repopulate["state"] == "REPOPULATED"
    assert island_after_repopulate["stagnation_counter"] == 0
    assert island_after_repopulate["repopulation_count"] == 1
    assert island_after_repopulate["population_size"] == 6

    repopulated_status = service.handle("campaign.status", {"campaign_id": campaign_id})
    assert repopulated_status["island_states"] == repopulated["island_states"]


def test_search_step_honors_step_budget_fuse_without_budget_overrun(tmp_path: Path) -> None:
    service = make_service(tmp_path)
    campaign_id = init_campaign(service, max_steps=20)

    result = service.handle(
        "search.step",
        {
            "campaign_id": campaign_id,
            "n_steps": 5,
            "step_budget": {"max_steps": 2},
            "idempotency_key": "search-step-budget-fuse",
        },
    )

    assert result["n_steps_requested"] == 5
    assert result["n_steps_executed"] == 2
    assert result["early_stopped"] is True
    assert result["early_stop_reason"] == "step_budget_exhausted"
    assert result["budget_snapshot"]["steps_used"] == 2
    assert result["budget_snapshot"]["steps_remaining"] == 18

    status = service.handle("campaign.status", {"campaign_id": campaign_id})
    assert status["status"] == "running"
    assert status["budget_snapshot"]["steps_used"] == 2
    assert status["island_states"] == result["island_states"]


def test_search_step_single_tick_moves_seeding_to_exploring(tmp_path: Path) -> None:
    service = make_service(tmp_path)
    campaign_id = init_campaign(service, max_steps=20)

    result = service.handle(
        "search.step",
        {
            "campaign_id": campaign_id,
            "n_steps": 1,
            "idempotency_key": "search-single-tick",
        },
    )

    island = result["island_states"][0]
    assert island["state"] == "EXPLORING"
    assert island["stagnation_counter"] == 0
    assert island["repopulation_count"] == 0


def test_search_step_best_score_improvement_resets_stagnation_to_converging(tmp_path: Path) -> None:
    service = make_service(tmp_path)
    campaign_id = init_campaign(service, max_steps=20)
    node_ids = list(service.store.load_nodes(campaign_id).keys())

    warmup = service.handle(
        "search.step",
        {
            "campaign_id": campaign_id,
            "n_steps": 2,
            "idempotency_key": "search-warmup",
        },
    )
    assert warmup["island_states"][0]["state"] == "EXPLORING"
    assert warmup["island_states"][0]["stagnation_counter"] == 1

    service.handle(
        "eval.run",
        {
            "campaign_id": campaign_id,
            "node_ids": [node_ids[0]],
            "evaluator_config": {"dimensions": ["novelty", "impact"], "n_reviewers": 2},
            "idempotency_key": "eval-improve-best-score",
        },
    )

    result = service.handle(
        "search.step",
        {
            "campaign_id": campaign_id,
            "n_steps": 1,
            "idempotency_key": "search-after-improvement",
        },
    )
    island = result["island_states"][0]
    assert island["state"] == "CONVERGING"
    assert island["stagnation_counter"] == 0
    assert island["best_score"] is not None


def test_search_step_global_step_budget_exhaustion_sets_campaign_exhausted(tmp_path: Path) -> None:
    service = make_service(tmp_path)
    campaign_id = init_campaign(service, max_steps=2)

    result = service.handle(
        "search.step",
        {
            "campaign_id": campaign_id,
            "n_steps": 5,
            "idempotency_key": "search-global-budget-fuse",
        },
    )

    assert result["n_steps_executed"] == 2
    assert result["early_stopped"] is True
    assert result["early_stop_reason"] == "budget_exhausted"
    assert result["budget_snapshot"]["steps_used"] == 2
    assert result["budget_snapshot"]["steps_remaining"] == 0
    assert result["island_states"][0]["state"] == "EXHAUSTED"

    status = service.handle("campaign.status", {"campaign_id": campaign_id})
    assert status["status"] == "exhausted"
    assert status["budget_snapshot"]["steps_used"] == 2
    assert status["island_states"] == result["island_states"]

    try:
        service.handle(
            "search.step",
            {
                "campaign_id": campaign_id,
                "n_steps": 1,
                "idempotency_key": "search-after-exhausted",
            },
        )
        assert False, "expected RpcError"
    except RpcError as exc:
        assert exc.code == -32001
        assert exc.message == "budget_exhausted"


def test_search_step_exact_max_steps_exhausts_without_early_stop_flag(tmp_path: Path) -> None:
    service = make_service(tmp_path)
    campaign_id = init_campaign(service, max_steps=2)

    result = service.handle(
        "search.step",
        {
            "campaign_id": campaign_id,
            "n_steps": 2,
            "idempotency_key": "search-exact-max-steps",
        },
    )

    assert result["n_steps_executed"] == 2
    assert "early_stopped" not in result
    assert "early_stop_reason" not in result

    status = service.handle("campaign.status", {"campaign_id": campaign_id})
    assert status["status"] == "exhausted"
    assert status["budget_snapshot"]["steps_used"] == 2


def test_search_step_step_budget_max_tokens_is_noop_in_m2_5(tmp_path: Path) -> None:
    service = make_service(tmp_path)
    campaign_id = init_campaign(service, max_steps=5)

    result = service.handle(
        "search.step",
        {
            "campaign_id": campaign_id,
            "n_steps": 2,
            "step_budget": {"max_tokens": 1},
            "idempotency_key": "search-step-budget-max-tokens",
        },
    )

    # M2.6 minimal operator loop still does not consume tokens.
    assert result["n_steps_executed"] == 2
    assert "early_stopped" not in result
    assert result["budget_snapshot"]["tokens_used"] == 0
    assert result["budget_snapshot"]["steps_used"] == 2


def test_search_step_idempotency_replay_does_not_double_spend_steps(tmp_path: Path) -> None:
    service = make_service(tmp_path)
    campaign_id = init_campaign(service, max_steps=20)
    params = {
        "campaign_id": campaign_id,
        "n_steps": 1,
        "idempotency_key": "search-replay",
    }

    first = service.handle("search.step", params)
    second = service.handle("search.step", params)

    assert first["step_id"] == second["step_id"]
    assert first["n_steps_executed"] == second["n_steps_executed"] == 1
    assert first["idempotency"]["is_replay"] is False
    assert second["idempotency"]["is_replay"] is True

    status = service.handle("campaign.status", {"campaign_id": campaign_id})
    assert status["budget_snapshot"]["steps_used"] == 1
