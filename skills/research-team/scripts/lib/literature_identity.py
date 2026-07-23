"""Domain-neutral canonical identity validation for literature gates."""

from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path

from literature_artifact_refs import resolve_pinned_project_json
from literature_identity_keys import (
    PROVIDER_ID_RE,
    canonicalize_stable_locator,
    normalize_author,
    normalize_title,
    normalize_year,
)
from literature_identity_provenance import validate_provenance_record


SHA256_RE = re.compile(r"^sha256:[0-9a-f]{64}$")
PROVENANCE_KINDS = {
    "archived_canonical_metadata",
    "authoritative_retrieval",
    "citation_triangulation",
}


@dataclass(frozen=True)
class CanonicalIdentity:
    keys: frozenset[str]
    title: str
    year: str
    authors: tuple[str, ...]


def validate_canonical_identity(
    value: object,
    label: str,
    errors: list[str],
    *,
    project_root: Path,
) -> CanonicalIdentity | None:
    if not isinstance(value, dict):
        errors.append(f"{label}.canonical_identity must be an object for identity_status='resolved'")
        return None
    canonical_key = canonicalize_stable_locator(value.get("canonical_id"))
    if canonical_key is None:
        errors.append(
            f"{label}.canonical_identity.canonical_id must be a DOI, an http(s) URL, "
            "or provider:<namespace>:<record>"
        )
    title = normalize_title(value.get("title"))
    if not title:
        errors.append(f"{label}.canonical_identity.title is required")
    year = normalize_year(value.get("year"))
    if not year:
        errors.append(f"{label}.canonical_identity.year must be a four-digit year")
    authors_raw = value.get("authors")
    authors: tuple[str, ...] = ()
    if authors_raw is not None:
        if not isinstance(authors_raw, list) or not authors_raw or not all(
            isinstance(author, str) and normalize_author(author) for author in authors_raw
        ):
            errors.append(f"{label}.canonical_identity.authors must be a non-empty string array when provided")
        else:
            authors = tuple(normalize_author(author) for author in authors_raw)

    url_key = canonicalize_stable_locator(value.get("url"))
    if url_key is None or not url_key.startswith(("url:", "doi:", "project:")):
        errors.append(f"{label}.canonical_identity.url must be a stable http(s) or pinned project URL")
    aliases_raw = value.get("aliases", [])
    if not isinstance(aliases_raw, list):
        errors.append(f"{label}.canonical_identity.aliases must be an array")
        aliases_raw = []
    alias_keys: list[str] = []
    for index, alias in enumerate(aliases_raw):
        key = canonicalize_stable_locator(alias)
        if key is None:
            errors.append(
                f"{label}.canonical_identity.aliases[{index}] must be a DOI, an http(s) URL, "
                "or provider:<namespace>:<record>"
            )
        else:
            alias_keys.append(key)

    declared_keys = {key for key in [canonical_key, *alias_keys] if key}
    archived_keys: frozenset[str] = frozenset()
    provenance = value.get("provenance")
    if not isinstance(provenance, dict):
        errors.append(f"{label}.canonical_identity.provenance must be an object")
    else:
        kind = str(provenance.get("kind") or "").strip()
        provider_name = str(provenance.get("provider") or "").strip()
        record_sha256 = str(provenance.get("record_sha256") or "").strip()
        if kind not in PROVENANCE_KINDS:
            errors.append(f"{label}.canonical_identity.provenance.kind must be one of {sorted(PROVENANCE_KINDS)}")
        if not provider_name:
            errors.append(f"{label}.canonical_identity.provenance.provider is required")
        if not SHA256_RE.fullmatch(record_sha256):
            errors.append(f"{label}.canonical_identity.provenance.record_sha256 must be sha256:<64 lowercase hex>")
        provider_match = PROVIDER_ID_RE.fullmatch(str(value.get("canonical_id") or "").strip())
        if provider_match and kind != "citation_triangulation":
            if provider_name.casefold() != provider_match.group("namespace").casefold():
                errors.append(
                    f"{label}.canonical_identity provenance provider must match the provider namespace "
                    "or use citation_triangulation"
                )
        if canonical_key is not None and title and year and declared_keys:
            archived_keys = validate_provenance_record(
                identity=value,
                provenance=provenance,
                project_root=project_root,
                label=label,
                errors=errors,
            )

    if canonical_key is None or not title or not year or not declared_keys:
        return None
    # Display URLs never join identities unless an archived provider block
    # independently establishes the same locator as a record key.
    return CanonicalIdentity(
        keys=frozenset(declared_keys) | archived_keys,
        title=title,
        year=year,
        authors=authors,
    )


__all__ = [
    "CanonicalIdentity",
    "canonicalize_stable_locator",
    "normalize_author",
    "normalize_title",
    "normalize_year",
    "resolve_pinned_project_json",
    "validate_canonical_identity",
]
