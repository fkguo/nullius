from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path


TESTS_DIR = Path(__file__).resolve().parent
RESEARCH_TEAM_DIR = TESTS_DIR.parent
GATE = RESEARCH_TEAM_DIR / "scripts" / "gates" / "check_notebook_integrity.py"


def _write_config(tmp_path: Path, enabled: bool) -> None:
    (tmp_path / "research_team_config.json").write_text(
        json.dumps({
            "features": {
                "notebook_integrity_gate": enabled,
            },
        }, indent=2) + "\n",
        encoding="utf-8",
    )


def _valid_contract(
    *,
    review_excerpt: str = "Short excerpt with real content.",
    audit_slices: str = "- Quick proxy check: dimensional analysis matches expected units.",
    milestone_kind: str = "computational",
    min_headline_numbers: int = 3,
    body_prefix: str = "## 1. Overview",
) -> str:
    return (
        f"{body_prefix}\n\n"
        "<!-- REVIEW_EXCERPT_START -->\n"
        f"{review_excerpt}\n"
        "<!-- REVIEW_EXCERPT_END -->\n\n"
        "<!-- AUDIT_SLICES_START -->\n"
        f"{audit_slices}\n"
        "<!-- AUDIT_SLICES_END -->\n\n"
        "<!-- REPRO_CAPSULE_START -->\n"
        f"Milestone kind: {milestone_kind}\n"
        f"Min headline numbers: {min_headline_numbers}\n"
        "<!-- REPRO_CAPSULE_END -->\n"
    )


def _run_gate(tmp_path: Path, notes_text: str, *, enabled: bool = True) -> subprocess.CompletedProcess[str]:
    tmp_path.mkdir(parents=True, exist_ok=True)
    _write_config(tmp_path, enabled)
    notes = tmp_path / "research_contract.md"
    notes.write_text(notes_text, encoding="utf-8")
    return subprocess.run(
        [sys.executable, str(GATE), "--notes", str(notes)],
        text=True,
        capture_output=True,
        check=False,
    )


def test_returns_skip_when_notebook_integrity_gate_disabled(tmp_path: Path) -> None:
    result = _run_gate(tmp_path, _valid_contract(), enabled=False)
    assert result.returncode == 0
    assert "[skip] notebook integrity gate disabled" in result.stdout


def test_fails_when_marker_block_is_duplicated(tmp_path: Path) -> None:
    notes = _valid_contract() + "\n<!-- REVIEW_EXCERPT_START -->\nDuplicate block\n<!-- REVIEW_EXCERPT_END -->\n"
    result = _run_gate(tmp_path, notes)
    assert result.returncode == 1
    assert "duplicate marker" in result.stdout


def test_fails_when_review_excerpt_is_template_only(tmp_path: Path) -> None:
    result = _run_gate(tmp_path, _valid_contract(review_excerpt="Paste the minimal excerpt here."))
    assert result.returncode == 1
    assert "REVIEW_EXCERPT block is empty or still template placeholder" in result.stdout


def test_fails_when_computational_audit_block_is_template_only(tmp_path: Path) -> None:
    result = _run_gate(
        tmp_path,
        _valid_contract(
            audit_slices=(
                "- Key algorithm steps to cross-check:\n"
                "- Proxy headline numbers (audit quantities; fast to verify by hand/estimate):\n"
                "- Boundary or consistency checks (limits/symmetry/conservation):\n"
                "- Trivial operations not rechecked (standard library, io, plotting):\n"
                "- Audit slice artifacts (logs/tables):"
            ),
        ),
    )
    assert result.returncode == 1
    assert "AUDIT_SLICES block is still template-only" in result.stdout


def test_does_not_fail_for_template_only_audit_when_theory_or_zero_headlines(tmp_path: Path) -> None:
    template_audit = (
        "- Key algorithm steps to cross-check:\n"
        "- Proxy headline numbers (audit quantities; fast to verify by hand/estimate):\n"
        "- Boundary or consistency checks (limits/symmetry/conservation):\n"
        "- Trivial operations not rechecked (standard library, io, plotting):\n"
        "- Audit slice artifacts (logs/tables):"
    )

    theory = _run_gate(
        tmp_path / "theory",
        _valid_contract(audit_slices=template_audit, milestone_kind="theory"),
    )
    zero_headlines = _run_gate(
        tmp_path / "zero",
        _valid_contract(audit_slices=template_audit, min_headline_numbers=0),
    )

    assert theory.returncode == 0
    assert "Gate: PASS" in theory.stdout
    assert zero_headlines.returncode == 0
    assert "Gate: PASS" in zero_headlines.stdout


def test_fails_on_math_or_link_rendering_hazard(tmp_path: Path) -> None:
    result = _run_gate(
        tmp_path,
        _valid_contract(body_prefix="## 1. Overview\n\nHere is a bad inline delimiter: \\(x+y\\)."),
    )
    assert result.returncode == 1
    assert "disallowed LaTeX math delimiter" in result.stdout


def test_warn_only_heading_gap_still_passes(tmp_path: Path) -> None:
    result = _run_gate(
        tmp_path,
        _valid_contract(body_prefix="## 1. Overview\n\n## 3. Gap\n\n## 4. Follow-up"),
    )
    assert result.returncode == 0
    assert "WARN:" in result.stdout
