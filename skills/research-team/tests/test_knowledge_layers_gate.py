from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path


TESTS_DIR = Path(__file__).resolve().parent
RESEARCH_TEAM_DIR = TESTS_DIR.parent
GATE = RESEARCH_TEAM_DIR / "scripts" / "gates" / "check_knowledge_layers.py"


def _write_config(tmp_path: Path, *, require_literature_reading_evidence: bool = False) -> None:
    (tmp_path / "research_team_config.json").write_text(
        json.dumps(
            {
                "features": {
                    "knowledge_layers_gate": True,
                },
                "knowledge_layers": {
                    "base_dir": "knowledge_base",
                    "require_min_methodology_traces": 1,
                    "require_min_literature": 1,
                    "require_min_priors": 1,
                    "allow_none": False,
                    "require_literature_reading_evidence": require_literature_reading_evidence,
                },
            },
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )


def _write_project_files(tmp_path: Path, literature_note: str) -> Path:
    kb_root = tmp_path / "knowledge_base"
    (kb_root / "literature").mkdir(parents=True, exist_ok=True)
    (kb_root / "methodology_traces").mkdir(parents=True, exist_ok=True)
    (kb_root / "priors").mkdir(parents=True, exist_ok=True)

    (kb_root / "literature" / "demo.md").write_text(literature_note, encoding="utf-8")
    (kb_root / "methodology_traces" / "trace.md").write_text("# Trace\n\n- validated\n", encoding="utf-8")
    (kb_root / "priors" / "prior.md").write_text("# Prior\n\n- convention\n", encoding="utf-8")

    notes = tmp_path / "research_contract.md"
    notes.write_text(
        "<!-- REPRO_CAPSULE_START -->\n"
        "### I) Knowledge base references (MANDATORY when enabled)\n"
        "Literature:\n"
        "- [Demo](knowledge_base/literature/demo.md)\n"
        "Methodology traces:\n"
        "- [Trace](knowledge_base/methodology_traces/trace.md)\n"
        "Priors:\n"
        "- [Prior](knowledge_base/priors/prior.md)\n"
        "<!-- REPRO_CAPSULE_END -->\n",
        encoding="utf-8",
    )
    return notes


def _run_gate(tmp_path: Path, literature_note: str, *, require_literature_reading_evidence: bool) -> subprocess.CompletedProcess[str]:
    _write_config(tmp_path, require_literature_reading_evidence=require_literature_reading_evidence)
    notes = _write_project_files(tmp_path, literature_note)
    return subprocess.run(
        [sys.executable, str(GATE), "--notes", str(notes)],
        text=True,
        capture_output=True,
        check=False,
    )


def _metadata_only_note() -> str:
    return (
        "# Demo Note\n\n"
        "RefKey: demo-ref\n"
        "Authors: Doe et al.\n"
        "Publication: Phys. Rev. 1 1 1968\n"
        "Links:\n"
        "- INSPIRE: https://inspirehep.net/literature/1234\n\n"
        "Verification status: metadata-only (auto-generated; full text not yet deep-read)\n"
        "Evidence readiness: reading-required\n"
        "Reading evidence needed:\n"
        "- Source form actually read: (fill: PDF | arXiv source | journal HTML | other)\n"
        "- Sections/pages/equations/figures actually read: (fill)\n"
        "- Central equations/assumptions extracted: (fill)\n"
        "- What was not read and why: (fill)\n"
        "- Project relevance: (fill)\n"
        "- Limitations / caveats for using this note: (fill)\n"
    )


def _reading_ready_note() -> str:
    return (
        "# Demo Note\n\n"
        "RefKey: demo-ref\n"
        "Authors: Doe et al.\n"
        "Publication: Phys. Rev. 1 1 1968\n"
        "Links:\n"
        "- INSPIRE: https://inspirehep.net/literature/1234\n\n"
        "Verification status: spot-checked\n"
        "Evidence readiness: evidence-ready\n"
        "Reading evidence needed:\n"
        "- Source form actually read: journal PDF downloaded on 2026-05-03\n"
        "- Sections/pages/equations/figures actually read: pp. 2-5; Eq. (3); Fig. 1\n"
        "- Central equations/assumptions extracted: dispersion relation assumes one subtraction and elastic dominance\n"
        "- What was not read and why: appendices not needed for current bound check\n"
        "- Project relevance: baseline method for the continuation step used in this milestone\n"
        "- Limitations / caveats for using this note: no independent reproduction yet; use only for method comparison\n"
    )


def test_metadata_only_note_passes_when_reading_evidence_not_required(tmp_path: Path) -> None:
    result = _run_gate(tmp_path, _metadata_only_note(), require_literature_reading_evidence=False)
    assert result.returncode == 0
    assert "[ok] knowledge layers gate passed" in result.stdout


def test_metadata_only_note_fails_when_reading_evidence_required(tmp_path: Path) -> None:
    result = _run_gate(tmp_path, _metadata_only_note(), require_literature_reading_evidence=True)
    assert result.returncode == 1
    assert "allowed values: spot-checked, replicated, contradicted" in result.stdout


def test_missing_reading_coverage_field_fails_when_reading_evidence_required(tmp_path: Path) -> None:
    note = _reading_ready_note().replace("- Project relevance: baseline method for the continuation step used in this milestone\n", "")
    result = _run_gate(tmp_path, note, require_literature_reading_evidence=True)
    assert result.returncode == 1
    assert "missing required reading-evidence field" in result.stdout


def test_bogus_verification_and_evidence_status_fail_when_reading_evidence_required(tmp_path: Path) -> None:
    note = (
        _reading_ready_note()
        .replace("Verification status: spot-checked\n", "Verification status: ingest-failed\n")
        .replace("Evidence readiness: evidence-ready\n", "Evidence readiness: banana\n")
    )
    result = _run_gate(tmp_path, note, require_literature_reading_evidence=True)
    assert result.returncode == 1
    assert "allowed values: spot-checked, replicated, contradicted" in result.stdout
    assert "must be 'evidence-ready'" in result.stdout
