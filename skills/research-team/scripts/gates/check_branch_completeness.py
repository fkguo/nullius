#!/usr/bin/env python3
"""
Fail-fast guardrail for multi-root / multi-branch scan semantics.

Why:
- When multiple roots/branches exist (poles/zeros/turning points), it is easy to silently mix branches in
  bands/uncertainty plots, making the shaded region semantically wrong even if solvers are correct.
- LLM reviewers often miss this unless the workflow forces an explicit branch contract + diagnostics.

This gate runs before any LLM calls (after scan-dependency gate) and enforces a minimal contract:
- Branch inventory + assignment rule + output mapping + at least one invariant + minimal diagnostic evidence.
- If bands are shown, require per-branch quantiles and per-branch n_ok counts.

Exit codes:
  0  ok (or not applicable: Multi-root quantities: none)
  1  contract missing/incomplete, missing columns, invariant violated, or pooled band detected
  2  input/config errors
"""

from __future__ import annotations

import argparse
import csv
import re
import sys
from dataclasses import dataclass
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "lib"))

from team_config import load_team_config  # type: ignore

START = "<!-- REPRO_CAPSULE_START -->"
END = "<!-- REPRO_CAPSULE_END -->"


@dataclass(frozen=True)
class BranchContract:
    applicable: bool
    bands_shown: bool
    branches: list[str]
    branch_outputs: dict[str, tuple[str, list[str]]]  # branch -> (csv_path, columns)
    ordering_invariant: tuple[str, str] | None  # (left_col, right_col)
    continuity_invariant: tuple[str, float] | None  # (col, max_abs_delta)
    label_stability_invariant: tuple[str, float] | None  # (switch_rate_col, max_fraction)
    scan_coordinate: str | None
    diagnostic_artifacts: list[str]


def _extract_capsule(text: str) -> str | None:
    if START not in text or END not in text:
        return None
    a = text.index(START) + len(START)
    b = text.index(END)
    capsule = text[a:b].strip()
    return capsule if capsule else ""


def _extract_section(capsule: str, heading_pattern: str) -> str:
    m = re.search(rf"^###\s+{heading_pattern}.*?$", capsule, flags=re.MULTILINE)
    if not m:
        return ""
    start = m.end()
    m2 = re.search(r"^###\s+", capsule[start:], flags=re.MULTILINE)
    end = start + (m2.start() if m2 else len(capsule[start:]))
    return capsule[start:end].strip()


def _parse_key_line(sec: str, key: str) -> str | None:
    for ln in sec.splitlines():
        m = re.match(rf"^\s*(?:-\s*)?{re.escape(key)}\s*:\s*(.+?)\s*$", ln, flags=re.IGNORECASE)
        if m:
            return m.group(1).strip()
    return None


def _parse_boolish(s: str) -> bool | None:
    # Allow inline comments like "no  # ..." in templates.
    v = s.split("#", 1)[0].strip().lower()
    if v in ("yes", "true", "1", "y"):
        return True
    if v in ("no", "false", "0", "n"):
        return False
    return None


def _split_csv_list(s: str) -> list[str]:
    parts = [p.strip() for p in re.split(r"[,\n]+", s) if p.strip()]
    return parts


def _parse_branch_outputs(h_sec: str) -> dict[str, tuple[str, list[str]]]:
    """
    Parse blocks like:
      - Branch connected:
        - Output file: runs/x/main.csv
        - Columns: connected_q05, connected_q50, connected_q95, connected_n_ok
    """
    out: dict[str, tuple[str, list[str]]] = {}
    lines = h_sec.splitlines()
    i = 0
    current: str | None = None
    cur_file: str | None = None
    cur_cols: list[str] = []
    while i < len(lines):
        ln = lines[i]
        m = re.match(r"^\s*-\s*Branch\s+(.+?)\s*:\s*$", ln, flags=re.IGNORECASE)
        if m:
            if current and cur_file and cur_cols:
                out[current] = (cur_file, cur_cols)
            current = m.group(1).strip()
            cur_file = None
            cur_cols = []
            i += 1
            continue
        if current:
            mfile = re.match(r"^\s*-\s*Output file\s*:\s*(\S+)\s*$", ln, flags=re.IGNORECASE)
            if mfile:
                cur_file = mfile.group(1).strip()
                i += 1
                continue
            mcols = re.match(r"^\s*-\s*Columns\s*:\s*(.+?)\s*$", ln, flags=re.IGNORECASE)
            if mcols:
                cur_cols = _split_csv_list(mcols.group(1))
                i += 1
                continue
        i += 1
    if current and cur_file and cur_cols:
        out[current] = (cur_file, cur_cols)
    return out


def _parse_ordering_invariant(h_sec: str) -> tuple[str, str] | None:
    v = _parse_key_line(h_sec, "Ordering invariant")
    if not v:
        return None
    m = re.match(r"^\s*([A-Za-z0-9_.-]+)\s*>=\s*([A-Za-z0-9_.-]+)\s*$", v)
    if not m:
        return None
    return (m.group(1), m.group(2))

def _parse_scan_coordinate(h_sec: str) -> str | None:
    v = _parse_key_line(h_sec, "Scan coordinate")
    if not v:
        return None
    col = v.strip()
    return col if col else None


def _parse_continuity_invariant(h_sec: str) -> tuple[str, float] | None:
    v = _parse_key_line(h_sec, "Continuity invariant")
    if not v:
        return None
    # Accept: abs_delta(col) <= number
    m = re.match(r"^\s*abs_delta\(\s*([A-Za-z0-9_.-]+)\s*\)\s*<=\s*([+-]?\d+(?:\.\d*)?(?:[eE][+-]?\d+)?)\s*$", v)
    if not m:
        # Accept: col max_abs_delta <= number
        m = re.match(r"^\s*([A-Za-z0-9_.-]+)\s+max_abs_delta\s*<=\s*([+-]?\d+(?:\.\d*)?(?:[eE][+-]?\d+)?)\s*$", v)
    if not m:
        return None
    col = m.group(1)
    try:
        thr = float(m.group(2))
    except Exception:
        return None
    return (col, thr)


def _parse_label_stability_invariant(h_sec: str) -> tuple[str, float] | None:
    v = _parse_key_line(h_sec, "Label stability")
    if not v:
        return None
    # Accept: col <= number
    m = re.match(r"^\s*([A-Za-z0-9_.-]+)\s*<=\s*([+-]?\d+(?:\.\d*)?(?:[eE][+-]?\d+)?)\s*$", v)
    if not m:
        return None
    col = m.group(1)
    try:
        thr = float(m.group(2))
    except Exception:
        return None
    return (col, thr)


def _parse_diagnostic_artifacts(h_sec: str) -> list[str]:
    out: list[str] = []
    for ln in h_sec.splitlines():
        m = re.match(r"^\s*-\s*Diagnostic artifact\s*:\s*(\S+)\s*$", ln, flags=re.IGNORECASE)
        if m:
            out.append(m.group(1).strip())
    return out


def parse_branch_contract(notes_path: Path) -> BranchContract:
    text = notes_path.read_text(encoding="utf-8", errors="replace")
    capsule = _extract_capsule(text)
    if capsule is None:
        raise ValueError("Missing capsule markers")
    h_sec = _extract_section(capsule, r"H\)\s+Branch Semantics\s*/\s*Multi-root Contract")
    if not h_sec:
        raise ValueError("Missing section H) Branch Semantics / Multi-root Contract")

    mr = _parse_key_line(h_sec, "Multi-root quantities")
    if mr is None:
        raise ValueError("Missing key line: Multi-root quantities:")
    bands = _parse_key_line(h_sec, "Bands shown")
    if bands is None:
        raise ValueError("Missing key line: Bands shown:")
    bands_b = _parse_boolish(bands)
    if bands_b is None:
        raise ValueError("Bands shown must be yes/no")

    applicable = mr.strip().lower() not in ("none", "n/a", "na", "no")

    branches_line = _parse_key_line(h_sec, "Branches") or ""
    branches = [] if branches_line.strip().lower() in ("", "none", "n/a", "na") else _split_csv_list(branches_line)

    outputs = _parse_branch_outputs(h_sec)
    ordering = _parse_ordering_invariant(h_sec)
    continuity = _parse_continuity_invariant(h_sec)
    label_stability = _parse_label_stability_invariant(h_sec)
    scan_coord = _parse_scan_coordinate(h_sec)
    diags = _parse_diagnostic_artifacts(h_sec)

    return BranchContract(
        applicable=applicable,
        bands_shown=bands_b,
        branches=branches,
        branch_outputs=outputs,
        ordering_invariant=ordering,
        continuity_invariant=continuity,
        label_stability_invariant=label_stability,
        scan_coordinate=scan_coord,
        diagnostic_artifacts=diags,
    )


def _read_csv_header(path: Path) -> list[str]:
    with path.open("r", encoding="utf-8", newline="") as f:
        reader = csv.reader(f)
        header = next(reader, None)
        if header is None:
            return []
        return [h.strip() for h in header]


def _iter_csv_rows(path: Path, max_rows: int = 2000) -> list[dict[str, str]]:
    with path.open("r", encoding="utf-8", newline="") as f:
        reader = csv.DictReader(f)
        rows: list[dict[str, str]] = []
        for i, row in enumerate(reader):
            if i >= max_rows:
                break
            rows.append({k: (v or "").strip() for k, v in row.items()})
        return rows


def _to_float(s: str) -> float | None:
    if s == "" or s.lower() == "nan":
        return None
    try:
        return float(s)
    except Exception:
        return None


def _notebook_text_without_capsule(text: str) -> str:
    if START not in text or END not in text:
        return text
    a = text.index(START)
    b = text.index(END) + len(END)
    return text[:a] + "\n\n" + text[b:]


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--notes", type=Path, required=True, help="Path to Draft_Derivation.md.")
    ap.add_argument(
        "--resolve-relative-to",
        choices=["notebook"],
        default="notebook",
        help="Currently only notebook-relative resolution is supported (consistent with Markdown embedding).",
    )
    ap.add_argument("--max-check-rows", type=int, default=200, help="Max rows to check for ordering invariant.")
    args = ap.parse_args()

    if not args.notes.is_file():
        print(f"ERROR: notes not found: {args.notes}", flush=True)
        return 2

    cfg = load_team_config(args.notes)
    if not cfg.feature_enabled("branch_semantics_gate", default=True):
        print("[skip] branch semantics gate disabled by research_team_config", flush=True)
        return 0
    strict_required = bool(cfg.data.get("branch_semantics", {}).get("require_when_declared", True))

    try:
        bc = parse_branch_contract(args.notes)
    except Exception as e:
        print("[fail] branch contract parse failed", flush=True)
        print(f"[error] {e}", flush=True)
        return 1

    if not bc.applicable:
        print("[ok] branch contract not applicable (Multi-root quantities: none)", flush=True)
        return 0

    errors: list[str] = []
    warnings: list[str] = []

    if not bc.branches:
        errors.append("Branch inventory missing: 'Branches:' must list all physically relevant branches (comma-separated).")

    # Outputs mapping: every declared branch must have an output file+columns block.
    for br in bc.branches:
        if br not in bc.branch_outputs:
            errors.append(f"Output mapping missing for branch '{br}' (expect '- Branch {br}:' block with Output file + Columns).")

    # Diagnostics: require at least one diagnostic artifact path.
    if not bc.diagnostic_artifacts:
        errors.append("Missing minimal diagnostic evidence: add at least one 'Diagnostic artifact: <path>' in section H.")

    notes_text = args.notes.read_text(encoding="utf-8", errors="replace")
    notes_wo_capsule = _notebook_text_without_capsule(notes_text)
    notebook_dir = args.notes.parent.resolve()

    # Check diagnostic artifacts exist.
    for p in bc.diagnostic_artifacts[:20]:
        path = Path(p)
        if not path.is_absolute():
            path = notebook_dir / path
        if not path.exists():
            errors.append(f"Diagnostic artifact missing on disk: {p}")

    # Column existence + (outside-capsule) references.
    for br, (csv_path_s, cols) in bc.branch_outputs.items():
        csv_path = Path(csv_path_s)
        if not csv_path.is_absolute():
            csv_path = notebook_dir / csv_path
        if not csv_path.exists():
            errors.append(f"Branch '{br}': output file missing on disk: {csv_path_s}")
            continue
        header = _read_csv_header(csv_path)
        if not header:
            errors.append(f"Branch '{br}': output CSV has no header/rows: {csv_path_s}")
            continue
        missing_cols = [c for c in cols if c not in header]
        if missing_cols:
            errors.append(f"Branch '{br}': missing columns in {csv_path_s}: {', '.join(missing_cols[:8])}" + (" ..." if len(missing_cols) > 8 else ""))

        # Require notebook cites which columns are used (outside capsule).
        # Minimal enforce: must mention csv path or at least one column name outside capsule.
        cited = (csv_path_s in notes_wo_capsule) or any(c in notes_wo_capsule for c in cols[:5])
        if not cited:
            errors.append(f"Branch '{br}': notebook does not cite columns for this branch outside capsule (mention '{csv_path_s}' and/or its columns in Results/plots section).")

        if bc.bands_shown:
            # Require per-branch quantiles and per-branch n_ok counts.
            qcols = [c for c in cols if re.search(r"(?:^|_)(q0?2?5|q0?5|q50|q95|q97?5)(?:$|_)", c)]
            if len(qcols) < 3:
                errors.append(f"Branch '{br}': bands shown but fewer than 3 quantile-like columns listed (got {len(qcols)}).")
            if not any(c.endswith("n_ok") or c.endswith("_n_ok") or c == "n_ok" for c in cols):
                errors.append(f"Branch '{br}': bands shown but missing per-branch n_ok column (e.g. '{br}_n_ok').")

    # Non-mixing invariant: ordering check.
    if bc.ordering_invariant is None and bc.continuity_invariant is None and bc.label_stability_invariant is None:
        errors.append(
            "Missing non-mixing invariant: provide at least one of "
            "'Ordering invariant: <col_left> >= <col_right>', "
            "'Continuity invariant: abs_delta(<col>) <= <max_abs_delta>', "
            "or 'Label stability: <switch_rate_col> <= <max_fraction>' in section H."
        )

    def _find_csv_with_columns(cols_need: list[str]) -> Path | None:
        for _, (csv_path_s, _) in bc.branch_outputs.items():
            p = Path(csv_path_s)
            if not p.is_absolute():
                p = notebook_dir / p
            if not p.exists():
                continue
            header = _read_csv_header(p)
            if all(c in header for c in cols_need):
                return p
        return None

    # Ordering invariant
    if bc.ordering_invariant is not None:
        left, right = bc.ordering_invariant
        found_csv = _find_csv_with_columns([left, right])
        if found_csv is None:
            errors.append(f"Ordering invariant columns not found together in any declared branch CSV: {left}, {right}")
        else:
            rows = _iter_csv_rows(found_csv, max_rows=max(50, args.max_check_rows))
            checked = 0
            for row in rows:
                lv = _to_float(row.get(left, ""))
                rv = _to_float(row.get(right, ""))
                if lv is None or rv is None:
                    continue
                checked += 1
                if lv < rv:
                    key = ""
                    if bc.scan_coordinate and bc.scan_coordinate in row:
                        key = f"{bc.scan_coordinate}={row.get(bc.scan_coordinate)}"
                    elif "m_pi_gev" in row:
                        key = f"m_pi_gev={row.get('m_pi_gev')}"
                    elif row:
                        first_k = next(iter(row.keys()))
                        key = f"{first_k}={row.get(first_k)}"
                    errors.append(f"Ordering invariant violated at {key}: {left}={lv} < {right}={rv} (file={found_csv})")
                    break
                if checked >= args.max_check_rows:
                    break
            if checked == 0:
                errors.append(f"Ordering invariant check found no rows with both columns non-NaN: {left}, {right} (file={found_csv})")

    # Continuity invariant
    if bc.continuity_invariant is not None:
        col, thr = bc.continuity_invariant
        cols_need = [col] + ([bc.scan_coordinate] if bc.scan_coordinate else [])
        found_csv = _find_csv_with_columns(cols_need if cols_need else [col])
        if found_csv is None:
            errors.append(f"Continuity invariant column not found in any declared branch CSV: {col}")
        else:
            rows = _iter_csv_rows(found_csv, max_rows=2000)
            # Build sequence (optionally sort by coordinate).
            seq: list[tuple[float | None, float | None]] = []
            for r in rows:
                x = _to_float(r.get(bc.scan_coordinate, "")) if bc.scan_coordinate else None
                y = _to_float(r.get(col, ""))
                seq.append((x, y))
            if bc.scan_coordinate:
                seq = sorted(seq, key=lambda t: (t[0] is None, t[0] if t[0] is not None else 0.0))
            prev_y: float | None = None
            prev_x: float | None = None
            checked = 0
            for x, y in seq:
                if y is None:
                    continue
                if prev_y is None:
                    prev_y, prev_x = y, x
                    continue
                checked += 1
                d = abs(y - prev_y)
                if d > thr:
                    key = ""
                    if bc.scan_coordinate:
                        key = f"{bc.scan_coordinate}={x} (prev={prev_x})"
                    errors.append(f"Continuity invariant violated: abs_delta({col})={d} > {thr} at {key} (file={found_csv})")
                    break
                prev_y, prev_x = y, x
                if checked >= 200:
                    break
            if checked == 0:
                errors.append(f"Continuity invariant check found insufficient adjacent numeric points for column: {col} (file={found_csv})")

    # Label stability invariant (switch rate)
    if bc.label_stability_invariant is not None:
        col, thr = bc.label_stability_invariant
        found_csv = _find_csv_with_columns([col])
        if found_csv is None:
            errors.append(f"Label stability column not found in any declared branch CSV: {col}")
        else:
            rows = _iter_csv_rows(found_csv, max_rows=2000)
            checked = 0
            for r in rows:
                v = _to_float(r.get(col, ""))
                if v is None:
                    continue
                checked += 1
                if v > thr:
                    key = ""
                    if bc.scan_coordinate and bc.scan_coordinate in r:
                        key = f"{bc.scan_coordinate}={r.get(bc.scan_coordinate)}"
                    errors.append(f"Label stability invariant violated: {col}={v} > {thr} at {key} (file={found_csv})")
                    break
                if checked >= 200:
                    break
            if checked == 0:
                errors.append(f"Label stability check found no numeric rows for column: {col} (file={found_csv})")

    if errors:
        if not strict_required:
            print("[warn] branch contract has issues, but branch_semantics.require_when_declared=false (non-blocking)", flush=True)
            for e in errors:
                print(f"[warn] {e}", flush=True)
            for w in warnings:
                print(f"[warn] {w}", flush=True)
            return 0
        print("[fail] branch completeness gate failed", flush=True)
        for e in errors:
            print(f"[error] {e}", flush=True)
        for w in warnings:
            print(f"[warn] {w}", flush=True)
        return 1

    print("[ok] branch completeness gate passed", flush=True)
    for w in warnings:
        print(f"[warn] {w}", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
