from __future__ import annotations

import json
import subprocess
from pathlib import Path
from typing import Any, Iterable


def _workspace_root() -> Path:
    current = Path(__file__).resolve()
    for candidate in [current, *current.parents]:
        if (candidate / "pnpm-workspace.yaml").is_file():
            return candidate
    raise RuntimeError("Unable to locate autoresearch workspace root for literature workflow launcher")


def resolve_literature_workflow(
    repo_root: Path,
    *,
    recipe_id: str,
    phase: str,
    inputs: dict[str, Any],
    available_tools: Iterable[str],
    preferred_providers: Iterable[str] | None = None,
) -> dict[str, Any]:
    workspace_root = _workspace_root()
    dist_index = workspace_root / "packages" / "literature-workflows" / "dist" / "index.js"
    if not dist_index.is_file():
        raise RuntimeError(
            "literature workflow launcher requires built TS artifacts at packages/literature-workflows/dist/index.js"
        )
    request = {
        "inputs": dict(inputs),
        "available_tools": sorted({str(name) for name in available_tools if str(name).strip()}),
        "preferred_providers": list(preferred_providers or []),
        "project_root": str(repo_root),
    }
    runner = (
        "import { pathToFileURL } from 'node:url';"
        "import { readFileSync } from 'node:fs';"
        f"const mod = await import(pathToFileURL({json.dumps(str(dist_index))}).href);"
        "const raw = readFileSync(0, 'utf8');"
        "const payload = raw.trim().length ? JSON.parse(raw) : {};"
        "const resolved = mod.resolveWorkflowRecipe({"
        f"  recipe_id: {json.dumps(recipe_id)},"
        f"  phase: {json.dumps(phase)},"
        "  inputs: payload.inputs ?? {},"
        "  preferred_providers: payload.preferred_providers ?? [],"
        "  allowed_providers: payload.allowed_providers,"
        "  available_tools: payload.available_tools,"
        "});"
        "process.stdout.write(JSON.stringify(resolved));"
    )
    command = [
        "pnpm",
        "--dir",
        str(workspace_root),
        "exec",
        "node",
        "--input-type=module",
        "--eval",
        runner,
    ]
    completed = subprocess.run(
        command,
        cwd=str(workspace_root),
        input=json.dumps(request),
        capture_output=True,
        text=True,
        check=False,
    )
    if completed.returncode != 0:
        detail = completed.stderr.strip() or completed.stdout.strip() or "unknown launcher error"
        raise RuntimeError(f"literature workflow launcher failed: {detail}")
    try:
        return json.loads(completed.stdout)
    except Exception as exc:
        raise RuntimeError("literature workflow launcher returned invalid JSON") from exc


def extract_candidate_recids(payload: object, *, max_recids: int) -> list[str]:
    out: list[str] = []

    def add(value: object) -> None:
        text = str(value).strip()
        if text and text not in out:
            out.append(text)

    if not isinstance(payload, dict):
        return out

    for key in ("papers", "results", "entries"):
        items = payload.get(key)
        if not isinstance(items, list):
            continue
        for item in items:
            if not isinstance(item, dict):
                continue
            recid = item.get("recid") or item.get("id") or item.get("paper_id")
            if recid is None:
                continue
            add(recid)
            if len(out) >= max_recids:
                return out
    return out
