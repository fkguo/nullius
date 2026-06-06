from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from .project_policy import PROJECT_POLICY_CHOICES
from .project_scaffold import ensure_project_scaffold


def main() -> int:
    ap = argparse.ArgumentParser(description="Render the canonical generic project scaffold.")
    ap.add_argument("--root", type=Path, required=True, help="Project root to scaffold.")
    ap.add_argument("--project", default="", help="Project display name.")
    ap.add_argument("--profile", default="mixed", help="Optional profile hint for scaffold placeholders.")
    ap.add_argument("--project-policy", choices=PROJECT_POLICY_CHOICES, default="real_project", help="Project root policy.")
    mode = ap.add_mutually_exclusive_group()
    mode.add_argument("--force", action="store_true", help="Overwrite all scaffold files, including user-owned seed files.")
    mode.add_argument(
        "--refresh",
        action="store_true",
        help="Re-apply managed scaffold docs only (back up changed files); never write user seed files.",
    )
    ap.add_argument("--dry-run", action="store_true", help="With --refresh, report what would change without writing.")
    args = ap.parse_args()

    if args.dry_run and not args.refresh:
        ap.error("--dry-run is only valid together with --refresh")

    result = ensure_project_scaffold(
        repo_root=args.root.expanduser().resolve(),
        project_name=args.project or None,
        profile=args.profile or None,
        force=bool(args.force),
        refresh=bool(args.refresh),
        dry_run=bool(args.dry_run),
        project_policy=args.project_policy,
    )
    print(json.dumps(result, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:
        print(f"[error] {exc}", file=sys.stderr)
        raise SystemExit(1)
