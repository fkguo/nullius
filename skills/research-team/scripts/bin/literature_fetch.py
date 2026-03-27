#!/usr/bin/env python3
# CONTRACT-EXEMPT: CODE-01.1 sunset:2026-06-01 — multi-source fetcher; split into per-source modules planned
"""
Fetch bibliographic metadata from INSPIRE-HEP and arXiv (and optionally download arXiv LaTeX sources).

Scope / safety:
- This script only talks to an allowlist of hosts:
  - inspirehep.net
  - export.arxiv.org
  - arxiv.org
  - github.com / api.github.com (GitHub repo discovery + metadata)
  - doi.org (DOI resolver; stable DOI anchors and content negotiation)
  - api.crossref.org (Crossref metadata; DOI discovery + BibTeX transform)
  - api.datacite.org (DataCite metadata; datasets/software)
- It is intended for *project leaders* during prework/KB building.
  Reviewers (Member A/B) must NOT use network; they only use the team packet.

Why this exists:
- Provide a reproducible way to populate `knowledge_base/` with metadata-rich notes.
- Generate a ready-to-paste `research_contract.md` reference entry line that satisfies the references gate.
- Act as a source-adapter / prework helper only; generic literature workflow sequencing authority lives in the checked-in `literature-workflows` recipes, session protocol, and launcher-backed consumers, not in this script.

Examples:
  # Resolve a checked-in literature workflow plan through the launcher authority
  python3 literature_fetch.py workflow-plan --recipe literature_landscape --phase prework --query "three-body force" --topic "three-body force"

  # INSPIRE search + fetch a record + write KB note
  python3 literature_fetch.py inspire-search --query "t:Faddeev AND date:2015->2026" -n 5
  python3 literature_fetch.py inspire-get --recid 2919719 --write-note
  python3 literature_fetch.py inspire-bibtex --texkey "Epelbaum:2025aan" --revtex-fix-journal

  # arXiv search + fetch a record + write KB note
  python3 literature_fetch.py arxiv-search --query "three-body Faddeev" -n 5
  python3 literature_fetch.py arxiv-get --arxiv-id 0711.1635 --write-note

  # Download arXiv LaTeX source (no parsing) into references/arxiv_src/<id>/
  # Note: for old-style ids like hep-ph/0109056, the directory is normalized to hep-ph_0109056.
  python3 literature_fetch.py arxiv-source --arxiv-id 0711.1635 --out-dir references/arxiv_src

  # GitHub repo discovery + KB note (metadata only; pin commits manually)
  python3 literature_fetch.py github-search --query "faddeev equation julia" -n 5
  python3 literature_fetch.py github-get --repo "owner/repo" --write-note

Notes:
- For GitHub API rate limits, set `GITHUB_TOKEN` in the environment.
  Do NOT pass tokens on the command line (they can leak via process listings).
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sys
import subprocess
import shutil
import tarfile
import textwrap
import tempfile
import zipfile
import gzip
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from urllib.parse import quote, urlencode, urljoin, urlsplit
import xml.etree.ElementTree as ET


def _try_load_bibtex_utils():
    """
    Optional local import for deterministic BibTeX normalizations (no network).

    Keep `literature_fetch.py` usable as a standalone script even if the skill lib isn't on sys.path.
    """
    try:
        sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "lib"))
        from bibtex_utils import normalize_revtex4_2_bibtex  # type: ignore

        return normalize_revtex4_2_bibtex
    except Exception:
        return None


_normalize_revtex4_2_bibtex = _try_load_bibtex_utils()


def _try_load_workflow_resolver():
    try:
        sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "lib"))
        from literature_workflow_plan import resolve_workflow_plan  # type: ignore

        return resolve_workflow_plan
    except Exception:
        return None


_resolve_workflow_plan = _try_load_workflow_resolver()


ALLOWED_HOSTS = {
    "inspirehep.net",
    "export.arxiv.org",
    "arxiv.org",
    "github.com",
    "raw.githubusercontent.com",
    "api.github.com",
    "doi.org",
    "api.crossref.org",
    "api.datacite.org",
}

def _validate_url(url: str) -> None:
    """
    Defense-in-depth URL validation:
    - require http(s)
    - enforce host allowlist
    """
    parts = urlsplit(url.strip())
    if parts.scheme not in ("http", "https"):
        raise ValueError(f"Invalid URL scheme: {parts.scheme!r} (url={url!r})")
    host = (parts.netloc or "").split(":", 1)[0].lower()
    if not host:
        raise ValueError(f"Invalid URL host (url={url!r})")
    if host not in ALLOWED_HOSTS:
        raise ValueError(f"Refusing URL host not in allowlist: {host} (url={url!r})")


def _curl_get(
    url: str,
    *,
    timeout_s: int = 30,
    headers: list[str] | None = None,
    max_redirects: int = 3,
) -> bytes:
    """
    Fetch a URL via curl (workaround for TLS issues in some Python builds).

    Security:
    - We do NOT use `curl --location` because it can redirect to non-allowlisted domains.
    - Instead, we follow redirects manually and validate the host at each hop.
    """
    fixtures_dir = os.environ.get("RESEARCH_TEAM_HTTP_FIXTURES", "").strip()
    if fixtures_dir:
        base = Path(fixtures_dir).expanduser().resolve()
        if not base.is_dir():
            raise RuntimeError(f"RESEARCH_TEAM_HTTP_FIXTURES is not a directory: {base}")
        index_path = base / "fixtures_index.json"
        if index_path.is_file():
            try:
                idx = json.loads(index_path.read_text(encoding="utf-8", errors="replace"))
            except Exception as exc:
                raise RuntimeError(f"failed to read fixtures_index.json: {exc}") from exc
            if not isinstance(idx, dict):
                raise RuntimeError("fixtures_index.json must be a JSON object mapping url->relative_path")
            rel = idx.get(url)
            if isinstance(rel, str) and rel.strip():
                p = (base / rel.strip()).resolve()
                try:
                    p.relative_to(base)
                except Exception:
                    raise RuntimeError(f"fixture path escapes fixtures dir: {p}")
                if not p.is_file():
                    raise RuntimeError(f"fixture missing for url (mapped): {url} -> {p}")
                return p.read_bytes()

        h = hashlib.sha256(url.encode("utf-8", errors="replace")).hexdigest()
        p = base / f"{h}.bin"
        if not p.is_file():
            raise RuntimeError(f"fixture missing for url (sha256): {url} -> {p}")
        return p.read_bytes()

    headers = headers or []
    cur = url.strip()
    for _ in range(max_redirects + 1):
        _validate_url(cur)

        # Use temp files so we can read both headers and body deterministically.
        # We don't use `--fail` because we want to inspect 3xx/4xx codes ourselves.
        hdr_text = ""
        body = b""
        with tempfile.TemporaryDirectory(prefix="research-team-curl-") as tmpd:
            hdr_path = Path(tmpd) / "headers.txt"
            body_path = Path(tmpd) / "body.bin"
            conf_path = Path(tmpd) / "curl.conf"
            try:
                cmd = [
                    "curl",
                    "-sS",
                    "--max-time",
                    str(int(timeout_s)),
                    "-D",
                    str(hdr_path),
                    "-o",
                    str(body_path),
                    "-w",
                    "%{http_code}",
                ]
                if headers:
                    # Don't put sensitive headers (e.g., GitHub tokens) on the command line.
                    # Use a per-request config file in a 0700 temp dir instead.
                    lines: list[str] = []
                    for h in headers:
                        hv = str(h).replace("\\", "\\\\").replace('"', '\\"')
                        lines.append(f'header = "{hv}"')
                    conf_path.write_text("\n".join(lines) + "\n", encoding="utf-8")
                    try:
                        os.chmod(conf_path, 0o600)
                    except Exception:
                        pass
                    cmd.extend(["--config", str(conf_path)])
                cmd.append(cur)
                code_s = subprocess.check_output(cmd).decode("utf-8", errors="replace").strip()
            except subprocess.CalledProcessError as exc:
                # Avoid leaking sensitive headers (e.g., GitHub tokens) in exception strings.
                raise RuntimeError(f"curl failed for {cur!r} (exit={exc.returncode})") from None
            hdr_text = hdr_path.read_text(encoding="utf-8", errors="replace") if hdr_path.exists() else ""
            body = body_path.read_bytes() if body_path.exists() else b""

        try:
            http_code = int(code_s)
        except Exception as exc:
            raise RuntimeError(f"unexpected curl http_code output for {cur!r}: {code_s!r}") from exc

        if 200 <= http_code < 300:
            return body
        if 300 <= http_code < 400:
            # Follow redirect if Location exists.
            loc = ""
            for ln in hdr_text.splitlines():
                if ln.lower().startswith("location:"):
                    loc = ln.split(":", 1)[1].strip()
            if not loc:
                raise RuntimeError(f"redirect without Location header: {cur!r} (code={http_code})")
            cur = urljoin(cur, loc)
            continue

        # 4xx/5xx: surface a small snippet for debugging.
        snippet = body[:200].decode("utf-8", errors="replace").replace("\n", " ")
        raise RuntimeError(f"http error {http_code} for {cur!r}: {snippet!r}")

    raise RuntimeError(f"too many redirects (>{max_redirects}) for url: {url!r}")


def _crossref_user_agent(mailto: str | None) -> str:
    # Crossref prefers a UA string with a contact email ("polite pool").
    base = "research-team/literature_fetch"
    m = (mailto or "").strip()
    if m:
        return f"{base} (mailto:{m})"
    return base


def _crossref_headers(mailto: str | None) -> list[str]:
    return [
        f"User-Agent: {_crossref_user_agent(mailto)}",
        "Accept: application/json",
    ]


def _extract_crossref_year(item: dict[str, Any]) -> str:
    for key in ("issued", "published-print", "published-online", "published"):
        blk = item.get(key)
        if not isinstance(blk, dict):
            continue
        dp = blk.get("date-parts")
        if not isinstance(dp, list) or not dp:
            continue
        first = dp[0]
        if not isinstance(first, list) or not first:
            continue
        y = first[0]
        if isinstance(y, int) and 1900 <= y <= 2100:
            return str(y)
        if isinstance(y, str) and y.isdigit():
            return y
    return ""


def _format_crossref_first_author(item: dict[str, Any]) -> str:
    authors = item.get("author")
    if not isinstance(authors, list) or not authors:
        return "Unknown"
    a0 = authors[0] if isinstance(authors[0], dict) else {}
    given = str(a0.get("given") or "").strip()
    family = str(a0.get("family") or "").strip()
    if family:
        ini = _format_initials(given)
        first = f"{ini} {family}".strip()
    else:
        first = (given or family or "Unknown").strip()
    return first if len(authors) == 1 else f"{first} et al."


def _format_crossref_publication(item: dict[str, Any], year: str) -> str:
    container = item.get("container-title")
    journal = ""
    if isinstance(container, list) and container and isinstance(container[0], str):
        journal = container[0].strip()
    vol = str(item.get("volume") or "").strip()
    issue = str(item.get("issue") or "").strip()
    page = str(item.get("page") or "").strip()
    parts: list[str] = []
    if journal:
        parts.append(journal)
    if vol:
        parts.append(vol)
    if year:
        parts.append(f"({year})")
    if issue:
        parts.append(f"no.{issue}")
    if page:
        parts.append(page)
    return " ".join([p for p in parts if p]).strip() or "Unpublished"


def crossref_search(*, query: str, max_results: int, mailto: str | None) -> list[dict[str, Any]]:
    params = urlencode(
        {
            "query.bibliographic": query,
            "rows": int(max_results),
        }
    )
    url = f"https://api.crossref.org/works?{params}"
    data = json.loads(_curl_get(url, headers=_crossref_headers(mailto)).decode("utf-8", errors="replace"))
    msg = data.get("message", {})
    items = msg.get("items", []) if isinstance(msg, dict) else []
    out: list[dict[str, Any]] = []
    for it in items:
        if not isinstance(it, dict):
            continue
        doi = str(it.get("DOI") or "").strip()
        title = ""
        titles = it.get("title")
        if isinstance(titles, list) and titles and isinstance(titles[0], str):
            title = titles[0].strip()
        year = _extract_crossref_year(it)
        authors = _format_crossref_first_author(it)
        publication = _format_crossref_publication(it, year)
        out.append(
            {
                "refkey": _slugify_refkey(f"doi-{doi}") if doi else "unknown",
                "title": title or "Untitled",
                "authors": authors,
                "publication": publication,
                "year": year,
                "doi": doi,
                "score": it.get("score"),
                "type": str(it.get("type") or "").strip(),
            }
        )
    return out


def crossref_get(*, doi: str, mailto: str | None) -> dict[str, Any]:
    doi = str(doi).strip()
    if not doi:
        raise ValueError("missing DOI")
    doi_path = quote(doi, safe="")
    url = f"https://api.crossref.org/works/{doi_path}"
    data = json.loads(_curl_get(url, headers=_crossref_headers(mailto)).decode("utf-8", errors="replace"))
    msg = data.get("message", {})
    if not isinstance(msg, dict):
        raise RuntimeError("unexpected Crossref response shape")
    doi_norm = str(msg.get("DOI") or doi).strip()
    titles = msg.get("title")
    title = titles[0].strip() if isinstance(titles, list) and titles and isinstance(titles[0], str) else ""
    year = _extract_crossref_year(msg)
    authors = _format_crossref_first_author(msg)
    publication = _format_crossref_publication(msg, year)
    return {
        "refkey": _slugify_refkey(f"doi-{doi_norm}"),
        "title": title or "Untitled",
        "authors": authors,
        "publication": publication,
        "year": year,
        "doi": doi_norm,
    }


def doi_bibtex(*, doi: str, mailto: str | None) -> str:
    doi = str(doi).strip()
    if not doi:
        raise ValueError("missing DOI")
    url = f"https://doi.org/{doi}"
    headers = [
        "Accept: application/x-bibtex",
        f"User-Agent: {_crossref_user_agent(mailto)}",
    ]
    body = _curl_get(url, headers=headers, timeout_s=30, max_redirects=5)
    return body.decode("utf-8", errors="replace").strip()


def _datacite_headers() -> list[str]:
    return [
        "User-Agent: research-team/literature_fetch",
        "Accept: application/json",
    ]


def _datacite_parse_item(item: dict[str, Any]) -> dict[str, Any]:
    attrs = item.get("attributes") if isinstance(item.get("attributes"), dict) else {}
    doi = str(attrs.get("doi") or item.get("id") or "").strip()
    doi_norm = doi.lower()

    titles = attrs.get("titles") if isinstance(attrs.get("titles"), list) else []
    title = ""
    for t in titles:
        if isinstance(t, dict) and str(t.get("title") or "").strip():
            title = str(t.get("title") or "").strip()
            break
    title = " ".join(title.split()) or "Untitled"

    creators = attrs.get("creators") if isinstance(attrs.get("creators"), list) else []
    names: list[str] = []
    for c in creators:
        if not isinstance(c, dict):
            continue
        nm = str(c.get("name") or "").strip()
        if nm:
            names.append(nm)
            continue
        gn = str(c.get("givenName") or "").strip()
        fn = str(c.get("familyName") or "").strip()
        full = " ".join([x for x in (gn, fn) if x]).strip()
        if full:
            names.append(full)
    authors_str = "Unknown"
    if names:
        authors_str = names[0] if len(names) == 1 else f"{names[0]} et al."

    year = str(attrs.get("publicationYear") or "").strip()
    types = attrs.get("types") if isinstance(attrs.get("types"), dict) else {}
    rtype = str(types.get("resourceTypeGeneral") or "").strip()
    publisher = str(attrs.get("publisher") or "").strip()

    pub_bits: list[str] = []
    if publisher:
        pub_bits.append(publisher)
    elif rtype:
        pub_bits.append(rtype)
    else:
        pub_bits.append("DataCite")
    if year:
        pub_bits.append(f"({year})")
    publication = " ".join(pub_bits).strip()

    return {
        "refkey": _slugify_refkey(f"doi-{doi_norm}") if doi_norm else "unknown",
        "title": title,
        "authors": authors_str,
        "publication": publication,
        "year": year,
        "doi": doi_norm,
        "source": "DataCite",
    }


def datacite_search(query: str, max_results: int) -> list[dict[str, Any]]:
    q = str(query or "").strip()
    if not q:
        return []
    # DataCite API uses JSON:API filters; keep this minimal and deterministic.
    params = urlencode({"query": q, "page[size]": int(max_results)})
    url = f"https://api.datacite.org/dois?{params}"
    body = _curl_get(url, headers=_datacite_headers(), timeout_s=30, max_redirects=3)
    data = json.loads(body.decode("utf-8", errors="replace"))
    items = data.get("data") if isinstance(data, dict) else []
    out: list[dict[str, Any]] = []
    if isinstance(items, list):
        for it in items:
            if isinstance(it, dict):
                out.append(_datacite_parse_item(it))
    return out


def datacite_get(*, doi: str) -> dict[str, Any]:
    doi_s = str(doi or "").strip()
    if not doi_s:
        raise ValueError("missing doi")
    doi_path = quote(doi_s, safe="")
    url = f"https://api.datacite.org/dois/{doi_path}"
    body = _curl_get(url, headers=_datacite_headers(), timeout_s=30, max_redirects=3)
    data = json.loads(body.decode("utf-8", errors="replace"))
    item = data.get("data") if isinstance(data, dict) else None
    if not isinstance(item, dict):
        raise RuntimeError("unexpected DataCite response shape")
    return _datacite_parse_item(item)


def _stub_record(*, refkey: str, title_hint: str, external_url: str, error: str) -> dict[str, Any]:
    # Keep stubs deterministic + gate-friendly. Avoid fancy quotes (can cause mojibake in some environments).
    ymd = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    title = str(title_hint or "").strip() or "Untitled"
    return {
        "refkey": _slugify_refkey(refkey),
        "title": title,
        "authors": "UNKNOWN",
        "publication": f"Retrieved: {ymd} (metadata pending; fetch failed)",
        "year": "",
        "fetch_error": str(error or "").strip(),
        "external_url": str(external_url or "").strip(),
    }


def _ensure_author_attribution_for_entry(authors: str) -> str:
    s = str(authors or "").strip()
    if not s:
        return "Authors: UNKNOWN"
    if re.search(r"\bet\s+al\.?\b", s, flags=re.IGNORECASE):
        return s
    if re.search(r"\bAuthors?\s*:", s, flags=re.IGNORECASE):
        return s
    if re.search(r"\bMaintainer\s*:", s, flags=re.IGNORECASE):
        return s
    if re.search(r"\b[A-Z]\.(?:-[A-Z]\.)*\s*(?:[A-Z]\.\s*)*[A-Z][A-Za-z-]{2,}\b", s):
        return s
    if re.search(r"\b[A-Z][A-Za-z-]{2,}\s+et\s+al\.?\b", s, flags=re.IGNORECASE):
        return s
    return f"Authors: {s}"


def inspire_bibtex(*, recid: str | None = None, texkey: str | None = None) -> str:
    """
    Fetch BibTeX from INSPIRE by either:
    - record id (recid / control_number), or
    - texkey/citekey (INSPIRE texkey).
    """
    recid_s = str(recid or "").strip()
    texkey_s = str(texkey or "").strip()
    if not recid_s and not texkey_s:
        raise ValueError("missing recid/texkey")

    if recid_s:
        url = f"https://inspirehep.net/api/literature/{recid_s}?format=bibtex"
    else:
        params = urlencode({"q": f"texkey:{texkey_s}", "size": 1, "format": "bibtex"})
        url = f"https://inspirehep.net/api/literature?{params}"
    body = _curl_get(url, timeout_s=30, max_redirects=3)
    return body.decode("utf-8", errors="replace").strip()


DEFAULT_TRACE_PATH = "knowledge_base/methodology_traces/literature_queries.md"

def _infer_project_root_from_kb_dir(kb_dir: Path) -> Path | None:
    """
    Best-effort inference of project root given a KB directory.

    Typical KB layout:
      <project_root>/knowledge_base/{literature,priors,methodology_traces}/...
    """
    try:
        p = kb_dir.expanduser().resolve()
    except Exception:
        p = kb_dir
    cur = p
    for _ in range(30):
        if cur.name == "knowledge_base":
            return cur.parent
        if cur.parent == cur:
            break
        cur = cur.parent
    return None


def _resolve_trace_path(trace_path: Path, kb_dir: Path | None) -> Path:
    """
    Resolve trace_path robustly when callers pass an absolute --kb-dir but keep trace-path relative.

    Real-world failure mode:
    - user runs `literature_fetch.py ... --kb-dir /abs/project/knowledge_base/literature`
    - forgets `--trace-path`
    - trace row is appended to ./knowledge_base/... in the *current working directory*

    Policy:
    - If trace_path is absolute: use it.
    - If kb_dir is absolute and a project root can be inferred: interpret relative trace_path as relative to that root.
    - Else: keep it relative to CWD (back-compat).
    """
    tp = trace_path
    if tp.is_absolute():
        return tp
    if kb_dir is not None:
        try:
            kb_abs = kb_dir.expanduser().resolve()
        except Exception:
            kb_abs = kb_dir
        if kb_abs.is_absolute():
            root = _infer_project_root_from_kb_dir(kb_abs)
            if root is not None:
                return root / tp
            # Fallback heuristic: assume kb_dir is <root>/knowledge_base/<kind>
            try:
                return kb_abs.parent.parent / tp
            except Exception:
                return kb_abs / tp
    return tp


def _default_trace_template_text() -> str:
    # Prefer the skill template if available (keeps wording consistent with scaffold).
    try:
        skill_root = Path(__file__).resolve().parents[2]
        template = skill_root / "assets" / "literature_queries_template.md"
        if template.is_file():
            return template.read_text(encoding="utf-8", errors="replace").rstrip() + "\n"
    except Exception:
        pass
    return (
        "# literature_queries.md\n"
        "\n"
        "Purpose: append-only log of literature/code searches and selection decisions.\n"
        "\n"
        "## Log\n"
        "\n"
        "| Timestamp (UTC) | Source | Query | Filters / criteria | Shortlist (links) | Decision / notes | Local KB notes |\n"
        "|---|---|---|---|---|---|---|\n"
        "|  |  |  |  |  |  |  |\n"
    )


def _md_table_cell(text: str) -> str:
    s = str(text or "")
    s = s.replace("\r\n", "\n").replace("\r", "\n")
    s = s.replace("|", "\\|")
    s = s.replace("\n", "<br/>")
    return s.strip()


def _ensure_trace_file(trace_path: Path) -> None:
    if trace_path.exists():
        return
    trace_path.parent.mkdir(parents=True, exist_ok=True)
    trace_path.write_text(_default_trace_template_text(), encoding="utf-8")


def _append_trace_row(
    *,
    trace_path: Path,
    source: str,
    query: str,
    filters: str,
    shortlist: str,
    decision: str,
    kb_notes: str,
) -> None:
    _ensure_trace_file(trace_path)
    ts = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    row = (
        "| "
        + " | ".join(
            [
                _md_table_cell(ts),
                _md_table_cell(source),
                _md_table_cell(query),
                _md_table_cell(filters),
                _md_table_cell(shortlist),
                _md_table_cell(decision),
                _md_table_cell(kb_notes),
            ]
        )
        + " |\n"
    )
    # Append-only: never rewrite history.
    with trace_path.open("a", encoding="utf-8") as f:
        f.write(row)


def _slugify_refkey(s: str) -> str:
    # Keep refkeys stable, ASCII, and anchor-safe.
    out = re.sub(r"[^A-Za-z0-9_.:-]+", "-", s.strip())
    out = re.sub(r"-{2,}", "-", out).strip("-")
    return out or "unknown"

def _sanitize_path_component(s: str) -> str:
    """
    Sanitize a single filesystem path component (no slashes).
    Keep it readable and stable; this is used for folder names / filenames.
    """
    s = str(s or "").strip()
    s = s.replace("/", "_")
    s = re.sub(r"[^A-Za-z0-9_.:-]+", "_", s)
    s = re.sub(r"_{2,}", "_", s).strip("_")
    return s or "unknown"


def _arxiv_id_dirname(arxiv_id: str) -> str:
    """
    Map arXiv ids to a stable directory name:
    - new-style: 0711.1635 -> 0711.1635
    - old-style: hep-ph/0109056 -> hep-ph_0109056
    """
    arxiv_id = re.sub(r"v\d+$", "", str(arxiv_id).strip())
    return _sanitize_path_component(arxiv_id)


def _format_initials(first_name: str) -> str:
    # "Feng-Kun" -> "F.-K.", "W. N." stays "W. N."-ish.
    first_name = (first_name or "").strip()
    if not first_name:
        return ""
    parts = re.split(r"\s+", first_name)
    initials_parts: list[str] = []
    for part in parts:
        if not part:
            continue
        hy = part.split("-")
        hy_inits = []
        for h in hy:
            h = h.strip()
            if not h:
                continue
            hy_inits.append(h[0].upper() + ".")
        if hy_inits:
            initials_parts.append("-".join(hy_inits))
    return " ".join(initials_parts).strip()


def _format_first_author(author: dict[str, Any]) -> str:
    last = str(author.get("last_name") or "").strip()
    first = str(author.get("first_name") or "").strip()
    if last:
        ini = _format_initials(first)
        return f"{ini} {last}".strip()
    full = str(author.get("full_name") or "").strip()
    if "," in full:
        a, b = full.split(",", 1)
        last = a.strip()
        ini = _format_initials(b.strip())
        return f"{ini} {last}".strip()
    return full or "Unknown"


def _extract_year_from_meta(meta: dict[str, Any]) -> str:
    for k in ("preprint_date", "earliest_date", "legacy_creation_date", "date"):
        v = str(meta.get(k) or "").strip()
        m = re.search(r"(19|20)\d{2}", v)
        if m:
            return m.group(0)
    return ""


def _format_publication(meta: dict[str, Any]) -> tuple[str, str]:
    """
    Returns (publication_str, year_str).
    """
    pub_info = meta.get("publication_info") or []
    if isinstance(pub_info, list) and pub_info:
        p0 = pub_info[0] if isinstance(pub_info[0], dict) else {}
        journal = str(p0.get("journal_title") or "").strip()
        vol = str(p0.get("journal_volume") or "").strip()
        year = str(p0.get("year") or "").strip()
        art = str(p0.get("artid") or "").strip() or str(p0.get("page_start") or "").strip()
        parts = [x for x in (journal, vol, f"({year})" if year else "", art) if x]
        out = " ".join(parts).strip()
        return out or "Unpublished", year
    year = _extract_year_from_meta(meta)
    return ("Unpublished", year)


def _inspire_parse_record(meta: dict[str, Any]) -> dict[str, Any]:
    recid = meta.get("control_number")
    recid_s = str(recid).strip() if recid is not None else ""
    titles = meta.get("titles") or []
    title = ""
    if isinstance(titles, list) and titles and isinstance(titles[0], dict):
        title = str(titles[0].get("title") or "").strip()
    title = title or "Untitled"

    authors = meta.get("authors") or []
    authors_str = "Unknown"
    if isinstance(authors, list) and authors:
        first = _format_first_author(authors[0] if isinstance(authors[0], dict) else {})
        authors_str = first if len(authors) == 1 else f"{first} et al."

    texkeys = meta.get("texkeys") or []
    citekey = ""
    if isinstance(texkeys, list) and texkeys:
        citekey = str(texkeys[0]).strip()
    citekey = citekey or (f"recid-{recid_s}" if recid_s else "unknown")

    publication, year = _format_publication(meta)

    arxiv_eprints = meta.get("arxiv_eprints") or []
    arxiv_id = ""
    if isinstance(arxiv_eprints, list) and arxiv_eprints and isinstance(arxiv_eprints[0], dict):
        arxiv_id = str(arxiv_eprints[0].get("value") or "").strip()

    dois = meta.get("dois") or []
    doi = ""
    if isinstance(dois, list) and dois and isinstance(dois[0], dict):
        doi = str(dois[0].get("value") or "").strip()

    return {
        "refkey": f"recid-{recid_s}" if recid_s else _slugify_refkey(citekey),
        "recid": recid_s,
        "citekey": citekey,
        "title": title,
        "authors": authors_str,
        "publication": publication,
        "year": year,
        "arxiv_id": arxiv_id,
        "doi": doi,
        "inspire_url": f"https://inspirehep.net/literature/{recid_s}" if recid_s else "",
    }


def inspire_search(query: str, max_results: int) -> list[dict[str, Any]]:
    params = urlencode(
        {
            "q": query,
            "size": int(max_results),
            "fields": "control_number,titles,authors,publication_info,arxiv_eprints,dois,texkeys,preprint_date,earliest_date,legacy_creation_date",
        }
    )
    url = f"https://inspirehep.net/api/literature?{params}"
    data = json.loads(_curl_get(url).decode("utf-8", errors="replace"))
    hits = data.get("hits", {}).get("hits", [])
    out: list[dict[str, Any]] = []
    for h in hits:
        if not isinstance(h, dict):
            continue
        meta = h.get("metadata", {})
        if not isinstance(meta, dict):
            continue
        out.append(_inspire_parse_record(meta))
    return out


def inspire_get(recid: str) -> dict[str, Any]:
    recid = str(recid).strip()
    url = f"https://inspirehep.net/api/literature/{recid}"
    data = json.loads(_curl_get(url).decode("utf-8", errors="replace"))
    meta = data.get("metadata", {})
    if not isinstance(meta, dict):
        meta = {}
    return _inspire_parse_record(meta)


ARXIV_NS = {"atom": "http://www.w3.org/2005/Atom", "arxiv": "http://arxiv.org/schemas/atom"}


def _arxiv_parse_entry(entry: ET.Element) -> dict[str, Any]:
    def _text(tag: str) -> str:
        el = entry.find(f"atom:{tag}", ARXIV_NS)
        return el.text.strip() if el is not None and el.text else ""

    id_url = _text("id")
    arxiv_id = id_url.split("/abs/")[-1].strip()
    arxiv_id_clean = re.sub(r"v\d+$", "", arxiv_id)

    title = " ".join(_text("title").split()) or "Untitled"

    authors = []
    for a in entry.findall("atom:author", ARXIV_NS):
        nm = a.find("atom:name", ARXIV_NS)
        if nm is not None and nm.text:
            authors.append(nm.text.strip())
    authors_str = "Unknown"
    if authors:
        authors_str = authors[0] if len(authors) == 1 else f"{authors[0]} et al."

    published = _text("published")
    year = published[:4] if re.match(r"^(19|20)\d{2}-", published) else ""

    doi_el = entry.find("arxiv:doi", ARXIV_NS)
    doi = doi_el.text.strip() if doi_el is not None and doi_el.text else ""

    return {
        "refkey": _slugify_refkey(f"arxiv-{arxiv_id_clean}"),
        "arxiv_id": arxiv_id_clean,
        "title": title,
        "authors": authors_str,
        "publication": f"arXiv:{arxiv_id_clean} ({year})" if year else f"arXiv:{arxiv_id_clean}",
        "year": year,
        "doi": doi,
        "arxiv_url": f"https://arxiv.org/abs/{arxiv_id_clean}",
    }


def arxiv_search(query: str, max_results: int) -> list[dict[str, Any]]:
    params = urlencode({"search_query": f"all:{query}", "start": 0, "max_results": int(max_results)})
    url = f"https://export.arxiv.org/api/query?{params}"
    xml_text = _curl_get(url).decode("utf-8", errors="replace")
    root = ET.fromstring(xml_text)
    out: list[dict[str, Any]] = []
    for entry in root.findall("atom:entry", ARXIV_NS):
        out.append(_arxiv_parse_entry(entry))
    return out


def arxiv_get(arxiv_id: str) -> dict[str, Any]:
    arxiv_id = re.sub(r"v\d+$", "", str(arxiv_id).strip())
    params = urlencode({"id_list": arxiv_id})
    url = f"https://export.arxiv.org/api/query?{params}"
    xml_text = _curl_get(url).decode("utf-8", errors="replace")
    root = ET.fromstring(xml_text)
    entry = root.find("atom:entry", ARXIV_NS)
    if entry is None:
        raise ValueError(f"arXiv id not found: {arxiv_id}")
    return _arxiv_parse_entry(entry)


def arxiv_source(arxiv_id: str, out_dir: Path) -> Path:
    """
    Download arXiv LaTeX source tarball and extract it (no parsing).
    Returns the directory that contains extracted files.
    """
    arxiv_id = re.sub(r"v\d+$", "", str(arxiv_id).strip())
    out_dir = out_dir.resolve()
    out_dir.mkdir(parents=True, exist_ok=True)
    tar_path = out_dir / f"arXiv-{_sanitize_path_component(arxiv_id)}.tar.gz"
    url = f"https://arxiv.org/e-print/{arxiv_id}"
    tar_path.write_bytes(_curl_get(url, timeout_s=120))
    # Extract best-effort:
    # - tar/tar.gz (most common)
    # - zip (rare)
    # - single gzipped .tex (common for short submissions)
    extracted_dir = out_dir / "src"
    extracted_dir.mkdir(parents=True, exist_ok=True)
    try:
        with tarfile.open(tar_path, "r:*") as tf:
            # Avoid path traversal.
            for m in tf.getmembers():
                if m.name.startswith("/") or ".." in Path(m.name).parts:
                    continue
                # Avoid symlink/hardlink surprises (defense-in-depth).
                if m.issym() or m.islnk():
                    continue
                tf.extract(m, path=str(extracted_dir))
    except tarfile.ReadError:
        # Not a tarball.
        extracted = False
        try:
            with zipfile.ZipFile(tar_path) as zf:
                for info in zf.infolist():
                    name = info.filename
                    if name.startswith("/") or ".." in Path(name).parts:
                        continue
                    zf.extract(info, path=str(extracted_dir))
                extracted = True
        except Exception:
            extracted = False

        if not extracted:
            # Try "single gzipped file" fallback: write the decompressed bytes into src/source.tex.
            try:
                out_path = extracted_dir / "source.tex"
                with gzip.open(tar_path, "rb") as gz, out_path.open("wb") as f:
                    shutil.copyfileobj(gz, f)
                extracted = True
            except Exception:
                extracted = False

        if not extracted:
            # Final fallback: keep the raw download only; user can inspect manually.
            pass
    return extracted_dir


def _github_headers(token: str | None) -> list[str]:
    headers = [
        "Accept: application/vnd.github+json",
        "X-GitHub-Api-Version: 2022-11-28",
        "User-Agent: research-team-literature-fetch/1.0",
    ]
    if token:
        headers.append(f"Authorization: Bearer {token}")
    return headers


def _parse_github_repo_arg(repo: str) -> str:
    repo = str(repo or "").strip()
    if repo.startswith("https://github.com/") or repo.startswith("http://github.com/"):
        path = urlsplit(repo).path.strip("/")
        parts = [p for p in path.split("/") if p]
        if len(parts) >= 2:
            owner = parts[0]
            name = parts[1]
            if name.endswith(".git"):
                name = name[: -len(".git")]
            return f"{owner}/{name}"
    return repo


def _github_parse_repo(meta: dict[str, Any]) -> dict[str, Any]:
    full_name = str(meta.get("full_name") or "").strip()
    html_url = str(meta.get("html_url") or "").strip()
    desc = str(meta.get("description") or "").strip()
    stars = int(meta.get("stargazers_count") or 0)
    updated_at = str(meta.get("updated_at") or "").strip()
    created_at = str(meta.get("created_at") or "").strip()
    default_branch = str(meta.get("default_branch") or "").strip()

    lic = meta.get("license")
    lic_id = ""
    if isinstance(lic, dict):
        lic_id = str(lic.get("spdx_id") or lic.get("key") or "").strip()
    year = (updated_at or created_at)[:4] if re.match(r"^(19|20)\d{2}-", (updated_at or created_at)) else ""

    # Use a stable, anchor-safe refkey (no slashes).
    owner, name = ("", "")
    if "/" in full_name:
        owner, name = full_name.split("/", 1)
    refkey = _slugify_refkey(f"gh-{owner}__{name}" if owner and name else f"gh-{full_name}")

    title = desc or full_name or "GitHub repository"
    pub = f"GitHub repo{f' ({year})' if year else ''}; stars={stars}; license={lic_id or 'unknown'}; branch={default_branch or 'unknown'}"

    return {
        "refkey": refkey,
        "repo": full_name,
        "title": title,
        "authors": f"Maintainer: {full_name}" if full_name else "Maintainer: unknown",
        "publication": pub,
        "year": year,
        "github_url": html_url,
        "stars": stars,
        "license": lic_id,
        "updated_at": updated_at,
        "default_branch": default_branch,
    }


def github_search(query: str, max_results: int, *, token: str | None) -> list[dict[str, Any]]:
    # GitHub search API: use repo search (code search often requires auth and has stricter limits).
    params = urlencode({"q": query, "per_page": int(max_results), "sort": "stars", "order": "desc"})
    url = f"https://api.github.com/search/repositories?{params}"
    data = json.loads(_curl_get(url, headers=_github_headers(token), timeout_s=30).decode("utf-8", errors="replace"))
    items = data.get("items") or []
    out: list[dict[str, Any]] = []
    if isinstance(items, list):
        for it in items:
            if isinstance(it, dict):
                out.append(_github_parse_repo(it))
    return out


def github_get(repo: str, *, token: str | None) -> dict[str, Any]:
    repo = _parse_github_repo_arg(repo)
    if not re.match(r"^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$", repo):
        raise ValueError(f"invalid GitHub repo: {repo!r} (expected 'owner/name' or a GitHub URL)")
    url = f"https://api.github.com/repos/{repo}"
    data = json.loads(_curl_get(url, headers=_github_headers(token), timeout_s=30).decode("utf-8", errors="replace"))
    if not isinstance(data, dict):
        data = {}
    return _github_parse_repo(data)


def _kb_trace_template_github(rec: dict[str, Any], kb_note_path: str) -> str:
    lines: list[str] = []
    repo = rec.get("repo") or "unknown/unknown"
    lines.append(f"# Methodology trace: {repo} (GitHub)")
    lines.append("")
    lines.append(f"RefKey: {rec.get('refkey','unknown')}")
    lines.append(f"Maintainer: {repo}")
    lines.append(f"Publication: {rec.get('publication','')}")
    lines.append(f"Retrieved: {datetime.now(timezone.utc).isoformat()}")
    lines.append("")
    lines.append("Links:")
    if rec.get("github_url"):
        lines.append(f"- GitHub: {rec.get('github_url')}")
    else:
        lines.append("- Link: none")
    lines.append("")
    lines.append("## Relevance to this project")
    lines.append("")
    lines.append("<!-- Why this repo is useful (algorithms, reference implementation, test cases). -->")
    lines.append("")
    lines.append("## Pinning / reproducibility")
    lines.append("")
    lines.append("<!-- Record a pinned commit/tag and how it was obtained (e.g., git clone + rev-parse). -->")
    lines.append("")
    lines.append("## Key files / algorithms to audit")
    lines.append("")
    lines.append("<!-- List the specific functions/files to trust but verify; include paths and what they implement. -->")
    lines.append("")
    lines.append("## Notes / Issues")
    lines.append("")
    lines.append("<!-- Suspected bugs, numerical stability notes, license constraints, API mismatches. -->")
    lines.append("")
    lines.append(f"(KB note path: {kb_note_path})")
    lines.append("")
    return "\n".join(lines)


def _kb_note_template(rec: dict[str, Any], kb_note_path: str) -> str:
    # Metadata header is line-based (easy for gates and humans).
    lines: list[str] = []
    lines.append(f"# KB note: {rec.get('title','Untitled')}")
    lines.append("")
    lines.append(f"RefKey: {rec.get('refkey','unknown')}")
    if rec.get("recid"):
        lines.append(f"INSPIRE recid: {rec.get('recid')}")
        lines.append(f"Citekey: {rec.get('citekey','')}")
    if rec.get("arxiv_id"):
        lines.append(f"arXiv: {rec.get('arxiv_id')}")
    if rec.get("doi"):
        lines.append(f"DOI: {rec.get('doi')}")
    lines.append(f"Authors: {rec.get('authors','')}")
    lines.append(f"Publication: {rec.get('publication','')}")
    lines.append(f"Retrieved: {datetime.now(timezone.utc).isoformat()}")
    if rec.get("fetch_error"):
        lines.append(f"Fetch error: {rec.get('fetch_error')}")
    lines.append("")
    links: list[str] = []
    if rec.get("inspire_url"):
        links.append(f"- INSPIRE: {rec.get('inspire_url')}")
    if rec.get("arxiv_url"):
        links.append(f"- arXiv: {rec.get('arxiv_url')}")
    if rec.get("arxiv_id") and not rec.get("arxiv_url"):
        links.append(f"- arXiv: https://arxiv.org/abs/{rec.get('arxiv_id')}")
    if rec.get("doi"):
        links.append(f"- DOI: https://doi.org/{rec.get('doi')}")
    ext = str(rec.get("external_url") or "").strip()
    if ext and not any(ext in x for x in links):
        links.append(f"- Link: {ext}")
    lines.append("Links:")
    lines.extend(links or ["- Link: none"])
    lines.append("")
    lines.append("## Summary")
    lines.append("")
    lines.append("<!-- Summarize the key result(s) and relevance to this project. -->")
    lines.append("")
    lines.append("## Key equations / definitions (copy from source)")
    lines.append("")
    lines.append(
        "<!-- Copy equations into Markdown display math (use fenced display-math blocks). Do NOT split one equation into back-to-back display blocks. "
        "Inside display math, no line may start with + / - / = (prefix with \\\\quad). "
        "Note normalization conventions and any typos you fixed. -->"
    )
    lines.append("")
    lines.append("## Notes / Issues")
    lines.append("")
    lines.append("<!-- Record suspected typos, normalization mismatches, assumptions, and cross-links to our derivation sections. -->")
    lines.append("")
    lines.append(f"(KB note path: {kb_note_path})")
    lines.append("")
    return "\n".join(lines)


def _format_reference_entry(rec: dict[str, Any], kb_note_rel: str) -> str:
    key = rec.get("refkey", "unknown")
    authors = _ensure_author_attribution_for_entry(str(rec.get("authors", "Unknown")))
    title = rec.get("title", "Untitled")
    publication = rec.get("publication", "").strip()
    links: list[str] = []
    if rec.get("inspire_url"):
        links.append(f"[INSPIRE]({rec.get('inspire_url')})")
    if rec.get("arxiv_id"):
        links.append(f"[arXiv](https://arxiv.org/abs/{rec.get('arxiv_id')})")
    if rec.get("github_url"):
        links.append(f"[GitHub]({rec.get('github_url')})")
    if rec.get("doi"):
        links.append(f"[DOI](https://doi.org/{rec.get('doi')})")
    ext = str(rec.get("external_url") or "").strip()
    if ext:
        links.append(f"[Link]({ext})")
    links.append(f"[KB note]({kb_note_rel})")
    links_s = " | ".join(links) if links else "Link: none"
    pub_s = f", {publication}." if publication else "."
    return f'<a id="ref-{key}"></a>**[@{key}]** {authors}, "{title}"{pub_s} {links_s}'


def _relpath_posix(target: Path, base_dir: Path) -> str:
    """
    Deterministic path rewrite for Markdown links:
    - Compute a relative path from base_dir to target.
    - Normalize to POSIX separators for Markdown portability.
    """
    try:
        rel = os.path.relpath(str(target.resolve()), str(base_dir.resolve()))
    except Exception:
        rel = str(target)
    return rel.replace("\\", "/")


def _write_text(path: Path, content: str, force: bool) -> None:
    if path.exists() and not force:
        raise SystemExit(f"[skip] exists (use --force to overwrite): {path}")
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")
    print(f"[ok] wrote: {path}")


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    sub = ap.add_subparsers(dest="cmd", required=True)

    p = sub.add_parser("inspire-search", help="Search INSPIRE-HEP.")
    p.add_argument("--query", "-q", required=True)
    p.add_argument("-n", "--max-results", type=int, default=10)
    p.add_argument("--json", action="store_true")
    p.add_argument("--write-trace", action="store_true", help="Append a row to the literature query trace log.")
    p.add_argument("--trace-path", default=DEFAULT_TRACE_PATH)

    p = sub.add_parser("inspire-get", help="Fetch INSPIRE record by recid.")
    p.add_argument("--recid", "-r", required=True)
    p.add_argument("--write-note", action="store_true")
    p.add_argument("--kb-dir", default="knowledge_base/literature")
    p.add_argument("--force", action="store_true")
    p.add_argument("--allow-stub", action="store_true", help="If fetch fails, write a stub KB note + reference entry.")
    p.add_argument("--no-trace", action="store_true", help="Do not append to literature query trace log.")
    p.add_argument("--trace-note", default="", help="Optional note for the trace row (Decision/notes column).")
    p.add_argument("--trace-path", default=DEFAULT_TRACE_PATH)

    p = sub.add_parser("inspire-bibtex", help="Fetch BibTeX from INSPIRE (by recid or texkey).")
    g = p.add_mutually_exclusive_group(required=True)
    g.add_argument("--recid", "-r", default="", help="INSPIRE record id (control_number).")
    g.add_argument("--texkey", "-k", default="", help="INSPIRE texkey/citekey (e.g. Epelbaum:2025aan).")
    p.add_argument("--out", default="", help="Optional output .bib file. If omitted, prints to stdout.")
    p.add_argument("--append", action="store_true", help="Append to --out instead of overwriting.")
    p.add_argument(
        "--revtex-fix-journal",
        action="store_true",
        help="RevTeX 4.2 workaround: ensure @article entries contain journal=\"\" (requires skill-local bibtex_utils).",
    )

    p = sub.add_parser("arxiv-search", help="Search arXiv (export API).")
    p.add_argument("--query", "-q", required=True)
    p.add_argument("-n", "--max-results", type=int, default=10)
    p.add_argument("--json", action="store_true")
    p.add_argument("--write-trace", action="store_true", help="Append a row to the literature query trace log.")
    p.add_argument("--trace-path", default=DEFAULT_TRACE_PATH)

    p = sub.add_parser("arxiv-get", help="Fetch arXiv record by id.")
    p.add_argument("--arxiv-id", "-a", required=True)
    p.add_argument("--write-note", action="store_true")
    p.add_argument("--kb-dir", default="knowledge_base/literature")
    p.add_argument("--force", action="store_true")
    p.add_argument("--allow-stub", action="store_true", help="If fetch fails, write a stub KB note + reference entry.")
    p.add_argument("--no-trace", action="store_true", help="Do not append to literature query trace log.")
    p.add_argument("--trace-note", default="", help="Optional note for the trace row (Decision/notes column).")
    p.add_argument("--trace-path", default=DEFAULT_TRACE_PATH)

    p = sub.add_parser("arxiv-source", help="Download arXiv LaTeX source tarball (no parsing).")
    p.add_argument("--arxiv-id", "-a", required=True)
    p.add_argument(
        "--out-dir",
        default="references/arxiv_src",
        help="Base output dir. The script creates a subdir per arXiv id. You may also pass the full target dir.",
    )

    p = sub.add_parser("github-search", help="Search GitHub repositories (API).")
    p.add_argument("--query", "-q", required=True)
    p.add_argument("-n", "--max-results", type=int, default=10)
    p.add_argument("--json", action="store_true")
    p.add_argument("--write-trace", action="store_true", help="Append a row to the literature query trace log.")
    p.add_argument("--trace-path", default=DEFAULT_TRACE_PATH)

    p = sub.add_parser("github-get", help="Fetch GitHub repository metadata.")
    p.add_argument("--repo", required=True, help="owner/name or https://github.com/owner/name")
    p.add_argument("--write-note", action="store_true")
    p.add_argument("--kb-dir", default="knowledge_base/methodology_traces")
    p.add_argument("--force", action="store_true")
    p.add_argument("--no-trace", action="store_true", help="Do not append to literature query trace log.")
    p.add_argument("--trace-note", default="", help="Optional note for the trace row (Decision/notes column).")
    p.add_argument("--trace-path", default=DEFAULT_TRACE_PATH)

    p = sub.add_parser("crossref-search", help="Search Crossref (DOI discovery; metadata).")
    p.add_argument("--query", "-q", required=True, help="Keywords/title/author string (Crossref query.bibliographic).")
    p.add_argument("-n", "--max-results", type=int, default=10)
    p.add_argument("--mailto", default="", help="Optional contact email for Crossref polite pool (or set CROSSREF_MAILTO).")
    p.add_argument("--json", action="store_true")
    p.add_argument("--write-trace", action="store_true", help="Append a row to the literature query trace log.")
    p.add_argument("--trace-path", default=DEFAULT_TRACE_PATH)

    p = sub.add_parser("crossref-get", help="Fetch Crossref work metadata by DOI.")
    p.add_argument("--doi", required=True)
    p.add_argument("--mailto", default="", help="Optional contact email for Crossref polite pool (or set CROSSREF_MAILTO).")
    p.add_argument("--write-note", action="store_true")
    p.add_argument("--kb-dir", default="knowledge_base/literature")
    p.add_argument("--force", action="store_true")
    p.add_argument("--allow-stub", action="store_true", help="If fetch fails, write a stub KB note + reference entry.")
    p.add_argument("--no-trace", action="store_true", help="Do not append to literature query trace log.")
    p.add_argument("--trace-note", default="", help="Optional note for the trace row (Decision/notes column).")
    p.add_argument("--trace-path", default=DEFAULT_TRACE_PATH)

    p = sub.add_parser("datacite-search", help="Search DataCite (datasets/software; DOI discovery; metadata).")
    p.add_argument("--query", "-q", required=True)
    p.add_argument("-n", "--max-results", type=int, default=10)
    p.add_argument("--json", action="store_true")
    p.add_argument("--write-trace", action="store_true", help="Append a row to the literature query trace log.")
    p.add_argument("--trace-path", default=DEFAULT_TRACE_PATH)

    p = sub.add_parser("datacite-get", help="Fetch DataCite DOI metadata (datasets/software).")
    p.add_argument("--doi", required=True)
    p.add_argument("--write-note", action="store_true")
    p.add_argument("--kb-dir", default="knowledge_base/literature")
    p.add_argument("--force", action="store_true")
    p.add_argument("--allow-stub", action="store_true", help="If fetch fails, write a stub KB note + reference entry.")
    p.add_argument("--no-trace", action="store_true", help="Do not append to literature query trace log.")
    p.add_argument("--trace-note", default="", help="Optional note for the trace row (Decision/notes column).")
    p.add_argument("--trace-path", default=DEFAULT_TRACE_PATH)

    p = sub.add_parser("doi-bibtex", help="Fetch BibTeX for a DOI via doi.org content negotiation.")
    p.add_argument("--doi", required=True)
    p.add_argument("--mailto", default="", help="Optional contact email for Crossref polite pool (or set CROSSREF_MAILTO).")
    p.add_argument("--revtex-fix-journal", action="store_true", help="Apply the RevTeX journal=\"\" workaround to the fetched BibTeX (requires skill-local bibtex_utils).")

    p = sub.add_parser("trace-add", help="Append a row to literature query trace log (no network).")
    p.add_argument("--source", default="Manual", help="Source label (e.g., Scholar, ADS, Publisher).")
    p.add_argument("--query", required=True)
    p.add_argument("--filters", default="")
    p.add_argument("--shortlist", default="", help="Markdown allowed; use <br/> for multiple items.")
    p.add_argument("--decision", default="")
    p.add_argument("--kb-notes", default="")
    p.add_argument("--trace-path", default=DEFAULT_TRACE_PATH)

    p = sub.add_parser("workflow-plan", help="Resolve checked-in literature workflow authority into an executable plan.")
    p.add_argument("--recipe", required=True, choices=["literature_gap_analysis", "literature_landscape", "literature_to_evidence"])
    p.add_argument("--phase", required=True)
    p.add_argument("--query", default="")
    p.add_argument("--topic", default="")
    p.add_argument("--seed-recid", default="")
    p.add_argument("--analysis-seed", default="")
    p.add_argument("--recid", action="append", default=[])
    p.add_argument("--project-id", default="")
    p.add_argument("--paper-id", default="")
    p.add_argument("--run-id", default="")
    p.add_argument("--preferred-provider", action="append", default=[])

    args = ap.parse_args()

    if args.cmd == "workflow-plan":
        if _resolve_workflow_plan is None:
            raise RuntimeError("literature workflow launcher helper is unavailable")
        inputs = {
            "query": str(getattr(args, "query", "") or ""),
            "topic": str(getattr(args, "topic", "") or ""),
            "seed_recid": str(getattr(args, "seed_recid", "") or ""),
            "analysis_seed": str(getattr(args, "analysis_seed", "") or ""),
            "recids": [str(item).strip() for item in list(getattr(args, "recid", []) or []) if str(item).strip()],
            "project_id": str(getattr(args, "project_id", "") or ""),
            "paper_id": str(getattr(args, "paper_id", "") or ""),
            "run_id": str(getattr(args, "run_id", "") or ""),
        }
        plan = _resolve_workflow_plan(
            recipe_id=str(args.recipe),
            phase=str(args.phase),
            inputs=inputs,
            preferred_providers=[str(item) for item in list(getattr(args, "preferred_provider", []) or []) if str(item).strip()],
        )
        print(json.dumps(plan, indent=2, ensure_ascii=True))
        return 0

    if args.cmd == "inspire-search":
        res = inspire_search(args.query, args.max_results)
        if args.json:
            print(json.dumps(res, indent=2, ensure_ascii=True))
        else:
            for r in res:
                print(f"- recid={r.get('recid','')} citekey={r.get('citekey','')} year={r.get('year','')}  {r.get('authors','')}  {r.get('title','')}")
        if getattr(args, "write_trace", False):
            shortlist_lines: list[str] = []
            for r in res[: min(5, len(res))]:
                recid = str(r.get("recid") or "").strip()
                url = str(r.get("inspire_url") or "").strip()
                label = f"recid-{recid}" if recid else str(r.get("citekey") or "unknown").strip()
                link = f"[{label}]({url})" if url else label
                title = str(r.get("title") or "").strip()
                shortlist_lines.append(f"{link} — {title}" if title else link)
            _append_trace_row(
                trace_path=Path(str(getattr(args, "trace_path", DEFAULT_TRACE_PATH))),
                source="INSPIRE",
                query=str(args.query),
                filters="",
                shortlist="<br/>".join(shortlist_lines),
                decision="TODO: select + justify (fill)",
                kb_notes="",
            )
        return 0

    if args.cmd == "inspire-get":
        try:
            rec = inspire_get(args.recid)
        except Exception as exc:
            if not bool(getattr(args, "allow_stub", False)):
                raise
            rid = str(args.recid).strip()
            url = f"https://inspirehep.net/literature/{rid}" if rid else ""
            rec = _stub_record(
                refkey=f"recid-{rid or 'unknown'}",
                title_hint=f"STUB (INSPIRE recid {rid})",
                external_url=url,
                error=f"INSPIRE fetch failed: {exc.__class__.__name__}: {exc}",
            )
            rec["recid"] = rid
            rec["citekey"] = "UNKNOWN"
            rec["inspire_url"] = url
        kb_dir = Path(str(args.kb_dir))
        project_root = _infer_project_root_from_kb_dir(kb_dir)
        kb_note = kb_dir / f"{rec['refkey']}.md"
        kb_note_rel = (
            _relpath_posix(kb_note, project_root) if project_root is not None else str(kb_note).replace("\\", "/")
        )
        trace_path = _resolve_trace_path(
            Path(str(getattr(args, "trace_path", DEFAULT_TRACE_PATH))),
            kb_dir,
        )
        if args.write_note:
            _write_text(kb_note, _kb_note_template(rec, kb_note_rel), force=bool(args.force))
        print("")
        print("Reference entry (paste into research_contract.md -> ## References):")
        print(_format_reference_entry(rec, kb_note_rel))
        if bool(args.write_note) and not bool(getattr(args, "no_trace", False)):
            kb_note_for_trace = _relpath_posix(kb_note, trace_path.resolve().parent)
            links: list[str] = []
            if rec.get("inspire_url"):
                links.append(f"[INSPIRE]({rec.get('inspire_url')})")
            if rec.get("arxiv_id"):
                links.append(f"[arXiv](https://arxiv.org/abs/{rec.get('arxiv_id')})")
            if rec.get("doi"):
                links.append(f"[DOI](https://doi.org/{rec.get('doi')})")
            note = str(getattr(args, "trace_note", "") or "").strip()
            decision = "Accepted (KB note written)" + (f"; {note}" if note else "")
            _append_trace_row(
                trace_path=trace_path.resolve(),
                source="INSPIRE",
                query=f"recid:{args.recid}",
                filters="",
                shortlist="<br/>".join(links),
                decision=decision,
                kb_notes=f"[{rec.get('refkey','kb')}]({kb_note_for_trace})",
            )
        return 0

    if args.cmd == "inspire-bibtex":
        recid = str(getattr(args, "recid", "") or "").strip() or None
        texkey = str(getattr(args, "texkey", "") or "").strip() or None
        bib = inspire_bibtex(recid=recid, texkey=texkey)
        if bool(getattr(args, "revtex_fix_journal", False)):
            if _normalize_revtex4_2_bibtex is None:
                print("[warn] --revtex-fix-journal requested but bibtex_utils is not available; leaving BibTeX unchanged.", file=sys.stderr)
            else:
                bib, _ = _normalize_revtex4_2_bibtex(bib)

        out_path = str(getattr(args, "out", "") or "").strip()
        if out_path:
            p = Path(out_path)
            p.parent.mkdir(parents=True, exist_ok=True)
            append = bool(getattr(args, "append", False))
            mode = "a" if append else "w"
            with p.open(mode, encoding="utf-8") as f:
                if append and p.exists():
                    try:
                        if p.stat().st_size > 0:
                            f.write("\n")
                    except Exception:
                        pass
                f.write(bib.rstrip() + "\n")
            print(f"[ok] wrote: {p}")
        else:
            print(bib.rstrip())
        return 0

    if args.cmd == "arxiv-search":
        res = arxiv_search(args.query, args.max_results)
        if args.json:
            print(json.dumps(res, indent=2, ensure_ascii=True))
        else:
            for r in res:
                print(f"- arXiv={r.get('arxiv_id','')} year={r.get('year','')}  {r.get('authors','')}  {r.get('title','')}")
        if getattr(args, "write_trace", False):
            shortlist_lines: list[str] = []
            for r in res[: min(5, len(res))]:
                arxiv_id = str(r.get("arxiv_id") or "").strip()
                url = str(r.get("arxiv_url") or f"https://arxiv.org/abs/{arxiv_id}").strip() if arxiv_id else ""
                label = f"arXiv:{arxiv_id}" if arxiv_id else "arXiv"
                link = f"[{label}]({url})" if url else label
                title = str(r.get("title") or "").strip()
                shortlist_lines.append(f"{link} — {title}" if title else link)
            _append_trace_row(
                trace_path=Path(str(getattr(args, "trace_path", DEFAULT_TRACE_PATH))),
                source="arXiv",
                query=str(args.query),
                filters="",
                shortlist="<br/>".join(shortlist_lines),
                decision="TODO: select + justify (fill)",
                kb_notes="",
            )
        return 0

    if args.cmd == "arxiv-get":
        try:
            rec = arxiv_get(args.arxiv_id)
        except Exception as exc:
            if not bool(getattr(args, "allow_stub", False)):
                raise
            aid = re.sub(r"v\\d+$", "", str(args.arxiv_id).strip())
            url = f"https://arxiv.org/abs/{aid}" if aid else ""
            rec = _stub_record(
                refkey=f"arxiv-{aid or 'unknown'}",
                title_hint=f"STUB (arXiv {aid})",
                external_url=url,
                error=f"arXiv fetch failed: {exc.__class__.__name__}: {exc}",
            )
            rec["arxiv_id"] = aid
            rec["arxiv_url"] = url
        kb_dir = Path(str(args.kb_dir))
        project_root = _infer_project_root_from_kb_dir(kb_dir)
        kb_note = kb_dir / f"{rec['refkey']}.md"
        kb_note_rel = (
            _relpath_posix(kb_note, project_root) if project_root is not None else str(kb_note).replace("\\", "/")
        )
        trace_path = _resolve_trace_path(
            Path(str(getattr(args, "trace_path", DEFAULT_TRACE_PATH))),
            kb_dir,
        )
        if args.write_note:
            _write_text(kb_note, _kb_note_template(rec, kb_note_rel), force=bool(args.force))
        print("")
        print("Reference entry (paste into research_contract.md -> ## References):")
        print(_format_reference_entry(rec, kb_note_rel))
        if bool(args.write_note) and not bool(getattr(args, "no_trace", False)):
            kb_note_for_trace = _relpath_posix(kb_note, trace_path.resolve().parent)
            links: list[str] = []
            if rec.get("arxiv_id"):
                links.append(f"[arXiv](https://arxiv.org/abs/{rec.get('arxiv_id')})")
            if rec.get("doi"):
                links.append(f"[DOI](https://doi.org/{rec.get('doi')})")
            note = str(getattr(args, "trace_note", "") or "").strip()
            decision = "Accepted (KB note written)" + (f"; {note}" if note else "")
            _append_trace_row(
                trace_path=trace_path.resolve(),
                source="arXiv",
                query=f"arxiv:{args.arxiv_id}",
                filters="",
                shortlist="<br/>".join(links),
                decision=decision,
                kb_notes=f"[{rec.get('refkey','kb')}]({kb_note_for_trace})",
            )
        return 0

    if args.cmd == "arxiv-source":
        arxiv_id = re.sub(r"v\d+$", "", str(args.arxiv_id).strip())
        safe_dir = _arxiv_id_dirname(arxiv_id)
        base = Path(str(args.out_dir))

        # Backward-/human-error tolerant:
        # - If user passes the base dir (recommended): references/arxiv_src -> append <safe_dir>
        # - If user passes a full target dir (ends with <safe_dir>): use it directly
        # - If user passes an old-style nested path (.../hep-ph/0109056): also use it directly
        if base.name == safe_dir:
            out_dir = base
        else:
            raw_parts = [p for p in arxiv_id.split("/") if p]
            if len(raw_parts) == 2 and tuple(base.parts[-2:]) == tuple(raw_parts):
                out_dir = base
            else:
                out_dir = base / safe_dir
        extracted = arxiv_source(args.arxiv_id, out_dir=out_dir)
        print("[ok] downloaded arXiv source")
        print(f"- out_dir: {out_dir}")
        print(f"- extracted_dir: {extracted}")
        print("")
        print(
            textwrap.dedent(
                f"""\
                Next (manual, LLM-assisted):
                - Open the LaTeX sources under `{extracted}`.
                - Copy key equations/definitions into `knowledge_base/literature/<refkey>.md` under '## Key equations / definitions'.
                - Record normalization choices and suspected typos under '## Notes / Issues'.
                - If those excerpts use paper macros (\\newcommand), you can batch-discover safe 0-arg macro expansions and merge into your JSON config (run from project root): `python3 "${SKILL_DIR:-${CODEX_HOME:-$HOME/.codex}/skills/research-team}/scripts/bin/discover_latex_zero_arg_macros.py" --root . --update-config`
                """
            ).rstrip()
        )
        return 0

    if args.cmd == "github-search":
        token = os.environ.get("GITHUB_TOKEN", "").strip()
        res = github_search(args.query, args.max_results, token=token or None)
        if args.json:
            print(json.dumps(res, indent=2, ensure_ascii=True))
        else:
            for r in res:
                print(
                    f"- repo={r.get('repo','')} stars={r.get('stars',0)} year={r.get('year','')}  {r.get('title','')}"
                )
                if r.get("github_url"):
                    print(f"  {r.get('github_url')}")
        if getattr(args, "write_trace", False):
            shortlist_lines: list[str] = []
            for r in res[: min(5, len(res))]:
                repo = str(r.get("repo") or "").strip() or "repo"
                url = str(r.get("github_url") or "").strip()
                link = f"[{repo}]({url})" if url else repo
                title = str(r.get("title") or "").strip()
                shortlist_lines.append(f"{link} — {title}" if title else link)
            _append_trace_row(
                trace_path=Path(str(getattr(args, "trace_path", DEFAULT_TRACE_PATH))),
                source="GitHub",
                query=str(args.query),
                filters="",
                shortlist="<br/>".join(shortlist_lines),
                decision="TODO: select + justify (fill)",
                kb_notes="",
            )
        return 0

    if args.cmd == "github-get":
        token = os.environ.get("GITHUB_TOKEN", "").strip()
        rec = github_get(args.repo, token=token or None)
        kb_dir = Path(str(args.kb_dir))
        project_root = _infer_project_root_from_kb_dir(kb_dir)
        kb_note = kb_dir / f"{rec['refkey']}.md"
        kb_note_rel = (
            _relpath_posix(kb_note, project_root) if project_root is not None else str(kb_note).replace("\\", "/")
        )
        trace_path = _resolve_trace_path(
            Path(str(getattr(args, "trace_path", DEFAULT_TRACE_PATH))),
            kb_dir,
        )
        if args.write_note:
            _write_text(kb_note, _kb_trace_template_github(rec, kb_note_rel), force=bool(args.force))
        print("")
        print("Reference entry (paste into research_contract.md -> ## References):")
        print(_format_reference_entry(rec, kb_note_rel))
        if bool(args.write_note) and not bool(getattr(args, "no_trace", False)):
            kb_note_for_trace = _relpath_posix(kb_note, trace_path.resolve().parent)
            links: list[str] = []
            if rec.get("github_url"):
                links.append(f"[GitHub]({rec.get('github_url')})")
            note = str(getattr(args, "trace_note", "") or "").strip()
            decision = "Accepted (KB note written)" + (f"; {note}" if note else "")
            _append_trace_row(
                trace_path=trace_path.resolve(),
                source="GitHub",
                query=f"repo:{args.repo}",
                filters="",
                shortlist="<br/>".join(links),
                decision=decision,
                kb_notes=f"[{rec.get('refkey','kb')}]({kb_note_for_trace})",
            )
        return 0

    if args.cmd == "crossref-search":
        mailto = str(args.mailto or "").strip() or os.environ.get("CROSSREF_MAILTO", "").strip() or None
        res = crossref_search(query=args.query, max_results=args.max_results, mailto=mailto)
        if args.json:
            print(json.dumps(res, indent=2, ensure_ascii=True))
        else:
            for r in res:
                doi = r.get("doi", "")
                y = r.get("year", "")
                au = r.get("authors", "")
                title = r.get("title", "")
                typ = r.get("type", "")
                print(f"- DOI={doi} year={y} type={typ}  {au}  {title}")
        if getattr(args, "write_trace", False):
            shortlist_lines: list[str] = []
            for r in res[: min(5, len(res))]:
                doi = str(r.get("doi") or "").strip()
                url = f"https://doi.org/{doi}" if doi else ""
                label = f"DOI:{doi}" if doi else "DOI"
                link = f"[{label}]({url})" if url else label
                title = str(r.get("title") or "").strip()
                shortlist_lines.append(f"{link} — {title}" if title else link)
            _append_trace_row(
                trace_path=Path(str(getattr(args, "trace_path", DEFAULT_TRACE_PATH))),
                source="Crossref",
                query=str(args.query),
                filters="",
                shortlist="<br/>".join(shortlist_lines),
                decision="TODO: select + justify (fill)",
                kb_notes="",
            )
        return 0

    if args.cmd == "crossref-get":
        mailto = str(args.mailto or "").strip() or os.environ.get("CROSSREF_MAILTO", "").strip() or None
        try:
            rec = crossref_get(doi=args.doi, mailto=mailto)
        except Exception as exc:
            if not bool(getattr(args, "allow_stub", False)):
                raise
            doi = str(args.doi).strip()
            url = f"https://doi.org/{doi}" if doi else ""
            rec = _stub_record(
                refkey=f"doi-{doi or 'unknown'}",
                title_hint=f"STUB (DOI {doi})",
                external_url=url,
                error=f"Crossref fetch failed: {exc.__class__.__name__}: {exc}",
            )
            rec["doi"] = doi
        kb_dir = Path(str(args.kb_dir))
        project_root = _infer_project_root_from_kb_dir(kb_dir)
        kb_note = kb_dir / f"{rec['refkey']}.md"
        kb_note_rel = (
            _relpath_posix(kb_note, project_root) if project_root is not None else str(kb_note).replace("\\", "/")
        )
        trace_path = _resolve_trace_path(
            Path(str(getattr(args, "trace_path", DEFAULT_TRACE_PATH))),
            kb_dir,
        )
        if args.write_note:
            _write_text(kb_note, _kb_note_template(rec, kb_note_rel), force=bool(args.force))
        print("")
        print("Reference entry (paste into research_contract.md -> ## References):")
        print(_format_reference_entry(rec, kb_note_rel))
        if bool(args.write_note) and not bool(getattr(args, "no_trace", False)):
            kb_note_for_trace = _relpath_posix(kb_note, trace_path.resolve().parent)
            links: list[str] = []
            if rec.get("doi"):
                links.append(f"[DOI](https://doi.org/{rec.get('doi')})")
            note = str(getattr(args, "trace_note", "") or "").strip()
            decision = "Accepted (KB note written)" + (f"; {note}" if note else "")
            _append_trace_row(
                trace_path=trace_path.resolve(),
                source="Crossref",
                query=f"doi:{args.doi}",
                filters="",
                shortlist="<br/>".join(links),
                decision=decision,
                kb_notes=f"[{rec.get('refkey','kb')}]({kb_note_for_trace})",
            )
        return 0

    if args.cmd == "datacite-search":
        res = datacite_search(args.query, args.max_results)
        if args.json:
            print(json.dumps(res, indent=2, ensure_ascii=True))
        else:
            for r in res:
                doi = r.get("doi", "")
                y = r.get("year", "")
                au = r.get("authors", "")
                title = r.get("title", "")
                pub = r.get("publication", "")
                print(f"- DOI={doi} year={y}  {au}  {title}  [{pub}]")
        if getattr(args, "write_trace", False):
            shortlist_lines: list[str] = []
            for r in res[: min(5, len(res))]:
                doi = str(r.get("doi") or "").strip()
                url = f"https://doi.org/{doi}" if doi else ""
                label = f"DOI:{doi}" if doi else "DOI"
                link = f"[{label}]({url})" if url else label
                title = str(r.get("title") or "").strip()
                shortlist_lines.append(f"{link} — {title}" if title else link)
            _append_trace_row(
                trace_path=Path(str(getattr(args, "trace_path", DEFAULT_TRACE_PATH))),
                source="DataCite",
                query=str(args.query),
                filters="",
                shortlist="<br/>".join(shortlist_lines),
                decision="TODO: select + justify (fill)",
                kb_notes="",
            )
        return 0

    if args.cmd == "datacite-get":
        try:
            rec = datacite_get(doi=args.doi)
        except Exception as exc:
            if not bool(getattr(args, "allow_stub", False)):
                raise
            doi = str(args.doi).strip()
            url = f"https://doi.org/{doi}" if doi else ""
            rec = _stub_record(
                refkey=f"doi-{doi or 'unknown'}",
                title_hint=f"STUB (DOI {doi})",
                external_url=url,
                error=f"DataCite fetch failed: {exc.__class__.__name__}: {exc}",
            )
            rec["doi"] = doi
        kb_dir = Path(str(args.kb_dir))
        project_root = _infer_project_root_from_kb_dir(kb_dir)
        kb_note = kb_dir / f"{rec['refkey']}.md"
        kb_note_rel = (
            _relpath_posix(kb_note, project_root) if project_root is not None else str(kb_note).replace("\\", "/")
        )
        trace_path = _resolve_trace_path(
            Path(str(getattr(args, "trace_path", DEFAULT_TRACE_PATH))),
            kb_dir,
        )
        if args.write_note:
            _write_text(kb_note, _kb_note_template(rec, kb_note_rel), force=bool(args.force))
        print("")
        print("Reference entry (paste into research_contract.md -> ## References):")
        print(_format_reference_entry(rec, kb_note_rel))
        if bool(args.write_note) and not bool(getattr(args, "no_trace", False)):
            kb_note_for_trace = _relpath_posix(kb_note, trace_path.resolve().parent)
            links: list[str] = []
            if rec.get("doi"):
                links.append(f"[DOI](https://doi.org/{rec.get('doi')})")
            note = str(getattr(args, "trace_note", "") or "").strip()
            decision = "Accepted (KB note written)" + (f"; {note}" if note else "")
            _append_trace_row(
                trace_path=trace_path.resolve(),
                source="DataCite",
                query=f"doi:{args.doi}",
                filters="",
                shortlist="<br/>".join(links),
                decision=decision,
                kb_notes=f"[{rec.get('refkey','kb')}]({kb_note_for_trace})",
            )
        return 0

    if args.cmd == "doi-bibtex":
        mailto = str(args.mailto or "").strip() or os.environ.get("CROSSREF_MAILTO", "").strip() or None
        bib = doi_bibtex(doi=args.doi, mailto=mailto)
        if bool(getattr(args, "revtex_fix_journal", False)):
            if _normalize_revtex4_2_bibtex is None:
                print("[warn] --revtex-fix-journal requested but bibtex_utils is not available; leaving BibTeX unchanged.", file=sys.stderr)
            else:
                bib, _ = _normalize_revtex4_2_bibtex(bib)
        print(bib)
        return 0

    if args.cmd == "trace-add":
        _append_trace_row(
            trace_path=Path(str(getattr(args, "trace_path", DEFAULT_TRACE_PATH))),
            source=str(getattr(args, "source", "Manual")),
            query=str(args.query),
            filters=str(getattr(args, "filters", "")),
            shortlist=str(getattr(args, "shortlist", "")),
            decision=str(getattr(args, "decision", "")),
            kb_notes=str(getattr(args, "kb_notes", "")),
        )
        print(f"[ok] appended trace row: {getattr(args, 'trace_path', DEFAULT_TRACE_PATH)}")
        return 0

    raise SystemExit(f"Unknown cmd: {args.cmd}")


if __name__ == "__main__":
    raise SystemExit(main())
