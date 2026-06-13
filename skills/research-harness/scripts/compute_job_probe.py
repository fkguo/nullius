#!/usr/bin/env python3
"""Liveness + progress probe for a long-running, kill-prone compute job.

A SIGPIPE-safe replacement for hand-typed `until ! pgrep ...; sleep` loops.
It reports whether a backgrounded job is still running, how far its
append-only checkpoint file has advanced, and whether it is STALLED — the
checkpoint count flat across several consecutive probes, which is the
livelock signal (a single work unit longer than the kill window can never
land, so relaunching forever makes no progress).

Domain- and language-agnostic: it knows nothing about what the job computes,
only (a) a `pgrep -f` pattern that identifies the job process and (b) the
job's append-one-line-per-completed-unit checkpoint file. It NEVER pipes to
`head`, so it cannot SIGPIPE the job it is probing.

Output: one JSON object on stdout. Exit code is always 0 — the verdict is in
the JSON and the caller (agent) decides what to do.
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import time
from pathlib import Path

VERDICTS = ("running", "stalled", "completed", "killed_incomplete", "stopped")


def count_checkpoint_lines(path: Path | None) -> int:
    """Number of completed-unit lines in the append-only checkpoint (0 if absent)."""
    if path is None or not path.exists():
        return 0
    n = 0
    with path.open("rb") as fh:
        for _ in fh:
            n += 1
    return n


def job_pids(pattern: str) -> list[int]:
    """PIDs whose full command line matches `pattern`, excluding this probe and
    its launching shell (so a pattern that also appears in the probe's own argv
    does not self-match). Captures output rather than piping — SIGPIPE-safe."""
    exclude = {os.getpid(), os.getppid()}
    try:
        proc = subprocess.run(["pgrep", "-f", pattern], capture_output=True, text=True, check=False)
        raw = proc.stdout
        pids = [int(x) for x in raw.split() if x.strip().isdigit()]
    except FileNotFoundError:
        # pgrep unavailable: scan `ps` instead.
        proc = subprocess.run(["ps", "-A", "-o", "pid=,command="], capture_output=True, text=True, check=False)
        pids = []
        for line in proc.stdout.splitlines():
            line = line.strip()
            if not line:
                continue
            pid_str, _, cmd = line.partition(" ")
            if pid_str.isdigit() and pattern in cmd:
                pids.append(int(pid_str))
    return [p for p in pids if p not in exclude]


def decide(running: bool, count: int, expected: int | None, recent_counts: list[int], stall_window: int) -> str:
    """Pure verdict logic (unit-testable, no I/O).

    `recent_counts` is the checkpoint-count history including the current probe.
    """
    if running:
        if len(recent_counts) >= stall_window and len(set(recent_counts[-stall_window:])) == 1:
            return "stalled"
        return "running"
    if expected is not None:
        return "completed" if count >= expected else "killed_incomplete"
    return "stopped"


def _read_recent_counts(history: Path) -> list[int]:
    if not history.exists():
        return []
    counts: list[int] = []
    for line in history.read_text(encoding="utf-8", errors="replace").splitlines():
        parts = line.split("\t")
        if len(parts) >= 2 and parts[1].strip().isdigit():
            counts.append(int(parts[1]))
    return counts


def probe(pattern: str, checkpoint: Path | None, expected: int | None,
          history: Path, stall_window: int, now: float) -> dict:
    pids = job_pids(pattern)
    running = bool(pids)
    count = count_checkpoint_lines(checkpoint)

    recent_counts = _read_recent_counts(history)
    history.parent.mkdir(parents=True, exist_ok=True)
    with history.open("a", encoding="utf-8") as fh:
        fh.write(f"{now:.0f}\t{count}\t{'run' if running else 'stop'}\n")
    recent_counts.append(count)

    verdict = decide(running, count, expected, recent_counts, stall_window)
    return {
        "pattern": pattern,
        "running": running,
        "pids": pids,
        "checkpoint": str(checkpoint) if checkpoint else None,
        "checkpoint_count": count,
        "expected": expected,
        "stall_window": stall_window,
        "stalled": verdict == "stalled",
        "verdict": verdict,
    }


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description="SIGPIPE-safe liveness + progress probe for a kill-prone compute job.")
    p.add_argument("--pattern", required=True,
                   help="pgrep -f pattern identifying the job process. Be specific (e.g. the script filename) so it does not match the agent's own session.")
    p.add_argument("--checkpoint", type=Path, default=None,
                   help="append-one-line-per-completed-unit checkpoint file.")
    p.add_argument("--expected", type=int, default=None,
                   help="expected total unit count; enables completed / killed_incomplete verdicts.")
    p.add_argument("--history", type=Path, default=None,
                   help="probe-history file (default: <checkpoint>.probe, else .compute_job_probe.history in CWD).")
    p.add_argument("--stall-window", type=int, default=3,
                   help="consecutive equal-count probes that signal a stall/livelock (default 3).")
    args = p.parse_args(argv)

    history = args.history
    if history is None:
        history = (args.checkpoint.with_suffix(args.checkpoint.suffix + ".probe")
                   if args.checkpoint else Path(".compute_job_probe.history"))

    result = probe(args.pattern, args.checkpoint, args.expected, history, args.stall_window, time.time())
    print(json.dumps(result, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
