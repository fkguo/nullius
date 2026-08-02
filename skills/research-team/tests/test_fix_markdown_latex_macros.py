from __future__ import annotations

import importlib.util
import json
import sys
from pathlib import Path


def _load_fixer_module():
    repo_root = Path(__file__).resolve().parents[1]
    module_path = repo_root / "scripts" / "bin" / "fix_markdown_latex_macros.py"
    spec = importlib.util.spec_from_file_location("fix_markdown_latex_macros", module_path)
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


def test_normalize_expands_macros_but_preserves_code_spans_and_fences() -> None:
    mod = _load_fixer_module()
    macro_re = mod._compile_macro_re(["Rc", "Mc"])
    original = """Inline $\\Rc$ and code `\\Rc`.

```text
\\Rc should stay as-is
```

$\\Mc$
"""

    fixed, changes = mod._normalize(original, macro_re, {"Rc": "{\\mathcal{R}}", "Mc": "{\\mathcal{M}}"})

    assert "{\\mathcal{R}}" in fixed
    assert "`\\Rc`" in fixed
    assert "\\Rc should stay as-is" in fixed
    assert "{\\mathcal{M}}" in fixed
    assert len(changes) == 2


def test_main_detect_and_in_place_modes(tmp_path: Path) -> None:
    mod = _load_fixer_module()
    md = tmp_path / "sample.md"
    md.write_text("Inline $\\Rc$.\n", encoding="utf-8")

    assert _run_main_with_argv(mod, ["fix_markdown_latex_macros.py", "--root", str(tmp_path)]) == 1
    assert _run_main_with_argv(mod, ["fix_markdown_latex_macros.py", "--root", str(tmp_path), "--in-place"]) == 0
    assert "{\\mathcal{R}}" in md.read_text(encoding="utf-8")


def test_main_returns_input_error_when_forbidden_macro_lacks_expansion(tmp_path: Path) -> None:
    mod = _load_fixer_module()
    md = tmp_path / "sample.md"
    md.write_text("Inline $\\Rc$ and $\\ZZ$.\n", encoding="utf-8")
    (tmp_path / "research_team_config.json").write_text(
        json.dumps(
            {
                "latex_macro_hygiene": {
                    "forbidden_macros": ["Rc", "ZZ"],
                    "expansions": {"Rc": "{\\mathcal{R}}"},
                }
            },
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )

    assert _run_main_with_argv(mod, ["fix_markdown_latex_macros.py", "--root", str(tmp_path)]) == 2


def test_load_macro_config_uses_team_config_overrides(tmp_path: Path) -> None:
    mod = _load_fixer_module()
    (tmp_path / "research_team_config.json").write_text(
        json.dumps(
            {
                "latex_macro_hygiene": {
                    "forbidden_macros": ["Rc", "ZZ"],
                    "expansions": {"Rc": "{\\mathcal{R}}", "ZZ": "{\\mathbb{Z}}"},
                }
            },
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )

    forbidden, expansions = mod._load_macro_config(tmp_path)

    assert forbidden == ["Rc", "ZZ"]
    assert expansions["ZZ"] == "{\\mathbb{Z}}"
