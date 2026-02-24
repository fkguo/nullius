from __future__ import annotations

import hashlib
import os
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from ._git import try_get_git_metadata
from ._json import read_json, write_json
from ._time import utc_now_iso
from .workflow_context import WorkflowContext, workflow_context


@dataclass(frozen=True)
class ContextPackInputs:
    run_id: str
    workflow_id: str | None = None
    note: str | None = None
    refkey: str | None = None
    extra_links: list[str] | None = None


def _sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def _read_first_matching_line(path: Path, prefix: str) -> str | None:
    try:
        for line in path.read_text(encoding="utf-8", errors="replace").splitlines():
            if line.strip().startswith(prefix):
                return line.strip()
    except Exception:
        return None
    return None


def _rel_link(from_path: Path, to_path: Path) -> str:
    try:
        rel = os.path.relpath(to_path, start=from_path.parent)
        return rel.replace(os.sep, "/")
    except Exception:
        return os.fspath(to_path)


def _default_context_files(repo_root: Path) -> list[dict[str, Any]]:
    paths = [
        ("PROJECT_CHARTER.md", True),
        ("PROJECT_MAP.md", True),
        ("RESEARCH_PLAN.md", True),
        ("PREWORK.md", True),
        ("Draft_Derivation.md", True),
        ("AGENTS.md", True),
        ("knowledge_base/_index/kb_index.json", True),
        ("docs/APPROVAL_GATES.md", True),
        ("docs/ARTIFACT_CONTRACT.md", True),
        ("docs/EVAL_GATE_CONTRACT.md", True),
        ("docs/REVIEWER_ISOLATION.md", False),
        ("docs/ORCHESTRATOR_INTERACTION.md", False),
        ("docs/ORCHESTRATOR_STATE.md", False),
    ]
    out: list[dict[str, Any]] = []
    for rel, required in paths:
        p = repo_root / rel
        out.append(
            {
                "path": rel,
                "required": bool(required),
                "exists": bool(p.exists()),
                "sha256": _sha256_file(p) if p.exists() and p.is_file() else None,
            }
        )
    return out


def _escape_md_link_text(text: str) -> str:
    s = str(text)
    return (
        s.replace("\\", "\\\\")
        .replace("[", "\\[")
        .replace("]", "\\]")
        .replace("(", "\\(")
        .replace(")", "\\)")
    )


def _load_kb_profile_context(repo_root: Path, *, run_id: str) -> dict[str, Any] | None:
    kb_dir = repo_root / "artifacts" / "runs" / str(run_id) / "kb_profile"
    kb_profile_path = kb_dir / "kb_profile.json"
    report_path = kb_dir / "report.md"
    if not kb_profile_path.exists():
        return None

    payload: dict[str, Any] | None = None
    err: str | None = None
    try:
        raw = read_json(kb_profile_path)
        payload = raw if isinstance(raw, dict) else None
        if payload is None:
            err = "kb_profile.json is not a JSON object"
    except Exception as e:
        err = f"failed to read kb_profile.json: {e}"

    def rel(p: Path) -> str:
        try:
            return os.fspath(p.relative_to(repo_root)).replace(os.sep, "/")
        except Exception:
            return os.fspath(p)

    selected: list[dict[str, Any]] = []
    if payload and isinstance(payload.get("selected"), list):
        for e in payload.get("selected") or []:
            if not isinstance(e, dict):
                continue
            selected.append(
                {
                    "path": e.get("path"),
                    "kind": e.get("kind"),
                    "lang": e.get("lang"),
                    "sha256": e.get("sha256"),
                    "bytes": e.get("bytes"),
                    "title": e.get("title"),
                    "refkey": e.get("refkey"),
                }
            )

    return {
        "ok": err is None,
        "error": err,
        "kb_profile_json": rel(kb_profile_path),
        "kb_profile_report": rel(report_path) if report_path.exists() else None,
        "profile": payload.get("profile") if payload else None,
        "source": payload.get("source") if payload else None,
        "kb_index_path": payload.get("kb_index_path") if payload else None,
        "kb_index_sha256": payload.get("kb_index_sha256") if payload else None,
        "stats": payload.get("stats") if payload else None,
        "issues": payload.get("issues") if payload else None,
        "selected": selected,
    }


def build_context_pack(inps: ContextPackInputs, *, repo_root: Path) -> dict[str, Any]:
    if not inps.run_id or not str(inps.run_id).strip():
        raise ValueError("run_id is required")

    created_at = utc_now_iso().replace("+00:00", "Z")
    run_id = str(inps.run_id).strip()
    if "/" in run_id or "\\" in run_id or ".." in run_id:
        raise ValueError(f"run_id must not contain path separators or '..': {run_id!r}")
    workflow_id = str(inps.workflow_id).strip() if inps.workflow_id else None
    note = (inps.note or "").strip()

    out_dir = repo_root / "artifacts" / "runs" / run_id / "context"
    out_dir.mkdir(parents=True, exist_ok=True)

    context_json_path = out_dir / "context.json"
    context_md_path = out_dir / "context.md"

    git_meta = try_get_git_metadata(repo_root) or {}
    charter_line = _read_first_matching_line(repo_root / "PROJECT_CHARTER.md", "Status:")
    charter_status = charter_line.split(":", 1)[1].strip() if charter_line and ":" in charter_line else None

    wf_ctx: WorkflowContext | None = None
    if workflow_id:
        wf_ctx = workflow_context(workflow_id=workflow_id, run_id=run_id, refkey=inps.refkey)

    files = _default_context_files(repo_root)
    missing_required = [f["path"] for f in files if f.get("required") and not f.get("exists")]

    kb_profile_ctx = _load_kb_profile_context(repo_root, run_id=run_id)

    payload: dict[str, Any] = {
        "schema_version": 1,
        "created_at": created_at,
        "run_id": run_id,
        "workflow_id": workflow_id,
        "note": note or None,
        "git": git_meta or None,
        "project": {
            "charter_status": charter_status,
            "context_files": files,
            "missing_required_files": missing_required,
            "missing_required_files_count": int(len(missing_required)),
            "required_context_ok": int(len(missing_required) == 0),
        },
        "kb_profile": kb_profile_ctx,
        "workflow": (
            {
                "workflow_id": wf_ctx.workflow_id,
                "expected_outputs": wf_ctx.expected_outputs,
                "plan": wf_ctx.plan,
                "risks": wf_ctx.risks,
                "rollback": wf_ctx.rollback,
                "refkey": inps.refkey,
            }
            if wf_ctx
            else None
        ),
        "links": {
            "context_pack_md": os.fspath(context_md_path.relative_to(repo_root)),
            "context_pack_json": os.fspath(context_json_path.relative_to(repo_root)),
        },
    }

    write_json(context_json_path, payload)

    # Human-friendly view (MD) is a deterministic rendering of the JSON payload.
    def link(rel_path: str) -> str:
        return _rel_link(context_md_path, repo_root / rel_path)

    md_lines: list[str] = [
        f"# Context pack — {run_id}",
        "",
        f"- created_at: {created_at}",
        f"- workflow_id: {workflow_id or '(none)'}",
        f"- project charter status: {charter_status or '(unknown)'}",
    ]
    if git_meta:
        md_lines.append(f"- git: {git_meta.get('commit')} (dirty={git_meta.get('dirty')})")
    if note:
        md_lines.extend(["", "## Run note", "", note])

    md_lines.extend(
        [
            "",
            "## Global context (must stay in view)",
            "",
            "- Goals/anti-goals: "
            + f"[PROJECT_CHARTER.md]({link('PROJECT_CHARTER.md')})",
            "- Architecture map: " + f"[PROJECT_MAP.md]({link('PROJECT_MAP.md')})",
            "- Task board / roadmap: " + f"[RESEARCH_PLAN.md]({link('RESEARCH_PLAN.md')})",
            "- Problem Framing Snapshot + coverage matrix: " + f"[PREWORK.md]({link('PREWORK.md')})",
            "- Derivation notebook: " + f"[Draft_Derivation.md]({link('Draft_Derivation.md')})",
            "- KB index: " + f"[knowledge_base/_index/kb_index.json]({link('knowledge_base/_index/kb_index.json')})",
            "- Approval gates: " + f"[docs/APPROVAL_GATES.md]({link('docs/APPROVAL_GATES.md')})",
            "- Artifact contract: " + f"[docs/ARTIFACT_CONTRACT.md]({link('docs/ARTIFACT_CONTRACT.md')})",
            "- Eval gate contract: " + f"[docs/EVAL_GATE_CONTRACT.md]({link('docs/EVAL_GATE_CONTRACT.md')})",
        ]
    )

    md_lines.extend(["", "## Context file hashes (stability anchors)", ""])
    for item in files:
        p = str(item.get("path"))
        sha = item.get("sha256") or "(missing)"
        required = "required" if item.get("required") else "optional"
        md_lines.append(f"- {required}: `{p}` sha256={sha}")

    if kb_profile_ctx is not None:
        md_lines.extend(["", "## KB profile (reviewer context selection)", ""])
        if not kb_profile_ctx.get("ok"):
            md_lines.append(f"- status: error ({kb_profile_ctx.get('error')})")
        else:
            md_lines.append(f"- profile: {kb_profile_ctx.get('profile')}")
            kb_json = kb_profile_ctx.get("kb_profile_json")
            if isinstance(kb_json, str) and kb_json.strip():
                md_lines.append(f"- kb_profile.json: [{kb_json}]({link(kb_json)})")
            kb_report = kb_profile_ctx.get("kb_profile_report")
            if isinstance(kb_report, str) and kb_report.strip():
                md_lines.append(f"- report: [{kb_report}]({link(kb_report)})")
            src = kb_profile_ctx.get("source")
            if isinstance(src, str) and src.strip():
                md_lines.append(f"- source: [{src}]({link(src)})")
            stats = kb_profile_ctx.get("stats")
            if isinstance(stats, dict):
                total_entries = stats.get("total_entries")
                total_bytes = stats.get("total_bytes")
                if isinstance(total_entries, int) and not isinstance(total_entries, bool):
                    md_lines.append(f"- selected_entries: {total_entries}")
                if isinstance(total_bytes, int) and not isinstance(total_bytes, bool):
                    md_lines.append(f"- selected_bytes: {total_bytes}")

            selected = kb_profile_ctx.get("selected")
            if isinstance(selected, list) and selected:
                md_lines.extend(["", "### Selected KB files", ""])
                for e in selected[:200]:
                    if not isinstance(e, dict):
                        continue
                    p = e.get("path")
                    if not isinstance(p, str) or not p.strip():
                        continue
                    kind = str(e.get("kind") or "?")
                    lang = str(e.get("lang") or "?")
                    title = e.get("title")
                    label = _escape_md_link_text(title) if isinstance(title, str) and title.strip() else _escape_md_link_text(p)
                    md_lines.append(f"- ({kind}/{lang}) [{label}]({link(p)})")
                if len(selected) > 200:
                    md_lines.append(f"- ... ({len(selected) - 200} more)")

    if missing_required:
        md_lines.extend(["", "## Missing required context files", ""])
        for p in missing_required:
            md_lines.append(f"- `{p}`")

    if wf_ctx:
        md_lines.extend(["", "## Workflow intent (project-aligned)", ""])
        if inps.refkey:
            md_lines.append(f"- refkey: `{inps.refkey}`")
        md_lines.append("")
        md_lines.append("### Expected outputs")
        md_lines.append("")
        for o in wf_ctx.expected_outputs:
            md_lines.append(f"- `{o}`")
        md_lines.append("")
        md_lines.append("### Plan")
        md_lines.append("")
        for step in wf_ctx.plan:
            md_lines.append(f"- {step}")
        md_lines.append("")
        md_lines.append("### Risks")
        md_lines.append("")
        for r in wf_ctx.risks:
            md_lines.append(f"- {r}")
        md_lines.extend(["", "### Rollback", "", wf_ctx.rollback])

    md_lines.extend(
        [
            "",
            "## Why this exists",
            "",
            "This file is the guardrail against local optimizations that drift away from the end-to-end goals "
            "(correctness, quality, reproducibility, and safe human approvals).",
            "",
        ]
    )

    context_md_path.write_text("\n".join(md_lines).rstrip() + "\n", encoding="utf-8")

    return {
        "context_dir": os.fspath(out_dir.relative_to(repo_root)),
        "context_md": os.fspath(context_md_path.relative_to(repo_root)),
        "context_json": os.fspath(context_json_path.relative_to(repo_root)),
        "missing_required_files": missing_required,
    }
