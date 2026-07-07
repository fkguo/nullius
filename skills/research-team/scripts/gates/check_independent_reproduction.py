#!/usr/bin/env python3
"""
Independent reproduction gate for full_access team-cycle runs.

Layer 1 — artifact presence (per member):
  - evidence.outputs_produced must contain at least one file under:
      artifacts/runs/<run_id>/research_team/<member_id>/independent/
    (excluding script files like .py/.jl/.sh)
  - that file must exist on disk

Layer 2 — shared-kernel inheritance scan (fail-closed):
  Two reproductions that import / include / `using` the SAME kernel are not
  independent: their agreement can be a shared-error artifact, not a
  confirmation. The scan reads the reproduction sources each member wrote
  under its own independent/ directory and fails the gate
  (verdict `not_independent`, label SHARED_KERNEL_INHERITANCE) when:

  - K1: any member's reproduction source loads a DECLARED kernel-under-test
        module (config `independent_reproduction.kernel_modules` or repeated
        `--kernel-module`) — a call-through of the tested kernel is not a
        reproduction of it;
  - K2: BOTH members import the same module name that resolves to a
        project-local source file (outside both members' own directories);
  - K3: BOTH members include/source the same resolved project file by path.

  K2/K3 honor the same `logic_isolation.allowed_local_import_roots` allowlist
  the logic_isolation gate uses (default: shared_utils, toolkit), so the two
  gates never disagree about a deliberately shared utility root. A DECLARED
  kernel module is never allowlistable.

Resolution discipline (printed on failure): when two reproductions disagree,
locate the FIRST diverging intermediate quantity by tracing both paths;
never settle a disagreement by majority vote across copies of the same
kernel, and never by re-running until agreement.

Machine verdict:
  Emits a `convergence_gate_result_v1` JSON object on stdout (and to
  --out-json when given) whenever the gate actually evaluates
  (PASS / FAIL / input error). Human diagnostics go to stderr. On SKIP
  (feature disabled or review_access_mode != full_access) no verdict is
  emitted: nothing was evaluated.

Exit codes:
  0  PASS (or SKIP)
  1  FAIL (missing independent reproduction artifact, or not_independent)
  2  Input / execution error
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "lib"))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from convergence_schema import (  # type: ignore
    build_gate_meta,
    default_member_status,
    emit_convergence_result,
    validate_convergence_result,
)
from team_config import load_team_config  # type: ignore

MEMBERS = ("member_a", "member_b")

# Source files parsed for import/include statements (K2/K3) and scanned for
# declared kernel usage (K1). Code-like extensions only: prose files (.md,
# .txt) mentioning a kernel name are not load statements.
_PARSE_EXTS = {".py", ".jl"}
_SHELL_EXTS = {".sh", ".bash", ".zsh"}
_K1_SCAN_EXTS = _PARSE_EXTS | _SHELL_EXTS | {
    ".r", ".R", ".m", ".wl", ".wls", ".nb", ".ipynb",
    ".c", ".cc", ".cpp", ".h", ".hpp", ".f", ".f90", ".f95",
    ".rs", ".go", ".js", ".ts",
}
_HASH_COMMENT_EXTS = _PARSE_EXTS | _SHELL_EXTS | {".r", ".R"}
_SLASH_COMMENT_EXTS = {".c", ".cc", ".cpp", ".h", ".hpp", ".rs", ".go", ".js", ".ts"}
_MAX_SOURCE_BYTES = 2_000_000
_MAX_SOURCES_PER_MEMBER = 500

_PY_IMPORT_RE = re.compile(r"^\s*import\s+([A-Za-z_][\w.]*(?:\s*,\s*[A-Za-z_][\w.]*)*)")
_PY_FROM_RE = re.compile(r"^\s*from\s+(\.*)([A-Za-z_][\w.]*)?\s+import\b")
_JL_USING_RE = re.compile(r"^\s*(?:using|import)\s+([^#]+)")
_JL_INCLUDE_RE = re.compile(r"""\bincludet?\(\s*["']([^"']+)["']\s*\)""")
_SH_SOURCE_RE = re.compile(r"""^\s*(?:source|\.)\s+["']?([^\s"']+)""")
_R_SOURCE_RE = re.compile(r"""\bsource\(\s*["']([^"']+)["']""")
_R_LIBRARY_RE = re.compile(r"""\b(?:library|require)\(\s*["']?([A-Za-z][\w.]*)["']?\s*[,)]""")
_WL_GET_RE = re.compile(r"""\b(?:Get|Needs)\[\s*"([^"]+)"\s*[,\]]""")
_WL_LTLT_RE = re.compile(r"<<\s*([^\s;\]\"]+)")
# Language-agnostic "this line loads code" hint for the K1 declared-kernel
# scan (covers Mathematica Get/Needs/<<, R library/require, etc.).
_LOADER_HINT_RE = re.compile(
    r"(?:\b(?:import|using|include|includet|source|require|library|Get|Needs)\b|<<)"
)
# Python static import/from are covered precisely by the structured parser, so
# the K1 line scan for .py only hunts DYNAMIC loads — this keeps a docstring or
# string literal that merely mentions the kernel ("we import mykernel to
# compare") from producing a false FAIL, while still catching
# importlib.import_module("kernel") / __import__("kernel") call-throughs.
_PY_DYNAMIC_IMPORT_RE = re.compile(r"\b(?:importlib|__import__|import_module)\b")

# Directories never treated as project-local kernel sources (run artifacts,
# reviewer workspaces, vendored deps, caches).
_PRUNE_DIRS = {
    ".git", "artifacts", "team", "references", "node_modules", ".venv", "venv",
    "__pycache__", ".nullius", ".tmp", ".pytest_cache", ".serena",
    "knowledge_base", "knowledge_graph",
}
_WALK_MAX_DIRS = 4000
_WALK_MAX_DEPTH = 6


@dataclass(frozen=True)
class Issue:
    member: str
    message: str


@dataclass
class MemberSources:
    member: str
    root: Path
    files: list[Path] = field(default_factory=list)
    # top-level import/using module names -> first "file:line" seen
    modules: dict[str, str] = field(default_factory=dict)
    # resolved include/source paths -> first "file:line" seen
    includes: dict[Path, str] = field(default_factory=dict)


def _parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--notes", type=Path, required=True, help="Notebook path (used to locate config and project root).")
    p.add_argument("--tag", required=True, help="Resolved tag (e.g. M2-r3).")
    p.add_argument("--member-a", type=Path, required=True, help="Member A evidence JSON path.")
    p.add_argument("--member-b", type=Path, required=True, help="Member B evidence JSON path.")
    p.add_argument("--project-root", type=Path, default=None, help="Override project root (default: config dir or notes dir).")
    p.add_argument(
        "--kernel-module",
        action="append",
        default=[],
        help="Declared kernel-under-test module/package name (repeatable). "
        "Merged with config independent_reproduction.kernel_modules.",
    )
    p.add_argument("--out-json", type=Path, default=None, help="Also write the convergence_gate_result_v1 JSON here.")
    return p.parse_args()


def _safe_tag(tag: str) -> str:
    t = tag.strip()
    if not re.fullmatch(r"[A-Za-z0-9._-]+", t) or t == "." or ".." in t:
        raise ValueError(f"tag must be one safe path segment using only [A-Za-z0-9._-], not '.' and no '..': {tag}")
    return t


def _load(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8", errors="replace"))


def _project_root(notes: Path) -> Path:
    cfg = load_team_config(notes)
    cfg_path = getattr(cfg, "path", None)
    if isinstance(cfg_path, Path) and cfg_path.is_file():
        return cfg_path.parent.resolve()
    return notes.parent.resolve()


def _find_independent_outputs(ev: dict, prefix: str) -> list[str]:
    outs = ev.get("outputs_produced", [])
    if not isinstance(outs, list):
        return []
    found: list[str] = []
    for it in outs:
        if not isinstance(it, dict):
            continue
        p = str(it.get("path", "")).strip().replace("\\", "/")
        if not p.startswith(prefix):
            continue
        if p.lower().endswith((".py", ".jl", ".sh")):
            continue
        found.append(p)
    return found


# ---------------------------------------------------------------------------
# Layer 2: shared-kernel inheritance scan
# ---------------------------------------------------------------------------


def _config_kernel_modules(cfg: Any) -> list[str]:
    data = getattr(cfg, "data", {})
    if not isinstance(data, dict):
        return []
    block = data.get("independent_reproduction", {})
    if not isinstance(block, dict):
        return []
    mods = block.get("kernel_modules", [])
    if not isinstance(mods, list):
        return []
    return [str(m).strip() for m in mods if str(m).strip()]


def _allowed_local_roots(cfg: Any, kernels: list[str]) -> set[str]:
    """Local roots both members may legitimately share (same list the
    logic_isolation gate uses). A DECLARED kernel module is never
    allowlistable: the kernel-under-test wins over the allowlist."""
    data = getattr(cfg, "data", {})
    li = data.get("logic_isolation", {}) if isinstance(data, dict) else {}
    if not isinstance(li, dict):
        li = {}
    roots = li.get("allowed_local_import_roots", ["shared_utils", "toolkit"])
    if not isinstance(roots, list):
        roots = ["shared_utils", "toolkit"]
    return {str(x).strip() for x in roots if str(x).strip()} - set(kernels)


def _strip_comment(line: str, ext: str) -> str:
    if ext in _HASH_COMMENT_EXTS:
        return line.split("#", 1)[0]
    if ext in _SLASH_COMMENT_EXTS:
        return line.split("//", 1)[0]
    return line


def _iter_source_lines(path: Path) -> list[str]:
    try:
        if path.stat().st_size > _MAX_SOURCE_BYTES:
            return []
        text = path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return []
    return text.splitlines()


def _collect_member_sources(member: str, root: Path) -> MemberSources:
    ms = MemberSources(member=member, root=root)
    if not root.is_dir():
        return ms
    files = [p for p in sorted(root.rglob("*")) if p.is_file() and p.suffix in _K1_SCAN_EXTS]
    ms.files = files[:_MAX_SOURCES_PER_MEMBER]
    for f in ms.files:
        ext = f.suffix
        for lineno, raw in enumerate(_iter_source_lines(f), start=1):
            line = _strip_comment(raw, ext)
            if not line.strip():
                continue
            where = f"{f}:{lineno}"
            if ext == ".py":
                m = _PY_IMPORT_RE.match(line)
                if m:
                    for name in re.split(r"\s*,\s*", m.group(1)):
                        top = name.split(".", 1)[0]
                        ms.modules.setdefault(top, where)
                m = _PY_FROM_RE.match(line)
                if m:
                    dots, mod = m.group(1), m.group(2)
                    if not dots and mod:
                        ms.modules.setdefault(mod.split(".", 1)[0], where)
                    elif len(dots) >= 2 and mod:
                        rel = Path(*([".."] * (len(dots) - 1))) / Path(*mod.split("."))
                        for cand in (f.parent / rel).with_suffix(".py"), (f.parent / rel / "__init__.py"):
                            if cand.is_file():
                                ms.includes.setdefault(cand.resolve(), where)
            elif ext == ".jl":
                m = _JL_USING_RE.match(line)
                if m:
                    spec = m.group(1).split(":", 1)[0]
                    for name in re.split(r"\s*,\s*", spec):
                        name = name.strip()
                        if not name or name.startswith("."):
                            continue
                        top = name.split(".", 1)[0]
                        if re.fullmatch(r"[A-Za-z_]\w*", top):
                            ms.modules.setdefault(top, where)
                for m in _JL_INCLUDE_RE.finditer(line):
                    inc = Path(m.group(1))
                    cand = inc if inc.is_absolute() else (f.parent / inc)
                    if cand.is_file():
                        ms.includes.setdefault(cand.resolve(), where)
            elif ext in _SHELL_EXTS:
                m = _SH_SOURCE_RE.match(line)
                if m:
                    inc = Path(m.group(1))
                    cand = inc if inc.is_absolute() else (f.parent / inc)
                    if cand.is_file():
                        ms.includes.setdefault(cand.resolve(), where)
            elif ext in {".r", ".R"}:
                for m in _R_SOURCE_RE.finditer(line):
                    inc = Path(m.group(1))
                    cand = inc if inc.is_absolute() else (f.parent / inc)
                    if cand.is_file():
                        ms.includes.setdefault(cand.resolve(), where)
                for m in _R_LIBRARY_RE.finditer(line):
                    ms.modules.setdefault(m.group(1), where)
            elif ext in {".m", ".wl", ".wls"}:
                for m in [*_WL_GET_RE.finditer(line), *_WL_LTLT_RE.finditer(line)]:
                    arg = m.group(1).strip()
                    if arg.endswith("`"):
                        # Context form: Needs["Pkg`"] / Get["Pkg`Sub`"] — a module name.
                        top = arg.strip("`").split("`", 1)[0]
                        if re.fullmatch(r"[A-Za-z][\w$]*", top):
                            ms.modules.setdefault(top, where)
                    else:
                        inc = Path(arg)
                        cand = inc if inc.is_absolute() else (f.parent / inc)
                        if cand.is_file():
                            ms.includes.setdefault(cand.resolve(), where)
    return ms


def _scan_declared_kernels(ms: MemberSources, kernels: list[str]) -> list[Issue]:
    """K1: any load-like reference to a declared kernel-under-test module."""
    issues: list[Issue] = []
    if not kernels:
        return issues
    kernel_res = {k: re.compile(rf"\b{re.escape(k)}\b") for k in kernels}
    seen: set[tuple[str, str]] = set()

    for name, where in ms.modules.items():
        for k in kernels:
            if name == k and (ms.member, k) not in seen:
                seen.add((ms.member, k))
                issues.append(Issue(ms.member, f"SHARED_KERNEL_INHERITANCE: reproduction imports declared kernel-under-test module '{k}' ({where})"))
    for inc, where in ms.includes.items():
        for k, kre in kernel_res.items():
            if (ms.member, k) in seen:
                continue
            if any(kre.fullmatch(part) or kre.fullmatch(Path(part).stem) for part in inc.parts):
                seen.add((ms.member, k))
                issues.append(Issue(ms.member, f"SHARED_KERNEL_INHERITANCE: reproduction includes declared kernel-under-test file for '{k}' ({where})"))
    for f in ms.files:
        ext = f.suffix
        # For .py the structured parser above already covers static imports;
        # the line scan only hunts dynamic loads (importlib / __import__), so
        # a string literal or docstring mentioning the kernel cannot fail the
        # gate. Other languages keep the broad loader hint.
        hint_re = _PY_DYNAMIC_IMPORT_RE if ext == ".py" else _LOADER_HINT_RE
        for lineno, raw in enumerate(_iter_source_lines(f), start=1):
            line = _strip_comment(raw, ext)
            if not line.strip() or not hint_re.search(line):
                continue
            for k, kre in kernel_res.items():
                if (ms.member, k) in seen:
                    continue
                if kre.search(line):
                    seen.add((ms.member, k))
                    issues.append(Issue(ms.member, f"SHARED_KERNEL_INHERITANCE: reproduction source loads declared kernel-under-test '{k}' ({f}:{lineno}: {line.strip()[:120]})"))
    return issues


def _build_project_index(project_root: Path) -> dict[str, Path]:
    """Map module-name candidates -> project-local source path (bounded walk)."""
    index: dict[str, Path] = {}
    root_depth = len(project_root.parts)
    visited = 0
    for dirpath, dirnames, filenames in os.walk(project_root):
        visited += 1
        if visited > _WALK_MAX_DIRS:
            break
        cur = Path(dirpath)
        if len(cur.parts) - root_depth >= _WALK_MAX_DEPTH:
            dirnames[:] = []
            continue
        dirnames[:] = sorted(d for d in dirnames if d not in _PRUNE_DIRS and not d.startswith("."))
        for fn in sorted(filenames):
            p = cur / fn
            if fn == "__init__.py":
                index.setdefault(cur.name, p)
            elif fn.endswith((".py", ".jl", ".r", ".R", ".m", ".wl", ".wls")):
                index.setdefault(fn.rsplit(".", 1)[0], p)
            elif fn == "Project.toml":
                try:
                    m = re.search(r'(?m)^\s*name\s*=\s*"([^"]+)"', p.read_text(encoding="utf-8", errors="replace"))
                except OSError:
                    m = None
                if m:
                    index.setdefault(m.group(1), p)
            elif fn == "DESCRIPTION":
                try:
                    m = re.search(r"(?m)^Package:\s*([A-Za-z][\w.]*)", p.read_text(encoding="utf-8", errors="replace"))
                except OSError:
                    m = None
                if m:
                    index.setdefault(m.group(1), p)
    return index


def _member_shadows(ms: MemberSources, name: str) -> bool:
    """True when the member's own independent/ dir carries a module of this name."""
    for rel in (f"{name}.py", f"{name}/__init__.py", f"{name}.jl"):
        if (ms.root / rel).is_file():
            return True
    return False


def _scan_shared_kernel(
    ms_a: MemberSources,
    ms_b: MemberSources,
    project_root: Path,
    allowed_roots: set[str],
) -> list[Issue]:
    """K2 + K3: both reproduction paths inherit the same project-local kernel."""
    issues: list[Issue] = []

    shared_names = sorted(set(ms_a.modules) & set(ms_b.modules))
    index: dict[str, Path] | None = None
    for name in shared_names:
        if name in allowed_roots:
            continue
        if _member_shadows(ms_a, name) or _member_shadows(ms_b, name):
            continue
        if index is None:
            index = _build_project_index(project_root)
        target = index.get(name)
        if target is None:
            continue
        rel = target.relative_to(project_root) if target.is_relative_to(project_root) else target
        issues.append(
            Issue(
                "member_a+member_b",
                f"SHARED_KERNEL_INHERITANCE: both reproduction paths import project-local module '{name}' "
                f"(resolves to {rel}; member_a at {ms_a.modules[name]}, member_b at {ms_b.modules[name]}) — "
                "agreement between copies of one kernel is not an independent confirmation",
            )
        )

    member_roots = (ms_a.root.resolve(), ms_b.root.resolve())
    for inc in sorted(set(ms_a.includes) & set(ms_b.includes)):
        if not inc.is_relative_to(project_root):
            continue
        if any(inc.is_relative_to(r) for r in member_roots):
            continue
        rel = inc.relative_to(project_root)
        if rel.parts and rel.parts[0] in allowed_roots:
            continue
        issues.append(
            Issue(
                "member_a+member_b",
                f"SHARED_KERNEL_INHERITANCE: both reproduction paths include the same project file '{rel}' "
                f"(member_a at {ms_a.includes[inc]}, member_b at {ms_b.includes[inc]}) — "
                "agreement between copies of one kernel is not an independent confirmation",
            )
        )
    return issues


# ---------------------------------------------------------------------------
# Verdict emission (convergence_gate_result_v1)
# ---------------------------------------------------------------------------


def _emit_result_or_fallback(
    *,
    status: str,
    exit_code: int,
    reasons: list[str],
    report_status: dict[str, Any],
    meta: dict[str, Any],
    out_json: Path | None,
) -> int:
    result: dict[str, Any] = {
        "status": status,
        "exit_code": exit_code,
        "reasons": reasons,
        "report_status": report_status,
        "meta": meta,
    }
    schema_errors = validate_convergence_result(result)
    if schema_errors:
        result = {
            "status": "parse_error",
            "exit_code": 2,
            "reasons": ["schema validation failed", *schema_errors],
            "report_status": {k: {**v, "parse_ok": False} for k, v in report_status.items()},
            "meta": meta,
        }
        exit_code = 2
    emit_convergence_result(result, out_json=out_json)
    return exit_code


def _member_summary(verdict: str, independence: str, errors: list[str]) -> dict[str, Any]:
    out: dict[str, Any] = {
        "verdict": verdict,
        "blocking_count": len(errors),
        "parse_ok": True,
        "independence": independence,
    }
    if errors:
        out["errors"] = errors
    return out


def main() -> int:
    args = _parse_args()
    base_meta = build_gate_meta("independent_reproduction")

    def _input_error(reasons: list[str]) -> int:
        for r in reasons:
            print(f"ERROR: {r}", file=sys.stderr)
        return _emit_result_or_fallback(
            status="parse_error",
            exit_code=2,
            reasons=reasons,
            report_status={m: default_member_status() for m in MEMBERS},
            meta=base_meta,
            out_json=args.out_json,
        )

    try:
        return _run(args, base_meta, _input_error)
    except Exception as e:
        # Fail-closed: an unforeseen crash must still leave a machine-readable
        # parse_error verdict on stdout (exit 2), not a bare traceback whose
        # missing verdict a caller could mistake for "gate not run".
        return _input_error([f"unexpected gate error: {type(e).__name__}: {e}"])


def _run(args: argparse.Namespace, base_meta: dict[str, Any], _input_error: Any) -> int:
    if not args.notes.is_file():
        return _input_error([f"notes not found: {args.notes}"])

    cfg = load_team_config(args.notes)
    if not cfg.feature_enabled("independent_reproduction_gate", default=False):
        print(f"- Notes: `{args.notes}`", file=sys.stderr)
        print("- Gate: SKIP (independent_reproduction_gate disabled by config)", file=sys.stderr)
        return 0

    mode = str(getattr(cfg, "data", {}).get("review_access_mode", "packet_only")).strip().lower()
    if mode != "full_access":
        print(f"- Notes: `{args.notes}`", file=sys.stderr)
        print(f"- Review access mode: {mode or 'packet_only'}", file=sys.stderr)
        print("- Gate: SKIP (review_access_mode != full_access)", file=sys.stderr)
        return 0

    if not args.member_a.is_file() or not args.member_b.is_file():
        return _input_error(
            [f"missing member evidence file: {p}" for p in (args.member_a, args.member_b) if not p.is_file()]
        )

    project_root = args.project_root.resolve() if args.project_root is not None else _project_root(args.notes)
    tag = args.tag.strip()
    try:
        st = _safe_tag(tag)
    except ValueError as e:
        return _input_error([str(e)])

    try:
        ev_a = _load(args.member_a)
        ev_b = _load(args.member_b)
    except (json.JSONDecodeError, OSError) as e:
        return _input_error([f"failed to load member evidence JSON: {e}"])

    kernels = sorted({*(k.strip() for k in args.kernel_module if k.strip()), *_config_kernel_modules(cfg)})
    allowed_roots = _allowed_local_roots(cfg, kernels)

    # Layer 1: independent artifacts exist.
    issues: list[Issue] = []
    for member, ev in (("member_a", ev_a), ("member_b", ev_b)):
        prefix = f"artifacts/runs/{st}/research_team/{member}/independent/"
        outputs = _find_independent_outputs(ev, prefix)
        if not outputs:
            issues.append(Issue(member, f"MISSING_INDEPENDENT_ARTIFACT: no outputs_produced under {prefix!r} (excluding scripts)"))
            continue
        missing = []
        for p in outputs[:10]:
            abs_p = (project_root / p).resolve() if not Path(p).is_absolute() else Path(p).resolve()
            if not abs_p.exists():
                missing.append(p)
        if missing:
            issues.append(Issue(member, f"MISSING_INDEPENDENT_ARTIFACT: independent outputs missing on disk: {missing[:5]!r}"))

    # Layer 2: shared-kernel inheritance.
    ms = {
        member: _collect_member_sources(
            member, project_root / f"artifacts/runs/{st}/research_team/{member}/independent"
        )
        for member in MEMBERS
    }
    for member in MEMBERS:
        issues.extend(_scan_declared_kernels(ms[member], kernels))
        if kernels and not ms[member].files:
            issues.append(
                Issue(
                    member,
                    "UNVERIFIABLE_INDEPENDENCE: kernel modules are declared but no reproduction "
                    f"sources were found under {ms[member].root} to scan — independence from the "
                    "kernel-under-test cannot be verified (fail-closed)",
                )
            )
    issues.extend(_scan_shared_kernel(ms["member_a"], ms["member_b"], project_root, allowed_roots))

    print(f"- Notes: `{args.notes}`", file=sys.stderr)
    print(f"- Project root: `{project_root}`", file=sys.stderr)
    print(f"- Tag: {tag} (safe={st})", file=sys.stderr)
    print(f"- Member A evidence: `{args.member_a}`", file=sys.stderr)
    print(f"- Member B evidence: `{args.member_b}`", file=sys.stderr)
    print(f"- Declared kernel modules: {kernels if kernels else '(none declared)'}", file=sys.stderr)
    print(f"- Reproduction sources scanned: member_a={len(ms['member_a'].files)}, member_b={len(ms['member_b'].files)}", file=sys.stderr)
    print(f"- Issues: {len(issues)}", file=sys.stderr)

    member_errors = {m: [it.message for it in issues if m in it.member] for m in MEMBERS}
    not_independent = {
        m: any("SHARED_KERNEL_INHERITANCE" in msg for msg in member_errors[m]) for m in MEMBERS
    }
    meta = {
        **base_meta,
        "tag": tag,
        "kernel_modules": kernels,
        "allowed_local_import_roots": sorted(allowed_roots),
    }

    if issues:
        for it in issues:
            print(f"ERROR: {it.member}: {it.message}", file=sys.stderr)
        print("- Gate: FAIL", file=sys.stderr)
        print(
            "- Resolution discipline: locate the first diverging intermediate quantity by tracing "
            "both reproduction paths; never settle a disagreement by majority vote, and never by "
            "re-running until agreement.",
            file=sys.stderr,
        )
        report_status = {
            m: _member_summary(
                "needs_revision" if member_errors[m] else "ready",
                "not_independent" if not_independent[m] else ("independent" if not member_errors[m] else "unknown"),
                member_errors[m],
            )
            for m in MEMBERS
        }
        return _emit_result_or_fallback(
            status="not_converged",
            exit_code=1,
            reasons=[it.message for it in issues],
            report_status=report_status,
            meta=meta,
            out_json=args.out_json,
        )

    print("- Gate: PASS", file=sys.stderr)
    report_status = {m: _member_summary("ready", "independent", []) for m in MEMBERS}
    return _emit_result_or_fallback(
        status="converged",
        exit_code=0,
        reasons=[],
        report_status=report_status,
        meta=meta,
        out_json=args.out_json,
    )


if __name__ == "__main__":
    raise SystemExit(main())
