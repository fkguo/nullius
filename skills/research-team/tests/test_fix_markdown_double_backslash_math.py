from __future__ import annotations

import importlib.util
import json
import sys
from pathlib import Path


def _load_fixer_module():
    repo_root = Path(__file__).resolve().parents[1]
    module_path = repo_root / "scripts" / "bin" / "fix_markdown_double_backslash_math.py"
    spec = importlib.util.spec_from_file_location("fix_markdown_double_backslash_math", module_path)
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


def test_fix_text_rewrites_inline_math_but_not_code_span(tmp_path: Path) -> None:
    mod = _load_fixer_module()
    md = tmp_path / "sample.md"
    original = "Inline math: $\\\\Delta = 1$, code span: `\\\\Delta`.\n"

    fixed, changes = mod._fix_text(md, original)

    assert "$\\Delta = 1$" in fixed
    assert "`\\\\Delta`" in fixed
    assert len(changes) == 1
    assert changes[0].kind == "inline_math_double_backslash"


def test_fix_text_rewrites_display_math_block(tmp_path: Path) -> None:
    mod = _load_fixer_module()
    md = tmp_path / "sample.md"
    original = "$$\n\\\\gamma_{\\\\rm lin} = 2\n$$\n"

    fixed, changes = mod._fix_text(md, original)

    assert "\\gamma_{\\rm lin} = 2" in fixed
    assert len(changes) == 1
    assert changes[0].kind == "display_math_double_backslash"


def test_notes_mode_targets_key_docs_but_leaves_old_team_outputs_unchanged(tmp_path: Path) -> None:
    mod = _load_fixer_module()
    notes = tmp_path / "research_contract.md"
    notes.write_text("Inline math: $\\\\Delta = 1$\n", encoding="utf-8")
    (tmp_path / "project_charter.md").write_text("No math here.\n", encoding="utf-8")
    old_report = tmp_path / "team" / "runs" / "old" / "report.md"
    old_report.parent.mkdir(parents=True, exist_ok=True)
    old_report.write_text("Inline: $\\\\Delta = 1$.\n", encoding="utf-8")

    cfg = {
        "features": {"double_backslash_math_gate": True},
        "markdown_math_hygiene": {"targets": ["research_contract.md", "project_charter.md"], "exclude_globs": []},
    }
    (tmp_path / "research_team_config.json").write_text(json.dumps(cfg, indent=2) + "\n", encoding="utf-8")

    assert _run_main_with_argv(mod, ["fix_markdown_double_backslash_math.py", "--notes", str(notes)]) == 1
    assert _run_main_with_argv(mod, ["fix_markdown_double_backslash_math.py", "--notes", str(notes), "--in-place"]) == 0
    assert "$\\Delta = 1$" in notes.read_text(encoding="utf-8")
    assert "$\\\\Delta = 1$" in old_report.read_text(encoding="utf-8")


def test_root_mode_detect_and_in_place_exit_codes(tmp_path: Path) -> None:
    mod = _load_fixer_module()
    md = tmp_path / "sample.md"
    md.write_text("Inline math: $k^\\\\* = 0$\n", encoding="utf-8")

    assert _run_main_with_argv(mod, ["fix_markdown_double_backslash_math.py", "--root", str(tmp_path)]) == 1
    assert _run_main_with_argv(mod, ["fix_markdown_double_backslash_math.py", "--root", str(tmp_path), "--in-place"]) == 0
    assert "$k^\\* = 0$" in md.read_text(encoding="utf-8")
