from __future__ import annotations

import sys

from .orchestrator_cli import main as _orchestrator_main


def main() -> int:
    try:
        return _orchestrator_main()
    except Exception as exc:
        print(f"[error] {exc}", file=sys.stderr)
        return 1
