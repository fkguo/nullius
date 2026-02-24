#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_ROOT="$(cd "${SCRIPT_DIR}/../../.." && pwd)"

tmp_root="$(mktemp -d)"
cleanup() { rm -rf "${tmp_root}"; }
trap cleanup EXIT

echo "[smoke] tmp_root=${tmp_root}"

mkdir -p "${tmp_root}/kb/sub"
printf '%s\n' "# a" >"${tmp_root}/kb/sub/a.md"
printf '%s\n' "# b" >"${tmp_root}/kb/sub/b.markdown"

SKILL_ROOT="${SKILL_ROOT}" TMP_ROOT="${tmp_root}" python3 - <<'PY'
from __future__ import annotations

import os
import sys
from pathlib import Path

skill_root = Path(os.environ["SKILL_ROOT"]).resolve()
tmp = Path(os.environ["TMP_ROOT"]).resolve()

sys.path.insert(0, str(skill_root / "scripts" / "lib"))

from md_utils import iter_inline_code_spans, iter_md_files_by_targets, iter_md_files_under, strip_inline_code_spans  # type: ignore

# Inline code parsing (variable-length backticks).
assert strip_inline_code_spans("a `b` c") == "a  c"
assert strip_inline_code_spans("a ``b`` c") == "a  c"
assert strip_inline_code_spans("unclosed `code") == "unclosed `code"

sp = iter_inline_code_spans("x ``y`` z")
assert len(sp) == 1 and sp[0][2] == "y", sp

# File iteration under a directory (md + markdown).
files = iter_md_files_under(tmp / "kb")
rel = [p.relative_to(tmp).as_posix() for p in files]
assert rel == ["kb/sub/a.md", "kb/sub/b.markdown"], rel

# Target resolution + excludes.
files2, missing = iter_md_files_by_targets(tmp, ["kb/**/*.md", "kb/**/*.markdown"], ["kb/sub/b.markdown"])
assert missing == [], missing
rel2 = [p.relative_to(tmp).as_posix() for p in files2]
assert rel2 == ["kb/sub/a.md"], rel2
print("[ok] md_utils smoke assertions passed")
PY
