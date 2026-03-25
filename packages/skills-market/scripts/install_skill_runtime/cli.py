from __future__ import annotations

import argparse
import pathlib
import sys
import tempfile

from market_install_policy import evaluate_auto_safe_closure, format_auto_safe_rejection, write_auto_safe_audit
from .install_flow import install_payload
from .market_index import default_market_root, load_packages, pick_packages, resolve_dependency_order
from .package_contracts import ensure_install_policy, ensure_python_runtime, ensure_skill_source, platform_root
from .source_payload import clone_source_repo, collect_payload_files, git_head


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    script_path = pathlib.Path(__file__)
    parser = argparse.ArgumentParser(description="Install selected skills from skills-market metadata.")
    parser.add_argument("--platform", required=True, choices=["codex", "claude_code", "opencode"])
    parser.add_argument("--package", action="append", default=[], help="Package id to install. Repeatable.")
    parser.add_argument("--all", action="store_true", help="Install all skill-pack packages from the market index.")
    parser.add_argument("--market-root", default=str(default_market_root(script_path)))
    parser.add_argument("--source-root", default=None, help="Use local source repo root instead of cloning from GitHub.")
    parser.add_argument("--target-root", default=None, help="Override target install root for the selected platform.")
    parser.add_argument("--no-deps", action="store_true", help="Do not auto-install skill-pack dependencies.")
    parser.add_argument(
        "--strict-deps",
        action="store_true",
        help="Fail if non-skill dependencies are detected (tool/workflow/engine/contract packs).",
    )
    parser.add_argument("--force", action="store_true", help="Replace existing installed skill directories.")
    parser.add_argument("--dry-run", action="store_true", help="Resolve and print installation plan without writing files.")
    parser.add_argument(
        "--auto-safe",
        action="store_true",
        help="Install only when the full requested skill closure satisfies the bounded auto-safe policy.",
    )
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    try:
        if args.auto_safe:
            if args.all:
                raise RuntimeError("--auto-safe requires explicit --package and does not allow --all")
            if not args.package:
                raise RuntimeError("--auto-safe requires at least one --package")
            if args.no_deps:
                raise RuntimeError("--auto-safe requires dependency closure and rejects --no-deps")

        market_root = pathlib.Path(args.market_root).expanduser().resolve()
        target_root = platform_root(
            args.platform,
            pathlib.Path(args.target_root).expanduser() if args.target_root else None,
        )
        packages = load_packages(market_root)
        selected = pick_packages(all_skills=args.all, package_ids=args.package, packages=packages)
        order, non_skill_deps = resolve_dependency_order(selected, packages=packages, install_deps=not args.no_deps)
        auto_safe_evaluation = None
        package_auto_safe_records: dict[str, dict[str, object]] = {}
        if args.auto_safe:
            auto_safe_evaluation = evaluate_auto_safe_closure(
                requested_packages=selected,
                ordered_packages=order,
                packages=packages,
                non_skill_deps=non_skill_deps,
            )
            if not auto_safe_evaluation["eligible"]:
                if not args.dry_run:
                    write_auto_safe_audit(target_root, auto_safe_evaluation, result="rejected")
                raise RuntimeError(format_auto_safe_rejection(auto_safe_evaluation))
            package_auto_safe_records = {
                str(entry["package_id"]): {
                    **entry,
                    "closure_package_ids": list(auto_safe_evaluation["resolved_packages"]),
                }
                for entry in auto_safe_evaluation["evaluated_packages"]
            }

        if non_skill_deps and not args.auto_safe:
            lines = [f"  - {package_id}: {', '.join(sorted(set(deps)))}" for package_id, deps in sorted(non_skill_deps.items())]
            message = "non-skill dependencies detected (must be installed/configured separately):\n" + "\n".join(lines)
            if args.strict_deps:
                raise RuntimeError(message)
            print(f"[warn] {message}", file=sys.stderr)

        local_source_root = pathlib.Path(args.source_root).expanduser().resolve() if args.source_root else None
        clone_cache: dict[tuple[str, str], pathlib.Path] = {}
        try:
            with tempfile.TemporaryDirectory(prefix="skills-market-install-") as tmp:
                temp_dir = pathlib.Path(tmp)
                for package_id in order:
                    package = packages[package_id]
                    ensure_install_policy(package_id, package)
                    if package.get("package_type") != "skill-pack":
                        print(f"[skip] {package_id}: package_type={package.get('package_type')} (not a skill-pack)")
                        continue

                    source = ensure_skill_source(package_id, package)
                    runtime = ensure_python_runtime(package_id, package)
                    repo = str(source["repo"])
                    ref = str(source["ref"])
                    cache_key = (repo, ref)
                    if local_source_root is not None:
                        repo_root_path = local_source_root
                    else:
                        if cache_key not in clone_cache:
                            clone_cache[cache_key] = clone_source_repo(repo, ref, temp_dir)
                        repo_root_path = clone_cache[cache_key]

                    source_dir = (repo_root_path / str(source["subpath"])).resolve()
                    try:
                        source_dir.relative_to(repo_root_path.resolve())
                    except Exception as exc:
                        raise RuntimeError(f"{package_id}: source.subpath escapes repository root: {source['subpath']}") from exc

                    files = collect_payload_files(
                        source_dir,
                        [str(item) for item in source.get("include", [])],
                        [str(item) for item in source.get("exclude", [])],
                    )
                    install_payload(
                        package_id=package_id,
                        target_root=target_root,
                        source_dir=source_dir,
                        files=files,
                        metadata={
                            "source_repo": repo,
                            "source_ref": ref,
                            "source_subpath": str(pathlib.Path(str(source["subpath"])).as_posix()),
                            "source_commit": git_head(repo_root_path),
                        },
                        python_runtime=runtime,
                        install_mode="auto_safe" if args.auto_safe else "default",
                        auto_safe_evaluation=package_auto_safe_records.get(package_id),
                        force=args.force,
                        dry_run=args.dry_run,
                    )
        except RuntimeError as exc:
            if auto_safe_evaluation is not None and not args.dry_run:
                write_auto_safe_audit(target_root, auto_safe_evaluation, result="failed", error=str(exc))
            raise

        if auto_safe_evaluation is not None and not args.dry_run:
            write_auto_safe_audit(target_root, auto_safe_evaluation, result="installed")
        return 0
    except RuntimeError as exc:
        print(f"[error] {exc}", file=sys.stderr)
        return 1
