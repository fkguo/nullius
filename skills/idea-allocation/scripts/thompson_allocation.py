#!/usr/bin/env python3
"""Thompson-sampling investment allocation over idea posteriors.

Decision layer only: the belief graph computes ``P(worth investing | evidence)``
per idea; this script turns those posteriors into one round of investment
allocations. Utility, cost, and budget live HERE, never in the belief graph.

Beta construction (and why)
---------------------------
Each active idea with a posterior ``{value v in [0, 1], evidence_count n >= 0}``
is given a sampling distribution::

    Beta(alpha = v * n + 1,  beta = (1 - v) * n + 1)

Read ``n`` as an equivalent sample size: the construction treats the belief as
if it came from ``n`` observations with success fraction ``v``, plus one
Laplace pseudo-count on each side. Consequences that make this the right
shape for exploration-aware allocation:

- With zero evidence (``n = 0``) the distribution degenerates to
  ``Beta(1, 1)``, the uniform distribution on [0, 1]: no evidence means no
  opinion, and the idea samples anywhere with equal density.
- The posterior mean is ``(v * n + 1) / (n + 2)``, which approaches ``v`` as
  evidence accumulates, and the variance ``mean * (1 - mean) / (n + 3)``
  shrinks like ``1 / n``: concentration grows with evidence.
- Little evidence means a wide distribution, hence high sampling variance,
  hence a real chance to out-draw a better-believed idea: exploration falls
  out of the construction instead of being bolted on.
- The density is strictly positive on the open interval (0, 1) for every
  finite ``n``, so no idea's draw probability is ever exactly zero: low
  posterior ideas keep a nonzero chance of winning a reconnaissance or even a
  deep slot. Nothing starves.

Allocation rule
---------------
One draw per eligible idea (``lifecycle_state == "active"`` and posterior
present), ranked by sampled value, descending. The caller supplies
``--deep-slots`` and ``--recon-slots`` (no defaults: slot counts encode real
person-time and compute capacity, which only the caller knows). The top
``deep_slots`` draws get ``deep_investment``, the next ``recon_slots`` get
``reconnaissance``, the rest ``hold``.

Active ideas WITHOUT a posterior are cold starts: they are never sampled and
never occupy a deep or reconnaissance slot; they are appended to the tail of
the reconnaissance list (allocation ``"reconnaissance"``) so the round always
sends them scouting for their first posterior — build the belief graph entry
first, then compete.

Waiting-activation ideas do not participate; they are listed in the artifact
for the activation monitor. Archived ideas are excluded entirely.

Reproducibility
---------------
``--seed`` is mandatory and recorded in the artifact. Draw order is the
lexicographic order of node ids, so the same seed, the same store content, and
the same ``--generated-at`` reproduce the artifact byte for byte (Python's
Mersenne Twister and ``random.betavariate`` are deterministic for a given
Python version). ``decision_id`` is a uuid5 over campaign id, seed, timestamp,
and a digest of the store content — deterministic, no hidden randomness.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import random
import sys
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

if __package__ in (None, ""):
    sys.path.insert(0, str(Path(__file__).resolve().parent))

from nodes_store import (  # noqa: E402
    ACTIVATION_KINDS,
    ALLOCATION_KINDS,
    DECISION_ID_NAMESPACE,
    METHOD_NAME,
    StoreError,
    is_uuid_text,
    load_nodes_file,
    parse_datetime,
    waiting_entry,
)

DEFAULT_ARTIFACT_DIR = "artifacts/allocations"


# ---------------------------------------------------------------------------
# Beta construction
# ---------------------------------------------------------------------------

def beta_parameters(value: float, evidence_count: int) -> Tuple[float, float]:
    """Map a stored posterior summary to Beta sampling parameters.

    ``alpha = value * n + 1`` and ``beta = (1 - value) * n + 1`` with
    ``n = evidence_count``. See the module docstring for why: Laplace
    pseudo-counts make ``n = 0`` exactly uniform, the mean tracks ``value``,
    and the concentration grows linearly with the evidence count.
    """
    if not 0.0 <= value <= 1.0:
        raise ValueError(f"posterior value must be in [0, 1], got {value!r}")
    if evidence_count < 0:
        raise ValueError(f"evidence_count must be >= 0, got {evidence_count!r}")
    alpha = value * evidence_count + 1.0
    beta = (1.0 - value) * evidence_count + 1.0
    return alpha, beta


def beta_mean(alpha: float, beta: float) -> float:
    return alpha / (alpha + beta)


# ---------------------------------------------------------------------------
# Sampling and slot assignment
# ---------------------------------------------------------------------------

def split_nodes(nodes: List[Dict[str, Any]]) -> Dict[str, List[Dict[str, Any]]]:
    """Partition store nodes by how this round treats them."""
    groups: Dict[str, List[Dict[str, Any]]] = {
        "sampled": [],        # active, posterior present -> Thompson draw
        "cold_start": [],     # active, no posterior -> reconnaissance tail
        "waiting": [],        # waiting_activation -> monitor queue
        "archived": [],       # excluded
    }
    for node in nodes:
        state = node["lifecycle_state"]
        if state == "archived":
            groups["archived"].append(node)
        elif state == "waiting_activation":
            groups["waiting"].append(node)
        elif node.get("posterior") is not None:
            groups["sampled"].append(node)
        else:
            groups["cold_start"].append(node)
    return groups


def draw_samples(
    sampled_nodes: List[Dict[str, Any]], seed: int
) -> List[Dict[str, Any]]:
    """One Beta draw per node, in lexicographic node_id order (deterministic)."""
    rng = random.Random(seed)
    draws: List[Dict[str, Any]] = []
    for node in sorted(sampled_nodes, key=lambda n: n["node_id"]):
        posterior = node["posterior"]
        value = float(posterior["value"])
        count = int(posterior["evidence_count"])
        alpha, beta = beta_parameters(value, count)
        draws.append(
            {
                "node_id": node["node_id"],
                "posterior_value": value,
                "evidence_count": count,
                "sampled_value": rng.betavariate(alpha, beta),
                "posterior_mean": beta_mean(alpha, beta),
            }
        )
    return draws


def _draw_comment(sampled: float, mean: float) -> str:
    if sampled > mean:
        return f"sampled {sampled:.4f} above posterior mean {mean:.4f} — exploration draw"
    if sampled < mean:
        return f"sampled {sampled:.4f} below posterior mean {mean:.4f} — conservative draw"
    return f"sampled {sampled:.4f} at posterior mean {mean:.4f}"


def assign_allocations(
    draws: List[Dict[str, Any]],
    cold_start_nodes: List[Dict[str, Any]],
    deep_slots: int,
    recon_slots: int,
) -> List[Dict[str, Any]]:
    """Rank draws and cut them into deep / reconnaissance / hold.

    Cold-start nodes are appended after the sampled candidates with a fixed
    ``reconnaissance`` allocation; they never consume a deep or reconnaissance
    slot (the slot budget applies to sampled candidates only).
    """
    if deep_slots < 0 or recon_slots < 0:
        raise ValueError("deep_slots and recon_slots must be >= 0")
    ranked = sorted(draws, key=lambda d: (-d["sampled_value"], d["node_id"]))
    candidates: List[Dict[str, Any]] = []
    for rank, draw in enumerate(ranked):
        comment = _draw_comment(draw["sampled_value"], draw["posterior_mean"])
        if rank < deep_slots:
            allocation = "deep_investment"
            note = f"deep slot {rank + 1} of {deep_slots}; {comment}"
        elif rank < deep_slots + recon_slots:
            allocation = "reconnaissance"
            note = f"reconnaissance slot {rank - deep_slots + 1} of {recon_slots}; {comment}"
        else:
            allocation = "hold"
            note = f"below slot cutoff this round; {comment}"
        candidates.append(
            {
                "node_id": draw["node_id"],
                "posterior_value": draw["posterior_value"],
                "evidence_count": draw["evidence_count"],
                "sampled_value": draw["sampled_value"],
                "allocation": allocation,
                "budget_note": note,
            }
        )
    for node in sorted(cold_start_nodes, key=lambda n: n["node_id"]):
        candidates.append(
            {
                "node_id": node["node_id"],
                "posterior_value": None,
                "evidence_count": None,
                "sampled_value": None,
                "allocation": "reconnaissance",
                "budget_note": (
                    "no posterior yet — needs belief graph first; fixed reconnaissance "
                    "(cold start, outside the slot budget)"
                ),
            }
        )
    return candidates


# ---------------------------------------------------------------------------
# Decision artifact
# ---------------------------------------------------------------------------

def _nodes_digest(nodes: List[Dict[str, Any]]) -> str:
    canonical = json.dumps(nodes, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def build_decision(
    campaign_id: str,
    nodes: List[Dict[str, Any]],
    seed: int,
    deep_slots: int,
    recon_slots: int,
    generated_at: str,
) -> Dict[str, Any]:
    """Assemble the full allocation_decision_v1 artifact object."""
    groups = split_nodes(nodes)
    draws = draw_samples(groups["sampled"], seed)
    candidates = assign_allocations(draws, groups["cold_start"], deep_slots, recon_slots)
    waiting = [waiting_entry(node) for node in sorted(groups["waiting"], key=lambda n: n["node_id"])]
    decision_id = str(
        uuid.uuid5(
            DECISION_ID_NAMESPACE,
            f"{campaign_id}|{seed}|{generated_at}|{_nodes_digest(nodes)}",
        )
    )
    return {
        "decision_id": decision_id,
        "campaign_id": campaign_id,
        "generated_at": generated_at,
        "method": METHOD_NAME,
        "random_seed": seed,
        "candidates": candidates,
        "waiting_activation": waiting,
    }


# ---------------------------------------------------------------------------
# Hand-rolled artifact validation (structure pinned with the campaign store's
# allocation_decision_v1 contract; this validator is the local guard)
# ---------------------------------------------------------------------------

_TOP_KEYS = (
    "decision_id",
    "campaign_id",
    "generated_at",
    "method",
    "random_seed",
    "candidates",
    "waiting_activation",
)
_CANDIDATE_KEYS = (
    "node_id",
    "posterior_value",
    "evidence_count",
    "sampled_value",
    "allocation",
    "budget_note",
)
_WAITING_KEYS = ("node_id", "activation_condition", "last_checked_at")


def _is_int(value: Any) -> bool:
    return isinstance(value, int) and not isinstance(value, bool)


def _is_number(value: Any) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool)


def validate_allocation_decision(obj: Any) -> List[str]:
    """Return a list of problems; empty list means the artifact is valid."""
    problems: List[str] = []
    if not isinstance(obj, dict):
        return [f"artifact must be an object, got {type(obj).__name__}"]

    missing = [key for key in _TOP_KEYS if key not in obj]
    extra = [key for key in obj if key not in _TOP_KEYS]
    if missing:
        problems.append(f"missing top-level keys: {missing}")
    if extra:
        problems.append(f"unexpected top-level keys: {extra}")

    if "decision_id" in obj and not is_uuid_text(obj["decision_id"]):
        problems.append(f"decision_id must be a UUID string, got {obj['decision_id']!r}")
    if "campaign_id" in obj and not is_uuid_text(obj["campaign_id"]):
        problems.append(f"campaign_id must be a UUID string, got {obj['campaign_id']!r}")
    if "generated_at" in obj and parse_datetime(obj["generated_at"]) is None:
        problems.append(
            f"generated_at must be an ISO 8601 date-time string, got {obj['generated_at']!r}"
        )
    if "method" in obj and obj["method"] != METHOD_NAME:
        problems.append(f"method must be {METHOD_NAME!r}, got {obj['method']!r}")
    if "random_seed" in obj and not _is_int(obj["random_seed"]):
        problems.append(f"random_seed must be an integer, got {obj['random_seed']!r}")

    candidates = obj.get("candidates")
    if candidates is not None:
        if not isinstance(candidates, list):
            problems.append(f"candidates must be a list, got {type(candidates).__name__}")
        else:
            for index, entry in enumerate(candidates):
                problems.extend(_validate_candidate(index, entry))

    waiting = obj.get("waiting_activation")
    if waiting is not None:
        if not isinstance(waiting, list):
            problems.append(
                f"waiting_activation must be a list, got {type(waiting).__name__}"
            )
        else:
            for index, entry in enumerate(waiting):
                problems.extend(_validate_waiting(index, entry))
    return problems


def _validate_candidate(index: int, entry: Any) -> List[str]:
    prefix = f"candidates[{index}]"
    problems: List[str] = []
    if not isinstance(entry, dict):
        return [f"{prefix} must be an object, got {type(entry).__name__}"]
    missing = [key for key in _CANDIDATE_KEYS if key not in entry]
    extra = [key for key in entry if key not in _CANDIDATE_KEYS]
    if missing:
        problems.append(f"{prefix} missing keys: {missing}")
    if extra:
        problems.append(f"{prefix} unexpected keys: {extra}")
    if missing:
        return problems

    if not isinstance(entry["node_id"], str) or not entry["node_id"].strip():
        problems.append(f"{prefix}.node_id must be a non-empty string")
    if entry["allocation"] not in ALLOCATION_KINDS:
        problems.append(
            f"{prefix}.allocation must be one of {list(ALLOCATION_KINDS)}, "
            f"got {entry['allocation']!r}"
        )
    if not isinstance(entry["budget_note"], str) or not entry["budget_note"].strip():
        problems.append(f"{prefix}.budget_note must be a non-empty string")

    triple = (entry["posterior_value"], entry["evidence_count"], entry["sampled_value"])
    if all(item is None for item in triple):
        if entry.get("allocation") != "reconnaissance":
            problems.append(
                f"{prefix}: a candidate without posterior data (cold start) must have "
                f"allocation 'reconnaissance', got {entry.get('allocation')!r}"
            )
    elif any(item is None for item in triple):
        problems.append(
            f"{prefix}: posterior_value, evidence_count, sampled_value must be all "
            f"null (cold start) or all present, got {triple!r}"
        )
    else:
        value, count, sampled = triple
        if not _is_number(value) or not (0.0 <= float(value) <= 1.0):
            problems.append(f"{prefix}.posterior_value must be a number in [0, 1], got {value!r}")
        if not _is_int(count) or count < 0:
            problems.append(f"{prefix}.evidence_count must be an integer >= 0, got {count!r}")
        if not _is_number(sampled) or not (0.0 <= float(sampled) <= 1.0):
            problems.append(f"{prefix}.sampled_value must be a number in [0, 1], got {sampled!r}")
    return problems


def _validate_waiting(index: int, entry: Any) -> List[str]:
    prefix = f"waiting_activation[{index}]"
    problems: List[str] = []
    if not isinstance(entry, dict):
        return [f"{prefix} must be an object, got {type(entry).__name__}"]
    missing = [key for key in _WAITING_KEYS if key not in entry]
    extra = [key for key in entry if key not in _WAITING_KEYS]
    if missing:
        problems.append(f"{prefix} missing keys: {missing}")
    if extra:
        problems.append(f"{prefix} unexpected keys: {extra}")
    if missing:
        return problems

    if not isinstance(entry["node_id"], str) or not entry["node_id"].strip():
        problems.append(f"{prefix}.node_id must be a non-empty string")
    condition = entry["activation_condition"]
    if not isinstance(condition, dict):
        problems.append(f"{prefix}.activation_condition must be an object")
    else:
        if condition.get("kind") not in ACTIVATION_KINDS:
            problems.append(
                f"{prefix}.activation_condition.kind must be one of "
                f"{list(ACTIVATION_KINDS)}, got {condition.get('kind')!r}"
            )
        description = condition.get("description")
        if not isinstance(description, str) or not description.strip():
            problems.append(
                f"{prefix}.activation_condition.description must be a non-empty string"
            )
        if not isinstance(condition.get("satisfied"), bool):
            problems.append(
                f"{prefix}.activation_condition.satisfied must be a boolean, "
                f"got {condition.get('satisfied')!r}"
            )
    checked = entry["last_checked_at"]
    if checked is not None and parse_datetime(checked) is None:
        problems.append(
            f"{prefix}.last_checked_at must be null or an ISO 8601 date-time string, "
            f"got {checked!r}"
        )
    return problems


# ---------------------------------------------------------------------------
# Output
# ---------------------------------------------------------------------------

def render_summary(
    decision: Dict[str, Any], deep_slots: int, recon_slots: int
) -> str:
    lines: List[str] = []
    lines.append(f"THOMPSON SAMPLING ALLOCATION — campaign {decision['campaign_id']}")
    lines.append(
        f"seed={decision['random_seed']} deep_slots={deep_slots} recon_slots={recon_slots} "
        f"generated_at={decision['generated_at']}"
    )
    lines.append(f"decision_id={decision['decision_id']}")
    by_allocation: Dict[str, List[Dict[str, Any]]] = {kind: [] for kind in ALLOCATION_KINDS}
    for entry in decision["candidates"]:
        by_allocation[entry["allocation"]].append(entry)

    def _fmt(entry: Dict[str, Any]) -> str:
        if entry["sampled_value"] is None:
            return f"  {entry['node_id']:<24} (no posterior)          {entry['budget_note']}"
        return (
            f"  {entry['node_id']:<24} posterior {entry['posterior_value']:.3f} "
            f"(n={entry['evidence_count']:>3}) sampled {entry['sampled_value']:.4f}  "
            f"{entry['budget_note']}"
        )

    lines.append("")
    lines.append(f"DEEP INVESTMENT ({len(by_allocation['deep_investment'])})")
    lines.extend(_fmt(entry) for entry in by_allocation["deep_investment"])
    lines.append("")
    lines.append(f"RECONNAISSANCE ({len(by_allocation['reconnaissance'])})")
    lines.extend(_fmt(entry) for entry in by_allocation["reconnaissance"])
    lines.append("")
    lines.append(f"HOLD ({len(by_allocation['hold'])})")
    lines.extend(_fmt(entry) for entry in by_allocation["hold"])
    lines.append("")
    waiting = decision["waiting_activation"]
    lines.append(
        f"WAITING ACTIVATION ({len(waiting)}) — not allocated; "
        f"run activation_monitor.py for check guidance"
    )
    for entry in waiting:
        condition = entry["activation_condition"]
        lines.append(
            f"  {entry['node_id']:<24} {condition['kind']:<24} "
            f"satisfied={str(condition['satisfied']).lower()}"
        )
    return "\n".join(lines)


def write_artifact(decision: Dict[str, Any], artifact_dir: str) -> Path:
    directory = Path(artifact_dir)
    directory.mkdir(parents=True, exist_ok=True)
    path = directory / f"allocation-{decision['decision_id']}.json"
    text = json.dumps(decision, indent=2, sort_keys=True) + "\n"
    path.write_text(text, encoding="utf-8")
    return path


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def _utc_now_iso() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def main(argv: Optional[List[str]] = None) -> int:
    parser = argparse.ArgumentParser(
        description="Thompson-sampling investment allocation over idea posteriors."
    )
    parser.add_argument("--nodes", required=True, help="path to nodes_latest.json")
    parser.add_argument("--seed", required=True, type=int, help="random seed (recorded)")
    parser.add_argument(
        "--deep-slots", required=True, type=int,
        help="number of deep-investment slots this round (caller-decided, no default)",
    )
    parser.add_argument(
        "--recon-slots", required=True, type=int,
        help="number of reconnaissance slots this round (caller-decided, no default)",
    )
    parser.add_argument(
        "--campaign-id", default=None,
        help="campaign UUID (required if nodes file has no campaign_id; must match if both)",
    )
    parser.add_argument(
        "--artifact-dir", default=DEFAULT_ARTIFACT_DIR,
        help=f"directory for the decision artifact (default: {DEFAULT_ARTIFACT_DIR})",
    )
    parser.add_argument(
        "--generated-at", default=None,
        help="override the generated_at timestamp (ISO 8601; for reproducible reruns)",
    )
    parser.add_argument(
        "--dry-run", action="store_true", help="print the summary, write nothing"
    )
    args = parser.parse_args(argv)

    if args.deep_slots < 0 or args.recon_slots < 0:
        print("error: --deep-slots and --recon-slots must be >= 0", file=sys.stderr)
        return 2

    generated_at = args.generated_at
    if generated_at is not None and parse_datetime(generated_at) is None:
        print(
            f"error: --generated-at is not a valid ISO 8601 date-time: {generated_at!r}",
            file=sys.stderr,
        )
        return 2
    if generated_at is None:
        generated_at = _utc_now_iso()

    try:
        campaign_id, nodes = load_nodes_file(args.nodes, args.campaign_id)
    except StoreError as exc:
        print("error: nodes file failed validation:", file=sys.stderr)
        for problem in exc.problems:
            print(f"  - {problem}", file=sys.stderr)
        return 2

    decision = build_decision(
        campaign_id, nodes, args.seed, args.deep_slots, args.recon_slots, generated_at
    )

    problems = validate_allocation_decision(decision)
    if problems:
        print(
            "error: generated artifact failed its own validation (refusing to write):",
            file=sys.stderr,
        )
        for problem in problems:
            print(f"  - {problem}", file=sys.stderr)
        return 2

    print(render_summary(decision, args.deep_slots, args.recon_slots))
    if args.dry_run:
        target = Path(args.artifact_dir) / f"allocation-{decision['decision_id']}.json"
        print(f"\n[dry-run] artifact not written; would write {target}")
        return 0
    path = write_artifact(decision, args.artifact_dir)
    print(f"\nartifact: {path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
