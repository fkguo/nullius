#!/usr/bin/env python3
"""Generate the ecosystem-manifest ``components`` block from the market catalog.

The manifest ``components`` map is a projection of ``packages/*.json``. Editing a
skill package (channel bump, new version, added dependency) should not require a
second hand-edit of the manifest; run this generator instead, or let CI's
``--check`` mode fail closed when the two drift.

Usage:
  # Rewrite the manifest components in place from the catalog (single source):
  python3 scripts/generate_manifest_components.py --write

  # Fail (exit 1) if the manifest components differ from the catalog projection:
  python3 scripts/generate_manifest_components.py --check

The manifest path defaults to the in-repo ``meta/compatibility-matrix`` layout and
can be overridden with --manifest or the NULLIUS_META_MANIFEST / NULLIUS_META_ROOT
env vars (same resolution as the market validator).
"""

from __future__ import annotations

import argparse
import json
import os
import pathlib
import sys

from manifest_components import expected_components, load_market_packages, merge_components

SCRIPT_ROOT = pathlib.Path(__file__).resolve().parent
MARKET_ROOT = SCRIPT_ROOT.parent


def default_manifest_path() -> pathlib.Path:
    meta_root = pathlib.Path(
        os.environ.get("NULLIUS_META_ROOT", str(MARKET_ROOT.parent.parent / "meta"))
    ).expanduser()
    return pathlib.Path(
        os.environ.get(
            "NULLIUS_META_MANIFEST",
            str(meta_root / "compatibility-matrix" / "ecosystem-manifest.json"),
        )
    ).expanduser()


def _dump(manifest: dict[str, object]) -> str:
    return json.dumps(manifest, ensure_ascii=False, indent=2) + "\n"


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--write", action="store_true", help="Rewrite the manifest components in place from the catalog.")
    mode.add_argument("--check", action="store_true", help="Exit non-zero if manifest components differ from the catalog.")
    parser.add_argument("--packages-dir", default=str(MARKET_ROOT / "packages"), help="Market packages directory.")
    parser.add_argument("--manifest", default=None, help="Path to ecosystem-manifest.json.")
    args = parser.parse_args(argv)

    packages_dir = pathlib.Path(args.packages_dir).expanduser().resolve()
    manifest_path = pathlib.Path(args.manifest).expanduser() if args.manifest else default_manifest_path()

    try:
        packages = load_market_packages(packages_dir)
    except (RuntimeError, OSError) as exc:
        print(f"[error] {exc}", file=sys.stderr)
        return 1

    components = expected_components(packages)

    if not manifest_path.exists():
        print(f"[error] manifest not found: {manifest_path}", file=sys.stderr)
        return 1
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError) as exc:
        print(f"[error] cannot read manifest {manifest_path}: {exc}", file=sys.stderr)
        return 1

    regenerated = merge_components(manifest, components)

    if args.check:
        if manifest.get("components") != components:
            print(
                "[error] manifest components are stale; regenerate with "
                "`python3 scripts/generate_manifest_components.py --write`",
                file=sys.stderr,
            )
            return 1
        print("[ok] manifest components match the market catalog")
        return 0

    # --write
    new_text = _dump(regenerated)
    if manifest_path.read_text(encoding="utf-8") == new_text:
        print(f"[ok] manifest components already current: {manifest_path}")
        return 0
    manifest_path.write_text(new_text, encoding="utf-8")
    print(f"[ok] rewrote manifest components from catalog: {manifest_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
