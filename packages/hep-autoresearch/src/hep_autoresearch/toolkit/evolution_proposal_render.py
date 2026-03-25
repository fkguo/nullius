from __future__ import annotations

import os
from pathlib import Path
from typing import Any


def _truncate(value: str, *, max_chars: int = 200) -> str:
    text = str(value)
    if len(text) <= max_chars:
        return text
    return text[: max(0, max_chars - 3)].rstrip() + "..."


def _rel(repo_root: Path, path: Path) -> str:
    return os.fspath(path.relative_to(repo_root))


def render_proposals_md(*, repo_root: Path, out_dir: Path, analysis: dict[str, Any]) -> str:
    rel_dir = _rel(repo_root, out_dir)
    results = analysis.get("results") if isinstance(analysis, dict) else None
    proposals = results.get("proposals") if isinstance(results, dict) and isinstance(results.get("proposals"), list) else []
    lines: list[str] = [
        "# Evolution proposals (v0)",
        "",
        "> This file is a deterministic, human-readable view derived from JSON SSOT in the same directory.",
        "> Regenerate (do not hand-edit) if needed.",
        "",
        f"- artifact_dir: [{rel_dir}](./)",
        f"- source_run_tag: `{((analysis.get('inputs') or {}).get('source_run_tag')) if isinstance(analysis, dict) else ''}`",
        "",
        "## Proposals",
        "",
    ]
    if not proposals:
        return "\n".join(lines + ["- (no proposals generated)", ""]).rstrip() + "\n"
    for idx, proposal in enumerate(proposals):
        if not isinstance(proposal, dict):
            continue
        pointer = f"analysis.json#/results/proposals/{idx}"
        lines.extend(
            [
                f"### {proposal.get('proposal_id') or f'P{idx + 1:03d}'} — {proposal.get('kind') or '(unknown)'} (severity={proposal.get('severity') or '(unknown)'})",
                "",
                f"- requires_approval: `{proposal.get('requires_approval') or '(none)'}` (`{pointer}/requires_approval`)",
                f"- summary: {proposal.get('summary') or ''} (`{pointer}/summary`)",
                "",
            ]
        )
        if proposal.get("handling"):
            lines.extend([f"- handling: `{proposal.get('handling')}` (`{pointer}/handling`)", f"- handled_reason: {proposal.get('handled_reason') or ''} (`{pointer}/handled_reason`)", ""])
        evidence = proposal.get("evidence")
        if isinstance(evidence, list) and evidence:
            lines.append("**Evidence**")
            for item in evidence[:12]:
                if isinstance(item, dict):
                    lines.append(f"- `{item.get('path') or ''}{item.get('pointer') or ''}` — `{_truncate(item.get('message') or '')}`")
            if len(evidence) > 12:
                lines.append(f"- … ({len(evidence) - 12} more; see `{pointer}/evidence`)")
            lines.append("")
        actions = proposal.get("actions")
        if isinstance(actions, list) and actions:
            lines.append("**Next actions**")
            for action in actions[:12]:
                if not isinstance(action, dict):
                    continue
                if action.get("handling"):
                    lines.append(f"- {action.get('type') or '(type?)'}: {action.get('description') or ''} ({action.get('handling')})")
                else:
                    lines.append(f"- {action.get('type') or '(type?)'}: {action.get('description') or ''} (requires `{action.get('requires_approval') or '(none)'}`)")
            if len(actions) > 12:
                lines.append(f"- … ({len(actions) - 12} more; see `{pointer}/actions`)")
            lines.append("")
        bindings = proposal.get("bindings")
        if isinstance(bindings, dict) and bindings:
            lines.append("**Bindings (suggested artifacts)**")
            if bindings.get("suggested_eval_case_path"):
                lines.append(f"- suggested_eval_case_path: `{bindings.get('suggested_eval_case_path')}`")
            if bindings.get("trace_stub_path"):
                lines.append(f"- trace_stub_path: `{bindings.get('trace_stub_path')}`")
            lines.append("")
    return "\n".join(lines).rstrip() + "\n"


def render_trace_stub_md(*, source_run_tag: str, proposals: list[dict[str, Any]], proposal_dir_rel: str) -> str:
    proposal_dir_rel = str(proposal_dir_rel).rstrip("/")
    lines: list[str] = [
        "# Methodology trace — Evolution proposal (v0)",
        "",
        "This trace records a concrete failure→proposal mapping for audit and future regression hardening.",
        "",
        f"- source_run_tag: `{source_run_tag}`",
        f"- source_run_dir: [artifacts/runs/{source_run_tag}](artifacts/runs/{source_run_tag})",
        f"- proposal_artifacts: [{proposal_dir_rel}]({proposal_dir_rel})",
        f"- proposal_md: [proposal.md]({proposal_dir_rel}/proposal.md)",
        "",
        "## What failed / what looked risky",
        "",
    ]
    if not proposals:
        return "\n".join(lines + ["- (no proposals generated)", ""]).rstrip() + "\n"
    for proposal in proposals[:20]:
        lines.append(f"- {proposal.get('proposal_id') or '(id?)'} [{proposal.get('kind') or '(kind?)'}]: {proposal.get('summary') or ''}")
    lines.extend(
        [
            "",
            "## Next actions (human-approved when needed)",
            "",
            "- For any code change, require an explicit A2 approval packet and add/extend an eval regression anchor.",
            "- Prefer deterministic failure injection (stubs) over live network calls in evals.",
            "",
        ]
    )
    return "\n".join(lines).rstrip() + "\n"
