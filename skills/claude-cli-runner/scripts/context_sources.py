#!/usr/bin/env python3
"""Record and check which context sources a Claude CLI lane was allowed to load.

The Claude CLI normally loads the operator's own context into every call: the user-level
instruction file, CLAUDE.md/AGENTS.md files of the working directory and its parents, the
auto-memory index of the project, plugins, hooks and skills. A lane whose result must be
independent of the operator's notes and earlier conclusions cannot carry any of that, so the
runner starts the CLI with ``--safe-mode`` by default (it keeps the login; ``--bare`` does not).

``declare`` writes ``context_sources.json`` into the attempt directory before the first call:
the mechanism, what it excludes and what still reaches the lane. ``observe`` reads one live-capture
attempt's stream, writes ``attempt_N.context_observed.json`` and exits 78 when a lane declared
hermetic shows the auto-memory location in its init event, or when a successful hermetic stream has
no init event at all (nothing observed is not evidence of exclusion). The init event does not name
loaded CLAUDE.md files, so that part of the claim rests on the CLI's own exclusion and on the
measured probe recorded with this runner's tests, not on a per-call observation.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

SCHEMA = "claude_lane_context_sources_v1"
NOT_HERMETIC = 78

EXCLUDED = [
    "user-level instruction files (CLAUDE.md and rules in the CLI config directory)",
    "CLAUDE.md, CLAUDE.local.md and AGENTS.md of the working directory and its parents",
    "auto memory (MEMORY.md and topic files of the project)",
    "managed-policy CLAUDE.md",
    "installed plugins, hooks, skills, custom commands and agents, output styles, MCP servers",
]
ADMITTED = [
    "the request's own system prompt (--system-prompt)",
    "the request's own prompt (stdin)",
    "the CLI environment block (working directory, platform, model, date)",
    "account identity attached by the CLI login (e-mail address)",
]


def _write(path: Path, obj: dict) -> None:
    path.write_text(json.dumps(obj, ensure_ascii=False, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def declare(args: argparse.Namespace) -> int:
    hermetic = args.mode == "hermetic"
    record = {
        "schema": SCHEMA,
        "hermetic": hermetic,
        "mechanism": "--safe-mode" if hermetic else "none (--load-operator-context)",
        "excluded": EXCLUDED if hermetic else [],
        "admitted": ADMITTED if hermetic else ADMITTED + ["all operator context the CLI loads by default"],
        "per_call_observation": "init event memory_paths (live capture only)" if args.live_capture
        else "unavailable without live capture",
    }
    _write(Path(args.out), record)
    return 0


def _init_event(events: Path) -> dict | None:
    try:
        lines = events.read_text(encoding="utf-8", errors="replace").splitlines()
    except OSError:
        return None
    for line in lines:
        try:
            obj = json.loads(line)
        except ValueError:
            continue
        if isinstance(obj, dict) and obj.get("type") == "system" and obj.get("subtype") == "init":
            return obj
    return None


def observe(args: argparse.Namespace) -> int:
    init = _init_event(Path(args.events))
    memory = init.get("memory_paths") if init is not None else None
    loaded_memory = sorted(str(v) for v in memory.values() if v) if isinstance(memory, dict) else (
        [str(memory)] if memory else [])
    record = {
        "schema": SCHEMA,
        "init_event_seen": init is not None,
        "memory_paths": loaded_memory,
        "plugins": sorted(str(p.get("name")) for p in init.get("plugins", []) if isinstance(p, dict))
        if init is not None and isinstance(init.get("plugins"), list) else None,
        "hermetic_required": args.mode == "hermetic",
    }
    failure = None
    if args.mode == "hermetic":
        if loaded_memory:
            failure = "the CLI reported an auto-memory location, so operator memory entered the lane"
        elif init is None and args.exit_code == 0:
            failure = "a successful stream carried no init event, so exclusion was not observed"
    record["verdict"] = "not_hermetic" if failure else ("hermetic" if args.mode == "hermetic" else "not_required")
    if failure:
        record["reason"] = failure
    _write(Path(args.out), record)
    if failure:
        print(f"Claude lane rejected: {failure}.", file=sys.stderr)
        return NOT_HERMETIC
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    sub = parser.add_subparsers(dest="command", required=True)
    d = sub.add_parser("declare")
    d.add_argument("--mode", choices=("hermetic", "operator"), required=True)
    d.add_argument("--live-capture", action="store_true")
    d.add_argument("--out", required=True)
    o = sub.add_parser("observe")
    o.add_argument("--mode", choices=("hermetic", "operator"), required=True)
    o.add_argument("--events", required=True)
    o.add_argument("--exit-code", type=int, required=True)
    o.add_argument("--out", required=True)
    args = parser.parse_args(argv)
    return declare(args) if args.command == "declare" else observe(args)


if __name__ == "__main__":
    raise SystemExit(main())
