from __future__ import annotations

import json
import pathlib
import sys

import pytest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / "scripts"))

from install_skill_runtime.cli import main as install_main
from install_skill_runtime.python_runtime import python_bin_relative_path
import install_skill_runtime.install_flow as install_flow

ROOT = pathlib.Path(__file__).resolve().parents[1]
REPO_ROOT = ROOT.parents[1]
IMMUTABLE_REF = "52956e32da7fa9c8c523a22736081d2ac91d92e2"


def _load_package(package_id: str) -> dict[str, object]:
    return json.loads((ROOT / "packages" / f"{package_id}.json").read_text(encoding="utf-8"))


def _read_json(path: pathlib.Path) -> dict[str, object]:
    return json.loads(path.read_text(encoding="utf-8"))


def _install_args(package_id: str, target_root: pathlib.Path) -> list[str]:
    return [
        "--platform",
        "codex",
        "--market-root",
        str(ROOT),
        "--source-root",
        str(REPO_ROOT),
        "--target-root",
        str(target_root),
        "--package",
        package_id,
        "--auto-safe",
    ]


def _fake_create_isolated_venv(skill_root: pathlib.Path, packages: list[str]) -> dict[str, object]:
    venv_python = skill_root.joinpath(*python_bin_relative_path().parts)
    venv_python.parent.mkdir(parents=True, exist_ok=True)
    venv_python.write_text("#!/usr/bin/env python3\n", encoding="utf-8")
    venv_python.chmod(0o755)
    return {
        "mode": "isolated-venv",
        "venv_dir": ".venv",
        "venv_python": python_bin_relative_path().as_posix(),
        "installer_python": "test-python",
        "packages": packages,
    }


@pytest.mark.parametrize("package_id", ["codex-cli-runner", "auto-relay"])
def test_real_packages_are_pinned_for_auto_safe(package_id: str) -> None:
    package = _load_package(package_id)
    assert package["install_policy"] == {"auto_safe": {"human_pre_approved": True}}
    assert package["source"]["repo"] == "autoresearch-lab/skills"
    assert package["source"]["ref"] == IMMUTABLE_REF


def test_real_codex_cli_runner_auto_safe_install_succeeds(tmp_path: pathlib.Path) -> None:
    target_root = tmp_path / "target"
    rc = install_main(_install_args("codex-cli-runner", target_root))
    assert rc == 0

    install_dir = target_root / "codex-cli-runner"
    assert install_dir.is_dir()
    assert (install_dir / "SKILL.md").is_file()
    assert (install_dir / "scripts" / "run_codex.sh").is_file()

    install_record = _read_json(install_dir / ".market_install.json")
    assert install_record["install_mode"] == "auto_safe"
    assert install_record["source_ref"] == IMMUTABLE_REF
    assert install_record["auto_safe_evaluation"]["eligible"] is True
    assert "python_runtime" not in install_record

    audit = _read_json(target_root / ".auto_safe_install_audit.json")
    assert audit["result"] == "installed"
    assert audit["eligible"] is True
    assert audit["requested_packages"] == ["codex-cli-runner"]
    assert audit["resolved_packages"] == ["codex-cli-runner"]


def test_real_auto_relay_auto_safe_install_succeeds_with_runtime_seam(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: pathlib.Path,
) -> None:
    # Keep the rollout proof local and deterministic while still exercising the real package metadata.
    monkeypatch.setattr(install_flow, "create_isolated_venv", _fake_create_isolated_venv)

    target_root = tmp_path / "target"
    rc = install_main(_install_args("auto-relay", target_root))
    assert rc == 0

    install_dir = target_root / "auto-relay"
    assert install_dir.is_dir()
    assert (install_dir / "SKILL.md").is_file()
    assert (install_dir / "scripts" / "relay.py").is_file()
    assert (install_dir / "schemas" / "profile.schema.json").is_file()
    assert (install_dir / "templates" / "next_prompt.md.j2").is_file()

    install_record = _read_json(install_dir / ".market_install.json")
    assert install_record["install_mode"] == "auto_safe"
    assert install_record["source_ref"] == IMMUTABLE_REF
    assert install_record["auto_safe_evaluation"]["eligible"] is True
    assert install_record["python_runtime"]["mode"] == "isolated-venv"
    assert install_record["python_runtime"]["packages"] == ["pyyaml>=6,<7"]

    skill_text = (install_dir / "SKILL.md").read_text(encoding="utf-8")
    assert "<!-- skills-market:python-runtime-note start -->" in skill_text
    assert install_dir.joinpath(*python_bin_relative_path().parts).is_file()

    audit = _read_json(target_root / ".auto_safe_install_audit.json")
    assert audit["result"] == "installed"
    assert audit["eligible"] is True
    assert audit["requested_packages"] == ["auto-relay"]
    assert audit["resolved_packages"] == ["auto-relay"]
