from __future__ import annotations

import os
from pathlib import Path
from typing import Any, Iterable

from ._json import read_json
from .evolution_proposal_history import dedupe_candidate_proposals


AUTO_HANDLED_REASON = (
    "Bounded triage/read/analyze work is auto-handled inside EVO-10; "
    "no approval queue entry is created."
)


def _rel(repo_root: Path, path: Path) -> str:
    return os.fspath(path.relative_to(repo_root))


def _is_under_any(path: Path, needles: Iterable[str]) -> bool:
    return any(needle in set(path.parts) for needle in needles)


def _classify_error_messages(errors: list[str], ok_flag: bool | None) -> tuple[str, str, str]:
    joined = "\n".join(errors).lower()
    severity = "high" if ok_flag is False else "medium" if errors else "low"
    if any(token in joined for token in ("ssl", "certificate", "tls", "urlopen error", "timed out", "timeout", "connection reset", "eof occurred")):
        return "network_flakiness", severity, "External network/SSL failure during retrieval (should be retried/backed off and made deterministic for evals)."
    if "missing" in joined or "not found" in joined or "no such file" in joined:
        return "missing_inputs", severity, "Missing required inputs/assets (should fail-fast with actionable diagnostics and a regression anchor)."
    if any(token in joined for token in ("nan", "overflow", "diverg", "singular", "ill-conditioned")):
        return "numeric_instability", severity, "Numerical instability detected (needs diagnostics + stability gate + regression anchor)."
    return "unknown_failure", severity, "Unhandled failure mode (needs triage, categorization, and a minimal reproducible regression anchor)."


def _iter_analysis_json(repo_root: Path, source_run_dir: Path) -> list[Path]:
    if not source_run_dir.exists():
        return []
    files: list[Path] = []
    for path in sorted(source_run_dir.rglob("analysis.json")):
        rel = path.relative_to(repo_root)
        if _is_under_any(rel, {"approvals", "context", "dual_review", "evolution_proposal"}):
            continue
        files.append(path)
    return files


def _read_results_failure(path: Path) -> tuple[dict[str, Any] | None, list[str], bool | None]:
    payload = read_json(path)
    results = payload.get("results") if isinstance(payload, dict) else None
    if not isinstance(results, dict):
        return None, [], None
    errors = [error.strip() for error in results.get("errors") or [] if isinstance(error, str) and error.strip()]
    ok_value = results.get("ok") if "ok" in results else None
    ok_flag = bool(ok_value) if isinstance(ok_value, bool) else None
    if ok_flag is False or errors:
        return payload, errors, ok_flag
    return None, [], ok_flag


def _auto_handled_action(*, action_type: str, description: str, created_at: str) -> dict[str, Any]:
    return {
        "type": action_type,
        "description": description,
        "handling": "auto_handled",
        "handled_at": created_at,
        "handled_reason": AUTO_HANDLED_REASON,
    }


def _finalize_proposal_handling(proposal: dict[str, Any], *, created_at: str) -> None:
    actions = proposal.get("actions")
    proposal.pop("requires_approval", None)
    proposal.pop("handling", None)
    proposal.pop("handled_at", None)
    proposal.pop("handled_reason", None)
    if not isinstance(actions, list):
        return
    required = sorted(
        str(action.get("requires_approval") or "").strip()
        for action in actions
        if isinstance(action, dict) and str(action.get("requires_approval") or "").strip()
    )
    if required:
        proposal["requires_approval"] = required[0]
        return
    proposal["handling"] = "auto_handled"
    proposal["handled_at"] = created_at
    proposal["handled_reason"] = AUTO_HANDLED_REASON


def build_proposal_analysis(
    *,
    repo_root: Path,
    tag: str,
    source_run_tag: str,
    max_proposals: int,
    include_eval_failures: bool,
    write_kb_trace: bool,
    trigger_mode: str | None,
    terminal_status: str | None,
    created_at: str,
    suggested_eval_case_rel: str,
    trace_stub_rel: str,
) -> dict[str, Any]:
    source_run_dir = repo_root / "artifacts" / "runs" / source_run_tag
    candidate_proposals: list[dict[str, Any]] = []
    for path in _iter_analysis_json(repo_root, source_run_dir):
        payload, errors, ok_flag = _read_results_failure(path)
        if payload is None:
            continue
        if len(candidate_proposals) >= max_proposals:
            break
        kind, severity, summary = _classify_error_messages(errors, ok_flag)
        rel_path = _rel(repo_root, path)
        evidence = [{"path": rel_path, "pointer": f"#/results/errors/{idx}", "message": message} for idx, message in enumerate(errors[:10])]
        if ok_flag is False:
            evidence.insert(0, {"path": rel_path, "pointer": "#/results/ok", "message": "results.ok == false"})
        actions: list[dict[str, Any]] = [
            _auto_handled_action(action_type="triage", description=f"Reproduce and categorize this failure mode ({kind}) into a stable bucket.", created_at=created_at),
            {"type": "eval", "description": "Add a deterministic regression anchor (no live network) so this failure cannot silently return.", "requires_approval": "A2"},
        ]
        if kind == "network_flakiness":
            actions.append({"type": "code_change", "description": "Implement retry/backoff + offline fallback for metadata/bibtex retrieval; keep errors evidence-first.", "requires_approval": "A2"})
        if kind == "numeric_instability":
            actions.append({"type": "code_change", "description": "Add diagnostics (conditioning, step sizes, invariants) and a stability gate before promoting results.", "requires_approval": "A2"})
        candidate_proposals.append(
            {
                "kind": kind,
                "severity": severity,
                "summary": summary,
                "target_file": rel_path,
                "source": {"source_run_tag": source_run_tag, "analysis_path": rel_path},
                "evidence": evidence,
                "actions": actions,
                "bindings": {"suggested_eval_case_path": suggested_eval_case_rel, "trace_stub_path": trace_stub_rel},
            }
        )
    if include_eval_failures:
        eval_analysis = source_run_dir / "evals" / "analysis.json"
        if eval_analysis.exists():
            try:
                payload = read_json(eval_analysis)
                results = payload.get("results") if isinstance(payload, dict) else None
                failed_cases = [
                    {"case_id": case.get("case_id"), "messages": case.get("messages") if isinstance(case.get("messages"), list) else []}
                    for case in (results.get("cases") or [])
                    if isinstance(results, dict) and results.get("ok") is False and isinstance(case, dict) and case.get("ok") is not True
                ]
                if failed_cases and len(candidate_proposals) < max_proposals:
                    rel_path = _rel(repo_root, eval_analysis)
                    candidate_proposals.append(
                        {
                            "kind": "eval_failures",
                            "severity": "high",
                            "summary": "Eval suite reported failures (treat as hard gate before promotion).",
                            "target_file": rel_path,
                            "source": {"source_run_tag": source_run_tag, "analysis_path": rel_path},
                            "evidence": [{"path": rel_path, "pointer": "#/results/ok", "message": "results.ok == false"}],
                            "actions": [
                                {"type": "triage", "description": "Inspect failed cases and decide: fix code or update eval expectations (never both blindly).", "requires_approval": "A2"},
                                _auto_handled_action(action_type="kb_trace", description="Record root cause and decision (bug vs. intended change) as an append-only trace.", created_at=created_at),
                            ],
                            "bindings": {"trace_stub_path": trace_stub_rel},
                            "details": {"failed_cases": failed_cases[:20]},
                        }
                    )
            except Exception:  # CONTRACT-EXEMPT: CODE-01.5 skip unreadable eval artifacts
                pass
    proposals, suppressed_duplicates, empty_cycles, threshold = dedupe_candidate_proposals(
        candidate_proposals,
        repo_root=repo_root,
        tag=tag,
        source_run_tag=source_run_tag,
        created_at=created_at,
        finalize_proposal=_finalize_proposal_handling,
    )
    stagnation_detected = not proposals and empty_cycles >= threshold
    return {
        "schema_version": 1,
        "created_at": created_at,
        "inputs": {
            "tag": tag,
            "source_run_tag": source_run_tag,
            "max_proposals": max_proposals,
            "include_eval_failures": include_eval_failures,
            "write_kb_trace": write_kb_trace,
            "trigger_mode": trigger_mode,
            "terminal_status": terminal_status,
        },
        "results": {
            "ok": True,
            "proposals_total": len(proposals),
            "proposals": proposals,
            "suppressed_duplicates": suppressed_duplicates,
            "suppressed_duplicates_total": len(suppressed_duplicates),
            "repair_loop_detected": bool(suppressed_duplicates),
            "consecutive_empty_cycles": empty_cycles,
            "stagnation": {"detected": stagnation_detected, "threshold": threshold, "reason": "consecutive_empty_cycles" if stagnation_detected else None},
        },
    }
