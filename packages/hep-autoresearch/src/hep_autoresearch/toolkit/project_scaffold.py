from __future__ import annotations

from .project_contracts_bridge import load_project_contracts_module


_module = load_project_contracts_module("project_scaffold")

ensure_project_scaffold = _module.ensure_project_scaffold
