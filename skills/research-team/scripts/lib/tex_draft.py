#!/usr/bin/env python3
from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class TexLine:
    path: Path
    line_no: int
    text: str


@dataclass(frozen=True)
class TexIncludeEdge:
    kind: str  # input/include/subfile
    from_path: Path
    to_spec: str
    resolved_path: Path | None


@dataclass(frozen=True)
class TexOccurrence:
    kind: str
    value: str
    path: Path
    line_no: int


@dataclass(frozen=True)
class TexSection:
    command: str
    level: int
    title: str
    start_idx: int
    end_idx: int
    path: Path
    line_no: int


@dataclass(frozen=True)
class TexEnvBlock:
    env: str
    start_idx: int
    end_idx: int
    path: Path
    start_line_no: int
    end_path: Path
    end_line_no: int


_INCLUDE_BRACED_RE = re.compile(r"\\(input|include|subfile)\s*{([^}]+)}")
_INCLUDE_UNBRACED_RE = re.compile(r"\\input\s+([^\s%]+)")
_GRAPHICSPATH_RE = re.compile(r"\\graphicspath\s*{")


def strip_tex_comments(line: str) -> str:
    """
    Best-effort TeX comment stripping.

    TeX treats '%' as comment start in most contexts. To avoid nuking literal '\\%' we
    treat '%' as a comment delimiter only when preceded by an even number of backslashes.
    This is a practical heuristic for sources that often include patterns like '\\\\%'.
    """
    if "%" not in line:
        return line
    for i, ch in enumerate(line):
        if ch != "%":
            continue
        backslashes = 0
        j = i - 1
        while j >= 0 and line[j] == "\\":
            backslashes += 1
            j -= 1
        if backslashes % 2 == 0:
            return line[:i]
    return line


def _resolve_include(from_path: Path, spec: str) -> Path | None:
    spec = (spec or "").strip().strip('"').strip("'")
    if not spec:
        return None
    if any(x in spec for x in ("\\", "{", "}", "$")):
        return None
    base = Path(spec)
    if not base.is_absolute():
        base = from_path.parent / base
    if base.exists():
        return base.resolve()
    if base.suffix == "":
        cand = base.with_suffix(".tex")
        if cand.exists():
            return cand.resolve()
    return None


def flatten_tex(main_tex: Path, max_files: int = 2000, max_total_lines: int = 400_000) -> tuple[list[TexLine], list[TexIncludeEdge], list[str]]:
    """
    Flatten a TeX document by recursively inlining \\input/\\include/\\subfile targets.

    Returns:
      - flat lines (including the original include directive line),
      - include edges,
      - warnings (strings).
    """
    flat: list[TexLine] = []
    edges: list[TexIncludeEdge] = []
    warnings: list[str] = []
    stack: list[Path] = []

    def _read_lines(p: Path) -> list[str] | None:
        try:
            raw = p.read_text(encoding="utf-8", errors="replace").replace("\r\n", "\n").replace("\r", "\n")
        except Exception as exc:
            warnings.append(f"[warn] failed to read TeX file: {p} ({exc})")
            return None
        return raw.splitlines(keepends=True)

    def _walk(p: Path) -> None:
        nonlocal flat
        if len(stack) >= max_files:
            warnings.append(f"[warn] include depth/file count exceeded; skipping: {p}")
            return
        rp = p.resolve()
        if rp in stack:
            cycle = " -> ".join(str(x) for x in (stack + [rp]))
            warnings.append(f"[warn] include cycle detected; skipping: {cycle}")
            return

        lines = _read_lines(rp)
        if lines is None:
            return

        stack.append(rp)
        for i, ln in enumerate(lines, start=1):
            flat.append(TexLine(path=rp, line_no=i, text=ln))
            if len(flat) >= max_total_lines:
                warnings.append("[warn] max_total_lines exceeded; truncating flatten traversal")
                stack.pop()
                return

            clean = strip_tex_comments(ln)
            for m in _INCLUDE_BRACED_RE.finditer(clean):
                kind, spec = m.group(1), m.group(2)
                resolved = _resolve_include(rp, spec)
                edges.append(TexIncludeEdge(kind=kind, from_path=rp, to_spec=spec, resolved_path=resolved))
                if resolved is None:
                    warnings.append(f"[warn] missing/unresolvable include: {kind}{{{spec}}} (from {rp}:{i})")
                    continue
                _walk(resolved)

            # Support \\input without braces (single token).
            if "\\input" in clean and "{ " not in clean:
                for m in _INCLUDE_UNBRACED_RE.finditer(clean):
                    spec = m.group(1)
                    resolved = _resolve_include(rp, spec)
                    edges.append(TexIncludeEdge(kind="input", from_path=rp, to_spec=spec, resolved_path=resolved))
                    if resolved is None:
                        warnings.append(f"[warn] missing/unresolvable include: input {spec} (from {rp}:{i})")
                        continue
                    _walk(resolved)

        stack.pop()

    _walk(main_tex)
    return flat, edges, warnings


def parse_bib_keys(bib_path: Path) -> tuple[set[str], list[str]]:
    if not bib_path.is_file():
        return set(), [f"[error] bib file not found: {bib_path}"]
    try:
        text = bib_path.read_text(encoding="utf-8", errors="replace").replace("\r\n", "\n").replace("\r", "\n")
    except Exception as exc:
        return set(), [f"[error] failed to read bib file: {bib_path} ({exc})"]

    keys: set[str] = set()
    errors: list[str] = []

    # Rough BibTeX entry key extraction: @type{key,
    for m in re.finditer(r"@\s*([A-Za-z]+)\s*{\s*([^,\s]+)\s*,", text):
        typ = m.group(1).lower()
        if typ in ("comment", "preamble", "string"):
            continue
        keys.add(m.group(2).strip())

    if not keys:
        errors.append(f"[warn] no BibTeX entry keys detected in: {bib_path}")
    return keys, errors


def _read_balanced_braces(flat: list[TexLine], start_idx: int, start_col: int, max_chars: int = 8000) -> tuple[str, int, int]:
    """
    Read a { ... } argument that may span multiple lines.

    Returns: (content, end_idx, end_col) where end_* points to the closing brace.
    If no closing brace found within max_chars, returns truncated content and end at traversal end.
    """
    depth = 0
    out: list[str] = []
    total = 0

    i = start_idx
    col = start_col
    while i < len(flat):
        ln = strip_tex_comments(flat[i].text)
        j = col
        while j < len(ln):
            ch = ln[j]
            if ch == "{":
                depth += 1
                if depth > 1:
                    out.append(ch)
            elif ch == "}":
                depth -= 1
                if depth <= 0:
                    return "".join(out), i, j
                out.append(ch)
            else:
                if depth >= 1:
                    out.append(ch)
            total += 1
            if total >= max_chars:
                return "".join(out).rstrip() + "\n[... truncated ...]", i, j
            j += 1
        i += 1
        col = 0
    return "".join(out).rstrip() + "\n[... truncated ...]", len(flat) - 1 if flat else 0, 0


def extract_sections(flat: list[TexLine]) -> list[TexSection]:
    sec_re = re.compile(
        r"\\(?P<cmd>chapter|section|subsection|subsubsection|paragraph|subparagraph)\*?\s*(?:\\[[^\\]]*\\]\\s*)?{"
    )
    level_map = {
        "chapter": 1,
        "section": 2,
        "subsection": 3,
        "subsubsection": 4,
        "paragraph": 5,
        "subparagraph": 6,
    }

    markers: list[tuple[int, str, int, str]] = []
    for idx, tl in enumerate(flat):
        clean = strip_tex_comments(tl.text)
        m = sec_re.search(clean)
        if not m:
            continue
        cmd = m.group("cmd")
        brace_pos = m.end() - 1
        title, end_idx, end_col = _read_balanced_braces(flat, idx, brace_pos)
        title_clean = " ".join(title.replace("\n", " ").split()).strip()
        markers.append((idx, cmd, level_map.get(cmd, 9), title_clean))

    sections: list[TexSection] = []
    for i, (idx, cmd, level, title) in enumerate(markers):
        end_idx = len(flat)
        for j in range(i + 1, len(markers)):
            j_idx, _jcmd, j_level, _jtitle = markers[j]
            if j_level <= level:
                end_idx = j_idx
                break
        tl = flat[idx]
        sections.append(
            TexSection(
                command=cmd,
                level=level,
                title=title,
                start_idx=idx,
                end_idx=end_idx,
                path=tl.path,
                line_no=tl.line_no,
            )
        )
    return sections


def extract_env_blocks(flat: list[TexLine], max_blocks: int = 50_000) -> tuple[list[TexEnvBlock], list[str]]:
    token_re = re.compile(r"\\(?P<kind>begin|end)\s*{(?P<env>[^}]+)}")
    stack: list[tuple[str, int]] = []
    blocks: list[TexEnvBlock] = []
    warnings: list[str] = []

    for idx, tl in enumerate(flat):
        clean = strip_tex_comments(tl.text)
        for m in token_re.finditer(clean):
            kind = m.group("kind")
            env = m.group("env").strip()
            if not env:
                continue
            if kind == "begin":
                stack.append((env, idx))
                continue
            # kind == end
            if stack and stack[-1][0] == env:
                env_name, start_idx = stack.pop()
                start_tl = flat[start_idx]
                end_tl = tl
                blocks.append(
                    TexEnvBlock(
                        env=env_name,
                        start_idx=start_idx,
                        end_idx=idx,
                        path=start_tl.path,
                        start_line_no=start_tl.line_no,
                        end_path=end_tl.path,
                        end_line_no=end_tl.line_no,
                    )
                )
                if len(blocks) >= max_blocks:
                    warnings.append("[warn] max_blocks exceeded; truncating env extraction")
                    return blocks, warnings

    if stack:
        warnings.append(f"[warn] unclosed TeX environment(s) detected: {len(stack)}")
    return blocks, warnings


def extract_occurrences(flat: list[TexLine]) -> tuple[list[TexOccurrence], list[TexOccurrence], list[TexOccurrence], list[TexOccurrence]]:
    cite_re = re.compile(r"\\(?P<cmd>[A-Za-z]*cite[A-Za-z*]*)\s*(?:\\[[^\\]]*\\]\\s*)*{")
    label_re = re.compile(r"\\label\\s*{")
    ref_re = re.compile(r"\\(?P<cmd>ref|eqref|cref|Cref|autoref|pageref|vref)\\s*{")
    fig_re = re.compile(r"\\includegraphics\\s*(?:\\[[^\\]]*\\]\\s*)?{")

    cites: list[TexOccurrence] = []
    labels: list[TexOccurrence] = []
    refs: list[TexOccurrence] = []
    figs: list[TexOccurrence] = []

    for idx, tl in enumerate(flat):
        clean = strip_tex_comments(tl.text)

        for m in cite_re.finditer(clean):
            brace_pos = m.end() - 1
            content, end_idx, end_col = _read_balanced_braces(flat, idx, brace_pos)
            for k in [x.strip() for x in content.split(",")]:
                if k:
                    cites.append(TexOccurrence(kind=m.group("cmd"), value=k, path=tl.path, line_no=tl.line_no))

        for m in label_re.finditer(clean):
            brace_pos = m.end() - 1
            content, end_idx, end_col = _read_balanced_braces(flat, idx, brace_pos)
            k = content.strip()
            if k:
                labels.append(TexOccurrence(kind="label", value=k, path=tl.path, line_no=tl.line_no))

        for m in ref_re.finditer(clean):
            brace_pos = m.end() - 1
            content, end_idx, end_col = _read_balanced_braces(flat, idx, brace_pos)
            k = content.strip()
            if k:
                refs.append(TexOccurrence(kind=m.group("cmd"), value=k, path=tl.path, line_no=tl.line_no))

        for m in fig_re.finditer(clean):
            brace_pos = m.end() - 1
            content, end_idx, end_col = _read_balanced_braces(flat, idx, brace_pos)
            k = content.strip()
            if k:
                figs.append(TexOccurrence(kind="includegraphics", value=k, path=tl.path, line_no=tl.line_no))

    return cites, labels, refs, figs


def extract_graphicspath_dirs(flat: list[TexLine]) -> list[TexOccurrence]:
    """
    Extract \\graphicspath directory specs.

    Supports common forms:
      \\graphicspath{{figs/}{../figures/}}
      \\graphicspath{ {figs/} {../figures/} }   (whitespace/newlines)
      (best-effort) \\graphicspath{figs/}
    """
    out: list[TexOccurrence] = []
    for idx, tl in enumerate(flat):
        clean = strip_tex_comments(tl.text)
        for m in _GRAPHICSPATH_RE.finditer(clean):
            brace_pos = m.end() - 1
            content, _end_idx, _end_col = _read_balanced_braces(flat, idx, brace_pos, max_chars=4000)
            inner = content.strip()
            dirs = [x.strip() for x in re.findall(r"{([^}]*)}", inner)]
            if not dirs and inner:
                dirs = [inner]
            for d in dirs:
                if d:
                    out.append(TexOccurrence(kind="graphicspath", value=d, path=tl.path, line_no=tl.line_no))
    return out


def slice_flat_lines(flat: list[TexLine], start_idx: int, end_idx: int, max_chars: int = 12000) -> str:
    if not flat:
        return ""
    start_idx = max(0, min(start_idx, len(flat) - 1))
    end_idx = max(start_idx, min(end_idx, len(flat)))
    out: list[str] = []
    total = 0
    for tl in flat[start_idx:end_idx]:
        s = tl.text
        out.append(s)
        total += len(s)
        if total >= max_chars:
            out.append("\n% [... truncated ...]\n")
            break
    return "".join(out)
