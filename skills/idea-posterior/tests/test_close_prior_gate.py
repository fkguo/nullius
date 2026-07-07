"""Regression tests for the close-prior deep-literature gate."""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import validate_close_prior_gate as gate


def identity(verdict: str = "consistent", providers: int = 2):
    blocks = [
        {
            "provider": "arxiv",
            "title": "Source-grounded example paper",
            "year": 2026,
            "identifier": "2601.00001",
        },
        {
            "provider": "inspire",
            "title": "Source-grounded example paper",
            "year": 2026,
            "identifier": "recid:2601001",
        },
    ][:providers]
    return {"verdict": verdict, "providers": blocks}


def valid_survey():
    return {
        "version": 1,
        "generated_at": "2026-07-05T00:00:00Z",
        "topic": "close-prior gate fixture",
        "papers": [
            {
                "ref_key": "Example2026",
                "domain": "hep",
                "read_status": "full_text_read",
                "source_links": ["https://arxiv.org/abs/2601.00001"],
                "read_locators": ["source.tex lines 10-70"],
                "read_sections": [
                    "introduction",
                    "formalism_method",
                    "results_discussion",
                    "conclusion_outlook",
                ],
                "role": "core",
                "one_line": "Anchors the close-prior gate fixture.",
                "identity_triangulation": identity(),
                "source_fidelity_audit": {
                    "status": "pass",
                    "auditor": "fixture-reviewer",
                    "checked_locators": ["source.tex lines 10-70"],
                },
            }
        ],
        "synthesis": {"consensus": [], "tensions": [], "gaps": []},
        "coverage": {
            "total_papers": 1,
            "deep_read": 1,
            "core_total": 1,
            "core_deep_read": 1,
            "saturation": "saturated",
            "saturation_evidence": [
                {
                    "round": 1,
                    "expansion_candidates_screened": 8,
                    "new_core_papers": 1,
                    "discovery_methods": ["seed_search", "backward_references"],
                },
                {
                    "round": 2,
                    "expansion_candidates_screened": 6,
                    "new_core_papers": 0,
                    "discovery_methods": ["forward_citations", "critique_specific_search"],
                },
            ],
        },
    }


def valid_entry():
    return {
        "reference": "Example2026",
        "source_link": "https://arxiv.org/abs/2601.00001",
        "read_status": "full_text_read",
        "locator": "source.tex lines 10-70",
        "sections_read": [
            "introduction",
            "formalism_method",
            "results_discussion",
            "conclusion_outlook",
        ],
        "same_scope": "not_same_scope",
        "supports_subclaims": ["testability_timing"],
        "weakens_novelty_claims": [],
        "stale_or_provisional": False,
        "identity_triangulation": identity(),
        "source_fidelity_audit": {
            "status": "pass",
            "auditor": "fixture-reviewer",
            "checked_locators": ["source.tex lines 10-70"],
        },
    }


def valid_matrix():
    return {
        "coverage_status": "saturated",
        "survey_ref": f"project://artifacts/literature/survey.json#sha256:{'c' * 64}",
        "close_prior_matrix_ref": f"project://artifacts/literature/close-prior-matrix.json#sha256:{'d' * 64}",
        "critique_search": {
            "queries": ["example competing resolution"],
            "top_hits_reviewed": ["Example2026"],
        },
        "entries": [valid_entry()],
        "gaia_anchors": [
            {
                "anchor_source": "claim_grounding",
                "proposition": "The close-prior fixture supports testability timing.",
                "quote": "short checked source span",
                "locator": "source.tex lines 42-45",
                "source_link": "https://arxiv.org/abs/2601.00001",
            }
        ],
    }


REPORT = """
# posterior_report_v1

## Close-Prior Matrix

| reference | read status | same-scope | supports | weakens | stale |
|---|---|---|---|---|---|
| [Example2026](https://arxiv.org/abs/2601.00001) | full_text_read | not_same_scope | testability_timing | none | no |
"""


def problems(matrix=None, survey=None, report=REPORT, *, allow_exploratory=False):
    return gate.validate_gate(
        valid_survey() if survey is None else survey,
        valid_matrix() if matrix is None else matrix,
        report,
        allow_exploratory=allow_exploratory,
    )


def assert_problem_contains(problems_list, text):
    assert any(text in problem for problem in problems_list), problems_list


def test_valid_gate_passes():
    assert problems() == []


def test_coverage_incomplete_can_pass_only_as_provisional_not_allocation_eligible():
    matrix = valid_matrix()
    matrix["coverage_status"] = "coverage_incomplete"
    matrix["posterior_status"] = "provisional"
    matrix["allocation_eligible"] = False
    assert problems(matrix) == []

    matrix = valid_matrix()
    matrix["coverage_status"] = "coverage_incomplete"
    matrix["posterior_status"] = "current"
    matrix["allocation_eligible"] = False
    assert_problem_contains(problems(matrix), "posterior_status current")

    matrix = valid_matrix()
    matrix["coverage_status"] = "coverage_incomplete"
    matrix["posterior_status"] = "provisional"
    matrix["allocation_eligible"] = True
    assert_problem_contains(problems(matrix), "allocation_eligible")


def test_coverage_incomplete_exploratory_allocation_requires_explicit_allow():
    matrix = valid_matrix()
    matrix["coverage_status"] = "coverage_incomplete"
    matrix["posterior_status"] = "provisional"
    matrix["allocation_eligible"] = True
    matrix["exploratory_allocation"] = True
    assert_problem_contains(problems(matrix), "requires --allow-exploratory")
    assert problems(matrix, allow_exploratory=True) == []


def test_metadata_only_coverage_cannot_enter_posterior_writeback():
    matrix = valid_matrix()
    matrix["coverage_status"] = "metadata_only"
    matrix["posterior_status"] = "provisional"
    matrix["allocation_eligible"] = False
    assert_problem_contains(problems(matrix), "metadata_only coverage")


def test_unknown_survey_saturation_cannot_enter_posterior_writeback():
    survey = valid_survey()
    survey["coverage"]["saturation"] = "unknown"
    survey["coverage"].pop("saturation_evidence")
    assert_problem_contains(problems(survey=survey), "saturation=unknown")


def test_malformed_saturation_rounds_fail():
    survey = valid_survey()
    survey["coverage"]["saturation_evidence"] = [
        {
            "round": 2,
            "expansion_candidates_screened": 0,
            "new_core_papers": 1,
            "discovery_methods": ["seed_search", "seed_search"],
        }
    ]
    issues = problems(survey=survey)
    assert_problem_contains(issues, "round must equal 1")
    assert_problem_contains(issues, "positive integer")
    assert_problem_contains(issues, "cannot exceed")
    assert_problem_contains(issues, "must not repeat")


def test_missing_critique_search_fails_for_tension_resolution_above_weakest():
    matrix = valid_matrix()
    matrix.pop("critique_search")
    matrix["tension_resolution"] = {
        "grade": "substantial",
        "supporting_refs": ["Example2026"],
        "challenge_refs": ["Example2026b"],
    }
    issues = problems(matrix)
    assert_problem_contains(issues, "critique_search.queries")


def test_tension_resolution_above_weakest_requires_challenge_pool():
    matrix = valid_matrix()
    matrix["tension_resolution"] = {
        "grade": "substantial",
        "supporting_refs": ["Example2026"],
    }
    issues = problems(matrix)
    assert_problem_contains(issues, "challenge_refs")


def test_close_prior_entry_requires_read_status_source_link_locator_and_identity():
    matrix = valid_matrix()
    matrix["entries"][0] = {"reference": "ThinEntry"}
    issues = problems(matrix)
    assert_problem_contains(issues, "read_status")
    assert_problem_contains(issues, "source_link")
    assert_problem_contains(issues, "locator")
    assert_problem_contains(issues, "citation identity triangulation")


def test_citation_identity_triangulation_fails_on_conflict_or_single_provider():
    matrix = valid_matrix()
    matrix["entries"][0]["identity_triangulation"] = identity("conflicted")
    assert_problem_contains(problems(matrix), "verdict must be consistent")
    matrix = valid_matrix()
    matrix["entries"][0]["identity_triangulation"] = identity("consistent", providers=1)
    assert_problem_contains(problems(matrix), "at least two provider records")

    matrix = valid_matrix()
    bad = identity()
    bad["providers"][1]["provider"] = "arxiv"
    matrix["entries"][0]["identity_triangulation"] = bad
    assert_problem_contains(problems(matrix), "independent provider names")

    matrix = valid_matrix()
    bad = identity()
    bad["providers"][1]["title"] = "A different paper"
    matrix["entries"][0]["identity_triangulation"] = bad
    assert_problem_contains(problems(matrix), "conflicting titles")

    matrix = valid_matrix()
    bad = identity()
    bad["providers"][1]["identifier"] = "arXiv:2601.99999"
    matrix["entries"][0]["identity_triangulation"] = bad
    assert_problem_contains(problems(matrix), "conflicting arXiv ids")


def test_metadata_only_entries_cannot_support_or_weaken_subclaims():
    matrix = valid_matrix()
    entry = valid_entry()
    entry["read_status"] = "metadata_only"
    entry["supports_subclaims"] = ["novelty"]
    matrix["entries"][0] = entry
    assert_problem_contains(problems(matrix), "cannot support or weaken subclaims")


def test_metadata_only_entries_cannot_have_gaia_anchor_refs():
    matrix = valid_matrix()
    entry = valid_entry()
    entry["read_status"] = "metadata_only"
    entry["gaia_anchor_refs"] = ["anchor-1"]
    matrix["entries"][0] = entry
    assert_problem_contains(problems(matrix), "cannot anchor Gaia likelihood")


def test_negative_novelty_claims_always_require_reviewer_gate():
    matrix = valid_matrix()
    matrix["negative_novelty_claims"] = [
        {
            "claim": "No existing work implements this scope.",
            "strength": "weak",
        }
    ]
    assert_problem_contains(problems(matrix), "requires reviewer_gate")


def test_missing_matrix_fails():
    issues = gate.validate_gate(valid_survey(), None, REPORT, allow_exploratory=False)
    assert_problem_contains(issues, "close-prior matrix must be a JSON object")


def test_report_requires_clickable_source_links():
    report = REPORT.replace("[Example2026](https://arxiv.org/abs/2601.00001)", "Example2026")
    assert_problem_contains(problems(report=report), "clickable source link")


def test_source_fidelity_audit_is_required_for_deep_read_summaries():
    matrix = valid_matrix()
    matrix["entries"][0].pop("source_fidelity_audit")
    assert_problem_contains(problems(matrix), "source_fidelity_audit")
    matrix = valid_matrix()
    matrix["entries"][0]["source_fidelity_audit"]["status"] = "partial"
    assert_problem_contains(problems(matrix), "status must be pass")


def test_arxiv_2411_18257_fixture_fails_if_late_femtoscopy_caveat_is_missing():
    matrix = valid_matrix()
    report = REPORT.replace("Example2026", "arXiv:2411.18257").replace(
        "https://arxiv.org/abs/2601.00001",
        "https://arxiv.org/abs/2411.18257",
    )
    entry = valid_entry()
    entry.update(
        {
            "reference": "arXiv:2411.18257",
            "arxiv_id": "arXiv:2411.18257",
            "inspire_recid": "2853359",
            "source_link": "https://arxiv.org/abs/2411.18257",
            "locator": "Exotics_v2.tex lines 739-746",
            "required_late_caveat_terms": ["source profile", "source size", "uv regulator"],
            "key_caveats": ["momentum correlations contain final-state interaction information"],
            "identity_triangulation": {
                "verdict": "consistent",
                "providers": [
                    {
                        "provider": "arxiv",
                        "title": "Production of exotic hadrons in pp and nuclear collisions",
                        "year": 2024,
                        "identifier": "2411.18257",
                    },
                    {
                        "provider": "inspire",
                        "title": "Production of exotic hadrons in pp and nuclear collisions",
                        "year": 2024,
                        "identifier": "2853359",
                    },
                ],
            },
        }
    )
    matrix["entries"][0] = entry
    matrix["gaia_anchors"][0]["source_link"] = "https://arxiv.org/abs/2411.18257"
    issues = problems(matrix, report=report)
    assert_problem_contains(issues, "required late-section caveat terms")
    assert_problem_contains(issues, "source profile")


def test_arxiv_2411_18257_fixture_passes_when_late_caveat_is_recorded():
    matrix = valid_matrix()
    report = REPORT.replace("Example2026", "arXiv:2411.18257").replace(
        "https://arxiv.org/abs/2601.00001",
        "https://arxiv.org/abs/2411.18257",
    )
    entry = valid_entry()
    entry.update(
        {
            "reference": "arXiv:2411.18257",
            "arxiv_id": "arXiv:2411.18257",
            "inspire_recid": "2853359",
            "source_link": "https://arxiv.org/abs/2411.18257",
            "locator": "Exotics_v2.tex lines 739-746",
            "required_late_caveat_terms": ["source profile", "source size", "uv regulator"],
            "key_caveats": [
                "The extracted hadron-hadron interaction depends on the assumed source profile and source size; the source function acts as a UV regulator/form factor.",
            ],
            "identity_triangulation": {
                "verdict": "consistent",
                "providers": [
                    {
                        "provider": "arxiv",
                        "title": "Production of exotic hadrons in pp and nuclear collisions",
                        "year": 2024,
                        "identifier": "2411.18257",
                    },
                    {
                        "provider": "inspire",
                        "title": "Production of exotic hadrons in pp and nuclear collisions",
                        "year": 2024,
                        "identifier": "2853359",
                    },
                ],
            },
        }
    )
    matrix["entries"][0] = entry
    matrix["gaia_anchors"][0]["source_link"] = "https://arxiv.org/abs/2411.18257"
    assert problems(matrix, report=report) == []


def test_subagent_synthesis_cannot_enter_gaia_without_claim_grounding():
    matrix = valid_matrix()
    matrix["subagent_inputs"] = [{"summary": "Subagent says the prior art is absent", "used_in_gaia": True}]
    assert_problem_contains(problems(matrix), "without claim_grounding_ref")


def test_gaia_anchor_must_be_proposition_level_claim_grounding():
    matrix = valid_matrix()
    matrix["gaia_anchors"][0] = {
        "anchor_source": "subagent_summary",
        "proposition": "A paper exists.",
        "source_link": "https://arxiv.org/abs/2601.00001",
        "locator": "metadata",
        "quote": "summary",
    }
    assert_problem_contains(problems(matrix), "must come from claim_grounding")


def test_gaia_anchor_source_link_must_match_source_read_matrix_entry():
    matrix = valid_matrix()
    matrix["gaia_anchors"][0]["source_link"] = "https://arxiv.org/abs/2601.99999"
    assert_problem_contains(problems(matrix), "must match a source-read close-prior entry")


def test_cli_fails_closed(tmp_path: Path):
    survey = tmp_path / "survey.json"
    matrix = tmp_path / "matrix.json"
    report = tmp_path / "posterior_report.md"
    survey.write_text(json.dumps(valid_survey()), encoding="utf-8")
    bad_matrix = valid_matrix()
    bad_matrix.pop("critique_search")
    matrix.write_text(json.dumps(bad_matrix), encoding="utf-8")
    report.write_text(REPORT, encoding="utf-8")
    result = subprocess.run(
        [
            sys.executable,
            str(Path(__file__).resolve().parents[1] / "scripts" / "validate_close_prior_gate.py"),
            "--survey-json",
            str(survey),
            "--matrix-json",
            str(matrix),
            "--report-md",
            str(report),
        ],
        capture_output=True,
        text=True,
    )
    assert result.returncode == 2
    assert "close-prior gate failed" in result.stderr
