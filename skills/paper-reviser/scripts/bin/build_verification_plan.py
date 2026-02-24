#!/usr/bin/env python3
"""
build_verification_plan.py

Convert paper-reviser `verification_requests.json` into an executable (orchestration-friendly)
plan for literature verification using research-team's `literature_fetch.py`.

Design goals:
- Deterministic (stable ordering, deduplication).
- Dependency-free (stdlib only).
- Portable enough for orchestration (provides both template argv with ${SKILLS_DIR} and resolved argv).

Typical usage:
  python3 build_verification_plan.py --in /path/to/verification_requests.json

Outputs:
  - verification_plan.json (default: next to the input json)

This script does NOT run network calls. It only produces the plan.
"""

from __future__ import annotations

import argparse
import json
import os
import re
from dataclasses import dataclass
from datetime import datetime, timezone
from hashlib import sha256
from pathlib import Path
from typing import Any


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _sha256_file(path: Path) -> str:
    h = sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def _codex_home() -> Path:
    env = os.environ.get("CODEX_HOME", "").strip()
    if env:
        return Path(env).expanduser().resolve()
    return (Path.home() / ".codex").resolve()


def _default_skills_dir() -> Path:
    return _codex_home() / "skills"


def _default_literature_fetch(skills_dir: Path) -> Path:
    return skills_dir / "research-team" / "scripts" / "bin" / "literature_fetch.py"


_RE_ARXIV_NEW = re.compile(r"\b(?P<id>\d{4}\.\d{4,5})(?:v\d+)?\b")
_RE_ARXIV_OLD = re.compile(r"\b(?P<id>[a-z-]+/\d{7})(?:v\d+)?\b", flags=re.IGNORECASE)
_RE_DOI = re.compile(r"\b(10\.\d{4,9}/[^\s\"<>]+)\b", flags=re.IGNORECASE)
_RE_INSPIRE_RECID = re.compile(r"\b(?:recid\s*[:=]\s*)?(?P<id>\d{5,10})\b", flags=re.IGNORECASE)


def _extract_arxiv_ids(ref: str) -> list[str]:
    out: list[str] = []
    for m in _RE_ARXIV_NEW.finditer(ref):
        out.append(m.group("id"))
    for m in _RE_ARXIV_OLD.finditer(ref):
        out.append(m.group("id"))
    return out


def _extract_dois(ref: str) -> list[str]:
    return [m.group(1).rstrip(").,;") for m in _RE_DOI.finditer(ref)]


def _extract_inspire_recids(ref: str) -> list[str]:
    # Heuristic: accept "INSPIRE recid: 1234567" or "recid=1234567".
    if "inspire" not in ref.lower() and "recid" not in ref.lower():
        return []
    out: list[str] = []
    for m in _RE_INSPIRE_RECID.finditer(ref):
        out.append(m.group("id"))
    return out


def _normalize_query(q: str) -> str:
    return " ".join(q.strip().split())


@dataclass(frozen=True)
class TaskSpec:
    cmd: str
    argv_template: tuple[str, ...]
    argv_resolved: tuple[str, ...]
    meta: tuple[tuple[str, str], ...]  # small stable key/value tuples


def _task_key(t: TaskSpec) -> tuple[str, tuple[str, ...]]:
    # Deduplicate by the resolved argv (stable and unambiguous).
    return (t.cmd, t.argv_resolved)


def _make_task(
    *,
    cmd: str,
    script_template: str,
    script_resolved: str,
    args: list[str],
    meta: dict[str, str],
) -> TaskSpec:
    argv_t = ("python3", script_template, cmd, *args)
    argv_r = ("python3", script_resolved, cmd, *args)
    return TaskSpec(cmd=cmd, argv_template=argv_t, argv_resolved=argv_r, meta=tuple(sorted(meta.items())))


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--in", dest="input_json", required=True, type=Path, help="Path to paper-reviser verification_requests.json")
    ap.add_argument(
        "--out",
        dest="out_json",
        default=None,
        type=Path,
        help="Output plan path (default: <input_dir>/verification_plan.json)",
    )
    ap.add_argument("--skills-dir", default=None, type=Path, help="Override skills directory (default: $CODEX_HOME/skills)")
    ap.add_argument(
        "--literature-fetch",
        default=None,
        type=Path,
        help="Override path to research-team literature_fetch.py (default: <skills-dir>/research-team/scripts/bin/literature_fetch.py)",
    )
    ap.add_argument("-n", "--max-results", type=int, default=5, help="Max results for search tasks (default: 5)")
    ap.add_argument("--kb-dir", default="knowledge_base/literature", help="KB output dir for *-get tasks (default: knowledge_base/literature)")
    ap.add_argument(
        "--trace-path",
        default="knowledge_base/methodology_traces/literature_queries.md",
        help="Trace log path for write-trace (default: knowledge_base/methodology_traces/literature_queries.md)",
    )
    ap.add_argument(
        "--arxiv-src-dir",
        default="references/arxiv_src",
        help="Output dir for arxiv-source (default: references/arxiv_src)",
    )
    ap.add_argument("--no-inspire-search", action="store_true", help="Disable inspire-search tasks from queries")
    ap.add_argument("--no-arxiv-search", action="store_true", help="Disable arxiv-search tasks from queries")
    ap.add_argument("--no-arxiv-source", action="store_true", help="Disable arxiv-source tasks for arXiv refs")
    ap.add_argument("--no-write-note", action="store_true", help="Disable --write-note for *-get tasks")
    ap.add_argument("--no-write-trace", action="store_true", help="Disable --write-trace for *-search tasks")
    args = ap.parse_args()

    in_path = args.input_json.expanduser().resolve()
    if not in_path.is_file():
        print(f"ERROR: --in not found: {in_path}")
        return 2
    out_path = args.out_json.expanduser().resolve() if args.out_json else (in_path.parent / "verification_plan.json")

    skills_dir = args.skills_dir.expanduser().resolve() if args.skills_dir else _default_skills_dir()
    lit_fetch = args.literature_fetch.expanduser().resolve() if args.literature_fetch else _default_literature_fetch(skills_dir)
    if not lit_fetch.is_file():
        print(f"ERROR: literature_fetch.py not found: {lit_fetch} (set --skills-dir or --literature-fetch)")
        return 2

    raw = in_path.read_text(encoding="utf-8", errors="replace")
    try:
        obj = json.loads(raw)
    except Exception as exc:
        print(f"ERROR: invalid JSON: {exc}")
        return 2
    if not isinstance(obj, dict) or obj.get("schema_version") != 1 or not isinstance(obj.get("items"), list):
        print("ERROR: input schema invalid: expected {schema_version:1, items:[...]}")
        return 2

    script_template = "${SKILLS_DIR}/research-team/scripts/bin/literature_fetch.py"
    script_resolved = str(lit_fetch)

    tasks: list[TaskSpec] = []
    task_to_vr_ids: dict[tuple[str, tuple[str, ...]], list[str]] = {}

    for item in obj.get("items", []):
        if not isinstance(item, dict):
            continue
        vr_id = str(item.get("id", "")).strip() or "VR-UNKNOWN"
        kind = str(item.get("kind", "")).strip()
        if kind != "literature":
            continue

        queries = item.get("queries", [])
        if isinstance(queries, list):
            for q in queries:
                qq = _normalize_query(str(q))
                if not qq:
                    continue
                if not args.no_inspire_search:
                    a: list[str] = ["--query", qq, "-n", str(args.max_results)]
                    if not args.no_write_trace:
                        a += ["--write-trace", "--trace-path", str(args.trace_path)]
                    t = _make_task(
                        cmd="inspire-search",
                        script_template=script_template,
                        script_resolved=script_resolved,
                        args=a,
                        meta={"source": "query", "query": qq},
                    )
                    k = _task_key(t)
                    if k not in task_to_vr_ids:
                        tasks.append(t)
                        task_to_vr_ids[k] = []
                    task_to_vr_ids[k].append(vr_id)

                if not args.no_arxiv_search:
                    a = ["--query", qq, "-n", str(args.max_results)]
                    if not args.no_write_trace:
                        a += ["--write-trace", "--trace-path", str(args.trace_path)]
                    t = _make_task(
                        cmd="arxiv-search",
                        script_template=script_template,
                        script_resolved=script_resolved,
                        args=a,
                        meta={"source": "query", "query": qq},
                    )
                    k = _task_key(t)
                    if k not in task_to_vr_ids:
                        tasks.append(t)
                        task_to_vr_ids[k] = []
                    task_to_vr_ids[k].append(vr_id)

        refs = item.get("candidate_refs", [])
        if isinstance(refs, list):
            for ref in refs:
                s = str(ref).strip()
                if not s:
                    continue

                for arxiv_id in _extract_arxiv_ids(s):
                    # arxiv-get
                    a = ["--arxiv-id", arxiv_id]
                    if not args.no_write_note:
                        a += ["--write-note", "--kb-dir", str(args.kb_dir)]
                    # Trace note ties the entry to the VR id for audit.
                    a += ["--trace-note", f"paper-reviser:{vr_id}", "--trace-path", str(args.trace_path)]
                    t = _make_task(
                        cmd="arxiv-get",
                        script_template=script_template,
                        script_resolved=script_resolved,
                        args=a,
                        meta={"source": "candidate_ref", "ref": s, "arxiv_id": arxiv_id},
                    )
                    k = _task_key(t)
                    if k not in task_to_vr_ids:
                        tasks.append(t)
                        task_to_vr_ids[k] = []
                    task_to_vr_ids[k].append(vr_id)

                    # arxiv-source (optional)
                    if not args.no_arxiv_source:
                        a2 = ["--arxiv-id", arxiv_id, "--out-dir", str(args.arxiv_src_dir)]
                        t2 = _make_task(
                            cmd="arxiv-source",
                            script_template=script_template,
                            script_resolved=script_resolved,
                            args=a2,
                            meta={"source": "candidate_ref", "ref": s, "arxiv_id": arxiv_id},
                        )
                        k2 = _task_key(t2)
                        if k2 not in task_to_vr_ids:
                            tasks.append(t2)
                            task_to_vr_ids[k2] = []
                        task_to_vr_ids[k2].append(vr_id)

                for recid in _extract_inspire_recids(s):
                    a = ["--recid", recid]
                    if not args.no_write_note:
                        a += ["--write-note", "--kb-dir", str(args.kb_dir)]
                    a += ["--trace-note", f"paper-reviser:{vr_id}", "--trace-path", str(args.trace_path)]
                    t = _make_task(
                        cmd="inspire-get",
                        script_template=script_template,
                        script_resolved=script_resolved,
                        args=a,
                        meta={"source": "candidate_ref", "ref": s, "recid": recid},
                    )
                    k = _task_key(t)
                    if k not in task_to_vr_ids:
                        tasks.append(t)
                        task_to_vr_ids[k] = []
                    task_to_vr_ids[k].append(vr_id)

                for doi in _extract_dois(s):
                    # Prefer crossref-get (metadata + optional KB note).
                    a = ["--doi", doi]
                    if not args.no_write_note:
                        a += ["--write-note", "--kb-dir", str(args.kb_dir)]
                    a += ["--trace-note", f"paper-reviser:{vr_id}", "--trace-path", str(args.trace_path)]
                    t = _make_task(
                        cmd="crossref-get",
                        script_template=script_template,
                        script_resolved=script_resolved,
                        args=a,
                        meta={"source": "candidate_ref", "ref": s, "doi": doi},
                    )
                    k = _task_key(t)
                    if k not in task_to_vr_ids:
                        tasks.append(t)
                        task_to_vr_ids[k] = []
                    task_to_vr_ids[k].append(vr_id)

                    a2 = ["--doi", doi]
                    t2 = _make_task(
                        cmd="doi-bibtex",
                        script_template=script_template,
                        script_resolved=script_resolved,
                        args=a2,
                        meta={"source": "candidate_ref", "ref": s, "doi": doi},
                    )
                    k2 = _task_key(t2)
                    if k2 not in task_to_vr_ids:
                        tasks.append(t2)
                        task_to_vr_ids[k2] = []
                    task_to_vr_ids[k2].append(vr_id)

    # Stable task ids.
    plan_tasks: list[dict[str, Any]] = []
    for i, t in enumerate(tasks, start=1):
        k = _task_key(t)
        vr_ids = sorted(set(task_to_vr_ids.get(k, [])))
        plan_tasks.append(
            {
                "task_id": f"LF-{i:03d}",
                "tool": "research-team.literature_fetch",
                "cmd": t.cmd,
                "vr_ids": vr_ids,
                "argv_template": list(t.argv_template),
                "argv_resolved": list(t.argv_resolved),
                "meta": dict(t.meta),
            }
        )

    plan_obj: dict[str, Any] = {
        "schema_version": 1,
        "generated_at": _utc_now(),
        "inputs": {
            "verification_requests_json": {
                "path": str(in_path),
                "sha256": _sha256_file(in_path),
            },
            "skills_dir": str(skills_dir),
            "literature_fetch_resolved": str(lit_fetch),
            "literature_fetch_template": script_template,
        },
        "defaults": {
            "max_results": int(args.max_results),
            "kb_dir": str(args.kb_dir),
            "trace_path": str(args.trace_path),
            "arxiv_src_dir": str(args.arxiv_src_dir),
            "include_inspire_search": (not bool(args.no_inspire_search)),
            "include_arxiv_search": (not bool(args.no_arxiv_search)),
            "include_arxiv_source": (not bool(args.no_arxiv_source)),
            "write_note": (not bool(args.no_write_note)),
            "write_trace": (not bool(args.no_write_trace)),
        },
        "tasks": plan_tasks,
    }

    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(plan_obj, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print(f"[ok] wrote: {out_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
