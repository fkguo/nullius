from __future__ import annotations

import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

from validate_market_runtime.contracts import load_json
from validate_market_runtime.package_checks import build_constraints_from_schema, validate_package


def _validator_inputs() -> tuple[set[str], set[str], set[str], set[str], set[str]]:
    schema = load_json(ROOT / "schemas" / "market-package.schema.json")
    required_keys, allowed_types, allowed_channels, allowed_platforms = build_constraints_from_schema(schema)
    allowed_properties = set(schema.get("properties", {}).keys())
    return required_keys, allowed_types, allowed_channels, allowed_platforms, allowed_properties


def _base_skill() -> dict[str, object]:
    return {
        "package_id": "sample-skill",
        "package_type": "skill-pack",
        "repo": "autoresearch-lab/skills-market",
        "channel": "dev",
        "version": "0.1.0",
        "summary": "Sample skill",
        "platforms": ["codex", "claude_code", "opencode"],
        "source_path": "skills/sample-skill/SKILL.md",
        "install": {"codex": "install"},
        "source": {
            "repo": "autoresearch-lab/skills",
            "ref": "main",
            "subpath": "skills/sample-skill",
            "include": ["SKILL.md"],
            "exclude": [],
        },
    }


def test_runtime_python_is_valid_for_skill_pack() -> None:
    required, types, channels, platforms, properties = _validator_inputs()
    data = _base_skill()
    data["runtime"] = {"python": {"mode": "isolated-venv", "packages": ["pyyaml>=6,<7"]}}
    errs = validate_package(
        path=ROOT / "packages" / "sample-skill.json",
        data=data,
        required_keys=required,
        allowed_types=types,
        allowed_channels=channels,
        allowed_platforms=platforms,
        package_versions={"sample-skill": "0.1.0"},
        allowed_properties=properties,
    )
    assert errs == []


def test_runtime_python_is_rejected_for_non_skill_pack() -> None:
    required, types, channels, platforms, properties = _validator_inputs()
    data = _base_skill()
    data["package_type"] = "workflow-pack"
    data["runtime"] = {"python": {"mode": "isolated-venv", "packages": []}}
    errs = validate_package(
        path=ROOT / "packages" / "sample-skill.json",
        data=data,
        required_keys=required,
        allowed_types=types,
        allowed_channels=channels,
        allowed_platforms=platforms,
        package_versions={"sample-skill": "0.1.0"},
        allowed_properties=properties,
    )
    assert "runtime is only allowed for skill-pack entries" in "\n".join(errs)


def test_runtime_python_mode_must_match_contract() -> None:
    required, types, channels, platforms, properties = _validator_inputs()
    data = _base_skill()
    data["runtime"] = {"python": {"mode": "shared-python", "packages": []}}
    errs = validate_package(
        path=ROOT / "packages" / "sample-skill.json",
        data=data,
        required_keys=required,
        allowed_types=types,
        allowed_channels=channels,
        allowed_platforms=platforms,
        package_versions={"sample-skill": "0.1.0"},
        allowed_properties=properties,
    )
    assert "runtime.python.mode must be 'isolated-venv'" in "\n".join(errs)


def test_runtime_python_packages_must_be_non_empty_strings() -> None:
    required, types, channels, platforms, properties = _validator_inputs()
    data = _base_skill()
    data["runtime"] = {"python": {"mode": "isolated-venv", "packages": ["", 123]}}
    errs = validate_package(
        path=ROOT / "packages" / "sample-skill.json",
        data=data,
        required_keys=required,
        allowed_types=types,
        allowed_channels=channels,
        allowed_platforms=platforms,
        package_versions={"sample-skill": "0.1.0"},
        allowed_properties=properties,
    )
    joined = "\n".join(errs)
    assert "runtime.python.packages[0] must be a non-empty string" in joined
    assert "runtime.python.packages[1] must be a non-empty string" in joined


def test_install_policy_auto_safe_is_valid_for_skill_pack() -> None:
    required, types, channels, platforms, properties = _validator_inputs()
    data = _base_skill()
    data["install_policy"] = {"auto_safe": {"human_pre_approved": True}}
    data["source"]["ref"] = "0123456789abcdef0123456789abcdef01234567"
    errs = validate_package(
        path=ROOT / "packages" / "sample-skill.json",
        data=data,
        required_keys=required,
        allowed_types=types,
        allowed_channels=channels,
        allowed_platforms=platforms,
        package_versions={"sample-skill": "0.1.0"},
        allowed_properties=properties,
    )
    assert errs == []


def test_install_policy_auto_safe_requires_immutable_source_ref() -> None:
    required, types, channels, platforms, properties = _validator_inputs()
    data = _base_skill()
    data["install_policy"] = {"auto_safe": {"human_pre_approved": True}}
    errs = validate_package(
        path=ROOT / "packages" / "sample-skill.json",
        data=data,
        required_keys=required,
        allowed_types=types,
        allowed_channels=channels,
        allowed_platforms=platforms,
        package_versions={"sample-skill": "0.1.0"},
        allowed_properties=properties,
    )
    assert "auto-safe source.ref must be an immutable 40-character git SHA" in "\n".join(errs)


def test_research_team_package_metadata_describes_copy_vs_symlink_install() -> None:
    required, types, channels, platforms, properties = _validator_inputs()
    package_path = ROOT / "packages" / "research-team.json"
    data = load_json(package_path)
    errs = validate_package(
        path=package_path,
        data=data,
        required_keys=required,
        allowed_types=types,
        allowed_channels=channels,
        allowed_platforms=platforms,
        package_versions={"research-team": str(data["version"]), "literature-workflows": "0.1.0"},
        allowed_properties=properties,
    )
    assert errs == []
    assert data["source"]["subpath"] == "skills/research-team"

    expected_scripts = {
        "claude_code": "packages/skills-market/scripts/install_symlink_claude_code.sh",
        "codex": "packages/skills-market/scripts/install_symlink_codex.sh",
        "opencode": "packages/skills-market/scripts/install_symlink_opencode.sh",
    }
    for platform, script_path in expected_scripts.items():
        install_text = str(data["install"][platform]).lower()
        assert "copies this skill into the target" in install_text
        assert "reinstall" in install_text
        assert "--force" in install_text
        assert "live repo-tracking development installs" in install_text
        assert script_path in install_text
        assert "all market-listed skill-pack" in install_text
        assert "symlink" in install_text
        assert "monorepo skills root" in install_text
