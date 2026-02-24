#!/usr/bin/env bash
set -euo pipefail

# Superpowers-style installer:
# - discover skill-pack package ids from skills-market metadata
# - symlink all skill directories from a local skills source repository
# - target one platform root at a time

usage() {
  cat <<'EOF'
install_symlink_skills.sh

Install all market-listed skill-pack skills as symlinks (superpowers-style).

Usage:
  install_symlink_skills.sh --platform codex --skills-root /path/to/skills-repo

Options:
  --platform PLATFORM        Required: codex | claude_code | opencode
  --skills-root DIR          Required: local skills source repo root
                             Expected layout:
                               - DIR/skills/<skill-id>/SKILL.md  (preferred)
                               - DIR/<skill-id>/SKILL.md         (fallback)
  --market-root DIR          Optional: skills-market repo root
                             Default: parent of this script
  --target-root DIR          Optional: override target install root
  --allow-missing            Optional: skip missing skill sources with warning
  --dry-run                  Optional: print actions only
  -h, --help                 Show this help

Platform default target roots:
  codex       -> ~/.codex/skills
  claude_code -> ~/.claude/skills
  opencode    -> ~/.config/opencode/skills

Exit behavior:
  - Non-zero if any blocking error occurs.
  - With --allow-missing, missing source directories are warnings.
EOF
}

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MARKET_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
PLATFORM=""
SKILLS_ROOT=""
TARGET_ROOT=""
ALLOW_MISSING=0
DRY_RUN=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --platform)
      if [[ $# -lt 2 || -z "${2:-}" ]]; then
        echo "[error] --platform requires a value" >&2
        exit 2
      fi
      PLATFORM="$2"
      shift 2
      ;;
    --skills-root)
      if [[ $# -lt 2 || -z "${2:-}" ]]; then
        echo "[error] --skills-root requires a value" >&2
        exit 2
      fi
      SKILLS_ROOT="$2"
      shift 2
      ;;
    --market-root)
      if [[ $# -lt 2 || -z "${2:-}" ]]; then
        echo "[error] --market-root requires a value" >&2
        exit 2
      fi
      MARKET_ROOT="$2"
      shift 2
      ;;
    --target-root)
      if [[ $# -lt 2 || -z "${2:-}" ]]; then
        echo "[error] --target-root requires a value" >&2
        exit 2
      fi
      TARGET_ROOT="$2"
      shift 2
      ;;
    --allow-missing)
      ALLOW_MISSING=1
      shift
      ;;
    --dry-run)
      DRY_RUN=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "[error] unknown argument: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if [[ -z "${PLATFORM}" ]]; then
  echo "[error] --platform is required" >&2
  usage >&2
  exit 2
fi
if [[ -z "${SKILLS_ROOT}" ]]; then
  echo "[error] --skills-root is required" >&2
  usage >&2
  exit 2
fi

if [[ ! -d "${MARKET_ROOT}" ]]; then
  echo "[error] market-root does not exist: ${MARKET_ROOT}" >&2
  exit 1
fi
if [[ ! -d "${SKILLS_ROOT}" ]]; then
  echo "[error] skills-root does not exist: ${SKILLS_ROOT}" >&2
  exit 1
fi

MARKET_ROOT="$(cd -- "${MARKET_ROOT}" && pwd -P)"
SKILLS_ROOT="$(cd -- "${SKILLS_ROOT}" && pwd -P)"

if [[ ! -d "${MARKET_ROOT}/packages" ]]; then
  echo "[error] market packages directory missing: ${MARKET_ROOT}/packages" >&2
  exit 1
fi

if [[ -z "${TARGET_ROOT}" ]]; then
  case "${PLATFORM}" in
    codex) TARGET_ROOT="${HOME}/.codex/skills" ;;
    claude_code) TARGET_ROOT="${HOME}/.claude/skills" ;;
    opencode) TARGET_ROOT="${HOME}/.config/opencode/skills" ;;
    *)
      echo "[error] unsupported platform: ${PLATFORM}" >&2
      exit 2
      ;;
  esac
fi

mkdir -p "${TARGET_ROOT}"

discover_skill_ids() {
  local pkg
  local package_type
  local files=()
  local ids=()
  shopt -s nullglob
  files=("${MARKET_ROOT}"/packages/*.json)
  shopt -u nullglob

  if [[ "${#files[@]}" -eq 0 ]]; then
    echo "[error] no package metadata files found under ${MARKET_ROOT}/packages" >&2
    return 1
  fi

  for pkg in "${files[@]}"; do
    [[ "$(basename "${pkg}")" == "index.json" ]] && continue

    if ! package_type="$(python3 - "${pkg}" <<'PY'
import json
import sys

path = sys.argv[1]
with open(path, "r", encoding="utf-8") as f:
    data = json.load(f)
print(data.get("package_type", ""))
PY
)"; then
      echo "[error] failed to parse package metadata: ${pkg}" >&2
      return 1
    fi

    if [[ "${package_type}" == "skill-pack" ]]; then
      ids+=("$(basename "${pkg}" .json)")
    fi
  done

  if [[ "${#ids[@]}" -eq 0 ]]; then
    echo "[error] no skill-pack packages found under ${MARKET_ROOT}/packages" >&2
    return 1
  fi

  printf '%s\n' "${ids[@]}" | sort -u
}

resolve_source_dir() {
  local skill_id="$1"
  local candidate_a="${SKILLS_ROOT}/skills/${skill_id}"
  local candidate_b="${SKILLS_ROOT}/${skill_id}"
  if [[ -f "${candidate_a}/SKILL.md" ]]; then
    printf '%s\n' "${candidate_a}"
    return 0
  fi
  if [[ -f "${candidate_b}/SKILL.md" ]]; then
    printf '%s\n' "${candidate_b}"
    return 0
  fi
  return 1
}

is_valid_skill_id() {
  local skill_id="$1"
  [[ -n "${skill_id}" ]] || return 1
  [[ "${skill_id}" != "." && "${skill_id}" != ".." ]] || return 1
  [[ "${skill_id}" != *"/"* && "${skill_id}" != *"\\"* ]] || return 1
  [[ "${skill_id}" =~ ^[A-Za-z0-9._-]+$ ]] || return 1
  return 0
}

linked=0
missing=0
errors=0

if ! skill_ids_raw="$(discover_skill_ids)"; then
  exit 1
fi

while IFS= read -r skill_id; do
  [[ -z "${skill_id}" ]] && continue

  if ! is_valid_skill_id "${skill_id}"; then
    echo "[error] invalid skill id from package metadata: ${skill_id}" >&2
    errors=$((errors + 1))
    continue
  fi

  target="${TARGET_ROOT}/${skill_id}"

  if ! source_dir="$(resolve_source_dir "${skill_id}")"; then
    if [[ "${ALLOW_MISSING}" -eq 1 ]]; then
      echo "[warn] missing source for ${skill_id} under ${SKILLS_ROOT}"
      missing=$((missing + 1))
      continue
    else
      echo "[error] missing source for ${skill_id} under ${SKILLS_ROOT}" >&2
      errors=$((errors + 1))
      continue
    fi
  fi

  if ! source_dir="$(cd -- "${source_dir}" && pwd -P)"; then
    echo "[error] failed to resolve source path for ${skill_id}: ${source_dir}" >&2
    errors=$((errors + 1))
    continue
  fi
  if [[ "${source_dir}" != "${SKILLS_ROOT}" && "${source_dir#"$SKILLS_ROOT"/}" == "${source_dir}" ]]; then
    echo "[error] source path escapes skills-root for ${skill_id}: ${source_dir}" >&2
    errors=$((errors + 1))
    continue
  fi

  if [[ -e "${target}" && ! -L "${target}" ]]; then
    echo "[error] target exists and is not symlink: ${target}" >&2
    errors=$((errors + 1))
    continue
  fi

  if [[ "${DRY_RUN}" -eq 1 ]]; then
    echo "[dry-run] ln -sfn \"${source_dir}\" \"${target}\""
  else
    ln -sfn "${source_dir}" "${target}"
    echo "[ok] linked ${skill_id} -> ${target}"
  fi
  linked=$((linked + 1))
done <<< "${skill_ids_raw}"

echo "[summary] platform=${PLATFORM} target_root=${TARGET_ROOT} linked=${linked} missing=${missing} errors=${errors}"

if [[ "${errors}" -gt 0 ]]; then
  exit 1
fi

exit 0
