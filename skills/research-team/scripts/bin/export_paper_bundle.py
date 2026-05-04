#!/usr/bin/env python3
from __future__ import annotations

import argparse
import os
import re
import shutil
import sys
from pathlib import Path

AUTO_START = "<!-- PROJECT_INDEX_AUTO_START -->"
AUTO_END = "<!-- PROJECT_INDEX_AUTO_END -->"


def _norm_text(s: str) -> str:
    return s.replace("\r\n", "\n").replace("\r", "\n")


def _safe_tag(tag: str) -> str:
    return re.sub(r"[^A-Za-z0-9._-]+", "_", tag.strip())


def _find_project_root(seed: Path) -> Path:
    cur = seed.resolve()
    if cur.is_file():
        cur = cur.parent
    for _ in range(10):
        if (cur / "project_charter.md").is_file() and (cur / "research_contract.md").is_file():
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


def _write_text(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(_norm_text(text), encoding="utf-8")


def _extract_pointer_field(text: str, prefix: str) -> str:
    needle = prefix.lower()
    for line in text.splitlines():
        stripped = line.strip()
        if stripped.lower().startswith(needle):
            return stripped.split(":", 1)[1].strip()
    return ""


def _detect_team_run_dir(project_root: Path, team_dir: Path, safe_tag: str) -> Path | None:
    cand = team_dir / "runs" / safe_tag
    if cand.is_dir():
        return cand
    # Fallback: older layouts / user-provided out-dir without runs/.
    if team_dir.is_dir():
        any_match = (team_dir / f"{safe_tag}_member_a.md").is_file() or (team_dir / f"{safe_tag}_member_b.md").is_file()
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


def _copy_latest_pointer_if_live(
    src: Path,
    dst: Path,
    *,
    label: str,
    requested_tag: str,
    requested_safe_tag: str,
    target_exists: bool,
    notes: list[str],
) -> bool:
    if not src.is_file():
        return False
    pointer_tag = _extract_pointer_field(_norm_text(src.read_text(encoding="utf-8", errors="replace")), "- Latest tag:")
    if not pointer_tag:
        notes.append(f"[warn] skipped {label}: could not parse - Latest tag:")
        return False
    if pointer_tag not in {requested_tag, requested_safe_tag}:
        notes.append(
            f"[warn] skipped {label}: pointer tag {pointer_tag} does not match requested tag {requested_tag}"
        )
        return False
    if not target_exists:
        notes.append(f"[warn] skipped {label}: missing target for pointer tag {pointer_tag}")
        return False
    _copy_file(src, dst)
    return True


def _write_team_latest_index(
    dst: Path,
    *,
    include_team: bool,
    include_draft: bool,
    include_trajectory: bool,
) -> None:
    lines: list[str] = []
    lines.append("# Latest pointers")
    lines.append("")
    if include_team:
        lines.append("- Team cycle: [LATEST_TEAM.md](LATEST_TEAM.md)")
    if include_draft:
        lines.append("- Draft cycle: [LATEST_DRAFT.md](LATEST_DRAFT.md)")
    if include_trajectory:
        lines.append("- Trajectory index: [trajectory_index.json](trajectory_index.json)")
    _write_text(dst, "\n".join(lines) + "\n")


def _sanitize_project_index_optional_auto_lines(
    text: str,
    *,
    keep_team: bool,
    keep_draft: bool,
    keep_artifacts: bool,
) -> str:
    def should_drop(line: str) -> bool:
        stripped = line.strip().lower()
        if stripped.startswith("- team latest tag:") or stripped.startswith("- team latest status:"):
            return not keep_team
        if stripped.startswith("- latest team:"):
            return not keep_team
        if stripped.startswith("- draft latest tag:") or stripped.startswith("- draft latest status:"):
            return not keep_draft
        if stripped.startswith("- latest draft:"):
            return not keep_draft
        if stripped.startswith("- latest artifacts:"):
            return not keep_artifacts
        return False

    def sanitize_block(block: str) -> str:
        kept = [line for line in block.splitlines() if not should_drop(line)]
        return "\n".join(kept).rstrip("\n")

    if AUTO_START in text and AUTO_END in text:
        start = text.index(AUTO_START) + len(AUTO_START)
        end = text.index(AUTO_END)
        sanitized = sanitize_block(text[start:end])
        return text[:start] + "\n" + sanitized + ("\n" if sanitized else "") + text[end:]

    kept_lines = [line for line in text.splitlines() if not should_drop(line)]
    return "\n".join(kept_lines) + ("\n" if text.endswith("\n") else "")


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
    copied_team_latest = False
    copied_team_cycle = False
    copied_draft_cycle = False
    copied_artifacts_latest = False
    copied_trajectory = False

    # Core docs.
    docs_dir = bundle_dir / "docs"
    for name in ("project_index.md", "project_charter.md", "research_plan.md", "research_preflight.md", "research_contract.md"):
        src = project_root / name
        if src.is_file():
            _copy_file(src, docs_dir / name)
            copied.append(f"docs/{name}")
        else:
            missing.append(name)

    # Team pointers + trajectory + run directory.
    team_out = bundle_dir / "team"
    if team_dir.is_dir():
        run_dir = _detect_team_run_dir(project_root, team_dir, safe)
        latest_index = team_dir / "LATEST.md"
        team_latest = team_dir / "LATEST_TEAM.md"
        if _copy_latest_pointer_if_live(
            team_latest,
            team_out / "LATEST_TEAM.md",
            label="team/LATEST_TEAM.md",
            requested_tag=tag,
            requested_safe_tag=safe,
            target_exists=run_dir is not None and run_dir.is_dir(),
            notes=notes,
        ):
            copied.append("team/LATEST_TEAM.md")
            copied_team_cycle = True
        draft_latest = team_dir / "LATEST_DRAFT.md"
        if _copy_latest_pointer_if_live(
            draft_latest,
            team_out / "LATEST_DRAFT.md",
            label="team/LATEST_DRAFT.md",
            requested_tag=tag,
            requested_safe_tag=safe,
            target_exists=run_dir is not None and run_dir.is_dir(),
            notes=notes,
        ):
            copied.append("team/LATEST_DRAFT.md")
            copied_draft_cycle = True
        trajectory = team_dir / "trajectory_index.json"
        if trajectory.is_file():
            _copy_file(trajectory, team_out / "trajectory_index.json")
            copied.append("team/trajectory_index.json")
            copied_trajectory = True
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
        if latest_index.is_file() or copied_team_cycle or copied_draft_cycle or copied_trajectory:
            _write_team_latest_index(
                team_out / "LATEST.md",
                include_team=copied_team_cycle,
                include_draft=copied_draft_cycle,
                include_trajectory=copied_trajectory,
            )
            copied.append("team/LATEST.md")
            copied_team_latest = True
    else:
        notes.append(f"[warn] team dir not found: {team_dir}")

    # Artifacts.
    art_latest = project_root / "artifacts" / "LATEST.md"
    art_run = _detect_artifacts_run_dir(project_root, safe)
    if _copy_latest_pointer_if_live(
        art_latest,
        bundle_dir / "artifacts" / "LATEST.md",
        label="artifacts/LATEST.md",
        requested_tag=tag,
        requested_safe_tag=safe,
        target_exists=art_run is not None and art_run.is_dir(),
        notes=notes,
    ):
        copied.append("artifacts/LATEST.md")
        copied_artifacts_latest = True
    if art_run is not None and art_run.is_dir():
        dst_art = bundle_dir / "artifacts" / "runs" / safe
        _copy_tree(art_run, dst_art)
        copied.append(f"artifacts/runs/{safe}/ (dir)")
    else:
        notes.append("[warn] artifacts dir for tag not found (skipped)")

    project_index_out = docs_dir / "project_index.md"
    if project_index_out.is_file():
        project_index_out.write_text(
            _sanitize_project_index_optional_auto_lines(
                _norm_text(project_index_out.read_text(encoding="utf-8", errors="replace")),
                keep_team=copied_team_cycle,
                keep_draft=copied_draft_cycle,
                keep_artifacts=copied_artifacts_latest,
            ),
            encoding="utf-8",
        )

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
    lines.append("- Start from `docs/project_index.md` and `docs/research_contract.md`.")
    if copied_team_latest:
        lines.append("- Use `team/LATEST.md` as the pointer index for bundled team surfaces.")
    if copied_team_cycle:
        lines.append("- Use `team/LATEST_TEAM.md` for the latest bundled team-cycle audit.")
    if copied_draft_cycle:
        lines.append("- Use `team/LATEST_DRAFT.md` for the latest bundled draft-cycle review.")
    if copied_artifacts_latest:
        lines.append("- Use `artifacts/LATEST.md` for the latest bundled artifact pointer.")
    lines.append("")
    manifest.write_text("\n".join(lines) + "\n", encoding="utf-8")

    print(f"[ok] wrote bundle: {bundle_dir}")
    print(f"[ok] wrote manifest: {manifest}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
