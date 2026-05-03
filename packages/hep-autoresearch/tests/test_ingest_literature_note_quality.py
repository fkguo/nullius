from __future__ import annotations

from pathlib import Path

import hep_autoresearch.toolkit.ingest as ingest_mod
from hep_autoresearch.toolkit.ingest import IngestInputs, ingest_one


def _init_repo_root(repo_root: Path) -> None:
    (repo_root / "knowledge_base" / "literature").mkdir(parents=True, exist_ok=True)
    (repo_root / "knowledge_base" / "methodology_traces").mkdir(parents=True, exist_ok=True)
    (repo_root / "knowledge_base" / "priors").mkdir(parents=True, exist_ok=True)
    (repo_root / "knowledge_base" / "methodology_traces" / "literature_queries.md").write_text(
        "| timestamp | source | query | selector | shortlist | decision | note |\n"
        "|---|---|---|---|---|---|---|\n",
        encoding="utf-8",
    )


def test_metadata_only_ingest_note_marks_reading_required_and_keeps_query_log_separate(
    tmp_path: Path,
    monkeypatch,
) -> None:
    _init_repo_root(tmp_path)

    def fake_http_get_json(url: str) -> dict[str, object]:
        assert url == "https://inspirehep.net/api/literature/1234"
        return {
            "metadata": {
                "titles": [{"title": "Example Paper"}],
                "authors": [{"full_name": "Doe, Jane"}, {"full_name": "Roe, John"}],
                "preprint_date": "1968-01-01",
                "publication_info": [{"journal_title": "Phys. Rev.", "journal_volume": "123", "year": 1968}],
                "arxiv_eprints": [{"value": "1234.5678", "categories": ["hep-th"]}],
                "texkeys": ["Doe:1968example"],
            }
        }

    def fake_http_get_text(url: str) -> str:
        assert url == "https://inspirehep.net/api/literature/1234?format=bibtex"
        return "@article{Doe:1968example,title={Example Paper}}\n"

    monkeypatch.setattr(ingest_mod, "http_get_json", fake_http_get_json)
    monkeypatch.setattr(ingest_mod, "http_get_text", fake_http_get_text)

    result = ingest_one(
        IngestInputs(inspire_recid="1234", tag="M1-test", download="none"),
        repo_root=tmp_path,
    )

    assert result["errors"] == []
    note_path = tmp_path / "knowledge_base" / "literature" / "recid-1234-example-paper.md"
    note_text = note_path.read_text(encoding="utf-8")
    query_log = (tmp_path / "knowledge_base" / "methodology_traces" / "literature_queries.md").read_text(
        encoding="utf-8"
    )

    assert "Verification status: metadata-only" in note_text
    assert "Evidence readiness: reading-required" in note_text
    assert "Reading evidence needed:" in note_text
    assert "- Source form actually read:" in note_text
    assert "- Sections/pages/equations/figures actually read:" in note_text
    assert "- Central equations/assumptions extracted:" in note_text
    assert "- What was not read and why:" in note_text
    assert "- Project relevance:" in note_text
    assert "- Limitations / caveats for using this note:" in note_text
    assert "direct INSPIRE recid input" in query_log
    assert "direct INSPIRE recid input" not in note_text


def test_arxiv_only_ingest_note_marks_reading_required_and_keeps_query_log_separate(
    tmp_path: Path,
    monkeypatch,
) -> None:
    _init_repo_root(tmp_path)

    arxiv_atom = """<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:arxiv="http://arxiv.org/schemas/atom">
  <entry>
    <id>http://arxiv.org/abs/2401.01234v1</id>
    <updated>2024-01-03T00:00:00Z</updated>
    <published>2024-01-02T00:00:00Z</published>
    <title> arXiv Only Example </title>
    <summary>Example summary.</summary>
    <author><name>Jane Doe</name></author>
    <author><name>John Roe</name></author>
    <link href="https://arxiv.org/abs/2401.01234v1" rel="alternate" type="text/html" />
    <arxiv:primary_category term="hep-th" />
  </entry>
</feed>
"""

    def fake_http_get_text(url: str) -> str:
        assert url == "https://export.arxiv.org/api/query?id_list=2401.01234"
        return arxiv_atom

    def fake_http_get_json(url: str) -> dict[str, object]:
        assert url == "https://inspirehep.net/api/literature?q=eprint%3A2401.01234&size=2"
        return {"hits": {"total": 0, "hits": []}}

    monkeypatch.setattr(ingest_mod, "http_get_text", fake_http_get_text)
    monkeypatch.setattr(ingest_mod, "http_get_json", fake_http_get_json)

    result = ingest_one(
        IngestInputs(arxiv_id="2401.01234", tag="M1-test", download="none"),
        repo_root=tmp_path,
    )

    assert result["errors"] == []
    note_path = tmp_path / "knowledge_base" / "literature" / "arxiv-2401.01234-arxiv-only-example.md"
    note_text = note_path.read_text(encoding="utf-8")
    query_log = (tmp_path / "knowledge_base" / "methodology_traces" / "literature_queries.md").read_text(
        encoding="utf-8"
    )

    assert "Authors: Doe, Roe" in note_text
    assert "Publication: arXiv: 2401.01234 [hep-th]" in note_text
    assert "Evidence readiness: reading-required" in note_text
    assert "Reading evidence needed:" in note_text
    assert "- Source form actually read:" in note_text
    assert "- Sections/pages/equations/figures actually read:" in note_text
    assert "- Central equations/assumptions extracted:" in note_text
    assert "- What was not read and why:" in note_text
    assert "- Project relevance:" in note_text
    assert "- Limitations / caveats for using this note:" in note_text
    assert "arXiv Atom metadata" in query_log
    assert "arXiv Atom metadata" not in note_text


def test_doi_only_ingest_note_marks_reading_required_and_keeps_query_log_separate(
    tmp_path: Path,
    monkeypatch,
) -> None:
    _init_repo_root(tmp_path)

    def fake_http_get_json(url: str) -> dict[str, object]:
        if url == "https://inspirehep.net/api/literature?q=doi%3A10.1103%2FPhysRevD.12.345&size=2":
            return {"hits": {"total": 0, "hits": []}}
        assert url == "https://api.crossref.org/works/10.1103/PhysRevD.12.345"
        return {
            "message": {
                "title": ["DOI Only Example"],
                "author": [
                    {"given": "Jane", "family": "Doe"},
                    {"given": "John", "family": "Roe"},
                ],
                "published-print": {"date-parts": [[1975, 1, 1]]},
            }
        }

    def unexpected_http_get_text(url: str) -> str:
        raise AssertionError(f"unexpected text fetch: {url}")

    monkeypatch.setattr(ingest_mod, "http_get_json", fake_http_get_json)
    monkeypatch.setattr(ingest_mod, "http_get_text", unexpected_http_get_text)

    result = ingest_one(
        IngestInputs(doi="10.1103/PhysRevD.12.345", tag="M1-test", download="none"),
        repo_root=tmp_path,
    )

    assert result["errors"] == []
    note_path = tmp_path / "knowledge_base" / "literature" / "doi-10.1103-physrevd.12.345.md"
    note_text = note_path.read_text(encoding="utf-8")
    query_log = (tmp_path / "knowledge_base" / "methodology_traces" / "literature_queries.md").read_text(
        encoding="utf-8"
    )

    assert "Authors: Doe, Roe" in note_text
    assert "Publication: DOI: 10.1103/PhysRevD.12.345" in note_text
    assert "Evidence readiness: reading-required" in note_text
    assert "Reading evidence needed:" in note_text
    assert "- Source form actually read:" in note_text
    assert "- Sections/pages/equations/figures actually read:" in note_text
    assert "- Central equations/assumptions extracted:" in note_text
    assert "- What was not read and why:" in note_text
    assert "- Project relevance:" in note_text
    assert "- Limitations / caveats for using this note:" in note_text
    assert "Crossref metadata" in query_log
    assert "Crossref metadata" not in note_text
