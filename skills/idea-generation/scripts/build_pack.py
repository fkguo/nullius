#!/usr/bin/env python3
"""Assemble a generation_pack_v1 from agent-authored candidates.

Inputs: a JSON array of candidates (each already carrying rationale_draft,
card_fields, provenance, novelty_delta, target_admission_route — everything
EXCEPT dedup), plus the dedup report produced by dedup_check.py. The script:

1. folds dedup results in — auto_drop candidates move to rejected_candidates,
   flagged candidates move to rejected_candidates UNLESS a human override
   (--override INDEX=REASON) records why they should import anyway;
2. runs a fail-fast client-side validation that mirrors the engine's semantic
   rules (the ENGINE is the authority — these checks only save a round-trip);
3. writes the pack JSON (refusing to overwrite).

The pack carries no scores and no posteriors: evaluation authority stays with
the belief layer. Python >= 3.9, standard library only.
"""

from __future__ import annotations

import argparse
import datetime as _dt
import hashlib
import json
import sys
from pathlib import Path
from typing import Any, Dict, List, Optional

# --- Mirrors of engine-side constants -------------------------------------
# The engine (packages/idea-engine) is the authority; tests lock the enum
# mirrors against the engine contract file so drift is caught at test time.

TRIGGER_VOCABULARY = [
    "manual",
    "survey_updated",
    "failure_recorded",
    "computation_gated",
    "match_concluded",
    "activation_satisfied",
    "milestone_reached",
    "posterior_moved",
]
ENABLED_TRIGGER_KINDS = ["manual", "survey_updated", "failure_recorded"]

FAMILY_ARITY: Dict[str, Dict[str, int]] = {
    "AnalogyTransfer": {"max": 1, "min": 0},
    "FailureRouting": {"max": 1, "min": 0},
    "LiteratureMining": {"exact": 0},
    "Mutation": {"exact": 1},
    "Recombination": {"min": 2},
}

DELTA_TYPES = [
    "new_mechanism",
    "new_method",
    "new_domain_application",
    "new_observable",
    "new_framework",
    "contradicts_prior",
    "parameter_tweak",
    "rewording",
]
NON_NOVEL_DELTA_TYPES = ["parameter_tweak", "rewording"]

ADMISSION_ROUTES = ["open_problem", "mechanism", "method", "framework"]

RESERVED_TRACE_INPUT_KEYS = ["trigger", "pack_artifact", "parent_revisions"]
PLACEHOLDER_EVIDENCE_URI = "https://example.org/reference"


def _is_nonempty_str(value: Any) -> bool:
    return isinstance(value, str) and len(value) > 0


def _claim_uris(card_fields: Dict[str, Any]) -> List[str]:
    uris: List[str] = []
    for claim in card_fields.get("claims", []) if isinstance(card_fields.get("claims"), list) else []:
        if isinstance(claim, dict) and isinstance(claim.get("evidence_uris"), list):
            uris.extend(uri for uri in claim["evidence_uris"] if isinstance(uri, str))
    return uris


def _receipt_uris(trace_inputs: Dict[str, Any]) -> List[str]:
    receipts = trace_inputs.get("retrieval_receipts")
    uris: List[str] = []
    if isinstance(receipts, list):
        for entry in receipts:
            if isinstance(entry, dict) and _is_nonempty_str(entry.get("uri")) and _is_nonempty_str(entry.get("source")):
                uris.append(entry["uri"])
    return uris


def validate_candidate(candidate: Dict[str, Any], index: int) -> List[str]:
    """Fail-fast mirror of the engine's per-candidate semantic validation."""
    problems: List[str] = []
    label = f"candidates[{index}]"

    for key in ("rationale_draft", "card_fields", "provenance", "novelty_delta", "target_admission_route"):
        if key not in candidate:
            problems.append(f"{label}: missing {key}")
    if problems:
        return problems

    provenance = candidate["provenance"]
    if not isinstance(provenance, dict):
        return [f"{label}: provenance is not an object"]

    family = provenance.get("operator_family")
    rule = FAMILY_ARITY.get(family) if isinstance(family, str) else None
    if rule is None:
        known = ", ".join(sorted(FAMILY_ARITY))
        problems.append(f"{label}: unknown operator_family {family!r}; known: {known}")
        return problems

    parents = provenance.get("parent_node_ids")
    parents = parents if isinstance(parents, list) else []
    if len(set(parents)) != len(parents):
        problems.append(f"{label}: parent_node_ids contains duplicates")
    n = len(parents)
    if "exact" in rule and n != rule["exact"]:
        problems.append(f"{label}: {family} requires exactly {rule['exact']} parents, got {n}")
    if "min" in rule and n < rule["min"]:
        problems.append(f"{label}: {family} requires at least {rule['min']} parents, got {n}")
    if "max" in rule and n > rule["max"]:
        problems.append(f"{label}: {family} allows at most {rule['max']} parents, got {n}")

    draft = candidate.get("rationale_draft")
    if family == "AnalogyTransfer":
        mapping = draft.get("analogy_mapping") if isinstance(draft, dict) else None
        if not (isinstance(mapping, list) and mapping):
            problems.append(f"{label}: AnalogyTransfer requires non-empty rationale_draft.analogy_mapping")

    trace_inputs = provenance.get("trace_inputs")
    trace_inputs = trace_inputs if isinstance(trace_inputs, dict) else {}
    for key in RESERVED_TRACE_INPUT_KEYS:
        if key in trace_inputs:
            problems.append(f"{label}: trace_inputs.{key} is engine-owned (reserved)")
    trace_params = provenance.get("trace_params")
    if isinstance(trace_params, dict) and "formalization" in trace_params:
        problems.append(f"{label}: trace_params.formalization is engine-owned (reserved)")

    evidence_used = provenance.get("evidence_uris_used")
    evidence_used = [uri for uri in evidence_used if isinstance(uri, str)] if isinstance(evidence_used, list) else []
    card_fields = candidate.get("card_fields")
    card_fields = card_fields if isinstance(card_fields, dict) else {}
    claim_uris = _claim_uris(card_fields)
    receipts = set(_receipt_uris(trace_inputs))

    for uri in evidence_used + claim_uris:
        if uri == PLACEHOLDER_EVIDENCE_URI:
            problems.append(f"{label}: placeholder evidence URI is forbidden in generated candidates")
            break
    for uri in claim_uris:
        if uri not in evidence_used:
            problems.append(f"{label}: claim evidence URI not listed in evidence_uris_used: {uri}")
    for uri in sorted(set(evidence_used + claim_uris)):
        if uri not in receipts:
            problems.append(f"{label}: no retrieval receipt for evidence URI (no receipt, no URI): {uri}")

    if family == "LiteratureMining":
        anchor = trace_inputs.get("anchor")
        if not isinstance(anchor, dict):
            problems.append(f"{label}: LiteratureMining requires trace_inputs.anchor")
        elif anchor.get("kind") == "tension":
            ref_keys = anchor.get("ref_keys")
            if not (_is_nonempty_str(anchor.get("statement")) and isinstance(ref_keys, list) and ref_keys
                    and all(_is_nonempty_str(k) for k in ref_keys)):
                problems.append(f"{label}: tension anchor requires statement + non-empty ref_keys")
        elif anchor.get("kind") == "gap":
            resolved = anchor.get("resolved_refs")
            refs = [r for r in resolved if _is_nonempty_str(r)] if isinstance(resolved, list) else []
            if not refs or not isinstance(resolved, list) or len(refs) != len(resolved):
                problems.append(f"{label}: gap anchor requires non-empty resolved_refs (no resolved references, no gap idea)")
            else:
                for ref in refs:
                    if ref not in receipts:
                        problems.append(f"{label}: gap resolved_ref has no retrieval receipt: {ref}")
        else:
            problems.append(f"{label}: anchor.kind must be tension or gap")

    if family == "FailureRouting" and n == 0:
        refs = trace_inputs.get("failed_approach_refs")
        if not (isinstance(refs, list) and refs and all(_is_nonempty_str(r) for r in refs)):
            problems.append(f"{label}: parentless FailureRouting requires non-empty trace_inputs.failed_approach_refs")

    delta = candidate.get("novelty_delta")
    if isinstance(delta, dict):
        delta_type = delta.get("delta_type")
        if delta_type not in DELTA_TYPES:
            problems.append(f"{label}: novelty_delta.delta_type must be one of {', '.join(DELTA_TYPES)}")
        elif delta_type in NON_NOVEL_DELTA_TYPES:
            problems.append(f"{label}: delta_type {delta_type!r} is non-novel by construction — not importable")
        statement = delta.get("falsifiable_delta_statement")
        if not (_is_nonempty_str(statement) and len(statement) >= 20):
            problems.append(f"{label}: falsifiable_delta_statement must be a statement (>= 20 chars)")
        for key in ("closest_prior", "overlap_summary"):
            if not _is_nonempty_str(delta.get(key)):
                problems.append(f"{label}: novelty_delta.{key} required")
    else:
        problems.append(f"{label}: novelty_delta is not an object")

    if candidate.get("target_admission_route") not in ADMISSION_ROUTES:
        problems.append(f"{label}: target_admission_route must be one of {', '.join(ADMISSION_ROUTES)}")

    return problems


def validate_pack_shape(pack: Dict[str, Any], parent_revisions: Dict[str, int]) -> List[str]:
    problems: List[str] = []
    trigger = pack.get("trigger")
    trigger = trigger if isinstance(trigger, dict) else {}
    kind = trigger.get("kind")
    if kind not in TRIGGER_VOCABULARY:
        problems.append(f"trigger.kind must be one of {', '.join(TRIGGER_VOCABULARY)}")
    elif kind not in ENABLED_TRIGGER_KINDS:
        problems.append(
            f"trigger.kind {kind!r} is reserved vocabulary, not yet enabled for import "
            f"(enabled: {', '.join(ENABLED_TRIGGER_KINDS)})",
        )
    if kind != "manual" and not _is_nonempty_str(trigger.get("artifact_ref")):
        problems.append("non-manual triggers require trigger.artifact_ref")

    for index, candidate in enumerate(pack.get("candidates", [])):
        problems.extend(validate_candidate(candidate, index))
        provenance = candidate.get("provenance") if isinstance(candidate, dict) else None
        parents = provenance.get("parent_node_ids") if isinstance(provenance, dict) else None
        for parent in parents if isinstance(parents, list) else []:
            if parent not in parent_revisions:
                problems.append(
                    f"candidates[{index}]: parent {parent} missing from parent_revisions "
                    "(record the revision read at generation time)",
                )
    return problems


def sha256_file(path: Path) -> str:
    return "sha256:" + hashlib.sha256(path.read_bytes()).hexdigest()


def _parse_overrides(pairs: List[str]) -> Dict[int, str]:
    overrides: Dict[int, str] = {}
    for pair in pairs:
        index_text, _, reason = pair.partition("=")
        if not index_text.isdigit() or not reason.strip():
            raise ValueError(f"--override expects INDEX=REASON, got {pair!r}")
        overrides[int(index_text)] = reason.strip()
    return overrides


def run(argv: Optional[List[str]] = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--campaign-id", required=True)
    parser.add_argument("--candidates", required=True, help="JSON array of candidates (without dedup)")
    parser.add_argument("--dedup-report", required=True, help="Report from dedup_check.py")
    parser.add_argument("--trigger-kind", required=True, choices=TRIGGER_VOCABULARY)
    parser.add_argument("--trigger-artifact-ref", help="Evidence-delta artifact (required for non-manual triggers)")
    parser.add_argument("--survey-artifact-ref", help="Survey artifact reference for evidence_snapshot")
    parser.add_argument("--survey-file", help="Local survey file; its sha256 becomes survey_content_hash")
    parser.add_argument("--failed-approach-refs", nargs="*", default=[], help="Ledger refs for evidence_snapshot")
    parser.add_argument("--parent-revisions", help="JSON file mapping parent node_id -> revision at read time")
    parser.add_argument(
        "--rejected", help="Optional JSON array of operator-rejected candidates ({summary, reason, details?})",
    )
    parser.add_argument(
        "--override", action="append", default=[],
        help="INDEX=REASON — human override importing a dedup-flagged candidate, reason recorded in the pack",
    )
    parser.add_argument("--created-at", help="RFC3339 timestamp; defaults to now (UTC)")
    parser.add_argument("--out", required=True)
    args = parser.parse_args(argv)

    out_path = Path(args.out)
    if out_path.exists():
        print(f"error: refusing to overwrite existing pack {out_path}", file=sys.stderr)
        return 2

    try:
        candidates = json.loads(Path(args.candidates).read_text(encoding="utf-8"))
        report = json.loads(Path(args.dedup_report).read_text(encoding="utf-8"))
        overrides = _parse_overrides(list(args.override))
        rejected: List[Dict[str, Any]] = []
        if args.rejected:
            rejected = json.loads(Path(args.rejected).read_text(encoding="utf-8"))
        parent_revisions: Dict[str, int] = {}
        if args.parent_revisions:
            parent_revisions = json.loads(Path(args.parent_revisions).read_text(encoding="utf-8"))
    except (OSError, ValueError, json.JSONDecodeError) as exc:
        print(f"error: cannot load inputs: {exc}", file=sys.stderr)
        return 2

    if not isinstance(candidates, list) or not candidates:
        print("error: candidates must be a non-empty JSON array", file=sys.stderr)
        return 2
    results = report.get("results") if isinstance(report, dict) else None
    if not isinstance(results, list) or len(results) != len(candidates):
        print("error: dedup report does not cover the candidate list (rerun dedup_check.py)", file=sys.stderr)
        return 2

    kept: List[Dict[str, Any]] = []
    for index, (candidate, dedup_entry) in enumerate(zip(candidates, results)):
        if "dedup" in candidate:
            print(f"error: candidates[{index}] already carries a dedup record — dedup is this pipeline's job", file=sys.stderr)
            return 2
        decision = dedup_entry.get("decision")
        record: Dict[str, Any] = {"decision": "unique", "method": report.get("method", "unknown")}
        if "nearest_neighbor_node_id" in dedup_entry:
            record["nearest_neighbor_node_id"] = dedup_entry["nearest_neighbor_node_id"]
        if "nearest_similarity" in dedup_entry:
            record["nearest_similarity"] = dedup_entry["nearest_similarity"]
        summary_source = candidate.get("rationale_draft", {})
        summary = summary_source.get("title") or summary_source.get("rationale") or f"candidate {index}"
        if decision == "auto_drop":
            rejected.append({
                "details": {k: v for k, v in record.items() if k != "decision"},
                "reason": f"dedup auto-drop at similarity >= {report.get('drop_threshold')}",
                "summary": str(summary),
            })
            continue
        if decision == "flagged":
            if index not in overrides:
                rejected.append({
                    "details": {k: v for k, v in record.items() if k != "decision"},
                    "reason": (
                        f"dedup flagged at similarity >= {report.get('flag_threshold')} and no human override "
                        "was recorded (--override INDEX=REASON)"
                    ),
                    "summary": str(summary),
                })
                continue
            record["decision"] = "flagged"
            record["override_reason"] = overrides[index]
        candidate = dict(candidate)
        candidate["dedup"] = record
        kept.append(candidate)

    if not kept:
        print("error: every candidate was rejected by dedup — nothing to import (the report is the record)", file=sys.stderr)
        return 2

    evidence_snapshot: Dict[str, Any] = {}
    if args.survey_artifact_ref:
        evidence_snapshot["survey_artifact_ref"] = args.survey_artifact_ref
    if args.survey_file:
        evidence_snapshot["survey_content_hash"] = sha256_file(Path(args.survey_file))
    if args.failed_approach_refs:
        evidence_snapshot["failed_approach_refs"] = list(args.failed_approach_refs)
    if parent_revisions:
        evidence_snapshot["parent_revisions"] = parent_revisions

    trigger: Dict[str, Any] = {"kind": args.trigger_kind}
    if args.trigger_artifact_ref:
        trigger["artifact_ref"] = args.trigger_artifact_ref

    created_at = args.created_at or _dt.datetime.now(_dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    pack: Dict[str, Any] = {
        "campaign_id": args.campaign_id,
        "candidates": kept,
        "created_at": created_at,
        "evidence_snapshot": evidence_snapshot,
        "rejected_candidates": rejected,
        "trigger": trigger,
    }

    problems = validate_pack_shape(pack, parent_revisions)
    if problems:
        print("pack validation failed (engine would refuse these too):", file=sys.stderr)
        for problem in problems:
            print(f"  - {problem}", file=sys.stderr)
        return 2

    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(pack, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(json.dumps({
        "imported_candidates": len(kept),
        "out": str(out_path),
        "rejected_candidates": len(rejected),
    }))
    return 0


if __name__ == "__main__":
    sys.exit(run())
