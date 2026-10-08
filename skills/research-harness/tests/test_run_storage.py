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
    paths = {k: [r["path"] for r in doc[k]] for k in ("tracked", "untracked", "ignored_stowed", "ignored_unstowed")}
    assert paths == {
        "tracked": ["artifacts/runs/legacy/tracked.dat"],
        "untracked": ["artifacts/runs/new/untracked.dat"],
        "ignored_stowed": ["artifacts/runs/stowed/out.dat"],
        "ignored_unstowed": ["artifacts/runs/ignored/lost.dat"],
    }
    assert run_main(["check", "--strict"], repo, monkeypatch) == rs.EXIT_FINDINGS


def test_policy_file_is_validated(tmp_path, monkeypatch, capsys):
    repo = make_repo(tmp_path)
    (repo / ".nullius" / "storage_policy.json").write_text(json.dumps({"schema": "other"}))
    assert run_main(["check"], repo, monkeypatch) == rs.EXIT_ERROR
    (repo / ".nullius" / "storage_policy.json").write_text(
        json.dumps({"schema": rs.POLICY_SCHEMA, "bulk_threshold_bytes": 0}))
    assert run_main(["check"], repo, monkeypatch) == rs.EXIT_ERROR
    (repo / ".nullius" / "storage_policy.json").write_text(
        json.dumps({"schema": rs.POLICY_SCHEMA, "run_roots": ["../outside"]}))
    assert run_main(["check"], repo, monkeypatch) == rs.EXIT_ERROR


# ------------------------------------------------------------------- stow

def test_stow_links_into_shared_store_and_keeps_file_readable_in_place(tmp_path, monkeypatch, capsys):
    repo = make_repo(tmp_path)
    run = repo / "artifacts" / "runs" / "r1"
    (run / "sub").mkdir(parents=True)
    data = blob(THRESHOLD * 3, 5)
    (run / "sub" / "field.bin").write_bytes(data)
    (run / "log.txt").write_text("small log\n")
    assert run_main(["stow", str(run)], repo, monkeypatch) == rs.EXIT_OK
    target = run / "sub" / "field.bin"
    sha = rs.sha256_file(target)
    entry = rs.store_path(store_of(repo), sha)
    assert entry.exists() and os.path.samestat(entry.stat(), target.stat()), "same inode, no extra bytes"
    assert target.read_bytes() == data, "original bytes readable in place"
    assert stat.S_IMODE(target.stat().st_mode) & 0o222 == 0, "stowed output is read-only"
    manifest = json.loads((run / rs.MANIFEST_NAME).read_text())
    assert manifest["schema"] == rs.MANIFEST_SCHEMA
    assert [(e["path"], e["size"], e["sha256"]) for e in manifest["entries"]] == [("sub/field.bin", len(data), sha)]
    assert sh("git", "check-ignore", "-q", "artifacts/runs/r1/sub/field.bin", cwd=repo, check=False).returncode == 0
    assert sh("git", "check-ignore", "-q", "artifacts/runs/r1/log.txt", cwd=repo, check=False).returncode == 1
    sh("git", "add", "-A", cwd=repo)
    staged = sh("git", "diff", "--cached", "--name-only", cwd=repo).stdout.split()
    assert "artifacts/runs/r1/sub/field.bin" not in staged
    assert {"artifacts/runs/r1/bulk_manifest.json", "artifacts/runs/r1/.gitignore",
            "artifacts/runs/r1/log.txt"} <= set(staged)
    # second stow is a no-op
    capsys.readouterr()
    assert run_main(["stow", str(run), "--json"], repo, monkeypatch) == rs.EXIT_OK
    assert json.loads(capsys.readouterr().out)["stowed"] == []


def test_stow_shares_identical_outputs_and_refuses_changed_results(tmp_path, monkeypatch, capsys):
    repo = make_repo(tmp_path)
    runs = repo / "artifacts" / "runs"
    for name in ("a", "b"):
        (runs / name).mkdir()
        (runs / name / "out.bin").write_bytes(blob(THRESHOLD * 2, 9))
        assert run_main(["stow", f"artifacts/runs/{name}"], repo, monkeypatch) == rs.EXIT_OK
    assert os.path.samestat((runs / "a" / "out.bin").stat(), (runs / "b" / "out.bin").stat())
    entries = list((store_of(repo) / "sha256").rglob("*"))
    assert len([e for e in entries if e.is_file()]) == 1
    # a changed result under a recorded path is refused, never silently re-recorded
    target = runs / "a" / "out.bin"
    target.unlink()
    target.write_bytes(blob(THRESHOLD * 2, 10))
    assert run_main(["stow", "artifacts/runs/a"], repo, monkeypatch) == rs.EXIT_FINDINGS


def test_stow_leaves_tracked_bulk_alone_and_refuses_outside_run_roots(tmp_path, monkeypatch, capsys):
    repo = make_repo(tmp_path)
    run = repo / "artifacts" / "runs" / "legacy"
    run.mkdir()
    (run / "tracked.bin").write_bytes(blob(THRESHOLD, 11))
    sh("git", "add", "-A", cwd=repo)
    sh("git", "commit", "-q", "-m", "legacy", cwd=repo)
    capsys.readouterr()
    assert run_main(["stow", str(run), "--json"], repo, monkeypatch) == rs.EXIT_OK
    doc = json.loads(capsys.readouterr().out)
    assert doc["stowed"] == [] and [r["path"] for r in doc["already_tracked"]] == ["tracked.bin"]
    assert not (run / rs.MANIFEST_NAME).exists() or json.loads((run / rs.MANIFEST_NAME).read_text())["entries"] == []
    other = repo / "elsewhere"
    other.mkdir()
    assert run_main(["stow", str(other)], repo, monkeypatch) == rs.EXIT_ERROR


def test_ignore_block_escapes_special_names(tmp_path, monkeypatch):
    repo = make_repo(tmp_path)
    run = repo / "artifacts" / "runs" / "r1"
    run.mkdir()
    names = ["a[1]*.bin", "#hash.bin", "!bang.bin", "trailing.bin "]
    for i, name in enumerate(names):
        (run / name).write_bytes(blob(THRESHOLD, 20 + i))
    (run / "a1x.bin").write_bytes(b"small")
    (run / ".gitignore").write_text("# user rule kept\n*.tmp\n")
    assert run_main(["stow", str(run)], repo, monkeypatch) == rs.EXIT_OK
    for name in names:
        assert sh("git", "check-ignore", "-q", f"artifacts/runs/r1/{name}", cwd=repo, check=False).returncode == 0, name
    assert sh("git", "check-ignore", "-q", "artifacts/runs/r1/a1x.bin", cwd=repo, check=False).returncode == 1
    text = (run / ".gitignore").read_text()
    assert text.startswith("# user rule kept\n*.tmp\n") and text.count(rs.GITIGNORE_BEGIN) == 1


def test_store_put_copies_across_file_systems(tmp_path, monkeypatch):
    src = tmp_path / "f.bin"
    src.write_bytes(blob(THRESHOLD, 30))

    def no_link(a, b):
        raise OSError(errno.EXDEV, "cross-device link")

    monkeypatch.setattr(rs.os, "link", no_link)
    sha, dest, method = rs.store_put(src, tmp_path / "store")
    assert method == "copy" and dest.read_bytes() == src.read_bytes()
    assert not os.path.samestat(dest.stat(), src.stat())


# ------------------------------------------------------- verify / materialize

def test_verify_reports_every_state(tmp_path, monkeypatch, capsys):
    repo = make_repo(tmp_path)
    run = repo / "artifacts" / "runs" / "r1"
    run.mkdir()
    for name, seed in (("ok.bin", 40), ("gone.bin", 41), ("lost.bin", 42), ("bad.bin", 43)):
        (run / name).write_bytes(blob(THRESHOLD, seed))
    assert run_main(["stow", str(run)], repo, monkeypatch) == rs.EXIT_OK
    capsys.readouterr()
    assert run_main(["verify", str(run)], repo, monkeypatch) == rs.EXIT_OK
    (run / "gone.bin").unlink()
    lost_sha = rs.sha256_file(run / "lost.bin")
    (run / "lost.bin").unlink()
    store_entry = rs.store_path(store_of(repo), lost_sha)
    store_entry.unlink()
    bad = run / "bad.bin"
    bad.unlink()  # break the link, then write different bytes under the recorded name
    bad.write_bytes(blob(THRESHOLD, 99))
    capsys.readouterr()
    assert run_main(["verify", str(run), "--json"], repo, monkeypatch) == rs.EXIT_FINDINGS
    statuses = {e["path"]: e["status"] for e in json.loads(capsys.readouterr().out)["entries"]}
    assert statuses == {"ok.bin": "ok", "gone.bin": "in_store_only", "lost.bin": "missing", "bad.bin": "mismatch"}


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
    capsys.readouterr()
    assert run_main(["verify", str(wt_run)], wt, monkeypatch) == rs.EXIT_OK  # intact in the shared store
    assert run_main(["materialize", str(wt_run)], wt, monkeypatch) == rs.EXIT_OK
    assert (wt_run / "out.bin").read_bytes() == data
    assert os.path.samestat((wt_run / "out.bin").stat(), (run / "out.bin").stat())
    capsys.readouterr()
    assert run_main(["verify", str(wt_run), "--json"], wt, monkeypatch) == rs.EXIT_OK
    assert [e["status"] for e in json.loads(capsys.readouterr().out)["entries"]] == ["ok"]


# ------------------------------------------------------------- worktrees

def _worktree(repo: Path, tmp_path: Path, name: str) -> Path:
    wt = tmp_path / name
    sh("git", "worktree", "add", "-q", "-b", name, str(wt), cwd=repo)
    return wt


def _verdicts(capsys) -> dict:
    doc = json.loads(capsys.readouterr().out)
    return {Path(r["worktree"]).name: r for r in doc["worktrees"]}


def test_worktree_check_verdicts(tmp_path, monkeypatch, capsys):
    repo = make_repo(tmp_path)
    (repo / ".gitignore").write_text("node_modules/\n*.out\n")
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

    # the printed removal command really works for a safe worktree, and the
    # stowed output survives in the shared store after the worktree is gone
    entry = rs.store_path(store_of(repo), rs.sha256_file(run / "big.bin"))
    sh(*v["stowed"]["remove_command"].split(), cwd=repo)
    assert not stowed.exists() and entry.exists()
    # nothing was removed by the check itself
    assert (unique / "result.out").exists() and clean.exists()


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
    assert run_main(["sparse-exclude-bulk"], wt, monkeypatch) == rs.EXIT_OK
    assert not (wt / "artifacts/runs/legacy/huge.bin").exists()
    assert (wt / "artifacts/runs/legacy/notes.txt").exists() and (wt / "README.md").exists()
    assert (run / "huge.bin").exists(), "main checkout keeps its full checkout"
    assert sh("git", "status", "--porcelain", cwd=wt).stdout == ""
    assert run_main(["sparse-exclude-bulk"], wt, monkeypatch) == rs.EXIT_ERROR  # never overwrites patterns
    sh("git", "sparse-checkout", "disable", cwd=wt)
    assert (wt / "artifacts/runs/legacy/huge.bin").exists()


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
    temp_parent = tmp_path / "temp"
    old_root = temp_parent / "lane-run-1"
    old_root.mkdir(parents=True)
    (old_root / "f").write_bytes(b"z" * 100)
    past = time.time() - 30 * 86400
    os.utime(old_root / "f", (past, past))
    os.utime(old_root, (past, past))
    (temp_parent / "lane-run-2").mkdir()
    capsys.readouterr()
    rc = run_main(["report", str(scratch), "--repo", str(repo), "--stale-dir", str(temp_parent),
                   "--stale-prefix", "lane-", "--json"], tmp_path, monkeypatch)
    assert rc == rs.EXIT_OK
    doc = json.loads(capsys.readouterr().out)
    assert doc["summary_bytes"]["duplicate_content"] == len(dup)
    assert doc["summary_bytes"]["regenerable_directories"] == 1000
    bundles = {Path(b["path"]).name: b["contained_in_reference"] for b in doc["bundles"]}
    assert bundles == {"contained.bundle": True, "extra.bundle": False}
    stores = {Path(g["path"]).name: g["contained_in_reference"] for g in doc["git_object_stores"]}
    assert stores == {"copy-of-history.git": False}
    assert [Path(s["path"]).name for s in doc["stale"]] == ["lane-run-1"]
    assert (scratch / "b" / "copy.bin").exists(), "report never deletes"


# --------------------------------------------------------------- closeout

def test_closeout_plans_then_applies_with_manifest(tmp_path, monkeypatch, capsys):
    root = tmp_path / "acceptance-run"
    (root / "isolated-copy" / "node_modules" / "dep").mkdir(parents=True)
    (root / "isolated-copy" / "node_modules" / "dep" / "x.js").write_text("x")
    (root / "isolated-copy" / "src.txt").write_text("source copy\n")
    (root / "evidence").mkdir()
    big = blob(2 * 1024 * 1024, 90)
    (root / "evidence" / "observations.json").write_bytes(big)
    (root / "evidence" / "small.txt").write_text("kept as is\n")
    verdict = root / "verdict.json"
    assert run_main(["closeout", str(root), "--verdict", str(verdict)], tmp_path, monkeypatch) == rs.EXIT_ERROR
    verdict.write_text('{"verdict": "PASS"}\n')
    assert run_main(["closeout", str(root), "--verdict", str(verdict), "--prune", "isolated-copy"],
                    tmp_path, monkeypatch) == rs.EXIT_OK
    assert (root / "isolated-copy").exists() and not (root / rs.CLOSEOUT_MANIFEST_NAME).exists(), "plan only"
    assert run_main(["closeout", str(root), "--verdict", str(verdict), "--prune", "../outside"],
                    tmp_path, monkeypatch) == rs.EXIT_ERROR
    capsys.readouterr()
    monkeypatch.setattr(rs.shutil, "which", lambda name: None)  # exercise the stdlib (xz) path
    assert run_main(["closeout", str(root), "--verdict", str(verdict), "--prune", "isolated-copy", "--apply",
                     "--json"], tmp_path, monkeypatch) == rs.EXIT_OK
    manifest = json.loads((root / rs.CLOSEOUT_MANIFEST_NAME).read_text())
    assert manifest["state"] == "applied" and not (root / "isolated-copy").exists()
    assert [p["path"] for p in manifest["pruned"]] == ["isolated-copy"] and manifest["pruned"][0]["tree_digest"]
    original_sha = manifest["kept_files"]["evidence/observations.json"]["sha256"]
    [entry] = manifest["compressed"]
    assert entry["path"] == "evidence/observations.json" and entry["method"] == "xz"
    with lzma.open(root / "evidence" / entry["compressed_path"], "rb") as fh:
        restored = fh.read()
    assert restored == big and rs.hashlib.sha256(restored).hexdigest() == original_sha
    assert (root / "evidence" / "small.txt").read_text() == "kept as is\n"
    assert run_main(["closeout", str(root), "--verdict", str(verdict), "--apply"],
                    tmp_path, monkeypatch) == rs.EXIT_ERROR, "a tree is closed out once"


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
    assert rs.store_path(store, first).exists()
    assert run_main(["tree-digest", str(tree), "--store", str(store), "--compare", first], tmp_path,
                    monkeypatch) == rs.EXIT_OK
    (tree / "d" / "f.txt").write_text("two\n")
    (tree / "g.txt").write_text("new\n")
    capsys.readouterr()
    assert run_main(["tree-digest", str(tree), "--store", str(store), "--compare", first, "--json"], tmp_path,
                    monkeypatch) == rs.EXIT_FINDINGS
    cmp = json.loads(capsys.readouterr().out)["compare"]
    assert cmp["added"] == ["g.txt"] and cmp["changed"] == ["d/f.txt"] and cmp["removed"] == []


def test_store_put_stores_once(tmp_path, monkeypatch, capsys):
    a = tmp_path / "a.bin"
    b = tmp_path / "b.bin"
    a.write_bytes(blob(5000, 1))
    b.write_bytes(blob(5000, 1))
    store = tmp_path / "store"
    capsys.readouterr()
    assert run_main(["store-put", str(a), str(b), "--store", str(store), "--copy", "--json"], tmp_path,
                    monkeypatch) == rs.EXIT_OK
    methods = [r["method"] for r in json.loads(capsys.readouterr().out)["stored"]]
    assert methods == ["copy", "existing"]
    assert stat.S_IMODE(a.stat().st_mode) & 0o200, "--copy leaves the source writable"


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

def test_skill_documents_exactly_the_implemented_subcommands():
    parser_choices = set(rs.build_parser()._subparsers._group_actions[0].choices)
    assert parser_choices == set(rs.SUBCOMMANDS)
    text = SKILL_MD.read_text(encoding="utf-8")
    match = re.search(r"^## Run Storage\b.*?(?=^## )", text, flags=re.S | re.M)
    assert match, "SKILL.md must have a '## Run Storage' section"
    documented = set(re.findall(r"run_storage\.py (\b[a-z][a-z-]+\b)", match.group(0)))
    assert documented == set(rs.SUBCOMMANDS), (sorted(documented ^ set(rs.SUBCOMMANDS)))
    for phrase in ("bulk_manifest.json", "git worktree remove", "refs/nullius/runs", "5 MiB"):
        assert phrase in match.group(0), phrase
