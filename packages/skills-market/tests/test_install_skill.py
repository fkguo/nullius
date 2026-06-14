from __future__ import annotations

import base64
import hashlib
import importlib.util
import json
import pathlib
import subprocess
import sys
import zipfile
from types import ModuleType, SimpleNamespace

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))

from install_skill_runtime.cli import main as install_main
from install_skill_runtime.market_index import default_market_root, load_json
from install_skill_runtime.python_runtime import python_bin_relative_path
from install_skill_runtime.source_payload import collect_payload_files
from install_skill_runtime.skill_note import NOTE_START, inject_python_runtime_note


def _installed_venv_python(install_dir: pathlib.Path) -> pathlib.Path:
    return install_dir.joinpath(*python_bin_relative_path().parts)


def _write_dummy_wheel(dist_dir: pathlib.Path, distribution: str) -> pathlib.Path:
    version = "0.0.1"
    wheel_path = dist_dir / f"{distribution}-{version}-py3-none-any.whl"
    dist_info = f"{distribution}-{version}.dist-info"
    files = {
        f"{distribution}/__init__.py": b'VALUE = "ok"\n',
        f"{dist_info}/WHEEL": b"Wheel-Version: 1.0\nGenerator: tests\nRoot-Is-Purelib: true\nTag: py3-none-any\n",
        f"{dist_info}/METADATA": (
            "Metadata-Version: 2.1\n"
            f"Name: {distribution}\n"
            f"Version: {version}\n"
            "Summary: Dummy package\n"
        ).encode("utf-8"),
    }
    record_lines: list[str] = []
    for rel_path, payload in files.items():
        digest = hashlib.sha256(payload).digest()
        encoded = base64.urlsafe_b64encode(digest).rstrip(b"=").decode("ascii")
        record_lines.append(f"{rel_path},sha256={encoded},{len(payload)}")
    record_lines.append(f"{dist_info}/RECORD,,")
    files[f"{dist_info}/RECORD"] = ("\n".join(record_lines) + "\n").encode("utf-8")
    with zipfile.ZipFile(wheel_path, "w") as archive:
        for rel_path, payload in files.items():
            archive.writestr(rel_path, payload)
    return wheel_path


def _make_market(tmp_path: pathlib.Path, package_id: str, runtime_packages: list[str] | None) -> tuple[pathlib.Path, pathlib.Path]:
    market_root = tmp_path / "market"
    source_root = tmp_path / "source"
    package_dir = market_root / "packages"
    package_dir.mkdir(parents=True)
    skill_dir = source_root / "skills" / package_id
    skill_dir.mkdir(parents=True)
    (skill_dir / "SKILL.md").write_text(
        "---\nname: sample\n---\n\n# Sample Skill\n\nUse me.\n",
        encoding="utf-8",
    )
    (skill_dir / "run.py").write_text("print('hello')\n", encoding="utf-8")
    package = {
        "package_id": package_id,
        "package_type": "skill-pack",
        "repo": "autoresearch-lab/skills-market",
        "channel": "dev",
        "version": "0.1.0",
        "summary": "Sample skill",
        "platforms": ["codex"],
        "source_path": f"skills/{package_id}/SKILL.md",
        "source": {
            "repo": "autoresearch-lab/skills",
            "ref": "main",
            "subpath": f"skills/{package_id}",
            "include": ["SKILL.md", "run.py"],
            "exclude": [],
        },
    }
    if runtime_packages is not None:
        package["runtime"] = {"python": {"mode": "isolated-venv", "packages": runtime_packages}}
    (package_dir / f"{package_id}.json").write_text(json.dumps(package, indent=2) + "\n", encoding="utf-8")
    (package_dir / "index.json").write_text(
        json.dumps({"index_version": "1.0.0", "updated_at": "2026-03-24T00:00:00Z", "packages": [f"{package_id}.json"]}, indent=2)
        + "\n",
        encoding="utf-8",
    )
    return market_root, source_root


def test_default_market_root_points_to_skills_market_root() -> None:
    script_file = ROOT / "scripts" / "install_skill_runtime" / "cli.py"
    assert default_market_root(script_file) == ROOT


def test_install_skill_dry_run_reports_isolated_runtime(capsys, tmp_path: pathlib.Path) -> None:
    wheel_path = _write_dummy_wheel(tmp_path, "market_dummy_dryrun")
    market_root, source_root = _make_market(tmp_path, "dryrun-skill", [str(wheel_path)])
    rc = install_main(
        ["--platform", "codex", "--market-root", str(market_root), "--source-root", str(source_root), "--target-root", str(tmp_path / "target"), "--package", "dryrun-skill", "--dry-run"]
    )
    assert rc == 0
    assert "isolated Python runtime (1 package(s))" in capsys.readouterr().out


def test_real_install_uses_skill_local_venv_and_writes_runtime_record(tmp_path: pathlib.Path) -> None:
    distribution = "market_dummy_local_only"
    wheel_path = _write_dummy_wheel(tmp_path, distribution)
    market_root, source_root = _make_market(tmp_path, "runtime-skill", [str(wheel_path)])
    target_root = tmp_path / "target"
    assert install_main(["--platform", "codex", "--market-root", str(market_root), "--source-root", str(source_root), "--target-root", str(target_root), "--package", "runtime-skill"]) == 0
    install_dir = target_root / "runtime-skill"
    expected_venv_python = python_bin_relative_path().as_posix()
    venv_python = _installed_venv_python(install_dir)
    assert venv_python.is_file()
    local_import = subprocess.run([str(venv_python), "-c", f"import {distribution}; print({distribution}.VALUE)"], text=True, capture_output=True, check=True)
    assert local_import.stdout.strip() == "ok"
    global_import = subprocess.run([sys.executable, "-c", f"import {distribution}"], text=True, capture_output=True)
    assert global_import.returncode != 0
    skill_text = (install_dir / "SKILL.md").read_text(encoding="utf-8")
    assert skill_text.startswith("---\nname: sample\n---\n\n")
    assert NOTE_START in skill_text
    inject_python_runtime_note(install_dir / "SKILL.md", expected_venv_python)
    assert (install_dir / "SKILL.md").read_text(encoding="utf-8").count(NOTE_START) == 1
    install_record = json.loads((install_dir / ".market_install.json").read_text(encoding="utf-8"))
    assert install_record["install_mode"] == "default"
    assert install_record["python_runtime"]["mode"] == "isolated-venv"
    assert install_record["python_runtime"]["venv_python"] == expected_venv_python


def test_force_reinstall_replaces_existing_install_and_cleanup_is_fail_closed(tmp_path: pathlib.Path) -> None:
    wheel_path = _write_dummy_wheel(tmp_path, "market_dummy_force")
    market_root, source_root = _make_market(tmp_path, "force-skill", [str(wheel_path)])
    target_root = tmp_path / "target"
    assert install_main(["--platform", "codex", "--market-root", str(market_root), "--source-root", str(source_root), "--target-root", str(target_root), "--package", "force-skill"]) == 0
    install_dir = target_root / "force-skill"
    (install_dir / "stale.txt").write_text("old\n", encoding="utf-8")
    assert install_main(["--platform", "codex", "--market-root", str(market_root), "--source-root", str(source_root), "--target-root", str(target_root), "--package", "force-skill", "--force"]) == 0
    assert not (install_dir / "stale.txt").exists()

    failing_market, failing_source = _make_market(tmp_path / "fail", "broken-skill", [str(tmp_path / "missing.whl")])
    fail_target = tmp_path / "fail-target"
    assert install_main(["--platform", "codex", "--market-root", str(failing_market), "--source-root", str(failing_source), "--target-root", str(fail_target), "--package", "broken-skill"]) == 1
    assert not (fail_target / "broken-skill").exists()


def test_non_opt_in_skill_remains_copy_only(tmp_path: pathlib.Path) -> None:
    market_root, source_root = _make_market(tmp_path, "copy-only-skill", None)
    target_root = tmp_path / "target"
    assert install_main(["--platform", "codex", "--market-root", str(market_root), "--source-root", str(source_root), "--target-root", str(target_root), "--package", "copy-only-skill"]) == 0
    install_dir = target_root / "copy-only-skill"
    assert install_dir.is_dir()
    assert not install_dir.is_symlink()
    assert not (install_dir / ".venv").exists()
    installed_skill = install_dir / "SKILL.md"
    source_skill = source_root / "skills" / "copy-only-skill" / "SKILL.md"
    original_text = installed_skill.read_text(encoding="utf-8")
    assert NOTE_START not in original_text

    source_skill.write_text("---\nname: sample\n---\n\n# Changed Source Skill\n", encoding="utf-8")
    assert installed_skill.read_text(encoding="utf-8") == original_text


def test_research_team_workflow_plan_copy_uses_source_workspace_provenance(monkeypatch, tmp_path: pathlib.Path) -> None:
    repo_root = ROOT.parents[1]
    target_root = tmp_path / "target"
    assert install_main(
        [
            "--platform",
            "codex",
            "--market-root",
            str(ROOT),
            "--source-root",
            str(repo_root),
            "--target-root",
            str(target_root),
            "--package",
            "research-team",
        ]
    ) == 0

    module_path = target_root / "research-team" / "scripts" / "lib" / "literature_workflow_plan.py"
    spec = importlib.util.spec_from_file_location("installed_literature_workflow_plan", module_path)
    assert spec is not None
    assert spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    assert isinstance(module, ModuleType)
    spec.loader.exec_module(module)

    captured: dict[str, object] = {}

    def fake_run(command, *, cwd, input, capture_output, text, check):
        captured["command"] = command
        captured["cwd"] = cwd
        captured["input"] = input
        captured["capture_output"] = capture_output
        captured["text"] = text
        captured["check"] = check
        return SimpleNamespace(returncode=0, stdout='{"entry_tool":"literature_workflows.resolve"}\n', stderr="")

    monkeypatch.setattr(module.subprocess, "run", fake_run)
    payload = module.resolve_workflow_plan(
        recipe_id="literature_landscape",
        phase="prework",
        inputs={"query": "test", "topic": "test"},
    )

    assert payload["entry_tool"] == "literature_workflows.resolve"
    assert captured["cwd"] == str(repo_root)
    assert captured["command"][:3] == ["pnpm", "--dir", str(repo_root)]
    assert (target_root / "research-team" / "assets" / "research_team_config_template.json").is_file()
    assert (target_root / "research-team" / "assets" / "knowledge_base_readme_template.md").is_file()


def test_research_team_package_payload_includes_template_assets() -> None:
    repo_root = ROOT.parents[1]
    package = load_json(ROOT / "packages" / "research-team.json")
    source = package["source"]
    assert source["subpath"] == "skills/research-team"

    files = collect_payload_files(
        repo_root / str(source["subpath"]),
        [str(item) for item in source["include"]],
        [str(item) for item in source.get("exclude", [])],
    )
    relative_files = {path.relative_to(repo_root / str(source["subpath"])).as_posix() for path in files}

    assert "assets/research_team_config_template.json" in relative_files
    assert "assets/knowledge_base_readme_template.md" in relative_files
