#!/usr/bin/env python3
"""
discover_latex_zero_arg_macros.py

Deterministically discover 0-argument custom LaTeX macros from local LaTeX sources
(typically downloaded under `references/arxiv_src/`) and produce:
- a JSON mapping suitable for `latex_macro_hygiene.expansions`, and/or
- an in-place update to a JSON `research_team_config.json` (explicit opt-in).

Why:
- Markdown math renderers generally do not know project/paper macros defined via `\\newcommand`.
- The research-team workflow enforces a fail-fast macro hygiene gate; this tool reduces
  manual macro-by-macro additions by extracting safe 0-arg definitions in bulk.

Scope / safety:
- Local-only, deterministic, no network, no TeX execution.
- Conservative: skips any macro definition that appears to take arguments.

Supported (0-arg only):
- \\newcommand{\\X}{...}
- \\renewcommand{\\X}{...}
- \\providecommand{\\X}{...}
- (limited) \\def\\X{...}
- \\DeclareMathOperator{\\X}{Name} / \\DeclareMathOperator*{\\X}{Name}

Exit codes:
  0  ok (including "no sources found" skip)
  1  conflicts detected (only when --strict)
  2  input/config error
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from dataclasses import dataclass
from pathlib import Path


sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "lib"))
from team_config import load_team_config  # type: ignore


_CMD_NEWLIKE = {"newcommand", "renewcommand", "providecommand"}
_CMD_DEF = "def"
_CMD_DECLARE = "DeclareMathOperator"


@dataclass(frozen=True)
class MacroDef:
    name: str  # without leading backslash
    expansion: str
    source: str
    line: int


def _read_text(path: Path) -> str:
    return path.read_text(encoding="utf-8", errors="replace").replace("\r\n", "\n").replace("\r", "\n")


def _strip_comments(text: str) -> str:
    out_lines: list[str] = []
    for ln in text.splitlines():
        cut = None
        for i, ch in enumerate(ln):
            if ch != "%":
                continue
            if i > 0 and ln[i - 1] == "\\":
                continue
            cut = i
            break
        out_lines.append(ln if cut is None else ln[:cut])
    return "\n".join(out_lines) + ("\n" if text.endswith("\n") else "")


def _is_name_char(ch: str) -> bool:
    return ("A" <= ch <= "Z") or ("a" <= ch <= "z") or (ch == "@")


def _read_control_sequence(text: str, i: int) -> tuple[str, int] | None:
    if i >= len(text) or text[i] != "\\":
        return None
    j = i + 1
    while j < len(text) and _is_name_char(text[j]):
        j += 1
    if j == i + 1:
        return None
    return text[i + 1 : j], j


def _skip_ws(text: str, i: int) -> int:
    while i < len(text) and text[i].isspace():
        i += 1
    return i


def _read_balanced(text: str, i: int, open_ch: str, close_ch: str) -> tuple[str, int] | None:
    if i >= len(text) or text[i] != open_ch:
        return None
    depth = 1
    start = i + 1
    i += 1
    while i < len(text):
        ch = text[i]
        if ch == "\\":
            i += 2
            continue
        if ch == open_ch:
            depth += 1
        elif ch == close_ch:
            depth -= 1
            if depth == 0:
                return text[start:i], i + 1
        i += 1
    return None


def _read_braced(text: str, i: int) -> tuple[str, int] | None:
    return _read_balanced(text, i, "{", "}")


def _read_bracket(text: str, i: int) -> tuple[str, int] | None:
    return _read_balanced(text, i, "[", "]")


def _parse_macro_name_from_group(group: str) -> str | None:
    s = group.strip()
    if not s.startswith("\\"):
        return None
    m = re.match(r"^\\([A-Za-z@]+)$", s)
    if not m:
        return None
    name = m.group(1)
    if "@" in name:
        return None
    return name


def _read_macro_name(text: str, i: int) -> tuple[str, int] | None:
    i = _skip_ws(text, i)
    if i >= len(text):
        return None
    if text[i] == "{":
        grp = _read_braced(text, i)
        if grp is None:
            return None
        body, j = grp
        name = _parse_macro_name_from_group(body)
        if not name:
            return None
        return name, j
    if text[i] == "\\":
        cs = _read_control_sequence(text, i)
        if cs is None:
            return None
        name, j = cs
        if "@" in name:
            return None
        return name, j
    return None


def _normalize_expansion(raw: str) -> str:
    s = raw.replace("\r\n", "\n").replace("\r", "\n")
    s = s.strip()
    s = re.sub(r"\s+", " ", s)
    s = re.sub(r"(\\xspace\s*)+$", "", s).strip()
    if not s:
        return ""
    if not (s.startswith("{") and s.endswith("}")):
        s = "{" + s + "}"
    return s


def _extract_from_text(text: str, *, source: str) -> list[MacroDef]:
    defs: list[MacroDef] = []
    text = _strip_comments(text)
    i = 0
    n = len(text)
    while i < n:
        if text[i] != "\\":
            i += 1
            continue
        cmd = _read_control_sequence(text, i)
        if cmd is None:
            i += 1
            continue
        name, j = cmd
        star = False
        if j < n and text[j] == "*":
            star = True
            j += 1

        if name in _CMD_NEWLIKE:
            k = _skip_ws(text, j)
            mname = _read_macro_name(text, k)
            if mname is None:
                i = j
                continue
            macro_name, k = mname
            k = _skip_ws(text, k)

            opt = _read_bracket(text, k)
            if opt is not None:
                opt_body, k2 = opt
                opt_s = opt_body.strip()
                k2 = _skip_ws(text, k2)
                opt2 = _read_bracket(text, k2)
                if opt2 is not None:
                    k = opt2[1]
                else:
                    k = k2
                grp = _read_braced(text, _skip_ws(text, k))
                if grp is not None:
                    i = grp[1]
                else:
                    i = k
                if opt_s == "0" and opt2 is None:
                    pass
                else:
                    continue

            grp = _read_braced(text, _skip_ws(text, k))
            if grp is None:
                i = k
                continue
            body, end = grp
            exp = _normalize_expansion(body)
            i = end
            if not exp:
                continue
            line = text.count("\n", 0, i) + 1
            defs.append(MacroDef(name=macro_name, expansion=exp, source=source, line=line))
            continue

        if name == _CMD_DEF:
            k = _skip_ws(text, j)
            mname = _read_macro_name(text, k)
            if mname is None:
                i = j
                continue
            macro_name, k = mname
            k = _skip_ws(text, k)
            param_end = k
            saw_hash = False
            while param_end < n and text[param_end] != "{":
                if text[param_end] == "#":
                    saw_hash = True
                    break
                if text[param_end] == "\n":
                    break
                param_end += 1
            grp = _read_braced(text, _skip_ws(text, param_end))
            if grp is None:
                i = param_end
                continue
            body, end = grp
            i = end
            if saw_hash:
                continue
            exp = _normalize_expansion(body)
            if not exp:
                continue
            line = text.count("\n", 0, i) + 1
            defs.append(MacroDef(name=macro_name, expansion=exp, source=source, line=line))
            continue

        if name == _CMD_DECLARE:
            k = _skip_ws(text, j)
            mname = _read_macro_name(text, k)
            if mname is None:
                i = j
                continue
            macro_name, k = mname
            grp = _read_braced(text, _skip_ws(text, k))
            if grp is None:
                i = k
                continue
            op, end = grp
            op_norm = re.sub(r"\s+", " ", op.strip())
            if not op_norm:
                i = end
                continue
            exp = "{\\operatorname" + ("*" if star else "") + "{" + op_norm + "}}"
            i = end
            line = text.count("\n", 0, i) + 1
            defs.append(MacroDef(name=macro_name, expansion=exp, source=source, line=line))
            continue

        i = j
    return defs


def _iter_source_files(root: Path, source_roots: list[Path], exts: tuple[str, ...]) -> list[Path]:
    files: list[Path] = []
    for sr in source_roots:
        sr_abs = sr if sr.is_absolute() else (root / sr)
        if not sr_abs.exists():
            continue
        if sr_abs.is_file():
            if sr_abs.suffix.lower() in exts:
                files.append(sr_abs)
            continue
        for p in sr_abs.rglob("*"):
            if not p.is_file():
                continue
            if ".git" in p.parts:
                continue
            if p.suffix.lower() not in exts:
                continue
            files.append(p)
    seen: set[Path] = set()
    uniq: list[Path] = []
    for p in files:
        if p in seen:
            continue
        seen.add(p)
        uniq.append(p)
    return sorted(uniq, key=lambda x: x.as_posix())


def _default_source_roots(root: Path) -> list[Path]:
    cand = root / "references" / "arxiv_src"
    return [cand] if cand.exists() else []


def _discover_macros(root: Path, source_roots: list[Path], *, exts: tuple[str, ...]) -> tuple[dict[str, MacroDef], dict[str, list[MacroDef]]]:
    files = _iter_source_files(root, source_roots, exts)
    macros: dict[str, MacroDef] = {}
    conflicts: dict[str, list[MacroDef]] = {}
    for p in files:
        rel = p.resolve().relative_to(root.resolve()).as_posix() if root.exists() else p.as_posix()
        for d in _extract_from_text(_read_text(p), source=rel):
            prev = macros.get(d.name)
            if prev is None:
                macros[d.name] = d
                continue
            if prev.expansion == d.expansion:
                continue
            conflicts.setdefault(d.name, [prev]).append(d)
    return macros, conflicts


def _load_raw_json(path: Path) -> dict | None:
    try:
        data = json.loads(path.read_text(encoding="utf-8", errors="replace"))
        return data if isinstance(data, dict) else None
    except Exception:
        return None


def _update_json_config(config_path: Path, macros: dict[str, MacroDef], conflicts: dict[str, list[MacroDef]], *, force: bool) -> tuple[int, int, int]:
    raw = _load_raw_json(config_path)
    if raw is None:
        raise ValueError(f"failed to load JSON config: {config_path}")

    lm = raw.get("latex_macro_hygiene")
    if not isinstance(lm, dict):
        lm = {}
        raw["latex_macro_hygiene"] = lm

    exp = lm.get("expansions")
    if not isinstance(exp, dict):
        exp = {}
        lm["expansions"] = exp

    forbid = lm.get("forbidden_macros")
    if not isinstance(forbid, list):
        forbid = []
        lm["forbidden_macros"] = forbid

    forbid_set = {str(x).strip() for x in forbid if str(x).strip()}

    added = 0
    skipped = 0
    conflicted = len(conflicts)
    for name in sorted(macros.keys()):
        if name in conflicts:
            skipped += 1
            continue
        d = macros[name]
        if name in exp and not force:
            skipped += 1
            continue
        exp[name] = d.expansion
        forbid_set.add(name)
        added += 1

    lm["forbidden_macros"] = sorted(forbid_set)

    config_path.write_text(json.dumps(raw, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    return added, skipped, conflicted


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--root", type=Path, default=Path("."), help="Project root (or any path inside the project).")
    ap.add_argument(
        "--source-root",
        action="append",
        default=[],
        help="LaTeX source directory/file (absolute or relative to project root). May be repeated.",
    )
    ap.add_argument(
        "--ext",
        action="append",
        default=[],
        help="File extension(s) to scan (default: .tex, .sty, .cls). May be repeated.",
    )
    ap.add_argument(
        "--format",
        choices=("expansions-json", "detailed-json"),
        default="expansions-json",
        help="Output format (default: expansions-json).",
    )
    ap.add_argument("--out", type=Path, default=None, help="Write output to this file instead of stdout.")
    ap.add_argument("--strict", action="store_true", help="Exit non-zero if conflicting macro definitions are detected.")
    ap.add_argument("--update-config", action="store_true", help="Merge discoveries into a JSON research_team_config.json (explicit opt-in).")
    ap.add_argument("--config", type=Path, default=None, help="Config path to update (JSON only). Default: auto-discover via team_config.")
    ap.add_argument("--force", action="store_true", help="When updating config, overwrite existing expansions (still skip conflicts).")
    args = ap.parse_args()

    seed = args.root
    if not seed.exists():
        print(f"ERROR: root not found: {seed}", file=sys.stderr)
        return 2

    cfg = load_team_config(seed)
    project_root = (cfg.path.parent if cfg.path is not None else (seed if seed.is_dir() else seed.parent)).resolve()

    src_roots: list[Path] = [Path(s) for s in args.source_root] if args.source_root else _default_source_roots(project_root)
    exts = tuple(sorted({("." + e.lstrip(".")) for e in (args.ext or []) if str(e).strip()})) or (".tex", ".sty", ".cls")

    macros, conflicts = _discover_macros(project_root, src_roots, exts=exts)

    if not macros:
        print("[skip] no 0-arg LaTeX macros discovered (no sources found or no supported definitions)")
        return 0

    if args.update_config:
        config_path = args.config
        if config_path is None:
            if cfg.path is None:
                config_path = project_root / "research_team_config.json"
            else:
                config_path = cfg.path
        if config_path.suffix.lower() != ".json":
            print(f"ERROR: --update-config currently supports JSON only (got {config_path})", file=sys.stderr)
            return 2
        if not config_path.exists():
            print(f"ERROR: config not found: {config_path}", file=sys.stderr)
            return 2
        try:
            added, skipped, conflicted = _update_json_config(config_path, macros, conflicts, force=bool(args.force))
        except Exception as exc:
            print(f"ERROR: failed to update config: {exc}", file=sys.stderr)
            return 2
        print("[ok] updated config with discovered macro expansions")
        print(f"- config: {config_path}")
        print(f"- added: {added}")
        print(f"- skipped: {skipped}")
        if conflicted:
            print(f"- conflicts: {conflicted} (not applied; see detailed-json output)")
        if args.strict and conflicted:
            return 1
        return 0

    if args.format == "expansions-json":
        out = {k: macros[k].expansion for k in sorted(macros.keys()) if k not in conflicts}
    else:
        out = {
            "version": 1,
            "project_root": project_root.as_posix(),
            "source_roots": [p.as_posix() for p in src_roots],
            "macros": {
                k: {"expansion": macros[k].expansion, "source": macros[k].source, "line": macros[k].line} for k in sorted(macros.keys())
            },
            "conflicts": {
                k: [{"expansion": d.expansion, "source": d.source, "line": d.line} for d in conflicts[k]] for k in sorted(conflicts.keys())
            },
        }
    payload = json.dumps(out, indent=2, sort_keys=True) + "\n"
    if args.out is not None:
        args.out.write_text(payload, encoding="utf-8")
    else:
        sys.stdout.write(payload)

    if args.strict and conflicts:
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

