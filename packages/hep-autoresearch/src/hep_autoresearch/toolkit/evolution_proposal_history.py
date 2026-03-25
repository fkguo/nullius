from __future__ import annotations

from collections.abc import Callable
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


def _known_value(known: Any, field: str) -> str:
    if hasattr(known, field):
        return str(getattr(known, field) or "")
    if isinstance(known, dict):
        return str(known.get(field) or "")
    return ""


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


def dedupe_candidate_proposals(
    candidate_proposals: list[dict[str, Any]],
    *,
    repo_root: Path,
    tag: str,
    source_run_tag: str,
    created_at: str,
    finalize_proposal: Callable[..., None],
) -> tuple[list[dict[str, Any]], list[dict[str, Any]], int, int]:
    history = load_proposal_history(repo_root, current_tag=tag)
    seen: dict[str, Any] = dict(history.known_actions)
    proposals: list[dict[str, Any]] = []
    suppressed_duplicates: list[dict[str, Any]] = []
    for candidate in candidate_proposals:
        failure_class = str(candidate.get("kind") or "").strip()
        target_file = str(candidate.get("target_file") or "").strip()
        actions = candidate.get("actions")
        if not isinstance(actions, list):
            continue
        kept_actions: list[dict[str, Any]] = []
        new_fingerprints: list[tuple[str, str]] = []
        for action in actions:
            if not isinstance(action, dict):
                continue
            action_type = str(action.get("type") or "").strip()
            if not (failure_class and target_file and action_type):
                kept_actions.append(action)
                continue
            fingerprint_key = make_action_fingerprint(
                failure_class=failure_class,
                target_file=target_file,
                action_type=action_type,
            )
            known = seen.get(fingerprint_key)
            if known is not None:
                suppressed_duplicates.append(
                    {
                        "fingerprint_key": fingerprint_key,
                        "failure_class": failure_class,
                        "target_file": target_file,
                        "action_type": action_type,
                        "duplicate_of": {
                            "source_run_tag": _known_value(known, "source_run_tag"),
                            "analysis_path": _known_value(known, "analysis_path"),
                            "proposal_id": _known_value(known, "proposal_id"),
                        },
                    }
                )
                continue
            kept_actions.append(action)
            new_fingerprints.append((fingerprint_key, action_type))
        if not kept_actions:
            continue
        proposal = dict(candidate)
        proposal["proposal_id"] = f"P{len(proposals) + 1:03d}"
        proposal["actions"] = kept_actions
        finalize_proposal(proposal, created_at=created_at)
        proposals.append(proposal)
        analysis_path = str(((proposal.get("source") or {}).get("analysis_path")) or "")
        for fingerprint_key, action_type in new_fingerprints:
            seen[fingerprint_key] = {
                "source_run_tag": source_run_tag,
                "analysis_path": analysis_path,
                "proposal_id": proposal["proposal_id"],
                "action_type": action_type,
            }
    empty_cycles = 0 if proposals else history.consecutive_empty_cycles + 1
    return proposals, suppressed_duplicates, empty_cycles, history.empty_cycle_threshold
