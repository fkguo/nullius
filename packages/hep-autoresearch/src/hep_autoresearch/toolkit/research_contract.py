from __future__ import annotations

from .project_contracts_bridge import load_project_contracts_module


_module = load_project_contracts_module("research_contract")

SYNC_START = _module.SYNC_START
SYNC_END = _module.SYNC_END
sync_research_contract = _module.sync_research_contract
