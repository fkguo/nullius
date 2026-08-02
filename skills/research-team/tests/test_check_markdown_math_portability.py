from __future__ import annotations

import importlib.util
import json
import sys
from pathlib import Path


def _load_gate_module():
    repo_root = Path(__file__).resolve().parents[1]
    module_path = repo_root / "scripts" / "gates" / "check_markdown_math_portability.py"
    spec = importlib.util.spec_from_file_location("check_markdown_math_portability", module_path)
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


def test_scan_file_warns_for_slashed_and_table_math_pipe_but_ignores_code(tmp_path: Path) -> None:
    mod = _load_gate_module()
    md = tmp_path / "sample.md"
    md.write_text(
        """| expr | note |
| --- | --- |
| $a | b$ | flagged |

Inline: $\\slashed{p}$.
Code span: `\\slashed{q}`.

```text
| $c | d$ | not real |
\\slashed{r}
```
""",
        encoding="utf-8",
    )

    findings = mod._scan_file(md)

    assert [(finding.kind, finding.line) for finding in findings] == [
        ("table_math_pipe", 3),
        ("slashed", 5),
    ]


def test_main_warn_only_returns_zero(tmp_path: Path) -> None:
    mod = _load_gate_module()
    notes = tmp_path / "research_contract.md"
    notes.write_text("Inline: $\\slashed{p}$.\n", encoding="utf-8")
    (tmp_path / "project_charter.md").write_text("Project charter.\n", encoding="utf-8")
    (tmp_path / "research_team_config.json").write_text(
        json.dumps(
            {
                "features": {"markdown_math_portability_gate": True},
                "markdown_math_portability": {
                    "targets": ["research_contract.md"],
                    "exclude_globs": [],
                    "enforce_table_math_pipes": False,
                    "enforce_slashed": False,
                },
            },
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )

    assert _run_main_with_argv(mod, ["check_markdown_math_portability.py", "--notes", str(notes)]) == 0


def test_main_enforces_table_math_pipes_when_configured(tmp_path: Path) -> None:
    mod = _load_gate_module()
    notes = tmp_path / "research_contract.md"
    notes.write_text("| expr | note |\n| --- | --- |\n| $a | b$ | flagged |\n", encoding="utf-8")
    (tmp_path / "project_charter.md").write_text("Project charter.\n", encoding="utf-8")
    (tmp_path / "research_team_config.json").write_text(
        json.dumps(
            {
                "features": {"markdown_math_portability_gate": True},
                "markdown_math_portability": {
                    "targets": ["research_contract.md"],
                    "exclude_globs": [],
                    "enforce_table_math_pipes": True,
                    "enforce_slashed": False,
                },
            },
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )

    assert _run_main_with_argv(mod, ["check_markdown_math_portability.py", "--notes", str(notes)]) == 1


def test_main_enforces_slashed_when_configured(tmp_path: Path) -> None:
    mod = _load_gate_module()
    notes = tmp_path / "research_contract.md"
    notes.write_text("Inline: $\\slashed{p}$.\n", encoding="utf-8")
    (tmp_path / "project_charter.md").write_text("Project charter.\n", encoding="utf-8")
    (tmp_path / "research_team_config.json").write_text(
        json.dumps(
            {
                "features": {"markdown_math_portability_gate": True},
                "markdown_math_portability": {
                    "targets": ["research_contract.md"],
                    "exclude_globs": [],
                    "enforce_table_math_pipes": False,
                    "enforce_slashed": True,
                },
            },
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )

    assert _run_main_with_argv(mod, ["check_markdown_math_portability.py", "--notes", str(notes)]) == 1
