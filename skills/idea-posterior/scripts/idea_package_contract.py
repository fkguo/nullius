#!/usr/bin/env python3
"""Shared package-contract checks for idea-posterior Gaia packages.

Gaia 0.5.0a4 does not include ``knowledges[*].exported`` in its own
``ir_hash``. Idea-posterior therefore binds references to the exact compiled
``ir.json`` bytes and separately enforces the public-root contract encoded in
those bytes. Keeping both operations here prevents extractors, renderers, and
writeback from inventing subtly different notions of package state.
"""

from __future__ import annotations

import hashlib
import json
import re


READER_REASONING_RE = re.compile(r"^\s*reader_reasoning:\s*\S")
GAIA_IR_HASH_RE = re.compile(r"^sha256:[0-9a-f]{64}$")
EVIDENCE_FAMILY_RE = re.compile(
    r"\bevidence_family\s*:\s*"
    r"([a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?)\b"
)
CORRELATION_MODEL_RE = re.compile(
    r"\bcorrelation_model\s*:\s*"
    r"(single)\b"
)


def compiled_ir_pin(ir_bytes: bytes) -> str:
    """Return the content pin for the exact compiled IR artifact."""
    return "sha256:" + hashlib.sha256(ir_bytes).hexdigest()


def load_compiled_ir(ir_bytes: bytes) -> dict:
    """Decode a compiled IR object with a stable, caller-friendly error."""
    try:
        ir = json.loads(ir_bytes)
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise ValueError(f"compiled ir.json is not valid UTF-8 JSON: {exc}") from exc
    if not isinstance(ir, dict):
        raise ValueError("compiled ir.json is not a JSON object")
    if GAIA_IR_HASH_RE.fullmatch(str(ir.get("ir_hash") or "")) is None:
        raise ValueError(
            "compiled ir.json has no canonical Gaia ir_hash "
            "(expected sha256:<64 lowercase hex>); exact-byte package pinning "
            "supplements this compiled-IR marker rather than replacing it"
        )
    return ir


def require_unique_exported_root(ir: dict, root_label: str = "worth") -> dict:
    """Require ``root_label`` to be the package's sole exported conclusion."""
    knowledges = ir.get("knowledges")
    if not isinstance(knowledges, list):
        raise ValueError("compiled ir.json has no knowledges list")
    exported = [
        item
        for item in knowledges
        if isinstance(item, dict) and item.get("exported") is True
    ]
    roots = [item for item in exported if item.get("label") == root_label]
    if (
        len(exported) == 1
        and len(roots) == 1
        and roots[0].get("type") == "claim"
    ):
        return roots[0]

    labels = [
        str(item.get("label") or item.get("id") or "(unlabelled)")
        for item in exported
    ]
    expected = f'__all__ = ["{root_label}"]'
    raise ValueError(
        "idea-posterior package contract violation: expected exactly one "
        f"exported conclusion labelled {root_label!r}, but found exported "
        f"nodes {labels!r}. Migrate the package module to {expected}, then "
        "re-run run_infer_and_extract.py to recompile, infer, render, and "
        "issue a fresh package reference"
    )


def require_authored_infer_rationales(ir: dict) -> None:
    """Require an explicit authored-reasoning sentinel on every infer edge.

    The sentinel is structural: it records that the author supplied the
    evidence-to-hypothesis explanation. It deliberately does not match or
    forbid any criterion sentence in natural language.
    """
    for index, strategy in enumerate(ir.get("strategies") or []):
        if not isinstance(strategy, dict) or strategy.get("type") != "infer":
            continue
        rationale = " ".join(
            str(step.get("reasoning") or "").strip()
            for step in strategy.get("steps") or []
            if isinstance(step, dict) and str(step.get("reasoning") or "").strip()
        )
        before_anchor = rationale.split("anchor:", 1)[0]
        if READER_REASONING_RE.search(before_anchor) is None:
            strategy_id = strategy.get("strategy_id") or f"infer[{index}]"
            raise ValueError(
                "idea-posterior package contract violation: infer strategy "
                f"{strategy_id!r} has no explicit authored reader reasoning. "
                "Migrate its literal rationale to "
                "'reader_reasoning: <why the evidence changes the hypothesis> "
                "anchor: <source>', then re-run run_infer_and_extract.py"
            )


def parse_evidence_family_rationale(rationale: str) -> tuple[str, str]:
    """Parse the explicit evidence-family and correlation declarations."""
    before_anchor = rationale.split("anchor:", 1)[0]
    family_declarations = re.findall(r"\bevidence_family\s*:", before_anchor)
    model_declarations = re.findall(r"\bcorrelation_model\s*:", before_anchor)
    families = EVIDENCE_FAMILY_RE.findall(before_anchor)
    models = CORRELATION_MODEL_RE.findall(before_anchor)
    if (
        len(family_declarations) != 1
        or len(model_declarations) != 1
        or len(families) != 1
        or len(models) != 1
    ):
        raise ValueError(
            "every observe rationale must declare exactly one "
            "'evidence_family: <stable-token>' and exactly one "
            "'correlation_model: single' before its anchor. Gaia 0.5.0a4 "
            "does not encode a joint likelihood for correlated observations; "
            "collapse a correlated family into one composite observation"
        )
    return families[0], models[0]


def audit_evidence_families(ir: dict, root_label: str = "worth") -> dict[str, dict]:
    """Fail closed on duplicated independent votes from one evidence family.

    Gaia 0.5.0a4's ``infer`` surface multiplies separate likelihood factors;
    merely routing correlated observations through one latent claim does not
    encode their joint distribution. Consequently, at most one observation
    from a family may have a likelihood-bearing path to the exported root, and
    that observation may have only one such path. Correlated material must be
    collapsed into one composite observation with one authored likelihood.
    Repeated family labels are tolerated only on disconnected source notes
    that cannot change the exported posterior.
    """
    root = require_unique_exported_root(ir, root_label)
    root_id = str(root.get("id"))
    knowledges = {
        str(item["id"]): item
        for item in ir.get("knowledges") or []
        if isinstance(item, dict) and item.get("id")
    }
    outgoing: dict[str, list[str]] = {kid: [] for kid in knowledges}
    for strategy in ir.get("strategies") or []:
        if not isinstance(strategy, dict) or strategy.get("type") != "infer":
            continue
        premises = strategy.get("premises") or []
        conclusion = strategy.get("conclusion")
        probabilities = strategy.get("conditional_probabilities") or []
        if (
            len(premises) == 1
            and len(probabilities) == 2
            and conclusion in knowledges
            and premises[0] in knowledges
        ):
            outgoing[str(conclusion)].append(str(premises[0]))

    visit_state: dict[str, int] = {}

    def assert_acyclic(node_id: str) -> None:
        state = visit_state.get(node_id, 0)
        if state == 1:
            raise ValueError("compiled reader evidence-flow graph contains a cycle")
        if state == 2:
            return
        visit_state[node_id] = 1
        for target in outgoing.get(node_id, []):
            assert_acyclic(target)
        visit_state[node_id] = 2

    for knowledge_id in knowledges:
        assert_acyclic(knowledge_id)

    reach_cache: dict[str, bool] = {}
    path_count_cache: dict[str, int] = {}

    def reaches_root(node_id: str) -> bool:
        if node_id == root_id:
            return True
        if node_id in reach_cache:
            return reach_cache[node_id]
        result = any(
            reaches_root(target)
            for target in outgoing.get(node_id, [])
        )
        reach_cache[node_id] = result
        return result

    def root_path_count(node_id: str) -> int:
        """Count worth paths, capped at two because only uniqueness matters."""
        if node_id == root_id:
            return 1
        if node_id in path_count_cache:
            return path_count_cache[node_id]
        total = 0
        for target in outgoing.get(node_id, []):
            total += root_path_count(target)
            if total > 1:
                total = 2
                break
        path_count_cache[node_id] = total
        return total

    records: dict[str, dict] = {}
    for kid, item in knowledges.items():
        supports = (item.get("metadata") or {}).get("supported_by") or []
        observation_supports = [
            support
            for support in supports
            if isinstance(support, dict) and support.get("pattern") == "observation"
        ]
        if not observation_supports:
            continue
        if len(observation_supports) != 1:
            raise ValueError(
                f"observed knowledge {kid!r} must carry exactly one observation "
                "record so its evidence family is unambiguous"
            )
        rationale = str(observation_supports[0].get("rationale") or "")
        try:
            family, correlation_model = parse_evidence_family_rationale(rationale)
        except ValueError as exc:
            raise ValueError(f"observed knowledge {kid!r}: {exc}") from exc
        root_targets = [
            target for target in outgoing.get(kid, []) if reaches_root(target)
        ]
        if len(root_targets) > 1:
            raise ValueError(
                f"observed knowledge {kid!r} supplies {len(root_targets)} "
                "independent likelihood updates on paths to worth. Model one "
                "shared dependency update, then propagate that claim to criteria"
            )
        path_count = root_path_count(kid)
        if path_count > 1:
            raise ValueError(
                f"observed knowledge {kid!r} reaches worth through more than "
                "one likelihood-bearing path. Collapse the evidence into one "
                "criterion path; branching one observation into several "
                "worth updates counts the same evidence more than once"
            )
        records[kid] = {
            "family": family,
            "correlation_model": correlation_model,
            "root_target": root_targets[0] if root_targets else None,
            "root_path_count": path_count,
        }

    by_family: dict[str, list[str]] = {}
    for kid, record in records.items():
        by_family.setdefault(record["family"], []).append(kid)
    for family, node_ids in by_family.items():
        connected = [
            kid for kid in node_ids if records[kid]["root_path_count"] == 1
        ]
        if len(connected) > 1:
            raise ValueError(
                f"evidence family {family!r} is reused by observed nodes "
                f"{connected!r} on paths to worth. Gaia 0.5.0a4 would multiply "
                "those likelihoods even if the arrows meet at one claim; "
                "collapse the correlated material into one composite "
                "observation with one likelihood update"
            )
    family_counts = {family: len(node_ids) for family, node_ids in by_family.items()}
    for record in records.values():
        record["reuse_count"] = family_counts[record["family"]]
    return records
