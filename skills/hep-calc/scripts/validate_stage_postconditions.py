#!/usr/bin/env python3
from __future__ import annotations

import argparse
import base64
import errno
import hashlib
import json
import math
import os
import stat
import sys
from collections import Counter
from datetime import datetime, timezone
from decimal import Decimal
from pathlib import Path
from typing import Any


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _absolute_parts(path: Path) -> tuple[str, ...]:
    absolute = Path(os.path.abspath(os.fspath(path)))
    if not absolute.is_absolute():  # pragma: no cover - os.path.abspath guarantees this
        raise ValueError("path_not_absolute")
    return absolute.parts


def _open_directory_secure(path: Path, *, create: bool = False) -> int:
    """Open a directory without following a symlink in any path component."""
    parts = _absolute_parts(path)
    fd = os.open(parts[0], os.O_RDONLY | os.O_DIRECTORY)
    try:
        for component in parts[1:]:
            flags = os.O_RDONLY | os.O_DIRECTORY | getattr(os, "O_NOFOLLOW", 0)
            try:
                child_fd = os.open(component, flags, dir_fd=fd)
            except FileNotFoundError:
                if not create:
                    raise
                os.mkdir(component, mode=0o755, dir_fd=fd)
                child_fd = os.open(component, flags, dir_fd=fd)
            os.close(fd)
            fd = child_fd
        return fd
    except Exception:
        os.close(fd)
        raise


_RUNNER_DIRECTORIES = (
    "logs",
    "inputs",
    "meta",
    "symbolic",
    "numeric",
    "tex",
    "report",
    "feynarts_formcalc",
    "auto_qft",
    "auto_qft/feynarts_model",
    "auto_qft/diagrams",
    "auto_qft/amplitude",
    "auto_qft/model_build",
    "auto_qft/model_build/tex_preprocess",
    "auto_qft/formcalc",
)

_RUNNER_LOGS = (
    "logs/run_hep_calc.log",
    "logs/env_check.log",
    "logs/fa_fc.log",
    "logs/auto_qft.log",
    "logs/formcalc_reducer.log",
    "logs/tex_model_preprocess.log",
    "logs/mma.log",
    "logs/julia.log",
    "logs/compare_tex.log",
    "logs/generate_report.log",
)

_RUNNER_STALE_ACCEPTANCE_PATHS = (
    "symbolic/symbolic.json",
    "symbolic/status.json",
    "auto_qft/status.json",
    "auto_qft/summary.json",
    "auto_qft/producer_status.json",
    "auto_qft/model_build/status.json",
    "auto_qft/model_build/summary.json",
    "auto_qft/formcalc/handoff.json",
    "auto_qft/formcalc/status.json",
    "auto_qft/formcalc/job_snapshot.json",
    "auto_qft/formcalc/input_snapshot.m",
    "auto_qft/formcalc/.input_snapshot.m.tmp",
    "auto_qft/amplitude/amps_raw.m",
    "auto_qft/amplitude/amp_terms.m",
    "auto_qft/amplitude/.amplitude_summed.m.tmp",
    "auto_qft/amplitude/amplitude_summed.m",
    "auto_qft/amplitude/amplitude_summed.md",
    "auto_qft/amplitude/amplitude_summed.tex",
    "summary.json",
    "analysis.json",
    "manifest.json",
    "report/audit_report.md",
)


def _unlink_relative_secure(root: Path, relative: str) -> bool:
    relative_path = Path(relative)
    if relative_path.is_absolute() or ".." in relative_path.parts:
        raise ValueError("unsafe_relative_path")
    try:
        parent_fd = _open_directory_secure(root / relative_path.parent)
    except FileNotFoundError:
        return False
    try:
        try:
            os.unlink(relative_path.name, dir_fd=parent_fd)
        except FileNotFoundError:
            return False
        except IsADirectoryError as exc:
            raise OSError(errno.EISDIR, "refusing_to_unlink_directory", relative) from exc
        return True
    finally:
        os.close(parent_fd)


def _validate_tree_no_links(directory_fd: int, relative: Path = Path(".")) -> None:
    """Reject every symlink or special file already present below an output root."""
    with os.scandir(directory_fd) as entries:
        for entry in entries:
            entry_relative = relative / entry.name
            if entry.is_symlink():
                raise OSError(errno.ELOOP, "refusing_existing_symlink", entry_relative.as_posix())
            if entry.is_dir(follow_symlinks=False):
                flags = os.O_RDONLY | os.O_DIRECTORY | getattr(os, "O_NOFOLLOW", 0)
                child_fd = os.open(entry.name, flags, dir_fd=directory_fd)
                try:
                    _validate_tree_no_links(child_fd, entry_relative)
                finally:
                    os.close(child_fd)
                continue
            if not entry.is_file(follow_symlinks=False):
                raise OSError(
                    errno.EINVAL,
                    "refusing_existing_special_file",
                    entry_relative.as_posix(),
                )


def prepare_runner_out_dir(out_dir: Path) -> int:
    """Securely create/check runner directories before any shell write or cleanup."""
    opened: list[int] = []
    try:
        root_fd = _open_directory_secure(out_dir, create=True)
        opened.append(root_fd)
        _validate_tree_no_links(root_fd)
        for relative in _RUNNER_DIRECTORIES:
            opened.append(_open_directory_secure(out_dir / relative, create=True))

        # Validate every existing cleanup ancestry before mutating any output.
        for relative in _RUNNER_STALE_ACCEPTANCE_PATHS:
            try:
                opened.append(_open_directory_secure(out_dir / Path(relative).parent))
            except FileNotFoundError:
                continue
    except (OSError, ValueError) as exc:
        print(
            json.dumps(
                {
                    "status": "ERROR",
                    "reason": f"unsafe_out_dir:{type(exc).__name__}:{exc}",
                },
                sort_keys=True,
            )
        )
        return 1
    finally:
        for fd in opened:
            os.close(fd)

    removed = sum(
        1 for relative in _RUNNER_STALE_ACCEPTANCE_PATHS if _unlink_relative_secure(out_dir, relative)
    )
    for relative in _RUNNER_LOGS:
        _write_bytes_atomic_secure(out_dir / relative, b"")
    print(removed)
    return 0


def read_bytes_secure(path: Path) -> tuple[bytes | None, dict[str, Any] | None, str | None]:
    """Read one pinned regular-file object through no-follow directory FDs."""
    absolute = Path(os.path.abspath(os.fspath(path)))
    try:
        parent_fd = _open_directory_secure(absolute.parent)
    except FileNotFoundError:
        return None, None, "missing"
    except OSError as exc:
        return None, None, f"unsafe_ancestry:{type(exc).__name__}"
    fd: int | None = None
    try:
        flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
        fd = os.open(absolute.name, flags, dir_fd=parent_fd)
        before = os.fstat(fd)
        if not stat.S_ISREG(before.st_mode):
            return None, None, "not_regular_file"
        chunks: list[bytes] = []
        while True:
            chunk = os.read(fd, 1024 * 1024)
            if not chunk:
                break
            chunks.append(chunk)
        after = os.fstat(fd)
        stable_fields = (
            "st_dev",
            "st_ino",
            "st_size",
            "st_mtime_ns",
            "st_ctime_ns",
        )
        if any(getattr(before, field) != getattr(after, field) for field in stable_fields):
            return None, None, "changed_during_read"
        data = b"".join(chunks)
        if len(data) != after.st_size:
            return None, None, "size_changed_during_read"
        witness = {
            "bytes": len(data),
            "sha256": hashlib.sha256(data).hexdigest(),
            "device": after.st_dev,
            "inode": after.st_ino,
        }
        return data, witness, None
    except FileNotFoundError:
        return None, None, "missing"
    except OSError as exc:
        if exc.errno == errno.ELOOP:
            return None, None, "symlink"
        return None, None, f"unreadable:{type(exc).__name__}"
    finally:
        if fd is not None:
            os.close(fd)
        os.close(parent_fd)


def _write_bytes_atomic_secure(path: Path, data: bytes) -> None:
    absolute = Path(os.path.abspath(os.fspath(path)))
    parent_fd = _open_directory_secure(absolute.parent, create=True)
    tmp_name = f".{absolute.name}.{os.getpid()}.{os.urandom(8).hex()}.tmp"
    fd: int | None = None
    try:
        flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0)
        fd = os.open(tmp_name, flags, 0o600, dir_fd=parent_fd)
        offset = 0
        while offset < len(data):
            offset += os.write(fd, data[offset:])
        os.fsync(fd)
        os.close(fd)
        fd = None
        os.replace(tmp_name, absolute.name, src_dir_fd=parent_fd, dst_dir_fd=parent_fd)
    finally:
        if fd is not None:
            os.close(fd)
        try:
            os.unlink(tmp_name, dir_fd=parent_fd)
        except FileNotFoundError:
            pass
        os.close(parent_fd)


def write_secure_stdin(destination: Path) -> int:
    data = sys.stdin.buffer.read()
    _write_bytes_atomic_secure(destination, data)
    written, witness, error = read_bytes_secure(destination)
    if error is not None or written != data or witness is None:
        print(json.dumps({"status": "ERROR", "reason": error or "write_mismatch"}))
        return 1
    print(
        json.dumps(
            {"status": "PASS", "bytes": witness["bytes"], "sha256": witness["sha256"]},
            sort_keys=True,
        )
    )
    return 0


def copy_secure_file(source: Path, destination: Path) -> int:
    data, witness, error = read_bytes_secure(source)
    if error is not None or data is None or witness is None:
        print(json.dumps({"status": "ERROR", "reason": error or "missing"}))
        return 1
    _write_bytes_atomic_secure(destination, data)
    copied, copied_witness, copied_error = read_bytes_secure(destination)
    if (
        copied_error is not None
        or copied != data
        or copied_witness is None
        or copied_witness["bytes"] != witness["bytes"]
        or copied_witness["sha256"] != witness["sha256"]
    ):
        print(json.dumps({"status": "ERROR", "reason": copied_error or "copy_mismatch"}))
        return 1
    print(
        json.dumps(
            {
                "status": "PASS",
                "bytes": copied_witness["bytes"],
                "sha256": copied_witness["sha256"],
            },
            sort_keys=True,
        )
    )
    return 0


_FEYNARTS_MODEL_SUFFIXES = (".mod", ".gen", ".pars")


def _validated_model_name(model_name: str | None) -> str:
    if (
        not isinstance(model_name, str)
        or not model_name
        or len(model_name) > 128
        or any(char not in "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_" for char in model_name)
    ):
        raise ValueError("unsafe_feynarts_model_name")
    return model_name


def prepare_feynarts_model(out_dir: Path, model_name: str | None) -> int:
    name = _validated_model_name(model_name)
    relative_paths = tuple(
        f"auto_qft/feynarts_model/{name}{suffix}" for suffix in _FEYNARTS_MODEL_SUFFIXES
    )
    try:
        model_dir_fd = _open_directory_secure(out_dir / "auto_qft" / "feynarts_model", create=True)
        os.close(model_dir_fd)
        removed = sum(1 for relative in relative_paths if _unlink_relative_secure(out_dir, relative))
        residual = [
            relative
            for relative in relative_paths
            if read_bytes_secure(out_dir / relative)[2] != "missing"
        ]
    except (OSError, ValueError) as exc:
        print(
            json.dumps(
                {"status": "ERROR", "reason": f"model_prepare_failed:{type(exc).__name__}:{exc}"},
                sort_keys=True,
            )
        )
        return 1
    if residual:
        print(json.dumps({"status": "ERROR", "reason": "model_invalidation_failed", "paths": residual}, sort_keys=True))
        return 1
    print(json.dumps({"status": "PASS", "removed": removed, "paths": list(relative_paths)}, sort_keys=True))
    return 0


def verify_feynarts_model(out_dir: Path, model_name: str | None) -> int:
    name = _validated_model_name(model_name)
    witnesses: dict[str, dict[str, Any]] = {}
    errors: list[str] = []
    for suffix in _FEYNARTS_MODEL_SUFFIXES:
        relative = f"auto_qft/feynarts_model/{name}{suffix}"
        data, witness, error = read_bytes_secure(out_dir / relative)
        if error is not None:
            errors.append(f"{relative}:{error}")
        elif data is None or witness is None or witness["bytes"] <= 0:
            errors.append(f"{relative}:empty")
        else:
            witnesses[relative] = {
                "bytes": witness["bytes"],
                "sha256": witness["sha256"],
            }
    if errors:
        print(json.dumps({"status": "ERROR", "reason": "feynarts_model_files_invalid", "errors": errors}, sort_keys=True))
        return 1
    print(json.dumps({"status": "PASS", "files": witnesses}, sort_keys=True))
    return 0


def read_json_bound(
    path: Path,
    *,
    exact_numbers: bool = False,
) -> tuple[dict[str, Any] | None, bytes | None, dict[str, Any] | None, str | None]:
    data, witness, read_error = read_bytes_secure(path)
    if read_error is not None or data is None:
        return None, data, witness, read_error or "missing"
    try:
        loads_kwargs = {"parse_float": Decimal} if exact_numbers else {}
        value = json.loads(data.decode("utf-8"), **loads_kwargs)
    except Exception as exc:
        return None, data, witness, f"unreadable:{type(exc).__name__}"
    if not isinstance(value, dict):
        return None, data, witness, "not_object"
    return value, data, witness, None


def read_json(
    path: Path,
    *,
    exact_numbers: bool = False,
) -> tuple[dict[str, Any] | None, str | None]:
    value, _, _, error = read_json_bound(path, exact_numbers=exact_numbers)
    return value, error


def write_json_atomic(path: Path, value: dict[str, Any]) -> None:
    payload = (json.dumps(value, indent=2, sort_keys=True) + "\n").encode("utf-8")
    _write_bytes_atomic_secure(path, payload)


def exact_decimal(value: Any) -> Decimal | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return Decimal(value)
    if isinstance(value, Decimal):
        return value if value.is_finite() else None
    if isinstance(value, float):
        return Decimal.from_float(value) if math.isfinite(value) else None
    return None


def is_finite_nonnegative_real(value: Any) -> bool:
    normalized = exact_decimal(value)
    return normalized is not None and normalized >= 0


def invalid_assertion_summary(error: str) -> dict[str, Any]:
    return {
        "contract_valid": False,
        "total": 1,
        "pass": 0,
        "fail": 1,
        "invalid": 1,
        "failed_ids": ["assertions_contract"],
        "contract_errors": [error],
    }


def evaluate_assertions(symbolic: dict[str, Any] | None, symbolic_error: str | None) -> dict[str, Any]:
    if symbolic_error is not None or symbolic is None:
        return invalid_assertion_summary(f"symbolic_json_{symbolic_error or 'missing'}")
    if "data" not in symbolic:
        return invalid_assertion_summary("missing_data")
    data = symbolic.get("data")
    if not isinstance(data, dict):
        return invalid_assertion_summary("data_not_object")
    if "assertions" not in data:
        return {
            "contract_valid": True,
            "total": 0,
            "pass": 0,
            "fail": 0,
            "invalid": 0,
            "failed_ids": [],
            "contract_errors": [],
        }

    assertions = data.get("assertions")
    if not isinstance(assertions, list):
        return invalid_assertion_summary("assertions_not_list")

    declared_ids = [
        item.get("id")
        for item in assertions
        if isinstance(item, dict) and isinstance(item.get("id"), str) and item.get("id", "").strip()
    ]
    duplicate_ids = {item_id for item_id, count in Counter(declared_ids).items() if count > 1}
    evaluated: list[dict[str, Any]] = []
    contract_errors: list[str] = []

    for index, assertion in enumerate(assertions, start=1):
        generated_id = f"assertion_{index}"
        assertion_id = generated_id
        valid = isinstance(assertion, dict)
        if valid:
            raw_id = assertion.get("id")
            if isinstance(raw_id, str) and raw_id.strip():
                assertion_id = raw_id
            else:
                valid = False
                contract_errors.append(f"{generated_id}:invalid_id")
        else:
            contract_errors.append(f"{generated_id}:not_object")

        passed = assertion.get("passed") if isinstance(assertion, dict) else None
        if type(passed) is not bool:
            valid = False
            contract_errors.append(f"{assertion_id}:passed_not_boolean")

        if assertion_id in duplicate_ids:
            valid = False
            contract_errors.append(f"{assertion_id}:duplicate_id")

        has_residual = isinstance(assertion, dict) and "residual" in assertion
        has_tolerance = isinstance(assertion, dict) and "tolerance" in assertion
        if has_residual != has_tolerance:
            valid = False
            contract_errors.append(f"{assertion_id}:residual_tolerance_pair_required")
        elif has_residual and has_tolerance:
            residual = assertion.get("residual")
            tolerance = assertion.get("tolerance")
            if not is_finite_nonnegative_real(residual) or not is_finite_nonnegative_real(tolerance):
                valid = False
                contract_errors.append(f"{assertion_id}:invalid_residual_or_tolerance")
            elif type(passed) is bool and passed is not (
                exact_decimal(residual) <= exact_decimal(tolerance)
            ):
                valid = False
                contract_errors.append(f"{assertion_id}:passed_residual_mismatch")

        evaluated.append(
            {
                "id": assertion_id,
                "valid": valid,
                "passed": bool(valid and passed is True),
            }
        )

    failed_ids = list(
        dict.fromkeys(item["id"] for item in evaluated if not item["passed"])
    )
    pass_count = sum(1 for item in evaluated if item["passed"])
    invalid_count = sum(1 for item in evaluated if not item["valid"])
    total = len(evaluated)
    return {
        "contract_valid": invalid_count == 0,
        "total": total,
        "pass": pass_count,
        "fail": total - pass_count,
        "invalid": invalid_count,
        "failed_ids": failed_ids,
        "contract_errors": list(dict.fromkeys(contract_errors)),
    }


def validate_symbolic(out_dir: Path, *, observed_process_rc: int = 0) -> int:
    symbolic_path = out_dir / "symbolic" / "symbolic.json"
    status_path = out_dir / "symbolic" / "status.json"
    symbolic, symbolic_error = read_json(symbolic_path, exact_numbers=True)
    observed_status, status_error = read_json(status_path)
    assertions = evaluate_assertions(symbolic, symbolic_error)

    postcondition_errors: list[str] = []
    if observed_process_rc != 0:
        postcondition_errors.append(f"symbolic_process_rc_nonzero:{observed_process_rc}")
    if status_error is not None:
        postcondition_errors.append(f"symbolic_status_{status_error}")
    elif observed_status is not None and observed_status.get("stage") != "mathematica_symbolic":
        postcondition_errors.append("symbolic_status_wrong_stage")

    assertion_failed = assertions["fail"] > 0 or not assertions["contract_valid"]
    execution_status = observed_status.get("status") if observed_status else None
    execution_reason = observed_status.get("reason") if observed_status else None

    if assertion_failed:
        final_status = "FAIL"
        final_reason = (
            "invalid_symbolic_assertions_contract"
            if not assertions["contract_valid"]
            else "symbolic_assertions_failed"
        )
    elif postcondition_errors:
        final_status = "ERROR"
        final_reason = "symbolic_postcondition_failed"
    elif execution_status == "PASS":
        final_status = "PASS"
        final_reason = execution_reason
    else:
        final_status = execution_status if execution_status in {"FAIL", "ERROR"} else "ERROR"
        final_reason = execution_reason or "symbolic_stage_not_pass"

    status = dict(observed_status or {})
    status.update(
        {
            "stage": "mathematica_symbolic",
            "status": final_status,
            "reason": final_reason,
            "assertions": assertions,
            "postconditions": {
                "status": "PASS" if final_status == "PASS" else "FAIL",
                "errors": postcondition_errors,
                "observed_process_rc": observed_process_rc,
                "checked_at": utc_now(),
            },
        }
    )
    if observed_status is None or execution_status != final_status or execution_reason != final_reason:
        status["execution_observed"] = {
            "status": execution_status,
            "reason": execution_reason,
            "status_artifact_error": status_error,
        }
    write_json_atomic(status_path, status)
    return 0 if final_status == "PASS" else 1


def _validated_auto_qft_config(job: dict[str, Any]) -> tuple[dict[str, Any], dict[str, Any]]:
    auto = job.get("auto_qft")
    if auto is None:
        auto = {}
    if not isinstance(auto, dict):
        raise ValueError("auto_qft_not_object")
    if "enable" in auto and type(auto.get("enable")) is not bool:
        raise ValueError("auto_qft.enable_not_boolean")
    formcalc_cfg = auto.get("formcalc")
    if formcalc_cfg is None:
        formcalc_cfg = {}
    elif not isinstance(formcalc_cfg, dict):
        raise ValueError("auto_qft.formcalc_not_object")
    if "enable" in formcalc_cfg and type(formcalc_cfg.get("enable")) is not bool:
        raise ValueError("auto_qft.formcalc.enable_not_boolean")
    memory_limit_mb = formcalc_cfg.get("memory_limit_mb", 2048)
    if type(memory_limit_mb) is not int or memory_limit_mb <= 0:
        raise ValueError("auto_qft.formcalc.memory_limit_mb_not_positive_integer")
    pave_reduce = formcalc_cfg.get("pave_reduce", "LoopTools")
    if pave_reduce not in {"LoopTools", "False"}:
        raise ValueError("auto_qft.formcalc.pave_reduce_invalid")
    return auto, formcalc_cfg


def bind_auto_qft_job(job_path: Path, out_dir: Path) -> int:
    data, witness, error = read_bytes_secure(job_path)
    if error is not None or data is None or witness is None:
        raise ValueError(f"job_resolved_json_{error or 'missing'}")
    try:
        job = json.loads(data.decode("utf-8"))
    except Exception as exc:
        raise ValueError(f"job_resolved_json_unreadable:{type(exc).__name__}") from exc
    if not isinstance(job, dict):
        raise ValueError("job_resolved_json_not_object")
    auto, formcalc_cfg = _validated_auto_qft_config(job)
    snapshot_path = out_dir / "auto_qft" / "formcalc" / "job_snapshot.json"
    _write_bytes_atomic_secure(snapshot_path, data)
    snapshot_data, snapshot_witness, snapshot_error = read_bytes_secure(snapshot_path)
    if (
        snapshot_error is not None
        or snapshot_data != data
        or snapshot_witness is None
        or snapshot_witness["bytes"] != witness["bytes"]
        or snapshot_witness["sha256"] != witness["sha256"]
    ):
        raise ValueError("job_snapshot_publish_mismatch")
    feynarts_model = auto.get("feynarts_model")
    fields = (
        "1" if auto.get("enable") is True else "0",
        "1" if formcalc_cfg.get("enable") is True else "0",
        "1" if isinstance(feynarts_model, str) and bool(feynarts_model.strip()) else "0",
        str(witness["bytes"]),
        witness["sha256"],
    )
    print("\t".join(fields))
    return 0


def emit_secure_read(path: Path) -> int:
    data, witness, error = read_bytes_secure(path)
    if error is not None or data is None or witness is None:
        print(json.dumps({"status": "ERROR", "reason": error or "missing"}))
        return 1
    print(
        json.dumps(
            {
                "status": "PASS",
                "bytes": witness["bytes"],
                "sha256": witness["sha256"],
                "base64": base64.b64encode(data).decode("ascii"),
            },
            sort_keys=True,
        )
    )
    return 0


def publish_secure_snapshot(
    source: Path,
    destination: Path,
    expected_bytes: int,
    expected_sha256: str,
) -> int:
    data, witness, error = read_bytes_secure(source)
    if error is not None or data is None or witness is None:
        print(json.dumps({"status": "ERROR", "reason": error or "missing"}))
        return 1
    if witness["bytes"] != expected_bytes or witness["sha256"] != expected_sha256:
        print(json.dumps({"status": "ERROR", "reason": "source_witness_mismatch"}))
        return 1
    _write_bytes_atomic_secure(destination, data)
    copied, copied_witness, copied_error = read_bytes_secure(destination)
    if (
        copied_error is not None
        or copied != data
        or copied_witness is None
        or copied_witness["bytes"] != expected_bytes
        or copied_witness["sha256"] != expected_sha256
    ):
        print(json.dumps({"status": "ERROR", "reason": "snapshot_witness_mismatch"}))
        return 1
    print(
        json.dumps(
            {
                "status": "PASS",
                "bytes": copied_witness["bytes"],
                "sha256": copied_witness["sha256"],
            },
            sort_keys=True,
        )
    )
    return 0


def validate_auto_qft(
    job_path: Path,
    out_dir: Path,
    *,
    expected_job_bytes: int | None = None,
    expected_job_sha256: str | None = None,
    observed_process_rc: int = 0,
) -> int:
    if expected_job_bytes is None:
        raise ValueError("expected_job_bytes_required")
    if expected_job_sha256 is None:
        raise ValueError("expected_job_sha256_required")
    job_data, job_witness_full, job_error = read_bytes_secure(job_path)
    if job_error is not None or job_data is None or job_witness_full is None:
        raise ValueError(f"job_resolved_json_{job_error or 'missing'}")
    try:
        job = json.loads(job_data.decode("utf-8"))
    except Exception as exc:
        raise ValueError(f"job_resolved_json_unreadable:{type(exc).__name__}") from exc
    if not isinstance(job, dict):
        raise ValueError("job_resolved_json_not_object")
    auto, formcalc_cfg = _validated_auto_qft_config(job)
    if job_witness_full["bytes"] != expected_job_bytes:
        raise ValueError("job_resolved_bytes_binding_mismatch")
    if job_witness_full["sha256"] != expected_job_sha256:
        raise ValueError("job_resolved_sha256_binding_mismatch")
    formcalc_memory_limit_mb = formcalc_cfg.get("memory_limit_mb", 2048)
    formcalc_pave_reduce = formcalc_cfg.get("pave_reduce", "LoopTools")

    if auto.get("enable") is not True:
        return 0

    auto_dir = out_dir / "auto_qft"
    status_path = auto_dir / "status.json"
    summary_path = auto_dir / "summary.json"
    amplitude_path = auto_dir / "amplitude" / "amplitude_summed.m"
    amps_raw_path = auto_dir / "amplitude" / "amps_raw.m"
    producer_status_path = auto_dir / "producer_status.json"
    handoff_path = auto_dir / "formcalc" / "handoff.json"
    input_snapshot_path = auto_dir / "formcalc" / "input_snapshot.m"
    formcalc_status_path = auto_dir / "formcalc" / "status.json"
    observed_status, status_data, status_witness, status_error = read_json_bound(status_path)
    observed_summary, summary_data, summary_witness, summary_error = read_json_bound(summary_path)
    formcalc_requested = formcalc_cfg.get("enable") is True
    errors: list[str] = []
    if observed_process_rc != 0:
        errors.append(f"auto_qft_process_rc_nonzero:{observed_process_rc}")
    try:
        job_relative_path = job_path.relative_to(out_dir).as_posix()
    except ValueError:
        job_relative_path = os.path.abspath(os.fspath(job_path))
    job_witness = {
        "path": job_relative_path,
        "bytes": job_witness_full["bytes"],
        "sha256": job_witness_full["sha256"],
    }
    amplitude_data, amplitude_identity, amplitude_error = read_bytes_secure(amplitude_path)
    amplitude_witness = (
        {"bytes": amplitude_identity["bytes"], "sha256": amplitude_identity["sha256"]}
        if amplitude_identity is not None
        else None
    )
    producer_status, producer_data, producer_file_witness, producer_status_error = read_json_bound(producer_status_path)
    handoff, handoff_data, handoff_file_witness, handoff_error = read_json_bound(handoff_path)

    if status_error is not None:
        errors.append(f"auto_qft_status_{status_error}")
    elif observed_status is not None:
        if observed_status.get("stage") != "auto_qft_one_loop":
            errors.append("auto_qft_status_wrong_stage")
        if observed_status.get("status") != "PASS":
            errors.append("auto_qft_status_not_pass")

    if summary_error is not None:
        errors.append(f"auto_qft_summary_{summary_error}")
    elif observed_summary is not None and observed_summary.get("status") != "PASS":
        errors.append("auto_qft_summary_not_pass")

    if amplitude_error == "missing":
        errors.append("amplitude_summed_missing_or_empty")
    elif amplitude_error is not None:
        errors.append(f"amplitude_summed_{amplitude_error}")
    elif amplitude_witness is None or amplitude_witness["bytes"] <= 0:
        errors.append("amplitude_summed_missing_or_empty")

    if producer_status_error is not None:
        errors.append(f"auto_qft_producer_status_{producer_status_error}")
    elif producer_status is not None:
        if producer_status.get("stage") != "auto_qft_feynarts_producer":
            errors.append("auto_qft_producer_status_wrong_stage")
        if producer_status.get("status") != "PASS":
            errors.append("auto_qft_producer_status_not_pass")
        if producer_status.get("job") != job_witness:
            errors.append("auto_qft_producer_job_binding_mismatch")
    if handoff_error is not None:
        errors.append(f"auto_qft_handoff_{handoff_error}")
    elif handoff is not None and handoff.get("job") != job_witness:
        errors.append("auto_qft_handoff_job_binding_mismatch")
    if isinstance(observed_summary, dict) and observed_summary.get("job") != job_witness:
        errors.append("auto_qft_summary_job_binding_mismatch")
    if (
        not formcalc_requested
        and isinstance(observed_status, dict)
        and observed_status.get("job") != job_witness
    ):
        errors.append("auto_qft_status_job_binding_mismatch")

    if formcalc_requested:
        raw_relative_path = "auto_qft/amplitude/amps_raw.m"
        handoff_relative_path = "auto_qft/formcalc/handoff.json"
        snapshot_relative_path = "auto_qft/formcalc/input_snapshot.m"
        reducer_status_relative_path = "auto_qft/formcalc/status.json"
        status_formcalc = observed_status.get("formcalc") if isinstance(observed_status, dict) else None
        summary_options = observed_summary.get("options") if isinstance(observed_summary, dict) else None
        summary_formcalc = summary_options.get("formcalc") if isinstance(summary_options, dict) else None
        reducer_status, reducer_data, reducer_file_witness, reducer_status_error = read_json_bound(formcalc_status_path)
        raw_data, raw_identity, raw_witness_error = read_bytes_secure(amps_raw_path)
        snapshot_data, snapshot_identity, snapshot_witness_error = read_bytes_secure(input_snapshot_path)
        output_data, output_identity, output_witness_error = amplitude_data, amplitude_identity, amplitude_error
        raw_witness = (
            {"bytes": raw_identity["bytes"], "sha256": raw_identity["sha256"]}
            if raw_identity is not None
            else None
        )
        snapshot_witness = (
            {"bytes": snapshot_identity["bytes"], "sha256": snapshot_identity["sha256"]}
            if snapshot_identity is not None
            else None
        )
        output_witness = (
            {"bytes": output_identity["bytes"], "sha256": output_identity["sha256"]}
            if output_identity is not None
            else None
        )

        if not isinstance(status_formcalc, dict) or status_formcalc.get("status") != "PASS":
            errors.append("formcalc_status_not_explicit_pass")
        if (
            not isinstance(summary_formcalc, dict)
            or summary_formcalc.get("enable") is not True
            or summary_formcalc.get("status") != "PASS"
        ):
            errors.append("formcalc_summary_not_explicit_pass")
        elif summary_formcalc.get("pave_reduce") != formcalc_pave_reduce:
            errors.append("formcalc_summary_pave_reduce_mismatch")
        elif summary_formcalc.get("memory_limit_mb") != formcalc_memory_limit_mb:
            errors.append("formcalc_summary_memory_limit_mismatch")
        elif summary_formcalc.get("reducer_status") != reducer_status_relative_path:
            errors.append("formcalc_summary_reducer_status_path_mismatch")
        elif summary_formcalc.get("job") != job_witness:
            errors.append("formcalc_summary_job_binding_mismatch")
        if not isinstance(observed_status, dict) or observed_status.get("amplitude_level") != "formcalc":
            errors.append("formcalc_amplitude_level_not_confirmed")

        if producer_status_error is not None:
            errors.append(f"formcalc_producer_status_{producer_status_error}")
        elif producer_status is not None:
            if producer_status.get("stage") != "auto_qft_feynarts_producer":
                errors.append("formcalc_producer_status_wrong_stage")
            if producer_status.get("status") != "PASS":
                errors.append("formcalc_producer_status_not_pass")
            if producer_status.get("handoff") != handoff_relative_path:
                errors.append("formcalc_producer_handoff_path_mismatch")

        producer_token = producer_status.get("token") if isinstance(producer_status, dict) else None
        if not isinstance(producer_token, str) or not producer_token:
            errors.append("formcalc_producer_token_invalid")
        producer_input = producer_status.get("amplitude") if isinstance(producer_status, dict) else None
        if not isinstance(producer_input, dict):
            errors.append("formcalc_producer_input_witness_missing")
            producer_input = {}
        producer_bytes = producer_input.get("bytes")
        producer_sha256 = producer_input.get("sha256")
        producer_amp_count = producer_input.get("amp_count")
        if producer_input.get("path") != raw_relative_path:
            errors.append("formcalc_producer_input_path_mismatch")
        if type(producer_bytes) is not int or producer_bytes <= 0:
            errors.append("formcalc_producer_input_bytes_invalid")
        if (
            not isinstance(producer_sha256, str)
            or len(producer_sha256) != 64
            or any(char not in "0123456789abcdef" for char in producer_sha256)
        ):
            errors.append("formcalc_producer_input_sha256_invalid")
        if type(producer_amp_count) is not int or producer_amp_count <= 0:
            errors.append("formcalc_producer_amp_count_invalid")

        if handoff_error is not None:
            errors.append(f"formcalc_handoff_{handoff_error}")
        elif handoff is not None:
            if handoff.get("stage") != "auto_qft_formcalc_handoff":
                errors.append("formcalc_handoff_wrong_stage")
            if handoff.get("status") != "PASS":
                errors.append("formcalc_handoff_not_pass")
            if handoff.get("token") != producer_token:
                errors.append("formcalc_handoff_token_mismatch")
            if handoff.get("raw_path") != raw_relative_path:
                errors.append("formcalc_handoff_raw_path_mismatch")
            if handoff.get("raw_bytes") != producer_bytes:
                errors.append("formcalc_handoff_raw_bytes_mismatch")
            if handoff.get("raw_sha256") != producer_sha256:
                errors.append("formcalc_handoff_raw_sha256_mismatch")
            if handoff.get("amp_count") != producer_amp_count:
                errors.append("formcalc_handoff_amp_count_mismatch")
            if handoff.get("pave_reduce") != formcalc_cfg.get("pave_reduce", "LoopTools"):
                errors.append("formcalc_handoff_pave_reduce_mismatch")
            if handoff.get("memory_limit_mb") != formcalc_memory_limit_mb:
                errors.append("formcalc_handoff_memory_limit_mismatch")

        if raw_witness_error is not None:
            errors.append(f"formcalc_current_raw_{raw_witness_error}")
        elif raw_witness is not None:
            if raw_witness["bytes"] <= 0:
                errors.append("formcalc_current_raw_empty")
            if raw_witness.get("bytes") != producer_bytes:
                errors.append("formcalc_current_raw_bytes_mismatch")
            if raw_witness.get("sha256") != producer_sha256:
                errors.append("formcalc_current_raw_sha256_mismatch")

        if snapshot_witness_error is not None:
            errors.append(f"formcalc_input_snapshot_{snapshot_witness_error}")
        elif snapshot_witness is not None:
            if snapshot_witness["bytes"] <= 0:
                errors.append("formcalc_input_snapshot_empty")
            if snapshot_witness.get("bytes") != producer_bytes:
                errors.append("formcalc_input_snapshot_bytes_mismatch")
            if snapshot_witness.get("sha256") != producer_sha256:
                errors.append("formcalc_input_snapshot_sha256_mismatch")
            if raw_witness is not None and snapshot_witness != raw_witness:
                errors.append("formcalc_snapshot_current_raw_mismatch")

        if reducer_status_error == "missing":
            errors.append("formcalc_reducer_status_not_pass")
        elif reducer_status_error is not None:
            errors.append(f"formcalc_reducer_status_{reducer_status_error}")
        elif reducer_status is not None:
            if reducer_status.get("stage") != "auto_qft_formcalc_reducer":
                errors.append("formcalc_reducer_status_wrong_stage")
            if reducer_status.get("status") != "PASS":
                errors.append("formcalc_reducer_status_not_pass")
            if reducer_status.get("memory_limit_mb") != formcalc_memory_limit_mb:
                errors.append("formcalc_reducer_memory_limit_mismatch")
            if reducer_status.get("pave_reduce") != formcalc_pave_reduce:
                errors.append("formcalc_reducer_pave_reduce_mismatch")
            if reducer_status.get("producer_token") != producer_token:
                errors.append("formcalc_reducer_producer_token_mismatch")
            if reducer_status.get("job") != job_witness:
                errors.append("formcalc_reducer_job_binding_mismatch")

            reducer_input = reducer_status.get("input")
            if not isinstance(reducer_input, dict):
                errors.append("formcalc_reducer_input_witness_missing")
            else:
                if reducer_input.get("token") != producer_token:
                    errors.append("formcalc_reducer_input_token_mismatch")
                if reducer_input.get("path") != raw_relative_path:
                    errors.append("formcalc_reducer_input_path_mismatch")
                if reducer_input.get("bytes") != producer_bytes:
                    errors.append("formcalc_reducer_input_bytes_mismatch")
                if reducer_input.get("sha256") != producer_sha256:
                    errors.append("formcalc_reducer_input_sha256_mismatch")

            reducer_snapshot = reducer_status.get("snapshot")
            if not isinstance(reducer_snapshot, dict):
                errors.append("formcalc_reducer_snapshot_witness_missing")
            else:
                if reducer_snapshot.get("token") != producer_token:
                    errors.append("formcalc_reducer_snapshot_token_mismatch")
                if reducer_snapshot.get("path") != snapshot_relative_path:
                    errors.append("formcalc_reducer_snapshot_path_mismatch")
                if reducer_snapshot.get("source_path") != raw_relative_path:
                    errors.append("formcalc_reducer_snapshot_source_path_mismatch")
                if reducer_snapshot.get("bytes") != producer_bytes:
                    errors.append("formcalc_reducer_snapshot_bytes_mismatch")
                if reducer_snapshot.get("sha256") != producer_sha256:
                    errors.append("formcalc_reducer_snapshot_sha256_mismatch")

            expected_chain_checks = {
                "after_snapshot_publish": "PASS",
                "after_snapshot_read": "PASS",
                "after_reduction": "PASS",
                "before_pass_publish": "PASS",
            }
            if reducer_status.get("input_chain_checks") != expected_chain_checks:
                errors.append("formcalc_reducer_input_chain_checks_incomplete")

            reducer_output = reducer_status.get("output")
            if not isinstance(reducer_output, dict):
                errors.append("formcalc_reducer_output_witness_missing")
            else:
                if reducer_output.get("path") != "auto_qft/amplitude/amplitude_summed.m":
                    errors.append("formcalc_reducer_output_path_mismatch")
                if output_witness_error is not None:
                    errors.append(f"formcalc_reducer_output_{output_witness_error}")
                elif output_witness is not None and (
                    reducer_output.get("bytes") != output_witness.get("bytes")
                    or reducer_output.get("sha256") != output_witness.get("sha256")
                ):
                    errors.append("formcalc_reducer_output_witness_mismatch")

        if isinstance(status_formcalc, dict):
            if status_formcalc.get("reducer_status") != reducer_status_relative_path:
                errors.append("formcalc_top_reducer_status_path_mismatch")
            if status_formcalc.get("pave_reduce") != formcalc_pave_reduce:
                errors.append("formcalc_top_pave_reduce_mismatch")
            if status_formcalc.get("memory_limit_mb") != formcalc_memory_limit_mb:
                errors.append("formcalc_top_memory_limit_mismatch")
            if status_formcalc.get("job") != job_witness:
                errors.append("formcalc_top_job_binding_mismatch")
            if status_formcalc.get("producer_token") != producer_token:
                errors.append("formcalc_top_producer_token_mismatch")
            if status_formcalc.get("input_path") != raw_relative_path:
                errors.append("formcalc_top_input_path_mismatch")
            if status_formcalc.get("snapshot_path") != snapshot_relative_path:
                errors.append("formcalc_top_snapshot_path_mismatch")
            if status_formcalc.get("input_bytes") != producer_bytes:
                errors.append("formcalc_top_input_bytes_mismatch")
            if status_formcalc.get("input_sha256") != producer_sha256:
                errors.append("formcalc_top_input_sha256_mismatch")
            if status_formcalc.get("output_path") != "auto_qft/amplitude/amplitude_summed.m":
                errors.append("formcalc_top_output_path_mismatch")
            if output_witness is not None:
                if status_formcalc.get("output_bytes") != output_witness.get("bytes"):
                    errors.append("formcalc_top_output_bytes_mismatch")
                if status_formcalc.get("output_sha256") != output_witness.get("sha256"):
                    errors.append("formcalc_top_output_sha256_mismatch")

        if isinstance(summary_formcalc, dict) and output_witness is not None:
            if summary_formcalc.get("output_path") != "auto_qft/amplitude/amplitude_summed.m":
                errors.append("formcalc_summary_output_path_mismatch")
            if summary_formcalc.get("output_bytes") != output_witness.get("bytes"):
                errors.append("formcalc_summary_output_bytes_mismatch")
            if summary_formcalc.get("output_sha256") != output_witness.get("sha256"):
                errors.append("formcalc_summary_output_sha256_mismatch")
        if isinstance(observed_summary, dict):
            if observed_summary.get("formcalc_reducer") != reducer_status:
                errors.append("formcalc_summary_reducer_witness_mismatch")

        for label, path, original_data, original_witness in (
            ("job", job_path, job_data, job_witness_full),
            ("top_status", status_path, status_data, status_witness),
            ("summary", summary_path, summary_data, summary_witness),
            ("producer_status", producer_status_path, producer_data, producer_file_witness),
            ("handoff", handoff_path, handoff_data, handoff_file_witness),
            ("reducer_status", formcalc_status_path, reducer_data, reducer_file_witness),
        ):
            reread_data, reread_witness, reread_error = read_bytes_secure(path)
            if (
                reread_error is not None
                or reread_data != original_data
                or reread_witness != original_witness
            ):
                errors.append(f"formcalc_{label}_changed_during_validation")
        for label, path, original_data, original_identity in (
            ("current_raw", amps_raw_path, raw_data, raw_identity),
            ("input_snapshot", input_snapshot_path, snapshot_data, snapshot_identity),
            ("reduced_output", amplitude_path, output_data, output_identity),
        ):
            reread_data, reread_identity, reread_error = read_bytes_secure(path)
            if (
                reread_error is not None
                or reread_data != original_data
                or reread_identity != original_identity
            ):
                errors.append(f"formcalc_{label}_changed_during_validation")

    if not formcalc_requested:
        for label, path, original_data, original_witness in (
            ("job", job_path, job_data, job_witness_full),
            ("top_status", status_path, status_data, status_witness),
            ("summary", summary_path, summary_data, summary_witness),
            ("producer_status", producer_status_path, producer_data, producer_file_witness),
            ("handoff", handoff_path, handoff_data, handoff_file_witness),
        ):
            reread_data, reread_witness, reread_error = read_bytes_secure(path)
            if (
                reread_error is not None
                or reread_data != original_data
                or reread_witness != original_witness
            ):
                errors.append(f"auto_qft_{label}_changed_during_validation")
        reread_amplitude_data, reread_amplitude_identity, reread_amplitude_error = read_bytes_secure(
            amplitude_path
        )
        if (
            reread_amplitude_error is not None
            or reread_amplitude_data != amplitude_data
            or reread_amplitude_identity != amplitude_identity
        ):
            errors.append("auto_qft_amplitude_changed_during_validation")

    errors = list(dict.fromkeys(errors))
    postconditions = {
        "status": "FAIL" if errors else "PASS",
        "errors": errors,
        "formcalc_requested": formcalc_requested,
        "observed_process_rc": observed_process_rc,
        "checked_at": utc_now(),
    }

    status = dict(observed_status or {})
    summary = dict(observed_summary or {})
    if errors:
        status.update(
            {
                "stage": "auto_qft_one_loop",
                "status": "ERROR",
                "reason": status.get("reason")
                or ("formcalc_failed" if formcalc_requested else "auto_qft_postcondition_failed"),
                "postconditions": postconditions,
            }
        )
        summary.update(
            {
                "status": "ERROR",
                "reason": summary.get("reason")
                or ("formcalc_failed" if formcalc_requested else "auto_qft_postcondition_failed"),
                "postconditions": postconditions,
            }
        )
    else:
        status["postconditions"] = postconditions
        summary["postconditions"] = postconditions
    write_json_atomic(status_path, status)
    write_json_atomic(summary_path, summary)
    final_errors: list[str] = []
    written_status, written_status_error = read_json(status_path)
    written_summary, written_summary_error = read_json(summary_path)
    if written_status_error is not None or written_status != status:
        final_errors.append("formcalc_top_status_changed_after_publish")
    if written_summary_error is not None or written_summary != summary:
        final_errors.append("formcalc_summary_changed_after_publish")
    final_job_data, final_job_identity, final_job_error = read_bytes_secure(job_path)
    if (
        final_job_error is not None
        or final_job_data != job_data
        or final_job_identity != job_witness_full
    ):
        final_errors.append("auto_qft_job_changed_before_return")
    final_output_data, final_output_identity, final_output_error = read_bytes_secure(amplitude_path)
    if (
        final_output_error is not None
        or final_output_data != amplitude_data
        or final_output_identity != amplitude_identity
    ):
        final_errors.append("auto_qft_amplitude_changed_before_return")
    if final_errors:
        all_errors = list(dict.fromkeys([*errors, *final_errors]))
        final_postconditions = dict(postconditions)
        final_postconditions.update({"status": "FAIL", "errors": all_errors, "checked_at": utc_now()})
        failure_status = dict(status)
        failure_summary = dict(summary)
        failure_status.update(
            {
                "stage": "auto_qft_one_loop",
                "status": "ERROR",
                "reason": "formcalc_failed" if formcalc_requested else "auto_qft_postcondition_failed",
                "postconditions": final_postconditions,
            }
        )
        failure_summary.update(
            {
                "status": "ERROR",
                "reason": "formcalc_failed" if formcalc_requested else "auto_qft_postcondition_failed",
                "postconditions": final_postconditions,
            }
        )
        write_json_atomic(status_path, failure_status)
        write_json_atomic(summary_path, failure_summary)
        return 1
    return 1 if errors else 0


def main() -> int:
    parser = argparse.ArgumentParser(description="Validate fail-closed hep-calc stage postconditions.")
    parser.add_argument(
        "--stage",
        choices=(
            "symbolic",
            "auto_qft",
            "bind_auto_qft_job",
            "prepare_out_dir",
            "prepare_feynarts_model",
            "verify_feynarts_model",
            "secure_read",
            "secure_write",
            "secure_copy",
            "publish_snapshot",
        ),
        required=True,
    )
    parser.add_argument("--out")
    parser.add_argument("--job")
    parser.add_argument("--path")
    parser.add_argument("--source")
    parser.add_argument("--destination")
    parser.add_argument("--model-name")
    parser.add_argument("--expected-bytes", type=int)
    parser.add_argument("--expected-sha256")
    parser.add_argument("--expected-job-bytes", type=int)
    parser.add_argument("--expected-job-sha256")
    parser.add_argument("--observed-process-rc", type=int, default=0)
    args = parser.parse_args()
    if args.stage == "secure_read":
        if not args.path:
            parser.error("--path is required for secure_read")
        return emit_secure_read(Path(os.path.abspath(os.path.expanduser(args.path))))
    if args.stage == "secure_write":
        if not args.destination:
            parser.error("--destination is required for secure_write")
        return write_secure_stdin(Path(os.path.abspath(os.path.expanduser(args.destination))))
    if args.stage == "secure_copy":
        if not args.source or not args.destination:
            parser.error("--source and --destination are required for secure_copy")
        return copy_secure_file(
            Path(os.path.abspath(os.path.expanduser(args.source))),
            Path(os.path.abspath(os.path.expanduser(args.destination))),
        )
    if args.stage == "publish_snapshot":
        if (
            not args.source
            or not args.destination
            or args.expected_bytes is None
            or args.expected_sha256 is None
        ):
            parser.error(
                "--source, --destination, --expected-bytes, and --expected-sha256 are required"
            )
        return publish_secure_snapshot(
            Path(os.path.abspath(os.path.expanduser(args.source))),
            Path(os.path.abspath(os.path.expanduser(args.destination))),
            args.expected_bytes,
            args.expected_sha256,
        )
    if not args.out:
        parser.error("--out is required")
    out_dir = Path(os.path.abspath(os.path.expanduser(args.out)))
    if args.stage == "prepare_out_dir":
        return prepare_runner_out_dir(out_dir)
    if args.stage == "prepare_feynarts_model":
        return prepare_feynarts_model(out_dir, args.model_name)
    if args.stage == "verify_feynarts_model":
        return verify_feynarts_model(out_dir, args.model_name)
    if args.stage == "bind_auto_qft_job":
        if not args.job:
            parser.error("--job is required for bind_auto_qft_job")
        return bind_auto_qft_job(
            Path(os.path.abspath(os.path.expanduser(args.job))),
            out_dir,
        )
    if args.stage == "symbolic":
        return validate_symbolic(out_dir, observed_process_rc=args.observed_process_rc)
    if not args.job:
        parser.error("--job is required for auto_qft postconditions")
    try:
        return validate_auto_qft(
            Path(os.path.abspath(os.path.expanduser(args.job))),
            out_dir,
            expected_job_bytes=args.expected_job_bytes,
            expected_job_sha256=args.expected_job_sha256,
            observed_process_rc=args.observed_process_rc,
        )
    except Exception as exc:
        auto_dir = out_dir / "auto_qft"
        error = {
            "stage": "auto_qft_one_loop",
            "status": "ERROR",
            "reason": "auto_qft_postcondition_validator_error",
            "postconditions": {
                "status": "FAIL",
                "errors": [f"validator_error:{type(exc).__name__}:{exc}"],
                "checked_at": utc_now(),
            },
        }
        write_json_atomic(auto_dir / "status.json", error)
        write_json_atomic(auto_dir / "summary.json", dict(error))
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
