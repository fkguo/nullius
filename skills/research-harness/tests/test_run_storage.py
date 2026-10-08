"""Tests for run_storage.py (bulk run outputs kept out of git history)."""
from __future__ import annotations

import errno
import importlib.util
import json
import lzma
import os
import re
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
    assert stowed["method"] in ("clone", "link", "copy")
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


def test_stow_rehashes_the_source_on_the_existing_object_branch(tmp_path, monkeypatch, capsys):
    repo = make_repo(tmp_path)
    runs = repo / "artifacts" / "runs"
    original = blob(THRESHOLD, 69)
    for name in ("a", "b"):
        (runs / name).mkdir()
        (runs / name / "out.bin").write_bytes(original)
    stow_json(runs / "a", repo, monkeypatch, capsys)

    def writer_then_no_clone(src, dst):  # an open writer changes run b between hashing and recording
        target = runs / "b" / "out.bin"
        os.chmod(target, 0o644)
        target.write_bytes(blob(THRESHOLD, 70))
        return False

    monkeypatch.setattr(rs, "clone_file", writer_then_no_clone)
    assert run_main(["stow", str(runs / "b")], repo, monkeypatch) == rs.EXIT_ERROR
    assert not (runs / "b" / rs.MANIFEST_NAME).exists(), "nothing recorded for bytes that are not in place"


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


def test_symlinked_run_root_is_refused_cleanly(tmp_path, monkeypatch):
    repo = make_repo(tmp_path)
    outside = tmp_path / "outside-runs"
    (outside / "r1").mkdir(parents=True)
    (outside / "r1" / "big.bin").write_bytes(blob(THRESHOLD, 17))
    shutil.rmtree(repo / "artifacts" / "runs")
    os.symlink(outside, repo / "artifacts" / "runs")
    assert run_main(["stow", "artifacts/runs/r1"], repo, monkeypatch) == rs.EXIT_ERROR
    assert run_main(["check"], repo, monkeypatch) == rs.EXIT_OK


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

    entry = rs.store_path(store_of(repo), rs.sha256_file(run / "big.bin"))
    sh(*v["stowed"]["remove_command"].split(), cwd=repo)
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


def test_worktree_check_keeps_a_worktree_that_contains_the_store(tmp_path, monkeypatch, capsys):
    repo = make_repo(tmp_path)
    (repo / ".gitignore").write_text("store/\n")
    sh("git", "add", "-A", cwd=repo)
    sh("git", "commit", "-q", "-m", "ignore", cwd=repo)
    wt = _worktree(repo, tmp_path, "lane")
    policy = {"schema": rs.POLICY_SCHEMA, "bulk_threshold_bytes": THRESHOLD, "store_root": str(wt / "store")}
    (repo / ".nullius" / "storage_policy.json").write_text(json.dumps(policy))
    (wt / ".nullius" / "storage_policy.json").write_text(json.dumps(policy))
    run = wt / "artifacts" / "runs" / "r1"
    run.mkdir()
    (run / "big.bin").write_bytes(blob(THRESHOLD, 63))
    assert run_main(["stow", str(run)], wt, monkeypatch) == rs.EXIT_OK
    capsys.readouterr()
    assert run_main(["worktree-check", str(wt), "--json"], repo, monkeypatch) == rs.EXIT_FINDINGS
    v = _verdicts(capsys)["lane"]
    assert v["verdict"] == "keep" and any("lies inside this worktree" in r for r in v["reasons"])
    assert v["ignored"]["in_store"] == []


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


# ----------------------------------------------------------------- sparse

def test_sparse_exclude_bulk_in_linked_worktree(tmp_path, monkeypatch, capsys):
    repo = make_repo(tmp_path)
    run = repo / "artifacts" / "runs" / "legacy"
    run.mkdir()
    (run / "huge.bin").write_bytes(blob(THRESHOLD * 2, 70))
    (run / "notes.txt").write_text("small evidence\n")
    sh("git", "add", "-A", cwd=repo)
    sh("git", "commit", "-q", "-m", "legacy bulk", cwd=repo)
    assert run_main(["sparse-exclude-bulk"], repo, monkeypatch) == rs.EXIT_ERROR  # main checkout refused
    wt = _worktree(repo, tmp_path, "lane")
    other = _worktree(repo, tmp_path, "other")
    assert run_main(["sparse-exclude-bulk"], wt, monkeypatch) == rs.EXIT_OK
    assert not (wt / "artifacts/runs/legacy/huge.bin").exists()
    assert (wt / "artifacts/runs/legacy/notes.txt").exists() and (wt / "README.md").exists()
    assert (run / "huge.bin").exists() and (other / "artifacts/runs/legacy/huge.bin").exists(), \
        "the main checkout and other worktrees keep their full checkouts"
    assert sh("git", "status", "--porcelain", cwd=wt).stdout == ""
    assert run_main(["sparse-exclude-bulk"], wt, monkeypatch) == rs.EXIT_ERROR  # never overwrites patterns
    sh("git", "sparse-checkout", "disable", cwd=wt)
    assert (wt / "artifacts/runs/legacy/huge.bin").exists()


def test_sparse_exclude_bulk_refuses_a_hidden_edit_of_a_bulk_file(tmp_path, monkeypatch):
    repo = make_repo(tmp_path)
    run = repo / "artifacts" / "runs" / "legacy"
    run.mkdir()
    (run / "huge.bin").write_bytes(blob(THRESHOLD * 2, 72))
    sh("git", "add", "-A", cwd=repo)
    sh("git", "commit", "-q", "-m", "legacy bulk", cwd=repo)
    wt = _worktree(repo, tmp_path, "lane")
    edited = blob(THRESHOLD * 2, 73)
    (wt / "artifacts/runs/legacy/huge.bin").write_bytes(edited)
    sh("git", "update-index", "--assume-unchanged", "artifacts/runs/legacy/huge.bin", cwd=wt)
    assert run_main(["sparse-exclude-bulk"], wt, monkeypatch) == rs.EXIT_ERROR
    assert (wt / "artifacts/runs/legacy/huge.bin").read_bytes() == edited


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
    assert doc["summary_bytes"]["regenerable_directories"] == 1000, "overlapping roots are counted once"
    bundles = {Path(b["path"]).name: b["contained_in_reference"] for b in doc["bundles"]}
    assert bundles == {"contained.bundle": True, "extra.bundle": False, "dangling.bundle": False}
    stores = {Path(g["path"]).name: g["contained_in_reference"] for g in doc["git_object_stores"]}
    assert stores == {"copy-of-history.git": False, "same-history.git": True, "tag-only-history.git": False,
                      "dangling-history.git": False, ".git": False, "dropped-tag-history.git": False}
    assert [Path(s["path"]).name for s in doc["stale"]] == ["lane-run-1"]
    assert (scratch / "b" / "copy.bin").exists(), "report never deletes"


# --------------------------------------------------------------- closeout

def _closeout_tree(tmp_path) -> "tuple[Path, Path, bytes]":
    root = tmp_path / "acceptance-run"
    (root / "isolated-copy" / "node_modules" / "dep").mkdir(parents=True)
    (root / "isolated-copy" / "node_modules" / "dep" / "x.js").write_text("x")
    (root / "isolated-copy" / "src.txt").write_text("source copy\n")
    (root / "evidence").mkdir()
    big = blob(2 * 1024 * 1024, 90)
    (root / "evidence" / "observations.json").write_bytes(big)
    (root / "evidence" / "small.txt").write_text("kept as is\n")
    return root, root / "verdict.json", big


@pytest.mark.parametrize("bad", [".", "./", "", "../outside", "evidence/..", rs.CLOSEOUT_MANIFEST_NAME, "evidence",
                                 "linkdir/keepme-link"])
def test_closeout_refuses_unsafe_prune_paths(tmp_path, monkeypatch, bad):
    root, verdict, _ = _closeout_tree(tmp_path)
    if bad == "evidence":  # a prune path that contains the verdict
        verdict = root / "evidence" / "verdict.json"
    if bad.startswith("linkdir/"):  # a path that leaves the tree through a symlinked directory
        outside = tmp_path / "outside"
        outside.mkdir()
        os.symlink(root / "evidence" / "small.txt", outside / "keepme-link")
        os.symlink(outside, root / "linkdir")
    verdict.write_text('{"verdict": "PASS"}\n')
    assert run_main(["closeout", str(root), "--verdict", str(verdict), "--prune", bad, "--apply"],
                    tmp_path, monkeypatch) == rs.EXIT_ERROR
    assert (root / "evidence" / "observations.json").exists() and verdict.exists()
    assert not (root / rs.CLOSEOUT_MANIFEST_NAME).exists()
    if bad.startswith("linkdir/"):
        assert (tmp_path / "outside" / "keepme-link").is_symlink()


def test_closeout_prunes_exactly_the_named_path_including_whitespace(tmp_path, monkeypatch):
    root, verdict, _ = _closeout_tree(tmp_path)
    verdict.write_text("PASS\n")
    for name in ("cache", " cache"):
        (root / name).mkdir()
        (root / name / "f").write_text(name)
    assert run_main(["closeout", str(root), "--verdict", str(verdict), "--prune", " cache", "--no-compress",
                     "--apply"], tmp_path, monkeypatch) == rs.EXIT_OK
    assert not (root / " cache").exists() and (root / "cache" / "f").read_text() == "cache"


def test_closeout_prune_caches_never_removes_the_verdict(tmp_path, monkeypatch):
    root, _, _ = _closeout_tree(tmp_path)
    verdict = root / "isolated-copy" / "node_modules" / "verdict.json"
    verdict.write_text("PASS\n")
    assert run_main(["closeout", str(root), "--verdict", str(verdict), "--prune-caches", "--apply"],
                    tmp_path, monkeypatch) == rs.EXIT_ERROR
    assert verdict.exists() and not (root / rs.CLOSEOUT_MANIFEST_NAME).exists()


def _interrupted_closeout(tmp_path, monkeypatch, fail_at):
    root, verdict, big = _closeout_tree(tmp_path)
    verdict.write_text("PASS\n")
    monkeypatch.setattr(rs.shutil, "which", lambda name: None)
    real = getattr(rs, fail_at)

    def fail_once(*a, **k):
        monkeypatch.setattr(rs, fail_at, real)
        if fail_at == "remove_path":
            first = sorted(Path(a[0]).rglob("*"))[-1]
            first.unlink()  # part of the tree is already gone when the failure hits
        raise rs.StorageError("simulated interruption")

    monkeypatch.setattr(rs, fail_at, fail_once)
    assert run_main(["closeout", str(root), "--verdict", str(verdict), "--prune", "isolated-copy", "--apply"],
                    tmp_path, monkeypatch) == rs.EXIT_ERROR
    return root, verdict, big


@pytest.mark.parametrize("damage", ["removed", "corrupted"])
def test_closeout_resume_needs_an_intact_inventory_before_deleting_more(tmp_path, monkeypatch, damage):
    root, verdict, _ = _interrupted_closeout(tmp_path, monkeypatch, "remove_path")
    entry = json.loads((root / rs.CLOSEOUT_MANIFEST_NAME).read_text())["pruned"][0]
    record = root / entry["inventory_file"]
    os.chmod(record, 0o644)
    if damage == "removed":
        record.unlink()
    else:
        record.write_text("{}")
    held = root / rs.QUARANTINE_DIR / "0"
    survivors = sorted(p.name for p in held.rglob("*"))
    assert run_main(["closeout", str(root), "--verdict", str(verdict), "--apply"], tmp_path,
                    monkeypatch) == rs.EXIT_ERROR
    assert sorted(p.name for p in held.rglob("*")) == survivors, "the quarantined remainder is kept"


def test_closeout_resume_after_partial_deletion_keeps_the_complete_inventory(tmp_path, monkeypatch):
    root, verdict, _ = _interrupted_closeout(tmp_path, monkeypatch, "remove_path")
    first = json.loads((root / rs.CLOSEOUT_MANIFEST_NAME).read_text())["pruned"][0]
    assert first["files"] == 2 and not first.get("removed")
    assert run_main(["closeout", str(root), "--verdict", str(verdict), "--apply"], tmp_path, monkeypatch) == rs.EXIT_OK
    final = json.loads((root / rs.CLOSEOUT_MANIFEST_NAME).read_text())["pruned"][0]
    assert final["tree_digest"] == first["tree_digest"] and final["files"] == 2 and final["removed"]
    assert not (root / rs.QUARANTINE_DIR).exists()


def test_closeout_resume_never_removes_bytes_written_after_the_plan(tmp_path, monkeypatch):
    root, verdict, big = _interrupted_closeout(tmp_path, monkeypatch, "fsync_dir")
    manifest = json.loads((root / rs.CLOSEOUT_MANIFEST_NAME).read_text())
    assert manifest["state"] == "applying"
    src = root / "evidence" / "observations.json"
    if not src.exists():
        pytest.skip("the interruption landed after the original was removed")
    src.write_bytes(b"new result written after the plan")
    assert run_main(["closeout", str(root), "--verdict", str(verdict), "--apply"], tmp_path,
                    monkeypatch) == rs.EXIT_ERROR
    assert src.read_bytes() == b"new result written after the plan"


def test_closeout_never_removes_an_original_rewritten_during_compression(tmp_path, monkeypatch):
    root, verdict, big = _closeout_tree(tmp_path)
    verdict.write_text("PASS\n")
    monkeypatch.setattr(rs.shutil, "which", lambda name: None)
    real = rs.compress_to_new_file

    def compress_then_write(src, out, sha, method):
        size = real(src, out, sha, method)
        os.chmod(src, 0o644)
        src.write_bytes(b"result written while compressing")  # a producer that did not stop
        return size

    monkeypatch.setattr(rs, "compress_to_new_file", compress_then_write)
    assert run_main(["closeout", str(root), "--verdict", str(verdict), "--apply"], tmp_path,
                    monkeypatch) == rs.EXIT_ERROR
    assert (root / "evidence" / "observations.json").read_bytes() == b"result written while compressing"


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


def test_tree_digest_compare_refuses_a_damaged_inventory(tmp_path, monkeypatch, capsys):
    tree = tmp_path / "tree"
    tree.mkdir()
    (tree / "f").write_text("x")
    store = tmp_path / "store"
    capsys.readouterr()
    assert run_main(["tree-digest", str(tree), "--store", str(store), "--json"], tmp_path, monkeypatch) == rs.EXIT_OK
    digest = json.loads(capsys.readouterr().out)["digest"]
    obj = rs.store_path(store, digest)
    os.chmod(obj, 0o644)
    obj.write_text("not json")
    (tree / "g").write_text("changed")  # a different tree, so the damaged object is not simply rewritten
    assert run_main(["tree-digest", str(tree), "--store", str(store), "--compare", digest], tmp_path,
                    monkeypatch) == rs.EXIT_ERROR


@pytest.mark.parametrize("tamper", ["escaping_prune", "escaping_compress", "inventory_mismatch"])
def test_closeout_resume_revalidates_the_recorded_plan(tmp_path, monkeypatch, tamper):
    root, verdict, _ = _interrupted_closeout(tmp_path, monkeypatch, "remove_path")
    outside = tmp_path / "valuable"
    outside.mkdir()
    (outside / "keep.txt").write_text("precious\n")
    path = root / rs.CLOSEOUT_MANIFEST_NAME
    manifest = json.loads(path.read_text())
    if tamper == "escaping_prune":
        manifest["pruned"].append({"path": "../valuable"})
    elif tamper == "escaping_compress":
        manifest["compressed"].append({"path": "../valuable/keep.txt", "sha256": "0" * 64, "size": 9,
                                       "method": "xz"})
    else:
        record = root / manifest["pruned"][0]["inventory_file"]
        os.chmod(record, 0o644)
        record.write_text("{}")
        manifest["pruned"][0].pop("tree_digest")
        manifest["pruned"][0].pop("inventory_file")
        (root / rs.QUARANTINE_DIR / "0" / "src.txt").write_text("source copy\n")
    path.write_text(json.dumps(manifest))
    assert run_main(["closeout", str(root), "--verdict", str(verdict), "--apply"], tmp_path,
                    monkeypatch) == rs.EXIT_ERROR
    assert (outside / "keep.txt").read_text() == "precious\n"


def test_closeout_plans_then_applies_with_manifest(tmp_path, monkeypatch, capsys):
    root, verdict, big = _closeout_tree(tmp_path)
    assert run_main(["closeout", str(root), "--verdict", str(verdict)], tmp_path, monkeypatch) == rs.EXIT_ERROR
    verdict.write_text("")  # an empty verdict file is not a recorded verdict
    assert run_main(["closeout", str(root), "--verdict", str(verdict), "--prune", "isolated-copy", "--apply"],
                    tmp_path, monkeypatch) == rs.EXIT_ERROR
    assert (root / "isolated-copy").exists() and not (root / rs.CLOSEOUT_MANIFEST_NAME).exists()
    verdict.write_text('{"verdict": "PASS"}\n')
    assert run_main(["closeout", str(root), "--verdict", str(verdict), "--prune", "./isolated-copy//"],
                    tmp_path, monkeypatch) == rs.EXIT_OK
    assert (root / "isolated-copy").exists() and not (root / rs.CLOSEOUT_MANIFEST_NAME).exists(), "plan only"
    capsys.readouterr()
    monkeypatch.setattr(rs.shutil, "which", lambda name: None)  # exercise the stdlib (xz) path
    assert run_main(["closeout", str(root), "--verdict", str(verdict), "--prune", "./isolated-copy//", "--apply",
                     "--json"], tmp_path, monkeypatch) == rs.EXIT_OK
    manifest = json.loads((root / rs.CLOSEOUT_MANIFEST_NAME).read_text())
    assert manifest["state"] == "applied" and not (root / "isolated-copy").exists()
    assert not any(k.startswith("isolated-copy") for k in manifest["kept_files"])
    [pruned] = manifest["pruned"]
    assert pruned["path"] == "isolated-copy" and pruned["files"] == 2
    inventory_bytes = (root / pruned["inventory_file"]).read_bytes()
    assert rs.hashlib.sha256(inventory_bytes).hexdigest() == pruned["tree_digest"]
    inventory = json.loads(inventory_bytes)
    assert inventory["src.txt"]["sha256"] == rs.hashlib.sha256(b"source copy\n").hexdigest()
    original_sha = manifest["kept_files"]["evidence/observations.json"]["sha256"]
    [entry] = manifest["compressed"]
    assert entry["path"] == "evidence/observations.json" and entry["method"] == "xz" and entry["done"]
    with lzma.open(root / entry["compressed_path"], "rb") as fh:
        restored = fh.read()
    assert restored == big and rs.hashlib.sha256(restored).hexdigest() == original_sha
    assert (root / "evidence" / "small.txt").read_text() == "kept as is\n"
    assert not (root / rs.QUARANTINE_DIR).exists()
    assert run_main(["closeout", str(root), "--verdict", str(verdict), "--apply"],
                    tmp_path, monkeypatch) == rs.EXIT_ERROR, "a tree is closed out once"


def test_closeout_never_overwrites_an_existing_compressed_name(tmp_path, monkeypatch):
    root = tmp_path / "run"
    root.mkdir()
    (root / "data.bin").write_bytes(b"A" * 2 * 1024 * 1024)
    (root / "data.bin.xz").write_bytes(b"PRECIOUS " * 300)
    (root / "verdict.txt").write_text("PASS\n")
    monkeypatch.setattr(rs.shutil, "which", lambda name: None)
    assert run_main(["closeout", str(root), "--verdict", str(root / "verdict.txt"), "--apply"],
                    tmp_path, monkeypatch) == rs.EXIT_OK
    assert (root / "data.bin.xz").read_bytes() == b"PRECIOUS " * 300
    assert (root / "data.bin").exists()
    manifest = json.loads((root / rs.CLOSEOUT_MANIFEST_NAME).read_text())
    assert manifest["compressed"] == [] and manifest["compression_skipped"][0]["path"] == "data.bin"


def test_closeout_keeps_content_store_objects_byte_exact(tmp_path, monkeypatch):
    root = tmp_path / "run"
    data = b"0123456789" * 300_000
    _, obj = rs.store_put_bytes(data, root / "store")
    (root / "verdict.txt").write_text("PASS\n")
    assert run_main(["closeout", str(root), "--verdict", str(root / "verdict.txt"), "--apply"],
                    tmp_path, monkeypatch) == rs.EXIT_OK
    assert rs.verify_store_object(obj, obj.name)


@pytest.mark.parametrize("broken", ["not json", "no_verdict", "verdict_not_dict", "kept_record_not_dict",
                                    "kept_record_without_hash"])
def test_closeout_refuses_a_broken_recorded_manifest_cleanly(tmp_path, monkeypatch, broken):
    root, verdict, _ = _closeout_tree(tmp_path)
    verdict.write_text("PASS\n")
    good = {"schema": rs.CLOSEOUT_SCHEMA, "state": "applying",
            "verdict": {"path": str(verdict), "sha256": rs.sha256_file(verdict)},
            "kept_files": {"evidence/small.txt": {"type": "file", "size": 11, "sha256": "a" * 64}},
            "pruned": [{"path": "isolated-copy"}], "compressed": []}
    if broken == "not json":
        text = "not json"
    else:
        doc = json.loads(json.dumps(good))
        if broken == "no_verdict":
            doc.pop("verdict")
        elif broken == "verdict_not_dict":
            doc["verdict"] = []
        elif broken == "kept_record_not_dict":
            doc["kept_files"]["evidence/small.txt"] = []
        else:
            doc["kept_files"]["evidence/small.txt"].pop("sha256")
        text = json.dumps(doc)
    (root / rs.CLOSEOUT_MANIFEST_NAME).write_text(text)
    assert run_main(["closeout", str(root), "--verdict", str(verdict), "--apply"], tmp_path,
                    monkeypatch) == rs.EXIT_ERROR
    assert (root / "isolated-copy").exists()


def test_closeout_keeps_git_object_stores_byte_exact(tmp_path, monkeypatch):
    root = tmp_path / "run"
    repo = root / "copy"
    repo.mkdir(parents=True)
    sh("git", "init", "-q", cwd=repo)
    (repo / "big.txt").write_bytes(b"0123456789" * 300_000)
    sh("git", "add", "-A", cwd=repo)
    sh("git", "commit", "-q", "-m", "c", cwd=repo)
    sh("git", "gc", "-q", cwd=repo)
    (root / "verdict.txt").write_text("PASS\n")
    assert run_main(["closeout", str(root), "--verdict", str(root / "verdict.txt"), "--compress-min-size", "1",
                     "--apply"], tmp_path, monkeypatch) == rs.EXIT_OK
    manifest = json.loads((root / rs.CLOSEOUT_MANIFEST_NAME).read_text())
    assert not any("/.git/" in c["path"] for c in manifest["compressed"])
    assert sh("git", "fsck", "--no-progress", cwd=repo, check=False).returncode == 0


def test_closeout_resumes_an_interrupted_apply(tmp_path, monkeypatch, capsys):
    root, verdict, big = _closeout_tree(tmp_path)
    verdict.write_text("PASS\n")
    monkeypatch.setattr(rs.shutil, "which", lambda name: None)
    calls = {"n": 0}
    real = rs.compress_to_new_file

    def fail_once(*a, **k):
        calls["n"] += 1
        if calls["n"] == 1:
            raise rs.StorageError("simulated interruption")
        return real(*a, **k)

    monkeypatch.setattr(rs, "compress_to_new_file", fail_once)
    assert run_main(["closeout", str(root), "--verdict", str(verdict), "--prune", "isolated-copy", "--apply"],
                    tmp_path, monkeypatch) == rs.EXIT_ERROR
    manifest = json.loads((root / rs.CLOSEOUT_MANIFEST_NAME).read_text())
    assert manifest["state"] == "applying" and manifest["pruned"][0]["removed"]
    assert (root / "evidence" / "observations.json").read_bytes() == big, "the original survives the failure"
    assert run_main(["closeout", str(root), "--verdict", str(verdict), "--prune", "other", "--apply"],
                    tmp_path, monkeypatch) == rs.EXIT_ERROR, "a resume follows the recorded plan only"
    assert run_main(["closeout", str(root), "--verdict", str(verdict), "--apply"], tmp_path, monkeypatch) == rs.EXIT_OK
    manifest = json.loads((root / rs.CLOSEOUT_MANIFEST_NAME).read_text())
    assert manifest["state"] == "applied" and manifest["compressed"][0]["done"]
    assert not (root / "evidence" / "observations.json").exists()


@pytest.mark.skipif(shutil.which("zstd") is None, reason="zstd not installed")
def test_closeout_zstd_round_trip(tmp_path, monkeypatch, capsys):
    root = tmp_path / "run"
    root.mkdir()
    big = blob(2 * 1024 * 1024, 91)
    (root / "data.bin").write_bytes(big)
    (root / "verdict.txt").write_text("PASS\n")
    assert run_main(["closeout", str(root), "--verdict", str(root / "verdict.txt"), "--apply"],
                    tmp_path, monkeypatch) == rs.EXIT_OK
    out = subprocess.run(["zstd", "-q", "-d", "-c", str(root / "data.bin.zst")], capture_output=True, check=True)
    assert out.stdout == big and not (root / "data.bin").exists()


# ---------------------------------------------------- store-put / tree-digest

def test_tree_digest_store_and_compare(tmp_path, monkeypatch, capsys):
    tree = tmp_path / "tree"
    (tree / "d").mkdir(parents=True)
    (tree / "d" / "f.txt").write_text("one\n")
    store = tmp_path / "store"
    capsys.readouterr()
    assert run_main(["tree-digest", str(tree), "--store", str(store), "--json"], tmp_path, monkeypatch) == rs.EXIT_OK
    first = json.loads(capsys.readouterr().out)["digest"]
    assert rs.verify_store_object(rs.store_path(store, first), first)
    assert run_main(["tree-digest", str(tree), "--store", str(store), "--compare", first], tmp_path,
                    monkeypatch) == rs.EXIT_OK
    (tree / "d" / "f.txt").write_text("two\n")
    (tree / "g.txt").write_text("new\n")
    capsys.readouterr()
    assert run_main(["tree-digest", str(tree), "--store", str(store), "--compare", first, "--json"], tmp_path,
                    monkeypatch) == rs.EXIT_FINDINGS
    cmp = json.loads(capsys.readouterr().out)["compare"]
    assert cmp["added"] == ["g.txt"] and cmp["changed"] == ["d/f.txt"] and cmp["removed"] == []


def test_store_put_stores_once_and_leaves_the_source_untouched(tmp_path, monkeypatch, capsys):
    a = tmp_path / "a.bin"
    b = tmp_path / "b.bin"
    a.write_bytes(blob(5000, 1))
    b.write_bytes(blob(5000, 1))
    before = stat.S_IMODE(a.stat().st_mode)
    store = tmp_path / "store"
    capsys.readouterr()
    assert run_main(["store-put", str(a), str(b), "--store", str(store), "--json"], tmp_path,
                    monkeypatch) == rs.EXIT_OK
    methods = [r["method"] for r in json.loads(capsys.readouterr().out)["stored"]]
    assert methods[0] in ("clone", "copy") and methods[1] == "existing"
    assert stat.S_IMODE(a.stat().st_mode) == before, "recording a file never changes it"
    with open(a, "ab") as fh:  # the observed program can keep writing
        fh.write(b"more")


# ------------------------------------------------------------------- hook

def test_install_hook_warns_blocks_and_respects_foreign_hooks(tmp_path, monkeypatch, capsys):
    repo = make_repo(tmp_path)
    assert run_main(["install-hook"], repo, monkeypatch) == rs.EXIT_OK
    run = repo / "artifacts" / "runs" / "r1"
    run.mkdir()
    (run / "big.dat").write_bytes(blob(THRESHOLD, 100))
    sh("git", "add", "-A", cwd=repo)
    commit = sh("git", "commit", "-q", "-m", "warned", cwd=repo, check=False)
    assert commit.returncode == 0 and "artifacts/runs/r1/big.dat" in commit.stdout + commit.stderr
    assert run_main(["install-hook", "--strict"], repo, monkeypatch) == rs.EXIT_OK
    (run / "big2.dat").write_bytes(blob(THRESHOLD, 101))
    sh("git", "add", "-A", cwd=repo)
    assert sh("git", "commit", "-q", "-m", "blocked", cwd=repo, check=False).returncode != 0
    hook = repo / ".git" / "hooks" / "pre-commit"
    hook.write_text("#!/bin/sh\nexit 0\n")
    assert run_main(["install-hook"], repo, monkeypatch) == rs.EXIT_ERROR
    assert hook.read_text() == "#!/bin/sh\nexit 0\n"


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
