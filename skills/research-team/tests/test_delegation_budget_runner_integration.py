#!/usr/bin/env python3
"""Runner-level integration tests for the delegation budget preflight brake.

The anti-drift lock pins what the run_team_cycle.sh wiring *looks like*; these
tests prove the runner actually *calls* the gate and fail-fast propagates its
verdict — including in the exploration stage (no downgrade) and under
--preflight-only. They mirror the deterministic scaffold + stub-runner recipe
of scripts/validation/run_full_contract_validation.sh, scoped to one profile.
"""

from __future__ import annotations

import json
import subprocess
import sys
from datetime import date
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
BIN = ROOT / "scripts" / "bin"
SCAFFOLD = BIN / "scaffold_research_workflow.sh"
DEMO = BIN / "generate_demo_milestone.sh"
RUN_TEAM = BIN / "run_team_cycle.sh"

DEMO_TAG = "20260719T000000Z-m0-it-full-r1"


def _write(path: Path, content: str) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")
    return path


def _complete_contract() -> dict:
    return {
        "contract_version": 1,
        "delegation_id": "it-lane-01",
        "workstream": "integration probe: validate the preflight delegation brake",
        "tolerance_ceiling": {
            "value": 1e-6,
            "anchor_note": "probe threshold: downstream check only resolves 1e-5",
        },
        "time_box": {"seconds": 600},
        "max_attempts": 1,
        "scope_negative_list": ["no scope expansion of any kind in this probe"],
        "peak_memory_estimate": {"dry_run_peak_rss_mb": 100, "heap_limit_mb": 200},
    }


@pytest.fixture()
def project(tmp_path: Path) -> Path:
    """Scaffold a deterministic exploration-stage project ready for a
    stub-runner preflight (mirrors run_full_contract_validation.sh)."""
    root = tmp_path / "proj"
    subprocess.run(
        [
            "bash",
            str(SCAFFOLD),
            "--root",
            str(root),
            "--project",
            "DelegationBudgetIT",
            "--profile",
            "exploratory",
            "--full",
        ],
        check=True,
        capture_output=True,
        text=True,
    )
    _write(
        root / "project_brief.md",
        "# Deterministic validation brief\n\nGoal:\n"
        "- Validate the delegation budget preflight brake with stub runners only.\n",
    )
    subprocess.run(
        ["bash", str(DEMO), "--root", str(root), "--tag", DEMO_TAG],
        check=True,
        capture_output=True,
        text=True,
    )
    today = date.today().isoformat()
    _write(
        root / "project_charter.md",
        f"""# project_charter.md

Status: APPROVED
Project: DelegationBudgetIT
Root: {root}
Created: {today}
Last updated: {today}

## 0. Purpose

One-sentence project purpose: deterministic validation of the delegation budget preflight brake.

## 1. Goals

Primary goal: deterministic validation of the delegation budget gate
Validation goal(s): prove a bad or missing delegation contract fails preflight

Anti-goals / non-goals:
- Do not validate a domain-specific scientific claim.
- Do not call external LLMs or network services.
""",
    )
    cfg_path = root / "research_team_config.json"
    cfg = json.loads(cfg_path.read_text(encoding="utf-8"))
    cfg.setdefault("features", {})["independent_reproduction_gate"] = False
    # Exploration on purpose: the delegation gate must fail fast even in the
    # most permissive stage.
    cfg["project_stage"] = "exploration"
    cfg_path.write_text(json.dumps(cfg, indent=2, sort_keys=True) + "\n", encoding="utf-8")

    # The stub records every invocation in a marker file, so tests can assert
    # the preflight brake fired BEFORE any member runner was dispatched.
    stub = tmp_path / "stub_runner.sh"
    _write(
        stub,
        '#!/usr/bin/env bash\necho invoked >> "$(dirname "$0")/runner_invocations.marker"\nexit 0\n',
    )
    stub.chmod(0o755)
    return root


def _runner_marker(root: Path) -> Path:
    return root.parent / "runner_invocations.marker"


def _run_cycle(root: Path, tag: str, *, preflight_only: bool = True) -> subprocess.CompletedProcess:
    stub = root.parent / "stub_runner.sh"
    argv = [
        "bash",
        str(RUN_TEAM),
        "--tag",
        tag,
        "--notes",
        "research_contract.md",
        "--out-dir",
        "team",
        "--member-a-system",
        "prompts/_system_member_a.txt",
        "--member-b-system",
        "prompts/_system_member_b.txt",
        "--member-a-runner-kind",
        "codex",
        "--member-b-runner-kind",
        "codex",
        "--member-a-runner",
        str(stub),
        "--member-b-runner",
        str(stub),
        "--no-sidecar",
    ]
    if preflight_only:
        argv.append("--preflight-only")
    return subprocess.run(argv, cwd=root, capture_output=True, text=True)


def _run_preflight(root: Path, tag: str) -> subprocess.CompletedProcess:
    return _run_cycle(root, tag, preflight_only=True)


def _persisted_verdict(root: Path, tag: str) -> dict:
    # Assumes safe_tag == tag: every tag used in this module is chosen from
    # the runner's already-sanitized alphabet, so the run dir is named by the
    # tag verbatim.
    verdict_path = root / "team" / "runs" / tag / f"{tag}_delegation_budget_gate.json"
    assert verdict_path.is_file(), f"machine verdict not persisted at {verdict_path}"
    return json.loads(verdict_path.read_text(encoding="utf-8"))


def test_bad_contract_fails_preflight_even_in_exploration(project: Path) -> None:
    _write(
        project / "team" / "delegations" / "bad.json",
        json.dumps({"contract_version": 1, "delegation_id": "x"}),
    )
    tag = "20260719T000000Z-m0-it-bad-r1"
    proc = _run_preflight(project, tag)
    assert proc.returncode == 1, f"preflight should brake on bad contract; log:\n{proc.stderr[-2000:]}"
    verdict = _persisted_verdict(project, tag)
    assert verdict["status"] == "not_converged"
    assert any("MISSING_TIME_BOX" in r for r in verdict["reasons"])


def test_bad_contract_brakes_full_cycle_before_any_runner(project: Path) -> None:
    """A normal (non --preflight-only) cycle must brake on a bad contract at
    preflight, before dispatching any member runner — a future PREFLIGHT_ONLY
    guard around the gate would flip this test red."""
    _write(
        project / "team" / "delegations" / "bad.json",
        json.dumps({"contract_version": 1, "delegation_id": "x"}),
    )
    tag = "20260719T000000Z-m0-it-fullcycle-r1"
    proc = _run_cycle(project, tag, preflight_only=False)
    assert proc.returncode == 1, f"full cycle should brake on bad contract; log:\n{proc.stderr[-2000:]}"
    verdict = _persisted_verdict(project, tag)
    assert verdict["status"] == "not_converged"
    assert not _runner_marker(project).exists(), (
        "member runners were dispatched despite a failing delegation budget contract"
    )


def test_required_with_no_contract_fails_preflight(project: Path) -> None:
    cfg_path = project / "research_team_config.json"
    cfg = json.loads(cfg_path.read_text(encoding="utf-8"))
    cfg["delegation_budget"] = {"required": True}
    cfg_path.write_text(json.dumps(cfg, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    tag = "20260719T000000Z-m0-it-req-r1"
    proc = _run_preflight(project, tag)
    assert proc.returncode == 1, f"preflight should brake on missing required contract; log:\n{proc.stderr[-2000:]}"
    verdict = _persisted_verdict(project, tag)
    assert any("NO_CONTRACTS_FOUND" in r for r in verdict["reasons"])


def test_complete_contract_passes_preflight(project: Path) -> None:
    _write(
        project / "team" / "delegations" / "good.json",
        json.dumps(_complete_contract()),
    )
    cfg_path = project / "research_team_config.json"
    cfg = json.loads(cfg_path.read_text(encoding="utf-8"))
    cfg["delegation_budget"] = {"required": True}
    cfg_path.write_text(json.dumps(cfg, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    tag = "20260719T000000Z-m0-it-good-r1"
    proc = _run_preflight(project, tag)
    assert proc.returncode == 0, f"preflight should pass with a complete contract; log:\n{proc.stderr[-2000:]}\n{proc.stdout[-2000:]}"
    verdict = _persisted_verdict(project, tag)
    assert verdict["status"] == "converged"


if __name__ == "__main__":
    sys.exit(pytest.main([__file__, "-q"]))
