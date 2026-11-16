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
  install-hook      install the staged storage check in the repository's pre-commit hook.
  sparse-exclude-bulk  omit selected tracked outputs from a checkout with Git sparse patterns.
  store-put         copy a file into a verified content-addressed store.
  tree-digest       hash a directory inventory and optionally store or compare it.
  closeout          preview or apply cleanup to a finished scratch directory.
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
  worktree-check    read-only: can a linked worktree be removed without
                    losing anything? Lists what exists only there
                    (``git worktree remove`` deletes ignored files silently).
  report            read-only estimate of reclaimable bytes under any trees:
                    duplicate content, regenerable directories, separate
                    history copies and bundles already contained in a
                    reference repository, stale temporary roots, and a
                    rough compression estimate.

``--store PATH`` overrides the policy's store for ``stow``, ``verify``,
``materialize``, ``worktree-check``, and ``check`` without ``--staged``.

Exit codes: 0 clean; 1 findings (strict-check violations, verification or
restore problems, a worktree that must be kept, a stow refused because
recorded outputs changed or are unavailable, because bulk files are staged or
changed but not committed, because git ignores the manifest or ignore file,
because the ignore block does not cover a recorded file renamed only in
letter case, or because an ignore rule re-includes a stowed file or git
tracks it anyway); 2 usage or
environment errors and inputs refused before any change (unrecordable file
names, damaged ignore-block markers, a run directory inside or around another
stowed run, a malformed manifest or policy, a store inside a checkout).
POSIX (macOS/Linux) only.
Scratch closeout is previewed before application. Sparse exclusion leaves the
original tracked bytes in Git. Stow keeps run files readable in place.

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


def canonical_json(obj) -> bytes:
    return (json.dumps(obj, sort_keys=True, separators=(",", ":"), ensure_ascii=False) + "\n").encode("utf-8", "backslashreplace")


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
    if literal_pathspecs:
        env["GIT_LITERAL_PATHSPECS"] = "1"
    else:  # check-ignore dies in this mode (it takes plain path names anyway), even when inherited
        env.pop("GIT_LITERAL_PATHSPECS", None)
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


PATHS_PER_CALL = 500
PATH_BYTES_PER_CALL = 64 * 1024  # a conservative macOS/Linux budget for the path arguments of one call (the fixed arguments and the environment come on top; a failed call is reported, never read as a verdict)


def batches(paths: "list[str]") -> "list[list[str]]":
    """Path names in groups small enough for one command line each: at most
    PATHS_PER_CALL names and PATH_BYTES_PER_CALL bytes per group (a single
    longer name gets a group of its own)."""
    groups: "list[list[str]]" = []
    current: "list[str]" = []
    size = 0
    for path in paths:
        n = len(os.fsencode(path)) + 1
        if current and (len(current) >= PATHS_PER_CALL or size + n > PATH_BYTES_PER_CALL):
            groups.append(current)
            current, size = [], 0
        current.append(path)
        size += n
    if current:
        groups.append(current)
    return groups or [[]]


def git_z_paths(args: "list[str]", paths: "list[str]", cwd: Path) -> "list[str]":
    """`git <args> -- <paths>` run once per batch of paths; the outputs joined."""
    out: "list[str]" = []
    for group in batches(paths):
        if group:
            out += git_z([*args, "--", *group], cwd)
    return out


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
        except OSError as exc:
            print(f"run-storage: could not remove the probe file {probe} ({exc.strerror or exc}); "
                  "delete it by hand", file=sys.stderr)


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
        # git itself folds letter case (core.ignorecase=true) only for ASCII letters.
        self.ignorecase_configured = git(["config", "--bool", "core.ignorecase"], self.toplevel,
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
            # Measured where bulk outputs live: the first existing run root, else the checkout.
            where = next((self.toplevel / r for r in self.run_roots
                          if (self.toplevel / r).is_dir() and not (self.toplevel / r).is_symlink()), self.toplevel)
            # Read commands must not create a filesystem probe. Conservative
            # folding is safe: each alias is still checked by device/inode.
            self._ignorecase = True if self.read_only else self.ignorecase_configured or case_insensitive(where)
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
        if not existing.is_dir():
            raise StorageError(f"content store {store} passes through {existing}, which is not a directory")
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
        return set(git_z_paths(["ls-files", "-z"], pathspecs, self.toplevel)) if pathspecs else set()

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
    if not is_sha256_hex(sha):
        raise StorageError("invalid content store SHA-256")
    obj = store / "sha256" / sha[:2] / sha
    if obj.parent.resolve() != store.resolve() / "sha256" / sha[:2]:
        raise StorageError("content store shard passes through a symbolic link")
    return obj


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


# ------------------------------------------------------------- manifests

RESERVED_NOTE = (f"under a run root the file name {MANIFEST_NAME} is reserved for run storage manifests; "
                 "rename a data file that has this name")


def tree_inventory(root: Path, skip: "set[str] | None" = None) -> dict:
    """Inventory of every entry under ``root``: {relative path: record}.
    Symlinks are recorded by target, never followed."""
    root = Path(root)
    skip = skip or set()
    inventory: dict = {}
    for dirpath, dirnames, filenames in os.walk(root, followlinks=False, onerror=walk_error):
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


def blob_ids(repo: Repo, args: "list[str]", paths: "list[str] | None" = None) -> "dict[str, tuple[str, str]]":
    """Map path -> (file mode, object id) from ls-tree or ls-files --stage, for
    the given paths (batched so long lists fit one command line) or, with no
    paths, for everything the command lists."""
    found = {}
    # A failure is an error, never "nothing committed".
    items = git_z(args, repo.toplevel) if paths is None else git_z_paths(args, paths, repo.toplevel)
    for item in items:
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
    head = blob_ids(repo, ["ls-tree", "-r", "-z", "HEAD"], pathspecs) if born else {}
    index = blob_ids(repo, ["ls-files", "--stage", "-z"], pathspecs)
    modified = set(git_z_paths(["diff", "--name-only", "-z"], pathspecs, repo.toplevel))
    # `ls-files -v` tags a plain entry "H"; assume-unchanged entries get a
    # lowercase tag and skip-worktree entries "S". Only plain entries are trusted.
    flagged = {item[2:] for item in git_z_paths(["ls-files", "-v", "-z"], pathspecs, repo.toplevel)
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
    stage = git_z_paths(["ls-files", "--stage", "-z"], changed, repo.toplevel)
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
    stowed_folded: "dict[str, list[tuple[Path, dict]]]" = {}
    if repo.ignorecase:
        for rel, records in stowed.items():
            for run_dir, entry in records:
                stowed_folded.setdefault(rel.casefold(), []).append((run_dir, entry))
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
                elif rel in stowed or any(same_file(full, run_dir / entry["path"]) or renamed_copy(full, run_dir, entry)
                                          for run_dir, entry in stowed_folded.get(rel.casefold(), ())):
                    continue  # the recorded output itself (or it, renamed only in letter case): classified above
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
        elif in_root and row["size"] >= threshold and not storage_record:
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
        if in_root and not storage_record:
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
    violations = (classes["untracked"] or classes["ignored_unstowed"] or classes["stowed_damaged"]
                  or classes["pending"] or classes["symlinked_run_roots"] or classes["uncommitted_records"])
    notices = classes["nested_repositories"] or classes["symlinks_not_followed"]
    emit(result, args.json, lines if (violations or notices or not args.quiet) else [])
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


def renamed_copy(full: Path, run_dir: Path, entry: dict) -> bool:
    """On a case-sensitive file system a recorded file renamed only in letter
    case is a new name for the same bytes: the recorded spelling is gone from
    the run directory and this file holds exactly the recorded size and hash."""
    if (run_dir / entry["path"]).exists() or (run_dir / entry["path"]).is_symlink():
        return False
    try:
        st = full.lstat()
    except OSError:
        return False
    return stat.S_ISREG(st.st_mode) and st.st_size == entry["size"] and sha256_file(full) == entry["sha256"]


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


def refuse(args, kinds: "dict[str, list[dict]]", messages: "list[str]", code: int, record_written: bool = False,
           done: "dict | None" = None, done_lines: "list[str] | None" = None) -> int:
    """Report a refusal: the explanation (with one line per path) on stderr and,
    with --json, a result object on stdout naming each kind of refusal and the
    paths it concerns. A refusal after the record was written also reports
    what was done (`done`, `done_lines`)."""
    for message in [*(done_lines or []), *messages]:
        print(message.encode("utf-8", "backslashreplace").decode("utf-8"), file=sys.stderr)
    if getattr(args, "json", False):
        emit({"refused": sorted(kinds), "items": kinds, "record_written": record_written, **(done or {})}, True, [])
    return code


def path_list(items: "list[str]") -> str:
    return ", ".join(items)


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
        rels = [repo.rel(run_dir / n) for n in hidden]
        return refuse(args, {"records_ignored": [{"path": r} for r in rels]}, [
            f"run-storage: git's ignore rules exclude {path_list(rels)}, so the stow record could not be committed "
            "(nothing was changed). Make them committable (see `git check-ignore -v <path>` for the rule; a rule "
            "that ignores a whole run root cannot be undone below it), then stow again."], EXIT_FINDINGS)

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
            twins = folded.get(rel_run.casefold(), ())
            if any(same_file(full, run_dir / k) for k in twins) or any(renamed_copy(full, run_dir, entries[k])
                                                                         for k in twins):
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
        return refuse(args, {"recorded_outputs_unavailable": [{"path": r, "status": st} for r, st in conflicts]}, [
            "run-storage: recorded outputs are changed or unavailable (nothing was changed). A changed result "
            "belongs in a new run. `missing` and `store_mismatch` entries have no valid copy here (neither in "
            "place nor in the store, so `materialize` cannot help): put the recorded bytes back in place from "
            "another copy (another store, a backup) and stow again, or record the result in a new run. A file that "
            "was only renamed in letter case is restored by renaming it back to the recorded spelling:",
            *[f"  {st:>14}  {r}" for r, st in conflicts]], EXIT_FINDINGS)
    if uncommitted:
        return refuse(args, {"uncommitted_bulk": [{"path": r} for r in uncommitted]}, [
            "run-storage: these bulk files are staged or changed but not committed, so the next commit would put "
            "them into history (nothing was changed). For a new file, `git rm --cached <path>` unstages it (the "
            "file stays on disk), then stow again; a committed file that was changed is a changed result and "
            "belongs in a new run. A path marked assume-unchanged or skip-worktree counts as changed (git hides "
            "its working-tree state); clear the mark with `git update-index --no-assume-unchanged` or "
            "`--no-skip-worktree <path>` to have it judged:", *[f"  {r}" for r in uncommitted]], EXIT_FINDINGS)
    if unexpressible:
        return refuse(args, {"unrecordable_names": [{"path": r, "problem": pr} for r, pr in unexpressible]}, [
            "run-storage: these file names cannot be recorded in a manifest or ignore rule; rename them and stow "
            "again (nothing was changed):", *[f"  {pr}: {r!r}" for r, pr in unexpressible]], EXIT_ERROR)
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
        # Under the current ignore rules: the real stow would refuse these (the managed block only lists
        # the recorded spelling).
        uncovered_now = [rel for rel in respelled if not is_ignored(repo, run_dir / rel)]
        lines += [f"  would refuse: {rel} is a recorded file renamed only in letter case that the ignore rules do "
                  "not cover" for rel in uncovered_now]
        # A dry run writes nothing, so it does not predict the record's state: null, never a guess.
        emit({"dry_run": True, "planned": [{"path": r, "size": sizes[r]} for r, _ in plan],
              "already_tracked": legacy, "symlinks_not_followed": sorted(links), "store": str(store),
              "commit_needed": None, "case_respelled_uncovered": uncovered_now}, args.json, lines)
        return EXIT_FINDINGS if uncovered_now else EXIT_OK

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
    # git never applies ignore rules to a tracked path (e.g. one added with `git add -f`).
    in_index = repo.tracked([repo.rel(run_dir / rel) for rel in not_ignored]) if not_ignored else set()
    forced = [rel for rel in not_ignored if repo.rel(run_dir / rel) in in_index]
    reincluded = [rel for rel in not_ignored if rel not in forced]
    kinds: "dict[str, list[dict]]" = {}
    messages: "list[str]" = []
    if case_uncovered:
        kinds["case_respelled_uncovered"] = [{"path": r} for r in case_uncovered]
        messages.append(f"run-storage: {path_list(case_uncovered)}: recorded file(s) renamed only in letter case "
                        "that the ignore block does not cover (git folds letter case only with "
                        "core.ignorecase=true, and then only for ASCII letters), so a plain `git add` would commit "
                        "them: rename them back to the recorded spelling."
                        + ("" if repo.ignorecase_configured else " On a case-insensitive file system, setting "
                           "core.ignorecase=true also works when the spellings differ only in ASCII letters."))
    if forced:
        kinds["stowed_but_tracked"] = [{"path": r} for r in forced]
        messages.append(f"run-storage: {path_list(forced)}: stowed but tracked by git (added with `git add -f`?), "
                        "so the ignore block cannot keep them out of history: `git rm --cached <path>` (the file "
                        "stays on disk).")
    if reincluded:
        kinds["reincluded_by_negation"] = [{"path": r} for r in reincluded]
        messages.append(f"run-storage: the ignore block does not cover {path_list(reincluded)}; a negation rule "
                        "elsewhere re-includes them. Fix the ignore rules before committing.")
    if kinds:  # the files are stored and recorded; what stays to fix is the ignore rules or the index
        return refuse(args, kinds, messages, EXIT_FINDINGS, record_written=True,
                      done={"stowed": stowed, "already_tracked": legacy, "symlinks_not_followed": sorted(links),
                            "store": str(store), "manifest": str(run_dir / MANIFEST_NAME),
                            "commit_needed": record_needs_commit(repo, run_dir)},
                      done_lines=lines)
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


# ----------------------------------------------------------- worktree-check

# Directories and files rebuilt by a tool from recorded inputs.
REGENERABLE_DIR_NAMES = frozenset({
    "node_modules", "__pycache__", ".pytest_cache", ".mypy_cache", ".ruff_cache", ".tox", ".ipynb_checkpoints",
})
REGENERABLE_FILE_SUFFIXES = (".pyc", ".pyo")
REGENERABLE_FILE_NAMES = frozenset({".DS_Store"})
# Machine-local bookkeeping that the tool rewrites from scratch (the invocation
# anchor, on every reconnect). The other ignored `.nullius/` files are not on
# this list: the event ledger is this checkout's own history, and refresh
# backups hold the user's customizations of managed files; they are judged like
# any other ignored file.
MACHINE_BOOKKEEPING = (".nullius/HARNESS_INVOCATION",)


def is_regenerable(rel_posix: str) -> bool:
    parts = rel_posix.split("/")
    if any(part in REGENERABLE_DIR_NAMES for part in parts[:-1]):
        return True
    name = parts[-1]
    return name in REGENERABLE_FILE_NAMES or name.endswith(REGENERABLE_FILE_SUFFIXES) or name in REGENERABLE_DIR_NAMES


def is_machine_bookkeeping(rel_posix: str) -> bool:
    return any(rel_posix == p or (p.endswith("/") and rel_posix.startswith(p)) for p in MACHINE_BOOKKEEPING)


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
        tag, sep, rel = item.partition(" ")
        if len(tag) != 1 or not sep:
            raise StorageError(f"unexpected `git ls-files -v` record {item!r} in {path}")
        if tag.islower() or tag == "S":
            flagged.append(rel)
    if not flagged:
        return []
    index = {}
    for item in git_z_paths(["ls-files", "-s", "-z"], flagged, path):
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
        # Compared whatever core.filemode says: with it off, git does not record a changed
        # executable bit, but removing the worktree would still lose it.
        if bool(st.st_mode & stat.S_IXUSR) != (mode == "100755"):
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


# The only per-worktree git state whose meaning worktree-check fully assesses.
# Anything else in the worktree's private git directory (its own refs or ref
# logs, an in-progress merge/rebase/bisect, a lock, private ignore rules,
# submodule stores, ...) makes the verdict `keep`: unknown state is kept,
# never guessed at.
KNOWN_PRIVATE_GIT_FILES = frozenset({
    "HEAD", "ORIG_HEAD", "FETCH_HEAD", "COMMIT_EDITMSG", "commondir", "gitdir", "index", "config.worktree",
    "logs/HEAD", "info/sparse-checkout",
})
KNOWN_PRIVATE_GIT_DIRS = frozenset({"logs", "info"})
BOOLEAN_WORKTREE_SETTINGS = frozenset({"core.sparsecheckout", "core.sparsecheckoutcone", "index.sparse", "core.longpaths"})


def benign_worktree_setting(key: str, value: str, common_dir: Path) -> bool:
    """Per-worktree settings that hold no data: sparse-checkout switches and
    long-path support, and a hooks path naming the repository's own hooks
    directory (what agent desktop apps write when they create a worktree)."""
    key = key.lower()
    if key in BOOLEAN_WORKTREE_SETTINGS:
        return value.lower() in ("true", "false")
    if key == "core.bare":  # written for worktrees of a bare repository
        return value.lower() == "false"
    if key == "core.hookspath":
        return Path(os.path.realpath(os.path.expanduser(value))) == Path(os.path.realpath(common_dir / "hooks"))
    return False


def has_no_entries(path: Path) -> bool:
    """True when the directory itself holds nothing at all (no entries of any kind);
    a directory that cannot be read counts as holding something."""
    try:
        with os.scandir(path) as entries:
            return next(iter(entries), None) is None
    except OSError:
        return False


def unassessed_private_git_state(git_dir: Path, common_dir: Path) -> "list[str]":
    unknown = []
    try:
        for dirpath, dirnames, filenames in os.walk(git_dir, followlinks=False, onerror=walk_error):
            here = Path(dirpath)
            for name in dirnames:
                rel = (here / name).relative_to(git_dir).as_posix()
                if (here / name).is_symlink():
                    unknown.append(rel + "/")
                elif rel == "refs" and has_no_entries(here / name):
                    # git itself creates an empty refs/ in every new worktree's private
                    # directory (seen with git 2.50). Only that one, and only while it holds
                    # no entry at all, is understood; anything inside it (even an empty
                    # refs/heads/topic/), and any other unknown directory, empty or not, is
                    # state this check does not assess (its existence may be the state).
                    pass
                elif rel not in KNOWN_PRIVATE_GIT_DIRS:
                    unknown.append(rel + "/")
            dirnames[:] = [d for d in dirnames if (here / d).relative_to(git_dir).as_posix() in KNOWN_PRIVATE_GIT_DIRS
                           and not (here / d).is_symlink()]
            for name in filenames:
                rel = (here / name).relative_to(git_dir).as_posix()
                if rel not in KNOWN_PRIVATE_GIT_FILES or (here / name).is_symlink():
                    unknown.append(rel)
    except OSError as exc:
        raise StorageError(f"cannot read the worktree's private git directory ({exc})")
    config = git_dir / "config.worktree"
    if config.is_file() and not config.is_symlink():
        listing = git(["config", "--file", str(config), "--null", "--list"], git_dir, check=False)
        pairs = [item.split("\n", 1) for item in listing.stdout.decode("utf-8", "replace").split("\0") if item]
        if listing.returncode != 0 or any(len(pair) != 2 or not benign_worktree_setting(pair[0], pair[1], common_dir)
                                          for pair in pairs):
            unknown.append("config.worktree (settings beyond sparse checkout, long paths, and the repository's "
                           "own hooks path)")
    # info/sparse-checkout holds which tracked files are checked out. Only the
    # documented form (include everything, then exclude named paths) is
    # understood: it records nothing but files left out of this checkout, all of
    # them in git. Other patterns (cone mode, the user's own rules) keep the worktree.
    sparse = git_dir / "info" / "sparse-checkout"
    if sparse.is_file() and not sparse.is_symlink():
        try:
            patterns = sparse.read_bytes().decode("utf-8").splitlines()
        except (OSError, UnicodeDecodeError):
            patterns = None
        if not patterns or patterns[0] != "/*" or not all(line.startswith("!/") for line in patterns[1:]):
            unknown.append("info/sparse-checkout (patterns other than '/*' followed by '!/' exclusions)")
    return sorted(unknown)


def _shas_in(text: str, source: str, log_format: bool) -> "set[str]":
    found: "set[str]" = set()
    for line in text.splitlines():
        if not line.strip():
            continue
        fields = line.split(" ", 2) if log_format else [line.split()[0]]
        if log_format and len(fields) < 3:
            raise StorageError(f"this worktree's {source} is not readable; its commits cannot be assessed")
        for sha in fields[:2]:
            if not (len(sha) in (40, 64) and set(sha) <= HEX):
                raise StorageError(f"this worktree's {source} is not readable; its commits cannot be assessed")
            if set(sha) != {"0"}:
                found.add(sha)
    return found


def reflog_only_commits(path: Path) -> "list[str]":
    """Objects remembered only by this worktree's private records (its HEAD
    reflog, ORIG_HEAD, FETCH_HEAD) that no shared ref reaches. Those records
    live in the worktree's private git directory, so removing the worktree
    leaves such commits unreferenced (collectable)."""
    git_dir = Path(git_text(["rev-parse", "--git-dir"], path))
    git_dir = git_dir if git_dir.is_absolute() else path / git_dir
    remembered: "set[str]" = set()
    # Read the files themselves: `git reflog` falls back to printing HEAD alone,
    # with success, when the log is missing, corrupt, or unreadable.
    for rel, log_format in (("logs/HEAD", True), ("ORIG_HEAD", False), ("FETCH_HEAD", False)):
        record = git_dir / rel
        if not (record.exists() or record.is_symlink()):
            continue
        try:
            data = record.read_bytes()
        except OSError as exc:
            raise StorageError(f"cannot read this worktree's {rel} ({exc}); its commits cannot be assessed")
        remembered |= _shas_in(data.decode("utf-8", "replace"), rel, log_format)
    if remembered:
        listing = git(["cat-file", "--batch-check=%(objectname) %(objecttype)"], path,
                      input_bytes=("\n".join(sorted(remembered)) + "\n").encode()).stdout.decode().splitlines()
        # Any object type (a fetched annotated tag names a tag object); an object
        # that is not in this repository any more has nothing left to lose.
        remembered = {line.split()[0] for line in listing if not line.endswith(" missing")}
    if not remembered:
        return []
    # --exclude applies to the next ref selector only, so the exclusions sit
    # directly before the one --glob that covers every shared ref; --objects
    # covers tag, tree and blob objects as well as commits.
    shared = git(["rev-list", "--objects", "--exclude=refs/worktree/*", "--exclude=refs/bisect/*",
                  "--exclude=refs/rewritten/*", "--glob=refs/*"], path, check=False)
    if shared.returncode != 0:
        return sorted(remembered)  # cannot tell: count every remembered object as at risk
    reachable = {line.split()[0] for line in shared.stdout.decode().splitlines() if line.strip()}
    return sorted(remembered - reachable)


def exact_patch_ids(path: Path, revs: "list[str]") -> "dict[str, str] | None":
    """Commit -> digest of its patch text, byte for byte, for the non-merge
    commits `git rev-list revs` lists: whitespace, file modes, binary content
    and the hunk positions all count (`git patch-id`, even with --verbatim,
    discards hunk positions, so two commits making the same textual change at
    different places in a file would share an id). A rewritten commit whose
    hunks moved is therefore not credited: the worktree is kept, which is the
    safe side. A commit whose patch is empty gets no id. None when git fails."""
    listing = git(["rev-list", "--no-merges", *revs, "--"], path, check=False)
    if listing.returncode != 0:
        return None
    ids: "dict[str, str]" = {}
    for commit in listing.stdout.decode().split():
        patch = git(["diff-tree", "--no-commit-id", "-p", "--no-color", "--no-ext-diff", "--no-textconv", "--no-renames",
                     "--binary", "--full-index", "-r", commit, "--"], path, check=False)
        if patch.returncode != 0:
            return None
        if patch.stdout.strip():
            ids[commit] = hashlib.sha256(patch.stdout).hexdigest()
    return ids


def rewritten_copy_on_base(path: Path, base: str, obj: str) -> bool:
    """A commit only this worktree remembers whose changes are all on the base
    branch: no merge lies between the merge base and it, and every commit of
    that stretch has a byte-identical patch text (hunk positions included)
    among the base's own commits since the merge base. This is what an amended
    or rebased commit leaves in a
    reflog; its content is reconstructible from base, so removing the worktree
    loses nothing."""
    if git(["cat-file", "-t", obj], path, check=False).stdout.decode().strip() != "commit":
        return False  # e.g. an annotated tag object: assessed as at risk
    if git(["merge-base", base, obj], path, check=False).returncode != 0:
        return False  # unrelated history
    merges = git(["rev-list", "--merges", f"{base}..{obj}"], path, check=False)
    if merges.returncode != 0 or merges.stdout.strip():
        return False
    stretch = git(["rev-list", "--no-merges", f"{base}..{obj}"], path, check=False)
    commits = stretch.stdout.decode().split()
    mine = exact_patch_ids(path, [f"{base}..{obj}"])
    theirs = exact_patch_ids(path, [f"{obj}..{base}"])
    if stretch.returncode != 0 or not commits or mine is None or theirs is None:
        return False
    # Each commit of the stretch must be matched by a distinct base commit with
    # the same patch text: a change made twice here (P, its inverse, P again)
    # is not reproduced by a base that made it once, so digests are consumed,
    # not merely looked up. A commit with an empty patch (no id) is not shown
    # to be on base: kept.
    available: "dict[str, int]" = {}
    for digest in theirs.values():
        available[digest] = available.get(digest, 0) + 1
    for c in commits:
        digest = mine.get(c)
        if digest is None or available.get(digest, 0) == 0:
            return False
        available[digest] -= 1
    return True


def worktree_private_refs(path: Path, base: str) -> "list[str]":
    """Per-worktree refs (refs/worktree/*, refs/bisect/*, refs/rewritten/*)
    pointing at commits the base branch does not contain."""
    out = git(["for-each-ref", "--format=%(refname) %(objectname)", "refs/worktree/", "refs/bisect/",
               "refs/rewritten/"], path)  # a failure is an error (keep), never "no refs"
    if out.stderr.strip():  # e.g. "ignoring broken ref": the enumeration is incomplete
        raise StorageError(f"the worktree-private refs could not all be read ({out.stderr.decode(errors='replace').strip()})")
    held = []
    for line in out.stdout.decode().splitlines():
        name, _, sha = line.partition(" ")
        if git(["cat-file", "-t", sha], path, check=False).stdout.decode().strip() != "commit":
            held.append(name)  # e.g. an annotated tag object: the tag itself would be lost
            continue
        peeled = git(["rev-parse", "--verify", "--quiet", f"{sha}^{{commit}}"], path, check=False)
        commit = peeled.stdout.decode().strip() if peeled.returncode == 0 else None
        if commit is None or git(["merge-base", "--is-ancestor", commit, base], path, check=False).returncode != 0:
            held.append(name)
    return held


def worktree_record_owner(git_dir: Path) -> "Path | None":
    """The `.git` file a linked worktree's record points back to (its
    `gitdir` file: an absolute path, or one relative to the record), or None
    when it cannot be read."""
    record = git_dir / "gitdir"
    try:
        raw = record.read_bytes().decode("utf-8").strip()
    except (OSError, UnicodeDecodeError):
        return None
    if not raw:
        return None
    return Path(os.path.realpath(raw if os.path.isabs(raw) else git_dir / raw))


def check_one_worktree(path: Path, base: str, main_root: "Path | None", store: Path) -> dict:
    report: dict = {"worktree": str(path), "reasons": []}
    if not path.is_dir():
        report.update(verdict="keep", reasons=["path does not exist (prune stale metadata with `git worktree prune`)"])
        return report
    wt = Repo(path)
    path = wt.toplevel
    report["worktree"] = str(path)
    if not wt.is_linked_worktree:
        report.update(verdict="keep", reasons=["not a linked worktree: a main checkout (of this repository or of "
                                               "a separate one)"])
        return report
    # A linked worktree's record (its private git directory) names the checkout it belongs to. A copied
    # checkout, or one whose record a newer worktree has reused, shares that other tree's HEAD and index:
    # every git answer here would describe the other tree, so nothing further is asked of git.
    owner = worktree_record_owner(wt.git_dir)
    if owner != Path(os.path.realpath(path / ".git")):
        report.update(verdict="keep", record_owner=str(owner) if owner else None, reasons=[
            f"its .git file names the worktree record {wt.git_dir}, which belongs to "
            f"{owner.parent if owner else 'no readable checkout'}, not to this one: a copy or an orphan. git commands "
            "run here read and write that other worktree's HEAD and index; never use `git worktree remove` or "
            "`git worktree prune` on it"])
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
    # With core.filemode off, `git status` also hides a changed executable bit on every
    # tracked file; the bit is compared regardless, since removal would lose it.
    if git(["config", "--bool", "core.filemode"], path, check=False).stdout.decode().strip() == "false":
        differing = git_z(["-c", "core.filemode=true", "diff", "--no-renames", "--name-only", "-z",
                           "--ignore-submodules=all"], path)  # content differences included; deduplicated below
        changed += [rel for rel in differing if rel not in changed]
    report["tracked_changes"] = changed
    report["untracked"] = untracked
    gitlinks = [item for item in git_z(["ls-files", "-z", "--stage"], path) if item.startswith("160000 ")]
    if (path / ".gitmodules").exists() or gitlinks:
        report["reasons"].append("contains submodules; their own commits and changes are not assessed here")
    unknown_state = unassessed_private_git_state(wt.git_dir, wt.common_dir)
    report["unassessed_git_state"] = unknown_state
    if unknown_state:
        report["reasons"].append("per-worktree git state that this check does not assess: "
                                 + ", ".join(unknown_state[:5]) + (" ..." if len(unknown_state) > 5 else ""))
    remembered_only = reflog_only_commits(path)
    rewritten = [c for c in remembered_only if rewritten_copy_on_base(path, base, c)]
    report["reflog_only_commits"] = [c for c in remembered_only if c not in rewritten]
    report["rewritten_copies_on_base"] = rewritten
    if report["reflog_only_commits"]:
        report["reasons"].append(f"{len(report['reflog_only_commits'])} commit(s) are remembered only by this "
                                 "worktree's own records (HEAD reflog, ORIG_HEAD, FETCH_HEAD; unreferenced once it "
                                 f"is removed) and their changes are not all on {base}")
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
        if store_usable and verify_store_object(store_path(store, sha), sha, st.st_size):
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
    report["ignored"] = classes
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


HOOK_MARKER = "# run_storage.py pre-commit check"


def cmd_install_hook(args) -> int:
    repo = Repo(args.project_root)
    hooks_dir = Path(git_text(["rev-parse", "--git-path", "hooks"], repo.toplevel))
    if not hooks_dir.is_absolute():
        hooks_dir = (repo.toplevel / hooks_dir).resolve()
    if hooks_dir.resolve() != repo.common_dir / "hooks":
        raise StorageError("custom hooks path is in use; add check --staged to that hook manually")
    hook = hooks_dir / "pre-commit"
    script = shlex.quote(str(Path(__file__).resolve()))

    def hook_body(strict: bool) -> bytes:
        options = " --strict" if strict else ""
        return (f"#!/bin/sh\n{HOOK_MARKER}\nSCRIPT={script}\n"
                'if [ -f "$SCRIPT" ] && command -v python3 >/dev/null 2>&1; then\n'
                f'  exec python3 "$SCRIPT" check --staged --quiet{options}\n'
                "fi\n"
                'echo "run-storage check could not run: $SCRIPT or python3 is missing" >&2\n'
                f"exit {1 if strict else 0}\n").encode("utf-8")

    body = hook_body(args.strict)
    if hook.exists() or hook.is_symlink():
        if hook.is_symlink() or not hook.is_file() or hook.read_bytes() not in (hook_body(False), hook_body(True)):
            raise StorageError(f"keeping existing pre-commit hook {hook}; add check --staged manually")
    if args.dry_run:
        print(f"would write {hook}:\n{body.decode()}")
        return EXIT_OK
    write_atomic(hook, body, mode=0o755)
    print(f"installed {hook} ({'blocks' if args.strict else 'warns about'} commits adding bulk files)")
    return EXIT_OK


def cmd_sparse_exclude_bulk(args) -> int:
    repo = Repo(args.worktree or ".")
    if not repo.is_linked_worktree:
        raise StorageError("sparse exclusion requires a linked worktree; the main checkout keeps its files")
    threshold = resolve_threshold(repo, args.threshold)
    if git(["config", "--bool", "core.sparseCheckout"], repo.toplevel, check=False).stdout.decode().strip() == "true":
        raise StorageError("sparse checkout is already configured in this worktree; not overwriting it "
                           "(`git sparse-checkout list` shows the current patterns)")
    sparse_file = repo.git_dir / "info" / "sparse-checkout"
    if sparse_file.exists() or sparse_file.is_symlink():
        raise StorageError("existing sparse-checkout patterns must be preserved")
    if repo.symlinked_run_roots():
        raise StorageError("a configured run root passes through a symbolic link")
    listing = git_z(["ls-tree", "-r", "-l", "-z", "HEAD", "--", *repo.run_roots], repo.toplevel)
    bulk = []
    for item in listing:
        meta, _, rel = item.partition("\t")
        parts = meta.split()
        if (len(parts) == 4 and parts[0] in ("100644", "100755") and parts[3].isdigit()
                and not is_storage_record(rel) and bulk_candidate(repo, rel, int(parts[3]), threshold)):
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
    staged = set(git_z(["diff", "--cached", "--name-only", "-z", "HEAD"], repo.toplevel))
    if staged & bulk_paths:
        raise StorageError("a candidate has staged changes")
    for item in listing:
        meta, _, rel = item.partition("\t")
        if rel not in bulk_paths:
            continue
        mode, _, blob, _ = meta.split()
        full = repo.toplevel / rel
        st = full.lstat()
        if (full.resolve() != full or not stat.S_ISREG(st.st_mode)
                or bool(st.st_mode & stat.S_IXUSR) != (mode == "100755")
                or git_text(["hash-object", "--no-filters", "--", rel], repo.toplevel) != blob):
            raise StorageError(f"working copy of {rel!r} differs from the bytes or mode in Git")
    patterns = ["/*", *["!" + gitignore_escape(r["path"]) for r in bulk]]
    rules = ("\n".join(patterns) + "\n").encode("utf-8")
    # Ask Git which index paths these patterns actually leave out, including case-folded aliases.
    tracked = git(["ls-files", "-z"], repo.toplevel).stdout
    with tempfile.NamedTemporaryFile() as rulefile:
        rulefile.write(rules)
        rulefile.flush()
        included = git(["sparse-checkout", "check-rules", "--no-cone", "--rules-file", rulefile.name, "-z"],
                       repo.toplevel, input_bytes=tracked).stdout
    if set(tracked.split(b"\0")) - set(included.split(b"\0")) != {os.fsencode(p) for p in bulk_paths}:
        raise StorageError("Git's sparse patterns would omit a different set of tracked paths")
    lines = [f"run-storage: {len(bulk)} tracked bulk file(s), {human(total)}, left out of this checkout "
             f"({repo.toplevel})"]
    if args.dry_run:
        lines += [f"  would exclude {human(r['size']):>12}  {r['path']}" for r in bulk[: args.limit]]
        emit({"dry_run": True, "excluded": bulk}, args.json, lines)
        return EXIT_OK
    git(["sparse-checkout", "set", "--no-cone", "--stdin"], repo.toplevel,
        input_bytes=rules)
    still_present = [r["path"] for r in bulk if (repo.toplevel / r["path"]).exists()]
    if still_present:
        print(f"run-storage: {len(still_present)} file(s) are still checked out; check the patterns with "
              "`git sparse-checkout list`", file=sys.stderr)
        return EXIT_FINDINGS
    lines.append(f"  restore the full checkout with: git -C {shlex.quote(str(repo.toplevel))} sparse-checkout disable")
    emit({"excluded": bulk, "restore_command": f"git -C {repo.toplevel} sparse-checkout disable"}, args.json, lines)
    return EXIT_OK


def cmd_worktree_check(args) -> int:
    repo = Repo(args.project_root or (args.worktree if args.worktree else "."))
    base = args.base or default_base(repo)
    store = repo.store(args.store)
    trees = list_worktrees(repo)
    main_root = Path(trees[0]["worktree"]).resolve() if trees and "bare" not in trees[0] else None
    if args.all and args.worktree:
        raise StorageError("name one worktree path or pass --all, not both")
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


# ------------------------------------------------------------------ report

ALREADY_COMPRESSED_SUFFIXES = frozenset({
    ".gz", ".tgz", ".zst", ".xz", ".bz2", ".zip", ".7z", ".lz4",
    ".png", ".jpg", ".jpeg", ".gif", ".webp", ".pdf", ".mp4", ".mov", ".npz",
})


def on_disk(st: os.stat_result) -> int:
    """Bytes a file occupies: its allocated blocks (a one-byte file holds a
    whole block, a sparse file only the blocks written; a copy-on-write clone
    still counts in full, so totals stay upper bounds). Its length, where the
    platform reports no block count."""
    blocks = getattr(st, "st_blocks", None)
    return st.st_size if blocks is None else blocks * 512


def dir_size(path: Path, unreadable: "list[str]") -> "tuple[int, int, float, bool, int]":
    """Bytes and files under `path`; the newest modification time of any file
    or directory in it (removing a file changes only its directory's time);
    whether every directory and file could be read; and the bytes held in
    files with more than one hard link (a local clone's objects, a pnpm
    store's packages), which removing this tree may not free at all."""
    total, count, newest, linked = 0, 0, 0.0, 0
    complete = True

    def failed(error: OSError) -> None:
        nonlocal complete
        complete = False
        unreadable.append(str(error.filename))

    for dirpath, dirnames, filenames in os.walk(path, followlinks=False, onerror=failed):
        for entry in [dirpath, *(os.path.join(dirpath, name) for name in dirnames + filenames)]:
            try:
                st = os.lstat(entry)
            except OSError:
                complete = False
                unreadable.append(entry)
                continue
            newest = max(newest, st.st_mtime)
            if entry == dirpath or not stat.S_ISREG(st.st_mode) and not stat.S_ISLNK(st.st_mode):
                continue
            total += on_disk(st)
            count += 1
            if st.st_nlink > 1:
                linked += on_disk(st)
    return total, count, newest, complete, linked


def is_git_store(path: Path) -> bool:
    return (path / "objects").is_dir() and (path / "refs").is_dir() and (path / "HEAD").is_file()


def missing_objects(reference: Path, shas: "list[str]") -> "set[str]":
    """The objects among `shas` the reference does not hold locally (an object
    a partial clone only promises counts as missing: nothing is fetched). When
    git cannot answer, every one counts as missing."""
    if not shas:
        return set()
    proc = git(["cat-file", "--batch-check=%(objectname) %(objecttype)"], reference, check=False,
               input_bytes=("\n".join(shas) + "\n").encode())
    if proc.returncode != 0:
        return set(shas)
    out = proc.stdout.decode().splitlines()
    return {line.split()[0] for line in out if line.endswith(" missing")}


class DurableObjects:
    """Objects reachable from the refs of a reference repository (computed
    once per report). Objects that merely exist there, or that only a reflog
    keeps, can be removed by its garbage collection and never count."""

    def __init__(self, reference: Path):
        self.reference = reference
        self._ids: "set[str] | None" = None
        # A partial clone only promises some objects; a traversal inside it skips them silently.
        promisor = git(["config", "--get-regexp", r"^(extensions\.partialclone|remote\..*\.promisor)$"], reference,
                       check=False).stdout.decode().split("\n")
        self.partial = any(line.split(" ", 1)[-1].strip().lower() not in ("", "false") for line in promisor if line)

    def ids(self) -> "set[str]":
        if self._ids is None:
            out = git(["rev-list", "--objects", "--all", "--missing=allow-promisor"], self.reference).stdout.decode()
            self._ids = {line.split()[0] for line in out.splitlines() if line.strip()}
        return self._ids

    def covers_closure_of(self, revs: "list[str]") -> "bool | None":
        """True when every object reachable from ``revs`` (computed inside
        the reference) is durably reachable there; None when the reference is
        a partial clone, where that traversal skips objects it only promises."""
        if self.partial:
            return None
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
    the reference repository; None when the store cannot be assessed. Objects a
    partial clone never held are not fetched (and are not the copy's to lose)."""
    linked, modules = git_dir / "worktrees", git_dir / "modules"
    try:
        if linked.is_dir() and any(linked.iterdir()):
            return None  # linked worktrees keep their own indexes, refs and logs: not assessed
        if modules.is_dir() and any(modules.iterdir()):
            return None  # submodules keep their own object stores, refs and logs: not assessed
        # Pseudo-refs (FETCH_HEAD, ORIG_HEAD, MERGE_HEAD, ...) and in-progress operations can be
        # the only reference to objects; rev-list --all does not follow them.
        if any((entry.name.endswith("_HEAD") or entry.name in ("AUTO_MERGE", "sequencer", "rebase-merge",
                                                                  "rebase-apply", "BISECT_LOG"))
               for entry in git_dir.iterdir()):
            return None
    except OSError:
        return None
    objects = git(["--git-dir", str(git_dir), "rev-list", "--objects", "--all", "--reflog", "--indexed-objects",
                   "--missing=allow-promisor"], durable.reference, check=False)
    refs = git(["--git-dir", str(git_dir), "for-each-ref", "--format=%(objectname)"], durable.reference, check=False)
    if objects.returncode != 0 or refs.returncode != 0 or objects.stderr.strip() or refs.stderr.strip():
        return None
    reachable = {line.split()[0] for line in objects.stdout.decode().splitlines() if line.strip()}
    reachable |= set(refs.stdout.decode().split())
    if not reachable:
        return False
    # Reachable is not enough when the reference is a partial clone: its bytes must be held there.
    # (In a complete repository every reachable object is held; that traversal fails otherwise.)
    return reachable <= durable.ids() and (not durable.partial or not missing_objects(durable.reference,
                                                                                    sorted(reachable)))


FileIdentity = "tuple[int, int, int, int, int]"  # device, inode, size, mtime and ctime in ns


def file_identity(st: os.stat_result) -> "tuple[int, int, int, int, int]":
    return (st.st_dev, st.st_ino, st.st_size, st.st_mtime_ns, st.st_ctime_ns)


def link_count_if_unchanged(path: Path, identity: "tuple[int, int, int, int, int]") -> "int | None | str":
    """Hard links of the file that was scanned under `identity`. "unreadable" when the
    path cannot be examined (vanished or unreadable); "changed" when it no longer
    names that file (another device or inode, size, modification or change time:
    replaced or rewritten since it was scanned and hashed; the change time cannot be
    set back by a writer)."""
    try:
        st = path.lstat()
    except OSError:
        return "unreadable"
    if file_identity(st) != identity:
        return "changed"
    return st.st_nlink


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
    unreadable: "list[str]" = []
    changed_since_scan: "list[str]" = []
    reference = Path(args.repo).expanduser().resolve() if args.repo else None
    durable = DurableObjects(reference) if reference is not None else None
    regenerable, git_stores, bundles = [], [], []
    files: "dict[int, list[tuple[Path, int, int]]]" = {}
    seen_inodes: set = set()
    for root in roots:
        for dirpath, dirnames, filenames in os.walk(root, followlinks=False,
                                                    onerror=lambda e: unreadable.append(str(e.filename))):
            here = Path(dirpath)
            for name in list(dirnames):
                full = here / name
                try:
                    dst = full.lstat()
                except OSError:
                    unreadable.append(str(full))  # listed, as every skipped path is
                    continue
                if (dst.st_dev, dst.st_ino) in seen_dirs:
                    dirnames.remove(name)
                    continue
                seen_dirs.add((dst.st_dev, dst.st_ino))
                if name in REGENERABLE_DIR_NAMES:
                    size, count, _, _, linked = dir_size(full, unreadable)
                    regenerable.append({"path": str(full), "bytes": size, "files": count,
                                        "reclaimable_bytes": size - linked})
                    dirnames.remove(name)
                elif (name == ".git" or name.endswith(".git")) and is_git_store(full):
                    size, count, _, _, _ = dir_size(full, unreadable)
                    # Containment is checked for the objects reachable from the copy's refs, HEAD,
                    # reflogs and index; its objects directory may also hold unreachable objects
                    # (not compared, lost with the copy), and the rest of the git directory
                    # (config, hooks, index, logs, info) is not compared at all.
                    objects, _, _, _, linked = dir_size(full / "objects", unreadable)
                    record = {"path": str(full), "bytes": size, "object_bytes": objects,
                              "other_bytes": size - objects, "reclaimable_bytes": objects - linked,
                              "kind": "git object store"}
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
                    unreadable.append(str(full))  # listed, as every skipped path is
                    continue
                if not stat.S_ISREG(st.st_mode):
                    continue
                if name.endswith(".bundle"):
                    record = {"path": str(full), "bytes": on_disk(st),
                              "reclaimable_bytes": on_disk(st) if st.st_nlink == 1 else 0}
                    if reference is not None:
                        heads = git(["bundle", "list-heads", str(full)], reference, check=False)
                        shas = [line.split()[0] for line in heads.stdout.decode().splitlines() if line.strip()]
                        record["contained_in_reference"] = durable.covers_closure_of(shas) if heads.returncode == 0 \
                            else False
                    bundles.append(record)
                if st.st_size >= args.min_size and (st.st_dev, st.st_ino) not in seen_inodes:
                    seen_inodes.add((st.st_dev, st.st_ino))
                    files.setdefault(st.st_size, []).append((full, file_identity(st), on_disk(st)))
    duplicates = []
    unique_large: "list[tuple[Path, int]]" = []
    for size, group in files.items():
        if len(group) < 2:
            unique_large.append((group[0][0], size))
            continue
        by_prefix: "dict[str, list[Path]]" = {}
        identity = {path: ident for path, ident, _ in group}
        occupied = {path: disk for path, _, disk in group}
        for path, _, _ in group:
            try:
                by_prefix.setdefault(hash_prefix(path), []).append(path)
            except OSError:
                unreadable.append(str(path))
        for paths in by_prefix.values():
            by_full: "dict[str, list[Path]]" = {}
            if len(paths) < 2:
                unique_large.append((paths[0], size))
                continue
            for path in paths:
                try:
                    by_full.setdefault(sha256_file(path), []).append(path)
                except OSError:
                    unreadable.append(str(path))
            for sha, same in by_full.items():
                if len(same) == 1:
                    unique_large.append((same[0], size))
                    continue
                # A copy that can no longer be examined as the file that was scanned (vanished,
                # unreadable, replaced or rewritten since) may already be gone or hold other content.
                # Such a group is then not a known set of duplicates any more: it is not reported as
                # one, its examinable members do not stand in for it, and the skipped paths are listed.
                counts = [link_count_if_unchanged(p, identity[p]) for p in same]
                unreadable += [str(p) for p, n in zip(same, counts) if n == "unreadable"]  # listed, as every skipped path is
                changed_since_scan += [str(p) for p, n in zip(same, counts) if n == "changed"]
                if any(isinstance(n, str) for n in counts):
                    continue
                unique_large.append((same[0], size))
                # Removing a copy that has other hard links frees nothing, so only single-linked
                # copies may go; one copy stays, the one occupying the least when all are single-linked
                # (a multi-linked copy stays anyway). Freed bytes are what the removable copies occupy.
                removable = sorted((p for p, n in zip(same, counts) if n == 1), key=lambda p: occupied[p])
                if len(removable) == len(same):
                    removable = removable[1:]
                duplicates.append({"sha256": sha, "size": size, "copies": len(same),
                                   "occupied": [occupied[p] for p in same],
                                   "reclaimable": sum(occupied[p] for p in removable),
                                   "paths": [str(p) for p in same]})
    duplicates.sort(key=lambda d: -d["reclaimable"])
    unique_large.sort(key=lambda item: -item[1])
    candidates = [(p, s) for p, s in unique_large if p.suffix.lower() not in ALREADY_COMPRESSED_SUFFIXES]
    sampled = candidates[: args.compress_sample]
    compress_saving = 0.0
    sampled_ok = 0
    for path, size in sampled:
        try:
            compress_saving += size * max(0.0, 1.0 - sample_ratio(path))
        except OSError:
            unreadable.append(str(path))  # listed, as every skipped path is
            continue
        sampled_ok += 1
    stale = []
    cutoff = time.time() - args.older_than_days * 86400
    for d in args.stale_dir:
        base = Path(d).expanduser().resolve()
        if not base.is_dir():
            continue
        try:
            children = sorted(base.iterdir())
        except OSError:
            unreadable.append(str(base))
            continue
        for child in children:
            if args.stale_prefix and not any(child.name.startswith(p) for p in args.stale_prefix):
                continue
            try:
                st = child.lstat()
            except OSError:  # removed meanwhile, or unreadable: its age is unknown
                unreadable.append(str(child))
                continue
            if stat.S_ISLNK(st.st_mode):
                continue
            if stat.S_ISDIR(st.st_mode):
                size, count, newest, complete, linked = dir_size(child, unreadable)
            else:
                size, count, newest, complete = on_disk(st), 1, st.st_mtime, True
                linked = on_disk(st) if st.st_nlink > 1 else 0
            # Age is known only when every part of the root could be examined.
            if complete and newest < cutoff:
                stale.append({"path": str(child), "bytes": size, "files": count, "reclaimable_bytes": size - linked,
                              "age_days": round((time.time() - newest) / 86400, 1)})
    redundant_bundles = [b for b in bundles if b.get("contained_in_reference")]
    redundant_stores = [g for g in git_stores if g.get("contained_in_reference")]
    summary = {
        "duplicate_content": sum(d["reclaimable"] for d in duplicates),
        "regenerable_directories": sum(r["reclaimable_bytes"] for r in regenerable),
        "history_copies_contained_in_reference": sum(g["reclaimable_bytes"] for g in redundant_stores),
        "bundles_contained_in_reference": sum(b["reclaimable_bytes"] for b in redundant_bundles),
        "stale_temporary_roots": sum(s["reclaimable_bytes"] for s in stale),
        "compression_estimate": int(compress_saving),
    }
    result = {
        "roots": [str(r) for r in roots], "reference_repo": str(reference) if reference else None,
        "min_size": args.min_size, "summary_bytes": summary,
        "duplicates": duplicates, "regenerable": sorted(regenerable, key=lambda r: -r["bytes"]),
        "git_object_stores": git_stores, "bundles": bundles, "stale": stale,
        "compression": {"sampled_files": sampled_ok, "candidate_files": len(candidates)},
        "unreadable": sorted(set(unreadable)),
        "changed_since_scan": sorted(set(changed_since_scan)),
        "notes": [
            "Read-only: nothing was changed.",
            "Duplicate bytes are an upper bound: copy-on-write clones share blocks but look like separate files.",
            "In a duplicate group, `size` is the content length (what made the copies a group); `occupied` lists "
            "the bytes each copy holds on disk, in `paths` order; `reclaimable` sums the single-linked copies "
            "that may go, keeping the copy that occupies the least when every copy is single-linked.",
            "For a git copy, `reclaimable_bytes` counts its objects directory net of hard links; the containment "
            "check compared the objects reachable from its refs, HEAD, reflogs and index, while unreachable objects "
            "in that directory are counted but not compared (lost on removal). `other_bytes` (config, hooks, index, "
            "logs, refs, info) is not compared with the reference and not counted.",
            "Categories can overlap (a stale root may contain duplicates or regenerable directories).",
            "Stale temporary roots are judged by age alone (the newest file or directory time; a root with any "
            "unreadable part is not listed); check that nothing still uses them before removing.",
            "Reclaimable totals leave out files with more than one hard link (local clones, pnpm stores): removing "
            "one link may free nothing. Copy-on-write clones cannot be told apart, so totals stay upper bounds.",
            "Bytes held in files with more than one hard link are left out even when every link lies in what "
            "would be removed (a git copy whose objects are hard-linked among themselves, a duplicate linked only "
            "to another duplicate), so those figures can be underestimates.",
            "The compression figure extrapolates a zlib ratio measured on the first 4 MiB of each sampled file.",
            "Unreadable paths, and duplicate copies replaced or rewritten since they were scanned, are skipped and listed "
            "(`unreadable`, `changed_since_scan`); the figures do not include them.",
        ],
    }
    lines = ["run-storage report (read-only; nothing was changed)"]
    labels = {
        "duplicate_content": "identical content stored more than once",
        "regenerable_directories": "regenerable directories (dependency trees, caches)",
        "history_copies_contained_in_reference": "object storage of separate git stores whose reachable objects "
                                                 "are contained in --repo",
        "bundles_contained_in_reference": "git bundles already contained in --repo",
        "stale_temporary_roots": f"temporary roots unchanged for {args.older_than_days} days "
                                 "(age only: whether a process still uses them is not checked)",
        "compression_estimate": "rough saving from compressing the sampled large files (see --compress-sample)",
    }
    for key, label in labels.items():
        lines.append(f"  {human(summary[key]):>12}  {label}")
    lines.append("  Categories can overlap; duplicate bytes are an upper bound (see --json notes).")
    if unreadable:
        lines.append(f"  {len(set(unreadable))} unreadable path(s) were skipped and are not counted (see --json)")
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


# ------------------------------------------------------------------- main

def store_for_path(path: Path, override: str | None) -> Path:
    directory = path if path.is_dir() else path.parent
    if git(["rev-parse", "--show-toplevel"], directory, check=False).returncode == 0:
        return Repo(directory).store(override)
    if not override:
        raise StorageError(f"{path} is outside a working tree; pass --store")
    store = Path(override).expanduser().resolve()
    existing = store
    while not existing.exists():
        existing = existing.parent
    if not existing.is_dir() or git(["rev-parse", "--git-dir"], existing, check=False).returncode == 0:
        raise StorageError("an external content store must be outside a Git repository")
    return store


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
    store = store_for_path(root, args.store) if args.store else None
    if store is not None and is_under(store, root):
        raise StorageError("the inventory store must be outside the tree being hashed")
    if args.compare and (store is None or not is_sha256_hex(args.compare)):
        raise StorageError("--compare requires --store and a lowercase SHA-256 digest")
    inventory = tree_inventory(root)
    digest = tree_digest(inventory)
    result = {"root": str(root), "digest": digest, "entries": len(inventory),
              "bytes": sum(v.get("size", 0) for v in inventory.values())}
    lines = [f"{digest}  {root}  ({len(inventory)} entries)"]
    if args.compare:
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
    if store is not None:
        sha, dest = store_put_bytes(canonical_json(inventory), store)
        assert sha == digest
        result["inventory_entry"] = str(dest)
    emit(result, args.json, lines)
    return EXIT_FINDINGS if (args.compare and args.compare != digest) else EXIT_OK


def cmd_closeout(args) -> int:
    import run_storage
    import storage_closeout
    return storage_closeout.cmd_closeout(args, run_storage)


def non_negative_int(text: str) -> int:
    value = int(text)
    if value < 0:
        raise argparse.ArgumentTypeError("must be 0 or more")
    return value


def non_negative_float(text: str) -> float:
    value = float(text)
    if not value >= 0 or value == float("inf"):  # also refuses nan
        raise argparse.ArgumentTypeError("must be a finite number, 0 or more")
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
    p.add_argument("--quiet", action="store_true",
                   help="print nothing when nothing needs attention (no bulk file at risk and no notice)")
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

    p = sub.add_parser("worktree-check", help="read-only: can linked worktrees be removed without losing anything?")
    common(p)
    p.add_argument("worktree", nargs="?", default=None)
    p.add_argument("--all", action="store_true", help="check every linked worktree of the repository")
    p.add_argument("--base", default=None, help="branch a removable worktree must be merged into (default main/master)")
    p.add_argument("--store", default=None, help=STORE_HELP)
    p.set_defaults(func=cmd_worktree_check)

    p = sub.add_parser("report", help="read-only estimate of reclaimable bytes under any trees")
    common(p, project=False)
    p.add_argument("roots", nargs="+")
    p.add_argument("--repo", default=None, help="reference repository for bundle / history-copy containment")
    p.add_argument("--min-size", type=non_negative_int, default=CHUNK,
                   help="smallest file considered (bytes, default 1 MiB)")
    p.add_argument("--stale-dir", action="append", default=[], help="temporary location whose old children are listed")
    p.add_argument("--stale-prefix", action="append", default=[], help="only children with this name prefix")
    p.add_argument("--older-than-days", type=non_negative_float, default=7.0)
    p.add_argument("--compress-sample", type=non_negative_int, default=500,
                   help="largest files sampled for the compression estimate")
    p.set_defaults(func=cmd_report)

    p = sub.add_parser("materialize", help="recreate missing manifest entries from the store")
    common(p, limit=False)
    p.add_argument("run_dir")
    p.add_argument("--store", default=None, help=STORE_HELP)
    p.add_argument("--dry-run", action="store_true")
    p.set_defaults(func=cmd_materialize)

    p = sub.add_parser("inventory", help="read-only file counts, duplicate index objects and retention review")
    common(p)
    p.set_defaults(func=cmd_inventory)

    p = sub.add_parser("install-hook", help="install a pre-commit hook running `check --staged`")
    common(p, json_flag=False, limit=False)
    p.add_argument("--strict", action="store_true", help="the hook refuses commits that add bulk files")
    p.add_argument("--dry-run", action="store_true")
    p.set_defaults(func=cmd_install_hook)

    p = sub.add_parser("sparse-exclude-bulk", help="leave tracked bulk files out of a linked worktree's checkout")
    common(p, project=False)
    p.add_argument("--worktree", default=None, help="worktree path (default: cwd)")
    p.add_argument("--threshold", type=int, default=None)
    p.add_argument("--dry-run", action="store_true")
    p.set_defaults(func=cmd_sparse_exclude_bulk)

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

    p = sub.add_parser("closeout", help="after a verdict: hash manifest, prune regenerable paths, compress")
    common(p, project=False, limit=False)
    p.add_argument("dir")
    p.add_argument("--verdict", required=True, help="recorded verdict file (required)")
    p.add_argument("--prune", action="append", default=[], help="relative path to remove (repeatable)")
    p.add_argument("--prune-caches", action="store_true", help="also remove dependency trees and caches found inside")
    p.add_argument("--compress-min-size", type=non_negative_int, default=CHUNK)
    p.add_argument("--no-compress", action="store_true")
    p.add_argument("--apply", action="store_true", help="execute (default: print the plan only)")
    p.set_defaults(func=cmd_closeout)
    return parser


SUBCOMMANDS = ("check", "stow", "verify", "materialize", "inventory", "worktree-check", "report",
               "install-hook", "sparse-exclude-bulk", "store-put", "tree-digest", "closeout")


def main(argv: "list[str] | None" = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    if getattr(args, "project_root", None) is None and args.command in ("check", "inventory", "install-hook"):
        args.project_root = "."
    try:
        return args.func(args)
    except (StorageError, OSError, subprocess.SubprocessError) as exc:
        return stop_on_error(args, str(exc))
    except (ValueError, RuntimeError, UnicodeError) as exc:  # unusual input: an error, never "findings"
        return stop_on_error(args, f"cannot process this input ({type(exc).__name__}: {exc})")


def stop_on_error(args, message: str) -> int:
    """An error that stops a command: on stderr and, with --json, as an object."""
    print(f"run-storage: {message}".encode("utf-8", "backslashreplace").decode("utf-8"), file=sys.stderr)
    if getattr(args, "json", False):
        emit({"error": message}, True, [])
    return EXIT_ERROR


if __name__ == "__main__":
    sys.modules["run_storage"] = sys.modules[__name__]
    sys.exit(main())
