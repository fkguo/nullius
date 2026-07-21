from __future__ import annotations

import argparse
import json
from pathlib import Path

from .main_research_report import validate_main_research_report


def main() -> int:
    parser = argparse.ArgumentParser(description="Validate the promoted main research report contract.")
    parser.add_argument("--project-root", type=Path, required=True, help="External project root containing project_index.md.")
    args = parser.parse_args()
    result = validate_main_research_report(args.project_root)
    print(json.dumps(result, indent=2, sort_keys=True))
    return 0 if result["status"] == "pass" else 3


if __name__ == "__main__":
    raise SystemExit(main())
