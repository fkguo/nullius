from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from .project_policy import (
    PROJECT_POLICY_CHOICES,
    assert_path_allowed,
    assert_path_within_project,
    assert_project_root_allowed,
    resolve_user_path,
)


def _print(payload: dict[str, str]) -> int:
    print(json.dumps(payload, indent=2, sort_keys=True))
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description="Validate project-root and output path policy.")
    sp = ap.add_subparsers(dest="cmd", required=True)

    p_root = sp.add_parser("assert-root", help="Validate a project root under the selected policy.")
    p_root.add_argument("--project-root", required=True, type=Path)
    p_root.add_argument("--project-policy", choices=PROJECT_POLICY_CHOICES, default="real_project")

    p_path = sp.add_parser("assert-path", help="Validate a single path under the selected policy.")
    p_path.add_argument("--path", required=True, type=Path)
    p_path.add_argument("--project-policy", choices=PROJECT_POLICY_CHOICES, default="real_project")
    p_path.add_argument("--label", default="path")
    p_path.add_argument("--resolve-from", type=Path, default=Path.cwd())

    p_run = sp.add_parser("assert-run-paths", help="Validate project root, notebook, and output path together.")
    p_run.add_argument("--project-root", required=True, type=Path)
    p_run.add_argument("--notes", required=True, type=Path)
    p_run.add_argument("--out-dir", required=True, type=Path)
    p_run.add_argument("--project-policy", choices=PROJECT_POLICY_CHOICES, default="real_project")
    p_run.add_argument("--resolve-from", type=Path, default=Path.cwd())

    args = ap.parse_args()

    if args.cmd == "assert-root":
        root = assert_project_root_allowed(args.project_root, project_policy=args.project_policy)
        return _print({"project_policy": args.project_policy, "project_root": str(root)})

    if args.cmd == "assert-path":
        path = assert_path_allowed(
            args.path,
            project_policy=args.project_policy,
            label=args.label,
            base=resolve_user_path(args.resolve_from),
        )
        return _print({"label": args.label, "path": str(path), "project_policy": args.project_policy})

    project_root = assert_project_root_allowed(args.project_root, project_policy=args.project_policy)
    resolve_from = resolve_user_path(args.resolve_from)
    notes = resolve_user_path(args.notes, base=resolve_from)
    out_dir = assert_path_allowed(
        args.out_dir,
        project_policy=args.project_policy,
        label="team output path",
        base=resolve_from,
    )
    assert_path_allowed(notes, project_policy=args.project_policy, label="research notebook")
    assert_path_within_project(notes, project_root=project_root, label="research notebook")
    return _print(
        {
            "notes": str(notes),
            "out_dir": str(out_dir),
            "project_policy": args.project_policy,
            "project_root": str(project_root),
        }
    )


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:
        print(f"[error] {exc}", file=sys.stderr)
        raise SystemExit(1)
