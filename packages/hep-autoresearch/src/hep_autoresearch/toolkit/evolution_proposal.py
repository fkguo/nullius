from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any

from ._time import utc_now_iso
from .evolution_proposal_analysis import build_proposal_analysis
from .evolution_proposal_outputs import make_output_paths, write_output_bundle


@dataclass(frozen=True)
class EvolutionProposalInputs:
    tag: str
    source_run_tag: str
    max_proposals: int = 20
    include_eval_failures: bool = True
    write_kb_trace: bool = True
    kb_trace_path: str | None = None
    trigger_mode: str | None = None
    terminal_status: str | None = None


def _require_non_empty(value: str, *, field: str) -> str:
    text = str(value or "").strip()
    if not text:
        raise ValueError(f"{field} is required")
    return text


def evolution_proposal_one(inps: EvolutionProposalInputs, repo_root: Path) -> dict[str, Any]:
    tag = _require_non_empty(inps.tag, field="tag")
    source_run_tag = _require_non_empty(inps.source_run_tag, field="source_run_tag")
    created_at = utc_now_iso()
    paths = make_output_paths(repo_root=repo_root, tag=tag)
    suggested_eval_case_rel = str(paths["suggested_eval_case"].relative_to(repo_root))
    trace_stub_rel = str(paths["trace_stub_md"].relative_to(repo_root))
    analysis = build_proposal_analysis(
        repo_root=repo_root,
        tag=tag,
        source_run_tag=source_run_tag,
        max_proposals=int(inps.max_proposals),
        include_eval_failures=bool(inps.include_eval_failures),
        write_kb_trace=bool(inps.write_kb_trace),
        trigger_mode=str(inps.trigger_mode) if inps.trigger_mode else None,
        terminal_status=str(inps.terminal_status) if inps.terminal_status else None,
        created_at=created_at,
        suggested_eval_case_rel=suggested_eval_case_rel,
        trace_stub_rel=trace_stub_rel,
    )
    return write_output_bundle(
        repo_root=repo_root,
        tag=tag,
        source_run_tag=source_run_tag,
        max_proposals=int(inps.max_proposals),
        include_eval_failures=bool(inps.include_eval_failures),
        write_kb_trace=bool(inps.write_kb_trace),
        kb_trace_path=str(inps.kb_trace_path) if inps.kb_trace_path else None,
        trigger_mode=str(inps.trigger_mode) if inps.trigger_mode else None,
        terminal_status=str(inps.terminal_status) if inps.terminal_status else None,
        created_at=created_at,
        paths=paths,
        analysis=analysis,
    )
