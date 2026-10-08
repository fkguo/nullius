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
  ``git clean`` and ``git worktree remove``). The run directory keeps the
  same file as a hard link (same bytes, no extra space, readable in place),
  made read-only; a tracked ``bulk_manifest.json`` records path, size and
  sha256, and a managed block in the run directory's ``.gitignore`` lists
  exactly those paths. The code-origin snapshot of later runs therefore
  carries the hashes of the bulk inputs, while the bulk bytes stay out of
  history.

  Optional ``.nullius/storage_policy.json``:
    {"schema": "storage_policy_v1", "bulk_threshold_bytes": 5242880,
     "run_roots": ["artifacts/runs"], "store_root": "/abs/or/relative/path"}

Subcommands
  check             report bulk files under the run roots (``--staged``: in
                    the index, i.e. about to be committed). Warns; exits 1
                    only with ``--strict``.
  install-hook      install a pre-commit hook running ``check --staged``
                    (never overwrites a foreign hook).
  stow              move a finished run's bulk outputs into the store
                    (hard link in place + manifest + ignore block).
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
digest) and ``sparse-exclude-bulk`` (removes tracked, unmodified files from
a worktree's checkout; ``git sparse-checkout disable`` restores them).
"""
from __future__ import annotations

import argparse
import errno
import hashlib
import json
import lzma
import os
import shlex
import shutil
import stat
import subprocess
import sys
import tempfile
import time
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

def git(args: "list[str]", cwd: Path, check: bool = True, input_bytes: "bytes | None" = None) -> subprocess.CompletedProcess:
    env = dict(os.environ, GIT_OPTIONAL_LOCKS="0", LC_ALL="C")
    proc = subprocess.run(
        ["git", "-c", "core.quotepath=off", "-c", "core.fsmonitor=false", *args],
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
        self.policy = load_policy(self.toplevel)

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
            p = Path(configured).expanduser()
            return (p if p.is_absolute() else self.toplevel / p).resolve()
        return self.common_dir.joinpath(*STORE_SUBPATH)

    def rel(self, path: Path) -> str:
        return path.resolve().relative_to(self.toplevel).as_posix()

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
        if not isinstance(doc["store_root"], str) or not doc["store_root"]:
            raise StorageError(f"{POLICY_REL}: store_root must be a non-empty string")
        policy["store_root"] = doc["store_root"]
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


def store_put(path: Path, store: Path, prefer_link: bool = True) -> "tuple[str, Path, str]":
    """Place ``path``'s bytes into ``store`` under their sha256.

    With ``prefer_link`` the store entry is a hard link to ``path`` (same
    inode, no extra space) and both names become read-only; across file
    systems, or with ``prefer_link=False``, a verified copy is written.
    Returns (sha256, store entry, method) with method in
    {"existing", "link", "copy"}.
    """
    path = Path(path)
    st = path.lstat()
    if not stat.S_ISREG(st.st_mode):
        raise StorageError(f"not a regular file: {path}")
    if prefer_link:
        os.chmod(path, stat.S_IMODE(st.st_mode) & ~0o222)
    sha = sha256_file(path)
    dest = store_path(store, sha)
    dest.parent.mkdir(parents=True, exist_ok=True)
    if dest.exists():
        if dest.stat().st_size != st.st_size:
            raise StorageError(f"store entry {dest} has the wrong size; the store is damaged")
        return sha, dest, "existing"
    if prefer_link:
        try:
            os.link(path, dest)
            if sha256_file(dest) != sha:
                os.unlink(dest)
                raise StorageError(f"{path} changed while being stored; stow it after the run has finished")
            fsync_dir(dest.parent)
            return sha, dest, "link"
        except FileExistsError:
            return sha, dest, "existing"
        except OSError as exc:
            if exc.errno not in (errno.EXDEV, errno.EPERM, errno.EMLINK, errno.ENOTSUP):
                raise
    fd, tmp = tempfile.mkstemp(prefix=f".{sha}.", suffix=".tmp", dir=dest.parent)
    try:
        h = hashlib.sha256()
        with os.fdopen(fd, "wb") as out, open(path, "rb") as src:
            for block in iter(lambda: src.read(CHUNK), b""):
                h.update(block)
                out.write(block)
            out.flush()
            os.fsync(out.fileno())
        if h.hexdigest() != sha:
            raise StorageError(f"{path} changed while being stored; stow it after the run has finished")
        os.chmod(tmp, 0o444)
        os.replace(tmp, dest)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise
    fsync_dir(dest.parent)
    return sha, dest, "copy"


def store_put_bytes(data: bytes, store: Path) -> "tuple[str, Path]":
    sha = hashlib.sha256(data).hexdigest()
    dest = store_path(store, sha)
    if not dest.exists():
        write_atomic(dest, data, mode=0o444)
    return sha, dest


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


def manifests_under(repo: Repo) -> "dict[str, dict]":
    """Map repository-relative path -> manifest entry for every bulk manifest
    under the run roots."""
    found: dict = {}
    for root in repo.run_roots:
        base = repo.toplevel / root
        if not base.is_dir():
            continue
        for dirpath, dirnames, filenames in os.walk(base, followlinks=False):
            if MANIFEST_NAME in filenames:
                run_dir = Path(dirpath)
                doc = load_manifest(run_dir)
                for entry in doc["entries"]:
                    found[repo.rel(run_dir / entry["path"])] = entry
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


def update_ignore_block(run_dir: Path, rel_paths: "list[str]") -> None:
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
    roots = [r for r in repo.run_roots if (repo.toplevel / r).exists()]
    classes: "dict[str, list[dict]]" = {"tracked": [], "untracked": [], "ignored_stowed": [], "ignored_unstowed": []}
    if not roots:
        return classes
    tracked = repo.tracked(roots)
    untracked = repo.untracked(roots)
    stowed = manifests_under(repo)
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
                elif rel in stowed and stowed[rel]["size"] == st.st_size:
                    classes["ignored_stowed"].append(record)
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
        "ignored_stowed": "stowed (in the content store, hash recorded)",
    }
    lines = [f"run-storage: bulk files (>= {human(threshold)}) under {', '.join(repo.run_roots)}:"]
    for key in ("untracked", "ignored_unstowed", "tracked", "ignored_stowed"):
        records = classes[key]
        lines.append(f"  {len(records):5d} files {human(sum(r['size'] for r in records)):>12}  {labels[key]}")
        for r in records[: args.limit]:
            lines.append(f"        {human(r['size']):>12}  {r['path']}")
        if len(records) > args.limit:
            lines.append(f"        ... {len(records) - args.limit} more")
    emit(result, args.json, lines)
    violations = classes["untracked"] or classes["ignored_unstowed"]
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
    if not any(is_under(path, repo.toplevel / root) for root in repo.run_roots):
        raise StorageError(f"{path} is not under a run root ({', '.join(repo.run_roots)}); "
                           f"add its root to {POLICY_REL} if it should follow the bulk policy")
    return path


def cmd_stow(args) -> int:
    repo = Repo(args.project_root if args.project_root else args.run_dir)
    run_dir = resolve_run_dir(repo, args.run_dir)
    threshold = resolve_threshold(repo, args.threshold)
    store = repo.store(args.store)
    tracked = repo.tracked([repo.rel(run_dir)])
    manifest = load_manifest(run_dir) or {"schema": MANIFEST_SCHEMA, "entries": []}
    entries = {e["path"]: e for e in manifest["entries"]}
    candidates = []
    legacy = []
    for dirpath, dirnames, filenames in os.walk(run_dir, followlinks=False):
        for name in sorted(filenames):
            full = Path(dirpath) / name
            rel_run = full.relative_to(run_dir).as_posix()
            if rel_run in (MANIFEST_NAME, ".gitignore") or name == CLOSEOUT_MANIFEST_NAME:
                continue
            st = full.lstat()
            if not stat.S_ISREG(st.st_mode) or st.st_size < threshold:
                continue
            if repo.rel(full) in tracked:
                legacy.append({"path": rel_run, "size": st.st_size})
                continue
            candidates.append((rel_run, full, st))
    plan, conflicts = [], []
    for rel_run, full, st in candidates:
        known = entries.get(rel_run)
        if known:
            same_inode = False
            dest = store_path(store, known["sha256"])
            if dest.exists():
                dst = dest.stat()
                same_inode = (dst.st_ino, dst.st_dev) == (st.st_ino, st.st_dev)
            if same_inode or (known["size"] == st.st_size and sha256_file(full) == known["sha256"]):
                if dest.exists():
                    continue
            else:
                conflicts.append(rel_run)
                continue
        plan.append((rel_run, full, st))
    if conflicts:
        print("run-storage: these outputs differ from the hashes already recorded in "
              f"{MANIFEST_NAME}; a changed result belongs in a new run:", file=sys.stderr)
        for rel_run in conflicts:
            print(f"  {rel_run}", file=sys.stderr)
        return EXIT_FINDINGS
    total = sum(st.st_size for _, _, st in plan)
    lines = [f"run-storage: {len(plan)} bulk file(s), {human(total)}, from {repo.rel(run_dir)} into {store}"]
    if legacy:
        lines.append(f"  {len(legacy)} bulk file(s) are already tracked in git and stay as they are "
                     "(history is never rewritten here)")
    if args.dry_run:
        lines += [f"  would stow {human(st.st_size):>12}  {rel_run}" for rel_run, _, st in plan]
        emit({"dry_run": True, "planned": [{"path": r, "size": st.st_size} for r, _, st in plan],
              "already_tracked": legacy, "store": str(store)}, args.json, lines)
        return EXIT_OK
    stowed = []
    for rel_run, full, st in plan:
        sha, dest, method = store_put(full, store, prefer_link=True)
        if method == "existing":
            dst = dest.stat()
            if (dst.st_ino, dst.st_dev) != (full.stat().st_ino, full.stat().st_dev):
                # Identical bytes were stored before (another run produced the
                # same output): share that inode instead of keeping two copies.
                try:
                    tmp = full.with_name(f".{full.name}.stow-link")
                    os.link(dest, tmp)
                    os.replace(tmp, full)
                    method = "link-existing"
                except OSError:
                    method = "existing-copy-kept"
        entries[rel_run] = {"path": rel_run, "size": st.st_size, "sha256": sha, "stowed_utc": utc_now()}
        stowed.append({"path": rel_run, "size": st.st_size, "sha256": sha, "method": method})
        lines.append(f"  stowed {human(st.st_size):>12}  {rel_run}  ({method})")
    manifest["entries"] = sorted(entries.values(), key=lambda e: e["path"])
    manifest["threshold_bytes"] = threshold
    write_json_atomic(run_dir / MANIFEST_NAME, manifest)
    update_ignore_block(run_dir, [e["path"] for e in manifest["entries"]])
    not_ignored = []
    for entry in manifest["entries"]:
        target = run_dir / entry["path"]
        if git(["check-ignore", "-q", "--", os.path.relpath(target, repo.toplevel)], repo.toplevel,
               check=False).returncode != 0:
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

def entry_status(run_dir: Path, store: Path, entry: dict) -> dict:
    target = run_dir / entry["path"]
    status = {"path": entry["path"], "size": entry["size"], "sha256": entry["sha256"]}
    if target.exists():
        actual = sha256_file(target)
        status["status"] = "ok" if actual == entry["sha256"] else "mismatch"
        if actual != entry["sha256"]:
            status["actual_sha256"] = actual
        return status
    dest = store_path(store, entry["sha256"])
    if dest.exists():
        status["status"] = "in_store_only" if sha256_file(dest) == entry["sha256"] else "store_mismatch"
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
    bad = [s for s in statuses if s["status"] not in ("ok", "in_store_only")]
    lines = [f"run-storage verify {repo.rel(run_dir)}: {len(statuses)} entr(y/ies)"]
    for s in statuses:
        lines.append(f"  {s['status']:>14}  {s['path']}")
    if any(s["status"] == "in_store_only" for s in statuses):
        lines.append("  in_store_only entries are intact in the store; `materialize` makes them readable in place")
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
        target = run_dir / entry["path"]
        if target.exists() or target.is_symlink():
            continue
        dest = store_path(store, entry["sha256"])
        if not dest.exists() or sha256_file(dest) != entry["sha256"]:
            problems.append({"path": entry["path"], "status": "missing" if not dest.exists() else "store_mismatch"})
            continue
        if args.dry_run:
            done.append({"path": entry["path"], "method": "planned"})
            continue
        target.parent.mkdir(parents=True, exist_ok=True)
        try:
            os.link(dest, target)
            method = "link"
        except OSError:
            os.symlink(dest, target)
            method = "symlink"
        done.append({"path": entry["path"], "method": method})
    lines = [f"run-storage materialize {repo.rel(run_dir)}: {len(done)} restored, {len(problems)} unavailable"]
    lines += [f"  {d['method']:>8}  {d['path']}" for d in done]
    lines += [f"  {p['status']:>8}  {p['path']}" for p in problems]
    emit({"restored": done, "unavailable": problems, "store": str(store)}, args.json, lines)
    return EXIT_FINDINGS if problems else EXIT_OK


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
    head = git_text(["rev-parse", "HEAD"], path)
    branch = git(["symbolic-ref", "-q", "--short", "HEAD"], path, check=False).stdout.decode().strip() or None
    merged = git(["merge-base", "--is-ancestor", head, base], path, check=False).returncode == 0
    report.update(head=head, branch=branch, base=base, merged=merged)
    if not merged:
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
    report["tracked_changes"] = changed
    report["untracked"] = untracked
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
            if is_under(target, store):
                classes["in_store"].append(record)
                continue
            classes["unique"].append({**record, "symlink_target": os.readlink(full)})
            continue
        if not stat.S_ISREG(st.st_mode):
            classes["unique"].append(record)
            continue
        sha = sha256_file(full)
        if store_path(store, sha).exists():
            classes["in_store"].append(record)
            continue
        twin = main_root / rel if main_root else None
        if twin is not None and twin.is_file() and twin.stat().st_size == st.st_size and sha256_file(twin) == sha:
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
    reports = [check_one_worktree(t, base, main_root, store) for t in targets]
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


def tips_contained(repo_root: Path, shas: "list[str]") -> bool:
    if not shas:
        return False
    for sha in shas:
        if git(["cat-file", "-e", f"{sha}^{{commit}}"], repo_root, check=False).returncode != 0:
            return False
        out = git(["for-each-ref", "--contains", sha, "--count=1", "--format=%(refname)"], repo_root, check=False)
        if out.returncode != 0 or not out.stdout.strip():
            return False
    return True


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
    roots = [Path(r).expanduser().resolve() for r in args.roots]
    for r in roots:
        if not r.exists():
            raise StorageError(f"no such path: {r}")
    reference = Path(args.repo).expanduser().resolve() if args.repo else None
    regenerable, git_stores, bundles = [], [], []
    files: "dict[int, list[tuple[Path, int, int]]]" = {}
    seen_inodes: set = set()
    for root in roots:
        for dirpath, dirnames, filenames in os.walk(root, followlinks=False):
            here = Path(dirpath)
            for name in list(dirnames):
                full = here / name
                if name in REGENERABLE_DIR_NAMES:
                    size, count, _ = dir_size(full)
                    regenerable.append({"path": str(full), "bytes": size, "files": count})
                    dirnames.remove(name)
                elif (name == ".git" or name.endswith(".git")) and is_git_store(full):
                    size, count, _ = dir_size(full)
                    record = {"path": str(full), "bytes": size, "kind": "git object store"}
                    if reference is not None and full.resolve() != (reference / ".git").resolve() \
                            and full.resolve() != reference:
                        refs = git(["--git-dir", str(full), "for-each-ref", "--format=%(objectname) %(objecttype)"],
                                   root, check=False)
                        if refs.returncode == 0:
                            tips = [line.split()[0] for line in refs.stdout.decode().splitlines()
                                    if line.endswith(" commit")]
                            record["contained_in_reference"] = tips_contained(reference, tips)
                        else:
                            record["contained_in_reference"] = None
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
                        record["contained_in_reference"] = heads.returncode == 0 and tips_contained(reference, shas)
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
            "The compression figure extrapolates a zlib ratio measured on the first 4 MiB of each sampled file.",
        ],
    }
    lines = ["run-storage report (read-only; nothing was changed)"]
    labels = {
        "duplicate_content": "identical content stored more than once",
        "regenerable_directories": "regenerable directories (dependency trees, caches)",
        "history_copies_contained_in_reference": "separate git object stores already contained in --repo",
        "bundles_contained_in_reference": "git bundles already contained in --repo",
        "stale_temporary_roots": f"temporary roots older than {args.older_than_days} days",
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

def compress_file(path: Path, sha: str) -> dict:
    zstd = shutil.which("zstd")
    if zstd:
        out = path.with_name(path.name + ".zst")
        proc = subprocess.run([zstd, "-q", "-T0", "-10", "-o", str(out), str(path)], capture_output=True)
        if proc.returncode != 0:
            raise StorageError(f"zstd failed on {path}: {proc.stderr.decode(errors='replace').strip()}")
        h = hashlib.sha256()
        with subprocess.Popen([zstd, "-q", "-d", "-c", str(out)], stdout=subprocess.PIPE,
                              stderr=subprocess.DEVNULL) as proc:
            for block in iter(lambda: proc.stdout.read(CHUNK), b""):
                h.update(block)
        restored = h.hexdigest() if proc.returncode == 0 else None
        method = "zstd"
    else:
        out = path.with_name(path.name + ".xz")
        with open(path, "rb") as src, lzma.open(out, "wb", preset=6) as dst:
            shutil.copyfileobj(src, dst, CHUNK)
        h = hashlib.sha256()
        with lzma.open(out, "rb") as fh:
            for block in iter(lambda: fh.read(CHUNK), b""):
                h.update(block)
        restored = h.hexdigest()
        method = "xz"
    if restored != sha:
        out.unlink(missing_ok=True)
        raise StorageError(f"compressed copy of {path} does not decompress to the original bytes; kept the original")
    st = path.stat()
    os.utime(out, (st.st_atime, st.st_mtime))
    os.chmod(out, stat.S_IMODE(st.st_mode))
    path.unlink()
    return {"compressed_path": out.name, "method": method, "compressed_size": out.stat().st_size}


def cmd_closeout(args) -> int:
    root = Path(args.dir).expanduser().resolve()
    if not root.is_dir():
        raise StorageError(f"not a directory: {root}")
    verdict = Path(args.verdict).expanduser().resolve()
    if not verdict.is_file() or verdict.stat().st_size == 0:
        raise StorageError(f"verdict file missing or empty: {verdict}; closeout runs only after a verdict is recorded")
    manifest_path = root / CLOSEOUT_MANIFEST_NAME
    if manifest_path.exists():
        raise StorageError(f"{manifest_path} already exists; this tree was closed out before")
    prune: "list[str]" = []
    for rel in args.prune:
        rel = rel.strip("/")
        target = root / rel
        if not rel or ".." in rel.split("/") or not (target.exists() or target.is_symlink()):
            raise StorageError(f"--prune {rel!r}: must name an existing path inside {root}")
        if not target.is_symlink() and not is_under(target, root):
            raise StorageError(f"--prune {rel!r} resolves outside {root}")
        prune.append(rel)
    if args.prune_caches:
        for dirpath, dirnames, filenames in os.walk(root, followlinks=False):
            for name in list(dirnames):
                if name in REGENERABLE_DIR_NAMES:
                    rel = (Path(dirpath) / name).relative_to(root).as_posix()
                    if not any(rel == p or rel.startswith(p + "/") for p in prune):
                        prune.append(rel)
                    dirnames.remove(name)
    prune = sorted(set(prune))
    prune = [p for p in prune if not any(p != q and p.startswith(q + "/") for q in prune)]
    pruned_set = set(prune)

    def inside_pruned(rel: str) -> bool:
        return any(rel == p or rel.startswith(p + "/") for p in pruned_set)

    pruned_records = []
    for rel in prune:
        target = root / rel
        if target.is_symlink() or target.is_file():
            st = target.lstat()
            inv = {rel: {"type": "symlink", "target": os.readlink(target)}} if target.is_symlink() else \
                {rel: {"type": "file", "size": st.st_size, "sha256": sha256_file(target)}}
            pruned_records.append({"path": rel, "files": 1, "bytes": st.st_size, "tree_digest": tree_digest(inv)})
        else:
            inv = tree_inventory(target)
            size = sum(v.get("size", 0) for v in inv.values())
            files_n = sum(1 for v in inv.values() if v["type"] == "file")
            pruned_records.append({"path": rel, "files": files_n, "bytes": size, "tree_digest": tree_digest(inv)})
    kept_inventory = {}
    compress_plan = []
    for dirpath, dirnames, filenames in os.walk(root, followlinks=False):
        here = Path(dirpath)
        rel_dir = here.relative_to(root).as_posix()
        if rel_dir != "." and inside_pruned(rel_dir):
            dirnames[:] = []
            continue
        for name in sorted(filenames):
            full = here / name
            rel = full.relative_to(root).as_posix()
            if inside_pruned(rel) or rel == CLOSEOUT_MANIFEST_NAME:
                continue
            st = full.lstat()
            if stat.S_ISLNK(st.st_mode):
                kept_inventory[rel] = {"type": "symlink", "target": os.readlink(full)}
                continue
            if not stat.S_ISREG(st.st_mode):
                continue
            sha = sha256_file(full)
            kept_inventory[rel] = {"type": "file", "size": st.st_size, "sha256": sha, "mode": stat.S_IMODE(st.st_mode)}
            if (not args.no_compress and st.st_size >= args.compress_min_size
                    and full.suffix.lower() not in ALREADY_COMPRESSED_SUFFIXES
                    and st.st_nlink == 1 and full.resolve() != verdict):
                compress_plan.append((rel, sha, st.st_size))
    pruned_bytes = sum(r["bytes"] for r in pruned_records)
    lines = [f"run-storage closeout {root}",
             f"  verdict: {verdict}",
             f"  remove {len(pruned_records)} regenerable path(s), {human(pruned_bytes)}"]
    lines += [f"    {human(r['bytes']):>12}  {r['path']}" for r in pruned_records]
    lines.append(f"  compress {len(compress_plan)} file(s), {human(sum(s for _, _, s in compress_plan))} before compression")
    manifest = {
        "schema": CLOSEOUT_SCHEMA, "created_utc": utc_now(), "state": "planned",
        "verdict": {"path": str(verdict), "sha256": sha256_file(verdict)},
        "kept_files": kept_inventory, "pruned": pruned_records, "compressed": [],
    }
    if not args.apply:
        lines.append("  plan only; rerun with --apply to execute")
        emit({**manifest, "applied": False}, args.json, lines)
        return EXIT_OK
    write_json_atomic(manifest_path, manifest)
    for rec in pruned_records:
        target = root / rec["path"]
        if target.is_symlink() or target.is_file():
            target.unlink()
        else:
            shutil.rmtree(target)
    compressed = []
    for rel, sha, size in compress_plan:
        info = compress_file(root / rel, sha)
        compressed.append({"path": rel, "sha256": sha, "size": size, **info})
    manifest.update(state="applied", applied_utc=utc_now(), compressed=compressed)
    write_json_atomic(manifest_path, manifest)
    saved = sum(c["size"] - c["compressed_size"] for c in compressed)
    lines.append(f"  applied: removed {human(pruned_bytes)}, compression saved {human(saved)}; "
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
        sha, dest, method = store_put(path, store, prefer_link=not args.copy)
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
        if not other.exists():
            raise StorageError(f"no stored inventory for digest {args.compare}")
        diff = diff_inventories(json.loads(other.read_text(encoding="utf-8")), inventory)
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

    p = sub.add_parser("stow", help="move a finished run's bulk outputs into the content store")
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
    p.add_argument("--copy", action="store_true", help="store a copy instead of a read-only hard link")
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
