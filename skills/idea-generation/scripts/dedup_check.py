#!/usr/bin/env python3
"""Mechanical near-duplicate check for generation candidates.

Compares each candidate's text against EVERY node already in the campaign
store (active, waiting_activation, and archived alike) using a deterministic,
dependency-free vector-space cosine: hashed character-3-gram counts. This is
NOT a semantic embedding — it is a mechanical near-duplicate filter, strong on
near-verbatim and light-paraphrase duplicates, and it is recorded as such
(`method` field) so a later, better backend can supersede it visibly.

Never uses model memory, never scores novelty: the output is a dedup record
per candidate ({decision: unique|flagged|auto_drop}, nearest neighbor,
similarity) that build_pack.py folds into the pack. Thresholds follow the
design defaults: >= 0.95 auto-drop, >= 0.80 flag for human review.

Python >= 3.9, standard library only.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import sys
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

DEDUP_METHOD = "charngram3-hash-cosine-v1"
DEFAULT_DIM = 4096
DEFAULT_FLAG_THRESHOLD = 0.80
DEFAULT_DROP_THRESHOLD = 0.95
NGRAM_SIZE = 3


def normalize_text(text: str) -> str:
    return " ".join(text.lower().split())


def char_ngram_vector(text: str, dim: int = DEFAULT_DIM) -> Dict[int, int]:
    """Deterministic hashed bag of character 3-grams."""
    normalized = normalize_text(text)
    counts: Dict[int, int] = {}
    if len(normalized) < NGRAM_SIZE:
        if normalized:
            index = int(hashlib.sha256(normalized.encode("utf-8")).hexdigest()[:8], 16) % dim
            counts[index] = 1
        return counts
    for i in range(len(normalized) - NGRAM_SIZE + 1):
        gram = normalized[i:i + NGRAM_SIZE]
        index = int(hashlib.sha256(gram.encode("utf-8")).hexdigest()[:8], 16) % dim
        counts[index] = counts.get(index, 0) + 1
    return counts


def cosine(a: Dict[int, int], b: Dict[int, int]) -> float:
    if not a or not b:
        return 0.0
    dot = sum(value * b.get(index, 0) for index, value in a.items())
    norm_a = math.sqrt(sum(value * value for value in a.values()))
    norm_b = math.sqrt(sum(value * value for value in b.values()))
    if norm_a == 0.0 or norm_b == 0.0:
        return 0.0
    return dot / (norm_a * norm_b)


def _string_items(value: Any) -> List[str]:
    if not isinstance(value, list):
        return []
    return [item for item in value if isinstance(item, str)]


def node_comparison_text(node: Dict[str, Any]) -> str:
    """The node text a candidate is compared against: thesis + rationale + claims."""
    parts: List[str] = []
    card = node.get("idea_card")
    if isinstance(card, dict):
        thesis = card.get("thesis_statement")
        if isinstance(thesis, str):
            parts.append(thesis)
        for claim in card.get("claims", []) if isinstance(card.get("claims"), list) else []:
            if isinstance(claim, dict) and isinstance(claim.get("claim_text"), str):
                parts.append(claim["claim_text"])
        parts.extend(_string_items(card.get("testable_hypotheses")))
    draft = node.get("rationale_draft")
    if isinstance(draft, dict):
        if isinstance(draft.get("title"), str):
            parts.append(draft["title"])
        if isinstance(draft.get("rationale"), str):
            parts.append(draft["rationale"])
    return " ".join(parts)


def candidate_comparison_text(candidate: Dict[str, Any]) -> str:
    parts: List[str] = []
    draft = candidate.get("rationale_draft")
    if isinstance(draft, dict):
        if isinstance(draft.get("title"), str):
            parts.append(draft["title"])
        if isinstance(draft.get("rationale"), str):
            parts.append(draft["rationale"])
    card_fields = candidate.get("card_fields")
    if isinstance(card_fields, dict):
        parts.extend(_string_items(card_fields.get("testable_hypotheses")))
        for claim in card_fields.get("claims", []) if isinstance(card_fields.get("claims"), list) else []:
            if isinstance(claim, dict) and isinstance(claim.get("claim_text"), str):
                parts.append(claim["claim_text"])
    return " ".join(parts)


def load_store_nodes(nodes_path: Path) -> Dict[str, Dict[str, Any]]:
    payload = json.loads(nodes_path.read_text(encoding="utf-8"))
    # Accept both the raw nodes_latest.json mapping and a {campaign_id, nodes} wrapper.
    if isinstance(payload, dict) and isinstance(payload.get("nodes"), (dict, list)):
        payload = payload["nodes"]
    if isinstance(payload, list):
        return {str(node.get("node_id")): node for node in payload if isinstance(node, dict)}
    if isinstance(payload, dict):
        return {str(node_id): node for node_id, node in payload.items() if isinstance(node, dict)}
    raise ValueError("nodes file is neither a node mapping nor a node list")


def normalized_key(text: str) -> str:
    return normalize_text(text)


def nearest_neighbor(
    candidate_vector: Dict[int, int],
    candidate_key: str,
    node_entries: List[Tuple[str, Dict[int, int], str]],
    earlier_candidates: List[Tuple[int, Dict[int, int], str]],
) -> Tuple[Optional[str], Optional[int], float]:
    """Nearest neighbor over BOTH the campaign store and the earlier
    candidates of the same burst (same-anchor twins are the most likely
    duplicate source and are invisible to a store-only comparison).
    Exact normalized-text equality short-circuits to similarity 1.0 —
    a hash-collision artifact can never mask a verbatim duplicate."""
    best_node_id: Optional[str] = None
    best_candidate_index: Optional[int] = None
    best_similarity = 0.0
    for node_id, node_vector, node_key in node_entries:
        similarity = 1.0 if (candidate_key and candidate_key == node_key) else cosine(candidate_vector, node_vector)
        if similarity > best_similarity:
            best_similarity = similarity
            best_node_id, best_candidate_index = node_id, None
    for index, vector, key in earlier_candidates:
        similarity = 1.0 if (candidate_key and candidate_key == key) else cosine(candidate_vector, vector)
        if similarity > best_similarity:
            best_similarity = similarity
            best_node_id, best_candidate_index = None, index
    return best_node_id, best_candidate_index, best_similarity


def decide(similarity: float, flag_threshold: float, drop_threshold: float) -> str:
    if similarity >= drop_threshold:
        return "auto_drop"
    if similarity >= flag_threshold:
        return "flagged"
    return "unique"


def run(argv: Optional[List[str]] = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--nodes", required=True, help="Path to the campaign store's nodes_latest.json")
    parser.add_argument("--candidates", required=True, help="JSON array of pack candidates (pre-dedup)")
    parser.add_argument("--out", required=True, help="Where to write the dedup report JSON")
    parser.add_argument("--flag-threshold", type=float, default=DEFAULT_FLAG_THRESHOLD)
    parser.add_argument("--drop-threshold", type=float, default=DEFAULT_DROP_THRESHOLD)
    parser.add_argument("--dim", type=int, default=DEFAULT_DIM)
    args = parser.parse_args(argv)

    if not (0.0 < args.flag_threshold <= args.drop_threshold <= 1.0):
        print("error: thresholds must satisfy 0 < flag <= drop <= 1", file=sys.stderr)
        return 2
    if args.dim < 64:
        print("error: --dim must be >= 64 (a tiny hash space makes every text collide)", file=sys.stderr)
        return 2

    out_path = Path(args.out)
    if out_path.exists():
        print(f"error: refusing to overwrite existing report {out_path}", file=sys.stderr)
        return 2

    try:
        nodes = load_store_nodes(Path(args.nodes))
    except (OSError, ValueError, json.JSONDecodeError) as exc:
        print(f"error: cannot load nodes: {exc}", file=sys.stderr)
        return 2
    try:
        candidates = json.loads(Path(args.candidates).read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        print(f"error: cannot load candidates: {exc}", file=sys.stderr)
        return 2
    if not isinstance(candidates, list) or not candidates:
        print("error: candidates must be a non-empty JSON array", file=sys.stderr)
        return 2

    node_entries = []
    for node_id, node in sorted(nodes.items()):
        text = node_comparison_text(node)
        node_entries.append((node_id, char_ngram_vector(text, args.dim), normalized_key(text)))

    results = []
    earlier_candidates: List[Any] = []
    for index, candidate in enumerate(candidates):
        if not isinstance(candidate, dict):
            print(f"error: candidates[{index}] is not an object", file=sys.stderr)
            return 2
        text = candidate_comparison_text(candidate)
        vector = char_ngram_vector(text, args.dim)
        key = normalized_key(text)
        neighbor_id, neighbor_index, similarity = nearest_neighbor(vector, key, node_entries, earlier_candidates)
        entry: Dict[str, Any] = {
            "candidate_index": index,
            "decision": decide(similarity, args.flag_threshold, args.drop_threshold),
            "nearest_similarity": round(similarity, 6),
        }
        if neighbor_id is not None:
            entry["nearest_neighbor_node_id"] = neighbor_id
        if neighbor_index is not None:
            entry["intra_burst_neighbor_index"] = neighbor_index
        results.append(entry)
        earlier_candidates.append((index, vector, key))

    report = {
        "artifact": "generation_dedup_report_v1",
        "dim": args.dim,
        "drop_threshold": args.drop_threshold,
        "flag_threshold": args.flag_threshold,
        "method": DEDUP_METHOD,
        "results": results,
    }
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(json.dumps({"out": str(out_path), "decisions": [r["decision"] for r in results]}))
    return 0


if __name__ == "__main__":
    sys.exit(run())
