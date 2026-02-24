from __future__ import annotations

from idea_core.engine.operators import (
    HepAnomalyAbductionOperator,
    HepLimitExplorerOperator,
    HepSymmetryOperator,
    SearchOperator,
)


def test_operator_families_conform_to_search_operator_protocol() -> None:
    operators = (
        HepAnomalyAbductionOperator(),
        HepSymmetryOperator(),
        HepLimitExplorerOperator(),
    )
    for operator in operators:
        try:
            assert isinstance(operator, SearchOperator)
        except TypeError as exc:
            assert False, f"SearchOperator protocol must be runtime-checkable: {exc}"

