from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys

import pytest

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "packages/skills-market/scripts"))
from build_personal_plugin import DEFAULT_SERVERS, build
from install_skill_runtime.market_index import load_packages
from install_skill_runtime.source_payload import collect_payload_files


def _write_nullius_workspace(root):
    root.mkdir(parents=True, exist_ok=True)
    (root / "pnpm-workspace.yaml").write_text("packages: []\n")
    (root / "package.json").write_text(json.dumps({"name": "nullius"}))
    package = root / "packages/orchestrator/package.json"
    package.parent.mkdir(parents=True, exist_ok=True)
    package.write_text(json.dumps({"name": "@nullius/orchestrator", "bin": {"nullius": "dist/cli.js"}}))
    for relative in ("packages/orchestrator/src/cli.ts", "packages/literature-workflows/src/index.ts",
                     "packages/project-contracts/src/project_contracts/research_contract.py"):
        target = root / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text("# unit fixture\n")


@pytest.fixture
def packed(tmp_path):
    """Copy real catalog/payload; packaging must not require a built runtime."""
    source = tmp_path / "source"
    source.mkdir()
    (source / "pnpm-workspace.yaml").write_text("packages: []\n")
    shutil.copytree(ROOT / "packages/skills-market/packages", source / "packages/skills-market/packages")
    for package in load_packages(ROOT / "packages/skills-market").values():
        if package["package_type"] != "skill-pack":
            continue
        config = package["source"]
        directory = ROOT / config["subpath"]
        for original in collect_payload_files(directory, config["include"], config.get("exclude", [])):
            target = source / original.relative_to(ROOT)
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(original, target)
    (source / "private-project-filename.txt").write_text("not a public payload\n")
    subprocess.run(["git", "init", "-q", str(source)], check=True)
    output = tmp_path / "plugins/nullius"
    manifest = build(source_root=source, output=output)
    return source, output, manifest


def test_complete_source_payload_and_manifests(packed):
    source, output, manifest = packed
    assert len(manifest["skill_ids"]) == 31
    assert sorted(p.name for p in (output / "skills").iterdir()) == manifest["skill_ids"]
    assert manifest["source_dirty"] is True
    assert set(manifest) == {"format", "format_version", "source_commit", "source_dirty", "skill_ids", "files"}
    for relative, record in manifest["files"].items():
        copied = output / relative
        assert not Path(relative).is_absolute()
        assert not Path(record["source"]).is_absolute()
        assert copied.read_bytes() == (source / record["source"]).read_bytes()
        assert hashlib.sha256(copied.read_bytes()).hexdigest() == record["sha256"]
        assert not copied.is_symlink()
        assert not ({"tests", "test", "dev", "tmp", "__pycache__", ".pytest_cache"} & set(copied.relative_to(output).parts))
        assert copied.name not in {".env", "credentials.json", "oauth_creds.json"}
    for required in ["research-harness/scripts/check_launch_authorization.py",
                     "research-harness/scripts/compute_job_probe.py",
                     "research-harness/scripts/independent_reproduction_check.py",
                     "research-team/FULL_VALIDATION_CONTRACT.md"]:
        assert (output / "skills" / required).is_file()
    for host in ("codex", "claude"):
        config = json.loads((output / f".{host}-plugin/plugin.json").read_text())
        assert config["name"] == output.name == "nullius"
        assert config["mcpServers"] == "./.mcp.json"
        assert "apps" not in config
    assert not (output / ".app.json").exists()
    assert not (output / "scripts").exists()
    servers = json.loads((output / ".mcp.json").read_text())["mcpServers"]
    assert set(servers) == set(DEFAULT_SERVERS)
    for name, server in servers.items():
        assert server == {"command": "nullius", "args": ["runtime", "mcp", name]}
    for path in output.rglob("*"):
        if path.is_file():
            payload = path.read_bytes()
            assert str(source).encode() not in payload
            assert str(output).encode() not in payload
            assert b"private-project-filename.txt" not in payload
    for path in (output / "skills").glob("*/.market_install.json"):
        assert "source_workspace_root" not in json.loads(path.read_text())


def test_repeatable_build_and_explicit_replacement(packed, tmp_path):
    source, output, manifest = packed
    with pytest.raises(ValueError, match="already exists"):
        build(source_root=source, output=output)
    repeated = build(source_root=source, output=output, force=True)
    assert repeated == manifest
    unsafe = tmp_path / "other/nullius"
    unsafe.mkdir(parents=True)
    (unsafe / "keep").write_text("user data")
    with pytest.raises(ValueError, match="not a plugin"):
        build(source_root=source, output=unsafe, force=True)
    assert (unsafe / "keep").read_text() == "user data"
    link = tmp_path / "symlinks/nullius"
    link.parent.mkdir()
    link.symlink_to(output, target_is_directory=True)
    with pytest.raises(ValueError, match="non-symlink"):
        build(source_root=source, output=link, force=True)


def test_moved_copied_helpers_use_current_runtime_and_sibling_runners(packed, tmp_path):
    source, original, _ = packed
    output = tmp_path / "another-host/nullius"
    shutil.copytree(original, output)
    shutil.rmtree(original)
    destination_runtime = tmp_path / "another-checkout"
    _write_nullius_workspace(destination_runtime)
    cli_bin = tmp_path / "bin"
    cli_bin.mkdir()
    cli = cli_bin / "nullius"
    cli.write_text(f"#!{sys.executable}\nimport sys\nassert sys.argv[1:] == ['runtime', 'path']\nprint({str(destination_runtime)!r})\n")
    cli.chmod(0o755)
    environment = {**os.environ, "PATH": str(cli_bin) + os.pathsep + os.environ["PATH"],
                   "CODEX_HOME": str(tmp_path / "old-host"), "CLAUDE_CONFIG_DIR": str(tmp_path / "old-host")}
    environment.pop("NULLIUS_WORKSPACE_ROOT", None)
    # Obsolete provenance must never regain runtime authority, even if malformed.
    (output / "skills/research-team/.market_install.json").write_text("invalid obsolete record")
    subprocess_checks = [
        ("research-team/scripts/lib/literature_workflow_plan.py", "_workspace_root", destination_runtime),
        ("research-team/scripts/bin/refresh_research_contract.py", "_repo_root", destination_runtime),
        ("review-swarm/scripts/bin/run_multi_task.py", "_agent_skills_root", output / "skills"),
        ("research-writer/scripts/bin/research_writer_learn_discussion_logic.py", "_agent_skills_root", output / "skills"),
        ("paper-reviser/scripts/bin/build_verification_plan.py", "_default_skills_dir", output / "skills"),
    ]
    for relative, function, expected in subprocess_checks:
        script = output / "skills" / relative
        code = "import runpy,sys; ns=runpy.run_path(sys.argv[1]); print(ns[sys.argv[2]]())"
        result = subprocess.run([sys.executable, "-B", "-c", code, str(script), function], env=environment,
                                text=True, capture_output=True, timeout=10)
        assert result.returncode == 0, result.stderr
        assert result.stdout.strip() == str(expected)


@pytest.mark.parametrize("flag", ["--node", "--project-root", "--idea-data-dir"])
def test_builder_rejects_machine_binding_flags(flag, tmp_path):
    result = subprocess.run([sys.executable, "-B", str(ROOT / "packages/skills-market/scripts/build_personal_plugin.py"),
                             "--source-root", str(ROOT), "--output", str(tmp_path / "nullius"), flag, str(tmp_path)],
                            text=True, capture_output=True, timeout=10)
    assert result.returncode == 2
    assert "unrecognized arguments" in result.stderr
    assert not (tmp_path / "nullius").exists()


@pytest.mark.parametrize("relative,payload,category", [
    ("scripts/.env", "DUMMY=redacted", "sensitive filename"),
    ("scripts/oauth_creds.json", '{}', "sensitive filename"),
    ("scripts/local.json", '"' + "/Users/" + "private-person/data" + '"', "concrete machine home path"),
    ("scripts/local.txt", "sk-" + "a" * 40, "high-confidence credential"),
])
def test_plugin_rejects_ignored_sensitive_selected_payload(packed, relative, payload, category):
    source, output, _ = packed
    target = source / "skills/research-team" / relative
    target.write_text(payload)
    (source / ".gitignore").write_text(str(target.relative_to(source)) + "\n")
    assert subprocess.run(["git", "-C", str(source), "check-ignore", "--quiet", str(target)], check=False).returncode == 0
    previous = (output / "SOURCE_MANIFEST.json").read_bytes()
    with pytest.raises(RuntimeError, match=category) as error:
        build(source_root=source, output=output, force=True)
    assert payload not in str(error.value)
    assert (output / "SOURCE_MANIFEST.json").read_bytes() == previous


def test_plugin_rejects_external_payload_symlink(packed, tmp_path):
    source, output, _ = packed
    outside = tmp_path / "private-outside"
    outside.write_text("must not be read")
    link = source / "skills/research-team/scripts/local-link"
    link.symlink_to(outside)
    with pytest.raises(RuntimeError, match="outside source root"):
        build(source_root=source, output=output, force=True)
