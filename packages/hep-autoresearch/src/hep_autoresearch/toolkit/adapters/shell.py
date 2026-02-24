from __future__ import annotations

import json
import os
import re
import shutil
import stat
import subprocess
import tempfile
import time
import uuid
from pathlib import Path
from typing import Any

from .artifacts import sha256_json, validate_adapter_artifacts, write_adapter_artifacts
from .base import Adapter, BackendKind, CollectResult, ExecuteResult, PrepareResult, VerifyResult


_DOCKER_IMAGE_SAFE_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._/@:-]{0,253}$")
_ENV_KEY_SAFE_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")
_ENV_VAL_UNSAFE_RE = re.compile(r"[\x00-\x1f]")
_SANDBOX_ENV_ALLOWLIST = frozenset(
    {
        # Locale / UI
        "LANG",
        "LC_ALL",
        "TZ",
        # Common execution
        "PATH",
        "PYTHONPATH",
        "PYTHONIOENCODING",
    }
)


def _truncate_text(s: str, *, max_chars: int) -> str:
    s = str(s)
    if len(s) <= max_chars:
        return s
    return s[: max(0, max_chars - 3)].rstrip() + "..."


# ─── C-02: Command / path validation ───

# Dangerous command patterns (matched against joined argv string).
_BLOCKED_COMMAND_PATTERNS: list[re.Pattern[str]] = [
    re.compile(r"\brm\s+(-[a-zA-Z]*r[a-zA-Z]*f|--force\s.*?--recursive|-[a-zA-Z]*f[a-zA-Z]*r)\s+/\s*$"),
    re.compile(r"\brm\s+-rf\s+/"),
    re.compile(r"\bcurl\b.*\|\s*\b(sh|bash|zsh)\b"),
    re.compile(r"\bwget\b.*\|\s*\b(sh|bash|zsh)\b"),
    re.compile(r"\bchmod\s+777\b"),
    re.compile(r"\bmkfs\b"),
    re.compile(r"\bdd\s+.*of=/dev/"),
    re.compile(r"\b:(){ :|:& };:"),  # fork bomb
]

# Sensitive paths that must never appear as write targets.
_SENSITIVE_PATHS: tuple[str, ...] = (
    "/etc/passwd",
    "/etc/shadow",
    "/etc/sudoers",
    "/etc/ssh",
    "/root/.ssh",
    "/dev/sda",
    "/dev/nvme",
    "/boot",
)


class UnsafeCommandError(ValueError):
    """Raised when a command fails safety validation."""


def _validate_command(argv: list[str]) -> None:
    """Reject argv lists containing known-dangerous patterns.

    Raises ``UnsafeCommandError`` with code ``BLOCKED_COMMAND`` on match.
    """
    joined = " ".join(argv)
    for pat in _BLOCKED_COMMAND_PATTERNS:
        if pat.search(joined):
            raise UnsafeCommandError(f"BLOCKED_COMMAND: command matches blocked pattern: {pat.pattern!r}")

    # Check for sensitive path references in any argument.
    for arg in argv:
        for sp in _SENSITIVE_PATHS:
            if sp in arg:
                raise UnsafeCommandError(f"UNSAFE_FS: argv references sensitive path: {sp}")


def _validate_output_paths(
    outputs: list[str | Path],
    *,
    repo_root: Path,
    data_dir: Path | None = None,
) -> None:
    """Ensure all output paths are within ``repo_root/`` or ``data_dir/``.

    Raises ``UnsafeCommandError`` with code ``UNSAFE_FS`` on violation.
    """
    allowed: list[Path] = [repo_root.resolve()]
    if data_dir is not None:
        allowed.append(data_dir.resolve())
    hep_data = os.environ.get("HEP_DATA_DIR")
    if hep_data:
        allowed.append(Path(hep_data).resolve())

    for p in outputs:
        resolved = Path(p).resolve()
        if not any(
            resolved == base or str(resolved).startswith(str(base) + os.sep) for base in allowed
        ):
            raise UnsafeCommandError(
                f"UNSAFE_FS: output path {str(resolved)!r} is outside allowed directories"
            )


# ─── C-02: ResourceLimiter (best-effort ulimit wrapper) ───

class ResourceLimiter:
    """Best-effort resource limits via ``ulimit``-style preexec.

    On non-Linux/macOS platforms, this is a no-op.
    """

    def __init__(
        self,
        *,
        cpu_seconds: int | None = None,
        mem_bytes: int | None = None,
        fsize_bytes: int | None = None,
    ) -> None:
        self.cpu_seconds = cpu_seconds
        self.mem_bytes = mem_bytes
        self.fsize_bytes = fsize_bytes

    def preexec_fn(self) -> None:
        """Intended for use as ``subprocess.Popen(preexec_fn=...)``."""
        try:
            import resource

            if self.cpu_seconds is not None:
                resource.setrlimit(resource.RLIMIT_CPU, (self.cpu_seconds, self.cpu_seconds))
            if self.fsize_bytes is not None:
                resource.setrlimit(resource.RLIMIT_FSIZE, (self.fsize_bytes, self.fsize_bytes))
            # macOS does not support RLIMIT_AS; use RLIMIT_RSS as a best-effort proxy.
            if self.mem_bytes is not None:
                try:
                    resource.setrlimit(resource.RLIMIT_AS, (self.mem_bytes, self.mem_bytes))
                except (ValueError, AttributeError):
                    try:
                        resource.setrlimit(resource.RLIMIT_RSS, (self.mem_bytes, self.mem_bytes))
                    except (ValueError, AttributeError):
                        pass
        except Exception:  # CONTRACT-EXEMPT: CODE-01.5 best-effort cleanup
            # Fail open — resource limits are best-effort hardening.
            pass


def _docker_daemon_available(*, timeout_seconds: float = 2.0) -> tuple[bool, str | None]:
    if shutil.which("docker") is None:
        return False, None
    try:
        cp = subprocess.run(
            ["docker", "info", "--format", "{{.ServerVersion}}"],
            capture_output=True,
            text=True,
            timeout=timeout_seconds,
            check=False,
        )
        if int(cp.returncode) != 0:
            return False, None
        ver = (cp.stdout or "").strip() or None
        return True, ver
    except Exception:  # CONTRACT-EXEMPT: CODE-01.5 intentional fallback
        return False, None


def _make_tree_read_only(root: Path) -> None:
    """Best-effort: remove write bits under root (does not follow symlinks)."""
    if not root.exists():
        return
    for dirpath, dirnames, filenames in os.walk(root):
        d = Path(dirpath)
        try:
            if d.is_symlink():
                dirnames[:] = []
                continue
        except Exception:  # CONTRACT-EXEMPT: CODE-01.5 best-effort symlink detection in tree walk
            pass

        # Prevent walking into symlinked dirs.
        kept: list[str] = []
        for name in dirnames:
            p = d / name
            try:
                if p.is_symlink():
                    continue
            except Exception:  # CONTRACT-EXEMPT: CODE-01.5 best-effort symlink detection in tree walk
                pass
            kept.append(name)
        dirnames[:] = kept

        for p in [d] + [d / n for n in filenames]:
            try:
                if p.is_symlink():
                    continue
            except Exception:  # CONTRACT-EXEMPT: CODE-01.5 best-effort symlink detection in tree walk
                pass
            try:
                st = p.stat()
                os.chmod(p, int(st.st_mode) & ~(stat.S_IWUSR | stat.S_IWGRP | stat.S_IWOTH))
            except Exception:  # CONTRACT-EXEMPT: CODE-01.5 best-effort chmod
                # Best-effort hardening only.
                continue


def _make_tree_writable(root: Path) -> None:
    """Best-effort: add user write bit under root (does not follow symlinks)."""
    if not root.exists():
        return
    for dirpath, dirnames, filenames in os.walk(root):
        d = Path(dirpath)
        try:
            if d.is_symlink():
                dirnames[:] = []
                continue
        except Exception:  # CONTRACT-EXEMPT: CODE-01.5 best-effort symlink detection in tree walk
            pass

        kept: list[str] = []
        for name in dirnames:
            p = d / name
            try:
                if p.is_symlink():
                    continue
            except Exception:  # CONTRACT-EXEMPT: CODE-01.5 best-effort symlink detection in tree walk
                pass
            kept.append(name)
        dirnames[:] = kept

        for p in [d] + [d / n for n in filenames]:
            try:
                if p.is_symlink():
                    continue
            except Exception:  # CONTRACT-EXEMPT: CODE-01.5 best-effort symlink detection in tree walk
                pass
            try:
                st = p.stat()
                os.chmod(p, int(st.st_mode) | stat.S_IWUSR)
            except Exception:  # CONTRACT-EXEMPT: CODE-01.5 best-effort chmod
                continue


def _copy_staged_outputs(*, staged_dir: Path, dest_dir: Path) -> tuple[int, list[str]]:
    """Copy staged outputs back into dest_dir, skipping SSOT files owned by the adapter."""
    if not staged_dir.exists() or not staged_dir.is_dir():
        return 0, []

    try:
        staged_root = staged_dir.resolve()
    except Exception:  # CONTRACT-EXEMPT: CODE-01.5 diagnostic fallthrough
        staged_root = staged_dir

    copied: list[str] = []
    skipped_names = {"manifest.json", "summary.json", "analysis.json", "report.md", "run_card.json"}
    for p in sorted(staged_dir.rglob("*")):
        # Defense-in-depth: refuse any source path that resolves outside staged_dir
        # (e.g., via a symlinked directory). local_copy is not a security boundary,
        # but we still avoid copying arbitrary files into real artifacts.
        try:
            p.resolve().relative_to(staged_root)
        except Exception:  # CONTRACT-EXEMPT: CODE-01.5 skip unresolvable paths
            continue
        try:
            st = p.lstat()
        except Exception:  # CONTRACT-EXEMPT: CODE-01.5 skip unreadable files
            continue
        if stat.S_ISLNK(st.st_mode):
            continue
        if not stat.S_ISREG(st.st_mode):
            continue
        rel = p.relative_to(staged_dir)
        rel_posix = rel.as_posix()
        if rel_posix.startswith("logs/"):
            # Logs are owned by the adapter and written in the real artifact_dir after execute().
            # Skip any sandbox-produced logs to avoid mixing outputs and copying unexpected large files.
            continue
        if rel.name in skipped_names:
            continue
        out = dest_dir / rel
        out.parent.mkdir(parents=True, exist_ok=True)
        tmp = out.parent / f".tmp_copy_{uuid.uuid4().hex}_{rel.name}"
        try:
            # Best-effort hardening: local_copy is not a security boundary, but we refuse symlinks
            # to avoid copying link targets from the sandbox into real artifacts.
            shutil.copy2(p, tmp, follow_symlinks=False)
            # Refuse symlinks in the destination even under TOCTOU (avoid copying link targets).
            try:
                tmp_st = tmp.lstat()
                if stat.S_ISLNK(tmp_st.st_mode):
                    tmp.unlink()
                    raise RuntimeError(
                        f"sandbox staged output is a symlink (refusing copy): {rel_posix}"
                    )
            except OSError:
                # tmp removed between copy and check; treat as "not copied".
                continue
            os.replace(tmp, out)
            # NOTE: This check is TOCTOU-vulnerable and cannot prevent a determined attacker.
            # It exists only to catch accidental symlink creation during copy-back.
            if out.is_symlink():
                out.unlink()
                raise RuntimeError(
                    f"sandbox staged output became a symlink (refusing copy): {rel_posix}"
                )
        except Exception as e:
            try:
                if tmp.exists():
                    tmp.unlink()
            except Exception:  # CONTRACT-EXEMPT: CODE-01.5 best-effort cleanup
                pass
            if isinstance(e, RuntimeError):
                raise
            continue
        copied.append(rel_posix)
    return len(copied), copied


def _rmtree_force(root: Path) -> tuple[bool, str | None]:
    def _onerror(func, path: str, exc_info) -> None:
        try:
            os.chmod(path, stat.S_IRWXU)
            func(path)
        except Exception:  # CONTRACT-EXEMPT: CODE-01.5 cleanup before re-raise
            # Re-raise to avoid silently leaving a partially-deleted sandbox tree on disk.
            exctype, value, tb = exc_info
            raise value.with_traceback(tb)

    err: str | None = None
    try:
        shutil.rmtree(root, onerror=_onerror)
    except Exception as e:
        err = str(e)
    ok = False
    try:
        ok = not root.exists()
    except Exception:  # CONTRACT-EXEMPT: CODE-01.5 intentional fallback
        ok = False
    return ok, err


class ShellAdapter(Adapter):
    @property
    def adapter_id(self) -> str:
        return "shell"

    @property
    def backend_kind(self) -> BackendKind:
        return "shell"

    def prepare(self, run_card: dict[str, Any], state: dict[str, Any], *, repo_root: Path, force: bool) -> PrepareResult:
        run_id = str(run_card.get("run_id") or state.get("run_id") or "").strip()
        workflow_id = str(run_card.get("workflow_id") or state.get("workflow_id") or "").strip()
        step_dir = str(run_card.get("artifact_step") or "adapter_shell").strip()
        if not run_id:
            raise ValueError("run_card.run_id is required")
        if not workflow_id:
            raise ValueError("run_card.workflow_id is required")
        if not step_dir:
            raise ValueError("run_card.artifact_step must be a non-empty string")
        if "/" in run_id or "\\" in run_id or ".." in run_id:
            raise ValueError(f"run_id must not contain path separators or '..': {run_id!r}")
        if "/" in step_dir or "\\" in step_dir or ".." in step_dir:
            raise ValueError(f"artifact_step must not contain path separators or '..': {step_dir!r}")

        artifact_dir = repo_root / "artifacts" / "runs" / run_id / step_dir
        artifact_dir.mkdir(parents=True, exist_ok=True)
        try:
            artifact_dir.resolve().relative_to((repo_root / "artifacts" / "runs").resolve())
        except Exception as e:
            raise ValueError(f"artifact_dir must be under artifacts/runs/: {artifact_dir}") from e
        run_card_path = artifact_dir / "run_card.json"
        run_card_path.write_text(json.dumps(run_card, indent=2, sort_keys=True, ensure_ascii=False) + "\n", encoding="utf-8")
        run_card_sha = sha256_json(run_card)

        required_gates_raw = run_card.get("required_gates")
        if required_gates_raw is None:
            required_gates = ()
        elif isinstance(required_gates_raw, list):
            required_gates = tuple(str(x) for x in required_gates_raw if isinstance(x, str) and x.strip())
        else:
            raise ValueError("run_card.required_gates must be a list of strings (or omitted)")

        backend = run_card.get("backend") if isinstance(run_card.get("backend"), dict) else {}
        sandbox = backend.get("sandbox") if isinstance(backend.get("sandbox"), dict) else None
        if isinstance(sandbox, dict):
            if "enabled" not in sandbox:
                raise ValueError("backend.sandbox present but 'enabled' key missing; explicit opt-in required")
            if bool(sandbox.get("enabled")):
                provider = str(sandbox.get("provider") or "auto").strip().lower()
                if provider in {"none", "off", "false", "0"}:
                    raise ValueError(
                        "backend.sandbox.enabled=true requires sandbox.provider to be auto/local_copy/docker (not 'none')"
                    )
                net = str(sandbox.get("network") or "disabled").strip().lower()
                if net not in {"disabled", "none", "host"}:
                    raise ValueError(f"sandbox.network must be disabled/none/host, got {net!r}")
                if net not in {"disabled", "none"}:
                    required_gates = tuple(sorted(set(required_gates) | {"A1"}))

        # Idempotence: if already completed with the same run-card hash, skip unless forced.
        analysis_path = artifact_dir / "analysis.json"
        if analysis_path.exists() and not force:
            try:
                payload = __import__("json").loads(analysis_path.read_text(encoding="utf-8"))
                prev_sha = ((payload.get("inputs") or {}).get("run_card_sha256") if isinstance(payload, dict) else None)
                prev_status = ((payload.get("results") or {}).get("status") if isinstance(payload, dict) else None)
                if prev_sha == run_card_sha and prev_status == "completed":
                    return PrepareResult(
                        artifact_dir=artifact_dir,
                        required_gates=required_gates,
                        run_card=run_card,
                        run_card_path=run_card_path,
                        run_card_sha256=run_card_sha,
                        skip_execute=True,
                        skip_reason="already completed with same run-card",
                    )
                if prev_sha and prev_sha != run_card_sha:
                    raise ValueError("run-card differs from previous run in same directory; use a new --run-id or --force")
            except Exception:  # CONTRACT-EXEMPT: CODE-01.5 multi-strategy fallthrough
                # Fall through to execute; prepare is best-effort.
                pass

        return PrepareResult(
            artifact_dir=artifact_dir,
            required_gates=required_gates,
            run_card=run_card,
            run_card_path=run_card_path,
            run_card_sha256=run_card_sha,
        )

    def execute(self, prep: PrepareResult, state: dict[str, Any], *, repo_root: Path) -> ExecuteResult:
        backend = prep.run_card.get("backend") or {}
        argv = backend.get("argv")
        if not isinstance(argv, list) or not argv or not all(isinstance(x, str) and x for x in argv):
            raise ValueError("run_card.backend.argv must be a non-empty string list")

        # C-02: validate command before execution
        _validate_command(argv)

        cwd = backend.get("cwd")
        cwd_path = Path(cwd) if isinstance(cwd, str) and cwd else repo_root
        if not cwd_path.is_absolute():
            cwd_path = repo_root / cwd_path

        env_cfg = backend.get("env") if isinstance(backend.get("env"), dict) else {}
        env = os.environ.copy()
        for k, v in env_cfg.items():
            if isinstance(k, str) and isinstance(v, str):
                env[k] = v

        sandbox = backend.get("sandbox") if isinstance(backend.get("sandbox"), dict) else None
        if isinstance(sandbox, dict):
            if "enabled" not in sandbox:
                raise ValueError("backend.sandbox present but 'enabled' key missing; explicit opt-in required")
            sandbox_enabled = bool(sandbox.get("enabled"))
        else:
            sandbox_enabled = False
        sandbox_provider = str(sandbox.get("provider") or "auto").strip().lower() if isinstance(sandbox, dict) else "none"
        sandbox_network = str(sandbox.get("network") or "disabled").strip().lower() if isinstance(sandbox, dict) else "disabled"
        sandbox_repo_read_only = bool(sandbox.get("repo_read_only", True)) if isinstance(sandbox, dict) else True
        sandbox_docker_image = str(sandbox.get("docker_image") or "").strip() if isinstance(sandbox, dict) else ""
        if sandbox_enabled and sandbox_network not in {"disabled", "none", "host"}:
            raise ValueError(f"sandbox.network must be disabled/none/host, got {sandbox_network!r}")
        if sandbox_enabled and sandbox_network not in {"disabled", "none"} and "A1" not in prep.required_gates:
            raise ValueError("sandbox network policy requires A1 gate (missing from required_gates)")
        if sandbox_enabled and sandbox_provider in {"none", "off", "false", "0"}:
            raise ValueError("backend.sandbox.enabled=true requires sandbox.provider to be auto/local_copy/docker (not 'none')")

        timeout_seconds = None
        budgets = prep.run_card.get("budgets") if isinstance(prep.run_card.get("budgets"), dict) else {}
        if isinstance(budgets, dict) and budgets.get("timeout_seconds") is not None:
            timeout_seconds = float(budgets["timeout_seconds"])

        logs_dir = prep.artifact_dir / "logs"
        logs_dir.mkdir(parents=True, exist_ok=True)
        stdout_path = logs_dir / "stdout.txt"
        stderr_path = logs_dir / "stderr.txt"

        started = time.time()
        timed_out = False
        exit_code: int | None = None
        stdout = ""
        stderr = ""
        errors: list[str] = []
        sandbox_details: dict[str, Any] = {}
        if sandbox_enabled:
            sandbox_details.update(
                {
                "requested_provider": sandbox_provider,
                "network_policy": sandbox_network,
                "repo_read_only": bool(sandbox_repo_read_only),
                "resolved_provider": None,
                "fallback_reason": None,
                }
            )
        try:
            if not sandbox_enabled:
                cp = subprocess.run(
                    argv,
                    cwd=os.fspath(cwd_path),
                    env=env,
                    capture_output=True,
                    text=True,
                    timeout=timeout_seconds,
                    check=False,
                )
                exit_code = int(cp.returncode)
                stdout = cp.stdout or ""
                stderr = cp.stderr or ""
            else:
                # Sandbox: prefer docker when available; fallback to local_copy (best-effort isolation).
                provider = sandbox_provider
                docker_ok, docker_ver = _docker_daemon_available()
                sandbox_details.update(
                    {
                        "requested_provider": provider,
                        "docker_daemon_available": bool(docker_ok),
                        "docker_server_version": docker_ver,
                        "network_policy": sandbox_network,
                        "repo_read_only": bool(sandbox_repo_read_only),
                    }
                )
                fallback_reason: str | None = None
                if provider == "auto" and not docker_ok:
                    fallback_reason = "docker daemon unavailable"
                resolved_provider = provider
                if provider in {"auto", "docker"} and docker_ok:
                    resolved_provider = "docker"
                elif provider in {"auto", "local_copy"}:
                    resolved_provider = "local_copy"
                elif provider == "docker" and not docker_ok:
                    sandbox_details.update(
                        {
                            "resolved_provider": "unresolved",
                            "fallback_reason": "docker daemon unavailable; explicit provider=docker cannot fall back",
                        }
                    )
                    raise RuntimeError("sandbox provider docker requested but docker daemon is not available")
                else:
                    # Unknown provider: fail fast (explicit config).
                    sandbox_details.update({"resolved_provider": "unresolved", "fallback_reason": f"unknown provider: {provider!r}"})
                    raise ValueError(f"unknown sandbox provider: {provider!r}")

                sandbox_details.update({"resolved_provider": resolved_provider, "fallback_reason": fallback_reason})

                if not cwd_path.resolve().is_relative_to(repo_root.resolve()):
                    raise ValueError("sandboxed shell adapter requires backend.cwd to be within repo_root")

                env2 = dict(env)
                env2.setdefault("PYTHONDONTWRITEBYTECODE", "1")
                env2["HEP_AUTORESEARCH_SANDBOX"] = "1"
                env2["HEP_AUTORESEARCH_SANDBOX_PROVIDER"] = resolved_provider
                env2["HEP_AUTORESEARCH_SANDBOX_NETWORK"] = sandbox_network

                if resolved_provider == "docker":
                    if not sandbox_repo_read_only:
                        raise ValueError("invalid sandbox config: provider=docker requires sandbox.repo_read_only=true")
                    image = sandbox_docker_image or "python:3.11-slim"
                    if not _DOCKER_IMAGE_SAFE_RE.match(image) or any(ch.isspace() for ch in image):
                        raise ValueError(f"sandbox.docker_image contains invalid characters: {image!r}")
                    rel_cwd = cwd_path.resolve().relative_to(repo_root.resolve())
                    workdir = "/" + "/".join(["repo"] + list(rel_cwd.parts)) if rel_cwd.parts else "/repo"
                    # Use on-disk artifact_dir names (canonical) to avoid any run-card normalization drift.
                    run_id = str(prep.artifact_dir.parent.name)
                    step_dir = str(prep.artifact_dir.name)
                    if not run_id:
                        raise ValueError("missing run_id for sandbox artifacts mount")
                    if not step_dir:
                        raise ValueError("missing artifact_step for sandbox artifacts mount")
                    if "/" in run_id or "\\" in run_id or ".." in run_id:
                        raise ValueError(f"run_id must not contain path separators or '..': {run_id!r}")
                    if "/" in step_dir or "\\" in step_dir or ".." in step_dir:
                        raise ValueError(f"artifact_step must not contain path separators or '..': {step_dir!r}")
                    artifact_mount_dst = f"/repo/artifacts/runs/{run_id}/{step_dir}"
                    docker_cmd: list[str] = [
                        "docker",
                        "run",
                        "--rm",
                        "--network",
                        "none" if sandbox_network in {"disabled", "none"} else "host",
                        "--workdir",
                        workdir,
                        "--mount",
                        f"type=bind,src={repo_root.resolve()},dst=/repo,readonly",
                        "--mount",
                        f"type=bind,src={prep.artifact_dir.resolve()},dst={artifact_mount_dst}",
                    ]
                    docker_warnings: list[str] = []
                    if hasattr(os, "getuid") and hasattr(os, "getgid"):
                        try:
                            docker_cmd.extend(["--user", f"{os.getuid()}:{os.getgid()}"])
                        except Exception as e:
                            docker_warnings.append(f"could not set docker --user; container may run as root: {e}")
                    forward_env_keys: set[str] = set()
                    if isinstance(sandbox, dict):
                        raw = sandbox.get("forward_env_keys")
                        if raw is not None:
                            if not isinstance(raw, list) or not all(isinstance(x, str) and x.strip() for x in raw):
                                raise ValueError("sandbox.forward_env_keys must be a list of strings (or omitted)")
                            forward_env_keys = {str(x).strip() for x in raw if str(x).strip()}
                    for fk in sorted(forward_env_keys):
                        if any(s in fk.upper() for s in ("SECRET", "TOKEN", "PASSWORD", "CREDENTIAL", "API_KEY", "PRIVATE")):
                            docker_warnings.append(f"forward_env_keys includes potential secret key: {fk}")

                    allowed_env_keys = set(_SANDBOX_ENV_ALLOWLIST) | set(forward_env_keys)
                    env_container: dict[str, str] = {}
                    for k, v in env2.items():
                        if isinstance(k, str) and isinstance(v, str) and k in allowed_env_keys:
                            env_container[k] = v
                    for k in [
                        "PYTHONDONTWRITEBYTECODE",
                        "HEP_AUTORESEARCH_SANDBOX",
                        "HEP_AUTORESEARCH_SANDBOX_PROVIDER",
                        "HEP_AUTORESEARCH_SANDBOX_NETWORK",
                    ]:
                        if k in env2 and isinstance(env2[k], str):
                            env_container[k] = str(env2[k])
                    for k, v in env_container.items():
                        if not _ENV_KEY_SAFE_RE.match(k) or _ENV_VAL_UNSAFE_RE.search(v):
                            raise ValueError(f"unsafe environment variable for sandbox: {k!r}")
                        docker_cmd.extend(["-e", f"{k}={v}"])
                    docker_cmd.append(image)
                    docker_cmd.extend(argv)
                    docker_env = {"PATH": os.environ.get("PATH", "")}
                    cp = subprocess.run(
                        docker_cmd,
                        cwd=os.fspath(repo_root),
                        env=docker_env,
                        capture_output=True,
                        text=True,
                        timeout=timeout_seconds,
                        check=False,
                    )
                    exit_code = int(cp.returncode)
                    stdout = cp.stdout or ""
                    stderr = cp.stderr or ""
                    sandbox_details.update(
                        {
                            "provider": "docker",
                            "docker_image": image,
                            "network_effective": "disabled" if sandbox_network in {"disabled", "none"} else "host",
                            "network_enforced": True,
                            "repo_mount": {"src": os.fspath(repo_root.resolve()), "dst": "/repo", "read_only": True},
                            "artifacts_mount": {
                                "src": os.fspath(prep.artifact_dir.resolve()),
                                "dst": artifact_mount_dst,
                                "read_only": False,
                            },
                            "workdir": workdir,
                            "docker_argv": docker_cmd,
                            "warnings": docker_warnings,
                        }
                    )
                else:
                    sandbox_root = Path(tempfile.mkdtemp(prefix="hep-autoresearch-sandbox-"))
                    sandbox_details.update({"provider": "local_copy"})
                    try:
                        sandbox_repo = sandbox_root / "repo"
                        sandbox_artifacts = sandbox_root / "artifacts"
                        ignore = shutil.ignore_patterns(
                            ".git",
                            ".env",
                            ".env.*",
                            "*.env",
                            "*.env.*",
                            ".envrc",
                            ".direnv",
                            "artifacts",
                            ".autoresearch",
                            "__pycache__",
                            ".pytest_cache",
                            ".mypy_cache",
                            ".ruff_cache",
                            ".venv",
                            "node_modules",
                            "dist",
                            "build",
                        )
                        shutil.copytree(repo_root, sandbox_repo, ignore=ignore, dirs_exist_ok=True)
                        sandbox_artifacts.mkdir(parents=True, exist_ok=True)
                        # Keep relative "artifacts/..." paths working inside the sandboxed repo.
                        try:
                            (sandbox_repo / "artifacts").symlink_to(sandbox_artifacts, target_is_directory=True)
                        except Exception as e:
                            raise RuntimeError(f"failed to create artifacts symlink in sandbox: {e}") from e

                        if sandbox_repo_read_only:
                            # NOTE: we must create the artifacts symlink *before* making the tree read-only,
                            # otherwise symlink creation would fail.
                            _make_tree_read_only(sandbox_repo)

                        rel_cwd = cwd_path.resolve().relative_to(repo_root.resolve())
                        sandbox_cwd = sandbox_repo / rel_cwd
                        sandbox_cwd.mkdir(parents=True, exist_ok=True)

                        cp = subprocess.run(
                            argv,
                            cwd=os.fspath(sandbox_cwd),
                            env=env2,
                            capture_output=True,
                            text=True,
                            timeout=timeout_seconds,
                            check=False,
                        )
                        exit_code = int(cp.returncode)
                        stdout = cp.stdout or ""
                        stderr = cp.stderr or ""

                        # Copy back staged outputs under this adapter's artifact_dir.
                        rel_artifact = prep.artifact_dir.resolve().relative_to(repo_root.resolve())
                        staged_artifact_dir = sandbox_repo / rel_artifact
                        try:
                            staged_artifact_dir.resolve().relative_to(sandbox_root.resolve())
                        except Exception as e:
                            raise RuntimeError(
                                f"staged_artifact_dir escapes sandbox_root (refusing copy): {os.fspath(staged_artifact_dir)}"
                            ) from e
                        copied_n, copied = _copy_staged_outputs(staged_dir=staged_artifact_dir, dest_dir=prep.artifact_dir)

                        sandbox_details.update(
                            {
                            "network_policy": sandbox_network,
                            "network_effective": "inherit",
                            "network_enforced": False,
                            "repo_read_only": bool(sandbox_repo_read_only),
                            "cwd_rel": str(rel_cwd).replace("\\", "/"),
                            "copied_outputs": {"count": int(copied_n), "files": copied[:200]},
                            }
                        )
                    finally:
                        # Restore writability before cleanup (rmtree needs write permission on parent dirs).
                        _make_tree_writable(sandbox_root)
                        cleanup_ok, cleanup_err = _rmtree_force(sandbox_root)
                        sandbox_details["cleanup"] = {"ok": bool(cleanup_ok), "error": cleanup_err}
                        if not cleanup_ok:
                            errors.append(
                                f"sandbox cleanup failed (residual sandbox left on disk at {sandbox_root}): "
                                f"{cleanup_err or '(unknown)'}"
                            )
        except subprocess.TimeoutExpired as e:
            timed_out = True
            exit_code = None
            stdout = (e.stdout or "") if isinstance(e.stdout, str) else ""
            stderr = (e.stderr or "") if isinstance(e.stderr, str) else ""
            errors.append("timeout")
        except Exception as e:
            errors.append(f"shell execution error: {e}")
        duration = time.time() - started

        stdout_path.write_text(stdout, encoding="utf-8", errors="replace")
        stderr_path.write_text(stderr, encoding="utf-8", errors="replace")

        stdout_preview = _truncate_text(stdout, max_chars=400) if stdout else ""
        stderr_preview = _truncate_text(stderr, max_chars=400) if stderr else ""

        if sandbox_enabled and sandbox_details.get("resolved_provider") is None:
            sandbox_details["resolved_provider"] = "unresolved"
            errors.append("sandbox resolved_provider was not set (sandbox setup failed before provider resolution)")

        ok = (exit_code == 0) and (not timed_out) and (not errors)
        provenance = {
            "call_kind": "shell",
            "argv": argv,
            "cwd": os.fspath(cwd_path),
            "timeout_seconds": timeout_seconds,
        }
        if sandbox_enabled:
            provenance["sandbox"] = {
                "enabled": True,
                "provider": sandbox_provider,
                "network_policy": sandbox_network,
                "repo_read_only": bool(sandbox_repo_read_only),
                "docker_image": sandbox_docker_image or None,
                "resolved": sandbox_details or {"provider": "unknown"},
            }

        return ExecuteResult(
            ok=bool(ok),
            exit_code=exit_code,
            timed_out=bool(timed_out),
            duration_seconds=float(duration),
            stdout_path=stdout_path,
            stderr_path=stderr_path,
            stdout_preview=stdout_preview,
            stderr_preview=stderr_preview,
            provenance=provenance,
            errors=errors,
        )

    def collect(
        self,
        prep: PrepareResult,
        exec_result: ExecuteResult | None,
        state: dict[str, Any],
        *,
        repo_root: Path,
        status: str,
    ) -> CollectResult:
        params = {
            "workflow_id": str(prep.run_card.get("workflow_id")),
            "run_id": str(prep.run_card.get("run_id")),
            "adapter_id": self.adapter_id,
            "artifact_step": str(prep.run_card.get("artifact_step") or "adapter_shell"),
        }
        command = " ".join([str(x) for x in (prep.run_card.get("orchestrator_command") or [])]) or "python3 scripts/orchestrator.py run"

        exec_payload = None
        errors: list[str] = []
        provenance = None
        if exec_result is not None:
            errors.extend(exec_result.errors)
            provenance = exec_result.provenance
            exec_payload = {
                "ok": bool(exec_result.ok),
                "exit_code": exec_result.exit_code,
                "timed_out": bool(exec_result.timed_out),
                "duration_seconds": exec_result.duration_seconds,
                "stdout_preview": exec_result.stdout_preview,
                "stderr_preview": exec_result.stderr_preview,
            }

        artifact_paths = write_adapter_artifacts(
            repo_root=repo_root,
            artifact_dir=prep.artifact_dir,
            command=str(command),
            params=params,
            run_card_path=prep.run_card_path,
            run_card_sha256=prep.run_card_sha256,
            required_gates=prep.required_gates,
            backend_kind=self.backend_kind,
            provenance=provenance,
            exec_result=exec_payload,
            errors=errors,
            status=status,
            gate_resolution_mode=(str(prep.run_card.get("gate_resolution_mode")) if isinstance(prep.run_card.get("gate_resolution_mode"), str) else None),
            gate_resolution_trace=(prep.run_card.get("gate_resolution_trace") if isinstance(prep.run_card.get("gate_resolution_trace"), list) else None),
        )

        return CollectResult(artifact_dir=prep.artifact_dir, artifact_paths=artifact_paths, errors=errors)

    def verify(self, collected: CollectResult, state: dict[str, Any], *, repo_root: Path) -> VerifyResult:
        errors = validate_adapter_artifacts(repo_root=repo_root, artifact_dir=collected.artifact_dir)
        ok = not errors
        msgs = ["PASS"] if ok else errors
        return VerifyResult(ok=ok, messages=msgs)
