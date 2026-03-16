from __future__ import annotations

from idea_core.engine.retrieval import LibrarianRecipeBook, LibrarianRecipeTemplate


def build_hep_librarian_recipe_book() -> LibrarianRecipeBook:
    family_templates: dict[str, tuple[LibrarianRecipeTemplate, ...]] = {
        "AnomalyAbduction": (
            LibrarianRecipeTemplate(
                recipe_id="inspire.anomaly_abduction.v1",
                provider="INSPIRE",
                query_template='primarch:{domain} AND fulltext:"{claim_text}" AND fulltext:"anomaly"',
                summary_template=(
                    "INSPIRE template for anomaly-abduction prior art and correlated-observable checks "
                    "for {operator_family}."
                ),
                relevance=0.92,
            ),
            LibrarianRecipeTemplate(
                recipe_id="pdg.anomaly_constraints.v1",
                provider="PDG",
                query_template='"{claim_text}" anomaly constraints',
                summary_template=(
                    "PDG template for anomaly constraints and baseline world averages tied to the current claim."
                ),
                relevance=0.88,
            ),
        ),
        "SymmetryOperator": (
            LibrarianRecipeTemplate(
                recipe_id="inspire.symmetry_selection_rules.v1",
                provider="INSPIRE",
                query_template='primarch:{domain} AND fulltext:"{hypothesis}" AND fulltext:"symmetry selection rule"',
                summary_template=(
                    "INSPIRE template for symmetry-based selection rules and allowed/forbidden channels."
                ),
                relevance=0.9,
            ),
            LibrarianRecipeTemplate(
                recipe_id="pdg.symmetry_baselines.v1",
                provider="PDG",
                query_template='"{hypothesis}" branching ratio baseline',
                summary_template=(
                    "PDG template for symmetry-sensitive observables and branching-ratio baselines."
                ),
                relevance=0.86,
            ),
        ),
        "LimitExplorer": (
            LibrarianRecipeTemplate(
                recipe_id="inspire.limit_regime.v1",
                provider="INSPIRE",
                query_template='primarch:{domain} AND fulltext:"{hypothesis}" AND fulltext:"limit scaling"',
                summary_template=(
                    "INSPIRE template for controlled limits (decoupling/large-N/soft-collinear) and scaling checks."
                ),
                relevance=0.89,
            ),
            LibrarianRecipeTemplate(
                recipe_id="pdg.limit_measurements.v1",
                provider="PDG",
                query_template='"{hypothesis}" limit measurement',
                summary_template=(
                    "PDG template for measurements constraining the proposed limit regime."
                ),
                relevance=0.85,
            ),
        ),
    }

    return LibrarianRecipeBook(
        templates_by_family=family_templates,
        default_templates=(
            LibrarianRecipeTemplate(
                recipe_id="inspire.generic.hep.v1",
                provider="INSPIRE",
                query_template='primarch:{domain} AND fulltext:"{claim_text}"',
                summary_template="INSPIRE generic HEP retrieval template for claim-level prior art.",
                relevance=0.84,
            ),
            LibrarianRecipeTemplate(
                recipe_id="pdg.generic.hep.v1",
                provider="PDG",
                query_template='"{claim_text}"',
                summary_template="PDG generic HEP retrieval template for data/constraint baselines.",
                relevance=0.8,
            ),
        ),
    )
