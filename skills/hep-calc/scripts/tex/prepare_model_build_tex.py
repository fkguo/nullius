#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
from dataclasses import dataclass
from datetime import datetime, timezone
from hashlib import sha256
from pathlib import Path
from typing import Any, Callable, Optional


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def dump_json(path: Path, obj: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as f:
        json.dump(obj, f, indent=2, sort_keys=True)
        f.write("\n")


def load_json(path: Path) -> dict:
    with path.open("r", encoding="utf-8") as f:
        v = json.load(f)
    if not isinstance(v, dict):
        raise TypeError("job.resolved.json must be an object")
    return v


def file_sha256(path: Path) -> str:
    h = sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


_RE_BEGIN_DOC = re.compile(r"\\begin\{document\}")
_RE_NEWCOMMAND = re.compile(r"\\(re)?newcommand\*?\s*(\{\\[A-Za-z@]+\}|\\[A-Za-z@]+)")
_RE_PROVIDECOMMAND = re.compile(r"\\providecommand\*?\s*(\{\\[A-Za-z@]+\}|\\[A-Za-z@]+)")
_RE_DEF = re.compile(r"\\def\s*\\([A-Za-z@]+)")
_RE_LABEL = re.compile(r"\\label\{([^}]+)\}")

_RE_INPUT_LIKE = re.compile(r"\\(input|include|subfile)\s*\{", re.IGNORECASE)

MATH_ENVS = {
    "equation",
    "equation*",
    "align",
    "align*",
    "multline",
    "multline*",
    "eqnarray",
    "eqnarray*",
    "gather",
    "gather*",
}

_RE_DISPLAY_DOLLAR = re.compile(r"\$\$([\s\S]*?)\$\$")
_RE_DISPLAY_BRACKET = re.compile(r"\\\[([\s\S]*?)\\\]")


@dataclass(frozen=True)
class Macro:
    name: str  # without leading backslash, e.g. "Tr"
    nargs: int
    body: str
    source: str


def _strip_braces(s: str) -> str:
    s = s.strip()
    if s.startswith("{") and s.endswith("}"):
        return s[1:-1]
    return s


def _find_balanced_brace(text: str, start: int) -> tuple[str, int]:
    """
    Parse a {...} group starting at position `start` (which must point to '{').
    Returns (content_without_outer_braces, next_index_after_group).
    """
    if start >= len(text) or text[start] != "{":
        raise ValueError("expected '{' at start")
    depth = 0
    i = start
    out: list[str] = []
    while i < len(text):
        ch = text[i]
        if ch == "{":
            depth += 1
            if depth > 1:
                out.append(ch)
        elif ch == "}":
            depth -= 1
            if depth == 0:
                return ("".join(out), i + 1)
            out.append(ch)
        else:
            out.append(ch)
        i += 1
    raise ValueError("unbalanced braces")


def _parse_optional_bracket_int(text: str, start: int) -> tuple[Optional[int], int]:
    i = start
    while i < len(text) and text[i].isspace():
        i += 1
    if i < len(text) and text[i] == "[":
        j = text.find("]", i + 1)
        if j < 0:
            return None, start
        raw = text[i + 1 : j].strip()
        try:
            return int(raw), j + 1
        except Exception:
            return None, j + 1
    return None, start


def _extract_macros_from_preamble(text: str, *, source: str) -> dict[str, Macro]:
    """
    Best-effort macro extraction from preamble:
    - \\newcommand{\\foo}[n]{body}
    - \\renewcommand{\\foo}[n]{body}
    - \\providecommand{\\foo}[n]{body}
    - \\def\\foo#1#2{body} (limited: counts consecutive #<digit> params)
    """
    macros: dict[str, Macro] = {}

    def add(m: Macro) -> None:
        # last definition wins
        macros[m.name] = m

    i = 0
    while i < len(text):
        m = _RE_NEWCOMMAND.search(text, i)
        m2 = _RE_PROVIDECOMMAND.search(text, i)
        candidates = [x for x in [m, m2] if x]
        if not candidates:
            break
        m = min(candidates, key=lambda x: x.start())
        i = m.end()

        raw_name = m.group(2)
        name = _strip_braces(raw_name).lstrip("\\")

        nargs, i2 = _parse_optional_bracket_int(text, i)
        i = i2

        while i < len(text) and text[i].isspace():
            i += 1
        if i >= len(text) or text[i] != "{":
            continue
        body, i = _find_balanced_brace(text, i)
        add(Macro(name=name, nargs=int(nargs or 0), body=body, source=source))

    i = 0
    while i < len(text):
        m = _RE_DEF.search(text, i)
        if not m:
            break
        name = m.group(1)
        i = m.end()

        # parse parameters like #1#2 immediately following
        nargs = 0
        j = i
        while j + 1 < len(text) and text[j] == "#" and text[j + 1].isdigit():
            nargs = max(nargs, int(text[j + 1]))
            j += 2
        i = j

        while i < len(text) and text[i].isspace():
            i += 1
        if i >= len(text) or text[i] != "{":
            continue
        body, i = _find_balanced_brace(text, i)
        add(Macro(name=name, nargs=nargs, body=body, source=source))

    return macros


def _expand_macros(text: str, macros: dict[str, Macro], *, max_rounds: int = 20) -> tuple[str, list[dict[str, Any]]]:
    """
    Best-effort macro expansion within a math snippet.
    Only expands macros defined in `macros`.

    Returns (expanded_text, trace_events).
    """
    trace: list[dict[str, Any]] = []

    def parse_one_arg(s: str, start: int) -> tuple[str, int]:
        i = start
        while i < len(s) and s[i].isspace():
            i += 1
        if i >= len(s):
            return "", start
        if s[i] == "{":
            arg, j = _find_balanced_brace(s, i)
            return arg, j
        if s[i] == "\\":
            m = re.match(r"\\[A-Za-z@]+", s[i:])
            if m:
                return m.group(0), i + len(m.group(0))
        m = re.match(r"[A-Za-z0-9_\^]+", s[i:])
        if m:
            return m.group(0), i + len(m.group(0))
        return s[i], i + 1

    def expand_once(s: str) -> tuple[str, bool]:
        out: list[str] = []
        i = 0
        changed = False
        while i < len(s):
            if s[i] != "\\":
                out.append(s[i])
                i += 1
                continue
            m = re.match(r"\\([A-Za-z@]+)", s[i:])
            if not m:
                out.append(s[i])
                i += 1
                continue
            name = m.group(1)
            macro = macros.get(name)
            if not macro:
                out.append(s[i : i + len(m.group(0))])
                i += len(m.group(0))
                continue

            j = i + len(m.group(0))
            args: list[str] = []
            ok = True
            for _ in range(macro.nargs):
                arg, j2 = parse_one_arg(s, j)
                if j2 == j:
                    ok = False
                    break
                args.append(arg)
                j = j2
            if not ok:
                out.append(s[i : i + len(m.group(0))])
                i += len(m.group(0))
                continue

            body = macro.body
            for k, a in enumerate(args, start=1):
                body = body.replace(f"#{k}", a)
            out.append(body)
            trace.append({"event": "macro_expand", "name": name, "nargs": macro.nargs, "source": macro.source})
            changed = True
            i = j
        return "".join(out), changed

    cur = text
    for _ in range(max_rounds):
        cur2, changed = expand_once(cur)
        cur = cur2
        if not changed:
            break
    return cur, trace


def _line_for_index(text: str, idx: int) -> int:
    if idx <= 0:
        return 1
    return text.count("\n", 0, idx) + 1


def _replace_balanced_braced_call(
    text: str, *, macro: str, replacement: Callable[[str], str]
) -> tuple[str, int, list[dict[str, Any]]]:
    """
    Replace occurrences of \\<macro>{...} where ... is a balanced brace group.
    Returns (new_text, n_replaced, trace_events).
    """
    token = "\\" + macro
    out: list[str] = []
    trace: list[dict[str, Any]] = []
    i = 0
    n = 0
    while i < len(text):
        j = text.find(token, i)
        if j < 0:
            out.append(text[i:])
            break
        out.append(text[i:j])
        k = j + len(token)
        while k < len(text) and text[k].isspace():
            k += 1
        if k >= len(text) or text[k] != "{":
            out.append(token)
            i = j + len(token)
            continue
        try:
            arg, k2 = _find_balanced_brace(text, k)
        except Exception:
            out.append(token)
            i = j + len(token)
            continue
        out.append(replacement(arg))
        trace.append({"event": "normalize_balanced_macro", "macro": macro})
        n += 1
        i = k2
    return "".join(out), n, trace


def _replace_not_syntax(text: str) -> tuple[str, int, list[dict[str, Any]]]:
    """
    Best-effort normalize \\not forms:
      - \\not{X} (balanced braces)
      - \\not X, \\not\\!X
    to \\text{Slash}(X).
    """
    trace: list[dict[str, Any]] = []
    out: list[str] = []
    i = 0
    n = 0
    token = "\\not"
    while i < len(text):
        j = text.find(token, i)
        if j < 0:
            out.append(text[i:])
            break
        out.append(text[i:j])
        k = j + len(token)
        # optional whitespace + \\! decorations
        while k < len(text) and text[k].isspace():
            k += 1
        while k + 1 < len(text) and text[k] == "\\" and text[k + 1] == "!":
            k += 2
            while k < len(text) and text[k].isspace():
                k += 1
        if k < len(text) and text[k] == "{":
            try:
                arg, k2 = _find_balanced_brace(text, k)
                out.append(rf"\text{{Slash}}({arg})")
                trace.append({"event": "normalize_not"})
                n += 1
                i = k2
                continue
            except Exception:
                pass

        # unbraced arg: a macro or a simple token
        if k < len(text) and text[k] == "\\":
            m = re.match(r"\\[A-Za-z@]+", text[k:])
            if m:
                arg = m.group(0)
                out.append(rf"\text{{Slash}}({arg})")
                trace.append({"event": "normalize_not"})
                n += 1
                i = k + len(arg)
                continue
        m = re.match(r"[A-Za-z0-9_]+", text[k:])
        if m:
            arg = m.group(0)
            out.append(rf"\text{{Slash}}({arg})")
            trace.append({"event": "normalize_not"})
            n += 1
            i = k + len(arg)
            continue

        # fallback: keep literal token
        out.append(token)
        i = j + len(token)

    return "".join(out), n, trace


def _normalize_for_texform(text: str) -> tuple[str, list[dict[str, Any]]]:
    """
    Normalize TeX snippet so Mathematica TeXForm parsing does not drop semantics.
    This does NOT interpret physics; it only rewrites into parseable placeholders.
    """
    trace: list[dict[str, Any]] = []
    out = text

    # Strip alignment and labels/nonumber
    out2 = re.sub(r"\\label\{[^}]+\}", " ", out)
    if out2 != out:
        trace.append({"event": "strip_label"})
    out = out2
    out2 = out.replace("&", " ")
    if out2 != out:
        trace.append({"event": "strip_align_ampersand"})
    out = out2
    out2 = re.sub(r"\\\\(\[[^\]]*\])?", " ", out)
    if out2 != out:
        trace.append({"event": "strip_linebreak"})
    out = out2
    out2 = re.sub(r"\\(notag|nonumber)\b", " ", out)
    if out2 != out:
        trace.append({"event": "strip_notag"})
    out = out2

    # Normalize h.c. to HC (parseable)
    out2 = re.sub(r"\\text\{\s*h\s*\.?\s*c\s*\.?\s*\}", r"\\text{HC}", out, flags=re.IGNORECASE)
    out2 = re.sub(r"\\mathrm\{\s*h\s*\.?\s*c\s*\.?\s*\}", r"\\mathrm{HC}", out2, flags=re.IGNORECASE)
    if out2 != out:
        trace.append({"event": "normalize_hc"})
    out = out2

    # Normalize slashed / not into a parseable placeholder.
    # We use \\text{Slash}(...) because Mathematica parses it as Slash[...].
    out2, _, t2 = _replace_balanced_braced_call(out, macro="slashed", replacement=lambda arg: rf"\text{{Slash}}({arg})")
    if out2 != out:
        trace.append({"event": "normalize_slashed"})
        trace.extend(t2)
    out = out2

    out2, _, t2 = _replace_balanced_braced_call(out, macro="cancel", replacement=lambda arg: rf"\text{{Slash}}({arg})")
    if out2 != out:
        trace.append({"event": "normalize_cancel"})
        trace.extend(t2)
    out = out2

    out2, _, t2 = _replace_not_syntax(out)
    if out2 != out:
        trace.extend(t2)
    out = out2

    # Collapse whitespace
    out = re.sub(r"\s+", " ", out).strip()
    return out, trace


def _extract_math_blocks(text: str, *, file_path: str) -> list[dict[str, Any]]:
    lines = text.splitlines()
    blocks: list[dict[str, Any]] = []
    i = 0
    while i < len(lines):
        line = lines[i]
        m = re.search(r"\\begin\{([A-Za-z*]+)\}", line)
        if not m:
            i += 1
            continue
        env = m.group(1)
        if env not in MATH_ENVS:
            i += 1
            continue
        start_line = i + 1
        buf: list[str] = []
        i += 1
        while i < len(lines):
            if re.search(rf"\\end\{{{re.escape(env)}\}}", lines[i]):
                break
            buf.append(lines[i])
            i += 1
        end_line = i + 1
        raw = "\n".join(buf)
        labels = _RE_LABEL.findall(raw)
        blocks.append(
            {
                "file": file_path,
                "env": env,
                "start_line": start_line,
                "end_line": end_line,
                "labels": labels,
                "raw_tex": raw,
            }
        )
        i += 1

    # TODO: support $$...$$ and \\[...\\] if needed
    for m in _RE_DISPLAY_DOLLAR.finditer(text):
        raw = m.group(1).strip()
        blocks.append(
            {
                "file": file_path,
                "env": "$$",
                "start_line": _line_for_index(text, m.start()),
                "end_line": _line_for_index(text, m.end()),
                "labels": _RE_LABEL.findall(raw),
                "raw_tex": raw,
            }
        )
    for m in _RE_DISPLAY_BRACKET.finditer(text):
        raw = m.group(1).strip()
        blocks.append(
            {
                "file": file_path,
                "env": "\\[\\]",
                "start_line": _line_for_index(text, m.start()),
                "end_line": _line_for_index(text, m.end()),
                "labels": _RE_LABEL.findall(raw),
                "raw_tex": raw,
            }
        )
    return blocks


def _split_block_rows(block: dict[str, Any]) -> list[dict[str, Any]]:
    raw = block.get("raw_tex") or ""
    parts = re.split(r"\\\\(?:\[[^\]]*\])?", raw)
    rows: list[dict[str, Any]] = []
    for idx, p in enumerate(parts):
        s = p.strip()
        if not s:
            continue
        labels = _RE_LABEL.findall(s)
        rows.append(
            {
                "file": block.get("file"),
                "env": block.get("env"),
                "start_line": block.get("start_line"),
                "end_line": block.get("end_line"),
                "row_index": idx,
                "labels": labels,
                "raw_tex": s,
            }
        )
    return rows


def _choose_selected(rows: list[dict[str, Any]], *, mode: str, include: list[str], exclude: list[str]) -> list[dict[str, Any]]:
    if mode == "all_math_blocks":
        return rows

    inc_re = [re.compile(p) for p in include if p]
    exc_re = [re.compile(p) for p in exclude if p]

    out: list[dict[str, Any]] = []
    for r in rows:
        t = r.get("normalized_tex") or r.get("expanded_tex") or r.get("raw_tex") or ""
        if inc_re and not any(rx.search(t) for rx in inc_re):
            continue
        if any(rx.search(t) for rx in exc_re):
            continue
        out.append(r)
    return out


def _run_latexpand(src: Path, dst: Path, *, cwd: Path, expand_usepackage: bool) -> dict[str, Any]:
    cmd = ["latexpand", "--fatal", "--output", str(dst), str(src)]
    if expand_usepackage:
        cmd.insert(1, "--expand-usepackage")
    try:
        proc = subprocess.run(cmd, cwd=str(cwd), check=False, capture_output=True, text=True)
        return {"cmd": cmd, "returncode": proc.returncode, "stdout": proc.stdout, "stderr": proc.stderr}
    except FileNotFoundError as exc:
        return {"cmd": cmd, "returncode": 127, "stdout": "", "stderr": "", "error": "latexpand_not_found", "exception": str(exc)}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--job", required=True, help="Path to job.resolved.json")
    ap.add_argument("--out", required=True, help="out_dir")
    args = ap.parse_args()

    out_dir = Path(args.out).resolve()
    job = load_json(Path(args.job))
    auto = job.get("auto_qft") or {}
    model_build = auto.get("model_build") or {}
    if not isinstance(model_build, dict):
        model_build = {}

    stage_dir = out_dir / "auto_qft" / "model_build" / "tex_preprocess"
    status_path = stage_dir / "status.json"
    summary_path = stage_dir / "summary.json"

    started = utc_now()

    # Determine whether to run: explicit enable OR implicit if tex_paths/inline is present.
    explicit_enable = model_build.get("enable")
    tex_paths = model_build.get("tex_paths") or []
    inline_tex = (model_build.get("inline_tex") or "").strip()

    enabled = bool(explicit_enable) or bool(tex_paths) or bool(inline_tex)
    if explicit_enable is False:
        enabled = False

    if not enabled:
        dump_json(status_path, {"stage": "tex_model_preprocess", "status": "SKIPPED", "reason": "not_requested", "started_at": started, "ended_at": utc_now()})
        dump_json(summary_path, {"ts": utc_now(), "status": "SKIPPED", "reason": "not_requested"})
        return 0

    if inline_tex and tex_paths:
        dump_json(
            status_path,
            {
                "stage": "tex_model_preprocess",
                "status": "ERROR",
                "reason": "both_inline_and_tex_paths",
                "hint": "Provide either auto_qft.model_build.inline_tex OR auto_qft.model_build.tex_paths (not both).",
                "started_at": started,
                "ended_at": utc_now(),
            },
        )
        dump_json(summary_path, {"ts": utc_now(), "status": "ERROR", "reason": "both_inline_and_tex_paths"})
        return 2

    preprocess_cfg = model_build.get("preprocess") or {}
    if not isinstance(preprocess_cfg, dict):
        preprocess_cfg = {}
    flatten = preprocess_cfg.get("flatten", True) is not False
    expand_usepackage = bool(preprocess_cfg.get("expand_usepackage", False))
    macro_overrides = preprocess_cfg.get("macro_overrides") or {}
    if not isinstance(macro_overrides, dict):
        macro_overrides = {}

    selection_cfg = model_build.get("selection") or {}
    if not isinstance(selection_cfg, dict):
        selection_cfg = {}
    mode = (selection_cfg.get("mode") or "lagrangian_like").strip()
    include_patterns = selection_cfg.get("include_patterns") or [r"\\mathcal\{L\}", r"\\mathscr\{L\}"]
    exclude_patterns = selection_cfg.get("exclude_patterns") or []
    if not isinstance(include_patterns, list):
        include_patterns = [str(include_patterns)]
    if not isinstance(exclude_patterns, list):
        exclude_patterns = [str(exclude_patterns)]

    trace_events: list[dict[str, Any]] = []
    all_rows: list[dict[str, Any]] = []
    tex_files: list[dict[str, Any]] = []
    macros_all: dict[str, Macro] = {}

    if inline_tex:
        # Treat as a single virtual file.
        rows = [{"file": "<inline>", "env": "<inline>", "start_line": None, "end_line": None, "row_index": 0, "labels": [], "raw_tex": inline_tex}]
        all_rows = rows
    else:
        if not isinstance(tex_paths, list) or not tex_paths:
            dump_json(
                status_path,
                {
                    "stage": "tex_model_preprocess",
                    "status": "ERROR",
                    "reason": "missing_tex_paths",
                    "hint": "Provide auto_qft.model_build.tex_paths (absolute or job-relative paths).",
                    "started_at": started,
                    "ended_at": utc_now(),
                },
            )
            dump_json(summary_path, {"ts": utc_now(), "status": "ERROR", "reason": "missing_tex_paths"})
            return 2

        for p in tex_paths:
            src = Path(str(p)).expanduser().resolve()
            if not src.is_file():
                dump_json(status_path, {"stage": "tex_model_preprocess", "status": "ERROR", "reason": "tex_file_not_found", "file": str(src), "started_at": started, "ended_at": utc_now()})
                dump_json(summary_path, {"ts": utc_now(), "status": "ERROR", "reason": "tex_file_not_found", "file": str(src)})
                return 2

            src_text = src.read_text(encoding="utf-8", errors="replace")
            has_multifile_refs = bool(_RE_INPUT_LIKE.search(src_text))

            text: str
            flatten_info: dict[str, Any] = {"enabled": bool(flatten)}
            if flatten:
                dst = stage_dir / "flattened" / (src.stem + ".flattened.tex")
                dst.parent.mkdir(parents=True, exist_ok=True)
                info = _run_latexpand(src, dst, cwd=src.parent, expand_usepackage=expand_usepackage)
                flatten_info.update(info)
                if info.get("error") == "latexpand_not_found":
                    if has_multifile_refs:
                        dump_json(
                            status_path,
                            {
                                "stage": "tex_model_preprocess",
                                "status": "ERROR",
                                "reason": "missing_latexpand_multifile_detected",
                                "hint": "Install `latexpand` (TeXLive) or provide a flattened .tex. Detected \\\\input/\\\\include in source.",
                                "file": str(src),
                                "latexpand": flatten_info,
                                "started_at": started,
                                "ended_at": utc_now(),
                            },
                        )
                        dump_json(summary_path, {"ts": utc_now(), "status": "ERROR", "reason": "missing_latexpand_multifile_detected", "file": str(src)})
                        return 2
                    # Single-file fallback: proceed deterministically without flattening, but record a warning.
                    flatten_info["fallback"] = "proceeded_without_latexpand_single_file"
                    trace_events.append({"event": "latexpand_missing_fallback_single_file", "file": str(src)})
                    text = src_text
                    flattened_path = src
                elif info.get("returncode") != 0 or not dst.is_file():
                    dump_json(
                        status_path,
                        {
                            "stage": "tex_model_preprocess",
                            "status": "ERROR",
                            "reason": "latexpand_failed",
                            "file": str(src),
                            "latexpand": flatten_info,
                            "started_at": started,
                            "ended_at": utc_now(),
                        },
                    )
                    dump_json(summary_path, {"ts": utc_now(), "status": "ERROR", "reason": "latexpand_failed", "file": str(src)})
                    return 2
                else:
                    text = dst.read_text(encoding="utf-8", errors="replace")
                    flattened_path = dst
            else:
                if has_multifile_refs:
                    trace_events.append({"event": "multifile_refs_detected_but_flatten_disabled", "file": str(src)})
                text = src_text
                flattened_path = src

            tex_files.append(
                {
                    "original": str(src),
                    "original_sha256": file_sha256(src),
                    "flattened": str(flattened_path),
                    "flattened_sha256": file_sha256(flattened_path),
                    "latexpand": flatten_info,
                }
            )

            # Macro extraction from preamble only.
            preamble = text
            mdoc = _RE_BEGIN_DOC.search(text)
            if mdoc:
                preamble = text[: mdoc.start()]
            macros = _extract_macros_from_preamble(preamble, source=str(src))
            macros_all.update(macros)

            blocks = _extract_math_blocks(text, file_path=str(src))
            rows: list[dict[str, Any]] = []
            for b in blocks:
                rows.extend(_split_block_rows(b))
            all_rows.extend(rows)

    # Apply macro overrides as trivial macros
    for k, v in macro_overrides.items():
        name = str(k).strip()
        if name.startswith("\\"):
            name = name[1:]
        macros_all[name] = Macro(name=name, nargs=0, body=str(v), source="macro_overrides")

    # Expand + normalize all rows
    for r in all_rows:
        raw_tex = str(r.get("raw_tex") or "")
        expanded, t1 = _expand_macros(raw_tex, macros_all)
        normalized, t2 = _normalize_for_texform(expanded)
        r["expanded_tex"] = expanded
        r["normalized_tex"] = normalized
        trace_events.extend(t1)
        trace_events.extend(t2)

        # stable id
        labels = r.get("labels") or []
        if isinstance(labels, list) and labels:
            r["id"] = str(labels[0])
        else:
            f = os.path.basename(str(r.get("file") or "tex"))
            sl = r.get("start_line")
            ri = r.get("row_index", 0)
            r["id"] = f"{f}:{sl}:{ri}"

    selected = _choose_selected(all_rows, mode=mode, include=list(map(str, include_patterns)), exclude=list(map(str, exclude_patterns)))
    selected_ids = {r.get("id") for r in selected}
    for r in all_rows:
        r["selected"] = bool(r.get("id") in selected_ids)

    dump_json(stage_dir / "tex_files.json", {"ts": utc_now(), "files": tex_files})
    dump_json(stage_dir / "macros.json", {"ts": utc_now(), "macros": {k: {"nargs": v.nargs, "body": v.body, "source": v.source} for k, v in sorted(macros_all.items())}})
    dump_json(stage_dir / "blocks_all.json", {"ts": utc_now(), "mode": mode, "rows": all_rows})
    dump_json(stage_dir / "blocks_selected.json", {"ts": utc_now(), "mode": mode, "rows": selected})
    dump_json(stage_dir / "trace.json", {"ts": utc_now(), "events": trace_events})

    dump_json(
        status_path,
        {"stage": "tex_model_preprocess", "status": "PASS", "reason": None, "started_at": started, "ended_at": utc_now()},
    )
    dump_json(
        summary_path,
        {
            "ts": utc_now(),
            "status": "PASS",
            "counts": {
                "tex_files": len(tex_files) if not inline_tex else 0,
                "blocks_rows_total": len(all_rows),
                "blocks_rows_selected": len(selected),
                "macros_total": len(macros_all),
            },
            "selection": {"mode": mode, "include_patterns": include_patterns, "exclude_patterns": exclude_patterns},
        },
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
