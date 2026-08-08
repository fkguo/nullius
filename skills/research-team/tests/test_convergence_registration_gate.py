"""Fold-boundary registration gate: declaration required, declaration
verified against the traceability record, honest SKIPs.

The gate consumes `nullius current --json` through the project launcher, so
these tests run against a stub launcher that serves a controlled view JSON —
the contract under test is (declaration grammar) x (view verification), not
the CLI itself (covered by the orchestrator's own tests).
"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

GATES = Path(__file__).resolve().parent.parent / "scripts" / "gates"
GATE = GATES / "check_convergence_registration.py"


def _convergence_json(tmp_path: Path, status: str = "converged") -> Path:
    exit_code = {"converged": 0, "not_converged": 1, "error": 2}.get(status, 0)
    payload = {
        "status": status,
        "exit_code": exit_code,
        "reasons": [],
        "report_status": {
            "member_a": {
                "verdict": "ready",
                "parse_ok": True,
                "blocking_count": 0,
                "minor_issues_count": 0,
                "missing_sections": [],
            },
        },
        "meta": {
            "gate_id": "team_convergence",
            "generated_at": "2026-08-08T00:00:00Z",
            "parser_version": "1",
            "schema_id": "convergence_gate_result_v1",
            "schema_version": 1,
        },
    }
    path = tmp_path / f"convergence-{status}.json"
    path.write_text(json.dumps(payload), encoding="utf-8")
    return path


DEFAULT_VIEW = {
    "results": {
        "block_found": True,
        "current": [
            {
                "result_id": "binding-energy",
                "run_id": "20260808-m2-r010-final",
                "effective_commit": "a" * 40,
                "has_snapshot": False,
                "artifact": "artifacts/runs/20260808-m2-r010-final/value.json",
                "defective": False,
            },
        ],
        "rows": 1,
        "issues": [],
    },
    "runs": {
        "superseded": [
            {"run_id": "20260808-m2-r009-old", "by": "20260808-m2-r010-final", "reason": "refit"},
        ],
        "conflicting_stamps": [],
        "no_authoritative_identity": [],
    },
    "notebook": {
        "found": True,
        "sections": [
            {"heading": "Spectrum results", "class": "current", "cause": "stamp matches HEAD"},
            {"heading": "Old formalism", "class": "stale", "cause": "stamp predates superseding run"},
            {"heading": "Methods", "class": "unstamped", "cause": "no written-against stamp"},
        ],
    },
}


def _project_root(tmp_path: Path, view: dict | None = None, *, launcher: bool = True) -> Path:
    root = tmp_path / "proj"
    bin_dir = root / ".nullius" / "bin"
    bin_dir.mkdir(parents=True)
    if launcher:
        view_path = root / ".nullius" / "view.json"
        view_path.write_text(json.dumps(view if view is not None else DEFAULT_VIEW), encoding="utf-8")
        stub = bin_dir / "nullius"
        stub.write_text(
            "#!/usr/bin/env bash\n"
            f'cat "{view_path}"\n',
            encoding="utf-8",
        )
        stub.chmod(0o755)
    return root


def _adjudication(tmp_path: Path, body: str) -> Path:
    path = tmp_path / "adjudication.md"
    path.write_text(body, encoding="utf-8")
    return path


def _run_gate(convergence: Path, adjudication: Path, project_root: Path) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [
            sys.executable,
            str(GATE),
            "--convergence-json",
            str(convergence),
            "--adjudication",
            str(adjudication),
            "--project-root",
            str(project_root),
        ],
        capture_output=True,
        text=True,
        check=False,
    )


GOOD_DECLARATION = """# Adjudication

## 6) Result registration

- Headline result: binding-energy @ 20260808-m2-r010-final
- Supersedes: 20260808-m2-r009-old -> 20260808-m2-r010-final
- Rewritten sections: "Spectrum results"

## 7) How to use this file
"""


def test_matching_declaration_passes(tmp_path: Path) -> None:
    result = _run_gate(
        _convergence_json(tmp_path),
        _adjudication(tmp_path, GOOD_DECLARATION),
        _project_root(tmp_path),
    )
    assert result.returncode == 0, result.stderr + result.stdout
    payload = json.loads(result.stdout.strip().splitlines()[-1])
    assert payload["status"] == "pass"
    assert payload["headline"] == {"result_id": "binding-energy", "run_id": "20260808-m2-r010-final"}


def test_supersession_with_trailing_note_parses_full_run_ids(tmp_path: Path) -> None:
    body = GOOD_DECLARATION.replace(
        "- Supersedes: 20260808-m2-r009-old -> 20260808-m2-r010-final",
        "- Supersedes: 20260808-m2-r009-old -> 20260808-m2-r010-final — refit with corrected weights",
    )
    result = _run_gate(
        _convergence_json(tmp_path),
        _adjudication(tmp_path, body),
        _project_root(tmp_path),
    )
    assert result.returncode == 0, result.stderr + result.stdout


def test_none_headline_with_reason_passes(tmp_path: Path) -> None:
    body = """## Result registration

- Headline result: none — infrastructure milestone, no result-bearing claim
- Supersedes: none
- Rewritten sections: none
"""
    result = _run_gate(
        _convergence_json(tmp_path),
        _adjudication(tmp_path, body),
        _project_root(tmp_path),
    )
    assert result.returncode == 0, result.stderr + result.stdout


def test_missing_registration_section_fails(tmp_path: Path) -> None:
    result = _run_gate(
        _convergence_json(tmp_path),
        _adjudication(tmp_path, "# Adjudication\n\n## 2) Non-blocking findings\n"),
        _project_root(tmp_path),
    )
    assert result.returncode == 1
    assert "Result registration" in result.stderr


def test_unfilled_template_placeholder_fails(tmp_path: Path) -> None:
    body = """## 6) Result registration

- Headline result: (fill)
- Supersedes: (fill)
- Rewritten sections: (fill)
"""
    result = _run_gate(
        _convergence_json(tmp_path),
        _adjudication(tmp_path, body),
        _project_root(tmp_path),
    )
    assert result.returncode == 1
    assert "malformed" in result.stderr


def test_bare_none_headline_without_reason_fails(tmp_path: Path) -> None:
    body = """## Result registration

- Headline result: none
- Supersedes: none
- Rewritten sections: none
"""
    result = _run_gate(
        _convergence_json(tmp_path),
        _adjudication(tmp_path, body),
        _project_root(tmp_path),
    )
    assert result.returncode == 1
    assert "requires a stated reason" in result.stderr


def test_declared_result_absent_from_registry_fails(tmp_path: Path) -> None:
    view = json.loads(json.dumps(DEFAULT_VIEW))
    view["results"]["current"] = []
    result = _run_gate(
        _convergence_json(tmp_path),
        _adjudication(tmp_path, GOOD_DECLARATION),
        _project_root(tmp_path, view),
    )
    assert result.returncode == 1
    assert "no current row" in result.stderr
    assert "set-current" in result.stderr


def test_declared_result_bound_to_other_run_fails(tmp_path: Path) -> None:
    view = json.loads(json.dumps(DEFAULT_VIEW))
    view["results"]["current"][0]["run_id"] = "some-other-run"
    result = _run_gate(
        _convergence_json(tmp_path),
        _adjudication(tmp_path, GOOD_DECLARATION),
        _project_root(tmp_path, view),
    )
    assert result.returncode == 1
    assert "not the declared" in result.stderr


def test_declared_supersession_missing_from_ledger_fails(tmp_path: Path) -> None:
    view = json.loads(json.dumps(DEFAULT_VIEW))
    view["runs"]["superseded"] = []
    result = _run_gate(
        _convergence_json(tmp_path),
        _adjudication(tmp_path, GOOD_DECLARATION),
        _project_root(tmp_path, view),
    )
    assert result.returncode == 1
    assert "not on the validity ledger" in result.stderr
    assert "trace supersede" in result.stderr


def test_declared_rewrite_without_fresh_stamp_fails(tmp_path: Path) -> None:
    body = GOOD_DECLARATION.replace('"Spectrum results"', '"Methods"')
    result = _run_gate(
        _convergence_json(tmp_path),
        _adjudication(tmp_path, body),
        _project_root(tmp_path),
    )
    assert result.returncode == 1
    assert "unstamped" in result.stderr
    assert "written-against" in result.stderr


def test_declared_rewrite_of_unknown_section_fails(tmp_path: Path) -> None:
    body = GOOD_DECLARATION.replace('"Spectrum results"', '"No Such Section"')
    result = _run_gate(
        _convergence_json(tmp_path),
        _adjudication(tmp_path, body),
        _project_root(tmp_path),
    )
    assert result.returncode == 1
    assert "does not exist in the notebook" in result.stderr


def test_non_converged_cycle_skips(tmp_path: Path) -> None:
    result = _run_gate(
        _convergence_json(tmp_path, status="not_converged"),
        _adjudication(tmp_path, GOOD_DECLARATION),
        _project_root(tmp_path),
    )
    assert result.returncode == 0
    payload = json.loads(result.stdout.strip().splitlines()[-1])
    assert payload["status"] == "skip"


def test_project_without_launcher_skips(tmp_path: Path) -> None:
    result = _run_gate(
        _convergence_json(tmp_path),
        _adjudication(tmp_path, GOOD_DECLARATION),
        _project_root(tmp_path, launcher=False),
    )
    assert result.returncode == 0
    payload = json.loads(result.stdout.strip().splitlines()[-1])
    assert payload["status"] == "skip"
    assert "launcher" in payload["reason"]


def test_launcher_error_is_input_error_not_pass(tmp_path: Path) -> None:
    root = _project_root(tmp_path)
    stub = root / ".nullius" / "bin" / "nullius"
    stub.write_text("#!/usr/bin/env bash\necho boom >&2\nexit 3\n", encoding="utf-8")
    stub.chmod(0o755)
    result = _run_gate(
        _convergence_json(tmp_path),
        _adjudication(tmp_path, GOOD_DECLARATION),
        root,
    )
    assert result.returncode == 2
    assert "exited 3" in result.stderr


def test_builder_template_carries_the_registration_section(tmp_path: Path) -> None:
    builder = GATES.parent / "bin" / "build_adjudication_response.py"
    a = tmp_path / "a.md"
    b = tmp_path / "b.md"
    a.write_text("# A\n\n## Verdict\n- ready\n", encoding="utf-8")
    b.write_text("# B\n\n## Verdict\n- ready\n", encoding="utf-8")
    out = tmp_path / "adj.md"
    proc = subprocess.run(
        [sys.executable, str(builder), "--tag", "tag-r1", "--member-a", str(a), "--member-b", str(b), "--out", str(out)],
        capture_output=True,
        text=True,
        check=False,
    )
    assert proc.returncode == 0, proc.stderr
    text = out.read_text(encoding="utf-8")
    assert "Result registration" in text
    assert "- Headline result: (fill)" in text
    assert "- Supersedes: (fill)" in text
    assert "- Rewritten sections: (fill)" in text
    # The gate must FIND the declaration section exactly as the builder emits it.
    sys.path.insert(0, str(GATES))
    from check_convergence_registration import extract_registration_section  # type: ignore

    assert extract_registration_section(text) is not None


def test_backtick_wrapped_heading_containing_a_double_quote_passes(tmp_path: Path) -> None:
    view = json.loads(json.dumps(DEFAULT_VIEW))
    view["notebook"]["sections"].append(
        {"heading": 'The "exact" spectrum', "class": "current", "cause": "stamp matches HEAD"}
    )
    body = GOOD_DECLARATION.replace(
        '- Rewritten sections: "Spectrum results"',
        '- Rewritten sections: `The "exact" spectrum`',
    )
    result = _run_gate(
        _convergence_json(tmp_path),
        _adjudication(tmp_path, body),
        _project_root(tmp_path, view),
    )
    assert result.returncode == 0, result.stderr + result.stdout


def test_headline_issue_match_is_word_bounded_not_substring(tmp_path: Path) -> None:
    # An issue about result "m01-fit" must not trip the declaration of "m0".
    view = json.loads(json.dumps(DEFAULT_VIEW))
    view["results"]["current"].append(
        {
            "result_id": "m0",
            "run_id": "20260808-m2-r010-final",
            "effective_commit": "a" * 40,
            "has_snapshot": False,
            "artifact": "artifacts/runs/20260808-m2-r010-final/v.json",
            "defective": False,
        }
    )
    view["results"]["issues"] = [
        {"code": "row_defect", "message": "registry row for m01-fit cites a voided run"},
    ]
    body = GOOD_DECLARATION.replace(
        "- Headline result: binding-energy @ 20260808-m2-r010-final",
        "- Headline result: m0 @ 20260808-m2-r010-final",
    )
    result = _run_gate(
        _convergence_json(tmp_path),
        _adjudication(tmp_path, body),
        _project_root(tmp_path, view),
    )
    assert result.returncode == 0, result.stderr + result.stdout


def test_duplicate_heading_with_one_stale_namesake_fails(tmp_path: Path) -> None:
    view = json.loads(json.dumps(DEFAULT_VIEW))
    view["notebook"]["sections"].append(
        {"heading": "Spectrum results", "class": "stale", "cause": "stamp predates superseding run"}
    )
    result = _run_gate(
        _convergence_json(tmp_path),
        _adjudication(tmp_path, GOOD_DECLARATION),
        _project_root(tmp_path, view),
    )
    assert result.returncode == 1
    assert "namesake" in result.stderr


def test_supersession_of_a_cleaned_up_run_directory_passes(tmp_path: Path) -> None:
    # The view row carries directory_missing (ledger truth survives run-dir
    # cleanup); the gate accepts the declared relation all the same.
    view = json.loads(json.dumps(DEFAULT_VIEW))
    view["runs"]["superseded"][0]["directory_missing"] = True
    result = _run_gate(
        _convergence_json(tmp_path),
        _adjudication(tmp_path, GOOD_DECLARATION),
        _project_root(tmp_path, view),
    )
    assert result.returncode == 0, result.stderr + result.stdout
