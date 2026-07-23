# CONTRACT-EXEMPT: CODE-01.1 sunset:2026-10-31 Pre-existing literature gate suite; this change adds bounded adversarial regressions.
import hashlib
import json
import subprocess
from pathlib import Path


REPO = Path(__file__).resolve().parents[3]
GATE = REPO / "skills" / "research-team" / "scripts" / "gates" / "check_literature_trace.py"
FETCH = REPO / "skills" / "research-team" / "scripts" / "bin" / "literature_fetch.py"


def _canonical_identity(
    canonical_id: str,
    *,
    title: str,
    year: int,
    url: str,
    aliases: list[str] | None = None,
) -> dict:
    return {
        "canonical_id": canonical_id,
        "title": title,
        "authors": ["A. Example"],
        "year": year,
        "url": url,
        "aliases": aliases or [],
        "provenance": {
            "kind": "authoritative_retrieval",
            "provider": "catalog",
            "record_ref": url,
            "record_sha256": "sha256:" + "a" * 64,
        },
    }


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
                "execution_bounds": {"max_requests": 1, "max_records": 50},
                "request_log": [
                    {
                        "query": "test query",
                        "page_or_cursor": "page:1",
                        "returned_count": 50,
                        "continuation": "exhausted",
                    }
                ],
                "stop_reason": "pagination reached stable core set",
            },
            "arxiv": {
                "status": "queried",
                "queries": ["test query"],
                "returned_count": 12,
                "total_count": 12,
                "execution_bounds": {"max_requests": 1, "max_records": 12},
                "request_log": [
                    {
                        "query": "test query",
                        "page_or_cursor": "cursor:end",
                        "returned_count": 12,
                        "continuation": "exhausted",
                    }
                ],
                "stop_reason": "exhausted",
            },
            "openalex": {
                "status": "queried",
                "queries": ["test query"],
                "returned_count": 30,
                "total_count_unknown": True,
                "execution_bounds": {"max_requests": 1, "max_records": 30},
                "request_log": [
                    {
                        "query": "test query",
                        "page_or_cursor": "cursor:bounded",
                        "returned_count": 30,
                        "continuation": "exhausted",
                    }
                ],
                "stop_reason": "no new core papers",
            },
            "web": {"status": "not_applicable", "reason": "no unstable web-only citations used"},
        },
        "candidate_pool": {
            "artifact": "artifacts/literature/candidates.jsonl",
            "total_candidates": 2,
            "selected_core_ids": ["provider:catalog:core-1"],
            "selection_rationale": "core anchor selected after provider and citation expansion",
            "candidates": [
                {
                    "id": "provider:catalog:core-1",
                    "identity_status": "resolved",
                    "canonical_identity": _canonical_identity(
                        "provider:catalog:core-1",
                        title="Core example",
                        year=2025,
                        url="https://catalog.example/records/core-1",
                        aliases=["provider:registry:record-1"],
                    ),
                    "disposition": "core",
                    "rationale": "selected core source",
                    "discovered_from": [
                        {"kind": "search", "source_id": "query:1", "locator": "page 1, record 1"}
                    ],
                },
                {
                    "id": "doi:10.1000/example",
                    "identity_status": "resolved",
                    "canonical_identity": _canonical_identity(
                        "doi:10.1000/example",
                        title="Cited example",
                        year=2024,
                        url="https://doi.org/10.1000/example",
                    ),
                    "disposition": "supporting",
                    "rationale": "method-bearing reference cited by the core source",
                    "discovered_from": [
                        {
                            "kind": "bibliography",
                            "source_id": "provider:catalog:core-1",
                            "locator": "References, entry 7",
                        }
                    ],
                },
            ],
        },
        "bibliography_reconciliation": {
            "core_sources": [
                {
                    "id": "provider:catalog:core-1",
                    "status": "reconciled",
                    "references_artifact_ref": "project://artifacts/literature/catalog-core-1-bibliography.json#sha256:" + "0" * 64,
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
                    "source_id": "provider:catalog:core-1",
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
                    "id": "provider:catalog:core-1",
                    "provider": "inspire",
                    "references_checked": True,
                    "citations_checked": True,
                    "coverage_status": "saturated",
                    "artifacts": {
                        "references": "artifacts/literature/catalog-core-1-references.json",
                        "citations": "artifacts/literature/catalog-core-1-citations.json",
                    },
                    "gaps": [],
                }
            ]
        },
        "source_first_reading": {
            "notes": ["knowledge_base/literature/catalog-core-1.md"],
            "metadata_only_not_evidence_ready": metadata_only or [],
        },
        "final_status": final_status,
        "stop_reason": "no new core papers after citation/reference expansion",
    }


def _write_saturation(tmp_path: Path, data: dict) -> None:
    for index, candidate in enumerate(data.get("candidate_pool", {}).get("candidates", [])):
        canonical = candidate.get("canonical_identity")
        if candidate.get("identity_status") != "resolved" or not isinstance(canonical, dict):
            continue
        canonical_id = str(canonical.get("canonical_id") or "")
        providers: list[dict] = []
        provider_keys = [canonical_id, *canonical.get("aliases", [])]
        for key in provider_keys:
            if not isinstance(key, str) or not key.startswith("provider:"):
                continue
            _, provider, identifier = key.split(":", 2)
            providers.append(
                {
                    "provider": provider,
                    "title": canonical.get("title"),
                    "authors": canonical.get("authors"),
                    "year": canonical.get("year"),
                    "doi": None,
                    "venue": None,
                    "identifier": identifier,
                }
            )
        if not providers:
            doi = canonical_id.removeprefix("doi:") if canonical_id.startswith("doi:") else None
            providers.append(
                {
                    "provider": str(canonical.get("provenance", {}).get("provider") or "catalog"),
                    "title": canonical.get("title"),
                    "authors": canonical.get("authors"),
                    "year": canonical.get("year"),
                    "doi": doi,
                    "venue": None,
                    "identifier": canonical_id if canonical_id.startswith("http") else f"record-{index}",
                }
            )
        identity_path = tmp_path / "artifacts" / "identity" / f"candidate-{index}.json"
        identity_path.parent.mkdir(parents=True, exist_ok=True)
        identity_path.write_text(
            json.dumps({"citation_key": canonical_id, "providers": providers}, indent=2) + "\n",
            encoding="utf-8",
        )
        digest = hashlib.sha256(identity_path.read_bytes()).hexdigest()
        provenance = canonical["provenance"]
        if len(providers) > 1:
            provenance["kind"] = "citation_triangulation"
            provenance["provider"] = "citation-triangulation"
        provenance["record_ref"] = (
            f"project://{identity_path.relative_to(tmp_path).as_posix()}#sha256:{digest}"
        )
        provenance["record_sha256"] = f"sha256:{digest}"
    for source in data.get("bibliography_reconciliation", {}).get("core_sources", []):
        artifact_ref = str(source.get("references_artifact_ref") or "").strip()
        if artifact_ref.startswith("project://"):
            artifact = artifact_ref.removeprefix("project://").split("#", 1)[0]
            artifact_path = tmp_path / artifact
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
                reference = {
                    "raw_text": f"Raw bibliographic entry for {candidate_id}",
                    "locator": discovery["locator"],
                    "candidate_id": candidate_id,
                }
                canonical = candidate.get("canonical_identity")
                if isinstance(canonical, dict):
                    reference["identity"] = {
                        "canonical_id": canonical["canonical_id"],
                        "title": canonical["title"],
                        "year": canonical["year"],
                    }
                else:
                    reference["identity_status"] = "unresolved"
                    reference["unresolved_reason"] = "canonical metadata has not yet been established"
                references.append(reference)
            artifact_path.write_text(
                json.dumps({"source_id": source.get("id"), "references": references}, indent=2) + "\n",
                encoding="utf-8",
            )
            source["references_artifact_ref"] = (
                f"project://{artifact}#sha256:{hashlib.sha256(artifact_path.read_bytes()).hexdigest()}"
            )
    (tmp_path / "knowledge_base" / "methodology_traces" / "literature_saturation.json").write_text(
        json.dumps(data, indent=2),
        encoding="utf-8",
    )


def _raw_bibliography_path(tmp_path: Path, source: dict) -> Path:
    ref = str(source["references_artifact_ref"])
    return tmp_path / ref.removeprefix("project://").split("#", 1)[0]


def _repin_raw_bibliography(tmp_path: Path, source: dict) -> None:
    path = _raw_bibliography_path(tmp_path, source)
    relative = path.relative_to(tmp_path).as_posix()
    source["references_artifact_ref"] = (
        f"project://{relative}#sha256:{hashlib.sha256(path.read_bytes()).hexdigest()}"
    )
    saturation = tmp_path / "knowledge_base" / "methodology_traces" / "literature_saturation.json"
    data = json.loads(saturation.read_text(encoding="utf-8"))
    data["bibliography_reconciliation"]["core_sources"][0]["references_artifact_ref"] = source[
        "references_artifact_ref"
    ]
    saturation.write_text(json.dumps(data, indent=2), encoding="utf-8")


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
    artifact = _raw_bibliography_path(tmp_path, doc["bibliography_reconciliation"]["core_sources"][0])
    artifact.unlink()

    result = _run_gate(tmp_path)

    assert result.returncode == 1
    assert "references_artifact_ref does not resolve" in result.stdout


def test_gate_fails_closed_when_raw_bibliography_manifest_is_unstructured_or_count_mismatched(tmp_path: Path) -> None:
    _write_project(tmp_path)
    _write_trace(tmp_path)
    doc = _saturated_doc()
    _write_saturation(tmp_path, doc)
    artifact = _raw_bibliography_path(tmp_path, doc["bibliography_reconciliation"]["core_sources"][0])
    artifact.write_text("{}\n", encoding="utf-8")
    _repin_raw_bibliography(tmp_path, doc["bibliography_reconciliation"]["core_sources"][0])

    result = _run_gate(tmp_path)
    assert result.returncode == 1
    assert "references_artifact_ref.source_id must equal" in result.stdout
    assert "references_artifact_ref.references: expected array" in result.stdout

    artifact.write_text(
        json.dumps({"source_id": "provider:catalog:core-1", "references": []}) + "\n",
        encoding="utf-8",
    )
    _repin_raw_bibliography(tmp_path, doc["bibliography_reconciliation"]["core_sources"][0])
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
        {"kind": "bibliography", "source_id": "provider:catalog:core-1", "locator": "References, entry 8"}
    )
    _write_saturation(tmp_path, doc)
    artifact = _raw_bibliography_path(tmp_path, source)
    manifest = json.loads(artifact.read_text(encoding="utf-8"))
    manifest["references"].append(
        {
            "raw_text": "Alternate raw entry for the same work",
            "locator": "References, entry 8",
            "candidate_id": "doi:10.1000/example",
            "identity": {
                "canonical_id": candidate["canonical_identity"]["canonical_id"],
                "title": candidate["canonical_identity"]["title"],
                "year": candidate["canonical_identity"]["year"],
            },
        }
    )
    artifact.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    _repin_raw_bibliography(tmp_path, source)

    result = _run_gate(tmp_path)

    assert result.returncode == 0


def test_gate_fails_closed_on_unresolved_or_undispositioned_candidate(tmp_path: Path) -> None:
    _write_project(tmp_path)
    _write_trace(tmp_path)
    unresolved = _saturated_doc()
    candidate = unresolved["candidate_pool"]["candidates"][1]
    candidate["identity_status"] = "unresolved"
    candidate.pop("canonical_identity")
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
    duplicate_identity["candidate_pool"]["candidates"][1]["canonical_identity"]["aliases"] = [
        "provider:catalog:core-1"
    ]
    _write_saturation(tmp_path, duplicate_identity)

    result = _run_gate(tmp_path)
    assert result.returncode == 1
    assert "merge aliases into one normalized candidate record" in result.stdout


def test_gate_deduplicates_doi_and_provider_keys_from_pinned_provider_records(tmp_path: Path) -> None:
    _write_project(tmp_path)
    _write_trace(tmp_path)
    doc = _saturated_doc()
    doc["candidate_pool"]["total_candidates"] = 3
    doc["candidate_pool"]["candidates"].append(
        {
            "id": "provider:catalog:record-1",
            "identity_status": "resolved",
            "canonical_identity": _canonical_identity(
                "provider:catalog:record-1",
                title="Cited example",
                year=2024,
                url="https://catalog.example/records/unproven-display",
            ),
            "disposition": "supporting",
            "rationale": "second representation of an already archived work",
            "discovered_from": [
                {"kind": "search", "source_id": "query:2", "locator": "page 1, record 2"}
            ],
        }
    )
    _write_saturation(tmp_path, doc)

    result = _run_gate(tmp_path)

    assert result.returncode == 1
    assert "merge aliases into one normalized candidate record" in result.stdout


def test_gate_rejects_resolved_candidate_with_unrecognized_identity_shape(tmp_path: Path) -> None:
    _write_project(tmp_path)
    _write_trace(tmp_path)
    doc = _saturated_doc()
    candidate = doc["candidate_pool"]["candidates"][1]
    candidate.pop("canonical_identity")
    candidate["stable_ids"] = ["arbitrary self-asserted string"]
    _write_saturation(tmp_path, doc)

    result = _run_gate(tmp_path)

    assert result.returncode == 1
    assert "canonical_identity" in result.stdout


def test_gate_rejects_unbound_or_swapped_canonical_provenance(tmp_path: Path) -> None:
    _write_project(tmp_path)
    _write_trace(tmp_path)
    _write_saturation(tmp_path, _saturated_doc())
    saturation_path = tmp_path / "knowledge_base" / "methodology_traces" / "literature_saturation.json"
    saturation = json.loads(saturation_path.read_text(encoding="utf-8"))
    provenance = saturation["candidate_pool"]["candidates"][1]["canonical_identity"]["provenance"]
    provenance["record_ref"] = "https://invalid.example/metadata#sha256:" + "b" * 64
    provenance["record_sha256"] = "sha256:" + "b" * 64
    saturation_path.write_text(json.dumps(saturation, indent=2), encoding="utf-8")

    result = _run_gate(tmp_path)
    assert result.returncode == 1
    assert "must be an exact pinned project JSON reference" in result.stdout

    _write_saturation(tmp_path, _saturated_doc())
    saturation = json.loads(saturation_path.read_text(encoding="utf-8"))
    provenance = saturation["candidate_pool"]["candidates"][1]["canonical_identity"]["provenance"]
    identity_path = tmp_path / provenance["record_ref"].removeprefix("project://").split("#", 1)[0]
    identity = json.loads(identity_path.read_text(encoding="utf-8"))
    identity["providers"][0]["title"] = "Metadata for a different work"
    identity_path.write_text(json.dumps(identity, indent=2) + "\n", encoding="utf-8")
    digest = hashlib.sha256(identity_path.read_bytes()).hexdigest()
    provenance["record_ref"] = (
        f"project://{identity_path.relative_to(tmp_path).as_posix()}#sha256:{digest}"
    )
    provenance["record_sha256"] = f"sha256:{digest}"
    saturation_path.write_text(json.dumps(saturation, indent=2), encoding="utf-8")

    result = _run_gate(tmp_path)
    assert result.returncode == 1
    assert "title does not match canonical candidate metadata" in result.stdout


def test_gate_normalizes_doi_url_case_and_preprint_version_aliases_before_collision_check(tmp_path: Path) -> None:
    _write_project(tmp_path)
    _write_trace(tmp_path)
    doc = _saturated_doc()
    core = doc["candidate_pool"]["candidates"][0]
    cited = doc["candidate_pool"]["candidates"][1]
    core["canonical_identity"] = _canonical_identity(
        "https://doi.org/10.48550/arXiv.1234.56789V2",
        title="Core example",
        year=2025,
        url="https://doi.org/10.48550/arXiv.1234.56789V2",
    )
    cited["canonical_identity"] = _canonical_identity(
        "doi:10.48550/arxiv.1234.56789",
        title="Cited example",
        year=2024,
        url="https://doi.org/10.48550/arxiv.1234.56789",
    )
    _write_saturation(tmp_path, doc)

    result = _run_gate(tmp_path)

    assert result.returncode == 1
    assert "canonical identity" in result.stdout
    assert "merge aliases" in result.stdout


def test_gate_rejects_raw_bibliography_identity_with_swapped_metadata(tmp_path: Path) -> None:
    _write_project(tmp_path)
    _write_trace(tmp_path)
    doc = _saturated_doc()
    _write_saturation(tmp_path, doc)
    source = doc["bibliography_reconciliation"]["core_sources"][0]
    artifact = _raw_bibliography_path(tmp_path, source)
    manifest = json.loads(artifact.read_text(encoding="utf-8"))
    manifest["references"][0]["identity"]["title"] = "Metadata from a different work"
    artifact.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    _repin_raw_bibliography(tmp_path, source)

    result = _run_gate(tmp_path)

    assert result.returncode == 1
    assert "identity.title" in result.stdout
    assert "canonical candidate metadata" in result.stdout


def test_gate_rejects_bibliography_discovery_missing_from_pinned_manifest(tmp_path: Path) -> None:
    _write_project(tmp_path)
    _write_trace(tmp_path)
    doc = _saturated_doc()
    doc["candidate_pool"]["candidates"][1]["discovered_from"].append(
        {
            "kind": "bibliography",
            "source_id": "provider:catalog:core-1",
            "locator": "References, entry 8",
        }
    )
    _write_saturation(tmp_path, doc)

    result = _run_gate(tmp_path)

    assert result.returncode == 1
    assert "bibliography discovery claims do not match the pinned raw manifest" in result.stdout

    _write_saturation(tmp_path, _saturated_doc())
    saturation_path = tmp_path / "knowledge_base" / "methodology_traces" / "literature_saturation.json"
    saturation = json.loads(saturation_path.read_text(encoding="utf-8"))
    saturation["candidate_pool"]["candidates"][1]["discovered_from"][0]["source_id"] = (
        "provider:catalog:not-a-core-source"
    )
    saturation_path.write_text(json.dumps(saturation, indent=2), encoding="utf-8")

    result = _run_gate(tmp_path)

    assert result.returncode == 1
    assert "is not a selected core source" in result.stdout


def test_gate_fails_closed_when_method_family_scan_is_not_complete(tmp_path: Path) -> None:
    _write_project(tmp_path)
    _write_trace(tmp_path)
    doc = _saturated_doc()
    screening = doc["method_family_audit"]["source_audits"][0]["bibliography_candidate_screening"][0]
    screening.clear()
    screening.update(
        {
            "candidate_id": "doi:10.1000/example",
            "disposition": "coverage_debt",
            "locator": "References, entry 7",
            "evidence_basis": "source_text",
            "rationale": "The citation context has not yet been resolved.",
        }
    )
    _write_saturation(tmp_path, doc)

    result = _run_gate(tmp_path)

    assert result.returncode == 1
    assert "no unresolved method-family gaps" in result.stdout


def test_gate_requires_one_method_screening_disposition_per_reconciled_candidate(tmp_path: Path) -> None:
    _write_project(tmp_path)
    _write_trace(tmp_path)
    doc = _saturated_doc()
    source = doc["method_family_audit"]["source_audits"][0]
    source["bibliography_candidate_screening"] = []
    _write_saturation(tmp_path, doc)

    result = _run_gate(tmp_path)

    assert result.returncode == 1
    assert "bibliography_candidate_screening" in result.stdout
    assert "doi:10.1000/example" in result.stdout


def test_gate_accepts_explicit_not_method_bearing_screening(tmp_path: Path) -> None:
    _write_project(tmp_path)
    _write_trace(tmp_path)
    doc = _saturated_doc()
    source = doc["method_family_audit"]["source_audits"][0]
    source["bibliography_candidate_screening"] = [
        {
            "candidate_id": "doi:10.1000/example",
            "disposition": "not_method_bearing",
            "locator": "References, entry 7 and surrounding citation context",
            "evidence_basis": "source_text",
            "rationale": "The citation supplies background context and carries no method attribution.",
        }
    ]
    _write_saturation(tmp_path, doc)

    result = _run_gate(tmp_path)

    assert result.returncode == 0


def test_gate_rejects_title_year_only_negative_method_screening(tmp_path: Path) -> None:
    _write_project(tmp_path)
    _write_trace(tmp_path)
    doc = _saturated_doc()
    doc["method_family_audit"]["source_audits"][0]["bibliography_candidate_screening"] = [
        {
            "candidate_id": "doi:10.1000/example",
            "disposition": "not_method_bearing",
            "locator": "catalog title and publication year",
            "evidence_basis": "title_year_query",
            "rationale": "title and year do not advertise a method",
        }
    ]
    _write_saturation(tmp_path, doc)

    result = _run_gate(tmp_path)

    assert result.returncode == 1
    assert "evidence_basis must be 'source_text'" in result.stdout


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
    candidate.pop("canonical_identity")
    candidate["disposition"] = "coverage_debt"
    reconciliation = doc["bibliography_reconciliation"]["core_sources"][0]
    reconciliation["status"] = "coverage_debt"
    reconciliation["coverage_debt"] = ["candidate identity unresolved"]
    doc["method_family_audit"]["status"] = "coverage_debt"
    screening = doc["method_family_audit"]["source_audits"][0]["bibliography_candidate_screening"][0]
    screening.clear()
    screening.update(
        {
            "candidate_id": "doi:10.1000/example",
            "disposition": "coverage_debt",
            "locator": "References, entry 7",
            "evidence_basis": "source_text",
            "rationale": "The citation context has not yet been resolved.",
        }
    )
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


def test_gate_rejects_missing_or_inconsistent_page_cursor_accounting(tmp_path: Path) -> None:
    _write_project(tmp_path)
    _write_trace(tmp_path)
    missing = _saturated_doc()
    missing["providers"]["inspire"].pop("request_log")
    _write_saturation(tmp_path, missing)

    result = _run_gate(tmp_path)
    assert result.returncode == 1
    assert "request_log must record each bounded page or cursor request" in result.stdout

    inconsistent = _saturated_doc()
    inconsistent["providers"]["inspire"]["request_log"][0]["returned_count"] = 49
    _write_saturation(tmp_path, inconsistent)

    result = _run_gate(tmp_path)
    assert result.returncode == 1
    assert "request_log returned counts must sum to returned_count" in result.stdout


def test_gate_rejects_unsearched_declared_query_or_unexhausted_known_total(tmp_path: Path) -> None:
    _write_project(tmp_path)
    _write_trace(tmp_path)
    unsearched = _saturated_doc()
    unsearched["providers"]["inspire"]["queries"] = ["broad historical query", "test query"]
    _write_saturation(tmp_path, unsearched)

    result = _run_gate(tmp_path)
    assert result.returncode == 1
    assert "every declared query must have request_log coverage" in result.stdout

    incomplete = _saturated_doc()
    incomplete["providers"]["arxiv"]["total_count"] = 100
    _write_saturation(tmp_path, incomplete)

    result = _run_gate(tmp_path)
    assert result.returncode == 1
    assert "known total_count must be fully returned before saturation" in result.stdout

    bounded = _saturated_doc()
    bounded["providers"]["inspire"]["request_log"][0]["continuation"] = "bounded_stop"
    _write_saturation(tmp_path, bounded)

    result = _run_gate(tmp_path)
    assert result.returncode == 1
    assert "must end with continuation='exhausted'" in result.stdout


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
            "--max-requests",
            "2",
            "--max-records",
            "50",
            "--request-log-json",
            '[{"query":"q1","page_or_cursor":"page:1","returned_count":25,"continuation":"exhausted"},{"query":"q2","page_or_cursor":"cursor:end","returned_count":25,"continuation":"exhausted"}]',
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
            "provider:catalog:core-1",
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
            "provider:catalog:core-1",
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
