from __future__ import annotations

import importlib.util
import hashlib
import json
import os
import shutil
import subprocess
import sys
from contextlib import contextmanager
from pathlib import Path

import pytest


def _load_module():
    repo_root = Path(__file__).resolve().parents[1]
    module_path = repo_root / "scripts" / "bin" / "export_paper_bundle.py"
    spec = importlib.util.spec_from_file_location("export_paper_bundle", module_path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"Failed to load module spec: {module_path}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


@contextmanager
def _pushd(path: Path):
    old = Path.cwd()
    os.chdir(path)
    try:
        yield
    finally:
        os.chdir(old)


def _run_main_with_argv(mod, argv: list[str], cwd: Path) -> int:
    old_argv = sys.argv
    with _pushd(cwd):
        try:
            sys.argv = argv
            return mod.main()
        finally:
            sys.argv = old_argv


def _write_project_docs(root: Path) -> None:
    for name in ("project_index.md", "project_charter.md", "research_plan.md", "research_preflight.md", "research_contract.md"):
        (root / name).write_text(f"# {name}\n", encoding="utf-8")


def test_collect_tex_dependencies_follows_inputs_and_graphics(tmp_path: Path) -> None:
    mod = _load_module()
    paper = tmp_path / "paper"
    paper.mkdir()
    (paper / "main.tex").write_text("\\input{sections/intro}\n\\includegraphics{figs/plot}\n", encoding="utf-8")
    (paper / "sections").mkdir()
    (paper / "sections" / "intro.tex").write_text("Intro\n", encoding="utf-8")
    (paper / "figs").mkdir()
    (paper / "figs" / "plot.png").write_text("png", encoding="utf-8")

    deps, warnings = mod.collect_tex_dependencies(paper / "main.tex")

    assert warnings == []
    assert [path.name for path in deps] == ["main.tex", "plot.png", "intro.tex"]


def test_main_requires_force_to_overwrite_existing_bundle(tmp_path: Path) -> None:
    mod = _load_module()
    _write_project_docs(tmp_path)
    existing = tmp_path / "export" / "paper_bundle_M3-r1"
    existing.mkdir(parents=True)
    (existing / "stale.txt").write_text("stale\n", encoding="utf-8")

    assert _run_main_with_argv(mod, ["export_paper_bundle.py", "--tag", "M3-r1"], tmp_path) == 2
    assert _run_main_with_argv(mod, ["export_paper_bundle.py", "--tag", "M3-r1", "--force"], tmp_path) == 0
    assert not (existing / "stale.txt").exists()


def test_bundle_keeps_notebook_cross_run_and_tex_links_after_moving(tmp_path: Path) -> None:
    mod = _load_module()
    project = tmp_path / "source"
    project.mkdir()
    _write_project_docs(project)
    notebook = b"# Research notes\r\n[Project](project_index.md)\r\n[Result](artifacts/runs/R2/report.md)\r\n"
    (project / "research_notebook.md").write_bytes(notebook)
    (project / "project_index.md").write_text("[Notebook](research_notebook.md)\n")
    r1 = project / "artifacts/runs/R1"
    r1.mkdir(parents=True)
    (r1 / "data.csv").write_text("x,y\n1,2\n")
    r2 = project / "artifacts/runs/R2"
    r2.mkdir()
    (r2 / "report.md").write_text("[Data](../R1/data.csv)\n")
    (r2 / "linked.csv").symlink_to("../R1/data.csv")
    paper = project / "paper"
    (paper / "sections").mkdir(parents=True)
    (paper / "figures").mkdir()
    (paper / "main.tex").write_text("\\documentclass{article}\n\\input{sections/results}\n\\bibliography{refs}\n")
    (paper / "sections/results.tex").write_text("\\includegraphics{figures/result}\n")
    # Byte fixtures verify paths and copying, not PDF rendering or scientific validity.
    (paper / "figures/result.pdf").write_bytes(b"synthetic figure bytes")
    (paper / "main.pdf").write_bytes(b"synthetic reading PDF bytes")
    (paper / "refs.bib").write_text("@article{fixture,title={Fixture}}\n")
    before = (paper / "main.tex").read_bytes()
    assert _run_main_with_argv(mod, ["export_paper_bundle.py", "--tag", "R2", "--tex", "paper/main.tex", "--include", "paper/main.pdf"], project) == 0
    moved = tmp_path / "different-root/delivered"
    moved.parent.mkdir()
    shutil.move(str(project / "export/paper_bundle_R2"), moved)
    shutil.rmtree(project)
    assert (moved / "research_notebook.md").read_bytes() == notebook
    assert (moved / "project_index.md").is_file()
    assert (moved / "artifacts/runs/R2/../R1/data.csv").read_text() == "x,y\n1,2\n"
    assert not (moved / "artifacts/runs/R2/linked.csv").is_symlink()
    assert (moved / "artifacts/runs/R2/linked.csv").read_text() == "x,y\n1,2\n"
    assert (moved / "paper/main.tex").read_bytes() == before
    assert (moved / "paper/refs.bib").is_file()
    assert (moved / "paper/figures/result.pdf").read_bytes() == b"synthetic figure bytes"
    assert (moved / "paper/main.pdf").read_bytes() == b"synthetic reading PDF bytes"
    assert not (moved / "docs").exists()


def test_explicit_writer_export_forms_small_self_contained_selection(tmp_path: Path) -> None:
    mod = _load_module()
    _write_project_docs(tmp_path)
    (tmp_path / "project_index.md").write_text("[Unselected history](missing-history.md)\n")
    paper = tmp_path / "paper"
    paper.mkdir()
    (paper / "article.tex").write_text("\\bibliography{refs}\n")
    (paper / "refs.bib").write_text("@article{fixture,title={Fixture}}\n")
    (paper / "article.pdf").write_bytes(b"synthetic PDF bytes; path check only")
    manifest = {"schemaVersion": 1, "tool": "research-writer", "status": "ok",
                "paper": {"main_tex": "article.tex", "bib": ["refs.bib"]},
                "compile": {"requested": True, "status": "ok", "pdf": "article.pdf"},
                "input_hashes": {name: hashlib.sha256((paper / name).read_bytes()).hexdigest() for name in ("article.tex", "refs.bib")},
                "output_hashes": {"article.pdf": hashlib.sha256((paper / "article.pdf").read_bytes()).hexdigest()}}
    (paper / "export_manifest.json").write_text(json.dumps(manifest))
    assert _run_main_with_argv(mod, ["export_paper_bundle.py", "--tag", "stage", "--without-project-docs", "--writer-export", "paper/export_manifest.json"], tmp_path) == 0
    bundle = tmp_path / "export/paper_bundle_stage"
    assert (bundle / "paper/article.pdf").is_file()
    assert (bundle / "paper/refs.bib").is_file()
    assert not (bundle / "project_index.md").exists()
    assert "[paper/article.pdf](paper/article.pdf)" in (bundle / "MANIFEST.md").read_text()
    manifest["compile"]["status"] = "failed"
    (paper / "export_manifest.json").write_text(json.dumps(manifest))
    assert _run_main_with_argv(mod, ["export_paper_bundle.py", "--tag", "failed", "--without-project-docs", "--writer-export", "paper/export_manifest.json"], tmp_path) == 2
    assert not (tmp_path / "export/paper_bundle_failed").exists()


def test_missing_link_fails_without_rewriting_source_or_old_bundle(tmp_path: Path) -> None:
    mod = _load_module()
    _write_project_docs(tmp_path)
    source = b"# Index\r\n[Missing](missing.md)\r\n"
    (tmp_path / "project_index.md").write_bytes(source)
    old = tmp_path / "export/paper_bundle_stage"
    old.mkdir(parents=True)
    (old / "previous.md").write_text("previous complete bundle\n")
    assert _run_main_with_argv(mod, ["export_paper_bundle.py", "--tag", "stage", "--force"], tmp_path) == 2
    assert (tmp_path / "project_index.md").read_bytes() == source
    assert (old / "previous.md").read_text() == "previous complete bundle\n"


@pytest.mark.parametrize("target", ["../outside.dat", "missing.dat"])
def test_missing_or_escaping_symlink_is_not_exported(tmp_path: Path, target: str) -> None:
    mod = _load_module()
    project = tmp_path / "project"
    project.mkdir()
    _write_project_docs(project)
    (tmp_path / "outside.dat").write_bytes(b"outside the project")
    (project / "result.dat").symlink_to(target)
    assert _run_main_with_argv(mod, ["export_paper_bundle.py", "--tag", "stage", "--without-project-docs", "--include", "result.dat"], project) == 2
    assert not (project / "export/paper_bundle_stage").exists()


def test_directory_reference_copies_actual_children_and_reference_links(tmp_path: Path) -> None:
    mod = _load_module()
    _write_project_docs(tmp_path)
    (tmp_path / "research_notebook.md").write_text("[Results][runs]\n\n[runs]: artifacts/runs/ \"nullius-navigation\"\n")
    for name in ("A", "B"):
        folder = tmp_path / "artifacts/runs" / name
        folder.mkdir(parents=True)
        (folder / "result.md").write_text(f"# Result {name}\n")
    assert _run_main_with_argv(mod, ["export_paper_bundle.py", "--tag", "A"], tmp_path) == 0
    bundle = tmp_path / "export/paper_bundle_A"
    assert (bundle / "artifacts/runs/A/result.md").is_file()
    assert (bundle / "artifacts/runs/B/result.md").is_file()


def test_duplicate_reference_uses_first_target_after_moving(tmp_path: Path) -> None:
    mod = _load_module()
    project = tmp_path / "source"
    project.mkdir()
    _write_project_docs(project)
    report = "[Evidence][result]\n\n[result]: first.csv\n[RESULT]: second.csv\n"
    (project / "report.md").write_text(report)
    (project / "first.csv").write_text("x,y\n1,2\n")
    (project / "second.csv").write_text("x,y\n3,4\n")
    assert _run_main_with_argv(mod, ["export_paper_bundle.py", "--tag", "stage", "--without-project-docs", "--include", "report.md"], project) == 0
    moved = tmp_path / "different-root/delivered"
    moved.parent.mkdir()
    shutil.move(str(project / "export/paper_bundle_stage"), moved)
    shutil.rmtree(project)
    assert (moved / "report.md").read_text() == report
    assert (moved / "first.csv").read_text() == "x,y\n1,2\n"
    assert not (moved / "second.csv").exists()


def test_code_examples_are_not_dependencies_but_titled_links_are(tmp_path: Path) -> None:
    mod = _load_module()
    _write_project_docs(tmp_path)
    (tmp_path / "research_notebook.md").write_text(
        '`[example](missing-inline.md)`\n'
        '```markdown\n[example](missing-fence.md)\n```\n'
        '[Project](project_index.md "nullius-navigation") and [Data](data.csv "data")\n'
    )
    (tmp_path / "data.csv").write_text("x,y\n1,2\n")
    assert _run_main_with_argv(mod, ["export_paper_bundle.py", "--tag", "notes"], tmp_path) == 0
    bundle = tmp_path / "export/paper_bundle_notes"
    assert (bundle / "project_index.md").is_file()
    assert (bundle / "data.csv").is_file()
    assert not (bundle / "missing-inline.md").exists()


def test_read_first_link_escapes_spaces_and_parentheses(tmp_path: Path) -> None:
    mod = _load_module()
    _write_project_docs(tmp_path)
    report = tmp_path / "reports/stage report (final).md"
    report.parent.mkdir()
    report.write_text("# Result\n")
    assert _run_main_with_argv(mod, ["export_paper_bundle.py", "--tag", "stage", "--without-project-docs", "--include", "reports/stage report (final).md"], tmp_path) == 0
    bundle = tmp_path / "export/paper_bundle_stage"
    manifest = (bundle / "MANIFEST.md").read_text()
    assert "(reports/stage%20report%20%28final%29.md)" in manifest
    assert (bundle / "reports/stage report (final).md").read_text() == "# Result\n"


@pytest.mark.parametrize("changed", ["main.tex", "sections/result.tex", "references_generated.bib", "figures/result.pdf", "../artifacts/runs/R1/inputs.csv", "../artifacts/runs/R1/extra.bib", "main.pdf"])
def test_writer_receipt_rejects_source_or_output_drift(tmp_path: Path, monkeypatch, changed: str) -> None:
    mod = _load_module()
    source = Path(__file__).resolve().parents[2] / "research-writer/scripts/bin/research_writer_consume_paper_manifest.py"
    spec = importlib.util.spec_from_file_location("consume_for_export_fixture", source)
    consumer = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = consumer
    spec.loader.exec_module(consumer)
    project = tmp_path / "project"
    project.mkdir()
    _write_project_docs(project)
    paper = project / "paper"
    (paper / "figures").mkdir(parents=True)
    (paper / "sections").mkdir()
    (paper / "main.tex").write_text("\\documentclass{article}\n\\input{sections/result}\n\\includegraphics{figures/result.pdf}\n\\bibliography{references_generated,../artifacts/runs/R1/extra}\n")
    (paper / "sections/result.tex").write_text("Result: 1.\n")
    (paper / "references_generated.bib").write_text("@article{A,title={A}}\n")
    (paper / "figures/result.pdf").write_bytes(b"synthetic figure bytes")
    cross_run = project / "artifacts/runs/R1/inputs.csv"
    cross_run.parent.mkdir(parents=True)
    cross_run.write_text("x,y\n1,2\n")
    (cross_run.parent / "extra.bib").write_text("@article{Extra,title={Extra}}\n")
    environment = tmp_path / "tex-environment.cls"
    environment.write_text("external build environment fixture\n")
    manifest = {"schemaVersion": 1, "mainTex": "main.tex", "figuresDir": "figures", "bib": {"generated": "references_generated.bib"}}
    (paper / "paper_manifest.json").write_text(json.dumps(manifest))
    monkeypatch.setattr(consumer, "_have_latexmk", lambda: True)

    def compile_fixture(command, **kwargs):
        assert "-recorder" in command
        build = Path(next(arg.split("=", 1)[1] for arg in command if arg.startswith("-outdir=")))
        (build / "main.pdf").write_bytes(b"synthetic current PDF; not rendered\n" + (paper / "main.tex").read_bytes())
        (build / "main.fls").write_text(f"PWD {paper}\nINPUT {paper / 'main.tex'}\nINPUT {paper / 'sections/result.tex'}\nINPUT {cross_run}\nINPUT {environment}\n")
        return subprocess.CompletedProcess(command, 0, "", "")

    monkeypatch.setattr(consumer.subprocess, "run", compile_fixture)
    monkeypatch.setattr(sys, "argv", [str(source), "--paper-manifest", str(paper / "paper_manifest.json"), "--compile"])
    assert consumer.main() == 0
    receipt = json.loads((paper / "export_manifest.json").read_text())
    assert "../artifacts/runs/R1/inputs.csv" in receipt["input_hashes"]
    assert not any("tex-environment" in key for key in receipt["input_hashes"])
    environment.unlink()  # Another host need not retain the old TeX absolute path.
    args = ["export_paper_bundle.py", "--tag", "good", "--without-project-docs", "--writer-export", "paper/export_manifest.json"]
    assert _run_main_with_argv(mod, args, project) == 0
    assert (project / "export/paper_bundle_good/artifacts/runs/R1/inputs.csv").is_file()
    target = paper / changed
    target.write_bytes(target.read_bytes() + b"\nchanged after build\n")
    args[2] = "drifted"
    assert _run_main_with_argv(mod, args, project) == 2
    assert not (project / "export/paper_bundle_drifted").exists()
