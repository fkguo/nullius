# Adapters (unified backend integration)

Goal: integrate external backends (skills / `hep-research-mcp` / shell commands / internal toolkit) into the Orchestrator **without modifying upstream tools**, while keeping the repo’s reliability trio:

1) Unified state machine: `status/pause/resume/approve`
2) Unified run-card (input contract)
3) Unified SSOT artifacts: `manifest.json` / `summary.json` / `analysis.json` (optional derived `report.md`)

Code pointers:
- Adapter base + helpers: `src/hep_autoresearch/toolkit/adapters/`
- Orchestrator wiring: `src/hep_autoresearch/orchestrator_cli.py`
- Artifact contract: `docs/ARTIFACT_CONTRACT.md`
- Approval gates: `docs/APPROVAL_GATES.md`
- Evals: `docs/EVALS.md`

Chinese version (more detailed notes): `docs/ADAPTERS.zh.md`.

---

## 1) Adapter responsibilities (avoid duplicate tooling)

An adapter **does**:
- Controlled backend execution (shell / MCP / internal python)
- Provenance capture (argv/cwd/env/budgets, exit code, stdout/stderr previews)
- SSOT artifact writing **even for** `awaiting_approval` and failures (auditable + resumable)
- Minimal deterministic verification to support eval cases

An adapter **does not**:
- Reimplement external tool logic (BibTeX fetching, LaTeX scaffolding, physics compute, reviewer/writer content generation, etc.)

---

## 2) Run-card (adapter input contract)

The Orchestrator generates or loads a run-card and writes a copy into the adapter’s artifact dir:

- `artifacts/runs/<run_id>/<artifact_step>/run_card.json`

Minimal example:

```json
{
  "schema_version": 1,
  "run_id": "MXX-adapter-smoke-r1",
  "workflow_id": "shell_adapter_smoke",
  "adapter_id": "shell",
  "artifact_step": "shell_adapter_smoke",
  "required_gates": ["A3"],
  "budgets": { "timeout_seconds": 30 },
  "backend": {
    "kind": "shell",
    "argv": ["python3", "-c", "print(\"ok\")"],
    "cwd": ".",
    "env": {}
  }
}
```

Notes:
- `required_gates` is the adapter’s safety floor; Orchestrator policy may enforce additional gates.

### 2.1) Optional: sandboxed execution (T40 v0)

For shell backends, `backend.sandbox` enables isolation:

```json
{
  "backend": {
    "kind": "shell",
    "argv": ["python3", "-c", "print(\"ok\")"],
    "cwd": ".",
    "sandbox": {
      "enabled": true,
      "provider": "auto",
      "network": "disabled",
      "repo_read_only": true,
      "docker_image": "python:3.11-slim",
      "forward_env_keys": ["HEP_DATA_DIR"]
    }
  }
}
```

Semantics (v0):
- `provider=docker`: if available, run in a container with the repo mounted read-only at `/repo` and only `artifacts/runs/<run_id>/<artifact_step>/` mounted writable. Network is disabled by default (`--network none`). Container env forwards a small allowlist from `backend.env` plus any keys in `sandbox.forward_env_keys` (and internal sandbox vars). Avoid forwarding secrets.
- `provider=local_copy`: best-effort fallback when Docker isn’t available. Copy the repo into a temp dir (excluding `artifacts/`), run there, then copy back staged outputs under `artifacts/runs/<run_id>/<artifact_step>/` (SSOT files like `manifest.json` are skipped). Network isolation is not enforced; **not a security boundary**.
- `provider=auto`: prefer Docker if the daemon is available, else degrade to `local_copy` (provenance records the fallback reason).

> ⚠️ `provider=local_copy` is **not** a security boundary. It aims to reduce accidental corruption and improve auditability; it cannot stop determined malicious code. Use `provider=docker` for untrusted inputs.

Safety constraints (v0):
- If `sandbox.network` is not `disabled/none`, the ShellAdapter requires `A1`.
- Sandboxed shell requires `backend.cwd` to be within the repo root.

---

## 3) Adding a new adapter workflow (template)

Principle: do not modify external tools; only add adapter + wiring + eval.

1) Implement adapter logic (often start from `ShellAdapter`)
2) Register workflow id in `src/hep_autoresearch/toolkit/adapters/registry.py`
3) Wire the workflow id in `src/hep_autoresearch/orchestrator_cli.py`
4) Add an offline regression harness + eval case under `evals/cases/`
