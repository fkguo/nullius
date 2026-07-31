#!/usr/bin/env python3
"""Runner-level tests for the bounded-rounds cap.

The verification-granularity contract caps reviewed rounds per tag family
(default 5) and makes "another round" a forbidden response at the cap —
the sanctioned responses are narrowing, claim reduction, or owner
escalation. These tests prove the runner brakes a tag whose -rN suffix
exceeds the cap, honors a deliberate config raise, and leaves in-cap tags
untouched. The fixture mirrors the deterministic scaffold recipe of the
delegation-budget integration tests so preflight reaches the brake.
"""

from __future__ import annotations

import json
import subprocess
from datetime import date
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
BIN = ROOT / "scripts" / "bin"
SCAFFOLD = BIN / "scaffold_research_workflow.sh"
DEMO = BIN / "generate_demo_milestone.sh"
RUN_TEAM = BIN / "run_team_cycle.sh"

DEMO_TAG = "20260731T000000Z-m0-rc-demo-r1"


def _write(path: Path, content: str) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")
    return path


@pytest.fixture()
def project(tmp_path: Path) -> Path:
    root = tmp_path / "proj"
    subprocess.run(
        ["bash", str(SCAFFOLD), "--root", str(root), "--project", "RoundCapIT",
         "--profile", "exploratory", "--full"],
        check=True, capture_output=True, text=True,
    )
    _write(
        root / "project_brief.md",
        "# Deterministic round-cap brief\n\nGoal:\n- Validate the bounded-rounds brake.\n",
    )
    subprocess.run(
        ["bash", str(DEMO), "--root", str(root), "--tag", DEMO_TAG],
        check=True, capture_output=True, text=True,
    )
    today = date.today().isoformat()
    _write(
        root / "project_charter.md",
        f"""# project_charter.md

Status: APPROVED
Project: RoundCapIT
Root: {root}
Created: {today}
Last updated: {today}

## 0. Purpose

One-sentence project purpose: deterministic validation of the bounded-rounds brake.

## 1. Goals

Primary goal: deterministic round-cap validation
Validation goal(s): a tag beyond the cap is refused with the narrowing rule

Anti-goals / non-goals:
- Do not validate a domain-specific scientific claim.
- Do not call external LLMs or network services.
""",
    )
    cfg_path = root / "research_team_config.json"
    cfg = json.loads(cfg_path.read_text(encoding="utf-8"))
    cfg.setdefault("features", {})["independent_reproduction_gate"] = False
    cfg["project_stage"] = "exploration"
    cfg_path.write_text(json.dumps(cfg, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    return root


def _set_cap(root: Path, cap: int) -> None:
    cfg_path = root / "research_team_config.json"
    cfg = json.loads(cfg_path.read_text(encoding="utf-8"))
    cfg["bounded_rounds"] = {"max_per_tag_family": cap}
    cfg_path.write_text(json.dumps(cfg, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def _run(root: Path, tag: str) -> subprocess.CompletedProcess:
    return subprocess.run(
        [
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
            "--preflight-only",
        ],
        cwd=root,
        capture_output=True,
        text=True,
        timeout=300,
    )


def test_round_beyond_cap_brakes_with_narrowing_message(project: Path) -> None:
    tag = "20260731T000000Z-m0-rc-topic-r6"
    proc = _run(project, tag)
    assert proc.returncode == 2, proc.stderr[-1500:]
    assert "bounded-rounds cap" in proc.stderr
    assert "narrow the candidate's scope" in proc.stderr
    assert "bounded_rounds.max_per_tag_family" in proc.stderr
    # The brake fires before any run directory is created for the tag.
    assert not (project / "team" / "runs" / tag).exists()


def test_config_raise_allows_more_rounds(project: Path) -> None:
    _set_cap(project, 8)
    proc = _run(project, "20260731T000000Z-m0-rc-topic-r6")
    # Round 6 is within the raised cap: the brake must not fire (preflight may
    # still stop later at other gates — only the brake message is asserted
    # absent).
    assert "bounded-rounds cap" not in proc.stderr


def test_in_cap_tag_passes_the_brake_and_preflight(project: Path) -> None:
    proc = _run(project, "20260731T000000Z-m0-rc-topic-r5")
    assert "bounded-rounds cap" not in proc.stderr
    assert proc.returncode == 0, proc.stderr[-1500:]
