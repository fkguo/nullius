import io
import json
import subprocess
import sys
import tarfile
from pathlib import Path


def _repo_root() -> Path:
    return Path(__file__).resolve().parents[3]


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

    script = _repo_root() / "skills" / "research-team" / "scripts" / "bin" / "literature_fetch.py"
    out_dir = tmp_path / "references" / "arxiv_src"
    proc = subprocess.run(
        [
            sys.executable,
            str(script),
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
    assert "${SKILL_DIR:-${CODEX_HOME:-$HOME/.codex}/skills/research-team}" in proc.stdout
    assert "NameError" not in proc.stderr
    assert (out_dir / arxiv_id / "src" / "main.tex").read_bytes() == payload
