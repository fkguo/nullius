#!/usr/bin/env python3
"""Materialize one version-pinned Gaia SDK reference outside research packages.

The reference is authoring help, not argument-graph source.  Keep one cache
per exact Gaia pin under ``~/.cache/gaia-sdk/`` instead of generating an
identical ``gaia-sdk/`` directory inside every package.
"""

from __future__ import annotations

import argparse
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

GAIA_PIN = "0.5.0a4"
DEFAULT_CACHE_ROOT = Path.home() / ".cache" / "gaia-sdk"
EXPECTED_FILES = (
    "CHEATSHEET.md",
    "index.md",
    "gaia_engine_lang.md",
    "gaia_engine_bayes.md",
)
PIN_INSTALL_HINT = (
    "Install the pinned Gaia toolchain (the pin is deliberate; upgrading is an "
    "explicit, reviewed action):\n"
    "  uv venv .gaia-venv --python 3.12\n"
    f"  uv pip install --python .gaia-venv/bin/python gaia-lang=={GAIA_PIN}\n"
    "then pass --gaia-bin .gaia-venv/bin/gaia or export GAIA_BIN."
)


def resolve_gaia_bin(cli_value: str | None) -> str:
    """Resolve Gaia from --gaia-bin, then $GAIA_BIN, then PATH."""
    candidate = cli_value or os.environ.get("GAIA_BIN") or shutil.which("gaia")
    if not candidate:
        sys.stderr.write(
            "error: no `gaia` executable found (checked --gaia-bin, $GAIA_BIN, "
            "PATH).\n" + PIN_INSTALL_HINT + "\n"
        )
        raise SystemExit(2)
    return candidate


def check_gaia_version(gaia_bin: str) -> None:
    """Fail unless ``gaia --version`` reports the exact pinned version."""
    try:
        result = subprocess.run(
            [gaia_bin, "--version"],
            capture_output=True,
            text=True,
            timeout=60,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        sys.stderr.write(
            f"error: could not run `{gaia_bin} --version`: {exc}\n"
            + PIN_INSTALL_HINT
            + "\n"
        )
        raise SystemExit(2) from exc
    lines = (result.stdout or result.stderr).strip().splitlines()
    banner = lines[0] if lines else ""
    if result.returncode != 0 or GAIA_PIN not in banner.replace(",", " ").split():
        sys.stderr.write(
            f"error: gaia version mismatch: expected exactly {GAIA_PIN}, got "
            f"{banner!r}. The pin is explicit; do not silently upgrade or "
            "downgrade.\n" + PIN_INSTALL_HINT + "\n"
        )
        raise SystemExit(2)


def is_complete_sdk_reference(directory: Path) -> bool:
    """True only when every file the pinned ``gaia sdk`` command emits exists."""
    return directory.is_dir() and all((directory / name).is_file() for name in EXPECTED_FILES)


def cache_directory(cache_root: Path) -> Path:
    """Return the version-specific cache path without creating it."""
    return cache_root.expanduser().resolve() / f"gaia-lang-{GAIA_PIN}"


def materialize_sdk_reference(gaia_bin: str, cache_root: Path) -> Path:
    """Generate the reference once, atomically, without touching any package."""
    target = cache_directory(cache_root)
    if target.exists():
        if is_complete_sdk_reference(target):
            return target
        raise RuntimeError(
            f"incomplete Gaia SDK cache at {target}; preserve it for inspection "
            "and repair or remove it deliberately before retrying"
        )

    parent = target.parent
    parent.mkdir(parents=True, exist_ok=True)
    lock = parent / f".{target.name}.lock"
    try:
        lock.mkdir()
    except FileExistsError:
        if is_complete_sdk_reference(target):
            return target
        raise RuntimeError(
            f"Gaia SDK cache creation is already in progress at {lock}; retry "
            "after that invocation finishes"
        )

    temporary: Path | None = None
    try:
        if target.exists():
            if is_complete_sdk_reference(target):
                return target
            raise RuntimeError(
                f"incomplete Gaia SDK cache at {target}; preserve it for inspection "
                "and repair or remove it deliberately before retrying"
            )
        temporary = Path(tempfile.mkdtemp(prefix=f".{target.name}.", dir=parent))
        result = subprocess.run(
            [gaia_bin, "sdk", "--out", str(temporary)],
            capture_output=True,
            text=True,
            timeout=300,
            check=False,
        )
        if result.returncode != 0:
            detail = (result.stderr or result.stdout).strip()
            raise RuntimeError(
                f"`gaia sdk --out {temporary}` failed (exit {result.returncode})"
                + (f": {detail}" if detail else "")
            )
        if not is_complete_sdk_reference(temporary):
            missing = [name for name in EXPECTED_FILES if not (temporary / name).is_file()]
            raise RuntimeError(
                "`gaia sdk` did not produce the expected reference files: "
                + ", ".join(missing)
            )
        os.rename(temporary, target)
        return target
    finally:
        if temporary is not None and temporary.exists():
            shutil.rmtree(temporary)
        lock.rmdir()


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Generate one version-pinned Gaia SDK reference outside packages."
    )
    parser.add_argument(
        "--gaia-bin",
        default=None,
        help="path to the gaia executable (default: $GAIA_BIN, then PATH)",
    )
    parser.add_argument(
        "--cache-root",
        type=Path,
        default=DEFAULT_CACHE_ROOT,
        help="parent for versioned references (default: ~/.cache/gaia-sdk)",
    )
    args = parser.parse_args(argv)
    gaia_bin = resolve_gaia_bin(args.gaia_bin)
    check_gaia_version(gaia_bin)
    try:
        target = materialize_sdk_reference(gaia_bin, args.cache_root)
    except RuntimeError as exc:
        sys.stderr.write(f"error: {exc}\n")
        return 2
    print(target)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
