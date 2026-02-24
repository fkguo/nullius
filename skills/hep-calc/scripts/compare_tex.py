#!/usr/bin/env python3
from __future__ import annotations

import argparse
import importlib.util
import json
import math
import os
import re
import sys
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Optional, Tuple


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


NUMBER_RE_DEFAULT = re.compile(r"[-+]?(?:\d+\.\d*|\d*\.\d+|\d+)(?:[eE][-+]?\d+)?")


@dataclass
class ExtractedValue:
    value: Optional[float]
    raw: Optional[str]
    source: Optional[dict]
    error: Optional[str] = None


def load_json(path: Path) -> dict:
    with path.open("r", encoding="utf-8") as f:
        return json.load(f)


def dump_json(path: Path, obj: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as f:
        json.dump(obj, f, indent=2, sort_keys=True)
        f.write("\n")


def parse_calc_value(v: Any) -> Optional[complex]:
    if v is None:
        return None
    if isinstance(v, (int, float)):
        return complex(float(v), 0.0)
    if isinstance(v, dict) and "re" in v and "im" in v:
        return complex(float(v["re"]), float(v["im"]))
    return None


def tolerance_for_target(job: dict, target: dict) -> Tuple[float, float]:
    tol = job.get("tolerance") or {}
    rel = float(tol.get("rel", 1e-4))
    abs_ = float(tol.get("abs", 1e-12))
    if isinstance(target.get("tolerance"), dict):
        rel = float(target["tolerance"].get("rel", rel))
        abs_ = float(target["tolerance"].get("abs", abs_))
    per = (tol.get("per_target") or {}).get(target.get("id"))
    if isinstance(per, dict):
        rel = float(per.get("rel", rel))
        abs_ = float(per.get("abs", abs_))
    return rel, abs_


def within_tol(calc: float, ref: float, rel: float, abs_: float) -> Tuple[bool, float, float]:
    delta = abs(calc - ref)
    scale = abs(ref)
    thresh = max(abs_, rel * scale) if scale > abs_ else abs_
    return delta <= thresh, delta, thresh


def _read_tex_files(paths: list[str]) -> dict[str, str]:
    out: dict[str, str] = {}
    for p in paths:
        try:
            out[p] = Path(p).read_text(encoding="utf-8", errors="replace")
        except Exception as exc:
            out[p] = ""
            out[p + ".__error__"] = str(exc)
    return out


def _load_plugin(path: str):
    spec = importlib.util.spec_from_file_location("hep_calc_extractor_plugin", path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot load plugin: {path}")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)  # type: ignore[assignment]
    return mod


def default_extract_one(job: dict, target: dict, tex_by_path: dict[str, str]) -> ExtractedValue:
    label = target.get("label")
    regex = target.get("regex")
    tex_paths = job.get("latex", {}).get("tex_paths") or []

    # Choose a tex file: target.file overrides, else first in tex_paths.
    file_path = target.get("file") or (tex_paths[0] if tex_paths else None)
    if not file_path:
        return ExtractedValue(value=None, raw=None, source=None, error="no_tex_paths")
    text = tex_by_path.get(file_path, "")
    if not text:
        err = tex_by_path.get(file_path + ".__error__")
        return ExtractedValue(value=None, raw=None, source=None, error=err or "empty_tex")

    if regex:
        m = re.search(regex, text, flags=re.MULTILINE | re.DOTALL)
        if not m:
            return ExtractedValue(value=None, raw=None, source={"file": file_path, "regex": regex}, error="regex_no_match")
        raw = m.group(1) if m.groups() else m.group(0)
        try:
            return ExtractedValue(value=float(raw), raw=raw, source={"file": file_path, "regex": regex})
        except Exception as exc:
            return ExtractedValue(value=None, raw=raw, source={"file": file_path, "regex": regex}, error=f"parse_float_failed: {exc}")

    if not label:
        return ExtractedValue(value=None, raw=None, source={"file": file_path}, error="no_label_or_regex")

    idx = text.find(f"\\label{{{label}}}")
    if idx < 0:
        return ExtractedValue(value=None, raw=None, source={"file": file_path, "label": label}, error="label_not_found")

    window = int(target.get("window_chars", 800))
    lo = max(0, idx - window)
    hi = min(len(text), idx + window)
    snippet = text[lo:hi]
    label_pos_in_snippet = idx - lo

    label_patterns = job.get("latex", {}).get("label_patterns") or {}
    prefix = label.split(":", 1)[0] if isinstance(label, str) and ":" in label else label
    pat = label_patterns.get(prefix)
    number_re = re.compile(pat) if isinstance(pat, str) and pat else NUMBER_RE_DEFAULT

    matches = list(number_re.finditer(snippet))
    if not matches:
        return ExtractedValue(value=None, raw=None, source={"file": file_path, "label": label}, error="number_not_found_near_label")

    # Prefer the numeric match closest *before* the label (common in equations/tables).
    before = [m for m in matches if m.start() < label_pos_in_snippet]
    m = max(before, key=lambda m: m.start()) if before else matches[0]

    raw = m.group(1) if m.groups() else m.group(0)
    try:
        return ExtractedValue(value=float(raw), raw=raw, source={"file": file_path, "label": label})
    except Exception as exc:
        return ExtractedValue(value=None, raw=raw, source={"file": file_path, "label": label}, error=f"parse_float_failed: {exc}")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--job", required=True, help="Path to job.resolved.json")
    ap.add_argument("--out", required=True, help="out_dir")
    args = ap.parse_args()

    out_dir = Path(args.out).resolve()
    job = load_json(Path(args.job))

    tex_dir = out_dir / "tex"
    status_path = tex_dir / "status.json"
    extracted_path = tex_dir / "extracted.json"
    comparison_path = tex_dir / "comparison.json"

    latex = job.get("latex") or {}
    tex_paths = latex.get("tex_paths") or []
    targets = latex.get("targets") or []

    started = utc_now()

    if not targets:
        reason = "no_targets_specified"
    elif not tex_paths:
        reason = "no_tex_paths"
    else:
        reason = ""

    if reason:
        dump_json(extracted_path, {"ts": utc_now(), "values": {}})
        dump_json(comparison_path, {"ts": utc_now(), "results": []})
        dump_json(
            status_path,
            {
                "stage": "tex_compare",
                "status": "SKIPPED",
                "reason": reason,
                "started_at": started,
                "ended_at": utc_now(),
            },
        )
        return 0

    tex_by_path = _read_tex_files(list(map(str, tex_paths)))

    plugin_path = latex.get("extractor_plugin")
    plugin_results: dict[str, Any] = {}
    plugin_error: Optional[str] = None
    if plugin_path:
        try:
            mod = _load_plugin(plugin_path)
            if not hasattr(mod, "extract"):
                raise RuntimeError("plugin must define extract(job, tex_by_path, out_dir) -> dict")
            plugin_results = mod.extract(job, tex_by_path, str(out_dir))  # type: ignore[attr-defined]
            if not isinstance(plugin_results, dict):
                raise RuntimeError("plugin.extract must return dict")
        except Exception as exc:
            plugin_error = str(exc)

    extracted: Dict[str, Any] = {}
    for t in targets:
        tid = t.get("id")
        if not tid:
            continue
        if tid in plugin_results:
            extracted[tid] = plugin_results[tid]
            continue
        ev = default_extract_one(job, t, tex_by_path)
        extracted[tid] = {
            "value": ev.value,
            "raw": ev.raw,
            "source": ev.source,
            "error": ev.error,
        }

    dump_json(extracted_path, {"ts": utc_now(), "values": extracted, "plugin_error": plugin_error})

    # Compare against numeric results (if present).
    numeric_path = out_dir / "numeric" / "numeric.json"
    numeric: dict[str, Any] = {"results": []}
    if numeric_path.is_file():
        numeric = load_json(numeric_path)

    calc_by_id: dict[str, Optional[complex]] = {}
    for r in numeric.get("results") or []:
        rid = r.get("id")
        if not rid:
            continue
        calc_by_id[rid] = parse_calc_value(r.get("value"))

    results: list[dict[str, Any]] = []
    n_pass = n_fail = n_skip = 0
    for t in targets:
        tid = t.get("id")
        if not tid:
            continue
        ref_obj = extracted.get(tid) or {}
        ref_val = ref_obj.get("value")
        calc_val = calc_by_id.get(tid)
        rel, abs_ = tolerance_for_target(job, t)

        if ref_val is None:
            n_skip += 1
            results.append({"id": tid, "status": "SKIPPED", "reason": "no_tex_value", "tolerance": {"rel": rel, "abs": abs_}})
            continue
        if calc_val is None:
            n_skip += 1
            results.append({"id": tid, "status": "SKIPPED", "reason": "no_calc_value", "tolerance": {"rel": rel, "abs": abs_}})
            continue

        try:
            scale = float(t.get("scaling", 1.0))
        except Exception:
            scale = 1.0
        ref_raw = float(ref_val)
        ref_scaled = ref_raw * scale

        calc_real = float(calc_val.real)
        ok, delta, thresh = within_tol(calc_real, ref_scaled, rel, abs_)
        imag = float(calc_val.imag)
        imag_ok = abs(imag) <= max(abs_, 10.0 * abs_)  # allow tiny numerical noise

        status = "PASS" if (ok and imag_ok) else "FAIL"
        if status == "PASS":
            n_pass += 1
        else:
            n_fail += 1
        results.append(
            {
                "id": tid,
                "status": status,
                "ref": {"value": ref_scaled, "value_raw": ref_raw, "scaling": scale},
                "calc": {"re": calc_real, "im": imag},
                "delta": {"abs": delta, "threshold": thresh},
                "tolerance": {"rel": rel, "abs": abs_},
            }
        )

    dump_json(comparison_path, {"ts": utc_now(), "results": results})
    dump_json(
        status_path,
        {
            "stage": "tex_compare",
            "status": "PASS" if n_fail == 0 else "FAIL",
            "started_at": started,
            "ended_at": utc_now(),
            "counts": {"pass": n_pass, "fail": n_fail, "skipped": n_skip, "total": len(results)},
            "plugin_error": plugin_error,
        },
    )

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
