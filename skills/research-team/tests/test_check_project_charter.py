"""The team entry gate accepts the canonical project and rejects unscoped goals."""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import pytest


REPO_ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(REPO_ROOT / "packages/project-contracts/src"))

from project_contracts.project_scaffold import ensure_project_scaffold


GATE = REPO_ROOT / "skills/research-team/scripts/gates/check_project_charter.py"
PRIMARY = "Compare the two measured observables with their stated uncertainties."
VALIDATION = "Recompute the comparison from the published inputs and conventions."
ANTI = "Do not infer a combined measurement from incompatible definitions."


@pytest.fixture
def project(tmp_path: Path) -> Path:
    root = tmp_path / "project"
    ensure_project_scaffold(repo_root=root, project_name="Charter gate fixture", profile="mixed")
    return root


def _fill_charter(root: Path) -> str:
    path = root / "project_charter.md"
    text = path.read_text(encoding="utf-8")
    replacements = {
        "Status: DRAFT": "Status: ACTIVE",
        "Primary goal:\n": f"Primary goal: {PRIMARY}\n",
        "- (fill; checks, reproductions, audits, or benchmark comparisons that validate the main work)": f"- {VALIDATION}",
        "- (fill; work that would look productive but should not steer the project)": f"- {ANTI}",
    }
    for old, new in replacements.items():
        assert old in text
        text = text.replace(old, new)
    path.write_text(text, encoding="utf-8")
    return text


def _run_gate(root: Path) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, str(GATE), "--notes", str(root / "research_contract.md")],
        capture_output=True, text=True, check=False,
    )


def test_filled_canonical_project_passes_without_optional_support(project: Path) -> None:
    text = _fill_charter(project)
    assert "Project-specific commitments:" not in text
    assert not (project / "knowledge_base").exists()
    assert not (project / "research_team_config.json").exists()
    result = _run_gate(project)
    assert result.returncode == 0, result.stdout + result.stderr


def test_untouched_canonical_template_is_not_an_approved_goal(project: Path) -> None:
    result = _run_gate(project)
    assert result.returncode == 1
    for error in ("Status must", "Primary goal", "Validation goals", "Anti-goals/non-goals"):
        assert error in result.stdout


@pytest.mark.parametrize(
    ("content", "error"),
    [(PRIMARY, "Primary goal"), (f"- {VALIDATION}\n", "Validation goals"), (f"- {ANTI}\n", "Anti-goals/non-goals")],
)
def test_empty_required_goal_cannot_borrow_a_neighboring_field(
    project: Path, content: str, error: str,
) -> None:
    text = _fill_charter(project).replace(content, "")
    (project / "project_charter.md").write_text(text, encoding="utf-8")
    result = _run_gate(project)
    assert result.returncode == 1, result.stdout
    assert error in result.stdout


@pytest.mark.parametrize(
    ("content", "placeholder", "error"),
    [
        (PRIMARY, "TBD: choose the scientific question", "Primary goal"),
        (PRIMARY, "<PRIMARY_GOAL>", "Primary goal"),
        (VALIDATION, "TODO: select a verification method", "Validation goals"),
        (ANTI, "(fill; avoid unproductive directions)", "Anti-goals/non-goals"),
    ],
)
def test_unresolved_goals_do_not_pass(project: Path, content: str, placeholder: str, error: str) -> None:
    text = _fill_charter(project).replace(content, placeholder)
    (project / "project_charter.md").write_text(text, encoding="utf-8")
    result = _run_gate(project)
    assert result.returncode == 1, result.stdout
    assert error in result.stdout


@pytest.mark.parametrize(
    ("content", "replacement"),
    [
        (PRIMARY, "Measure how placeholder values affect the published estimator bias."),
        (VALIDATION, "Check that no TODO item remains in the exported comparison."),
        (ANTI, "Do not substitute placeholder values for missing observations."),
    ],
)
def test_goal_prose_can_discuss_placeholders_without_being_unfilled(
    project: Path, content: str, replacement: str,
) -> None:
    text = _fill_charter(project).replace(content, replacement)
    (project / "project_charter.md").write_text(text, encoding="utf-8")
    result = _run_gate(project)
    assert result.returncode == 0, result.stdout + result.stderr


@pytest.mark.parametrize("neighbor", ["**Other outputs:**", "其他输出："])
def test_empty_validation_cannot_borrow_a_differently_formatted_field(
    project: Path, neighbor: str,
) -> None:
    text = _fill_charter(project).replace(f"- {VALIDATION}", f"{neighbor}\n- Prepare a presentation.")
    (project / "project_charter.md").write_text(text, encoding="utf-8")
    result = _run_gate(project)
    assert result.returncode == 1, result.stdout
    assert "Validation goals" in result.stdout


def test_hidden_validation_cannot_fill_visible_empty_field(project: Path) -> None:
    text = _fill_charter(project).replace(f"- {VALIDATION}", f"<!-- - {VALIDATION} -->")
    (project / "project_charter.md").write_text(text, encoding="utf-8")
    result = _run_gate(project)
    assert result.returncode == 1
    assert "Validation goals" in result.stdout


@pytest.mark.parametrize("status", ["DRAFT", "PENDING"])
def test_filled_goals_do_not_replace_reviewed_status(project: Path, status: str) -> None:
    text = _fill_charter(project).replace("Status: ACTIVE", f"Status: {status}")
    (project / "project_charter.md").write_text(text, encoding="utf-8")
    result = _run_gate(project)
    assert result.returncode == 1
    assert "Status must" in result.stdout


def test_declared_profile_must_still_match_effective_configuration(project: Path) -> None:
    _fill_charter(project)
    (project / "research_team_config.json").write_text(json.dumps({"profile": "theory"}), encoding="utf-8")
    result = _run_gate(project)
    assert result.returncode == 1
    assert "Declared profile mismatch" in result.stdout


def test_explicit_gate_disable_remains_effective(project: Path) -> None:
    (project / "research_team_config.json").write_text(
        json.dumps({"features": {"project_charter_gate": False}}), encoding="utf-8",
    )
    result = _run_gate(project)
    assert result.returncode == 0
    assert "[skip]" in result.stdout


def test_inline_validation_and_anti_goal_order_remain_meaningful(project: Path) -> None:
    text = _fill_charter(project).replace(f"Validation goals:\n- {VALIDATION}", f"Validation goal(s): {VALIDATION}")
    text = text.replace("Non-goals / anti-goals:", "Anti-goals / non-goals:")
    (project / "project_charter.md").write_text(text, encoding="utf-8")
    result = _run_gate(project)
    assert result.returncode == 0, result.stdout + result.stderr


def test_optional_commitments_have_no_fixed_count_or_kb_requirement(project: Path) -> None:
    text = _fill_charter(project) + "\nProject-specific commitments:\n- Record the source versions used in the comparison.\n"
    (project / "project_charter.md").write_text(text, encoding="utf-8")
    result = _run_gate(project)
    assert result.returncode == 0, result.stdout + result.stderr


@pytest.mark.parametrize("commitment", [
    "\n- Read [source note](knowledge_base/missing.md).",
    "\n- TODO: Read [source note](knowledge_base/missing.md).",
    " Read [source note](knowledge_base/missing.md).",
])
def test_optional_commitments_still_reject_a_broken_declared_kb_link(
    project: Path, commitment: str,
) -> None:
    text = _fill_charter(project) + f"\nProject-specific commitments:{commitment}\n"
    (project / "project_charter.md").write_text(text, encoding="utf-8")
    result = _run_gate(project)
    assert result.returncode == 1
    assert "missing KB file" in result.stdout
