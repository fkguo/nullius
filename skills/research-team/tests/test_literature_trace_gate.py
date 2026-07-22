import json
import subprocess
from pathlib import Path


REPO = Path(__file__).resolve().parents[3]
GATE = REPO / "skills" / "research-team" / "scripts" / "gates" / "check_literature_trace.py"
FETCH = REPO / "skills" / "research-team" / "scripts" / "bin" / "literature_fetch.py"


def _write_project(tmp_path: Path, *, stage: str = "development", require_reading_evidence: bool = False) -> None:
    (tmp_path / ".git").mkdir()
    (tmp_path / "knowledge_base" / "methodology_traces").mkdir(parents=True)
    (tmp_path / "research_contract.md").write_text("# Contract\n", encoding="utf-8")
    (tmp_path / "research_team_config.json").write_text(
        json.dumps(
            {
                "version": 1,
                "mode": "literature_review",
                "project_stage": stage,
                "features": {
                    "references_gate": True,
                    "knowledge_layers_gate": True,
                    "literature_trace_gate": True,
                },
                "knowledge_layers": {
                    "require_literature_reading_evidence": require_reading_evidence,
                },
            },
            indent=2,
        ),
        encoding="utf-8",
    )


def _write_trace(tmp_path: Path, *, rows: int = 1) -> None:
    lines = [
        "# literature_queries.md",
        "",
        "| Timestamp (UTC) | Source | Query | Filters / criteria | Shortlist (links) | Decision / notes | Local KB notes |",
        "|---|---|---|---|---|---|---|",
    ]
    for i in range(rows):
        lines.append(
            f"| 2026-05-15T00:00:0{i}Z | INSPIRE | test query {i} | page_size=50 | core-{i} | selected | note-{i} |"
        )
    (tmp_path / "knowledge_base" / "methodology_traces" / "literature_queries.md").write_text(
        "\n".join(lines) + "\n",
        encoding="utf-8",
    )


def _saturated_doc(*, final_status: str = "saturated", metadata_only: list[str] | None = None) -> dict:
    return {
        "schema_version": 1,
        "topic": "test",
        "run_id": "RUN-1",
        "generated_at": "2026-05-15T00:00:00Z",
        "providers": {
            "inspire": {
                "status": "queried",
                "queries": ["test query"],
                "returned_count": 50,
                "total_count_unknown": True,
                "stop_reason": "pagination reached stable core set",
            },
            "arxiv": {"status": "queried", "queries": ["test query"], "returned_count": 12, "total_count": 12, "stop_reason": "exhausted"},
            "openalex": {"status": "queried", "queries": ["test query"], "returned_count": 30, "total_count_unknown": True, "stop_reason": "no new core papers"},
            "web": {"status": "not_applicable", "reason": "no unstable web-only citations used"},
        },
        "candidate_pool": {
            "artifact": "artifacts/literature/candidates.jsonl",
            "total_candidates": 2,
            "selected_core_ids": ["inspire:1"],
            "selection_rationale": "core anchor selected after provider and citation expansion",
            "candidates": [
                {
                    "id": "inspire:1",
                    "identity_status": "resolved",
                    "stable_ids": ["provider:1"],
                    "disposition": "core",
                    "rationale": "selected core source",
                    "discovered_from": [
                        {"kind": "search", "source_id": "query:1", "locator": "page 1, record 1"}
                    ],
                },
                {
                    "id": "doi:10.1000/example",
                    "identity_status": "resolved",
                    "stable_ids": ["doi:10.1000/example"],
                    "disposition": "supporting",
                    "rationale": "method-bearing reference cited by the core source",
                    "discovered_from": [
                        {
                            "kind": "bibliography",
                            "source_id": "inspire:1",
                            "locator": "References, entry 7",
                        }
                    ],
                },
            ],
        },
        "bibliography_reconciliation": {
            "core_sources": [
                {
                    "id": "inspire:1",
                    "status": "reconciled",
                    "references_artifact": "artifacts/literature/inspire-1-bibliography.json",
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
                    "source_id": "inspire:1",
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
                    "cited_method_descriptions": [
                        {
                            "candidate_id": "doi:10.1000/example",
                            "description": "The source attributes an alternative integral construction to this reference.",
                            "locator": "Method, paragraph 3 and reference 7",
                            "evidence_basis": "source_text",
                            "method_features": ["alternative integral construction"],
                            "family_ids": ["integral-method"],
                            "disposition": "classified",
                        }
                    ],
                    "cited_method_scan_complete": True,
                }
            ],
        },
        "citation_graph": {
            "seeds": [
                {
                    "id": "inspire:1",
                    "provider": "inspire",
                    "references_checked": True,
                    "citations_checked": True,
                    "coverage_status": "saturated",
                    "artifacts": {
                        "references": "artifacts/literature/inspire-1-references.json",
                        "citations": "artifacts/literature/inspire-1-citations.json",
                    },
                    "gaps": [],
                }
            ]
        },
        "source_first_reading": {
            "notes": ["knowledge_base/literature/inspire-1.md"],
            "metadata_only_not_evidence_ready": metadata_only or [],
        },
        "final_status": final_status,
        "stop_reason": "no new core papers after citation/reference expansion",
    }


def _write_saturation(tmp_path: Path, data: dict) -> None:
    for source in data.get("bibliography_reconciliation", {}).get("core_sources", []):
        artifact = str(source.get("references_artifact") or "").strip()
        if artifact:
            artifact_path = Path(artifact)
            if not artifact_path.is_absolute():
                artifact_path = tmp_path / artifact_path
            artifact_path.parent.mkdir(parents=True, exist_ok=True)
            references = []
            for candidate_id in source.get("candidate_ids", []):
                candidate = next(
                    item
                    for item in data.get("candidate_pool", {}).get("candidates", [])
                    if item.get("id") == candidate_id
                )
                discovery = next(
                    item
                    for item in candidate.get("discovered_from", [])
                    if item.get("kind") == "bibliography" and item.get("source_id") == source.get("id")
                )
                references.append(
                    {
                        "raw_text": f"Raw bibliographic entry for {candidate_id}",
                        "locator": discovery["locator"],
                        "candidate_id": candidate_id,
                    }
                )
            artifact_path.write_text(
                json.dumps({"source_id": source.get("id"), "references": references}, indent=2) + "\n",
                encoding="utf-8",
            )
    (tmp_path / "knowledge_base" / "methodology_traces" / "literature_saturation.json").write_text(
        json.dumps(data, indent=2),
        encoding="utf-8",
    )


def _run_gate(tmp_path: Path) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["python3", str(GATE), "--notes", str(tmp_path / "research_contract.md")],
        cwd=tmp_path,
        text=True,
        capture_output=True,
        check=False,
    )


def test_gate_fails_without_saturation_artifact(tmp_path: Path) -> None:
    _write_project(tmp_path)
    _write_trace(tmp_path)

    result = _run_gate(tmp_path)

    assert result.returncode == 1
    assert "Missing literature saturation artifact" in result.stdout


def test_gate_fails_when_core_paper_lacks_citations(tmp_path: Path) -> None:
    _write_project(tmp_path)
    _write_trace(tmp_path, rows=2)
    doc = _saturated_doc()
    doc["citation_graph"]["seeds"][0]["citations_checked"] = False
    _write_saturation(tmp_path, doc)

    result = _run_gate(tmp_path)

    assert result.returncode == 1
    assert "citations_checked must be true" in result.stdout


def test_gate_fails_closed_when_core_bibliography_is_unreconciled(tmp_path: Path) -> None:
    _write_project(tmp_path)
    _write_trace(tmp_path)
    doc = _saturated_doc()
    core = doc["bibliography_reconciliation"]["core_sources"][0]
    core["status"] = "coverage_debt"
    core["coverage_debt"] = ["one raw reference is not yet resolved"]
    _write_saturation(tmp_path, doc)

    result = _run_gate(tmp_path)

    assert result.returncode == 1
    assert "requires reconciled bibliographies" in result.stdout


def test_gate_fails_closed_when_raw_bibliography_artifact_is_missing(tmp_path: Path) -> None:
    _write_project(tmp_path)
    _write_trace(tmp_path)
    doc = _saturated_doc()
    _write_saturation(tmp_path, doc)
    artifact = tmp_path / doc["bibliography_reconciliation"]["core_sources"][0]["references_artifact"]
    artifact.unlink()

    result = _run_gate(tmp_path)

    assert result.returncode == 1
    assert "references_artifact does not exist" in result.stdout


def test_gate_fails_closed_when_raw_bibliography_manifest_is_unstructured_or_count_mismatched(tmp_path: Path) -> None:
    _write_project(tmp_path)
    _write_trace(tmp_path)
    doc = _saturated_doc()
    _write_saturation(tmp_path, doc)
    artifact = tmp_path / doc["bibliography_reconciliation"]["core_sources"][0]["references_artifact"]
    artifact.write_text("{}\n", encoding="utf-8")

    result = _run_gate(tmp_path)
    assert result.returncode == 1
    assert "references_artifact.source_id must equal" in result.stdout
    assert "references_artifact.references: expected array" in result.stdout

    artifact.write_text(
        json.dumps({"source_id": "inspire:1", "references": []}) + "\n",
        encoding="utf-8",
    )
    result = _run_gate(tmp_path)
    assert result.returncode == 1
    assert "references_extracted must equal the raw references manifest count" in result.stdout


def test_gate_allows_multiple_raw_aliases_to_map_to_one_normalized_candidate(tmp_path: Path) -> None:
    _write_project(tmp_path)
    _write_trace(tmp_path)
    doc = _saturated_doc()
    source = doc["bibliography_reconciliation"]["core_sources"][0]
    source["references_extracted"] = 2
    candidate = doc["candidate_pool"]["candidates"][1]
    candidate["discovered_from"].append(
        {"kind": "bibliography", "source_id": "inspire:1", "locator": "References, entry 8"}
    )
    _write_saturation(tmp_path, doc)
    artifact = tmp_path / source["references_artifact"]
    manifest = json.loads(artifact.read_text(encoding="utf-8"))
    manifest["references"].append(
        {
            "raw_text": "Alternate raw entry for the same work",
            "locator": "References, entry 8",
            "candidate_id": "doi:10.1000/example",
        }
    )
    artifact.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")

    result = _run_gate(tmp_path)

    assert result.returncode == 0


def test_gate_fails_closed_on_unresolved_or_undispositioned_candidate(tmp_path: Path) -> None:
    _write_project(tmp_path)
    _write_trace(tmp_path)
    unresolved = _saturated_doc()
    candidate = unresolved["candidate_pool"]["candidates"][1]
    candidate["identity_status"] = "unresolved"
    candidate["stable_ids"] = []
    candidate["disposition"] = "coverage_debt"
    _write_saturation(tmp_path, unresolved)

    result = _run_gate(tmp_path)
    assert result.returncode == 1
    assert "cannot retain unresolved/coverage-debt candidates" in result.stdout

    undispositioned = _saturated_doc()
    undispositioned["candidate_pool"]["candidates"][1].pop("disposition")
    _write_saturation(tmp_path, undispositioned)
    result = _run_gate(tmp_path)
    assert result.returncode == 1
    assert ".disposition must be one of" in result.stdout


def test_gate_rejects_unselected_core_disposition_and_duplicate_stable_identity(tmp_path: Path) -> None:
    _write_project(tmp_path)
    _write_trace(tmp_path)
    extra_core = _saturated_doc()
    extra_core["candidate_pool"]["candidates"][1]["disposition"] = "core"
    _write_saturation(tmp_path, extra_core)

    result = _run_gate(tmp_path)
    assert result.returncode == 1
    assert "core-disposition candidate(s) absent from selected_core_ids" in result.stdout

    duplicate_identity = _saturated_doc()
    duplicate_identity["candidate_pool"]["candidates"][1]["stable_ids"] = ["provider:1"]
    _write_saturation(tmp_path, duplicate_identity)

    result = _run_gate(tmp_path)
    assert result.returncode == 1
    assert "merge aliases into one normalized candidate record" in result.stdout


def test_gate_fails_closed_when_method_family_scan_is_not_complete(tmp_path: Path) -> None:
    _write_project(tmp_path)
    _write_trace(tmp_path)
    doc = _saturated_doc()
    doc["method_family_audit"]["source_audits"][0]["cited_method_scan_complete"] = False
    _write_saturation(tmp_path, doc)

    result = _run_gate(tmp_path)

    assert result.returncode == 1
    assert "cited_method_scan_complete must be true before saturation" in result.stdout


def test_gate_rejects_saturated_status_with_unchecked_graph_coverage(tmp_path: Path) -> None:
    _write_project(tmp_path)
    _write_trace(tmp_path)
    doc = _saturated_doc()
    seed = doc["citation_graph"]["seeds"][0]
    seed["references_checked"] = False
    seed["citations_checked"] = False
    seed["coverage_status"] = "not_covered"
    seed["gaps"] = ["coverage unavailable"]
    _write_saturation(tmp_path, doc)

    result = _run_gate(tmp_path)

    assert result.returncode == 1
    assert "coverage_status must be 'saturated'" in result.stdout
    assert "references_checked must be true when final_status='saturated'" in result.stdout
    assert "citations_checked must be true when final_status='saturated'" in result.stdout


def test_gate_rejects_string_false_for_graph_check_booleans(tmp_path: Path) -> None:
    _write_project(tmp_path)
    _write_trace(tmp_path)
    doc = _saturated_doc()
    seed = doc["citation_graph"]["seeds"][0]
    seed["references_checked"] = "false"
    seed["citations_checked"] = "false"
    _write_saturation(tmp_path, doc)

    result = _run_gate(tmp_path)

    assert result.returncode == 1
    assert "references_checked must be true when final_status='saturated'" in result.stdout
    assert "citations_checked must be true when final_status='saturated'" in result.stdout


def test_gate_requires_source_local_method_descriptions_not_only_taxonomy_labels(tmp_path: Path) -> None:
    _write_project(tmp_path)
    _write_trace(tmp_path)
    doc = _saturated_doc()
    doc["method_family_audit"]["source_audits"][0]["paper_method_descriptions"][0]["description"] = ""
    _write_saturation(tmp_path, doc)

    result = _run_gate(tmp_path)

    assert result.returncode == 1
    assert "must describe the method, not only title/year metadata" in result.stdout


def test_gate_rejects_title_year_only_method_metadata(tmp_path: Path) -> None:
    _write_project(tmp_path)
    _write_trace(tmp_path)
    doc = _saturated_doc()
    method = doc["method_family_audit"]["source_audits"][0]["paper_method_descriptions"][0]
    method["description"] = "Example Paper (2020)"
    method["locator"] = "title and publication year"
    _write_saturation(tmp_path, doc)

    result = _run_gate(tmp_path)

    assert result.returncode == 1
    assert "description must contain at least one recorded method feature" in result.stdout

    missing_source_evidence = _saturated_doc()
    method = missing_source_evidence["method_family_audit"]["source_audits"][0]["paper_method_descriptions"][0]
    method.pop("evidence_basis")
    method["method_features"] = []
    _write_saturation(tmp_path, missing_source_evidence)
    result = _run_gate(tmp_path)
    assert result.returncode == 1
    assert "title/year metadata alone is insufficient" in result.stdout
    assert "method_features must record at least one" in result.stdout


def test_gate_rejects_incomplete_coverage_outside_exploration(tmp_path: Path) -> None:
    _write_project(tmp_path, stage="development")
    _write_trace(tmp_path)
    _write_saturation(tmp_path, _saturated_doc(final_status="coverage_incomplete"))

    result = _run_gate(tmp_path)

    assert result.returncode == 1
    assert "coverage_incomplete is only allowed as exploration debt" in result.stdout


def test_gate_allows_incomplete_coverage_as_exploration_debt(tmp_path: Path) -> None:
    _write_project(tmp_path, stage="exploration")
    _write_trace(tmp_path)
    _write_saturation(tmp_path, _saturated_doc(final_status="coverage_incomplete"))

    result = _run_gate(tmp_path)

    assert result.returncode == 0
    assert "final_status: coverage_incomplete" in result.stdout


def test_gate_allows_explicit_reconciliation_and_method_debt_only_in_exploration(tmp_path: Path) -> None:
    _write_project(tmp_path, stage="exploration")
    _write_trace(tmp_path)
    doc = _saturated_doc(final_status="coverage_incomplete")
    candidate = doc["candidate_pool"]["candidates"][1]
    candidate["identity_status"] = "unresolved"
    candidate["stable_ids"] = []
    candidate["disposition"] = "coverage_debt"
    reconciliation = doc["bibliography_reconciliation"]["core_sources"][0]
    reconciliation["status"] = "coverage_debt"
    reconciliation["coverage_debt"] = ["candidate identity unresolved"]
    doc["method_family_audit"]["status"] = "coverage_debt"
    doc["method_family_audit"]["source_audits"][0]["cited_method_scan_complete"] = False
    _write_saturation(tmp_path, doc)

    result = _run_gate(tmp_path)

    assert result.returncode == 0
    assert "final_status: coverage_incomplete" in result.stdout


def test_gate_rejects_metadata_only_notes_when_reading_evidence_required(tmp_path: Path) -> None:
    _write_project(tmp_path, require_reading_evidence=True)
    _write_trace(tmp_path)
    _write_saturation(tmp_path, _saturated_doc(metadata_only=["knowledge_base/literature/meta.md"]))

    result = _run_gate(tmp_path)

    assert result.returncode == 1
    assert "metadata-only literature notes cannot satisfy" in result.stdout


def test_gate_passes_saturated_provider_and_graph_artifact(tmp_path: Path) -> None:
    _write_project(tmp_path, require_reading_evidence=True)
    _write_trace(tmp_path, rows=2)
    _write_saturation(tmp_path, _saturated_doc())

    result = _run_gate(tmp_path)

    assert result.returncode == 0
    assert "[ok] literature trace gate passed" in result.stdout
    assert "final_status: saturated" in result.stdout


def test_literature_fetch_saturation_helpers_preserve_explicit_reconciliation_sections(tmp_path: Path) -> None:
    _write_project(tmp_path)
    _write_trace(tmp_path)
    sat = tmp_path / "knowledge_base" / "methodology_traces" / "literature_saturation.json"

    commands = [
        ["saturation-init", "--topic", "test", "--run-id", "RUN-1", "--path", str(sat), "--force"],
        [
            "saturation-add-provider",
            "--provider",
            "inspire",
            "--status",
            "queried",
            "--query",
            "q1,q2",
            "--returned-count",
            "50",
            "--total-count-unknown",
            "--stop-reason",
            "stable core set",
            "--path",
            str(sat),
        ],
        [
            "saturation-set-candidate-pool",
            "--artifact",
            "artifacts/literature/candidates.jsonl",
            "--total-candidates",
            "50",
            "--selected-core-ids",
            "inspire:1",
            "--selection-rationale",
            "selected after expansion",
            "--path",
            str(sat),
        ],
        [
            "saturation-add-provider",
            "--provider",
            "arxiv",
            "--status",
            "not_applicable",
            "--reason",
            "INSPIRE record had no arXiv source requirement for this test",
            "--path",
            str(sat),
        ],
        [
            "saturation-add-provider",
            "--provider",
            "openalex",
            "--status",
            "not_applicable",
            "--reason",
            "cross-domain coverage not needed for this test",
            "--path",
            str(sat),
        ],
        [
            "saturation-add-provider",
            "--provider",
            "web",
            "--status",
            "not_applicable",
            "--reason",
            "no web-only sources used",
            "--path",
            str(sat),
        ],
        [
            "saturation-add-core",
            "--paper-id",
            "inspire:1",
            "--references-checked",
            "--citations-checked",
            "--coverage-status",
            "saturated",
            "--path",
            str(sat),
        ],
        [
            "saturation-finalize",
            "--final-status",
            "saturated",
            "--stop-reason",
            "no new core papers after expansion",
            "--path",
            str(sat),
        ],
    ]
    for command in commands:
        result = subprocess.run(["python3", str(FETCH), *command], cwd=tmp_path, text=True, capture_output=True, check=False)
        assert result.returncode == 0, result.stderr

    generated = json.loads(sat.read_text(encoding="utf-8"))
    closed = _saturated_doc()
    generated["candidate_pool"] = closed["candidate_pool"]
    generated["bibliography_reconciliation"] = closed["bibliography_reconciliation"]
    generated["method_family_audit"] = closed["method_family_audit"]
    _write_saturation(tmp_path, generated)

    result = _run_gate(tmp_path)

    assert result.returncode == 0
    assert "final_status: saturated" in result.stdout
