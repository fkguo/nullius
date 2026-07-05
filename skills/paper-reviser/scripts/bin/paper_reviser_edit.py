#!/usr/bin/env python3
# CONTRACT-EXEMPT: CODE-01.1 sunset:2026-06-01 — monolithic reviser; split blocked on paper-reviser skill redesign
"""
paper_reviser_edit.py

Content-first paper reviser for LaTeX drafts.

Workflow (human-like):
  1) Read-through: understand global intent/logic/style.
  2) Writer line-edit: produce a conservative candidate edit (body-only for full documents).
  3) Auditor review: independent critique + verification requests.
  4) Deep verifier (Codex): step-by-step derivation/maths checks from verification requests.
  5) Optional repair loop: apply reviewer feedback, re-audit and re-verify.

Outputs (under --out-dir):
  - original.tex (LF-normalized baseline)
  - clean.tex
  - changes.diff (unified diff)
  - tracked.tex (full documents only, and only when real latexdiff succeeds)
  - tracked_fragment_audit.tex (fragment-only audit view; not a valid tracked delivery)
  - readthrough.md
  - risk_flags.md
  - global_style_notes.md
  - changes.md
  - open_questions.md
  - audit.md
  - response_revision_audit.md
  - verification_requests.md
  - deep_verification.md
  - run.json
  - trace.jsonl

This script intentionally avoids external Python deps.
"""

from __future__ import annotations

import argparse
import dataclasses
import difflib
import hashlib
import json
import re
import shutil
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


_MARKER_LINE_RE = re.compile(r"^\s*%%__CODEX_BLOCK__([A-Z_]+)__(BEGIN|END)__\s*$", flags=re.M)


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def _sha256_text(text: str) -> str:
    return _sha256_bytes(text.encode("utf-8", errors="replace"))


def _sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def _read_text(path: Path, *, encoding: str) -> str:
    raw = path.read_bytes()
    try:
        text = raw.decode(encoding)
    except UnicodeDecodeError as exc:
        raise UnicodeDecodeError(
            exc.encoding,
            exc.object,
            exc.start,
            exc.end,
            f"{exc.reason} (hint: pass --encoding; input_bytes_sha256={_sha256_bytes(raw)})",
        )

    # Strip UTF-8 BOM (common editor artifact).
    if text.startswith("\ufeff"):
        text = text.lstrip("\ufeff")

    # Normalize newlines to LF.
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    if not text.endswith("\n"):
        text += "\n"
    return text


def _write_text(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")


def _write_json(path: Path, obj: Any) -> None:
    _write_text(path, json.dumps(obj, indent=2, sort_keys=True) + "\n")


def _append_jsonl(path: Path, obj: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as f:
        f.write(json.dumps(obj, sort_keys=True) + "\n")


def _skill_root() -> Path:
    return Path(__file__).resolve().parents[2]


# All cli-runner families accept the same core flags
# (--model / --system-prompt-file / --prompt-file / --out); their extra flags are
# optional with sane defaults, so a single generic dispatch covers every family.
BACKEND_FAMILIES: tuple[str, ...] = ("claude", "gemini", "codex", "opencode", "kimi")


def _resolve_family_runner(family: str) -> Path | None:
    """
    Resolve `<family>-cli-runner/scripts/run_<family>.sh` under the sibling skills
    root where this skill is installed (host-neutral: derived from this script's own
    location, no single host hardcoded). Returns None if the runner is absent.
    """
    base = _skill_root().parent
    runner = base / f"{family}-cli-runner" / "scripts" / f"run_{family}.sh"
    return runner if runner.is_file() else None


def _default_runner_paths() -> tuple[Path | None, Path | None]:
    # Back-compat helper for the claude/gemini default runners.
    return (_resolve_family_runner("claude"), _resolve_family_runner("gemini"))


def _estimate_tokens_est(text: str) -> int:
    # Conservative heuristic for LaTeX-heavy text.
    return (len(text) + 2) // 3


def _first_unescaped_comment_pos(line: str) -> int | None:
    r"""
    Return index of the first TeX comment-starting % in the line, or None.

    Treat % as starting a comment unless it is escaped as \% (odd backslashes).
    Best-effort: TeX tokenization is more complex, but this catches common cases.
    """
    for i, ch in enumerate(line):
        if ch != "%":
            continue
        j = i - 1
        bs = 0
        while j >= 0 and line[j] == "\\":
            bs += 1
            j -= 1
        if bs % 2 == 0:
            return i
    return None


def _strip_tex_comment(line: str) -> str:
    pos = _first_unescaped_comment_pos(line)
    return line if pos is None else line[:pos]


def _find_uncommented_begin_document(tex: str) -> int | None:
    """Return string index of the first uncommented \\begin{document}, else None."""
    offset = 0
    for ln in tex.splitlines(keepends=True):
        content = _strip_tex_comment(ln)
        idx = content.find("\\begin{document}")
        if idx != -1:
            return offset + idx
        offset += len(ln)
    return None


def _has_uncommented_end_document(tex: str) -> bool:
    """True if an uncommented \\end{document} appears anywhere in tex."""
    for ln in tex.splitlines():
        if "\\end{document}" in _strip_tex_comment(ln):
            return True
    return False


def _preflight_marker_collision(tex: str) -> list[str]:
    collisions: list[str] = []
    for ln in tex.splitlines():
        if _MARKER_LINE_RE.match(ln):
            collisions.append(ln)
    return collisions


class BlockParseError(RuntimeError):
    pass


class LatexdiffDeliveryError(RuntimeError):
    def __init__(self, message: str, *, metadata: dict[str, Any]) -> None:
        super().__init__(message)
        self.metadata = metadata


def _extract_block(raw: str, *, name: str, allow_implicit_begin: bool = False) -> str:
    """
    Extract a single tagged block.

    Requirements:
    - Exactly one BEGIN and one END marker, as full lines.
    - Content returned with LF newlines and a trailing newline.
    - Fail if any marker-like line appears inside the extracted content.
    """
    begin_pat = re.compile(rf"^\s*%%__CODEX_BLOCK__{re.escape(name)}__BEGIN__\s*$", flags=re.M)
    end_pat = re.compile(rf"^\s*%%__CODEX_BLOCK__{re.escape(name)}__END__\s*$", flags=re.M)

    begins = list(begin_pat.finditer(raw))
    ends = list(end_pat.finditer(raw))

    implicit_begin = bool(allow_implicit_begin and len(begins) == 0 and len(ends) == 1)
    if not implicit_begin and (len(begins) != 1 or len(ends) != 1):
        raise BlockParseError(
            f"block {name}: expected exactly 1 BEGIN and 1 END marker, got {len(begins)} BEGIN and {len(ends)} END"
        )

    e = ends[0]
    if implicit_begin:
        start = 0
        # END-only recovery: avoid swallowing preceding tagged blocks.
        # If other markers appear before END, start after the last marker line.
        last_marker_before_end: re.Match[str] | None = None
        prefix = raw[: e.start()]
        for m in _MARKER_LINE_RE.finditer(prefix):
            last_marker_before_end = m
        if last_marker_before_end is not None:
            start = last_marker_before_end.end()
            if start < len(raw) and raw[start : start + 1] == "\n":
                start += 1
    else:
        b = begins[0]
        if e.start() <= b.end():
            raise BlockParseError(f"block {name}: END appears before BEGIN")
        start = b.end()
        if start < len(raw) and raw[start : start + 1] == "\n":
            start += 1

    if e.start() <= start:
        raise BlockParseError(f"block {name}: END appears before content start")

    end = e.start()
    if end > 0 and raw[end - 1 : end] == "\n":
        end -= 1

    content = raw[start:end]
    content = content.replace("\r\n", "\n").replace("\r", "\n")
    for ln in content.splitlines():
        if _MARKER_LINE_RE.match(ln):
            raise BlockParseError(f"block {name}: marker-like line found inside content: {ln!r}")
    if not content.endswith("\n"):
        content += "\n"
    return content


def _deep_verifier_accepts_timeout_fallback(
    *,
    codex_verify: bool,
    deep_verdict: str,
    deep_verifier_timed_out: bool,
    codex_timeout_policy: str,
    secondary_backend_enabled: bool,
    secondary_deep_verdict: str,
) -> bool:
    if not codex_verify:
        return True
    if deep_verdict == "READY":
        return True
    return bool(
        deep_verifier_timed_out
        and codex_timeout_policy == "allow-secondary"
        and secondary_backend_enabled
        and secondary_deep_verdict == "READY"
    )


def _strip_comment_environment(tex: str) -> str:
    """
    Remove \\begin{comment}...\\end{comment} blocks (best-effort, non-nested).
    """
    begin_re = re.compile(r"^\s*\\begin\{comment\}\s*(?:%.*)?$")
    end_re = re.compile(r"^\s*\\end\{comment\}\s*(?:%.*)?$")

    out: list[str] = []
    in_comment_env = False
    for ln in tex.splitlines(keepends=True):
        non_comment = _strip_tex_comment(ln)
        if in_comment_env:
            if end_re.match(non_comment):
                in_comment_env = False
            continue
        if begin_re.match(non_comment):
            in_comment_env = True
            continue
        out.append(ln)
    return "".join(out)


def _count_non_comment_bytes(tex: str) -> int:
    """
    Approximate payload bytes by stripping TeX comments and comment environments.
    """
    stripped_env = _strip_comment_environment(tex)
    total = 0
    for ln in stripped_env.splitlines(keepends=True):
        code = _strip_tex_comment(ln)
        if not code.strip():
            continue
        total += len(code.encode("utf-8", errors="replace"))
    return total


def _compute_clean_size_ratio_details(original: str, clean: str) -> dict[str, float | int]:
    raw_ratio = len(clean) / max(len(original), 1)
    original_non_comment_bytes = _count_non_comment_bytes(original)
    clean_non_comment_bytes = _count_non_comment_bytes(clean)
    non_comment_ratio = clean_non_comment_bytes / max(original_non_comment_bytes, 1)
    effective_ratio = max(raw_ratio, non_comment_ratio)
    return {
        "raw_ratio": raw_ratio,
        "non_comment_ratio": non_comment_ratio,
        "effective_ratio": effective_ratio,
        "original_non_comment_bytes": original_non_comment_bytes,
        "clean_non_comment_bytes": clean_non_comment_bytes,
    }


def _compute_clean_size_ratio(original: str, clean: str) -> float:
    """
    Adaptive clean-size ratio used by --min-clean-size-ratio checks.
    """
    return float(_compute_clean_size_ratio_details(original, clean)["effective_ratio"])


def _build_deep_verification_timeout_stub(*, stage: str, timeout_seconds: int) -> str:
    return (
        "VERDICT: NOT_READY\n\n"
        "## What was checked\n\n"
        f"- Stage `{stage}` timed out after {timeout_seconds} seconds before returning a verifier payload.\n\n"
        "## Step-by-step verification\n\n"
        "- Not available due to timeout.\n\n"
        "## Issues found (if any)\n\n"
        "- Deep verification did not complete within the hard timeout budget.\n\n"
        "## Minimal fix instructions\n\n"
        "- Re-run deep verification with narrower excerpts or a higher timeout.\n"
        "- If a secondary deep verifier is enabled, use it as fallback evidence.\n\n"
        "## Assumptions / required context\n\n"
        "- Timeout is treated as an auditable NOT_READY condition.\n"
    )


@dataclasses.dataclass(frozen=True)
class ModelConfig:
    writer_backend: str
    writer_model: str
    auditor_backend: str
    auditor_model: str
    # Resolved runner path per backend family (only the families that were found /
    # explicitly overridden are present). Back-compat: claude_runner / gemini_runner
    # remain available as convenience accessors.
    runners: dict[str, Path]
    fallback_auditor: str
    fallback_auditor_model: str
    codex_model: str
    codex_verify: bool
    codex_config_overrides: tuple[str, ...]

    @property
    def claude_runner(self) -> Path:
        return self.runners["claude"]

    @property
    def gemini_runner(self) -> Path:
        return self.runners["gemini"]


def _run_cmd(cmd: list[str], *, trace_path: Path, stage: str) -> int:
    _append_jsonl(trace_path, {"ts": _utc_now(), "stage": stage, "event": "model_call", "cmd": cmd})
    proc = subprocess.run(cmd, check=False)
    _append_jsonl(trace_path, {"ts": _utc_now(), "stage": stage, "event": "model_call_end", "exit_code": proc.returncode})
    return proc.returncode


def _run_cmd_with_stdin_file(cmd: list[str], *, stdin_path: Path, trace_path: Path, stage: str) -> int:
    _append_jsonl(
        trace_path,
        {
            "ts": _utc_now(),
            "stage": stage,
            "event": "model_call",
            "cmd": cmd,
            "stdin_path": str(stdin_path),
            "stdin_sha256": _sha256_file(stdin_path) if stdin_path.is_file() else None,
        },
    )
    with stdin_path.open("rb") as fin:
        proc = subprocess.run(cmd, check=False, stdin=fin)
    _append_jsonl(trace_path, {"ts": _utc_now(), "stage": stage, "event": "model_call_end", "exit_code": proc.returncode})
    return proc.returncode


def _run_family_runner(
    *,
    runner: Path,
    model: str,
    system_prompt_file: Path,
    prompt_file: Path,
    out_file: Path,
    trace_path: Path,
    stage: str,
) -> int:
    """
    Invoke any `<family>-cli-runner/scripts/run_<family>.sh` with the uniform four
    core flags shared by every family (claude/gemini/codex/opencode/kimi). Each
    runner's extra flags (codex --sandbox/--skip-git-repo-check,
    opencode/kimi --tool-mode/--workspace-dir, gemini --tool-mode) are optional and
    default sanely, so this single call covers all of them.
    """
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
    return _run_cmd(cmd, trace_path=trace_path, stage=stage)


def _run_backend(
    *,
    backend: str,
    runners: dict[str, Path],
    model: str,
    system_prompt_file: Path,
    prompt_file: Path,
    out_file: Path,
    trace_path: Path,
    stage: str,
) -> int:
    runner = runners.get(backend)
    if runner is None:
        raise ValueError(f"no resolved runner for backend: {backend!r}")
    return _run_family_runner(
        runner=runner,
        model=model,
        system_prompt_file=system_prompt_file,
        prompt_file=prompt_file,
        out_file=out_file,
        trace_path=trace_path,
        stage=stage,
    )


def _unified_diff(original: str, clean: str) -> str:
    o_lines = original.splitlines(keepends=True)
    c_lines = clean.splitlines(keepends=True)
    diff = difflib.unified_diff(
        o_lines,
        c_lines,
        fromfile="original.tex",
        tofile="clean.tex",
        n=3,
        lineterm="",
    )
    out = "\n".join(diff) + "\n"
    return out.replace("\r\n", "\n").replace("\r", "\n")


def _comment_annotated_tracked(original: str, clean: str) -> str:
    """
    Compile-safe tracked view: clean.tex with comment annotations for deletions/replacements.

    This is not a visual redline; it is an inline, greppable audit trail.
    """
    o = original.splitlines()
    c = clean.splitlines()
    sm = difflib.SequenceMatcher(a=o, b=c)
    out: list[str] = []
    hunk_id = 0
    for tag, i1, i2, j1, j2 in sm.get_opcodes():
        if tag == "equal":
            out.extend(c[j1:j2])
            continue
        hunk_id += 1
        out.append(f"% HUNK {hunk_id}: {tag} original[{i1}:{i2}] -> clean[{j1}:{j2}]")
        if tag in {"replace", "delete"}:
            for ln in o[i1:i2]:
                out.append(f"% REVDEL: {ln}")
        if tag in {"replace", "insert"}:
            for ln in c[j1:j2]:
                out.append(f"% REVADD: {ln}")
                out.append(ln)
            continue
        # delete: nothing to add
    return "\n".join(out) + "\n"


def _extract_labels(tex: str) -> set[str]:
    return set(re.findall(r"\\label\{([^}]+)\}", tex))


def _extract_refs(tex: str) -> set[str]:
    refs = set(re.findall(r"\\(?:eq)?ref\{([^}]+)\}", tex))
    hrefs = set(re.findall(r"\\hyperref\[([^\]]+)\]", tex))
    return refs | hrefs


_RE_CITE = re.compile(r"\\cite\\w*\s*(?:\[[^\]]*\]\s*)*\{([^}]+)\}")


def _extract_cite_keys(tex: str) -> set[str]:
    keys: set[str] = set()
    for group in _RE_CITE.findall(tex):
        for k in group.split(","):
            kk = k.strip()
            if kk:
                keys.add(kk)
    return keys


def _extract_protected_env_blocks(tex: str, *, env_names: list[str]) -> list[str]:
    """Best-effort, non-nested extraction of protected environments as raw text blocks."""
    lines = tex.splitlines(keepends=True)
    out: list[str] = []

    # Allow common verbatim-like envs with optional args, e.g.
    #   \begin{minted}[...]{python}
    #   \begin{lstlisting}[...]
    # We intentionally keep this best-effort: full TeX parsing is out of scope.
    begin_re = re.compile(
        r"^\s*\\begin\{(?P<env>"
        + "|".join(re.escape(e) for e in (env_names + ["verbatim*"]))
        + r")\}\s*"
        + r"(?:\[[^\]]*\]\s*)*"  # optional args (single-line)
        + r"(?:\{[^}]*\}\s*)*"  # required args (single-line)
        + r"$"
    )

    i = 0
    while i < len(lines):
        # Ignore commented-out begin lines.
        m = begin_re.match(_strip_tex_comment(lines[i]))
        if not m:
            i += 1
            continue
        env = m.group("env")
        # Match end line at start of line (after whitespace); allow trailing comments.
        end_re = re.compile(rf"^\s*\\end\{{{re.escape(env)}\}}\s*(?:%.*)?$")
        start = i
        i += 1
        while i < len(lines) and not end_re.match(lines[i]):
            i += 1
        if i >= len(lines):
            out.append("".join(lines[start:]))
            break
        i += 1
        out.append("".join(lines[start:i]))
    return out


def _detect_revision_context(*, tex: str, extra_context: str, readthrough_md: str) -> dict[str, Any]:
    headers = re.findall(r"\\(?:sub)*section\*?\{([^}]+)\}", tex)
    short_headers = [h.strip() for h in headers if len(h.strip().split()) <= 8]
    starred_header_count = len(re.findall(r"\\(?:sub)*section\*\{", tex))
    response_pair_count = len(
        re.findall(
            r"\\(?:sub)*section\*?\{[^}]*comment[^}]*\}[\s\S]{0,800}?\\(?:sub)*section\*?\{[^}]*response[^}]*\}",
            tex,
            flags=re.I,
        )
    )
    author_reply_count = len(
        re.findall(r"\bwe\s+(?:revised|clarified|added|corrected|updated|expanded)\b", tex, flags=re.I)
    )
    manuscript_marker_count = len(
        re.findall(r"\\(?:sub)*section\*?\{[^}]*(?:manuscript|revision|revised text)[^}]*\}", tex, flags=re.I)
    )
    score = 0
    signals: list[str] = []
    if starred_header_count >= 3 and len(short_headers) >= 3:
        score += 1
        signals.append("multi-section short-header exchange structure")
    if response_pair_count >= 1:
        score += 1
        signals.append("comment-response header pairing")
    if author_reply_count >= 1 and manuscript_marker_count >= 1:
        score += 1
        signals.append("author reply declarations plus manuscript-revision section")
    if re.search(r"\breferee\b|\breviewer\b", tex + "\n" + extra_context + "\n" + readthrough_md, flags=re.I):
        score += 1
        signals.append("review-dialogue role markers")
    mode = "referee_response" if score >= 2 else "paper_revision"
    return {"mode": mode, "signals": signals, "score": score}


def _postprocess_latexdiff_tex(raw: str) -> str:
    text = raw.replace("\r\n", "\n").replace("\r", "\n")
    text = re.sub(
        r"\\definecolor\{DIFADDCOLOR\}\{rgb\}\{[^}]+\}",
        r"\\definecolor{DIFADDCOLOR}{rgb}{0.00,0.45,0.00}",
        text,
    )
    text = re.sub(
        r"\\definecolor\{DIFDELCOLOR\}\{rgb\}\{[^}]+\}",
        r"\\definecolor{DIFDELCOLOR}{rgb}{0.65,0.10,0.10}",
        text,
    )
    if "DIFADDCOLOR" not in text:
        text = text.replace(
            r"\RequirePackage{color}",
            "\\RequirePackage{color}\n\\definecolor{DIFADDCOLOR}{rgb}{0.00,0.45,0.00}\n\\definecolor{DIFDELCOLOR}{rgb}{0.65,0.10,0.10}",
            1,
        )
    text = text.replace(
        r"\providecommand{\DIFadd}[1]{{\protect\color{blue}\uwave{#1}}}",
        r"\providecommand{\DIFadd}[1]{{\protect\color{DIFADDCOLOR}\uwave{#1}}}",
    )
    text = text.replace(
        r"\providecommand{\DIFdel}[1]{{\protect\color{red}\sout{#1}}}",
        r"\providecommand{\DIFdel}[1]{{\protect\color{DIFDELCOLOR}\sout{#1}}}",
    )
    text = text.replace(
        r"\providecommand{\DIFaddbegin}{\color{blue}}",
        r"\providecommand{\DIFaddbegin}{\color{DIFADDCOLOR}}",
    )
    text = text.replace(
        r"\providecommand{\DIFdelbegin}{\color{red}}",
        r"\providecommand{\DIFdelbegin}{\color{DIFDELCOLOR}}",
    )
    return text


def _audit_latexdiff_color_visibility(*, original: str, clean: str, tracked: str) -> list[str]:
    warnings: list[str] = []
    color_change_re = re.compile(r"\\textcolor\{[^}]+\}\{.*?\}", flags=re.S)
    original_colors = color_change_re.findall(original)
    clean_colors = color_change_re.findall(clean)
    if original_colors != clean_colors and not re.search(r"\\DIFadd|\\DIFdel", tracked):
        warnings.append(
            "Colored revision changed between original and clean, but latexdiff markers are not visible inside the colored segment."
        )
    return warnings


def _comment_audit_view(original: str, clean: str) -> str:
    return _comment_annotated_tracked(original, clean)


def _build_latexdiff_artifacts(
    *,
    original_path: Path,
    clean_path: Path,
    original: str,
    clean: str,
    out_dir: Path,
    full_document: bool,
    trace_path: Path | None = None,
) -> dict[str, Any]:
    repair_actions: list[str] = []
    compile_verification = {
        "clean_pdf_verified": False,
        "latexdiff_pdf_verified": False,
        "status": "not_run",
    }
    if not full_document:
        artifact_path = out_dir / "tracked_fragment_audit.tex"
        _write_text(artifact_path, _comment_audit_view(original, clean))
        meta = {
            "status": "audit_only",
            "required": False,
            "valid_tracked_delivery": False,
            "delivery_kind": "fragment_audit_view",
            "artifact_path": str(artifact_path),
            "repair_loop": {
                "required": False,
                "attempted": False,
                "actions": [],
            },
            "compile_verification": compile_verification,
        }
        if trace_path is not None:
            _append_jsonl(
                trace_path,
                {"ts": _utc_now(), "stage": "latexdiff", "event": "fragment_audit_view_written", "artifact_path": str(artifact_path)},
            )
        return meta

    latexdiff_bin = shutil.which("latexdiff")
    if not latexdiff_bin:
        meta = {
            "status": "not_ready",
            "required": True,
            "valid_tracked_delivery": False,
            "delivery_kind": "latexdiff_required",
            "artifact_path": None,
            "repair_loop": {
                "required": True,
                "attempted": False,
                "actions": [],
            },
            "compile_verification": compile_verification,
            "reason": "latexdiff binary not found",
        }
        if trace_path is not None:
            _append_jsonl(trace_path, {"ts": _utc_now(), "stage": "latexdiff", "event": "missing_binary", "binary": "latexdiff"})
        raise LatexdiffDeliveryError("latexdiff binary not found", metadata=meta)

    cmd = [latexdiff_bin, "--type=UNDERLINE", "--encoding=utf8", str(original_path), str(clean_path)]
    if trace_path is not None:
        _append_jsonl(trace_path, {"ts": _utc_now(), "stage": "latexdiff", "event": "run", "cmd": cmd})
    proc = subprocess.run(cmd, text=True, capture_output=True)
    if proc.returncode != 0 or not proc.stdout.strip():
        meta = {
            "status": "not_ready",
            "required": True,
            "valid_tracked_delivery": False,
            "delivery_kind": "latexdiff_required",
            "artifact_path": None,
            "repair_loop": {
                "required": True,
                "attempted": True,
                "actions": [],
            },
            "compile_verification": compile_verification,
            "reason": (
                "latexdiff returned empty output" if proc.returncode == 0 and not proc.stdout.strip() else f"latexdiff failed with exit {proc.returncode}"
            ),
            "command": cmd,
            "stderr_tail": (proc.stderr or "")[-1000:],
        }
        if trace_path is not None:
            _append_jsonl(
                trace_path,
                {
                    "ts": _utc_now(),
                    "stage": "latexdiff",
                    "event": "failed",
                    "exit_code": proc.returncode,
                    "stdout_bytes": len(proc.stdout.encode("utf-8", errors="replace")),
                },
            )
        raise LatexdiffDeliveryError(meta["reason"], metadata=meta)

    tracked = proc.stdout.replace("\r\n", "\n").replace("\r", "\n")
    cooked = _postprocess_latexdiff_tex(tracked)
    if cooked != tracked:
        repair_actions.append("postprocessed latexdiff palette to keep diff colors distinct from author colors")
    visibility_warnings = _audit_latexdiff_color_visibility(original=original, clean=clean, tracked=cooked)
    repair_actions.extend([f"visibility-check: {warning}" for warning in visibility_warnings])

    artifact_path = out_dir / "tracked.tex"
    _write_text(artifact_path, cooked)
    meta = {
        "status": "ready",
        "required": True,
        "valid_tracked_delivery": True,
        "delivery_kind": "latexdiff",
        "artifact_path": str(artifact_path),
        "repair_loop": {
            "required": True,
            "attempted": True,
            "actions": repair_actions or ["latexdiff output accepted without post-processing changes"],
        },
        "compile_verification": compile_verification,
        "visibility_warnings": visibility_warnings,
        "command": cmd,
    }
    if trace_path is not None:
        _append_jsonl(
            trace_path,
            {
                "ts": _utc_now(),
                "stage": "latexdiff",
                "event": "ready",
                "artifact_path": str(artifact_path),
                "repair_actions": repair_actions,
                "visibility_warnings": visibility_warnings,
            },
        )
    return meta


def _build_response_localization_audit(
    *,
    document_mode: str,
    changes_md: str,
    clean_tex: str,
    tracked_tex: str,
    tracked_delivery: dict[str, Any] | None = None,
) -> str:
    lower_changes = changes_md.lower()
    declares_revision = bool(re.search(r"\b(?:revised|clarified|added|corrected|updated|expanded)\b", lower_changes))
    has_anchor = bool(re.search(r"\b(?:section|eq\.?|equation|figure|fig\.|table|appendix|paragraph|line|abstract|introduction|conclusion)\b", lower_changes))
    localization_status = "NOT VERIFIED" if (document_mode == "referee_response" and declares_revision and not has_anchor) else "VERIFIED"
    tracked_status = (tracked_delivery or {}).get("status", "unknown")
    tracked_kind = (tracked_delivery or {}).get("delivery_kind", "unknown")
    clean_pdf_verified = (tracked_delivery or {}).get("compile_verification", {}).get("clean_pdf_verified", False)
    latexdiff_pdf_verified = (tracked_delivery or {}).get("compile_verification", {}).get("latexdiff_pdf_verified", False)
    lines = [
        "# Response Revision Audit",
        "",
        f"- document_mode: {document_mode}",
        f"- localization_status: {localization_status}",
        f"- tracked_delivery_status: {tracked_status}",
        f"- tracked_delivery_kind: {tracked_kind}",
        f"- clean_pdf_verified: {'YES' if clean_pdf_verified else 'NO'}",
        f"- latexdiff_pdf_verified: {'YES' if latexdiff_pdf_verified else 'NO'}",
        "",
        "## Modification declaration mapping",
    ]
    if localization_status == "NOT VERIFIED":
        lines.append("- NOT VERIFIED: revision declarations were found, but no minimal location anchor was detected in changes.md.")
    else:
        lines.append("- VERIFIED: no unlocalized revision declaration was detected by the lightweight audit.")
    lines.extend(
        [
            "",
            "## Correction convergence",
            "- correction-convergence relies on the bounded audit/repair loop plus this audit artifact; no silent fallback success is allowed.",
            "",
            "## Notes",
            f"- clean_tex_bytes: {len(clean_tex.encode('utf-8', errors='replace'))}",
            f"- tracked_tex_bytes: {len(tracked_tex.encode('utf-8', errors='replace'))}",
        ]
    )
    return "\n".join(lines) + "\n"


def _system_prompt_readthrough() -> str:
    return (
        "You are a careful academic advisor. First read the LaTeX draft globally; do NOT rewrite it yet.\n"
        "Priorities: (1) content correctness/precision, (2) logical flow and definitions, (3) English clarity, (4) LaTeX hygiene.\n\n"
        "OUTPUT FORMAT (strict):\n"
        "- Output only tagged blocks; no code fences; no text outside blocks.\n"
        "- Use these exact markers and block names.\n\n"
        "%%__CODEX_BLOCK__READTHROUGH_MD__BEGIN__\n"
        "(global summary: what the draft argues; main contributions; structure; notation inventory; where claims are made)\n"
        "%%__CODEX_BLOCK__READTHROUGH_MD__END__\n\n"
        "%%__CODEX_BLOCK__RISK_FLAGS_MD__BEGIN__\n"
        "(bullet list of high-risk statements: likely wrong/overstated/unsupported; missing citations; ambiguous definitions)\n"
        "%%__CODEX_BLOCK__RISK_FLAGS_MD__END__\n\n"
        "%%__CODEX_BLOCK__GLOBAL_STYLE_NOTES_MD__BEGIN__\n"
        "(style notes to keep consistent: tense, voice, level of formality, notation conventions)\n"
        "%%__CODEX_BLOCK__GLOBAL_STYLE_NOTES_MD__END__\n"
    )


def _system_prompt_writer(
    *,
    full_document: bool,
    is_repair: bool,
    document_mode: str = "paper_revision",
    correction_constraints: list[str] | None = None,
) -> str:
    mode = "REPAIR" if is_repair else "WRITE"
    doc_hint = (
        "FULL-DOCUMENT MODE: You will be given a PREAMBLE (read-only) and a BODY to edit. Output only the edited BODY as CLEAN_BODY_TEX.\n"
        "- CLEAN_BODY_TEX must start with \\begin{document}.\n"
        "- If the input body ends with \\end{document}, CLEAN_BODY_TEX must also end with it.\n"
        "- Do NOT output the preamble; it will be preserved by the tool.\n"
        if full_document
        else "FRAGMENT MODE: You will be given a single LaTeX fragment. Output the complete edited fragment as CLEAN_TEX.\n"
    )
    repair_hint = (
        "You are applying auditor feedback. Minimize new drift; change only what is needed to satisfy the audit and improve correctness/clarity.\n"
        if is_repair
        else ""
    )
    extra_constraints = correction_constraints or []
    constraint_block = ""
    if extra_constraints:
        constraint_block = "TEMPORARY GLOBAL CONSTRAINTS:\n" + "\n".join(f"- {item}" for item in extra_constraints) + "\n\n"
    referee_block = ""
    if document_mode == "referee_response":
        referee_block = (
            "REFEREE-RESPONSE MODE:\n"
            "- Referee comments are read-only; do not rewrite, soften, or paraphrase them.\n"
            "- Only modify author responses and manuscript revision text.\n"
            "- Use evidence-calibrated wording: keep strong statements when the manuscript or provided evidence supports them; strengthen underclaimed text when evidence warrants it; weaken only when evidence is missing, logic overreaches, or cited literature does not support the claim.\n"
            "- Do not add generic caveats or politeness hedges by default.\n"
            "- Localize every modification declaration (for example 'we revised/clarified/added/corrected') to the shortest semantically sufficient place in the manuscript or response.\n"
            "- Preserve author stance; do not weaken author responses by generic smoothing.\n"
            "- Respect correction-convergence: address the current blocker with the smallest sufficient edit and do not introduce fresh drift.\n\n"
        )
    return (
        "You are a senior academic advisor doing a conservative line edit of a LaTeX draft.\n"
        f"STAGE: {mode}.\n\n"
        "PRIORITIES (strict order):\n"
        "1) Correctness/precision of statements (content first).\n"
        "2) Evidence/verification: use an evidence-calibrated claim-strength contract rather than a default conservative style. Keep justified strong statements, strengthen underclaimed statements when supported, and weaken only when evidence is insufficient or logic/literature does not support the wording.\n"
        "3) English writing quality, while preserving meaning and author voice.\n"
        "4) LaTeX formatting (avoid stylistic reformatting unless it improves clarity or prevents confusion).\n\n"
        "HARD CONSTRAINTS:\n"
        "- Do not rename \\label{...} keys; do not break \\ref/\\eqref targets; do not invent citation keys.\n"
        "- Do not edit content inside verbatim-like environments (verbatim, verbatim*, lstlisting, minted, comment) or inline \\verb.\n"
        "- Do not introduce new packages or new global macros unless absolutely necessary; if unavoidable, explain in CHANGES_MD.\n"
        "- Do not change numerical values unless clearly wrong; if uncertain, flag in OPEN_QUESTIONS_MD.\n"
        "- If you add a stronger/new claim that would normally need a citation, either cite an existing key, or phrase conservatively and flag for verification in OPEN_QUESTIONS_MD.\n\n"
        + doc_hint
        + repair_hint
        + referee_block
        + constraint_block
        + "\nOUTPUT FORMAT (strict):\n"
        "- Output only tagged blocks; no code fences; no text outside blocks.\n"
        "- Do NOT include any marker-like lines (%%__CODEX_BLOCK__...) inside the TeX block.\n\n"
        "%%__CODEX_BLOCK__CHANGES_MD__BEGIN__\n"
        "(detailed, structured change list with before/after snippets + rationale; include an Open questions header)\n"
        "%%__CODEX_BLOCK__CHANGES_MD__END__\n\n"
        "%%__CODEX_BLOCK__OPEN_QUESTIONS_MD__BEGIN__\n"
        "(questions that require author confirmation or external verification; may be empty)\n"
        "%%__CODEX_BLOCK__OPEN_QUESTIONS_MD__END__\n\n"
        + (
            "%%__CODEX_BLOCK__CLEAN_BODY_TEX__BEGIN__\n"
            "(edited LaTeX body only)\n"
            "%%__CODEX_BLOCK__CLEAN_BODY_TEX__END__\n"
            if full_document
            else "%%__CODEX_BLOCK__CLEAN_TEX__BEGIN__\n(edited LaTeX fragment)\n%%__CODEX_BLOCK__CLEAN_TEX__END__\n"
        )
    )


def _system_prompt_auditor(*, document_mode: str = "paper_revision") -> str:
    referee_block = ""
    if document_mode == "referee_response":
        referee_block = (
            "REFEREE-RESPONSE MODE CONTRACT:\n"
            "- Referee comments remain read-only.\n"
            "- Audit response localization: every 'we revised/clarified/added/corrected' declaration must be localized to the shortest sufficient manuscript location.\n"
            "- If author replies were weakened by generic politeness or caveat inflation, flag it.\n\n"
        )
    return (
        "You are an independent technical auditor for an academic LaTeX draft.\n"
        "You do NOT rewrite the TeX. You judge correctness/precision, overclaims, missing references, and LaTeX safety risks.\n\n"
        "VERDICT RULE:\n"
        "- If there are blocking correctness/evidence/LaTeX-safety issues introduced or left unresolved, set VERDICT: NOT_READY and list concrete fixes.\n"
        "- Otherwise set VERDICT: READY, but still list non-blocking improvements and verification requests.\n\n"
        "SPECIAL CONTRACT CHECKS:\n"
        "- Run a claim-strength audit: do not treat default hedging as safe. Keep strong claims when evidence supports them; strengthen underclaimed text when the evidence in the draft supports it; weaken only for genuine evidence or logic gaps.\n"
        "- Literature/novelty claim gate: title/abstract/metadata-only checks are insufficient for novelty claims. Require full text evidence or explicitly mark NOT_READY / needs verification.\n"
        "- Correction-convergence: verify that the current edit resolves prior blockers with the smallest sufficient change and does not add new drift.\n"
        "- Author-color versus diff-color contract: author color semantics must remain distinct from latexdiff colors, and colored insertions/deletions must stay visible.\n\n"
        + referee_block
        +
        "IMPORTANT: Provide VERIFICATION_REQUESTS_MD with two sections:\n"
        "1) Derivation & math checks (step-by-step): list key derivations/equations/claims that should be internally verified.\n"
        "   - For each item, COPY the exact TeX excerpt from the candidate (equations + the surrounding defining text) so a separate checker can verify without the whole paper.\n"
        "   - State precisely what must be shown, which identities/assumptions are used, and what would constitute a failure.\n"
        "2) Literature checks: list simple, high-impact statements that should be verified in the literature.\n"
        "   - For each request: quote the statement (or paraphrase precisely), why verification is needed, and suggested search queries / candidate references.\n\n"
        "OUTPUT FORMAT (strict):\n"
        "- Output only tagged blocks; no code fences; no text outside blocks.\n\n"
        "%%__CODEX_BLOCK__AUDIT_MD__BEGIN__\n"
        "VERDICT: READY|NOT_READY\n\n"
        "CLAIM_STRENGTH: PASS|FAIL\n"
        "CLAIM_STRENGTH_REASON: <short reason or N/A>\n"
        "NOVELTY_SUPPORT: FULL_TEXT|METADATA_ONLY|UNSUPPORTED|NA\n"
        "CORRECTION_CONVERGENCE: PASS|FAIL\n\n"
        "## Blockers\n(only if NOT_READY)\n\n"
        "## Non-blocking\n\n"
        "## Evidence & verification\n\n"
        "## LaTeX safety\n\n"
        "## Specific fix instructions\n"
        "%%__CODEX_BLOCK__AUDIT_MD__END__\n\n"
        "%%__CODEX_BLOCK__VERIFICATION_REQUESTS_MD__BEGIN__\n"
        "(may be empty)\n"
        "%%__CODEX_BLOCK__VERIFICATION_REQUESTS_MD__END__\n"
        "\n"
        "Also provide a machine-readable JSON form. Requirements:\n"
        "- Must be valid JSON (no trailing commas, no comments).\n"
        '- \"schema_version\" must be 1.\n'
        "- Each item must have: id, kind, priority, title, excerpt_tex, what_to_verify, failure_condition, queries, candidate_refs.\n"
        "- kind must be one of: derivation_math, literature.\n"
        "- priority must be one of: high, medium, low.\n"
        "\n"
        "%%__CODEX_BLOCK__VERIFICATION_REQUESTS_JSON__BEGIN__\n"
        "{\n"
        '  \"schema_version\": 1,\n'
        '  \"items\": [\n'
        "    {\n"
        '      \"id\": \"VR-001\",\n'
        '      \"kind\": \"derivation_math\",\n'
        '      \"priority\": \"high\",\n'
        '      \"title\": \"short title\",\n'
        '      \"excerpt_tex\": \"(exact TeX excerpt; include surrounding defining text)\",\n'
        '      \"what_to_verify\": \"(what must be shown/confirmed)\",\n'
        '      \"failure_condition\": \"(what would make this wrong)\",\n'
        '      \"queries\": [\"search query 1\", \"search query 2\"],\n'
        '      \"candidate_refs\": [\"optional: arXiv:xxxx.xxxxx\", \"optional: DOI:10...\", \"optional: INSPIRE recid:...\"]\n'
        "    }\n"
        "  ]\n"
        "}\n"
        "%%__CODEX_BLOCK__VERIFICATION_REQUESTS_JSON__END__\n"
    )


def _system_prompt_deep_verifier() -> str:
    return (
        "You are Codex acting as a meticulous physics/mathematics derivation verifier for an academic LaTeX paper.\n"
        "You do NOT rewrite the paper. You only verify the logic of derivations and math/physics statements requested.\n\n"
        "REQUIREMENTS:\n"
        "- NO SKIPPING STEPS: show every non-trivial algebraic/logical step; state exactly which identity/assumption is used.\n"
        "- If a step cannot be verified from the provided excerpt, say so and list the missing definitions/assumptions needed.\n"
        "- If you detect an error/ambiguity, propose the minimal fix and explain why it fixes the issue.\n"
        "- You are running in a read-only sandbox. Do not attempt to create/modify files; use purely logical/algebraic reasoning.\n\n"
        "VERDICT RULE:\n"
        "- If any requested derivation/maths check fails or is unverifiable due to missing information, set VERDICT: NOT_READY.\n"
        "- Otherwise set VERDICT: READY.\n\n"
        "OUTPUT FORMAT (strict):\n"
        "- Output only tagged blocks; no text outside blocks.\n\n"
        "%%__CODEX_BLOCK__DEEP_VERIFICATION_MD__BEGIN__\n"
        "VERDICT: READY|NOT_READY\n\n"
        "## What was checked\n\n"
        "## Step-by-step verification\n\n"
        "## Issues found (if any)\n\n"
        "## Minimal fix instructions\n\n"
        "## Assumptions / required context\n"
        "%%__CODEX_BLOCK__DEEP_VERIFICATION_MD__END__\n"
    )


def _system_prompt_deep_verifier_secondary() -> str:
    return (
        "You are a second, independent physics/mathematics derivation verifier for an academic LaTeX paper.\n"
        "You do NOT rewrite the paper. You only verify the logic of derivations and math/physics statements requested.\n\n"
        "REQUIREMENTS:\n"
        "- NO SKIPPING STEPS: show every non-trivial algebraic/logical step; state exactly which identity/assumption is used.\n"
        "- If a step cannot be verified from the provided excerpt, say so and list the missing definitions/assumptions needed.\n"
        "- If you detect an error/ambiguity, propose the minimal fix and explain why it fixes the issue.\n\n"
        "VERDICT RULE:\n"
        "- If any requested derivation/maths check fails or is unverifiable due to missing information, set VERDICT: NOT_READY.\n"
        "- Otherwise set VERDICT: READY.\n\n"
        "OUTPUT FORMAT (strict):\n"
        "- Output only tagged blocks; no text outside blocks.\n\n"
        "%%__CODEX_BLOCK__DEEP_VERIFICATION_SECONDARY_MD__BEGIN__\n"
        "VERDICT: READY|NOT_READY\n\n"
        "## What was checked\n\n"
        "## Step-by-step verification\n\n"
        "## Issues found (if any)\n\n"
        "## Minimal fix instructions\n\n"
        "## Assumptions / required context\n"
        "%%__CODEX_BLOCK__DEEP_VERIFICATION_SECONDARY_MD__END__\n"
    )


def _parse_verdict_line(text: str, *, label: str) -> str:
    first = ""
    for ln in text.splitlines():
        if ln.strip():
            first = ln.strip()
            break
    # Be tolerant to harmless trailing text, but keep the contract strict-ish.
    if first.startswith("VERDICT: READY"):
        return "READY"
    if first.startswith("VERDICT: NOT_READY"):
        return "NOT_READY"
    raise ValueError(f"{label} first line must start with VERDICT: READY|NOT_READY, got: {first!r}")


def _parse_verdict(audit_md: str) -> str:
    return _parse_verdict_line(audit_md, label="audit.md")


def _extract_status_value(text: str, key: str) -> str | None:
    pat = re.compile(rf"^\s*{re.escape(key)}\s*:\s*(.+?)\s*$", flags=re.M)
    m = pat.search(text)
    return m.group(1).strip() if m else None


def _collect_contract_blockers(
    *,
    document_mode: str,
    audit_md: str,
    response_revision_audit_md: str,
    tracked_delivery: dict[str, Any],
) -> list[str]:
    blockers: list[str] = []
    required_contract_fields = {
        "CLAIM_STRENGTH": {"PASS", "FAIL"},
        "NOVELTY_SUPPORT": {"FULL_TEXT", "METADATA_ONLY", "UNSUPPORTED", "NA"},
        "CORRECTION_CONVERGENCE": {"PASS", "FAIL"},
    }
    if tracked_delivery.get("required") and tracked_delivery.get("status") == "not_ready":
        blockers.append("Full-document tracked delivery requires a real latexdiff artifact. comment-only fallback is forbidden.")

    response_localization = _extract_status_value(response_revision_audit_md, "localization_status")
    if document_mode == "referee_response" and response_localization != "VERIFIED":
        blockers.append("Response localization audit is not VERIFIED; referee-response runs cannot converge until every revision declaration is localized.")

    contract_values: dict[str, str | None] = {}
    for key, legal_values in required_contract_fields.items():
        value = _extract_status_value(audit_md, key)
        contract_values[key] = value
        if value is None:
            blockers.append(f"Missing required audit contract field: {key}.")
            continue
        if value not in legal_values:
            blockers.append(f"Illegal value for required audit contract field {key}: {value}.")

    novelty_support = _extract_status_value(audit_md, "NOVELTY_SUPPORT")
    if contract_values.get("NOVELTY_SUPPORT") == "METADATA_ONLY":
        blockers.append("Novelty support is metadata-only; full-text evidence is required for novelty claims.")
    elif contract_values.get("NOVELTY_SUPPORT") == "UNSUPPORTED":
        blockers.append("Novelty claim is unsupported by the cited full-text evidence.")

    if contract_values.get("CLAIM_STRENGTH") == "FAIL":
        reason = _extract_status_value(audit_md, "CLAIM_STRENGTH_REASON")
        blockers.append(
            f"Claim-strength audit failed{': ' + reason if reason else ''}."
        )

    if contract_values.get("CORRECTION_CONVERGENCE") == "FAIL":
        blockers.append("Correction-convergence failed: the current revision did not resolve blockers with the smallest sufficient edit.")
    return blockers


def _force_audit_not_ready(audit_md: str, *, reasons: list[str]) -> str:
    if not reasons:
        return audit_md
    lines = audit_md.splitlines()
    for idx, ln in enumerate(lines):
        if ln.strip():
            lines[idx] = "VERDICT: NOT_READY"
            break
    body = "\n".join(lines).rstrip() + "\n\n## Tool contract blockers\n\n"
    body += "\n".join(f"- {reason}" for reason in reasons) + "\n"
    return body


def _diff_contains_math_changes(diff: str) -> bool:
    """
    Best-effort heuristic: detect whether a unified diff touches mathy LaTeX.

    We intentionally keep this conservative (false positives are acceptable)
    because the consequence is only a warning in fast/no-verify mode.
    """
    # Avoid a bare "$" token: it causes too many false positives (currency, shell, etc.).
    math_re = re.compile(
        r"\$[^$]+\$"  # inline $...$
        r"|\$\$"  # display $$
        r"|\\[\(\)\[\]]"  # \( \) \[ \]
        r"|\\begin\{(?:equation\*?|align\*?|gather\*?|multline\*?|eqnarray\*?)\}"
        r"|\\end\{(?:equation\*?|align\*?|gather\*?|multline\*?|eqnarray\*?)\}"
        r"|\\(?:frac|sqrt|sum|int|partial|nabla|mathrm|mathcal|mathbb|mathbf|left|right|cdot|times|pm|equiv|approx|sim|propto)\b"
    )
    for ln in diff.splitlines():
        if not ln:
            continue
        if ln.startswith(("--- ", "+++ ", "@@")):
            continue
        if not (ln.startswith("+") or ln.startswith("-")):
            continue
        # Ignore file header-like lines (already excluded above).
        content = ln[1:]
        if math_re.search(content):
            return True
    return False


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--in", dest="input_tex", type=Path, required=True, help="Path to input .tex file")
    ap.add_argument(
        "--out-dir",
        type=Path,
        default=None,
        help="Output directory (default: <input_dir>/paper_reviser_edits/<run-id>)",
    )
    ap.add_argument("--run-id", type=str, default=None, help="Run id (default: UTC timestamp)")
    ap.add_argument("--encoding", type=str, default="utf-8", help="Input encoding (default: utf-8)")

    ap.add_argument("--run-models", action="store_true", help="Call local Claude+Gemini CLIs via runner scripts")
    ap.add_argument("--stub-models", action="store_true", help="Use deterministic stubs (no external model calls)")
    ap.add_argument("--dry-run", action="store_true", help="Write run.json + deterministic checks only; do not call models")

    ap.add_argument("--writer-backend", choices=list(BACKEND_FAMILIES), default="claude", help="Backend for writer/read-through (default: claude)")
    ap.add_argument("--writer-model", type=str, default="", help="Model name/alias for the writer backend (required with --run-models)")
    ap.add_argument("--auditor-backend", choices=list(BACKEND_FAMILIES), default="gemini", help="Backend for auditor, independent of the writer (default: gemini)")
    ap.add_argument("--auditor-model", type=str, default="", help="Model name/alias for the auditor backend (required with --run-models)")
    ap.add_argument("--fallback-auditor", choices=["off", *BACKEND_FAMILIES], default="off", help="Optional fallback auditor backend if the primary auditor returns malformed/empty output (default: off)")
    ap.add_argument(
        "--fallback-auditor-model",
        type=str,
        default="",
        help="Model to use if --fallback-auditor triggers (default: --writer-model when --fallback-auditor matches --writer-backend, e.g. both claude)",
    )

    ap.set_defaults(codex_verify=True)
    ap.add_argument("--codex-verify", dest="codex_verify", action="store_true", help="Run Codex deep derivation verifier")
    ap.add_argument("--no-codex-verify", dest="codex_verify", action="store_false", help="Disable Codex deep derivation verifier")
    ap.add_argument(
        "--mode",
        choices=["full", "fast"],
        default="full",
        help=(
            "Execution mode: full (default) runs deep derivation/maths verification; "
            "fast skips deep derivation/maths verification (still runs writer + auditor)."
        ),
    )
    ap.add_argument("--codex-model", type=str, default="", help="Optional Codex model override (default: Codex CLI config default)")
    ap.add_argument(
        "--codex-config",
        action="append",
        default=[],
        help="Optional Codex CLI config override (repeatable). Passed as: codex exec -c <key=value>.",
    )
    ap.add_argument(
        "--codex-timeout-seconds",
        type=int,
        default=900,
        help="Hard timeout (seconds) for codex deep verifier subprocess (default: 900)",
    )
    ap.add_argument(
        "--codex-timeout-policy",
        choices=["stub", "allow-secondary", "fail"],
        default="stub",
        help=(
            "Timeout handling for codex deep verifier: "
            "stub (emit NOT_READY stub), allow-secondary (accept secondary verifier if READY), fail (fatal error)."
        ),
    )
    ap.add_argument(
        "--secondary-deep-verify-backend",
        choices=["off", *BACKEND_FAMILIES],
        default="off",
        help="Optional secondary deep verifier backend (default: off)",
    )
    ap.add_argument(
        "--secondary-deep-verify-model",
        type=str,
        default="",
        help="Model name/alias for the secondary deep verifier (required if --secondary-deep-verify-backend is not off)",
    )

    ap.add_argument("--max-input-tokens-est", type=int, default=60000)
    ap.add_argument("--max-prompt-tokens-est", type=int, default=120000)
    ap.add_argument("--max-rounds", type=int, default=1, help="Max audit->repair cycles")
    ap.add_argument("--min-clean-size-ratio", type=float, default=0.85)
    ap.add_argument("--fail-on-label-removal", action="store_true")

    ap.add_argument("--context-file", type=Path, default=None, help="Optional extra context appended to writer prompts")
    ap.add_argument(
        "--context-dir",
        type=Path,
        default=None,
        help="Optional directory of extra context files (*.md/*.txt) appended to writer prompts (deterministic name-sorted).",
    )
    ap.add_argument("--claude-runner", type=Path, default=None)
    ap.add_argument("--gemini-runner", type=Path, default=None)
    ap.add_argument("--force", action="store_true", help="Overwrite existing out dir")

    args = ap.parse_args()

    if args.codex_timeout_seconds < 1:
        print("ERROR: --codex-timeout-seconds must be >= 1", file=sys.stderr)
        return 2

    input_path = args.input_tex.expanduser().resolve()
    if not input_path.is_file():
        print(f"ERROR: --in not found: {input_path}", file=sys.stderr)
        return 2

    run_id = args.run_id or datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    out_dir = args.out_dir.expanduser().resolve() if args.out_dir else (input_path.parent / "paper_reviser_edits" / run_id)

    if out_dir.exists():
        if not args.force:
            print(f"ERROR: out dir exists (use --force): {out_dir}", file=sys.stderr)
            return 2
        shutil.rmtree(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    trace_path = out_dir / "trace.jsonl"
    run_path = out_dir / "run.json"
    timestamp_start = _utc_now()

    fatal_errors: list[str] = []
    warnings: list[str] = []

    # Apply mode presets early (before validation / dry-run). In fast mode we
    # intentionally skip derivation/maths verification for speed.
    if args.mode == "fast":
        # Treat explicit conflicting flags as an error (avoid surprising silent overrides).
        if "--codex-verify" in sys.argv:
            print("ERROR: --mode fast is incompatible with --codex-verify; use --mode full", file=sys.stderr)
            return 2
        if "--secondary-deep-verify-backend" in sys.argv and str(args.secondary_deep_verify_backend) != "off":
            print(
                "ERROR: --mode fast is incompatible with --secondary-deep-verify-backend (must be off); use --mode full",
                file=sys.stderr,
            )
            return 2

        if args.codex_verify:
            warnings.append("mode=fast: deep derivation/maths verification disabled (--no-codex-verify implied)")
        args.codex_verify = False
        if str(args.secondary_deep_verify_backend) != "off":
            warnings.append("mode=fast: overriding --secondary-deep-verify-backend to off")
            args.secondary_deep_verify_backend = "off"
            args.secondary_deep_verify_model = ""

    input_bytes = input_path.read_bytes()
    input_bytes_sha = _sha256_bytes(input_bytes)

    try:
        original_tex = _read_text(input_path, encoding=args.encoding)
    except Exception as exc:
        fatal_errors.append(str(exc))
        _write_json(
            run_path,
            {
                "schema_version": 1,
                "timestamp_start": timestamp_start,
                "timestamp_end": _utc_now(),
                "input_path": str(input_path),
                "input_bytes_sha256": input_bytes_sha,
                "encoding": args.encoding,
                "warnings": warnings,
                "fatal_errors": fatal_errors,
                "exit_status": 2,
            },
        )
        return 2

    collisions = _preflight_marker_collision(original_tex)
    if collisions:
        fatal_errors.append(
            "marker-collision lines found in input: " + repr(collisions[:3]) + (" (more...)" if len(collisions) > 3 else "")
        )
        _write_json(
            run_path,
            {
                "schema_version": 1,
                "timestamp_start": timestamp_start,
                "timestamp_end": _utc_now(),
                "input_path": str(input_path),
                "input_bytes_sha256": input_bytes_sha,
                "original_tex_sha256": _sha256_text(original_tex),
                "encoding": args.encoding,
                "warnings": warnings,
                "fatal_errors": fatal_errors,
                "exit_status": 2,
            },
        )
        return 2

    input_tokens_est = _estimate_tokens_est(original_tex)
    if input_tokens_est > args.max_input_tokens_est:
        fatal_errors.append(
            f"input too large: tokens_est={input_tokens_est} exceeds --max-input-tokens-est={args.max_input_tokens_est}"
        )
        _write_json(
            run_path,
            {
                "schema_version": 1,
                "timestamp_start": timestamp_start,
                "timestamp_end": _utc_now(),
                "input_path": str(input_path),
                "input_bytes_sha256": input_bytes_sha,
                "original_tex_sha256": _sha256_text(original_tex),
                "encoding": args.encoding,
                "warnings": warnings,
                "fatal_errors": fatal_errors,
                "exit_status": 2,
            },
        )
        return 2

    begin_doc_pos = _find_uncommented_begin_document(original_tex)
    full_document = begin_doc_pos is not None
    preamble_tex = original_tex[:begin_doc_pos] if full_document else ""
    body_tex = original_tex[begin_doc_pos:] if full_document else original_tex

    _write_text(out_dir / "original.tex", original_tex)

    if args.dry_run:
        _write_json(
            run_path,
            {
                "schema_version": 1,
                "timestamp_start": timestamp_start,
                "timestamp_end": _utc_now(),
                "input_path": str(input_path),
                "input_bytes_sha256": input_bytes_sha,
                "original_tex_sha256": _sha256_text(original_tex),
                "encoding": args.encoding,
                "mode": str(args.mode),
                "models": {
                    "writer": {"backend": args.writer_backend, "model": args.writer_model},
                    "auditor": {"backend": args.auditor_backend, "model": args.auditor_model},
                    "deep_verifier": {
                        "backend": "codex",
                        "enabled": bool(args.codex_verify),
                        "model": (str(args.codex_model) or None),
                        "config_overrides": [str(x) for x in (args.codex_config or [])],
                        "timeout_seconds": int(args.codex_timeout_seconds),
                        "timeout_policy": str(args.codex_timeout_policy),
                    },
                },
                "full_document": full_document,
                "tracked_delivery": {
                    "status": ("not_ready" if full_document else "audit_only"),
                    "required": bool(full_document),
                    "valid_tracked_delivery": False,
                    "delivery_kind": ("latexdiff_required" if full_document else "fragment_audit_view"),
                    "artifact_path": None,
                },
                "warnings": warnings,
                "fatal_errors": fatal_errors,
                "exit_status": 0,
            },
        )
        return 0

    if args.run_models and args.stub_models:
        print("ERROR: choose only one of --run-models or --stub-models", file=sys.stderr)
        return 2
    if not args.run_models and not args.stub_models:
        print("ERROR: pass --run-models or --stub-models (or --dry-run)", file=sys.stderr)
        return 2
    if args.run_models:
        if not str(args.writer_model).strip():
            print("ERROR: --writer-model is required with --run-models", file=sys.stderr)
            return 2
        if not str(args.auditor_model).strip():
            print("ERROR: --auditor-model is required with --run-models", file=sys.stderr)
            return 2
        if str(args.secondary_deep_verify_backend) != "off" and not str(args.secondary_deep_verify_model).strip():
            print(
                "ERROR: --secondary-deep-verify-model is required when --secondary-deep-verify-backend is not off",
                file=sys.stderr,
            )
            return 2

    # Resolve one runner per backend family. claude/gemini keep dedicated override
    # flags (--claude-runner/--gemini-runner) for back-compat; every other family is
    # auto-detected via the same sibling-skills probe. Explicit overrides win.
    runner_overrides: dict[str, Path | None] = {
        "claude": (args.claude_runner.expanduser().resolve() if args.claude_runner else _resolve_family_runner("claude")),
        "gemini": (args.gemini_runner.expanduser().resolve() if args.gemini_runner else _resolve_family_runner("gemini")),
    }

    # claude + gemini remain always-required (the default writer/auditor pair, and
    # the historical contract), plus any additional family actually selected by the
    # chosen writer/auditor/fallback/secondary backends.
    required_families: set[str] = {"claude", "gemini"}
    required_families.add(str(args.writer_backend))
    required_families.add(str(args.auditor_backend))
    if str(args.fallback_auditor) != "off":
        required_families.add(str(args.fallback_auditor))
    if str(args.secondary_deep_verify_backend) != "off":
        required_families.add(str(args.secondary_deep_verify_backend))

    runners: dict[str, Path] = {}
    for family in sorted(required_families):
        resolved = runner_overrides.get(family)
        if resolved is None:
            resolved = _resolve_family_runner(family)
        if resolved is None or not resolved.is_file():
            hint = f"; set --{family}-runner" if family in ("claude", "gemini") else ""
            print(f"ERROR: {family} runner not found{hint}", file=sys.stderr)
            return 2
        runners[family] = resolved

    cfg = ModelConfig(
        writer_backend=str(args.writer_backend),
        writer_model=str(args.writer_model),
        auditor_backend=str(args.auditor_backend),
        auditor_model=str(args.auditor_model),
        runners=runners,
        fallback_auditor=str(args.fallback_auditor),
        fallback_auditor_model=str(args.fallback_auditor_model),
        codex_model=str(args.codex_model),
        codex_verify=bool(args.codex_verify),
        codex_config_overrides=tuple(str(x) for x in (args.codex_config or [])),
    )

    extra_context_parts: list[str] = []
    context_file_meta: dict[str, Any] | None = None
    context_dir_meta: dict[str, Any] | None = None
    context_files_meta: list[dict[str, Any]] = []

    def read_context_file(p: Path) -> tuple[str, dict[str, Any]]:
        txt = p.read_text(encoding="utf-8", errors="replace")
        meta = {
            "name": p.name,
            "path": str(p),
            "bytes": p.stat().st_size,
            "sha256": _sha256_file(p),
            "text_sha256": _sha256_text(txt),
        }
        return txt, meta

    if args.context_file is not None:
        ctx_path = args.context_file.expanduser().resolve()
        if not ctx_path.is_file():
            print(f"ERROR: --context-file not found: {ctx_path}", file=sys.stderr)
            return 2
        txt, meta = read_context_file(ctx_path)
        extra_context_parts.append(f"### Context file: {ctx_path.name}\n\n{txt}")
        context_file_meta = meta
        context_files_meta.append(meta)

    if args.context_dir is not None:
        dir_path = args.context_dir.expanduser().resolve()
        if not dir_path.is_dir():
            print(f"ERROR: --context-dir not found or not a directory: {dir_path}", file=sys.stderr)
            return 2
        ctx_files = sorted(
            [p for p in dir_path.iterdir() if p.is_file() and p.suffix.lower() in {".md", ".txt"} and not p.name.startswith(".")],
            key=lambda p: p.name.lower(),
        )
        context_dir_meta = {
            "path": str(dir_path),
            "file_count": len(ctx_files),
            "included_suffixes": [".md", ".txt"],
        }
        for p in ctx_files:
            txt, meta = read_context_file(p)
            extra_context_parts.append(f"### Context dir file: {p.name}\n\n{txt}")
            context_files_meta.append(meta)

    extra_context = "\n\n---\n\n".join(extra_context_parts)

    prompts_dir = out_dir / "prompts"
    raw_dir = out_dir / "raw"
    prompts_dir.mkdir(parents=True, exist_ok=True)
    raw_dir.mkdir(parents=True, exist_ok=True)

    def write_prompt(stage: str, *, system: str, user: str) -> tuple[Path, Path]:
        sys_path = prompts_dir / f"{stage}_system.txt"
        user_path = prompts_dir / f"{stage}_prompt.txt"
        _write_text(sys_path, system)
        _write_text(user_path, user)
        prompt_blob = system + "\n\n" + user
        tokens_est = _estimate_tokens_est(prompt_blob)
        _append_jsonl(
            trace_path,
            {
                "ts": _utc_now(),
                "stage": stage,
                "event": "prompt_guard",
                "tokens_est": tokens_est,
                "max": args.max_prompt_tokens_est,
                "system_sha256": _sha256_file(sys_path),
                "user_sha256": _sha256_file(user_path),
            },
        )
        if tokens_est > args.max_prompt_tokens_est:
            raise RuntimeError(
                f"prompt too large for stage={stage}: tokens_est={tokens_est} exceeds --max-prompt-tokens-est={args.max_prompt_tokens_est}"
            )
        return sys_path, user_path

    # Stage 1: read-through.
    if args.stub_models:
        readthrough_md = "# Read-through (stub)\n\n- Stub mode: no model calls.\n"
        risk_flags_md = ""
        style_notes_md = ""
    else:
        stage = "readthrough"
        sys_txt = _system_prompt_readthrough()
        user_txt = f"INPUT FILE: {input_path.name}\n\n{original_tex}"
        sys_path, user_path = write_prompt(stage, system=sys_txt, user=user_txt)
        out_raw = raw_dir / f"{stage}_{cfg.writer_backend}.txt"
        code = _run_backend(
            backend=cfg.writer_backend,
            runners=cfg.runners,
            model=cfg.writer_model,
            system_prompt_file=sys_path,
            prompt_file=user_path,
            out_file=out_raw,
            trace_path=trace_path,
            stage=stage,
        )
        raw_text = out_raw.read_text(encoding="utf-8", errors="replace") if out_raw.exists() else ""
        if code != 0 or not raw_text.strip():
            fatal_errors.append(f"stage {stage} failed (exit {code})")
            _write_text(out_dir / f"raw_{stage}.txt", raw_text)
            _write_json(
                run_path,
                {
                    "schema_version": 1,
                    "timestamp_start": timestamp_start,
                    "timestamp_end": _utc_now(),
                    "input_path": str(input_path),
                    "input_bytes_sha256": input_bytes_sha,
                    "original_tex_sha256": _sha256_text(original_tex),
                    "encoding": args.encoding,
                    "warnings": warnings,
                    "fatal_errors": fatal_errors,
                    "exit_status": 2,
                },
            )
            return 2
        try:
            readthrough_md = _extract_block(raw_text, name="READTHROUGH_MD")
            risk_flags_md = _extract_block(raw_text, name="RISK_FLAGS_MD")
            style_notes_md = _extract_block(raw_text, name="GLOBAL_STYLE_NOTES_MD")
        except Exception as exc:
            fatal_errors.append(f"stage {stage} parse error: {exc}")
            _write_text(out_dir / f"raw_{stage}.txt", raw_text)
            _write_json(
                run_path,
                {
                    "schema_version": 1,
                    "timestamp_start": timestamp_start,
                    "timestamp_end": _utc_now(),
                    "input_path": str(input_path),
                    "input_bytes_sha256": input_bytes_sha,
                    "original_tex_sha256": _sha256_text(original_tex),
                    "encoding": args.encoding,
                    "warnings": warnings,
                    "fatal_errors": fatal_errors,
                    "exit_status": 2,
                },
            )
            return 2

    _write_text(out_dir / "readthrough.md", readthrough_md)
    _write_text(out_dir / "risk_flags.md", risk_flags_md)
    _write_text(out_dir / "global_style_notes.md", style_notes_md)

    revision_context = _detect_revision_context(tex=original_tex, extra_context=extra_context, readthrough_md=readthrough_md)
    document_mode = str(revision_context["mode"])
    correction_constraints: list[str] = []
    if document_mode == "referee_response":
        correction_constraints.append("Do not weaken author responses by generic politeness smoothing.")

    tracked_delivery_meta: dict[str, Any] = {
        "status": "unknown",
        "required": bool(full_document),
        "valid_tracked_delivery": False,
        "delivery_kind": ("latexdiff_required" if full_document else "fragment_audit_view"),
        "artifact_path": None,
        "repair_loop": {"required": bool(full_document), "attempted": False, "actions": []},
        "compile_verification": {
            "clean_pdf_verified": False,
            "latexdiff_pdf_verified": False,
            "status": "not_run",
        },
    }
    response_revision_audit_path = out_dir / "response_revision_audit.md"

    def run_writer(
        stage: str,
        *,
        is_repair: bool,
        input_tex_for_prompt: str,
        current_clean_tex: str | None,
        current_audit_md: str | None,
        current_deep_verification_md: str | None,
    ) -> tuple[str, str, str]:
        if args.stub_models:
            changes_md = "# Changes (stub)\n\n- Stub mode: no changes.\n\n## Open questions\n\n(none)\n"
            open_q = ""
            return input_tex_for_prompt, changes_md, open_q

        sys_txt = _system_prompt_writer(
            full_document=full_document,
            is_repair=is_repair,
            document_mode=document_mode,
            correction_constraints=correction_constraints,
        )

        parts: list[str] = []
        parts.append(f"FILE: {input_path.name}\n")
        parts.append("## Read-through summary (stage 1)\n" + readthrough_md + "\n")
        if style_notes_md.strip():
            parts.append("## Global style notes\n" + style_notes_md + "\n")
        if extra_context.strip():
            parts.append("## Extra context (evidence/notes; read-only)\n" + extra_context + "\n")
        if is_repair and current_audit_md:
            parts.append("## Auditor report (must address)\n" + current_audit_md + "\n")
        if is_repair and response_revision_audit_path.is_file():
            parts.append(
                "## Response revision audit (must address)\n"
                + response_revision_audit_path.read_text(encoding="utf-8", errors="replace")
                + "\n"
            )
        if is_repair and current_deep_verification_md:
            parts.append("## Deep derivation verification (must address)\n" + current_deep_verification_md + "\n")
        if is_repair and current_clean_tex and current_clean_tex.strip() != input_tex_for_prompt.strip():
            parts.append("## Current candidate (for repair)\n" + current_clean_tex + "\n")

        if full_document:
            parts.append("## PREAMBLE (read-only; do NOT output)\n" + preamble_tex + "\n")
            parts.append("## BODY TO EDIT (must output as CLEAN_BODY_TEX)\n" + input_tex_for_prompt + "\n")
        else:
            parts.append("## INPUT TEX (must output as CLEAN_TEX)\n" + input_tex_for_prompt + "\n")

        user_txt = "\n".join(parts)
        sys_path, user_path = write_prompt(stage, system=sys_txt, user=user_txt)
        out_raw = raw_dir / f"{stage}_{cfg.writer_backend}.txt"
        code = _run_backend(
            backend=cfg.writer_backend,
            runners=cfg.runners,
            model=cfg.writer_model,
            system_prompt_file=sys_path,
            prompt_file=user_path,
            out_file=out_raw,
            trace_path=trace_path,
            stage=stage,
        )
        raw_text = out_raw.read_text(encoding="utf-8", errors="replace") if out_raw.exists() else ""
        if code != 0 or not raw_text.strip():
            raise RuntimeError(f"stage {stage} failed (exit {code})")

        changes_md = _extract_block(raw_text, name="CHANGES_MD")
        open_q = _extract_block(raw_text, name="OPEN_QUESTIONS_MD")
        if full_document:
            clean_body = _extract_block(raw_text, name="CLEAN_BODY_TEX")
            return clean_body, changes_md, open_q
        clean_tex = _extract_block(raw_text, name="CLEAN_TEX")
        return clean_tex, changes_md, open_q

    def write_candidate_artifacts(*, original: str, clean: str, changes_md: str, open_q: str) -> None:
        diff = _unified_diff(original, clean)

        tool_notes: list[str] = []
        if args.mode == "fast":
            tool_notes.append("This run used --mode fast: deep derivation/maths verification was skipped.")
        elif not cfg.codex_verify:
            tool_notes.append("Deep derivation/maths verification was skipped (--no-codex-verify).")

        if not cfg.codex_verify and _diff_contains_math_changes(diff):
            msg = "math edits detected while deep derivation/maths verification is disabled; consider re-running with --mode full"
            warnings.append(msg)
            tool_notes.append("WARNING: Math edits detected while deep verification is disabled. Consider re-running with --mode full.")

        if tool_notes:
            notes = "\n".join(f"- {n}" for n in tool_notes)
            header = "## Tool notes"
            if header in changes_md:
                # Append a second bullet list to the existing section (do not duplicate header).
                changes_md = changes_md.rstrip() + "\n\n" + notes + "\n"
            else:
                changes_md = changes_md.rstrip() + "\n\n---\n\n" + header + "\n\n" + notes + "\n"

        _write_text(out_dir / "clean.tex", clean)
        _write_text(out_dir / "changes.md", changes_md)
        _write_text(out_dir / "open_questions.md", open_q)
        _write_text(out_dir / "changes.diff", diff)

        ratio_info = _compute_clean_size_ratio_details(original, clean)
        ratio = float(ratio_info["effective_ratio"])
        if ratio < args.min_clean_size_ratio:
            raise RuntimeError(
                "clean.tex suspiciously short: "
                f"effective_ratio={ratio:.3f} (raw_ratio={float(ratio_info['raw_ratio']):.3f}, "
                f"non_comment_ratio={float(ratio_info['non_comment_ratio']):.3f}) "
                f"< --min-clean-size-ratio={args.min_clean_size_ratio}"
            )
        if (
            float(ratio_info["raw_ratio"]) < args.min_clean_size_ratio
            and float(ratio_info["non_comment_ratio"]) >= args.min_clean_size_ratio
        ):
            warnings.append(
                "clean-size ratio raw bytes is below threshold, but non-comment bytes passed; "
                "treating shrink as comment-heavy normalization"
            )

        orig_labels = _extract_labels(original)
        new_labels = _extract_labels(clean)
        removed = sorted(orig_labels - new_labels)
        if removed:
            msg = f"labels removed ({len(removed)}): {removed[:10]}" + (" (+more)" if len(removed) > 10 else "")
            if args.fail_on_label_removal:
                raise RuntimeError(msg)
            warnings.append(msg)

        refs = _extract_refs(clean)
        orphans = sorted(refs - new_labels)
        if orphans:
            warnings.append(
                f"orphan ref targets (in this file): {orphans[:10]}" + (" (+more)" if len(orphans) > 10 else "")
            )

        orig_cites = _extract_cite_keys(original)
        new_cites = _extract_cite_keys(clean)
        disappeared = sorted(orig_cites - new_cites)
        appeared = sorted(new_cites - orig_cites)
        if disappeared:
            warnings.append(
                f"citation keys disappeared: {disappeared[:10]}" + (" (+more)" if len(disappeared) > 10 else "")
            )
        if appeared:
            warnings.append(f"new citation keys appeared: {appeared[:10]}" + (" (+more)" if len(appeared) > 10 else ""))

        protected_envs = ["verbatim", "lstlisting", "minted", "comment"]
        if _extract_protected_env_blocks(original, env_names=protected_envs) != _extract_protected_env_blocks(
            clean, env_names=protected_envs
        ):
            raise RuntimeError("protected environment blocks changed (verbatim/lstlisting/minted/comment)")

        nonlocal tracked_delivery_meta
        try:
            tracked_delivery_meta = _build_latexdiff_artifacts(
                original_path=out_dir / "original.tex",
                clean_path=out_dir / "clean.tex",
                original=original,
                clean=clean,
                out_dir=out_dir,
                full_document=full_document,
                trace_path=trace_path,
            )
        except LatexdiffDeliveryError as exc:
            tracked_delivery_meta = exc.metadata
            warnings.append(f"tracked delivery NOT_READY: {exc}")

        tracked_for_audit = ""
        tracked_artifact = tracked_delivery_meta.get("artifact_path")
        if tracked_artifact and Path(str(tracked_artifact)).is_file():
            tracked_for_audit = Path(str(tracked_artifact)).read_text(encoding="utf-8", errors="replace")
        response_audit_md = _build_response_localization_audit(
            document_mode=document_mode,
            changes_md=changes_md,
            clean_tex=clean,
            tracked_tex=tracked_for_audit,
            tracked_delivery=tracked_delivery_meta,
        )
        _write_text(response_revision_audit_path, response_audit_md)

    rounds_completed = 0
    converged = False
    auditor_verdict = ""
    deep_verifier_verdict = ""
    deep_verifier_timed_out = False
    timeout_fallback_note_emitted = False

    # Initial writer pass.
    try:
        writer_tex, changes_md, open_q = run_writer(
            "writer",
            is_repair=False,
            input_tex_for_prompt=(body_tex if full_document else original_tex),
            current_clean_tex=None,
            current_audit_md=None,
            current_deep_verification_md=None,
        )
    except Exception as exc:
        fatal_errors.append(str(exc))
        _write_json(
            run_path,
            {
                "schema_version": 1,
                "timestamp_start": timestamp_start,
                "timestamp_end": _utc_now(),
                "input_path": str(input_path),
                "input_bytes_sha256": input_bytes_sha,
                "original_tex_sha256": _sha256_text(original_tex),
                "encoding": args.encoding,
                "warnings": warnings,
                "fatal_errors": fatal_errors,
                "exit_status": 2,
            },
        )
        return 2

    def validate_and_assemble_writer_output(writer_out: str) -> tuple[str, str]:
        """
        Validate writer output and assemble clean.tex.

        Returns: (clean_tex, next_input_tex_for_prompt)
        - For full documents: writer_out is the BODY (must start with \\begin{document}); clean_tex includes the preserved preamble.
        - For fragments: writer_out is the full fragment; clean_tex is writer_out.
        """
        if not writer_out.strip():
            raise RuntimeError("writer returned empty TeX")

        if not full_document:
            return writer_out, writer_out

        # Guard: first non-empty, non-comment line must contain \begin{document}.
        first = ""
        for ln in writer_out.splitlines():
            if ln.strip() and not ln.lstrip().startswith("%"):
                first = ln.strip()
                break
        if "\\begin{document}" not in first:
            raise RuntimeError("CLEAN_BODY_TEX must start with \\begin{document}")

        if _has_uncommented_end_document(body_tex) and not _has_uncommented_end_document(writer_out):
            raise RuntimeError("CLEAN_BODY_TEX must contain an uncommented \\end{document} (input had one)")

        # Common LaTeX hygiene footguns: packages/classes belong in the preamble, not the body.
        body_cmd_pat = re.compile(r"^\s*\\(documentclass|usepackage)\b")
        for ln in writer_out.splitlines():
            if body_cmd_pat.match(_strip_tex_comment(ln)):
                warnings.append(
                    "preamble-only command appears in CLEAN_BODY_TEX: "
                    + ln.strip()[:120]
                    + " (consider moving to preamble manually)"
                )
                break

        return preamble_tex + writer_out, writer_out

    try:
        current_clean_tex, current_input_tex_for_prompt = validate_and_assemble_writer_output(writer_tex)
    except Exception as exc:
        fatal_errors.append(str(exc))
        _write_json(
            run_path,
            {
                "schema_version": 1,
                "timestamp_start": timestamp_start,
                "timestamp_end": _utc_now(),
                "input_path": str(input_path),
                "input_bytes_sha256": input_bytes_sha,
                "original_tex_sha256": _sha256_text(original_tex),
                "encoding": args.encoding,
                "warnings": warnings,
                "fatal_errors": fatal_errors,
                "exit_status": 2,
            },
        )
        return 2

    try:
        write_candidate_artifacts(original=original_tex, clean=current_clean_tex, changes_md=changes_md, open_q=open_q)
    except Exception as exc:
        fatal_errors.append(str(exc))
        _write_json(
            run_path,
            {
                "schema_version": 1,
                "timestamp_start": timestamp_start,
                "timestamp_end": _utc_now(),
                "input_path": str(input_path),
                "input_bytes_sha256": input_bytes_sha,
                "original_tex_sha256": _sha256_text(original_tex),
                "encoding": args.encoding,
                "warnings": warnings,
                "fatal_errors": fatal_errors,
                "exit_status": 2,
            },
        )
        return 2

    def run_auditor(stage: str, *, previous_audit: str | None) -> tuple[str, str, dict[str, Any], str]:
        if args.stub_models:
            stub_audit = (
                "VERDICT: READY\n\n"
                "CLAIM_STRENGTH: PASS\n"
                "CLAIM_STRENGTH_REASON: N/A\n"
                "NOVELTY_SUPPORT: NA\n"
                "CORRECTION_CONVERGENCE: PASS\n\n"
                "(stub)\n"
            )
            return stub_audit, "", {"schema_version": 1, "items": []}, "READY"

        def parse_auditor_payload(raw_text: str) -> tuple[str, str, dict[str, Any], str]:
            end_only_audit = (
                "%%__CODEX_BLOCK__AUDIT_MD__BEGIN__" not in raw_text
                and "%%__CODEX_BLOCK__AUDIT_MD__END__" in raw_text
            )
            audit_md = _extract_block(raw_text, name="AUDIT_MD", allow_implicit_begin=True)
            if end_only_audit:
                warnings.append("auditor AUDIT_MD BEGIN marker missing; auto-repaired from file start (END-only recovery)")

            verif_md = _extract_block(raw_text, name="VERIFICATION_REQUESTS_MD")

            verif_json_obj: dict[str, Any] = {"schema_version": 1, "items": []}
            try:
                verif_json_txt = _extract_block(raw_text, name="VERIFICATION_REQUESTS_JSON")
                try:
                    parsed = json.loads(verif_json_txt)
                    if isinstance(parsed, dict) and parsed.get("schema_version") == 1 and isinstance(parsed.get("items"), list):
                        verif_json_obj = parsed
                    else:
                        warnings.append("auditor returned VERIFICATION_REQUESTS_JSON but schema is invalid; using empty items")
                        verif_json_obj = {"schema_version": 1, "items": [], "meta": {"note": "invalid_schema"}}
                except Exception as exc:
                    warnings.append(f"auditor VERIFICATION_REQUESTS_JSON parse error: {exc}; using empty items")
                    verif_json_obj = {"schema_version": 1, "items": [], "meta": {"note": "json_parse_error"}}
            except Exception:
                warnings.append("auditor did not return VERIFICATION_REQUESTS_JSON; using empty items")
                verif_json_obj = {"schema_version": 1, "items": [], "meta": {"note": "missing"}}

            verdict = _parse_verdict(audit_md)
            return audit_md, verif_md, verif_json_obj, verdict

        sys_txt = _system_prompt_auditor(document_mode=document_mode)
        parts: list[str] = []
        parts.append(f"FILE: {input_path.name}\n")
        parts.append("## Read-through\n" + readthrough_md + "\n")
        parts.append("## changes.diff\n" + (out_dir / "changes.diff").read_text(encoding="utf-8", errors="replace") + "\n")
        parts.append("## changes.md (writer)\n" + (out_dir / "changes.md").read_text(encoding="utf-8", errors="replace") + "\n")
        parts.append("## Candidate clean.tex\n" + (out_dir / "clean.tex").read_text(encoding="utf-8", errors="replace") + "\n")
        parts.append("## Tracked delivery metadata\n" + json.dumps(tracked_delivery_meta, indent=2, sort_keys=True) + "\n")
        parts.append("## Response revision audit\n" + response_revision_audit_path.read_text(encoding="utf-8", errors="replace") + "\n")
        if previous_audit:
            parts.append("## Previous audit (context)\n" + previous_audit + "\n")
        base_user_txt = "\n".join(parts)

        def run_auditor_once(*, backend: str, model: str, stage_name: str, user_txt: str) -> tuple[int, str]:
            sys_path_local, user_path_local = write_prompt(stage_name, system=sys_txt, user=user_txt)
            out_raw_local = raw_dir / f"{stage_name}_{backend}.txt"
            code = _run_backend(
                backend=backend,
                runners=cfg.runners,
                model=model,
                system_prompt_file=sys_path_local,
                prompt_file=user_path_local,
                out_file=out_raw_local,
                trace_path=trace_path,
                stage=stage_name,
            )
            raw_text_local = out_raw_local.read_text(encoding="utf-8", errors="replace") if out_raw_local.is_file() else ""
            return code, raw_text_local

        def resolve_fallback_model() -> str:
            fallback_model = str(cfg.fallback_auditor_model).strip()
            if fallback_model:
                return fallback_model
            # No explicit fallback model: reuse the writer model only when the
            # fallback backend matches the writer backend (same family/aliases).
            if cfg.fallback_auditor != cfg.writer_backend:
                raise RuntimeError(
                    "fallback auditor requires --fallback-auditor-model when "
                    "--fallback-auditor differs from --writer-backend"
                )
            return cfg.writer_model

        # Non-claude auditor backends get a marker-recovery retry loop (their CLI
        # output can drop/duplicate the tagged-block markers) plus an optional
        # cross-family fallback auditor. The claude backend keeps its single-shot path.
        if cfg.auditor_backend != "claude":
            auditor_backend = cfg.auditor_backend
            last_code = 1
            last_parse_error: Exception | None = None

            for attempt in range(2):
                retrying = attempt > 0
                stage_name = stage if not retrying else f"{stage}_marker_retry"
                user_txt = base_user_txt
                if retrying:
                    user_txt += (
                        "\n\nRETRY (format contract): your previous output had marker issues.\n"
                        "Return ONLY tagged blocks, include every required BEGIN/END marker exactly once.\n"
                    )
                last_code, raw_text = run_auditor_once(
                    backend=auditor_backend,
                    model=cfg.auditor_model,
                    stage_name=stage_name,
                    user_txt=user_txt,
                )
                if not raw_text.strip():
                    if attempt == 0:
                        warnings.append(f"{auditor_backend} auditor failed or empty output (exit {last_code}); retrying once")
                    continue
                try:
                    return parse_auditor_payload(raw_text)
                except Exception as exc:
                    last_parse_error = exc
                    if attempt == 0:
                        warnings.append(f"{auditor_backend} auditor returned malformed blocks; retrying once: {exc}")
                        continue

            if cfg.fallback_auditor != "off":
                fallback_backend = cfg.fallback_auditor
                warnings.append(f"{auditor_backend} auditor malformed/empty after retry; falling back to {fallback_backend} auditor")
                fallback_model = resolve_fallback_model()
                fb_code, fb_raw = run_auditor_once(
                    backend=fallback_backend,
                    model=fallback_model,
                    stage_name=f"{stage}_fallback_{fallback_backend}",
                    user_txt=base_user_txt,
                )
                if not fb_raw.strip():
                    raise RuntimeError(f"fallback auditor failed (exit {fb_code})")
                try:
                    return parse_auditor_payload(fb_raw)
                except Exception as exc:
                    raise RuntimeError(f"fallback auditor parse error: {exc}") from exc

            if last_parse_error is not None:
                raise RuntimeError(f"auditor parse error after retry: {last_parse_error}") from last_parse_error
            raise RuntimeError(f"auditor failed (exit {last_code})")

        code, raw_text = run_auditor_once(
            backend=cfg.auditor_backend,
            model=cfg.auditor_model,
            stage_name=stage,
            user_txt=base_user_txt,
        )
        if not raw_text.strip():
            raise RuntimeError(f"auditor failed (exit {code})")
        return parse_auditor_payload(raw_text)

    def run_deep_verifier(stage: str, *, verif_md: str, previous_report: str | None) -> tuple[str, str]:
        """
        Run a Codex-only deep verifier on derivation/math checks.

        This uses the local `codex` CLI (agent mode) as a third backend.
        We run it in read-only sandbox mode and instruct it not to execute commands.
        """
        nonlocal deep_verifier_timed_out
        if not cfg.codex_verify:
            deep_verifier_timed_out = False
            md = "VERDICT: READY\n\n(skipped: --no-codex-verify)\n"
            return md, "READY"
        if args.stub_models:
            deep_verifier_timed_out = False
            return "VERDICT: READY\n\n(stub)\n", "READY"

        codex_bin = shutil.which("codex")
        if not codex_bin:
            raise RuntimeError("codex CLI not found in PATH (install/configure it or pass --no-codex-verify)")

        sys_txt = _system_prompt_deep_verifier()
        parts: list[str] = []
        parts.append(f"FILE: {input_path.name}\n")
        parts.append(
            "Focus ONLY on derivation & math checks. Ignore literature-search items.\n"
            "If the requests are underspecified, mark NOT_READY and list the missing context precisely.\n"
        )
        parts.append("## VERIFICATION_REQUESTS_MD\n" + verif_md + "\n")
        # Provide the full candidate paper as optional context. This helps when the auditor
        # excerpt is incomplete (missing definitions/assumptions) and enables cross-referencing.
        try:
            clean_tex_ref = (out_dir / "clean.tex").read_text(encoding="utf-8", errors="replace")
            if clean_tex_ref.strip():
                parts.append(
                    "## REFERENCE: clean.tex (current candidate; use only for cross-referencing context)\n"
                    + clean_tex_ref
                    + "\n"
                )
        except Exception:
            # Best-effort; deep verification can still proceed from the quoted excerpts.
            pass
        if previous_report:
            parts.append("## Previous deep verification (context)\n" + previous_report + "\n")
        user_txt = "\n".join(parts)

        sys_path, user_path = write_prompt(stage, system=sys_txt, user=user_txt)

        # Codex CLI does not support separate system/user prompt files; we feed a combined stdin prompt.
        combined_path = prompts_dir / f"{stage}_combined_prompt.txt"
        combined = sys_txt + "\n\n---\n\n" + user_txt
        _write_text(combined_path, combined)

        out_last = raw_dir / f"{stage}_codex_last.txt"
        out_log = raw_dir / f"{stage}_codex.log"

        cmd = [
            codex_bin,
            "exec",
            "--sandbox",
            "read-only",
            "--skip-git-repo-check",
            "--output-last-message",
            str(out_last),
        ]
        if cfg.codex_model.strip():
            cmd.extend(["--model", cfg.codex_model.strip()])
        for ov in cfg.codex_config_overrides:
            if str(ov).strip():
                cmd.extend(["-c", str(ov).strip()])
        cmd.append("-")

        _append_jsonl(
            trace_path,
            {
                "ts": _utc_now(),
                "stage": stage,
                "event": "model_call",
                "cmd": cmd,
                "stdin_path": str(combined_path),
                "stdin_sha256": _sha256_file(combined_path),
            },
        )
        try:
            with combined_path.open("rb") as fin:
                proc = subprocess.run(
                    cmd,
                    check=False,
                    stdin=fin,
                    capture_output=True,
                    text=True,
                    timeout=int(args.codex_timeout_seconds),
                )
        except subprocess.TimeoutExpired as exc:
            deep_verifier_timed_out = True

            def _coerce_text(value: str | bytes | None) -> str:
                if value is None:
                    return ""
                if isinstance(value, bytes):
                    return value.decode("utf-8", errors="replace")
                return value

            timeout_note = (
                f"[timeout] codex deep verifier stage={stage} exceeded "
                f"--codex-timeout-seconds={int(args.codex_timeout_seconds)}"
            )
            _write_text(out_log, _coerce_text(exc.stdout) + _coerce_text(exc.stderr) + "\n" + timeout_note + "\n")
            _append_jsonl(
                trace_path,
                {
                    "ts": _utc_now(),
                    "stage": stage,
                    "event": "model_call_end",
                    "exit_code": None,
                    "timed_out": True,
                    "timeout_seconds": int(args.codex_timeout_seconds),
                },
            )
            warnings.append(
                f"codex deep verifier timed out after {int(args.codex_timeout_seconds)}s at stage={stage} "
                f"(policy={args.codex_timeout_policy})"
            )
            if str(args.codex_timeout_policy) == "fail":
                raise RuntimeError(
                    f"codex deep verifier timed out after {int(args.codex_timeout_seconds)}s; see {out_log}"
                ) from exc

            deep_md = _build_deep_verification_timeout_stub(stage=stage, timeout_seconds=int(args.codex_timeout_seconds))
            return deep_md, "NOT_READY"

        deep_verifier_timed_out = False
        _write_text(out_log, (proc.stdout or "") + (proc.stderr or ""))
        _append_jsonl(
            trace_path,
            {
                "ts": _utc_now(),
                "stage": stage,
                "event": "model_call_end",
                "exit_code": proc.returncode,
                "timed_out": False,
                "timeout_seconds": int(args.codex_timeout_seconds),
            },
        )

        raw_text = out_last.read_text(encoding="utf-8", errors="replace") if out_last.exists() else ""
        if proc.returncode != 0 and not raw_text.strip():
            raise RuntimeError(f"codex deep verifier failed (exit {proc.returncode}); see {out_log}")
        if not raw_text.strip():
            raise RuntimeError(f"codex deep verifier returned empty output; see {out_log}")

        deep_md = _extract_block(raw_text, name="DEEP_VERIFICATION_MD")
        deep_verdict = _parse_verdict_line(deep_md, label="deep_verification.md")
        return deep_md, deep_verdict

    def run_secondary_deep_verifier(stage: str, *, verif_md: str, previous_report: str | None) -> tuple[str, str]:
        """
        Optional secondary deep verifier (Claude or Gemini), for redundancy.
        """
        backend = str(args.secondary_deep_verify_backend)
        if backend == "off":
            return "", "READY"
        if args.stub_models:
            return "VERDICT: READY\n\n(stub)\n", "READY"

        sys_txt = _system_prompt_deep_verifier_secondary()
        parts: list[str] = []
        parts.append(f"FILE: {input_path.name}\n")
        parts.append(
            "Focus ONLY on derivation & math checks. Ignore literature-search items.\n"
            "If the requests are underspecified, mark NOT_READY and list the missing context precisely.\n"
        )
        parts.append("## VERIFICATION_REQUESTS_MD\n" + verif_md + "\n")
        try:
            clean_tex_ref = (out_dir / "clean.tex").read_text(encoding="utf-8", errors="replace")
            if clean_tex_ref.strip():
                parts.append(
                    "## REFERENCE: clean.tex (current candidate; use only for cross-referencing context)\n"
                    + clean_tex_ref
                    + "\n"
                )
        except Exception:
            pass
        if previous_report:
            parts.append("## Previous secondary deep verification (context)\n" + previous_report + "\n")
        user_txt = "\n".join(parts)

        sys_path, user_path = write_prompt(stage, system=sys_txt, user=user_txt)
        out_raw = raw_dir / f"{stage}_{backend}.txt"

        # Retry once on failure for non-claude backends, similar to the auditor path.
        last_code = 1
        attempts = 1 if backend == "claude" else 2
        for attempt in range(attempts):
            last_code = _run_backend(
                backend=backend,
                runners=cfg.runners,
                model=str(args.secondary_deep_verify_model),
                system_prompt_file=sys_path,
                prompt_file=user_path,
                out_file=out_raw,
                trace_path=trace_path,
                stage=stage,
            )
            if out_raw.is_file() and out_raw.read_text(encoding="utf-8", errors="replace").strip():
                break
            if attempt == 0 and attempts > 1:
                warnings.append(f"secondary deep verifier ({backend}) failed (exit {last_code}); retrying once")

        raw_text = out_raw.read_text(encoding="utf-8", errors="replace") if out_raw.exists() else ""
        if not raw_text.strip():
            raise RuntimeError(f"secondary deep verifier failed (exit {last_code})")

        sec_md = _extract_block(raw_text, name="DEEP_VERIFICATION_SECONDARY_MD")
        sec_verdict = _parse_verdict_line(sec_md, label="deep_verification_secondary.md")
        return sec_md, sec_verdict

    try:
        audit_md, verif_md, verif_json_obj, verdict = run_auditor("auditor", previous_audit=None)
    except Exception as exc:
        fatal_errors.append(str(exc))
        _write_json(
            run_path,
            {
                "schema_version": 1,
                "timestamp_start": timestamp_start,
                "timestamp_end": _utc_now(),
                "input_path": str(input_path),
                "input_bytes_sha256": input_bytes_sha,
                "original_tex_sha256": _sha256_text(original_tex),
                "encoding": args.encoding,
                "warnings": warnings,
                "fatal_errors": fatal_errors,
                "exit_status": 2,
            },
        )
        return 2

    tool_contract_blockers = _collect_contract_blockers(
        document_mode=document_mode,
        audit_md=audit_md,
        response_revision_audit_md=response_revision_audit_path.read_text(encoding="utf-8", errors="replace"),
        tracked_delivery=tracked_delivery_meta,
    )
    audit_md = _force_audit_not_ready(audit_md, reasons=tool_contract_blockers)
    verdict = _parse_verdict(audit_md)

    _write_text(out_dir / "audit.md", audit_md)
    _write_text(out_dir / "verification_requests.md", verif_md)
    _write_json(out_dir / "verification_requests.json", verif_json_obj)
    auditor_verdict = verdict

    try:
        deep_verification_md, deep_verdict = run_deep_verifier("deep_verify", verif_md=verif_md, previous_report=None)
    except Exception as exc:
        fatal_errors.append(str(exc))
        _write_json(
            run_path,
            {
                "schema_version": 1,
                "timestamp_start": timestamp_start,
                "timestamp_end": _utc_now(),
                "input_path": str(input_path),
                "input_bytes_sha256": input_bytes_sha,
                "original_tex_sha256": _sha256_text(original_tex),
                "encoding": args.encoding,
                "warnings": warnings,
                "fatal_errors": fatal_errors,
                "exit_status": 2,
            },
        )
        return 2

    _write_text(out_dir / "deep_verification.md", deep_verification_md)
    deep_verifier_verdict = deep_verdict

    secondary_deep_verification_md = ""
    secondary_deep_verdict = "READY"
    secondary_deep_verifier_verdict = ""
    deep_verification_context_md = deep_verification_md

    if str(args.secondary_deep_verify_backend) != "off":
        try:
            secondary_deep_verification_md, secondary_deep_verdict = run_secondary_deep_verifier(
                "deep_verify_secondary",
                verif_md=verif_md,
                previous_report=None,
            )
        except Exception as exc:
            fatal_errors.append(str(exc))
            _write_json(
                run_path,
                {
                    "schema_version": 1,
                    "timestamp_start": timestamp_start,
                    "timestamp_end": _utc_now(),
                    "input_path": str(input_path),
                    "input_bytes_sha256": input_bytes_sha,
                    "original_tex_sha256": _sha256_text(original_tex),
                    "encoding": args.encoding,
                    "warnings": warnings,
                    "fatal_errors": fatal_errors,
                    "exit_status": 2,
                },
            )
            return 2

        _write_text(out_dir / "deep_verification_secondary.md", secondary_deep_verification_md)
        secondary_deep_verifier_verdict = secondary_deep_verdict
        deep_verification_context_md = (
            deep_verification_md + "\n\n---\n\n## Secondary deep verification\n\n" + secondary_deep_verification_md
        )

    def is_ready(*, audit_verdict: str, deep_verdict: str, secondary_deep_verdict: str) -> bool:
        nonlocal timeout_fallback_note_emitted
        if audit_verdict != "READY":
            return False
        secondary_backend_enabled = str(args.secondary_deep_verify_backend) != "off"
        deep_gate_ok = _deep_verifier_accepts_timeout_fallback(
            codex_verify=cfg.codex_verify,
            deep_verdict=deep_verdict,
            deep_verifier_timed_out=deep_verifier_timed_out,
            codex_timeout_policy=str(args.codex_timeout_policy),
            secondary_backend_enabled=secondary_backend_enabled,
            secondary_deep_verdict=secondary_deep_verdict,
        )
        if not deep_gate_ok:
            return False
        if (
            cfg.codex_verify
            and deep_verdict != "READY"
            and deep_verifier_timed_out
            and str(args.codex_timeout_policy) == "allow-secondary"
            and secondary_backend_enabled
            and secondary_deep_verdict == "READY"
            and not timeout_fallback_note_emitted
        ):
            warnings.append(
                "codex deep verifier timed out, but secondary deep verifier is READY; "
                "accepting fallback per --codex-timeout-policy=allow-secondary"
            )
            timeout_fallback_note_emitted = True
        if str(args.secondary_deep_verify_backend) != "off" and secondary_deep_verdict != "READY":
            return False
        return True

    if is_ready(audit_verdict=verdict, deep_verdict=deep_verdict, secondary_deep_verdict=secondary_deep_verdict):
        converged = True
    else:
        prev_audit = audit_md
        prev_primary_deep_verification_md = deep_verification_md
        prev_secondary_deep_verification_md = secondary_deep_verification_md
        prev_deep_context_md = deep_verification_context_md
        while (
            not is_ready(audit_verdict=verdict, deep_verdict=deep_verdict, secondary_deep_verdict=secondary_deep_verdict)
        ) and rounds_completed < args.max_rounds:
            rounds_completed += 1
            repair_stage = f"repair_{rounds_completed}"

            try:
                writer_tex, changes_md, open_q = run_writer(
                    repair_stage,
                    is_repair=True,
                    input_tex_for_prompt=current_input_tex_for_prompt,
                    current_clean_tex=current_input_tex_for_prompt,
                    current_audit_md=prev_audit,
                    current_deep_verification_md=prev_deep_context_md,
                )
            except Exception as exc:
                fatal_errors.append(str(exc))
                break

            try:
                current_clean_tex, current_input_tex_for_prompt = validate_and_assemble_writer_output(writer_tex)
            except Exception as exc:
                fatal_errors.append(str(exc))
                break
            try:
                write_candidate_artifacts(original=original_tex, clean=current_clean_tex, changes_md=changes_md, open_q=open_q)
            except Exception as exc:
                fatal_errors.append(str(exc))
                break

            try:
                audit_md, verif_md, verif_json_obj, verdict = run_auditor(f"auditor_{rounds_completed}", previous_audit=prev_audit)
            except Exception as exc:
                fatal_errors.append(str(exc))
                break

            tool_contract_blockers = _collect_contract_blockers(
                document_mode=document_mode,
                audit_md=audit_md,
                response_revision_audit_md=response_revision_audit_path.read_text(encoding="utf-8", errors="replace"),
                tracked_delivery=tracked_delivery_meta,
            )
            audit_md = _force_audit_not_ready(audit_md, reasons=tool_contract_blockers)
            verdict = _parse_verdict(audit_md)

            _write_text(out_dir / "audit.md", audit_md)
            _write_text(out_dir / "verification_requests.md", verif_md)
            _write_json(out_dir / "verification_requests.json", verif_json_obj)
            auditor_verdict = verdict

            try:
                deep_verification_md, deep_verdict = run_deep_verifier(
                    f"deep_verify_{rounds_completed}",
                    verif_md=verif_md,
                    previous_report=prev_primary_deep_verification_md,
                )
            except Exception as exc:
                fatal_errors.append(str(exc))
                break
            _write_text(out_dir / "deep_verification.md", deep_verification_md)
            deep_verifier_verdict = deep_verdict

            secondary_deep_verification_md = ""
            secondary_deep_verdict = "READY"
            if str(args.secondary_deep_verify_backend) != "off":
                try:
                    secondary_deep_verification_md, secondary_deep_verdict = run_secondary_deep_verifier(
                        f"deep_verify_secondary_{rounds_completed}",
                        verif_md=verif_md,
                        previous_report=prev_secondary_deep_verification_md,
                    )
                except Exception as exc:
                    fatal_errors.append(str(exc))
                    break
                _write_text(out_dir / "deep_verification_secondary.md", secondary_deep_verification_md)
                secondary_deep_verifier_verdict = secondary_deep_verdict

            deep_verification_context_md = deep_verification_md
            if secondary_deep_verification_md.strip():
                deep_verification_context_md = (
                    deep_verification_md + "\n\n---\n\n## Secondary deep verification\n\n" + secondary_deep_verification_md
                )

            prev_audit = audit_md
            prev_primary_deep_verification_md = deep_verification_md
            prev_secondary_deep_verification_md = secondary_deep_verification_md
            prev_deep_context_md = deep_verification_context_md

        converged = is_ready(audit_verdict=verdict, deep_verdict=deep_verdict, secondary_deep_verdict=secondary_deep_verdict)

    exit_status = 0 if (converged and not fatal_errors) else (1 if not fatal_errors else 2)
    _write_json(
        run_path,
        {
            "schema_version": 1,
            "timestamp_start": timestamp_start,
            "timestamp_end": _utc_now(),
            "input_path": str(input_path),
            "input_bytes_sha256": input_bytes_sha,
            "original_tex_sha256": _sha256_text(original_tex),
            "clean_tex_sha256": _sha256_file(out_dir / "clean.tex"),
            "encoding": args.encoding,
            "mode": str(args.mode),
            "context_file": context_file_meta,
            "context_dir": context_dir_meta,
            "context_files": context_files_meta,
            "models": {
                "writer": {"backend": cfg.writer_backend, "model": cfg.writer_model},
                "auditor": {"backend": cfg.auditor_backend, "model": cfg.auditor_model},
                "deep_verifier": {
                    "backend": "codex",
                    "enabled": cfg.codex_verify,
                    "model": (cfg.codex_model or None),
                    "config_overrides": list(cfg.codex_config_overrides),
                    "timeout_seconds": int(args.codex_timeout_seconds),
                    "timeout_policy": str(args.codex_timeout_policy),
                    "timed_out_last_run": bool(deep_verifier_timed_out),
                },
                "deep_verifier_secondary": {
                    "backend": (str(args.secondary_deep_verify_backend) if str(args.secondary_deep_verify_backend) != "off" else None),
                    "enabled": (str(args.secondary_deep_verify_backend) != "off"),
                    "model": (str(args.secondary_deep_verify_model) or None),
                },
            },
            "full_document": full_document,
            "revision_context": revision_context,
            "tracked_delivery": tracked_delivery_meta,
            "correction_convergence": {
                "enabled": True,
                "rounds_completed": rounds_completed,
                "converged": converged,
            },
            "artifacts": {
                "clean_tex": str(out_dir / "clean.tex"),
                "changes_diff": str(out_dir / "changes.diff"),
                "audit_md": str(out_dir / "audit.md"),
                "response_revision_audit.md": str(response_revision_audit_path),
                "tracked_delivery_artifact": tracked_delivery_meta.get("artifact_path"),
            },
            "rounds_completed": rounds_completed,
            "auditor_verdict": auditor_verdict,
            "deep_verifier_verdict": deep_verifier_verdict,
            "secondary_deep_verifier_verdict": (secondary_deep_verifier_verdict or None),
            "converged": converged,
            "warnings": warnings,
            "fatal_errors": fatal_errors,
            "exit_status": exit_status,
        },
    )
    return exit_status


if __name__ == "__main__":
    raise SystemExit(main())
