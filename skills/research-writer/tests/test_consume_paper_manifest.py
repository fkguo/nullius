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


def _invoke_build(monkeypatch, mpath: Path) -> int:
    monkeypatch.setattr(sys, "argv", [str(_MOD), "--paper-manifest", str(mpath), "--compile"])
    return cm.main()


def test_compile_uses_declared_main_and_exports_that_pdf(tmp_path, monkeypatch):
    mpath = _make_paper(tmp_path)
    paper = mpath.parent
    (paper / "main.tex").rename(paper / "article.tex")
    manifest = json.loads(mpath.read_text())
    manifest["mainTex"] = "article.tex"
    mpath.write_text(json.dumps(manifest))
    (paper / "main.pdf").write_bytes(b"old PDF fixture")
    monkeypatch.setattr(cm, "_have_latexmk", lambda: True)

    def compile_target(command, **kwargs):
        assert command[-1] == str((paper / "article.tex").resolve())
        build_dir = Path(next(arg.split("=", 1)[1] for arg in command if arg.startswith("-outdir=")))
        assert build_dir != paper and build_dir.parent == paper
        assert "-jobname=article" in command
        assert Path(kwargs["cwd"]) == paper
        # Synthetic bytes test output routing, not PDF rendering or science.
        (build_dir / "article.pdf").write_bytes(b"current PDF fixture")
        (build_dir / "article.fls").write_text(f"PWD {paper}\nINPUT {paper / 'article.tex'}\n")
        return subprocess.CompletedProcess(command, 0, "built", "")

    monkeypatch.setattr(cm.subprocess, "run", compile_target)
    assert _invoke_build(monkeypatch, mpath) == 0
    export = json.loads((paper / "export_manifest.json").read_text())
    assert export["status"] == "ok"
    assert export["compile"]["pdf"] == "article.pdf"
    assert export["paper"]["main_tex"] == "article.tex"
    assert "article.tex" in export["input_hashes"]
    assert "article.pdf" in export["output_hashes"]


def test_missing_compiler_invalidates_old_success_receipt(tmp_path, monkeypatch):
    mpath = _make_paper(tmp_path)
    paper = mpath.parent
    (paper / "main.pdf").write_bytes(b"old PDF fixture")
    (paper / "export_manifest.json").write_text(json.dumps({"compile": {"status": "ok", "pdf": "main.pdf"}}))
    monkeypatch.setattr(cm, "_have_latexmk", lambda: False)
    assert _invoke_build(monkeypatch, mpath) == 2
    export = json.loads((paper / "export_manifest.json").read_text())
    assert export["status"] == "failed"
    assert export["compile"]["status"] == "unavailable"
    assert export["compile"]["pdf"] is None
    assert (paper / "main.pdf").read_bytes() == b"old PDF fixture"


def test_failed_build_does_not_reexport_old_pdf(tmp_path, monkeypatch):
    mpath = _make_paper(tmp_path)
    paper = mpath.parent
    (paper / "main.pdf").write_bytes(b"old PDF fixture")
    monkeypatch.setattr(cm, "_have_latexmk", lambda: True)
    monkeypatch.setattr(cm.subprocess, "run", lambda command, **kw: subprocess.CompletedProcess(command, 1, "", "compile error"))
    assert _invoke_build(monkeypatch, mpath) == 2
    export = json.loads((paper / "export_manifest.json").read_text())
    assert export["compile"]["status"] == "failed"
    assert export["compile"]["pdf"] is None


def test_successful_exit_without_pdf_is_not_build_success(tmp_path, monkeypatch):
    mpath = _make_paper(tmp_path)
    (mpath.parent / "main.pdf").write_bytes(b"old PDF fixture")
    monkeypatch.setattr(cm, "_have_latexmk", lambda: True)
    monkeypatch.setattr(cm.subprocess, "run", lambda command, **kw: subprocess.CompletedProcess(command, 0, "", ""))
    assert _invoke_build(monkeypatch, mpath) == 2
    export = json.loads((mpath.parent / "export_manifest.json").read_text())
    assert export["status"] == "failed"
    assert export["compile"]["pdf"] is None
    assert (mpath.parent / "main.pdf").read_bytes() == b"old PDF fixture"


def test_parse_failure_invalidates_an_earlier_success_receipt(tmp_path, monkeypatch):
    mpath = _make_paper(tmp_path)
    monkeypatch.setattr(sys, "argv", [str(_MOD), "--paper-manifest", str(mpath)])
    assert cm.main() == 0
    mpath.write_text("{broken json")
    assert _invoke_build(monkeypatch, mpath) == 2
    export = json.loads((mpath.parent / "export_manifest.json").read_text())
    assert export["status"] == "failed"
    assert export["compile"]["pdf"] is None


def test_new_recorder_dependency_requires_a_bound_recompile(tmp_path, monkeypatch):
    import hashlib

    mpath = _make_paper(tmp_path)
    paper = mpath.parent
    (tmp_path / "project_charter.md").write_text("Project\n")
    (tmp_path / "research_contract.md").write_text("Contract\n")
    dependency = tmp_path / "derived.tex"
    dependency.write_bytes(b"Original source")
    calls = []
    monkeypatch.setattr(cm, "_have_latexmk", lambda: True)

    def compiler(command, **kwargs):
        calls.append(command.copy())
        out = Path(next(arg.split("=", 1)[1] for arg in command if arg.startswith("-outdir=")))
        (out / "main.pdf").write_bytes(dependency.read_bytes())
        (out / "main.fls").write_text(f"PWD {paper}\nINPUT {paper / 'main.tex'}\nINPUT {dependency}\n")
        if len(calls) == 1:
            dependency.write_bytes(b"Updated after discovery")
        return subprocess.CompletedProcess(command, 0, "", "")

    monkeypatch.setattr(cm.subprocess, "run", compiler)
    assert _invoke_build(monkeypatch, mpath) == 0
    assert len(calls) == 2 and "-g" in calls[1]
    export = json.loads((paper / "export_manifest.json").read_text())
    assert (paper / "main.pdf").read_bytes() == dependency.read_bytes()
    assert export["input_hashes"]["../derived.tex"] == hashlib.sha256(dependency.read_bytes()).hexdigest()


def test_dependency_mutating_during_bound_recompile_cannot_publish_success(tmp_path, monkeypatch):
    mpath = _make_paper(tmp_path)
    paper = mpath.parent
    (tmp_path / "project_charter.md").write_text("Project\n")
    (tmp_path / "research_contract.md").write_text("Contract\n")
    dependency = tmp_path / "derived.tex"
    dependency.write_bytes(b"Original source")
    (paper / "main.pdf").write_bytes(b"Previously published PDF")
    calls = []
    monkeypatch.setattr(cm, "_have_latexmk", lambda: True)

    def compiler(command, **kwargs):
        calls.append(command.copy())
        out = Path(next(arg.split("=", 1)[1] for arg in command if arg.startswith("-outdir=")))
        (out / "main.pdf").write_bytes(dependency.read_bytes())
        (out / "main.fls").write_text(f"PWD {paper}\nINPUT {paper / 'main.tex'}\nINPUT {dependency}\n")
        dependency.write_bytes(dependency.read_bytes() + b" changed")
        return subprocess.CompletedProcess(command, 0, "", "")

    monkeypatch.setattr(cm.subprocess, "run", compiler)
    assert _invoke_build(monkeypatch, mpath) == 2
    assert len(calls) == 2
    export = json.loads((paper / "export_manifest.json").read_text())
    assert export["status"] == "failed" and export["compile"]["pdf"] is None
    assert (paper / "main.pdf").read_bytes() == b"Previously published PDF"
