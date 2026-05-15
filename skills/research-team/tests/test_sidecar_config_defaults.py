#!/usr/bin/env python3
from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path


TESTS_DIR = Path(__file__).resolve().parent
SKILL_ROOT = TESTS_DIR.parent
CONFIG_TEMPLATE = SKILL_ROOT / "assets" / "research_team_config_template.json"
RUN_TEAM_CYCLE = SKILL_ROOT / "scripts" / "bin" / "run_team_cycle.sh"

sys.path.insert(0, str(SKILL_ROOT / "scripts" / "lib"))

from team_config import DEFAULT_CONFIG


def test_template_and_library_defaults_keep_sidecar_opt_in() -> None:
    cfg = json.loads(CONFIG_TEMPLATE.read_text(encoding="utf-8"))

    assert cfg["sidecar_review"]["enabled"] is False
    assert DEFAULT_CONFIG["sidecar_review"]["enabled"] is False
    assert cfg["sidecar_reviews"] == []
    assert cfg["sidecar_review"]["system_prompt"] == "prompts/_system_member_c_numerics.txt"
    assert DEFAULT_CONFIG["sidecar_review"]["model"] == ""


def test_template_and_library_defaults_use_host_native_subagent_members() -> None:
    cfg = json.loads(CONFIG_TEMPLATE.read_text(encoding="utf-8"))

    assert cfg["member_a"]["runner_kind"] == "host_native"
    assert cfg["member_b"]["runner_kind"] == "host_native"
    assert cfg["member_a"]["reasoning_effort"] == "auto"
    assert cfg["member_b"]["reasoning_effort"] == "auto"
    assert DEFAULT_CONFIG["member_a"]["runner_kind"] == "host_native"
    assert DEFAULT_CONFIG["member_b"]["runner_kind"] == "host_native"


def test_full_scaffold_config_keeps_sidecar_disabled_by_default(tmp_path: Path) -> None:
    root = tmp_path / "proj"
    result = subprocess.run(
        [
            "bash",
            str(SKILL_ROOT / "scripts/bin/scaffold_research_workflow.sh"),
            "--root",
            str(root),
            "--project",
            "Sidecar Opt-in Demo",
            "--full",
        ],
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        check=False,
    )

    assert result.returncode == 0, result.stdout

    cfg = json.loads((root / "research_team_config.json").read_text(encoding="utf-8"))

    assert cfg["sidecar_review"]["enabled"] is False
    assert cfg["sidecar_reviews"] == []
    assert cfg["member_a"]["runner_kind"] == "host_native"
    assert cfg["member_b"]["runner_kind"] == "host_native"
    assert (root / "scripts" / "run_codex.sh").is_file()
    assert (root / "prompts" / "_system_member_c_numerics.txt").is_file()


def test_team_cycle_does_not_switch_member_providers_automatically() -> None:
    script = RUN_TEAM_CYCLE.read_text(encoding="utf-8")

    assert "member-b-fallback" not in script
    assert "choose_member_b_fallback" not in script
    assert "auto-falling back" not in script
    assert "falling back to" not in script
    assert "runner-kind=host_native requires" in script
