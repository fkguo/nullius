#!/usr/bin/env python3
"""
Fail-fast validator for the mandatory "Reproducibility Capsule" in Draft_Derivation.md.

Exit codes:
  0  Capsule present and minimally complete
  1  Capsule missing or incomplete
  2  Input error (file not found, etc.)
"""

from __future__ import annotations

import argparse
import os
import re
from dataclasses import dataclass
from pathlib import Path
import sys
import json
import subprocess
from urllib.parse import parse_qs, urlsplit
import csv

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "lib"))
from team_config import load_team_config  # type: ignore


START = "<!-- REPRO_CAPSULE_START -->"
END = "<!-- REPRO_CAPSULE_END -->"


@dataclass(frozen=True)
class CapsuleCheck:
    ok: bool
    errors: list[str]
    warnings: list[str]

def _load_capsule_config(notes: Path) -> dict:
    cfg = load_team_config(notes)
    capsule_cfg = cfg.data.get("capsule", {}) if isinstance(cfg.data, dict) else {}
    return capsule_cfg if isinstance(capsule_cfg, dict) else {}


def _load_project_stage(notes: Path) -> str:
    cfg = load_team_config(notes)
    stage = str(cfg.data.get("project_stage", "development")).strip().lower() if isinstance(cfg.data, dict) else ""
    if stage not in ("exploration", "development", "publication"):
        return "development"
    return stage


def _load_exploration_minimal_capsule_config(notes: Path) -> dict:
    capsule_cfg = _load_capsule_config(notes)
    v = capsule_cfg.get("exploration_minimal", {}) if isinstance(capsule_cfg, dict) else {}
    return v if isinstance(v, dict) else {}

def _get_min_headlines(notes: Path) -> int | None:
    capsule_cfg = _load_capsule_config(notes)
    stage = _load_project_stage(notes)
    if stage == "exploration":
        expl = _load_exploration_minimal_capsule_config(notes)
        if bool(expl.get("enabled", True)):
            v = expl.get("min_headline_numbers")
            if isinstance(v, int):
                return v
            return 0
    val = capsule_cfg.get("min_headline_numbers") if isinstance(capsule_cfg, dict) else None
    if isinstance(val, int):
        return val
    return None

def _get_min_nontrivial_headlines(notes: Path) -> int | None:
    capsule_cfg = _load_capsule_config(notes)
    stage = _load_project_stage(notes)
    if stage == "exploration":
        expl = _load_exploration_minimal_capsule_config(notes)
        if bool(expl.get("enabled", True)):
            v = expl.get("min_nontrivial_headlines")
            if isinstance(v, int):
                return v
            return 0
    val = capsule_cfg.get("min_nontrivial_headlines") if isinstance(capsule_cfg, dict) else None
    if isinstance(val, int):
        return val
    return None

def _get_nontrivial_tiers(notes: Path) -> list[str] | None:
    capsule_cfg = _load_capsule_config(notes)
    val = capsule_cfg.get("nontrivial_tiers") if isinstance(capsule_cfg, dict) else None
    if not isinstance(val, list):
        return None
    out: list[str] = []
    for x in val:
        s = str(x).strip().upper()
        if s:
            out.append(s)
    return out or None


def _extract_capsule(text: str) -> str | None:
    if START not in text or END not in text:
        return None
    a = text.index(START) + len(START)
    b = text.index(END)
    capsule = text[a:b].strip()
    return capsule if capsule else ""


def _has_code_fence_command(capsule: str) -> bool:
    # Look for a bash fenced block with something inside.
    m = re.search(r"```bash\s+([\s\S]*?)```", capsule, flags=re.IGNORECASE)
    if not m:
        return False
    content = m.group(1).strip()
    # Require at least one non-comment, non-empty line.
    for ln in content.splitlines():
        s = ln.strip()
        if not s or s.startswith("#"):
            continue
        return True
    return False


def _count_headlines(capsule: str) -> int:
    # Accept "- H1:" style (preferred).
    return len(re.findall(r"^\s*-\s*H\d+\s*:", capsule, flags=re.MULTILINE))

def _headlines_have_sources(capsule: str, required_count: int) -> bool:
    # Require each H-line to include a "(from ...)" pointer so we can verify against artifacts.
    hs = [ln.strip() for ln in capsule.splitlines() if re.match(r"^\s*-\s*H\d+\s*:", ln)]
    if required_count <= 0:
        if not hs:
            return True
        required_count = 1
    if len(hs) < required_count:
        return False
    for ln in hs[:required_count]:
        if "(from" not in ln.lower():
            return False
    return True

def _find_min_headlines_overrides(capsule: str) -> list[int]:
    # Per-capsule override to allow milestone-specific headline requirements.
    #
    # Allow trailing comments so templates like:
    #   - Min headline numbers: 0  # no meaningful numeric headlines
    # still parse correctly.
    pat = r"^\s*(?:-\s*)?Min headline numbers\s*:\s*(\d+)\s*(?:#.*)?$"
    vals: list[int] = []
    for s in re.findall(pat, capsule, flags=re.IGNORECASE | re.MULTILINE):
        try:
            v = int(s)
        except ValueError:
            continue
        if v < 0:
            continue
        vals.append(v)
    return vals

def _find_min_nontrivial_headlines_overrides(capsule: str) -> list[int]:
    # Per-capsule override to allow milestone-specific nontrivial headline requirements.
    #
    # Allow trailing comments so templates like:
    #   - Min nontrivial headlines: 0  # no meaningful diagnostic headline this round
    # still parse correctly.
    pat = r"^\s*(?:-\s*)?Min\s+nontrivial\s+headlines\s*:\s*(\d+)\s*(?:#.*)?$"
    vals: list[int] = []
    for s in re.findall(pat, capsule, flags=re.IGNORECASE | re.MULTILINE):
        try:
            v = int(s)
        except ValueError:
            continue
        if v < 0:
            continue
        vals.append(v)
    return vals


def _parse_outputs_list(capsule: str) -> list[str]:
    sec = _extract_section(capsule, r"D\)\s+Expected outputs")
    if not sec:
        return []
    outs: list[str] = []
    for ln in sec.splitlines():
        m = re.match(r"^\s*-\s*(\S+)\s*$", ln)
        if not m:
            continue
        outs.append(m.group(1))
    return outs

def _parse_milestone_kind(capsule: str) -> str:
    """
    Optional: allow users to declare milestone kind to avoid over-constraining pure-theory milestones.
      - Milestone kind: computational
      - Milestone kind: theory
      - Milestone kind: dataset
    Accepted synonyms: compute, computation, numeric, numerics, theory-only, data_prep.
    Default: computational (strict).
    """
    for ln in capsule.splitlines():
        m = re.match(r"^\s*(?:-\s*)?Milestone kind\s*:\s*(.+?)\s*$", ln, flags=re.IGNORECASE)
        if not m:
            continue
        v = m.group(1).strip().lower()
        if v in ("theory", "theory-only", "analytic", "derivation"):
            return "theory"
        if v in ("dataset", "data_prep", "data-prep", "dataprep", "data", "generate-data"):
            return "dataset"
        if v in ("computational", "compute", "computation", "numeric", "numerics", "simulation", "dns"):
            return "computational"
        return v
    return "computational"

def _parse_headline_tier(rest: str) -> str | None:
    # Preferred: [T1] / [T2] / [T3]
    m = re.search(r"\[\s*(T[123])\s*\]", rest, flags=re.IGNORECASE)
    if m:
        return m.group(1).upper()
    # Accept: tier=T2 / Tier: T2 / (tier=T2)
    m = re.search(r"(?:^|[^A-Za-z])tier\s*[:=]\s*(T[123])(?:[^A-Za-z]|$)", rest, flags=re.IGNORECASE)
    if m:
        return m.group(1).upper()
    return None


def _parse_headline_sources(
    capsule: str,
) -> list[tuple[str, str | None, float | None, str | None, float | None, float | None, bool]]:
    """
    Parse section E headline lines.

    Supports optional tolerance annotations (recommended for floating-point results):
      - (tol=1e-3)   absolute tolerance
      - (rtol=1e-3)  relative tolerance
      - (exact)      require exact match (diff==0)
    """
    items: list[tuple[str, str | None, float | None, str | None, float | None, float | None, bool]] = []
    for ln in capsule.splitlines():
        m_label = re.match(r"^\s*-\s*(H\d+)\s*:\s*(.*)$", ln)
        if not m_label:
            continue
        label = m_label.group(1)
        rest = m_label.group(2)
        tier = _parse_headline_tier(rest)
        m_val = re.search(r"(?:=|≈|\\simeq)\s*([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?)", rest)
        reported = float(m_val.group(1)) if m_val else None
        m_from = re.search(r"\(from\s+([^)]+)\)", rest, flags=re.IGNORECASE)
        source = m_from.group(1).strip() if m_from else None
        m_tol = re.search(r"\(\s*tol\s*=\s*([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?)\s*\)", rest, flags=re.IGNORECASE)
        m_rtol = re.search(r"\(\s*rtol\s*=\s*([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?)\s*\)", rest, flags=re.IGNORECASE)
        exact = bool(re.search(r"\(\s*exact\s*\)", rest, flags=re.IGNORECASE))
        tol_abs = float(m_tol.group(1)) if m_tol else None
        tol_rel = float(m_rtol.group(1)) if m_rtol else None
        items.append((label, tier, reported, source, tol_abs, tol_rel, exact))
    return items


def _extract_numeric_from_json(obj: object, dot_path: str) -> float | None:
    cur = obj
    for tok in [t for t in dot_path.split(".") if t]:
        if isinstance(cur, list):
            cur = cur[int(tok)]
        elif isinstance(cur, dict):
            cur = cur[tok]
        else:
            return None
    if isinstance(cur, (int, float)):
        return float(cur)
    return None


def _json_pointer_get(obj: object, pointer: str) -> object:
    if pointer == "" or pointer == "/":
        return obj
    if not pointer.startswith("/"):
        raise ValueError(f"JSON pointer must start with '/': {pointer}")
    cur = obj
    for raw in pointer.split("/")[1:]:
        tok = raw.replace("~1", "/").replace("~0", "~")
        if isinstance(cur, list):
            cur = cur[int(tok)]
        elif isinstance(cur, dict):
            cur = cur[tok]
        else:
            raise KeyError(f"Cannot descend into non-container at token {tok}")
    return cur


def _extract_headline_value_from_source(source_spec: str, cwd: Path) -> float | None:
    # CSV query spec (Scheme B):
    #   path/to.csv?where=col:value&field=target_col
    # Only supports a single equality filter (where) and a single numeric field extraction.
    if "?" in source_spec and ".csv" in source_spec.lower():
        return _extract_headline_value_from_csv_query(source_spec, cwd)

    if "#" in source_spec:
        path_s, pointer = source_spec.split("#", 1)
        path = Path(path_s)
        if not path.is_absolute():
            path = cwd / path
        if path.suffix.lower() != ".json":
            return None
        obj = json.loads(path.read_text(encoding="utf-8"))
        val = _json_pointer_get(obj, pointer)
        return float(val) if isinstance(val, (int, float)) else None
    if ":" not in source_spec:
        return None
    path_s, dot = source_spec.rsplit(":", 1)
    path = Path(path_s)
    if not path.is_absolute():
        path = cwd / path
    if path.suffix.lower() != ".json":
        return None
    obj = json.loads(path.read_text(encoding="utf-8"))
    return _extract_numeric_from_json(obj, dot)


def _try_float(s: str) -> float | None:
    try:
        return float(s)
    except Exception:
        return None


def _extract_headline_value_from_csv_query(source_spec: str, cwd: Path) -> float | None:
    """
    Parse and execute:
      path/to.csv?where=col:value&field=target_col
    Rules:
      - exactly one where and one field
      - where is "col:value" (no URL-decoding tricks required; standard encoding ok)
      - matches exactly one row (string match or numeric match)
      - field must exist and be numeric
    """
    u = urlsplit(source_spec)
    path_s = u.path
    q = parse_qs(u.query, keep_blank_values=True)
    where_vals = q.get("where", [])
    field_vals = q.get("field", [])
    if len(where_vals) != 1 or len(field_vals) != 1:
        raise ValueError("CSV query must include exactly one 'where' and one 'field' parameter")
    where = where_vals[0]
    field = field_vals[0].strip()
    if ":" not in where or not field:
        raise ValueError("CSV query requires where=col:value and non-empty field=target_col")
    where_col, where_val_raw = where.split(":", 1)
    where_col = where_col.strip()
    where_val_raw = where_val_raw.strip()
    if not where_col or not where_val_raw:
        raise ValueError("CSV query requires non-empty where column and value")

    path = Path(path_s)
    if not path.is_absolute():
        path = cwd / path
    if path.suffix.lower() != ".csv":
        raise ValueError("CSV query path must end with .csv")
    if not path.exists():
        raise FileNotFoundError(path)

    with path.open("r", encoding="utf-8", newline="") as f:
        reader = csv.DictReader(f)
        if reader.fieldnames is None:
            raise ValueError("CSV has no header row")
        if where_col not in reader.fieldnames:
            raise ValueError(f"CSV missing where column: {where_col}")
        if field not in reader.fieldnames:
            raise ValueError(f"CSV missing field column: {field}")

        matched_rows: list[dict[str, str]] = []
        where_val_f = _try_float(where_val_raw)
        for row in reader:
            cell = (row.get(where_col) or "").strip()
            if cell == "":
                continue
            if where_val_f is not None:
                cell_f = _try_float(cell)
                if cell_f is not None:
                    # Numeric match with small tolerance (covers "0.14" vs "0.1400").
                    diff = abs(cell_f - where_val_f)
                    tol = max(1e-12, 1e-12 * max(abs(cell_f), abs(where_val_f)))
                    if diff <= tol:
                        matched_rows.append(row)
                        continue
            if cell == where_val_raw:
                matched_rows.append(row)

        if len(matched_rows) != 1:
            raise ValueError(f"CSV query must match exactly 1 row, got {len(matched_rows)} (where={where_col}:{where_val_raw})")
        val_raw = (matched_rows[0].get(field) or "").strip()
        val_f = _try_float(val_raw)
        if val_f is None:
            raise ValueError(f"CSV field '{field}' value is not numeric: {val_raw!r}")
        return float(val_f)


def _is_supported_headline_source_spec(source_spec: str) -> bool:
    """
    Supported source spec formats:
    - JSON (Scheme A, recommended):
      - path/to/file.json:dot.path
      - path/to/file.json#/json/pointer
    - CSV (Scheme B, supported):
      - path/to/file.csv?where=col:value&field=target_col

    Not supported:
    - natural-language specs like "CSV row with ..."
    - whitespace inside the source spec
    """
    if not source_spec or any(ch.isspace() for ch in source_spec):
        return False
    # CSV query spec
    if ".csv" in source_spec.lower():
        if "?" not in source_spec:
            return False
        u = urlsplit(source_spec)
        if not u.path.lower().endswith(".csv"):
            return False
        q = parse_qs(u.query, keep_blank_values=True)
        where_vals = q.get("where", [])
        field_vals = q.get("field", [])
        if len(where_vals) != 1 or len(field_vals) != 1:
            return False
        where = where_vals[0]
        field = field_vals[0]
        return (":" in where) and bool(field.strip())
    if "#" in source_spec:
        path_s = source_spec.split("#", 1)[0]
        return path_s.lower().endswith(".json")
    if ":" in source_spec:
        path_s = source_spec.rsplit(":", 1)[0]
        return path_s.lower().endswith(".json")
    return False


def _paths_exist(paths: list[str], cwd: Path) -> tuple[list[str], list[str]]:
    exists: list[str] = []
    missing: list[str] = []
    for p in paths:
        path = Path(p)
        if not path.is_absolute():
            path = cwd / path
        if path.exists():
            exists.append(p)
        else:
            missing.append(p)
    return exists, missing


def _has_placeholder_tokens(capsule: str) -> bool:
    # Common placeholders from the template that must NOT remain in a "complete" capsule.
    placeholders = [
        "<FULL COMMAND LINE>",
        "<path/to/",
        "<quantity>",
        "<value>",
        "<units>",
        "<YYYY-MM-DD>",
        "<e.g.",
    ]
    lower = capsule.lower()
    for ph in placeholders:
        if ph.lower() in lower:
            return True
    return False


def _has_outputs(capsule: str) -> bool:
    # Accept any list items that look like paths (contain / or .json/.csv/.png etc.).
    # We require at least ONE path-like bullet under Expected outputs section.
    sec = _extract_section(capsule, r"D\)\s+Expected outputs")
    if not sec:
        return False
    # Accept any path-like bullet. Prefer: contains '/' or has an extension.
    return bool(re.search(r"^\s*-\s*\S+(/|\.[A-Za-z0-9]{1,8})\b", sec, flags=re.MULTILINE))


def _extract_section(capsule: str, heading_pattern: str) -> str:
    # Capture from a matching heading line until the next "###" heading or end.
    m = re.search(rf"^###\s+{heading_pattern}.*?$", capsule, flags=re.MULTILINE)
    if not m:
        return ""
    start = m.end()
    m2 = re.search(r"^###\s+", capsule[start:], flags=re.MULTILINE)
    end = start + (m2.start() if m2 else len(capsule[start:]))
    return capsule[start:end].strip()


def _has_input_table(capsule: str) -> bool:
    sec = _extract_section(capsule, r"B\)\s+Exact inputs")
    if not sec:
        return False
    # Heuristic: require at least one pipe-row and one separator row.
    has_row = bool(re.search(r"^\s*\|.+\|\s*$", sec, flags=re.MULTILINE))
    # Allow alignment colons like ---: or :---:.
    has_sep = bool(re.search(r"^\s*\|(?:\s*:?-{3,}:?\s*\|)+\s*$", sec, flags=re.MULTILINE))
    return has_row and has_sep


def _has_truncation_info(capsule: str) -> bool:
    sec = _extract_section(capsule, r"A\)\s+Model")
    if not sec:
        return False
    required_phrases = [
        "Retained terms",
        "Dropped terms",
    ]
    return all(phrase in sec for phrase in required_phrases)


def _has_env_and_sources(capsule: str) -> bool:
    sec = _extract_section(capsule, r"F\)\s+Environment")
    if not sec:
        return False
    has_julia = bool(re.search(r"julia\s*:\s*\S+", sec, flags=re.IGNORECASE))
    has_python = bool(re.search(r"python\s*:\s*\S+", sec, flags=re.IGNORECASE))
    has_numpy = bool(re.search(r"numpy\s*:\s*\S+", sec, flags=re.IGNORECASE))
    # Julia reproducibility typically requires Project.toml + Manifest.toml (or at least Manifest.toml pinned).
    has_julia_manifest = bool(re.search(r"\bManifest\.toml\b", sec))
    # Require at least one real source pointer bullet (no "<path/to...>") and at least one hash/commit token.
    has_source_bullet = bool(re.search(r"^\s*-\s+[^<].*\.(py|jl|m|c|cpp|h|ts|js)", sec, flags=re.MULTILINE | re.IGNORECASE))
    has_hashish = bool(re.search(r"\b(sha256=|git=|commit=)\b", sec))
    # Language policy:
    # - Prefer Julia for numerics, but allow Python-only projects.
    # - If Python is listed, require numpy (otherwise environment is underspecified for numeric work).
    has_some_runtime = has_julia or has_python
    python_ok = (not has_python) or has_numpy
    julia_ok = (not has_julia) or has_julia_manifest
    return has_some_runtime and python_ok and julia_ok and has_source_bullet and has_hashish


def _figure_outputs(outs: list[str]) -> list[str]:
    fig_exts = (".png", ".pdf", ".svg", ".jpg", ".jpeg")
    return [p for p in outs if p.lower().endswith(fig_exts)]

def _data_outputs(outs: list[str]) -> list[str]:
    data_exts = (
        ".json",
        ".csv",
        ".tsv",
        ".h5",
        ".hdf5",
        ".parquet",
        ".nc",
        ".npz",
        ".npy",
        ".mat",
        ".fits",
        ".root",
    )
    return [p for p in outs if p.lower().endswith(data_exts)]

def _rich_data_outputs(outs: list[str]) -> list[str]:
    rich_exts = (".h5", ".hdf5", ".nc", ".npz", ".parquet", ".fits", ".root")
    return [p for p in outs if p.lower().endswith(rich_exts)]


def _embedded_figure_refs(notebook_text: str) -> list[str]:
    refs: list[str] = []
    refs.extend(re.findall(r"!\[[^\]]*\]\(\s*([^)]+?)\s*\)", notebook_text))
    refs.extend(re.findall(r"<img[^>]+src=[\"']([^\"']+)[\"']", notebook_text, flags=re.IGNORECASE))
    cleaned: list[str] = []
    for r in refs:
        s = r.strip()
        if not s or s.startswith(("http://", "https://", "data:")):
            continue
        cleaned.append(s.split()[0])
    return cleaned


def _embedded_figure_matches_outputs_and_exists(notebook_path: Path, outs: list[str]) -> tuple[bool, str]:
    """
    Require that at least one embedded figure reference:
      (a) corresponds to one of the listed figure outputs (by exact path or basename), and
      (b) resolves to an existing file on disk relative to the notebook directory.
    """
    figs = _figure_outputs(outs)
    if not figs:
        return (False, "no figure outputs listed")
    text = notebook_path.read_text(encoding="utf-8", errors="replace")
    refs = _embedded_figure_refs(text)
    if not refs:
        return (False, "no embedded figure references found in notebook")

    fig_basenames = {Path(p).name for p in figs}
    notebook_dir = notebook_path.parent.resolve()
    for ref in refs:
        ref_path = Path(ref)
        ref_base = ref_path.name
        if not ref_base:
            continue
        # Resolve which declared outputs this ref could mean.
        candidates: list[str] = []
        if ref in figs:
            candidates = [ref]
        else:
            candidates = [p for p in figs if Path(p).name == ref_base]
        if not candidates:
            continue
        if len(candidates) > 1 and ref not in figs:
            return (
                False,
                f"embedded figure ref '{ref}' is ambiguous (matches multiple declared outputs by basename): {', '.join(candidates[:3])}"
                + (" ..." if len(candidates) > 3 else ""),
            )
        p = ref_path if ref_path.is_absolute() else (notebook_dir / ref_path)
        if p.exists():
            return (True, "")
        return (False, f"embedded figure ref does not exist on disk: {ref} (resolved to {p})")
    return (False, "no embedded figure reference matches any listed figure output (by path or basename)")


def _has_embedded_figures(notebook_text: str, outs: list[str]) -> bool:
    figs = _figure_outputs(outs)
    if not figs:
        return False
    # Accept Markdown images ![](path) or HTML <img src="path">. Match either exact relative path
    # or just basename (some users move figures under the same name).
    for p in figs:
        base = Path(p).name
        pats = [
            rf"!\[[^\]]*\]\(\s*{re.escape(p)}\s*\)",
            rf"!\[[^\]]*\]\(\s*{re.escape(base)}\s*\)",
            rf"<img[^>]+src=[\"']{re.escape(p)}[\"']",
            rf"<img[^>]+src=[\"']{re.escape(base)}[\"']",
        ]
        if any(re.search(pt, notebook_text, flags=re.IGNORECASE) for pt in pats):
            return True
    return False


def _has_sweep_semantics(capsule: str) -> bool:
    sec = _extract_section(capsule, r"G\)\s+Sweep semantics\s*/\s*parameter dependence")
    if not sec:
        return False
    # Require the exact keywords and at least one non-whitespace character after ':'.
    required = [
        r"^\s*(?:-\s*)?Scanned variables:\s*\S",
        r"^\s*(?:-\s*)?Dependent recomputations:\s*\S",
        r"^\s*(?:-\s*)?Held-fixed constants:\s*\S",
    ]
    if not all(re.search(pat, sec, flags=re.MULTILINE) for pat in required):
        return False
    # Reject obvious "non-content" placeholders (keep conservative to avoid false positives).
    placeholder_patterns = [
        r"^\s*(?:-\s*)?Scanned variables:\s*(?:<[^>]+>|\(.*?略.*?\)|（.*?略.*?）|tbd|todo|fill)\s*$",
        r"^\s*(?:-\s*)?Dependent recomputations:\s*(?:<[^>]+>|\(.*?略.*?\)|（.*?略.*?）|tbd|todo|fill)\s*$",
        r"^\s*(?:-\s*)?Held-fixed constants:\s*(?:<[^>]+>|\(.*?略.*?\)|（.*?略.*?）|tbd|todo|fill)\s*$",
    ]
    for pat in placeholder_patterns:
        if re.search(pat, sec, flags=re.IGNORECASE | re.MULTILINE):
            return False
    return True

def _has_branch_contract_stub(capsule: str) -> bool:
    sec = _extract_section(capsule, r"H\)\s+Branch Semantics\s*/\s*Multi-root Contract")
    if not sec:
        return False
    # Require two fixed keyword lines so downstream branch gate can reason about applicability.
    required = [
        r"^\s*(?:-\s*)?Multi-root quantities:\s*\S",
        r"^\s*(?:-\s*)?Bands shown:\s*\S",
    ]
    return all(re.search(pat, sec, flags=re.IGNORECASE | re.MULTILINE) for pat in required)

def _resolve_repo_root(start_dir: Path) -> Path | None:
    try:
        out = subprocess.check_output(
            ["git", "-C", str(start_dir), "rev-parse", "--show-toplevel"],
            stderr=subprocess.DEVNULL,
        ).decode("utf-8", errors="replace").strip()
        return Path(out).resolve() if out else None
    except Exception:
        return None


def check_capsule(
    path: Path,
    resolve_relative_to: str = "notebook",
    root: Path | None = None,
    min_headlines: int = 3,
) -> CapsuleCheck:
    text = path.read_text(encoding="utf-8", errors="replace")
    capsule = _extract_capsule(text)
    if capsule is None:
        return CapsuleCheck(ok=False, errors=[f"Missing capsule markers {START} ... {END}"], warnings=[])

    errors: list[str] = []
    warnings: list[str] = []
    team_cfg = load_team_config(path)
    stage = (
        str(team_cfg.data.get("project_stage", "development")).strip().lower()
        if isinstance(team_cfg.data, dict)
        else "development"
    )
    if stage not in ("exploration", "development", "publication"):
        stage = "development"
    capsule_cfg = team_cfg.data.get("capsule", {}) if isinstance(team_cfg.data, dict) else {}
    capsule_cfg = capsule_cfg if isinstance(capsule_cfg, dict) else {}
    expl_cfg = capsule_cfg.get("exploration_minimal", {}) if isinstance(capsule_cfg, dict) else {}
    expl_cfg = expl_cfg if isinstance(expl_cfg, dict) else {}
    exploration_minimal = (stage == "exploration") and bool(expl_cfg.get("enabled", True))
    if exploration_minimal:
        warnings.append("Project stage=exploration: using minimal Capsule validation (non-blocking for early research).")
    overrides = _find_min_headlines_overrides(capsule)
    if overrides:
        if len(overrides) > 1:
            warnings.append(f"Multiple 'Min headline numbers' overrides found; using last: {overrides[-1]}")
        min_headlines = overrides[-1]
    nontrivial_overrides = _find_min_nontrivial_headlines_overrides(capsule)
    if nontrivial_overrides and len(nontrivial_overrides) > 1:
        warnings.append(f"Multiple 'Min nontrivial headlines' overrides found; using last: {nontrivial_overrides[-1]}")
    notebook_dir = path.parent.resolve()
    # Resolve relative artifact paths relative to the notebook location by default.
    if root is not None:
        cwd = root.resolve()
    elif resolve_relative_to == "repo":
        rr = _resolve_repo_root(notebook_dir)
        if rr is None:
            return CapsuleCheck(
                ok=False,
                errors=[f"Could not resolve repo root via git from: {notebook_dir} (use --root or set --resolve-relative-to notebook)"],
                warnings=[],
            )
        cwd = rr
    else:
        cwd = notebook_dir

    milestone_kind = _parse_milestone_kind(capsule)

    if not _has_truncation_info(capsule):
        errors.append("Missing model/truncation details in section A (Retained terms / Dropped terms).")
    if not _has_input_table(capsule):
        errors.append("Missing inputs table in section B.")
    if not _has_code_fence_command(capsule):
        errors.append("Missing at least one non-empty fenced ```bash``` command in section C.")
    if not _has_outputs(capsule):
        errors.append("Missing expected output paths in section D.")
    else:
        outs = _parse_outputs_list(capsule)
        min_outputs = 2
        if exploration_minimal:
            try:
                min_outputs = int(expl_cfg.get("min_outputs", 1))
            except Exception:
                min_outputs = 1
            if min_outputs < 0:
                min_outputs = 0
        if len(outs) < min_outputs:
            errors.append(f"Expected outputs list should include at least {min_outputs} path(s) (found {len(outs)}).")

        figs = _figure_outputs(outs)
        data = _data_outputs(outs)
        rich = _rich_data_outputs(outs)

        if not exploration_minimal:
            if milestone_kind != "theory":
                if not data:
                    errors.append(
                        "Expected outputs in section D must include at least one data artifact "
                        "(.json/.csv/.tsv/.h5/.hdf5/.parquet/.nc/.npz/.npy/.mat/.fits/.root)."
                    )
                if milestone_kind == "dataset":
                    # Dataset/data-prep milestone: data is required, figures are optional.
                    if figs and _has_embedded_figures(text, outs):
                        ok_embed, why = _embedded_figure_matches_outputs_and_exists(path, outs)
                        if not ok_embed:
                            errors.append(f"Main figure embed check failed: {why}")
                else:
                    # Default computational: require at least one main figure and embed it.
                    if not figs:
                        errors.append(
                            "Expected outputs in section D must include at least one figure file (e.g. .png/.pdf) for main results."
                        )
                    if figs:
                        if not _has_embedded_figures(text, outs):
                            errors.append(
                                "Main figure(s) must be embedded in the notebook via Markdown image syntax (e.g. ![](figures/M2-r1_main.png))."
                            )
                        else:
                            ok_embed, why = _embedded_figure_matches_outputs_and_exists(path, outs)
                            if not ok_embed:
                                errors.append(f"Main figure embed check failed: {why}")
            else:
                # For pure-theory milestones, allow no figures/data, but still encourage at least one concrete artifact.
                if not (figs or data or rich):
                    warnings.append(
                        "Theory milestone: outputs list contains no figure/data artifacts; ensure you still provide auditable evidence (e.g. scripts, PDFs)."
                    )
        else:
            # Exploration minimal: allow early work to proceed without forcing figure/data/embed constraints.
            require_data = bool(expl_cfg.get("require_data_artifact", False))
            require_fig = bool(expl_cfg.get("require_figure_artifact", False))
            require_embed = bool(expl_cfg.get("require_figure_embed", False))
            if milestone_kind != "theory":
                if require_data and not data:
                    errors.append(
                        "Exploration minimal: expected outputs must include at least one data artifact "
                        "(.json/.csv/.tsv/.h5/.hdf5/.parquet/.nc/.npz/.npy/.mat/.fits/.root)."
                    )
                if milestone_kind != "dataset" and require_fig and not figs:
                    errors.append("Exploration minimal: expected outputs must include at least one figure file (e.g. .png/.pdf).")
                if require_embed and figs:
                    if not _has_embedded_figures(text, outs):
                        errors.append("Exploration minimal: figure outputs are listed but no figure is embedded in the notebook.")
                    else:
                        ok_embed, why = _embedded_figure_matches_outputs_and_exists(path, outs)
                        if not ok_embed:
                            errors.append(f"Exploration minimal: main figure embed check failed: {why}")

        _, missing_outs = _paths_exist(outs, cwd)
        if missing_outs:
            require_exists = True
            if exploration_minimal:
                require_exists = bool(expl_cfg.get("require_outputs_exist", True))
            msg = (
                f"Expected outputs missing on disk (run your reproduction command): {', '.join(missing_outs[:5])}"
                + (" ..." if len(missing_outs) > 5 else "")
            )
            if require_exists:
                errors.append(msg)
            else:
                warnings.append(msg)
    hcount = _count_headlines(capsule)
    if hcount < min_headlines:
        hint = ""
        if min_headlines > 0:
            hint = " If this milestone has no meaningful numeric headlines, set 'Min headline numbers: 0' in the capsule and provide audit slices / logic checks."
        errors.append(f"Need at least {min_headlines} headline numbers in section E (found {hcount}).{hint}")
    if not _headlines_have_sources(capsule, min_headlines):
        if min_headlines <= 1:
            required_label = "H1"
        else:
            required_label = f"H1-H{min_headlines}"
        errors.append(
            "Headline numbers must include artifact pointers like '(from path:field)' "
            f"(at least for {required_label})."
        )
    else:
        items = _parse_headline_sources(capsule)

        # Enforce a tier taxonomy so cross-checks cannot collapse into trivial arithmetic.
        # Deterministic contract:
        # - Every headline line must be tagged with [T1]/[T2]/[T3]
        # - Require at least N "nontrivial" headlines (default 1) tagged as T2/T3, unless explicitly overridden to 0.
        nontrivial_tiers = _get_nontrivial_tiers(path) or ["T2", "T3"]
        min_nontrivial = _get_min_nontrivial_headlines(path) or (1 if min_headlines > 0 else 0)
        if nontrivial_overrides:
            min_nontrivial = nontrivial_overrides[-1]

        missing_tiers = [label for (label, tier, _reported, _source, _tol_abs, _tol_rel, _exact) in items if tier is None]
        if missing_tiers:
            errors.append(
                "Headline numbers must include an explicit tier tag per line (use [T1]/[T2]/[T3]). "
                f"Missing tier tag for: {', '.join(missing_tiers[:12])}" + (" ..." if len(missing_tiers) > 12 else "")
            )

        nontrivial_count = sum(
            1
            for (_label, tier, _reported, _source, _tol_abs, _tol_rel, _exact) in items
            if tier is not None and tier.upper() in nontrivial_tiers
        )
        if min_nontrivial > 0 and nontrivial_count < min_nontrivial:
            errors.append(
                f"Need at least {min_nontrivial} nontrivial headline(s) in section E "
                f"(tiers {', '.join(nontrivial_tiers)}). Found {nontrivial_count}. "
                "Add a diagnostic headline (residual/error/convergence/two-method delta) with an artifact pointer."
            )
        if min_nontrivial > 0 and min_nontrivial > len(items):
            errors.append(f"Min nontrivial headlines ({min_nontrivial}) cannot exceed total headline count ({len(items)}).")

        # Validate the first N headlines can be extracted and match the reported value (within rounding tolerance).
        checked = 0
        check_limit = min_headlines if min_headlines > 0 else min(1, len(items))
        for label, _tier, reported, source, tol_abs, tol_rel, exact in items:
            if not label.startswith("H"):
                continue
            if source is None or reported is None:
                continue
            if checked >= check_limit:
                break
            if not _is_supported_headline_source_spec(source):
                errors.append(
                    f"{label}: unsupported headline source spec '{source}'. "
                    "Use JSON pointers like '(from path/to/analysis.json:results.q1)' or '(from path/to/analysis.json#/results/q1)', "
                    "or CSV queries like '(from path/to/data.csv?where=m_pi_gev:0.14&field=sA_re)'."
                )
                checked += 1
                continue
            # Extract referenced artifact path for existence checks.
            if "?" in source and ".csv" in source.lower():
                src_path = urlsplit(source).path
            else:
                src_path = source.split("#", 1)[0].split(":", 1)[0]
            if src_path:
                _, missing_src = _paths_exist([src_path], cwd)
                if missing_src:
                    errors.append(f"{label}: referenced artifact missing: {src_path}")
                    checked += 1
                    continue
            try:
                extracted = _extract_headline_value_from_source(source, cwd)
            except Exception as e:
                errors.append(f"{label}: failed to extract from '{source}': {e}")
                checked += 1
                continue
            if extracted is None:
                errors.append(f"{label}: extracted value is not numeric (or unsupported artifact type) from '{source}'")
                checked += 1
                continue
            diff = abs(extracted - reported)
            tol_default = max(1e-6, 1e-6 * max(abs(extracted), abs(reported)))
            tol = tol_default
            if tol_abs is not None:
                tol = max(tol, abs(tol_abs))
            if tol_rel is not None:
                tol = max(tol, abs(tol_rel) * max(abs(extracted), abs(reported)))
            if exact:
                tol = 0.0
            if diff > tol:
                why = f"diff={diff} > tol={tol}"
                if tol_abs is not None or tol_rel is not None or exact:
                    why += f" (declared: tol={tol_abs}, rtol={tol_rel}, exact={exact})"
                errors.append(f"{label}: reported={reported} but extracted={extracted} ({why})")
            checked += 1

    if min_headlines == 0:
        warnings.append("Min headline numbers set to 0: computation replication may be N/A; ensure audit slices / logic checks exist in the team packet.")
        if milestone_kind != "theory":
            warnings.append("Min headline numbers is 0 but Milestone kind is not theory; consider setting 'Milestone kind: theory' or provide numeric audit proxies.")
    if not _has_env_and_sources(capsule):
        msg = (
            "Missing environment versions and/or source pointers with hash/commit in section F. "
            "If you list Julia, you must also reference Manifest.toml (recommended: include sha256=...)."
        )
        if exploration_minimal and bool(expl_cfg.get("relax_env_and_sources", True)):
            warnings.append("Exploration minimal: " + msg)
        else:
            errors.append(msg)
    if not _has_sweep_semantics(capsule):
        errors.append(
            "Missing sweep semantics in section G. Require lines: "
            "'Scanned variables:', 'Dependent recomputations:', 'Held-fixed constants:' (with non-empty values)."
        )
    if not _has_branch_contract_stub(capsule):
        errors.append(
            "Missing branch semantics stub in section H. Require section 'H) Branch Semantics / Multi-root Contract' "
            "with lines 'Multi-root quantities:' and 'Bands shown:'. Use 'Multi-root quantities: none' if not applicable."
        )
    if _has_placeholder_tokens(capsule):
        errors.append("Capsule still contains template placeholders (e.g. <FULL COMMAND LINE>, <path/to/...>). Replace with real values.")

    # Soft warnings: encourage more package versions.
    if "scipy:" not in capsule.lower():
        warnings.append("scipy version not listed (recommended).")
    if "julia:" not in capsule.lower():
        warnings.append("julia version not listed (recommended; preferred for numerics).")

    return CapsuleCheck(ok=(len(errors) == 0), errors=errors, warnings=warnings)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--notes", type=Path, required=True, help="Path to Draft_Derivation.md (or equivalent).")
    ap.add_argument(
        "--min-headlines",
        type=int,
        default=None,
        help="Override minimum headline numbers (default: from config or 3).",
    )
    ap.add_argument(
        "--resolve-relative-to",
        choices=["notebook", "repo"],
        default="notebook",
        help="How to resolve relative paths in the capsule (default: notebook directory).",
    )
    ap.add_argument(
        "--root",
        type=Path,
        default=None,
        help="Explicit root directory used to resolve relative paths (overrides --resolve-relative-to).",
    )
    ap.add_argument("--strict", action="store_true", help="Treat warnings as errors.")
    args = ap.parse_args()

    if not args.notes.is_file():
        print(f"ERROR: file not found: {args.notes}")
        return 2

    notebook_dir = args.notes.parent.resolve()
    root_dir = args.root.resolve() if args.root is not None else None
    min_headlines = args.min_headlines
    if min_headlines is None:
        cfg_min = _get_min_headlines(args.notes)
        min_headlines = cfg_min if cfg_min is not None else 3
    result = check_capsule(
        args.notes,
        resolve_relative_to=args.resolve_relative_to,
        root=root_dir,
        min_headlines=min_headlines,
    )
    if result.ok and not (args.strict and result.warnings):
        print(f"[ok] Reproducibility Capsule complete: {args.notes}")
        if result.warnings:
            for w in result.warnings:
                print(f"[warn] {w}")
        return 0

    print(f"[fail] Reproducibility Capsule incomplete: {args.notes}")
    # Make path-resolution semantics explicit (so users don't need to read source).
    if root_dir is not None:
        resolve_base = root_dir
    elif args.resolve_relative_to == "repo":
        resolve_base = _resolve_repo_root(notebook_dir) or notebook_dir
    else:
        resolve_base = notebook_dir
    print(f"[info] Relative paths are resolved relative to: {resolve_base}")
    if resolve_base == notebook_dir:
        print(
            "[info] Example: if notebook is under 'LLM-notes/', then write outputs as 'artifacts/...' (NOT 'LLM-notes/artifacts/...')."
        )
    for e in result.errors:
        print(f"[error] {e}")
    if result.warnings:
        for w in result.warnings:
            print(f"[warn] {w}")
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
