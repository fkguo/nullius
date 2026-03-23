from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from .project_policy import PROJECT_POLICY_CHOICES
from .project_scaffold import ensure_project_scaffold


def main() -> int:
    ap = argparse.ArgumentParser(description="Render the canonical project scaffold.")
    ap.add_argument("--root", type=Path, required=True, help="Project root to scaffold.")
    ap.add_argument("--project", default="", help="Project display name.")
    ap.add_argument("--profile", default="mixed", help="Optional profile hint for scaffold placeholders.")
    ap.add_argument("--variant", choices=("minimal", "full"), default="minimal", help="Scaffold size policy.")
    ap.add_argument("--project-policy", choices=PROJECT_POLICY_CHOICES, default="real_project", help="Project root policy.")
    ap.add_argument("--force", action="store_true", help="Overwrite scaffold-managed files.")
    args = ap.parse_args()

    result = ensure_project_scaffold(
        repo_root=args.root.expanduser().resolve(),
        project_name=args.project or None,
        profile=args.profile or None,
        variant=args.variant,
        force=bool(args.force),
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
