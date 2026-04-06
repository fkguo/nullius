from __future__ import annotations

import sys

from .orchestrator_cli import public_main as _public_main


def main() -> int:
    try:
        return _public_main()
    except SystemExit as exc:
        code = exc.code
        return int(code) if isinstance(code, int) else 1
    except Exception as exc:
        print(f"[error] {exc}", file=sys.stderr)
        return 1
