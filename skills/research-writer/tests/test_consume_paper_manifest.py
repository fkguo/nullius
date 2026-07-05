"""Tests for the deterministic paper_manifest.json consumer/publisher.

Drives the CLI against fixture ``paper/`` trees and pins the actual outputs:
the empty manual bib is created, main.tex gains a ``\\bibliography{gen,man}``
that references both databases, build_trace.jsonl / export_manifest.json are
written, and the fail-fast validations (hep://, citekey conflict, missing
inputs, '..' escapes) reject with exit code 2.
"""
from __future__ import annotations

import importlib.util
import json
import subprocess
import sys
from pathlib import Path

_MOD = Path(__file__).resolve().parent.parent / "scripts" / "bin" / "research_writer_consume_paper_manifest.py"
_spec = importlib.util.spec_from_file_location("research_writer_consume_paper_manifest", _MOD)
cm = importlib.util.module_from_spec(_spec)
sys.modules[_spec.name] = cm  # dataclasses on 3.12 needs the module registered
_spec.loader.exec_module(cm)


_MAIN_TEX = (
    "\\documentclass{revtex4-2}\n"
    "\\begin{document}\n"
    "Hello.\n"
    "\\bibliography{references_generated}\n"
    "\\end{document}\n"
)


def _make_paper(tmp_path: Path, *, main_tex: str = _MAIN_TEX,
                manifest: dict | None = None,
                gen_bib: str = "@article{gen:a, journal={J}, title={G}}\n",
                manual_bib: str | None = None) -> Path:
    """Build a minimal but valid paper/ tree; return the manifest path."""
    paper = tmp_path / "paper"
    (paper / "figures").mkdir(parents=True)
    (paper / "main.tex").write_text(main_tex, encoding="utf-8")
    (paper / "references_generated.bib").write_text(gen_bib, encoding="utf-8")
    if manual_bib is not None:
        (paper / "references_manual.bib").write_text(manual_bib, encoding="utf-8")
    (paper / "figures" / ".keep").write_text("", encoding="utf-8")
    if manifest is None:
        manifest = {
            "schemaVersion": 1,
            "mainTex": "main.tex",
            "figuresDir": "figures",
            "bib": {"generated": "references_generated.bib"},
        }
    mpath = paper / "paper_manifest.json"
    mpath.write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    return mpath


def _run_cli(args: list[str]) -> subprocess.CompletedProcess:
    return subprocess.run(
        [sys.executable, str(_MOD), *args],
        capture_output=True,
        text=True,
        check=False,
    )


def _trace_events(paper_root: Path) -> list[dict]:
    lines = (paper_root / "build_trace.jsonl").read_text(encoding="utf-8").splitlines()
    return [json.loads(ln) for ln in lines if ln.strip()]


# --- green path: expected outputs from a valid fixture manifest ---

def test_valid_manifest_produces_expected_outputs(tmp_path):
    mpath = _make_paper(tmp_path)
    paper = mpath.parent
    r = _run_cli(["--paper-manifest", str(mpath)])
    assert r.returncode == 0, r.stdout + r.stderr
    assert "ok: validated paper" in r.stdout

    # 1) missing manual bib was created (empty, user-maintained placeholder)
    manual = paper / "references_manual.bib"
    assert manual.is_file()
    assert "user-maintained" in manual.read_text(encoding="utf-8")

    # 2) main.tex now references BOTH databases, generated first, manual last
    tex = (paper / "main.tex").read_text(encoding="utf-8")
    assert "\\bibliography{references_generated,references_manual}" in tex

    # 3) an audit trail and an export manifest were emitted
    events = {e["event"] for e in _trace_events(paper)}
    assert {"run_start", "manual_bib_created", "validate_ok", "run_done"} <= events
    export = json.loads((paper / "export_manifest.json").read_text(encoding="utf-8"))
    assert export["entrypoint"] == "consume_paper_manifest"
    assert export["schemaVersion"] == 1
    assert export["paper"]["bib"]["manual"] == "references_manual.bib"
    assert export["compile"]["status"] == "not_requested"


def test_existing_manual_bib_is_preserved_and_bibliography_updated(tmp_path):
    mpath = _make_paper(tmp_path, manual_bib="@book{man:x, title={M}}\n")
    paper = mpath.parent
    r = _run_cli(["--paper-manifest", str(mpath)])
    assert r.returncode == 0, r.stdout + r.stderr
    # existing manual bib content untouched (no placeholder overwrite)
    assert "@book{man:x" in (paper / "references_manual.bib").read_text(encoding="utf-8")
    tex = (paper / "main.tex").read_text(encoding="utf-8")
    assert "\\bibliography{references_generated,references_manual}" in tex


def test_bibliography_already_correct_is_left_unchanged(tmp_path):
    good_tex = _MAIN_TEX.replace(
        "\\bibliography{references_generated}",
        "\\bibliography{references_generated,references_manual}",
    )
    mpath = _make_paper(tmp_path, main_tex=good_tex,
                        manual_bib="% manual\n")
    paper = mpath.parent
    r = _run_cli(["--paper-manifest", str(mpath)])
    assert r.returncode == 0, r.stdout + r.stderr
    events = _trace_events(paper)
    kinds = {e["event"] for e in events}
    # no bibliography rewrite happened; the "ok" event is logged instead
    assert "main_tex_bibliography_ok" in kinds
    assert "main_tex_bibliography_updated" not in kinds
    # and no backup file was created
    assert not (paper / "main.tex.bak").exists()


def test_dry_run_writes_no_files_but_traces(tmp_path):
    mpath = _make_paper(tmp_path)
    paper = mpath.parent
    r = _run_cli(["--paper-manifest", str(mpath), "--dry-run"])
    assert r.returncode == 0, r.stdout + r.stderr
    # manual bib NOT created, main.tex NOT modified, no export manifest
    assert not (paper / "references_manual.bib").exists()
    assert "\\bibliography{references_generated}\n" in (paper / "main.tex").read_text(encoding="utf-8")
    assert not (paper / "export_manifest.json").exists()
    # but the plan is still recorded in the trace
    kinds = {e["event"] for e in _trace_events(paper)}
    assert "manual_bib_missing" in kinds
    assert "main_tex_bibliography_planned" in kinds


# --- unit-level checks on pure helpers ---

def test_bib_dbname_strips_suffix_and_uses_posix():
    assert cm._bib_dbname("references_generated.bib") == "references_generated"
    assert cm._bib_dbname("sub/refs.BIB") == "sub/refs"


def test_reject_dotdot_helper():
    import pytest
    with pytest.raises(ValueError):
        cm._resolve_from_paper_root(Path("/paper"), "../escape.tex")


def test_read_bib_keys_dedups(tmp_path):
    bib = tmp_path / "r.bib"
    bib.write_text("@article{a, title={x}}\n@book{b, title={y}}\n@misc{a, title={z}}\n",
                   encoding="utf-8")
    assert cm._read_bib_keys(bib) == ["a", "b"]


def test_ensure_main_bibliography_inserts_both(tmp_path):
    tex = tmp_path / "main.tex"
    tex.write_text("\\bibliography{references_generated}\n", encoding="utf-8")
    patch = cm._ensure_main_bibliography(tex, gen_db="references_generated", man_db="references_manual")
    assert patch["changed"] is True
    assert patch["new"] == "references_generated,references_manual"
    assert "\\bibliography{references_generated,references_manual}" in patch["after_text"]


# --- fail-fast validations: each must exit 2 ---

def test_hep_uri_in_tex_is_rejected(tmp_path):
    bad_tex = _MAIN_TEX.replace("Hello.", "See hep://run/42 for provenance.")
    mpath = _make_paper(tmp_path, main_tex=bad_tex)
    r = _run_cli(["--paper-manifest", str(mpath)])
    assert r.returncode == 2
    assert "hep://" in (r.stdout + r.stderr)
    kinds = {e["event"] for e in _trace_events(mpath.parent)}
    assert "run_failed" in kinds


def test_citekey_conflict_between_bibs_is_rejected(tmp_path):
    mpath = _make_paper(
        tmp_path,
        gen_bib="@article{dup, journal={J}, title={G}}\n",
        manual_bib="@book{dup, title={M}}\n",
    )
    r = _run_cli(["--paper-manifest", str(mpath)])
    assert r.returncode == 2
    assert "citekey conflict" in (r.stdout + r.stderr)


def test_missing_main_tex_is_rejected(tmp_path):
    mpath = _make_paper(tmp_path)
    (mpath.parent / "main.tex").unlink()
    r = _run_cli(["--paper-manifest", str(mpath)])
    assert r.returncode == 2
    assert "main.tex not found" in (r.stdout + r.stderr)


def test_missing_generated_bib_is_rejected(tmp_path):
    mpath = _make_paper(tmp_path)
    (mpath.parent / "references_generated.bib").unlink()
    r = _run_cli(["--paper-manifest", str(mpath)])
    assert r.returncode == 2
    assert "references_generated.bib not found" in (r.stdout + r.stderr)


def test_bad_schema_version_is_rejected(tmp_path):
    mpath = _make_paper(
        tmp_path,
        manifest={
            "schemaVersion": 99,
            "mainTex": "main.tex",
            "figuresDir": "figures",
            "bib": {"generated": "references_generated.bib"},
        },
    )
    r = _run_cli(["--paper-manifest", str(mpath)])
    assert r.returncode == 2
    assert "unsupported schemaVersion" in (r.stdout + r.stderr)


def test_no_bibliography_command_in_main_tex_is_rejected(tmp_path):
    no_bib_tex = "\\documentclass{revtex4-2}\n\\begin{document}\nHi.\n\\end{document}\n"
    mpath = _make_paper(tmp_path, main_tex=no_bib_tex)
    r = _run_cli(["--paper-manifest", str(mpath)])
    assert r.returncode == 2
    assert "\\bibliography" in (r.stdout + r.stderr)


def test_missing_manifest_file_is_rejected(tmp_path):
    r = _run_cli(["--paper-manifest", str(tmp_path / "nope" / "paper_manifest.json")])
    assert r.returncode == 2
    assert "not found" in (r.stdout + r.stderr)


def test_invalid_json_manifest_is_rejected(tmp_path):
    paper = tmp_path / "paper"
    paper.mkdir()
    mpath = paper / "paper_manifest.json"
    mpath.write_text("{ not json", encoding="utf-8")
    r = _run_cli(["--paper-manifest", str(mpath)])
    assert r.returncode == 2
    assert "invalid paper manifest" in (r.stdout + r.stderr)
