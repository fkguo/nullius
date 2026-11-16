import fcntl
import hashlib
import json
import lzma
import os
from pathlib import Path
import shutil
import subprocess
import sys

import pytest

SCRIPTS = Path(__file__).resolve().parents[1] / "scripts"


@pytest.fixture
def scratch(tmp_path):
    root = tmp_path.resolve() / "scratch"
    root.mkdir()
    (root / "verdict.txt").write_text("review complete\n")
    (root / "output").write_bytes(b"sample " * 20000)
    cache = root / "__pycache__"
    cache.mkdir()
    (cache / "bytecode.pyc").write_bytes(b"cache")
    return root


def invoke(root, *options, code=0, verdict=None, path=None):
    env = dict(os.environ)
    if path is not None:
        env["PATH"] = path
    proc = subprocess.run([sys.executable, str(SCRIPTS / "run_storage.py"), "closeout", str(root),
                           "--verdict", str(verdict or (root / "verdict.txt")), "--json", *options],
                          text=True, capture_output=True, env=env)
    assert proc.returncode == code, (proc.stdout, proc.stderr)
    return json.loads(proc.stdout)


@pytest.mark.parametrize("method", ["xz", "zstd"])
def test_preview_apply_and_repeat(scratch, method):
    if method == "zstd" and not shutil.which("zstd"):
        pytest.skip("zstd not installed")
    original = (scratch / "output").read_bytes()
    zero = scratch / "other"
    zero.touch()
    (scratch / "other.xz").write_bytes(b"already in use")
    (scratch / "other.zst").write_bytes(b"already in use")
    (scratch / "copy").hardlink_to(scratch / "verdict.txt")
    options = ["--prune-caches", "--compress-min-size", "0"]
    path = "" if method == "xz" else None
    preview = invoke(scratch, *options, path=path)
    assert preview["pruned"] == ["__pycache__"] and preview["compressed"] == ["output"]
    assert not Path(preview["manifest"]).exists() and (scratch / "output").exists()
    final = invoke(scratch, *options, "--apply", path=path)
    assert final["applied"] and final["plan_sha256"] == preview["plan_sha256"]
    assert zero.exists() and not (scratch / "__pycache__").exists() and not (scratch / "output").exists()
    restored = (lzma.open(scratch / "output.xz").read() if method == "xz"
                else subprocess.check_output(["zstd", "-dc", str(scratch / "output.zst")]))
    assert restored == original
    recorded = json.loads(Path(final["manifest"]).read_bytes())["plan"]["inventory"]
    assert recorded["__pycache__/bytecode.pyc"]["sha256"] == hashlib.sha256(b"cache").hexdigest()
    assert invoke(scratch, *options, "--apply", path=path) == final


@pytest.mark.parametrize("target", [".", "../__pycache__", "output", "fake/__pycache__", "link/__pycache__",
                                    "__pycache__/../output", "storage_closeout_manifest.json"])
def test_refuse_unknown_prune_and_link(scratch, target):
    outside = scratch.parent / "outside"
    (outside / "__pycache__").mkdir(parents=True)
    (outside / "__pycache__/keep").write_text("must survive")
    (scratch / "link").symlink_to(outside)
    assert invoke(scratch, "--prune", target, "--apply", code=2)["error"]
    assert (scratch / "output").is_file() and (outside / "__pycache__/keep").is_file()


@pytest.mark.parametrize("kind", ["repo", "nested", "bare", "inside-bare", "inside-project", "store",
                                  "nested-run", "pinned-evidence", "bundle"])
def test_refuse_protected_tree_before_changing_anything(scratch, kind):
    if kind in {"repo", "nested", "bare", "inside-bare"}:
        repo = {"repo": scratch, "nested": scratch / "__pycache__/nested",
                "bare": scratch / "copy", "inside-bare": scratch.parent}[kind]
        subprocess.run(["git", "init", "-q", *(["--bare"] if kind in {"bare", "inside-bare"} else []), str(repo)],
                       check=True)
    elif kind == "inside-project":
        (scratch.parent / ".nullius").mkdir()
    elif kind == "store":
        (scratch / "__pycache__/sha256").mkdir()
    elif kind == "nested-run":
        (scratch / "__pycache__/artifacts/runs").mkdir(parents=True)
    elif kind == "pinned-evidence":
        (scratch / "__pycache__/bulk_manifest.json").write_text("{}")
    else:
        (scratch / "__pycache__/backup.bundle").touch()
    assert invoke(scratch, "--apply", "--prune-caches", code=2)["error"]
    assert (scratch / "__pycache__/bytecode.pyc").exists()


def test_verdict_and_manifest_identity(scratch):
    verdict = scratch / "__pycache__/verdict"
    verdict.write_text("done")
    assert invoke(scratch, "--prune-caches", "--apply", code=2, verdict=verdict)["error"]
    outside = scratch.parent / "outside"
    outside.write_text("outside data")
    assert invoke(scratch, "--apply", code=2, verdict=outside)["error"]
    (scratch / "verdict.txt").unlink()
    (scratch / "verdict.txt").symlink_to(outside)
    assert invoke(scratch, "--apply", code=2)["error"]
    (scratch / "verdict.txt").unlink()
    (scratch / "verdict.txt").touch()
    assert invoke(scratch, "--apply", code=2)["error"]
    (scratch / "verdict.txt").write_text("done")
    (scratch / "storage_closeout_manifest.json").symlink_to(outside)
    assert invoke(scratch, "--apply", code=2)["error"]
    assert outside.read_text() == "outside data"


@pytest.mark.parametrize("after", ["retry", "new-cache", "changed-cache", "tamper", "wrong-verdict", "wrong-options"])
def test_resume_only_removes_unchanged_remainder(scratch, monkeypatch, after):
    monkeypatch.syspath_prepend(str(SCRIPTS))
    import run_storage
    import storage_closeout
    (scratch / "__pycache__/later").write_bytes(b"later")
    options = ["--prune-caches", "--no-compress", "--apply"]
    args = run_storage.build_parser().parse_args(["closeout", str(scratch), "--verdict", str(scratch / "verdict.txt"),
                                                 *options])
    unlink = Path.unlink
    with monkeypatch.context() as m:
        def interrupted(path, *a, **kw):
            if path == scratch / "__pycache__/later":
                raise InterruptedError("producer stopped here")
            return unlink(path, *a, **kw)
        m.setattr(Path, "unlink", interrupted)
        with pytest.raises(InterruptedError):
            storage_closeout.cmd_closeout(args, run_storage)
    assert not (scratch / "__pycache__/bytecode.pyc").exists()
    record = scratch / "storage_closeout_manifest.json"
    if after == "retry":
        assert invoke(scratch, *options)["applied"]
        assert not (scratch / "__pycache__").exists()
        return
    if after == "new-cache":
        (scratch / "__pycache__/new").write_text("new")
    elif after == "changed-cache":
        (scratch / "__pycache__/later").write_text("changed")
    elif after == "tamper":
        obj = json.loads(record.read_text())
        obj["plan"]["inventory"]["__pycache__/later"]["size"] = 42
        record.write_text(json.dumps(obj))
    elif after == "wrong-verdict":
        (scratch / "verdict.txt").write_text("different")
    elif after == "wrong-options":
        options.remove("--no-compress")
    assert invoke(scratch, *options, code=2)["error"]
    assert (scratch / "__pycache__/later").exists()


def test_changed_output_during_compression_survives(scratch, monkeypatch):
    monkeypatch.syspath_prepend(str(SCRIPTS))
    import run_storage
    import storage_closeout
    compress = storage_closeout.compress_file
    def modify_after_compress(s, src, *args):
        compress(s, src, *args)
        src.write_bytes(b"a newer result")
    monkeypatch.setattr(storage_closeout, "compress_file", modify_after_compress)
    args = run_storage.build_parser().parse_args(["closeout", str(scratch), "--verdict", str(scratch / "verdict.txt"),
                                                 "--apply", "--compress-min-size", "1000"])
    with pytest.raises(run_storage.StorageError, match="changed during compression"):
        storage_closeout.cmd_closeout(args, run_storage)
    assert (scratch / "output").read_bytes() == b"a newer result"


def test_parallel_apply_is_exclusive(scratch):
    fd = os.open(scratch, os.O_DIRECTORY)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX)
        assert "another closeout" in invoke(scratch, "--apply", "--prune-caches", code=2)["error"]
        assert (scratch / "__pycache__/bytecode.pyc").exists()
    finally:
        os.close(fd)


def test_renamed_bundle_under_cache_survives(scratch):
    bundle = scratch / "__pycache__/cache.data"
    bundle.write_bytes(b"# v3 git bundle\nretained bytes")
    assert invoke(scratch, "--apply", "--prune-caches", code=2)["error"]
    assert bundle.exists()


def test_compression_keeps_extended_attributes(scratch):
    path = scratch / "output"
    if sys.platform == "darwin":
        subprocess.run(["/usr/bin/xattr", "-w", "test.user", "local metadata", str(path)], check=True)
    elif hasattr(os, "setxattr"):
        os.setxattr(path, "user.test", b"local metadata")
    else:
        pytest.skip("extended attribute fixture unavailable")
    assert invoke(scratch, "--apply", "--compress-min-size", "1000")["compressed"] == []
    assert path.exists()
