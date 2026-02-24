from __future__ import annotations

from .orchestrator_cli import main as _orchestrator_main


def main() -> int:
    return _orchestrator_main()

