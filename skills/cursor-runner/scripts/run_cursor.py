#!/usr/bin/env python3
"""Run a single file-based prompt through the local Cursor Agent CLI."""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
from pathlib import Path
import shutil
import signal
import stat
import subprocess
import sys
import tempfile
import time

from client_compat import check_client
from process_budget import ChildReapingError, child_exited, own_child_reaping, stop_group

PROMPT_LIMIT = 64 * 1024
FLAGS = ("--print", "--output-format", "--mode", "--model", "--sandbox", "--workspace", "--trust", "--list-models")


def read_prompt(path: Path) -> str:
    # Open nonblocking so a FIFO cannot hang before the model deadline starts.
    with os.fdopen(os.open(path, os.O_RDONLY | os.O_NONBLOCK), "rb") as stream:
        if not stat.S_ISREG(os.fstat(stream.fileno()).st_mode):
            raise ValueError(f"Prompt input must be a regular file: {path}")
        data = stream.read(PROMPT_LIMIT + 1)
    if len(data) > PROMPT_LIMIT or b"\x00" in data:
        raise ValueError("Cursor takes the prompt as an argument. Use at most 64 KiB of UTF-8 without NUL bytes.")
    return data.decode("utf-8")


def dispatch(command: list[str], timeout: float, *, cwd=None, stdout=None, stderr=None) -> int:
    own_child_reaping()
    cancelled = 0

    def cancel(signum, _frame):
        nonlocal cancelled
        cancelled = signum

    prior_handlers = {sig: signal.signal(sig, cancel) for sig in (signal.SIGINT, signal.SIGTERM)}
    deadline = time.monotonic() + timeout
    try:
        if cancelled:
            return 128 + cancelled
        proc = subprocess.Popen(command, cwd=cwd, stdin=subprocess.DEVNULL,
                                stdout=stdout, stderr=stderr, start_new_session=True)
        reaped_elsewhere = False
        timed_out = False
        try:
            while not cancelled:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    timed_out = True
                    break
                if child_exited(proc.pid, min(remaining, 0.05)):
                    break
        except ChildReapingError:
            reaped_elsewhere = True
        finally:
            stop_group(proc, reaped_elsewhere)
        if cancelled:
            return 128 + cancelled
        if timed_out:
            print("Cursor command timed out.", file=sys.stderr)
            return 124
        if reaped_elsewhere:
            print("Cursor process exit status is unavailable.", file=sys.stderr)
            return 70
        return proc.returncode if proc.returncode >= 0 else 128 - proc.returncode
    finally:
        for sig, handler in prior_handlers.items():
            signal.signal(sig, handler)


def parse_result(path: Path) -> tuple[str, str | None, str | None]:
    result = None
    init = None
    with path.open(encoding="utf-8") as stream:
        for line in stream:
            if not line.strip():
                continue
            event = json.loads(line)
            if not isinstance(event, dict) or not isinstance(event.get("type"), str):
                raise ValueError("Cursor emitted an invalid event.")
            if result is not None:
                raise ValueError("Cursor emitted an event after its terminal result.")
            if event["type"] == "result":
                result = event
            if event["type"] == "system" and event.get("subtype") == "init":
                if init is not None:
                    raise ValueError("Cursor emitted multiple session initialization events.")
                init = event
    if result is None or result.get("subtype") != "success" or result.get("is_error") is not False:
        raise ValueError("Cursor did not emit a successful terminal result.")
    text = result.get("result")
    if not isinstance(text, str) or not text.strip():
        raise ValueError("Cursor returned no final text.")
    session_id = result.get("session_id")
    initial_session = init.get("session_id") if init else None
    if initial_session and session_id and initial_session != session_id:
        raise ValueError("Cursor initialization and result refer to different sessions.")
    reported_model = init.get("model") if init else None
    return (text, reported_model if isinstance(reported_model, str) else None,
            session_id if isinstance(session_id, str) else None)


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    action = parser.add_mutually_exclusive_group()
    action.add_argument("--check-client", action="store_true", help="Check CLI flags without a model call.")
    action.add_argument("--list-models", action="store_true", help="Show models available to the current Cursor account.")
    action.add_argument("--dry-run", action="store_true", help="Validate a request without sending it.")
    parser.add_argument("--cursor-bin", help="Cursor CLI executable. Defaults to cursor-agent or agent on PATH.")
    parser.add_argument("--model", help="Exact model ID printed by Cursor. Required for a prompt.")
    parser.add_argument("--prompt-file", type=Path)
    parser.add_argument("--system-prompt-file", type=Path, help="Optional instructions prepended to the user prompt.")
    parser.add_argument("--out", type=Path, help="New path for the completed assistant text.")
    parser.add_argument("--timeout-secs", type=float, default=300, help="One request deadline in seconds (default: 300).")
    args = parser.parse_args(argv)
    client = shutil.which(args.cursor_bin or "cursor-agent")
    generic_client_name = client is None and args.cursor_bin is None
    if generic_client_name:
        client = shutil.which("agent")
    if client is None:
        parser.error("Cursor Agent CLI executable is missing. Install it or set --cursor-bin.")
    client = str(Path(client).absolute())

    if not math.isfinite(args.timeout_secs) or args.timeout_secs <= 0:
        parser.error("--timeout-secs must be a finite positive number.")
    if args.check_client or args.list_models:
        if args.model or args.prompt_file or args.system_prompt_file or args.out:
            parser.error("Client checks and model listing take no prompt or output arguments.")
        if args.check_client:
            return check_client(client, "", FLAGS)
        if generic_client_name and check_client(client, "", FLAGS):
            return 2
        try:
            return dispatch([client, "--list-models"], args.timeout_secs)
        except OSError as exc:
            print(f"Cursor runner: {exc}", file=sys.stderr)
            return 2

    if not args.model or not args.model.strip() or args.prompt_file is None or args.out is None:
        parser.error("--model, --prompt-file and --out are required.")
    try:
        if args.out.exists() or args.out.is_symlink():
            parser.error("--out must be a new path.")
        out = args.out.parent.resolve() / args.out.name
        user_text = read_prompt(args.prompt_file)
        system_text = read_prompt(args.system_prompt_file) if args.system_prompt_file else ""
        if not user_text.strip():
            parser.error("--prompt-file must contain nonblank text.")
        prompt = f"{system_text}\n\n{user_text}" if system_text else user_text
        prompt_bytes = prompt.encode("utf-8")
        if len(prompt_bytes) > PROMPT_LIMIT:
            parser.error("Cursor takes the prompt as an argument. Use at most 64 KiB of combined UTF-8.")
        receipt = {
            "requested_model": args.model,
            "prompt_bytes": len(prompt_bytes),
            "prompt_sha256": hashlib.sha256(prompt_bytes).hexdigest(),
        }
        if args.dry_run:
            print(json.dumps({**receipt, "client": client, "out": str(out), "timeout_secs": args.timeout_secs}))
            return 0
        if generic_client_name and check_client(client, "", FLAGS):
            return 2

        out.parent.mkdir(parents=True, exist_ok=True)
        trace = Path(tempfile.mkdtemp(prefix=".cursor-attempt-", dir=out.parent))
        print(f"Cursor attempt files: {trace}", file=sys.stderr)
        with tempfile.TemporaryDirectory(prefix="nullius-cursor-") as work:
            workspace = Path(work).resolve()
            command = [client, "--print", "--output-format", "stream-json", "--mode", "ask",
                       "--sandbox", "enabled", "--workspace", str(workspace), "--trust",
                       f"--model={args.model}", "--", prompt]
            with (trace / "stdout.jsonl").open("wb") as stdout, (trace / "stderr.log").open("wb") as stderr:
                try:
                    code = dispatch(command, args.timeout_secs, cwd=workspace, stdout=stdout, stderr=stderr)
                except OSError as exc:
                    code = 2
                    receipt["launch_error"] = str(exc)
                    stderr.write(f"{exc}\n".encode("utf-8", errors="backslashreplace"))

        receipt["cursor_exit_code"] = code
        if code:
            (trace / "receipt.json").write_text(json.dumps(receipt, indent=2) + "\n")
            print(f"Cursor exited with status {code}. See stderr.log in the attempt directory.", file=sys.stderr)
            return code
        try:
            text, model, session_id = parse_result(trace / "stdout.jsonl")
            result = text.encode("utf-8")
        except ValueError as exc:
            # JSONDecodeError includes the offending data in its attributes, not in str(exc).
            receipt["output_error"] = str(exc)
            (trace / "receipt.json").write_text(json.dumps(receipt, indent=2) + "\n")
            print(f"Cannot accept Cursor output: {exc}", file=sys.stderr)
            return 12
        receipt.update(reported_model=model, session_id=session_id,
                       output_sha256=hashlib.sha256(result).hexdigest())
        (trace / "receipt.json").write_text(json.dumps(receipt, indent=2) + "\n")
        captured = trace / "result.txt"
        captured.touch(mode=0o600, exist_ok=False)
        captured.write_bytes(result)
        os.link(captured, out)
        captured.unlink()
        return 0
    except (OSError, ValueError) as exc:
        print(f"Cursor runner: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
