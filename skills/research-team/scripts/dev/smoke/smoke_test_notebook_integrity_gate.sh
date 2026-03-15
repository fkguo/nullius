#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_ROOT="$(cd "${SCRIPT_DIR}/../../.." && pwd)"
BIN_DIR="${SKILL_ROOT}/scripts/bin"
GATE="${SKILL_ROOT}/scripts/gates/check_notebook_integrity.py"

tmp_root="$(mktemp -d)"
cleanup() { rm -rf "${tmp_root}"; }
trap cleanup EXIT

echo "[smoke] tmp_root=${tmp_root}"

if [[ ! -f "${GATE}" ]]; then
  echo "[fail] gate script missing: ${GATE}" >&2
  exit 2
fi

bash "${BIN_DIR}/scaffold_research_workflow.sh" --root "${tmp_root}" --project "SmokeNotebookIntegrity" --profile "mixed" --full >/dev/null 2>&1
python3 "${BIN_DIR}/generate_demo_milestone.py" --root "${tmp_root}" --tag "M0-demo" >/dev/null 2>&1

notes="${tmp_root}/research_contract.md"

# Ensure gate is enabled deterministically.
python3 - "${tmp_root}/research_team_config.json" <<'PY'
from __future__ import annotations

import json
import sys
from pathlib import Path

p = Path(sys.argv[1])
d = json.loads(p.read_text(encoding="utf-8", errors="replace"))
d.setdefault("features", {})
d["features"]["notebook_integrity_gate"] = True
p.write_text(json.dumps(d, indent=2, sort_keys=True) + "\n", encoding="utf-8")
PY

echo "[test0] baseline passes"
python3 "${GATE}" --notes "${notes}" >"${tmp_root}/nb_ok.log" 2>&1

patch_excerpt() {
  local mode="$1" # bad | split | good
  python3 - "${notes}" "${mode}" <<'PY'
from __future__ import annotations

import sys
from pathlib import Path

notes = Path(sys.argv[1])
mode = sys.argv[2].strip()
text = notes.read_text(encoding="utf-8", errors="replace").replace("\r\n", "\n").replace("\r", "\n")

START = "<!-- REVIEW_EXCERPT_START -->"
END = "<!-- REVIEW_EXCERPT_END -->"
if START not in text or END not in text:
    raise SystemExit("missing REVIEW_EXCERPT markers")
a = text.index(START) + len(START)
b = text.index(END)

if mode == "bad":
    excerpt = """
Bad excerpt (smoke): inject known rendering hazards.

`[demo](knowledge_base/literature/demo.md)`

$$
a = 1
- b = 2
$$
""".strip()
elif mode == "split":
    excerpt = """
Split excerpt (smoke): inject split-$$ hazard (back-to-back display blocks).

[demo](knowledge_base/literature/bezanson2017_julia.md)

$$
a = 1
b = 2
$$
$$
\\qquad c = 3
$$
""".strip()
elif mode == "good":
    excerpt = """
Safe excerpt (smoke): no backticked links; no leading operators in display math.

[demo](knowledge_base/literature/bezanson2017_julia.md)

$$
a = 1
b = 2
$$

~~~text
$$
- not math (code fence; should be ignored)
$$
~~~
""".strip()
else:
    raise SystemExit(f"unknown mode: {mode}")

out = text[:a] + "\n" + excerpt + "\n" + text[b:]
notes.write_text(out, encoding="utf-8")
print("patched:", notes, "mode=", mode)
PY
}

echo "[test1] injected hazards fail"
patch_excerpt "bad" >/dev/null 2>&1
set +e
python3 "${GATE}" --notes "${notes}" >"${tmp_root}/nb_bad.log" 2>&1
code1=$?
set -e
if [[ ${code1} -eq 0 ]]; then
  echo "[fail] expected notebook integrity gate to fail; got:" >&2
  sed -n '1,220p' "${tmp_root}/nb_bad.log" >&2 || true
  exit 1
fi
if ! grep -nF "Markdown link is wrapped in inline code" "${tmp_root}/nb_bad.log" >/dev/null 2>&1; then
  echo "[fail] expected backticked-link error marker; got:" >&2
  sed -n '1,220p' "${tmp_root}/nb_bad.log" >&2 || true
  exit 1
fi
if ! grep -nF 'line inside $$...$$ starts with' "${tmp_root}/nb_bad.log" >/dev/null 2>&1; then
  echo "[fail] expected display-math leading-operator error marker; got:" >&2
  sed -n '1,240p' "${tmp_root}/nb_bad.log" >&2 || true
  exit 1
fi
echo "[ok] fail case"

echo '[test1b] injected split-$$ hazard fails'
patch_excerpt "split" >/dev/null 2>&1
set +e
python3 "${GATE}" --notes "${notes}" >"${tmp_root}/nb_split.log" 2>&1
code1b=$?
set -e
if [[ ${code1b} -eq 0 ]]; then
  echo "[fail] expected split-$$ notebook integrity gate failure; got:" >&2
  sed -n '1,220p' "${tmp_root}/nb_split.log" >&2 || true
  exit 1
fi
if ! grep -nF "suspected split display equation" "${tmp_root}/nb_split.log" >/dev/null 2>&1; then
  echo "[fail] expected split-$$ error marker; got:" >&2
  sed -n '1,240p' "${tmp_root}/nb_split.log" >&2 || true
  exit 1
fi
echo '[ok] split-$$ fail case'

echo "[test2] repaired excerpt passes"
patch_excerpt "good" >/dev/null 2>&1
python3 "${GATE}" --notes "${notes}" >"${tmp_root}/nb_good.log" 2>&1
if ! grep -nF -- "- Gate: PASS" "${tmp_root}/nb_good.log" >/dev/null 2>&1; then
  echo "[fail] expected PASS marker; got:" >&2
  sed -n '1,220p' "${tmp_root}/nb_good.log" >&2 || true
  exit 1
fi
echo "[ok] notebook integrity gate pass/fail smoke test passed"
