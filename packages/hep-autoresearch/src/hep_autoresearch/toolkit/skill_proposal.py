from __future__ import annotations

import hashlib
import json
import os
import platform
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable

from ._git import try_get_git_metadata
from ._json import read_json, write_json
from ._paths import manifest_cwd
from ._time import utc_now_iso
from .artifact_report import write_artifact_report


@dataclass(frozen=True)
class SkillProposalInputs:
    tag: str
    source_run_tag: str
    max_proposals: int = 5


def _rel(repo_root: Path, p: Path) -> str:
    return os.fspath(p.relative_to(repo_root))


def _is_under_any(p: Path, needles: Iterable[str]) -> bool:
    parts = set(p.parts)
    return any(n in parts for n in needles)


_SLUG_RE = re.compile(r"[^A-Za-z0-9]+")


def _slug(s: str, *, max_len: int = 48) -> str:
    s = str(s)
    s = _SLUG_RE.sub("-", s).strip("-").lower()
    s = s[:max_len].strip("-")
    return s or "cmd"


def _sha256_short(payload: Any, *, n: int = 10) -> str:
    blob = json.dumps(payload, sort_keys=True, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    return hashlib.sha256(blob).hexdigest()[:n]


def _write_text_under(out_dir: Path, path: Path, content: str) -> None:
    out_dir_r = out_dir.resolve()
    path_r = path.resolve()
    try:
        path_r.relative_to(out_dir_r)
    except Exception as e:
        raise ValueError(f"refusing to write outside output dir: {os.fspath(path)}") from e
    path_r.parent.mkdir(parents=True, exist_ok=True)
    path_r.write_text(content.rstrip() + "\n", encoding="utf-8")


def _iter_run_cards(repo_root: Path, source_run_dir: Path) -> list[Path]:
    if not source_run_dir.exists():
        return []
    out: list[Path] = []
    for p in sorted(source_run_dir.rglob("run_card.json")):
        rel = p.relative_to(repo_root)
        if _is_under_any(rel, {"approvals", "context", "dual_review", "evolution_proposal", "skill_proposal"}):
            continue
        out.append(p)
    return out


def _render_skill_md(
    *,
    skill_id: str,
    title: str,
    description: str,
    argv: list[str],
    cwd: str,
    source_run_tag: str,
    source_run_card_rel: str,
) -> str:
    argv_str = json.dumps(argv, ensure_ascii=False)
    lines = [
        f"# Skill proposal — {title}",
        "",
        f"- skill_id: `{skill_id}`",
        f"- source_run_tag: `{source_run_tag}`",
        f"- source_run_card: `{source_run_card_rel}`",
        "",
        "## Purpose",
        "",
        description.strip() or "(fill in)",
        "",
        "## Observed command pattern (from run artifacts)",
        "",
        f"- cwd: `{cwd}`",
        f"- argv: `{argv_str}`",
        "",
        "## Safety contract (v0)",
        "",
        "- Deterministic by default; no live network unless explicitly A1-gated.",
        "- Must write outputs only under the run artifact directory.",
        "- Installing this as a real skill (outside artifacts) requires **A2** + dual review.",
        "",
    ]
    return "\n".join(lines).rstrip() + "\n"


def _render_proposal_md(*, repo_root: Path, out_dir: Path, analysis: dict[str, Any]) -> str:
    rel_dir = _rel(repo_root, out_dir)
    proposals = ((analysis.get("results") or {}).get("proposals") or []) if isinstance(analysis, dict) else []
    if not isinstance(proposals, list):
        proposals = []
    lines: list[str] = [
        "# Skill proposals (v0)",
        "",
        "> Deterministic, derived view of JSON SSOT in this directory.",
        "",
        f"- artifact_dir: [{rel_dir}](./)",
        f"- source_run_tag: `{((analysis.get('inputs') or {}).get('source_run_tag')) if isinstance(analysis, dict) else ''}`",
        "",
        "## Proposals",
        "",
    ]
    if not proposals:
        lines.append("- (no proposals generated)")
        lines.append("")
        return "\n".join(lines).rstrip() + "\n"
    for idx, p in enumerate(proposals):
        if not isinstance(p, dict):
            continue
        pid = p.get("proposal_id") or f"P{idx + 1:03d}"
        title = p.get("title") or "(title?)"
        skill_id = p.get("skill_id") or "(skill_id?)"
        scaffold_dir = p.get("scaffold_dir") or ""
        ptr_base = f"analysis.json#/results/proposals/{idx}"
        lines.extend(
            [
                f"### {pid} — {title}",
                "",
                f"- skill_id: `{skill_id}` (`{ptr_base}/skill_id`)",
                f"- scaffold_dir: `{scaffold_dir}` (`{ptr_base}/scaffold_dir`)",
                "",
            ]
        )
    return "\n".join(lines).rstrip() + "\n"


def skill_proposal_one(inps: SkillProposalInputs, repo_root: Path) -> dict[str, Any]:
    if not inps.tag or not str(inps.tag).strip():
        raise ValueError("tag is required")
    if not inps.source_run_tag or not str(inps.source_run_tag).strip():
        raise ValueError("source_run_tag is required")

    created_at = utc_now_iso()
    out_dir = repo_root / "artifacts" / "runs" / str(inps.tag) / "skill_proposal"
    scaffolds_dir = out_dir / "scaffolds"
    out_dir.mkdir(parents=True, exist_ok=True)

    manifest_path = out_dir / "manifest.json"
    summary_path = out_dir / "summary.json"
    analysis_path = out_dir / "analysis.json"
    report_path = out_dir / "report.md"
    proposal_md_path = out_dir / "proposal.md"

    versions: dict[str, Any] = {"python": os.sys.version.split()[0], "os": platform.platform()}

    source_run_dir = repo_root / "artifacts" / "runs" / str(inps.source_run_tag)
    run_cards = _iter_run_cards(repo_root, source_run_dir)

    patterns: dict[str, dict[str, Any]] = {}
    for p in run_cards:
        try:
            rc = read_json(p)
        except Exception:  # CONTRACT-EXEMPT: CODE-01.5 skip unreadable files
            continue
        if not isinstance(rc, dict):
            continue
        backend = rc.get("backend") if isinstance(rc.get("backend"), dict) else {}
        if str(backend.get("kind") or "").strip().lower() != "shell":
            continue
        argv = backend.get("argv")
        if not isinstance(argv, list) or not argv or not all(isinstance(x, str) and x.strip() for x in argv):
            continue
        cwd = backend.get("cwd") if isinstance(backend.get("cwd"), str) and backend.get("cwd") else "."
        key = json.dumps({"argv": argv, "cwd": cwd}, sort_keys=True, ensure_ascii=False, separators=(",", ":"))
        rec = patterns.get(key) or {"count": 0, "example_run_card": _rel(repo_root, p), "argv": argv, "cwd": cwd}
        rec["count"] = int(rec.get("count") or 0) + 1
        patterns[key] = rec

    ordered = sorted(patterns.values(), key=lambda r: (-int(r.get("count") or 0), str(r.get("example_run_card") or "")))

    proposals: list[dict[str, Any]] = []
    for idx, rec in enumerate(ordered[: int(inps.max_proposals)]):
        pid = f"P{idx + 1:03d}"
        argv = list(rec.get("argv") or [])
        cwd = str(rec.get("cwd") or ".")
        cmd0 = argv[0] if argv else "cmd"
        cmd_slug = _slug(cmd0)
        skill_id = f"skill_shell_{cmd_slug}_{_sha256_short({'argv': argv, 'cwd': cwd})}"
        title = f"Shell wrapper: {cmd0}"
        desc = "Wrap a frequently observed shell command pattern into a reusable, auditable skill scaffold."
        scaffold_dir = scaffolds_dir / pid
        skill_md_path = scaffold_dir / "SKILL.md"
        _write_text_under(
            out_dir,
            skill_md_path,
            _render_skill_md(
                skill_id=skill_id,
                title=title,
                description=desc,
                argv=argv,
                cwd=cwd,
                source_run_tag=str(inps.source_run_tag),
                source_run_card_rel=str(rec.get("example_run_card") or ""),
            ),
        )
        proposals.append(
            {
                "proposal_id": pid,
                "title": title,
                "skill_id": skill_id,
                "requires_approval": "A2",
                "source": {
                    "source_run_tag": str(inps.source_run_tag),
                    "example_run_card": str(rec.get("example_run_card") or ""),
                    "count": int(rec.get("count") or 0),
                },
                "observed_command": {"cwd": cwd, "argv": argv},
                "scaffold_dir": _rel(repo_root, scaffold_dir),
                "scaffold_files": [_rel(repo_root, skill_md_path)],
            }
        )

    analysis: dict[str, Any] = {
        "schema_version": 1,
        "created_at": created_at,
        "inputs": {
            "tag": str(inps.tag),
            "source_run_tag": str(inps.source_run_tag),
            "max_proposals": int(inps.max_proposals),
        },
        "results": {
            "ok": True,
            "proposals_total": len(proposals),
            "proposals": proposals,
            "write_scope": {
                "root": _rel(repo_root, out_dir),
                "ok": True,
                "created_files": [],
            },
        },
    }

    manifest: dict[str, Any] = {
        "schema_version": 1,
        "created_at": created_at,
        "command": "python3 scripts/run_skill_proposal.py",
        "cwd": manifest_cwd(repo_root=repo_root, cwd=repo_root),
        "params": {
            "tag": str(inps.tag),
            "source_run_tag": str(inps.source_run_tag),
            "max_proposals": int(inps.max_proposals),
        },
        "versions": versions,
        "outputs": [],
    }
    git_meta = try_get_git_metadata(repo_root)
    if git_meta:
        manifest["git"] = git_meta

    summary: dict[str, Any] = {
        "schema_version": 1,
        "created_at": created_at,
        "definitions": {"workflow": "EVOLUTION_skill_proposal", "kind": "skill_proposal"},
        "stats": {"proposals_total": len(proposals)},
        "outputs": {
            "analysis": _rel(repo_root, analysis_path),
            "proposal_md": _rel(repo_root, proposal_md_path),
            "scaffolds_dir": _rel(repo_root, scaffolds_dir),
        },
    }

    _write_text_under(out_dir, proposal_md_path, _render_proposal_md(repo_root=repo_root, out_dir=out_dir, analysis=analysis))

    outputs: list[str] = []
    for p in sorted(out_dir.rglob("*")):
        if p.is_file():
            relp = _rel(repo_root, p)
            outputs.append(relp)
    for p in [manifest_path, summary_path, analysis_path, report_path]:
        relp = _rel(repo_root, p)
        if relp not in outputs:
            outputs.append(relp)
    outputs = sorted(set(outputs))
    manifest["outputs"] = outputs
    analysis["results"]["write_scope"]["created_files"] = list(outputs)

    write_json(manifest_path, manifest)
    write_json(summary_path, summary)
    write_json(analysis_path, analysis)
    report_rel = write_artifact_report(
        repo_root=repo_root,
        artifact_dir=out_dir,
        manifest=manifest,
        summary=summary,
        analysis=analysis,
    )

    return {
        "artifact_dir": _rel(repo_root, out_dir),
        "artifact_paths": {
            "manifest": _rel(repo_root, manifest_path),
            "summary": _rel(repo_root, summary_path),
            "analysis": _rel(repo_root, analysis_path),
            "report": report_rel,
            "proposal_md": _rel(repo_root, proposal_md_path),
        },
        "proposals_total": len(proposals),
    }
