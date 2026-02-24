#!/usr/bin/env python3
from __future__ import annotations

import argparse
import hashlib
import json
import os
import subprocess
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Optional


HEP_CALC_VERSION = "0.1.0"


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def load_json(path: Path) -> dict:
    with path.open("r", encoding="utf-8") as f:
        return json.load(f)


def dump_json(path: Path, obj: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as f:
        json.dump(obj, f, indent=2, sort_keys=True)
        f.write("\n")


def sha256(path: Path) -> Optional[str]:
    try:
        h = hashlib.sha256()
        with path.open("rb") as f:
            for chunk in iter(lambda: f.read(1024 * 1024), b""):
                h.update(chunk)
        return h.hexdigest()
    except Exception:
        return None


def git_info(cwd: str, report_dir: Path) -> dict:
    try:
        inside = subprocess.check_output(["git", "-C", cwd, "rev-parse", "--is-inside-work-tree"], text=True).strip()
        if inside != "true":
            return {}
        head = subprocess.check_output(["git", "-C", cwd, "rev-parse", "HEAD"], text=True).strip()
        status = subprocess.check_output(["git", "-C", cwd, "status", "--porcelain=v1"], text=True).splitlines()
        dirty = len(status) > 0
        out = {"head": head, "dirty": dirty}
        if dirty:
            try:
                diff = subprocess.check_output(["git", "-C", cwd, "diff", "HEAD"], text=True)
                report_dir.mkdir(parents=True, exist_ok=True)
                diff_path = report_dir / "git_diff.patch"
                diff_path.write_text(diff, encoding="utf-8")
                try:
                    out["diff_path"] = str(diff_path.relative_to(report_dir.parent))
                except Exception:
                    out["diff_path"] = str(diff_path)
                out["diff_sha256"] = sha256(diff_path)
            except Exception:
                pass
        return out
    except Exception:
        return {}


def read_optional_json(path: Path) -> Optional[dict]:
    if not path.is_file():
        return None
    try:
        return load_json(path)
    except Exception:
        return None


def _redact_path(p: str) -> str:
    """
    Remove machine-specific absolute paths from human-facing reports.
    - If under $HOME, rewrite as ~/...
    - Otherwise, collapse to basename for common system roots
    """
    try:
        if not p:
            return ""
        p = str(p)
        home = str(Path.home().resolve())
        pp = str(Path(p).expanduser().resolve())
        if pp == home:
            return "~"
        if pp.startswith(home + os.sep):
            return "~/" + os.path.relpath(pp, home)
        if pp.startswith(("/usr/", "/opt/", "/bin/", "/sbin/", "/Applications/")):
            return os.path.basename(pp) or pp
        return pp
    except Exception:
        return str(p)


def _find_job_original_rel(out_dir: Path) -> str:
    inputs_dir = out_dir / "inputs"
    if not inputs_dir.is_dir():
        return "inputs/"
    try:
        hits = sorted(p.name for p in inputs_dir.iterdir() if p.is_file() and p.name.startswith("job.original."))
        if hits:
            return f"inputs/{hits[0]}"
    except Exception:
        pass
    return "inputs/job.original.<yml|yaml|json>"


def _find_first_rel(out_dir: Path, *, dir_rel: str, prefix: str) -> Optional[str]:
    d = out_dir / dir_rel
    if not d.is_dir():
        return None
    try:
        hits = sorted(p.name for p in d.iterdir() if p.is_file() and p.name.startswith(prefix))
        if hits:
            return f"{dir_rel}/{hits[0]}"
    except Exception:
        return None
    return None


def _canonical_json_bytes(obj: Any) -> bytes:
    # Deterministic (stable key ordering + stable separators).
    return json.dumps(obj, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")


def _sha256_bytes(data: bytes) -> str:
    h = hashlib.sha256()
    h.update(data)
    return h.hexdigest()


def _strip_job_meta(job: dict) -> dict:
    out = dict(job)
    out.pop("_meta", None)
    return out


def _walk_files_rel(out_dir: Path) -> list[str]:
    """
    Deterministically list all files under out_dir as POSIX relative paths.
    """
    out: list[str] = []
    for root, _, files in os.walk(out_dir):
        root_p = Path(root)
        for fn in files:
            p = root_p / fn
            try:
                rel = p.relative_to(out_dir).as_posix()
            except Exception:
                continue
            if rel == ".DS_Store" or rel.endswith("/.DS_Store"):
                continue
            out.append(rel)
    return sorted(set(out))


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--job", required=True, help="Path to job.resolved.json")
    ap.add_argument("--out", required=True, help="out_dir")
    args = ap.parse_args()

    out_dir = Path(args.out).resolve()
    job = load_json(Path(args.job))
    meta = job.get("_meta") or {}

    env = read_optional_json(out_dir / "meta" / "env.json") or {}
    fa_fc_status = read_optional_json(out_dir / "feynarts_formcalc" / "status.json") or {"stage": "feynarts_formcalc", "status": "NOT_RUN"}
    auto_qft_status = read_optional_json(out_dir / "auto_qft" / "status.json") or {"stage": "auto_qft_one_loop", "status": "NOT_RUN"}
    auto_qft_summary = read_optional_json(out_dir / "auto_qft" / "summary.json") or {}
    model_build_status = read_optional_json(out_dir / "auto_qft" / "model_build" / "status.json") or {
        "stage": "auto_qft_model_build",
        "status": "NOT_RUN",
    }
    tex_model_status = read_optional_json(out_dir / "auto_qft" / "model_build" / "tex_preprocess" / "status.json") or {
        "stage": "tex_model_preprocess",
        "status": "NOT_RUN",
    }
    sym_status = read_optional_json(out_dir / "symbolic" / "status.json") or {"stage": "mathematica_symbolic", "status": "NOT_RUN"}
    num_status = read_optional_json(out_dir / "numeric" / "status.json") or {"stage": "julia_numeric", "status": "NOT_RUN"}
    tex_status = read_optional_json(out_dir / "tex" / "status.json") or {"stage": "tex_compare", "status": "NOT_RUN"}
    comparison = read_optional_json(out_dir / "tex" / "comparison.json") or {"results": []}

    results = comparison.get("results") or []
    n_pass = sum(1 for r in results if r.get("status") == "PASS")
    n_fail = sum(1 for r in results if r.get("status") == "FAIL")
    n_skip = sum(1 for r in results if r.get("status") == "SKIPPED")

    latex = job.get("latex") or {}
    tex_targets_requested = bool(latex.get("targets") or [])
    run_mode = "tex_audit" if tex_targets_requested else "compute_only"
    tex_compare_performed = tex_status.get("status") in {"PASS", "FAIL"}

    stage_statuses = [
        fa_fc_status.get("status"),
        tex_model_status.get("status"),
        model_build_status.get("status"),
        auto_qft_status.get("status"),
        sym_status.get("status"),
        num_status.get("status"),
        tex_status.get("status"),
    ]
    compute_statuses = [fa_fc_status.get("status"), auto_qft_status.get("status"), sym_status.get("status"), num_status.get("status")]
    compute_passed = any(s == "PASS" for s in compute_statuses)
    any_error = any(s == "ERROR" for s in stage_statuses)
    any_fail = n_fail > 0
    any_target = (n_pass + n_fail + n_skip) > 0

    if any_error:
        overall = "ERROR"
    elif any_fail:
        overall = "FAIL"
    else:
        if tex_targets_requested:
            # TeX audit mode: targets exist, so missing values are an incomplete audit (PARTIAL).
            if any_target and n_skip > 0:
                overall = "PARTIAL"
            elif any_target and n_pass > 0 and n_fail == 0 and n_skip == 0:
                overall = "PASS"
            else:
                overall = "PARTIAL"
        else:
            # Compute-only mode: TeX compare is not requested; consider PASS if computation succeeded.
            overall = "PASS" if compute_passed else "PARTIAL"

    # SSOT artifacts: use a stable created_at when possible (job.resolved.json is the best reference).
    created_at = meta.get("resolved_at") or env.get("ts") or utc_now()

    # Inputs + checksums (best effort, portable: paths redacted; prefer copies under out_dir/inputs).
    job_original_rel = _find_job_original_rel(out_dir)
    run_card_rel = _find_first_rel(out_dir, dir_rel="inputs", prefix="run_card")

    inputs: list[dict[str, Any]] = []

    job_original_path = out_dir / Path(job_original_rel)
    inputs.append({"kind": "job_original", "path": job_original_rel, "sha256": sha256(job_original_path)})

    run_card_src = (job.get("run_card") or "").strip()
    if run_card_rel:
        inputs.append(
            {
                "kind": "run_card",
                "path": run_card_rel,
                "sha256": sha256(out_dir / Path(run_card_rel)),
                "source_path": _redact_path(run_card_src) if run_card_src else None,
            }
        )
    elif run_card_src:
        inputs.append({"kind": "run_card", "path": None, "sha256": sha256(Path(run_card_src)), "source_path": _redact_path(run_card_src)})

    job_entry = ((job.get("mathematica") or {}).get("entry") or "").strip()
    if job_entry:
        inputs.append({"kind": "mathematica.entry", "path": None, "sha256": sha256(Path(job_entry)), "source_path": _redact_path(job_entry)})

    auto = job.get("auto_qft") or {}
    for p in auto.get("model_files") or []:
        if isinstance(p, str) and p.strip():
            inputs.append({"kind": "auto_qft.model_file", "path": None, "sha256": sha256(Path(p)), "source_path": _redact_path(p)})

    mb = auto.get("model_build") or {}
    if isinstance(mb, dict):
        rewrite_wls = (mb.get("rewrite_wls") or "").strip()
        if rewrite_wls:
            inputs.append({"kind": "auto_qft.model_build.rewrite_wls", "path": None, "sha256": sha256(Path(rewrite_wls)), "source_path": _redact_path(rewrite_wls)})
        for p in mb.get("base_model_files") or []:
            if isinstance(p, str) and p.strip():
                inputs.append({"kind": "auto_qft.model_build.base_model_file", "path": None, "sha256": sha256(Path(p)), "source_path": _redact_path(p)})
        for p in mb.get("tex_paths") or []:
            if isinstance(p, str) and p.strip():
                inputs.append({"kind": "auto_qft.model_build.tex_path", "path": None, "sha256": sha256(Path(p)), "source_path": _redact_path(p)})

    for p in (job.get("latex") or {}).get("tex_paths") or []:
        if isinstance(p, str) and p.strip():
            inputs.append({"kind": "latex.tex_path", "path": None, "sha256": sha256(Path(p)), "source_path": _redact_path(p)})
    plugin = ((job.get("latex") or {}).get("extractor_plugin") or "").strip()
    if plugin:
        inputs.append({"kind": "latex.extractor_plugin", "path": None, "sha256": sha256(Path(plugin)), "source_path": _redact_path(plugin)})

    # Stable fingerprints for downstream regression/eval:
    # - job config fingerprint ignores run-local _meta fields.
    # - output file list fingerprint is computed later after writing artifacts.
    job_resolved_wo_meta_sha256 = _sha256_bytes(_canonical_json_bytes(_strip_job_meta(job)))

    report_dir = out_dir / "report"
    report_dir.mkdir(parents=True, exist_ok=True)
    gi = git_info(meta.get("cwd") or os.getcwd(), report_dir)

    failed_ids = [r.get("id") for r in results if r.get("status") == "FAIL" and r.get("id")]
    skipped_ids = [r.get("id") for r in results if r.get("status") == "SKIPPED" and r.get("id")]

    versions = env.get("versions") or {}
    tools = env.get("tools") or {}
    env_full = bool(env.get("ok_full_toolchain"))
    out_dir_rel = "."
    audit_md_rel = "report/audit_report.md"

    audit_md = report_dir / "audit_report.md"
    audit_md.write_text(
        "\n".join(
            [
                "# hep-calc audit report",
                "",
                f"- created_at_utc: {created_at}",
                f"- hep_calc_version: {HEP_CALC_VERSION}",
                f"- overall_status: {overall}",
                f"- run_mode: {run_mode}",
                f"- tex_compare_requested: {tex_targets_requested}",
                f"- tex_compare_performed: {tex_compare_performed}",
                f"- out_dir: {out_dir_rel}",
                f"- job: {job_original_rel}",
                "",
                "## Step status",
                "",
                "| Step | Status | Reason |",
                "|---|---:|---|",
                f"| env_check | {'PASS' if env_full else 'ERROR'} | {'-' if env_full else 'see meta/env.json'} |",
                f"| feynarts_formcalc | {fa_fc_status.get('status','?')} | {fa_fc_status.get('reason', fa_fc_status.get('hint','-'))} |",
                f"| tex_model_preprocess | {tex_model_status.get('status','?')} | {tex_model_status.get('reason', tex_model_status.get('hint','-'))} |",
                f"| auto_qft_model_build | {model_build_status.get('status','?')} | {model_build_status.get('reason','-') or '-'} |",
                f"| auto_qft_one_loop | {auto_qft_status.get('status','?')} | {auto_qft_status.get('reason', auto_qft_summary.get('reason','-'))} |",
                f"| mathematica_symbolic | {sym_status.get('status','?')} | {sym_status.get('reason','-')} |",
                f"| julia_numeric | {num_status.get('status','?')} | {num_status.get('reason','-')} |",
                f"| tex_compare | {tex_status.get('status','?')} | {tex_status.get('reason','-')} |",
                "",
                "## Config notes",
                "",
                f"- auto_qft_enable_mode: {meta.get('auto_qft_enable_mode','')}",
                f"- auto_qft_enable_implicit_reason: {json.dumps(meta.get('auto_qft_enable_implicit_reason') or {}, sort_keys=True)}",
                "",
                "## Environment (snapshot)",
                "",
                f"- full_toolchain_ok: {env.get('ok_full_toolchain','')}",
                f"- python3: {versions.get('python3','')}",
                f"- wolframscript: {versions.get('wolframscript','')}",
                f"- julia: {versions.get('julia','')}",
                f"- mathematica: {versions.get('mathematica','')}",
                f"- system_id: {versions.get('system_id','')}",
                f"- feyncalc: {versions.get('feyncalc','')}",
                f"- feynarts: {versions.get('feynarts','')}",
                f"- formcalc: {versions.get('formcalc','')}",
                f"- feynrules: {versions.get('feynrules','')}",
                f"- looptools_jl: {versions.get('looptools_jl','')}",
                f"- looptools_bin_sha256: {(tools.get('looptools_bin') or {}).get('sha256','') if isinstance(tools.get('looptools_bin'), dict) else ''}",
                f"- tool_paths: {json.dumps({k: _redact_path(v.get('path')) for k, v in tools.items() if isinstance(v, dict) and 'path' in v}, sort_keys=True)}",
                "",
                "## Target summary",
                "",
                f"- targets_total: {n_pass + n_fail + n_skip}",
                f"- pass: {n_pass}",
                f"- fail: {n_fail}",
                f"  - ids: {', '.join(failed_ids) if failed_ids else 'None'}",
                f"- skipped: {n_skip}",
                f"  - ids: {', '.join(skipped_ids) if skipped_ids else 'None'}",
                "",
                "## Mandatory disclosures (skipped/missing)",
                "",
                "- If a step shows SKIPPED/NOT_RUN, it was not executed; see per-step status.json and logs/ for details.",
                "- Notebook (.nb) inputs are best-effort: only Input cells are extracted and executed; see symbolic/status.json risks.",
                "- FeynArts→FormCalc pipeline is OFF by default; enable via `enable_fa_fc: true` or provide `feynarts_formcalc_spec`.",
                "- auto_qft runs when explicitly enabled (`auto_qft.enable: true`) OR implicitly when `auto_qft.process` + a model are specified and `auto_qft.enable` is omitted. To force-disable, set `auto_qft.enable: false`. auto_qft amplitude is UNRENORMALIZED; explicit UV poles (1/ε) typically require FormCalc reduction (`auto_qft.formcalc.enable: true`).",
                "- TeX compare is optional: if `latex.targets` is empty, tex_compare is treated as not requested (compute-only mode).",
                "",
                "## Pointers",
                "",
                f"- env: meta/env.json",
                f"- job: job.resolved.json",
                f"- feynarts_formcalc: feynarts_formcalc/status.json",
                f"- tex_model_preprocess: auto_qft/model_build/tex_preprocess/status.json",
                f"- auto_qft_model_build: auto_qft/model_build/status.json",
                f"- auto_qft: auto_qft/status.json",
                f"- symbolic: symbolic/symbolic.json",
                f"- numeric: numeric/numeric.json",
                f"- tex extracted: tex/extracted.json",
                f"- comparison: tex/comparison.json",
                "",
                "## Git (best-effort)",
                "",
                f"- git: {json.dumps(gi, sort_keys=True)}",
                "",
            ]
        )
        + "\n",
        encoding="utf-8",
    )

    steps = {
        "feynarts_formcalc": fa_fc_status,
        "tex_model_preprocess": tex_model_status,
        "auto_qft_model_build": model_build_status,
        "auto_qft": auto_qft_status,
        "symbolic": sym_status,
        "numeric": num_status,
        "tex_compare": tex_status,
    }

    tools_public = {}
    if isinstance(tools, dict):
        for k, v in tools.items():
            if not isinstance(v, dict):
                continue
            tools_public[k] = {kk: v.get(kk) for kk in ("ok", "reason", "hint") if v.get(kk) is not None}

    env_public = {
        "ok_full_toolchain": bool(env.get("ok_full_toolchain")),
        "versions": versions,
        "tools": tools_public,
        "env_json": "meta/env.json",
    }

    pointers = {
        "job_resolved": "job.resolved.json",
        "job_original": job_original_rel,
        "run_card": run_card_rel,
        "command_line": "meta/command_line.txt",
        "audit_report": audit_md_rel,
        "report_dir": "report",
        "logs_dir": "logs",
    }

    manifest = {
        "kind": "hep-calc-run",
        "schema_version": 1,
        "created_at": created_at,
        "tool": {"name": "hep-calc", "version": HEP_CALC_VERSION},
        "out_dir": out_dir_rel,
        "cwd": _redact_path(meta.get("cwd") or os.getcwd()),
        "job": {
            "original": job_original_rel,
            "resolved": "job.resolved.json",
            "run_card": run_card_rel,
            "resolved_wo_meta_sha256": job_resolved_wo_meta_sha256,
        },
        "inputs": inputs,
        "environment": env_public,
        "commands": [{"id": "run", "path": "meta/command_line.txt"}],
        "steps": steps,
        "auto_qft_summary": auto_qft_summary,
        "overall_status": overall,
        "run_mode": run_mode,
        "tex_compare_requested": tex_targets_requested,
        "tex_compare_performed": tex_compare_performed,
        "outputs": {"files": [], "paths_digest_sha256": None},
        "pointers": pointers,
        "git": gi,
    }

    headline = [
        {"id": "tex.targets_total", "value": n_pass + n_fail + n_skip, "definition": "Number of latex.targets that produced a PASS/FAIL/SKIPPED result."},
        {"id": "tex.pass", "value": n_pass, "definition": "Count of PASS targets in tex comparison."},
        {"id": "tex.fail", "value": n_fail, "definition": "Count of FAIL targets in tex comparison."},
        {"id": "tex.skipped", "value": n_skip, "definition": "Count of SKIPPED targets in tex comparison."},
    ]
    if isinstance(auto_qft_status, dict):
        headline.append({"id": "auto_qft.status", "value": auto_qft_status.get("status"), "definition": "Status of the auto_qft stage (diagrams + one-loop amplitude)."})
    if isinstance(sym_status, dict):
        headline.append({"id": "symbolic.status", "value": sym_status.get("status"), "definition": "Status of the Mathematica symbolic stage."})
    if isinstance(num_status, dict):
        headline.append({"id": "numeric.status", "value": num_status.get("status"), "definition": "Status of the Julia numeric stage."})

    summary = {
        "created_at": created_at,
        "overall_status": overall,
        "run_mode": run_mode,
        "tex_compare_requested": tex_targets_requested,
        "tex_compare_performed": tex_compare_performed,
        "compute_passed": compute_passed,
        "counts": {"pass": n_pass, "fail": n_fail, "skipped": n_skip, "total": n_pass + n_fail + n_skip},
        "headline": headline,
        "fingerprints": {"job_resolved_wo_meta_sha256": job_resolved_wo_meta_sha256},
        "out_dir": out_dir_rel,
        "audit_report": audit_md_rel,
        "manifest": "manifest.json",
        "analysis": "analysis.json",
    }

    analysis = {
        "created_at": created_at,
        "overall_status": overall,
        "run_mode": run_mode,
        "tex_compare_requested": tex_targets_requested,
        "tex_compare_performed": tex_compare_performed,
        "comparison": results,
        "steps": steps,
        "auto_qft_summary": auto_qft_summary,
        "inputs": inputs,
    }

    # Write SSOT artifacts both at out_dir root and under report/ (back-compat).
    dump_json(out_dir / "manifest.json", manifest)
    dump_json(out_dir / "summary.json", summary)
    dump_json(out_dir / "analysis.json", analysis)
    dump_json(report_dir / "manifest.json", manifest)
    dump_json(report_dir / "summary.json", summary)
    dump_json(report_dir / "analysis.json", analysis)

    # Populate deterministic output file list for regression/eval.
    out_files = _walk_files_rel(out_dir)
    out_digest = _sha256_bytes(("\n".join(out_files) + "\n").encode("utf-8"))
    manifest["outputs"] = {"files": out_files, "paths_digest_sha256": out_digest}
    summary["fingerprints"]["outputs_files_sha256"] = out_digest

    dump_json(out_dir / "manifest.json", manifest)
    dump_json(out_dir / "summary.json", summary)
    dump_json(report_dir / "manifest.json", manifest)
    dump_json(report_dir / "summary.json", summary)

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
