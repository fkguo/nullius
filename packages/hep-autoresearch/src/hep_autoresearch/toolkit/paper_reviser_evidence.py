from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any

from ._json import write_json
from ._time import utc_now_iso
from .paper_reviser_utils import (
    _fs_token,
    _find_llm_runner,
    _load_json_if_exists,
    _resolve_under_dir,
    _run_logged,
    _safe_rel,
    _sha256_file,
    _skills_dir,
)


def _extract_json_object(text: str) -> dict[str, Any]:
    """
    Best-effort JSON object extraction for LLM outputs.
    - Prefer direct json.loads(text)
    - Else, try to parse a fenced ```json ... ``` block
    - Else, try to parse the first {...} span.
    """
    t = str(text).strip()
    try:
        obj = json.loads(t)
        if isinstance(obj, dict):
            return obj
    except Exception:  # CONTRACT-EXEMPT: CODE-01.5 multi-strategy fallthrough
        pass

    # Try a fenced JSON code block.
    try:
        import re

        m = re.search(r"```(?:json)?\s*(\{.*\})\s*```", t, flags=re.DOTALL)
        if m:
            obj3 = json.loads(m.group(1))
            if isinstance(obj3, dict):
                return obj3
    except Exception:  # CONTRACT-EXEMPT: CODE-01.5 multi-strategy fallthrough
        pass

    # Fallback: naive brace span.
    i = t.find("{")
    j = t.rfind("}")
    if i != -1 and j != -1 and j > i:
        blob = t[i : j + 1]
        try:
            obj2 = json.loads(blob)
            if isinstance(obj2, dict):
                return obj2
        except Exception:  # CONTRACT-EXEMPT: CODE-01.5 multi-strategy fallthrough
            pass
    raise ValueError("could not parse a JSON object from model output")


def _render_vr_markdown(vr: dict[str, Any]) -> str:
    vr_id = str(vr.get("vr_id") or "").strip() or "VR-UNKNOWN"
    verdict = str(vr.get("verdict") or "").strip() or "inconclusive"
    criteria = vr.get("criteria") if isinstance(vr.get("criteria"), list) else []
    evidence_files = vr.get("evidence_files") if isinstance(vr.get("evidence_files"), list) else []
    quotes = vr.get("quotes") if isinstance(vr.get("quotes"), list) else []
    notes = str(vr.get("notes") or "").rstrip()

    lines: list[str] = [f"# {vr_id}", "", f"VERDICT: {verdict}", ""]

    lines.append("## Criteria")
    if criteria:
        for c in criteria[:50]:
            s = str(c).strip()
            if s:
                lines.append(f"- {s}")
    else:
        lines.append("- (none)")
    lines.append("")

    lines.append("## Evidence Files")
    if evidence_files:
        lines.append("")
        lines.append("| path | sha256 | kind |")
        lines.append("|---|---|---|")
        rows = []
        for ef in evidence_files:
            if not isinstance(ef, dict):
                continue
            p = str(ef.get("path") or "").strip()
            sha = str(ef.get("sha256") or "").strip()
            kind = str(ef.get("kind") or "").strip()
            if not p:
                continue
            rows.append((p, sha, kind))
        for p, sha, kind in sorted(rows)[:200]:
            lines.append(f"| `{p}` | `{sha}` | `{kind}` |")
        lines.append("")
    else:
        lines.append("- (none)")
        lines.append("")

    lines.append("## Quotes")
    if quotes:
        # Deterministic ordering.
        rows2 = []
        for q in quotes:
            if not isinstance(q, dict):
                continue
            sp = str(q.get("source_path") or "").strip()
            sha = str(q.get("sha256") or "").strip()
            excerpt = str(q.get("excerpt") or "").strip()
            locator = q.get("locator")
            loc_s = str(locator).strip() if isinstance(locator, str) else ""
            if not sp or not excerpt:
                continue
            rows2.append((sp, sha, excerpt, loc_s))
        for sp, sha, excerpt, loc_s in sorted(rows2)[:50]:
            lines.append(f"> {excerpt}")
            trailer = f"(source: {sp}, sha256={sha}"
            if loc_s:
                trailer += f", locator={loc_s}"
            trailer += ")"
            lines.append(trailer)
            lines.append("")
    else:
        lines.append("- (none)")
        lines.append("")

    lines.append("## Notes")
    if notes.strip():
        lines.append("")
        lines.append(notes)
        lines.append("")
    else:
        lines.append("- (none)\n")

    return "\n".join(lines).rstrip() + "\n"


def _validate_vr_json_obj(
    *,
    vr_id: str,
    obj: dict[str, Any],
    repo_root: Path,
    run_root: Path,
) -> tuple[dict[str, Any], list[str], list[str]]:
    """
    Validate/sanitize a VR evidence JSON object.

    Hard constraint (evidence-first): any referenced file paths must resolve under run_root.
    We accept paths relative to repo_root *or* relative to run_root (LLM-friendly),
    but we store them repo_root-relative in the SSOT output.
    """
    fatal: list[str] = []
    warnings: list[str] = []
    vid = str(vr_id).strip() or "VR-UNKNOWN"

    verdict_raw = str(obj.get("verdict") or "").strip()
    verdict = verdict_raw.lower()
    if verdict not in {"pass", "fail", "inconclusive"}:
        warnings.append(f"invalid verdict: {verdict_raw!r} (coerced to inconclusive)")
        verdict = "inconclusive"

    criteria_raw = obj.get("criteria")
    criteria: list[str] = []
    if isinstance(criteria_raw, list):
        for x in criteria_raw:
            s = str(x).strip()
            if s:
                criteria.append(s)
    elif isinstance(criteria_raw, str):
        s = criteria_raw.strip()
        if s:
            criteria.append(s)
    elif criteria_raw is not None:
        warnings.append("criteria must be a list of strings (coerced to [])")

    def _sanitize_file_list(field_name: str, items: Any, *, key: str) -> tuple[list[dict[str, Any]], list[str]]:
        errs: list[str] = []
        out: list[dict[str, Any]] = []
        if items is None:
            return [], []
        if not isinstance(items, list):
            return [], [f"{field_name} must be a list (coerced to empty)"]
        for it in items:
            if not isinstance(it, dict):
                continue
            p0 = str(it.get(key) or "").strip()
            if not p0:
                continue
            abs_p = _resolve_under_dir(repo_root=repo_root, base_dir=run_root, path_str=p0)
            if abs_p is None:
                errs.append(f"{field_name}: path outside run_root: {p0!r}")
                continue
            if not abs_p.is_file():
                errs.append(f"{field_name}: file not found: {p0!r}")
                continue
            rel = _safe_rel(repo_root, abs_p)
            sha = _sha256_file(abs_p)
            row = dict(it)
            row[key] = rel
            row["sha256"] = sha
            out.append(row)
        return out, errs

    evidence_files, err_ev = _sanitize_file_list("evidence_files", obj.get("evidence_files"), key="path")
    quotes, err_q = _sanitize_file_list("quotes", obj.get("quotes"), key="source_path")
    # Evidence-first: referencing outside run_root (or missing files) is a hard error.
    for e in err_ev:
        if "outside run_root" in e or "file not found" in e:
            fatal.append(e)
        else:
            warnings.append(e)
    for e in err_q:
        if "outside run_root" in e or "file not found" in e:
            fatal.append(e)
        else:
            warnings.append(e)

    notes = str(obj.get("notes") or "").strip()
    if obj.get("notes") is None:
        # Keep it required-but-empty rather than failing hard.
        notes = ""

    out_obj: dict[str, Any] = {
        "schema_version": 1,
        "vr_id": vid,
        "verdict": verdict or "inconclusive",
        "criteria": criteria,
        "evidence_files": evidence_files,
        "quotes": quotes,
        "notes": notes,
    }
    return out_obj, fatal, warnings


def run_step_d_evidence_synthesis(
    *,
    repo_root: Path,
    out_dir: Path,
    ver_root: Path,
    evidence_state_dir: Path,
    evidence_dir: Path,
    kb_dir: Path,
    trace_path: Path,
    executed_tasks: list[dict[str, Any]],
    verification_requests_obj: dict[str, Any] | None,
    vr_ids: list[str],
    can_run: bool,
    manual_evidence: bool,
    evidence_synth_backend: str | None,
    evidence_synth_model: str | None,
    timeout_seconds_evidence_synth: int,
    skills_dir: Path | None,
) -> dict[str, Any]:
    """
    Step D: Evidence synthesis (fan-in).

    Contract (SSOT):
    - Writes per-VR state to evidence_state/<VR-ID>.json
    - Writes per-VR outputs to evidence/<VR-ID>.json + deterministic evidence/<VR-ID>.md
    - Skip rule: state.exit_code==0 and output_json_sha256 matches current output file
    """

    def _evidence_state_ok(
        st_path: Path,
        out_json_path: Path,
        *,
        expect_backend: str,
        expect_model: str,
    ) -> bool:
        st_obj = _load_json_if_exists(st_path)
        if not isinstance(st_obj, dict) or int(st_obj.get("schema_version") or 0) != 1:
            return False
        if int(st_obj.get("exit_code", 999)) != 0:
            return False
        if str(st_obj.get("backend") or "") != str(expect_backend):
            return False
        if str(st_obj.get("model") or "") != str(expect_model):
            return False
        exp = str(st_obj.get("output_json_sha256") or "").strip()
        if not exp:
            return False
        if not out_json_path.is_file():
            return False
        return _sha256_file(out_json_path) == exp

    errors: list[str] = []
    needs_resume = False
    resume_state: dict[str, Any] | None = None

    evidence_done = 0
    evidence_skipped = 0
    synthesized_vrs: list[dict[str, Any]] = []

    if not can_run:
        return {
            "step": {"status": "pending", "note": "blocked upstream (A/B/C)"},
            "evidence_done": 0,
            "evidence_skipped": 0,
            "errors": [],
            "needs_resume": False,
            "resume_state": None,
        }

    if manual_evidence:
        missing_manual: list[str] = []
        for vid in vr_ids:
            # Accept either the raw VR id filename (when safe) or the sanitized file-id.
            vid_fs = _fs_token(vid, kind="VR")
            candidates = [evidence_dir / f"{vid}.md", evidence_dir / f"{vid_fs}.md"]
            # Dedupe in the common case where vid is already safe.
            if not any(p.is_file() for p in dict.fromkeys(candidates)):
                missing_manual.append(vid)
        if missing_manual:
            needs_resume = True
            resume_state = {"step": "D", "reason": "manual_evidence_missing", "missing_vr_ids": missing_manual[:50]}
            return {
                "step": {
                    "status": "needs_manual_evidence",
                    "missing_vr_ids": missing_manual,
                    "evidence_dir": _safe_rel(repo_root, evidence_dir),
                },
                "evidence_done": 0,
                "evidence_skipped": 0,
                "errors": [],
                "needs_resume": True,
                "resume_state": resume_state,
            }
        return {
            "step": {"status": "skipped", "note": "manual evidence provided; synthesis skipped"},
            "evidence_done": 0,
            "evidence_skipped": 0,
            "errors": [],
            "needs_resume": False,
            "resume_state": None,
        }

    backend = str(evidence_synth_backend or "").strip()
    model = str(evidence_synth_model or "").strip()
    if not backend or not model:
        raise ValueError("evidence_synth_backend/model required unless manual_evidence=true")

    raw_dir = ver_root / "evidence_raw"
    raw_dir.mkdir(parents=True, exist_ok=True)
    prompt_dir = ver_root / "evidence_prompts"
    prompt_dir.mkdir(parents=True, exist_ok=True)

    def _read_text_truncated(p: Path, *, max_chars: int) -> str:
        """
        Read UTF-8-ish text best-effort and truncate to max_chars.

        This is intentionally non-strict: quality-first synthesis should see *some*
        evidence rather than fail on encoding edge-cases.
        """
        try:
            txt = p.read_text(encoding="utf-8", errors="replace")
        except Exception:  # CONTRACT-EXEMPT: CODE-01.5 multi-strategy fallthrough
            try:
                txt = p.read_bytes().decode("utf-8", errors="replace")
            except Exception:  # CONTRACT-EXEMPT: CODE-01.5 best-effort file read
                return ""
        if len(txt) > max_chars:
            return txt[:max_chars] + "\n...(truncated)\n"
        return txt

    # Provide a bounded evidence snapshot to the model (avoid huge context).
    def evidence_text_for_vr(vid: str) -> str:
        parts: list[str] = []
        parts.append(f"VR_ID: {vid}\n")

        # 1) The requested verification item (grounding).
        if isinstance(verification_requests_obj, dict):
            items = verification_requests_obj.get("items")
            if isinstance(items, list):
                for it in items:
                    if not isinstance(it, dict):
                        continue
                    if str(it.get("id") or "").strip() != vid:
                        continue
                    parts.append("## Verification request item (JSON)\n")
                    parts.append(json.dumps(it, indent=2, sort_keys=True) + "\n")
                    break

        # 2) Evidence sources and snippets.
        available_files: list[tuple[str, str]] = []  # (repo_rel_path, sha256)

        # Retrieval logs relevant to this VR (often include the fetched record summary).
        for t in executed_tasks:
            if not isinstance(t, dict):
                continue
            vr_list = t.get("vr_ids")
            if not isinstance(vr_list, list) or vid not in [str(x) for x in vr_list]:
                continue
            lp = t.get("log_path")
            if not isinstance(lp, str) or not lp.strip():
                continue
            full = (repo_root / lp).resolve()
            if not full.is_file():
                continue
            sha = _sha256_file(full)
            available_files.append((lp, sha))
            parts.append(f"## Retrieval log ({lp}; sha256={sha})\n")
            parts.append(_read_text_truncated(full, max_chars=12000) + "\n")

        # Trace file (query→selection log).
        if trace_path.is_file():
            tr_rel = _safe_rel(repo_root, trace_path)
            tr_sha = _sha256_file(trace_path)
            available_files.append((tr_rel, tr_sha))
            txt2 = _read_text_truncated(trace_path, max_chars=12000)
            if txt2.strip():
                parts.append(f"## Trace ({tr_rel}; sha256={tr_sha})\n")
                parts.append(txt2 + "\n")

        # KB notes written by literature_fetch.py (higher signal than raw logs).
        if kb_dir.is_dir():
            kb_files: list[Path] = []
            try:
                for p in kb_dir.rglob("*"):
                    if not p.is_file():
                        continue
                    if p.suffix.lower() not in {".md", ".txt"}:
                        continue
                    # Avoid huge blobs.
                    try:
                        if int(p.stat().st_size) > 800_000:
                            continue
                    except Exception:  # CONTRACT-EXEMPT: CODE-01.5 skip unreadable files
                        continue
                    kb_files.append(p)
            except Exception:  # CONTRACT-EXEMPT: CODE-01.5 intentional fallback
                kb_files = []

            kb_files = sorted(kb_files, key=lambda x: _safe_rel(repo_root, x).lower())
            if kb_files:
                parts.append("## KB notes index (kb_dir)\n")
                for p in kb_files[:50]:
                    rel = _safe_rel(repo_root, p)
                    sha = _sha256_file(p)
                    available_files.append((rel, sha))
                    parts.append(f"- {rel} (sha256={sha})")
                parts.append("")

                # Include a few KB note bodies (quality-first; may be redundant but high value).
                for p in kb_files[:5]:
                    rel = _safe_rel(repo_root, p)
                    sha = _sha256_file(p)
                    parts.append(f"## KB note ({rel}; sha256={sha})\n")
                    parts.append(_read_text_truncated(p, max_chars=12000) + "\n")

        # 3) Explicit list of available files (to help the model reference paths correctly).
        if available_files:
            parts.append("## Available files (cite these paths in evidence_files/quotes; must be under RUN_ROOT)\n")
            seen: set[str] = set()
            for rel, sha in available_files:
                if rel in seen:
                    continue
                seen.add(rel)
                parts.append(f"- {rel} (sha256={sha})")
            parts.append("")

        return "\n".join(parts)

    evidence_failed: list[str] = []
    for vid in vr_ids:
        vid_fs = _fs_token(vid, kind="VR")
        st_path = evidence_state_dir / f"{vid_fs}.json"
        out_json = evidence_dir / f"{vid_fs}.json"
        out_md = evidence_dir / f"{vid_fs}.md"

        warnings_this: list[str] = []
        if _evidence_state_ok(st_path, out_json, expect_backend=backend, expect_model=model):
            evidence_skipped += 1
            synthesized_vrs.append(
                {
                    "vr_id": vid,
                    "status": "skipped",
                    "output_json": _safe_rel(repo_root, out_json),
                    "output_md": _safe_rel(repo_root, out_md) if out_md.exists() else None,
                    "output_json_sha256": _sha256_file(out_json),
                }
            )
            continue

        started_at = utc_now_iso().replace("+00:00", "Z")
        rc = 0
        vr_obj: dict[str, Any] | None = None
        raw_out = raw_dir / f"{vid_fs}_{backend}.txt"
        log_path = raw_dir / f"{vid_fs}_{backend}.log"
        attempts_meta: list[dict[str, Any]] = []

        if backend == "stub":
            # Deterministic stub: mark inconclusive and cite the task logs as evidence.
            ts = utc_now_iso().replace("+00:00", "Z")
            ev_files: list[dict[str, str]] = []
            qt: list[dict[str, str]] = []

            for t in executed_tasks:
                if not isinstance(t, dict):
                    continue
                vr_list = t.get("vr_ids")
                if not isinstance(vr_list, list) or vid not in [str(x) for x in vr_list]:
                    continue
                lp = t.get("log_path")
                if not isinstance(lp, str) or not lp.strip():
                    continue
                full = (repo_root / lp).resolve()
                if not full.is_file():
                    continue
                ev_files.append({"path": lp, "sha256": _sha256_file(full), "kind": "task_log"})
                txt = full.read_text(encoding="utf-8", errors="replace").strip()
                if txt:
                    qt.append({"source_path": lp, "sha256": _sha256_file(full), "excerpt": txt[:200]})

            # Also include any small files under kb_dir (best-effort; avoid huge arxiv_src trees).
            for p in sorted(kb_dir.rglob("*"))[:200]:
                if p.is_file():
                    rel = _safe_rel(repo_root, p)
                    ev_files.append({"path": rel, "sha256": _sha256_file(p), "kind": "kb_literature"})

            vr_obj = {
                "schema_version": 1,
                "vr_id": vid,
                "verdict": "inconclusive",
                "criteria": ["stub backend: no LLM synthesis performed; verify manually"],
                "evidence_files": sorted(ev_files, key=lambda d: str(d.get("path") or ""))[:500],
                "quotes": qt[:50],
                "notes": f"Generated by stub backend at {ts}. Replace with manual evidence or an LLM synthesis run.",
            }
            vr_obj2, fatal_errs, warn = _validate_vr_json_obj(vr_id=vid, obj=vr_obj, repo_root=repo_root, run_root=out_dir)
            warnings_this = list(warn)
            if fatal_errs:
                rc = 2
                (evidence_dir / f"{vid_fs}.error.txt").write_text("\n".join(fatal_errs) + "\n", encoding="utf-8")
            else:
                out_json.write_text(json.dumps(vr_obj2, indent=2, sort_keys=True) + "\n", encoding="utf-8")
                out_md.write_text(_render_vr_markdown(vr_obj2), encoding="utf-8")
                raw_out.write_text(json.dumps(vr_obj2, indent=2, sort_keys=True) + "\n", encoding="utf-8")
                log_path.write_text(f"stub evidence_synth for {vid}\n", encoding="utf-8")
                vr_obj = vr_obj2
                rc = 0
        else:
            # LLM backend: call runner scripts (no gate) and require strict JSON output.
            sd = (skills_dir.expanduser().resolve() if skills_dir else _skills_dir())
            runner = _find_llm_runner(skills_dir=sd, backend=backend)
            sys_txt_base = (
                "You are an evidence synthesizer. Output ONLY a single JSON object.\n"
                "Required fields:\n"
                "- schema_version: 1\n"
                "- vr_id: string\n"
                "- verdict: pass|fail|inconclusive\n"
                "- criteria: [string]\n"
                "- evidence_files: [{path, sha256, kind}] (paths must refer to files under the provided RUN_ROOT)\n"
                "- quotes: [{source_path, sha256, excerpt, locator?}] (keep excerpts short)\n"
                "- notes: string\n\n"
                "QUALITY RULE (strict):\n"
                "- If verdict is pass or fail, you MUST include at least one quote.\n"
                "  The quote.source_path MUST be an existing file under RUN_ROOT.\n"
                "- If you cannot provide a quote, set verdict to inconclusive.\n"
            )
            user_txt_base = (
                "Synthesize evidence for this verification request. Prefer conservative verdicts.\n"
                "Use only files under RUN_ROOT (relative paths are preferred).\n"
                "If you reference a file in evidence_files/quotes, it must exist under RUN_ROOT.\n\n"
                + evidence_text_for_vr(vid)
                + "\n\n"
                + f"RUN_ROOT: {_safe_rel(repo_root, out_dir)}\n"
                + f"EVIDENCE_DIR: {_safe_rel(repo_root, evidence_dir)}\n"
            )

            # Quality-first: allow controlled non-determinism via small repair retries.
            max_attempts = 3
            repair_note = ""
            last_raw_out: Path | None = None
            last_log_path: Path | None = None

            for attempt in range(1, max_attempts + 1):
                sys_txt = sys_txt_base
                user_txt = user_txt_base
                if repair_note:
                    user_txt += "\n\n---\n\n## Repair note (from previous attempt)\n" + repair_note + "\n"

                sys_path = prompt_dir / f"{vid_fs}_{backend}_system_attempt{attempt:02d}.txt"
                user_path = prompt_dir / f"{vid_fs}_{backend}_prompt_attempt{attempt:02d}.txt"
                raw_out_attempt = raw_dir / f"{vid_fs}_{backend}_attempt{attempt:02d}.txt"
                log_path_attempt = raw_dir / f"{vid_fs}_{backend}_attempt{attempt:02d}.log"
                sys_path.write_text(sys_txt, encoding="utf-8")
                user_path.write_text(user_txt, encoding="utf-8")

                cmd_llm: list[str] = [
                    "bash",
                    str(runner),
                    "--model",
                    model,
                    "--system-prompt-file",
                    str(sys_path),
                    "--prompt-file",
                    str(user_path),
                    "--out",
                    str(raw_out_attempt),
                ]
                rc_attempt = _run_logged(
                    cmd_llm,
                    cwd=repo_root,
                    log_path=log_path_attempt,
                    timeout_seconds=int(timeout_seconds_evidence_synth),
                )

                last_raw_out = raw_out_attempt
                last_log_path = log_path_attempt
                attempts_meta.append(
                    {
                        "attempt": attempt,
                        "exit_code": int(rc_attempt),
                        "system_prompt": _safe_rel(repo_root, sys_path),
                        "user_prompt": _safe_rel(repo_root, user_path),
                        "raw_output": _safe_rel(repo_root, raw_out_attempt) if raw_out_attempt.exists() else None,
                        "log_path": _safe_rel(repo_root, log_path_attempt) if log_path_attempt.exists() else None,
                    }
                )

                if int(rc_attempt) != 0:
                    if int(rc_attempt) == 127:
                        # Runner missing: fail-fast; retry won't help.
                        msg = (
                            "Evidence synthesis runner not found (exit_code=127).\n"
                            f"- backend: {backend}\n"
                            f"- skills_dir: {os.fspath(sd)}\n"
                            f"- runner: {runner}\n"
                            f"- log: {_safe_rel(repo_root, log_path_attempt)}\n"
                        )
                        (evidence_dir / f"{vid_fs}.error.txt").write_text(msg, encoding="utf-8")
                        rc = 127
                        break

                    repair_note = (
                        f"Runner exited with code {int(rc_attempt)}. "
                        "Please output a single valid JSON object and follow the QUALITY RULE."
                    )
                    continue

                raw_text = raw_out_attempt.read_text(encoding="utf-8", errors="replace") if raw_out_attempt.exists() else ""
                try:
                    obj = _extract_json_object(raw_text)
                except Exception as exc:
                    repair_note = (
                        "Your last output was not a valid JSON object.\n"
                        f"Error: {exc}\n"
                        "Output only a JSON object with the required fields."
                    )
                    continue

                obj["schema_version"] = 1
                obj["vr_id"] = vid
                vr_obj2, fatal_errs2, warn2 = _validate_vr_json_obj(vr_id=vid, obj=obj, repo_root=repo_root, run_root=out_dir)
                warnings_this = list(warn2)
                if fatal_errs2:
                    repair_note = (
                        "Your output referenced files outside RUN_ROOT or missing files.\n"
                        + "\n".join(fatal_errs2[:20])
                        + "\nFix by using only paths listed under 'Available files' (and ensure they exist)."
                    )
                    continue

                verdict = str(vr_obj2.get("verdict") or "").strip().lower()
                quotes = vr_obj2.get("quotes") if isinstance(vr_obj2.get("quotes"), list) else []
                if verdict in {"pass", "fail"} and not quotes:
                    if attempt < max_attempts:
                        repair_note = (
                            "You set verdict to pass/fail but provided no quotes.\n"
                            "Either include at least one quote with source_path pointing to an existing file under RUN_ROOT,\n"
                            "or set verdict to inconclusive."
                        )
                        continue
                    # Final attempt: downgrade to conservative verdict instead of failing the whole workflow.
                    vr_obj2["verdict"] = "inconclusive"
                    crit = vr_obj2.get("criteria")
                    if isinstance(crit, list):
                        crit.append("Downgraded to inconclusive: strong verdict requires at least one quote.")
                    else:
                        vr_obj2["criteria"] = ["Downgraded to inconclusive: strong verdict requires at least one quote."]
                    warnings_this.append("downgraded strong verdict to inconclusive due to missing quotes")

                # Success: write SSOT outputs.
                out_json.write_text(json.dumps(vr_obj2, indent=2, sort_keys=True) + "\n", encoding="utf-8")
                out_md.write_text(_render_vr_markdown(vr_obj2), encoding="utf-8")
                vr_obj = vr_obj2
                rc = 0
                raw_out = raw_out_attempt
                log_path = log_path_attempt
                break

            # Record attempt metadata for auditability.
            if attempts_meta:
                warnings_this.append(f"attempts={len(attempts_meta)} (see evidence_raw/evidence_prompts)")

            if vr_obj is None and int(rc) == 0:
                # All attempts failed to yield a usable object.
                rc = 2
            if vr_obj is None and last_raw_out is not None and last_log_path is not None:
                raw_out = last_raw_out
                log_path = last_log_path
            if vr_obj is None:
                # Provide a human-readable failure summary for manual follow-up.
                err_p = evidence_dir / f"{vid_fs}.error.txt"
                if not err_p.exists():
                    msg = (
                        f"Evidence synthesis failed for vr_id={vid!r} after {len(attempts_meta)} attempt(s).\n"
                        f"- backend: {backend}\n"
                        f"- model: {model}\n"
                        f"- evidence_dir: {_safe_rel(repo_root, evidence_dir)}\n"
                        f"- last_raw_output: {_safe_rel(repo_root, raw_out) if raw_out.exists() else None}\n"
                        f"- last_log_path: {_safe_rel(repo_root, log_path) if log_path.exists() else None}\n"
                        "\nNext steps:\n"
                        "- Inspect the attempt logs under verification/evidence_raw/ and prompts under verification/evidence_prompts/.\n"
                        "- If the model output was close but invalid, rerun the workflow to trigger another repair attempt.\n"
                        "- Or switch to --manual-evidence and write a conservative evidence note under verification/evidence/.\n"
                    )
                    err_p.write_text(msg, encoding="utf-8")

        ended_at = utc_now_iso().replace("+00:00", "Z")
        st_obj: dict[str, Any] = {
            "schema_version": 1,
            "vr_id": vid,
            "vr_file_id": vid_fs,
            "backend": backend,
            "model": model,
            "started_at": started_at,
            "ended_at": ended_at,
            "exit_code": int(rc),
            "output_json": _safe_rel(repo_root, out_json) if out_json.exists() else None,
            "output_md": _safe_rel(repo_root, out_md) if out_md.exists() else None,
            "output_json_sha256": _sha256_file(out_json) if out_json.exists() else None,
            "raw_output": _safe_rel(repo_root, raw_out) if raw_out.exists() else None,
            "raw_output_sha256": _sha256_file(raw_out) if raw_out.exists() else None,
            "log_path": _safe_rel(repo_root, log_path) if log_path.exists() else None,
            "log_sha256": _sha256_file(log_path) if log_path.exists() else None,
        }
        if attempts_meta:
            st_obj["attempts"] = attempts_meta
        if warnings_this:
            st_obj["warnings"] = warnings_this[:50]
        write_json(st_path, st_obj)

        if int(rc) == 0 and out_json.exists():
            evidence_done += 1
            synthesized_vrs.append(
                {
                    "vr_id": vid,
                    "status": "completed",
                    "output_json": st_obj.get("output_json"),
                    "output_md": st_obj.get("output_md"),
                    "output_json_sha256": st_obj.get("output_json_sha256"),
                }
            )
        else:
            evidence_failed.append(vid)
            errors.append(f"Step D failed (vr_id={vid})")
            needs_resume = True
            resume_state = {"step": "D", "reason": "evidence_synth_failed", "vr_id": vid}
            break

    if evidence_failed:
        step = {"status": "failed", "failed_vr_ids": evidence_failed, "vrs": synthesized_vrs}
    else:
        step = {
            "status": "completed",
            "backend": backend,
            "model": model,
            "evidence_completed": evidence_done,
            "evidence_skipped": evidence_skipped,
            "evidence_total": evidence_done + evidence_skipped,
            "evidence_dir": _safe_rel(repo_root, evidence_dir),
            "vrs": synthesized_vrs,
        }

    return {
        "step": step,
        "evidence_done": evidence_done,
        "evidence_skipped": evidence_skipped,
        "errors": errors,
        "needs_resume": needs_resume,
        "resume_state": resume_state,
    }
