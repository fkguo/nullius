# CONTRACT-EXEMPT: CODE-01.1 sunset:2026-10-31 Pre-existing close-prior suite; this change adds bounded adversarial regressions.
"""Regression tests for the close-prior deep-literature gate."""

from __future__ import annotations

import hashlib
import json
import subprocess
import sys
import tempfile
from copy import deepcopy
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
            "bibliography_reconciliation": {
                "status": "reconciled",
                "artifact_ref": "project://artifacts/literature/literature-ledger.json#sha256:" + "0" * 64,
                "core_sources_total": 1,
                "core_sources_reconciled": 1,
                "candidates_total": 2,
                "candidates_dispositioned": 2,
                "unresolved_candidates": 0,
                "coverage_debt_candidates": 0,
            },
            "method_family_audit": {
                "status": "audited",
                "artifact_ref": "project://artifacts/literature/literature-ledger.json#sha256:" + "0" * 64,
                "core_sources_total": 1,
                "core_sources_audited": 1,
                "taxonomy_families": 1,
                "source_method_descriptions_audited": 1,
                "cited_method_descriptions_audited": 1,
                "unresolved_method_family_gaps": 0,
            },
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
    with tempfile.TemporaryDirectory(prefix="close-prior-ledger-") as directory:
        project_root = Path(directory)
        bound_survey, _ = _write_bound_ledger(project_root)
        candidate_survey = deepcopy(valid_survey() if survey is None else survey)
        candidate_survey["papers"] = bound_survey["papers"]
        candidate_survey["coverage"]["bibliography_reconciliation"]["artifact_ref"] = (
            bound_survey["coverage"]["bibliography_reconciliation"]["artifact_ref"]
        )
        candidate_survey["coverage"]["method_family_audit"]["artifact_ref"] = (
            bound_survey["coverage"]["method_family_audit"]["artifact_ref"]
        )
        return gate.validate_gate(
            candidate_survey,
            valid_matrix() if matrix is None else matrix,
            report,
            allow_exploratory=allow_exploratory,
            project_root=project_root,
        )


def assert_problem_contains(problems_list, text):
    assert any(text in problem for problem in problems_list), problems_list


def _project_ref(path: Path, project_root: Path) -> str:
    digest = hashlib.sha256(path.read_bytes()).hexdigest()
    return f"project://{path.relative_to(project_root).as_posix()}#sha256:{digest}"


def _repin_ledger(survey: dict, ledger_path: Path, project_root: Path) -> None:
    ledger_ref = _project_ref(ledger_path, project_root)
    survey["coverage"]["bibliography_reconciliation"]["artifact_ref"] = ledger_ref
    survey["coverage"]["method_family_audit"]["artifact_ref"] = ledger_ref


def _write_identity_record(
    project_root: Path,
    name: str,
    *,
    canonical_id: str,
    title: str,
    authors: list[str],
    year: int,
    providers: list[tuple[str, str]],
    doi: str | None = None,
) -> tuple[str, str]:
    path = project_root / "artifacts" / "identity" / f"{name}.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    document = {
        "citation_key": canonical_id,
        "providers": [
            {
                "provider": provider,
                "title": title,
                "authors": authors,
                "year": year,
                "doi": doi,
                "venue": None,
                "identifier": identifier,
            }
            for provider, identifier in providers
        ],
    }
    path.write_text(json.dumps(document, indent=2) + "\n", encoding="utf-8")
    ref = _project_ref(path, project_root)
    return ref, "sha256:" + ref.rsplit("sha256:", 1)[1]


def _write_bound_ledger(
    tmp_path: Path,
    *,
    ledger_core_id: str = "provider:catalog:core-1",
) -> tuple[dict, Path]:
    ledger_core_token = ledger_core_id.rsplit(":", 1)[-1]
    core_record_ref, core_record_hash = _write_identity_record(
        tmp_path,
        "core-1",
        canonical_id=ledger_core_id,
        title="Source-grounded example paper",
        authors=["A. Example"],
        year=2026,
        providers=[("catalog", ledger_core_token), ("registry", ledger_core_token)],
    )
    cited_record_ref, cited_record_hash = _write_identity_record(
        tmp_path,
        "cited-example",
        canonical_id="doi:10.1000/example",
        title="Cited example",
        authors=["A. Example"],
        year=2024,
        providers=[("catalog", "cited-example")],
        doi="10.1000/example",
    )
    raw_path = tmp_path / "artifacts" / "literature" / "core-1-bibliography.json"
    raw_path.parent.mkdir(parents=True, exist_ok=True)
    raw_doc = {
        "source_id": ledger_core_id,
        "references": [
            {
                "raw_text": "A. Example, Cited example, 2024.",
                "locator": "References, entry 7",
                "candidate_id": "doi:10.1000/example",
                "identity": {
                    "canonical_id": "doi:10.1000/example",
                    "title": "Cited example",
                    "year": 2024,
                },
            }
        ],
    }
    raw_path.write_text(json.dumps(raw_doc, indent=2) + "\n", encoding="utf-8")
    raw_ref = _project_ref(raw_path, tmp_path)
    ledger = {
        "schema_version": 1,
        "providers": {
            "catalog": {
                "status": "queried",
                "queries": ["source-grounded example"],
                "returned_count": 2,
                "total_count": 2,
                "execution_bounds": {"max_requests": 1, "max_records": 10},
                "request_log": [
                    {
                        "query": "source-grounded example",
                        "page_or_cursor": "page:1",
                        "returned_count": 2,
                        "continuation": "exhausted",
                    }
                ],
                "stop_reason": "the bounded result page was exhausted",
            }
        },
        "candidate_pool": {
            "artifact": "artifacts/literature/literature-ledger.json",
            "total_candidates": 2,
            "selected_core_ids": [ledger_core_id],
            "selection_rationale": "the source is the single full-text core paper in the declared scope",
            "candidates": [
                {
                    "id": ledger_core_id,
                    "identity_status": "resolved",
                    "canonical_identity": {
                        "canonical_id": ledger_core_id,
                        "title": "Source-grounded example paper",
                        "authors": ["A. Example"],
                        "year": 2026,
                        "url": f"https://catalog.example/records/{ledger_core_token}",
                        "aliases": [f"provider:registry:{ledger_core_token}"],
                        "provenance": {
                            "kind": "citation_triangulation",
                            "provider": "citation-triangulation",
                            "record_ref": core_record_ref,
                            "record_sha256": core_record_hash,
                        },
                    },
                    "disposition": "core",
                    "rationale": "selected core source",
                    "discovered_from": [
                        {"kind": "search", "source_id": "catalog-query-1", "locator": "page 1, record 1"}
                    ],
                },
                {
                    "id": "doi:10.1000/example",
                    "identity_status": "resolved",
                    "canonical_identity": {
                        "canonical_id": "doi:10.1000/example",
                        "title": "Cited example",
                        "authors": ["A. Example"],
                        "year": 2024,
                        "url": "https://doi.org/10.1000/example",
                        "aliases": [],
                        "provenance": {
                            "kind": "authoritative_retrieval",
                            "provider": "catalog",
                            "record_ref": cited_record_ref,
                            "record_sha256": cited_record_hash,
                        },
                    },
                    "disposition": "supporting",
                    "rationale": "reconciled bibliography candidate",
                    "discovered_from": [
                        {
                            "kind": "bibliography",
                            "source_id": ledger_core_id,
                            "locator": "References, entry 7",
                        }
                    ],
                },
            ],
        },
        "bibliography_reconciliation": {
            "core_sources": [
                {
                    "id": ledger_core_id,
                    "status": "reconciled",
                    "references_artifact_ref": raw_ref,
                    "references_extracted": 1,
                    "candidate_ids": ["doi:10.1000/example"],
                    "coverage_debt": [],
                }
            ]
        },
        "method_family_audit": {
            "status": "audited",
            "taxonomy": [
                {
                    "id": "integral-method",
                    "label": "Integral method",
                    "description": "Methods based on an integral representation",
                }
            ],
            "source_audits": [
                {
                    "source_id": ledger_core_id,
                    "paper_method_descriptions": [
                        {
                            "description": "The source evaluates the observable through an integral representation.",
                            "locator": "Method, paragraph 2",
                            "evidence_basis": "source_text",
                            "method_features": ["integral representation"],
                            "family_ids": ["integral-method"],
                            "disposition": "classified",
                        }
                    ],
                    "bibliography_candidate_screening": [
                        {
                            "candidate_id": "doi:10.1000/example",
                            "disposition": "method_bearing",
                            "locator": "Method, paragraph 3 and reference 7",
                            "evidence_basis": "source_text",
                            "rationale": "The source explicitly attributes a method construction to this reference.",
                            "description": "The source attributes an alternative integral construction to this reference.",
                            "method_features": ["alternative integral construction"],
                            "family_ids": ["integral-method"],
                            "method_disposition": "classified",
                        }
                    ],
                }
            ],
        },
        "citation_graph": {
            "seeds": [
                {
                    "id": ledger_core_id,
                    "references_checked": True,
                    "citations_checked": True,
                    "coverage_status": "saturated",
                    "gaps": [],
                }
            ]
        },
        "final_status": "saturated",
        "stop_reason": "bounded provider and citation expansion reached no new core papers",
    }
    ledger_path = tmp_path / "artifacts" / "literature" / "literature-ledger.json"
    ledger_path.write_text(json.dumps(ledger, indent=2) + "\n", encoding="utf-8")
    ledger_ref = _project_ref(ledger_path, tmp_path)

    survey = valid_survey()
    survey["papers"][0]["source_links"] = ["https://catalog.example/records/core-1"]
    survey["papers"][0]["identity_triangulation"] = {
        "verdict": "consistent",
        "providers": [
            {
                "provider": "catalog",
                "title": "Source-grounded example paper",
                "year": 2026,
                "identifier": "core-1",
            },
            {
                "provider": "registry",
                "title": "Source-grounded example paper",
                "year": 2026,
                "identifier": "record-1",
            },
        ],
    }
    survey["coverage"]["bibliography_reconciliation"]["artifact_ref"] = ledger_ref
    survey["coverage"]["method_family_audit"]["artifact_ref"] = ledger_ref
    survey["coverage"]["method_family_audit"]["cited_method_descriptions_audited"] = 1
    return survey, ledger_path


def test_valid_gate_passes():
    assert problems() == []


def test_saturated_gate_without_project_root_fails_closed() -> None:
    issues = gate.validate_gate(valid_survey(), valid_matrix(), REPORT)
    assert_problem_contains(issues, "project_root is required")


def test_bound_coverage_rejects_nonexistent_pinned_ledger(tmp_path: Path) -> None:
    survey, _ = _write_bound_ledger(tmp_path)
    missing = "project://artifacts/literature/missing.json#sha256:" + "0" * 64
    survey["coverage"]["bibliography_reconciliation"]["artifact_ref"] = missing
    survey["coverage"]["method_family_audit"]["artifact_ref"] = missing

    issues = gate.validate_gate(
        survey,
        valid_matrix(),
        REPORT,
        project_root=tmp_path,
    )

    assert_problem_contains(issues, "does not resolve")


def test_bound_coverage_rejects_stale_hash_and_path_escape(tmp_path: Path) -> None:
    survey, _ = _write_bound_ledger(tmp_path)
    stale = "project://artifacts/literature/literature-ledger.json#sha256:" + "0" * 64
    survey["coverage"]["bibliography_reconciliation"]["artifact_ref"] = stale
    survey["coverage"]["method_family_audit"]["artifact_ref"] = stale
    issues = gate.validate_gate(survey, valid_matrix(), REPORT, project_root=tmp_path)
    assert_problem_contains(issues, "pin")

    escaped = "project://../outside.json#sha256:" + "0" * 64
    survey["coverage"]["bibliography_reconciliation"]["artifact_ref"] = escaped
    survey["coverage"]["method_family_audit"]["artifact_ref"] = escaped
    issues = gate.validate_gate(survey, valid_matrix(), REPORT, project_root=tmp_path)
    assert_problem_contains(issues, "escapes")


def test_bound_coverage_rejects_cross_artifact_receipt_reuse(tmp_path: Path) -> None:
    survey, ledger_path = _write_bound_ledger(tmp_path)
    other = ledger_path.with_name("other-ledger.json")
    other.write_bytes(ledger_path.read_bytes())
    survey["coverage"]["method_family_audit"]["artifact_ref"] = _project_ref(other, tmp_path)

    issues = gate.validate_gate(survey, valid_matrix(), REPORT, project_root=tmp_path)

    assert_problem_contains(issues, "same combined ledger")


def test_bound_coverage_rejects_different_core_identity_set(tmp_path: Path) -> None:
    survey, _ = _write_bound_ledger(tmp_path, ledger_core_id="provider:catalog:other-core")

    issues = gate.validate_gate(survey, valid_matrix(), REPORT, project_root=tmp_path)

    assert_problem_contains(issues, "core identity set")


def test_bound_coverage_recomputes_summary_instead_of_trusting_counts(tmp_path: Path) -> None:
    survey, _ = _write_bound_ledger(tmp_path)
    survey["coverage"]["bibliography_reconciliation"]["candidates_total"] = 99
    survey["coverage"]["method_family_audit"]["cited_method_descriptions_audited"] = 99

    issues = gate.validate_gate(survey, valid_matrix(), REPORT, project_root=tmp_path)

    assert_problem_contains(issues, "does not match detailed ledger")


def test_bound_coverage_rejects_global_candidate_debt_and_unselected_core(tmp_path: Path) -> None:
    survey, ledger_path = _write_bound_ledger(tmp_path)
    ledger = json.loads(ledger_path.read_text(encoding="utf-8"))
    ledger["candidate_pool"]["candidates"].append(
        {
            "id": "provider:catalog:unresolved-search-hit",
            "identity_status": "unresolved",
            "disposition": "coverage_debt",
            "rationale": "search result identity remains unresolved",
        }
    )
    ledger["candidate_pool"]["total_candidates"] = 3
    ledger_path.write_text(json.dumps(ledger, indent=2) + "\n", encoding="utf-8")
    _repin_ledger(survey, ledger_path, tmp_path)

    issues = gate.validate_gate(survey, valid_matrix(), REPORT, project_root=tmp_path)
    assert_problem_contains(issues, "cannot retain unresolved/coverage-debt candidates")

    survey, ledger_path = _write_bound_ledger(tmp_path)
    ledger = json.loads(ledger_path.read_text(encoding="utf-8"))
    ledger["candidate_pool"]["candidates"][1]["disposition"] = "core"
    ledger_path.write_text(json.dumps(ledger, indent=2) + "\n", encoding="utf-8")
    _repin_ledger(survey, ledger_path, tmp_path)

    issues = gate.validate_gate(survey, valid_matrix(), REPORT, project_root=tmp_path)
    assert_problem_contains(issues, "core-disposition candidate")


def test_bound_coverage_deduplicates_doi_and_provider_keys_from_pinned_records(tmp_path: Path) -> None:
    survey, ledger_path = _write_bound_ledger(tmp_path)
    record_ref, record_hash = _write_identity_record(
        tmp_path,
        "cited-provider-representation",
        canonical_id="provider:catalog:cited-example",
        title="Cited example",
        authors=["A. Example"],
        year=2024,
        providers=[("catalog", "cited-example")],
        doi="10.1000/example",
    )
    ledger = json.loads(ledger_path.read_text(encoding="utf-8"))
    ledger["candidate_pool"]["candidates"].append(
        {
            "id": "provider:catalog:cited-example",
            "identity_status": "resolved",
            "canonical_identity": {
                "canonical_id": "provider:catalog:cited-example",
                "title": "Cited example",
                "authors": ["A. Example"],
                "year": 2024,
                "url": "https://catalog.example/records/unproven-display",
                "aliases": [],
                "provenance": {
                    "kind": "authoritative_retrieval",
                    "provider": "catalog",
                    "record_ref": record_ref,
                    "record_sha256": record_hash,
                },
            },
            "disposition": "supporting",
            "rationale": "second representation of an already archived work",
            "discovered_from": [
                {"kind": "search", "source_id": "catalog-query-2", "locator": "page 1, record 2"}
            ],
        }
    )
    ledger["candidate_pool"]["total_candidates"] = 3
    ledger_path.write_text(json.dumps(ledger, indent=2) + "\n", encoding="utf-8")
    survey["coverage"]["bibliography_reconciliation"]["candidates_total"] = 3
    survey["coverage"]["bibliography_reconciliation"]["candidates_dispositioned"] = 3
    _repin_ledger(survey, ledger_path, tmp_path)

    issues = gate.validate_gate(survey, valid_matrix(), REPORT, project_root=tmp_path)

    assert_problem_contains(issues, "merge aliases")


def test_bound_coverage_rejects_unresolved_canonical_provenance_record(tmp_path: Path) -> None:
    survey, ledger_path = _write_bound_ledger(tmp_path)
    ledger = json.loads(ledger_path.read_text(encoding="utf-8"))
    provenance = ledger["candidate_pool"]["candidates"][0]["canonical_identity"]["provenance"]
    provenance["record_ref"] = "project://artifacts/identity/missing.json#sha256:" + "0" * 64
    provenance["record_sha256"] = "sha256:" + "0" * 64
    ledger_path.write_text(json.dumps(ledger, indent=2) + "\n", encoding="utf-8")
    _repin_ledger(survey, ledger_path, tmp_path)

    issues = gate.validate_gate(survey, valid_matrix(), REPORT, project_root=tmp_path)

    assert_problem_contains(issues, "provenance.record_ref does not resolve")


def test_bound_coverage_rejects_remote_or_swapped_identity_provenance(tmp_path: Path) -> None:
    survey, ledger_path = _write_bound_ledger(tmp_path)
    ledger = json.loads(ledger_path.read_text(encoding="utf-8"))
    provenance = ledger["candidate_pool"]["candidates"][1]["canonical_identity"]["provenance"]
    provenance["record_ref"] = "https://invalid.example/metadata#sha256:" + "b" * 64
    provenance["record_sha256"] = "sha256:" + "b" * 64
    ledger_path.write_text(json.dumps(ledger, indent=2) + "\n", encoding="utf-8")
    _repin_ledger(survey, ledger_path, tmp_path)

    issues = gate.validate_gate(survey, valid_matrix(), REPORT, project_root=tmp_path)
    assert_problem_contains(issues, "must be an exact pinned project JSON reference")

    survey, ledger_path = _write_bound_ledger(tmp_path)
    identity_path = tmp_path / "artifacts" / "identity" / "cited-example.json"
    identity = json.loads(identity_path.read_text(encoding="utf-8"))
    identity["providers"][0]["title"] = "Metadata for a different work"
    identity_path.write_text(json.dumps(identity, indent=2) + "\n", encoding="utf-8")
    identity_ref = _project_ref(identity_path, tmp_path)
    ledger = json.loads(ledger_path.read_text(encoding="utf-8"))
    provenance = ledger["candidate_pool"]["candidates"][1]["canonical_identity"]["provenance"]
    provenance["record_ref"] = identity_ref
    provenance["record_sha256"] = "sha256:" + identity_ref.rsplit("sha256:", 1)[1]
    ledger_path.write_text(json.dumps(ledger, indent=2) + "\n", encoding="utf-8")
    _repin_ledger(survey, ledger_path, tmp_path)

    issues = gate.validate_gate(survey, valid_matrix(), REPORT, project_root=tmp_path)
    assert_problem_contains(issues, "title does not match canonical candidate metadata")


def test_bound_coverage_rejects_title_year_only_negative_method_screening(tmp_path: Path) -> None:
    survey, ledger_path = _write_bound_ledger(tmp_path)
    ledger = json.loads(ledger_path.read_text(encoding="utf-8"))
    screening = ledger["method_family_audit"]["source_audits"][0]["bibliography_candidate_screening"][0]
    screening.clear()
    screening.update(
        {
            "candidate_id": "doi:10.1000/example",
            "disposition": "not_method_bearing",
            "locator": "catalog title and publication year",
            "evidence_basis": "title_year_query",
            "rationale": "title and year do not advertise a method",
        }
    )
    ledger_path.write_text(json.dumps(ledger, indent=2) + "\n", encoding="utf-8")
    _repin_ledger(survey, ledger_path, tmp_path)

    issues = gate.validate_gate(survey, valid_matrix(), REPORT, project_root=tmp_path)

    assert_problem_contains(issues, "evidence_basis must be 'source_text'")


def test_bound_coverage_rejects_bibliography_discovery_missing_from_pinned_manifest(tmp_path: Path) -> None:
    survey, ledger_path = _write_bound_ledger(tmp_path)
    ledger = json.loads(ledger_path.read_text(encoding="utf-8"))
    ledger["candidate_pool"]["candidates"][1]["discovered_from"].append(
        {
            "kind": "bibliography",
            "source_id": "provider:catalog:core-1",
            "locator": "References, entry 8",
        }
    )
    ledger_path.write_text(json.dumps(ledger, indent=2) + "\n", encoding="utf-8")
    _repin_ledger(survey, ledger_path, tmp_path)

    issues = gate.validate_gate(survey, valid_matrix(), REPORT, project_root=tmp_path)

    assert_problem_contains(issues, "bibliography discovery claims do not match the pinned raw manifest")

    survey, ledger_path = _write_bound_ledger(tmp_path)
    ledger = json.loads(ledger_path.read_text(encoding="utf-8"))
    ledger["candidate_pool"]["candidates"][1]["discovered_from"][0]["source_id"] = (
        "provider:catalog:not-a-core-source"
    )
    ledger_path.write_text(json.dumps(ledger, indent=2) + "\n", encoding="utf-8")
    _repin_ledger(survey, ledger_path, tmp_path)

    issues = gate.validate_gate(survey, valid_matrix(), REPORT, project_root=tmp_path)

    assert_problem_contains(issues, "is not a selected core source")


def test_bound_coverage_rejects_missing_bounded_retrieval_accounting(tmp_path: Path) -> None:
    survey, ledger_path = _write_bound_ledger(tmp_path)
    ledger = json.loads(ledger_path.read_text(encoding="utf-8"))
    ledger.pop("providers")
    ledger_path.write_text(json.dumps(ledger, indent=2) + "\n", encoding="utf-8")
    _repin_ledger(survey, ledger_path, tmp_path)

    issues = gate.validate_gate(survey, valid_matrix(), REPORT, project_root=tmp_path)

    assert_problem_contains(issues, "providers must include bounded query/page or cursor accounting")


def test_bound_coverage_rejects_unsearched_declared_query(tmp_path: Path) -> None:
    survey, ledger_path = _write_bound_ledger(tmp_path)
    ledger = json.loads(ledger_path.read_text(encoding="utf-8"))
    ledger["providers"]["catalog"]["queries"].insert(0, "broad historical query")
    ledger_path.write_text(json.dumps(ledger, indent=2) + "\n", encoding="utf-8")
    _repin_ledger(survey, ledger_path, tmp_path)

    issues = gate.validate_gate(survey, valid_matrix(), REPORT, project_root=tmp_path)

    assert_problem_contains(issues, "every declared query must have request_log coverage")


def test_bound_coverage_does_not_join_core_identity_through_unproven_display_url(tmp_path: Path) -> None:
    survey, ledger_path = _write_bound_ledger(tmp_path)
    identity_path = tmp_path / "artifacts" / "identity" / "different-core.json"
    identity_path.write_text(
        json.dumps(
            {
                "citation_key": "doi:10.2000/different",
                "providers": [
                    {
                        "provider": "registry",
                        "title": "Source-grounded example paper",
                        "authors": ["A. Example"],
                        "year": 2026,
                        "doi": "10.2000/different",
                        "venue": None,
                        "identifier": "different-core",
                    }
                ],
            },
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )
    identity_ref = _project_ref(identity_path, tmp_path)
    ledger = json.loads(ledger_path.read_text(encoding="utf-8"))
    canonical = ledger["candidate_pool"]["candidates"][0]["canonical_identity"]
    canonical["canonical_id"] = "doi:10.2000/different"
    canonical["aliases"] = []
    canonical["provenance"] = {
        "kind": "authoritative_retrieval",
        "provider": "registry",
        "record_ref": identity_ref,
        "record_sha256": "sha256:" + identity_ref.rsplit("sha256:", 1)[1],
    }
    ledger_path.write_text(json.dumps(ledger, indent=2) + "\n", encoding="utf-8")
    _repin_ledger(survey, ledger_path, tmp_path)

    issues = gate.validate_gate(survey, valid_matrix(), REPORT, project_root=tmp_path)

    assert_problem_contains(issues, "core identity set")


def test_saturated_stale_matrix_cannot_enter_current_writeback() -> None:
    matrix = valid_matrix()
    matrix["posterior_status"] = "stale"
    matrix["allocation_eligible"] = False
    assert_problem_contains(problems(matrix), "posterior_status stale")


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


def test_saturated_survey_requires_bibliography_reconciliation_closure():
    survey = valid_survey()
    survey["coverage"]["bibliography_reconciliation"]["status"] = "coverage_debt"
    survey["coverage"]["bibliography_reconciliation"]["unresolved_candidates"] = 1
    issues = problems(survey=survey)
    assert_problem_contains(issues, "requires bibliography_reconciliation.status=reconciled")
    assert_problem_contains(issues, "cannot retain unresolved or coverage-debt bibliography candidates")


def test_saturated_survey_requires_method_family_audit_closure():
    survey = valid_survey()
    survey["coverage"]["method_family_audit"]["status"] = "coverage_debt"
    survey["coverage"]["method_family_audit"]["unresolved_method_family_gaps"] = 1
    issues = problems(survey=survey)
    assert_problem_contains(issues, "requires method_family_audit.status=audited")
    assert_problem_contains(issues, "cannot retain unresolved method-family gaps")


def test_saturated_survey_requires_source_method_evidence_for_each_core_source():
    survey = valid_survey()
    survey["coverage"]["method_family_audit"]["source_method_descriptions_audited"] = 0
    issues = gate.validate_gate(survey, valid_matrix(), REPORT, allow_exploratory=False)
    assert_problem_contains(issues, "source-text method evidence for every audited core source")


def test_saturated_survey_rejects_boolean_coverage_counters():
    survey = valid_survey()
    survey["coverage"]["core_total"] = True
    survey["coverage"]["bibliography_reconciliation"]["core_sources_total"] = True
    for field in (
        "core_sources_reconciled",
        "candidates_total",
        "candidates_dispositioned",
        "unresolved_candidates",
        "coverage_debt_candidates",
    ):
        survey["coverage"]["bibliography_reconciliation"][field] = True
    for field in (
        "core_sources_audited",
        "taxonomy_families",
        "source_method_descriptions_audited",
        "cited_method_descriptions_audited",
        "unresolved_method_family_gaps",
    ):
        survey["coverage"]["method_family_audit"][field] = True
    survey["coverage"]["method_family_audit"]["core_sources_total"] = True
    survey["coverage"]["saturation_evidence"][0]["round"] = True
    survey["coverage"]["saturation_evidence"][0]["expansion_candidates_screened"] = True

    issues = gate.validate_gate(survey, valid_matrix(), REPORT, allow_exploratory=False)

    assert_problem_contains(issues, "bibliography_reconciliation.candidates_total must be a non-negative integer")
    assert_problem_contains(issues, "method_family_audit.taxonomy_families must be a non-negative integer")
    assert_problem_contains(issues, "coverage.core_total must be a non-negative integer")
    assert_problem_contains(issues, "bibliography_reconciliation.core_sources_total must be a non-negative integer")
    assert_problem_contains(issues, "method_family_audit.core_sources_total must be a non-negative integer")
    assert_problem_contains(issues, ".round must be a positive integer")
    assert_problem_contains(issues, "expansion_candidates_screened must be a positive integer")


def test_saturated_survey_reports_malformed_method_counters_without_crashing():
    survey = valid_survey()
    survey["coverage"]["method_family_audit"]["taxonomy_families"] = "bad"
    survey["coverage"]["method_family_audit"]["source_method_descriptions_audited"] = "bad"

    issues = gate.validate_gate(survey, valid_matrix(), REPORT, allow_exploratory=False)

    assert_problem_contains(issues, "method_family_audit.taxonomy_families must be a non-negative integer")
    assert_problem_contains(issues, "method_family_audit.source_method_descriptions_audited must be a non-negative integer")


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


def tension_ir(*pairs):
    tension_id = "github:fixture::tension_resolution"
    return {
        "knowledges": [
            {
                "id": tension_id,
                "label": "tension_resolution",
                "type": "claim",
            }
        ],
        "strategies": [
            {
                "type": "infer",
                "premises": [tension_id],
                "conclusion": f"github:fixture::evidence_{index}",
                "conditional_probabilities": [p_nh, p_h],
                "steps": [
                    {
                        "reasoning": "reader_reasoning: An executed check demonstrates the scoped "
                        "resolution. resolution_evidence: discriminating_test. "
                        "anchor: fixture"
                    }
                ],
            }
            for index, (p_h, p_nh) in enumerate(pairs)
        ],
    }


def test_tension_grade_must_match_compiled_gaia_likelihood() -> None:
    matrix = valid_matrix()
    matrix["tension_resolution"] = {"grade": "weakest"}
    issues = gate.validate_tension_resolution_consistency(
        matrix, tension_ir((0.9, 0.09))
    )
    assert_problem_contains(issues, "does not match compiled Gaia")


def test_multiple_tension_updates_require_exact_grade_multiset() -> None:
    matrix = valid_matrix()
    matrix["tension_resolution"] = {"grade": "substantial"}
    ir = tension_ir((0.75, 0.25), (0.9, 0.09))
    issues = gate.validate_tension_resolution_consistency(matrix, ir)
    assert_problem_contains(issues, "raising_likelihood_grades")

    matrix["tension_resolution"]["raising_likelihood_grades"] = [
        "weakest",
        "substantial",
    ]
    assert gate.validate_tension_resolution_consistency(matrix, ir) == []


def test_tension_existence_or_plan_cannot_raise_resolution_at_write_gate() -> None:
    matrix = valid_matrix()
    matrix["tension_resolution"] = {"grade": "substantial"}
    ir = tension_ir((0.9, 0.09))
    ir["strategies"][0]["steps"][0]["reasoning"] = (
        "reader_reasoning: The observation anchors the existence of an open tension and the idea "
        "proposes a future check. anchor: fixture"
    )
    issues = gate.validate_tension_resolution_consistency(matrix, ir)
    assert_problem_contains(issues, "tension existence or a plan alone is insufficient")


def test_null_reasoning_is_treated_as_missing_resolution_evidence() -> None:
    matrix = valid_matrix()
    matrix["tension_resolution"] = {"grade": "substantial"}
    ir = tension_ir((0.9, 0.09))
    ir["strategies"][0]["steps"][0]["reasoning"] = None
    issues = gate.validate_tension_resolution_consistency(matrix, ir)
    assert_problem_contains(issues, "idea-specific pre-anchor clause")


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
