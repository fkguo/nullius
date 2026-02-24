#!/usr/bin/env python3
"""
Pointer lint preflight for research-team audits.

Goal:
  Catch "definition-hardened" code-pointer drift in notebooks, e.g.
    `hw2d.physical_properties.get_energy`  (looks plausible, but is not import-resolvable)
  before running dual audits.

What it checks (best-effort, safe-by-default):
  - Scans inline-code segments (`...`) in the notebook for dotted identifiers that look like
    Python pointers: foo.bar.baz
  - Attempts to resolve pointers in a target Python environment (auto-detected or user-specified):
      import the longest module prefix, then getattr the remaining segments.
  - Reports PASS/FAIL and lists failing pointers with notebook line numbers.

Exit codes:
  0  No failing resolvable Python pointers
  1  At least one failing resolvable Python pointer
  2  Input / execution error (file missing, cannot run import-check interpreter, etc.)
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shlex
import shutil
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "lib"))

from team_config import load_team_config  # type: ignore

_INLINE_CODE_RE = re.compile(r"`([^`\n]+)`")
_DOTTED_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)+$")
_FILE_SYMBOL_RE = re.compile(r"^(?P<path>[^#:\s][^#:\n]*?)(?P<sep>[:#])(?P<sym>[A-Za-z_][A-Za-z0-9_]*)$")
_FILE_EXTS = {
    "md",
    "txt",
    "json",
    "jsonl",
    "csv",
    "tsv",
    "png",
    "pdf",
    "svg",
    "h5",
    "hdf5",
    "tex",
    "bib",
    "jl",
    "py",
}


@dataclass(frozen=True)
class PointerOccurrence:
    line: int


@dataclass(frozen=True)
class PointerResult:
    status: str  # ok / fail / skip
    module: str | None
    detail: str | None


def _parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--notes", type=Path, required=True, help="Path to the primary notebook (Markdown).")
    p.add_argument(
        "--import-cmd",
        type=str,
        default="",
        help=(
            "Optional Python command used for import checks. Examples:\n"
            '  --import-cmd "conda run -n plasma python"\n'
            '  --import-cmd "/opt/miniconda3/envs/plasma/bin/python"\n'
            "If omitted, auto-detects from env var / environment.yml / .venv."
        ),
    )
    p.add_argument(
        "--max-failures",
        type=int,
        default=50,
        help="Maximum number of failing pointers to show in the report.",
    )
    return p.parse_args()


def _find_project_root(start: Path) -> Path:
    markers = ("environment.yml", "pyproject.toml", "requirements.txt", ".git")
    cur = start.resolve()
    while True:
        for m in markers:
            if (cur / m).exists():
                return cur
        if cur.parent == cur:
            return start.resolve()
        cur = cur.parent


def _parse_conda_env_name(env_yml: Path) -> str | None:
    try:
        for ln in env_yml.read_text(encoding="utf-8", errors="replace").splitlines():
            s = ln.strip()
            if not s or s.startswith("#"):
                continue
            if s.startswith("name:"):
                name = s.split(":", 1)[1].strip()
                return name or None
    except Exception:
        return None
    return None


def _detect_import_cmd(project_root: Path, explicit: str) -> list[str]:
    if explicit.strip():
        return shlex.split(explicit.strip())

    env_cmd = os.environ.get("RESEARCH_TEAM_IMPORT_CMD", "").strip()
    if env_cmd:
        return shlex.split(env_cmd)

    # Back-compat
    env_cmd = os.environ.get("RESEARCH_TEAM_AUDIT_IMPORT_CMD", "").strip()
    if env_cmd:
        return shlex.split(env_cmd)

    env_yml = project_root / "environment.yml"
    if env_yml.is_file():
        env_name = _parse_conda_env_name(env_yml)
        if env_name:
            # IMPORTANT: conda-run captures output by default and does not forward stdin;
            # add --no-capture-output so we can feed JSON payloads via stdin.
            return ["conda", "run", "--no-capture-output", "-n", env_name, "python"]

    venv_py = project_root / ".venv" / "bin" / "python"
    if venv_py.is_file():
        return [str(venv_py)]

    return ["python3"]


def _normalize_import_cmd(import_cmd: list[str]) -> list[str]:
    # If the user provided "conda run ..." without --no-capture-output, stdin will be swallowed.
    if len(import_cmd) >= 2 and import_cmd[0] == "conda" and import_cmd[1] == "run":
        if "--no-capture-output" not in import_cmd and "--live-stream" not in import_cmd:
            return [import_cmd[0], import_cmd[1], "--no-capture-output", *import_cmd[2:]]
    return import_cmd


def _extract_dotted_inline_code(text: str) -> dict[str, list[PointerOccurrence]]:
    occurrences: dict[str, list[PointerOccurrence]] = {}
    for lineno, line in enumerate(text.splitlines(), start=1):
        for m in _INLINE_CODE_RE.finditer(line):
            token = m.group(1).strip()
            if not token:
                continue
            if not _DOTTED_RE.match(token):
                continue
            # Avoid obvious filename-like tokens (e.g. `Draft.md`, `analysis.json`), which
            # match the dotted regex but are not code pointers.
            if "." in token:
                ext = token.rsplit(".", 1)[1].lower()
                if ext in _FILE_EXTS:
                    continue
            occurrences.setdefault(token, []).append(PointerOccurrence(line=lineno))
    return occurrences


def _extract_file_symbol_inline_code(text: str) -> dict[str, list[PointerOccurrence]]:
    """
    Extract file-based pointers like:
      `src/foo.jl:myfunc`
      `include/bar.cpp#MyClass`
    """
    occurrences: dict[str, list[PointerOccurrence]] = {}
    for lineno, line in enumerate(text.splitlines(), start=1):
        for m in _INLINE_CODE_RE.finditer(line):
            token = m.group(1).strip()
            if not token or "://" in token:
                continue
            m2 = _FILE_SYMBOL_RE.match(token)
            if not m2:
                continue
            occurrences.setdefault(token, []).append(PointerOccurrence(line=lineno))
    return occurrences


def _resolve_pointer_path(path_s: str, notes_path: Path, project_root: Path) -> Path:
    p = Path(path_s)
    if p.is_absolute():
        return p
    cand = notes_path.parent / p
    if cand.exists():
        return cand
    return project_root / p


def _file_contains_symbol(path: Path, symbol: str) -> bool:
    if path.is_dir() or not path.exists():
        return False
    use_rg = bool(shutil.which("rg")) and os.environ.get("RESEARCH_TEAM_POINTER_LINT_NO_RG", "").strip() != "1"
    pat = rf"\b{re.escape(symbol)}\b"
    if use_rg:
        try:
            proc = subprocess.run(
                ["rg", "-n", "-m", "1", "--pcre2", pat, str(path)],
                capture_output=True,
                text=True,
            )
            return proc.returncode == 0
        except Exception:
            pass
    try:
        data = path.read_text(encoding="utf-8", errors="replace")
    except Exception:
        return False
    return re.search(pat, data) is not None


def _run_file_symbol_checks(notes: Path, pointers: list[str], project_root: Path) -> dict[str, PointerResult]:
    out: dict[str, PointerResult] = {}
    for p in pointers:
        m = _FILE_SYMBOL_RE.match(p)
        if not m:
            out[p] = PointerResult(status="skip", module=None, detail="not a file:Symbol pointer")
            continue
        path_s = m.group("path")
        sym = m.group("sym")
        fp = _resolve_pointer_path(path_s, notes, project_root)
        if not fp.exists():
            out[p] = PointerResult(status="fail", module=str(fp), detail="file not found")
            continue
        if _file_contains_symbol(fp, sym):
            out[p] = PointerResult(status="ok", module=str(fp), detail=f"symbol={sym}")
        else:
            out[p] = PointerResult(status="fail", module=str(fp), detail=f"symbol not found: {sym}")
    return out


def _run_import_checks(import_cmd: list[str], pointers: list[str], cwd: Path) -> dict[str, PointerResult]:
    # Run all checks in one interpreter call for speed and consistent sys.path.
    payload = {"pointers": pointers}
    code = r"""
import importlib
import json
import sys

data = json.load(sys.stdin)
pointers = data.get("pointers", [])

out = {}
for p in pointers:
    parts = p.split(".")
    last_mod_err = None
    resolved = False
    for i in range(len(parts), 0, -1):
        modname = ".".join(parts[:i])
        try:
            mod = importlib.import_module(modname)
        except ModuleNotFoundError as e:
            last_mod_err = e
            continue
        except Exception as e:
            out[p] = {"status": "fail", "module": modname, "detail": f"import error: {type(e).__name__}: {e}"}
            resolved = True
            break
        obj = mod
        try:
            for attr in parts[i:]:
                obj = getattr(obj, attr)
            out[p] = {"status": "ok", "module": modname, "detail": f"type={type(obj).__name__}"}
        except Exception as e:
            out[p] = {"status": "fail", "module": modname, "detail": f"{type(e).__name__}: {e}"}
        resolved = True
        break

    if not resolved:
        # Top-level module not importable: most likely this dotted path is a JSON key path, not a code pointer.
        msg = None
        if last_mod_err is not None:
            msg = f"{type(last_mod_err).__name__}: {last_mod_err}"
        out[p] = {"status": "skip", "module": None, "detail": msg}

print(json.dumps(out))
"""

    try:
        proc = subprocess.run(
            [*import_cmd, "-c", code],
            input=json.dumps(payload),
            text=True,
            capture_output=True,
            cwd=str(cwd),
        )
    except FileNotFoundError as e:
        raise RuntimeError(f"import-cmd not found: {import_cmd!r} ({e})")

    if proc.returncode != 0:
        stderr = (proc.stderr or "").strip()
        stdout = (proc.stdout or "").strip()
        hint = stderr or stdout or "(no output)"
        raise RuntimeError(f"import-check interpreter failed (code={proc.returncode}): {hint}")

    try:
        raw = json.loads(proc.stdout)
    except Exception as e:
        raise RuntimeError(f"import-check returned non-JSON output: {e}\nstdout:\n{proc.stdout}\nstderr:\n{proc.stderr}")

    out: dict[str, PointerResult] = {}
    for p, r in raw.items():
        out[p] = PointerResult(
            status=str(r.get("status", "fail")),
            module=r.get("module"),
            detail=r.get("detail"),
        )
    return out


def _fmt_locations(notes_path: Path, occs: list[PointerOccurrence]) -> str:
    # Compact: show up to 3 line numbers.
    lines = [o.line for o in occs]
    uniq = sorted(set(lines))
    show = uniq[:3]
    locs = ", ".join(f"{notes_path.name}:{n}" for n in show)
    if len(uniq) > len(show):
        locs += f", ... (+{len(uniq) - len(show)})"
    return locs


def _escape_table_cell(s: str) -> str:
    return s.replace("|", "\\|").replace("\n", " ").strip()


def main() -> int:
    args = _parse_args()
    notes: Path = args.notes
    if not notes.is_file():
        print(f"ERROR: notes not found: {notes}", file=sys.stderr)
        return 2

    cfg = load_team_config(notes)
    if not cfg.feature_enabled("pointer_lint_gate", default=True):
        print("- Notes: `{}`".format(notes))
        print("- Gate: SKIP (disabled by research_team_config)")
        return 0

    strategy = str(cfg.data.get("pointer_lint", {}).get("strategy", "python_import")).strip()
    if strategy in ("off", "false", "0"):
        strategy = "disabled"
    if strategy == "disabled":
        print("- Notes: `{}`".format(notes))
        print("- Gate: SKIP (pointer_lint.strategy=disabled)")
        return 0

    text = notes.read_text(encoding="utf-8", errors="replace")
    if strategy == "python_import":
        occurrences = _extract_dotted_inline_code(text)
    elif strategy == "file_symbol_grep":
        occurrences = _extract_file_symbol_inline_code(text)
    else:
        print(f"ERROR: unknown pointer_lint.strategy: {strategy!r}", file=sys.stderr)
        return 2

    pointers = sorted(occurrences.keys())

    project_root = _find_project_root(notes.parent)

    results: dict[str, PointerResult] = {}
    import_cmd: list[str] | None = None
    if pointers:
        try:
            if strategy == "python_import":
                import_cmd = _normalize_import_cmd(_detect_import_cmd(project_root, args.import_cmd))
                results = _run_import_checks(import_cmd, pointers, cwd=project_root)
            else:
                results = _run_file_symbol_checks(notes, pointers, project_root=project_root)
        except Exception as e:
            print("ERROR: failed to run import checks.", file=sys.stderr)
            print(f"  notes: {notes}", file=sys.stderr)
            print(f"  project_root: {project_root}", file=sys.stderr)
            if strategy == "python_import":
                print(f"  import_cmd: {import_cmd!r}", file=sys.stderr)
            print(f"  error: {e}", file=sys.stderr)
            return 2

    checked = [p for p in pointers if results.get(p, PointerResult("skip", None, None)).status in ("ok", "fail")]
    passed = [p for p in checked if results[p].status == "ok"]
    failed = [p for p in checked if results[p].status == "fail"]
    skipped = [p for p in pointers if results.get(p, PointerResult("skip", None, None)).status == "skip"]

    gate = "PASS" if not failed else "FAIL"

    # Report (Markdown snippet, no outer heading; packet builder wraps this).
    print(f"- Notes: `{notes}`")
    print(f"- Project root (heuristic): `{project_root}`")
    print(f"- Pointer lint strategy: `{strategy}`")
    if strategy == "python_import":
        if import_cmd:
            print(f"- Import check cmd: `{_escape_table_cell(' '.join(import_cmd))}`")
        else:
            print("- Import check cmd: (skipped; no inline pointers)")
    print(f"- Inline pointers found: {len(pointers)}")
    print(f"- Import-checked: {len(checked)} (pass={len(passed)}, fail={len(failed)}); skipped={len(skipped)}")
    print(f"- Gate: {gate}")

    if failed:
        print("")
        print("| Pointer | Locations | Error |")
        print("|---|---|---|")
        for p in failed[: args.max_failures]:
            r = results[p]
            loc = _fmt_locations(notes, occurrences[p])
            err = r.detail or "(no detail)"
            print(f"| `{_escape_table_cell(p)}` | {_escape_table_cell(loc)} | {_escape_table_cell(err)} |")
        if len(failed) > args.max_failures:
            print(f"| ... | ... | (and {len(failed) - args.max_failures} more) |")

    # Make skipped pointers visible but non-blocking (usually JSON dot-paths).
    if skipped:
        print("")
        if strategy == "python_import":
            print("- Skipped (top-level module not importable; likely JSON dot-paths, not code pointers):")
        else:
            print("- Skipped (pointer did not match the required file:Symbol pattern):")
        for p in skipped[:10]:
            loc = _fmt_locations(notes, occurrences[p])
            print(f"  - `{p}` ({loc})")
        if len(skipped) > 10:
            print(f"  - ... ({len(skipped) - 10} more)")

    return 0 if not failed else 1


if __name__ == "__main__":
    raise SystemExit(main())
