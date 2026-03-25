from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any

from ._json import read_json


EMPTY_CYCLE_THRESHOLD = 3


@dataclass(frozen=True)
class KnownProposalAction:
    fingerprint_key: str
    failure_class: str
    target_file: str
    action_type: str
    source_run_tag: str
    analysis_path: str
    proposal_id: str


@dataclass(frozen=True)
class ProposalHistory:
    known_actions: dict[str, KnownProposalAction]
    consecutive_empty_cycles: int
    empty_cycle_threshold: int = EMPTY_CYCLE_THRESHOLD


def make_action_fingerprint(*, failure_class: str, target_file: str, action_type: str) -> str:
    return "|".join(
        [
            str(failure_class or "").strip(),
            str(target_file or "").strip(),
            str(action_type or "").strip(),
        ]
    )


def proposal_target_file(proposal: dict[str, Any]) -> str:
    target_file = str(proposal.get("target_file") or "").strip()
    if target_file:
        return target_file
    source = proposal.get("source") if isinstance(proposal.get("source"), dict) else {}
    return str(source.get("analysis_path") or "").strip()


def load_proposal_history(repo_root: Path, *, current_tag: str) -> ProposalHistory:
    runs_root = repo_root / "artifacts" / "runs"
    if not runs_root.exists():
        return ProposalHistory(known_actions={}, consecutive_empty_cycles=0)

    known_actions: dict[str, KnownProposalAction] = {}
    history_counts: list[tuple[str, str, int]] = []

    for analysis_path in sorted(runs_root.glob("*/evolution_proposal/analysis.json")):
        try:
            source_run_tag = analysis_path.parents[1].name
        except IndexError:
            continue
        if source_run_tag == str(current_tag):
            continue
        try:
            payload = read_json(analysis_path)
        except Exception:
            continue

        results = payload.get("results") if isinstance(payload, dict) else None
        proposals = results.get("proposals") if isinstance(results, dict) else None
        created_at = str(payload.get("created_at") or "")
        proposal_count = len(proposals) if isinstance(proposals, list) else 0
        history_counts.append((created_at, source_run_tag, proposal_count))

        if not isinstance(proposals, list):
            continue
        for proposal in proposals:
            if not isinstance(proposal, dict):
                continue
            failure_class = str(proposal.get("kind") or "").strip()
            target_file = proposal_target_file(proposal)
            proposal_id = str(proposal.get("proposal_id") or "").strip()
            actions = proposal.get("actions")
            if not isinstance(actions, list):
                continue
            for action in actions:
                if not isinstance(action, dict):
                    continue
                action_type = str(action.get("type") or "").strip()
                if not (failure_class and target_file and action_type):
                    continue
                fingerprint_key = make_action_fingerprint(
                    failure_class=failure_class,
                    target_file=target_file,
                    action_type=action_type,
                )
                known_actions.setdefault(
                    fingerprint_key,
                    KnownProposalAction(
                        fingerprint_key=fingerprint_key,
                        failure_class=failure_class,
                        target_file=target_file,
                        action_type=action_type,
                        source_run_tag=source_run_tag,
                        analysis_path=str(analysis_path.relative_to(repo_root)),
                        proposal_id=proposal_id,
                    ),
                )

    history_counts.sort(key=lambda item: (item[0], item[1]))
    consecutive_empty_cycles = 0
    for _, _, proposal_count in reversed(history_counts):
        if proposal_count > 0:
            break
        consecutive_empty_cycles += 1

    return ProposalHistory(
        known_actions=known_actions,
        consecutive_empty_cycles=consecutive_empty_cycles,
    )
