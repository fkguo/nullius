from __future__ import annotations

from .project_contracts_bridge import load_project_contracts_module


_module = load_project_contracts_module("scaffold_template_loader")

scaffold_template_dir = _module.scaffold_template_dir
load_scaffold_template = _module.load_scaffold_template
