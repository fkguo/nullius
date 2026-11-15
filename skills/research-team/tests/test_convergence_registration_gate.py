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
import pytest

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
        # Controlled read-model fixture, not a real semantic reviewer receipt.
        "content_review": {"status": "accepted"},
        "result_links": {
            "status": "linked",
            "results": [{"result_id": "binding-energy", "sections": ["Spectrum results"]}],
            "missing_result_ids": [],
        },
        "found": True,
        "sections": [
            {"heading": "Spectrum results"},
            {"heading": "Old formalism"},
            {"heading": "Methods"},
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
        controlled = view if view is not None else DEFAULT_VIEW
        content = controlled["notebook"].get("content_review", {})
        structure = controlled["notebook"].get("result_links", {})
        accepted = content.get("status") == "accepted" and structure.get("status") in ("linked", "not_applicable")
        check_path = root / ".nullius" / "notebook-check.json"
        check_path.write_text(json.dumps({"status": "accepted" if accepted else "incomplete", "content_review": content, "structure": structure}), encoding="utf-8")
        stub = bin_dir / "nullius"
        stub.write_text(
            "#!/usr/bin/env bash\n"
            'if [[ "$*" == *"notebook check"* ]]; then\n'
            f'  cat "{check_path}"\n'
            f'  exit {0 if accepted else 1}\n'
            'fi\n'
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


@pytest.mark.parametrize("status", ["missing", "stale", "rejected", "unavailable", "incomplete"])
def test_navigation_cannot_replace_current_whole_notebook_review(tmp_path: Path, status: str) -> None:
    view = json.loads(json.dumps(DEFAULT_VIEW))
    view["notebook"]["content_review"] = {"status": status}
    result = _run_gate(_convergence_json(tmp_path), _adjudication(tmp_path, GOOD_DECLARATION), _project_root(tmp_path, view))
    assert result.returncode == 1
    assert "whole-notebook" in result.stderr.lower()


def test_absent_content_review_contract_does_not_inherit_linked_acceptance(tmp_path: Path) -> None:
    view = json.loads(json.dumps(DEFAULT_VIEW))
    del view["notebook"]["content_review"]
    result = _run_gate(_convergence_json(tmp_path), _adjudication(tmp_path, GOOD_DECLARATION), _project_root(tmp_path, view))
    assert result.returncode == 1
    assert "whole-notebook" in result.stderr.lower()


@pytest.mark.parametrize("status", ["missing", "stale", "rejected", "unavailable", "incomplete"])
def test_none_declarations_cannot_exempt_a_converged_fold(tmp_path: Path, status: str) -> None:
    view = json.loads(json.dumps(DEFAULT_VIEW))
    view["notebook"]["content_review"] = {"status": status}
    body = "## Result registration\n\n- Headline result: none — no named result\n- Supersedes: none\n- Rewritten sections: none\n"
    result = _run_gate(_convergence_json(tmp_path), _adjudication(tmp_path, body), _project_root(tmp_path, view))
    assert result.returncode == 1
    assert "whole-notebook" in result.stderr.lower()


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


@pytest.mark.parametrize("historical_class", [None, "unstamped", "stale", "incomparable"])
def test_current_full_review_accepts_notes_without_section_stamps(tmp_path: Path, historical_class: str | None) -> None:
    view = json.loads(json.dumps(DEFAULT_VIEW))
    if historical_class is not None:
        view["notebook"]["sections"][0]["class"] = historical_class
    result = _run_gate(
        _convergence_json(tmp_path),
        _adjudication(tmp_path, GOOD_DECLARATION),
        _project_root(tmp_path, view),
    )
    assert result.returncode == 0, result.stderr + result.stdout


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


def test_project_without_launcher_cannot_accept_a_converged_fold(tmp_path: Path) -> None:
    result = _run_gate(
        _convergence_json(tmp_path),
        _adjudication(tmp_path, GOOD_DECLARATION),
        _project_root(tmp_path, launcher=False),
    )
    assert result.returncode == 2
    payload = json.loads(result.stdout.strip().splitlines()[-1])
    assert payload["status"] == "error"
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
    assert "written-against" not in text
    assert "refresh its automatic block" not in text
    assert "finish the user's research notes" in text
    assert "unscoped `nullius notebook check --json`" in text
    assert "actual-byte SHA-256 of the complete UTF-8 notebook" in text
    # The gate must FIND the declaration section exactly as the builder emits it.
    sys.path.insert(0, str(GATES))
    from check_convergence_registration import extract_registration_section  # type: ignore

    assert extract_registration_section(text) is not None


def test_backtick_wrapped_heading_containing_a_double_quote_passes(tmp_path: Path) -> None:
    view = json.loads(json.dumps(DEFAULT_VIEW))
    view["notebook"]["sections"].append(
        {"heading": 'The "exact" spectrum', "class": "current", "cause": "stamp matches HEAD"}
    )
    view["notebook"]["result_links"]["results"][0]["sections"] = ['The "exact" spectrum']
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
    view["notebook"]["result_links"]["results"].append({"result_id": "m0", "sections": ["Spectrum results"]})
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


@pytest.mark.parametrize("review_status", ["accepted", "missing", "stale"])
def test_duplicate_headings_rely_on_whole_notebook_review(tmp_path: Path, review_status: str) -> None:
    view = json.loads(json.dumps(DEFAULT_VIEW))
    view["notebook"]["sections"].append(
        {"heading": "Spectrum results", "class": "stale", "cause": "stamp predates superseding run"}
    )
    view["notebook"]["content_review"] = {"status": review_status}
    result = _run_gate(
        _convergence_json(tmp_path),
        _adjudication(tmp_path, GOOD_DECLARATION),
        _project_root(tmp_path, view),
    )
    if review_status == "accepted":
        assert result.returncode == 0, result.stderr + result.stdout
    else:
        assert result.returncode == 1
        assert "whole-notebook" in result.stderr


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


@pytest.mark.parametrize("block", [
    {"block_found": True, "duplicated_markers": False, "in_sync": False},
    {"block_found": False, "duplicated_markers": False, "in_sync": None},
    {"block_found": False, "duplicated_markers": True, "in_sync": None},
])
def test_historical_machine_block_metadata_does_not_gate_reviewed_notes(tmp_path: Path, block: dict) -> None:
    # Currency comes from the result registry and current full-text review.
    # A historical machine block is no longer a required notebook component.
    view = json.loads(json.dumps(DEFAULT_VIEW))
    view["notebook"]["current_state_block"] = block
    result = _run_gate(
        _convergence_json(tmp_path),
        _adjudication(tmp_path, GOOD_DECLARATION),
        _project_root(tmp_path, view),
    )
    assert result.returncode == 0, result.stderr + result.stdout


@pytest.mark.parametrize("validity", ["superseded", "void"])
def test_historical_citations_do_not_require_english_tokens_or_hidden_roles(tmp_path: Path, validity: str) -> None:
    view = json.loads(json.dumps(DEFAULT_VIEW))
    heading = "计算过程与当前结论"
    view["notebook"]["sections"] = [{"heading": heading}]
    view["notebook"]["result_links"]["results"][0]["sections"] = [heading]
    view["notebook"]["run_links"] = {
        "notebook_found": True,
        "citations": [{
            "section": heading,
            "run_id": "20260808-m2-r003-old",
            "validity": validity,
            "superseded_by": "20260808-m2-r010-final" if validity == "superseded" else None,
        }],
        "unknown_run_ids": [],
    }
    body = GOOD_DECLARATION.replace('"Spectrum results"', f'"{heading}"')
    result = _run_gate(
        _convergence_json(tmp_path),
        _adjudication(tmp_path, body),
        _project_root(tmp_path, view),
    )
    assert result.returncode == 0, result.stderr + result.stdout


@pytest.mark.parametrize("validity", ["superseded", "void"])
def test_current_result_from_an_invalid_run_still_refuses(tmp_path: Path, validity: str) -> None:
    view = json.loads(json.dumps(DEFAULT_VIEW))
    # The canonical registry read model marks this objectively invalid row.
    view["results"]["current"][0]["defective"] = True
    view["results"]["issues"] = [{
        "code": "row_defect",
        "message": f"registry row for binding-energy cites a {validity} run",
    }]
    result = _run_gate(
        _convergence_json(tmp_path),
        _adjudication(tmp_path, GOOD_DECLARATION),
        _project_root(tmp_path, view),
    )
    assert result.returncode == 1
    assert "defective registry row" in result.stderr
    assert f"cites a {validity} run" in result.stderr


def test_headline_without_human_rewrite_refuses(tmp_path: Path) -> None:
    body = GOOD_DECLARATION.replace('- Rewritten sections: "Spectrum results"', '- Rewritten sections: none')
    result = _run_gate(_convergence_json(tmp_path), _adjudication(tmp_path, body), _project_root(tmp_path))
    assert result.returncode == 1
    assert "needs its artifact linked" in result.stderr


def test_historical_machine_metadata_cannot_satisfy_user_result_links(tmp_path: Path) -> None:
    view = json.loads(json.dumps(DEFAULT_VIEW))
    view["notebook"]["current_state_block"] = {"block_found": True, "in_sync": True}
    view["notebook"]["result_links"]["status"] = "missing_links"
    view["notebook"]["result_links"]["results"][0]["sections"] = []
    result = _run_gate(_convergence_json(tmp_path), _adjudication(tmp_path, GOOD_DECLARATION), _project_root(tmp_path, view))
    assert result.returncode == 1
    assert "needs its artifact linked" in result.stderr


def test_missing_link_read_model_is_not_approval(tmp_path: Path) -> None:
    view = json.loads(json.dumps(DEFAULT_VIEW))
    del view["notebook"]["result_links"]
    result = _run_gate(_convergence_json(tmp_path), _adjudication(tmp_path, GOOD_DECLARATION), _project_root(tmp_path, view))
    assert result.returncode == 1
    assert "check unavailable" in result.stderr


def test_result_scoped_navigation_does_not_exempt_the_whole_closeout_check(tmp_path: Path) -> None:
    view = json.loads(json.dumps(DEFAULT_VIEW))
    view["notebook"]["result_links"]["status"] = "missing_links"
    view["notebook"]["result_links"]["missing_result_ids"] = ["other-result"]
    result = _run_gate(_convergence_json(tmp_path), _adjudication(tmp_path, GOOD_DECLARATION), _project_root(tmp_path, view))
    assert result.returncode == 1
    assert "whole-notebook closeout" in result.stderr


def test_none_declaration_cannot_exempt_missing_adopted_result_navigation(tmp_path: Path) -> None:
    view = json.loads(json.dumps(DEFAULT_VIEW))
    view["notebook"]["result_links"]["status"] = "missing_links"
    body = "## Result registration\n\n- Headline result: none — no named result\n- Supersedes: none\n- Rewritten sections: none\n"
    result = _run_gate(_convergence_json(tmp_path), _adjudication(tmp_path, body), _project_root(tmp_path, view))
    assert result.returncode == 1
    assert "structure=missing_links" in result.stderr
