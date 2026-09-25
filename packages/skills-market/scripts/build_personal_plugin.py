#!/usr/bin/env python3
"""Build a portable plugin payload; never install it or fetch dependencies."""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import tempfile

from install_skill_runtime.market_index import load_packages, pick_packages
from install_skill_runtime.package_contracts import ensure_skill_source
from install_skill_runtime.source_payload import collect_payload_files, git_head

DEFAULT_SERVERS = ("project-mcp", "hep-mcp", "idea-mcp")


def write_json(path: Path, value: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, sort_keys=True, indent=2) + "\n")


def absolute_path(value: str, label: str) -> Path:
    path = Path(value).expanduser()
    if not path.is_absolute():
        raise ValueError(f"{label} must be absolute")
    return path


def build(*, source_root: Path, output: Path, force: bool = False) -> dict:
    for label, path in (("source root", source_root), ("output", output)):
        if not path.is_absolute():
            raise ValueError(f"{label} must be absolute")
    source_root = source_root.resolve(strict=True)
    if output.name != "nullius" or output.is_symlink():
        raise ValueError("output must be a non-symlink directory named nullius")
    output = output.resolve()
    if output.is_relative_to(source_root) or source_root.is_relative_to(output):
        raise ValueError("output must be outside the source checkout")
    if output.exists() and (not force or not output.is_dir()):
        raise ValueError("output already exists; use --force to replace a plugin directory")
    if output.exists() and not (output / ".codex-plugin/plugin.json").is_file():
        raise ValueError("refuse to replace a directory that is not a plugin")
    if not (source_root / "pnpm-workspace.yaml").is_file():
        raise ValueError("source root must be a Nullius workspace")
    packages = load_packages(source_root / "packages/skills-market")
    skill_ids = pick_packages(all_skills=True, package_ids=[], packages=packages)
    actual_ids = sorted(p.parent.name for p in (source_root / "skills").glob("*/SKILL.md"))
    if actual_ids != skill_ids:
        raise ValueError("catalog skill-pack set does not match repository skills")
    status = subprocess.run(["git", "-C", str(source_root), "status", "--porcelain", "--untracked-files=all"],
                            text=True, capture_output=True, check=True).stdout
    manifest = {
        "format": "nullius-personal-plugin", "format_version": 1,
        "source_commit": git_head(source_root), "source_dirty": bool(status.strip()),
        "skill_ids": skill_ids, "files": {},
    }
    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix=".nullius-stage-", dir=output.parent) as temporary:
        stage = Path(temporary) / "nullius"
        stage.mkdir()
        for skill_id in skill_ids:
            source = ensure_skill_source(skill_id, packages[skill_id])
            source_dir = source_root / source["subpath"]
            if not source_dir.resolve().is_relative_to(source_root):
                raise ValueError(f"skill source escapes checkout: {skill_id}")
            files = collect_payload_files(source_dir, source["include"], source.get("exclude", []))
            for original in files:
                relative = original.relative_to(source_dir)
                target = stage / "skills" / skill_id / relative
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(original, target, follow_symlinks=False)
                manifest["files"][target.relative_to(stage).as_posix()] = {
                    "source": original.relative_to(source_root).as_posix(),
                    "sha256": hashlib.sha256(target.read_bytes()).hexdigest(),
                }
            write_json(stage / "skills" / skill_id / ".market_install.json", {
                "package_id": skill_id, "install_mode": "personal-plugin",
                "commit": manifest["source_commit"],
                "source_dirty": manifest["source_dirty"], "file_count": len(files),
            })
        common = {"name": "nullius", "version": "0.1.0", "description": "Research workflows using the configured Nullius runtime.",
                  "author": {"name": "Nullius"}, "skills": "./skills/", "mcpServers": "./.mcp.json"}
        write_json(stage / ".claude-plugin/plugin.json", common)
        write_json(stage / ".codex-plugin/plugin.json", {**common, "interface": {
            "displayName": "Nullius", "shortDescription": "Local research workflows and verification",
            "longDescription": "Existing Nullius skills and project, HEP, and idea tools using the configured Nullius runtime.",
            "developerName": "Nullius", "category": "Productivity", "capabilities": ["Interactive", "Write"],
            "defaultPrompt": ["Recover this project and identify its next verifiable research step."],
        }})
        write_json(stage / ".mcp.json", {"mcpServers": {
            name: {"command": "nullius", "args": ["runtime", "mcp", name]}
            for name in DEFAULT_SERVERS
        }})
        write_json(stage / "SOURCE_MANIFEST.json", manifest)
        (stage / "README.md").write_text(
            "# Nullius personal plugin\n\n"
            "This portable payload contains copied skills and host manifests. Install the Nullius CLI on each machine "
            "and make `nullius` available on the MCP host's PATH. Runtime packages, Python, Node, pnpm, external CLIs, "
            "scientific tools, credentials and provider data remain local dependencies.\n\n"
            "MCP servers start through `nullius runtime mcp <server-name>`. Configure the external project, idea store "
            "and provider settings under servers.<server-name>.env in the machine's private runtime configuration. "
            "Set NULLIUS_RUNTIME_CONFIG to its absolute file path, or use ${XDG_CONFIG_HOME:-$HOME/.config}/nullius/runtime.json. "
            "Keep that file outside this plugin. "
            "GUI hosts must receive their PATH and any configuration environment explicitly; a terminal export alone "
            "does not configure them. Project and idea servers require an external project; idea also requires its data directory. "
            "A bound project becomes the server working directory; HEP can run standalone without that binding. "
            "Existing HEP tools retain their local-server trust and capabilities; this plugin adds no sandbox.\n\n"
            "Copied skill helpers use an explicit NULLIUS_WORKSPACE_ROOT, a source ancestor, or `nullius runtime path`. "
            "No source checkout, executable, project, data or credential path is embedded in the generated manifests. "
            "You can copy this directory to another location without rebuilding it; configure the destination runtime "
            "separately. Skills are snapshots: rebuild and reload after source skill changes. SOURCE_MANIFEST.json "
            "records the source commit, dirty boolean, relative source paths and payload hashes; dirty source is not "
            "an immutable commit pin. No ChatGPT connection, tunnel or authentication is created.\n")
        backup = Path(temporary) / "previous"
        if output.exists():
            output.rename(backup)
        try:
            stage.rename(output)
        except BaseException:
            if backup.exists():
                backup.rename(output)
            raise
    return manifest


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source-root", required=True)
    parser.add_argument("--output", required=True, help="Absolute output directory, basename nullius")
    parser.add_argument("--force", action="store_true")
    args = parser.parse_args()
    try:
        manifest = build(source_root=absolute_path(args.source_root, "source root"),
                         output=absolute_path(args.output, "output"),
                         force=args.force)
    except (OSError, ValueError, RuntimeError, subprocess.CalledProcessError) as exc:
        parser.exit(1, f"error: {exc}\n")
    print(f"Built {len(manifest['skill_ids'])} skills at {args.output}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
