from __future__ import annotations

from idea_core.engine.domain_pack import (
    DomainPackAssets,
    DomainPackDescriptor,
    build_default_abstract_problem_registry,
)
from idea_core.engine.operators import default_search_operators
from idea_core.engine.retrieval import build_default_librarian_recipe_book


DEFAULT_DOMAIN_PACK_ID = "generic.default.v1"


def _build_default_assets() -> DomainPackAssets:
    return DomainPackAssets(
        pack_id=DEFAULT_DOMAIN_PACK_ID,
        domain_prefixes=(),
        abstract_problem_registry=build_default_abstract_problem_registry(),
        search_operators=default_search_operators(),
        librarian_recipes=build_default_librarian_recipe_book(),
        operator_selection_policy="round_robin_v1",
        constraint_policy=None,
    )


def build_builtin_default_domain_pack_descriptors() -> tuple[DomainPackDescriptor, ...]:
    return (
        DomainPackDescriptor(
            pack_id=DEFAULT_DOMAIN_PACK_ID,
            domain_prefixes=(),
            description="Provider-neutral default pack with generic search operators and recipes.",
            loader=_build_default_assets,
        ),
    )
