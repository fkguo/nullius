from __future__ import annotations

from dataclasses import dataclass
from typing import Any
from urllib.parse import quote_plus

from idea_core.engine.operators import OperatorOutput
from idea_core.engine.utils import sha256_hex


def _compact_text(value: Any, fallback: str) -> str:
    if not isinstance(value, str):
        return fallback
    compact = " ".join(value.split())
    if not compact:
        return fallback
    return _sanitize_for_query(compact)


def _sanitize_for_query(text: str) -> str:
    """H-08: Sanitize text for use in INSPIRE fulltext queries.

    Escapes double quotes and strips control characters to prevent
    query injection via user-supplied claim_text / hypothesis fields.
    """
    # Strip null bytes and control characters (keep normal whitespace).
    cleaned = "".join(ch for ch in text if ch == "\n" or ch == "\t" or (ch >= " " and ch != "\x7f"))
    # Escape double quotes to prevent breaking out of fulltext:"..." queries.
    cleaned = cleaned.replace('"', '\\"')
    return cleaned.strip()


def _dedupe_uris(uris: list[str]) -> list[str]:
    deduped: list[str] = []
    seen: set[str] = set()
    for uri in uris:
        if uri in seen:
            continue
        seen.add(uri)
        deduped.append(uri)
    return deduped


def _provider_landing_uri(provider: str, query: str) -> str:
    encoded_query = quote_plus(query)
    if provider == "INSPIRE":
        return f"https://inspirehep.net/literature?sort=mostrecent&q={encoded_query}"
    if provider == "PDG":
        return f"https://pdg.lbl.gov/search?query={encoded_query}"
    return f"https://example.org/search?provider={quote_plus(provider)}&q={encoded_query}"


@dataclass(frozen=True)
class LibrarianRecipeTemplate:
    recipe_id: str
    provider: str
    query_template: str
    summary_template: str
    relevance: float

    def render(
        self,
        *,
        fields: dict[str, str],
    ) -> dict[str, Any]:
        query = self.query_template.format(**fields)
        summary = self.summary_template.format(**fields)
        raw_response_hash = f"sha256:{sha256_hex(self.provider + '|' + query + '|' + summary)}"
        hit = {
            "uri": _provider_landing_uri(self.provider, query),
            "summary": summary,
            "summary_source": "template",
            "relevance": round(float(self.relevance), 3),
        }
        return {
            "recipe_id": self.recipe_id,
            "provider": self.provider,
            "query_template": self.query_template,
            "query": query,
            "api_source": self.provider,
            "api_query": query,
            "raw_response_hash": raw_response_hash,
            "hits": [hit],
        }


@dataclass(frozen=True)
class LibrarianRecipeBook:
    templates_by_family: dict[str, tuple[LibrarianRecipeTemplate, ...]]
    default_templates: tuple[LibrarianRecipeTemplate, ...]

    def _templates_for_family(self, operator_family: str) -> tuple[LibrarianRecipeTemplate, ...]:
        templates = self.templates_by_family.get(operator_family)
        if templates:
            return templates
        return self.default_templates

    def build_packet(
        self,
        *,
        campaign_id: str,
        step_id: str,
        tick: int,
        island_id: str,
        operator_output: OperatorOutput,
        domain: str,
        formalism_id: str,
        generated_at: str,
    ) -> dict[str, Any]:
        claim_text = _compact_text(operator_output.claim_text, "candidate claim")
        hypothesis = _compact_text(operator_output.hypothesis, "testable hypothesis")
        rationale_title = _compact_text(operator_output.rationale_title, "untitled rationale")
        fields = {
            "domain": _compact_text(domain, "hep-ph"),
            "formalism_id": _compact_text(formalism_id, "hep/toy"),
            "operator_family": _compact_text(operator_output.operator_family, "UnknownFamily"),
            "claim_text": claim_text,
            "hypothesis": hypothesis,
            "rationale_title": rationale_title,
        }

        recipes: list[dict[str, Any]] = []
        evidence_items: list[dict[str, Any]] = []
        for template in self._templates_for_family(operator_output.operator_family):
            rendered = template.render(fields=fields)
            recipes.append(rendered)
            hit = rendered["hits"][0]
            evidence_items.append(
                {
                    "provider": rendered["provider"],
                    "recipe_id": rendered["recipe_id"],
                    "uri": hit["uri"],
                    "summary": hit["summary"],
                    "relevance": hit["relevance"],
                }
            )

        return {
            "packet_type": "librarian_evidence_packet_v1",
            "packet_schema_version": 1,
            "relevance_policy": "template_prior_v1",
            "packet_id": f"librarian-{step_id}-tick-{tick:03d}",
            "campaign_id": campaign_id,
            "step_id": step_id,
            "tick": tick,
            "island_id": island_id,
            "operator_id": operator_output.operator_id,
            "operator_family": operator_output.operator_family,
            "generated_by_role": "Librarian",
            "recipes": recipes,
            "evidence_items": evidence_items,
            "retrieval_timestamp": generated_at,
            "generated_at": generated_at,
        }

    @staticmethod
    def claim_evidence_uris(
        *,
        packet_ref: str,
        packet_payload: dict[str, Any],
        operator_evidence_uris: list[str],
    ) -> list[str]:
        uris: list[str] = [packet_ref]
        for item in packet_payload.get("evidence_items", []):
            uri = item.get("uri")
            if isinstance(uri, str) and uri:
                uris.append(uri)
        uris.extend(operator_evidence_uris)
        return _dedupe_uris(uris)


def build_default_librarian_recipe_book() -> LibrarianRecipeBook:
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
                query_template='"{claim_text}" "{formalism_id}" anomaly constraints',
                summary_template=(
                    "PDG template for anomaly constraints and baseline world averages linked to {formalism_id}."
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
                query_template='"{hypothesis}" "{formalism_id}" branching ratio baseline',
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
                query_template='"{hypothesis}" "{formalism_id}" limit measurement',
                summary_template=(
                    "PDG template for measurements constraining the proposed limit regime in {formalism_id}."
                ),
                relevance=0.85,
            ),
        ),
    }

    default_templates = (
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
            query_template='"{claim_text}" "{formalism_id}"',
            summary_template="PDG generic HEP retrieval template for data/constraint baselines.",
            relevance=0.8,
        ),
    )
    return LibrarianRecipeBook(
        templates_by_family=family_templates,
        default_templates=default_templates,
    )
