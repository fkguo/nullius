#!/usr/bin/env python3
# CONTRACT-EXEMPT: CODE-01.1 sunset:2026-06-01 — discussion logic learner; split into extraction + analysis modules planned
"""
research_writer_learn_discussion_logic.py

N=10 (default) mixed-mode workflow helper for `research-writer`:

1) (Optional) Fetch an exemplar corpus via INSPIRE → arXiv sources
   using `scripts/bin/fetch_prl_style_corpus.py`.
2) Prepare per-paper "reading packs" (excerpt + evidence pointers) to enable
   clean-room LLM extraction of *general physics discussion logic*.
3) (Optional) Run a dual-model pass (Claude + Gemini) to produce argument maps,
   writing outputs + trace logs under the chosen out dir.

Each run also updates `PROGRESS.md` and `PROGRESS.json` in `--out-dir` so long
corpus jobs can be resumed deterministically.

This script does NOT automatically update `assets/style/physics_discussion_logic_playbook.md`.
That merge step remains an agent/human task for stability and auditability.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
from dataclasses import dataclass
from datetime import datetime, timezone
from html import unescape as _html_unescape
from pathlib import Path
from typing import Any


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _write_json(path: Path, obj: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(obj, indent=2, sort_keys=True) + "\n", encoding="utf-8")


def _append_jsonl(path: Path, obj: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as f:
        f.write(json.dumps(obj, sort_keys=True) + "\n")


def _read_text(path: Path) -> str:
    return path.read_text(encoding="utf-8", errors="replace").replace("\r\n", "\n").replace("\r", "\n")


def _model_output_ok(path: Path) -> bool:
    """
    Best-effort validation: treat empty/garbled outputs as missing so `--mode repair`
    can re-run them deterministically.
    """
    if not path.is_file():
        return False
    try:
        if path.stat().st_size < 20:
            return False
        with path.open("r", encoding="utf-8", errors="replace") as f:
            head = f.read(6000)
    except Exception:
        return False
    return ("## Moves" in head) and ("## Diagnostics" in head) and ("## Reusable" in head)


def _line_from_index(text: str, idx: int) -> int:
    if idx <= 0:
        return 1
    return text.count("\n", 0, idx) + 1


def _strip_latex_comments(text: str) -> str:
    """
    Best-effort comment stripping: remove '%' comments unless escaped as '\\%'.
    Not a full TeX parser (good enough for reading-pack generation).
    """
    out_lines: list[str] = []
    for ln in text.splitlines():
        cut = None
        for i, ch in enumerate(ln):
            if ch != "%":
                continue
            # In TeX, '%' starts a comment unless escaped as '\%'.
            # If there are N backslashes immediately preceding '%':
            # - N odd  => '%' is escaped (literal percent)
            # - N even => '%' starts a comment (e.g. '\\%': linebreak then comment)
            j = i - 1
            n_bs = 0
            while j >= 0 and ln[j] == "\\":
                n_bs += 1
                j -= 1
            if n_bs % 2 == 0:
                cut = i
                break
        out_lines.append(ln[:cut] if cut is not None else ln)
    return "\n".join(out_lines) + ("\n" if text.endswith("\n") else "")


_RE_CITE = re.compile(r"\\cite[a-zA-Z]*\s*\{[^}]*\}")
_RE_DOLLAR_BLOCK = re.compile(r"\$\$(.*?)\$\$", flags=re.S)
_RE_DOLLAR_INLINE = re.compile(r"\$[^$\n]{0,400}\$")
_RE_MATH_ENV = re.compile(
    r"\\begin\{(equation\*?|align\*?|gather\*?|multline\*?|eqnarray\*?)\}.*?\\end\{\1\}",
    flags=re.S,
)


def _mask_citations(text: str) -> str:
    return _RE_CITE.sub("<CITE>", text)


def _mask_math(text: str) -> str:
    text = _RE_MATH_ENV.sub("<MATH_ENV>", text)
    text = _RE_DOLLAR_BLOCK.sub("<MATH_BLOCK>", text)
    text = _RE_DOLLAR_INLINE.sub("<MATH>", text)
    return text


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


def _resolve_input_path(paper_dir: Path, raw: str) -> Path | None:
    raw = raw.strip().strip("{}").strip()
    if not raw:
        return None
    # Remove surrounding quotes.
    raw = raw.strip("\"'")
    rel = raw
    if not Path(rel).suffix:
        rel = rel + ".tex"
    p = (paper_dir / rel).resolve()
    try:
        p.relative_to(paper_dir.resolve())
    except Exception:
        return None
    return p if p.is_file() else None


_RE_INPUT = re.compile(r"\\(input|include)\s*\{([^}]+)\}")


def _flatten_inputs(text: str, *, paper_dir: Path, max_depth: int = 2, max_bytes: int = 2_000_000) -> str:
    """
    Best-effort flattening of \\input{...}/\\include{...} within the same paper dir.
    """

    def helper(t: str, depth: int, total_bytes: int) -> tuple[str, int]:
        if depth <= 0:
            return t, total_bytes
        out: list[str] = []
        last = 0
        for m in _RE_INPUT.finditer(t):
            out.append(t[last : m.start()])
            inc_path = _resolve_input_path(paper_dir, m.group(2))
            if inc_path is None:
                out.append(t[m.start() : m.end()])  # keep as-is
                last = m.end()
                continue
            try:
                inc_txt = _read_text(inc_path)
            except Exception:
                out.append(t[m.start() : m.end()])
                last = m.end()
                continue
            if total_bytes + len(inc_txt) > max_bytes:
                out.append(t[m.start() : m.end()])
                last = m.end()
                continue
            total_bytes += len(inc_txt)
            inc_flat, total_bytes = helper(inc_txt, depth - 1, total_bytes)
            out.append(f"\n% --- BEGIN INPUT: {inc_path.name} ---\n")
            out.append(inc_flat)
            out.append(f"\n% --- END INPUT: {inc_path.name} ---\n")
            last = m.end()
        out.append(t[last:])
        return "".join(out), total_bytes

    flat, _ = helper(text, max_depth, len(text))
    return flat


@dataclass(frozen=True)
class Segment:
    name: str
    text: str
    evidence: str


def _clip(s: str, *, max_chars: int) -> str:
    s = s.strip()
    if len(s) <= max_chars:
        return s
    return s[: max_chars - 3].rstrip() + "..."


_RE_HTML_TAG = re.compile(r"<[^>]+>")


def _strip_simple_html(s: str) -> str:
    """
    INSPIRE sometimes returns MathML/HTML fragments in titles.
    Strip tags for cleaner pack headers (audit source remains in record.json).
    """
    s = _html_unescape(str(s))
    s = _RE_HTML_TAG.sub("", s)
    s = s.replace("\u00a0", " ")
    s = re.sub(r"\s+", " ", s).strip()
    return s


def _extract_segments_text(
    raw: str,
    *,
    evidence_name: str,
    mask_math: bool,
    mask_cites: bool,
) -> tuple[list[Segment], dict[str, Any]]:
    no_comments = _strip_latex_comments(raw)
    body = no_comments
    doc_idx = body.find("\\begin{document}")
    if doc_idx != -1:
        body = body[doc_idx + len("\\begin{document}") :]

    if mask_cites:
        body_masked = _mask_citations(body)
    else:
        body_masked = body
    if mask_math:
        body_masked = _mask_math(body_masked)

    segs: list[Segment] = []
    evidence_obj: dict[str, Any] = {
        "evidence_file": evidence_name,
        "created_at": _utc_now(),
        "segments": [],
    }

    def add_seg(name: str, seg_text: str, start_idx_in_raw: int | None, extra_evidence: str = "") -> None:
        seg_text = seg_text.strip()
        if not seg_text:
            return
        evidence = evidence_name
        if start_idx_in_raw is not None:
            evidence = f"{evidence_name}#L{_line_from_index(raw, start_idx_in_raw)}"
        if extra_evidence:
            evidence = f"{evidence} ({extra_evidence})"
        segs.append(Segment(name=name, text=seg_text, evidence=evidence))
        evidence_obj["segments"].append({"name": name, "evidence": evidence, "chars": len(seg_text)})

    # Abstract.
    m_abs = re.search(r"\\begin\{abstract\}(.*?)\\end\{abstract\}", no_comments, flags=re.S)
    if m_abs:
        abs_txt = m_abs.group(1)
        if mask_cites:
            abs_txt = _mask_citations(abs_txt)
        if mask_math:
            abs_txt = _mask_math(abs_txt)
        add_seg("Abstract", _clip(abs_txt, max_chars=2200), m_abs.start())

    # Introduction opening.
    intro_start = None
    intro_label = ""
    m_intro_sec = re.search(r"\\section\*?\{Introduction\}", no_comments)
    if m_intro_sec:
        intro_start = m_intro_sec.start()
        intro_label = "\\section{Introduction}"
    else:
        m_intro_em = re.search(r"\\emph\{Introduction\}", no_comments)
        if m_intro_em:
            intro_start = m_intro_em.start()
            intro_label = "\\emph{Introduction}---"
    if intro_start is not None:
        intro_txt = no_comments[intro_start : intro_start + 8000]
        if mask_cites:
            intro_txt = _mask_citations(intro_txt)
        if mask_math:
            intro_txt = _mask_math(intro_txt)
        add_seg("Introduction opening", _clip(intro_txt, max_chars=6000), intro_start, extra_evidence=intro_label)

    # Bottom line / Conclusions.
    conc_start = None
    conc_label = ""
    for pat, label in (
        (r"\\emph\{Bottom line\}", "\\emph{Bottom line}"),
        (r"\\section\*?\{Conclusions?\}", "\\section{Conclusions}"),
        (r"\\emph\{Conclusions?\}", "\\emph{Conclusions}"),
        (r"\\section\*?\{Summary\}", "\\section{Summary}"),
        (r"\\emph\{Summary\}", "\\emph{Summary}"),
    ):
        m = re.search(pat, no_comments)
        if m:
            conc_start = m.start()
            conc_label = label
            break
    if conc_start is not None:
        conc_txt = no_comments[conc_start : conc_start + 9000]
        # stop at acknowledgments/bibliography if present
        stop = len(conc_txt)
        for stop_pat in ("\\begin{acknowledgments}", "\\bibliography", "\\end{document}"):
            j = conc_txt.find(stop_pat)
            if j != -1:
                stop = min(stop, j)
        conc_txt = conc_txt[:stop]
        if mask_cites:
            conc_txt = _mask_citations(conc_txt)
        if mask_math:
            conc_txt = _mask_math(conc_txt)
        add_seg("Bottom line / Conclusions", _clip(conc_txt, max_chars=4500), conc_start, extra_evidence=conc_label)

    # Diagnostics / uncertainties: keyword-selected paragraphs from masked body.
    keywords = [
        "uncert",
        "systematic",
        "dominant",
        "sensitivity",
        "vary",
        "variation",
        "scale",
        "robust",
        "stability",
        "model depend",
        "consistent",
        "inconsistent",
        "mismatch",
        "tension",
        "discrep",
        "driven by",
    ]
    paras = [p.strip() for p in re.split(r"\n\s*\n", body_masked) if p.strip()]
    scored: list[tuple[int, int, str]] = []
    for idx, p in enumerate(paras):
        p_norm = p.lower()
        score = sum(1 for k in keywords if k in p_norm)
        if score <= 0:
            continue
        # Keep reasonably sized paragraphs.
        if len(p) < 200 or len(p) > 2500:
            continue
        scored.append((score, idx, p))
    scored.sort(key=lambda x: (-x[0], x[1]))
    selected = scored[:4]
    if selected:
        blocks = []
        for score, idx, p in sorted(selected, key=lambda x: x[1]):
            blocks.append(_clip(p, max_chars=1400))
        add_seg("Diagnostics / uncertainties (auto-selected)", "\n\n".join(blocks), None, extra_evidence="keyword-selected")

    return segs, evidence_obj


def _codex_home() -> Path:
    env = os.environ.get("CODEX_HOME", "").strip()
    if env:
        return Path(env).expanduser().resolve()
    return (Path.home() / ".codex").resolve()


def _find_runner(kind: str) -> Path:
    codex = _codex_home()
    if kind == "claude":
        return codex / "skills" / "claude-cli-runner" / "scripts" / "run_claude.sh"
    if kind == "gemini":
        return codex / "skills" / "gemini-cli-runner" / "scripts" / "run_gemini.sh"
    raise ValueError(kind)


def _skill_root() -> Path:
    return Path(__file__).resolve().parents[2]


def _ordered_paper_dirs(papers_dir: Path, *, trace: Path | None = None) -> list[Path]:
    """
    Prefer INSPIRE-returned order when available (records_order.json written by fetcher).
    Fallback to a deterministic directory-name order.
    """
    order_path = papers_dir.parent / "records_order.json"
    if order_path.is_file():
        try:
            obj = json.loads(_read_text(order_path))
            entries = obj.get("order")
            out: list[Path] = []
            if isinstance(entries, list):
                for e in entries:
                    safe_id = ""
                    if isinstance(e, str):
                        safe_id = e
                    elif isinstance(e, dict):
                        v = e.get("safe_id")
                        safe_id = v if isinstance(v, str) else ""
                    safe_id = safe_id.strip()
                    if not safe_id:
                        continue
                    pd = papers_dir / safe_id
                    if pd.is_dir():
                        out.append(pd)
            if out:
                return out
        except Exception as exc:
            if trace is not None:
                _append_jsonl(trace, {"ts": _utc_now(), "event": "order_read_error", "path": str(order_path), "error": str(exc)})

    # Fallback: deterministic but imperfect proxy for recency (kept for backward compatibility).
    return sorted([p for p in papers_dir.iterdir() if p.is_dir()], key=lambda p: p.name, reverse=True)


def _run_fetch(*, query_url: str, query: str, n: int, out_dir: Path, trace: Path, resume: bool) -> int:
    fetcher = _skill_root() / "scripts" / "bin" / "fetch_prl_style_corpus.py"
    cmd = [sys.executable, str(fetcher), "--out-dir", str(out_dir), "--max-records", str(int(n))]
    if query_url.strip():
        cmd += ["--query-url", query_url.strip()]
    elif query.strip():
        cmd += ["--query", query.strip()]
    else:
        print("ERROR: need --query-url or --query for fetch", file=sys.stderr)
        return 2
    if resume:
        cmd += ["--resume"]

    _append_jsonl(trace, {"ts": _utc_now(), "event": "fetch_start", "cmd": cmd})
    code = subprocess.run(cmd, check=False).returncode
    _append_jsonl(trace, {"ts": _utc_now(), "event": "fetch_end", "exit_code": code})
    return code


def _write_pack(out_path: Path, *, rec: dict[str, Any], segs: list[Segment]) -> None:
    title = _strip_simple_html(rec.get("title") or "")
    year = str(rec.get("year") or "").strip()
    authors = rec.get("authors") if isinstance(rec.get("authors"), list) else []
    arxiv_id = str(rec.get("arxiv_id") or "").strip()

    lines: list[str] = []
    lines.append(f"# Paper pack: {arxiv_id} ({year}) — {title}".strip())
    lines.append("")
    lines.append("## Metadata")
    lines.append(f"- arXiv: {arxiv_id}")
    if title:
        lines.append(f"- Title: {title}")
    if year:
        lines.append(f"- Year: {year}")
    if authors:
        lines.append(f"- Authors: {', '.join(str(a) for a in authors[:12])}" + (" …" if len(authors) > 12 else ""))
    lines.append("")
    lines.append("## Excerpts (for discussion-logic extraction)")
    for s in segs:
        lines.append(f"### {s.name}")
        lines.append(f"_Evidence: {s.evidence}_")
        lines.append("")
        lines.append(s.text.strip())
        lines.append("")
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text("\n".join(lines).rstrip() + "\n", encoding="utf-8")


def _run_models_for_pack(
    *,
    out_dir: Path,
    pack_path: Path,
    system_prompt_path: Path,
    run_claude: bool,
    run_gemini: bool,
    claude_model: str,
    gemini_model: str,
    claude_timeout_s: int,
    gemini_timeout_s: int,
    stub_models: bool,
    trace: Path,
) -> dict[str, Any]:
    if stub_models:
        arxiv_id = out_dir.name
        out: dict[str, Any] = {"claude_ok": None, "gemini_ok": None, "stub_models": True}
        if run_claude:
            _append_jsonl(trace, {"ts": _utc_now(), "event": "claude_stub_start", "arxiv_id": arxiv_id})
            (out_dir / "claude.md").write_text(
                "\n".join(
                    [
                        "## Argument Map (Mermaid)",
                        "",
                        "```mermaid",
                        "flowchart TD",
                        f'  Q["Question / observable"] --> M["Mechanism / constraints"]',
                        f'  M --> R["Results (numbers + uncertainties)"]',
                        f'  R --> D["Diagnostics (stability / variations)"]',
                        "```",
                        "",
                        "## Moves (Bullets)",
                        "- MOVE: Define the observable and kinematics | Evidence: Abstract",
                        "- MOVE: Name the gap/tension and precision target | Evidence: Introduction opening",
                        "- MOVE: State the controlling mechanism/constraint first | Evidence: Introduction opening",
                        "- MOVE: Separate inputs from assumptions (what is data vs model) | Evidence: Methods/setup",
                        "- MOVE: Quote the headline result with uncertainty and meaning | Evidence: Results",
                        "- MOVE: Attribute shifts vs prior work to specific ingredients | Evidence: Discussion",
                        "- MOVE: State limitations and what remains unverified | Evidence: Conclusions",
                        "",
                        "## Diagnostics & Uncertainties",
                        "- Diagnose robustness by varying a matching scale / fit window and checking stability.",
                        "- Structure an uncertainty budget: identify dominant vs subleading sources and why.",
                        "- Use limits/scaling checks or a baseline/counterfactual as consistency diagnostics.",
                        "",
                        "## Reusable General Lessons",
                        "- Mechanism-first discussion beats authority: explain disagreements via missing ingredients.",
                        "- Turn numbers into meaning: sign/size origin + what it implies physically.",
                        "- End with actionability: the highest-leverage next measurement/computation.",
                        "",
                    ]
                ),
                encoding="utf-8",
            )
            _append_jsonl(trace, {"ts": _utc_now(), "event": "claude_stub_end", "arxiv_id": arxiv_id})
            out["claude_ok"] = True
        if run_gemini:
            _append_jsonl(trace, {"ts": _utc_now(), "event": "gemini_stub_start", "arxiv_id": arxiv_id})
            (out_dir / "gemini.md").write_text(
                "\n".join(
                    [
                        "## Argument Map (Mermaid)",
                        "",
                        "```mermaid",
                        "flowchart TD",
                        f'  Q["Question / observable"] --> G["Gap / motivation"]',
                        f'  G --> A["Approach / representation"]',
                        f'  A --> C["Comparison to prior work/data"]',
                        f'  C --> O["Outlook / tests"]',
                        "```",
                        "",
                        "## Moves (Bullets)",
                        "- MOVE: Define the observable and conventions | Evidence: Abstract",
                        "- MOVE: Motivate via a discrepancy/gap and a precision target | Evidence: Introduction opening",
                        "- MOVE: Specify the formalism/representation and inputs | Evidence: Methods/setup",
                        "- MOVE: Compare to literature/data and explain differences via ingredients | Evidence: Discussion",
                        "- MOVE: Provide predictions/implications and concrete tests | Evidence: Conclusions",
                        "",
                        "## Diagnostics & Uncertainties",
                        "- Check stability under parameter variations and treat residual dependence as systematic.",
                        "- Distinguish raw data from model-dependent extraction when interpreting comparisons.",
                        "",
                        "## Reusable General Lessons",
                        "- Separate data/inputs from extraction assumptions; localize disagreements.",
                        "- Sensitivity-first: identify which inputs dominate and which improvement is highest leverage.",
                        "",
                    ]
                ),
                encoding="utf-8",
            )
            _append_jsonl(trace, {"ts": _utc_now(), "event": "gemini_stub_end", "arxiv_id": arxiv_id})
            out["gemini_ok"] = True
        return out

    claude_runner = _find_runner("claude")
    gemini_runner = _find_runner("gemini")
    if not claude_runner.is_file():
        raise FileNotFoundError(f"claude runner not found: {claude_runner}")
    if not gemini_runner.is_file():
        raise FileNotFoundError(f"gemini runner not found: {gemini_runner}")

    claude_out = out_dir / "claude.md"
    gemini_out = out_dir / "gemini.md"

    out: dict[str, Any] = {"claude_ok": None, "gemini_ok": None}

    if run_claude:
        claude_cmd = [
            "bash",
            str(claude_runner),
            "--model",
            claude_model,
            "--system-prompt-file",
            str(system_prompt_path),
            "--prompt-file",
            str(pack_path),
            "--out",
            str(claude_out),
        ]
        _append_jsonl(trace, {"ts": _utc_now(), "event": "claude_start", "cmd": claude_cmd})
        try:
            code_a = subprocess.run(claude_cmd, check=False, timeout=max(1, int(claude_timeout_s))).returncode
        except subprocess.TimeoutExpired:
            code_a = 124
            _append_jsonl(trace, {"ts": _utc_now(), "event": "claude_timeout", "timeout_s": int(claude_timeout_s)})
        _append_jsonl(trace, {"ts": _utc_now(), "event": "claude_end", "exit_code": code_a})
        out["claude_ok"] = code_a == 0

    if run_gemini:
        gemini_prompt = out_dir / "gemini_prompt.txt"
        gemini_prompt.write_text(_read_text(system_prompt_path).rstrip() + "\n\n" + _read_text(pack_path), encoding="utf-8")
        gemini_cmd = [
            "bash",
            str(gemini_runner),
            "--model",
            gemini_model,
            "--prompt-file",
            str(gemini_prompt),
            "--out",
            str(gemini_out),
        ]
        _append_jsonl(trace, {"ts": _utc_now(), "event": "gemini_start", "cmd": gemini_cmd})
        try:
            code_b = subprocess.run(gemini_cmd, check=False, timeout=max(1, int(gemini_timeout_s))).returncode
        except subprocess.TimeoutExpired:
            code_b = 124
            _append_jsonl(trace, {"ts": _utc_now(), "event": "gemini_timeout", "timeout_s": int(gemini_timeout_s)})
        _append_jsonl(trace, {"ts": _utc_now(), "event": "gemini_end", "exit_code": code_b})
        out["gemini_ok"] = code_b == 0

    return out


_RE_GEMINI_HOOK_PREAMBLE = re.compile(r"^Hook registry initialized with \d+ hook entries\s*$")


def _sanitize_gemini_output(path: Path) -> None:
    """
    Some Gemini CLI builds emit a one-line preamble like:
      "Hook registry initialized with 0 hook entries"
    before the actual model output. Strip that deterministically if present at the top.
    """
    if not path.is_file():
        return
    try:
        raw = _read_text(path)
    except Exception:
        return
    lines = raw.splitlines()
    i = 0
    # Skip leading blanks and a single known preamble line.
    while i < len(lines) and not lines[i].strip():
        i += 1
    if i < len(lines) and _RE_GEMINI_HOOK_PREAMBLE.match(lines[i]):
        i += 1
        while i < len(lines) and not lines[i].strip():
            i += 1
    cleaned = "\n".join(lines[i:]).rstrip() + "\n"
    if cleaned != raw:
        path.write_text(cleaned, encoding="utf-8")


def _read_json(path: Path) -> Any:
    return json.loads(_read_text(path))


def _iter_corpus_order(corpus_dir: Path, *, trace: Path | None = None) -> list[dict[str, Any]]:
    """
    Return the INSPIRE order list when available. Falls back to sorting paper dirs.
    Each entry is a dict containing at least: safe_id (str), rank (int|None).
    """
    order_path = corpus_dir / "records_order.json"
    papers_dir = corpus_dir / "papers"
    if order_path.is_file():
        try:
            data = _read_json(order_path)
            order = data.get("order")
            if isinstance(order, list) and order:
                out: list[dict[str, Any]] = []
                for e in order:
                    if not isinstance(e, dict):
                        continue
                    safe_id = str(e.get("safe_id") or "").strip()
                    if not safe_id:
                        continue
                    rank = e.get("rank")
                    out.append(
                        {
                            "safe_id": safe_id,
                            "rank": int(rank) if isinstance(rank, int) else None,
                            "year": str(e.get("year") or "").strip(),
                            "title": _strip_simple_html(e.get("title") or ""),
                            "recid": str(e.get("recid") or "").strip(),
                        }
                    )
                if out:
                    return out
        except Exception as exc:
            if trace is not None:
                _append_jsonl(trace, {"ts": _utc_now(), "event": "progress_order_read_error", "error": str(exc)})

    # Fallback: use existing paper dirs.
    if papers_dir.is_dir():
        dirs = sorted([p for p in papers_dir.iterdir() if p.is_dir()], key=lambda p: p.name, reverse=True)
        return [{"safe_id": p.name, "rank": None, "year": "", "title": "", "recid": ""} for p in dirs]
    return []


def _pack_status(pack_dir: Path) -> dict[str, bool]:
    pack_complete = (pack_dir / "pack.md").is_file() and (pack_dir / "flattened_main.tex").is_file() and (pack_dir / "evidence.json").is_file()
    return {
        "pack": bool(pack_complete),
        "claude": _model_output_ok(pack_dir / "claude.md"),
        "gemini": _model_output_ok(pack_dir / "gemini.md"),
    }


def _truncate_one_line(s: str, *, max_chars: int) -> str:
    s = re.sub(r"\s+", " ", str(s or "")).strip()
    if len(s) <= max_chars:
        return s
    return s[: max_chars - 1].rstrip() + "…"


def _write_progress(out_dir: Path, *, corpus_dir: Path, run_claude: bool, run_gemini: bool, trace: Path) -> dict[str, Any]:
    """
    Write a small deterministic progress snapshot for long-running corpus jobs.
    """
    packs_dir = out_dir / "packs"
    order = _iter_corpus_order(corpus_dir, trace=trace)
    total = len(order)

    rows: list[dict[str, Any]] = []
    missing_claude: list[str] = []
    missing_gemini: list[str] = []
    missing_both: list[str] = []
    packs_present = 0
    dual_done = 0

    for e in order:
        sid = e["safe_id"]
        st = _pack_status(packs_dir / sid)
        packs_present += 1 if st["pack"] else 0
        want_claude = bool(run_claude)
        want_gemini = bool(run_gemini)
        have_claude = st["claude"] if want_claude else True
        have_gemini = st["gemini"] if want_gemini else True
        done = bool(st["pack"]) and bool(have_claude) and bool(have_gemini)
        dual_done += 1 if done else 0

        if st["pack"]:
            if want_claude and not st["claude"]:
                missing_claude.append(sid)
            if want_gemini and not st["gemini"]:
                missing_gemini.append(sid)
            if want_claude and want_gemini and (not st["claude"]) and (not st["gemini"]):
                missing_both.append(sid)

        rows.append(
            {
                "rank": e.get("rank"),
                "safe_id": sid,
                "year": e.get("year", ""),
                "title": e.get("title", ""),
                "pack": st["pack"],
                "claude": st["claude"],
                "gemini": st["gemini"],
                "done": done,
            }
        )

    # Batch summary (10 papers per batch).
    batch_size = 10
    batches: list[dict[str, Any]] = []
    if total:
        for i in range(0, total, batch_size):
            chunk = rows[i : i + batch_size]
            batch_idx = (i // batch_size) + 1
            packs_b = sum(1 for r in chunk if r["pack"])
            done_b = sum(1 for r in chunk if r["done"])
            batches.append(
                {
                    "batch": batch_idx,
                    "ranks": f"{i + 1}-{min(i + batch_size, total)}",
                    "packs": f"{packs_b}/{len(chunk)}",
                    "done": f"{done_b}/{len(chunk)}",
                }
            )

    # Next up: first 10 not-done papers in INSPIRE order.
    next_up = [r for r in rows if not r["done"]][:10]

    # Include corpus meta query if present.
    corpus_meta_path = corpus_dir / "meta.json"
    corpus_meta: dict[str, Any] = {}
    if corpus_meta_path.is_file():
        try:
            m = _read_json(corpus_meta_path)
            if isinstance(m, dict):
                corpus_meta = m
        except Exception as exc:
            _append_jsonl(trace, {"ts": _utc_now(), "event": "progress_meta_read_error", "error": str(exc)})

    # Trace-derived summaries (last run + recent errors).
    last_done: dict[str, Any] | None = None
    recent_errors: list[dict[str, Any]] = []
    if trace.is_file():
        try:
            with trace.open("r", encoding="utf-8", errors="replace") as f:
                for ln in f:
                    ln = ln.strip()
                    if not ln:
                        continue
                    try:
                        ev = json.loads(ln)
                    except Exception:
                        continue
                    if not isinstance(ev, dict):
                        continue
                    if ev.get("event") == "done":
                        last_done = ev
                    if ev.get("event") == "paper_error":
                        recent_errors.append(
                            {
                                "ts": ev.get("ts"),
                                "arxiv_id": ev.get("arxiv_id"),
                                "error": ev.get("error"),
                            }
                        )
                        recent_errors = recent_errors[-5:]
        except Exception as exc:
            _append_jsonl(trace, {"ts": _utc_now(), "event": "progress_trace_read_error", "error": str(exc)})

    progress_json = {
        "updated_at": _utc_now(),
        "out_dir": str(out_dir),
        "corpus_dir": str(corpus_dir),
        "total_papers": total,
        "packs_present": packs_present,
        "dual_model_complete": dual_done,
        "run_claude": bool(run_claude),
        "run_gemini": bool(run_gemini),
        "missing_claude": missing_claude,
        "missing_gemini": missing_gemini,
        "missing_both": missing_both,
        "batches": batches,
        "next_up": [{"rank": r["rank"], "safe_id": r["safe_id"], "year": r["year"]} for r in next_up],
        "last_run": {
            "ts": (last_done or {}).get("ts"),
            "processed": int((last_done or {}).get("processed") or 0),
            "errors": int((last_done or {}).get("errors") or 0),
            "skipped_existing": int((last_done or {}).get("skipped_existing") or 0),
            "skipped_no_main_tex": int((last_done or {}).get("skipped_no_main_tex") or 0),
        },
        "recent_errors": recent_errors,
        "corpus_meta": {
            "query": corpus_meta.get("query", ""),
            "sort": corpus_meta.get("sort", ""),
            "max_records": corpus_meta.get("max_records", ""),
            "extra_params": corpus_meta.get("extra_params", {}),
        },
    }
    _write_json(out_dir / "PROGRESS.json", progress_json)

    lines: list[str] = []
    lines.append("# PRL discussion-logic extraction — progress")
    lines.append("")
    lines.append(f"- Updated: {progress_json['updated_at']}")
    lines.append(f"- Out: `{out_dir}`")
    lines.append(f"- Corpus: `{corpus_dir}`")
    q = str(progress_json["corpus_meta"].get("query") or "").strip()
    if q:
        lines.append(f"- INSPIRE query: `{q}`")
    extra = progress_json["corpus_meta"].get("extra_params") or {}
    if isinstance(extra, dict) and extra:
        lines.append(f"- Filters: `{json.dumps(extra, sort_keys=True)}`")
    lines.append(f"- Total papers: **{total}**")
    lines.append(f"- Packs present: **{packs_present}/{total}**")
    lines.append(f"- Dual-model complete: **{dual_done}/{total}**")
    lines.append("")

    lr = progress_json.get("last_run") or {}
    if isinstance(lr, dict):
        lines.append("## Last run")
        lines.append("")
        lines.append(
            f"- processed={lr.get('processed', 0)} errors={lr.get('errors', 0)} skipped_existing={lr.get('skipped_existing', 0)} skipped_no_main_tex={lr.get('skipped_no_main_tex', 0)}"
        )
        lines.append("")

    if recent_errors:
        lines.append("## Recent errors (tail)")
        lines.append("")
        for e in recent_errors:
            ts = str(e.get("ts") or "").strip() or "?"
            aid = str(e.get("arxiv_id") or "").strip() or "?"
            msg = _truncate_one_line(e.get("error") or "", max_chars=140)
            lines.append(f"- {ts} `{aid}` — {msg}")
        lines.append("")

    if batches:
        lines.append("## Batch summary (N=10)")
        lines.append("")
        lines.append("| batch | ranks | packs | dual-model |")
        lines.append("|---:|:---:|:---:|:---:|")
        for b in batches:
            lines.append(f"| {b['batch']} | {b['ranks']} | {b['packs']} | {b['done']} |")
        lines.append("")

    lines.append("## Missing outputs")
    lines.append("")
    if run_claude:
        lines.append(f"- Missing Claude: {len(missing_claude)}")
        if missing_claude:
            lines.append(f"  - `{', '.join(missing_claude[:25])}`" + (" …" if len(missing_claude) > 25 else ""))
    if run_gemini:
        lines.append(f"- Missing Gemini: {len(missing_gemini)}")
        if missing_gemini:
            lines.append(f"  - `{', '.join(missing_gemini[:25])}`" + (" …" if len(missing_gemini) > 25 else ""))
    if run_claude and run_gemini:
        lines.append(f"- Missing both: {len(missing_both)}")
        if missing_both:
            lines.append(f"  - `{', '.join(missing_both[:25])}`" + (" …" if len(missing_both) > 25 else ""))
    lines.append("")

    lines.append("## Next up (first 10 not complete)")
    lines.append("")
    if not next_up:
        lines.append("- (none)")
    else:
        for r in next_up:
            rank = r.get("rank")
            sid = r["safe_id"]
            year = r.get("year", "")
            title = _truncate_one_line(r.get("title", ""), max_chars=92)
            left = f"{rank}." if isinstance(rank, int) else "-"
            bits = [sid]
            if year:
                bits.append(year)
            if title:
                bits.append(title)
            if len(bits) > 1:
                lines.append(f"- {left} `{sid}` — " + " — ".join(bits[1:]))
            else:
                lines.append(f"- {left} `{sid}`")
    lines.append("")

    lines.append("## Continue")
    lines.append("")
    lines.append("Repair missing model outputs:")
    lines.append("")
    lines.append("```bash")
    lines.append(f"python3 scripts/bin/research_writer_learn_discussion_logic.py --out-dir \"{out_dir}\" --corpus-dir \"{corpus_dir}\" --mode repair --n 10 --resume --run-models")
    lines.append("```")
    lines.append("")
    lines.append("Add the next batch:")
    lines.append("")
    lines.append("```bash")
    lines.append(f"python3 scripts/bin/research_writer_learn_discussion_logic.py --out-dir \"{out_dir}\" --corpus-dir \"{corpus_dir}\" --mode new --n 10 --resume --run-models")
    lines.append("```")
    lines.append("")

    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / "PROGRESS.md").write_text("\n".join(lines).rstrip() + "\n", encoding="utf-8")
    return progress_json


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--out-dir", required=True, type=Path, help="Output directory for packs + logs.")
    ap.add_argument("--n", type=int, default=10, help="Number of papers to process (default: 10).")
    ap.add_argument("--resume", action="store_true", help="Skip papers whose packs (and model outputs, if requested) already exist.")
    ap.add_argument(
        "--mode",
        default="new",
        choices=["new", "repair"],
        help="Selection mode: 'new' = create N new packs; 'repair' = retry missing model outputs for existing packs.",
    )
    ap.add_argument("--query-url", default="", help="INSPIRE UI query URL (used only if fetching).")
    ap.add_argument("--query", default="", help="INSPIRE query string (used only if fetching).")
    ap.add_argument("--corpus-dir", type=Path, default=None, help="Existing corpus dir (output of fetch_prl_style_corpus.py).")
    ap.add_argument("--fetch", action="store_true", help="Fetch the corpus into out-dir/corpus (requires --query-url or --query).")
    ap.add_argument("--fetch-n", type=int, default=None, help="If fetching, number of records to fetch (default: same as --n).")
    ap.add_argument("--mask-math", action="store_true", help="Mask common math blocks in excerpts (recommended).")
    ap.add_argument("--mask-cites", action="store_true", help="Mask \\cite{...} in excerpts (recommended).")
    ap.add_argument("--run-models", action="store_true", help="Run Claude+Gemini on each pack (clean-room, tools disabled).")
    ap.add_argument("--stub-models", action="store_true", help="Offline testing: do not call external model CLIs; write deterministic stub outputs.")
    ap.add_argument(
        "--models",
        default="",
        help="Optional comma-separated subset of models to run: claude,gemini. Overrides --run-models default.",
    )
    ap.add_argument("--claude-model", default="opus")
    ap.add_argument("--gemini-model", default="gemini-3-pro-preview")
    ap.add_argument("--claude-timeout-s", type=int, default=1800, help="Timeout per Claude call (seconds).")
    ap.add_argument("--gemini-timeout-s", type=int, default=1800, help="Timeout per Gemini call (seconds).")
    args = ap.parse_args()

    out_dir = args.out_dir.expanduser().resolve()
    out_dir.mkdir(parents=True, exist_ok=True)
    trace = out_dir / "trace.jsonl"
    packs_dir = out_dir / "packs"

    _append_jsonl(trace, {"ts": _utc_now(), "event": "start", "argv": sys.argv})

    corpus_dir = args.corpus_dir.expanduser().resolve() if args.corpus_dir is not None else None
    if args.fetch or corpus_dir is None:
        corpus_dir = out_dir / "corpus"
        fetch_n = int(args.fetch_n) if args.fetch_n is not None else int(args.n)
        code = _run_fetch(
            query_url=args.query_url,
            query=args.query,
            n=max(0, fetch_n),
            out_dir=corpus_dir,
            trace=trace,
            resume=bool(args.resume),
        )
        if code != 0:
            return code

    assert corpus_dir is not None
    papers_dir = corpus_dir / "papers"
    if not papers_dir.is_dir():
        print(f"ERROR: corpus papers dir not found: {papers_dir}", file=sys.stderr)
        return 2

    # Choose papers in INSPIRE order when possible (records_order.json), otherwise fall back.
    # In --resume mode we select the first N *unprocessed* papers, enabling repeated N=10 batch runs.
    paper_dirs = _ordered_paper_dirs(papers_dir, trace=trace)

    system_prompt = _skill_root() / "assets" / "style" / "discussion_logic_extractor_system_prompt.txt"
    if (args.run_models or args.models.strip()) and not system_prompt.is_file():
        print(f"ERROR: system prompt not found: {system_prompt}", file=sys.stderr)
        return 2

    model_set = {m.strip().lower() for m in args.models.split(",") if m.strip()} if args.models.strip() else set()
    run_claude = ("claude" in model_set) if model_set else bool(args.run_models)
    run_gemini = ("gemini" in model_set) if model_set else bool(args.run_models)

    meta = {
        "created_at": _utc_now(),
        "n": int(args.n),
        "corpus_dir": str(corpus_dir),
        "mode": str(args.mode),
        "mask_math": bool(args.mask_math),
        "mask_cites": bool(args.mask_cites),
        "run_models": bool(args.run_models),
        "stub_models": bool(args.stub_models),
        "run_claude": bool(run_claude),
        "run_gemini": bool(run_gemini),
        "models": sorted(model_set) if model_set else [],
        "claude_model": args.claude_model,
        "gemini_model": args.gemini_model,
        "claude_timeout_s": int(args.claude_timeout_s),
        "gemini_timeout_s": int(args.gemini_timeout_s),
    }
    _write_json(out_dir / "meta.json", meta)

    processed = 0
    skipped_existing = 0
    skipped_no_main_tex = 0
    errors = 0
    for pd in paper_dirs:
        if processed >= max(0, int(args.n)):
            break
        arxiv_id = pd.name
        pack_dir = packs_dir / arxiv_id
        pack_path = pack_dir / "pack.md"
        flat_path = pack_dir / "flattened_main.tex"
        evidence_path = pack_dir / "evidence.json"
        claude_out = pack_dir / "claude.md"
        gemini_out = pack_dir / "gemini.md"

        pack_complete = pack_path.is_file() and flat_path.is_file() and evidence_path.is_file()
        models_complete = (not run_claude or _model_output_ok(claude_out)) and (not run_gemini or _model_output_ok(gemini_out))

        if args.mode == "new" and pack_complete:
            # In --run-models mode, treat packs as "existing" only when the requested model
            # outputs are also present. This prevents silent partial batches when a runner
            # exhausts retries (claude/gemini exit non-zero) but pack files exist.
            if args.resume and (not (run_claude or run_gemini) or models_complete):
                skipped_existing += 1
                continue

        if args.mode == "repair" and not pack_complete:
            continue

        if args.resume and args.mode == "repair" and models_complete:
            skipped_existing += 1
            _append_jsonl(
                trace,
                {
                    "ts": _utc_now(),
                    "event": "resume_skip_existing",
                    "arxiv_id": arxiv_id,
                    "pack_complete": True,
                    "models_complete": bool(models_complete),
                },
            )
            continue

        rec_path = pd / "record.json"
        rec: dict[str, Any] = {}
        if rec_path.is_file():
            try:
                rec = json.loads(_read_text(rec_path))
            except Exception:
                rec = {}
            if "arxiv_id" not in rec:
                rec["arxiv_id"] = arxiv_id

        try:
            if args.mode == "new" and not (args.resume and pack_complete):
                main_tex = _find_main_tex(pd)
                if main_tex is None:
                    skipped_no_main_tex += 1
                    _append_jsonl(trace, {"ts": _utc_now(), "event": "skip_no_main_tex", "arxiv_id": arxiv_id})
                    continue

                flat = _flatten_inputs(_read_text(main_tex), paper_dir=pd)
                pack_dir.mkdir(parents=True, exist_ok=True)
                flat_path.write_text(flat, encoding="utf-8")

                segs, evidence = _extract_segments_text(
                    flat,
                    evidence_name=flat_path.name,
                    mask_math=bool(args.mask_math),
                    mask_cites=bool(args.mask_cites),
                )
                evidence["arxiv_id"] = arxiv_id
                evidence["source_main_tex"] = main_tex.name
                _write_json(evidence_path, evidence)
                if rec:
                    _write_json(pack_dir / "record.json", rec)
                _write_pack(pack_path, rec=rec, segs=segs)

                _append_jsonl(
                    trace,
                    {
                        "ts": _utc_now(),
                        "event": "pack_ok",
                        "arxiv_id": arxiv_id,
                        "main_tex": main_tex.name,
                        "segments": len(segs),
                    },
                )

            run_claude_needed = bool(run_claude) and not _model_output_ok(claude_out)
            run_gemini_needed = bool(run_gemini) and not _model_output_ok(gemini_out)
            if (run_claude_needed or run_gemini_needed):
                _run_models_for_pack(
                    out_dir=pack_dir,
                    pack_path=pack_path,
                    system_prompt_path=system_prompt,
                    run_claude=bool(run_claude_needed),
                    run_gemini=bool(run_gemini_needed),
                    claude_model=args.claude_model,
                    gemini_model=args.gemini_model,
                    claude_timeout_s=int(args.claude_timeout_s),
                    gemini_timeout_s=int(args.gemini_timeout_s),
                    stub_models=bool(args.stub_models),
                    trace=trace,
                )
                if run_gemini_needed:
                    _sanitize_gemini_output(gemini_out)

            processed += 1
        except Exception as exc:
            errors += 1
            _append_jsonl(trace, {"ts": _utc_now(), "event": "paper_error", "arxiv_id": arxiv_id, "error": str(exc)})
            continue

    _append_jsonl(
        trace,
        {
            "ts": _utc_now(),
            "event": "done",
            "processed": processed,
            "skipped_existing": skipped_existing,
            "skipped_no_main_tex": skipped_no_main_tex,
            "errors": errors,
        },
    )
    progress_obj: dict[str, Any] | None = None
    try:
        progress_obj = _write_progress(out_dir, corpus_dir=corpus_dir, run_claude=bool(run_claude), run_gemini=bool(run_gemini), trace=trace)
    except Exception as exc:
        _append_jsonl(trace, {"ts": _utc_now(), "event": "progress_write_error", "error": str(exc)})
    print("[ok] discussion-logic packs prepared")
    print(f"- corpus: {corpus_dir}")
    print(f"- out:    {out_dir}")
    print(f"- packs:  {packs_dir}")
    if args.resume:
        print(f"- skipped existing: {skipped_existing}")
    if progress_obj:
        try:
            total = int(progress_obj.get("total_papers") or 0)
            packs_present = int(progress_obj.get("packs_present") or 0)
            dual_done = int(progress_obj.get("dual_model_complete") or 0)
            miss_c = len(progress_obj.get("missing_claude") or []) if bool(progress_obj.get("run_claude")) else 0
            miss_g = len(progress_obj.get("missing_gemini") or []) if bool(progress_obj.get("run_gemini")) else 0
            print(f"[summary] packs={packs_present}/{total} dual={dual_done}/{total} missing: claude={miss_c} gemini={miss_g}")
            print(f"[summary] progress: {out_dir / 'PROGRESS.md'}")
        except Exception:
            pass
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
