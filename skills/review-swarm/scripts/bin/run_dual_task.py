#!/usr/bin/env python3
"""
run_dual_task.py (deprecated shim)

Compatibility wrapper that forwards legacy dual-review arguments to
run_multi_task.py.
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import sys
from pathlib import Path
from typing import Optional

_DEPRECATION_MSG = (
    "DEPRECATED: run_dual_task.py is a compatibility shim. "
    "Use run_multi_task.py directly."
)


def _normalize_model_arg(raw: str) -> Optional[str]:
    value = str(raw).strip()
    if not value or value.lower() == "default":
        return None
    return value


def _load_run_multi_task_module():
    module_path = Path(__file__).resolve().parent / "run_multi_task.py"
    spec = importlib.util.spec_from_file_location("run_multi_task", module_path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"Failed to load run_multi_task module: {module_path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _invoke_run_multi(argv: list[str]) -> int:
    mod = _load_run_multi_task_module()
    old_argv = sys.argv
    try:
        sys.argv = argv
        return int(mod.main())
    finally:
        sys.argv = old_argv


def _patch_meta_compat(meta_path: Path, *, claude_out: Path, gemini_out: Path) -> None:
    if not meta_path.exists() or not meta_path.is_file():
        return
    try:
        meta = json.loads(meta_path.read_text(encoding="utf-8"))
    except Exception:
        return
    if not isinstance(meta, dict):
        return

    paths = meta.get("paths")
    if not isinstance(paths, dict):
        paths = {}
        meta["paths"] = paths

    paths.setdefault("claude_output", str(claude_out))
    paths.setdefault("gemini_output", str(gemini_out))
    paths.setdefault("reviewer_b_output", str(gemini_out))
    meta["deprecated_entrypoint"] = "run_dual_task.py"

    meta_path.write_text(json.dumps(meta, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--out-dir", required=True, type=Path, help="Output directory for outputs + trace.")

    ap.add_argument(
        "--claude-runner",
        default=None,
        type=Path,
        help="Optional override path to the Claude runner script.",
    )
    ap.add_argument(
        "--gemini-runner",
        default=None,
        type=Path,
        help="Optional override path to the Gemini runner script.",
    )

    ap.add_argument("--claude-system", required=True, type=Path, help="Claude system prompt file.")
    ap.add_argument("--claude-prompt", required=True, type=Path, help="Claude user prompt file.")
    ap.add_argument("--gemini-prompt", required=True, type=Path, help="Gemini prompt file (can include system instructions).")

    ap.add_argument("--claude-model", default="", help="Claude model. Omit/default means CLI default.")
    ap.add_argument("--gemini-model", default="", help="Gemini model. Omit/default means CLI default.")
    ap.add_argument("--gemini-cli-home", default="", help="Optional GEMINI_CLI_HOME override for Gemini runner.")

    ap.add_argument("--claude-out", default="claude_output.md", help="Output filename under out-dir.")
    ap.add_argument("--gemini-out", default="gemini_output.md", help="Output filename under out-dir.")

    ap.add_argument("--check-review-contract", action="store_true", help="Validate strict review contract.")
    ap.add_argument(
        "--fallback-mode",
        choices=["off", "ask", "auto"],
        default="off",
        help="Fallback behavior when reviewer-B output is invalid.",
    )
    ap.add_argument(
        "--fallback-order",
        default="codex,claude",
        help="Comma-separated fallback sequence for reviewer-B.",
    )
    ap.add_argument(
        "--fallback-codex-model",
        default="",
        help="Codex fallback model (omit/default means Codex CLI default).",
    )
    ap.add_argument(
        "--fallback-claude-model",
        default="",
        help="Claude fallback model (omit/default means Claude CLI default).",
    )

    guard = ap.add_mutually_exclusive_group()
    guard.add_argument("--max-prompt-bytes", type=int, help="Optional per-file max prompt size in bytes.")
    guard.add_argument("--max-prompt-chars", type=int, help="Optional per-file max prompt size in Unicode characters.")
    ap.add_argument(
        "--max-prompt-overflow",
        choices=["fail", "truncate"],
        default="fail",
        help="Overflow behavior when max prompt guard is enabled.",
    )

    args = ap.parse_args()

    out_dir = args.out_dir.expanduser().resolve()
    out_dir.mkdir(parents=True, exist_ok=True)

    claude_model = _normalize_model_arg(args.claude_model)
    gemini_model = _normalize_model_arg(args.gemini_model)
    fallback_codex_model = _normalize_model_arg(args.fallback_codex_model)
    fallback_claude_model = _normalize_model_arg(args.fallback_claude_model)

    claude_spec = f"claude/{claude_model or 'default'}"
    gemini_spec = f"gemini/{gemini_model or 'default'}"

    forward_argv = [
        "run_multi_task.py",
        "--out-dir",
        str(out_dir),
        "--system",
        str(args.claude_system.expanduser().resolve()),
        "--prompt",
        str(args.claude_prompt.expanduser().resolve()),
        "--models",
        f"{claude_spec},{gemini_spec}",
        "--backend-prompt",
        f"gemini={args.gemini_prompt.expanduser().resolve()}",
        "--backend-system",
        "gemini=none",
        "--backend-output",
        f"claude={args.claude_out}",
        "--backend-output",
        f"gemini={args.gemini_out}",
        "--fallback-mode",
        str(args.fallback_mode),
        "--fallback-order",
        str(args.fallback_order),
        "--fallback-target-backends",
        "gemini",
    ]

    if args.claude_runner:
        forward_argv.extend(["--claude-runner", str(args.claude_runner.expanduser().resolve())])
    if args.gemini_runner:
        forward_argv.extend(["--gemini-runner", str(args.gemini_runner.expanduser().resolve())])
    if args.check_review_contract:
        forward_argv.append("--check-review-contract")
    if str(args.gemini_cli_home).strip():
        forward_argv.extend(["--gemini-cli-home", str(args.gemini_cli_home).strip()])
    if fallback_codex_model:
        forward_argv.extend(["--fallback-codex-model", fallback_codex_model])
    if fallback_claude_model:
        forward_argv.extend(["--fallback-claude-model", fallback_claude_model])

    if args.max_prompt_bytes is not None:
        forward_argv.extend(["--max-prompt-bytes", str(args.max_prompt_bytes)])
    if args.max_prompt_chars is not None:
        forward_argv.extend(["--max-prompt-chars", str(args.max_prompt_chars)])
    forward_argv.extend(["--max-prompt-overflow", str(args.max_prompt_overflow)])

    print(_DEPRECATION_MSG, file=sys.stderr)
    code = _invoke_run_multi(forward_argv)

    _patch_meta_compat(
        out_dir / "meta.json",
        claude_out=out_dir / args.claude_out,
        gemini_out=out_dir / args.gemini_out,
    )

    return code


if __name__ == "__main__":
    raise SystemExit(main())
