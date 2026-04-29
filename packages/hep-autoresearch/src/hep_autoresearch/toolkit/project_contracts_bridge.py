from __future__ import annotations

import importlib
import sys
from pathlib import Path
from types import ModuleType


def _prefer_local_project_contracts() -> None:
    repo_root = Path(__file__).resolve().parents[5]
    src_root = repo_root / "packages" / "project-contracts" / "src"
    if src_root.is_dir():
        src = str(src_root)
        if src not in sys.path:
            sys.path.insert(0, src)


def load_project_contracts_module(module_name: str) -> ModuleType:
    target = f"project_contracts.{module_name}"
    _prefer_local_project_contracts()
    try:
        return importlib.import_module(target)
    except ModuleNotFoundError as exc:
        if exc.name not in {"project_contracts", target}:
            raise
        return importlib.import_module(target)
