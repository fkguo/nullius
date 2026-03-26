#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
hep-calc: reproducible/auditable HEP calc runner

Usage:
  run_hep_calc.sh --job job.yml [--out <dir>]

Required:
  --job, -j    Path to job YAML/JSON

Optional:
  --out, -o    Output directory (default: process/hep-calc/<timestamp>/)
  --help, -h   Show help
EOF
}

JOB_PATH=""
OUT_DIR=""

orig_argv=("$@")
while [[ $# -gt 0 ]]; do
  case "$1" in
    --job|-j)
      JOB_PATH="${2:-}"; shift 2 ;;
    --out|-o)
      OUT_DIR="${2:-}"; shift 2 ;;
    --help|-h)
      usage; exit 0 ;;
    *)
      echo "ERROR: unknown arg: $1" >&2
      usage
      exit 2 ;;
  esac
done

if [[ -z "${JOB_PATH}" ]]; then
  echo "ERROR: --job is required" >&2
  usage
  exit 2
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

job_abs="$(python3 -c 'import os,sys; print(os.path.abspath(sys.argv[1]))' "${JOB_PATH}")"
job_ext="${job_abs##*.}"

timestamp="$(python3 - <<'PY'
from datetime import datetime, timezone
print(datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%SZ"))
PY
)"

if [[ -z "${OUT_DIR}" ]]; then
  OUT_DIR="process/hep-calc/${timestamp}"
fi

out_abs="$(python3 -c 'import os,sys; print(os.path.abspath(sys.argv[1]))' "${OUT_DIR}")"

mkdir -p "${out_abs}"/{logs,inputs,meta,symbolic,numeric,tex,report,feynarts_formcalc,auto_qft}

main_log="${out_abs}/logs/run_hep_calc.log"
env_log="${out_abs}/logs/env_check.log"
fa_fc_log="${out_abs}/logs/fa_fc.log"
auto_qft_log="${out_abs}/logs/auto_qft.log"
tex_model_log="${out_abs}/logs/tex_model_preprocess.log"
mma_log="${out_abs}/logs/mma.log"
julia_log="${out_abs}/logs/julia.log"
tex_log="${out_abs}/logs/compare_tex.log"
report_log="${out_abs}/logs/generate_report.log"

: > "${env_log}"
: > "${fa_fc_log}"
: > "${auto_qft_log}"
: > "${tex_model_log}"
: > "${mma_log}"
: > "${julia_log}"
: > "${tex_log}"
: > "${report_log}"

{
  echo "[hep-calc] start_utc=${timestamp}"
  echo "[hep-calc] out_dir=${out_abs}"
  echo "[hep-calc] job=${job_abs}"
  echo "[hep-calc] argv=$(printf '%q ' "${orig_argv[@]}")"
} | tee -a "${main_log}" >/dev/null

printf '%q ' "$0" "${orig_argv[@]}" > "${out_abs}/meta/command_line.txt"
printf '\n' >> "${out_abs}/meta/command_line.txt"

job_copy="${out_abs}/inputs/job.original.${job_ext}"
cp -f "${job_abs}" "${job_copy}"

resolved_job="${out_abs}/job.resolved.json"
python3 - "${job_abs}" "${out_abs}" > "${resolved_job}" <<'PY'
import json
import os
import sys
from copy import deepcopy
from datetime import datetime, timezone

import yaml


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _deep_update(dst, src):
    if not isinstance(dst, dict) or not isinstance(src, dict):
        return src
    out = dict(dst)
    for k, v in src.items():
        if k in out:
            out[k] = _deep_update(out[k], v)
        else:
            out[k] = v
    return out


def _as_list(x):
    if x is None:
        return []
    if isinstance(x, list):
        return x
    return [x]


def _resolve_path(p, base_dir):
    if p is None:
        return None
    if isinstance(p, str) and p.strip():
        p = os.path.expanduser(p)
        if os.path.isabs(p):
            return os.path.abspath(p)
        return os.path.abspath(os.path.join(base_dir, p))
    return p


def _resolve_paths_in_job(job, job_dir):
    job = deepcopy(job)
    # Defensive: user may set these sections to null/non-mapping in YAML/JSON.
    # Normalize null -> {}, and fail-fast for non-mapping types with a clear error.
    for k in ("mathematica", "numeric", "latex", "auto_qft"):
        v = job.get(k)
        if v is None:
            job[k] = {}
        elif not isinstance(v, dict):
            raise SystemExit(f"{k} must be a mapping/object (or null), got {type(v).__name__}")

    job.setdefault("mathematica", {})
    job.setdefault("numeric", {})
    job.setdefault("latex", {})
    job.setdefault("auto_qft", {})

    job["mathematica"]["entry"] = _resolve_path(job["mathematica"].get("entry"), job_dir)
    resolved_tex_paths = [_resolve_path(p, job_dir) for p in _as_list(job["latex"].get("tex_paths"))]
    targets = job["latex"].get("targets")
    if isinstance(targets, list):
        extra = []
        for t in targets:
            if not isinstance(t, dict):
                continue
            if "file" in t:
                t["file"] = _resolve_path(t.get("file"), job_dir)
                if t["file"] and t["file"] not in resolved_tex_paths and t["file"] not in extra:
                    extra.append(t["file"])
        resolved_tex_paths = resolved_tex_paths + extra
    job["latex"]["tex_paths"] = resolved_tex_paths
    job["latex"]["extractor_plugin"] = _resolve_path(job["latex"].get("extractor_plugin"), job_dir)
    if isinstance(job.get("feynarts_formcalc_spec"), dict):
        spec = dict(job["feynarts_formcalc_spec"])
        spec["entry"] = _resolve_path(spec.get("entry"), job_dir)
        job["feynarts_formcalc_spec"] = spec
    job["run_card"] = _resolve_path(job.get("run_card"), job_dir)
    job["auto_qft"]["feynrules_root"] = _resolve_path(job["auto_qft"].get("feynrules_root"), job_dir)
    job["auto_qft"]["model_files"] = [_resolve_path(p, job_dir) for p in _as_list(job["auto_qft"].get("model_files"))]
    mb = job["auto_qft"].get("model_build")
    if isinstance(mb, dict):
        mb["tex_paths"] = [_resolve_path(p, job_dir) for p in _as_list(mb.get("tex_paths"))]
        mb["base_model_files"] = [_resolve_path(p, job_dir) for p in _as_list(mb.get("base_model_files"))]
        mb["rewrite_wls"] = _resolve_path(mb.get("rewrite_wls"), job_dir)
    return job


def _defaults():
    return {
        "schema_version": 1,
        "run_card": None,
        "tolerance": {"rel": 1e-4, "abs": 1e-12, "per_target": {}},
        "mathematica": {"entry": None},
        "numeric": {"enable": True, "engine": "julia"},
        "auto_qft": {
            "enable": False,
            "feynrules_root": None,
            "model_files": [],
            "lagrangian_symbol": "LSM",
            "process": {"in": [], "out": [], "in_fa": [], "out_fa": []},
            "feynarts": {"loop_order": 1, "insertion_level": "Particles", "exclude_topologies": ["Tadpoles"], "counterterms": False},
            "formcalc": {"enable": False, "pave_reduce": "LoopTools"},
            "export": {"diagrams": True, "amplitude_md": True, "amplitude_tex": False, "per_diagram": False},
            "model_build": {
                "enable": False,
                "tex_paths": [],
                "inline_tex": "",
                "preprocess": {"flatten": True, "expand_usepackage": False, "macro_overrides": {}},
                "selection": {"mode": "lagrangian_like", "include_patterns": [r"\\mathcal\{L\}", r"\\mathscr\{L\}"], "exclude_patterns": []},
                "parse_policy": "best_effort",
                "base_model_files": [],
                "rewrite_wls": None,
            },
        },
        "latex": {
            "tex_paths": [],
            "targets": [],
            "label_patterns": {
                "eq": r"([-+]?(?:\d+\.\d*|\d*\.\d+|\d+)(?:[eE][-+]?\d+)?)",
                "tab": r"([-+]?(?:\d+\.\d*|\d*\.\d+|\d+)(?:[eE][-+]?\d+)?)",
            },
            "extractor_plugin": None,
        },
        "enable_fa_fc": False,
        "feynarts_formcalc_spec": None,
        "integrations": [],
        "tag": None,
    }


def main():
    job_path = os.path.abspath(sys.argv[1])
    out_dir = os.path.abspath(sys.argv[2])
    job_dir = os.path.dirname(job_path)

    with open(job_path, "r", encoding="utf-8") as f:
        if job_path.lower().endswith(".json"):
            raw = json.load(f)
        else:
            raw = yaml.safe_load(f) or {}

    if not isinstance(raw, dict):
        raise SystemExit("job must be a mapping/object at top-level")

    merged = _deep_update(_defaults(), raw)
    merged = _resolve_paths_in_job(merged, job_dir)

    # Implicit auto-enable for auto_qft:
    # - If user did NOT explicitly set auto_qft.enable, and
    # - job provides BOTH a process specification AND a model specification,
    # then enable auto_qft automatically.
    raw_auto = raw.get("auto_qft") if isinstance(raw.get("auto_qft"), dict) else {}
    explicit_enable_set = isinstance(raw_auto, dict) and ("enable" in raw_auto)

    auto_enable_mode = "explicit" if explicit_enable_set else "default"
    implicit_reason = {}
    if not explicit_enable_set:
        auto = merged.get("auto_qft") or {}
        proc = auto.get("process") or {}

        def _as_nonempty_list(v):
            return v if isinstance(v, list) and len(v) > 0 else []

        proc_in_fa = _as_nonempty_list(proc.get("in_fa"))
        proc_out_fa = _as_nonempty_list(proc.get("out_fa"))
        proc_in = _as_nonempty_list(proc.get("in"))
        proc_out = _as_nonempty_list(proc.get("out"))

        has_process = (len(proc_in_fa) > 0 and len(proc_out_fa) > 0) or (len(proc_in) > 0 and len(proc_out) > 0)
        mb = auto.get("model_build") or {}
        has_model_build = False
        if isinstance(mb, dict):
            if mb.get("enable") is True:
                has_model_build = True
            elif ("tex_paths" in mb and bool(mb.get("tex_paths") or [])) or ("inline_tex" in mb and bool((mb.get("inline_tex") or "").strip())):
                has_model_build = True

        has_model = bool((auto.get("feynarts_model") or "").strip()) or (
            isinstance(auto.get("model_files"), list) and len(auto.get("model_files") or []) > 0
        ) or has_model_build

        if has_process and has_model:
            merged.setdefault("auto_qft", {})["enable"] = True
            auto_enable_mode = "implicit"
            implicit_reason = {"has_process": has_process, "has_model": has_model}

    merged["_meta"] = {
        "resolved_at": _utc_now(),
        "job_path": job_path,
        "job_dir": job_dir,
        "cwd": os.getcwd(),
        "out_dir": out_dir,
        "auto_qft_enable_mode": auto_enable_mode,
        "auto_qft_enable_implicit_reason": implicit_reason,
    }

    json.dump(merged, sys.stdout, indent=2, sort_keys=True)
    sys.stdout.write("\n")


if __name__ == "__main__":
    main()
PY

# Optional: copy a user-provided run-card into out_dir/inputs for portability.
run_card_copied=""
if run_card_copied="$(python3 - "${resolved_job}" "${out_abs}" <<'PY'
import json
import os
import shutil
import sys

job_path = sys.argv[1]
out_dir = sys.argv[2]

try:
    job = json.load(open(job_path, "r", encoding="utf-8"))
except Exception:
    raise SystemExit(0)

run_card = (job.get("run_card") or "").strip()
if not run_card:
    raise SystemExit(0)
if not os.path.isfile(run_card):
    # Best-effort only (do not fail the run).
    print("", end="")
    raise SystemExit(0)

ext = os.path.splitext(run_card)[1]
dst = os.path.join(out_dir, "inputs", "run_card" + ext)
os.makedirs(os.path.dirname(dst), exist_ok=True)
shutil.copy2(run_card, dst)
print(dst)
PY
)"; then
  if [[ -n "${run_card_copied}" ]]; then
    echo "[hep-calc] copied run_card to inputs: ${run_card_copied}" | tee -a "${main_log}" >/dev/null
  fi
fi

env_json="${out_abs}/meta/env.json"
env_rc=0
if bash "${SCRIPT_DIR}/check_env.sh" --json "${env_json}" >"${env_log}" 2>&1; then
  echo "[hep-calc] env_check OK; env_json=${env_json}" | tee -a "${main_log}" >/dev/null
else
  env_rc=$?
  echo "[hep-calc] env_check FAILED (rc=${env_rc}); see ${env_log}" | tee -a "${main_log}" >/dev/null
fi

tex_model_rc=0
if python3 "${SCRIPT_DIR}/tex/prepare_model_build_tex.py" --job "${resolved_job}" --out "${out_abs}" >"${tex_model_log}" 2>&1; then
  echo "[hep-calc] tex model preprocess stage OK; log=${tex_model_log}" | tee -a "${main_log}" >/dev/null
else
  tex_model_rc=$?
  echo "[hep-calc] tex model preprocess stage ERROR (rc=${tex_model_rc}); see ${tex_model_log}" | tee -a "${main_log}" >/dev/null
fi

# Ensure model_build status/summary exist for audit contract (will be overwritten if auto_qft runs).
python3 - "${out_abs}" <<'PY'
import json
import os
import sys
from datetime import datetime, timezone

out_dir = sys.argv[1]
ts = datetime.now(timezone.utc).isoformat()
mb_dir = os.path.join(out_dir, "auto_qft", "model_build")
os.makedirs(mb_dir, exist_ok=True)

status_path = os.path.join(mb_dir, "status.json")
summary_path = os.path.join(mb_dir, "summary.json")

if not os.path.isfile(status_path):
    with open(status_path, "w", encoding="utf-8") as f:
        json.dump(
            {"stage": "auto_qft_model_build", "status": "NOT_RUN", "reason": "auto_qft_not_executed", "ts": ts},
            f,
            indent=2,
            sort_keys=True,
        )
        f.write("\n")
if not os.path.isfile(summary_path):
    with open(summary_path, "w", encoding="utf-8") as f:
        json.dump({"ts": ts, "status": "NOT_RUN", "reason": "auto_qft_not_executed"}, f, indent=2, sort_keys=True)
        f.write("\n")
PY

read -r wolframscript_ok mma_pkgs_ok julia_ok julia_looptools_ok mma_feynarts_ok mma_formcalc_ok feynrules_ok <<<"$(python3 - "${env_json}" <<'PY'
import json, sys

path = sys.argv[1]
try:
    env = json.load(open(path, "r", encoding="utf-8"))
except Exception:
    print("0 0 0 0 0 0 0")
    raise SystemExit(0)

tools = env.get("tools") or {}
def ok(name: str) -> int:
    v = tools.get(name) or {}
    return 1 if isinstance(v, dict) and v.get("ok") else 0

jl = tools.get("julia_looptools") or {}
julia_looptools_ok = 1 if isinstance(jl, dict) and jl.get("ok") else 0
mma = tools.get("mma_packages") or {}
mma_feynarts_ok = 1 if isinstance(mma, dict) and mma.get("feynarts") else 0
mma_formcalc_ok = 1 if isinstance(mma, dict) and mma.get("formcalc") else 0
fr = tools.get("feynrules") or {}
feynrules_ok = 1 if isinstance(fr, dict) and fr.get("ok") else 0

print(f"{ok('wolframscript')} {ok('mma_packages')} {ok('julia')} {julia_looptools_ok} {mma_feynarts_ok} {mma_formcalc_ok} {feynrules_ok}")
PY
)"

mma_entry="$(python3 - "${resolved_job}" <<'PY'
import json, sys
job=json.load(open(sys.argv[1], 'r', encoding='utf-8'))
entry=(job.get('mathematica') or {}).get('entry')
print(entry or '')
PY
)"

fa_fc_rc=0
fa_fc_enabled="$(python3 - "${resolved_job}" <<'PY'
import json, sys
job=json.load(open(sys.argv[1], 'r', encoding='utf-8'))
enabled = bool(job.get('enable_fa_fc', False)) or (job.get('feynarts_formcalc_spec') is not None)
print('1' if enabled else '0')
PY
)"

fa_fc_spec_entry="$(python3 - "${resolved_job}" <<'PY'
import json, sys
job=json.load(open(sys.argv[1], 'r', encoding='utf-8'))
spec=job.get('feynarts_formcalc_spec')
entry=''
if isinstance(spec, dict):
    entry = (spec.get('entry') or '').strip()
print(entry)
PY
)"

if [[ "${fa_fc_enabled}" != "1" ]]; then
  python3 - "${out_abs}" <<'PY'
import json, os, sys
from datetime import datetime, timezone

out_dir=sys.argv[1]
ts=datetime.now(timezone.utc).isoformat()
st=os.path.join(out_dir,"feynarts_formcalc","status.json")
os.makedirs(os.path.dirname(st), exist_ok=True)
with open(st,"w",encoding="utf-8") as f:
    json.dump({"stage":"feynarts_formcalc","status":"SKIPPED","reason":"not_enabled","hint":"Set enable_fa_fc: true or provide feynarts_formcalc_spec.entry to run this stage.","ts":ts}, f, indent=2, sort_keys=True)
    f.write("\n")
PY
  echo "[hep-calc] feynarts_formcalc stage SKIPPED (not enabled)" | tee -a "${main_log}" >/dev/null
  echo "[hep-calc] SKIPPED: not_enabled" >> "${fa_fc_log}"
elif [[ -z "${fa_fc_spec_entry}" ]]; then
  python3 - "${out_abs}" <<'PY'
import json, os, sys
from datetime import datetime, timezone

out_dir=sys.argv[1]
ts=datetime.now(timezone.utc).isoformat()
st=os.path.join(out_dir,"feynarts_formcalc","status.json")
os.makedirs(os.path.dirname(st), exist_ok=True)
with open(st,"w",encoding="utf-8") as f:
    json.dump({"stage":"feynarts_formcalc","status":"SKIPPED","reason":"enabled_but_missing_spec_entry","hint":"Provide feynarts_formcalc_spec.entry (a .wls/.m file) to execute the FA/FC pipeline.","ts":ts}, f, indent=2, sort_keys=True)
    f.write("\n")
PY
  echo "[hep-calc] feynarts_formcalc stage SKIPPED (missing spec.entry)" | tee -a "${main_log}" >/dev/null
  echo "[hep-calc] SKIPPED: enabled_but_missing_spec_entry" >> "${fa_fc_log}"
elif [[ "${wolframscript_ok}" != "1" ]]; then
  python3 - "${out_abs}" "${env_json}" <<'PY'
import json, os, sys
from datetime import datetime, timezone

out_dir=sys.argv[1]
env_path=sys.argv[2]
ts=datetime.now(timezone.utc).isoformat()
st=os.path.join(out_dir,"feynarts_formcalc","status.json")
os.makedirs(os.path.dirname(st), exist_ok=True)
reason="missing_wolframscript"
hint="Install WolframScript/Mathematica and ensure `wolframscript` is on PATH. An LLM agent can often fix PATH and rerun."
try:
    env=json.load(open(env_path, "r", encoding="utf-8"))
    ws=(env.get("tools") or {}).get("wolframscript") or {}
    if isinstance(ws, dict):
        if ws.get("path"):
            reason=str(ws.get("reason") or "wolframscript_unavailable")
            hint=str(ws.get("hint") or hint)
except Exception:
    pass
with open(st,"w",encoding="utf-8") as f:
    json.dump({
      "stage":"feynarts_formcalc",
      "status":"ERROR",
      "reason":reason,
      "hint":hint,
      "ts":ts
    }, f, indent=2, sort_keys=True)
    f.write("\n")
PY
  fa_fc_rc=1
  echo "[hep-calc] feynarts_formcalc stage ERROR (missing wolframscript)" | tee -a "${main_log}" >/dev/null
  echo "[hep-calc] ERROR: missing_wolframscript" >> "${fa_fc_log}"
elif [[ "${mma_pkgs_ok}" != "1" ]]; then
  python3 - "${out_abs}" <<'PY'
import json, os, sys
from datetime import datetime, timezone

out_dir=sys.argv[1]
ts=datetime.now(timezone.utc).isoformat()
st=os.path.join(out_dir,"feynarts_formcalc","status.json")
os.makedirs(os.path.dirname(st), exist_ok=True)
with open(st,"w",encoding="utf-8") as f:
    json.dump({
      "stage":"feynarts_formcalc",
      "status":"ERROR",
      "reason":"missing_mma_packages",
      "hint":"Install required Mathematica packages (FeynArts/FormCalc/FeynCalc as needed) so Needs[...] works in wolframscript. An LLM agent can help validate package paths.",
      "ts":ts
    }, f, indent=2, sort_keys=True)
    f.write("\n")
PY
  fa_fc_rc=1
  echo "[hep-calc] feynarts_formcalc stage ERROR (missing Mathematica packages)" | tee -a "${main_log}" >/dev/null
  echo "[hep-calc] ERROR: missing_mma_packages" >> "${fa_fc_log}"
else
  if wolframscript -noprompt -file "${SCRIPT_DIR}/mma/run_fa_fc.wls" -- "${resolved_job}" "${out_abs}" >"${fa_fc_log}" 2>&1; then
    echo "[hep-calc] feynarts_formcalc stage OK; log=${fa_fc_log}" | tee -a "${main_log}" >/dev/null
  else
    fa_fc_rc=$?
    echo "[hep-calc] feynarts_formcalc stage ERROR (rc=${fa_fc_rc}); see ${fa_fc_log}" | tee -a "${main_log}" >/dev/null
  fi
fi

auto_qft_rc=0
auto_qft_enabled="$(python3 - "${resolved_job}" <<'PY'
import json, sys
job=json.load(open(sys.argv[1], 'r', encoding='utf-8'))
auto=job.get('auto_qft') or {}
print('1' if auto.get('enable', False) else '0')
PY
)"

auto_qft_formcalc_enable="$(python3 - "${resolved_job}" <<'PY'
import json, sys
job=json.load(open(sys.argv[1], 'r', encoding='utf-8'))
auto=job.get('auto_qft') or {}
fc=auto.get('formcalc') or {}
print('1' if isinstance(fc, dict) and fc.get('enable', False) else '0')
PY
)"

auto_qft_feynarts_only="$(python3 - "${resolved_job}" <<'PY'
import json, sys
job=json.load(open(sys.argv[1], 'r', encoding='utf-8'))
auto=job.get('auto_qft') or {}
v=(auto.get('feynarts_model') or '')
print('1' if isinstance(v, str) and v.strip() else '0')
PY
)"

if [[ "${auto_qft_enabled}" != "1" ]]; then
  python3 - "${out_abs}" <<'PY'
import json, os, sys
from datetime import datetime, timezone

out_dir=sys.argv[1]
ts=datetime.now(timezone.utc).isoformat()
auto_dir=os.path.join(out_dir,"auto_qft")
os.makedirs(auto_dir, exist_ok=True)
with open(os.path.join(auto_dir,"status.json"),"w",encoding="utf-8") as f:
    json.dump({
      "stage":"auto_qft_one_loop",
      "status":"SKIPPED",
      "reason":"not_enabled",
      "hint":"Enable auto_qft explicitly via auto_qft.enable: true (or omit enable and provide auto_qft.process + a model (auto_qft.feynarts_model or auto_qft.model_files) to trigger implicit enable).",
      "ts":ts
    }, f, indent=2, sort_keys=True)
    f.write("\n")
with open(os.path.join(auto_dir,"summary.json"),"w",encoding="utf-8") as f:
    json.dump({"ts":ts,"status":"SKIPPED","reason":"not_enabled"}, f, indent=2, sort_keys=True)
    f.write("\n")
PY
  echo "[hep-calc] auto_qft stage SKIPPED (not enabled)" | tee -a "${main_log}" >/dev/null
  echo "[hep-calc] SKIPPED: not_enabled" >> "${auto_qft_log}"
elif [[ "${wolframscript_ok}" != "1" ]]; then
  python3 - "${out_abs}" "${env_json}" <<'PY'
import json, os, sys
from datetime import datetime, timezone

out_dir=sys.argv[1]
env_path=sys.argv[2]
ts=datetime.now(timezone.utc).isoformat()
auto_dir=os.path.join(out_dir,"auto_qft")
os.makedirs(auto_dir, exist_ok=True)
reason="missing_wolframscript"
hint="Install WolframScript/Mathematica and ensure `wolframscript` is on PATH. An LLM agent can often fix PATH and rerun env_check."
try:
    env=json.load(open(env_path, "r", encoding="utf-8"))
    ws=(env.get("tools") or {}).get("wolframscript") or {}
    if isinstance(ws, dict):
        if ws.get("path"):
            reason=str(ws.get("reason") or "wolframscript_unavailable")
            hint=str(ws.get("hint") or hint)
except Exception:
    pass
with open(os.path.join(auto_dir,"status.json"),"w",encoding="utf-8") as f:
    json.dump({
      "stage":"auto_qft_one_loop",
      "status":"ERROR",
      "reason":reason,
      "hint":hint,
      "ts":ts
    }, f, indent=2, sort_keys=True)
    f.write("\n")
with open(os.path.join(auto_dir,"summary.json"),"w",encoding="utf-8") as f:
    json.dump({"ts":ts,"status":"ERROR","reason":reason}, f, indent=2, sort_keys=True)
    f.write("\n")
PY
  auto_qft_rc=1
  echo "[hep-calc] auto_qft stage ERROR (missing wolframscript)" | tee -a "${main_log}" >/dev/null
  echo "[hep-calc] ERROR: missing_wolframscript" >> "${auto_qft_log}"
elif [[ "${auto_qft_feynarts_only}" != "1" && "${feynrules_ok}" != "1" ]]; then
  python3 - "${out_abs}" <<'PY'
import json, os, sys
from datetime import datetime, timezone

out_dir=sys.argv[1]
ts=datetime.now(timezone.utc).isoformat()
auto_dir=os.path.join(out_dir,"auto_qft")
os.makedirs(auto_dir, exist_ok=True)
with open(os.path.join(auto_dir,"status.json"),"w",encoding="utf-8") as f:
    json.dump({
      "stage":"auto_qft_one_loop",
      "status":"ERROR",
      "reason":"missing_feynrules",
      "hint":"Install FeynRules under $HOME/Library/Wolfram/Applications/FeynRules (or set FEYNRULES_PATH). If you only want built-in FeynArts models, use FeynArts-only mode via auto_qft.feynarts_model.",
      "ts":ts
    }, f, indent=2, sort_keys=True)
    f.write("\n")
with open(os.path.join(auto_dir,"summary.json"),"w",encoding="utf-8") as f:
    json.dump({"ts":ts,"status":"ERROR","reason":"missing_feynrules"}, f, indent=2, sort_keys=True)
    f.write("\n")
PY
  auto_qft_rc=1
  echo "[hep-calc] auto_qft stage ERROR (missing feynrules)" | tee -a "${main_log}" >/dev/null
  echo "[hep-calc] ERROR: missing_feynrules" >> "${auto_qft_log}"
elif [[ "${mma_feynarts_ok}" != "1" ]]; then
  python3 - "${out_abs}" <<'PY'
import json, os, sys
from datetime import datetime, timezone

out_dir=sys.argv[1]
ts=datetime.now(timezone.utc).isoformat()
auto_dir=os.path.join(out_dir,"auto_qft")
os.makedirs(auto_dir, exist_ok=True)
with open(os.path.join(auto_dir,"status.json"),"w",encoding="utf-8") as f:
    json.dump({
      "stage":"auto_qft_one_loop",
      "status":"ERROR",
      "reason":"missing_feynarts",
      "hint":"Install FeynArts (Mathematica package) so Needs[\"FeynArts`\"] works in wolframscript. An LLM agent can help place packages under $UserBaseDirectory/Applications.",
      "ts":ts
    }, f, indent=2, sort_keys=True)
    f.write("\n")
with open(os.path.join(auto_dir,"summary.json"),"w",encoding="utf-8") as f:
    json.dump({"ts":ts,"status":"ERROR","reason":"missing_feynarts"}, f, indent=2, sort_keys=True)
    f.write("\n")
PY
  auto_qft_rc=1
  echo "[hep-calc] auto_qft stage ERROR (missing feynarts)" | tee -a "${main_log}" >/dev/null
  echo "[hep-calc] ERROR: missing_feynarts" >> "${auto_qft_log}"
elif [[ "${auto_qft_formcalc_enable}" == "1" && "${mma_formcalc_ok}" != "1" ]]; then
  python3 - "${out_abs}" <<'PY'
import json, os, sys
from datetime import datetime, timezone

out_dir=sys.argv[1]
ts=datetime.now(timezone.utc).isoformat()
auto_dir=os.path.join(out_dir,"auto_qft")
os.makedirs(auto_dir, exist_ok=True)
with open(os.path.join(auto_dir,"status.json"),"w",encoding="utf-8") as f:
    json.dump({
      "stage":"auto_qft_one_loop",
      "status":"ERROR",
      "reason":"missing_formcalc",
      "hint":"Install FormCalc (Mathematica package), or disable this requirement via auto_qft.formcalc.enable: false.",
      "ts":ts
    }, f, indent=2, sort_keys=True)
    f.write("\n")
with open(os.path.join(auto_dir,"summary.json"),"w",encoding="utf-8") as f:
    json.dump({"ts":ts,"status":"ERROR","reason":"missing_formcalc"}, f, indent=2, sort_keys=True)
    f.write("\n")
PY
  auto_qft_rc=1
  echo "[hep-calc] auto_qft stage ERROR (missing formcalc)" | tee -a "${main_log}" >/dev/null
  echo "[hep-calc] ERROR: missing_formcalc" >> "${auto_qft_log}"
else
  if wolframscript -noprompt -file "${SCRIPT_DIR}/mma/run_auto_qft.wls" -- "${resolved_job}" "${out_abs}" >"${auto_qft_log}" 2>&1; then
    echo "[hep-calc] auto_qft stage OK; log=${auto_qft_log}" | tee -a "${main_log}" >/dev/null
  else
    auto_qft_rc=$?
    echo "[hep-calc] auto_qft stage ERROR (rc=${auto_qft_rc}); see ${auto_qft_log}" | tee -a "${main_log}" >/dev/null
  fi
fi

mma_rc=0
if [[ -z "${mma_entry}" ]]; then
  mkdir -p "${out_abs}/symbolic"
  python3 - "${out_abs}" <<'PY'
import json, os, sys
from datetime import datetime, timezone

out_dir=sys.argv[1]
ts=datetime.now(timezone.utc).isoformat()
sym_json=os.path.join(out_dir,"symbolic","symbolic.json")
st_json=os.path.join(out_dir,"symbolic","status.json")
os.makedirs(os.path.dirname(sym_json), exist_ok=True)
with open(sym_json,"w",encoding="utf-8") as f:
    json.dump({"schema_version":1,"generated_at":ts,"data":{"tasks":[],"notes":["No job.mathematica.entry provided; symbolic stage skipped."]}}, f, indent=2, sort_keys=True)
    f.write("\n")
with open(st_json,"w",encoding="utf-8") as f:
    json.dump({"stage":"mathematica_symbolic","status":"SKIPPED","reason":"missing_mathematica_entry","ts":ts}, f, indent=2, sort_keys=True)
    f.write("\n")
PY
  echo "[hep-calc] mathematica stage SKIPPED (missing_mathematica_entry)" | tee -a "${main_log}" >/dev/null
elif [[ "${wolframscript_ok}" != "1" ]]; then
  mkdir -p "${out_abs}/symbolic"
  python3 - "${out_abs}" "${env_json}" <<'PY'
import json, os, sys
from datetime import datetime, timezone

out_dir=sys.argv[1]
env_path=sys.argv[2]
ts=datetime.now(timezone.utc).isoformat()
sym_json=os.path.join(out_dir,"symbolic","symbolic.json")
st_json=os.path.join(out_dir,"symbolic","status.json")
os.makedirs(os.path.dirname(sym_json), exist_ok=True)
reason="missing_wolframscript"
hint="Install WolframScript/Mathematica and ensure `wolframscript` is on PATH. An LLM agent can often automate PATH checks and rerun."
try:
    env=json.load(open(env_path, "r", encoding="utf-8"))
    ws=(env.get("tools") or {}).get("wolframscript") or {}
    if isinstance(ws, dict):
        if ws.get("path"):
            reason=str(ws.get("reason") or "wolframscript_unavailable")
            hint=str(ws.get("hint") or hint)
except Exception:
    pass
with open(sym_json,"w",encoding="utf-8") as f:
    json.dump({"schema_version":1,"generated_at":ts,"data":{"tasks":[],"notes":[f\"symbolic stage not executed ({reason})\"]}}, f, indent=2, sort_keys=True)
    f.write("\n")
with open(st_json,"w",encoding="utf-8") as f:
    json.dump({
      "stage":"mathematica_symbolic",
      "status":"ERROR",
      "reason":reason,
      "hint":hint,
      "ts":ts
    }, f, indent=2, sort_keys=True)
    f.write("\n")
PY
  mma_rc=1
  echo "[hep-calc] mathematica stage ERROR (missing wolframscript)" | tee -a "${main_log}" >/dev/null
elif [[ "${mma_pkgs_ok}" != "1" ]]; then
  mkdir -p "${out_abs}/symbolic"
  python3 - "${out_abs}" <<'PY'
import json, os, sys
from datetime import datetime, timezone

out_dir=sys.argv[1]
ts=datetime.now(timezone.utc).isoformat()
sym_json=os.path.join(out_dir,"symbolic","symbolic.json")
st_json=os.path.join(out_dir,"symbolic","status.json")
os.makedirs(os.path.dirname(sym_json), exist_ok=True)
with open(sym_json,"w",encoding="utf-8") as f:
    json.dump({"schema_version":1,"generated_at":ts,"data":{"tasks":[],"notes":["symbolic stage not executed (missing Mathematica packages)"]}}, f, indent=2, sort_keys=True)
    f.write("\n")
with open(st_json,"w",encoding="utf-8") as f:
    json.dump({
      "stage":"mathematica_symbolic",
      "status":"ERROR",
      "reason":"missing_mma_packages",
      "hint":"Install required Mathematica packages (FeynCalc/FeynArts/FormCalc/LoopTools) so Needs[...] works in wolframscript. An LLM agent can help validate $UserBaseDirectory/Applications paths.",
      "ts":ts
    }, f, indent=2, sort_keys=True)
    f.write("\n")
PY
  mma_rc=1
  echo "[hep-calc] mathematica stage ERROR (missing Mathematica packages)" | tee -a "${main_log}" >/dev/null
else
  if wolframscript -noprompt -file "${SCRIPT_DIR}/mma/run_job.wls" -- "${resolved_job}" "${out_abs}" >"${mma_log}" 2>&1; then
    echo "[hep-calc] mathematica stage OK; log=${mma_log}" | tee -a "${main_log}" >/dev/null
  else
    mma_rc=$?
    echo "[hep-calc] mathematica stage ERROR (rc=${mma_rc}); see ${mma_log}" | tee -a "${main_log}" >/dev/null
  fi
fi

julia_rc=0
numeric_enable="$(python3 - "${resolved_job}" <<'PY'
import json, sys
with open(sys.argv[1], 'r', encoding='utf-8') as f:
    job=json.load(f)
print('1' if job.get('numeric',{}).get('enable', True) else '0')
PY
)"

tasks_total="$(python3 - "${out_abs}/symbolic/symbolic.json" <<'PY' || true
import json, sys
try:
    sym=json.load(open(sys.argv[1], "r", encoding="utf-8"))
    data = sym.get("data") or {}
    tasks = data.get("tasks") or []
    print(len(tasks) if isinstance(tasks, list) else 0)
except Exception:
    print(-1)
PY
)"

if [[ "${numeric_enable}" != "1" ]]; then
  mkdir -p "${out_abs}/numeric"
  python3 - "${out_abs}" <<'PY'
import json, sys
from datetime import datetime, timezone

out_dir=sys.argv[1]
ts=datetime.now(timezone.utc).isoformat()
status_path=f"{out_dir}/numeric/status.json"
numeric_path=f"{out_dir}/numeric/numeric.json"

with open(numeric_path,"w",encoding="utf-8") as f:
    json.dump({"schema_version":1,"generated_at":ts,"results":[],"errors":[]}, f, indent=2, sort_keys=True)
    f.write("\n")

obj={"stage":"julia_numeric","status":"SKIPPED","reason":"disabled_by_job","ts":ts}
with open(status_path,"w",encoding="utf-8") as f:
    json.dump(obj,f,indent=2,sort_keys=True)
    f.write("\n")
PY
  echo "[hep-calc] julia stage SKIPPED (disabled_by_job)" | tee -a "${main_log}" >/dev/null
elif [[ "${tasks_total}" == "0" ]]; then
  mkdir -p "${out_abs}/numeric"
  python3 - "${out_abs}" <<'PY'
import json, sys
from datetime import datetime, timezone

out_dir=sys.argv[1]
ts=datetime.now(timezone.utc).isoformat()
status_path=f"{out_dir}/numeric/status.json"
numeric_path=f"{out_dir}/numeric/numeric.json"

with open(numeric_path,"w",encoding="utf-8") as f:
    json.dump({"schema_version":1,"generated_at":ts,"results":[],"errors":[]}, f, indent=2, sort_keys=True)
    f.write("\n")

obj={"stage":"julia_numeric","status":"SKIPPED","reason":"no_tasks","ts":ts}
with open(status_path,"w",encoding="utf-8") as f:
    json.dump(obj,f,indent=2,sort_keys=True)
    f.write("\n")
PY
  echo "[hep-calc] julia stage SKIPPED (no_tasks)" | tee -a "${main_log}" >/dev/null
elif [[ "${tasks_total}" == "-1" ]]; then
  mkdir -p "${out_abs}/numeric"
  python3 - "${out_abs}" <<'PY'
import json, sys
from datetime import datetime, timezone

out_dir=sys.argv[1]
ts=datetime.now(timezone.utc).isoformat()
status_path=f"{out_dir}/numeric/status.json"
numeric_path=f"{out_dir}/numeric/numeric.json"

with open(numeric_path,"w",encoding="utf-8") as f:
    json.dump({"schema_version":1,"generated_at":ts,"results":[],"errors":[]}, f, indent=2, sort_keys=True)
    f.write("\n")

obj={"stage":"julia_numeric","status":"SKIPPED","reason":"missing_symbolic_json","ts":ts}
with open(status_path,"w",encoding="utf-8") as f:
    json.dump(obj,f,indent=2,sort_keys=True)
    f.write("\n")
PY
  echo "[hep-calc] julia stage SKIPPED (missing_symbolic_json)" | tee -a "${main_log}" >/dev/null
elif [[ "${julia_ok}" != "1" ]]; then
  mkdir -p "${out_abs}/numeric"
  python3 - "${out_abs}" <<'PY'
import json, sys
from datetime import datetime, timezone

out_dir=sys.argv[1]
ts=datetime.now(timezone.utc).isoformat()
status_path=f"{out_dir}/numeric/status.json"
numeric_path=f"{out_dir}/numeric/numeric.json"

with open(numeric_path,"w",encoding="utf-8") as f:
    json.dump({"schema_version":1,"generated_at":ts,"results":[],"errors":[{"stage":"env","error":"missing_julia"}]}, f, indent=2, sort_keys=True)
    f.write("\n")

obj={
  "stage":"julia_numeric",
  "status":"ERROR",
  "reason":"missing_julia",
  "hint":"Install Julia and ensure `julia` is on PATH (or set numeric.enable: false). An LLM agent can often automate installation.",
  "ts":ts
}
with open(status_path,"w",encoding="utf-8") as f:
    json.dump(obj,f,indent=2,sort_keys=True)
    f.write("\n")
PY
  julia_rc=1
  echo "[hep-calc] julia stage ERROR (missing julia)" | tee -a "${main_log}" >/dev/null
elif [[ "${julia_looptools_ok}" != "1" ]]; then
  mkdir -p "${out_abs}/numeric"
  python3 - "${out_abs}" <<'PY'
import json, sys
from datetime import datetime, timezone

out_dir=sys.argv[1]
ts=datetime.now(timezone.utc).isoformat()
status_path=f"{out_dir}/numeric/status.json"
numeric_path=f"{out_dir}/numeric/numeric.json"

with open(numeric_path,"w",encoding="utf-8") as f:
    json.dump({"schema_version":1,"generated_at":ts,"results":[],"errors":[{"stage":"env","error":"missing_looptools_jl"}]}, f, indent=2, sort_keys=True)
    f.write("\n")

obj={
  "stage":"julia_numeric",
  "status":"ERROR",
  "reason":"missing_looptools_jl",
  "hint":"Install LoopTools.jl (e.g. `julia -e 'using Pkg; Pkg.add(\"LoopTools\")'`) or set numeric.enable: false. An LLM agent can automate this.",
  "ts":ts
}
with open(status_path,"w",encoding="utf-8") as f:
    json.dump(obj,f,indent=2,sort_keys=True)
    f.write("\n")
PY
  julia_rc=1
  echo "[hep-calc] julia stage ERROR (missing LoopTools.jl)" | tee -a "${main_log}" >/dev/null
else
  if julia --startup-file=no "${SCRIPT_DIR}/julia/eval_numeric.jl" "${resolved_job}" "${out_abs}" >"${julia_log}" 2>&1; then
    echo "[hep-calc] julia stage OK; log=${julia_log}" | tee -a "${main_log}" >/dev/null
  else
    julia_rc=$?
    echo "[hep-calc] julia stage ERROR (rc=${julia_rc}); see ${julia_log}" | tee -a "${main_log}" >/dev/null
  fi
fi

tex_rc=0
if python3 "${SCRIPT_DIR}/compare_tex.py" --job "${resolved_job}" --out "${out_abs}" >"${tex_log}" 2>&1; then
  echo "[hep-calc] tex compare stage OK; log=${tex_log}" | tee -a "${main_log}" >/dev/null
else
  tex_rc=$?
  echo "[hep-calc] tex compare stage ERROR (rc=${tex_rc}); see ${tex_log}" | tee -a "${main_log}" >/dev/null
fi

report_rc=0
if python3 "${SCRIPT_DIR}/generate_report.py" --job "${resolved_job}" --out "${out_abs}" >"${report_log}" 2>&1; then
  echo "[hep-calc] report stage OK; log=${report_log}" | tee -a "${main_log}" >/dev/null
else
  report_rc=$?
  echo "[hep-calc] report stage ERROR (rc=${report_rc}); see ${report_log}" | tee -a "${main_log}" >/dev/null
fi

sync_rc=0
python3 - "${resolved_job}" "${out_abs}" <<'PY' || sync_rc=$?
import json
import os
import shutil
import sys

job_path=sys.argv[1]
out_dir=sys.argv[2]
with open(job_path,"r",encoding="utf-8") as f:
    job=json.load(f)

integrations=set(job.get("integrations") or [])
tag=(job.get("tag") or "").strip()
meta=(job.get("_meta") or {})
job_dir=(meta.get("job_dir") or "").strip()
cwd=(meta.get("cwd") or "").strip()

def _find_research_team_root(start: str) -> str:
    p = os.path.abspath(os.path.expanduser(start))
    while True:
        if os.path.isdir(os.path.join(p, "artifacts", "runs")) or os.path.isdir(os.path.join(p, "artifacts")):
            return p
        parent = os.path.dirname(p)
        if parent == p:
            return ""
        p = parent

research_team_root = (job.get("research_team_root") or os.environ.get("RESEARCH_TEAM_ROOT") or "").strip()
if research_team_root:
    base = os.path.abspath(os.path.expanduser(research_team_root))
    if not os.path.isdir(base):
        print(f"ERROR: research_team_root not found: {base}", file=sys.stderr)
        raise SystemExit(2)
else:
    candidates = [cwd, job_dir, os.getcwd()]
    base = ""
    for c in candidates:
        c = (c or "").strip()
        if not c:
            continue
        root = _find_research_team_root(c)
        if root:
            base = root
            break
    if not base:
        base = os.path.abspath(os.path.expanduser(cwd or os.getcwd()))

if "research-team" not in integrations:
    raise SystemExit(0)
if not tag:
    print("ERROR: integrations includes research-team but job.tag is missing/empty", file=sys.stderr)
    raise SystemExit(2)

dest=os.path.join(base, "artifacts", "runs", tag, "hep-calc")
os.makedirs(dest, exist_ok=True)

to_copy = [
    (os.path.join(out_dir, "manifest.json"), "manifest.json"),
    (os.path.join(out_dir, "summary.json"), "summary.json"),
    (os.path.join(out_dir, "analysis.json"), "analysis.json"),
    (os.path.join(out_dir, "report", "audit_report.md"), "audit_report.md"),
    (os.path.join(out_dir, "feynarts_formcalc", "status.json"), "feynarts_formcalc.status.json"),
    (os.path.join(out_dir, "auto_qft", "status.json"), "auto_qft.status.json"),
    (os.path.join(out_dir, "auto_qft", "summary.json"), "auto_qft.summary.json"),
    (os.path.join(out_dir, "auto_qft", "model_build", "status.json"), "auto_qft.model_build.status.json"),
    (os.path.join(out_dir, "auto_qft", "model_build", "summary.json"), "auto_qft.model_build.summary.json"),
    (os.path.join(out_dir, "auto_qft", "model_build", "generated_lagrangian.fr"), "auto_qft.model_build.generated_lagrangian.fr"),
    (os.path.join(out_dir, "auto_qft", "model_build", "parsed_blocks.m"), "auto_qft.model_build.parsed_blocks.m"),
    (os.path.join(out_dir, "auto_qft", "model_build", "tex_preprocess", "status.json"), "auto_qft.model_build.tex_preprocess.status.json"),
    (os.path.join(out_dir, "auto_qft", "model_build", "tex_preprocess", "summary.json"), "auto_qft.model_build.tex_preprocess.summary.json"),
    (os.path.join(out_dir, "auto_qft", "model_build", "tex_preprocess", "blocks_selected.json"), "auto_qft.model_build.tex_preprocess.blocks_selected.json"),
    (os.path.join(out_dir, "auto_qft", "model_build", "tex_preprocess", "blocks_all.json"), "auto_qft.model_build.tex_preprocess.blocks_all.json"),
    (os.path.join(out_dir, "auto_qft", "model_build", "tex_preprocess", "macros.json"), "auto_qft.model_build.tex_preprocess.macros.json"),
    (os.path.join(out_dir, "auto_qft", "model_build", "tex_preprocess", "tex_files.json"), "auto_qft.model_build.tex_preprocess.tex_files.json"),
    (os.path.join(out_dir, "auto_qft", "model_build", "tex_preprocess", "trace.json"), "auto_qft.model_build.tex_preprocess.trace.json"),
    (os.path.join(out_dir, "auto_qft", "diagrams", "diagrams.pdf"), "auto_qft.diagrams.pdf"),
    (os.path.join(out_dir, "auto_qft", "diagrams", "index.md"), "auto_qft.diagrams.index.md"),
    (os.path.join(out_dir, "auto_qft", "amplitude", "amplitude_summed.m"), "auto_qft.amplitude_summed.m"),
    (os.path.join(out_dir, "auto_qft", "amplitude", "amplitude_summed.tex"), "auto_qft.amplitude_summed.tex"),
    (os.path.join(out_dir, "auto_qft", "amplitude", "amplitude_summed.md"), "auto_qft.amplitude_summed.md"),
    (os.path.join(out_dir, "job.resolved.json"), "job.resolved.json"),
    (os.path.join(out_dir, "meta", "env.json"), "env.json"),
]

for (src, dst_name) in to_copy:
    if os.path.isfile(src):
        shutil.copy2(src, os.path.join(dest, dst_name))

with open(os.path.join(dest, "FULL_OUT_DIR.txt"), "w", encoding="utf-8") as f:
    f.write(out_dir + "\n")
print(f"[hep-calc] synced core artifacts to {dest}")
PY

if [[ "${sync_rc}" -ne 0 ]]; then
  echo "[hep-calc] research-team sync FAILED (rc=${sync_rc})" | tee -a "${main_log}" >/dev/null
fi

if [[ "${env_rc}" -ne 0 || "${tex_model_rc}" -ne 0 || "${fa_fc_rc}" -ne 0 || "${auto_qft_rc}" -ne 0 || "${mma_rc}" -ne 0 || "${julia_rc}" -ne 0 || "${tex_rc}" -ne 0 || "${report_rc}" -ne 0 || "${sync_rc}" -ne 0 ]]; then
  exit 1
fi
exit 0
