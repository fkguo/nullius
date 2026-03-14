from __future__ import annotations

import json
import sys
import tempfile
from contextlib import ExitStack
from copy import deepcopy
from pathlib import Path
from unittest.mock import patch
from uuid import UUID

REPO_ROOT = Path(__file__).resolve().parents[4]
IDEA_CORE_SRC = REPO_ROOT / "packages/idea-core/src"
if str(IDEA_CORE_SRC) not in sys.path:
    sys.path.insert(0, str(IDEA_CORE_SRC))

from idea_core.contracts.validate import DEFAULT_CONTRACT_DIR  # noqa: E402
from idea_core.engine.coordinator import IdeaCoreService  # noqa: E402
from idea_core.rpc.server import handle_request  # noqa: E402
import idea_core.engine.coordinator as coordinator  # noqa: E402
from write_rpc_fixture_support import materialize_snapshot, snapshot_store  # noqa: E402


FIXTURE_PATH = Path(__file__).with_name("search-step-rpc-golden.json")


def campaign_init_request(*, idempotency_key: str, max_steps: int) -> dict[str, object]:
    return {
        "jsonrpc": "2.0",
        "id": f"init:{idempotency_key}",
        "method": "campaign.init",
        "params": {
            "charter": {
                "campaign_name": f"search-step-{idempotency_key}",
                "domain": "hep-ph",
                "scope": f"search.step fixture {idempotency_key}",
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
            "idempotency_key": idempotency_key,
        },
    }


def search_step_request(*, campaign_id: str, idempotency_key: str, n_steps: int, step_budget: dict[str, object] | None = None) -> dict[str, object]:
    params: dict[str, object] = {
        "campaign_id": campaign_id,
        "n_steps": n_steps,
        "idempotency_key": idempotency_key,
    }
    if step_budget is not None:
        params["step_budget"] = step_budget
    return {
        "jsonrpc": "2.0",
        "id": f"search:{idempotency_key}",
        "method": "search.step",
        "params": params,
    }


def build_case(*, initial_store: dict[str, object], name: str, now: str, requests: list[dict[str, object]], uuid_sequence: list[str]) -> dict[str, object]:
    with tempfile.TemporaryDirectory(prefix="idea-engine-search-fixture-") as tmp_dir:
        store_root = Path(tmp_dir) / "store"
        store_root.mkdir(parents=True, exist_ok=True)
        materialize_snapshot(store_root, initial_store)
        service = IdeaCoreService(data_dir=store_root, contract_dir=DEFAULT_CONTRACT_DIR)
        steps: list[dict[str, object]] = []
        with ExitStack() as stack:
            stack.enter_context(patch.object(coordinator, "utc_now_iso", return_value=now))
            stack.enter_context(patch.object(coordinator, "uuid4", side_effect=[UUID(value) for value in uuid_sequence]))
            for request in requests:
                steps.append({"request": deepcopy(request), "response": handle_request(service, deepcopy(request))})
        return {
            "name": name,
            "now": now,
            "uuid_sequence": uuid_sequence,
            "initial_store": initial_store,
            "steps": steps,
            "expected_store": snapshot_store(store_root),
        }


def paused_campaign_snapshot(*, now: str, uuid_sequence: list[str]) -> tuple[str, dict[str, object]]:
    with tempfile.TemporaryDirectory(prefix="idea-engine-search-paused-") as tmp_dir:
        store_root = Path(tmp_dir) / "store"
        service = IdeaCoreService(data_dir=store_root, contract_dir=DEFAULT_CONTRACT_DIR)
        request = campaign_init_request(idempotency_key="search-paused-init", max_steps=20)
        with ExitStack() as stack:
            stack.enter_context(patch.object(coordinator, "utc_now_iso", return_value=now))
            stack.enter_context(patch.object(coordinator, "uuid4", side_effect=[UUID(value) for value in uuid_sequence]))
            response = handle_request(service, deepcopy(request))
        campaign_id = response["result"]["campaign_id"]
        campaign_path = store_root / "campaigns" / campaign_id / "campaign.json"
        campaign = json.loads(campaign_path.read_text(encoding="utf-8"))
        campaign["status"] = "paused"
        campaign_path.write_text(json.dumps(campaign, ensure_ascii=False, indent=2), encoding="utf-8")
        return campaign_id, snapshot_store(store_root)


def main() -> None:
    happy_campaign_id = "11111111-1111-4111-8111-111111111111"
    conflict_campaign_id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
    budget_campaign_id = "12121212-1212-4212-8212-121212121212"
    island_campaign_id = "21212121-2121-4212-8212-212121212121"
    exhausted_campaign_id = "31313131-3131-4313-8313-313131313131"
    paused_campaign_id, paused_initial_store = paused_campaign_snapshot(
        now="2026-03-14T13:30:00Z",
        uuid_sequence=[
            "41414141-4141-4414-8414-414141414141",
            "42424242-4242-4424-8424-424242424242",
            "43434343-4343-4434-8434-434343434343",
            "44444444-4444-4444-8444-444444444444",
            "45454545-4545-4454-8454-454545454545",
        ],
    )
    fixture = {
        "cases": [
            build_case(
                name="search.step happy path then replay",
                now="2026-03-14T13:00:00Z",
                uuid_sequence=[
                    happy_campaign_id,
                    "22222222-2222-4222-8222-222222222222",
                    "33333333-3333-4333-8333-333333333333",
                    "44444444-4444-4444-8444-444444444444",
                    "55555555-5555-4555-8555-555555555555",
                    "66666666-6666-4666-8666-666666666666",
                    "77777777-7777-4777-8777-777777777777",
                    "88888888-8888-4888-8888-888888888888",
                    "99999999-9999-4999-8999-999999999999",
                    "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa01",
                ],
                initial_store={},
                requests=[
                    campaign_init_request(idempotency_key="search-happy-init", max_steps=20),
                    search_step_request(campaign_id=happy_campaign_id, idempotency_key="search-happy", n_steps=2),
                    search_step_request(campaign_id=happy_campaign_id, idempotency_key="search-happy", n_steps=2),
                ],
            ),
            build_case(
                name="search.step idempotency conflict",
                now="2026-03-14T13:05:00Z",
                uuid_sequence=[
                    conflict_campaign_id,
                    "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
                    "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
                    "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
                    "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
                    "ffffffff-ffff-4fff-8fff-ffffffffffff",
                    "10101010-1010-4010-8010-101010101010",
                    "11111111-aaaa-4aaa-8aaa-111111111111",
                ],
                initial_store={},
                requests=[
                    campaign_init_request(idempotency_key="search-conflict-init", max_steps=20),
                    search_step_request(campaign_id=conflict_campaign_id, idempotency_key="search-conflict", n_steps=1),
                    search_step_request(campaign_id=conflict_campaign_id, idempotency_key="search-conflict", n_steps=2),
                ],
            ),
            build_case(
                name="search.step step_budget early stop",
                now="2026-03-14T13:10:00Z",
                uuid_sequence=[
                    budget_campaign_id,
                    "13131313-1313-4313-8313-131313131313",
                    "14141414-1414-4414-8414-141414141414",
                    "15151515-1515-4515-8515-151515151515",
                    "16161616-1616-4616-8616-161616161616",
                    "17171717-1717-4717-8717-171717171717",
                    "18181818-1818-4818-8818-181818181818",
                    "19191919-1919-4919-8919-191919191919",
                    "20202020-2020-4020-8020-202020202020",
                    "21202020-2020-4020-8020-202020202020",
                ],
                initial_store={},
                requests=[
                    campaign_init_request(idempotency_key="search-budget-init", max_steps=20),
                    search_step_request(campaign_id=budget_campaign_id, idempotency_key="search-budget", n_steps=5, step_budget={"max_steps": 2}),
                ],
            ),
            build_case(
                name="search.step island state transitions",
                now="2026-03-14T13:15:00Z",
                uuid_sequence=[
                    island_campaign_id,
                    "23232323-2323-4232-8232-232323232323",
                    "24242424-2424-4242-8242-242424242424",
                    "25252525-2525-4252-8252-252525252525",
                    "26262626-2626-4262-8262-262626262626",
                    "27272727-2727-4272-8272-272727272727",
                    "28282828-2828-4282-8282-282828282828",
                    "29292929-2929-4292-8292-292929292929",
                    "30303030-3030-4303-8303-303030303030",
                    "32323232-3232-4323-8323-323232323232",
                    "34343434-3434-4343-8343-343434343434",
                    "35353535-3535-4353-8353-353535353535",
                    "36363636-3636-4363-8363-363636363636",
                    "37373737-3737-4373-8373-373737373737",
                    "38383838-3838-4383-8383-383838383838",
                    "39393939-3939-4393-8393-393939393939",
                ],
                initial_store={},
                requests=[
                    campaign_init_request(idempotency_key="search-island-init", max_steps=20),
                    search_step_request(campaign_id=island_campaign_id, idempotency_key="search-stagnant", n_steps=3),
                    search_step_request(campaign_id=island_campaign_id, idempotency_key="search-repopulated", n_steps=1),
                ],
            ),
            build_case(
                name="search.step budget exhausted and follow-up error",
                now="2026-03-14T13:20:00Z",
                uuid_sequence=[
                    exhausted_campaign_id,
                    "51515151-5151-4515-8515-515151515151",
                    "52525252-5252-4525-8525-525252525252",
                    "53535353-5353-4535-8535-535353535353",
                    "54545454-5454-4545-8545-545454545454",
                    "56565656-5656-4565-8565-565656565656",
                    "57575757-5757-4575-8575-575757575757",
                    "58585858-5858-4585-8585-585858585858",
                    "59595959-5959-4595-8595-595959595959",
                    "60606060-6060-4060-8060-606060606060",
                ],
                initial_store={},
                requests=[
                    campaign_init_request(idempotency_key="search-exhausted-init", max_steps=2),
                    search_step_request(campaign_id=exhausted_campaign_id, idempotency_key="search-exhausted", n_steps=5),
                    search_step_request(campaign_id=exhausted_campaign_id, idempotency_key="search-after-exhausted", n_steps=1),
                ],
            ),
            build_case(
                name="search.step campaign_not_active when paused",
                now="2026-03-14T13:30:00Z",
                uuid_sequence=[],
                initial_store=paused_initial_store,
                requests=[
                    search_step_request(campaign_id=paused_campaign_id, idempotency_key="search-paused", n_steps=1),
                ],
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
