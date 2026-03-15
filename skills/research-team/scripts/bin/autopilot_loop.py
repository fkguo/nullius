#!/usr/bin/env python3
"""
Auto-run loop for research-team projects.

Flow:
- Auto-fill research_plan.md if configured and template detected.
- Iterate tasks in research_plan.md (checkbox lines), run team cycle per task.
- Stop on completion or configured failure limits.
"""
from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "lib"))

from task_board_templates import default_task_board_lines  # type: ignore
from team_config import find_config_path, load_team_config  # type: ignore
from kickoff_prompt_utils import looks_approved  # type: ignore


def _load_config(root: Path) -> dict:
    cfg_path = find_config_path(root) if root.is_dir() else None
    if not cfg_path:
        return {}
    try:
        return json.loads(cfg_path.read_text(encoding="utf-8", errors="replace"))
    except Exception:
        return {}


def _find_plan(root: Path) -> Path:
    return root / "research_plan.md"


def _stop_signal(root: Path, names: list[str]) -> Path | None:
    for n in names:
        p = root / n
        if p.exists():
            return p
    return None


def _parse_tasks(text: str, base_line: int = 0) -> list[dict]:
    tasks: list[dict] = []
    for idx, ln in enumerate(text.splitlines()):
        m = re.match(r"^\s*(?:[-*+]|(?:\d+\.))\s+\[( |x|X)\]\s+(.*)$", ln)
        if not m:
            continue
        done = m.group(1).lower() == "x"
        body = m.group(2).strip()
        task_id = None
        if ":" in body:
            head = body.split(":", 1)[0].strip()
            if head and len(head) <= 12:
                task_id = head
        if not task_id:
            task_id = f"T{len(tasks)+1}"
        mode = "auto"
        if "(manual)" in body.lower():
            mode = "manual"
        tasks.append(
            {
                "id": task_id,
                "line_no": base_line + idx,
                "done": done,
                "text": body,
                "raw": ln,
                "mode": mode,
            }
        )
    return tasks


def _extract_task_board(text: str) -> tuple[str, int]:
    lines = text.splitlines()
    for i, ln in enumerate(lines):
        if re.match(r"^\s*#{1,6}\s+Task\s*Board\b", ln, flags=re.IGNORECASE):
            start = i + 1
            end = len(lines)
            for j in range(i + 1, len(lines)):
                if re.match(r"^\s*#{1,6}\s+\S", lines[j]):
                    end = j
                    break
            return "\n".join(lines[start:end]), start
    return text, 0


def _update_task_line(lines: list[str], line_no: int, done: bool) -> None:
    ln = lines[line_no]
    if "- [x]" in ln or "- [X]" in ln:
        if done:
            return
        lines[line_no] = ln.replace("- [x]", "- [ ]").replace("- [X]", "- [ ]")
        return
    if "- [ ]" in ln and done:
        lines[line_no] = ln.replace("- [ ]", "- [x]")


def _run(cmd: list[str]) -> int:
    proc = subprocess.run(cmd)
    return proc.returncode


def _run_markdown_safety_fixes(*, root: Path, notes: Path) -> int:
    """
    Best-effort deterministic hygiene fixes for common LLM/TOC artifacts.

    Rationale: autopilot is meant to be agent-first; it should proactively repair
    common Markdown hazards instead of stopping on avoidable preflight failures.
    """
    fixes: list[tuple[str, list[str]]] = [
        # Fix over-escaped LaTeX backslashes in math regions, e.g. \\Delta -> \Delta.
        ("fix_markdown_double_backslash_math.py", ["--notes", str(notes), "--in-place"]),
        # Make Capsule I) KB links human-readable: RefKey — Authors — Title.
        ("format_kb_reference_links.py", ["--notes", str(notes), "--in-place"]),
    ]
    for script, extra in fixes:
        p = Path(__file__).with_name(script)
        if not p.is_file():
            continue
        code = _run(["python3", str(p), *extra])
        if code == 2:
            print(f"[stop] markdown fix failed: {p.name} (exit=2)")
            return 2
    return 0


def _ensure_task_board(plan_path: Path) -> bool:
    text = plan_path.read_text(encoding="utf-8", errors="replace")
    if "## Task Board" in text:
        return False
    team_cfg = load_team_config(plan_path)
    profile = str(getattr(team_cfg, "data", {}).get("profile", "")).strip() if hasattr(team_cfg, "data") else ""
    lines = text.splitlines()
    lines.append("")
    lines.append("## Task Board")
    lines.append("")
    lines.extend(default_task_board_lines(profile))
    plan_path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    return True


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--root", type=Path, default=Path.cwd(), help="Project root (default: cwd).")
    ap.add_argument("--notes", type=Path, default=None, help="Notebook path (default: research_contract.md).")
    ap.add_argument("--out-dir", type=Path, default=None, help="Team output directory (default: team).")
    ap.add_argument("--once", action="store_true", help="Run at most one task.")
    ap.add_argument("--mode", choices=["auto", "assist"], default="auto", help="Assist mode pauses on manual tasks.")
    ap.add_argument("--max-rounds", type=int, default=None, help="Override max rounds.")
    ap.add_argument(
        "--reset-state",
        action="store_true",
        help="Reset autopilot retry/progress counters by deleting out_dir/autopilot_state.json before running.",
    )
    args = ap.parse_args()

    root = args.root.resolve()
    notes = args.notes or (root / "research_contract.md")
    out_dir = args.out_dir or (root / "team")

    cfg = _load_config(root)
    auto_cfg = cfg.get("automation", {}) if isinstance(cfg.get("automation", {}), dict) else {}

    # Optional kickoff prompt generation/approval step (human-in-the-loop start).
    kickoff_cfg = auto_cfg.get("kickoff_prompt", {}) if isinstance(auto_cfg.get("kickoff_prompt", {}), dict) else {}
    kickoff_enabled = bool(kickoff_cfg.get("enabled", False))
    if kickoff_enabled:
        kickoff_path = str(kickoff_cfg.get("path", "PROJECT_START_PROMPT.md"))
        require_approval = bool(kickoff_cfg.get("require_approval", False))
        approved_marker = str(kickoff_cfg.get("approved_marker", "Status: APPROVED")).strip()
        if require_approval and (not approved_marker or len(approved_marker) < 2):
            print("[stop] kickoff_prompt.approved_marker is invalid/too short:", repr(approved_marker))
            return 2
        kickoff_file = Path(kickoff_path)
        if not kickoff_file.is_absolute():
            kickoff_file = (root / kickoff_file).resolve()
        else:
            kickoff_file = kickoff_file.resolve()
        # Reject paths escaping the project root (safety/clarity).
        try:
            kickoff_file.relative_to(root)
        except Exception:
            print("[stop] kickoff_prompt.path must be inside project root:", kickoff_file)
            return 2

        gen_script = Path(__file__).with_name("generate_project_start_prompt.py")
        generated = False
        if not kickoff_file.is_file() and gen_script.is_file():
            cmd = ["python3", str(gen_script), "--root", str(root), "--out", str(kickoff_file)]
            if approved_marker:
                cmd.extend(["--approved-marker", approved_marker])
            code = _run(cmd)
            if code != 0:
                print("[stop] failed to generate kickoff prompt; ensure initial instruction exists and rerun.")
                return 2
            generated = True
        if require_approval:
            if not kickoff_file.is_file():
                print("[stop] kickoff prompt missing and could not be generated:", kickoff_file)
                return 2
            txt = kickoff_file.read_text(encoding="utf-8", errors="replace")
            if not looks_approved(txt, approved_marker):
                if generated:
                    print("[stop] kickoff prompt generated; review and approve before auto-run.")
                else:
                    print("[stop] kickoff prompt requires approval before auto-run.")
                print("  - file:", kickoff_file)
                print("  - set:", approved_marker)
                return 0

    enable_autofill = bool(auto_cfg.get("enable_autofill", True))
    auto_run = bool(auto_cfg.get("auto_run", True))
    max_rounds = int(auto_cfg.get("max_rounds", 10))
    max_retries = int(auto_cfg.get("max_retries_per_task", 3))
    no_progress_rounds = int(auto_cfg.get("no_progress_rounds", 2))
    stop_files = auto_cfg.get("stop_files", [".stop", ".pause", "STOP"])
    require_executor = bool(auto_cfg.get("require_executor", False))
    pause_on_manual = bool(auto_cfg.get("pause_on_manual", True))
    warn_if_no_executor = bool(auto_cfg.get("warn_if_no_executor", True))
    if args.max_rounds is not None:
        max_rounds = args.max_rounds

    plan = _find_plan(root)
    if enable_autofill:
        check_script = Path(__file__).resolve().parent.parent / "gates" / "check_research_plan.py"
        check_cmd = [
            "python3",
            str(check_script),
            "--notes",
            str(notes),
            "--detect-only",
        ]
        code = _run(check_cmd)
        if code == 0:
            fill_cmd = [
                "python3",
                str(Path(__file__).with_name("auto_fill_research_plan.py")),
                "--root",
                str(root),
            ]
            if _run(fill_cmd) != 0:
                return 2
        # After auto-fill, proactively repair common Markdown hazards (agent-first hygiene).
        if _run_markdown_safety_fixes(root=root, notes=notes) != 0:
            return 2

    if not auto_run:
        print("[info] auto_run disabled by config; exiting after auto-fill.")
        return 0

    if not plan.is_file():
        print("ERROR: research_plan.md not found.")
        return 2

    if _ensure_task_board(plan):
        print("[info] Task Board missing; added a minimal Task Board.")

    if not notes.is_file():
        print(f"ERROR: notes not found: {notes}")
        return 2

    member_a_system = root / "prompts/_system_member_a.txt"
    member_b_system = root / "prompts/_system_member_b.txt"
    if not member_a_system.is_file() or not member_b_system.is_file():
        print("ERROR: missing prompts/_system_member_a.txt or prompts/_system_member_b.txt")
        return 2

    run_team_cycle = Path(__file__).with_name("run_team_cycle.sh")
    if not run_team_cycle.is_file():
        print("ERROR: missing run_team_cycle.sh")
        return 2

    executor = root / "scripts/execute_task.sh"
    if require_executor and not executor.is_file():
        print("ERROR: automation.require_executor=true but scripts/execute_task.sh not found.")
        return 2

    out_dir.mkdir(parents=True, exist_ok=True)
    state_path = out_dir / "autopilot_state.json"
    if args.reset_state and state_path.is_file():
        state_path.unlink()
        print("[info] reset autopilot state:", state_path)
    state = {"round": 0, "tasks": {}, "updated_at": None}
    if state_path.is_file():
        try:
            state = json.loads(state_path.read_text(encoding="utf-8", errors="replace"))
        except Exception:
            pass
    if not isinstance(state.get("tasks"), dict):
        state["tasks"] = {}

    no_progress = 0
    warned_no_executor = False

    for _ in range(max_rounds):
        stop = _stop_signal(root, stop_files if isinstance(stop_files, list) else [".stop"])
        if stop is not None:
            print(f"[stop] detected stop signal: {stop}")
            break
        # Keep Markdown hygiene stable across long runs (TOC tools / LLM edits can reintroduce hazards).
        if _run_markdown_safety_fixes(root=root, notes=notes) != 0:
            return 2

        text = plan.read_text(encoding="utf-8", errors="replace")
        section_text, base_line = _extract_task_board(text)
        tasks = _parse_tasks(section_text, base_line=base_line)
        if not tasks:
            print("[stop] no Task Board entries found in research_plan.md")
            return 2
        pending = [t for t in tasks if not t["done"]]
        if not pending:
            print("[done] all tasks completed.")
            break

        task = pending[0]
        task_id = task["id"]
        task_text = task["text"]
        task_mode = task.get("mode", "auto")

        if task_mode == "manual" and (args.mode == "assist" or pause_on_manual):
            print(f"[assist] manual task detected: {task_id} {task_text}")
            print("[assist] complete the task manually, then re-run autopilot.")
            if pause_on_manual and args.mode != "assist":
                print("[assist] set automation.pause_on_manual=false to override.")
            return 0

        if warn_if_no_executor and not executor.is_file() and not warned_no_executor:
            print("[warn] scripts/execute_task.sh not found; autopilot will only run team cycles.")
            print("[warn] mark tasks (manual) for human work or add an executor to automate tasks.")
            warned_no_executor = True

        exec_failed = False
        if executor.is_file():
            code = _run(["bash", str(executor), task_id, task_text])
            if code != 0:
                # Convention: exit 3 means "manual intervention required" (pause without counting as failure).
                if code == 3:
                    print(f"[assist] executor requested manual intervention: {task_id} {task_text}")
                    print("[assist] complete the task manually, then re-run autopilot.")
                    return 0
                exec_failed = True
                print(f"[error] executor failed for {task_id} (code {code})")
        elif args.mode == "assist":
            print(f"[assist] executor not found; cannot execute {task_id} automatically.")
            return 0

        if exec_failed:
            tasks_state = state.get("tasks", {})
            task_state = tasks_state.get(task_id, {"retries": 0, "status": "pending"})
            task_state["retries"] = int(task_state.get("retries", 0)) + 1
            task_state["status"] = "exec_failed"
            tasks_state[task_id] = task_state
            state["tasks"] = tasks_state
            no_progress += 1
            state["updated_at"] = datetime.now(timezone.utc).isoformat()
            state_path.write_text(json.dumps(state, indent=2), encoding="utf-8")
            if task_state["retries"] >= max_retries or no_progress >= no_progress_rounds:
                print("[stop] max retries or no progress reached.")
                print("[hint] you can reset retries with: --reset-state (or delete)", state_path)
                break
            continue

        tag = task_id
        cmd = [
            "bash",
            str(run_team_cycle),
            "--tag",
            tag,
            "--notes",
            str(notes),
            "--out-dir",
            str(out_dir),
            "--member-a-system",
            str(member_a_system),
            "--member-b-system",
            str(member_b_system),
            "--auto-tag",
        ]
        code = _run(cmd)
        state["round"] = int(state.get("round", 0)) + 1
        tasks_state = state.get("tasks", {})
        task_state = tasks_state.get(task_id, {"retries": 0, "status": "pending"})
        if code != 0:
            task_state["retries"] = int(task_state.get("retries", 0)) + 1
            task_state["status"] = "failed"
            tasks_state[task_id] = task_state
            state["tasks"] = tasks_state
            no_progress += 1
            if task_state["retries"] >= max_retries or no_progress >= no_progress_rounds:
                print("[stop] max retries or no progress reached.")
                print("[hint] you can reset retries with: --reset-state (or delete)", state_path)
                break
        else:
            lines = text.splitlines()
            _update_task_line(lines, task["line_no"], True)
            plan.write_text("\n".join(lines) + "\n", encoding="utf-8")
            task_state["status"] = "done"
            tasks_state[task_id] = task_state
            state["tasks"] = tasks_state
            no_progress = 0

        state["updated_at"] = datetime.now(timezone.utc).isoformat()
        state_path.write_text(json.dumps(state, indent=2), encoding="utf-8")

        if args.once:
            break

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
