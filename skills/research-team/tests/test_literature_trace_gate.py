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
            "total_candidates": 92,
            "selected_core_ids": ["inspire:1"],
            "selection_rationale": "core anchor selected after provider and citation expansion",
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


def test_literature_fetch_saturation_helpers_can_create_passing_artifact(tmp_path: Path) -> None:
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

    result = _run_gate(tmp_path)

    assert result.returncode == 0
    assert "final_status: saturated" in result.stdout
