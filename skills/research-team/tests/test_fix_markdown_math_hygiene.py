from __future__ import annotations

import importlib.util
import sys
from pathlib import Path


def _load_fixer_module():
    repo_root = Path(__file__).resolve().parents[1]
    module_path = repo_root / "scripts" / "bin" / "fix_markdown_math_hygiene.py"
    spec = importlib.util.spec_from_file_location("fix_markdown_math_hygiene", module_path)
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


def test_normalize_prefixes_display_operator_but_ignores_code_fence() -> None:
    mod = _load_fixer_module()
    original = """$$
a = 1
- b = 2
$$

```text
$$
- not math
$$
```
"""

    fixed, changes = mod._normalize(original)

    assert "\\quad - b = 2" in fixed
    assert "```text\n$$\n- not math\n$$\n```" in fixed
    assert [change.kind for change in changes] == ["prefix_operator"]


def test_normalize_merges_split_display_blocks_and_preserves_blank_lines() -> None:
    mod = _load_fixer_module()
    original = """$$
a = 1
$$

$$
\\qquad b = 2
$$
"""

    fixed, changes = mod._normalize(original)

    assert fixed == "$$\na = 1\n\n\\qquad b = 2\n$$\n"
    assert [change.kind for change in changes] == ["merge_split_display"]


def test_normalize_rewrites_simple_inline_display_only() -> None:
    mod = _load_fixer_module()
    original = "$$ x = 1 $$\n$$ a $$ and $$ b $$\n"

    fixed, changes = mod._normalize(original)

    assert fixed == "$$\nx = 1\n$$\n$$ a $$ and $$ b $$\n"
    assert [change.kind for change in changes] == ["inline_display_to_fence"]


def test_main_detect_and_in_place_modes(tmp_path: Path) -> None:
    mod = _load_fixer_module()
    md = tmp_path / "sample.md"
    md.write_text("$$\na = 1\n- b = 2\n$$\n", encoding="utf-8")

    assert _run_main_with_argv(mod, ["fix_markdown_math_hygiene.py", "--root", str(tmp_path)]) == 1
    assert _run_main_with_argv(mod, ["fix_markdown_math_hygiene.py", "--root", str(tmp_path), "--in-place"]) == 0
    assert "\\quad - b = 2" in md.read_text(encoding="utf-8")
