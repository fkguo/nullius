#!/usr/bin/env python3
"""Real-runner smoke test for run_multi_task.py.

This script executes run_multi_task.py with real local runner CLIs (no stubs),
with per-backend timeout and structured summary output.
"""

from __future__ import annotations

import argparse
import contextlib
import json
import os
import shutil
import signal
import subprocess
import sys
import tempfile
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Optional


@dataclass
class CmdResult:
    timed_out: bool
    exit_code: Optional[int]
    stdout: str
    stderr: str
    elapsed_sec: float


def _run_with_timeout(cmd: list[str], timeout_sec: int) -> CmdResult:
    start = time.monotonic()
    proc = subprocess.Popen(
        cmd,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        start_new_session=True,
    )
    try:
        stdout, stderr = proc.communicate(timeout=timeout_sec)
        return CmdResult(
            timed_out=False,
            exit_code=proc.returncode,
            stdout=stdout,
            stderr=stderr,
            elapsed_sec=time.monotonic() - start,
        )
    except subprocess.TimeoutExpired:
        with contextlib.suppress(ProcessLookupError):
            os.killpg(proc.pid, signal.SIGKILL)
        stdout, stderr = proc.communicate()
        return CmdResult(
            timed_out=True,
            exit_code=None,
            stdout=stdout,
            stderr=stderr,
            elapsed_sec=time.monotonic() - start,
        )


def _read_json(path: Path) -> dict[str, Any]:
    if not path.exists() or not path.is_file():
        return {}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}


def _tail_trace_event(path: Path) -> dict[str, Any]:
    if not path.exists() or not path.is_file():
        return {}
    lines = path.read_text(encoding="utf-8", errors="replace").splitlines()
    for line in reversed(lines):
        line = line.strip()
        if not line:
            continue
        try:
            obj = json.loads(line)
            if isinstance(obj, dict):
                return obj
        except Exception:
            continue
    return {}


def _read_first_output_text(meta: dict[str, Any]) -> str:
    paths = meta.get("paths") if isinstance(meta.get("paths"), dict) else {}
    outputs = paths.get("outputs") if isinstance(paths, dict) else []
    if not isinstance(outputs, list) or not outputs:
        return ""
    out_path = Path(str(outputs[0]))
    if not out_path.exists() or not out_path.is_file():
        return ""
    try:
        return out_path.read_text(encoding="utf-8", errors="replace").strip()
    except Exception:
        return ""


def _normalize_gemini_model(model: str) -> str:
    m = model.strip()
    if m.startswith("gemini/"):
        m = m.split("/", 1)[1].strip()
    return m


def _normalize_codex_model(model: str) -> str:
    m = model.strip()
    if m.startswith("codex/"):
        m = m.split("/", 1)[1].strip()
    return m


def _build_cmd(
    *,
    run_multi: Path,
    backend: str,
    out_dir: Path,
    system_prompt: Path,
    user_prompt: Path,
    opencode_model: str,
    claude_model: str,
    codex_model: str,
    gemini_model: str,
) -> list[str]:
    cmd = [
        sys.executable,
        str(run_multi),
        "--out-dir",
        str(out_dir),
        "--system",
        str(system_prompt),
        "--prompt",
        str(user_prompt),
        "--no-parallel",
    ]
    if backend == "opencode":
        cmd.extend(["--model", opencode_model])
    elif backend == "claude":
        cmd.extend(["--models", f"claude/{claude_model.strip() or 'default'}"])
    elif backend == "codex":
        cmd.extend(["--models", f"codex/{_normalize_codex_model(codex_model)}"])
    elif backend == "gemini":
        cmd.extend(["--models", f"gemini/{_normalize_gemini_model(gemini_model)}"])
    else:
        raise ValueError(f"Unsupported backend: {backend}")
    return cmd


def _parse_backends(raw: str) -> list[str]:
    items = [x.strip().lower() for x in raw.split(",") if x.strip()]
    allowed = {"opencode", "claude", "codex", "gemini"}
    for item in items:
        if item not in allowed:
            raise ValueError(f"Unknown backend: {item}")
    if not items:
        raise ValueError("No backends selected")
    return items


def _print_summary(rows: list[dict[str, Any]], root: Path, summary_json: Path) -> None:
    print("\\n== run_multi_task real-runner smoke summary ==")
    print(f"workspace: {root}")
    for row in rows:
        status = "PASS" if row.get("ok") else "FAIL"
        backend = row.get("backend")
        detail = row.get("detail", "")
        elapsed = row.get("elapsed_sec", 0.0)
        exit_code = row.get("exit_code")
        timeout = row.get("timed_out")
        print(
            f"- {backend}: {status} | exit={exit_code} | timeout={timeout} | "
            f"elapsed={elapsed:.1f}s | {detail}"
        )
    print(f"summary_json: {summary_json}")


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument(
        "--backends",
        default="opencode,claude,codex,gemini",
        help="Comma-separated backends to test (opencode,claude,codex,gemini).",
    )
    ap.add_argument(
        "--timeout-secs",
        type=int,
        default=90,
        help="Per-backend timeout seconds (default: 90).",
    )
    ap.add_argument(
        "--opencode-model",
        default="default",
        help="Model value passed to --model for opencode backend (default: default).",
    )
    ap.add_argument(
        "--claude-model",
        default="default",
        help="Claude model name without prefix (default: default).",
    )
    ap.add_argument(
        "--codex-model",
        default="default",
        help="Codex model name without prefix (default: default).",
    )
    ap.add_argument(
        "--gemini-model",
        default="default",
        help="Gemini model name without prefix (default: default).",
    )
    ap.add_argument(
        "--keep-temp",
        action="store_true",
        help="Keep temp directory even when all cases pass.",
    )
    ap.add_argument(
        "--work-dir",
        type=Path,
        default=None,
        help="Optional working directory for smoke artifacts (default: mkdtemp).",
    )
    args = ap.parse_args()

    if args.timeout_secs <= 0:
        print("ERROR: --timeout-secs must be > 0", file=sys.stderr)
        return 2

    try:
        backends = _parse_backends(args.backends)
    except Exception as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 2

    run_multi = Path(__file__).resolve().parent / "run_multi_task.py"
    if not run_multi.exists():
        print(f"ERROR: run_multi_task.py not found: {run_multi}", file=sys.stderr)
        return 2

    root = args.work_dir.expanduser().resolve() if args.work_dir else Path(tempfile.mkdtemp(prefix="run_multi_smoke_"))
    root.mkdir(parents=True, exist_ok=True)

    prompts_dir = root / "inputs"
    prompts_dir.mkdir(parents=True, exist_ok=True)
    system_prompt = prompts_dir / "system.txt"
    user_prompt = prompts_dir / "prompt.txt"
    system_prompt.write_text("You are concise.\\n", encoding="utf-8")
    user_prompt.write_text(
        "Return a short one-line response that starts with SMOKE_OK and then at most 5 words.\\n",
        encoding="utf-8",
    )

    rows: list[dict[str, Any]] = []

    for backend in backends:
        case_dir = root / backend
        cmd = _build_cmd(
            run_multi=run_multi,
            backend=backend,
            out_dir=case_dir,
            system_prompt=system_prompt,
            user_prompt=user_prompt,
            opencode_model=args.opencode_model,
            claude_model=args.claude_model,
            codex_model=args.codex_model,
            gemini_model=args.gemini_model,
        )

        result = _run_with_timeout(cmd, timeout_sec=args.timeout_secs)
        meta = _read_json(case_dir / "meta.json")
        last_event = _tail_trace_event(case_dir / "trace.jsonl")
        first_output = _read_first_output_text(meta)

        ok = False
        detail = ""
        if result.timed_out:
            detail = "timed out"
        elif result.exit_code != 0:
            detail = f"run_multi_task exit={result.exit_code}"
        else:
            success_count = meta.get("success_count") if isinstance(meta.get("success_count"), int) else -1
            if success_count < 1:
                detail = "meta.success_count < 1"
            elif not first_output:
                detail = "empty output"
            else:
                ok = True
                detail = "ok"

        rows.append(
            {
                "backend": backend,
                "ok": ok,
                "detail": detail,
                "timed_out": result.timed_out,
                "exit_code": result.exit_code,
                "elapsed_sec": round(result.elapsed_sec, 3),
                "cmd": cmd,
                "stdout_tail": result.stdout[-2000:],
                "stderr_tail": result.stderr[-4000:],
                "meta": meta,
                "trace_last_event": last_event,
                "output_preview": first_output[:500],
            }
        )

    overall_ok = all(bool(x.get("ok")) for x in rows)
    summary = {
        "created_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "overall_ok": overall_ok,
        "backends": backends,
        "timeout_secs": args.timeout_secs,
        "results": rows,
        "root": str(root),
    }
    summary_json = root / "smoke_summary.json"
    summary_json.write_text(json.dumps(summary, indent=2, sort_keys=True) + "\n", encoding="utf-8")

    _print_summary(rows, root, summary_json)

    if overall_ok and not args.keep_temp and args.work_dir is None:
        shutil.rmtree(root, ignore_errors=True)
        print("temp directory removed (all cases passed)")
    else:
        print("artifacts kept for inspection")

    return 0 if overall_ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
