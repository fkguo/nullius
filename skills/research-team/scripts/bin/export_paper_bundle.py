#!/usr/bin/env python3
from __future__ import annotations

import argparse
import os
import re
import shutil
import sys
from pathlib import Path


def _norm_text(s: str) -> str:
    return s.replace("\r\n", "\n").replace("\r", "\n")


def _safe_tag(tag: str) -> str:
    return re.sub(r"[^A-Za-z0-9._-]+", "_", tag.strip())


def _find_project_root(seed: Path) -> Path:
    cur = seed.resolve()
    if cur.is_file():
        cur = cur.parent
    for _ in range(10):
        if (cur / "PROJECT_CHARTER.md").is_file() and (cur / "Draft_Derivation.md").is_file():
            return cur
        if cur.parent == cur:
            break
        cur = cur.parent
    return seed.resolve() if seed.is_dir() else seed.parent.resolve()


def _copy_file(src: Path, dst: Path) -> None:
    dst.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(src, dst)


def _copy_tree(src_dir: Path, dst_dir: Path) -> None:
    if dst_dir.exists():
        shutil.rmtree(dst_dir)
    shutil.copytree(src_dir, dst_dir)


def _detect_team_run_dir(project_root: Path, team_dir: Path, safe_tag: str) -> Path | None:
    cand = team_dir / "runs" / safe_tag
    if cand.is_dir():
        return cand
    # Fallback: older layouts / user-provided out-dir without runs/.
    if team_dir.is_dir():
        any_match = any((team_dir / f"{safe_tag}_member_a.md").is_file(), (team_dir / f"{safe_tag}_member_b.md").is_file())
        if any_match:
            return team_dir
    return None


def _detect_artifacts_run_dir(project_root: Path, safe_tag: str) -> Path | None:
    cand = project_root / "artifacts" / "runs" / safe_tag
    if cand.is_dir():
        return cand
    cand = project_root / "artifacts" / safe_tag
    if cand.is_dir():
        return cand
    return None


_RE_INPUT = re.compile(r"\\(?:input|include)\s*\{\s*([^}]+?)\s*\}")
_RE_GRAPHICS = re.compile(r"\\includegraphics(?:\[[^\]]*\])?\s*\{\s*([^}]+?)\s*\}")


def _resolve_tex_path(base_dir: Path, raw: str) -> Path | None:
    raw = raw.strip()
    if not raw:
        return None
    p = Path(raw)
    if not p.suffix:
        p = p.with_suffix(".tex")
    if not p.is_absolute():
        p = base_dir / p
    return p.resolve()


def _resolve_graphics_path(base_dir: Path, raw: str) -> list[Path]:
    raw = raw.strip()
    if not raw:
        return []
    p = Path(raw)
    candidates: list[Path] = []
    if p.suffix:
        candidates.append(p)
    else:
        for ext in (".pdf", ".png", ".jpg", ".jpeg", ".eps"):
            candidates.append(Path(raw + ext))
    out: list[Path] = []
    for c in candidates:
        q = c
        if not q.is_absolute():
            q = base_dir / q
        q = q.resolve()
        if q.is_file():
            out.append(q)
    return out


def collect_tex_dependencies(main_tex: Path) -> tuple[list[Path], list[str]]:
    """
    Best-effort dependency collection for a LaTeX source tree:
    - follows \\input{...} / \\include{...} recursively
    - collects \\includegraphics{...} files (common extensions if omitted)

    This is intentionally simple and deterministic; it will not expand macros.
    """
    warnings: list[str] = []
    seen: set[Path] = set()
    stack: list[Path] = [main_tex.resolve()]
    deps: list[Path] = []

    while stack:
        tex = stack.pop()
        if tex in seen:
            continue
        seen.add(tex)
        if not tex.is_file():
            warnings.append(f"missing TeX input: {tex}")
            continue
        deps.append(tex)
        base = tex.parent
        text = _norm_text(tex.read_text(encoding="utf-8", errors="replace"))

        for m in _RE_INPUT.finditer(text):
            child = _resolve_tex_path(base, m.group(1))
            if child is not None:
                stack.append(child)

        for m in _RE_GRAPHICS.finditer(text):
            for img in _resolve_graphics_path(base, m.group(1)):
                if img not in seen and img.is_file():
                    deps.append(img)

    # Dedup while keeping order.
    uniq: list[Path] = []
    seen2: set[Path] = set()
    for p in deps:
        if p in seen2:
            continue
        seen2.add(p)
        uniq.append(p)
    return uniq, warnings


def main() -> int:
    ap = argparse.ArgumentParser(description="Export a minimal writing-friendly bundle for a given tag.")
    ap.add_argument("--tag", required=True, help="Tag to export (e.g. M3-r1).")
    ap.add_argument("--out", default="export", help="Output directory for bundles (default: export).")
    ap.add_argument("--team-dir", default="team", help="Team directory (default: team).")
    ap.add_argument("--tex", default="", help="Optional main.tex to include (best-effort dependency copy).")
    ap.add_argument("--bib", default="", help="Optional .bib file to include.")
    ap.add_argument("--force", action="store_true", help="Overwrite the destination bundle directory if it exists.")
    args = ap.parse_args()

    tag = args.tag.strip()
    safe = _safe_tag(tag)
    project_root = _find_project_root(Path.cwd())
    team_dir = (project_root / args.team_dir).resolve()
    out_base = (project_root / args.out).resolve()
    bundle_dir = out_base / f"paper_bundle_{safe}"

    if bundle_dir.exists():
        if not args.force:
            print(f"ERROR: bundle already exists: {bundle_dir} (use --force to overwrite)", file=sys.stderr)
            return 2
        shutil.rmtree(bundle_dir)

    bundle_dir.mkdir(parents=True, exist_ok=True)

    copied: list[str] = []
    missing: list[str] = []
    notes: list[str] = []

    # Core docs.
    docs_dir = bundle_dir / "docs"
    for name in ("PROJECT_MAP.md", "PROJECT_CHARTER.md", "RESEARCH_PLAN.md", "PREWORK.md", "Draft_Derivation.md"):
        src = project_root / name
        if src.is_file():
            _copy_file(src, docs_dir / name)
            copied.append(f"docs/{name}")
        else:
            missing.append(name)

    # Team pointers + trajectory + run directory.
    team_out = bundle_dir / "team"
    if team_dir.is_dir():
        for name in ("LATEST.md", "LATEST_TEAM.md", "LATEST_DRAFT.md", "trajectory_index.json"):
            src = team_dir / name
            if src.is_file():
                _copy_file(src, team_out / name)
                copied.append(f"team/{name}")
        run_dir = _detect_team_run_dir(project_root, team_dir, safe)
        if run_dir is not None and run_dir.is_dir():
            if run_dir == team_dir:
                # Old layout: copy only tag-matched files to avoid pulling in unrelated history.
                dst_run = team_out / "runs" / safe
                dst_run.mkdir(parents=True, exist_ok=True)
                for p in sorted(team_dir.iterdir()):
                    if not p.is_file():
                        continue
                    if p.name.startswith(f"{safe}_") or p.name == f"team_packet_{safe}.txt":
                        _copy_file(p, dst_run / p.name)
                        copied.append(f"team/runs/{safe}/{p.name}")
            else:
                dst_run = team_out / "runs" / safe
                _copy_tree(run_dir, dst_run)
                copied.append(f"team/runs/{safe}/ (dir)")
    else:
        notes.append(f"[warn] team dir not found: {team_dir}")

    # Artifacts.
    art_run = _detect_artifacts_run_dir(project_root, safe)
    if art_run is not None and art_run.is_dir():
        dst_art = bundle_dir / "artifacts" / "runs" / safe
        _copy_tree(art_run, dst_art)
        copied.append(f"artifacts/runs/{safe}/ (dir)")
    else:
        notes.append("[warn] artifacts dir for tag not found (skipped)")

    # TeX sources (optional).
    if args.tex:
        main_tex = (project_root / args.tex).resolve() if not Path(args.tex).is_absolute() else Path(args.tex).resolve()
        if not main_tex.is_file():
            notes.append(f"[warn] tex not found: {main_tex} (skipped)")
        else:
            deps, warn = collect_tex_dependencies(main_tex)
            notes.extend([f"[warn] {w}" for w in warn])
            paper_dir = bundle_dir / "paper"
            for p in deps:
                try:
                    rel = p.relative_to(project_root)
                except Exception:
                    notes.append(f"[warn] tex dependency outside project root (skipped): {p}")
                    continue
                _copy_file(p, paper_dir / rel)
                copied.append(f"paper/{rel.as_posix()}")

    if args.bib:
        bib = (project_root / args.bib).resolve() if not Path(args.bib).is_absolute() else Path(args.bib).resolve()
        if bib.is_file():
            _copy_file(bib, bundle_dir / "paper" / bib.name)
            copied.append(f"paper/{bib.name}")
        else:
            notes.append(f"[warn] bib not found: {bib} (skipped)")

    # Write manifest.
    manifest = bundle_dir / "MANIFEST.md"
    lines: list[str] = []
    lines.append(f"# Paper Bundle — {safe}")
    lines.append("")
    lines.append(f"- Project root: {project_root}")
    lines.append(f"- Source tag (raw): {tag}")
    lines.append(f"- Bundle tag (safe): {safe}")
    lines.append("")
    lines.append("## Contents")
    lines.append("")
    for item in copied:
        lines.append(f"- {item}")
    if missing:
        lines.append("")
        lines.append("## Missing (not found in project root)")
        lines.append("")
        for m in missing:
            lines.append(f"- {m}")
    if notes:
        lines.append("")
        lines.append("## Notes")
        lines.append("")
        for n in notes:
            lines.append(f"- {n}")
    lines.append("")
    lines.append("## How to use")
    lines.append("")
    lines.append("- Start from `docs/PROJECT_MAP.md` and `docs/Draft_Derivation.md`.")
    lines.append("- Use `team/LATEST_TEAM.md` for the latest team-cycle audit, and `team/LATEST_DRAFT.md` for draft-cycle review.")
    lines.append("")
    manifest.write_text("\n".join(lines) + "\n", encoding="utf-8")

    print(f"[ok] wrote bundle: {bundle_dir}")
    print(f"[ok] wrote manifest: {manifest}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

