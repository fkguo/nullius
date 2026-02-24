from __future__ import annotations

import difflib
import hashlib
import json
import os
import re
import subprocess
from pathlib import Path
from typing import Any

from ._json import read_json
from ._time import utc_now_iso


def _sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def _sha256_text(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8", errors="replace")).hexdigest()


def _safe_rel(repo_root: Path, p: Path) -> str:
    try:
        return os.fspath(p.resolve().relative_to(repo_root.resolve())).replace(os.sep, "/")
    except Exception:
        return os.fspath(p)


def _resolve_under_dir(*, repo_root: Path, base_dir: Path, path_str: str) -> Path | None:
    """
    Resolve a user-provided path string as either:
    - absolute path, or
    - repo_root-relative, or
    - base_dir-relative (handy when an LLM outputs paths relative to RUN_ROOT).

    Returns an absolute Path if it resolves *under* base_dir; otherwise None.
    This is a safety helper for evidence-first validation.
    """
    s = str(path_str or "").strip()
    if not s:
        return None

    base = base_dir.expanduser().resolve()
    repo = repo_root.expanduser().resolve()
    p = Path(s).expanduser()

    def _is_under(x: Path) -> bool:
        try:
            x.resolve().relative_to(base)
            return True
        except Exception:
            return False

    if p.is_absolute():
        abs_p = p.resolve()
        return abs_p if _is_under(abs_p) else None

    cand_repo = (repo / p).resolve()
    if _is_under(cand_repo):
        return cand_repo

    cand_base = (base / p).resolve()
    if _is_under(cand_base):
        return cand_base

    return None


def _codex_home() -> Path:
    env = os.environ.get("CODEX_HOME", "").strip()
    if env:
        return Path(env).expanduser().resolve()
    return (Path.home() / ".codex").resolve()


def _skills_dir() -> Path:
    return _codex_home() / "skills"


def _require_file(path: Path, *, label: str) -> Path:
    p = path.expanduser().resolve()
    if not p.is_file():
        raise FileNotFoundError(f"{label} not found: {p}")
    return p


def _paper_reviser_skill_dir(*, skills_dir: Path | None) -> Path:
    sd = (skills_dir.expanduser().resolve() if skills_dir else _skills_dir())
    return sd / "paper-reviser"


def find_paper_reviser_edit_script(*, skills_dir: Path | None = None) -> Path:
    root = _paper_reviser_skill_dir(skills_dir=skills_dir)
    return _require_file(root / "scripts" / "bin" / "paper_reviser_edit.py", label="paper-reviser edit script")


def find_build_verification_plan_script(*, skills_dir: Path | None = None) -> Path:
    root = _paper_reviser_skill_dir(skills_dir=skills_dir)
    return _require_file(root / "scripts" / "bin" / "build_verification_plan.py", label="paper-reviser build plan script")


def _find_llm_runner(*, skills_dir: Path, backend: str) -> Path:
    sd = skills_dir.expanduser().resolve()
    if backend == "claude":
        return _require_file(sd / "claude-cli-runner" / "scripts" / "run_claude.sh", label="claude runner")
    if backend == "gemini":
        return _require_file(sd / "gemini-cli-runner" / "scripts" / "run_gemini.sh", label="gemini runner")
    raise ValueError(f"unknown backend: {backend!r}")


def _run_logged(
    argv: list[str],
    *,
    cwd: Path,
    log_path: Path,
    timeout_seconds: int | None = None,
    env: dict[str, str] | None = None,
) -> int:
    log_path.parent.mkdir(parents=True, exist_ok=True)
    started = utc_now_iso().replace("+00:00", "Z")
    header = f"[started_at] {started}\n[cwd] {cwd}\n[argv] {json.dumps(argv)}\n\n"
    log_path.write_text(header, encoding="utf-8")
    try:
        p = subprocess.run(
            argv,
            cwd=cwd,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            encoding="utf-8",
            errors="replace",
            timeout=int(timeout_seconds) if timeout_seconds else None,
            env=env,
            check=False,
        )
        log_path.write_text(header + (p.stdout or ""), encoding="utf-8")
        return int(p.returncode)
    except FileNotFoundError as exc:
        # Preserve SSOT logging even when an executable/script is missing.
        log_path.write_text(header + f"\n[error] FileNotFoundError: {exc}\n", encoding="utf-8")
        return 127
    except subprocess.TimeoutExpired:
        log_path.write_text(header + f"\n[timeout] timeout_seconds={timeout_seconds}\n", encoding="utf-8")
        return 124


def _load_json_if_exists(path: Path) -> dict[str, Any] | None:
    if not path.exists():
        return None
    try:
        obj = read_json(path)
        return obj if isinstance(obj, dict) else None
    except Exception:
        return None


def _paper_reviser_round_ok(round_dir: Path) -> tuple[bool, dict[str, Any] | None, list[str]]:
    run_path = round_dir / "run.json"
    clean_path = round_dir / "clean.tex"
    diff_path = round_dir / "changes.diff"

    if not run_path.is_file():
        return False, None, [f"missing run.json: {run_path}"]
    run = _load_json_if_exists(run_path)
    if not isinstance(run, dict):
        return False, None, ["run.json is not a JSON object"]

    errors: list[str] = []
    if int(run.get("schema_version") or 0) != 1:
        errors.append("run.json schema_version != 1")
    if int(run.get("exit_status") or 0) != 0:
        errors.append(f"run.json exit_status != 0 (exit_status={run.get('exit_status')})")
    if run.get("converged") is not True:
        errors.append(f"run.json converged != true (converged={run.get('converged')!r})")
    if not clean_path.is_file():
        errors.append(f"missing clean.tex: {clean_path}")
    if not diff_path.is_file():
        errors.append(f"missing changes.diff: {diff_path}")

    return (not errors), run, errors


def _diff_text(a: str, b: str, *, from_name: str, to_name: str) -> str:
    return "".join(
        difflib.unified_diff(
            a.splitlines(keepends=True),
            b.splitlines(keepends=True),
            fromfile=from_name,
            tofile=to_name,
        )
    )


_SAFE_FS_TOKEN_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")


def _is_safe_fs_token(s: str) -> bool:
    """
    Return True if s is safe to use as a single path segment for SSOT files.

    Quality-first rationale:
    - Preserve human-meaningful ids (VR ids, task ids) when they are already safe.
    - For unsafe ids, map deterministically to a safe token (see _fs_token) rather than
      fail-closed and block the workflow.
    """
    t = str(s or "").strip()
    if not t:
        return False
    if t in {".", ".."}:
        return False
    if "/" in t or "\\" in t:
        return False
    return bool(_SAFE_FS_TOKEN_RE.match(t))


def _fs_token(raw: str, *, kind: str) -> str:
    """
    Map an arbitrary id string to a filesystem-safe token (single path segment).

    - If raw is already safe, return it unchanged (preserves readability).
    - Else, return "<slug>__<sha10>" where slug is ASCII [A-Za-z0-9._-] and sha10 is a
      stable short hash of the original raw string (collision-resistant).
    """
    t = str(raw or "").strip()
    if _is_safe_fs_token(t):
        return t
    h = hashlib.sha256(t.encode("utf-8", errors="replace")).hexdigest()[:10]
    slug = re.sub(r"[^A-Za-z0-9._-]+", "_", t).strip("._-")
    if not slug:
        slug = str(kind or "ID").strip() or "ID"
    if len(slug) > 64:
        slug = slug[:64].rstrip("._-") or (str(kind or "ID").strip() or "ID")
    return f"{slug}__{h}"
