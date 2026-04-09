from __future__ import annotations

import json
import os
from collections import deque
from pathlib import Path
from typing import Any, Optional

from fastapi import FastAPI, HTTPException
from fastapi.responses import HTMLResponse

from ..orchestrator_cli import _status_effective_run_status
from ..toolkit.orchestrator_state import approval_policy_path, autoresearch_dir, ledger_path, load_state, state_path

app = FastAPI(title="hep-autoresearch", version="0.0.1")


def _repo_root() -> Path:
    override = os.environ.get("HEP_AUTORESEARCH_ROOT")
    return Path(override).resolve() if override else Path.cwd()


@app.get("/", response_class=HTMLResponse)
def ui() -> str:
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
    .muted { color: #6e7781; font-size: 13px; }
  </style>
</head>
<body>
  <h1>hep-autoresearch</h1>
  <p class="muted">Read-only local diagnostics for the provider-local internal parser/toolkit residue. Canonical lifecycle authority lives on <code>autoresearch</code>.</p>

  <div class="row">
    <button onclick="refresh()">refresh</button>
    <button onclick="logs()">fetch logs</button>
  </div>

  <h2>Status</h2>
  <pre id="status">loading...</pre>

  <h2>Canonical lifecycle</h2>
  <pre>autoresearch init --project-root /abs/path/to/project
autoresearch status --project-root /abs/path/to/project
autoresearch approve &lt;approval_id&gt; --project-root /abs/path/to/project
autoresearch pause --project-root /abs/path/to/project
autoresearch resume --project-root /abs/path/to/project
autoresearch export --project-root /abs/path/to/project --run-id &lt;run_id&gt;</pre>

  <h2>Logs (tail)</h2>
  <pre id="logs">(not loaded)</pre>

  <script>
    async function api(method, path) {
      const res = await fetch(path, { method });
      if (!res.ok) {
        const txt = await res.text();
        throw new Error(res.status + " " + txt);
      }
      return await res.json();
    }

    async function refresh() {
      const st = await api("GET", "/status");
      document.getElementById("status").textContent = JSON.stringify(st, null, 2);
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


@app.get("/status")
def status() -> dict[str, Any]:
    repo_root = _repo_root()
    st = load_state(repo_root)
    if st is None:
        raise HTTPException(status_code=404, detail="not initialized (run autoresearch init)")

    display_run_status, warnings = _status_effective_run_status(st)
    if display_run_status is None:
        raw_run_status = st.get("run_status")
        display_run_status = str(raw_run_status) if isinstance(raw_run_status, str) else None

    return {
        "ok": True,
        "run_status": display_run_status,
        "raw_run_status": st.get("run_status"),
        "run_id": st.get("run_id"),
        "workflow_id": st.get("workflow_id"),
        "current_step": st.get("current_step"),
        "checkpoints": st.get("checkpoints"),
        "pending_approval": st.get("pending_approval"),
        "gate_satisfied": st.get("gate_satisfied"),
        "artifacts": st.get("artifacts"),
        "notes": st.get("notes"),
        "warnings": warnings,
        "stop_files": {"pause": (repo_root / ".pause").exists(), "stop": (repo_root / ".stop").exists()},
        "canonical_cli": {
            "init": "autoresearch init",
            "status": "autoresearch status",
            "approve": "autoresearch approve <approval_id>",
            "pause": "autoresearch pause",
            "resume": "autoresearch resume",
            "export": "autoresearch export --run-id <run_id>",
        },
        "paths": {
            "repo_root": os.fspath(repo_root),
            "state_path": os.fspath(state_path(repo_root)),
            "approval_policy": os.fspath(approval_policy_path(repo_root)),
            "runtime_dir": os.fspath(autoresearch_dir(repo_root)),
        },
    }


@app.get("/logs")
def logs(run_id: Optional[str] = None, tail: int = 50) -> dict[str, Any]:
    repo_root = _repo_root()
    ledger = ledger_path(repo_root)
    if not ledger.exists():
        raise HTTPException(status_code=404, detail="ledger missing (run autoresearch init first)")

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
