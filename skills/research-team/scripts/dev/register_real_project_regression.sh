#!/usr/bin/env bash
set -euo pipefail

NAME=""
ROOT=""
REGISTRY=""
NOTES="research_contract.md"
OUT_DIR="team"
MEMBER_A_SYSTEM="prompts/_system_member_a.txt"
MEMBER_B_SYSTEM="prompts/_system_member_b.txt"
STAGE_OVERRIDE=""
REPLACE=0

usage() {
  cat <<'EOF'
register_real_project_regression.sh

Register a real project as a "realism regression" target for this skill.

This writes a local registry JSON (default under skilldev/, which is git-ignored).

Usage:
  bash scripts/dev/register_real_project_regression.sh --name NAME --root /abs/path/to/project

Options:
  --name NAME              Registry name (unique key).
  --root PATH              Project root (absolute or relative; stored as absolute).
  --registry PATH          Registry JSON path (default: <skill_root>/skilldev/regression/real_projects.json).
  --notes PATH             Notebook path inside project (default: research_contract.md).
  --out-dir DIR            Team output dir (default: team).
  --member-a-system PATH   Member A system prompt (default: prompts/_system_member_a.txt).
  --member-b-system PATH   Member B system prompt (default: prompts/_system_member_b.txt).
  --stage STAGE            Optional stage override applied on copied snapshots (exploration|development|publication).
  --replace                Replace existing entry with same --name.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --name) NAME="${2:-}"; shift 2 ;;
    --root) ROOT="${2:-}"; shift 2 ;;
    --registry) REGISTRY="${2:-}"; shift 2 ;;
    --notes) NOTES="${2:-}"; shift 2 ;;
    --out-dir) OUT_DIR="${2:-}"; shift 2 ;;
    --member-a-system) MEMBER_A_SYSTEM="${2:-}"; shift 2 ;;
    --member-b-system) MEMBER_B_SYSTEM="${2:-}"; shift 2 ;;
    --stage) STAGE_OVERRIDE="${2:-}"; shift 2 ;;
    --replace) REPLACE=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown arg: $1" >&2; usage; exit 2 ;;
  esac
done

if [[ -z "${NAME}" || -z "${ROOT}" ]]; then
  echo "ERROR: --name and --root are required." >&2
  usage
  exit 2
fi

if [[ -n "${STAGE_OVERRIDE}" ]]; then
  case "${STAGE_OVERRIDE}" in
    exploration|development|publication) ;;
    *)
      echo "ERROR: invalid --stage: ${STAGE_OVERRIDE} (expected exploration|development|publication)" >&2
      exit 2
      ;;
  esac
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

if [[ -z "${REGISTRY}" ]]; then
  REGISTRY="${SKILL_ROOT}/skilldev/regression/real_projects.json"
fi

python3 - "${REGISTRY}" "${NAME}" "${ROOT}" "${NOTES}" "${OUT_DIR}" "${MEMBER_A_SYSTEM}" "${MEMBER_B_SYSTEM}" "${STAGE_OVERRIDE}" "${REPLACE}" <<'PY'
from __future__ import annotations

import json
import sys
from pathlib import Path


def die(msg: str, code: int = 2) -> None:
    print(f"ERROR: {msg}", file=sys.stderr)
    raise SystemExit(code)


registry_path = Path(sys.argv[1]).expanduser()
name = str(sys.argv[2]).strip()
root = Path(str(sys.argv[3]).strip()).expanduser()
notes = str(sys.argv[4]).strip() or "research_contract.md"
out_dir = str(sys.argv[5]).strip() or "team"
member_a_system = str(sys.argv[6]).strip() or "prompts/_system_member_a.txt"
member_b_system = str(sys.argv[7]).strip() or "prompts/_system_member_b.txt"
stage_override = str(sys.argv[8]).strip()
replace = str(sys.argv[9]).strip() == "1"

if not name:
    die("empty --name")
if not str(root):
    die("empty --root")

try:
    root_abs = root.resolve()
except Exception:
    die(f"cannot resolve --root: {root}")

if not root_abs.exists():
    die(f"project root not found: {root_abs}")
if not root_abs.is_dir():
    die(f"project root is not a directory: {root_abs}")

entry: dict[str, object] = {
    "name": name,
    "root": str(root_abs),
    "notes": notes,
    "out_dir": out_dir,
    "member_a_system": member_a_system,
    "member_b_system": member_b_system,
}
if stage_override:
    entry["stage_override"] = stage_override

data: dict[str, object] = {"version": 1, "projects": []}
if registry_path.exists():
    try:
        loaded = json.loads(registry_path.read_text(encoding="utf-8", errors="replace"))
        if isinstance(loaded, dict):
            data = loaded
    except Exception:
        die(f"failed to parse registry JSON: {registry_path}")

projects = data.get("projects")
if not isinstance(projects, list):
    projects = []
    data["projects"] = projects

idx = None
for i, it in enumerate(projects):
    if isinstance(it, dict) and str(it.get("name", "")).strip() == name:
        idx = i
        break

if idx is not None and not replace:
    die(f"project '{name}' already exists in registry. Use --replace to overwrite.")

if idx is None:
    projects.append(entry)
else:
    projects[idx] = entry

registry_path.parent.mkdir(parents=True, exist_ok=True)
registry_path.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
print(f"[ok] registered realism regression project: {name}")
print(f"[ok] registry: {registry_path}")
print(f"[ok] root: {root_abs}")
PY

