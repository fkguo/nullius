import json
import sys
import unittest
from copy import deepcopy
from pathlib import Path

from jsonschema import Draft202012Validator, ValidationError


def _src_root() -> Path:
    return Path(__file__).resolve().parents[1] / "src"


class TestAgentRegistry(unittest.TestCase):
    def _load_modules(self):
        src_root = str(_src_root())
        added_path = False
        if src_root not in sys.path:
            sys.path.insert(0, src_root)
            added_path = True
        try:
            from hep_autoresearch.toolkit.agent_contracts import (
                load_schema,
                validate_agent_card,
                validate_agent_message,
            )
            from hep_autoresearch.toolkit.agent_registry import builtin_agent_cards_dir, load_agent_registry

            return {
                "builtin_agent_cards_dir": builtin_agent_cards_dir,
                "load_agent_registry": load_agent_registry,
                "load_schema": load_schema,
                "validate_agent_card": validate_agent_card,
                "validate_agent_message": validate_agent_message,
            }
        finally:
            if added_path:
                try:
                    sys.path.remove(src_root)
                except ValueError:
                    pass

    def test_builtin_cards_validate_via_json_schema_and_manual_contracts(self) -> None:
        loaded = self._load_modules()
        schema = loaded["load_schema"]("agent_card_v1")
        validator = Draft202012Validator(schema)
        cards_dir = loaded["builtin_agent_cards_dir"]()

        discovered_ids: set[str] = set()
        for card_path in sorted(cards_dir.glob("*.json")):
            payload = json.loads(card_path.read_text(encoding="utf-8"))
            validator.validate(payload)
            loaded["validate_agent_card"](payload)
            discovered_ids.add(str(payload["agent_id"]))
            if payload["agent_id"] == "idea-engine":
                self.assertEqual(
                    payload["input_contracts"][0]["source_path"],
                    "packages/idea-engine/contracts/idea-runtime-contracts/schemas/idea_core_rpc_v1.openrpc.json",
                )
                self.assertEqual(
                    payload["output_contracts"][0]["source_path"],
                    "packages/idea-engine/contracts/idea-runtime-contracts/schemas/idea_core_rpc_v1.openrpc.json",
                )

        self.assertEqual(discovered_ids, {"hep-mcp", "idea-engine"})

    def test_agent_message_schema_requires_uuid_v4_trace_id(self) -> None:
        loaded = self._load_modules()
        schema = loaded["load_schema"]("agent_message_v1")
        validator = Draft202012Validator(schema)
        message = {
            "schema_version": 1,
            "message_id": "MSG-1",
            "trace_id": "0f5ca9e6-0d92-48f1-b906-8bd17cfce0af",
            "run_id": "RUN-1",
            "source_agent_id": "client",
            "target_agent_id": "hep-mcp",
            "message_kind": "request",
            "requested_capability": "mcp.list_tools",
            "payload": {},
        }

        validator.validate(message)
        loaded["validate_agent_message"](message)

        invalid = dict(message)
        invalid["trace_id"] = "123e4567-e89b-12d3-a456-426614174000"

        with self.assertRaises(ValidationError):
            validator.validate(invalid)
        with self.assertRaisesRegex(ValueError, "UUID v4"):
            loaded["validate_agent_message"](invalid)

    def test_registry_queries_and_unknown_dispatchable_ids_fail_closed(self) -> None:
        loaded = self._load_modules()
        registry = loaded["load_agent_registry"](dispatchable_agent_ids={"hep-mcp"})

        tools_agents = registry.list_agents(capability="mcp.list_tools", dispatchable_only=True)
        self.assertEqual(len(tools_agents), 1)
        self.assertEqual(tools_agents[0]["card"]["agent_id"], "hep-mcp")
        self.assertTrue(tools_agents[0]["available_for_dispatch"])

        idea_entry = registry.resolve_capability(
            "campaign.status",
            target_agent_id="idea-engine",
            dispatchable_only=False,
        )
        self.assertFalse(idea_entry["available_for_dispatch"])

        with self.assertRaisesRegex(RuntimeError, "dispatchable agent ids missing agent cards"):
            loaded["load_agent_registry"](dispatchable_agent_ids={"missing-agent"})

    def test_agent_card_validator_rejects_negative_paths(self) -> None:
        loaded = self._load_modules()
        cards_dir = loaded["builtin_agent_cards_dir"]()
        card = json.loads((cards_dir / "hep-mcp.json").read_text(encoding="utf-8"))

        unknown_key = deepcopy(card)
        unknown_key["unexpected"] = True
        with self.assertRaisesRegex(ValueError, "unexpected keys"):
            loaded["validate_agent_card"](unknown_key)

        duplicate_capability = deepcopy(card)
        duplicate_capability["capabilities"].append(deepcopy(duplicate_capability["capabilities"][0]))
        with self.assertRaisesRegex(ValueError, "duplicate capability_id"):
            loaded["validate_agent_card"](duplicate_capability)

        missing_contract = deepcopy(card)
        missing_contract["capabilities"][0]["input_contract_ids"] = ["missing_contract"]
        with self.assertRaisesRegex(ValueError, "references unknown contract_id"):
            loaded["validate_agent_card"](missing_contract)

    def test_agent_message_validator_enforces_payload_error_exclusivity(self) -> None:
        loaded = self._load_modules()
        schema = loaded["load_schema"]("agent_message_v1")
        validator = Draft202012Validator(schema)
        error_message = {
            "schema_version": 1,
            "message_id": "MSG-error",
            "trace_id": "0f5ca9e6-0d92-48f1-b906-8bd17cfce0af",
            "run_id": "RUN-2",
            "source_agent_id": "hep-mcp",
            "target_agent_id": "client",
            "message_kind": "error",
            "requested_capability": "mcp.call_tool",
            "payload": {},
            "error": {
                "domain": "hepar",
                "code": "INVALID_PARAMS",
                "message": "boom",
                "retryable": False,
                "run_id": "RUN-2",
                "trace_id": "0f5ca9e6-0d92-48f1-b906-8bd17cfce0af",
                "data": None,
            },
        }

        with self.assertRaises(ValidationError):
            validator.validate(error_message)
        with self.assertRaisesRegex(ValueError, "must not include payload"):
            loaded["validate_agent_message"](error_message)

        request_with_error = deepcopy(error_message)
        request_with_error["message_kind"] = "request"
        request_with_error.pop("payload")
        request_with_error["payload"] = {}
        with self.assertRaises(ValidationError):
            validator.validate(request_with_error)
        with self.assertRaisesRegex(ValueError, "must not include error"):
            loaded["validate_agent_message"](request_with_error)


if __name__ == "__main__":
    unittest.main()
