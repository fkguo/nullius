from __future__ import annotations

import json
import os
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class McpServerConfig:
    """Minimal MCP server config (stdio transport)."""

    name: str
    command: str
    args: tuple[str, ...]
    env: dict[str, str]


def _as_str_dict(obj: object) -> dict[str, str]:
    if not isinstance(obj, dict):
        return {}
    out: dict[str, str] = {}
    for k, v in obj.items():
        if isinstance(k, str) and isinstance(v, str):
            out[k] = v
    return out


def load_mcp_server_config(*, config_path: Path, server_name: str) -> McpServerConfig:
    payload = json.loads(config_path.read_text(encoding="utf-8"))
    if not isinstance(payload, dict):
        raise ValueError("mcp config must be a JSON object")

    servers = payload.get("mcpServers")
    if not isinstance(servers, dict):
        raise ValueError("mcp config missing mcpServers")

    raw = servers.get(server_name)
    if not isinstance(raw, dict):
        raise KeyError(f"mcp server not found in config: {server_name!r}")

    cmd = raw.get("command")
    if not isinstance(cmd, str) or not cmd.strip():
        raise ValueError(f"mcp server {server_name!r} missing command")

    args_raw = raw.get("args", [])
    if args_raw is None:
        args_raw = []
    if not isinstance(args_raw, list) or not all(isinstance(x, str) and x.strip() for x in args_raw):
        raise ValueError(f"mcp server {server_name!r} args must be a list of strings")

    env = _as_str_dict(raw.get("env"))

    return McpServerConfig(
        name=str(server_name),
        command=str(cmd).strip(),
        args=tuple(str(x).strip() for x in args_raw),
        env=env,
    )


def default_hep_data_dir(*, repo_root: Path) -> Path:
    """Default HEP_DATA_DIR for this repo (aligned with .hep/workspace.json convention)."""
    # Keep this deterministic and local-by-default. Users can override by exporting HEP_DATA_DIR.
    return (repo_root / ".hep-research-mcp").resolve()


_MCP_SUBPROCESS_ENV_ALLOWLIST = frozenset(
    {
        # Common exec
        "PATH",
        # Node.js (many MCP servers are Node-based; these are not secrets)
        "NODE_PATH",
        "NODE_OPTIONS",
        "NVM_DIR",
        "NVM_BIN",
        "npm_config_prefix",
        "PNPM_HOME",
        # Python (test stubs or python-based MCP servers)
        "PYTHONPATH",
        "VIRTUAL_ENV",
        # Locale
        "LANG",
        "LC_ALL",
        "LC_CTYPE",
        # User/home (some tools infer defaults from HOME)
        "HOME",
        "USER",
        "LOGNAME",
        # Temp
        "TMPDIR",
        "TEMP",
        "TMP",
        # Shell (rarely needed, but safe)
        "SHELL",
        # H-20: MCP server configuration keys
        "HEP_TOOL_MODE",
        "PDG_DB_PATH",
        "PDG_ARTIFACT_TTL_HOURS",
    }
)


def merged_env(*, base: dict[str, str] | None = None, overrides: dict[str, str] | None = None) -> dict[str, str]:
    # Build a *scoped* environment for the MCP subprocess.
    #
    # Security note: Do NOT forward the full parent environment by default. The MCP server is an
    # external process; forwarding all env vars risks leaking secrets (API keys/tokens) into logs.
    base_env = base if base is not None else os.environ
    env: dict[str, str] = {}
    for k in _MCP_SUBPROCESS_ENV_ALLOWLIST:
        v = base_env.get(k)
        if isinstance(v, str) and v.strip():
            env[k] = v
    if overrides:
        for k, v in overrides.items():
            if isinstance(k, str) and isinstance(v, str):
                env[k] = v
    return env
