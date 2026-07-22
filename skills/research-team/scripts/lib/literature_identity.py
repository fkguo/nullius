"""Domain-neutral canonical identity and pinned-artifact helpers for literature gates."""

from __future__ import annotations

import hashlib
import importlib.util
import json
import re
import sys
import unicodedata
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from urllib.parse import unquote, urlsplit, urlunsplit


PINNED_PROJECT_REF_RE = re.compile(
    r"^project://(?P<path>[^\s#]+)#sha256:(?P<digest>[0-9a-f]{64})$"
)
DOI_RE = re.compile(r"^10\.\d{4,9}/\S+$", re.IGNORECASE)
PROVIDER_ID_RE = re.compile(
    r"^provider:(?P<namespace>[a-z0-9][a-z0-9._-]*):(?P<record>[^\s:][^\s]*)$",
    re.IGNORECASE,
)
SHA256_RE = re.compile(r"^sha256:[0-9a-f]{64}$")
PROVENANCE_KINDS = {
    "archived_canonical_metadata",
    "authoritative_retrieval",
    "citation_triangulation",
}
_PREPRINT_DOI_VERSION_RE = re.compile(r"^(10\.48550/arxiv\..+)v\d+$")


@dataclass(frozen=True)
class CanonicalIdentity:
    keys: frozenset[str]
    title: str
    year: str
    authors: tuple[str, ...]


def normalize_title(value: object) -> str:
    text = unicodedata.normalize("NFKD", str(value or ""))
    text = "".join(ch for ch in text if not unicodedata.combining(ch))
    return re.sub(r"[^\w]+", " ", text.casefold(), flags=re.UNICODE).strip()


def normalize_year(value: object) -> str:
    match = re.fullmatch(r"\s*((?:1[5-9]|20|21)\d{2})\s*", str(value or ""))
    return match.group(1) if match else ""


def normalize_author(value: object) -> str:
    return normalize_title(value).replace(" ", "")


def normalize_doi(value: str) -> str:
    text = value.strip()
    lowered = text.casefold()
    if PINNED_PROJECT_REF_RE.fullmatch(text):
        return f"project:{text}"
    url_form = False
    for prefix in (
        "https://doi.org/",
        "http://doi.org/",
        "https://dx.doi.org/",
        "http://dx.doi.org/",
        "doi.org/",
        "dx.doi.org/",
    ):
        if lowered.startswith(prefix):
            text = unquote(text[len(prefix):].split("?", 1)[0].split("#", 1)[0])
            url_form = True
            break
    if not url_form and lowered.startswith("doi:"):
        text = text[4:]
    text = text.strip().casefold()
    while True:
        stripped = text.strip("/").rstrip(".,;")
        if stripped == text:
            break
        text = stripped
    match = _PREPRINT_DOI_VERSION_RE.fullmatch(text)
    if match:
        text = match.group(1)
    return text


def _canonical_http_url(value: str) -> str | None:
    try:
        parsed = urlsplit(value.strip())
    except ValueError:
        return None
    if parsed.scheme.casefold() not in {"http", "https"} or not parsed.hostname:
        return None
    scheme = parsed.scheme.casefold()
    hostname = parsed.hostname.casefold()
    port = parsed.port
    if port is not None and not ((scheme == "http" and port == 80) or (scheme == "https" and port == 443)):
        hostname = f"{hostname}:{port}"
    path = parsed.path or "/"
    return urlunsplit((scheme, hostname, path, parsed.query, ""))


def canonicalize_stable_locator(value: object) -> str | None:
    """Return a comparison key only for an auditable stable locator shape."""
    if not isinstance(value, str) or not value.strip():
        return None
    text = value.strip()
    lowered = text.casefold()
    if DOI_RE.fullmatch(normalize_doi(text)) and (
        lowered.startswith(("10.", "doi:", "doi.org/", "dx.doi.org/"))
        or "doi.org/" in lowered
    ):
        return f"doi:{normalize_doi(text)}"
    provider = PROVIDER_ID_RE.fullmatch(text)
    if provider:
        namespace = provider.group("namespace").casefold()
        record = unicodedata.normalize("NFKC", provider.group("record")).strip()
        return f"provider:{namespace}:{record}"
    url = _canonical_http_url(text)
    return f"url:{url}" if url else None


def _load_citation_triangulation_contract() -> Any | None:
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


def _validate_provenance_record(
    *,
    identity: dict[str, Any],
    provenance: dict[str, Any],
    project_root: Path,
    label: str,
    errors: list[str],
) -> None:
    record_ref = provenance.get("record_ref")
    record_sha256 = str(provenance.get("record_sha256") or "").strip()
    match = PINNED_PROJECT_REF_RE.fullmatch(str(record_ref or ""))
    if not match:
        errors.append(
            f"{label}.canonical_identity.provenance.record_ref must be an exact pinned project JSON reference"
        )
        return
    if record_sha256 != f"sha256:{match.group('digest')}":
        errors.append(
            f"{label}.canonical_identity.provenance.record_sha256 must equal the record_ref byte pin"
        )
        return
    document, _ = resolve_pinned_project_json(
        record_ref,
        project_root,
        f"{label}.canonical_identity.provenance.record_ref",
        errors,
    )
    if document is None:
        return
    raw_blocks = document.get("providers")
    if not isinstance(raw_blocks, list) or not raw_blocks:
        errors.append(
            f"{label}.canonical_identity.provenance.record_ref must contain citation-triangulation provider blocks"
        )
        return
    contract = _load_citation_triangulation_contract()
    if contract is None:
        errors.append(f"{label}.canonical_identity provenance cannot load the citation-triangulation contract")
        return
    blocks: list[dict[str, Any]] = []
    for index, raw_block in enumerate(raw_blocks):
        try:
            blocks.append(contract._validate_block(raw_block, f"provenance.providers[{index}]"))
        except Exception as exc:
            errors.append(f"{label}.canonical_identity provenance provider block is invalid: {exc}")
    if len(blocks) != len(raw_blocks):
        return
    kind = str(provenance.get("kind") or "").strip()
    provider_name = str(provenance.get("provider") or "").strip()
    provider_names = {str(block["provider"]).casefold() for block in blocks}
    if kind == "citation_triangulation":
        comparison = contract.compare_blocks(blocks)
        if comparison.get("verdict") != "consistent":
            errors.append(
                f"{label}.canonical_identity citation triangulation must recompute to verdict='consistent'"
            )
    elif provider_name.casefold() not in provider_names:
        errors.append(
            f"{label}.canonical_identity provenance provider is absent from its archived provider blocks"
        )

    candidate_title = contract.fold_text(str(identity.get("title") or "")).replace(" ", "")
    candidate_year = int(normalize_year(identity.get("year")) or 0)
    candidate_authors = identity.get("authors")
    candidate_author_families = (
        [contract.extract_family_name(author) for author in candidate_authors]
        if isinstance(candidate_authors, list) and candidate_authors
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
        if candidate_author_families is not None and block.get("authors") is not None:
            block_authors = [contract.extract_family_name(author) for author in block["authors"]]
            if block_authors != candidate_author_families:
                errors.append(f"{block_label}.authors do not match canonical candidate metadata")

    canonical_key = canonicalize_stable_locator(identity.get("canonical_id"))
    required_keys = {canonical_key} if canonical_key else set()
    aliases = identity.get("aliases")
    if isinstance(aliases, list):
        required_keys.update(
            key for key in (canonicalize_stable_locator(alias) for alias in aliases) if key
        )
    record_keys: set[str] = set()
    for block in blocks:
        doi = block.get("doi")
        if doi:
            record_keys.add(f"doi:{contract.normalize_doi(doi)}")
        identifier = str(block.get("identifier") or "").strip()
        provider = str(block.get("provider") or "").strip().casefold()
        if identifier:
            record_keys.add(f"provider:{provider}:{unicodedata.normalize('NFKC', identifier).strip()}")
            normalized_identifier = canonicalize_stable_locator(identifier)
            if normalized_identifier:
                record_keys.add(normalized_identifier)
    citation_key = canonicalize_stable_locator(document.get("citation_key"))
    if canonical_key is not None and citation_key != canonical_key:
        errors.append(f"{label}.canonical_identity provenance citation_key does not match canonical_id")
    if canonical_key is not None and canonical_key not in record_keys:
        errors.append(
            f"{label}.canonical_identity canonical_id is not established by the archived provider record"
        )
    missing_keys = sorted(required_keys - record_keys)
    if missing_keys:
        errors.append(
            f"{label}.canonical_identity provenance does not establish canonical identity aliases: "
            + ", ".join(missing_keys)
        )


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

    # `url` is a display/retrieval locator, not identity authority by itself.
    # It participates in joins only when repeated as canonical_id or as an
    # explicit alias established by the archived provider blocks.
    keys = frozenset(key for key in [canonical_key, *alias_keys] if key)
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
        if canonical_key is not None and title and year and keys:
            _validate_provenance_record(
                identity=value,
                provenance=provenance,
                project_root=project_root,
                label=label,
                errors=errors,
            )

    if canonical_key is None or not title or not year or not keys:
        return None
    return CanonicalIdentity(keys=keys, title=title, year=year, authors=authors)


def resolve_pinned_project_json(
    ref: object,
    project_root: Path,
    label: str,
    errors: list[str],
) -> tuple[dict[str, Any] | None, Path | None]:
    if not isinstance(ref, str) or not PINNED_PROJECT_REF_RE.fullmatch(ref):
        errors.append(
            f"{label} must be project://<project-relative path>#sha256:<64 lowercase hex>"
        )
        return None, None
    match = PINNED_PROJECT_REF_RE.fullmatch(ref)
    assert match is not None
    if not re.fullmatch(r"[A-Za-z0-9._~%/-]+", match.group("path")):
        errors.append(f"{label} path must use canonical percent-encoding")
        return None, None
    rel_text = unquote(match.group("path"))
    parts = rel_text.split("/")
    if "\\" in rel_text or any(part in {"", ".", ".."} for part in parts):
        errors.append(f"{label} path escapes or is not canonical: {rel_text!r}")
        return None, None
    root = project_root.resolve()
    path = project_root.joinpath(*parts)
    try:
        resolved = path.resolve(strict=True)
        resolved.relative_to(root)
    except (OSError, ValueError):
        errors.append(f"{label} does not resolve inside project root: {path}")
        return None, None
    if not resolved.is_file():
        errors.append(f"{label} target is not a file: {resolved}")
        return None, None
    try:
        payload = resolved.read_bytes()
    except OSError as exc:
        errors.append(f"{label} cannot be read: {exc}")
        return None, None
    actual = hashlib.sha256(payload).hexdigest()
    if actual != match.group("digest"):
        errors.append(
            f"{label} pin does not match exact artifact bytes: expected sha256:{match.group('digest')}, "
            f"got sha256:{actual}"
        )
        return None, resolved
    try:
        document = json.loads(payload)
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        errors.append(f"{label} must contain UTF-8 JSON: {exc}")
        return None, resolved
    if not isinstance(document, dict):
        errors.append(f"{label} JSON must be an object")
        return None, resolved
    return document, resolved
