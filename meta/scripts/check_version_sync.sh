#!/usr/bin/env bash
# M-23: Check that root package.json version matches all pyproject.toml versions.
# Exit non-zero if any mismatch is found.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"

root_version=$(python3 -c "import json; print(json.load(open('$REPO_ROOT/package.json'))['version'])")

mismatches=()

for pyproject in "$REPO_ROOT"/packages/*/pyproject.toml; do
    pkg_dir=$(dirname "$pyproject")
    pkg_name=$(basename "$pkg_dir")

    # Extract version from pyproject.toml (handles both inline and multi-line)
    py_version=$(python3 -c "
import re, sys
text = open('$pyproject').read()
m = re.search(r'^version\s*=\s*\"([^\"]+)\"', text, re.MULTILINE)
if m:
    print(m.group(1))
else:
    print('MISSING')
")

    if [ "$py_version" = "MISSING" ]; then
        continue  # Not a Python package or no version field
    fi

    if [ "$py_version" != "$root_version" ]; then
        mismatches+=("$pkg_name: pyproject.toml=$py_version (expected $root_version)")
    fi
done

if [ ${#mismatches[@]} -gt 0 ]; then
    echo "ERROR: Version mismatch detected!" >&2
    echo "Root package.json version: $root_version" >&2
    for m in "${mismatches[@]}"; do
        echo "  - $m" >&2
    done
    exit 1
fi

echo "OK: All versions match ($root_version)"
