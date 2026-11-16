#!/usr/bin/env python3
"""Internal read-only runtime capture verifier: one structured JSON request on stdin."""
import json
import sys
from pathlib import Path

from runtime_capture_observation import verify_capture_observation


def main() -> int:
    try:
        request = json.load(sys.stdin)
        if not isinstance(request, dict) or not {"budget_path", "report_path", "input_sha256"} <= set(request) or set(request) - {"budget_path", "report_path", "input_sha256", "expected_working_directory", "expected_context_tokens", "expected_backend"}:
            raise ValueError("invalid observation verification request")
        budget = Path(request["budget_path"]) if request["budget_path"] is not None else None
        result = verify_capture_observation(budget, Path(request["report_path"]), request["input_sha256"], request.get("expected_working_directory"), request.get("expected_context_tokens"), request.get("expected_backend"))
    except (ValueError, OSError, KeyError, TypeError) as error:
        print(json.dumps({"valid": False, "reason": str(error)}))
        return 1
    print(json.dumps(result))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
