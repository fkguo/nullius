#!/usr/bin/env python3
"""Bounded, tool-free file-prompt execution through the installed DSH CLI."""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
from pathlib import Path
import re
import shutil
import signal
import subprocess
import sys
import tempfile
import time


sys.path.insert(0, str(Path(__file__).resolve().parent))
from dsh_runtime import SUPPORTED_VERSION, RunError, runtime, overlay, check_runtime_identity
from dsh_session import check_events


def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def write_json(path: Path, value: object) -> None:
    path.write_text(json.dumps(value, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


def publish_output(path: Path, raw: bytes, deadline: float | None = None) -> None:
    """Publish complete bytes atomically without replacing an existing delivery."""
    fd, name = tempfile.mkstemp(prefix=".dsh-output-", dir=path.parent)
    temporary = Path(name)
    try:
        with os.fdopen(fd, "wb") as output:
            output.write(raw)
            output.flush()
            os.fsync(output.fileno())
        if deadline is not None and time.monotonic() >= deadline:
            raise RunError("deadline exhausted before atomic output publication")
        os.link(temporary, path)
    finally:
        try:
            temporary.unlink(missing_ok=True)
        except OSError:
            pass


def provider_profile(raw: bytes, model: str, cap: int | None, effort: str | None) -> dict:
    profile = json.loads(raw)
    if not isinstance(profile, dict):
        raise RunError("provider config must be a JSON object")
    key_ref = profile.get("apiKeyEnv")
    if not isinstance(key_ref, str) or not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", key_ref):
        raise RunError("provider config requires an apiKeyEnv environment-variable reference")
    # Headers and inline credentials can leak through configuration receipts.
    def has_inline_credentials(value: object) -> bool:
        if isinstance(value, dict):
            return any(str(key).lower() in {'apikey', 'api_key', 'headers', 'authorization'} or has_inline_credentials(item) for key, item in value.items())
        return isinstance(value, list) and any(has_inline_credentials(item) for item in value)
    if has_inline_credentials(profile):
        raise RunError("inline credentials and headers are unsupported; use apiKeyEnv")
    models = profile.get("models")
    if not isinstance(models, list) or not models or not all(isinstance(m, dict) for m in models):
        raise RunError("provider config requires an explicit nonempty models list")
    selected = [m for m in models if m.get("id") == model]
    if len(selected) != 1:
        raise RunError("requested model must occur exactly once in provider config")
    selected = selected[0]
    # Register only the selected model; do not discover or silently switch routes.
    profile["models"] = [selected]
    if cap is not None:
        selected["maxTokens"] = cap
    if effort is not None:
        levels = selected.get("reasoningEfforts")
        if not isinstance(levels, dict) or effort not in levels:
            raise RunError("reasoning level must be explicitly declared in selected model reasoningEfforts")
        profile["reasoning"] = effort
    profile["retryPolicy"] = {"mode": "normal", "maxRetries": 0}
    return profile


def terminate(proc: subprocess.Popen) -> None:
    # Repeated user cancellation must not abort cleanup and orphan the group.
    handlers = {s: signal.signal(s, signal.SIG_IGN) for s in (signal.SIGTERM, signal.SIGINT)}
    try:
        try:
            os.killpg(proc.pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
        try:
            proc.wait(timeout=1)
        except subprocess.TimeoutExpired:
            pass
        # The leader may exit while descendants ignore TERM.
        try:
            os.killpg(proc.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        proc.wait()
    finally:
        for signum, handler in handlers.items():
            signal.signal(signum, handler)


def main(argv: list[str] | None = None) -> int:
    if sys.version_info < (3, 10):
        print("dsh-cli-runner requires Python 3.10+", file=sys.stderr)
        return 1
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cli-entry", help="Installed desktop dsh launcher (otherwise resolve dsh on PATH)")
    parser.add_argument("--provider", required=True)
    parser.add_argument("--model", required=True)
    parser.add_argument("--provider-config-file", type=Path, required=True)
    parser.add_argument("--prompt-file", type=Path, required=True)
    parser.add_argument("--system-prompt-file", type=Path)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--trace-dir", type=Path)
    parser.add_argument("--timeout-secs", type=float, required=True, help="Total local deadline; strictly positive")
    parser.add_argument("--max-tokens", type=int)
    parser.add_argument("--reasoning")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args(argv)
    started = time.monotonic()
    run = None
    receipt = {"status": "preflight_failed", "provider": args.provider, "model": args.model, "attempt_limit": 1, "timeout_secs": args.timeout_secs}
    try:
        if not math.isfinite(args.timeout_secs) or args.timeout_secs <= 0:
            raise RunError("timeout-secs must be finite and strictly positive")
        if args.max_tokens is not None and args.max_tokens <= 0:
            raise RunError("max-tokens must be strictly positive")
        if not args.provider.strip() or not args.model.strip():
            raise RunError("provider and model must be nonblank")
        out = args.out.expanduser().absolute()
        if out.exists() or out.is_symlink():
            raise RunError("output path already exists; choose a fresh output path")
        prompt = args.prompt_file.read_text(encoding="utf-8")
        if not prompt.strip() or "\0" in prompt:
            raise RunError("prompt must be nonblank UTF-8 without NUL")
        persona = args.system_prompt_file.read_text(encoding="utf-8") if args.system_prompt_file else ""
        profile_bytes = args.provider_config_file.read_bytes()
        profile = provider_profile(profile_bytes, args.model, args.max_tokens, args.reasoning)
        if not args.dry_run and not os.environ.get(profile["apiKeyEnv"]):
            raise RunError("selected apiKeyEnv is not exported; no credential stores are copied or read")
        trace = (args.trace_dir or Path(str(out) + ".attempts")).expanduser().absolute()
        trace.mkdir(parents=True, exist_ok=True)
        run = Path(tempfile.mkdtemp(prefix="run.", dir=trace)).resolve(strict=True)
        run.chmod(0o700)
        (run / "workspace").mkdir()
        (run / "home").mkdir()
        env = os.environ.copy()
        env.update(DSH_HOME=str(run / "home"), DSH_TELEMETRY_DISABLED="1")
        env.pop("DSH_TOOLS_MODE", None)
        command, entries, identity = runtime(args.cli_entry, run, env, started + args.timeout_secs)
        patch = run / "dispatch.patch.json"
        write_json(patch, overlay(entries, run, profile, args.provider, args.model, persona))
        task = "Task:\n" + prompt
        cmd = command + ["--profile", "headless", "--patch", str(patch), task]
        # execve limits include argv, environment and pointers; Linux also has
        # a per-string 32-page cap. Oversized input is refused, never truncated.
        arg_max = os.sysconf("SC_ARG_MAX")
        size = sum(len(os.fsencode(s)) + 1 for s in cmd) + sum(len(os.fsencode(k + "=" + v)) + 1 for k, v in env.items())
        size += (len(cmd) + len(env) + 2) * 8
        if size + 16384 >= arg_max or (sys.platform.startswith("linux") and len(task.encode()) + 1 > 32 * os.sysconf("SC_PAGE_SIZE")):
            raise RunError("prompt exceeds exec argument budget; partition the task before dispatch")
        receipt.update(runtime=identity, prompt_sha256=digest(prompt.encode()), system_sha256=digest(persona.encode()),
                       provider_config_sha256=digest(profile_bytes), argv_bytes=size,
                       isolated_cwd=str(run / "workspace"), trace=str(run), tool_mode="none")
        if args.dry_run:
            receipt["status"] = "dry_run"
            return 0
        stdout = run / "stdout.txt"
        stderr = run / "stderr.txt"
        with stdout.open("wb") as sout, stderr.open("wb") as serr:
            remaining = args.timeout_secs - (time.monotonic() - started)
            if remaining <= 0:
                raise RunError("deadline exhausted before launch")
            proc = subprocess.Popen(cmd, cwd=run / "workspace", env=env, stdout=sout, stderr=serr, start_new_session=True)
            old_term = signal.getsignal(signal.SIGTERM)
            def cancel(_signum, _frame):
                raise KeyboardInterrupt
            signal.signal(signal.SIGTERM, cancel)
            try:
                proc.wait(timeout=remaining)
            except (subprocess.TimeoutExpired, KeyboardInterrupt):
                terminate(proc)
                partial = stdout.read_bytes()
                if partial.strip():
                    (run / "output.partial").write_bytes(partial)
                receipt["status"] = "interrupted"
                raise RunError("deadline or cancellation interrupted the local process group")
            finally:
                signal.signal(signal.SIGTERM, old_term)
        receipt["exit_code"] = proc.returncode
        raw = stdout.read_bytes()
        if raw.strip():
            (run / "output.partial").write_bytes(raw)
        if proc.returncode != 0:
            raise RunError("DSH exited unsuccessfully; retain stderr and session log as failure evidence")
        logs = list((run / "home/sessions").rglob("session.v4.jsonl"))
        if len(logs) != 1:
            raise RunError("expected exactly one durable plaintext session log")
        events = [json.loads(line) for line in logs[0].read_text(encoding="utf-8").splitlines()]
        final, evidence = check_events(events, args.provider, args.model, args.max_tokens, args.reasoning, str(run / "workspace"))
        if raw.decode("utf-8") != final + "\n":
            raise RunError("stdout differs from the complete committed final assistant text")
        if time.monotonic() - started >= args.timeout_secs:
            raise RunError("deadline exhausted before output delivery")
        check_runtime_identity(identity)
        if time.monotonic() >= started + args.timeout_secs:
            raise RunError("deadline exhausted during runtime identity verification")
        out.parent.mkdir(parents=True, exist_ok=True)
        receipt.update(status="completed", evidence=evidence, output_sha256=digest(raw), session_log=str(logs[0]))
        receipt["elapsed_secs"] = time.monotonic() - started
        write_json(run / "receipt.json", receipt)
        publish_output(out, raw, started + args.timeout_secs)
        return 0
    except (RunError, OSError, ValueError, KeyError, TypeError) as exc:
        receipt["error"] = str(exc) if isinstance(exc, RunError) else f"invalid input or runtime evidence ({type(exc).__name__})"
        if receipt["status"] != "interrupted":
            receipt["status"] = "failed"
        print("dsh-cli-runner: " + receipt["error"], file=sys.stderr)
        return 1
    finally:
        if run is not None:
            if receipt["status"] != "completed":
                receipt["elapsed_secs"] = time.monotonic() - started
                write_json(run / "receipt.json", receipt)
            print(f"dsh-cli-runner: receipt {run / 'receipt.json'}", file=sys.stderr)


if __name__ == "__main__":
    raise SystemExit(main())
