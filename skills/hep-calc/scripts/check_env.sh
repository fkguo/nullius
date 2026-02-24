#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
check_env.sh: environment check for hep-calc

Usage:
  check_env.sh [--json <path>]

Writes a machine-readable JSON summary (if --json provided) and prints
human-readable diagnostics to stdout/stderr.
EOF
}

JSON_OUT=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --json)
      JSON_OUT="${2:-}"; shift 2 ;;
    --help|-h)
      usage; exit 0 ;;
    *)
      echo "ERROR: unknown arg: $1" >&2
      usage
      exit 2 ;;
  esac
done

python_ok=0
wolfram_ok=0
julia_ok=0
mma_pkgs_ok=0
mma_feyncalc_ok=0
mma_feynarts_ok=0
mma_formcalc_ok=0
julia_looptools_ok=0
looptools_bin_ok=0
feynrules_present=0
feynrules_ok=0

python_path="$(command -v python3 || true)"
wolfram_path="$(command -v wolframscript || true)"
julia_path="$(command -v julia || true)"

python_ver=""
wolfram_ver=""
wls_probe_out=""
wls_probe_rc=0
wolfram_reason=""
wolfram_hint=""
julia_ver=""
mma_version=""
system_id=""
feyncalc_ver=""
feynarts_ver=""
formcalc_ver=""
looptools_jl_ver=""
looptools_bin_sha256=""
feynrules_root=""
feynrules_ver=""
feynrules_date=""

if [[ -n "${python_path}" ]]; then
  python_ok=1
  python_ver="$(python3 -c 'import sys; print(sys.version.replace("\n"," "))' 2>/dev/null || true)"
fi

if [[ -n "${wolfram_path}" ]]; then
  wolfram_ver="$(wolframscript -version 2>/dev/null || true)"
  # Probe whether the local Wolfram kernel can execute code (license/activation issues show up here).
  set +e
  wls_probe_out="$(wolframscript -noprompt -code 'Print["HEP_CALC_WOLFRAM_OK"]; Quit[]' 2>&1)"
  wls_probe_rc=$?
  set -e

  if [[ "${wls_probe_rc}" -eq 0 ]] && echo "${wls_probe_out}" | grep -q "HEP_CALC_WOLFRAM_OK"; then
    wolfram_ok=1
    mma_version="$(wolframscript -noprompt -code 'Print[$Version]; Quit[]' 2>/dev/null | head -n 1 || true)"
    system_id="$(wolframscript -noprompt -code 'Print[$SystemID]; Quit[]' 2>/dev/null | head -n 1 || true)"

    if wolframscript -noprompt -code 'Quiet@Check[Needs["FeynCalc`"]; Quit[0], Quit[1], {Get::noopen, Needs::nocont}]' >/dev/null 2>&1; then
      mma_feyncalc_ok=1
    fi
    if wolframscript -noprompt -code 'Quiet@Check[Needs["FeynArts`"]; Quit[0], Quit[1], {Get::noopen, Needs::nocont}]' >/dev/null 2>&1; then
      mma_feynarts_ok=1
    fi
    if wolframscript -noprompt -code 'Quiet@Check[Needs["FormCalc`"]; Quit[0], Quit[1], {Get::noopen, Needs::nocont}]' >/dev/null 2>&1; then
      mma_formcalc_ok=1
    fi
    if [[ "${mma_feyncalc_ok}" -eq 1 && "${mma_feynarts_ok}" -eq 1 && "${mma_formcalc_ok}" -eq 1 ]]; then
      mma_pkgs_ok=1
    fi
  else
    wolfram_ok=0
    wolfram_reason="kernel_unavailable"
    wolfram_hint="Wolfram kernel is not runnable (often license/activation). Try: wolframscript -code '2+2'. If it errors, activate Mathematica/Wolfram Engine (open it once, or use wolframscript -activate)."
    if echo "${wls_probe_out}" | grep -qiE 'not activated|license|No valid password|activate'; then
      wolfram_reason="not_activated"
    fi
  fi
fi

if [[ -n "${julia_path}" ]]; then
  julia_ok=1
  julia_ver="$(julia --version 2>/dev/null || true)"
  if julia --startup-file=no -e 'using LoopTools; println(LoopTools.VERSION)' >/dev/null 2>&1; then
    julia_looptools_ok=1
  fi
fi

lt_bin=""
lt_root="${HOME}/Library/Wolfram/Applications/LoopTools"
if [[ -d "${lt_root}" ]]; then
  lt_bin="$(find -L "${lt_root}" -maxdepth 5 -type f -path '*/bin/lt' 2>/dev/null | head -n 1 || true)"
  if [[ -n "${lt_bin}" && -x "${lt_bin}" ]]; then
    looptools_bin_ok=1
  fi
fi

if [[ "${wolfram_ok}" -eq 1 && "${mma_feyncalc_ok}" -eq 1 ]]; then
  feyncalc_ver="$(
    wolframscript -noprompt -code 'Needs["FeynCalc`"]; If[ValueQ[FeynCalc`$FeynCalcVersion], Print[FeynCalc`$FeynCalcVersion], Print["unknown"]]; Quit[]' 2>/dev/null | tail -n 1 || true
  )"
fi
if [[ "${wolfram_ok}" -eq 1 && "${mma_feynarts_ok}" -eq 1 ]]; then
  feynarts_ver="$(
    wolframscript -noprompt -code 'Needs["FeynArts`"]; If[ValueQ[FeynArts`$FeynArtsVersion], Print[FeynArts`$FeynArtsVersion], Print["unknown"]]; Quit[]' 2>/dev/null | tail -n 1 || true
  )"
fi
if [[ "${wolfram_ok}" -eq 1 && "${mma_formcalc_ok}" -eq 1 ]]; then
  formcalc_ver="$(
    wolframscript -noprompt -code 'Needs["FormCalc`"]; If[ValueQ[FormCalc`$FormCalcVersion], Print[FormCalc`$FormCalcVersion], Print["unknown"]]; Quit[]' 2>/dev/null | tail -n 1 || true
  )"
fi

fr_root_candidate="${FEYNRULES_PATH:-${HOME}/Library/Wolfram/Applications/FeynRules}"
if [[ -d "${fr_root_candidate}" && -f "${fr_root_candidate}/FeynRules.m" ]]; then
  feynrules_present=1
  feynrules_root="${fr_root_candidate}"
  if [[ "${wolfram_ok}" -eq 1 ]]; then
    fr_lines="$(wolframscript -noprompt -code 'fr="'"${feynrules_root}"'"; $FeynRulesPath=fr; Quiet@Check[Get[FileNameJoin[{fr,"FeynRules.m"}]], Quit[2], {Get::noopen, Needs::nocont}]; Print["VERSION="<>ToString[FeynRules`FR$VersionNumber]]; Print["DATE="<>ToString[FeynRules`FR$VersionDate]]; Quit[0]' 2>/dev/null || true)"
    if echo "${fr_lines}" | grep -q '^VERSION='; then
      feynrules_ok=1
      feynrules_ver="$(echo "${fr_lines}" | grep '^VERSION=' | head -n 1 | sed 's/^VERSION=//')"
      feynrules_date="$(echo "${fr_lines}" | grep '^DATE=' | head -n 1 | sed 's/^DATE=//')"
    fi
  fi
fi

if [[ "${julia_ok}" -eq 1 && "${julia_looptools_ok}" -eq 1 ]]; then
  looptools_jl_ver="$(
    julia --startup-file=no -e 'using TOML; p=Base.find_package("LoopTools"); if p===nothing; print(""); else; pkgdir=abspath(normpath(joinpath(dirname(p), ".."))); proj=joinpath(pkgdir, "Project.toml"); if !isfile(proj); print(""); else; t=TOML.parsefile(proj); print(get(t,"version","")); end; end' 2>/dev/null || true
  )"
fi

if [[ "${python_ok}" -eq 1 && "${looptools_bin_ok}" -eq 1 && -n "${lt_bin}" ]]; then
  looptools_bin_sha256="$(python3 - "${lt_bin}" <<'PY' 2>/dev/null || true
import hashlib
import sys

p = sys.argv[1]
h = hashlib.sha256()
with open(p, "rb") as f:
    for chunk in iter(lambda: f.read(1024 * 1024), b""):
        h.update(chunk)
print(h.hexdigest())
PY
)"
fi

ok_full=1
if [[ "${python_ok}" -ne 1 || "${wolfram_ok}" -ne 1 || "${julia_ok}" -ne 1 || "${mma_pkgs_ok}" -ne 1 || "${julia_looptools_ok}" -ne 1 ]]; then
  ok_full=0
fi
ok="${python_ok}"

echo "python3: ${python_ok} (${python_path})"
echo "wolframscript: ${wolfram_ok} (${wolfram_path})"
echo "julia: ${julia_ok} (${julia_path})"
echo "mma_packages: ${mma_pkgs_ok} (FeynCalc=${mma_feyncalc_ok} FeynArts=${mma_feynarts_ok} FormCalc=${mma_formcalc_ok})"
echo "julia_looptools: ${julia_looptools_ok} (using LoopTools)"
echo "looptools_bin: ${looptools_bin_ok} (${lt_bin})"
echo "feyncalc: ${feyncalc_ver}"
echo "feynarts: ${feynarts_ver}"
echo "formcalc: ${formcalc_ver}"
echo "looptools_jl: ${looptools_jl_ver}"
echo "feynrules_present: ${feynrules_present} (${feynrules_root})"
echo "feynrules: ${feynrules_ok} (${feynrules_ver} ${feynrules_date})"

echo ""
echo "=== hep-calc env hints (for humans + agents) ==="
if [[ -z "${wolfram_path}" ]]; then
  echo "HINT: wolframscript not found. Install WolframScript/Mathematica and ensure 'wolframscript' is on PATH."
  echo "      (Agent note) If Mathematica is installed but PATH is wrong, an agent can locate wolframscript and export PATH."
elif [[ "${wolfram_ok}" -ne 1 ]]; then
  echo "HINT: wolframscript exists but the Wolfram kernel is not runnable (often license/activation)."
  echo "      Try: wolframscript -code '2+2'. If it errors, activate Mathematica/Wolfram Engine (open it once, or use wolframscript -activate)."
fi
if [[ "${wolfram_ok}" -eq 1 && "${mma_pkgs_ok}" -ne 1 ]]; then
  echo "HINT: Some Mathematica packages failed to load (Needs[...]). Install/repair packages under \$UserBaseDirectory/Applications (macOS: ~/Library/Wolfram/Applications)."
  echo "      Missing: FeynCalc=${mma_feyncalc_ok} FeynArts=${mma_feynarts_ok} FormCalc=${mma_formcalc_ok}"
fi
if [[ "${julia_ok}" -ne 1 ]]; then
  echo "HINT: julia not found. Install Julia and ensure 'julia' is on PATH. (macOS: 'brew install julia')"
  echo "      (Agent note) An agent can often automate installation + PATH checks."
fi
if [[ "${julia_ok}" -eq 1 && "${julia_looptools_ok}" -ne 1 ]]; then
  echo "HINT: Julia package LoopTools.jl is missing/unloadable."
  echo "      Install (preferred fork): julia --startup-file=no -e 'using Pkg; Pkg.add(url=\"https://github.com/fkguo/LoopTools.jl\"); Pkg.precompile()'"
  echo "      Or registry:              julia --startup-file=no -e 'using Pkg; Pkg.add(\"LoopTools\"); Pkg.precompile()'"
fi
if [[ "${feynrules_present}" -ne 1 ]]; then
  echo "HINT: FeynRules not found. If you need FeynRules->FeynArts export, git-clone it under ~/Library/Wolfram/Applications/FeynRules or set FEYNRULES_PATH."
  echo "      If you only use built-in FeynArts models, you can run in FeynArts-only mode (auto_qft.feynarts_model) without FeynRules."
fi

if [[ -n "${JSON_OUT}" ]]; then
  mkdir -p "$(dirname "${JSON_OUT}")"
  python3 - "${JSON_OUT}" "${ok}" "${ok_full}" "${python_ok}" "${python_path}" "${wolfram_ok}" "${wolfram_path}" "${wolfram_reason}" "${wolfram_hint}" "${julia_ok}" "${julia_path}" "${mma_pkgs_ok}" "${mma_feyncalc_ok}" "${mma_feynarts_ok}" "${mma_formcalc_ok}" "${julia_looptools_ok}" "${looptools_bin_ok}" "${lt_bin}" "${feynrules_present}" "${feynrules_ok}" "${feynrules_root}" "${python_ver}" "${wolfram_ver}" "${julia_ver}" "${mma_version}" "${system_id}" "${feyncalc_ver}" "${feynarts_ver}" "${formcalc_ver}" "${looptools_jl_ver}" "${feynrules_ver}" "${feynrules_date}" "${looptools_bin_sha256}" <<'PY'
import json
import sys
from datetime import datetime, timezone

out_path = sys.argv[1]
ok = int(sys.argv[2])
ok_full = int(sys.argv[3])
python_ok = int(sys.argv[4])
python_path = sys.argv[5]
wolfram_ok = int(sys.argv[6])
wolfram_path = sys.argv[7]
wolfram_reason = sys.argv[8]
wolfram_hint = sys.argv[9]
julia_ok = int(sys.argv[10])
julia_path = sys.argv[11]
mma_pkgs_ok = int(sys.argv[12])
mma_feyncalc_ok = int(sys.argv[13])
mma_feynarts_ok = int(sys.argv[14])
mma_formcalc_ok = int(sys.argv[15])
julia_looptools_ok = int(sys.argv[16])
looptools_bin_ok = int(sys.argv[17])
lt_bin = sys.argv[18]
feynrules_present = int(sys.argv[19])
feynrules_ok = int(sys.argv[20])
feynrules_root = sys.argv[21]
python_ver = sys.argv[22]
wolfram_ver = sys.argv[23]
julia_ver = sys.argv[24]
mma_version = sys.argv[25]
system_id = sys.argv[26]
feyncalc_ver = sys.argv[27]
feynarts_ver = sys.argv[28]
formcalc_ver = sys.argv[29]
looptools_jl_ver = sys.argv[30]
feynrules_ver = sys.argv[31]
feynrules_date = sys.argv[32]
looptools_bin_sha256 = sys.argv[33]

obj = {
    "ts": datetime.now(timezone.utc).isoformat(),
    "ok": bool(ok),
    "ok_full_toolchain": bool(ok_full),
    "tools": {
        "python3": {"ok": bool(python_ok), "path": python_path},
        "wolframscript": {"ok": bool(wolfram_ok), "path": wolfram_path, "reason": wolfram_reason, "hint": wolfram_hint},
        "julia": {"ok": bool(julia_ok), "path": julia_path},
        "mma_packages": {
            "ok": bool(mma_pkgs_ok),
            "feyncalc": bool(mma_feyncalc_ok),
            "feynarts": bool(mma_feynarts_ok),
            "formcalc": bool(mma_formcalc_ok),
        },
        "julia_looptools": {"ok": bool(julia_looptools_ok)},
        "looptools_bin": {"ok": bool(looptools_bin_ok), "path": lt_bin, "sha256": looptools_bin_sha256},
        "feynrules": {"present": bool(feynrules_present), "ok": bool(feynrules_ok), "root": feynrules_root},
    },
    "versions": {
        "python3": python_ver,
        "wolframscript": wolfram_ver,
        "julia": julia_ver,
        "mathematica": mma_version,
        "system_id": system_id,
        "feyncalc": feyncalc_ver,
        "feynarts": feynarts_ver,
        "formcalc": formcalc_ver,
        "looptools_jl": looptools_jl_ver,
        "feynrules": feynrules_ver,
        "feynrules_date": feynrules_date,
    },
}
with open(out_path, "w", encoding="utf-8") as f:
    json.dump(obj, f, indent=2, sort_keys=True)
    f.write("\n")
PY
fi

if [[ "${ok}" -ne 1 ]]; then
  exit 1
fi
exit 0
