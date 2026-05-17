#!/usr/bin/env python3
"""
Prune ephemeral per-member workspaces under team/runs/<tag>/workspaces/.

Each research-team run creates two member workspaces (`member_a_<uuid>` and
`member_b_<uuid>`) that are full filtered snapshots of the project tree. They
can balloon to many GB across N runs × 2 members × large datasets in
references/ or artifacts/.

The workspaces are **ephemeral scratch space**, not durable artifacts. The
durable forensic data for each run lives at the run_dir top level:
  team/runs/<tag>/cycle_state.json
  team/runs/<tag>/<tag>_member_a.md
  team/runs/<tag>/<tag>_member_b.md
  team/runs/<tag>/member_a_evidence.json
  team/runs/<tag>/member_b_evidence.json
  team/runs/<tag>/member_a_audit.jsonl
  team/runs/<tag>/member_b_audit.jsonl
  team/runs/<tag>/logs/member_a/
  team/runs/<tag>/logs/member_b/

This tool only deletes `team/runs/<tag>/workspaces/` subdirectories. It never
touches the forensic data above.

Safety policy (default):
- Dry-run by default. Use --apply to actually delete.
- Skip workspaces whose cycle_state.json shows status="running" AND was touched
  within --min-age-hours (default 1).
- Honor --keep-last N (keep the N most recently-updated runs' workspaces).
- Honor --keep-failed (preserve workspaces of runs where cycle_state status is
  neither "completed" nor missing).

Exit codes:
  0  success (plan computed and printed; apply succeeded)
  1  runtime error
  2  usage / input error
"""

from __future__ import annotations

import argparse
import errno
import json
import os
import shutil
import stat
import sys
from dataclasses import dataclass, asdict
from datetime import datetime, timedelta, timezone
from pathlib import Path


@dataclass
class WorkspacePlan:
    tag: str
    workspaces_dir: str
    size_bytes: int
    status: str  # "completed" | "running" | "error" | "unknown"
    last_update_iso: str | None
    action: str  # "delete" | "skip"
    skip_reason: str = ""


def _read_cycle_state(tag_dir: Path) -> tuple[str, datetime | None]:
    """Return (status, last_update) from cycle_state.json or ("unknown", None)."""
    state_path = tag_dir / "cycle_state.json"
    if not state_path.is_file():
        return "unknown", None
    try:
        data = json.loads(state_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return "unknown", None
    status = str(data.get("status") or "unknown")
    updated = data.get("updated_at") or data.get("last_update_iso")
    last_update: datetime | None = None
    if isinstance(updated, str):
        try:
            last_update = datetime.fromisoformat(updated.replace("Z", "+00:00"))
        except ValueError:
            last_update = None
    return status, last_update


def _dir_size(path: Path) -> int:
    total = 0
    for root, _dirs, files in os.walk(path, followlinks=False):
        for f in files:
            try:
                total += os.lstat(os.path.join(root, f)).st_size
            except OSError:
                pass
    return total


def _format_bytes(n: int) -> str:
    units = ["B", "KB", "MB", "GB", "TB"]
    i = 0
    f = float(n)
    while f >= 1024 and i < len(units) - 1:
        f /= 1024
        i += 1
    return f"{f:.1f} {units[i]}" if i > 0 else f"{int(n)} B"


def _rmtree_force(path: Path) -> None:
    """Recursively delete path, restoring perms first (workspaces may be chmod a-rwx).

    Assumes workspaces are full file copies (the current run_team_cycle.sh
    behavior). If a future refactor introduces hardlinks shared with the
    project root, the os.chmod calls below would mutate inode permissions
    outside the workspace; revisit the chmod logic before that refactor.
    """

    def _onerror(_func, target, exc_info):
        exc = exc_info[1] if isinstance(exc_info, tuple) else exc_info
        if isinstance(exc, PermissionError) or (
            isinstance(exc, OSError) and exc.errno in (errno.EACCES, errno.EPERM)
        ):
            try:
                # Restore u+rwx so we can remove the entry.
                os.chmod(target, stat.S_IRWXU)
            except OSError:
                pass
            _func(target)
        else:
            raise exc

    # First pass: restore traversal perms on every dir under path so a later
    # walk can enumerate entries even if a previous run chmod'd them to 000.
    try:
        os.chmod(path, stat.S_IRWXU)
    except OSError:
        pass
    for root, dirs, _files in os.walk(path, followlinks=False):
        for d in dirs:
            try:
                os.chmod(Path(root) / d, stat.S_IRWXU)
            except OSError:
                pass
    shutil.rmtree(path, onerror=_onerror)


def find_plans(
    project_root: Path,
    *,
    keep_last: int,
    keep_failed: bool,
    min_age_hours: float,
    now: datetime | None = None,
) -> list[WorkspacePlan]:
    """Walk team/runs/<tag>/ and decide deletion plan for each workspaces dir."""
    if now is None:
        now = datetime.now(timezone.utc)
    runs_root = (project_root / "team" / "runs").resolve()
    if not runs_root.is_dir():
        return []
    candidates: list[WorkspacePlan] = []
    for tag_dir in sorted(runs_root.iterdir()):
        if not tag_dir.is_dir() or tag_dir.is_symlink():
            continue
        ws_dir = tag_dir / "workspaces"
        if not ws_dir.is_dir() or ws_dir.is_symlink():
            continue
        # Containment guard: refuse to plan a deletion for any workspaces path
        # that resolves outside team/runs/. Symlinked tag/ or workspaces/ dirs
        # could otherwise escape via realpath.
        try:
            ws_real = ws_dir.resolve(strict=True)
            ws_real.relative_to(runs_root)
        except (OSError, ValueError):
            continue
        status, last_update = _read_cycle_state(tag_dir)
        ws_mtime = datetime.fromtimestamp(ws_dir.stat().st_mtime, tz=timezone.utc)
        effective_update = last_update or ws_mtime
        # status="unknown" with a fresh mtime is treated the same as "running"
        # because cycle_state.json may not have been written yet when a cycle
        # crashes between mkdir(workspaces) and the first state update.
        in_progress = (
            status in ("running", "unknown")
            and (now - ws_mtime) < timedelta(hours=min_age_hours)
        )
        is_failed = status not in {"completed", "running", "unknown", None}
        size = _dir_size(ws_dir)
        candidates.append(
            WorkspacePlan(
                tag=tag_dir.name,
                workspaces_dir=str(ws_dir),
                size_bytes=size,
                status=status,
                last_update_iso=effective_update.isoformat() if effective_update else None,
                action="skip" if in_progress else "delete",
                skip_reason="cycle_state status=running and mtime fresh" if in_progress else "",
            )
        )
        if is_failed and keep_failed:
            candidates[-1].action = "skip"
            candidates[-1].skip_reason = f"--keep-failed set (status={status})"
    # Apply --keep-last to the remaining "delete" entries (sorted by recency desc).
    delete_set = [p for p in candidates if p.action == "delete"]
    delete_set.sort(key=lambda p: p.last_update_iso or "", reverse=True)
    for i, p in enumerate(delete_set):
        if i < keep_last:
            p.action = "skip"
            p.skip_reason = f"within --keep-last={keep_last} most-recent runs"
    return candidates


def _parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--root", type=Path, required=True, help="Project root directory (contains team/runs/).")
    p.add_argument("--apply", action="store_true", help="Actually delete (default: dry-run preview).")
    p.add_argument("--keep-last", type=int, default=0, help="Keep workspaces for the N most recently-updated runs (default 0).")
    p.add_argument("--keep-failed", action="store_true", help="Preserve workspaces of failed runs (cycle_state status not in {completed, running, unknown}).")
    p.add_argument("--min-age-hours", type=float, default=1.0, help="Treat workspaces with status=running and mtime younger than this as in-progress and skip (default 1.0).")
    p.add_argument("--json", action="store_true", help="Emit machine-readable JSON plan instead of the human-readable summary.")
    return p.parse_args()


def main() -> int:
    args = _parse_args()
    project_root = args.root.resolve()
    if not project_root.is_dir():
        print(f"ERROR: project root not found: {project_root}", file=sys.stderr)
        return 2
    plans = find_plans(
        project_root,
        keep_last=args.keep_last,
        keep_failed=args.keep_failed,
        min_age_hours=args.min_age_hours,
    )
    if args.json:
        # schema_version=1 so a downstream parser can fail fast on incompatible
        # field additions in a future tool revision.
        json_envelope: dict[str, object] = {
            "schema_version": 1,
            "project_root": str(project_root),
            "apply": args.apply,
            "plans": [asdict(p) for p in plans],
        }
        # We may augment with "result" after the deletion pass below; emit later.
    else:
        total_to_delete = sum(p.size_bytes for p in plans if p.action == "delete")
        total_to_skip = sum(p.size_bytes for p in plans if p.action == "skip")
        print(f"Found {len(plans)} workspaces under {project_root}/team/runs/")
        print(f"  to delete: {sum(1 for p in plans if p.action == 'delete')} ({_format_bytes(total_to_delete)})")
        print(f"  to skip:   {sum(1 for p in plans if p.action == 'skip')} ({_format_bytes(total_to_skip)})")
        print("")
        for p in plans:
            tag = p.tag if len(p.tag) <= 40 else p.tag[:37] + "..."
            line = f"  [{p.action:<6}] {tag:<40} {_format_bytes(p.size_bytes):>10}  status={p.status}"
            if p.skip_reason:
                line += f"  ({p.skip_reason})"
            print(line)
        if not args.apply:
            print("")
            print("Dry-run only. Re-run with --apply to actually delete.")
    if not args.apply:
        if args.json:
            print(json.dumps(json_envelope, indent=2))
        return 0
    deleted = 0
    freed = 0
    errors: list[dict[str, str]] = []
    for p in plans:
        if p.action != "delete":
            continue
        try:
            _rmtree_force(Path(p.workspaces_dir))
            deleted += 1
            freed += p.size_bytes
        except OSError as exc:
            errors.append({"workspaces_dir": p.workspaces_dir, "error": str(exc)})
            print(f"ERROR: could not delete {p.workspaces_dir}: {exc}", file=sys.stderr)
    if args.json:
        json_envelope["result"] = {
            "deleted": deleted,
            "freed_bytes": freed,
            "errors": errors,
        }
        print(json.dumps(json_envelope, indent=2))
    else:
        print("")
        print(f"Deleted {deleted} workspace tree(s), freed {_format_bytes(freed)}.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
