from __future__ import annotations

from pathlib import Path
import json
from copy import deepcopy

from write_rpc_fixture_support import prepared_recovery_initial_store, run_case

FIXTURE_PATH = Path(__file__).with_name("write-rpc-golden.json")


def campaign_init_request(*, scope: str, seed_count: int, idempotency_key: str, initial_islands: int | None = None) -> dict[str, object]:
    charter: dict[str, object] = {
        "campaign_name": "write-side-fixture",
        "domain": "hep-ph",
        "scope": scope,
        "approval_gate_ref": "gate://a0.1",
    }
    if initial_islands is not None:
        charter["extensions"] = {"initial_island_count": initial_islands}
    seeds = [{"seed_type": "text", "content": f"seed-{index + 1}"} for index in range(seed_count)]
    return {
        "jsonrpc": "2.0",
        "id": idempotency_key,
        "method": "campaign.init",
        "params": {
            "charter": charter,
            "seed_pack": {"seeds": seeds},
            "budget": {
                "max_tokens": 100000,
                "max_cost_usd": 100.0,
                "max_wall_clock_s": 100000,
                "max_steps": 50,
                "max_nodes": 10,
            },
            "idempotency_key": idempotency_key,
        },
    }


def main() -> None:
    happy_request = campaign_init_request(
        scope="write-side happy path fixture scope",
        seed_count=2,
        idempotency_key="write-init-happy",
        initial_islands=2,
    )
    conflict_request = campaign_init_request(
        scope="write-side conflict baseline scope",
        seed_count=1,
        idempotency_key="write-init-conflict",
    )
    conflict_reuse = deepcopy(conflict_request)
    conflict_reuse["params"]["charter"]["scope"] = "write-side conflict DIFFERENT scope"
    recovery_request = campaign_init_request(
        scope="write-side prepared recovery scope",
        seed_count=1,
        idempotency_key="write-init-recovery",
    )
    fixture = {
        "cases": [
            run_case(
                name="campaign.init happy path then replay",
                requests=[happy_request, deepcopy(happy_request)],
                now="2026-03-14T12:00:00Z",
                uuid_sequence=[
                    "11111111-1111-4111-8111-111111111111",
                    "22222222-2222-4222-8222-222222222222",
                    "33333333-3333-4333-8333-333333333333",
                    "44444444-4444-4444-8444-444444444444",
                    "55555555-5555-4555-8555-555555555555",
                ],
            ),
            run_case(
                name="campaign.init idempotency conflict",
                requests=[conflict_request, conflict_reuse],
                now="2026-03-14T12:05:00Z",
                uuid_sequence=[
                    "66666666-6666-4666-8666-666666666666",
                    "77777777-7777-4777-8777-777777777777",
                    "88888888-8888-4888-8888-888888888888",
                ],
            ),
            run_case(
                name="campaign.init prepared record recovery",
                requests=[recovery_request],
                now="2026-03-14T12:10:00Z",
                uuid_sequence=[
                    "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
                    "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
                    "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
                ],
                initial_store=prepared_recovery_initial_store(
                    recovery_request,
                    now="2026-03-14T12:09:00Z",
                    uuid_sequence=[
                        "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
                        "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
                        "ffffffff-ffff-4fff-8fff-ffffffffffff",
                    ],
                ),
            ),
            run_case(
                name="invalid_request envelope",
                requests=[{"id": "bad-request", "method": "campaign.init", "params": {}}],
                now="2026-03-14T12:15:00Z",
                uuid_sequence=[],
            ),
            run_case(
                name="invalid_params envelope",
                requests=[{"jsonrpc": "2.0", "id": "bad-params", "method": "campaign.init", "params": []}],
                now="2026-03-14T12:16:00Z",
                uuid_sequence=[],
            ),
            run_case(
                name="method_not_found envelope",
                requests=[{"jsonrpc": "2.0", "id": "bad-method", "method": "unknown.method", "params": {}}],
                now="2026-03-14T12:17:00Z",
                uuid_sequence=[],
            ),
        ],
        "parse_cases": [
            {
                "name": "parse_error envelope",
                "line": "{",
                "response": {
                    "jsonrpc": "2.0",
                    "id": None,
                    "error": {"code": -32700, "message": "parse_error", "data": {"reason": "parse_error"}},
                },
            }
        ],
    }
    FIXTURE_PATH.write_text(json.dumps(fixture, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
