"""Local process supervision; copied with each independently installed runner skill."""
from __future__ import annotations

import argparse
import contextlib
import json
import hashlib
import os
from pathlib import Path
import select
import signal
import subprocess
import sys
import time


def save(path: Path, state: dict) -> None:
    temporary = path.with_suffix('.tmp')
    temporary.write_text(json.dumps(state, indent=2)+'\n')
    os.replace(temporary, path)


def remaining(state: dict) -> float | None:
    deadline = state['deadline_monotonic']
    return None if deadline is None else max(0, deadline-time.monotonic())


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
        for entry in entries:
            if entry.isdigit():
                try:
                    with open(f'/proc/{entry}/stat') as stream:
                        fields = stream.read().rsplit(')', 1)[1].split()
                except OSError:
                    continue
                if int(fields[2]) == pgid and fields[0] not in 'ZX':
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


def main() -> int:
    # macOS monotonic clocks share a process-independent reference from 3.10.
    # Never turn a per-process timestamp into a reusable absolute deadline.
    if sys.version_info < (3, 10):
        print('Runner supervision requires Python >= 3.10 for a cross-process monotonic deadline.', file=sys.stderr)
        return 2
    own_child_reaping()
    ap = argparse.ArgumentParser()
    ap.add_argument('action', choices=['init', 'run', 'sleep', 'finish'])
    ap.add_argument('--state', type=Path, required=True)
    ap.add_argument('--max-attempts', type=int, default=3)
    ap.add_argument('--timeout-secs', type=float, default=0)
    ap.add_argument('--seconds', type=float, default=0)
    ap.add_argument('--cwd')
    ap.add_argument('--stdin', type=Path)
    ap.add_argument('--stdout', type=Path)
    ap.add_argument('--stderr', type=Path)
    ap.add_argument('--append', action='store_true')
    ap.add_argument('--unmetered', action='store_true')
    ap.add_argument('--exit-code', type=int, default=1)
    ap.add_argument('--out', type=Path)
    ap.add_argument('--prompt-file', type=Path)
    ap.add_argument('--system-file', type=Path)
    arguments = sys.argv[1:]
    separator = arguments.index('--') if '--' in arguments else len(arguments)
    args = ap.parse_args(arguments[:separator])
    command = arguments[separator+1:]
    if args.action == 'init':
        inputs = [p for p in (args.prompt_file,args.system_file) if p]
        artifacts = [args.out, Path(str(args.out)+'.partial')] if args.out else []
        for artifact in artifacts:
            for source in inputs:
                if artifact.resolve() == source.resolve() or (artifact.exists() and source.exists() and artifact.samefile(source)):
                    ap.error('output/partial path must differ from prompt inputs')
        for label,artifact in zip(('previous-output.txt','previous-partial.txt'),artifacts):
            if artifact.exists():
                (args.state.parent/label).write_bytes(artifact.read_bytes())
                artifact.unlink()
        now = time.monotonic()
        save(args.state, {'max_attempts':args.max_attempts, 'attempts_used':0,
                         'started_monotonic':now,
                         'deadline_monotonic':now+args.timeout_secs if args.timeout_secs else None,
                         'input_sha256':[hashlib.sha256(p.read_bytes()).hexdigest() for p in inputs],
                         'python_version':sys.version.split()[0],
                         'clock':time.get_clock_info('monotonic').implementation,
                         'attempts':[]})
        return 0
    state = json.loads(args.state.read_text())
    if args.action == 'finish':
        state.update(status='completed' if args.exit_code == 0 else 'cancelled' if args.exit_code in (130,143) else 'failed',
                     runner_exit_code=args.exit_code, elapsed_secs=time.monotonic()-state['started_monotonic'])
        save(args.state, state)
        return 0
    left = remaining(state)
    if args.action == 'sleep':
        if left is not None and left <= args.seconds:
            time.sleep(left)
            return 124
        time.sleep(args.seconds)
        return 0
    if left is not None and left <= 0:
        print('Runner total deadline exhausted.', file=sys.stderr)
        return 124
    if not args.unmetered and state['attempts_used'] >= state['max_attempts']:
        print('Runner total call budget exhausted.', file=sys.stderr)
        return 125
    if not command: ap.error('command is required')
    entry = None
    if not args.unmetered:
        state['attempts_used'] += 1
        index = state['attempts_used']
        entry = {'index':index, 'status':'running', 'actual_model':None,
                 'requested_model':command[command.index('-m')+1] if '-m' in command else None}
        state['attempts'].append(entry)
        save(args.state, state)  # consume before spawning; no reset at fallback/continuation
    started = time.monotonic()
    cancelled = 0
    proc = None

    def cancel(signum, frame):
        # Only record the request. The supervising code stops the CLI's group
        # before it reaps; a handler that did so could interrupt a reap.
        nonlocal cancelled
        cancelled = signum

    signal.signal(signal.SIGTERM, cancel)
    signal.signal(signal.SIGINT, cancel)
    code = 1
    offsets = {p: p.stat().st_size if args.append and p.exists() else 0
               for p in (args.stdout, args.stderr)}
    with contextlib.ExitStack() as stack:
        stdin = stack.enter_context(args.stdin.open('rb')) if args.stdin else subprocess.DEVNULL
        stdout = stack.enter_context(args.stdout.open('ab' if args.append else 'wb'))
        stderr = stack.enter_context(args.stderr.open('ab' if args.append else 'wb'))
        try:
            if cancelled: return 128+cancelled
            proc = subprocess.Popen(command, cwd=args.cwd, stdin=stdin, stdout=stdout,
                                    stderr=stderr, start_new_session=True)
            timed_out = False
            reaped_elsewhere = False
            try:
                while not cancelled:
                    left = remaining(state)
                    if child_exited(proc.pid, 0.05 if left is None else max(0, min(0.05, left))):
                        break
                    if left is not None and left <= 0:
                        timed_out = True
                        break
            except ChildReapingError:
                reaped_elsewhere = True
            finally:
                stop_group(proc, reaped_elsewhere)
            code = proc.returncode
            if timed_out:
                stderr.write(b'Runner subprocess timed out: total deadline exhausted.\n')
                code = 124
            if cancelled: code = 128+cancelled
            if reaped_elsewhere:
                stderr.write(b'Runner subprocess was reaped outside the supervisor (SIGCHLD ignored); its process group was not signalled and its exit status is unknown.\n')
                code = 70
        except OSError as exc:
            stderr.write((str(exc)+'\n').encode())
            code = 127
    if entry is not None:
        # Raw events remain per call even when retries share an aggregate file.
        trace = args.state.parent
        for suffix, source in [('stdout',args.stdout), ('stderr',args.stderr)]:
            target = trace/f'attempt_{index}.{suffix}'
            target.write_bytes(source.read_bytes()[offsets[source]:])
            entry[suffix] = target.name
        entry.update(status='cancelled' if cancelled else 'timed_out' if code == 124 else 'exited',
                     exit_code=code, elapsed_secs=time.monotonic()-started)
        save(args.state, state)
    return code if code >= 0 else 128-code


if __name__ == '__main__':
    raise SystemExit(main())
