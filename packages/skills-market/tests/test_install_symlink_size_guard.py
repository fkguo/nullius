#!/usr/bin/env python3
"""
Regression lock for the install_symlink_skills.sh size guard (OpenCode install-crash remediation).

A whole-dir symlink exposes the source tree UNFILTERED; a skill dir bloated with local run artifacts
(e.g. hep-calc/process ~130MB) could hang/OOM an eager skill loader. The installer refuses to link a
source dir over a size threshold unless --allow-large-artifacts is passed. These tests pin that
behaviour so a future refactor can't silently drop the guard.
"""
import json
import os
import shutil
import subprocess
from pathlib import Path

import pytest

_MARKET_ROOT = Path(__file__).resolve().parents[1]
_INSTALLER = _MARKET_ROOT / "scripts" / "install_symlink_skills.sh"

pytestmark = pytest.mark.skipif(shutil.which("bash") is None, reason="bash required")


def _fixture(tmp_path):
    """A skills-root with a tiny skill + an oversized skill, and a matching market-root."""
    skills_root = tmp_path / "skills_src"
    market_root = tmp_path / "market"
    (market_root / "packages").mkdir(parents=True)
    for sid in ("small-skill", "big-skill"):
        d = skills_root / "skills" / sid
        d.mkdir(parents=True)
        (d / "SKILL.md").write_text(f"---\nname: {sid}\ndescription: x\n---\n# {sid}\n")
        (market_root / "packages" / f"{sid}.json").write_text(json.dumps({"package_type": "skill-pack"}))
    # bloat big-skill to ~5MB so it trips a 2MB threshold; small-skill stays tiny
    (skills_root / "skills" / "big-skill" / "artifact.bin").write_bytes(b"\0" * (5 * 1024 * 1024))
    return skills_root, market_root


def _run(skills_root, market_root, target, *extra, env_mb="2"):
    return subprocess.run(
        ["bash", str(_INSTALLER), "--platform", "codex",
         "--skills-root", str(skills_root), "--market-root", str(market_root),
         "--target-root", str(target), "--dry-run", *extra],
        capture_output=True, text=True,
        env={**os.environ, "HOME": str(target.parent), "SKILL_SYMLINK_MAX_MB": env_mb},
    )


def test_oversized_skill_is_refused_small_one_links(tmp_path):
    skills_root, market_root = _fixture(tmp_path)
    target = tmp_path / "dest"
    target.mkdir()
    r = _run(skills_root, market_root, target)
    assert r.returncode == 1, r.stderr
    assert "big-skill source is" in r.stderr and "> 2MB" in r.stderr   # refused with actionable message
    assert "small-skill" in r.stdout                                    # the safe one still links


def test_allow_large_artifacts_overrides(tmp_path):
    skills_root, market_root = _fixture(tmp_path)
    target = tmp_path / "dest"
    target.mkdir()
    r = _run(skills_root, market_root, target, "--allow-large-artifacts")
    assert r.returncode == 0, r.stderr
    assert "big-skill" in r.stdout                                      # now links despite size


def test_non_numeric_threshold_rejected(tmp_path):
    skills_root, market_root = _fixture(tmp_path)
    target = tmp_path / "dest"
    target.mkdir()
    r = _run(skills_root, market_root, target, env_mb="not-a-number")
    assert r.returncode == 2 and "must be a non-negative integer" in r.stderr


def test_market_root_has_valid_catalog_skill_md():
    # The market root is symlinked as a skill dir by install_{codex,opencode,claude_code}.sh, so it MUST
    # carry a SKILL.md or a strict loader (OpenCode) can crash. Lock its presence + minimal frontmatter.
    skill_md = _MARKET_ROOT / "SKILL.md"
    assert skill_md.is_file()
    text = skill_md.read_text(encoding="utf-8")
    assert text.startswith("---\n") and "name: autoresearch-market" in text.split("---", 2)[1]
