from __future__ import annotations

import json
import os
import zipfile
from collections import deque
from pathlib import Path
from typing import Any, Optional

from fastapi import FastAPI, HTTPException
from fastapi.responses import HTMLResponse
from pydantic import BaseModel

from ..toolkit._time import utc_now_iso
from ..toolkit.orchestrator_state import (
    append_ledger_event,
    approval_policy_path,
    autoresearch_dir,
    default_state,
    ensure_runtime_dirs,
    ledger_path,
    load_state,
    maybe_mark_needs_recovery,
    save_state,
    state_path,
)

app = FastAPI(title="hep-autoresearch", version="0.0.1")


def _repo_root() -> Path:
    override = os.environ.get("HEP_AUTORESEARCH_ROOT")
    return Path(override).resolve() if override else Path.cwd()


class InitBody(BaseModel):
    force: bool = False
    checkpoint_interval_seconds: Optional[int] = None


class NoteBody(BaseModel):
    note: Optional[str] = None


class ResumeBody(BaseModel):
    note: Optional[str] = None
    force: bool = False


class ApprovalBody(BaseModel):
    note: Optional[str] = None


class ExportBody(BaseModel):
    run_id: Optional[str] = None
    out: Optional[str] = None


@app.get("/", response_class=HTMLResponse)
def ui() -> str:
    # Minimal, dependency-free UI (no build step).
    return """<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>hep-autoresearch</title>
  <style>
    body { font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif; margin: 24px; }
    pre { background: #0b1020; color: #e6e6e6; padding: 12px; border-radius: 8px; overflow: auto; }
    code { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; }
    .row { display: flex; gap: 12px; align-items: center; flex-wrap: wrap; }
    button { padding: 8px 10px; border-radius: 8px; border: 1px solid #d0d7de; background: #fff; cursor: pointer; }
    button:hover { background: #f6f8fa; }
    .danger { border-color: #cf222e; color: #cf222e; }
    .danger:hover { background: #ffebe9; }
    .ok { border-color: #1a7f37; color: #1a7f37; }
    .ok:hover { background: #dafbe1; }
    .muted { color: #6e7781; font-size: 13px; }
  </style>
</head>
<body>
  <h1>hep-autoresearch</h1>
  <p class="muted">Local UI for status/pause/resume/approve/reject/logs/export. Run from a project root (or set HEP_AUTORESEARCH_ROOT).</p>

  <div class="row">
    <button onclick="init()">init</button>
    <button onclick="refresh()">refresh</button>
    <button class="danger" onclick="pause()">pause</button>
    <button class="ok" onclick="resume()">resume</button>
  </div>

  <h2>Status</h2>
  <pre id="status">loading...</pre>

  <h2>Pending approval</h2>
  <div class="row">
    <input id="approvalId" placeholder="approval_id (e.g. A3-0001)" style="padding:8px;border-radius:8px;border:1px solid #d0d7de;min-width:260px;" />
    <button class="ok" onclick="approve()">approve</button>
    <button class="danger" onclick="reject()">reject</button>
  </div>
  <p class="muted">If status shows pending_approval, the UI will auto-fill approval_id.</p>

  <h2>Logs (tail)</h2>
  <div class="row">
    <button onclick="logs()">fetch logs</button>
  </div>
  <pre id="logs">(not loaded)</pre>

  <script>
    async function api(method, path, body) {
      const res = await fetch(path, {
        method,
        headers: body ? { "Content-Type": "application/json" } : undefined,
        body: body ? JSON.stringify(body) : undefined
      });
      if (!res.ok) {
        const txt = await res.text();
        throw new Error(res.status + " " + txt);
      }
      return await res.json();
    }

    async function refresh() {
      const st = await api("GET", "/status");
      document.getElementById("status").textContent = JSON.stringify(st, null, 2);
      const pending = (st && st.pending_approval) ? st.pending_approval.approval_id : null;
      if (pending) document.getElementById("approvalId").value = pending;
    }

    async function init() { await api("POST", "/init", { force: false }); await refresh(); }
    async function pause() { await api("POST", "/pause", { note: "paused from web" }); await refresh(); }
    async function resume() { await api("POST", "/resume", { note: "resumed from web", force: false }); await refresh(); }
    async function approve() {
      const id = document.getElementById("approvalId").value.trim();
      if (!id) return alert("approval_id required");
      await api("POST", "/approve/" + encodeURIComponent(id), { note: "approved from web" });
      await refresh();
    }
    async function reject() {
      const id = document.getElementById("approvalId").value.trim();
      if (!id) return alert("approval_id required");
      await api("POST", "/reject/" + encodeURIComponent(id), { note: "rejected from web" });
      await refresh();
    }
    async function logs() {
      const out = await api("GET", "/logs?tail=50");
      document.getElementById("logs").textContent = JSON.stringify(out, null, 2);
    }

    refresh().catch(e => { document.getElementById("status").textContent = String(e); });
  </script>
</body>
</html>
"""


@app.post("/init")
def init(body: InitBody) -> dict[str, Any]:
    repo_root = _repo_root()
    ensure_runtime_dirs(repo_root)
    st_path = state_path(repo_root)
    if st_path.exists() and not body.force:
        st = load_state(repo_root) or default_state()
        return {"ok": True, "already_initialized": True, "state_path": os.fspath(st_path), "state": st}

    st = default_state()
    if body.checkpoint_interval_seconds is not None:
        st["checkpoints"]["checkpoint_interval_seconds"] = int(body.checkpoint_interval_seconds)
    save_state(repo_root, st)
    append_ledger_event(repo_root, event_type="initialized", run_id=None, workflow_id=None, details={"via": "web"})
    return {"ok": True, "already_initialized": False, "state_path": os.fspath(st_path), "state": st}


@app.get("/status")
def status() -> dict[str, Any]:
    repo_root = _repo_root()
    st = load_state(repo_root)
    if st is None:
        raise HTTPException(status_code=404, detail="not initialized (POST /init, or run autoresearch init)")
    maybe_mark_needs_recovery(repo_root, st)

    return {
        "ok": True,
        "run_status": st.get("run_status"),
        "run_id": st.get("run_id"),
        "workflow_id": st.get("workflow_id"),
        "current_step": st.get("current_step"),
        "checkpoints": st.get("checkpoints"),
        "pending_approval": st.get("pending_approval"),
        "gate_satisfied": st.get("gate_satisfied"),
        "artifacts": st.get("artifacts"),
        "notes": st.get("notes"),
        "stop_files": {"pause": (repo_root / ".pause").exists(), "stop": (repo_root / ".stop").exists()},
        "paths": {
            "repo_root": os.fspath(repo_root),
            "state_path": os.fspath(state_path(repo_root)),
            "approval_policy": os.fspath(approval_policy_path(repo_root)),
            "runtime_dir": os.fspath(autoresearch_dir(repo_root)),
        },
    }


@app.post("/pause")
def pause(body: NoteBody) -> dict[str, Any]:
    repo_root = _repo_root()
    ensure_runtime_dirs(repo_root)
    st = load_state(repo_root) or default_state()

    (repo_root / ".pause").write_text("paused\n", encoding="utf-8")
    if st.get("run_status") != "paused":
        st["paused_from_status"] = st.get("run_status")
    st["run_status"] = "paused"
    st["notes"] = body.note or "paused by user (web)"
    save_state(repo_root, st)
    append_ledger_event(repo_root, event_type="paused", run_id=st.get("run_id"), workflow_id=st.get("workflow_id"), details={"via": "web", "note": body.note or ""})
    return {"ok": True, "state": st}


@app.post("/resume")
def resume(body: ResumeBody) -> dict[str, Any]:
    repo_root = _repo_root()
    ensure_runtime_dirs(repo_root)
    st = load_state(repo_root) or default_state()

    pending = st.get("pending_approval")
    if pending:
        raise HTTPException(status_code=409, detail=f"cannot resume while awaiting approval ({pending.get('approval_id')})")

    pause_file = repo_root / ".pause"
    if pause_file.exists():
        pause_file.unlink()

    if st.get("run_status") in {"idle", "completed", "failed"} and not body.force:
        raise HTTPException(status_code=409, detail=f"cannot resume from status={st.get('run_status')} (use start or force=true)")

    restored = st.pop("paused_from_status", None)
    st["run_status"] = restored or "running"
    st["notes"] = body.note or "resumed by user (web)"
    st.setdefault("checkpoints", {})["last_checkpoint_at"] = utc_now_iso().replace("+00:00", "Z")
    save_state(repo_root, st)
    append_ledger_event(repo_root, event_type="resumed", run_id=st.get("run_id"), workflow_id=st.get("workflow_id"), details={"via": "web", "note": body.note or ""})
    return {"ok": True, "state": st}


@app.post("/approve/{approval_id}")
def approve(approval_id: str, body: ApprovalBody) -> dict[str, Any]:
    repo_root = _repo_root()
    ensure_runtime_dirs(repo_root)
    st = load_state(repo_root) or default_state()

    pending = st.get("pending_approval") or {}
    if pending.get("approval_id") != approval_id:
        raise HTTPException(status_code=404, detail=f"no matching pending approval: {approval_id}")

    category = pending.get("category")
    st["pending_approval"] = None
    st["run_status"] = "running"
    st["notes"] = body.note or f"approved {approval_id} (web)"
    if category:
        st.setdefault("gate_satisfied", {})[str(category)] = approval_id
    st.setdefault("approval_history", []).append(
        {"ts": utc_now_iso().replace("+00:00", "Z"), "approval_id": approval_id, "category": category, "decision": "approved", "note": body.note or "", "via": "web"}
    )
    save_state(repo_root, st)
    append_ledger_event(repo_root, event_type="approval_approved", run_id=st.get("run_id"), workflow_id=st.get("workflow_id"), details={"via": "web", "approval_id": approval_id, "category": category, "note": body.note or ""})
    return {"ok": True, "state": st}


@app.post("/reject/{approval_id}")
def reject(approval_id: str, body: ApprovalBody) -> dict[str, Any]:
    repo_root = _repo_root()
    ensure_runtime_dirs(repo_root)
    st = load_state(repo_root) or default_state()

    pending = st.get("pending_approval") or {}
    if pending.get("approval_id") != approval_id:
        raise HTTPException(status_code=404, detail=f"no matching pending approval: {approval_id}")

    category = pending.get("category")
    (repo_root / ".pause").write_text("paused\n", encoding="utf-8")
    st["pending_approval"] = None
    st["run_status"] = "paused"
    st["notes"] = body.note or f"rejected {approval_id} (web)"
    st.setdefault("approval_history", []).append(
        {"ts": utc_now_iso().replace("+00:00", "Z"), "approval_id": approval_id, "category": category, "decision": "rejected", "note": body.note or "", "via": "web"}
    )
    save_state(repo_root, st)
    append_ledger_event(repo_root, event_type="approval_rejected", run_id=st.get("run_id"), workflow_id=st.get("workflow_id"), details={"via": "web", "approval_id": approval_id, "category": category, "note": body.note or ""})
    return {"ok": True, "state": st}


@app.get("/logs")
def logs(run_id: Optional[str] = None, tail: int = 50) -> dict[str, Any]:
    repo_root = _repo_root()
    ensure_runtime_dirs(repo_root)
    ledger = ledger_path(repo_root)
    if not ledger.exists():
        raise HTTPException(status_code=404, detail="ledger missing (run /init first)")

    st = load_state(repo_root) or {}
    target_run_id = run_id or st.get("run_id")

    buf: deque[dict[str, Any]] = deque(maxlen=int(tail))
    with ledger.open("r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                event = json.loads(line)
            except Exception:  # CONTRACT-EXEMPT: CODE-01.5 skip malformed ledger lines
                continue
            if target_run_id and event.get("run_id") != target_run_id:
                continue
            buf.append(event)
    return {"ok": True, "run_id": target_run_id, "events": list(buf)}


@app.post("/export")
def export(body: ExportBody) -> dict[str, Any]:
    repo_root = _repo_root()
    ensure_runtime_dirs(repo_root)
    st = load_state(repo_root) or {}
    run_id = body.run_id or st.get("run_id")
    if not run_id:
        raise HTTPException(status_code=400, detail="missing run_id (pass run_id or start a run first)")

    out_path = Path(body.out).expanduser() if body.out else (repo_root / "exports" / f"{run_id}.zip")
    if not out_path.is_absolute():
        out_path = (repo_root / out_path).resolve()
    out_path.parent.mkdir(parents=True, exist_ok=True)

    include_dirs = [
        repo_root / "artifacts" / "runs" / run_id,
        repo_root / "team" / "runs" / run_id,
    ]
    with zipfile.ZipFile(out_path, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        for base in include_dirs:
            if not base.exists():
                continue
            for p in base.rglob("*"):
                if p.is_file():
                    zf.write(p, arcname=os.fspath(p.relative_to(repo_root)))
    append_ledger_event(repo_root, event_type="exported", run_id=run_id, workflow_id=st.get("workflow_id"), details={"via": "web", "out": os.fspath(out_path)})
    return {"ok": True, "out": os.fspath(out_path)}
