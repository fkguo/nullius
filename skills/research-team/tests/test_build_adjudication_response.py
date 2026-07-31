"""The adjudication builder inventories every non-blocking finding.

Severity-graded convergence lets a member report `ready` while carrying
Minor Issues; those findings flow to the coordinator's adjudication for an
explicit disposition (fix now / named acceptance point / discard with
reason). A builder that never extracts the Minor Issues section would let
them fall out of the record silently — exactly the silent drop the
disposition rule forbids.
"""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path

SCRIPT = (
    Path(__file__).resolve().parents[1] / "scripts" / "bin" / "build_adjudication_response.py"
)

REPORT_A = """# Member A report

## Major Gaps
- (none)

## Minor Issues
- fixture X could also mutate field beta (hardening beyond declared scope)
- prefer a named constant for the tolerance literal

## Minimal Fix List
1. src/module.py: tighten the boundary check

## Verdict
- ready for next milestone
- Blocking issues: none
"""

REPORT_B = """# Member B report

## Major Gaps
- (none)

## Minor Issues
- add an extra negative control for the empty-input path

## Minimal Fix List
- (none)

## Verdict
- ready for next milestone
- Blocking issues: none
"""


def test_minor_issues_are_inventoried_with_disposition_slots(tmp_path: Path) -> None:
    a = tmp_path / "a.md"
    b = tmp_path / "b.md"
    out = tmp_path / "adjudication.md"
    a.write_text(REPORT_A, encoding="utf-8")
    b.write_text(REPORT_B, encoding="utf-8")

    proc = subprocess.run(
        [
            sys.executable,
            str(SCRIPT),
            "--tag",
            "M1-r1",
            "--member-a",
            str(a),
            "--member-b",
            str(b),
            "--out",
            str(out),
        ],
        capture_output=True,
        text=True,
        timeout=60,
    )
    assert proc.returncode == 0, proc.stderr
    text = out.read_text(encoding="utf-8")

    # Every Minor Issue from both members appears in the adjudication skeleton.
    assert "fixture X could also mutate field beta" in text
    assert "prefer a named constant for the tolerance literal" in text
    assert "add an extra negative control for the empty-input path" in text
    # The disposition contract is stated and a fillable disposition table exists.
    assert "explicit disposition" in text
    assert "fix now / attach to a named acceptance" in text
    assert "Disposition (fix now / acceptance point <name> / discard: <reason>)" in text


def test_absent_minor_issues_section_yields_empty_inventory(tmp_path: Path) -> None:
    a = tmp_path / "a.md"
    b = tmp_path / "b.md"
    out = tmp_path / "adjudication.md"
    a.write_text("# A\n\n## Verdict\n- ready for next milestone\n", encoding="utf-8")
    b.write_text("# B\n\n## Verdict\n- ready for next milestone\n", encoding="utf-8")

    proc = subprocess.run(
        [
            sys.executable,
            str(SCRIPT),
            "--tag",
            "M1-r1",
            "--member-a",
            str(a),
            "--member-b",
            str(b),
            "--out",
            str(out),
        ],
        capture_output=True,
        text=True,
        timeout=60,
    )
    assert proc.returncode == 0, proc.stderr
    text = out.read_text(encoding="utf-8")
    assert "### 2.1 From Member A — Minor Issues" in text
    assert "- (none)" in text
