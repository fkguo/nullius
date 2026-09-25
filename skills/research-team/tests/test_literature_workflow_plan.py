from __future__ import annotations

import importlib.util
import json
import subprocess
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace

import pytest


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


class TestResearchTeamWorkflowPlan(unittest.TestCase):
    def test_workflow_plan_subcommand_uses_launcher_authority(self) -> None:
        repo_root = Path(__file__).resolve().parents[3]
        script = repo_root / "skills" / "research-team" / "scripts" / "bin" / "literature_fetch.py"
        completed = subprocess.run(
            [
                sys.executable,
                str(script),
                "workflow-plan",
                "--recipe",
                "literature_landscape",
                "--phase",
                "prework",
                "--query",
                "bootstrap amplitudes",
                "--topic",
                "bootstrap amplitudes",
                "--seed-recid",
                "1234",
                "--preferred-provider",
                "openalex",
            ],
            cwd=str(repo_root),
            capture_output=True,
            text=True,
            check=False,
        )
        self.assertEqual(completed.returncode, 0, msg=completed.stdout + completed.stderr)
        payload = json.loads(completed.stdout)
        self.assertEqual(payload.get("entry_tool"), "literature_workflows.resolve")
        steps = payload.get("resolved_steps") or []
        self.assertTrue(isinstance(steps, list) and steps)
        self.assertEqual((steps[0] or {}).get("tool"), "openalex_search")

# Workspace discovery is exercised without running provider/model processes.


@pytest.fixture
def workspace_helper(tmp_path, monkeypatch):
    source = Path(__file__).resolve().parents[1] / "scripts/lib/literature_workflow_plan.py"
    spec = importlib.util.spec_from_file_location("copied_workflow_plan_helper", source)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    monkeypatch.setattr(module, "__file__", str(tmp_path / "copied/skills/research-team/scripts/lib/literature_workflow_plan.py"))
    monkeypatch.delenv("NULLIUS_WORKSPACE_ROOT", raising=False)
    return module


def test_explicit_workspace_and_source_ancestor_precede_cli(workspace_helper, tmp_path, monkeypatch):
    def no_cli(*args, **kwargs):
        raise AssertionError("runtime lookup should not run")

    monkeypatch.setattr(workspace_helper.subprocess, "run", no_cli)
    root = tmp_path / "explicit-checkout"
    _write_nullius_workspace(root)
    monkeypatch.setenv("NULLIUS_WORKSPACE_ROOT", str(root))
    assert workspace_helper._workspace_root() == root
    monkeypatch.delenv("NULLIUS_WORKSPACE_ROOT")
    monkeypatch.setattr(workspace_helper, "__file__", str(root / "skills/research-team/scripts/lib/literature_workflow_plan.py"))
    assert workspace_helper._workspace_root() == root


def test_invalid_explicit_workspace_does_not_fall_back(workspace_helper, monkeypatch):
    monkeypatch.setenv("NULLIUS_WORKSPACE_ROOT", "relative-checkout")
    with pytest.raises(RuntimeError, match="NULLIUS_WORKSPACE_ROOT"):
        workspace_helper._workspace_root()


@pytest.mark.parametrize("output,code", [("relative-checkout\n", 0), ("/missing/workspace\n", 0), ("/one\n/two\n", 0), ("", 0)])
def test_invalid_runtime_path_is_rejected(workspace_helper, monkeypatch, output, code):
    monkeypatch.setattr(workspace_helper.subprocess, "run", lambda *a, **kw: SimpleNamespace(stdout=output, returncode=code))
    with pytest.raises(RuntimeError, match="one absolute Nullius source workspace"):
        workspace_helper._workspace_root()


def test_nonzero_runtime_path_is_rejected_even_for_existing_workspace(workspace_helper, tmp_path, monkeypatch):
    _write_nullius_workspace(tmp_path)
    monkeypatch.setattr(workspace_helper.subprocess, "run", lambda *a, **kw: SimpleNamespace(stdout=str(tmp_path), returncode=1))
    with pytest.raises(RuntimeError, match="one absolute Nullius source workspace"):
        workspace_helper._workspace_root_from_runtime()


@pytest.mark.parametrize("failure", [FileNotFoundError("nullius"), subprocess.TimeoutExpired(["nullius"], 10)])
def test_unavailable_runtime_is_explicit(workspace_helper, monkeypatch, failure):
    def unavailable(*args, **kwargs):
        raise failure

    monkeypatch.setattr(workspace_helper.subprocess, "run", unavailable)
    with pytest.raises(RuntimeError, match="Unable to locate Nullius runtime"):
        workspace_helper._workspace_root()


def test_unrelated_pnpm_ancestor_does_not_override_current_cli(workspace_helper, tmp_path, monkeypatch):
    unrelated = tmp_path / "copied"
    unrelated.mkdir()
    (unrelated / "pnpm-workspace.yaml").write_text("packages: []\n")
    (unrelated / "package.json").write_text('{"name":"another-application"}')
    runtime = tmp_path / "correct-runtime"
    _write_nullius_workspace(runtime)
    calls = []

    def runtime_path(command, **kwargs):
        calls.append(command)
        return SimpleNamespace(stdout=str(runtime) + "\n", returncode=0)

    monkeypatch.setattr(workspace_helper.subprocess, "run", runtime_path)
    assert workspace_helper._workspace_root() == runtime
    assert calls == [["nullius", "runtime", "path"]]
