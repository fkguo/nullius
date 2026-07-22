"""Runtime binding for detailed literature reconciliation and method ledgers.

The compact survey receipts are intentionally not authority.  This module
resolves their exact-byte-pinned combined ledger, validates its project-root
confinement and internal joins, derives both summaries from the detailed
records, and binds the ledger's selected core identities to the current survey.
"""

from __future__ import annotations

import hashlib
import json
import re
import sys
import unicodedata
from pathlib import Path
from typing import Any
from urllib.parse import unquote, urlsplit, urlunsplit

sys.path.insert(
    0,
    str(Path(__file__).resolve().parents[2] / "research-team" / "scripts" / "lib"),
)

from literature_identity import validate_canonical_identity as validate_archived_canonical_identity  # type: ignore
from literature_coverage import validate_bounded_provider_accounting  # type: ignore


PINNED_PROJECT_REF_RE = re.compile(
    r"^project://(?P<path>[^\s#]+)#sha256:(?P<digest>[0-9a-f]{64})$"
)
DOI_RE = re.compile(r"^10\.\d{4,9}/\S+$", re.IGNORECASE)
PROVIDER_ID_RE = re.compile(
    r"^provider:(?P<namespace>[a-z0-9][a-z0-9._-]*):(?P<record>[^\s:][^\s]*)$",
    re.IGNORECASE,
)
SHA256_RE = re.compile(r"^sha256:[0-9a-f]{64}$")
PREPRINT_DOI_VERSION_RE = re.compile(r"^(10\.48550/arxiv\..+)v\d+$")
PROVENANCE_KINDS = {
    "archived_canonical_metadata",
    "authoritative_retrieval",
    "citation_triangulation",
}
CANDIDATE_DISPOSITIONS = {
    "core",
    "supporting",
    "background",
    "duplicate",
    "out_of_scope",
    "coverage_debt",
}
METHOD_DISPOSITIONS = {"classified", "out_of_scope", "coverage_debt"}
SCREENING_DISPOSITIONS = {"method_bearing", "not_method_bearing", "coverage_debt"}


def _text(value: object) -> str:
    return str(value or "").strip()


def _fold(value: object) -> str:
    text = unicodedata.normalize("NFKD", _text(value))
    text = "".join(ch for ch in text if not unicodedata.combining(ch))
    return re.sub(r"[^\w]+", " ", text.casefold(), flags=re.UNICODE).strip()


def _year(value: object) -> str:
    match = re.fullmatch(r"\s*((?:1[5-9]|20|21)\d{2})\s*", str(value or ""))
    return match.group(1) if match else ""


def _normalize_doi(value: str) -> str:
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
    version = PREPRINT_DOI_VERSION_RE.fullmatch(text)
    return version.group(1) if version else text


def _canonical_url(value: str) -> str | None:
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
    return urlunsplit((scheme, hostname, parsed.path or "/", parsed.query, ""))


def canonical_locator(value: object) -> str | None:
    if not isinstance(value, str) or not value.strip():
        return None
    text = value.strip()
    lowered = text.casefold()
    doi = _normalize_doi(text)
    if DOI_RE.fullmatch(doi) and (
        lowered.startswith(("10.", "doi:", "doi.org/", "dx.doi.org/"))
        or "doi.org/" in lowered
    ):
        return f"doi:{doi}"
    provider = PROVIDER_ID_RE.fullmatch(text)
    if provider:
        return (
            f"provider:{provider.group('namespace').casefold()}:"
            f"{unicodedata.normalize('NFKC', provider.group('record')).strip()}"
        )
    url = _canonical_url(text)
    return f"url:{url}" if url else None


def _resolve_project_json(
    ref: object,
    project_root: Path,
    label: str,
    problems: list[str],
) -> dict[str, Any] | None:
    if not isinstance(ref, str) or not PINNED_PROJECT_REF_RE.fullmatch(ref):
        problems.append(
            f"{label} must be project://<project-relative path>#sha256:<64 lowercase hex>"
        )
        return None
    match = PINNED_PROJECT_REF_RE.fullmatch(ref)
    assert match is not None
    if not re.fullmatch(r"[A-Za-z0-9._~%/-]+", match.group("path")):
        problems.append(f"{label} path must use canonical percent-encoding")
        return None
    relative = unquote(match.group("path"))
    parts = relative.split("/")
    if "\\" in relative or any(part in {"", ".", ".."} for part in parts):
        problems.append(f"{label} path escapes project root or is not canonical: {relative!r}")
        return None
    root = project_root.resolve()
    try:
        path = project_root.joinpath(*parts).resolve(strict=True)
        path.relative_to(root)
    except (OSError, ValueError):
        problems.append(f"{label} does not resolve inside project root")
        return None
    if not path.is_file():
        problems.append(f"{label} target is not a file")
        return None
    try:
        payload = path.read_bytes()
    except OSError as exc:
        problems.append(f"{label} cannot be read: {exc}")
        return None
    actual = hashlib.sha256(payload).hexdigest()
    if actual != match.group("digest"):
        problems.append(
            f"{label} pin does not match exact artifact bytes: expected sha256:{match.group('digest')}, "
            f"got sha256:{actual}"
        )
        return None
    try:
        document = json.loads(payload)
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        problems.append(f"{label} must contain UTF-8 JSON: {exc}")
        return None
    if not isinstance(document, dict):
        problems.append(f"{label} JSON must be an object")
        return None
    return document


def _canonical_identity(
    candidate: dict[str, Any],
    label: str,
    problems: list[str],
    project_root: Path,
) -> tuple[set[str], str, str] | None:
    if _text(candidate.get("identity_status")) != "resolved":
        if candidate.get("canonical_identity") is not None:
            problems.append(f"{label}.canonical_identity must be absent while identity_status='unresolved'")
        return None
    value = candidate.get("canonical_identity")
    if not isinstance(value, dict):
        problems.append(f"{label}.canonical_identity is required for identity_status='resolved'")
        return None
    if "stable_ids" in candidate:
        problems.append(f"{label}.stable_ids is not canonical identity authority")
    primary = canonical_locator(value.get("canonical_id"))
    provider_identity = PROVIDER_ID_RE.fullmatch(_text(value.get("canonical_id")))
    url = canonical_locator(value.get("url"))
    if primary is None:
        problems.append(
            f"{label}.canonical_identity.canonical_id must be a DOI, an http(s) URL, "
            "or provider:<namespace>:<record>"
        )
    if url is None or not url.startswith(("url:", "doi:", "project:")):
        problems.append(f"{label}.canonical_identity.url must be a stable http(s) or pinned project URL")
    aliases = value.get("aliases", [])
    if not isinstance(aliases, list):
        problems.append(f"{label}.canonical_identity.aliases must be an array")
        aliases = []
    keys = {key for key in (primary, url) if key}
    for index, alias in enumerate(aliases):
        key = canonical_locator(alias)
        if key is None:
            problems.append(f"{label}.canonical_identity.aliases[{index}] has an unrecognized stable identity shape")
        else:
            keys.add(key)
    title = _fold(value.get("title"))
    year = _year(value.get("year"))
    if not title:
        problems.append(f"{label}.canonical_identity.title is required")
    if not year:
        problems.append(f"{label}.canonical_identity.year must be a four-digit year")
    provenance = value.get("provenance")
    if not isinstance(provenance, dict):
        problems.append(f"{label}.canonical_identity.provenance is required")
    else:
        kind = _text(provenance.get("kind"))
        provider = _text(provenance.get("provider"))
        record_ref = _text(provenance.get("record_ref"))
        record_hash = _text(provenance.get("record_sha256"))
        if kind not in PROVENANCE_KINDS:
            problems.append(f"{label}.canonical_identity.provenance.kind is invalid")
        if not provider:
            problems.append(f"{label}.canonical_identity.provenance.provider is required")
        if not re.match(r"^[a-z][a-z0-9+.-]*://", record_ref, re.IGNORECASE) or record_ref.casefold().startswith("file://"):
            problems.append(f"{label}.canonical_identity.provenance.record_ref must be a stable non-file URI")
        if not SHA256_RE.fullmatch(record_hash):
            problems.append(f"{label}.canonical_identity.provenance.record_sha256 must be sha256:<64 lowercase hex>")
        if kind in {"archived_canonical_metadata", "citation_triangulation"} and record_ref and record_hash:
            if not record_ref.endswith(f"#{record_hash}"):
                problems.append(f"{label}.canonical_identity.provenance record_ref/hash binding is inconsistent")
        if provider_identity and kind != "citation_triangulation":
            if provider.casefold() != provider_identity.group("namespace").casefold():
                problems.append(
                    f"{label}.canonical_identity provenance provider must match the provider namespace "
                    "or use citation_triangulation"
                )
    archived = validate_archived_canonical_identity(
        value,
        label,
        problems,
        project_root=project_root,
    )
    if archived is None:
        return None
    return set(archived.keys), archived.title, archived.year


def _validate_method_description(
    item: object,
    *,
    label: str,
    families: set[str],
    disposition_field: str,
    problems: list[str],
) -> tuple[bool, bool]:
    if not isinstance(item, dict):
        problems.append(f"{label} must be an object")
        return False, True
    description = _text(item.get("description"))
    locator = _text(item.get("locator"))
    evidence_basis = _text(item.get("evidence_basis"))
    features = item.get("method_features")
    family_ids = item.get("family_ids")
    disposition = _text(item.get(disposition_field))
    valid = True
    if not description:
        problems.append(f"{label}.description is required")
        valid = False
    if not locator:
        problems.append(f"{label}.locator is required")
        valid = False
    if evidence_basis != "source_text":
        problems.append(f"{label}.evidence_basis must be 'source_text'")
        valid = False
    if not isinstance(features, list) or not features or not all(_text(feature) for feature in features):
        problems.append(f"{label}.method_features must be a non-empty string array")
        valid = False
    elif description and not any(_text(feature).casefold() in description.casefold() for feature in features):
        problems.append(f"{label}.description must contain a recorded method feature")
        valid = False
    if not isinstance(family_ids, list):
        problems.append(f"{label}.family_ids must be an array")
        family_ids = []
        valid = False
    unknown = sorted({_text(family) for family in family_ids if _text(family)} - families)
    if unknown:
        problems.append(f"{label}.family_ids contains unknown taxonomy families: {', '.join(unknown)}")
        valid = False
    if disposition not in METHOD_DISPOSITIONS:
        problems.append(f"{label}.{disposition_field} must be one of {sorted(METHOD_DISPOSITIONS)}")
        valid = False
    if disposition == "classified" and not family_ids:
        problems.append(f"{label}: classified requires at least one taxonomy family")
        valid = False
    if disposition != "classified" and family_ids:
        problems.append(f"{label}: only classified may carry family_ids")
        valid = False
    return valid, disposition == "coverage_debt"


def _survey_core_records(survey: dict[str, Any], problems: list[str]) -> list[tuple[set[str], str, str]]:
    records: list[tuple[set[str], str, str]] = []
    papers = survey.get("papers")
    if not isinstance(papers, list):
        return records
    for index, paper in enumerate(papers):
        if not isinstance(paper, dict) or paper.get("role") != "core":
            continue
        label = f"literature_survey_v1.papers[{index}]"
        identity = paper.get("identity_triangulation")
        providers = identity.get("providers") if isinstance(identity, dict) else None
        keys: set[str] = set()
        titles: set[str] = set()
        years: set[str] = set()
        if isinstance(providers, list):
            for provider_record in providers:
                if not isinstance(provider_record, dict):
                    continue
                provider = _text(provider_record.get("provider")).casefold()
                identifier = _text(provider_record.get("identifier"))
                direct = canonical_locator(identifier)
                if direct:
                    keys.add(direct)
                elif provider and identifier:
                    keys.add(f"provider:{provider}:{unicodedata.normalize('NFKC', identifier)}")
                doi = canonical_locator(provider_record.get("doi"))
                if doi:
                    keys.add(doi)
                if _fold(provider_record.get("title")):
                    titles.add(_fold(provider_record.get("title")))
                if _year(provider_record.get("year")):
                    years.add(_year(provider_record.get("year")))
        for link in paper.get("source_links", []) if isinstance(paper.get("source_links"), list) else []:
            key = canonical_locator(link)
            if key:
                keys.add(key)
        if not keys:
            problems.append(f"{label} has no canonical identity locator")
        if len(titles) != 1 or len(years) != 1:
            problems.append(f"{label} identity metadata is not internally consistent")
        records.append((keys, next(iter(titles), ""), next(iter(years), "")))
    return records


def _compare_summary(
    actual: dict[str, Any],
    expected: dict[str, Any],
    label: str,
    problems: list[str],
) -> None:
    for field, expected_value in expected.items():
        if actual.get(field) != expected_value:
            problems.append(
                f"{label}.{field}={actual.get(field)!r} does not match detailed ledger value {expected_value!r}"
            )


def validate_bound_coverage_closure(
    survey: dict[str, Any],
    project_root: Path,
) -> list[str]:
    problems: list[str] = []
    coverage = survey.get("coverage")
    if not isinstance(coverage, dict):
        return ["literature_survey_v1.coverage must be an object before ledger binding"]
    bibliography_summary = coverage.get("bibliography_reconciliation")
    method_summary = coverage.get("method_family_audit")
    if not isinstance(bibliography_summary, dict) or not isinstance(method_summary, dict):
        return ["coverage reconciliation summaries must be objects before ledger binding"]
    bibliography_ref = bibliography_summary.get("artifact_ref")
    method_ref = method_summary.get("artifact_ref")
    if bibliography_ref != method_ref:
        problems.append(
            "bibliography_reconciliation.artifact_ref and method_family_audit.artifact_ref "
            "must pin the same combined ledger; cross-artifact receipt reuse is forbidden"
        )
        return problems
    ledger = _resolve_project_json(
        bibliography_ref,
        project_root,
        "coverage literature ledger artifact_ref",
        problems,
    )
    if ledger is None:
        return problems

    ledger_status = _text(ledger.get("final_status"))
    provider_complete = validate_bounded_provider_accounting(
        ledger.get("providers"),
        problems,
        label="detailed ledger providers",
        require_queried=ledger_status == "saturated",
    )
    if not _text(ledger.get("stop_reason")):
        problems.append("detailed ledger stop_reason is required")

    pool = ledger.get("candidate_pool")
    if not isinstance(pool, dict):
        problems.append("detailed ledger candidate_pool must be an object")
        return problems
    selected = pool.get("selected_core_ids")
    candidates = pool.get("candidates")
    if not isinstance(selected, list) or not all(_text(item) for item in selected):
        problems.append("detailed ledger candidate_pool.selected_core_ids must be a non-empty string array")
        selected = []
    selected_ids = [_text(item) for item in selected]
    if len(selected_ids) != len(set(selected_ids)):
        problems.append("detailed ledger selected_core_ids must not contain duplicates")
    if not isinstance(candidates, list):
        problems.append("detailed ledger candidate_pool.candidates must be an array")
        candidates = []
    total_candidates = pool.get("total_candidates")
    if isinstance(total_candidates, bool) or not isinstance(total_candidates, int) or total_candidates < 0:
        problems.append("detailed ledger candidate_pool.total_candidates must be a non-negative integer")
    elif total_candidates != len(candidates):
        problems.append("detailed ledger candidate_pool.total_candidates must equal the explicit candidate ledger")
    if not _text(pool.get("artifact")):
        problems.append("detailed ledger candidate_pool.artifact is required")
    if not _text(pool.get("selection_rationale")):
        problems.append("detailed ledger candidate_pool.selection_rationale is required")

    candidates_by_id: dict[str, dict[str, Any]] = {}
    identities: dict[str, tuple[set[str], str, str]] = {}
    key_owners: dict[str, str] = {}
    for index, raw_candidate in enumerate(candidates):
        label = f"detailed ledger candidate_pool.candidates[{index}]"
        if not isinstance(raw_candidate, dict):
            problems.append(f"{label} must be an object")
            continue
        candidate_id = _text(raw_candidate.get("id"))
        if not candidate_id or candidate_id in candidates_by_id:
            problems.append(f"{label}.id is missing or duplicated")
            continue
        candidates_by_id[candidate_id] = raw_candidate
        status = _text(raw_candidate.get("identity_status"))
        if status not in {"resolved", "unresolved"}:
            problems.append(f"{label}.identity_status must be resolved or unresolved")
        canonical = _canonical_identity(raw_candidate, label, problems, project_root)
        if canonical:
            identities[candidate_id] = canonical
            for key in canonical[0]:
                owner = key_owners.get(key)
                if owner is not None:
                    problems.append(
                        f"{label} canonical identity {key!r} is already occupied by {owner!r}; merge aliases"
                    )
                else:
                    key_owners[key] = candidate_id
        disposition = _text(raw_candidate.get("disposition"))
        if disposition not in CANDIDATE_DISPOSITIONS:
            problems.append(f"{label}.disposition is invalid")
        if status == "unresolved" and disposition != "coverage_debt":
            problems.append(f"{label}: unresolved identity must remain coverage_debt")
        if not _text(raw_candidate.get("rationale")):
            problems.append(f"{label}.rationale is required")
        discovered_from = raw_candidate.get("discovered_from")
        if not isinstance(discovered_from, list) or not discovered_from:
            problems.append(f"{label}.discovered_from must record at least one discovery source")
        else:
            for discovery_index, discovery in enumerate(discovered_from):
                discovery_label = f"{label}.discovered_from[{discovery_index}]"
                if not isinstance(discovery, dict):
                    problems.append(f"{discovery_label} must be an object")
                elif (
                    _text(discovery.get("kind")) not in {"search", "bibliography", "citation"}
                    or not _text(discovery.get("source_id"))
                    or not _text(discovery.get("locator"))
                ):
                    problems.append(f"{discovery_label} requires kind, source_id, and locator")
    for selected_id in selected_ids:
        if _text(candidates_by_id.get(selected_id, {}).get("disposition")) != "core":
            problems.append(f"detailed ledger selected core candidate {selected_id!r} must have disposition='core'")
    ledger_core_ids = {
        candidate_id
        for candidate_id, record in candidates_by_id.items()
        if _text(record.get("disposition")) == "core"
    }
    if ledger_core_ids != set(selected_ids):
        problems.append("detailed ledger contains core-disposition candidate(s) absent from selected_core_ids")
    debt_candidate_ids = sorted(
        candidate_id
        for candidate_id, record in candidates_by_id.items()
        if _text(record.get("identity_status")) == "unresolved"
        or _text(record.get("disposition")) == "coverage_debt"
    )
    if ledger_status == "saturated" and debt_candidate_ids:
        problems.append(
            "detailed ledger final_status=saturated cannot retain unresolved/coverage-debt candidates: "
            + ", ".join(debt_candidate_ids)
        )

    bibliography = ledger.get("bibliography_reconciliation")
    core_sources = bibliography.get("core_sources") if isinstance(bibliography, dict) else None
    if not isinstance(core_sources, list):
        problems.append("detailed ledger bibliography_reconciliation.core_sources must be an array")
        core_sources = []
    source_statuses: dict[str, str] = {}
    bibliography_candidates: dict[str, set[str]] = {}
    for index, raw_source in enumerate(core_sources):
        label = f"detailed ledger bibliography_reconciliation.core_sources[{index}]"
        if not isinstance(raw_source, dict):
            problems.append(f"{label} must be an object")
            continue
        source_id = _text(raw_source.get("id"))
        if not source_id or source_id in source_statuses:
            problems.append(f"{label}.id is missing or duplicated")
            continue
        source_statuses[source_id] = _text(raw_source.get("status"))
        candidate_ids = raw_source.get("candidate_ids")
        if not isinstance(candidate_ids, list) or not all(_text(item) for item in candidate_ids):
            problems.append(f"{label}.candidate_ids must be an array of strings")
            candidate_ids = []
        candidate_set = {_text(item) for item in candidate_ids}
        if len(candidate_set) != len(candidate_ids):
            problems.append(f"{label}.candidate_ids must not contain duplicates")
        bibliography_candidates[source_id] = candidate_set
        unknown = sorted(candidate_set - candidates_by_id.keys())
        if unknown:
            problems.append(f"{label}.candidate_ids references unknown candidates: {', '.join(unknown)}")
        raw_manifest = _resolve_project_json(
            raw_source.get("references_artifact_ref"),
            project_root,
            f"{label}.references_artifact_ref",
            problems,
        )
        if raw_manifest is not None:
            if _text(raw_manifest.get("source_id")) != source_id:
                problems.append(f"{label}.references_artifact_ref source_id mismatch")
            references = raw_manifest.get("references")
            if not isinstance(references, list):
                problems.append(f"{label}.references_artifact_ref.references must be an array")
                references = []
            extracted = raw_source.get("references_extracted")
            if isinstance(extracted, bool) or not isinstance(extracted, int) or extracted < 0:
                problems.append(f"{label}.references_extracted must be a non-negative integer")
            elif extracted != len(references):
                problems.append(f"{label}.references_extracted does not match raw bibliography count")
            mapped: set[str] = set()
            for reference_index, reference in enumerate(references):
                reference_label = f"{label}.references_artifact_ref.references[{reference_index}]"
                if not isinstance(reference, dict):
                    problems.append(f"{reference_label} must be an object")
                    continue
                candidate_id = _text(reference.get("candidate_id"))
                if not _text(reference.get("raw_text")) or not _text(reference.get("locator")):
                    problems.append(f"{reference_label} requires raw_text and locator")
                mapped.add(candidate_id)
                if candidate_id not in candidate_set:
                    problems.append(f"{reference_label}.candidate_id is not reconciled by this source")
                    continue
                candidate = candidates_by_id.get(candidate_id, {})
                if candidate.get("identity_status") == "resolved":
                    raw_identity = reference.get("identity")
                    canonical = identities.get(candidate_id)
                    if not isinstance(raw_identity, dict) or canonical is None:
                        problems.append(f"{reference_label}.identity must bind the raw entry to its canonical candidate")
                    else:
                        if canonical_locator(raw_identity.get("canonical_id")) not in canonical[0]:
                            problems.append(f"{reference_label}.identity canonical_id mismatch")
                        if _fold(raw_identity.get("title")) != canonical[1]:
                            problems.append(f"{reference_label}.identity title mismatch")
                        if _year(raw_identity.get("year")) != canonical[2]:
                            problems.append(f"{reference_label}.identity year mismatch")
                elif _text(reference.get("identity_status")) != "unresolved" or not _text(reference.get("unresolved_reason")):
                    problems.append(f"{reference_label} must preserve unresolved identity coverage debt")
            if mapped != candidate_set:
                problems.append(f"{label}.references_artifact_ref candidate mappings do not match candidate_ids")
        debt = raw_source.get("coverage_debt")
        if not isinstance(debt, list):
            problems.append(f"{label}.coverage_debt must be an array")
            debt = []
        if source_statuses[source_id] == "reconciled" and debt:
            problems.append(f"{label} cannot be reconciled while retaining coverage debt")
        if source_statuses[source_id] not in {"reconciled", "coverage_debt"}:
            problems.append(f"{label}.status is invalid")

    if set(source_statuses) != set(selected_ids):
        problems.append("detailed ledger bibliography core set differs from selected_core_ids")
    bibliography_records = list(candidates_by_id.values())
    bibliography_expected = {
        "status": "reconciled" if (
            set(source_statuses) == set(selected_ids)
            and all(status == "reconciled" for status in source_statuses.values())
            and all(record.get("identity_status") == "resolved" for record in bibliography_records)
            and all(_text(record.get("disposition")) != "coverage_debt" for record in bibliography_records)
            and ledger_core_ids == set(selected_ids)
        ) else "coverage_debt",
        "core_sources_total": len(selected_ids),
        "core_sources_reconciled": sum(status == "reconciled" for status in source_statuses.values()),
        "candidates_total": len(candidates_by_id),
        "candidates_dispositioned": sum(
            _text(record.get("disposition")) in CANDIDATE_DISPOSITIONS for record in bibliography_records
        ),
        "unresolved_candidates": sum(record.get("identity_status") == "unresolved" for record in bibliography_records),
        "coverage_debt_candidates": sum(_text(record.get("disposition")) == "coverage_debt" for record in bibliography_records),
    }
    _compare_summary(bibliography_summary, bibliography_expected, "bibliography_reconciliation", problems)

    method = ledger.get("method_family_audit")
    taxonomy = method.get("taxonomy") if isinstance(method, dict) else None
    source_audits = method.get("source_audits") if isinstance(method, dict) else None
    if not isinstance(taxonomy, list):
        problems.append("detailed ledger method_family_audit.taxonomy must be an array")
        taxonomy = []
    families: set[str] = set()
    for index, family in enumerate(taxonomy):
        family_id = _text(family.get("id")) if isinstance(family, dict) else ""
        if not family_id or family_id in families:
            problems.append(f"detailed ledger method_family_audit.taxonomy[{index}].id is missing or duplicated")
        else:
            families.add(family_id)
    if selected_ids and not families:
        problems.append("detailed ledger method taxonomy must not be empty")
    if not isinstance(source_audits, list):
        problems.append("detailed ledger method_family_audit.source_audits must be an array")
        source_audits = []
    audited_ids: set[str] = set()
    valid_source_descriptions = 0
    method_bearing_descriptions = 0
    unresolved_gaps = 0
    method_complete = True
    for index, raw_audit in enumerate(source_audits):
        label = f"detailed ledger method_family_audit.source_audits[{index}]"
        if not isinstance(raw_audit, dict):
            problems.append(f"{label} must be an object")
            method_complete = False
            continue
        source_id = _text(raw_audit.get("source_id"))
        if not source_id or source_id in audited_ids:
            problems.append(f"{label}.source_id is missing or duplicated")
            method_complete = False
            continue
        audited_ids.add(source_id)
        paper_methods = raw_audit.get("paper_method_descriptions")
        if not isinstance(paper_methods, list) or not paper_methods:
            problems.append(f"{label}.paper_method_descriptions must contain source-text method evidence")
            paper_methods = []
            method_complete = False
        for method_index, item in enumerate(paper_methods):
            valid, debt = _validate_method_description(
                item,
                label=f"{label}.paper_method_descriptions[{method_index}]",
                families=families,
                disposition_field="disposition",
                problems=problems,
            )
            valid_source_descriptions += int(valid and not debt)
            unresolved_gaps += int(debt)
            method_complete = method_complete and valid and not debt
        screenings = raw_audit.get("bibliography_candidate_screening")
        if "cited_method_descriptions" in raw_audit or "cited_method_scan_complete" in raw_audit:
            problems.append(
                f"{label} must use per-candidate bibliography_candidate_screening, "
                "not a cited-method list or completion boolean"
            )
            method_complete = False
        if not isinstance(screenings, list):
            problems.append(f"{label}.bibliography_candidate_screening must be an array")
            screenings = []
            method_complete = False
        screened_ids: set[str] = set()
        for screening_index, screening in enumerate(screenings):
            screening_label = f"{label}.bibliography_candidate_screening[{screening_index}]"
            if not isinstance(screening, dict):
                problems.append(f"{screening_label} must be an object")
                method_complete = False
                continue
            candidate_id = _text(screening.get("candidate_id"))
            disposition = _text(screening.get("disposition"))
            if not candidate_id or candidate_id in screened_ids:
                problems.append(f"{screening_label}.candidate_id is missing or duplicated")
                method_complete = False
            else:
                screened_ids.add(candidate_id)
            if not _text(screening.get("locator")) or not _text(screening.get("evidence_basis")) or not _text(screening.get("rationale")):
                problems.append(f"{screening_label} requires locator, evidence_basis, and rationale")
                method_complete = False
            if disposition not in SCREENING_DISPOSITIONS:
                problems.append(f"{screening_label}.disposition is invalid")
                method_complete = False
            elif disposition == "method_bearing":
                valid, debt = _validate_method_description(
                    screening,
                    label=screening_label,
                    families=families,
                    disposition_field="method_disposition",
                    problems=problems,
                )
                method_bearing_descriptions += int(valid and not debt)
                unresolved_gaps += int(debt)
                method_complete = method_complete and valid and not debt
            elif disposition == "coverage_debt":
                unresolved_gaps += 1
                method_complete = False
            elif disposition == "not_method_bearing" and _text(screening.get("evidence_basis")) != "source_text":
                problems.append(
                    f"{screening_label}.evidence_basis must be 'source_text' for not_method_bearing; "
                    "title/year metadata alone is insufficient"
                )
                method_complete = False
            elif any(
                field in screening
                for field in ("description", "method_features", "family_ids", "method_disposition")
            ):
                problems.append(f"{screening_label}: only method_bearing may carry method classification fields")
                method_complete = False
        expected_screened = bibliography_candidates.get(source_id, set())
        missing = expected_screened - screened_ids
        extra = screened_ids - expected_screened
        if missing or extra:
            problems.append(f"{label}.bibliography_candidate_screening does not cover exactly the reconciled candidates")
            unresolved_gaps += len(missing)
            method_complete = False
    if audited_ids != set(selected_ids):
        problems.append("detailed ledger method audit core set differs from selected_core_ids")
        method_complete = False
    method_expected = {
        "status": "audited" if (
            method_complete
            and audited_ids == set(selected_ids)
            and bool(families or not selected_ids)
            and unresolved_gaps == 0
        ) else "coverage_debt",
        "core_sources_total": len(selected_ids),
        "core_sources_audited": len(audited_ids & set(selected_ids)),
        "taxonomy_families": len(families),
        "source_method_descriptions_audited": valid_source_descriptions,
        "cited_method_descriptions_audited": method_bearing_descriptions,
        "unresolved_method_family_gaps": unresolved_gaps,
    }
    declared_method_status = _text(method.get("status")) if isinstance(method, dict) else ""
    if declared_method_status != method_expected["status"]:
        problems.append(
            "detailed ledger method_family_audit.status does not match the status derived from its screening records"
        )
    _compare_summary(method_summary, method_expected, "method_family_audit", problems)

    citation_graph = ledger.get("citation_graph")
    seed_records = citation_graph.get("seeds") if isinstance(citation_graph, dict) else None
    graph_complete = True
    if not isinstance(seed_records, list):
        problems.append("detailed ledger citation_graph.seeds must be an array")
        seed_records = []
        graph_complete = False
    graph_ids: set[str] = set()
    for index, seed in enumerate(seed_records):
        label = f"detailed ledger citation_graph.seeds[{index}]"
        if not isinstance(seed, dict):
            problems.append(f"{label} must be an object")
            graph_complete = False
            continue
        seed_id = _text(seed.get("id"))
        if not seed_id or seed_id in graph_ids:
            problems.append(f"{label}.id is missing or duplicated")
            graph_complete = False
        else:
            graph_ids.add(seed_id)
        gaps = seed.get("gaps")
        if seed.get("references_checked") is not True or seed.get("citations_checked") is not True:
            problems.append(f"{label} must record bounded reference and citation checks")
            graph_complete = False
        if _text(seed.get("coverage_status")) != "saturated" or not isinstance(gaps, list) or gaps:
            problems.append(f"{label} must be saturated with no graph coverage gaps")
            graph_complete = False
    if graph_ids != set(selected_ids):
        problems.append("detailed ledger citation graph core set differs from selected_core_ids")
        graph_complete = False

    survey_cores = _survey_core_records(survey, problems)
    matched_ids: list[str] = []
    for index, (keys, title, year) in enumerate(survey_cores):
        matches = [candidate_id for candidate_id in selected_ids if identities.get(candidate_id) and keys & identities[candidate_id][0]]
        if len(matches) != 1:
            problems.append(
                f"literature_survey_v1 core identity set does not match detailed ledger at core paper index {index}"
            )
            continue
        match = matches[0]
        matched_ids.append(match)
        candidate_identity = identities[match]
        if title != candidate_identity[1] or year != candidate_identity[2]:
            problems.append(
                f"literature_survey_v1 core identity metadata does not match detailed ledger candidate {match!r}"
            )
    if len(matched_ids) != len(set(matched_ids)) or set(matched_ids) != set(selected_ids):
        problems.append("literature_survey_v1 core identity set differs from detailed ledger selected_core_ids")

    derived_status = "saturated" if (
        provider_complete
        and not debt_candidate_ids
        and ledger_core_ids == set(selected_ids)
        and bibliography_expected["status"] == "reconciled"
        and method_expected["status"] == "audited"
        and graph_complete
    ) else "coverage_incomplete"
    if ledger_status != derived_status:
        problems.append("detailed ledger final_status does not match recomputed coverage closure")
    saturation = _text(coverage.get("saturation"))
    if saturation == "saturated" and ledger_status != "saturated":
        problems.append("saturated survey requires detailed ledger final_status=saturated")
    if saturation == "coverage_incomplete" and ledger_status not in {"coverage_incomplete", "saturated"}:
        problems.append("coverage_incomplete survey has an invalid detailed ledger final_status")
    return problems
