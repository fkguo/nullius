#!/usr/bin/env python3
"""
Deterministic auto-fill helper for research_preflight.md.

Currently focuses on ensuring a minimal, gate-passing "## Problem Framing Snapshot" block exists.

Design goals:
- No external LLM calls (safe to run during preflight).
- Never overwrite non-empty user content.
- Prefer explicit pointers (research_plan.md, research_contract.md) when domain details are unknown.
"""

from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "lib"))

from team_config import find_config_path  # type: ignore


DEFAULT_INSTRUCTION_PATHS = (
    "project_brief.md",
    "项目开始指令.md",
    "README.md",
)

TEMPLATE_LINE_MARKERS = (
    "paste the user's initial project instruction here.",
    "this file is used for auto-fill.",
    "recommended next step",
    "example:",
)


def _read_text(path: Path) -> str:
    return path.read_text(encoding="utf-8", errors="replace").replace("\r\n", "\n").replace("\r", "\n")


def _find_first_nonempty(root: Path, rels: list[str]) -> tuple[Path | None, str]:
    for rel in rels:
        p = root / rel
        if p.is_file():
            txt = _read_text(p).strip()
            if txt:
                return p, txt
    return None, ""


def _extract_goal_line(text: str) -> str:
    fallback = ""
    for raw_line in text.splitlines():
        line = raw_line.strip()
        if not line:
            continue
        if not fallback:
            fallback = line
        low = line.lower()
        if line.startswith("#"):
            continue
        if any(marker in low for marker in TEMPLATE_LINE_MARKERS):
            continue
        if re.match(r"^[-*]\s*(goal|background|required references \(if any\)|constraints)\s*:?\s*$", low):
            continue
        return line
    return fallback


def _render_problem_framing_block(*, goal_line: str) -> str:
    # Keep the block compact and pointer-based so it's safe across domains.
    gl = goal_line.strip() if goal_line.strip() else "(fill: one-sentence problem from project_brief.md)"
    return "\n".join(
        [
            "## Problem Framing Snapshot",
            "",
            "Goal: make prework decomposition executable (Problem Interpretation + P/D separation + sequential review), so it cannot be silently skipped.",
            "",
            "### Problem Interpretation (P)",
            "",
            f"- Problem sentence: {gl}",
            "- Inputs: see [research_plan.md](research_plan.md) (Scope/In scope) and Reproducibility Capsule B) Inputs",
            "- Outputs: primary notebook [research_contract.md](research_contract.md) + reproducible artifacts under [runs/](runs/) (see [research_plan.md](research_plan.md) deliverables)",
            "- Scope: see [research_plan.md](research_plan.md) '## 1. Scope (SCOPE)'",
            "- Anti-scope: see [research_plan.md](research_plan.md) 'Out of scope'",
            "- Falsification / kill criteria: Fail if any declared falsification/acceptance test triggers; see [research_plan.md](research_plan.md) 'Claims & Falsification'",
            "",
            "### Principle / Derivation Separation (P/D)",
            "",
            "- Principles (P): (>=1; each must have a source pointer)",
            "- P1: Keep every touched claim auditable from plan to notebook to artifact; do not skip the evidence trail. | Source: [research_plan.md](research_plan.md) | Confidence: med | Verification: spot-checked",
            "- Derivation trace (D): (>=3 atomic steps; link to where each step lives)",
            "- D1: Lock scope, inputs, and kill criteria in [project_brief.md](project_brief.md) and [research_plan.md](research_plan.md) before any team cycle.",
            "- D2: Record the working derivation or audit steps in [research_contract.md](research_contract.md) and supporting notes under [knowledge_base/methodology_traces/](knowledge_base/methodology_traces/).",
            "- D3: Map formula -> code pointer -> artifact and verify outputs under [runs/](runs/) or other declared artifact directories.",
            "",
            "### Sequential Review Checklist (do not skip)",
            "",
            "- [ ] Problem interpretation complete and consistent",
            "- [ ] P/D separation: principles have sources; derivation has >=3 atomic steps",
            "- [ ] At least one external consistency check planned (limit / baseline / literature)",
            "",
        ]
    )


def _patch_line_if_empty(lines: list[str], key: str, value: str, start: int, end: int) -> None:
    """
    If a line '- <key>:' exists inside [start,end) with empty value, fill it.
    """
    prefix = f"- {key}:"
    for i in range(start, end):
        ln = lines[i]
        if ln.strip().startswith(prefix):
            # Preserve indentation and only fill when nothing follows ':'.
            head, sep, tail = ln.partition(":")
            if sep and not tail.strip():
                indent = ln[: ln.index("-")] if "-" in ln else ""
                lines[i] = f"{indent}- {key}: {value}"
            return


def _has_nonempty_p_line(line: str) -> bool:
    """
    Accept "- P1: ... | Source: ..." with both parts non-empty.
    """
    if "source:" not in line.lower():
        return False
    before, after = line.split(":", 1)[1].split("Source:", 1) if "Source:" in line else (line, "")
    return bool(before.strip().strip("|").strip()) and bool(after.strip())


def _ensure_p_and_d(lines: list[str], start: int, end: int) -> None:
    # Ensure at least one filled principle line (P1) exists.
    default_p1 = "- P1: Keep every touched claim auditable from plan to notebook to artifact; do not skip the evidence trail. | Source: [research_plan.md](research_plan.md) | Confidence: med | Verification: spot-checked"
    p1_idx = None
    for i in range(start, end):
        if lines[i].lstrip().startswith("- P1:"):
            p1_idx = i
            break
    if p1_idx is not None:
        if not _has_nonempty_p_line(lines[p1_idx]):
            lines[p1_idx] = default_p1
    else:
        # Insert after the "Principles (P)" anchor if present; else append within the section.
        insert_at = end
        for i in range(start, end):
            if "principles (p)" in lines[i].lower():
                insert_at = i + 1
                break
        lines.insert(insert_at, default_p1)
        end += 1

    # Ensure D1-D3 exist and are non-empty (process-level defaults are fine).
    defaults = {
        "D1": "Lock scope, inputs, and kill criteria in [project_brief.md](project_brief.md) and [research_plan.md](research_plan.md) before any team cycle.",
        "D2": "Record the working derivation or audit steps in [research_contract.md](research_contract.md) and supporting notes under [knowledge_base/methodology_traces/](knowledge_base/methodology_traces/).",
        "D3": "Map formula -> code pointer -> artifact and verify outputs under [runs/](runs/) or other declared artifact directories.",
    }
    d_present: dict[str, int] = {}
    for i in range(start, end):
        for k in ("D1", "D2", "D3"):
            if lines[i].lstrip().startswith(f"- {k}:"):
                d_present[k] = i
    for k, v in defaults.items():
        if k in d_present:
            ln = lines[d_present[k]]
            head, sep, tail = ln.partition(":")
            if sep and not tail.strip():
                lines[d_present[k]] = f"- {k}: {v}"
        else:
            # Insert after "Derivation trace (D)" anchor if present.
            insert_at = end
            for i in range(start, end):
                if "derivation trace (d)" in lines[i].lower():
                    insert_at = i + 1
                    break
            lines.insert(insert_at, f"- {k}: {v}")
            end += 1

    # Ensure the sequential review checklist has at least 3 checkbox lines.
    cb_count = 0
    for i in range(start, end):
        if lines[i].lstrip().startswith("- ["):
            cb_count += 1
    if cb_count < 3:
        insert_at = end
        for i in range(start, end):
            if lines[i].strip().lower().startswith("### sequential review checklist"):
                insert_at = i + 1
                break
        checklist = [
            "- [ ] Problem interpretation complete and consistent",
            "- [ ] P/D separation: principles have sources; derivation has >=3 atomic steps",
            "- [ ] At least one external consistency check planned (limit / baseline / literature)",
        ]
        lines[insert_at:insert_at] = checklist


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--root", type=Path, default=Path.cwd(), help="Project root (default: cwd).")
    ap.add_argument(
        "--deterministic",
        action="store_true",
        help="Present for symmetry with other auto-fill scripts; this script is always deterministic.",
    )
    args = ap.parse_args()

    root = args.root.resolve()
    if not root.is_dir():
        print(f"ERROR: --root must be a directory: {root}", file=sys.stderr)
        return 2

    # Respect config overrides for initial-instruction paths (best-effort).
    cfg_path = find_config_path(root)
    instr_paths = list(DEFAULT_INSTRUCTION_PATHS)
    if cfg_path and cfg_path.is_file():
        try:
            import json

            cfg = json.loads(cfg_path.read_text(encoding="utf-8", errors="replace"))
            auto = cfg.get("automation", {}) if isinstance(cfg.get("automation", {}), dict) else {}
            paths = auto.get("initial_instruction_paths", [])
            if isinstance(paths, list) and paths:
                instr_paths = [str(p) for p in paths if str(p).strip()]
        except Exception:
            pass

    instr_path, instr_text = _find_first_nonempty(root, instr_paths)
    goal_line = _extract_goal_line(instr_text) if instr_text.strip() else ""

    prework = root / "research_preflight.md"
    if not prework.is_file():
        # Create a minimal research_preflight.md if missing (prefer template if available).
        assets = Path(__file__).resolve().parent.parent / "assets"
        tmpl = assets / "research_preflight_template.md"
        if tmpl.is_file():
            prework.write_text(_read_text(tmpl).strip() + "\n", encoding="utf-8")
        else:
            prework.write_text("# research_preflight.md\n\n", encoding="utf-8")

    text = _read_text(prework)
    if re.search(r"^##\s+Problem\s+Framing\s+Snapshot\b", text, flags=re.IGNORECASE | re.MULTILINE) is None:
        patched = text.rstrip() + "\n\n" + _render_problem_framing_block(goal_line=goal_line)
        prework.write_text(patched.rstrip() + "\n", encoding="utf-8")
        print("[ok] inserted Problem Framing Snapshot into research_preflight.md")
        if instr_path:
            print(f"- initial instruction: {instr_path}")
        return 0

    # Patch-in-place for empty required fields inside the Problem Framing Snapshot section only.
    lines = text.splitlines()
    start = None
    end = len(lines)
    for i, ln in enumerate(lines):
        heading = ln.strip().lower()
        # Backward compatibility: patch either legacy LOCA heading or the new Problem Framing heading.
        if heading.startswith("## loca snapshot") or heading.startswith("## problem framing snapshot"):
            start = i + 1
            continue
        if start is not None and ln.strip().startswith("## "):
            end = i
            break

    if start is None:
        # Heading exists in text but not as a standalone line; append a clean block.
        patched = text.rstrip() + "\n\n" + _render_problem_framing_block(goal_line=goal_line)
        prework.write_text(patched.rstrip() + "\n", encoding="utf-8")
        print("[ok] appended clean Problem Framing Snapshot block into research_preflight.md")
        return 0

    _patch_line_if_empty(lines, "Problem sentence", goal_line or "(fill)", start, end)
    _patch_line_if_empty(lines, "Inputs", "see [research_plan.md](research_plan.md) (Scope/In scope) and Capsule B) Inputs", start, end)
    _patch_line_if_empty(
        lines,
        "Outputs",
        "see [research_plan.md](research_plan.md) deliverables; primary notebook [research_contract.md](research_contract.md) + [runs/](runs/)",
        start,
        end,
    )
    _patch_line_if_empty(lines, "Scope", "see [research_plan.md](research_plan.md) '## 1. Scope (SCOPE)'", start, end)
    _patch_line_if_empty(lines, "Anti-scope", "see [research_plan.md](research_plan.md) 'Out of scope'", start, end)
    _patch_line_if_empty(
        lines,
        "Falsification / kill criteria",
        "Fail if any declared falsification/acceptance test triggers; see [research_plan.md](research_plan.md) 'Claims & Falsification'",
        start,
        end,
    )

    _ensure_p_and_d(lines, start, end)

    prework.write_text("\n".join(lines).rstrip() + "\n", encoding="utf-8")
    print("[ok] patched Problem Framing Snapshot fields in research_preflight.md (no overwrite of non-empty lines)")
    if instr_path:
        print(f"- initial instruction: {instr_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
