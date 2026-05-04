#!/usr/bin/env python3
from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path


TESTS_DIR = Path(__file__).resolve().parent
SKILL_ROOT = TESTS_DIR.parent
CONFIG_TEMPLATE = SKILL_ROOT / "assets" / "research_team_config_template.json"

sys.path.insert(0, str(SKILL_ROOT / "scripts" / "lib"))

from team_config import DEFAULT_CONFIG


def test_template_and_library_defaults_keep_sidecar_opt_in() -> None:
    cfg = json.loads(CONFIG_TEMPLATE.read_text(encoding="utf-8"))

    assert cfg["sidecar_review"]["enabled"] is False
    assert DEFAULT_CONFIG["sidecar_review"]["enabled"] is False
    assert cfg["sidecar_reviews"] == []
    assert cfg["sidecar_review"]["system_prompt"] == "prompts/_system_member_c_numerics.txt"


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
    assert (root / "prompts" / "_system_member_c_numerics.txt").is_file()
