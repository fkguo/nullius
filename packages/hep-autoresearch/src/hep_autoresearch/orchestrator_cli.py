from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import zipfile
from pathlib import Path

from .toolkit._time import utc_now_iso
from .toolkit._json import read_json, write_json
from .toolkit._paths import manifest_cwd
from .toolkit.artifact_report import write_artifact_report
from .toolkit.context_pack import ContextPackInputs, build_context_pack
from .toolkit.project_policy import PROJECT_POLICY_REAL_PROJECT, assert_project_root_allowed
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
from .toolkit.evolution_trigger import trigger_evolution_proposal
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
from .toolkit.workflow_context import workflow_context
from .toolkit.ingest import IngestInputs, ingest_one
from .toolkit.reproduce import ReproduceInputs, reproduce_one
from .toolkit.paper_reviser import PaperReviserInputs, paper_reviser_one
from .toolkit.revision import RevisionInputs, revise_one
from .toolkit.computation import ComputationInputs, computation_one
from .toolkit.run_card import ensure_run_card, normalize_approval_run_card_fields
from .toolkit.run_card_schema import load_run_card_v2, normalize_and_validate_run_card_v2
from .toolkit.logging_config import configure_logging


def _die(msg: str, code: int = 2) -> int:
    print(f"[error] {msg}")
    return code


PUBLIC_RUN_WORKFLOW_IDS: tuple[str, ...] = ()

INTERNAL_ONLY_RUN_WORKFLOW_IDS: tuple[str, ...] = (
    "ingest",
    "paper_reviser",
    "reproduce",
    "revision",
    "literature_survey_polish",
)


def _public_run_workflow_ids() -> set[str]:
    return set(PUBLIC_RUN_WORKFLOW_IDS)


def _internal_only_run_workflow_ids() -> set[str]:
    return set(INTERNAL_ONLY_RUN_WORKFLOW_IDS) | adapter_workflow_ids()


PUBLIC_SHELL_COMMANDS: tuple[str, ...] = (
    "run",
)

PUBLIC_SHELL_COMMANDS_MARKDOWN = ", ".join(f"`{command}`" for command in PUBLIC_SHELL_COMMANDS)


def _all_run_workflow_ids() -> set[str]:
    return {"computation"} | _public_run_workflow_ids() | _internal_only_run_workflow_ids()


def _repo_checkout_root_from_source() -> Path | None:
    current = Path(__file__).resolve()
    for parent in current.parents:
        if (parent / "packages" / "orchestrator").is_dir() and (parent / "package.json").is_file():
            return parent
    return None


def _resolve_autoresearch_launcher() -> list[str] | None:
    resolved = shutil.which("autoresearch")
    if resolved:
        return [resolved]

    repo_root = _repo_checkout_root_from_source()
    node = shutil.which("node")
    if repo_root is not None and node:
        dist_cli = repo_root / "packages" / "orchestrator" / "dist" / "cli.js"
        if dist_cli.is_file():
            return [node, os.fspath(dist_cli)]

    pnpm = shutil.which("pnpm")
    if repo_root is not None and pnpm:
        src_cli = repo_root / "packages" / "orchestrator" / "src" / "cli.ts"
        if src_cli.is_file():
            return [pnpm, "--dir", os.fspath(repo_root), "exec", "tsx", os.fspath(src_cli)]
    return None


def _run_autoresearch_passthrough(*, repo_root: Path, argv: list[str]) -> int:
    launcher = _resolve_autoresearch_launcher()
    if launcher is None:
        return _die(
            "canonical `autoresearch` CLI is unavailable; install/build @autoresearch/orchestrator "
            "or put `autoresearch` on PATH"
        )

    cmd = [*launcher, "--project-root", os.fspath(repo_root), *[str(arg) for arg in argv]]
    cp = subprocess.run(
        cmd,
        cwd=os.fspath(repo_root),
        capture_output=True,
        text=True,
        check=False,
    )
    if cp.stdout:
        sys.stdout.write(cp.stdout)
    if cp.stderr:
        sys.stderr.write(cp.stderr)
    return int(cp.returncode)


def _run_workflow_id_help(*, public_surface: bool) -> str:
    if public_surface:
        public_workflow_ids = sorted(_public_run_workflow_ids())
        if public_workflow_ids:
            return "Workflow id for the remaining public compatibility workflow, e.g. " + "|".join(
                public_workflow_ids
            )
        return (
            "No installable public legacy run workflow ids remain. "
            "Use `autoresearch run --workflow-id ...`."
        )
    return "Workflow id, e.g. " + "|".join(sorted(_all_run_workflow_ids()))


def _assert_public_shell_inventory(subparsers: argparse._SubParsersAction[argparse.ArgumentParser]) -> None:
    # This parse-time check is the installable public-shell drift gate.
    actual = tuple(subparsers.choices.keys())
    if actual != PUBLIC_SHELL_COMMANDS:
        raise RuntimeError(
            "installable public shell inventory drifted: "
            f"expected {PUBLIC_SHELL_COMMANDS!r}, got {actual!r}"
        )


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
    # Keep the legacy wrapper fail-closed on repo-internal real-project roots
    # before the TS passthrough attempts any filesystem work.
    repo_root = assert_project_root_allowed(
        _repo_root_for_init(args),
        project_policy=PROJECT_POLICY_REAL_PROJECT,
    )
    forwarded = ["init"]
    if bool(getattr(args, "force", False)):
        forwarded.append("--force")
    if bool(getattr(args, "allow_nested", False)):
        forwarded.append("--allow-nested")
    if bool(getattr(args, "runtime_only", False)):
        forwarded.append("--runtime-only")
    if getattr(args, "checkpoint_interval_seconds", None) is not None:
        forwarded.extend(["--checkpoint-interval-seconds", str(int(args.checkpoint_interval_seconds))])
    return _run_autoresearch_passthrough(repo_root=repo_root, argv=forwarded)


# Internal-only maintainer surface: `start` is retired from the installable shell
# and has not been repointed onto the canonical TS lifecycle front door.
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
    forwarded = ["pause"]
    if getattr(args, "note", None):
        forwarded.extend(["--note", str(args.note)])
    return _run_autoresearch_passthrough(repo_root=repo_root, argv=forwarded)


def cmd_resume(args: argparse.Namespace) -> int:
    repo_root = _repo_root_from_args(args)
    forwarded = ["resume"]
    if getattr(args, "note", None):
        forwarded.extend(["--note", str(args.note)])
    if bool(getattr(args, "force", False)):
        forwarded.append("--force")
    return _run_autoresearch_passthrough(repo_root=repo_root, argv=forwarded)


# Internal-only maintainer surface: `checkpoint` is retired from the installable
# shell and still owns local mutation semantics pending TS parity.
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


# Internal-only maintainer surface: `request-approval` is retired from the
# installable shell and still materializes packets locally pending TS parity.
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


def _require_pending(st: dict, approval_id: str) -> dict | None:
    pending = st.get("pending_approval")
    if not pending:
        return None
    if pending.get("approval_id") != approval_id:
        return None
    return pending


def cmd_approve(args: argparse.Namespace) -> int:
    repo_root = _repo_root_from_args(args)
    forwarded = ["approve", str(args.approval_id)]
    if getattr(args, "note", None):
        forwarded.extend(["--note", str(args.note)])
    return _run_autoresearch_passthrough(repo_root=repo_root, argv=forwarded)


# Internal-only maintainer surface: `reject` is retired from the installable
# shell and still performs a direct local state mutation pending TS parity.
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
    allow_errors = bool(getattr(args, "allow_errors", False))
    if errors and not allow_errors:
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


def cmd_export(args: argparse.Namespace) -> int:
    repo_root = _repo_root_from_args(args)
    forwarded = ["export"]
    if getattr(args, "run_id", None):
        forwarded.extend(["--run-id", str(args.run_id)])
    if getattr(args, "out", None):
        forwarded.extend(["--out", str(args.out)])
    if bool(getattr(args, "include_kb_profile", False)):
        forwarded.append("--include-kb-profile")
    return _run_autoresearch_passthrough(repo_root=repo_root, argv=forwarded)


def main(argv: list[str] | None = None, *, public_surface: bool = False) -> int:
    description = (
        "Legacy Pipeline A CLI for residual provider-local workflow/support commands."
        if public_surface
        else "Orchestrator CLI v0.4 (provider-local workflows plus narrow lifecycle adapters)."
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

    if not public_surface:
        p_app = sub.add_parser("approve", help="Approve a pending approval and resume running (canonical generic entrypoint is `autoresearch approve`).")
        p_app.add_argument("approval_id", help="Approval id, e.g. A1-0001")
        p_app.add_argument("--note", help="Ledger note.")
        p_app.set_defaults(fn=cmd_approve)

    run_help = (
        "Public compatibility wrapper only; no installable public legacy run workflow ids remain. "
        "Use `autoresearch run --workflow-id ...` (for computation: `autoresearch run --workflow-id computation`)."
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
    if not public_surface:
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
            help="Workflow run-card path. For computation: required (run_card v2 JSON). For adapter workflows: optional (adapter run-card v1 JSON).",
        )
        p_run.add_argument(
            "--project-dir",
            help="computation: project directory (optional; inferred from <project_dir>/run_cards/<card>.json).",
        )
        p_run.add_argument(
            "--trust-project",
            action="store_true",
            help="computation: trust project to execute shell backends (non-interactive).",
        )
        p_run.add_argument(
            "--resume",
            action="store_true",
            help="computation: resume from artifacts/runs/<run-id>/computation (requires matching run-card).",
        )
        p_run.add_argument(
            "--param",
            action="append",
            default=[],
            help="computation: parameter override (repeatable: key=value).",
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
        p_run.add_argument(
            "--paper-root",
            default="paper",
            help="revision: LaTeX project root (default: paper).",
        )
        p_run.add_argument(
            "--tex-main",
            default="main.tex",
            help="revision: main TeX file within paper-root.",
        )
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

    if not public_surface:
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

    if public_surface:
        _assert_public_shell_inventory(sub)

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
