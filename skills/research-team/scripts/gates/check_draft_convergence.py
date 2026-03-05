#!/usr/bin/env python3
"""
Deterministic convergence gate for the LaTeX draft cycle (A/B/Leader).

Convergence criterion (strict):
- Every report declares:
  - Verdict: ready for review cycle
  - Blocking issues count: 0

Exit codes:
  0  converged
  1  not converged (needs revision / blocking issues present)
  2  input/parse error (missing files or contract violations)
"""

from __future__ import annotations

import argparse
import datetime as _dt
import os
import re
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "lib"))

from convergence_schema import (
    build_gate_meta,
    default_member_status,
    emit_convergence_result,
    validate_convergence_result,
)
from team_config import get_language_tokens, load_team_config  # type: ignore


def _utc_now() -> str:
    return _dt.datetime.utcnow().replace(microsecond=0).isoformat() + "Z"


def _extract_section_by_heading_prefix(text: str, prefix: str) -> str:
    """
    Extract a section starting at a "## ..." heading whose title starts with `prefix`
    (case-insensitive), ending before the next "## " heading.
    """
    pat = re.compile(rf"^##\s+{re.escape(prefix)}\b.*$", re.MULTILINE | re.IGNORECASE)
    m = pat.search(text)
    if not m:
        return ""
    start = m.end()
    m2 = re.compile(r"^##\s+", re.MULTILINE).search(text, start)
    end = m2.start() if m2 else len(text)
    return text[start:end].strip()


def _first_match(pattern: str, text: str) -> str:
    m = re.search(pattern, text, flags=re.IGNORECASE | re.MULTILINE)
    return (m.group(1).strip() if m else "").strip()


def _parse_verdict_value(value: str, ready_tokens: tuple[str, ...], needs_tokens: tuple[str, ...]) -> str:
    v = (value or "").strip()
    if not v:
        return "unknown"
    vl = v.lower()
    ready_l = tuple(t.lower() for t in ready_tokens)
    needs_l = tuple(t.lower() for t in needs_tokens)

    has_needs = ("needs revision" in vl) or ("not ready" in vl) or any(t in vl for t in needs_l)
    has_ready = ("ready for review cycle" in vl) or ("ready for next milestone" in vl) or any(t in vl for t in ready_l)

    if has_needs and has_ready:
        return "unknown"
    if has_needs:
        return "needs_revision"
    if has_ready:
        return "ready"
    return "unknown"


def _count_list_items(section_text: str) -> int:
    """
    Count top-level list items in a section.
    - Counts *top-level* items only (indentation == 0; no leading whitespace):
      - `- ...` / `* ...`
      - `1. ...`
    - Ignores explicit empty markers like `(none)` / `none`.
    """
    count = 0
    for ln in (section_text or "").splitlines():
        raw = ln.rstrip("\n")
        if not raw.strip():
            continue
        if raw.strip().lower() in {"(none)", "none"}:
            continue
        m = re.match(r"^(\s*)([-*])\s+(.*)$", raw)
        if m:
            indent = len(m.group(1).replace("\t", "    "))
            if indent != 0:
                continue
            item = (m.group(3) or "").strip()
            if item.lower() in {"(none)", "none"}:
                continue
            count += 1
            continue
        m = re.match(r"^(\s*)(\d+)\.\s+(.*)$", raw)
        if m:
            indent = len(m.group(1).replace("\t", "    "))
            if indent != 0:
                continue
            item = (m.group(3) or "").strip()
            if item.lower() in {"(none)", "none"}:
                continue
            count += 1
            continue
    return count


def _extract_list_like(section_text: str) -> str:
    lines: list[str] = []
    for ln in (section_text or "").splitlines():
        s = ln.rstrip()
        if s.strip().startswith(("-", "*")) or re.match(r"^\s*\d+\.\s+", s):
            lines.append(s)
    return "\n".join(lines).strip() if lines else section_text.strip()


def _rel_link(from_dir: Path, target: Path) -> str:
    rel = os.path.relpath(target.resolve(), start=from_dir.resolve()).replace(os.sep, "/")
    if not rel.startswith("."):
        rel = "./" + rel
    return rel


@dataclass(frozen=True)
class DraftReportStatus:
    name: str
    path: Path
    verdict: str  # ready | needs_revision | unknown
    blocking_declared: int | None
    blocking_count: int | None
    errors: tuple[str, ...]
    blocking_section: str
    minimal_fix_list: str


def _parse_report(name: str, path: Path) -> DraftReportStatus:
    text = path.read_text(encoding="utf-8", errors="replace")
    cfg = load_team_config(path)
    _pass_tokens, _fail_tokens, ready_tokens, needs_tokens = get_language_tokens(cfg)

    verdict_sec = _extract_section_by_heading_prefix(text, "Verdict")
    if not verdict_sec:
        return DraftReportStatus(
            name=name,
            path=path,
            verdict="unknown",
            blocking_declared=None,
            blocking_count=None,
            errors=("missing section: ## Verdict",),
            blocking_section="",
            minimal_fix_list="",
        )

    verdict_value = _first_match(r"^\s*Verdict\s*:\s*(.+?)\s*$", verdict_sec)
    verdict = _parse_verdict_value(verdict_value, ready_tokens, needs_tokens)

    blocking_declared_s = _first_match(r"^\s*Blocking issues count\s*:\s*(\d+)\s*$", verdict_sec)
    blocking_declared: int | None = None
    if blocking_declared_s.isdigit():
        blocking_declared = int(blocking_declared_s)

    blocking_sec = _extract_section_by_heading_prefix(text, "Blocking")
    minimal_sec = _extract_section_by_heading_prefix(text, "Minimal Fix List")

    errors: list[str] = []
    if verdict_value == "":
        errors.append("missing 'Verdict: ...' line in ## Verdict")
    elif verdict == "unknown":
        errors.append(f"unparseable Verdict value: {verdict_value!r}")
    if blocking_declared is None:
        errors.append("missing 'Blocking issues count: N' line in ## Verdict")
    if not blocking_sec:
        errors.append("missing section: ## Blocking ...")

    blocking_count = _count_list_items(blocking_sec) if blocking_sec else None
    if blocking_declared is not None and blocking_count is not None and blocking_declared != blocking_count:
        errors.append(f"blocking count mismatch: declared={blocking_declared} vs bullets={blocking_count}")

    return DraftReportStatus(
        name=name,
        path=path,
        verdict=verdict,
        blocking_declared=blocking_declared,
        blocking_count=blocking_count,
        errors=tuple(errors),
        blocking_section=_extract_list_like(blocking_sec) if blocking_sec else "",
        minimal_fix_list=_extract_list_like(minimal_sec) if minimal_sec else "",
    )


def _write_log(
    out_path: Path,
    tag: str,
    statuses: tuple[DraftReportStatus, ...],
    converged: bool,
) -> None:
    out_path.parent.mkdir(parents=True, exist_ok=True)
    base = out_path.parent
    lines: list[str] = []
    lines.append(f"# Draft Convergence Log — {tag or '(tag)'}")
    lines.append("")
    lines.append(f"Generated at (UTC): {_utc_now()}")
    lines.append("")
    lines.append(f"- Status: {'converged' if converged else 'not_converged'}")
    lines.append("")
    lines.append("## Parsed Status")
    lines.append("")
    lines.append("| Member | Verdict | Blocking issues | Report |")
    lines.append("|---|---|---:|---|")
    for st in statuses:
        v = st.verdict
        bc = st.blocking_declared if st.blocking_declared is not None else "?"
        href = _rel_link(base, st.path)
        lines.append(f"| {st.name} | {v} | {bc} | [{st.path.name}]({href}) |")
    lines.append("")

    for st in statuses:
        lines.append(f"## {st.name} — Blocking Issues")
        lines.append("")
        lines.append(st.blocking_section.strip() or "(none)")
        lines.append("")
        lines.append(f"## {st.name} — Minimal Fix List")
        lines.append("")
        lines.append(st.minimal_fix_list.strip() or "(none)")
        lines.append("")

    lines.append("## Author Response / Adjudication (fill)")
    lines.append("")
    lines.append("- Decision: revision_required | proceed")
    lines.append("- Rationale:")
    lines.append("- Minimal evidence to add (if any):")
    lines.append("- Next tag:")
    lines.append("")
    out_path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def _write_summary(
    out_path: Path,
    tag: str,
    statuses: tuple[DraftReportStatus, ...],
    converged: bool,
) -> None:
    out_path.parent.mkdir(parents=True, exist_ok=True)
    base = out_path.parent
    lines: list[str] = []
    lines.append(f"# Draft Converged Summary — {tag or '(tag)'}")
    lines.append("")
    lines.append(f"Generated at (UTC): {_utc_now()}")
    lines.append("")
    lines.append(f"- Status: {'converged' if converged else 'not_converged'}")
    lines.append("")
    if not converged:
        lines.append("## Next Action")
        lines.append("")
        lines.append("This draft cycle is not converged. Apply the blocking fixes and rerun with a new tag (e.g., `D0-r2`).")
        lines.append("")

    lines.append("## Consolidated Minimal Fix List")
    lines.append("")
    for st in statuses:
        href = _rel_link(base, st.path)
        lines.append(f"### {st.name} ({st.path.name})")
        lines.append(f"- Report: [{st.path.name}]({href})")
        lines.append("")
        lines.append(st.minimal_fix_list.strip() or "(none)")
        lines.append("")

    out_path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def _member_key(name: str) -> str:
    lowered = name.lower()
    if lowered.startswith("member a"):
        return "member_a"
    if lowered.startswith("member b"):
        return "member_b"
    if lowered.startswith("member c"):
        return "member_c"
    return re.sub(r"[^a-z0-9]+", "_", lowered).strip("_")


def _summarize_member(st: DraftReportStatus) -> dict[str, Any]:
    return {
        "verdict": st.verdict if st.verdict in {"ready", "needs_revision"} else "unknown",
        "blocking_count": st.blocking_declared,
        "parse_ok": len(st.errors) == 0,
        "source_path": str(st.path),
        "errors": list(st.errors),
    }


def _collect_not_converged_reasons(statuses: tuple[DraftReportStatus, ...]) -> list[str]:
    reasons: list[str] = []
    for st in statuses:
        key = _member_key(st.name)
        if st.verdict != "ready":
            reasons.append(f"{key}: verdict={st.verdict}")
        declared = st.blocking_declared if st.blocking_declared is not None else -1
        if declared != 0:
            reasons.append(f"{key}: blocking_count={declared}")
    if not reasons:
        reasons.append("convergence criteria not satisfied")
    return reasons


def _emit_result_or_fallback(
    *,
    status: str,
    exit_code: int,
    reasons: list[str],
    report_status: dict[str, Any],
    meta: dict[str, Any],
    out_json: Path | None,
) -> int:
    result: dict[str, Any] = {
        "status": status,
        "exit_code": exit_code,
        "reasons": reasons,
        "report_status": report_status,
        "meta": meta,
    }
    schema_errors = validate_convergence_result(result)
    if schema_errors:
        result = {
            "status": "parse_error",
            "exit_code": 2,
            "reasons": ["schema validation failed", *schema_errors],
            "report_status": {
                k: {**v, "parse_ok": False}
                for k, v in report_status.items()
            },
            "meta": meta,
        }
        exit_code = 2
    emit_convergence_result(result, out_json=out_json)
    return exit_code


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--tag", default="", help="Draft round tag (optional, for logs).")
    p.add_argument("--member-a", type=Path, required=True, help="Draft Member A report path.")
    p.add_argument("--member-b", type=Path, required=True, help="Draft Member B report path.")
    p.add_argument("--member-c", type=Path, required=True, help="Draft Member C (leader audit) report path.")
    p.add_argument("--out-log", type=Path, default=None, help="Write a Markdown convergence log (optional).")
    p.add_argument("--out-summary", type=Path, default=None, help="Write a Markdown converged summary (optional).")
    p.add_argument("--out-json", type=Path, default=None, help="Write structured convergence JSON (optional).")
    args = p.parse_args()

    meta = build_gate_meta("draft_convergence")
    meta["tag"] = args.tag

    missing_reasons: list[str] = []
    for name, path in (("Member A", args.member_a), ("Member B", args.member_b), ("Member C", args.member_c)):
        if not path.is_file():
            missing_reasons.append(f"{name} report not found: {path}")
    if missing_reasons:
        return _emit_result_or_fallback(
            status="parse_error",
            exit_code=2,
            reasons=missing_reasons,
            report_status={
                "member_a": default_member_status(args.member_a),
                "member_b": default_member_status(args.member_b),
                "member_c": default_member_status(args.member_c),
            },
            meta=meta,
            out_json=args.out_json,
        )

    statuses = (
        _parse_report("Member A", args.member_a),
        _parse_report("Member B", args.member_b),
        _parse_report("Member C (Leader)", args.member_c),
    )

    parse_errors: list[str] = []
    for st in statuses:
        for e in st.errors:
            parse_errors.append(f"{st.name}: {e} ({st.path})")

    report_status: dict[str, Any] = {
        _member_key(st.name): _summarize_member(st)
        for st in statuses
    }

    if parse_errors:
        if args.out_log is not None:
            _write_log(args.out_log, args.tag, statuses, converged=False)
        if args.out_summary is not None:
            _write_summary(args.out_summary, args.tag, statuses, converged=False)
        return _emit_result_or_fallback(
            status="parse_error",
            exit_code=2,
            reasons=parse_errors,
            report_status=report_status,
            meta=meta,
            out_json=args.out_json,
        )

    converged = all(st.verdict == "ready" and (st.blocking_declared or 0) == 0 for st in statuses)

    if args.out_log is not None:
        _write_log(args.out_log, args.tag, statuses, converged=converged)
    if args.out_summary is not None:
        _write_summary(args.out_summary, args.tag, statuses, converged=converged)

    if converged:
        return _emit_result_or_fallback(
            status="converged",
            exit_code=0,
            reasons=[],
            report_status=report_status,
            meta=meta,
            out_json=args.out_json,
        )
    return _emit_result_or_fallback(
        status="not_converged",
        exit_code=1,
        reasons=_collect_not_converged_reasons(statuses),
        report_status=report_status,
        meta=meta,
        out_json=args.out_json,
    )


if __name__ == "__main__":
    raise SystemExit(main())
