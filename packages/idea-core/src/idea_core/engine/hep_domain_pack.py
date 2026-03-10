from __future__ import annotations

import copy
import json
from pathlib import Path
from typing import Any

from idea_core.engine.domain_pack import (
    DomainConstraintPolicy,
    DomainPackAssets,
    DomainPackDescriptor,
    build_default_abstract_problem_registry,
)
from idea_core.engine.hep_constraint_policy import build_hep_constraint_findings
from idea_core.engine.operators import SearchOperator, hep_operator_families_m32


HEP_CONSTRAINT_POLICY = DomainConstraintPolicy(
    namespace="hep",
    blocking_error_message="hep_constraints_failed",
    build_findings=build_hep_constraint_findings,
)
HEP_BUILTIN_PACK_CATALOG = Path(__file__).with_name("hep_builtin_domain_packs.json")


def _load_hep_builtin_pack_catalog() -> list[dict[str, Any]]:
    payload = json.loads(HEP_BUILTIN_PACK_CATALOG.read_text(encoding="utf-8"))
    packs = payload.get("packs")
    if not isinstance(packs, list) or not packs:
        raise ValueError("HEP built-in pack catalog must contain a non-empty packs list")
    return packs


def _resolve_operator_set(
    operator_source: str,
) -> tuple[SearchOperator, ...]:
    if operator_source == "hep_operator_families_m32":
        return hep_operator_families_m32()
    raise ValueError(f"unknown HEP operator_source: {operator_source}")


def _build_hep_assets(
    *,
    entry: dict[str, Any],
) -> DomainPackAssets:
    pack_id = str(entry["pack_id"])
    domain_prefixes = tuple(str(prefix) for prefix in entry.get("domain_prefixes", []))
    operator_source = str(entry["operator_source"])
    operator_selection_policy = str(entry.get("operator_selection_policy", "round_robin_v1"))
    return DomainPackAssets(
        pack_id=pack_id,
        domain_prefixes=domain_prefixes,
        abstract_problem_registry=build_default_abstract_problem_registry(),
        search_operators=_resolve_operator_set(operator_source),
        operator_selection_policy=operator_selection_policy,
        constraint_policy=HEP_CONSTRAINT_POLICY,
    )


def build_builtin_hep_domain_pack_descriptors() -> tuple[DomainPackDescriptor, ...]:
    descriptors: list[DomainPackDescriptor] = []
    for entry in _load_hep_builtin_pack_catalog():
        pack_id = str(entry["pack_id"])
        domain_prefixes = tuple(str(prefix) for prefix in entry.get("domain_prefixes", []))
        description = str(entry["description"])
        descriptors.append(
            DomainPackDescriptor(
                pack_id=pack_id,
                domain_prefixes=domain_prefixes,
                description=description,
                loader=lambda entry=copy.deepcopy(entry): _build_hep_assets(entry=entry),
            )
        )
    return tuple(descriptors)
