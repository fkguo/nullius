#!/usr/bin/env python3

from __future__ import annotations

import argparse
import os
import subprocess
import sys
from pathlib import Path
from typing import Any

REPO_ROOT = Path(__file__).resolve().parents[1]
SRC_ROOT = REPO_ROOT / "src"
sys.path.insert(0, str(SRC_ROOT if SRC_ROOT.exists() else REPO_ROOT))

from hep_autoresearch.toolkit._git import try_get_git_metadata  # noqa: E402
from hep_autoresearch.toolkit._json import read_json, write_json  # noqa: E402
from hep_autoresearch.toolkit._paths import manifest_cwd  # noqa: E402
from hep_autoresearch.toolkit._time import utc_now_iso  # noqa: E402
from hep_autoresearch.toolkit.artifact_report import write_artifact_report  # noqa: E402


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


def main() -> int:
    parser = argparse.ArgumentParser(description="Adapter smoke runner (offline, deterministic).")
    parser.add_argument("--tag", required=True, help="Run tag / run-id (artifacts/runs/<tag>/...).")
    parser.add_argument(
        "--workflow-id",
        default="ADAPTER_shell_smoke",
        help="Adapter workflow id to run (default: ADAPTER_shell_smoke).",
    )
    parser.add_argument(
        "--timeout-seconds",
        type=int,
        default=120,
        help="Timeout per orchestrator invocation (default: 120).",
    )
    parser.add_argument(
        "--runtime-dir",
        help="Isolated runtime dir for .autopilot state/ledger (relative to repo root by default).",
    )
    args = parser.parse_args()

    tag = str(args.tag).strip()
    workflow_id = str(args.workflow_id).strip()
    if not tag:
        raise ValueError("--tag is required")
    if "/" in tag or "\\" in tag or ".." in tag:
        raise ValueError("tag/run-id must not contain path separators or '..'")

    created_at = utc_now_iso().replace("+00:00", "Z")
    out_dir = REPO_ROOT / "artifacts" / "runs" / tag / "adapter_smoke_regression"
    logs_dir = out_dir / "logs"
    logs_dir.mkdir(parents=True, exist_ok=True)

    runtime_rel = args.runtime_dir or os.fspath((out_dir / ".autopilot").relative_to(REPO_ROOT))
    runtime_dir = (Path(runtime_rel) if Path(runtime_rel).is_absolute() else (REPO_ROOT / runtime_rel)).resolve()
    runtime_dir.mkdir(parents=True, exist_ok=True)
    state_path = runtime_dir / "state.json"

    env = dict(os.environ)
    env["HEP_AUTOPILOT_DIR"] = runtime_rel

    errors: list[str] = []

    manifest: dict[str, Any] = {
        "schema_version": 1,
        "created_at": created_at,
        "command": "python3 scripts/run_adapter_smoke.py",
        "cwd": manifest_cwd(repo_root=REPO_ROOT, cwd=REPO_ROOT),
        "params": {
            "tag": tag,
            "workflow_id": workflow_id,
            "runtime_dir": runtime_rel,
            "timeout_seconds": int(args.timeout_seconds),
        },
        "versions": {"python": os.sys.version.split()[0]},
        "outputs": [
            os.fspath((out_dir / "manifest.json").relative_to(REPO_ROOT)),
            os.fspath((out_dir / "summary.json").relative_to(REPO_ROOT)),
            os.fspath((out_dir / "analysis.json").relative_to(REPO_ROOT)),
            os.fspath((out_dir / "report.md").relative_to(REPO_ROOT)),
        ],
    }
    git_meta = try_get_git_metadata(REPO_ROOT)
    if git_meta:
        manifest["git"] = git_meta

    summary: dict[str, Any] = {
        "schema_version": 1,
        "created_at": created_at,
        "definitions": {"kind": "adapter_smoke_regression"},
        "stats": {},
        "outputs": {},
    }
    analysis: dict[str, Any] = {
        "schema_version": 1,
        "created_at": created_at,
        "inputs": {"tag": tag, "workflow_id": workflow_id, "runtime_dir": runtime_rel},
        "results": {},
    }

    # init (isolated runtime dir)
    rc_init, out_init = _run(
        ["python3", "scripts/orchestrator.py", "init", "--force"],
        cwd=REPO_ROOT,
        env=env,
        timeout_seconds=min(60, int(args.timeout_seconds)),
    )
    (logs_dir / "init.txt").write_text(out_init, encoding="utf-8")
    manifest["outputs"].append(os.fspath((logs_dir / "init.txt").relative_to(REPO_ROOT)))
    analysis["results"]["orchestrator_init_exit_code"] = int(rc_init)
    if rc_init != 0:
        errors.append(f"orchestrator init failed (exit_code={rc_init})")

    cmd_run = [
        "python3",
        "scripts/orchestrator.py",
        "run",
        "--run-id",
        tag,
        "--workflow-id",
        workflow_id,
    ]
    rc_gate, out_gate = _run(cmd_run, cwd=REPO_ROOT, env=env, timeout_seconds=int(args.timeout_seconds))
    (logs_dir / "run_gate.txt").write_text(out_gate, encoding="utf-8")
    manifest["outputs"].append(os.fspath((logs_dir / "run_gate.txt").relative_to(REPO_ROOT)))

    pending = _read_pending_approval(state_path)
    approval_id = (pending or {}).get("approval_id")
    category = (pending or {}).get("category")
    packet_rel = (pending or {}).get("packet_path")

    rc_approve = None
    out_approve = ""
    if isinstance(approval_id, str) and approval_id.strip():
        rc_approve, out_approve = _run(
            ["python3", "scripts/orchestrator.py", "approve", approval_id],
            cwd=REPO_ROOT,
            env=env,
            timeout_seconds=60,
        )
        (logs_dir / "approve.txt").write_text(out_approve, encoding="utf-8")
        manifest["outputs"].append(os.fspath((logs_dir / "approve.txt").relative_to(REPO_ROOT)))

    rc_final, out_final = _run(cmd_run, cwd=REPO_ROOT, env=env, timeout_seconds=int(args.timeout_seconds))
    (logs_dir / "run_final.txt").write_text(out_final, encoding="utf-8")
    manifest["outputs"].append(os.fspath((logs_dir / "run_final.txt").relative_to(REPO_ROOT)))

    analysis["results"].update(
        {
            "gate_exit_code": int(rc_gate),
            "pending_category": category,
            "approval_id": approval_id,
            "approval_packet": packet_rel,
            "approve_exit_code": int(rc_approve) if rc_approve is not None else None,
            "final_exit_code": int(rc_final),
        }
    )
    summary["stats"].update(
        {
            "errors": int(len(errors)),
            "gate_exit_code": int(rc_gate),
            "final_exit_code": int(rc_final),
        }
    )

    # Write regression artifacts.
    out_dir.mkdir(parents=True, exist_ok=True)
    write_json(out_dir / "manifest.json", manifest)
    write_json(out_dir / "summary.json", summary)
    write_json(out_dir / "analysis.json", analysis)
    _ = write_artifact_report(repo_root=REPO_ROOT, artifact_dir=out_dir, manifest=manifest, summary=summary, analysis=analysis)

    if errors:
        print("[warn] errors:")
        for e in errors:
            print(f"- {e}")
        return 2
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
