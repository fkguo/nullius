from __future__ import annotations

import json
import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / "scripts"))

from generate_manifest_components import main as generate_main
from manifest_components import component_from_package, expected_components
from validate_market_runtime.manifest_alignment import validate_manifest_alignment


def _skill_package(package_id: str, **overrides: object) -> dict[str, object]:
    package: dict[str, object] = {
        "package_id": package_id,
        "package_type": "skill-pack",
        "repo": "nullius/skills-market",
        "channel": "dev",
        "version": "0.1.0",
        "source_path": f"skills/{package_id}/SKILL.md",
    }
    package.update(overrides)
    return package


def _write_manifest(path: pathlib.Path, components: dict[str, object]) -> None:
    manifest = {
        "manifest_version": "1.0.0",
        "updated_at": "2026-01-01T00:00:00Z",
        "org": "nullius",
        "channels": ["stable", "beta", "dev"],
        "components": components,
        "platforms": {
            "claude_code": {"install_mode": "x"},
            "codex": {"install_mode": "x"},
            "opencode": {"install_mode": "x"},
        },
    }
    path.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")


def test_component_projection_omits_absent_fields_and_keeps_depends_on() -> None:
    package = _skill_package("child", depends_on={"other": ">=0.1.0 <0.2.0"})
    component = component_from_package(package)
    assert component == {
        "type": "skill-pack",
        "repo": "nullius/skills-market",
        "channel": "dev",
        "version": "0.1.0",
        "source_path": "skills/child/SKILL.md",
        "depends_on": {"other": ">=0.1.0 <0.2.0"},
    }
    # package_id and summary/install are NOT projected into the component block.
    assert "package_id" not in component


def test_alignment_passes_when_manifest_matches_catalog(tmp_path: pathlib.Path) -> None:
    packages = {p["package_id"]: p for p in [_skill_package("a"), _skill_package("b", channel="beta")]}
    manifest_path = tmp_path / "manifest.json"
    _write_manifest(manifest_path, expected_components(packages))
    errs, warns = validate_manifest_alignment(packages, manifest_path=manifest_path, explicit_manifest_path=True)
    assert errs == []


def test_alignment_fails_closed_on_dropped_depends_on(tmp_path: pathlib.Path) -> None:
    packages = {"a": _skill_package("a", depends_on={"b": ">=0.1.0 <0.2.0"}), "b": _skill_package("b")}
    stale = expected_components(packages)
    del stale["a"]["depends_on"]  # simulate the historical manifest drift
    manifest_path = tmp_path / "manifest.json"
    _write_manifest(manifest_path, stale)
    errs, _ = validate_manifest_alignment(packages, manifest_path=manifest_path, explicit_manifest_path=True)
    assert any("'a' is stale" in e for e in errs)
    assert any("generate_manifest_components.py --write" in e for e in errs)


def test_alignment_fails_closed_on_extra_manifest_component(tmp_path: pathlib.Path) -> None:
    packages = {"a": _skill_package("a")}
    components = expected_components(packages)
    components["ghost"] = {"type": "skill-pack", "repo": "nullius/skills-market", "channel": "dev", "version": "0.1.0"}
    manifest_path = tmp_path / "manifest.json"
    _write_manifest(manifest_path, components)
    errs, _ = validate_manifest_alignment(packages, manifest_path=manifest_path, explicit_manifest_path=True)
    assert any("missing in market index" in e and "ghost" in e for e in errs)


def test_generator_write_then_check_roundtrip(tmp_path: pathlib.Path) -> None:
    packages_dir = tmp_path / "packages"
    packages_dir.mkdir()
    for package in [_skill_package("a"), _skill_package("b", depends_on={"a": ">=0.1.0 <0.2.0"})]:
        (packages_dir / f"{package['package_id']}.json").write_text(json.dumps(package, indent=2) + "\n", encoding="utf-8")
    (packages_dir / "index.json").write_text(json.dumps({"packages": ["a.json", "b.json"]}) + "\n", encoding="utf-8")
    manifest_path = tmp_path / "manifest.json"
    _write_manifest(manifest_path, {})  # deliberately empty -> stale

    # --check must fail on the stale (empty) components block.
    assert generate_main(["--check", "--packages-dir", str(packages_dir), "--manifest", str(manifest_path)]) == 1
    # --write brings it into alignment.
    assert generate_main(["--write", "--packages-dir", str(packages_dir), "--manifest", str(manifest_path)]) == 0
    # --check now passes and non-component fields survived the rewrite.
    assert generate_main(["--check", "--packages-dir", str(packages_dir), "--manifest", str(manifest_path)]) == 0
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    assert manifest["org"] == "nullius"
    assert set(manifest["components"]) == {"a", "b"}
    assert manifest["components"]["b"]["depends_on"] == {"a": ">=0.1.0 <0.2.0"}
