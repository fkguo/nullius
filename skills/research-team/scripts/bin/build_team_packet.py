#!/usr/bin/env python3
# CONTRACT-EXEMPT: CODE-01.1 sunset:2026-06-01 — team packet builder; split into section generators planned
"""
Build a compact team packet for a two-member research-team cycle.

Canonical entrypoint: build_team_packet.py

This script is intentionally generic:
- It can extract a marked excerpt from a notebook (between HTML comment markers),
  so reviewers focus on the right section.
- It records minimal provenance (cwd + git hash when available).
- It keeps novelty maximization explicit via an “innovation delta” section.
"""

from __future__ import annotations

import argparse
import datetime as _dt
import os
import sys
import re
import subprocess
import json
import csv
from urllib.parse import parse_qs, urlsplit
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "lib"))

from team_config import load_team_config  # type: ignore


EXCERPT_START = "<!-- REVIEW_EXCERPT_START -->"
EXCERPT_END = "<!-- REVIEW_EXCERPT_END -->"
CAPSULE_START = "<!-- REPRO_CAPSULE_START -->"
CAPSULE_END = "<!-- REPRO_CAPSULE_END -->"
AUDIT_START = "<!-- AUDIT_SLICES_START -->"
AUDIT_END = "<!-- AUDIT_SLICES_END -->"


# ---------------------------------------------------------------------------
# RT-01: asymmetric-mode redaction helpers
# ---------------------------------------------------------------------------

_HEADLINE_NUMBER_RE = re.compile(
    r"(?<![A-Za-z_\d.])"                     # not preceded by alpha/digit/dot (prevents mid-number/identifier match)
    r"[+-]?"                                  # optional sign
    r"(?:\d+(?:\.\d*)?|\.\d+)"               # mantissa
    r"(?:"                                     # exponent / scientific notation (optional)
    r"(?:[eE][+-]?\d+)"
    r"|(?:\s*(?:\*|×|\\times)\s*10\^?\{?[+-]?\d+\}?)"
    r")?"
    r"(?:\s*(?:±|\+/-|\\pm)\s*"              # optional uncertainty term
    r"[+-]?(?:\d+(?:\.\d*)?|\.\d+)"
    r"(?:[eE][+-]?\d+)?"
    r")?"
    r"(?!\d)",                                # not followed by digit (prevents partial-number match)
)

REDACTED_TAG = "[REDACTED — verifier must derive independently]"
HIDDEN_TAG = "[HIDDEN — compute independently]"


def _redact_critical_steps(packet_text: str, critical_steps: list[str]) -> str:
    """Replace the body of specified steps with REDACTED_TAG.

    Recognised step markers:
      ## Step N: <title>
    where N is in *critical_steps* (matches on N or on the title substring).
    The replacement covers everything between the matched heading and the next
    heading of the same or higher level.
    """
    if not critical_steps:
        return packet_text

    step_set = {s.strip().lower() for s in critical_steps if s.strip()}
    if not step_set:
        return packet_text

    def _replacer(m: re.Match) -> str:
        step_num = m.group("num").strip().lower()
        step_title = m.group("title").strip().lower()
        body = m.group("body")
        for crit in step_set:
            # Numeric selectors match step number only; text selectors match title substring
            if crit.isdigit():
                if crit == step_num:
                    return m.group("heading") + "\n" + REDACTED_TAG + "\n"
            else:
                if crit in step_title:
                    return m.group("heading") + "\n" + REDACTED_TAG + "\n"
        return m.group(0)  # no match → keep original

    # Pattern: ## Step N: title\n<body until next ## or end>
    # Use .* (not .+) so blank lines within a step body are captured.
    # Tolerates 0-3 leading spaces per CommonMark ATX heading spec.
    pattern = re.compile(
        r"(?P<heading>^\s{0,3}##\s+Step\s+(?P<num>\d+)\s*:\s*(?P<title>[^\n]*))\n"
        r"(?P<body>(?:(?!^\s{0,3}##\s).*\n?)*)",
        flags=re.MULTILINE,
    )
    return pattern.sub(_replacer, packet_text)


def _redact_headline_numbers(packet_text: str) -> str:
    """Redact numeric values in headline_numbers / Capsule Section E for blind verification.

    Targets:
      - Lines like "- H1: [T1] Q = 1.23 ± 0.04"
      - The "headline_numbers" subsection in the Reproducibility Capsule
    """
    lines = packet_text.splitlines(keepends=True)
    out: list[str] = []
    in_capsule_headlines = False
    for ln in lines:
        # Detect capsule headline section (Section E)
        # Tolerates 0-3 leading spaces per CommonMark ATX heading spec.
        if re.match(r"^\s{0,3}###\s+E\)\s+Headline numbers", ln, re.IGNORECASE):
            in_capsule_headlines = True
            out.append(ln)
            continue
        if in_capsule_headlines and re.match(r"^\s{0,3}###\s+", ln):
            in_capsule_headlines = False

        # Redact H-lines and capsule headline section lines
        if re.match(r"^\s*-\s*H\d+\s*:", ln) or in_capsule_headlines:
            out.append(_HEADLINE_NUMBER_RE.sub(HIDDEN_TAG, ln))
        else:
            out.append(ln)
    return "".join(out)


# ---------------------------------------------------------------------------
# RT-04: idea-source injection + lead export helpers
# ---------------------------------------------------------------------------

def _load_idea_seeds(path: Path) -> list[dict]:
    """Load idea seeds from a JSON file.

    Accepted formats:
      - {"ideas": [idea_card_v1, ...]}  (idea pack)
      - [idea_card_v1, ...]             (bare array)
      - idea_card_v1                    (single card)
    """
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except Exception as e:
        print(f"[warn] failed to load idea-source {path}: {e}", file=sys.stderr)
        return []

    if isinstance(data, dict):
        if "ideas" in data and isinstance(data["ideas"], list):
            return [x for x in data["ideas"] if isinstance(x, dict)]
        # Single idea card
        return [data]
    if isinstance(data, list):
        return [x for x in data if isinstance(x, dict)]
    return []


def _format_idea_seed_section(seeds: list[dict]) -> list[str]:
    """Format idea seeds into packet lines."""
    lines: list[str] = []
    lines.append("## 0.3) External Idea Seeds (injected via --idea-source)")
    lines.append("")
    lines.append("The following structured research ideas are provided as seeds for this cycle.")
    lines.append("Evaluate their relevance to the current milestone and incorporate if appropriate.")
    lines.append("")
    for i, seed in enumerate(seeds[:10], 1):
        thesis = seed.get("thesis_statement", "(no thesis)")
        hypotheses = seed.get("testable_hypotheses", [])
        observables = seed.get("required_observables", [])
        lines.append(f"### Seed {i}")
        lines.append(f"- Thesis: {thesis}")
        if hypotheses:
            lines.append(f"- Hypotheses: {'; '.join(str(h) for h in hypotheses[:5])}")
        if observables:
            lines.append(f"- Observables: {'; '.join(str(o) for o in observables[:5])}")
        claims = seed.get("claims", [])
        if claims:
            lines.append(f"- Claims ({len(claims)}):")
            for c in claims[:3]:
                ct = c.get("claim_text", "?")
                st = c.get("support_type", "?")
                lines.append(f"  - [{st}] {ct}")
        lines.append("")
    return lines


def _parse_innovation_leads(log_path: Path) -> list[dict]:
    """Parse INNOVATION_LOG.md and extract breakthrough leads.

    Expected format in the log:
      ## Lead N: <title>
      - Baseline it must beat: ...
      - Discriminant: ...
      - Minimal test: ...
      - Kill criterion: ...
    """
    try:
        text = log_path.read_text(encoding="utf-8", errors="replace")
    except Exception:
        return []

    leads: list[dict] = []
    # Use .* (not .+) so blank lines within a lead body are captured.
    # Tolerates 0-3 leading spaces per CommonMark ATX heading spec.
    pattern = re.compile(
        r"^\s{0,3}##\s+Lead\s+\d+\s*:\s*(?P<title>[^\n]+)\n(?P<body>(?:(?!^\s{0,3}##\s).*\n?)*)",
        flags=re.MULTILINE,
    )
    for m in pattern.finditer(text):
        title = m.group("title").strip()
        body = m.group("body")

        def _field(name: str) -> str:
            fm = re.search(rf"^\s*[-*]\s*{re.escape(name)}\s*:\s*(.+)$", body, re.MULTILINE | re.IGNORECASE)
            return fm.group(1).strip() if fm else ""

        lead = {
            "title": title,
            "baseline": _field("Baseline it must beat"),
            "discriminant": _field("Discriminant"),
            "minimal_test": _field("Minimal test"),
            "kill_criterion": _field("Kill criterion"),
        }
        leads.append(lead)
    return leads


def _leads_to_idea_cards(leads: list[dict]) -> list[dict]:
    """Map INNOVATION_LOG leads to idea_card_v1 schema (best-effort).

    Ensures thesis_statement meets the schema minLength (20 chars).
    """
    _THESIS_MIN_LEN = 20
    cards: list[dict] = []
    for lead in leads:
        title = lead.get("title") or "Untitled lead"
        # Pad short titles to meet idea_card_v1 minLength requirement
        if len(title) < _THESIS_MIN_LEN:
            title = title + " — innovation lead from research-team"
        card = {
            "thesis_statement": title,
            "testable_hypotheses": [
                lead.get("discriminant") or "Hypothesis TBD from lead",
            ],
            "required_observables": [
                lead.get("minimal_test") or "Observable TBD",
            ],
            "candidate_formalisms": ["research-team/innovation-lead"],
            "minimal_compute_plan": [
                {
                    "step": lead.get("minimal_test") or "Implement minimal test",
                    "method": "TBD",
                    "estimated_difficulty": "moderate",
                }
            ],
            "claims": [
                {
                    "claim_text": lead.get("title", "Lead claim"),
                    "support_type": "llm_inference",
                    "evidence_uris": [],
                    "verification_plan": lead.get("kill_criterion") or "Apply kill criterion",
                }
            ],
        }
        if lead.get("baseline"):
            card["claims"].append({
                "claim_text": f"Must beat baseline: {lead['baseline']}",
                "support_type": "assumption",
                "evidence_uris": [],
                "verification_plan": "Compare against stated baseline",
            })
        cards.append(card)
    return cards


def _parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--tag", required=True, help="Round tag (e.g. M2-r1).")
    p.add_argument("--out", type=Path, required=True, help="Output team packet path.")
    p.add_argument(
        "--language",
        type=str,
        default="",
        help="Preferred reply language (optional). If omitted, members should inherit from the packet content.",
    )
    p.add_argument("--notes", type=Path, nargs="*", default=[], help="Notebook/notes paths to reference (optional).")
    p.add_argument("--innovation-log", type=Path, default=None, help="Path to INNOVATION_LOG.md (optional).")
    p.add_argument("--figures", type=Path, nargs="*", default=[], help="Figure paths (optional).")
    p.add_argument("--tables", type=Path, nargs="*", default=[], help="Table/CSV paths (optional).")
    p.add_argument("--questions", type=str, nargs="*", default=[], help="Questions to stress-test (optional).")
    p.add_argument("--adjudication", type=Path, default=None, help="Adjudication note path (optional).")
    p.add_argument(
        "--pointer-import-cmd",
        type=str,
        default="",
        help=(
            "Optional Python command used by pointer lint to resolve code pointers in the notebook. "
            'Example: --pointer-import-cmd "conda run -n plasma python"'
        ),
    )
    # RT-01: mode-aware packet construction
    p.add_argument(
        "--workflow-mode",
        choices=["peer", "leader", "asymmetric"],
        default="leader",
        help="Workflow mode (default: leader).",
    )
    p.add_argument(
        "--critical-steps",
        type=str,
        default="",
        help="Comma-separated step names/numbers for asymmetric redaction.",
    )
    p.add_argument(
        "--blind-numerics",
        action="store_true",
        default=False,
        help="Redact ALL headline numbers for blind verification.",
    )
    # RT-04: idea-source injection
    p.add_argument(
        "--idea-source",
        type=Path,
        default=None,
        help="Path to seed_pack_v1 or {ideas: [idea_card_v1, ...]} JSON for external idea seeds.",
    )
    p.add_argument(
        "--export-leads-to",
        type=Path,
        default=None,
        help="Export INNOVATION_LOG breakthrough leads as idea_card_v1 JSON list to this path.",
    )
    return p.parse_args()


def _git_info(cwd: Path) -> tuple[str | None, bool | None]:
    try:
        commit = (
            subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=str(cwd), stderr=subprocess.DEVNULL)
            .decode("utf-8")
            .strip()
        )
        dirty = subprocess.call(["git", "diff", "--quiet"], cwd=str(cwd)) != 0
        return commit, dirty
    except Exception:
        return None, None


def _extract_excerpt(path: Path, max_chars: int = 6000) -> str | None:
    """
    Extract the reviewer excerpt between the explicit marker lines.

    Important: match markers only when they appear as standalone lines
    (with optional surrounding whitespace). This avoids accidental matches when
    users mention the marker strings in prose or inline code blocks.
    """
    try:
        text = path.read_text(encoding="utf-8")
    except Exception:
        return None

    m_start = re.search(rf"^\s*{re.escape(EXCERPT_START)}\s*$", text, flags=re.MULTILINE)
    if not m_start:
        return None
    m_end = re.search(
        rf"^\s*{re.escape(EXCERPT_END)}\s*$",
        text[m_start.end() :],
        flags=re.MULTILINE,
    )
    if not m_end:
        return None
    a = m_start.end()
    b = m_start.end() + m_end.start()
    excerpt = text[a:b].strip()
    if len(excerpt) > max_chars:
        cut = excerpt.rfind("\n", 0, max_chars)
        if cut <= 0:
            cut = max_chars
        excerpt = excerpt[:cut].rstrip() + "\n[... truncated ...]\n"
    return excerpt


def _extract_capsule(path: Path, max_chars: int = 60000) -> str | None:
    """
    Extract the reproducibility capsule between explicit marker lines.

    Like _extract_excerpt, match markers only as standalone lines to avoid
    accidental capture from prose mentions.
    """
    try:
        text = path.read_text(encoding="utf-8")
    except Exception:
        return None

    m_start = re.search(rf"^\s*{re.escape(CAPSULE_START)}\s*$", text, flags=re.MULTILINE)
    if not m_start:
        return None
    m_end = re.search(
        rf"^\s*{re.escape(CAPSULE_END)}\s*$",
        text[m_start.end() :],
        flags=re.MULTILINE,
    )
    if not m_end:
        return None
    a = m_start.end()
    b = m_start.end() + m_end.start()
    capsule = text[a:b].strip()
    if len(capsule) > max_chars:
        cut = capsule.rfind("\n", 0, max_chars)
        if cut <= 0:
            cut = max_chars
        capsule = capsule[:cut].rstrip() + "\n[... truncated ...]\n"
    return capsule


def _extract_audit_slices(path: Path, max_chars: int = 10000) -> str | None:
    """
    Extract audit slices between explicit marker lines (standalone-line match).
    """
    try:
        text = path.read_text(encoding="utf-8")
    except Exception:
        return None

    m_start = re.search(rf"^\s*{re.escape(AUDIT_START)}\s*$", text, flags=re.MULTILINE)
    if not m_start:
        return None
    m_end = re.search(
        rf"^\s*{re.escape(AUDIT_END)}\s*$",
        text[m_start.end() :],
        flags=re.MULTILINE,
    )
    if not m_end:
        return None
    a = m_start.end()
    b = m_start.end() + m_end.start()
    audit = text[a:b].strip()
    if len(audit) > max_chars:
        cut = audit.rfind("\n", 0, max_chars)
        if cut <= 0:
            cut = max_chars
        audit = audit[:cut].rstrip() + "\n[... truncated ...]\n"
    return audit


def _extract_capsule_section(capsule: str, heading_regex: str) -> str:
    """
    Extract a "### ..." section body from the capsule, given a regex that matches the heading text.
    Returns the section body (no heading line), or "" if missing.
    """
    m = re.search(rf"^###\s+{heading_regex}.*?$", capsule, flags=re.MULTILINE)
    if not m:
        return ""
    start = m.end()
    m2 = re.search(r"^###\s+", capsule[start:], flags=re.MULTILINE)
    end = start + (m2.start() if m2 else len(capsule[start:]))
    return capsule[start:end].strip()


def _extract_mapping_table(text: str) -> list[dict[str, str]]:
    m = re.search(r"^##\s+6\.\s+Mapping to Computation.*$", text, flags=re.MULTILINE)
    if not m:
        return []
    lines = text[m.end() :].splitlines()
    header_idx = None
    for i, ln in enumerate(lines):
        if "|" in ln and "Quantity" in ln and "Code pointer" in ln and "Artifact pointer" in ln:
            header_idx = i
            break
    if header_idx is None:
        return []
    rows: list[dict[str, str]] = []
    for ln in lines[header_idx + 2 :]:
        if not ln.strip().startswith("|"):
            if rows:
                break
            continue
        cells = [c.strip() for c in ln.strip().strip("|").split("|")]
        while len(cells) < 5:
            cells.append("")
        qty, definition, code, artifact, uncertainty = cells[:5]
        if not any([definition, code, artifact, uncertainty]):
            continue
        rows.append(
            {
                "quantity": qty,
                "definition": definition,
                "code": code,
                "artifact": artifact,
                "uncertainty": uncertainty,
            }
        )
    return rows


def _parse_capsule_outputs(capsule: str) -> list[str]:
    # Heuristic: bullet lines in the "Expected outputs" section that look path-like.
    outputs: list[str] = []
    in_outputs = False
    for ln in capsule.splitlines():
        if ln.strip().startswith("###") and "Expected outputs" in ln:
            in_outputs = True
            continue
        if ln.strip().startswith("###") and in_outputs:
            break
        if not in_outputs:
            continue
        m = re.match(r"^\s*-\s+(\S+)\s*$", ln)
        if not m:
            continue
        val = m.group(1)
        if "/" in val or "." in val:
            outputs.append(val)
    return outputs


def _unique(seq: list[str]) -> list[str]:
    seen: set[str] = set()
    out: list[str] = []
    for item in seq:
        if item in seen:
            continue
        seen.add(item)
        out.append(item)
    return out


def _classify_outputs(outputs: list[str]) -> tuple[list[str], list[str], list[str]]:
    fig_exts = (".png", ".jpg", ".jpeg", ".svg", ".pdf", ".eps", ".gif")
    data_exts = (
        ".csv",
        ".tsv",
        ".json",
        ".jsonl",
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
    figs: list[str] = []
    tables: list[str] = []
    others: list[str] = []
    for p in outputs:
        low = p.lower()
        if any(low.endswith(ext) for ext in fig_exts):
            figs.append(p)
        elif any(low.endswith(ext) for ext in data_exts):
            tables.append(p)
        else:
            others.append(p)
    return (_unique(figs), _unique(tables), _unique(others))


def _annotate_path(path_str: str, base_dir: Path) -> str:
    p = Path(path_str)
    if not p.is_absolute():
        p = base_dir / p
    try:
        if p.is_file():
            return path_str
    except Exception:
        return f"{path_str} (missing)"
    return f"{path_str} (missing)"


def _parse_capsule_headlines(capsule: str) -> list[str]:
    # Preferred: "- H1: ..." lines.
    lines: list[str] = []
    for ln in capsule.splitlines():
        if re.match(r"^\s*-\s*H\d+\s*:", ln):
            lines.append(ln.strip())
    return lines


def _json_pointer_get(obj: object, pointer: str) -> object:
    # JSON Pointer: https://datatracker.ietf.org/doc/html/rfc6901
    if pointer == "" or pointer == "/":
        return obj
    if not pointer.startswith("/"):
        raise ValueError(f"JSON pointer must start with '/': {pointer}")
    cur = obj
    for raw in pointer.split("/")[1:]:
        token = raw.replace("~1", "/").replace("~0", "~")
        if isinstance(cur, list):
            idx = int(token)
            cur = cur[idx]
        elif isinstance(cur, dict):
            cur = cur[token]
        else:
            raise KeyError(f"Cannot descend into non-container at token {token}")
    return cur


def _dot_path_get(obj: object, path: str) -> object:
    cur = obj
    for tok in [t for t in path.split(".") if t]:
        if isinstance(cur, list):
            cur = cur[int(tok)]
        elif isinstance(cur, dict):
            cur = cur[tok]
        else:
            raise KeyError(f"Cannot descend into non-container at token {tok}")
    return cur


def _parse_headline_from_pointer(line: str) -> tuple[str, float | None, str | None]:
    """
    Parse one headline line like:
      - H1: [T1] Q1 = 1.23 (from runs/x/summary.json:stats.q1)
      - H2: [T2] max_rel_err = 4.56e-3 (from runs/x/analysis.json:diagnostics.max_rel_err)

    Returns: (label, reported_value, source_spec)
    where source_spec is either "path:dot.path" or "path#/json/pointer".
    """
    m_label = re.match(r"^\s*-\s*(H\d+)\s*:\s*(.*)$", line)
    if not m_label:
        return ("", None, None)
    label = m_label.group(1)
    rest = m_label.group(2)

    m_val = re.search(r"(?:=|≈|\\simeq)\s*([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?)", rest)
    reported = float(m_val.group(1)) if m_val else None

    m_from = re.search(r"\(from\s+([^)]+)\)", rest, flags=re.IGNORECASE)
    source = m_from.group(1).strip() if m_from else None
    return (label, reported, source)


def _extract_from_artifact(source_spec: str, cwd: Path) -> float | None:
    """
    Extract a numeric value from an artifact.
    Supported:
      - path:dot.path
      - path#/json/pointer
      - path.csv?where=col:value&field=target_col
    """
    if "?" in source_spec and ".csv" in source_spec.lower():
        return _extract_from_csv_query(source_spec, cwd)
    if "#" in source_spec:
        path_s, pointer = source_spec.split("#", 1)
        path = Path(path_s)
        if not path.is_absolute():
            path = cwd / path
        if path.suffix.lower() != ".json":
            return None
        obj = json.loads(path.read_text(encoding="utf-8"))
        val = _json_pointer_get(obj, pointer)
    else:
        if ":" not in source_spec:
            return None
        path_s, dot = source_spec.rsplit(":", 1)
        path = Path(path_s)
        if not path.is_absolute():
            path = cwd / path
        if path.suffix.lower() != ".json":
            return None
        obj = json.loads(path.read_text(encoding="utf-8"))
        val = _dot_path_get(obj, dot)
    if isinstance(val, (int, float)):
        return float(val)
    return None


def _try_float(s: str) -> float | None:
    try:
        return float(s)
    except Exception:
        return None


def _extract_from_csv_query(source_spec: str, cwd: Path) -> float | None:
    u = urlsplit(source_spec)
    path_s = u.path
    q = parse_qs(u.query, keep_blank_values=True)
    where_vals = q.get("where", [])
    field_vals = q.get("field", [])
    if len(where_vals) != 1 or len(field_vals) != 1:
        return None
    where = where_vals[0]
    field = field_vals[0].strip()
    if ":" not in where or not field:
        return None
    where_col, where_val_raw = where.split(":", 1)
    where_col = where_col.strip()
    where_val_raw = where_val_raw.strip()
    if not where_col or not where_val_raw:
        return None

    path = Path(path_s)
    if not path.is_absolute():
        path = cwd / path
    if path.suffix.lower() != ".csv" or not path.exists():
        return None

    with path.open("r", encoding="utf-8", newline="") as f:
        reader = csv.DictReader(f)
        if reader.fieldnames is None:
            return None
        if where_col not in reader.fieldnames or field not in reader.fieldnames:
            return None
        matched_rows: list[dict[str, str]] = []
        where_val_f = _try_float(where_val_raw)
        for row in reader:
            cell = (row.get(where_col) or "").strip()
            if cell == "":
                continue
            if where_val_f is not None:
                cell_f = _try_float(cell)
                if cell_f is not None:
                    diff = abs(cell_f - where_val_f)
                    tol = max(1e-12, 1e-12 * max(abs(cell_f), abs(where_val_f)))
                    if diff <= tol:
                        matched_rows.append(row)
                        continue
            if cell == where_val_raw:
                matched_rows.append(row)
        if len(matched_rows) != 1:
            return None
        val_raw = (matched_rows[0].get(field) or "").strip()
        val_f = _try_float(val_raw)
        return float(val_f) if val_f is not None else None


def _build_headline_check_table(capsule_headlines: list[str], cwd: Path) -> tuple[list[str], list[str]]:
    """
    Returns (table_lines, warnings).
    """
    warnings: list[str] = []
    rows: list[tuple[str, str, str, str]] = []
    for ln in capsule_headlines[:10]:
        label, reported, src = _parse_headline_from_pointer(ln)
        if not label or reported is None or not src:
            warnings.append(f"Could not parse headline line: {ln}")
            continue
        extracted = None
        try:
            extracted = _extract_from_artifact(src, cwd)
        except Exception as e:
            warnings.append(f"{label}: failed to read '{src}': {e}")
        if extracted is None:
            warnings.append(f"{label}: could not extract numeric value from '{src}'")
            continue
        diff = extracted - reported
        rows.append((label, f"{reported:.6g}", f"{extracted:.6g}", f"{diff:.3g}"))

    if not rows:
        return ([], warnings)

    table: list[str] = []
    table.append("| Headline | Reported | Extracted | Diff (extracted-reported) |")
    table.append("|---|---:|---:|---:|")
    for r in rows:
        table.append(f"| {r[0]} | {r[1]} | {r[2]} | {r[3]} |")
    return (table, warnings)


def _parse_capsule_commands(capsule: str) -> list[str]:
    # Extract first fenced bash block (full command line reproduction).
    m = re.search(r"```bash\s+([\s\S]*?)```", capsule, flags=re.IGNORECASE)
    if not m:
        return []
    cmds: list[str] = []
    for ln in m.group(1).splitlines():
        s = ln.strip()
        if not s or s.startswith("#"):
            continue
        cmds.append(s)
    return cmds


def _git_changed_files(cwd: Path) -> list[str]:
    try:
        import subprocess

        # Prefer staged+unstaged diff vs HEAD when possible.
        out = subprocess.check_output(
            ["git", "diff", "--name-only", "HEAD"],
            cwd=str(cwd),
            stderr=subprocess.DEVNULL,
        ).decode("utf-8")
        files = [ln.strip() for ln in out.splitlines() if ln.strip()]
        if files:
            return files
        # Fall back to "status" for new/untracked info.
        out2 = subprocess.check_output(
            ["git", "status", "--porcelain"],
            cwd=str(cwd),
            stderr=subprocess.DEVNULL,
        ).decode("utf-8")
        files2 = [ln[3:] for ln in out2.splitlines() if ln.strip() and len(ln) > 3]
        return sorted(set(files2))
    except Exception:
        return []


def _run_pointer_lint(notes: Path, import_cmd: str) -> tuple[str, int]:
    script = Path(__file__).resolve().parent.parent / "gates" / "check_pointer_lint.py"
    if not script.is_file():
        return (f"(missing pointer lint script: {script})", 2)
    cmd = ["python3", str(script), "--notes", str(notes)]
    if import_cmd.strip():
        cmd.extend(["--import-cmd", import_cmd.strip()])
    proc = subprocess.run(cmd, capture_output=True, text=True)
    out = (proc.stdout or "").strip()
    if not out:
        out = f"(pointer lint produced no stdout; exit={proc.returncode})"
    return (out, int(proc.returncode))


def _find_research_plan(seed: Path) -> Path | None:
    cur = (seed.parent if seed.is_file() else seed).resolve()
    for _ in range(50):
        cand = cur / "RESEARCH_PLAN.md"
        if cand.is_file():
            return cand
        if cur.parent == cur:
            break
        cur = cur.parent
    return None


def _find_prework(seed: Path) -> Path | None:
    cur = (seed.parent if seed.is_file() else seed).resolve()
    for _ in range(50):
        cand = cur / "PREWORK.md"
        if cand.is_file():
            return cand
        if cur.parent == cur:
            break
        cur = cur.parent
    return None


def _find_project_charter(seed: Path) -> Path | None:
    cur = (seed.parent if seed.is_file() else seed).resolve()
    for _ in range(50):
        cand = cur / "PROJECT_CHARTER.md"
        if cand.is_file():
            return cand
        if cur.parent == cur:
            break
        cur = cur.parent
    return None


def _strip_fenced_code(text: str) -> str:
    lines = text.splitlines()
    out: list[str] = []
    in_fence = False
    fence_marker = ""
    for ln in lines:
        stripped = ln.strip()
        if stripped.startswith("```") or stripped.startswith("~~~"):
            marker = "```" if stripped.startswith("```") else "~~~"
            if not in_fence:
                in_fence = True
                fence_marker = marker
                continue
            if marker == fence_marker:
                in_fence = False
                fence_marker = ""
                continue
        if not in_fence:
            out.append(ln)
    return "\n".join(out)


def _charter_excerpt(path: Path, max_chars: int = 4000) -> str | None:
    try:
        text = path.read_text(encoding="utf-8", errors="replace")
    except Exception:
        return None
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    text = _strip_fenced_code(text).strip()
    if not text:
        return None
    if len(text) > max_chars:
        cut = text.rfind("\n", 0, max_chars)
        if cut <= 0:
            cut = max_chars
        text = text[:cut].rstrip() + "\n[... truncated ...]\n"
    return text


def _extract_heading_block(text: str, *, heading_re: str) -> str:
    """
    Extract a markdown section starting at a heading matching `heading_re`
    and ending right before the next heading of the same or higher level.
    """
    m = re.search(heading_re, text, flags=re.MULTILINE)
    if not m:
        return ""
    hashes = m.group("hashes") if "hashes" in m.groupdict() else "###"
    level = len(hashes)
    start = m.end()
    m2 = re.search(rf"^#{{1,{level}}}\s", text[start:], flags=re.MULTILINE)
    end = start + (m2.start() if m2 else len(text[start:]))
    return text[start:end].strip()


def _extract_task_board_line(plan_text: str, task_id: str) -> str:
    """
    Return the checkbox line for a task like 'T1' from the plan Task Board.
    """
    # Narrow to Task Board region if possible.
    tb = ""
    m = re.search(r"^##\s+Task\s+Board\b.*$", plan_text, flags=re.MULTILINE | re.IGNORECASE)
    if m:
        start = m.end()
        m2 = re.search(r"^##\s+", plan_text[start:], flags=re.MULTILINE)
        end = start + (m2.start() if m2 else len(plan_text[start:]))
        tb = plan_text[start:end]
    else:
        tb = plan_text
    for ln in tb.splitlines():
        if re.match(rf"^\s*(?:[-*+]|(?:\d+\.))\s*\[\s*(?:x|X| )\s*\]\s+{re.escape(task_id)}\s*:\s+.+$", ln):
            return ln.strip()
    return ""


def main() -> int:
    args = _parse_args()
    out: Path = args.out
    out.parent.mkdir(parents=True, exist_ok=True)

    cwd = Path.cwd()
    commit, dirty = _git_info(cwd)
    now = _dt.datetime.now().strftime("%Y-%m-%d %H:%M:%S")

    innovation_log: Path | None = args.innovation_log
    if innovation_log is None:
        candidate = cwd / "INNOVATION_LOG.md"
        if candidate.is_file():
            innovation_log = candidate

    lines: list[str] = []
    lines.append("Research Team Packet")
    lines.append("")
    lines.append(f"Tag: {args.tag}")
    lines.append(f"Date: {now}")
    lines.append(f"Repo/Root: {cwd}")
    if commit is not None:
        lines.append(f"Git: {commit}" + ("" if dirty is None else f" (dirty={dirty})"))
    if args.notes:
        lines.append(f"Primary notebook: {args.notes[0]}")
    lang_value = args.language.strip() if args.language.strip() else "(inherit from packet content)"
    lines.append(f"Preferred reply language: {lang_value}")
    # RT-01: workflow mode metadata
    wf_mode = args.workflow_mode or "leader"
    lines.append(f"Workflow mode: {wf_mode}")
    if wf_mode == "asymmetric" and args.blind_numerics:
        lines.append("Blind numerics: active (all headline numbers redacted)")
    if innovation_log is not None:
        lines.append(f"Innovation log (optional): {innovation_log}")
    lines.append("")

    team_cfg = load_team_config(args.notes[0] if args.notes else cwd)
    cfg_path = getattr(team_cfg, "path", None)
    cfg_data = getattr(team_cfg, "data", {}) if hasattr(team_cfg, "data") else {}
    if not isinstance(cfg_data, dict):
        cfg_data = {}
    mode = str(cfg_data.get("mode", "")).strip()
    profile = str(cfg_data.get("profile", "")).strip()
    review_access_mode = str(cfg_data.get("review_access_mode", "packet_only")).strip().lower()
    if review_access_mode not in ("full_access", "packet_only"):
        review_access_mode = "packet_only"
    isolation_strategy = str(cfg_data.get("isolation_strategy", "separate_worktrees")).strip().lower()
    if isolation_strategy not in ("separate_worktrees", "sequential_with_acl"):
        isolation_strategy = "separate_worktrees"
    feats = cfg_data.get("features", {}) if isinstance(cfg_data.get("features", {}), dict) else {}
    kb_cfg = cfg_data.get("knowledge_layers", {}) if isinstance(cfg_data.get("knowledge_layers", {}), dict) else {}

    def _onoff(name: str) -> str:
        return "on" if bool(feats.get(name, False)) else "off"

    lines.append("## 0.1) Project mode/profile (reviewer context)")
    lines.append("")
    if cfg_path is not None:
        lines.append(f"- Config: {cfg_path}")
    else:
        lines.append("- Config: (not found; using defaults)")
    lines.append(f"- Mode: {mode or '(unset)'}")
    lines.append(f"- Profile: {profile or '(unset)'}")
    lines.append(f"- Review access mode: {review_access_mode}")
    lines.append(f"- Isolation strategy: {isolation_strategy}")
    lines.append(
        "- Gates: "
        + ", ".join(
            [
                f"charter={_onoff('project_charter_gate')}",
                f"plan={_onoff('research_plan_gate')}",
                f"dod={_onoff('milestone_dod_gate')}",
                f"kb={_onoff('knowledge_layers_gate')}",
                f"refs={_onoff('references_gate')}",
                f"notebook={_onoff('notebook_integrity_gate')}",
                f"packet={_onoff('packet_completeness_gate')}",
            ]
        )
    )
    if kb_cfg:
        lines.append(
            "- KB minima: "
            + ", ".join(
                [
                    f"literature>={int(kb_cfg.get('require_min_literature', 0))}",
                    f"traces>={int(kb_cfg.get('require_min_methodology_traces', 0))}",
                    f"priors>={int(kb_cfg.get('require_min_priors', 0))}",
                    f"allow_none={bool(kb_cfg.get('allow_none', True))}",
                ]
            )
        )
    lines.append("- Reviewer focus (profile-aware; do not ignore):")
    lines.append(
        "  - Knowledge base: regardless of profile, expect the layered KB to expand beyond the initial instruction; "
        "require query log + selection rationale + new citations when relevant."
    )
    lines.append("  - Query log (create if missing): [literature_queries.md](knowledge_base/methodology_traces/literature_queries.md)")
    if (profile or "").strip().lower() == "toolkit_extraction":
        lines.append("  - Toolkit extraction: enforce a nontrivial Toolkit delta (API spec + code snippet index + KB evidence links).")
    elif (profile or "").strip().lower() == "literature_review":
        lines.append("  - Literature review: enforce coverage matrix completeness + citations; flag missing/weak evidence as Major Gaps.")
    elif (profile or "").strip().lower() == "methodology_dev":
        lines.append("  - Methodology development: enforce candidate-method comparison + justified selection; flag brute-force as a Major Gap.")
    lines.append("")

    charter_path = _find_project_charter(args.notes[0] if args.notes else cwd)
    if charter_path is not None:
        excerpt = _charter_excerpt(charter_path)
        if excerpt:
            lines.append("## 0.15) Project charter (goal hierarchy; drift guardrail)")
            lines.append("")
            lines.append(f"- Charter: {charter_path}")
            lines.append("")
            for ln in excerpt.splitlines():
                lines.append(ln.rstrip())
            lines.append("")

    lines.append("## Reviewer Contract (both reviewers do both)")
    lines.append("")
    lines.append("You are acting as an internal research-team auditor. Please:")
    lines.append("1) Independently re-derive the key steps (from stated starting equations to final claim).")
    lines.append("   - Show at least 3 critical intermediate steps/equations (not just 'verified').")
    lines.append("2) Independently reproduce (or at least re-check) the key computations from the provided artifacts.")
    lines.append("3) List missing steps, unclear assumptions, sign/normalization ambiguities, circular definitions, or hidden fit parameters.")
    lines.append("4) Provide a minimal fix list (what to add/change, and where).")
    lines.append("")

    # Surface the milestone/task DoD so reviewers can flag "ceremonial acceptance criteria".
    dod_lines: list[str] = []
    plan_path: Path | None = None
    if args.notes:
        plan_path = _find_research_plan(args.notes[0])
    if plan_path is None:
        plan_path = _find_research_plan(cwd)
    if plan_path is not None and plan_path.is_file():
        plan_text = plan_path.read_text(encoding="utf-8", errors="replace").replace("\r\n", "\n").replace("\r", "\n")
        plan_text = _strip_fenced_code(plan_text)
        tag = args.tag.strip()
        # Allow common sub-milestone tags like "M5b-r1" in addition to "M5-r1".
        m_m = re.match(r"^(M\d+[A-Za-z]?)\b", tag)
        m_t = re.match(r"^(T\d+)\b", tag)
        if m_m:
            ms = m_m.group(1)
            block = _extract_heading_block(plan_text, heading_re=rf"^(?P<hashes>##+)\s+.*\b{re.escape(ms)}\b.*$")
            if block:
                dod_lines.append(f"Milestone section: {ms}")
                dod_lines.extend(block.splitlines())
        elif m_t:
            tid = m_t.group(1)
            line = _extract_task_board_line(plan_text, tid)
            if line:
                dod_lines.append(f"Task Board line: {line}")

    if plan_path is not None:
        lines.append("## 0.2) Milestone/Task DoD snapshot (from RESEARCH_PLAN.md; anti-superficial)")
        lines.append("")
        lines.append(f"- Plan: {plan_path}")
        if dod_lines:
            lines.append("- Snapshot:")
            lines.append("")
            snippet = "\n".join(dod_lines).strip()
            if len(snippet) > 3000:
                snippet = snippet[:3000].rstrip() + "\n[... truncated ...]"
            lines.extend(snippet.splitlines())
        else:
            lines.append("- Snapshot: (not found for this tag; ensure RESEARCH_PLAN.md has a matching milestone/task section)")
        lines.append("")

    # Surface Problem Framing Snapshot (prework decomposition) to reviewers, so it cannot be ignored.
    prework_path: Path | None = None
    if args.notes:
        prework_path = _find_prework(args.notes[0])
    if prework_path is None:
        prework_path = _find_prework(cwd)
    if prework_path is not None and prework_path.is_file():
        prework_text = prework_path.read_text(encoding="utf-8", errors="replace").replace("\r\n", "\n").replace("\r", "\n")
        prework_text = _strip_fenced_code(prework_text)
        problem_framing_block = _extract_heading_block(prework_text, heading_re=r"(?i)^(?P<hashes>##+)\s+Problem\s+Framing\s+Snapshot\b.*$")
        lines.append("## 0.25) Problem Framing Snapshot (from PREWORK.md; prework decomposition)")
        lines.append("")
        lines.append(f"- Prework: {prework_path}")
        if problem_framing_block:
            lines.append("- Snapshot:")
            lines.append("")
            snippet = problem_framing_block.strip()
            if len(snippet) > 3000:
                snippet = snippet[:3000].rstrip() + "\n[... truncated ...]"
            lines.extend(snippet.splitlines())
        else:
            lines.append("- Snapshot: (not found; add '## Problem Framing Snapshot' to PREWORK.md)")
        lines.append("")

    # RT-04: inject idea seeds before the convergence gate section
    if args.idea_source is not None and args.idea_source.is_file():
        seeds = _load_idea_seeds(args.idea_source)
        if seeds:
            lines.extend(_format_idea_seed_section(seeds))

    lines.append("## 0) Round & convergence gate")
    lines.append("")
    lines.append("- Round/tag: (fill; e.g. M2-r1, M2-r2)")
    lines.append("- Previous team reports: (fill paths)")
    adjudication_path: Path | None = None
    if args.adjudication is not None:
        if args.adjudication.is_file():
            adjudication_path = args.adjudication
        else:
            print(f"[warn] adjudication note not found: {args.adjudication}", file=sys.stderr)
    if adjudication_path is not None:
        lines.append(f"- Adjudication/response note: {adjudication_path}")
    else:
        lines.append("- Adjudication/response note: (fill; required if you rejected/modified any reviewer recommendation)")
    lines.append("- Resolved items since last round: (fill; reference prior Minimal Fix List items)")
    lines.append("- Open disagreements: (fill; must be classified as SCOPE/MATCHING and accepted by both reviewers)")
    lines.append("- Gate rule: if any mismatch/fail/needs revision, do not advance; apply fixes and re-run until convergence.")
    lines.append("")

    lines.append("## 1) What changed since last round?")
    lines.append("")
    lines.append("- Notes updated:")
    for p in args.notes:
        lines.append(f"  - {p}")
    if not args.notes:
        lines.append("  - (fill)")
    lines.append("- Code updated (auto, best-effort):")
    changed = _git_changed_files(cwd)
    if changed:
        for f in changed[:50]:
            lines.append(f"  - {f}")
        if len(changed) > 50:
            lines.append(f"  - ... ({len(changed)-50} more)")
    else:
        lines.append("  - (no git changes detected / not a git repo)")

    # Pointer lint preflight: catches doc↔code pointer drift (e.g. bad dotted import paths in backticks).
    if args.notes:
        lint_text, lint_code = _run_pointer_lint(args.notes[0], args.pointer_import_cmd)
        lines.append("")
        lines.append("## 1.5) Pointer lint preflight (auto)")
        lines.append("")
        if lint_code != 0:
            lines.append(f"- Status: FAIL (exit code {lint_code})")
        lines.extend(lint_text.splitlines())
        lines.append("")

    capsule_outputs: list[str] = []
    capsule_headlines: list[str] = []
    capsule_cmds: list[str] = []
    capsule_text: str | None = None
    audit_text: str | None = None
    notes_text: str | None = None
    mapping_rows: list[dict[str, str]] = []
    headline_table: list[str] = []
    headline_warnings: list[str] = []
    auto_figs: list[str] = []
    auto_tables: list[str] = []
    auto_others: list[str] = []
    base_dir = cwd
    if args.notes:
        base_dir = args.notes[0].parent.resolve()
        try:
            notes_text = args.notes[0].read_text(encoding="utf-8", errors="replace")
        except Exception:
            notes_text = None
        capsule_text = _extract_capsule(args.notes[0])
        audit_text = _extract_audit_slices(args.notes[0])
        if audit_text is None:
            print("[info] audit slices markers not found; added placeholder to packet.", file=sys.stderr)
        if capsule_text:
            capsule_outputs = _parse_capsule_outputs(capsule_text)
            auto_figs, auto_tables, auto_others = _classify_outputs(capsule_outputs)
            capsule_headlines = _parse_capsule_headlines(capsule_text)
            capsule_cmds = _parse_capsule_commands(capsule_text)
            headline_table, headline_warnings = _build_headline_check_table(capsule_headlines, base_dir)
        if notes_text:
            mapping_rows = _extract_mapping_table(notes_text)

    merged_figs = _unique([str(p) for p in args.figures] + auto_figs)
    merged_tables = _unique([str(p) for p in args.tables] + auto_tables)

    lines.append("- New data/artifacts (from Reproducibility Capsule, if present):")
    if capsule_outputs:
        for p in capsule_outputs:
            lines.append(f"  - {_annotate_path(p, base_dir)}")
    else:
        lines.append("  - (capsule missing or outputs not listed)")
    lines.append("- New figures/tables:")
    for p in merged_figs:
        lines.append(f"  - {_annotate_path(p, base_dir)}")
    for p in merged_tables:
        lines.append(f"  - {_annotate_path(p, base_dir)}")
    if not merged_figs and not merged_tables:
        lines.append("  - none")
    lines.append("")

    lines.append("## 2) Definition-hardened quantities (exact operational definitions)")
    lines.append("")
    if mapping_rows:
        lines.append("- Auto-extracted from Draft_Derivation.md Section 6 table:")
        for row in mapping_rows:
            qty = row.get("quantity", "").strip() or "(unnamed)"
            definition = row.get("definition", "").strip() or "(missing definition)"
            code = row.get("code", "").strip() or "(missing code pointer)"
            artifact = row.get("artifact", "").strip() or "(missing artifact pointer)"
            uncertainty = row.get("uncertainty", "").strip() or "(missing uncertainty)"
            lines.append(
                f"  - {qty}: {definition} | Code: {code} | Artifact: {artifact} | Uncertainty: {uncertainty}"
            )
    else:
        lines.append("- (fill: definition + code pointer + artifact pointer + uncertainty method)")
    lines.append("")

    lines.append("## 2.5) Innovation delta (maximize novelty, keep falsifiable)")
    lines.append("")
    lines.append("- New falsifiable claim/diagnostic since last round:")
    lines.append("- What baseline does it discriminate against?")
    lines.append("- What would falsify it / kill criterion?")
    if innovation_log is not None:
        lines.append(f"- Idea portfolio updates (advance/revise/kill): see {innovation_log}")
    else:
        lines.append("- Idea portfolio updates (advance/revise/kill): (optional) INNOVATION_LOG.md")
    lines.append("")

    # Sweep semantics / parameter dependence (mandatory in capsule; surfaced here as a cross-check focus).
    if capsule_text:
        sweep = _extract_capsule_section(
            capsule_text,
            r"G\)\s+Sweep semantics\s*/\s*parameter dependence",
        )
        if sweep:
            lines.append("## 2.75) Sweep semantics / parameter dependence (from Reproducibility Capsule)")
            lines.append("")
            lines.append("Members MUST cross-check scan semantics and dependent recomputations:")
            lines.append("")
            for ln in sweep.splitlines():
                lines.append(ln.rstrip())
            lines.append("")

        branch = _extract_capsule_section(
            capsule_text,
            r"H\)\s+Branch Semantics\s*/\s*Multi-root Contract",
        )
        if branch:
            # Only surface when applicable (Multi-root quantities not 'none').
            m_mr = re.search(r"^\s*(?:-\s*)?Multi-root quantities:\s*(.+?)\s*$", branch, flags=re.IGNORECASE | re.MULTILINE)
            mr_val = (m_mr.group(1).strip().lower() if m_mr else "")
            if mr_val and mr_val not in ("none", "n/a", "na", "no"):
                lines.append("## 2.85) Branch semantics / multi-root contract (from Reproducibility Capsule)")
                lines.append("")
                lines.append("If multiple roots/branches exist, reviewers MUST verify branch completeness and non-mixing semantics:")
                lines.append("")
                for ln in branch.splitlines():
                    lines.append(ln.rstrip())
                lines.append("")

    lines.append("## 2.9) Audit slices / quick checks (from notebook; optional)")
    lines.append("")
    if audit_text:
        lines.append("Reviewers should cross-check proxy headline numbers and key algorithm steps:")
        lines.append("")
        for ln in audit_text.splitlines():
            lines.append(ln.rstrip())
    else:
        lines.append("(Optional) Audit slices markers not found. Add to your notebook:") 
        lines.append("")
        lines.append(f"`{AUDIT_START}`")
        lines.append("... list key algorithm steps and proxy headline numbers here ...")
        lines.append(f"`{AUDIT_END}`")
    lines.append("")

    lines.append("## 3) Evidence bundle")
    lines.append("")
    lines.append("- Figures:")
    for p in merged_figs:
        lines.append(f"  - {_annotate_path(p, base_dir)}")
    if not merged_figs:
        lines.append("  - none")
    lines.append("- Tables/CSV:")
    for p in merged_tables:
        lines.append(f"  - {_annotate_path(p, base_dir)}")
    if not merged_tables:
        lines.append("  - none")
    if auto_others:
        lines.append("- Other artifacts:")
        for p in auto_others:
            lines.append(f"  - {_annotate_path(p, base_dir)}")
    lines.append("- Provenance checks:")
    if capsule_cmds:
        for c in capsule_cmds[:5]:
            lines.append(f"  - {c}")
    else:
        lines.append("  - (capsule missing or no command listed)")
    lines.append("- Reproducibility Capsule (auto-extracted; mandatory):")
    if capsule_text:
        lines.append("  - (included below)")
    else:
        lines.append("  - (missing; this will fail the gate)")
    lines.append("")

    # Optional: surface knowledge base references (domain-neutral).
    if capsule_text:
        kb = _extract_capsule_section(capsule_text, r"I\)\s+Knowledge\s+base\s+references")
        if kb:
            lines.append("## 3.05) Knowledge base references (auto-extracted)")
            lines.append("")
            for ln in kb.splitlines():
                lines.append(ln.rstrip())
            lines.append("")

    lines.append("## 3.1 Self-consistency checks (fill with numbers)")
    lines.append("")
    if capsule_headlines:
        if headline_table:
            lines.append("- Auto-extracted headline checks (best-effort; extracted from referenced artifacts):")
            lines.extend(headline_table)
            if headline_warnings:
                lines.append("")
                lines.append("- Auto-extraction warnings (fix your '(from ...)' pointers if needed):")
                for w in headline_warnings[:10]:
                    lines.append(f"  - {w}")
        else:
            lines.append("- Headline numbers (from capsule; manual copy/paste):")
            for h in capsule_headlines[:10]:
                lines.append(f"  {h}")
        lines.append("")
        lines.append("- Check A (mandatory): recompute at least one headline number from its stated formula and compare.")
        lines.append("- Check B (mandatory): verify at least one definition identity (quantity computed two ways matches).")
    else:
        lines.append("- (capsule missing or no headline numbers; this will fail the gate)")
    lines.append("")

    lines.append("## 4) Questions to stress-test (3–5)")
    lines.append("")
    if args.questions:
        for q in args.questions:
            lines.append(f"- {q}")
    else:
        lines.append("- (fill)")
    lines.append("")

    lines.append("## 5) Excerpt to review")
    lines.append("")

    excerpt_written = False
    for note in args.notes:
        excerpt = _extract_excerpt(note)
        if excerpt:
            lines.append(f"--- Excerpt from {note} ---")
            lines.append(excerpt)
            lines.append(f"--- End excerpt from {note} ---")
            lines.append("")
            excerpt_written = True
    if not excerpt_written:
        lines.append("(No excerpt markers found. Add markers to your notebook:)") 
        lines.append("")
        lines.append(f"`{EXCERPT_START}`")
        lines.append("... paste minimal excerpt ...")
        lines.append(f"`{EXCERPT_END}`")
        lines.append("")

    # Append the capsule at the end so reviewers have it in one place, while still
    # referencing it from Evidence/Self-consistency sections above.
    lines.append("")
    lines.append("## Appendix A) Reproducibility Capsule (auto-extracted)")
    lines.append("")
    if capsule_text:
        lines.append("--- Reproducibility Capsule ---")
        lines.append(capsule_text.strip())
        lines.append("--- End Reproducibility Capsule ---")
    else:
        lines.append("(Missing capsule markers. Add to your notebook:)") 
        lines.append("")
        lines.append(f"`{CAPSULE_START}`")
        lines.append("... fill Reproducibility Capsule ...")
        lines.append(f"`{CAPSULE_END}`")
        lines.append("")

    packet_text = "\n".join(lines).rstrip() + "\n"

    # RT-01: asymmetric-mode redaction
    if wf_mode == "asymmetric":
        critical = [s.strip() for s in (args.critical_steps or "").split(",") if s.strip()]
        if critical:
            packet_text = _redact_critical_steps(packet_text, critical)
        if args.blind_numerics:
            packet_text = _redact_headline_numbers(packet_text)

    out.write_text(packet_text, encoding="utf-8")
    print("Wrote:", out)

    # RT-04: export leads to idea_card_v1 JSON
    if args.export_leads_to is not None and innovation_log is not None:
        leads = _parse_innovation_leads(innovation_log)
        if leads:
            cards = _leads_to_idea_cards(leads)
            args.export_leads_to.parent.mkdir(parents=True, exist_ok=True)
            args.export_leads_to.write_text(
                json.dumps({"ideas": cards}, indent=2, ensure_ascii=False) + "\n",
                encoding="utf-8",
            )
            print(f"Exported {len(cards)} leads as idea_card_v1 to: {args.export_leads_to}")
        else:
            print(f"[info] No leads found in {innovation_log}; skipping export.", file=sys.stderr)

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
