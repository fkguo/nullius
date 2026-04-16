from __future__ import annotations

import hashlib
import json
import math
import os
import platform
import re
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from ._git import try_get_git_metadata
from ._json import write_json
from ._paths import manifest_cwd
from ._time import utc_now_iso
from .artifact_report import write_artifact_report
from .literature_workflows import extract_candidate_recids, resolve_literature_workflow
from .mcp_config import default_hep_data_dir, load_mcp_server_config, merged_env
from .mcp_stdio_client import McpStdioClient
from .project_policy import PROJECT_POLICY_REAL_PROJECT, assert_path_allowed


@dataclass(slots=True)
class LiteratureGapDiscoverInputs:
    tag: str
    topic: str
    focus: list[str] = field(default_factory=list)
    seed_recid: str | None = None
    iterations: int = 2
    max_papers: int = 40
    prefer_journal: bool = False
    max_recids: int = 12
    mcp_config: str | None = None
    mcp_server: str = "hep-research"
    hep_data_dir: str | None = None


@dataclass(slots=True)
class LiteratureGapAnalyzeInputs:
    tag: str
    seed_selection: str
    topic: str | None = None
    candidates: str | None = None
    max_recids: int = 12
    allow_external_seeds: bool = False
    allow_external_inputs: bool = False
    topic_mode: str = "timeline"
    topic_limit: int = 40
    topic_granularity: str = "5year"
    critical_mode: str = "analysis"
    network_mode: str = "citation"
    network_limit: int = 80
    network_depth: int = 1
    network_direction: str = "both"
    mcp_config: str | None = None
    mcp_server: str = "hep-research"
    hep_data_dir: str | None = None


@dataclass(slots=True)
class LiteratureGapRunResult:
    exit_code: int
    out_dir: Path
    errors: list[str]


def _mcp_config_path(repo_root: Path, *, raw_path: str | None) -> Path:
    if isinstance(raw_path, str) and raw_path.strip():
        path = Path(raw_path).expanduser()
        if not path.is_absolute():
            path = repo_root / path
        return path.resolve()
    return (repo_root / ".mcp.json").resolve()


def _mcp_env(
    repo_root: Path,
    cfg_env: dict[str, str],
    *,
    hep_data_dir_override: str | None,
    create_data_dir: bool,
    project_policy: str | None = None,
) -> dict[str, str]:
    env_data_dir: str | None = None
    hep_data_dir_source = "default"
    if isinstance(hep_data_dir_override, str) and hep_data_dir_override.strip():
        hep_data_dir = Path(hep_data_dir_override).expanduser()
        if not hep_data_dir.is_absolute():
            hep_data_dir = repo_root / hep_data_dir
        hep_data_dir = hep_data_dir.resolve()
        hep_data_dir_source = "cli"
    else:
        env_data_dir = os.environ.get("HEP_DATA_DIR")
        if env_data_dir:
            hep_data_dir = Path(env_data_dir).expanduser().resolve()
            hep_data_dir_source = "env"
        else:
            hep_data_dir = default_hep_data_dir(repo_root=repo_root)
            hep_data_dir_source = "default"

    if hep_data_dir.exists() and not hep_data_dir.is_dir():
        raise ValueError(f"HEP_DATA_DIR is not a directory: {hep_data_dir}")
    if project_policy is not None and hep_data_dir_source in {"cli", "env"}:
        assert_path_allowed(hep_data_dir, project_policy=project_policy, label="HEP_DATA_DIR")

    overrides = dict(cfg_env or {})
    if create_data_dir:
        repo_real = Path(os.path.realpath(repo_root))
        hep_real = Path(os.path.realpath(hep_data_dir))
        under_repo = False
        try:
            hep_real.relative_to(repo_real)
            under_repo = True
        except Exception:
            under_repo = False

        if under_repo:
            hep_data_dir.mkdir(parents=True, exist_ok=True)
        else:
            if hep_data_dir.exists() and hep_data_dir_source in {"cli", "env"}:
                pass
            else:
                raise ValueError(
                    "refuse to create a new HEP_DATA_DIR outside repo_root. Create it manually (or pass a repo-local path).\n"
                    f"repo_root={repo_real}\nHEP_DATA_DIR={hep_data_dir}"
                )
    overrides["HEP_DATA_DIR"] = os.fspath(hep_data_dir)
    return merged_env(overrides=overrides)


def _rel(repo_root: Path, path: Path) -> str:
    try:
        return os.fspath(path.resolve().relative_to(repo_root.resolve())).replace(os.sep, "/")
    except Exception:
        return os.fspath(path).replace(os.sep, "/")


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _resolve_path(repo_root: Path, raw_path: str, *, allow_external: bool) -> Path:
    path = Path(str(raw_path)).expanduser()
    if not path.is_absolute():
        path = repo_root / path
    resolved = path.resolve()
    if not allow_external:
        try:
            resolved.relative_to(repo_root.resolve())
        except Exception as exc:
            raise ValueError(
                f"unsafe path outside repo_root (copy into repo or pass --allow-external-inputs): {resolved}"
            ) from exc
    return resolved


def _read_json_file(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8", errors="replace"))


def _load_seed_selection(path: Path) -> tuple[list[str], dict[str, Any] | None, list[str]]:
    errs: list[str] = []
    try:
        raw = _read_json_file(path)
    except Exception as exc:
        return [], None, [f"seed_selection: failed to read JSON: {exc}"]
    if not isinstance(raw, dict):
        return [], None, ["seed_selection: JSON must be an object"]
    if int(raw.get("schema_version") or 0) != 1:
        errs.append("seed_selection: schema_version must be 1")
    logic = str(raw.get("selection_logic") or "").strip()
    if not logic:
        errs.append("seed_selection: selection_logic must be a non-empty string")
    items = raw.get("items")
    if not isinstance(items, list) or not items:
        errs.append("seed_selection: items must be a non-empty list")
        return [], raw, errs

    out: list[str] = []
    seen: set[str] = set()
    for index, item in enumerate(items[:200]):
        if not isinstance(item, dict):
            errs.append(f"seed_selection: items[{index}] must be an object")
            continue
        recid = str(item.get("recid") or "").strip()
        if not recid:
            errs.append(f"seed_selection: items[{index}].recid must be a non-empty string")
            continue
        reason = str(item.get("reason_for_inclusion") or "").strip()
        if not reason:
            errs.append(f"seed_selection: items[{index}].reason_for_inclusion must be a non-empty string")
        if recid in seen:
            continue
        seen.add(recid)
        out.append(recid)
    if not out:
        errs.append("seed_selection: no valid recids extracted from items")
    return out, raw, errs


def _load_candidates(path: Path) -> tuple[set[str], dict[str, Any] | None, list[str]]:
    errs: list[str] = []
    try:
        raw = _read_json_file(path)
    except Exception as exc:
        return set(), None, [f"candidates: failed to read JSON: {exc}"]
    if not isinstance(raw, dict) or int(raw.get("schema_version") or 0) != 1:
        errs.append("candidates: schema_version must be 1 and JSON must be an object")
        return set(), raw if isinstance(raw, dict) else None, errs
    papers = raw.get("papers")
    if not isinstance(papers, list):
        errs.append("candidates: papers must be a list")
        return set(), raw, errs
    recids: set[str] = set()
    for paper in papers:
        if not isinstance(paper, dict):
            continue
        recid = str(paper.get("recid") or "").strip()
        if recid:
            recids.add(recid)
    if not recids:
        errs.append("candidates: no recids found in papers")
    return recids, raw, errs


def _collect_text(value: object, *, max_items: int = 40, max_depth: int = 3) -> str:
    parts: list[str] = []
    preferred_keys = {"value", "text", "title", "abstract", "name", "label"}

    def rec(current: object, depth: int) -> None:
        if current is None or depth > max_depth:
            return
        if isinstance(current, str):
            text = current.strip()
            if text:
                parts.append(text)
            return
        if isinstance(current, (bool, int, float)):
            return
        if isinstance(current, dict):
            for key in sorted(preferred_keys):
                if key in current:
                    rec(current.get(key), depth + 1)
            for key, child in list(current.items())[:max_items]:
                if str(key) in preferred_keys:
                    continue
                rec(child, depth + 1)
            return
        if isinstance(current, list):
            for child in current[:max_items]:
                rec(child, depth + 1)

    rec(value, 0)
    return " ".join(parts).strip()


def _as_int(value: object) -> int | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return int(value)
    if isinstance(value, float):
        if math.isfinite(value):
            return int(value)
        return None
    if isinstance(value, str):
        text = value.strip()
        if not text:
            return None
        try:
            return int(text)
        except Exception:
            return None
    return None


def _extract_year(paper: dict[str, Any]) -> int | None:
    for key in ["year", "publication_year", "pub_year"]:
        year = _as_int(paper.get(key))
        if isinstance(year, int) and 1900 <= year <= 2100:
            return int(year)
    for key in ["date", "publication_date", "pub_date"]:
        text = str(paper.get(key) or "").strip()
        if not text:
            continue
        match = re.search(r"\b(19\d{2}|20\d{2})\b", text)
        if match:
            try:
                return int(match.group(1))
            except Exception:
                continue
    return None


def _extract_citations(paper: dict[str, Any]) -> int | None:
    for key in ["citation_count", "citations", "cited_by", "citationCount", "citation_count_total"]:
        citations = _as_int(paper.get(key))
        if isinstance(citations, int) and citations >= 0:
            return int(citations)
    return None


def _extract_title(paper: dict[str, Any]) -> str | None:
    for key in ["title", "titles", "document_title"]:
        if key in paper:
            text = _collect_text(paper.get(key))
            return text or None
    return None


def _extract_abstract(paper: dict[str, Any]) -> str | None:
    for key in ["abstract", "abstracts", "summary"]:
        if key in paper:
            text = _collect_text(paper.get(key))
            return text or None
    return None


def _extract_authors(paper: dict[str, Any]) -> list[str]:
    authors = paper.get("authors")
    if not isinstance(authors, list):
        return []
    out: list[str] = []
    for author in authors[:50]:
        if isinstance(author, str):
            text = author.strip()
            if text:
                out.append(text)
            continue
        if isinstance(author, dict):
            text = ""
            for key in ["full_name", "name"]:
                if key in author and str(author.get(key) or "").strip():
                    text = str(author.get(key) or "").strip()
                    break
            if not text and (author.get("first_name") or author.get("last_name")):
                text = (
                    str(author.get("first_name") or "").strip()
                    + " "
                    + str(author.get("last_name") or "").strip()
                ).strip()
            if text:
                out.append(text)
    seen: set[str] = set()
    deduped: list[str] = []
    for author in out:
        if author in seen:
            continue
        seen.add(author)
        deduped.append(author)
    return deduped


def extract_seed_search_candidates(payload: object, *, created_at: str) -> dict[str, Any]:
    if not isinstance(payload, dict):
        return {
            "schema_version": 1,
            "created_at": created_at,
            "papers": [],
            "stats": {"papers_seen": 0, "unique_recids": 0},
            "notes": "payload not an object; no candidates extracted",
        }

    papers_raw = payload.get("papers")
    if not isinstance(papers_raw, list):
        return {
            "schema_version": 1,
            "created_at": created_at,
            "papers": [],
            "stats": {"papers_seen": 0, "unique_recids": 0},
            "notes": "search output missing papers[]; no candidates extracted",
        }

    papers_out: list[dict[str, Any]] = []
    for index, paper in enumerate([item for item in papers_raw if isinstance(item, dict)], start=1):
        recid = str(paper.get("recid") or "").strip()
        if not recid:
            continue
        title = _extract_title(paper)
        abstract = _extract_abstract(paper)
        year = _extract_year(paper)
        citations = _extract_citations(paper)
        missing: list[str] = []
        if not title:
            missing.append("title")
        if not abstract:
            missing.append("abstract")
        if not isinstance(year, int):
            missing.append("year")
        if not isinstance(citations, int):
            missing.append("citation_count")
        papers_out.append(
            {
                "recid": recid,
                "first_seen_index": index,
                "sources": ["seed_search"],
                "title": title,
                "abstract": abstract,
                "authors": _extract_authors(paper),
                "year": year,
                "citation_count": citations,
                "missing_fields": missing,
                "extra": {},
            }
        )

    return {
        "schema_version": 1,
        "created_at": created_at,
        "papers": papers_out,
        "stats": {"papers_seen": len(papers_out), "unique_recids": len(papers_out)},
        "notes": "Launcher-resolved seed-search candidates only; downstream selection/ranking remains external.",
    }


def run_literature_gap_discover(repo_root: Path, inputs: LiteratureGapDiscoverInputs) -> LiteratureGapRunResult:
    tag = str(inputs.tag or "").strip()
    if not tag:
        raise ValueError("--tag is required")
    topic = str(inputs.topic or "").strip()
    if not topic:
        raise ValueError("--topic is required for discover")

    created_at = utc_now_iso().replace("+00:00", "Z")
    out_dir = (repo_root / "artifacts" / "runs" / tag / "literature_gap" / "discover").resolve()
    out_dir.mkdir(parents=True, exist_ok=True)

    cfg_path = _mcp_config_path(repo_root, raw_path=inputs.mcp_config)
    if not cfg_path.exists():
        raise ValueError(
            "missing MCP config. Create .mcp.json (ignored by git) or pass --mcp-config.\n"
            f"expected: {cfg_path}"
        )

    server_name = str(inputs.mcp_server or "hep-research").strip()
    cfg = load_mcp_server_config(config_path=cfg_path, server_name=server_name)
    env = _mcp_env(
        repo_root,
        cfg.env,
        hep_data_dir_override=inputs.hep_data_dir,
        create_data_dir=False,
        project_policy=PROJECT_POLICY_REAL_PROJECT,
    )

    plan_path = out_dir / "workflow_plan.json"
    discover_path = out_dir / "seed_search.json"
    candidates_path = out_dir / "candidates.json"
    gap_report_path = out_dir / "gap_report.json"
    manifest_path = out_dir / "manifest.json"
    summary_path = out_dir / "summary.json"
    analysis_path = out_dir / "analysis.json"

    actions: list[dict[str, Any]] = []
    errors: list[str] = []
    workflow_plan: dict[str, Any] | None = None
    discover_json: Any | None = None
    candidates_json: dict[str, Any] | None = None
    discover_ok = False
    mcp_init: dict[str, Any] | None = None
    mcp_tools: list[str] = []

    def record(tool: str, status: str, **extras: Any) -> None:
        row: dict[str, Any] = {
            "tool": tool,
            "status": status,
            "timestamp": utc_now_iso().replace("+00:00", "Z"),
        }
        row.update(extras)
        actions.append(row)

    try:
        with McpStdioClient(cfg=cfg, cwd=repo_root, env=env) as client:
            init_raw = client.initialize(client_name="autoresearch", client_version="0.0.1")
            mcp_init = {
                "protocolVersion": init_raw.get("protocolVersion") if isinstance(init_raw, dict) else None,
                "serverInfo": init_raw.get("serverInfo") if isinstance(init_raw, dict) else None,
            }
            tools = client.list_tools()
            tool_names = {tool.name for tool in tools}
            mcp_tools = sorted(tool_names)

            focus_terms = [str(value).strip() for value in inputs.focus if str(value).strip()]
            seed_recid = str(inputs.seed_recid or "").strip()
            workflow_plan = resolve_literature_workflow(
                repo_root,
                recipe_id="literature_gap_analysis",
                phase="discover",
                inputs={
                    "query": topic,
                    "topic": topic,
                    "focus": list(focus_terms),
                    "seed_recid": seed_recid or None,
                },
                available_tools=tool_names,
                preferred_providers=["inspire"],
            )
            write_json(plan_path, workflow_plan)

            resolved_steps = workflow_plan.get("resolved_steps") if isinstance(workflow_plan, dict) else None
            if not isinstance(resolved_steps, list) or not resolved_steps:
                errors.append("literature workflow launcher returned no discover steps")
            for step in resolved_steps or []:
                if not isinstance(step, dict):
                    continue
                step_id = str(step.get("id") or "").strip()
                tool_name = str(step.get("tool") or "").strip()
                step_args = step.get("params") if isinstance(step.get("params"), dict) else {}
                if not step_id or not tool_name:
                    errors.append("literature workflow launcher returned an invalid discover step")
                    continue
                result = client.call_tool_json(tool_name=tool_name, arguments=step_args, timeout_seconds=300.0)
                record(
                    tool_name,
                    "ok" if result.ok else "error",
                    workflow_step=step_id,
                    provider=str(step.get("provider") or "") or None,
                )
                if not result.ok:
                    errors.append(f"{tool_name}: {result.raw_text or '(error)'}")
                if step_id == "seed_search":
                    discover_ok = bool(result.ok)
                    discover_json = result.json

            write_json(discover_path, discover_json if discover_json is not None else {})
            candidates_json = extract_seed_search_candidates(discover_json, created_at=created_at)
            candidates_json["inputs"] = {
                "topic": topic,
                "query": topic,
                "focus": list(focus_terms),
                "seed_recid": seed_recid or None,
            }
            candidates_json["resolver"] = {
                "recipe_id": "literature_gap_analysis",
                "phase": "discover",
                "seed_recids_preview": extract_candidate_recids(
                    discover_json,
                    max_recids=int(inputs.max_recids or 12),
                ),
            }
    except Exception as exc:
        errors.append(f"exception: {exc}")

    write_json(plan_path, workflow_plan if workflow_plan is not None else {})
    write_json(discover_path, discover_json if discover_json is not None else {})
    write_json(
        candidates_path,
        candidates_json
        if candidates_json is not None
        else {"schema_version": 1, "created_at": created_at, "papers": [], "inputs": {"topic": topic}},
    )

    gap_report = {
        "schema_version": 1,
        "created_at": created_at,
        "phase": "discover",
        "inputs": {
            "topic": topic,
            "focus": [str(value).strip() for value in inputs.focus if str(value).strip()],
            "seed_recid": str(inputs.seed_recid or "").strip() or None,
            "iterations": int(inputs.iterations or 2),
            "max_papers": int(inputs.max_papers or 40),
        },
        "results": {
            "ok": bool(not errors),
            "errors": errors,
            "workflow_plan": {"path": _rel(repo_root, plan_path)},
            "seed_search": {"ok": bool(discover_ok), "path": _rel(repo_root, discover_path)},
            "candidates": {
                "path": _rel(repo_root, candidates_path),
                "stats": (candidates_json.get("stats") if isinstance(candidates_json, dict) else None),
            },
            "seed_selection_required": True,
            "seed_selection_contract": {
                "schema_version": 1,
                "required_fields": ["schema_version", "selection_logic", "items[].recid", "items[].reason_for_inclusion"],
            },
        },
        "agent_actions": actions,
    }
    write_json(gap_report_path, gap_report)

    manifest: dict[str, Any] = {
        "schema_version": 1,
        "created_at": created_at,
        "command": "hep_autoresearch.toolkit.literature_gap.run_literature_gap_discover",
        "cwd": manifest_cwd(repo_root=repo_root, cwd=repo_root),
        "params": {
            "tag": tag,
            "phase": "discover",
            "topic": topic,
            "mcp_server": cfg.name,
        },
        "versions": {"python": sys.version.split()[0], "os": platform.platform()},
        "mcp": {"server_name": cfg.name, "init": mcp_init, "tools": mcp_tools},
        "outputs": [
            _rel(repo_root, manifest_path),
            _rel(repo_root, summary_path),
            _rel(repo_root, analysis_path),
            _rel(repo_root, gap_report_path),
            _rel(repo_root, plan_path),
            _rel(repo_root, discover_path),
            _rel(repo_root, candidates_path),
        ],
    }
    git_meta = try_get_git_metadata(repo_root)
    if git_meta:
        manifest["git"] = git_meta

    stats_candidates = candidates_json.get("stats") if isinstance(candidates_json, dict) else None
    summary: dict[str, Any] = {
        "schema_version": 1,
        "created_at": created_at,
        "definitions": {"kind": "literature_gap_discover"},
        "stats": {
            "ok": bool(not errors),
            "errors": int(len(errors)),
            "actions": int(len(actions)),
            "candidates": (stats_candidates.get("unique_recids") if isinstance(stats_candidates, dict) else None),
        },
        "outputs": {"gap_report": _rel(repo_root, gap_report_path), "candidates": _rel(repo_root, candidates_path)},
    }
    analysis_out: dict[str, Any] = {
        "schema_version": 1,
        "created_at": created_at,
        "inputs": {"tag": tag, "phase": "discover", "topic": topic},
        "results": {
            "ok": bool(not errors),
            "errors": errors,
            "actions": actions,
            "candidates_stats": stats_candidates,
            "outputs": {"gap_report": _rel(repo_root, gap_report_path), "candidates": _rel(repo_root, candidates_path)},
        },
    }

    write_json(manifest_path, manifest)
    write_json(summary_path, summary)
    write_json(analysis_path, analysis_out)
    write_artifact_report(repo_root=repo_root, artifact_dir=out_dir, manifest=manifest, summary=summary, analysis=analysis_out)

    return LiteratureGapRunResult(exit_code=0 if not errors else 2, out_dir=out_dir, errors=errors)


def run_literature_gap_analyze(repo_root: Path, inputs: LiteratureGapAnalyzeInputs) -> LiteratureGapRunResult:
    tag = str(inputs.tag or "").strip()
    if not tag:
        raise ValueError("--tag is required")

    created_at = utc_now_iso().replace("+00:00", "Z")
    out_dir = (repo_root / "artifacts" / "runs" / tag / "literature_gap" / "analyze").resolve()
    out_dir.mkdir(parents=True, exist_ok=True)

    cfg_path = _mcp_config_path(repo_root, raw_path=inputs.mcp_config)
    if not cfg_path.exists():
        raise ValueError(
            "missing MCP config. Create .mcp.json (ignored by git) or pass --mcp-config.\n"
            f"expected: {cfg_path}"
        )

    server_name = str(inputs.mcp_server or "hep-research").strip()
    cfg = load_mcp_server_config(config_path=cfg_path, server_name=server_name)
    env = _mcp_env(
        repo_root,
        cfg.env,
        hep_data_dir_override=inputs.hep_data_dir,
        create_data_dir=False,
        project_policy=PROJECT_POLICY_REAL_PROJECT,
    )

    allow_external_inputs = bool(inputs.allow_external_inputs)
    seed_selection_raw = str(inputs.seed_selection or "").strip()
    if not seed_selection_raw:
        raise ValueError("--seed-selection is required for analyze")
    seed_selection_path = _resolve_path(repo_root, seed_selection_raw, allow_external=allow_external_inputs)
    if not seed_selection_path.exists():
        raise ValueError(f"--seed-selection not found: {seed_selection_path}")

    if str(inputs.candidates or "").strip():
        candidates_path_in = _resolve_path(repo_root, str(inputs.candidates or ""), allow_external=allow_external_inputs)
    else:
        candidates_path_in = (repo_root / "artifacts" / "runs" / tag / "literature_gap" / "discover" / "candidates.json").resolve()
    if not candidates_path_in.exists():
        raise ValueError(f"candidates.json not found (run discover first, or pass --candidates): {candidates_path_in}")

    cand_recids, cand_obj, cand_errs = _load_candidates(candidates_path_in)
    if cand_errs:
        raise ValueError("invalid candidates.json:\n- " + "\n- ".join(cand_errs))

    topic = str(inputs.topic or "").strip()
    cand_topic = ""
    inps = cand_obj.get("inputs") if isinstance(cand_obj, dict) else None
    if isinstance(inps, dict):
        cand_topic = str(inps.get("topic") or "").strip()
    if topic and cand_topic and topic != cand_topic:
        raise ValueError(
            f"--topic mismatch for analyze: cli={topic!r}, candidates.json#/inputs/topic={cand_topic!r}. "
            "Use --candidates to point to the matching discover run, or omit --topic to infer."
        )
    if not topic:
        topic = cand_topic
    if not topic:
        raise ValueError("--topic missing and could not infer it from candidates.json#/inputs/topic")

    seed_recids, _seed_obj, seed_errs = _load_seed_selection(seed_selection_path)
    if seed_errs:
        raise ValueError("invalid seed_selection.json:\n- " + "\n- ".join(seed_errs))

    errors: list[str] = []
    missing = [recid for recid in seed_recids if recid not in cand_recids]
    if missing and not inputs.allow_external_seeds:
        raise ValueError(
            "seed_selection contains recids not present in candidates.json (refuse to continue without --allow-external-seeds):\n- "
            + "\n- ".join(missing[:20])
            + ("\n- …" if len(missing) > 20 else "")
        )
    if missing and inputs.allow_external_seeds:
        errors.append(f"seed_selection: {len(missing)} recids not in candidates.json (allowed by --allow-external-seeds)")

    max_recids = int(inputs.max_recids or 12)
    if max_recids < 1:
        raise ValueError("--max-recids must be >= 1")
    recids = seed_recids[:max_recids]
    if not recids:
        raise ValueError("seed_selection produced no recids (cannot analyze)")

    seed_copy_path = out_dir / "seed_selection.json"
    seed_copy_path.write_text(seed_selection_path.read_text(encoding="utf-8", errors="replace"), encoding="utf-8")
    seed_copy_sha256 = _sha256_file(seed_copy_path)

    plan_path = out_dir / "workflow_plan.json"
    topic_path = out_dir / "topic_analysis.json"
    critical_path = out_dir / "critical_analysis.json"
    network_path = out_dir / "network_analysis.json"
    connection_path = out_dir / "connection_scan.json"
    gap_report_path = out_dir / "gap_report.json"
    manifest_path = out_dir / "manifest.json"
    summary_path = out_dir / "summary.json"
    analysis_path = out_dir / "analysis.json"

    actions: list[dict[str, Any]] = []
    workflow_plan: dict[str, Any] | None = None
    topic_json: Any | None = None
    critical_json: Any | None = None
    network_json: Any | None = None
    connection_json: Any | None = None
    mcp_init: dict[str, Any] | None = None
    mcp_tools: list[str] = []

    def record(tool: str, status: str, **extras: Any) -> None:
        row: dict[str, Any] = {
            "tool": tool,
            "status": status,
            "timestamp": utc_now_iso().replace("+00:00", "Z"),
        }
        row.update(extras)
        actions.append(row)

    try:
        with McpStdioClient(cfg=cfg, cwd=repo_root, env=env) as client:
            init_raw = client.initialize(client_name="autoresearch", client_version="0.0.1")
            mcp_init = {
                "protocolVersion": init_raw.get("protocolVersion") if isinstance(init_raw, dict) else None,
                "serverInfo": init_raw.get("serverInfo") if isinstance(init_raw, dict) else None,
            }
            tools = client.list_tools()
            tool_names = {tool.name for tool in tools}
            mcp_tools = sorted(tool_names)

            network_direction_cli = str(inputs.network_direction or "both").strip().lower()
            direction_map = {"both": "both", "in": "citations", "out": "refs"}
            network_direction_tool = direction_map.get(network_direction_cli, "both")
            seed = str(recids[0])
            workflow_plan = resolve_literature_workflow(
                repo_root,
                recipe_id="literature_gap_analysis",
                phase="analyze",
                inputs={"topic": topic, "recids": recids, "analysis_seed": seed},
                available_tools=tool_names,
                preferred_providers=["inspire"],
            )
            write_json(plan_path, workflow_plan)

            resolved_steps = workflow_plan.get("resolved_steps") if isinstance(workflow_plan, dict) else None
            if not isinstance(resolved_steps, list) or not resolved_steps:
                errors.append("literature workflow launcher returned no analyze steps")
            for step in resolved_steps or []:
                if not isinstance(step, dict):
                    continue
                step_id = str(step.get("id") or "").strip()
                tool_name = str(step.get("tool") or "").strip()
                step_args = dict(step.get("params") or {}) if isinstance(step.get("params"), dict) else {}
                if step_id == "topic_scan":
                    step_args["mode"] = str(inputs.topic_mode or "timeline")
                    step_args["topic"] = topic
                    step_args["limit"] = int(inputs.topic_limit or 40)
                    step_args["options"] = {"granularity": str(inputs.topic_granularity or "5year")}
                elif step_id == "critical_analysis":
                    step_args["recid"] = seed
                elif step_id == "citation_network":
                    step_args["mode"] = str(inputs.network_mode or "citation")
                    step_args["seed"] = seed
                    step_args["limit"] = int(inputs.network_limit or 80)
                    step_args["options"] = {
                        "depth": int(inputs.network_depth or 1),
                        "direction": network_direction_tool,
                    }
                elif step_id == "connection_scan":
                    step_args["recids"] = recids
                    if not recids:
                        connection_json = {
                            "schema_version": 1,
                            "created_at": created_at,
                            "workflow_step": step_id,
                            "status": "skipped",
                            "reason": "no_input_recids",
                            "summary": "No recids were available, so connection analysis was skipped.",
                            "inputs": {"recids": []},
                        }
                        record(
                            tool_name,
                            "skipped",
                            workflow_step=step_id,
                            provider=str(step.get("provider") or "") or None,
                            reason="no_input_recids",
                        )
                        continue
                result = client.call_tool_json(tool_name=tool_name, arguments=step_args, timeout_seconds=300.0)
                extras: dict[str, Any] = {
                    "workflow_step": step_id,
                    "provider": str(step.get("provider") or "") or None,
                }
                if step_id == "citation_network":
                    extras["network_direction_cli"] = network_direction_cli
                    extras["network_direction_tool"] = network_direction_tool
                record(tool_name, "ok" if result.ok else "error", **extras)
                if not result.ok:
                    errors.append(f"{tool_name}: {result.raw_text or '(error)'}")
                if step_id == "topic_scan":
                    topic_json = result.json
                elif step_id == "critical_analysis":
                    critical_json = result.json
                elif step_id == "citation_network":
                    network_json = result.json
                elif step_id == "connection_scan":
                    connection_json = result.json
    except Exception as exc:
        errors.append(f"exception: {exc}")

    write_json(plan_path, workflow_plan if workflow_plan is not None else {})
    write_json(topic_path, topic_json if topic_json is not None else {})
    write_json(critical_path, critical_json if critical_json is not None else {})
    write_json(network_path, network_json if network_json is not None else {})
    write_json(connection_path, connection_json if connection_json is not None else {})

    gap_report = {
        "schema_version": 1,
        "created_at": created_at,
        "phase": "analyze",
        "inputs": {
            "topic": topic,
            "seed_selection_path": _rel(repo_root, seed_copy_path),
            "seed_selection_sha256": seed_copy_sha256,
            "candidates_path": _rel(repo_root, candidates_path_in),
            "recids": recids,
        },
        "results": {
            "ok": bool(not errors),
            "errors": errors,
            "workflow_plan": {"path": _rel(repo_root, plan_path)},
            "topic_analysis": {"path": _rel(repo_root, topic_path)},
            "critical_analysis": {"path": _rel(repo_root, critical_path)},
            "network_analysis": {"path": _rel(repo_root, network_path)},
            "connection_scan": {"path": _rel(repo_root, connection_path)},
        },
        "agent_actions": actions,
    }
    write_json(gap_report_path, gap_report)

    manifest: dict[str, Any] = {
        "schema_version": 1,
        "created_at": created_at,
        "command": "hep_autoresearch.toolkit.literature_gap.run_literature_gap_analyze",
        "cwd": manifest_cwd(repo_root=repo_root, cwd=repo_root),
        "params": {"tag": tag, "phase": "analyze", "topic": topic, "mcp_server": cfg.name},
        "versions": {"python": sys.version.split()[0], "os": platform.platform()},
        "mcp": {"server_name": cfg.name, "init": mcp_init, "tools": mcp_tools},
        "outputs": [
            _rel(repo_root, manifest_path),
            _rel(repo_root, summary_path),
            _rel(repo_root, analysis_path),
            _rel(repo_root, gap_report_path),
            _rel(repo_root, plan_path),
            _rel(repo_root, topic_path),
            _rel(repo_root, critical_path),
            _rel(repo_root, network_path),
            _rel(repo_root, connection_path),
            _rel(repo_root, seed_copy_path),
        ],
    }
    git_meta = try_get_git_metadata(repo_root)
    if git_meta:
        manifest["git"] = git_meta

    summary: dict[str, Any] = {
        "schema_version": 1,
        "created_at": created_at,
        "definitions": {"kind": "literature_gap_analyze"},
        "stats": {"ok": bool(not errors), "recids": int(len(recids)), "errors": int(len(errors)), "actions": int(len(actions))},
        "outputs": {"gap_report": _rel(repo_root, gap_report_path), "seed_selection": _rel(repo_root, seed_copy_path)},
    }
    analysis_out: dict[str, Any] = {
        "schema_version": 1,
        "created_at": created_at,
        "inputs": {"tag": tag, "phase": "analyze", "topic": topic},
        "results": {
            "ok": bool(not errors),
            "errors": errors,
            "recids": recids,
            "actions": actions,
            "outputs": {"gap_report": _rel(repo_root, gap_report_path)},
        },
    }

    write_json(manifest_path, manifest)
    write_json(summary_path, summary)
    write_json(analysis_path, analysis_out)
    write_artifact_report(repo_root=repo_root, artifact_dir=out_dir, manifest=manifest, summary=summary, analysis=analysis_out)

    return LiteratureGapRunResult(exit_code=0 if not errors else 2, out_dir=out_dir, errors=errors)
