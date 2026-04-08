#!/usr/bin/env python3
"""
Prune optional scaffold artifacts from an existing research-team project.

This tool is intended to reduce clutter in projects that were scaffolded with
the full template set (wrappers/prompts/scaffolds) but later only use a subset.

Safety policy (default):
- Dry-run by default (no moves).
- Never deletes; moves into an archive directory under the project root.
- Only prunes files/dirs that match the current scaffold templates
  (after placeholder substitution when applicable).
- If the project is a git repo, never prunes git-modified/staged files.

Exit codes:
  0  success (dry-run or apply)
  1  runtime error
  2  usage / input error
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from pathlib import Path


@dataclass
class ItemResult:
    kind: str  # "file" | "dir"
    component: str
    path: str
    status: str  # "missing" | "skip" | "plan_move" | "moved" | "error"
    reason: str
    archive_path: str = ""
    git_porcelain: str = ""


def _now_utc_slug() -> str:
    return datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")


def _read_text(path: Path) -> str:
    return path.read_text(encoding="utf-8", errors="replace").replace("\r\n", "\n").replace("\r", "\n")


def _normalize_for_compare(text: str) -> str:
    # Keep comparison strict but robust to line endings + trailing whitespace.
    lines = [ln.rstrip() for ln in text.replace("\r\n", "\n").replace("\r", "\n").split("\n")]
    return "\n".join(lines).rstrip() + "\n"


def _root_variants(project_root: Path) -> tuple[str, ...]:
    vals = {str(project_root), os.path.abspath(str(project_root)), os.path.realpath(str(project_root))}
    extra: set[str] = set()
    for v in list(vals):
        if v.startswith("/private/var/"):
            extra.add(v.replace("/private/var/", "/var/", 1))
        elif v.startswith("/var/"):
            extra.add(v.replace("/var/", "/private/var/", 1))
    vals.update(extra)
    return tuple(sorted((v for v in vals if v), key=len, reverse=True))


def _normalize_project_root_variants(text: str, project_root: Path) -> str:
    out = text
    for root in _root_variants(project_root):
        out = out.replace(root, "<PROJECT_ROOT>")
    return out


def _canonicalize_project_root_value(value: object, project_root: Path) -> object:
    if isinstance(value, str):
        return _normalize_project_root_variants(value, project_root)
    if isinstance(value, list):
        return [_canonicalize_project_root_value(v, project_root) for v in value]
    if isinstance(value, dict):
        return {str(k): _canonicalize_project_root_value(v, project_root) for k, v in value.items()}
    return value


def _is_git_repo(root: Path) -> bool:
    try:
        r = subprocess.run(
            ["git", "rev-parse", "--is-inside-work-tree"],
            cwd=str(root),
            capture_output=True,
            text=True,
            check=False,
        )
        return r.returncode == 0 and r.stdout.strip().lower() == "true"
    except Exception:
        return False


def _git_status_porcelain(root: Path, rel: str) -> str:
    try:
        r = subprocess.run(
            ["git", "status", "--porcelain", "--", rel],
            cwd=str(root),
            capture_output=True,
            text=True,
            check=False,
        )
        if r.returncode != 0:
            return ""
        return (r.stdout or "").strip()
    except Exception:
        return ""


def _render_template(template_text: str, *, project_name: str, project_root: Path, profile: str) -> str:
    out = template_text
    out = out.replace("<PROJECT_NAME>", project_name)
    out = out.replace("<PROJECT_ROOT>", str(project_root))
    out = out.replace("<PROFILE>", profile)
    return out


def _extract_project_name(project_root: Path) -> str:
    charter = project_root / "project_charter.md"
    if not charter.is_file():
        return project_root.name
    text = _read_text(charter)
    m = re.search(r"^\s*Project\s*:\s*(.+?)\s*$", text, flags=re.MULTILINE)
    if m:
        name = m.group(1).strip()
        if name and "<" not in name and "(fill" not in name.lower():
            return name
    return project_root.name


def _extract_profile(project_root: Path) -> str:
    cfg = project_root / "research_team_config.json"
    if not cfg.is_file():
        return "mixed"
    try:
        data = json.loads(cfg.read_text(encoding="utf-8", errors="replace"))
    except Exception:
        return "mixed"
    prof = str((data or {}).get("profile", "")).strip()
    return prof or "mixed"


def _write_json(path: Path, obj: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(obj, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


def _write_text(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")


def _safe_relpath(path: Path, root: Path) -> str:
    try:
        return path.resolve().relative_to(root.resolve()).as_posix()
    except Exception:
        return path.as_posix()


def _matches_template_file(
    *,
    project_root: Path,
    rel_path: str,
    asset_path: Path,
    project_name: str,
    profile: str,
) -> tuple[bool, str]:
    abs_path = project_root / rel_path
    if not abs_path.is_file():
        return False, "missing"
    if not asset_path.is_file():
        return False, f"missing template asset: {asset_path}"

    actual = _normalize_for_compare(_read_text(abs_path))
    templ = _normalize_for_compare(_render_template(_read_text(asset_path), project_name=project_name, project_root=project_root, profile=profile))
    if abs_path.suffix == ".json" and asset_path.suffix == ".json":
        try:
            actual_obj = _canonicalize_project_root_value(json.loads(actual), project_root)
            templ_obj = _canonicalize_project_root_value(json.loads(templ), project_root)
            if actual_obj == templ_obj:
                return True, ""
        except Exception:
            pass
    actual = _normalize_project_root_variants(actual, project_root)
    templ = _normalize_project_root_variants(templ, project_root)
    if actual == templ:
        return True, ""
    return False, "content differs from template"


def _dir_files_rel(dir_path: Path) -> set[str]:
    out: set[str] = set()
    for p in dir_path.rglob("*"):
        if p.is_file():
            out.add(p.relative_to(dir_path).as_posix())
    return out


def _check_mechanisms_dir(project_root: Path, *, assets_dir: Path, project_name: str, profile: str) -> tuple[bool, str]:
    mech = project_root / "mechanisms"
    if not mech.is_dir():
        return False, "missing"

    mapping: dict[str, Path] = {
        "00_pre_task_clarifier.md": assets_dir / "mechanisms" / "clarifier_template.md",
        "01_analogy_mining.md": assets_dir / "mechanisms" / "analogy_mining_template.md",
        "02_problem_framing_protocol.md": assets_dir / "mechanisms" / "problem_framing_protocol_template.md",
    }

    present = _dir_files_rel(mech)
    expected = set(mapping.keys())
    extra = sorted(present - expected)
    missing = sorted(expected - present)
    if missing:
        return False, f"missing expected files: {missing[:5]!r}"
    if extra:
        return False, f"contains non-default files: {extra[:5]!r}"

    for rel, asset in mapping.items():
        ok, why = _matches_template_file(
            project_root=project_root,
            rel_path=f"mechanisms/{rel}",
            asset_path=asset,
            project_name=project_name,
            profile=profile,
        )
        if not ok:
            return False, f"{rel} not default: {why}"

    return True, ""


def _check_knowledge_graph_dir(project_root: Path, *, assets_dir: Path, project_name: str, profile: str) -> tuple[bool, str]:
    kg = project_root / "knowledge_graph"
    if not kg.is_dir():
        return False, "missing"

    expected = {"claims.jsonl", "edges.jsonl", "evidence_manifest.jsonl", "README.md"}
    present = _dir_files_rel(kg)
    extra = sorted(present - expected)
    if extra:
        return False, f"contains non-default files: {extra[:5]!r}"
    missing = sorted(expected - present)
    if missing:
        return False, f"missing expected files: {missing[:5]!r}"

    # jsonl must be empty/whitespace-only.
    for name in ("claims.jsonl", "edges.jsonl", "evidence_manifest.jsonl"):
        txt = _read_text(kg / name)
        if txt.strip():
            return False, f"{name} is not empty"

    ok, why = _matches_template_file(
        project_root=project_root,
        rel_path="knowledge_graph/README.md",
        asset_path=assets_dir / "knowledge_graph_readme_template.md",
        project_name=project_name,
        profile=profile,
    )
    if not ok:
        return False, f"README.md not default: {why}"

    return True, ""


def _check_prompts_dir(project_root: Path, *, assets_dir: Path, project_name: str, profile: str) -> tuple[bool, str]:
    prompts = project_root / "prompts"
    if not prompts.is_dir():
        return False, "missing"

    mapping: dict[str, Path] = {
        "_team_packet.txt": assets_dir / "team_packet_template.txt",
        "_system_member_a.txt": assets_dir / "system_member_a.txt",
        "_system_member_b.txt": assets_dir / "system_member_b.txt",
        "_system_draft_member_a.txt": assets_dir / "system_draft_member_a.txt",
        "_system_draft_member_b.txt": assets_dir / "system_draft_member_b.txt",
        "_system_draft_member_c_leader.txt": assets_dir / "system_draft_member_c_leader.txt",
        "_system_member_c_numerics.txt": assets_dir / "system_member_c_numerics.txt",
        "README.md": assets_dir / "prompts_readme_template.md",
    }

    present = _dir_files_rel(prompts)
    expected = set(mapping.keys())
    extra = sorted(present - expected)
    missing = sorted(expected - present)
    if missing:
        return False, f"missing expected files: {missing[:5]!r}"
    if extra:
        return False, f"contains non-default files: {extra[:5]!r}"

    for rel, asset in mapping.items():
        ok, why = _matches_template_file(
            project_root=project_root,
            rel_path=f"prompts/{rel}",
            asset_path=asset,
            project_name=project_name,
            profile=profile,
        )
        if not ok:
            return False, f"{rel} not default: {why}"

    return True, ""


def _check_knowledge_base_dir(project_root: Path, *, assets_dir: Path, project_name: str, profile: str) -> tuple[bool, str]:
    kb = project_root / "knowledge_base"
    if not kb.is_dir():
        return False, "missing"

    mapping: dict[str, Path] = {
        "README.md": assets_dir / "knowledge_base_readme_template.md",
        "methodology_traces/_template.md": assets_dir / "methodology_trace_template.md",
        "methodology_traces/literature_queries.md": assets_dir / "literature_queries_template.md",
    }
    present = _dir_files_rel(kb)
    expected = set(mapping.keys())
    extra = sorted(present - expected)
    missing = sorted(expected - present)
    if missing:
        return False, f"missing expected files: {missing[:5]!r}"
    if extra:
        return False, f"contains non-default files: {extra[:5]!r}"

    for rel, asset in mapping.items():
        ok, why = _matches_template_file(
            project_root=project_root,
            rel_path=f"knowledge_base/{rel}",
            asset_path=asset,
            project_name=project_name,
            profile=profile,
        )
        if not ok:
            return False, f"{rel} not default: {why}"

    return True, ""


def _check_references_dir(project_root: Path, *, assets_dir: Path, project_name: str, profile: str) -> tuple[bool, str]:
    refs = project_root / "references"
    if not refs.is_dir():
        return False, "missing"

    present = _dir_files_rel(refs)
    if present != {"README.md"}:
        return False, f"contains non-default files: {sorted(present)[:5]!r}"

    ok, why = _matches_template_file(
        project_root=project_root,
        rel_path="references/README.md",
        asset_path=assets_dir / "references_readme_template.md",
        project_name=project_name,
        profile=profile,
    )
    if not ok:
        return False, f"README.md not default: {why}"
    return True, ""


def _check_team_dir(project_root: Path, *, assets_dir: Path, project_name: str, profile: str) -> tuple[bool, str]:
    team = project_root / "team"
    if not team.is_dir():
        return False, "missing"

    mapping: dict[str, Path] = {
        "LATEST.md": assets_dir / "team_latest_template.md",
        "LATEST_TEAM.md": assets_dir / "team_latest_team_template.md",
        "LATEST_DRAFT.md": assets_dir / "team_latest_draft_template.md",
    }
    present = _dir_files_rel(team)
    expected = set(mapping.keys())
    extra = sorted(present - expected)
    missing = sorted(expected - present)
    if missing:
        return False, f"missing expected files: {missing[:5]!r}"
    if extra:
        return False, f"contains non-default files: {extra[:5]!r}"

    runs_dir = team / "runs"
    if not runs_dir.is_dir():
        return False, "missing runs/"
    if any(runs_dir.iterdir()):
        return False, "team/runs is not empty"

    for rel, asset in mapping.items():
        ok, why = _matches_template_file(
            project_root=project_root,
            rel_path=f"team/{rel}",
            asset_path=asset,
            project_name=project_name,
            profile=profile,
        )
        if not ok:
            return False, f"{rel} not default: {why}"

    return True, ""


def _check_hep_dir(project_root: Path, *, assets_dir: Path, project_name: str, profile: str) -> tuple[bool, str]:
    hep_dir = project_root / ".hep"
    if not hep_dir.is_dir():
        return False, "missing"

    mapping: dict[str, Path] = {
        "workspace.json": assets_dir / "hep_workspace_template.json",
        "mappings.json": assets_dir / "hep_mappings_template.json",
    }
    present = _dir_files_rel(hep_dir)
    expected = set(mapping.keys())
    extra = sorted(present - expected)
    missing = sorted(expected - present)
    if missing:
        return False, f"missing expected files: {missing[:5]!r}"
    if extra:
        return False, f"contains non-default files: {extra[:5]!r}"

    for rel, asset in mapping.items():
        ok, why = _matches_template_file(
            project_root=project_root,
            rel_path=f".hep/{rel}",
            asset_path=asset,
            project_name=project_name,
            profile=profile,
        )
        if not ok:
            return False, f"{rel} not default: {why}"

    return True, ""


def _infer_scaffold_variant(project_root: Path) -> str:
    wrappers = [
        "scripts/run_full_cycle.sh",
        "scripts/run_autopilot.sh",
        "scripts/run_claude.sh",
        "scripts/run_gemini.sh",
        "scripts/execute_task.sh",
        "scripts/export_paper_bundle.sh",
    ]
    prompt_extras = [
        "prompts/_team_packet.txt",
        "prompts/_system_member_a.txt",
        "prompts/_system_member_b.txt",
        "prompts/_system_draft_member_a.txt",
        "prompts/_system_draft_member_b.txt",
        "prompts/_system_draft_member_c_leader.txt",
        "prompts/_system_member_c_numerics.txt",
        "prompts/README.md",
    ]
    if any((project_root / p).exists() for p in wrappers + prompt_extras):
        return "full"
    if any(
        (project_root / p).exists()
        for p in ("knowledge_graph", "mechanisms", "knowledge_base", "references", "team", ".hep", "research_team_config.json")
    ):
        return "full"
    return "minimal"


def _patch_config_variant(project_root: Path, variant: str) -> str:
    cfg = project_root / "research_team_config.json"
    if not cfg.is_file():
        return "config missing"
    try:
        data = json.loads(cfg.read_text(encoding="utf-8", errors="replace"))
    except Exception:
        return "config parse failed"
    if not isinstance(data, dict):
        return "config invalid"
    data["scaffold_variant"] = variant
    cfg.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    return "ok"


def _parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--root", type=Path, required=True, help="Project root directory.")
    p.add_argument(
        "--components",
        default="wrappers,prompt_extras,pointers,host_config,scaffolds",
        help="Comma-separated list: wrappers,prompt_extras,pointers,host_config,scaffolds,all (default prunes full-only surfaces back to minimal).",
    )
    p.add_argument("--apply", action="store_true", help="Apply moves (default: dry-run).")
    p.add_argument(
        "--archive-dir",
        type=Path,
        default=None,
        help="Archive directory under project root (default: team/migrations/scaffold_prune_<UTC>/).",
    )
    p.add_argument("--no-update-config", action="store_true", help="Do not update research_team_config.json scaffold_variant.")
    return p.parse_args()


def main() -> int:
    args = _parse_args()
    project_root = args.root.resolve()
    if not project_root.is_dir():
        print(f"ERROR: project root not found: {project_root}", file=sys.stderr)
        return 2

    skill_root = Path(__file__).resolve().parents[2]
    assets_dir = skill_root / "assets"
    if not assets_dir.is_dir():
        print(f"ERROR: missing assets dir: {assets_dir}", file=sys.stderr)
        return 1

    components_raw = [c.strip() for c in str(args.components or "").split(",") if c.strip()]
    comps = set(components_raw)
    if "all" in comps:
        comps = {"wrappers", "prompt_extras", "pointers", "host_config", "scaffolds"}
    allowed = {"wrappers", "prompt_extras", "pointers", "host_config", "scaffolds"}
    unknown = sorted([c for c in comps if c not in allowed])
    if unknown:
        print(f"ERROR: unknown component(s): {unknown}. Allowed: {sorted(allowed)}", file=sys.stderr)
        return 2

    project_name = _extract_project_name(project_root)
    profile = _extract_profile(project_root)
    git_enabled = _is_git_repo(project_root)

    archive_dir = args.archive_dir
    if archive_dir is None:
        archive_dir = project_root / "artifacts" / "migrations" / f"scaffold_prune_{_now_utc_slug()}"
    if not archive_dir.is_absolute():
        archive_dir = (project_root / archive_dir).resolve()

    if archive_dir.exists():
        # Keep deterministic: do not merge with an existing archive directory.
        print(f"ERROR: archive dir already exists: {archive_dir}", file=sys.stderr)
        return 2
    archive_dir.mkdir(parents=True, exist_ok=True)

    file_targets: dict[str, list[tuple[str, Path]]] = {
        "wrappers": [
            ("scripts/run_full_cycle.sh", assets_dir / "run_full_cycle.sh"),
            ("scripts/run_autopilot.sh", assets_dir / "run_autopilot.sh"),
            ("scripts/run_claude.sh", assets_dir / "run_claude.sh"),
            ("scripts/run_gemini.sh", assets_dir / "run_gemini.sh"),
            ("scripts/execute_task.sh", assets_dir / "execute_task.sh"),
            ("scripts/export_paper_bundle.sh", assets_dir / "export_paper_bundle.sh"),
        ],
        "pointers": [
            ("artifacts/LATEST.md", assets_dir / "artifacts_latest_template.md"),
        ],
        "host_config": [
            ("research_team_config.json", assets_dir / "research_team_config_template.json"),
            ("scan_dependency_rules.json", assets_dir / "scan_dependency_rules_template.json"),
        ],
    }

    results: list[ItemResult] = []
    planned_moves: list[tuple[int, Path, Path]] = []

    for component in ("wrappers", "prompt_extras", "pointers", "host_config"):
        if component not in comps:
            continue
        for rel, asset in file_targets.get(component, []):
            src = project_root / rel
            if not src.exists():
                results.append(ItemResult(kind="file", component=component, path=rel, status="missing", reason="not present"))
                continue
            if not src.is_file():
                results.append(ItemResult(kind="file", component=component, path=rel, status="skip", reason="not a regular file"))
                continue

            git_porcelain = _git_status_porcelain(project_root, rel) if git_enabled else ""
            if git_porcelain and not git_porcelain.startswith("??"):
                results.append(
                    ItemResult(
                        kind="file",
                        component=component,
                        path=rel,
                        status="skip",
                        reason="git-modified/staged",
                        git_porcelain=git_porcelain,
                    )
                )
                continue

            ok, why = _matches_template_file(
                project_root=project_root,
                rel_path=rel,
                asset_path=asset,
                project_name=project_name,
                profile=profile,
            )
            if not ok:
                results.append(
                    ItemResult(
                        kind="file",
                        component=component,
                        path=rel,
                        status="skip",
                        reason=why,
                        git_porcelain=git_porcelain,
                    )
                )
                continue

            dst = archive_dir / rel
            results.append(
                ItemResult(
                    kind="file",
                    component=component,
                    path=rel,
                    status="plan_move",
                    reason="default scaffold file",
                    archive_path=_safe_relpath(dst, project_root),
                    git_porcelain=git_porcelain,
                )
            )
            planned_moves.append((len(results) - 1, src, dst))

    # Directories (scaffolds).
    for component, dname, checker in (
        ("prompt_extras", "prompts", _check_prompts_dir),
        ("scaffolds", "knowledge_graph", _check_knowledge_graph_dir),
        ("scaffolds", "mechanisms", _check_mechanisms_dir),
        ("scaffolds", "knowledge_base", _check_knowledge_base_dir),
        ("scaffolds", "references", _check_references_dir),
        ("scaffolds", "team", _check_team_dir),
        ("scaffolds", ".hep", _check_hep_dir),
    ):
        if component not in comps:
            continue
        src_dir = project_root / dname
        if not src_dir.exists():
            results.append(ItemResult(kind="dir", component=component, path=dname, status="missing", reason="not present"))
            continue
        if not src_dir.is_dir():
            results.append(ItemResult(kind="dir", component=component, path=dname, status="skip", reason="not a directory"))
            continue

        ok, why = checker(project_root, assets_dir=assets_dir, project_name=project_name, profile=profile)
        if not ok:
            results.append(ItemResult(kind="dir", component=component, path=dname, status="skip", reason=why))
            continue
        dst_dir = archive_dir / dname
        results.append(
            ItemResult(
                kind="dir",
                component=component,
                path=dname,
                status="plan_move",
                reason="default scaffold directory",
                archive_path=_safe_relpath(dst_dir, project_root),
            )
        )
        planned_moves.append((len(results) - 1, src_dir, dst_dir))

    # Apply moves (with best-effort rollback).
    moved: list[tuple[Path, Path]] = []
    if args.apply and planned_moves:
        try:
            for idx, src, dst in planned_moves:
                dst.parent.mkdir(parents=True, exist_ok=True)
                shutil.move(str(src), str(dst))
                moved.append((src, dst))
                try:
                    results[idx].status = "moved"
                except Exception:
                    pass
        except Exception as e:
            for src, dst in reversed(moved):
                try:
                    if src.exists():
                        continue
                    src.parent.mkdir(parents=True, exist_ok=True)
                    shutil.move(str(dst), str(src))
                except Exception:
                    pass
            results.append(ItemResult(kind="meta", component="meta", path="*", status="error", reason=f"move failed: {e}"))
            # Still write reports for auditability.
            pass

    # Update config scaffold_variant (best-effort).
    config_update = "skipped"
    inferred_variant = _infer_scaffold_variant(project_root)
    if args.apply and (not args.no_update_config):
        config_update = _patch_config_variant(project_root, inferred_variant)

    report = {
        "version": 1,
        "utc": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%fZ"),
        "project_root": str(project_root),
        "archive_dir": str(archive_dir),
        "dry_run": (not args.apply),
        "components": sorted(comps),
        "project_name": project_name,
        "profile": profile,
        "git_enabled": git_enabled,
        "inferred_scaffold_variant_after": inferred_variant,
        "config_update": config_update,
        "items": [asdict(x) for x in results],
    }
    _write_json(archive_dir / "prune_report.json", report)

    md_lines: list[str] = []
    md_lines.append("# Optional scaffold prune report")
    md_lines.append("")
    md_lines.append(f"- UTC: {report['utc']}")
    md_lines.append(f"- Project root: `{project_root}`")
    md_lines.append(f"- Archive dir: `{archive_dir}`")
    md_lines.append(f"- Dry run: {report['dry_run']}")
    md_lines.append(f"- Components: {', '.join(report['components'])}")
    md_lines.append(f"- Inferred scaffold_variant after: `{inferred_variant}` (config update: {config_update})")
    md_lines.append("")
    md_lines.append("## Items")
    md_lines.append("")
    for it in results:
        extra = ""
        if it.archive_path:
            extra += f" -> `{it.archive_path}`"
        if it.git_porcelain:
            extra += f" (git={it.git_porcelain})"
        md_lines.append(f"- [{it.status}] {it.kind}:{it.component} `{it.path}` — {it.reason}{extra}")
    md_lines.append("")
    md_lines.append("## Restore")
    md_lines.append("")
    md_lines.append("To restore a moved item, move it back from the archive to the project root, e.g.:")
    md_lines.append("")
    md_lines.append("```bash")
    md_lines.append(f"cd {project_root}")
    md_lines.append(f"# example:")
    archive_rel = _safe_relpath(archive_dir, project_root)
    md_lines.append(f"mv {archive_rel}/scripts/run_full_cycle.sh scripts/run_full_cycle.sh")
    md_lines.append("```")
    md_lines.append("")
    _write_text(archive_dir / "prune_report.md", "\n".join(md_lines))

    print(f"[ok] report: {archive_dir / 'prune_report.md'}")
    if not planned_moves:
        print("[ok] nothing to prune")
        return 0
    if args.apply and any(x.status == "error" for x in results):
        print("[error] prune failed; see report", file=sys.stderr)
        return 1
    if args.apply:
        print(f"[ok] pruned items archived under: {archive_dir}")
    else:
        print(f"[ok] dry-run: would archive {len(planned_moves)} item(s) under: {archive_dir}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
