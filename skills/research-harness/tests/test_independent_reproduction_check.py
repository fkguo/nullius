"""Tests for the opt-in independent reproduction check (fresh-checkout rerun)."""
from __future__ import annotations

import importlib.util
import json
import os
import subprocess
import sys
from pathlib import Path

_MOD = Path(__file__).resolve().parent.parent / "scripts" / "independent_reproduction_check.py"
_spec = importlib.util.spec_from_file_location("independent_reproduction_check", _MOD)
irc = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(irc)


# --- fixtures: a tiny fake project whose reproduction entry emits one JSON
#     artifact and two stdout lines (all values domain-neutral) ---

REPRO_SCRIPT = """\
import json, pathlib
value = 1.234
pathlib.Path("out").mkdir(exist_ok=True)
pathlib.Path("out/result.json").write_text(
    json.dumps({"fit": {"quality": value}, "eigenvalues": [-2.5, 1.0]}), encoding="utf-8")
print("intermediate quality = 999.0")
print(f"final quality = {value}")
"""

DRIFTED_SCRIPT = REPRO_SCRIPT.replace("1.234", "5.678")


def _manifest_doc(**overrides) -> dict:
    doc = {
        "manifest_version": 1,
        "entry_command": f"{sys.executable} reproduce.py",
        "working_inputs": ["reproduce.py"],
        "timeout_seconds": 60,
        "environment_note": "test interpreter; no network",
        "expected": [
            {"id": "fit_quality", "artifact_path": "out/result.json", "json_path": "fit.quality",
             "value": 1.234, "tolerance": {"kind": "absolute", "value": 1e-9}},
            {"id": "lowest_eigenvalue", "artifact_path": "out/result.json",
             "json_path": "eigenvalues.0",
             "value": -2.5, "tolerance": {"kind": "relative", "value": 1e-9}},
            {"id": "stdout_quality", "stdout_pattern": r"final quality = ([-+0-9.eE]+)",
             "value": 1.234, "tolerance": {"kind": "absolute", "value": 1e-9},
             "unit_note": "dimensionless"},
        ],
    }
    doc.update(overrides)
    return doc


def _git_env() -> dict:
    env = dict(os.environ)
    env["GIT_CONFIG_GLOBAL"] = os.devnull
    env["GIT_CONFIG_SYSTEM"] = os.devnull
    env["GIT_AUTHOR_NAME"] = env["GIT_COMMITTER_NAME"] = "test"
    env["GIT_AUTHOR_EMAIL"] = env["GIT_COMMITTER_EMAIL"] = "test@example.invalid"
    return env


def _run_git(args: list, cwd: Path) -> None:
    subprocess.run(["git", *args], cwd=str(cwd), env=_git_env(), check=True, capture_output=True)


def _make_git_project(tmp_path: Path, manifest_doc: dict, script: str = REPRO_SCRIPT) -> Path:
    project = tmp_path / "proj"
    (project / "artifacts" / "runs" / "demo").mkdir(parents=True)
    (project / "reproduce.py").write_text(script, encoding="utf-8")
    (project / "artifacts" / "runs" / "demo" / "reproduction_manifest.json").write_text(
        json.dumps(manifest_doc, indent=2), encoding="utf-8")
    _run_git(["init", "-q"], project)
    _run_git(["add", "-A"], project)
    _run_git(["commit", "-q", "-m", "seed"], project)
    return project


def _run_check(tmp_path: Path, project: Path, extra_args: "list | None" = None) -> "tuple[int, dict]":
    work = tmp_path / "work"
    manifest = project / "artifacts" / "runs" / "demo" / "reproduction_manifest.json"
    argv = ["--manifest", str(manifest), "--work-dir", str(work)] + (extra_args or [])
    code = irc.main(argv)
    report = json.loads((work / "report.json").read_text(encoding="utf-8"))
    return code, report


# --- pure verdict logic ---

def test_decide_verdict_precedence_and_default_deny():
    assert irc.decide_verdict(True, True, ["within_tolerance"]) == "environment_failed"
    assert irc.decide_verdict(False, False, ["within_tolerance"]) == "incomplete"
    assert irc.decide_verdict(False, True, ["within_tolerance", "not_extracted"]) == "incomplete"
    assert irc.decide_verdict(False, True, []) == "incomplete"  # nothing verified => not reproduced
    assert irc.decide_verdict(False, True, ["within_tolerance", "out_of_tolerance"]) == "mismatch"
    assert irc.decide_verdict(False, True, ["within_tolerance", "within_tolerance"]) == "reproduced"
    for verdict in (irc.decide_verdict(b, e, s) for b in (True, False) for e in (True, False)
                    for s in ([], ["within_tolerance"], ["not_extracted"], ["out_of_tolerance"])):
        assert verdict in irc.VERDICTS


def test_exit_code_zero_only_for_reproduced():
    assert irc.EXIT_CODES["reproduced"] == 0
    assert all(code != 0 for verdict, code in irc.EXIT_CODES.items() if verdict != "reproduced")


# --- comparison math ---

def test_compare_value_absolute_and_relative():
    r = irc.compare_value(1.0, 1.05, "absolute", 0.1)
    assert abs(r["deviation"] - 0.05) < 1e-12 and r["within"] and r["deviation_over_tolerance"] <= 1
    r = irc.compare_value(1.0, 1.2, "absolute", 0.1)
    assert not r["within"] and r["deviation_over_tolerance"] > 1
    r = irc.compare_value(-2.0, -2.0004, "relative", 1e-3)  # |dev|/(tol*|declared|) = 0.2
    assert r["within"] and abs(r["deviation_over_tolerance"] - 0.2) < 1e-9
    r = irc.compare_value(-2.0, -2.004, "relative", 1e-3)
    assert not r["within"]
    # exactly at the boundary counts as within (ratio == 1; binary-exact values)
    r = irc.compare_value(1.0, 1.25, "absolute", 0.25)
    assert r["within"] and r["deviation_over_tolerance"] == 1.0


def test_walk_json_path_keys_lists_and_errors():
    doc = {"fit": {"quality": 1.5}, "eigenvalues": [-2.5, 1.0]}
    assert irc.walk_json_path(doc, "fit.quality") == (1.5, None)
    assert irc.walk_json_path(doc, "eigenvalues.1") == (1.0, None)
    assert irc.walk_json_path(doc, "fit.missing")[1] is not None
    assert irc.walk_json_path(doc, "eigenvalues.7")[1] is not None
    assert irc.walk_json_path(doc, "eigenvalues.x")[1] is not None
    assert irc.walk_json_path(doc, "fit.quality.deeper")[1] is not None


# --- manifest validation (fail-closed error paths) ---

def test_validate_manifest_accepts_the_reference_shape():
    assert irc.validate_manifest(_manifest_doc()) == []


def test_validate_manifest_rejects_missing_tolerance():
    doc = _manifest_doc()
    del doc["expected"][0]["tolerance"]
    assert any("tolerance" in e for e in irc.validate_manifest(doc))


def test_validate_manifest_rejects_relative_tolerance_on_zero_value():
    doc = _manifest_doc()
    doc["expected"][0]["value"] = 0
    doc["expected"][0]["tolerance"] = {"kind": "relative", "value": 1e-3}
    assert any("relative tolerance is undefined" in e for e in irc.validate_manifest(doc))


def test_validate_manifest_rejects_ambiguous_or_missing_extraction():
    doc = _manifest_doc()
    doc["expected"][0]["stdout_pattern"] = "x = (\\d+)"  # both mechanisms declared
    assert any("exactly one extraction mechanism" in e for e in irc.validate_manifest(doc))
    doc = _manifest_doc()
    del doc["expected"][0]["artifact_path"], doc["expected"][0]["json_path"]  # neither
    assert any("exactly one extraction mechanism" in e for e in irc.validate_manifest(doc))


def test_validate_manifest_rejects_structural_defects():
    assert irc.validate_manifest([]) == ["manifest root must be a JSON object"]
    doc = _manifest_doc(expected=[])
    assert any("non-empty list" in e for e in irc.validate_manifest(doc))
    doc = _manifest_doc(timeout_seconds=0)
    assert any("timeout_seconds" in e for e in irc.validate_manifest(doc))
    doc = _manifest_doc(environment_note="  ")
    assert any("environment_note" in e for e in irc.validate_manifest(doc))
    doc = _manifest_doc(working_inputs=["../escape"])
    assert any("working_inputs" in e for e in irc.validate_manifest(doc))
    doc = _manifest_doc()
    doc["expected"][1]["id"] = doc["expected"][0]["id"]
    assert any("duplicates" in e for e in irc.validate_manifest(doc))
    doc = _manifest_doc()
    doc["expected"][0]["artifact_path"] = "/absolute/out.json"
    assert any("artifact_path" in e for e in irc.validate_manifest(doc))
    doc = _manifest_doc()
    doc["expected"][2]["stdout_pattern"] = "no capture group"
    assert any("capture group" in e for e in irc.validate_manifest(doc))
    doc = _manifest_doc()
    doc["expected"][0]["value"] = "1.234"  # string, not a number
    assert any("finite number" in e for e in irc.validate_manifest(doc))


# --- end-to-end: git worktree isolation ---

def test_worktree_reproduced(tmp_path):
    project = _make_git_project(tmp_path, _manifest_doc())
    code, report = _run_check(tmp_path, project)
    assert report["verdict"] == "reproduced", report
    assert code == 0
    assert report["isolation"]["mode"] == "worktree"
    assert all(item["status"] in irc.ITEM_STATUSES for item in report["expected"])
    assert all(item["status"] == "within_tolerance" for item in report["expected"])
    assert all(item["deviation_over_tolerance"] <= 1 for item in report["expected"])
    assert report["manifest"]["git_state"] == "tracked_clean"
    assert (tmp_path / "work" / "report.md").exists()
    assert report["isolation"]["kept"] is True  # ground truth: checkout still on disk
    assert Path(report["isolation"]["checkout"]).exists()  # kept for inspection


def test_worktree_mismatch_on_drifted_declared_value(tmp_path):
    doc = _manifest_doc()
    doc["expected"][0]["value"] = 9.99  # declared expectation the rerun cannot meet
    project = _make_git_project(tmp_path, doc)
    code, report = _run_check(tmp_path, project)
    assert report["verdict"] == "mismatch"
    assert code == 3
    drifted = [i for i in report["expected"] if i["id"] == "fit_quality"][0]
    assert drifted["status"] == "out_of_tolerance"
    assert drifted["deviation_over_tolerance"] > 1
    assert [i for i in report["expected"] if i["id"] == "stdout_quality"][0]["status"] == "within_tolerance"


def test_uncommitted_drift_is_invisible_to_the_fresh_checkout(tmp_path):
    """The core isolation semantic: the rerun sees committed state only."""
    project = _make_git_project(tmp_path, _manifest_doc())
    (project / "reproduce.py").write_text(DRIFTED_SCRIPT, encoding="utf-8")  # NOT committed
    code, report = _run_check(tmp_path, project)
    assert report["verdict"] == "reproduced", "uncommitted drift must not reach the isolated rerun"
    assert code == 0
    assert report["isolation"]["original_tree_dirty"] is True
    # and the original tree keeps its uncommitted edit, untouched
    assert (project / "reproduce.py").read_text(encoding="utf-8") == DRIFTED_SCRIPT


def test_original_tree_is_never_modified(tmp_path):
    project = _make_git_project(tmp_path, _manifest_doc())
    before_files = sorted(str(p.relative_to(project)) for p in project.rglob("*") if ".git" not in p.parts)
    _run_check(tmp_path, project)
    after_files = sorted(str(p.relative_to(project)) for p in project.rglob("*") if ".git" not in p.parts)
    assert before_files == after_files
    status = subprocess.run(["git", "status", "--porcelain"], cwd=str(project), env=_git_env(),
                            capture_output=True, text=True, check=True)
    assert status.stdout.strip() == ""


def test_entry_nonzero_exit_is_incomplete_even_with_stale_artifacts(tmp_path):
    # the entry produces every artifact, then fails: a failing entry is not a reproduction
    script = REPRO_SCRIPT + "raise SystemExit(7)\n"
    project = _make_git_project(tmp_path, _manifest_doc(), script=script)
    code, report = _run_check(tmp_path, project)
    assert report["verdict"] == "incomplete"
    assert code == 4
    assert report["entry"]["exit_code"] == 7
    # diagnosis is still recorded per expected value
    assert all(i["status"] == "within_tolerance" for i in report["expected"])


def test_missing_artifact_is_incomplete(tmp_path):
    project = _make_git_project(tmp_path, _manifest_doc(entry_command="true"))
    code, report = _run_check(tmp_path, project)
    assert report["verdict"] == "incomplete"
    assert code == 4
    assert all(i["status"] == "not_extracted" for i in report["expected"])
    assert all("extraction_error" in i for i in report["expected"])


def test_timeout_is_incomplete_and_kills_the_entry(tmp_path):
    project = _make_git_project(tmp_path, _manifest_doc(entry_command="sleep 30", timeout_seconds=1))
    code, report = _run_check(tmp_path, project)
    assert report["verdict"] == "incomplete"
    assert code == 4
    assert report["entry"]["timed_out"] is True
    assert report["entry"]["exit_code"] is None
    assert report["entry"]["duration_seconds"] < 10


def test_manifest_validation_failure_is_environment_failed(tmp_path):
    doc = _manifest_doc()
    del doc["expected"][0]["tolerance"]
    project = _make_git_project(tmp_path, doc)
    code, report = _run_check(tmp_path, project)
    assert report["verdict"] == "environment_failed"
    assert code == 5
    assert any("tolerance" in e for e in report["errors"])
    assert report["expected"] == []  # nothing was compared


def test_repository_without_commits_is_environment_failed(tmp_path):
    project = tmp_path / "proj"
    (project / "artifacts" / "runs" / "demo").mkdir(parents=True)
    (project / "reproduce.py").write_text(REPRO_SCRIPT, encoding="utf-8")
    manifest = project / "artifacts" / "runs" / "demo" / "reproduction_manifest.json"
    manifest.write_text(json.dumps(_manifest_doc()), encoding="utf-8")
    _run_git(["init", "-q"], project)  # no commit
    code, report = _run_check(tmp_path, project)
    assert report["verdict"] == "environment_failed"
    assert code == 5
    assert any("no resolvable HEAD" in e for e in report["errors"])


def test_work_dir_inside_project_is_refused(tmp_path, capsys):
    project = _make_git_project(tmp_path, _manifest_doc())
    manifest = project / "artifacts" / "runs" / "demo" / "reproduction_manifest.json"
    code = irc.main(["--manifest", str(manifest), "--work-dir", str(project / "inside")])
    assert code == 5
    report = json.loads(capsys.readouterr().out)
    assert report["verdict"] == "environment_failed"
    assert any("outside the project" in e for e in report["errors"])
    assert not (project / "inside").exists()  # refused before creating anything


def test_cleanup_removes_checkout_keeps_reports(tmp_path):
    project = _make_git_project(tmp_path, _manifest_doc())
    code, report = _run_check(tmp_path, project, extra_args=["--cleanup"])
    assert code == 0
    assert report["isolation"]["cleanup_done"] is True
    assert report["isolation"]["kept"] is False  # ground truth after removal
    assert not Path(report["isolation"]["checkout"]).exists()
    assert (tmp_path / "work" / "report.json").exists()
    assert (tmp_path / "work" / "entry_stdout.log").exists()


# --- the claim under test must itself be committed (worktree mode) ---

def test_uncommitted_manifest_edit_is_environment_failed(tmp_path):
    project = _make_git_project(tmp_path, _manifest_doc())
    manifest = project / "artifacts" / "runs" / "demo" / "reproduction_manifest.json"
    doc = _manifest_doc()
    doc["expected"][0]["tolerance"]["value"] = 1e9  # loosen tolerance WITHOUT committing
    manifest.write_text(json.dumps(doc, indent=2), encoding="utf-8")
    code, report = _run_check(tmp_path, project)
    assert report["verdict"] == "environment_failed"
    assert code == 5
    assert any("committed" in e for e in report["errors"])
    assert report["manifest"]["git_state"] == "tracked_modified"


def test_untracked_manifest_is_environment_failed_in_worktree_mode(tmp_path):
    project = _make_git_project(tmp_path, _manifest_doc())
    loose = project / "artifacts" / "runs" / "demo" / "loose_manifest.json"
    loose.write_text(json.dumps(_manifest_doc()), encoding="utf-8")  # never committed
    work = tmp_path / "work"
    code = irc.main(["--manifest", str(loose), "--work-dir", str(work)])
    report = json.loads((work / "report.json").read_text(encoding="utf-8"))
    assert report["verdict"] == "environment_failed"
    assert code == 5
    assert any("tracked in git" in e for e in report["errors"])


# --- vacuous-pass guard: pre-existing artifacts and symlinks ---

def test_preexisting_committed_artifact_cannot_pass_vacuously(tmp_path):
    """A committed stale output + a no-op entry must NOT read as reproduced."""
    doc = _manifest_doc(entry_command="true")
    project = tmp_path / "proj"
    (project / "artifacts" / "runs" / "demo").mkdir(parents=True)
    (project / "out").mkdir()
    (project / "reproduce.py").write_text(REPRO_SCRIPT, encoding="utf-8")
    (project / "out" / "result.json").write_text(  # stale output, committed
        json.dumps({"fit": {"quality": 1.234}, "eigenvalues": [-2.5, 1.0]}), encoding="utf-8")
    (project / "artifacts" / "runs" / "demo" / "reproduction_manifest.json").write_text(
        json.dumps(doc, indent=2), encoding="utf-8")
    _run_git(["init", "-q"], project)
    _run_git(["add", "-A"], project)
    _run_git(["commit", "-q", "-m", "seed with stale committed artifact"], project)
    code, report = _run_check(tmp_path, project)
    assert report["verdict"] == "incomplete", report
    assert code == 4
    assert report["isolation"]["preexisting_artifacts_removed"] == ["out/result.json"]
    artifact_items = [i for i in report["expected"] if i["mechanism"] == "json_artifact"]
    assert all(i["status"] == "not_extracted" for i in artifact_items)


def test_artifact_symlink_is_refused(tmp_path):
    entry = ("mkdir -p out && printf '{\"fit\": {\"quality\": 1.234}}' > real.json && "
             "ln -s ../real.json out/result.json && echo 'final quality = 1.234'")
    doc = _manifest_doc(entry_command=entry)
    doc["expected"] = [doc["expected"][0], doc["expected"][2]]  # one artifact + one stdout item
    project = _make_git_project(tmp_path, doc)
    code, report = _run_check(tmp_path, project)
    assert report["verdict"] == "incomplete"
    assert code == 4
    artifact_item = [i for i in report["expected"] if i["id"] == "fit_quality"][0]
    assert artifact_item["status"] == "not_extracted"
    assert "symlink" in artifact_item["extraction_error"]
    assert [i for i in report["expected"] if i["id"] == "stdout_quality"][0]["status"] == "within_tolerance"


def test_copy_mode_rejects_symlinked_working_inputs(tmp_path):
    doc = _manifest_doc(working_inputs=["reproduce.py", "linked.py"])
    project = _make_plain_project(tmp_path, doc)
    (project / "linked.py").symlink_to(project / "reproduce.py")
    code, report = _run_check(tmp_path, project,
                              extra_args=["--project-root", str(project), "--isolation", "copy"])
    assert report["verdict"] == "environment_failed"
    assert code == 5
    assert any("symlink" in e for e in report["errors"])


# --- project nested below its repo toplevel ---

def test_project_as_subdirectory_of_repo(tmp_path):
    repo = tmp_path / "repo"
    project = repo / "sub"
    (project / "artifacts" / "runs" / "demo").mkdir(parents=True)
    (project / "reproduce.py").write_text(REPRO_SCRIPT, encoding="utf-8")
    (project / "artifacts" / "runs" / "demo" / "reproduction_manifest.json").write_text(
        json.dumps(_manifest_doc(), indent=2), encoding="utf-8")
    _run_git(["init", "-q"], repo)
    _run_git(["add", "-A"], repo)
    _run_git(["commit", "-q", "-m", "seed"], repo)
    work = tmp_path / "work"
    manifest = project / "artifacts" / "runs" / "demo" / "reproduction_manifest.json"
    code = irc.main(["--manifest", str(manifest), "--work-dir", str(work),
                     "--project-root", str(project)])
    report = json.loads((work / "report.json").read_text(encoding="utf-8"))
    assert report["verdict"] == "reproduced", report
    assert code == 0
    assert report["isolation"]["run_root"].endswith("sub")


# --- stdout extraction determinism ---

def test_stdout_last_match_wins(tmp_path):
    doc = _manifest_doc()
    doc["expected"] = [{"id": "quality_any", "stdout_pattern": r"quality = ([-+0-9.eE]+)",
                        "value": 1.234, "tolerance": {"kind": "absolute", "value": 1e-9}}]
    # the fixture prints "intermediate quality = 999.0" BEFORE "final quality = 1.234";
    # only last-match semantics makes this pass
    project = _make_git_project(tmp_path, doc)
    code, report = _run_check(tmp_path, project)
    assert report["verdict"] == "reproduced", report
    assert report["expected"][0]["computed_value"] == 1.234


def test_stdout_pattern_without_match_is_incomplete(tmp_path):
    doc = _manifest_doc()
    doc["expected"][2]["stdout_pattern"] = r"never printed anywhere = ([-+0-9.eE]+)"
    project = _make_git_project(tmp_path, doc)
    code, report = _run_check(tmp_path, project)
    assert report["verdict"] == "incomplete"
    assert code == 4
    missing = [i for i in report["expected"] if i["id"] == "stdout_quality"][0]
    assert missing["status"] == "not_extracted"


# --- copy-mode cleanup ---

def test_copy_cleanup_removes_checkout_keeps_reports(tmp_path):
    project = _make_plain_project(tmp_path, _manifest_doc())
    code, report = _run_check(tmp_path, project,
                              extra_args=["--project-root", str(project), "--isolation", "copy",
                                          "--cleanup"])
    assert code == 0
    assert report["isolation"]["cleanup_done"] is True
    assert report["isolation"]["kept"] is False
    assert not Path(report["isolation"]["checkout"]).exists()
    assert (tmp_path / "work" / "report.json").exists()


# --- CLI override and helper hardening ---

def test_cli_timeout_override_must_be_finite(tmp_path, capsys):
    project = _make_git_project(tmp_path, _manifest_doc())
    manifest = project / "artifacts" / "runs" / "demo" / "reproduction_manifest.json"
    code = irc.main(["--manifest", str(manifest), "--timeout-seconds", "inf"])
    assert code == 5
    report = json.loads(capsys.readouterr().out)
    assert report["verdict"] == "environment_failed"
    assert any("finite" in e for e in report["errors"])


def test_validate_manifest_requires_explicit_version():
    doc = _manifest_doc()
    del doc["manifest_version"]
    assert any("manifest_version" in e for e in irc.validate_manifest(doc))
    doc = _manifest_doc(manifest_version=2)
    assert any("manifest_version" in e for e in irc.validate_manifest(doc))


def test_validate_manifest_rejects_dot_and_huge_values():
    doc = _manifest_doc(working_inputs=["."])
    assert any("working_inputs" in e for e in irc.validate_manifest(doc))
    doc = _manifest_doc()
    doc["expected"][0]["value"] = 10 ** 400  # overflows float(); must reject, not crash
    assert any("finite number" in e for e in irc.validate_manifest(doc))


def test_compare_value_zero_denominator_fails_closed():
    r = irc.compare_value(0.0, 0.0, "relative", 1e-3)  # rejected upstream; helper must not raise
    assert r["within"] is False
    assert r["deviation_over_tolerance"] == float("inf")


def test_walk_json_path_unicode_digit_segment_fails_cleanly():
    doc = {"values": [1.0, 2.0]}
    value, err = irc.walk_json_path(doc, "values.²")  # superscript two: isdigit() is True
    assert value is None and err is not None


def test_extract_value_rejects_non_finite_artifact_value(tmp_path):
    (tmp_path / "artifact.json").write_text('{"v": NaN}', encoding="utf-8")
    item = {"id": "x", "artifact_path": "artifact.json", "json_path": "v"}
    value, err = irc.extract_value(item, tmp_path, "")
    assert value is None and "finite" in err


def test_cli_mismatch_exit_code_via_subprocess(tmp_path):
    doc = _manifest_doc()
    doc["expected"][0]["value"] = 9.99
    project = _make_git_project(tmp_path, doc)
    manifest = project / "artifacts" / "runs" / "demo" / "reproduction_manifest.json"
    proc = subprocess.run(
        [sys.executable, str(_MOD), "--manifest", str(manifest),
         "--work-dir", str(tmp_path / "cliwork")],
        capture_output=True, text=True, check=False)
    assert proc.returncode == 3, proc.stderr
    assert json.loads(proc.stdout)["verdict"] == "mismatch"


# --- work dir defaults must never land inside the project ---

def test_default_tmpdir_inside_project_is_refused(tmp_path):
    project = _make_git_project(tmp_path, _manifest_doc())
    inside_tmp = project / "tmpspace"
    inside_tmp.mkdir()
    env = dict(os.environ)
    env["TMPDIR"] = str(inside_tmp)
    manifest = project / "artifacts" / "runs" / "demo" / "reproduction_manifest.json"
    proc = subprocess.run(
        [sys.executable, str(_MOD), "--manifest", str(manifest)],  # no --work-dir: default path
        capture_output=True, text=True, check=False, env=env)
    assert proc.returncode == 5, proc.stdout + proc.stderr
    report = json.loads(proc.stdout)
    assert report["verdict"] == "environment_failed"
    assert any("temp directory" in e for e in report["errors"])
    assert list(inside_tmp.iterdir()) == []  # nothing was created inside the project


# --- environment scrub: the rerun must not import the original tree ---

def test_sanitize_child_env_drops_only_references_to_forbidden_roots(tmp_path):
    proj = tmp_path / "proj"
    proj.mkdir()
    sibling = str(proj) + "2"  # shares the prefix; must NOT be treated as a reference
    environ = {
        "PYTHONPATH": f"{proj}{os.pathsep}/usr/lib/pythonX",
        "VIRTUAL_ENV": str(proj / ".venv"),
        "SAFE": "unrelated-value",
        "NEAR_MISS": sibling,
    }
    child_env, dropped = irc.sanitize_child_env(environ, [proj])
    assert child_env["PYTHONPATH"] == "/usr/lib/pythonX"
    assert "VIRTUAL_ENV" not in child_env
    assert child_env["SAFE"] == "unrelated-value"
    assert child_env["NEAR_MISS"] == sibling
    assert dropped == {"PYTHONPATH": [str(proj)], "VIRTUAL_ENV": [str(proj / ".venv")]}


def test_env_referencing_original_tree_is_dropped_for_the_entry(tmp_path, monkeypatch):
    entry = f'echo "PP=[$PYTHONPATH]" && {sys.executable} reproduce.py'
    project = _make_git_project(tmp_path, _manifest_doc(entry_command=entry))
    monkeypatch.setenv("PYTHONPATH", str(project))
    code, report = _run_check(tmp_path, project)
    assert code == 0, report
    assert report["entry"]["environment_entries_dropped"] == {"PYTHONPATH": [str(project)]}
    stdout_log = Path(report["entry"]["stdout_log"]).read_text(encoding="utf-8")
    assert "PP=[]" in stdout_log  # the original-tree path never reached the child
    assert str(project) not in stdout_log


# --- optional capture group must fail cleanly, never crash the report ---

def test_optional_capture_group_not_participating_is_not_extracted():
    item = {"id": "x", "stdout_pattern": r"result = ([-+0-9.eE]+)?"}
    value, err = irc.extract_value(item, Path("."), "result = \n")
    assert value is None
    assert "did not participate" in err


# --- committed symlinks must not smuggle state from outside the checkout ---

def test_committed_symlink_escaping_the_checkout_is_refused(tmp_path):
    outside = tmp_path / "outside_data.json"
    outside.write_text("{}", encoding="utf-8")
    project = tmp_path / "proj"
    (project / "artifacts" / "runs" / "demo").mkdir(parents=True)
    (project / "reproduce.py").write_text(REPRO_SCRIPT, encoding="utf-8")
    (project / "artifacts" / "runs" / "demo" / "reproduction_manifest.json").write_text(
        json.dumps(_manifest_doc(), indent=2), encoding="utf-8")
    (project / "data_link.json").symlink_to(outside)  # escapes the project; will be committed
    _run_git(["init", "-q"], project)
    _run_git(["add", "-A"], project)
    _run_git(["commit", "-q", "-m", "seed with escaping symlink"], project)
    code, report = _run_check(tmp_path, project)
    assert report["verdict"] == "environment_failed", report
    assert code == 5
    assert any("symlinks resolve outside the fresh checkout" in e for e in report["errors"])


def test_committed_internal_relative_symlink_is_allowed(tmp_path):
    project = tmp_path / "proj"
    (project / "artifacts" / "runs" / "demo").mkdir(parents=True)
    (project / "reproduce.py").write_text(REPRO_SCRIPT, encoding="utf-8")
    (project / "artifacts" / "runs" / "demo" / "reproduction_manifest.json").write_text(
        json.dumps(_manifest_doc(), indent=2), encoding="utf-8")
    (project / "alias.py").symlink_to("reproduce.py")  # relative, stays inside the checkout
    _run_git(["init", "-q"], project)
    _run_git(["add", "-A"], project)
    _run_git(["commit", "-q", "-m", "seed with internal symlink"], project)
    code, report = _run_check(tmp_path, project)
    assert report["verdict"] == "reproduced", report
    assert code == 0


# --- env scrub must catch symlink aliases and spare relative components ---

def test_sanitize_child_env_catches_symlink_alias_of_project_root(tmp_path):
    proj = tmp_path / "proj"
    proj.mkdir()
    alias = tmp_path / "alias-link"
    alias.symlink_to(proj)
    environ = {
        "PYTHONPATH": f"{alias}{os.pathsep}/usr/lib/pythonX",
        "TOOL_HOME": str(alias / "tools"),
    }
    child_env, dropped = irc.sanitize_child_env(environ, [proj])
    assert child_env["PYTHONPATH"] == "/usr/lib/pythonX"
    assert "TOOL_HOME" not in child_env
    assert dropped == {"PYTHONPATH": [str(alias)], "TOOL_HOME": [str(alias / "tools")]}


def test_sanitize_child_env_keeps_relative_and_plain_values(tmp_path):
    proj = tmp_path / "proj"
    proj.mkdir()
    run_root = tmp_path / "work" / "checkout"
    run_root.mkdir(parents=True)
    environ = {"LESS": "-R", "REL_PATH": "./lib", "WORDS": "no path here"}
    child_env, dropped = irc.sanitize_child_env(environ, [proj], relative_base=run_root)
    assert child_env == environ
    assert dropped == {}


def test_sanitize_child_env_drops_relative_traversal_into_original_tree(tmp_path):
    """A relative component that escapes the run root back into the original
    tree (e.g. ../../proj from a sibling work dir) must be dropped."""
    proj = tmp_path / "proj"
    proj.mkdir()
    run_root = tmp_path / "work" / "checkout"
    run_root.mkdir(parents=True)
    environ = {"PYTHONPATH": f"../../proj{os.pathsep}vendor/lib"}
    child_env, dropped = irc.sanitize_child_env(environ, [proj], relative_base=run_root)
    assert child_env["PYTHONPATH"] == "vendor/lib"  # innocent relative component kept
    assert dropped == {"PYTHONPATH": ["../../proj"]}


def test_try_resolve_never_raises_on_symlink_loop(tmp_path):
    """Symlink loops raise OSError or RuntimeError depending on the Python
    version; _try_resolve must swallow both so every guard fails closed
    instead of crashing (verdicts stay fail-closed either way: unresolvable
    links are treated as escaping, and a loop the entry reads breaks the
    entry, never the report)."""
    loop = tmp_path / "loop"
    loop.symlink_to("loop")
    result = irc._try_resolve(loop)
    assert result is None or isinstance(result, Path)


def test_copy_mode_rejects_symlinked_ancestor_in_working_inputs(tmp_path):
    outside = tmp_path / "outside_dir"
    outside.mkdir()
    (outside / "data.py").write_text("x = 1\n", encoding="utf-8")
    doc = _manifest_doc(working_inputs=["reproduce.py", "linked_dir/data.py"])
    project = _make_plain_project(tmp_path, doc)
    (project / "linked_dir").symlink_to(outside)  # entry path passes THROUGH this link
    code, report = _run_check(tmp_path, project,
                              extra_args=["--project-root", str(project), "--isolation", "copy"])
    assert report["verdict"] == "environment_failed"
    assert code == 5
    assert any("passes through a symlink" in e for e in report["errors"])


# --- malformed manifest JSON must be a clean environment_failed ---

def test_malformed_manifest_json_is_environment_failed(tmp_path):
    project = _make_git_project(tmp_path, _manifest_doc())
    broken = project / "artifacts" / "runs" / "demo" / "broken.json"
    broken.write_text("{not json", encoding="utf-8")
    work = tmp_path / "work"
    code = irc.main(["--manifest", str(broken), "--work-dir", str(work)])
    report = json.loads((work / "report.json").read_text(encoding="utf-8"))
    assert report["verdict"] == "environment_failed"
    assert code == 5
    assert any("not valid JSON" in e for e in report["errors"])


# --- end-to-end: copy fallback for non-git projects ---

def _make_plain_project(tmp_path: Path, manifest_doc: dict) -> Path:
    project = tmp_path / "plainproj"
    (project / "artifacts" / "runs" / "demo").mkdir(parents=True)
    (project / "reproduce.py").write_text(REPRO_SCRIPT, encoding="utf-8")
    (project / "artifacts" / "runs" / "demo" / "reproduction_manifest.json").write_text(
        json.dumps(manifest_doc), encoding="utf-8")
    return project


def test_copy_mode_reproduced_for_non_git_project(tmp_path):
    project = _make_plain_project(tmp_path, _manifest_doc())
    code, report = _run_check(tmp_path, project,
                              extra_args=["--project-root", str(project), "--isolation", "copy"])
    assert report["verdict"] == "reproduced"
    assert code == 0
    assert report["isolation"]["mode"] == "copy"


def test_copy_mode_requires_working_inputs(tmp_path):
    doc = _manifest_doc()
    del doc["working_inputs"]
    project = _make_plain_project(tmp_path, doc)
    code, report = _run_check(tmp_path, project,
                              extra_args=["--project-root", str(project), "--isolation", "copy"])
    assert report["verdict"] == "environment_failed"
    assert code == 5
    assert any("working_inputs" in e for e in report["errors"])


def test_copy_mode_missing_input_is_environment_failed(tmp_path):
    doc = _manifest_doc(working_inputs=["reproduce.py", "data/absent.csv"])
    project = _make_plain_project(tmp_path, doc)
    code, report = _run_check(tmp_path, project,
                              extra_args=["--project-root", str(project), "--isolation", "copy"])
    assert report["verdict"] == "environment_failed"
    assert any("not found" in e for e in report["errors"])


# --- CLI end-to-end (subprocess): exit code + stdout JSON contract ---

def test_cli_reproduced_exit_zero_and_json_stdout(tmp_path):
    project = _make_git_project(tmp_path, _manifest_doc())
    manifest = project / "artifacts" / "runs" / "demo" / "reproduction_manifest.json"
    proc = subprocess.run(
        [sys.executable, str(_MOD), "--manifest", str(manifest),
         "--work-dir", str(tmp_path / "cliwork")],
        capture_output=True, text=True, check=False)
    assert proc.returncode == 0, proc.stderr
    report = json.loads(proc.stdout)
    assert report["verdict"] == "reproduced"
    assert report["report_json"] and Path(report["report_json"]).exists()
    assert report["limitations"]  # the environment-isolation limit is always restated
