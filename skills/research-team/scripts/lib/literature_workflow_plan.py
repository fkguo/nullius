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


def resolve_workflow_plan(
    *,
    recipe_id: str,
    phase: str,
    inputs: dict[str, Any],
    preferred_providers: Iterable[str] | None = None,
) -> dict[str, Any]:
    workspace_root = _workspace_root()
    command = [
        "pnpm",
        "--dir",
        str(workspace_root),
        "--filter",
        "@autoresearch/literature-workflows",
        "exec",
        "tsx",
        "src/cli.ts",
        "resolve",
        "--recipe",
        recipe_id,
        "--phase",
        phase,
    ]
    completed = subprocess.run(
        command,
        cwd=str(workspace_root),
        input=json.dumps(
            {
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
