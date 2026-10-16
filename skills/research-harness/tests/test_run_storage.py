"""Tests for run_storage.py (bulk run outputs kept out of git history)."""
from __future__ import annotations

import errno
import importlib.util
import hashlib
import json
import os
import re
import shlex
import shutil
import stat
import subprocess
import sys
import time
from pathlib import Path

import pytest

_MOD = Path(__file__).resolve().parent.parent / "scripts" / "run_storage.py"
_spec = importlib.util.spec_from_file_location("run_storage", _MOD)
rs = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(rs)

SKILL_MD = Path(__file__).resolve().parent.parent / "SKILL.md"
RUN_STORAGE_REFERENCE_MD = Path(__file__).resolve().parent.parent / "references" / "run-storage.md"
THRESHOLD = 4096
STOWED_FOR_LARGE_MANIFEST = 24  # enough manifest entries to exceed THRESHOLD bytes


@pytest.fixture(autouse=True)
def hermetic_git(monkeypatch, tmp_path):
    monkeypatch.setenv("GIT_CONFIG_GLOBAL", os.devnull)
    monkeypatch.setenv("GIT_CONFIG_SYSTEM", os.devnull)
    monkeypatch.setenv("GIT_AUTHOR_NAME", "test")
    monkeypatch.setenv("GIT_COMMITTER_NAME", "test")
    monkeypatch.setenv("GIT_AUTHOR_EMAIL", "test@example.invalid")
    monkeypatch.setenv("GIT_COMMITTER_EMAIL", "test@example.invalid")


def sh(*args, cwd, check=True):
    proc = subprocess.run(list(args), cwd=str(cwd), capture_output=True, text=True)
    if check and proc.returncode != 0:
        raise AssertionError(f"{args} failed: {proc.stdout}\n{proc.stderr}")
    return proc


def make_repo(tmp_path: Path, policy: "dict | None" = None) -> Path:
    repo = tmp_path / "project"
    repo.mkdir()
    sh("git", "init", "-q", "-b", "main", cwd=repo)
    (repo / "README.md").write_text("project\n")
    (repo / "artifacts" / "runs").mkdir(parents=True)
    (repo / "artifacts" / "runs" / ".keep").write_text("")
    doc = {"schema": rs.POLICY_SCHEMA, "bulk_threshold_bytes": THRESHOLD}
    if policy:
        doc.update(policy)
    (repo / ".nullius").mkdir()
    (repo / ".nullius" / "storage_policy.json").write_text(json.dumps(doc))
    sh("git", "add", "-A", cwd=repo)
    sh("git", "commit", "-q", "-m", "init", cwd=repo)
    return repo


def blob(n: int, seed: int = 0) -> bytes:
    pattern = bytes((i * 7 + seed) % 251 for i in range(251))
    return (pattern * (n // len(pattern) + 1))[:n]


def run_main(argv, cwd: Path, monkeypatch) -> int:
    monkeypatch.chdir(cwd)
    return rs.main(argv)


def store_of(repo: Path) -> Path:
    return repo / ".git" / "nullius" / "store"


def stow_json(run_dir, cwd, monkeypatch, capsys) -> dict:
    capsys.readouterr()
    assert run_main(["stow", str(run_dir), "--json"], cwd, monkeypatch) == rs.EXIT_OK
    return json.loads(capsys.readouterr().out)


def commit_records(repo: Path) -> None:
    """Commit what stow asks to commit (stowed files are ignored)."""
    sh("git", "add", "-A", cwd=repo)
    sh("git", "commit", "-q", "-m", "stow records", cwd=repo)


def overwrite_in_place(path: Path, data: bytes) -> None:
    os.chmod(path, 0o644)
    with open(path, "r+b") as fh:
        fh.write(data)


# ------------------------------------------------------------------ check

def test_check_staged_warns_and_strict_blocks(tmp_path, monkeypatch, capsys):
    repo = make_repo(tmp_path)
    run = repo / "artifacts" / "runs" / "r1"
    run.mkdir()
    (run / "big.dat").write_bytes(blob(THRESHOLD + 10))
    (run / "small.txt").write_text("summary\n")
    sh("git", "add", "-A", cwd=repo)
    assert run_main(["check", "--staged"], repo, monkeypatch) == rs.EXIT_OK
    out = capsys.readouterr().out
    assert "artifacts/runs/r1/big.dat" in out and "small.txt" not in out
    assert "git rm --cached <path>" in out, "the hint keeps the file on disk"
    assert run_main(["check", "--staged", "--strict"], repo, monkeypatch) == rs.EXIT_FINDINGS
    sh("git", "restore", "--staged", "artifacts/runs/r1/big.dat", cwd=repo)
    capsys.readouterr()
    assert run_main(["check", "--staged", "--strict", "--quiet"], repo, monkeypatch) == rs.EXIT_OK
    assert capsys.readouterr().out == ""


def test_check_working_tree_classifies_bulk(tmp_path, monkeypatch, capsys):
    repo = make_repo(tmp_path)
    runs = repo / "artifacts" / "runs"
    (runs / "legacy").mkdir()
    (runs / "legacy" / "tracked.dat").write_bytes(blob(THRESHOLD, 1))
    sh("git", "add", "-A", cwd=repo)
    sh("git", "commit", "-q", "-m", "legacy bulk", cwd=repo)
    (runs / "new").mkdir()
    (runs / "new" / "untracked.dat").write_bytes(blob(THRESHOLD, 2))
    (runs / "stowed").mkdir()
    (runs / "stowed" / "out.dat").write_bytes(blob(THRESHOLD, 3))
    assert run_main(["stow", "artifacts/runs/stowed"], repo, monkeypatch) == rs.EXIT_OK
    (runs / "ignored").mkdir()
    (runs / "ignored" / ".gitignore").write_text("*.dat\n")
    (runs / "ignored" / "lost.dat").write_bytes(blob(THRESHOLD, 4))
    capsys.readouterr()
    assert run_main(["check", "--json"], repo, monkeypatch) == rs.EXIT_OK
    doc = json.loads(capsys.readouterr().out)
    paths = {k: [r["path"] for r in doc[k]] for k in ("tracked", "untracked", "stowed", "stowed_damaged",
                                                      "ignored_unstowed")}
    assert paths == {
        "tracked": ["artifacts/runs/legacy/tracked.dat"],
        "untracked": ["artifacts/runs/new/untracked.dat"],
        "stowed": ["artifacts/runs/stowed/out.dat"],
        "stowed_damaged": [],
        "ignored_unstowed": ["artifacts/runs/ignored/lost.dat"],
    }
    assert run_main(["check", "--strict"], repo, monkeypatch) == rs.EXIT_FINDINGS


@pytest.mark.parametrize("damage", ["rewrite_by_rename", "shrink_below_threshold", "store_object_lost"])
def test_check_strict_flags_stowed_outputs_that_no_longer_match(tmp_path, monkeypatch, capsys, damage):
    repo = make_repo(tmp_path)
    run = repo / "artifacts" / "runs" / "r1"
    run.mkdir()
    (run / "a.bin").write_bytes(blob(THRESHOLD, 5))
    assert run_main(["stow", str(run)], repo, monkeypatch) == rs.EXIT_OK
    sha = rs.sha256_file(run / "a.bin")
    if damage == "rewrite_by_rename":  # read-only bits do not stop a rename over the file
        (run / ".tmp").write_bytes(blob(THRESHOLD, 6))
        os.replace(run / ".tmp", run / "a.bin")
    elif damage == "shrink_below_threshold":
        (run / "a.bin").unlink()
        (run / "a.bin").write_bytes(b"small now")
    else:
        rs.store_path(store_of(repo), sha).unlink()
    capsys.readouterr()
    assert run_main(["check", "--strict", "--json"], repo, monkeypatch) == rs.EXIT_FINDINGS
    doc = json.loads(capsys.readouterr().out)
    assert [r["path"] for r in doc["stowed_damaged"]] == ["artifacts/runs/r1/a.bin"] and doc["stowed"] == []


@pytest.mark.parametrize("defect", ["duplicate_path", "hash_not_hex", "size_bool", "size_negative", "path_not_normal"])
@pytest.mark.parametrize("command", ["check", "verify", "stow", "materialize"])
def test_malformed_manifests_are_refused_by_every_reader(tmp_path, monkeypatch, defect, command):
    repo = make_repo(tmp_path)
    run = repo / "artifacts" / "runs" / "r1"
    run.mkdir()
    (run / "a.bin").write_bytes(blob(THRESHOLD, 83))
    assert run_main(["stow", str(run)], repo, monkeypatch) == rs.EXIT_OK
    manifest = json.loads((run / rs.MANIFEST_NAME).read_text())
    entry = manifest["entries"][0]
    if defect == "duplicate_path":  # a damaged first record followed by a valid one
        manifest["entries"] = [{**entry, "sha256": "f" * 64}, entry]
    elif defect == "hash_not_hex":
        entry["sha256"] = "z" * 64
    elif defect == "size_bool":
        entry["size"] = True
    elif defect == "size_negative":
        entry["size"] = -1
    else:
        entry["path"] = "./a.bin"
    (run / rs.MANIFEST_NAME).write_text(json.dumps(manifest))
    argv = {"check": ["check", "--strict"], "verify": ["verify", str(run)], "stow": ["stow", str(run)],
            "materialize": ["materialize", str(run)]}[command]
    assert run_main(argv, repo, monkeypatch) == rs.EXIT_ERROR


def test_verify_compares_the_recorded_size_too(tmp_path, monkeypatch, capsys):
    repo = make_repo(tmp_path)
    run = repo / "artifacts" / "runs" / "r1"
    run.mkdir()
    (run / "a.bin").write_bytes(blob(THRESHOLD, 84))
    assert run_main(["stow", str(run)], repo, monkeypatch) == rs.EXIT_OK
    manifest = json.loads((run / rs.MANIFEST_NAME).read_text())
    manifest["entries"][0]["size"] += 1  # inconsistent record, right hash
    (run / rs.MANIFEST_NAME).write_text(json.dumps(manifest))
    capsys.readouterr()
    assert run_main(["verify", str(run), "--json"], repo, monkeypatch) == rs.EXIT_FINDINGS
    assert [e["status"] for e in json.loads(capsys.readouterr().out)["entries"]] == ["mismatch"]


def test_policy_file_is_validated(tmp_path, monkeypatch):
    repo = make_repo(tmp_path)
    policy = repo / ".nullius" / "storage_policy.json"
    for doc in ({"schema": "other"},
                {"schema": rs.POLICY_SCHEMA, "bulk_threshold_bytes": 0},
                {"schema": rs.POLICY_SCHEMA, "run_roots": ["../outside"]},
                # a relative store would live inside each checkout and die with a removed worktree
                {"schema": rs.POLICY_SCHEMA, "store_root": ".nullius/store"}):
        policy.write_text(json.dumps(doc))
        assert run_main(["check"], repo, monkeypatch) == rs.EXIT_ERROR, doc


@pytest.mark.parametrize("mode", ["staged", "working_tree"])
def test_check_counts_a_file_of_exactly_the_threshold_as_bulk(tmp_path, monkeypatch, capsys, mode):
    repo = make_repo(tmp_path)
    run = repo / "artifacts" / "runs" / "r1"
    run.mkdir()
    (run / "at.bin").write_bytes(blob(THRESHOLD, 1))
    (run / "below.bin").write_bytes(blob(THRESHOLD - 1, 2))
    sh("git", "add", "-A", cwd=repo)
    capsys.readouterr()
    argv = ["check", "--json"] + (["--staged"] if mode == "staged" else [])
    assert run_main(argv, repo, monkeypatch) == rs.EXIT_OK
    doc = json.loads(capsys.readouterr().out)
    found = doc["staged_bulk"] if mode == "staged" else doc["pending"]
    assert [r["path"] for r in found] == ["artifacts/runs/r1/at.bin"]


def test_check_staged_treats_names_with_glob_characters_literally(tmp_path, monkeypatch, capsys):
    repo = make_repo(tmp_path)
    run = repo / "artifacts" / "runs" / "r1"
    run.mkdir()
    (run / "a.bin").write_bytes(blob(THRESHOLD, 3))  # committed bulk that a glob "[ab].bin" would match
    sh("git", "add", "-A", cwd=repo)
    sh("git", "commit", "-q", "-m", "legacy", cwd=repo)
    (run / "[ab].bin").write_bytes(blob(THRESHOLD, 4))
    sh("git", "add", "-A", cwd=repo)
    capsys.readouterr()
    assert run_main(["check", "--staged", "--json"], repo, monkeypatch) == rs.EXIT_OK
    assert [r["path"] for r in json.loads(capsys.readouterr().out)["staged_bulk"]] == ["artifacts/runs/r1/[ab].bin"]


def test_check_separates_committed_bulk_from_bulk_the_next_commit_would_add(tmp_path, monkeypatch, capsys):
    repo = make_repo(tmp_path)
    runs = repo / "artifacts" / "runs"
    (runs / "old").mkdir()
    (runs / "old" / "kept.bin").write_bytes(blob(THRESHOLD, 5))
    (runs / "old" / "edited.bin").write_bytes(blob(THRESHOLD, 6))
    (runs / "old" / "restaged.bin").write_bytes(blob(THRESHOLD, 7))
    sh("git", "add", "-A", cwd=repo)
    sh("git", "commit", "-q", "-m", "legacy", cwd=repo)
    (runs / "old" / "edited.bin").write_bytes(blob(THRESHOLD, 8))  # modified in the working tree only
    (runs / "old" / "restaged.bin").write_bytes(blob(THRESHOLD, 9))
    (runs / "new").mkdir()
    (runs / "new" / "added.bin").write_bytes(blob(THRESHOLD, 10))
    sh("git", "add", "artifacts/runs/old/restaged.bin", "artifacts/runs/new/added.bin", cwd=repo)
    capsys.readouterr()
    assert run_main(["check", "--json"], repo, monkeypatch) == rs.EXIT_OK
    doc = json.loads(capsys.readouterr().out)
    assert [r["path"] for r in doc["tracked"]] == ["artifacts/runs/old/kept.bin"]
    assert sorted(r["path"] for r in doc["pending"]) == [
        "artifacts/runs/new/added.bin", "artifacts/runs/old/edited.bin", "artifacts/runs/old/restaged.bin"]
    assert run_main(["check", "--strict"], repo, monkeypatch) == rs.EXIT_FINDINGS


@pytest.mark.parametrize("state", ["tracked", "stowed", "pending", "untracked", "ignored_unstowed",
                                   "stowed_damaged", "symlinked_run_root"])
def test_check_strict_fails_on_exactly_the_classes_that_need_attention(tmp_path, monkeypatch, state):
    repo = make_repo(tmp_path)
    run = repo / "artifacts" / "runs" / "r1"
    run.mkdir()
    (run / "big.bin").write_bytes(blob(THRESHOLD, 11))
    if state == "tracked":
        sh("git", "add", "-A", cwd=repo)
        sh("git", "commit", "-q", "-m", "bulk", cwd=repo)
    elif state in ("stowed", "stowed_damaged"):
        assert run_main(["stow", str(run)], repo, monkeypatch) == rs.EXIT_OK
        commit_records(repo)
        if state == "stowed_damaged":
            rs.store_path(store_of(repo), rs.sha256_file(run / "big.bin")).unlink()
    elif state == "pending":
        sh("git", "add", "-A", cwd=repo)
    elif state == "ignored_unstowed":
        (run / ".gitignore").write_text("*.bin\n")
    elif state == "symlinked_run_root":
        shutil.move(str(repo / "artifacts"), str(repo / "real-artifacts"))
        os.symlink("real-artifacts", repo / "artifacts")  # an ancestor of the run root, inside the checkout
    expected = rs.EXIT_OK if state in ("tracked", "stowed") else rs.EXIT_FINDINGS
    assert run_main(["check", "--strict"], repo, monkeypatch) == expected


def test_check_lists_but_never_classifies_files_of_a_nested_repository(tmp_path, monkeypatch, capsys):
    repo = make_repo(tmp_path)
    nested = repo / "artifacts" / "runs" / "dep"
    nested.mkdir()
    sh("git", "init", "-q", cwd=nested)
    (nested / "big.bin").write_bytes(blob(THRESHOLD, 12))
    (nested / "run").mkdir()
    (nested / "run" / rs.MANIFEST_NAME).write_text("{ that repository's own records, not read here")
    capsys.readouterr()
    assert run_main(["check", "--strict", "--json"], repo, monkeypatch) == rs.EXIT_OK
    doc = json.loads(capsys.readouterr().out)
    assert doc["nested_repositories"] == [{"path": "artifacts/runs/dep", "size": 0}]
    assert all(doc[k] == [] for k in ("tracked", "pending", "untracked", "ignored_unstowed", "stowed"))


def test_check_never_counts_the_manifest_or_ignore_file_as_bulk(tmp_path, monkeypatch, capsys):
    # Staged/snapshot admission exempts validated stow records only; a
    # reserved filename alone grants no exemption (docs/RUN_STORAGE.md).
    repo = make_repo(tmp_path)
    run = repo / "artifacts" / "runs" / "r1"
    run.mkdir()
    (run / ".gitignore").write_text("# a long user ignore file\n" + "*.tmp\n" * THRESHOLD)
    for i in range(STOWED_FOR_LARGE_MANIFEST):
        (run / f"big{i:02d}.bin").write_bytes(blob(THRESHOLD, 14 + i))
    stow_json(run, repo, monkeypatch, capsys)
    sh("git", "add", "-A", cwd=repo)
    assert sh("git", "diff", "--cached", "--name-only", cwd=repo).stdout.split() == [
        "artifacts/runs/r1/.gitignore", "artifacts/runs/r1/bulk_manifest.json"]
    # Both records are at or above the threshold, so passing requires the
    # validated-record exemption, not merely small files.
    assert min((run / n).stat().st_size for n in (".gitignore", rs.MANIFEST_NAME)) >= THRESHOLD
    for mode in ("--staged", "--snapshot"):
        capsys.readouterr()
        assert run_main(["check", mode, "--strict", "--json"], repo, monkeypatch) == rs.EXIT_OK, mode
        doc = json.loads(capsys.readouterr().out)
        assert doc["admission_findings"] == [] and doc["admission_limits"] == []
        assert doc["admission_totals"] == {"files": 0, "logical_bytes": 0}  # records excluded from totals
    sh("git", "commit", "-q", "-m", "stow records", cwd=repo)
    assert run_main(["check", "--strict"], repo, monkeypatch) == rs.EXIT_OK
    unmanaged = repo / "artifacts" / "runs" / "r2"
    unmanaged.mkdir()
    (unmanaged / ".gitignore").write_text("# a long user ignore file\n" + "*.tmp\n" * THRESHOLD)
    sh("git", "add", "-A", cwd=repo)
    assert run_main(["check", "--strict"], repo, monkeypatch) == rs.EXIT_OK
    (unmanaged / rs.MANIFEST_NAME).write_text("x" * THRESHOLD)  # reserved name, not a stow record
    sh("git", "add", "-A", cwd=repo)
    for mode in ("--staged", "--snapshot"):
        capsys.readouterr()
        assert run_main(["check", mode, "--strict", "--json"], repo, monkeypatch) == rs.EXIT_FINDINGS, mode
        assert {(r["path"], r["reason"]) for r in json.loads(capsys.readouterr().out)["admission_findings"]} == {
            ("artifacts/runs/r2/.gitignore", "bulk_output"), ("artifacts/runs/r2/" + rs.MANIFEST_NAME, "bulk_output")}


def test_a_path_recorded_by_two_manifests_is_damaged_and_neither_record_hides_the_other(tmp_path, monkeypatch, capsys):
    repo = make_repo(tmp_path)
    outer = repo / "artifacts" / "runs" / "r1"
    (outer / "inner").mkdir(parents=True)
    (outer / "inner" / "a.bin").write_bytes(blob(THRESHOLD, 13))
    assert run_main(["stow", str(outer / "inner")], repo, monkeypatch) == rs.EXIT_OK
    inner_entry = json.loads((outer / "inner" / rs.MANIFEST_NAME).read_text())["entries"][0]
    (outer / rs.MANIFEST_NAME).write_text(json.dumps(  # a second record of the same file, with other bytes
        {"schema": rs.MANIFEST_SCHEMA, "entries": [{**inner_entry, "path": "inner/a.bin", "sha256": "e" * 64}]}))
    capsys.readouterr()
    assert run_main(["check", "--strict", "--json"], repo, monkeypatch) == rs.EXIT_FINDINGS
    doc = json.loads(capsys.readouterr().out)
    assert [(r["path"], r["status"]) for r in doc["stowed_damaged"]] == [
        ("artifacts/runs/r1/inner/a.bin", "recorded_more_than_once")] and doc["stowed"] == []


@pytest.mark.parametrize("layout", ["enclosing", "nested"])
def test_stow_refuses_a_run_inside_or_around_another_stowed_run(tmp_path, monkeypatch, layout):
    repo = make_repo(tmp_path)
    outer = repo / "artifacts" / "runs" / "r1"
    (outer / "sub").mkdir(parents=True)
    (outer / "a.bin").write_bytes(blob(THRESHOLD, 14))
    (outer / "sub" / "b.bin").write_bytes(blob(THRESHOLD, 15))
    first, second = (outer, outer / "sub") if layout == "enclosing" else (outer / "sub", outer)
    assert run_main(["stow", str(first)], repo, monkeypatch) == rs.EXIT_OK
    before = (first / rs.MANIFEST_NAME).read_text()
    assert run_main(["stow", str(second)], repo, monkeypatch) == rs.EXIT_ERROR
    assert not (second / rs.MANIFEST_NAME).exists() and (first / rs.MANIFEST_NAME).read_text() == before


def test_policy_run_roots_must_be_plain_and_disjoint(tmp_path, monkeypatch):
    repo = make_repo(tmp_path)
    policy = repo / ".nullius" / "storage_policy.json"
    for roots in ([], ["."], ["./artifacts/runs"], ["artifacts//runs"], ["artifacts/./runs"], ["/abs"],
                  ["artifacts/../runs"], ["artifacts", "artifacts/runs"], ["artifacts/runs", "artifacts/runs/"],
                  [""], [7]):
        policy.write_text(json.dumps({"schema": rs.POLICY_SCHEMA, "run_roots": roots}))
        assert run_main(["check"], repo, monkeypatch) == rs.EXIT_ERROR, roots
    for doc in ({"schema": rs.POLICY_SCHEMA, "bulk_threshold_bytes": True},
                {"schema": rs.POLICY_SCHEMA, "bulk_threshold_bytes": "5"},
                {"schema": rs.POLICY_SCHEMA, "unknown": 1},
                {"schema": rs.POLICY_SCHEMA, "store_root": 5},
                ["not an object"]):
        policy.write_text(json.dumps(doc))
        assert run_main(["check"], repo, monkeypatch) == rs.EXIT_ERROR, doc
    policy.write_text(json.dumps({"schema": rs.POLICY_SCHEMA, "run_roots": ["artifacts/runs/", "outputs"],
                                  "store_root": str(tmp_path / "shared-store")}))
    assert run_main(["check"], repo, monkeypatch) == rs.EXIT_OK


@pytest.mark.parametrize("defect", ["schema", "entries_not_list", "size_string", "hash_uppercase", "path_absolute",
                                    "path_parent", "path_nul"])
def test_manifest_fields_are_checked_one_by_one(tmp_path, monkeypatch, defect):
    repo = make_repo(tmp_path)
    run = repo / "artifacts" / "runs" / "r1"
    run.mkdir()
    (run / "a.bin").write_bytes(blob(THRESHOLD, 16))
    assert run_main(["stow", str(run)], repo, monkeypatch) == rs.EXIT_OK
    manifest = json.loads((run / rs.MANIFEST_NAME).read_text())
    entry = manifest["entries"][0]
    if defect == "schema":
        manifest["schema"] = "other"
    elif defect == "entries_not_list":
        manifest["entries"] = {"a.bin": entry}
    elif defect == "size_string":
        entry["size"] = str(entry["size"])
    elif defect == "hash_uppercase":
        entry["sha256"] = entry["sha256"].upper()
    elif defect == "path_absolute":
        entry["path"] = "/a.bin"
    elif defect == "path_parent":
        entry["path"] = "../a.bin"
    else:
        entry["path"] = "a\x00.bin"
    (run / rs.MANIFEST_NAME).write_text(json.dumps(manifest))
    assert run_main(["verify", str(run)], repo, monkeypatch) == rs.EXIT_ERROR


# ------------------------------------------------------------------- stow

def test_stow_stores_once_and_keeps_the_file_readable_in_place(tmp_path, monkeypatch, capsys):
    repo = make_repo(tmp_path)
    run = repo / "artifacts" / "runs" / "r1"
    (run / "sub").mkdir(parents=True)
    data = blob(THRESHOLD * 3, 5)
    (run / "sub" / "field.bin").write_bytes(data)
    (run / "log.txt").write_text("small log\n")
    [stowed] = stow_json(run, repo, monkeypatch, capsys)["stowed"]
    target = run / "sub" / "field.bin"
    obj = rs.store_path(store_of(repo), stowed["sha256"])
    assert stowed["method"] in ("clone", "copy")
    assert rs.verify_store_object(obj, stowed["sha256"]) and target.read_bytes() == data
    assert stat.S_IMODE(target.stat().st_mode) & 0o222 == 0, "stowed output is read-only"
    if stowed["method"] == "clone":
        assert not os.path.samestat(obj.stat(), target.stat()), "a clone is an independent file"
    manifest = json.loads((run / rs.MANIFEST_NAME).read_text())
    assert manifest["schema"] == rs.MANIFEST_SCHEMA
    assert [(e["path"], e["size"], e["sha256"]) for e in manifest["entries"]] == \
        [("sub/field.bin", len(data), stowed["sha256"])]
    assert sh("git", "check-ignore", "-q", "artifacts/runs/r1/sub/field.bin", cwd=repo, check=False).returncode == 0
    assert sh("git", "check-ignore", "-q", "artifacts/runs/r1/log.txt", cwd=repo, check=False).returncode == 1
    sh("git", "add", "-A", cwd=repo)
    staged = sh("git", "diff", "--cached", "--name-only", cwd=repo).stdout.split()
    assert "artifacts/runs/r1/sub/field.bin" not in staged
    assert {"artifacts/runs/r1/bulk_manifest.json", "artifacts/runs/r1/.gitignore",
            "artifacts/runs/r1/log.txt"} <= set(staged)
    assert stow_json(run, repo, monkeypatch, capsys)["stowed"] == [], "second stow is a no-op"


def test_identical_outputs_share_one_store_object(tmp_path, monkeypatch, capsys):
    repo = make_repo(tmp_path)
    runs = repo / "artifacts" / "runs"
    for name in ("a", "b"):
        (runs / name).mkdir()
        (runs / name / "out.bin").write_bytes(blob(THRESHOLD * 2, 9))
    stow_json(runs / "a", repo, monkeypatch, capsys)
    [second] = stow_json(runs / "b", repo, monkeypatch, capsys)["stowed"]
    assert second["method"].startswith("existing")
    objects = [e for e in (store_of(repo) / "sha256").rglob("*") if e.is_file()]
    assert len(objects) == 1
    for name in ("a", "b"):
        assert run_main(["verify", str(runs / name)], repo, monkeypatch) == rs.EXIT_OK


def test_in_place_edit_is_refused_and_never_spreads_to_other_runs(tmp_path, monkeypatch, capsys):
    repo = make_repo(tmp_path)
    runs = repo / "artifacts" / "runs"
    original = blob(THRESHOLD * 2, 12)
    for name in ("a", "b"):
        (runs / name).mkdir()
        (runs / name / "out.bin").write_bytes(original)
    [first] = stow_json(runs / "a", repo, monkeypatch, capsys)["stowed"]
    assert first["method"] in ("clone", "copy"), "the store never shares an inode with a run file"
    overwrite_in_place(runs / "a" / "out.bin", b"CORRUPT")  # deliberate edit of a stowed output
    sha = rs.hashlib.sha256(original).hexdigest()
    assert rs.verify_store_object(rs.store_path(store_of(repo), sha), sha), "the edit never reaches the store"
    capsys.readouterr()
    assert run_main(["stow", str(runs / "a")], repo, monkeypatch) == rs.EXIT_FINDINGS, "changed result refused"
    # Run b holds the original bytes; stowing it must never replace them with damaged ones,
    # whether or not the edit above reached the store (it does when the store shares an inode).
    stow_json(runs / "b", repo, monkeypatch, capsys)
    assert (runs / "b" / "out.bin").read_bytes() == original
    assert rs.verify_store_object(rs.store_path(store_of(repo), sha), sha)
    assert run_main(["verify", str(runs / "b")], repo, monkeypatch) == rs.EXIT_OK
    overwrite_in_place(runs / "b" / "out.bin", b"LATER")  # an edit of run b never reaches run a's evidence
    assert rs.verify_store_object(rs.store_path(store_of(repo), sha), sha)


def test_stow_without_clone_support_still_keeps_independent_copies(tmp_path, monkeypatch, capsys):
    monkeypatch.setattr(rs, "clone_file", lambda a, b: False)  # e.g. a file system without copy-on-write
    repo = make_repo(tmp_path)
    run = repo / "artifacts" / "runs" / "r1"
    run.mkdir()
    data = blob(THRESHOLD, 18)
    (run / "out.bin").write_bytes(data)
    [stowed] = stow_json(run, repo, monkeypatch, capsys)["stowed"]
    obj = rs.store_path(store_of(repo), stowed["sha256"])
    assert stowed["method"] == "copy" and not os.path.samestat(obj.stat(), (run / "out.bin").stat())
    overwrite_in_place(run / "out.bin", b"EDIT")
    assert rs.verify_store_object(obj, stowed["sha256"])


def test_a_damaged_store_object_is_set_aside_not_trusted(tmp_path, monkeypatch, capsys):
    repo = make_repo(tmp_path)
    runs = repo / "artifacts" / "runs"
    original = blob(THRESHOLD * 2, 13)
    (runs / "a").mkdir()
    (runs / "a" / "out.bin").write_bytes(original)
    sha = stow_json(runs / "a", repo, monkeypatch, capsys)["stowed"][0]["sha256"]
    obj = rs.store_path(store_of(repo), sha)
    forged = obj.with_name("forged")
    forged.write_bytes(blob(len(original), 14))  # same size, different bytes, under the right name
    os.replace(forged, obj)
    assert run_main(["verify", str(runs / "a")], repo, monkeypatch) == rs.EXIT_FINDINGS  # ok_in_place_only
    (runs / "b").mkdir()
    (runs / "b" / "out.bin").write_bytes(original)
    stow_json(runs / "b", repo, monkeypatch, capsys)
    assert (runs / "b" / "out.bin").read_bytes() == original
    assert rs.verify_store_object(obj, sha)
    assert [p.name for p in obj.parent.iterdir() if ".damaged-" in p.name], "damaged bytes kept for inspection"
    assert run_main(["verify", str(runs / "a")], repo, monkeypatch) == rs.EXIT_OK


def test_stow_leaves_tracked_bulk_alone_and_refuses_outside_run_roots(tmp_path, monkeypatch, capsys):
    repo = make_repo(tmp_path)
    run = repo / "artifacts" / "runs" / "legacy"
    run.mkdir()
    (run / "tracked.bin").write_bytes(blob(THRESHOLD, 11))
    sh("git", "add", "-A", cwd=repo)
    sh("git", "commit", "-q", "-m", "legacy", cwd=repo)
    doc = stow_json(run, repo, monkeypatch, capsys)
    assert doc["stowed"] == [] and [r["path"] for r in doc["already_tracked"]] == ["tracked.bin"]
    other = repo / "elsewhere"
    other.mkdir()
    assert run_main(["stow", str(other)], repo, monkeypatch) == rs.EXIT_ERROR


def test_stow_refuses_unrecordable_names_before_changing_anything(tmp_path, monkeypatch):
    repo = make_repo(tmp_path)
    run = repo / "artifacts" / "runs" / "r1"
    run.mkdir()
    (run / "fine.bin").write_bytes(blob(THRESHOLD, 15))
    (run / "line\nbreak.bin").write_bytes(blob(THRESHOLD, 16))
    assert run_main(["stow", str(run)], repo, monkeypatch) == rs.EXIT_ERROR
    assert not (run / rs.MANIFEST_NAME).exists() and not (run / ".gitignore").exists()
    assert stat.S_IMODE((run / "fine.bin").stat().st_mode) & 0o200, "nothing was made read-only"
    assert not store_of(repo).exists()


@pytest.mark.skipif(sys.platform == "darwin", reason="macOS file systems refuse names that are not valid UTF-8")
def test_stow_refuses_names_that_are_not_utf8(tmp_path, monkeypatch):
    repo = make_repo(tmp_path)
    run = repo / "artifacts" / "runs" / "r1"
    run.mkdir()
    (run / "fine.bin").write_bytes(blob(THRESHOLD, 15))
    with open(os.path.join(os.fsencode(run), b"bad\xff.bin"), "wb") as fh:
        fh.write(blob(THRESHOLD, 19))
    assert run_main(["stow", str(run)], repo, monkeypatch) == rs.EXIT_ERROR
    assert not (run / rs.MANIFEST_NAME).exists()
    assert stat.S_IMODE((run / "fine.bin").stat().st_mode) & 0o200


def test_materialize_without_clone_support_places_an_independent_read_only_copy(tmp_path, monkeypatch, capsys):
    monkeypatch.setattr(rs, "clone_file", lambda a, b: False)
    repo = make_repo(tmp_path)
    run = repo / "artifacts" / "runs" / "r1"
    run.mkdir()
    data = blob(THRESHOLD, 68)
    (run / "out.bin").write_bytes(data)
    sha = stow_json(run, repo, monkeypatch, capsys)["stowed"][0]["sha256"]
    (run / "out.bin").unlink()
    capsys.readouterr()
    assert run_main(["materialize", str(run), "--json"], repo, monkeypatch) == rs.EXIT_OK
    assert [r["method"] for r in json.loads(capsys.readouterr().out)["restored"]] == ["copy"]
    obj = rs.store_path(store_of(repo), sha)
    placed = run / "out.bin"
    assert placed.read_bytes() == data and not os.path.samestat(placed.stat(), obj.stat())
    assert stat.S_IMODE(placed.stat().st_mode) & 0o222 == 0


def test_store_put_rehashes_the_source_when_the_object_already_exists(tmp_path, monkeypatch):
    src = tmp_path / "out.bin"
    src.write_bytes(blob(THRESHOLD, 69))
    store = tmp_path / "store"
    rs.store_put(src, store)
    real_verify = rs.verify_store_object

    def writer_during_verify(obj, sha, size=None):  # an open writer changes the source meanwhile
        src.write_bytes(blob(THRESHOLD, 70))
        return real_verify(obj, sha, size)

    monkeypatch.setattr(rs, "verify_store_object", writer_during_verify)
    with pytest.raises(rs.StorageError, match="changed while being stored"):
        rs.store_put(src, store)


def test_stow_rehashes_what_is_in_place_after_storing(tmp_path, monkeypatch, capsys):
    repo = make_repo(tmp_path)
    run = repo / "artifacts" / "runs" / "r1"
    run.mkdir()
    (run / "out.bin").write_bytes(blob(THRESHOLD, 71))
    real_put = rs.store_put

    def put_then_writer(path, store):  # the bytes change after a clean store step
        result = real_put(path, store)
        overwrite_in_place(path, blob(THRESHOLD, 72))
        return result

    monkeypatch.setattr(rs, "store_put", put_then_writer)
    assert run_main(["stow", str(run)], repo, monkeypatch) == rs.EXIT_ERROR
    assert not (run / rs.MANIFEST_NAME).exists(), "nothing recorded for bytes that are not in place"


@pytest.mark.parametrize("command", ["verify", "check", "stow", "materialize"])
def test_symlinks_at_or_above_recorded_paths_are_never_trusted(tmp_path, monkeypatch, capsys, command):
    repo = make_repo(tmp_path)
    run = repo / "artifacts" / "runs" / "r1"
    run.mkdir()
    (run / "a.bin").write_bytes(blob(THRESHOLD, 71))
    assert run_main(["stow", str(run)], repo, monkeypatch) == rs.EXIT_OK
    (run / "a.bin").unlink()
    os.symlink(tmp_path / "nowhere", run / "a.bin")  # dangling symlink at a recorded path
    outside = tmp_path / "outside"
    outside.mkdir()
    os.symlink(outside, run / "link")  # a symlinked ancestor of a recorded path
    manifest = json.loads((run / rs.MANIFEST_NAME).read_text())
    manifest["entries"].append({"path": "link/escape.bin", "size": THRESHOLD, "sha256": manifest["entries"][0]["sha256"]})
    (run / rs.MANIFEST_NAME).write_text(json.dumps(manifest))
    capsys.readouterr()
    argv = {"verify": ["verify", str(run), "--json"], "check": ["check", "--strict", "--json"],
            "stow": ["stow", str(run)], "materialize": ["materialize", str(run), "--json"]}[command]
    assert run_main(argv, repo, monkeypatch) == rs.EXIT_FINDINGS
    out = capsys.readouterr().out
    if command == "verify":
        assert {e["path"]: e["status"] for e in json.loads(out)["entries"]} == {
            "a.bin": "mismatch", "link/escape.bin": "unsafe_path"}
    if command == "check":
        assert len(json.loads(out)["stowed_damaged"]) == 2
    assert list(outside.iterdir()) == [], "nothing is created outside the run directory"


def test_stow_refuses_a_recorded_path_that_escapes_through_a_symlinked_ancestor(tmp_path, monkeypatch):
    repo = make_repo(tmp_path)
    run = repo / "artifacts" / "runs" / "r1"
    run.mkdir()
    (run / "a.bin").write_bytes(blob(THRESHOLD, 74))
    assert run_main(["stow", str(run)], repo, monkeypatch) == rs.EXIT_OK
    outside = tmp_path / "outside"
    outside.mkdir()
    (outside / "escape.bin").write_bytes(blob(THRESHOLD, 75))
    os.chmod(outside / "escape.bin", 0o644)
    os.symlink(outside, run / "link")
    manifest = json.loads((run / rs.MANIFEST_NAME).read_text())
    manifest["entries"].append({"path": "link/escape.bin", "size": THRESHOLD,
                                "sha256": rs.sha256_file(outside / "escape.bin")})
    (run / rs.MANIFEST_NAME).write_text(json.dumps(manifest))
    (run / "new.bin").write_bytes(blob(THRESHOLD, 76))
    assert run_main(["stow", str(run)], repo, monkeypatch) == rs.EXIT_FINDINGS
    assert stat.S_IMODE((outside / "escape.bin").stat().st_mode) == 0o644, "nothing outside is touched"
    assert stat.S_IMODE((run / "new.bin").stat().st_mode) & 0o200, "nothing is changed at all"


def test_materialize_never_overwrites_an_occupied_path(tmp_path, monkeypatch, capsys):
    repo = make_repo(tmp_path)
    run = repo / "artifacts" / "runs" / "r1"
    run.mkdir()
    (run / "a.bin").write_bytes(blob(THRESHOLD, 64))
    (run / "b.bin").write_bytes(blob(THRESHOLD, 65))
    assert run_main(["stow", str(run)], repo, monkeypatch) == rs.EXIT_OK
    (run / "a.bin").unlink()
    os.symlink(tmp_path / "nowhere", run / "a.bin")  # dangling
    (run / "b.bin").unlink()
    (run / "b.bin").write_bytes(b"other bytes")
    capsys.readouterr()
    assert run_main(["materialize", str(run), "--json"], repo, monkeypatch) == rs.EXIT_FINDINGS
    doc = json.loads(capsys.readouterr().out)
    assert {p["path"]: p["status"] for p in doc["unavailable"]} == {
        "a.bin": "occupied_by_symlink", "b.bin": "occupied_by_different_bytes"}
    assert (run / "b.bin").read_bytes() == b"other bytes"


def test_stow_refuses_a_run_directory_holding_a_nested_repository(tmp_path, monkeypatch):
    repo = make_repo(tmp_path)
    run = repo / "artifacts" / "runs" / "r1"
    nested = run / "dep"
    nested.mkdir(parents=True)
    sh("git", "init", "-q", cwd=nested)
    (nested / "big.bin").write_bytes(blob(THRESHOLD, 85))
    assert run_main(["stow", str(run), "--project-root", str(repo)], repo, monkeypatch) == rs.EXIT_ERROR
    assert stat.S_IMODE((nested / "big.bin").stat().st_mode) & 0o200 and not (run / rs.MANIFEST_NAME).exists()


def test_symlinked_run_root_is_refused_cleanly(tmp_path, monkeypatch):
    repo = make_repo(tmp_path)
    outside = tmp_path / "outside-runs"
    (outside / "r1").mkdir(parents=True)
    (outside / "r1" / "big.bin").write_bytes(blob(THRESHOLD, 17))
    shutil.rmtree(repo / "artifacts" / "runs")
    os.symlink(outside, repo / "artifacts" / "runs")
    assert run_main(["stow", "artifacts/runs/r1"], repo, monkeypatch) == rs.EXIT_ERROR
    assert run_main(["check"], repo, monkeypatch) == rs.EXIT_OK
    for argv in (["check", "--strict"], ["check", "--staged", "--strict"]):
        assert run_main(argv, repo, monkeypatch) == rs.EXIT_FINDINGS, argv
    assert stat.S_IMODE((outside / "r1" / "big.bin").stat().st_mode) & 0o200


def test_ignore_block_escapes_special_names(tmp_path, monkeypatch):
    repo = make_repo(tmp_path)
    run = repo / "artifacts" / "runs" / "r1"
    run.mkdir()
    names = ["a[1]*.bin", "#hash.bin", "!bang.bin", "trailing.bin ", "back\\slash.bin", "tab\there.bin"]
    for i, name in enumerate(names):
        (run / name).write_bytes(blob(THRESHOLD, 20 + i))
    (run / "a1x.bin").write_bytes(b"small")
    (run / ".gitignore").write_text("# user rule kept\n*.tmp\n")
    assert run_main(["stow", str(run)], repo, monkeypatch) == rs.EXIT_OK
    for name in names:
        rel = f"artifacts/runs/r1/{name}"
        assert sh("git", "check-ignore", "-q", "--no-index", rel, cwd=repo, check=False).returncode == 0, name
    assert sh("git", "check-ignore", "-q", "artifacts/runs/r1/a1x.bin", cwd=repo, check=False).returncode == 1
    text = (run / ".gitignore").read_text()
    assert text.startswith("# user rule kept\n*.tmp\n") and text.count(rs.GITIGNORE_BEGIN) == 1


@pytest.mark.skipif(sys.platform != "darwin", reason="decomposed file names are a macOS file-system behaviour")
def test_decomposed_unicode_names_are_recorded_in_git_form(tmp_path, monkeypatch, capsys):
    repo = make_repo(tmp_path)
    run = repo / "artifacts" / "runs" / "r1"
    run.mkdir()
    (run / "é.bin").write_bytes(blob(THRESHOLD, 30))  # NFD on disk
    assert run_main(["stow", str(run)], repo, monkeypatch) == rs.EXIT_OK
    assert sh("git", "status", "--porcelain", "--untracked-files=all", cwd=repo).stdout.count(".bin") == 0
    commit_records(repo)
    capsys.readouterr()
    assert run_main(["check", "--strict", "--json"], repo, monkeypatch) == rs.EXIT_OK
    doc = json.loads(capsys.readouterr().out)
    assert doc["stowed_damaged"] == [] and doc["ignored_unstowed"] == []
    assert [r["path"] for r in doc["stowed"]] == ["artifacts/runs/r1/é.bin"]


def test_store_put_copies_across_file_systems(tmp_path, monkeypatch):
    src = tmp_path / "f.bin"
    src.write_bytes(blob(THRESHOLD, 30))

    def no_link(a, b):
        raise OSError(errno.EXDEV, "cross-device link")

    monkeypatch.setattr(rs, "clone_file", lambda a, b: False)
    real_link = rs.os.link
    monkeypatch.setattr(rs.os, "link", lambda a, b: no_link(a, b) if Path(a) == src else real_link(a, b))
    sha, dest, method = rs.store_put(src, tmp_path / "store")
    assert method == "copy" and dest.read_bytes() == src.read_bytes()
    assert not os.path.samestat(dest.stat(), src.stat())


@pytest.mark.parametrize("state", ["missing", "store_mismatch"])
def test_stow_refuses_while_a_recorded_entry_is_unavailable(tmp_path, monkeypatch, capsys, state):
    repo = make_repo(tmp_path)
    run = repo / "artifacts" / "runs" / "r1"
    run.mkdir()
    (run / "a.bin").write_bytes(blob(THRESHOLD, 17))
    assert run_main(["stow", str(run)], repo, monkeypatch) == rs.EXIT_OK
    obj = rs.store_path(store_of(repo), rs.sha256_file(run / "a.bin"))
    (run / "a.bin").unlink()
    os.chmod(obj, 0o644)
    if state == "missing":
        obj.unlink()
    else:
        obj.write_bytes(blob(THRESHOLD, 18))
    (run / "new.bin").write_bytes(blob(THRESHOLD, 19))
    before = (run / rs.MANIFEST_NAME).read_text()
    capsys.readouterr()
    assert run_main(["stow", str(run)], repo, monkeypatch) == rs.EXIT_FINDINGS
    err = capsys.readouterr().err
    assert "from another copy" in err and "renaming it back to the recorded spelling" in err
    assert (run / rs.MANIFEST_NAME).read_text() == before
    assert stat.S_IMODE((run / "new.bin").stat().st_mode) & 0o200, "nothing is changed"


def test_stow_stores_again_an_entry_whose_store_copy_was_lost(tmp_path, monkeypatch, capsys):
    repo = make_repo(tmp_path)
    run = repo / "artifacts" / "runs" / "r1"
    run.mkdir()
    (run / "a.bin").write_bytes(blob(THRESHOLD, 20))
    assert run_main(["stow", str(run)], repo, monkeypatch) == rs.EXIT_OK
    obj = rs.store_path(store_of(repo), rs.sha256_file(run / "a.bin"))
    obj.unlink()
    capsys.readouterr()
    assert run_main(["verify", str(run), "--json"], repo, monkeypatch) == rs.EXIT_FINDINGS
    assert [e["status"] for e in json.loads(capsys.readouterr().out)["entries"]] == ["ok_in_place_only"]
    assert run_main(["stow", str(run)], repo, monkeypatch) == rs.EXIT_OK
    capsys.readouterr()
    assert run_main(["verify", str(run), "--json"], repo, monkeypatch) == rs.EXIT_OK
    assert [e["status"] for e in json.loads(capsys.readouterr().out)["entries"]] == ["ok"]
    assert stat.S_IMODE(obj.stat().st_mode) == 0o444


def test_restow_keeps_user_rules_around_the_managed_block_and_anchors_entries(tmp_path, monkeypatch):
    repo = make_repo(tmp_path)
    run = repo / "artifacts" / "runs" / "r1"
    run.mkdir()
    (run / "out.bin").write_bytes(blob(THRESHOLD, 21))
    assert run_main(["stow", str(run)], repo, monkeypatch) == rs.EXIT_OK
    with open(run / ".gitignore", "a") as fh:
        fh.write("# user rules after the block\n*.log\n")
    (run / "more.bin").write_bytes(blob(THRESHOLD, 22))
    assert run_main(["stow", str(run)], repo, monkeypatch) == rs.EXIT_OK
    text = (run / ".gitignore").read_text()
    assert text.endswith("# user rules after the block\n*.log\n") and text.count(rs.GITIGNORE_BEGIN) == 1
    (run / "sub").mkdir()
    (run / "sub" / "out.bin").write_bytes(b"a different, small file of the same name")
    assert sh("git", "check-ignore", "-q", "artifacts/runs/r1/sub/out.bin", cwd=repo, check=False).returncode == 1


def test_stow_reports_a_deeper_negation_rule_that_re_includes_a_stowed_file(tmp_path, monkeypatch, capsys):
    repo = make_repo(tmp_path)
    run = repo / "artifacts" / "runs" / "r1"
    (run / "sub").mkdir(parents=True)
    (run / "sub" / ".gitignore").write_text("!big.bin\n")
    (run / "sub" / "big.bin").write_bytes(blob(THRESHOLD, 23))
    capsys.readouterr()
    assert run_main(["stow", str(run)], repo, monkeypatch) == rs.EXIT_FINDINGS
    assert "sub/big.bin" in capsys.readouterr().err


@pytest.mark.skipif(sys.platform != "darwin", reason="needs a case-insensitive file system")
def test_a_case_only_rename_on_a_case_insensitive_file_system_is_not_recorded_twice(tmp_path, monkeypatch, capsys):
    (tmp_path / "probe").write_text("")
    if not (tmp_path / "PROBE").exists():
        pytest.skip("this file system is case-sensitive")
    repo = make_repo(tmp_path)
    run = repo / "artifacts" / "runs" / "r1"
    run.mkdir()
    (run / "out.bin").write_bytes(blob(THRESHOLD, 24))
    assert run_main(["stow", str(run)], repo, monkeypatch) == rs.EXIT_OK
    commit_records(repo)
    os.rename(run / "out.bin", run / "OUT.bin")
    assert run_main(["stow", str(run)], repo, monkeypatch) == rs.EXIT_OK
    assert [e["path"] for e in json.loads((run / rs.MANIFEST_NAME).read_text())["entries"]] == ["out.bin"]
    capsys.readouterr()
    assert run_main(["check", "--strict", "--json"], repo, monkeypatch) == rs.EXIT_OK
    doc = json.loads(capsys.readouterr().out)
    assert len(doc["stowed"]) == 1 and doc["ignored_unstowed"] == [], "one file, classified once"


@pytest.mark.parametrize("variant", ["repository_above_the_run_dir", "run_dir_is_a_repository", "git_file"])
def test_stow_refuses_run_directories_that_belong_to_another_repository(tmp_path, monkeypatch, variant):
    repo = make_repo(tmp_path)
    run = repo / "artifacts" / "runs" / ("dep/r1" if variant == "repository_above_the_run_dir" else "r1")
    run.mkdir(parents=True)
    (run / "big.bin").write_bytes(blob(THRESHOLD, 25))
    if variant == "repository_above_the_run_dir":  # the run directory itself holds no .git
        sh("git", "init", "-q", cwd=run.parent)
    elif variant == "run_dir_is_a_repository":
        sh("git", "init", "-q", cwd=run)
    else:
        (run / "dep").mkdir()
        (run / "dep" / ".git").write_text("gitdir: /nonexistent/elsewhere\n")
    assert run_main(["stow", str(run), "--project-root", str(repo)], repo, monkeypatch) == rs.EXIT_ERROR
    assert stat.S_IMODE((run / "big.bin").stat().st_mode) & 0o200 and not (run / rs.MANIFEST_NAME).exists()


def test_a_symlinked_store_object_is_never_trusted(tmp_path, monkeypatch, capsys):
    repo = make_repo(tmp_path)
    run = repo / "artifacts" / "runs" / "r1"
    run.mkdir()
    data = blob(THRESHOLD, 26)
    (run / "a.bin").write_bytes(data)
    assert run_main(["stow", str(run)], repo, monkeypatch) == rs.EXIT_OK
    obj = rs.store_path(store_of(repo), rs.sha256_file(run / "a.bin"))
    elsewhere = tmp_path / "elsewhere.bin"
    elsewhere.write_bytes(data)  # the right bytes, but not a store object
    obj.unlink()
    os.symlink(elsewhere, obj)
    (run / "a.bin").unlink()
    capsys.readouterr()
    assert run_main(["verify", str(run), "--json"], repo, monkeypatch) == rs.EXIT_FINDINGS
    assert [e["status"] for e in json.loads(capsys.readouterr().out)["entries"]] == ["store_mismatch"]
    assert run_main(["materialize", str(run)], repo, monkeypatch) == rs.EXIT_FINDINGS
    assert not (run / "a.bin").exists()


def test_a_store_object_of_another_size_than_recorded_is_not_restored(tmp_path, monkeypatch, capsys):
    repo = make_repo(tmp_path)
    run = repo / "artifacts" / "runs" / "r1"
    run.mkdir()
    (run / "a.bin").write_bytes(blob(THRESHOLD, 27))
    assert run_main(["stow", str(run)], repo, monkeypatch) == rs.EXIT_OK
    (run / "a.bin").unlink()
    manifest = json.loads((run / rs.MANIFEST_NAME).read_text())
    manifest["entries"][0]["size"] += 1  # inconsistent record, right hash
    (run / rs.MANIFEST_NAME).write_text(json.dumps(manifest))
    capsys.readouterr()
    assert run_main(["verify", str(run), "--json"], repo, monkeypatch) == rs.EXIT_FINDINGS
    assert [e["status"] for e in json.loads(capsys.readouterr().out)["entries"]] == ["store_mismatch"]
    assert run_main(["materialize", str(run)], repo, monkeypatch) == rs.EXIT_FINDINGS
    assert not (run / "a.bin").exists()


def test_materialize_never_opens_a_special_file_at_a_recorded_path(tmp_path, monkeypatch, capsys):
    repo = make_repo(tmp_path)
    run = repo / "artifacts" / "runs" / "r1"
    run.mkdir()
    (run / "out.bin").write_bytes(blob(THRESHOLD, 28))
    assert run_main(["stow", str(run)], repo, monkeypatch) == rs.EXIT_OK
    (run / "out.bin").unlink()
    os.mkfifo(run / "out.bin")  # opening it for reading would block
    capsys.readouterr()
    assert run_main(["materialize", str(run), "--json"], repo, monkeypatch) == rs.EXIT_FINDINGS
    assert [p["status"] for p in json.loads(capsys.readouterr().out)["unavailable"]] == ["occupied_by_non_file"]


def test_store_put_publishes_nothing_under_the_old_hash_when_the_source_changes_while_copied(tmp_path, monkeypatch):
    src = tmp_path / "out.bin"
    src.write_bytes(blob(THRESHOLD, 29))
    sha = rs.sha256_file(src)
    store = tmp_path / "store"

    def writer_during_clone(a, b):  # the source changes after hashing, before the copy
        src.write_bytes(blob(THRESHOLD, 30))
        return False

    monkeypatch.setattr(rs, "clone_file", writer_during_clone)
    with pytest.raises(rs.StorageError, match="changed while being stored"):
        rs.store_put(src, store)
    assert not rs.store_path(store, sha).exists()
    assert list(rs.store_path(store, sha).parent.iterdir()) == [], "no incoming copy is left behind"


@pytest.mark.parametrize("racer", ["same_bytes", "other_bytes"])
def test_publish_never_replaces_an_object_that_appears_meanwhile(tmp_path, monkeypatch, capsys, racer):
    src = tmp_path / "out.bin"
    data = blob(THRESHOLD, 31)
    src.write_bytes(data)
    sha = rs.sha256_file(src)
    store = tmp_path / "store"
    dest = rs.store_path(store, sha)

    def concurrent_stow(a, b):  # another worktree publishes the same name in between
        dest.write_bytes(data if racer == "same_bytes" else blob(THRESHOLD, 32))
        return False

    monkeypatch.setattr(rs, "clone_file", concurrent_stow)
    got_sha, obj, method = rs.store_put(src, store)
    assert got_sha == sha and obj.read_bytes() == data
    if racer == "same_bytes":
        assert method == "existing"
    else:
        assert method == "copy" and len(list(dest.parent.glob(f"{sha}.damaged-*"))) == 1, "set aside, not deleted"


def test_materialize_never_replaces_a_file_that_appears_meanwhile(tmp_path, monkeypatch, capsys):
    repo = make_repo(tmp_path)
    run = repo / "artifacts" / "runs" / "r1"
    run.mkdir()
    (run / "a.bin").write_bytes(blob(THRESHOLD, 33))
    assert run_main(["stow", str(run)], repo, monkeypatch) == rs.EXIT_OK
    (run / "a.bin").unlink()
    real_copy = rs.copy_file_durably

    def writer_appears(src, dst):  # a program writes the path after materialize looked
        (run / "a.bin").write_bytes(b"new bytes from elsewhere")
        return real_copy(src, dst)

    monkeypatch.setattr(rs, "clone_file", lambda a, b: False)
    monkeypatch.setattr(rs, "copy_file_durably", writer_appears)
    assert run_main(["materialize", str(run)], repo, monkeypatch) == rs.EXIT_FINDINGS
    assert (run / "a.bin").read_bytes() == b"new bytes from elsewhere"


def test_materialize_places_nothing_from_a_damaged_store_object(tmp_path, monkeypatch, capsys):
    repo = make_repo(tmp_path)
    run = repo / "artifacts" / "runs" / "r1"
    run.mkdir()
    (run / "a.bin").write_bytes(blob(THRESHOLD, 34))
    assert run_main(["stow", str(run)], repo, monkeypatch) == rs.EXIT_OK
    obj = rs.store_path(store_of(repo), rs.sha256_file(run / "a.bin"))
    (run / "a.bin").unlink()
    os.chmod(obj, 0o644)
    overwrite_in_place(obj, blob(THRESHOLD, 35))
    capsys.readouterr()
    assert run_main(["materialize", str(run), "--json"], repo, monkeypatch) == rs.EXIT_FINDINGS
    assert [p["status"] for p in json.loads(capsys.readouterr().out)["unavailable"]] == ["store_mismatch"]
    assert not (run / "a.bin").exists()


def test_stow_refuses_a_restored_entry_whose_bytes_changed_before_storing(tmp_path, monkeypatch, capsys):
    repo = make_repo(tmp_path)
    run = repo / "artifacts" / "runs" / "r1"
    run.mkdir()
    (run / "a.bin").write_bytes(blob(THRESHOLD, 36))
    assert run_main(["stow", str(run)], repo, monkeypatch) == rs.EXIT_OK
    rs.store_path(store_of(repo), rs.sha256_file(run / "a.bin")).unlink()  # ok_in_place_only
    real_put = rs.store_put

    def writer_then_put(path, store):  # changed after it was judged intact, before it is stored
        overwrite_in_place(path, blob(THRESHOLD, 37))
        return real_put(path, store)

    monkeypatch.setattr(rs, "store_put", writer_then_put)
    before = (run / rs.MANIFEST_NAME).read_text()
    assert run_main(["stow", str(run)], repo, monkeypatch) == rs.EXIT_ERROR
    assert (run / rs.MANIFEST_NAME).read_text() == before


def test_git_calls_never_fetch_lock_or_expand_patterns(monkeypatch, tmp_path):
    seen = {}

    def capture(args, **kwargs):
        seen["args"], seen["env"] = args, kwargs["env"]
        return subprocess.CompletedProcess(args, 0, b"", b"")

    monkeypatch.setattr(rs.subprocess, "run", capture)
    rs.git(["status"], tmp_path)
    assert seen["env"]["GIT_NO_LAZY_FETCH"] == "1" and seen["env"]["GIT_OPTIONAL_LOCKS"] == "0"
    assert seen["env"]["GIT_LITERAL_PATHSPECS"] == "1" and seen["env"]["GIT_TERMINAL_PROMPT"] == "0"
    assert "protocol.allow=never" in seen["args"]


def test_check_staged_in_a_partial_clone_fetches_nothing(tmp_path, monkeypatch, capsys):
    origin = make_repo(tmp_path)
    run = origin / "artifacts" / "runs" / "r1"
    run.mkdir()
    (run / "old.bin").write_bytes(blob(THRESHOLD, 38))
    sh("git", "add", "-A", cwd=origin)
    sh("git", "commit", "-q", "-m", "bulk", cwd=origin)
    sh("git", "config", "uploadpack.allowFilter", "true", cwd=origin)
    sh("git", "config", "uploadpack.allowAnySHA1InWant", "true", cwd=origin)
    clone = tmp_path / "clone"
    sh("git", "clone", "-q", "--no-checkout", "--filter=blob:none", origin.resolve().as_uri(), str(clone), cwd=tmp_path)
    sh("git", "read-tree", "HEAD", cwd=clone)  # index from HEAD; blobs stay on the remote
    missing = lambda: sh("git", "rev-list", "--objects", "--all", "--missing=print", cwd=clone).stdout.count("\n?")
    before = missing()
    assert before >= 1
    sh("git", "rm", "-q", "--cached", "artifacts/runs/r1/old.bin", cwd=clone)
    (clone / "artifacts" / "runs" / "r1").mkdir(parents=True)
    (clone / "artifacts" / "runs" / "r1" / "new.bin").write_bytes(blob(THRESHOLD, 38)[:-8] + b"changed!")
    sh("git", "add", "artifacts/runs/r1/new.bin", cwd=clone)  # a rename candidate of a blob that is not here
    capsys.readouterr()
    # the policy file is not checked out here, so the threshold is given explicitly
    assert run_main(["check", "--staged", "--json", "--threshold", str(THRESHOLD)], clone, monkeypatch) == rs.EXIT_OK
    assert [r["path"] for r in json.loads(capsys.readouterr().out)["staged_bulk"]] == ["artifacts/runs/r1/new.bin"]
    assert missing() == before, "nothing was fetched from the remote"


@pytest.mark.skipif(sys.platform != "darwin", reason="decomposed file names are a macOS file-system behaviour")
def test_decomposed_unicode_run_directory_names_are_matched_in_git_form(tmp_path, monkeypatch, capsys):
    repo = make_repo(tmp_path)
    run = repo / "artifacts" / "runs" / "e\u0301t\u00e9"  # NFD and NFC mixed on disk
    run.mkdir()
    (run / "a.bin").write_bytes(blob(THRESHOLD, 39))
    assert run_main(["stow", str(run)], repo, monkeypatch) == rs.EXIT_OK
    commit_records(repo)
    capsys.readouterr()
    assert run_main(["check", "--strict", "--json"], repo, monkeypatch) == rs.EXIT_OK
    doc = json.loads(capsys.readouterr().out)
    assert doc["ignored_unstowed"] == [] and len(doc["stowed"]) == 1


def test_check_staged_flags_a_run_root_behind_a_symlinked_ancestor(tmp_path, monkeypatch, capsys):
    repo = make_repo(tmp_path)
    shutil.move(str(repo / "artifacts"), str(repo / "real-artifacts"))
    os.symlink("real-artifacts", repo / "artifacts")
    capsys.readouterr()
    assert run_main(["check", "--staged", "--strict", "--json"], repo, monkeypatch) == rs.EXIT_FINDINGS
    assert json.loads(capsys.readouterr().out)["symlinked_run_roots"] == ["artifacts/runs"]
    assert run_main(["check", "--staged"], repo, monkeypatch) == rs.EXIT_OK


@pytest.mark.parametrize("where", ["main_checkout", "linked_worktree", "worktree_private_git_dir",
                                   "relative_inside_the_checkout", "common_git_dir", "outside"])
@pytest.mark.parametrize("how", ["policy", "option"])
def test_a_store_inside_any_checkout_is_refused(tmp_path, monkeypatch, where, how):
    repo = make_repo(tmp_path)
    wt = tmp_path / "wt"
    sh("git", "worktree", "add", "-q", "-b", "side", str(wt), cwd=repo)
    store = {"main_checkout": repo / "kept-store",
             "linked_worktree": wt / "kept-store",
             "worktree_private_git_dir": repo / ".git" / "worktrees" / "wt" / "kept-store",
             "relative_inside_the_checkout": Path("kept-store"),
             "common_git_dir": repo / ".git" / "kept-store",
             "outside": tmp_path / "kept-store"}[where]
    run = repo / "artifacts" / "runs" / "r1"
    run.mkdir()
    (run / "a.bin").write_bytes(blob(THRESHOLD, 40))
    argv = ["stow", str(run)]
    if how == "policy":
        (repo / ".nullius" / "storage_policy.json").write_text(json.dumps(
            {"schema": rs.POLICY_SCHEMA, "bulk_threshold_bytes": THRESHOLD, "store_root": str(store)}))
    else:
        argv += ["--store", str(store)]
    if where == "relative_inside_the_checkout" and how == "policy":
        pytest.skip("the policy refuses relative paths outright (test_policy_file_is_validated)")
    expected = rs.EXIT_OK if where in ("common_git_dir", "outside") else rs.EXIT_ERROR
    assert run_main(argv, repo, monkeypatch) == expected
    assert (repo / store if not store.is_absolute() else store).exists() == (expected == rs.EXIT_OK)
    if expected == rs.EXIT_ERROR:
        assert stat.S_IMODE((run / "a.bin").stat().st_mode) & 0o200 and not (run / rs.MANIFEST_NAME).exists()


def test_a_store_reached_through_a_symlink_into_a_worktree_private_git_directory_is_refused(tmp_path, monkeypatch):
    repo = make_repo(tmp_path)
    wt = tmp_path / "wt"
    sh("git", "worktree", "add", "-q", "-b", "side", str(wt), cwd=repo)
    os.symlink(repo / ".git" / "worktrees" / "wt", tmp_path / "alias")  # removed with that worktree
    run = repo / "artifacts" / "runs" / "r1"
    run.mkdir()
    (run / "a.bin").write_bytes(blob(THRESHOLD, 41))
    assert run_main(["stow", str(run), "--store", str(tmp_path / "alias" / "kept-store")], repo,
                    monkeypatch) == rs.EXIT_ERROR
    assert not (repo / ".git" / "worktrees" / "wt" / "kept-store").exists()


@pytest.mark.parametrize("state", ["staged_new", "committed_then_changed", "committed_then_changed_and_staged"])
def test_stow_refuses_bulk_files_the_next_commit_would_add(tmp_path, monkeypatch, capsys, state):
    repo = make_repo(tmp_path)
    run = repo / "artifacts" / "runs" / "r1"
    run.mkdir()
    (run / "a.bin").write_bytes(blob(THRESHOLD, 41))
    sh("git", "add", "-A", cwd=repo)
    if state != "staged_new":
        sh("git", "commit", "-q", "-m", "bulk", cwd=repo)
        (run / "a.bin").write_bytes(blob(THRESHOLD, 42))
        if state == "committed_then_changed_and_staged":
            sh("git", "add", "-A", cwd=repo)
    (run / "b.bin").write_bytes(blob(THRESHOLD, 43))  # an untracked candidate is not stowed either
    capsys.readouterr()
    assert run_main(["stow", str(run)], repo, monkeypatch) == rs.EXIT_FINDINGS
    assert "\n  a.bin\n" in capsys.readouterr().err, "the uncommitted file is named"
    assert not (run / rs.MANIFEST_NAME).exists() and not (run / ".gitignore").exists()
    assert stat.S_IMODE((run / "a.bin").stat().st_mode) & 0o200 and stat.S_IMODE((run / "b.bin").stat().st_mode) & 0o200


def test_a_data_file_with_the_reserved_manifest_name_is_explained(tmp_path, monkeypatch, capsys):
    repo = make_repo(tmp_path)
    run = repo / "artifacts" / "runs" / "r1"
    (run / "sub").mkdir(parents=True)
    (run / "sub" / rs.MANIFEST_NAME).write_bytes(blob(5000, 44))  # a data file that happens to have the name
    (run / "big.bin").write_bytes(blob(THRESHOLD, 45))
    for argv in (["check"], ["stow", str(run)]):
        capsys.readouterr()
        assert run_main(argv, repo, monkeypatch) == rs.EXIT_ERROR, argv
        assert "is reserved for run storage manifests" in capsys.readouterr().err, argv
    assert stat.S_IMODE((run / "big.bin").stat().st_mode) & 0o200


def test_symlinked_ignore_file_or_manifest_is_refused_and_left_alone(tmp_path, monkeypatch):
    repo = make_repo(tmp_path)
    run = repo / "artifacts" / "runs" / "r1"
    run.mkdir()
    (run / "big.bin").write_bytes(blob(THRESHOLD, 46))
    shared = repo / "shared-ignore"
    shared.write_text("*.tmp\n")
    os.symlink("../../../shared-ignore", run / ".gitignore")
    assert run_main(["stow", str(run)], repo, monkeypatch) == rs.EXIT_ERROR
    assert (run / ".gitignore").is_symlink() and shared.read_text() == "*.tmp\n"
    assert stat.S_IMODE((run / "big.bin").stat().st_mode) & 0o200 and not (run / rs.MANIFEST_NAME).exists()
    (run / ".gitignore").unlink()
    assert run_main(["stow", str(run)], repo, monkeypatch) == rs.EXIT_OK
    real = repo / "manifest-elsewhere.json"
    os.replace(run / rs.MANIFEST_NAME, real)
    os.symlink("../../../manifest-elsewhere.json", run / rs.MANIFEST_NAME)
    for argv in (["verify", str(run)], ["check"], ["stow", str(run)]):
        assert run_main(argv, repo, monkeypatch) == rs.EXIT_ERROR, argv


@pytest.mark.parametrize("rule", ["root_ignored_by_parent", "manifest_ignored_by_run_rule"])
def test_stow_refuses_when_git_would_ignore_the_record(tmp_path, monkeypatch, capsys, rule):
    repo = make_repo(tmp_path)
    run = repo / "artifacts" / "runs" / "r1"
    run.mkdir()
    (run / "a.bin").write_bytes(blob(THRESHOLD, 47))
    if rule == "root_ignored_by_parent":
        (repo / ".gitignore").write_text("artifacts/runs/\n")
    else:
        (run / ".gitignore").write_text("*.json\n")
    before = (run / ".gitignore").read_text() if (run / ".gitignore").exists() else None
    capsys.readouterr()
    assert run_main(["stow", str(run)], repo, monkeypatch) == rs.EXIT_FINDINGS
    assert "bulk_manifest.json" in capsys.readouterr().err
    assert not (run / rs.MANIFEST_NAME).exists() and stat.S_IMODE((run / "a.bin").stat().st_mode) & 0o200
    assert ((run / ".gitignore").read_text() if (run / ".gitignore").exists() else None) == before
    assert not store_of(repo).exists()


def test_check_strict_flags_stow_records_not_committed_as_they_are(tmp_path, monkeypatch, capsys):
    repo = make_repo(tmp_path)
    run = repo / "artifacts" / "runs" / "r1"
    run.mkdir()
    (run / "a.bin").write_bytes(blob(THRESHOLD, 48))
    assert run_main(["stow", str(run)], repo, monkeypatch) == rs.EXIT_OK

    def records():
        capsys.readouterr()
        code = run_main(["check", "--strict", "--json"], repo, monkeypatch)
        return code, {r["path"]: r["status"] for r in json.loads(capsys.readouterr().out)["uncommitted_records"]}

    manifest, ignore = "artifacts/runs/r1/bulk_manifest.json", "artifacts/runs/r1/.gitignore"
    assert records() == (rs.EXIT_FINDINGS, {manifest: "untracked", ignore: "untracked"})
    commit_records(repo)
    assert records() == (rs.EXIT_OK, {})
    (run / "b.bin").write_bytes(blob(THRESHOLD, 49))
    assert run_main(["stow", str(run)], repo, monkeypatch) == rs.EXIT_OK  # the record changed
    assert records() == (rs.EXIT_FINDINGS, {manifest: "pending", ignore: "pending"})
    commit_records(repo)
    (run / ".gitignore").unlink()
    code, found = records()
    assert code == rs.EXIT_FINDINGS and found == {ignore: "missing"}


def test_symbolic_links_under_run_roots_are_listed_not_followed(tmp_path, monkeypatch, capsys):
    repo = make_repo(tmp_path)
    run = repo / "artifacts" / "runs" / "r1"
    run.mkdir()
    elsewhere = tmp_path / "elsewhere"
    elsewhere.mkdir()
    (elsewhere / "big.bin").write_bytes(blob(THRESHOLD, 50))
    os.symlink(elsewhere, run / "data")
    commit_records(repo)  # the link itself is committed
    capsys.readouterr()
    assert run_main(["check", "--strict", "--json"], repo, monkeypatch) == rs.EXIT_OK
    assert [r["path"] for r in json.loads(capsys.readouterr().out)["symlinks_not_followed"]] == ["artifacts/runs/r1/data"]
    assert run_main(["check"], repo, monkeypatch) == rs.EXIT_OK
    assert "artifacts/runs/r1/data is a symbolic link, not followed" in capsys.readouterr().out
    doc = stow_json(run, repo, monkeypatch, capsys)
    assert doc["symlinks_not_followed"] == ["data"] and doc["stowed"] == [] and doc["commit_needed"] is False
    assert not (run / rs.MANIFEST_NAME).exists() and not (run / ".gitignore").exists(), "nothing to record"


def test_an_unreadable_head_tree_is_an_error_but_no_commit_yet_is_not(tmp_path, monkeypatch, capsys):
    repo = make_repo(tmp_path)
    run = repo / "artifacts" / "runs" / "r1"
    run.mkdir()
    (run / "a.bin").write_bytes(blob(THRESHOLD, 51))
    sh("git", "add", "-A", cwd=repo)
    sh("git", "commit", "-q", "-m", "bulk", cwd=repo)
    real_git = rs.git

    def tree_missing(args, cwd, **kw):  # e.g. a partial clone without trees, with fetching disabled
        if args[0] == "ls-tree":  # the real call, made to fail as a missing tree object would
            args = [a if a != "HEAD" else "0" * 40 for a in args]
        return real_git(args, cwd, **kw)

    monkeypatch.setattr(rs, "git", tree_missing)
    assert run_main(["check", "--strict"], repo, monkeypatch) == rs.EXIT_ERROR
    monkeypatch.setattr(rs, "git", real_git)
    fresh = tmp_path / "fresh"
    fresh.mkdir()
    sh("git", "init", "-q", "-b", "main", cwd=fresh)
    (fresh / "artifacts" / "runs" / "r1").mkdir(parents=True)
    (fresh / "artifacts" / "runs" / "r1" / "a.bin").write_bytes(blob(rs.DEFAULT_THRESHOLD, 52))
    sh("git", "add", "-A", cwd=fresh)
    capsys.readouterr()
    assert run_main(["check", "--json"], fresh, monkeypatch) == rs.EXIT_OK
    assert [r["path"] for r in json.loads(capsys.readouterr().out)["pending"]] == ["artifacts/runs/r1/a.bin"]


def test_limit_must_not_be_negative(tmp_path, monkeypatch):
    repo = make_repo(tmp_path)
    with pytest.raises(SystemExit) as exc:
        run_main(["check", "--limit", "-1"], repo, monkeypatch)
    assert exc.value.code == 2


def test_materialize_dry_run_says_what_it_would_restore(tmp_path, monkeypatch, capsys):
    repo = make_repo(tmp_path)
    run = repo / "artifacts" / "runs" / "r1"
    run.mkdir()
    (run / "a.bin").write_bytes(blob(THRESHOLD, 53))
    assert run_main(["stow", str(run)], repo, monkeypatch) == rs.EXIT_OK
    (run / "a.bin").unlink()
    capsys.readouterr()
    assert run_main(["materialize", str(run), "--dry-run"], repo, monkeypatch) == rs.EXIT_OK
    assert "1 would be restored (dry run)" in capsys.readouterr().out and not (run / "a.bin").exists()


def test_a_force_added_stowed_file_is_reported_as_tracked_not_as_a_negation_rule(tmp_path, monkeypatch, capsys):
    repo = make_repo(tmp_path)
    run = repo / "artifacts" / "runs" / "r1"
    run.mkdir()
    (run / "big.bin").write_bytes(blob(THRESHOLD, 54))
    assert run_main(["stow", str(run)], repo, monkeypatch) == rs.EXIT_OK
    commit_records(repo)
    sh("git", "add", "-f", "artifacts/runs/r1/big.bin", cwd=repo)
    capsys.readouterr()
    assert run_main(["stow", str(run)], repo, monkeypatch) == rs.EXIT_FINDINGS
    err = capsys.readouterr().err
    assert "git rm --cached <path>" in err and "negation rule" not in err
    (run / "sub").mkdir()
    (run / "sub" / ".gitignore").write_text("!other.bin\n")
    (run / "sub" / "other.bin").write_bytes(blob(THRESHOLD, 58))  # re-included by a deeper rule
    capsys.readouterr()
    assert run_main(["stow", str(run)], repo, monkeypatch) == rs.EXIT_FINDINGS
    err = capsys.readouterr().err
    assert "big.bin: stowed but tracked" in err and "does not cover sub/other.bin;" in err and "['" not in err
    assert run_main(["stow", str(run), "--json"], repo, monkeypatch) == rs.EXIT_FINDINGS
    doc = json.loads(capsys.readouterr().out)
    assert doc["refused"] == ["reincluded_by_negation", "stowed_but_tracked"] and doc["record_written"] is True
    assert doc["items"] == {"reincluded_by_negation": [{"path": "sub/other.bin"}],
                            "stowed_but_tracked": [{"path": "big.bin"}]}


def test_a_stow_that_changes_nothing_rewrites_nothing_and_asks_for_no_commit(tmp_path, monkeypatch, capsys):
    repo = make_repo(tmp_path)
    run = repo / "artifacts" / "runs" / "r1"
    run.mkdir()
    (run / "big.bin").write_bytes(blob(THRESHOLD, 55))
    assert run_main(["stow", str(run)], repo, monkeypatch) == rs.EXIT_OK
    capsys.readouterr()
    assert run_main(["stow", str(run)], repo, monkeypatch) == rs.EXIT_OK
    assert "  commit " in capsys.readouterr().out, "uncommitted records are still to be committed"
    commit_records(repo)
    stamps = {n: os.stat(run / n, follow_symlinks=False).st_mtime_ns for n in (rs.MANIFEST_NAME, ".gitignore")}
    inodes = {n: os.stat(run / n).st_ino for n in (rs.MANIFEST_NAME, ".gitignore")}
    capsys.readouterr()
    assert run_main(["stow", str(run)], repo, monkeypatch) == rs.EXIT_OK
    out = capsys.readouterr().out
    assert "nothing changed" in out and "  commit " not in out
    assert {n: os.stat(run / n).st_ino for n in (rs.MANIFEST_NAME, ".gitignore")} == inodes, "not rewritten"
    assert {n: os.stat(run / n, follow_symlinks=False).st_mtime_ns for n in (rs.MANIFEST_NAME, ".gitignore")} == stamps
    assert stow_json(run, repo, monkeypatch, capsys)["commit_needed"] is False
    (run / "more.bin").write_bytes(blob(THRESHOLD, 57))  # a new output changes the committed record
    doc = stow_json(run, repo, monkeypatch, capsys)
    assert doc["commit_needed"] is True and [s["path"] for s in doc["stowed"]] == ["more.bin"]
    assert "/more.bin" in (run / ".gitignore").read_text()
    assert {e["path"] for e in json.loads((run / rs.MANIFEST_NAME).read_text())["entries"]} == {"big.bin", "more.bin"}


@pytest.mark.parametrize("staged", [True, False])
def test_a_mode_only_change_to_a_stow_record_is_not_committed(tmp_path, monkeypatch, capsys, staged):
    repo = make_repo(tmp_path)
    run = repo / "artifacts" / "runs" / "r1"
    run.mkdir()
    (run / "big.bin").write_bytes(blob(THRESHOLD, 56))
    assert run_main(["stow", str(run)], repo, monkeypatch) == rs.EXIT_OK
    commit_records(repo)
    os.chmod(run / rs.MANIFEST_NAME, 0o755)
    if staged:
        sh("git", "add", "artifacts/runs/r1/bulk_manifest.json", cwd=repo)
    capsys.readouterr()
    assert run_main(["stow", str(run)], repo, monkeypatch) == rs.EXIT_OK
    out = capsys.readouterr().out
    assert "  commit " in out and "nothing changed" not in out
    assert run_main(["check", "--strict", "--json"], repo, monkeypatch) == rs.EXIT_FINDINGS
    assert [r["status"] for r in json.loads(capsys.readouterr().out)["uncommitted_records"]] == ["pending"]


@pytest.mark.parametrize("flag", ["--assume-unchanged", "--skip-worktree"])
def test_a_path_whose_index_flag_hides_changes_is_never_taken_as_committed(tmp_path, monkeypatch, capsys, flag):
    repo = make_repo(tmp_path)
    run = repo / "artifacts" / "runs" / "r1"
    run.mkdir()
    (run / "old.bin").write_bytes(blob(THRESHOLD, 59))
    sh("git", "add", "-A", cwd=repo)
    sh("git", "commit", "-q", "-m", "bulk", cwd=repo)
    sh("git", "update-index", flag, "artifacts/runs/r1/old.bin", cwd=repo)
    overwrite_in_place(run / "old.bin", blob(THRESHOLD, 60))  # git status stays silent about this
    assert sh("git", "status", "--porcelain", cwd=repo).stdout == ""
    capsys.readouterr()
    assert run_main(["check", "--strict", "--json"], repo, monkeypatch) == rs.EXIT_FINDINGS
    doc = json.loads(capsys.readouterr().out)
    assert [r["path"] for r in doc["pending"]] == ["artifacts/runs/r1/old.bin"] and doc["tracked"] == []
    assert run_main(["stow", str(run)], repo, monkeypatch) == rs.EXIT_FINDINGS
    assert "--no-assume-unchanged" in capsys.readouterr().err
    assert not (run / rs.MANIFEST_NAME).exists()


@pytest.mark.parametrize("flag", ["--assume-unchanged", "--skip-worktree"])
def test_a_flagged_stow_record_is_not_committed_as_it_is(tmp_path, monkeypatch, capsys, flag):
    repo = make_repo(tmp_path)
    run = repo / "artifacts" / "runs" / "r1"
    run.mkdir()
    (run / "big.bin").write_bytes(blob(THRESHOLD, 61))
    assert run_main(["stow", str(run)], repo, monkeypatch) == rs.EXIT_OK
    commit_records(repo)
    sh("git", "update-index", flag, "artifacts/runs/r1/.gitignore", cwd=repo)
    with open(run / ".gitignore", "a") as fh:
        fh.write("*.tmp\n")  # a user rule git status does not show
    capsys.readouterr()
    assert run_main(["check", "--strict", "--json"], repo, monkeypatch) == rs.EXIT_FINDINGS
    found = {r["path"]: r["status"] for r in json.loads(capsys.readouterr().out)["uncommitted_records"]}
    assert found == {"artifacts/runs/r1/.gitignore": "pending"}
    assert stow_json(run, repo, monkeypatch, capsys)["commit_needed"] is True


def test_commit_needed_follows_the_record_as_it_ends_up(tmp_path, monkeypatch, capsys):
    repo = make_repo(tmp_path)
    run = repo / "artifacts" / "runs" / "r1"
    run.mkdir()
    (run / "big.bin").write_bytes(blob(THRESHOLD, 62))
    capsys.readouterr()
    assert run_main(["stow", str(run), "--dry-run", "--json"], repo, monkeypatch) == rs.EXIT_OK
    assert json.loads(capsys.readouterr().out)["commit_needed"] is None, "a dry run predicts nothing"
    assert run_main(["stow", str(run)], repo, monkeypatch) == rs.EXIT_OK
    commit_records(repo)
    policy = repo / ".nullius" / "storage_policy.json"  # a committed threshold change rewrites the manifest
    policy.write_text(json.dumps({"schema": rs.POLICY_SCHEMA, "bulk_threshold_bytes": THRESHOLD - 1}))
    commit_records(repo)
    capsys.readouterr()
    assert run_main(["stow", str(run), "--dry-run", "--json"], repo, monkeypatch) == rs.EXIT_OK
    assert json.loads(capsys.readouterr().out)["commit_needed"] is None
    assert stow_json(run, repo, monkeypatch, capsys)["commit_needed"] is True, "threshold_bytes was updated"
    commit_records(repo)
    with open(run / rs.MANIFEST_NAME, "a") as fh:
        fh.write("\n\n")  # harmless whitespace; stow rewrites the committed bytes
    doc = stow_json(run, repo, monkeypatch, capsys)
    assert doc["commit_needed"] is False
    assert sh("git", "status", "--porcelain", cwd=repo).stdout == ""


@pytest.mark.parametrize("how", ["policy", "option"])
def test_a_store_inside_another_repository_working_tree_is_refused(tmp_path, monkeypatch, capsys, how):
    repo = make_repo(tmp_path)
    other = tmp_path / "other-repository"
    other.mkdir()
    sh("git", "init", "-q", cwd=other)
    store = other / "cache" / "not-yet-created"  # judged from its nearest existing ancestor
    run = repo / "artifacts" / "runs" / "r1"
    run.mkdir()
    (run / "a.bin").write_bytes(blob(THRESHOLD, 63))
    argv = ["stow", str(run)]
    if how == "policy":
        (repo / ".nullius" / "storage_policy.json").write_text(json.dumps(
            {"schema": rs.POLICY_SCHEMA, "bulk_threshold_bytes": THRESHOLD, "store_root": str(store)}))
    else:
        argv += ["--store", str(store)]
    capsys.readouterr()
    assert run_main(argv, repo, monkeypatch) == rs.EXIT_ERROR
    assert f"lies inside {other.resolve()}" in capsys.readouterr().err
    assert not store.exists() and not (run / rs.MANIFEST_NAME).exists()
    assert stat.S_IMODE((run / "a.bin").stat().st_mode) & 0o200


def test_ignore_checks_take_glob_characters_and_a_leading_colon_literally(tmp_path, monkeypatch):
    repo = make_repo(tmp_path)
    (repo / ".gitignore").write_text("/a1x.bin\n/x.bin\n")
    for name in ("a1x.bin", "a[1]*.bin", "x.bin", ":x.bin"):
        (repo / name).write_bytes(b"x")
    r = rs.Repo(repo)
    assert rs.is_ignored(r, repo / "a1x.bin") and rs.is_ignored(r, repo / "x.bin")
    assert not rs.is_ignored(r, repo / "a[1]*.bin"), "a glob name is not the file it would match"
    assert not rs.is_ignored(r, repo / ":x.bin"), "a leading ':' is not pathspec magic"


@pytest.mark.skipif(sys.platform != "darwin", reason="needs a case-insensitive file system")
def test_case_sensitivity_is_measured_when_the_config_does_not_say(tmp_path, monkeypatch, capsys):
    (tmp_path / "probe").write_text("")
    if not (tmp_path / "PROBE").exists():
        pytest.skip("this file system is case-sensitive")
    repo = make_repo(tmp_path)
    sh("git", "config", "--unset", "core.ignorecase", cwd=repo, check=False)  # absent already is fine
    assert rs.case_insensitive(repo) is True and rs.Repo(repo).ignorecase is True
    assert not list(repo.glob(".nullius-case-probe-*")), "the probe file is removed"
    run = repo / "artifacts" / "runs" / "r1"
    run.mkdir()
    (run / "out.bin").write_bytes(blob(THRESHOLD, 64))
    assert run_main(["stow", str(run)], repo, monkeypatch) == rs.EXIT_OK
    commit_records(repo)
    os.rename(run / "out.bin", run / "OUT.bin")
    capsys.readouterr()
    # git matches ignore rules case-sensitively here, so a plain `git add` would commit OUT.bin
    assert run_main(["stow", str(run)], repo, monkeypatch) == rs.EXIT_FINDINGS
    assert "renamed only in letter case" in capsys.readouterr().err
    assert [e["path"] for e in json.loads((run / rs.MANIFEST_NAME).read_text())["entries"]] == ["out.bin"]
    assert run_main(["check", "--strict", "--json"], repo, monkeypatch) == rs.EXIT_FINDINGS
    assert [r["path"] for r in json.loads(capsys.readouterr().out)["untracked"]] == ["artifacts/runs/r1/OUT.bin"]
    sh("git", "config", "core.ignorecase", "true", cwd=repo)  # git now treats case as equal: covered
    assert run_main(["stow", str(run)], repo, monkeypatch) == rs.EXIT_OK
    assert run_main(["check", "--strict"], repo, monkeypatch) == rs.EXIT_OK


def test_case_probe_reports_what_the_file_system_does(tmp_path):
    (tmp_path / "lower").write_text("")
    observed = (tmp_path / "LOWER").exists()
    sub = tmp_path / "probe-here"
    sub.mkdir()
    assert rs.case_insensitive(sub) is observed and list(sub.iterdir()) == []
    os.chmod(sub, 0o500)
    try:
        if os.geteuid() != 0:
            assert rs.case_insensitive(sub) is False, "unknown (cannot write) counts as case-sensitive"
    finally:
        os.chmod(sub, 0o700)


def test_same_file_compares_identity_without_following_links(tmp_path):
    a = tmp_path / "a.bin"
    a.write_bytes(b"x")
    os.link(a, tmp_path / "hard.bin")
    (tmp_path / "other.bin").write_bytes(b"x")
    os.symlink(a, tmp_path / "link.bin")
    assert rs.same_file(a, tmp_path / "hard.bin")
    assert not rs.same_file(a, tmp_path / "other.bin"), "equal bytes are not the same file"
    assert not rs.same_file(a, tmp_path / "link.bin"), "a link is not its target"
    assert not rs.same_file(a, tmp_path / "missing.bin")


def case_sensitive_file_system(directory: Path) -> bool:
    (directory / "case-probe").write_text("")
    return not (directory / "CASE-PROBE").exists()


def test_a_different_file_whose_name_only_folds_to_a_recorded_one_is_never_skipped(tmp_path, monkeypatch, capsys):
    if not case_sensitive_file_system(tmp_path):
        pytest.skip("needs a case-sensitive file system (as on Linux)")
    repo = make_repo(tmp_path)
    sh("git", "config", "core.ignorecase", "true", cwd=repo)  # e.g. carried over from a macOS checkout
    run = repo / "artifacts" / "runs" / "r1"
    run.mkdir()
    (run / "result.bin").write_bytes(blob(THRESHOLD, 65))
    assert run_main(["stow", str(run)], repo, monkeypatch) == rs.EXIT_OK
    commit_records(repo)
    (run / "RESULT.bin").write_bytes(blob(THRESHOLD, 66))  # a new, different output
    assert sh("git", "check-ignore", "-q", "artifacts/runs/r1/RESULT.bin", cwd=repo, check=False).returncode == 0, \
        "git folds case here, so the managed block hides the new file"
    capsys.readouterr()
    assert run_main(["check", "--strict", "--json"], repo, monkeypatch) == rs.EXIT_FINDINGS
    doc = json.loads(capsys.readouterr().out)
    assert [r["path"] for r in doc["ignored_unstowed"]] == ["artifacts/runs/r1/RESULT.bin"]
    assert [r["path"] for r in doc["stowed"]] == ["artifacts/runs/r1/result.bin"]
    doc = stow_json(run, repo, monkeypatch, capsys)
    assert [e["path"] for e in doc["stowed"]] == ["RESULT.bin"], "stowed as the new output it is"
    assert {e["path"] for e in json.loads((run / rs.MANIFEST_NAME).read_text())["entries"]} == {
        "result.bin", "RESULT.bin"}
    commit_records(repo)
    assert run_main(["check", "--strict"], repo, monkeypatch) == rs.EXIT_OK


# ------------------------------------------------------- verify / materialize

def test_verify_reports_every_state(tmp_path, monkeypatch, capsys):
    repo = make_repo(tmp_path)
    run = repo / "artifacts" / "runs" / "r1"
    run.mkdir()
    for name, seed in (("ok.bin", 40), ("gone.bin", 41), ("lost.bin", 42), ("bad.bin", 43), ("nostore.bin", 44)):
        (run / name).write_bytes(blob(THRESHOLD, seed))
    assert run_main(["stow", str(run)], repo, monkeypatch) == rs.EXIT_OK
    capsys.readouterr()
    assert run_main(["verify", str(run)], repo, monkeypatch) == rs.EXIT_OK
    (run / "gone.bin").unlink()
    lost_sha = rs.sha256_file(run / "lost.bin")
    (run / "lost.bin").unlink()
    rs.store_path(store_of(repo), lost_sha).unlink()
    rs.store_path(store_of(repo), rs.sha256_file(run / "nostore.bin")).unlink()
    (run / "bad.bin").unlink()
    (run / "bad.bin").write_bytes(blob(THRESHOLD, 99))
    capsys.readouterr()
    assert run_main(["verify", str(run), "--json"], repo, monkeypatch) == rs.EXIT_FINDINGS
    statuses = {e["path"]: e["status"] for e in json.loads(capsys.readouterr().out)["entries"]}
    assert statuses == {"ok.bin": "ok", "gone.bin": "in_store_only", "lost.bin": "missing",
                        "bad.bin": "mismatch", "nostore.bin": "ok_in_place_only"}


def test_verify_reports_an_ancestor_replaced_by_a_file_and_continues(tmp_path, monkeypatch, capsys):
    repo = make_repo(tmp_path)
    run = repo / "artifacts" / "runs" / "r1"
    (run / "sub").mkdir(parents=True)
    (run / "sub" / "out.bin").write_bytes(blob(THRESHOLD, 77))
    (run / "ok.bin").write_bytes(blob(THRESHOLD, 78))
    assert run_main(["stow", str(run)], repo, monkeypatch) == rs.EXIT_OK
    shutil.rmtree(run / "sub")
    (run / "sub").write_text("now a file")
    capsys.readouterr()
    assert run_main(["verify", str(run), "--json"], repo, monkeypatch) == rs.EXIT_FINDINGS
    assert {e["path"]: e["status"] for e in json.loads(capsys.readouterr().out)["entries"]} == {
        "ok.bin": "ok", "sub/out.bin": "mismatch"}


def test_materialize_reports_a_broken_entry_and_restores_the_rest(tmp_path, monkeypatch, capsys):
    repo = make_repo(tmp_path)
    run = repo / "artifacts" / "runs" / "r1"
    (run / "a").mkdir(parents=True)
    (run / "a" / "out.bin").write_bytes(blob(THRESHOLD, 79))
    (run / "z.bin").write_bytes(blob(THRESHOLD, 80))
    assert run_main(["stow", str(run)], repo, monkeypatch) == rs.EXIT_OK
    shutil.rmtree(run / "a")
    (run / "a").write_text("now a file")  # sorts before z.bin
    (run / "z.bin").unlink()
    capsys.readouterr()
    assert run_main(["materialize", str(run), "--json"], repo, monkeypatch) == rs.EXIT_FINDINGS
    doc = json.loads(capsys.readouterr().out)
    assert [d["path"] for d in doc["restored"]] == ["z.bin"] and (run / "z.bin").exists()
    assert [p["path"] for p in doc["unavailable"]] == ["a/out.bin"]


@pytest.mark.skipif(os.geteuid() == 0, reason="root reads unreadable files")
def test_materialize_continues_past_an_unreadable_occupied_entry(tmp_path, monkeypatch, capsys):
    repo = make_repo(tmp_path)
    run = repo / "artifacts" / "runs" / "r1"
    run.mkdir()
    (run / "a.bin").write_bytes(blob(THRESHOLD, 81))
    (run / "z.bin").write_bytes(blob(THRESHOLD, 82))
    assert run_main(["stow", str(run)], repo, monkeypatch) == rs.EXIT_OK
    os.chmod(run / "a.bin", 0)
    (run / "z.bin").unlink()
    try:
        capsys.readouterr()
        assert run_main(["materialize", str(run), "--json"], repo, monkeypatch) == rs.EXIT_FINDINGS
        doc = json.loads(capsys.readouterr().out)
        assert [d["path"] for d in doc["restored"]] == ["z.bin"]
        assert [p["path"] for p in doc["unavailable"]] == ["a.bin"]
    finally:
        os.chmod(run / "a.bin", 0o444)


def test_materialize_in_linked_worktree(tmp_path, monkeypatch, capsys):
    repo = make_repo(tmp_path)
    run = repo / "artifacts" / "runs" / "r1"
    run.mkdir()
    data = blob(THRESHOLD * 2, 50)
    (run / "out.bin").write_bytes(data)
    assert run_main(["stow", str(run)], repo, monkeypatch) == rs.EXIT_OK
    sh("git", "add", "-A", cwd=repo)
    sh("git", "commit", "-q", "-m", "run with manifest", cwd=repo)
    wt = tmp_path / "wt"
    sh("git", "worktree", "add", "-q", "-b", "lane", str(wt), cwd=repo)
    wt_run = wt / "artifacts" / "runs" / "r1"
    assert (wt_run / rs.MANIFEST_NAME).exists() and not (wt_run / "out.bin").exists()
    assert run_main(["verify", str(wt_run)], wt, monkeypatch) == rs.EXIT_OK  # intact in the shared store
    capsys.readouterr()
    assert run_main(["materialize", str(wt_run), "--json"], wt, monkeypatch) == rs.EXIT_OK
    [restored] = json.loads(capsys.readouterr().out)["restored"]
    assert restored["method"] in ("clone", "copy")
    assert (wt_run / "out.bin").read_bytes() == data
    capsys.readouterr()
    assert run_main(["verify", str(wt_run), "--json"], wt, monkeypatch) == rs.EXIT_OK
    assert [e["status"] for e in json.loads(capsys.readouterr().out)["entries"]] == ["ok"]


# ------------------------------------------------------------- worktrees

def _worktree(repo: Path, tmp_path: Path, name: str, *extra) -> Path:
    wt = tmp_path / name
    sh("git", "worktree", "add", "-q", *extra, "-b", name, str(wt), cwd=repo)
    return wt


def _verdicts(capsys) -> dict:
    doc = json.loads(capsys.readouterr().out)
    names = [Path(r["worktree"]).name for r in doc["worktrees"]]
    assert len(names) == len(set(names)), "test worktrees must have distinct names"
    return {Path(r["worktree"]).name: r for r in doc["worktrees"]}


def test_worktree_check_verdicts(tmp_path, monkeypatch, capsys):
    repo = make_repo(tmp_path)
    (repo / ".gitignore").write_text("node_modules/\n*.out\n")
    (repo / "notes.md").write_text("v1\n")
    sh("git", "add", "-A", cwd=repo)
    sh("git", "commit", "-q", "-m", "ignore rules", cwd=repo)

    clean = _worktree(repo, tmp_path, "clean")
    (clean / "node_modules" / "pkg").mkdir(parents=True)
    (clean / "node_modules" / "pkg" / "index.js").write_text("x")

    unique = _worktree(repo, tmp_path, "unique")
    (unique / "result.out").write_text("only here\n")

    outdir = _worktree(repo, tmp_path, "outdir")  # an ignored directory whose name says nothing
    (repo / ".git" / "info").mkdir(exist_ok=True)
    (repo / ".git" / "info" / "exclude").write_text("outputs/\n")
    (outdir / "outputs").mkdir()
    (outdir / "outputs" / "table.txt").write_text("computed only here\n")

    stowed = _worktree(repo, tmp_path, "stowed")
    run = stowed / "artifacts" / "runs" / "r1"
    run.mkdir()
    (run / "big.bin").write_bytes(blob(THRESHOLD, 60))
    assert run_main(["stow", str(run)], stowed, monkeypatch) == rs.EXIT_OK
    sh("git", "add", "-A", cwd=stowed)
    sh("git", "commit", "-q", "-m", "stowed run", cwd=stowed)
    sh("git", "merge", "-q", "--ff-only", "stowed", cwd=repo)

    unmerged = _worktree(repo, tmp_path, "unmerged")
    (unmerged / "new.txt").write_text("x")
    sh("git", "add", "-A", cwd=unmerged)
    sh("git", "commit", "-q", "-m", "not merged", cwd=unmerged)

    dirty = _worktree(repo, tmp_path, "dirty")
    (dirty / "scratch.txt").write_text("untracked\n")

    hidden = _worktree(repo, tmp_path, "hidden")  # edit hidden from `git status`
    (hidden / "notes.md").write_text("edited\n")
    sh("git", "update-index", "--assume-unchanged", "notes.md", cwd=hidden)

    private = _worktree(repo, tmp_path, "private")  # commit kept only by a per-worktree ref
    commit = sh("git", "commit-tree", "-p", "HEAD", "-m", "kept by a private ref",
                sh("git", "rev-parse", "HEAD^{tree}", cwd=private).stdout.strip(), cwd=private).stdout.strip()
    sh("git", "update-ref", "refs/worktree/saved", commit, cwd=private)

    twin = _worktree(repo, tmp_path, "twin")  # main's same-path "copy" is a symlink into the worktree
    (twin / "result.out").write_text("only here\n")
    os.symlink(twin / "result.out", repo / "result.out")

    capsys.readouterr()
    assert run_main(["worktree-check", "--all", "--json"], repo, monkeypatch) == rs.EXIT_FINDINGS
    v = _verdicts(capsys)
    assert v["clean"]["verdict"] == "safe_to_remove"
    assert v["stowed"]["verdict"] == "safe_to_remove"
    assert [r["path"] for r in v["stowed"]["ignored"]["in_store"]] == ["artifacts/runs/r1/big.bin"]
    assert v["unique"]["verdict"] == "keep"
    assert [r["path"] for r in v["unique"]["ignored"]["unique"]] == ["result.out"]
    assert v["unmerged"]["verdict"] == "keep" and v["unmerged"]["merged"] is False
    assert v["dirty"]["verdict"] == "keep" and v["dirty"]["untracked"] == ["scratch.txt"]
    assert v["hidden"]["verdict"] == "keep" and v["hidden"]["tracked_changes"] == ["notes.md"]
    assert v["private"]["verdict"] == "keep" and v["private"]["worktree_private_refs"] == ["refs/worktree/saved"]
    assert v["twin"]["verdict"] == "keep" and [r["path"] for r in v["twin"]["ignored"]["unique"]] == ["result.out"]
    assert all("remove_command" not in r for r in v.values() if r["verdict"] == "keep")
    assert v["outdir"]["verdict"] == "keep"
    assert [r["path"] for r in v["outdir"]["ignored"]["unique"]] == ["outputs/table.txt"]
    assert set(v) == {"clean", "unique", "outdir", "stowed", "unmerged", "dirty", "hidden", "private", "twin"}, \
        "linked worktrees only, never the main checkout"
    assert v["stowed"]["remove_command"] == f"git worktree remove {shlex.quote(str(stowed.resolve()))}"

    entry = rs.store_path(store_of(repo), rs.sha256_file(run / "big.bin"))
    sh(*shlex.split(v["stowed"]["remove_command"]), cwd=repo)
    assert not stowed.exists() and entry.exists(), "the stowed output survives in the shared store"
    assert (unique / "result.out").exists() and clean.exists(), "the check itself removes nothing"


def test_worktree_check_does_not_credit_a_damaged_store_object(tmp_path, monkeypatch, capsys):
    repo = make_repo(tmp_path)
    (repo / ".gitignore").write_text("*.out\n")
    sh("git", "add", "-A", cwd=repo)
    sh("git", "commit", "-q", "-m", "ignore", cwd=repo)
    wt = _worktree(repo, tmp_path, "lane")
    data = blob(THRESHOLD, 61)
    (wt / "only-good-copy.out").write_bytes(data)
    sha = rs.hashlib.sha256(data).hexdigest()
    obj = rs.store_path(store_of(repo), sha)
    obj.parent.mkdir(parents=True)
    obj.write_bytes(blob(THRESHOLD, 62))  # right name, wrong bytes
    capsys.readouterr()
    assert run_main(["worktree-check", str(wt), "--json"], repo, monkeypatch) == rs.EXIT_FINDINGS
    v = _verdicts(capsys)
    assert v["lane"]["verdict"] == "keep"
    assert [r["path"] for r in v["lane"]["ignored"]["unique"]] == ["only-good-copy.out"]


def test_worktree_check_refuses_a_store_configured_inside_a_worktree(tmp_path, monkeypatch, capsys):
    repo = make_repo(tmp_path)
    wt = _worktree(repo, tmp_path, "lane")
    policy = {"schema": rs.POLICY_SCHEMA, "bulk_threshold_bytes": THRESHOLD, "store_root": str(wt / "store")}
    (repo / ".nullius" / "storage_policy.json").write_text(json.dumps(policy))
    (wt / ".nullius" / "storage_policy.json").write_text(json.dumps(policy))  # each checkout reads its own
    capsys.readouterr()
    assert run_main(["worktree-check", str(wt), "--json"], repo, monkeypatch) == rs.EXIT_ERROR
    assert "lies inside" in capsys.readouterr().err


@pytest.mark.parametrize("written_in", ["checked_worktree_only", "main_checkout_only"])
def test_worktree_check_reads_the_policy_of_the_worktree_it_checks(tmp_path, monkeypatch, capsys, written_in):
    repo = make_repo(tmp_path)
    wt = _worktree(repo, tmp_path, "lane")
    policy = {"schema": rs.POLICY_SCHEMA, "bulk_threshold_bytes": THRESHOLD, "store_root": str(wt / "store")}
    (repo if written_in == "main_checkout_only" else wt).joinpath(".nullius", "storage_policy.json").write_text(
        json.dumps(policy))
    capsys.readouterr()
    rc = run_main(["worktree-check", str(wt), "--json"], repo, monkeypatch)
    if written_in == "checked_worktree_only":
        assert rc == rs.EXIT_ERROR and "lies inside" in json.loads(capsys.readouterr().out)["error"]
    else:  # the worktree's own (default) policy applies; the main checkout's copy is not read for it
        assert rc == rs.EXIT_OK and _verdicts(capsys)["lane"]["verdict"] == "safe_to_remove"


def test_worktree_check_keeps_hidden_mode_and_type_changes_and_submodules(tmp_path, monkeypatch, capsys):
    repo = make_repo(tmp_path)
    (repo / "tool.sh").write_text("echo hi\n")
    os.symlink("README.md", repo / "link")
    sh("git", "add", "-A", cwd=repo)
    sh("git", "commit", "-q", "-m", "files", cwd=repo)
    mode = _worktree(repo, tmp_path, "mode")
    os.chmod(mode / "tool.sh", 0o755)  # same bytes, new executable bit
    sh("git", "update-index", "--assume-unchanged", "tool.sh", cwd=mode)
    kind = _worktree(repo, tmp_path, "kind")
    (kind / "link").unlink()
    (kind / "link").write_text("README.md")  # same bytes as the link target string, now a regular file
    sh("git", "update-index", "--skip-worktree", "link", cwd=kind)
    sub_src = tmp_path / "sub-src"
    sub_src.mkdir()
    sh("git", "init", "-q", cwd=sub_src)
    (sub_src / "f").write_text("x\n")
    sh("git", "add", "-A", cwd=sub_src)
    sh("git", "commit", "-q", "-m", "sub", cwd=sub_src)
    subm = _worktree(repo, tmp_path, "subm")
    sh("git", "-c", "protocol.file.allow=always", "submodule", "add", "-q", str(sub_src), "dep", cwd=subm)
    sh("git", "commit", "-q", "-m", "add submodule", cwd=subm)
    sh("git", "merge", "-q", "--ff-only", "subm", cwd=repo)
    capsys.readouterr()
    run_main(["worktree-check", "--all", "--json"], repo, monkeypatch)
    v = _verdicts(capsys)
    assert v["mode"]["verdict"] == "keep" and v["mode"]["tracked_changes"] == ["tool.sh"]
    assert v["kind"]["verdict"] == "keep" and v["kind"]["tracked_changes"] == ["link"]
    assert v["subm"]["verdict"] == "keep" and any("submodules" in r for r in v["subm"]["reasons"])


@pytest.mark.parametrize("hidden", [False, True])
def test_worktree_check_keeps_a_changed_executable_bit_even_when_core_filemode_is_off(tmp_path, monkeypatch,
                                                                                        capsys, hidden):
    """With core.filemode off, git records no mode change and `git status` shows none; removing the
    worktree would lose the bit all the same. A worktree with the setting but no such change stays safe."""
    repo = make_repo(tmp_path)
    (repo / "tool.sh").write_text("echo hi\n")
    sh("git", "add", "-A", cwd=repo)
    sh("git", "commit", "-q", "-m", "files", cwd=repo)
    changed = _worktree(repo, tmp_path, "changed")
    sh("git", "config", "core.filemode", "false", cwd=changed)
    os.chmod(changed / "tool.sh", 0o755)  # same bytes, new executable bit
    if hidden:
        sh("git", "update-index", "--assume-unchanged", "tool.sh", cwd=changed)
    assert sh("git", "status", "--porcelain", cwd=changed).stdout == "", "control: git itself shows nothing"
    plain = _worktree(repo, tmp_path, "plain")
    sh("git", "config", "core.filemode", "false", cwd=plain)
    capsys.readouterr()
    run_main(["worktree-check", "--all", "--json"], repo, monkeypatch)
    v = _verdicts(capsys)
    assert v["changed"]["verdict"] == "keep" and v["changed"]["tracked_changes"] == ["tool.sh"]
    assert v["plain"]["verdict"] == "safe_to_remove", "control: the setting alone keeps nothing"


def test_hidden_change_check_handles_line_breaks_in_names(tmp_path, monkeypatch, capsys):
    repo = make_repo(tmp_path)
    (repo / "x\ny").write_text("same\n")
    (repo / "x").write_text("same\n")  # a naive newline-split would hash this file instead
    (repo / "y").write_text("other\n")
    sh("git", "add", "-A", cwd=repo)
    sh("git", "commit", "-q", "-m", "names", cwd=repo)
    wt = _worktree(repo, tmp_path, "lane")
    with open(wt / "x\ny", "a") as fh:
        fh.write("PRECIOUS EDIT\n")
    subprocess.run(["git", "update-index", "--assume-unchanged", "-z", "--stdin"], cwd=wt, input=b"x\ny\0", check=True)
    capsys.readouterr()
    assert run_main(["worktree-check", str(wt), "--json"], repo, monkeypatch) == rs.EXIT_FINDINGS
    assert _verdicts(capsys)["lane"]["tracked_changes"] == ["x\ny"]


@pytest.mark.skipif(os.geteuid() == 0, reason="root reads unreadable files")
def test_worktree_check_all_survives_an_unreadable_file(tmp_path, monkeypatch, capsys):
    repo = make_repo(tmp_path)
    (repo / ".gitignore").write_text("*.log\n")
    sh("git", "add", "-A", cwd=repo)
    sh("git", "commit", "-q", "-m", "ignore", cwd=repo)
    a = _worktree(repo, tmp_path, "a")
    _worktree(repo, tmp_path, "b")
    (a / "x.log").write_text("s")
    os.chmod(a / "x.log", 0)
    try:
        capsys.readouterr()
        run_main(["worktree-check", "--all", "--json"], repo, monkeypatch)
        v = _verdicts(capsys)
        assert v["a"]["verdict"] == "keep" and v["b"]["verdict"] == "safe_to_remove"
    finally:
        os.chmod(a / "x.log", 0o644)


def test_worktree_check_treats_pathspec_magic_names_literally(tmp_path, monkeypatch, capsys):
    repo = make_repo(tmp_path)
    (repo / ":(glob)a").write_text("v1\n")  # read as magic, this names the file "a", not itself
    (repo / "a").write_text("plain\n")
    sh("git", "add", "--", ":(literal):(glob)a", "a", cwd=repo)
    sh("git", "commit", "-q", "-m", "odd name", cwd=repo)
    wt = _worktree(repo, tmp_path, "lane")
    (wt / ":(glob)a").write_text("hidden edit\n")
    subprocess.run(["git", "update-index", "--assume-unchanged", "-z", "--stdin"], cwd=wt,
                   input=b":(glob)a\0", check=True)
    capsys.readouterr()
    assert run_main(["worktree-check", str(wt), "--json"], repo, monkeypatch) == rs.EXIT_FINDINGS
    assert _verdicts(capsys)["lane"]["tracked_changes"] == [":(glob)a"]


def test_worktree_check_keeps_commits_only_the_worktree_reflog_remembers(tmp_path, monkeypatch, capsys):
    repo = make_repo(tmp_path)
    wt = tmp_path / "detached"
    sh("git", "worktree", "add", "-q", "--detach", str(wt), "main", cwd=repo)
    (wt / "work.txt").write_text("committed, then reset away\n")
    sh("git", "add", "-A", cwd=wt)
    sh("git", "commit", "-q", "-m", "only in the reflog", cwd=wt)
    lost = sh("git", "rev-parse", "HEAD", cwd=wt).stdout.strip()
    sh("git", "reset", "-q", "--hard", "main", cwd=wt)  # clean tree, HEAD contained in main
    capsys.readouterr()
    assert run_main(["worktree-check", str(wt), "--json"], repo, monkeypatch) == rs.EXIT_FINDINGS
    v = _verdicts(capsys)["detached"]
    assert v["verdict"] == "keep" and v["reflog_only_commits"] == [lost]
    # a worktree-private ref does not count as a shared ref that would keep the commit alive
    sh("git", "update-ref", "refs/worktree/saved", lost, cwd=wt)
    assert rs.reflog_only_commits(wt) == [lost]


@pytest.mark.parametrize("damage", ["corrupt", "unreadable"])
def test_worktree_check_keeps_a_worktree_whose_reflog_cannot_be_read(tmp_path, monkeypatch, capsys, damage):
    if damage == "unreadable" and os.geteuid() == 0:
        pytest.skip("root reads unreadable files")
    repo = make_repo(tmp_path)
    wt = _worktree(repo, tmp_path, "lane")
    log = Path(sh("git", "rev-parse", "--git-path", "logs/HEAD", cwd=wt).stdout.strip())
    log = log if log.is_absolute() else wt / log
    if damage == "corrupt":
        log.write_text("not a reflog line\n")
    else:
        os.chmod(log, 0)
    try:
        capsys.readouterr()
        assert run_main(["worktree-check", str(wt), "--json"], repo, monkeypatch) == rs.EXIT_FINDINGS
        assert _verdicts(capsys)["lane"]["verdict"] == "keep"
    finally:
        os.chmod(log, 0o644)


def test_worktree_check_understands_only_the_empty_refs_directory_git_itself_creates(tmp_path, monkeypatch, capsys):
    """git creates an empty refs/ in a new worktree's private directory (observed with git 2.50);
    that one directory, while empty, is understood. Any other unknown directory is state this
    check does not assess, even when it is empty: its existence may be the state. refs/ with
    anything inside it, even an empty directory, is state too."""
    repo = make_repo(tmp_path)
    wt = _worktree(repo, tmp_path, "fresh")
    private = repo / ".git" / "worktrees" / "fresh"
    (private / "refs").mkdir(exist_ok=True)
    capsys.readouterr()
    assert run_main(["worktree-check", "--all", "--json"], repo, monkeypatch) == rs.EXIT_OK
    v = _verdicts(capsys)
    assert v["fresh"]["unassessed_git_state"] == [] and v["fresh"]["verdict"] == "safe_to_remove"
    (private / "scratch" / "deeper").mkdir(parents=True)  # unknown and empty: still state
    capsys.readouterr()
    assert run_main(["worktree-check", "--all", "--json"], repo, monkeypatch) == rs.EXIT_FINDINGS
    v = _verdicts(capsys)
    assert v["fresh"]["verdict"] == "keep" and "scratch/" in v["fresh"]["unassessed_git_state"]
    (private / "scratch").rename(private / "gone-scratch")
    (private / "gone-scratch" / "deeper").rmdir()
    (private / "gone-scratch").rmdir()
    (private / "refs" / "heads" / "topic").mkdir(parents=True)  # refs/ with anything inside, even empty, is state
    capsys.readouterr()
    assert run_main(["worktree-check", "--all", "--json"], repo, monkeypatch) == rs.EXIT_FINDINGS
    v = _verdicts(capsys)
    assert v["fresh"]["verdict"] == "keep" and "refs/" in v["fresh"]["unassessed_git_state"]


def test_worktree_check_treats_an_unreadable_private_directory_as_state(tmp_path, monkeypatch, capsys):
    """The one directory the check would exempt, git's own refs/, is exempt only while it is seen to
    hold nothing; when it cannot be read it may hold anything, so it is state, not empty."""
    if os.geteuid() == 0:
        pytest.skip("root reads unreadable directories")
    repo = make_repo(tmp_path)
    _worktree(repo, tmp_path, "fresh")
    private = repo / ".git" / "worktrees" / "fresh"
    (private / "refs").mkdir(exist_ok=True)
    (private / "refs").chmod(0)
    try:
        capsys.readouterr()
        assert run_main(["worktree-check", "--all", "--json"], repo, monkeypatch) == rs.EXIT_FINDINGS
        v = _verdicts(capsys)
        assert v["fresh"]["verdict"] == "keep" and "refs/" in v["fresh"]["unassessed_git_state"]
    finally:
        (private / "refs").chmod(0o755)


@pytest.mark.parametrize("state", ["private_ref_reflog", "merge_in_progress", "lock_file", "custom_worktree_config",
                                   "foreign_hooks_path", "private_info_exclude", "cone_sparse_patterns",
                                   "own_sparse_patterns", "locked_by_git_worktree_lock"])
def test_worktree_check_keeps_worktrees_with_unassessed_git_state(tmp_path, monkeypatch, capsys, state):
    repo = make_repo(tmp_path)
    wt = tmp_path / "lane"
    sh("git", "worktree", "add", "-q", "--detach", str(wt), "main", cwd=repo)
    git_dir = Path(sh("git", "rev-parse", "--git-dir", cwd=wt).stdout.strip())
    git_dir = git_dir if git_dir.is_absolute() else wt / git_dir
    if state == "private_ref_reflog":  # the unique commit survives only in the private ref's own log
        tree = sh("git", "rev-parse", "HEAD^{tree}", cwd=wt).stdout.strip()
        unique = sh("git", "commit-tree", "-p", "HEAD", "-m", "unique", tree, cwd=wt).stdout.strip()
        sh("git", "update-ref", "--create-reflog", "refs/worktree/saved", unique, cwd=wt)
        sh("git", "update-ref", "refs/worktree/saved", "main", cwd=wt)
    elif state == "merge_in_progress":
        (git_dir / "MERGE_HEAD").write_text(sh("git", "rev-parse", "HEAD", cwd=wt).stdout)
    elif state == "lock_file":
        (git_dir / "locked").write_text("kept on purpose\n")
    elif state == "custom_worktree_config":
        sh("git", "config", "extensions.worktreeConfig", "true", cwd=repo)
        sh("git", "config", "--worktree", "notes.displayRef", "refs/notes/lane-only", cwd=wt)
    elif state == "private_info_exclude":  # user ignore rules kept only in this worktree's git directory
        (git_dir / "info").mkdir(exist_ok=True)
        (git_dir / "info" / "exclude").write_text("lane-scratch/\n")
    elif state == "cone_sparse_patterns":  # sparse rules other than the documented form
        (wt / "docs").mkdir()
        (wt / "docs" / "a.md").write_text("a\n")
        sh("git", "add", "-A", cwd=wt)
        sh("git", "commit", "-q", "-m", "docs", cwd=wt)
        sh("git", "update-ref", "refs/heads/main", "HEAD", cwd=wt)
        sh("git", "sparse-checkout", "set", "--cone", "docs", cwd=wt)
    elif state == "locked_by_git_worktree_lock":  # marked to be kept; git also refuses to remove it
        sh("git", "worktree", "lock", "--reason", "on a removable disk", str(wt), cwd=repo)
    elif state == "own_sparse_patterns":
        subprocess.run(["git", "sparse-checkout", "set", "--no-cone", "--stdin"], cwd=wt, check=True,
                       input=b"/*\n!/README.md\n/README.md\n")
    else:  # a hooks path that is not the repository's own hooks directory
        sh("git", "config", "extensions.worktreeConfig", "true", cwd=repo)
        sh("git", "config", "--worktree", "core.hooksPath", str(tmp_path / "lane-hooks"), cwd=wt)
    capsys.readouterr()
    assert run_main(["worktree-check", str(wt), "--json"], repo, monkeypatch) == rs.EXIT_FINDINGS
    v = _verdicts(capsys)["lane"]
    assert v["verdict"] == "keep" and v["unassessed_git_state"]


def test_worktree_check_keeps_an_annotated_tag_held_only_by_fetch_head(tmp_path, monkeypatch, capsys):
    repo = make_repo(tmp_path)
    other = tmp_path / "other"
    sh("git", "clone", "-q", str(repo), str(other), cwd=tmp_path)
    (other / "x.txt").write_text("exists only behind the fetched tag\n")
    sh("git", "add", "-A", cwd=other)
    sh("git", "commit", "-q", "-m", "tagged only", cwd=other)
    sh("git", "tag", "-a", "-m", "t", "v-fetched", cwd=other)
    wt = tmp_path / "lane"
    sh("git", "worktree", "add", "-q", "--detach", str(wt), "main", cwd=repo)
    sh("git", "fetch", "-q", str(other), "refs/tags/v-fetched", cwd=wt)  # no destination: only FETCH_HEAD names it
    tag = sh("git", "rev-parse", "v-fetched", cwd=other).stdout.strip()  # the annotated tag object
    capsys.readouterr()
    assert run_main(["worktree-check", str(wt), "--json"], repo, monkeypatch) == rs.EXIT_FINDINGS
    v = _verdicts(capsys)["lane"]
    assert v["verdict"] == "keep" and tag in v["reflog_only_commits"]


def test_worktree_check_keeps_a_commit_that_only_orig_head_remembers(tmp_path, monkeypatch, capsys):
    repo = make_repo(tmp_path)
    wt = tmp_path / "lane"
    sh("git", "worktree", "add", "-q", "--detach", str(wt), "main", cwd=repo)
    (wt / "only-here.txt").write_text("a change no ref holds\n")
    sh("git", "add", "-A", cwd=wt)
    sh("git", "commit", "-q", "-m", "unique", cwd=wt)
    unique = sh("git", "rev-parse", "HEAD", cwd=wt).stdout.strip()
    sh("git", "reset", "-q", "--hard", "main", cwd=wt)  # ORIG_HEAD now names the unique commit
    sh("git", "reflog", "expire", "--expire=now", "--all", cwd=wt)
    git_dir = Path(sh("git", "rev-parse", "--git-dir", cwd=wt).stdout.strip())
    assert unique not in (git_dir / "logs" / "HEAD").read_text() and (git_dir / "ORIG_HEAD").read_text().strip() == unique
    capsys.readouterr()
    assert run_main(["worktree-check", str(wt), "--json"], repo, monkeypatch) == rs.EXIT_FINDINGS
    v = _verdicts(capsys)["lane"]
    assert v["verdict"] == "keep" and unique in v["reflog_only_commits"]


def test_worktree_check_all_reports_a_worktree_with_a_broken_private_ref_and_goes_on(tmp_path, monkeypatch, capsys):
    repo = make_repo(tmp_path)
    good = _worktree(repo, tmp_path, "good")
    bad = _worktree(repo, tmp_path, "bad")
    git_dir = Path(sh("git", "rev-parse", "--git-dir", cwd=bad).stdout.strip())
    (git_dir / "refs" / "worktree").mkdir(parents=True)
    (git_dir / "refs" / "worktree" / "saved").write_text("not an object name\n")
    capsys.readouterr()
    assert run_main(["worktree-check", "--all", "--json"], repo, monkeypatch) == rs.EXIT_FINDINGS
    v = _verdicts(capsys)
    assert v["good"]["verdict"] == "safe_to_remove"
    assert v["bad"]["verdict"] == "keep" and "remove_command" not in v["bad"]


def test_worktree_check_judges_against_the_named_base_and_needs_one(tmp_path, monkeypatch, capsys):
    repo = make_repo(tmp_path)
    sh("git", "branch", "devel", cwd=repo)
    wt = tmp_path / "lane"
    sh("git", "worktree", "add", "-q", "-b", "lane", str(wt), "devel", cwd=repo)
    (wt / "f.txt").write_text("merged into devel only\n")
    sh("git", "add", "-A", cwd=wt)
    sh("git", "commit", "-q", "-m", "lane work", cwd=wt)
    sh("git", "branch", "-f", "devel", "lane", cwd=repo)
    capsys.readouterr()
    assert run_main(["worktree-check", str(wt), "--json"], repo, monkeypatch) == rs.EXIT_FINDINGS
    assert _verdicts(capsys)["lane"]["merged"] is False
    assert run_main(["worktree-check", str(wt), "--base", "devel", "--json"], repo, monkeypatch) == rs.EXIT_OK
    assert _verdicts(capsys)["lane"]["verdict"] == "safe_to_remove"
    sh("git", "branch", "-m", "main", "trunk", cwd=repo)  # neither main nor master any more
    assert run_main(["worktree-check", str(wt), "--json"], repo, monkeypatch) == rs.EXIT_ERROR
    assert "pass --base" in json.loads(capsys.readouterr().out)["error"]


def test_worktree_private_refs_with_a_broken_ref_are_an_error(tmp_path):
    repo = make_repo(tmp_path)
    wt = _worktree(repo, tmp_path, "lane")
    git_dir = Path(sh("git", "rev-parse", "--git-dir", cwd=wt).stdout.strip())
    git_dir = git_dir if git_dir.is_absolute() else wt / git_dir
    (git_dir / "refs" / "worktree").mkdir(parents=True)
    (git_dir / "refs" / "worktree" / "broken").write_text("not an object id\n")
    with pytest.raises(rs.StorageError):
        rs.worktree_private_refs(wt, "main")


def test_worktree_check_all_survives_a_broken_worktree(tmp_path, monkeypatch, capsys):
    repo = make_repo(tmp_path)
    good = _worktree(repo, tmp_path, "good")
    broken = _worktree(repo, tmp_path, "broken")
    sh("git", "update-ref", "-d", "refs/heads/broken", cwd=repo)  # its HEAD now names a missing branch
    capsys.readouterr()
    run_main(["worktree-check", "--all", "--json"], repo, monkeypatch)
    v = _verdicts(capsys)
    assert v["good"]["verdict"] == "safe_to_remove"
    assert v["broken"]["verdict"] == "keep" and good.exists() and broken.exists()


def test_worktree_check_all_without_linked_worktrees_checks_nothing(tmp_path, monkeypatch, capsys):
    repo = make_repo(tmp_path)
    capsys.readouterr()
    assert run_main(["worktree-check", "--all", "--json"], repo, monkeypatch) == rs.EXIT_OK
    assert json.loads(capsys.readouterr().out)["worktrees"] == []
    assert run_main(["worktree-check", str(repo), "--json"], repo, monkeypatch) == rs.EXIT_FINDINGS
    main_verdict = _verdicts(capsys)[repo.name]
    assert main_verdict["verdict"] == "keep", "the main checkout itself is never removable"
    assert main_verdict["reasons"][0].startswith("not a linked worktree: a main checkout")


def test_worktree_check_needs_exactly_one_of_a_path_or_all(tmp_path, monkeypatch, capsys):
    repo = make_repo(tmp_path)
    wt = _worktree(repo, tmp_path, "lane")
    capsys.readouterr()
    assert run_main(["worktree-check", "--json"], repo, monkeypatch) == rs.EXIT_ERROR
    assert "pass --all" in json.loads(capsys.readouterr().out)["error"]
    assert run_main(["worktree-check", str(wt), "--all", "--json"], repo, monkeypatch) == rs.EXIT_ERROR
    assert "not both" in json.loads(capsys.readouterr().out)["error"]


def test_report_refuses_a_negative_or_infinite_age(tmp_path, monkeypatch, capsys):
    for bad in ("-1", "inf", "nan"):
        with pytest.raises(SystemExit) as exit_info:
            run_main(["report", str(tmp_path), "--older-than-days", bad], tmp_path, monkeypatch)
        assert exit_info.value.code == 2
    assert "must be a finite number" in capsys.readouterr().err


def test_worktree_check_accepts_settings_that_hold_no_data(tmp_path, monkeypatch, capsys):
    repo = make_repo(tmp_path)
    sh("git", "config", "extensions.worktreeConfig", "true", cwd=repo)
    app = _worktree(repo, tmp_path, "app-made")  # what agent desktop apps write into a new worktree
    common = Path(sh("git", "rev-parse", "--git-common-dir", cwd=repo).stdout.strip())
    common = common if common.is_absolute() else repo / common
    sh("git", "config", "--worktree", "core.longpaths", "true", cwd=app)
    sh("git", "config", "--worktree", "core.hooksPath", str(common.resolve() / "hooks"), cwd=app)
    sh("git", "config", "--worktree", "core.bare", "false", cwd=app)  # what a bare repository's worktrees carry
    sparse = _worktree(repo, tmp_path, "sparse")  # which tracked files are checked out: configuration only
    subprocess.run(["git", "sparse-checkout", "set", "--no-cone", "--stdin"], cwd=sparse, check=True,
                   input=b"/*\n!/README.md\n")
    assert not (sparse / "README.md").exists()
    capsys.readouterr()
    assert run_main(["worktree-check", "--all", "--json"], repo, monkeypatch) == rs.EXIT_OK
    v = _verdicts(capsys)
    assert v["app-made"]["verdict"] == "safe_to_remove" and v["app-made"]["unassessed_git_state"] == []
    assert v["sparse"]["verdict"] == "safe_to_remove"


@pytest.mark.parametrize("key,value", [("core.hooksPath", "elsewhere"), ("core.longpaths", "/a/path")])
def test_worktree_check_keeps_settings_it_does_not_recognize(tmp_path, monkeypatch, capsys, key, value):
    repo = make_repo(tmp_path)
    sh("git", "config", "extensions.worktreeConfig", "true", cwd=repo)
    wt = _worktree(repo, tmp_path, "lane")
    if value == "elsewhere":  # a hooks directory other than the repository's own
        (tmp_path / "other-hooks").mkdir()
        value = str(tmp_path / "other-hooks")
    sh("git", "config", "--worktree", key, value, cwd=wt)
    capsys.readouterr()
    assert run_main(["worktree-check", str(wt), "--json"], repo, monkeypatch) == rs.EXIT_FINDINGS
    v = _verdicts(capsys)["lane"]
    assert v["verdict"] == "keep" and any(u.startswith("config.worktree") for u in v["unassessed_git_state"])


def test_worktree_check_keeps_a_copied_checkout_and_asks_git_nothing_about_it(tmp_path, monkeypatch, capsys):
    # A copy's .git file still names the original's worktree record: git would answer about the original.
    repo = make_repo(tmp_path)
    lane = _worktree(repo, tmp_path, "lane")
    copy = tmp_path / "copy-of-lane"
    shutil.copytree(lane, copy, symlinks=True)
    record = Path(sh("git", "rev-parse", "--git-dir", cwd=lane).stdout.strip())
    index_before = (record / "index").stat().st_mtime_ns
    capsys.readouterr()
    assert run_main(["worktree-check", str(copy), "--json"], repo, monkeypatch) == rs.EXIT_FINDINGS
    v = _verdicts(capsys)["copy-of-lane"]
    assert v["verdict"] == "keep" and "remove_command" not in v
    assert v["record_owner"] == str((lane / ".git").resolve()) and "a copy or an orphan" in v["reasons"][0]
    assert (record / "index").stat().st_mtime_ns == index_before
    assert run_main(["worktree-check", str(lane), "--json"], repo, monkeypatch) == rs.EXIT_OK
    assert _verdicts(capsys)["lane"]["verdict"] == "safe_to_remove", "the original itself is judged as usual"


def test_worktree_record_owner_reads_absolute_and_relative_records(tmp_path):
    # git 2.48+ can write the record relative to itself (worktree.useRelativePaths).
    record = tmp_path / "repo" / ".git" / "worktrees" / "w"
    record.mkdir(parents=True)
    (tmp_path / "w").mkdir()
    (tmp_path / "w" / ".git").write_text("gitdir: ../repo/.git/worktrees/w\n")
    (record / "gitdir").write_text("../../../../w/.git\n")
    assert rs.worktree_record_owner(record) == (tmp_path / "w" / ".git").resolve()
    (record / "gitdir").write_text(str(tmp_path / "w" / ".git") + "\n")
    assert rs.worktree_record_owner(record) == (tmp_path / "w" / ".git").resolve()
    (record / "gitdir").write_text("")
    assert rs.worktree_record_owner(record) is None
    (record / "gitdir").unlink()
    assert rs.worktree_record_owner(record) is None


def test_worktree_check_keeps_a_worktree_whose_event_ledger_or_refresh_backups_exist_only_there(tmp_path, monkeypatch,
                                                                                                capsys):
    repo = make_repo(tmp_path)
    (repo / ".gitignore").write_text(".nullius/HARNESS_INVOCATION\n.nullius/ledger.jsonl\n.nullius/backups/\n")
    sh("git", "add", "-A", cwd=repo)
    sh("git", "commit", "-q", "-m", "template ignore rules", cwd=repo)
    trees = {name: _worktree(repo, tmp_path, name) for name in ("anchor-only", "ledger", "backup", "same-ledger")}
    for wt in trees.values():
        (wt / ".nullius" / "HARNESS_INVOCATION").write_text(f"project_root: {wt}\n")  # rewritten on reconnect
    (trees["ledger"] / ".nullius" / "ledger.jsonl").write_text('{"event": "approved", "lane": "ledger"}\n')
    (trees["backup"] / ".nullius" / "backups").mkdir()
    (trees["backup"] / ".nullius" / "backups" / "AGENTS.md").write_text("the user's customized instructions\n")
    (repo / ".nullius" / "ledger.jsonl").write_text('{"event": "initialized"}\n')
    (trees["same-ledger"] / ".nullius" / "ledger.jsonl").write_text('{"event": "initialized"}\n')
    capsys.readouterr()
    assert run_main(["worktree-check", "--all", "--json"], repo, monkeypatch) == rs.EXIT_FINDINGS
    v = _verdicts(capsys)
    assert v["anchor-only"]["verdict"] == "safe_to_remove"
    assert [r["path"] for r in v["anchor-only"]["ignored"]["machine_bookkeeping"]] == [".nullius/HARNESS_INVOCATION"]
    assert v["ledger"]["verdict"] == "keep" and [r["path"] for r in v["ledger"]["ignored"]["unique"]] == [".nullius/ledger.jsonl"]
    assert v["backup"]["verdict"] == "keep"
    assert [r["path"] for r in v["backup"]["ignored"]["unique"]] == [".nullius/backups/AGENTS.md"]
    assert v["same-ledger"]["verdict"] == "safe_to_remove"


def test_worktree_check_compares_ignored_files_with_the_main_checkout_by_content(tmp_path, monkeypatch, capsys):
    repo = make_repo(tmp_path)
    (repo / ".gitignore").write_text("*.out\n")
    sh("git", "add", "-A", cwd=repo)
    sh("git", "commit", "-q", "-m", "ignore rules", cwd=repo)
    same = _worktree(repo, tmp_path, "same")
    other = _worktree(repo, tmp_path, "other")
    (repo / "result.out").write_text("value 1\n")
    (same / "result.out").write_text("value 1\n")
    (other / "result.out").write_text("value 2\n")  # same size, other bytes
    capsys.readouterr()
    assert run_main(["worktree-check", "--all", "--json"], repo, monkeypatch) == rs.EXIT_FINDINGS
    v = _verdicts(capsys)
    assert v["same"]["verdict"] == "safe_to_remove"
    assert [r["path"] for r in v["same"]["ignored"]["same_in_main_checkout"]] == ["result.out"]
    assert v["other"]["verdict"] == "keep" and [r["path"] for r in v["other"]["ignored"]["unique"]] == ["result.out"]


@pytest.mark.parametrize("difference", ["whitespace", "file_mode", "binary_content"])
def test_worktree_check_credits_only_byte_identical_rewritten_patches(tmp_path, monkeypatch, capsys, difference):
    # git cherry's default patch ids ignore whitespace: a reflog-only commit whose patch differs from the
    # base's only in a space, a file mode, or binary bytes is not reconstructible from the base.
    repo = make_repo(tmp_path)
    wt = tmp_path / "lane"
    sh("git", "worktree", "add", "-q", "--detach", str(wt), "main", cwd=repo)
    if difference == "binary_content":
        (wt / "data.bin").write_bytes(b"\0\1lane bytes")
        (repo / "data.bin").write_bytes(b"\0\1base bytes")
    else:
        (wt / "f.txt").write_text("new value\n")
        (repo / "f.txt").write_text("new value\n" if difference == "file_mode" else "newvalue\n")
        if difference == "file_mode":
            os.chmod(wt / "f.txt", 0o755)
    sh("git", "add", "-A", cwd=wt)
    sh("git", "commit", "-q", "-m", "lane version", cwd=wt)
    lane_commit = sh("git", "rev-parse", "HEAD", cwd=wt).stdout.strip()
    sh("git", "add", "-A", cwd=repo)
    sh("git", "commit", "-q", "-m", "base version", cwd=repo)
    sh("git", "reset", "-q", "--hard", "main", cwd=wt)  # the lane version survives only in the reflog
    capsys.readouterr()
    assert run_main(["worktree-check", str(wt), "--json"], repo, monkeypatch) == rs.EXIT_FINDINGS
    v = _verdicts(capsys)["lane"]
    assert v["verdict"] == "keep" and lane_commit in v["reflog_only_commits"]


def test_worktree_check_does_not_credit_a_patch_match_older_than_the_merge_base(tmp_path, monkeypatch, capsys):
    # The base once had this exact patch and reverted it before the lane began: the lane's re-application
    # exists nowhere on the base now.
    repo = make_repo(tmp_path)
    (repo / "f.txt").write_text("a change the base later reverted\n")
    sh("git", "add", "-A", cwd=repo)
    sh("git", "commit", "-q", "-m", "change", cwd=repo)
    sh("git", "revert", "--no-edit", "HEAD", cwd=repo)
    wt = tmp_path / "lane"
    sh("git", "worktree", "add", "-q", "--detach", str(wt), "main", cwd=repo)
    (wt / "f.txt").write_text("a change the base later reverted\n")
    sh("git", "add", "-A", cwd=wt)
    sh("git", "commit", "-q", "-m", "change again", cwd=wt)
    again = sh("git", "rev-parse", "HEAD", cwd=wt).stdout.strip()
    sh("git", "reset", "-q", "--hard", "main", cwd=wt)
    capsys.readouterr()
    assert run_main(["worktree-check", str(wt), "--json"], repo, monkeypatch) == rs.EXIT_FINDINGS
    v = _verdicts(capsys)["lane"]
    assert v["verdict"] == "keep" and again in v["reflog_only_commits"]


def test_worktree_check_keeps_a_private_ref_naming_an_annotated_tag(tmp_path, monkeypatch, capsys):
    repo = make_repo(tmp_path)
    wt = _worktree(repo, tmp_path, "lane")
    head = sh("git", "rev-parse", "HEAD", cwd=wt).stdout.strip()
    tag = subprocess.run(["git", "mktag"], cwd=wt, check=True, capture_output=True, text=True, input=(
        f"object {head}\ntype commit\ntag lane-only\ntagger T <t@example.org> 0 +0000\n\n"
        "kept only by a per-worktree ref\n")).stdout.strip()
    sh("git", "update-ref", "refs/worktree/note", tag, cwd=wt)
    capsys.readouterr()
    assert run_main(["worktree-check", str(wt), "--json"], repo, monkeypatch) == rs.EXIT_FINDINGS
    v = _verdicts(capsys)["lane"]
    assert v["verdict"] == "keep" and v["worktree_private_refs"] == ["refs/worktree/note"]


def test_an_unexpected_ls_files_record_is_an_error_not_a_skipped_file(tmp_path, monkeypatch):
    repo = make_repo(tmp_path)
    real = rs.git_z
    monkeypatch.setattr(rs, "git_z", lambda args, cwd: ["hREADME.md"] if args[:2] == ["ls-files", "-v"] else real(args, cwd))
    with pytest.raises(rs.StorageError, match="unexpected `git ls-files -v` record"):
        rs.hidden_tracked_changes(repo)


def test_worktree_check_does_not_credit_a_merge_between_rewritten_copies(tmp_path, monkeypatch, capsys):
    # git cherry skips merge commits, so a change made in a merge (a conflict resolution, an edit)
    # would pass unseen: a merge in the stretch keeps the worktree.
    repo = make_repo(tmp_path)
    wt = tmp_path / "lane"
    sh("git", "worktree", "add", "-q", "-b", "lane", str(wt), "main", cwd=repo)
    (wt / "one.txt").write_text("first change\n")
    sh("git", "add", "-A", cwd=wt)
    sh("git", "commit", "-q", "-m", "one", cwd=wt)
    first = sh("git", "rev-parse", "HEAD", cwd=wt).stdout.strip()
    sh("git", "switch", "-q", "-c", "side", "main", cwd=wt)
    (wt / "two.txt").write_text("second change\n")
    sh("git", "add", "-A", cwd=wt)
    sh("git", "commit", "-q", "-m", "two", cwd=wt)
    second = sh("git", "rev-parse", "HEAD", cwd=wt).stdout.strip()
    sh("git", "switch", "-q", "lane", cwd=wt)
    sh("git", "merge", "-q", "--no-ff", "--no-commit", "side", cwd=wt)  # neither parent is on main
    (wt / "made-in-the-merge.txt").write_text("exists only in the merge commit\n")
    sh("git", "add", "-A", cwd=wt)
    sh("git", "commit", "-q", "-m", "merge with an edit", cwd=wt)
    merge = sh("git", "rev-parse", "HEAD", cwd=wt).stdout.strip()
    sh("git", "branch", "-q", "-D", "side", cwd=wt)
    for commit in (first, second):  # equal patches on main: git cherry marks both "-"
        sh("git", "cherry-pick", "-x", commit, cwd=repo)
    assert [line[:1] for line in sh("git", "cherry", "main", merge, cwd=repo).stdout.split("\n") if line] == ["-", "-"]
    sh("git", "reset", "-q", "--hard", "main", cwd=wt)  # the merge survives only in this worktree's reflog
    capsys.readouterr()
    assert run_main(["worktree-check", str(wt), "--json"], repo, monkeypatch) == rs.EXIT_FINDINGS
    v = _verdicts(capsys)["lane"]
    assert v["verdict"] == "keep" and merge in v["reflog_only_commits"]


@pytest.mark.parametrize("applied", ["all", "part"])
def test_worktree_check_credits_rewritten_commits_only_when_every_change_is_on_base(tmp_path, monkeypatch, capsys,
                                                                                   applied):
    repo = make_repo(tmp_path)
    wt = tmp_path / "lane"
    sh("git", "worktree", "add", "-q", "--detach", str(wt), "main", cwd=repo)
    (wt / "one.txt").write_text("first change\n")
    sh("git", "add", "-A", cwd=wt)
    sh("git", "commit", "-q", "-m", "one", cwd=wt)
    first = sh("git", "rev-parse", "HEAD", cwd=wt).stdout.strip()
    (wt / "two.txt").write_text("second change\n")
    sh("git", "add", "-A", cwd=wt)
    sh("git", "commit", "-q", "-m", "two", cwd=wt)
    second = sh("git", "rev-parse", "HEAD", cwd=wt).stdout.strip()
    # -x records the origin in the message: an equal patch under another commit id, as a rewrite leaves it
    sh("git", "cherry-pick", "-x", first, cwd=repo)
    if applied == "all":
        sh("git", "cherry-pick", "-x", second, cwd=repo)
    assert sh("git", "merge-base", "--is-ancestor", first, "main", cwd=repo, check=False).returncode == 1
    sh("git", "reset", "-q", "--hard", "main", cwd=wt)  # the originals survive only in this worktree's reflog
    capsys.readouterr()
    rc = run_main(["worktree-check", str(wt), "--json"], repo, monkeypatch)
    v = _verdicts(capsys)["lane"]
    if applied == "all":
        assert rc == rs.EXIT_OK and v["verdict"] == "safe_to_remove"
        assert set(v["rewritten_copies_on_base"]) == {first, second} and v["reflog_only_commits"] == []
    else:  # the second change exists nowhere but here
        assert rc == rs.EXIT_FINDINGS and v["verdict"] == "keep" and second in v["reflog_only_commits"]


def test_worktree_check_does_not_credit_the_same_change_made_at_another_place(tmp_path, monkeypatch, capsys):
    """Two patches that differ only in where their hunks sit (the same textual change applied to
    the first block on base and to the second, identical block in the worktree) change different
    things. git patch-id discards hunk positions and would call them the same patch; the check
    compares the patch text itself, so the worktree's commit is not credited and the worktree is kept."""
    repo = make_repo(tmp_path)
    # Three unchanged lines on each side of the changed one: the hunk bodies (context included)
    # come out identical for both places, and only the @@ positions differ.
    block = "x\nx\nx\nold\ny\ny\ny\n"
    changed = block.replace("old", "new")
    (repo / "blocks.txt").write_text(block * 2)
    sh("git", "add", "-A", cwd=repo)
    sh("git", "commit", "-q", "-m", "two identical blocks", cwd=repo)
    wt = tmp_path / "lane"
    sh("git", "worktree", "add", "-q", "--detach", str(wt), "main", cwd=repo)
    (wt / "blocks.txt").write_text(block + changed)  # the worktree changes the second block
    sh("git", "add", "-A", cwd=wt)
    sh("git", "commit", "-q", "-m", "change the second block", cwd=wt)
    orphan = sh("git", "rev-parse", "HEAD", cwd=wt).stdout.strip()
    (repo / "blocks.txt").write_text(changed + block)  # base changes the first block
    sh("git", "add", "-A", cwd=repo)
    sh("git", "commit", "-q", "-m", "change the first block", cwd=repo)
    sh("git", "reset", "-q", "--hard", "main", cwd=wt)  # the worktree's commit survives only in its reflog
    capsys.readouterr()
    rc = run_main(["worktree-check", str(wt), "--json"], repo, monkeypatch)
    v = _verdicts(capsys)["lane"]
    assert rc == rs.EXIT_FINDINGS and v["verdict"] == "keep"
    assert orphan in v["reflog_only_commits"] and v["rewritten_copies_on_base"] == []


def test_worktree_check_does_not_credit_a_change_made_twice_against_a_base_that_made_it_once(tmp_path, monkeypatch, capsys):
    """Base: P then its inverse. The worktree's orphaned history: P, its inverse, P again. Every
    patch text of the orphaned stretch occurs on base, but the second P has no base commit of its
    own: the stretch ends in a state base never reached. Credit consumes distinct base commits."""
    repo = make_repo(tmp_path)
    (repo / "p.txt").write_text("before\n")
    sh("git", "add", "-A", cwd=repo)
    sh("git", "commit", "-q", "-m", "start", cwd=repo)
    wt = tmp_path / "lane"
    sh("git", "worktree", "add", "-q", "--detach", str(wt), "main", cwd=repo)
    for text, msg in (("after\n", "P"), ("before\n", "inverse"), ("after\n", "P again")):
        (wt / "p.txt").write_text(text)
        sh("git", "add", "-A", cwd=wt)
        sh("git", "commit", "-q", "-m", msg, cwd=wt)
    orphan = sh("git", "rev-parse", "HEAD", cwd=wt).stdout.strip()
    for text, msg in (("after\n", "P on base"), ("before\n", "inverse on base")):
        (repo / "p.txt").write_text(text)
        sh("git", "add", "-A", cwd=repo)
        sh("git", "commit", "-q", "-m", msg, cwd=repo)
    sh("git", "reset", "-q", "--hard", "main", cwd=wt)  # the orphaned stretch survives only in this worktree's reflog
    capsys.readouterr()
    rc = run_main(["worktree-check", str(wt), "--json"], repo, monkeypatch)
    v = _verdicts(capsys)["lane"]
    assert rc == rs.EXIT_FINDINGS and v["verdict"] == "keep"
    # The reflog also remembers the intermediate P and inverse commits; each of those stretches is
    # matched by distinct base commits and is credited. The final commit's stretch needs P twice.
    assert orphan in v["reflog_only_commits"] and orphan not in v["rewritten_copies_on_base"]


# ----------------------------------------------------------------- report

def test_report_counts_reclaimable_bytes(tmp_path, monkeypatch, capsys):
    repo = make_repo(tmp_path)
    scratch = tmp_path / "scratch"
    (scratch / "a").mkdir(parents=True)
    (scratch / "b").mkdir()
    dup = blob(2 * 1024 * 1024, 80)
    (scratch / "a" / "copy.bin").write_bytes(dup)
    (scratch / "b" / "copy.bin").write_bytes(dup)
    os.link(scratch / "a" / "copy.bin", scratch / "a" / "hardlink.bin")  # not a second copy
    (scratch / "a" / "node_modules" / "x").mkdir(parents=True)
    (scratch / "a" / "node_modules" / "x" / "f.js").write_bytes(b"y" * 1000)
    sh("git", "bundle", "create", str(scratch / "contained.bundle"), "main", cwd=repo)
    other = tmp_path / "other"
    sh("git", "clone", "-q", str(repo), str(other), cwd=tmp_path)
    (other / "extra.txt").write_text("not in the reference repo\n")
    sh("git", "add", "-A", cwd=other)
    sh("git", "commit", "-q", "-m", "extra", cwd=other)
    sh("git", "bundle", "create", str(scratch / "extra.bundle"), "HEAD", cwd=other)
    shutil.copytree(other / ".git", scratch / "copy-of-history.git")
    sh("git", "clone", "-q", "--bare", str(repo), str(scratch / "same-history.git"), cwd=tmp_path)
    tagged = scratch / "tag-only-history.git"
    sh("git", "clone", "-q", "--bare", str(repo), str(tagged), cwd=tmp_path)
    tree = sh("git", "rev-parse", "HEAD^{tree}", cwd=tagged).stdout.strip()
    extra = sh("git", "commit-tree", "-p", "HEAD", "-m", "only behind an annotated tag", tree, cwd=tagged).stdout.strip()
    sh("git", "tag", "-a", "-m", "t", "v-only", extra, cwd=tagged)
    # objects that exist in the reference only as dangling (unreferenced) objects do not count
    dangling = scratch / "dangling-history.git"
    sh("git", "clone", "-q", "--bare", str(repo), str(dangling), cwd=tmp_path)
    tree2 = sh("git", "rev-parse", "HEAD^{tree}", cwd=dangling).stdout.strip()
    loose = sh("git", "commit-tree", "-p", "HEAD", "-m", "later dropped in the reference", tree2,
               cwd=dangling).stdout.strip()
    sh("git", "update-ref", "refs/heads/kept-here", loose, cwd=dangling)
    sh("git", "fetch", "-q", str(dangling), "refs/heads/kept-here:refs/heads/tmp-ref", cwd=repo)
    sh("git", "update-ref", "-d", "refs/heads/tmp-ref", cwd=repo)  # object stays, now unreachable
    sh("git", "bundle", "create", str(scratch / "dangling.bundle"), "kept-here", cwd=dangling)
    linked = scratch / "with-linked-worktree"  # a staged blob held only by a linked worktree's own index
    sh("git", "clone", "-q", str(repo), str(linked), cwd=tmp_path)
    sh("git", "worktree", "add", "-q", "-b", "side", str(tmp_path / "linked-wt"), cwd=linked)
    (tmp_path / "linked-wt" / "s.txt").write_text("staged in the linked worktree only\n")
    sh("git", "add", "s.txt", cwd=tmp_path / "linked-wt")
    fetched = scratch / "fetch-head-only"  # a commit named only by the copy's FETCH_HEAD
    sh("git", "clone", "-q", str(repo), str(fetched), cwd=tmp_path)
    sh("git", "fetch", "-q", str(other), "HEAD", cwd=fetched)
    staged = scratch / "staged-only"  # a blob held only by the copy's index
    sh("git", "clone", "-q", str(repo), str(staged), cwd=tmp_path)
    (staged / "s.txt").write_text("staged, never committed\n")
    sh("git", "add", "s.txt", cwd=staged)
    (staged / "s.txt").unlink()
    sh("git", "tag", "-a", "-m", "dropped later", "v-dropped", "main", cwd=repo)
    sh("git", "clone", "-q", "--bare", str(repo), str(scratch / "dropped-tag-history.git"), cwd=tmp_path)
    sh("git", "tag", "-d", "v-dropped", cwd=repo)  # tag object stays in the reference, unreachable
    temp_parent = tmp_path / "temp"
    old_root = temp_parent / "lane-run-1"
    old_root.mkdir(parents=True)
    (old_root / "f").write_bytes(b"z" * 100)
    past = time.time() - 30 * 86400
    os.utime(old_root / "f", (past, past))
    os.utime(old_root, (past, past))
    (temp_parent / "lane-run-2").mkdir()
    capsys.readouterr()
    rc = run_main(["report", str(scratch), str(scratch / "a"), "--repo", str(repo), "--stale-dir", str(temp_parent),
                   "--stale-prefix", "lane-", "--json"], tmp_path, monkeypatch)
    assert rc == rs.EXIT_OK
    doc = json.loads(capsys.readouterr().out)
    assert doc["summary_bytes"]["duplicate_content"] == len(dup)
    assert doc["summary_bytes"]["regenerable_directories"] == os.lstat(
        scratch / "a" / "node_modules" / "x" / "f.js").st_blocks * 512, \
        "overlapping roots are counted once, and a 1000-byte file counts the block it occupies"
    bundles = {Path(b["path"]).name: b["contained_in_reference"] for b in doc["bundles"]}
    assert bundles == {"contained.bundle": True, "extra.bundle": False, "dangling.bundle": False}
    stores = {(Path(g["path"]).parent.name if Path(g["path"]).name == ".git" else Path(g["path"]).name):
              g["contained_in_reference"] for g in doc["git_object_stores"]}  # a plain checkout's store is .git
    assert stores == {"copy-of-history.git": False, "same-history.git": True, "tag-only-history.git": False,
                      "dangling-history.git": False, "dropped-tag-history.git": False,
                      "with-linked-worktree": None, "fetch-head-only": None, "staged-only": False}
    assert doc["summary_bytes"]["compression_estimate"] > 0 and doc["compression"]["sampled_files"] > 0
    assert [Path(s["path"]).name for s in doc["stale"]] == ["lane-run-1"]
    assert (scratch / "b" / "copy.bin").exists(), "report never deletes"


def test_report_does_not_credit_a_copy_whose_refs_git_cannot_all_read(tmp_path, monkeypatch, capsys):
    # git skips a broken ref with only a warning: the objects it named would be missed.
    repo = make_repo(tmp_path)
    scratch = tmp_path / "scratch"
    scratch.mkdir()
    sh("git", "clone", "-q", "--bare", str(repo), str(scratch / "copy.git"), cwd=tmp_path)
    (scratch / "copy.git" / "refs" / "heads" / "broken").write_text("not an object name\n")
    capsys.readouterr()
    assert run_main(["report", str(scratch), "--repo", str(repo), "--json"], tmp_path, monkeypatch) == rs.EXIT_OK
    stores = {Path(g["path"]).name: g["contained_in_reference"] for g in json.loads(capsys.readouterr().out)["git_object_stores"]}
    assert stores == {"copy.git": None}


def test_report_does_not_credit_a_copy_detached_at_a_commit_only_it_holds(tmp_path, monkeypatch, capsys):
    # --all names HEAD too: a detached HEAD at a unique commit counts even after its reflog expired.
    repo = make_repo(tmp_path)
    scratch = tmp_path / "scratch"
    scratch.mkdir()
    copy = scratch / "copy"
    sh("git", "clone", "-q", str(repo), str(copy), cwd=tmp_path)
    sh("git", "commit", "-q", "--amend", "-m", "same tree, a commit only the copy holds", cwd=copy)
    unique = sh("git", "rev-parse", "HEAD", cwd=copy).stdout.strip()
    sh("git", "checkout", "-q", "--detach", unique, cwd=copy)
    sh("git", "branch", "-q", "-f", "main", "origin/main", cwd=copy)
    sh("git", "reflog", "expire", "--expire=now", "--all", cwd=copy)
    assert sh("git", "cat-file", "-t", unique, cwd=repo, check=False).returncode != 0
    capsys.readouterr()
    assert run_main(["report", str(scratch), "--repo", str(repo), "--json"], tmp_path, monkeypatch) == rs.EXIT_OK
    stores = {Path(g["path"]).parent.name: g["contained_in_reference"]
              for g in json.loads(capsys.readouterr().out)["git_object_stores"]}
    assert stores == {"copy": False}


def test_json_output_reports_an_error_that_stops_a_command(tmp_path, monkeypatch, capsys):
    repo = make_repo(tmp_path)
    (tmp_path / "plain-file").write_text("not a directory\n")
    run = repo / "artifacts" / "runs" / "r1"
    run.mkdir()
    (run / "a.bin").write_bytes(blob(THRESHOLD, 149))
    capsys.readouterr()
    assert run_main(["stow", str(run), "--json", "--store", str(tmp_path / "plain-file" / "store")], repo,
                    monkeypatch) == rs.EXIT_ERROR
    out = capsys.readouterr()
    assert "not a directory" in json.loads(out.out)["error"] and "not a directory" in out.err


def test_report_does_not_credit_copies_whose_objects_a_partial_clone_reference_only_promises(tmp_path, monkeypatch,
                                                                                              capsys):
    repo = make_repo(tmp_path)
    (repo / "data.txt").write_text("held only by the full copies\n")
    sh("git", "add", "-A", cwd=repo)
    sh("git", "commit", "-q", "-m", "data", cwd=repo)
    sh("git", "config", "uploadpack.allowFilter", "true", cwd=repo)
    partial = tmp_path / "partial"
    sh("git", "clone", "-q", "--no-local", "--filter=blob:none", "--no-checkout", f"file://{repo}", str(partial),
       cwd=tmp_path)
    blob_id = sh("git", "rev-parse", "HEAD:data.txt", cwd=repo).stdout.strip()
    probe = subprocess.run(["git", "cat-file", "-e", blob_id], cwd=partial, capture_output=True,
                           env=dict(os.environ, GIT_NO_LAZY_FETCH="1"))
    assert probe.returncode != 0, "the reference reaches the blob but does not hold it"
    scratch = tmp_path / "scratch"
    scratch.mkdir()
    sh("git", "clone", "-q", "--bare", "--no-hardlinks", str(repo), str(scratch / "full.git"), cwd=tmp_path)
    sh("git", "bundle", "create", str(scratch / "full.bundle"), "main", cwd=repo)
    capsys.readouterr()
    assert run_main(["report", str(scratch), "--repo", str(partial), "--json"], tmp_path, monkeypatch) == rs.EXIT_OK
    doc = json.loads(capsys.readouterr().out)
    assert [g["contained_in_reference"] for g in doc["git_object_stores"]] == [False]
    assert [b["contained_in_reference"] for b in doc["bundles"]] == [None]  # its contents cannot be listed here
    assert doc["summary_bytes"]["history_copies_contained_in_reference"] == 0
    assert doc["summary_bytes"]["bundles_contained_in_reference"] == 0
    assert run_main(["report", str(scratch), "--repo", str(repo), "--json"], tmp_path, monkeypatch) == rs.EXIT_OK
    doc = json.loads(capsys.readouterr().out)
    assert [g["contained_in_reference"] for g in doc["git_object_stores"]] == [True], "control: a full reference"
    assert [b["contained_in_reference"] for b in doc["bundles"]] == [True]


def test_report_does_not_assess_a_copy_with_submodule_stores(tmp_path, monkeypatch, capsys):
    repo = make_repo(tmp_path)
    scratch = tmp_path / "scratch"
    scratch.mkdir()
    copy = scratch / "copy"
    sh("git", "clone", "-q", str(repo), str(copy), cwd=tmp_path)
    module = copy / ".git" / "modules" / "sub"  # a submodule's own store, with commits nobody else has
    sh("git", "init", "-q", "--bare", str(module), cwd=tmp_path)
    capsys.readouterr()
    assert run_main(["report", str(scratch), "--repo", str(repo), "--json"], tmp_path, monkeypatch) == rs.EXIT_OK
    stores = {Path(g["path"]).parent.name: g["contained_in_reference"]
              for g in json.loads(capsys.readouterr().out)["git_object_stores"]}
    assert stores == {"copy": None}


def test_report_does_not_count_hard_linked_bundles_or_duplicates_as_reclaimable(tmp_path, monkeypatch, capsys):
    repo = make_repo(tmp_path)
    scratch = tmp_path / "scratch"
    (scratch / "a").mkdir(parents=True)
    sh("git", "bundle", "create", str(scratch / "a" / "h.bundle"), "main", cwd=repo)
    os.link(scratch / "a" / "h.bundle", tmp_path / "elsewhere.bundle")  # another link outside the scan
    data = blob(2 * 1024 * 1024, 152)
    (scratch / "a" / "d1.bin").write_bytes(data)
    (scratch / "a" / "d2.bin").write_bytes(data)
    os.link(scratch / "a" / "d2.bin", tmp_path / "d2-elsewhere.bin")
    (scratch / "a" / "d3.bin").write_bytes(data)
    os.link(scratch / "a" / "d3.bin", tmp_path / "d3-elsewhere.bin")
    capsys.readouterr()
    assert run_main(["report", str(scratch), "--repo", str(repo), "--json"], tmp_path, monkeypatch) == rs.EXIT_OK
    doc = json.loads(capsys.readouterr().out)
    assert [(b["contained_in_reference"], b["reclaimable_bytes"]) for b in doc["bundles"]] == [(True, 0)]
    assert doc["summary_bytes"]["bundles_contained_in_reference"] == 0
    assert [(d["copies"], d["reclaimable"]) for d in doc["duplicates"]] == [(3, len(data))], \
        "two copies have other hard links (removing them frees nothing): only the single-linked copy can go"


def test_report_does_not_count_a_duplicate_group_when_a_copy_vanished_after_hashing(tmp_path, monkeypatch, capsys):
    """Two identical copies are hashed; one disappears (or becomes unreadable) before its link
    count is read. The survivor is then the only copy, so nothing in the group is reclaimable."""
    repo = make_repo(tmp_path)
    scratch = tmp_path / "scratch"
    (scratch / "a").mkdir(parents=True)
    data = blob(2 * 1024 * 1024, 153)
    gone, kept = scratch / "a" / "gone.bin", scratch / "a" / "kept.bin"
    gone.write_bytes(data)
    kept.write_bytes(data)
    real_link_count = rs.link_count_if_unchanged

    def vanishing_link_count(path, identity):
        if path == gone:
            gone.unlink(missing_ok=True)  # the copy is gone by the time its links are counted
        return real_link_count(path, identity)

    monkeypatch.setattr(rs, "link_count_if_unchanged", vanishing_link_count)
    capsys.readouterr()
    assert run_main(["report", str(scratch), "--repo", str(repo), "--json"], tmp_path, monkeypatch) == rs.EXIT_OK
    doc = json.loads(capsys.readouterr().out)
    assert doc["duplicates"] == [], \
        "a copy that cannot be examined may already be gone: the group is no known set of duplicates any more"
    assert doc["summary_bytes"]["duplicate_content"] == 0
    assert str(gone) in doc["unreadable"], "a skipped path is listed, not silently dropped"
    assert all(Path(u["path"]).name != "gone.bin" for u in doc.get("unique_large", [])) if "unique_large" in doc else True


def test_report_does_not_count_a_duplicate_group_when_a_copy_was_replaced_after_hashing(tmp_path, monkeypatch, capsys):
    """Two identical copies are hashed; one is atomically replaced by other content of the same size
    before its links are counted. The path no longer names the file that was hashed, so the group
    is not counted and the path is listed."""
    repo = make_repo(tmp_path)
    scratch = tmp_path / "scratch"
    (scratch / "a").mkdir(parents=True)
    data = blob(2 * 1024 * 1024, 154)
    other = blob(2 * 1024 * 1024, 155)
    replaced, kept = scratch / "a" / "replaced.bin", scratch / "a" / "kept.bin"
    replaced.write_bytes(data)
    kept.write_bytes(data)
    real_link_count = rs.link_count_if_unchanged

    def replacing_link_count(path, identity):
        if path == replaced:
            new = scratch / "a" / "incoming.bin"
            new.write_bytes(other)
            new.replace(replaced)  # same path, different file and content
        return real_link_count(path, identity)

    monkeypatch.setattr(rs, "link_count_if_unchanged", replacing_link_count)
    capsys.readouterr()
    assert run_main(["report", str(scratch), "--repo", str(repo), "--json"], tmp_path, monkeypatch) == rs.EXIT_OK
    doc = json.loads(capsys.readouterr().out)
    assert doc["duplicates"] == [], "a copy replaced after hashing is no duplicate any more: the group is not reported as one"
    assert doc["summary_bytes"]["duplicate_content"] == 0
    assert str(replaced) in doc["changed_since_scan"] and str(replaced) not in doc["unreadable"]


def test_report_counts_what_a_sparse_file_occupies_not_its_length(tmp_path, monkeypatch, capsys):
    """Two identical sparse copies: 8 MiB long, a few blocks allocated. Removing one frees what it
    occupies, not its length; the report must not promise megabytes that were never written."""
    repo = make_repo(tmp_path)
    scratch = tmp_path / "scratch"
    (scratch / "a").mkdir(parents=True)
    length = 8 * 1024 * 1024
    for name in ("s1.bin", "s2.bin"):
        with open(scratch / "a" / name, "wb") as f:
            f.write(b"head")
            f.truncate(length)
    allocated = [os.lstat(scratch / "a" / name).st_blocks * 512 for name in ("s1.bin", "s2.bin")]
    if max(allocated) >= length:
        pytest.skip("this file system does not store sparse files sparsely")
    assert 0 < min(allocated), "the written head occupies at least one block"
    capsys.readouterr()
    assert run_main(["report", str(scratch), "--repo", str(repo), "--json"], tmp_path, monkeypatch) == rs.EXIT_OK
    doc = json.loads(capsys.readouterr().out)
    [dup] = doc["duplicates"]
    assert dup["copies"] == 2 and dup["size"] == length, "size is the content length that made them a group"
    assert sorted(dup["occupied"]) == sorted(allocated)
    assert dup["reclaimable"] == max(allocated), "the copy occupying the least stays; the other may go"
    assert doc["summary_bytes"]["duplicate_content"] == dup["reclaimable"]


def test_report_sums_what_each_removable_copy_occupies(tmp_path, monkeypatch, capsys):
    """Three identical copies of unequal occupation: one sparse, one full, one full with another hard
    link. The multi-linked copy stays whatever happens, so both single-linked copies may go, and the
    bytes freed are what those two hold, not three times the smallest."""
    repo = make_repo(tmp_path)
    scratch = tmp_path / "scratch"
    (scratch / "a").mkdir(parents=True)
    length = 8 * 1024 * 1024
    with open(scratch / "a" / "sparse.bin", "wb") as f:
        f.truncate(length)
    full = bytes(length)  # the same content, written out
    (scratch / "a" / "full.bin").write_bytes(full)
    (scratch / "a" / "linked.bin").write_bytes(full)
    os.link(scratch / "a" / "linked.bin", tmp_path / "linked-elsewhere.bin")
    occupied = {name: os.lstat(scratch / "a" / name).st_blocks * 512 for name in ("sparse.bin", "full.bin", "linked.bin")}
    if occupied["sparse.bin"] >= occupied["full.bin"]:
        pytest.skip("this file system does not store sparse files sparsely")
    capsys.readouterr()
    assert run_main(["report", str(scratch), "--repo", str(repo), "--json"], tmp_path, monkeypatch) == rs.EXIT_OK
    doc = json.loads(capsys.readouterr().out)
    [dup] = doc["duplicates"]
    assert dup["copies"] == 3 and dict(zip((Path(p).name for p in dup["paths"]), dup["occupied"])) == occupied
    assert dup["reclaimable"] == occupied["sparse.bin"] + occupied["full.bin"]
    assert doc["summary_bytes"]["duplicate_content"] == dup["reclaimable"]


def test_report_counts_a_bundle_against_a_partial_clone_as_not_assessed_even_with_a_missing_tip(tmp_path, monkeypatch,
                                                                                               capsys):
    repo = make_repo(tmp_path)
    sh("git", "config", "uploadpack.allowFilter", "true", cwd=repo)
    partial = tmp_path / "partial"
    sh("git", "clone", "-q", "--no-local", "--filter=blob:none", "--no-checkout", f"file://{repo}", str(partial),
       cwd=tmp_path)
    (repo / "later.txt").write_text("committed after the partial clone\n")
    sh("git", "add", "-A", cwd=repo)
    sh("git", "commit", "-q", "-m", "later", cwd=repo)
    scratch = tmp_path / "scratch"
    scratch.mkdir()
    sh("git", "bundle", "create", str(scratch / "newer.bundle"), "main", cwd=repo)  # its tip is not in the clone
    capsys.readouterr()
    assert run_main(["report", str(scratch), "--repo", str(partial), "--json"], tmp_path, monkeypatch) == rs.EXIT_OK
    assert [b["contained_in_reference"] for b in json.loads(capsys.readouterr().out)["bundles"]] == [None]


def test_report_skips_a_stale_candidate_that_disappears_while_it_runs(tmp_path, monkeypatch, capsys):
    temp = tmp_path / "temp"
    (temp / "lane-run-1").mkdir(parents=True)
    (tmp_path / "empty").mkdir()
    real_lstat = Path.lstat

    def vanishing(self):
        if self.name == "lane-run-1":
            raise FileNotFoundError(2, "No such file or directory", str(self))
        return real_lstat(self)

    monkeypatch.setattr(Path, "lstat", vanishing)
    capsys.readouterr()
    assert run_main(["report", str(tmp_path / "empty"), "--stale-dir", str(temp), "--json"], tmp_path,
                    monkeypatch) == rs.EXIT_OK
    doc = json.loads(capsys.readouterr().out)
    assert doc["stale"] == [] and str(temp / "lane-run-1") in doc["unreadable"]


def test_report_does_not_count_hard_linked_objects_as_reclaimable(tmp_path, monkeypatch, capsys):
    repo = make_repo(tmp_path)
    incompressible = b"".join(hashlib.sha256(i.to_bytes(4, "big")).digest() for i in range(7000))
    (repo / "data.bin").write_bytes(incompressible)  # about 220 kB, and its git object stays that large
    sh("git", "add", "-A", cwd=repo)
    sh("git", "commit", "-q", "-m", "data", cwd=repo)
    scratch = tmp_path / "scratch"
    scratch.mkdir()
    sh("git", "clone", "-q", "--bare", str(repo), str(scratch / "linked.git"), cwd=tmp_path)  # local: hard links
    sh("git", "clone", "-q", "--bare", "--no-hardlinks", str(repo), str(scratch / "copied.git"), cwd=tmp_path)
    capsys.readouterr()
    assert run_main(["report", str(scratch), "--repo", str(repo), "--json"], tmp_path, monkeypatch) == rs.EXIT_OK
    doc = json.loads(capsys.readouterr().out)
    stores = {Path(g["path"]).name: g for g in doc["git_object_stores"]}
    packs = list((scratch / "linked.git" / "objects").rglob("*"))
    if not any(p.is_file() and p.stat().st_nlink > 1 for p in packs):
        pytest.skip("this file system made git copy instead of hard-linking the local clone")
    assert stores["linked.git"]["contained_in_reference"] and stores["copied.git"]["contained_in_reference"]
    for store in stores.values():  # what containment verified is the objects; the rest is not counted
        assert store["object_bytes"] + store["other_bytes"] == store["bytes"] and store["other_bytes"] > 0
    assert stores["copied.git"]["reclaimable_bytes"] == stores["copied.git"]["object_bytes"]
    assert stores["linked.git"]["object_bytes"] > 200_000 and stores["linked.git"]["reclaimable_bytes"] < 100_000
    assert doc["summary_bytes"]["history_copies_contained_in_reference"] == sum(
        g["reclaimable_bytes"] for g in stores.values())


@pytest.mark.parametrize("why", ["recent_change_in_a_subdirectory", "unreadable_part"])
def test_report_lists_a_root_as_stale_only_when_its_whole_age_is_known(tmp_path, monkeypatch, capsys, why):
    if why == "unreadable_part" and os.geteuid() == 0:
        pytest.skip("root reads unreadable directories")
    temp, empty = tmp_path / "temp", tmp_path / "empty"
    root = temp / "lane-run-1"
    (root / "sub" / "deeper").mkdir(parents=True)
    empty.mkdir()
    (root / "sub" / "kept").write_bytes(b"k" * 10)
    (root / "sub" / "gone").write_bytes(b"g" * 10)
    past = time.time() - 30 * 86400

    def age_everything():
        for p in [root / "sub" / "kept", root / "sub" / "deeper", root / "sub", root]:
            os.utime(p, (past, past))

    def stale_names():
        capsys.readouterr()
        assert run_main(["report", str(empty), "--stale-dir", str(temp), "--json"], tmp_path, monkeypatch) == rs.EXIT_OK
        return [Path(s["path"]).name for s in json.loads(capsys.readouterr().out)["stale"]]

    (root / "sub" / "gone").unlink()
    age_everything()
    assert stale_names() == ["lane-run-1"], "positive control: every part unchanged for 30 days"
    if why == "recent_change_in_a_subdirectory":
        (root / "sub" / "kept").unlink()
        os.utime(root / "sub" / "deeper", (past, past))
        (root / "sub" / "kept").write_bytes(b"k" * 10)
        os.utime(root / "sub" / "kept", (past, past))  # only sub/'s own time is recent now
        os.utime(root, (past, past))
        assert stale_names() == []
    else:
        os.chmod(root / "sub" / "deeper", 0)
        try:
            age_everything()
            assert stale_names() == []
        finally:
            os.chmod(root / "sub" / "deeper", 0o755)


@pytest.mark.skipif(os.geteuid() == 0, reason="root reads unreadable directories")
def test_report_lists_what_it_could_not_read(tmp_path, monkeypatch, capsys):
    scratch = tmp_path / "scratch"
    sealed = scratch / "sealed"
    sealed.mkdir(parents=True)
    (sealed / "f.bin").write_bytes(blob(2 * 1024 * 1024, 81))
    os.chmod(sealed, 0)
    try:
        capsys.readouterr()
        assert run_main(["report", str(scratch), "--json"], tmp_path, monkeypatch) == rs.EXIT_OK
        assert str(sealed) in json.loads(capsys.readouterr().out)["unreadable"]
    finally:
        os.chmod(sealed, 0o755)


# ------------------------------------------------- follow-ups of the core review

def test_many_paths_are_passed_to_git_in_batches(tmp_path, monkeypatch, capsys):
    repo = make_repo(tmp_path)
    run = repo / "artifacts" / "runs" / "r1"
    run.mkdir()
    for i in range(5):
        (run / f"old{i}.bin").write_bytes(blob(THRESHOLD, 100 + i))
    sh("git", "add", "-A", cwd=repo)
    sh("git", "commit", "-q", "-m", "committed bulk", cwd=repo)
    for i in range(3):
        (run / f"new{i}.bin").write_bytes(blob(THRESHOLD, 110 + i))
    sh("git", "add", "-A", cwd=repo)
    capsys.readouterr()
    assert run_main(["check", "--json"], repo, monkeypatch) == rs.EXIT_OK
    whole = json.loads(capsys.readouterr().out)
    calls = []
    real_git = rs.git
    monkeypatch.setattr(rs, "PATHS_PER_CALL", 2)
    monkeypatch.setattr(rs, "git", lambda args, cwd, **kw: (calls.append(args), real_git(args, cwd, **kw))[1])
    assert run_main(["check", "--json", "--staged"], repo, monkeypatch) == rs.EXIT_OK
    assert run_main(["check", "--json"], repo, monkeypatch) == rs.EXIT_OK
    batched = json.loads(capsys.readouterr().out.split("\n}\n", 1)[1])
    assert {k: [r["path"] for r in batched[k]] for k in ("tracked", "pending")} == \
        {k: [r["path"] for r in whole[k]] for k in ("tracked", "pending")}
    paths_per_call = [len(a) - a.index("--") - 1 for a in calls if "--" in a and a[0] in ("ls-files", "ls-tree", "diff")]
    assert paths_per_call and max(paths_per_call) <= 2, "no git call carries more than one batch of paths"


def test_long_path_names_are_also_batched_by_size(monkeypatch):
    monkeypatch.setattr(rs, "PATH_BYTES_PER_CALL", 100)
    names = [f"d/{'x' * 40}{i}" for i in range(5)] + ["d/" + "文" * 30]  # the last name is 92 bytes, 32 characters
    groups = rs.batches(names)
    assert [n for g in groups for n in g] == names
    # The budget is in encoded bytes, not characters: a multibyte name must be sized the way the kernel sees it.
    assert all(sum(len(os.fsencode(n)) + 1 for n in g) <= 100 or len(g) == 1 for g in groups) and len(groups) >= 4
    assert groups[-1] == [names[-1]] or sum(len(os.fsencode(n)) + 1 for n in groups[-1]) <= 100
    assert rs.batches([]) == [[]]


def test_a_subprocess_error_is_reported_as_an_error(tmp_path, monkeypatch, capsys):
    repo = make_repo(tmp_path)

    def broken(*a, **kw):
        raise subprocess.SubprocessError("git could not be run")

    capsys.readouterr()
    monkeypatch.setattr(rs.subprocess, "run", broken)
    assert run_main(["check", "--json"], repo, monkeypatch) == rs.EXIT_ERROR
    out = capsys.readouterr()
    assert json.loads(out.out)["error"] == "git could not be run" and "Traceback" not in out.err


def test_quiet_prints_nothing_when_nothing_needs_attention(tmp_path, monkeypatch, capsys):
    repo = make_repo(tmp_path)
    run = repo / "artifacts" / "runs" / "r1"
    run.mkdir()
    (run / "kept.bin").write_bytes(blob(THRESHOLD, 120))
    sh("git", "add", "-A", cwd=repo)
    sh("git", "commit", "-q", "-m", "committed bulk", cwd=repo)
    capsys.readouterr()
    assert run_main(["check", "--quiet"], repo, monkeypatch) == rs.EXIT_OK
    assert capsys.readouterr().out == "", "committed bulk alone needs no attention"
    (run / "new.bin").write_bytes(blob(THRESHOLD, 121))
    assert run_main(["check", "--quiet"], repo, monkeypatch) == rs.EXIT_OK
    assert "new.bin" in capsys.readouterr().out


def test_quiet_still_prints_notices_and_json_always_prints_the_result(tmp_path, monkeypatch, capsys):
    repo = make_repo(tmp_path)
    run = repo / "artifacts" / "runs" / "r1"
    run.mkdir()
    os.symlink(tmp_path, run / "link")  # a notice, not a finding
    capsys.readouterr()
    assert run_main(["check", "--quiet"], repo, monkeypatch) == rs.EXIT_OK
    assert "is a symbolic link, not followed" in capsys.readouterr().out
    os.unlink(run / "link")
    assert run_main(["check", "--quiet"], repo, monkeypatch) == rs.EXIT_OK
    assert capsys.readouterr().out == ""
    assert run_main(["check", "--quiet", "--json"], repo, monkeypatch) == rs.EXIT_OK
    assert json.loads(capsys.readouterr().out)["mode"] == "working_tree"


def test_limit_caps_the_rows_listed(tmp_path, monkeypatch, capsys):
    repo = make_repo(tmp_path)
    run = repo / "artifacts" / "runs" / "r1"
    run.mkdir()
    for i in range(3):
        (run / f"u{i}.bin").write_bytes(blob(THRESHOLD, 130 + i))
    capsys.readouterr()
    assert run_main(["check", "--limit", "1"], repo, monkeypatch) == rs.EXIT_OK
    out = capsys.readouterr().out
    assert sum(f"u{i}.bin" in out for i in range(3)) == 1 and "... 2 more" in out


def test_an_inherited_literal_pathspec_setting_does_not_break_ignore_checks(tmp_path, monkeypatch, capsys):
    repo = make_repo(tmp_path)
    run = repo / "artifacts" / "runs" / "r1"
    run.mkdir()
    (run / "a.bin").write_bytes(blob(THRESHOLD, 140))
    monkeypatch.setenv("GIT_LITERAL_PATHSPECS", "1")  # exported by the user's shell
    assert run_main(["stow", str(run)], repo, monkeypatch) == rs.EXIT_OK
    assert rs.is_ignored(rs.Repo(repo), run / "a.bin")


def test_a_store_path_through_a_regular_file_is_refused_clearly(tmp_path, monkeypatch, capsys):
    repo = make_repo(tmp_path)
    (tmp_path / "plain-file").write_text("not a directory\n")
    run = repo / "artifacts" / "runs" / "r1"
    run.mkdir()
    (run / "a.bin").write_bytes(blob(THRESHOLD, 141))
    capsys.readouterr()
    assert run_main(["stow", str(run), "--store", str(tmp_path / "plain-file" / "store")], repo, monkeypatch) == rs.EXIT_ERROR
    assert "which is not a directory" in capsys.readouterr().err


def test_a_store_inside_another_repositorys_git_directory_is_accepted(tmp_path, monkeypatch):
    # Not a working tree: no clean, worktree removal, or commit of that repository reaches it.
    repo = make_repo(tmp_path)
    other = tmp_path / "other"
    other.mkdir()
    sh("git", "init", "-q", cwd=other)
    run = repo / "artifacts" / "runs" / "r1"
    run.mkdir()
    (run / "a.bin").write_bytes(blob(THRESHOLD, 142))
    assert run_main(["stow", str(run), "--store", str(other / ".git" / "stores")], repo, monkeypatch) == rs.EXIT_OK


def test_a_store_path_through_a_symlink_into_another_working_tree_is_refused(tmp_path, monkeypatch, capsys):
    repo = make_repo(tmp_path)
    other = tmp_path / "other"
    other.mkdir()
    sh("git", "init", "-q", cwd=other)
    os.symlink(other, tmp_path / "alias")
    run = repo / "artifacts" / "runs" / "r1"
    run.mkdir()
    (run / "a.bin").write_bytes(blob(THRESHOLD, 143))
    capsys.readouterr()
    assert run_main(["stow", str(run), "--store", str(tmp_path / "alias" / "cache")], repo, monkeypatch) == rs.EXIT_ERROR
    assert f"lies inside {other.resolve()}" in capsys.readouterr().err


def test_the_case_rename_refusal_holds_on_every_platform(tmp_path, monkeypatch, capsys):
    # git matches ignore rules case-sensitively here while names differing only in case are one output:
    # the managed block lists the recorded spelling, so the new spelling is not covered.
    repo = make_repo(tmp_path)
    sh("git", "config", "core.ignorecase", "false", cwd=repo)
    monkeypatch.setattr(rs.Repo, "ignorecase", property(lambda self: True))
    run = repo / "artifacts" / "runs" / "r1"
    run.mkdir()
    (run / "out.bin").write_bytes(blob(THRESHOLD, 144))
    assert run_main(["stow", str(run)], repo, monkeypatch) == rs.EXIT_OK
    commit_records(repo)
    os.rename(run / "out.bin", run / "OUT.bin")  # same file on a case-insensitive disk, same bytes elsewhere
    capsys.readouterr()
    assert run_main(["stow", str(run), "--dry-run", "--json"], repo, monkeypatch) == rs.EXIT_FINDINGS
    assert json.loads(capsys.readouterr().out)["case_respelled_uncovered"] == ["OUT.bin"]
    assert run_main(["stow", str(run), "--json"], repo, monkeypatch) == rs.EXIT_FINDINGS
    out = capsys.readouterr()
    doc = json.loads(out.out)
    assert doc["refused"] == ["case_respelled_uncovered"] and doc["items"]["case_respelled_uncovered"] == [{"path": "OUT.bin"}]
    assert "OUT.bin: recorded file(s) renamed only in letter case" in out.err and "['" not in out.err
    assert [e["path"] for e in json.loads((run / rs.MANIFEST_NAME).read_text())["entries"]] == ["out.bin"]


def test_a_case_rename_in_non_ascii_letters_is_refused_even_with_ignorecase(tmp_path, monkeypatch, capsys):
    # git folds letter case only for ASCII letters, even with core.ignorecase=true; Python's casefold
    # (and a case-insensitive disk) folds more. The refusal must not advise setting what is already set.
    repo = make_repo(tmp_path)
    sh("git", "config", "core.ignorecase", "true", cwd=repo)
    run = repo / "artifacts" / "runs" / "r1"
    run.mkdir()
    (run / "é.bin").write_bytes(blob(THRESHOLD, 147))
    assert run_main(["stow", str(run)], repo, monkeypatch) == rs.EXIT_OK
    commit_records(repo)
    os.rename(run / "é.bin", run / "É.bin")  # same file on a case-insensitive disk, same bytes elsewhere
    capsys.readouterr()
    assert run_main(["stow", str(run), "--json"], repo, monkeypatch) == rs.EXIT_FINDINGS
    out = capsys.readouterr()
    assert json.loads(out.out)["refused"] == ["case_respelled_uncovered"]
    assert "only for ASCII letters" in out.err and "setting core.ignorecase=true also works" not in out.err
    assert run_main(["check", "--strict", "--json"], repo, monkeypatch) == rs.EXIT_FINDINGS
    assert [r["path"] for r in json.loads(capsys.readouterr().out)["untracked"]] == ["artifacts/runs/r1/É.bin"]


def test_a_case_probe_that_cannot_be_removed_is_reported(tmp_path, monkeypatch, capsys):
    real_unlink = os.unlink

    def refuse_probe(path, *a, **kw):
        if ".nullius-case-probe-" in str(path):
            raise PermissionError(13, "Permission denied")
        return real_unlink(path, *a, **kw)

    monkeypatch.setattr(rs.os, "unlink", refuse_probe)
    capsys.readouterr()
    observed = (tmp_path / "x").write_text("") or (tmp_path / "X").exists()
    assert rs.case_insensitive(tmp_path) is observed
    err = capsys.readouterr().err
    assert "could not remove the probe file" in err and "delete it by hand" in err


def test_a_refusal_after_the_record_was_written_still_reports_what_was_stored(tmp_path, monkeypatch, capsys):
    repo = make_repo(tmp_path)
    run = repo / "artifacts" / "runs" / "r1"
    (run / "sub").mkdir(parents=True)
    (run / "sub" / ".gitignore").write_text("!a.bin\n")  # a deeper rule re-includes it
    (run / "sub" / "a.bin").write_bytes(blob(THRESHOLD, 151))
    capsys.readouterr()
    assert run_main(["stow", str(run), "--json"], repo, monkeypatch) == rs.EXIT_FINDINGS
    out = capsys.readouterr()
    doc = json.loads(out.out)
    assert doc["refused"] == ["reincluded_by_negation"] and doc["record_written"] is True
    assert [e["path"] for e in doc["stowed"]] == ["sub/a.bin"] and doc["manifest"] == str(run / rs.MANIFEST_NAME)
    assert "stowed" in out.err and "sub/a.bin" in out.err


def test_a_refusal_after_the_record_was_written_reports_what_success_would(tmp_path, monkeypatch, capsys):
    repo = make_repo(tmp_path)
    run = repo / "artifacts" / "runs" / "r1"
    (run / "sub").mkdir(parents=True)
    (run / "sub" / ".gitignore").write_text("!a.bin\n")
    (run / "sub" / "a.bin").write_bytes(blob(THRESHOLD, 153))
    capsys.readouterr()
    assert run_main(["stow", str(run), "--json"], repo, monkeypatch) == rs.EXIT_FINDINGS
    doc = json.loads(capsys.readouterr().out)
    assert {"stowed", "already_tracked", "symlinks_not_followed", "store", "manifest", "commit_needed"} <= set(doc)
    assert doc["commit_needed"] is True


def test_a_case_probe_that_cannot_be_created_counts_as_case_sensitive(tmp_path, capsys):
    if os.geteuid() == 0:
        pytest.skip("root writes into read-only directories")
    sealed = tmp_path / "sealed"
    sealed.mkdir()
    os.chmod(sealed, 0o555)
    try:
        assert rs.case_insensitive(sealed) is False
        assert list(sealed.iterdir()) == [] and capsys.readouterr().err == ""
    finally:
        os.chmod(sealed, 0o755)


def test_case_sensitivity_is_measured_where_the_run_outputs_live(tmp_path, monkeypatch):
    repo = make_repo(tmp_path)
    seen = []
    monkeypatch.setattr(rs, "case_insensitive", lambda d: (seen.append(Path(d)), False)[1])
    sh("git", "config", "core.ignorecase", "false", cwd=repo)
    assert rs.Repo(repo).ignorecase is False
    assert seen == [(repo / "artifacts" / "runs").resolve()]


def test_a_case_only_rename_on_a_case_sensitive_file_system_is_the_same_output(tmp_path, monkeypatch, capsys):
    if not case_sensitive_file_system(tmp_path):
        pytest.skip("needs a case-sensitive file system (as on Linux)")
    repo = make_repo(tmp_path)
    sh("git", "config", "core.ignorecase", "true", cwd=repo)  # carried over from a case-insensitive checkout
    run = repo / "artifacts" / "runs" / "r1"
    run.mkdir()
    (run / "out.bin").write_bytes(blob(THRESHOLD, 145))
    assert run_main(["stow", str(run)], repo, monkeypatch) == rs.EXIT_OK
    commit_records(repo)
    os.rename(run / "out.bin", run / "OUT.bin")  # a new name for the same bytes
    assert run_main(["stow", str(run)], repo, monkeypatch) == rs.EXIT_OK
    assert [e["path"] for e in json.loads((run / rs.MANIFEST_NAME).read_text())["entries"]] == ["out.bin"]
    capsys.readouterr()
    assert run_main(["check", "--strict", "--json"], repo, monkeypatch) == rs.EXIT_OK
    doc = json.loads(capsys.readouterr().out)
    assert doc["ignored_unstowed"] == [] and [r["path"] for r in doc["stowed"]] == ["artifacts/runs/r1/out.bin"]
    overwrite_in_place(run / "OUT.bin", blob(THRESHOLD, 146))  # now different bytes under the new name
    assert run_main(["check", "--strict", "--json"], repo, monkeypatch) == rs.EXIT_FINDINGS
    assert [r["path"] for r in json.loads(capsys.readouterr().out)["ignored_unstowed"]] == ["artifacts/runs/r1/OUT.bin"]


def test_without_case_folding_a_case_only_rename_is_an_ordinary_rename(tmp_path, monkeypatch, capsys):
    if not case_sensitive_file_system(tmp_path):
        pytest.skip("needs a case-sensitive file system (as on Linux)")
    repo = make_repo(tmp_path)
    sh("git", "config", "core.ignorecase", "false", cwd=repo)  # the default on a case-sensitive file system
    run = repo / "artifacts" / "runs" / "r1"
    run.mkdir()
    (run / "out.bin").write_bytes(blob(THRESHOLD, 150))
    assert run_main(["stow", str(run)], repo, monkeypatch) == rs.EXIT_OK
    commit_records(repo)
    os.rename(run / "out.bin", run / "OUT.bin")
    capsys.readouterr()
    assert run_main(["check", "--strict", "--json"], repo, monkeypatch) == rs.EXIT_FINDINGS
    doc = json.loads(capsys.readouterr().out)
    assert [r["path"] for r in doc["untracked"]] == ["artifacts/runs/r1/OUT.bin"]
    assert [(r["path"], r["status"]) for r in doc["stowed"]] == [("artifacts/runs/r1/out.bin", "in_store_only")]
    assert run_main(["stow", str(run)], repo, monkeypatch) == rs.EXIT_OK  # like a rename to any other name
    assert [e["path"] for e in json.loads((run / rs.MANIFEST_NAME).read_text())["entries"]] == ["OUT.bin", "out.bin"]
    commit_records(repo)
    assert run_main(["check", "--strict"], repo, monkeypatch) == rs.EXIT_OK


def test_a_different_file_differing_only_in_case_with_the_same_bytes_is_a_new_output(tmp_path, monkeypatch, capsys):
    if not case_sensitive_file_system(tmp_path):
        pytest.skip("needs a case-sensitive file system (as on Linux)")
    repo = make_repo(tmp_path)
    sh("git", "config", "core.ignorecase", "true", cwd=repo)
    run = repo / "artifacts" / "runs" / "r1"
    run.mkdir()
    (run / "out.bin").write_bytes(blob(THRESHOLD, 148))
    assert run_main(["stow", str(run)], repo, monkeypatch) == rs.EXIT_OK
    commit_records(repo)
    (run / "OUT.bin").write_bytes(blob(THRESHOLD, 148))  # a second file; the recorded one is still there
    capsys.readouterr()
    assert run_main(["check", "--strict", "--json"], repo, monkeypatch) == rs.EXIT_FINDINGS
    assert [r["path"] for r in json.loads(capsys.readouterr().out)["ignored_unstowed"]] == ["artifacts/runs/r1/OUT.bin"]
    assert run_main(["stow", str(run)], repo, monkeypatch) == rs.EXIT_OK
    assert [e["path"] for e in json.loads((run / rs.MANIFEST_NAME).read_text())["entries"]] == ["OUT.bin", "out.bin"]


# ---------------------------------------------------------- unusual input

@pytest.mark.parametrize("layout", ["begin_only", "end_before_begin", "two_blocks"])
def test_stow_refuses_malformed_managed_block_markers_before_changing_anything(tmp_path, monkeypatch, layout):
    repo = make_repo(tmp_path)
    run = repo / "artifacts" / "runs" / "r1"
    run.mkdir()
    (run / "big.bin").write_bytes(blob(THRESHOLD, 66))
    b, e = rs.GITIGNORE_BEGIN, rs.GITIGNORE_END
    text = {"begin_only": f"user-rule-1\n{b}\nuser-rule-2\n",
            "end_before_begin": f"{e}\nuser-rule-1\n{b}\nuser-rule-2\n",
            "two_blocks": f"{b}\n{e}\nuser-rule-1\n{b}\n{e}\n"}[layout]
    (run / ".gitignore").write_text(text)
    assert run_main(["stow", str(run)], repo, monkeypatch) == rs.EXIT_ERROR
    assert (run / ".gitignore").read_text() == text
    assert stat.S_IMODE((run / "big.bin").stat().st_mode) & 0o200 and not store_of(repo).exists()


def test_verify_never_opens_a_special_file_at_a_recorded_path(tmp_path, monkeypatch, capsys):
    repo = make_repo(tmp_path)
    run = repo / "artifacts" / "runs" / "r1"
    run.mkdir()
    (run / "out.bin").write_bytes(blob(THRESHOLD, 67))
    assert run_main(["stow", str(run)], repo, monkeypatch) == rs.EXIT_OK
    (run / "out.bin").unlink()
    os.mkfifo(run / "out.bin")
    capsys.readouterr()
    assert run_main(["verify", str(run), "--json"], repo, monkeypatch) == rs.EXIT_FINDINGS
    assert [e["status"] for e in json.loads(capsys.readouterr().out)["entries"]] == ["mismatch"]


@pytest.mark.skipif(os.geteuid() == 0, reason="root reads unreadable directories")
@pytest.mark.parametrize("command", ["check", "stow"])
def test_walks_that_records_rest_on_stop_at_unreadable_directories(tmp_path, monkeypatch, command):
    root = make_repo(tmp_path)
    hidden = root / "artifacts" / "runs" / "r1" / "sealed"
    hidden.mkdir(parents=True)
    (hidden / "big.bin").write_bytes(blob(2 * 1024 * 1024, 93))
    os.chmod(hidden, 0)
    try:
        argv = {"check": ["check", "--strict"], "stow": ["stow", "artifacts/runs/r1"]}[command]
        assert run_main(argv, root, monkeypatch) == rs.EXIT_ERROR
    finally:
        os.chmod(hidden, 0o755)


# ------------------------------------------------------- documentation lock

def test_skill_documents_exactly_the_implemented_subcommands_and_statuses():
    parser_choices = set(rs.build_parser()._subparsers._group_actions[0].choices)
    assert parser_choices == set(rs.SUBCOMMANDS)
    text = SKILL_MD.read_text(encoding="utf-8")
    match = re.search(r"^## Run Storage\b.*?(?=^## )", text, flags=re.S | re.M)
    assert match, "SKILL.md must have a '## Run Storage' section"
    section = match.group(0) + RUN_STORAGE_REFERENCE_MD.read_text(encoding="utf-8")
    documented = set(re.findall(r"run_storage\.py (\b[a-z][a-z-]+\b)", section))
    assert documented == set(rs.SUBCOMMANDS), (sorted(documented ^ set(rs.SUBCOMMANDS)))
    for status in rs.ENTRY_STATUSES:
        assert f"`{status}`" in section, status
    for phrase in ("bulk_manifest.json", "git worktree remove", "refs/nullius/runs", "5 MiB"):
        assert phrase in section, phrase


def test_declared_value_overrides_size_and_store_captures_small_outputs(tmp_path, monkeypatch, capsys):
    repo = make_repo(tmp_path, {"path_rules": [
        {"path": "artifacts/runs/r1", "disposition": "store", "reason": "reproducible intermediates"},
        {"path": "artifacts/runs/r1/input.json", "disposition": "git", "reason": "unique frozen input"},
        {"path": "artifacts/runs/r1/solver.py", "disposition": "git", "reason": "source implementation"},
        {"path": "artifacts/runs/r1/result.json", "disposition": "git", "reason": "necessary result"},
    ]})
    run = repo / "artifacts/runs/r1"
    run.mkdir()
    (run / "array.txt").write_text("regenerable\n")
    (run / "input.json").write_bytes(blob(THRESHOLD + 1))
    (run / "solver.py").write_text("value = 1\n")
    (run / "result.json").write_text('{"value": 1}\n')
    doc = stow_json(run, repo, monkeypatch, capsys)
    assert [r["path"] for r in doc["stowed"]] == ["array.txt"]
    sh("git", "add", "-A", cwd=repo)
    assert run_main(["check", "--staged", "--strict"], repo, monkeypatch) == rs.EXIT_OK
    assert (run / "input.json").stat().st_mode & stat.S_IWUSR
    original = (run / "array.txt").read_bytes()
    (run / "array.txt").unlink()
    assert run_main(["verify", str(run)], repo, monkeypatch) == rs.EXIT_OK
    assert run_main(["materialize", str(run)], repo, monkeypatch) == rs.EXIT_OK
    assert (run / "array.txt").read_bytes() == original


def test_admission_uses_index_bytes_and_checks_small_local_files_outside_runs(tmp_path, monkeypatch, capsys):
    repo = make_repo(tmp_path, {"path_rules": [
        {"path": "backups", "disposition": "local", "reason": "off-repository backups", "retention_days": 30},
        {"path": "artifacts/runs/r1/array.json", "disposition": "store", "reason": "regenerable samples"},
    ]})
    run = repo / "artifacts/runs/r1"
    run.mkdir()
    (run / "array.json").write_text("[]")
    (repo / "backups").mkdir()
    (repo / "backups/archive.txt").write_text("backup")
    sh("git", "add", "-A", cwd=repo)
    (run / "array.json").unlink()  # staged bytes still enter the next commit
    assert run_main(["check", "--staged", "--strict", "--json"], repo, monkeypatch) == rs.EXIT_FINDINGS
    doc = json.loads(capsys.readouterr().out)
    assert {r["reason"] for r in doc["admission_findings"]} == {"declared_store", "declared_local"}


@pytest.mark.parametrize("metric", ["bytes", "files"])
def test_many_small_outputs_trigger_aggregate_admission(tmp_path, monkeypatch, capsys, metric):
    repo = make_repo(tmp_path, {"admission_max_bytes": 10 if metric == "bytes" else 100,
                                "admission_max_files": 1 if metric == "files" else 100})
    run = repo / "artifacts/runs/r1"
    run.mkdir()
    for name in ("a.txt", "b.txt"):
        (run / name).write_text("same data")
    sh("git", "add", "-A", cwd=repo)
    assert run_main(["check", "--staged", "--strict", "--json"], repo, monkeypatch) == rs.EXIT_FINDINGS
    doc = json.loads(capsys.readouterr().out)
    assert doc["staged_bulk"] == []
    assert doc["admission_limits"] == [{"metric": metric, "observed": 18 if metric == "bytes" else 2,
                                         "maximum": 10 if metric == "bytes" else 1}]


def test_git_bundle_is_detected_from_bytes_without_extension(tmp_path, monkeypatch, capsys):
    repo = make_repo(tmp_path)
    sh("git", "bundle", "create", "saved.data", "HEAD", cwd=repo)
    sh("git", "add", "saved.data", cwd=repo)
    assert run_main(["check", "--snapshot", "--strict", "--json"], repo, monkeypatch) == rs.EXIT_FINDINGS
    doc = json.loads(capsys.readouterr().out)
    assert {r["reason"] for r in doc["admission_findings"]} == {"git_backup_archive"}
    assert (repo / "saved.data").read_bytes().startswith(b"# v2 git bundle")


def test_snapshot_checks_unstaged_output_before_any_git_object_write(tmp_path, monkeypatch, capsys):
    repo = make_repo(tmp_path)
    run = repo / "artifacts/runs/r1"
    run.mkdir()
    f = run / "output.txt"
    f.write_text("old\n")
    sh("git", "add", "-A", cwd=repo)
    sh("git", "commit", "-q", "-m", "small evidence", cwd=repo)
    f.write_bytes(blob(THRESHOLD))
    before = {str(p.relative_to(repo)): p.read_bytes() for p in repo.rglob("*") if p.is_file()}
    monkeypatch.setattr(rs, "case_insensitive", lambda *a: pytest.fail("read-only commands must not probe"))
    assert run_main(["check", "--snapshot", "--strict", "--json"], repo, monkeypatch) == rs.EXIT_FINDINGS
    doc = json.loads(capsys.readouterr().out)
    assert [(r["path"], r["source"]) for r in doc["admission_findings"]] == [("artifacts/runs/r1/output.txt", "working_tree")]
    after = {str(p.relative_to(repo)): p.read_bytes() for p in repo.rglob("*") if p.is_file()}
    assert before == after


def test_inventory_reports_duplicates_and_retention_without_writes(tmp_path, monkeypatch, capsys):
    repo = make_repo(tmp_path, {"path_rules": [
        {"path": "artifacts/runs/r1/logs", "disposition": "local", "reason": "disposable raw logs", "retention_days": 1}
    ]})
    run = repo / "artifacts/runs/r1"
    (run / "logs").mkdir(parents=True)
    for name in ("a.json", "b.json"):
        (run / name).write_text('{"result": 1}\n')
    log = run / "logs/raw.txt"
    log.write_text("old raw log")
    os.utime(log, (0, 0))
    sh("git", "add", "-A", cwd=repo)
    before = {str(p.relative_to(repo)): p.read_bytes() for p in repo.rglob("*") if p.is_file()}
    monkeypatch.setattr(rs, "case_insensitive", lambda *a: pytest.fail("read-only inventory must not probe"))
    assert run_main(["inventory", "--json"], repo, monkeypatch) == rs.EXIT_OK
    doc = json.loads(capsys.readouterr().out)
    assert doc["duplicate_occurrences"] == 1
    assert doc["duplicate_logical_bytes"] == len('{"result": 1}\n')
    assert doc["duplicates"][0]["copies"] == 2
    assert doc["retention_review"] == [{"path": "artifacts/runs/r1/logs/raw.txt", "size": 11,
                                         "retention_days": 1, "tracked": True, "reason": "disposable raw logs"}]
    assert before == {str(p.relative_to(repo)): p.read_bytes() for p in repo.rglob("*") if p.is_file()}


@pytest.mark.parametrize("rule", [
    {"path": "../escape", "disposition": "git", "reason": "input"},
    {"path": ".git/objects", "disposition": "local", "reason": "cache"},
    {"path": "inputs", "disposition": "git", "reason": ""},
    {"path": "inputs", "disposition": "git", "reason": "input", "retention_days": 1},
])
def test_invalid_classification_fails_before_writes(tmp_path, monkeypatch, rule):
    repo = make_repo(tmp_path, {"path_rules": [rule]})
    assert run_main(["check", "--snapshot", "--strict"], repo, monkeypatch) == rs.EXIT_ERROR


@pytest.mark.parametrize("name", ["bulk_manifest.json", ".gitignore"])
def test_backup_header_is_not_exempted_by_storage_record_name(tmp_path, monkeypatch, capsys, name):
    repo = make_repo(tmp_path)
    (repo / "backups").mkdir()
    sh("git", "bundle", "create", "backups/" + name, "HEAD", cwd=repo)
    sh("git", "add", "backups/" + name, cwd=repo)
    for mode in ("--staged", "--snapshot"):
        assert run_main(["check", mode, "--strict", "--json"], repo, monkeypatch) == rs.EXIT_FINDINGS
        doc = json.loads(capsys.readouterr().out)
        assert {r["reason"] for r in doc["admission_findings"]} == {"git_backup_archive"}


def test_retention_reports_local_file_and_directory_rules_outside_run_roots(tmp_path, monkeypatch, capsys):
    repo = make_repo(tmp_path, {"path_rules": [
        {"path": "logs", "disposition": "local", "reason": "machine logs", "retention_days": 1},
        {"path": "cache.bin", "disposition": "local", "reason": "disposable cache", "retention_days": 2},
        {"path": "logs/essential.json", "disposition": "git", "reason": "unique failure evidence"},
    ]})
    (repo / "logs").mkdir()
    for name in ("logs/raw.txt", "cache.bin", "logs/essential.json"):
        q = repo / name
        q.write_text("old bytes")
        os.utime(q, (0, 0))
    sh("git", "add", "logs/raw.txt", cwd=repo)
    before = {str(p.relative_to(repo)): p.read_bytes() for p in repo.rglob("*") if p.is_file()}
    assert run_main(["inventory", "--json"], repo, monkeypatch) == rs.EXIT_OK
    doc = json.loads(capsys.readouterr().out)
    assert [(r["path"], r["tracked"]) for r in doc["retention_review"]] == [("cache.bin", False), ("logs/raw.txt", True)]
    assert before == {str(p.relative_to(repo)): p.read_bytes() for p in repo.rglob("*") if p.is_file()}


def test_retention_union_deduplicates_overlapping_roots_and_never_follows_links(tmp_path, monkeypatch, capsys):
    repo = make_repo(tmp_path, {"path_rules": [
        {"path": "artifacts", "disposition": "local", "reason": "declared local outputs", "retention_days": 1},
        {"path": "artifacts/runs/r1/keep.json", "disposition": "git", "reason": "unique retained input"},
        {"path": "external", "disposition": "local", "reason": "local path", "retention_days": 1},
    ]})
    (repo / "artifacts/runs/r1").mkdir()
    for name in ("old.txt", "keep.json"):
        q = repo / "artifacts/runs/r1" / name
        q.write_text("bytes")
        os.utime(q, (0, 0))
    external = tmp_path / "outside"
    external.mkdir()
    (external / "private.txt").write_text("private")
    (repo / "external").symlink_to(external, target_is_directory=True)
    assert run_main(["inventory", "--json"], repo, monkeypatch) == rs.EXIT_OK
    doc = json.loads(capsys.readouterr().out)
    assert [r["path"] for r in doc["retention_review"]] == ["artifacts/runs/r1/old.txt"]
    assert doc["filesystem"] == [{"path": "artifacts", "files": 3, "logical_bytes": 10}]
    assert doc["skipped"] == [{"path": "external", "reason": "symlinked_root"}]


@pytest.mark.parametrize("name", ["bulk_manifest.json", ".gitignore"])
def test_declared_local_paths_outside_runs_have_no_record_name_exemption(tmp_path, monkeypatch, capsys, name):
    repo = make_repo(tmp_path, {"path_rules": [
        {"path": "backups", "disposition": "local", "reason": "off-repository backups"}
    ]})
    (repo / "backups").mkdir()
    (repo / "backups" / name).write_text("local bytes")
    sh("git", "add", "backups/" + name, cwd=repo)
    assert run_main(["check", "--staged", "--strict", "--json"], repo, monkeypatch) == rs.EXIT_FINDINGS
    assert json.loads(capsys.readouterr().out)["admission_findings"][0]["reason"] == "declared_local"


@pytest.mark.parametrize("name", ["bulk_manifest.json", ".gitignore"])
@pytest.mark.parametrize("disposition", ["local", "store"])
def test_arbitrary_reserved_names_inside_runs_do_not_bypass_classification(tmp_path, monkeypatch, capsys, name, disposition):
    repo = make_repo(tmp_path, {"path_rules": [
        {"path": "artifacts/runs/r1/" + name, "disposition": disposition, "reason": "declared output"}
    ]})
    (repo / "artifacts/runs/r1").mkdir()
    (repo / "artifacts/runs/r1" / name).write_text("local output\n")
    sh("git", "add", "-A", cwd=repo)
    for mode in ("--staged", "--snapshot"):
        assert run_main(["check", mode, "--strict", "--json"], repo, monkeypatch) == rs.EXIT_FINDINGS
        assert {r["reason"] for r in json.loads(capsys.readouterr().out)["admission_findings"]} == {"declared_" + disposition}


def test_arbitrary_reserved_names_are_subject_to_bulk_and_total_limits(tmp_path, monkeypatch, capsys):
    repo = make_repo(tmp_path, {"admission_max_bytes": 16})
    (repo / "artifacts/runs/r1").mkdir()
    f = repo / "artifacts/runs/r1/bulk_manifest.json"
    f.write_text("x" * THRESHOLD)
    sh("git", "add", "-A", cwd=repo)
    assert run_main(["check", "--staged", "--strict", "--json"], repo, monkeypatch) == rs.EXIT_FINDINGS
    doc = json.loads(capsys.readouterr().out)
    assert doc["admission_findings"][0]["reason"] == "bulk_output"
    assert doc["admission_limits"] == [{"metric": "bytes", "observed": THRESHOLD, "maximum": 16}]


def test_record_exemption_uses_staged_manifest_bytes_not_later_working_bytes(tmp_path, monkeypatch, capsys):
    repo = make_repo(tmp_path, {"path_rules": [
        {"path": "artifacts/runs/r1", "disposition": "store", "reason": "regenerable outputs"}
    ]})
    (repo / "artifacts/runs/r1").mkdir()
    f = repo / "artifacts/runs/r1/bulk_manifest.json"
    f.write_text("not a manifest")
    sh("git", "add", "-A", cwd=repo)
    f.write_text(json.dumps({"schema": rs.MANIFEST_SCHEMA, "entries": []}))
    assert run_main(["check", "--staged", "--strict", "--json"], repo, monkeypatch) == rs.EXIT_FINDINGS
    assert json.loads(capsys.readouterr().out)["admission_findings"][0]["source"] == "index"
