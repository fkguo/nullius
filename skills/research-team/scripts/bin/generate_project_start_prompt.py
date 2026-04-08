#!/usr/bin/env python3
"""
Generate a project-local start prompt (kickoff prompt) from the user's initial instruction.

Why:
- Make the research-team workflow explicit for the executing agent (reduces workflow amnesia).
- Provide a user-reviewable "start contract" before any automation runs.

Default output: <root>/PROJECT_START_PROMPT.md

Approval model (optional but recommended):
- The prompt starts with "Status: DRAFT".
- User reviews/edits it, then changes to "Status: APPROVED".
- Autopilot can be configured to require this approval before running.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shlex
import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "lib"))

from team_config import find_config_path, load_team_config  # type: ignore
from kickoff_prompt_utils import looks_approved  # type: ignore


DEFAULT_INSTRUCTION_PATHS = (
    "project_brief.md",
    "项目开始指令.md",
    "README.md",
)


def _read_text(path: Path) -> str:
    return path.read_text(encoding="utf-8", errors="replace").strip()


def _load_config(root: Path) -> dict:
    cfg_path = find_config_path(root) if root.is_dir() else None
    if not cfg_path:
        return {}
    try:
        return json.loads(cfg_path.read_text(encoding="utf-8", errors="replace"))
    except Exception:
        return {}


def _find_first_nonempty(root: Path, rels: list[str]) -> tuple[Path | None, str]:
    for rel in rels:
        p = root / rel
        if p.is_file():
            txt = _read_text(p)
            if txt:
                return p, txt
    return None, ""


def _code_span(s: str) -> str:
    """
    Render a Markdown inline-code span safely even if `s` contains backticks.
    """
    s = s or ""
    max_run = 0
    for m in re.finditer(r"`+", s):
        max_run = max(max_run, len(m.group(0)))
    fence = "`" * max(1, max_run + 1)
    # CommonMark requires padding when the content starts/ends with a backtick.
    if s.startswith("`") or s.endswith("`"):
        return f"{fence} {s} {fence}"
    return f"{fence}{s}{fence}"


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--root", type=Path, default=Path.cwd(), help="Project root (default: cwd).")
    ap.add_argument("--out", type=Path, default=None, help="Output path (default: <root>/PROJECT_START_PROMPT.md).")
    ap.add_argument("--force", action="store_true", help="Overwrite even if the prompt already exists.")
    ap.add_argument("--print", dest="print_full", action="store_true", help="Print the generated prompt to stdout.")
    ap.add_argument(
        "--approved-marker",
        default="Status: APPROVED",
        help='Approval marker line (default: "Status: APPROVED").',
    )
    args = ap.parse_args()

    root = args.root.resolve()
    out_path = (args.out if args.out is not None else (root / "PROJECT_START_PROMPT.md")).resolve()
    # This generator is intended to write a project-local file. Prevent accidental writes outside root.
    try:
        out_path.relative_to(root)
    except Exception:
        print("ERROR: --out must be inside --root (refusing to write outside project root).")
        print("- root:", root)
        print("- out:", out_path)
        return 2

    approved_marker = str(args.approved_marker or "").strip()
    if not approved_marker:
        print("ERROR: --approved-marker is empty")
        return 2

    cfg = _load_config(root)
    auto_cfg = cfg.get("automation", {}) if isinstance(cfg.get("automation", {}), dict) else {}
    instr_paths = auto_cfg.get("initial_instruction_paths", [])
    if not isinstance(instr_paths, list) or not instr_paths:
        instr_paths = list(DEFAULT_INSTRUCTION_PATHS)

    instr_path, instr_text = _find_first_nonempty(root, instr_paths)
    if not instr_text:
        print("ERROR: no initial instruction found.")
        print("Checked:", ", ".join(instr_paths))
        return 2

    team_cfg = load_team_config(root)
    profile = str(team_cfg.data.get("profile", "")).strip()
    profile_source = "config" if team_cfg.path is not None else "unset"

    if out_path.is_file() and not args.force:
        existing = out_path.read_text(encoding="utf-8", errors="replace")
        if looks_approved(existing, approved_marker):
            print("[skip] kickoff prompt already approved; not overwriting:", out_path)
            return 0
        print("[skip] kickoff prompt already exists (use --force to overwrite):", out_path)
        return 0

    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    project = root.name.replace("\n", " ").replace("\r", " ")
    owner = os.environ.get("USER", "").strip() or os.environ.get("USERNAME", "").strip() or "unknown"

    instr_rel = ""
    try:
        instr_rel = str(instr_path.resolve().relative_to(root)) if instr_path is not None else ""
    except Exception:
        instr_rel = str(instr_path) if instr_path is not None else ""

    # Keep this prompt deterministic and "tool-neutral" so it can be reused across agents.
    lines: list[str] = []
    lines.append("# PROJECT_START_PROMPT.md")
    lines.append("")
    lines.append(f"Status: DRAFT  # change to '{approved_marker}' after you review/edit")
    lines.append(f"Generated: {today}")
    lines.append(f"Project: {project}")
    lines.append(f"Owner: {owner}")
    if instr_rel:
        lines.append(f"Source instruction: {_code_span(instr_rel)}")
    lines.append("")
    lines.append("## How to use (human-in-the-loop)")
    lines.append("")
    lines.append("1) Read and edit this file until it accurately reflects your intent and constraints.")
    lines.append("2) If acceptable, replace the first-line status with:")
    lines.append(f"   - {_code_span(approved_marker)}")
    lines.append("3) Start execution via autopilot or manual team cycle.")
    lines.append("")
    lines.append("## Role (executing agent)")
    lines.append("")
    lines.append("You are the executing agent for this project. You MUST follow the research-team workflow:")
    lines.append("- Deterministic preflight gates first (fail-fast).")
    lines.append("- Two-member cross-check (Member A + Member B) must converge before advancing.")
    lines.append("- Keep artifacts, references, and knowledge base updated as first-class outputs.")
    lines.append("")
    lines.append("Hard constraints / policies:")
    lines.append(
        "- Network policy (allowed, but audited): prefer stable anchors (INSPIRE/arXiv/DOI/GitHub/Zenodo/Software Heritage) + official docs/archives/registries (SciPy/Julia/NumPy/PyPI/etc.). General scholarly search may be used for discovery, but MUST be logged in `knowledge_base/methodology_traces/` and the final citations must be stabilized to stable anchors; if a needed domain is blocked by the References gate, extend allowlist via `research_team_config.json: references.allowed_external_hosts_extra`."
    )
    lines.append("- All network queries/decisions MUST be logged in `knowledge_base/methodology_traces/` (and referenced from `research_preflight.md`). Prefer `knowledge_base/methodology_traces/literature_queries.md` as an append-only log.")
    lines.append("- Prefer `hep-mcp` / `@autoresearch/hep-mcp` (if available in your agent environment) for INSPIRE/arXiv retrieval; fallback is direct INSPIRE REST + arXiv export API (see `scripts/literature_fetch.py` if present).")
    lines.append("- For DOI discovery/metadata: Crossref is preferred for papers; DataCite is preferred for datasets/software DOIs. If network/DNS fails but you must keep moving, use `literature_fetch.py *-get --allow-stub` to write an auditable stub KB note (publication stage will block until metadata is filled).")
    lines.append("- For arXiv papers: downloading LaTeX sources is allowed (store under `references/arxiv_src/`), but avoid writing brittle LaTeX parsers; do LLM-assisted extraction into KB notes with explicit file pointers and normalization notes.")
    lines.append("- If numerical algorithms look unstable/unclear, perform an algorithm/code search within the allowed sources and log it in `knowledge_base/methodology_traces/` before coding.")
    lines.append('- Math formatting: use `$...$` / `$$...$$`. Do not use `\\(\\)` / `\\[\\]`. Inside `$$...$$`, do not start a new line with `+`, `-`, or `=`; do not split one equation into back-to-back `$$` blocks (keep one `$$...$$` block). If you slip, run `python3 "${SKILL_DIR:-${CODEX_HOME:-$HOME/.codex}/skills/research-team}/scripts/bin/fix_markdown_math_hygiene.py" --root <path> --in-place`.')
    lines.append('- Avoid accidental double-backslash LaTeX escapes in Markdown math (common LLM/TOC artifact), e.g. `\\\\Delta`, `\\\\gamma\\\\_{\\\\rm lin}`. If they appear, run: `python3 "${SKILL_DIR:-${CODEX_HOME:-$HOME/.codex}/skills/research-team}/scripts/bin/fix_markdown_double_backslash_math.py" --notes research_contract.md --in-place`.')
    lines.append("- References: maintain `## References` in `research_contract.md`; each entry MUST include an external link (if exists) and a local KB note link.")
    lines.append('- If you pasted unstable URL variants into References (e.g. `dx.doi.org`, `arxiv.org/pdf/...pdf`, `inspirehep.net/api/...`), normalize them deterministically: `python3 "${SKILL_DIR:-${CODEX_HOME:-$HOME/.codex}/skills/research-team}/scripts/bin/upgrade_reference_anchors.py" --notes research_contract.md --in-place`.')
    lines.append("")
    lines.append("## Start protocol (must follow; anti-amnesia)")
    lines.append("")
    lines.append("Plan (in-chat, mandatory):")
    lines.append(
        "- Before running any commands or editing files, publish a short execution plan (3–7 steps) and keep it updated as steps complete."
    )
    lines.append(
        "- If your agent environment supports a plan tool (e.g., Codex `update_plan`), use it; otherwise keep a plain Markdown plan section."
    )
    lines.append("")
    lines.append("Profile (important):")
    if profile_source == "config":
        lines.append(f"- Detected from {_code_span(str(team_cfg.path))}: {_code_span(profile)}")
        lines.append("- If your project goal is 'reusable toolkit + layered knowledge base', set profile to `toolkit_extraction` in your config before running.")
    else:
        lines.append("- No research_team_config found; choose a profile before running scaffold:")
        lines.append("  - `mixed`: default theory+numerics workflow")
        lines.append("  - `toolkit_extraction`: reusable toolkit + KB; stronger anti-goal-drift gates (Toolkit delta)")
    lines.append("")
    lines.append("0) Ensure scaffold exists (or re-run scaffold without `--force` to fill missing files):")
    lines.append("```bash")
    lines.append('SKILL_DIR="${SKILL_DIR:-${CODEX_HOME:-$HOME/.codex}/skills/research-team}"')
    lines.append('bash "${SKILL_DIR}/scripts/bin/scaffold_research_workflow.sh" \\')
    lines.append("  --root . \\")
    include_profile_line = profile_source == "config" and bool(profile)
    if include_profile_line:
        lines.append(f"  --project {shlex.quote(project)} \\")
        lines.append(f"  --profile {shlex.quote(profile)}")
    else:
        lines.append(f"  --project {shlex.quote(project)}")
    lines.append("```")
    lines.append("")
    lines.append("1) Run deterministic preflight only (no external LLM calls):")
    lines.append("```bash")
    lines.append('SKILL_DIR="${SKILL_DIR:-${CODEX_HOME:-$HOME/.codex}/skills/research-team}"')
    lines.append('bash "${SKILL_DIR}/scripts/bin/run_team_cycle.sh" \\')
    lines.append("  --tag M0-r1 \\")
    lines.append("  --notes research_contract.md \\")
    lines.append("  --out-dir team \\")
    lines.append("  --member-a-system prompts/_system_member_a.txt \\")
    lines.append("  --member-b-system prompts/_system_member_b.txt \\")
    lines.append("  --auto-tag \\")
    lines.append("  --preflight-only")
    lines.append("```")
    lines.append("")
    lines.append("2) Prework (before any full team cycle):")
    lines.append("- Fill `research_preflight.md` coverage matrix and method selection.")
    lines.append("- Add KB notes under `knowledge_base/literature/`, `knowledge_base/methodology_traces/`, `knowledge_base/priors/`.")
    lines.append("- Update Capsule I) in `research_contract.md` with clickable links to those KB notes (use human-readable link text like `RefKey — Authors — Title`).")
    lines.append("")
    lines.append("3) Plan (anti-superficial acceptance):")
    lines.append("- Ensure `research_plan.md` is not a template.")
    lines.append("- For the active milestone, make Deliverables/Acceptance concrete (paths/commands/thresholds).")
    lines.append("- Keep `## Task Board` + `## Progress Log` updated (plan_tracking).")
    lines.append("")
    lines.append("4) Claim graph / knowledge graph (optional but recommended):")
    lines.append("- Maintain `knowledge_graph/claims.jsonl`, `edges.jsonl`, `evidence_manifest.jsonl` as the project evolves.")
    lines.append("- Render the claim graph (DOT/PNG/SVG) after convergence if enabled.")
    lines.append("")
    lines.append("5) Full team cycle (Claude + Gemini; must converge):")
    lines.append("```bash")
    lines.append('SKILL_DIR="${SKILL_DIR:-${CODEX_HOME:-$HOME/.codex}/skills/research-team}"')
    lines.append('bash "${SKILL_DIR}/scripts/bin/run_team_cycle.sh" \\')
    lines.append("  --tag M0-r1 \\")
    lines.append("  --notes research_contract.md \\")
    lines.append("  --out-dir team \\")
    lines.append("  --member-a-system prompts/_system_member_a.txt \\")
    lines.append("  --member-b-system prompts/_system_member_b.txt \\")
    lines.append("  --auto-tag")
    lines.append("```")
    lines.append("")
    lines.append("## Inputs (verbatim initial instruction)")
    lines.append("")
    # Pick a fence that does not appear in the instruction text (deterministic).
    max_bt = 0
    for m in re.finditer(r"`+", instr_text):
        max_bt = max(max_bt, len(m.group(0)))
    # Deterministically pick a fence longer than any run of backticks in the text.
    fence = "`" * max(3, max_bt + 1)
    lines.append(fence)
    lines.append(instr_text)
    lines.append(fence)
    lines.append("")

    out_path.parent.mkdir(parents=True, exist_ok=True)
    # Atomic-ish write: write to a temp file, then replace. Avoid overwriting if a file
    # appears concurrently and --force is not set.
    tmp = out_path.with_name(out_path.name + f".tmp.{os.getpid()}")
    tmp.write_text("\n".join(lines), encoding="utf-8")
    if out_path.exists() and not args.force:
        print("[skip] kickoff prompt appeared concurrently; not overwriting:", out_path)
        try:
            tmp.unlink()
        except Exception:
            pass
        return 0
    tmp.replace(out_path)
    print("[ok] wrote kickoff prompt:", out_path)
    if args.print_full:
        print("")
        print(out_path.read_text(encoding="utf-8", errors="replace"))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
