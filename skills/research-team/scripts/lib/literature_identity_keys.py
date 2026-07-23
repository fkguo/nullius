"""Canonical comparison keys for domain-neutral literature identities."""

from __future__ import annotations

import re
import unicodedata
from urllib.parse import unquote, urlsplit, urlunsplit


PINNED_PROJECT_REF_RE = re.compile(
    r"^project://(?P<path>[^\s#]+)#sha256:(?P<digest>[0-9a-f]{64})$"
)
DOI_RE = re.compile(r"^10\.\d{4,9}/\S+$", re.IGNORECASE)
PROVIDER_ID_RE = re.compile(
    r"^provider:(?P<namespace>[a-z0-9][a-z0-9._-]*):(?P<record>[^\s:][^\s]*)$",
    re.IGNORECASE,
)
_PREPRINT_DOI_VERSION_RE = re.compile(r"^(10\.48550/arxiv\..+)v\d+$")


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
    return match.group(1) if match else text


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
    return urlunsplit((scheme, hostname, parsed.path or "/", parsed.query, ""))


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
