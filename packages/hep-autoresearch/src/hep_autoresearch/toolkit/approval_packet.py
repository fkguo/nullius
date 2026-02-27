"""Approval packet renderer — generates the three-artifact approval trio (NEW-02).

Produces:
  - packet_short.md  (≤60 lines, terminal default)
  - packet.md        (full details)
  - approval_packet_v1.json (structured, schema-validated)

UX-07 adds gate-specific context enrichment via GateContextSummary + per-gate assemblers.
"""
from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any


@dataclass
class KeyResult:
    """A single key numerical or categorical result for the reviewer."""

    label: str
    value: str
    unit: str = ""
    source: str = ""


@dataclass
class GateContextSummary:
    """Gate-specific context assembled for human reviewers (UX-07).

    Provides a concise, gate-aware summary to help reviewers make informed
    decisions from ``packet_short.md`` without needing to read full details.
    """

    gate_id: str  # A0..A5
    summary: str = ""  # 1–3 line overview rendered in packet_short
    key_results: list[KeyResult] = field(default_factory=list)
    integrity_flags: list[str] = field(default_factory=list)  # warnings / anomaly flags
    recommendation: str = ""  # e.g. "APPROVE", "REVIEW CAREFULLY", "REQUEST REVISION"
    details: dict[str, Any] = field(default_factory=dict)  # gate-specific structured data


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
    gate_context: GateContextSummary | None = None  # UX-07 enrichment


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


def _gate_context_section(ctx: GateContextSummary) -> list[str]:
    """Render a compact gate context block (≤12 lines) for packet_short."""
    lines: list[str] = ["## Gate Context", ""]
    if ctx.summary:
        lines.append(ctx.summary.strip())
        lines.append("")
    if ctx.key_results:
        for kr in ctx.key_results[:4]:  # cap at 4 key results
            unit_str = f" {kr.unit}" if kr.unit else ""
            src_str = f" ({kr.source})" if kr.source else ""
            lines.append(f"- **{kr.label}**: {kr.value}{unit_str}{src_str}")
        lines.append("")
    if ctx.integrity_flags:
        for flag in ctx.integrity_flags[:3]:  # cap at 3 flags
            lines.append(f"⚠ {flag}")
        lines.append("")
    if ctx.recommendation:
        lines.append(f"**Recommendation**: {ctx.recommendation}")
        lines.append("")
    return lines


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
    ]
    if data.gate_context is not None:
        lines.extend(_gate_context_section(data.gate_context))
    lines.extend([
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
    ])
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
    if data.gate_context is not None:
        ctx = data.gate_context
        if ctx.summary:
            obj["context_summary"] = ctx.summary
        if ctx.key_results:
            obj["key_results"] = [
                {
                    "label": kr.label,
                    "value": kr.value,
                    **({"unit": kr.unit} if kr.unit else {}),
                    **({"source": kr.source} if kr.source else {}),
                }
                for kr in ctx.key_results
            ]
        if ctx.integrity_flags:
            obj["integrity_flags"] = ctx.integrity_flags
        if ctx.recommendation:
            obj["recommendation"] = ctx.recommendation
    return obj


# V2-only fields that are NOT in approval_packet_v1.schema.json (additionalProperties: false).
# When adding new v2+ fields to render_json, update this set to keep v1 artifacts valid.
# Regression test: test_gate_context_write_trio verifies v1 file is free of these keys.
_V2_ONLY_KEYS: frozenset[str] = frozenset(
    {"context_summary", "key_results", "integrity_flags", "recommendation"}
)


def write_trio(data: ApprovalPacketData, approval_dir: Path) -> dict[str, str]:
    """Write the three approval artifacts to *approval_dir*.

    Always writes ``approval_packet_v1.json`` with strictly v1-compliant fields
    (no gate_context enrichment). When ``data.gate_context`` is set, also writes
    ``approval_packet_v2.json`` with full enriched content (schema_version 2).

    Returns a dict mapping artifact name to its absolute path.
    """
    approval_dir.mkdir(parents=True, exist_ok=True)

    short_path = approval_dir / "packet_short.md"
    short_path.write_text(render_short(data), encoding="utf-8")

    full_path = approval_dir / "packet.md"
    full_path.write_text(render_full(data), encoding="utf-8")

    json_obj = render_json(data)

    # v1 file: strip any v2-only fields so it passes approval_packet_v1.schema.json
    json_v1 = {k: v for k, v in json_obj.items() if k not in _V2_ONLY_KEYS}
    json_path = approval_dir / "approval_packet_v1.json"
    json_path.write_text(
        json.dumps(json_v1, indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )

    result = {
        "packet_short": str(short_path),
        "packet_full": str(full_path),
        "packet_json": str(json_path),
    }

    # v2 file: only written when gate_context enrichment is present
    if data.gate_context is not None:
        json_v2 = {**json_obj, "schema_version": 2}
        json_v2_path = approval_dir / "approval_packet_v2.json"
        json_v2_path.write_text(
            json.dumps(json_v2, indent=2, ensure_ascii=False) + "\n",
            encoding="utf-8",
        )
        result["packet_json_v2"] = str(json_v2_path)

    return result


# ─────────────────────────────────────────────────────────────────────────────
# Per-gate context assemblers (UX-07)
# ─────────────────────────────────────────────────────────────────────────────


def assemble_a0_context(
    *,
    thesis: str = "",
    hypotheses: list[str] | None = None,
    compute_difficulty: str = "",
    literature_coverage: str = "",
    integrity_flags: list[str] | None = None,
    recommendation: str = "",
) -> GateContextSummary:
    """A0: IdeaCard gate — thesis, hypotheses, compute difficulty, literature coverage."""
    summary_parts: list[str] = []
    if thesis:
        summary_parts.append(f"Thesis: {thesis}")
    if compute_difficulty:
        summary_parts.append(f"Compute difficulty: {compute_difficulty}")
    if literature_coverage:
        summary_parts.append(f"Literature coverage: {literature_coverage}")

    key_results: list[KeyResult] = []
    for i, hyp in enumerate(hypotheses or [], 1):
        key_results.append(KeyResult(label=f"Hypothesis {i}", value=hyp))

    return GateContextSummary(
        gate_id="A0",
        summary="; ".join(summary_parts),
        key_results=key_results,
        integrity_flags=integrity_flags or [],
        recommendation=recommendation,
        details={
            "thesis": thesis,
            "hypotheses": hypotheses or [],
            "compute_difficulty": compute_difficulty,
            "literature_coverage": literature_coverage,
        },
    )


def assemble_a1_context(
    *,
    retrieval_strategy: str = "",
    hit_count: int | None = None,
    coverage_summary: str = "",
    missed_risk: str = "",
    integrity_flags: list[str] | None = None,
    recommendation: str = "",
) -> GateContextSummary:
    """A1: Literature retrieval gate — strategy, hit count, coverage, missed risks."""
    summary_parts: list[str] = []
    if retrieval_strategy:
        summary_parts.append(f"Strategy: {retrieval_strategy}")
    if hit_count is not None:
        summary_parts.append(f"Hits: {hit_count}")
    if coverage_summary:
        summary_parts.append(f"Coverage: {coverage_summary}")
    if missed_risk:
        summary_parts.append(f"Missed risk: {missed_risk}")

    key_results: list[KeyResult] = []
    if hit_count is not None:
        key_results.append(KeyResult(label="Retrieved papers", value=str(hit_count)))

    return GateContextSummary(
        gate_id="A1",
        summary="; ".join(summary_parts),
        key_results=key_results,
        integrity_flags=integrity_flags or [],
        recommendation=recommendation,
        details={
            "retrieval_strategy": retrieval_strategy,
            "hit_count": hit_count,
            "coverage_summary": coverage_summary,
            "missed_risk": missed_risk,
        },
    )


def assemble_a2_context(
    *,
    changed_files: list[str] | None = None,
    lines_added: int | None = None,
    lines_removed: int | None = None,
    test_coverage_status: str = "",
    integrity_flags: list[str] | None = None,
    recommendation: str = "",
) -> GateContextSummary:
    """A2: Code changes gate — changed files, diff stats, test coverage."""
    summary_parts: list[str] = []
    if changed_files is not None:
        summary_parts.append(f"{len(changed_files)} file(s) changed")
    if lines_added is not None or lines_removed is not None:
        add = lines_added or 0
        rem = lines_removed or 0
        summary_parts.append(f"+{add}/-{rem} lines")
    if test_coverage_status:
        summary_parts.append(f"Tests: {test_coverage_status}")

    key_results: list[KeyResult] = []
    if changed_files is not None:
        key_results.append(KeyResult(label="Files changed", value=str(len(changed_files))))
    if lines_added is not None:
        key_results.append(KeyResult(label="Lines added", value=str(lines_added)))
    if lines_removed is not None:
        key_results.append(KeyResult(label="Lines removed", value=str(lines_removed)))

    return GateContextSummary(
        gate_id="A2",
        summary="; ".join(summary_parts),
        key_results=key_results,
        integrity_flags=integrity_flags or [],
        recommendation=recommendation,
        details={
            "changed_files": changed_files or [],
            "lines_added": lines_added,
            "lines_removed": lines_removed,
            "test_coverage_status": test_coverage_status,
        },
    )


def assemble_a3_context(
    *,
    parameter_rationale: str = "",
    computation_budget: str = "",
    expected_precision: str = "",
    key_parameters: list[tuple[str, str]] | None = None,
    integrity_flags: list[str] | None = None,
    recommendation: str = "",
) -> GateContextSummary:
    """A3: Computation gate — parameter choices, budget, expected precision."""
    summary_parts: list[str] = []
    if parameter_rationale:
        summary_parts.append(f"Params: {parameter_rationale}")
    if computation_budget:
        summary_parts.append(f"Budget: {computation_budget}")
    if expected_precision:
        summary_parts.append(f"Precision: {expected_precision}")

    key_results: list[KeyResult] = [
        KeyResult(label=k, value=v) for k, v in (key_parameters or [])
    ]

    return GateContextSummary(
        gate_id="A3",
        summary="; ".join(summary_parts),
        key_results=key_results,
        integrity_flags=integrity_flags or [],
        recommendation=recommendation,
        details={
            "parameter_rationale": parameter_rationale,
            "computation_budget": computation_budget,
            "expected_precision": expected_precision,
            "key_parameters": key_parameters or [],
        },
    )


def assemble_a4_context(
    *,
    modification_summary: str = "",
    citation_changes: str = "",
    evidence_coverage_pct: float | None = None,
    integrity_flags: list[str] | None = None,
    recommendation: str = "",
) -> GateContextSummary:
    """A4: Paper edits gate — modification summary, citation changes, evidence coverage."""
    summary_parts: list[str] = []
    if modification_summary:
        summary_parts.append(f"Changes: {modification_summary}")
    if citation_changes:
        summary_parts.append(f"Citations: {citation_changes}")
    if evidence_coverage_pct is not None:
        summary_parts.append(f"Evidence coverage: {evidence_coverage_pct:.0f}%")

    key_results: list[KeyResult] = []
    if evidence_coverage_pct is not None:
        key_results.append(KeyResult(label="Evidence coverage", value=f"{evidence_coverage_pct:.1f}", unit="%"))

    return GateContextSummary(
        gate_id="A4",
        summary="; ".join(summary_parts),
        key_results=key_results,
        integrity_flags=integrity_flags or [],
        recommendation=recommendation,
        details={
            "modification_summary": modification_summary,
            "citation_changes": citation_changes,
            "evidence_coverage_pct": evidence_coverage_pct,
        },
    )


def assemble_a5_context(
    *,
    core_results: list[tuple[str, str, str]] | None = None,  # (label, value, unit)
    cross_validation_summary: str = "",
    integrity_flags: list[str] | None = None,
    recommendation: str = "",
) -> GateContextSummary:
    """A5: Final conclusions gate — core results table, cross-validation summary."""
    summary_parts: list[str] = []
    if core_results:
        summary_parts.append(f"{len(core_results)} key result(s)")
    if cross_validation_summary:
        summary_parts.append(f"Cross-validation: {cross_validation_summary}")

    key_results: list[KeyResult] = [
        KeyResult(label=label, value=value, unit=unit)
        for label, value, unit in (core_results or [])
    ]

    return GateContextSummary(
        gate_id="A5",
        summary="; ".join(summary_parts),
        key_results=key_results,
        integrity_flags=integrity_flags or [],
        recommendation=recommendation,
        details={
            "core_results": core_results or [],
            "cross_validation_summary": cross_validation_summary,
        },
    )
