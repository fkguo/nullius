#!/usr/bin/env python3
"""
check_latex_xrefs.py

Deterministic LaTeX cross-reference + citation integrity checker.

Goal: catch the mechanical reference/citation defects that a human proofreader
(and BibTeX/LaTeX only partially) misses until a compile pass — before handoff.

What it checks (over *.tex under --root, and/or explicit --tex files):

  Cross-references
  - Collect every \\label{...}.
  - Collect every reference-family use:
      \\ref \\eqref \\cref \\Cref \\autoref \\pageref \\nameref
    (\\cref/\\Cref accept comma-separated multi-target lists: \\cref{a,b,c}).
  - FAIL: a reference whose target key has no matching \\label (dangling ref).
  - FAIL: a \\label key defined more than once (duplicate label).
  - WARN: a \\label that is never referenced (unused label) — exit stays 0.

  Citations
  - Collect every \\cite-family use:
      \\cite \\citep \\citet \\citealp \\citeauthor \\citeyear
    (optional [..] pre/post-notes are skipped; keys may be comma-separated).
  - Available bib keys are the union of:
      * \\bibitem{key} keys found in the scanned .tex (thebibliography), and
      * @entry{key,...} keys from .bib files (auto-discovered next to the .tex,
        picked up from \\bibliography{...}, or passed via --bib).
  - FAIL: a citation whose key has no matching bib entry (undefined citation).

Notes:
- Comments are stripped first with an odd-parity backslash-run rule (a '%' is a
  comment iff the number of backslashes immediately before it is even), matching
  the sibling tools; a naive text[j-1]=='\\' check mishandles "\\\\%".
- If no bib source at all is discovered, the undefined-citation check is skipped
  (reported as a warning) rather than failing every citation — absence of a bib
  file is a different problem than a wrong key.

Exit codes:
  0  ok, or warnings only (e.g. unused labels)
  2  integrity failure (dangling ref, duplicate label, or undefined citation),
     or an input error (bad --root/--tex/--bib)
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Iterable


def _read_text(path: Path) -> str:
    return path.read_text(encoding="utf-8", errors="replace").replace("\r\n", "\n").replace("\r", "\n")


def _strip_latex_comments(text: str) -> str:
    """
    Best-effort comment stripping: remove '%' comments unless escaped as '\\%'.
    Not a full TeX parser; sufficient for a deterministic lint gate.
    """
    out_lines: list[str] = []
    for ln in text.splitlines():
        cut = None
        for i, ch in enumerate(ln):
            if ch != "%":
                continue
            # In TeX, '%' starts a comment unless escaped as '\%'.
            # If there are N backslashes immediately preceding '%':
            # - N odd  => '%' is escaped (literal percent)
            # - N even => '%' starts a comment (e.g. '\\%': linebreak then comment)
            j = i - 1
            n_bs = 0
            while j >= 0 and ln[j] == "\\":
                n_bs += 1
                j -= 1
            if n_bs % 2 == 0:
                cut = i
                break
        out_lines.append(ln[:cut] if cut is not None else ln)
    return "\n".join(out_lines) + ("\n" if text.endswith("\n") else "")


def _line_from_index(text: str, idx: int) -> int:
    if idx <= 0:
        return 1
    return text.count("\n", 0, idx) + 1


def _iter_tex_files(root: Path) -> Iterable[Path]:
    for p in sorted(root.rglob("*.tex")):
        if p.is_file():
            yield p


# --- reference/citation command families ---------------------------------

# Reference-family commands whose braced argument is a (comma-separated) list of
# label keys. \eqref/\autoref/\pageref/\nameref take a single key; \cref/\Cref
# accept multi-target lists, but splitting on commas is harmless for all of them.
_REF_COMMANDS = ("ref", "eqref", "cref", "Cref", "autoref", "pageref", "nameref")

# Citation-family commands whose braced argument is a comma-separated key list.
_CITE_COMMANDS = ("cite", "citep", "citet", "citealp", "citeauthor", "citeyear")

# \label{key}
_RE_LABEL = re.compile(r"\\label\s*\{([^}]*)\}")

# \bibitem[..]{key}
_RE_BIBITEM = re.compile(r"\\bibitem\s*(?:\[[^\]]*\])?\s*\{([^}]*)\}")

# \bibliography{a,b}  and  \addbibresource{a.bib}
_RE_BIBLIOGRAPHY = re.compile(r"\\bibliography\s*\{([^}]*)\}")
_RE_ADDBIBRESOURCE = re.compile(r"\\addbibresource\s*\{([^}]*)\}")

# @article{key, ...  — a BibTeX entry key. Same shape parsed by
# fix_bibtex_revtex4_2.py: entry type, an opening '{' or '(', then key up to ','.
# @string/@preamble/@comment are not citable keys and are excluded.
_RE_BIB_ENTRY = re.compile(r"@([A-Za-z]+)\s*[{(]\s*([^,\s{}()]+)\s*,")
_NON_KEY_ENTRY_TYPES = frozenset({"string", "preamble", "comment"})


def _ref_command_regex() -> re.Pattern[str]:
    # Longest-first so \Cref is not shadowed by a shorter alternative; a trailing
    # boundary (?![A-Za-z]) stops \ref from matching inside \reflectbox, etc.
    alt = "|".join(re.escape(c) for c in sorted(_REF_COMMANDS, key=len, reverse=True))
    return re.compile(r"\\(" + alt + r")(?![A-Za-z])\s*\{([^}]*)\}")


def _cite_command_regex() -> re.Pattern[str]:
    alt = "|".join(re.escape(c) for c in sorted(_CITE_COMMANDS, key=len, reverse=True))
    # Skip up to two optional bracket args (pre-note / post-note) before the keys.
    return re.compile(r"\\(" + alt + r")(?![A-Za-z])\s*(?:\[[^\]]*\]\s*){0,2}\{([^}]*)\}")


def _split_keys(arg: str) -> list[str]:
    """Split a braced argument into individual, whitespace-trimmed keys."""
    return [k.strip() for k in arg.split(",") if k.strip()]


# --- data model ----------------------------------------------------------

@dataclass(frozen=True)
class Use:
    key: str
    command: str
    path: str
    line: int


@dataclass(frozen=True)
class Finding:
    kind: str        # "dangling_ref" | "duplicate_label" | "unused_label" | "undefined_citation"
    severity: str    # "error" | "warning"
    key: str
    command: str
    path: str
    line: int
    detail: str


@dataclass
class Result:
    findings: list[Finding] = field(default_factory=list)
    n_tex: int = 0
    n_labels: int = 0
    n_refs: int = 0
    n_cites: int = 0
    n_bib_keys: int = 0
    bib_sources: list[str] = field(default_factory=list)
    cite_check_skipped: bool = False

    @property
    def errors(self) -> list[Finding]:
        return [f for f in self.findings if f.severity == "error"]

    @property
    def warnings(self) -> list[Finding]:
        return [f for f in self.findings if f.severity == "warning"]

    @property
    def ok(self) -> bool:
        return not self.errors


def _extract_labels(text: str, path: str) -> list[Use]:
    out: list[Use] = []
    for m in _RE_LABEL.finditer(text):
        key = m.group(1).strip()
        if not key:
            continue
        out.append(Use(key=key, command="label", path=path, line=_line_from_index(text, m.start())))
    return out


def _extract_refs(text: str, path: str, ref_re: re.Pattern[str]) -> list[Use]:
    out: list[Use] = []
    for m in ref_re.finditer(text):
        cmd = m.group(1)
        line = _line_from_index(text, m.start())
        for key in _split_keys(m.group(2)):
            out.append(Use(key=key, command=cmd, path=path, line=line))
    return out


def _extract_cites(text: str, path: str, cite_re: re.Pattern[str]) -> list[Use]:
    out: list[Use] = []
    for m in cite_re.finditer(text):
        cmd = m.group(1)
        line = _line_from_index(text, m.start())
        for key in _split_keys(m.group(2)):
            # A '*' variant of \cite has no key list; guard against stray '*'.
            if key == "*":
                continue
            out.append(Use(key=key, command=cmd, path=path, line=line))
    return out


def _extract_bibitem_keys(text: str) -> set[str]:
    return {m.group(1).strip() for m in _RE_BIBITEM.finditer(text) if m.group(1).strip()}


def _extract_bib_entry_keys(bib_text: str) -> set[str]:
    keys: set[str] = set()
    for m in _RE_BIB_ENTRY.finditer(bib_text):
        entry_type = m.group(1).lower()
        if entry_type in _NON_KEY_ENTRY_TYPES:
            continue
        key = m.group(2).strip()
        if key:
            keys.add(key)
    return keys


def _discover_bib_paths(tex_files: list[Path], text_by_path: dict[Path, str], explicit: list[Path]) -> list[Path]:
    """
    Collect .bib paths from:
      - explicit --bib arguments,
      - \\bibliography{...} / \\addbibresource{...} declarations (resolved
        relative to the declaring .tex, with a '.bib' suffix as needed),
      - any *.bib sitting in a directory that contains a scanned .tex.
    Returns a deterministic, de-duplicated, existence-filtered list.
    """
    found: list[Path] = []
    seen: set[Path] = set()

    def _add(p: Path) -> None:
        rp = p.expanduser().resolve()
        if rp in seen:
            return
        if rp.is_file():
            seen.add(rp)
            found.append(rp)

    for p in explicit:
        _add(p)

    for tex in tex_files:
        text = text_by_path[tex]
        names: list[str] = []
        for m in _RE_BIBLIOGRAPHY.finditer(text):
            names.extend(_split_keys(m.group(1)))
        for m in _RE_ADDBIBRESOURCE.finditer(text):
            names.extend(_split_keys(m.group(1)))
        for name in names:
            cand = (tex.parent / name)
            if cand.suffix.lower() != ".bib":
                cand = cand.with_name(cand.name + ".bib")
            _add(cand)

    # Fallback: any .bib next to a scanned .tex (deterministic by sorted dir set).
    for d in sorted({tex.parent for tex in tex_files}):
        for bib in sorted(d.glob("*.bib")):
            _add(bib)

    return found


def evaluate(*, tex_files: list[Path], bib_files: list[Path]) -> Result:
    """
    Core, side-effect-free integrity evaluation. Ordering of findings is
    deterministic: by (kind, path, line, key).
    """
    ref_re = _ref_command_regex()
    cite_re = _cite_command_regex()

    tex_files = sorted(set(tex_files))
    text_by_path: dict[Path, str] = {p: _strip_latex_comments(_read_text(p)) for p in tex_files}

    labels: list[Use] = []
    refs: list[Use] = []
    cites: list[Use] = []
    bibitem_keys: set[str] = set()

    for p in tex_files:
        text = text_by_path[p]
        rel = str(p)
        labels.extend(_extract_labels(text, rel))
        refs.extend(_extract_refs(text, rel, ref_re))
        cites.extend(_extract_cites(text, rel, cite_re))
        bibitem_keys |= _extract_bibitem_keys(text)

    bib_paths = _discover_bib_paths(tex_files, text_by_path, bib_files)
    bib_entry_keys: set[str] = set()
    for bp in bib_paths:
        bib_entry_keys |= _extract_bib_entry_keys(_read_text(bp))

    available_bib_keys = bibitem_keys | bib_entry_keys
    have_bib_source = bool(bibitem_keys) or bool(bib_paths)

    # Label defined-set + duplicate detection (deterministic scan order).
    label_lines: dict[str, list[Use]] = {}
    for u in labels:
        label_lines.setdefault(u.key, []).append(u)
    defined_labels = set(label_lines)

    findings: list[Finding] = []

    # Duplicate labels: flag every occurrence after the first (stable order).
    for key in sorted(label_lines):
        uses = label_lines[key]
        if len(uses) < 2:
            continue
        first = uses[0]
        for dup in uses[1:]:
            findings.append(
                Finding(
                    kind="duplicate_label",
                    severity="error",
                    key=key,
                    command="label",
                    path=dup.path,
                    line=dup.line,
                    detail=f"label {key!r} redefined (first defined at {first.path}:{first.line})",
                )
            )

    # Dangling references: a ref whose key has no matching label.
    referenced_keys: set[str] = set()
    for u in refs:
        referenced_keys.add(u.key)
        if u.key not in defined_labels:
            findings.append(
                Finding(
                    kind="dangling_ref",
                    severity="error",
                    key=u.key,
                    command=u.command,
                    path=u.path,
                    line=u.line,
                    detail=f"\\{u.command}{{{u.key}}} has no matching \\label",
                )
            )

    # Unused labels: defined but never referenced (warning only).
    for key in sorted(defined_labels):
        if key in referenced_keys:
            continue
        first = label_lines[key][0]
        findings.append(
            Finding(
                kind="unused_label",
                severity="warning",
                key=key,
                command="label",
                path=first.path,
                line=first.line,
                detail=f"label {key!r} is defined but never referenced",
            )
        )

    # Undefined citations: a cite whose key has no bib entry.
    if not have_bib_source:
        cite_check_skipped = True
    else:
        cite_check_skipped = False
        for u in cites:
            if u.key not in available_bib_keys:
                findings.append(
                    Finding(
                        kind="undefined_citation",
                        severity="error",
                        key=u.key,
                        command=u.command,
                        path=u.path,
                        line=u.line,
                        detail=f"\\{u.command}{{{u.key}}} has no bib entry (\\bibitem or @entry)",
                    )
                )

    findings.sort(key=lambda f: (f.kind, f.path, f.line, f.key))

    res = Result(
        findings=findings,
        n_tex=len(tex_files),
        n_labels=len(defined_labels),
        n_refs=len(refs),
        n_cites=len(cites),
        n_bib_keys=len(available_bib_keys),
        bib_sources=[str(p) for p in bib_paths],
        cite_check_skipped=cite_check_skipped,
    )
    return res


def _result_to_dict(res: Result) -> dict:
    return {
        "ok": res.ok,
        "summary": {
            "n_tex": res.n_tex,
            "n_labels": res.n_labels,
            "n_refs": res.n_refs,
            "n_cites": res.n_cites,
            "n_bib_keys": res.n_bib_keys,
            "n_errors": len(res.errors),
            "n_warnings": len(res.warnings),
            "cite_check_skipped": res.cite_check_skipped,
            "bib_sources": res.bib_sources,
        },
        "findings": [
            {
                "kind": f.kind,
                "severity": f.severity,
                "key": f.key,
                "command": f.command,
                "path": f.path,
                "line": f.line,
                "detail": f.detail,
            }
            for f in res.findings
        ],
    }


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--root", type=Path, default=None, help="Scan all *.tex under this directory (recursive).")
    ap.add_argument("--tex", type=Path, action="append", default=[], help="Scan a specific .tex file (can repeat).")
    ap.add_argument("--bib", type=Path, action="append", default=[], help="Explicit .bib file for citation keys (can repeat). Auto-discovered otherwise.")
    ap.add_argument("--json", action="store_true", help="Emit a machine-readable JSON summary on stdout instead of text.")
    args = ap.parse_args()

    tex_files: list[Path] = []
    if args.root is not None:
        root = args.root.expanduser().resolve()
        if not root.is_dir():
            print(f"ERROR: --root is not a directory: {root}", file=sys.stderr)
            return 2
        tex_files.extend(list(_iter_tex_files(root)))
    for p in args.tex:
        pp = p.expanduser().resolve()
        if not pp.is_file():
            print(f"ERROR: --tex not found: {pp}", file=sys.stderr)
            return 2
        tex_files.append(pp)

    if not tex_files:
        print("ERROR: provide --root or --tex (no .tex files to scan)", file=sys.stderr)
        return 2
    tex_files = sorted(set(tex_files))

    bib_files: list[Path] = []
    for p in args.bib:
        pp = p.expanduser().resolve()
        if not pp.is_file():
            print(f"ERROR: --bib not found: {pp}", file=sys.stderr)
            return 2
        bib_files.append(pp)

    res = evaluate(tex_files=tex_files, bib_files=bib_files)

    if args.json:
        print(json.dumps(_result_to_dict(res), indent=2, sort_keys=False))
        return 0 if res.ok else 2

    for f in res.errors:
        print(f"[latex-xrefs] ERROR [{f.kind}] {f.path}:{f.line} — {f.detail}")
    for f in res.warnings:
        print(f"[latex-xrefs] warning [{f.kind}] {f.path}:{f.line} — {f.detail}")
    if res.cite_check_skipped and res.n_cites:
        print(
            f"[latex-xrefs] warning: undefined-citation check skipped "
            f"({res.n_cites} citation(s) found but no \\bibitem or .bib source discovered)"
        )

    if not res.ok:
        print(
            f"[latex-xrefs] FAIL: {len(res.errors)} error(s) across {res.n_tex} tex file(s) "
            f"(labels={res.n_labels}, refs={res.n_refs}, cites={res.n_cites}, bib_keys={res.n_bib_keys})"
        )
        return 2

    print(
        f"[latex-xrefs] ok: {res.n_tex} tex file(s); labels={res.n_labels}, refs={res.n_refs}, "
        f"cites={res.n_cites}, bib_keys={res.n_bib_keys}"
        + (f"; {len(res.warnings)} warning(s)" if res.warnings else "")
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
