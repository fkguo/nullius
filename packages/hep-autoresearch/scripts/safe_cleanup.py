#!/usr/bin/env python3

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
from collections import Counter
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterable


PROTECTED_PREFIXES = (
    ".git",
    "src",
    "scripts",
    "tests",
    "docs",
    "knowledge_base",
    "references",
)

DEFAULT_SCAFFOLD_TARGETS = (
    "Draft_Derivation.md",
    "INITIAL_INSTRUCTION.md",
    "INITIAL_INSTRUCTION.zh.md",
    "INNOVATION_LOG.md",
    "PREWORK.md",
    "PREWORK.zh.md",
    "PROJECT_CHARTER.md",
    "PROJECT_CHARTER.zh.md",
    "PROJECT_MAP.md",
    "RESEARCH_PLAN.md",
    "RESEARCH_PLAN.zh.md",
    "RESEARCH_PLAN.md.bak",
    "research_team_config.json",
    "team",
    "artifacts/runs",
)


@dataclass(frozen=True)
class Candidate:
    rel_path: str
    kind: str
    exists: bool
    tracked: bool
    protected: bool


def _utc_now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def _norm_rel(p: str) -> str:
    s = p.strip().replace("\\", "/")
    while s.startswith("./"):
        s = s[2:]
    while s.startswith("/"):
        s = s[1:]
    return s.rstrip("/")


def _is_within(path: Path, root: Path) -> bool:
    try:
        path.resolve().relative_to(root.resolve())
        return True
    except Exception:
        return False


def _is_protected(rel: str) -> bool:
    parts = [x for x in rel.split("/") if x]
    if not parts:
        return False
    top = parts[0]
    return top in PROTECTED_PREFIXES


def _git(repo_root: Path, args: list[str]) -> tuple[int, str]:
    proc = subprocess.run(
        ["git", *args],
        cwd=repo_root,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        encoding="utf-8",
        errors="replace",
        check=False,
    )
    return int(proc.returncode), proc.stdout


def _git_tracked_paths(repo_root: Path) -> set[str]:
    rc, out = _git(repo_root, ["ls-files"])
    if rc != 0:
        raise RuntimeError(f"git ls-files failed:\n{out}")
    tracked: set[str] = set()
    for line in out.splitlines():
        s = _norm_rel(line)
        if s:
            tracked.add(s)
    return tracked


def _iter_user_targets(args: argparse.Namespace) -> list[str]:
    raw: list[str] = []
    if args.mode == "scaffold":
        raw.extend(DEFAULT_SCAFFOLD_TARGETS)
    raw.extend(args.path or [])
    seen: set[str] = set()
    out: list[str] = []
    for item in raw:
        rel = _norm_rel(item)
        if not rel or rel == ".":
            continue
        if rel not in seen:
            seen.add(rel)
            out.append(rel)
    return out


def _build_candidates(repo_root: Path, rel_targets: Iterable[str], tracked: set[str]) -> list[Candidate]:
    out: list[Candidate] = []
    for rel in rel_targets:
        full = repo_root / rel
        if not _is_within(full, repo_root):
            raise ValueError(f"path escapes repo root: {rel}")
        exists = full.exists() or full.is_symlink()
        kind = "missing"
        if full.is_symlink() or full.is_file():
            kind = "file"
        elif full.is_dir():
            kind = "dir"
        if kind == "dir":
            prefix = rel + "/"
            tracked_hit = any((p == rel or p.startswith(prefix)) for p in tracked)
        else:
            tracked_hit = rel in tracked
        out.append(
            Candidate(
                rel_path=rel,
                kind=kind,
                exists=exists,
                tracked=bool(tracked_hit),
                protected=_is_protected(rel),
            )
        )
    return out


def _top_level_counts(candidates: list[Candidate]) -> list[dict[str, object]]:
    counter = Counter()
    for c in candidates:
        top = c.rel_path.split("/", 1)[0] if c.rel_path else ""
        counter[top] += 1
    rows = [{"top_level": k, "count": v} for k, v in counter.most_common()]
    return rows


def _write_manifest(repo_root: Path, path: Path, payload: dict[str, object]) -> Path:
    full = path if path.is_absolute() else (repo_root / path)
    full.parent.mkdir(parents=True, exist_ok=True)
    full.write_text(json.dumps(payload, indent=2, sort_keys=True, ensure_ascii=False) + "\n", encoding="utf-8")
    return full


def _load_manifest(repo_root: Path, path: str) -> dict[str, object]:
    full = Path(path)
    if not full.is_absolute():
        full = repo_root / full
    if not full.is_file():
        raise FileNotFoundError(f"manifest not found: {full}")
    raw = json.loads(full.read_text(encoding="utf-8"))
    if not isinstance(raw, dict):
        raise ValueError("manifest must be a JSON object")
    return raw


def _delete_path(repo_root: Path, rel: str) -> str:
    full = repo_root / rel
    if full.is_symlink() or full.is_file():
        full.unlink(missing_ok=True)
        return "deleted"
    if full.is_dir():
        shutil.rmtree(full)
        return "deleted"
    return "missing"


def _allowlist_norm(values: Iterable[str]) -> set[str]:
    return {_norm_rel(v) for v in values if _norm_rel(v)}


def _check_protection(candidates: list[Candidate], allow_protected: set[str]) -> list[str]:
    blocked: list[str] = []
    for c in candidates:
        if not c.protected:
            continue
        if c.rel_path in allow_protected:
            continue
        blocked.append(c.rel_path)
    return blocked


def _manifest_candidates(raw: object) -> list[Candidate]:
    if not isinstance(raw, list):
        raise ValueError("manifest candidates must be a list")
    out: list[Candidate] = []
    for item in raw:
        if not isinstance(item, dict):
            raise ValueError("manifest candidate must be an object")
        rel = _norm_rel(str(item.get("rel_path", "")))
        kind = str(item.get("kind", "missing"))
        exists = bool(item.get("exists", False))
        tracked = bool(item.get("tracked", False))
        protected = bool(item.get("protected", False))
        if not rel:
            raise ValueError("manifest candidate missing rel_path")
        out.append(Candidate(rel_path=rel, kind=kind, exists=exists, tracked=tracked, protected=protected))
    return out


def cmd_dry_run(args: argparse.Namespace) -> int:
    repo_root = Path.cwd().resolve()
    tracked = _git_tracked_paths(repo_root)
    rel_targets = _iter_user_targets(args)
    if not rel_targets:
        print("No targets selected. Use --mode scaffold or pass --path.", file=sys.stderr)
        return 2

    candidates = _build_candidates(repo_root, rel_targets, tracked)
    allow_protected = _allowlist_norm(args.allow_protected or [])
    blocked = _check_protection(candidates, allow_protected)

    summary = {
        "generated_at": _utc_now_iso(),
        "repo_root": os.fspath(repo_root),
        "mode": args.mode,
        "candidate_count": len(candidates),
        "existing_count": sum(1 for c in candidates if c.exists),
        "tracked_count": sum(1 for c in candidates if c.tracked),
        "protected_count": sum(1 for c in candidates if c.protected),
        "blocked_count": len(blocked),
        "top_level": _top_level_counts(candidates),
        "allow_protected": sorted(allow_protected),
    }
    payload = {
        "schema_version": 1,
        "kind": "safe_cleanup_manifest",
        "summary": summary,
        "candidates": [
            {
                "rel_path": c.rel_path,
                "kind": c.kind,
                "exists": c.exists,
                "tracked": c.tracked,
                "protected": c.protected,
            }
            for c in candidates
        ],
        "blocked": blocked,
    }

    manifest_rel = args.out_manifest or f"artifacts/safe_cleanup/manifest_{datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')}.json"
    manifest_path = _write_manifest(repo_root, Path(manifest_rel), payload)

    print("SAFE CLEANUP DRY RUN")
    print(f"- manifest: {manifest_path}")
    print(f"- candidates: {summary['candidate_count']}")
    print(f"- existing: {summary['existing_count']}")
    print(f"- tracked: {summary['tracked_count']}")
    print(f"- protected: {summary['protected_count']}")
    print(f"- blocked: {summary['blocked_count']}")
    for row in summary["top_level"]:
        print(f"  - {row['top_level']}: {row['count']}")

    if blocked:
        print("\nBlocked protected paths (must pass --allow-protected to include):")
        for rel in blocked:
            print(f"- {rel}")
    print("\nNext: review manifest, then run with --apply --manifest <path>.")
    return 0


def cmd_apply(args: argparse.Namespace) -> int:
    repo_root = Path.cwd().resolve()
    manifest = _load_manifest(repo_root, args.manifest)
    candidates = _manifest_candidates(manifest.get("candidates"))
    allow_protected = _allowlist_norm(args.allow_protected or [])
    blocked = _check_protection(candidates, allow_protected)
    if blocked:
        print("Refuse to apply: protected paths present and not allow-listed:", file=sys.stderr)
        for rel in blocked:
            print(f"- {rel}", file=sys.stderr)
        print("Re-run with --allow-protected <path> if intentional.", file=sys.stderr)
        return 3

    delete_existing = [c for c in candidates if c.exists]
    if not args.yes:
        print("Refuse to apply without --yes.", file=sys.stderr)
        print(f"Would delete {len(delete_existing)} existing paths from manifest.", file=sys.stderr)
        return 4

    deleted = 0
    missing = 0
    for c in candidates:
        status = _delete_path(repo_root, c.rel_path)
        if status == "deleted":
            deleted += 1
        else:
            missing += 1

    print("SAFE CLEANUP APPLY")
    print(f"- manifest: {args.manifest}")
    print(f"- deleted: {deleted}")
    print(f"- missing: {missing}")
    print("Done. Review with: git status --short")
    return 0


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description="Two-phase safe cleanup (dry-run manifest + explicit apply)")
    p.add_argument("--mode", choices=("scaffold", "custom"), default="custom", help="target preset")
    p.add_argument("--path", action="append", default=[], help="target path (repeatable)")
    p.add_argument("--out-manifest", default="", help="output manifest path for dry-run")
    p.add_argument(
        "--allow-protected",
        action="append",
        default=[],
        help="explicitly allow deleting protected top-level target (repeatable)",
    )
    p.add_argument("--apply", action="store_true", help="apply deletions from manifest")
    p.add_argument("--manifest", default="", help="manifest path for --apply")
    p.add_argument("--yes", action="store_true", help="required confirmation for --apply")
    return p


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)

    if args.apply:
        if not args.manifest:
            print("--apply requires --manifest <path>", file=sys.stderr)
            return 2
        return cmd_apply(args)
    return cmd_dry_run(args)


if __name__ == "__main__":
    raise SystemExit(main())

