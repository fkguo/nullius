#!/usr/bin/env python3
"""
References gate for Draft_Derivation.md.

Checks:
- A "References" section exists (## References / ## 参考文献).
  Accepts optional numeric prefix (e.g., "## 10. References").
- At least one entry exists.
- Each entry includes:
  - a reference key "[@Key]"
  - an HTML anchor defining "ref-Key" on the same line (e.g. <a id="ref-Key"></a>)
  - a knowledge_base link
  - an external link (http/https), unless explicitly marked as "Link: none" or "External: none".
  - author attribution (at least first author + "et al." when applicable), and a publication year or retrieval/access date
  - for [@recid-<N>] entries: an INSPIRE link containing that recid (https://inspirehep.net/literature/<N>)
  - for [@arxiv-<ID>] entries (new-style: arxiv-YYYY.NNNN): an arXiv abs link containing that id (https://arxiv.org/abs/YYYY.NNNN)
  - for [@arxiv-<archive>-<YYMMNNN>] entries (old-style: arxiv-hep-ph-0109056): an arXiv abs link containing archive/YYMMNNN
    (https://arxiv.org/abs/hep-ph/0109056)
"""

from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path
from urllib.parse import urlsplit

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "lib"))

from team_config import load_team_config  # type: ignore


SECTION_PATTERNS = (
    r"^##\s+(?:\d+\.\s*)?References\b.*$",
    r"^##\s+(?:\d+\.\s*)?参考文献\b.*$",
)

_INLINE_CODE_2_RE = re.compile(r"``[^`]*``")
_INLINE_CODE_1_RE = re.compile(r"`[^`]*`")
_ANCHOR_DEF_RE = re.compile(
    r"""<a\s+[^>]*(?:id|name)\s*=\s*['"]ref-([A-Za-z0-9_.:-]+)['"]""",
    flags=re.IGNORECASE,
)

# Keep this allowlist narrow by default: references should be anchored to stable sources.
# If your project needs additional domains, add them in `research_team_config.json`:
#   references.allowed_external_hosts_extra: ["example.com", ...]
# or override entirely:
#   references.allowed_external_hosts: ["example.com", ...]
ALLOWED_EXTERNAL_HOSTS = {
    "inspirehep.net",
    "arxiv.org",
    "export.arxiv.org",
    "doi.org",
    "github.com",
    "raw.githubusercontent.com",
    "api.github.com",
    # Common, stable research software/docs + archival sources:
    "docs.scipy.org",
    "numpy.org",
    "pypi.org",
    "docs.julialang.org",
    "julialang.org",
    "zenodo.org",
    # Data/software archives:
    "archive.softwareheritage.org",
    "softwareheritage.org",
    "hepdata.net",
    "cds.cern.ch",
    "datacite.org",
}

_YEAR_RE = re.compile(r"\b(19|20)\d{2}\b")
_ISO_DATE_RE = re.compile(r"\b(19|20)\d{2}-\d{2}-\d{2}\b")

# Conservative placeholder tokens: fail in publication stage (metadata must be stabilized).
_PLACEHOLDER_TOKENS = (
    "unknown",
    "tbd",
    "todo",
    "pending",
    "placeholder",
    "stub",
    "metadata pending",
    "???",
)


def _strip_inline_code_spans(line: str) -> str:
    # Best-effort CommonMark-ish stripping: handle ``code`` then `code`.
    # This is used to avoid treating documentation examples like `[@Key](#ref-Key)` as real citations/entries.
    out = _INLINE_CODE_2_RE.sub("", line)
    out = _INLINE_CODE_1_RE.sub("", out)
    return out


def _extract_urls(text: str) -> list[str]:
    # Minimal URL capture: exclude trailing punctuation that often follows Markdown links.
    urls = re.findall(r"https?://[^\s)>\"]+", text)
    out: list[str] = []
    for u in urls:
        out.append(u.rstrip(".,;:"))
    return out


def _normalize_host(x: str) -> str:
    s = str(x or "").strip()
    if not s:
        return ""
    if "://" in s:
        try:
            s = urlsplit(s).netloc
        except Exception:
            pass
    host = s.lower().split(":", 1)[0].strip()
    if host.startswith("www."):
        host = host[4:]
    return host


def _allowed_hosts_from_config(cfg: object) -> set[str]:
    data = getattr(cfg, "data", None)
    if not isinstance(data, dict):
        return set(ALLOWED_EXTERNAL_HOSTS)
    refs = data.get("references", {})
    if not isinstance(refs, dict):
        return set(ALLOWED_EXTERNAL_HOSTS)

    override = refs.get("allowed_external_hosts")
    if isinstance(override, list):
        custom: set[str] = set()
        for x in override:
            h = _normalize_host(str(x))
            if h:
                custom.add(h)
        return custom or set(ALLOWED_EXTERNAL_HOSTS)

    extra = refs.get("allowed_external_hosts_extra", [])
    hosts = set(ALLOWED_EXTERNAL_HOSTS)
    if isinstance(extra, list):
        for x in extra:
            h = _normalize_host(str(x))
            if h:
                hosts.add(h)
    return hosts


def _urls_all_allowed(urls: list[str], *, allowed_hosts: set[str]) -> tuple[bool, str]:
    for u in urls:
        try:
            host = urlsplit(u).netloc.lower().split(":", 1)[0]
        except Exception:
            return False, f"bad url parse: {u}"
        if host.startswith("www."):
            host = host[4:]
        if host and host not in allowed_hosts:
            return False, f"external link host not allowed: {host} (url={u})"
    return True, ""


def _has_author_attribution(line: str) -> bool:
    # Heuristic: accept any ONE of these.
    if re.search(r"\bet\s+al\.?\b", line, flags=re.IGNORECASE):
        return True
    if re.search(r"\bAuthors?\s*:", line, flags=re.IGNORECASE):
        return True
    if re.search(r"\bMaintainer\s*:", line, flags=re.IGNORECASE):
        return True
    # "F.-K. Guo" / "W. N. Polyzou" style.
    if re.search(r"\b[A-Z]\.(?:-[A-Z]\.)*\s*(?:[A-Z]\.\s*)*[A-Z][A-Za-z-]{2,}\b", line):
        return True
    # "Guo et al." style.
    if re.search(r"\b[A-Z][A-Za-z-]{2,}\s+et\s+al\.?\b", line, flags=re.IGNORECASE):
        return True
    return False


def _has_pub_time_signal(line: str) -> bool:
    # Publication year OR explicit retrieval/access date is required.
    if _YEAR_RE.search(line):
        return True
    if _ISO_DATE_RE.search(line):
        return True
    # Allow "Retrieved:" / "Accessed:" only if something non-empty follows (avoid empty placeholders).
    if re.search(r"\b(Retrieved|Accessed)\s*:\s*\S", line, flags=re.IGNORECASE):
        return True
    return False


def _find_section(text: str) -> tuple[str | None, int, int]:
    for pat in SECTION_PATTERNS:
        m = re.search(pat, text, flags=re.MULTILINE)
        if not m:
            continue
        start = m.end()
        m2 = re.search(r"^##\s+", text[start:], flags=re.MULTILINE)
        end = start + (m2.start() if m2 else len(text) - start)
        return text[start:end].strip(), m.start(), end
    return None, -1, -1


def _line_number(text: str, offset: int) -> int:
    if offset < 0:
        return 1
    return text[:offset].count("\n") + 1


def _extract_field(head: str, field: str) -> str:
    m = re.search(rf"^\s*{re.escape(field)}\s*:\s*(.+?)\s*$", head, flags=re.MULTILINE)
    return m.group(1).strip() if m else ""


def _has_placeholder(s: str) -> bool:
    t = (s or "").strip().lower()
    if not t:
        return True
    return any(tok in t for tok in _PLACEHOLDER_TOKENS)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--notes", type=Path, required=True, help="Path to Draft_Derivation.md.")
    args = ap.parse_args()

    if not args.notes.is_file():
        print(f"ERROR: notes not found: {args.notes}")
        return 2

    cfg = load_team_config(args.notes)
    if not cfg.feature_enabled("references_gate", default=False):
        print("[skip] references gate disabled by research_team_config")
        return 0

    allowed_hosts = _allowed_hosts_from_config(cfg)
    stage = str(getattr(cfg, "data", {}).get("project_stage", "development") if isinstance(getattr(cfg, "data", {}), dict) else "development").strip()
    if stage not in ("exploration", "development", "publication"):
        stage = "development"

    text = args.notes.read_text(encoding="utf-8", errors="replace")
    section, start_offset, end_offset = _find_section(text)
    if section is None:
        print("[fail] references gate failed")
        print("[error] Missing '## References' (or '## 参考文献') section in the main document.")
        return 1

    errors: list[str] = []
    base_line = _line_number(text, start_offset)
    entries: list[tuple[int, str]] = []

    # Ignore fenced blocks inside References (users sometimes show examples).
    in_fence = False
    for i, ln in enumerate(section.splitlines(), start=1):
        stripped = ln.strip()
        if stripped.startswith("```") or stripped.startswith("~~~"):
            in_fence = not in_fence
            continue
        if in_fence:
            continue
        ln_no_code = _strip_inline_code_spans(ln)
        # Only treat a line as a reference entry if it defines an HTML anchor id/name for "ref-<Key>".
        # This prevents instruction/example lines like "Cite in text as [@Key](#ref-Key)" from being
        # misclassified as entries and failing the gate.
        m_key = re.search(r"\[@([A-Za-z0-9_.:-]+)\]", ln_no_code)
        if not m_key:
            continue
        key = m_key.group(1)
        m_anchor = _ANCHOR_DEF_RE.search(ln_no_code)
        if not m_anchor:
            continue
        if m_anchor.group(1) != key:
            continue
        entries.append((i, ln))

    if not entries:
        errors.append("No reference entries found (expected lines containing [@Key]).")

    seen_keys: set[str] = set()
    key_to_kb_path: dict[str, str] = {}
    for rel_line, ln in entries:
        line_no = base_line + rel_line
        ln_no_code = _strip_inline_code_spans(ln)
        m = re.search(r"\[@([A-Za-z0-9_.:-]+)\]", ln_no_code)
        if not m:
            errors.append(f"Line {line_no}: missing reference key in entry.")
            continue
        key = m.group(1)
        if key in seen_keys:
            errors.append(f"Line {line_no}: duplicate reference key '{key}'.")
        seen_keys.add(key)

        if f"ref-{key}" not in ln_no_code:
            errors.append(f"Line {line_no}: missing anchor 'ref-{key}' on the same line.")

        if "knowledge_base/" not in ln_no_code and "knowledge_base\\" not in ln_no_code:
            errors.append(f"Line {line_no}: missing knowledge_base link.")
        else:
            # Best-effort: capture the first knowledge_base/<...>.md path and verify it exists.
            m_kb = re.search(r"\((knowledge_base/[^)\s]+)\)", ln_no_code)
            if not m_kb:
                m_kb = re.search(r"(knowledge_base/[^\s)]+\.md)", ln_no_code)
            if m_kb:
                key_to_kb_path[key] = m_kb.group(1)

        urls = _extract_urls(ln_no_code)
        if not urls:
            if re.search(r"(link|external)\s*:\s*none", ln_no_code, flags=re.IGNORECASE) is None:
                errors.append(
                    f"Line {line_no}: missing external link (http/https). "
                    "If none exists, add 'Link: none'."
                )
        else:
            ok, msg = _urls_all_allowed(urls, allowed_hosts=allowed_hosts)
            if not ok:
                errors.append(f"Line {line_no}: {msg}")

        # Require attribution + time/publication info (prevents content-free references).
        if not _has_author_attribution(ln_no_code):
            errors.append(
                f"Line {line_no}: missing author attribution (expected e.g. 'F. Surname', 'Surname et al.', or 'Authors: ...')."
            )
        if not _has_pub_time_signal(ln_no_code):
            errors.append(
                f"Line {line_no}: missing publication year or retrieval/access date (expected a 4-digit year like 2024, or 'Retrieved: YYYY-MM-DD')."
            )

        # Tighten key-specific link requirements for stable provenance.
        m_recid = re.fullmatch(r"recid-(\d+)", key)
        if m_recid:
            rid = m_recid.group(1)
            if f"inspirehep.net/literature/{rid}" not in ln_no_code:
                errors.append(
                    f"Line {line_no}: [@{key}] must include an INSPIRE link containing the recid (https://inspirehep.net/literature/{rid})."
                )
        m_arxiv = re.fullmatch(r"arxiv-([0-9]{4}\.[0-9]{4,5})", key)
        if m_arxiv:
            aid = m_arxiv.group(1)
            if f"arxiv.org/abs/{aid}" not in ln_no_code:
                errors.append(
                    f"Line {line_no}: [@{key}] must include an arXiv abs link (https://arxiv.org/abs/{aid})."
                )
        m_arxiv_old = re.fullmatch(r"arxiv-([a-z]+(?:-[a-z]+)*)-(\d{7})", key)
        if m_arxiv_old:
            archive = m_arxiv_old.group(1)
            num = m_arxiv_old.group(2)
            if f"arxiv.org/abs/{archive}/{num}" not in ln_no_code:
                errors.append(
                    f"Line {line_no}: [@{key}] must include an arXiv abs link (https://arxiv.org/abs/{archive}/{num})."
                )

    if errors:
        print("[fail] references gate failed")
        for e in errors:
            print(f"[error] {e}")
        return 1

    # Cross-check: citations in the main body must have matching entries in References.
    # (Exclude the References section itself.)
    body = text
    if start_offset >= 0 and end_offset > start_offset:
        body = text[:start_offset] + "\n" + text[end_offset:]

    def _iter_body_lines(md: str) -> list[str]:
        out: list[str] = []
        in_fence = False
        for ln in md.splitlines():
            if ln.strip().startswith("```"):
                in_fence = not in_fence
                continue
            if in_fence:
                continue
            # Remove inline code spans to avoid treating examples like `[@Key]` as real citations.
            ln2 = _strip_inline_code_spans(ln)
            out.append(ln2)
        return out

    body_lines = _iter_body_lines(body)

    cited_keys: set[str] = set()
    for ln in body_lines:
        for m in re.finditer(r"\[@([A-Za-z0-9_.:-]+)\]", ln):
            cited_keys.add(m.group(1))

    missing_entries = sorted(cited_keys - seen_keys)
    if missing_entries:
        print("[fail] references gate failed")
        for k in missing_entries[:20]:
            print(f"[error] Missing reference entry for cited key: {k!r}")
        if len(missing_entries) > 20:
            print(f"[error] ... ({len(missing_entries) - 20} more missing reference entries)")
        return 1

    # Cross-check: if the body links to a recid-based literature note, require a matching [@recid-XXXX] entry.
    recid_keys: set[str] = set()
    for ln in body_lines:
        for m in re.finditer(r"knowledge_base/literature/(recid-\d+)\.md", ln):
            recid_keys.add(m.group(1))
    missing_recids = sorted(recid_keys - seen_keys)
    if missing_recids:
        print("[fail] references gate failed")
        for k in missing_recids[:20]:
            print(f"[error] Body links to knowledge_base literature note but References is missing [@{k}]: {k}.md")
        if len(missing_recids) > 20:
            print(f"[error] ... ({len(missing_recids) - 20} more missing recid reference entries)")
        return 1

    # Verify referenced KB note paths exist on disk (best-effort).
    note_dir = args.notes.parent.resolve()
    project_root = note_dir
    # Prefer resolving root-relative paths from the config location (if any).
    # This makes the gate robust even if Draft_Derivation.md lives in a subdirectory.
    if getattr(cfg, "path", None):
        try:
            project_root = cfg.path.parent.resolve()  # type: ignore[union-attr]
        except Exception:
            project_root = note_dir
    kb_missing: list[str] = []
    kb_paths: dict[str, Path] = {}
    for key, path_s in key_to_kb_path.items():
        norm = str(path_s).replace("\\", "/")
        p = Path(norm)
        if not p.is_absolute():
            if norm.startswith(
                (
                    "knowledge_base/",
                    "knowledge_graph/",
                    "references/",
                    "artifacts/",
                    "runs/",
                    "figures/",
                    "scripts/",
                    "team/",
                    "prompts/",
                )
            ):
                p = project_root / p
            else:
                p = note_dir / p
        if not p.is_file():
            kb_missing.append(f"{key}: {path_s}")
        else:
            kb_paths[key] = p
    if kb_missing:
        print("[fail] references gate failed")
        for x in kb_missing[:20]:
            print(f"[error] Missing knowledge_base file for reference entry: {x}")
        if len(kb_missing) > 20:
            print(f"[error] ... ({len(kb_missing) - 20} more missing KB files)")
        return 1

    # Publication-stage: verify metadata consistency and forbid placeholders.
    if stage == "publication":
        pub_errors: list[str] = []
        for key, p in kb_paths.items():
            try:
                txt = p.read_text(encoding="utf-8", errors="replace")
            except Exception as exc:
                pub_errors.append(f"{p}: failed to read ({exc})")
                continue
            head = "\n".join(txt.splitlines()[:200])
            refkey = _extract_field(head, "RefKey")
            if refkey and refkey != key:
                pub_errors.append(f"{p}: RefKey mismatch (RefKey={refkey!r} vs cited key={key!r})")
            authors = _extract_field(head, "Authors")
            publication = _extract_field(head, "Publication")
            if _has_placeholder(authors):
                pub_errors.append(f"{p}: placeholder/missing Authors (got {authors!r})")
            if _has_placeholder(publication):
                pub_errors.append(f"{p}: placeholder/missing Publication (got {publication!r})")

            m_recid = re.fullmatch(r"recid-(\d+)", key)
            if m_recid:
                rid = m_recid.group(1)
                inspire_rid = _extract_field(head, "INSPIRE recid")
                citekey = _extract_field(head, "Citekey")
                if inspire_rid != rid:
                    pub_errors.append(f"{p}: INSPIRE recid mismatch (expected {rid}, got {inspire_rid!r})")
                if _has_placeholder(citekey):
                    pub_errors.append(f"{p}: placeholder/missing Citekey (got {citekey!r})")

            m_arxiv = re.fullmatch(r"arxiv-([0-9]{4}\.[0-9]{4,5})", key)
            m_arxiv_old = re.fullmatch(r"arxiv-([a-z]+(?:-[a-z]+)*)-(\d{7})", key)
            if m_arxiv or m_arxiv_old:
                arxiv_id = _extract_field(head, "arXiv")
                if _has_placeholder(arxiv_id):
                    pub_errors.append(f"{p}: placeholder/missing arXiv id (got {arxiv_id!r})")

            if key.startswith("doi-") or "doi.org/" in txt.lower():
                doi = _extract_field(head, "DOI")
                if _has_placeholder(doi):
                    pub_errors.append(f"{p}: placeholder/missing DOI (got {doi!r})")

        if pub_errors:
            print("[fail] references gate failed")
            print("[error] publication-stage metadata consistency checks failed")
            for e in pub_errors[:50]:
                print(f"[error] {e}")
            if len(pub_errors) > 50:
                print(f"[error] ... ({len(pub_errors) - 50} more)")
            return 1

    print("[ok] references gate passed")
    print(f"- references listed: {len(entries)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
