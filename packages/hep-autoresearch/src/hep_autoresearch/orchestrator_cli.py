from __future__ import annotations

import argparse
import json
import math
import os
import re
import shutil
import site
import subprocess
import sys
import zipfile
from collections import deque
from pathlib import Path

from .toolkit._time import utc_now_iso
from .toolkit._json import read_json, write_json
from .toolkit._paths import manifest_cwd
from .toolkit.artifact_report import write_artifact_report
from .toolkit.context_pack import ContextPackInputs, build_context_pack
from .toolkit.mcp_config import default_hep_data_dir, load_mcp_server_config, merged_env
from .toolkit.mcp_stdio_client import McpStdioClient
from .toolkit.project_policy import PROJECT_POLICY_REAL_PROJECT, assert_path_allowed, assert_project_root_allowed
from .toolkit.kb_profile import write_kb_profile
from .toolkit.project_scaffold import ensure_project_scaffold
from .toolkit.project_surface import PROJECT_CHARTER
from .toolkit.adapters.registry import (
    adapter_for_workflow,
    adapter_workflow_ids,
    default_run_card_for_workflow,
    load_run_card,
    validate_adapter_registry,
)
from .toolkit.evolution_proposal import EvolutionProposalInputs, evolution_proposal_one
from .toolkit.evolution_trigger import trigger_evolution_proposal
from .toolkit.skill_proposal import SkillProposalInputs, skill_proposal_one
from .toolkit.method_design import MethodDesignInputs, method_design_one
from .toolkit.orchestrator_state import (
    APPROVAL_CATEGORY_TO_POLICY_KEY,
    append_ledger_event,
    approval_policy_path,
    autoresearch_dir,
    check_approval_budget,
    check_approval_timeout,
    default_state,
    ensure_runtime_dirs,
    get_active_branch_id,
    ledger_path,
    load_state,
    maybe_mark_needs_recovery,
    next_approval_id,
    plan_md_path,
    persist_state_with_ledger_event,
    read_approval_policy,
    save_state,
    state_lock,
    state_path,
)
from .toolkit.approval_packet import ApprovalPacketData, write_trio
from .toolkit.report_renderer import collect_run_result, render_md, render_tex
from .toolkit.workflow_context import workflow_context
from .toolkit.ingest import IngestInputs, ingest_one
from .toolkit.reproduce import ReproduceInputs, reproduce_one
from .toolkit.paper_reviser import PaperReviserInputs, paper_reviser_one
from .toolkit.revision import RevisionInputs, revise_one
from .toolkit.computation import ComputationInputs, computation_one
from .toolkit.run_card import ensure_run_card, normalize_approval_run_card_fields
from .toolkit.run_card_schema import load_run_card_v2, normalize_and_validate_run_card_v2
from .toolkit.literature_workflows import extract_candidate_recids, resolve_literature_workflow
from .toolkit.logging_config import configure_logging


def _die(msg: str, code: int = 2) -> int:
    print(f"[error] {msg}")
    return code


def _public_run_workflow_ids() -> set[str]:
    return {
        "ingest",
        "reproduce",
        "paper_reviser",
        "revision",
        "literature_survey_polish",
    } | adapter_workflow_ids()


def _all_run_workflow_ids() -> set[str]:
    return {"computation"} | _public_run_workflow_ids()


def _run_workflow_id_help(*, public_surface: bool) -> str:
    if public_surface:
        return (
            "Workflow id for the remaining public non-computation legacy workflows, e.g. "
            + "|".join(sorted(_public_run_workflow_ids()))
        )
    return "Workflow id, e.g. " + "|".join(sorted(_all_run_workflow_ids()))


def _maybe_auto_trigger_evolution_proposal(
    repo_root: Path,
    st: dict[str, object],
    *,
    terminal_status: str,
) -> None:
    run_id = st.get("run_id")
    if not isinstance(run_id, str) or not run_id.strip():
        return
    workflow_id = st.get("workflow_id")
    result = trigger_evolution_proposal(
        repo_root=repo_root,
        run_id=run_id,
        workflow_id=str(workflow_id) if isinstance(workflow_id, str) else None,
        terminal_status=terminal_status,
    )

    artifact_paths = result.artifact_paths if isinstance(result.artifact_paths, dict) else {}
    if artifact_paths:
        prefixed = {f"evolution_proposal_{key}": value for key, value in artifact_paths.items()}
        if result.artifact_dir:
            prefixed["evolution_proposal_artifact_dir"] = str(result.artifact_dir)
        st.setdefault("artifacts", {}).update(prefixed)
        save_state(repo_root, st)

    if result.status == "failed":
        print(f"[warn] evolution trigger failed: {result.reason}", file=sys.stderr)


def _looks_like_project_root(path: Path) -> bool:
    ap = path / ".autoresearch"
    if not ap.is_dir():
        return False

    init_marker = ap / ".initialized"
    has_state = (ap / "state.json").exists()
    has_policy = (ap / "approval_policy.json").exists()
    has_ledger = (ap / "ledger.jsonl").exists()

    # Require a stable sentinel to avoid false positives on stale directories.
    # - Preferred (v0+): `.autoresearch/.initialized` AND at least one core state file.
    # - Legacy: `state.json` plus another core file.
    if init_marker.exists():
        if not (has_state or has_policy):
            return False
    else:
        if not (has_state and (has_policy or has_ledger)):
            return False

    # Reduce false positives by requiring at least one project marker file/dir in addition to `.autoresearch/*`.
    for marker in [
        path / PROJECT_CHARTER,
        path / "AGENTS.md",
        path / "docs",
        path / "specs",
        path / "artifacts",
        path / ".git",
    ]:
        if marker.exists():
            return True
    return False


def _find_nearest_project_root(start: Path) -> Path | None:
    cur = start.resolve()
    max_depth = 50
    for _ in range(max_depth):
        if _looks_like_project_root(cur):
            return cur
        if cur.parent == cur:
            return None
        cur = cur.parent
    return None


def _repo_root_from_args(args: argparse.Namespace) -> Path:
    override = getattr(args, "project_root", None)
    if isinstance(override, str) and override.strip():
        p = Path(override).expanduser()
        if not p.is_absolute():
            p = Path.cwd() / p
        return p.resolve()
    found = _find_nearest_project_root(Path.cwd())
    if found and found.resolve() == Path.home().resolve():
        print(
            "[warn] ignoring auto-discovered project root at $HOME; use --project-root to target it explicitly",
            file=sys.stderr,
        )
        found = None
    if found and found.resolve() != Path.cwd().resolve():
        print(
            f"[info] using project root: {found} (discovered from parent; use --project-root to override)",
            file=sys.stderr,
        )
    return found or Path.cwd()


def _repo_root_for_init(args: argparse.Namespace) -> Path:
    """Init should default to the *current directory* (or an explicit override).

    Unlike other commands, init must not automatically "snap" to a parent project root;
    users may intentionally create nested research projects.
    """
    override = getattr(args, "project_root", None)
    if isinstance(override, str) and override.strip():
        p = Path(override).expanduser()
        if not p.is_absolute():
            p = Path.cwd() / p
        return p.resolve()
    return Path.cwd()


def _read_or_init_state(repo_root: Path, *, _caller_holds_lock: bool = False) -> dict:
    ensure_runtime_dirs(repo_root)
    st = load_state(repo_root)
    if st is None:
        st = default_state()
        save_state(repo_root, st)
        append_ledger_event(repo_root, event_type="initialized", run_id=None, workflow_id=None, details={})
    maybe_mark_needs_recovery(repo_root, st, _caller_holds_lock=_caller_holds_lock)
    return st


def _ensure_context_pack(
    *,
    repo_root: Path,
    st: dict,
    run_id: str,
    workflow_id: str | None,
    note: str | None = None,
    refkey: str | None = None,
) -> None:
    """Create/refresh the per-run context pack and store pointers in state.

    This is the guardrail that keeps the whole project context (charter, plan, gates, artifact contract)
    visible even when executing a narrow local step.
    """
    res = build_context_pack(
        ContextPackInputs(
            run_id=str(run_id),
            workflow_id=str(workflow_id) if workflow_id else None,
            note=str(note) if note else None,
            refkey=str(refkey) if refkey else None,
        ),
        repo_root=repo_root,
    )
    st.setdefault("artifacts", {})["context_md"] = res.get("context_md")
    st.setdefault("artifacts", {})["context_json"] = res.get("context_json")
    save_state(repo_root, st)


def _ensure_kb_profile(
    *,
    repo_root: Path,
    st: dict,
    run_id: str,
    kb_profile: str,
    kb_profile_user_path: str | None = None,
) -> None:
    out_dir = repo_root / "artifacts" / "runs" / str(run_id) / "kb_profile"
    outs = write_kb_profile(
        repo_root=repo_root,
        out_dir=out_dir,
        profile=str(kb_profile),
        user_profile_path=str(kb_profile_user_path) if kb_profile_user_path else None,
    )
    st.setdefault("artifacts", {})["kb_profile_json"] = outs.get("kb_profile_json")
    st.setdefault("artifacts", {})["kb_profile_report"] = outs.get("report")
    st["kb_profile"] = {"profile": str(kb_profile), "user_profile_path": kb_profile_user_path}
    save_state(repo_root, st)


def _ensure_run_card(
    *,
    repo_root: Path,
    st: dict,
    run_id: str,
    workflow_id: str | None,
    params: dict | None = None,
    notes: str | None = None,
    overwrite: bool = False,
) -> None:
    if not run_id or not str(run_id).strip():
        return
    wid = str(workflow_id) if workflow_id else "(unknown)"
    artifacts = st.setdefault("artifacts", {})
    evidence_bundle: dict = {}
    if isinstance(artifacts, dict):
        evidence_bundle = {
            "context_md": artifacts.get("context_md"),
            "context_json": artifacts.get("context_json"),
            "kb_profile_json": artifacts.get("kb_profile_json"),
            "kb_profile_report": artifacts.get("kb_profile_report"),
        }
    rel, sha = ensure_run_card(
        repo_root=repo_root,
        run_id=str(run_id),
        workflow_id=wid,
        params=params if isinstance(params, dict) else {},
        orchestrator_command=list(sys.argv),
        evidence_bundle=evidence_bundle,
        notes=notes,
        overwrite=bool(overwrite),
    )
    if isinstance(artifacts, dict):
        artifacts["run_card"] = rel
        artifacts["run_card_sha256"] = sha
    save_state(repo_root, st)


def cmd_init(args: argparse.Namespace) -> int:
    repo_root = _repo_root_for_init(args)
    if repo_root.name == ".autoresearch":
        return _die("refusing init inside .autoresearch/ (run init at the project root, or use --project-root)")
    parent_root = _find_nearest_project_root(repo_root.parent)
    if parent_root and parent_root.resolve() == Path.home().resolve():
        parent_root = None
    if parent_root and parent_root.resolve() != repo_root.resolve() and not bool(getattr(args, "allow_nested", False)):
        return _die(
            "refusing init: a parent directory is already a project root "
            f"({parent_root}); run init at the intended root, or pass --allow-nested"
        )
    scaffold_root = repo_root
    if not bool(getattr(args, "runtime_only", False)):
        scaffold_root = assert_project_root_allowed(repo_root, project_policy=PROJECT_POLICY_REAL_PROJECT)

    with state_lock(repo_root):
        ensure_runtime_dirs(repo_root)
        scaffold = (
            {"created": [], "skipped": []}
            if bool(getattr(args, "runtime_only", False))
            else ensure_project_scaffold(
                repo_root=scaffold_root,
                project_name=scaffold_root.name,
                project_policy=PROJECT_POLICY_REAL_PROJECT,
            )
        )
        st_path = state_path(repo_root)
        if st_path.exists() and not args.force:
            print(f"[ok] already initialized: {st_path}")
        else:
            st = default_state()
            if args.checkpoint_interval_seconds is not None:
                st["checkpoints"]["checkpoint_interval_seconds"] = int(args.checkpoint_interval_seconds)
            save_state(repo_root, st)
            append_ledger_event(repo_root, event_type="initialized", run_id=None, workflow_id=None, details={})
            print(f"[ok] wrote: {st_path}")

        policy_path = approval_policy_path(repo_root)
        if not policy_path.exists():
            policy = read_approval_policy(repo_root)
            policy_path.parent.mkdir(parents=True, exist_ok=True)
            policy_path.write_text(json.dumps(policy, indent=2, sort_keys=True) + "\n", encoding="utf-8")
            print(f"[ok] wrote: {policy_path}")
        else:
            print(f"[ok] approval policy present: {policy_path}")

        marker = autoresearch_dir(repo_root) / ".initialized"
        if not marker.exists():
            marker.write_text(utc_now_iso().replace("+00:00", "Z") + "\n", encoding="utf-8")
        print(f"[ok] runtime dir: {autoresearch_dir(repo_root)}")
        if bool(getattr(args, "runtime_only", False)):
            print("[ok] project scaffold skipped (--runtime-only)")

    created = scaffold.get("created") if isinstance(scaffold, dict) else None
    if isinstance(created, list) and created:
        print("[ok] scaffold created:")
        for p in created[:50]:
            print(f"- {p}")
        if len(created) > 50:
            print(f"- ... ({len(created) - 50} more)")
    return 0


def cmd_start(args: argparse.Namespace) -> int:
    repo_root = _repo_root_from_args(args)
    st = _read_or_init_state(repo_root)

    if st.get("run_status") in {"running", "awaiting_approval"} and not args.force:
        return _die(f"already running or awaiting approval (status={st.get('run_status')}); use --force to override")

    now = _now_z()
    st["run_id"] = args.run_id
    st["workflow_id"] = args.workflow_id
    st["run_status"] = "running"
    st["pending_approval"] = None
    st["gate_satisfied"] = {}
    st["approval_history"] = []
    st["artifacts"] = {}
    st["plan"] = _build_plan_for_run(
        workflow_id=str(args.workflow_id),
        run_id=str(args.run_id),
        args=args,
        refkey=None,
    )
    try:
        st["plan_md_path"] = os.fspath(plan_md_path(repo_root).relative_to(repo_root))
    except Exception:  # CONTRACT-EXEMPT: CODE-01.5 diagnostic fallthrough
        st["plan_md_path"] = os.fspath(plan_md_path(repo_root))

    plan = st.get("plan") if isinstance(st.get("plan"), dict) else {}
    default_step_id = str(plan.get("current_step_id") or "START")
    step_id = str(args.step_id or default_step_id)
    default_title = ""
    steps = plan.get("steps") if isinstance(plan, dict) else None
    if isinstance(steps, list):
        for step in steps:
            if isinstance(step, dict) and str(step.get("step_id")) == step_id:
                default_title = str(step.get("description") or "")
                break
    title = str(args.step_title or default_title or "Start run")
    st["current_step"] = {"step_id": step_id, "title": title, "started_at": now}
    _sync_plan_current_step(repo_root, st, step_id=step_id, title=title)

    st.setdefault("checkpoints", {})["last_checkpoint_at"] = now
    if args.checkpoint_interval_seconds is not None:
        st["checkpoints"]["checkpoint_interval_seconds"] = int(args.checkpoint_interval_seconds)

    save_state(repo_root, st)
    append_ledger_event(
        repo_root,
        event_type="run_started",
        run_id=st.get("run_id"),
        workflow_id=st.get("workflow_id"),
        step_id=st["current_step"]["step_id"],
        details={"note": args.note or ""},
    )
    try:
        _ensure_context_pack(
            repo_root=repo_root,
            st=st,
            run_id=st.get("run_id") or args.run_id,
            workflow_id=st.get("workflow_id") or args.workflow_id,
            note=args.note,
        )
        _ensure_run_card(
            repo_root=repo_root,
            st=st,
            run_id=str(st.get("run_id") or args.run_id),
            workflow_id=st.get("workflow_id") or args.workflow_id,
            params={"command": "start", "run_id": args.run_id, "workflow_id": args.workflow_id, "note": args.note or ""},
            notes="run-card recorded at start",
            overwrite=True,
        )
    except Exception as e:
        return _die(f"failed to build context pack: {e}")
    print(f"[ok] started run_id={st['run_id']} workflow_id={st['workflow_id']}")
    return 0


_REVISION_SUBSTEP_ORDER = ("A", "B", "C", "D", "E", "APPLY")


class GateResolutionError(ValueError):
    """Raised when approval resolution mode/policy combination is invalid."""


def _status_warning(*, code: str, message: str, path: str | None = None) -> dict[str, str]:
    payload: dict[str, str] = {
        "code": str(code),
        "message": str(message),
    }
    if isinstance(path, str) and path.strip():
        payload["path"] = path.strip()
    return payload


def _status_effective_run_status(st: dict) -> tuple[str | None, list[dict[str, str]]]:
    run_status = st.get("run_status")
    warnings: list[dict[str, str]] = []
    if run_status != "running":
        return (str(run_status) if isinstance(run_status, str) else None, warnings)

    checkpoints = st.get("checkpoints") if isinstance(st.get("checkpoints"), dict) else {}
    last = checkpoints.get("last_checkpoint_at") if isinstance(checkpoints, dict) else None
    interval = checkpoints.get("checkpoint_interval_seconds") if isinstance(checkpoints, dict) else None
    if not last:
        return ("running", warnings)
    try:
        interval_seconds = int(interval or 0)
    except Exception:  # CONTRACT-EXEMPT: CODE-01.5 intentional fallback
        interval_seconds = 0
    if interval_seconds <= 0:
        return ("running", warnings)
    try:
        import datetime as dt

        last_dt = dt.datetime.fromisoformat(str(last).replace("Z", "+00:00"))
        now_dt = dt.datetime.now(dt.timezone.utc)
    except Exception:  # CONTRACT-EXEMPT: CODE-01.5 intentional fallback
        return ("running", warnings)

    age = (now_dt - last_dt).total_seconds()
    if age <= 2 * interval_seconds:
        return ("running", warnings)
    warnings.append(
        _status_warning(
            code="checkpoint_stale",
            message=(
                "checkpoint heartbeat is stale; status is displayed as needs_recovery "
                "(read-only, state.json not mutated)"
            ),
        )
    )
    return ("needs_recovery", warnings)


def _status_revision_substeps_from_state(st: dict) -> dict[str, str]:
    out: dict[str, str] = {k: "pending" for k in _REVISION_SUBSTEP_ORDER}
    step_id_to_key = {"paper_reviser.round_01": "A", "paper_reviser.verification_plan": "B", "paper_reviser.retrieval": "C", "paper_reviser.evidence_synthesis": "D", "paper_reviser.round_02": "E", "paper_reviser.apply": "APPLY"}

    plan = st.get("plan") if isinstance(st.get("plan"), dict) else None
    steps = plan.get("steps") if isinstance(plan, dict) else None
    if isinstance(steps, list):
        for step in steps:
            if not isinstance(step, dict):
                continue
            sid = str(step.get("step_id") or "").strip()
            key = step_id_to_key.get(sid)
            if not key:
                continue
            status = step.get("status")
            if isinstance(status, str) and status.strip():
                out[key] = status.strip()

    current = st.get("current_step") if isinstance(st.get("current_step"), dict) else None
    cur_sid = str((current or {}).get("step_id") or "").strip()
    cur_key = step_id_to_key.get(cur_sid)
    if cur_key and out.get(cur_key, "pending") in {"pending", ""}:
        out[cur_key] = "in_progress"
    return out


def _status_revision_substeps_from_manifest(repo_root: Path, run_id: str | None) -> tuple[dict[str, str] | None, list[dict[str, str]]]:
    warnings: list[dict[str, str]] = []
    rid = str(run_id or "").strip()
    if not rid:
        warnings.append(
            _status_warning(
                code="revision_manifest_missing_run_id",
                message="run_id missing; cannot inspect artifacts/runs/<run_id>/paper_reviser/manifest.json",
            )
        )
        return (None, warnings)

    manifest_path = repo_root / "artifacts" / "runs" / rid / "paper_reviser" / "manifest.json"
    try:
        rel_manifest = os.fspath(manifest_path.relative_to(repo_root))
    except Exception:  # CONTRACT-EXEMPT: CODE-01.5 diagnostic fallthrough
        rel_manifest = os.fspath(manifest_path)

    if not manifest_path.exists():
        warnings.append(
            _status_warning(
                code="revision_manifest_missing",
                message="paper_reviser manifest missing; fallback to .autoresearch/state.json",
                path=rel_manifest,
            )
        )
        return (None, warnings)

    try:
        payload = read_json(manifest_path)
    except Exception as exc:
        warnings.append(
            _status_warning(
                code="revision_manifest_corrupt",
                message=f"failed to read/parse paper_reviser manifest ({exc}); fallback to .autoresearch/state.json",
                path=rel_manifest,
            )
        )
        return (None, warnings)

    steps = payload.get("steps") if isinstance(payload, dict) else None
    if not isinstance(steps, dict):
        warnings.append(
            _status_warning(
                code="revision_manifest_steps_schema_invalid",
                message="manifest.steps is missing or not an object; fallback to .autoresearch/state.json",
                path=rel_manifest,
            )
        )
        return (None, warnings)

    parsed: dict[str, str] = {}
    for key in _REVISION_SUBSTEP_ORDER:
        item = steps.get(key)
        if not isinstance(item, dict):
            warnings.append(
                _status_warning(
                    code="revision_manifest_steps_schema_invalid",
                    message=f"manifest.steps.{key} missing or not an object; fallback to .autoresearch/state.json",
                    path=rel_manifest,
                )
            )
            return (None, warnings)
        status = item.get("status")
        if not isinstance(status, str) or not status.strip():
            warnings.append(
                _status_warning(
                    code="revision_manifest_steps_schema_invalid",
                    message=f"manifest.steps.{key}.status missing/invalid; fallback to .autoresearch/state.json",
                    path=rel_manifest,
                )
            )
            return (None, warnings)
        parsed[key] = status.strip()

    return (parsed, warnings)


def _status_revision_manifest_is_completed(substeps: dict[str, str]) -> bool:
    if not isinstance(substeps, dict):
        return False
    success = {"completed", "skipped"}
    for key in _REVISION_SUBSTEP_ORDER:
        status = str(substeps.get(key) or "").strip()
        if status not in success:
            return False
    return True


def _status_revision_manifest_derived_run_status(substeps: dict[str, str]) -> str:
    statuses = {str(v).strip() for v in substeps.values() if isinstance(v, str)}
    if "blocked_by_gate" in statuses:
        return "blocked_by_gate"
    if "needs_manual_evidence" in statuses:
        return "needs_manual_evidence"
    if "failed" in statuses or "needs_force" in statuses:
        return "failed"
    if _status_revision_manifest_is_completed(substeps):
        return "completed"
    if statuses and (statuses != {"pending"}):
        return "in_progress"
    return "pending"


def cmd_status(args: argparse.Namespace) -> int:
    repo_root = _repo_root_from_args(args)
    # Intentionally read-only: status display must not mutate .autoresearch/state.json.
    # Crash-recovery transitions (maybe_mark_needs_recovery) are persisted by mutating commands
    # via _read_or_init_state().
    st = load_state(repo_root)
    if st is None:
        return _die("not initialized (run: autoresearch init)")

    warnings: list[dict[str, str]] = []
    display_run_status, stale_warnings = _status_effective_run_status(st)
    warnings.extend(stale_warnings)
    if display_run_status is None:
        run_status_raw = st.get("run_status")
        display_run_status = str(run_status_raw) if isinstance(run_status_raw, str) else None

    reconciled = False
    revision_substeps: dict[str, str] | None = None
    revision_substeps_source: str | None = None
    if str(st.get("workflow_id") or "") == "paper_reviser":
        state_substeps = _status_revision_substeps_from_state(st)
        manifest_substeps, manifest_warnings = _status_revision_substeps_from_manifest(repo_root, str(st.get("run_id") or ""))
        warnings.extend(manifest_warnings)
        if manifest_substeps is None:
            revision_substeps = state_substeps
            revision_substeps_source = "state"
        else:
            revision_substeps = manifest_substeps
            revision_substeps_source = "manifest"
            prior_display_status = display_run_status
            display_run_status = _status_revision_manifest_derived_run_status(manifest_substeps)
            state_statuses = {str(v).strip().lower() for v in state_substeps.values() if isinstance(v, str)}
            manifest_completed = _status_revision_manifest_is_completed(manifest_substeps)
            if manifest_completed and (
                (str(prior_display_status or "") != "completed")
                or ("pending" in state_statuses)
                or ("in_progress" in state_statuses)
            ):
                reconciled = True
            if (str(st.get("run_status") or "") != str(display_run_status or "")) and manifest_completed:
                reconciled = True

    if bool(getattr(args, "json", False)):
        payload = {
            "run_status": display_run_status,
            "run_id": st.get("run_id"),
            "workflow_id": st.get("workflow_id"),
            "current_step": st.get("current_step") if isinstance(st.get("current_step"), dict) else None,
            "plan_md_path": st.get("plan_md_path"),
            "plan": st.get("plan") if isinstance(st.get("plan"), dict) else None,
            "checkpoints": st.get("checkpoints") if isinstance(st.get("checkpoints"), dict) else {},
            "pending_approval": st.get("pending_approval") if isinstance(st.get("pending_approval"), dict) else None,
            "artifacts": st.get("artifacts") if isinstance(st.get("artifacts"), dict) else {},
            "gate_satisfied": st.get("gate_satisfied") if isinstance(st.get("gate_satisfied"), dict) else {},
            "stop_files": {
                "pause": (repo_root / ".pause").exists(),
                "stop": (repo_root / ".stop").exists(),
            },
            "state_path": os.fspath(state_path(repo_root)),
            "approval_policy": os.fspath(approval_policy_path(repo_root)),
            "reconciled": bool(reconciled),
            "warnings": warnings,
        }
        if revision_substeps is not None:
            payload["revision_substeps"] = {
                "source": revision_substeps_source,
                "statuses": {k: revision_substeps.get(k) for k in _REVISION_SUBSTEP_ORDER},
            }
        print(json.dumps(payload, indent=2, ensure_ascii=False, sort_keys=True))
        return 0

    for w in warnings:
        code = str(w.get("code") or "warning")
        message = str(w.get("message") or "")
        path = str(w.get("path") or "").strip()
        if path:
            print(f"[warn][status] {code}: {message} ({path})", file=sys.stderr)
        else:
            print(f"[warn][status] {code}: {message}", file=sys.stderr)

    pause_file = repo_root / ".pause"
    stop_file = repo_root / ".stop"

    reconciled_tag = " [reconciled]" if reconciled else ""
    print(f"run_status: {display_run_status}{reconciled_tag}")
    print(f"run_id: {st.get('run_id')}")
    print(f"workflow_id: {st.get('workflow_id')}")
    current = st.get("current_step") or {}
    if isinstance(current, dict) and current:
        print(f"current_step: {current.get('step_id')} — {current.get('title')}")
        print(f"step_started_at: {current.get('started_at')}")

    plan = st.get("plan")
    if isinstance(plan, dict) and plan:
        print(f"plan_md_path: {st.get('plan_md_path')}")
        print(f"plan_current_step: {plan.get('current_step_id')}")
        steps = plan.get("steps")
        if isinstance(steps, list) and steps:
            print("plan_steps:")
            for step in steps:
                if not isinstance(step, dict):
                    continue
                sid = step.get("step_id")
                status = step.get("status")
                desc = step.get("description")
                print(f"  - {sid} [{status}]: {desc}")

    if revision_substeps is not None:
        print(f"revision_substeps_source: {revision_substeps_source}")
        print("revision_substeps:")
        for sid in _REVISION_SUBSTEP_ORDER:
            print(f"  - {sid}: {revision_substeps.get(sid)}")

    checkpoints = st.get("checkpoints") or {}
    if isinstance(checkpoints, dict):
        print(f"last_checkpoint_at: {checkpoints.get('last_checkpoint_at')}")
        print(f"checkpoint_interval_seconds: {checkpoints.get('checkpoint_interval_seconds')}")

    pending = st.get("pending_approval")
    if pending:
        print("pending_approval:")
        print(f"  approval_id: {pending.get('approval_id')}")
        print(f"  category: {pending.get('category')}")
        print(f"  requested_at: {pending.get('requested_at')}")
        print(f"  timeout_at: {pending.get('timeout_at')}")
        print(f"  on_timeout: {pending.get('on_timeout')}")
        print(f"  packet_path: {pending.get('packet_path')}")

    artifacts = st.get("artifacts") or {}
    if isinstance(artifacts, dict) and artifacts:
        print("artifacts:")
        for k in [
            "context_md",
            "context_json",
            "run_card",
            "run_card_sha256",
            "manifest",
            "summary",
            "analysis",
            "report",
            "latest_manifest",
            "latest_summary",
            "latest_analysis",
            "latest_report",
        ]:
            v = artifacts.get(k)
            if v:
                print(f"  {k}: {v}")

    gate_satisfied = st.get("gate_satisfied") or {}
    if isinstance(gate_satisfied, dict) and gate_satisfied:
        print("gate_satisfied:")
        for k, v in sorted(gate_satisfied.items()):
            print(f"  {k}: {v}")

    print(f"stop_files: pause={pause_file.exists()} stop={stop_file.exists()}")
    print(f"state_path: {state_path(repo_root)}")
    print(f"approval_policy: {approval_policy_path(repo_root)}")
    return 0


def cmd_pause(args: argparse.Namespace) -> int:
    repo_root = _repo_root_from_args(args)
    st = _read_or_init_state(repo_root)

    (repo_root / ".pause").write_text("paused\n", encoding="utf-8")
    # Preserve the previous status so resume can restore e.g. completed/failed
    # without accidentally flipping the run back to "running".
    if st.get("run_status") != "paused":
        st["paused_from_status"] = st.get("run_status")
    st["run_status"] = "paused"
    st["notes"] = args.note or "paused by user"
    save_state(repo_root, st)
    append_ledger_event(
        repo_root,
        event_type="paused",
        run_id=st.get("run_id"),
        workflow_id=st.get("workflow_id"),
        step_id=(st.get("current_step") or {}).get("step_id") if isinstance(st.get("current_step"), dict) else None,
        details={"note": args.note or ""},
    )
    print("[ok] paused (created .pause)")
    return 0


def cmd_resume(args: argparse.Namespace) -> int:
    repo_root = _repo_root_from_args(args)
    st = _read_or_init_state(repo_root)
    pending = st.get("pending_approval")
    if pending:
        return _die(f"cannot resume while awaiting approval ({pending.get('approval_id')}); run approve/reject")

    pause_file = repo_root / ".pause"
    if pause_file.exists():
        pause_file.unlink()

    if st.get("run_status") in {"idle", "completed", "failed"} and not args.force:
        return _die(f"cannot resume from status={st.get('run_status')} (use start or --force)")

    restored = st.pop("paused_from_status", None)
    st["run_status"] = restored or "running"
    st["notes"] = args.note or "resumed by user"
    st.setdefault("checkpoints", {})["last_checkpoint_at"] = utc_now_iso().replace("+00:00", "Z")
    save_state(repo_root, st)
    append_ledger_event(
        repo_root,
        event_type="resumed",
        run_id=st.get("run_id"),
        workflow_id=st.get("workflow_id"),
        step_id=(st.get("current_step") or {}).get("step_id") if isinstance(st.get("current_step"), dict) else None,
        details={"note": args.note or ""},
    )
    print("[ok] resumed")
    return 0


def cmd_checkpoint(args: argparse.Namespace) -> int:
    repo_root = _repo_root_from_args(args)
    st = _read_or_init_state(repo_root)
    if st.get("run_status") not in {"running", "paused", "awaiting_approval"} and not args.force:
        return _die(f"refusing checkpoint in status={st.get('run_status')} (use --force)")

    # --- C-01: enforce timeout/budget at every checkpoint ---
    timeout_action = check_approval_timeout(repo_root, st)
    if timeout_action:
        print(f"[warn] approval timed out (policy_action={timeout_action})", file=sys.stderr)
        return 0  # state already mutated; don't continue the checkpoint
    if check_approval_budget(repo_root, st):
        print("[warn] approval budget exhausted", file=sys.stderr)
        return 0
    # --- end C-01 ---

    if args.step_id or args.step_title:
        step_id = str(args.step_id or (st.get("current_step") or {}).get("step_id") or "STEP")
        title = str(args.step_title or (st.get("current_step") or {}).get("title") or "")
        st["current_step"] = {"step_id": step_id, "title": title, "started_at": _now_z()}
        _sync_plan_current_step(repo_root, st, step_id=step_id, title=title)
    st.setdefault("checkpoints", {})["last_checkpoint_at"] = _now_z()
    save_state(repo_root, st)
    append_ledger_event(
        repo_root,
        event_type="checkpoint",
        run_id=st.get("run_id"),
        workflow_id=st.get("workflow_id"),
        step_id=(st.get("current_step") or {}).get("step_id") if isinstance(st.get("current_step"), dict) else None,
        details={"note": args.note or ""},
    )
    print("[ok] checkpoint updated")
    return 0


def _require_plan(st: dict) -> dict:
    plan = st.get("plan")
    if not isinstance(plan, dict) or not plan:
        raise RuntimeError("plan missing in state (run: start)")
    return plan


def _validate_id(name: str, value: str | None) -> str:
    s = str(value or "").strip()
    if not s:
        raise ValueError(f"{name} is required")
    if any(ord(c) < 32 or ord(c) == 127 for c in s):
        raise ValueError(f"invalid {name}: contains control characters")
    if any(ch.isspace() for ch in s):
        raise ValueError(f"invalid {name}: whitespace is not allowed")
    if ":" in s:
        raise ValueError(f"invalid {name}: ':' is reserved for composite ids (decision_id:branch_id)")
    if s.startswith("-"):
        raise ValueError(f"invalid {name}: must not start with '-' (avoid CLI flag ambiguity)")
    allowed = set("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._-")
    if any(c not in allowed for c in s):
        raise ValueError(f"invalid {name}: contains unsupported characters (allow: [A-Za-z0-9._-])")
    return s


def _composite_branch_id(*, decision_id: str, branch_id: str) -> str:
    return f"{decision_id}:{branch_id}"


def _parse_composite_branch_id(composite: str) -> tuple[str, str]:
    parts = str(composite).split(":", 1)
    if len(parts) != 2:
        raise ValueError(f"invalid composite branch id: {composite!r}")
    a = parts[0].strip()
    b = parts[1].strip()
    if (not a) or (not b):
        raise ValueError(f"invalid composite branch id: {composite!r}")
    return a, b


def _ensure_plan_branching(plan: dict) -> dict:
    branching = plan.get("branching")
    if branching is None:
        branching = {
            "schema_version": 1,
            "active_branch_id": None,
            "max_branches_per_decision": 5,
            "decisions": [],
            "notes": "",
        }
        plan["branching"] = branching
    if not isinstance(branching, dict):
        raise ValueError("plan.branching must be an object or null")
    sv = branching.get("schema_version")
    if sv is None:
        branching["schema_version"] = 1
    else:
        if not isinstance(sv, int):
            raise ValueError("plan.branching.schema_version must be an integer")
        if int(sv) != 1:
            raise ValueError(f"unsupported plan.branching.schema_version: {sv}")
    if branching.get("active_branch_id") is not None:
        branching["active_branch_id"] = str(branching["active_branch_id"]).strip() or None
    if not isinstance(branching.get("max_branches_per_decision"), int) or int(branching["max_branches_per_decision"]) < 1:
        branching["max_branches_per_decision"] = 5
    decisions = branching.get("decisions")
    if decisions is None:
        branching["decisions"] = []
    elif not isinstance(decisions, list):
        raise ValueError("plan.branching.decisions must be an array")
    notes = branching.get("notes")
    if notes is None:
        branching["notes"] = ""
    elif not isinstance(notes, str):
        raise ValueError("plan.branching.notes must be a string")
    return branching


def _branch_decisions(branching: dict) -> list[dict]:
    decisions = branching.get("decisions")
    if decisions is None:
        return []
    if not isinstance(decisions, list):
        raise ValueError("plan.branching.decisions must be an array")
    return [d for d in decisions if isinstance(d, dict)]


def _find_decision(decisions: list[dict], decision_id: str) -> dict | None:
    for d in decisions:
        if str(d.get("decision_id")) == str(decision_id):
            return d
    return None


def cmd_branch_list(args: argparse.Namespace) -> int:
    repo_root = _repo_root_from_args(args)
    with state_lock(repo_root, timeout_seconds=5.0):
        return _cmd_branch_list_locked(repo_root, args)


def _cmd_branch_list_locked(repo_root: Path, args: argparse.Namespace) -> int:
    st = _read_or_init_state(repo_root, _caller_holds_lock=True)
    try:
        plan = _require_plan(st)
    except Exception as e:
        return _die(str(e))
    branching = plan.get("branching")
    if not isinstance(branching, dict):
        print("branching: (none)")
        return 0

    active = str(branching.get("active_branch_id") or "").strip() or "(none)"
    max_per = branching.get("max_branches_per_decision")
    print(f"branching.active_branch_id: {active}")
    print(f"branching.max_branches_per_decision: {max_per}")
    try:
        decisions = _branch_decisions(branching)
    except Exception as e:
        return _die(str(e))
    if not decisions:
        print("decisions: (none)")
        return 0
    print("decisions:")
    for d in decisions:
        did = str(d.get("decision_id") or "").strip() or "(missing)"
        title = str(d.get("title") or "").strip() or "(missing)"
        step_id = str(d.get("step_id") or "").strip() or "-"
        cap = d.get("max_branches")
        active_branch = str(d.get("active_branch_id") or "").strip() or "(none)"
        print(f"- {did} — {title} (step_id={step_id} max_branches={cap} active={active_branch})")
        branches = d.get("branches")
        if isinstance(branches, list):
            for br in branches:
                if not isinstance(br, dict):
                    continue
                bid = str(br.get("branch_id") or "").strip() or "(missing)"
                status = str(br.get("status") or "").strip() or "candidate"
                label = str(br.get("label") or "").strip() or bid
                desc = str(br.get("description") or "").strip() or ""
                print(f"  - [{status}] {bid} — {label}: {desc}")
    return 0


def _parse_expected_approvals(raw: str | None) -> list[str]:
    if raw is None:
        return []
    parts = [p.strip() for p in str(raw).split(",") if p.strip()]
    out: list[str] = []
    for p in parts:
        if p not in {"A1", "A2", "A3", "A4", "A5"}:
            raise ValueError(f"invalid expected approval category: {p!r}")
        out.append(p)
    return out


def cmd_branch_add(args: argparse.Namespace) -> int:
    repo_root = _repo_root_from_args(args)
    with state_lock(repo_root, timeout_seconds=30.0):
        return _cmd_branch_add_locked(repo_root, args)


def _cmd_branch_add_locked(repo_root: Path, args: argparse.Namespace) -> int:
    st = _read_or_init_state(repo_root, _caller_holds_lock=True)
    try:
        plan = _require_plan(st)
    except Exception as e:
        return _die(str(e))

    cur = st.get("current_step") if isinstance(st.get("current_step"), dict) else {}
    default_decision_id = cur.get("step_id") or plan.get("current_step_id") or "STEP"
    try:
        decision_id = _validate_id("decision_id", args.decision_id or str(default_decision_id))
    except Exception as e:
        return _die(str(e))

    plan_steps = plan.get("steps") if isinstance(plan.get("steps"), list) else []
    valid_step_ids = {str(s.get("step_id")) for s in plan_steps if isinstance(s, dict) and str(s.get("step_id") or "").strip()}
    if not valid_step_ids:
        return _die("plan.steps is missing/empty; cannot attach branching decisions")

    # Pre-validate decision.step_id without mutating the Plan SSOT.
    existing_decision: dict | None = None
    branching_existing = plan.get("branching")
    if isinstance(branching_existing, dict):
        decisions_existing = branching_existing.get("decisions")
        if isinstance(decisions_existing, list):
            for d in decisions_existing:
                if isinstance(d, dict) and str(d.get("decision_id")) == decision_id:
                    existing_decision = d
                    break
    if isinstance(existing_decision, dict):
        decision_step_id = str(existing_decision.get("step_id") or "").strip()
        if decision_step_id not in valid_step_ids:
            return _die(
                f"decision {decision_id} step_id {decision_step_id!r} not found in plan.steps (valid: {sorted(valid_step_ids)})"
            )
        provided_step_id = str(getattr(args, "step_id", None) or "").strip()
        if provided_step_id and provided_step_id != decision_step_id:
            return _die(
                f"--step-id={provided_step_id} conflicts with existing decision {decision_id} "
                + f"(already attached to step_id={decision_step_id}); cannot reassign step_id"
            )

    now = _now_z()
    step_id_to_use = None
    if existing_decision is None:
        step_id_to_use = args.step_id or str(cur.get("step_id") or plan.get("current_step_id") or "")
        if not str(step_id_to_use).strip():
            return _die(
                f"cannot determine step_id for new decision {decision_id}; no current step is active. "
                + f"Pass --step-id explicitly (valid: {sorted(valid_step_ids)})"
            )
        try:
            step_id_to_use = _validate_id("step_id", str(step_id_to_use))
        except Exception as e:
            return _die(str(e))
        if step_id_to_use not in valid_step_ids:
            return _die(f"step_id {step_id_to_use!r} not found in plan.steps (valid: {sorted(valid_step_ids)})")

    # Snapshot caps/branches without mutating Plan SSOT (so validation failures don't dirty in-memory state).
    base_cap = 5
    if isinstance(branching_existing, dict):
        try:
            base_cap = int(branching_existing.get("max_branches_per_decision") or 5)
        except Exception:  # CONTRACT-EXEMPT: CODE-01.5 intentional fallback
            base_cap = 5
    if base_cap < 1:
        base_cap = 5

    branches_existing: list[Any] = []
    decision_cap = base_cap
    existing_cap_override: int | None = None
    if isinstance(existing_decision, dict):
        if isinstance(existing_decision.get("branches"), list):
            branches_existing = existing_decision["branches"]
        try:
            decision_cap = int(existing_decision.get("max_branches") or 0)
        except Exception:  # CONTRACT-EXEMPT: CODE-01.5 intentional fallback
            decision_cap = 0
        if decision_cap < 1:
            decision_cap = base_cap
        if existing_decision.get("cap_override") is not None:
            try:
                existing_cap_override = int(existing_decision["cap_override"])
            except Exception:  # CONTRACT-EXEMPT: CODE-01.5 intentional fallback
                existing_cap_override = None

    branches_dicts = [b for b in branches_existing if isinstance(b, dict)]
    existing_branch_ids = {str(b.get("branch_id")) for b in branches_dicts if isinstance(b.get("branch_id"), str)}

    cap_override = int(args.cap_override) if args.cap_override is not None else None
    max_branches = int(decision_cap)
    cap_override_field = existing_cap_override
    if existing_decision is None:
        max_branches = int(base_cap)
        cap_override_field = None
        if cap_override is not None and cap_override != base_cap:
            if cap_override < 1:
                return _die("invalid --cap-override: must be >= 1")
            max_branches = int(cap_override)
            cap_override_field = int(cap_override)
    else:
        if cap_override is not None:
            if cap_override < 1:
                return _die("invalid --cap-override: must be >= 1")
            if cap_override > max_branches:
                max_branches = int(cap_override)
                cap_override_field = int(cap_override)

    if len(branches_dicts) >= max_branches:
        return _die(
            f"decision {decision_id} already has {len(branches_dicts)} branches (cap={max_branches}); pass --cap-override to raise cap explicitly"
        )

    try:
        approvals = _parse_expected_approvals(getattr(args, "expected_approvals", None))
    except Exception as e:
        return _die(str(e))
    outs = [str(o).strip() for o in (getattr(args, "expected_output", None) or []) if str(o).strip()]

    branch_id = getattr(args, "branch_id", None)
    if branch_id is not None:
        try:
            branch_id = _validate_id("branch_id", str(branch_id))
        except Exception as e:
            return _die(str(e))
    else:
        existing = {str(b.get("branch_id")) for b in branches_dicts if isinstance(b.get("branch_id"), str)}
        branch_id = None
        for i in range(1, 1000):
            cand = f"b{i}"
            if cand not in existing:
                branch_id = cand
                break
        if branch_id is None:
            return _die("could not allocate a branch_id (too many branches)")

    if str(branch_id) in existing_branch_ids:
        return _die(f"branch_id already exists in decision {decision_id}: {branch_id}")

    label = str(getattr(args, "label", None) or str(branch_id)).strip() or str(branch_id)
    description = str(getattr(args, "description", None) or "").strip()
    if not description:
        return _die("missing --description")
    if any(x in description for x in ["\n", "\r", "\x00"]):
        return _die("invalid --description: contains control characters")

    activate = bool(getattr(args, "activate", False))
    status = "active" if activate else "candidate"
    recovery_notes = str(getattr(args, "recovery_notes", None) or "")

    branching_initialized = plan.get("branching") is None
    try:
        branching = _ensure_plan_branching(plan)
        decisions = _branch_decisions(branching)
    except Exception as e:
        return _die(str(e))

    decision = _find_decision(decisions, decision_id)
    if decision is None:
        title = str(args.decision_title or f"Decision at {decision_id}").strip() or f"Decision at {decision_id}"
        if any(x in title for x in ["\n", "\r", "\x00"]):
            return _die("invalid --decision-title: contains control characters")
        if len(title) > 200:
            return _die("invalid --decision-title: too long (max 200 chars)")
        if not step_id_to_use:
            return _die("step_id could not be determined for new decision")
        step_id = str(step_id_to_use)
        decision = {
            "decision_id": decision_id,
            "title": title,
            "step_id": step_id,
            "created_at": now,
            "updated_at": now,
            "max_branches": int(max_branches),
            "cap_override": cap_override_field,
            "active_branch_id": None,
            "branches": [],
            "notes": "",
        }
        branching.setdefault("decisions", []).append(decision)
    else:
        decision["max_branches"] = int(max_branches)
        decision["cap_override"] = cap_override_field

    branches = decision.get("branches")
    if not isinstance(branches, list):
        branches = []
        decision["branches"] = branches
    branches_dicts = [b for b in branches if isinstance(b, dict)]

    if activate:
        prev = str(decision.get("active_branch_id") or "").strip() or None
        if prev and prev != branch_id:
            for b in branches_dicts:
                if str(b.get("branch_id")) == prev and b.get("status") == "active":
                    b["status"] = "abandoned"
                    b["updated_at"] = now
        decision["active_branch_id"] = str(branch_id)
        branching["active_branch_id"] = _composite_branch_id(decision_id=str(decision_id), branch_id=str(branch_id))

    branches.append(
        {
            "branch_id": str(branch_id),
            "label": label,
            "description": description,
            "status": status,
            "expected_approvals": approvals,
            "expected_outputs": outs,
            "recovery_notes": recovery_notes,
            "created_at": now,
            "updated_at": now,
        }
    )

    decision["updated_at"] = now
    plan["updated_at"] = now
    try:
        persist_state_with_ledger_event(
            repo_root,
            state=st,
            event_type="branch_candidate_added",
            run_id=st.get("run_id"),
            workflow_id=st.get("workflow_id"),
            step_id=str((st.get("current_step") or {}).get("step_id") or plan.get("current_step_id") or ""),
            details={
                "decision_id": decision_id,
                "branch_id": str(branch_id),
                "status": status,
                "cap": int(decision.get("max_branches") or 0),
                "cap_override": decision.get("cap_override"),
                "branching_initialized": bool(branching_initialized),
            },
        )
    except Exception as e:
        return _die(f"failed to persist branching update: {e}")
    print(f"[ok] added branch {branch_id} to decision {decision_id} (status={status})")
    return 0


def cmd_branch_switch(args: argparse.Namespace) -> int:
    repo_root = _repo_root_from_args(args)
    with state_lock(repo_root, timeout_seconds=30.0):
        return _cmd_branch_switch_locked(repo_root, args)


def _cmd_branch_switch_locked(repo_root: Path, args: argparse.Namespace) -> int:
    st = _read_or_init_state(repo_root, _caller_holds_lock=True)
    try:
        plan = _require_plan(st)
    except Exception as e:
        return _die(str(e))
    plan_steps = plan.get("steps") if isinstance(plan.get("steps"), list) else []
    valid_step_ids = {str(s.get("step_id")) for s in plan_steps if isinstance(s, dict) and str(s.get("step_id") or "").strip()}
    if not valid_step_ids:
        return _die("plan.steps is missing/empty; cannot switch branches")

    branching = plan.get("branching")
    if not isinstance(branching, dict):
        return _die("branching not initialized (run: branch add ... first)")
    if branching.get("schema_version") is not None and branching.get("schema_version") != 1:
        return _die(f"unsupported plan.branching.schema_version: {branching.get('schema_version')}")
    if not isinstance(branching.get("decisions"), list):
        return _die("plan.branching.decisions must be an array")
    try:
        decisions = _branch_decisions(branching)
    except Exception as e:
        return _die(str(e))

    cur = st.get("current_step") if isinstance(st.get("current_step"), dict) else {}
    default_decision_id = cur.get("step_id") or plan.get("current_step_id") or "STEP"
    try:
        decision_id = _validate_id("decision_id", args.decision_id or str(default_decision_id))
    except Exception as e:
        return _die(str(e))
    try:
        branch_id = _validate_id("branch_id", str(args.branch_id))
    except Exception as e:
        return _die(str(e))

    decision = _find_decision(decisions, decision_id)
    if decision is None:
        return _die(f"unknown decision_id: {decision_id}")
    decision_step_id = str(decision.get("step_id") or "").strip()
    if decision_step_id and decision_step_id not in valid_step_ids:
        return _die(
            f"decision {decision_id} references stale step_id {decision_step_id!r}; cannot switch branches (valid: {sorted(valid_step_ids)})"
        )
    branches = decision.get("branches")
    if not isinstance(branches, list):
        return _die(f"decision {decision_id} has no branches")

    target: dict | None = None
    for br in branches:
        if isinstance(br, dict) and str(br.get("branch_id")) == str(branch_id):
            target = br
            break
    if target is None:
        return _die(f"unknown branch_id {branch_id} in decision {decision_id}")

    now = _now_z()
    prev = str(decision.get("active_branch_id") or "").strip() or None
    prev_status = str(getattr(args, "previous_status", None) or "abandoned").strip()
    if prev_status not in {"abandoned", "failed", "completed"}:
        return _die(f"invalid --previous-status: {prev_status!r}")

    if prev and prev != branch_id:
        for br in branches:
            if not isinstance(br, dict):
                continue
            if str(br.get("branch_id")) != prev:
                continue
            if br.get("status") == "active":
                br["status"] = prev_status
                br["updated_at"] = now

    # Activate target branch.
    target["status"] = "active"
    target["updated_at"] = now
    decision["active_branch_id"] = branch_id
    decision["updated_at"] = now
    plan["updated_at"] = now
    branching["active_branch_id"] = _composite_branch_id(decision_id=str(decision_id), branch_id=str(branch_id))

    try:
        persist_state_with_ledger_event(
            repo_root,
            state=st,
            event_type="branch_switched",
            run_id=st.get("run_id"),
            workflow_id=st.get("workflow_id"),
            step_id=str((st.get("current_step") or {}).get("step_id") or plan.get("current_step_id") or ""),
            details={
                "decision_id": decision_id,
                "from_branch_id": prev,
                "to_branch_id": branch_id,
                "previous_status": prev_status if (prev and prev != branch_id) else None,
                "note": str(getattr(args, "note", None) or ""),
            },
        )
    except Exception as e:
        return _die(f"failed to persist branching update: {e}")
    print(f"[ok] switched active branch for {decision_id}: {prev or '(none)'} -> {branch_id}")
    return 0


def _approval_packet_skeleton(
    *,
    category: str,
    approval_id: str,
    run_id: str,
    workflow_id: str | None,
    context_pack_path: str | None,
    run_card_path: str | None,
    run_card_sha256: str | None,
    plan_md_path: str | None,
    plan_ssot_pointer: str | None,
    plan_step_ids: list[str] | None,
    active_branch_id: str | None,
    purpose: str,
    plan: list[str],
    details_md: str | None = None,
    budgets: dict[str, int],
    risks: list[str],
    outputs: list[str],
    rollback: str,
) -> str:
    plan_md = "\n".join([f"- {p}" for p in plan]) if plan else "- (fill)"
    risks_md = "\n".join([f"- {r}" for r in risks]) if risks else "- (fill)"
    outputs_md = "\n".join([f"- {o}" for o in outputs]) if outputs else "- (fill)"
    plan_steps = ", ".join(str(x) for x in (plan_step_ids or []) if str(x).strip()) or "(unknown)"
    lines: list[str] = [
        f"# Approval packet — {approval_id} ({category})",
        "",
        f"- Run: {run_id}",
        f"- Workflow: {workflow_id or '(unknown)'}",
        f"- Context pack: {context_pack_path or '(missing)'}",
        f"- Run-card: {run_card_path or '(missing)'}",
        f"- Run-card SHA256 (canonical JSON): {run_card_sha256 or '(missing)'}",
        f"- Plan view: {plan_md_path or '(missing)'}",
        f"- Plan SSOT: {plan_ssot_pointer or '(missing)'}",
        f"- Plan step(s): {plan_steps}",
        f"- Active branch: {active_branch_id or '(none)'}",
        "",
        "## Purpose",
        "",
        purpose.strip() or "(fill)",
        "",
        "## Plan (what will be done)",
        "",
        plan_md,
        "",
    ]
    if isinstance(details_md, str) and details_md.strip():
        lines.extend(["## Details", "", details_md.strip(), ""])
    lines.extend(
        [
            "## Budgets",
            "",
            f"- max_network_calls: {budgets.get('max_network_calls')}",
            f"- max_runtime_minutes: {budgets.get('max_runtime_minutes')}",
            "",
            "## Risks / failure modes",
            "",
            risks_md,
            "",
            "## Outputs (paths)",
            "",
            outputs_md,
            "",
            "## Rollback",
            "",
            rollback.strip() or "(fill)",
            "",
        ]
    )
    return "\n".join(lines)


def _request_approval(
    *,
    repo_root: Path,
    st: dict,
    category: str,
    run_id: str,
    plan_step_ids: list[str] | None,
    purpose: str | None,
    plan: list[str],
    risks: list[str],
    outputs: list[str],
    rollback: str | None,
    details_md: str | None = None,
    approval_resolution_trace: list[dict[str, str]] | None = None,
    note: str | None,
    force: bool,
) -> tuple[str, str]:
    if st.get("pending_approval") and not force:
        pending = st["pending_approval"]
        raise RuntimeError(f"already awaiting approval: {pending.get('approval_id')}")

    if category not in APPROVAL_CATEGORY_TO_POLICY_KEY:
        raise ValueError(f"unknown category: {category}")

    approval_id = next_approval_id(st, category)
    policy = read_approval_policy(repo_root)
    policy_key = APPROVAL_CATEGORY_TO_POLICY_KEY[category]
    timeout_cfg = (policy.get("timeouts") or {}).get(policy_key) or {"timeout_seconds": 86400, "on_timeout": "block"}
    timeout_seconds = int(timeout_cfg.get("timeout_seconds") or 0)
    on_timeout = str(timeout_cfg.get("on_timeout") or "block")

    requested_at = utc_now_iso().replace("+00:00", "Z")
    if timeout_seconds > 0:
        import datetime as dt

        timeout_at = (
            dt.datetime.fromisoformat(requested_at.replace("Z", "+00:00"))
            + dt.timedelta(seconds=timeout_seconds)
        ).isoformat(timespec="seconds").replace("+00:00", "Z")
    else:
        timeout_at = None

    budgets = policy.get("budgets") or {}
    plan_md_path = st.get("plan_md_path") if isinstance(st.get("plan_md_path"), str) else None
    artifacts = st.get("artifacts") if isinstance(st.get("artifacts"), dict) else {}
    run_card_path = artifacts.get("run_card") if isinstance(artifacts, dict) else None
    run_card_sha256 = artifacts.get("run_card_sha256") if isinstance(artifacts, dict) else None
    active_branch_id = get_active_branch_id(st)
    try:
        state_rel = os.fspath(state_path(repo_root).relative_to(repo_root))
    except Exception:  # CONTRACT-EXEMPT: CODE-01.5 diagnostic fallthrough
        state_rel = os.fspath(state_path(repo_root))
    plan_ssot_pointer = f"{state_rel}#/plan"

    step_ids = [str(x) for x in (plan_step_ids or []) if str(x).strip()]
    if not step_ids:
        cur = st.get("current_step") if isinstance(st.get("current_step"), dict) else {}
        sid = cur.get("step_id")
        if sid:
            step_ids = [str(sid)]

    approval_dir = repo_root / "artifacts" / "runs" / run_id / "approvals" / approval_id
    packet_data = ApprovalPacketData(
        approval_id=approval_id,
        gate_id=category,
        run_id=run_id,
        workflow_id=st.get("workflow_id"),
        purpose=purpose or "(fill)",
        plan=plan,
        risks=risks,
        budgets={
            "max_network_calls": int(budgets.get("max_network_calls") or 0),
            "max_runtime_minutes": int(budgets.get("max_runtime_minutes") or 0),
        },
        outputs=outputs,
        rollback=rollback or "(fill)",
        commands=[],
        checklist=[],
        requested_at=requested_at,
        context_pack_path=(st.get("artifacts") or {}).get("context_md") if isinstance(st.get("artifacts"), dict) else None,
        run_card_path=str(run_card_path) if isinstance(run_card_path, str) else None,
        run_card_sha256=str(run_card_sha256) if isinstance(run_card_sha256, str) else None,
        plan_ssot_pointer=plan_ssot_pointer,
        plan_step_ids=step_ids,
        active_branch_id=active_branch_id,
        gate_resolution_trace=[
            item for item in (approval_resolution_trace or []) if isinstance(item, dict)
        ],
        details_md=details_md,
    )
    write_trio(packet_data, approval_dir)
    packet_path = approval_dir / "packet.md"

    st["run_id"] = run_id
    st["run_status"] = "awaiting_approval"
    st["pending_approval"] = {
        "approval_id": approval_id,
        "category": category,
        "plan_step_ids": step_ids,
        "requested_at": requested_at,
        "timeout_at": timeout_at,
        "on_timeout": on_timeout,
        "packet_path": os.fspath(packet_path.relative_to(repo_root)),
    }
    st["notes"] = note or f"awaiting approval {approval_id}"
    save_state(repo_root, st)
    append_ledger_event(
        repo_root,
        event_type="approval_requested",
        run_id=st.get("run_id"),
        workflow_id=st.get("workflow_id"),
        step_id=(st.get("current_step") or {}).get("step_id") if isinstance(st.get("current_step"), dict) else None,
        details={
            "approval_id": approval_id,
            "category": category,
            "packet_path": os.fspath(packet_path.relative_to(repo_root)),
        },
    )
    return approval_id, os.fspath(packet_path.relative_to(repo_root))


def cmd_request_approval(args: argparse.Namespace) -> int:
    repo_root = _repo_root_from_args(args)
    st = _read_or_init_state(repo_root)

    category = args.category
    run_id = args.run_id or st.get("run_id")
    if not run_id:
        return _die("missing run_id (run: start --run-id ...), or pass --run-id")
    try:
        _ensure_context_pack(
            repo_root=repo_root,
            st=st,
            run_id=str(run_id),
            workflow_id=st.get("workflow_id"),
            note=args.note,
        )
        _ensure_run_card(
            repo_root=repo_root,
            st=st,
            run_id=str(run_id),
            workflow_id=st.get("workflow_id"),
            params={
                "command": "request-approval",
                "run_id": run_id,
                "workflow_id": st.get("workflow_id"),
                "category": category,
            },
            notes="run-card recorded before approval request",
        )
    except Exception as e:
        return _die(f"failed to build context pack: {e}")
    try:
        approval_id, packet_rel = _request_approval(
            repo_root=repo_root,
            st=st,
            category=category,
            run_id=run_id,
            plan_step_ids=None,
            purpose=args.purpose,
            plan=args.plan or [],
            risks=args.risk or [],
            outputs=args.output or [],
            rollback=args.rollback,
            note=args.note,
            force=bool(args.force),
        )
    except Exception as e:
        return _die(str(e))

    print(f"[ok] requested approval: {approval_id}")
    print(f"[ok] packet: {packet_rel}")
    return 0


def cmd_approvals_show(args: argparse.Namespace) -> int:
    """Show approval packets for a run (NEW-03)."""
    repo_root = _repo_root_from_args(args)
    run_id: str = args.run_id
    gate_filter: str | None = getattr(args, "gate", None)
    fmt: str = getattr(args, "format", "short") or "short"

    approvals_dir = repo_root / "artifacts" / "runs" / run_id / "approvals"
    if not approvals_dir.is_dir():
        if fmt == "json":
            print("[]")
        else:
            print(f"[info] no approvals found for run {run_id}")
        return 0

    dirs = sorted(approvals_dir.iterdir())
    if gate_filter:
        dirs = [d for d in dirs if d.name.startswith(gate_filter)]

    if not dirs:
        if fmt == "json":
            print("[]")
        else:
            print(f"[info] no approvals matching gate={gate_filter or '*'} for run {run_id}")
        return 0

    json_packets: list[dict] = []  # collect for --format json

    for approval_dir in dirs:
        if not approval_dir.is_dir():
            continue
        if fmt == "json":
            json_path = approval_dir / "approval_packet_v1.json"
            if json_path.exists():
                try:
                    json_packets.append(json.loads(json_path.read_text(encoding="utf-8")))
                except (json.JSONDecodeError, UnicodeDecodeError):
                    json_packets.append({"error": f"malformed JSON in {approval_dir.name}/approval_packet_v1.json"})
            else:
                packet_path = approval_dir / "packet.md"
                if packet_path.exists():
                    json_packets.append({"error": f"no JSON packet, showing markdown path: {packet_path}"})
                else:
                    json_packets.append({"error": f"no packet found in {approval_dir.name}"})
        elif fmt == "full":
            full_path = approval_dir / "packet.md"
            if full_path.exists():
                print(full_path.read_text(encoding="utf-8"), end="")
            else:
                print(f"[warn] no packet.md in {approval_dir.name}")
        else:
            short_path = approval_dir / "packet_short.md"
            if short_path.exists():
                print(short_path.read_text(encoding="utf-8"), end="")
            else:
                full_path = approval_dir / "packet.md"
                if full_path.exists():
                    print(full_path.read_text(encoding="utf-8"), end="")
                else:
                    print(f"[warn] no packet found in {approval_dir.name}")

    if fmt == "json":
        print(json.dumps(json_packets, indent=2, ensure_ascii=False))

    return 0


def cmd_report_render(args: argparse.Namespace) -> int:
    """Render a self-contained report from run results (NEW-04)."""
    repo_root = _repo_root_from_args(args)
    run_ids = [rid.strip() for rid in args.run_ids.split(",") if rid.strip()]
    if not run_ids:
        return _die("no run-ids provided")

    out_fmt: str = getattr(args, "out", "md") or "md"
    output_path: str | None = getattr(args, "output_path", None)

    results = []
    for rid in run_ids:
        run_dir = repo_root / "artifacts" / "runs" / rid
        if not run_dir.is_dir():
            print(f"[warn] run directory not found: {rid}")
            continue
        results.append(collect_run_result(repo_root, rid))

    if not results:
        return _die("no valid runs found")

    if out_fmt == "tex":
        content = render_tex(results)
    else:
        content = render_md(results)

    if output_path:
        Path(output_path).parent.mkdir(parents=True, exist_ok=True)
        Path(output_path).write_text(content, encoding="utf-8")
        print(f"[ok] report written to {output_path}")
    else:
        print(content)
    return 0


def _require_pending(st: dict, approval_id: str) -> dict | None:
    pending = st.get("pending_approval")
    if not pending:
        return None
    if pending.get("approval_id") != approval_id:
        return None
    return pending


def cmd_approve(args: argparse.Namespace) -> int:
    repo_root = _repo_root_from_args(args)
    st = _read_or_init_state(repo_root)

    # --- C-01: enforce timeout/budget before allowing approval ---
    timeout_action = check_approval_timeout(repo_root, st)
    if timeout_action:
        return _die(f"approval timed out (policy_action={timeout_action})")
    if check_approval_budget(repo_root, st):
        return _die("BUDGET_EXHAUSTED: approval budget has been reached")
    # --- end C-01 ---

    pending = _require_pending(st, args.approval_id)
    if not pending:
        return _die(f"no matching pending approval: {args.approval_id}")

    category = pending.get("category")
    st["pending_approval"] = None
    st["run_status"] = "running"
    st["notes"] = args.note or f"approved {args.approval_id}"
    if category:
        st.setdefault("gate_satisfied", {})[str(category)] = args.approval_id
    st.setdefault("approval_history", []).append(
        {
            "ts": utc_now_iso().replace("+00:00", "Z"),
            "approval_id": args.approval_id,
            "category": category,
            "decision": "approved",
            "note": args.note or "",
        }
    )
    st.setdefault("checkpoints", {})["last_checkpoint_at"] = utc_now_iso().replace("+00:00", "Z")
    save_state(repo_root, st)
    append_ledger_event(
        repo_root,
        event_type="approval_approved",
        run_id=st.get("run_id"),
        workflow_id=st.get("workflow_id"),
        step_id=(st.get("current_step") or {}).get("step_id") if isinstance(st.get("current_step"), dict) else None,
        details={"approval_id": args.approval_id, "category": category, "note": args.note or ""},
    )
    print(f"[ok] approved: {args.approval_id}")
    return 0


def cmd_reject(args: argparse.Namespace) -> int:
    repo_root = _repo_root_from_args(args)
    st = _read_or_init_state(repo_root)
    pending = _require_pending(st, args.approval_id)
    if not pending:
        return _die(f"no matching pending approval: {args.approval_id}")

    category = pending.get("category")
    (repo_root / ".pause").write_text("paused\n", encoding="utf-8")
    st["pending_approval"] = None
    st["run_status"] = "paused"
    st["notes"] = args.note or f"rejected {args.approval_id}"
    st.setdefault("approval_history", []).append(
        {
            "ts": utc_now_iso().replace("+00:00", "Z"),
            "approval_id": args.approval_id,
            "category": category,
            "decision": "rejected",
            "note": args.note or "",
        }
    )
    save_state(repo_root, st)
    append_ledger_event(
        repo_root,
        event_type="approval_rejected",
        run_id=st.get("run_id"),
        workflow_id=st.get("workflow_id"),
        step_id=(st.get("current_step") or {}).get("step_id") if isinstance(st.get("current_step"), dict) else None,
        details={"approval_id": args.approval_id, "category": category, "note": args.note or ""},
    )
    print(f"[ok] rejected: {args.approval_id} (paused)")
    return 0


def _check_stop_pause(repo_root: Path) -> str | None:
    if (repo_root / ".stop").exists():
        return "stop"
    if (repo_root / ".pause").exists():
        return "pause"
    return None


def _workflow_context(*, workflow_id: str, run_id: str) -> tuple[list[str], list[str], list[str], str]:
    ctx = workflow_context(workflow_id=str(workflow_id), run_id=str(run_id), refkey=None)
    return ctx.expected_outputs, ctx.plan, ctx.risks, ctx.rollback


def _now_z() -> str:
    return utc_now_iso().replace("+00:00", "Z")


def _plan_step(
    *,
    step_id: str,
    description: str,
    status: str,
    expected_approvals: list[str],
    expected_outputs: list[str],
    recovery_notes: str,
    started_at: str | None = None,
    completed_at: str | None = None,
) -> dict:
    sid = str(step_id).strip() or "STEP"
    desc = str(description).strip() or "(missing description)"
    st = str(status).strip() or "pending"
    approvals = [str(a).strip() for a in (expected_approvals or []) if str(a).strip()]
    outs = [str(o).strip() for o in (expected_outputs or []) if str(o).strip()]
    return {
        "step_id": sid,
        "description": desc,
        "status": st,
        "expected_approvals": approvals,
        "expected_outputs": outs,
        "recovery_notes": str(recovery_notes),
        "started_at": started_at,
        "completed_at": completed_at,
    }


def _filter_outputs(outputs: list[str], needle: str) -> list[str]:
    n = str(needle)
    out: list[str] = []
    for p in outputs or []:
        s = str(p)
        if f"/{n}/" in s:
            out.append(s)
    return out


def _build_plan_for_run(*, workflow_id: str, run_id: str, args: argparse.Namespace, refkey: str | None) -> dict:
    ctx = workflow_context(workflow_id=str(workflow_id), run_id=str(run_id), refkey=refkey)
    outs_all = list(ctx.expected_outputs or [])
    now = _now_z()

    wid = str(workflow_id)
    rid = str(run_id)

    if wid == "computation":
        return {
            "schema_version": 1,
            "created_at": now,
            "updated_at": now,
            "plan_id": f"{rid}:{wid}",
            "run_id": rid,
            "workflow_id": wid,
            "current_step_id": "computation.S1",
            "steps": [
                _plan_step(
                    step_id="computation.S1",
                    description="Validate run_card v2 + execute phases (DAG) + write SSOT artifacts",
                    status="in_progress",
                    expected_approvals=["A3"],
                    expected_outputs=outs_all,
                    recovery_notes="If awaiting approval, approve A3 then rerun. If failed, inspect computation/report.md and phase logs.",
                    started_at=now,
                    completed_at=None,
                )
            ],
            "notes": "",
        }

    if wid == "reproduce":
        return {
            "schema_version": 1,
            "created_at": now,
            "updated_at": now,
            "plan_id": f"{rid}:{wid}",
            "run_id": rid,
            "workflow_id": wid,
            "current_step_id": "reproduce.main",
            "steps": [
                _plan_step(
                    step_id="reproduce.main",
                    description="Run reproduction (toy) and write artifacts",
                    status="in_progress",
                    expected_approvals=["A3"],
                    expected_outputs=outs_all,
                    recovery_notes="If failed, inspect artifacts + logs; rerun after approval/budget adjustments.",
                    started_at=now,
                    completed_at=None,
                )
            ],
            "notes": "",
        }

    if wid == "revision":
        return {
            "schema_version": 1,
            "created_at": now,
            "updated_at": now,
            "plan_id": f"{rid}:{wid}",
            "run_id": rid,
            "workflow_id": wid,
            "current_step_id": "revision.main",
            "steps": [
                _plan_step(
                    step_id="revision.main",
                    description="Compile gate + deterministic paper revision (v0)",
                    status="in_progress",
                    expected_approvals=["A4"],
                    expected_outputs=outs_all,
                    recovery_notes="If compile fails, use diff + latex logs to isolate and rollback.",
                    started_at=now,
                    completed_at=None,
                )
            ],
            "notes": "",
        }

    if wid == "paper_reviser":
        return {
            "schema_version": 1,
            "created_at": now,
            "updated_at": now,
            "plan_id": f"{rid}:{wid}",
            "run_id": rid,
            "workflow_id": wid,
            "current_step_id": "paper_reviser.round_01",
            "steps": [
                _plan_step(
                    step_id="paper_reviser.round_01",
                    description="Paper reviser round_01 (writer/auditor/deep verification) (no external retrieval)",
                    status="in_progress",
                    expected_approvals=[],
                    expected_outputs=_filter_outputs(outs_all, "paper_reviser/round_01"),
                    recovery_notes="If failed, inspect artifacts/runs/<run_id>/paper_reviser/round_01/run.json and logs.",
                    started_at=now,
                    completed_at=None,
                ),
                _plan_step(
                    step_id="paper_reviser.verification_plan",
                    description="Build verification plan (deterministic; routes retrieval outputs under artifacts/)",
                    status="pending",
                    expected_approvals=[],
                    expected_outputs=_filter_outputs(outs_all, "paper_reviser/verification/verification_plan.json"),
                    recovery_notes="If missing/invalid, rebuild from round_01/verification_requests.json or provide --verification-plan.",
                ),
                _plan_step(
                    step_id="paper_reviser.retrieval",
                    description="A1-gated retrieval tasks (research-team.literature_fetch) with per-task state/logs",
                    status="pending",
                    expected_approvals=["A1"],
                    expected_outputs=_filter_outputs(outs_all, "paper_reviser/verification"),
                    recovery_notes="If awaiting approval, approve A1 then rerun. If a task failed, inspect task_state + logs and rerun.",
                ),
                _plan_step(
                    step_id="paper_reviser.evidence_synthesis",
                    description="Evidence synthesis (fan-in): per-VR JSON SSOT + deterministic VR-*.md under verification/evidence/",
                    status="pending",
                    expected_approvals=[],
                    expected_outputs=_filter_outputs(outs_all, "paper_reviser/verification/evidence"),
                    recovery_notes="If manual evidence is enabled, write evidence/<VR-ID>.md then rerun. Otherwise inspect evidence_state + raw logs.",
                ),
                _plan_step(
                    step_id="paper_reviser.round_02",
                    description="Paper reviser round_02 with evidence context (max_rounds=1)",
                    status="pending",
                    expected_approvals=[],
                    expected_outputs=_filter_outputs(outs_all, "paper_reviser/round_02"),
                    recovery_notes="If failed, inspect round_02/run.json and logs; rerun after fixing evidence or model config.",
                ),
                _plan_step(
                    step_id="paper_reviser.apply",
                    description="(Optional) Apply final clean.tex back to the draft .tex (A4-gated if approval_policy requires)",
                    status="pending",
                    expected_approvals=["A4"],
                    expected_outputs=_filter_outputs(outs_all, "paper_reviser/apply"),
                    recovery_notes="If awaiting approval, approve A4 then rerun with --apply-to-draft. Always review diffs before applying.",
                ),
            ],
            "notes": "",
        }

    if wid == "literature_survey_polish":
        return {
            "schema_version": 1,
            "created_at": now,
            "updated_at": now,
            "plan_id": f"{rid}:{wid}",
            "run_id": rid,
            "workflow_id": wid,
            "current_step_id": "literature_survey.export",
            "steps": [
                _plan_step(
                    step_id="literature_survey.export",
                    description="Export deterministic KB → literature survey (T30)",
                    status="in_progress",
                    expected_approvals=[],
                    expected_outputs=_filter_outputs(outs_all, "literature_survey"),
                    recovery_notes="If export fails, inspect literature_survey/ logs and ensure KB note snapshots exist.",
                    started_at=now,
                    completed_at=None,
                ),
                _plan_step(
                    step_id="literature_survey.polish",
                    description="A4-gated research-writer consume (hygiene + optional compile) (T36)",
                    status="pending",
                    expected_approvals=["A4"],
                    expected_outputs=_filter_outputs(outs_all, "literature_survey_polish"),
                    recovery_notes="If awaiting approval, approve A4 and rerun. If failed, inspect paper/build_trace.jsonl and logs.",
                ),
            ],
            "notes": "",
        }

    if wid in adapter_workflow_ids():
        return {
            "schema_version": 1,
            "created_at": now,
            "updated_at": now,
            "plan_id": f"{rid}:{wid}",
            "run_id": rid,
            "workflow_id": wid,
            "current_step_id": "ADAPTER.S1",
            "steps": [
                _plan_step(
                    step_id="ADAPTER.S1",
                    description=f"Run adapter workflow {wid}",
                    status="in_progress",
                    expected_approvals=[],
                    expected_outputs=outs_all,
                    recovery_notes="If adapter fails, inspect adapter report/logs; keep SSOT artifacts.",
                    started_at=now,
                    completed_at=None,
                )
            ],
            "notes": "",
        }

    # ingest (default)
    return {
        "schema_version": 1,
        "created_at": now,
        "updated_at": now,
        "plan_id": f"{rid}:{wid}",
        "run_id": rid,
        "workflow_id": wid,
        "current_step_id": "ingest.main",
        "steps": [
            _plan_step(
                step_id="ingest.main",
                description="Ingest paper (snapshots + KB note + artifacts)",
                status="in_progress",
                expected_approvals=[],
                expected_outputs=outs_all,
                recovery_notes="If network fails, keep partial snapshots + retry; ensure RefKey consistency.",
                started_at=now,
                completed_at=None,
            )
        ],
        "notes": "",
    }


def _sync_plan_current_step(repo_root: Path, st: dict, *, step_id: str, title: str) -> None:
    plan = st.get("plan")
    if not isinstance(plan, dict):
        return

    now = _now_z()
    plan["updated_at"] = now
    plan["current_step_id"] = str(step_id)

    steps = plan.get("steps")
    if not isinstance(steps, list):
        steps = []
        plan["steps"] = steps

    found = False
    for step in steps:
        if not isinstance(step, dict):
            continue
        if str(step.get("step_id")) == str(step_id):
            found = True
            if step.get("status") != "in_progress":
                step["status"] = "in_progress"
            if not step.get("started_at"):
                step["started_at"] = now
            step["completed_at"] = None
            if not step.get("description"):
                step["description"] = str(title).strip() or "(missing description)"
        elif step.get("status") == "in_progress":
            step["status"] = "completed"
            if not step.get("completed_at"):
                step["completed_at"] = now
    if not found:
        steps.append(
            _plan_step(
                step_id=str(step_id),
                description=str(title),
                status="in_progress",
                expected_approvals=[],
                expected_outputs=[],
                recovery_notes="",
                started_at=now,
                completed_at=None,
            )
        )
    # plan_md_path is derived and written on save_state()


def _sync_plan_terminal(repo_root: Path, st: dict, *, step_id: str, title: str, status: str) -> None:
    plan = st.get("plan")
    if not isinstance(plan, dict):
        return
    now = _now_z()
    plan["updated_at"] = now
    steps = plan.get("steps")
    if not isinstance(steps, list):
        steps = []
        plan["steps"] = steps

    found = False
    for step in steps:
        if not isinstance(step, dict):
            continue
        if str(step.get("step_id")) != str(step_id):
            continue
        found = True
        step["status"] = str(status)
        if status in {"completed", "failed"}:
            if not step.get("completed_at"):
                step["completed_at"] = now
        if not step.get("description"):
            step["description"] = str(title).strip() or "(missing description)"
    if not found:
        steps.append(
            _plan_step(
                step_id=str(step_id),
                description=str(title),
                status=str(status),
                expected_approvals=[],
                expected_outputs=[],
                recovery_notes="",
                started_at=None,
                completed_at=now if status in {"completed", "failed"} else None,
            )
        )
    # plan_md_path is derived and written on save_state()


def _default_gate_for_run(*, workflow_id: str, args: argparse.Namespace, policy: dict) -> str | None:
    req = policy.get("require_approval_for") or {}
    if workflow_id in adapter_workflow_ids():
        # Adapter workflows express their gate requirements in the run-card and handle approvals
        # inside the adapter runner to ensure SSOT artifacts are written even when awaiting approval.
        return None
    if workflow_id == "computation" and bool(req.get("compute_runs")):
        return "A3"
    if workflow_id == "reproduce" and bool(req.get("compute_runs")):
        return "A3"
    if workflow_id == "revision":
        apply_edits = not bool(getattr(args, "no_apply_provenance_table", False))
        if apply_edits and bool(req.get("paper_edits")):
            return "A4"
    return None


def _approval_history_has_approved(st: dict, *, category: str, approval_id: str) -> bool:
    history = st.get("approval_history")
    if not isinstance(history, list):
        return False
    for rec in history:
        if not isinstance(rec, dict):
            continue
        if rec.get("approval_id") != approval_id:
            continue
        if rec.get("category") != category:
            continue
        if rec.get("decision") != "approved":
            continue
        return True
    return False


def _parse_csv_floats(s: str) -> tuple[float, ...]:
    return tuple(float(x.strip()) for x in str(s).split(",") if x.strip())


def _parse_param_overrides(pairs: list[str] | None) -> dict[str, str]:
    """Parse repeatable `--param key=value` CLI args into a dict (values kept as strings).

    Type coercion (string/number/bool/int) is performed by run_card v2 validation.
    """
    out: dict[str, str] = {}
    for raw in (pairs or [])[:500]:
        s = str(raw).strip()
        if not s:
            continue
        if "=" not in s:
            raise ValueError(f"--param must be key=value (got {raw!r})")
        k, v = s.split("=", 1)
        k = k.strip()
        if not k:
            raise ValueError(f"--param key must be non-empty (got {raw!r})")
        out[k] = v
    return out


def _infer_project_dir_from_run_card_path(run_card_path: Path) -> Path | None:
    """Infer project_dir from a standard layout: <project_dir>/run_cards/<card>.json."""
    p = run_card_path.resolve()
    if p.parent.name != "run_cards":
        return None
    candidate = p.parent.parent
    if candidate.exists() and candidate.is_dir() and (candidate / "run_cards").is_dir():
        return candidate
    return None


def _resolve_effective_refkey(*, workflow_id: str, args: argparse.Namespace) -> str | None:
    if getattr(args, "refkey", None):
        return str(args.refkey)
    return None


def _resolve_effective_source_tex(*, workflow_id: str, args: argparse.Namespace) -> str | None:
    if getattr(args, "source_tex", None):
        return str(args.source_tex)
    return None


def _update_step(repo_root: Path, st: dict, *, step_id: str, title: str) -> None:
    now = _now_z()
    st["current_step"] = {"step_id": str(step_id), "title": str(title), "started_at": now}
    _sync_plan_current_step(repo_root, st, step_id=str(step_id), title=str(title))
    st.setdefault("checkpoints", {})["last_checkpoint_at"] = now
    save_state(repo_root, st)
    append_ledger_event(
        repo_root,
        event_type="step_started",
        run_id=st.get("run_id"),
        workflow_id=st.get("workflow_id"),
        step_id=str(step_id),
        details={},
    )


def _prefix_artifacts(prefix: str, artifact_paths: dict[str, str]) -> dict[str, str]:
    out: dict[str, str] = {}
    for k, v in (artifact_paths or {}).items():
        out[f"{prefix}_{k}"] = v
    return out


def _policy_floor_gates_for_backend(*, backend_kind: str, policy_req: dict[str, object]) -> set[str]:
    out: set[str] = set()
    bk = str(backend_kind or "").strip()
    if bk in {"shell", "internal"}:
        if bool(policy_req.get("compute_runs")):
            out.add("A3")
    elif bk == "mcp":
        if bool(policy_req.get("mass_search")):
            out.add("A1")
        if bool(policy_req.get("compute_runs")):
            out.add("A3")
    else:
        if bool(policy_req.get("mass_search")):
            out.add("A1")
        if bool(policy_req.get("compute_runs")):
            out.add("A3")
    return out


def _build_gate_trace_entry(*, gate_id: str, triggered_by: str, reason: str) -> dict[str, str]:
    return {
        "gate_id": str(gate_id),
        "triggered_by": str(triggered_by),
        "reason": str(reason),
        "timestamp_utc": utc_now_iso().replace("+00:00", "Z"),
    }


def _resolve_adapter_gate_resolution(
    *,
    run_card: dict[str, object],
    policy: dict[str, object],
    backend_kind: str,
    cli_gate: str | None,
    strict_mode: bool,
    is_default_run_card: bool,
) -> tuple[set[str], str, list[dict[str, str]], list[dict[str, str]]]:
    raw = run_card.get("required_approvals")
    if isinstance(raw, list):
        run_card_approvals = {str(x).strip() for x in raw if isinstance(x, str) and str(x).strip()}
    elif raw is None:
        run_card_approvals = set()
    else:
        raise ValueError("run-card.required_approvals must be a list of strings (or omitted)")

    mode_raw = run_card.get("approval_resolution_mode")
    mode = str(mode_raw or "union").strip().lower()
    allowed_modes = {"union", "policy_only", "run_card_only"}
    if mode not in allowed_modes:
        raise ValueError(
            f"run-card.approval_resolution_mode must be one of {sorted(allowed_modes)} when provided"
        )

    policy_req = policy.get("require_approval_for")
    policy_req_obj = policy_req if isinstance(policy_req, dict) else {}
    policy_approvals = _policy_floor_gates_for_backend(backend_kind=str(backend_kind), policy_req=policy_req_obj)

    cli_approvals: set[str] = set()
    if isinstance(cli_gate, str) and cli_gate.strip():
        cli_approvals.add(cli_gate.strip())

    if mode == "union":
        resolved_approvals = set(run_card_approvals) | set(policy_approvals) | set(cli_approvals)
    elif mode == "policy_only":
        resolved_approvals = set(policy_approvals) | set(cli_approvals)
    else:
        resolved_approvals = set(run_card_approvals) | set(cli_approvals)

    trace: list[dict[str, str]] = []
    for approval in sorted(resolved_approvals):
        if approval in cli_approvals:
            trace.append(
                _build_gate_trace_entry(
                    gate_id=approval,
                    triggered_by="cli_override",
                    reason="approval requested by CLI --gate override",
                )
            )
            continue
        if approval in policy_approvals and approval in run_card_approvals:
            trace.append(
                _build_gate_trace_entry(
                    gate_id=approval,
                    triggered_by="both",
                    reason="approval required by both run-card and approval policy floor",
                )
            )
            continue
        if approval in policy_approvals:
            trace.append(
                _build_gate_trace_entry(
                    gate_id=approval,
                    triggered_by="policy",
                    reason="approval injected by approval policy floor",
                )
            )
            continue
        if approval in run_card_approvals and is_default_run_card:
            trace.append(
                _build_gate_trace_entry(
                    gate_id=approval,
                    triggered_by="workflow_default",
                    reason="approval comes from workflow default run-card",
                )
            )
            continue
        trace.append(
            _build_gate_trace_entry(
                gate_id=approval,
                triggered_by="run_card",
                reason="approval requested by run-card.required_approvals",
            )
        )

    warnings: list[dict[str, str]] = []
    if mode == "run_card_only" and not run_card_approvals and not cli_approvals:
        msg = (
            "run_card_only with empty required_approvals suppresses policy floor approvals; "
            "no approvals will be requested unless CLI overrides are provided"
        )
        warnings.append(
            _status_warning(
                code="approval_resolution_policy_suppressed",
                message=msg,
            )
        )
        trace.append(
            _build_gate_trace_entry(
                gate_id="(none)",
                triggered_by="cli_override",
                reason="all policy approvals suppressed by run_card_only + empty approval list",
            )
        )
        if strict_mode:
            raise GateResolutionError(msg)

    return resolved_approvals, mode, trace, warnings


def _inject_approval_resolution_trace_into_manifest(
    *,
    repo_root: Path,
    artifact_paths: dict[str, str],
    approval_resolution_mode: str,
    approval_resolution_trace: list[dict[str, str]],
) -> None:
    manifest_rel = artifact_paths.get("manifest") if isinstance(artifact_paths, dict) else None
    if not isinstance(manifest_rel, str) or not manifest_rel.strip():
        return

    manifest_path = (repo_root / manifest_rel).resolve()
    if not manifest_path.exists():
        return
    try:
        manifest = read_json(manifest_path)
    except Exception as e:
        print(f"[warn][approval-resolution] failed to read manifest for trace injection: {e} ({manifest_path})", file=sys.stderr)
        return
    if not isinstance(manifest, dict):
        print(
            f"[warn][approval-resolution] manifest is not a JSON object; cannot inject approval trace ({manifest_path})",
            file=sys.stderr,
        )
        return

    manifest["approval_resolution_mode"] = str(approval_resolution_mode)
    manifest["approval_resolution_trace"] = [x for x in approval_resolution_trace if isinstance(x, dict)]
    try:
        write_json(manifest_path, manifest)
    except Exception as e:
        print(f"[warn][approval-resolution] failed to write manifest trace fields: {e} ({manifest_path})", file=sys.stderr)
        return

    summary_rel = artifact_paths.get("summary") if isinstance(artifact_paths, dict) else None
    analysis_rel = artifact_paths.get("analysis") if isinstance(artifact_paths, dict) else None
    if not (isinstance(summary_rel, str) and summary_rel.strip() and isinstance(analysis_rel, str) and analysis_rel.strip()):
        return
    summary_path = (repo_root / summary_rel).resolve()
    analysis_path = (repo_root / analysis_rel).resolve()
    if not (summary_path.exists() and analysis_path.exists()):
        return
    try:
        summary = read_json(summary_path)
        analysis = read_json(analysis_path)
    except Exception as e:
        print(
            f"[warn][approval-resolution] failed to reload summary/analysis for report regeneration: {e} "
            f"({summary_path}, {analysis_path})",
            file=sys.stderr,
        )
        return
    if not (isinstance(summary, dict) and isinstance(analysis, dict)):
        return
    artifact_dir = manifest_path.parent
    try:
        write_artifact_report(repo_root=repo_root, artifact_dir=artifact_dir, manifest=manifest, summary=summary, analysis=analysis)
    except Exception as e:
        print(
            f"[warn][approval-resolution] failed to regenerate report after trace injection: {e} ({artifact_dir})",
            file=sys.stderr,
        )


def cmd_run(args: argparse.Namespace) -> int:
    repo_root = _repo_root_from_args(args)
    st = _read_or_init_state(repo_root)

    supported = _all_run_workflow_ids()
    if args.workflow_id not in supported:
        return _die(f"v0.4 supports --workflow-id {('|'.join(sorted(supported)))}")

    # attach/start run if needed
    started_new_run = False
    effective_refkey = _resolve_effective_refkey(workflow_id=str(args.workflow_id), args=args)
    effective_source_tex = _resolve_effective_source_tex(workflow_id=str(args.workflow_id), args=args)
    if (st.get("run_id") != args.run_id) or (st.get("workflow_id") != args.workflow_id):
        started_new_run = True
        if st.get("run_status") in {"running", "awaiting_approval", "paused"} and not args.force:
            return _die(
                f"state has active run_id={st.get('run_id')} workflow_id={st.get('workflow_id')} "
                f"(status={st.get('run_status')}); use --force to override"
            )
        st["run_id"] = args.run_id
        st["workflow_id"] = args.workflow_id
        st["run_status"] = "running"
        st["pending_approval"] = None
        st["gate_satisfied"] = {}
        st["approval_history"] = []
        st["artifacts"] = {}
        st["plan"] = _build_plan_for_run(
            workflow_id=str(args.workflow_id),
            run_id=str(args.run_id),
            args=args,
            refkey=effective_refkey,
        )
        try:
            st["plan_md_path"] = os.fspath(plan_md_path(repo_root).relative_to(repo_root))
        except Exception:  # CONTRACT-EXEMPT: CODE-01.5 diagnostic fallthrough
            st["plan_md_path"] = os.fspath(plan_md_path(repo_root))

        now = _now_z()
        plan = st.get("plan") if isinstance(st.get("plan"), dict) else {}
        step_id = str(plan.get("current_step_id") or "START")
        title = "Run workflow"
        steps = plan.get("steps") if isinstance(plan, dict) else None
        if isinstance(steps, list):
            for step in steps:
                if isinstance(step, dict) and str(step.get("step_id")) == step_id:
                    title = str(step.get("description") or title)
                    break
        st["current_step"] = {"step_id": step_id, "title": title, "started_at": now}
        _sync_plan_current_step(repo_root, st, step_id=step_id, title=title)
        st.setdefault("checkpoints", {})["last_checkpoint_at"] = now
        save_state(repo_root, st)
        append_ledger_event(
            repo_root,
            event_type="run_started",
            run_id=st.get("run_id"),
            workflow_id=st.get("workflow_id"),
            step_id=step_id,
            details={"note": args.note or ""},
        )
        try:
            _ensure_context_pack(
                repo_root=repo_root,
                st=st,
                run_id=st.get("run_id") or args.run_id,
                workflow_id=st.get("workflow_id") or args.workflow_id,
                note=args.note,
                refkey=effective_refkey,
            )
        except Exception as e:
            return _die(f"failed to build context pack: {e}")
        try:
            _ensure_kb_profile(
                repo_root=repo_root,
                st=st,
                run_id=str(st.get("run_id") or args.run_id),
                kb_profile=str(args.kb_profile),
                kb_profile_user_path=str(args.kb_profile_user_path) if getattr(args, "kb_profile_user_path", None) else None,
            )
        except Exception as e:
            return _die(f"failed to build kb_profile: {e}")

    if not started_new_run:
        # Ensure context pack exists even when re-entering an existing run_id/workflow_id.
        artifacts = st.get("artifacts")
        context_md = artifacts.get("context_md") if isinstance(artifacts, dict) else None
        if not isinstance(context_md, str):
            try:
                _ensure_context_pack(
                    repo_root=repo_root,
                    st=st,
                    run_id=st.get("run_id") or args.run_id,
                    workflow_id=st.get("workflow_id") or args.workflow_id,
                    note=args.note,
                    refkey=effective_refkey,
                )
            except Exception as e:
                return _die(f"failed to build context pack: {e}")
        kb_profile_json = artifacts.get("kb_profile_json") if isinstance(artifacts, dict) else None
        if not isinstance(kb_profile_json, str):
            try:
                _ensure_kb_profile(
                    repo_root=repo_root,
                    st=st,
                    run_id=str(st.get("run_id") or args.run_id),
                    kb_profile=str(args.kb_profile),
                    kb_profile_user_path=str(args.kb_profile_user_path)
                    if getattr(args, "kb_profile_user_path", None)
                    else None,
                )
            except Exception as e:
                return _die(f"failed to build kb_profile: {e}")

    try:
        _ensure_run_card(
            repo_root=repo_root,
            st=st,
            run_id=str(st.get("run_id") or args.run_id),
            workflow_id=st.get("workflow_id") or args.workflow_id,
            params={
                "command": "run",
                "run_id": args.run_id,
                "workflow_id": args.workflow_id,
                "note": args.note or "",
                "kb_profile": str(args.kb_profile),
                "kb_profile_user_path": str(args.kb_profile_user_path) if getattr(args, "kb_profile_user_path", None) else None,
                "cli_args": {k: v for k, v in vars(args).items() if v is not None and not callable(v)},
                "effective_refkey": effective_refkey,
                "effective_source_tex": effective_source_tex,
            },
            notes="run-card ensured before gates",
            overwrite=bool(started_new_run),
        )
    except Exception as e:
        return _die(f"failed to ensure run-card: {e}")

    stop_pause = _check_stop_pause(repo_root)
    if stop_pause == "stop":
        st["run_status"] = "failed"
        st["notes"] = "stopped by user (.stop)"
        save_state(repo_root, st)
        append_ledger_event(repo_root, event_type="stopped", run_id=st.get("run_id"), workflow_id=st.get("workflow_id"))
        return 5
    if stop_pause == "pause" or st.get("run_status") == "paused":
        st["run_status"] = "paused"
        save_state(repo_root, st)
        return 4

    # --- C-01: enforce timeout/budget before continuing a run ---
    pending = st.get("pending_approval")
    if pending:
        timeout_action = check_approval_timeout(repo_root, st)
        if timeout_action:
            print(f"[warn] approval timed out (policy_action={timeout_action})", file=sys.stderr)
            return 2 if timeout_action == "reject" else 3
        if check_approval_budget(repo_root, st):
            return _die("BUDGET_EXHAUSTED: approval budget has been reached")
        print(f"[info] awaiting approval: {pending.get('approval_id')}")
        return 3
    # --- end C-01 ---

    if st.get("run_status") == "completed" and not args.force:
        print("[ok] already completed")
        return 0

    if st.get("run_status") == "failed" and not args.force:
        return _die("run is failed; use --force to rerun or start a new --run-id")

    policy = read_approval_policy(repo_root)
    gates: list[str] = []
    if args.workflow_id not in adapter_workflow_ids():
        auto_gate = _default_gate_for_run(workflow_id=str(args.workflow_id), args=args, policy=policy)
        if auto_gate:
            gates.append(auto_gate)
        if args.gate and args.gate not in gates:
            gates.append(args.gate)

    for gate in gates:
        gate_satisfied = (st.get("gate_satisfied") or {}).get(gate)
        if gate_satisfied:
            # Prevent accidental/agentic bypass by state tampering: a satisfied gate must correspond
            # to an approval record in approval_history.
            if not _approval_history_has_approved(st, category=str(gate), approval_id=str(gate_satisfied)):
                st.setdefault("gate_satisfied", {}).pop(str(gate), None)
                save_state(repo_root, st)
                append_ledger_event(
                    repo_root,
                    event_type="gate_satisfied_invalidated",
                    run_id=st.get("run_id"),
                    workflow_id=st.get("workflow_id"),
                    step_id=(st.get("current_step") or {}).get("step_id") if isinstance(st.get("current_step"), dict) else None,
                    details={"category": str(gate), "approval_id": str(gate_satisfied), "reason": "missing approval_history record"},
                )
                gate_satisfied = None
            else:
                continue
        outputs, plan, risks, rollback = _workflow_context(workflow_id=str(args.workflow_id), run_id=str(args.run_id))
        try:
            approval_id, packet_rel = _request_approval(
                repo_root=repo_root,
                st=st,
                category=gate,
                run_id=args.run_id,
                plan_step_ids=None,
                purpose=f"Gate {gate} before running {args.workflow_id}",
                plan=plan,
                risks=risks,
                outputs=outputs,
                rollback=rollback,
                note="auto gate requested by policy/CLI",
                force=False,
            )
        except Exception as e:
            return _die(str(e))
        print(f"[info] requested approval: {approval_id}")
        print(f"[info] packet: {packet_rel}")
        return 3

    now = _now_z()
    step_id: str | None = None
    title: str | None = None
    plan = st.get("plan")
    if isinstance(plan, dict):
        cur = plan.get("current_step_id")
        if cur:
            step_id = str(cur)
        steps = plan.get("steps")
        if step_id and isinstance(steps, list):
            for step in steps:
                if not isinstance(step, dict):
                    continue
                if str(step.get("step_id")) != step_id:
                    continue
                title = str(step.get("description") or "").strip() or None
                break
    step_id = step_id or "START"
    title = title or "Run workflow"
    st["current_step"] = {"step_id": step_id, "title": title, "started_at": now}
    _sync_plan_current_step(repo_root, st, step_id=step_id, title=title)
    st.setdefault("checkpoints", {})["last_checkpoint_at"] = now
    save_state(repo_root, st)
    append_ledger_event(
        repo_root,
        event_type="step_started",
        run_id=st.get("run_id"),
        workflow_id=st.get("workflow_id"),
        step_id=step_id,
        details={},
    )

    try:
        if args.workflow_id == "computation":
            run_card_arg = getattr(args, "run_card", None)
            if not run_card_arg:
                return _die("computation requires --run-card <path>")

            run_card_path = Path(str(run_card_arg)).expanduser()
            if not run_card_path.is_absolute():
                run_card_path = repo_root / run_card_path
            run_card_path = run_card_path.resolve()

            project_dir_arg = getattr(args, "project_dir", None)
            if project_dir_arg:
                project_dir = Path(str(project_dir_arg)).expanduser()
                if not project_dir.is_absolute():
                    project_dir = repo_root / project_dir
                project_dir = project_dir.resolve()
            else:
                project_dir = _infer_project_dir_from_run_card_path(run_card_path)  # type: ignore[assignment]

            if not project_dir or not project_dir.exists() or not project_dir.is_dir():
                return _die(
                    "computation could not infer project_dir from run-card path; expected layout: "
                    "<project_dir>/run_cards/<card>.json (or pass --project-dir <dir>)"
                )

            params = _parse_param_overrides(getattr(args, "param", None))
            res = computation_one(
                ComputationInputs(
                    tag=str(args.run_id),
                    project_dir=os.fspath(project_dir),
                    run_card=os.fspath(run_card_path),
                    trust_project=bool(getattr(args, "trust_project", False)),
                    resume=bool(getattr(args, "resume", False)),
                    params=params,
                    gate_satisfied=(st.get("gate_satisfied") if isinstance(st.get("gate_satisfied"), dict) else None),
                    command_argv=list(sys.argv),
                ),
                repo_root=repo_root,
            )

            # Determine status from the SSOT analysis.json (computation errors list may be empty when blocked/skipped).
            analysis_rel = (res.get("artifact_paths") or {}).get("analysis")
            if isinstance(analysis_rel, str) and analysis_rel.strip():
                analysis = read_json(repo_root / analysis_rel)
                results = analysis.get("results") if isinstance(analysis, dict) else None
                status = results.get("status") if isinstance(results, dict) else None

                if status == "blocked_by_gate":
                    blocked = results.get("blocked") if isinstance(results, dict) else None
                    missing_gates = blocked.get("missing_gates") if isinstance(blocked, dict) else None
                    if isinstance(missing_gates, list) and missing_gates:
                        # Persist artifacts pointers before requesting the approval.
                        st.setdefault("artifacts", {}).update(res.get("artifact_paths") or {})
                        for k in ["manifest", "summary", "analysis", "report"]:
                            v = (res.get("artifact_paths") or {}).get(k)
                            if v:
                                st.setdefault("artifacts", {})[f"latest_{k}"] = v
                        save_state(repo_root, st)

                        gate = str(missing_gates[0]).strip()
                        outputs, plan, risks, rollback = _workflow_context(workflow_id=str(args.workflow_id), run_id=str(args.run_id))
                        approval_id, packet_rel = _request_approval(
                            repo_root=repo_root,
                            st=st,
                            category=gate,
                            run_id=str(args.run_id),
                            plan_step_ids=[str(step_id)] if step_id else None,
                            purpose=f"Gate {gate} before running computation phase {blocked.get('phase_id') if isinstance(blocked, dict) else '(unknown)'}",
                            plan=plan,
                            risks=risks,
                            outputs=outputs,
                            rollback=rollback,
                            note="computation phase gate requested by run-card",
                            force=False,
                        )
                        print(f"[info] requested approval: {approval_id}")
                        print(f"[info] packet: {packet_rel}")
                        return 3

                if status and status != "completed":
                    # Ensure Orchestrator fails closed on non-completed runs (even if computation errors list is empty).
                    res.setdefault("errors", []).append(f"computation not completed (status={status})")

        elif args.workflow_id == "reproduce":
            ns = tuple(int(x.strip()) for x in str(args.ns).split(",") if x.strip())
            res = reproduce_one(
                ReproduceInputs(
                    tag=args.run_id,
                    case=str(args.case),
                    ns=ns,
                    epsabs=float(args.epsabs),
                    epsrel=float(args.epsrel),
                    mpmath_dps=int(args.mpmath_dps),
                ),
                repo_root=repo_root,
            )
        elif args.workflow_id == "revision":
            apply_edits = not bool(getattr(args, "no_apply_provenance_table", False))
            require_paper_approval = bool((policy.get("require_approval_for") or {}).get("paper_edits"))
            can_edit = (not require_paper_approval) or bool((st.get("gate_satisfied") or {}).get("A4"))
            res = revise_one(
                RevisionInputs(
                    tag=args.run_id,
                    paper_root=str(getattr(args, "paper_root", "paper")),
                    tex_main=str(getattr(args, "tex_main", "main.tex")),
                    apply_provenance_table=apply_edits,
                    compile_before=not bool(getattr(args, "no_compile_before", False)),
                    compile_after=not bool(getattr(args, "no_compile_after", False)),
                    latexmk_timeout_seconds=int(getattr(args, "latexmk_timeout_seconds", 300)),
                ),
                repo_root=repo_root,
                i_approve_paper_edits=bool(can_edit) if apply_edits else False,
            )
        elif args.workflow_id == "paper_reviser":
            # paper_reviser: evidence-first A-E workflow around ~/.codex/skills/paper-reviser.
            # Hard gate: Step C (retrieval tasks) is always A1-gated if tasks exist.
            # Optional: apply-to-draft is A4-gated (approval_policy dependent).

            # Enforce "no hardcoded defaults": require explicit writer/auditor backend+model.
            writer_backend = str(getattr(args, "writer_backend", "") or "").strip()
            writer_model = str(getattr(args, "writer_model", "") or "").strip()
            auditor_backend = str(getattr(args, "auditor_backend", "") or "").strip()
            auditor_model = str(getattr(args, "auditor_model", "") or "").strip()
            if not (writer_backend and writer_model and auditor_backend and auditor_model):
                return _die(
                    "paper_reviser requires --writer-backend/--writer-model/--auditor-backend/--auditor-model (all non-empty; no defaults)"
                )

            manual_evidence = bool(getattr(args, "manual_evidence", False))
            evidence_backend = str(getattr(args, "evidence_synth_backend", "") or "").strip()
            evidence_model = str(getattr(args, "evidence_synth_model", "") or "").strip()
            if not manual_evidence:
                if not (evidence_backend and evidence_model):
                    return _die(
                        "paper_reviser requires --evidence-synth-backend/--evidence-synth-model unless --manual-evidence is set (no defaults)"
                    )

            # Gate-satisfied sanity: refuse stale approvals that are not in approval_history.
            for cat in ["A1", "A4"]:
                gate_val = (st.get("gate_satisfied") or {}).get(cat)
                if gate_val and not _approval_history_has_approved(st, category=cat, approval_id=str(gate_val)):
                    st.setdefault("gate_satisfied", {}).pop(cat, None)
                    save_state(repo_root, st)
                    try:
                        append_ledger_event(
                            repo_root,
                            event_type="gate_satisfied_invalidated",
                            run_id=st.get("run_id"),
                            workflow_id=st.get("workflow_id"),
                            step_id=step_id,
                            details={
                                "category": cat,
                                "approval_id": str(gate_val),
                                "reason": "missing approval_history record",
                            },
                        )
                    except Exception:
                        # Fail open for ledger writes; state remains authoritative for gating.
                        print(
                            f"[warn] ledger write failed for gate_satisfied_invalidated ({cat}={gate_val})",
                            file=sys.stderr,
                        )

            apply_to_draft = bool(getattr(args, "apply_to_draft", False))
            require_paper_approval = bool((policy.get("require_approval_for") or {}).get("paper_edits"))
            can_apply = (not require_paper_approval) or bool((st.get("gate_satisfied") or {}).get("A4"))
            codex_cfg_raw = getattr(args, "paper_reviser_codex_config", []) or []
            codex_cfg: list[str] = []
            if isinstance(codex_cfg_raw, list):
                for x in codex_cfg_raw:
                    s = str(x).strip()
                    if s:
                        codex_cfg.append(s)

            try:
                res = paper_reviser_one(
                    PaperReviserInputs(
                        tag=str(args.run_id),
                        draft_tex_path=str(getattr(args, "draft_tex", "") or "").strip() or None,
                        paper_root=str(getattr(args, "paper_root", "paper")),
                        tex_main=str(getattr(args, "tex_main", "main.tex")),
                        writer_backend=writer_backend,
                        writer_model=writer_model,
                        auditor_backend=auditor_backend,
                        auditor_model=auditor_model,
                        paper_reviser_mode=str(getattr(args, "paper_reviser_mode", "run-models") or "run-models"),
                        max_rounds_rev1=int(getattr(args, "paper_reviser_max_rounds_rev1", 1) or 1),
                        no_codex_verify=bool(getattr(args, "paper_reviser_no_codex_verify", False)),
                        min_clean_size_ratio=(
                            float(getattr(args, "paper_reviser_min_clean_size_ratio"))
                            if getattr(args, "paper_reviser_min_clean_size_ratio", None) is not None
                            else None
                        ),
                        codex_model=str(getattr(args, "paper_reviser_codex_model", "") or "").strip() or None,
                        codex_config=codex_cfg,
                        fallback_auditor=str(getattr(args, "paper_reviser_fallback_auditor", "") or "").strip() or None,
                        fallback_auditor_model=(
                            str(getattr(args, "paper_reviser_fallback_auditor_model", "") or "").strip() or None
                        ),
                        secondary_deep_verify_backend=(
                            str(getattr(args, "paper_reviser_secondary_deep_verify_backend", "") or "").strip() or None
                        ),
                        secondary_deep_verify_model=(
                            str(getattr(args, "paper_reviser_secondary_deep_verify_model", "") or "").strip() or None
                        ),
                        manual_evidence=manual_evidence,
                        evidence_synth_backend=evidence_backend or None,
                        evidence_synth_model=evidence_model or None,
                        verification_plan_path=str(getattr(args, "verification_plan", "") or "").strip() or None,
                        apply_to_draft=apply_to_draft,
                        skills_dir=str(getattr(args, "skills_dir", "") or "").strip() or None,
                    ),
                    repo_root=repo_root,
                    gate_satisfied=(st.get("gate_satisfied") if isinstance(st.get("gate_satisfied"), dict) else None),
                    approval_history=(st.get("approval_history") if isinstance(st.get("approval_history"), list) else None),
                    i_approve_paper_edits=bool(can_apply) if apply_to_draft else False,
                    force=bool(getattr(args, "force", False)),
                    command_argv=list(sys.argv),
                )
            except (ValueError, FileNotFoundError) as exc:
                return _die(f"paper_reviser input error: {exc}")
            except Exception as exc:
                return _die(f"paper_reviser crashed: {exc}")

            analysis_rel = (res.get("artifact_paths") or {}).get("analysis")
            status = None
            blocked = None
            results = None
            if isinstance(analysis_rel, str) and analysis_rel.strip():
                analysis = read_json(repo_root / analysis_rel)
                results = analysis.get("results") if isinstance(analysis, dict) else None
                if isinstance(results, dict):
                    status = results.get("status")
                    blocked = results.get("blocked") if isinstance(results.get("blocked"), dict) else None

            if status == "blocked_by_gate":
                missing_gates = blocked.get("missing_gates") if isinstance(blocked, dict) else None
                if isinstance(missing_gates, list) and missing_gates:
                    # Persist artifact pointers before requesting approval.
                    st.setdefault("artifacts", {}).update(res.get("artifact_paths") or {})
                    for k in ["manifest", "summary", "analysis", "report"]:
                        v = (res.get("artifact_paths") or {}).get(k)
                        if v:
                            st.setdefault("artifacts", {})[f"latest_{k}"] = v
                    save_state(repo_root, st)

                    gate = str(missing_gates[0]).strip()
                    outputs, plan, risks, rollback = _workflow_context(
                        workflow_id=str(args.workflow_id),
                        run_id=str(args.run_id),
                    )
                    purpose = (
                        f"Gate {gate} before running paper_reviser step {blocked.get('phase_id') if isinstance(blocked, dict) else '(unknown)'}"
                    )
                    if gate == "A1":
                        purpose = "Run external retrieval tasks (research-team.literature_fetch) for paper-reviser verification"
                    if gate == "A4":
                        purpose = "Apply paper-reviser edits back to the draft .tex (write to repo)"
                    details_md = None
                    if gate == "A1" and isinstance(blocked, dict):
                        tasks = blocked.get("tasks")
                        if isinstance(tasks, list) and tasks:
                            import shlex

                            lines: list[str] = ["### Planned tasks (argv_resolved)", ""]
                            for t in tasks[:200]:
                                if not isinstance(t, dict):
                                    continue
                                tid = str(t.get("task_id") or "").strip() or "LF-UNKNOWN"
                                tool = str(t.get("tool") or "").strip()
                                vr_ids = t.get("vr_ids")
                                vr_s = ""
                                if isinstance(vr_ids, list):
                                    vr_s = ", ".join(str(x).strip() for x in vr_ids if str(x).strip())
                                argv = t.get("argv_resolved")
                                argv_list = [str(x) for x in argv] if isinstance(argv, list) else []

                                lines.append(f"#### {tid}")
                                if tool:
                                    lines.append(f"- tool: {tool}")
                                if vr_s:
                                    lines.append(f"- vr_ids: {vr_s}")
                                lines.append("")
                                argv_safe = True
                                for x in argv_list:
                                    if ("\x00" in x) or ("\n" in x) or ("\r" in x):
                                        argv_safe = False
                                        break
                                if argv_list and argv_safe:
                                    lines.append("```bash")
                                    lines.append(" ".join(shlex.quote(x) for x in argv_list))
                                    lines.append("```")
                                elif argv_list:
                                    lines.append("(argv_resolved contains unsafe control characters; omitted)")
                                else:
                                    lines.append("(missing argv_resolved)")
                                lines.append("")
                            details_md = "\n".join(lines).strip()
                    approval_id, packet_rel = _request_approval(
                        repo_root=repo_root,
                        st=st,
                        category=gate,
                        run_id=str(args.run_id),
                        plan_step_ids=[str(step_id)] if step_id else None,
                        purpose=purpose,
                        plan=plan,
                        risks=risks,
                        outputs=outputs,
                        rollback=rollback,
                        details_md=details_md,
                        note=f"paper_reviser gate requested: {gate}",
                        force=False,
                    )
                    print(f"[info] requested approval: {approval_id}")
                    print(f"[info] packet: {packet_rel}")
                    return 3

            elif status == "needs_manual_evidence":
                # Pause the run to make "next action required" explicit.
                st.setdefault("artifacts", {}).update(res.get("artifact_paths") or {})
                st["run_status"] = "paused"
                st["notes"] = (
                    "paper_reviser awaiting manual evidence notes "
                    "(see artifacts/runs/<run_id>/paper_reviser/verification/evidence/)"
                )
                save_state(repo_root, st)
                append_ledger_event(
                    repo_root,
                    event_type="paused",
                    run_id=st.get("run_id"),
                    workflow_id=st.get("workflow_id"),
                    step_id=step_id,
                    details={"reason": "needs_manual_evidence"},
                )
                (repo_root / ".pause").write_text("paused\n", encoding="utf-8")
                print("[info] manual evidence required; write evidence notes then rerun")
                return 4

            elif status is None:
                res.setdefault("errors", []).append("paper_reviser missing/invalid analysis.json results.status")

            elif status != "completed":
                res.setdefault("errors", []).append(f"paper_reviser not completed (status={status})")

            else:
                # Happy path: record "latest_*" pointers. Common post-processing persists state,
                # so we avoid calling save_state() here to prevent inconsistent windows.
                ok_flag = (results or {}).get("ok") if isinstance(results, dict) else None
                if ok_flag is not True:
                    res.setdefault("errors", []).append("paper_reviser completed but analysis.results.ok != true")
                st.setdefault("artifacts", {}).update(res.get("artifact_paths") or {})
                for k in ["manifest", "summary", "analysis", "report"]:
                    v = (res.get("artifact_paths") or {}).get(k)
                    if v:
                        st.setdefault("artifacts", {})[f"latest_{k}"] = v
        elif args.workflow_id == "literature_survey_polish":
            from .toolkit.literature_survey_export import LiteratureSurveyExportInputs, literature_survey_export_one
            from .toolkit.literature_survey_polish import (
                LiteratureSurveyPolishInputs,
                find_research_writer_consume_script,
                literature_survey_polish_one,
            )

            # Step 1: deterministic survey export (T30)
            _update_step(repo_root, st, step_id="literature_survey.export", title="Deterministic literature survey export (T30)")
            survey_dir = repo_root / "artifacts" / "runs" / str(args.run_id) / "literature_survey"
            survey_log_dir = survey_dir / "logs"
            survey_log_dir.mkdir(parents=True, exist_ok=True)

            survey_json = survey_dir / "survey.json"
            res = {"errors": [], "artifact_paths": {}}
            if not survey_json.exists():
                topic: str | None = None
                if getattr(args, "survey_topic", None):
                    topic = str(args.survey_topic).strip()
                    if topic.startswith("-") or ("\n" in topic) or ("\r" in topic) or ("\x00" in topic):
                        return _die(f"invalid --survey-topic value: {topic!r}")

                refkeys_list: list[str] | None = None
                if getattr(args, "survey_refkeys", None):
                    refkeys_raw = str(args.survey_refkeys).strip()
                    if refkeys_raw.startswith("-") or ("\n" in refkeys_raw) or ("\r" in refkeys_raw) or ("\x00" in refkeys_raw):
                        return _die(f"invalid --survey-refkeys value: {refkeys_raw!r}")
                    refkeys_list = [x.strip() for x in refkeys_raw.split(",") if x.strip()]

                export = literature_survey_export_one(
                    LiteratureSurveyExportInputs(
                        tag=str(args.run_id),
                        topic=topic,
                        refkeys=refkeys_list,
                    ),
                    repo_root=repo_root,
                )
                log_lines = [
                    "literature_survey export via library call (no scripts/ dependency)",
                    f"ok={export.get('ok')}",
                    "",
                    "artifact_paths:",
                ]
                for k, v in sorted((export.get('artifact_paths') or {}).items()):
                    log_lines.append(f"- {k}: {v}")
                errors = export.get("errors") or []
                if errors:
                    log_lines.extend(["", "errors:"])
                    for e in errors:
                        log_lines.append(f"- {e}")
                (survey_log_dir / "orchestrator_export.txt").write_text("\n".join(log_lines).rstrip() + "\n", encoding="utf-8")
                if errors or (not bool(export.get("ok"))):
                    raise RuntimeError(
                        "literature_survey export failed; "
                        f"see {os.fspath((survey_log_dir / 'orchestrator_export.txt').relative_to(repo_root))}"
                    )

            # Step 2: A4-gated research-writer consume (T36)
            _update_step(repo_root, st, step_id="literature_survey.polish", title="Literature survey polish (research-writer)")

            require_paper_approval = bool((policy.get("require_approval_for") or {}).get("paper_edits"))
            gate_satisfied = (st.get("gate_satisfied") or {}).get("A4")
            if gate_satisfied and not _approval_history_has_approved(st, category="A4", approval_id=str(gate_satisfied)):
                st.setdefault("gate_satisfied", {}).pop("A4", None)
                save_state(repo_root, st)
                append_ledger_event(
                    repo_root,
                    event_type="gate_satisfied_invalidated",
                    run_id=st.get("run_id"),
                    workflow_id=st.get("workflow_id"),
                    step_id="literature_survey.polish",
                    details={"category": "A4", "approval_id": str(gate_satisfied), "reason": "missing approval_history record"},
                )
                gate_satisfied = None

            if require_paper_approval and not gate_satisfied:
                try:
                    find_research_writer_consume_script()
                except Exception as e:
                    return _die(str(e))
                outputs, plan, risks, rollback = _workflow_context(
                    workflow_id=str(args.workflow_id),
                    run_id=str(args.run_id),
                )
                approval_id, packet_rel = _request_approval(
                    repo_root=repo_root,
                    st=st,
                    category="A4",
                    run_id=str(args.run_id),
                    plan_step_ids=["literature_survey.polish"],
                    purpose="Run research-writer consume (deterministic hygiene + optional compile) on the T30 literature survey export.",
                    plan=plan,
                    risks=risks,
                    outputs=outputs,
                    rollback=rollback,
                    note="A4 gate for literature survey polish",
                    force=False,
                )
                print(f"[info] requested approval: {approval_id}")
                print(f"[info] packet: {packet_rel}")
                return 3

            polish = literature_survey_polish_one(
                LiteratureSurveyPolishInputs(
                    tag=str(args.run_id),
                    compile_pdf=not bool(getattr(args, "survey_no_compile", False)),
                    timeout_seconds=900,
                ),
                repo_root=repo_root,
            )
            errors = list(res.get("errors") or []) + list(polish.get("errors") or [])
            artifact_paths: dict[str, str] = {}
            # Pointers to the deterministic input export.
            for name in [
                "manifest.json",
                "summary.json",
                "analysis.json",
                "survey.json",
                "survey.tex",
                "literature_survey.bib",
                "refkey_to_citekey.json",
                "citekey_to_refkeys.json",
                "report.md",
            ]:
                p = survey_dir / name
                if p.exists() and p.is_file():
                    artifact_paths[f"survey_{name.replace('.', '_')}"] = os.fspath(p.relative_to(repo_root))
            export_log = survey_log_dir / "orchestrator_export.txt"
            if export_log.exists() and export_log.is_file():
                artifact_paths["survey_export_log"] = os.fspath(export_log.relative_to(repo_root))
            artifact_paths.update(polish.get("artifact_paths") or {})
            # Keep the last-produced artifacts under the legacy keys for status readability.
            for k in ["manifest", "summary", "analysis", "report"]:
                if (polish.get("artifact_paths") or {}).get(k):
                    artifact_paths[k] = str((polish.get("artifact_paths") or {}).get(k))
            res = {"errors": errors, "artifact_paths": artifact_paths}
        elif args.workflow_id in adapter_workflow_ids():
            # Adapter workflows: run-card-driven backend execution with SSOT artifacts.
            try:
                validate_adapter_registry()
            except Exception as e:
                return _die(f"adapter registry invalid: {e}")

            run_card_from_file = False
            if getattr(args, "run_card", None):
                run_card_path = Path(str(args.run_card))
                if not run_card_path.is_absolute():
                    run_card_path = repo_root / run_card_path
                run_card = load_run_card(run_card_path)
                run_card_from_file = True
            else:
                run_card = default_run_card_for_workflow(workflow_id=str(args.workflow_id), run_id=str(args.run_id), state=st)
            run_card = normalize_approval_run_card_fields(run_card)

            # Enforce run_id/workflow_id coherence (Orchestrator is the single entrypoint).
            run_card["run_id"] = str(args.run_id)
            run_card["workflow_id"] = str(args.workflow_id)
            run_card["orchestrator_command"] = list(sys.argv)
            artifact_step = run_card.get("artifact_step")
            if not isinstance(artifact_step, str) or not artifact_step.strip():
                raise ValueError("run-card.artifact_step is required for adapter workflows")
            artifact_step = artifact_step.strip()
            if "/" in artifact_step or "\\" in artifact_step or ".." in artifact_step:
                raise ValueError(f"artifact_step must not contain path separators or '..': {artifact_step!r}")
            run_card["artifact_step"] = artifact_step
            try:
                adapter = adapter_for_workflow(str(args.workflow_id))
            except KeyError:
                return _die(f"no adapter registered for workflow_id {args.workflow_id!r}")

            backend = run_card.get("backend") if isinstance(run_card.get("backend"), dict) else {}
            # Optional sandbox injection for adapter workflows (v0).
            sandbox_provider = str(getattr(args, "sandbox", "none") or "none").strip().lower()
            if sandbox_provider not in {"none", "off", "false", "0"}:
                if not isinstance(backend, dict):
                    backend = {}
                backend_raw = run_card.get("backend")
                if not isinstance(backend_raw, dict):
                    raise ValueError("--sandbox requires run-card.backend to be an object (with argv/cwd/env)")
                argv_raw = backend.get("argv")
                if not isinstance(argv_raw, list) or not argv_raw or not all(isinstance(x, str) and x.strip() for x in argv_raw):
                    raise ValueError("--sandbox requires run-card.backend.argv to be a non-empty string list")
                if bool(getattr(args, "sandbox_repo_writable", False)) and sandbox_provider != "local_copy":
                    raise ValueError(
                        "--sandbox-repo-writable is only supported with --sandbox local_copy "
                        "(docker is always repo_read_only; auto may resolve to docker)"
                    )
                existing = backend.get("sandbox") if isinstance(backend.get("sandbox"), dict) else None
                existing_enabled = bool(existing and bool(existing.get("enabled")))
                if existing_enabled and not bool(getattr(args, "force", False)):
                    raise ValueError(
                        "run-card already specifies backend.sandbox; omit --sandbox (run-card is SSOT). "
                        "If you must override for a rerun, pass --force (overrides cannot weaken existing policy and may still be refused)."
                    )
                if existing_enabled and bool(getattr(args, "force", False)):
                    existing_provider = str((existing or {}).get("provider") or "").strip().lower()
                    existing_network = str((existing or {}).get("network") or "disabled").strip().lower()
                    existing_repo_ro = bool((existing or {}).get("repo_read_only", True))
                    new_network = str(getattr(args, "sandbox_network", "disabled") or "disabled").strip().lower()
                    new_repo_ro = True if sandbox_provider == "docker" else not bool(getattr(args, "sandbox_repo_writable", False))
                    if existing_provider and sandbox_provider != existing_provider:
                        raise ValueError(
                            f"refusing to change sandbox provider via CLI override: {existing_provider!r} -> {sandbox_provider!r} (edit run-card instead)"
                        )
                    if existing_network in {"disabled", "none"} and new_network == "host":
                        raise ValueError("refusing to weaken sandbox network policy from disabled/none -> host (edit run-card instead)")
                    if existing_repo_ro and not new_repo_ro:
                        raise ValueError("refusing to weaken sandbox repo_read_only from true -> false via CLI override (edit run-card instead)")
                    prev_note = str(run_card.get("notes") or "").strip()
                    suffix = "sandbox overridden by CLI flags (non-weakening enforced)"
                    run_card["notes"] = (prev_note + ("\n" if prev_note else "") + suffix).strip()
                repo_read_only = True if sandbox_provider == "docker" else not bool(getattr(args, "sandbox_repo_writable", False))
                sandbox_cfg: dict[str, object] = {
                    "enabled": True,
                    "provider": sandbox_provider,
                    "network": str(getattr(args, "sandbox_network", "disabled") or "disabled").strip().lower(),
                    "repo_read_only": bool(repo_read_only),
                }
                docker_image = str(getattr(args, "sandbox_docker_image", "") or "").strip()
                if docker_image:
                    sandbox_cfg["docker_image"] = docker_image
                backend["sandbox"] = sandbox_cfg
                run_card["backend"] = backend

            backend_kind = backend.get("kind") if isinstance(backend.get("kind"), str) else None
            backend_kind = str(backend_kind or adapter.backend_kind)

            strict_gate_resolution = bool(getattr(args, "strict_gate_resolution", False))
            try:
                resolved_approvals, approval_resolution_mode, approval_resolution_trace, approval_resolution_warnings = _resolve_adapter_gate_resolution(
                    run_card=run_card,
                    policy=policy,
                    backend_kind=backend_kind,
                    cli_gate=(str(args.gate).strip() if getattr(args, "gate", None) else None),
                    strict_mode=strict_gate_resolution,
                    is_default_run_card=not run_card_from_file,
                )
            except GateResolutionError as e:
                run_card_ref = "<default-run-card>"
                if run_card_from_file:
                    try:
                        run_card_ref = os.fspath(run_card_path.relative_to(repo_root))
                    except Exception:  # CONTRACT-EXEMPT: CODE-01.5 diagnostic fallthrough
                        run_card_ref = os.fspath(run_card_path)
                raise GateResolutionError(
                    f"{e} (run_id={args.run_id}, workflow_id={args.workflow_id}, run_card={run_card_ref})"
                ) from e

            for w in approval_resolution_warnings:
                print(f"[warn][approval-resolution] {w.get('code')}: {w.get('message')}", file=sys.stderr)

            run_card["required_approvals"] = sorted(resolved_approvals)
            run_card["approval_resolution_mode"] = approval_resolution_mode
            run_card["approval_resolution_trace"] = approval_resolution_trace

            prep = adapter.prepare(run_card, st, repo_root=repo_root, force=bool(args.force))

            # Approval handling is adapter-local (to allow SSOT artifacts even when awaiting approval).
            for gate in prep.required_approvals:
                gate_satisfied = (st.get("gate_satisfied") or {}).get(gate)
                if gate_satisfied and not _approval_history_has_approved(st, category=str(gate), approval_id=str(gate_satisfied)):
                    st.setdefault("gate_satisfied", {}).pop(str(gate), None)
                    save_state(repo_root, st)
                    append_ledger_event(
                        repo_root,
                        event_type="gate_satisfied_invalidated",
                        run_id=st.get("run_id"),
                        workflow_id=st.get("workflow_id"),
                        step_id=step_id,
                        details={"category": str(gate), "approval_id": str(gate_satisfied), "reason": "missing approval_history record"},
                    )
                    gate_satisfied = None

                if not gate_satisfied:
                    # Write SSOT artifacts for the awaiting-approval state, then request approval.
                    collected = adapter.collect(prep, None, st, repo_root=repo_root, status="awaiting_approval")
                    st.setdefault("artifacts", {}).update(collected.artifact_paths or {})
                    save_state(repo_root, st)

                    outputs, plan, risks, rollback = _workflow_context(workflow_id=str(args.workflow_id), run_id=str(args.run_id))
                    approval_id, packet_rel = _request_approval(
                        repo_root=repo_root,
                        st=st,
                        category=str(gate),
                        run_id=args.run_id,
                        plan_step_ids=[str(step_id)] if step_id else None,
                        purpose=f"Approval {gate} before running {args.workflow_id}",
                        plan=plan,
                        risks=risks,
                        outputs=outputs,
                        rollback=rollback,
                        approval_resolution_trace=approval_resolution_trace,
                        note="adapter approval requested by run-card/policy",
                        force=False,
                    )
                    print(f"[info] requested approval: {approval_id}")
                    print(f"[info] packet: {packet_rel}")
                    return 3

            if prep.skip_execute:
                # Idempotent resume: load existing artifact pointers (and regenerate report.md if missing).
                artifact_dir = prep.artifact_dir
                manifest_p = artifact_dir / "manifest.json"
                summary_p = artifact_dir / "summary.json"
                analysis_p = artifact_dir / "analysis.json"
                report_p = artifact_dir / "report.md"
                if (not report_p.exists()) and manifest_p.exists() and summary_p.exists() and analysis_p.exists():
                    write_artifact_report(
                        repo_root=repo_root,
                        artifact_dir=artifact_dir,
                        manifest=read_json(manifest_p),
                        summary=read_json(summary_p),
                        analysis=read_json(analysis_p),
                    )
                res = {
                    "errors": [],
                    "artifact_paths": {
                        "manifest": os.fspath(manifest_p.relative_to(repo_root)),
                        "summary": os.fspath(summary_p.relative_to(repo_root)),
                        "analysis": os.fspath(analysis_p.relative_to(repo_root)),
                        "report": os.fspath(report_p.relative_to(repo_root)),
                        "run_card": os.fspath(prep.run_card_path.relative_to(repo_root)),
                    },
                }
            else:
                exec_result = adapter.execute(prep, st, repo_root=repo_root)
                status = "completed" if exec_result.ok else "failed"
                collected = adapter.collect(prep, exec_result, st, repo_root=repo_root, status=status)
                verify = adapter.verify(collected, st, repo_root=repo_root)
                errors = list(collected.errors or [])
                if not verify.ok:
                    errors.extend([m for m in verify.messages if m != "PASS"])
                res = {"errors": errors, "artifact_paths": collected.artifact_paths}

            _inject_approval_resolution_trace_into_manifest(
                repo_root=repo_root,
                artifact_paths=res.get("artifact_paths") if isinstance(res.get("artifact_paths"), dict) else {},
                approval_resolution_mode=approval_resolution_mode,
                approval_resolution_trace=approval_resolution_trace,
            )
        else:
            if not (args.inspire_recid or args.arxiv_id or args.doi):
                return _die("ingest requires one of --inspire-recid/--arxiv-id/--doi")
            res = ingest_one(
                IngestInputs(
                    inspire_recid=args.inspire_recid,
                    arxiv_id=args.arxiv_id,
                    doi=args.doi,
                    refkey=args.refkey,
                    tag=args.run_id,
                    download=args.download,
                    overwrite_note=bool(args.overwrite_note),
                    append_query_log=not bool(args.no_query_log),
                ),
                repo_root=repo_root,
            )
    except GateResolutionError as e:
        cur = st.get("current_step") if isinstance(st.get("current_step"), dict) else {}
        _sync_plan_terminal(
            repo_root,
            st,
            step_id=str(step_id),
            title=str(cur.get("title") or ""),
            status="failed",
        )
        st["run_status"] = "failed"
        st["notes"] = f"{args.workflow_id} failed: approval resolution error: {e}"
        save_state(repo_root, st)
        append_ledger_event(
            repo_root,
            event_type="failed",
            run_id=st.get("run_id"),
            workflow_id=st.get("workflow_id"),
            step_id=step_id,
            details={"error": str(e), "error_type": "approval_resolution"},
        )
        _maybe_auto_trigger_evolution_proposal(repo_root, st, terminal_status="failed")
        return 2
    except Exception as e:
        cur = st.get("current_step") if isinstance(st.get("current_step"), dict) else {}
        _sync_plan_terminal(
            repo_root,
            st,
            step_id=str(step_id),
            title=str(cur.get("title") or ""),
            status="failed",
        )
        st["run_status"] = "failed"
        st["notes"] = f"{args.workflow_id} failed: {e}"
        save_state(repo_root, st)
        append_ledger_event(
            repo_root,
            event_type="failed",
            run_id=st.get("run_id"),
            workflow_id=st.get("workflow_id"),
            step_id=step_id,
            details={"error": str(e)},
        )
        _maybe_auto_trigger_evolution_proposal(repo_root, st, terminal_status="failed")
        return 2

    st.setdefault("artifacts", {}).update(res.get("artifact_paths") or {})
    st.setdefault("checkpoints", {})["last_checkpoint_at"] = _now_z()

    errors = res.get("errors") or []
    if errors and not args.allow_errors:
        cur = st.get("current_step") if isinstance(st.get("current_step"), dict) else {}
        _sync_plan_terminal(
            repo_root,
            st,
            step_id=str(step_id),
            title=str(cur.get("title") or ""),
            status="failed",
        )
        st["run_status"] = "failed"
        st["notes"] = f"{args.workflow_id} completed with errors ({len(errors)}); see artifacts"
        save_state(repo_root, st)
        append_ledger_event(
            repo_root,
            event_type="failed",
            run_id=st.get("run_id"),
            workflow_id=st.get("workflow_id"),
            step_id=step_id,
            details={"errors": errors},
        )
        _maybe_auto_trigger_evolution_proposal(repo_root, st, terminal_status="failed")
        return 2

    cur = st.get("current_step") if isinstance(st.get("current_step"), dict) else {}
    _sync_plan_terminal(
        repo_root,
        st,
        step_id=str(step_id),
        title=str(cur.get("title") or ""),
        status="completed",
    )
    st["run_status"] = "completed"
    st["notes"] = f"completed {args.workflow_id}"
    save_state(repo_root, st)
    append_ledger_event(
        repo_root,
        event_type="completed",
        run_id=st.get("run_id"),
        workflow_id=st.get("workflow_id"),
        step_id=step_id,
        details={"refkey": res.get("refkey"), "errors": errors},
    )
    _maybe_auto_trigger_evolution_proposal(repo_root, st, terminal_status="completed")
    print("[ok] run completed")
    return 0


def cmd_logs(args: argparse.Namespace) -> int:
    repo_root = _repo_root_from_args(args)
    st = _read_or_init_state(repo_root)

    target_run_id = args.run_id or st.get("run_id")
    ledger = ledger_path(repo_root)
    if not ledger.exists():
        return _die("ledger missing (run: init)")

    buf: deque[dict] = deque(maxlen=int(args.tail))
    with ledger.open("r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                event = json.loads(line)
            except Exception:  # CONTRACT-EXEMPT: CODE-01.5 skip malformed JSON lines
                continue
            if target_run_id and event.get("run_id") != target_run_id:
                continue
            buf.append(event)

    for ev in buf:
        ts = ev.get("ts")
        et = ev.get("event_type")
        step = ev.get("step_id")
        details = ev.get("details") or {}
        suffix = f" step={step}" if step else ""
        print(f"- {ts} {et}{suffix} {json.dumps(details, ensure_ascii=False)}")
    return 0


def cmd_context(args: argparse.Namespace) -> int:
    repo_root = _repo_root_from_args(args)
    st = _read_or_init_state(repo_root)
    run_id = args.run_id or st.get("run_id")
    if not run_id:
        return _die("missing run_id (pass --run-id or start a run first)")
    workflow_id = args.workflow_id or st.get("workflow_id")
    try:
        _ensure_context_pack(
            repo_root=repo_root,
            st=st,
            run_id=str(run_id),
            workflow_id=str(workflow_id) if workflow_id else None,
            note=args.note,
            refkey=args.refkey,
        )
    except Exception as e:
        return _die(f"failed to build context pack: {e}")
    ctx_md = (st.get("artifacts") or {}).get("context_md") if isinstance(st.get("artifacts"), dict) else None
    ctx_json = (st.get("artifacts") or {}).get("context_json") if isinstance(st.get("artifacts"), dict) else None
    print("[ok] context pack:")
    if ctx_md:
        print(f"- md: {ctx_md}")
    if ctx_json:
        print(f"- json: {ctx_json}")
    return 0


def cmd_export(args: argparse.Namespace) -> int:
    repo_root = _repo_root_from_args(args)
    st = _read_or_init_state(repo_root)
    run_id = args.run_id or st.get("run_id")
    if not run_id:
        return _die("missing run_id (pass --run-id or start a run first)")

    out_path = Path(args.out) if args.out else (repo_root / "exports" / f"{run_id}.zip")
    out_path.parent.mkdir(parents=True, exist_ok=True)

    include_dirs = [
        repo_root / "artifacts" / "runs" / run_id,
        repo_root / "team" / "runs" / run_id,
    ]

    def rel(p: Path) -> str:
        try:
            return os.fspath(p.relative_to(repo_root)).replace(os.sep, "/")
        except Exception:  # CONTRACT-EXEMPT: CODE-01.5 diagnostic fallthrough
            return os.fspath(p)

    def is_within(path: Path, root: Path) -> bool:
        try:
            path.relative_to(root)
            return True
        except Exception:  # CONTRACT-EXEMPT: CODE-01.5 deny-by-default path containment
            return False

    def safe_kb_file(rel_path: str) -> Path:
        s = str(rel_path).replace("\\", "/").strip()
        if not s:
            raise ValueError("empty path")
        if s.startswith("/") or s.startswith("~") or ":" in Path(s).drive:
            raise ValueError(f"absolute path is not allowed: {s}")
        if s.startswith("./"):
            s = s[2:]
        if ".." in Path(s).parts:
            raise ValueError(f"path traversal is not allowed: {s}")

        full = (repo_root / s).resolve()
        allowed_root = (repo_root / "knowledge_base").resolve()
        if not is_within(full, allowed_root):
            raise ValueError(f"path is outside knowledge_base/: {s}")
        if not full.exists() or not full.is_file():
            raise FileNotFoundError(f"missing file: {s}")
        return full

    files: list[Path] = []
    for base in include_dirs:
        if not base.exists():
            continue
        for p in sorted(base.rglob("*"), key=lambda x: rel(x)):
            if p.is_file():
                files.append(p)

    if getattr(args, "include_kb_profile", False):
        kb_profile_path = repo_root / "artifacts" / "runs" / str(run_id) / "kb_profile" / "kb_profile.json"
        if not kb_profile_path.exists():
            return _die(f"--include-kb-profile requires kb_profile.json: {rel(kb_profile_path)}")
        try:
            kb_profile = read_json(kb_profile_path)
        except Exception as e:
            return _die(f"failed to read kb_profile.json: {e}")
        if not isinstance(kb_profile, dict):
            return _die("kb_profile.json must be a JSON object")

        candidates: list[str] = []
        for k in ["kb_index_path", "source"]:
            v = kb_profile.get(k)
            if isinstance(v, str) and v.strip():
                candidates.append(v)

        selected = kb_profile.get("selected") if isinstance(kb_profile.get("selected"), list) else []
        for e in selected:
            if isinstance(e, dict) and isinstance(e.get("path"), str) and str(e.get("path")).strip():
                candidates.append(str(e.get("path")))

        kb_files: list[Path] = []
        issues: list[str] = []
        seen: set[str] = set()
        for c in candidates:
            s = str(c).replace("\\", "/").strip()
            if not s or s in seen:
                continue
            seen.add(s)
            try:
                kb_files.append(safe_kb_file(s))
            except Exception as e:
                issues.append(f"{s}: {e}")
        if issues:
            preview = "\n".join(f"- {x}" for x in issues[:10])
            return _die(f"kb-profile export safety check failed:\n{preview}")
        files.extend(sorted(kb_files, key=lambda x: rel(x)))

    seen: set[str] = set()
    with zipfile.ZipFile(out_path, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        for p in files:
            arc = rel(p)
            if arc in seen:
                continue
            seen.add(arc)
            zf.write(p, arcname=arc)

    print(f"[ok] wrote: {out_path}")
    return 0


def _mcp_config_path(repo_root: Path, args: argparse.Namespace) -> Path:
    raw = getattr(args, "mcp_config", None)
    if isinstance(raw, str) and raw.strip():
        p = Path(raw).expanduser()
        if not p.is_absolute():
            p = repo_root / p
        return p.resolve()
    return (repo_root / ".mcp.json").resolve()


def _mcp_env(
    repo_root: Path,
    cfg_env: dict[str, str],
    args: argparse.Namespace,
    *,
    create_data_dir: bool,
    project_policy: str | None = None,
) -> dict[str, str]:
    # Prefer explicit CLI override, then process env, else project-local default.
    hep_data_dir_arg = getattr(args, "hep_data_dir", None)
    env_data_dir: str | None = None
    hep_data_dir_source = "default"
    if isinstance(hep_data_dir_arg, str) and hep_data_dir_arg.strip():
        hep_data_dir = Path(hep_data_dir_arg).expanduser()
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

    # Safety: avoid creating arbitrary directories outside the repo by default.
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
        except Exception:  # CONTRACT-EXEMPT: CODE-01.5 deny-by-default path containment
            under_repo = False

        if under_repo:
            hep_data_dir.mkdir(parents=True, exist_ok=True)
        else:
            # Allow explicit / env external dirs *only if they already exist* (no implicit mkdir outside repo).
            if hep_data_dir.exists() and hep_data_dir_source in {"cli", "env"}:
                print(f"[warn] HEP_DATA_DIR is outside repo_root (allowed because it exists): {hep_data_dir}", file=sys.stderr)
            else:
                raise ValueError(
                    "refuse to create a new HEP_DATA_DIR outside repo_root. Create it manually (or pass a repo-local path).\n"
                    f"repo_root={repo_real}\nHEP_DATA_DIR={hep_data_dir}"
                )
    overrides["HEP_DATA_DIR"] = os.fspath(hep_data_dir)
    return merged_env(overrides=overrides)


def cmd_smoke_test(args: argparse.Namespace) -> int:
    # No MCP server interaction; fail-fast check for a healthy Python install + imports.
    try:
        from .toolkit.mcp_config import McpServerConfig, load_mcp_server_config, merged_env  # noqa: F401
        from .toolkit.mcp_stdio_client import McpStdioClient  # noqa: F401
    except Exception as e:
        return _die(f"smoke-test failed: {e}")
    print("[ok] smoke-test: MCP modules importable")
    return 0


def _doctor_detect_shell() -> str:
    shell = str(os.environ.get("SHELL") or "").strip().lower()
    name = Path(shell).name.lower() if shell else ""
    if name in {"zsh", "bash", "fish"}:
        return name
    return "unknown"


def _doctor_runtime_user_bin_candidates() -> list[str]:
    candidates: set[str] = set()
    try:
        user_base = site.getuserbase()
    except Exception:  # CONTRACT-EXEMPT: CODE-01.5 best-effort PATH discovery
        user_base = ""
    if isinstance(user_base, str) and user_base:
        candidates.add(os.path.realpath(os.path.join(user_base, "bin")))

    try:
        user_site = site.getusersitepackages()
    except Exception:  # CONTRACT-EXEMPT: CODE-01.5 best-effort PATH discovery
        user_site = ""
    if isinstance(user_site, str) and user_site:
        candidates.add(os.path.realpath(os.path.join(user_site, "..", "..", "bin")))
        candidates.add(os.path.realpath(os.path.join(user_site, "..", "..", "..", "bin")))

    candidates.add(os.path.realpath(os.path.expanduser("~/.local/bin")))

    py_ver = f"{sys.version_info.major}.{sys.version_info.minor}"
    candidates.add(os.path.realpath(os.path.expanduser(f"~/Library/Python/{py_ver}/bin")))

    mac_py_root = Path.home() / "Library" / "Python"
    try:
        for p in mac_py_root.glob("*/bin"):
            candidates.add(os.path.realpath(os.fspath(p)))
    except Exception:  # CONTRACT-EXEMPT: CODE-01.5 best-effort PATH discovery
        pass

    return sorted({p for p in candidates if p})


def _doctor_entrypoint_hints(
    *,
    shell_name: str,
    in_venv: bool,
    user_bin_on_path: bool,
    user_bin_candidates: list[str],
) -> list[str]:
    hints: list[str] = []
    preferred_user_bin = next(
        (str(p) for p in user_bin_candidates if isinstance(p, str) and p.strip()),
        os.path.realpath(os.path.expanduser("~/.local/bin")),
    )

    if in_venv:
        hints.append(
            "current session appears inside a virtual environment; activate the intended venv before running "
            "autoresearch"
        )
        hints.append(
            "if legacy entrypoints are installed globally instead, deactivate venv or run the absolute script path"
        )
        if user_bin_on_path:
            hints.append(
                f"user scripts directory appears on PATH ({preferred_user_bin}); verify package installation target matches current Python"
            )
        else:
            hints.append("venv is active and user scripts directory is not on PATH in this session")
        return hints
    quoted_bin = preferred_user_bin.replace('"', '\\"')
    if shell_name == "zsh":
        hints.append(
            f"add user scripts dir to PATH (zsh): echo 'export PATH=\"{quoted_bin}:$PATH\"' >> ~/.zshrc"
        )
        hints.append("then reload shell: source ~/.zshrc")
    elif shell_name == "bash":
        hints.append(
            f"add user scripts dir to PATH (bash): echo 'export PATH=\"{quoted_bin}:$PATH\"' >> ~/.bashrc"
        )
        hints.append("then reload shell: source ~/.bashrc")
    elif shell_name == "fish":
        hints.append(f"add user scripts dir to PATH (fish): fish_add_path '{preferred_user_bin}'")
    else:
        hints.append(
            "shell not recognized; ensure the Python scripts directory (e.g. ~/.local/bin or ~/Library/Python/*/bin) is on PATH"
        )

    if user_bin_on_path:
        hints.append(
            "user scripts directory is already on PATH; check whether the package was installed in a different Python environment"
        )
    else:
        hints.append("user scripts directory does not appear on PATH in this session")
    return hints


def _doctor_entrypoint_discovery() -> tuple[dict[str, object], list[dict[str, str]]]:
    shell_name = _doctor_detect_shell()
    in_venv = bool(getattr(sys, "real_prefix", None)) or (str(getattr(sys, "base_prefix", "")) != str(getattr(sys, "prefix", "")))

    path_entries = [p for p in str(os.environ.get("PATH") or "").split(os.pathsep) if p]
    path_norm = [os.path.realpath(os.path.expanduser(p)) for p in path_entries]

    user_bin_candidates = _doctor_runtime_user_bin_candidates()
    user_bin_on_path = any(p in path_norm for p in user_bin_candidates)

    entrypoints: dict[str, dict[str, object]] = {}
    missing: list[str] = []
    for name in ["autoresearch"]:
        resolved = shutil.which(name)
        found = bool(resolved)
        entrypoints[name] = {
            "found": found,
            "path": resolved,
        }
        if not found:
            missing.append(name)

    hints = _doctor_entrypoint_hints(
        shell_name=shell_name,
        in_venv=in_venv,
        user_bin_on_path=user_bin_on_path,
        user_bin_candidates=user_bin_candidates,
    )
    discovery: dict[str, object] = {
        "shell": shell_name,
        "in_venv": bool(in_venv),
        "user_bin_on_path": bool(user_bin_on_path),
        "user_bin_candidates": user_bin_candidates,
        "entrypoints": entrypoints,
        "hints": hints,
    }

    warnings: list[dict[str, str]] = []
    if missing:
        warnings.append(
            _status_warning(
                code="entrypoints_missing",
                message=f"missing entrypoints on PATH: {', '.join(missing)}",
            )
        )
    return discovery, warnings


def _doctor_entrypoint_discovery_json(
    args: argparse.Namespace,
    *,
    entrypoint_discovery: dict[str, object] | None = None,
    entrypoint_warnings: list[dict[str, str]] | None = None,
) -> int:
    strict_entrypoints = bool(getattr(args, "strict_entrypoints", False))
    if entrypoint_discovery is None or entrypoint_warnings is None:
        entrypoint_discovery, entrypoint_warnings = _doctor_entrypoint_discovery()

    payload = {
        "entrypoint_discovery": entrypoint_discovery,
        "warnings": entrypoint_warnings,
        "strict_entrypoints": strict_entrypoints,
        "ok": not (strict_entrypoints and bool(entrypoint_warnings)),
    }
    print(json.dumps(payload, indent=2, ensure_ascii=False, sort_keys=True))
    if strict_entrypoints and entrypoint_warnings:
        return 2
    return 0


def _doctor_missing_mcp_config_message(*, repo_root: Path, cfg_path: Path) -> str:
    lines = [
        "missing MCP config. Create .mcp.json (ignored by git) or pass --mcp-config.",
        f"expected: {cfg_path}",
    ]
    ex = (repo_root / ".mcp.json.example").resolve()
    if ex.exists():
        lines.extend(
            [
                "template available:",
                f"- {ex}",
                "quick start:",
                f"- cp {ex} {cfg_path}",
            ]
        )
    return "\n".join(lines)


def cmd_doctor(args: argparse.Namespace) -> int:
    repo_root = _repo_root_from_args(args)

    strict_entrypoints = bool(getattr(args, "strict_entrypoints", False))
    json_mode = bool(getattr(args, "json", False))
    entrypoints_only = bool(getattr(args, "entrypoints_only", False))
    allow_missing_mcp_config = bool(getattr(args, "allow_missing_mcp_config", False))
    entrypoint_discovery, entrypoint_warnings = _doctor_entrypoint_discovery()

    if json_mode:
        return _doctor_entrypoint_discovery_json(
            args,
            entrypoint_discovery=entrypoint_discovery,
            entrypoint_warnings=entrypoint_warnings,
        )

    print("[doctor] entrypoint_discovery:")
    print(f"- shell: {entrypoint_discovery.get('shell')}")
    print(f"- in_venv: {entrypoint_discovery.get('in_venv')}")
    print(f"- user_bin_on_path: {entrypoint_discovery.get('user_bin_on_path')}")
    entrypoints = entrypoint_discovery.get("entrypoints")
    if isinstance(entrypoints, dict):
        for cmd in ["autoresearch"]:
            item = entrypoints.get(cmd) if isinstance(entrypoints.get(cmd), dict) else {}
            found = bool((item or {}).get("found"))
            path = (item or {}).get("path")
            if found:
                print(f"- {cmd}: found ({path})")
            else:
                print(f"- {cmd}: missing on PATH")
    hints = entrypoint_discovery.get("hints")
    if isinstance(hints, list) and hints:
        print("[doctor] entrypoint hints:", file=sys.stderr)
        for hint in hints:
            if isinstance(hint, str) and hint.strip():
                print(f"- {hint}", file=sys.stderr)

    entrypoint_error = False
    for w in entrypoint_warnings:
        print(f"[warn][doctor] {w.get('code')}: {w.get('message')}", file=sys.stderr)
        if strict_entrypoints:
            entrypoint_error = True

    if entrypoint_error:
        return _die("strict entrypoint check failed (missing autoresearch on PATH)", code=2)

    if entrypoints_only:
        print("[doctor] entrypoints-only: skipping MCP config/server checks")
        if allow_missing_mcp_config:
            print("[doctor] note: --allow-missing-mcp-config is redundant with --entrypoints-only", file=sys.stderr)
        return 0

    cfg_path = _mcp_config_path(repo_root, args)
    if not cfg_path.exists():
        msg = _doctor_missing_mcp_config_message(repo_root=repo_root, cfg_path=cfg_path)
        if allow_missing_mcp_config:
            print(f"[warn][doctor] {msg}", file=sys.stderr)
            return 0
        return _die(
            msg
        )

    server_name = str(getattr(args, "mcp_server", "hep-research") or "hep-research").strip()
    try:
        cfg = load_mcp_server_config(config_path=cfg_path, server_name=server_name)
    except Exception as e:
        return _die(f"failed to load MCP server config: {e}")

    try:
        env = _mcp_env(repo_root, cfg.env, args, create_data_dir=False, project_policy=PROJECT_POLICY_REAL_PROJECT)
    except Exception as e:
        return _die(str(e))

    try:
        with McpStdioClient(cfg=cfg, cwd=repo_root, env=env) as client:
            client.initialize(client_name="hepar", client_version="0.0.1")
            tools = client.list_tools()
            names = {t.name for t in tools}

            required = [
                "hep_health",
                "hep_project_list",
                "hep_project_create",
                "hep_run_create",
                "hep_run_stage_content",
                "hep_run_read_artifact_chunk",
            ]
            missing = [t for t in required if t not in names]

            print("[doctor] mcp server ok:")
            print(f"- server: {cfg.name}")
            if env.get("HEP_DATA_DIR"):
                print(f"- HEP_DATA_DIR: {env.get('HEP_DATA_DIR')}")
            print(f"- tools: {len(tools)}")
            if missing:
                print("[doctor] missing required tools:")
                for t in missing:
                    print(f"- {t}")
                return 2

            health = client.call_tool_json(tool_name="hep_health", arguments={"check_inspire": False})
            if not health.ok:
                print("[doctor] hep_health returned error:")
                print(health.raw_text or "(no output)")
                return 2
            print("[doctor] hep_health:")
            print(health.raw_text or "(ok)")
            return 0
    except Exception as e:
        return _die(f"doctor failed: {e}")


def cmd_bridge(args: argparse.Namespace) -> int:
    repo_root = _repo_root_from_args(args)

    hepar_run_id = str(getattr(args, "run_id", "") or "").strip()
    workspace_arg = getattr(args, "workspace", None)
    if isinstance(workspace_arg, str) and workspace_arg.strip():
        ws = Path(workspace_arg).expanduser()
        if not ws.is_absolute():
            ws = repo_root / ws
        computation_dir = ws.resolve()
    else:
        if not hepar_run_id:
            return _die("bridge requires --run-id (or --workspace)")
        computation_dir = (repo_root / "artifacts" / "runs" / hepar_run_id / "computation").resolve()

    analysis_path = computation_dir / "analysis.json"
    manifest_path = computation_dir / "manifest.json"
    if not analysis_path.exists():
        return _die(f"missing computation analysis.json: {analysis_path}")
    if not manifest_path.exists():
        return _die(f"missing computation manifest.json: {manifest_path}")

    try:
        analysis = read_json(analysis_path)
        w_manifest = read_json(manifest_path)
    except Exception as e:
        return _die(f"failed to read computation artifacts: {e}")

    results = analysis.get("results") if isinstance(analysis, dict) else None
    if not isinstance(results, dict):
        return _die("computation analysis.json missing results object")

    status = results.get("status")
    if status != "completed":
        return _die(f"computation is not completed (status={status!r}); run computation first")

    headline_numbers = results.get("headline_numbers")
    acceptance_checks = results.get("acceptance_checks")
    ok_flag = bool(results.get("ok"))
    if not isinstance(headline_numbers, list):
        return _die("computation analysis.json missing results.headline_numbers list")
    if not isinstance(acceptance_checks, list):
        return _die("computation analysis.json missing results.acceptance_checks list")

    created_at = utc_now_iso().replace("+00:00", "Z")
    bridge_step_dir = repo_root / "artifacts" / "runs" / (hepar_run_id or "bridge") / "bridge_mcp"
    bridge_step_dir.mkdir(parents=True, exist_ok=True)

    cfg_path = _mcp_config_path(repo_root, args)
    if not cfg_path.exists():
        return _die(
            "missing MCP config. Create .mcp.json (ignored by git) or pass --mcp-config.\n"
            f"expected: {cfg_path}"
        )

    server_name = str(getattr(args, "mcp_server", "hep-research") or "hep-research").strip()
    project_name = str(getattr(args, "mcp_project_name", "hep-autoresearch") or "hep-autoresearch").strip()
    if not project_name:
        return _die("--mcp-project-name must be non-empty")

    try:
        cfg = load_mcp_server_config(config_path=cfg_path, server_name=server_name)
    except Exception as e:
        return _die(f"failed to load MCP server config: {e}")

    try:
        # `_mcp_env` builds a *sanitized* environment for the MCP subprocess (allowlisted base env +
        # explicit overrides like HEP_DATA_DIR). Do not forward the full parent env (secret leakage risk).
        # See: toolkit/mcp_config.py `merged_env()` allowlist.
        env = _mcp_env(repo_root, cfg.env, args, create_data_dir=True, project_policy=PROJECT_POLICY_REAL_PROJECT)
    except Exception as e:
        return _die(str(e))

    def _rel(p: Path) -> str:
        try:
            return os.fspath(p.resolve().relative_to(repo_root.resolve())).replace(os.sep, "/")
        except Exception:  # CONTRACT-EXEMPT: CODE-01.5 diagnostic fallthrough
            return os.fspath(p).replace(os.sep, "/")

    # Prepare staged payloads (keep them JSON so they can be consumed later).
    payload_headlines = {
        "schema_version": 1,
        "generated_at": created_at,
        "hepar_run_id": hepar_run_id or None,
        "computation_analysis": _rel(analysis_path),
        "headline_numbers": headline_numbers,
    }
    payload_acceptance = {
        "schema_version": 1,
        "generated_at": created_at,
        "hepar_run_id": hepar_run_id or None,
        "computation_analysis": _rel(analysis_path),
        "ok": bool(ok_flag),
        "acceptance_checks": acceptance_checks,
    }
    payload_manifest = {
        "schema_version": 1,
        "generated_at": created_at,
        "hepar_run_id": hepar_run_id or None,
        "computation_manifest": _rel(manifest_path),
        "manifest": w_manifest,
    }

    actions: list[dict[str, Any]] = []
    required_passed: list[str] = []
    required_failed: list[str] = []
    staged: dict[str, dict[str, Any]] = {}
    mcp_run_id = ""

    bridge_state_path = bridge_step_dir / "bridge_state.json"
    bridge_report_path = bridge_step_dir / "bridge_report.json"

    def _write_bridge_state(status2: str, **progress: Any) -> None:
        write_json(
            bridge_state_path,
            {
                "schema_version": 1,
                "status": str(status2),
                "timestamp_utc": utc_now_iso().replace("+00:00", "Z"),
                "hepar_run_id": hepar_run_id or None,
                "computation_dir": _rel(computation_dir),
                "mcp_server": cfg.name,
                "mcp_project_name": project_name,
                "mcp_run_id": mcp_run_id or None,
                "required_passed": sorted(required_passed),
                "required_failed": sorted(required_failed),
                "staged_artifacts": staged,
                "progress": progress,
                "agent_actions": actions,
            },
        )

    def _record(tool: str, status2: str, **extras: Any) -> None:
        row: dict[str, Any] = {"tool": tool, "status": status2, "timestamp": utc_now_iso().replace("+00:00", "Z")}
        row.update(extras)
        actions.append(row)

    _write_bridge_state("in_progress", step="start")

    try:
        with McpStdioClient(cfg=cfg, cwd=repo_root, env=env) as client:
            client.initialize(client_name="hepar", client_version="0.0.1")
            tools = client.list_tools()
            tool_names = {t.name for t in tools}

            required_tools = [
                "hep_project_list",
                "hep_project_create",
                "hep_run_create",
                "hep_run_stage_content",
                "hep_run_read_artifact_chunk",
            ]
            missing_tools = [t for t in required_tools if t not in tool_names]
            if missing_tools:
                _write_bridge_state("failed", step="missing_tools", missing_tools=sorted(missing_tools))
                return _die(f"MCP server missing tools: {', '.join(missing_tools)}")

            # Resolve or create a project by name (best-effort).
            proj_list = client.call_tool_json(tool_name="hep_project_list", arguments={})
            _record("hep_project_list", "ok" if proj_list.ok else "error")
            projects = proj_list.json if isinstance(proj_list.json, list) else []
            project_id: str | None = None
            for p in projects:
                if isinstance(p, dict) and str(p.get("name") or "") == project_name and isinstance(p.get("project_id"), str):
                    project_id = str(p["project_id"])
                    break

            if project_id is None:
                proj_create = client.call_tool_json(
                    tool_name="hep_project_create",
                    arguments={"name": project_name, "description": f"hepar bridge from {repo_root.name}"},
                )
                _record("hep_project_create", "ok" if proj_create.ok else "error")
                if not proj_create.ok:
                    raise RuntimeError(f"hep_project_create failed: {proj_create.raw_text}")
                proj = proj_create.json if isinstance(proj_create.json, dict) else None
                project_id = str(proj.get("project_id") or "").strip() if isinstance(proj, dict) else ""
                if not project_id:
                    raise RuntimeError(f"hep_project_create returned no project_id: {proj_create.raw_text}")

            _write_bridge_state("in_progress", step="project_resolved", project_id=project_id)

            # Create an MCP run to hold staged compute results.
            args_snapshot = {
                "hepar_run_id": hepar_run_id,
                "computation_dir": _rel(computation_dir),
                "computation_analysis": _rel(analysis_path),
            }
            run_create = client.call_tool_json(
                tool_name="hep_run_create",
                arguments={"project_id": project_id, "args_snapshot": args_snapshot},
            )
            _record("hep_run_create", "ok" if run_create.ok else "error")
            if not run_create.ok:
                raise RuntimeError(f"hep_run_create failed: {run_create.raw_text}")
            run_obj = run_create.json if isinstance(run_create.json, dict) else None
            manifest_obj = run_obj.get("manifest") if isinstance(run_obj, dict) else None
            mcp_run_id = str(manifest_obj.get("run_id") or "").strip() if isinstance(manifest_obj, dict) else ""
            if not mcp_run_id:
                raise RuntimeError(f"hep_run_create returned no run_id: {run_create.raw_text}")

            _write_bridge_state("in_progress", step="run_created", mcp_run_id=mcp_run_id)

            # Stage required payloads.
            for key, payload in [
                ("headline_numbers", payload_headlines),
                ("acceptance", payload_acceptance),
                ("manifest", payload_manifest),
            ]:
                staged_res = client.call_tool_json(
                    tool_name="hep_run_stage_content",
                    arguments={
                        "run_id": mcp_run_id,
                        "content_type": "section_output",
                        "content": json.dumps(payload, indent=2, sort_keys=True) + "\n",
                        "artifact_suffix": f"hepar_{key}_{hepar_run_id or 'run'}",
                    },
                )
                _record("hep_run_stage_content", "ok" if staged_res.ok else "error", kind=key)
                if not staged_res.ok:
                    raise RuntimeError(f"hep_run_stage_content failed ({key}): {staged_res.raw_text}")
                staged_obj = staged_res.json if isinstance(staged_res.json, dict) else None
                if not isinstance(staged_obj, dict) or not isinstance(staged_obj.get("artifact_name"), str):
                    raise RuntimeError(f"bad stage result ({key}): {staged_res.raw_text}")
                staged[key] = staged_obj
                _write_bridge_state(
                    "in_progress",
                    step="staged",
                    staged_kind=str(key),
                    staged_artifact=str(staged_obj.get("artifact_name") or ""),
                )

            # Outcome gate: verify run + staged artifacts can be read back.
            def _check(name: str, artifact_name: str) -> None:
                r = client.call_tool_json(
                    tool_name="hep_run_read_artifact_chunk",
                    arguments={"run_id": mcp_run_id, "artifact_name": artifact_name, "offset": 0, "length": 128},
                )
                _record("hep_run_read_artifact_chunk", "ok" if r.ok else "error", artifact=artifact_name)
                if r.ok:
                    required_passed.append(name)
                else:
                    required_failed.append(name)

            _check("run_registered", "args_snapshot.json")
            _check("headline_numbers", str(staged["headline_numbers"]["artifact_name"]))
            _check("acceptance", str(staged["acceptance"]["artifact_name"]))
            _check("manifest", str(staged["manifest"]["artifact_name"]))

            bridge_status = "success" if not required_failed else "partial"
            bridge_report = {
                "bridge_status": bridge_status,
                "mcp_run_id": mcp_run_id,
                "outcome_gate": {
                    "required_passed": sorted(required_passed),
                    "required_failed": sorted(required_failed),
                    "optional_passed": [],
                    "optional_warned": [],
                },
                "agent_actions": actions,
                "retry_count": 0,
                "timestamp_utc": created_at,
            }

            write_json(bridge_report_path, bridge_report)
            _write_bridge_state(str(bridge_status), step="outcome_gate", bridge_status=str(bridge_status))

            # Also write SSOT artifacts for the bridge step.
            from .toolkit._git import try_get_git_metadata
            import platform

            manifest = {
                "schema_version": 1,
                "created_at": created_at,
                "command": "hepar bridge",
                "cwd": manifest_cwd(repo_root=repo_root, cwd=repo_root),
                "params": {
                    "hepar_run_id": hepar_run_id,
                    "computation_dir": _rel(computation_dir),
                    "mcp_server": cfg.name,
                    "mcp_project_name": project_name,
                },
                "versions": {"python": sys.version.split()[0], "os": platform.platform()},
                "outputs": [_rel(bridge_report_path)],
            }
            git_meta = try_get_git_metadata(repo_root)
            if git_meta:
                manifest["git"] = git_meta

            summary = {
                "schema_version": 1,
                "created_at": created_at,
                "definitions": {"kind": "bridge_mcp"},
                "stats": {
                    "bridge_status": bridge_status,
                    "required_passed": int(len(required_passed)),
                    "required_failed": int(len(required_failed)),
                },
                "outputs": {
                    "bridge_report": _rel(bridge_report_path),
                },
            }

            analysis_out = {
                "schema_version": 1,
                "created_at": created_at,
                "inputs": {
                    "hepar_run_id": hepar_run_id,
                    "computation_analysis": _rel(analysis_path),
                },
                "results": {
                    "ok": bool(bridge_status == "success"),
                    "errors": [f"required_failed: {x}" for x in required_failed],
                    "headlines": {
                        "required_passed": int(len(required_passed)),
                        "required_failed": int(len(required_failed)),
                    },
                    "bridge_status": bridge_status,
                    "mcp_run_id": mcp_run_id,
                    "staged_artifacts": staged,
                },
            }

            manifest_path_out = bridge_step_dir / "manifest.json"
            summary_path_out = bridge_step_dir / "summary.json"
            analysis_path_out = bridge_step_dir / "analysis.json"
            write_json(manifest_path_out, manifest)
            write_json(summary_path_out, summary)
            write_json(analysis_path_out, analysis_out)
            write_artifact_report(
                repo_root=repo_root,
                artifact_dir=bridge_step_dir,
                manifest=manifest,
                summary=summary,
                analysis=analysis_out,
            )

            if bridge_status != "success":
                print("[warn] bridge outcome gate: partial (see bridge_report.json)")
                return 2

            print("[ok] bridge outcome gate: success")
            print(f"- mcp_run_id: {mcp_run_id}")
            print(f"- report: {_rel(bridge_report_path)}")
            return 0
    except Exception as e:
        try:
            write_json(
                bridge_report_path,
                {
                    "bridge_status": "failed",
                    "mcp_run_id": mcp_run_id or None,
                    "outcome_gate": {
                        "required_passed": sorted(required_passed),
                        "required_failed": sorted(required_failed),
                        "optional_passed": [],
                        "optional_warned": [],
                    },
                    "agent_actions": actions,
                    "retry_count": 0,
                    "error": str(e),
                    "timestamp_utc": created_at,
                },
            )
            _write_bridge_state("failed", step="exception", error=str(e))
        except Exception as write_err:
            print(f"[error] failed to write bridge crash artifacts: {write_err}", file=sys.stderr)
        return _die(f"bridge failed: {e}")


def _extract_discovery_recids(payload: object, *, max_recids: int) -> list[str]:
    """Best-effort recid extraction from launcher-resolved discovery output."""
    return extract_candidate_recids(payload, max_recids=max_recids)


def _c1_collect_text(v: object, *, max_items: int = 40, max_depth: int = 3) -> str:
    """Best-effort extract a readable text blob from nested JSON-ish values."""

    parts: list[str] = []
    preferred_keys = {"value", "text", "title", "abstract", "name", "label"}

    def rec(x: object, depth: int) -> None:
        if x is None:
            return
        if depth > max_depth:
            return
        if isinstance(x, str):
            s = x.strip()
            if s:
                parts.append(s)
            return
        if isinstance(x, (bool, int, float)):
            return
        if isinstance(x, dict):
            # Prefer common text-like keys first, then fall back to values.
            for k in sorted(preferred_keys):
                if k in x:
                    rec(x.get(k), depth + 1)
            for kk, vv in list(x.items())[:max_items]:
                if str(kk) in preferred_keys:
                    continue
                rec(vv, depth + 1)
            return
        if isinstance(x, list):
            for vv in x[:max_items]:
                rec(vv, depth + 1)
            return

    rec(v, 0)
    return " ".join(parts).strip()


def _c1_as_int(v: object) -> int | None:
    if isinstance(v, bool):
        return None
    if isinstance(v, int):
        return int(v)
    if isinstance(v, float):
        if math.isfinite(v):
            return int(v)
        return None
    if isinstance(v, str):
        s = v.strip()
        if not s:
            return None
        try:
            return int(s)
        except Exception:  # CONTRACT-EXEMPT: CODE-01.5 intentional fallback
            return None
    return None


def _c1_extract_year(p: dict[str, Any]) -> int | None:
    for k in ["year", "publication_year", "pub_year"]:
        y = _c1_as_int(p.get(k))
        if isinstance(y, int) and 1900 <= y <= 2100:
            return int(y)
    for k in ["date", "publication_date", "pub_date"]:
        s = str(p.get(k) or "").strip()
        if not s:
            continue
        m = re.search(r"\b(19\d{2}|20\d{2})\b", s)
        if m:
            try:
                return int(m.group(1))
            except Exception:  # CONTRACT-EXEMPT: CODE-01.5 skip on error
                continue
    return None


def _c1_extract_citations(p: dict[str, Any]) -> int | None:
    for k in ["citation_count", "citations", "cited_by", "citationCount", "citation_count_total"]:
        c = _c1_as_int(p.get(k))
        if isinstance(c, int) and c >= 0:
            return int(c)
    return None


def _c1_extract_title(p: dict[str, Any]) -> str | None:
    for k in ["title", "titles", "document_title"]:
        if k in p:
            s = _c1_collect_text(p.get(k))
            return s or None
    return None


def _c1_extract_abstract(p: dict[str, Any]) -> str | None:
    for k in ["abstract", "abstracts", "summary"]:
        if k in p:
            s = _c1_collect_text(p.get(k))
            return s or None
    return None


def _c1_extract_authors(p: dict[str, Any]) -> list[str]:
    a = p.get("authors")
    if not isinstance(a, list):
        return []
    out: list[str] = []
    for x in a[:50]:
        if isinstance(x, str):
            s = x.strip()
            if s:
                out.append(s)
            continue
        if isinstance(x, dict):
            # Common keys: full_name/name/last_name/first_name.
            s = ""
            for k in ["full_name", "name"]:
                if k in x and str(x.get(k) or "").strip():
                    s = str(x.get(k) or "").strip()
                    break
            if not s and (x.get("first_name") or x.get("last_name")):
                s = (str(x.get("first_name") or "").strip() + " " + str(x.get("last_name") or "").strip()).strip()
            s = s.strip()
            if s:
                out.append(s)
    # Stable, de-duplicated.
    seen: set[str] = set()
    dedup: list[str] = []
    for s in out:
        if s in seen:
            continue
        seen.add(s)
        dedup.append(s)
    return dedup


def _c1_extract_field_survey_candidates(payload: object, *, created_at: str) -> dict[str, Any]:
    """Extract a candidate paper list from field-survey style output (no ranking, no heuristic relevance).

    This is intentionally best-effort and schema-flexible, because MCP servers may evolve the output shape.
    """
    if not isinstance(payload, dict):
        return {
            "schema_version": 1,
            "created_at": created_at,
            "papers": [],
            "stats": {"papers_seen": 0, "unique_recids": 0},
            "notes": "payload not an object; no candidates extracted",
        }

    # FieldSurveyResult (hep-research-mcp) has:
    # - reviews.papers
    # - seminal_papers.papers
    # - citation_network.all_papers
    #
    # Older stubs may use citation_network.papers.
    sections: list[tuple[str, list[dict[str, Any]]]] = []

    def _as_papers_list(sec: object, *, keys: list[str]) -> list[dict[str, Any]]:
        if not isinstance(sec, dict):
            return []
        for k in keys:
            v = sec.get(k)
            if isinstance(v, list):
                return [x for x in v if isinstance(x, dict)]
        return []

    reviews = payload.get("reviews")
    sections.append(("reviews", _as_papers_list(reviews, keys=["papers"])))

    seminal = payload.get("seminal_papers")
    sections.append(("seminal_papers", _as_papers_list(seminal, keys=["papers"])))

    citation = payload.get("citation_network")
    sections.append(("citation_network", _as_papers_list(citation, keys=["all_papers", "papers"])))

    # Merge per-recid info across sections (no scoring).
    by_recid: dict[str, dict[str, Any]] = {}
    first_seen: dict[str, int] = {}
    papers_seen = 0
    idx = 0
    for sec_key, papers in sections:
        for p in papers:
            recid_raw = p.get("recid")
            if recid_raw is None:
                continue
            recid = str(recid_raw).strip()
            if not recid:
                continue
            papers_seen += 1
            idx += 1
            if recid not in first_seen:
                first_seen[recid] = idx
            row = by_recid.get(recid)
            if row is None:
                row = {
                    "recid": recid,
                    "sources": set(),
                    "title": None,
                    "abstract": None,
                    "authors": [],
                    "year": None,
                    "citation_count": None,
                    "extra": {},
                }
                by_recid[recid] = row
            row["sources"].add(sec_key)
            if row.get("title") is None:
                row["title"] = _c1_extract_title(p)
            if row.get("abstract") is None:
                row["abstract"] = _c1_extract_abstract(p)
            if not row.get("authors"):
                row["authors"] = _c1_extract_authors(p)
            y = _c1_extract_year(p)
            if y is not None:
                prev = row.get("year")
                if not isinstance(prev, int) or y > prev:
                    row["year"] = y
            c = _c1_extract_citations(p)
            if c is not None:
                prevc = row.get("citation_count")
                if not isinstance(prevc, int) or c > prevc:
                    row["citation_count"] = c

            # Preserve a small, stable extra subset when present.
            extra = row.get("extra") if isinstance(row.get("extra"), dict) else {}
            for k in ["discovery_source", "contribution", "review_mentions", "is_review", "key_topics"]:
                if k in p and k not in extra:
                    extra[k] = p.get(k)
            row["extra"] = extra

    papers_out: list[dict[str, Any]] = []
    for recid, info in by_recid.items():
        title = info.get("title")
        abstract = info.get("abstract")
        year = info.get("year")
        citations = info.get("citation_count")
        authors = info.get("authors") if isinstance(info.get("authors"), list) else []
        sources = sorted(list(info.get("sources") or [])) if isinstance(info.get("sources"), set) else []
        extra = info.get("extra") if isinstance(info.get("extra"), dict) else {}

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
                "first_seen_index": int(first_seen.get(recid) or 0),
                "sources": sources,
                "title": title,
                "abstract": abstract,
                "authors": [str(a) for a in authors if isinstance(a, str) and a.strip()],
                "year": year,
                "citation_count": citations,
                "missing_fields": missing,
                "extra": extra,
            }
        )

    # Preserve first-seen ordering (no implied relevance scoring).
    papers_out.sort(key=lambda r: (int(r.get("first_seen_index") or 0), str(r.get("recid") or "")))

    return {
        "schema_version": 1,
        "created_at": created_at,
        "papers": papers_out,
        "stats": {"papers_seen": int(papers_seen), "unique_recids": int(len(by_recid))},
        "notes": "Candidate extraction only; selection/ranking is external (LLM/human) and must be recorded separately.",
    }


def _c1_extract_seed_search_candidates(payload: object, *, created_at: str) -> dict[str, Any]:
    """Extract candidate papers from search-style discovery output."""
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
        title = _c1_extract_title(paper)
        abstract = _c1_extract_abstract(paper)
        year = _c1_extract_year(paper)
        citations = _c1_extract_citations(paper)
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
                "authors": _c1_extract_authors(paper),
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


def _validate_field_survey_schema(payload: object) -> list[str]:
    """Best-effort shape checks for field-survey JSON output (diagnostic only)."""
    issues: list[str] = []
    if not isinstance(payload, dict):
        issues.append("field_survey output is not a JSON object")
        return issues
    expected = ["seminal_papers", "reviews", "citation_network"]
    if not any(k in payload for k in expected):
        issues.append("field_survey output missing expected sections: seminal_papers/reviews/citation_network")
        return issues
    # Validate the minimal expected paper-list locations.
    for key in ["reviews", "seminal_papers"]:
        sec = payload.get(key)
        if sec is None:
            continue
        if not isinstance(sec, dict):
            issues.append(f"field_survey section {key!r} is not an object")
            continue
        papers = sec.get("papers")
        if papers is not None and not isinstance(papers, list):
            issues.append(f"field_survey section {key!r}.papers is not a list")

    citation = payload.get("citation_network")
    if citation is not None:
        if not isinstance(citation, dict):
            issues.append("field_survey section 'citation_network' is not an object")
        else:
            papers = citation.get("all_papers")
            papers2 = citation.get("papers")
            if papers is None and papers2 is None:
                issues.append("field_survey section 'citation_network' missing both all_papers and papers")
            if papers is not None and not isinstance(papers, list):
                issues.append("field_survey section 'citation_network'.all_papers is not a list")
            if papers2 is not None and not isinstance(papers2, list):
                issues.append("field_survey section 'citation_network'.papers is not a list")
    return issues


def cmd_literature_gap(args: argparse.Namespace) -> int:
    """Phase C1: MCP-assisted literature gap discovery + analysis.

    Seed selection (relevance ranking / filtering) is external (LLM/human) and MUST be recorded in a
    `seed_selection.json` file. This workflow intentionally provides **no deterministic relevance fallback**.
    """
    repo_root = _repo_root_from_args(args)

    tag = str(getattr(args, "tag", "") or "").strip()
    if not tag:
        return _die("--tag is required")

    phase = str(getattr(args, "phase", "discover") or "discover").strip().lower()
    if phase not in {"discover", "analyze"}:
        return _die("--phase must be one of: discover, analyze")

    topic = str(getattr(args, "topic", "") or "").strip()

    created_at = utc_now_iso().replace("+00:00", "Z")
    out_dir = (repo_root / "artifacts" / "runs" / tag / "literature_gap" / phase).resolve()
    out_dir.mkdir(parents=True, exist_ok=True)

    cfg_path = _mcp_config_path(repo_root, args)
    if not cfg_path.exists():
        return _die(
            "missing MCP config. Create .mcp.json (ignored by git) or pass --mcp-config.\n"
            f"expected: {cfg_path}"
        )

    server_name = str(getattr(args, "mcp_server", "hep-research") or "hep-research").strip()
    try:
        cfg = load_mcp_server_config(config_path=cfg_path, server_name=server_name)
    except Exception as e:
        return _die(f"failed to load MCP server config: {e}")

    try:
        env = _mcp_env(repo_root, cfg.env, args, create_data_dir=True, project_policy=PROJECT_POLICY_REAL_PROJECT)
    except Exception as e:
        return _die(str(e))

    allow_external_inputs = bool(getattr(args, "allow_external_inputs", False))

    def _rel(p: Path) -> str:
        try:
            return os.fspath(p.resolve().relative_to(repo_root.resolve())).replace(os.sep, "/")
        except Exception:  # CONTRACT-EXEMPT: CODE-01.5 diagnostic fallthrough
            return os.fspath(p).replace(os.sep, "/")

    def _sha256_file(path: Path) -> str:
        import hashlib

        h = hashlib.sha256()
        with path.open("rb") as f:
            for chunk in iter(lambda: f.read(1024 * 1024), b""):
                h.update(chunk)
        return h.hexdigest()

    def _resolve_path(p: str, *, allow_external: bool) -> Path:
        pp = Path(str(p)).expanduser()
        if not pp.is_absolute():
            pp = repo_root / pp
        resolved = pp.resolve()
        if not allow_external:
            try:
                resolved.relative_to(repo_root.resolve())
            except Exception:
                raise ValueError(f"unsafe path outside repo_root (copy into repo or pass --allow-external-inputs): {resolved}")
        return resolved

    def _read_json_file(path: Path) -> Any:
        return json.loads(path.read_text(encoding="utf-8", errors="replace"))

    def _load_seed_selection(path: Path) -> tuple[list[str], dict[str, Any] | None, list[str]]:
        """Return (ordered_recids, raw_obj, errors)."""
        errs: list[str] = []
        try:
            raw = _read_json_file(path)
        except Exception as e:
            return [], None, [f"seed_selection: failed to read JSON: {e}"]
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
        for i, it in enumerate(items[:200]):
            if not isinstance(it, dict):
                errs.append(f"seed_selection: items[{i}] must be an object")
                continue
            recid = str(it.get("recid") or "").strip()
            if not recid:
                errs.append(f"seed_selection: items[{i}].recid must be a non-empty string")
                continue
            reason = str(it.get("reason_for_inclusion") or "").strip()
            if not reason:
                errs.append(f"seed_selection: items[{i}].reason_for_inclusion must be a non-empty string")
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
        except Exception as e:
            return set(), None, [f"candidates: failed to read JSON: {e}"]
        if not isinstance(raw, dict) or int(raw.get("schema_version") or 0) != 1:
            errs.append("candidates: schema_version must be 1 and JSON must be an object")
            return set(), raw if isinstance(raw, dict) else None, errs
        papers = raw.get("papers")
        if not isinstance(papers, list):
            errs.append("candidates: papers must be a list")
            return set(), raw, errs
        recids: set[str] = set()
        for p in papers:
            if not isinstance(p, dict):
                continue
            r = str(p.get("recid") or "").strip()
            if r:
                recids.add(r)
        if not recids:
            errs.append("candidates: no recids found in papers")
        return recids, raw, errs

    actions: list[dict[str, Any]] = []
    errors: list[str] = []

    def _record(tool: str, status2: str, **extras: Any) -> None:
        row: dict[str, Any] = {"tool": tool, "status": status2, "timestamp": utc_now_iso().replace("+00:00", "Z")}
        row.update(extras)
        actions.append(row)

    mcp_init: dict[str, Any] | None = None
    mcp_tools: list[str] = []

    if phase == "discover":
        analyze_dir = (repo_root / "artifacts" / "runs" / tag / "literature_gap" / "analyze").resolve()
        if analyze_dir.exists() and (analyze_dir / "gap_report.json").exists():
            print("[warn] literature-gap discover: analyze artifacts already exist for this tag; re-running discover may make analyze stale")
            print(f"- analyze_dir: {_rel(analyze_dir)}")

        if not topic:
            return _die("--topic is required for --phase discover")

        workflow_plan: dict[str, Any] | None = None
        discover_json: Any | None = None
        discover_ok = False
        candidates_json: dict[str, Any] | None = None
        plan_path = out_dir / "workflow_plan.json"
        discover_path = out_dir / "seed_search.json"

        try:
            with McpStdioClient(cfg=cfg, cwd=repo_root, env=env) as client:
                init_raw = client.initialize(client_name="hepar", client_version="0.0.1")
                mcp_init = {
                    "protocolVersion": init_raw.get("protocolVersion") if isinstance(init_raw, dict) else None,
                    "serverInfo": init_raw.get("serverInfo") if isinstance(init_raw, dict) else None,
                }
                tools = client.list_tools()
                tool_names = {t.name for t in tools}
                mcp_tools = sorted(tool_names)

                focus_terms: list[str] = []
                focus = getattr(args, "focus", None)
                if isinstance(focus, list) and focus:
                    focus_terms = [str(x).strip() for x in focus if str(x).strip()]
                seed_recid = str(getattr(args, "seed_recid", "") or "").strip()
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
                    _record(
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
                candidates_json = _c1_extract_seed_search_candidates(discover_json, created_at=created_at)
                candidate_recids = _extract_discovery_recids(
                    discover_json,
                    max_recids=int(getattr(args, "max_recids", 12) or 12),
                )
                candidates_json["inputs"] = {
                    "topic": topic,
                    "query": topic,
                    "focus": list(focus_terms),
                    "seed_recid": seed_recid or None,
                }
                candidates_json["resolver"] = {
                    "recipe_id": "literature_gap_analysis",
                    "phase": "discover",
                    "seed_recids_preview": candidate_recids,
                }
        except Exception as e:
            errors.append(f"exception: {e}")

        candidates_path = out_dir / "candidates.json"
        gap_report_path = out_dir / "gap_report.json"
        write_json(plan_path, workflow_plan if workflow_plan is not None else {})
        write_json(discover_path, discover_json if discover_json is not None else {})
        write_json(
            candidates_path,
            candidates_json if candidates_json is not None else {"schema_version": 1, "created_at": created_at, "papers": [], "inputs": {"topic": topic}},
        )

        gap_report = {
            "schema_version": 1,
            "created_at": created_at,
            "phase": "discover",
            "inputs": {
                "topic": topic,
                "focus": list(getattr(args, "focus", None) or []) if isinstance(getattr(args, "focus", None), list) else [],
                "seed_recid": str(getattr(args, "seed_recid", "") or "").strip() or None,
                "iterations": int(getattr(args, "iterations", 2) or 2),
                "max_papers": int(getattr(args, "max_papers", 40) or 40),
            },
            "results": {
                "ok": bool(not errors),
                "errors": errors,
                "workflow_plan": {"path": _rel(plan_path)},
                "seed_search": {"ok": bool(discover_ok), "path": _rel(discover_path)},
                "candidates": {
                    "path": _rel(candidates_path),
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

        manifest_path = out_dir / "manifest.json"
        summary_path = out_dir / "summary.json"
        analysis_path = out_dir / "analysis.json"

        from .toolkit._git import try_get_git_metadata
        import platform

        manifest: dict[str, Any] = {
            "schema_version": 1,
            "created_at": created_at,
            "command": "python -m hep_autoresearch.orchestrator_cli literature-gap --phase discover",
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
                _rel(manifest_path),
                _rel(summary_path),
                _rel(analysis_path),
                _rel(gap_report_path),
                _rel(plan_path),
                _rel(discover_path),
                _rel(candidates_path),
            ],
        }
        git_meta = try_get_git_metadata(repo_root)
        if git_meta:
            manifest["git"] = git_meta

        ok_flag = bool(not errors)
        stats_candidates = candidates_json.get("stats") if isinstance(candidates_json, dict) else None
        try:
            cand_count = int((stats_candidates or {}).get("unique_recids") or 0) if isinstance(stats_candidates, dict) else 0
        except Exception:  # CONTRACT-EXEMPT: CODE-01.5 intentional fallback
            cand_count = 0
        if cand_count == 0:
            print("[warn] literature-gap discover: 0 candidates extracted; seed_selection.json will have nothing to select from")

        summary: dict[str, Any] = {
            "schema_version": 1,
            "created_at": created_at,
            "definitions": {"kind": "literature_gap_discover"},
            "stats": {
                "ok": bool(ok_flag),
                "errors": int(len(errors)),
                "actions": int(len(actions)),
                "candidates": (stats_candidates.get("unique_recids") if isinstance(stats_candidates, dict) else None),
            },
            "outputs": {"gap_report": _rel(gap_report_path), "candidates": _rel(candidates_path)},
        }

        analysis_out: dict[str, Any] = {
            "schema_version": 1,
            "created_at": created_at,
            "inputs": {"tag": tag, "phase": "discover", "topic": topic},
            "results": {
                "ok": bool(ok_flag),
                "errors": errors,
                "actions": actions,
                "candidates_stats": stats_candidates,
                "outputs": {"gap_report": _rel(gap_report_path), "candidates": _rel(candidates_path)},
            },
        }

        write_json(manifest_path, manifest)
        write_json(summary_path, summary)
        write_json(analysis_path, analysis_out)
        write_artifact_report(repo_root=repo_root, artifact_dir=out_dir, manifest=manifest, summary=summary, analysis=analysis_out)

        if not ok_flag:
            print("[warn] literature-gap discover: completed with errors (see analysis.json)")
            for item in errors:
                print(f"- error: {item}")
            print(f"- out: {_rel(out_dir)}")
            return 2

        print("[ok] literature-gap discover: wrote artifacts")
        print(f"- out: {_rel(out_dir)}")
        print(f"- candidates: {_rel(candidates_path)}")
        print("Next: create seed_selection.json (schema_version=1), then run --phase analyze.")
        return 0

    # phase == analyze
    seed_sel_raw = str(getattr(args, "seed_selection", "") or "").strip()
    if not seed_sel_raw:
        return _die("--seed-selection is required for --phase analyze")
    try:
        seed_sel_path = _resolve_path(seed_sel_raw, allow_external=allow_external_inputs)
    except Exception as e:
        return _die(str(e))
    if not seed_sel_path.exists():
        return _die(f"--seed-selection not found: {seed_sel_path}")

    candidates_raw = str(getattr(args, "candidates", "") or "").strip()
    if candidates_raw:
        try:
            candidates_path_in = _resolve_path(candidates_raw, allow_external=allow_external_inputs)
        except Exception as e:
            return _die(str(e))
    else:
        candidates_path_in = (repo_root / "artifacts" / "runs" / tag / "literature_gap" / "discover" / "candidates.json").resolve()
    if not candidates_path_in.exists():
        return _die(f"candidates.json not found (run discover first, or pass --candidates): {candidates_path_in}")

    cand_recids, cand_obj, cand_errs = _load_candidates(candidates_path_in)
    if cand_errs:
        return _die("invalid candidates.json:\n- " + "\n- ".join(cand_errs))

    cli_topic = topic
    cand_topic = ""
    try:
        inps = cand_obj.get("inputs") if isinstance(cand_obj, dict) else None
        cand_topic = str((inps or {}).get("topic") or "").strip() if isinstance(inps, dict) else ""
    except Exception:  # CONTRACT-EXEMPT: CODE-01.5 intentional fallback
        cand_topic = ""

    if cli_topic and cand_topic and cli_topic != cand_topic:
        return _die(
            f"--topic mismatch for --phase analyze: cli={cli_topic!r}, candidates.json#/inputs/topic={cand_topic!r}. "
            "Use --candidates to point to the matching discover run, or omit --topic to infer."
        )

    if not topic:
        try:
            topic = cand_topic
        except Exception:  # CONTRACT-EXEMPT: CODE-01.5 intentional fallback
            topic = ""
    if not topic:
        return _die("--topic missing and could not infer it from candidates.json#/inputs/topic")

    seed_recids, _seed_obj, seed_errs = _load_seed_selection(seed_sel_path)
    if seed_errs:
        return _die("invalid seed_selection.json:\n- " + "\n- ".join(seed_errs))

    allow_external = bool(getattr(args, "allow_external_seeds", False))
    missing = [r for r in seed_recids if r not in cand_recids]
    if missing and not allow_external:
        return _die(
            "seed_selection contains recids not present in candidates.json (refuse to continue without --allow-external-seeds):\n- "
            + "\n- ".join(missing[:20])
            + ("\n- …" if len(missing) > 20 else "")
        )
    if missing and allow_external:
        errors.append(f"seed_selection: {len(missing)} recids not in candidates.json (allowed by --allow-external-seeds)")

    max_recids = int(getattr(args, "max_recids", 12) or 12)
    if max_recids < 1:
        return _die("--max-recids must be >= 1")
    recids = seed_recids[:max_recids]
    if not recids:
        return _die("seed_selection produced no recids (cannot analyze)")

    seed_copy_path = out_dir / "seed_selection.json"
    seed_copy_path.write_text(seed_sel_path.read_text(encoding="utf-8", errors="replace"), encoding="utf-8")
    seed_copy_sha256 = _sha256_file(seed_copy_path)

    workflow_plan: dict[str, Any] | None = None
    plan_path = out_dir / "workflow_plan.json"
    topic_json: Any | None = None
    critical_json: Any | None = None
    network_json: Any | None = None
    connection_json: Any | None = None

    try:
        with McpStdioClient(cfg=cfg, cwd=repo_root, env=env) as client:
            init_raw = client.initialize(client_name="hepar", client_version="0.0.1")
            mcp_init = {
                "protocolVersion": init_raw.get("protocolVersion") if isinstance(init_raw, dict) else None,
                "serverInfo": init_raw.get("serverInfo") if isinstance(init_raw, dict) else None,
            }
            tools = client.list_tools()
            tool_names = {t.name for t in tools}
            mcp_tools = sorted(tool_names)

            topic_mode = str(getattr(args, "topic_mode", "timeline") or "timeline").strip()
            network_mode = str(getattr(args, "network_mode", "citation") or "citation").strip()
            seed = str(recids[0])
            network_direction_cli = str(getattr(args, "network_direction", "both") or "both").strip().lower()
            direction_map = {
                "both": "both",
                "in": "citations",
                "out": "refs",
            }
            network_direction_tool = direction_map.get(network_direction_cli, "both")
            workflow_plan = resolve_literature_workflow(
                repo_root,
                recipe_id="literature_gap_analysis",
                phase="analyze",
                inputs={
                    "topic": topic,
                    "recids": recids,
                    "analysis_seed": seed,
                },
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
                    step_args["mode"] = topic_mode
                    step_args["topic"] = topic
                    step_args["limit"] = int(getattr(args, "topic_limit", 40) or 40)
                    step_args["options"] = {"granularity": str(getattr(args, "topic_granularity", "5year") or "5year")}
                elif step_id == "critical_analysis":
                    step_args["recid"] = seed
                elif step_id == "citation_network":
                    step_args["mode"] = network_mode
                    step_args["seed"] = seed
                    step_args["limit"] = int(getattr(args, "network_limit", 80) or 80)
                    step_args["options"] = {
                        "depth": int(getattr(args, "network_depth", 1) or 1),
                        "direction": network_direction_tool,
                    }
                elif step_id == "connection_scan":
                    step_args["recids"] = recids
                result = client.call_tool_json(tool_name=tool_name, arguments=step_args, timeout_seconds=300.0)
                extras: dict[str, Any] = {
                    "workflow_step": step_id,
                    "provider": str(step.get("provider") or "") or None,
                }
                if step_id == "citation_network":
                    extras["network_direction_cli"] = network_direction_cli
                    extras["network_direction_tool"] = network_direction_tool
                _record(tool_name, "ok" if result.ok else "error", **extras)
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
    except Exception as e:
        errors.append(f"exception: {e}")

    topic_path = out_dir / "topic_analysis.json"
    critical_path = out_dir / "critical_analysis.json"
    network_path = out_dir / "network_analysis.json"
    connection_path = out_dir / "connection_scan.json"
    gap_report_path = out_dir / "gap_report.json"
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
            "seed_selection_path": _rel(seed_copy_path),
            "seed_selection_sha256": seed_copy_sha256,
            "candidates_path": _rel(candidates_path_in),
            "recids": recids,
        },
        "results": {
            "ok": bool(not errors),
            "errors": errors,
            "workflow_plan": {"path": _rel(plan_path)},
            "topic_analysis": {"path": _rel(topic_path)},
            "critical_analysis": {"path": _rel(critical_path)},
            "network_analysis": {"path": _rel(network_path)},
            "connection_scan": {"path": _rel(connection_path)},
        },
        "agent_actions": actions,
    }
    write_json(gap_report_path, gap_report)

    manifest_path = out_dir / "manifest.json"
    summary_path = out_dir / "summary.json"
    analysis_path = out_dir / "analysis.json"

    from .toolkit._git import try_get_git_metadata
    import platform

    manifest: dict[str, Any] = {
        "schema_version": 1,
        "created_at": created_at,
        "command": "python -m hep_autoresearch.orchestrator_cli literature-gap --phase analyze",
        "cwd": manifest_cwd(repo_root=repo_root, cwd=repo_root),
        "params": {"tag": tag, "phase": "analyze", "topic": topic, "mcp_server": cfg.name},
        "versions": {"python": sys.version.split()[0], "os": platform.platform()},
        "mcp": {"server_name": cfg.name, "init": mcp_init, "tools": mcp_tools},
        "outputs": [
            _rel(manifest_path),
            _rel(summary_path),
            _rel(analysis_path),
            _rel(gap_report_path),
            _rel(plan_path),
            _rel(topic_path),
            _rel(critical_path),
            _rel(network_path),
            _rel(connection_path),
            _rel(seed_copy_path),
        ],
    }
    git_meta = try_get_git_metadata(repo_root)
    if git_meta:
        manifest["git"] = git_meta

    ok_flag = bool(not errors)
    summary: dict[str, Any] = {
        "schema_version": 1,
        "created_at": created_at,
        "definitions": {"kind": "literature_gap_analyze"},
        "stats": {"ok": bool(ok_flag), "recids": int(len(recids)), "errors": int(len(errors)), "actions": int(len(actions))},
        "outputs": {"gap_report": _rel(gap_report_path), "seed_selection": _rel(seed_copy_path)},
    }

    analysis_out: dict[str, Any] = {
        "schema_version": 1,
        "created_at": created_at,
        "inputs": {"tag": tag, "phase": "analyze", "topic": topic},
        "results": {"ok": bool(ok_flag), "errors": errors, "recids": recids, "actions": actions, "outputs": {"gap_report": _rel(gap_report_path)}},
    }

    write_json(manifest_path, manifest)
    write_json(summary_path, summary)
    write_json(analysis_path, analysis_out)
    write_artifact_report(repo_root=repo_root, artifact_dir=out_dir, manifest=manifest, summary=summary, analysis=analysis_out)

    if not ok_flag:
        print("[warn] literature-gap analyze: completed with errors (see analysis.json)")
        for item in errors:
            print(f"- error: {item}")
        print(f"- out: {_rel(out_dir)}")
        return 2

    print("[ok] literature-gap analyze: wrote artifacts")
    print(f"- out: {_rel(out_dir)}")
    print(f"- gap_report: {_rel(gap_report_path)}")
    return 0


def cmd_method_design(args: argparse.Namespace) -> int:
    """Phase C2: method design + runnable computation scaffold generation (MVP: deterministic templates)."""
    repo_root = _repo_root_from_args(args)
    try:
        res = method_design_one(
            MethodDesignInputs(
                tag=str(args.tag),
                template=str(args.template),
                project_id=str(args.project_id or ""),
                title=str(args.title) if getattr(args, "title", None) else None,
                description=str(args.description) if getattr(args, "description", None) else None,
                out_project_dir=str(args.out_project_dir) if getattr(args, "out_project_dir", None) else None,
                overwrite=bool(getattr(args, "overwrite", False)),
                spec_path=str(args.spec) if getattr(args, "spec", None) else None,
                mcp_config=str(args.mcp_config) if getattr(args, "mcp_config", None) else None,
                mcp_server=str(getattr(args, "mcp_server", "hep-research") or "hep-research"),
                hep_data_dir=str(args.hep_data_dir) if getattr(args, "hep_data_dir", None) else None,
                pdg_particle_name=str(args.pdg_particle_name) if getattr(args, "pdg_particle_name", None) else None,
                pdg_property=str(getattr(args, "pdg_property", "mass") or "mass"),
                pdg_allow_derived=not bool(getattr(args, "pdg_no_derived", False)),
            ),
            repo_root=repo_root,
        )
    except Exception as e:
        return _die(f"method-design failed: {e}")

    ok = bool(res.get("ok"))
    paths = res.get("artifact_paths") if isinstance(res.get("artifact_paths"), dict) else {}
    if ok:
        print("[ok] method-design: wrote artifacts + project scaffold:")
    else:
        print("[warn] method-design: completed with errors (see analysis.json):")
    for k, v in sorted(paths.items()):
        print(f"- {k}: {v}")
    return 0 if ok else 2


def cmd_propose(args: argparse.Namespace) -> int:
    repo_root = _repo_root_from_args(args)
    res = evolution_proposal_one(
        EvolutionProposalInputs(
            tag=str(args.tag),
            source_run_tag=str(args.source_run_tag),
            max_proposals=int(args.max_proposals),
            include_eval_failures=not bool(args.no_eval_failures),
            write_kb_trace=not bool(args.no_kb_trace),
            kb_trace_path=str(args.kb_trace_path) if args.kb_trace_path else None,
        ),
        repo_root=repo_root,
    )
    print("[ok] wrote evolution proposal artifacts:")
    for k, v in sorted((res.get("artifact_paths") or {}).items()):
        print(f"- {k}: {v}")
    return 0


def cmd_skill_propose(args: argparse.Namespace) -> int:
    repo_root = _repo_root_from_args(args)
    res = skill_proposal_one(
        SkillProposalInputs(
            tag=str(args.tag),
            source_run_tag=str(args.source_run_tag),
            max_proposals=int(args.max_proposals),
        ),
        repo_root=repo_root,
    )
    print("[ok] wrote skill proposal artifacts:")
    for k, v in sorted((res.get("artifact_paths") or {}).items()):
        print(f"- {k}: {v}")
    return 0


def cmd_run_card_validate(args: argparse.Namespace) -> int:
    """Validate a computation run_card v2 (strict schema + cycle check)."""
    repo_root = _repo_root_from_args(args)

    run_card_path = Path(str(args.run_card)).expanduser()
    if not run_card_path.is_absolute():
        run_card_path = repo_root / run_card_path
    run_card_path = run_card_path.resolve()
    if not run_card_path.exists() or not run_card_path.is_file():
        return _die(f"run-card not found: {run_card_path}")

    project_dir_arg = getattr(args, "project_dir", None)
    if project_dir_arg:
        project_dir = Path(str(project_dir_arg)).expanduser()
        if not project_dir.is_absolute():
            project_dir = repo_root / project_dir
        project_dir = project_dir.resolve()
    else:
        project_dir = _infer_project_dir_from_run_card_path(run_card_path)
    if not project_dir or not project_dir.exists() or not project_dir.is_dir():
        return _die(
            "could not infer project_dir from run-card path; expected layout: <project_dir>/run_cards/<card>.json "
            "(or pass --project-dir <dir>)"
        )

    raw = load_run_card_v2(run_card_path)
    params = _parse_param_overrides(getattr(args, "param", None))
    run_id_override = str(args.run_id).strip() if getattr(args, "run_id", None) else None
    card = normalize_and_validate_run_card_v2(raw, run_id_override=run_id_override, param_overrides=params)

    # Cycle detection for phases.depends_on (shares semantics with computation).
    from .toolkit.computation import validate_phase_dag

    validate_phase_dag(list(card.normalized.get("phases") or []))

    print("[ok] run-card v2 validated (computation)")
    print(f"- project_dir: {os.fspath(project_dir)}")
    print(f"- run_card: {os.fspath(run_card_path)}")
    return 0


def _render_phase_dag_text(phases: list[dict[str, Any]]) -> str:
    from .toolkit.computation import validate_phase_dag

    order = validate_phase_dag(phases)
    edges: list[tuple[str, str]] = []
    for ph in phases:
        pid = str(ph.get("phase_id"))
        for d in ph.get("depends_on") or []:
            edges.append((str(d), pid))
    edges_sorted = sorted(set(edges))

    lines: list[str] = []
    lines.append("computation phase DAG")
    lines.append("")
    lines.append("Topological order:")
    lines.append("- " + " -> ".join(order))
    lines.append("")
    lines.append("Edges:")
    if edges_sorted:
        for a, b in edges_sorted:
            lines.append(f"- {a} -> {b}")
    else:
        lines.append("- (none)")
    lines.append("")
    return "\n".join(lines)


def _render_phase_dag_dot(phases: list[dict[str, Any]]) -> str:
    from .toolkit.computation import validate_phase_dag

    order = validate_phase_dag(phases)
    edges: list[tuple[str, str]] = []
    for ph in phases:
        pid = str(ph.get("phase_id"))
        for d in ph.get("depends_on") or []:
            edges.append((str(d), pid))
    edges_sorted = sorted(set(edges))

    lines: list[str] = []
    lines.append('digraph "computation" {')
    lines.append("  rankdir=LR;")
    for pid in order:
        lines.append(f'  "{pid}";')
    for a, b in edges_sorted:
        lines.append(f'  "{a}" -> "{b}";')
    lines.append("}")
    lines.append("")
    return "\n".join(lines)


def _render_phase_dag_mermaid(phases: list[dict[str, Any]]) -> str:
    from .toolkit.computation import validate_phase_dag

    order = validate_phase_dag(phases)
    deps: dict[str, list[str]] = {pid: [] for pid in order}
    for ph in phases:
        pid = str(ph.get("phase_id"))
        for d in ph.get("depends_on") or []:
            deps.setdefault(pid, []).append(str(d))

    lines: list[str] = []
    lines.append("flowchart TD")
    for pid in order:
        lines.append(f"  {pid}[{pid}]")
    has_edge = False
    for pid in order:
        for d in sorted(set(deps.get(pid) or [])):
            has_edge = True
            lines.append(f"  {d} --> {pid}")
    if not has_edge:
        lines.append("  %% (no edges)")
    lines.append("")
    return "\n".join(lines)


def cmd_run_card_render(args: argparse.Namespace) -> int:
    """Render a computation run_card v2 phase DAG (after strict validation)."""
    repo_root = _repo_root_from_args(args)

    run_card_path = Path(str(args.run_card)).expanduser()
    if not run_card_path.is_absolute():
        run_card_path = repo_root / run_card_path
    run_card_path = run_card_path.resolve()
    if not run_card_path.exists() or not run_card_path.is_file():
        return _die(f"run-card not found: {run_card_path}")

    project_dir_arg = getattr(args, "project_dir", None)
    if project_dir_arg:
        project_dir = Path(str(project_dir_arg)).expanduser()
        if not project_dir.is_absolute():
            project_dir = repo_root / project_dir
        project_dir = project_dir.resolve()
    else:
        project_dir = _infer_project_dir_from_run_card_path(run_card_path)
    if not project_dir or not project_dir.exists() or not project_dir.is_dir():
        return _die(
            "could not infer project_dir from run-card path; expected layout: <project_dir>/run_cards/<card>.json "
            "(or pass --project-dir <dir>)"
        )

    raw = load_run_card_v2(run_card_path)
    params = _parse_param_overrides(getattr(args, "param", None))
    run_id_override = str(args.run_id).strip() if getattr(args, "run_id", None) else None
    card = normalize_and_validate_run_card_v2(raw, run_id_override=run_id_override, param_overrides=params)

    phases = list(card.normalized.get("phases") or [])
    fmt = str(getattr(args, "format", "mermaid") or "mermaid").strip().lower()
    if fmt == "text":
        rendered = _render_phase_dag_text(phases)
    elif fmt == "dot":
        rendered = _render_phase_dag_dot(phases)
    else:
        rendered = _render_phase_dag_mermaid(phases)

    out = getattr(args, "out", None)
    if out:
        out_path = Path(str(out)).expanduser()
        if not out_path.is_absolute():
            out_path = repo_root / out_path
        out_path = out_path.resolve()
        try:
            out_path.relative_to(repo_root.resolve())
        except Exception:
            return _die(f"run-card render out must be within repo_root: {out_path}")
        out_path.parent.mkdir(parents=True, exist_ok=True)
        out_path.write_text(rendered, encoding="utf-8")
        print("[ok] wrote run-card DAG:")
        print(f"- out: {os.fspath(out_path)}")
    else:
        sys.stdout.write(rendered)
    return 0


def cmd_migrate_wrapper(args: argparse.Namespace) -> int:
    """CLI wrapper for ``workspace migrate`` (M-20)."""
    from .toolkit.migrate import cmd_migrate

    repo_root = _repo_root_from_args(args)
    registry_path = None
    reg_arg = getattr(args, "registry", None)
    if reg_arg:
        registry_path = Path(str(reg_arg)).expanduser().resolve()
    dry_run = getattr(args, "dry_run", False)
    return cmd_migrate(repo_root, registry_path=registry_path, dry_run=dry_run)


def main(argv: list[str] | None = None, *, public_surface: bool = False) -> int:
    description = (
        "Legacy Pipeline A CLI for unrepointed workflow and maintainer commands."
        if public_surface
        else "Orchestrator CLI v0.4 (run + status/pause/resume/approve)."
    )
    parser = argparse.ArgumentParser(description=description)
    parser.add_argument(
        "--project-root",
        help="Project root directory (default: search upward for .autoresearch/, else use CWD).",
    )
    sub = parser.add_subparsers(dest="cmd", required=True)

    if not public_surface:
        p_init = sub.add_parser("init", help="Initialize .autoresearch/ state and approval policy (legacy Pipeline A surface; canonical generic entrypoint is `autoresearch init`).")
        p_init.add_argument("--force", action="store_true", help="Overwrite existing state.json.")
        p_init.add_argument(
            "--allow-nested",
            action="store_true",
            help="Allow init inside a subdirectory of an existing project root (not recommended).",
        )
        p_init.add_argument(
            "--runtime-only",
            action="store_true",
            help="Initialize only .autoresearch runtime state/policy without scaffolding project-local docs/KB/specs. Intended for maintainer regressions and harness use.",
        )
        p_init.add_argument("--checkpoint-interval-seconds", type=int, help="Default checkpoint interval.")
        p_init.set_defaults(fn=cmd_init)

    p_start = sub.add_parser("start", help="Start a run (sets run_id/workflow_id, status=running).")
    p_start.add_argument("--run-id", required=True, help="Run tag, e.g. M1-r1")
    p_start.add_argument("--workflow-id", required=True, help="Workflow id, e.g. ingest")
    p_start.add_argument("--step-id", help="Optional initial step id.")
    p_start.add_argument("--step-title", help="Optional initial step title.")
    p_start.add_argument("--checkpoint-interval-seconds", type=int, help="Override checkpoint interval for this run.")
    p_start.add_argument("--note", help="Ledger note.")
    p_start.add_argument("--force", action="store_true", help="Override running/awaiting_approval.")
    p_start.set_defaults(fn=cmd_start)

    if not public_surface:
        p_status = sub.add_parser("status", help="Show current state (legacy Pipeline A surface; canonical generic entrypoint is `autoresearch status`).")
        p_status.add_argument("--json", action="store_true", help="Emit machine-readable JSON output.")
        p_status.set_defaults(fn=cmd_status)

        p_pause = sub.add_parser("pause", help="Pause current run (writes .pause and updates state; canonical generic entrypoint is `autoresearch pause`).")
        p_pause.add_argument("--note", help="Ledger note.")
        p_pause.set_defaults(fn=cmd_pause)

        p_resume = sub.add_parser("resume", help="Resume current run (removes .pause and updates state; canonical generic entrypoint is `autoresearch resume`).")
        p_resume.add_argument("--note", help="Ledger note.")
        p_resume.add_argument("--force", action="store_true", help="Allow resuming from idle/completed/failed.")
        p_resume.set_defaults(fn=cmd_resume)

    p_ckpt = sub.add_parser("checkpoint", help="Update checkpoint timestamp (runner heartbeat).")
    p_ckpt.add_argument("--step-id", help="Optional current step id.")
    p_ckpt.add_argument("--step-title", help="Optional current step title.")
    p_ckpt.add_argument("--note", help="Ledger note.")
    p_ckpt.add_argument("--force", action="store_true", help="Allow checkpoint in any status.")
    p_ckpt.set_defaults(fn=cmd_checkpoint)

    p_req = sub.add_parser("request-approval", help="Enter awaiting_approval and write an approval packet.")
    p_req.add_argument("--category", required=True, help="A1|A2|A3|A4|A5")
    p_req.add_argument("--run-id", help="Override run_id for packet path.")
    p_req.add_argument("--purpose", help="Purpose (1–3 sentences).")
    p_req.add_argument("--plan", action="append", default=[], help="Plan step (repeatable).")
    p_req.add_argument("--risk", action="append", default=[], help="Risk line (repeatable).")
    p_req.add_argument("--output", action="append", default=[], help="Output path line (repeatable).")
    p_req.add_argument("--rollback", help="Rollback plan.")
    p_req.add_argument("--note", help="Ledger note.")
    p_req.add_argument("--force", action="store_true", help="Overwrite existing pending approval.")
    p_req.set_defaults(fn=cmd_request_approval)

    if not public_surface:
        p_app = sub.add_parser("approve", help="Approve a pending approval and resume running (canonical generic entrypoint is `autoresearch approve`).")
        p_app.add_argument("approval_id", help="Approval id, e.g. A1-0001")
        p_app.add_argument("--note", help="Ledger note.")
        p_app.set_defaults(fn=cmd_approve)

    p_rej = sub.add_parser("reject", help="Reject a pending approval and pause.")
    p_rej.add_argument("approval_id", help="Approval id, e.g. A1-0001")
    p_rej.add_argument("--note", help="Ledger note.")
    p_rej.set_defaults(fn=cmd_reject)

    p_approvals = sub.add_parser("approvals", help="Approval packet utilities (NEW-03).")
    approvals_sub = p_approvals.add_subparsers(dest="approvals_cmd", required=True)
    p_approvals_show = approvals_sub.add_parser("show", help="Show approval packets for a run.")
    p_approvals_show.add_argument("--run-id", required=True, help="Run id.")
    p_approvals_show.add_argument("--gate", help="Filter by gate prefix (e.g. A1, A3).")
    p_approvals_show.add_argument(
        "--format", choices=["short", "full", "json"], default="short",
        help="Output format (default: short).",
    )
    p_approvals_show.set_defaults(fn=cmd_approvals_show)

    p_report = sub.add_parser("report", help="Report utilities (NEW-04).")
    report_sub = p_report.add_subparsers(dest="report_cmd", required=True)
    p_report_render = report_sub.add_parser("render", help="Render a self-contained report from run results.")
    p_report_render.add_argument("--run-ids", required=True, help="Comma-separated run ids.")
    p_report_render.add_argument("--out", choices=["md", "tex"], default="md", help="Output format (default: md).")
    p_report_render.add_argument("--output-path", help="Write to file instead of stdout.")
    p_report_render.set_defaults(fn=cmd_report_render)

    run_help = (
        "Run a residual legacy workflow (non-computation only; use `autoresearch run --workflow-id computation` for computation)."
        if public_surface
        else "Run a workflow (v0.4+: computation + ingest + reproduce(toy) + paper_reviser + revision + literature_survey_polish + shell_adapter_smoke)."
    )
    p_run = sub.add_parser("run", help=run_help, description=run_help)
    p_run.add_argument("--run-id", required=True, help="Run tag, e.g. M1-r1")
    p_run.add_argument(
        "--workflow-id",
        required=True,
        choices=sorted(_public_run_workflow_ids() if public_surface else _all_run_workflow_ids()),
        help=_run_workflow_id_help(public_surface=public_surface),
    )
    p_run.add_argument("--note", help="Ledger note.")
    p_run.add_argument(
        "--kb-profile",
        default="minimal",
        choices=["minimal", "curated", "user"],
        help="KB profile selection for reviewer/LLM context (v0: writes artifacts/runs/<run-id>/kb_profile/...).",
    )
    p_run.add_argument(
        "--kb-profile-user-path",
        help="If --kb-profile=user, path to a kb_profile definition JSON (default: .autoresearch/kb_profile_user.json).",
    )
    p_run.add_argument("--force", action="store_true", help="Override state mismatch / rerun completed.")
    p_run.add_argument("--gate", choices=sorted(APPROVAL_CATEGORY_TO_POLICY_KEY.keys()), help="Force a gate (A1–A5) before running.")
    p_run.add_argument(
        "--run-card",
        help=(
            "Optional adapter run-card path for adapter workflows."
            if public_surface
            else "Workflow run-card path. For computation: required (run_card v2 JSON). For adapter workflows: optional (adapter run-card v1 JSON)."
        ),
    )
    p_run.add_argument(
        "--project-dir",
        help=argparse.SUPPRESS
        if public_surface
        else "computation: project directory (optional; inferred from <project_dir>/run_cards/<card>.json).",
    )
    p_run.add_argument(
        "--trust-project",
        action="store_true",
        help=argparse.SUPPRESS if public_surface else "computation: trust project to execute shell backends (non-interactive).",
    )
    p_run.add_argument(
        "--resume",
        action="store_true",
        help=argparse.SUPPRESS
        if public_surface
        else "computation: resume from artifacts/runs/<run-id>/computation (requires matching run-card).",
    )
    p_run.add_argument(
        "--param",
        action="append",
        default=[],
        help=argparse.SUPPRESS if public_surface else "computation: parameter override (repeatable: key=value).",
    )
    p_run.add_argument(
        "--sandbox",
        default="none",
        choices=["none", "auto", "local_copy", "docker"],
        help="Adapter workflows: sandbox execution provider (v0: local_copy fallback; docker requires a running daemon).",
    )
    p_run.add_argument(
        "--sandbox-network",
        default="disabled",
        choices=["disabled", "none", "host"],
        help="Sandbox network policy (docker only; default: disabled).",
    )
    p_run.add_argument(
        "--sandbox-docker-image",
        help="Sandbox docker image (docker provider; default: python:3.11-slim).",
    )
    p_run.add_argument(
        "--sandbox-repo-writable",
        action="store_true",
        help="Sandbox local_copy only: allow writes to the sandboxed repo copy (default: read-only; no effect for docker provider).",
    )
    w1 = p_run.add_mutually_exclusive_group(required=False)
    w1.add_argument("--inspire-recid", help="INSPIRE literature recid, e.g. 1234567")
    w1.add_argument("--arxiv-id", help="arXiv id, e.g. 2210.03629")
    w1.add_argument("--doi", help="DOI, e.g. 10.1103/PhysRevLett.116.061102")
    p_run.add_argument("--case", default="toy", help="reproduce case id (v0: toy).")
    p_run.add_argument("--ns", default="0,1,2,5,10", help="reproduce toy case n values (comma-separated).")
    p_run.add_argument("--epsabs", type=float, default=1e-12, help="reproduce toy: scipy.integrate.quad epsabs.")
    p_run.add_argument("--epsrel", type=float, default=1e-12, help="reproduce toy: scipy.integrate.quad epsrel.")
    p_run.add_argument("--mpmath-dps", type=int, default=80, help="reproduce toy: mpmath precision (decimal digits).")
    p_run.add_argument("--refkey", help="Optional RefKey (defaults to a stable derived key)")
    p_run.add_argument(
        "--download",
        default="auto",
        choices=["none", "auto", "arxiv_source", "arxiv_pdf", "both"],
        help="Download policy for arXiv assets (if available).",
    )
    p_run.add_argument("--paper-root", default="paper", help="revision: LaTeX project root (default: paper).")
    p_run.add_argument("--tex-main", default="main.tex", help="revision: main TeX file within paper-root.")
    p_run.add_argument("--draft-tex", help="paper_reviser: input draft .tex path (default: <paper-root>/<tex-main>).")
    p_run.add_argument(
        "--paper-reviser-mode",
        default="run-models",
        choices=["run-models", "stub-models", "dry-run"],
        help="paper_reviser: paper-reviser execution mode (default: run-models).",
    )
    p_run.add_argument("--writer-backend", choices=["claude", "gemini"], help="paper_reviser: writer backend (required).")
    p_run.add_argument("--writer-model", help="paper_reviser: writer model/alias (required; non-empty).")
    p_run.add_argument("--auditor-backend", choices=["claude", "gemini"], help="paper_reviser: auditor backend (required).")
    p_run.add_argument("--auditor-model", help="paper_reviser: auditor model/alias (required; non-empty).")
    p_run.add_argument(
        "--paper-reviser-max-rounds-rev1",
        type=int,
        default=1,
        help="paper_reviser: paper-reviser --max-rounds for round_01 (default: 1).",
    )
    p_run.add_argument(
        "--paper-reviser-no-codex-verify",
        action="store_true",
        help="paper_reviser: pass --no-codex-verify to paper-reviser.",
    )
    p_run.add_argument(
        "--paper-reviser-min-clean-size-ratio",
        type=float,
        help="paper_reviser: pass --min-clean-size-ratio to paper-reviser (must be in (0, 1]).",
    )
    p_run.add_argument(
        "--paper-reviser-codex-model",
        help="paper_reviser: pass --codex-model to paper-reviser.",
    )
    p_run.add_argument(
        "--paper-reviser-codex-config",
        action="append",
        default=[],
        help="paper_reviser: repeatable --codex-config key=value passthrough.",
    )
    p_run.add_argument(
        "--paper-reviser-fallback-auditor",
        choices=["off", "claude"],
        help="paper_reviser: pass --fallback-auditor to paper-reviser.",
    )
    p_run.add_argument(
        "--paper-reviser-fallback-auditor-model",
        help="paper_reviser: pass --fallback-auditor-model to paper-reviser.",
    )
    p_run.add_argument(
        "--paper-reviser-secondary-deep-verify-backend",
        choices=["off", "claude", "gemini"],
        help="paper_reviser: pass --secondary-deep-verify-backend to paper-reviser.",
    )
    p_run.add_argument(
        "--paper-reviser-secondary-deep-verify-model",
        help="paper_reviser: pass --secondary-deep-verify-model to paper-reviser.",
    )
    p_run.add_argument(
        "--manual-evidence",
        action="store_true",
        help="paper_reviser: stop after retrieval; require manual evidence/<VR-ID>.md before round_02.",
    )
    p_run.add_argument(
        "--evidence-synth-backend",
        choices=["stub", "claude", "gemini"],
        help="paper_reviser: evidence synthesis backend (required unless --manual-evidence).",
    )
    p_run.add_argument(
        "--evidence-synth-model",
        help="paper_reviser: evidence synthesis model/alias (required unless --manual-evidence).",
    )
    p_run.add_argument(
        "--verification-plan",
        help="paper_reviser: explicit verification_plan.json path (copied into SSOT under artifacts/runs/<run-id>/paper_reviser/verification/).",
    )
    p_run.add_argument(
        "--apply-to-draft",
        action="store_true",
        help="paper_reviser: apply final clean.tex back to the draft .tex (A4-gated if required by approval_policy).",
    )
    p_run.add_argument("--skills-dir", help="paper_reviser: override $CODEX_HOME/skills for tool discovery.")
    p_run.add_argument("--survey-topic", help="literature_survey_polish: optional topic header for the T30 survey export.")
    p_run.add_argument(
        "--survey-refkeys",
        help="literature_survey_polish: comma-separated RefKey list for the T30 survey export (default: curated KB profile literature notes).",
    )
    p_run.add_argument(
        "--survey-no-compile",
        action="store_true",
        help="literature_survey_polish: do not attempt latexmk compile in research-writer consume (still runs hygiene).",
    )
    p_run.add_argument("--no-apply-provenance-table", action="store_true", help="revision: do not edit paper; compile only.")
    p_run.add_argument("--no-compile-before", action="store_true", help="revision: skip compile before edits.")
    p_run.add_argument("--no-compile-after", action="store_true", help="revision: skip compile after edits.")
    p_run.add_argument("--latexmk-timeout-seconds", type=int, default=300, help="revision: timeout per latexmk invocation.")
    p_run.add_argument("--overwrite-note", action="store_true", help="Overwrite existing knowledge_base note.")
    p_run.add_argument("--no-query-log", action="store_true", help="Do not append to literature_queries.md")
    p_run.add_argument("--allow-errors", action="store_true", help="Treat workflow errors list as non-fatal.")
    p_run.add_argument(
        "--strict-gate-resolution",
        action="store_true",
        help="Adapter workflows: treat unsafe approval-resolution combinations as hard errors (e.g. run_card_only + empty required_approvals).",
    )
    p_run.set_defaults(fn=cmd_run)

    p_logs = sub.add_parser("logs", help="Show recent ledger events.")
    p_logs.add_argument("--run-id", help="Filter by run id (default: current).")
    p_logs.add_argument("--tail", type=int, default=25, help="Number of events to show.")
    p_logs.set_defaults(fn=cmd_logs)

    p_ctx = sub.add_parser("context", help="Write/update the per-run context pack (context.md + context.json).")
    p_ctx.add_argument("--run-id", help="Run id to write context pack for (default: current).")
    p_ctx.add_argument("--workflow-id", help="Workflow id (optional; improves intent section).")
    p_ctx.add_argument("--refkey", help="Optional RefKey (for paper workflows).")
    p_ctx.add_argument("--note", help="Optional note to include in the context pack.")
    p_ctx.set_defaults(fn=cmd_context)

    if not public_surface:
        p_export = sub.add_parser("export", help="Export a run bundle (zip; canonical generic entrypoint is `autoresearch export`).")
        p_export.add_argument("--run-id", help="Run id to export (default: current).")
        p_export.add_argument("--out", help="Output zip path (default: exports/<run_id>.zip).")
        p_export.add_argument(
            "--include-kb-profile",
            action="store_true",
            help="Also bundle the KB files referenced by artifacts/runs/<run-id>/kb_profile/kb_profile.json (allowlist: knowledge_base/ only).",
        )
        p_export.set_defaults(fn=cmd_export)

    p_smoke = sub.add_parser("smoke-test", help="Import MCP bridge modules (no MCP server required).")
    p_smoke.set_defaults(fn=cmd_smoke_test)

    if not public_surface:
        p_doc = sub.add_parser("doctor", help="Check MCP server connectivity and required tool availability (Phase B6).")
        p_doc.add_argument("--mcp-config", help="Path to .mcp.json (default: <project_root>/.mcp.json).")
        p_doc.add_argument("--mcp-server", default="hep-research", help="MCP server name in .mcp.json (default: hep-research).")
        p_doc.add_argument("--hep-data-dir", help="Override HEP_DATA_DIR for the MCP server process (default: project-local .hep-mcp).")
        p_doc.add_argument(
            "--allow-missing-mcp-config",
            action="store_true",
            help="Do not fail when .mcp.json is missing; print warning/hints and return success.",
        )
        p_doc.add_argument(
            "--entrypoints-only",
            action="store_true",
            help="Run entrypoint discovery only (text mode); skip MCP config/server checks.",
        )
        p_doc.add_argument("--strict-entrypoints", action="store_true", help="Fail if the canonical `autoresearch` entrypoint is missing on PATH.")
        p_doc.add_argument(
            "--json",
            action="store_true",
            help="Emit JSON for entrypoint_discovery only (offline PATH diagnostics; skips MCP checks).",
        )
        p_doc.set_defaults(fn=cmd_doctor)

        p_bridge = sub.add_parser("bridge", help="Bridge a completed computation run into MCP evidence (Phase B4).")
        p_bridge.add_argument("--run-id", help="HEPAR run id (reads artifacts/runs/<run-id>/computation).")
        p_bridge.add_argument("--workspace", help="Explicit computation workspace dir (overrides --run-id).")
        p_bridge.add_argument("--mcp-project-name", default="hep-autoresearch", help="MCP project name to create/reuse.")
        p_bridge.add_argument("--mcp-config", help="Path to .mcp.json (default: <project_root>/.mcp.json).")
        p_bridge.add_argument("--mcp-server", default="hep-research", help="MCP server name in .mcp.json (default: hep-research).")
        p_bridge.add_argument("--hep-data-dir", help="Override HEP_DATA_DIR for the MCP server process (default: project-local .hep-mcp).")
        p_bridge.set_defaults(fn=cmd_bridge)

    if not public_surface:
        p_gap = sub.add_parser("literature-gap", help="Discover literature gaps via launcher-resolved literature workflow authority (Phase C1).")
        p_gap.add_argument("--tag", required=True, help="Run tag for output artifacts, e.g. M73-r1")
        p_gap.add_argument(
            "--phase",
            default="discover",
            choices=["discover", "analyze"],
            help="Phase of the C1 workflow (default: discover).",
        )
        p_gap.add_argument(
            "--topic",
            required=False,
            help="HEP topic string (required for --phase discover; optional for analyze if inferable from candidates.json).",
        )
        p_gap.add_argument("--focus", action="append", default=[], help="Optional focus keywords (repeatable).")
        p_gap.add_argument("--seed-recid", help="Optional INSPIRE seed recid (forces inclusion in the seed set).")
        p_gap.add_argument("--iterations", type=int, default=2, help="Reserved discover knob for launcher-resolved consumers (default: 2).")
        p_gap.add_argument("--max-papers", type=int, default=40, help="Reserved discover knob for launcher-resolved consumers (default: 40).")
        p_gap.add_argument("--prefer-journal", action="store_true", help="Reserved discover knob for launcher-resolved consumers.")
        p_gap.add_argument("--max-recids", type=int, default=12, help="Max seed recids extracted from discover candidates (default: 12).")
        p_gap.add_argument(
            "--seed-selection",
            help="Path to seed_selection.json (required for --phase analyze).",
        )
        p_gap.add_argument(
            "--candidates",
            help="Optional path to candidates.json for --phase analyze (default: artifacts/runs/<TAG>/literature_gap/discover/candidates.json).",
        )
        p_gap.add_argument(
            "--allow-external-seeds",
            action="store_true",
            help="Allow seed_selection recids that are not present in candidates.json (default: refuse).",
        )
        p_gap.add_argument(
            "--allow-external-inputs",
            action="store_true",
            help="Allow --seed-selection/--candidates paths outside the project root (default: refuse).",
        )
        p_gap.add_argument(
            "--topic-mode",
            default="timeline",
            choices=["timeline", "evolution", "emerging", "all"],
            help="INSPIRE topic analysis mode (default: timeline).",
        )
        p_gap.add_argument("--topic-limit", type=int, default=40, help="INSPIRE topic analysis limit (default: 40).")
        p_gap.add_argument("--topic-granularity", default="5year", help="INSPIRE topic analysis granularity (default: 5year).")
        p_gap.add_argument(
            "--critical-mode",
            default="analysis",
            choices=["analysis"],
            help="Legacy compatibility flag; analyze phase now always uses inspire_critical_analysis.",
        )
        p_gap.add_argument(
            "--network-mode",
            default="citation",
            choices=["citation", "collaboration"],
            help="INSPIRE network analysis mode (default: citation).",
        )
        p_gap.add_argument("--network-limit", type=int, default=80, help="INSPIRE network analysis limit (default: 80).")
        p_gap.add_argument("--network-depth", type=int, default=1, help="INSPIRE network analysis depth (default: 1).")
        p_gap.add_argument(
            "--network-direction",
            default="both",
            choices=["both", "in", "out"],
            help="INSPIRE network analysis direction (default: both).",
        )
        p_gap.add_argument("--mcp-config", help="Path to .mcp.json (default: <project_root>/.mcp.json).")
        p_gap.add_argument("--mcp-server", default="hep-research", help="MCP server name in .mcp.json (default: hep-research).")
        p_gap.add_argument("--hep-data-dir", help="Override HEP_DATA_DIR for the MCP server process (default: project-local .hep-mcp).")
        p_gap.set_defaults(fn=cmd_literature_gap)

    p_md = sub.add_parser("method-design", help="Generate a runnable computation project scaffold (Phase C2).")
    p_md.add_argument("--tag", required=True, help="Run tag for artifact output paths.")
    p_md.add_argument(
        "--template",
        default="minimal_ok",
        choices=["minimal_ok", "pdg_snapshot", "pdg_runtime", "spec_v1"],
        help="Scaffold template (default: minimal_ok).",
    )
    p_md.add_argument(
        "--project-id",
        required=False,
        help="Generated project_id (lowercase, underscores; used in project.json). Optional for template=spec_v1 (taken from spec unless overridden).",
    )
    p_md.add_argument("--spec", help="Path to method_spec v1 JSON (required for template=spec_v1).")
    p_md.add_argument("--title", help="Optional title override for generated project/run-card.")
    p_md.add_argument("--description", help="Optional description override for generated project.")
    p_md.add_argument(
        "--out-project-dir",
        help="Write the generated project into this directory (default: artifacts/runs/<TAG>/method_design/project).",
    )
    p_md.add_argument("--overwrite", action="store_true", help="Allow overwriting existing generated files.")

    # MCP options (used by templates that query PDG at design time).
    p_md.add_argument("--mcp-config", help="Path to MCP config JSON (default: .mcp.json).")
    p_md.add_argument("--mcp-server", default="hep-research", help="MCP server name in config (default: hep-research).")
    p_md.add_argument("--hep-data-dir", help="Override HEP_DATA_DIR for the MCP server process (default: project-local .hep-mcp).")

    # PDG knobs (template=pdg_snapshot or template=pdg_runtime).
    p_md.add_argument("--pdg-particle-name", help="Particle name for PDG query (template=pdg_snapshot|pdg_runtime).")
    p_md.add_argument(
        "--pdg-property",
        default="mass",
        choices=["mass", "width", "lifetime"],
        help="PDG property to snapshot (default: mass).",
    )
    p_md.add_argument("--pdg-no-derived", action="store_true", help="Disallow derived PDG values.")
    p_md.set_defaults(fn=cmd_method_design)

    p_prop = sub.add_parser("propose", help="Generate evolution proposals from a past run (evidence-first).")
    p_prop.add_argument("--tag", required=True, help="Run tag for proposal artifacts output.")
    p_prop.add_argument("--source-run-tag", required=True, help="Existing run tag to analyze.")
    p_prop.add_argument("--max-proposals", type=int, default=20, help="Max proposals to emit (default: 20).")
    p_prop.add_argument("--no-eval-failures", action="store_true", help="Do not include eval failures even if present.")
    p_prop.add_argument("--no-kb-trace", action="store_true", help="Do not write a KB methodology trace file.")
    p_prop.add_argument("--kb-trace-path", help="Override KB trace path (project-relative).")
    p_prop.set_defaults(fn=cmd_propose)

    p_skill = sub.add_parser("skill-propose", help="Generate deterministic skill proposal scaffolds from a past run (T38).")
    p_skill.add_argument("--tag", required=True, help="Run tag for output artifacts.")
    p_skill.add_argument("--source-run-tag", required=True, help="Existing run tag to analyze.")
    p_skill.add_argument("--max-proposals", type=int, default=5, help="Max proposals to emit (default: 5).")
    p_skill.set_defaults(fn=cmd_skill_propose)

    p_rc = sub.add_parser("run-card", help="Run-card utilities (computation run_card v2).")
    rc_sub = p_rc.add_subparsers(dest="run_card_cmd", required=True)

    p_rc_val = rc_sub.add_parser("validate", help="Validate a computation run-card v2 (strict).")
    p_rc_val.add_argument("--run-card", required=True, help="Path to run-card v2 JSON (absolute or project-relative).")
    p_rc_val.add_argument(
        "--project-dir",
        help="Project directory (optional; inferred from <project_dir>/run_cards/<card>.json).",
    )
    p_rc_val.add_argument("--run-id", help="Optional run-id override (like hepar run --run-id).")
    p_rc_val.add_argument("--param", action="append", default=[], help="Parameter override (repeatable: key=value).")
    p_rc_val.set_defaults(fn=cmd_run_card_validate)

    p_rc_rend = rc_sub.add_parser("render", help="Render a computation run-card v2 phase DAG (mermaid/dot/text).")
    p_rc_rend.add_argument("--run-card", required=True, help="Path to run-card v2 JSON (absolute or project-relative).")
    p_rc_rend.add_argument(
        "--project-dir",
        help="Project directory (optional; inferred from <project_dir>/run_cards/<card>.json).",
    )
    p_rc_rend.add_argument("--run-id", help="Optional run-id override (like hepar run --run-id).")
    p_rc_rend.add_argument("--param", action="append", default=[], help="Parameter override (repeatable: key=value).")
    p_rc_rend.add_argument("--format", default="mermaid", choices=["mermaid", "dot", "text"], help="Render format.")
    p_rc_rend.add_argument("--out", help="Write to this path (default: stdout).")
    p_rc_rend.set_defaults(fn=cmd_run_card_render)

    p_branch = sub.add_parser("branch", help="Record branching decisions in Plan SSOT (T39).")
    branch_sub = p_branch.add_subparsers(dest="branch_cmd", required=True)

    p_branch_list = branch_sub.add_parser("list", help="Show recorded branch decisions and candidates.")
    p_branch_list.set_defaults(fn=cmd_branch_list)

    p_branch_add = branch_sub.add_parser("add", help="Add a branch candidate under a decision (default: current step).")
    p_branch_add.add_argument(
        "--decision-id",
        help="Decision id (default: current step_id). Must be a stable token (no whitespace).",
    )
    p_branch_add.add_argument(
        "--decision-title",
        help="Human title for the decision (only used when creating a new decision).",
    )
    p_branch_add.add_argument(
        "--step-id",
        help="Plan step id this decision is attached to (default: current step_id). Must be a stable token (no whitespace).",
    )
    p_branch_add.add_argument("--branch-id", help="Branch id (default: auto b1,b2,...) (no whitespace).")
    p_branch_add.add_argument("--label", help="Short label for the branch (default: branch id).")
    p_branch_add.add_argument("--description", help="Branch description (required).")
    p_branch_add.add_argument(
        "--cap-override",
        type=int,
        help="Explicitly raise per-decision branch cap (default cap=5). Required when adding beyond cap.",
    )
    p_branch_add.add_argument(
        "--expected-approvals",
        help="Comma-separated expected approvals for this branch (A1..A5).",
    )
    p_branch_add.add_argument(
        "--expected-output",
        action="append",
        default=[],
        help="Expected output path (repeatable).",
    )
    p_branch_add.add_argument("--recovery-notes", help="Recovery notes for this branch candidate.")
    p_branch_add.add_argument("--activate", action="store_true", help="Also activate this branch immediately.")
    p_branch_add.set_defaults(fn=cmd_branch_add)

    p_branch_switch = branch_sub.add_parser("switch", help="Switch the active branch for a decision.")
    p_branch_switch.add_argument(
        "--decision-id",
        help="Decision id (default: current step_id). Must be a stable token (no whitespace).",
    )
    p_branch_switch.add_argument("--branch-id", required=True, help="Target branch id (no whitespace).")
    p_branch_switch.add_argument(
        "--previous-status",
        default="abandoned",
        choices=["abandoned", "failed", "completed"],
        help="Status to assign to the previous active branch (default: abandoned).",
    )
    p_branch_switch.add_argument("--note", help="Optional note for the ledger event.")
    p_branch_switch.set_defaults(fn=cmd_branch_switch)

    # -- migrate -----------------------------------------------------------
    p_migrate = sub.add_parser("migrate", help="Detect and upgrade old-version artifacts (M-20).")
    p_migrate.add_argument("--registry", help="Path to migration_registry_v1.json (auto-detected if omitted).")
    p_migrate.add_argument("--dry-run", action="store_true", help="Show what would be migrated without writing.")
    p_migrate.set_defaults(fn=cmd_migrate_wrapper)

    args = parser.parse_args(argv)

    # trace-jsonl: configure structured JSONL logging for the orchestrator
    configure_logging("orchestrator")

    return int(args.fn(args))


def public_main(argv: list[str] | None = None) -> int:
    return main(argv, public_surface=True)


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:
        print(f"[error] {exc}", file=sys.stderr)
        raise SystemExit(1)
