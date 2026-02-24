#!/usr/bin/env python3
"""
Deterministic TeX draft preflight gate (domain-neutral).

Checks:
  - Citation keys used in TeX exist in the provided .bib (FAIL).
  - Missing \\label for referenced keys (WARN by default).
  - Missing \\includegraphics targets (WARN by default).
  - Missing KB notes for citations at knowledge_base/literature/<bibkey>.md (WARN by default).

This gate is intentionally "TeX-toolchain free": it does not compile the document.

Exit codes:
  0  ok (may include WARN)
  1  hard failures (e.g., missing bib keys)
  2  input/config errors
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "lib"))

from team_config import load_team_config  # type: ignore
from tex_draft import (  # type: ignore
    extract_occurrences,
    extract_graphicspath_dirs,
    extract_sections,
    flatten_tex,
    parse_bib_keys,
)


def _rel(root: Path, p: Path) -> str:
    try:
        return p.resolve().relative_to(root.resolve()).as_posix()
    except Exception:
        return p.as_posix()


def _resolve_graphics(
    occ_value: str,
    from_path: Path,
    main_dir: Path,
    graphic_dirs: list[Path],
) -> list[Path]:
    spec = (occ_value or "").strip().strip('"').strip("'")
    if not spec:
        return []
    if any(x in spec for x in ("{", "}", "$")):
        return []

    exts = [".pdf", ".png", ".jpg", ".jpeg", ".eps", ".svg"]
    base = Path(spec)
    if base.is_absolute():
        if base.suffix:
            return [base] if base.exists() else []
        found: list[Path] = []
        for ext in exts:
            cand = base.with_suffix(ext)
            if cand.exists():
                found.append(cand)
        return found

    # Search dirs (dedup, preserve order): local file dir, main dir, then graphicspath dirs.
    cand_dirs: list[Path] = []
    seen: set[Path] = set()
    for d in [from_path.parent, main_dir, *graphic_dirs]:
        try:
            rd = d.resolve()
        except Exception:
            rd = d
        if rd in seen:
            continue
        seen.add(rd)
        cand_dirs.append(rd)

    found: list[Path] = []
    for d in cand_dirs:
        cand = d / base
        if cand.suffix:
            if cand.exists():
                found.append(cand)
            continue
        for ext in exts:
            cand2 = cand.with_suffix(ext)
            if cand2.exists():
                found.append(cand2)
    if found:
        return found
    return []


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--tex", type=Path, required=True, help="Main TeX file (seed for include traversal).")
    ap.add_argument("--bib", type=Path, required=True, help="BibTeX file path.")
    ap.add_argument("--out-json", type=Path, default=None, help="Write a machine-readable structure map JSON (optional).")
    ap.add_argument("--out-report", type=Path, default=None, help="Write a Markdown preflight report (optional).")
    args = ap.parse_args()

    if not args.tex.is_file():
        print(f"[error] TeX file not found: {args.tex}")
        return 2
    if not args.bib.is_file():
        print(f"[error] Bib file not found: {args.bib}")
        return 2

    cfg = load_team_config(args.tex)
    kb_base = "knowledge_base"
    kl = cfg.data.get("knowledge_layers", {})
    if isinstance(kl, dict):
        kb_base = str(kl.get("base_dir", kb_base)).strip() or kb_base

    root = args.tex.parent.resolve()
    # Prefer config-root discovery for better relative links.
    if cfg.path is not None:
        root = cfg.path.parent.resolve()

    bib_keys, bib_msgs = parse_bib_keys(args.bib)
    for msg in bib_msgs:
        if msg.startswith("[error]"):
            print(msg)
        else:
            print(msg, file=sys.stderr)

    flat, edges, flat_warnings = flatten_tex(args.tex)
    for w in flat_warnings:
        print(w, file=sys.stderr)

    cites, labels, refs, figs = extract_occurrences(flat)
    graphicspath_occ = extract_graphicspath_dirs(flat)
    graphic_dirs: list[Path] = []
    for occ in graphicspath_occ:
        spec = (occ.value or "").strip().strip('"').strip("'")
        if not spec:
            continue
        if any(x in spec for x in ("\\", "{", "}", "$")):
            continue
        p = Path(spec)
        if not p.is_absolute():
            p = occ.path.parent / p
        if p.is_dir():
            graphic_dirs.append(p.resolve())
        else:
            print(f"[warn] graphicspath dir not found: {spec} (from {_rel(root, occ.path)}:{occ.line_no})", file=sys.stderr)
    sections = extract_sections(flat)

    cite_keys = sorted({c.value for c in cites if c.value.strip()})
    bib_missing = sorted([k for k in cite_keys if k not in bib_keys])

    label_keys = {x.value for x in labels}
    ref_keys = sorted({x.value for x in refs})
    missing_labels = sorted([k for k in ref_keys if k not in label_keys])

    missing_figs: list[dict] = []
    for occ in figs:
        resolved = _resolve_graphics(occ.value, occ.path, main_dir=args.tex.resolve().parent, graphic_dirs=graphic_dirs)
        if not resolved:
            missing_figs.append(
                {
                    "spec": occ.value,
                    "from": f"{_rel(root, occ.path)}:{occ.line_no}",
                }
            )

    kb_missing: list[str] = []
    kb_paths: dict[str, str] = {}
    for k in cite_keys:
        if "/" in k or "\\" in k:
            kb_paths[k] = ""
            kb_missing.append(k)
            continue
        p = root / kb_base / "literature" / f"{k}.md"
        kb_paths[k] = _rel(root, p)
        if not p.is_file():
            kb_missing.append(k)

    hard_fail = False
    if bib_missing:
        hard_fail = True
        print("[error] missing BibTeX entries for cited keys:")
        for k in bib_missing:
            print(f"- {k}")

    if missing_labels:
        print("[warn] unresolved references (missing \\label):", file=sys.stderr)
        for k in missing_labels[:50]:
            print(f"- {k}", file=sys.stderr)
        if len(missing_labels) > 50:
            print(f"- ... ({len(missing_labels) - 50} more)", file=sys.stderr)

    if missing_figs:
        print("[warn] missing figure files (\\includegraphics):", file=sys.stderr)
        for rec in missing_figs[:50]:
            print(f"- {rec['spec']} ({rec['from']})", file=sys.stderr)
        if len(missing_figs) > 50:
            print(f"- ... ({len(missing_figs) - 50} more)", file=sys.stderr)

    if kb_missing:
        print(f"[warn] missing KB literature notes under {kb_base}/literature/ (default WARN):", file=sys.stderr)
        for k in kb_missing[:50]:
            print(f"- {k}", file=sys.stderr)
        if len(kb_missing) > 50:
            print(f"- ... ({len(kb_missing) - 50} more)", file=sys.stderr)

    obj = {
        "version": 1,
        "tex_main": _rel(root, args.tex),
        "bib": _rel(root, args.bib),
        "kb_base_dir": kb_base,
        "include_edges": [
            {
                "kind": e.kind,
                "from": _rel(root, e.from_path),
                "to_spec": e.to_spec,
                "resolved": _rel(root, e.resolved_path) if e.resolved_path else None,
            }
            for e in edges
        ],
        "citations": {"used": cite_keys, "missing_in_bib": bib_missing},
        "labels": {"defined": sorted(label_keys), "refs": ref_keys, "missing": missing_labels},
        "figures": {"missing": missing_figs},
        "graphicspath": {"dirs": [_rel(root, p) for p in graphic_dirs]},
        "kb_notes": {"expected": kb_paths, "missing": kb_missing},
        "sections": [
            {
                "level": s.level,
                "command": s.command,
                "title": s.title,
                "start": {"file": _rel(root, s.path), "line": s.line_no},
                "end_idx": s.end_idx,
            }
            for s in sections
        ],
    }

    if args.out_json is not None:
        args.out_json.parent.mkdir(parents=True, exist_ok=True)
        args.out_json.write_text(json.dumps(obj, indent=2, sort_keys=True) + "\n", encoding="utf-8")
        print(f"[ok] wrote: {args.out_json}")

    if args.out_report is not None:
        args.out_report.parent.mkdir(parents=True, exist_ok=True)
        lines: list[str] = []
        lines.append("# Draft Preflight Report\n")
        lines.append(f"- TeX: `{_rel(root, args.tex)}`\n")
        lines.append(f"- Bib: `{_rel(root, args.bib)}`\n")
        lines.append(f"- KB base: `{kb_base}`\n")
        lines.append("\n## Summary\n")
        lines.append(f"- Cited keys: {len(cite_keys)} (missing in bib: {len(bib_missing)})\n")
        lines.append(f"- Missing labels: {len(missing_labels)} (WARN)\n")
        lines.append(f"- Missing figures: {len(missing_figs)} (WARN)\n")
        lines.append(f"- Graphic search dirs (from \\\\graphicspath): {len(graphic_dirs)}\n")
        lines.append(f"- Missing KB notes: {len(kb_missing)} (WARN)\n")

        if bib_missing:
            lines.append("\n## FAIL — Missing BibTeX Keys\n")
            for k in bib_missing:
                lines.append(f"- {k}\n")

        if missing_labels:
            lines.append("\n## WARN — Missing Labels For Refs\n")
            for k in missing_labels[:200]:
                lines.append(f"- {k}\n")
            if len(missing_labels) > 200:
                lines.append(f"- ... ({len(missing_labels) - 200} more)\n")

        if missing_figs:
            lines.append("\n## WARN — Missing Figures\n")
            for rec in missing_figs[:200]:
                lines.append(f"- `{rec['spec']}` ({rec['from']})\n")
            if len(missing_figs) > 200:
                lines.append(f"- ... ({len(missing_figs) - 200} more)\n")

        lines.append("\n## KB Literature Notes (Expected)\n")
        for k in cite_keys:
            relp = kb_paths.get(k, "")
            if relp:
                status = "MISSING" if k in kb_missing else "ok"
                lines.append(f"- {k}: [{relp}]({relp}) ({status})\n")
            else:
                lines.append(f"- {k}: (invalid key for path mapping) (MISSING)\n")

        args.out_report.write_text("".join(lines), encoding="utf-8")
        print(f"[ok] wrote: {args.out_report}")

    return 1 if hard_fail else 0


if __name__ == "__main__":
    raise SystemExit(main())
