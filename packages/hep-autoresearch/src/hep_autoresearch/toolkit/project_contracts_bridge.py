from __future__ import annotations

import importlib
import sys
from pathlib import Path
from types import ModuleType


def load_project_contracts_module(module_name: str) -> ModuleType:
    target = f"project_contracts.{module_name}"
    try:
        return importlib.import_module(target)
    except ModuleNotFoundError as exc:
        if exc.name not in {"project_contracts", target}:
            raise
        repo_root = Path(__file__).resolve().parents[5]
        src_root = repo_root / "packages" / "project-contracts" / "src"
        if src_root.is_dir():
            sys.path.insert(0, str(src_root))
        return importlib.import_module(target)
