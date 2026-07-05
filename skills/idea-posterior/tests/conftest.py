"""Shared test setup: script imports and Gaia availability detection."""

from __future__ import annotations

import os
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

SCRIPTS_DIR = Path(__file__).resolve().parent.parent / "scripts"
FIXTURES_DIR = Path(__file__).resolve().parent / "fixtures"

sys.path.insert(0, str(SCRIPTS_DIR))

GAIA_PIN = "0.5.0a4"


def detect_gaia() -> tuple[str | None, str | None]:
    """Return (gaia path, None) or (None, reason it is unavailable)."""
    candidate = os.environ.get("GAIA_BIN") or shutil.which("gaia")
    if not candidate:
        return None, "no gaia executable via $GAIA_BIN or PATH"
    try:
        out = subprocess.run(
            [candidate, "--version"],
            capture_output=True,
            text=True,
            timeout=60,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        return None, f"could not run {candidate!r}: {exc}"
    lines = (out.stdout or out.stderr).strip().splitlines()
    banner = lines[0] if lines else ""
    if GAIA_PIN not in banner.replace(",", " ").split():
        return None, f"version mismatch: got {banner!r}, need exactly {GAIA_PIN}"
    return candidate, None


@pytest.fixture(scope="session")
def gaia_bin() -> str:
    """Path to a pinned gaia executable, or skip with the reason."""
    path, reason = detect_gaia()
    if path is None:
        pytest.skip(
            f"gaia {GAIA_PIN} unavailable ({reason}); install with: "
            "uv venv .gaia-venv --python 3.12 && "
            f"uv pip install --python .gaia-venv/bin/python gaia-lang=={GAIA_PIN} "
            "and export GAIA_BIN=.gaia-venv/bin/gaia"
        )
    return path


@pytest.fixture()
def fixtures_dir() -> Path:
    return FIXTURES_DIR
