from __future__ import annotations

import json
import pathlib
import re
from typing import Any

AUTO_SAFE_REF_RE = re.compile(r"^[0-9a-f]{40}$")
ALLOWED_INSTALL_POLICY_KEYS = {"auto_safe"}
ALLOWED_AUTO_SAFE_KEYS = {"human_pre_approved"}


def _install_policy_issues(package_type: Any, install_policy: Any) -> list[str]:
    if install_policy is None:
        return []
    if package_type != "skill-pack":
        return ["install_policy is only allowed for skill-pack entries"]
    if not isinstance(install_policy, dict):
        return ["install_policy must be an object when present"]

    errs: list[str] = []
    extra_keys = sorted(set(install_policy.keys()) - ALLOWED_INSTALL_POLICY_KEYS)
    if extra_keys:
        errs.append(f"install_policy has unsupported keys: {extra_keys}")

    auto_safe = install_policy.get("auto_safe")
    if auto_safe is None:
        errs.append("install_policy.auto_safe is required when install_policy is present")
        return errs
    if not isinstance(auto_safe, dict):
        errs.append("install_policy.auto_safe must be an object")
        return errs

    extra_auto_safe_keys = sorted(set(auto_safe.keys()) - ALLOWED_AUTO_SAFE_KEYS)
    if extra_auto_safe_keys:
        errs.append(f"install_policy.auto_safe has unsupported keys: {extra_auto_safe_keys}")
    if auto_safe.get("human_pre_approved") is not True:
        errs.append("install_policy.auto_safe.human_pre_approved must be true")
    return errs


def validate_install_policy(path_label: str, package_type: Any, install_policy: Any) -> list[str]:
    return [f"{path_label}: {issue}" for issue in _install_policy_issues(package_type, install_policy)]


def ensure_install_policy(package_id: str, package: dict[str, Any]) -> dict[str, Any] | None:
    issues = _install_policy_issues(package.get("package_type"), package.get("install_policy"))
    if issues:
        raise RuntimeError(f"{package_id}: {issues[0]}")
    install_policy = package.get("install_policy")
    return install_policy if isinstance(install_policy, dict) else None


def has_auto_safe_opt_in(package: dict[str, Any]) -> bool:
    install_policy = package.get("install_policy")
    if not isinstance(install_policy, dict):
        return False
    auto_safe = install_policy.get("auto_safe")
    return (
        isinstance(auto_safe, dict)
        and set(auto_safe.keys()) == ALLOWED_AUTO_SAFE_KEYS
        and auto_safe.get("human_pre_approved") is True
    )


def auto_safe_install_issues(
    package_id: str,
    package: dict[str, Any],
    *,
    require_opt_in: bool,
) -> list[str]:
    issues: list[str] = []
    if package.get("package_type") != "skill-pack":
        issues.append("auto-safe install is only allowed for skill-pack entries")
    if require_opt_in and not has_auto_safe_opt_in(package):
        issues.append("install_policy.auto_safe.human_pre_approved must be true for auto-safe install")

    source = package.get("source")
    ref = source.get("ref") if isinstance(source, dict) else None
    if not isinstance(ref, str) or not AUTO_SAFE_REF_RE.fullmatch(ref):
        issues.append("auto-safe source.ref must be an immutable 40-character git SHA")

    runtime = package.get("runtime")
    if runtime is not None:
        python_runtime = runtime.get("python") if isinstance(runtime, dict) else None
        if not isinstance(python_runtime, dict) or python_runtime.get("mode") != "isolated-venv":
            issues.append("auto-safe runtime must be absent or use runtime.python.mode='isolated-venv'")

    if not package_id:
        issues.append("package_id must be non-empty for auto-safe install")
    return issues


def evaluate_auto_safe_package(package_id: str, package: dict[str, Any]) -> dict[str, Any]:
    issues = auto_safe_install_issues(package_id, package, require_opt_in=True)
    source = package.get("source")
    runtime = package.get("runtime")
    python_runtime = runtime.get("python") if isinstance(runtime, dict) else None
    return {
        "package_id": package_id,
        "eligible": not issues,
        "human_pre_approved": has_auto_safe_opt_in(package),
        "source_ref": source.get("ref") if isinstance(source, dict) else None,
        "runtime_mode": python_runtime.get("mode") if isinstance(python_runtime, dict) else None,
        "reasons": issues,
    }


def evaluate_auto_safe_closure(
    *,
    requested_packages: list[str],
    ordered_packages: list[str],
    packages: dict[str, dict[str, Any]],
    non_skill_deps: dict[str, list[str]],
) -> dict[str, Any]:
    evaluated_packages = [evaluate_auto_safe_package(package_id, packages[package_id]) for package_id in ordered_packages]
    dependency_errors = [
        f"{package_id}: non-skill dependencies are not allowed for --auto-safe: {', '.join(sorted(set(dep_ids)))}"
        for package_id, dep_ids in sorted(non_skill_deps.items())
    ]
    return {
        "requested_packages": list(requested_packages),
        "resolved_packages": list(ordered_packages),
        "eligible": not dependency_errors and all(entry["eligible"] for entry in evaluated_packages),
        "dependency_errors": dependency_errors,
        "evaluated_packages": evaluated_packages,
    }


def format_auto_safe_rejection(evaluation: dict[str, Any]) -> str:
    lines = ["auto-safe install rejected:"]
    for issue in evaluation.get("dependency_errors", []):
        lines.append(f"  - {issue}")
    for entry in evaluation.get("evaluated_packages", []):
        if entry.get("eligible"):
            continue
        package_id = entry.get("package_id", "<unknown>")
        for reason in entry.get("reasons", []):
            lines.append(f"  - {package_id}: {reason}")
    return "\n".join(lines)


def write_auto_safe_audit(
    target_root: pathlib.Path,
    evaluation: dict[str, Any],
    *,
    result: str,
    error: str | None = None,
) -> pathlib.Path:
    target_root.mkdir(parents=True, exist_ok=True)
    payload = {
        **evaluation,
        "result": result,
    }
    if error is not None:
        payload["error"] = error
    audit_path = target_root / ".auto_safe_install_audit.json"
    audit_path.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    return audit_path
