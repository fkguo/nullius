"""Validation and authoritative-key extraction for archived citation records."""

from __future__ import annotations

import importlib.util
import sys
import unicodedata
from pathlib import Path
from typing import Any

from literature_artifact_refs import resolve_pinned_project_json
from literature_identity_keys import PINNED_PROJECT_REF_RE, canonicalize_stable_locator, normalize_year


def _load_citation_contract() -> Any | None:
    module_name = "nullius_citation_triangulation_contract"
    if module_name in sys.modules:
        return sys.modules[module_name]
    script = (
        Path(__file__).resolve().parents[3]
        / "citation-triangulation"
        / "scripts"
        / "bin"
        / "triangulate_citation.py"
    )
    if not script.is_file():
        return None
    spec = importlib.util.spec_from_file_location(module_name, script)
    if spec is None or spec.loader is None:
        return None
    module = importlib.util.module_from_spec(spec)
    sys.modules[module_name] = module
    spec.loader.exec_module(module)
    return module


def _record_keys(blocks: list[dict[str, Any]], contract: Any) -> set[str]:
    keys: set[str] = set()
    for block in blocks:
        doi = block.get("doi")
        if doi:
            keys.add(f"doi:{contract.normalize_doi(doi)}")
        identifier = str(block.get("identifier") or "").strip()
        provider = str(block.get("provider") or "").strip().casefold()
        if identifier:
            normalized = unicodedata.normalize("NFKC", identifier).strip()
            keys.add(f"provider:{provider}:{normalized}")
            direct = canonicalize_stable_locator(identifier)
            if direct:
                keys.add(direct)
    return keys


def validate_provenance_record(
    *,
    identity: dict[str, Any],
    provenance: dict[str, Any],
    project_root: Path,
    label: str,
    errors: list[str],
) -> frozenset[str]:
    """Return every archived DOI/provider key only when validation succeeds."""
    start_errors = len(errors)
    record_ref = provenance.get("record_ref")
    record_sha256 = str(provenance.get("record_sha256") or "").strip()
    match = PINNED_PROJECT_REF_RE.fullmatch(str(record_ref or ""))
    if not match:
        errors.append(
            f"{label}.canonical_identity.provenance.record_ref must be an exact pinned project JSON reference"
        )
        return frozenset()
    if record_sha256 != f"sha256:{match.group('digest')}":
        errors.append(f"{label}.canonical_identity.provenance.record_sha256 must equal the record_ref byte pin")
        return frozenset()
    document, _ = resolve_pinned_project_json(
        record_ref,
        project_root,
        f"{label}.canonical_identity.provenance.record_ref",
        errors,
    )
    if document is None:
        return frozenset()
    raw_blocks = document.get("providers")
    if not isinstance(raw_blocks, list) or not raw_blocks:
        errors.append(f"{label}.canonical_identity.provenance.record_ref must contain citation-triangulation provider blocks")
        return frozenset()
    contract = _load_citation_contract()
    if contract is None:
        errors.append(f"{label}.canonical_identity provenance cannot load the citation-triangulation contract")
        return frozenset()
    blocks: list[dict[str, Any]] = []
    for index, raw_block in enumerate(raw_blocks):
        try:
            blocks.append(contract._validate_block(raw_block, f"provenance.providers[{index}]"))
        except Exception as exc:
            errors.append(f"{label}.canonical_identity provenance provider block is invalid: {exc}")
    if len(blocks) != len(raw_blocks):
        return frozenset()

    kind = str(provenance.get("kind") or "").strip()
    provider_name = str(provenance.get("provider") or "").strip()
    provider_names = {str(block["provider"]).casefold() for block in blocks}
    if kind == "citation_triangulation":
        if contract.compare_blocks(blocks).get("verdict") != "consistent":
            errors.append(f"{label}.canonical_identity citation triangulation must recompute to verdict='consistent'")
    elif provider_name.casefold() not in provider_names:
        errors.append(f"{label}.canonical_identity provenance provider is absent from its archived provider blocks")

    candidate_title = contract.fold_text(str(identity.get("title") or "")).replace(" ", "")
    candidate_year = int(normalize_year(identity.get("year")) or 0)
    authors = identity.get("authors")
    candidate_authors = (
        [contract.extract_family_name(author) for author in authors]
        if isinstance(authors, list) and authors
        else None
    )
    for index, block in enumerate(blocks):
        block_label = f"{label}.canonical_identity.provenance.providers[{index}]"
        if block.get("title") is not None:
            block_title = contract.fold_text(block["title"]).replace(" ", "")
            if block_title != candidate_title:
                errors.append(f"{block_label}.title does not match canonical candidate metadata")
        if block.get("year") is not None and int(block["year"]) != candidate_year:
            errors.append(f"{block_label}.year does not match canonical candidate metadata")
        if candidate_authors is not None and block.get("authors") is not None:
            block_authors = [contract.extract_family_name(author) for author in block["authors"]]
            if block_authors != candidate_authors:
                errors.append(f"{block_label}.authors do not match canonical candidate metadata")

    canonical_key = canonicalize_stable_locator(identity.get("canonical_id"))
    required_keys = {canonical_key} if canonical_key else set()
    aliases = identity.get("aliases")
    if isinstance(aliases, list):
        required_keys.update(key for key in map(canonicalize_stable_locator, aliases) if key)
    record_keys = _record_keys(blocks, contract)
    if canonical_key is not None and canonicalize_stable_locator(document.get("citation_key")) != canonical_key:
        errors.append(f"{label}.canonical_identity provenance citation_key does not match canonical_id")
    if canonical_key is not None and canonical_key not in record_keys:
        errors.append(f"{label}.canonical_identity canonical_id is not established by the archived provider record")
    missing_keys = sorted(required_keys - record_keys)
    if missing_keys:
        errors.append(
            f"{label}.canonical_identity provenance does not establish canonical identity aliases: "
            + ", ".join(missing_keys)
        )
    return frozenset(record_keys) if len(errors) == start_errors else frozenset()
