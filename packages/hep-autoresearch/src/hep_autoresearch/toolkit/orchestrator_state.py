from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any

from ._json import read_json
from ._time import utc_now_iso


AUTORESEARCH_DIRNAME = ".autoresearch"
STATE_FILENAME = "state.json"
LEDGER_FILENAME = "ledger.jsonl"
STATE_LOCK_FILENAME = "state.lock"
APPROVAL_POLICY_FILENAME = "approval_policy.json"
PLAN_MD_FILENAME = "plan.md"


APPROVAL_CATEGORY_TO_POLICY_KEY: dict[str, str] = {
    "A1": "mass_search",
    "A2": "code_changes",
    "A3": "compute_runs",
    "A4": "paper_edits",
    "A5": "final_conclusions",
}

def autoresearch_dir(repo_root: Path) -> Path:
    override = os.environ.get("HEP_AUTORESEARCH_DIR")
    if override:
        p = Path(override)
        if not p.is_absolute():
            p = repo_root / p
        return p
    return repo_root / AUTORESEARCH_DIRNAME


def state_path(repo_root: Path) -> Path:
    return autoresearch_dir(repo_root) / STATE_FILENAME


def plan_md_path(repo_root: Path) -> Path:
    return autoresearch_dir(repo_root) / PLAN_MD_FILENAME


def ledger_path(repo_root: Path) -> Path:
    return autoresearch_dir(repo_root) / LEDGER_FILENAME


def state_lock_path(repo_root: Path) -> Path:
    return autoresearch_dir(repo_root) / STATE_LOCK_FILENAME


def state_lock(repo_root: Path, *, timeout_seconds: float = 10.0, poll_seconds: float = 0.1):
    """Return a context manager that holds an advisory exclusive lock for state/ledger mutations.

    On POSIX, uses `fcntl.flock` on `.autoresearch/state.lock`. On platforms without `fcntl`,
    the lock is a no-op (single-process use only).
    """
    from contextlib import contextmanager

    @contextmanager
    def _cm():
        ensure_runtime_dirs(repo_root)
        lock_path = state_lock_path(repo_root)
        lock_path.parent.mkdir(parents=True, exist_ok=True)

        try:
            import errno
            import time

            import fcntl  # type: ignore
        except ImportError:
            with lock_path.open("a", encoding="utf-8"):
                yield
            return

        deadline = time.time() + max(float(timeout_seconds), 0.0)
        with lock_path.open("a", encoding="utf-8") as f:
            while True:
                try:
                    fcntl.flock(f.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
                    break
                except OSError as e:
                    if e.errno not in {errno.EACCES, errno.EAGAIN}:
                        raise
                    if time.time() >= deadline:
                        raise TimeoutError(f"timed out acquiring state lock: {lock_path}")
                    time.sleep(max(float(poll_seconds), 0.01))
            try:
                yield
            finally:
                try:
                    fcntl.flock(f.fileno(), fcntl.LOCK_UN)
                except Exception:  # CONTRACT-EXEMPT: CODE-01.5 best-effort lock release in finally
                    pass

    return _cm()


def approval_policy_path(repo_root: Path) -> Path:
    return autoresearch_dir(repo_root) / APPROVAL_POLICY_FILENAME


def _write_json_atomic(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    os.replace(tmp, path)


def ensure_runtime_dirs(repo_root: Path) -> None:
    autoresearch_dir(repo_root).mkdir(parents=True, exist_ok=True)
    ledger = ledger_path(repo_root)
    if not ledger.exists():
        ledger.write_text("", encoding="utf-8")


def default_state() -> dict[str, Any]:
    return {
        "schema_version": 1,
        "run_id": None,
        "workflow_id": None,
        "run_status": "idle",
        "current_step": None,
        "plan": None,
        "plan_md_path": None,
        "checkpoints": {"last_checkpoint_at": None, "checkpoint_interval_seconds": 900},
        "pending_approval": None,
        "approval_seq": {"A1": 0, "A2": 0, "A3": 0, "A4": 0, "A5": 0},
        "gate_satisfied": {},
        "approval_history": [],
        "artifacts": {},
        "notes": "",
    }


def _schema_type_ok(v: Any, schema_type: str) -> bool:
    if schema_type == "object":
        return isinstance(v, dict)
    if schema_type == "array":
        return isinstance(v, list)
    if schema_type == "string":
        return isinstance(v, str)
    if schema_type == "boolean":
        return isinstance(v, bool)
    if schema_type == "null":
        return v is None
    if schema_type == "integer":
        return isinstance(v, int) and not isinstance(v, bool)
    if schema_type == "number":
        return isinstance(v, (int, float)) and not isinstance(v, bool)
    return True


def _schema_resolve_ref(root_schema: dict[str, Any], ref: str) -> dict[str, Any] | None:
    if not ref.startswith("#/"):
        return None
    tokens = [t for t in ref.lstrip("#/").split("/") if t != ""]

    def unescape(p: str) -> str:
        return p.replace("~1", "/").replace("~0", "~")

    cur: Any = root_schema
    for t in (unescape(x) for x in tokens):
        if isinstance(cur, list):
            try:
                cur = cur[int(t)]
            except Exception:  # CONTRACT-EXEMPT: CODE-01.5 intentional fallback
                return None
            continue
        if isinstance(cur, dict):
            if t not in cur:
                return None
            cur = cur[t]
            continue
        return None
    return cur if isinstance(cur, dict) else None


def _schema_validate(payload: Any, schema: dict[str, Any], path: str, *, root_schema: dict[str, Any]) -> list[str]:
    """Minimal JSON-schema subset validator (deterministic, no third-party deps).

    Supported keywords: type, required, properties, items, enum, minimum, minLength, oneOf.
    """
    errors: list[str] = []

    if not isinstance(schema, dict):
        return errors

    if "$ref" in schema:
        ref = schema.get("$ref")
        if not isinstance(ref, str):
            return [f"{path}: $ref must be a string"]
        target = _schema_resolve_ref(root_schema, ref)
        if target is None:
            return [f"{path}: could not resolve $ref {ref!r}"]
        return _schema_validate(payload, target, path, root_schema=root_schema)

    if "oneOf" in schema:
        opts = schema.get("oneOf")
        if not isinstance(opts, list) or not opts:
            return [f"{path}: schema.oneOf must be a non-empty list"]
        best_errs: list[str] | None = None
        for opt in opts:
            if not isinstance(opt, dict):
                continue
            sub_errs = _schema_validate(payload, opt, path, root_schema=root_schema)
            if not sub_errs:
                return []
            if best_errs is None or len(sub_errs) < len(best_errs):
                best_errs = sub_errs
        errors.append(f"{path}: does not satisfy any schema in oneOf")
        if best_errs:
            errors.extend(best_errs[:5])
        return errors

    schema_type = schema.get("type")
    if isinstance(schema_type, str) and not _schema_type_ok(payload, schema_type):
        return [f"{path}: expected type {schema_type}, got {type(payload).__name__}"]

    if "enum" in schema and isinstance(schema.get("enum"), list):
        if payload not in schema["enum"]:
            errors.append(f"{path}: value {payload!r} not in enum")

    if isinstance(schema_type, str) and schema_type in {"integer", "number"} and "minimum" in schema:
        try:
            if float(payload) < float(schema["minimum"]):
                errors.append(f"{path}: value {payload} < minimum {schema['minimum']}")
        except Exception:
            errors.append(f"{path}: cannot compare minimum for value {payload!r}")

    if isinstance(schema_type, str) and schema_type == "string" and "minLength" in schema:
        try:
            if len(str(payload)) < int(schema["minLength"]):
                errors.append(f"{path}: string shorter than minLength {schema['minLength']}")
        except Exception:
            errors.append(f"{path}: cannot validate minLength for value {payload!r}")

    if isinstance(schema_type, str) and schema_type == "object":
        required = schema.get("required") or []
        if isinstance(required, list):
            for k in required:
                if not isinstance(k, str):
                    continue
                if not isinstance(payload, dict) or k not in payload:
                    errors.append(f"{path}: missing required field {k}")
        props = schema.get("properties") or {}
        if isinstance(props, dict) and isinstance(payload, dict):
            for k, subschema in props.items():
                if k not in payload:
                    continue
                if isinstance(subschema, dict):
                    errors.extend(_schema_validate(payload[k], subschema, f"{path}.{k}", root_schema=root_schema))
            if schema.get("additionalProperties") is False:
                allowed = set(props.keys())
                extra = set(payload.keys()) - allowed
                if extra:
                    errors.append(f"{path}: unexpected properties {sorted(extra)}")

    if isinstance(schema_type, str) and schema_type == "array" and "items" in schema:
        items = schema.get("items")
        if isinstance(items, dict) and isinstance(payload, list):
            for i, item in enumerate(payload[:200]):
                errors.extend(_schema_validate(item, items, f"{path}[{i}]", root_schema=root_schema))

    return errors


def validate_plan(repo_root: Path, *, plan: dict[str, Any]) -> None:
    schema_path = repo_root / "specs" / "plan.schema.json"
    if not schema_path.exists():
        raise FileNotFoundError(f"missing plan schema: {schema_path}")
    schema = read_json(schema_path)
    if not isinstance(schema, dict):
        raise ValueError("plan schema must be a JSON object")
    errs = _schema_validate(plan, schema, "plan", root_schema=schema)
    if errs:
        raise ValueError("plan schema validation failed:\n" + "\n".join(errs[:15]))

    branching = plan.get("branching")
    if branching is None:
        return
    if not isinstance(branching, dict):
        raise ValueError("plan.branching must be an object or null")

    step_ids = set()
    steps = plan.get("steps")
    if isinstance(steps, list):
        for s in steps:
            if not isinstance(s, dict):
                continue
            sid = str(s.get("step_id") or "").strip()
            if sid:
                step_ids.add(sid)

    decisions = branching.get("decisions")
    if not isinstance(decisions, list):
        return

    active_pairs: list[tuple[str, str]] = []
    seen_decision_ids: set[str] = set()
    for dec in decisions:
        if not isinstance(dec, dict):
            continue
        decision_id = str(dec.get("decision_id") or "").strip()
        if decision_id:
            if decision_id in seen_decision_ids:
                raise ValueError(f"duplicate branch_decision decision_id: {decision_id}")
            seen_decision_ids.add(decision_id)
        decision_step_id = str(dec.get("step_id") or "").strip()
        if decision_step_id and decision_step_id not in step_ids:
            raise ValueError(f"branch_decision {decision_id}: step_id {decision_step_id!r} not found in plan.steps")
        branches = dec.get("branches") if isinstance(dec.get("branches"), list) else []
        branches_dicts = [b for b in branches if isinstance(b, dict)]
        seen_branch_ids: set[str] = set()
        for br in branches_dicts:
            bid = str(br.get("branch_id") or "").strip()
            if not bid:
                continue
            if bid in seen_branch_ids:
                raise ValueError(f"branch_decision {decision_id}: duplicate branch_id: {bid}")
            seen_branch_ids.add(bid)

        # If decision.active_branch_id is set, it must point to an existing branch with status=active.
        active_dec = dec.get("active_branch_id")
        if active_dec is not None:
            s = str(active_dec).strip()
            if not s:
                raise ValueError(f"branch_decision {decision_id or '(missing)'}: active_branch_id must be non-empty or null")
            target = None
            for br in branches_dicts:
                if str(br.get("branch_id") or "").strip() == s:
                    target = br
                    break
            if target is None:
                raise ValueError(f"branch_decision {decision_id}: active_branch_id {s!r} not found in branches")
            if str(target.get("status") or "").strip() != "active":
                raise ValueError(f"branch_decision {decision_id}: active_branch_id {s!r} must have status 'active'")

        active_in_dec = [str(br.get("branch_id") or "").strip() for br in branches_dicts if str(br.get("status") or "").strip() == "active"]
        active_in_dec = [x for x in active_in_dec if x]
        if len(active_in_dec) > 1:
            raise ValueError(f"branch_decision {decision_id}: multiple active branches: {sorted(active_in_dec)}")
        if len(active_in_dec) == 1:
            bid = active_in_dec[0]
            if str(dec.get("active_branch_id") or "").strip() != bid:
                raise ValueError(
                    f"branch_decision {decision_id}: branch {bid!r} marked active but decision.active_branch_id is {dec.get('active_branch_id')!r}"
                )
            active_pairs.append((decision_id, bid))

    active_global = branching.get("active_branch_id")
    if active_global is not None:
        s = str(active_global).strip()
        if not s:
            raise ValueError("plan.branching.active_branch_id must be non-empty or null")
        if s.count(":") != 1:
            raise ValueError("plan.branching.active_branch_id must be a composite '<decision_id>:<branch_id>'")
        did, bid = (p.strip() for p in s.split(":", 1))
        if not did or not bid:
            raise ValueError("plan.branching.active_branch_id must be a composite '<decision_id>:<branch_id>'")
        if not active_pairs:
            raise ValueError(
                "plan.branching.active_branch_id is set but no branch candidate has status 'active' (decision.active_branch_id mismatch)"
            )
        if (did, bid) not in active_pairs:
            raise ValueError(
                f"plan.branching.active_branch_id {s!r} points to a branch that is not active in its decision"
            )


def get_active_branch_id(state: dict[str, Any]) -> str | None:
    """Return the composite active_branch_id ('decision_id:branch_id') from Plan SSOT, if present."""
    plan = state.get("plan") if isinstance(state.get("plan"), dict) else None
    branching = plan.get("branching") if isinstance(plan, dict) else None
    if not isinstance(branching, dict):
        return None
    active = branching.get("active_branch_id")
    if active is None:
        return None
    s = str(active).strip()
    if not s:
        return None
    if s.count(":") != 1:
        return None
    return s


def render_plan_md(plan: dict[str, Any]) -> str:
    steps = plan.get("steps") if isinstance(plan, dict) else None
    if not isinstance(steps, list):
        steps = []

    branching = plan.get("branching") if isinstance(plan, dict) else None

    run_id = plan.get("run_id") if isinstance(plan, dict) else None
    workflow_id = plan.get("workflow_id") if isinstance(plan, dict) else None
    updated_at = plan.get("updated_at") if isinstance(plan, dict) else None

    lines: list[str] = []
    lines.append("# Plan (derived view)")
    lines.append("")
    lines.append(f"- Run: {run_id or '(unknown)'}")
    lines.append(f"- Workflow: {workflow_id or '(unknown)'}")
    if updated_at:
        lines.append(f"- Updated: {updated_at}")
    lines.append("")
    lines.append("SSOT: `.autoresearch/state.json#/plan`")
    lines.append("")
    lines.append("## Steps")
    lines.append("")
    for idx, step in enumerate(steps, start=1):
        if not isinstance(step, dict):
            continue
        step_id = str(step.get("step_id") or "").strip()
        desc = str(step.get("description") or "").strip()
        status = str(step.get("status") or "").strip()
        approvals = step.get("expected_approvals") or []
        if not isinstance(approvals, list):
            approvals = []
        approvals_s = ", ".join(str(a) for a in approvals if a) or "-"
        lines.append(f"{idx}. [{status or 'pending'}] {step_id} — {desc}")
        lines.append(f"   - expected_approvals: {approvals_s}")
        outs = step.get("expected_outputs") or []
        if isinstance(outs, list) and outs:
            lines.append("   - expected_outputs:")
            for o in outs:
                if o:
                    lines.append(f"     - {o}")
        rec = str(step.get("recovery_notes") or "").strip()
        if rec:
            lines.append(f"   - recovery_notes: {rec}")

    if isinstance(branching, dict):
        lines.append("")
        lines.append("## Branching")
        lines.append("")
        active = str(branching.get("active_branch_id") or "").strip() or "-"
        max_per = branching.get("max_branches_per_decision")
        max_per_s = str(max_per) if max_per is not None else "-"
        lines.append(f"- active_branch_id: {active}")
        lines.append(f"- max_branches_per_decision: {max_per_s}")

        decisions = branching.get("decisions")
        if isinstance(decisions, list) and decisions:
            lines.append("")
            lines.append("### Decisions")
            lines.append("")
            for didx, dec in enumerate(decisions, start=1):
                if not isinstance(dec, dict):
                    continue
                decision_id = str(dec.get("decision_id") or "").strip() or "DECISION"
                title = str(dec.get("title") or "").strip() or "(missing title)"
                step_id = str(dec.get("step_id") or "").strip() or "-"
                lines.append(f"{didx}. {decision_id} — {title}")
                lines.append(f"   - step_id: {step_id}")
                lines.append(f"   - max_branches: {dec.get('max_branches')}")
                if dec.get("cap_override") is not None:
                    lines.append(f"   - cap_override: {dec.get('cap_override')}")
                active_branch = str(dec.get("active_branch_id") or "").strip() or "-"
                lines.append(f"   - active_branch_id: {active_branch}")
                branches = dec.get("branches")
                if isinstance(branches, list) and branches:
                    lines.append("   - branches:")
                    for br in branches:
                        if not isinstance(br, dict):
                            continue
                        bid = str(br.get("branch_id") or "").strip() or "BRANCH"
                        label = str(br.get("label") or "").strip() or bid
                        status = str(br.get("status") or "").strip() or "candidate"
                        desc = str(br.get("description") or "").strip() or "(missing description)"
                        lines.append(f"     - [{status}] {bid} — {label}: {desc}")
    lines.append("")
    return "\n".join(lines)


def write_plan_md(repo_root: Path, *, plan: dict[str, Any]) -> str:
    validate_plan(repo_root, plan=plan)
    ensure_runtime_dirs(repo_root)
    p = plan_md_path(repo_root)
    tmp = p.with_suffix(p.suffix + ".tmp")
    tmp.write_text(render_plan_md(plan), encoding="utf-8")
    try:
        os.replace(tmp, p)
    except Exception:  # CONTRACT-EXEMPT: CODE-01.5 cleanup before re-raise
        try:
            tmp.unlink()
        except Exception:  # CONTRACT-EXEMPT: CODE-01.5 best-effort cleanup
            pass
        raise
    try:
        return os.fspath(p.relative_to(repo_root))
    except Exception:  # CONTRACT-EXEMPT: CODE-01.5 diagnostic fallthrough
        return os.fspath(p)


def load_state(repo_root: Path) -> dict[str, Any] | None:
    p = state_path(repo_root)
    if not p.exists():
        return None
    st = read_json(p)
    if not isinstance(st, dict):
        return None
    return st


def save_state(repo_root: Path, state: dict[str, Any]) -> None:
    plan = state.get("plan")
    if isinstance(plan, dict):
        validate_plan(repo_root, plan=plan)
        try:
            state["plan_md_path"] = os.fspath(plan_md_path(repo_root).relative_to(repo_root))
        except Exception:  # CONTRACT-EXEMPT: CODE-01.5 diagnostic fallthrough
            state["plan_md_path"] = os.fspath(plan_md_path(repo_root))
    _write_json_atomic(state_path(repo_root), state)
    if isinstance(plan, dict):
        # Derive after state is safely persisted (SSOT-first).
        write_plan_md(repo_root, plan=plan)


def persist_state_with_ledger_event(
    repo_root: Path,
    *,
    state: dict[str, Any],
    event_type: str,
    run_id: str | None,
    workflow_id: str | None,
    step_id: str | None = None,
    details: dict[str, Any] | None = None,
) -> None:
    """Transaction-ish persistence for workflows that need ledger+state ordering guarantees.

    IMPORTANT: caller MUST hold `state_lock(repo_root)` before calling this function.

    Algorithm:
    1) Validate plan (incl. cross-field branching invariants).
    2) Stage the updated state to `.autoresearch/state.json.next` (atomic write).
    3) Append the ledger event.
    4) Atomically replace `.autoresearch/state.json` with the staged file.
    5) Derive `plan.md`.

    If the ledger append fails, the staged state is removed (best-effort) and state.json is unchanged.
    If the final replace fails after ledger write, the staged file is left on disk for manual recovery.
    """
    _persist_state_with_ledger_event_locked(
        repo_root,
        state=state,
        event_type=event_type,
        run_id=run_id,
        workflow_id=workflow_id,
        step_id=step_id,
        details=details,
    )


def _persist_state_with_ledger_event_locked(
    repo_root: Path,
    *,
    state: dict[str, Any],
    event_type: str,
    run_id: str | None,
    workflow_id: str | None,
    step_id: str | None = None,
    details: dict[str, Any] | None = None,
) -> None:
    plan = state.get("plan")
    if isinstance(plan, dict):
        validate_plan(repo_root, plan=plan)
        try:
            state["plan_md_path"] = os.fspath(plan_md_path(repo_root).relative_to(repo_root))
        except Exception:  # CONTRACT-EXEMPT: CODE-01.5 diagnostic fallthrough
            state["plan_md_path"] = os.fspath(plan_md_path(repo_root))

    ensure_runtime_dirs(repo_root)

    final_state = state_path(repo_root)
    staged = final_state.with_suffix(final_state.suffix + ".next")
    _write_json_atomic(staged, state)
    try:
        append_ledger_event(
            repo_root,
            event_type=event_type,
            run_id=run_id,
            workflow_id=workflow_id,
            step_id=step_id,
            details=details,
        )
    except Exception:  # CONTRACT-EXEMPT: CODE-01.5 cleanup before re-raise
        try:
            staged.unlink()
        except Exception:  # CONTRACT-EXEMPT: CODE-01.5 best-effort cleanup
            pass
        raise

    try:
        os.replace(staged, final_state)
    except Exception as e:
        raise RuntimeError(
            f"failed to commit state after ledger write; staged_state={staged}; error={e}"
        ) from e

    if isinstance(plan, dict):
        # Derive after state is safely persisted (SSOT-first).
        write_plan_md(repo_root, plan=plan)


def append_ledger_event(
    repo_root: Path,
    *,
    event_type: str,
    run_id: str | None,
    workflow_id: str | None,
    step_id: str | None = None,
    trace_id: str | None = None,
    details: dict[str, Any] | None = None,
) -> None:
    ensure_runtime_dirs(repo_root)
    event = {
        "ts": utc_now_iso().replace("+00:00", "Z"),
        "event_type": event_type,
        "run_id": run_id,
        "workflow_id": workflow_id,
        "step_id": step_id,
        **({"trace_id": trace_id} if trace_id else {}),
        "details": details or {},
    }
    ledger = ledger_path(repo_root)
    with ledger.open("a", encoding="utf-8") as f:
        f.write(json.dumps(event, sort_keys=True) + "\n")


def next_approval_id(state: dict[str, Any], category: str) -> str:
    seq = (state.get("approval_seq") or {}).get(category, 0)
    seq = int(seq) + 1
    state.setdefault("approval_seq", {})[category] = seq
    return f"{category}-{seq:04d}"


def read_approval_policy(repo_root: Path) -> dict[str, Any]:
    p = approval_policy_path(repo_root)
    if p.exists():
        return read_json(p)
    template = repo_root / "templates" / "approval_policy.safe.example.json"
    if template.exists():
        return read_json(template)
    # Fallback for new/empty directories (no templates/ yet).
    return {
        "schema_version": 1,
        "mode": "safe",
        "require_approval_for": {
            "mass_search": True,
            "code_changes": True,
            "compute_runs": True,
            "paper_edits": True,
            "final_conclusions": True,
        },
        "budgets": {"max_network_calls": 200, "max_runtime_minutes": 60},
        "timeouts": {
            "mass_search": {"timeout_seconds": 86400, "on_timeout": "block"},
            "code_changes": {"timeout_seconds": 172800, "on_timeout": "block"},
            "compute_runs": {"timeout_seconds": 172800, "on_timeout": "block"},
            "paper_edits": {"timeout_seconds": 604800, "on_timeout": "block"},
            "final_conclusions": {"timeout_seconds": 604800, "on_timeout": "block"},
        },
        "notes": "Default: human-in-the-loop at high-risk steps. Increase budgets or relax approvals only with explicit user consent.",
    }


def maybe_mark_needs_recovery(repo_root: Path, state: dict[str, Any]) -> bool:
    """Return True if state was mutated and saved."""
    if state.get("run_status") != "running":
        return False
    checkpoints = state.get("checkpoints") or {}
    last = checkpoints.get("last_checkpoint_at")
    interval = int(checkpoints.get("checkpoint_interval_seconds") or 0)
    if not last or interval <= 0:
        return False
    # Compare as strings only after parsing; keep it dependency-free by using fromisoformat.
    try:
        import datetime as dt

        last_dt = dt.datetime.fromisoformat(str(last).replace("Z", "+00:00"))
        now_dt = dt.datetime.now(dt.timezone.utc)
    except Exception:  # CONTRACT-EXEMPT: CODE-01.5 intentional fallback
        return False
    if (now_dt - last_dt).total_seconds() <= 2 * interval:
        return False

    state["run_status"] = "needs_recovery"
    state["notes"] = "checkpoint timeout: needs recovery decision (resume/pause/abort)"
    save_state(repo_root, state)
    append_ledger_event(
        repo_root,
        event_type="needs_recovery",
        run_id=state.get("run_id"),
        workflow_id=state.get("workflow_id"),
        step_id=(state.get("current_step") or {}).get("step_id") if isinstance(state.get("current_step"), dict) else None,
        details={"reason": "checkpoint_stale"},
    )
    return True


def check_approval_timeout(repo_root: Path, state: dict[str, Any]) -> str | None:
    """Check if the pending approval has timed out.

    Returns the ``on_timeout`` action string (``"block"``/``"reject"``/``"escalate"``)
    if the approval has timed out, or ``None`` if not timed out or no pending approval.
    Side-effects: on timeout, mutates *state*, persists to disk, and writes a ledger event.
    """
    pending = state.get("pending_approval")
    if not pending or not isinstance(pending, dict):
        return None
    timeout_at = pending.get("timeout_at")
    if not timeout_at:
        return None

    import datetime as dt

    try:
        deadline = dt.datetime.fromisoformat(str(timeout_at).replace("Z", "+00:00"))
        now = dt.datetime.now(dt.timezone.utc)
    except Exception:  # CONTRACT-EXEMPT: CODE-01.5 intentional fallback for malformed timestamp
        return None
    if now <= deadline:
        return None

    on_timeout = str(pending.get("on_timeout") or "block")
    approval_id = pending.get("approval_id", "")

    if on_timeout == "reject":
        state["pending_approval"] = None
        state["run_status"] = "rejected"
        state["notes"] = f"approval {approval_id} timed out — auto-rejected"
        state.setdefault("approval_history", []).append(
            {
                "ts": utc_now_iso().replace("+00:00", "Z"),
                "approval_id": approval_id,
                "category": pending.get("category"),
                "decision": "timeout_rejected",
                "note": f"auto-rejected: timed out at {timeout_at}",
            }
        )
    elif on_timeout == "escalate":
        state["run_status"] = "needs_recovery"
        state["notes"] = f"approval {approval_id} timed out — escalated"
    else:  # "block" (default)
        state["run_status"] = "blocked"
        state["notes"] = f"approval {approval_id} timed out — blocked"

    save_state(repo_root, state)
    append_ledger_event(
        repo_root,
        event_type="approval_timeout",
        run_id=state.get("run_id"),
        workflow_id=state.get("workflow_id"),
        step_id=(
            (state.get("current_step") or {}).get("step_id")
            if isinstance(state.get("current_step"), dict)
            else None
        ),
        details={
            "approval_id": approval_id,
            "policy_action": on_timeout,
            "timeout_at": timeout_at,
        },
    )
    return on_timeout


def check_approval_budget(
    repo_root: Path, state: dict[str, Any], *, max_approvals: int | None = None
) -> bool:
    """Check if the approval budget is exhausted.

    *max_approvals* is read from the approval policy ``budgets.max_approvals``
    when not supplied explicitly.

    Returns ``True`` if the budget is exhausted (and the state is updated on disk),
    ``False`` otherwise.
    """
    if max_approvals is None:
        policy = read_approval_policy(repo_root)
        budgets = policy.get("budgets") or {}
        raw = budgets.get("max_approvals")
        if raw is None:
            return False
        max_approvals = int(raw)

    if max_approvals <= 0:
        return False

    history = state.get("approval_history") or []
    granted = sum(1 for h in history if isinstance(h, dict) and h.get("decision") == "approved")

    if granted < max_approvals:
        return False

    state["run_status"] = "blocked"
    state["notes"] = f"approval budget exhausted ({granted}/{max_approvals})"
    if state.get("pending_approval"):
        state["pending_approval"] = None
    save_state(repo_root, state)
    append_ledger_event(
        repo_root,
        event_type="approval_budget_exhausted",
        run_id=state.get("run_id"),
        workflow_id=state.get("workflow_id"),
        step_id=(
            (state.get("current_step") or {}).get("step_id")
            if isinstance(state.get("current_step"), dict)
            else None
        ),
        details={"granted": granted, "max_approvals": max_approvals},
    )
    return True
