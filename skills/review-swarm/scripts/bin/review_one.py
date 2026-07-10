#!/usr/bin/env python3
"""review_one.py — one-command single-reviewer entry for review-swarm.

Assembles the whole review packet (system prompt from templates/<role>.md; user
packet embedding artifact files or a git diff, plus optional context) and then
delegates to run_multi_task.py in this same directory, so runner discovery,
per-backend read-only tool modes, process-group timeouts, trace.jsonl/meta.json
artifacts and contract checking are inherited from the one launcher — there is
no second orchestration path.

A single reviewer is one model family: its verdict is ADVISORY. Final verdicts
require cross-family review (see SKILL.md, "Host-aware execution").

Examples:
    python3 review_one.py --model codex/default --artifact notes.md
    python3 review_one.py --model gemini/default --diff main..HEAD --role correctness
"""

from __future__ import annotations

import argparse
import contextlib
import json
import os
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

_SCRIPT_DIR = Path(__file__).resolve().parent
if str(_SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(_SCRIPT_DIR))

import run_multi_task  # same-directory launcher; single orchestration path

_SKILL_ROOT = _SCRIPT_DIR.parents[1]
_TEMPLATES_DIR = _SKILL_ROOT / "templates"
_ROLES = ("generic", "correctness", "execution-adversary", "source-fidelity")
_RUNNER_BACKENDS = ("opencode", "claude", "codex", "gemini", "kimi")

ADVISORY_BANNER = "single-family review — advisory; final verdicts require cross-family review"

_PACKET_FRAMING = """\
=== REVIEW TASK ===

Review the material embedded below against your system-prompt role. Everything
you are expected to judge is embedded in this packet; ground every finding in
the embedded text (quote the exact line or name the exact location). Produce
exactly the output format your system prompt requires: the verdict first line,
then all required section headers.
"""


def _read_input_file(raw: str, *, label: str) -> tuple[Path, str]:
    p = Path(raw).expanduser().resolve()
    if not p.is_file():
        raise ValueError(f"{label} file not found: {p}")
    return p, p.read_text(encoding="utf-8", errors="replace")


def _run_git_diff(diff_range: str) -> str:
    if diff_range.startswith("-"):
        # Injection guard: the value is passed as an argument to `git diff`, so a
        # leading "-" would be read as a git option (e.g. --output=..., --ext-diff),
        # not a revision range. Git refs themselves can never start with "-".
        raise ValueError(
            f"--diff value {diff_range!r} starts with '-' and would be interpreted as a "
            "git option, not a revision range (git refs cannot start with '-'); "
            "pass a BASE..HEAD revision range"
        )
    proc = subprocess.run(["git", "diff", diff_range], check=False, capture_output=True, text=True)
    if proc.returncode != 0:
        raise ValueError(f"`git diff {diff_range}` failed: {proc.stderr.strip()}")
    if not proc.stdout.strip():
        raise ValueError(f"`git diff {diff_range}` produced no output — nothing to review")
    return proc.stdout


def _assemble_packet(args: argparse.Namespace) -> str:
    parts = [ADVISORY_BANNER, "", _PACKET_FRAMING]
    for raw in args.artifact or []:
        path, text = _read_input_file(raw, label="--artifact")
        parts.append(f"=== ARTIFACT: {path} ===\n\n{text.rstrip()}\n\n=== END ARTIFACT ===\n")
    if args.diff:
        diff_text = _run_git_diff(args.diff)
        parts.append(
            f"=== DIFF ({args.diff}) — output of `git diff {args.diff}` ===\n\n"
            f"{diff_text.rstrip()}\n\n=== END DIFF ===\n"
        )
    if args.context:
        path, text = _read_input_file(args.context, label="--context")
        parts.append(f"=== ADDITIONAL CONTEXT: {path} ===\n\n{text.rstrip()}\n\n=== END CONTEXT ===\n")
    return "\n".join(parts)


def _parse_args(argv: Optional[list[str]] = None) -> argparse.Namespace:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--model", required=True,
                    help="Exactly one model spec — required, no default (e.g. codex/default, "
                         "gemini/default, kimi/default, claude/<model>, or an OpenCode provider/model).")
    source = ap.add_mutually_exclusive_group(required=True)
    source.add_argument("--artifact", action="append", default=None, metavar="PATH",
                        help="File to embed as the review target. Repeatable.")
    source.add_argument("--diff", default=None, metavar="BASE..HEAD",
                        help="Embed the output of `git diff BASE..HEAD` as the review target.")
    ap.add_argument("--role", choices=_ROLES, default="generic",
                    help="Reviewer role; the system prompt is templates/<role>.md (default: generic).")
    ap.add_argument("--context", default=None, metavar="PATH",
                    help="Optional context file appended to the packet.")
    ap.add_argument("--out-dir", type=Path, default=None,
                    help="Output directory (default: ./review-one-<UTC timestamp>/).")
    ap.add_argument("--host-family", default=None, metavar="FAMILY",
                    help="Your own (host) model family, e.g. claude. When --model resolves to it, "
                         "the run is refused: review your own family in-host, not via its CLI.")
    ap.add_argument("--use-project-config", action="store_true",
                    help="Allow .nullius/review-swarm.json auto-discovery in the launcher: "
                         "REVIEW_SWARM_NO_AUTO_CONFIG is removed for the delegated run even "
                         "when the caller's environment already sets it (prior value restored "
                         "afterward). Default: disabled via REVIEW_SWARM_NO_AUTO_CONFIG=1 for "
                         "hermetic runs.")
    ap.add_argument("--timeout-secs", type=int, default=None,
                    help="Per-backend timeout override, forwarded to the launcher.")
    ap.add_argument("--backend-tool-mode", action="append", default=[], metavar="BACKEND=MODE",
                    help="Forwarded to the launcher (e.g. claude=review, gemini=review). Repeatable.")
    guard = ap.add_mutually_exclusive_group()
    guard.add_argument("--max-prompt-bytes", type=int, default=None,
                       help="Refuse when an assembled input exceeds this many bytes.")
    guard.add_argument("--max-prompt-chars", type=int, default=None,
                       help="Refuse when an assembled input exceeds this many characters.")
    for backend in _RUNNER_BACKENDS:
        ap.add_argument(f"--{backend}-runner", type=Path, default=None,
                        help=f"Optional override path to the {backend} runner script (forwarded).")
    return ap.parse_args(argv)


def _validate_model(args: argparse.Namespace) -> None:
    model = str(args.model or "").strip()
    if not model or "," in model:
        raise ValueError("--model takes exactly one model spec (no commas, no default)")
    backend, _ = run_multi_task._classify_model(model)
    if str(args.host_family or "").strip().lower() == backend:
        raise ValueError(
            f"--model {model} resolves to backend '{backend}', which is your own (host) family. "
            "Review your own family in-host — a native child-agent/sub-agent primitive if your "
            "host has one, else inline — never through its own CLI; for an independent reviewer "
            "here, pick a --model from a different family (see SKILL.md, 'Host-aware execution')."
        )


def _delegate(args: argparse.Namespace, *, out_dir: Path, system_path: Path, packet_path: Path) -> int:
    argv = ["run_multi_task.py", "--out-dir", str(out_dir), "--system", str(system_path),
            "--prompt", str(packet_path), "--models", str(args.model).strip(), "--check-review-contract",
            # The launcher default is 0 (strictly additive for its other
            # path-pinned consumers); this entry opts in to one orchestrator-level
            # rerun when the runner exits 0 but writes an empty output file.
            "--retry-empty-output", "1"]
    if args.timeout_secs is not None:
        argv += ["--timeout-secs", str(args.timeout_secs)]
    for entry in args.backend_tool_mode:
        argv += ["--backend-tool-mode", str(entry)]
    for backend in _RUNNER_BACKENDS:
        override = getattr(args, f"{backend}_runner")
        if override is not None:
            argv += [f"--{backend}-runner", str(override)]

    prior_argv, prior_env = sys.argv, os.environ.get("REVIEW_SWARM_NO_AUTO_CONFIG")
    if args.use_project_config:
        # Opt-in must also win over an inherited REVIEW_SWARM_NO_AUTO_CONFIG=1
        # from the caller's environment: remove it for the delegated invocation.
        os.environ.pop("REVIEW_SWARM_NO_AUTO_CONFIG", None)
    else:
        os.environ["REVIEW_SWARM_NO_AUTO_CONFIG"] = "1"
    try:
        sys.argv = argv
        return int(run_multi_task.main())
    finally:
        sys.argv = prior_argv
        if prior_env is None:
            os.environ.pop("REVIEW_SWARM_NO_AUTO_CONFIG", None)
        else:
            os.environ["REVIEW_SWARM_NO_AUTO_CONFIG"] = prior_env


def _print_summary(*, out_dir: Path, packet_path: Path) -> None:
    meta_path = out_dir / "meta.json"
    agent: dict = {}
    with contextlib.suppress(Exception):
        agents = json.loads(meta_path.read_text(encoding="utf-8")).get("agents") or []
        if agents and isinstance(agents[0], dict):
            agent = agents[0]
    print(f"note: {ADVISORY_BANNER}")
    print(f"verdict: {agent.get('verdict') or 'NONE'}")
    print(f"contract_ok: {json.dumps(agent.get('contract_ok'))}")
    print(f"output: {agent.get('out') or ''}")
    print(f"packet: {packet_path}")
    print(f"meta: {meta_path}")
    print(f"trace: {out_dir / 'trace.jsonl'}")


def main(argv: Optional[list[str]] = None) -> int:
    args = _parse_args(argv)
    try:
        _validate_model(args)
        template_path = _TEMPLATES_DIR / f"{args.role}.md"
        if not template_path.is_file():
            raise ValueError(f"role template not found: {template_path}")

        stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
        out_dir = (args.out_dir or Path(f"review-one-{stamp}")).expanduser().resolve()
        inputs_dir = out_dir / "inputs"
        system_path, packet_path = inputs_dir / "system.md", inputs_dir / "packet.md"

        packet_text = _assemble_packet(args)
        run_multi_task._atomic_write_text(system_path, template_path.read_text(encoding="utf-8"))
        run_multi_task._atomic_write_text(packet_path, packet_text)
        if args.max_prompt_bytes is not None or args.max_prompt_chars is not None:
            for label, path in (("system", system_path), ("prompt", packet_path)):
                # Existing launcher guard semantics; overflow="fail" refuses an
                # oversize input with the guard's own message (no truncation).
                run_multi_task._apply_prompt_limit(
                    path, label=label, out_dir=inputs_dir, trace_path=out_dir / "trace.jsonl",
                    max_bytes=args.max_prompt_bytes, max_chars=args.max_prompt_chars, overflow="fail",
                )
    except ValueError as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 2

    rc = _delegate(args, out_dir=out_dir, system_path=system_path, packet_path=packet_path)
    _print_summary(out_dir=out_dir, packet_path=packet_path)
    return rc


if __name__ == "__main__":
    raise SystemExit(main())
