from __future__ import annotations

import os
import platform
import shutil
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Iterable

from ._git import try_get_git_metadata
from ._json import read_json, write_json
from ._paths import manifest_cwd
from ._time import utc_now_iso
from .artifact_report import write_artifact_report
from .paper_reviser_evidence import run_step_d_evidence_synthesis
from .paper_reviser_utils import (
    _diff_text,
    _fs_token,
    _load_json_if_exists,
    _paper_reviser_round_ok,
    _run_logged,
    _safe_rel,
    _sha256_file,
    _sha256_text,
    find_build_verification_plan_script,
    find_paper_reviser_edit_script,
)

@dataclass(frozen=True)
class PaperReviserInputs:
    tag: str
    draft_tex_path: str | None = None
    paper_root: str = "paper"
    tex_main: str = "main.tex"

    # Required: no model defaults at the hepar layer (even if stub mode is used).
    writer_backend: str = ""
    writer_model: str = ""
    auditor_backend: str = ""
    auditor_model: str = ""

    paper_reviser_mode: str = "run-models"  # run-models|stub-models|dry-run
    max_rounds_rev1: int = 1
    no_codex_verify: bool = False
    min_clean_size_ratio: float | None = None
    codex_model: str | None = None
    codex_config: list[str] = field(default_factory=list)
    fallback_auditor: str | None = None
    fallback_auditor_model: str | None = None
    secondary_deep_verify_backend: str | None = None
    secondary_deep_verify_model: str | None = None

    # Evidence synthesis (Step D)
    manual_evidence: bool = False
    evidence_synth_backend: str | None = None  # stub|claude|gemini (required if not manual_evidence)
    evidence_synth_model: str | None = None

    # Optional: provide an explicit verification_plan.json (copied into run_root/verification/).
    verification_plan_path: str | None = None

    # Optional: apply final clean.tex back to the original draft file (A4-gated by orchestrator).
    apply_to_draft: bool = False

    # Tool discovery overrides
    skills_dir: str | None = None

    # Logging / safety
    timeout_seconds_step_a: int = 3600
    timeout_seconds_step_e: int = 3600
    timeout_seconds_task: int = 1800
    timeout_seconds_evidence_synth: int = 1800


def _validate_inputs(inps: PaperReviserInputs) -> None:
    if not inps.tag or not str(inps.tag).strip():
        raise ValueError("tag is required")
    for k in ["writer_backend", "writer_model", "auditor_backend", "auditor_model"]:
        v = getattr(inps, k)
        if not isinstance(v, str) or not v.strip():
            raise ValueError(f"{k} is required (non-empty)")
    if str(inps.paper_reviser_mode) not in {"run-models", "stub-models", "dry-run"}:
        raise ValueError("paper_reviser_mode must be one of: run-models|stub-models|dry-run")
    if inps.min_clean_size_ratio is not None:
        try:
            ratio = float(inps.min_clean_size_ratio)
        except Exception as exc:
            raise ValueError("min_clean_size_ratio must be a float in (0, 1]") from exc
        if not (0.0 < ratio <= 1.0):
            raise ValueError(f"min_clean_size_ratio must be in (0, 1], got {ratio}")
    if inps.fallback_auditor is not None and str(inps.fallback_auditor).strip():
        if str(inps.fallback_auditor).strip() not in {"off", "claude"}:
            raise ValueError("fallback_auditor must be one of: off|claude")
    if inps.secondary_deep_verify_backend is not None and str(inps.secondary_deep_verify_backend).strip():
        bk = str(inps.secondary_deep_verify_backend).strip()
        if bk not in {"off", "claude", "gemini"}:
            raise ValueError("secondary_deep_verify_backend must be one of: off|claude|gemini")
        if bk != "off":
            if not (isinstance(inps.secondary_deep_verify_model, str) and inps.secondary_deep_verify_model.strip()):
                raise ValueError("secondary_deep_verify_model is required when secondary_deep_verify_backend != off")
    for cfg in list(inps.codex_config or []):
        if not isinstance(cfg, str) or not cfg.strip():
            raise ValueError("codex_config entries must be non-empty strings")
    if not bool(inps.manual_evidence):
        if not (isinstance(inps.evidence_synth_backend, str) and inps.evidence_synth_backend.strip()):
            raise ValueError("evidence_synth_backend is required unless manual_evidence=true")
        if not (isinstance(inps.evidence_synth_model, str) and inps.evidence_synth_model.strip()):
            raise ValueError("evidence_synth_model is required unless manual_evidence=true")


def _load_verification_plan(plan_path: Path) -> dict[str, Any]:
    obj = read_json(plan_path)
    if not isinstance(obj, dict) or int(obj.get("schema_version") or 0) != 1:
        raise ValueError("verification_plan.json schema invalid (expected schema_version=1 object)")
    tasks = obj.get("tasks")
    if tasks is not None and not isinstance(tasks, list):
        raise ValueError("verification_plan.json tasks must be a list")
    return obj


def _load_verification_requests(vr_path: Path) -> dict[str, Any]:
    obj = read_json(vr_path)
    if not isinstance(obj, dict) or int(obj.get("schema_version") or 0) != 1:
        raise ValueError("verification_requests.json schema invalid (expected schema_version=1 object)")
    items = obj.get("items")
    if not isinstance(items, list):
        raise ValueError("verification_requests.json items must be a list")
    return obj


def _iter_plan_tasks(plan_obj: dict[str, Any]) -> Iterable[dict[str, Any]]:
    tasks = plan_obj.get("tasks") or []
    if not isinstance(tasks, list):
        return []
    for t in tasks:
        if isinstance(t, dict):
            yield t


def _task_id(t: dict[str, Any]) -> str:
    return str(t.get("task_id") or "").strip() or "LF-UNKNOWN"


def _task_argv(t: dict[str, Any]) -> list[str]:
    argv = t.get("argv_resolved")
    if not isinstance(argv, list) or not argv or not all(isinstance(x, str) and x.strip() for x in argv):
        raise ValueError(f"task {t.get('task_id')!r}: argv_resolved must be a non-empty list of strings")
    return [str(x) for x in argv]


def _looks_like_literature_fetch_argv(argv: list[str]) -> bool:
    if len(argv) < 2:
        return False
    exe = Path(str(argv[0])).name.lower()
    if not exe.startswith("python"):
        return False
    script = str(argv[1])
    return script.endswith("literature_fetch.py")


def _argv_has_flag(argv: list[str], flag: str) -> bool:
    f = str(flag)
    for a in argv:
        s = str(a)
        if s == f:
            return True
        if s.startswith(f + "="):
            return True
    return False


def _argv_flag_values(argv: list[str], flag: str) -> list[str]:
    f = str(flag)
    vals: list[str] = []
    for i, a in enumerate(argv):
        s = str(a)
        if s == f and i + 1 < len(argv):
            vals.append(str(argv[i + 1]))
        elif s.startswith(f + "="):
            vals.append(s.split("=", 1)[1])
    return [v for v in vals if str(v).strip()]


def _validate_literature_fetch_task_evidence_first(
    *,
    argv: list[str],
    repo_root: Path,
    run_root: Path,
) -> list[str]:
    """
    Evidence-first safety check for research-team literature_fetch.py invocations.

    Hard constraint: any retrieval outputs must land under artifacts/runs/<RUN_ID>/paper_reviser/ (run_root).
    We enforce this by validating common output path flags, and by requiring explicit paths
    whenever the task would otherwise write to defaults (knowledge_base/ or references/).
    """
    errors: list[str] = []
    if not argv:
        return ["argv_resolved is empty"]
    if len(argv) < 3:
        # Expect: python <literature_fetch.py> <subcommand> ...
        return ["argv_resolved too short for a literature_fetch task"]

    subcmd = str(argv[2] or "").strip()
    wants_note = _argv_has_flag(argv, "--write-note")
    wants_trace = _argv_has_flag(argv, "--write-trace")
    no_trace = _argv_has_flag(argv, "--no-trace")

    kb_vals = _argv_flag_values(argv, "--kb-dir")
    trace_vals = _argv_flag_values(argv, "--trace-path")
    out_vals = _argv_flag_values(argv, "--out-dir")

    if wants_note and not kb_vals:
        errors.append("missing --kb-dir for --write-note (must point under run_root)")
    if wants_trace and not trace_vals:
        errors.append("missing --trace-path for --write-trace (must point under run_root)")
    # Most *-get commands append to the trace log by default (unless --no-trace is set).
    if subcmd.endswith("-get") and (not no_trace) and (not trace_vals):
        errors.append(f"missing --trace-path for {subcmd} (writes trace by default; add --no-trace or set --trace-path under run_root)")
    if subcmd == "arxiv-source" and not out_vals:
        errors.append("arxiv-source task must include --out-dir under run_root (evidence-first)")

    # Validate any explicit path flags that exist (even when write-* flags are absent).
    run_abs = run_root.expanduser().resolve()

    def _cwd_resolves_under_run_root(s: str) -> bool:
        p = Path(str(s)).expanduser()
        abs_p = p.resolve() if p.is_absolute() else (repo_root.expanduser().resolve() / p).resolve()
        try:
            abs_p.relative_to(run_abs)
            return True
        except Exception:  # CONTRACT-EXEMPT: CODE-01.5 deny-by-default path containment
            return False

    for v in kb_vals:
        if not _cwd_resolves_under_run_root(v):
            errors.append(f"--kb-dir points outside run_root: {v!r}")
    for v in trace_vals:
        if not _cwd_resolves_under_run_root(v):
            errors.append(f"--trace-path points outside run_root: {v!r}")
    for v in out_vals:
        if not _cwd_resolves_under_run_root(v):
            errors.append(f"--out-dir points outside run_root: {v!r}")

    return errors


def _collect_vr_ids(*, plan_obj: dict[str, Any] | None, verification_requests: dict[str, Any] | None) -> list[str]:
    vr_ids: set[str] = set()
    if isinstance(verification_requests, dict):
        items = verification_requests.get("items")
        if isinstance(items, list):
            for it in items:
                if not isinstance(it, dict):
                    continue
                vid = str(it.get("id") or "").strip()
                if vid:
                    vr_ids.add(vid)
    if isinstance(plan_obj, dict):
        for t in _iter_plan_tasks(plan_obj):
            vr = t.get("vr_ids")
            if isinstance(vr, list):
                for x in vr:
                    s = str(x).strip()
                    if s:
                        vr_ids.add(s)
    return sorted(vr_ids)


def paper_reviser_one(
    inps: PaperReviserInputs,
    repo_root: Path,
    *,
    gate_satisfied: dict[str, str] | None,
    approval_history: list[dict[str, Any]] | None,
    i_approve_paper_edits: bool,
    force: bool,
    command_argv: list[str] | None = None,
) -> dict[str, Any]:
    """
    paper_reviser: evidence-first, resumable A-E workflow around the external paper-reviser skill.

    Contract:
    - SSOT is under artifacts/runs/<TAG>/paper_reviser/
    - Step C is A1-gated (mass_search) via the orchestrator (this function reports blocked_by_gate).
    - Optional apply-to-draft is A4-gated (paper_edits) via the orchestrator.
    """
    _validate_inputs(inps)

    created_at = utc_now_iso().replace("+00:00", "Z")
    out_dir = repo_root / "artifacts" / "runs" / str(inps.tag) / "paper_reviser"
    out_dir.mkdir(parents=True, exist_ok=True)

    # Layout (SSOT within run_root).
    rev1_dir = out_dir / "round_01"
    rev2_dir = out_dir / "round_02"
    logs_dir = out_dir / "logs"
    ver_root = out_dir / "verification"
    ver_root.mkdir(parents=True, exist_ok=True)
    plan_path = ver_root / "verification_plan.json"
    task_state_dir = ver_root / "task_state"
    task_logs_dir = ver_root / "logs"
    evidence_state_dir = ver_root / "evidence_state"
    evidence_dir = ver_root / "evidence"
    kb_dir = ver_root / "kb" / "literature"
    trace_path = ver_root / "traces" / "literature_queries.md"
    arxiv_src_dir = ver_root / "arxiv_src"

    task_state_dir.mkdir(parents=True, exist_ok=True)
    task_logs_dir.mkdir(parents=True, exist_ok=True)
    evidence_state_dir.mkdir(parents=True, exist_ok=True)
    evidence_dir.mkdir(parents=True, exist_ok=True)
    kb_dir.mkdir(parents=True, exist_ok=True)
    trace_path.parent.mkdir(parents=True, exist_ok=True)
    arxiv_src_dir.mkdir(parents=True, exist_ok=True)

    errors: list[str] = []
    warnings: list[str] = []

    # Tool discovery.
    skills_dir = Path(inps.skills_dir).expanduser().resolve() if inps.skills_dir else None
    edit_script = find_paper_reviser_edit_script(skills_dir=skills_dir)
    build_plan_script = find_build_verification_plan_script(skills_dir=skills_dir)
    wf_module_path = Path(__file__).resolve()
    wf_evidence_path = Path(__file__).with_name("paper_reviser_evidence.py").resolve()
    wf_utils_path = Path(__file__).with_name("paper_reviser_utils.py").resolve()

    tools: list[dict[str, str]] = [
        {"path": str(edit_script), "sha256": _sha256_file(edit_script)},
        {"path": str(build_plan_script), "sha256": _sha256_file(build_plan_script)},
        {"path": str(wf_module_path), "sha256": _sha256_file(wf_module_path)},
    ]
    for p in [wf_evidence_path, wf_utils_path]:
        if p.is_file():
            tools.append({"path": str(p), "sha256": _sha256_file(p)})

    # Inputs.
    if inps.draft_tex_path:
        draft_path = Path(inps.draft_tex_path).expanduser()
        if not draft_path.is_absolute():
            draft_path = repo_root / draft_path
        draft_path = draft_path.resolve()
    else:
        draft_path = (repo_root / inps.paper_root / inps.tex_main).resolve()

    # Refuse to apply to an external path; keep the workflow repo-local by default.
    try:
        draft_path.relative_to(repo_root.resolve())
    except Exception:
        raise ValueError(f"draft_tex_path must be within repo_root (got {draft_path})")

    if not draft_path.is_file():
        raise FileNotFoundError(f"draft tex not found: {draft_path}")

    inputs: dict[str, Any] = {
        "draft_tex": {"path": _safe_rel(repo_root, draft_path), "sha256": _sha256_file(draft_path)},
    }

    # Pull run-card (if present) into inputs for easier traceability.
    run_card_path = repo_root / "artifacts" / "runs" / str(inps.tag) / "run_card.json"
    if run_card_path.exists():
        inputs["run_card_path"] = _safe_rel(repo_root, run_card_path)
        try:
            inputs["run_card_sha256"] = _sha256_file(run_card_path)
        except Exception:  # CONTRACT-EXEMPT: CODE-01.5 optional metadata enrichment
            pass

    gate_satisfied = gate_satisfied or {}
    approvals: list[dict[str, Any]] = []

    def approval_record(category: str) -> dict[str, Any] | None:
        aid = str(gate_satisfied.get(category) or "").strip()
        if not aid:
            return None
        rec: dict[str, Any] = {"category": category, "approval_id": aid}
        if isinstance(approval_history, list):
            for h in approval_history:
                if not isinstance(h, dict):
                    continue
                if h.get("approval_id") != aid or h.get("category") != category:
                    continue
                # Expected keys: ts/decision/note.
                rec["ts"] = h.get("ts")
                rec["decision"] = h.get("decision")
                rec["note"] = h.get("note")
                break
        return rec

    for cat in ["A1", "A4"]:
        r = approval_record(cat)
        if r:
            approvals.append(r)

    # Step status bookkeeping (written into manifest/analysis).
    steps: dict[str, Any] = {}
    blocked: dict[str, Any] | None = None
    needs_resume = False
    resume_state: dict[str, Any] | None = None

    # Step A: Revise (round_01)
    ok_a, run_a, errs_a = _paper_reviser_round_ok(rev1_dir)
    if ok_a:
        steps["A"] = {
            "status": "skipped",
            "round_dir": _safe_rel(repo_root, rev1_dir),
            "run_json": _safe_rel(repo_root, rev1_dir / "run.json"),
            "auditor_verdict": (run_a or {}).get("auditor_verdict"),
            "deep_verifier_verdict": (run_a or {}).get("deep_verifier_verdict"),
        }
    else:
        if rev1_dir.exists() and not force:
            steps["A"] = {
                "status": "needs_force",
                "round_dir": _safe_rel(repo_root, rev1_dir),
                "run_json": _safe_rel(repo_root, rev1_dir / "run.json") if (rev1_dir / "run.json").exists() else None,
                "note": "round_01 exists but is incomplete/failed; pass --force to overwrite",
                "errors": errs_a,
            }
            needs_resume = True
            resume_state = {"step": "A", "reason": "needs_force", "errors": errs_a[:5]}
        else:
            if rev1_dir.exists() and force:
                shutil.rmtree(rev1_dir, ignore_errors=True)
                # Clear downstream artifacts that depend on rev1_dir.
                if plan_path.exists():
                    plan_path.unlink()
                if rev2_dir.exists():
                    shutil.rmtree(rev2_dir, ignore_errors=True)
                # Clear Step C/D state to prevent stale skips when round_01 changes.
                for p in [
                    task_state_dir,
                    task_logs_dir,
                    evidence_state_dir,
                    evidence_dir,
                    kb_dir.parent,
                    trace_path.parent,
                    arxiv_src_dir,
                    ver_root / "evidence_raw",
                    ver_root / "evidence_prompts",
                ]:
                    if p.exists():
                        shutil.rmtree(p, ignore_errors=True)
                for p in [task_state_dir, task_logs_dir, evidence_state_dir, evidence_dir, kb_dir, trace_path.parent, arxiv_src_dir]:
                    p.mkdir(parents=True, exist_ok=True)
            _log_a = logs_dir / "step_A_round_01.log"
            cmd = [
                sys.executable,
                str(edit_script),
                "--in",
                str(draft_path),
                "--out-dir",
                str(rev1_dir),
                "--writer-backend",
                str(inps.writer_backend),
                "--writer-model",
                str(inps.writer_model),
                "--auditor-backend",
                str(inps.auditor_backend),
                "--auditor-model",
                str(inps.auditor_model),
                "--max-rounds",
                str(int(inps.max_rounds_rev1)),
            ]
            if inps.paper_reviser_mode == "stub-models":
                cmd.append("--stub-models")
            elif inps.paper_reviser_mode == "dry-run":
                cmd.append("--dry-run")
            else:
                cmd.append("--run-models")
            if inps.no_codex_verify:
                cmd.append("--no-codex-verify")
            if inps.min_clean_size_ratio is not None:
                cmd.extend(["--min-clean-size-ratio", str(float(inps.min_clean_size_ratio))])
            if isinstance(inps.codex_model, str) and inps.codex_model.strip():
                cmd.extend(["--codex-model", str(inps.codex_model).strip()])
            for cfg in list(inps.codex_config or []):
                cmd.extend(["--codex-config", str(cfg)])
            if isinstance(inps.fallback_auditor, str) and inps.fallback_auditor.strip():
                cmd.extend(["--fallback-auditor", str(inps.fallback_auditor).strip()])
            if isinstance(inps.fallback_auditor_model, str) and inps.fallback_auditor_model.strip():
                cmd.extend(["--fallback-auditor-model", str(inps.fallback_auditor_model).strip()])
            if isinstance(inps.secondary_deep_verify_backend, str) and inps.secondary_deep_verify_backend.strip():
                cmd.extend(["--secondary-deep-verify-backend", str(inps.secondary_deep_verify_backend).strip()])
            if isinstance(inps.secondary_deep_verify_model, str) and inps.secondary_deep_verify_model.strip():
                cmd.extend(["--secondary-deep-verify-model", str(inps.secondary_deep_verify_model).strip()])
            # paper-reviser refuses to write into an existing out_dir unless --force is passed.
            rc = _run_logged(cmd, cwd=repo_root, log_path=_log_a, timeout_seconds=int(inps.timeout_seconds_step_a))
            ok_a2, run_a2, errs_a2 = _paper_reviser_round_ok(rev1_dir)
            steps["A"] = {
                "status": "completed" if (rc == 0 and ok_a2) else "failed",
                "round_dir": _safe_rel(repo_root, rev1_dir),
                "run_json": _safe_rel(repo_root, rev1_dir / "run.json") if (rev1_dir / "run.json").exists() else None,
                "exit_code": int(rc),
                "log_path": _safe_rel(repo_root, _log_a),
                "log_sha256": _sha256_file(_log_a) if _log_a.exists() else None,
                "auditor_verdict": (run_a2 or {}).get("auditor_verdict") if isinstance(run_a2, dict) else None,
                "deep_verifier_verdict": (run_a2 or {}).get("deep_verifier_verdict") if isinstance(run_a2, dict) else None,
                "errors": errs_a2,
            }
            if rc != 0 or not ok_a2:
                needs_resume = True
                resume_state = {"step": "A", "reason": "paper_reviser_edit_failed"}

    # If Step A failed, fail-closed (but still write SSOT artifacts).
    if steps.get("A", {}).get("status") == "failed":
        errors.append("Step A failed (round_01 paper_reviser_edit)")

    # Step B: Build verification plan (or accept provided plan).
    verification_requests_path = rev1_dir / "verification_requests.json"
    plan_obj: dict[str, Any] | None = None
    upstream_ok = steps.get("A", {}).get("status") in {"completed", "skipped"}
    if not upstream_ok:
        steps["B"] = {"status": "pending", "note": "blocked upstream (Step A incomplete/failed)"}
    elif isinstance(inps.verification_plan_path, str) and inps.verification_plan_path.strip():
        src_plan = Path(inps.verification_plan_path).expanduser()
        if not src_plan.is_absolute():
            src_plan = repo_root / src_plan
        src_plan = src_plan.resolve()
        if not src_plan.is_file():
            raise FileNotFoundError(f"--verification-plan not found: {src_plan}")
        # Copy into SSOT location.
        plan_path.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(src_plan, plan_path)
        inputs["verification_plan_source"] = {"path": _safe_rel(repo_root, src_plan), "sha256": _sha256_file(src_plan)}
        inputs["verification_plan"] = {"path": _safe_rel(repo_root, plan_path), "sha256": _sha256_file(plan_path)}
        plan_obj = _load_verification_plan(plan_path)
        steps["B"] = {"status": "completed", "verification_plan_json": _safe_rel(repo_root, plan_path), "mode": "provided"}
    elif verification_requests_path.is_file():
        # Idempotent skip: if plan exists and claims the same input sha, keep it.
        vr_sha = _sha256_file(verification_requests_path)
        plan_existing = _load_json_if_exists(plan_path)
        plan_ok = False
        if isinstance(plan_existing, dict):
            try:
                if int(plan_existing.get("schema_version") or 0) == 1:
                    inputs_meta = plan_existing.get("inputs") or {}
                    vr_in = inputs_meta.get("verification_requests_json") if isinstance(inputs_meta, dict) else None
                    if isinstance(vr_in, dict) and str(vr_in.get("sha256") or "") == vr_sha:
                        plan_ok = True
            except Exception:  # CONTRACT-EXEMPT: CODE-01.5 intentional fallback
                plan_ok = False
        if plan_ok:
            plan_obj = _load_verification_plan(plan_path)
            steps["B"] = {"status": "skipped", "verification_plan_json": _safe_rel(repo_root, plan_path)}
        else:
            _log_b = logs_dir / "step_B_build_verification_plan.log"
            cmd_b = [
                sys.executable,
                str(build_plan_script),
                "--in",
                str(verification_requests_path),
                "--out",
                str(plan_path),
                "--kb-dir",
                _safe_rel(repo_root, kb_dir),
                "--trace-path",
                _safe_rel(repo_root, trace_path),
                "--arxiv-src-dir",
                _safe_rel(repo_root, arxiv_src_dir),
            ]
            if skills_dir:
                cmd_b.extend(["--skills-dir", str(skills_dir)])
            rc_b = _run_logged(cmd_b, cwd=repo_root, log_path=_log_b, timeout_seconds=300)
            steps["B"] = {
                "status": "completed" if rc_b == 0 else "failed",
                "verification_plan_json": _safe_rel(repo_root, plan_path) if plan_path.exists() else None,
                "exit_code": int(rc_b),
                "log_path": _safe_rel(repo_root, _log_b),
                "log_sha256": _sha256_file(_log_b) if _log_b.exists() else None,
            }
            if rc_b != 0 or not plan_path.exists():
                errors.append("Step B failed (build_verification_plan)")
                needs_resume = True
                resume_state = {"step": "B", "reason": "build_verification_plan_failed"}
            else:
                inputs["verification_plan"] = {"path": _safe_rel(repo_root, plan_path), "sha256": _sha256_file(plan_path)}
                plan_obj = _load_verification_plan(plan_path)
    else:
        steps["B"] = {"status": "skipped", "note": "no verification_requests.json; no plan built"}

    verification_requests_obj: dict[str, Any] | None = None
    if verification_requests_path.exists():
        try:
            verification_requests_obj = _load_verification_requests(verification_requests_path)
        except Exception as exc:
            errors.append(f"verification_requests.json invalid: {exc}")
            needs_resume = True
            resume_state = {"step": "B", "reason": "invalid_verification_requests"}
    vr_ids = _collect_vr_ids(plan_obj=plan_obj, verification_requests=verification_requests_obj)

    # Step C: A1-gated retrieval tasks (execute only when gate satisfied).
    tasks_completed = 0
    tasks_skipped = 0
    tasks_failed: list[str] = []
    executed_tasks: list[dict[str, Any]] = []

    if upstream_ok and plan_obj and list(_iter_plan_tasks(plan_obj)):
        # Hard requirement: Step C always uses A1 approval gate (mass_search) when tasks exist.
        if not str(gate_satisfied.get("A1") or "").strip():
            planned_tasks: list[dict[str, Any]] = []
            invalid_tasks: list[dict[str, Any]] = []
            for t in _iter_plan_tasks(plan_obj):
                tid = _task_id(t)
                tool = str(t.get("tool") or "")
                rec: dict[str, Any] = {
                    "task_id": tid,
                    "tool": tool,
                    "cmd": str(t.get("cmd") or ""),
                    "vr_ids": t.get("vr_ids") if isinstance(t.get("vr_ids"), list) else [],
                    "argv_resolved": [],
                }
                try:
                    argv = _task_argv(t)
                    rec["argv_resolved"] = argv
                except Exception as exc:
                    rec["error"] = str(exc)
                    planned_tasks.append(rec)
                    invalid_tasks.append(rec)
                    continue

                # Evidence-first safety: Step C is retrieval-only; fail closed on unexpected tools/argv.
                if tool != "research-team.literature_fetch":
                    rec["error"] = f"unsupported tool (expected research-team.literature_fetch): {tool!r}"
                    invalid_tasks.append(rec)
                elif not _looks_like_literature_fetch_argv(argv):
                    rec["error"] = "argv_resolved does not look like a literature_fetch.py invocation"
                    invalid_tasks.append(rec)
                else:
                    out_errs = _validate_literature_fetch_task_evidence_first(
                        argv=argv, repo_root=repo_root, run_root=out_dir
                    )
                    if out_errs:
                        rec["error"] = out_errs[0]
                        rec["errors"] = out_errs[:20]
                        invalid_tasks.append(rec)
                planned_tasks.append(rec)

            if invalid_tasks:
                steps["C"] = {
                    "status": "failed",
                    "reason": "invalid_task_plan",
                    "invalid_task_ids": [str(t.get("task_id") or "") for t in invalid_tasks if str(t.get("task_id") or "").strip()],
                    "tasks": planned_tasks,
                    "verification_plan_json": _safe_rel(repo_root, plan_path),
                }
                errors.append(
                    f"Step C plan invalid: {len(invalid_tasks)} task(s) have invalid argv/tool; fix verification_plan.json before requesting A1 approval"
                )
                needs_resume = True
                resume_state = {"step": "C", "reason": "invalid_task_plan"}
            else:
                blocked = {
                    "missing_gates": ["A1"],
                    "phase_id": "C",
                    "reason": "literature_fetch_tasks_require_approval",
                    "task_count": len(planned_tasks),
                    "tasks": planned_tasks,
                    "verification_plan_json": _safe_rel(repo_root, plan_path),
                }
                steps["C"] = {"status": "blocked_by_gate", "blocked": blocked}
        else:
            for t in _iter_plan_tasks(plan_obj):
                tid = _task_id(t)
                tid_fs = _fs_token(tid, kind="TASK")
                tool = str(t.get("tool") or "")
                st_path = task_state_dir / f"{tid_fs}.json"
                log_path = task_logs_dir / f"{tid_fs}.log"
                try:
                    argv = _task_argv(t)
                except Exception as exc:
                    started_at = utc_now_iso().replace("+00:00", "Z")
                    ended_at = utc_now_iso().replace("+00:00", "Z")
                    state_obj: dict[str, Any] = {
                        "schema_version": 1,
                        "task_id": tid,
                        "task_file_id": tid_fs,
                        "tool": tool,
                        "cmd": str(t.get("cmd") or ""),
                        "vr_ids": t.get("vr_ids") if isinstance(t.get("vr_ids"), list) else [],
                        "argv_resolved": [],
                        "started_at": started_at,
                        "ended_at": ended_at,
                        "exit_code": 2,
                        "log_path": None,
                        "log_sha256": None,
                        "error": str(exc),
                        "meta": t.get("meta") if isinstance(t.get("meta"), dict) else {},
                    }
                    write_json(st_path, state_obj)
                    executed_tasks.append(
                        {
                            "task_id": tid,
                            "task_file_id": tid_fs,
                            "vr_ids": state_obj.get("vr_ids") or [],
                            "argv_resolved": [],
                            "exit_code": 2,
                            "log_path": None,
                            "log_sha256": None,
                            "status": "failed",
                            "error": str(exc),
                        }
                    )
                    tasks_failed.append(tid)
                    needs_resume = True
                    resume_state = {"step": "C", "reason": "invalid_task_argv", "task_id": tid}
                    break
                if tool != "research-team.literature_fetch":
                    state_obj = {
                        "schema_version": 1,
                        "task_id": tid,
                        "task_file_id": tid_fs,
                        "tool": tool,
                        "cmd": str(t.get("cmd") or ""),
                        "vr_ids": t.get("vr_ids") if isinstance(t.get("vr_ids"), list) else [],
                        "argv_resolved": argv,
                        "started_at": utc_now_iso().replace("+00:00", "Z"),
                        "ended_at": utc_now_iso().replace("+00:00", "Z"),
                        "exit_code": 2,
                        "log_path": None,
                        "log_sha256": None,
                        "error": f"unsupported tool (expected research-team.literature_fetch): {tool!r}",
                        "meta": t.get("meta") if isinstance(t.get("meta"), dict) else {},
                    }
                    write_json(st_path, state_obj)
                    executed_tasks.append(
                        {
                            "task_id": tid,
                            "task_file_id": tid_fs,
                            "vr_ids": state_obj.get("vr_ids") or [],
                            "argv_resolved": argv,
                            "exit_code": 2,
                            "log_path": None,
                            "log_sha256": None,
                            "status": "failed",
                            "error": state_obj.get("error"),
                        }
                    )
                    tasks_failed.append(tid)
                    needs_resume = True
                    resume_state = {"step": "C", "reason": "unsupported_task_tool", "task_id": tid}
                    break
                if not _looks_like_literature_fetch_argv(argv):
                    state_obj = {
                        "schema_version": 1,
                        "task_id": tid,
                        "task_file_id": tid_fs,
                        "tool": tool,
                        "cmd": str(t.get("cmd") or ""),
                        "vr_ids": t.get("vr_ids") if isinstance(t.get("vr_ids"), list) else [],
                        "argv_resolved": argv,
                        "started_at": utc_now_iso().replace("+00:00", "Z"),
                        "ended_at": utc_now_iso().replace("+00:00", "Z"),
                        "exit_code": 2,
                        "log_path": None,
                        "log_sha256": None,
                        "error": "argv_resolved does not look like a literature_fetch.py invocation",
                        "meta": t.get("meta") if isinstance(t.get("meta"), dict) else {},
                    }
                    write_json(st_path, state_obj)
                    executed_tasks.append(
                        {
                            "task_id": tid,
                            "task_file_id": tid_fs,
                            "vr_ids": state_obj.get("vr_ids") or [],
                            "argv_resolved": argv,
                            "exit_code": 2,
                            "log_path": None,
                            "log_sha256": None,
                            "status": "failed",
                            "error": state_obj.get("error"),
                        }
                    )
                    tasks_failed.append(tid)
                    needs_resume = True
                    resume_state = {"step": "C", "reason": "unexpected_task_argv", "task_id": tid}
                    break

                out_errs2 = _validate_literature_fetch_task_evidence_first(
                    argv=argv, repo_root=repo_root, run_root=out_dir
                )
                if out_errs2:
                    state_obj = {
                        "schema_version": 1,
                        "task_id": tid,
                        "task_file_id": tid_fs,
                        "tool": tool,
                        "cmd": str(t.get("cmd") or ""),
                        "vr_ids": t.get("vr_ids") if isinstance(t.get("vr_ids"), list) else [],
                        "argv_resolved": argv,
                        "started_at": utc_now_iso().replace("+00:00", "Z"),
                        "ended_at": utc_now_iso().replace("+00:00", "Z"),
                        "exit_code": 2,
                        "log_path": None,
                        "log_sha256": None,
                        "error": out_errs2[0],
                        "errors": out_errs2[:20],
                        "meta": t.get("meta") if isinstance(t.get("meta"), dict) else {},
                    }
                    write_json(st_path, state_obj)
                    executed_tasks.append(
                        {
                            "task_id": tid,
                            "task_file_id": tid_fs,
                            "vr_ids": state_obj.get("vr_ids") or [],
                            "argv_resolved": argv,
                            "exit_code": 2,
                            "log_path": None,
                            "log_sha256": None,
                            "status": "failed",
                            "error": state_obj.get("error"),
                        }
                    )
                    tasks_failed.append(tid)
                    needs_resume = True
                    resume_state = {"step": "C", "reason": "task_writes_outside_run_root", "task_id": tid}
                    break
                prev = _load_json_if_exists(st_path)
                prev_ok = False
                if isinstance(prev, dict):
                    try:
                        if int(prev.get("schema_version") or 0) == 1 and int(prev.get("exit_code") or 0) == 0:
                            prev_argv = prev.get("argv_resolved")
                            if isinstance(prev_argv, list) and [str(x) for x in prev_argv] == argv:
                                expected_sha = str(prev.get("log_sha256") or "")
                                if expected_sha and log_path.is_file() and _sha256_file(log_path) == expected_sha:
                                    prev_ok = True
                    except Exception:  # CONTRACT-EXEMPT: CODE-01.5 intentional fallback
                        prev_ok = False
                if prev_ok:
                    tasks_skipped += 1
                    executed_tasks.append(
                        {
                            "task_id": tid,
                            "task_file_id": tid_fs,
                            "vr_ids": t.get("vr_ids") if isinstance(t.get("vr_ids"), list) else [],
                            "argv_resolved": argv,
                            "exit_code": 0,
                            "log_path": _safe_rel(repo_root, log_path),
                            "log_sha256": str(prev.get("log_sha256") or ""),
                            "status": "skipped",
                        }
                    )
                    continue

                started_at = utc_now_iso().replace("+00:00", "Z")
                rc_t = _run_logged(argv, cwd=repo_root, log_path=log_path, timeout_seconds=int(inps.timeout_seconds_task))
                ended_at = utc_now_iso().replace("+00:00", "Z")
                log_sha = _sha256_file(log_path) if log_path.exists() else ""
                state_obj: dict[str, Any] = {
                    "schema_version": 1,
                    "task_id": tid,
                    "task_file_id": tid_fs,
                    "tool": str(t.get("tool") or ""),
                    "cmd": str(t.get("cmd") or ""),
                    "vr_ids": t.get("vr_ids") if isinstance(t.get("vr_ids"), list) else [],
                    "argv_resolved": argv,
                    "started_at": started_at,
                    "ended_at": ended_at,
                    "exit_code": int(rc_t),
                    "log_path": _safe_rel(repo_root, log_path),
                    "log_sha256": log_sha,
                    "meta": t.get("meta") if isinstance(t.get("meta"), dict) else {},
                }
                write_json(st_path, state_obj)
                executed_tasks.append(
                    {
                        "task_id": tid,
                        "task_file_id": tid_fs,
                        "vr_ids": state_obj.get("vr_ids") or [],
                        "argv_resolved": argv,
                        "exit_code": int(rc_t),
                        "log_path": state_obj.get("log_path"),
                        "log_sha256": state_obj.get("log_sha256"),
                        "status": "completed" if int(rc_t) == 0 else "failed",
                    }
                )
                if int(rc_t) == 0:
                    tasks_completed += 1
                else:
                    tasks_failed.append(tid)
                    needs_resume = True
                    resume_state = {"step": "C", "reason": "task_failed", "task_id": tid}
                    break

            # If we stop early, still record the remaining plan tasks as "not_started"
            # so the manifest is auditable and resumable.
            if tasks_failed:
                executed_ids = {str(x.get("task_id") or "") for x in executed_tasks if isinstance(x, dict)}
                for t2 in _iter_plan_tasks(plan_obj):
                    tid2 = _task_id(t2)
                    if tid2 in executed_ids:
                        continue
                    argv2: list[str] = []
                    try:
                        argv2 = _task_argv(t2)
                    except Exception:  # CONTRACT-EXEMPT: CODE-01.5 intentional fallback
                        argv2 = []
                    executed_tasks.append(
                        {
                            "task_id": tid2,
                            "vr_ids": t2.get("vr_ids") if isinstance(t2.get("vr_ids"), list) else [],
                            "argv_resolved": argv2,
                            "exit_code": None,
                            "log_path": None,
                            "log_sha256": None,
                            "status": "not_started",
                        }
                    )

            if tasks_failed:
                steps["C"] = {"status": "failed", "failed_task_ids": tasks_failed, "tasks": executed_tasks}
                errors.append(f"Step C failed (task {tasks_failed[0]})")
            else:
                steps["C"] = {
                    "status": "completed",
                    "tasks_completed": tasks_completed,
                    "tasks_skipped": tasks_skipped,
                    "tasks_total": tasks_completed + tasks_skipped,
                    "tasks": executed_tasks,
                    "verification_plan_json": _safe_rel(repo_root, plan_path),
                    "approval_id": str(gate_satisfied.get("A1") or ""),
                }
    else:
        steps["C"] = {"status": "skipped", "note": "no retrieval tasks"}

    # Step D: Evidence synthesis (fan-in).
    can_run_step_d = upstream_ok and (not errors) and (steps.get("C", {}).get("status") in {"completed", "skipped"})
    step_d_res = run_step_d_evidence_synthesis(
        repo_root=repo_root,
        out_dir=out_dir,
        ver_root=ver_root,
        evidence_state_dir=evidence_state_dir,
        evidence_dir=evidence_dir,
        kb_dir=kb_dir,
        trace_path=trace_path,
        executed_tasks=executed_tasks,
        verification_requests_obj=verification_requests_obj if isinstance(verification_requests_obj, dict) else None,
        vr_ids=vr_ids,
        can_run=can_run_step_d,
        manual_evidence=bool(inps.manual_evidence),
        evidence_synth_backend=inps.evidence_synth_backend,
        evidence_synth_model=inps.evidence_synth_model,
        timeout_seconds_evidence_synth=int(inps.timeout_seconds_evidence_synth),
        skills_dir=skills_dir,
    )
    steps["D"] = step_d_res.get("step") if isinstance(step_d_res.get("step"), dict) else {"status": "failed"}
    evidence_done = int(step_d_res.get("evidence_done") or 0)
    evidence_skipped = int(step_d_res.get("evidence_skipped") or 0)
    if step_d_res.get("errors"):
        errors.extend([str(x) for x in (step_d_res.get("errors") or []) if str(x).strip()])
    if bool(step_d_res.get("needs_resume")):
        needs_resume = True
        resume_state = (
            (step_d_res.get("resume_state") if isinstance(step_d_res.get("resume_state"), dict) else None) or resume_state
        )

    # Step E: Revise again (round_02), using evidence_dir as context.
    ok_e, run_e, errs_e = _paper_reviser_round_ok(rev2_dir)
    if ok_e:
        steps["E"] = {
            "status": "skipped",
            "round_dir": _safe_rel(repo_root, rev2_dir),
            "run_json": _safe_rel(repo_root, rev2_dir / "run.json"),
            "auditor_verdict": (run_e or {}).get("auditor_verdict"),
            "deep_verifier_verdict": (run_e or {}).get("deep_verifier_verdict"),
        }
    else:
        if rev2_dir.exists() and not force:
            steps["E"] = {
                "status": "needs_force",
                "round_dir": _safe_rel(repo_root, rev2_dir),
                "run_json": _safe_rel(repo_root, rev2_dir / "run.json") if (rev2_dir / "run.json").exists() else None,
                "note": "round_02 exists but is incomplete/failed; pass --force to overwrite",
                "errors": errs_e,
            }
            needs_resume = True
            resume_state = {"step": "E", "reason": "needs_force", "errors": errs_e[:5]}
        else:
            if rev2_dir.exists() and force:
                shutil.rmtree(rev2_dir, ignore_errors=True)
            if steps.get("D", {}).get("status") in {"failed", "needs_manual_evidence", "pending"}:
                # Do not proceed to E until evidence is ready.
                pass
            elif errors:
                # Upstream errors already recorded; avoid cascading.
                pass
            elif not upstream_ok:
                # Do not proceed to round_02 unless round_01 is complete.
                pass
            else:
                clean_rev1 = rev1_dir / "clean.tex"
                if not clean_rev1.is_file():
                    steps["E"] = {
                        "status": "failed",
                        "round_dir": _safe_rel(repo_root, rev2_dir),
                        "errors": [f"round_01 clean.tex missing: {_safe_rel(repo_root, clean_rev1)}"],
                    }
                    errors.append("Step E blocked: round_01/clean.tex not found")
                    needs_resume = True
                    resume_state = {"step": "E", "reason": "missing_round_01_clean_tex"}
                    # Fail closed: do not shell out.
                else:
                    _log_e = logs_dir / "step_E_round_02.log"
                    cmd_e = [
                        sys.executable,
                        str(edit_script),
                        "--in",
                        str(clean_rev1),
                        "--out-dir",
                        str(rev2_dir),
                        "--writer-backend",
                        str(inps.writer_backend),
                        "--writer-model",
                        str(inps.writer_model),
                        "--auditor-backend",
                        str(inps.auditor_backend),
                        "--auditor-model",
                        str(inps.auditor_model),
                        "--context-dir",
                        str(evidence_dir),
                        "--max-rounds",
                        "1",
                    ]
                    if inps.paper_reviser_mode == "stub-models":
                        cmd_e.append("--stub-models")
                    elif inps.paper_reviser_mode == "dry-run":
                        cmd_e.append("--dry-run")
                    else:
                        cmd_e.append("--run-models")
                    if inps.no_codex_verify:
                        cmd_e.append("--no-codex-verify")
                    if inps.min_clean_size_ratio is not None:
                        cmd_e.extend(["--min-clean-size-ratio", str(float(inps.min_clean_size_ratio))])
                    if isinstance(inps.codex_model, str) and inps.codex_model.strip():
                        cmd_e.extend(["--codex-model", str(inps.codex_model).strip()])
                    for cfg in list(inps.codex_config or []):
                        cmd_e.extend(["--codex-config", str(cfg)])
                    if isinstance(inps.fallback_auditor, str) and inps.fallback_auditor.strip():
                        cmd_e.extend(["--fallback-auditor", str(inps.fallback_auditor).strip()])
                    if isinstance(inps.fallback_auditor_model, str) and inps.fallback_auditor_model.strip():
                        cmd_e.extend(["--fallback-auditor-model", str(inps.fallback_auditor_model).strip()])
                    if isinstance(inps.secondary_deep_verify_backend, str) and inps.secondary_deep_verify_backend.strip():
                        cmd_e.extend(["--secondary-deep-verify-backend", str(inps.secondary_deep_verify_backend).strip()])
                    if isinstance(inps.secondary_deep_verify_model, str) and inps.secondary_deep_verify_model.strip():
                        cmd_e.extend(["--secondary-deep-verify-model", str(inps.secondary_deep_verify_model).strip()])
                    rc_e = _run_logged(
                        cmd_e, cwd=repo_root, log_path=_log_e, timeout_seconds=int(inps.timeout_seconds_step_e)
                    )
                    ok_e2, run_e2, errs_e2 = _paper_reviser_round_ok(rev2_dir)
                    steps["E"] = {
                        "status": "completed" if (rc_e == 0 and ok_e2) else "failed",
                        "round_dir": _safe_rel(repo_root, rev2_dir),
                        "run_json": _safe_rel(repo_root, rev2_dir / "run.json") if (rev2_dir / "run.json").exists() else None,
                        "exit_code": int(rc_e),
                        "log_path": _safe_rel(repo_root, _log_e),
                        "log_sha256": _sha256_file(_log_e) if _log_e.exists() else None,
                        "auditor_verdict": (run_e2 or {}).get("auditor_verdict") if isinstance(run_e2, dict) else None,
                        "deep_verifier_verdict": (run_e2 or {}).get("deep_verifier_verdict") if isinstance(run_e2, dict) else None,
                        "errors": errs_e2,
                    }
                    if rc_e != 0 or not ok_e2:
                        errors.append("Step E failed (round_02 paper_reviser_edit)")
                        needs_resume = True
                        resume_state = {"step": "E", "reason": "paper_reviser_edit_failed"}

    # Optional apply-to-draft (A4-gated by orchestrator).
    if bool(inps.apply_to_draft):
        clean_final = rev2_dir / "clean.tex"
        if clean_final.is_file():
            clean_txt = clean_final.read_text(encoding="utf-8", errors="replace")
            draft_txt = draft_path.read_text(encoding="utf-8", errors="replace")
            if _sha256_text(clean_txt) == _sha256_text(draft_txt):
                steps["APPLY"] = {"status": "skipped", "note": "draft already matches round_02 clean.tex"}
            elif not bool(i_approve_paper_edits):
                blocked = {"missing_gates": ["A4"], "phase_id": "APPLY", "reason": "apply_to_draft_requires_A4"}
                steps["APPLY"] = {"status": "blocked_by_gate", "blocked": blocked}
            else:
                apply_dir = out_dir / "apply"
                apply_dir.mkdir(parents=True, exist_ok=True)
                diff_txt = _diff_text(draft_txt, clean_txt, from_name=str(draft_path), to_name=str(clean_final))
                diff_path = apply_dir / "draft.diff"
                diff_path.write_text(diff_txt, encoding="utf-8")
                draft_path.write_text(clean_txt, encoding="utf-8")
                steps["APPLY"] = {
                    "status": "completed",
                    "draft_tex_path": _safe_rel(repo_root, draft_path),
                    "draft_sha256_after": _sha256_file(draft_path),
                    "diff_path": _safe_rel(repo_root, diff_path),
                }
        else:
            steps["APPLY"] = {"status": "skipped", "note": "round_02 clean.tex missing; nothing to apply"}

    # Collect evidence items (output notes) and their sha256 for manifest.
    evidence_items: list[dict[str, str]] = []
    if evidence_dir.exists():
        for p in sorted(evidence_dir.glob("*")):
            if not p.is_file():
                continue
            # Limit to reasonably sized evidence artifacts; large arxiv trees live elsewhere.
            relp = _safe_rel(repo_root, p)
            try:
                evidence_items.append({"path": relp, "sha256": _sha256_file(p)})
            except Exception:  # CONTRACT-EXEMPT: CODE-01.5 skip unhashable evidence files
                continue

    versions: dict[str, Any] = {
        "python": sys.version.split()[0],
        "os": platform.platform(),
    }

    # Derive workflow status for analysis.
    status = "completed"
    if blocked is not None:
        status = "blocked_by_gate"
    if steps.get("C", {}).get("status") == "blocked_by_gate":
        status = "blocked_by_gate"
        blocked = steps.get("C", {}).get("blocked") if isinstance(steps.get("C"), dict) else blocked
    if steps.get("D", {}).get("status") == "needs_manual_evidence":
        status = "needs_manual_evidence"
    if needs_resume and status == "completed":
        status = "needs_resume"
    if errors:
        status = "failed"

    ok = (status == "completed") and not errors

    manifest_path = out_dir / "manifest.json"
    summary_path = out_dir / "summary.json"
    analysis_path = out_dir / "analysis.json"

    manifest: dict[str, Any] = {
        "schema_version": 1,
        "created_at": created_at,
        "command": "hepar run --workflow-id paper_reviser",
        "cwd": manifest_cwd(repo_root=repo_root, cwd=repo_root),
        "params": {
            "tag": inps.tag,
            "workflow_id": "paper_reviser",
            "draft_tex_path": _safe_rel(repo_root, draft_path),
            "paper_root": inps.paper_root,
            "tex_main": inps.tex_main,
            # Model config is not secret, but is critical for reproducibility/audit.
            "writer_backend": inps.writer_backend,
            "writer_model": inps.writer_model,
            "auditor_backend": inps.auditor_backend,
            "auditor_model": inps.auditor_model,
            "paper_reviser_mode": inps.paper_reviser_mode,
            "max_rounds_rev1": int(inps.max_rounds_rev1),
            "no_codex_verify": bool(inps.no_codex_verify),
            "min_clean_size_ratio": float(inps.min_clean_size_ratio) if inps.min_clean_size_ratio is not None else None,
            "codex_model": inps.codex_model,
            "codex_config": list(inps.codex_config or []),
            "fallback_auditor": inps.fallback_auditor,
            "fallback_auditor_model": inps.fallback_auditor_model,
            "secondary_deep_verify_backend": inps.secondary_deep_verify_backend,
            "secondary_deep_verify_model": inps.secondary_deep_verify_model,
            "manual_evidence": bool(inps.manual_evidence),
            "evidence_synth_backend": inps.evidence_synth_backend,
            "evidence_synth_model": inps.evidence_synth_model,
            "apply_to_draft": bool(inps.apply_to_draft),
            "force": bool(force),
        },
        "versions": versions,
        "inputs": inputs,
        "outputs": [],
        "tools": tools,
        "steps": steps,
        "approvals": approvals,
        "verification_tasks": executed_tasks,
        "evidence_items": evidence_items,
        "needs_resume": bool(needs_resume),
        "resume_state": resume_state,
        "notes": "",
    }
    if warnings:
        manifest["warnings"] = list(warnings)
    if command_argv:
        manifest["orchestrator_command"] = [str(x) for x in command_argv if str(x).strip()]

    git_meta = try_get_git_metadata(repo_root)
    if git_meta:
        manifest["git"] = git_meta

    summary: dict[str, Any] = {
        "schema_version": 1,
        "created_at": created_at,
        "definitions": {"workflow": "paper_reviser"},
        "stats": {
            "tasks_total": int(tasks_completed + tasks_skipped),
            "tasks_completed": int(tasks_completed),
            "tasks_skipped": int(tasks_skipped),
            "vr_total": int(len(vr_ids)),
            "evidence_total": int(evidence_done + evidence_skipped),
            "evidence_completed": int(evidence_done),
            "evidence_skipped": int(evidence_skipped),
        },
        "outputs": {},
    }

    analysis: dict[str, Any] = {
        "schema_version": 1,
        "created_at": created_at,
        "inputs": {
            "tag": inps.tag,
            "draft_tex_path": _safe_rel(repo_root, draft_path),
            "writer_backend": inps.writer_backend,
            "writer_model": inps.writer_model,
            "auditor_backend": inps.auditor_backend,
            "auditor_model": inps.auditor_model,
        },
        "results": {
            "ok": bool(ok),
            "status": status,
            "errors": list(errors),
            "warnings": list(warnings),
            "blocked": blocked,
            "needs_resume": bool(needs_resume),
            "resume_state": resume_state,
            "artifact_paths": {
                "run_root": _safe_rel(repo_root, out_dir),
                "rev1_run_json": _safe_rel(repo_root, rev1_dir / "run.json") if (rev1_dir / "run.json").exists() else None,
                "rev2_run_json": _safe_rel(repo_root, rev2_dir / "run.json") if (rev2_dir / "run.json").exists() else None,
                "verification_requests_json": _safe_rel(repo_root, verification_requests_path)
                if verification_requests_path.exists()
                else None,
                "verification_plan_json": _safe_rel(repo_root, plan_path) if plan_path.exists() else None,
                "evidence_dir": _safe_rel(repo_root, evidence_dir),
            },
        },
    }

    # Populate outputs *before* writing SSOT + report so the report can reflect the final manifest.
    report_rel = _safe_rel(repo_root, out_dir / "report.md")
    manifest["outputs"] = [
        _safe_rel(repo_root, summary_path),
        _safe_rel(repo_root, analysis_path),
        report_rel,
        # Key per-round SSOT.
        _safe_rel(repo_root, rev1_dir / "run.json") if (rev1_dir / "run.json").exists() else None,
        _safe_rel(repo_root, rev2_dir / "run.json") if (rev2_dir / "run.json").exists() else None,
        _safe_rel(repo_root, verification_requests_path) if verification_requests_path.exists() else None,
        _safe_rel(repo_root, plan_path) if plan_path.exists() else None,
    ]
    manifest["outputs"] = [x for x in manifest["outputs"] if isinstance(x, str) and x.strip()]

    # Always write SSOT artifacts (even when blocked/failed) for auditability.
    write_json(summary_path, summary)
    write_json(analysis_path, analysis)
    write_artifact_report(repo_root=repo_root, artifact_dir=out_dir, manifest=manifest, summary=summary, analysis=analysis)
    write_json(manifest_path, manifest)

    return {
        "errors": errors,
        "ok": bool(ok),
        "artifact_paths": {
            "manifest": _safe_rel(repo_root, manifest_path),
            "summary": _safe_rel(repo_root, summary_path),
            "analysis": _safe_rel(repo_root, analysis_path),
            "report": report_rel,
        },
        "status": status,
    }
