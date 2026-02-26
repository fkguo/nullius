"""Approval packet renderer — generates the three-artifact approval trio (NEW-02).

Produces:
  - packet_short.md  (≤60 lines, terminal default)
  - packet.md        (full details)
  - approval_packet_v1.json (structured, schema-validated)
"""
from __future__ import annotations

import json
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any


@dataclass
class ApprovalPacketData:
    """All data needed to render the three approval artifacts."""

    approval_id: str
    gate_id: str
    run_id: str
    workflow_id: str | None = None
    purpose: str = ""
    plan: list[str] = field(default_factory=list)
    risks: list[str] = field(default_factory=list)
    budgets: dict[str, Any] = field(default_factory=dict)
    outputs: list[str] = field(default_factory=list)
    rollback: str = ""
    commands: list[str] = field(default_factory=list)
    checklist: list[str] = field(default_factory=list)
    requested_at: str = ""
    context_pack_path: str | None = None
    run_card_path: str | None = None
    run_card_sha256: str | None = None
    plan_ssot_pointer: str | None = None
    plan_step_ids: list[str] = field(default_factory=list)
    active_branch_id: str | None = None
    gate_resolution_trace: list[dict[str, str]] = field(default_factory=list)
    details_md: str | None = None


SHORT_LINE_LIMIT = 60


def _bullet_list(items: list[str], fallback: str = "(none)") -> str:
    if not items:
        return f"- {fallback}"
    return "\n".join(f"- {item}" for item in items)


def _budget_table(budgets: dict[str, Any]) -> str:
    rows = []
    for key in ("max_network_calls", "max_runtime_minutes", "max_cpu_hours", "max_gpu_hours", "max_disk_gb"):
        val = budgets.get(key)
        if val is not None:
            rows.append(f"| {key} | {val} |")
    if not rows:
        return "| (no budgets set) | — |"
    return "\n".join(rows)


def render_short(data: ApprovalPacketData) -> str:
    """Render the short packet (≤60 lines, terminal-friendly)."""
    lines: list[str] = [
        f"# Approval: {data.approval_id} ({data.gate_id})",
        "",
        f"**Run**: {data.run_id}  ",
        f"**Workflow**: {data.workflow_id or '(unknown)'}  ",
        f"**Requested**: {data.requested_at or '(unknown)'}",
        "",
        "## TL;DR",
        "",
        data.purpose.strip() or "(fill)",
        "",
        "## Plan",
        "",
        _bullet_list(data.plan),
        "",
        "## Budgets",
        "",
        "| Resource | Limit |",
        "|----------|-------|",
        _budget_table(data.budgets),
        "",
        "## Commands",
        "",
        _bullet_list(data.commands, "(no commands)"),
        "",
        "## Checklist",
        "",
        _bullet_list(data.checklist, "(no checklist items)"),
        "",
        "## Rollback",
        "",
        data.rollback.strip() or "(fill)",
        "",
    ]
    result = "\n".join(lines)
    rendered_lines = result.split("\n")
    if len(rendered_lines) > SHORT_LINE_LIMIT:
        overflow_lines = [
            "",
            "---",
            f"*Truncated. See packet.md for full details.*",
        ]
        cut = SHORT_LINE_LIMIT - len(overflow_lines)
        result = "\n".join(rendered_lines[:cut] + overflow_lines)
    return result


def render_full(data: ApprovalPacketData) -> str:
    """Render the full packet (all details, gate resolution trace)."""
    plan_steps = ", ".join(data.plan_step_ids) if data.plan_step_ids else "(unknown)"
    lines: list[str] = [
        f"# Approval packet — {data.approval_id} ({data.gate_id})",
        "",
        f"- Run: {data.run_id}",
        f"- Workflow: {data.workflow_id or '(unknown)'}",
        f"- Context pack: {data.context_pack_path or '(missing)'}",
        f"- Run-card: {data.run_card_path or '(missing)'}",
        f"- Run-card SHA256 (canonical JSON): {data.run_card_sha256 or '(missing)'}",
        f"- Plan SSOT: {data.plan_ssot_pointer or '(missing)'}",
        f"- Plan step(s): {plan_steps}",
        f"- Active branch: {data.active_branch_id or '(none)'}",
        f"- Requested at: {data.requested_at or '(unknown)'}",
        "",
        "## Purpose",
        "",
        data.purpose.strip() or "(fill)",
        "",
        "## Plan (what will be done)",
        "",
        _bullet_list(data.plan),
        "",
    ]
    if data.details_md and data.details_md.strip():
        lines.extend(["## Details", "", data.details_md.strip(), ""])
    lines.extend([
        "## Budgets",
        "",
        "| Resource | Limit |",
        "|----------|-------|",
        _budget_table(data.budgets),
        "",
        "## Risks / failure modes",
        "",
        _bullet_list(data.risks),
        "",
        "## Outputs (paths)",
        "",
        _bullet_list(data.outputs),
        "",
        "## Commands",
        "",
        _bullet_list(data.commands, "(no commands)"),
        "",
        "## Checklist",
        "",
        _bullet_list(data.checklist, "(no checklist items)"),
        "",
        "## Rollback",
        "",
        data.rollback.strip() or "(fill)",
        "",
    ])
    if data.gate_resolution_trace:
        lines.extend(["## Gate resolution trace", ""])
        for item in data.gate_resolution_trace:
            gate = item.get("gate_id", "(unknown)")
            triggered = item.get("triggered_by", "(unknown)")
            reason = item.get("reason", "(no reason)")
            ts = item.get("timestamp_utc", "")
            line = f"- gate={gate}; triggered_by={triggered}; reason={reason}"
            if ts:
                line += f"; at={ts}"
            lines.append(line)
        lines.append("")
    return "\n".join(lines)


def render_json(data: ApprovalPacketData) -> dict:
    """Build the structured JSON dict conforming to approval_packet_v1.schema.json."""
    obj: dict[str, Any] = {
        "schema_version": 1,
        "approval_id": data.approval_id,
        "gate_id": data.gate_id,
        "run_id": data.run_id,
        "purpose": data.purpose,
        "plan": data.plan,
        "risks": data.risks,
        "budgets": data.budgets,
        "outputs": data.outputs,
        "rollback": data.rollback,
        "commands": data.commands,
        "checklist": data.checklist,
        "requested_at": data.requested_at,
    }
    if data.workflow_id:
        obj["workflow_id"] = data.workflow_id
    if data.context_pack_path:
        obj["context_pack_path"] = data.context_pack_path
    if data.run_card_path:
        obj["run_card_path"] = data.run_card_path
    if data.run_card_sha256:
        obj["run_card_sha256"] = data.run_card_sha256
    if data.plan_ssot_pointer:
        obj["plan_ssot_pointer"] = data.plan_ssot_pointer
    if data.plan_step_ids:
        obj["plan_step_ids"] = data.plan_step_ids
    if data.active_branch_id:
        obj["active_branch_id"] = data.active_branch_id
    if data.gate_resolution_trace:
        obj["gate_resolution_trace"] = data.gate_resolution_trace
    if data.details_md:
        obj["details_md"] = data.details_md
    return obj


def write_trio(data: ApprovalPacketData, approval_dir: Path) -> dict[str, str]:
    """Write the three approval artifacts to *approval_dir*.

    Returns a dict mapping artifact name to its relative path (from repo root).
    """
    approval_dir.mkdir(parents=True, exist_ok=True)

    short_path = approval_dir / "packet_short.md"
    short_path.write_text(render_short(data), encoding="utf-8")

    full_path = approval_dir / "packet.md"
    full_path.write_text(render_full(data), encoding="utf-8")

    json_path = approval_dir / "approval_packet_v1.json"
    json_obj = render_json(data)
    json_path.write_text(
        json.dumps(json_obj, indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )

    return {
        "packet_short": str(short_path),
        "packet_full": str(full_path),
        "packet_json": str(json_path),
    }
