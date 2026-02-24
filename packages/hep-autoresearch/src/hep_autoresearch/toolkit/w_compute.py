from __future__ import annotations

import json
import os
import re
import shutil
import shlex
import stat
import subprocess
import sys
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from ._git import try_get_git_metadata
from ._json import read_json, write_json
from ._paths import manifest_cwd
from ._time import utc_now_iso
from .adapters.artifacts import sha256_file, sha256_json
from .artifact_report import write_artifact_report
from .run_card_schema import (
    RunCardV2,
    evaluate_acceptance_json_numeric_checks,
    expand_argv,
    extract_headline_numbers,
    load_run_card_v2,
    normalize_and_validate_run_card_v2,
)

_VALID_GATES = {"A1", "A2", "A3", "A4", "A5"}
_APPROVAL_ID_RE = re.compile(r"^A[1-5]-[0-9]{4,}$")


@dataclass(frozen=True)
class WComputeInputs:
    tag: str
    project_dir: str
    run_card: str
    trust_project: bool = False
    resume: bool = False
    params: dict[str, Any] | None = None
    gate_satisfied: dict[str, str] | None = None
    command_argv: list[str] | None = None
    default_timeout_seconds: int = 900


def _safe_rel(repo_root: Path, p: Path) -> str:
    try:
        return os.fspath(p.relative_to(repo_root)).replace(os.sep, "/")
    except Exception:  # CONTRACT-EXEMPT: CODE-01.5 diagnostic fallthrough
        return os.fspath(p).replace(os.sep, "/")


def _resolve_project_dir(repo_root: Path, project_dir: str) -> Path:
    p = Path(str(project_dir)).expanduser()
    if not p.is_absolute():
        p = repo_root / p
    p = p.resolve()
    if not p.is_dir():
        raise FileNotFoundError(f"project_dir not found or not a directory: {p}")
    return p


def _resolve_run_card_path(project_dir: Path, run_card: str) -> Path:
    p = Path(str(run_card)).expanduser()
    if not p.is_absolute():
        p = project_dir / p
    p = p.resolve()
    if not p.is_file():
        raise FileNotFoundError(f"run_card file not found: {p}")
    return p


def _toposort(phases: list[dict[str, Any]]) -> list[str]:
    """Return a topological order of phase_ids (raises on cycles)."""
    import heapq

    ids = [str(p.get("phase_id")) for p in phases]
    deps: dict[str, set[str]] = {pid: set() for pid in ids}
    users: dict[str, set[str]] = {pid: set() for pid in ids}
    for ph in phases:
        pid = str(ph.get("phase_id"))
        for d in ph.get("depends_on") or []:
            deps[pid].add(str(d))
            users[str(d)].add(pid)

    ready = [pid for pid in ids if not deps[pid]]
    heapq.heapify(ready)
    out: list[str] = []
    seen: set[str] = set()
    while ready:
        pid = heapq.heappop(ready)
        if pid in seen:
            continue
        seen.add(pid)
        out.append(pid)
        for u in sorted(users[pid]):
            deps[u].discard(pid)
            if not deps[u]:
                if u not in seen:
                    heapq.heappush(ready, u)
    if len(out) != len(ids):
        remaining = sorted([pid for pid in ids if pid not in out])
        raise ValueError(f"cycle detected in phases.depends_on (remaining): {remaining}")
    return out


def validate_phase_dag(phases: list[dict[str, Any]]) -> list[str]:
    """Public API: validate phase DAG and return a stable topological order of phase_ids.

    Raises ValueError on cycles or invalid/missing dependencies.
    """
    return _toposort(phases)


def _tty_present() -> bool:
    try:
        return bool(sys.stdin.isatty() and sys.stdout.isatty())
    except Exception:  # CONTRACT-EXEMPT: CODE-01.5 safe default for TTY detection
        return False


def _require_trust_project(*, trust_project: bool) -> dict[str, Any]:
    """Enforce the v3 trust model for executing shell commands and return an audit record."""
    import getpass

    tty = _tty_present()
    user = None
    try:
        user = getpass.getuser()
    except Exception:  # CONTRACT-EXEMPT: CODE-01.5 best-effort optional read
        user = None
    uid = None
    try:
        uid = os.getuid()
    except Exception:  # CONTRACT-EXEMPT: CODE-01.5 best-effort optional read
        uid = None

    if trust_project:
        return {
            "trusted": True,
            "mode": "flag",
            "tty_present": int(bool(tty)),
            "user": user,
            "uid": uid,
            "confirmed_at": utc_now_iso().replace("+00:00", "Z"),
        }

    if not tty:
        raise PermissionError("non-interactive run requires --trust-project to execute shell commands")

    # Interactive: ask once (best-effort). If stdin is not readable, fail closed.
    try:
        resp = input("This run_card executes shell commands. Trust this project? [y/N] ").strip().lower()
    except Exception as e:
        raise PermissionError(f"failed to read interactive trust prompt: {e}") from e
    if resp not in {"y", "yes"}:
        raise PermissionError("project not trusted (aborted)")

    return {
        "trusted": True,
        "mode": "prompt",
        "tty_present": int(bool(tty)),
        "user": user,
        "uid": uid,
        "confirmed_at": utc_now_iso().replace("+00:00", "Z"),
    }


def _containment_check(*, root: Path, path: Path, label: str) -> None:
    try:
        path.resolve().relative_to(root.resolve())
    except Exception as e:
        raise ValueError(f"{label} escapes root (refusing): {path}") from e


def _safe_copy_file(*, src: Path, dst: Path) -> None:
    """Copy src -> dst, refusing symlinks on both ends."""
    st = src.lstat()
    if stat.S_ISLNK(st.st_mode):
        raise RuntimeError(f"refusing to copy symlink: {src}")
    if not stat.S_ISREG(st.st_mode):
        raise RuntimeError(f"refusing to copy non-regular file: {src}")
    dst.parent.mkdir(parents=True, exist_ok=True)
    tmp = dst.with_name(f".tmp_copy_{int(time.time()*1000)}_{dst.name}")
    shutil.copy2(src, tmp, follow_symlinks=False)
    st2 = tmp.lstat()
    if stat.S_ISLNK(st2.st_mode):
        try:
            tmp.unlink()
        except Exception:  # CONTRACT-EXEMPT: CODE-01.5 best-effort cleanup
            pass
        raise RuntimeError(f"refusing copied symlink (tmp): {tmp}")
    os.replace(tmp, dst)
    if dst.is_symlink():
        try:
            dst.unlink()
        except Exception:  # CONTRACT-EXEMPT: CODE-01.5 best-effort cleanup
            pass
        raise RuntimeError(f"refusing copied symlink (dst): {dst}")


def _cleanup_phase_workspace_outputs(*, outputs_root: Path, phase_id: str) -> bool:
    """Best-effort cleanup of copied outputs under ${WORKSPACE}/phases/<phase_id>/ (safe to delete)."""
    phase_dir = (outputs_root / str(phase_id)).resolve()
    try:
        phase_dir.relative_to(outputs_root.resolve())
    except Exception:  # CONTRACT-EXEMPT: CODE-01.5 deny-by-default path containment
        return False
    if not phase_dir.exists():
        return False
    try:
        shutil.rmtree(phase_dir)
        return True
    except Exception:  # CONTRACT-EXEMPT: CODE-01.5 best-effort cleanup
        return False


def _hash_script_candidates(*, project_dir: Path, argv: list[str]) -> dict[str, str]:
    """Best-effort: hash argv tokens that look like project-local script paths."""
    hashes: dict[str, str] = {}
    for tok in argv[:50]:
        s = str(tok).strip()
        if not s or s.startswith("-"):
            continue
        # Heuristic: treat as a path if it contains a separator and resolves to a file under project_dir.
        if "/" not in s and "\\" not in s:
            continue
        if "://" in s:
            continue
        cand = (project_dir / s).resolve()
        try:
            cand.relative_to(project_dir.resolve())
        except Exception:  # CONTRACT-EXEMPT: CODE-01.5 skip unresolvable paths
            continue
        if not cand.is_file():
            continue
        # Small allowlist to avoid hashing large binary outputs by accident.
        if cand.suffix.lower() not in {".py", ".sh", ".jl", ".m", ".wl", ".wls", ".json", ".toml", ".yaml", ".yml", ".txt"}:
            continue
        rel = os.fspath(cand.relative_to(project_dir)).replace(os.sep, "/")
        try:
            hashes[rel] = sha256_file(cand)
        except Exception:  # CONTRACT-EXEMPT: CODE-01.5 skip unhashable files
            continue
    return hashes


def _sanitize_argv_for_audit(*, argv: list[str], project_dir: Path, workspace_dir: Path) -> list[str]:
    """Return a stable argv view by replacing project/workspace absolute paths with placeholders."""
    out: list[str] = []
    proj_root = project_dir.resolve()
    ws_root = workspace_dir.resolve()
    for tok in argv:
        s = str(tok)
        try:
            p = Path(s)
        except Exception:  # CONTRACT-EXEMPT: CODE-01.5 diagnostic fallthrough
            out.append(s)
            continue
        if p.is_absolute():
            try:
                rel = p.resolve().relative_to(ws_root)
                out.append(f"<WORKSPACE>/{rel.as_posix()}")
                continue
            except Exception:  # CONTRACT-EXEMPT: CODE-01.5 diagnostic fallthrough
                pass
            try:
                rel = p.resolve().relative_to(proj_root)
                out.append(f"<PROJECT_DIR>/{rel.as_posix()}")
                continue
            except Exception:  # CONTRACT-EXEMPT: CODE-01.5 diagnostic fallthrough
                pass
        out.append(s)
    return out


def _load_or_init_phase_state(
    *,
    phase_state_path: Path,
    card: RunCardV2,
    project_dir: Path,
    workspace_dir: Path,
    resume: bool,
) -> dict[str, Any]:
    if phase_state_path.exists():
        if not resume:
            raise ValueError("workspace already has phase_state.json; use --resume or a new --run-id")
        st = read_json(phase_state_path)
        if not isinstance(st, dict):
            raise ValueError("phase_state.json must be a JSON object")
        # Refuse resume if the run identity changed (fail-fast, no silent mixing).
        if str(st.get("run_id") or "").strip() != str(card.normalized.get("run_id") or "").strip():
            raise ValueError("phase_state.json run_id mismatch (use a new --run-id)")
        prev_sha = st.get("run_card_sha256")
        cur_sha = sha256_json(card.raw)
        if isinstance(prev_sha, str) and prev_sha.strip() and prev_sha.strip() != cur_sha:
            raise ValueError("run_card differs from previous run in same workspace; use a new --run-id")
        return st

    # Fresh state
    phases = card.normalized.get("phases") or []
    phase_states: dict[str, Any] = {}
    for ph in phases:
        pid = str(ph.get("phase_id"))
        phase_states[pid] = {
            "status": "NOT_STARTED",
            "attempts": 0,
            "last_exit_code": None,
            "last_error": None,
            "updated_at": None,
        }
    st = {
        "schema_version": 1,
        "created_at": utc_now_iso().replace("+00:00", "Z"),
        "updated_at": utc_now_iso().replace("+00:00", "Z"),
        "run_id": str(card.normalized.get("run_id")),
        "workflow_id": "W_compute",
        "project_dir": os.fspath(project_dir),
        "workspace_dir": os.fspath(workspace_dir),
        "run_card_sha256": sha256_json(card.raw),
        "phases": phase_states,
        "run_status": "NOT_STARTED",
    }
    write_json(phase_state_path, st)
    return st


def _persist_phase_state(phase_state_path: Path, st: dict[str, Any]) -> None:
    st["updated_at"] = utc_now_iso().replace("+00:00", "Z")
    write_json(phase_state_path, st)


def w_compute_one(inps: WComputeInputs, repo_root: Path) -> dict[str, Any]:
    """Execute a declarative run_card v2 DAG and write SSOT artifacts under artifacts/runs/<tag>/w_compute/."""
    tag = str(inps.tag).strip()
    if not tag:
        raise ValueError("tag is required")

    project_dir = _resolve_project_dir(repo_root, str(inps.project_dir))
    run_card_path = _resolve_run_card_path(project_dir, str(inps.run_card))

    raw = load_run_card_v2(run_card_path)
    card = normalize_and_validate_run_card_v2(raw, run_id_override=tag, param_overrides=inps.params)

    trust = _require_trust_project(trust_project=bool(inps.trust_project))

    workspace_dir = (repo_root / "artifacts" / "runs" / tag / "w_compute").resolve()
    workspace_dir.mkdir(parents=True, exist_ok=True)
    _containment_check(root=(repo_root / "artifacts" / "runs").resolve(), path=workspace_dir, label="workspace_dir")

    # Snapshot the *effective* run_card for this run.
    run_card_snapshot_path = workspace_dir / "run_card.json"
    run_card_snapshot_path.write_text(
        json.dumps(card.normalized, indent=2, sort_keys=True, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )

    phase_state_path = workspace_dir / "phase_state.json"
    st = _load_or_init_phase_state(
        phase_state_path=phase_state_path,
        card=card,
        project_dir=project_dir,
        workspace_dir=workspace_dir,
        resume=bool(inps.resume),
    )
    st["trust"] = trust
    if isinstance(inps.gate_satisfied, dict):
        # Gate satisfaction is provided by the Orchestrator (A1–A5). Keep it out of the run-card SSOT.
        unknown = sorted({str(k).strip() for k in inps.gate_satisfied.keys() if str(k).strip()} - _VALID_GATES)
        if unknown:
            raise ValueError(f"unknown gate_satisfied keys (expected A1-A5): {unknown}")
        cleaned: dict[str, str] = {}
        bad: list[str] = []
        for k, v in inps.gate_satisfied.items():
            kk = str(k).strip()
            if not kk:
                continue
            if kk not in _VALID_GATES:
                continue
            if not isinstance(v, str):
                bad.append(f"{kk}: expected approval id string, got {type(v).__name__}")
                continue
            vv = v.strip()
            if not vv:
                bad.append(f"{kk}: empty approval id")
                continue
            if not vv.startswith(f"{kk}-"):
                bad.append(f"{kk}: approval id must start with '{kk}-' (got {vv!r})")
                continue
            if not _APPROVAL_ID_RE.match(vv):
                bad.append(f"{kk}: invalid approval id format: {vv!r}")
                continue
            cleaned[kk] = vv
        if bad:
            raise ValueError("invalid gate_satisfied values: " + "; ".join(bad))
        st["gate_satisfied"] = cleaned
    _persist_phase_state(phase_state_path, st)

    # Crash recovery: any RUNNING phase is treated as FAILED (v3 semantics).
    phases_state = st.get("phases") if isinstance(st.get("phases"), dict) else {}
    if isinstance(phases_state, dict):
        for pid, ps in phases_state.items():
            if not isinstance(ps, dict):
                continue
            if str(ps.get("status")) == "RUNNING":
                ps["status"] = "FAILED"
                ps["last_error"] = "crash recovery: phase was RUNNING at last checkpoint"
                ps["crash_recovered"] = True
                ps["crash_recovered_at"] = utc_now_iso().replace("+00:00", "Z")
                ps["updated_at"] = utc_now_iso().replace("+00:00", "Z")
    _persist_phase_state(phase_state_path, st)

    phases = card.normalized.get("phases") or []
    phase_by_id = {str(p.get("phase_id")): p for p in phases if isinstance(p, dict) and p.get("phase_id")}

    order = _toposort(phases)

    logs_dir = workspace_dir / "logs"
    outputs_root = workspace_dir / "phases"
    logs_dir.mkdir(parents=True, exist_ok=True)
    outputs_root.mkdir(parents=True, exist_ok=True)

    on_failure = str(card.normalized.get("on_failure") or "fail-fast")
    default_timeout = int(inps.default_timeout_seconds)

    run_errors: list[str] = []
    blocked: dict[str, Any] | None = None

    def dep_ok(dep_id: str) -> bool:
        ps = phases_state.get(dep_id) if isinstance(phases_state, dict) else None
        return isinstance(ps, dict) and str(ps.get("status")) == "SUCCEEDED"

    for pid in order:
        ph = phase_by_id.get(pid)
        if not isinstance(ph, dict):
            run_errors.append(f"internal error: missing phase {pid}")
            break

        ps = phases_state.get(pid) if isinstance(phases_state, dict) else None
        if not isinstance(ps, dict):
            ps = {"status": "NOT_STARTED", "attempts": 0}
            phases_state[pid] = ps

        # Dependency gating.
        deps = [str(d) for d in (ph.get("depends_on") or [])]
        if deps and not all(dep_ok(d) for d in deps):
            # If any deps are not succeeded, mark as SKIPPED for this run.
            ps["status"] = "SKIPPED"
            ps["skip_reason"] = "dependency_not_succeeded"
            ps["updated_at"] = utc_now_iso().replace("+00:00", "Z")
            _persist_phase_state(phase_state_path, st)
            continue

        # Phase gates (approval categories A1-A5).
        gates = [str(g) for g in (ph.get("gates") or []) if str(g).strip()]
        missing_gates = []
        for g in gates:
            sat = (st.get("gate_satisfied") or {}).get(g) if isinstance(st.get("gate_satisfied"), dict) else None
            if not isinstance(sat, str) or not sat.strip():
                missing_gates.append(g)
        if missing_gates:
            ps["status"] = "BLOCKED_BY_GATE"
            ps["missing_gates"] = missing_gates
            ps["updated_at"] = utc_now_iso().replace("+00:00", "Z")
            blocked = {"phase_id": pid, "missing_gates": missing_gates}
            _persist_phase_state(phase_state_path, st)
            break

        # Idempotent resume: skip if already succeeded.
        if str(ps.get("status")) == "SUCCEEDED":
            continue

        backend = ph.get("backend") if isinstance(ph.get("backend"), dict) else {}
        argv_tmpl = backend.get("argv") or []
        if not isinstance(argv_tmpl, list) or not argv_tmpl:
            run_errors.append(f"phase {pid}: missing backend.argv")
            ps["status"] = "FAILED"
            ps["last_error"] = "missing backend.argv"
            ps["updated_at"] = utc_now_iso().replace("+00:00", "Z")
            _persist_phase_state(phase_state_path, st)
            if on_failure == "fail-fast":
                break
            continue

        cwd_rel = str(backend.get("cwd") or ".")
        phase_cwd = (project_dir / cwd_rel).resolve()
        _containment_check(root=project_dir, path=phase_cwd, label=f"phase {pid} backend.cwd")

        # Validate declared inputs exist before execution (fail-fast with actionable diagnostics).
        # Convention: paths prefixed with "phases/<...>" resolve under ${WORKSPACE}; other relative paths resolve under ${PROJECT_DIR}.
        inputs_rel_list = [str(p) for p in (ph.get("inputs") or [])]
        missing_inputs: list[str] = []
        for rel in inputs_rel_list[:200]:
            s = str(rel).strip().replace("\\", "/")
            if not s:
                continue
            if s.startswith("phases/"):
                ip = (workspace_dir / s).resolve()
                _containment_check(root=workspace_dir, path=ip, label=f"phase {pid} input")
            else:
                ip = (project_dir / s).resolve()
                _containment_check(root=project_dir, path=ip, label=f"phase {pid} input")
            if not ip.exists():
                missing_inputs.append(s)
        if missing_inputs:
            ps["status"] = "FAILED"
            ps["last_exit_code"] = None
            ps["timed_out"] = False
            ps["last_error"] = "missing inputs: " + ", ".join(missing_inputs[:20])
            run_errors.append(f"phase {pid} failed: {ps['last_error']}")
            ps["updated_at"] = utc_now_iso().replace("+00:00", "Z")
            _persist_phase_state(phase_state_path, st)
            if on_failure == "fail-fast":
                break
            continue

        out_rel_list = [str(p) for p in (ph.get("outputs") or [])]
        if ps.get("crash_recovered") is True:
            cleared = _cleanup_phase_workspace_outputs(outputs_root=outputs_root, phase_id=pid)
            ps["crash_recovered_workspace_outputs_cleared"] = int(bool(cleared))
            ps.pop("crash_recovered", None)

        # Expand argv: params + upstream phases/ paths.
        argv = expand_argv([str(x) for x in argv_tmpl], param_values=card.param_values, workspace_dir=workspace_dir)
        argv_sanitized = _sanitize_argv_for_audit(argv=argv, project_dir=project_dir, workspace_dir=workspace_dir)

        timeout_seconds = backend.get("timeout_seconds")
        timeout = int(timeout_seconds) if isinstance(timeout_seconds, int) and timeout_seconds > 0 else default_timeout

        retries = int(ph.get("retries") or 0)

        # Best-effort provenance: hash project-local scripts referenced in argv.
        script_hashes = _hash_script_candidates(project_dir=project_dir, argv=argv)

        ok = False
        last_err: str | None = None
        last_exit: int | None = None
        last_timed_out = False

        attempt_invoke = 0
        while attempt_invoke <= retries:
            ps["status"] = "RUNNING"
            ps["attempts"] = int(ps.get("attempts") or 0) + 1
            ps["updated_at"] = utc_now_iso().replace("+00:00", "Z")
            _persist_phase_state(phase_state_path, st)

            t0 = time.time()
            try:
                cp = subprocess.run(
                    argv,
                    cwd=os.fspath(phase_cwd),
                    capture_output=True,
                    text=True,
                    timeout=float(timeout),
                    check=False,
                )
                last_exit = int(cp.returncode)
                last_timed_out = False
                stdout = cp.stdout or ""
                stderr = cp.stderr or ""
            except subprocess.TimeoutExpired as e:
                last_exit = 124
                last_timed_out = True
                stdout = (e.stdout or "") if isinstance(e.stdout, str) else ""
                stderr = (e.stderr or "") if isinstance(e.stderr, str) else ""
                last_err = f"timeout after {timeout}s"
            except Exception as e:
                last_exit = 126
                last_timed_out = False
                stdout = ""
                stderr = ""
                last_err = f"execution error: {e}"

            dt = time.time() - t0

            # Always write logs (even on failure) for audit and crash recovery.
            ph_log_dir = logs_dir / pid
            ph_log_dir.mkdir(parents=True, exist_ok=True)
            (ph_log_dir / "stdout.txt").write_text(stdout, encoding="utf-8", errors="replace")
            (ph_log_dir / "stderr.txt").write_text(stderr, encoding="utf-8", errors="replace")
            (ph_log_dir / "meta.json").write_text(
                json.dumps(
                    {
                        "argv_template": [str(x) for x in argv_tmpl],
                        "argv_expanded": argv,
                        "argv_expanded_sanitized": argv_sanitized,
                        "cwd_rel": cwd_rel.replace("\\", "/"),
                        "timeout_seconds": int(timeout),
                        "duration_seconds": float(dt),
                        "exit_code": int(last_exit),
                        "timed_out": bool(last_timed_out),
                        "script_sha256": script_hashes,
                    },
                    indent=2,
                    sort_keys=True,
                    ensure_ascii=False,
                )
                + "\n",
                encoding="utf-8",
            )

            if last_exit != 0:
                if last_err is None:
                    last_err = f"exit_code={last_exit}"
                attempt_invoke += 1
                if attempt_invoke <= retries:
                    continue
                break

            # Verify declared outputs exist and copy to workspace.
            missing_out: list[str] = []
            for rel in out_rel_list:
                src = (phase_cwd / rel).resolve()
                try:
                    src.relative_to(phase_cwd.resolve())
                except Exception:
                    missing_out.append(f"{rel} (escapes phase cwd)")
                    continue
                if not src.exists():
                    missing_out.append(rel)
                    continue
            if missing_out:
                last_err = "missing outputs: " + ", ".join(missing_out[:20])
                attempt_invoke += 1
                if attempt_invoke <= retries:
                    continue
                break

            # Copy outputs to workspace/phases/<phase_id>/...
            for rel in out_rel_list:
                src = (phase_cwd / rel).resolve()
                _containment_check(root=phase_cwd, path=src, label=f"phase {pid} output src")
                dst = (outputs_root / pid / rel).resolve()
                _containment_check(root=(outputs_root / pid).resolve(), path=dst, label=f"phase {pid} output dst")
                _safe_copy_file(src=src, dst=dst)

            ok = True
            last_err = None
            break

        if ok:
            ps["status"] = "SUCCEEDED"
            ps["last_exit_code"] = int(last_exit) if last_exit is not None else 0
            ps["timed_out"] = bool(last_timed_out)
            ps["last_error"] = None
        else:
            ps["status"] = "FAILED"
            ps["last_exit_code"] = int(last_exit) if last_exit is not None else None
            ps["timed_out"] = bool(last_timed_out)
            ps["last_error"] = last_err or "unknown failure"
            run_errors.append(f"phase {pid} failed: {ps['last_error']}")
            if on_failure == "fail-fast":
                ps["updated_at"] = utc_now_iso().replace("+00:00", "Z")
                _persist_phase_state(phase_state_path, st)
                break

        ps["updated_at"] = utc_now_iso().replace("+00:00", "Z")
        _persist_phase_state(phase_state_path, st)

    # Headline extraction + acceptance checks (best-effort even on partial runs).
    headlines_rows: list[dict[str, Any]] = []
    acceptance_rows: list[dict[str, Any]] = []
    eval_errors: list[str] = []

    hn = card.normalized.get("headline_numbers")
    if isinstance(hn, dict):
        rows, errs = extract_headline_numbers(workspace_dir=workspace_dir, headline_numbers=hn)
        headlines_rows = rows
        eval_errors.extend(errs)

    acc = card.normalized.get("acceptance")
    if isinstance(acc, dict):
        rows, errs = evaluate_acceptance_json_numeric_checks(workspace_dir=workspace_dir, acceptance=acc)
        acceptance_rows = rows
        eval_errors.extend(errs)

    # Overall status
    all_succeeded = True
    for pid in order:
        ps = phases_state.get(pid) if isinstance(phases_state, dict) else None
        if not isinstance(ps, dict) or str(ps.get("status")) != "SUCCEEDED":
            all_succeeded = False
            break

    status = "completed"
    if blocked is not None:
        status = "blocked_by_gate"
    elif run_errors or eval_errors or not all_succeeded:
        status = "failed"

    created_at = utc_now_iso().replace("+00:00", "Z")
    out_dir = workspace_dir
    manifest_path = out_dir / "manifest.json"
    summary_path = out_dir / "summary.json"
    analysis_path = out_dir / "analysis.json"
    report_path = out_dir / "report.md"

    cmd_str = "hepar run (W_compute)"
    if isinstance(inps.command_argv, list) and inps.command_argv:
        cmd_str = " ".join(shlex.quote(str(x)) for x in inps.command_argv if str(x).strip())

    manifest: dict[str, Any] = {
        "schema_version": 1,
        "created_at": created_at,
        "command": cmd_str,
        "cwd": manifest_cwd(repo_root=repo_root, cwd=repo_root),
        "params": {
            "run_id": tag,
            "workflow_id": "W_compute",
            "project_dir": _safe_rel(repo_root, project_dir),
            "run_card_path": _safe_rel(repo_root, run_card_path),
            "resume": int(bool(inps.resume)),
        },
        "versions": {"python": sys.version.split()[0]},
        "inputs": {
            "run_card_sha256": sha256_json(card.raw),
            "run_card_effective_sha256": sha256_json(card.normalized),
            "trust": trust,
        },
        # Filled after writing SSOT files (see below).
        "outputs": [],
    }
    git_meta = try_get_git_metadata(repo_root)
    if git_meta:
        manifest["git"] = git_meta

    summary: dict[str, Any] = {
        "schema_version": 1,
        "created_at": created_at,
        "definitions": {"workflow": "W_compute", "kind": "w_compute"},
        "stats": {
            "status": status,
            "errors": int(len(run_errors) + len(eval_errors)),
            "blocked": int(bool(blocked is not None)),
            "phases_total": int(len(order)),
            "phases_succeeded": int(sum(1 for pid in order if str((phases_state.get(pid) or {}).get("status")) == "SUCCEEDED")),
        },
        "outputs": {
            "artifact_dir": _safe_rel(repo_root, out_dir),
            "run_card_snapshot": _safe_rel(repo_root, run_card_snapshot_path),
            "phase_state": _safe_rel(repo_root, phase_state_path),
        },
    }

    analysis: dict[str, Any] = {
        "schema_version": 1,
        "created_at": created_at,
        "inputs": {
            "project_dir": _safe_rel(repo_root, project_dir),
            "workspace_dir": _safe_rel(repo_root, workspace_dir),
            "run_card_path": _safe_rel(repo_root, run_card_path),
            "run_card_sha256": sha256_json(card.raw),
            "params": card.param_values,
            "on_failure": on_failure,
            "trust": trust,
        },
        "results": {
            "status": status,
            "ok": bool(status == "completed" and not run_errors and not eval_errors),
            "errors": run_errors + eval_errors,
            "blocked": blocked,
            "phase_states": phases_state,
            "headline_numbers": headlines_rows,
            "acceptance_checks": acceptance_rows,
        },
    }

    write_json(manifest_path, manifest)
    write_json(summary_path, summary)
    write_json(analysis_path, analysis)

    # report.md is derived; write early, then finalize manifest.outputs from on-disk files and regenerate report.
    _ = write_artifact_report(repo_root=repo_root, artifact_dir=out_dir, manifest=manifest, summary=summary, analysis=analysis)

    outputs_list: list[str] = []
    for p in sorted(out_dir.rglob("*")):
        if p.is_file():
            outputs_list.append(_safe_rel(repo_root, p))
    manifest["outputs"] = outputs_list
    write_json(manifest_path, manifest)
    _ = write_artifact_report(repo_root=repo_root, artifact_dir=out_dir, manifest=manifest, summary=summary, analysis=analysis)

    return {
        "errors": run_errors + eval_errors,
        "artifact_paths": {
            "manifest": _safe_rel(repo_root, manifest_path),
            "summary": _safe_rel(repo_root, summary_path),
            "analysis": _safe_rel(repo_root, analysis_path),
            "report": _safe_rel(repo_root, report_path),
            "run_card": _safe_rel(repo_root, run_card_snapshot_path),
            "phase_state": _safe_rel(repo_root, phase_state_path),
        },
    }
