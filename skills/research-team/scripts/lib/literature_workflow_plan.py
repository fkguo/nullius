from __future__ import annotations

import json
import os
import subprocess
from pathlib import Path
from typing import Any, Iterable


def _valid_workspace_root(path: Path) -> Path | None:
    path = path.expanduser()
    if not path.is_absolute():
        return None
    root = path.resolve()
    if not (root / "pnpm-workspace.yaml").is_file():
        return None
    try:
        package = json.loads((root / "package.json").read_text(encoding="utf-8"))
        orchestrator = json.loads((root / "packages/orchestrator/package.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    if not isinstance(package, dict) or not isinstance(orchestrator, dict):
        return None
    if package.get("name") != "nullius" or orchestrator.get("name") != "@nullius/orchestrator":
        return None
    if orchestrator.get("bin") != {"nullius": "dist/cli.js"}:
        return None
    required = (
        "packages/orchestrator/src/cli.ts",
        "packages/literature-workflows/src/index.ts",
        "packages/project-contracts/src/project_contracts/research_contract.py",
    )
    return root if all((root / relative).is_file() for relative in required) else None


def _workspace_root_from_runtime() -> Path:
    try:
        completed = subprocess.run(
            ["nullius", "runtime", "path"], capture_output=True, text=True,
            check=False, timeout=10,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise RuntimeError(
            "Unable to locate Nullius runtime. Make nullius available on PATH or set "
            "NULLIUS_WORKSPACE_ROOT to an absolute Nullius checkout."
        ) from exc
    value = completed.stdout.strip()
    root = _valid_workspace_root(Path(value)) if value and "\n" not in value and "\r" not in value else None
    if completed.returncode != 0 or root is None:
        raise RuntimeError(
            "nullius runtime path did not return one absolute Nullius source workspace with its canonical packages and entrypoints."
        )
    return root


def _workspace_root() -> Path:
    current = Path(__file__).resolve()
    env_root = os.environ.get("NULLIUS_WORKSPACE_ROOT", "").strip()
    if env_root:
        workspace_root = _valid_workspace_root(Path(env_root))
        if workspace_root is None:
            raise RuntimeError(
                "NULLIUS_WORKSPACE_ROOT does not point to a Nullius workspace "
                f"with its canonical packages and entrypoints: {env_root}"
            )
        return workspace_root

    for candidate in [current, *current.parents]:
        workspace_root = _valid_workspace_root(candidate)
        if workspace_root is not None:
            return workspace_root
    return _workspace_root_from_runtime()


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
        "@nullius/literature-workflows",
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


if __name__ == "__main__":
    print(_workspace_root())
