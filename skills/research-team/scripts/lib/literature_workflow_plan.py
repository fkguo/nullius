from __future__ import annotations

import json
import os
import subprocess
from pathlib import Path
from typing import Any, Iterable


def _valid_workspace_root(path: Path) -> Path | None:
    root = path.expanduser().resolve()
    if (root / "pnpm-workspace.yaml").is_file():
        return root
    return None


def _workspace_root_from_install_record(current: Path) -> Path | None:
    for candidate in [current, *current.parents]:
        record_path = candidate / ".market_install.json"
        if not record_path.is_file():
            continue
        try:
            record = json.loads(record_path.read_text(encoding="utf-8"))
        except Exception as exc:
            raise RuntimeError(f"invalid skills-market install provenance: {record_path}: {exc}") from exc
        source_root = record.get("source_workspace_root")
        if not isinstance(source_root, str) or not source_root.strip():
            return None
        workspace_root = _valid_workspace_root(Path(source_root))
        if workspace_root is None:
            raise RuntimeError(
                "skills-market install provenance source_workspace_root does not point to an "
                f"autoresearch workspace containing pnpm-workspace.yaml: {source_root}"
            )
        return workspace_root
    return None


def _workspace_root() -> Path:
    current = Path(__file__).resolve()
    env_root = os.environ.get("AUTORESEARCH_WORKSPACE_ROOT", "").strip()
    if env_root:
        workspace_root = _valid_workspace_root(Path(env_root))
        if workspace_root is None:
            raise RuntimeError(
                "AUTORESEARCH_WORKSPACE_ROOT does not point to an autoresearch workspace "
                f"containing pnpm-workspace.yaml: {env_root}"
            )
        return workspace_root

    installed_root = _workspace_root_from_install_record(current)
    if installed_root is not None:
        return installed_root

    for candidate in [current, *current.parents]:
        workspace_root = _valid_workspace_root(candidate)
        if workspace_root is not None:
            return workspace_root
    raise RuntimeError(
        "Unable to locate autoresearch workspace root for literature workflow launcher. "
        "Copied skills-market installs require source_workspace_root install provenance or "
        "AUTORESEARCH_WORKSPACE_ROOT pointing to a checkout containing pnpm-workspace.yaml."
    )


def resolve_workflow_plan(
    *,
    recipe_id: str,
    phase: str,
    inputs: dict[str, Any],
    preferred_providers: Iterable[str] | None = None,
) -> dict[str, Any]:
    workspace_root = _workspace_root()
    launcher = """
import { resolveWorkflowRecipe } from './src/index.ts';

let data = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { data += chunk; });
process.stdin.on('end', () => {
  const request = JSON.parse(data);
  process.stdout.write(JSON.stringify(resolveWorkflowRecipe(request)));
});
"""
    command = [
        "pnpm",
        "--dir",
        str(workspace_root),
        "--filter",
        "@autoresearch/literature-workflows",
        "exec",
        "node",
        "--import",
        "tsx",
        "--input-type=module",
        "--eval",
        launcher,
    ]
    completed = subprocess.run(
        command,
        cwd=str(workspace_root),
        input=json.dumps(
            {
                "recipe_id": recipe_id,
                "phase": phase,
                "inputs": dict(inputs),
                "preferred_providers": list(preferred_providers or []),
            }
        ),
        capture_output=True,
        text=True,
        check=False,
    )
    if completed.returncode != 0:
        detail = completed.stderr.strip() or completed.stdout.strip() or "unknown launcher error"
        raise RuntimeError(f"literature workflow launcher failed: {detail}")
    return json.loads(completed.stdout)
