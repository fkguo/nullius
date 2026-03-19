import json
import sys
import threading
import time
import uuid
from pathlib import Path


def src_root() -> Path:
    return Path(__file__).resolve().parents[1] / "src"


def stub_server_path() -> Path:
    return Path(__file__).resolve().parent / "mcp_stub_server.py"


def is_uuid_v4(value: str) -> bool:
    try:
        return uuid.UUID(value).version == 4
    except ValueError:
        return False


def load_modules() -> dict[str, object]:
    root = str(src_root())
    added_path = False
    if root not in sys.path:
        sys.path.insert(0, root)
        added_path = True
    try:
        from hep_autoresearch.toolkit.a2a_adapter import A2AAdapterConfig, A2AAdapterServer
        import hep_autoresearch.toolkit.a2a_adapter as a2a_adapter_module
        from hep_autoresearch.toolkit.a2a_client import discover_agents, get_agent_card, send_agent_message
        from hep_autoresearch.toolkit.agent_bindings import AgentDispatchContext

        return {
            "A2AAdapterConfig": A2AAdapterConfig,
            "A2AAdapterServer": A2AAdapterServer,
            "AgentDispatchContext": AgentDispatchContext,
            "a2a_adapter_module": a2a_adapter_module,
            "discover_agents": discover_agents,
            "get_agent_card": get_agent_card,
            "send_agent_message": send_agent_message,
        }
    finally:
        if added_path:
            try:
                sys.path.remove(root)
            except ValueError:
                pass


def write_mcp_config(repo_root: Path) -> None:
    payload = {
        "mcpServers": {
            "hep-research": {
                "command": sys.executable,
                "args": ["-u", str(stub_server_path())],
                "env": {},
            }
        }
    }
    (repo_root / ".mcp.json").write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")


def start_server(repo_root: Path):
    loaded = load_modules()
    server = loaded["A2AAdapterServer"](
        config=loaded["A2AAdapterConfig"](enabled=True, auth_token="secret-token"),
        dispatch_context=loaded["AgentDispatchContext"](repo_root=repo_root, mcp_server_name="hep-research"),
    )
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    time.sleep(0.05)
    return loaded, server, thread
