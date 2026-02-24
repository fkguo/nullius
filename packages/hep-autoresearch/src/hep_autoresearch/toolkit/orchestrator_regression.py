from __future__ import annotations

import os
import platform
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from ._git import try_get_git_metadata
from ._json import read_json, write_json
from ._paths import manifest_cwd
from ._time import utc_now_iso
from .artifact_report import write_artifact_report
from .orchestrator_state import plan_md_path as _plan_md_path
from .orchestrator_state import state_path as _state_path
from .run_quality_metrics import build_run_quality_metrics


@dataclass(frozen=True)
class OrchestratorRegressionInputs:
    tag: str
    scenarios: tuple[str, ...] = ("w2", "wcompute", "w3")  # project_init,plan,branching,sandbox,w2,wcompute,w3,survey_polish,bypass
    # Per-run isolated runtime dir for .autoresearch state/ledger (relative to repo_root by default).
    runtime_dir: str | None = None
    w2_ns: tuple[int, ...] = (0, 1, 2)
    w2_case: str = "toy"
    wcompute_run_card: str = "examples/schrodinger_ho/run_cards/ho_groundstate.json"
    w3_paper_root: str = "paper"
    w3_tex_main: str = "main.tex"
    timeout_seconds: int = 600


def _run(cmd: list[str], *, cwd: Path, env: dict[str, str], timeout_seconds: int) -> tuple[int, str]:
    p = subprocess.run(
        cmd,
        cwd=cwd,
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        encoding="utf-8",
        errors="replace",
        timeout=int(timeout_seconds),
        check=False,
    )
    return int(p.returncode), p.stdout


def _read_pending_approval(state_path: Path) -> dict[str, Any] | None:
    if not state_path.exists():
        return None
    st = read_json(state_path)
    pending = st.get("pending_approval")
    return pending if isinstance(pending, dict) else None


def _write_artifacts(
    *,
    repo_root: Path,
    out_dir: Path,
    manifest: dict[str, Any],
    summary: dict[str, Any],
    analysis: dict[str, Any],
) -> dict[str, str]:
    manifest_path = out_dir / "manifest.json"
    summary_path = out_dir / "summary.json"
    analysis_path = out_dir / "analysis.json"
    report_path = out_dir / "report.md"

    write_json(manifest_path, manifest)
    write_json(summary_path, summary)
    write_json(analysis_path, analysis)
    report_rel = write_artifact_report(repo_root=repo_root, artifact_dir=out_dir, manifest=manifest, summary=summary, analysis=analysis)

    return {
        "manifest": os.fspath(manifest_path.relative_to(repo_root)),
        "summary": os.fspath(summary_path.relative_to(repo_root)),
        "analysis": os.fspath(analysis_path.relative_to(repo_root)),
        "report": report_rel,
    }


def run_orchestrator_regression(inps: OrchestratorRegressionInputs, repo_root: Path) -> dict[str, Any]:
    if not inps.tag or not str(inps.tag).strip():
        raise ValueError("tag is required")

    created_at = utc_now_iso()
    out_dir = repo_root / "artifacts" / "runs" / str(inps.tag) / "orchestrator_regression"
    logs_dir = out_dir / "logs"
    logs_dir.mkdir(parents=True, exist_ok=True)

    runtime_rel = inps.runtime_dir or os.fspath((out_dir / ".autoresearch").relative_to(repo_root))
    runtime_dir = (Path(runtime_rel) if Path(runtime_rel).is_absolute() else (repo_root / runtime_rel)).resolve()
    runtime_dir.mkdir(parents=True, exist_ok=True)
    # Keep this process's path resolution consistent with the subprocesses by
    # temporarily applying the same HEP_AUTORESEARCH_DIR override used in env.
    prev_autoresearch_dir = os.environ.get("HEP_AUTORESEARCH_DIR")
    os.environ["HEP_AUTORESEARCH_DIR"] = runtime_rel
    try:
        state_path = _state_path(repo_root)
        plan_md_path = _plan_md_path(repo_root)
    finally:
        if prev_autoresearch_dir is None:
            os.environ.pop("HEP_AUTORESEARCH_DIR", None)
        else:
            os.environ["HEP_AUTORESEARCH_DIR"] = prev_autoresearch_dir

    def rel(p: Path) -> str:
        try:
            return os.fspath(p.relative_to(repo_root))
        except Exception:  # CONTRACT-EXEMPT: CODE-01.5 diagnostic fallthrough
            return os.fspath(p)

    errors: list[str] = []
    env = dict(os.environ)
    env["HEP_AUTORESEARCH_DIR"] = runtime_rel

    versions: dict[str, Any] = {"python": os.sys.version.split()[0], "os": platform.platform()}

    manifest: dict[str, Any] = {
        "schema_version": 1,
        "created_at": created_at,
        "command": "python3 scripts/run_orchestrator_regression.py",
        "cwd": manifest_cwd(repo_root=repo_root, cwd=repo_root),
        "params": {
            "tag": inps.tag,
            "scenarios": list(inps.scenarios),
            "runtime_dir": runtime_rel,
            "w2_case": inps.w2_case,
            "w2_ns": list(inps.w2_ns),
            "wcompute_run_card": inps.wcompute_run_card,
            "w3_paper_root": inps.w3_paper_root,
            "w3_tex_main": inps.w3_tex_main,
            "timeout_seconds": int(inps.timeout_seconds),
        },
        "versions": versions,
        "outputs": [
            os.fspath((out_dir / "manifest.json").relative_to(repo_root)),
            os.fspath((out_dir / "summary.json").relative_to(repo_root)),
            os.fspath((out_dir / "analysis.json").relative_to(repo_root)),
            os.fspath((out_dir / "report.md").relative_to(repo_root)),
            rel(state_path),
            rel(plan_md_path),
        ],
    }
    git_meta = try_get_git_metadata(repo_root)
    if git_meta:
        manifest["git"] = git_meta

    summary: dict[str, Any] = {
        "schema_version": 1,
        "created_at": created_at,
        "definitions": {"kind": "orchestrator_regression"},
        "stats": {},
        "outputs": {},
    }

    analysis: dict[str, Any] = {
        "schema_version": 1,
        "created_at": created_at,
        "inputs": {
            "tag": inps.tag,
            "scenarios": list(inps.scenarios),
            "runtime_dir": runtime_rel,
            "w2_case": inps.w2_case,
            "w2_ns": list(inps.w2_ns),
            "wcompute_run_card": inps.wcompute_run_card,
            "w3_paper_root": inps.w3_paper_root,
            "w3_tex_main": inps.w3_tex_main,
        },
        "results": {},
    }

    ledger_path = runtime_dir / "ledger.jsonl"
    manifest["outputs"].append(rel(ledger_path))

    # init (isolated runtime dir)
    init_cmd = ["python3", "scripts/orchestrator.py", "init", "--force"]
    rc_init, out_init = _run(init_cmd, cwd=repo_root, env=env, timeout_seconds=min(120, int(inps.timeout_seconds)))
    (logs_dir / "init.txt").write_text(out_init, encoding="utf-8")
    manifest["outputs"].append(os.fspath((logs_dir / "init.txt").relative_to(repo_root)))
    if rc_init != 0:
        errors.append(f"orchestrator init failed (exit_code={rc_init})")

    def inject_fake_gate_satisfied(*, category: str, approval_id: str) -> None:
        if not state_path.exists():
            errors.append("cannot inject fake gate_satisfied: state.json missing after init")
            return
        st = read_json(state_path)
        st.setdefault("gate_satisfied", {})[str(category)] = str(approval_id)
        # Intentionally do NOT add a matching approval_history record (simulates tampering).
        write_json(state_path, st)

    def scenario_w2() -> dict[str, Any]:
        run_id = f"{inps.tag}-w2"
        cmd_run = [
            "python3",
            "scripts/orchestrator.py",
            "run",
            "--run-id",
            run_id,
            "--workflow-id",
            "W2_reproduce",
            "--case",
            str(inps.w2_case),
            "--ns",
            ",".join(str(x) for x in inps.w2_ns),
        ]
        rc_gate, out_gate = _run(cmd_run, cwd=repo_root, env=env, timeout_seconds=int(inps.timeout_seconds))
        (logs_dir / "w2_gate.txt").write_text(out_gate, encoding="utf-8")
        manifest["outputs"].append(os.fspath((logs_dir / "w2_gate.txt").relative_to(repo_root)))

        pending = _read_pending_approval(state_path)
        approval_id = (pending or {}).get("approval_id")
        category = (pending or {}).get("category")
        packet_rel = (pending or {}).get("packet_path")

        rc_approve = None
        out_approve = ""
        if isinstance(approval_id, str) and approval_id.strip():
            rc_approve, out_approve = _run(
                ["python3", "scripts/orchestrator.py", "approve", approval_id],
                cwd=repo_root,
                env=env,
                timeout_seconds=60,
            )
            (logs_dir / "w2_approve.txt").write_text(out_approve, encoding="utf-8")
            manifest["outputs"].append(os.fspath((logs_dir / "w2_approve.txt").relative_to(repo_root)))

        rc_final, out_final = _run(cmd_run, cwd=repo_root, env=env, timeout_seconds=int(inps.timeout_seconds))
        (logs_dir / "w2_final.txt").write_text(out_final, encoding="utf-8")
        manifest["outputs"].append(os.fspath((logs_dir / "w2_final.txt").relative_to(repo_root)))

        return {
            "run_id": run_id,
            "gate_exit_code": int(rc_gate),
            "pending_category": category,
            "approval_id": approval_id,
            "approval_packet": packet_rel,
            "approve_exit_code": int(rc_approve) if rc_approve is not None else None,
            "final_exit_code": int(rc_final),
            "expected_outputs": {
                "approval_packet": f"artifacts/runs/{run_id}/approvals/{category or 'A3'}-0001/packet.md",
                "reproduce_manifest": f"artifacts/runs/{run_id}/reproduce/manifest.json",
                "reproduce_summary": f"artifacts/runs/{run_id}/reproduce/summary.json",
                "reproduce_analysis": f"artifacts/runs/{run_id}/reproduce/analysis.json",
            },
        }

    def scenario_project_init() -> dict[str, Any]:
        """Init/scaffold in a fresh project dir and verify root discovery works from a subdir."""
        project_root = out_dir / "project_init_project"
        project_root.mkdir(parents=True, exist_ok=True)

        env_proj = dict(env)
        env_proj.pop("HEP_AUTORESEARCH_DIR", None)
        src_root = os.fspath((repo_root / "src").resolve())
        prev_pp = env_proj.get("PYTHONPATH")
        env_proj["PYTHONPATH"] = src_root if not prev_pp else (src_root + os.pathsep + str(prev_pp))

        cli_snip = "from hep_autoresearch.orchestrator_cli import main; raise SystemExit(main())"

        cmd_init = ["python3", "-c", cli_snip, "init", "--force", "--allow-nested"]
        rc_init, out_init = _run(cmd_init, cwd=project_root, env=env_proj, timeout_seconds=60)
        (logs_dir / "project_init_init.txt").write_text(out_init, encoding="utf-8")
        manifest["outputs"].append(os.fspath((logs_dir / "project_init_init.txt").relative_to(repo_root)))

        expected_outputs: dict[str, str] = {
            "project_root": rel(project_root),
            "state_json": rel(project_root / ".autoresearch" / "state.json"),
            "approval_policy_json": rel(project_root / ".autoresearch" / "approval_policy.json"),
            "ledger_jsonl": rel(project_root / ".autoresearch" / "ledger.jsonl"),
            "kb_index_json": rel(project_root / "knowledge_base" / "_index" / "kb_index.json"),
            "kb_profile_minimal": rel(project_root / "knowledge_base" / "_index" / "kb_profiles" / "minimal.json"),
            "kb_profile_curated": rel(project_root / "knowledge_base" / "_index" / "kb_profiles" / "curated.json"),
            "docs_approval_gates": rel(project_root / "docs" / "APPROVAL_GATES.md"),
            "docs_artifact_contract": rel(project_root / "docs" / "ARTIFACT_CONTRACT.md"),
            "docs_eval_gate_contract": rel(project_root / "docs" / "EVAL_GATE_CONTRACT.md"),
        }
        for v in expected_outputs.values():
            manifest["outputs"].append(str(v))

        # Root discovery should work from a subdir.
        subdir = project_root / "knowledge_base"
        cmd_status = ["python3", "-c", cli_snip, "status"]
        rc_status, out_status = _run(cmd_status, cwd=subdir, env=env_proj, timeout_seconds=30)
        (logs_dir / "project_init_status_subdir.txt").write_text(out_status, encoding="utf-8")
        manifest["outputs"].append(os.fspath((logs_dir / "project_init_status_subdir.txt").relative_to(repo_root)))

        expected_state = (project_root / ".autoresearch" / "state.json").resolve()
        reported_state: Path | None = None
        for line in out_status.splitlines():
            if line.strip().startswith("state_path:"):
                raw = line.split(":", 1)[1].strip()
                if raw:
                    try:
                        reported_state = Path(raw).resolve()
                    except Exception:  # CONTRACT-EXEMPT: CODE-01.5 best-effort optional read
                        reported_state = None
                break
        state_path_ok = bool(reported_state and reported_state == expected_state)

        # Nested init guard: by default refuse to create nested project roots, but allow explicitly.
        nested_root = project_root / "nested_project"
        nested_root.mkdir(parents=True, exist_ok=True)
        cmd_nested_init = ["python3", "-c", cli_snip, "init", "--force"]
        rc_nested_init, out_nested_init = _run(cmd_nested_init, cwd=nested_root, env=env_proj, timeout_seconds=60)
        (logs_dir / "project_init_nested_init_refused.txt").write_text(out_nested_init, encoding="utf-8")
        manifest["outputs"].append(os.fspath((logs_dir / "project_init_nested_init_refused.txt").relative_to(repo_root)))

        cmd_nested_allow = ["python3", "-c", cli_snip, "init", "--force", "--allow-nested"]
        rc_nested_allow, out_nested_allow = _run(cmd_nested_allow, cwd=nested_root, env=env_proj, timeout_seconds=60)
        (logs_dir / "project_init_nested_init_allowed.txt").write_text(out_nested_allow, encoding="utf-8")
        manifest["outputs"].append(os.fspath((logs_dir / "project_init_nested_init_allowed.txt").relative_to(repo_root)))

        nested_state = nested_root / ".autoresearch" / "state.json"
        nested_state_exists = nested_state.exists()

        # Ensure the run path can build context pack + kb_profile and reach the A3 gate.
        run_id = f"{inps.tag}-proj-w2"
        cmd_run = [
            "python3",
            "-c",
            cli_snip,
            "run",
            "--run-id",
            run_id,
            "--workflow-id",
            "W2_reproduce",
            "--case",
            str(inps.w2_case),
            "--ns",
            ",".join(str(x) for x in inps.w2_ns),
        ]
        rc_gate, out_gate = _run(cmd_run, cwd=project_root, env=env_proj, timeout_seconds=int(inps.timeout_seconds))
        (logs_dir / "project_init_w2_gate.txt").write_text(out_gate, encoding="utf-8")
        manifest["outputs"].append(os.fspath((logs_dir / "project_init_w2_gate.txt").relative_to(repo_root)))

        pending_category: str | None = None
        approval_id: str | None = None
        approval_packet: str | None = None
        packet_abs: Path | None = None
        st_path = project_root / ".autoresearch" / "state.json"
        if st_path.exists():
            st_proj = read_json(st_path)
            pending = st_proj.get("pending_approval") if isinstance(st_proj, dict) else None
            if isinstance(pending, dict):
                pending_category = pending.get("category")
                approval_id = pending.get("approval_id")
                approval_packet = pending.get("packet_path")
                if isinstance(approval_packet, str) and approval_packet.strip():
                    packet_abs = project_root / approval_packet

        kb_profile_json = project_root / "artifacts" / "runs" / run_id / "kb_profile" / "kb_profile.json"
        plan_md = project_root / ".autoresearch" / "plan.md"
        expected_packet_abs = project_root / "artifacts" / "runs" / run_id / "approvals" / "A3-0001" / "packet.md"
        expected_outputs.update(
            {
                "plan_md": rel(plan_md),
                "kb_profile_json": rel(kb_profile_json),
                "approval_packet": rel(expected_packet_abs),
            }
        )
        manifest["outputs"].append(rel(expected_packet_abs))
        if plan_md.exists():
            manifest["outputs"].append(rel(plan_md))
        if kb_profile_json.exists():
            manifest["outputs"].append(rel(kb_profile_json))
        if packet_abs and packet_abs.exists():
            manifest["outputs"].append(rel(packet_abs))

        return {
            "project_root": rel(project_root),
            "init_exit_code": int(rc_init),
            "status_subdir_exit_code": int(rc_status),
            "status_subdir_state_path_ok": bool(state_path_ok),
            "nested_init_exit_code": int(rc_nested_init),
            "nested_init_allow_exit_code": int(rc_nested_allow),
            "nested_state_json_exists": bool(nested_state_exists),
            "run_id": run_id,
            "gate_exit_code": int(rc_gate),
            "pending_category": pending_category,
            "approval_id": approval_id,
            "approval_packet_rel": approval_packet,
            "expected_outputs": expected_outputs,
        }

    def scenario_plan() -> dict[str, Any]:
        """Plan protocol: create plan, pause/resume, ensure approval packets reference plan steps."""
        run_id = f"{inps.tag}-plan"

        cmd_start = [
            "python3",
            "scripts/orchestrator.py",
            "start",
            "--run-id",
            run_id,
            "--workflow-id",
            "W2_reproduce",
            "--force",
        ]
        rc_start, out_start = _run(cmd_start, cwd=repo_root, env=env, timeout_seconds=60)
        (logs_dir / "plan_start.txt").write_text(out_start, encoding="utf-8")
        manifest["outputs"].append(os.fspath((logs_dir / "plan_start.txt").relative_to(repo_root)))

        def _read_state() -> dict[str, Any]:
            if not state_path.exists():
                return {}
            st = read_json(state_path)
            return st if isinstance(st, dict) else {}

        st1 = _read_state()
        cur1 = st1.get("current_step") if isinstance(st1.get("current_step"), dict) else {}
        plan1 = st1.get("plan") if isinstance(st1.get("plan"), dict) else {}
        steps1 = plan1.get("steps") if isinstance(plan1.get("steps"), list) else []
        step_ids1 = [s.get("step_id") for s in steps1 if isinstance(s, dict)]

        artifacts1 = st1.get("artifacts") if isinstance(st1.get("artifacts"), dict) else {}
        run_card_rel = artifacts1.get("run_card") if isinstance(artifacts1, dict) else None
        run_card_exists = False
        if isinstance(run_card_rel, str) and run_card_rel.strip():
            run_card_exists = (repo_root / run_card_rel).exists()

        md_rel = st1.get("plan_md_path") if isinstance(st1.get("plan_md_path"), str) else None
        md_exists = False
        if isinstance(md_rel, str) and md_rel.strip():
            md_exists = (repo_root / md_rel).exists()

        rc_pause, out_pause = _run(["python3", "scripts/orchestrator.py", "pause"], cwd=repo_root, env=env, timeout_seconds=30)
        (logs_dir / "plan_pause.txt").write_text(out_pause, encoding="utf-8")
        manifest["outputs"].append(os.fspath((logs_dir / "plan_pause.txt").relative_to(repo_root)))

        rc_resume, out_resume = _run(["python3", "scripts/orchestrator.py", "resume", "--force"], cwd=repo_root, env=env, timeout_seconds=30)
        (logs_dir / "plan_resume.txt").write_text(out_resume, encoding="utf-8")
        manifest["outputs"].append(os.fspath((logs_dir / "plan_resume.txt").relative_to(repo_root)))

        # Trigger A3 gate to generate an approval packet.
        cmd_run = [
            "python3",
            "scripts/orchestrator.py",
            "run",
            "--run-id",
            run_id,
            "--workflow-id",
            "W2_reproduce",
            "--case",
            str(inps.w2_case),
            "--ns",
            ",".join(str(x) for x in inps.w2_ns),
        ]
        rc_gate, out_gate = _run(cmd_run, cwd=repo_root, env=env, timeout_seconds=int(inps.timeout_seconds))
        (logs_dir / "plan_gate.txt").write_text(out_gate, encoding="utf-8")
        manifest["outputs"].append(os.fspath((logs_dir / "plan_gate.txt").relative_to(repo_root)))

        pending = _read_pending_approval(state_path)
        approval_id = (pending or {}).get("approval_id")
        category = (pending or {}).get("category")
        packet_rel = (pending or {}).get("packet_path")
        pending_plan_steps = (pending or {}).get("plan_step_ids")

        packet_has_plan_refs = False
        packet_has_run_card_refs = False
        if isinstance(packet_rel, str) and packet_rel.strip():
            p = repo_root / packet_rel
            if p.exists():
                txt = p.read_text(encoding="utf-8", errors="replace")
                packet_has_plan_refs = ("Plan step(s):" in txt) and ("Plan SSOT:" in txt) and ("Plan view:" in txt)
                packet_has_run_card_refs = ("Run-card:" in txt) and (
                    ("Run-card SHA256:" in txt) or ("Run-card SHA256 (canonical JSON):" in txt)
                )

        rc_approve = None
        out_approve = ""
        if isinstance(approval_id, str) and approval_id.strip():
            rc_approve, out_approve = _run(
                ["python3", "scripts/orchestrator.py", "approve", approval_id],
                cwd=repo_root,
                env=env,
                timeout_seconds=60,
            )
            (logs_dir / "plan_approve.txt").write_text(out_approve, encoding="utf-8")
            manifest["outputs"].append(os.fspath((logs_dir / "plan_approve.txt").relative_to(repo_root)))

        rc_final, out_final = _run(cmd_run, cwd=repo_root, env=env, timeout_seconds=int(inps.timeout_seconds))
        (logs_dir / "plan_final.txt").write_text(out_final, encoding="utf-8")
        manifest["outputs"].append(os.fspath((logs_dir / "plan_final.txt").relative_to(repo_root)))

        st2 = _read_state()
        cur2 = st2.get("current_step") if isinstance(st2.get("current_step"), dict) else {}
        plan2 = st2.get("plan") if isinstance(st2.get("plan"), dict) else {}
        steps2 = plan2.get("steps") if isinstance(plan2.get("steps"), list) else []
        step2 = None
        for s in steps2:
            if isinstance(s, dict) and str(s.get("step_id")) == str(cur2.get("step_id")):
                step2 = s
                break

        reproduce_manifest_has_run_card = False
        try:
            mp = repo_root / "artifacts" / "runs" / run_id / "reproduce" / "manifest.json"
            if mp.exists():
                m = read_json(mp)
                inputs = m.get("inputs") if isinstance(m, dict) else None
                reproduce_manifest_has_run_card = (
                    isinstance(inputs, dict)
                    and isinstance(inputs.get("run_card_path"), str)
                    and isinstance(inputs.get("run_card_sha256"), str)
                )
        except Exception:  # CONTRACT-EXEMPT: CODE-01.5 intentional fallback
            reproduce_manifest_has_run_card = False

        return {
            "run_id": run_id,
            "start_exit_code": int(rc_start),
            "pause_exit_code": int(rc_pause),
            "resume_exit_code": int(rc_resume),
            "gate_exit_code": int(rc_gate),
            "pending_category": category,
            "approval_id": approval_id,
            "approval_packet": packet_rel,
            "pending_plan_step_ids": pending_plan_steps,
            "approval_packet_has_plan_refs": bool(packet_has_plan_refs),
            "approval_packet_has_run_card_refs": bool(packet_has_run_card_refs),
            "run_card_path": run_card_rel,
            "run_card_exists": bool(run_card_exists),
            "reproduce_manifest_has_run_card": bool(reproduce_manifest_has_run_card),
            "plan_md_path": md_rel,
            "plan_md_exists": bool(md_exists),
            "plan_current_step_id": plan1.get("current_step_id") if isinstance(plan1, dict) else None,
            "state_current_step_id": cur1.get("step_id") if isinstance(cur1, dict) else None,
            "state_current_step_in_plan": bool(cur1.get("step_id") in step_ids1) if isinstance(cur1, dict) else False,
            "approve_exit_code": int(rc_approve) if rc_approve is not None else None,
            "final_exit_code": int(rc_final),
            "final_step_status": (step2 or {}).get("status") if isinstance(step2, dict) else None,
            "expected_outputs": {
                "plan_state_json": rel(state_path),
                "plan_md": rel(plan_md_path),
                "run_card": f"artifacts/runs/{run_id}/run_card.json",
                "approval_packet": f"artifacts/runs/{run_id}/approvals/{category or 'A3'}-0001/packet.md",
                "reproduce_manifest": f"artifacts/runs/{run_id}/reproduce/manifest.json",
            },
        }

    def scenario_branching() -> dict[str, Any]:
        """Branching protocol: record candidates, enforce cap, switch active branch."""
        import json as _json

        run_id = f"{inps.tag}-branching"

        cmd_start = [
            "python3",
            "scripts/orchestrator.py",
            "start",
            "--run-id",
            run_id,
            "--workflow-id",
            "W2_reproduce",
            "--force",
        ]
        rc_start, out_start = _run(cmd_start, cwd=repo_root, env=env, timeout_seconds=60)
        (logs_dir / "branching_start.txt").write_text(out_start, encoding="utf-8")
        manifest["outputs"].append(os.fspath((logs_dir / "branching_start.txt").relative_to(repo_root)))

        def _read_state() -> dict[str, Any]:
            if not state_path.exists():
                return {}
            st = read_json(state_path)
            return st if isinstance(st, dict) else {}

        add_exit_codes: list[int] = []
        add_outs: list[str] = []
        for i in range(1, 6):
            cmd_add = [
                "python3",
                "scripts/orchestrator.py",
                "branch",
                "add",
                "--decision-id",
                "W2.S1",
                "--description",
                f"candidate {i}",
            ]
            rc_add, out_add = _run(cmd_add, cwd=repo_root, env=env, timeout_seconds=30)
            add_exit_codes.append(int(rc_add))
            add_outs.append(out_add)
        (logs_dir / "branching_add.txt").write_text("\n".join(add_outs), encoding="utf-8")
        manifest["outputs"].append(os.fspath((logs_dir / "branching_add.txt").relative_to(repo_root)))

        # Attempt to exceed cap without override (expected failure).
        cmd_over = [
            "python3",
            "scripts/orchestrator.py",
            "branch",
            "add",
            "--decision-id",
            "W2.S1",
            "--description",
            "candidate 6",
        ]
        rc_over, out_over = _run(cmd_over, cwd=repo_root, env=env, timeout_seconds=30)
        (logs_dir / "branching_over_cap.txt").write_text(out_over, encoding="utf-8")
        manifest["outputs"].append(os.fspath((logs_dir / "branching_over_cap.txt").relative_to(repo_root)))

        # Add with explicit cap override.
        cmd_add6 = [
            "python3",
            "scripts/orchestrator.py",
            "branch",
            "add",
            "--decision-id",
            "W2.S1",
            "--description",
            "candidate 6",
            "--cap-override",
            "6",
        ]
        rc_add6, out_add6 = _run(cmd_add6, cwd=repo_root, env=env, timeout_seconds=30)
        (logs_dir / "branching_add6.txt").write_text(out_add6, encoding="utf-8")
        manifest["outputs"].append(os.fspath((logs_dir / "branching_add6.txt").relative_to(repo_root)))

        # Switch to b3 (deterministic for auto branch ids).
        cmd_switch = [
            "python3",
            "scripts/orchestrator.py",
            "branch",
            "switch",
            "--decision-id",
            "W2.S1",
            "--branch-id",
            "b3",
            "--previous-status",
            "failed",
            "--note",
            "regression switch",
        ]
        rc_switch, out_switch = _run(cmd_switch, cwd=repo_root, env=env, timeout_seconds=30)
        (logs_dir / "branching_switch.txt").write_text(out_switch, encoding="utf-8")
        manifest["outputs"].append(os.fspath((logs_dir / "branching_switch.txt").relative_to(repo_root)))

        st = _read_state()
        plan = st.get("plan") if isinstance(st.get("plan"), dict) else {}
        branching = plan.get("branching") if isinstance(plan, dict) else None
        active_branch_id = branching.get("active_branch_id") if isinstance(branching, dict) else None

        decision: dict[str, Any] | None = None
        if isinstance(branching, dict) and isinstance(branching.get("decisions"), list):
            for d in branching["decisions"]:
                if isinstance(d, dict) and str(d.get("decision_id")) == "W2.S1":
                    decision = d
                    break

        branches_total = None
        decision_active_branch_id = None
        decision_cap = None
        decision_cap_override = None
        if isinstance(decision, dict):
            brs = decision.get("branches")
            if isinstance(brs, list):
                branches_total = len([b for b in brs if isinstance(b, dict)])
            decision_active_branch_id = decision.get("active_branch_id")
            decision_cap = decision.get("max_branches")
            decision_cap_override = decision.get("cap_override")

        ledger_has_switch = False
        ledger_has_add = False
        try:
            with ledger_path.open("r", encoding="utf-8") as f:
                for line in f:
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        ev = _json.loads(line)
                    except Exception:  # CONTRACT-EXEMPT: CODE-01.5 skip malformed JSON lines
                        continue
                    if not isinstance(ev, dict):
                        continue
                    if ev.get("event_type") == "branch_switched":
                        ledger_has_switch = True
                    if ev.get("event_type") == "branch_candidate_added":
                        ledger_has_add = True
        except Exception:  # CONTRACT-EXEMPT: CODE-01.5 test assertions catch failure via ledger flags
            pass

        ok = (
            int(rc_start) == 0
            and all(int(x) == 0 for x in add_exit_codes)
            and int(rc_over) != 0
            and int(rc_add6) == 0
            and int(rc_switch) == 0
            and str(active_branch_id or "") == "W2.S1:b3"
            and str(decision_active_branch_id or "") == "b3"
            and int(branches_total or 0) == 6
            and bool(ledger_has_add)
            and bool(ledger_has_switch)
        )

        return {
            "run_id": run_id,
            "ok": ok,
            "start_exit_code": int(rc_start),
            "add_exit_codes": add_exit_codes,
            "over_cap_exit_code": int(rc_over),
            "add6_exit_code": int(rc_add6),
            "switch_exit_code": int(rc_switch),
            "active_branch_id": active_branch_id,
            "decision_active_branch_id": decision_active_branch_id,
            "branches_total": branches_total,
            "decision_cap": decision_cap,
            "decision_cap_override": decision_cap_override,
            "ledger_has_branch_candidate_added": ledger_has_add,
            "ledger_has_branch_switched": ledger_has_switch,
        }

    def scenario_sandbox() -> dict[str, Any]:
        """Sandboxed execution (v0): shell adapter runs in a sandbox and cannot write outside allowlisted dirs."""
        import json as _json
        import uuid as _uuid

        run_id = str(inps.tag)
        step_dir = "adapter_shell_sandbox"
        suffix = _uuid.uuid4().hex[:8]
        forbidden_name = f"SANDBOX_FORBIDDEN_{run_id}_{suffix}.txt"
        forbidden_path = repo_root / forbidden_name
        if forbidden_path.exists():
            try:
                forbidden_path.unlink()
            except Exception:  # CONTRACT-EXEMPT: CODE-01.5 best-effort cleanup
                pass

        run_card_path = out_dir / "sandbox_run_card.json"
        cmd_py = (
            "from pathlib import Path\n"
            "import sys\n"
            f"forbidden=Path({forbidden_name!r})\n"
            "try:\n"
            "  forbidden.write_text('should_not_write')\n"
            "  print('WRITE_OK')\n"
            "except Exception as e:\n"
            "  print('WRITE_BLOCKED')\n"
            f"out=Path('artifacts/runs/{run_id}/{step_dir}/sandbox_ok.txt')\n"
            "out.parent.mkdir(parents=True, exist_ok=True)\n"
            "out.write_text('ok')\n"
        )
        run_card = {
            "schema_version": 1,
            "run_id": run_id,
            "workflow_id": "ADAPTER_shell_smoke",
            "adapter_id": "shell",
            "artifact_step": step_dir,
            "required_gates": [],
            "budgets": {"timeout_seconds": 60},
            "prompt": {"system": "", "user": "Sandbox regression: forbid writes outside artifacts; allow artifacts writes."},
            "tools": [],
            "evidence_bundle": {},
            "backend": {"kind": "shell", "argv": ["python3", "-c", cmd_py], "cwd": ".", "env": {}},
        }
        run_card_path.write_text(_json.dumps(run_card, indent=2, sort_keys=True, ensure_ascii=False) + "\n", encoding="utf-8")
        manifest["outputs"].append(os.fspath(run_card_path.relative_to(repo_root)))

        cmd_run = [
            "python3",
            "scripts/orchestrator.py",
            "run",
            "--run-id",
            run_id,
            "--workflow-id",
            "ADAPTER_shell_smoke",
            "--force",
            "--run-card",
            os.fspath(run_card_path.relative_to(repo_root)),
            "--sandbox",
            "local_copy",
            "--sandbox-network",
            "disabled",
        ]
        rc_gate, out_gate = _run(cmd_run, cwd=repo_root, env=env, timeout_seconds=60)
        (logs_dir / "sandbox_gate.txt").write_text(out_gate, encoding="utf-8")
        manifest["outputs"].append(os.fspath((logs_dir / "sandbox_gate.txt").relative_to(repo_root)))

        pending = _read_pending_approval(state_path)
        approval_id = (pending or {}).get("approval_id")
        category = (pending or {}).get("category")
        packet_rel = (pending or {}).get("packet_path")

        rc_approve = None
        out_approve = ""
        if isinstance(approval_id, str) and approval_id.strip():
            rc_approve, out_approve = _run(
                ["python3", "scripts/orchestrator.py", "approve", approval_id],
                cwd=repo_root,
                env=env,
                timeout_seconds=60,
            )
            (logs_dir / "sandbox_approve.txt").write_text(out_approve, encoding="utf-8")
            manifest["outputs"].append(os.fspath((logs_dir / "sandbox_approve.txt").relative_to(repo_root)))

        rc_final, out_final = _run(cmd_run, cwd=repo_root, env=env, timeout_seconds=120)
        (logs_dir / "sandbox_final.txt").write_text(out_final, encoding="utf-8")
        manifest["outputs"].append(os.fspath((logs_dir / "sandbox_final.txt").relative_to(repo_root)))

        sandbox_ok_path = repo_root / "artifacts" / "runs" / run_id / step_dir / "sandbox_ok.txt"
        sandbox_ok_exists = sandbox_ok_path.exists()
        adapter_stdout_path = repo_root / "artifacts" / "runs" / run_id / step_dir / "logs" / "stdout.txt"
        stdout_has_write_blocked = False
        try:
            if adapter_stdout_path.exists():
                txt = adapter_stdout_path.read_text(encoding="utf-8", errors="replace")
                stdout_has_write_blocked = ("WRITE_BLOCKED" in txt) and ("WRITE_OK" not in txt)
        except Exception:  # CONTRACT-EXEMPT: CODE-01.5 intentional fallback
            stdout_has_write_blocked = False
        forbidden_exists = forbidden_path.exists()
        if forbidden_exists:
            try:
                forbidden_path.unlink()
            except Exception:  # CONTRACT-EXEMPT: CODE-01.5 best-effort cleanup
                pass

        ok = (
            int(rc_gate) == 3
            and str(category or "") == "A3"
            and int(rc_final) == 0
            and bool(sandbox_ok_exists)
            and not bool(forbidden_exists)
        )

        return {
            "run_id": run_id,
            "ok": ok,
            "gate_exit_code": int(rc_gate),
            "pending_category": category,
            "approval_id": approval_id,
            "approval_packet": packet_rel,
            "approve_exit_code": int(rc_approve) if rc_approve is not None else None,
            "final_exit_code": int(rc_final),
            "forbidden_path": forbidden_name,
            "forbidden_exists_after_run": bool(forbidden_exists),
            "sandbox_ok_exists": bool(sandbox_ok_exists),
            "stdout_has_write_blocked": bool(stdout_has_write_blocked),
            "expected_outputs": {
                "approval_packet": f"artifacts/runs/{run_id}/approvals/{category or 'A3'}-0001/packet.md",
                "adapter_manifest": f"artifacts/runs/{run_id}/{step_dir}/manifest.json",
                "adapter_summary": f"artifacts/runs/{run_id}/{step_dir}/summary.json",
                "adapter_analysis": f"artifacts/runs/{run_id}/{step_dir}/analysis.json",
                "adapter_run_card": f"artifacts/runs/{run_id}/{step_dir}/run_card.json",
                "adapter_stdout": f"artifacts/runs/{run_id}/{step_dir}/logs/stdout.txt",
                "adapter_stderr": f"artifacts/runs/{run_id}/{step_dir}/logs/stderr.txt",
                "sandbox_ok": f"artifacts/runs/{run_id}/{step_dir}/sandbox_ok.txt",
            },
        }

    def scenario_w3() -> dict[str, Any]:
        run_id = f"{inps.tag}-w3"
        cmd_run = [
            "python3",
            "scripts/orchestrator.py",
            "run",
            "--run-id",
            run_id,
            "--workflow-id",
            "W3_revision",
            "--paper-root",
            str(inps.w3_paper_root),
            "--tex-main",
            str(inps.w3_tex_main),
        ]
        rc_gate, out_gate = _run(cmd_run, cwd=repo_root, env=env, timeout_seconds=int(inps.timeout_seconds))
        (logs_dir / "w3_gate.txt").write_text(out_gate, encoding="utf-8")
        manifest["outputs"].append(os.fspath((logs_dir / "w3_gate.txt").relative_to(repo_root)))

        pending = _read_pending_approval(state_path)
        approval_id = (pending or {}).get("approval_id")
        category = (pending or {}).get("category")
        packet_rel = (pending or {}).get("packet_path")

        rc_approve = None
        out_approve = ""
        if isinstance(approval_id, str) and approval_id.strip():
            rc_approve, out_approve = _run(
                ["python3", "scripts/orchestrator.py", "approve", approval_id],
                cwd=repo_root,
                env=env,
                timeout_seconds=60,
            )
            (logs_dir / "w3_approve.txt").write_text(out_approve, encoding="utf-8")
            manifest["outputs"].append(os.fspath((logs_dir / "w3_approve.txt").relative_to(repo_root)))

        rc_final, out_final = _run(cmd_run, cwd=repo_root, env=env, timeout_seconds=int(inps.timeout_seconds))
        (logs_dir / "w3_final.txt").write_text(out_final, encoding="utf-8")
        manifest["outputs"].append(os.fspath((logs_dir / "w3_final.txt").relative_to(repo_root)))

        return {
            "run_id": run_id,
            "gate_exit_code": int(rc_gate),
            "pending_category": category,
            "approval_id": approval_id,
            "approval_packet": packet_rel,
            "approve_exit_code": int(rc_approve) if rc_approve is not None else None,
            "final_exit_code": int(rc_final),
            "expected_outputs": {
                "approval_packet": f"artifacts/runs/{run_id}/approvals/{category or 'A4'}-0001/packet.md",
                "revision_manifest": f"artifacts/runs/{run_id}/revision/manifest.json",
                "revision_summary": f"artifacts/runs/{run_id}/revision/summary.json",
                "revision_analysis": f"artifacts/runs/{run_id}/revision/analysis.json",
            },
        }

    def scenario_survey_polish() -> dict[str, Any]:
        run_id = f"{inps.tag}-survey-polish"
        cmd_run = [
            "python3",
            "scripts/orchestrator.py",
            "run",
            "--run-id",
            run_id,
            "--workflow-id",
            "W3_literature_survey_polish",
        ]
        rc_gate, out_gate = _run(cmd_run, cwd=repo_root, env=env, timeout_seconds=int(inps.timeout_seconds))
        (logs_dir / "survey_polish_gate.txt").write_text(out_gate, encoding="utf-8")
        manifest["outputs"].append(os.fspath((logs_dir / "survey_polish_gate.txt").relative_to(repo_root)))

        pending = _read_pending_approval(state_path)
        approval_id = (pending or {}).get("approval_id")
        category = (pending or {}).get("category")
        packet_rel = (pending or {}).get("packet_path")

        rc_approve = None
        out_approve = ""
        if isinstance(approval_id, str) and approval_id.strip():
            rc_approve, out_approve = _run(
                ["python3", "scripts/orchestrator.py", "approve", approval_id],
                cwd=repo_root,
                env=env,
                timeout_seconds=60,
            )
            (logs_dir / "survey_polish_approve.txt").write_text(out_approve, encoding="utf-8")
            manifest["outputs"].append(os.fspath((logs_dir / "survey_polish_approve.txt").relative_to(repo_root)))

        rc_final, out_final = _run(cmd_run, cwd=repo_root, env=env, timeout_seconds=int(inps.timeout_seconds))
        (logs_dir / "survey_polish_final.txt").write_text(out_final, encoding="utf-8")
        manifest["outputs"].append(os.fspath((logs_dir / "survey_polish_final.txt").relative_to(repo_root)))

        return {
            "run_id": run_id,
            "gate_exit_code": int(rc_gate),
            "pending_category": category,
            "approval_id": approval_id,
            "approval_packet": packet_rel,
            "approve_exit_code": int(rc_approve) if rc_approve is not None else None,
            "final_exit_code": int(rc_final),
            "expected_outputs": {
                "approval_packet": f"artifacts/runs/{run_id}/approvals/{category or 'A4'}-0001/packet.md",
                "survey_manifest": f"artifacts/runs/{run_id}/literature_survey/manifest.json",
                "survey_summary": f"artifacts/runs/{run_id}/literature_survey/summary.json",
                "survey_analysis": f"artifacts/runs/{run_id}/literature_survey/analysis.json",
                "polish_manifest": f"artifacts/runs/{run_id}/literature_survey_polish/manifest.json",
                "polish_summary": f"artifacts/runs/{run_id}/literature_survey_polish/summary.json",
                "polish_analysis": f"artifacts/runs/{run_id}/literature_survey_polish/analysis.json",
                "paper_manifest": f"artifacts/runs/{run_id}/literature_survey_polish/paper/paper_manifest.json",
                "paper_export_manifest": f"artifacts/runs/{run_id}/literature_survey_polish/paper/export_manifest.json",
            },
        }

    def scenario_bypass() -> dict[str, Any]:
        """Attempt to bypass approvals by pre-populating gate_satisfied without approval_history."""
        def start_run(run_id: str, workflow_id: str) -> None:
            rc, out = _run(
                ["python3", "scripts/orchestrator.py", "start", "--run-id", run_id, "--workflow-id", workflow_id, "--force"],
                cwd=repo_root,
                env=env,
                timeout_seconds=60,
            )
            (logs_dir / f"bypass_start_{_safe_slug(run_id)}.txt").write_text(out, encoding="utf-8")
            manifest["outputs"].append(os.fspath((logs_dir / f"bypass_start_{_safe_slug(run_id)}.txt").relative_to(repo_root)))
            if rc != 0:
                errors.append(f"bypass start failed for {run_id} (exit_code={rc})")

        # A3 bypass attempt (W2_reproduce)
        run_id_a3 = f"{inps.tag}-bypass-a3"
        start_run(run_id_a3, "W2_reproduce")
        inject_fake_gate_satisfied(category="A3", approval_id="A3-FAKE")
        cmd_run_a3 = [
            "python3",
            "scripts/orchestrator.py",
            "run",
            "--run-id",
            run_id_a3,
            "--workflow-id",
            "W2_reproduce",
            "--case",
            str(inps.w2_case),
            "--ns",
            ",".join(str(x) for x in inps.w2_ns),
        ]
        rc_a3, out_a3 = _run(cmd_run_a3, cwd=repo_root, env=env, timeout_seconds=int(inps.timeout_seconds))
        (logs_dir / "bypass_a3_run.txt").write_text(out_a3, encoding="utf-8")
        manifest["outputs"].append(os.fspath((logs_dir / "bypass_a3_run.txt").relative_to(repo_root)))
        pending_a3 = _read_pending_approval(state_path)

        # A4 bypass attempt (W3_revision)
        run_id_a4 = f"{inps.tag}-bypass-a4"
        start_run(run_id_a4, "W3_revision")
        inject_fake_gate_satisfied(category="A4", approval_id="A4-FAKE")
        cmd_run_a4 = [
            "python3",
            "scripts/orchestrator.py",
            "run",
            "--run-id",
            run_id_a4,
            "--workflow-id",
            "W3_revision",
            "--paper-root",
            str(inps.w3_paper_root),
            "--tex-main",
            str(inps.w3_tex_main),
        ]
        rc_a4, out_a4 = _run(cmd_run_a4, cwd=repo_root, env=env, timeout_seconds=int(inps.timeout_seconds))
        (logs_dir / "bypass_a4_run.txt").write_text(out_a4, encoding="utf-8")
        manifest["outputs"].append(os.fspath((logs_dir / "bypass_a4_run.txt").relative_to(repo_root)))
        pending_a4 = _read_pending_approval(state_path)

        return {
            "a3": {
                "run_id": run_id_a3,
                "exit_code": int(rc_a3),
                "pending_approval": pending_a3,
            },
            "a4": {
                "run_id": run_id_a4,
                "exit_code": int(rc_a4),
                "pending_approval": pending_a4,
            },
        }

    def scenario_wcompute() -> dict[str, Any]:
        run_id = f"{inps.tag}-wcompute"
        run_card = str(inps.wcompute_run_card)
        cmd_run = [
            "python3",
            "scripts/orchestrator.py",
            "run",
            "--run-id",
            run_id,
            "--workflow-id",
            "W_compute",
            "--run-card",
            run_card,
            "--trust-project",
        ]
        rc_gate, out_gate = _run(cmd_run, cwd=repo_root, env=env, timeout_seconds=int(inps.timeout_seconds))
        (logs_dir / "wcompute_gate.txt").write_text(out_gate, encoding="utf-8")
        manifest["outputs"].append(os.fspath((logs_dir / "wcompute_gate.txt").relative_to(repo_root)))

        pending = _read_pending_approval(state_path)
        approval_id = (pending or {}).get("approval_id")
        category = (pending or {}).get("category")
        packet_rel = (pending or {}).get("packet_path")

        rc_approve = None
        out_approve = ""
        if isinstance(approval_id, str) and approval_id.strip():
            rc_approve, out_approve = _run(
                ["python3", "scripts/orchestrator.py", "approve", approval_id],
                cwd=repo_root,
                env=env,
                timeout_seconds=60,
            )
            (logs_dir / "wcompute_approve.txt").write_text(out_approve, encoding="utf-8")
            manifest["outputs"].append(os.fspath((logs_dir / "wcompute_approve.txt").relative_to(repo_root)))

        rc_final, out_final = _run(cmd_run, cwd=repo_root, env=env, timeout_seconds=int(inps.timeout_seconds))
        (logs_dir / "wcompute_final.txt").write_text(out_final, encoding="utf-8")
        manifest["outputs"].append(os.fspath((logs_dir / "wcompute_final.txt").relative_to(repo_root)))

        return {
            "run_id": run_id,
            "gate_exit_code": int(rc_gate),
            "pending_category": category,
            "approval_id": approval_id,
            "approval_packet": packet_rel,
            "approve_exit_code": int(rc_approve) if rc_approve is not None else None,
            "final_exit_code": int(rc_final),
            "expected_outputs": {
                "run_card": f"artifacts/runs/{run_id}/run_card.json",
                "analysis": f"artifacts/runs/{run_id}/w_compute/analysis.json",
                "manifest": f"artifacts/runs/{run_id}/w_compute/manifest.json",
                "summary": f"artifacts/runs/{run_id}/w_compute/summary.json",
                "report": f"artifacts/runs/{run_id}/w_compute/report.md",
            },
        }

    w2: dict[str, Any] = {}
    w3: dict[str, Any] = {}
    survey_polish: dict[str, Any] = {}
    wcompute: dict[str, Any] = {}
    bypass: dict[str, Any] = {}
    sandbox: dict[str, Any] = {}
    plan: dict[str, Any] = {}
    branching: dict[str, Any] = {}
    project_init: dict[str, Any] = {}
    scenarios = set(str(s).strip().lower() for s in inps.scenarios if str(s).strip())
    if not errors and "project_init" in scenarios:
        project_init = scenario_project_init()
    if not errors and "plan" in scenarios:
        plan = scenario_plan()
    if not errors and ("branching" in scenarios or "branch" in scenarios):
        branching = scenario_branching()
    if not errors and "sandbox" in scenarios:
        sandbox = scenario_sandbox()
    if not errors and "w2" in scenarios:
        w2 = scenario_w2()
    if not errors and "wcompute" in scenarios:
        wcompute = scenario_wcompute()
    if not errors and "w3" in scenarios:
        w3 = scenario_w3()
    if not errors and "survey_polish" in scenarios:
        survey_polish = scenario_survey_polish()
    if not errors and "bypass" in scenarios:
        bypass = scenario_bypass()

    # post-checks (packets + output paths)
    def require_path(rel: str) -> None:
        if not rel:
            return
        p = repo_root / rel
        if not p.exists():
            errors.append(f"missing expected path: {rel}")

    if w2:
        if w2.get("pending_category") != "A3":
            errors.append(f"W2 expected pending category A3, got {w2.get('pending_category')!r}")
        if w2.get("gate_exit_code") != 3:
            errors.append(f"W2 expected gate exit code 3, got {w2.get('gate_exit_code')}")
        if w2.get("approve_exit_code") not in (0, None):
            errors.append(f"W2 expected approve exit code 0, got {w2.get('approve_exit_code')}")
        if w2.get("final_exit_code") != 0:
            errors.append(f"W2 expected final exit code 0, got {w2.get('final_exit_code')}")
        require_path(str(w2.get("approval_packet") or ""))
        require_path(w2["expected_outputs"]["reproduce_manifest"])
        require_path(w2["expected_outputs"]["reproduce_summary"])
        require_path(w2["expected_outputs"]["reproduce_analysis"])

    if project_init:
        if project_init.get("init_exit_code") != 0:
            errors.append(f"project_init expected init exit code 0, got {project_init.get('init_exit_code')}")
        if project_init.get("status_subdir_exit_code") != 0:
            errors.append(
                f"project_init expected status exit code 0, got {project_init.get('status_subdir_exit_code')}"
            )
        if not bool(project_init.get("status_subdir_state_path_ok")):
            errors.append("project_init expected status_subdir_state_path_ok=true")
        if project_init.get("nested_init_exit_code") != 2:
            errors.append(
                f"project_init expected nested init refusal exit code 2, got {project_init.get('nested_init_exit_code')}"
            )
        if project_init.get("nested_init_allow_exit_code") != 0:
            errors.append(
                f"project_init expected nested init allow exit code 0, got {project_init.get('nested_init_allow_exit_code')}"
            )
        if not bool(project_init.get("nested_state_json_exists")):
            errors.append("project_init expected nested_state_json_exists=true after --allow-nested")
        if project_init.get("pending_category") != "A3":
            errors.append(
                f"project_init expected pending category A3, got {project_init.get('pending_category')!r}"
            )
        if project_init.get("gate_exit_code") != 3:
            errors.append(f"project_init expected gate exit code 3, got {project_init.get('gate_exit_code')}")
        for key in [
            "project_root",
            "state_json",
            "approval_policy_json",
            "ledger_jsonl",
            "kb_index_json",
            "kb_profile_minimal",
            "kb_profile_curated",
            "docs_approval_gates",
            "docs_artifact_contract",
            "docs_eval_gate_contract",
            "plan_md",
            "kb_profile_json",
            "approval_packet",
        ]:
            require_path(str((project_init.get("expected_outputs") or {}).get(key) or ""))

    if plan:
        if plan.get("start_exit_code") != 0:
            errors.append(f"plan expected start exit code 0, got {plan.get('start_exit_code')}")
        if plan.get("pause_exit_code") != 0:
            errors.append(f"plan expected pause exit code 0, got {plan.get('pause_exit_code')}")
        if plan.get("resume_exit_code") != 0:
            errors.append(f"plan expected resume exit code 0, got {plan.get('resume_exit_code')}")
        if plan.get("pending_category") != "A3":
            errors.append(f"plan expected pending category A3, got {plan.get('pending_category')!r}")
        if plan.get("gate_exit_code") != 3:
            errors.append(f"plan expected gate exit code 3, got {plan.get('gate_exit_code')}")
        if plan.get("approve_exit_code") not in (0, None):
            errors.append(f"plan expected approve exit code 0, got {plan.get('approve_exit_code')}")
        if plan.get("final_exit_code") != 0:
            errors.append(f"plan expected final exit code 0, got {plan.get('final_exit_code')}")
        if not bool(plan.get("plan_md_exists")):
            errors.append("plan expected plan_md_exists=true")
        if not bool(plan.get("state_current_step_in_plan")):
            errors.append("plan expected current_step to be present in plan steps")
        if plan.get("plan_current_step_id") != plan.get("state_current_step_id"):
            errors.append(
                f"plan expected plan.current_step_id == current_step.step_id, got {plan.get('plan_current_step_id')!r} vs {plan.get('state_current_step_id')!r}"
            )
        if not bool(plan.get("approval_packet_has_plan_refs")):
            errors.append("plan expected approval packet to contain plan references")
        require_path(str(plan.get("approval_packet") or ""))
        require_path(str((plan.get("expected_outputs") or {}).get("plan_state_json") or ""))
        require_path(str((plan.get("expected_outputs") or {}).get("plan_md") or ""))
        require_path(str((plan.get("expected_outputs") or {}).get("reproduce_manifest") or ""))

    if branching:
        if not bool(branching.get("ok")):
            errors.append("branching expected ok=true")

    if sandbox:
        if sandbox.get("pending_category") != "A3":
            errors.append(f"sandbox expected pending category A3, got {sandbox.get('pending_category')!r}")
        if sandbox.get("gate_exit_code") != 3:
            errors.append(f"sandbox expected gate exit code 3, got {sandbox.get('gate_exit_code')}")
        if sandbox.get("approve_exit_code") not in (0, None):
            errors.append(f"sandbox expected approve exit code 0, got {sandbox.get('approve_exit_code')}")
        if sandbox.get("final_exit_code") != 0:
            errors.append(f"sandbox expected final exit code 0, got {sandbox.get('final_exit_code')}")
        if not bool(sandbox.get("ok")):
            errors.append("sandbox expected ok=true")
        require_path(str(sandbox.get("approval_packet") or ""))
        for key in [
            "adapter_manifest",
            "adapter_summary",
            "adapter_analysis",
            "adapter_run_card",
            "adapter_stdout",
            "adapter_stderr",
            "sandbox_ok",
        ]:
            require_path(str((sandbox.get("expected_outputs") or {}).get(key) or ""))

    if w3:
        if w3.get("pending_category") != "A4":
            errors.append(f"W3 expected pending category A4, got {w3.get('pending_category')!r}")
        if w3.get("gate_exit_code") != 3:
            errors.append(f"W3 expected gate exit code 3, got {w3.get('gate_exit_code')}")
        if w3.get("approve_exit_code") not in (0, None):
            errors.append(f"W3 expected approve exit code 0, got {w3.get('approve_exit_code')}")
        if w3.get("final_exit_code") != 0:
            errors.append(f"W3 expected final exit code 0, got {w3.get('final_exit_code')}")
        require_path(str(w3.get("approval_packet") or ""))
        require_path(w3["expected_outputs"]["revision_manifest"])
        require_path(w3["expected_outputs"]["revision_summary"])
        require_path(w3["expected_outputs"]["revision_analysis"])

    if survey_polish:
        if survey_polish.get("pending_category") != "A4":
            errors.append(
                f"survey_polish expected pending category A4, got {survey_polish.get('pending_category')!r}"
            )
        if survey_polish.get("gate_exit_code") != 3:
            errors.append(f"survey_polish expected gate exit code 3, got {survey_polish.get('gate_exit_code')}")
        if survey_polish.get("approve_exit_code") not in (0, None):
            errors.append(f"survey_polish expected approve exit code 0, got {survey_polish.get('approve_exit_code')}")
        if survey_polish.get("final_exit_code") != 0:
            errors.append(f"survey_polish expected final exit code 0, got {survey_polish.get('final_exit_code')}")
        require_path(str(survey_polish.get("approval_packet") or ""))
        for key in [
            "survey_manifest",
            "survey_summary",
            "survey_analysis",
            "polish_manifest",
            "polish_summary",
            "polish_analysis",
            "paper_manifest",
            "paper_export_manifest",
        ]:
            require_path(str((survey_polish.get("expected_outputs") or {}).get(key) or ""))

    if wcompute:
        if wcompute.get("pending_category") != "A3":
            errors.append(f"W_compute expected pending category A3, got {wcompute.get('pending_category')!r}")
        if wcompute.get("gate_exit_code") != 3:
            errors.append(f"W_compute expected gate exit code 3, got {wcompute.get('gate_exit_code')}")
        if wcompute.get("approve_exit_code") not in (0, None):
            errors.append(f"W_compute expected approve exit code 0, got {wcompute.get('approve_exit_code')}")
        if wcompute.get("final_exit_code") != 0:
            errors.append(f"W_compute expected final exit code 0, got {wcompute.get('final_exit_code')}")
        require_path(str(wcompute.get("approval_packet") or ""))
        require_path(wcompute["expected_outputs"]["run_card"])
        require_path(wcompute["expected_outputs"]["manifest"])
        require_path(wcompute["expected_outputs"]["summary"])
        require_path(wcompute["expected_outputs"]["analysis"])
        require_path(wcompute["expected_outputs"]["report"])

    quality_metrics_dir = out_dir / "quality_metrics"
    quality_metrics_dir.mkdir(parents=True, exist_ok=True)
    quality_metrics: dict[str, Any] = {}
    quality_metrics_paths: dict[str, str] = {}

    def _maybe_write_metrics(*, key: str, run_id: str | None, workflow_id: str | None) -> None:
        if not run_id:
            return
        rid = str(run_id).strip()
        if not rid:
            return
        run_dir = repo_root / "artifacts" / "runs" / rid
        payload = build_run_quality_metrics(
            repo_root=repo_root,
            run_id=rid,
            workflow_id=str(workflow_id) if workflow_id else None,
            ledger_path=ledger_path,
            run_dir=run_dir,
        )
        out_path = quality_metrics_dir / f"{key}.json"
        write_json(out_path, payload)
        rel_out = os.fspath(out_path.relative_to(repo_root))
        manifest["outputs"].append(rel_out)
        quality_metrics_paths[key] = rel_out
        quality_metrics[key] = payload

    _maybe_write_metrics(key="plan", run_id=plan.get("run_id") if isinstance(plan, dict) else None, workflow_id="W2_reproduce")
    _maybe_write_metrics(key="w2", run_id=w2.get("run_id") if isinstance(w2, dict) else None, workflow_id="W2_reproduce")
    _maybe_write_metrics(key="wcompute", run_id=wcompute.get("run_id") if isinstance(wcompute, dict) else None, workflow_id="W_compute")
    _maybe_write_metrics(key="w3", run_id=w3.get("run_id") if isinstance(w3, dict) else None, workflow_id="W3_revision")
    _maybe_write_metrics(
        key="survey_polish",
        run_id=survey_polish.get("run_id") if isinstance(survey_polish, dict) else None,
        workflow_id="W3_literature_survey_polish",
    )

    ok = len(errors) == 0

    analysis["results"] = {
        "ok": ok,
        "errors": errors,
        "orchestrator_init_exit_code": int(rc_init),
        "quality_metrics": quality_metrics,
        "quality_metrics_paths": quality_metrics_paths,
        "project_init": project_init,
        "plan": plan,
        "branching": branching,
        "sandbox": sandbox,
        "w2": w2,
        "wcompute": wcompute,
        "w3": w3,
        "survey_polish": survey_polish,
        "bypass": bypass,
    }
    summary["stats"] = {
        "ok": ok,
        "errors": len(errors),
        "w2_gate_exit_code": int(w2.get("gate_exit_code") or 0) if w2 else None,
        "w2_final_exit_code": int(w2.get("final_exit_code") or 0) if w2 else None,
        "wcompute_gate_exit_code": int(wcompute.get("gate_exit_code") or 0) if wcompute else None,
        "wcompute_final_exit_code": int(wcompute.get("final_exit_code") or 0) if wcompute else None,
        "w3_gate_exit_code": int(w3.get("gate_exit_code") or 0) if w3 else None,
        "w3_final_exit_code": int(w3.get("final_exit_code") or 0) if w3 else None,
        "survey_polish_gate_exit_code": int(survey_polish.get("gate_exit_code") or 0) if survey_polish else None,
        "survey_polish_final_exit_code": int(survey_polish.get("final_exit_code") or 0) if survey_polish else None,
    }
    summary["outputs"] = {
        "artifact_dir": os.fspath(out_dir.relative_to(repo_root)),
        "runtime_dir": os.fspath(runtime_dir.relative_to(repo_root)),
        "logs_dir": os.fspath(logs_dir.relative_to(repo_root)),
    }

    artifact_paths = _write_artifacts(repo_root=repo_root, out_dir=out_dir, manifest=manifest, summary=summary, analysis=analysis)
    return {
        "errors": errors,
        "artifact_paths": artifact_paths,
        "artifact_dir": os.fspath(out_dir.relative_to(repo_root)),
        "w2_run_id": w2.get("run_id") if isinstance(w2, dict) else None,
        "wcompute_run_id": wcompute.get("run_id") if isinstance(wcompute, dict) else None,
        "w3_run_id": w3.get("run_id") if isinstance(w3, dict) else None,
    }
