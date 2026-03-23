from __future__ import annotations

from .project_contracts_bridge import load_project_contracts_module


main = load_project_contracts_module("project_scaffold_cli").main


if __name__ == "__main__":
    raise SystemExit(main())
