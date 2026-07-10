#!/usr/bin/env python3
# CONTRACT-EXEMPT: CODE-01.1 sunset:2026-12-01 — kept as a single stable launcher facade: two external
# consumers pin this file by path (skills/derivation-verify/scripts/run_multi_backend.py and
# skills/idea-pairwise-match/scripts/run_panel.py), and review_one.py delegates into main() so there is
# exactly one orchestration path. Mechanical extraction into backend modules is deferred until a consumer
# actually needs modularity; splitting now would only churn the pinned path without any consumer benefit.
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
import contextlib
import itertools
import json
import os
import re
import signal
import shutil
import subprocess
import sys
import tempfile
import threading
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
from hashlib import sha256
from pathlib import Path
from typing import Any, Optional


_TRACE_LOCK = threading.Lock()
_RE_MODEL_SLUG = re.compile(r"[^A-Za-z0-9._-]+")
_EXIT_NEEDS_USER_DECISION = 4
_DEFAULT_TIMEOUT_SECS = 900
_DEFAULT_BACKEND_TOOL_MODES = {
    "claude": "none",
    "gemini": "none",
    "opencode": "none",
}
_ALLOWED_BACKEND_TOOL_MODES = {
    "claude": {"none", "review"},
    "gemini": {"none", "review"},
    "opencode": {"none", "workspace"},
}
_GEMINI_OAUTH_BRIDGE_FILES = (
    "oauth_creds.json",
    "google_accounts.json",
)

_SCRIPT_DIR = Path(__file__).resolve().parent
if str(_SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(_SCRIPT_DIR))

from review_contract import (
    check_review_contract_file,
    check_two_phase_conformance,
    declared_criteria_categories,
    extract_review_criteria_block,
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


def _write_json_file(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def _atomic_write_text(path: Path, text: str) -> None:
    """Write *text* to *path* atomically (temp file in the same dir + rename)."""
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp_name = tempfile.mkstemp(dir=str(path.parent), prefix=f"{path.name}.", suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(text)
        os.replace(tmp_name, path)
    except Exception:
        with contextlib.suppress(OSError):
            os.unlink(tmp_name)
        raise


def _agent_skills_root() -> Path:
    """Host-neutral agent skills root holding the sibling runner skills.

    No single host is privileged: honor an explicitly advertised host home
    (CLAUDE_CONFIG_DIR / CODEX_HOME) when set, else probe the known agent skill
    homes that actually exist, else fall back to this script's own install
    location (which also covers hosts not listed here). Explicit `--*-runner`
    flags override the result entirely.
    """
    for env_var in ("CLAUDE_CONFIG_DIR", "CODEX_HOME"):
        val = os.environ.get(env_var, "").strip()
        if val:
            return (Path(val).expanduser() / "skills").resolve()
    for home in ("~/.claude", "~/.codex", "~/.config/opencode", "~/.kimi-code"):
        root = Path(home).expanduser() / "skills"
        if root.is_dir():
            return root.resolve()
    return Path(__file__).resolve().parents[3]


def _opencode_runner() -> Path:
    return _agent_skills_root() / "opencode-cli-runner" / "scripts" / "run_opencode.sh"


def _claude_runner() -> Path:
    return _agent_skills_root() / "claude-cli-runner" / "scripts" / "run_claude.sh"


def _codex_runner() -> Path:
    return _agent_skills_root() / "codex-cli-runner" / "scripts" / "run_codex.sh"


def _gemini_runner() -> Path:
    return _agent_skills_root() / "gemini-cli-runner" / "scripts" / "run_gemini.sh"


def _kimi_runner() -> Path:
    return _agent_skills_root() / "kimi-cli-runner" / "scripts" / "run_kimi.sh"


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


def _resolve_backend_tool_mode(backend: str, overrides: dict[str, str]) -> Optional[str]:
    if backend in overrides:
        return overrides[backend]
    return _DEFAULT_BACKEND_TOOL_MODES.get(backend)


def _load_default_gemini_oauth_auth() -> Optional[dict[str, Any]]:
    settings_path = Path.home() / ".gemini" / "settings.json"
    if not settings_path.is_file():
        return None
    try:
        payload = json.loads(settings_path.read_text(encoding="utf-8"))
    except Exception:
        return None

    security = payload.get("security")
    if not isinstance(security, dict):
        return None
    auth = security.get("auth")
    if not isinstance(auth, dict):
        return None
    selected_type = auth.get("selectedType")
    if not isinstance(selected_type, str) or not selected_type.startswith("oauth"):
        return None
    return auth


def _copy_default_gemini_oauth_support_files(home_root: Path) -> list[str]:
    source_root = Path.home() / ".gemini"
    target_root = home_root / ".gemini"
    copied: list[str] = []
    for name in _GEMINI_OAUTH_BRIDGE_FILES:
        src = source_root / name
        if not src.is_file():
            continue
        target_root.mkdir(parents=True, exist_ok=True)
        shutil.copy2(src, target_root / name)
        copied.append(name)
    return copied


def _write_gemini_review_settings(home_root: Path) -> tuple[Path, dict[str, Any], Optional[dict[str, Any]]]:
    settings_payload: dict[str, Any] = {
        "mcp": {
            "allowed": [],
        },
        "mcpServers": {},
    }
    auth_bridge: Optional[dict[str, Any]] = None
    oauth_auth = _load_default_gemini_oauth_auth()
    if oauth_auth is not None:
        settings_payload["security"] = {"auth": oauth_auth}
        auth_bridge = {
            "selected_type": oauth_auth.get("selectedType"),
            "copied_files": _copy_default_gemini_oauth_support_files(home_root),
            "source": str((Path.home() / ".gemini").resolve()),
        }
    settings_path = home_root / ".gemini" / "settings.json"
    _write_json_file(settings_path, settings_payload)
    return settings_path, settings_payload, auth_bridge


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
    if m.startswith("kimi/"):
        runner_model = m.split("/", 1)[1].strip()
        if not runner_model or runner_model == "default":
            return "kimi", None
        return "kimi", runner_model
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
    kimi_runner: Path,
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
        elif backend == "kimi":
            runner_path = kimi_runner
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
        "kimi": "Kimi runner",
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
    backend_tool_modes: dict[str, str],
    review_workspace_dir: Path,
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
    tool_mode = _resolve_backend_tool_mode(plan.backend, backend_tool_modes)
    if tool_mode:
        cmd.extend(["--tool-mode", tool_mode])
    if plan.backend == "opencode":
        if opencode_agent:
            cmd.extend(["--agent", opencode_agent])
        if opencode_variant:
            cmd.extend(["--variant", opencode_variant])
        if tool_mode == "workspace":
            cmd.append("--start-server")
            cmd.extend(["--workspace-dir", str(review_workspace_dir)])
    if plan.backend == "gemini" and gemini_cli_home:
        cmd.extend(["--gemini-cli-home", gemini_cli_home])
    return cmd


def _resolve_gemini_review_profile(
    *,
    plan: AgentPlan,
    out_dir: Path,
    backend_tool_modes: dict[str, str],
    explicit_gemini_cli_home: Optional[str],
) -> tuple[Optional[str], Optional[dict[str, Any]]]:
    if plan.backend != "gemini":
        return None, None

    tool_mode = _resolve_backend_tool_mode(plan.backend, backend_tool_modes)
    profile: dict[str, Any] = {
        "tool_mode": tool_mode,
    }
    if explicit_gemini_cli_home:
        profile.update(
            {
                "source": "explicit",
                "home": explicit_gemini_cli_home,
            }
        )
        return explicit_gemini_cli_home, profile

    if tool_mode != "review":
        profile["source"] = "default"
        return None, profile

    home_root = out_dir / "runtime" / "gemini_cli_home" / f"agent_{plan.index + 1}"
    settings_path, settings_payload, auth_bridge = _write_gemini_review_settings(home_root)
    profile.update(
        {
            "source": "auto_isolated_review",
            "home": str(home_root),
            "settings_path": str(settings_path),
            "settings_payload": settings_payload,
        }
    )
    if auth_bridge is not None:
        profile["auth_bridge"] = auth_bridge
    return str(home_root), profile


def _run_with_timeout(cmd: list[str], *, timeout_secs: int) -> dict[str, Any]:
    if timeout_secs <= 0:
        proc = subprocess.run(cmd, check=False, capture_output=True, text=True)
        return {
            "timed_out": False,
            "exit_code": proc.returncode,
            "stdout": proc.stdout,
            "stderr": proc.stderr,
        }

    proc = subprocess.Popen(
        cmd,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        start_new_session=True,
    )
    try:
        stdout, stderr = proc.communicate(timeout=timeout_secs)
        return {
            "timed_out": False,
            "exit_code": proc.returncode,
            "stdout": stdout,
            "stderr": stderr,
        }
    except subprocess.TimeoutExpired:
        with contextlib.suppress(ProcessLookupError):
            os.killpg(proc.pid, signal.SIGKILL)
        stdout, stderr = proc.communicate()
        return {
            "timed_out": True,
            "exit_code": None,
            "stdout": stdout,
            "stderr": stderr,
        }


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
    backend_tool_modes: dict[str, str],
    review_workspace_dir: Path,
    gemini_cli_home: Optional[str],
    gemini_review_profile: Optional[dict[str, Any]],
    timeout_secs: int,
    output_path: Optional[Path] = None,
    trace_phase: Optional[str] = None,
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
        backend_tool_modes=backend_tool_modes,
        review_workspace_dir=review_workspace_dir,
        gemini_cli_home=gemini_cli_home,
    )

    start_event: dict[str, Any] = {
        "ts": _utc_now(),
        "event": f"agent_{plan.index}_start",
        "index": plan.index,
        "backend": plan.backend,
        "model": plan.requested_model,
        "cmd": cmd,
    }
    if trace_phase is not None:
        start_event["phase"] = trace_phase
    _append_jsonl(trace_path, start_event)
    if gemini_review_profile is not None:
        _append_jsonl(
            trace_path,
            {
                "ts": _utc_now(),
                "event": f"agent_{plan.index}_gemini_profile",
                "index": plan.index,
                "backend": plan.backend,
                "model": plan.requested_model,
                "gemini_review_profile": gemini_review_profile,
            },
        )

    try:
        proc = _run_with_timeout(cmd, timeout_secs=timeout_secs)
        result = {
            "index": plan.index,
            "backend": plan.backend,
            "model": plan.requested_model,
            "runner_model": plan.runner_model,
            "exit_code": proc["exit_code"],
            "timed_out": bool(proc["timed_out"]),
            "success": bool((not proc["timed_out"]) and proc["exit_code"] == 0),
            "out": str(out_path),
        }
        if gemini_review_profile is not None:
            result["gemini_review_profile"] = gemini_review_profile
        event: dict[str, Any] = {
            "ts": _utc_now(),
            "event": f"agent_{plan.index}_end",
            "index": plan.index,
            "backend": plan.backend,
            "model": plan.requested_model,
            "exit_code": proc["exit_code"],
            "timed_out": bool(proc["timed_out"]),
        }
        if trace_phase is not None:
            event["phase"] = trace_phase
        if proc["stdout"]:
            event["stdout_preview"] = proc["stdout"][:800]
        if proc["stderr"]:
            event["stderr_preview"] = proc["stderr"][:800]
        _append_jsonl(trace_path, event)
        return result
    except Exception as exc:
        error_event: dict[str, Any] = {
            "ts": _utc_now(),
            "event": f"agent_{plan.index}_error",
            "index": plan.index,
            "backend": plan.backend,
            "model": plan.requested_model,
            "error": str(exc),
        }
        if trace_phase is not None:
            error_event["phase"] = trace_phase
        _append_jsonl(trace_path, error_event)
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


# --- Two-phase review protocol (opt-in via --two-phase) ---
#
# Phase 1 sends the scope packet only (no diff) and requires a declared-review-
# criteria commitment; phase 2 sends the full packet plus the reviewer's own
# phase-1 criteria block, verbatim. Conformance of phase-2 BLOCKING findings to
# the phase-1 commitment is machine-checked after the run (informational, same
# handling as the single-phase review-contract check).

_TWO_PHASE_DIR_NAME = "two_phase"

_TWO_PHASE_PHASE1_INSTRUCTIONS = """\
=== TWO-PHASE REVIEW - PHASE 1: CRITERIA COMMITMENT ===

You are one reviewer in a two-phase review protocol. In this phase you see ONLY
the change scope below (title, intent, changed-file list). The diff is
deliberately withheld until phase 2.

Declare, in advance, the review criteria you commit to applying when you later
see the diff. Output exactly one block delimited by these two sentinel lines,
each alone on its own line:

<review_criteria>
{
  "categories": [
    {"name": "<short category id>", "blocking_criteria": "<one sentence: what makes a finding BLOCKING in this category>"}
  ],
  "severity_scale": "<one sentence: the severity scale you commit to>"
}
</review_criteria>

Rules:
- "categories" must be a non-empty array; every entry needs a non-empty "name"
  and a non-empty "blocking_criteria".
- "severity_scale" must be a non-empty string.
- Base the categories on the declared scope only. Do not guess diff content,
  do not review anything yet, and do not ask for the diff.
- Brief reasoning outside the block is fine; the content between the two
  sentinel lines must be a single valid JSON object.

=== CHANGE SCOPE (no diff) ===

"""

_TWO_PHASE_PHASE2_INSTRUCTIONS = """\
=== TWO-PHASE REVIEW - PHASE 2: REVIEW PER YOUR DECLARED CRITERIA ===

You previously committed to the review criteria below (your own phase-1
declaration, verbatim). Review the change packet against those criteria.

Rules:
- Tag every BLOCKING finding with one of your declared category names: in
  Markdown output start each bullet under "## Blockers" with "[<category>]";
  in JSON output prefix each "blocking_issues" string entry with "[<category>]"
  (or give the entry object a "category" field).
- If the diff reveals a problem class your declared criteria did not
  anticipate, you MAY add a category, but you MUST declare the revision
  explicitly in the review body (after the verdict line): in Markdown output
  add a line "CRITERIA_REVISION: <category>: <one-line reason>"; in JSON
  output add "criteria_revisions": [{"category": "...", "reason": "..."}].
- A BLOCKING finding whose category is neither declared in phase 1 nor covered
  by a criteria revision declaration fails the machine conformance check.
- Do not weaken or reinterpret your phase-1 blocking criteria.

"""

_TWO_PHASE_CRITERIA_HEADER = "=== YOUR PHASE-1 DECLARED REVIEW CRITERIA (verbatim) ===\n\n"
_TWO_PHASE_CRITERIA_FOOTER = "\n\n=== END OF DECLARED CRITERIA ===\n\n=== REVIEW PACKET ===\n\n"


def _phase1_output_path(final_out: Path) -> Path:
    return final_out.with_name(f"{final_out.stem}.phase1{final_out.suffix or '.txt'}")


def _run_two_phase_one(
    *,
    plan: AgentPlan,
    out_dir: Path,
    output_prefix: str,
    system: Optional[Path],
    prompt: Path,
    trace_path: Path,
    opencode_agent: Optional[str],
    opencode_variant: Optional[str],
    backend_tool_modes: dict[str, str],
    review_workspace_dir: Path,
    gemini_cli_home: Optional[str],
    gemini_review_profile: Optional[dict[str, Any]],
    timeout_secs: int,
    output_path: Optional[Path] = None,
    scope_prompt: Path,
) -> dict[str, Any]:
    """Run one reviewer through the two-phase commit-then-review protocol.

    Phase 1 (scope packet, no diff) must yield a declared-review-criteria block;
    phase 2 (full packet + that block verbatim) writes the final output at the
    same path a single-phase run would use. Phase-1 failures skip phase 2 and
    mark the agent failed via ``two_phase.failure``.
    """
    final_out = output_path or _default_output_path(plan=plan, out_dir=out_dir, output_prefix=output_prefix)
    phase1_out = _phase1_output_path(final_out)
    slug = _model_slug(plan.requested_model)
    stage_dir = out_dir / _TWO_PHASE_DIR_NAME
    phase1_prompt_path = stage_dir / f"phase1_prompt_agent_{plan.index + 1}_{slug}.md"
    phase2_prompt_path = stage_dir / f"phase2_prompt_agent_{plan.index + 1}_{slug}.md"

    info: dict[str, Any] = {
        "enabled": True,
        "phase1_prompt": str(phase1_prompt_path),
        "phase1_out": str(phase1_out),
        "phase2_prompt": None,
        "phase1_exit_code": None,
        "phase1_timed_out": False,
        "criteria_ok": None,
        "criteria_errors": [],
        "declared_categories": [],
        "conformance_ok": None,
        "conformance_errors": [],
        "failure": None,
    }

    common: dict[str, Any] = dict(
        plan=plan,
        out_dir=out_dir,
        output_prefix=output_prefix,
        system=system,
        trace_path=trace_path,
        opencode_agent=opencode_agent,
        opencode_variant=opencode_variant,
        backend_tool_modes=backend_tool_modes,
        review_workspace_dir=review_workspace_dir,
        gemini_cli_home=gemini_cli_home,
        gemini_review_profile=gemini_review_profile,
        timeout_secs=timeout_secs,
    )

    def _phase_failure(base: dict[str, Any], failure: str) -> dict[str, Any]:
        info["failure"] = failure
        result = dict(base)
        result["out"] = str(final_out)
        result["success"] = False
        result["two_phase"] = info
        return result

    # Fresh-run hygiene for the two output files this protocol owns: a reused
    # out-dir must not let a stale phase-2 output from a previous run leak into
    # verdict/contract fields when this run's phase 2 is skipped.
    for stale in (phase1_out, final_out):
        with contextlib.suppress(FileNotFoundError):
            stale.unlink()

    scope_text = scope_prompt.read_text(encoding="utf-8", errors="replace")
    _atomic_write_text(phase1_prompt_path, _TWO_PHASE_PHASE1_INSTRUCTIONS + scope_text)

    r1 = _run_one(prompt=phase1_prompt_path, output_path=phase1_out, trace_phase="phase1", **common)
    info["phase1_exit_code"] = r1.get("exit_code")
    info["phase1_timed_out"] = bool(r1.get("timed_out"))

    if not r1.get("success"):
        return _phase_failure(r1, "phase1_command_failed")
    if _is_blank_file(phase1_out):
        return _phase_failure(r1, "phase1_empty_output")

    phase1_text = phase1_out.read_text(encoding="utf-8", errors="replace")
    criteria_block, criteria_obj, criteria_errors = extract_review_criteria_block(phase1_text)
    info["criteria_ok"] = len(criteria_errors) == 0
    info["criteria_errors"] = criteria_errors
    if criteria_obj is not None:
        info["declared_categories"] = declared_criteria_categories(criteria_obj)
    if criteria_errors or criteria_block is None:
        return _phase_failure(r1, "phase1_criteria_invalid")

    diff_text = prompt.read_text(encoding="utf-8", errors="replace")
    _atomic_write_text(
        phase2_prompt_path,
        _TWO_PHASE_PHASE2_INSTRUCTIONS
        + _TWO_PHASE_CRITERIA_HEADER
        + criteria_block.strip("\n")
        + _TWO_PHASE_CRITERIA_FOOTER
        + diff_text,
    )
    info["phase2_prompt"] = str(phase2_prompt_path)

    r2 = _run_one(prompt=phase2_prompt_path, output_path=final_out, trace_phase="phase2", **common)
    r2["two_phase"] = info
    return r2


def _finalize_two_phase_result(result: dict[str, Any], *, trace_path: Path) -> None:
    """Post-process one two-phase agent result (after _postprocess_result).

    Phase-1 failures override the generic failure_reason; successful runs get
    the phase-2 conformance check. Conformance failures are informational only
    (recorded in meta, never a fallback trigger), mirroring the single-phase
    review-contract check.
    """
    info = result.get("two_phase")
    if not isinstance(info, dict):
        return
    failure = info.get("failure")
    if failure:
        result["failure_reason"] = failure
        result["failure_class"] = _classify_failure(str(failure))
        result["success"] = False
    elif result.get("success"):
        phase1_path = Path(str(info.get("phase1_out", "")))
        phase2_path = Path(str(result.get("out", "")))
        try:
            phase1_text = phase1_path.read_text(encoding="utf-8", errors="replace")
            phase2_text = phase2_path.read_text(encoding="utf-8", errors="replace")
        except Exception as exc:
            info["conformance_ok"] = False
            info["conformance_errors"] = [f"failed to read phase outputs: {exc}"]
        else:
            conformance_errors = check_two_phase_conformance(phase1_text, phase2_text)
            info["conformance_ok"] = len(conformance_errors) == 0
            info["conformance_errors"] = conformance_errors
    _append_jsonl(
        trace_path,
        {
            "ts": _utc_now(),
            "event": f"agent_{result.get('index')}_two_phase",
            "index": result.get("index"),
            "criteria_ok": info.get("criteria_ok"),
            "criteria_errors": info.get("criteria_errors"),
            "conformance_ok": info.get("conformance_ok"),
            "conformance_errors": info.get("conformance_errors"),
            "failure": info.get("failure"),
        },
    )


# --- Failure classification (infrastructure vs content) ---
#
# An INFRASTRUCTURE failure means the backend never delivered reviewable
# content: the CLI timed out, crashed (nonzero exit), or exited 0 with an empty
# output file — including a failed/empty phase-1 call in the two-phase
# protocol. These are retry/outage signals. A CONTENT failure means the backend
# answered but the answer failed a protocol check (e.g. an unparseable phase-1
# criteria block); re-running is a judgment call, not an outage signal. The
# distinction keeps a degraded run legible as "backend down", never mistaken
# for review disagreement (same pattern as derivation-verify's backend
# availability tracker).
_INFRASTRUCTURE_FAILURE_REASONS = {
    "timeout",
    "empty_output",
    "phase1_command_failed",
    "phase1_empty_output",
}


def _classify_failure(failure_reason: Optional[str]) -> Optional[str]:
    if failure_reason is None:
        return None
    reason = str(failure_reason)
    if reason in _INFRASTRUCTURE_FAILURE_REASONS or reason.startswith("exit_code_"):
        return "infrastructure"
    # Everything else — e.g. phase1_criteria_invalid, and any unknown future
    # reason — is "content": misreading a disagreement as an outage would hide
    # review signal, which is the worse error.
    return "content"


def _unavailable_backend_summary(results: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Requested model specs whose every run this invocation failed at the
    infrastructure level (timeout / crash exit / empty output).

    A fallback-recovered run counts by its ORIGINAL failure (``fallback_reason``):
    the requested backend was still unreachable even if another backend covered
    for it. Specs listed here describe a backend outage, not review content."""
    reasons_by_spec: dict[str, list[Optional[str]]] = {}
    for r in results:
        requested = r.get("requested") if isinstance(r.get("requested"), dict) else {}
        spec = str(requested.get("model") or r.get("model") or "")
        if not spec:
            continue
        if r.get("variant") == "fallback":
            original_reason = r.get("fallback_reason")
        else:
            original_reason = r.get("failure_reason")
        reasons_by_spec.setdefault(spec, []).append(
            str(original_reason) if original_reason is not None else None
        )
    summary: list[dict[str, Any]] = []
    for spec in sorted(reasons_by_spec):
        reasons = reasons_by_spec[spec]
        if reasons and all(_classify_failure(reason) == "infrastructure" for reason in reasons):
            summary.append(
                {
                    "spec": spec,
                    "runs": len(reasons),
                    "failure_reasons": sorted({str(reason) for reason in reasons}),
                }
            )
    return summary


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
    if bool(result.get("timed_out")):
        failure_reason = "timeout"
    elif not command_success:
        failure_reason = f"exit_code_{result.get('exit_code', 'unknown')}"
    elif blank_output:
        failure_reason = "empty_output"
    # NOTE: contract_fail is informational only — does NOT trigger fallback.
    # Content matters more than format. Contract compliance is recorded in
    # contract_ok/contract_errors for downstream consumers but never blocks.

    result["failure_reason"] = failure_reason
    result["failure_class"] = _classify_failure(failure_reason)
    result["success"] = failure_reason is None
    return result


def _requested_backend(result: dict[str, Any]) -> str:
    req = result.get("requested")
    backend = req.get("backend") if isinstance(req, dict) else result.get("backend")
    return str(backend or "")


def _dual_review_summary(results: list[dict[str, Any]]) -> Optional[dict[str, Any]]:
    """Two-reviewer diversity summary over the first two reviewers (by index)
    whose REQUESTED backends differ — any backend pair counts, not a fixed
    seat assignment. Diversity degrades when the RESOLVED backends coincide
    (e.g. one reviewer fell back onto the other's backend)."""
    reviewer_a: Optional[dict[str, Any]] = None
    reviewer_b: Optional[dict[str, Any]] = None
    for r in results:
        if reviewer_a is None:
            reviewer_a = r
            continue
        if _requested_backend(r) != _requested_backend(reviewer_a):
            reviewer_b = r
            break
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



# --- Third-party agents file (family -> runner -> model-string mapping) ---
#
# Single update point for which model families exist on this machine, which
# execution route serves each family, and which model string each route takes.
# Schema, discovery order, and degradation semantics: docs/AGENTS_FILE.md.
# Deliberately self-contained (no shared parser library); the checked-in
# template docs/examples/agents.example.json is the shared parsing fixture
# that keeps this parser aligned with derivation-verify's.

_AGENTS_FILENAME = "agents.json"
_AGENTS_RUNNERS = {"native", "codex", "opencode", "kimi", "gemini", "claude-cli"}
# Runner label -> this launcher's backend name. `native` maps to no backend:
# the host runs its own family in-process, never through a CLI launcher.
_AGENTS_RUNNER_BACKEND = {
    "codex": "codex",
    "opencode": "opencode",
    "kimi": "kimi",
    "gemini": "gemini",
    "claude-cli": "claude",
}
_AGENTS_RUNNER_BINARY = {
    "codex": "codex",
    "opencode": "opencode",
    "kimi": "kimi",
    "gemini": "gemini",
    "claude-cli": "claude",
}
_FAMILY_SPEC_PREFIX = "family:"


def _validate_agents_roster(obj: Any, *, source: Any) -> dict[str, Any]:
    if not isinstance(obj, dict):
        raise ValueError(f"{source}: agents file root must be a JSON object")
    version = obj.get("version")
    if not isinstance(version, int) or isinstance(version, bool) or version != 1:
        raise ValueError(f"{source}: unsupported agents file version: {version!r} (expected the integer 1)")
    families = obj.get("families")
    if not isinstance(families, dict):
        raise ValueError(f"{source}: 'families' must be a JSON object")
    # One non-opencode CLI runner serves ONE model family (opencode is a multi-provider
    # gateway and may serve several). Two families on one dedicated runner, or two
    # families declaring the same (runner, model string), would make family attribution
    # ambiguous and could count one physical family twice in a cross-family gate — that
    # is a configuration contradiction, rejected here rather than guessed at later.
    runner_owner: dict[str, str] = {}
    seen_models: dict[tuple[str, str], str] = {}
    for name, fam in families.items():
        if not isinstance(name, str) or not name.strip():
            raise ValueError(f"{source}: family names must be non-empty strings")
        if name != name.strip().lower():
            # Family names travel through case-normalized channels (family: specs,
            # native family tags); a non-lowercase name would compare unequal to its
            # own normalized form and could label one physical family two ways.
            raise ValueError(f"{source}: family names must be lowercase: {name!r}")
        if not isinstance(fam, dict):
            raise ValueError(f"{source}: family {name!r} must be a JSON object")
        runner = fam.get("runner")
        if runner not in _AGENTS_RUNNERS:
            raise ValueError(
                f"{source}: family {name!r} has unknown runner {runner!r} "
                f"(expected one of: {', '.join(sorted(_AGENTS_RUNNERS))})"
            )
        if runner not in ("native", "opencode"):
            other = runner_owner.get(runner)
            if other is not None:
                raise ValueError(
                    f"{source}: families {other!r} and {name!r} both declare runner {runner!r}: "
                    "one dedicated execution route is one model family; merge them into one "
                    "family with multiple model tiers"
                )
            runner_owner[runner] = name
        models = fam.get("models", {})
        if not isinstance(models, dict):
            raise ValueError(f"{source}: family {name!r} 'models' must be a JSON object")
        for tier, value in models.items():
            if not isinstance(tier, str) or not tier.strip() or not isinstance(value, str) or not value.strip():
                raise ValueError(
                    f"{source}: family {name!r} model tiers must map non-empty strings to non-empty strings"
                )
            key = (str(runner), value.strip())
            other = seen_models.get(key)
            if other is not None and other != name:
                raise ValueError(
                    f"{source}: families {other!r} and {name!r} both declare model {value!r} "
                    f"on runner {runner!r}: one model string is one family"
                )
            seen_models[key] = name
        if "available" in fam and not isinstance(fam["available"], bool):
            raise ValueError(f"{source}: family {name!r} 'available' must be a boolean")
        if "notes" in fam and not isinstance(fam["notes"], str):
            raise ValueError(f"{source}: family {name!r} 'notes' must be a string")
    if "policy" in obj and not isinstance(obj["policy"], dict):
        raise ValueError(f"{source}: 'policy' must be a JSON object")
    policy = obj.get("policy") or {}
    minimum = policy.get("cross_family_minimum", 3)
    if isinstance(minimum, bool) or not isinstance(minimum, int) or minimum < 1:
        raise ValueError(f"{source}: policy.cross_family_minimum must be a positive integer")
    when_below = policy.get("when_below_minimum", "native_subagents")
    if when_below != "native_subagents":
        raise ValueError(
            f"{source}: policy.when_below_minimum must be \"native_subagents\" "
            "(the only value defined by schema version 1)"
        )
    return obj


def _find_agents_file(start: Path | None = None) -> tuple[Path | None, str]:
    """Auto-discover the agents file: project level <git-root>/.nullius/agents.json
    (same upward walk as review-swarm.json) first, then user level
    ~/.nullius/agents.json. Disabled when REVIEW_SWARM_NO_AUTO_CONFIG=1 (an
    explicit --agents-file bypasses this switch entirely)."""
    if os.environ.get("REVIEW_SWARM_NO_AUTO_CONFIG"):
        return None, "none"
    cur = (start or Path.cwd()).resolve()
    while True:
        if (cur / ".git").exists():
            candidate = cur / ".nullius" / _AGENTS_FILENAME
            if candidate.is_file():
                return candidate, "project"
            break
        parent = cur.parent
        if parent == cur:
            break
        cur = parent
    user_candidate = Path.home() / ".nullius" / _AGENTS_FILENAME
    if user_candidate.is_file():
        return user_candidate, "user"
    return None, "none"


def _load_agents_file(explicit: str | None) -> tuple[dict[str, Any] | None, str, Path | None]:
    """Load the agents file. Returns (roster or None, source, path or None).

    A missing file (no explicit path, nothing discovered) is the pure-native
    configuration and never an error. An explicit path that does not exist, or
    any file that fails to parse or validate, IS an input error: the run stops
    rather than silently continuing without the declared configuration."""
    if explicit:
        p = Path(explicit).expanduser().resolve()
        if not p.is_file():
            raise FileNotFoundError(f"--agents-file not found: {p}")
        roster = _validate_agents_roster(json.loads(p.read_text(encoding="utf-8")), source=p)
        return roster, "explicit", p
    found, source = _find_agents_file()
    if found is None:
        return None, "none", None
    roster = _validate_agents_roster(json.loads(found.read_text(encoding="utf-8")), source=found)
    return roster, source, found


def _resolve_family_spec(spec: str, roster: dict[str, Any] | None) -> str:
    """Resolve a family:<name>[:<tier>] spec into an explicit model spec via the
    agents file. Every failure is an explicit input error; a family spec is never
    silently reinterpreted, and an unusable family is never substituted."""
    body = spec[len(_FAMILY_SPEC_PREFIX):].strip()
    name, _, tier = body.partition(":")
    # Family names are lowercase by schema; normalize the request the same way.
    name = name.strip().lower()
    tier = tier.strip() or "default"
    if not name:
        raise ValueError(f"empty family spec: {spec!r}")
    if not roster:
        raise ValueError(
            f"model spec {spec!r} needs an agents file and none was found "
            "(pass --agents-file or create .nullius/agents.json; see docs/AGENTS_FILE.md)"
        )
    families = roster.get("families") or {}
    fam = families.get(name)
    if not isinstance(fam, dict):
        raise ValueError(
            f"agents file has no family {name!r} (declared: {', '.join(sorted(families)) or 'none'})"
        )
    if fam.get("available") is False:
        notes = str(fam.get("notes") or "").strip()
        raise ValueError(
            f"family {name!r} is declared unavailable in the agents file"
            + (f" ({notes})" if notes else "")
        )
    runner = str(fam.get("runner") or "")
    if runner == "native":
        raise ValueError(
            f"family {name!r} is declared native: it runs as the host's own subagents, "
            "not through this launcher"
        )
    if not _agents_runner_available(runner):
        raise ValueError(
            f"family {name!r} is declared available but its runner executable is not present "
            f"on this machine (runner {runner!r}); the family is honestly absent, never substituted"
        )
    models = fam.get("models") or {}
    model = models.get(tier)
    if not isinstance(model, str) or not model.strip():
        raise ValueError(
            f"family {name!r} has no model tier {tier!r} "
            f"(declared tiers: {', '.join(sorted(models)) or 'none'})"
        )
    model = model.strip()
    backend = _AGENTS_RUNNER_BACKEND[runner]
    if backend == "opencode":
        # OpenCode model strings already carry their provider/model prefix. A provider
        # segment that collides with a reserved launcher prefix would make _classify_model
        # re-route the agent to a DIFFERENT runner than the file declares — reject the
        # collision instead of silently overriding the declared runner.
        head = model.split("/", 1)[0].strip().lower()
        if head in ("claude", "codex", "gemini", "kimi") or model.lower().startswith(_FAMILY_SPEC_PREFIX):
            raise ValueError(
                f"family {name!r} declares opencode model {model!r} whose leading segment "
                "collides with a reserved launcher prefix (claude/, codex/, gemini/, kimi/, family:)"
            )
        return model
    return f"{backend}/{model}"


def _roster_family(backend: str, model: str, roster: dict[str, Any] | None) -> str:
    """Family label for one resolved (backend, model) execution, used by the
    independence record. Attribution works on the resolved execution: an exact
    model-string match against a declared tier wins; a runner used by exactly one
    declared family maps to that family; opencode model strings match by their
    provider/ prefix; anything the file cannot attribute keeps the backend name
    as its family label (the pre-agents-file behavior)."""
    if not roster:
        return backend
    families = roster.get("families") or {}
    m = (model or "").strip()
    if backend != "opencode" and m.startswith(backend + "/"):
        m = m.split("/", 1)[1]
    runner_families: list[str] = []
    for fam_name in sorted(families):
        fam = families[fam_name]
        if not isinstance(fam, dict):
            continue
        if _AGENTS_RUNNER_BACKEND.get(str(fam.get("runner") or "")) != backend:
            continue
        runner_families.append(fam_name)
        tiers = fam.get("models") or {}
        if m and isinstance(tiers, dict) and m in {str(v).strip() for v in tiers.values()}:
            return fam_name
    if backend != "opencode":
        if len(runner_families) == 1:
            return runner_families[0]
        return backend
    provider = m.split("/", 1)[0] if "/" in m else ""
    if provider:
        hits = [
            fam_name
            for fam_name in runner_families
            if any(
                "/" in str(v) and str(v).strip().split("/", 1)[0] == provider
                for v in (families[fam_name].get("models") or {}).values()
            )
        ]
        if len(hits) == 1:
            return hits[0]
    return backend


def _agents_runner_available(runner: str) -> bool:
    if runner == "native":
        return True
    binary = _AGENTS_RUNNER_BINARY.get(runner)
    return bool(binary and shutil.which(binary))


def _usable_families(roster: dict[str, Any]) -> list[str]:
    """Families that count as usable on this machine: declared available
    (`available` absent or true) AND the runner's executable actually exists
    (`native` always passes). Everything else is honestly absent."""
    out: list[str] = []
    for name in sorted(roster.get("families") or {}):
        fam = roster["families"][name]
        if not isinstance(fam, dict) or fam.get("available") is False:
            continue
        if _agents_runner_available(str(fam.get("runner") or "")):
            out.append(name)
    return out


def _resolved_family(result: dict[str, Any], roster: dict[str, Any] | None) -> str:
    resolved = result.get("resolved") if isinstance(result.get("resolved"), dict) else {}
    backend = str(resolved.get("backend") or result.get("backend") or "")
    model = resolved.get("model")
    return _roster_family(backend, str(model or ""), roster)


def _independence_summary(results: list[dict[str, Any]], roster: dict[str, Any] | None) -> dict[str, Any]:
    """Independence record for the run's outputs: which families actually
    produced output, at which independence level, and — when an agents file is
    in force — how that compares to the declared availability and the
    cross-family minimum. A degraded round must be visible as degraded; the
    launcher itself never blocks on this (falling back to the host's native
    subagent panel is the calling skill's move, per policy.when_below_minimum)."""
    participating = sorted({_resolved_family(r, roster) for r in results if r.get("success")})
    if len(participating) >= 2:
        level = "cross_family"
    elif len(participating) == 1:
        level = "single_family"
    else:
        level = "none"
    # The field set is identical on every path. Without an agents file the
    # declaration-relative fields are null — "nothing was declared", which is
    # different from an empty list ("everything declared participated").
    info: dict[str, Any] = {
        "level": level,
        "participating_families": participating,
        "declared_available_families": None,
        "absent_families": None,
        "cross_family_minimum": None,
        "below_minimum": None,
        "when_below_minimum": None,
    }
    if roster:
        declared = sorted(roster.get("families") or {})
        usable = _usable_families(roster)
        policy = roster.get("policy") or {}
        minimum = policy.get("cross_family_minimum", 3)
        info.update(
            {
                "declared_available_families": usable,
                "absent_families": [f for f in declared if f not in participating],
                "cross_family_minimum": int(minimum),
                "below_minimum": len(usable) < int(minimum),
                "when_below_minimum": str(policy.get("when_below_minimum", "native_subagents")),
            }
        )
    return info


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
    "timeout_secs": "timeout_secs",
    # NOTE: two_phase / scope_prompt are deliberately NOT config-mergeable.
    # The two-phase protocol is a per-invocation, explicit CLI opt-in; a
    # project config must never silently flip a default run into two-phase
    # (or break plain runs via a dangling scope_prompt).
}


def _find_project_config(start: Path | None = None) -> Path | None:
    """Find review-swarm.json by walking up from *start* (default: CWD)
    to find the git root, then checking:
      1. .nullius/review-swarm.json  (research project managed by nullius)
    Disabled when REVIEW_SWARM_NO_AUTO_CONFIG=1 (e.g. in tests)."""
    if os.environ.get("REVIEW_SWARM_NO_AUTO_CONFIG"):
        return None
    cur = (start or Path.cwd()).resolve()
    while True:
        if (cur / ".git").exists():
            candidate = cur / ".nullius" / _CONFIG_FILENAME
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
        ("backend_tool_mode", "backend_tool_mode"),
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
            "If omitted, auto-discovers .nullius/review-swarm.json from git root."
        ),
    )
    ap.add_argument(
        "--agents-file",
        default=None,
        help=(
            "Path to a third-party agents file (family -> runner -> model mapping; "
            "see docs/AGENTS_FILE.md). If omitted, auto-discovers "
            ".nullius/agents.json from the git root, then ~/.nullius/agents.json; "
            "a missing file is the pure-native configuration, never an error. "
            "REVIEW_SWARM_NO_AUTO_CONFIG=1 disables the auto-discovery only."
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
    ap.add_argument(
        "--kimi-runner",
        default=None,
        type=Path,
        help="Optional override path to the Kimi runner script.",
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
    ap.add_argument(
        "--backend-tool-mode",
        action="append",
        default=[],
        metavar="BACKEND=MODE",
        help=(
            "Per-backend tool-mode override. Repeatable. "
            "Supported: claude=none|review, gemini=none|review, opencode=none|workspace."
        ),
    )
    ap.add_argument(
        "--timeout-secs",
        type=int,
        default=_DEFAULT_TIMEOUT_SECS,
        help=f"Per-backend timeout seconds (0 disables, default: {_DEFAULT_TIMEOUT_SECS}).",
    )
    ap.add_argument(
        "--retry-empty-output",
        type=int,
        default=0,
        metavar="N",
        help=(
            "Orchestrator-level re-runs for an agent whose runner exited 0 but wrote an "
            "empty output file (default: 0 — disabled, so existing callers of this "
            "launcher keep their behavior; review_one.py passes 1 explicitly). When "
            "enabled, retries run before fallback is considered and before the agent is "
            "recorded as empty_output. In two-phase mode a phase-1 empty output "
            "(phase1_empty_output) is classified as an infrastructure failure but is NOT "
            "auto-retried by this flag, and --two-phase rejects fallback — recover it "
            "with a manual same-model rerun."
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
        "--two-phase",
        action="store_true",
        help=(
            "Opt-in two-phase review protocol: phase 1 sends the scope packet "
            "(--scope-prompt, no diff) and requires a declared-review-criteria block; "
            "phase 2 sends the full prompt plus the reviewer's own phase-1 criteria. "
            "Default single-phase behavior is unchanged when this flag is absent."
        ),
    )
    ap.add_argument(
        "--scope-prompt",
        default="",
        help=(
            "Scope packet file for two-phase phase 1 (change title, intent, "
            "changed-file list; no diff). Required with --two-phase."
        ),
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
        default="",
        help=(
            "Comma-separated backends allowed to trigger fallback. No default: "
            "required (explicitly chosen) whenever --fallback-mode is ask or auto."
        ),
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
    kimi_runner = args.kimi_runner.expanduser().resolve() if args.kimi_runner else _kimi_runner()

    system_prompt = args.system.expanduser().resolve()
    user_prompt = args.prompt.expanduser().resolve()
    explicit_gemini_cli_home = None
    if str(args.gemini_cli_home).strip():
        explicit_gemini_cli_home = str(Path(str(args.gemini_cli_home)).expanduser().resolve())
    fallback_order = _split_csv(args.fallback_order)
    fallback_targets = set(_split_csv(args.fallback_target_backends))
    fallback_codex_model = _normalize_model_arg(args.fallback_codex_model)
    fallback_claude_model = _normalize_model_arg(args.fallback_claude_model)
    allowed_backends = {"opencode", "claude", "codex", "gemini", "kimi"}
    backend_prompt_overrides: dict[str, Path] = {}
    backend_system_overrides: dict[str, Optional[Path]] = {}
    backend_output_overrides: dict[str, Path] = {}
    backend_tool_modes: dict[str, str] = {}
    scope_prompt: Optional[Path] = None
    review_workspace_dir = Path.cwd().resolve()
    agents_roster: Optional[dict[str, Any]] = None
    agents_source = "none"
    agents_path: Optional[Path] = None
    family_spec_by_index: dict[int, str] = {}

    try:
        if args.max_prompt_bytes is not None and args.max_prompt_bytes <= 0:
            raise ValueError("--max-prompt-bytes must be a positive integer")
        if args.max_prompt_chars is not None and args.max_prompt_chars <= 0:
            raise ValueError("--max-prompt-chars must be a positive integer")
        if args.timeout_secs < 0:
            raise ValueError("--timeout-secs must be >= 0")
        if args.retry_empty_output < 0:
            raise ValueError("--retry-empty-output must be >= 0")
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

        if args.two_phase:
            if not str(args.scope_prompt or "").strip():
                raise ValueError("--two-phase requires --scope-prompt (scope packet without the diff)")
            if args.fallback_mode != "off":
                raise ValueError(
                    "--two-phase does not support --fallback-mode ask/auto; "
                    "rerun the failed reviewer same-model instead"
                )
            scope_prompt = Path(str(args.scope_prompt)).expanduser().resolve()
            _require_file(scope_prompt, label="Scope prompt")
        elif str(args.scope_prompt or "").strip():
            raise ValueError("--scope-prompt requires --two-phase")

        if args.fallback_mode != "off" and not fallback_targets:
            raise ValueError(
                "--fallback-mode ask/auto requires explicit --fallback-target-backends "
                "(comma-separated backends allowed to trigger fallback; there is no default target)"
            )

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
        raw_backend_tool_modes = _parse_backend_assignments(
            args.backend_tool_mode,
            flag="--backend-tool-mode",
            allowed_backends=set(_ALLOWED_BACKEND_TOOL_MODES),
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

        for backend, raw in raw_backend_tool_modes.items():
            mode = str(raw).strip().lower()
            allowed_modes = _ALLOWED_BACKEND_TOOL_MODES[backend]
            if mode not in allowed_modes:
                raise ValueError(
                    f"--backend-tool-mode {backend}=... must be one of: {','.join(sorted(allowed_modes))}"
                )
            backend_tool_modes[backend] = mode

        _require_file(system_prompt, label="System prompt")
        _require_file(user_prompt, label="User prompt")

        agents_roster, agents_source, agents_path = _load_agents_file(args.agents_file)
        models = _select_models(args)
        resolved_models: list[str] = []
        for i, m in enumerate(models):
            if m.startswith(_FAMILY_SPEC_PREFIX):
                family_spec_by_index[i] = m
                resolved_models.append(_resolve_family_spec(m, agents_roster))
            else:
                resolved_models.append(m)
        models = resolved_models
        plans = _build_plans(
            models,
            opencode_runner=opencode_runner,
            claude_runner=claude_runner,
            codex_runner=codex_runner,
            gemini_runner=gemini_runner,
            kimi_runner=kimi_runner,
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
                "kimi": (kimi_runner, "Kimi runner"),
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
                # Which agents file was in force when the input was rejected (None when
                # the failure happened before/without one) — a family: spec rejection is
                # diagnosable from the meta alone, and the independence block hands the
                # calling skill its degradation signal (declared-available families,
                # below-minimum flag) without a second run. No agents ran: level "none".
                "agents_file": {"path": str(agents_path) if agents_path else None, "source": agents_source},
                "independence": _independence_summary([], agents_roster),
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
            if scope_prompt is not None:
                scope_prompt = _apply_prompt_limit(
                    scope_prompt,
                    label="scope",
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
                    "agents_file": {"path": str(agents_path) if agents_path else None, "source": agents_source},
                    "independence": _independence_summary([], agents_roster),
                    "paths": {"trace": str(trace_path)},
                },
            )
            return 2

    results: list[dict[str, Any]] = []
    run_specs: list[tuple[AgentPlan, Optional[Path], Path, Path, Optional[str], Optional[dict[str, Any]]]] = []
    for plan in plans:
        plan_gemini_cli_home, plan_gemini_review_profile = _resolve_gemini_review_profile(
            plan=plan,
            out_dir=out_dir,
            backend_tool_modes=backend_tool_modes,
            explicit_gemini_cli_home=explicit_gemini_cli_home,
        )
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
                plan_gemini_cli_home,
                plan_gemini_review_profile,
            )
        )

    config_event: dict[str, Any] = {
        "ts": _utc_now(),
        "event": "config",
        "n_agents": len(plans),
        "models": [p.requested_model for p in plans],
        "backends": [p.backend for p in plans],
        "agents_file": {"path": str(agents_path) if agents_path else None, "source": agents_source},
        "agent_name": args.agent or None,
        "variant": args.variant or None,
        "parallel": bool(args.parallel),
        "timeout_secs": int(args.timeout_secs),
        "check_review_contract": bool(args.check_review_contract),
        "fallback_mode": args.fallback_mode,
        "fallback_order": fallback_order,
        "fallback_targets": sorted(fallback_targets),
        "backend_prompt_overrides": {k: str(v) for k, v in backend_prompt_overrides.items()},
        "backend_system_overrides": {k: (str(v) if v is not None else None) for k, v in backend_system_overrides.items()},
        "backend_output_overrides": {k: str(v) for k, v in backend_output_overrides.items()},
        "backend_tool_modes": {
            backend: _resolve_backend_tool_mode(backend, backend_tool_modes)
            for backend in sorted({plan.backend for plan in plans} & set(_DEFAULT_BACKEND_TOOL_MODES))
        },
        "gemini_review_profiles": [
            {
                "index": plan.index,
                "requested_model": plan.requested_model,
                **profile,
            }
            for plan, _, _, _, _, profile in run_specs
            if plan.backend == "gemini" and profile is not None
        ],
    }
    if family_spec_by_index:
        config_event["family_specs"] = {str(i): family_spec_by_index[i] for i in sorted(family_spec_by_index)}
    if args.two_phase:
        config_event["two_phase"] = True
        config_event["scope_prompt"] = str(scope_prompt)
    _append_jsonl(trace_path, config_event)

    # Two-phase mode swaps the per-agent entrypoint; the single-phase call is
    # byte-for-byte identical to the historical behavior (empty extra kwargs).
    agent_fn = _run_two_phase_one if args.two_phase else _run_one
    two_phase_extra: dict[str, Any] = {"scope_prompt": scope_prompt} if args.two_phase else {}

    if args.parallel:
        max_workers = min(len(plans), 32)
        with ThreadPoolExecutor(max_workers=max_workers) as executor:
            futures = {
                executor.submit(
                    agent_fn,
                    plan=plan,
                    out_dir=out_dir,
                    output_prefix=args.output_prefix,
                    system=plan_system,
                    prompt=plan_prompt,
                    trace_path=trace_path,
                    opencode_agent=args.agent or None,
                    opencode_variant=args.variant or None,
                    backend_tool_modes=backend_tool_modes,
                    review_workspace_dir=review_workspace_dir,
                    gemini_cli_home=plan_gemini_cli_home,
                    gemini_review_profile=plan_gemini_review_profile,
                    timeout_secs=int(args.timeout_secs),
                    output_path=plan_out,
                    **two_phase_extra,
                ): (plan, plan_out)
                for plan, plan_system, plan_prompt, plan_out, plan_gemini_cli_home, plan_gemini_review_profile in run_specs
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
        for plan, plan_system, plan_prompt, plan_out, plan_gemini_cli_home, plan_gemini_review_profile in run_specs:
            results.append(
                agent_fn(
                    plan=plan,
                    out_dir=out_dir,
                    output_prefix=args.output_prefix,
                    system=plan_system,
                    prompt=plan_prompt,
                    trace_path=trace_path,
                    opencode_agent=args.agent or None,
                    opencode_variant=args.variant or None,
                    backend_tool_modes=backend_tool_modes,
                    review_workspace_dir=review_workspace_dir,
                    gemini_cli_home=plan_gemini_cli_home,
                    gemini_review_profile=plan_gemini_review_profile,
                    timeout_secs=int(args.timeout_secs),
                    output_path=plan_out,
                    **two_phase_extra,
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
        family_spec = family_spec_by_index.get(int(r.get("index", -1)))
        if family_spec is not None:
            r["family_spec"] = family_spec
        _postprocess_result(r, check_review_contract=bool(args.check_review_contract))

    if args.two_phase:
        for r in results:
            _finalize_two_phase_result(r, trace_path=trace_path)

    # Empty-output resilience: a runner that exits 0 but writes an empty file is
    # an infrastructure hiccup, not a review verdict. Re-run that agent (same
    # spec, same output path) up to --retry-empty-output times BEFORE fallback
    # is considered and before the agent is recorded as empty_output. Additive:
    # retried agents gain an "empty_output_retries" count in their result record.
    if int(args.retry_empty_output) > 0:
        spec_by_index = {spec[0].index: spec for spec in run_specs}
        for r in results:
            spec = spec_by_index.get(int(r.get("index", -1)))
            if spec is None:
                continue
            plan, plan_system, plan_prompt, plan_out, plan_gemini_cli_home, plan_gemini_review_profile = spec
            attempts = 0
            while attempts < int(args.retry_empty_output) and r.get("failure_reason") == "empty_output":
                attempts += 1
                _append_jsonl(
                    trace_path,
                    {
                        "ts": _utc_now(),
                        "event": "empty_output_retry",
                        "index": plan.index,
                        "backend": plan.backend,
                        "model": plan.requested_model,
                        "attempt": attempts,
                        "max_attempts": int(args.retry_empty_output),
                    },
                )
                rerun = agent_fn(
                    plan=plan,
                    out_dir=out_dir,
                    output_prefix=args.output_prefix,
                    system=plan_system,
                    prompt=plan_prompt,
                    trace_path=trace_path,
                    opencode_agent=args.agent or None,
                    opencode_variant=args.variant or None,
                    backend_tool_modes=backend_tool_modes,
                    review_workspace_dir=review_workspace_dir,
                    gemini_cli_home=plan_gemini_cli_home,
                    gemini_review_profile=plan_gemini_review_profile,
                    timeout_secs=int(args.timeout_secs),
                    output_path=plan_out,
                    **two_phase_extra,
                )
                r["command_success"] = bool(rerun.get("success", False))
                r["exit_code"] = rerun.get("exit_code")
                r["timed_out"] = bool(rerun.get("timed_out"))
                r["out"] = rerun.get("out", r.get("out"))
                if "two_phase" in rerun:
                    r["two_phase"] = rerun["two_phase"]
                _postprocess_result(r, check_review_contract=bool(args.check_review_contract))
                if args.two_phase:
                    _finalize_two_phase_result(r, trace_path=trace_path)
            if attempts:
                r["empty_output_retries"] = attempts

    # An agent requested through a family: spec never falls back to another backend:
    # the caller asked for THAT family, and an unusable family is honestly absent,
    # never substituted. Rerun the same family or drop it explicitly instead.
    for r in results:
        if (
            r.get("failure_reason")
            and str((r.get("requested") or {}).get("backend")) in fallback_targets
            and int(r.get("index", -1)) in family_spec_by_index
        ):
            _append_jsonl(
                trace_path,
                {
                    "ts": _utc_now(),
                    "event": "fallback_skipped_family_spec",
                    "index": r.get("index"),
                    "family_spec": family_spec_by_index[int(r.get("index", -1))],
                    "reason": r.get("failure_reason"),
                },
            )
    fallback_candidates = [
        r
        for r in results
        if r.get("failure_reason")
        and str((r.get("requested") or {}).get("backend")) in fallback_targets
        and int(r.get("index", -1)) not in family_spec_by_index
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
                "kimi": kimi_runner,
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
                    elif backend == "kimi":
                        model = None
                        requested_model = "kimi/default"
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
                    fallback_gemini_cli_home, fallback_gemini_review_profile = _resolve_gemini_review_profile(
                        plan=plan,
                        out_dir=out_dir,
                        backend_tool_modes=backend_tool_modes,
                        explicit_gemini_cli_home=explicit_gemini_cli_home,
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
                        backend_tool_modes=backend_tool_modes,
                        review_workspace_dir=review_workspace_dir,
                        gemini_cli_home=fallback_gemini_cli_home,
                        gemini_review_profile=fallback_gemini_review_profile,
                        timeout_secs=int(args.timeout_secs),
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
    independence = _independence_summary(results, agents_roster)
    _append_jsonl(trace_path, {"ts": _utc_now(), "event": "independence", **independence})
    meta: dict[str, Any] = {
        "schema_version": 1,
        "created_at": _utc_now(),
        "n_agents": len(plans),
        "success_count": success_count,
        "failure_count": len(plans) - success_count,
        "models": [p.requested_model for p in plans],
        "agents": results,
        # Which agents file was in force and which families actually produced
        # output, at which independence level. A run below the cross-family
        # minimum is allowed but must be visible as degraded, never silent.
        "agents_file": {"path": str(agents_path) if agents_path else None, "source": agents_source},
        "independence": independence,
        # Requested specs whose runs ALL failed at the infrastructure level
        # (timeout / crash exit / empty output): a degraded run reads as a
        # backend outage, never as review disagreement.
        "unavailable_backends": _unavailable_backend_summary(results),
        "paths": {
            "trace": str(trace_path),
            "outputs": [r.get("out", "") for r in results],
        },
    }
    if convergence_info is not None:
        meta["convergence"] = convergence_info
    if args.two_phase:
        meta["two_phase"] = {
            "enabled": True,
            "scope_prompt": str(scope_prompt),
        }
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
