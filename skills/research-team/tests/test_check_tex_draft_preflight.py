from __future__ import annotations

import importlib.util
import json
import sys
from pathlib import Path


def _load_gate_module():
    repo_root = Path(__file__).resolve().parents[1]
    module_path = repo_root / "scripts" / "gates" / "check_tex_draft_preflight.py"
    spec = importlib.util.spec_from_file_location("check_tex_draft_preflight", module_path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"Failed to load module spec: {module_path}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def _run_main_with_argv(mod, argv: list[str]) -> int:
    old_argv = sys.argv
    try:
        sys.argv = argv
        return mod.main()
    finally:
        sys.argv = old_argv


def test_resolve_graphics_prefers_graphicspath_and_extensions(tmp_path: Path) -> None:
    mod = _load_gate_module()
    tex_dir = tmp_path / "tex"
    figs = tex_dir / "figs"
    figs.mkdir(parents=True)
    (figs / "plot.png").write_text("png", encoding="utf-8")
    from_path = tex_dir / "main.tex"
    from_path.write_text("\\includegraphics{plot}\n", encoding="utf-8")

    found = mod._resolve_graphics("plot", from_path, tex_dir, [figs])

    assert found == [(figs / "plot.png").resolve()]


def test_main_returns_fail_for_missing_bib_key_and_writes_outputs(tmp_path: Path) -> None:
    mod = _load_gate_module()
    tex = tmp_path / "main.tex"
    bib = tmp_path / "references.bib"
    out_json = tmp_path / "out" / "structure.json"
    out_report = tmp_path / "out" / "report.md"
    tex.write_text("\\section{Alpha}\\nWe cite \\cite{MissingKey}.\\n", encoding="utf-8")
    bib.write_text("@article{PresentKey, title={Present}}\\n", encoding="utf-8")

    rc = _run_main_with_argv(
        mod,
        [
            "check_tex_draft_preflight.py",
            "--tex",
            str(tex),
            "--bib",
            str(bib),
            "--out-json",
            str(out_json),
            "--out-report",
            str(out_report),
        ],
    )

    assert rc == 1
    obj = json.loads(out_json.read_text(encoding="utf-8"))
    assert obj["citations"]["missing_in_bib"] == ["MissingKey"]
    assert "MissingKey" in out_report.read_text(encoding="utf-8")


def test_main_warns_only_for_missing_labels_figures_and_kb(tmp_path: Path) -> None:
    """Missing labels and figure files are WARNING-level (rc stays 0); only
    missing bib keys are hard failures. The fixture pins the repaired
    extractor: an undefined reference and a genuinely absent figure (with a
    bracketed width argument) must both be REPORTED — the original port
    asserted both lists empty, which merely characterized the era when the
    label/ref/figure regexes never matched anything."""
    mod = _load_gate_module()
    tex = tmp_path / "main.tex"
    bib = tmp_path / "references.bib"
    out_json = tmp_path / "out" / "structure.json"
    tex.write_text(
        "\\documentclass{article}\n"
        "\\usepackage{graphicx}\n"
        "\\graphicspath{{figs/}}\n"
        "\\begin{document}\n"
        "\\section{Results}\\label{sec:results}\n"
        "See Sec.~\\ref{eq:missing}. \\includegraphics{plot} \\cite{Key1}\n"
        "\\includegraphics[width=0.5\\textwidth]{ghost}\n"
        "\\end{document}\n",
        encoding="utf-8",
    )
    bib.write_text("@article{Key1, title={Key1}}\\n", encoding="utf-8")
    figs = tmp_path / "figs"
    figs.mkdir()
    (figs / "plot.png").write_text("png", encoding="utf-8")

    assert _run_main_with_argv(mod, ["check_tex_draft_preflight.py", "--tex", str(tex), "--bib", str(bib), "--out-json", str(out_json)]) == 0
    obj = json.loads(out_json.read_text(encoding="utf-8"))
    assert obj["labels"]["missing"] == ["eq:missing"]
    missing_specs = [entry["spec"] for entry in obj["figures"]["missing"]]
    assert missing_specs == ["ghost"]
    assert obj["kb_notes"]["missing"] == ["Key1"]


def test_main_returns_input_error_for_missing_paths(tmp_path: Path) -> None:
    mod = _load_gate_module()
    tex = tmp_path / "missing.tex"
    bib = tmp_path / "references.bib"
    bib.write_text("@article{Key1, title={Key1}}\\n", encoding="utf-8")

    assert _run_main_with_argv(mod, ["check_tex_draft_preflight.py", "--tex", str(tex), "--bib", str(bib)]) == 2
