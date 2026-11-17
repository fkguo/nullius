"""Distribution and execution boundaries for manuscript review.

The local reviewer below is a transport spy, not a scientific evaluator. These
tests show that the installed route reads original files and uses an actually
invoked reviewer's output, while the retired packet-to-verdict path is absent.
"""

from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import shlex
import subprocess
import sys

import pytest


ROOT = Path(__file__).resolve().parents[3]
INSTALLER = ROOT / "packages/skills-market/scripts/install_skill.py"
TRANSPORT_REPORT = (
    "VERDICT: NOT_READY\n\n## Blockers\n- Transport fixture rejection.\n\n"
    "## High-severity\n- none\n\n## Non-blocking\n- none\n\n"
    "## Real-research fit\n- fixture only\n\n## Robustness & safety\n- fixture only\n\n"
    "## Specific patch suggestions\n- fixture only\n"
)


@pytest.fixture
def installed(tmp_path):
    target = tmp_path / "installed-skills"
    previous = target / "referee-review/scripts/run_referee_review.py"
    previous.parent.mkdir(parents=True)
    previous.write_text("print('VERDICT: READY')\n", encoding="utf-8")
    schema = target / "referee-review/schemas/review.schema.json"
    schema.parent.mkdir()
    schema.write_text('{"title":"RefereeReview"}\n', encoding="utf-8")
    proc = subprocess.run(
        [sys.executable, str(INSTALLER), "--platform", "codex",
         "--market-root", str(ROOT / "packages/skills-market"),
         "--source-root", str(ROOT), "--target-root", str(target),
         "--package", "referee-review", "--force"],
        capture_output=True, text=True, timeout=30,
    )
    assert proc.returncode == 0, proc.stdout + proc.stderr
    return target


def test_copy_refresh_removes_packet_verdict_entry_and_resolves_review_route(installed, tmp_path):
    retired = installed / "referee-review/scripts/run_referee_review.py"
    assert not retired.exists()
    assert not (installed / "referee-review/schemas/review.schema.json").exists()
    workflow = installed / "referee-review/SKILL.md"
    # Selecting only this task must install its existing review runtime through
    # the catalog dependency closure, without a second explicit package choice.
    review_skill = workflow.parent / "../review-swarm/SKILL.md"
    assert "[review-swarm](../review-swarm/SKILL.md)" in workflow.read_text(encoding="utf-8")
    assert review_skill.is_file()
    assert (review_skill.parent / "scripts/bin/review_one.py").is_file()
    packet = tmp_path / "packet.md"
    packet.write_text(
        "## Paper diff\n+ We prove 1 + 1 = 3.\n\n"
        "## Artifact pointers\n- /does/not/exist/paper.tex\n", encoding="utf-8",
    )
    output = tmp_path / "old-command-output"
    proc = subprocess.run(
        [sys.executable, str(retired), "--profile", "generic", "--packet", str(packet),
         "--out-dir", str(output)], capture_output=True, text=True, timeout=10,
    )
    assert proc.returncode != 0
    assert not output.exists()


def _reviewer_spy(tmp_path):
    marker = tmp_path / "reviewer-invoked"
    runner = tmp_path / "run_codex.sh"
    report = TRANSPORT_REPORT
    runner.write_text(
        "#!/usr/bin/env bash\nset -euo pipefail\n"
        f"printf '%s' invoked > {shlex.quote(str(marker))}\n"
        "output=''\nwhile [[ $# -gt 0 ]]; do\n"
        "  case \"$1\" in\n    --out) output=\"$2\"; shift 2 ;;\n"
        "    *) shift ;;\n  esac\ndone\n"
        f"cat > \"${{output}}\" <<'REVIEW_FIXTURE'\n{report}REVIEW_FIXTURE\n", encoding="utf-8",
    )
    runner.chmod(0o755)
    return runner, marker, report


def _isolated_host_env(tmp_path):
    # These empty advertised homes deliberately differ from the copy target.
    # Discovery must use its shipped sibling, never a runner from the real host.
    home = tmp_path / "empty-host"
    home.mkdir(exist_ok=True)
    return {
        **os.environ,
        "HOME": str(home),
        "CODEX_HOME": str(home / "codex"),
        "CLAUDE_CONFIG_DIR": str(home / "claude"),
        "XDG_CONFIG_HOME": str(home / "config"),
        "REVIEW_SWARM_NO_AUTO_CONFIG": "1",
    }


def test_minimal_copy_install_executes_default_codex_discovery(installed, tmp_path):
    assert {p.name for p in installed.iterdir() if p.is_dir()} == {
        "referee-review", "review-swarm", "codex-cli-runner",
    }
    runner = installed / "codex-cli-runner/scripts/run_codex.sh"
    assert not runner.is_symlink()
    assert runner.read_bytes() == (ROOT / "skills/codex-cli-runner/scripts/run_codex.sh").read_bytes()
    manuscript = tmp_path / "paper.tex"
    manuscript.write_text("We prove 1 + 1 = 3.\n", encoding="utf-8")
    marker = tmp_path / "codex-client-invoked.json"
    # Exercise the actual installed shell runner, replacing only its external
    # client executable. This fixture cannot make a scientific assessment.
    executable = tmp_path / "bin/codex"
    executable.parent.mkdir()
    executable.write_text(
        f"#!{sys.executable}\n"
        "import json, sys\nfrom pathlib import Path\n"
        "assert sys.argv[1] == 'exec', sys.argv\n"
        "prompt = sys.stdin.read()\n"
        f"Path({str(marker)!r}).write_text(json.dumps({{'args': sys.argv[1:], 'prompt': prompt}}))\n"
        "output = Path(sys.argv[sys.argv.index('-o') + 1])\n"
        f"output.write_text({TRANSPORT_REPORT!r})\n", encoding="utf-8",
    )
    executable.chmod(0o755)
    environment = _isolated_host_env(tmp_path)
    environment["PATH"] = str(executable.parent) + os.pathsep + os.environ["PATH"]
    output = tmp_path / "default-discovery-review"
    proc = subprocess.run(
        [sys.executable, str(installed / "review-swarm/scripts/bin/review_one.py"),
         "--model", "codex/default", "--artifact", str(manuscript),
         "--role", "correctness", "--max-attempts", "1", "--timeout-secs", "20",
         "--out-dir", str(output)],
        env=environment, capture_output=True, text=True, timeout=30, cwd=tmp_path,
    )
    assert proc.returncode == 0, proc.stdout + proc.stderr
    observed = json.loads(marker.read_text(encoding="utf-8"))
    assert manuscript.read_text(encoding="utf-8") in observed["prompt"]
    assert observed["args"][observed["args"].index("--sandbox") + 1] == "read-only"
    trace = [json.loads(line) for line in (output / "trace.jsonl").read_text(encoding="utf-8").splitlines()]
    assert any(event.get("cmd", [])[:2] == ["bash", str(runner)] for event in trace)
    meta = json.loads((output / "meta.json").read_text(encoding="utf-8"))
    agent = meta["agents"][0]
    assert agent["verdict"] == "VERDICT: NOT_READY"
    assert Path(agent["out"]).read_text(encoding="utf-8") == TRANSPORT_REPORT


@pytest.mark.parametrize("backend", ["claude", "codex", "gemini", "kimi", "opencode"])
def test_copied_launcher_discovers_the_matching_sibling_backend(installed, tmp_path, backend):
    if backend != "codex":
        proc = subprocess.run(
            [sys.executable, str(INSTALLER), "--platform", "codex",
             "--market-root", str(ROOT / "packages/skills-market"),
             "--source-root", str(ROOT), "--target-root", str(installed),
             "--package", f"{backend}-cli-runner"],
            capture_output=True, text=True, timeout=30,
        )
        assert proc.returncode == 0, proc.stdout + proc.stderr
    launcher = installed / "review-swarm/scripts/bin/run_multi_task.py"
    code = (
        "import pathlib,runpy,sys; "
        "sys.path.insert(0,str(pathlib.Path(sys.argv[1]).parent)); "
        "ns=runpy.run_path(sys.argv[1]); print(ns['_' + sys.argv[2] + '_runner']())"
    )
    proc = subprocess.run(
        [sys.executable, "-B", "-c", code, str(launcher), backend],
        env=_isolated_host_env(tmp_path), capture_output=True, text=True, timeout=10,
    )
    assert proc.returncode == 0, proc.stdout + proc.stderr
    assert proc.stdout.strip() == str(installed / f"{backend}-cli-runner/scripts/run_{backend}.sh")


def _review_command(installed, target, runner, output):
    return [
        sys.executable, str(installed / "review-swarm/scripts/bin/review_one.py"),
        "--model", "codex/default", "--artifact", str(target),
        "--role", "source-fidelity", "--source-text-origin", "direct-original-text",
        "--correction-status", "not-applicable", "--codex-runner", str(runner),
        "--out-dir", str(output),
    ]


def test_installed_source_review_refuses_missing_original_before_execution(installed, tmp_path):
    manuscript = tmp_path / "paper.tex"
    manuscript.write_text("We prove 1 + 1 = 3.\n", encoding="utf-8")
    runner, marker, _ = _reviewer_spy(tmp_path)
    output = tmp_path / "missing-source-review"
    proc = subprocess.run(
        _review_command(installed, manuscript, runner, output),
        capture_output=True, text=True, timeout=30,
        env={**os.environ, "REVIEW_SWARM_NO_AUTO_CONFIG": "1"},
    )
    assert proc.returncode == 2
    assert "requires at least one --source" in proc.stderr
    assert not marker.exists()
    assert not (output / "meta.json").exists()


def test_installed_review_reads_original_and_preserves_executed_rejection(installed, tmp_path):
    manuscript = tmp_path / "paper.tex"
    manuscript.write_text("We prove 1 + 1 = 3.\n", encoding="utf-8")
    original = tmp_path / "original.tex"
    original.write_text("Original relation: 1 + 1 = 2.\n", encoding="utf-8")
    runner, marker, report = _reviewer_spy(tmp_path)
    output = tmp_path / "executed-review"
    proc = subprocess.run(
        [*_review_command(installed, manuscript, runner, output), "--source", str(original)],
        capture_output=True, text=True, timeout=30,
        env={**os.environ, "REVIEW_SWARM_NO_AUTO_CONFIG": "1"},
    )
    assert proc.returncode == 0, proc.stdout + proc.stderr
    assert marker.read_text() == "invoked"
    meta = json.loads((output / "meta.json").read_text(encoding="utf-8"))
    assert meta["agents"][0]["verdict"] == "VERDICT: NOT_READY"
    assert Path(meta["agents"][0]["out"]).read_text(encoding="utf-8") == report
    packet = (output / "inputs/packet.md").read_text(encoding="utf-8")
    assert manuscript.read_text(encoding="utf-8") in packet
    assert original.read_text(encoding="utf-8") in packet
    scope = json.loads((output / "inputs/source_fidelity_manifest.json").read_text(encoding="utf-8"))
    assert scope["primary_sources"][0]["sha256"] == hashlib.sha256(original.read_bytes()).hexdigest()


def test_historical_review_files_remain_readable_and_exportable_without_generator(tmp_path):
    project = tmp_path / "research-project"
    history = project / "artifacts/runs/past"
    history.mkdir(parents=True)
    (project / "project_charter.md").write_text("# Fixture project\n", encoding="utf-8")
    (project / "research_contract.md").write_text("# Fixture contract\n", encoding="utf-8")
    originals = {
        "review.md": b"VERDICT: READY\r\nHistorical unverified packet report.\r\n",
        "review.json": b'{"schema_version":1,"profile":"generic","verdict":"READY"}\n',
    }
    for name, data in originals.items():
        (history / name).write_bytes(data)
    proc = subprocess.run(
        [sys.executable, str(ROOT / "skills/research-team/scripts/bin/export_paper_bundle.py"),
         "--tag", "historical-review", "--without-project-docs",
         "--include", "artifacts/runs/past/review.md",
         "--include", "artifacts/runs/past/review.json"],
        cwd=project, capture_output=True, text=True, timeout=30,
    )
    assert proc.returncode == 0, proc.stdout + proc.stderr
    copied = project / "export/paper_bundle_historical-review/artifacts/runs/past"
    for name, data in originals.items():
        assert (history / name).read_bytes() == data
        assert (copied / name).read_bytes() == data
