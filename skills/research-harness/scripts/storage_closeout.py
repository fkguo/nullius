"""Archive a quiescent maintenance scratch tree outside research projects."""
from __future__ import annotations

import ctypes
import fcntl
import hashlib
import json
import lzma
import os
from pathlib import Path
import shutil
import stat
import subprocess
import tempfile
import unicodedata

MANIFEST = "storage_closeout_manifest.json"
MARKERS = {".git", ".nullius", "sha256", "bulk_manifest.json", "research_plan.md",
           "research_contract.md", "project_index.md", "run_origin.json",
           ".storage-closeout-quarantine", "storage_closeout_pruned"}
SUFFIX = {"xz": ".xz", "zstd": ".zst"}


def key(name):
    return unicodedata.normalize("NFC", name).casefold()


def check_tree(s, root):
    if root == Path.home().resolve() or root == root.parent:
        raise s.StorageError("closeout requires a separate scratch directory")
    for parent in (root, *root.parents):
        if (key(parent.name) in MARKERS or any(os.path.lexists(parent / n) for n in MARKERS - {"sha256"})
                or s.is_git_store(parent) or (parent / "commondir").is_file()
                or key(parent.name) == "runs" and key(parent.parent.name) == "artifacts"):
            raise s.StorageError(f"closeout cannot operate inside a repository, project or content store: {parent}")
    for here, dirs, files in os.walk(root, followlinks=False, onerror=s.walk_error):
        here = Path(here)
        names = {key(n) for n in dirs + files}
        if (names & MARKERS or s.is_git_store(here) or "commondir" in names
                or ("runs" in names and key(here.name) == "artifacts")
                or any(key(n).endswith(".bundle") for n in files)):
            raise s.StorageError(f"scratch tree contains repository, research or storage records at {here}")
        for name in files:
            f = here / name
            if f.is_symlink() or not stat.S_ISREG(f.lstat().st_mode):
                continue
            with f.open("rb") as stream:
                if stream.read(32).startswith((b"# v2 git bundle\n", b"# v3 git bundle\n")):
                    raise s.StorageError(f"scratch tree contains a Git bundle at {f}")
        for name in dirs + files:
            item = here / name
            if item.is_mount():
                raise s.StorageError(f"scratch tree crosses a mount at {item}")
            if key(name) == key(MANIFEST) and (here != root or name != MANIFEST):
                raise s.StorageError(f"ambiguous closeout manifest name: {item}")


def input_path(s, value):
    path = Path(value).expanduser().absolute()
    # macOS exposes its system temporary directories by these public aliases.
    if os.sys.platform == "darwin" and path.parts[1:2] in (("var",), ("tmp",)):
        prefix = Path("/") / path.parts[1]
        if prefix.is_symlink() and prefix.resolve() == Path("/private") / path.parts[1]:
            path = prefix.resolve() / path.relative_to(prefix)
    if ".." in path.parts or path.resolve() != path:
        raise s.StorageError(f"closeout input passes through a symbolic link or '..': {value}")
    return path


def checked_names(s, names):
    for name in names:
        if (not isinstance(name, str) or not name or name.startswith("/")
                or any(part in {"", ".", ".."} for part in name.split("/"))
                or any(key(part) in MARKERS | {key(MANIFEST)} for part in name.split("/"))):
            raise s.StorageError(f"invalid scratch-relative path: {name!r}")


def in_cache(path, targets):
    return any(path == target or path.startswith(target + "/") for target in targets)


def prune_targets(s, inventory, explicit, automatic, verdict):
    targets = set(explicit)
    if automatic:
        targets.update(p for p, r in inventory.items()
                       if r["type"] == "directory" and Path(p).name in s.REGENERABLE_DIR_NAMES)
    for p in targets:
        rec = inventory.get(p)
        name = Path(p).name
        if not rec or not (rec["type"] == "directory" and name in s.REGENERABLE_DIR_NAMES
                           or rec["type"] == "file" and (name in s.REGENERABLE_FILE_NAMES
                                                         or name.endswith(s.REGENERABLE_FILE_SUFFIXES))):
            raise s.StorageError(f"--prune requires a recognized cache file or directory: {p}")
    if in_cache(verdict, targets):
        raise s.StorageError("cannot prune a directory containing the verdict")
    return sorted(p for p in targets if not in_cache(p, targets - {p}))


def compressed_sha(path, method):
    h = hashlib.sha256()
    if method == "xz":
        with lzma.open(path, "rb") as stream:
            for block in iter(lambda: stream.read(1024 * 1024), b""):
                h.update(block)
    else:
        with subprocess.Popen(["zstd", "-qdc", "--", str(path)], stdout=subprocess.PIPE) as proc:
            for block in iter(lambda: proc.stdout.read(1024 * 1024), b""):
                h.update(block)
        if proc.returncode:
            raise ValueError(f"invalid zstd file: {path}")
    return h.hexdigest()


def compress_file(s, src, out, sha, method):
    with tempfile.NamedTemporaryFile(prefix=".closeout-", dir=out.parent, delete=False) as tmp:
        temp = Path(tmp.name)
    try:
        with temp.open("wb") as raw:
            if method == "zstd":
                subprocess.run(["zstd", "-qc", "--", str(src)], stdout=raw, check=True)
            else:
                with lzma.open(raw, "wb") as compressed, src.open("rb") as original:
                    shutil.copyfileobj(original, compressed, 1024 * 1024)
            raw.flush()
            os.fsync(raw.fileno())
        if compressed_sha(temp, method) != sha:
            raise s.StorageError(f"compressed bytes do not match original: {src}")
        st = src.stat()
        temp.chmod(stat.S_IMODE(st.st_mode))
        os.utime(temp, ns=(st.st_atime_ns, st.st_mtime_ns))
        os.link(temp, out)
        s.fsync_dir(out.parent)
    finally:
        temp.unlink(missing_ok=True)


def extra_file_data(path):
    """A compressed byte stream cannot preserve resource forks and user attributes."""
    if os.sys.platform == "darwin":
        listxattr = ctypes.CDLL(None, use_errno=True).listxattr
        listxattr.restype = ctypes.c_ssize_t
        filename = os.fsencode(path)
        size = listxattr(filename, None, 0, 0)
        if size < 0:
            raise OSError(ctypes.get_errno(), "cannot examine extended attributes", str(path))
        if not size:
            return False
        buf = ctypes.create_string_buffer(size)
        count = listxattr(filename, buf, size, 0)
        if count != size:
            raise OSError("extended attributes changed while scanning " + str(path))
        # macOS adds this bookkeeping label to ordinary temporary files too.
        return bool(set(buf.raw.split(b"\0")) - {b"", b"com.apple.provenance"})
    if hasattr(os, "listxattr"):
        return bool(os.listxattr(path, follow_symlinks=False))
    return True


def regular(path):
    return path.is_file() and not path.is_symlink()


def matches(s, path, record):
    st = path.lstat()
    kind = record["type"]
    if kind == "symlink":
        return stat.S_ISLNK(st.st_mode) and os.readlink(path) == record["target"]
    if stat.S_IMODE(st.st_mode) != record["mode"]:
        return False
    if kind == "directory":
        return stat.S_ISDIR(st.st_mode)
    return (kind == "file" and stat.S_ISREG(st.st_mode) and st.st_size == record["size"]
            and s.sha256_file(path) == record["sha256"])


def check_output(s, dst, record, method):
    if (not regular(dst) or stat.S_IMODE(dst.stat().st_mode) != record["mode"]
            or compressed_sha(dst, method) != record["sha256"]):
        raise s.StorageError(f"compressed file has changed or is incomplete: {dst}")


def closeout_locked(s, args, root, verdict):
    check_tree(s, root)
    if not verdict.is_relative_to(root) or not regular(verdict):
        raise s.StorageError("a nonempty regular verdict file inside the scratch directory is required")
    with verdict.open("rb") as stream:
        if not any(chunk.strip() for chunk in iter(lambda: stream.read(65536), b"")):
            raise s.StorageError("verdict file has no recorded content")
    rel_verdict = verdict.relative_to(root).as_posix()
    checked_names(s, [rel_verdict, *args.prune])
    if args.compress_min_size < 0:
        raise s.StorageError("negative compression threshold")
    options = dict(prune=sorted(set(args.prune)), prune_caches=args.prune_caches,
                   no_compress=args.no_compress, compress_min_size=args.compress_min_size)
    identity = dict(root=str(root), device=root.stat().st_dev, inode=root.stat().st_ino,
                    verdict=rel_verdict, verdict_sha256=s.sha256_file(verdict), options=options)
    manifest = root / MANIFEST
    resumed = os.path.lexists(manifest)
    if resumed and (not regular(manifest) or manifest.stat().st_nlink != 1):
        raise s.StorageError(f"unexpected closeout record: {manifest}")
    current = s.tree_inventory(root, skip={MANIFEST})
    if any(r["type"] == "other" for r in current.values()):
        raise s.StorageError("scratch tree contains a special file")
    if resumed:
        envelope = json.loads(manifest.read_bytes())
        plan = envelope["plan"]
        if (plan["identity"] != identity or envelope["schema"] != "scratch_closeout"
                or envelope["state"] not in {"applying", "applied"}
                or hashlib.sha256(s.canonical_json(plan)).hexdigest() != envelope["plan_sha256"]):
            raise s.StorageError("closeout record, directory, verdict or options differ; inspect before resuming")
    else:
        plan = dict(identity=identity, inventory=current,
                    kept_intact=sorted(p for p, r in current.items() if r["type"] == "file"
                                     and ((root / p).stat().st_nlink > 1 or
                                          r["size"] >= args.compress_min_size and not args.no_compress
                                          and extra_file_data(root / p))),
                    method="zstd" if shutil.which("zstd") else "xz")
        envelope = dict(schema="scratch_closeout", state="applying", plan=plan,
                        plan_sha256=hashlib.sha256(s.canonical_json(plan)).hexdigest())
    inventory = plan["inventory"]
    checked_names(s, inventory)
    if rel_verdict not in inventory or current.get(rel_verdict) != inventory[rel_verdict]:
        raise s.StorageError("verdict differs from the recorded file")
    method = plan["method"]
    suffix = SUFFIX[method]
    targets = prune_targets(s, inventory, options["prune"], args.prune_caches, rel_verdict)
    pruned = {p for p in inventory if in_cache(p, targets)}
    compressed = {p for p, r in inventory.items()
                  if not args.no_compress and r["type"] == "file" and r["size"] >= args.compress_min_size
                  and p not in pruned and p != rel_verdict and p not in plan["kept_intact"]
                  and Path(p).suffix.lower() not in s.ALREADY_COMPRESSED_SUFFIXES and p + suffix not in inventory}
    outputs = {p + suffix for p in compressed}
    # Resolve the entire plan before any mutation, including already-applied
    # steps. Never remove new cache entries or trust a changed remainder.
    for path, record in current.items():
        if path in inventory:
            if record != inventory[path]:
                raise s.StorageError(f"scratch entry changed after closeout was recorded: {path}")
        elif path in outputs:
            check_output(s, root / path, inventory[path[:-len(suffix)]], method)
        elif in_cache(path, targets):
            raise s.StorageError(f"new entry inside a cache selected for removal: {path}")
    for p in inventory.keys() - current.keys() - pruned:
        if p not in compressed or p + suffix not in current:
            raise s.StorageError(f"recorded entry missing: {p}")
    # A restored symlink may make a path alias an earlier entry on case-folding
    # filesystems. Only act on exact path spellings in the original inventory.
    for p in pruned | compressed:
        if (root / p).parent.resolve() != (root / p).parent:
            raise s.StorageError(f"closeout path passes through a symbolic link: {p}")
    pending_prune = pruned.intersection(current)
    pending_compress = compressed.intersection(current)
    for p in pending_compress:
        if (root / p).stat().st_nlink != 1 or extra_file_data(root / p):
            raise s.StorageError(f"original now has additional hard links or attributes: {p}")
        if os.path.lexists(root / (p + suffix)) and p + suffix not in current:
            raise s.StorageError(f"compressed name aliases an existing entry: {p}")
    if envelope["state"] == "applied" and (pending_prune or pending_compress):
        raise s.StorageError("files reappeared after closeout; inspect before proceeding")
    if args.apply and envelope["state"] != "applied":
        s.write_atomic(manifest, s.canonical_json(envelope), mode=0o600)
        for p in sorted(pending_prune, key=lambda p: (-p.count("/"), p)):
            target = root / p
            if target.parent.resolve() != target.parent or not matches(s, target, inventory[p]):
                raise s.StorageError(f"cache entry changed: {target}")
            if inventory[p]["type"] == "directory":
                target.rmdir()  # never recursively delete unrecorded contents
            else:
                target.unlink()
            s.fsync_dir(target.parent)
        for p in sorted(pending_compress):
            src, dst = root / p, root / (p + suffix)
            record = inventory[p]
            if src.parent.resolve() != src.parent or not matches(s, src, record) or src.stat().st_nlink != 1 or extra_file_data(src):
                raise s.StorageError(f"original changed: {src}")
            if not os.path.lexists(dst):
                compress_file(s, src, dst, record["sha256"], method)
            check_output(s, dst, record, method)
            if src.parent.resolve() != src.parent or not matches(s, src, record) or src.stat().st_nlink != 1 or extra_file_data(src):
                raise s.StorageError(f"original changed during compression: {src}")
            src.unlink()
            s.fsync_dir(src.parent)
        envelope["state"] = "applied"
        s.write_atomic(manifest, s.canonical_json(envelope), mode=0o600)
    applied = envelope["state"] == "applied"
    result = dict(applied=applied, pruned=targets, compressed=sorted(compressed),
                  method=method, plan_sha256=envelope["plan_sha256"], manifest=str(manifest))
    lines = [f"Scratch closeout {'applied' if applied else 'preview'} for {root}"]
    lines.extend(f"  prune {p}" for p in targets)
    lines.extend(f"  compress {p} to {p}{suffix}" for p in sorted(compressed))
    s.emit(result, args.json, lines)
    return 0


def cmd_closeout(args, storage):
    s = storage
    root = input_path(s, args.dir)
    verdict = input_path(s, args.verdict)
    fd = os.open(root, os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        fcntl.flock(fd, (fcntl.LOCK_EX if args.apply else fcntl.LOCK_SH) | fcntl.LOCK_NB)
        return closeout_locked(s, args, root, verdict)
    except BlockingIOError as exc:
        raise s.StorageError(f"another closeout is using {root}") from exc
    except (ValueError, TypeError, AttributeError, KeyError, lzma.LZMAError, subprocess.CalledProcessError) as exc:
        raise s.StorageError(f"invalid closeout record or compressed file: {exc}") from exc
    finally:
        os.close(fd)
