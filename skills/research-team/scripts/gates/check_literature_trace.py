#!/usr/bin/env python3
"""
Literature discovery saturation gate (domain-neutral).

Purpose:
- Ensure literature/reference/knowledge-evidence work has an auditable discovery trace,
  provider coverage record, candidate pool, and citation/reference graph checks.
- A few Markdown query rows or a small fixed paper count are not sufficient to declare
  literature research complete.

Default paths (relative to project root):
  knowledge_base/methodology_traces/literature_queries.md
  knowledge_base/methodology_traces/literature_saturation.json

Config:
- features.literature_trace_gate: enable/disable this gate (default: True).
- Optional overrides:
    references.trace_log_path: "knowledge_base/methodology_traces/literature_queries.md"
    references.saturation_path: "knowledge_base/methodology_traces/literature_saturation.json"

Exit codes:
  0  ok, gate disabled, or no literature-bearing gates are active
  1  missing/incomplete trace or saturation artifact
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


DEFAULT_TRACE = "knowledge_base/methodology_traces/literature_queries.md"
DEFAULT_SATURATION = "knowledge_base/methodology_traces/literature_saturation.json"
_ISO_TS = re.compile(r"^(19|20)\d{2}-\d{2}-\d{2}T")
_QUERY_PROVIDER_STATUSES = {"queried", "not_applicable", "unavailable"}
_FINAL_STATUSES = {"saturated", "coverage_incomplete"}
_COVERAGE_STATUSES = {"saturated", "coverage_incomplete", "not_covered", "unavailable"}
_EXPECTED_PROVIDERS = ("inspire", "arxiv", "openalex", "web")


@dataclass(frozen=True)
class Row:
    path: Path
    line: int
    text: str


def _trace_path_from_config(cfg: object) -> str:
    data = getattr(cfg, "data", None)
    if not isinstance(data, dict):
        return DEFAULT_TRACE
    refs = data.get("references", {})
    if isinstance(refs, dict):
        p = str(refs.get("trace_log_path") or "").strip()
        if p:
            return p
    return DEFAULT_TRACE


def _saturation_path_from_config(cfg: object) -> str:
    data = getattr(cfg, "data", None)
    if not isinstance(data, dict):
        return DEFAULT_SATURATION
    refs = data.get("references", {})
    if isinstance(refs, dict):
        p = str(refs.get("saturation_path") or "").strip()
        if p:
            return p
    return DEFAULT_SATURATION


def _project_stage(cfg: object) -> str:
    data = getattr(cfg, "data", None)
    if not isinstance(data, dict):
        return "development"
    return str(data.get("project_stage") or "development").strip() or "development"


def _gate_is_applicable(cfg: object) -> bool:
    data = getattr(cfg, "data", None)
    if not isinstance(data, dict):
        return True
    feats = data.get("features", {})
    if not isinstance(feats, dict):
        return True
    return bool(feats.get("references_gate")) or bool(feats.get("knowledge_layers_gate"))


def _require_reading_evidence(cfg: object) -> bool:
    data = getattr(cfg, "data", None)
    if not isinstance(data, dict):
        return False
    kb = data.get("knowledge_layers", {})
    return isinstance(kb, dict) and bool(kb.get("require_literature_reading_evidence", False))


def _resolve_project_path(project_root: Path, rel: str) -> Path:
    p = Path(rel.replace("\\\\", "/").lstrip("./"))
    if p.is_absolute():
        return p
    return project_root / p


def _as_dict(value: object, label: str, errors: list[str]) -> dict:
    if isinstance(value, dict):
        return value
    errors.append(f"{label}: expected object")
    return {}


def _as_list(value: object, label: str, errors: list[str]) -> list:
    if isinstance(value, list):
        return value
    errors.append(f"{label}: expected array")
    return []


def _nonempty_string(value: object) -> bool:
    return isinstance(value, str) and bool(value.strip())


def _int_or_none(value: object) -> int | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value
    return None


def _validate_saturation(data: dict, *, require_reading_evidence: bool, project_stage: str) -> list[str]:
    errors: list[str] = []

    final_status = str(data.get("final_status") or "").strip()
    if final_status not in _FINAL_STATUSES:
        errors.append("final_status must be 'saturated' or 'coverage_incomplete'")
    elif final_status == "coverage_incomplete" and project_stage != "exploration":
        errors.append("final_status=coverage_incomplete is only allowed as exploration debt")

    if not _nonempty_string(data.get("stop_reason")):
        errors.append("stop_reason is required")

    providers = _as_dict(data.get("providers"), "providers", errors)
    if not providers:
        errors.append("providers must include at least one provider record")
    missing_providers = [name for name in _EXPECTED_PROVIDERS if name not in providers]
    if missing_providers:
        errors.append(
            "providers must record coverage for expected provider(s), or mark them not_applicable/unavailable: "
            + ", ".join(missing_providers)
        )
    for provider_name, raw_provider in providers.items():
        label = f"providers.{provider_name}"
        provider = _as_dict(raw_provider, label, errors)
        status = str(provider.get("status") or "").strip()
        if status not in _QUERY_PROVIDER_STATUSES:
            errors.append(f"{label}.status must be one of {sorted(_QUERY_PROVIDER_STATUSES)}")
            continue
        if status == "queried":
            queries = provider.get("queries", provider.get("query_variants"))
            if not _as_list(queries, f"{label}.queries", errors):
                errors.append(f"{label}.queries must record at least one query variant")
            returned_count = _int_or_none(provider.get("returned_count"))
            if returned_count is None or returned_count < 0:
                errors.append(f"{label}.returned_count must be a non-negative integer")
            total_count = _int_or_none(provider.get("total_count"))
            total_unknown = bool(provider.get("total_count_unknown"))
            if total_count is None and not total_unknown:
                errors.append(f"{label} must record total_count or total_count_unknown=true")
            if not _nonempty_string(provider.get("stop_reason")):
                errors.append(f"{label}.stop_reason is required")
        elif not _nonempty_string(provider.get("reason")):
            errors.append(f"{label}.reason is required when provider is {status!r}")

    candidate_pool = _as_dict(data.get("candidate_pool"), "candidate_pool", errors)
    if not _nonempty_string(candidate_pool.get("artifact")):
        errors.append("candidate_pool.artifact is required")
    total_candidates = _int_or_none(candidate_pool.get("total_candidates"))
    if total_candidates is None or total_candidates < 0:
        errors.append("candidate_pool.total_candidates must be a non-negative integer")
    selected_core_ids = [
        str(item).strip()
        for item in _as_list(candidate_pool.get("selected_core_ids"), "candidate_pool.selected_core_ids", errors)
        if str(item).strip()
    ]
    if not selected_core_ids:
        errors.append("candidate_pool.selected_core_ids must name at least one core paper")
    if total_candidates is not None and selected_core_ids and total_candidates < len(selected_core_ids):
        errors.append("candidate_pool.total_candidates cannot be smaller than selected_core_ids")
    if not _nonempty_string(candidate_pool.get("selection_rationale")):
        errors.append("candidate_pool.selection_rationale is required")

    citation_graph = _as_dict(data.get("citation_graph"), "citation_graph", errors)
    seed_records = _as_list(citation_graph.get("seeds"), "citation_graph.seeds", errors)
    seeds_by_id: dict[str, dict] = {}
    for i, raw_seed in enumerate(seed_records):
        seed = _as_dict(raw_seed, f"citation_graph.seeds[{i}]", errors)
        seed_id = str(seed.get("id") or "").strip()
        if not seed_id:
            errors.append(f"citation_graph.seeds[{i}].id is required")
            continue
        seeds_by_id[seed_id] = seed
        coverage_status = str(seed.get("coverage_status") or "").strip()
        if coverage_status not in _COVERAGE_STATUSES:
            errors.append(f"citation_graph.seeds[{i}].coverage_status must be one of {sorted(_COVERAGE_STATUSES)}")
        gaps = [str(g).strip() for g in _as_list(seed.get("gaps", []), f"citation_graph.seeds[{i}].gaps", errors) if str(g).strip()]
        for side in ("references_checked", "citations_checked"):
            checked = bool(seed.get(side))
            if checked:
                continue
            if coverage_status in {"not_covered", "unavailable"} and gaps:
                continue
            errors.append(
                f"citation_graph.seeds[{i}].{side} must be true, unless coverage_status is not_covered/unavailable with gaps"
            )

    missing_core = [paper_id for paper_id in selected_core_ids if paper_id not in seeds_by_id]
    if missing_core:
        errors.append(f"citation_graph.seeds missing selected core paper(s): {', '.join(missing_core)}")

    if require_reading_evidence:
        source_first = _as_dict(data.get("source_first_reading", {}), "source_first_reading", errors)
        metadata_only = [
            str(item).strip()
            for item in _as_list(
                source_first.get("metadata_only_not_evidence_ready", []),
                "source_first_reading.metadata_only_not_evidence_ready",
                errors,
            )
            if str(item).strip()
        ]
        if metadata_only:
            errors.append(
                "metadata-only literature notes cannot satisfy knowledge_layers.require_literature_reading_evidence=true: "
                + ", ".join(metadata_only)
            )

    return errors


def _count_nonempty_rows(text: str, *, path: Path) -> tuple[int, list[Row]]:
    """
    Count non-empty Markdown table rows in the standard literature_queries.md table.
    A row is considered non-empty if it has a plausible ISO-like UTC timestamp in column 1.
    """
    text = (text or "").replace("\r\n", "\n").replace("\r", "\n")
    lines = text.splitlines()
    rows: list[Row] = []
    for i, ln in enumerate(lines, start=1):
        s = ln.strip()
        if not s.startswith("|"):
            continue
        # Skip header separators like |---|---|...
        if re.match(r"^\|\s*-{3,}\s*\|", s):
            continue
        # Split cells.
        parts = [p.strip() for p in s.strip("|").split("|")]
        if len(parts) < 2:
            continue
        ts = parts[0]
        # Template empty row: all cells empty.
        if all(not c for c in parts):
            continue
        # Count as non-empty only if timestamp looks filled (keeps the template placeholder row from counting).
        if _ISO_TS.match(ts):
            rows.append(Row(path=path, line=i, text=ln))
    return len(rows), rows


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--notes", type=Path, required=True, help="Path to research_contract.md (or equivalent).")
    args = ap.parse_args()

    if not args.notes.is_file():
        print(f"ERROR: notes not found: {args.notes}")
        return 2

    cfg = load_team_config(args.notes)
    if not cfg.feature_enabled("literature_trace_gate", default=True):
        print("[skip] literature trace gate disabled by research_team_config")
        return 0
    if not _gate_is_applicable(cfg):
        print("[skip] literature trace gate not applicable (references_gate and knowledge_layers_gate are disabled)")
        return 0

    # Resolve project root similarly to other gates.
    note_dir = args.notes.parent.resolve()
    project_root = note_dir
    if getattr(cfg, "path", None):
        try:
            project_root = cfg.path.parent.resolve()  # type: ignore[union-attr]
        except Exception:
            project_root = note_dir

    trace_path = _resolve_project_path(project_root, _trace_path_from_config(cfg))
    saturation_path = _resolve_project_path(project_root, _saturation_path_from_config(cfg))

    if not trace_path.is_file():
        print("[fail] literature trace gate failed")
        print(f"[error] Missing literature query trace log: {trace_path}")
        print("[hint] Create it (scaffold creates it automatically), or append a row via:")
        print(
            '  python3 "${SKILL_DIR:-$(for r in "${CLAUDE_CONFIG_DIR:-$HOME/.claude}" "${CODEX_HOME:-$HOME/.codex}" "$HOME/.config/opencode"; do [ -d "$r/skills/research-team" ] && echo "$r/skills/research-team" && break; done || true)}/scripts/bin/literature_fetch.py" trace-add '
            '--source \"Manual\" --query \"...\" --decision \"...\"'
        )
        return 1

    try:
        txt = trace_path.read_text(encoding="utf-8", errors="replace")
    except Exception as exc:
        print(f"[error] Failed to read trace log: {trace_path} ({exc})")
        return 2

    n, rows = _count_nonempty_rows(txt, path=trace_path)
    if n <= 0:
        print("[fail] literature trace gate failed")
        print(f"[error] Trace log has no non-empty rows beyond the template header: {trace_path}")
        print("[hint] Append at least one row documenting query -> shortlist -> decision.")
        return 1

    if not saturation_path.is_file():
        print("[fail] literature trace gate failed")
        print(f"[error] Missing literature saturation artifact: {saturation_path}")
        print("[hint] Create it with provider coverage, candidate-pool, and citation/reference graph checks.")
        return 1

    try:
        saturation = json.loads(saturation_path.read_text(encoding="utf-8", errors="replace"))
    except json.JSONDecodeError as exc:
        print("[fail] literature trace gate failed")
        print(f"[error] Invalid JSON in literature saturation artifact: {saturation_path} ({exc})")
        return 2
    except Exception as exc:
        print(f"[error] Failed to read saturation artifact: {saturation_path} ({exc})")
        return 2

    if not isinstance(saturation, dict):
        print("[fail] literature trace gate failed")
        print(f"[error] Literature saturation artifact must be a JSON object: {saturation_path}")
        return 1

    errors = _validate_saturation(
        saturation,
        require_reading_evidence=_require_reading_evidence(cfg),
        project_stage=_project_stage(cfg),
    )
    if errors:
        print("[fail] literature trace gate failed")
        print(f"[error] Literature saturation artifact is incomplete: {saturation_path}")
        for error in errors:
            print(f"- {error}")
        return 1

    print("[ok] literature trace gate passed")
    print(f"- trace: {trace_path}")
    print(f"- non-empty rows: {n}")
    print(f"- saturation: {saturation_path}")
    print(f"- final_status: {saturation.get('final_status')}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
