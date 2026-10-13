#!/usr/bin/env python3
"""Run storage: keep bulk run outputs out of git history without losing them.

Every byte of a tracked file exists once per checkout (the main checkout and
every linked worktree) plus once in the object store, and snapshot refs that
pin run origins keep historical blobs alive permanently. Source, unique inputs, essential results and provenance need preservation
by purpose. Size is a default review signal, not a value classifier; declared
reproducible outputs are stowed even when small. This tool implements that
policy for a project repository.

Size policy
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

  Semantic path_rules (git/store/local with reasons) override size; admission
  limits default to 64 MiB / 2000 changed run-output paths. Origin capture
  runs check --snapshot --strict before creating snapshot objects.

  Optional ``.nullius/storage_policy.json`` (commit it: every checkout reads
  its own copy, so an uncommitted policy leaves other worktrees on the
  defaults):
    {"schema": "storage_policy_v1", "bulk_threshold_bytes": 5242880,
     "run_roots": ["artifacts/runs"], "store_root": "/absolute/path"}
  Run roots are plain relative paths, none inside another, and must not pass
  through a symbolic link (files behind one are refused or flagged).

Subcommands
  inventory         read-only counts, duplicate index objects and retention review.
  check             report bulk files under the run roots (``--staged``: in
                    the index, i.e. about to be committed). Warns; exits 1
                    only with ``--strict``. Nested repositories are listed,
                    never classified.
  stow              place a finished run's bulk outputs in the store (an
                    independent clone or verified copy; the run's file stays
                    in place, read-only) + manifest + ignore block.
  verify            check every manifest entry against its sha256, in place
                    or in the store.
  materialize       recreate missing manifest entries in place from the
                    store (e.g. in another worktree; in a clone, even on the
                    same machine, pass ``--store`` with the original store).

``--store PATH`` overrides the policy's store for ``stow``, ``verify``,
``materialize``, and ``check`` without ``--staged``.

Exit codes: 0 clean; 1 findings (strict-check violations, verification or
restore problems, a stow refused because recorded outputs changed or are
unavailable, because bulk files are staged or changed but not committed, or
because git ignores the manifest or ignore file, an ignore rule that
re-includes a stowed file); 2 usage or
environment errors and inputs refused before any change (unrecordable file
names, damaged ignore-block markers, a run directory inside or around another
stowed run, a malformed manifest or policy, a store inside a checkout).
POSIX (macOS/Linux) only.
Nothing here deletes data: a damaged store object is renamed aside, never
removed, and run files are never replaced (stow only makes them read-only).

Operating assumptions: one user's own files (not an adversarial setting),
and nothing still writing into a run directory that is being stowed. Hashes
are re-checked immediately before each step that records or replaces
anything, but a process that keeps a file open can still write after the
last check; run ``stow`` only after the producing processes have stopped.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import posixpath
import secrets
import shutil
import stat
import subprocess
import sys
import tempfile
import unicodedata
from datetime import datetime, timezone
from pathlib import Path

DEFAULT_THRESHOLD = 5 * 1024 * 1024
DEFAULT_RUN_ROOTS = ("artifacts/runs",)
DEFAULT_ADMISSION_BYTES = 64 * 1024 * 1024
DEFAULT_ADMISSION_FILES = 2000
POLICY_REL = ".nullius/storage_policy.json"
POLICY_SCHEMA = "storage_policy_v1"
MANIFEST_NAME = "bulk_manifest.json"
MANIFEST_SCHEMA = "bulk_manifest_v1"
GITIGNORE_BEGIN = "# >>> bulk outputs kept outside git history (run_storage.py stow) >>>"
GITIGNORE_END = "# <<< bulk outputs kept outside git history <<<"
STORE_SUBPATH = ("nullius", "store")


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


def json_bytes(obj) -> bytes:
    return (json.dumps(obj, indent=2, sort_keys=True, ensure_ascii=False) + "\n").encode("utf-8")


def write_if_changed(path: Path, data: bytes) -> bool:
    """Write atomically unless the regular file already holds exactly these
    bytes. Returns whether anything was written."""
    try:
        if stat.S_ISREG(path.lstat().st_mode) and path.read_bytes() == data:
            return False
    except FileNotFoundError:
        pass
    write_atomic(path, data)
    return True


def walk_error(error: OSError) -> None:
    """os.walk silently skips unreadable directories; every walk a verdict or
    record rests on stops instead."""
    raise StorageError(f"cannot read {getattr(error, 'filename', '') or error} ({error.strerror or error}); "
                       "an incomplete walk cannot support this result")


HEX = frozenset("0123456789abcdef")

def is_sha256_hex(value) -> bool:
    return isinstance(value, str) and len(value) == 64 and set(value) <= HEX


def is_under(child: Path, parent: Path) -> bool:
    # os.path.realpath (unlike Path.resolve) does not raise on a symlink loop.
    try:
        Path(os.path.realpath(child)).relative_to(Path(os.path.realpath(parent)))
        return True
    except ValueError:
        return False


def emit(result: dict, as_json: bool, lines: "list[str]") -> None:
    # File names that are not valid UTF-8 arrive as surrogate escapes; they are
    # shown escaped rather than crashing the report.
    if as_json:
        print(json.dumps(result, indent=2, sort_keys=True, ensure_ascii=True))
    else:
        for line in lines:
            print(line.encode("utf-8", "backslashreplace").decode("utf-8"))


# ---------------------------------------------------------------------- git

def git(args: "list[str]", cwd: Path, check: bool = True, input_bytes: "bytes | None" = None,
        literal_pathspecs: bool = True) -> subprocess.CompletedProcess:
    # Never fetch: a partial clone would otherwise download missing objects
    # (network, credentials, and new packs written into a copy being read).
    # File names are passed as literal pathspecs (a name like ":(exclude)x" is just a name).
    env = dict(os.environ, GIT_OPTIONAL_LOCKS="0", LC_ALL="C", GIT_NO_LAZY_FETCH="1", GIT_TERMINAL_PROMPT="0")
    if literal_pathspecs:  # check-ignore dies in this mode (it takes plain path names anyway)
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


def same_file(a: Path, b: Path) -> bool:
    """Whether two paths name one file: the same device and inode, links not
    followed. A path that cannot be examined names no file here."""
    try:
        sa, sb = os.lstat(a), os.lstat(b)
    except OSError:
        return False
    return (sa.st_dev, sa.st_ino) == (sb.st_dev, sb.st_ino)


def case_insensitive(directory: Path) -> bool:
    """Whether names differing only in letter case are one file in `directory`:
    a lowercase probe file is created, its uppercase spelling looked up, and the
    probe removed. Unknown (cannot write here) counts as case-sensitive."""
    probe = directory / f".nullius-case-probe-{secrets.token_hex(4)}"
    try:
        fd = os.open(probe, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    except OSError:
        return False
    try:
        os.close(fd)
        return os.path.lexists(directory / probe.name.upper())
    finally:
        try:
            os.unlink(probe)
        except FileNotFoundError:
            pass


class Repo:
    """A checkout (main or linked worktree) of a git repository."""

    def __init__(self, start: Path, *, read_only: bool = False):
        self.read_only = read_only
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
        self._ignorecase: "bool | None" = None
        self.policy = load_policy(self.toplevel)

    @property
    def ignorecase(self) -> bool:
        """On a case-insensitive file system names differing only in case are one
        file. git records this as core.ignorecase; when the key does not say
        true (unset, or carried over from another file system) the checkout is
        measured directly, once."""
        if self._ignorecase is None:
            configured = git(["config", "--bool", "core.ignorecase"], self.toplevel,
                             check=False).stdout.decode().strip() == "true"
            # Read commands must not create a filesystem probe. Conservative
            # folding is safe: each alias is still checked by device/inode.
            self._ignorecase = True if self.read_only else configured or case_insensitive(self.toplevel)
        return self._ignorecase

    def symlinked_run_roots(self) -> "list[str]":
        """Run roots whose path passes through a symbolic link anywhere below the
        checkout: bulk under them would be checked at one path and tracked at
        another, so every command refuses or flags them."""
        found = []
        for root in self.run_roots:
            lexical = self.toplevel / root
            if (lexical.exists() or lexical.is_symlink()) and Path(os.path.realpath(lexical)) != lexical:
                found.append(root)
        return found

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
            store = Path(override).expanduser().resolve()
        elif self.policy.get("store_root"):
            store = Path(self.policy["store_root"]).expanduser().resolve()
        else:
            return self.common_dir.joinpath(*STORE_SUBPATH)
        self.check_store_location(store)
        return store

    def worktree_paths(self) -> "list[Path]":
        out = git_text(["worktree", "list", "--porcelain"], self.toplevel)
        return [Path(os.path.realpath(line[len("worktree "):])) for line in out.splitlines()
                if line.startswith("worktree ")]

    def check_store_location(self, store: Path) -> None:
        """A store must outlive every checkout: it lies in the repository's
        common git directory (not in a linked worktree's private part) or
        outside every checkout. Inside a checkout, `git worktree remove` would
        delete it, or a plain `git add` would commit it."""
        real = Path(os.path.realpath(store))
        common = Path(os.path.realpath(self.common_dir))
        if inside_of(real, common) and not inside_of(real, common / "worktrees"):
            return
        holders = [w for w in [*self.worktree_paths(), common / "worktrees"] if inside_of(real, w)]
        # Any other repository's working tree counts too: its owner's `git clean`, worktree removal, or
        # deletion would take the store along. Judged from the nearest existing ancestor of the path.
        existing = real
        while not existing.exists() and existing != existing.parent:
            existing = existing.parent
        probe = git(["rev-parse", "--show-toplevel"], existing, check=False)
        other = probe.stdout.decode("utf-8", errors="surrogateescape").strip() if probe.returncode == 0 else ""
        if other:
            holders.append(Path(other))
        if holders:
            raise StorageError(f"content store {store} lies inside {holders[0]}, which a worktree removal, a "
                               "clean, or a commit would take with it; use a path outside every git working "
                               "tree (or the default store in this repository's common git directory)")

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
    policy = {"bulk_threshold_bytes": DEFAULT_THRESHOLD, "run_roots": list(DEFAULT_RUN_ROOTS), "store_root": None, "path_rules": [],
              "admission_max_bytes": DEFAULT_ADMISSION_BYTES, "admission_max_files": DEFAULT_ADMISSION_FILES}
    path = toplevel / POLICY_REL
    if not path.exists():
        return policy
    try:
        doc = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        raise StorageError(f"{POLICY_REL}: unreadable ({exc})")
    if not isinstance(doc, dict) or doc.get("schema") != POLICY_SCHEMA:
        raise StorageError(f"{POLICY_REL}: expected an object with schema '{POLICY_SCHEMA}'")
    unknown = set(doc) - {"schema", "bulk_threshold_bytes", "run_roots", "store_root", "path_rules",
                          "admission_max_bytes", "admission_max_files"}
    if unknown:
        raise StorageError(f"{POLICY_REL}: unknown fields {sorted(unknown)}")
    if "bulk_threshold_bytes" in doc:
        value = doc["bulk_threshold_bytes"]
        if not isinstance(value, int) or isinstance(value, bool) or value <= 0:
            raise StorageError(f"{POLICY_REL}: bulk_threshold_bytes must be a positive integer")
        policy["bulk_threshold_bytes"] = value
    if "run_roots" in doc:
        roots = doc["run_roots"]
        # Plain relative paths below the checkout, written once each and never
        # one inside another (a file must be classified exactly once).
        if (not isinstance(roots, list) or not roots
                or not all(isinstance(r, str) and r and not r.startswith("/") and "\x00" not in r
                           and posixpath.normpath(r.rstrip("/")) == r.rstrip("/") and r.rstrip("/") not in ("", ".")
                           and ".." not in r.split("/") for r in roots)):
            raise StorageError(f"{POLICY_REL}: run_roots must be a non-empty list of plain relative paths "
                               "(no '.', '..', or empty components)")
        clean = [r.rstrip("/") for r in roots]
        for i, a in enumerate(clean):
            for b in clean[i + 1:]:
                if a == b or b.startswith(a + "/") or a.startswith(b + "/"):
                    raise StorageError(f"{POLICY_REL}: run_roots {a!r} and {b!r} overlap; list each tree once")
        policy["run_roots"] = clean
    if doc.get("store_root") is not None:
        root = doc["store_root"]
        if not isinstance(root, str) or not Path(root).expanduser().is_absolute():
            # A relative store would resolve inside each checkout, so removing a
            # worktree could delete the very store that was meant to outlive it.
            raise StorageError(f"{POLICY_REL}: store_root must be an absolute path (or start with ~)")
        policy["store_root"] = root
    for key in ("admission_max_bytes", "admission_max_files"):
        if key in doc:
            value = doc[key]
            if not isinstance(value, int) or isinstance(value, bool) or value <= 0:
                raise StorageError(f"{POLICY_REL}: {key} must be a positive integer")
            policy[key] = value
    rules = doc.get("path_rules", [])
    if not isinstance(rules, list):
        raise StorageError(f"{POLICY_REL}: path_rules must be a list")
    seen = set()
    for rule in rules:
        if (not isinstance(rule, dict) or set(rule) - {"path", "disposition", "reason", "retention_days"}
                or not isinstance(rule.get("path"), str) or not rule["path"]
                or rule["path"].startswith("/") or any(c in rule["path"] for c in "\\\n\r\x00")
                or posixpath.normpath(rule["path"]) != rule["path"]
                or any(c in (".", "..", ".git") for c in rule["path"].split("/"))
                or rule.get("disposition") not in ("git", "store", "local")
                or not isinstance(rule.get("reason"), str) or not rule["reason"].strip()):
            raise StorageError(f"{POLICY_REL}: each path rule needs a plain relative path, "
                               "git/store/local disposition and a nonempty reason")
        if rule["path"] in seen:
            raise StorageError(f"{POLICY_REL}: duplicate path rule {rule['path']!r}")
        seen.add(rule["path"])
        if "retention_days" in rule:
            days = rule["retention_days"]
            if rule["disposition"] != "local" or not isinstance(days, int) or isinstance(days, bool) or days <= 0:
                raise StorageError(f"{POLICY_REL}: retention_days is a positive integer for local rules only")
    policy["path_rules"] = rules
    return policy


def path_rule(repo: Repo, rel: str) -> "dict | None":
    matches = [r for r in repo.policy["path_rules"] if rel == r["path"] or rel.startswith(r["path"] + "/")]
    return max(matches, key=lambda r: len(r["path"]), default=None)


def bulk_candidate(repo: Repo, rel: str, size: int, threshold: int) -> bool:
    rule = path_rule(repo, rel)
    return rule["disposition"] == "store" if rule else size >= threshold


def resolve_threshold(repo: "Repo | None", override: "int | None") -> int:
    if override is not None:
        if override <= 0:
            raise StorageError("--threshold must be positive")
        return override
    return repo.threshold if repo else DEFAULT_THRESHOLD


# ------------------------------------------------------------ content store

def store_path(store: Path, sha: str) -> Path:
    return store / "sha256" / sha[:2] / sha


def verify_store_object(obj: Path, sha: str, size: "int | None" = None) -> bool:
    """A store object counts only when it is a regular file (never a symlink)
    whose full sha256 equals the hash it is filed under and, when a recorded
    size is given, whose size equals it."""
    try:
        st = obj.lstat()
    except OSError:
        return False
    if not stat.S_ISREG(st.st_mode) or (size is not None and st.st_size != size):
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
            if sha256_file(path) != sha:
                raise StorageError(f"{path} changed while being stored; stow it after the run has finished writing")
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


# ------------------------------------------------------------- manifests

RESERVED_NOTE = (f"under a run root the file name {MANIFEST_NAME} is reserved for run storage manifests; "
                 "rename a data file that has this name")


def load_manifest(run_dir: Path) -> "dict | None":
    path = run_dir / MANIFEST_NAME
    if path.is_symlink():  # git would record the link, not the hashes
        raise StorageError(f"{path} is a symbolic link; a bulk manifest must be a regular, tracked file")
    if not path.exists():
        return None
    try:
        doc = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        raise StorageError(f"{path}: unreadable ({exc}); {RESERVED_NOTE}")
    return validate_manifest_doc(doc, path)


def validate_manifest_doc(doc, path):
    if not isinstance(doc, dict) or doc.get("schema") != MANIFEST_SCHEMA or not isinstance(doc.get("entries"), list):
        raise StorageError(f"{path}: expected schema '{MANIFEST_SCHEMA}' with an entries list; {RESERVED_NOTE}")
    seen: "set[str]" = set()
    for entry in doc["entries"]:
        rel = entry.get("path") if isinstance(entry, dict) else None
        if (not isinstance(rel, str) or not rel or "\x00" in rel or posixpath.normpath(rel) != rel or rel.startswith("/")
                or ".." in rel.split("/") or not is_sha256_hex(entry.get("sha256"))
                or not isinstance(entry.get("size"), int) or isinstance(entry.get("size"), bool) or entry["size"] < 0):
            raise StorageError(f"{path}: malformed entry {entry!r}")
        if rel in seen:
            raise StorageError(f"{path}: the path {rel!r} is recorded more than once")
        seen.add(rel)
    return doc


def manifests_under(repo: Repo) -> "dict[str, list[tuple[Path, dict]]]":
    """Map repository-relative path -> every (run directory, manifest entry)
    that records it, across all bulk manifests under the run roots (a path
    recorded by two manifests must not hide either record)."""
    found: dict = {}
    for root in repo.run_roots:
        base = repo.toplevel / root
        if not base.is_dir() or root in repo.symlinked_run_roots():
            continue
        for dirpath, dirnames, filenames in os.walk(base, followlinks=False, onerror=walk_error):
            if ".git" in dirnames or ".git" in filenames:  # a nested repository keeps its own records
                dirnames[:] = []
                continue
            if MANIFEST_NAME in filenames:
                run_dir = Path(dirpath)
                doc = load_manifest(run_dir)
                run_rel = run_dir.relative_to(repo.toplevel).as_posix()  # walked inside the checkout
                for entry in doc["entries"]:
                    # Lexical path: a symlinked ancestor must not move the key elsewhere.
                    found.setdefault(repo.git_form(posixpath.join(run_rel, entry["path"])), []).append((run_dir, entry))
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


def read_ignore_lines(path: Path) -> "list[str]":
    """The file's lines split on "\\n" only (git's rule), each with one trailing
    "\\r" kept; a file that is not UTF-8 is refused rather than rewritten."""
    try:
        text = path.read_bytes().decode("utf-8")
    except UnicodeDecodeError:
        raise StorageError(f"{path} is not UTF-8 text; it is left untouched")
    lines = text.split("\n")
    if lines and lines[-1] == "":
        lines.pop()
    return lines


def check_ignore_markers(run_dir: Path) -> None:
    """The managed block must be absent or exactly one BEGIN ... END pair in
    that order; anything else would make the rewrite drop user rules."""
    path = run_dir / ".gitignore"
    if path.is_symlink():  # git does not read a symlinked .gitignore, and stow never replaces one
        raise StorageError(f"{path} is a symbolic link; git does not read a symlinked .gitignore, so the managed "
                           "block could not take effect: make it a regular file, then stow again")
    if not path.exists():
        return
    inside, blocks = False, 0
    for line in read_ignore_lines(path):
        line = line[:-1] if line.endswith("\r") else line
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


def update_ignore_block(run_dir: Path, rel_paths: "list[str]") -> bool:
    """Write the managed block where it already stands (rule order decides
    which rule wins), or append it; user lines are kept exactly."""
    check_ignore_markers(run_dir)
    path = run_dir / ".gitignore"
    lines = read_ignore_lines(path) if path.exists() else []
    block = [GITIGNORE_BEGIN, *[gitignore_escape(p) for p in sorted(rel_paths)], GITIGNORE_END]
    out: "list[str]" = []
    inside = placed = False
    for line in lines:  # a trailing "\r" on a user line is kept
        bare = line[:-1] if line.endswith("\r") else line
        if bare == GITIGNORE_BEGIN:
            inside = placed = True
            out.extend(block)
        elif bare == GITIGNORE_END:
            inside = False
        elif not inside:
            out.append(line)
    if not placed:
        while out and out[-1] in ("", "\r"):
            out.pop()
        out += ([""] if out else []) + block
    elif out and out[-1] == "":
        out.pop()  # the final newline is written below
    return write_if_changed(path, ("\n".join(out) + "\n").encode("utf-8"))


# ------------------------------------------------------------------ check

def is_storage_record(rel: str) -> bool:
    """The manifest and ignore file stow asks you to commit are never bulk."""
    return posixpath.basename(rel) in (MANIFEST_NAME, ".gitignore")


def blob_ids(repo: Repo, args: "list[str]") -> "dict[str, tuple[str, str]]":
    """Map path -> (file mode, object id) from ls-tree or ls-files --stage."""
    out = git(args, repo.toplevel)  # a failure is an error, never "nothing committed"
    found = {}
    for item in out.stdout.decode("utf-8", errors="surrogateescape").split("\0"):
        meta, _, path = item.partition("\t")
        parts = meta.split()
        if path and len(parts) >= 3:
            found[path] = (parts[0], parts[2] if args[0] == "ls-tree" else parts[1])
    return found


def is_ignored(repo: Repo, path: Path) -> bool:
    """True when git's ignore rules exclude this (tracked or not, existing or
    not) path; a tracked path is never excluded."""
    # "./" keeps a leading ':' from being read as pathspec magic; glob characters are taken literally.
    proc = git(["check-ignore", "-q", "--", "./" + os.path.relpath(path, repo.toplevel)], repo.toplevel,
               check=False, literal_pathspecs=False)
    if proc.returncode not in (0, 1):
        raise StorageError(f"git check-ignore failed for {path}: {proc.stderr.decode(errors='replace').strip()}")
    return proc.returncode == 0


RECORD_NAMES = (MANIFEST_NAME, ".gitignore")


def committed_and_pending(repo: Repo, pathspecs: "list[str]") -> "tuple[set[str], set[str]]":
    """Split tracked paths into committed ones and pending ones. Committed:
    HEAD holds the path with the index's content and mode, git reports no
    working-tree change, and no index flag lets git hide one (an entry marked
    assume-unchanged or skip-worktree is never taken as committed, since its
    working-tree bytes may differ from every commit). Everything else tracked
    is pending: newly staged, staged or working-tree changes, mode changes as
    git records them, or a flagged entry."""
    tracked = repo.tracked(pathspecs)
    if not tracked:
        return set(), set()
    # Before the first commit HEAD names no commit and nothing is committed.
    born = git(["rev-parse", "--verify", "-q", "HEAD^{commit}"], repo.toplevel, check=False).returncode == 0
    head = blob_ids(repo, ["ls-tree", "-r", "-z", "HEAD", "--", *pathspecs]) if born else {}
    index = blob_ids(repo, ["ls-files", "--stage", "-z", "--", *pathspecs])
    modified = set(git_z(["diff", "--name-only", "-z", "--", *pathspecs], repo.toplevel))
    # `ls-files -v` tags a plain entry "H"; assume-unchanged entries get a
    # lowercase tag and skip-worktree entries "S". Only plain entries are trusted.
    flagged = {item[2:] for item in git_z(["ls-files", "-v", "-z", "--", *pathspecs], repo.toplevel)
               if not item.startswith("H ")}
    committed = {p for p in tracked
                 if p in head and head[p] == index.get(p) and p not in modified and p not in flagged}
    return committed, tracked - committed


def record_needs_commit(repo: Repo, run_dir: Path) -> bool:
    """True when the run's manifest or ignore file on disk is not committed as it is."""
    rels = [repo.rel(run_dir / name) for name in RECORD_NAMES]
    committed, pending = committed_and_pending(repo, rels)
    return any(rel not in committed and (rel in pending or (repo.toplevel / rel).exists()
                                         or (repo.toplevel / rel).is_symlink()) for rel in rels)


def staged_bulk(repo: Repo, threshold: int) -> "list[dict]":
    # git cannot stage a file behind a symbolic link; such roots are reported separately.
    symlinked = repo.symlinked_run_roots()
    roots = [r for r in repo.run_roots if r not in symlinked]
    if not roots:
        return []
    # --no-renames: an added file is listed as added, and no blob is needed for
    # rename detection (in a partial clone that would require a fetch).
    changed = git_z(["diff", "--cached", "--no-renames", "--name-only", "-z", "--diff-filter=ACMT", "--", *roots],
                    repo.toplevel)
    if not changed:
        return []
    stage = git_z(["ls-files", "--stage", "-z", "--", *changed], repo.toplevel)
    shas: "dict[str, str]" = {}
    for item in stage:
        meta, _, path = item.partition("\t")
        parts = meta.split()
        if len(parts) >= 2 and parts[0] != "160000" and not is_storage_record(path):
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
    return sorted(({"path": p, "size": sizes[s]} for p, s in shas.items() if bulk_candidate(repo, p, sizes.get(s, 0), threshold)),
                  key=lambda r: (-r["size"], r["path"]))


def working_tree_bulk(repo: Repo, threshold: int, store: Path) -> "dict[str, list[dict]]":
    symlinked = repo.symlinked_run_roots()
    roots = [r for r in repo.run_roots if (repo.toplevel / r).is_dir() and r not in symlinked]
    classes: "dict[str, list[dict]]" = {"tracked": [], "pending": [], "untracked": [], "ignored_unstowed": [],
                                        "stowed": [], "stowed_damaged": [],
                                        "symlinked_run_roots": [{"path": r, "size": 0} for r in symlinked],
                                        "nested_repositories": [], "uncommitted_records": [],
                                        "symlinks_not_followed": []}
    if not roots:
        return classes
    committed, pending = committed_and_pending(repo, roots)
    untracked = repo.untracked(roots)
    stowed = manifests_under(repo)
    # On a case-insensitive file system a file renamed only in letter case is still the recorded one.
    # Recorded files by case-folded path. A file whose name folds to a recorded one is that file only
    # when it is the same file on disk; with core.ignorecase carried onto a case-sensitive file system
    # it can be a different file, which must be classified (and so reported), never skipped.
    stowed_folded: "dict[str, list[Path]]" = {}
    if repo.ignorecase:
        for rel, records in stowed.items():
            for run_dir, entry in records:
                stowed_folded.setdefault(rel.casefold(), []).append(run_dir / entry["path"])
    # Every recorded entry is checked by full hash, whatever its current size:
    # a stowed output that changed, shrank, vanished, lost its store copy, or
    # is recorded twice is not "stowed" any more.
    # The manifest and ignore file of every stowed run must be committed as
    # they are: otherwise removing this checkout loses the record.
    record_paths = sorted({repo.rel(run_dir / name) for records in stowed.values() for run_dir, _ in records
                           for name in RECORD_NAMES})
    committed_records, pending_records = committed_and_pending(repo, record_paths)
    for rel in record_paths:
        full = repo.toplevel / rel
        if rel in committed_records:
            continue
        if not (full.exists() or full.is_symlink()):
            status = "missing"
        elif rel in pending_records:
            status = "pending"
        else:
            status = "ignored" if is_ignored(repo, full) else "untracked"
        classes["uncommitted_records"].append({"path": rel, "size": 0, "status": status})
    for rel, records in sorted(stowed.items()):
        statuses = [entry_status(run_dir, store, entry)["status"] for run_dir, entry in records]
        status = "recorded_more_than_once" if len(records) > 1 else statuses[0]
        record = {"path": rel, "size": records[0][1]["size"], "status": status}
        good = status in GOOD_ENTRY_STATUSES
        classes["stowed" if good else "stowed_damaged"].append(record)
    for root in roots:
        for dirpath, dirnames, filenames in os.walk(repo.toplevel / root, followlinks=False, onerror=walk_error):
            here = Path(dirpath)
            if ".git" in dirnames or ".git" in filenames:  # a nested repository follows its own rules
                classes["nested_repositories"].append({"path": repo.rel(here), "size": 0})
                dirnames[:] = []
                continue
            for name in dirnames + filenames:  # git records a link, never its target's content
                if (here / name).is_symlink():
                    classes["symlinks_not_followed"].append({"path": repo.rel(here / name), "size": 0})
            for name in filenames:
                full = here / name
                st = full.lstat()
                if not stat.S_ISREG(st.st_mode):
                    continue
                rel = repo.rel(full)
                if not bulk_candidate(repo, rel, st.st_size, threshold):
                    continue
                if is_storage_record(rel):
                    continue
                record = {"path": rel, "size": st.st_size}
                if rel in committed:
                    classes["tracked"].append(record)
                elif rel in pending:
                    classes["pending"].append(record)
                elif rel in untracked:
                    classes["untracked"].append(record)
                elif rel in stowed or any(same_file(full, p) for p in stowed_folded.get(rel.casefold(), ())):
                    continue  # classified above by hash
                else:
                    classes["ignored_unstowed"].append(record)
    for records in classes.values():
        records.sort(key=lambda r: (-r["size"], r["path"]))
    return classes


def object_sizes(repo: Repo, oids: "list[str]") -> dict:
    if not oids:
        return {}
    out = git(["cat-file", "--batch-check=%(objectname) %(objecttype) %(objectsize)"], repo.toplevel,
              input_bytes=("\n".join(sorted(set(oids))) + "\n").encode()).stdout.decode().splitlines()
    sizes = {}
    for line in out:
        fields = line.split()
        if len(fields) != 3 or fields[1] != "blob" or not fields[2].isdigit():
            raise StorageError("a required index object is unavailable; no fetch was attempted")
        sizes[fields[0]] = int(fields[2])
    return sizes


def bundle_blob(repo: Repo, oid: str) -> bool:
    # Header, not extension, identifies a Git backup. Read only a prefix;
    # do not materialize the archive or trigger a partial-clone fetch.
    env = dict(os.environ, GIT_OPTIONAL_LOCKS="0", GIT_NO_LAZY_FETCH="1", GIT_TERMINAL_PROMPT="0")
    proc = subprocess.Popen(["git", "-c", "protocol.allow=never", "cat-file", "blob", oid],
                            cwd=repo.toplevel, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, env=env)
    try:
        prefix = proc.stdout.read(32)
    finally:
        proc.stdout.close()
        if proc.poll() is None:
            proc.terminate()
        proc.wait(timeout=10)
    return prefix.startswith((b"# v2 git bundle\n", b"# v3 git bundle\n"))


def admission_storage_record(repo: Repo, row: dict, index: dict, cache: dict) -> bool:
    """Exempt validated stow metadata, never a name alone. Index checks use
    index bytes; working checks use working bytes. Exact record rules win."""
    rel = row["path"]
    if not is_storage_record(rel):
        return False
    parent = posixpath.dirname(rel)
    key = (parent, row["source"])
    if key not in cache:
        try:
            if row["source"] == "index":
                pair = index.get(parent + "/" + MANIFEST_NAME)
                if not pair or pair[0] not in ("100644", "100755"):
                    cache[key] = None
                else:
                    data = git(["cat-file", "blob", pair[1]], repo.toplevel).stdout
                    cache[key] = validate_manifest_doc(json.loads(data), parent + "/" + MANIFEST_NAME)
            else:
                cache[key] = load_manifest(repo.toplevel / parent)
        except (StorageError, ValueError, UnicodeError):
            cache[key] = None
    doc = cache[key]
    if doc is None:
        return False
    if posixpath.basename(rel) == MANIFEST_NAME:
        return True
    try:
        data = (git(["cat-file", "blob", row["oid"]], repo.toplevel).stdout
                if row["source"] == "index" else (repo.toplevel / rel).read_bytes())
        lines = data.decode("utf-8").splitlines()
        if lines.count(GITIGNORE_BEGIN) != 1 or lines.count(GITIGNORE_END) != 1:
            return False
        first, last = lines.index(GITIGNORE_BEGIN), lines.index(GITIGNORE_END)
        return first < last and lines[first + 1:last] == [gitignore_escape(e["path"]) for e in doc["entries"]]
    except (StorageError, OSError, ValueError, UnicodeError):
        return False


def admission(repo: Repo, threshold: int, snapshot: bool = False) -> dict:
    changed = git_z(["diff", "--cached", "--no-renames", "--name-only", "-z", "--diff-filter=ACMT"], repo.toplevel)
    index = blob_ids(repo, ["ls-files", "--stage", "-z"])
    selected = {rel: index[rel] for rel in changed if rel in index and index[rel][0] in ("100644", "100755")}
    sizes = object_sizes(repo, [oid for _, oid in selected.values()])
    rows = [{"path": rel, "size": sizes[oid], "source": "index", "oid": oid} for rel, (_, oid) in selected.items()]
    if snapshot and git(["rev-parse", "--verify", "-q", "HEAD"], repo.toplevel, check=False).returncode == 0:
        dirty = git_z(["diff", "HEAD", "--no-renames", "--name-only", "-z", "--diff-filter=ACMT"], repo.toplevel)
        for rel in dirty:
            full = repo.toplevel / rel
            # A tracked directory replaced by a symlink is never followed.
            if repo.rel(full) != repo.git_form(rel):
                raise StorageError(f"unsafe snapshot path {rel!r}")
            try:
                st = full.lstat()
            except FileNotFoundError:
                continue
            if stat.S_ISREG(st.st_mode):
                rows.append({"path": rel, "size": st.st_size, "source": "working_tree"})
    findings = []
    totals = {}
    record_cache = {}
    for row in rows:
        rel = row["path"]
        in_root = any(rel == r or rel.startswith(r + "/") for r in repo.run_roots)
        storage_record = in_root and admission_storage_record(repo, row, index, record_cache)
        rule = path_rule(repo, rel)
        if rule and rule["disposition"] == "git":
            continue
        reason = None
        if rule and (not storage_record or rule["path"] == rel):
            reason = "declared_" + rule["disposition"]
        elif in_root and row["size"] >= threshold and not storage_record and posixpath.basename(rel) != ".gitignore":
            reason = "bulk_output"
        if reason is None:
            if row["source"] == "index":
                backup = bundle_blob(repo, row["oid"])
            else:
                with open(repo.toplevel / rel, "rb") as fh:
                    backup = fh.read(32).startswith((b"# v2 git bundle\n", b"# v3 git bundle\n"))
            if backup:
                reason = "git_backup_archive"
        if reason:
            findings.append({**row, "reason": reason})
        if in_root and not storage_record and (rule is not None or posixpath.basename(rel) != ".gitignore"):
            totals[rel] = max(totals.get(rel, 0), row["size"])
    total = sum(totals.values())
    limits = []
    for metric, value, key in [("bytes", total, "admission_max_bytes"),
                               ("files", len(totals), "admission_max_files")]:
        if value > repo.policy[key]:
            limits.append({"metric": metric, "observed": value, "maximum": repo.policy[key]})
    return {"admission_findings": sorted(findings, key=lambda r: (r["path"], r["source"])),
            "admission_totals": {"files": len(totals), "logical_bytes": total}, "admission_limits": limits}


def cmd_inventory(args) -> int:
    """Index identities and filesystem sizes only; no probes, hashes or writes."""
    repo = Repo(args.project_root, read_only=True)
    index = {rel: pair for rel, pair in blob_ids(repo, ["ls-files", "--stage", "-z"]).items()
             if pair[0] in ("100644", "100755")}
    sizes = object_sizes(repo, [oid for _, oid in index.values()])
    groups, copies, declarations = {}, {}, {"git": [], "store": [], "local": []}
    for rel, (_, oid) in sorted(index.items()):
        copies.setdefault(oid, []).append(rel)
        matched = next((r for r in repo.run_roots if rel.startswith(r + "/")), None)
        if matched:
            group = matched + "/" + rel[len(matched) + 1:].split("/")[0]
            item = groups.setdefault(group, {"path": group, "files": 0, "logical_bytes": 0})
            item["files"] += 1
            item["logical_bytes"] += sizes[oid]
        rule = path_rule(repo, rel)
        if rule:
            declarations[rule["disposition"]].append({"path": rel, "size": sizes[oid], "reason": rule["reason"]})
    duplicates = [{"oid": oid, "size": sizes[oid], "copies": len(paths), "paths": paths[:args.limit]}
                  for oid, paths in copies.items() if len(paths) > 1]
    duplicates.sort(key=lambda r: (-r["size"] * (r["copies"] - 1), r["oid"]))
    filesystem, retention, skipped = [], [], []
    now = datetime.now(timezone.utc).timestamp()
    # Inspect declared local paths as well as run roots; a project may
    # keep caches or backups elsewhere. Collapse overlap before walking.
    scan_roots = []
    requested = set(repo.run_roots) | {r["path"] for r in repo.policy["path_rules"] if r["disposition"] == "local"}
    for candidate in sorted(requested, key=lambda r: (len(r.split("/")), r)):
        if not any(candidate == r or candidate.startswith(r + "/") for r in scan_roots):
            scan_roots.append(candidate)
    def observe(full: Path) -> tuple:
        st = full.lstat()
        if not stat.S_ISREG(st.st_mode):
            skipped.append({"path": repo.rel(full), "reason": "not_regular_file"})
            return 0, 0
        rel = repo.rel(full)
        rule = path_rule(repo, rel)
        if rule and rule.get("retention_days") and now - st.st_mtime >= rule["retention_days"] * 86400:
            retention.append({"path": rel, "size": st.st_size, "retention_days": rule["retention_days"],
                              "tracked": rel in index, "reason": rule["reason"]})
        return 1, st.st_size
    for scan_root in scan_roots:
        base = repo.toplevel / scan_root
        if Path(os.path.realpath(base)) != base:
            skipped.append({"path": scan_root, "reason": "symlinked_root"})
            continue
        if not base.exists():
            continue
        count, nbytes = 0, 0
        if base.is_file():
            count, nbytes = observe(base)
        else:
            for directory, dirs, files in os.walk(base, followlinks=False, onerror=walk_error):
                here = Path(directory)
                if ".git" in dirs or ".git" in files:
                    skipped.append({"path": repo.rel(here), "reason": "nested_repository"})
                    dirs[:] = []
                    continue
                for d in list(dirs):
                    if (here / d).is_symlink():
                        skipped.append({"path": repo.rel(here / d), "reason": "symlinked_directory"})
                        dirs.remove(d)
                for name in files:
                    amount, size = observe(here / name)
                    count += amount
                    nbytes += size
        filesystem.append({"path": scan_root, "files": count, "logical_bytes": nbytes})
    refs = git_text(["for-each-ref", "--format=%(refname) %(objecttype)"], repo.toplevel).splitlines()
    namespaces = {}
    for ref in refs:
        name, kind = ref.rsplit(" ", 1)
        group = "/".join(name.split("/")[:2])
        key = group + ":" + kind
        namespaces[key] = namespaces.get(key, 0) + 1
    result = {"mode": "inventory", "scope": "current_index_run_roots_and_declared_local_paths", "read_only": True,
              "tracked_files": len(index), "tracked_logical_bytes": sum(sizes[oid] for _, oid in index.values()),
              "unique_blob_bytes": sum(sizes.values()), "unique_blobs": len(sizes),
              "duplicate_occurrences": len(index) - len(sizes),
              "duplicate_logical_bytes": sum(sizes[r["oid"]] * (r["copies"] - 1) for r in duplicates),
              "duplicates": duplicates[:args.limit], "run_groups": sorted(groups.values(), key=lambda r: (-r["files"], r["path"])),
              "filesystem": filesystem, "declared_tracked": declarations, "skipped": skipped,
              "retention_review": sorted(retention, key=lambda r: r["path"]), "ref_namespaces": namespaces,
              "limitations": ["Logical bytes are not disk usage or recoverable space.",
                              "Duplicate content does not imply duplicate scientific purpose.",
                              "No history, reflog, store reachability or reference-graph deletion proof is claimed.",
                              "Retention ages use mtime and require owner review; no files or refs are removed."]}
    emit(result, args.json, [f"run-storage: {len(index)} tracked files; {len(sizes)} unique blobs; "
                            f"{len(index) - len(sizes)} repeated occurrences (not deletion candidates).",
                            *[f"  {g['files']:6d} files  {human(g['logical_bytes']):>12}  {g['path']}"
                              for g in result["run_groups"][:args.limit]],
                            f"  {len(retention)} declared local files need retention review; nothing was changed."])
    return EXIT_OK


def cmd_check(args) -> int:
    repo = Repo(args.project_root, read_only=True)
    threshold = resolve_threshold(repo, args.threshold)
    if args.staged or args.snapshot:
        review = admission(repo, threshold, snapshot=args.snapshot)
        found = staged_bulk(repo, threshold)
        symlinked = repo.symlinked_run_roots()
        result = {"mode": "snapshot" if args.snapshot else "staged", **review, "threshold_bytes": threshold, "run_roots": repo.run_roots, "staged_bulk": found,
                  "symlinked_run_roots": symlinked}
        lines = [f"run-storage: run root {r} passes through a symbolic link; files staged behind it are not "
                 "checked (configure the real path in run_roots)" for r in symlinked]
        if found:
            lines.append(f"run-storage: {len(found)} staged file(s) under {', '.join(repo.run_roots)} at or above "
                         f"{human(threshold)} would enter git history permanently:")
            lines += [f"  {human(r['size']):>12}  {r['path']}" for r in found]
            lines.append("  Keep bulk outputs out of history: git rm --cached <path> (the file stays on disk; for a "
                         "path already in a commit, git restore --staged <path> keeps the committed version "
                         "instead), then run_storage.py stow <run_dir> (see research-harness: Run Storage).")
        elif not symlinked:
            lines.append(f"run-storage: no staged file at or above {human(threshold)} under the run roots.")
        for finding in review["admission_findings"]:
            lines.append(f"  {finding['reason']}: {finding['path']} ({finding['source']})")
        for limit in review["admission_limits"]:
            lines.append(f"  admission {limit['metric']}: {limit['observed']} exceeds {limit['maximum']}; "
                         "classify unique evidence explicitly or stow reproducible outputs before capture")
        violations = found or symlinked or review["admission_findings"] or review["admission_limits"]
        emit(result, args.json, lines if (violations or not args.quiet) else [])
        return EXIT_FINDINGS if (violations and args.strict) else EXIT_OK
    store = repo.store(args.store)
    classes = working_tree_bulk(repo, threshold, store)
    result = {"mode": "working_tree", "threshold_bytes": threshold, "run_roots": repo.run_roots,
              "store": str(store), **classes}
    labels = {
        "tracked": "already committed (every checkout and the object store hold a copy)",
        "pending": "staged, modified, or marked so git hides changes (assume-unchanged / skip-worktree): not "
                   "known to be committed as they are",
        "untracked": "untracked and not ignored (a plain `git add` would commit them)",
        "ignored_unstowed": "ignored but not stowed (lost if this checkout is removed)",
        "stowed_damaged": "recorded in a bulk manifest but changed, missing, recorded twice, or without a valid "
                          "store copy",
        "stowed": "stowed (valid copy in the content store; the copy in place, where present, matches the manifest)",
        "uncommitted_records": "manifest or ignore file of a stowed run not committed as it is (missing, ignored, "
                               "untracked, or changed; the record is lost with this checkout until committed)",
    }
    lines = [f"run-storage: bulk files (>= {human(threshold)}) under {', '.join(repo.run_roots)}:"]
    for r in classes["symlinked_run_roots"]:
        lines.append(f"  run root {r['path']} passes through a symbolic link; its content is not checked "
                     "(configure the real path in run_roots)")
    for r in classes["nested_repositories"]:
        lines.append(f"  {r['path']} is a nested repository; its files follow that repository's rules (not classified)")
    links = classes["symlinks_not_followed"]
    for r in links[: args.limit]:
        lines.append(f"  {r['path']} is a symbolic link, not followed: its target's content is neither checked nor stowed")
    if len(links) > args.limit:
        lines.append(f"  ... {len(links) - args.limit} more symbolic links")
    for key in ("stowed_damaged", "uncommitted_records", "pending", "untracked", "ignored_unstowed", "tracked",
                "stowed"):
        records = classes[key]
        lines.append(f"  {len(records):5d} files {human(sum(r['size'] for r in records)):>12}  {labels[key]}")
        for r in records[: args.limit]:
            lines.append(f"        {human(r['size']):>12}  {r['path']}")
        if len(records) > args.limit:
            lines.append(f"        ... {len(records) - args.limit} more")
    emit(result, args.json, lines)
    violations = (classes["untracked"] or classes["ignored_unstowed"] or classes["stowed_damaged"]
                  or classes["pending"] or classes["symlinked_run_roots"] or classes["uncommitted_records"])
    return EXIT_FINDINGS if (violations and args.strict) else EXIT_OK


# ------------------------------------------------------------------ stow

def inside_of(child: Path, base: Path) -> bool:
    try:
        child.relative_to(base)
        return True
    except ValueError:
        return False


def resolve_run_dir(repo: Repo, run_dir: str) -> Path:
    path = Path(run_dir)
    if not path.is_absolute():
        path = Path.cwd() / path
    if path.is_symlink() or not path.is_dir():
        raise StorageError(f"run directory must be a real directory: {path}")
    path = Path(os.path.realpath(path))
    if not is_under(path, repo.toplevel):
        raise StorageError(f"{path} resolves outside the repository {repo.toplevel} (a symlinked run root?)")
    # Both sides are real paths: run roots passing through a symbolic link are excluded.
    symlinked = repo.symlinked_run_roots()
    roots = [repo.toplevel / root for root in repo.run_roots if root not in symlinked]
    if not any(inside_of(path, base) for base in roots):
        hint = (f"; run root(s) {', '.join(symlinked)} pass through a symbolic link and are refused"
                if symlinked else "")
        raise StorageError(f"{path} is not under a run root ({', '.join(repo.run_roots)}){hint}; "
                           f"add its real root to {POLICY_REL} if it should follow the bulk policy")
    base = next(b for b in roots if inside_of(path, b))
    ancestor = path.parent
    while inside_of(ancestor, base):  # up to and including the run root
        if (ancestor / MANIFEST_NAME).exists():
            raise StorageError(f"{path} lies inside the stowed run directory {ancestor} (it holds a "
                               f"{MANIFEST_NAME}); stow that directory, since a run is recorded by one manifest "
                               f"({RESERVED_NOTE})")
        if ancestor == base:
            break
        ancestor = ancestor.parent
    if Repo(path).toplevel != repo.toplevel:
        raise StorageError(f"{path} belongs to a nested repository (a submodule?), not to {repo.toplevel}")
    for dirpath, dirnames, filenames in os.walk(path, followlinks=False, onerror=walk_error):
        if ".git" in dirnames or ".git" in filenames:
            raise StorageError(f"{dirpath} holds a nested repository; its files follow that repository's rules")
        if Path(dirpath) != path and MANIFEST_NAME in filenames:
            raise StorageError(f"{dirpath} holds a {MANIFEST_NAME}, which marks a stowed run directory inside "
                               f"{path}; a run is recorded by one manifest — stow the inner directory on its own or "
                               f"move it out ({RESERVED_NOTE})")
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


def cmd_stow(args) -> int:
    repo = Repo(args.project_root if args.project_root else args.run_dir, read_only=args.dry_run)
    run_dir = resolve_run_dir(repo, args.run_dir)
    threshold = resolve_threshold(repo, args.threshold)
    store = repo.store(args.store)
    committed, pending = committed_and_pending(repo, [repo.rel(run_dir)])
    existing = load_manifest(run_dir)
    manifest = existing or {"schema": MANIFEST_SCHEMA, "entries": []}
    entries = {e["path"]: e for e in manifest["entries"]}
    folded: "dict[str, list[str]]" = {}
    if repo.ignorecase:
        for k in entries:
            folded.setdefault(k.casefold(), []).append(k)
    check_ignore_markers(run_dir)  # before anything is changed
    # The manifest and ignore file are the record: if git ignores them, nothing could be committed.
    hidden = [name for name in RECORD_NAMES if is_ignored(repo, run_dir / name)]
    if hidden:
        print(f"run-storage: git's ignore rules exclude {', '.join(repo.rel(run_dir / n) for n in hidden)}, so the "
              "stow record could not be committed (nothing was changed). Make them committable (see "
              "`git check-ignore -v <path>` for the rule; a rule that ignores a whole run root cannot be undone "
              "below it), then stow again.", file=sys.stderr)
        return EXIT_FINDINGS

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
    candidates, legacy, uncommitted, unexpressible, links, respelled = [], [], [], [], [], []
    for dirpath, dirnames, filenames in os.walk(run_dir, followlinks=False, onerror=walk_error):
        links += [repo.git_form((Path(dirpath) / n).relative_to(run_dir).as_posix())
                  for n in dirnames + filenames if (Path(dirpath) / n).is_symlink()]
        for name in sorted(filenames):
            full = Path(dirpath) / name
            rel_run = repo.git_form(full.relative_to(run_dir).as_posix())
            if rel_run in (MANIFEST_NAME, ".gitignore") or rel_run in entries:
                continue
            # A recorded file renamed only in letter case is the same file on disk; a different file whose
            # name merely folds to a recorded one is a new candidate like any other.
            if any(same_file(full, run_dir / k) for k in folded.get(rel_run.casefold(), ())):
                respelled.append(rel_run)
                continue
            st = full.lstat()
            if not stat.S_ISREG(st.st_mode) or not bulk_candidate(repo, repo.rel(full), st.st_size, threshold):
                continue
            if repo.rel(full) in committed:
                legacy.append({"path": rel_run, "size": st.st_size})
                continue
            if repo.rel(full) in pending:
                uncommitted.append(rel_run)
                continue
            problem = expressible_problem(rel_run)
            if problem:
                unexpressible.append((rel_run, problem))
                continue
            candidates.append((rel_run, full))
    if conflicts:
        print("run-storage: recorded outputs are changed or unavailable (nothing was changed). A changed "
              "result belongs in a new run. `missing` and `store_mismatch` entries have no valid copy here "
              "(neither in place nor in the store, so `materialize` cannot help): put the recorded bytes back in "
              "place from another copy (another store, a backup) and stow again, or record the result in a new "
              "run:", file=sys.stderr)
        for rel_run, status in conflicts:
            print(f"  {status:>14}  {rel_run}", file=sys.stderr)
        return EXIT_FINDINGS
    if uncommitted:
        print("run-storage: these bulk files are staged or changed but not committed, so the next commit would "
              "put them into history (nothing was changed). For a new file, `git rm --cached <path>` unstages it "
              "(the file stays on disk), then stow again; a committed file that was changed is a changed result "
              "and belongs in a new run. A path marked assume-unchanged or skip-worktree counts as changed (git "
              "hides its working-tree state); clear the mark with `git update-index --no-assume-unchanged` or "
              "`--no-skip-worktree <path>` to have it judged:", file=sys.stderr)
        for rel_run in uncommitted:
            print(f"  {rel_run}", file=sys.stderr)
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
        lines.append(f"  {len(legacy)} bulk file(s) are already committed and stay as they are "
                     "(history is never rewritten here)")
    if links:
        lines.append(f"  {len(links)} symbolic link(s) are not followed; their targets' content is not stowed: "
                     + ", ".join(sorted(links)[:5]) + (" ..." if len(links) > 5 else ""))
    if not plan and existing is None:  # nothing to record: no manifest or ignore block is written
        lines.append("  nothing to stow; no manifest written")
        emit({"stowed": [], "already_tracked": legacy, "symlinks_not_followed": sorted(links), "store": str(store),
              "manifest": None, "commit_needed": False}, args.json, lines)
        return EXIT_OK
    if args.dry_run:
        lines += [f"  would stow {human(sizes[r]):>12}  {r}" for r, _ in plan]
        # A dry run writes nothing, so it does not predict the record's state: null, never a guess.
        emit({"dry_run": True, "planned": [{"path": r, "size": sizes[r]} for r, _ in plan],
              "already_tracked": legacy, "symlinks_not_followed": sorted(links), "store": str(store),
              "commit_needed": None}, args.json, lines)
        return EXIT_OK

    # 3. Store, then record. The manifest is written after every store step
    #    succeeded, so a failure leaves no entry without a stored copy.
    stowed = []
    for rel_run, full in plan:
        make_read_only(full)
        sha, obj, method = store_put(full, store)
        if rel_run in entries and entries[rel_run]["sha256"] != sha:
            raise StorageError(f"{full} changed while being stowed")
        if sha256_file(full) != sha:  # every branch: what is recorded is what is in place
            raise StorageError(f"{full} changed while being stowed; stow it after the run has finished writing")
        size = full.lstat().st_size
        if rel_run not in entries:
            entries[rel_run] = {"path": rel_run, "size": size, "sha256": sha, "stowed_utc": utc_now()}
        stowed.append({"path": rel_run, "size": size, "sha256": sha, "method": method})
        lines.append(f"  stowed {human(size):>12}  {rel_run}  ({method})")
    manifest["entries"] = sorted(entries.values(), key=lambda e: e["path"])
    manifest["threshold_bytes"] = threshold
    changed = update_ignore_block(run_dir, [e["path"] for e in manifest["entries"]])
    changed = write_if_changed(run_dir / MANIFEST_NAME, json_bytes(manifest)) or changed
    not_ignored = [e["path"] for e in manifest["entries"] if not is_ignored(repo, run_dir / e["path"])]
    # The spelling on disk is what git will see; unless git treats case as equal it is not covered.
    case_uncovered = [rel for rel in respelled if not is_ignored(repo, run_dir / rel)]
    if case_uncovered:
        print(f"run-storage: {case_uncovered} are recorded files renamed only in letter case, and git here does "
              "not treat letter case as equal (core.ignorecase is not true), so the ignore block does not cover "
              "them and a plain `git add` would commit them: rename them back to the recorded spelling (or set "
              "core.ignorecase=true).", file=sys.stderr)
        if not not_ignored:
            return EXIT_FINDINGS
    if not_ignored:
        # git never applies ignore rules to a tracked path (e.g. one added with `git add -f`).
        in_index = repo.tracked([repo.rel(run_dir / rel) for rel in not_ignored])
        forced = [rel for rel in not_ignored if repo.rel(run_dir / rel) in in_index]
        reincluded = [rel for rel in not_ignored if rel not in forced]
        if forced:
            print(f"run-storage: {forced} are stowed but tracked by git (added with `git add -f`?), so the ignore "
                  "block cannot keep them out of history: `git rm --cached <path>` (the file stays on disk).",
                  file=sys.stderr)
        if reincluded:
            print(f"run-storage: the ignore block does not cover {reincluded}; a negation rule elsewhere "
                  "re-includes them. Fix the ignore rules before committing.", file=sys.stderr)
        return EXIT_FINDINGS
    # Judged on the files as they now are: a rewrite that restores the committed bytes needs no commit.
    commit_needed = record_needs_commit(repo, run_dir)
    if commit_needed:
        lines.append(f"  commit {repo.rel(run_dir / MANIFEST_NAME)} and {repo.rel(run_dir / '.gitignore')}; "
                     "stowed files are read-only (a corrected result goes to a new run)")
    else:
        lines.append("  the stow record is already committed as it is" + ("" if changed else "; nothing changed"))
    emit({"stowed": stowed, "already_tracked": legacy, "symlinks_not_followed": sorted(links), "store": str(store),
          "manifest": str(run_dir / MANIFEST_NAME), "commit_needed": commit_needed}, args.json, lines)
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
    store_mismatch      absent in place, store object damaged or not of the recorded size
    missing             absent in place and in the store
    unsafe_path         the recorded path leads out of the run directory"""
    target = run_dir / entry["path"]
    status = {"path": entry["path"], "size": entry["size"], "sha256": entry["sha256"]}
    if not entry_path_is_safe(run_dir, entry["path"]):
        status["status"] = "unsafe_path"
        return status
    obj = store_path(store, entry["sha256"])
    store_ok = verify_store_object(obj, entry["sha256"], entry["size"])
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
        if actual != entry["sha256"] or lst.st_size != entry["size"]:
            status.update(status="mismatch", actual_sha256=actual)
        else:
            status["status"] = "ok" if store_ok else "ok_in_place_only"
        return status
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
    verb = "would be restored (dry run)" if args.dry_run else "restored"
    lines = [f"run-storage materialize {repo.rel(run_dir)}: {len(done)} {verb}, {len(problems)} unavailable"]
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
    if not verify_store_object(dest, entry["sha256"], entry["size"]):
        exists = dest.exists() or dest.is_symlink()
        problems.append({"path": entry["path"], "status": "store_mismatch" if exists else "missing"})
        return
    if dry_run:
        done.append({"path": entry["path"], "method": "planned"})
        return
    target.parent.mkdir(parents=True, exist_ok=True)
    done.append({"path": entry["path"], "method": place_from_store(dest, target, entry["sha256"])})


# ------------------------------------------------------------------- main

def non_negative_int(text: str) -> int:
    value = int(text)
    if value < 0:
        raise argparse.ArgumentTypeError("must be 0 or more")
    return value


STORE_HELP = "content store (default: the policy's store_root, else <git common dir>/nullius/store)"


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="run_storage.py", description=__doc__.split("\n\n")[0])
    sub = parser.add_subparsers(dest="command", required=True)

    def common(p, project=True, json_flag=True, limit=True):
        if project:
            p.add_argument("--project-root", default=None, help="repository checkout (default: from the path or cwd)")
        if json_flag:
            p.add_argument("--json", action="store_true", help="machine-readable output")
        if limit:
            p.add_argument("--limit", type=non_negative_int, default=20, help="rows listed per category")

    p = sub.add_parser("check", help="report bulk files under the run roots")
    common(p)
    modes = p.add_mutually_exclusive_group()
    modes.add_argument("--staged", action="store_true", help="inspect index bytes for the next commit")
    modes.add_argument("--snapshot", action="store_true", help="inspect index and dirty tracked bytes before origin capture")
    p.add_argument("--threshold", type=int, default=None, help="bytes (default: policy, 5 MiB)")
    p.add_argument("--strict", action="store_true",
                   help="exit 1 when something needs attention: with --staged, bulk files staged for the next "
                        "commit; otherwise bulk that is damaged, pending, untracked, or ignored but unstowed, "
                        "and stow records (manifest, ignore file) not committed as they are; "
                        "in both modes, a run root that passes through a symbolic link")
    p.add_argument("--quiet", action="store_true", help="print nothing when there is nothing to report")
    p.add_argument("--store", default=None, help=STORE_HELP)
    p.set_defaults(func=cmd_check)

    p = sub.add_parser("stow", help="store a finished run's bulk outputs (independent copy; the file stays in place, read-only)")
    common(p)
    p.add_argument("run_dir")
    p.add_argument("--threshold", type=int, default=None)
    p.add_argument("--store", default=None, help=STORE_HELP)
    p.add_argument("--dry-run", action="store_true")
    p.set_defaults(func=cmd_stow)

    p = sub.add_parser("verify", help="check manifest entries against their sha256")
    common(p, limit=False)
    p.add_argument("run_dir")
    p.add_argument("--store", default=None, help=STORE_HELP)
    p.set_defaults(func=cmd_verify)

    p = sub.add_parser("materialize", help="recreate missing manifest entries from the store")
    common(p, limit=False)
    p.add_argument("run_dir")
    p.add_argument("--store", default=None, help=STORE_HELP)
    p.add_argument("--dry-run", action="store_true")
    p.set_defaults(func=cmd_materialize)

    p = sub.add_parser("inventory", help="read-only file counts, duplicate index objects and retention review")
    common(p)
    p.set_defaults(func=cmd_inventory)
    return parser


SUBCOMMANDS = ("check", "stow", "verify", "materialize", "inventory")


def main(argv: "list[str] | None" = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    if getattr(args, "project_root", None) is None and args.command in ("check", "inventory"):
        args.project_root = "."
    try:
        return args.func(args)
    except StorageError as exc:
        print(f"run-storage: {exc}", file=sys.stderr)
        return EXIT_ERROR
    except OSError as exc:
        print(f"run-storage: {exc}", file=sys.stderr)
        return EXIT_ERROR
    except (ValueError, RuntimeError, UnicodeError) as exc:  # unusual input: an error, never "findings"
        print(f"run-storage: cannot process this input ({type(exc).__name__}: {exc})", file=sys.stderr)
        return EXIT_ERROR


if __name__ == "__main__":
    sys.exit(main())
