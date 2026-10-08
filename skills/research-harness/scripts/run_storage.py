#!/usr/bin/env python3
"""Run storage: keep bulk run outputs out of git history without losing them.

Every byte of a tracked file exists once per checkout (the main checkout and
every linked worktree) plus once in the object store, and snapshot refs that
pin run origins keep historical blobs alive permanently. Small text evidence
(scripts, configs, tables, logs, manifests) belongs in git; bulk numerical or
binary outputs above a size threshold do not. This tool implements that
policy for a project repository and provides the generic storage hygiene the
same policy needs elsewhere (scratch trees, acceptance runs).

Size policy (project repositories)
  A file under a run root (default ``artifacts/runs``) whose size is at or
  above the threshold (default 5 MiB) is BULK, whatever its format: large
  text tables cost as much per checkout as binary dumps. Bulk outputs are
  "stowed" after the run finishes: placed once, by sha256, into a content
  store shared by every worktree of the repository (default
  ``<git common dir>/nullius/store``; never checked out, untouched by
  ``git clean`` and ``git worktree remove``) as an independent file (a
  copy-on-write clone where the file system supports it, otherwise a
  verified copy). The run directory keeps its file, made read-only and
  readable in place; a tracked ``bulk_manifest.json`` records path, size and
  sha256, and a managed block in the run directory's ``.gitignore`` lists
  exactly those paths. The code-origin snapshot of later runs therefore
  carries the hashes of the bulk inputs, while the bulk bytes stay out of
  history.

  Optional ``.nullius/storage_policy.json``:
    {"schema": "storage_policy_v1", "bulk_threshold_bytes": 5242880,
     "run_roots": ["artifacts/runs"], "store_root": "/absolute/path"}

Subcommands
  check             report bulk files under the run roots (``--staged``: in
                    the index, i.e. about to be committed). Warns; exits 1
                    only with ``--strict``.
  install-hook      install a pre-commit hook running ``check --staged``
                    (never overwrites a foreign hook).
  stow              place a finished run's bulk outputs in the store (an
                    independent clone or verified copy; the run's file stays
                    in place, read-only) + manifest + ignore block.
  verify            check every manifest entry against its sha256, in place
                    or in the store.
  materialize       recreate missing manifest entries in place from the
                    store (e.g. in another worktree or clone).
  worktree-check    read-only: can a linked worktree be removed without
                    losing anything? Lists ignored outputs that exist only
                    there (``git worktree remove`` deletes them silently).
  sparse-exclude-bulk
                    in a linked worktree, leave tracked bulk files out of the
                    checkout (sparse checkout; reversible).
  report            read-only estimate of reclaimable bytes under any trees:
                    duplicate content, regenerable directories, separate
                    history copies and bundles already contained in a
                    reference repository, stale temporary run roots, and a
                    rough compression estimate.
  closeout          after a verdict is recorded: write a full hash manifest,
                    remove the regenerable paths named by the caller,
                    compress remaining large files. Plans by default;
                    ``--apply`` executes.
  store-put         put files into a content store (prints sha256 and path).
  tree-digest       one digest for a whole tree (sha256 of its canonical
                    inventory); with ``--store`` the inventory is stored
                    under that digest, and ``--compare`` lists differences.

Exit codes: 0 clean; 1 findings (strict-check violations, verification
problems, a worktree that must be kept); 2 usage or environment error.
POSIX (macOS/Linux) only. Nothing here deletes data except ``closeout
--apply`` (only the paths it is told to prune, after recording their
per-file inventory) and ``sparse-exclude-bulk`` (removes tracked, unmodified
files from a worktree's checkout; ``git sparse-checkout disable`` restores
them).

Operating assumptions: one user's own files (not an adversarial setting),
and nothing still writing into a tree that is being stowed or closed out.
Hashes are re-checked immediately before each irreversible step, but a
process that keeps a file open can still write after the last check; run
``stow`` and ``closeout`` only after the producing processes have stopped.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import lzma
import os
import posixpath
import secrets
import shlex
import shutil
import stat
import subprocess
import sys
import tempfile
import time
import unicodedata
import zlib
from datetime import datetime, timezone
from pathlib import Path

DEFAULT_THRESHOLD = 5 * 1024 * 1024
DEFAULT_RUN_ROOTS = ("artifacts/runs",)
POLICY_REL = ".nullius/storage_policy.json"
POLICY_SCHEMA = "storage_policy_v1"
MANIFEST_NAME = "bulk_manifest.json"
MANIFEST_SCHEMA = "bulk_manifest_v1"
CLOSEOUT_MANIFEST_NAME = "storage_closeout_manifest.json"
CLOSEOUT_SCHEMA = "storage_closeout_v1"
GITIGNORE_BEGIN = "# >>> bulk outputs kept outside git history (run_storage.py stow) >>>"
GITIGNORE_END = "# <<< bulk outputs kept outside git history <<<"
HOOK_MARKER = "# run_storage.py pre-commit check"
STORE_SUBPATH = ("nullius", "store")

# Directories whose content is rebuilt by a tool from recorded inputs.
REGENERABLE_DIR_NAMES = frozenset({
    "node_modules", "__pycache__", ".pytest_cache", ".mypy_cache", ".ruff_cache",
    ".tox", ".ipynb_checkpoints",
})
REGENERABLE_FILE_SUFFIXES = (".pyc", ".pyo")
REGENERABLE_FILE_NAMES = frozenset({".DS_Store"})
# Machine-local bookkeeping the project template keeps out of git (rewritten
# by the tool itself; never research content).
MACHINE_BOOKKEEPING = (".nullius/HARNESS_INVOCATION", ".nullius/ledger.jsonl", ".nullius/backups/")
ALREADY_COMPRESSED_SUFFIXES = frozenset({
    ".gz", ".tgz", ".zst", ".xz", ".bz2", ".zip", ".7z", ".lz4",
    ".png", ".jpg", ".jpeg", ".gif", ".webp", ".pdf", ".mp4", ".mov", ".npz",
})

EXIT_OK, EXIT_FINDINGS, EXIT_ERROR = 0, 1, 2
CHUNK = 1024 * 1024


class StorageError(Exception):
    """Usage or environment problem (exit 2)."""


# ---------------------------------------------------------------- utilities

def utc_now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def human(n: float) -> str:
    for unit in ("B", "KiB", "MiB", "GiB", "TiB"):
        if abs(n) < 1024 or unit == "TiB":
            return f"{n:.0f} {unit}" if unit == "B" else f"{n:.2f} {unit}"
        n /= 1024
    return f"{n:.2f} TiB"


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for block in iter(lambda: fh.read(CHUNK), b""):
            h.update(block)
    return h.hexdigest()


def canonical_json(obj) -> bytes:
    return (json.dumps(obj, sort_keys=True, separators=(",", ":"), ensure_ascii=False) + "\n").encode("utf-8")


def fsync_dir(path: Path) -> None:
    try:
        fd = os.open(path, os.O_RDONLY)
    except OSError:
        return
    try:
        os.fsync(fd)
    except OSError:
        pass
    finally:
        os.close(fd)


def write_atomic(path: Path, data: bytes, mode: int = 0o644) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=path.parent)
    try:
        with os.fdopen(fd, "wb") as fh:
            fh.write(data)
            fh.flush()
            os.fsync(fh.fileno())
        os.chmod(tmp, mode)
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise
    fsync_dir(path.parent)


def write_json_atomic(path: Path, obj) -> None:
    write_atomic(path, (json.dumps(obj, indent=2, sort_keys=True, ensure_ascii=False) + "\n").encode("utf-8"))


def is_under(child: Path, parent: Path) -> bool:
    try:
        child.resolve().relative_to(parent.resolve())
        return True
    except ValueError:
        return False


def is_regenerable(rel_posix: str) -> bool:
    parts = rel_posix.split("/")
    if any(part in REGENERABLE_DIR_NAMES for part in parts[:-1]):
        return True
    name = parts[-1]
    return name in REGENERABLE_FILE_NAMES or name.endswith(REGENERABLE_FILE_SUFFIXES) or name in REGENERABLE_DIR_NAMES


def is_machine_bookkeeping(rel_posix: str) -> bool:
    return any(rel_posix == p or (p.endswith("/") and rel_posix.startswith(p)) for p in MACHINE_BOOKKEEPING)


def emit(result: dict, as_json: bool, lines: "list[str]") -> None:
    if as_json:
        print(json.dumps(result, indent=2, sort_keys=True, ensure_ascii=False))
    else:
        for line in lines:
            print(line)


# ---------------------------------------------------------------------- git

def git(args: "list[str]", cwd: Path, check: bool = True, input_bytes: "bytes | None" = None,
        literal_pathspecs: bool = True) -> subprocess.CompletedProcess:
    # Never fetch: a partial clone would otherwise download missing objects
    # (network, credentials, and new packs written into a copy being read).
    # File names are passed as literal pathspecs (a name like ":(exclude)x" is just a name).
    env = dict(os.environ, GIT_OPTIONAL_LOCKS="0", LC_ALL="C", GIT_NO_LAZY_FETCH="1", GIT_TERMINAL_PROMPT="0")
    if literal_pathspecs:  # check-ignore rejects this mode; it refuses magic-looking names instead
        env["GIT_LITERAL_PATHSPECS"] = "1"
    proc = subprocess.run(
        ["git", "-c", "core.quotepath=off", "-c", "core.fsmonitor=false", "-c", "protocol.allow=never", *args],
        cwd=str(cwd), input=input_bytes, capture_output=True, env=env,
    )
    if check and proc.returncode != 0:
        raise StorageError(f"git {' '.join(args)} failed in {cwd}: {proc.stderr.decode(errors='replace').strip()}")
    return proc


def git_text(args: "list[str]", cwd: Path) -> str:
    return git(args, cwd).stdout.decode("utf-8", errors="surrogateescape").strip()


def git_z(args: "list[str]", cwd: Path) -> "list[str]":
    out = git(args, cwd).stdout.decode("utf-8", errors="surrogateescape")
    return [item for item in out.split("\0") if item]


class Repo:
    """A checkout (main or linked worktree) of a git repository."""

    def __init__(self, start: Path):
        start = Path(start).resolve()
        if start.is_file():
            start = start.parent
        if not start.exists():
            raise StorageError(f"path does not exist: {start}")
        proc = git(["rev-parse", "--show-toplevel"], start, check=False)
        if proc.returncode != 0:
            raise StorageError(f"not inside a git working tree: {start}")
        self.toplevel = Path(proc.stdout.decode().strip()).resolve()
        common = git_text(["rev-parse", "--git-common-dir"], self.toplevel)
        self.common_dir = (self.toplevel / common).resolve() if not os.path.isabs(common) else Path(common).resolve()
        git_dir = git_text(["rev-parse", "--git-dir"], self.toplevel)
        self.git_dir = (self.toplevel / git_dir).resolve() if not os.path.isabs(git_dir) else Path(git_dir).resolve()
        self.is_linked_worktree = self.git_dir != self.common_dir
        # With core.precomposeUnicode (set by `git init` on macOS) git names
        # files in composed (NFC) form whatever form the file system returns.
        self.precompose = git(["config", "--bool", "core.precomposeunicode"], self.toplevel,
                              check=False).stdout.decode().strip() == "true"
        self.policy = load_policy(self.toplevel)

    def git_form(self, rel: str) -> str:
        return unicodedata.normalize("NFC", rel) if self.precompose else rel

    @property
    def threshold(self) -> int:
        return self.policy["bulk_threshold_bytes"]

    @property
    def run_roots(self) -> "list[str]":
        return self.policy["run_roots"]

    def store(self, override: "str | None" = None) -> Path:
        if override:
            return Path(override).expanduser().resolve()
        configured = self.policy.get("store_root")
        if configured:
            return Path(configured).expanduser().resolve()
        return self.common_dir.joinpath(*STORE_SUBPATH)

    def rel(self, path: Path) -> str:
        """Repository-relative path; the final component is never followed,
        so a symlink inside the checkout keeps its own path."""
        path = Path(path)
        parent = Path(os.path.realpath(path.parent))
        try:
            rel = (parent / path.name).relative_to(self.toplevel).as_posix()
        except ValueError:
            raise StorageError(f"{path} resolves outside the repository {self.toplevel} "
                               "(a symlinked directory?); git does not track content behind symlinks")
        return self.git_form(rel)

    def tracked(self, pathspecs: "list[str]") -> "set[str]":
        return set(git_z(["ls-files", "-z", "--", *pathspecs], self.toplevel)) if pathspecs else set()

    def untracked(self, pathspecs: "list[str]") -> "set[str]":
        return set(git_z(["ls-files", "-z", "--others", "--exclude-standard", "--", *pathspecs], self.toplevel))

    def ignored(self, pathspecs: "list[str]") -> "set[str]":
        return set(git_z(["ls-files", "-z", "--others", "--ignored", "--exclude-standard", "--", *pathspecs],
                         self.toplevel))


def load_policy(toplevel: Path) -> dict:
    policy = {"bulk_threshold_bytes": DEFAULT_THRESHOLD, "run_roots": list(DEFAULT_RUN_ROOTS), "store_root": None}
    path = toplevel / POLICY_REL
    if not path.exists():
        return policy
    try:
        doc = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        raise StorageError(f"{POLICY_REL}: unreadable ({exc})")
    if not isinstance(doc, dict) or doc.get("schema") != POLICY_SCHEMA:
        raise StorageError(f"{POLICY_REL}: expected an object with schema '{POLICY_SCHEMA}'")
    unknown = set(doc) - {"schema", "bulk_threshold_bytes", "run_roots", "store_root"}
    if unknown:
        raise StorageError(f"{POLICY_REL}: unknown fields {sorted(unknown)}")
    if "bulk_threshold_bytes" in doc:
        value = doc["bulk_threshold_bytes"]
        if not isinstance(value, int) or isinstance(value, bool) or value <= 0:
            raise StorageError(f"{POLICY_REL}: bulk_threshold_bytes must be a positive integer")
        policy["bulk_threshold_bytes"] = value
    if "run_roots" in doc:
        roots = doc["run_roots"]
        if (not isinstance(roots, list) or not roots
                or not all(isinstance(r, str) and r and not r.startswith("/") and ".." not in r.split("/")
                           for r in roots)):
            raise StorageError(f"{POLICY_REL}: run_roots must be a non-empty list of relative paths")
        policy["run_roots"] = [r.strip("/") for r in roots]
    if doc.get("store_root") is not None:
        root = doc["store_root"]
        if not isinstance(root, str) or not Path(root).expanduser().is_absolute():
            # A relative store would resolve inside each checkout, so removing a
            # worktree could delete the very store that was meant to outlive it.
            raise StorageError(f"{POLICY_REL}: store_root must be an absolute path (or start with ~)")
        policy["store_root"] = root
    return policy


def resolve_threshold(repo: "Repo | None", override: "int | None") -> int:
    if override is not None:
        if override <= 0:
            raise StorageError("--threshold must be positive")
        return override
    return repo.threshold if repo else DEFAULT_THRESHOLD


# ------------------------------------------------------------ content store

def store_path(store: Path, sha: str) -> Path:
    return store / "sha256" / sha[:2] / sha


def verify_store_object(obj: Path, sha: str) -> bool:
    """A store object counts only when it is a regular file (never a symlink)
    whose full sha256 equals the hash it is filed under."""
    try:
        st = obj.lstat()
    except OSError:
        return False
    if not stat.S_ISREG(st.st_mode):
        return False
    try:
        return sha256_file(obj) == sha
    except OSError:
        return False


def clone_file(src: Path, dst: Path) -> bool:
    """Copy-on-write clone of ``src`` at the new path ``dst``: an independent
    file that shares data blocks until either side is modified. True only
    when the file system really cloned (APFS clonefile, Linux FICLONE)."""
    if sys.platform == "darwin":
        try:
            import ctypes
            import ctypes.util
            libc = ctypes.CDLL(ctypes.util.find_library("c"), use_errno=True)
            fn = libc.clonefile
            fn.argtypes = [ctypes.c_char_p, ctypes.c_char_p, ctypes.c_uint32]
            fn.restype = ctypes.c_int
            return fn(os.fsencode(str(src)), os.fsencode(str(dst)), 0) == 0
        except (OSError, AttributeError):
            return False
    if sys.platform.startswith("linux"):
        import fcntl
        ficlone = 0x40049409
        try:
            with open(src, "rb") as s_fh, open(dst, "xb") as d_fh:
                fcntl.ioctl(d_fh.fileno(), ficlone, s_fh.fileno())
            return True
        except OSError:
            try:
                os.unlink(dst)
            except OSError:
                pass
            return False
    return False


def incoming_path(directory: Path) -> Path:
    return directory / f".incoming-{os.getpid()}-{secrets.token_hex(8)}"


def fsync_file(path: Path) -> None:
    fd = os.open(path, os.O_RDONLY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def copy_file_durably(src: Path, dst: Path) -> None:
    with open(src, "rb") as s_fh, open(dst, "xb") as d_fh:
        shutil.copyfileobj(s_fh, d_fh, CHUNK)
        d_fh.flush()
        os.fsync(d_fh.fileno())


def set_aside_damaged(obj: Path) -> Path:
    """Move a store object whose bytes do not match its name out of the way.
    Nothing is deleted: the damaged bytes stay next to it for inspection."""
    aside = obj.with_name(f"{obj.name}.damaged-{datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')}-"
                          f"{secrets.token_hex(4)}")
    os.rename(obj, aside)
    print(f"run-storage: store object {obj} did not match its hash; moved to {aside.name}", file=sys.stderr)
    return aside


def publish(tmp: Path, dest: Path, sha: str) -> bool:
    """Create ``dest`` from the verified ``tmp`` without ever replacing an
    existing name. Returns False when an equal object was already there."""
    try:
        os.link(tmp, dest)
    except FileExistsError:
        if verify_store_object(dest, sha):
            return False
        set_aside_damaged(dest)
        os.link(tmp, dest)
    fsync_dir(dest.parent)
    return True


def store_put(path: Path, store: Path) -> "tuple[str, Path, str]":
    """Place ``path``'s bytes into ``store`` under their sha256, as a file
    independent of ``path``: a copy-on-write clone where the file system
    supports it (no extra blocks), otherwise a durable byte copy. The store
    never shares an inode with a user-visible file, so editing a run's file
    can never alter the stored evidence or another run's copy. An existing
    object is trusted only after its full hash is verified; a damaged one is
    set aside (never deleted) and replaced. The source is hashed before and
    after, so a file still being written is refused. Returns (sha256,
    object, method) with method in {"existing", "clone", "copy"}.
    """
    path = Path(path)
    st = path.lstat()
    if not stat.S_ISREG(st.st_mode):
        raise StorageError(f"not a regular file: {path}")
    sha = sha256_file(path)
    dest = store_path(store, sha)
    dest.parent.mkdir(parents=True, exist_ok=True)
    if dest.exists() or dest.is_symlink():
        if verify_store_object(dest, sha):
            return sha, dest, "existing"
        set_aside_damaged(dest)
    tmp = incoming_path(dest.parent)
    try:
        if os.stat(dest.parent).st_dev == st.st_dev and clone_file(path, tmp):
            method = "clone"
        else:
            copy_file_durably(path, tmp)
            method = "copy"
        if sha256_file(tmp) != sha or sha256_file(path) != sha:
            raise StorageError(f"{path} changed while being stored; stow it after the run has finished writing")
        os.chmod(tmp, 0o444)
        fsync_file(tmp)
        if not publish(tmp, dest, sha):
            method = "existing"
    finally:
        try:
            os.unlink(tmp)
        except FileNotFoundError:
            pass
    return sha, dest, method


def store_put_bytes(data: bytes, store: Path) -> "tuple[str, Path]":
    sha = hashlib.sha256(data).hexdigest()
    dest = store_path(store, sha)
    if (dest.exists() or dest.is_symlink()) and verify_store_object(dest, sha):
        return sha, dest
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = incoming_path(dest.parent)
    try:
        with open(tmp, "xb") as fh:
            fh.write(data)
            fh.flush()
            os.fsync(fh.fileno())
        os.chmod(tmp, 0o444)
        if dest.exists() or dest.is_symlink():
            set_aside_damaged(dest)
        publish(tmp, dest, sha)
    finally:
        try:
            os.unlink(tmp)
        except FileNotFoundError:
            pass
    return sha, dest


def place_from_store(obj: Path, target: Path, sha: str) -> str:
    """Create ``target`` (absent) as an independent read-only file with the
    bytes of the verified store object: a clone, else a byte copy. Returns
    the method."""
    tmp = incoming_path(target.parent)
    try:
        if clone_file(obj, tmp):
            method = "clone"
        else:
            copy_file_durably(obj, tmp)
            method = "copy"
        if sha256_file(tmp) != sha:
            raise StorageError(f"placing {target} from the store produced different bytes")
        os.chmod(tmp, 0o444)
        os.link(tmp, target)  # never replaces an existing name
        fsync_dir(target.parent)
    finally:
        try:
            os.unlink(tmp)
        except FileNotFoundError:
            pass
    return method


# ------------------------------------------------------------ tree digests

def tree_inventory(root: Path, skip: "set[str] | None" = None) -> dict:
    """Inventory of every entry under ``root``: {relative path: record}.
    Symlinks are recorded by target, never followed."""
    root = Path(root)
    skip = skip or set()
    inventory: dict = {}
    for dirpath, dirnames, filenames in os.walk(root, followlinks=False):
        here = Path(dirpath)
        dirnames.sort()
        for name in sorted(dirnames + filenames):
            full = here / name
            rel = full.relative_to(root).as_posix()
            if rel in skip:
                if name in dirnames:
                    dirnames.remove(name)
                continue
            st = full.lstat()
            mode = stat.S_IMODE(st.st_mode)
            if stat.S_ISLNK(st.st_mode):
                inventory[rel] = {"type": "symlink", "target": os.readlink(full)}
            elif stat.S_ISDIR(st.st_mode):
                inventory[rel] = {"type": "directory", "mode": mode}
            elif stat.S_ISREG(st.st_mode):
                inventory[rel] = {"type": "file", "mode": mode, "size": st.st_size, "sha256": sha256_file(full)}
            else:
                inventory[rel] = {"type": "other", "mode": mode}
    return inventory


def tree_digest(inventory: dict) -> str:
    return hashlib.sha256(canonical_json(inventory)).hexdigest()


def diff_inventories(a: dict, b: dict) -> dict:
    return {
        "added": sorted(set(b) - set(a)),
        "removed": sorted(set(a) - set(b)),
        "changed": sorted(k for k in set(a) & set(b) if a[k] != b[k]),
    }


# ------------------------------------------------------------- manifests

def load_manifest(run_dir: Path) -> "dict | None":
    path = run_dir / MANIFEST_NAME
    if not path.exists():
        return None
    try:
        doc = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        raise StorageError(f"{path}: unreadable ({exc})")
    if not isinstance(doc, dict) or doc.get("schema") != MANIFEST_SCHEMA or not isinstance(doc.get("entries"), list):
        raise StorageError(f"{path}: expected schema '{MANIFEST_SCHEMA}' with an entries list")
    for entry in doc["entries"]:
        if (not isinstance(entry, dict) or not isinstance(entry.get("path"), str)
                or not isinstance(entry.get("sha256"), str) or len(entry["sha256"]) != 64
                or not isinstance(entry.get("size"), int)
                or entry["path"].startswith("/") or ".." in entry["path"].split("/")):
            raise StorageError(f"{path}: malformed entry {entry!r}")
    return doc


def manifests_under(repo: Repo) -> "dict[str, tuple[Path, dict]]":
    """Map repository-relative path -> (run directory, manifest entry) for
    every bulk manifest under the run roots."""
    found: dict = {}
    for root in repo.run_roots:
        base = repo.toplevel / root
        if not base.is_dir() or base.is_symlink():
            continue
        for dirpath, dirnames, filenames in os.walk(base, followlinks=False):
            if MANIFEST_NAME in filenames:
                run_dir = Path(dirpath)
                doc = load_manifest(run_dir)
                run_rel = run_dir.relative_to(repo.toplevel).as_posix()  # walked inside the checkout
                for entry in doc["entries"]:
                    # Lexical path: a symlinked ancestor must not move the key elsewhere.
                    found[repo.git_form(posixpath.join(run_rel, entry["path"]))] = (run_dir, entry)
    return found


def gitignore_escape(rel: str) -> str:
    if "\n" in rel or "\r" in rel:
        raise StorageError(f"cannot express a path containing a newline in .gitignore: {rel!r}")
    out = []
    for ch in rel:
        if ch in "\\*?[]!#":
            out.append("\\" + ch)
        else:
            out.append(ch)
    escaped = "".join(out)
    stripped = escaped.rstrip(" ")
    return "/" + stripped + "\\ " * (len(escaped) - len(stripped))


def check_ignore_markers(run_dir: Path) -> None:
    """The managed block must be absent or exactly one BEGIN ... END pair in
    that order; anything else would make the rewrite drop user rules."""
    path = run_dir / ".gitignore"
    if not path.exists():
        return
    inside, blocks = False, 0
    for line in path.read_text(encoding="utf-8").splitlines():
        if line == GITIGNORE_BEGIN:
            if inside:
                break
            inside, blocks = True, blocks + 1
        elif line == GITIGNORE_END:
            if not inside:
                inside = None
                break
            inside = False
    else:
        if not inside and blocks <= 1:
            return
    raise StorageError(f"{path}: the managed block markers are not one BEGIN...END pair (edited by hand?); "
                       "repair them before stowing so no user rule is lost")


def update_ignore_block(run_dir: Path, rel_paths: "list[str]") -> None:
    check_ignore_markers(run_dir)
    path = run_dir / ".gitignore"
    lines = path.read_text(encoding="utf-8").splitlines() if path.exists() else []
    kept: "list[str]" = []
    inside = False
    for line in lines:
        if line == GITIGNORE_BEGIN:
            inside = True
            continue
        if line == GITIGNORE_END:
            inside = False
            continue
        if not inside:
            kept.append(line)
    while kept and not kept[-1].strip():
        kept.pop()
    block = [GITIGNORE_BEGIN, *[gitignore_escape(p) for p in sorted(rel_paths)], GITIGNORE_END]
    text = "\n".join(kept + ([""] if kept else []) + block) + "\n"
    write_atomic(path, text.encode("utf-8"))


# ------------------------------------------------------------------ check

def staged_bulk(repo: Repo, threshold: int) -> "list[dict]":
    changed = git_z(["diff", "--cached", "--name-only", "-z", "--diff-filter=ACMRT", "--", *repo.run_roots],
                    repo.toplevel)
    if not changed:
        return []
    stage = git_z(["ls-files", "--stage", "-z", "--", *changed], repo.toplevel)
    shas: "dict[str, str]" = {}
    for item in stage:
        meta, _, path = item.partition("\t")
        parts = meta.split()
        if len(parts) >= 2 and parts[0] != "160000":
            shas[path] = parts[1]
    if not shas:
        return []
    batch = git(["cat-file", "--batch-check=%(objectname) %(objectsize)"], repo.toplevel,
                input_bytes=("\n".join(shas.values()) + "\n").encode()).stdout.decode().splitlines()
    sizes = {}
    for line in batch:
        parts = line.split()
        if len(parts) == 2 and parts[1].isdigit():
            sizes[parts[0]] = int(parts[1])
    return sorted(({"path": p, "size": sizes[s]} for p, s in shas.items() if sizes.get(s, 0) >= threshold),
                  key=lambda r: (-r["size"], r["path"]))


def working_tree_bulk(repo: Repo, threshold: int) -> "dict[str, list[dict]]":
    roots = [r for r in repo.run_roots if (repo.toplevel / r).is_dir() and not (repo.toplevel / r).is_symlink()]
    skipped = [r for r in repo.run_roots if (repo.toplevel / r).is_symlink()]
    classes: "dict[str, list[dict]]" = {"tracked": [], "untracked": [], "ignored_unstowed": [],
                                        "stowed": [], "stowed_damaged": [],
                                        "skipped_symlinked_roots": [{"path": r, "size": 0} for r in skipped]}
    if not roots:
        return classes
    tracked = repo.tracked(roots)
    untracked = repo.untracked(roots)
    stowed = manifests_under(repo)
    store = repo.store()
    # Every recorded entry is checked by full hash, whatever its current size:
    # a stowed output that changed, shrank, vanished, or lost its store copy
    # is not "stowed" any more.
    for rel, (run_dir, entry) in sorted(stowed.items()):
        status = entry_status(run_dir, store, entry)
        record = {"path": rel, "size": entry["size"], "status": status["status"]}
        good = status["status"] in ("ok", "in_store_only")
        classes["stowed" if good else "stowed_damaged"].append(record)
    for root in roots:
        for dirpath, dirnames, filenames in os.walk(repo.toplevel / root, followlinks=False):
            for name in filenames:
                full = Path(dirpath) / name
                st = full.lstat()
                if not stat.S_ISREG(st.st_mode) or st.st_size < threshold:
                    continue
                rel = repo.rel(full)
                record = {"path": rel, "size": st.st_size}
                if rel in tracked:
                    classes["tracked"].append(record)
                elif rel in untracked:
                    classes["untracked"].append(record)
                elif rel in stowed:
                    continue  # classified above by hash
                else:
                    classes["ignored_unstowed"].append(record)
    for records in classes.values():
        records.sort(key=lambda r: (-r["size"], r["path"]))
    return classes


def cmd_check(args) -> int:
    repo = Repo(args.project_root)
    threshold = resolve_threshold(repo, args.threshold)
    if args.staged:
        found = staged_bulk(repo, threshold)
        result = {"mode": "staged", "threshold_bytes": threshold, "run_roots": repo.run_roots, "staged_bulk": found}
        lines = []
        if found:
            lines.append(f"run-storage: {len(found)} staged file(s) under {', '.join(repo.run_roots)} at or above "
                         f"{human(threshold)} would enter git history permanently:")
            lines += [f"  {human(r['size']):>12}  {r['path']}" for r in found]
            lines.append("  Keep bulk outputs out of history: git restore --staged <path>, then "
                         "run_storage.py stow <run_dir> (see research-harness: Run Storage).")
        else:
            lines.append(f"run-storage: no staged file at or above {human(threshold)} under the run roots.")
        emit(result, args.json, lines if (found or not args.quiet) else [])
        return EXIT_FINDINGS if (found and args.strict) else EXIT_OK
    classes = working_tree_bulk(repo, threshold)
    result = {"mode": "working_tree", "threshold_bytes": threshold, "run_roots": repo.run_roots,
              **{k: v for k, v in classes.items()}}
    labels = {
        "tracked": "already in git history (every checkout and the object store hold a copy)",
        "untracked": "untracked and not ignored (a plain `git add` would commit them)",
        "ignored_unstowed": "ignored but not stowed (lost if this checkout is removed)",
        "stowed_damaged": "recorded in a bulk manifest but changed, missing, or without a valid store copy",
        "stowed": "stowed (bytes match the manifest; valid copy in the content store)",
    }
    lines = [f"run-storage: bulk files (>= {human(threshold)}) under {', '.join(repo.run_roots)}:"]
    for r in classes.get("skipped_symlinked_roots", []):
        lines.append(f"  run root {r['path']} is a symbolic link; git does not track content behind it (skipped)")
    for key in ("stowed_damaged", "untracked", "ignored_unstowed", "tracked", "stowed"):
        records = classes[key]
        lines.append(f"  {len(records):5d} files {human(sum(r['size'] for r in records)):>12}  {labels[key]}")
        for r in records[: args.limit]:
            lines.append(f"        {human(r['size']):>12}  {r['path']}")
        if len(records) > args.limit:
            lines.append(f"        ... {len(records) - args.limit} more")
    emit(result, args.json, lines)
    violations = classes["untracked"] or classes["ignored_unstowed"] or classes["stowed_damaged"]
    return EXIT_FINDINGS if (violations and args.strict) else EXIT_OK


# ------------------------------------------------------------ install-hook

def cmd_install_hook(args) -> int:
    repo = Repo(args.project_root)
    hooks_dir = Path(git_text(["rev-parse", "--git-path", "hooks"], repo.toplevel))
    if not hooks_dir.is_absolute():
        hooks_dir = (repo.toplevel / hooks_dir).resolve()
    hook = hooks_dir / "pre-commit"
    script = Path(__file__).resolve()
    strict = " --strict" if args.strict else ""
    body = "\n".join([
        "#!/bin/sh",
        HOOK_MARKER,
        "# Warns when a commit adds files at or above the bulk threshold under the run roots.",
        f"SCRIPT={shlex.quote(str(script))}",
        'if [ -f "$SCRIPT" ] && command -v python3 >/dev/null 2>&1; then',
        f'  python3 "$SCRIPT" check --staged --quiet{strict}',
        "  exit $?",
        "fi",
        'echo "run-storage check skipped: $SCRIPT not found" >&2',
        "exit 0",
        "",
    ])
    if hook.exists():
        current = hook.read_text(encoding="utf-8", errors="replace")
        if HOOK_MARKER not in current:
            print(f"run-storage: {hook} already exists and was not installed by this tool; not overwriting.\n"
                  f"Add this line to it instead:\n  python3 {shlex.quote(str(script))} check --staged --quiet{strict}",
                  file=sys.stderr)
            return EXIT_ERROR
    if args.dry_run:
        print(f"would write {hook}:\n{body}")
        return EXIT_OK
    write_atomic(hook, body.encode("utf-8"), mode=0o755)
    print(f"installed {hook} ({'blocks' if args.strict else 'warns about'} commits adding bulk files)")
    return EXIT_OK


# ------------------------------------------------------------------ stow

def resolve_run_dir(repo: Repo, run_dir: str) -> Path:
    path = Path(run_dir)
    if not path.is_absolute():
        path = Path.cwd() / path
    if path.is_symlink() or not path.is_dir():
        raise StorageError(f"run directory must be a real directory: {path}")
    path = path.resolve()
    if not is_under(path, repo.toplevel):
        raise StorageError(f"{path} resolves outside the repository {repo.toplevel} (a symlinked run root?)")
    if not any(is_under(path, repo.toplevel / root) for root in repo.run_roots):
        raise StorageError(f"{path} is not under a run root ({', '.join(repo.run_roots)}); "
                           f"add its root to {POLICY_REL} if it should follow the bulk policy")
    return path


def expressible_problem(rel: str) -> "str | None":
    """Why a path cannot be recorded in the manifest and ignore block, if so."""
    try:
        rel.encode("utf-8")
    except UnicodeEncodeError:
        return "not valid UTF-8"
    try:
        gitignore_escape(rel)
    except StorageError:
        return "contains a line break"
    return None


def make_read_only(path: Path) -> None:
    st = path.lstat()
    if stat.S_ISREG(st.st_mode):
        os.chmod(path, stat.S_IMODE(st.st_mode) & ~0o222)


def share_store_blocks(full: Path, obj: Path, sha: str) -> str:
    """Replace a run file whose bytes equal a verified store object with a
    copy-on-write clone of that object, so identical outputs of different
    runs occupy their data blocks once while remaining independent files.
    Without clone support the file is left as it is."""
    tmp = incoming_path(full.parent)
    try:
        if clone_file(obj, tmp):
            os.chmod(tmp, 0o444)
            method = "existing-shared-clone"
        else:
            return "existing-separate-copy-kept"
        if sha256_file(tmp) != sha or sha256_file(full) != sha:
            raise StorageError(f"{full} changed while being stowed")
        os.replace(tmp, full)
        fsync_dir(full.parent)
        return method
    finally:
        try:
            os.unlink(tmp)
        except FileNotFoundError:
            pass


def cmd_stow(args) -> int:
    repo = Repo(args.project_root if args.project_root else args.run_dir)
    run_dir = resolve_run_dir(repo, args.run_dir)
    threshold = resolve_threshold(repo, args.threshold)
    store = repo.store(args.store)
    tracked = repo.tracked([repo.rel(run_dir)])
    manifest = load_manifest(run_dir) or {"schema": MANIFEST_SCHEMA, "entries": []}
    entries = {e["path"]: e for e in manifest["entries"]}
    check_ignore_markers(run_dir)  # before anything is changed

    # 1. Every entry already recorded must still hold its recorded bytes,
    #    whatever its current size: a recorded result is never re-recorded.
    conflicts = []
    restore = []
    for rel_run, entry in sorted(entries.items()):
        status = entry_status(run_dir, store, entry)["status"]
        if status in ("mismatch", "missing", "store_mismatch", "unsafe_path"):
            conflicts.append((rel_run, status))
        elif status == "ok_in_place_only":
            restore.append(rel_run)  # good bytes in place, store copy lost: store again

    # 2. New bulk candidates.
    candidates, legacy, unexpressible = [], [], []
    for dirpath, dirnames, filenames in os.walk(run_dir, followlinks=False):
        for name in sorted(filenames):
            full = Path(dirpath) / name
            rel_run = repo.git_form(full.relative_to(run_dir).as_posix())
            if rel_run in (MANIFEST_NAME, ".gitignore") or name == CLOSEOUT_MANIFEST_NAME or rel_run in entries:
                continue
            st = full.lstat()
            if not stat.S_ISREG(st.st_mode) or st.st_size < threshold:
                continue
            if repo.rel(full) in tracked:
                legacy.append({"path": rel_run, "size": st.st_size})
                continue
            problem = expressible_problem(rel_run)
            if problem:
                unexpressible.append((rel_run, problem))
                continue
            candidates.append((rel_run, full))
    if conflicts:
        print("run-storage: recorded outputs are changed or unavailable (nothing was changed). A changed "
              "result belongs in a new run; `missing`/`store_mismatch` entries need the store copy restored "
              "first (see `verify`):", file=sys.stderr)
        for rel_run, status in conflicts:
            print(f"  {status:>14}  {rel_run}", file=sys.stderr)
        return EXIT_FINDINGS
    if unexpressible:
        print("run-storage: these file names cannot be recorded in a manifest or ignore rule; rename them "
              "and stow again (nothing was changed):", file=sys.stderr)
        for rel_run, problem in unexpressible:
            print(f"  {problem}: {rel_run!r}", file=sys.stderr)
        return EXIT_ERROR
    plan = [(rel_run, run_dir / rel_run) for rel_run in restore] + candidates
    sizes = {rel_run: full.lstat().st_size for rel_run, full in plan}
    lines = [f"run-storage: {len(plan)} bulk file(s), {human(sum(sizes.values()))}, from {repo.rel(run_dir)} "
             f"into {store}"]
    if legacy:
        lines.append(f"  {len(legacy)} bulk file(s) are already tracked in git and stay as they are "
                     "(history is never rewritten here)")
    if args.dry_run:
        lines += [f"  would stow {human(sizes[r]):>12}  {r}" for r, _ in plan]
        emit({"dry_run": True, "planned": [{"path": r, "size": sizes[r]} for r, _ in plan],
              "already_tracked": legacy, "store": str(store)}, args.json, lines)
        return EXIT_OK

    # 3. Store, then record. The manifest is written after every store step
    #    succeeded, so a failure leaves no entry without a stored copy.
    stowed = []
    for rel_run, full in plan:
        make_read_only(full)
        sha, obj, method = store_put(full, store)
        if rel_run in entries and entries[rel_run]["sha256"] != sha:
            raise StorageError(f"{full} changed while being stowed")
        if method == "existing":
            method = share_store_blocks(full, obj, sha)
        if sha256_file(full) != sha:  # every branch: what is recorded is what is in place
            raise StorageError(f"{full} changed while being stowed; stow it after the run has finished writing")
        size = full.lstat().st_size
        if rel_run not in entries:
            entries[rel_run] = {"path": rel_run, "size": size, "sha256": sha, "stowed_utc": utc_now()}
        stowed.append({"path": rel_run, "size": size, "sha256": sha, "method": method})
        lines.append(f"  stowed {human(size):>12}  {rel_run}  ({method})")
    manifest["entries"] = sorted(entries.values(), key=lambda e: e["path"])
    manifest["threshold_bytes"] = threshold
    update_ignore_block(run_dir, [e["path"] for e in manifest["entries"]])
    write_json_atomic(run_dir / MANIFEST_NAME, manifest)
    not_ignored = []
    for entry in manifest["entries"]:
        target = run_dir / entry["path"]
        if git(["check-ignore", "-q", "--", os.path.relpath(target, repo.toplevel)], repo.toplevel,
               check=False, literal_pathspecs=False).returncode != 0:
            not_ignored.append(entry["path"])
    if not_ignored:
        print(f"run-storage: the ignore block does not cover {not_ignored}; a negation rule elsewhere "
              "re-includes them. Fix the ignore rules before committing.", file=sys.stderr)
        return EXIT_FINDINGS
    lines.append(f"  commit {repo.rel(run_dir / MANIFEST_NAME)} and {repo.rel(run_dir / '.gitignore')}; "
                 "stowed files are read-only (a corrected result goes to a new run)")
    emit({"stowed": stowed, "already_tracked": legacy, "store": str(store),
          "manifest": str(run_dir / MANIFEST_NAME)}, args.json, lines)
    return EXIT_OK


# ---------------------------------------------------------- verify / materialize

ENTRY_STATUSES = ("ok", "ok_in_place_only", "in_store_only", "mismatch", "store_mismatch", "missing", "unsafe_path")
GOOD_ENTRY_STATUSES = ("ok", "in_store_only")


def entry_path_is_safe(run_dir: Path, rel: str) -> bool:
    """A recorded path may not leave the run directory through a symlinked
    ancestor (its final component is never followed here)."""
    real_run = Path(os.path.realpath(run_dir))
    parent = Path(os.path.realpath((run_dir / rel).parent))
    return parent == real_run or is_under(parent, real_run)


def entry_status(run_dir: Path, store: Path, entry: dict) -> dict:
    """ok               in place with the recorded bytes, valid store copy
    ok_in_place_only    in place with the recorded bytes, store copy absent or damaged
    in_store_only       absent in place, valid store copy (`materialize` restores it)
    mismatch            something else occupies the path (other bytes, a symlink, a special file)
    store_mismatch      absent in place, store object damaged
    missing             absent in place and in the store
    unsafe_path         the recorded path leads out of the run directory"""
    target = run_dir / entry["path"]
    status = {"path": entry["path"], "size": entry["size"], "sha256": entry["sha256"]}
    if not entry_path_is_safe(run_dir, entry["path"]):
        status["status"] = "unsafe_path"
        return status
    store_ok = verify_store_object(store_path(store, entry["sha256"]), entry["sha256"])
    try:
        lst = target.lstat()
    except FileNotFoundError:
        lst = None
    except NotADirectoryError:  # an ancestor was replaced by a file: something else occupies the path
        status.update(status="mismatch", actual_sha256=None)
        return status
    if lst is not None:
        if not stat.S_ISREG(lst.st_mode):  # a symlink (dangling or not), FIFO, or device is not the record
            status.update(status="mismatch", actual_sha256=None)
            return status
        actual = sha256_file(target)
        if actual != entry["sha256"]:
            status.update(status="mismatch", actual_sha256=actual)
        else:
            status["status"] = "ok" if store_ok else "ok_in_place_only"
        return status
    obj = store_path(store, entry["sha256"])
    if store_ok:
        status["status"] = "in_store_only"
    elif obj.exists() or obj.is_symlink():
        status["status"] = "store_mismatch"
    else:
        status["status"] = "missing"
    return status


def cmd_verify(args) -> int:
    repo = Repo(args.project_root if args.project_root else args.run_dir)
    run_dir = resolve_run_dir(repo, args.run_dir)
    store = repo.store(args.store)
    manifest = load_manifest(run_dir)
    if manifest is None:
        raise StorageError(f"no {MANIFEST_NAME} in {run_dir}")
    statuses = [entry_status(run_dir, store, e) for e in manifest["entries"]]
    bad = [s for s in statuses if s["status"] not in GOOD_ENTRY_STATUSES]
    lines = [f"run-storage verify {repo.rel(run_dir)}: {len(statuses)} entr(y/ies)"]
    for s in statuses:
        lines.append(f"  {s['status']:>14}  {s['path']}")
    if any(s["status"] == "in_store_only" for s in statuses):
        lines.append("  in_store_only entries are intact in the store; `materialize` makes them readable in place")
    if any(s["status"] == "ok_in_place_only" for s in statuses):
        lines.append("  ok_in_place_only entries lost their store copy; `stow` stores them again")
    emit({"run_dir": str(run_dir), "store": str(store), "entries": statuses}, args.json, lines)
    return EXIT_FINDINGS if bad else EXIT_OK


def cmd_materialize(args) -> int:
    repo = Repo(args.project_root if args.project_root else args.run_dir)
    run_dir = resolve_run_dir(repo, args.run_dir)
    store = repo.store(args.store)
    manifest = load_manifest(run_dir)
    if manifest is None:
        raise StorageError(f"no {MANIFEST_NAME} in {run_dir}")
    done, problems = [], []
    for entry in manifest["entries"]:
        try:
            materialize_entry(run_dir, store, entry, args.dry_run, done, problems)
        except OSError as exc:  # e.g. an unreadable file or an ancestor that became a file
            problems.append({"path": entry["path"], "status": f"not_placed ({exc.strerror or exc})"})
    lines = [f"run-storage materialize {repo.rel(run_dir)}: {len(done)} restored, {len(problems)} unavailable"]
    lines += [f"  {d['method']:>8}  {d['path']}" for d in done]
    lines += [f"  {p['status']}  {p['path']} (left untouched)" for p in problems]
    emit({"restored": done, "unavailable": problems, "store": str(store)}, args.json, lines)
    return EXIT_FINDINGS if problems else EXIT_OK


def materialize_entry(run_dir: Path, store: Path, entry: dict, dry_run: bool, done: list, problems: list) -> None:
    """Restore one manifest entry from the store, or record why not."""
    target = run_dir / entry["path"]
    if not entry_path_is_safe(run_dir, entry["path"]):
        problems.append({"path": entry["path"], "status": "unsafe_path"})
        return
    if target.exists() or target.is_symlink():
        # Something occupies the path: fine only if it already holds the
        # recorded bytes; never overwritten.
        if target.is_symlink():
            problems.append({"path": entry["path"], "status": "occupied_by_symlink"})
        elif not target.is_file():
            problems.append({"path": entry["path"], "status": "occupied_by_non_file"})
        elif sha256_file(target) != entry["sha256"]:
            problems.append({"path": entry["path"], "status": "occupied_by_different_bytes"})
        return
    dest = store_path(store, entry["sha256"])
    if not verify_store_object(dest, entry["sha256"]):
        exists = dest.exists() or dest.is_symlink()
        problems.append({"path": entry["path"], "status": "store_mismatch" if exists else "missing"})
        return
    if dry_run:
        done.append({"path": entry["path"], "method": "planned"})
        return
    target.parent.mkdir(parents=True, exist_ok=True)
    done.append({"path": entry["path"], "method": place_from_store(dest, target, entry["sha256"])})


# ------------------------------------------------------------ worktrees

def list_worktrees(repo: Repo) -> "list[dict]":
    out = git_text(["worktree", "list", "--porcelain"], repo.toplevel)
    trees, current = [], {}
    for line in out.splitlines() + [""]:
        if not line:
            if current:
                trees.append(current)
            current = {}
            continue
        key, _, value = line.partition(" ")
        current[key] = value or True
    return trees


def default_base(repo: Repo) -> str:
    for candidate in ("main", "master"):
        if git(["rev-parse", "--verify", "--quiet", f"refs/heads/{candidate}"], repo.toplevel, check=False).returncode == 0:
            return candidate
    raise StorageError("no main/master branch found; pass --base <ref>")


def hidden_tracked_changes(path: Path) -> "list[str]":
    """Tracked files flagged assume-unchanged (lowercase tag in `ls-files -v`)
    or skip-worktree (tag S) whose type, executable bit, or bytes on disk
    differ from the index — edits `git status` does not show. A flagged file
    absent from disk is not counted (its content stays in git)."""
    flagged = []
    for item in git_z(["ls-files", "-v", "-z"], path):
        tag, rel = item[:1], item[2:]
        if tag.islower() or tag == "S":
            flagged.append(rel)
    if not flagged:
        return []
    filemode = git(["config", "--bool", "core.filemode"], path, check=False).stdout.decode().strip() != "false"
    index = {}
    for item in git_z(["ls-files", "-s", "-z", "--", *flagged], path):
        meta, _, rel = item.partition("\t")
        parts = meta.split()
        index[rel] = (parts[0], parts[1])
    changed, regular = [], []
    for rel in flagged:
        try:
            st = (path / rel).lstat()
        except FileNotFoundError:
            continue
        mode, blob = index.get(rel, (None, None))
        if mode is None or mode == "160000":
            continue
        if mode == "120000":
            if not stat.S_ISLNK(st.st_mode):
                changed.append(rel)
                continue
            link_blob = git(["hash-object", "--stdin"], path,
                            input_bytes=os.fsencode(os.readlink(path / rel))).stdout.decode().strip()
            if link_blob != blob:
                changed.append(rel)
            continue
        if not stat.S_ISREG(st.st_mode):
            changed.append(rel)
            continue
        if filemode and bool(st.st_mode & stat.S_IXUSR) != (mode == "100755"):
            changed.append(rel)
            continue
        regular.append(rel)
    batch = [rel for rel in regular if "\n" not in rel and "\r" not in rel]
    if batch:
        hashed = git(["hash-object", "--stdin-paths"], path,
                     input_bytes=("\n".join(batch) + "\n").encode("utf-8", "surrogateescape")).stdout.decode().split()
        if len(hashed) != len(batch):
            raise StorageError(f"could not hash the flagged files in {path}")
        changed += [rel for rel, sha in zip(batch, hashed) if index[rel][1] != sha]
    for rel in regular:
        if rel not in batch:  # a line break would split the --stdin-paths list
            sha = git(["hash-object", "--", rel], path).stdout.decode().strip()
            if index[rel][1] != sha:
                changed.append(rel)
    return sorted(changed)


def reflog_only_commits(path: Path) -> "list[str]":
    """Commits in this worktree's own HEAD reflog that no shared ref reaches.
    The HEAD reflog lives in the worktree's private git directory, so
    removing the worktree leaves such commits unreferenced (collectable)."""
    # Read the log file itself: `git reflog` falls back to printing HEAD alone,
    # with success, when the log is missing, corrupt, or unreadable.
    log = Path(git_text(["rev-parse", "--git-path", "logs/HEAD"], path))
    if not log.is_absolute():
        log = path / log
    if not (log.exists() or log.is_symlink()):
        return []  # no reflog: nothing is remembered only there
    try:
        data = log.read_bytes()
    except OSError as exc:
        raise StorageError(f"cannot read this worktree's HEAD reflog ({exc}); its commits cannot be assessed")
    remembered: "set[str]" = set()
    for line in data.decode("utf-8", "replace").splitlines():
        if not line.strip():
            continue
        parts = line.split(" ", 2)
        if len(parts) < 3 or not all(len(x) in (40, 64) and set(x) <= HEX for x in parts[:2]):
            raise StorageError("this worktree's HEAD reflog is not readable as a reflog; its commits cannot be assessed")
        remembered.update(x for x in parts[:2] if set(x) != {"0"})
    if remembered:
        listing = git(["cat-file", "--batch-check=%(objectname) %(objecttype)"], path,
                      input_bytes=("\n".join(sorted(remembered)) + "\n").encode()).stdout.decode().splitlines()
        remembered = {line.split()[0] for line in listing if line.endswith(" commit")}  # gone already: nothing to lose
    if not remembered:
        return []
    shared = git(["rev-list", "--exclude=refs/worktree/*", "--exclude=refs/bisect/*", "--exclude=refs/rewritten/*",
                  "--branches", "--tags", "--remotes", "--glob=refs/*", "--exclude=HEAD"], path, check=False)
    if shared.returncode != 0:
        return sorted(remembered)  # cannot tell: count every remembered commit as at risk
    reachable = set(shared.stdout.decode().split())
    return sorted(remembered - reachable)


def worktree_private_refs(path: Path, base: str) -> "list[str]":
    """Per-worktree refs (refs/worktree/*, refs/bisect/*, refs/rewritten/*)
    pointing at commits the base branch does not contain."""
    out = git(["for-each-ref", "--format=%(refname) %(objectname)", "refs/worktree/", "refs/bisect/",
               "refs/rewritten/"], path, check=False)
    held = []
    for line in out.stdout.decode().splitlines():
        name, _, sha = line.partition(" ")
        peeled = git(["rev-parse", "--verify", "--quiet", f"{sha}^{{commit}}"], path, check=False)
        commit = peeled.stdout.decode().strip() if peeled.returncode == 0 else None
        if commit is None or git(["merge-base", "--is-ancestor", commit, base], path, check=False).returncode != 0:
            held.append(name)
    return held


def check_one_worktree(path: Path, base: str, main_root: "Path | None", store: Path) -> dict:
    report: dict = {"worktree": str(path), "reasons": []}
    if not path.is_dir():
        report.update(verdict="keep", reasons=["path does not exist (prune stale metadata with `git worktree prune`)"])
        return report
    wt = Repo(path)
    path = wt.toplevel
    report["worktree"] = str(path)
    if not wt.is_linked_worktree:
        report.update(verdict="keep", reasons=["this is the main checkout, not a linked worktree"])
        return report
    store_usable = not is_under(store, path)
    if not store_usable:
        report["reasons"].append(f"the content store {store} lies inside this worktree; removing the worktree "
                                 "would delete it")
    head_proc = git(["rev-parse", "--verify", "--quiet", "HEAD"], path, check=False)
    head = head_proc.stdout.decode().strip() if head_proc.returncode == 0 else None
    branch = git(["symbolic-ref", "-q", "--short", "HEAD"], path, check=False).stdout.decode().strip() or None
    merged = head is not None and git(["merge-base", "--is-ancestor", head, base], path,
                                      check=False).returncode == 0
    report.update(head=head, branch=branch, base=base, merged=merged)
    if head is None:
        report["reasons"].append("HEAD has no commit")
    elif not merged:
        report["reasons"].append(f"HEAD {head[:12]} is not contained in {base}")
    status = git_z(["status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignore-submodules=none"], path)
    changed, untracked = [], []
    skip_next = False
    for item in status:
        if skip_next:
            skip_next = False
            continue
        code, rel = item[:2], item[3:]
        if code[0] in "RC":
            skip_next = True
        (untracked if code == "??" else changed).append(rel)
    # `git status` hides edits to files flagged assume-unchanged or
    # skip-worktree; `git worktree remove` would discard them silently.
    hidden = hidden_tracked_changes(path)
    changed += [rel for rel in hidden if rel not in changed]
    report["tracked_changes"] = changed
    report["untracked"] = untracked
    gitlinks = [item for item in git_z(["ls-files", "-z", "--stage"], path) if item.startswith("160000 ")]
    if (path / ".gitmodules").exists() or gitlinks:
        report["reasons"].append("contains submodules; their own commits and changes are not assessed here")
    reflog_only = reflog_only_commits(path)
    report["reflog_only_commits"] = reflog_only
    if reflog_only:
        report["reasons"].append(f"{len(reflog_only)} commit(s) are remembered only by this worktree's HEAD reflog "
                                 "(unreferenced once it is removed)")
    private_refs = worktree_private_refs(path, base)
    report["worktree_private_refs"] = private_refs
    if private_refs:
        report["reasons"].append(f"{len(private_refs)} worktree-private ref(s) hold commits not in {base} "
                                 "(lost with the worktree)")
    if changed:
        report["reasons"].append(f"{len(changed)} tracked change(s) not committed")
    if untracked:
        report["reasons"].append(f"{len(untracked)} untracked file(s)")
    ignored = sorted(git_z(["ls-files", "-z", "--others", "--ignored", "--exclude-standard"], path))
    classes: "dict[str, list[dict]]" = {"regenerable": [], "machine_bookkeeping": [], "in_store": [],
                                        "same_in_main_checkout": [], "unique": []}
    for rel in ignored:
        full = path / rel
        try:
            st = full.lstat()
        except OSError:
            continue
        record = {"path": rel, "size": st.st_size}
        if is_regenerable(rel):
            classes["regenerable"].append(record)
            continue
        if is_machine_bookkeeping(rel):
            classes["machine_bookkeeping"].append(record)
            continue
        if stat.S_ISLNK(st.st_mode):
            target = Path(os.path.realpath(full))
            if (store_usable and is_under(target, store) and target.parent.parent.name == "sha256"
                    and verify_store_object(target, target.name)):
                classes["in_store"].append(record)
                continue
            classes["unique"].append({**record, "symlink_target": os.readlink(full)})
            continue
        if not stat.S_ISREG(st.st_mode):
            classes["unique"].append(record)
            continue
        sha = sha256_file(full)
        if store_usable and verify_store_object(store_path(store, sha), sha):
            classes["in_store"].append(record)
            continue
        twin = main_root / rel if main_root else None
        if twin is not None:
            try:
                tst = twin.lstat()
            except OSError:
                tst = None
            # Only a regular file that lives outside this worktree survives its removal.
            if (tst is not None and stat.S_ISREG(tst.st_mode) and tst.st_size == st.st_size
                    and not is_under(twin, path) and sha256_file(twin) == sha):
                classes["same_in_main_checkout"].append(record)
                continue
        classes["unique"].append(record)
    report["ignored"] = {k: v for k, v in classes.items()}
    if classes["unique"]:
        report["reasons"].append(f"{len(classes['unique'])} ignored file(s) exist only in this worktree "
                                 "(`git worktree remove` would delete them)")
    on_disk = 0
    for dirpath, dirnames, filenames in os.walk(path, followlinks=False):
        for name in filenames:
            try:
                on_disk += (Path(dirpath) / name).lstat().st_size
            except OSError:
                pass
    report["bytes_on_disk"] = on_disk
    report["verdict"] = "safe_to_remove" if not report["reasons"] else "keep"
    if report["verdict"] == "safe_to_remove":
        report["remove_command"] = f"git worktree remove {shlex.quote(str(path))}"
    return report


def cmd_worktree_check(args) -> int:
    repo = Repo(args.project_root or (args.worktree if args.worktree else "."))
    base = args.base or default_base(repo)
    store = repo.store(args.store)
    trees = list_worktrees(repo)
    main_root = Path(trees[0]["worktree"]).resolve() if trees and "bare" not in trees[0] else None
    if args.all:
        targets = [Path(t["worktree"]) for t in trees[1:] if "bare" not in t]
    elif args.worktree:
        targets = [Path(args.worktree).resolve()]
    else:
        raise StorageError("name a worktree path or pass --all")
    reports = []
    for t in targets:
        try:
            reports.append(check_one_worktree(t, base, main_root, store))
        except (StorageError, OSError) as exc:
            reports.append({"worktree": str(t), "verdict": "keep", "reasons": [f"could not be checked: {exc}"]})
    lines = []
    for r in reports:
        lines.append(f"{r['verdict']:>14}  {r['worktree']}  ({human(r.get('bytes_on_disk', 0))} on disk)")
        for reason in r["reasons"]:
            lines.append(f"                  - {reason}")
        for rec in r.get("ignored", {}).get("unique", [])[: args.limit]:
            lines.append(f"                    only here: {rec['path']} ({human(rec['size'])})")
        if r.get("remove_command"):
            lines.append(f"                  remove with: {r['remove_command']}")
    safe = [r for r in reports if r["verdict"] == "safe_to_remove"]
    lines.append(f"{len(safe)} of {len(reports)} worktree(s) safe to remove, "
                 f"{human(sum(r.get('bytes_on_disk', 0) for r in safe))} on disk. Nothing was removed.")
    emit({"base": base, "store": str(store), "worktrees": reports}, args.json, lines)
    return EXIT_OK if len(safe) == len(reports) else EXIT_FINDINGS


def sparse_pattern(rel: str) -> str:
    return "!" + gitignore_escape(rel)


def cmd_sparse_exclude_bulk(args) -> int:
    repo = Repo(args.worktree or ".")
    if not repo.is_linked_worktree and not args.allow_main:
        raise StorageError("this is the main checkout; sparse exclusion is meant for linked worktrees "
                           "(pass --allow-main to apply it here anyway)")
    threshold = resolve_threshold(repo, args.threshold)
    if git(["config", "--bool", "core.sparseCheckout"], repo.toplevel, check=False).stdout.decode().strip() == "true":
        raise StorageError("sparse checkout is already configured in this worktree; not overwriting it "
                           "(`git sparse-checkout list` shows the current patterns)")
    listing = git_z(["ls-tree", "-r", "-l", "-z", "HEAD", "--", *repo.run_roots], repo.toplevel)
    bulk = []
    for item in listing:
        meta, _, rel = item.partition("\t")
        parts = meta.split()
        if len(parts) == 4 and parts[1] == "blob" and parts[3].isdigit() and int(parts[3]) >= threshold:
            bulk.append({"path": rel, "size": int(parts[3])})
    bulk.sort(key=lambda r: r["path"])
    total = sum(r["size"] for r in bulk)
    if not bulk:
        emit({"excluded": []}, args.json, [f"run-storage: no tracked file at or above {human(threshold)} "
                                            "under the run roots; nothing to exclude"])
        return EXIT_OK
    bulk_paths = {r["path"] for r in bulk}
    modified = set(git_z(["diff", "--name-only", "-z", "HEAD", "--", *repo.run_roots], repo.toplevel)) & bulk_paths
    modified |= set(hidden_tracked_changes(repo.toplevel)) & bulk_paths  # edits git status does not show
    if modified:
        raise StorageError(f"{len(modified)} bulk file(s) have local modifications; commit or restore them first")
    patterns = ["/*", *[sparse_pattern(r["path"]) for r in bulk]]
    lines = [f"run-storage: {len(bulk)} tracked bulk file(s), {human(total)}, left out of this checkout "
             f"({repo.toplevel})"]
    if args.dry_run:
        lines += [f"  would exclude {human(r['size']):>12}  {r['path']}" for r in bulk[: args.limit]]
        emit({"dry_run": True, "excluded": bulk}, args.json, lines)
        return EXIT_OK
    git(["sparse-checkout", "set", "--no-cone", "--stdin"], repo.toplevel,
        input_bytes=("\n".join(patterns) + "\n").encode("utf-8"))
    still_present = [r["path"] for r in bulk if (repo.toplevel / r["path"]).exists()]
    if still_present:
        print(f"run-storage: {len(still_present)} file(s) are still checked out; check the patterns with "
              "`git sparse-checkout list`", file=sys.stderr)
        return EXIT_FINDINGS
    lines.append(f"  restore the full checkout with: git -C {shlex.quote(str(repo.toplevel))} sparse-checkout disable")
    emit({"excluded": bulk, "restore_command": f"git -C {repo.toplevel} sparse-checkout disable"}, args.json, lines)
    return EXIT_OK


# ------------------------------------------------------------------ report

def dir_size(path: Path) -> "tuple[int, int, float]":
    total, count, newest = 0, 0, 0.0
    for dirpath, dirnames, filenames in os.walk(path, followlinks=False):
        for name in filenames:
            try:
                st = (Path(dirpath) / name).lstat()
            except OSError:
                continue
            total += st.st_size
            count += 1
            newest = max(newest, st.st_mtime)
    try:
        newest = max(newest, path.lstat().st_mtime)
    except OSError:
        pass
    return total, count, newest


def is_git_store(path: Path) -> bool:
    return (path / "objects").is_dir() and (path / "refs").is_dir() and (path / "HEAD").is_file()


def missing_objects(reference: Path, shas: "list[str]") -> "set[str]":
    if not shas:
        return set()
    out = git(["cat-file", "--batch-check=%(objectname) %(objecttype)"], reference,
              input_bytes=("\n".join(shas) + "\n").encode()).stdout.decode().splitlines()
    return {line.split()[0] for line in out if line.endswith(" missing")}


class DurableObjects:
    """Objects reachable from the refs of a reference repository (computed
    once per report). Objects that merely exist there, or that only a reflog
    keeps, can be removed by its garbage collection and never count."""

    def __init__(self, reference: Path):
        self.reference = reference
        self._ids: "set[str] | None" = None

    def ids(self) -> "set[str]":
        if self._ids is None:
            out = git(["rev-list", "--objects", "--all", "--missing=allow-promisor"], self.reference).stdout.decode()
            self._ids = {line.split()[0] for line in out.splitlines() if line.strip()}
        return self._ids

    def covers_closure_of(self, revs: "list[str]") -> bool:
        """True when every object reachable from ``revs`` (computed inside
        the reference) is durably reachable there."""
        if not revs or missing_objects(self.reference, revs):
            return False
        out = git(["rev-list", "--objects", "--missing=allow-promisor", "--stdin"], self.reference, check=False,
                  input_bytes=("\n".join(revs) + "\n").encode())
        if out.returncode != 0:
            return False
        closure = {line.split()[0] for line in out.stdout.decode().splitlines() if line.strip()}
        return closure <= self.ids()


def store_contained(durable: DurableObjects, git_dir: Path) -> "bool | None":
    """True when every object reachable in the separate object store (all
    refs, annotated tags, reflogs, and index entries) is durably reachable in
    the reference repository; None when the store cannot be read. Objects a
    partial clone never held are not fetched (and are not the copy's to lose)."""
    objects = git(["--git-dir", str(git_dir), "rev-list", "--objects", "--all", "--reflog", "--indexed-objects",
                   "--missing=allow-promisor"], durable.reference, check=False)
    refs = git(["--git-dir", str(git_dir), "for-each-ref", "--format=%(objectname)"], durable.reference, check=False)
    if objects.returncode != 0 or refs.returncode != 0:
        return None
    reachable = {line.split()[0] for line in objects.stdout.decode().splitlines() if line.strip()}
    reachable |= set(refs.stdout.decode().split())
    if not reachable:
        return False
    return reachable <= durable.ids()


def sample_ratio(path: Path, sample_bytes: int = 4 * CHUNK) -> float:
    with open(path, "rb") as fh:
        data = fh.read(sample_bytes)
    if not data:
        return 1.0
    return len(zlib.compress(data, 6)) / len(data)


def hash_prefix(path: Path, n: int = CHUNK) -> str:
    with open(path, "rb") as fh:
        return hashlib.sha256(fh.read(n)).hexdigest()


def cmd_report(args) -> int:
    roots = sorted({Path(r).expanduser().resolve() for r in args.roots})
    for r in roots:
        if not r.exists():
            raise StorageError(f"no such path: {r}")
    roots = [r for r in roots if not any(r != q and is_under(r, q) for q in roots)]  # overlapping roots once
    seen_dirs: set = set()
    reference = Path(args.repo).expanduser().resolve() if args.repo else None
    durable = DurableObjects(reference) if reference is not None else None
    regenerable, git_stores, bundles = [], [], []
    files: "dict[int, list[tuple[Path, int, int]]]" = {}
    seen_inodes: set = set()
    for root in roots:
        for dirpath, dirnames, filenames in os.walk(root, followlinks=False):
            here = Path(dirpath)
            for name in list(dirnames):
                full = here / name
                try:
                    dst = full.lstat()
                except OSError:
                    continue
                if (dst.st_dev, dst.st_ino) in seen_dirs:
                    dirnames.remove(name)
                    continue
                seen_dirs.add((dst.st_dev, dst.st_ino))
                if name in REGENERABLE_DIR_NAMES:
                    size, count, _ = dir_size(full)
                    regenerable.append({"path": str(full), "bytes": size, "files": count})
                    dirnames.remove(name)
                elif (name == ".git" or name.endswith(".git")) and is_git_store(full):
                    size, count, _ = dir_size(full)
                    record = {"path": str(full), "bytes": size, "kind": "git object store"}
                    if reference is not None and full.resolve() != (reference / ".git").resolve() \
                            and full.resolve() != reference:
                        record["contained_in_reference"] = store_contained(durable, full)
                    git_stores.append(record)
                    dirnames.remove(name)
            for name in filenames:
                full = here / name
                try:
                    st = full.lstat()
                except OSError:
                    continue
                if not stat.S_ISREG(st.st_mode):
                    continue
                if name.endswith(".bundle"):
                    record = {"path": str(full), "bytes": st.st_size}
                    if reference is not None:
                        heads = git(["bundle", "list-heads", str(full)], reference, check=False)
                        shas = [line.split()[0] for line in heads.stdout.decode().splitlines() if line.strip()]
                        record["contained_in_reference"] = heads.returncode == 0 and durable.covers_closure_of(shas)
                    bundles.append(record)
                if st.st_size >= args.min_size and (st.st_dev, st.st_ino) not in seen_inodes:
                    seen_inodes.add((st.st_dev, st.st_ino))
                    files.setdefault(st.st_size, []).append((full, st.st_dev, st.st_ino))
    duplicates = []
    unique_large: "list[tuple[Path, int]]" = []
    for size, group in files.items():
        if len(group) < 2:
            unique_large.append((group[0][0], size))
            continue
        by_prefix: "dict[str, list[Path]]" = {}
        for path, _, _ in group:
            by_prefix.setdefault(hash_prefix(path), []).append(path)
        for paths in by_prefix.values():
            by_full: "dict[str, list[Path]]" = {}
            if len(paths) < 2:
                unique_large.append((paths[0], size))
                continue
            for path in paths:
                by_full.setdefault(sha256_file(path), []).append(path)
            for sha, same in by_full.items():
                unique_large.append((same[0], size))
                if len(same) > 1:
                    duplicates.append({"sha256": sha, "size": size, "copies": len(same),
                                       "reclaimable": size * (len(same) - 1), "paths": [str(p) for p in same]})
    duplicates.sort(key=lambda d: -d["reclaimable"])
    unique_large.sort(key=lambda item: -item[1])
    candidates = [(p, s) for p, s in unique_large if p.suffix.lower() not in ALREADY_COMPRESSED_SUFFIXES]
    sampled = candidates[: args.compress_sample]
    compress_saving = 0.0
    for path, size in sampled:
        try:
            compress_saving += size * max(0.0, 1.0 - sample_ratio(path))
        except OSError:
            continue
    stale = []
    cutoff = time.time() - args.older_than_days * 86400
    for d in args.stale_dir:
        base = Path(d).expanduser().resolve()
        if not base.is_dir():
            continue
        for child in sorted(base.iterdir()):
            if args.stale_prefix and not any(child.name.startswith(p) for p in args.stale_prefix):
                continue
            if child.is_symlink():
                continue
            size, count, newest = dir_size(child) if child.is_dir() else (child.lstat().st_size, 1, child.lstat().st_mtime)
            if newest < cutoff:
                stale.append({"path": str(child), "bytes": size, "files": count,
                              "age_days": round((time.time() - newest) / 86400, 1)})
    redundant_bundles = [b for b in bundles if b.get("contained_in_reference")]
    redundant_stores = [g for g in git_stores if g.get("contained_in_reference")]
    summary = {
        "duplicate_content": sum(d["reclaimable"] for d in duplicates),
        "regenerable_directories": sum(r["bytes"] for r in regenerable),
        "history_copies_contained_in_reference": sum(g["bytes"] for g in redundant_stores),
        "bundles_contained_in_reference": sum(b["bytes"] for b in redundant_bundles),
        "stale_temporary_roots": sum(s["bytes"] for s in stale),
        "compression_estimate": int(compress_saving),
    }
    result = {
        "roots": [str(r) for r in roots], "reference_repo": str(reference) if reference else None,
        "min_size": args.min_size, "summary_bytes": summary,
        "duplicates": duplicates, "regenerable": sorted(regenerable, key=lambda r: -r["bytes"]),
        "git_object_stores": git_stores, "bundles": bundles, "stale": stale,
        "compression": {"sampled_files": len(sampled), "candidate_files": len(candidates)},
        "notes": [
            "Read-only: nothing was changed.",
            "Duplicate bytes are an upper bound: copy-on-write clones share blocks but look like separate files.",
            "Categories can overlap (a stale root may contain duplicates or regenerable directories).",
            "Stale temporary roots are judged by age alone; check that nothing still uses them before removing.",
            "The compression figure extrapolates a zlib ratio measured on the first 4 MiB of each sampled file.",
        ],
    }
    lines = ["run-storage report (read-only; nothing was changed)"]
    labels = {
        "duplicate_content": "identical content stored more than once",
        "regenerable_directories": "regenerable directories (dependency trees, caches)",
        "history_copies_contained_in_reference": "separate git object stores already contained in --repo",
        "bundles_contained_in_reference": "git bundles already contained in --repo",
        "stale_temporary_roots": f"temporary roots unchanged for {args.older_than_days} days "
                                 "(age only: whether a process still uses them is not checked)",
        "compression_estimate": "rough saving from compressing large files",
    }
    for key, label in labels.items():
        lines.append(f"  {human(summary[key]):>12}  {label}")
    lines.append("  Categories can overlap; duplicate bytes are an upper bound (see --json notes).")
    for d in duplicates[: args.limit]:
        lines.append(f"    dup x{d['copies']} {human(d['size']):>10}  {d['paths'][0]}")
    for r in sorted(regenerable, key=lambda r: -r["bytes"])[: args.limit]:
        lines.append(f"    regen {human(r['bytes']):>10}  {r['path']}")
    for g in git_stores[: args.limit]:
        flag = {True: "contained", False: "NOT contained"}.get(g.get("contained_in_reference"), "unchecked")
        lines.append(f"    git   {human(g['bytes']):>10}  {g['path']} ({flag})")
    for b in bundles[: args.limit]:
        flag = {True: "contained", False: "NOT contained"}.get(b.get("contained_in_reference"), "unchecked")
        lines.append(f"    bundle {human(b['bytes']):>9}  {b['path']} ({flag})")
    for s in stale[: args.limit]:
        lines.append(f"    stale {human(s['bytes']):>10}  {s['path']} ({s['age_days']} days)")
    emit(result, args.json, lines)
    return EXIT_OK


# ---------------------------------------------------------------- closeout

QUARANTINE_DIR = ".storage-closeout-quarantine"
PRUNED_INVENTORY_DIR = "storage_closeout_pruned"
RESERVED_NAMES = (CLOSEOUT_MANIFEST_NAME, QUARANTINE_DIR, PRUNED_INVENTORY_DIR)


HEX = frozenset("0123456789abcdef")


def is_sha256_hex(value) -> bool:
    return isinstance(value, str) and len(value) == 64 and set(value) <= HEX


def is_content_store_object(full: Path) -> bool:
    """<...>/sha256/<2 hex>/<64 hex>: a content-addressed object whose name
    must keep naming its bytes."""
    name, shard = full.name, full.parent.name
    return (len(name) == 64 and set(name) <= HEX and len(shard) == 2 and set(shard) <= HEX
            and name.startswith(shard) and full.parent.parent.name == "sha256")


def compression_method() -> "tuple[str, str]":
    return ("zstd", ".zst") if shutil.which("zstd") else ("xz", ".xz")


def decompressed_sha(path: Path, method: str) -> "str | None":
    h = hashlib.sha256()
    if method == "zstd":
        zstd = shutil.which("zstd")
        if not zstd:
            raise StorageError("zstd is required to read back a zstd-compressed file")
        with subprocess.Popen([zstd, "-q", "-d", "-c", str(path)], stdout=subprocess.PIPE,
                              stderr=subprocess.DEVNULL) as proc:
            for block in iter(lambda: proc.stdout.read(CHUNK), b""):
                h.update(block)
        return h.hexdigest() if proc.returncode == 0 else None
    try:
        with lzma.open(path, "rb") as fh:
            for block in iter(lambda: fh.read(CHUNK), b""):
                h.update(block)
    except (OSError, lzma.LZMAError):
        return None
    return h.hexdigest()


def compress_to_new_file(src: Path, out: Path, sha: str, method: str) -> int:
    """Write the compressed form of ``src`` at the new name ``out``: built in a
    temporary sibling, fsynced, verified to decompress to ``sha``, then
    published without ever replacing an existing name. Returns its size."""
    tmp = incoming_path(src.parent)
    try:
        if method == "zstd":
            zstd = shutil.which("zstd")
            if not zstd:
                raise StorageError("zstd is required for this closeout plan but is no longer on PATH")
            proc = subprocess.run([zstd, "-q", "-T0", "-10", "-o", str(tmp), str(src)], capture_output=True)
            if proc.returncode != 0:
                raise StorageError(f"zstd failed on {src}: {proc.stderr.decode(errors='replace').strip()}")
        else:
            with open(src, "rb") as s_fh, open(tmp, "xb") as raw, lzma.open(raw, "wb", preset=6) as d_fh:
                shutil.copyfileobj(s_fh, d_fh, CHUNK)
        fsync_file(tmp)
        if decompressed_sha(tmp, method) != sha:
            raise StorageError(f"the compressed copy of {src} does not decompress to its recorded bytes; "
                               "the original was kept")
        st = src.stat()
        os.chmod(tmp, stat.S_IMODE(st.st_mode))
        os.utime(tmp, (st.st_atime, st.st_mtime))
        os.link(tmp, out)  # raises if the name appeared meanwhile; never replaces
        fsync_dir(out.parent)
        return out.stat().st_size
    finally:
        try:
            os.unlink(tmp)
        except FileNotFoundError:
            pass


def normalize_prune(rel: str) -> str:
    # Only lexical normalization; whitespace is part of a file name.
    rel = posixpath.normpath(rel) if rel else rel
    if rel in ("", ".") or rel.startswith("/") or rel == ".." or rel.startswith("../"):
        raise StorageError(f"--prune {rel!r}: must name a path strictly inside the closed-out directory")
    if rel.split("/")[0] in RESERVED_NAMES:
        raise StorageError(f"--prune {rel!r}: closeout records cannot be pruned")
    return rel


def pruned_inventory(target: Path) -> dict:
    st = target.lstat()
    if stat.S_ISLNK(st.st_mode):
        return {".": {"type": "symlink", "target": os.readlink(target)}}
    if stat.S_ISREG(st.st_mode):
        return {".": {"type": "file", "mode": stat.S_IMODE(st.st_mode), "size": st.st_size,
                      "sha256": sha256_file(target)}}
    return tree_inventory(target)


def remove_path(target: Path) -> None:
    if target.is_symlink() or not target.is_dir():
        target.unlink()
    else:
        shutil.rmtree(target)


def verdict_rel_path(root: Path, verdict: Path) -> "str | None":
    if is_under(verdict, root):
        return Path(os.path.realpath(verdict)).relative_to(root).as_posix()
    return None


def check_prune_target(root: Path, rel: str, verdict_rel: "str | None") -> str:
    """Normalize one prune path and refuse anything that is not a path
    strictly inside ``root``, that is a closeout record, or that holds the
    verdict. Used for the plan and again for every resumed entry."""
    rel = normalize_prune(rel)
    target = root / rel
    # Every ancestor must be a real directory: a symlinked ancestor, even one
    # pointing elsewhere inside the tree, would delete a path recorded as kept.
    if Path(os.path.realpath(target.parent)) != target.parent:
        raise StorageError(f"prune path {rel!r} passes through a symbolic link; name the real path instead")
    if (target.exists() or target.is_symlink()) and not target.is_symlink():
        real = Path(os.path.realpath(target))
        if real == root or not is_under(real, root):
            raise StorageError(f"prune path {rel!r} does not resolve to a path strictly inside {root}")
    if verdict_rel is not None and (verdict_rel == rel or verdict_rel.startswith(rel + "/")):
        raise StorageError(f"prune path {rel!r} contains the verdict file; the verdict must survive the closeout")
    return rel


def plan_closeout(root: Path, verdict: Path, args) -> dict:
    verdict_rel = verdict_rel_path(root, verdict)
    prune = list(args.prune)
    if args.prune_caches:
        for dirpath, dirnames, filenames in os.walk(root, followlinks=False):
            for name in list(dirnames):
                if name in REGENERABLE_DIR_NAMES:
                    prune.append((Path(dirpath) / name).relative_to(root).as_posix())
                    dirnames.remove(name)
    prune = [check_prune_target(root, rel, verdict_rel) for rel in prune]
    for rel in prune:
        if not ((root / rel).exists() or (root / rel).is_symlink()):
            raise StorageError(f"--prune {rel!r}: no such path inside {root}")
    prune = sorted(set(prune))
    prune = [p for p in prune if not any(p != q and p.startswith(q + "/") for q in prune)]

    def inside_pruned(rel: str) -> bool:
        return any(rel == p or rel.startswith(p + "/") for p in prune)

    method, suffix = compression_method()
    kept: dict = {}
    compress, skipped = [], []
    git_stores: "list[str]" = []  # files inside a git object store are kept byte-exact
    for dirpath, dirnames, filenames in os.walk(root, followlinks=False):
        here = Path(dirpath)
        rel_dir = here.relative_to(root).as_posix()
        if rel_dir != "." and inside_pruned(rel_dir):
            dirnames[:] = []
            continue
        if rel_dir == ".":
            dirnames[:] = [d for d in dirnames if d not in RESERVED_NAMES]
        if here.name == ".git" or is_git_store(here):
            git_stores.append(rel_dir)
        in_git_store = any(g == "." or rel_dir == g or rel_dir.startswith(g + "/") for g in git_stores)
        for name in sorted(filenames):
            full = here / name
            rel = full.relative_to(root).as_posix()
            if inside_pruned(rel) or rel == CLOSEOUT_MANIFEST_NAME:
                continue
            st = full.lstat()
            if stat.S_ISLNK(st.st_mode):
                kept[rel] = {"type": "symlink", "target": os.readlink(full)}
                continue
            if not stat.S_ISREG(st.st_mode):
                continue
            sha = sha256_file(full)
            kept[rel] = {"type": "file", "size": st.st_size, "sha256": sha, "mode": stat.S_IMODE(st.st_mode)}
            if (args.no_compress or st.st_size < args.compress_min_size or rel == verdict_rel or in_git_store
                    or is_content_store_object(full) or full.suffix.lower() in ALREADY_COMPRESSED_SUFFIXES):
                continue
            if st.st_nlink > 1:
                skipped.append({"path": rel, "reason": "hard-linked elsewhere; compressing would not free space"})
                continue
            out = full.with_name(name + suffix)
            if out.exists() or out.is_symlink():
                skipped.append({"path": rel, "reason": f"{name + suffix} already exists"})
                continue
            compress.append({"path": rel, "sha256": sha, "size": st.st_size, "method": method})
    prune_plan = []
    for rel in prune:
        target = root / rel
        size, count, _ = dir_size(target) if (target.is_dir() and not target.is_symlink()) else \
            (target.lstat().st_size, 1, 0.0)
        prune_plan.append({"path": rel, "planned_bytes": size, "planned_files": count})
    return {
        "schema": CLOSEOUT_SCHEMA, "created_utc": utc_now(), "state": "planned",
        "verdict": {"path": str(verdict), "sha256": sha256_file(verdict)},
        "kept_files": kept, "pruned": prune_plan, "compressed": compress, "compression_skipped": skipped,
    }


def validate_resumed_plan(root: Path, verdict: Path, manifest: dict) -> None:
    """A recorded plan is re-checked as strictly as a new one before any
    resumed step touches the file system."""
    verdict_rel = verdict_rel_path(root, verdict)
    if not isinstance(manifest.get("kept_files"), dict) or not isinstance(manifest.get("pruned"), list) \
            or not isinstance(manifest.get("compressed"), list):
        raise StorageError("the recorded closeout plan is malformed")
    for rel, record in manifest["kept_files"].items():
        ok = isinstance(rel, str) and rel and normalize_prune(rel) == rel and isinstance(record, dict)
        if ok and record.get("type") == "file":
            ok = (is_sha256_hex(record.get("sha256")) and isinstance(record.get("size"), int)
                  and not isinstance(record.get("size"), bool) and record["size"] >= 0)
        elif ok:
            ok = record.get("type") == "symlink" and isinstance(record.get("target"), str)
        if not ok:
            raise StorageError(f"the recorded kept file {rel!r} is malformed; inspect before resuming")
    for entry in manifest["pruned"]:
        if not isinstance(entry, dict) or not isinstance(entry.get("path"), str) \
                or check_prune_target(root, entry["path"], verdict_rel) != entry["path"] \
                or (entry.get("removed") and not entry.get("tree_digest")):
            raise StorageError(f"the recorded prune entry {entry!r} is not a valid path inside {root}")
        digest = entry.get("tree_digest")
        if digest is not None and (not isinstance(digest, str) or len(digest) != 64
                                   or entry.get("inventory_file") != f"{PRUNED_INVENTORY_DIR}/{digest}.json"):
            raise StorageError(f"the recorded prune entry {entry['path']!r} has an invalid inventory reference")
    if manifest.get("state") != "applying":
        raise StorageError(f"the recorded closeout is in state {manifest.get('state')!r}, not an interrupted apply")
    for entry in manifest["pruned"]:
        if entry.get("removed") and not (is_sha256_hex(entry.get("tree_digest"))
                                         and verify_store_object(root / entry["inventory_file"], entry["tree_digest"])):
            raise StorageError(f"the inventory record of the already removed {entry['path']!r} is missing or "
                               "damaged; inspect before resuming")
    for entry in manifest["compressed"]:
        rel = entry.get("path") if isinstance(entry, dict) else None
        if not isinstance(rel, str) or normalize_prune(rel) != rel or entry.get("method") not in ("zstd", "xz"):
            raise StorageError(f"the recorded compression entry {entry!r} is malformed")
        if entry.get("done"):
            suffix = ".zst" if entry["method"] == "zstd" else ".xz"
            out = root / (rel + suffix)
            if entry.get("compressed_path") != rel + suffix or out.is_symlink() or not out.is_file() \
                    or decompressed_sha(out, entry["method"]) != entry.get("sha256"):
                raise StorageError(f"the compressed form of the already processed {rel!r} is missing or damaged; "
                                   "inspect before resuming")
        kept = manifest["kept_files"].get(rel)
        if not isinstance(kept, dict) or kept.get("type") != "file" or kept.get("sha256") != entry.get("sha256"):
            raise StorageError(f"the recorded compression entry {rel!r} does not match a recorded kept file")
        if Path(os.path.realpath((root / rel).parent)) != (root / rel).parent:
            raise StorageError(f"the recorded compression entry {rel!r} passes through a symbolic link or leaves "
                               f"{root}; inspect before resuming")


def write_inventory_record(inventories: Path, data: bytes, digest: str) -> None:
    record = inventories / f"{digest}.json"
    if record.exists() or record.is_symlink():
        if record.is_symlink() or record.read_bytes() != data:
            raise StorageError(f"{record} exists with different content; inspect before resuming")
        return
    inventories.mkdir(exist_ok=True)
    write_atomic(record, data, mode=0o444)


def apply_closeout(root: Path, manifest: dict, manifest_path: Path) -> "list[str]":
    """Each pruned path moves through recorded states: moved aside into the
    quarantine, inventoried (the inventory and its digest written once and
    never recomputed), then deleted. Each compressed file is published under
    its new name, recorded, re-hashed at its original path, and only then
    removed. A crash at any point resumes from the recorded state."""
    manifest["state"] = "applying"
    write_json_atomic(manifest_path, manifest)
    lines = []
    quarantine = root / QUARANTINE_DIR
    inventories = root / PRUNED_INVENTORY_DIR
    for index, entry in enumerate(manifest["pruned"]):
        if entry.get("removed"):
            continue
        target = root / entry["path"]
        held = quarantine / str(index)
        held_present = held.exists() or held.is_symlink()
        target_present = target.exists() or target.is_symlink()
        if entry.get("tree_digest"):
            # Already inventoried: only deletion remains (possibly half done),
            # and only while the recorded inventory is intact.
            if not verify_store_object(root / entry["inventory_file"], entry["tree_digest"]):
                raise StorageError(f"the inventory record of {entry['path']} is missing or damaged; the quarantined "
                                   f"remainder in {held} was kept")
            if target_present:
                raise StorageError(f"{target} reappeared after it was recorded and moved aside; inspect before resuming")
            if held_present:
                remove_path(held)
        else:
            if target_present:
                if held_present:
                    raise StorageError(f"both {target} and its quarantined copy {held} exist; inspect before resuming")
                quarantine.mkdir(exist_ok=True)
                os.rename(target, held)  # producers writing by the old path no longer reach it
                fsync_dir(quarantine)
            elif not held_present:
                raise StorageError(f"{target} vanished before it was recorded; inspect before resuming")
            inventory = pruned_inventory(held)
            data = canonical_json(inventory)
            digest = hashlib.sha256(data).hexdigest()
            write_inventory_record(inventories, data, digest)
            if tree_digest(pruned_inventory(held)) != digest:
                raise StorageError(f"{entry['path']} changed while being recorded; it was left in {held}")
            entry.update(files=sum(1 for v in inventory.values() if v["type"] == "file"),
                         bytes=sum(v.get("size", 0) for v in inventory.values()),
                         tree_digest=digest, inventory_file=f"{PRUNED_INVENTORY_DIR}/{digest}.json")
            write_json_atomic(manifest_path, manifest)
            remove_path(held)
        entry["removed"] = True
        write_json_atomic(manifest_path, manifest)
        lines.append(f"    removed {human(entry.get('bytes', 0)):>12}  {entry['path']}  "
                     f"(inventory {entry['tree_digest'][:12]})")
    try:
        quarantine.rmdir()
    except OSError:
        pass
    for entry in manifest["compressed"]:
        if entry.get("done"):
            continue
        src = root / entry["path"]
        if Path(os.path.realpath(src.parent)) != src.parent:
            raise StorageError(f"{entry['path']} now passes through a symbolic link; it was not compressed")
        suffix = ".zst" if entry["method"] == "zstd" else ".xz"
        out = src.with_name(src.name + suffix)
        src_present = src.exists() or src.is_symlink()
        if src_present and (src.is_symlink() or sha256_file(src) != entry["sha256"]):
            raise StorageError(f"{src} changed after it was recorded; it was not compressed or removed")
        if not (out.exists() or out.is_symlink()):
            if not src_present:
                raise StorageError(f"{src} vanished before it was compressed; inspect before resuming")
            entry["compressed_size"] = compress_to_new_file(src, out, entry["sha256"], entry["method"])
        elif out.is_symlink() or decompressed_sha(out, entry["method"]) != entry["sha256"]:
            raise StorageError(f"{out} exists and is not the compressed form of {src}; inspect before resuming")
        else:
            entry["compressed_size"] = out.stat().st_size
        entry["compressed_path"] = entry["path"] + suffix
        write_json_atomic(manifest_path, manifest)  # the mapping is durable before the original goes
        if src.exists() or src.is_symlink():
            # Re-hash immediately before removal: bytes written after the plan are never deleted.
            if src.is_symlink() or sha256_file(src) != entry["sha256"]:
                raise StorageError(f"{src} changed during the closeout; it was kept next to {out.name}")
            src.unlink()
            fsync_dir(src.parent)
        entry["done"] = True
        write_json_atomic(manifest_path, manifest)
    manifest.update(state="applied", applied_utc=utc_now())
    write_json_atomic(manifest_path, manifest)
    return lines


def cmd_closeout(args) -> int:
    root = Path(os.path.realpath(Path(args.dir).expanduser()))
    if not root.is_dir():
        raise StorageError(f"not a directory: {root}")
    verdict = Path(os.path.realpath(Path(args.verdict).expanduser()))
    if not verdict.is_file() or verdict.stat().st_size == 0:
        raise StorageError(f"verdict file missing or empty: {verdict}; closeout runs only after a verdict is recorded")
    manifest_path = root / CLOSEOUT_MANIFEST_NAME
    if manifest_path.exists():
        try:
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        except ValueError as exc:
            raise StorageError(f"{manifest_path} is not readable JSON ({exc}); inspect before resuming")
        if not isinstance(manifest, dict) or manifest.get("schema") != CLOSEOUT_SCHEMA \
                or not isinstance(manifest.get("verdict"), dict) or not isinstance(manifest["verdict"].get("sha256"), str):
            raise StorageError(f"{manifest_path} is not a closeout manifest")
        if manifest.get("state") == "applied":
            raise StorageError(f"{manifest_path} records a completed closeout; a tree is closed out once")
        if manifest["verdict"]["sha256"] != sha256_file(verdict):
            raise StorageError("the verdict file differs from the one this interrupted closeout recorded")
        if args.prune or args.prune_caches:
            raise StorageError("an interrupted closeout resumes its recorded plan; do not pass new --prune options")
        validate_resumed_plan(root, verdict, manifest)
        resumed = True
    else:
        manifest = plan_closeout(root, verdict, args)
        resumed = False
    pruned_bytes = sum(r.get("bytes", r.get("planned_bytes", 0)) for r in manifest["pruned"])
    lines = [f"run-storage closeout {root}" + (" (resuming the recorded plan)" if resumed else ""),
             f"  verdict: {verdict}",
             f"  remove {len(manifest['pruned'])} regenerable path(s), {human(pruned_bytes)}"]
    lines += [f"    {human(r.get('bytes', r.get('planned_bytes', 0))):>12}  {r['path']}" for r in manifest["pruned"]]
    lines.append(f"  compress {len(manifest['compressed'])} file(s), "
                 f"{human(sum(c['size'] for c in manifest['compressed']))} before compression")
    for skip in manifest.get("compression_skipped", []):
        lines.append(f"    not compressed: {skip['path']} ({skip['reason']})")
    lines.append("  precondition: nothing writes into this tree any more (the producing processes have stopped)")
    if not args.apply:
        lines.append("  plan only; rerun with --apply to execute")
        emit({**manifest, "applied": False}, args.json, lines)
        return EXIT_OK
    lines += apply_closeout(root, manifest, manifest_path)
    saved = sum(c["size"] - c.get("compressed_size", c["size"]) for c in manifest["compressed"])
    lines.append(f"  applied: removed {human(sum(r.get('bytes', 0) for r in manifest['pruned']))}, compression saved "
                 f"{human(saved)} (less where a file shared blocks with a copy-on-write clone); "
                 f"manifest {manifest_path} (sha256 {sha256_file(manifest_path)})")
    emit({**manifest, "applied": True}, args.json, lines)
    return EXIT_OK


# ------------------------------------------------------- store-put / digest

def store_for_path(path: Path, override: "str | None") -> Path:
    if override:
        return Path(override).expanduser().resolve()
    try:
        return Repo(path).store()
    except StorageError:
        raise StorageError(f"{path} is not inside a git working tree; pass --store")


def cmd_store_put(args) -> int:
    results = []
    for f in args.files:
        path = Path(f).expanduser()
        store = store_for_path(path, args.store)
        sha, dest, method = store_put(path, store)
        results.append({"path": str(path), "sha256": sha, "store_entry": str(dest), "method": method})
    emit({"stored": results}, args.json, [f"{r['sha256']}  {r['store_entry']}  ({r['method']})" for r in results])
    return EXIT_OK


def cmd_tree_digest(args) -> int:
    root = Path(args.root).expanduser().resolve()
    if not root.is_dir():
        raise StorageError(f"not a directory: {root}")
    inventory = tree_inventory(root)
    digest = tree_digest(inventory)
    result = {"root": str(root), "digest": digest, "entries": len(inventory),
              "bytes": sum(v.get("size", 0) for v in inventory.values())}
    lines = [f"{digest}  {root}  ({len(inventory)} entries)"]
    store = Path(args.store).expanduser().resolve() if args.store else None
    if store is not None:
        sha, dest = store_put_bytes(canonical_json(inventory), store)
        assert sha == digest
        result["inventory_entry"] = str(dest)
    if args.compare:
        if store is None:
            raise StorageError("--compare needs --store (the earlier inventory is read from it)")
        other = store_path(store, args.compare)
        if not verify_store_object(other, args.compare):
            raise StorageError(f"no intact stored inventory for digest {args.compare}")
        try:
            earlier = json.loads(other.read_text(encoding="utf-8"))
        except ValueError as exc:
            raise StorageError(f"the stored object {args.compare} is not an inventory ({exc})")
        if not isinstance(earlier, dict):
            raise StorageError(f"the stored object {args.compare} is not an inventory")
        diff = diff_inventories(earlier, inventory)
        result["compare"] = {"digest": args.compare, "equal": args.compare == digest, **diff}
        if args.compare == digest:
            lines.append("identical to the compared tree")
        else:
            for key in ("added", "removed", "changed"):
                lines += [f"  {key}: {p}" for p in diff[key][: args.limit]]
    emit(result, args.json, lines)
    return EXIT_FINDINGS if (args.compare and args.compare != digest) else EXIT_OK


# ------------------------------------------------------------------- main

def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="run_storage.py", description=__doc__.split("\n\n")[0])
    sub = parser.add_subparsers(dest="command", required=True)

    def common(p, project=True, json_flag=True, limit=True):
        if project:
            p.add_argument("--project-root", default=None, help="repository checkout (default: from the path or cwd)")
        if json_flag:
            p.add_argument("--json", action="store_true", help="machine-readable output")
        if limit:
            p.add_argument("--limit", type=int, default=20, help="rows listed per category")

    p = sub.add_parser("check", help="report bulk files under the run roots")
    common(p)
    p.add_argument("--staged", action="store_true", help="only files staged for the next commit")
    p.add_argument("--threshold", type=int, default=None, help="bytes (default: policy, 5 MiB)")
    p.add_argument("--strict", action="store_true", help="exit 1 when bulk files would enter history")
    p.add_argument("--quiet", action="store_true", help="print nothing when there is nothing to report")
    p.set_defaults(func=cmd_check)

    p = sub.add_parser("install-hook", help="install a pre-commit hook running `check --staged`")
    common(p, json_flag=False, limit=False)
    p.add_argument("--strict", action="store_true", help="the hook refuses commits that add bulk files")
    p.add_argument("--dry-run", action="store_true")
    p.set_defaults(func=cmd_install_hook)

    p = sub.add_parser("stow", help="store a finished run's bulk outputs (independent copy; the file stays in place, read-only)")
    common(p)
    p.add_argument("run_dir")
    p.add_argument("--threshold", type=int, default=None)
    p.add_argument("--store", default=None, help="content store (default: policy or <git common dir>/nullius/store)")
    p.add_argument("--dry-run", action="store_true")
    p.set_defaults(func=cmd_stow)

    p = sub.add_parser("verify", help="check manifest entries against their sha256")
    common(p, limit=False)
    p.add_argument("run_dir")
    p.add_argument("--store", default=None)
    p.set_defaults(func=cmd_verify)

    p = sub.add_parser("materialize", help="recreate missing manifest entries from the store")
    common(p, limit=False)
    p.add_argument("run_dir")
    p.add_argument("--store", default=None)
    p.add_argument("--dry-run", action="store_true")
    p.set_defaults(func=cmd_materialize)

    p = sub.add_parser("worktree-check", help="read-only: can linked worktrees be removed safely?")
    common(p)
    p.add_argument("worktree", nargs="?", default=None)
    p.add_argument("--all", action="store_true", help="check every linked worktree of the repository")
    p.add_argument("--base", default=None, help="branch a removable worktree must be merged into (default main/master)")
    p.add_argument("--store", default=None)
    p.set_defaults(func=cmd_worktree_check)

    p = sub.add_parser("sparse-exclude-bulk", help="leave tracked bulk files out of a linked worktree's checkout")
    common(p, project=False)
    p.add_argument("--worktree", default=None, help="worktree path (default: cwd)")
    p.add_argument("--threshold", type=int, default=None)
    p.add_argument("--allow-main", action="store_true", help="also allow the main checkout")
    p.add_argument("--dry-run", action="store_true")
    p.set_defaults(func=cmd_sparse_exclude_bulk)

    p = sub.add_parser("report", help="read-only estimate of reclaimable bytes")
    common(p, project=False)
    p.add_argument("roots", nargs="+")
    p.add_argument("--repo", default=None, help="reference repository for bundle / history-copy containment")
    p.add_argument("--min-size", type=int, default=CHUNK, help="smallest file considered (bytes, default 1 MiB)")
    p.add_argument("--stale-dir", action="append", default=[], help="temporary location whose old children are listed")
    p.add_argument("--stale-prefix", action="append", default=[], help="only children with this name prefix")
    p.add_argument("--older-than-days", type=float, default=7.0)
    p.add_argument("--compress-sample", type=int, default=500, help="largest files sampled for the compression estimate")
    p.set_defaults(func=cmd_report)

    p = sub.add_parser("closeout", help="after a verdict: hash manifest, prune regenerable paths, compress")
    common(p, project=False, limit=False)
    p.add_argument("dir")
    p.add_argument("--verdict", required=True, help="recorded verdict file (required)")
    p.add_argument("--prune", action="append", default=[], help="relative path to remove (repeatable)")
    p.add_argument("--prune-caches", action="store_true", help="also remove dependency trees and caches found inside")
    p.add_argument("--compress-min-size", type=int, default=CHUNK)
    p.add_argument("--no-compress", action="store_true")
    p.add_argument("--apply", action="store_true", help="execute (default: print the plan only)")
    p.set_defaults(func=cmd_closeout)

    p = sub.add_parser("store-put", help="put files into a content store")
    common(p, project=False, limit=False)
    p.add_argument("files", nargs="+")
    p.add_argument("--store", default=None)
    p.set_defaults(func=cmd_store_put)

    p = sub.add_parser("tree-digest", help="one digest for a whole tree")
    common(p, project=False)
    p.add_argument("root")
    p.add_argument("--store", default=None, help="store the canonical inventory under its digest")
    p.add_argument("--compare", default=None, help="digest of an earlier stored inventory")
    p.set_defaults(func=cmd_tree_digest)
    return parser


SUBCOMMANDS = ("check", "install-hook", "stow", "verify", "materialize", "worktree-check",
               "sparse-exclude-bulk", "report", "closeout", "store-put", "tree-digest")


def main(argv: "list[str] | None" = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    if getattr(args, "project_root", None) is None and args.command in ("check", "install-hook"):
        args.project_root = "."
    try:
        return args.func(args)
    except StorageError as exc:
        print(f"run-storage: {exc}", file=sys.stderr)
        return EXIT_ERROR
    except OSError as exc:
        print(f"run-storage: {exc}", file=sys.stderr)
        return EXIT_ERROR


if __name__ == "__main__":
    sys.exit(main())
