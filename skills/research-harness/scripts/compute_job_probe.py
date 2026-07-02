#!/usr/bin/env python3
"""Liveness + progress probe for a long-running, kill-prone compute job.

A SIGPIPE-safe replacement for hand-typed `until ! pgrep ...; sleep` loops.
It reports whether a backgrounded job is still running, how far its
append-only checkpoint file has advanced, and whether it is STALLED — the
checkpoint count flat across several consecutive probes, which is the
livelock signal (a single work unit longer than the kill window can never
land, so relaunching forever makes no progress).

A stopped-incomplete job is further split by a deadline marker file: when the
job (or its launch wrapper) writes the marker on expiry of its OWN per-task
time budget, the verdict is DEADLINE_REACHED — a deliberate time boundary the
caller should answer with resume-with-more-budget / resubmit / re-decompose —
instead of KILLED_INCOMPLETE (host kill or crash, answered by relaunching).
The handler consumes (deletes) the marker when acting on it.

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

VERDICTS = ("running", "stalled", "completed", "deadline_reached", "killed_incomplete", "stopped")


def count_checkpoint_lines(path: Path | None) -> int:
    """Number of completed-unit lines in the append-only checkpoint (0 if absent)."""
    if path is None or not path.exists():
        return 0
    n = 0
    with path.open("rb") as fh:
        for _ in fh:
            n += 1
    return n


def _self_and_ancestors() -> set[int]:
    """This process plus all of its ancestors.

    The agent typically launches the probe through a shell whose command line
    is the full `python3 compute_job_probe.py --pattern <X> ...` — so `<X>`
    appears in the probe's own and its ancestor shells' argv. BSD `pgrep`
    excludes ancestors natively, but Linux `pgrep` and the `ps` fallback do
    not, so exclude the whole ancestor chain ourselves to prevent a self-match.
    """
    pids = {os.getpid()}
    try:
        out = subprocess.run(["ps", "-A", "-o", "pid=,ppid="], capture_output=True, text=True, check=False).stdout
    except FileNotFoundError:
        return {os.getpid(), os.getppid()}
    parent: dict[int, int] = {}
    for line in out.splitlines():
        parts = line.split()
        if len(parts) >= 2 and parts[0].isdigit() and parts[1].isdigit():
            parent[int(parts[0])] = int(parts[1])
    cur = os.getpid()
    seen: set[int] = set()
    while cur in parent and cur not in seen:
        seen.add(cur)
        cur = parent[cur]
        if cur <= 1:
            break
        pids.add(cur)
    return pids


def job_pids(pattern: str) -> list[int]:
    """PIDs whose full command line matches `pattern`, excluding this probe and
    all its ancestors (so a pattern that also appears in the probe's own or a
    launching shell's argv does not self-match). Captures output rather than
    piping — SIGPIPE-safe."""
    exclude = _self_and_ancestors()
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


def decide(running: bool, count: int, expected: int | None, recent_counts: list[int], stall_window: int,
           deadline_fired: bool = False) -> str:
    """Pure verdict logic (unit-testable, no I/O).

    `recent_counts` is the checkpoint-count history including the current probe.
    `deadline_fired` is whether the job's own per-task time budget expired (the
    deadline marker file exists). Precedence on a stopped job: completed (all
    expected units landed, marker or not) > deadline_reached (time boundary,
    needs no expected target) > killed_incomplete / stopped (host kill or crash).
    A running job stays running/stalled — a leftover marker there is stale and
    is only surfaced through the JSON `deadline_fired` field.
    """
    if running:
        # "flat across consecutive probes" needs a window of at least 2.
        if stall_window >= 2 and len(recent_counts) >= stall_window and len(set(recent_counts[-stall_window:])) == 1:
            return "stalled"
        return "running"
    if expected is not None and count >= expected:
        return "completed"
    if deadline_fired:
        return "deadline_reached"
    if expected is not None:
        return "killed_incomplete"
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
          history: Path, stall_window: int, now: float,
          deadline_marker: Path | None = None) -> dict:
    pids = job_pids(pattern)
    running = bool(pids)
    count = count_checkpoint_lines(checkpoint)
    deadline_fired = deadline_marker is not None and deadline_marker.exists()

    recent_counts = _read_recent_counts(history)
    history.parent.mkdir(parents=True, exist_ok=True)
    with history.open("a", encoding="utf-8") as fh:
        fh.write(f"{now:.0f}\t{count}\t{'run' if running else 'stop'}\n")
    recent_counts.append(count)

    verdict = decide(running, count, expected, recent_counts, stall_window, deadline_fired)
    return {
        "pattern": pattern,
        "running": running,
        "pids": pids,
        "checkpoint": str(checkpoint) if checkpoint else None,
        "checkpoint_count": count,
        "expected": expected,
        "stall_window": stall_window,
        "deadline_marker": str(deadline_marker) if deadline_marker else None,
        "deadline_fired": deadline_fired,
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
                   help="consecutive equal-count probes that signal a stall/livelock (>=2; default 3).")
    p.add_argument("--deadline-marker", type=Path, default=None,
                   help="marker file the job/wrapper writes when its OWN per-task time budget expires; "
                        "if it exists, a stopped-incomplete job is reported as deadline_reached instead of "
                        "killed_incomplete (default: <checkpoint>.deadline when --checkpoint is given; "
                        "pass an empty value to disable).")
    args = p.parse_args(argv)

    history = args.history
    if history is None:
        history = (args.checkpoint.with_suffix(args.checkpoint.suffix + ".probe")
                   if args.checkpoint else Path(".compute_job_probe.history"))

    deadline_marker = args.deadline_marker
    if deadline_marker is not None and str(deadline_marker) in ("", "."):
        # An empty value (e.g. an unset shell variable) disables deadline probing;
        # Path("") resolves to Path(".") which always exists and would spuriously fire.
        deadline_marker = None
    elif deadline_marker is None and args.checkpoint is not None:
        deadline_marker = args.checkpoint.with_suffix(args.checkpoint.suffix + ".deadline")

    result = probe(args.pattern, args.checkpoint, args.expected, history, args.stall_window, time.time(),
                   deadline_marker)
    print(json.dumps(result, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
