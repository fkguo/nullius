from __future__ import annotations

import threading
from dataclasses import dataclass, field
from typing import Any, Callable

from idea_core.engine.operators import (
    SearchOperator,
    default_search_operators,
)
from idea_core.engine.retrieval import LibrarianRecipeBook, build_default_librarian_recipe_book


DomainConstraintFindingBuilder = Callable[[dict[str, Any]], list[dict[str, str]]]


@dataclass(frozen=True)
class DomainConstraintPolicy:
    namespace: str
    blocking_error_message: str
    build_findings: DomainConstraintFindingBuilder


@dataclass(frozen=True)
class DomainPackAssets:
    pack_id: str
    domain_prefixes: tuple[str, ...]
    abstract_problem_registry: dict[str, Any]
    search_operators: tuple[SearchOperator, ...]
    librarian_recipes: LibrarianRecipeBook = field(default_factory=build_default_librarian_recipe_book)
    operator_selection_policy: str = "round_robin_v1"
    constraint_policy: DomainConstraintPolicy | None = None


@dataclass(frozen=True)
class DomainPackDescriptor:
    pack_id: str
    domain_prefixes: tuple[str, ...]
    description: str
    loader: Callable[[], DomainPackAssets]


class DomainPackIndex:
    def __init__(self, descriptors: tuple[DomainPackDescriptor, ...]) -> None:
        if not descriptors:
            raise ValueError("domain pack index requires at least one descriptor")
        self._descriptors: dict[str, DomainPackDescriptor] = {}
        for descriptor in descriptors:
            if descriptor.pack_id in self._descriptors:
                raise ValueError(f"duplicate domain pack id: {descriptor.pack_id}")
            self._descriptors[descriptor.pack_id] = descriptor
        self._cache: dict[str, DomainPackAssets] = {}
        self._cache_lock = threading.Lock()

    def list_pack_ids(self) -> tuple[str, ...]:
        return tuple(self._descriptors.keys())

    def has_pack(self, pack_id: str) -> bool:
        return pack_id in self._descriptors

    def eligible_pack_ids_for_domain(self, domain: str) -> tuple[str, ...]:
        eligible: list[str] = []
        for descriptor in self._descriptors.values():
            prefixes = descriptor.domain_prefixes
            if not prefixes:
                eligible.append(descriptor.pack_id)
                continue
            if any(domain.startswith(prefix) for prefix in prefixes):
                eligible.append(descriptor.pack_id)
        return tuple(eligible)

    def load(self, pack_id: str) -> DomainPackAssets:
        descriptor = self._descriptors.get(pack_id)
        if descriptor is None:
            raise KeyError(f"unknown domain pack id: {pack_id}")
        with self._cache_lock:
            cached = self._cache.get(pack_id)
            if cached is not None:
                return cached
            assets = descriptor.loader()
            if assets.pack_id != pack_id:
                raise ValueError(
                    f"domain pack loader mismatch: descriptor={pack_id}, loaded={assets.pack_id}"
                )
            if not assets.search_operators:
                raise ValueError(f"domain pack {pack_id} has no search operators")
            if assets.constraint_policy is not None:
                if not assets.constraint_policy.namespace.strip():
                    raise ValueError(f"domain pack {pack_id} has empty constraint namespace")
                if not assets.constraint_policy.blocking_error_message.strip():
                    raise ValueError(f"domain pack {pack_id} has empty blocking error message")
            self._cache[pack_id] = assets
            return assets


def build_bootstrap_abstract_problem_registry() -> dict[str, Any]:
    return {
        "entries": [
            {
                "abstract_problem_type": "optimization",
                "description": "Default optimization abstraction for bootstrap runs.",
                "known_solution_families": ["gradient-based"],
                "prerequisite_checklist": ["objective is defined"],
                "reference_uris": ["https://example.org/optimization"],
            }
        ]
    }


def build_builtin_domain_pack_index(
    *,
    search_operators: tuple[SearchOperator, ...] | None = None,
) -> DomainPackIndex:
    resolved_search_operators = (
        tuple(search_operators)
        if search_operators is not None
        else default_search_operators()
    )
    if not resolved_search_operators:
        raise ValueError("built-in domain pack index requires at least one search operator")

    from idea_core.engine.hep_domain_pack import build_builtin_hep_domain_pack_descriptors

    return DomainPackIndex(build_builtin_hep_domain_pack_descriptors(resolved_search_operators))
