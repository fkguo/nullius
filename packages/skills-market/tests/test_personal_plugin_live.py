"""Opt-in real stdio composition smoke; no provider calls or external credentials."""
from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import queue
import shlex
import shutil
import subprocess
import sys
import threading
import time

import pytest

ROOT = Path(__file__).resolve().parents[3]
BUILDER = ROOT / "packages/skills-market/scripts/build_personal_plugin.py"
pytestmark = pytest.mark.skipif(
    os.environ.get("NULLIUS_REAL_PLUGIN_SMOKE") != "1",
    reason="explicit live smoke requires built workspace packages",
)


def run(command, *, cwd, env, timeout=60):
    result = subprocess.run(command, cwd=cwd, env=env, text=True, capture_output=True, timeout=timeout)
    assert result.returncode == 0, f"{command}\n{result.stdout}\n{result.stderr}"
    return result


def process_cwd(pid: int) -> Path:
    proc_link = Path(f"/proc/{pid}/cwd")
    if proc_link.exists():
        return proc_link.resolve()
    lsof = shutil.which("lsof")
    assert lsof, "This smoke needs /proc or lsof to observe server cwd"
    result = subprocess.run([lsof, "-a", "-p", str(pid), "-d", "cwd", "-Fn"],
                            text=True, capture_output=True, timeout=10, check=True)
    return Path(next(line[1:] for line in result.stdout.splitlines() if line.startswith("n"))).resolve()


def inspect_server(config: dict, *, project: Path, environment: dict) -> dict:
    messages: queue.Queue[str | None] = queue.Queue()
    diagnostics: list[str] = []
    process = subprocess.Popen([config["command"], *config["args"]], cwd=ROOT,
                               env={**environment, **config.get("env", {})}, stdin=subprocess.PIPE,
                               stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, bufsize=1)

    def stdout_reader():
        for line in process.stdout:
            messages.put(line)
        messages.put(None)

    def stderr_reader():
        for line in process.stderr:
            if len(diagnostics) < 100:
                diagnostics.append(line)

    threads = [threading.Thread(target=stdout_reader, daemon=True), threading.Thread(target=stderr_reader, daemon=True)]
    for thread in threads:
        thread.start()

    def send(value):
        process.stdin.write(json.dumps(value) + "\n")
        process.stdin.flush()

    def receive(request_id):
        deadline = time.monotonic() + 30
        while time.monotonic() < deadline:
            try:
                line = messages.get(timeout=max(0.01, deadline - time.monotonic()))
            except queue.Empty:
                raise AssertionError("MCP response timeout: " + "".join(diagnostics))
            assert line is not None, "MCP closed stdout: " + "".join(diagnostics)
            value = json.loads(line)
            if value.get("id") == request_id:
                assert "error" not in value, value
                return value["result"]
        raise AssertionError("MCP response deadline")

    try:
        send({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {
            "protocolVersion": "2024-11-05", "capabilities": {},
            "clientInfo": {"name": "nullius-local-composition-smoke", "version": "1.0.0"},
        }})
        initialized = receive(1)
        send({"jsonrpc": "2.0", "method": "notifications/initialized"})
        send({"jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": {}})
        listed = receive(2)
        assert not listed.get("nextCursor"), "Inventory needs explicit pagination support"
        names = [tool["name"] for tool in listed["tools"]]
        assert len(names) == len(set(names)), names
        observed = process_cwd(process.pid)
        assert observed == project.resolve()
        # The CLI supervises a child Node process; observe the server itself too.
        processes = subprocess.run(["ps", "-axo", "pid=,ppid="], text=True, capture_output=True,
                                   check=True, timeout=10)
        children = [int(parts[0]) for line in processes.stdout.splitlines()
                    if len(parts := line.split()) == 2 and int(parts[1]) == process.pid]
        assert children, "The runtime launcher must have a live MCP server child"
        server_cwds = [process_cwd(pid) for pid in children]
        assert all(cwd == project.resolve() for cwd in server_cwds)
        return {"server_info": initialized["serverInfo"], "count": len(names), "tools": names,
                "observed_cwd": str(observed), "server_cwds": [str(cwd) for cwd in server_cwds],
                "diagnostics": diagnostics}
    finally:
        if process.poll() is None:
            process.terminate()
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=5)
        for thread in threads:
            thread.join(timeout=1)
        for stream in (process.stdin, process.stdout, process.stderr):
            stream.close()


def copied_runtime_checkout(destination: Path) -> None:
    """Copy real runtime code; reuse installed third-party dependencies only."""
    shutil.copytree(ROOT, destination, symlinks=True, ignore=shutil.ignore_patterns(
        ".git", "node_modules", ".venv", "__pycache__", ".pytest_cache",
    ))
    shutil.copytree(ROOT / "node_modules", destination / "node_modules", symlinks=True,
                    ignore=shutil.ignore_patterns(".pnpm"))
    (destination / "node_modules/.pnpm").symlink_to(ROOT / "node_modules/.pnpm", target_is_directory=True)
    for original in (ROOT / "packages").glob("*/node_modules"):
        copied = destination / original.relative_to(ROOT)
        shutil.copytree(original, copied, symlinks=True)
        for dependency in (copied / "@nullius").glob("*"):
            assert dependency.resolve().is_relative_to(destination), "Workspace dependencies must use the second checkout"


def test_real_plugin_composition_and_copied_skill_execution(tmp_path):
    node = shutil.which("node")
    assert node
    original_plugin = tmp_path / "original-plugin/nullius"
    original_skills = tmp_path / "original-skills"
    environment = {key: value for key, value in os.environ.items() if not key.startswith(
        ("NULLIUS_", "IDEA_MCP_", "HEP_", "PDG_", "ZOTERO_")
    )}
    run([sys.executable, "-B", str(BUILDER), "--source-root", str(ROOT), "--output", str(original_plugin)],
        cwd=ROOT, env=environment)
    run([sys.executable, "-B", str(ROOT / "packages/skills-market/scripts/install_skill.py"),
         "--platform", "codex", "--source-root", str(ROOT), "--target-root", str(original_skills),
         "--package", "research-team"], cwd=ROOT, env=environment)
    plugin = tmp_path / "destination/plugins/nullius"
    skills = tmp_path / "destination/skills"
    # Actual migration: copy the already generated outputs, then remove their old locations.
    shutil.copytree(original_plugin, plugin)
    shutil.copytree(original_skills, skills)
    shutil.rmtree(original_plugin)
    shutil.rmtree(original_skills)
    manifest = json.loads((plugin / "SOURCE_MANIFEST.json").read_text())
    for relative, record in manifest["files"].items():
        assert hashlib.sha256((plugin / relative).read_bytes()).hexdigest() == record["sha256"]
    for tree in (plugin, skills):
        for path in tree.rglob("*"):
            if path.is_file():
                data = path.read_bytes()
                assert str(ROOT).encode() not in data
                assert str(original_plugin).encode() not in data
                assert str(original_skills).encode() not in data

    runtime = tmp_path / "destination/runtime-checkout"
    copied_runtime_checkout(runtime)
    runtime_cli = runtime / "packages/orchestrator/dist/cli.js"
    assert runtime_cli.is_file()
    cli_bin = tmp_path / "destination/bin"
    cli_bin.mkdir()
    cli = cli_bin / "nullius"
    cli.write_text("#!/bin/sh\nexec " + shlex.quote(node) + " " + shlex.quote(str(runtime_cli)) + ' "$@"\n')
    cli.chmod(0o755)
    environment["PATH"] = str(cli_bin) + os.pathsep + environment["PATH"]
    resolved = run(["nullius", "runtime", "path"], cwd=tmp_path, env=environment)
    assert Path(resolved.stdout.strip()) == runtime

    project = tmp_path / "destination/project"
    project.mkdir()
    private_config = tmp_path / "destination/private/runtime.json"
    private_config.parent.mkdir()
    private_config.write_text(json.dumps({"servers": {
        "project-mcp": {"env": {"NULLIUS_PROJECT_ROOT": str(project)}},
        "hep-mcp": {"env": {
            "NULLIUS_PROJECT_ROOT": str(project), "HEP_DATA_DIR": str(tmp_path / "hep"),
            "HEP_DOWNLOAD_DIR": str(tmp_path / "hep/downloads"), "PDG_DATA_DIR": str(tmp_path / "hep/pdg"),
            "HEP_DISCOVERY_TTL_HOURS": "0", "PDG_ARTIFACT_TTL_HOURS": "0",
        }},
        "idea-mcp": {"env": {"NULLIUS_PROJECT_ROOT": str(project), "IDEA_MCP_DATA_DIR": str(tmp_path / "idea-data")}},
    }}))
    environment["NULLIUS_RUNTIME_CONFIG"] = str(private_config)
    run(["nullius", "init", "--project-root", str(project), "--no-git"], cwd=tmp_path, env=environment)
    markers = [".nullius/HARNESS", ".nullius/state.json", ".nullius/bin/nullius"]
    assert all((project / marker).is_file() for marker in markers)
    config = json.loads((plugin / ".mcp.json").read_text())["mcpServers"]
    assert set(config) == {"project-mcp", "hep-mcp", "idea-mcp"}
    report = {"project_markers": markers, "plugin": str(plugin), "runtime": str(runtime),
              "ordinary_skills": str(skills), "original_outputs_removed": True,
              "third_party_dependencies": "reused local dependency store; workspace packages copied", "servers": {}}
    all_names = []
    for name, server in config.items():
        assert server == {"command": "nullius", "args": ["runtime", "mcp", name]}
        inventory = inspect_server(server, project=project, environment=environment)
        report["servers"][name] = inventory
        all_names.extend(inventory["tools"])
    assert len(all_names) == len(set(all_names)), "Composed tools must not collide"
    assert 20 <= report["servers"]["project-mcp"]["count"] <= 30
    assert report["servers"]["hep-mcp"]["count"] == 75
    assert report["servers"]["idea-mcp"]["count"] == 6
    helped = []
    for script in sorted((plugin / "skills/research-harness/scripts").glob("*.py")):
        result = run([sys.executable, "-B", str(script), "--help"], cwd=project, env=environment)
        assert "usage:" in result.stdout.lower()
        helped.append(script.name)
    assert len(helped) == 3
    report["copied_harness_help"] = helped
    for label, tree in (("plugin", plugin / "skills"), ("ordinary", skills)):
        scaffold = tmp_path / (label + "-skill-project")
        result = run(["bash", str(tree / "research-team/scripts/bin/scaffold_research_workflow.sh"),
                      "--root", str(scaffold), "--project", "plugin-smoke", "--skip-prework"], cwd=project, env=environment)
        assert all((scaffold / name).is_file() for name in ("AGENTS.md", "research_plan.md", "research_contract.md", "project_index.md"))
        resolved = run([sys.executable, "-B", str(tree / "research-team/scripts/lib/literature_workflow_plan.py")],
                       cwd=project, env=environment)
        assert Path(resolved.stdout.strip()) == runtime
        report[label + "_team_scaffold"] = {"root": str(scaffold), "resolved_workspace": resolved.stdout.strip()}
    report_path = tmp_path / "composition-report.json"
    report_path.write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps({"counts": {name: value["count"] for name, value in report["servers"].items()},
                      "report": str(report_path)}, sort_keys=True))
