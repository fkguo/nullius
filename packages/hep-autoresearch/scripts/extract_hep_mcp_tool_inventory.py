#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import os
import subprocess
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


@dataclass(frozen=True)
class RepoInfo:
    repo_root: str
    package_dir: str
    entrypoint: str
    version: str | None
    git_commit: str | None
    git_dirty: bool | None


def _utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _run(cmd: list[str], *, cwd: Path | None = None, env: dict[str, str] | None = None) -> str:
    proc = subprocess.run(
        cmd,
        cwd=str(cwd) if cwd else None,
        env=env,
        check=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )
    return proc.stdout


def _try_git_info(repo_root: Path) -> tuple[str | None, bool | None]:
    try:
        commit = _run(["git", "-C", str(repo_root), "rev-parse", "HEAD"]).strip()
    except Exception:
        return None, None
    try:
        dirty = _run(["git", "-C", str(repo_root), "status", "--porcelain"]).strip() != ""
    except Exception:
        dirty = None
    return commit, dirty


def _read_package_version(repo_root: Path) -> str | None:
    pkg_path = repo_root / "package.json"
    if not pkg_path.exists():
        return None
    try:
        raw = json.loads(pkg_path.read_text("utf-8"))
        v = raw.get("version")
        return str(v) if v is not None else None
    except Exception:
        return None


def _resolve_default_package_dir() -> Path:
    env_override = os.environ.get("HEP_MCP_PACKAGE_DIR")
    if env_override:
        return Path(env_override).expanduser().resolve()
    repo_candidate = Path(__file__).resolve().parents[3] / "packages" / "hep-mcp"

    candidates = [
        repo_candidate,
        Path.home() / "Coding/Agents/autoresearch-lab/packages/hep-mcp",
    ]
    for cand in candidates:
        if (cand / "dist/index.js").exists():
            return cand.resolve()
    for cand in candidates:
        if cand.exists():
            return cand.resolve()
    raise SystemExit(
        "Cannot find hep-mcp package dir.\n"
        "Pass --hep-mcp-package-dir or set $HEP_MCP_PACKAGE_DIR."
    )


def _repo_info(package_dir: Path) -> RepoInfo:
    repo_root = package_dir.parent.parent  # packages/hep-mcp -> repo root
    version = _read_package_version(repo_root)
    commit, dirty = _try_git_info(repo_root)
    return RepoInfo(
        repo_root=str(repo_root),
        package_dir=str(package_dir),
        entrypoint="dist/index.js",
        version=version,
        git_commit=commit,
        git_dirty=dirty,
    )


def _node_list_tools(
    *,
    package_dir: Path,
    mode: str,
    hep_data_dir: Path,
    include_input_schema: bool,
) -> dict[str, Any]:
    js = r"""
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

function summarizeInputSchema(inputSchema, includeFull) {
  if (!inputSchema || typeof inputSchema !== 'object') return null;
  if (includeFull) return inputSchema;
  const props = inputSchema.properties && typeof inputSchema.properties === 'object'
    ? Object.keys(inputSchema.properties).sort()
    : null;
  const req = Array.isArray(inputSchema.required) ? [...inputSchema.required].sort() : null;
  const out = { type: inputSchema.type ?? null, properties: props, required: req };
  return out;
}

async function main() {
  const mode = process.env.HEP_TOOL_MODE ?? 'standard';
  const includeFull = (process.env.HEP_INCLUDE_INPUT_SCHEMA ?? '0') === '1';

  const transport = new StdioClientTransport({
    command: 'node',
    args: ['dist/index.js'],
    env: { ...process.env, HEP_TOOL_MODE: mode },
  });

  const client = new Client({ name: `tool-inventory-${mode}`, version: '0.0.1' }, { capabilities: {} });
  await client.connect(transport);
  const { tools } = await client.listTools();
  await client.close();

  const normalized = tools
    .map(t => ({
      name: t.name,
      description: t.description ?? null,
      input_schema: summarizeInputSchema(t.inputSchema ?? null, includeFull),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  console.log(JSON.stringify({ mode, tool_count: normalized.length, tools: normalized }, null, 2));
}

await main();
"""
    env = dict(os.environ)
    env["HEP_TOOL_MODE"] = mode
    env["HEP_DATA_DIR"] = str(hep_data_dir)
    env["HEP_INCLUDE_INPUT_SCHEMA"] = "1" if include_input_schema else "0"

    raw = _run(["node", "--input-type=module", "-e", js], cwd=package_dir, env=env)
    return json.loads(raw)


def _group_prefix(tool_name: str) -> str:
    if "_" not in tool_name:
        return "misc"
    return tool_name.split("_", 1)[0]


def _write_markdown(out_path: Path, payload: dict[str, Any]) -> None:
    src = payload["source"]
    modes = payload["modes"]

    def fmt(v: Any) -> str:
        return "null" if v is None else str(v)

    lines: list[str] = []
    lines.append("# hep-mcp tool inventory")
    lines.append("")
    lines.append(f"- Generated at (UTC): {payload['generated_at']}")
    lines.append(f"- Repo root: `{src['repo_root']}`")
    lines.append(f"- Package dir: `{src['package_dir']}`")
    lines.append(f"- Entrypoint: `{src['entrypoint']}`")
    lines.append(f"- Version: `{fmt(src.get('version'))}`")
    lines.append(f"- Git commit: `{fmt(src.get('git_commit'))}`")
    lines.append(f"- Git dirty: `{fmt(src.get('git_dirty'))}`")
    lines.append("")

    for mode in ["standard", "full"]:
        if mode not in modes:
            continue
        tools = modes[mode]["tools"]
        lines.append(f"## {mode} ({len(tools)})")
        lines.append("")
        groups: dict[str, list[dict[str, Any]]] = {}
        for t in tools:
            groups.setdefault(_group_prefix(t["name"]), []).append(t)
        for prefix in sorted(groups.keys()):
            lines.append(f"### {prefix} ({len(groups[prefix])})")
            lines.append("")
            for t in groups[prefix]:
                desc = t.get("description") or ""
                desc = " ".join(desc.split())
                if len(desc) > 140:
                    desc = desc[:137] + "..."
                lines.append(f"- `{t['name']}` — {desc}")
            lines.append("")

    if "standard" in modes and "full" in modes:
        std = {t["name"] for t in modes["standard"]["tools"]}
        full = {t["name"] for t in modes["full"]["tools"]}
        extra = sorted(full - std)
        lines.append("## full - standard")
        lines.append("")
        lines.append(f"- Extra tools: {len(extra)}")
        for name in extra:
            lines.append(f"  - `{name}`")
        lines.append("")

    out_path.write_text("\n".join(lines).rstrip() + "\n", "utf-8")


def main() -> None:
    ap = argparse.ArgumentParser(
        description="Extract hep-mcp MCP tool inventory via listTools (no build)."
    )
    ap.add_argument(
        "--hep-mcp-package-dir",
        type=str,
        default=None,
        help="Path to hep-mcp package dir (e.g., .../packages/hep-mcp).",
    )
    ap.add_argument(
        "--out-dir",
        type=str,
        default="references/hep-mcp",
        help="Output directory (relative to project root by default).",
    )
    ap.add_argument(
        "--hep-data-dir",
        type=str,
        default="references/_tmp_hep_data/tool_inventory",
        help="HEP_DATA_DIR for the spawned server (kept inside this repo by default).",
    )
    ap.add_argument(
        "--modes",
        choices=["standard", "full", "both"],
        default="both",
        help="Which HEP_TOOL_MODE(s) to inventory.",
    )
    ap.add_argument(
        "--include-input-schema",
        action="store_true",
        help="Include full JSON schema for each tool (can be large).",
    )
    args = ap.parse_args()

    project_root = Path(__file__).resolve().parent.parent
    package_dir = (
        Path(args.hep_mcp_package_dir).expanduser().resolve()
        if args.hep_mcp_package_dir
        else _resolve_default_package_dir()
    )
    out_dir = (project_root / args.out_dir).resolve()
    hep_data_dir = (project_root / args.hep_data_dir).resolve()

    out_dir.mkdir(parents=True, exist_ok=True)
    hep_data_dir.mkdir(parents=True, exist_ok=True)

    info = _repo_info(package_dir)

    selected_modes = ["standard", "full"] if args.modes == "both" else [args.modes]
    modes: dict[str, Any] = {}
    for mode in selected_modes:
        modes[mode] = _node_list_tools(
            package_dir=package_dir,
            mode=mode,
            hep_data_dir=hep_data_dir,
            include_input_schema=args.include_input_schema,
        )

    payload: dict[str, Any] = {
        "generated_at": _utc_now_iso(),
        "source": {
            "repo_root": info.repo_root,
            "package_dir": info.package_dir,
            "entrypoint": info.entrypoint,
            "version": info.version,
            "git_commit": info.git_commit,
            "git_dirty": info.git_dirty,
        },
        "modes": modes,
        "notes": [
            "This inventory is obtained via MCP listTools against the package entrypoint.",
            "The spawned server uses the provided HEP_DATA_DIR (kept inside this repo by default).",
        ],
    }

    out_json = out_dir / "tool_inventory.json"
    out_md = out_dir / "tool_inventory.md"
    out_json.write_text(json.dumps(payload, indent=2, ensure_ascii=False) + "\n", "utf-8")
    _write_markdown(out_md, payload)

    print(f"Wrote: {out_json}")
    print(f"Wrote: {out_md}")


if __name__ == "__main__":
    main()
