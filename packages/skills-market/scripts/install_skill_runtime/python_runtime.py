from __future__ import annotations

import os
import pathlib
import sys
from typing import Any

from .source_payload import run_checked, safe_remove


def python_bin_relative_path() -> pathlib.PurePosixPath:
    if os.name == "nt":
        return pathlib.PurePosixPath(".venv/Scripts/python.exe")
    return pathlib.PurePosixPath(".venv/bin/python")


def resolve_base_python() -> pathlib.Path:
    current = pathlib.Path(sys.executable).resolve()
    prefix = pathlib.Path(sys.prefix).resolve()
    base_prefix = pathlib.Path(sys.base_prefix).resolve()
    if prefix == base_prefix:
        return current

    candidates: list[pathlib.Path] = []
    try:
        candidates.append(base_prefix / current.relative_to(prefix))
    except ValueError:
        pass

    subdir = "Scripts" if os.name == "nt" else "bin"
    candidates.extend(
        [
            base_prefix / subdir / current.name,
            base_prefix / subdir / "python3",
            base_prefix / subdir / "python",
        ]
    )
    for candidate in candidates:
        if candidate.is_file():
            return candidate.resolve()
    raise RuntimeError(
        "installer is running inside a virtual environment but could not locate a base interpreter "
        f"under {base_prefix}"
    )


def create_isolated_venv(skill_root: pathlib.Path, packages: list[str]) -> dict[str, Any]:
    venv_dir = skill_root / ".venv"
    python_executable = resolve_base_python()
    try:
        run_checked([str(python_executable), "-m", "venv", str(venv_dir)])
        venv_python = skill_root / python_bin_relative_path()
        if not venv_python.is_file():
            raise RuntimeError(f"created venv is missing interpreter: {venv_python}")
        if packages:
            run_checked(
                [
                    str(venv_python),
                    "-m",
                    "pip",
                    "install",
                    "--disable-pip-version-check",
                    "--no-input",
                    "--no-cache-dir",
                    *packages,
                ]
            )
    except RuntimeError:
        if venv_dir.exists():
            safe_remove(venv_dir)
        raise

    return {
        "mode": "isolated-venv",
        "venv_dir": ".venv",
        "venv_python": python_bin_relative_path().as_posix(),
        "installer_python": str(python_executable),
        "packages": packages,
    }
