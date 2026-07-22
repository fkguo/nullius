"""Tests for the version-pinned shared Gaia SDK reference helper."""

from __future__ import annotations

from pathlib import Path

import pytest

import gaia_package_scaffold as scaffold
import prepare_gaia_sdk_reference as sdk_reference
import run_infer_and_extract as extract


EXPECTED_FILES = (
    "CHEATSHEET.md",
    "index.md",
    "gaia_engine_lang.md",
    "gaia_engine_bayes.md",
)


def write_fake_gaia(path: Path, version: str = "0.5.0a4") -> Path:
    log = path.with_suffix(".log")
    path.write_text(
        f'''#!/usr/bin/env python3
import sys
from pathlib import Path

log = Path({str(log)!r})
args = sys.argv[1:]
if args == ["--version"]:
    log.write_text(log.read_text() + "version\\n" if log.exists() else "version\\n")
    print("gaia-lang {version}")
    raise SystemExit(0)
if len(args) == 3 and args[:2] == ["sdk", "--out"]:
    output = Path(args[2])
    output.mkdir(parents=True, exist_ok=True)
    for name in {EXPECTED_FILES!r}:
        (output / name).write_text(name, encoding="utf-8")
    log.write_text(log.read_text() + "sdk\\n" if log.exists() else "sdk\\n")
    raise SystemExit(0)
raise SystemExit(9)
''',
        encoding="utf-8",
    )
    path.chmod(0o755)
    return path


def test_materializes_one_shared_reference_and_reuses_it(tmp_path, capsys) -> None:
    fake_gaia = write_fake_gaia(tmp_path / "fake-gaia")
    cache_root = tmp_path / "cache"
    args = ["--gaia-bin", str(fake_gaia), "--cache-root", str(cache_root)]

    assert sdk_reference.main(args) == 0
    target = cache_root / f"gaia-lang-{sdk_reference.GAIA_PIN}"
    assert capsys.readouterr().out.strip() == str(target)
    assert all((target / name).is_file() for name in EXPECTED_FILES)
    assert not (tmp_path / "graph" / "gaia-sdk").exists()

    assert sdk_reference.main(args) == 0
    assert capsys.readouterr().out.strip() == str(target)
    assert fake_gaia.with_suffix(".log").read_text(encoding="utf-8").splitlines().count("sdk") == 1


def test_rejects_an_incomplete_cache_without_overwriting_it(tmp_path, capsys) -> None:
    fake_gaia = write_fake_gaia(tmp_path / "fake-gaia")
    cache_root = tmp_path / "cache"
    target = cache_root / f"gaia-lang-{sdk_reference.GAIA_PIN}"
    target.mkdir(parents=True)
    (target / "CHEATSHEET.md").write_text("partial", encoding="utf-8")

    assert sdk_reference.main([
        "--gaia-bin", str(fake_gaia), "--cache-root", str(cache_root),
    ]) == 2
    assert "incomplete Gaia SDK cache" in capsys.readouterr().err
    assert (target / "CHEATSHEET.md").read_text(encoding="utf-8") == "partial"
    assert not fake_gaia.with_suffix(".log").read_text(encoding="utf-8").splitlines().count("sdk")


def test_rejects_a_near_miss_version_before_creating_the_cache(tmp_path) -> None:
    fake_gaia = write_fake_gaia(tmp_path / "fake-gaia", version="0.5.0a41")
    with pytest.raises(SystemExit) as excinfo:
        sdk_reference.main([
            "--gaia-bin", str(fake_gaia), "--cache-root", str(tmp_path / "cache"),
        ])
    assert excinfo.value.code == 2
    assert not (tmp_path / "cache").exists()


def test_shared_helper_uses_the_same_gaia_pin_as_the_pipeline() -> None:
    assert sdk_reference.GAIA_PIN == scaffold.GAIA_PIN == extract.GAIA_PIN
