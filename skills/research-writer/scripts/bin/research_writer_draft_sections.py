#!/usr/bin/env python3
"""
research_writer_draft_sections.py

Opt-in section drafting helper for the `research-writer` skill.

Default UX: Writer -> Auditor (cross-model conservative revision) to produce a
single human-readable final draft, while preserving intermediate outputs and
trace logs for auditability.

Safety:
- Does NOT call external models unless `--run-models` or `--stub-models` is set.
- Always runs the deterministic evidence gate on the final draft (unless
  `--dry-run` is used).
"""

from __future__ import annotations

import argparse
import difflib
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _skill_root() -> Path:
    return Path(__file__).resolve().parents[2]


def _read_text(path: Path) -> str:
    return path.read_text(encoding="utf-8", errors="replace").replace("\r\n", "\n").replace("\r", "\n")


def _write_text(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")


def _write_json(path: Path, obj: Any) -> None:
    _write_text(path, json.dumps(obj, indent=2, sort_keys=True) + "\n")


def _append_jsonl(path: Path, obj: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as f:
        f.write(json.dumps(obj, sort_keys=True) + "\n")

def _sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _safe_json_summary(obj: Any) -> dict[str, Any]:
    """
    Best-effort summary for a run-card-like JSON value.

    The caller is responsible for preserving the full raw run-card elsewhere.
    """
    if not isinstance(obj, dict):
        return {"type": type(obj).__name__}

    approval = obj.get("approval") if isinstance(obj.get("approval"), dict) else {}
    return {
        "run_id": obj.get("run_id") or obj.get("runId") or obj.get("id"),
        "workflow_id": obj.get("workflow_id") or obj.get("workflowId"),
        "backend": obj.get("backend"),
        "approval_trace_id": (
            obj.get("approval_trace_id")
            or obj.get("approvalTraceId")
            or approval.get("trace_id")
            or approval.get("traceId")
            or approval.get("id")
        ),
    }


def _stage_run_card(run_card_path: Path, *, out_dir: Path) -> dict[str, Any]:
    raw = run_card_path.read_bytes()
    digest = _sha256_bytes(raw)

    dest = out_dir / "run_card.json"
    if dest.exists():
        try:
            if dest.read_bytes() != raw:
                dest = out_dir / f"run_card.{digest[:12]}.json"
        except Exception:
            dest = out_dir / f"run_card.{digest[:12]}.json"
    if not dest.exists():
        dest.write_bytes(raw)

    parsed: Any = None
    parse_error: str | None = None
    try:
        parsed = json.loads(raw.decode("utf-8", errors="replace"))
    except Exception as exc:
        parse_error = str(exc)

    return {
        "input_path": str(run_card_path),
        "path": dest.name,
        "sha256": digest,
        "parse_error": parse_error,
        "summary": _safe_json_summary(parsed),
    }


def _sha256_text(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8", errors="replace")).hexdigest()


def _sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def _slug(s: str) -> str:
    s = s.strip().lower()
    s = re.sub(r"[^a-z0-9]+", "_", s)
    s = re.sub(r"_+", "_", s).strip("_")
    return s or "section"


def _find_main_tex(paper_dir: Path) -> Path | None:
    tex_files = sorted([p for p in paper_dir.glob("*.tex") if p.is_file()], key=lambda p: p.name)
    best: tuple[int, int, Path] | None = None  # (score, size, path)
    for p in tex_files:
        try:
            txt = _read_text(p)
        except Exception:
            continue
        score = 0
        if "\\documentclass" in txt:
            score += 10
        if "\\begin{document}" in txt:
            score += 10
        if "\\title" in txt:
            score += 2
        size = p.stat().st_size if p.exists() else 0
        cand = (score, size, p)
        if best is None or cand[0] > best[0] or (cand[0] == best[0] and cand[1] > best[1]):
            best = cand
    return best[2] if best else None


def _extract_section_skeleton(main_tex: str, *, title: str) -> str:
    """
    Best-effort extract of an existing \\section{<title>} ... block from main.tex.
    Returns "" if not found.
    """
    # Match a literal title inside braces; allow whitespace variations.
    re_start = re.compile(rf"\\section\*?\s*\{{\s*{re.escape(title)}\s*\}}")
    m = re_start.search(main_tex)
    if not m:
        return ""
    start = m.start()
    # End at the next \\section or \\appendix (whichever comes first).
    re_next = re.compile(r"(\\section\*?\s*\{)|(\\appendix\b)")
    m2 = re_next.search(main_tex, m.end())
    end = m2.start() if m2 else len(main_tex)
    return main_tex[start:end].strip() + "\n"


_RE_BIBKEY = re.compile(r"^\s*@\w+\s*\{\s*([^,\s]+)\s*,", flags=re.M)


def _read_bib_keys(path: Path) -> list[str]:
    if not path.is_file():
        return []
    txt = _read_text(path)
    keys = _RE_BIBKEY.findall(txt)
    # Deterministic unique-preserving order.
    seen: set[str] = set()
    out: list[str] = []
    for k in keys:
        if k in seen:
            continue
        seen.add(k)
        out.append(k)
    return out


def _read_derivation_outline(project_root: Path, *, max_headings: int = 40) -> list[str]:
    md = project_root / "Draft_Derivation.md"
    if not md.is_file():
        return []
    out: list[str] = []
    for ln in _read_text(md).splitlines():
        if not ln.startswith("#"):
            continue
        t = ln.lstrip("#").strip()
        if not t:
            continue
        out.append(t)
        if len(out) >= max_headings:
            break
    return out


def _resolve_default_paper_dir(project_root: Path) -> Path | None:
    cand = project_root / "paper"
    return cand if cand.is_dir() else None


def _default_runner_paths() -> tuple[Path | None, Path | None]:
    # Prefer runner skills if installed alongside this skill.
    base = _skill_root().parent
    claude = base / "claude-cli-runner" / "scripts" / "run_claude.sh"
    gemini = base / "gemini-cli-runner" / "scripts" / "run_gemini.sh"
    return (claude if claude.is_file() else None, gemini if gemini.is_file() else None)


def _strip_code_fences(text: str) -> str:
    s = text.strip()
    if not s.startswith("```"):
        return text.strip()
    lines = s.splitlines()
    if not lines:
        return ""
    if not lines[0].startswith("```"):
        return s
    # Find closing fence.
    for i in range(1, len(lines)):
        if lines[i].strip() == "```":
            inner = "\n".join(lines[1:i]).strip()
            return inner
    return s


def _sanitize_model_output(text: str, *, section_title: str) -> str:
    s = _strip_code_fences(text).strip()

    # Remove known CLI noise lines (non-model output).
    # Keep this conservative: only drop very specific prefixes.
    while True:
        first = s.splitlines()[0].strip() if s.splitlines() else ""
        if not first:
            break
        if first.lower().startswith("hook registry initialized"):
            s = "\n".join(s.splitlines()[1:]).lstrip()
            continue
        break

    # Some CLIs emit non-model preamble lines (e.g., gemini hooks). If a section
    # header exists, drop anything before the first \section{...}.
    m = re.search(r"\\section\*?\s*\{", s)
    if m and m.start() > 0:
        s = s[m.start() :].lstrip()

    # If the model forgot to include a section header, add one.
    if "\\section" not in s:
        s = f"\\section{{{section_title}}}\n\n{s}\n"
    if not s.endswith("\n"):
        s += "\n"
    return s


@dataclass(frozen=True)
class ModelConfig:
    writer_model: str
    auditor_model: str
    claude_runner: Path | None
    gemini_runner: Path | None


def _load_system_prompt(path: Path) -> str:
    if not path.is_file():
        raise FileNotFoundError(f"system prompt not found: {path}")
    return _read_text(path).strip() + "\n"


def _run_claude(
    *,
    runner: Path,
    model: str,
    system_prompt_file: Path,
    prompt_file: Path,
    out_file: Path,
) -> None:
    cmd = [
        "bash",
        str(runner),
        "--model",
        model,
        "--system-prompt-file",
        str(system_prompt_file),
        "--prompt-file",
        str(prompt_file),
        "--out",
        str(out_file),
    ]
    subprocess.run(cmd, check=True)


def _run_gemini(
    *,
    runner: Path,
    model: str,
    prompt_file: Path,
    out_file: Path,
) -> None:
    cmd = ["bash", str(runner), "--prompt-file", str(prompt_file), "--out", str(out_file)]
    if model.strip():
        cmd.extend(["--model", model])
    subprocess.run(cmd, check=True)


def _render_allowed_cite_keys(keys: list[str], *, max_keys: int = 200) -> str:
    if not keys:
        return "(none found)"
    shown = keys[:max_keys]
    suffix = f" (+{len(keys) - max_keys} more)" if len(keys) > max_keys else ""
    return ", ".join(shown) + suffix


def _writer_prompt(
    *,
    section_title: str,
    section_skeleton: str,
    derivation_outline: list[str],
    allowed_cite_keys: list[str],
    project_root: Path,
    tag: str | None,
) -> str:
    outline = "\n".join(f"- {h}" for h in derivation_outline) if derivation_outline else "(missing)"
    cites = _render_allowed_cite_keys(allowed_cite_keys)
    artifacts_hint = ""
    if tag:
        artifacts_hint = (
            "\n## Artifacts hint\n"
            f"- If you need numbers, they must be traceable to project artifacts, e.g. `artifacts/runs/{tag}/...`.\n"
        )
    return (
        "You are drafting a single LaTeX section for a physics paper.\n"
        "\n"
        "OUTPUT RULES (strict):\n"
        "- Output only LaTeX (no markdown, no code fences, no commentary).\n"
        f"- The output must include `\\\\section{{{section_title}}}` as the first non-comment command.\n"
        "- Do not invent missing derivations or numbers; add TODOs instead.\n"
        "- Do not invent new citation keys. Use only the allowed keys listed below.\n"
        "\n"
        f"## Target section\n{section_title}\n"
        "\n"
        "## Allowed citation keys (from the provided BibTeX)\n"
        f"{cites}\n"
        "\n"
        "## Draft_Derivation outline (headings only)\n"
        f"{outline}\n"
        f"{artifacts_hint}\n"
        "## Current section skeleton (if present)\n"
        f"{section_skeleton if section_skeleton else '(not found in main.tex)'}\n"
        "\n"
        "## Project paths (for TODO sources)\n"
        f"- Project root: `{project_root}`\n"
        "- Derivation notebook: `Draft_Derivation.md`\n"
        "- Knowledge base: `knowledge_base/`\n"
        "- Artifacts: `artifacts/`\n"
    )


def _auditor_prompt(
    *,
    section_title: str,
    writer_draft: str,
    allowed_cite_keys: list[str],
) -> str:
    cites = _render_allowed_cite_keys(allowed_cite_keys)
    return (
        "You are the *auditor* for a physics manuscript section draft.\n"
        "\n"
        "MISSION:\n"
        "- Produce a single, coherent final LaTeX section suitable for a human to read.\n"
        "- Be conservative: improve clarity, tighten claims, enforce evidence gate.\n"
        "- If a factual/provenance/uncertainty claim lacks an explicit anchor, remove it or replace it with a TODO.\n"
        "\n"
        "OUTPUT RULES (strict):\n"
        "- Output only LaTeX (no markdown, no code fences, no commentary).\n"
        f"- The output must include `\\\\section{{{section_title}}}`.\n"
        "- Do not introduce new citation keys. Use only the allowed keys listed below.\n"
        "\n"
        "## Allowed citation keys (from the provided BibTeX)\n"
        f"{cites}\n"
        "\n"
        "## Writer draft to audit\n"
        f"{writer_draft}\n"
    )


def _stub_writer(section_title: str, *, safe: bool, tag: str | None) -> str:
    # Deterministic stub output. "Unsafe" intentionally violates evidence gate.
    anchor = f" (source: `artifacts/runs/{tag}/manifest.json`)" if (safe and tag) else ""
    if safe and not tag:
        anchor = " (source: `artifacts/manifest.json`)"
    risky = "The data are taken from NNOline and we assign a uniform uncertainty of 1\\%."
    if safe:
        risky = risky + anchor
    return (
        f"\\section{{{section_title}}}\n\n"
        "We provide a stub draft for smoke-testing the section drafting pipeline.\n\n"
        + risky
        + "\n"
    )


def _stub_auditor(writer_tex: str, *, safe: bool, tag: str | None) -> str:
    # Deterministic stub auditor: tweaks one sentence so diffs are non-empty.
    text = writer_tex.replace("We provide a stub draft", "This is a stub draft")
    if not safe:
        return text
    # For "safe", ensure the anchor exists even if writer forgot it.
    if "artifacts/" not in text:
        anchor = f"`artifacts/runs/{tag}/manifest.json`" if tag else "`artifacts/manifest.json`"
        text = text.rstrip("\n") + f" % anchor: {anchor}\n"
    return text


def _run_evidence_gate(
    *,
    checker: Path,
    tex_path: Path,
    scan_mode: str,
    macros: list[str],
) -> tuple[int, str]:
    cmd = [sys.executable, str(checker), "--tex", str(tex_path), "--fail"]
    if scan_mode == "all":
        cmd.append("--scan-all")
    else:
        for m in macros:
            cmd.extend(["--macro", m])
    proc = subprocess.run(cmd, text=True, capture_output=True)
    out = (proc.stdout or "") + (proc.stderr or "")
    return proc.returncode, out


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--project-root", type=Path, required=True, help="Path to a research-team project root.")
    ap.add_argument("--paper-dir", type=Path, default=None, help="Existing paper dir (e.g., output of scaffold).")
    ap.add_argument("--out-dir", type=Path, default=None, help="Output directory for drafts (default: paper/drafts/<run-id>).")
    ap.add_argument("--tag", type=str, default=None, help="Artifacts tag (used for hints only).")
    ap.add_argument("--run-id", type=str, default=None, help="Run identifier (default: timestamp UTC).")
    ap.add_argument("--section", action="append", default=[], help="Section key or title (repeatable).")
    ap.add_argument("--all", action="store_true", help="Draft default set: introduction, formalism, results, discussion.")
    ap.add_argument("--dry-run", action="store_true", help="Write prompts/trace only; do not call models.")
    ap.add_argument("--run-card", type=Path, default=None, help="Optional run-card JSON to copy into drafts/ for traceability.")

    ap.add_argument("--run-models", action="store_true", help="Call local Claude+Gemini CLIs via runner scripts.")
    ap.add_argument("--stub-models", action="store_true", help="Use deterministic stub model outputs (for tests).")
    ap.add_argument(
        "--stub-variant",
        choices=["safe", "unsafe"],
        default="safe",
        help="Stub behavior: safe passes evidence gate; unsafe should fail it.",
    )

    ap.add_argument("--writer-model", type=str, default="opus", help="Claude model alias (default: opus).")
    ap.add_argument("--auditor-model", type=str, default="gemini-3-pro-preview", help="Gemini model alias.")
    ap.add_argument("--claude-runner", type=Path, default=None, help="Path to run_claude.sh (optional).")
    ap.add_argument("--gemini-runner", type=Path, default=None, help="Path to run_gemini.sh (optional).")

    ap.add_argument(
        "--evidence-scan",
        choices=["all", "macros"],
        default="all",
        help="Evidence-gate scan mode: all text blocks (default) or only macros (revadd).",
    )
    ap.add_argument("--evidence-macro", action="append", default=[], help="Macro name(s) when --evidence-scan=macros.")
    ap.add_argument("--force", action="store_true", help="Overwrite existing out dir if present.")
    args = ap.parse_args()

    project_root = args.project_root.expanduser().resolve()
    if not project_root.is_dir():
        print(f"ERROR: --project-root is not a directory: {project_root}", file=sys.stderr)
        return 2

    paper_dir: Path | None = args.paper_dir.expanduser().resolve() if args.paper_dir else _resolve_default_paper_dir(project_root)
    if paper_dir is None or not paper_dir.is_dir():
        if args.out_dir is None:
            print("ERROR: provide --paper-dir (or create <project-root>/paper/) or set --out-dir", file=sys.stderr)
            return 2

    run_id = args.run_id or datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")

    out_dir = args.out_dir.expanduser().resolve() if args.out_dir else (paper_dir / "drafts" / run_id)
    if out_dir.exists():
        if not args.force:
            print(f"ERROR: out dir exists (use --force): {out_dir}", file=sys.stderr)
            return 2
        shutil.rmtree(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    run_card_info: dict[str, Any] | None = None
    if args.run_card is not None:
        run_card_path = args.run_card.expanduser().resolve()
        if not run_card_path.is_file():
            print(f"ERROR: --run-card not found: {run_card_path}", file=sys.stderr)
            return 2
        try:
            run_card_info = _stage_run_card(run_card_path, out_dir=out_dir)
        except Exception as exc:
            print(f"[warn] failed to stage run-card (continuing): {exc}", file=sys.stderr)
            run_card_info = {"input_path": str(run_card_path), "error": str(exc)}

    # Inputs for prompts.
    main_tex_path = _find_main_tex(paper_dir) if paper_dir else None
    main_tex = _read_text(main_tex_path) if main_tex_path else ""
    deriv_outline = _read_derivation_outline(project_root)

    bib_keys: list[str] = []
    if paper_dir:
        bib_keys = _read_bib_keys(paper_dir / "references.bib")
    if not bib_keys:
        bib_keys = _read_bib_keys(project_root / "references.bib")

    # Sections selection.
    default_sections = ["introduction", "formalism", "results", "discussion"]
    requested = list(args.section or [])
    if args.all or not requested:
        requested = default_sections if not requested else (requested + default_sections)
    # Deterministic unique-preserving.
    seen_sec: set[str] = set()
    sections: list[str] = []
    for s in requested:
        ss = str(s).strip()
        if not ss or ss in seen_sec:
            continue
        seen_sec.add(ss)
        sections.append(ss)
    if not sections:
        print("ERROR: no sections selected (use --section ... or --all)", file=sys.stderr)
        return 2

    title_map = {
        "introduction": "Introduction",
        "formalism": "Theory / Formalism",
        "results": "Results",
        "discussion": "Discussion and outlook",
        "conclusion": "Conclusions",
        "conclusions": "Conclusions",
    }

    # Model runner config.
    default_claude, default_gemini = _default_runner_paths()
    cfg = ModelConfig(
        writer_model=args.writer_model,
        auditor_model=args.auditor_model,
        claude_runner=(args.claude_runner.expanduser().resolve() if args.claude_runner else default_claude),
        gemini_runner=(args.gemini_runner.expanduser().resolve() if args.gemini_runner else default_gemini),
    )

    # System prompts (auditable assets).
    writer_sys_path = _skill_root() / "assets" / "style" / "writing_voice_system_prompt.txt"
    auditor_sys_path = _skill_root() / "assets" / "style" / "research_writer_guardrails_system_prompt.txt"
    writer_sys = _load_system_prompt(writer_sys_path)
    auditor_sys = _load_system_prompt(auditor_sys_path)

    trace_path = out_dir / "trace.jsonl"
    run_meta = {
        "run_id": run_id,
        "utc_started": _utc_now(),
        "project_root": str(project_root),
        "paper_dir": str(paper_dir) if paper_dir else None,
        "main_tex": str(main_tex_path) if main_tex_path else None,
        "tag": args.tag,
        "run_card": run_card_info,
        "sections": sections,
        "mode": "dry-run" if args.dry_run else ("stub-models" if args.stub_models else ("run-models" if args.run_models else "none")),
        "writer_model": cfg.writer_model,
        "auditor_model": cfg.auditor_model,
        "writer_system_prompt": str(writer_sys_path),
        "auditor_system_prompt": str(auditor_sys_path),
        "writer_system_prompt_sha256": _sha256_text(writer_sys),
        "auditor_system_prompt_sha256": _sha256_text(auditor_sys),
        "evidence_scan": args.evidence_scan,
        "evidence_macros": args.evidence_macro or ["revadd"],
    }
    _write_json(out_dir / "run.json", run_meta)
    _append_jsonl(trace_path, {"event": "run_start", "utc": _utc_now(), **run_meta})

    prompts_dir = out_dir / "prompts"
    _write_text(prompts_dir / "writer_system.txt", writer_sys)
    _write_text(prompts_dir / "auditor_system.txt", auditor_sys)

    if args.run_models and args.stub_models:
        print("ERROR: choose only one of --run-models or --stub-models", file=sys.stderr)
        return 2
    if (not args.run_models) and (not args.stub_models) and (not args.dry_run):
        print("ERROR: choose --run-models or --stub-models (or use --dry-run)", file=sys.stderr)
        return 2

    checker = _skill_root() / "scripts" / "bin" / "check_latex_evidence_gate.py"
    if not checker.is_file():
        print(f"ERROR: missing evidence gate checker: {checker}", file=sys.stderr)
        return 2

    macros = [m.strip() for m in (args.evidence_macro or []) if m and m.strip()] or ["revadd"]

    failures: list[str] = []

    for sec in sections:
        title = title_map.get(sec.lower(), sec)
        stem = _slug(title)
        section_skel = _extract_section_skeleton(main_tex, title=title) if main_tex else ""
        writer_prompt = _writer_prompt(
            section_title=title,
            section_skeleton=section_skel,
            derivation_outline=deriv_outline,
            allowed_cite_keys=bib_keys,
            project_root=project_root,
            tag=args.tag,
        )
        auditor_prompt = ""  # filled after writer draft is known

        writer_prompt_path = prompts_dir / f"writer_prompt_{stem}.txt"
        auditor_prompt_path = prompts_dir / f"auditor_prompt_{stem}.txt"
        _write_text(writer_prompt_path, writer_prompt)
        _append_jsonl(
            trace_path,
            {
                "event": "writer_prompt_written",
                "utc": _utc_now(),
                "section": title,
                "path": str(writer_prompt_path),
                "sha256": _sha256_file(writer_prompt_path),
            },
        )

        writer_raw_path = out_dir / f"draft_{stem}_writer.raw.txt"
        auditor_raw_path = out_dir / f"draft_{stem}_auditor.raw.txt"
        writer_tex_path = out_dir / f"draft_{stem}_writer.tex"
        final_tex_path = out_dir / f"draft_{stem}_final.tex"
        diff_path = out_dir / f"draft_{stem}.diff"
        report_path = out_dir / f"evidence_gate_report_{stem}.md"

        if args.dry_run:
            continue

        # 1) Writer.
        if args.stub_models:
            writer_raw = _stub_writer(title, safe=(args.stub_variant == "safe"), tag=args.tag)
            _write_text(writer_raw_path, writer_raw)
            _append_jsonl(
                trace_path,
                {
                    "event": "writer_stub_done",
                    "utc": _utc_now(),
                    "section": title,
                    "variant": args.stub_variant,
                    "raw_path": str(writer_raw_path),
                    "raw_sha256": _sha256_file(writer_raw_path),
                },
            )
        else:
            if cfg.claude_runner is None or not cfg.claude_runner.is_file():
                print("ERROR: Claude runner not found (set --claude-runner or install claude-cli-runner)", file=sys.stderr)
                return 2
            _append_jsonl(
                trace_path,
                {
                    "event": "writer_model_call",
                    "utc": _utc_now(),
                    "section": title,
                    "runner": str(cfg.claude_runner),
                    "model": cfg.writer_model,
                },
            )
            _run_claude(
                runner=cfg.claude_runner,
                model=cfg.writer_model,
                system_prompt_file=prompts_dir / "writer_system.txt",
                prompt_file=writer_prompt_path,
                out_file=writer_raw_path,
            )
            _append_jsonl(
                trace_path,
                {
                    "event": "writer_model_done",
                    "utc": _utc_now(),
                    "section": title,
                    "raw_path": str(writer_raw_path),
                    "raw_sha256": _sha256_file(writer_raw_path),
                },
            )

        writer_tex = _sanitize_model_output(_read_text(writer_raw_path), section_title=title)
        _write_text(writer_tex_path, writer_tex)
        _append_jsonl(
            trace_path,
            {
                "event": "writer_tex_written",
                "utc": _utc_now(),
                "section": title,
                "path": str(writer_tex_path),
                "sha256": _sha256_file(writer_tex_path),
            },
        )

        # 2) Auditor.
        auditor_prompt = auditor_sys + "\n" + _auditor_prompt(section_title=title, writer_draft=writer_tex, allowed_cite_keys=bib_keys)
        _write_text(auditor_prompt_path, auditor_prompt)
        _append_jsonl(
            trace_path,
            {
                "event": "auditor_prompt_written",
                "utc": _utc_now(),
                "section": title,
                "path": str(auditor_prompt_path),
                "sha256": _sha256_file(auditor_prompt_path),
            },
        )

        if args.stub_models:
            auditor_raw = _stub_auditor(writer_tex, safe=(args.stub_variant == "safe"), tag=args.tag)
            _write_text(auditor_raw_path, auditor_raw)
            _append_jsonl(
                trace_path,
                {
                    "event": "auditor_stub_done",
                    "utc": _utc_now(),
                    "section": title,
                    "variant": args.stub_variant,
                    "raw_path": str(auditor_raw_path),
                    "raw_sha256": _sha256_file(auditor_raw_path),
                },
            )
        else:
            if cfg.gemini_runner is None or not cfg.gemini_runner.is_file():
                print("ERROR: Gemini runner not found (set --gemini-runner or install gemini-cli-runner)", file=sys.stderr)
                return 2
            _append_jsonl(
                trace_path,
                {
                    "event": "auditor_model_call",
                    "utc": _utc_now(),
                    "section": title,
                    "runner": str(cfg.gemini_runner),
                    "model": cfg.auditor_model,
                },
            )
            _run_gemini(
                runner=cfg.gemini_runner,
                model=cfg.auditor_model,
                prompt_file=auditor_prompt_path,
                out_file=auditor_raw_path,
            )
            _append_jsonl(
                trace_path,
                {
                    "event": "auditor_model_done",
                    "utc": _utc_now(),
                    "section": title,
                    "raw_path": str(auditor_raw_path),
                    "raw_sha256": _sha256_file(auditor_raw_path),
                },
            )

        final_tex = _sanitize_model_output(_read_text(auditor_raw_path), section_title=title)
        _write_text(final_tex_path, final_tex)
        _append_jsonl(
            trace_path,
            {
                "event": "final_tex_written",
                "utc": _utc_now(),
                "section": title,
                "path": str(final_tex_path),
                "sha256": _sha256_file(final_tex_path),
            },
        )

        # 3) Diff.
        diff = "".join(
            difflib.unified_diff(
                writer_tex.splitlines(keepends=True),
                final_tex.splitlines(keepends=True),
                fromfile=writer_tex_path.name,
                tofile=final_tex_path.name,
            )
        )
        _write_text(diff_path, diff)

        # 4) Evidence gate (hard).
        code, eg_out = _run_evidence_gate(checker=checker, tex_path=final_tex_path, scan_mode=args.evidence_scan, macros=macros)
        _append_jsonl(
            trace_path,
            {
                "event": "evidence_gate_done",
                "utc": _utc_now(),
                "section": title,
                "exit_code": code,
            },
        )
        if code != 0:
            unsafe_path = out_dir / f"draft_{stem}_unsafe.tex"
            final_tex_path.replace(unsafe_path)
            _write_text(
                report_path,
                "# Evidence gate failure\n\n"
                f"- Section: {title}\n"
                f"- Unsafe output saved as: `{unsafe_path.name}`\n\n"
                "## Checker output\n\n"
                "```text\n"
                f"{eg_out.strip()}\n"
                "```\n",
            )
            failures.append(title)
            _append_jsonl(
                trace_path,
                {
                    "event": "evidence_gate_failed",
                    "utc": _utc_now(),
                    "section": title,
                    "report": str(report_path),
                },
            )

    # Run-level README.
    files = sorted([p.name for p in out_dir.iterdir() if p.is_file()])
    run_card_line = ""
    if run_card_info is not None:
        rc_path = run_card_info.get("path")
        if isinstance(rc_path, str) and rc_path.strip():
            run_card_line = f"- Run-card: `{rc_path.strip()}`\n"
    _write_text(
        out_dir / "README.md",
        "# research-writer drafts\n\n"
        f"- Run id: `{run_id}`\n"
        f"{run_card_line}"
        f"- Sections: {', '.join(sections)}\n"
        f"- Mode: `{run_meta['mode']}`\n"
        f"- Writer model: `{cfg.writer_model}`\n"
        f"- Auditor model: `{cfg.auditor_model}`\n"
        f"- Evidence scan: `{args.evidence_scan}`\n\n"
        "## Outputs\n"
        + "\n".join(f"- `{name}`" for name in files)
        + "\n\n"
        "## Notes\n"
        "- This command is opt-in and does not modify your `paper/main.tex`.\n"
        "- If the evidence gate fails, the output is renamed to `*_unsafe.tex` and a report is written.\n",
    )

    export_manifest = {
        "schemaVersion": 1,
        "tool": "research-writer",
        "entrypoint": "draft_sections",
        "generated_at_utc": _utc_now(),
        "run_id": run_id,
        "project_root": str(project_root),
        "paper_dir": str(paper_dir) if paper_dir else None,
        "tag": args.tag,
        "sections": sections,
        "mode": run_meta["mode"],
        "run_card": run_card_info,
        "trace": {"run_json": "run.json", "trace_jsonl": "trace.jsonl"},
        "outputs": {"dir": str(out_dir), "files": files + ["README.md"]},
    }
    _write_json(out_dir / "export_manifest.json", export_manifest)

    _append_jsonl(trace_path, {"event": "run_done", "utc": _utc_now(), "failures": failures})

    if failures:
        print(f"[draft_sections] evidence gate failed for {len(failures)} section(s): {', '.join(failures)}", file=sys.stderr)
        return 2

    print(f"[draft_sections] ok: wrote drafts under {out_dir}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
