from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path
from urllib.parse import urlencode


def _repo_root() -> Path:
    return Path(__file__).resolve().parents[3]


def test_inspire_search_caps_max_results_at_inspire_page_size(tmp_path: Path) -> None:
    fixtures = tmp_path / "fixtures"
    fixtures.mkdir()

    query = "axion potential"
    fields = "control_number,titles,authors,publication_info,arxiv_eprints,dois,texkeys,preprint_date,earliest_date,legacy_creation_date"
    capped_url = f"https://inspirehep.net/api/literature?{urlencode({'q': query, 'size': 1000, 'fields': fields})}"
    (fixtures / "inspire-search.json").write_text(
        json.dumps({"hits": {"hits": []}}),
        encoding="utf-8",
    )
    (fixtures / "fixtures_index.json").write_text(
        json.dumps({capped_url: "inspire-search.json"}),
        encoding="utf-8",
    )

    script = _repo_root() / "skills" / "research-team" / "scripts" / "bin" / "literature_fetch.py"
    proc = subprocess.run(
        [
            sys.executable,
            str(script),
            "inspire-search",
            "--query",
            query,
            "--max-results",
            "5000",
            "--json",
        ],
        cwd=tmp_path,
        env={
            "PATH": "/usr/bin:/bin",
            "RESEARCH_TEAM_HTTP_FIXTURES": str(fixtures),
        },
        text=True,
        capture_output=True,
        check=False,
    )

    assert proc.returncode == 0, proc.stdout + proc.stderr
    assert json.loads(proc.stdout) == []
    assert "size=5000" not in proc.stderr
