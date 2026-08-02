from __future__ import annotations

import importlib.util
import json
import sys
from pathlib import Path


def _load_gate_module():
    repo_root = Path(__file__).resolve().parents[1]
    module_path = repo_root / "scripts" / "gates" / "check_research_plan.py"
    spec = importlib.util.spec_from_file_location("check_research_plan", module_path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"Failed to load module spec: {module_path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _write_project(tmp_path: Path, *, plan_text: str, config: dict) -> tuple[Path, Path]:
    root = tmp_path / "proj"
    root.mkdir()
    notes = root / "research_contract.md"
    notes.write_text("# Notes\n", encoding="utf-8")
    (root / "research_plan.md").write_text(plan_text, encoding="utf-8")
    (root / "research_team_config.json").write_text(json.dumps(config, indent=2) + "\n", encoding="utf-8")
    return root, notes


def _run_main_with_argv(mod, argv: list[str]) -> int:
    old_argv = sys.argv
    try:
        sys.argv = argv
        return mod.main()
    finally:
        sys.argv = old_argv


def test_looks_like_template_detects_placeholder_plan() -> None:
    mod = _load_gate_module()
    assert mod._looks_like_template("research_plan.md (Template)\n- One-sentence objective:\n")


def test_main_passes_when_gate_enabled_and_sections_filled(tmp_path: Path) -> None:
    mod = _load_gate_module()
    _, notes = _write_project(
        tmp_path,
        plan_text="""# Research Plan

## Task Board
- [ ] Build the first bounded slice.

## Progress Log
- 2026-04-14: initialized a real project plan with concrete next steps and evidence.
""",
        config={
            "features": {"research_plan_gate": True},
            "plan_tracking": {"require_task_board": True, "require_progress_log": True},
        },
    )
    assert _run_main_with_argv(mod, ["check_research_plan.py", "--notes", str(notes)]) == 0


def test_main_fails_when_required_task_board_is_missing(tmp_path: Path) -> None:
    mod = _load_gate_module()
    _, notes = _write_project(
        tmp_path,
        plan_text="""# Research Plan

## Progress Log
- 2026-04-14: planning started with real content but the task board is still absent.
""",
        config={
            "features": {"research_plan_gate": True},
            "plan_tracking": {"require_task_board": True, "require_progress_log": True},
        },
    )
    assert _run_main_with_argv(mod, ["check_research_plan.py", "--notes", str(notes)]) == 1


def test_detect_only_reports_filled_plan_as_non_template(tmp_path: Path) -> None:
    mod = _load_gate_module()
    _, notes = _write_project(
        tmp_path,
        plan_text="""# Research Plan

This plan is long enough to avoid template heuristics and already carries concrete text.

## Task Board
- [x] Establish the capability-first scope.
""",
        config={"features": {"research_plan_gate": False}},
    )
    assert _run_main_with_argv(mod, ["check_research_plan.py", "--notes", str(notes), "--detect-only"]) == 1
