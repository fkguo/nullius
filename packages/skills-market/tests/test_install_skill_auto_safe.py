from __future__ import annotations

import json
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

from install_skill_runtime.cli import main as install_main

IMMUTABLE_REF = "0123456789abcdef0123456789abcdef01234567"


def _skill_package(
    package_id: str,
    *,
    install_policy: dict[str, object] | None,
    ref: str,
    depends_on: dict[str, str] | None = None,
    runtime: dict[str, object] | None = None,
) -> dict[str, object]:
    package: dict[str, object] = {
        "package_id": package_id,
        "package_type": "skill-pack",
        "repo": "autoresearch-lab/skills-market",
        "channel": "dev",
        "version": "0.1.0",
        "summary": f"Skill {package_id}",
        "platforms": ["codex"],
        "source_path": f"~/.codex/skills/{package_id}/SKILL.md",
        "source": {
            "repo": "autoresearch-lab/skills",
            "ref": ref,
            "subpath": f"skills/{package_id}",
            "include": ["SKILL.md", "run.py"],
            "exclude": [],
        },
    }
    if install_policy is not None:
        package["install_policy"] = install_policy
    if depends_on is not None:
        package["depends_on"] = depends_on
    if runtime is not None:
        package["runtime"] = runtime
    return package


def _write_market(tmp_path: pathlib.Path, packages: list[dict[str, object]]) -> tuple[pathlib.Path, pathlib.Path]:
    market_root = tmp_path / "market"
    source_root = tmp_path / "source"
    package_dir = market_root / "packages"
    package_dir.mkdir(parents=True)
    listed: list[str] = []
    for package in packages:
        package_id = str(package["package_id"])
        listed.append(f"{package_id}.json")
        (package_dir / f"{package_id}.json").write_text(json.dumps(package, indent=2) + "\n", encoding="utf-8")
        if package.get("package_type") == "skill-pack":
            skill_dir = source_root / "skills" / package_id
            skill_dir.mkdir(parents=True)
            (skill_dir / "SKILL.md").write_text("---\nname: sample\n---\n\n# Sample Skill\n", encoding="utf-8")
            (skill_dir / "run.py").write_text("print('ok')\n", encoding="utf-8")
    (package_dir / "index.json").write_text(
        json.dumps({"index_version": "1.0.0", "updated_at": "2026-03-25T00:00:00Z", "packages": listed}, indent=2) + "\n",
        encoding="utf-8",
    )
    return market_root, source_root


def _read_audit(target_root: pathlib.Path) -> dict[str, object]:
    return json.loads((target_root / ".auto_safe_install_audit.json").read_text(encoding="utf-8"))


def test_auto_safe_rejects_missing_install_policy(capsys, tmp_path: pathlib.Path) -> None:
    market_root, source_root = _write_market(tmp_path, [_skill_package("missing-policy", install_policy=None, ref=IMMUTABLE_REF)])
    target_root = tmp_path / "target"
    rc = install_main(["--platform", "codex", "--market-root", str(market_root), "--source-root", str(source_root), "--target-root", str(target_root), "--package", "missing-policy", "--auto-safe"])
    assert rc == 1
    assert "human_pre_approved" in capsys.readouterr().err
    assert _read_audit(target_root)["result"] == "rejected"


def test_auto_safe_rejects_mutable_source_ref(capsys, tmp_path: pathlib.Path) -> None:
    market_root, source_root = _write_market(
        tmp_path,
        [_skill_package("mutable-ref", install_policy={"auto_safe": {"human_pre_approved": True}}, ref="main")],
    )
    target_root = tmp_path / "target"
    rc = install_main(["--platform", "codex", "--market-root", str(market_root), "--source-root", str(source_root), "--target-root", str(target_root), "--package", "mutable-ref", "--auto-safe"])
    assert rc == 1
    assert "immutable 40-character git SHA" in capsys.readouterr().err
    assert _read_audit(target_root)["result"] == "rejected"


def test_auto_safe_rejects_non_skill_dependencies(capsys, tmp_path: pathlib.Path) -> None:
    workflow_pack = {
        "package_id": "tooling-bundle",
        "package_type": "workflow-pack",
        "repo": "autoresearch-lab/skills-market",
        "channel": "dev",
        "version": "0.1.0",
        "summary": "Workflow dependency",
        "platforms": ["codex"],
    }
    skill_pack = _skill_package(
        "needs-workflow",
        install_policy={"auto_safe": {"human_pre_approved": True}},
        ref=IMMUTABLE_REF,
        depends_on={"tooling-bundle": ">=0.1.0 <0.2.0"},
    )
    market_root, source_root = _write_market(tmp_path, [skill_pack, workflow_pack])
    target_root = tmp_path / "target"
    rc = install_main(["--platform", "codex", "--market-root", str(market_root), "--source-root", str(source_root), "--target-root", str(target_root), "--package", "needs-workflow", "--auto-safe"])
    assert rc == 1
    assert "non-skill dependencies are not allowed" in capsys.readouterr().err
    assert _read_audit(target_root)["result"] == "rejected"


def test_auto_safe_rejects_ineligible_dependency_closure_atomically(capsys, tmp_path: pathlib.Path) -> None:
    root_skill = _skill_package(
        "root-skill",
        install_policy={"auto_safe": {"human_pre_approved": True}},
        ref=IMMUTABLE_REF,
        depends_on={"child-skill": ">=0.1.0 <0.2.0"},
    )
    child_skill = _skill_package("child-skill", install_policy=None, ref=IMMUTABLE_REF)
    market_root, source_root = _write_market(tmp_path, [root_skill, child_skill])
    target_root = tmp_path / "target"
    rc = install_main(["--platform", "codex", "--market-root", str(market_root), "--source-root", str(source_root), "--target-root", str(target_root), "--package", "root-skill", "--auto-safe"])
    assert rc == 1
    assert "child-skill" in capsys.readouterr().err
    assert not (target_root / "root-skill").exists()
    assert not (target_root / "child-skill").exists()
    assert _read_audit(target_root)["result"] == "rejected"


def test_auto_safe_install_writes_receipt_and_audit(tmp_path: pathlib.Path) -> None:
    market_root, source_root = _write_market(
        tmp_path,
        [
            _skill_package(
                "safe-skill",
                install_policy={"auto_safe": {"human_pre_approved": True}},
                ref=IMMUTABLE_REF,
                runtime={"python": {"mode": "isolated-venv", "packages": []}},
            )
        ],
    )
    target_root = tmp_path / "target"
    rc = install_main(["--platform", "codex", "--market-root", str(market_root), "--source-root", str(source_root), "--target-root", str(target_root), "--package", "safe-skill", "--auto-safe"])
    assert rc == 0
    install_record = json.loads((target_root / "safe-skill" / ".market_install.json").read_text(encoding="utf-8"))
    assert install_record["install_mode"] == "auto_safe"
    assert install_record["auto_safe_evaluation"]["eligible"] is True
    audit = _read_audit(target_root)
    assert audit["result"] == "installed"
    assert audit["eligible"] is True
