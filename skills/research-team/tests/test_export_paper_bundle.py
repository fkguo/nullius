from __future__ import annotations

import importlib.util
import os
import sys
from contextlib import contextmanager
from pathlib import Path


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
