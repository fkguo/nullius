#!/usr/bin/env python3
"""
Problem Framing Snapshot gate (research_preflight.md).

Goal: ensure prework decomposition is not "shelfware":
- Problem Interpretation (P)
- Principle/Derivation separation (P/D)
- Sequential review checklist

Controlled by `features.problem_framing_snapshot_gate` in research_team_config.json.

Exit codes:
  0  ok, or gate disabled / not applicable
  1  fail-fast (missing/incomplete Problem Framing Snapshot)
  2  input error
"""

from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "lib"))

try:
    from team_config import load_team_config  # type: ignore
except Exception as exc:  # pragma: no cover - import-time failure
    print(f"ERROR: failed to import team_config: {exc}", file=sys.stderr)
    raise SystemExit(2)


_REQUIRED_FIELDS = (
    "Problem sentence",
    "Inputs",
    "Outputs",
    "Scope",
    "Anti-scope",
    "Falsification / kill criteria",
)

# Minimal anti-ceremonial guardrails (cheap, deterministic).
MIN_PROBLEM_LEN = 20
MIN_FIELD_LEN = 10
MIN_D_STEP_LEN = 20
MIN_P_LEN = 20

_BANNED_SOURCE_TOKENS = (
    "common sense",
    "obvious",
    "task description",
    "常识",
    "显然",
    "任务描述",
)


def _is_placeholder(val: str) -> bool:
    v = (val or "").strip().lower()
    if not v:
        return True
    # Common template placeholders; keep conservative to avoid false positives.
    bad_tokens = ("<your_name>", "<yyyy-mm-dd>", "(fill", "tbd", "todo")
    return any(tok in v for tok in bad_tokens)


def _extract_problem_framing_section(text: str) -> str:
    """
    Return the body of the top-level section '## Problem Framing Snapshot', excluding the heading.
    """
    m = re.search(r"^##\s+Problem\s+Framing\s+Snapshot\b.*$", text, flags=re.IGNORECASE | re.MULTILINE)
    if not m:
        return ""
    start = m.end()
    m2 = re.search(r"^##\s+\S", text[start:], flags=re.MULTILINE)
    end = start + (m2.start() if m2 else len(text[start:]))
    return text[start:end].strip()


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--notes", type=Path, required=True, help="Path to research_contract.md (used to locate project root).")
    args = ap.parse_args()

    if not args.notes.exists():
        print(f"ERROR: notes not found: {args.notes}")
        return 2

    try:
        cfg = load_team_config(args.notes if args.notes.is_file() else Path.cwd())
    except Exception as exc:
        print(f"ERROR: failed to load research_team_config: {exc}")
        return 2

    if not cfg.feature_enabled("problem_framing_snapshot_gate", default=False):
        print("[skip] problem framing snapshot gate disabled by research_team_config")
        return 0

    root = (cfg.path.parent if cfg.path is not None else (args.notes.parent if args.notes.is_file() else args.notes)).resolve()
    prework_cfg = cfg.data.get("prework", {}) if isinstance(cfg.data.get("prework", {}), dict) else {}
    prework_rel = str(prework_cfg.get("notes_path", "research_preflight.md")).strip() or "research_preflight.md"
    prework = (root / prework_rel).resolve()

    try:
        prework.relative_to(root)
    except Exception:
        print("[fail] problem framing snapshot gate failed")
        print(f"[error] prework.notes_path must be inside project root: {prework}")
        return 1

    if not prework.is_file():
        print("[fail] problem framing snapshot gate failed")
        print(f"[error] Missing prework file: {prework}")
        print("[fix] Create research_preflight.md (scaffold) and add '## Problem Framing Snapshot' section.")
        return 1

    text = prework.read_text(encoding="utf-8", errors="replace").replace("\r\n", "\n").replace("\r", "\n")
    section = _extract_problem_framing_section(text)
    if not section:
        print("[fail] problem framing snapshot gate failed")
        print(f"[error] Missing required section heading in {prework}: '## Problem Framing Snapshot'")
        print("[fix] Add the Problem Framing Snapshot block to research_preflight.md (see template).")
        return 1

    issues: list[str] = []

    # Required problem-interpretation fields.
    for key in _REQUIRED_FIELDS:
        m = re.search(rf"^\s*-\s*{re.escape(key)}:\s*(.+?)\s*$", section, flags=re.MULTILINE)
        if not m:
            issues.append(f"Missing field line: '- {key}:'")
            continue
        val = m.group(1).strip()
        if _is_placeholder(val):
            issues.append(f"Field '{key}' is empty/placeholder: {val!r}")
            continue
        min_len = MIN_PROBLEM_LEN if key == "Problem sentence" else MIN_FIELD_LEN
        if len(val) < min_len:
            issues.append(f"Field '{key}' is too short (<{min_len} chars): {val!r}")

        if key.lower().startswith("falsification"):
            # Require at least a minimal conditional/threshold signal (prevents empty platitudes).
            if re.search(r"(?i)\b(if|fail|falsif|kill)\b|!=|==|<=|>=|<|>", val) is None:
                issues.append("Field 'Falsification / kill criteria' should include at least one explicit condition/threshold (if/fail/kill/<,>,!=,...)")

    # Principles: require >=1 'P#' line with an inline Source: on the same line.
    p_lines = []
    for ln in section.splitlines():
        m = re.match(r"^\s*-\s*P\d+:\s*(.+?)\s*$", ln)
        if m:
            p_lines.append(m.group(1).strip())
    if not p_lines:
        issues.append("Missing principles list: add at least one '- P1: ... | Source: ...' line.")
    else:
        ok_any = False
        for content in p_lines:
            if "source:" not in content.lower():
                continue
            parts = re.split(r"(?i)source:", content, maxsplit=1)
            if len(parts) < 2:
                continue
            before, after = parts[0], parts[1]
            if not before.strip() or not after.strip():
                continue
            if _is_placeholder(before) or _is_placeholder(after):
                continue
            if len(before.strip()) < MIN_P_LEN:
                continue
            src = after.strip().lower()
            if any(tok in src for tok in _BANNED_SOURCE_TOKENS):
                continue
            # Require a "pointer-like" source (URL or local doc path); prevents "Source: common sense".
            if re.search(r"https?://|knowledge_base/|draft_derivation\.md|research_plan\.md", after, flags=re.IGNORECASE) is None:
                continue
            if before.strip() and after.strip():
                ok_any = True
                break
        if not ok_any:
            issues.append("Principles must include non-empty content AND non-empty 'Source:' on the same line.")

    # Derivation trace: require >=3 atomic steps.
    d_lines = []
    for ln in section.splitlines():
        m = re.match(r"^\s*-\s*D\d+:\s*(.+?)\s*$", ln)
        if m:
            d_lines.append(m.group(1).strip())
    if len(d_lines) < 3:
        issues.append("Derivation trace must include >=3 atomic steps: '- D1:', '- D2:', '- D3:'.")
    else:
        for i, val in enumerate(d_lines[:3], start=1):
            if _is_placeholder(val):
                issues.append(f"Derivation step D{i} is empty/placeholder: {val!r}")
                continue
            if len(val) < MIN_D_STEP_LEN:
                issues.append(f"Derivation step D{i} is too short (<{MIN_D_STEP_LEN} chars): {val!r}")

        # Require at least one explicit pointer in D1-D3 (prevents pure ceremony).
        d_join = " ".join(d_lines[:3])
        if re.search(r"`[^`]+`|Draft_Derivation\.md|knowledge_base/|runs/", d_join, flags=re.IGNORECASE) is None:
            issues.append("Derivation trace D1-D3 should include at least one explicit pointer (e.g. `research_contract.md`, `knowledge_base/`, `runs/`, or inline code pointers).")

    # Sequential review checklist: require presence of >=3 checkbox lines.
    cb_count = 0
    for ln in section.splitlines():
        if re.match(r"^\s*-\s*\[(?: |x|X)\]\s+.+$", ln):
            cb_count += 1
    if cb_count < 3:
        issues.append("Sequential review checklist must include >=3 checkbox lines '- [ ] ...'.")

    if issues:
        print("[fail] problem framing snapshot gate failed")
        print(f"[error] {prework} is missing required Problem Framing Snapshot content:")
        for it in issues[:20]:
            print(f"- {it}")
        if len(issues) > 20:
            print(f"- ... ({len(issues)-20} more)")
        print("[fix] Fill research_preflight.md '## Problem Framing Snapshot' fields with concrete content or explicit pointers to research_plan.md sections.")
        return 1

    print("[ok] problem framing snapshot gate passed")
    print(f"- root: {root}")
    print(f"- research_preflight.md: {prework}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
