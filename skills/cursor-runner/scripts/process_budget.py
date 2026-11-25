"""Supervise the Cursor CLI and its descendants until exit or cancellation."""

from __future__ import annotations

import os
import select
import signal
import subprocess
import sys
import time


class ChildReapingError(RuntimeError):
    """The CLI was reaped outside this supervisor, as the kernel does itself
    while SIGCHLD is ignored. Its pid then no longer names its process group,
    so nothing may be signalled by that number."""


def own_child_reaping() -> None:
    """Keep an exited CLI as a zombie until this supervisor reaps it.

    An ignored SIGCHLD survives exec. While it is ignored the kernel reaps an
    exited child at once (Linux; macOS once it is ignored in this process) and
    the number of the group the child led may be reissued. Called once at
    startup, before any CLI is spawned; nothing here sets it back.
    """
    signal.signal(signal.SIGCHLD, signal.SIG_DFL)


def child_exited(pid: int, timeout: float | None) -> bool:
    """Whether the child has exited, waiting up to timeout seconds (None: no limit).

    Never reaps: an exited, unreaped child stays a zombie that keeps its pid,
    and with it the number of the process group it leads. Raises
    ChildReapingError when the child may already have been reaped elsewhere.
    """
    if hasattr(select, 'kqueue'):  # macOS CPython has no os.waitid
        queue = select.kqueue()
        try:
            try:
                queue.control([select.kevent(pid, select.KQ_FILTER_PROC,
                                             select.KQ_EV_ADD | select.KQ_EV_ONESHOT,
                                             select.KQ_NOTE_EXIT)], 0, 0)
                exited = bool(queue.control(None, 1, timeout))
            except ProcessLookupError:
                exited = True  # a zombie, which the kernel refuses to watch, or a reaped pid
        finally:
            queue.close()
        # ESRCH does not tell a zombie from a reaped pid; only an unignored
        # SIGCHLD guarantees that an exited child is kept as a zombie.
        if exited and signal.getsignal(signal.SIGCHLD) == signal.SIG_IGN:
            raise ChildReapingError(f'child {pid} exited while SIGCHLD is ignored')
        return exited
    flags = os.WEXITED | os.WNOWAIT
    try:
        if timeout is None:
            os.waitid(os.P_PID, pid, flags)
            return True
        deadline = time.monotonic()+timeout
        delay = 0.001
        while os.waitid(os.P_PID, pid, flags | os.WNOHANG) is None:
            left = deadline-time.monotonic()
            if left <= 0:
                return False
            time.sleep(min(delay, left))
            delay = min(2*delay, 0.05)
    except ChildProcessError:  # ECHILD: not even a zombie is left
        raise ChildReapingError(f'child {pid} was reaped outside this supervisor') from None
    return True


def signal_group(pgid: int, signum: int) -> bool:
    """Signal a process group; False when nothing in it is left to signal.

    macOS answers EPERM for a group whose members have all exited while its
    unreaped leader is a zombie (Linux answers 0), and ESRCH once it is gone.
    """
    try:
        os.killpg(pgid, signum)
    except (ProcessLookupError, PermissionError):
        return False
    return True


def group_has_live_member(pgid: int) -> bool:
    """Whether anything in the group is left to signal. killpg(pgid, 0) says
    so on macOS (EPERM once only the zombie leader is left — same-user CLIs only; a descendant that changed credentials would answer EPERM too); on Linux the
    zombie leader still counts there, so /proc is read instead."""
    if sys.platform.startswith('linux'):
        try:
            entries = os.listdir('/proc')
        except OSError:
            return signal_group(pgid, 0)
        group_id = str(pgid).encode("ascii")
        for entry in entries:
            if entry.isdigit():
                try:
                    # A process name can contain arbitrary bytes, including ')'.
                    with open(f'/proc/{entry}/stat', 'rb') as stream:
                        fields = stream.read().rpartition(b')')[2].split(maxsplit=4)
                except OSError:
                    continue
                if len(fields) >= 3 and fields[2] == group_id and fields[0] not in (b'Z', b'X'):
                    return True
        return False
    return signal_group(pgid, 0)


def stop_group(proc: subprocess.Popen, reaped_elsewhere: bool = False) -> None:
    """Stop the CLI's whole group (SIGTERM, grace, SIGKILL), then reap the CLI.

    The CLI may exit before its descendants. Its pid is the group number, which
    names this group provably only while the CLI is unreaped, so every signal
    goes out before the reap and nothing before this function reaps the CLI.
    The grace ends early once nothing in the group is left to signal. A CLI
    reaped elsewhere (ChildReapingError) gets no signal by that number.
    """
    if not reaped_elsewhere and proc.returncode is None and signal_group(proc.pid, signal.SIGTERM):
        deadline = time.monotonic()+0.3
        while group_has_live_member(proc.pid) and time.monotonic() < deadline:
            time.sleep(0.01)
        signal_group(proc.pid, signal.SIGKILL)
    proc.wait()
