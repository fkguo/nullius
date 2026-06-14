import io
import json
import subprocess
import sys
import tarfile
from pathlib import Path


def _repo_root() -> Path:
    return Path(__file__).resolve().parents[3]


def _script() -> Path:
    return _repo_root() / "skills" / "research-team" / "scripts" / "bin" / "literature_fetch.py"


def test_arxiv_get_write_note_seeds_reading_required_skeleton(tmp_path: Path) -> None:
    arxiv_id = "0711.1635"
    fixtures = tmp_path / "fixtures"
    fixtures.mkdir()
    feed = fixtures / "arxiv-query.xml"
    feed.write_text(
        """<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:arxiv="http://arxiv.org/schemas/atom">
  <entry>
    <id>http://arxiv.org/abs/0711.1635v1</id>
    <updated>2007-11-10T00:00:00Z</updated>
    <published>2007-11-10T00:00:00Z</published>
    <title>Example source-first paper</title>
    <author><name>Jane Doe</name></author>
    <arxiv:doi>10.1000/example</arxiv:doi>
  </entry>
</feed>
""",
        encoding="utf-8",
    )
    (fixtures / "fixtures_index.json").write_text(
        json.dumps({f"https://export.arxiv.org/api/query?id_list={arxiv_id}": feed.name}),
        encoding="utf-8",
    )

    kb_dir = tmp_path / "knowledge_base" / "literature"
    proc = subprocess.run(
        [
            sys.executable,
            str(_script()),
            "arxiv-get",
            "--arxiv-id",
            arxiv_id,
            "--write-note",
            "--kb-dir",
            str(kb_dir),
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

    assert proc.returncode == 0, proc.stderr
    note = (kb_dir / f"arxiv-{arxiv_id}.md").read_text(encoding="utf-8")
    assert "Evidence readiness: reading-required" in note
    assert "Reading evidence needed:" in note
    for field in (
        "- Source form actually read:",
        "- Sections/pages/equations/figures actually read:",
        "- Central equations/assumptions extracted:",
        "- What was not read and why:",
        "- Project relevance:",
        "- Limitations / caveats for using this note:",
    ):
        assert field in note
    assert "For arXiv items: if LaTeX source is available, fetch/read the source before treating the note as evidence-ready." in note
    assert "Tool-use logs belong in methodology traces or run artifacts, not in this literature note." in note


def test_arxiv_source_success_prints_helper_without_name_error(tmp_path: Path) -> None:
    arxiv_id = "0711.1635"
    fixtures = tmp_path / "fixtures"
    fixtures.mkdir()
    archive = fixtures / "arxiv-source.tar.gz"

    payload = b"\\documentclass{article}\\begin{document}ok\\end{document}\n"
    with tarfile.open(archive, "w:gz") as tf:
        info = tarfile.TarInfo("main.tex")
        info.size = len(payload)
        tf.addfile(info, io.BytesIO(payload))

    (fixtures / "fixtures_index.json").write_text(
        json.dumps({f"https://arxiv.org/e-print/{arxiv_id}": archive.name}),
        encoding="utf-8",
    )

    out_dir = tmp_path / "references" / "arxiv_src"
    proc = subprocess.run(
        [
            sys.executable,
            str(_script()),
            "arxiv-source",
            "--arxiv-id",
            arxiv_id,
            "--out-dir",
            str(out_dir),
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

    assert proc.returncode == 0, proc.stderr
    assert "[ok] downloaded arXiv source" in proc.stdout
    assert "discover_latex_zero_arg_macros.py" in proc.stdout
    assert '${SKILL_DIR:-$(for r in "${CLAUDE_CONFIG_DIR:-$HOME/.claude}" "${CODEX_HOME:-$HOME/.codex}" "$HOME/.config/opencode"; do [ -d "$r/skills/research-team" ] && echo "$r/skills/research-team" && break; done || true)}' in proc.stdout
    assert "Prefer source-first reading: read the extracted LaTeX before relying on an arXiv note as evidence-ready." in proc.stdout
    assert "Record `Source form actually read: latex_source`" in proc.stdout
    assert "Tool-use logs and download attempts belong in methodology traces or run artifacts, not in the literature note." in proc.stdout
    assert "NameError" not in proc.stderr
    assert (out_dir / arxiv_id / "src" / "main.tex").read_bytes() == payload
