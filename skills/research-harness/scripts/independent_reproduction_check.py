#!/usr/bin/env python3
"""Independent reproduction check (opt-in): fresh-checkout rerun + comparison.

Reruns a project's declared reproduction entry command in a FRESH, ISOLATED
checkout and machine-compares the values it produces against the declared
expected values. A result that only reproduces inside the working directory
that produced it — uncommitted edits, leftover artifacts, stale caches — is
not reproducible yet; this check is the clean-state rerun.

Input: a project-declared reproduction manifest (JSON). Schema and field
semantics are documented in this skill's SKILL.md under "Independent
Reproduction Check (Opt-in)".

Isolation modes:
  worktree  fresh ``git worktree add --detach`` checkout of committed HEAD.
            Whatever is not committed does not exist for the rerun, by
            design: not committed means not reproducible. The manifest
            itself must be committed and unmodified — its bytes are checked
            against the fresh checkout, because the claim under test must
            be part of the committed state.
  copy      fallback for non-git projects: copy the manifest's declared
            working_inputs whitelist into a fresh directory. Strictly
            weaker than worktree mode: it copies filesystem state as-is,
            uncommitted edits included; symlinked inputs are refused.
  auto      worktree when the project root is inside a git repository,
            copy otherwise. A git repository whose worktree preparation
            fails (including "no commits yet") is environment_failed, not
            silently degraded to copy.

Vacuous-pass guard: before the entry command runs, any declared
artifact_path already present in the fresh checkout is deleted, so a
committed stale output can never satisfy the comparison without the entry
regenerating it. Declared artifact paths must not be symlinks and must
resolve inside the isolated run root, both before and after the run.

Symlink discipline: committed symlinks that resolve OUTSIDE the fresh
checkout are refused (environment_failed) — they could read state that is
not part of the committed tree; checkout-internal relative links are fine.
On macOS path comparisons are case-folded, matching its default
case-insensitive filesystem.

The original working tree is never modified: the entry command runs only in
the isolated directory, and every file this check creates lives under its
own work directory, which is required to lie outside the project (the
default temp directory is refused too when TMPDIR points inside it).
Worktree mode records only removable git bookkeeping metadata under the
repository's git dir (the report carries the exact removal command).
Environment entries that reference the original project tree — textually,
through a symlink alias, or through a relative traversal from the run root
(PYTHONPATH, PATH components, TMPDIR, a venv, and similar) — are dropped
from the entry's environment and recorded in the report, so the rerun
cannot import or execute uncommitted state through the environment.

What this check verifies — and what it does not.
It catches ACCIDENTAL contamination: a result that inadvertently depends
on uncommitted edits, stale or pre-existing artifacts, or original-tree
code leaking in through the environment. It does NOT verify that the
entry command computes the right thing: the manifest's entry command and
extraction rules are trusted input, so an entry that reads absolute
paths into the original tree, or that emits numbers without computing
them, is not caught here. Correctness of the computation itself rests
with the numerical-reliability-gate checks (convergence, orthogonal
cross-checks, invariants) and with human review of the entry command
recorded in every report; container-level sandboxing is explicitly out
of scope by design.
Honest limitations, restated in every report: isolation is checkout-level,
not container-level — beyond the targeted scrub the entry command inherits
the invoking environment and is not sandboxed against absolute-path
writes. POSIX (macOS/Linux) only: the entry runs under ``/bin/sh -c`` in
its own process group. Value extraction runs after (outside) the entry
timeout and trusts the manifest author's regex and artifact sizes, exactly
as it trusts the entry command itself.

Fail-closed verdict, one of:
  environment_failed  manifest missing/invalid, or the isolated directory
                      could not be prepared;
  incomplete          the entry command exited non-zero or timed out, or at
                      least one expected value could not be extracted;
  mismatch            entry exited zero, every expected value extracted,
                      and at least one value lies outside its declared
                      tolerance;
  reproduced          entry exited zero within its time budget and every
                      expected value lies within its explicit tolerance.
Precedence: environment_failed > incomplete > mismatch > reproduced.
Exit code is 0 ONLY for reproduced (3 mismatch, 4 incomplete,
5 environment_failed, 2 usage error).

Tolerance honesty: every expected value carries an EXPLICIT tolerance
(absolute or relative); there is no default and no order-of-magnitude pass.
The report records the signed deviation and the deviation-to-tolerance
ratio for every comparison.

Output: report.json + report.md written atomically (temp file + rename)
into the work directory; the full JSON report is also printed on stdout.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import platform
import re
import shutil
import signal
import subprocess
import sys
import tempfile
import time
from datetime import datetime, timezone
from pathlib import Path

VERDICTS = ("reproduced", "mismatch", "incomplete", "environment_failed")
EXIT_CODES = {"reproduced": 0, "mismatch": 3, "incomplete": 4, "environment_failed": 5}
ITEM_STATUSES = ("within_tolerance", "out_of_tolerance", "not_extracted")
LIMITATION_NOTE = (
    "Isolation is checkout-level, not container-level: beyond the recorded environment "
    "scrub, the entry command inherits the invoking process environment and is not "
    "sandboxed against absolute-path writes. The check catches accidental contamination "
    "by uncommitted or original-tree state; it does not verify that the entry command "
    "computes the right thing — the entry command and extraction rules (recorded in "
    "this report) are trusted input, and correctness of the computation itself rests "
    "with convergence/cross-method checks and human review."
)


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _is_number(x) -> bool:
    if not isinstance(x, (int, float)) or isinstance(x, bool):
        return False
    try:
        return math.isfinite(float(x))  # float() may overflow on huge ints
    except (OverflowError, ValueError):
        return False


def _is_safe_rel_path(s) -> bool:
    """A non-empty relative path, strictly below its base directory (so a bare
    '.' cannot smuggle the entire tree through a whitelist)."""
    if not isinstance(s, str) or not s.strip():
        return False
    parts = Path(s).parts
    return bool(parts) and not Path(s).is_absolute() and ".." not in parts and "." not in parts


def _try_resolve(path: Path) -> "Path | None":
    """Path.resolve() that returns None instead of raising: symlink loops
    raise OSError on some Python versions and RuntimeError on others
    (<= 3.12 pathlib), and every caller here must fail closed, not crash."""
    try:
        return path.resolve()
    except (OSError, RuntimeError):
        return None


def _resolved_under(base: Path, rel: str) -> "Path | None":
    """base/rel with symlinks resolved, or None when it escapes base or is
    not resolvable (fail-closed)."""
    candidate = _try_resolve(base / rel)
    resolved_base = _try_resolve(base)
    if candidate is None or resolved_base is None:
        return None
    try:
        candidate.relative_to(resolved_base)
    except ValueError:
        return None
    return candidate


def write_text_atomic(path: Path, text: str) -> None:
    """Write via a temp file in the same directory + rename, so a reader never
    sees a partial file and a crash never leaves a truncated report."""
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(prefix=path.name + ".", suffix=".tmp", dir=str(path.parent))
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            fh.write(text)
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


# --- manifest ---

def validate_manifest(doc) -> list[str]:
    """Return a list of validation errors (empty = valid). Fail-closed: every
    ambiguity is an error, never a silently applied default."""
    if not isinstance(doc, dict):
        return ["manifest root must be a JSON object"]
    errors: list[str] = []
    if doc.get("manifest_version") != 1:
        errors.append("manifest_version must be present and equal to 1 (explicit, never defaulted)")
    if not isinstance(doc.get("entry_command"), str) or not doc["entry_command"].strip():
        errors.append("entry_command must be a non-empty string")
    if not _is_number(doc.get("timeout_seconds")) or doc["timeout_seconds"] <= 0:
        errors.append("timeout_seconds must be a positive number")
    if not isinstance(doc.get("environment_note"), str) or not doc["environment_note"].strip():
        errors.append("environment_note must be a non-empty string stating interpreter/library/data assumptions")
    working_inputs = doc.get("working_inputs", [])
    if not isinstance(working_inputs, list) or not all(_is_safe_rel_path(x) for x in working_inputs):
        errors.append("working_inputs must be a list of relative paths that never leave the project root")
    expected = doc.get("expected")
    if not isinstance(expected, list) or not expected:
        errors.append("expected must be a non-empty list")
        return errors
    seen_ids: set[str] = set()
    for i, item in enumerate(expected):
        where = f"expected[{i}]"
        if not isinstance(item, dict):
            errors.append(f"{where} must be an object")
            continue
        item_id = item.get("id")
        if not isinstance(item_id, str) or not item_id.strip():
            errors.append(f"{where}.id must be a non-empty string")
        elif item_id in seen_ids:
            errors.append(f"{where}.id duplicates '{item_id}'")
        else:
            seen_ids.add(item_id)
        value = item.get("value")
        if not _is_number(value):
            errors.append(f"{where}.value must be a finite number")
        tol = item.get("tolerance")
        tol_ok = (isinstance(tol, dict) and tol.get("kind") in ("absolute", "relative")
                  and _is_number(tol.get("value")) and tol["value"] > 0)
        if not tol_ok:
            errors.append(f"{where}.tolerance must be explicit: "
                          '{"kind": "absolute"|"relative", "value": > 0} — no default tolerance')
        elif tol["kind"] == "relative" and _is_number(value) and value == 0:
            errors.append(f"{where}: a relative tolerance is undefined for a declared value of 0; "
                          "declare an absolute tolerance")
        has_artifact = "artifact_path" in item or "json_path" in item
        has_stdout = "stdout_pattern" in item
        if has_artifact == has_stdout:
            errors.append(f"{where} must declare exactly one extraction mechanism: "
                          "artifact_path + json_path, or stdout_pattern")
        if has_artifact:
            if not _is_safe_rel_path(item.get("artifact_path")):
                errors.append(f"{where}.artifact_path must be a relative path that never leaves the run root")
            if not isinstance(item.get("json_path"), str) or not item["json_path"].strip():
                errors.append(f"{where}.json_path must be a non-empty dotted path")
        if has_stdout:
            pattern = item.get("stdout_pattern")
            compiled = None
            if isinstance(pattern, str):
                try:
                    compiled = re.compile(pattern)
                except re.error:
                    compiled = None
            if compiled is None or compiled.groups != 1:
                errors.append(f"{where}.stdout_pattern must be a valid regex with exactly one capture group")
        if "unit_note" in item and not isinstance(item["unit_note"], str):
            errors.append(f"{where}.unit_note must be a string when present")
    return errors


# --- isolation ---

def _git(args: list[str], cwd: Path) -> subprocess.CompletedProcess:
    try:
        return subprocess.run(["git", *args], cwd=str(cwd), capture_output=True, text=True, check=False)
    except FileNotFoundError:
        return subprocess.CompletedProcess(["git", *args], 127, "", "git executable not found")


def _inside(child: Path, parent: Path) -> bool:
    """Used only by refusal guards: an unresolvable path (symlink loop) is
    treated as inside, i.e. refused — fail-closed."""
    resolved_child, resolved_parent = _try_resolve(child), _try_resolve(parent)
    if resolved_child is None or resolved_parent is None:
        return True
    try:
        resolved_child.relative_to(resolved_parent)
        return True
    except ValueError:
        return False


def manifest_git_state(manifest_path: Path) -> str:
    """Whether the manifest itself is committed and clean — recorded in the
    report. Worktree mode additionally ENFORCES a committed, unmodified
    manifest (enforce_committed_manifest); copy mode records the state only,
    since a non-git project has no commit to enforce against."""
    tracked = _git(["ls-files", "--error-unmatch", "--", str(manifest_path)], manifest_path.parent)
    if tracked.returncode != 0:
        return "untracked_or_not_in_git"
    status = _git(["status", "--porcelain", "--", str(manifest_path)], manifest_path.parent)
    return "tracked_clean" if status.stdout.strip() == "" else "tracked_modified"


def prepare_worktree(project_root: Path, checkout_dir: Path) -> "tuple[dict | None, list[str]]":
    top = _git(["rev-parse", "--show-toplevel"], project_root)
    if top.returncode != 0:
        return None, [f"project root is not inside a git repository: {top.stderr.strip()}"]
    toplevel = Path(top.stdout.strip())
    head = _git(["rev-parse", "HEAD"], toplevel)
    if head.returncode != 0:
        return None, ["repository has no resolvable HEAD (no commits yet); "
                      "commit the project before checking reproduction"]
    commit = head.stdout.strip()
    added = _git(["worktree", "add", "--detach", str(checkout_dir), "HEAD"], toplevel)
    if added.returncode != 0:
        return None, [f"git worktree add failed: {added.stderr.strip()}"]
    resolved_project = _try_resolve(project_root)
    resolved_toplevel = _try_resolve(toplevel)
    if resolved_project is None or resolved_toplevel is None:
        return None, ["project root or repository toplevel is not resolvable (symlink loop?); "
                      f"the checkout is kept at {checkout_dir} for inspection — remove with: "
                      f"git -C {toplevel} worktree remove --force {checkout_dir}"]
    run_root = _try_resolve(checkout_dir / os.path.relpath(str(resolved_project), str(resolved_toplevel)))
    if run_root is None or not run_root.is_dir():
        return None, ["project root does not exist in the fresh checkout (or its path is not "
                      "resolvable there — a committed symlink loop?) — is it committed? "
                      f"(the checkout is kept at {checkout_dir} for "
                      f"inspection — remove with: git -C {toplevel} worktree remove --force {checkout_dir})"]
    escaping = _escaping_symlinks(checkout_dir)
    if escaping:
        shown = ", ".join(str(p.relative_to(checkout_dir)) for p in escaping[:5])
        return None, ["committed symlinks resolve outside the fresh checkout — the rerun could read "
                      f"state that is not part of the committed tree ({shown}); replace them with "
                      "checkout-internal links or real files (the checkout is kept at "
                      f"{checkout_dir} for inspection — remove with: "
                      f"git -C {toplevel} worktree remove --force {checkout_dir})"]
    dirty = _git(["status", "--porcelain"], toplevel).stdout.strip()
    return {
        "mode": "worktree",
        "toplevel": str(toplevel),
        "commit": commit,
        "checkout": str(checkout_dir),
        "run_root": str(run_root),
        "original_tree_dirty": bool(dirty),
        "cleanup_command": f"git -C {toplevel} worktree remove --force {checkout_dir}",
    }, []


def _find_symlinks(root: Path) -> "list[Path]":
    """Every symlink at or below root (root itself included), without
    following links while walking."""
    if root.is_symlink():
        return [root]
    found: list[Path] = []
    if root.is_dir():
        for dirpath, dirnames, filenames in os.walk(root):
            for name in dirnames + filenames:
                p = Path(dirpath) / name
                if p.is_symlink():
                    found.append(p)
    return found


def _escaping_symlinks(root: Path) -> "list[Path]":
    """Symlinks below root that resolve OUTSIDE root. A checkout-internal
    relative link is a legitimate, reproducible committed object; a link that
    escapes the checkout can read state that is not part of the committed
    tree, so the caller must refuse it."""
    base = _try_resolve(root)
    escaping: list[Path] = []
    for link in _find_symlinks(root):
        target = _try_resolve(link)  # None on loops (OSError or RuntimeError)
        if target is None or base is None:
            escaping.append(link)  # not resolvable: treat as escaping, fail closed
            continue
        try:
            target.relative_to(base)
        except ValueError:
            escaping.append(link)
    return escaping


def prepare_copy(project_root: Path, checkout_dir: Path,
                 working_inputs: list) -> "tuple[dict | None, list[str]]":
    if not working_inputs:
        return None, ["copy isolation requires a non-empty working_inputs whitelist in the manifest"]
    # refuse symlinked inputs outright: a link could smuggle content from
    # outside the whitelist (or outside the project) into the isolated copy.
    # This includes symlinked ANCESTORS along the entry's own path (e.g.
    # linked_dir/file where linked_dir points elsewhere), not only links at
    # or below the entry.
    for rel in working_inputs:
        src = project_root / rel
        walker = project_root
        for part in Path(rel).parts:
            walker = walker / part
            if walker.is_symlink():
                return None, [f"working_inputs entry '{rel}' passes through a symlink "
                              f"({walker.relative_to(project_root)}); materialize it or use "
                              "worktree isolation"]
        symlinks = _find_symlinks(src)
        if symlinks:
            shown = ", ".join(str(p.relative_to(project_root)) for p in symlinks[:5])
            return None, [f"working_inputs entry '{rel}' contains symlinks ({shown}); "
                          "materialize them or use worktree isolation"]
        if not src.is_dir() and not src.is_file():
            return None, [f"working_inputs entry not found (or not a regular file/directory) "
                          f"in project root: {rel}"]
    checkout_dir.mkdir(parents=True, exist_ok=True)
    for rel in working_inputs:
        src = project_root / rel
        dst = checkout_dir / rel
        if src.is_dir():
            shutil.copytree(src, dst, dirs_exist_ok=True)
        else:
            dst.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(src, dst)
    return {
        "mode": "copy",
        "checkout": str(checkout_dir),
        "run_root": str(checkout_dir),
        "carries_uncommitted_state": True,
        "cleanup_command": f"rm -rf {checkout_dir}",
    }, []


def prepare_isolation(mode: str, project_root: Path, checkout_dir: Path,
                      working_inputs: list) -> "tuple[dict | None, list[str]]":
    if mode == "worktree":
        return prepare_worktree(project_root, checkout_dir)
    if mode == "copy":
        return prepare_copy(project_root, checkout_dir, working_inputs)
    # auto: worktree when inside a git repository, else copy; a git repository
    # whose worktree preparation fails is an error, never a silent downgrade
    if _git(["rev-parse", "--show-toplevel"], project_root).returncode == 0:
        return prepare_worktree(project_root, checkout_dir)
    return prepare_copy(project_root, checkout_dir, working_inputs)


def enforce_committed_manifest(manifest_path: Path, manifest_bytes: bytes,
                               checkout_dir: Path) -> "list[str]":
    """Worktree mode only: the manifest (the claim under test) must itself be
    committed and unmodified — compare its bytes against the fresh checkout.
    An uncommitted manifest could silently change the entry command, the
    expected values, or the tolerances that gate the verdict."""
    resolved = _try_resolve(manifest_path)
    if resolved is None:  # unreachable after a successful read; fail closed anyway
        return [f"manifest path is not resolvable: {manifest_path}"]
    tracked = _git(["ls-files", "--full-name", "--error-unmatch", "--", str(resolved)],
                   resolved.parent)
    if tracked.returncode != 0:
        return ["worktree mode requires the manifest to be tracked in git: the reproduction "
                "claim itself must be part of the committed state (commit the manifest, or use "
                "--isolation copy for non-git projects)"]
    rel_path = tracked.stdout.strip()
    committed = checkout_dir / rel_path
    if not committed.is_file():
        return [f"manifest not found in the fresh checkout at '{rel_path}'; commit it (a manifest "
                "tracked in a different repository than the project cannot be enforced)"]
    if committed.read_bytes() != manifest_bytes:
        return ["manifest differs from its committed version; commit the manifest edits — the "
                "entry command, expected values, and tolerances must come from committed state"]
    return []


def remove_preexisting_artifacts(expected: list, run_root: Path) -> "tuple[list[str], list[str]]":
    """Delete declared artifact paths that already exist in the isolated
    checkout, so a committed stale output can never satisfy the comparison
    without the entry regenerating it. Returns (removed, errors)."""
    removed: list[str] = []
    errors: list[str] = []
    for item in expected:
        rel = item.get("artifact_path")
        if not rel:
            continue
        raw = run_root / rel
        if raw.is_symlink():
            errors.append(f"expected '{item['id']}': artifact_path is a symlink in the fresh "
                          f"checkout ({rel}); declare the real file path")
            continue
        target = _resolved_under(run_root, rel)
        if target is None:
            errors.append(f"expected '{item['id']}': artifact_path resolves outside the isolated "
                          f"run root: {rel}")
            continue
        if target.is_dir():
            errors.append(f"expected '{item['id']}': artifact_path is a directory: {rel}")
        elif target.exists():
            try:
                target.unlink()
                removed.append(rel)
            except OSError as exc:
                errors.append(f"expected '{item['id']}': cannot remove pre-existing artifact "
                              f"{rel}: {exc}")
    return removed, errors


# --- entry execution ---

# macOS's default filesystem is case-insensitive: compare case-folded there,
# so a case-variant spelling of the project root cannot slip past the scrub.
_CASEFOLD_PATHS = sys.platform == "darwin"


def _references_path(value: str, marker: str) -> bool:
    """True when `value` contains `marker` as a whole path component prefix
    (so '/x/proj' matches '/x/proj' and '/x/proj/lib', never '/x/proj2')."""
    if _CASEFOLD_PATHS:
        value, marker = value.casefold(), marker.casefold()
    idx = value.find(marker)
    while idx != -1:
        end = idx + len(marker)
        if end == len(value) or value[end] in (os.sep, os.pathsep):
            return True
        idx = value.find(marker, idx + 1)
    return False


def _component_references(component: str, markers: "list[str]",
                          relative_base: "Path | None" = None) -> bool:
    """A single env-value component references a forbidden root when it does
    so textually, OR — for absolute paths — after resolving symlinks (so an
    alias like /tmp/link-to-project cannot slip past the scrub), OR — for
    relative components, resolved against `relative_base` (the isolated run
    root, i.e. the child's cwd) — when the traversal lands in a forbidden
    root (e.g. a ../../<project> that escapes a sibling work dir). An
    innocent relative component resolves inside the run root and never
    matches, so it is kept."""
    if any(_references_path(component, m) for m in markers):
        return True
    if os.path.isabs(component):
        resolved = _try_resolve(Path(component))
        if resolved is None:
            return True  # unresolvable absolute path: fail closed, drop it
        return any(_references_path(str(resolved), m) for m in markers)
    if relative_base is not None and component:
        resolved = _try_resolve(relative_base / component)
        if resolved is not None:
            return any(_references_path(str(resolved), m) for m in markers)
    return False


def sanitize_child_env(environ: dict, forbidden_roots: "list[Path]",
                       relative_base: "Path | None" = None) -> "tuple[dict, dict]":
    """Drop environment entries that reference the original project tree —
    textually, through a symlink alias, or through a relative traversal from
    the run root — so the rerun cannot import or execute uncommitted state
    through PYTHONPATH, PATH, TMPDIR, a venv, or similar. Multi-component
    values (os.pathsep-joined) keep their clean components; a value that is
    entirely a reference is removed. Returns (child_env, dropped) with
    `dropped` mapping each touched variable to the removed components —
    recorded in the report. Everything else is inherited: checkout-level,
    not container-level, isolation."""
    markers = []
    for root in forbidden_roots:
        resolved = _try_resolve(root)
        markers.append(str(resolved if resolved is not None else root))
    child_env: dict = {}
    dropped: dict = {}
    for key, value in environ.items():
        parts = value.split(os.pathsep)
        if not any(_component_references(p, markers, relative_base) for p in parts):
            child_env[key] = value
            continue
        kept = [p for p in parts if not _component_references(p, markers, relative_base)]
        removed = [p for p in parts if _component_references(p, markers, relative_base)]
        dropped[key] = removed
        if kept:
            child_env[key] = os.pathsep.join(kept)
    return child_env, dropped


def run_entry(entry_command: str, run_root: Path, timeout_seconds: float,
              stdout_path: Path, stderr_path: Path, env: "dict | None" = None) -> dict:
    started = time.time()
    with stdout_path.open("wb") as out, stderr_path.open("wb") as err:
        proc = subprocess.Popen(["/bin/sh", "-c", entry_command], cwd=str(run_root),
                                stdout=out, stderr=err, start_new_session=True, env=env)
        try:
            exit_code = proc.wait(timeout=timeout_seconds)
            timed_out = False
        except subprocess.TimeoutExpired:
            timed_out = True
            exit_code = None
            try:
                os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
            except (ProcessLookupError, PermissionError):
                try:
                    proc.kill()  # the process can be reaped in this window
                except OSError:
                    pass
            proc.wait()
    return {
        "command": entry_command,
        "exit_code": exit_code,
        "timed_out": timed_out,
        "duration_seconds": round(time.time() - started, 3),
        "stdout_log": str(stdout_path),
        "stderr_log": str(stderr_path),
    }


# --- extraction + comparison ---

def walk_json_path(doc, json_path: str) -> "tuple[object, str | None]":
    """Descend a dotted path; an all-ASCII-digit segment indexes a list."""
    cur = doc
    for seg in json_path.split("."):
        if isinstance(cur, list):
            # isascii() guard: str.isdigit() also accepts Unicode digits that
            # int() rejects, which would crash instead of failing cleanly
            if not (seg.isascii() and seg.isdigit()):
                return None, f"segment '{seg}' is not a list index"
            idx = int(seg)
            if idx >= len(cur):
                return None, f"list index {idx} out of range (length {len(cur)})"
            cur = cur[idx]
        elif isinstance(cur, dict):
            if seg not in cur:
                return None, f"key '{seg}' absent"
            cur = cur[seg]
        else:
            return None, f"cannot descend into a non-container at '{seg}'"
    return cur, None


def extract_value(item: dict, run_root: Path, stdout_text: str) -> "tuple[float | None, str | None]":
    """Return (value, error_note); value None means not extracted."""
    if "stdout_pattern" in item:
        matches = list(re.finditer(item["stdout_pattern"], stdout_text))
        if not matches:
            return None, "stdout_pattern matched nothing in the entry stdout"
        raw = matches[-1].group(1)  # deterministic rule: the last occurrence wins
        if raw is None:  # an optional capture group that did not participate
            return None, "capture group did not participate in the last match"
        try:
            value = float(raw)
        except (TypeError, ValueError):
            return None, f"captured text is not a number: {raw!r}"
        if not math.isfinite(value):
            return None, f"captured value is not finite: {raw!r}"
        return value, None
    if (run_root / item["artifact_path"]).is_symlink():
        return None, f"artifact_path is a symlink: {item['artifact_path']}; declare the real file path"
    artifact = _resolved_under(run_root, item["artifact_path"])
    if artifact is None:
        return None, f"artifact_path resolves outside the isolated run root: {item['artifact_path']}"
    if not artifact.is_file():
        return None, f"artifact not produced: {item['artifact_path']}"
    try:
        doc = json.loads(artifact.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        return None, f"artifact unreadable as JSON: {exc}"
    value, err = walk_json_path(doc, item["json_path"])
    if err is not None:
        return None, f"json_path '{item['json_path']}': {err}"
    if not _is_number(value):
        return None, f"json_path value is not a finite number: {value!r}"
    return float(value), None


def compare_value(declared: float, computed: float, tol_kind: str, tol_value: float) -> dict:
    """Explicit-tolerance comparison. deviation_over_tolerance <= 1 passes;
    the ratio itself is reported so the margin is always visible."""
    deviation = computed - declared
    denominator = tol_value if tol_kind == "absolute" else tol_value * abs(declared)
    # a zero denominator (relative tolerance on declared 0, rejected upstream
    # by validation) must fail closed, never raise or divide to a surprise
    ratio = abs(deviation) / denominator if denominator > 0 else math.inf
    return {"deviation": deviation, "deviation_over_tolerance": ratio, "within": ratio <= 1.0}


def decide_verdict(environment_failed: bool, entry_ok: bool, item_statuses: list) -> str:
    """Pure verdict logic (unit-testable). Default-deny: anything not fully
    verified lands on the failing side."""
    if environment_failed:
        return "environment_failed"
    if not entry_ok:
        return "incomplete"
    if not item_statuses or any(s == "not_extracted" for s in item_statuses):
        return "incomplete"
    if any(s == "out_of_tolerance" for s in item_statuses):
        return "mismatch"
    if all(s == "within_tolerance" for s in item_statuses):
        return "reproduced"
    return "incomplete"


# --- reporting ---

def render_markdown(report: dict) -> str:
    lines = [
        "# Independent reproduction check",
        "",
        f"- Verdict: **{report['verdict']}** (exit code {report['exit_code']})",
        f"- Manifest: {report['manifest']['path']} (sha256 {report['manifest'].get('sha256', 'n/a')}, "
        f"git state: {report['manifest'].get('git_state', 'unknown')})",
        f"- Isolation: {report['isolation'].get('mode', 'not_prepared')} at "
        f"{report['isolation'].get('checkout', 'n/a')}",
        f"- Entry: `{report['entry'].get('command', 'n/a')}` -> exit "
        f"{report['entry'].get('exit_code')}, timed_out={report['entry'].get('timed_out')}, "
        f"{report['entry'].get('duration_seconds')}s",
        f"- Limitation: {LIMITATION_NOTE}",
        "",
    ]
    if report.get("errors"):
        lines.append("## Errors")
        lines.append("")
        lines.extend(f"- {e}" for e in report["errors"])
        lines.append("")
    if report.get("expected"):
        lines.append("| id | declared | computed | tolerance | deviation | deviation/tolerance | status |")
        lines.append("|---|---|---|---|---|---|---|")
        for item in report["expected"]:
            tol = item["tolerance"]
            lines.append(
                f"| {item['id']} | {item['declared_value']} | {item.get('computed_value', 'n/a')} "
                f"| {tol['kind']} {tol['value']} | {item.get('deviation', 'n/a')} "
                f"| {item.get('deviation_over_tolerance', 'n/a')} | {item['status']} |")
        lines.append("")
    return "\n".join(lines) + "\n"


def emit_report(report: dict, work_dir: "Path | None") -> None:
    if work_dir is not None:
        report["report_json"] = str(work_dir / "report.json")
        report["report_md"] = str(work_dir / "report.md")
        write_text_atomic(work_dir / "report.json",
                          json.dumps(report, indent=2, ensure_ascii=False) + "\n")
        write_text_atomic(work_dir / "report.md", render_markdown(report))
    print(json.dumps(report, indent=2, ensure_ascii=False))


# --- main ---

def main(argv: "list[str] | None" = None) -> int:
    parser = argparse.ArgumentParser(
        description="Rerun a project's declared reproduction entry in a fresh, isolated checkout "
                    "and compare declared expected values by explicit tolerance (fail-closed; "
                    "POSIX/macOS/Linux only).")
    parser.add_argument("--manifest", type=Path, required=True,
                        help="reproduction manifest (JSON); see SKILL.md for the schema.")
    parser.add_argument("--project-root", type=Path, default=None,
                        help="project root the manifest belongs to (default: git toplevel of the "
                             "manifest's directory; required for non-git projects).")
    parser.add_argument("--isolation", choices=("auto", "worktree", "copy"), default="auto",
                        help="worktree = fresh checkout of committed HEAD (default when in git); "
                             "copy = copy the working_inputs whitelist into a fresh directory.")
    parser.add_argument("--work-dir", type=Path, default=None,
                        help="where the checkout, logs, and reports live (default: a fresh temp "
                             "directory; must lie outside the project).")
    parser.add_argument("--timeout-seconds", type=float, default=None,
                        help="override the manifest's timeout_seconds (> 0).")
    parser.add_argument("--cleanup", action="store_true",
                        help="remove the isolated checkout after the comparison (reports and logs "
                             "are kept).")
    args = parser.parse_args(argv)

    report: dict = {
        "report_version": 1,
        "component": "independent_reproduction_check",
        "started_utc": _utc_now(),
        "manifest": {"path": str(args.manifest)},
        "isolation": {},
        "entry": {},
        "expected": [],
        "errors": [],
        "runner": {"python": platform.python_version(), "platform": platform.platform()},
        "limitations": LIMITATION_NOTE,
    }

    def finish(verdict: str, work_dir: "Path | None") -> int:
        report["verdict"] = verdict
        report["exit_code"] = EXIT_CODES[verdict]
        report["finished_utc"] = _utc_now()
        emit_report(report, work_dir)
        return report["exit_code"]

    if args.timeout_seconds is not None and not (math.isfinite(args.timeout_seconds)
                                                 and args.timeout_seconds > 0):
        report["errors"].append("--timeout-seconds must be a finite number > 0")
        return finish("environment_failed", None)

    # -- manifest bytes (existence) --
    try:
        raw = args.manifest.read_bytes()
    except OSError as exc:
        report["errors"].append(f"cannot read manifest: {exc}")
        return finish("environment_failed", None)
    report["manifest"]["sha256"] = hashlib.sha256(raw).hexdigest()
    resolved_manifest = _try_resolve(args.manifest)
    if resolved_manifest is None:  # unreachable after a successful read; fail closed anyway
        report["errors"].append(f"manifest path is not resolvable: {args.manifest}")
        return finish("environment_failed", None)
    manifest_dir = resolved_manifest.parent

    # -- project root --
    if args.project_root is not None:
        project_root = _try_resolve(args.project_root)
        if project_root is None:
            report["errors"].append(f"--project-root is not resolvable: {args.project_root}")
            return finish("environment_failed", None)
        if not project_root.is_dir():
            report["errors"].append(f"--project-root is not a directory: {project_root}")
            return finish("environment_failed", None)
    else:
        top = _git(["rev-parse", "--show-toplevel"], manifest_dir)
        if top.returncode != 0:
            report["errors"].append("manifest is not inside a git repository; pass --project-root")
            return finish("environment_failed", None)
        project_root = Path(top.stdout.strip())
    report["project_root"] = str(project_root)

    # -- work dir: guard BEFORE creating anything, so a refused location is
    #    never even scaffolded inside the project --
    enclosing = _git(["rev-parse", "--show-toplevel"], project_root)
    guard_roots = [project_root]
    if enclosing.returncode == 0:
        guard_roots.append(Path(enclosing.stdout.strip()))
    if args.work_dir is not None:
        work_dir = _try_resolve(args.work_dir)
        if work_dir is None:
            report["errors"].append(f"--work-dir is not resolvable: {args.work_dir}")
            return finish("environment_failed", None)
        if any(_inside(work_dir, g) for g in guard_roots):
            report["errors"].append("work dir must lie outside the project (and its git repository) "
                                    "so the original tree stays untouched")
            return finish("environment_failed", None)
        work_dir.mkdir(parents=True, exist_ok=True)
    else:
        # the default temp dir honors TMPDIR, which could point inside the
        # project — guard it exactly like an explicit --work-dir
        if any(_inside(Path(tempfile.gettempdir()), g) for g in guard_roots):
            report["errors"].append("the default temp directory lies inside the project (TMPDIR?); "
                                    "set TMPDIR or --work-dir to a location outside the project")
            return finish("environment_failed", None)
        work_dir = Path(tempfile.mkdtemp(prefix="independent_reproduction_check_"))
    report["work_dir"] = str(work_dir)

    # -- manifest parse + validation (report files land in the work dir) --
    try:
        manifest = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, ValueError) as exc:
        report["errors"].append(f"manifest is not valid JSON: {exc}")
        return finish("environment_failed", work_dir)
    errors = validate_manifest(manifest)
    if errors:
        report["errors"].extend(errors)
        return finish("environment_failed", work_dir)
    report["manifest"]["git_state"] = manifest_git_state(resolved_manifest)
    report["manifest"]["environment_note"] = manifest["environment_note"]
    timeout_seconds = float(args.timeout_seconds if args.timeout_seconds is not None
                            else manifest["timeout_seconds"])
    report["manifest"]["timeout_seconds"] = timeout_seconds

    checkout_dir = work_dir / "checkout"
    if checkout_dir.exists():
        report["errors"].append(f"checkout dir already exists (refusing to reuse): {checkout_dir}")
        return finish("environment_failed", work_dir)

    # -- isolation --
    isolation, iso_errors = prepare_isolation(args.isolation, project_root, checkout_dir,
                                              manifest.get("working_inputs", []))
    if isolation is None:
        report["errors"].extend(iso_errors)
        return finish("environment_failed", work_dir)
    report["isolation"] = isolation
    run_root = Path(isolation["run_root"])

    # -- the claim under test must itself be committed (worktree mode) --
    if isolation["mode"] == "worktree":
        manifest_errors = enforce_committed_manifest(resolved_manifest, raw, checkout_dir)
        if manifest_errors:
            report["errors"].extend(manifest_errors)
            isolation["kept"] = checkout_dir.exists()
            return finish("environment_failed", work_dir)

    # -- vacuous-pass guard: a pre-existing artifact must never satisfy the
    #    comparison without the entry regenerating it --
    removed, removal_errors = remove_preexisting_artifacts(manifest["expected"], run_root)
    isolation["preexisting_artifacts_removed"] = removed
    if removal_errors:
        report["errors"].extend(removal_errors)
        isolation["kept"] = checkout_dir.exists()
        return finish("environment_failed", work_dir)

    # -- entry --
    # the rerun must not import/execute uncommitted state through the
    # environment: drop entries referencing the original tree (recorded)
    child_env, env_dropped = sanitize_child_env(dict(os.environ), guard_roots,
                                                relative_base=run_root)
    try:
        report["entry"] = run_entry(manifest["entry_command"], run_root, timeout_seconds,
                                    work_dir / "entry_stdout.log", work_dir / "entry_stderr.log",
                                    env=child_env)
    except OSError as exc:  # e.g. /bin/sh missing or log files unopenable
        report["errors"].append(f"entry could not be launched: {exc}")
        isolation["kept"] = checkout_dir.exists()
        return finish("environment_failed", work_dir)
    report["entry"]["environment_entries_dropped"] = env_dropped
    entry_ok = report["entry"]["exit_code"] == 0 and not report["entry"]["timed_out"]
    try:
        stdout_text = (work_dir / "entry_stdout.log").read_text(encoding="utf-8", errors="replace")
    except OSError:
        stdout_text = ""

    # -- extraction + comparison (attempted even when the entry failed, for
    #    diagnosis; the verdict stays incomplete on entry failure regardless) --
    statuses: list = []
    for item in manifest["expected"]:
        record = {
            "id": item["id"],
            "declared_value": item["value"],
            "tolerance": item["tolerance"],
            "mechanism": "stdout_regex" if "stdout_pattern" in item else "json_artifact",
        }
        if "unit_note" in item:
            record["unit_note"] = item["unit_note"]
        try:
            computed, err = extract_value(item, run_root, stdout_text)
        except Exception as exc:  # the report contract must survive any extraction defect
            computed, err = None, f"internal extraction error: {exc!r}"
        if computed is None:
            record["status"] = "not_extracted"
            record["extraction_error"] = err
        else:
            record["computed_value"] = computed
            cmp_result = compare_value(float(item["value"]), computed,
                                       item["tolerance"]["kind"], float(item["tolerance"]["value"]))
            record["deviation"] = cmp_result["deviation"]
            record["deviation_over_tolerance"] = cmp_result["deviation_over_tolerance"]
            record["status"] = "within_tolerance" if cmp_result["within"] else "out_of_tolerance"
        statuses.append(record["status"])
        report["expected"].append(record)

    verdict = decide_verdict(False, entry_ok, statuses)

    # -- optional cleanup: remove the checkout, keep reports and logs --
    if args.cleanup:
        if isolation["mode"] == "worktree":
            removal = _git(["worktree", "remove", "--force", str(checkout_dir)],
                           Path(isolation["toplevel"]))
            isolation["cleanup_done"] = removal.returncode == 0
            if removal.returncode != 0:
                isolation["cleanup_error"] = removal.stderr.strip()
        else:
            shutil.rmtree(checkout_dir, ignore_errors=True)
            isolation["cleanup_done"] = not checkout_dir.exists()
    # ground truth, not intent: "kept" reflects whether the checkout still exists
    isolation["kept"] = checkout_dir.exists()

    return finish(verdict, work_dir)


if __name__ == "__main__":
    raise SystemExit(main())
