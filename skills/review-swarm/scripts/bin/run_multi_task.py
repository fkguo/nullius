#!/usr/bin/env python3
"""
run_multi_task.py

Run clean-room multi-agent passes for the same task/prompt.
Supports OpenCode models plus explicit codex/ and gemini/ model routing.

Examples:
    python run_multi_task.py --out-dir ./results --system system.txt --prompt task.txt --agents 3
    python run_multi_task.py --out-dir ./results --system system.txt --prompt task.txt --models minimax/MiniMax-M2.5,qwen-cp/qwen3-coder-plus,zhipuglm/glm-5
    python run_multi_task.py --out-dir ./results --system system.txt --prompt task.txt --model default
"""

from __future__ import annotations

import argparse
import codecs
import itertools
import json
import os
import re
import subprocess
import sys
import threading
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
from hashlib import sha256
from pathlib import Path
from typing import Any, Optional


_TRACE_LOCK = threading.Lock()
_RE_MODEL_SLUG = re.compile(r"[^A-Za-z0-9._-]+")
_EXIT_NEEDS_USER_DECISION = 4

_SCRIPT_DIR = Path(__file__).resolve().parent
if str(_SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(_SCRIPT_DIR))

from review_contract import (
    check_review_contract_file,
    first_verdict,
    sanitize_contract_output,
    sanitize_gemini_output,
)


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _append_jsonl(path: Path, obj: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    line = json.dumps(obj, sort_keys=True)
    # Thread-safe append for parallel agent execution.
    with _TRACE_LOCK:
        with path.open("a", encoding="utf-8") as f:
            f.write(line + "\n")


def _write_meta_json(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def _codex_home() -> Path:
    env = os.environ.get("CODEX_HOME", "").strip()
    if env:
        return Path(env).expanduser().resolve()
    return (Path.home() / ".codex").resolve()


def _opencode_runner() -> Path:
    return _codex_home() / "skills" / "opencode-cli-runner" / "scripts" / "run_opencode.sh"


def _claude_runner() -> Path:
    return _codex_home() / "skills" / "claude-cli-runner" / "scripts" / "run_claude.sh"


def _codex_runner() -> Path:
    return _codex_home() / "skills" / "codex-cli-runner" / "scripts" / "run_codex.sh"


def _gemini_runner() -> Path:
    return _codex_home() / "skills" / "gemini-cli-runner" / "scripts" / "run_gemini.sh"


def _require_file(p: Path, *, label: str) -> None:
    if not p.is_file():
        raise FileNotFoundError(f"{label} not found: {p}")


def _sha256_file(path: Path, *, chunk_size: int = 1024 * 1024) -> str:
    h = sha256()
    with path.open("rb") as f:
        while True:
            chunk = f.read(chunk_size)
            if not chunk:
                break
            h.update(chunk)
    return h.hexdigest()


def _truncate_utf8_bytes_prefix(src: Path, dst: Path, *, max_bytes: int) -> dict[str, Any]:
    raw_prefix: bytes
    with src.open("rb") as f:
        raw_prefix = f.read(max_bytes)
    text_prefix = raw_prefix.decode("utf-8", errors="ignore")
    encoded_prefix = text_prefix.encode("utf-8")
    dst.parent.mkdir(parents=True, exist_ok=True)
    dst.write_bytes(encoded_prefix)
    return {
        "source_prefix_bytes": len(raw_prefix),
        "source_prefix_sha256": sha256(raw_prefix).hexdigest(),
        "dropped_invalid_utf8_bytes": len(raw_prefix) - len(encoded_prefix),
    }


def _truncate_utf8_chars_prefix(src: Path, dst: Path, *, max_chars: int, read_chunk_size: int = 64 * 1024) -> None:
    decoder = codecs.getincrementaldecoder("utf-8")(errors="replace")
    written = 0
    dst.parent.mkdir(parents=True, exist_ok=True)
    with src.open("rb") as fin, dst.open("w", encoding="utf-8") as fout:
        while written < max_chars:
            chunk = fin.read(read_chunk_size)
            if not chunk:
                tail = decoder.decode(b"", final=True)
                if tail:
                    remaining = max_chars - written
                    fout.write(tail[:remaining])
                break
            text = decoder.decode(chunk)
            if not text:
                continue
            remaining = max_chars - written
            if len(text) <= remaining:
                fout.write(text)
                written += len(text)
                continue
            fout.write(text[:remaining])
            break


def _detect_overflow_utf8_chars(src: Path, *, max_chars: int, read_chunk_size: int = 64 * 1024) -> bool:
    decoder = codecs.getincrementaldecoder("utf-8")(errors="replace")
    seen = 0
    with src.open("rb") as fin:
        while True:
            chunk = fin.read(read_chunk_size)
            if not chunk:
                tail = decoder.decode(b"", final=True)
                seen += len(tail)
                return seen > max_chars
            text = decoder.decode(chunk)
            seen += len(text)
            if seen > max_chars:
                return True


def _apply_prompt_limit(
    src: Path,
    *,
    label: str,
    out_dir: Path,
    trace_path: Path,
    max_bytes: Optional[int],
    max_chars: Optional[int],
    overflow: str,
) -> Path:
    src_bytes = src.stat().st_size

    if max_bytes is not None:
        within = src_bytes <= max_bytes
        limit_meta = {"type": "bytes", "value": max_bytes}
        exceeds = not within
    else:
        limit_meta = {"type": "chars", "value": max_chars}
        exceeds = _detect_overflow_utf8_chars(src, max_chars=max_chars or 0)

    if not exceeds:
        info = {
            "label": label,
            "path": str(src),
            "bytes": src_bytes,
            "limit": limit_meta,
            "overflow": overflow,
            "action": "none",
        }
        _append_jsonl(trace_path, {"ts": _utc_now(), "event": "prompt_guard_file", **info})
        return src

    if overflow == "fail":
        info = {
            "label": label,
            "path": str(src),
            "bytes": src_bytes,
            "limit": limit_meta,
            "overflow": overflow,
            "action": "fail",
            "reason": "prompt exceeds configured limit",
        }
        _append_jsonl(trace_path, {"ts": _utc_now(), "event": "prompt_guard_violation", **info})
        raise ValueError(f"{label} exceeds configured prompt limit ({limit_meta['type']}={limit_meta['value']}): {src}")

    suffix = src.suffix or ".txt"
    dst = out_dir / f"{label}.truncated{suffix}"
    trunc_meta: dict[str, Any] = {}
    if max_bytes is not None:
        trunc_meta = _truncate_utf8_bytes_prefix(src, dst, max_bytes=max_bytes)
    else:
        _truncate_utf8_chars_prefix(src, dst, max_chars=max_chars or 0)

    dst_bytes = dst.stat().st_size
    info = {
        "label": label,
        "path": str(src),
        "bytes": src_bytes,
        "limit": limit_meta,
        "overflow": overflow,
        "action": "truncate",
        "truncated_path": str(dst),
        "truncated_bytes": dst_bytes,
        "truncated_sha256": _sha256_file(dst),
    }
    info.update(trunc_meta)
    _append_jsonl(trace_path, {"ts": _utc_now(), "event": "prompt_guard_truncate", **info})
    return dst


def _read_opencode_config() -> dict[str, Any]:
    config_path = Path.home() / ".config" / "opencode" / "opencode.json"
    if not config_path.exists():
        return {}
    try:
        parsed = json.loads(config_path.read_text(encoding="utf-8"))
        return parsed if isinstance(parsed, dict) else {}
    except Exception:
        return {}


def _get_available_models() -> list[str]:
    config = _read_opencode_config()
    models: list[str] = []

    default = config.get("model")
    if isinstance(default, str) and default.strip():
        models.append(default.strip())

    providers = config.get("provider")
    if not isinstance(providers, dict):
        # Some configs use "providers"; keep compatibility.
        providers = config.get("providers") if isinstance(config.get("providers"), dict) else {}

    for provider_name, provider_config in providers.items():
        if not isinstance(provider_name, str) or not isinstance(provider_config, dict):
            continue
        provider_models = provider_config.get("models")
        if not isinstance(provider_models, dict):
            continue
        for model_key in provider_models.keys():
            if not isinstance(model_key, str) or not model_key.strip():
                continue
            model_id = f"{provider_name}/{model_key}"
            if model_id not in models:
                models.append(model_id)

    if not models:
        # Do not guess a historical model name; delegate model resolution
        # to the backend CLI default.
        models.append("default")
    return models


def _is_blank_file(path: Path) -> bool:
    if not path.exists() or not path.is_file():
        return True
    try:
        return not bool(path.read_text(encoding="utf-8", errors="replace").strip())
    except Exception:
        return True


def _word_set(text: str) -> set[str]:
    return set(re.findall(r"[A-Za-z0-9_]+", text.lower()))


def _compute_similarity(paths: list[Path]) -> dict[str, Any]:
    contents: list[str] = []
    for p in paths:
        if not p.exists():
            contents.append("")
            continue
        try:
            contents.append(p.read_text(encoding="utf-8", errors="replace").strip())
        except Exception:
            contents.append("")

    if len(contents) < 2:
        return {"similarity": "insufficient_data", "method": "jaccard"}

    word_sets = [_word_set(c) for c in contents]
    union = set.union(*word_sets) if word_sets else set()
    intersection = set.intersection(*word_sets) if word_sets else set()

    if not union:
        return {
            "similarity": 0.0,
            "method": "jaccard",
            "pairwise_mean": 0.0,
            "pairwise_min": 0.0,
            "pairwise_max": 0.0,
            "unique_words": 0,
            "intersection_words": 0,
            "n_texts": len(contents),
        }

    pairwise_scores: list[float] = []
    for left, right in itertools.combinations(word_sets, 2):
        pair_union = left | right
        if not pair_union:
            pairwise_scores.append(0.0)
            continue
        pairwise_scores.append(len(left & right) / len(pair_union))

    pairwise_mean = sum(pairwise_scores) / len(pairwise_scores) if pairwise_scores else 0.0
    return {
        "similarity": pairwise_mean,
        "method": "jaccard",
        "pairwise_mean": pairwise_mean,
        "pairwise_min": min(pairwise_scores) if pairwise_scores else 0.0,
        "pairwise_max": max(pairwise_scores) if pairwise_scores else 0.0,
        "global_intersection_over_union": len(intersection) / len(union),
        "unique_words": len(union),
        "intersection_words": len(intersection),
        "n_texts": len(contents),
    }


def _model_slug(model: str) -> str:
    slug = _RE_MODEL_SLUG.sub("_", model).strip("._-")
    return slug or "default"


def _normalize_model_arg(raw: str) -> Optional[str]:
    value = str(raw).strip()
    if not value or value.lower() == "default":
        return None
    return value


def _split_csv(raw: str) -> list[str]:
    return [x.strip() for x in str(raw).split(",") if x.strip()]


def _parse_backend_assignments(
    values: list[str],
    *,
    flag: str,
    allowed_backends: set[str],
    allow_none: bool = False,
) -> dict[str, Optional[str]]:
    parsed: dict[str, Optional[str]] = {}
    for raw in values:
        entry = str(raw).strip()
        if not entry:
            continue
        if "=" not in entry:
            raise ValueError(f"{flag} expects backend=value, got: {entry!r}")
        backend_raw, value_raw = entry.split("=", 1)
        backend = backend_raw.strip().lower()
        value = value_raw.strip()

        if backend not in allowed_backends:
            raise ValueError(f"{flag} has unknown backend: {backend!r}")
        if backend in parsed:
            raise ValueError(f"{flag} duplicate backend assignment: {backend!r}")

        if allow_none and value.lower() == "none":
            parsed[backend] = None
            continue
        if not value:
            raise ValueError(f"{flag} has empty value for backend: {backend!r}")
        parsed[backend] = value
    return parsed


def _mapping_to_assignment_list(
    obj: Any,
    *,
    field: str,
    source: Path,
    allow_none: bool,
) -> list[str]:
    if not isinstance(obj, dict):
        raise ValueError(f"{source}: '{field}' must be a JSON object mapping backend->value")
    out: list[str] = []
    for backend_raw, value in obj.items():
        if not isinstance(backend_raw, str) or not backend_raw.strip():
            raise ValueError(f"{source}: '{field}' has non-string/empty backend key")
        backend = backend_raw.strip().lower()
        if allow_none and value is None:
            out.append(f"{backend}=none")
            continue
        if not isinstance(value, str) or not value.strip():
            raise ValueError(f"{source}: '{field}.{backend}' must be a non-empty string")
        out.append(f"{backend}={value.strip()}")
    return out


def _expand_backend_prompt_json_entries(values: list[str]) -> tuple[list[str], list[str], list[str]]:
    prompt_entries: list[str] = []
    system_entries: list[str] = []
    output_entries: list[str] = []
    for raw in values:
        entry = str(raw).strip()
        if not entry:
            continue
        if not entry.startswith("@"):
            prompt_entries.append(entry)
            continue

        raw_path = entry[1:].strip()
        if not raw_path:
            raise ValueError("--backend-prompt @json requires a file path after '@'")
        json_path = Path(raw_path).expanduser().resolve()
        _require_file(json_path, label="backend prompt JSON config")

        try:
            payload = json.loads(json_path.read_text(encoding="utf-8"))
        except Exception as exc:
            raise ValueError(f"Failed to parse backend prompt JSON config {json_path}: {exc}") from exc
        if not isinstance(payload, dict):
            raise ValueError(f"{json_path}: root must be a JSON object")

        has_batch_keys = any(k in payload for k in ("prompt", "system", "output"))
        if has_batch_keys:
            extra_keys = [k for k in payload.keys() if k not in {"prompt", "system", "output"}]
            if extra_keys:
                raise ValueError(f"{json_path}: unsupported top-level keys: {','.join(sorted(map(str, extra_keys)))}")
            if "prompt" in payload:
                prompt_entries.extend(
                    _mapping_to_assignment_list(payload["prompt"], field="prompt", source=json_path, allow_none=False)
                )
            if "system" in payload:
                system_entries.extend(
                    _mapping_to_assignment_list(payload["system"], field="system", source=json_path, allow_none=True)
                )
            if "output" in payload:
                output_entries.extend(
                    _mapping_to_assignment_list(payload["output"], field="output", source=json_path, allow_none=False)
                )
        else:
            # Shorthand form: {"gemini": "/path/to/prompt.txt", ...}
            prompt_entries.extend(
                _mapping_to_assignment_list(payload, field="prompt", source=json_path, allow_none=False)
            )
    return prompt_entries, system_entries, output_entries


def _resolve_output_override_path(raw: str, *, out_dir: Path) -> Path:
    p = Path(raw).expanduser()
    if p.is_absolute():
        return p.resolve()
    return (out_dir / p).resolve()


class AgentPlan:
    __slots__ = ("index", "backend", "requested_model", "runner_model", "runner_path")

    def __init__(
        self,
        *,
        index: int,
        backend: str,
        requested_model: str,
        runner_model: Optional[str],
        runner_path: Path,
    ) -> None:
        self.index = index
        self.backend = backend
        self.requested_model = requested_model
        self.runner_model = runner_model
        self.runner_path = runner_path


def _classify_model(model: str) -> tuple[str, Optional[str]]:
    m = model.strip()
    if not m or m == "default":
        return "opencode", None
    if m.startswith("claude/"):
        runner_model = m.split("/", 1)[1].strip()
        if not runner_model or runner_model == "default":
            return "claude", None
        return "claude", runner_model
    if m.startswith("codex/"):
        runner_model = m.split("/", 1)[1].strip()
        if not runner_model or runner_model == "default":
            return "codex", None
        return "codex", runner_model
    if m.startswith("gemini/"):
        runner_model = m.split("/", 1)[1].strip()
        if not runner_model or runner_model == "default":
            return "gemini", None
        return "gemini", runner_model
    return "opencode", m


def _select_models(args: argparse.Namespace) -> list[str]:
    if args.models:
        models = [m.strip() for m in args.models.split(",") if m.strip()]
    elif args.model:
        if args.model == "default":
            models = ["default"]
        else:
            models = [args.model.strip()]
    else:
        if args.agents <= 0:
            raise ValueError("--agents must be a positive integer")
        pool = _get_available_models()
        models = [pool[i % len(pool)] for i in range(args.agents)]

    models = [m for m in models if m]
    if not models:
        raise ValueError("No models specified. Use --agents N, --models a,b,c, or --model default.")
    return models


def _build_plans(
    models: list[str],
    *,
    opencode_runner: Path,
    claude_runner: Path,
    codex_runner: Path,
    gemini_runner: Path,
) -> list[AgentPlan]:
    plans: list[AgentPlan] = []
    for i, model in enumerate(models):
        backend, runner_model = _classify_model(model)
        if backend == "opencode":
            runner_path = opencode_runner
        elif backend == "claude":
            runner_path = claude_runner
        elif backend == "codex":
            runner_path = codex_runner
        else:
            runner_path = gemini_runner
        plans.append(
            AgentPlan(
                index=i,
                backend=backend,
                requested_model=model,
                runner_model=runner_model,
                runner_path=runner_path,
            )
        )
    return plans


def _validate_runners(plans: list[AgentPlan]) -> None:
    checked: set[Path] = set()
    labels = {
        "opencode": "OpenCode runner",
        "claude": "Claude runner",
        "codex": "Codex runner",
        "gemini": "Gemini runner",
    }
    for plan in plans:
        if plan.runner_path in checked:
            continue
        _require_file(plan.runner_path, label=labels.get(plan.backend, "Runner"))
        checked.add(plan.runner_path)


def _build_cmd(
    *,
    plan: AgentPlan,
    system: Optional[Path],
    prompt: Path,
    out: Path,
    opencode_agent: Optional[str],
    opencode_variant: Optional[str],
    gemini_cli_home: Optional[str],
) -> list[str]:
    cmd = ["bash", str(plan.runner_path)]
    if system is not None:
        cmd.extend(["--system-prompt-file", str(system)])
    cmd.extend(
        [
            "--prompt-file",
            str(prompt),
            "--out",
            str(out),
        ]
    )
    if plan.runner_model:
        cmd.extend(["--model", plan.runner_model])
    if plan.backend == "opencode":
        if opencode_agent:
            cmd.extend(["--agent", opencode_agent])
        if opencode_variant:
            cmd.extend(["--variant", opencode_variant])
    if plan.backend == "gemini" and gemini_cli_home:
        cmd.extend(["--gemini-cli-home", gemini_cli_home])
    return cmd


def _run_one(
    *,
    plan: AgentPlan,
    out_dir: Path,
    output_prefix: str,
    system: Optional[Path],
    prompt: Path,
    trace_path: Path,
    opencode_agent: Optional[str],
    opencode_variant: Optional[str],
    gemini_cli_home: Optional[str],
    output_path: Optional[Path] = None,
) -> dict[str, Any]:
    out_path = output_path or (out_dir / f"{output_prefix}_{plan.index + 1}_{_model_slug(plan.requested_model)}.txt")
    out_path.parent.mkdir(parents=True, exist_ok=True)
    cmd = _build_cmd(
        plan=plan,
        system=system,
        prompt=prompt,
        out=out_path,
        opencode_agent=opencode_agent,
        opencode_variant=opencode_variant,
        gemini_cli_home=gemini_cli_home,
    )

    _append_jsonl(
        trace_path,
        {
            "ts": _utc_now(),
            "event": f"agent_{plan.index}_start",
            "index": plan.index,
            "backend": plan.backend,
            "model": plan.requested_model,
            "cmd": cmd,
        },
    )

    try:
        proc = subprocess.run(cmd, check=False, capture_output=True, text=True)
        result = {
            "index": plan.index,
            "backend": plan.backend,
            "model": plan.requested_model,
            "runner_model": plan.runner_model,
            "exit_code": proc.returncode,
            "success": proc.returncode == 0,
            "out": str(out_path),
        }
        event: dict[str, Any] = {
            "ts": _utc_now(),
            "event": f"agent_{plan.index}_end",
            "index": plan.index,
            "backend": plan.backend,
            "model": plan.requested_model,
            "exit_code": proc.returncode,
        }
        if proc.stderr:
            event["stderr_preview"] = proc.stderr[:800]
        _append_jsonl(trace_path, event)
        return result
    except Exception as exc:
        _append_jsonl(
            trace_path,
            {
                "ts": _utc_now(),
                "event": f"agent_{plan.index}_error",
                "index": plan.index,
                "backend": plan.backend,
                "model": plan.requested_model,
                "error": str(exc),
            },
        )
        return {
            "index": plan.index,
            "backend": plan.backend,
            "model": plan.requested_model,
            "runner_model": plan.runner_model,
            "exit_code": 2,
            "success": False,
            "error": str(exc),
            "out": str(out_path),
        }


def _default_output_path(*, plan: AgentPlan, out_dir: Path, output_prefix: str) -> Path:
    return out_dir / f"{output_prefix}_{plan.index + 1}_{_model_slug(plan.requested_model)}.txt"


def _effective_output_path(
    *,
    plan: AgentPlan,
    out_dir: Path,
    output_prefix: str,
    output_overrides: dict[str, Path],
) -> Path:
    return output_overrides.get(plan.backend, _default_output_path(plan=plan, out_dir=out_dir, output_prefix=output_prefix))


def _effective_system_path(
    *,
    backend: str,
    default_system: Path,
    system_overrides: dict[str, Optional[Path]],
) -> Optional[Path]:
    return system_overrides.get(backend, default_system)


def _effective_prompt_path(
    *,
    backend: str,
    default_prompt: Path,
    prompt_overrides: dict[str, Path],
) -> Path:
    return prompt_overrides.get(backend, default_prompt)


def _postprocess_result(
    result: dict[str, Any],
    *,
    check_review_contract: bool,
) -> dict[str, Any]:
    out_path = Path(str(result.get("out", "")))
    backend = str(result.get("resolved", {}).get("backend") or result.get("backend") or "")

    if check_review_contract and out_path.exists():
        if backend == "gemini":
            sanitize_gemini_output(out_path)
        else:
            sanitize_contract_output(out_path)

    blank_output = _is_blank_file(out_path)
    result["blank_output"] = blank_output
    result["verdict"] = first_verdict(out_path) if out_path.exists() else None

    contract_ok: Optional[bool] = None
    contract_errors: list[str] = []
    if check_review_contract:
        contract_errors = check_review_contract_file(out_path)
        contract_ok = len(contract_errors) == 0
    result["contract_ok"] = contract_ok
    if contract_errors:
        result["contract_errors"] = contract_errors
    elif "contract_errors" in result:
        result.pop("contract_errors", None)

    command_success = bool(result.get("command_success", result.get("success", False)))
    failure_reason: Optional[str] = None
    if not command_success:
        failure_reason = f"exit_code_{result.get('exit_code', 'unknown')}"
    elif blank_output:
        failure_reason = "empty_output"
    # NOTE: contract_fail is informational only — does NOT trigger fallback.
    # Content matters more than format. Contract compliance is recorded in
    # contract_ok/contract_errors for downstream consumers but never blocks.

    result["failure_reason"] = failure_reason
    result["success"] = failure_reason is None
    return result


def _dual_review_summary(results: list[dict[str, Any]]) -> Optional[dict[str, Any]]:
    reviewer_a = None
    reviewer_b = None
    for r in results:
        req = r.get("requested")
        backend = req.get("backend") if isinstance(req, dict) else r.get("backend")
        if backend == "claude" and reviewer_a is None:
            reviewer_a = r
        if backend == "gemini" and reviewer_b is None:
            reviewer_b = r
    if reviewer_a is None or reviewer_b is None:
        return None

    a_resolved = reviewer_a.get("resolved", {}) if isinstance(reviewer_a.get("resolved"), dict) else {}
    b_resolved = reviewer_b.get("resolved", {}) if isinstance(reviewer_b.get("resolved"), dict) else {}
    diversity = "ok"
    if a_resolved.get("backend") == b_resolved.get("backend"):
        diversity = "degraded"

    return {
        "reviewer_a": {
            "requested": reviewer_a.get("requested"),
            "resolved": a_resolved,
            "variant": reviewer_a.get("variant"),
            "fallback_reason": reviewer_a.get("fallback_reason"),
        },
        "reviewer_b": {
            "requested": reviewer_b.get("requested"),
            "resolved": b_resolved,
            "variant": reviewer_b.get("variant"),
            "fallback_reason": reviewer_b.get("fallback_reason"),
        },
        "diversity": diversity,
    }



_CONFIG_FILENAME = "review-swarm.json"

# Keys in the project config that map to simple CLI args (string/bool/number).
# list/dict-valued keys (backend_system, backend_prompt, backend_output) need special handling.
_CONFIG_SIMPLE_KEYS: dict[str, str] = {
    "models": "models",
    "model": "model",
    "agents": "agents",
    "output_prefix": "output_prefix",
    "fallback_mode": "fallback_mode",
    "fallback_order": "fallback_order",
    "fallback_target_backends": "fallback_target_backends",
    "fallback_codex_model": "fallback_codex_model",
    "fallback_claude_model": "fallback_claude_model",
    "check_review_contract": "check_review_contract",
    "check_convergence": "check_convergence",
    "convergence_threshold": "convergence_threshold",
    "max_prompt_bytes": "max_prompt_bytes",
    "max_prompt_chars": "max_prompt_chars",
    "max_prompt_overflow": "max_prompt_overflow",
    "gemini_cli_home": "gemini_cli_home",
}


def _find_project_config(start: Path | None = None) -> Path | None:
    """Find review-swarm.json by walking up from *start* (default: CWD)
    to find the git root, then checking:
      1. meta/review-swarm.json  (development context — autoresearch-lab itself)
      2. .autoresearch/review-swarm.json  (research project managed by autoresearch-lab)
    Disabled when REVIEW_SWARM_NO_AUTO_CONFIG=1 (e.g. in tests)."""
    if os.environ.get("REVIEW_SWARM_NO_AUTO_CONFIG"):
        return None
    cur = (start or Path.cwd()).resolve()
    while True:
        if (cur / ".git").exists():
            for subdir in ("meta", ".autoresearch"):
                candidate = cur / subdir / _CONFIG_FILENAME
                if candidate.is_file():
                    return candidate
            return None
        parent = cur.parent
        if parent == cur:
            break
        cur = parent
    return None


def _load_project_config(explicit_path: str | None) -> dict[str, Any]:
    """Load project config from explicit path or auto-discovered file.
    Returns empty dict if nothing found."""
    if explicit_path:
        p = Path(explicit_path).expanduser().resolve()
        if not p.is_file():
            raise FileNotFoundError(f"--config file not found: {p}")
        cfg = json.loads(p.read_text(encoding="utf-8"))
        if not isinstance(cfg, dict):
            raise ValueError(f"--config must be a JSON object, got {type(cfg).__name__}")
        print(f"review-swarm: loaded config from {p}", file=sys.stderr)
        return cfg
    auto = _find_project_config()
    if auto:
        cfg = json.loads(auto.read_text(encoding="utf-8"))
        if not isinstance(cfg, dict):
            raise ValueError(f"{auto}: expected JSON object, got {type(cfg).__name__}")
        print(f"review-swarm: loaded project config from {auto}", file=sys.stderr)
        return cfg
    return {}


def _apply_config_defaults(args: argparse.Namespace, cfg: dict[str, Any]) -> None:
    """Merge project config into args where CLI didn't explicitly set a value.
    CLI args always win over config file values."""
    if not cfg:
        return
    for cfg_key, attr in _CONFIG_SIMPLE_KEYS.items():
        if cfg_key not in cfg:
            continue
        val = cfg[cfg_key]
        current = getattr(args, attr, None)
        # Detect "unset" CLI values: empty string, None, or argparse default False for store_true.
        if isinstance(current, str) and current == "":
            setattr(args, attr, str(val))
        elif current is None:
            setattr(args, attr, val)
        elif isinstance(current, bool) and not current and isinstance(val, bool) and val:
            setattr(args, attr, True)
    # Dict-valued: backend_system, backend_prompt, backend_output
    for dict_key, attr in [
        ("backend_system", "backend_system"),
        ("backend_prompt", "backend_prompt"),
        ("backend_output", "backend_output"),
    ]:
        if dict_key not in cfg:
            continue
        mapping = cfg[dict_key]
        if not isinstance(mapping, dict):
            continue
        existing = getattr(args, attr, []) or []
        # Only inject config entries that aren't already set by CLI.
        existing_backends = set()
        for entry in existing:
            if "=" in entry:
                existing_backends.add(entry.split("=", 1)[0].strip().lower())
        for backend, value in mapping.items():
            if backend.lower() not in existing_backends:
                existing.append(f"{backend}={value}")
        setattr(args, attr, existing)

def _parse_args() -> argparse.Namespace:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--out-dir", required=True, type=Path, help="Output directory for outputs + trace.")
    ap.add_argument(
        "--config",
        default=None,
        help=(
            "Path to project config JSON file. "
            "If omitted, auto-discovers meta/review-swarm.json from git root."
        ),
    )
    ap.add_argument(
        "--opencode-runner",
        default=None,
        type=Path,
        help="Optional override path to the OpenCode runner script.",
    )
    ap.add_argument(
        "--claude-runner",
        default=None,
        type=Path,
        help="Optional override path to the Claude runner script.",
    )
    ap.add_argument(
        "--codex-runner",
        default=None,
        type=Path,
        help="Optional override path to the Codex runner script.",
    )
    ap.add_argument(
        "--gemini-runner",
        default=None,
        type=Path,
        help="Optional override path to the Gemini runner script.",
    )
    ap.add_argument("--system", required=True, type=Path, help="System prompt file.")
    ap.add_argument("--prompt", required=True, type=Path, help="User prompt file.")

    model_group = ap.add_mutually_exclusive_group()
    model_group.add_argument(
        "--agents",
        type=int,
        default=2,
        help="Number of agents to run (default: 2). Rotates through available OpenCode models.",
    )
    model_group.add_argument(
        "--models",
        default="",
        help=(
            "Comma-separated model specs. "
            "OpenCode: provider/model or default. "
            "Other CLIs: claude/<model|default>, codex/<model|default>, gemini/<model|default>. "
            "Overrides --agents."
        ),
    )
    ap.add_argument(
        "--model",
        default="",
        help="Single OpenCode model for one agent. Use 'default' (or omit) to use OpenCode CLI default.",
    )
    ap.add_argument("--output-prefix", default="agent", help="Output filename prefix (default: agent).")

    ap.add_argument(
        "--agent",
        default="",
        help="Optional OpenCode agent name (e.g., sisyphus, oracle).",
    )
    ap.add_argument(
        "--variant",
        default="",
        help="Optional OpenCode model variant.",
    )
    ap.add_argument(
        "--gemini-cli-home",
        default="",
        help="Optional GEMINI_CLI_HOME override passed to gemini-cli-runner.",
    )
    ap.add_argument(
        "--backend-prompt",
        action="append",
        default=[],
        metavar="BACKEND=PATH|@CONFIG.json",
        help=(
            "Per-backend prompt override. Repeatable. "
            "Example: --backend-prompt gemini=/tmp/gemini_prompt.txt. "
            "Batch mode: --backend-prompt @overrides.json."
        ),
    )
    ap.add_argument(
        "--backend-system",
        action="append",
        default=[],
        metavar="BACKEND=PATH|none",
        help=(
            "Per-backend system override. Repeatable. "
            "Use 'none' to omit --system-prompt-file for that backend."
        ),
    )
    ap.add_argument(
        "--backend-output",
        action="append",
        default=[],
        metavar="BACKEND=PATH",
        help=(
            "Per-backend output path override. Repeatable. "
            "Relative paths are resolved under --out-dir."
        ),
    )

    guard = ap.add_mutually_exclusive_group()
    guard.add_argument("--max-prompt-bytes", type=int, help="Optional per-file max prompt size in bytes.")
    guard.add_argument("--max-prompt-chars", type=int, help="Optional per-file max prompt size in Unicode characters.")
    ap.add_argument(
        "--max-prompt-overflow",
        choices=["fail", "truncate"],
        default="fail",
        help="When prompt exceeds limit: fail-fast (default) or truncate.",
    )

    ap.add_argument(
        "--check-convergence",
        action="store_true",
        help="Check if outputs converge (similarity >= threshold).",
    )
    ap.add_argument(
        "--convergence-threshold",
        type=float,
        default=0.7,
        help="Jaccard similarity threshold for convergence (default: 0.7).",
    )
    ap.add_argument(
        "--check-review-contract",
        action="store_true",
        help="Validate strict review contract on each agent output after sanitization.",
    )
    ap.add_argument(
        "--fallback-mode",
        choices=["off", "ask", "auto"],
        default="off",
        help="Fallback behavior when a target backend output is invalid.",
    )
    ap.add_argument(
        "--fallback-order",
        default="codex,claude",
        help="Comma-separated fallback backend order for auto mode.",
    )
    ap.add_argument(
        "--fallback-target-backends",
        default="gemini",
        help="Comma-separated backends that can trigger fallback (default: gemini).",
    )
    ap.add_argument(
        "--fallback-codex-model",
        default="",
        help="Codex fallback model. Omit/default to use Codex CLI default.",
    )
    ap.add_argument(
        "--fallback-claude-model",
        default="",
        help="Claude fallback model. Omit/default to use Claude CLI default.",
    )

    parallel_group = ap.add_mutually_exclusive_group()
    parallel_group.add_argument(
        "--parallel",
        dest="parallel",
        action="store_true",
        default=True,
        help="Run agents in parallel (default).",
    )
    parallel_group.add_argument(
        "--no-parallel",
        dest="parallel",
        action="store_false",
        help="Run agents sequentially.",
    )

    args = ap.parse_args()

    # Load project config and apply as defaults (CLI args always win).
    cfg = _load_project_config(args.config)
    _apply_config_defaults(args, cfg)

    return args


def main() -> int:
    args = _parse_args()

    out_dir = args.out_dir.expanduser().resolve()
    out_dir.mkdir(parents=True, exist_ok=True)
    trace_path = out_dir / "trace.jsonl"
    meta_path = out_dir / "meta.json"

    opencode_runner = args.opencode_runner.expanduser().resolve() if args.opencode_runner else _opencode_runner()
    claude_runner = args.claude_runner.expanduser().resolve() if args.claude_runner else _claude_runner()
    codex_runner = args.codex_runner.expanduser().resolve() if args.codex_runner else _codex_runner()
    gemini_runner = args.gemini_runner.expanduser().resolve() if args.gemini_runner else _gemini_runner()

    system_prompt = args.system.expanduser().resolve()
    user_prompt = args.prompt.expanduser().resolve()
    gemini_cli_home = str(args.gemini_cli_home).strip() or None
    fallback_order = _split_csv(args.fallback_order)
    fallback_targets = set(_split_csv(args.fallback_target_backends))
    fallback_codex_model = _normalize_model_arg(args.fallback_codex_model)
    fallback_claude_model = _normalize_model_arg(args.fallback_claude_model)
    allowed_backends = {"opencode", "claude", "codex", "gemini"}
    backend_prompt_overrides: dict[str, Path] = {}
    backend_system_overrides: dict[str, Optional[Path]] = {}
    backend_output_overrides: dict[str, Path] = {}

    try:
        if args.max_prompt_bytes is not None and args.max_prompt_bytes <= 0:
            raise ValueError("--max-prompt-bytes must be a positive integer")
        if args.max_prompt_chars is not None and args.max_prompt_chars <= 0:
            raise ValueError("--max-prompt-chars must be a positive integer")
        if not (0.0 <= args.convergence_threshold <= 1.0):
            raise ValueError("--convergence-threshold must be between 0 and 1")
        if args.fallback_mode != "off" and not fallback_order:
            raise ValueError("--fallback-order must contain at least one backend when fallback is enabled")
        unknown_order = [b for b in fallback_order if b not in allowed_backends]
        if unknown_order:
            raise ValueError(f"Unknown fallback backend(s): {','.join(unknown_order)}")
        unknown_targets = [b for b in fallback_targets if b not in allowed_backends]
        if unknown_targets:
            raise ValueError(f"Unknown fallback target backend(s): {','.join(unknown_targets)}")

        prompt_entries, prompt_json_system_entries, prompt_json_output_entries = _expand_backend_prompt_json_entries(
            args.backend_prompt
        )
        raw_backend_prompt_overrides = _parse_backend_assignments(
            prompt_entries,
            flag="--backend-prompt",
            allowed_backends=allowed_backends,
            allow_none=False,
        )
        raw_backend_system_overrides = _parse_backend_assignments(
            [*prompt_json_system_entries, *args.backend_system],
            flag="--backend-system",
            allowed_backends=allowed_backends,
            allow_none=True,
        )
        raw_backend_output_overrides = _parse_backend_assignments(
            [*prompt_json_output_entries, *args.backend_output],
            flag="--backend-output",
            allowed_backends=allowed_backends,
            allow_none=False,
        )

        for backend, raw in raw_backend_prompt_overrides.items():
            p = Path(str(raw)).expanduser().resolve()
            _require_file(p, label=f"{backend} backend prompt override")
            backend_prompt_overrides[backend] = p

        for backend, raw in raw_backend_system_overrides.items():
            if raw is None:
                if backend == "claude":
                    raise ValueError("--backend-system claude=none is not supported")
                backend_system_overrides[backend] = None
                continue
            p = Path(str(raw)).expanduser().resolve()
            _require_file(p, label=f"{backend} backend system override")
            backend_system_overrides[backend] = p

        for backend, raw in raw_backend_output_overrides.items():
            backend_output_overrides[backend] = _resolve_output_override_path(str(raw), out_dir=out_dir)

        _require_file(system_prompt, label="System prompt")
        _require_file(user_prompt, label="User prompt")

        models = _select_models(args)
        plans = _build_plans(
            models,
            opencode_runner=opencode_runner,
            claude_runner=claude_runner,
            codex_runner=codex_runner,
            gemini_runner=gemini_runner,
        )
        backend_counts: dict[str, int] = {}
        for plan in plans:
            backend_counts[plan.backend] = backend_counts.get(plan.backend, 0) + 1
        colliding = sorted([b for b, c in backend_counts.items() if c > 1 and b in backend_output_overrides])
        if colliding:
            raise ValueError(
                "--backend-output does not support repeated backend assignments in one run: "
                + ",".join(colliding)
            )
        _validate_runners(plans)
        if args.fallback_mode == "auto":
            runner_checks = {
                "opencode": (opencode_runner, "OpenCode runner"),
                "claude": (claude_runner, "Claude runner"),
                "codex": (codex_runner, "Codex runner"),
                "gemini": (gemini_runner, "Gemini runner"),
            }
            for b in fallback_order:
                p, label = runner_checks[b]
                _require_file(p, label=label)
    except Exception as exc:
        _append_jsonl(trace_path, {"ts": _utc_now(), "event": "input_error", "error": str(exc)})
        print(f"ERROR: {exc}", file=sys.stderr)
        _write_meta_json(
            meta_path,
            {
                "schema_version": 1,
                "created_at": _utc_now(),
                "status": "input_error",
                "error": str(exc),
                "paths": {"trace": str(trace_path)},
            },
        )
        return 2

    if args.max_prompt_bytes is not None or args.max_prompt_chars is not None:
        _append_jsonl(
            trace_path,
            {
                "ts": _utc_now(),
                "event": "prompt_guard_config",
                "max_prompt_bytes": args.max_prompt_bytes,
                "max_prompt_chars": args.max_prompt_chars,
                "overflow": args.max_prompt_overflow,
            },
        )

        inputs_dir = out_dir / "inputs"
        try:
            system_prompt = _apply_prompt_limit(
                system_prompt,
                label="system",
                out_dir=inputs_dir,
                trace_path=trace_path,
                max_bytes=args.max_prompt_bytes,
                max_chars=args.max_prompt_chars,
                overflow=args.max_prompt_overflow,
            )
            user_prompt = _apply_prompt_limit(
                user_prompt,
                label="prompt",
                out_dir=inputs_dir,
                trace_path=trace_path,
                max_bytes=args.max_prompt_bytes,
                max_chars=args.max_prompt_chars,
                overflow=args.max_prompt_overflow,
            )
            for backend, override_prompt in list(backend_prompt_overrides.items()):
                backend_prompt_overrides[backend] = _apply_prompt_limit(
                    override_prompt,
                    label=f"{backend}_prompt",
                    out_dir=inputs_dir,
                    trace_path=trace_path,
                    max_bytes=args.max_prompt_bytes,
                    max_chars=args.max_prompt_chars,
                    overflow=args.max_prompt_overflow,
                )
            for backend, override_system in list(backend_system_overrides.items()):
                if override_system is None:
                    continue
                backend_system_overrides[backend] = _apply_prompt_limit(
                    override_system,
                    label=f"{backend}_system",
                    out_dir=inputs_dir,
                    trace_path=trace_path,
                    max_bytes=args.max_prompt_bytes,
                    max_chars=args.max_prompt_chars,
                    overflow=args.max_prompt_overflow,
                )
        except Exception as exc:
            _append_jsonl(trace_path, {"ts": _utc_now(), "event": "prompt_guard_error", "error": str(exc)})
            print(f"ERROR: {exc}", file=sys.stderr)
            _write_meta_json(
                meta_path,
                {
                    "schema_version": 1,
                    "created_at": _utc_now(),
                    "status": "prompt_guard_error",
                    "error": str(exc),
                    "paths": {"trace": str(trace_path)},
                },
            )
            return 2

    _append_jsonl(
        trace_path,
        {
            "ts": _utc_now(),
            "event": "config",
            "n_agents": len(plans),
            "models": [p.requested_model for p in plans],
            "backends": [p.backend for p in plans],
            "agent_name": args.agent or None,
            "variant": args.variant or None,
            "parallel": bool(args.parallel),
            "check_review_contract": bool(args.check_review_contract),
            "fallback_mode": args.fallback_mode,
            "fallback_order": fallback_order,
            "fallback_targets": sorted(fallback_targets),
            "backend_prompt_overrides": {k: str(v) for k, v in backend_prompt_overrides.items()},
            "backend_system_overrides": {k: (str(v) if v is not None else None) for k, v in backend_system_overrides.items()},
            "backend_output_overrides": {k: str(v) for k, v in backend_output_overrides.items()},
        },
    )

    results: list[dict[str, Any]] = []
    run_specs: list[tuple[AgentPlan, Optional[Path], Path, Path]] = []
    for plan in plans:
        run_specs.append(
            (
                plan,
                _effective_system_path(
                    backend=plan.backend,
                    default_system=system_prompt,
                    system_overrides=backend_system_overrides,
                ),
                _effective_prompt_path(
                    backend=plan.backend,
                    default_prompt=user_prompt,
                    prompt_overrides=backend_prompt_overrides,
                ),
                _effective_output_path(
                    plan=plan,
                    out_dir=out_dir,
                    output_prefix=args.output_prefix,
                    output_overrides=backend_output_overrides,
                ),
            )
        )

    if args.parallel:
        max_workers = min(len(plans), 32)
        with ThreadPoolExecutor(max_workers=max_workers) as executor:
            futures = {
                executor.submit(
                    _run_one,
                    plan=plan,
                    out_dir=out_dir,
                    output_prefix=args.output_prefix,
                    system=plan_system,
                    prompt=plan_prompt,
                    trace_path=trace_path,
                    opencode_agent=args.agent or None,
                    opencode_variant=args.variant or None,
                    gemini_cli_home=gemini_cli_home,
                    output_path=plan_out,
                ): (plan, plan_out)
                for plan, plan_system, plan_prompt, plan_out in run_specs
            }
            for future in as_completed(futures):
                plan, plan_out = futures[future]
                try:
                    results.append(future.result())
                except Exception as exc:
                    _append_jsonl(
                        trace_path,
                        {
                            "ts": _utc_now(),
                            "event": f"agent_{plan.index}_error",
                            "index": plan.index,
                            "backend": plan.backend,
                            "model": plan.requested_model,
                            "error": str(exc),
                        },
                    )
                    results.append(
                        {
                            "index": plan.index,
                            "backend": plan.backend,
                            "model": plan.requested_model,
                            "runner_model": plan.runner_model,
                            "exit_code": 2,
                            "success": False,
                            "error": str(exc),
                            "out": str(plan_out),
                        }
                    )
    else:
        for plan, plan_system, plan_prompt, plan_out in run_specs:
            results.append(
                _run_one(
                    plan=plan,
                    out_dir=out_dir,
                    output_prefix=args.output_prefix,
                    system=plan_system,
                    prompt=plan_prompt,
                    trace_path=trace_path,
                    opencode_agent=args.agent or None,
                    opencode_variant=args.variant or None,
                    gemini_cli_home=gemini_cli_home,
                    output_path=plan_out,
                )
            )

    results.sort(key=lambda x: x["index"])

    for r in results:
        requested = {"backend": str(r.get("backend")), "model": r.get("model")}
        r["requested"] = requested
        r["resolved"] = dict(requested)
        r["variant"] = "canonical"
        r["fallback_reason"] = None
        r["command_success"] = bool(r.get("success", False))
        _postprocess_result(r, check_review_contract=bool(args.check_review_contract))

    fallback_candidates = [
        r for r in results if r.get("failure_reason") and str((r.get("requested") or {}).get("backend")) in fallback_targets
    ]
    needs_user_decision = False
    if fallback_candidates:
        _append_jsonl(
            trace_path,
            {
                "ts": _utc_now(),
                "event": "fallback_needed",
                "mode": args.fallback_mode,
                "targets": [r.get("index") for r in fallback_candidates],
                "reasons": {str(r.get("index")): r.get("failure_reason") for r in fallback_candidates},
            },
        )
        if args.fallback_mode == "ask":
            needs_user_decision = True
        elif args.fallback_mode == "auto":
            runner_map = {
                "opencode": opencode_runner,
                "claude": claude_runner,
                "codex": codex_runner,
                "gemini": gemini_runner,
            }
            for r in fallback_candidates:
                original_reason = r.get("failure_reason")
                out_path = Path(str(r.get("out", "")))
                recovered = False
                for backend in fallback_order:
                    if backend == "opencode":
                        model = None
                        requested_model = "default"
                    elif backend == "codex":
                        model = fallback_codex_model
                        requested_model = f"codex/{model or 'default'}"
                    elif backend == "claude":
                        model = fallback_claude_model
                        requested_model = f"claude/{model or 'default'}"
                    elif backend == "gemini":
                        model = None
                        requested_model = "gemini/default"
                    else:
                        _append_jsonl(trace_path, {"ts": _utc_now(), "event": "fallback_backend_unknown", "backend": backend})
                        continue

                    plan = AgentPlan(
                        index=int(r["index"]),
                        backend=backend,
                        requested_model=requested_model,
                        runner_model=model,
                        runner_path=runner_map[backend],
                    )
                    _append_jsonl(
                        trace_path,
                        {
                            "ts": _utc_now(),
                            "event": "fallback_attempt",
                            "index": r.get("index"),
                            "from_backend": (r.get("resolved") or {}).get("backend"),
                            "to_backend": backend,
                            "to_model": model,
                            "reason": original_reason,
                        },
                    )
                    fb = _run_one(
                        plan=plan,
                        out_dir=out_dir,
                        output_prefix=args.output_prefix,
                        system=_effective_system_path(
                            backend=backend,
                            default_system=system_prompt,
                            system_overrides=backend_system_overrides,
                        ),
                        prompt=_effective_prompt_path(
                            backend=backend,
                            default_prompt=user_prompt,
                            prompt_overrides=backend_prompt_overrides,
                        ),
                        trace_path=trace_path,
                        opencode_agent=args.agent or None,
                        opencode_variant=args.variant or None,
                        gemini_cli_home=gemini_cli_home,
                        output_path=out_path,
                    )
                    r["resolved"] = {"backend": backend, "model": model}
                    r["variant"] = "fallback"
                    r["fallback_reason"] = original_reason
                    r["command_success"] = bool(fb.get("success", False))
                    r["exit_code"] = fb.get("exit_code")
                    r["out"] = fb.get("out", r.get("out"))
                    _postprocess_result(r, check_review_contract=bool(args.check_review_contract))
                    if r.get("success"):
                        recovered = True
                        break

                if not recovered:
                    _append_jsonl(
                        trace_path,
                        {
                            "ts": _utc_now(),
                            "event": "fallback_failed",
                            "index": r.get("index"),
                            "reason": original_reason,
                        },
                    )

    convergence_info = None
    if args.check_convergence:
        output_files = [
            Path(r["out"])
            for r in results
            if r.get("success") and Path(r["out"]).exists() and not _is_blank_file(Path(r["out"]))
        ]
        similarity = _compute_similarity(output_files)

        sim_value = similarity.get("similarity", 0)
        if isinstance(sim_value, str):
            sim_value = 0.0

        converged = float(sim_value) >= args.convergence_threshold
        convergence_info = {
            "threshold": args.convergence_threshold,
            "similarity": similarity,
            "converged": converged,
            "evaluated_outputs": [str(p) for p in output_files],
        }
        _append_jsonl(trace_path, {"ts": _utc_now(), "event": "convergence_check", **convergence_info})

    success_count = sum(1 for r in results if r.get("success", False))
    meta: dict[str, Any] = {
        "schema_version": 1,
        "created_at": _utc_now(),
        "n_agents": len(plans),
        "success_count": success_count,
        "failure_count": len(plans) - success_count,
        "models": [p.requested_model for p in plans],
        "agents": results,
        "paths": {
            "trace": str(trace_path),
            "outputs": [r.get("out", "") for r in results],
        },
    }
    if convergence_info is not None:
        meta["convergence"] = convergence_info
    dual_summary = _dual_review_summary(results)
    if dual_summary is not None:
        meta.update(dual_summary)
        paths = meta.get("paths", {})
        if isinstance(paths, dict):
            a_req = (dual_summary.get("reviewer_a") or {}).get("requested") or {}
            b_req = (dual_summary.get("reviewer_b") or {}).get("requested") or {}
            a_idx = next((r["index"] for r in results if r.get("requested") == a_req), None)
            b_idx = next((r["index"] for r in results if r.get("requested") == b_req), None)
            if isinstance(a_idx, int):
                paths["reviewer_a_output"] = results[a_idx].get("out")
            if isinstance(b_idx, int):
                paths["reviewer_b_output"] = results[b_idx].get("out")

    _write_meta_json(meta_path, meta)

    if needs_user_decision:
        print(
            "One or more fallback targets produced invalid output.\n"
            f"Re-run with --fallback-mode auto --fallback-order {','.join(fallback_order)} "
            "or --fallback-mode off.",
            file=sys.stderr,
        )
        return _EXIT_NEEDS_USER_DECISION
    if success_count == 0:
        return 2
    if success_count < len(plans):
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
