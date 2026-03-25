from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from .evolution_proposal import EvolutionProposalInputs, evolution_proposal_one


_TERMINAL_STATUSES = frozenset({"completed", "failed"})


@dataclass(frozen=True)
class EvolutionTriggerResult:
    status: str
    reason: str | None = None
    artifact_dir: str | None = None
    artifact_paths: dict[str, str] | None = None


def _existing_artifact_paths(repo_root: Path, run_id: str) -> tuple[str, dict[str, str]] | None:
    artifact_dir = repo_root / "artifacts" / "runs" / run_id / "evolution_proposal"
    analysis_path = artifact_dir / "analysis.json"
    if not analysis_path.exists():
        return None

    rel_dir = str(artifact_dir.relative_to(repo_root))
    paths: dict[str, str] = {}
    for name, key in [
        ("manifest.json", "manifest"),
        ("summary.json", "summary"),
        ("analysis.json", "analysis"),
        ("report.md", "report"),
        ("proposal.md", "proposal_md"),
        ("trace_stub.md", "trace_stub_md"),
        ("suggested_eval_case.case.json", "suggested_eval_case"),
    ]:
        candidate = artifact_dir / name
        if candidate.exists():
            paths[key] = str(candidate.relative_to(repo_root))
    return rel_dir, paths


def trigger_evolution_proposal(
    *,
    repo_root: Path,
    run_id: str,
    workflow_id: str | None,
    terminal_status: str,
) -> EvolutionTriggerResult:
    source_run_tag = str(run_id or "").strip()
    status = str(terminal_status or "").strip()
    if not source_run_tag:
        return EvolutionTriggerResult(status="failed", reason="missing_run_id")
    if status not in _TERMINAL_STATUSES:
        return EvolutionTriggerResult(status="skipped", reason=f"unsupported_status:{status or '(empty)'}")

    run_dir = repo_root / "artifacts" / "runs" / source_run_tag
    if not run_dir.exists():
        return EvolutionTriggerResult(status="skipped", reason="missing_run_dir")

    existing = _existing_artifact_paths(repo_root, source_run_tag)
    if existing is not None:
        artifact_dir, artifact_paths = existing
        return EvolutionTriggerResult(
            status="skipped",
            reason="already_exists",
            artifact_dir=artifact_dir,
            artifact_paths=artifact_paths,
        )

    try:
        result = evolution_proposal_one(
            EvolutionProposalInputs(
                tag=source_run_tag,
                source_run_tag=source_run_tag,
                write_kb_trace=False,
                trigger_mode="auto_terminal",
                terminal_status=status,
            ),
            repo_root=repo_root,
        )
    except Exception as exc:
        wf = str(workflow_id or "").strip() or "(unknown)"
        return EvolutionTriggerResult(
            status="failed",
            reason=f"{type(exc).__name__} while auto-triggering {wf}: {exc}",
        )

    artifact_paths = result.get("artifact_paths")
    if not isinstance(artifact_paths, dict):
        artifact_paths = {}
    return EvolutionTriggerResult(
        status="triggered",
        artifact_dir=str(result.get("artifact_dir") or ""),
        artifact_paths={str(k): str(v) for k, v in artifact_paths.items()},
    )
