import tempfile
import unittest
import uuid
from pathlib import Path
from unittest.mock import patch

from a2a_test_support import is_uuid_v4, load_modules, start_server, write_mcp_config


class TestA2AAdapter(unittest.TestCase):
    def _load_modules(self):
        return load_modules()

    def _start_server(self, repo_root: Path):
        return start_server(repo_root)

    def test_config_defaults_fail_closed_and_non_loopback_requires_allowlist(self) -> None:
        loaded = self._load_modules()
        config = loaded["A2AAdapterConfig"]()
        self.assertFalse(config.enabled)
        config.validate()

        with tempfile.TemporaryDirectory() as td:
            repo_root = Path(td)
            with self.assertRaisesRegex(ValueError, "disabled"):
                loaded["A2AAdapterServer"](
                    config=config,
                    dispatch_context=loaded["AgentDispatchContext"](repo_root=repo_root),
                )

        with self.assertRaisesRegex(ValueError, "explicit allowlist"):
            loaded["A2AAdapterConfig"](enabled=True, bind_host="0.0.0.0", auth_token="secret-token").validate()

        loaded["A2AAdapterConfig"](
            enabled=True,
            bind_host="0.0.0.0",
            auth_token="secret-token",
            non_loopback_allowlist=("0.0.0.0",),
        ).validate()

    def test_auth_required_and_invalid_message_fail_closed(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            repo_root = Path(td)
            loaded, server, thread = self._start_server(repo_root)
            try:
                status, response = loaded["discover_agents"](url=server.base_url, auth_token="wrong-token")
                self.assertEqual(status, 401)
                envelope = response["error"]["data"]
                self.assertEqual(envelope["code"], "INVALID_PARAMS")
                self.assertEqual(envelope["data"]["reason"], "auth_required")
                self.assertTrue(is_uuid_v4(envelope["trace_id"]))

                bad_message = {
                    "schema_version": 1,
                    "message_id": "MSG-bad",
                    "trace_id": "not-a-uuid",
                    "run_id": "RUN-bad",
                    "source_agent_id": "client",
                    "target_agent_id": "hep-mcp",
                    "message_kind": "request",
                    "requested_capability": "mcp.list_tools",
                }
                status, response = loaded["send_agent_message"](
                    url=server.base_url,
                    auth_token="secret-token",
                    message=bad_message,
                )
                self.assertEqual(status, 400)
                envelope = response["error"]["data"]
                self.assertEqual(envelope["code"], "INVALID_PARAMS")
                self.assertEqual(envelope["data"]["reason"], "schema_invalid")
                self.assertTrue(is_uuid_v4(envelope["trace_id"]))
                self.assertNotEqual(envelope["trace_id"], bad_message["trace_id"])
            finally:
                server.shutdown()
                thread.join(timeout=2)

    def test_payload_too_large_fails_closed(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            repo_root = Path(td)
            loaded = self._load_modules()
            with patch.object(loaded["a2a_adapter_module"], "_MAX_REQUEST_BYTES", 32):
                loaded, server, thread = self._start_server(repo_root)
                try:
                    status, response = loaded["discover_agents"](url=server.base_url, auth_token="secret-token")
                    self.assertEqual(status, 413)
                    envelope = response["error"]["data"]
                    self.assertEqual(envelope["code"], "INVALID_PARAMS")
                    self.assertEqual(envelope["data"]["reason"], "payload_too_large")
                    self.assertEqual(envelope["data"]["max_bytes"], 32)
                finally:
                    server.shutdown()
                    thread.join(timeout=2)

    def test_discovery_and_dispatch_integration_with_stub_mcp(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            repo_root = Path(td)
            write_mcp_config(repo_root)
            loaded, server, thread = self._start_server(repo_root)
            try:
                status, response = loaded["discover_agents"](url=server.base_url, auth_token="secret-token")
                self.assertEqual(status, 200)
                entries = response["result"]["agents"]
                by_id = {entry["card"]["agent_id"]: entry for entry in entries}
                self.assertEqual(set(by_id), {"hep-mcp", "idea-engine"})
                self.assertTrue(by_id["hep-mcp"]["available_for_dispatch"])
                self.assertFalse(by_id["idea-engine"]["available_for_dispatch"])

                status, response = loaded["get_agent_card"](
                    url=server.base_url,
                    auth_token="secret-token",
                    agent_id="idea-engine",
                )
                self.assertEqual(status, 200)
                self.assertEqual(response["result"]["card"]["agent_id"], "idea-engine")
                self.assertFalse(response["result"]["available_for_dispatch"])

                trace_id = str(uuid.uuid4())
                status, response = loaded["send_agent_message"](
                    url=server.base_url,
                    auth_token="secret-token",
                    message={
                        "schema_version": 1,
                        "message_id": "MSG-call",
                        "trace_id": trace_id,
                        "run_id": "RUN-1",
                        "source_agent_id": "loopback-client",
                        "target_agent_id": "hep-mcp",
                        "message_kind": "request",
                        "requested_capability": "mcp.call_tool",
                        "payload": {"tool_name": "hep_health", "arguments": {}},
                    },
                )
                self.assertEqual(status, 200)
                message = response["result"]["message"]
                self.assertEqual(message["message_kind"], "response")
                self.assertEqual(message["trace_id"], trace_id)
                self.assertEqual(message["payload"]["tool_name"], "hep_health")
                self.assertTrue(message["payload"]["ok"])
                self.assertEqual(message["payload"]["result_json"]["ok"], True)

                status, response = loaded["send_agent_message"](
                    url=server.base_url,
                    auth_token="secret-token",
                    message={
                        "schema_version": 1,
                        "message_id": "MSG-idea",
                        "trace_id": str(uuid.uuid4()),
                        "run_id": "RUN-2",
                        "source_agent_id": "loopback-client",
                        "target_agent_id": "idea-engine",
                        "message_kind": "request",
                        "requested_capability": "campaign.status",
                        "payload": {},
                    },
                )
                self.assertEqual(status, 200)
                message = response["result"]["message"]
                self.assertEqual(message["message_kind"], "error")
                self.assertEqual(message["error"]["data"]["reason"], "binding_unavailable")
            finally:
                server.shutdown()
                thread.join(timeout=2)


if __name__ == "__main__":
    unittest.main()
