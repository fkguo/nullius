#!/usr/bin/env python3
"""Structured semantic packet selection with fail-closed replay surfaces.

Deterministic hints are provenance only: they help expand and rank auditable
candidate units, but they must not override semantic adjudication decisions.
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any


DECISION_STATUS_VALUES = frozenset({"selected", "rejected", "uncertain", "abstained"})
ADJUDICATOR_STATUS_VALUES = frozenset({"ok", "abstained", "unavailable", "parse_error"})


@dataclass(frozen=True)
class CandidateRecord:
    candidate_id: str
    unit: str
    label: str
    source_path: str
    start_line: int
    end_line: int
    preview: str
    text: str
    hints: dict[str, Any]
    fallback_rank: int


def _sha256_text(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8", errors="replace")).hexdigest()


def _normalize_tags(raw: Any) -> list[str]:
    if not isinstance(raw, list):
        return []
    out: list[str] = []
    seen: set[str] = set()
    for value in raw:
        tag = str(value or "").strip()
        if not tag or tag in seen:
            continue
        seen.add(tag)
        out.append(tag)
        if len(out) >= 8:
            break
    return out


def _candidate_payload(candidate: CandidateRecord) -> dict[str, Any]:
    return {
        "id": candidate.candidate_id,
        "unit": candidate.unit,
        "label": candidate.label,
        "source": {
            "path": candidate.source_path,
            "start_line": int(candidate.start_line),
            "end_line": int(candidate.end_line),
        },
        "preview": candidate.preview,
        "text_sha256": _sha256_text(candidate.text),
        "deterministic_hints": candidate.hints,
        "decision": {
            "status": "abstained",
            "semantic_tags": [],
            "rationale": "",
            "failure_state": "",
        },
    }


def _read_adjudication(path: Path, *, candidate_ids: set[str]) -> tuple[dict[str, Any], dict[str, dict[str, Any]]]:
    raw = path.read_text(encoding="utf-8")
    obj = json.loads(raw)
    if not isinstance(obj, dict):
        raise ValueError("adjudication JSON must be an object")

    status = str(obj.get("status") or "ok").strip().lower()
    if status not in ADJUDICATOR_STATUS_VALUES:
        raise ValueError(f"unsupported adjudicator status: {status}")

    decisions = obj.get("decisions", [])
    if not isinstance(decisions, list):
        raise ValueError("adjudication.decisions must be an array")

    parsed: dict[str, dict[str, Any]] = {}
    for idx, item in enumerate(decisions):
        if not isinstance(item, dict):
            raise ValueError(f"decision[{idx}] must be an object")
        candidate_id = str(item.get("candidate_id") or "").strip()
        if not candidate_id:
            raise ValueError(f"decision[{idx}] missing candidate_id")
        if candidate_id not in candidate_ids:
            raise ValueError(f"decision[{idx}] references unknown candidate_id={candidate_id!r}")
        if candidate_id in parsed:
            raise ValueError(f"duplicate decision for candidate_id={candidate_id!r}")
        decision_status = str(item.get("status") or "").strip().lower()
        if decision_status not in DECISION_STATUS_VALUES:
            raise ValueError(f"decision[{idx}] has unsupported status={decision_status!r}")
        rationale = str(item.get("rationale") or "").strip()
        if decision_status in {"selected", "uncertain"} and not rationale:
            raise ValueError(f"decision[{idx}] must include rationale for status={decision_status}")
        parsed[candidate_id] = {
            "status": decision_status,
            "semantic_tags": _normalize_tags(item.get("semantic_tags", [])),
            "rationale": rationale,
            "failure_state": str(item.get("failure_state") or "").strip(),
        }

    meta = {
        "mode": str(obj.get("mode") or "external_json").strip() or "external_json",
        "status": status,
        "model": str(obj.get("model") or "").strip(),
        "notes": [str(x).strip() for x in obj.get("notes", []) if str(x).strip()] if isinstance(obj.get("notes"), list) else [],
        "sha256": _sha256_text(raw),
    }
    return meta, parsed


def curate_candidates(
    *,
    selection_kind: str,
    candidates: list[CandidateRecord],
    adjudication_path: Path | None,
    max_primary: int,
    fallback_count: int,
) -> dict[str, Any]:
    seen: set[str] = set()
    payload_candidates: list[dict[str, Any]] = []
    for candidate in candidates:
        if candidate.candidate_id in seen:
            raise ValueError(f"duplicate candidate_id: {candidate.candidate_id}")
        seen.add(candidate.candidate_id)
        payload_candidates.append(_candidate_payload(candidate))

    adjudicator: dict[str, Any] = {
        "mode": "none",
        "status": "abstained",
        "model": "",
        "source_path": str(adjudication_path) if adjudication_path is not None else "",
        "sha256": "",
        "notes": [],
        "parse_error": "",
    }
    decisions: dict[str, dict[str, Any]] = {}

    if adjudication_path is not None:
        if not adjudication_path.is_file():
            adjudicator["mode"] = "external_json"
            adjudicator["status"] = "unavailable"
            adjudicator["parse_error"] = "selection file not found"
        else:
            try:
                meta, decisions = _read_adjudication(adjudication_path, candidate_ids=seen)
                adjudicator.update(meta)
            except Exception as exc:
                adjudicator["mode"] = "external_json"
                adjudicator["status"] = "parse_error"
                adjudicator["parse_error"] = str(exc)

    for item in payload_candidates:
        decision = decisions.get(item["id"])
        if decision is None:
            continue
        item["decision"] = decision

    selected_ids = [item["id"] for item in payload_candidates if item["decision"]["status"] == "selected"]
    uncertain_ids = [item["id"] for item in payload_candidates if item["decision"]["status"] == "uncertain"]
    rejected_ids = [item["id"] for item in payload_candidates if item["decision"]["status"] == "rejected"]
    abstained_ids = [item["id"] for item in payload_candidates if item["decision"]["status"] == "abstained"]

    render_mode = "none"
    primary_ids: list[str] = []
    render_notes: list[str] = []
    if selected_ids:
        render_mode = "semantic_selected"
        primary_ids = selected_ids[: max(1, int(max_primary))]
        overflow = selected_ids[max(1, int(max_primary)) :]
        if overflow:
            render_notes.append(f"selected_overflow_truncated={len(overflow)}")
    elif uncertain_ids:
        render_mode = "semantic_uncertain"
        primary_ids = uncertain_ids[: max(1, int(max_primary))]
    elif adjudicator["status"] in {"abstained", "unavailable", "parse_error"} and payload_candidates:
        render_mode = "candidate_fallback"
        primary_ids = [item["id"] for item in payload_candidates[: max(1, int(fallback_count))]]

    return {
        "schemaVersion": 1,
        "selection_kind": selection_kind,
        "max_primary": int(max_primary),
        "adjudicator": adjudicator,
        "counts": {
            "candidates": len(payload_candidates),
            "selected": len(selected_ids),
            "uncertain": len(uncertain_ids),
            "rejected": len(rejected_ids),
            "abstained": len(abstained_ids),
        },
        "render_plan": {
            "mode": render_mode,
            "primary_candidate_ids": primary_ids,
            "notes": render_notes,
        },
        "candidates": payload_candidates,
    }
