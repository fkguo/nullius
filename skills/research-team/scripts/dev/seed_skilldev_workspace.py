#!/usr/bin/env python3
from __future__ import annotations

import argparse
import re
from pathlib import Path


PROJECT_BRIEF_TEXT = """Improve the research-team skill via a deterministic maintainer-fixture workflow that validates scaffold, contract, and preflight gates without acting as a real user research project.

Background:
- This workspace exists for methodology/tooling development of the research-team skill itself.
- The goal is to keep self-audit runs reproducible, auditable, and clearly separate from `real_project` authority.

Required references (if any):
- `research_contract.md`
- `research_plan.md`
- `knowledge_base/methodology_traces/demo_trace.md`

Constraints:
- Treat this workspace as `maintainer_fixture`, not `real_project`.
- Keep outputs deterministic enough for smoke tests and preflight-only self-audits.
"""

DEMO_TRACE_TEXT = """# demo_trace.md

Purpose: capture the deterministic maintainer-fixture seed used for research-team self-audit.

- Mode: `maintainer_fixture`
- Scope: scaffold/init/preflight/doc alignment for the research-team skill
- Anti-scope: registering this workspace as a real research project or treating repo-local outputs as real-project authority
- Core pointers: `project_brief.md`, `research_plan.md`, `research_contract.md`
"""


def _read_text(path: Path) -> str:
    return path.read_text(encoding="utf-8", errors="replace").replace("\r\n", "\n").replace("\r", "\n")


def _write_text(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text.rstrip() + "\n", encoding="utf-8")
    print(f"[ok] patched: {path}")


def _seed_project_brief(root: Path) -> None:
    path = root / "project_brief.md"
    if not path.exists():
        _write_text(path, PROJECT_BRIEF_TEXT)
        return

    text = _read_text(path)
    template_markers = (
        "# project_brief.md",
        "Paste the user's initial project instruction here.",
        "This file is used for auto-fill.",
    )
    if any(marker in text for marker in template_markers):
        _write_text(path, PROJECT_BRIEF_TEXT)


def _seed_demo_trace(root: Path) -> None:
    path = root / "knowledge_base/methodology_traces/demo_trace.md"
    if not path.exists():
        _write_text(path, DEMO_TRACE_TEXT)


def _patch_charter(root: Path, profile: str) -> None:
    path = root / "project_charter.md"
    if not path.is_file():
        return

    text = _read_text(path)

    def sub_line(pat: str, repl: str) -> None:
        nonlocal text
        text = re.sub(pat, repl, text, flags=re.MULTILINE)

    sub_line(r"^Status:\s*.*$", "Status: APPROVED")
    sub_line(r"^Primary goal:\s*.*$", "Primary goal: Improve the research-team skill via a reproducible, auditable self-evolution workspace")
    sub_line(
        r"^Validation goal\(s\):\s*.*$",
        "Validation goal(s): Run deterministic self-audit (preflight-only + smoke tests) and keep docs/contracts aligned with real research workflows",
    )
    sub_line(r"^Declared profile:\s*.*$", f"Declared profile: {profile}")
    sub_line(r"^Rationale:\s*.*$", "Rationale: This is methodology/tooling development for the skill itself (not a user research project).")

    text = re.sub(
        r"(^Anti-goals / non-goals.*\n)(?:[-*+]\s+.*\n)+",
        r"\1- Do NOT introduce hard cutoffs that break real research workflows; prefer warn+debt in exploration and enforce in development/publication.\n",
        text,
        flags=re.MULTILINE,
    )

    commitments_block = (
        "Project-specific commitments (fill at least 2 bullets; must include at least 1 KB link):\n"
        "- [KB] Keep an auditable query/decision trail: [demo_trace](knowledge_base/methodology_traces/demo_trace.md)\n"
        "- [DOC] Keep docs/templates aligned with gates and agent-first usage; record any policy exceptions in KB traces.\n"
    )
    text = re.sub(
        r"^Project-specific commitments \(fill at least 2 bullets; must include at least 1 KB link\):\n(?:[-*+]\s+.*\n)+",
        commitments_block,
        text,
        flags=re.MULTILINE,
    )

    text = re.sub(
        r"^\s*-\s*Allowed\s+sources\s+for\s+discovery\s*:\s*.*$",
        "- Allowed sources for discovery: prefer stable anchors (INSPIRE/arXiv/DOI/GitHub) + official docs/archives; general scholarly search is OK for discovery if logged in KB traces and stabilized to final anchors.",
        text,
        flags=re.MULTILINE,
    )

    _write_text(path, text)


def main() -> int:
    ap = argparse.ArgumentParser(description="Seed deterministic maintainer-fixture content for the research-team skilldev workspace.")
    ap.add_argument("--workspace", required=True, type=Path)
    ap.add_argument("--profile", default="methodology_dev")
    args = ap.parse_args()

    root = args.workspace.resolve()
    profile = str(args.profile or "").strip() or "methodology_dev"

    _seed_project_brief(root)
    _seed_demo_trace(root)
    _patch_charter(root, profile)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
