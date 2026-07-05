from __future__ import annotations

import json
import pathlib
import sys

import pytest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1] / "scripts"))

from install_skill_runtime.cli import main as install_main

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


@pytest.mark.parametrize("package_id", ["codex-cli-runner"])
def test_real_packages_are_pinned_for_auto_safe(package_id: str) -> None:
    package = _load_package(package_id)
    assert package["install_policy"] == {"auto_safe": {"human_pre_approved": True}}
    assert package["source"]["repo"] == "nullius/skills"
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
