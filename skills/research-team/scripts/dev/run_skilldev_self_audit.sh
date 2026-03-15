#!/usr/bin/env bash
set -euo pipefail

WORKSPACE=""
PROFILE="methodology_dev"
STAGE="development"
TAG="SKILLDEV-M0"
RESET=0
WITH_REVIEWS=0
WITH_SMOKE=0
WITH_REGRESSION=0
REGRESSION_REGISTRY=""
REGRESSION_RUNS_DIR=""

usage() {
  cat <<'EOF'
run_skilldev_self_audit.sh

One-shot maintainer entrypoint to self-audit this skill using a generated local workspace.

Default behavior:
  1) init/refresh a local workspace (scaffold + deterministic demo milestone)
  2) run `run_team_cycle.sh --preflight-only` inside that workspace
  3) print exploration debt summary (if any)

Usage:
  bash scripts/dev/run_skilldev_self_audit.sh [--workspace PATH] [--stage exploration|development|publication] [--with-reviews]

Options:
  --workspace PATH        Workspace directory (default: <skill_root>/skilldev)
  --profile PROFILE       Passed to scaffold (default: methodology_dev)
  --stage STAGE           exploration|development|publication (default: development)
  --tag TAG               Demo milestone tag (default: SKILLDEV-M0)
  --reset                 Recreate workspace (safe; requires marker file)
  --with-reviews          Run full team cycle (calls external Claude+Gemini CLIs)
  --with-smoke            Also run `bash scripts/dev/run_all_smoke_tests.sh` (from skill root)
  --with-regression       Also run realism regression (runs preflight-only on registered real projects)
  --regression-registry PATH  Override regression registry path
  --regression-runs-dir PATH  Override regression runs output dir
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --workspace) WORKSPACE="${2:-}"; shift 2 ;;
    --profile) PROFILE="${2:-}"; shift 2 ;;
    --stage) STAGE="${2:-}"; shift 2 ;;
    --tag) TAG="${2:-}"; shift 2 ;;
    --reset) RESET=1; shift ;;
    --with-reviews) WITH_REVIEWS=1; shift ;;
    --with-smoke) WITH_SMOKE=1; shift ;;
    --with-regression) WITH_REGRESSION=1; shift ;;
    --regression-registry) REGRESSION_REGISTRY="${2:-}"; shift 2 ;;
    --regression-runs-dir) REGRESSION_RUNS_DIR="${2:-}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown arg: $1" >&2; usage; exit 2 ;;
  esac
done

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

if [[ -z "${WORKSPACE}" ]]; then
  WORKSPACE="${SKILL_ROOT}/skilldev"
fi

init_args=( --workspace "${WORKSPACE}" --profile "${PROFILE}" --stage "${STAGE}" --tag "${TAG}" )
if [[ "${RESET}" -eq 1 ]]; then
  init_args+=( --reset )
fi
bash "${SKILL_ROOT}/scripts/dev/init_skilldev_workspace.sh" "${init_args[@]}"

safe_tag="$(echo "${TAG}" | sed -E 's/[^A-Za-z0-9._-]+/_/g')"

bash "${SKILL_ROOT}/scripts/dev/check_scaffold_output_contract.sh" --root "${WORKSPACE}"

pushd "${WORKSPACE}" >/dev/null
cycle_args=(
  --tag "${TAG}"
  --notes research_contract.md
  --out-dir team
  --member-a-system prompts/_system_member_a.txt
  --member-b-system prompts/_system_member_b.txt
)
if [[ "${WITH_REVIEWS}" -ne 1 ]]; then
  cycle_args+=( --preflight-only )
fi
bash "${SKILL_ROOT}/scripts/bin/run_team_cycle.sh" "${cycle_args[@]}"
popd >/dev/null

python3 "${SKILL_ROOT}/scripts/bin/exploration_debt_dashboard.py" summary --team-dir "${WORKSPACE}/team" --max-items 25 || true

packet="${WORKSPACE}/team/runs/${safe_tag}/team_packet_${safe_tag}.txt"
if [[ -f "${packet}" ]]; then
  echo "[ok] skilldev packet: ${packet}" >&2
fi

if [[ "${WITH_SMOKE}" -eq 1 ]]; then
  bash "${SKILL_ROOT}/scripts/dev/run_all_smoke_tests.sh"
fi

if [[ "${WITH_REGRESSION}" -eq 1 ]]; then
  reg_args=()
  if [[ -n "${REGRESSION_REGISTRY}" ]]; then
    reg_args+=( --registry "${REGRESSION_REGISTRY}" )
  fi
  if [[ -n "${REGRESSION_RUNS_DIR}" ]]; then
    reg_args+=( --runs-dir "${REGRESSION_RUNS_DIR}" )
  fi
  bash "${SKILL_ROOT}/scripts/dev/run_real_project_regression.sh" "${reg_args[@]}"
fi
