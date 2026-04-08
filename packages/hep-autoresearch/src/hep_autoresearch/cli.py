from __future__ import annotations

import sys

RETIRED_MESSAGE = (
    "The installable legacy `hepar` / `hep-autoresearch` shell has been retired. "
    "Use the root `autoresearch` CLI instead."
)


def main() -> int:
    print(f"[error] {RETIRED_MESSAGE}", file=sys.stderr)
    return 1
