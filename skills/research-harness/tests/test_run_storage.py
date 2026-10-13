"""Tests for run_storage.py (bulk run outputs kept out of git history)."""
from __future__ import annotations

import errno
import importlib.util
import json
import os
import re
import shutil
import stat
import subprocess
import sys
from pathlib import Path

import pytest

_MOD = Path(__file__).resolve().parent.parent / "scripts" / "run_storage.py"
_spec = importlib.util.spec_from_file_location("run_storage", _MOD)
rs = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(rs)

SKILL_MD = Path(__file__).resolve().parent.parent / "SKILL.md"
THRESHOLD = 4096


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
    repo = make_repo(tmp_path)
    run = repo / "artifacts" / "runs" / "r1"
    run.mkdir()
    (run / ".gitignore").write_text("# a long user ignore file\n" + "*.tmp\n" * THRESHOLD)
    sh("git", "add", "-A", cwd=repo)
    for argv in (["check", "--staged", "--strict"], ["check", "--strict"]):
        assert run_main(argv, repo, monkeypatch) == rs.EXIT_OK, argv


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
    assert "from another copy" in capsys.readouterr().err
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
    assert "['big.bin'] are stowed but tracked" in err and "does not cover ['sub/other.bin']" in err


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
    sh("git", "config", "--unset", "core.ignorecase", cwd=repo)
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
    section = match.group(0)
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


def test_gitignore_configuration_preserved_under_tiny_aggregate_limit_but_rules_still_apply(tmp_path, monkeypatch, capsys):
    repo = make_repo(tmp_path, {"admission_max_bytes": 1, "admission_max_files": 1})
    run = repo / "artifacts/runs/r1"
    run.mkdir()
    (run / ".gitignore").write_text("# unique Git configuration\n*.tmp\n")
    sh("git", "add", "-A", cwd=repo)
    for mode in ("--staged", "--snapshot"):
        assert run_main(["check", mode, "--strict", "--json"], repo, monkeypatch) == rs.EXIT_OK
        doc = json.loads(capsys.readouterr().out)
        assert doc["admission_findings"] == [] and doc["admission_totals"] == {"files": 0, "logical_bytes": 0}
    policy = json.loads((repo / rs.POLICY_REL).read_text())
    policy["path_rules"] = [{"path": "artifacts/runs/r1/.gitignore", "disposition": "local", "reason": "explicit owner classification"}]
    (repo / rs.POLICY_REL).write_text(json.dumps(policy))
    assert run_main(["check", "--staged", "--strict", "--json"], repo, monkeypatch) == rs.EXIT_FINDINGS
    assert json.loads(capsys.readouterr().out)["admission_findings"][0]["reason"] == "declared_local"
