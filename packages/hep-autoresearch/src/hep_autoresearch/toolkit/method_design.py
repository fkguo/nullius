from __future__ import annotations

import json
import os
import platform
import re
import sys
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from typing import Any

from ._git import try_get_git_metadata
from ._json import write_json
from ._paths import manifest_cwd
from ._time import utc_now_iso
from .artifact_report import write_artifact_report
from .mcp_config import load_mcp_server_config, merged_env
from .mcp_stdio_client import McpStdioClient
from .run_card_schema import normalize_and_validate_run_card_v2
from .w_compute import validate_phase_dag


_PROJECT_ID_RE = re.compile(r"^[a-z][a-z0-9_]{0,63}$")


@dataclass(frozen=True)
class MethodDesignInputs:
    tag: str
    template: str
    project_id: str
    title: str | None = None
    description: str | None = None
    out_project_dir: str | None = None
    overwrite: bool = False
    # Optional method spec bundle (materialize a project from a structured spec file).
    spec_path: str | None = None
    # Optional MCP config (used by templates that query PDG at design time).
    mcp_config: str | None = None
    mcp_server: str = "hep-research"
    hep_data_dir: str | None = None
    # PDG query knobs (used by pdg_snapshot template).
    pdg_particle_name: str | None = None
    pdg_property: str = "mass"
    pdg_allow_derived: bool = True


def _rel(repo_root: Path, p: Path) -> str:
    try:
        return os.fspath(p.resolve().relative_to(repo_root.resolve())).replace(os.sep, "/")
    except Exception:  # CONTRACT-EXEMPT: CODE-01.5 diagnostic fallthrough
        return os.fspath(p).replace(os.sep, "/")


def _containment_check(*, repo_root: Path, path: Path, label: str) -> None:
    try:
        path.resolve().relative_to(repo_root.resolve())
    except Exception as e:
        raise ValueError(f"{label} must be within repo_root: {path}") from e


def _write_text(path: Path, content: str, *, overwrite: bool) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.exists() and not overwrite:
        raise FileExistsError(f"refusing to overwrite existing file: {path}")
    path.write_text(content.rstrip() + "\n", encoding="utf-8")


def _write_json(path: Path, payload: dict[str, Any], *, overwrite: bool) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.exists() and not overwrite:
        raise FileExistsError(f"refusing to overwrite existing file: {path}")
    path.write_text(json.dumps(payload, indent=2, sort_keys=True, ensure_ascii=False) + "\n", encoding="utf-8")


def _validate_project_id(project_id: str) -> str:
    pid = str(project_id or "").strip()
    if not pid or not _PROJECT_ID_RE.match(pid):
        raise ValueError("project_id must match ^[a-z][a-z0-9_]{0,63}$")
    return pid


def _is_safe_relpath_posix(path: str) -> bool:
    """Return True if `path` is a safe POSIX-ish relative path (no abs, no '..')."""
    s = str(path).strip().replace("\\", "/")
    if not s:
        return False
    if s.startswith("/"):
        return False
    try:
        pp = PurePosixPath(s)
    except Exception:  # CONTRACT-EXEMPT: CODE-01.5 deny-by-default path validation
        return False
    if pp.is_absolute():
        return False
    parts = [p for p in pp.parts if p not in {"", "."}]
    if any(p == ".." for p in parts):
        return False
    return True


def _resolve_under(root: Path, rel: str, *, label: str) -> Path:
    if not _is_safe_relpath_posix(rel):
        raise ValueError(f"{label} is not a safe relative path: {rel!r}")
    p = (root / rel.strip().replace("\\", "/")).resolve()
    try:
        p.relative_to(root.resolve())
    except Exception as e:
        raise ValueError(f"{label} escapes root: {rel!r}") from e
    return p


def _load_method_spec_v1(path: Path) -> dict[str, Any]:
    """Load and validate a method_spec v1 bundle (strict; unknown fields are errors)."""
    payload = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(payload, dict):
        raise ValueError("method_spec must be a JSON object")
    extra = sorted([k for k in payload.keys() if k not in {"schema_version", "project", "run_card_path", "run_card", "files", "notes"}])
    if extra:
        raise ValueError(f"method_spec: unexpected top-level fields: {extra}")
    sv = payload.get("schema_version")
    if not isinstance(sv, int) or int(sv) != 1:
        raise ValueError("method_spec.schema_version must be integer const 1")
    proj = payload.get("project")
    if not isinstance(proj, dict):
        raise ValueError("method_spec.project must be an object")
    proj_extra = sorted([k for k in proj.keys() if k not in {"project_id", "title", "description", "required_references", "eval_cases"}])
    if proj_extra:
        raise ValueError(f"method_spec.project: unexpected fields: {proj_extra}")
    pid = proj.get("project_id")
    title = proj.get("title")
    if not isinstance(pid, str) or not pid.strip() or not _PROJECT_ID_RE.match(pid.strip()):
        raise ValueError("method_spec.project.project_id invalid (expected ^[a-z][a-z0-9_]{0,63}$)")
    if not isinstance(title, str) or not title.strip():
        raise ValueError("method_spec.project.title must be a non-empty string")
    if "description" in proj and proj.get("description") is not None and not isinstance(proj.get("description"), str):
        raise ValueError("method_spec.project.description must be a string if present")
    rr = proj.get("required_references", [])
    if rr is None:
        rr = []
    if not isinstance(rr, list) or not all(isinstance(x, str) and x.strip() for x in rr):
        raise ValueError("method_spec.project.required_references must be an array of strings if present")
    ev = proj.get("eval_cases", [])
    if ev is None:
        ev = []
    if not isinstance(ev, list) or not all(isinstance(x, str) and x.strip() for x in ev):
        raise ValueError("method_spec.project.eval_cases must be an array of strings if present")

    run_card_path = payload.get("run_card_path", "run_cards/main.json")
    if not isinstance(run_card_path, str) or not run_card_path.strip() or not _is_safe_relpath_posix(run_card_path):
        raise ValueError("method_spec.run_card_path must be a safe relative path string")

    run_card = payload.get("run_card")
    if not isinstance(run_card, dict):
        raise ValueError("method_spec.run_card must be an object (run_card v2 payload)")

    files = payload.get("files", [])
    if files is None:
        files = []
    if not isinstance(files, list):
        raise ValueError("method_spec.files must be an array if present")
    files_norm: list[dict[str, Any]] = []
    seen_paths: set[str] = set()
    for idx, f in enumerate(files):
        if not isinstance(f, dict):
            raise ValueError(f"method_spec.files[{idx}] must be an object")
        f_extra = sorted([k for k in f.keys() if k not in {"path", "content", "executable"}])
        if f_extra:
            raise ValueError(f"method_spec.files[{idx}]: unexpected fields: {f_extra}")
        rel = f.get("path")
        if not isinstance(rel, str) or not rel.strip() or not _is_safe_relpath_posix(rel):
            raise ValueError(f"method_spec.files[{idx}].path invalid: {rel!r}")
        rel_norm = rel.strip().replace("\\", "/")
        if rel_norm in seen_paths:
            raise ValueError(f"method_spec.files[{idx}].path duplicated: {rel_norm!r}")
        seen_paths.add(rel_norm)
        content = f.get("content")
        if not isinstance(content, str):
            raise ValueError(f"method_spec.files[{idx}].content must be a string")
        if len(content.encode("utf-8", errors="replace")) > 800_000:
            raise ValueError(f"method_spec.files[{idx}].content too large (>800KB)")
        executable = f.get("executable", False)
        if not isinstance(executable, bool):
            raise ValueError(f"method_spec.files[{idx}].executable must be boolean if present")
        files_norm.append({"path": rel_norm, "content": content, "executable": bool(executable)})

    notes = payload.get("notes", "")
    if notes is None:
        notes = ""
    if not isinstance(notes, str):
        raise ValueError("method_spec.notes must be a string if present")

    return {
        "schema_version": 1,
        "project": {
            "project_id": pid.strip(),
            "title": title.strip(),
            "description": proj.get("description") if isinstance(proj.get("description"), str) else None,
            "required_references": [str(x).strip() for x in rr if isinstance(x, str) and x.strip()],
            "eval_cases": [str(x).strip() for x in ev if isinstance(x, str) and x.strip()],
        },
        "run_card_path": run_card_path.strip().replace("\\", "/"),
        "run_card": dict(run_card),
        "files": files_norm,
        "notes": notes,
    }


def _find_first_number(payload: Any) -> float | None:
    """Best-effort: find a numeric value in a tool response.

    This is intentionally conservative and only used to enrich the normalized snapshot;
    the raw response is always preserved.
    """
    if isinstance(payload, bool):
        return None
    if isinstance(payload, (int, float)):
        return float(payload)
    if isinstance(payload, dict):
        for k in ["value", "central_value", "val", "mass", "width", "lifetime"]:
            if k in payload:
                v = _find_first_number(payload.get(k))
                if v is not None:
                    return v
        for v in payload.values():
            x = _find_first_number(v)
            if x is not None:
                return x
        return None
    if isinstance(payload, list):
        for v in payload[:50]:
            x = _find_first_number(v)
            if x is not None:
                return x
        return None
    return None


def _mcp_config_path(repo_root: Path, inps: MethodDesignInputs) -> Path:
    if inps.mcp_config:
        p = Path(str(inps.mcp_config)).expanduser()
        if not p.is_absolute():
            p = repo_root / p
        return p.resolve()
    return (repo_root / ".mcp.json").resolve()


def _mcp_env(repo_root: Path, base_env: dict[str, str] | None, inps: MethodDesignInputs) -> dict[str, str]:
    env = merged_env(base=base_env)
    # Keep PDG/HEP data local to the repo by default unless explicitly overridden.
    if inps.hep_data_dir:
        env["HEP_DATA_DIR"] = str(Path(str(inps.hep_data_dir)).expanduser().resolve())
    else:
        env.setdefault("HEP_DATA_DIR", os.fspath((repo_root / ".hep-research-mcp").resolve()))
    return env


def _pdg_snapshot_v1(
    *,
    repo_root: Path,
    inps: MethodDesignInputs,
    created_at: str,
) -> tuple[dict[str, Any], list[dict[str, Any]], list[str]]:
    """Query PDG via MCP and return (snapshot_json, actions, errors)."""
    actions: list[dict[str, Any]] = []
    errors: list[str] = []

    particle = str(inps.pdg_particle_name or "").strip()
    if not particle:
        return {}, actions, ["--pdg-particle-name is required for template=pdg_snapshot"]

    cfg_path = _mcp_config_path(repo_root, inps)
    if not cfg_path.exists():
        return {}, actions, [f"missing MCP config: {cfg_path}"]

    try:
        cfg = load_mcp_server_config(config_path=cfg_path, server_name=str(inps.mcp_server))
    except Exception as e:
        return {}, actions, [f"failed to load MCP server config: {e}"]

    try:
        env = _mcp_env(repo_root, cfg.env, inps)
    except Exception as e:
        return {}, actions, [str(e)]

    tool_name = "pdg_get_property"
    raw_json: Any | None = None
    try:
        with McpStdioClient(cfg=cfg, cwd=repo_root, env=env) as client:
            init_raw = client.initialize(client_name="hepar", client_version="0.0.1")
            actions.append(
                {
                    "tool": "initialize",
                    "status": "ok",
                    "timestamp": utc_now_iso().replace("+00:00", "Z"),
                    "protocolVersion": init_raw.get("protocolVersion") if isinstance(init_raw, dict) else None,
                }
            )
            tools = client.list_tools()
            names = {t.name for t in tools}
            if tool_name not in names:
                return {}, actions, [f"MCP server missing tool: {tool_name}"]

            args: dict[str, Any] = {
                "allow_derived": bool(inps.pdg_allow_derived),
                "particle": {"case_sensitive": False, "name": particle},
                "property": str(inps.pdg_property or "mass"),
            }
            res = client.call_tool_json(tool_name=tool_name, arguments=args, timeout_seconds=60.0)
            actions.append(
                {
                    "tool": tool_name,
                    "status": "ok" if res.ok else "error",
                    "timestamp": utc_now_iso().replace("+00:00", "Z"),
                    "arguments": args,
                }
            )
            if not res.ok:
                errors.append(f"{tool_name}: {res.raw_text or '(error)'}")
            raw_json = res.json
    except Exception as e:
        errors.append(f"exception: {e}")

    extracted_value = _find_first_number(raw_json)
    unit = None
    if isinstance(raw_json, dict):
        unit = raw_json.get("unit") or raw_json.get("units") or raw_json.get("unit_label")

    snapshot = {
        "schema_version": 1,
        "created_at": created_at,
        "query": {
            "particle_name": particle,
            "property": str(inps.pdg_property or "mass"),
            "allow_derived": bool(inps.pdg_allow_derived),
        },
        "result": {
            "ok": bool(not errors),
            "value": extracted_value,
            "unit": unit,
        },
        "raw": raw_json,
    }
    return snapshot, actions, errors


def method_design_one(inps: MethodDesignInputs, *, repo_root: Path) -> dict[str, Any]:
    if not inps.tag or not str(inps.tag).strip():
        raise ValueError("tag is required")
    template = str(inps.template or "").strip() or "minimal_ok"
    spec_path: Path | None = None
    spec_norm: dict[str, Any] | None = None
    if template == "spec_v1":
        raw_spec = str(inps.spec_path or "").strip()
        if not raw_spec:
            raise ValueError("spec_path is required for template=spec_v1 (pass --spec)")
        spec_path = Path(raw_spec).expanduser()
        if not spec_path.is_absolute():
            spec_path = repo_root / spec_path
        spec_path = spec_path.resolve()
        if not spec_path.exists() or not spec_path.is_file():
            raise FileNotFoundError(f"method_spec not found: {spec_path}")
        spec_norm = _load_method_spec_v1(spec_path)
        spec_pid = _validate_project_id(str(((spec_norm.get("project") or {}).get("project_id")) or ""))
        override_pid = str(inps.project_id or "").strip()
        if override_pid:
            project_id = _validate_project_id(override_pid)
            if project_id != spec_pid:
                # Allow overriding the spec project_id (recorded in actions).
                if isinstance(spec_norm.get("project"), dict):
                    spec_norm["project"] = dict(spec_norm["project"])
                    spec_norm["project"]["project_id"] = project_id
        else:
            project_id = spec_pid
    else:
        project_id = _validate_project_id(str(inps.project_id or ""))

    created_at = utc_now_iso().replace("+00:00", "Z")
    out_dir = (repo_root / "artifacts" / "runs" / str(inps.tag) / "method_design").resolve()
    out_dir.mkdir(parents=True, exist_ok=True)

    manifest_path = out_dir / "manifest.json"
    summary_path = out_dir / "summary.json"
    analysis_path = out_dir / "analysis.json"

    # Decide where to write the generated plugin project.
    if inps.out_project_dir:
        proj_dir = Path(str(inps.out_project_dir)).expanduser()
        if not proj_dir.is_absolute():
            proj_dir = repo_root / proj_dir
        proj_dir = proj_dir.resolve()
    else:
        proj_dir = (out_dir / "project").resolve()
    _containment_check(repo_root=repo_root, path=proj_dir, label="out_project_dir")

    actions: list[dict[str, Any]] = []
    errors: list[str] = []

    def _act(kind: str, status: str, **extras: Any) -> None:
        row: dict[str, Any] = {"action": kind, "status": status, "timestamp": utc_now_iso().replace("+00:00", "Z")}
        row.update(extras)
        actions.append(row)

    # Template: minimal_ok — deterministic local pipeline (no MCP dependency).
    if template == "minimal_ok":
        title = inps.title or "Method-design scaffold (minimal_ok)"
        desc = inps.description or "Deterministic example scaffold: one phase writes a small JSON output."

        project_json = {
            "schema_version": 1,
            "project_id": project_id,
            "title": title,
            "description": desc,
            "run_cards": {"main": "run_cards/main.json"},
            "required_references": [],
            "eval_cases": [],
        }

        script_rel = "scripts/write_ok.py"
        script_path = proj_dir / script_rel
        _write_text(
            script_path,
            (
                "from __future__ import annotations\n"
                "\n"
                "import json\n"
                "from pathlib import Path\n"
                "\n"
                "Path('results').mkdir(parents=True, exist_ok=True)\n"
                "Path('results/ok.json').write_text(json.dumps({'ok': True, 'value': 1}) + '\\n', encoding='utf-8')\n"
            ),
            overwrite=bool(inps.overwrite),
        )
        _act("write_script", "ok", path=_rel(repo_root, script_path))

        run_card = {
            "schema_version": 2,
            "run_id": str(inps.tag),
            "workflow_id": "W_compute",
            "title": title,
            "phases": [
                {
                    "phase_id": "write_ok",
                    "description": "Write a small deterministic JSON output",
                    "backend": {"kind": "shell", "argv": ["python3", script_rel], "cwd": ".", "timeout_seconds": 30},
                    "outputs": ["results/ok.json"],
                    "retries": 0,
                }
            ],
            "headline_numbers": {
                "source": "phases/write_ok/results/ok.json",
                "extract": [
                    {"pointer": "#/value", "label": "Toy value", "tier": "T3"},
                ],
            },
        }

        # Validate generated run-card (strict) + DAG cycle check.
        card = normalize_and_validate_run_card_v2(run_card, run_id_override=str(inps.tag), param_overrides={})
        validate_phase_dag(list(card.normalized.get("phases") or []))

        proj_json_path = proj_dir / "project.json"
        rc_path = proj_dir / "run_cards" / "main.json"
        readme_path = proj_dir / "README.md"
        _write_json(proj_json_path, project_json, overwrite=bool(inps.overwrite))
        _write_json(rc_path, run_card, overwrite=bool(inps.overwrite))
        _write_text(
            readme_path,
            (
                f"# {project_id} (Generated by hepar method-design)\n\n"
                f"- template: `{template}`\n"
                f"- tag: `{inps.tag}`\n\n"
                "## Validate\n\n"
                "```bash\n"
                "python3 -m hep_autoresearch run-card validate \\\n"
                f"  --run-card {rc_path.as_posix()}\n"
                "```\n\n"
                "## Run\n\n"
                "```bash\n"
                "python3 -m hep_autoresearch run \\\n"
                f"  --run-id {inps.tag} \\\n"
                "  --workflow-id W_compute \\\n"
                f"  --run-card {rc_path.as_posix()} \\\n"
                "  --trust-project\n"
                "```\n"
            ),
            overwrite=bool(inps.overwrite),
        )
        _act("write_project", "ok", project_dir=_rel(repo_root, proj_dir), run_card=_rel(repo_root, rc_path))

    # Template: spec_v1 — materialize a project from a structured method_spec bundle (no LLM calls).
    elif template == "spec_v1":
        assert spec_norm is not None
        assert spec_path is not None

        proj_spec = spec_norm.get("project") if isinstance(spec_norm.get("project"), dict) else {}
        title = inps.title or str(proj_spec.get("title") or "").strip() or "Method-design scaffold (spec_v1)"
        desc = inps.description or (proj_spec.get("description") if isinstance(proj_spec.get("description"), str) else None) or ""

        run_card_path_rel = str(spec_norm.get("run_card_path") or "run_cards/main.json").strip().replace("\\", "/")
        rc_path = _resolve_under(proj_dir, run_card_path_rel, label="method_spec.run_card_path")

        # 1) Write project.json (derived from spec).
        project_json = {
            "schema_version": 1,
            "project_id": project_id,
            "title": title,
            "description": desc,
            "run_cards": {"main": run_card_path_rel},
            "required_references": list(proj_spec.get("required_references") or []) if isinstance(proj_spec.get("required_references"), list) else [],
            "eval_cases": list(proj_spec.get("eval_cases") or []) if isinstance(proj_spec.get("eval_cases"), list) else [],
        }
        proj_json_path = proj_dir / "project.json"
        _write_json(proj_json_path, project_json, overwrite=bool(inps.overwrite))
        _act("write_project_json", "ok", path=_rel(repo_root, proj_json_path))

        # 2) Write method_spec snapshot for provenance (best-effort, do not overwrite unless --overwrite).
        spec_snap_rel = "inputs/method_spec.json"
        try:
            spec_snap_path = _resolve_under(proj_dir, spec_snap_rel, label="method_spec snapshot path")
            _write_json(spec_snap_path, spec_norm, overwrite=bool(inps.overwrite))
            _act("write_method_spec_snapshot", "ok", path=_rel(repo_root, spec_snap_path))
        except Exception as e:
            errors.append(f"method_spec_snapshot: {e}")
            _act("write_method_spec_snapshot", "error", error=str(e))

        # 3) Write declared files.
        for f in list(spec_norm.get("files") or []):
            if not isinstance(f, dict):
                continue
            rel = str(f.get("path") or "").strip().replace("\\", "/")
            try:
                p = _resolve_under(proj_dir, rel, label="method_spec.files.path")
                _write_text(p, str(f.get("content") or ""), overwrite=bool(inps.overwrite))
                if bool(f.get("executable")):
                    try:
                        mode = p.stat().st_mode
                        p.chmod(mode | 0o100)  # u+x
                    except Exception:  # CONTRACT-EXEMPT: CODE-01.5 best-effort chmod
                        pass
                _act("write_file", "ok", path=_rel(repo_root, p))
            except Exception as e:
                errors.append(f"file_write: {rel}: {e}")
                _act("write_file", "error", path=rel, error=str(e))

        # 4) Write run_card v2 and validate it (strict) + DAG cycle check.
        run_card = dict(spec_norm.get("run_card") or {})
        run_card["run_id"] = str(inps.tag)
        run_card.setdefault("workflow_id", "W_compute")
        run_card.setdefault("title", title)
        _write_json(rc_path, run_card, overwrite=bool(inps.overwrite))
        _act("write_run_card", "ok", path=_rel(repo_root, rc_path))

        try:
            card = normalize_and_validate_run_card_v2(run_card, run_id_override=str(inps.tag), param_overrides={})
            validate_phase_dag(list(card.normalized.get("phases") or []))
        except Exception as e:
            errors.append(f"run_card_invalid: {e}")
            _act("validate_run_card", "error", error=str(e))
        else:
            _act("validate_run_card", "ok", run_id=str(inps.tag))

        # 5) README (optional; only if not provided by spec).
        readme_path = proj_dir / "README.md"
        if not readme_path.exists():
            try:
                _write_text(
                    readme_path,
                    (
                        f"# {project_id} (Generated by hepar method-design)\n\n"
                        f"- template: `{template}`\n"
                        f"- tag: `{inps.tag}`\n"
                        f"- source_spec: `{_rel(repo_root, spec_path)}`\n\n"
                        "## Validate\n\n"
                        "```bash\n"
                        "python3 -m hep_autoresearch run-card validate \\\n"
                        f"  --run-card {rc_path.as_posix()}\n"
                        "```\n\n"
                        "## Run\n\n"
                        "```bash\n"
                        "python3 -m hep_autoresearch run \\\n"
                        f"  --run-id {inps.tag} \\\n"
                        "  --workflow-id W_compute \\\n"
                        f"  --run-card {rc_path.as_posix()} \\\n"
                        "  --trust-project\n"
                        "```\n"
                    ),
                    overwrite=False,
                )
                _act("write_readme", "ok", path=_rel(repo_root, readme_path))
            except Exception:  # CONTRACT-EXEMPT: CODE-01.5 non-essential scaffold README
                pass

        _act("write_project", "ok", project_dir=_rel(repo_root, proj_dir), run_card=_rel(repo_root, rc_path))

    # Template: pdg_snapshot — query PDG at design time and embed a snapshot into the project.
    elif template == "pdg_snapshot":
        title = inps.title or f"Method-design scaffold (pdg_snapshot: {inps.pdg_particle_name}/{inps.pdg_property})"
        desc = inps.description or "Scaffold that snapshots a PDG property (via MCP) and prepares a runnable W_compute run-card."

        snapshot, pdg_actions, pdg_errors = _pdg_snapshot_v1(repo_root=repo_root, inps=inps, created_at=created_at)
        actions.extend(pdg_actions)
        errors.extend(pdg_errors)

        project_json = {
            "schema_version": 1,
            "project_id": project_id,
            "title": title,
            "description": desc,
            "run_cards": {"main": "run_cards/main.json"},
            "required_references": [],
            "eval_cases": [],
        }

        snapshot_rel = "inputs/pdg_snapshot.json"
        snapshot_path = proj_dir / snapshot_rel
        _write_json(snapshot_path, snapshot, overwrite=bool(inps.overwrite))
        _act("write_pdg_snapshot", "ok" if not pdg_errors else "error", path=_rel(repo_root, snapshot_path))

        script_rel = "scripts/copy_snapshot.py"
        script_path = proj_dir / script_rel
        _write_text(
            script_path,
            (
                "from __future__ import annotations\n"
                "\n"
                "import json\n"
                "from pathlib import Path\n"
                "\n"
                "src = Path('inputs/pdg_snapshot.json')\n"
                "dst_dir = Path('results')\n"
                "dst_dir.mkdir(parents=True, exist_ok=True)\n"
                "payload = json.loads(src.read_text(encoding='utf-8'))\n"
                "Path('results/pdg_snapshot.json').write_text(json.dumps(payload, indent=2, sort_keys=True) + '\\n', encoding='utf-8')\n"
            ),
            overwrite=bool(inps.overwrite),
        )
        _act("write_script", "ok", path=_rel(repo_root, script_path))

        run_card = {
            "schema_version": 2,
            "run_id": str(inps.tag),
            "workflow_id": "W_compute",
            "title": title,
            "phases": [
                {
                    "phase_id": "emit_snapshot",
                    "description": "Copy the PDG snapshot into results (self-contained compute run)",
                    "inputs": [snapshot_rel],
                    "backend": {"kind": "shell", "argv": ["python3", script_rel], "cwd": ".", "timeout_seconds": 30},
                    "outputs": ["results/pdg_snapshot.json"],
                    "retries": 0,
                }
            ],
            "headline_numbers": {
                "source": "phases/emit_snapshot/results/pdg_snapshot.json",
                "extract": [
                    {"pointer": "#/result/value", "label": "PDG property (best-effort extracted)", "tier": "T2"},
                ],
            },
        }

        # Validate generated run-card (strict) + DAG cycle check.
        card = normalize_and_validate_run_card_v2(run_card, run_id_override=str(inps.tag), param_overrides={})
        validate_phase_dag(list(card.normalized.get("phases") or []))

        proj_json_path = proj_dir / "project.json"
        rc_path = proj_dir / "run_cards" / "main.json"
        readme_path = proj_dir / "README.md"
        _write_json(proj_json_path, project_json, overwrite=bool(inps.overwrite))
        _write_json(rc_path, run_card, overwrite=bool(inps.overwrite))
        _write_text(
            readme_path,
            (
                f"# {project_id} (Generated by hepar method-design)\n\n"
                f"- template: `{template}`\n"
                f"- tag: `{inps.tag}`\n\n"
                "## Validate\n\n"
                "```bash\n"
                "python3 -m hep_autoresearch run-card validate \\\n"
                f"  --run-card {rc_path.as_posix()}\n"
                "```\n\n"
                "## Run\n\n"
                "```bash\n"
                "python3 -m hep_autoresearch run \\\n"
                f"  --run-id {inps.tag} \\\n"
                "  --workflow-id W_compute \\\n"
                f"  --run-card {rc_path.as_posix()} \\\n"
                "  --trust-project\n"
                "```\n"
            ),
            overwrite=bool(inps.overwrite),
        )
        _act("write_project", "ok", project_dir=_rel(repo_root, proj_dir), run_card=_rel(repo_root, rc_path))

    # Template: pdg_runtime — query PDG at runtime via MCP (phase executes pdg_get_property).
    elif template == "pdg_runtime":
        particle = str(inps.pdg_particle_name or "").strip() or "pi0"
        prop = str(inps.pdg_property or "mass").strip() or "mass"
        allow_derived = bool(inps.pdg_allow_derived)

        title = inps.title or f"Method-design scaffold (pdg_runtime: {particle}/{prop})"
        desc = (
            inps.description
            or "Scaffold that queries a PDG property at runtime via MCP (pdg_get_property) and writes a deterministic JSON result."
        )

        project_json = {
            "schema_version": 1,
            "project_id": project_id,
            "title": title,
            "description": desc,
            "run_cards": {"main": "run_cards/main.json"},
            "required_references": [],
            "eval_cases": [],
        }

        # Snapshot the intended query for provenance (runtime still performs the MCP call).
        query_rel = "inputs/pdg_query.json"
        query_path = proj_dir / query_rel
        _write_json(
            query_path,
            {
                "schema_version": 1,
                "created_at": created_at,
                "query": {
                    "particle_name": particle,
                    "property": prop,
                    "allow_derived": bool(allow_derived),
                },
            },
            overwrite=bool(inps.overwrite),
        )
        _act("write_pdg_query_snapshot", "ok", path=_rel(repo_root, query_path))

        script_rel = "scripts/query_pdg_property.py"
        script_path = proj_dir / script_rel
        _write_text(
            script_path,
            (
                "from __future__ import annotations\n"
                "\n"
                "import argparse\n"
                "import json\n"
                "import os\n"
                "from pathlib import Path\n"
                "\n"
                "from hep_autoresearch.toolkit._time import utc_now_iso\n"
                "from hep_autoresearch.toolkit.mcp_config import load_mcp_server_config, merged_env\n"
                "from hep_autoresearch.toolkit.mcp_stdio_client import McpStdioClient\n"
                "\n"
                "\n"
                "def _parse_bool(s: str) -> bool:\n"
                "    return str(s).strip().lower() in {\"1\", \"true\", \"yes\", \"y\", \"on\"}\n"
                "\n"
                "\n"
                "def main() -> int:\n"
                "    ap = argparse.ArgumentParser(description=\"Query a PDG property via MCP and write a deterministic JSON snapshot.\")\n"
                "    ap.add_argument(\"--mcp-config\", default=\".mcp.json\", help=\"Path to .mcp.json (default: .mcp.json in project dir)\")\n"
                "    ap.add_argument(\"--mcp-server\", default=\"hep-research\", help=\"MCP server name in config (default: hep-research)\")\n"
                "    ap.add_argument(\"--hep-data-dir\", default=\"\", help=\"Optional HEP_DATA_DIR override for the MCP server process\")\n"
                "    ap.add_argument(\"--particle-name\", required=True)\n"
                "    ap.add_argument(\"--property\", default=\"mass\", choices=[\"mass\", \"width\", \"lifetime\"])\n"
                "    ap.add_argument(\"--allow-derived\", default=\"true\")\n"
                "    ap.add_argument(\"--out\", default=\"results/pdg_property.json\")\n"
                "    args = ap.parse_args()\n"
                "\n"
                "    cfg_path = Path(args.mcp_config).expanduser()\n"
                "    if not cfg_path.is_absolute():\n"
                "        cfg_path = (Path.cwd() / cfg_path)\n"
                "    cfg_path = cfg_path.resolve()\n"
                "    if not cfg_path.exists():\n"
                "        raise SystemExit(f\"missing mcp config: {cfg_path}\")\n"
                "\n"
                "    cfg = load_mcp_server_config(config_path=cfg_path, server_name=str(args.mcp_server))\n"
                "\n"
                "    hep_data_dir = str(args.hep_data_dir or \"\").strip()\n"
                "    if hep_data_dir:\n"
                "        p = Path(hep_data_dir).expanduser()\n"
                "        if not p.is_absolute():\n"
                "            p = (Path.cwd() / p)\n"
                "        hep_path = p.resolve()\n"
                "    else:\n"
                "        hep_path = (Path.cwd() / \".hep-research-mcp\").resolve()\n"
                "    hep_path.mkdir(parents=True, exist_ok=True)\n"
                "\n"
                "    overrides = dict(cfg.env or {})\n"
                "    overrides[\"HEP_DATA_DIR\"] = os.fspath(hep_path)\n"
                "    env = merged_env(overrides=overrides)\n"
                "\n"
                "    out_path = Path(args.out).expanduser()\n"
                "    if not out_path.is_absolute():\n"
                "        out_path = (Path.cwd() / out_path)\n"
                "    out_path = out_path.resolve()\n"
                "    out_path.parent.mkdir(parents=True, exist_ok=True)\n"
                "\n"
                "    created_at = utc_now_iso().replace(\"+00:00\", \"Z\")\n"
                "    actions = []\n"
                "    errors = []\n"
                "    raw = None\n"
                "    ok = False\n"
                "\n"
                "    try:\n"
                "        with McpStdioClient(cfg=cfg, cwd=Path.cwd(), env=env) as client:\n"
                "            init_raw = client.initialize(client_name=\"hepar\", client_version=\"0.0.1\")\n"
                "            actions.append({\n"
                "                \"tool\": \"initialize\",\n"
                "                \"status\": \"ok\",\n"
                "                \"timestamp\": utc_now_iso().replace(\"+00:00\", \"Z\"),\n"
                "                \"protocolVersion\": init_raw.get(\"protocolVersion\") if isinstance(init_raw, dict) else None,\n"
                "            })\n"
                "            tool_args = {\n"
                "                \"allow_derived\": _parse_bool(str(args.allow_derived)),\n"
                "                \"particle\": {\"case_sensitive\": False, \"name\": str(args.particle_name)},\n"
                "                \"property\": str(args.property),\n"
                "            }\n"
                "            res = client.call_tool_json(tool_name=\"pdg_get_property\", arguments=tool_args, timeout_seconds=60.0)\n"
                "            actions.append({\n"
                "                \"tool\": \"pdg_get_property\",\n"
                "                \"status\": \"ok\" if res.ok else \"error\",\n"
                "                \"timestamp\": utc_now_iso().replace(\"+00:00\", \"Z\"),\n"
                "                \"arguments\": tool_args,\n"
                "            })\n"
                "            raw = res.json\n"
                "            ok = bool(res.ok)\n"
                "            if not res.ok:\n"
                "                errors.append(res.raw_text or \"(error)\")\n"
                "    except Exception as e:\n"
                "        errors.append(f\"exception: {e}\")\n"
                "\n"
                "    payload = {\n"
                "        \"schema_version\": 1,\n"
                "        \"created_at\": created_at,\n"
                "        \"query\": {\n"
                "            \"particle_name\": str(args.particle_name),\n"
                "            \"property\": str(args.property),\n"
                "            \"allow_derived\": _parse_bool(str(args.allow_derived)),\n"
                "        },\n"
                "        \"mcp\": {\n"
                "            \"server_name\": cfg.name,\n"
                "        },\n"
                "        \"result\": {\n"
                "            \"ok\": bool(ok),\n"
                "            \"errors\": errors,\n"
                "            \"raw\": raw,\n"
                "        },\n"
                "        \"agent_actions\": actions,\n"
                "    }\n"
                "    out_path.write_text(json.dumps(payload, indent=2, sort_keys=True) + \"\\n\", encoding=\"utf-8\")\n"
                "    return 0 if ok else 2\n"
                "\n"
                "\n"
                "if __name__ == \"__main__\":\n"
                "    raise SystemExit(main())\n"
            ),
            overwrite=bool(inps.overwrite),
        )
        _act("write_script", "ok", path=_rel(repo_root, script_path))

        run_card = {
            "schema_version": 2,
            "run_id": str(inps.tag),
            "workflow_id": "W_compute",
            "title": title,
            "parameters": {
                "mcp_config": {"type": "string", "default": ".mcp.json", "description": "Path to MCP config JSON for runtime PDG query."},
                "mcp_server": {"type": "string", "default": str(inps.mcp_server), "description": "MCP server name in config."},
                "hep_data_dir": {"type": "string", "default": "", "description": "Optional HEP_DATA_DIR override (empty=project-local)."},
                "particle_name": {"type": "string", "default": particle, "description": "PDG particle name."},
                "property": {"type": "string", "default": prop, "description": "PDG property (mass/width/lifetime)."},
                "allow_derived": {"type": "boolean", "default": bool(allow_derived), "description": "Allow derived PDG values."},
            },
            "phases": [
                {
                    "phase_id": "query_pdg",
                    "description": "Query PDG property via MCP at runtime and write a deterministic JSON result.",
                    "inputs": [query_rel],
                    "backend": {
                        "kind": "shell",
                        "argv": [
                            "python3",
                            script_rel,
                            "--mcp-config",
                            "${mcp_config}",
                            "--mcp-server",
                            "${mcp_server}",
                            "--hep-data-dir",
                            "${hep_data_dir}",
                            "--particle-name",
                            "${particle_name}",
                            "--property",
                            "${property}",
                            "--allow-derived",
                            "${allow_derived}",
                            "--out",
                            "results/pdg_property.json",
                        ],
                        "cwd": ".",
                        "timeout_seconds": 60,
                    },
                    "outputs": ["results/pdg_property.json"],
                    "retries": 0,
                }
            ],
            "headline_numbers": {
                "source": "phases/query_pdg/results/pdg_property.json",
                "extract": [
                    {"pointer": "#/result/raw/value", "label": "PDG property (raw.value)", "tier": "T2"},
                ],
            },
        }

        # Validate generated run-card (strict) + DAG cycle check.
        card = normalize_and_validate_run_card_v2(run_card, run_id_override=str(inps.tag), param_overrides={})
        validate_phase_dag(list(card.normalized.get("phases") or []))

        proj_json_path = proj_dir / "project.json"
        rc_path = proj_dir / "run_cards" / "main.json"
        readme_path = proj_dir / "README.md"
        _write_json(proj_json_path, project_json, overwrite=bool(inps.overwrite))
        _write_json(rc_path, run_card, overwrite=bool(inps.overwrite))
        _write_text(
            readme_path,
            (
                f"# {project_id} (Generated by hepar method-design)\n\n"
                f"- template: `{template}`\n"
                f"- tag: `{inps.tag}`\n\n"
                "## Configure MCP\n\n"
                "Create a `.mcp.json` in this project directory (ignored by git) that points to your MCP server.\n\n"
                "## Validate\n\n"
                "```bash\n"
                "python3 -m hep_autoresearch run-card validate \\\n"
                f"  --run-card {rc_path.as_posix()}\n"
                "```\n\n"
                "## Run\n\n"
                "```bash\n"
                "python3 -m hep_autoresearch run \\\n"
                f"  --run-id {inps.tag} \\\n"
                "  --workflow-id W_compute \\\n"
                f"  --run-card {rc_path.as_posix()} \\\n"
                "  --trust-project\n"
                "```\n"
            ),
            overwrite=bool(inps.overwrite),
        )
        _act("write_project", "ok", project_dir=_rel(repo_root, proj_dir), run_card=_rel(repo_root, rc_path))

    else:
        raise ValueError(f"unknown template: {template!r} (supported: minimal_ok, pdg_snapshot, pdg_runtime, spec_v1)")

    ok = not bool(errors)
    versions: dict[str, Any] = {"python": sys.version.split()[0], "os": platform.platform()}

    manifest: dict[str, Any] = {
        "schema_version": 1,
        "created_at": created_at,
        "command": "hepar method-design",
        "cwd": manifest_cwd(repo_root=repo_root, cwd=repo_root),
        "params": {
            "tag": str(inps.tag),
            "template": template,
            "project_id": project_id,
        },
        "versions": versions,
        "outputs": [
            _rel(repo_root, manifest_path),
            _rel(repo_root, summary_path),
            _rel(repo_root, analysis_path),
            _rel(repo_root, proj_dir),
        ],
    }
    if spec_path is not None:
        manifest["params"]["spec_path"] = _rel(repo_root, spec_path)
    git_meta = try_get_git_metadata(repo_root)
    if git_meta:
        manifest["git"] = git_meta

    summary: dict[str, Any] = {
        "schema_version": 1,
        "created_at": created_at,
        "definitions": {"kind": "method_design"},
        "stats": {
            "ok": bool(ok),
            "template": template,
            "actions": int(len(actions)),
            "errors": int(len(errors)),
        },
        "outputs": {
            "project_dir": _rel(repo_root, proj_dir),
        },
    }

    analysis: dict[str, Any] = {
        "schema_version": 1,
        "created_at": created_at,
        "inputs": {
            "tag": str(inps.tag),
            "template": template,
            "project_id": project_id,
        },
        "results": {
            "ok": bool(ok),
            "errors": errors,
            "actions": actions,
            "project_dir": _rel(repo_root, proj_dir),
        },
    }
    if spec_path is not None:
        analysis["inputs"]["spec_path"] = _rel(repo_root, spec_path)

    write_json(manifest_path, manifest)
    write_json(summary_path, summary)
    write_json(analysis_path, analysis)
    write_artifact_report(repo_root=repo_root, artifact_dir=out_dir, manifest=manifest, summary=summary, analysis=analysis)

    return {
        "ok": bool(ok),
        "artifact_paths": {
            "manifest": _rel(repo_root, manifest_path),
            "summary": _rel(repo_root, summary_path),
            "analysis": _rel(repo_root, analysis_path),
            "project_dir": _rel(repo_root, proj_dir),
        },
        "errors": errors,
    }
