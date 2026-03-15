#!/usr/bin/env python3
"""
upgrade_reference_anchors.py

Deterministic helper to stabilize external URLs in `research_contract.md -> ## References`.

Why:
- During exploration, you may paste "whatever link you found". Before development/publication,
  references should point to stable anchors (DOI/arXiv/INSPIRE/etc.).
- This tool performs only conservative, pattern-based rewrites; it does not do web search.

Rewrites (in References section only):
- dx.doi.org -> doi.org (https)
- export.arxiv.org -> arxiv.org
- arxiv.org/pdf/<id>.pdf -> arxiv.org/abs/<id>  (strip vN)
- arxiv.org/abs/<id>vN -> arxiv.org/abs/<id>
- inspirehep.net/api/literature/<recid> -> inspirehep.net/literature/<recid>

Optionally:
- Add external hosts to `research_team_config.json: references.allowed_external_hosts_extra`
  (audited exception mechanism; keep it narrow and justified in research_preflight.md).

Usage:
  python3 upgrade_reference_anchors.py --notes research_contract.md
  python3 upgrade_reference_anchors.py --notes research_contract.md --in-place
  python3 upgrade_reference_anchors.py --notes research_contract.md --add-host hepdata.net --config research_team_config.json --apply-config
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import urlsplit, urlunsplit


SECTION_PATTERNS = (
    r"^##\s+(?:\d+\.\s*)?References\b.*$",
    r"^##\s+(?:\d+\.\s*)?参考文献\b.*$",
)


_URL_RE = re.compile(r"https?://[^\s)>\"]+")


@dataclass(frozen=True)
class UrlChange:
    old: str
    new: str


def _find_section(text: str) -> tuple[str | None, int, int]:
    for pat in SECTION_PATTERNS:
        m = re.search(pat, text, flags=re.MULTILINE)
        if not m:
            continue
        start = m.end()
        m2 = re.search(r"^##\s+", text[start:], flags=re.MULTILINE)
        end = start + (m2.start() if m2 else len(text) - start)
        return text[start:end], start, end
    return None, -1, -1


def _strip_arxiv_version(arxiv_id: str) -> str:
    return re.sub(r"v\d+$", "", (arxiv_id or "").strip())


def _normalize_url(u: str) -> str:
    u = (u or "").strip().rstrip(".,;:")
    try:
        parts = urlsplit(u)
    except Exception:
        return u
    scheme = "https"
    host = (parts.netloc or "").lower().split(":", 1)[0]
    path = parts.path or ""
    query = parts.query or ""
    frag = parts.fragment or ""

    if host in ("dx.doi.org", "doi.org"):
        host = "doi.org"
        scheme = "https"

    if host == "export.arxiv.org":
        host = "arxiv.org"

    if host == "arxiv.org":
        # /pdf/<id>.pdf -> /abs/<id>
        m_pdf = re.match(r"^/pdf/([^/]+)\.pdf$", path)
        if m_pdf:
            arxiv_id = _strip_arxiv_version(m_pdf.group(1))
            path = f"/abs/{arxiv_id}"
            query = ""
            frag = ""
        # /abs/<id>vN -> /abs/<id>
        m_abs = re.match(r"^/abs/([^/]+)$", path)
        if m_abs:
            arxiv_id = _strip_arxiv_version(m_abs.group(1))
            path = f"/abs/{arxiv_id}"

    if host == "inspirehep.net":
        m_api = re.match(r"^/api/literature/(\d+)", path)
        if m_api:
            rid = m_api.group(1)
            path = f"/literature/{rid}"
            query = ""
            frag = ""

    return urlunsplit((scheme, host, path, query, frag))


def _rewrite_section(section: str) -> tuple[str, list[UrlChange]]:
    changes: list[UrlChange] = []

    def repl(m: re.Match[str]) -> str:
        old = m.group(0)
        new = _normalize_url(old)
        if new != old:
            changes.append(UrlChange(old=old, new=new))
        return new

    out = _URL_RE.sub(repl, section)
    return out, changes


def _normalize_host(s: str) -> str:
    s = (s or "").strip()
    if "://" in s:
        try:
            s = urlsplit(s).netloc
        except Exception:
            pass
    host = s.lower().split(":", 1)[0].strip()
    if host.startswith("www."):
        host = host[4:]
    return host


def _apply_config_hosts(config_path: Path, hosts: list[str]) -> None:
    raw = json.loads(config_path.read_text(encoding="utf-8", errors="replace"))
    if not isinstance(raw, dict):
        raise ValueError("config is not a JSON object")
    refs = raw.get("references")
    if not isinstance(refs, dict):
        refs = {}
        raw["references"] = refs
    extra = refs.get("allowed_external_hosts_extra")
    if not isinstance(extra, list):
        extra = []
        refs["allowed_external_hosts_extra"] = extra

    cur = {_normalize_host(str(x)) for x in extra if _normalize_host(str(x))}
    for h in hosts:
        hn = _normalize_host(h)
        if hn and hn not in cur:
            extra.append(hn)
            cur.add(hn)

    config_path.write_text(json.dumps(raw, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--notes", type=Path, required=True, help="Path to research_contract.md (or equivalent).")
    ap.add_argument("--in-place", action="store_true", help="Rewrite the file in place (default: dry-run).")
    ap.add_argument(
        "--config",
        type=Path,
        default=Path("research_team_config.json"),
        help="Config path for allowlist updates (default: research_team_config.json).",
    )
    ap.add_argument("--add-host", action="append", default=[], help="Host to add to references.allowed_external_hosts_extra.")
    ap.add_argument(
        "--apply-config",
        action="store_true",
        help="If set: actually update --config (otherwise only prints what would change).",
    )
    args = ap.parse_args()

    if not args.notes.is_file():
        print(f"ERROR: notes not found: {args.notes}", file=sys.stderr)
        return 2

    text = args.notes.read_text(encoding="utf-8", errors="replace").replace("\r\n", "\n").replace("\r", "\n")
    sec, a, b = _find_section(text)
    if sec is None:
        print("[skip] no ## References section found", file=sys.stderr)
        return 0

    new_sec, changes = _rewrite_section(sec)
    if not changes:
        print("[ok] no reference URL rewrites needed")
    else:
        print(f"[info] url rewrites: {len(changes)}")
        for ch in changes[:40]:
            print(f"- {ch.old} -> {ch.new}")
        if len(changes) > 40:
            print(f"- ... ({len(changes) - 40} more)")

    if args.in_place and changes:
        out = text[:a] + new_sec + text[b:]
        args.notes.write_text(out, encoding="utf-8")
        print(f"[ok] wrote: {args.notes}")

    hosts_to_add = [h for h in (args.add_host or []) if str(h).strip()]
    if hosts_to_add:
        cfg = args.config
        if not cfg.is_absolute():
            cfg = (args.notes.parent / cfg).resolve()
        if not cfg.is_file():
            print(f"[error] config not found: {cfg}", file=sys.stderr)
            return 2
        if args.apply_config:
            _apply_config_hosts(cfg, hosts_to_add)
            print(f"[ok] updated allowlist in: {cfg}")
        else:
            print("[dry-run] would add hosts to allowlist:")
            for h in hosts_to_add:
                print(f"- {h}")
            print("Use --apply-config to write changes.")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())

