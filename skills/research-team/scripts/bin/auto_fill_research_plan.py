#!/usr/bin/env python3
"""
Auto-fill research_plan.md using initial instruction + prework.
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "lib"))
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "gates"))

from task_board_templates import default_task_board_lines  # type: ignore
from team_config import load_team_config  # type: ignore


DEFAULT_INSTRUCTION_PATHS = (
    "project_brief.md",
    "项目开始指令.md",
    "README.md",
)


def _read_text(path: Path) -> str:
    return path.read_text(encoding="utf-8", errors="replace").strip()


def _find_first_nonempty(root: Path, rels: list[str]) -> tuple[Path | None, str]:
    for rel in rels:
        p = root / rel
        if p.is_file():
            txt = _read_text(p)
            if txt:
                return p, txt
    return None, ""


def _run(cmd: list[str]) -> tuple[int, str]:
    proc = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    return proc.returncode, proc.stdout


def _deterministic_plan(
    *,
    root: Path,
    mode: str,
    profile: str,
    instr_path: Path | None,
    instr_text: str,
    prework_path: Path,
    prework_text: str,
) -> str:
    today = datetime.now(timezone.utc).date().isoformat()
    project = root.name
    owner = os.environ.get("USER", "").strip() or os.environ.get("USERNAME", "").strip() or "unknown"
    toolkit_profile = (profile or "").strip().lower() == "toolkit_extraction"

    def _rel(p: Path | None) -> str:
        if p is None:
            return ""
        try:
            return str(p.resolve().relative_to(root.resolve()))
        except Exception:
            return str(p)

    instr_rel = _rel(instr_path)
    prework_rel = _rel(prework_path) if prework_text else ""

    instr_hint = "See initial instruction file." if instr_rel else "Add an initial instruction file (project_brief.md / 项目开始指令.md / README.md)."
    goal_line = instr_text.splitlines()[0].strip() if instr_text.strip() else instr_hint

    lines: list[str] = []
    lines.append("# research_plan.md")
    lines.append("")
    lines.append(f"Project: {project}")
    lines.append(f"Owner: {owner}")
    lines.append(f"Created: {today}")
    lines.append(f"Last updated: {today}")
    lines.append("")
    lines.append("## Execution Trigger (Prework -> Team Cycle)")
    lines.append("")
    if instr_rel:
        lines.append(f"- Initial instruction: [{instr_rel}]({instr_rel})")
    if prework_rel:
        lines.append(f"- Prework: [{prework_rel}]({prework_rel})")
    if mode or profile:
        lines.append(f"- Mode/Profile: `{mode or ''}` / `{profile or ''}`")
    lines.append("")
    lines.append("Run preflight (no external LLM calls):")
    lines.append("")
    lines.append("```bash")
    lines.append('SKILL_DIR="${SKILL_DIR:-$(for r in "${CLAUDE_CONFIG_DIR:-$HOME/.claude}" "${CODEX_HOME:-$HOME/.codex}" "$HOME/.config/opencode"; do [ -d "$r/skills/research-team" ] && echo "$r/skills/research-team" && break; done || true)}"')
    lines.append('bash "${SKILL_DIR}/scripts/bin/run_team_cycle.sh" \\')
    lines.append("  --tag 20260502T023000Z-m0-topic \\")
    lines.append("  --notes research_contract.md \\")
    lines.append("  --out-dir team \\")
    lines.append("  --member-a-system prompts/_system_member_a.txt \\")
    lines.append("  --member-b-system prompts/_system_member_b.txt \\")
    lines.append("  --auto-tag \\")
    lines.append("  --preflight-only")
    lines.append("```")
    lines.append("")
    lines.append("Run full team cycle:")
    lines.append("")
    lines.append("- Default: the current host agent assigns Member A and Member B through its native subagent mechanism.")
    lines.append("- Shell execution: provide explicit CLI runner kinds and runner paths; the script does not switch providers automatically.")
    lines.append("")
    lines.append("```bash")
    lines.append('SKILL_DIR="${SKILL_DIR:-$(for r in "${CLAUDE_CONFIG_DIR:-$HOME/.claude}" "${CODEX_HOME:-$HOME/.codex}" "$HOME/.config/opencode"; do [ -d "$r/skills/research-team" ] && echo "$r/skills/research-team" && break; done || true)}"')
    lines.append('bash "${SKILL_DIR}/scripts/bin/run_team_cycle.sh" \\')
    lines.append("  --tag 20260502T023000Z-m0-topic \\")
    lines.append("  --notes research_contract.md \\")
    lines.append("  --out-dir team \\")
    lines.append("  --member-a-system prompts/_system_member_a.txt \\")
    lines.append("  --member-b-system prompts/_system_member_b.txt \\")
    lines.append("  --member-a-runner-kind <codex|claude> \\")
    lines.append("  --member-a-runner <path-to-member-a-runner> \\")
    lines.append("  --member-b-runner-kind <codex|claude|gemini> \\")
    lines.append("  --member-b-runner <path-to-member-b-runner> \\")
    lines.append("  --auto-tag")
    lines.append("```")
    lines.append("")
    lines.append("## 0. Goal (What / Why)")
    lines.append("")
    lines.append(f"- One-sentence objective: {goal_line}")
    lines.append("- Why it matters: (fill; tie to falsifiable claims and/or impact)")
    lines.append("- Primary deliverables (paper / note / code / data): (fill)")
    lines.append("")
    lines.append("## 1. Scope (SCOPE)")
    lines.append("")
    lines.append("- In scope: (fill)")
    lines.append("- Out of scope: (fill)")
    lines.append("- Explicit limitations (assumptions / regimes / data): (fill)")
    lines.append("")
    lines.append("## 2. Claims & Falsification")
    lines.append("")
    lines.append("- Claim C1: (fill)")
    lines.append("  - Evidence needed: (fill)")
    lines.append("  - Falsified if: (fill)")
    lines.append("- Claim C2: (fill)")
    lines.append("  - Evidence needed: (fill)")
    lines.append("  - Falsified if: (fill)")
    lines.append("")
    lines.append("## 3. Milestones")
    lines.append("")
    lines.append("Each milestone must have deliverables + acceptance tests + team gate (convergence) + evidence pointers.")
    if toolkit_profile:
        lines.append(
            "- Toolkit extraction contract (profile=toolkit_extraction): each milestone must include a Toolkit delta (API spec + code snippet index + KB evidence links)."
        )
    lines.append("")
    lines.append("### Definition of Done (DoD) rubric (anti-superficial)")
    lines.append("")
    lines.append("- Acceptance MUST be evidence-backed and quickly checkable (files/commands/thresholds, not just prose).")
    lines.append("- If full recomputation is impractical, define audit proxy headlines in research_contract.md Audit slices.")
    lines.append("")
    lines.append("### M0 — Baseline Reproduction")
    lines.append("")
    lines.append("- Deliverables:")
    lines.append("  - [research_contract.md](research_contract.md) capsule + excerpt markers filled")
    lines.append("  - At least 1 reproducible artifact run (manifest/summary/analysis + one main figure embedded)")
    lines.append("- Acceptance:")
    lines.append("  - `run_team_cycle.sh --preflight-only` passes")
    lines.append("  - At least 1 headline number is machine-extractable from an artifact (e.g. `artifacts/runs/<run_id>/analysis.json:results.H1`)")
    lines.append("- Review gate:")
    lines.append("  - Team reports saved under [team/](team/) and convergence reached")
    if toolkit_profile:
        lines.append("- Toolkit delta:")
        lines.append("  - API spec: [TOOLKIT_API.md](TOOLKIT_API.md) records the validation-harness API boundary.")
        lines.append("  - Code snippet index: [scripts/make_demo_artifacts.py](scripts/make_demo_artifacts.py) writes the demo manifest and analysis artifacts.")
        lines.append("  - KB evidence links: [demo_trace](knowledge_base/methodology_traces/demo_trace.md) records the reproducibility method.")
    lines.append("")
    lines.append("### M1 — Core Derivation")
    lines.append("")
    lines.append("- Deliverables:")
    lines.append("  - Step-by-step derivation with explicit assumptions and limiting checks")
    lines.append("- Acceptance:")
    lines.append("  - Both reviewers show >=3 nontrivial intermediate steps and Derivation replication is `pass`")
    if toolkit_profile:
        lines.append("- Toolkit delta:")
        lines.append("  - API spec: (fill)")
        lines.append("  - Code snippet index: (fill)")
        lines.append("  - KB evidence links: (fill)")
    lines.append("")
    lines.append("### M2 — Core Computation Validation")
    lines.append("")
    lines.append("- Deliverables:")
    lines.append("  - Scripts that reproduce headline numbers + figures from raw artifacts")
    lines.append("- Acceptance:")
    lines.append("  - Headline numbers trace to artifacts (e.g. `artifacts/runs/<run_id>/analysis.json#/results/...`) and match capsule values")
    lines.append("  - Audit slices contain nontrivial proxy headline(s) + key algorithm steps with code pointers")
    if toolkit_profile:
        lines.append("- Toolkit delta:")
        lines.append("  - API spec: (fill)")
        lines.append("  - Code snippet index: (fill)")
        lines.append("  - KB evidence links: (fill)")
    lines.append("")
    lines.append("## Task Board")
    lines.append("")
    for ln in default_task_board_lines(profile):
        lines.append(ln)
    lines.append("")
    lines.append("## Progress Log")
    lines.append("")
    lines.append(f"- {today} tag= status= task= note=")
    lines.append("")
    return "\n".join(lines).strip() + "\n"


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--root", type=Path, default=Path.cwd(), help="Project root (default: cwd).")
    ap.add_argument("--plan", type=Path, default=None, help="Path to research_plan.md.")
    ap.add_argument("--force", action="store_true", help="Overwrite even if plan is not a template.")
    ap.add_argument("--deterministic", action="store_true", help="Do not call external LLM runners; generate a minimal starter plan deterministically.")
    ap.add_argument("--member-a-model", default="", help="Optional model for plan draft (defaults to runner config).")
    ap.add_argument("--member-b-model", default="", help="Optional model for plan refinement (defaults to runner config).")
    ap.add_argument("--member-a-reasoning-effort", default="high", choices=["low", "medium", "high", "xhigh"], help="Codex reasoning effort for plan draft.")
    ap.add_argument("--member-b-reasoning-effort", default="high", choices=["low", "medium", "high", "xhigh"], help="Codex reasoning effort for plan refinement.")
    ap.add_argument("--member-a-system", default=None, help="System prompt for Member A (optional).")
    ap.add_argument("--member-b-system", default=None, help="System prompt for Member B (optional).")
    args = ap.parse_args()

    root = args.root.resolve()
    plan_path = args.plan or (root / "research_plan.md")
    plan_exists = plan_path.is_file()

    team_cfg = load_team_config(root)
    cfg_data = team_cfg.data if isinstance(team_cfg.data, dict) else {}
    mode = str(cfg_data.get("mode", "")).strip()
    profile = str(cfg_data.get("profile", "")).strip()
    auto_cfg = cfg_data.get("automation", {}) if isinstance(cfg_data.get("automation", {}), dict) else {}
    instr_paths = auto_cfg.get("initial_instruction_paths", [])
    if not isinstance(instr_paths, list) or not instr_paths:
        instr_paths = list(DEFAULT_INSTRUCTION_PATHS)

    instr_path, instr_text = _find_first_nonempty(root, instr_paths)
    if not instr_text:
        print("ERROR: no initial instruction found.")
        print("Checked:", ", ".join(instr_paths))
        return 2

    prework_path = root / "research_preflight.md"
    prework_text = _read_text(prework_path) if prework_path.is_file() else ""

    member_a_system = args.member_a_system
    if member_a_system is None:
        cand = root / "prompts/_system_member_a.txt"
        member_a_system = str(cand) if cand.is_file() else ""
    member_b_system = args.member_b_system
    if member_b_system is None:
        cand = root / "prompts/_system_member_b.txt"
        member_b_system = str(cand) if cand.is_file() else ""

    plan_marker = plan_path.read_text(encoding="utf-8", errors="replace") if plan_exists else ""
    from check_research_plan import _looks_like_template  # type: ignore

    if plan_exists and not _looks_like_template(plan_marker) and not args.force:
        print("[skip] research_plan.md appears filled; use --force to overwrite.")
        return 0

    if args.deterministic:
        final_text = _deterministic_plan(
            root=root,
            mode=mode,
            profile=profile,
            instr_path=instr_path,
            instr_text=instr_text,
            prework_path=prework_path,
            prework_text=prework_text,
        )
        if plan_exists:
            backup = plan_path.with_suffix(plan_path.suffix + ".bak")
            plan_path.replace(backup)
        plan_path.write_text(final_text, encoding="utf-8")
        log = {
            "created_at": datetime.now(timezone.utc).isoformat(),
            "method": "deterministic",
            "instruction_path": str(instr_path) if instr_path else None,
            "prework_path": str(prework_path) if prework_text else None,
            "plan_path": str(plan_path),
        }
        temp_dir = root / "team"
        temp_dir.mkdir(parents=True, exist_ok=True)
        (temp_dir / "auto_fill_log.json").write_text(json.dumps(log, indent=2), encoding="utf-8")
        print("[ok] auto-filled research_plan.md (deterministic)")
        return 0

    prompt = (
        "You are drafting research_plan.md for a research-team project.\n"
        "Use the initial instruction and prework. Output full Markdown for research_plan.md.\n"
        "Requirements:\n"
        "- Include goals, scope, claims, milestones, and acceptance tests.\n"
        "- Add a section 'Task Board' with checkbox tasks formatted as '- [ ] T1: ...'.\n"
        "- Add a 'Progress Log' section with an empty template line.\n"
        "- Include 'Last updated: <YYYY-MM-DD>' near the top.\n"
        "- Each task should mention the required team cycle step.\n"
        "- Keep tasks small and ordered.\n"
        "\n"
        f"Project mode: {mode or '(unset)'}\n"
        f"Project profile: {profile or '(unset)'}\n"
        "Profile guidance:\n"
        "- Regardless of profile: include at least one task that expands the layered knowledge base beyond the initial instruction (log queries + add KB notes + update References).\n"
        "- If profile=toolkit_extraction: include a Toolkit delta per milestone (API spec + code snippet index + KB evidence links).\n"
        "\n"
        "Initial instruction:\n"
        f"{instr_text}\n"
        "\n"
        "Prework (if any):\n"
        f"{prework_text}\n"
    )

    temp_dir = root / "team"
    temp_dir.mkdir(parents=True, exist_ok=True)
    prompt_path = temp_dir / "_autofill_prompt.txt"
    prompt_path.write_text(prompt, encoding="utf-8")

    if member_a_system:
        sys_path = Path(member_a_system)
        if not sys_path.is_file():
            member_a_system = ""

    local_codex = root / "scripts/run_codex.sh"
    skills_root = Path(__file__).resolve().parents[2]
    codex_runner = local_codex if local_codex.is_file() else skills_root / "research-team/assets/run_codex.sh"
    if not codex_runner.is_file():
        print("ERROR: missing codex runner script. Use --deterministic for deterministic auto-fill, or provide the project-local runner explicitly before running LLM auto-fill.")
        return 2

    draft_out = temp_dir / "_autofill_plan_draft.md"
    sys_path = temp_dir / "_autofill_system.txt"
    if member_a_system:
        sys_path = Path(member_a_system)
    else:
        # Fallback: use prompt as system+user combined.
        sys_path.write_text("You are a research planning assistant.", encoding="utf-8")
    cmd = [
        "bash",
        str(codex_runner),
        "--reasoning-effort",
        args.member_a_reasoning_effort,
        "--system-prompt-file",
        str(sys_path),
        "--prompt-file",
        str(prompt_path),
        "--out",
        str(draft_out),
    ]
    if args.member_a_model:
        cmd[2:2] = ["--model", args.member_a_model]
    code, out = _run(cmd)
    if code != 0:
        print("ERROR: Codex plan draft failed. research-team will not switch to another generation path automatically; rerun with --deterministic if you want deterministic auto-fill.")
        print(out)
        return 2

    # Independent CLI-runner refinement for shell-only auto-fill.
    refine_prompt = (
        "Refine the following research_plan.md. Output full Markdown only.\n"
        "Ensure Task Board uses '- [ ] Tn: ...' and tasks are concrete and ordered.\n"
        "\n"
        + draft_out.read_text(encoding="utf-8", errors="replace")
    )
    refine_path = temp_dir / "_autofill_refine_prompt.txt"
    refine_path.write_text(refine_prompt, encoding="utf-8")

    refine_system = temp_dir / "_autofill_refine_system.txt"
    refine_system.write_text("You are an independent research-plan reviewer. Tighten the plan without adding unsupported facts.", encoding="utf-8")
    refine_out = temp_dir / "_autofill_plan_refined.md"
    cmd = [
        "bash",
        str(codex_runner),
        "--reasoning-effort",
        args.member_b_reasoning_effort,
        "--system-prompt-file",
        str(refine_system),
        "--prompt-file",
        str(refine_path),
        "--out",
        str(refine_out),
    ]
    if args.member_b_model:
        cmd[2:2] = ["--model", args.member_b_model]
    code, out = _run(cmd)
    if code != 0:
        print("[warn] Codex refinement failed; using draft.")
        final_text = draft_out.read_text(encoding="utf-8", errors="replace")
    else:
        final_text = refine_out.read_text(encoding="utf-8", errors="replace").strip()
        if not final_text:
            final_text = draft_out.read_text(encoding="utf-8", errors="replace")

    if plan_exists:
        backup = plan_path.with_suffix(plan_path.suffix + ".bak")
        plan_path.replace(backup)

    plan_path.write_text(final_text.strip() + "\n", encoding="utf-8")

    log = {
        "created_at": datetime.now(timezone.utc).isoformat(),
        "method": "llm",
        "instruction_path": str(instr_path) if instr_path else None,
        "prework_path": str(prework_path) if prework_text else None,
        "member_a_model": args.member_a_model,
        "member_b_model": args.member_b_model,
        "plan_path": str(plan_path),
    }
    (temp_dir / "auto_fill_log.json").write_text(json.dumps(log, indent=2), encoding="utf-8")

    print("[ok] auto-filled research_plan.md")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
