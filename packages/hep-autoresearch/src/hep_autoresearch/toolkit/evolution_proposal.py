from __future__ import annotations

import os
import platform
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable

from ._git import try_get_git_metadata
from ._json import read_json, write_json
from ._paths import manifest_cwd
from ._time import utc_now_iso
from .artifact_report import write_artifact_report


@dataclass(frozen=True)
class EvolutionProposalInputs:
    tag: str
    source_run_tag: str
    max_proposals: int = 20
    include_eval_failures: bool = True
    write_kb_trace: bool = True
    kb_trace_path: str | None = None


def _truncate(s: str, *, max_chars: int = 200) -> str:
    s = str(s)
    if len(s) <= max_chars:
        return s
    return s[: max(0, max_chars - 3)].rstrip() + "..."


def _rel(repo_root: Path, p: Path) -> str:
    return os.fspath(p.relative_to(repo_root))


def _is_under_any(p: Path, needles: Iterable[str]) -> bool:
    parts = set(p.parts)
    return any(n in parts for n in needles)


def _classify_error_messages(errors: list[str], ok_flag: bool | None) -> tuple[str, str, str]:
    joined = "\n".join(errors).lower()
    severity = "high" if ok_flag is False else "medium" if errors else "low"

    if any(
        tok in joined
        for tok in [
            "ssl",
            "certificate",
            "tls",
            "urlopen error",
            "timed out",
            "timeout",
            "connection reset",
            "eof occurred",
        ]
    ):
        kind = "network_flakiness"
        summary = "External network/SSL failure during retrieval (should be retried/backed off and made deterministic for evals)."
        return kind, severity, summary

    if "missing" in joined or "not found" in joined or "no such file" in joined:
        kind = "missing_inputs"
        summary = "Missing required inputs/assets (should fail-fast with actionable diagnostics and a regression anchor)."
        return kind, severity, summary

    if any(tok in joined for tok in ["nan", "overflow", "diverg", "singular", "ill-conditioned"]):
        kind = "numeric_instability"
        summary = "Numerical instability detected (needs diagnostics + stability gate + regression anchor)."
        return kind, severity, summary

    kind = "unknown_failure"
    summary = "Unhandled failure mode (needs triage, categorization, and a minimal reproducible regression anchor)."
    return kind, severity, summary


def _iter_analysis_json(repo_root: Path, source_run_dir: Path) -> list[Path]:
    if not source_run_dir.exists():
        return []
    out: list[Path] = []
    for p in sorted(source_run_dir.rglob("analysis.json")):
        rel = p.relative_to(repo_root)
        # Avoid self-recursion and noisy directories.
        if _is_under_any(rel, {"approvals", "context", "dual_review", "evolution_proposal"}):
            continue
        out.append(p)
    return out


def _read_results_failure(p: Path) -> tuple[dict[str, Any] | None, list[str], bool | None]:
    payload = read_json(p)
    results = payload.get("results") if isinstance(payload, dict) else None
    if not isinstance(results, dict):
        return None, [], None
    errors_raw = results.get("errors")
    errors: list[str] = []
    if isinstance(errors_raw, list):
        for e in errors_raw:
            if isinstance(e, str) and e.strip():
                errors.append(e.strip())
    ok_val = results.get("ok") if "ok" in results else None
    ok_flag: bool | None
    if isinstance(ok_val, bool):
        ok_flag = bool(ok_val)
    else:
        ok_flag = None
    if ok_flag is False or errors:
        return payload, errors, ok_flag
    return None, [], ok_flag


def _write_text(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content.rstrip() + "\n", encoding="utf-8")


def _render_proposals_md(*, repo_root: Path, out_dir: Path, analysis: dict[str, Any]) -> str:
    rel_dir = _rel(repo_root, out_dir)
    proposals = ((analysis.get("results") or {}).get("proposals") or []) if isinstance(analysis, dict) else []
    if not isinstance(proposals, list):
        proposals = []

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
        lines.append("- (no proposals generated)")
        lines.append("")
        return "\n".join(lines).rstrip() + "\n"

    for idx, p in enumerate(proposals):
        if not isinstance(p, dict):
            continue
        pid = p.get("proposal_id") or f"P{idx + 1:03d}"
        kind = p.get("kind") or "(unknown)"
        severity = p.get("severity") or "(unknown)"
        summary = p.get("summary") or ""
        requires = p.get("requires_approval") or "(none)"
        ptr_base = f"analysis.json#/results/proposals/{idx}"

        lines.extend(
            [
                f"### {pid} — {kind} (severity={severity})",
                "",
                f"- requires_approval: `{requires}` (`{ptr_base}/requires_approval`)",
                f"- summary: {summary} (`{ptr_base}/summary`)",
                "",
            ]
        )

        evidence = p.get("evidence")
        if isinstance(evidence, list) and evidence:
            lines.append("**Evidence**")
            for ev in evidence[:12]:
                if not isinstance(ev, dict):
                    continue
                path = ev.get("path") or ""
                pointer = ev.get("pointer") or ""
                msg = ev.get("message") or ""
                lines.append(f"- `{path}{pointer}` — `{_truncate(msg, max_chars=200)}`")
            if len(evidence) > 12:
                lines.append(f"- … ({len(evidence) - 12} more; see `{ptr_base}/evidence`)")
            lines.append("")

        actions = p.get("actions")
        if isinstance(actions, list) and actions:
            lines.append("**Next actions**")
            for a in actions[:12]:
                if not isinstance(a, dict):
                    continue
                atype = a.get("type") or "(type?)"
                desc = a.get("description") or ""
                req = a.get("requires_approval") or "(none)"
                lines.append(f"- {atype}: {desc} (requires `{req}`)")
            if len(actions) > 12:
                lines.append(f"- … ({len(actions) - 12} more; see `{ptr_base}/actions`)")
            lines.append("")

        bindings = p.get("bindings")
        if isinstance(bindings, dict) and bindings:
            lines.append("**Bindings (suggested artifacts)**")
            eval_skel = bindings.get("suggested_eval_case_path")
            trace_stub = bindings.get("trace_stub_path")
            if eval_skel:
                lines.append(f"- suggested_eval_case_path: `{eval_skel}`")
            if trace_stub:
                lines.append(f"- trace_stub_path: `{trace_stub}`")
            lines.append("")

    return "\n".join(lines).rstrip() + "\n"


def _render_trace_stub_md(*, source_run_tag: str, proposals: list[dict[str, Any]], proposal_dir_rel: str) -> str:
    proposal_dir_rel = str(proposal_dir_rel).rstrip("/")
    proposal_md = f"{proposal_dir_rel}/proposal.md"
    source_run_dir = f"artifacts/runs/{str(source_run_tag).strip().rstrip('/')}"

    lines: list[str] = [
        "# Methodology trace — Evolution proposal (v0)",
        "",
        "This trace records a concrete failure→proposal mapping for audit and future regression hardening.",
        "",
        f"- source_run_tag: `{source_run_tag}`",
        f"- source_run_dir: [{source_run_dir}]({source_run_dir})",
        f"- proposal_artifacts: [{proposal_dir_rel}]({proposal_dir_rel})",
        f"- proposal_md: [proposal.md]({proposal_md})",
        "",
        "## What failed / what looked risky",
        "",
    ]

    if not proposals:
        lines.append("- (no proposals generated)")
        lines.append("")
        return "\n".join(lines).rstrip() + "\n"

    for p in proposals[:20]:
        pid = p.get("proposal_id") or "(id?)"
        kind = p.get("kind") or "(kind?)"
        summary = p.get("summary") or ""
        lines.append(f"- {pid} [{kind}]: {summary}")
    lines.append("")

    lines.extend(
        [
            "## Next actions (human-approved when needed)",
            "",
            "- For any code change, require an explicit A2 approval packet and add/extend an eval regression anchor.",
            "- Prefer deterministic failure injection (stubs) over live network calls in evals.",
            "",
        ]
    )
    return "\n".join(lines).rstrip() + "\n"


def evolution_proposal_one(inps: EvolutionProposalInputs, repo_root: Path) -> dict[str, Any]:
    if not inps.tag or not str(inps.tag).strip():
        raise ValueError("tag is required")
    if not inps.source_run_tag or not str(inps.source_run_tag).strip():
        raise ValueError("source_run_tag is required")

    created_at = utc_now_iso()
    out_dir = repo_root / "artifacts" / "runs" / str(inps.tag) / "evolution_proposal"
    out_dir.mkdir(parents=True, exist_ok=True)

    manifest_path = out_dir / "manifest.json"
    summary_path = out_dir / "summary.json"
    analysis_path = out_dir / "analysis.json"
    report_path = out_dir / "report.md"
    proposal_md_path = out_dir / "proposal.md"
    trace_stub_path = out_dir / "trace_stub.md"
    suggested_eval_case_path = out_dir / "suggested_eval_case.case.json"

    versions: dict[str, Any] = {"python": os.sys.version.split()[0], "os": platform.platform()}

    source_run_dir = repo_root / "artifacts" / "runs" / str(inps.source_run_tag)
    analysis_files = _iter_analysis_json(repo_root, source_run_dir)

    proposals: list[dict[str, Any]] = []
    for p in analysis_files:
        payload, errors, ok_flag = _read_results_failure(p)
        if payload is None:
            continue
        if len(proposals) >= int(inps.max_proposals):
            break

        kind, severity, summary = _classify_error_messages(errors, ok_flag)
        rel_path = _rel(repo_root, p)
        evidence: list[dict[str, Any]] = []
        for i, msg in enumerate(errors[:10]):
            evidence.append(
                {
                    "path": rel_path,
                    "pointer": f"#/results/errors/{i}",
                    "message": msg,
                }
            )
        if ok_flag is False:
            evidence.insert(
                0,
                {
                    "path": rel_path,
                    "pointer": "#/results/ok",
                    "message": "results.ok == false",
                },
            )

        actions: list[dict[str, Any]] = [
            {
                "type": "triage",
                "description": f"Reproduce and categorize this failure mode ({kind}) into a stable bucket.",
                "requires_approval": "A0",
            },
            {
                "type": "eval",
                "description": "Add a deterministic regression anchor (no live network) so this failure cannot silently return.",
                "requires_approval": "A2",
            },
        ]
        if kind in {"network_flakiness"}:
            actions.append(
                {
                    "type": "code_change",
                    "description": "Implement retry/backoff + offline fallback for metadata/bibtex retrieval; keep errors evidence-first.",
                    "requires_approval": "A2",
                }
            )
        if kind in {"numeric_instability"}:
            actions.append(
                {
                    "type": "code_change",
                    "description": "Add diagnostics (conditioning, step sizes, invariants) and a stability gate before promoting results.",
                    "requires_approval": "A2",
                }
            )

        proposal_id = f"P{len(proposals) + 1:03d}"
        proposals.append(
            {
                "proposal_id": proposal_id,
                "kind": kind,
                "severity": severity,
                "summary": summary,
                "requires_approval": "A2" if any(a.get("type") == "code_change" for a in actions) else "A0",
                "source": {"source_run_tag": str(inps.source_run_tag), "analysis_path": rel_path},
                "evidence": evidence,
                "actions": actions,
                "bindings": {
                    "suggested_eval_case_path": _rel(repo_root, suggested_eval_case_path),
                    "trace_stub_path": _rel(repo_root, trace_stub_path),
                },
            }
        )

    # Optionally: include eval failures from the source run
    if inps.include_eval_failures:
        eval_analysis = source_run_dir / "evals" / "analysis.json"
        if eval_analysis.exists():
            try:
                payload = read_json(eval_analysis)
                results = payload.get("results") if isinstance(payload, dict) else None
                if isinstance(results, dict) and results.get("ok") is False:
                    failed_cases: list[dict[str, Any]] = []
                    for c in (results.get("cases") or []):
                        if not isinstance(c, dict) or c.get("ok") is True:
                            continue
                        failed_cases.append(
                            {
                                "case_id": c.get("case_id"),
                                "messages": c.get("messages") if isinstance(c.get("messages"), list) else [],
                            }
                        )
                    if failed_cases and len(proposals) < int(inps.max_proposals):
                        proposals.append(
                            {
                                "proposal_id": f"P{len(proposals) + 1:03d}",
                                "kind": "eval_failures",
                                "severity": "high",
                                "summary": "Eval suite reported failures (treat as hard gate before promotion).",
                                "requires_approval": "A2",
                                "source": {"source_run_tag": str(inps.source_run_tag), "analysis_path": _rel(repo_root, eval_analysis)},
                                "evidence": [
                                    {
                                        "path": _rel(repo_root, eval_analysis),
                                        "pointer": "#/results/ok",
                                        "message": "results.ok == false",
                                    }
                                ],
                                "actions": [
                                    {
                                        "type": "triage",
                                        "description": "Inspect failed cases and decide: fix code or update eval expectations (never both blindly).",
                                        "requires_approval": "A2",
                                    },
                                    {
                                        "type": "kb_trace",
                                        "description": "Record root cause and decision (bug vs. intended change) as an append-only trace.",
                                        "requires_approval": "A0",
                                    },
                                ],
                                "bindings": {"trace_stub_path": _rel(repo_root, trace_stub_path)},
                                "details": {"failed_cases": failed_cases[:20]},
                            }
                        )
            except Exception:
                # Keep proposal generation robust: ignore unreadable eval artifacts.
                pass

    analysis: dict[str, Any] = {
        "schema_version": 1,
        "created_at": created_at,
        "inputs": {
            "tag": str(inps.tag),
            "source_run_tag": str(inps.source_run_tag),
            "max_proposals": int(inps.max_proposals),
            "include_eval_failures": bool(inps.include_eval_failures),
            "write_kb_trace": bool(inps.write_kb_trace),
        },
        "results": {
            "ok": True,
            "proposals_total": len(proposals),
            "proposals": proposals,
        },
    }

    manifest: dict[str, Any] = {
        "schema_version": 1,
        "created_at": created_at,
        "command": "python3 scripts/run_evolution_proposal.py",
        "cwd": manifest_cwd(repo_root=repo_root, cwd=repo_root),
        "params": {
            "tag": str(inps.tag),
            "source_run_tag": str(inps.source_run_tag),
            "max_proposals": int(inps.max_proposals),
            "include_eval_failures": bool(inps.include_eval_failures),
            "write_kb_trace": bool(inps.write_kb_trace),
        },
        "versions": versions,
        "outputs": [
            _rel(repo_root, manifest_path),
            _rel(repo_root, summary_path),
            _rel(repo_root, analysis_path),
            _rel(repo_root, report_path),
            _rel(repo_root, proposal_md_path),
            _rel(repo_root, trace_stub_path),
            _rel(repo_root, suggested_eval_case_path),
        ],
    }
    git_meta = try_get_git_metadata(repo_root)
    if git_meta:
        manifest["git"] = git_meta

    summary: dict[str, Any] = {
        "schema_version": 1,
        "created_at": created_at,
        "definitions": {"workflow": "EVOLUTION_proposal", "kind": "evolution_proposal"},
        "stats": {"proposals_total": len(proposals)},
        "outputs": {
            "analysis": _rel(repo_root, analysis_path),
            "proposal_md": _rel(repo_root, proposal_md_path),
            "trace_stub_md": _rel(repo_root, trace_stub_path),
            "suggested_eval_case": _rel(repo_root, suggested_eval_case_path),
        },
    }

    # Suggested eval skeleton (as an artifact; applying it to evals/ requires A2).
    suggested_eval: dict[str, Any] = {
        "schema_version": 1,
        "case_id": "E??-todo-failure-regression-anchor",
        "workflow": "custom",
        "description": "TODO: turn one proposal into a deterministic eval case (no live network).",
        "inputs": {"source_run_tag": str(inps.source_run_tag), "proposal_tag": str(inps.tag)},
        "acceptance": {"required_paths_exist": [_rel(repo_root, proposal_md_path), _rel(repo_root, analysis_path)]},
        "notes": "Generated as a skeleton. Copy into evals/cases/ and refine case_id + acceptance.",
    }

    write_json(manifest_path, manifest)
    write_json(summary_path, summary)
    write_json(analysis_path, analysis)
    report_rel = write_artifact_report(
        repo_root=repo_root, artifact_dir=out_dir, manifest=manifest, summary=summary, analysis=analysis
    )
    _write_text(proposal_md_path, _render_proposals_md(repo_root=repo_root, out_dir=out_dir, analysis=analysis))
    _write_text(
        trace_stub_path,
        _render_trace_stub_md(
            source_run_tag=str(inps.source_run_tag),
            proposals=proposals,
            proposal_dir_rel=os.fspath(out_dir.relative_to(repo_root)),
        ),
    )
    write_json(suggested_eval_case_path, suggested_eval)

    if inps.write_kb_trace:
        if inps.kb_trace_path:
            kb_path = repo_root / str(inps.kb_trace_path)
        else:
            kb_path = (
                repo_root
                / "knowledge_base"
                / "methodology_traces"
                / f"{created_at[:10]}_t23_evolution_proposal_{inps.tag}.md"
            )
        _write_text(
            kb_path,
            _render_trace_stub_md(
                source_run_tag=str(inps.source_run_tag),
                proposals=proposals,
                proposal_dir_rel=os.fspath(out_dir.relative_to(repo_root)),
            ),
        )

    return {
        "artifact_dir": os.fspath(out_dir.relative_to(repo_root)),
        "artifact_paths": {
            "manifest": _rel(repo_root, manifest_path),
            "summary": _rel(repo_root, summary_path),
            "analysis": _rel(repo_root, analysis_path),
            "report": report_rel,
            "proposal_md": _rel(repo_root, proposal_md_path),
            "trace_stub_md": _rel(repo_root, trace_stub_path),
            "suggested_eval_case": _rel(repo_root, suggested_eval_case_path),
        },
        "proposals_total": len(proposals),
    }
