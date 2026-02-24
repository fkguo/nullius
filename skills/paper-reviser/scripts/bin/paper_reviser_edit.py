#!/usr/bin/env python3
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
  - tracked.tex (latexdiff if available for full docs; otherwise comment-annotated)
  - readthrough.md
  - risk_flags.md
  - global_style_notes.md
  - changes.md
  - open_questions.md
  - audit.md
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


def _default_runner_paths() -> tuple[Path | None, Path | None]:
    # Sibling skills under $CODEX_HOME/skills/
    base = _skill_root().parent
    claude = base / "claude-cli-runner" / "scripts" / "run_claude.sh"
    gemini = base / "gemini-cli-runner" / "scripts" / "run_gemini.sh"
    return (claude if claude.is_file() else None, gemini if gemini.is_file() else None)


def _estimate_tokens_est(text: str) -> int:
    # Conservative heuristic for LaTeX-heavy text.
    return (len(text) + 2) // 3


def _first_unescaped_comment_pos(line: str) -> int | None:
    """
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
    claude_runner: Path
    gemini_runner: Path
    fallback_auditor: str
    fallback_auditor_model: str
    codex_model: str
    codex_verify: bool
    codex_config_overrides: tuple[str, ...]


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


def _run_claude(
    *,
    runner: Path,
    model: str,
    system_prompt_file: Path,
    prompt_file: Path,
    out_file: Path,
    trace_path: Path,
    stage: str,
) -> int:
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


def _run_gemini(
    *,
    runner: Path,
    model: str,
    system_prompt_file: Path,
    prompt_file: Path,
    out_file: Path,
    trace_path: Path,
    stage: str,
) -> int:
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
    claude_runner: Path,
    gemini_runner: Path,
    model: str,
    system_prompt_file: Path,
    prompt_file: Path,
    out_file: Path,
    trace_path: Path,
    stage: str,
) -> int:
    if backend == "claude":
        return _run_claude(
            runner=claude_runner,
            model=model,
            system_prompt_file=system_prompt_file,
            prompt_file=prompt_file,
            out_file=out_file,
            trace_path=trace_path,
            stage=stage,
        )
    if backend == "gemini":
        return _run_gemini(
            runner=gemini_runner,
            model=model,
            system_prompt_file=system_prompt_file,
            prompt_file=prompt_file,
            out_file=out_file,
            trace_path=trace_path,
            stage=stage,
        )
    raise ValueError(f"unknown backend: {backend!r}")


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


def _system_prompt_writer(*, full_document: bool, is_repair: bool) -> str:
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
    return (
        "You are a senior academic advisor doing a conservative line edit of a LaTeX draft.\n"
        f"STAGE: {mode}.\n\n"
        "PRIORITIES (strict order):\n"
        "1) Correctness/precision of statements (content first).\n"
        "2) Evidence/verification: strengthen or add claims ONLY if supported by the draft's own results/derivations or a verifiable reference.\n"
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


def _system_prompt_auditor() -> str:
    return (
        "You are an independent technical auditor for an academic LaTeX draft.\n"
        "You do NOT rewrite the TeX. You judge correctness/precision, overclaims, missing references, and LaTeX safety risks.\n\n"
        "VERDICT RULE:\n"
        "- If there are blocking correctness/evidence/LaTeX-safety issues introduced or left unresolved, set VERDICT: NOT_READY and list concrete fixes.\n"
        "- Otherwise set VERDICT: READY, but still list non-blocking improvements and verification requests.\n\n"
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

    ap.add_argument("--writer-backend", choices=["claude", "gemini"], default="claude", help="Backend for writer/read-through (default: claude)")
    ap.add_argument("--writer-model", type=str, default="", help="Model name/alias for the writer backend (required with --run-models)")
    ap.add_argument("--auditor-backend", choices=["claude", "gemini"], default="gemini", help="Backend for auditor (default: gemini)")
    ap.add_argument("--auditor-model", type=str, default="", help="Model name/alias for the auditor backend (required with --run-models)")
    ap.add_argument("--fallback-auditor", choices=["off", "claude"], default="off")
    ap.add_argument(
        "--fallback-auditor-model",
        type=str,
        default="",
        help="Claude model to use if --fallback-auditor=claude triggers (default: --writer-model when --writer-backend=claude)",
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
        choices=["off", "claude", "gemini"],
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

    default_claude_runner, default_gemini_runner = _default_runner_paths()
    claude_runner = (args.claude_runner.expanduser().resolve() if args.claude_runner else default_claude_runner)
    gemini_runner = (args.gemini_runner.expanduser().resolve() if args.gemini_runner else default_gemini_runner)
    if claude_runner is None or not claude_runner.is_file():
        print("ERROR: claude runner not found; set --claude-runner", file=sys.stderr)
        return 2
    if gemini_runner is None or not gemini_runner.is_file():
        print("ERROR: gemini runner not found; set --gemini-runner", file=sys.stderr)
        return 2

    cfg = ModelConfig(
        writer_backend=str(args.writer_backend),
        writer_model=str(args.writer_model),
        auditor_backend=str(args.auditor_backend),
        auditor_model=str(args.auditor_model),
        claude_runner=claude_runner,
        gemini_runner=gemini_runner,
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
            claude_runner=cfg.claude_runner,
            gemini_runner=cfg.gemini_runner,
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

        sys_txt = _system_prompt_writer(full_document=full_document, is_repair=is_repair)

        parts: list[str] = []
        parts.append(f"FILE: {input_path.name}\n")
        parts.append("## Read-through summary (stage 1)\n" + readthrough_md + "\n")
        if style_notes_md.strip():
            parts.append("## Global style notes\n" + style_notes_md + "\n")
        if extra_context.strip():
            parts.append("## Extra context (evidence/notes; read-only)\n" + extra_context + "\n")
        if is_repair and current_audit_md:
            parts.append("## Auditor report (must address)\n" + current_audit_md + "\n")
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
            claude_runner=cfg.claude_runner,
            gemini_runner=cfg.gemini_runner,
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

        tracked_path = out_dir / "tracked.tex"
        latexdiff_bin = shutil.which("latexdiff")
        if full_document and latexdiff_bin:
            proc = subprocess.run(
                [latexdiff_bin, "--type=UNDERLINE", "--encoding=utf8", str(out_dir / "original.tex"), str(out_dir / "clean.tex")],
                text=True,
                capture_output=True,
            )
            if proc.returncode == 0 and proc.stdout.strip():
                _write_text(tracked_path, proc.stdout.replace("\r\n", "\n").replace("\r", "\n"))
            else:
                warnings.append(f"latexdiff failed (exit {proc.returncode}); using comment-annotated tracked.tex")
                _write_text(tracked_path, _comment_annotated_tracked(original, clean))
        else:
            _write_text(tracked_path, _comment_annotated_tracked(original, clean))

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
            return "VERDICT: READY\n\n(stub)\n", "", {"schema_version": 1, "items": []}, "READY"

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

        sys_txt = _system_prompt_auditor()
        parts: list[str] = []
        parts.append(f"FILE: {input_path.name}\n")
        parts.append("## Read-through\n" + readthrough_md + "\n")
        parts.append("## changes.diff\n" + (out_dir / "changes.diff").read_text(encoding="utf-8", errors="replace") + "\n")
        parts.append("## changes.md (writer)\n" + (out_dir / "changes.md").read_text(encoding="utf-8", errors="replace") + "\n")
        parts.append("## Candidate clean.tex\n" + (out_dir / "clean.tex").read_text(encoding="utf-8", errors="replace") + "\n")
        if previous_audit:
            parts.append("## Previous audit (context)\n" + previous_audit + "\n")
        base_user_txt = "\n".join(parts)

        def run_auditor_once(*, backend: str, model: str, stage_name: str, user_txt: str) -> tuple[int, str]:
            sys_path_local, user_path_local = write_prompt(stage_name, system=sys_txt, user=user_txt)
            out_raw_local = raw_dir / f"{stage_name}_{backend}.txt"
            if backend == "gemini":
                code = _run_gemini(
                    runner=cfg.gemini_runner,
                    model=model,
                    system_prompt_file=sys_path_local,
                    prompt_file=user_path_local,
                    out_file=out_raw_local,
                    trace_path=trace_path,
                    stage=stage_name,
                )
            elif backend == "claude":
                code = _run_claude(
                    runner=cfg.claude_runner,
                    model=model,
                    system_prompt_file=sys_path_local,
                    prompt_file=user_path_local,
                    out_file=out_raw_local,
                    trace_path=trace_path,
                    stage=stage_name,
                )
            else:
                raise ValueError(f"unexpected auditor backend: {backend}")
            raw_text_local = out_raw_local.read_text(encoding="utf-8", errors="replace") if out_raw_local.is_file() else ""
            return code, raw_text_local

        def resolve_fallback_model() -> str:
            fallback_model = str(cfg.fallback_auditor_model).strip()
            if fallback_model:
                return fallback_model
            if cfg.writer_backend != "claude":
                raise RuntimeError("fallback auditor requires --fallback-auditor-model when --writer-backend is not claude")
            return cfg.writer_model

        if cfg.auditor_backend == "gemini":
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
                    backend="gemini",
                    model=cfg.auditor_model,
                    stage_name=stage_name,
                    user_txt=user_txt,
                )
                if not raw_text.strip():
                    if attempt == 0:
                        warnings.append(f"gemini auditor failed or empty output (exit {last_code}); retrying once")
                    continue
                try:
                    return parse_auditor_payload(raw_text)
                except Exception as exc:
                    last_parse_error = exc
                    if attempt == 0:
                        warnings.append(f"gemini auditor returned malformed blocks; retrying once: {exc}")
                        continue

            if cfg.fallback_auditor == "claude":
                warnings.append("gemini auditor malformed/empty after retry; falling back to claude auditor")
                fallback_model = resolve_fallback_model()
                fb_code, fb_raw = run_auditor_once(
                    backend="claude",
                    model=fallback_model,
                    stage_name=stage + "_fallback_claude",
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
            backend="claude",
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

        # Retry once on failure for Gemini, similar to the auditor path.
        last_code = 1
        attempts = 2 if backend == "gemini" else 1
        for attempt in range(attempts):
            last_code = _run_backend(
                backend=backend,
                claude_runner=cfg.claude_runner,
                gemini_runner=cfg.gemini_runner,
                model=str(args.secondary_deep_verify_model),
                system_prompt_file=sys_path,
                prompt_file=user_path,
                out_file=out_raw,
                trace_path=trace_path,
                stage=stage,
            )
            if out_raw.is_file() and out_raw.read_text(encoding="utf-8", errors="replace").strip():
                break
            if attempt == 0 and backend == "gemini":
                warnings.append(f"secondary deep verifier (gemini) failed (exit {last_code}); retrying once")

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
