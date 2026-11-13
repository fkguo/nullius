#!/usr/bin/env python3
"""Report handwritten file sizes as review context, without a line-count limit.

Select paths with --files, newline/NUL-delimited stdin, or --base-ref. The latter
includes branch, staged, unstaged and untracked changes from the merge base.
Exit 0 means the report was produced, not that the code is correct. Selection or
read failures exit 2. Effective line counts are a comment/blank-line heuristic.
"""

from __future__ import annotations

import argparse
from contextlib import contextmanager
import json
import os
import re
import stat
import subprocess
import sys
from pathlib import Path

_COMMENT_LINE = re.compile(r"^\s*(#|//|/\*|\*)")
_CODE_SUFFIXES = frozenset({".py", ".sh", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".mts"})
_REPO_ROOT = Path(__file__).resolve().parents[2]
_GENERATED_ROOTS = (
    _REPO_ROOT / "packages" / "shared" / "src" / "generated",
    _REPO_ROOT / "meta" / "generated" / "python",
)


def count_text(text: str) -> int:
    return sum(bool(line.strip()) and not _COMMENT_LINE.match(line)
               for line in text.splitlines())


@contextmanager
def open_regular_file(path: Path):
    if not stat.S_ISREG(path.lstat().st_mode):
        raise ValueError("expected a regular file, not a directory, symlink or special file")
    flags = os.O_RDONLY | getattr(os, "O_NONBLOCK", 0) | getattr(os, "O_NOFOLLOW", 0)
    descriptor = os.open(path, flags)
    with os.fdopen(descriptor, "rb") as source:
        if not stat.S_ISREG(os.fstat(source.fileno()).st_mode):
            raise ValueError("selected file changed into a non-regular file")
        yield source


def effective_loc(path: Path) -> int:
    with open_regular_file(path) as source:
        return count_text(source.read().decode("utf-8"))


def is_declared_generated(path: Path) -> bool:
    resolved = path.resolve()
    return any(root in resolved.parents for root in _GENERATED_ROOTS)


def git(root: Path | None, *arguments: str, reject_stderr: bool = False) -> bytes:
    process = subprocess.run(["git", *arguments], cwd=root, capture_output=True, check=False)
    if process.returncode or (reject_stderr and process.stderr):
        raise ValueError(process.stderr.decode("utf-8", errors="replace").strip()
                         or f"git exited {process.returncode}")
    return process.stdout


def changed_files(base_ref: str) -> tuple[Path, str, list[str], dict[bytes, str]]:
    root = Path(git(None, "rev-parse", "--show-toplevel").decode("utf-8").removesuffix("\n"))
    reference = git(root, "rev-parse", "--verify", "--end-of-options", f"{base_ref}^{{commit}}").decode().strip()
    base = git(root, "merge-base", reference, "HEAD").decode().strip()
    paths = git(root, "diff", "--name-only", "--no-renames", "--diff-filter=d", "-z", base, "--")
    paths += git(root, "diff", "--cached", "--name-only", "--no-renames", "--diff-filter=d", "-z", base, "--")
    # Git can exit 0 after a directory traversal warning and omit its files.
    paths += git(root, "ls-files", "--others", "--exclude-standard", "-z", reject_stderr=True)
    deleted = set(git(root, "diff", "--name-only", "--no-renames", "--diff-filter=D", "-z", "--").split(b"\0"))
    selected = list(dict.fromkeys(value.decode("utf-8") for value in paths.split(b"\0")
                                 if value and value not in deleted))
    originals = {}
    for entry in git(root, "ls-tree", "-r", "-z", "--full-tree", base).split(b"\0"):
        if entry:
            metadata, name = entry.split(b"\t", 1)
            mode, kind, oid = metadata.split()
            if mode in (b"100644", b"100755") and kind == b"blob":
                originals[name] = oid.decode("ascii")
    return root, base, selected, originals


def stdin_paths(nul_delimited: bool) -> list[str]:
    text = sys.stdin.buffer.read().decode("utf-8")
    if not text:
        return []
    separator = "\0" if nul_delimited else "\n"
    paths = text.split(separator)
    if paths[-1] == "":
        paths.pop()
    if any(not path for path in paths):
        raise ValueError("input contains an empty path")
    return list(dict.fromkeys(paths))


def report(args: argparse.Namespace) -> dict:
    result = {"status": "reported", "scope": "maintainability_context", "base_ref": args.base_ref,
              "base_commit": None, "files": [], "excluded": [], "errors": []}
    root, originals = None, {}
    try:
        if args.base_ref is not None:
            root, result["base_commit"], paths, originals = changed_files(args.base_ref)
        else:
            paths = args.files if args.files is not None else stdin_paths(args.null)
    except (OSError, ValueError) as error:
        result["errors"].append({"path": None, "message": str(error)})
        paths = []
    for value in dict.fromkeys(paths):
        try:
            if not value or "\0" in value:
                raise ValueError("expected a nonempty file path without NUL")
            path = root / value if root else Path(value)
            with open_regular_file(path) as source:
                excluded = "non_code" if path.suffix.casefold() not in _CODE_SUFFIXES else (
                    "generated" if is_declared_generated(path) else None)
                if excluded:
                    result["excluded"].append({"path": value, "reason": excluded})
                    continue
                current = count_text(source.read().decode("utf-8"))
            baseline = None
            if root:
                oid = originals.get(value.encode("utf-8"))
                baseline = count_text(git(root, "cat-file", "blob", oid).decode("utf-8")) if oid else 0
            result["files"].append({"path": value, "eloc": current, "base_eloc": baseline,
                                    "delta_eloc": current - baseline if baseline is not None else None})
        except (OSError, ValueError) as error:
            result["errors"].append({"path": value, "message": str(error)})
    result["status"] = "error" if result["errors"] else ("reported" if result["files"] else "no_files")
    return result


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    selection = parser.add_mutually_exclusive_group()
    selection.add_argument("--files", nargs="+", help="Explicit files; otherwise read stdin")
    selection.add_argument("--base-ref", help="Report all current changes from this ref's merge base")
    parser.add_argument("--null", action="store_true", help="Read NUL-delimited paths from stdin")
    parser.add_argument("--json", action="store_true", help="Emit the structured report")
    args = parser.parse_args()
    if args.base_ref == "":
        parser.error("--base-ref requires a nonempty ref")
    if args.null and (args.files is not None or args.base_ref is not None):
        parser.error("--null applies only to stdin selection")
    if args.files is None and args.base_ref is None and sys.stdin.isatty():
        parser.error("select files with --files, --base-ref or piped stdin")
    result = report(args)
    if args.json:
        print(json.dumps(result, ensure_ascii=True))
    else:
        print(f"CODE-01.1 INFO: {len(result['files'])} handwritten file(s), "
              f"{len(result['excluded'])} excluded; size is review context, not a quality verdict.")
        for entry in result["files"]:
            size = str(entry["eloc"])
            if entry["base_eloc"] is not None:
                size = f"{entry['base_eloc']} -> {entry['eloc']} ({entry['delta_eloc']:+d})"
            print(f"  {json.dumps(entry['path'])}: {size} eLOC")
        for error in result["errors"]:
            print(f"CODE-01.1 ERROR: {json.dumps(error)}", file=sys.stderr)
    return 2 if result["errors"] else 0


if __name__ == "__main__":
    sys.exit(main())
