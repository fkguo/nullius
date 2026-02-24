from __future__ import annotations

import os
import zipfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from ._git import try_get_git_metadata
from ._json import read_json, write_json
from ._paths import manifest_cwd
from ._time import utc_now_iso
from .artifact_report import write_artifact_report


@dataclass(frozen=True)
class CaseResult:
    case_id: str
    workflow: str
    ok: bool
    messages: list[str]


def _resolve_note_path(repo_root: Path, case: dict[str, Any], required_paths: list[str]) -> Path | None:
    inputs = case.get("inputs") or {}
    refkey = inputs.get("refkey")
    if isinstance(refkey, str) and refkey.strip():
        return repo_root / "knowledge_base" / "literature" / f"{refkey.strip()}.md"
    for p in required_paths:
        if p.endswith(".md"):
            return repo_root / p
    return None


def _json_pointer_get(payload: Any, pointer: str) -> Any:
    """Resolve a JSON pointer or dotted path (very small subset).

    Supported formats:
    - "#/a/b/0/c"
    - "/a/b/0/c"
    - "a.b.0.c"
    """
    if pointer.startswith("#"):
        pointer = pointer[1:]
    pointer = pointer.strip()
    if not pointer:
        return payload

    if pointer.startswith("/"):
        parts = pointer.lstrip("/").split("/")

        def unescape(p: str) -> str:
            return p.replace("~1", "/").replace("~0", "~")

        tokens: list[str] = [unescape(p) for p in parts if p != ""]
    else:
        tokens = [p for p in pointer.split(".") if p != ""]

    cur: Any = payload
    for t in tokens:
        if isinstance(cur, list):
            try:
                idx = int(t)
            except Exception as e:
                raise KeyError(f"expected list index, got {t!r}") from e
            cur = cur[idx]
            continue
        if isinstance(cur, dict):
            if t not in cur:
                raise KeyError(t)
            cur = cur[t]
            continue
        raise KeyError(f"cannot traverse into {type(cur).__name__}")
    return cur


def _schema_type_ok(v: Any, schema_type: str) -> bool:
    if schema_type == "object":
        return isinstance(v, dict)
    if schema_type == "array":
        return isinstance(v, list)
    if schema_type == "string":
        return isinstance(v, str)
    if schema_type == "boolean":
        return isinstance(v, bool)
    if schema_type == "null":
        return v is None
    if schema_type == "integer":
        return isinstance(v, int) and not isinstance(v, bool)
    if schema_type == "number":
        return isinstance(v, (int, float)) and not isinstance(v, bool)
    return True


def _schema_resolve_ref(root_schema: dict[str, Any], ref: str) -> dict[str, Any] | None:
    if not ref.startswith("#/"):
        return None
    tokens = [t for t in ref.lstrip("#/").split("/") if t != ""]

    def unescape(p: str) -> str:
        return p.replace("~1", "/").replace("~0", "~")

    cur: Any = root_schema
    for t in (unescape(x) for x in tokens):
        if isinstance(cur, list):
            try:
                cur = cur[int(t)]
            except Exception:  # CONTRACT-EXEMPT: CODE-01.5 intentional fallback for invalid pointer
                return None
            continue
        if isinstance(cur, dict):
            if t not in cur:
                return None
            cur = cur[t]
            continue
        return None
    return cur if isinstance(cur, dict) else None


def _schema_validate(payload: Any, schema: dict[str, Any], path: str, *, root_schema: dict[str, Any]) -> list[str]:
    """Minimal JSON-schema subset validator (deterministic, no third-party deps).

    Supported keywords: $ref, type, required, properties, additionalProperties, items, enum, minimum, minLength, oneOf.
    """
    errors: list[str] = []

    if not isinstance(schema, dict):
        return errors

    if "$ref" in schema:
        ref = schema.get("$ref")
        if not isinstance(ref, str):
            return [f"{path}: $ref must be a string"]
        target = _schema_resolve_ref(root_schema, ref)
        if target is None:
            return [f"{path}: could not resolve $ref {ref!r}"]
        return _schema_validate(payload, target, path, root_schema=root_schema)

    if "oneOf" in schema:
        opts = schema.get("oneOf")
        if not isinstance(opts, list) or not opts:
            return [f"{path}: schema.oneOf must be a non-empty list"]
        best_errs: list[str] | None = None
        for opt in opts:
            if not isinstance(opt, dict):
                continue
            sub_errs = _schema_validate(payload, opt, path, root_schema=root_schema)
            if not sub_errs:
                return []
            if best_errs is None or len(sub_errs) < len(best_errs):
                best_errs = sub_errs
        errors.append(f"{path}: does not satisfy any schema in oneOf")
        if best_errs:
            errors.extend(best_errs[:5])
        return errors

    schema_type = schema.get("type")
    if isinstance(schema_type, str) and not _schema_type_ok(payload, schema_type):
        return [f"{path}: expected type {schema_type}, got {type(payload).__name__}"]

    if "enum" in schema and isinstance(schema.get("enum"), list):
        if payload not in schema["enum"]:
            errors.append(f"{path}: value {payload!r} not in enum")

    if isinstance(schema_type, str) and schema_type in {"integer", "number"} and "minimum" in schema:
        try:
            if float(payload) < float(schema["minimum"]):
                errors.append(f"{path}: value {payload} < minimum {schema['minimum']}")
        except Exception:
            errors.append(f"{path}: cannot compare minimum for value {payload!r}")

    if isinstance(schema_type, str) and schema_type == "string" and "minLength" in schema:
        try:
            if len(str(payload)) < int(schema["minLength"]):
                errors.append(f"{path}: string shorter than minLength {schema['minLength']}")
        except Exception:
            errors.append(f"{path}: cannot validate minLength for value {payload!r}")

    if isinstance(schema_type, str) and schema_type == "object":
        required = schema.get("required") or []
        if isinstance(required, list):
            for k in required:
                if isinstance(k, str) and k not in payload:
                    errors.append(f"{path}: missing required key {k!r}")
        props = schema.get("properties") or {}
        if isinstance(props, dict):
            for k, sub in props.items():
                if k in payload and isinstance(sub, dict):
                    errors.extend(_schema_validate(payload[k], sub, f"{path}.{k}", root_schema=root_schema))
            if schema.get("additionalProperties") is False:
                allowed = set(props.keys())
                extra = set(payload.keys()) - allowed
                if extra:
                    errors.append(f"{path}: unexpected properties {sorted(extra)}")

    if isinstance(schema_type, str) and schema_type == "array":
        items = schema.get("items")
        if isinstance(items, dict):
            for i, item in enumerate(payload[:200]):
                errors.extend(_schema_validate(item, items, f"{path}[{i}]", root_schema=root_schema))
            if len(payload) > 200:
                errors.append(f"{path}: array too long for v0 validator (len={len(payload)})")

    return errors


def _schema_for_json_path(repo_root: Path, rel_path: str) -> Path | None:
    rel_norm = str(rel_path).replace("\\", "/")
    name = Path(rel_norm).name
    if name == "manifest.json":
        return repo_root / "specs" / "artifact_manifest.schema.json"
    if name == "summary.json":
        return repo_root / "specs" / "artifact_summary.schema.json"
    if name == "analysis.json":
        return repo_root / "specs" / "artifact_analysis.schema.json"
    if rel_norm.startswith("knowledge_base/_index/") and name == "kb_index.json":
        return repo_root / "specs" / "kb_index.schema.json"
    if rel_norm.endswith("/literature_survey/survey.json"):
        return repo_root / "specs" / "literature_survey.schema.json"
    if rel_norm.endswith("/kb_profile/kb_profile.json"):
        return repo_root / "specs" / "kb_profile.schema.json"
    if "/quality_metrics/" in rel_norm and rel_norm.endswith(".json"):
        return repo_root / "specs" / "run_quality_metrics.schema.json"
    return None


def run_eval_case(case_dir: Path, repo_root: Path) -> CaseResult:
    case_path = case_dir / "case.json"
    case = read_json(case_path)
    case_id = str(case.get("case_id") or case_dir.name)
    workflow = str(case.get("workflow") or "custom")
    acceptance = case.get("acceptance") or {}

    ok = True
    messages: list[str] = []

    # Case schema validation (v0 subset).
    try:
        schema = read_json(repo_root / "specs" / "eval_case.schema.json")
        schema_errors = _schema_validate(case, schema, "case", root_schema=schema)
        if schema_errors:
            ok = False
            messages.append("case.json schema validation failed:")
            messages.extend([f"- {e}" for e in schema_errors[:10]])
    except Exception as e:
        ok = False
        messages.append(f"case.json schema validation error: {e}")

    required_paths = acceptance.get("required_paths_exist") or []
    if not isinstance(required_paths, list):
        required_paths = []
        ok = False
        messages.append("acceptance.required_paths_exist must be a list")
    for rel in required_paths:
        p = repo_root / str(rel)
        if not p.exists():
            ok = False
            messages.append(f"missing required path: {rel}")
            continue
        # Schema validation for common artifact JSON files.
        schema_path = _schema_for_json_path(repo_root, str(rel))
        if schema_path is not None and schema_path.exists() and p.is_file():
            try:
                payload = read_json(p)
                schema = read_json(schema_path)
                schema_errors = _schema_validate(payload, schema, f"{rel}", root_schema=schema)
                if schema_errors:
                    ok = False
                    messages.append(f"schema validation failed for {rel}:")
                    messages.extend([f"- {e}" for e in schema_errors[:10]])
            except Exception as e:
                ok = False
                messages.append(f"schema validation error for {rel}: {e}")

    required_fields = acceptance.get("reading_note_required_fields") or []
    if required_fields:
        note_path = _resolve_note_path(repo_root, case, required_paths)
        if note_path is None:
            ok = False
            messages.append("could not resolve reading note path (set inputs.refkey or include a .md in required_paths_exist)")
        elif not note_path.exists():
            ok = False
            messages.append(f"reading note missing: {note_path.relative_to(repo_root)}")
        else:
            text = note_path.read_text(encoding="utf-8")
            for needle in required_fields:
                if str(needle) not in text:
                    ok = False
                    messages.append(f"reading note missing required field: {needle}")

    numeric_checks = acceptance.get("json_numeric_checks") or []
    if numeric_checks:
        if not isinstance(numeric_checks, list):
            ok = False
            messages.append("acceptance.json_numeric_checks must be a list")
        else:
            for idx, check in enumerate(numeric_checks):
                if not isinstance(check, dict):
                    ok = False
                    messages.append(f"json_numeric_checks[{idx}] must be an object")
                    continue
                rel_path = check.get("path")
                pointer = check.get("pointer")
                if not rel_path or not pointer:
                    ok = False
                    messages.append(f"json_numeric_checks[{idx}] requires 'path' and 'pointer'")
                    continue
                p = repo_root / str(rel_path)
                if not p.exists():
                    ok = False
                    messages.append(f"json_numeric_checks[{idx}] missing file: {rel_path}")
                    continue
                try:
                    payload = read_json(p)
                except Exception as e:
                    ok = False
                    messages.append(f"json_numeric_checks[{idx}] could not read json: {rel_path} ({e})")
                    continue
                try:
                    v = _json_pointer_get(payload, str(pointer))
                except Exception as e:
                    ok = False
                    messages.append(f"json_numeric_checks[{idx}] missing pointer: {rel_path}{pointer} ({e})")
                    continue

                if isinstance(v, bool) or not isinstance(v, (int, float)):
                    ok = False
                    messages.append(
                        f"json_numeric_checks[{idx}] value is not numeric: {rel_path}{pointer} ({type(v).__name__})"
                    )
                    continue

                # thresholds
                if "max_abs" in check:
                    lim = float(check["max_abs"])
                    if abs(float(v)) > lim:
                        ok = False
                        messages.append(f"json_numeric_checks[{idx}] abs({v}) > {lim} at {rel_path}{pointer}")
                if "max" in check:
                    lim = float(check["max"])
                    if float(v) > lim:
                        ok = False
                        messages.append(f"json_numeric_checks[{idx}] {v} > {lim} at {rel_path}{pointer}")
                if "min" in check:
                    lim = float(check["min"])
                    if float(v) < lim:
                        ok = False
                        messages.append(f"json_numeric_checks[{idx}] {v} < {lim} at {rel_path}{pointer}")

    value_checks = acceptance.get("json_value_checks") or []
    if value_checks:
        if not isinstance(value_checks, list):
            ok = False
            messages.append("acceptance.json_value_checks must be a list")
        else:
            for idx, check in enumerate(value_checks):
                if not isinstance(check, dict):
                    ok = False
                    messages.append(f"json_value_checks[{idx}] must be an object")
                    continue
                rel_path = check.get("path")
                pointer = check.get("pointer")
                if not rel_path or not pointer:
                    ok = False
                    messages.append(f"json_value_checks[{idx}] requires 'path' and 'pointer'")
                    continue
                p = repo_root / str(rel_path)
                if not p.exists():
                    ok = False
                    messages.append(f"json_value_checks[{idx}] missing file: {rel_path}")
                    continue
                try:
                    payload = read_json(p)
                except Exception as e:
                    ok = False
                    messages.append(f"json_value_checks[{idx}] could not read json: {rel_path} ({e})")
                    continue
                try:
                    v = _json_pointer_get(payload, str(pointer))
                except Exception as e:
                    ok = False
                    messages.append(f"json_value_checks[{idx}] missing pointer: {rel_path}{pointer} ({e})")
                    continue

                expected_type = check.get("type")
                if expected_type is not None:
                    if not isinstance(expected_type, str):
                        ok = False
                        messages.append(f"json_value_checks[{idx}] type must be a string at {rel_path}{pointer}")
                    else:
                        t = expected_type.strip()
                        if t and not _schema_type_ok(v, t):
                            ok = False
                            messages.append(
                                f"json_value_checks[{idx}] expected type {t}, got {type(v).__name__} at {rel_path}{pointer}"
                            )

                if "equals" in check:
                    expected = check.get("equals")
                    if v != expected:
                        ok = False
                        messages.append(f"json_value_checks[{idx}] expected {expected!r}, got {v!r} at {rel_path}{pointer}")
                if "expected" in check and "equals" not in check:
                    expected = check.get("expected")
                    if v != expected:
                        ok = False
                        messages.append(f"json_value_checks[{idx}] expected {expected!r}, got {v!r} at {rel_path}{pointer}")

                if "contains" in check:
                    needle = check.get("contains")
                    if not isinstance(needle, str):
                        ok = False
                        messages.append(f"json_value_checks[{idx}] contains must be a string at {rel_path}{pointer}")
                    elif not isinstance(v, str):
                        ok = False
                        messages.append(f"json_value_checks[{idx}] value is not string for contains at {rel_path}{pointer}")
                    elif needle not in v:
                        ok = False
                        messages.append(
                            f"json_value_checks[{idx}] expected substring {needle!r} missing in {v!r} at {rel_path}{pointer}"
                        )

                if "min_length" in check:
                    try:
                        lim = int(check.get("min_length"))
                    except Exception:
                        ok = False
                        messages.append(f"json_value_checks[{idx}] min_length must be integer at {rel_path}{pointer}")
                        lim = None
                    if lim is not None:
                        if isinstance(v, (str, list)):
                            if len(v) < lim:
                                ok = False
                                messages.append(
                                    f"json_value_checks[{idx}] length {len(v)} < {lim} at {rel_path}{pointer}"
                                )
                        else:
                            ok = False
                            messages.append(
                                f"json_value_checks[{idx}] value is not string/list for min_length at {rel_path}{pointer}"
                            )

    text_checks = acceptance.get("text_contains_checks") or []
    if text_checks:
        if not isinstance(text_checks, list):
            ok = False
            messages.append("acceptance.text_contains_checks must be a list")
        else:
            for idx, check in enumerate(text_checks):
                if not isinstance(check, dict):
                    ok = False
                    messages.append(f"text_contains_checks[{idx}] must be an object")
                    continue
                rel_path = check.get("path")
                needles = check.get("contains") or []
                if not rel_path:
                    ok = False
                    messages.append(f"text_contains_checks[{idx}] requires 'path'")
                    continue
                if not isinstance(needles, list):
                    ok = False
                    messages.append(f"text_contains_checks[{idx}].contains must be a list")
                    continue
                p = repo_root / str(rel_path)
                if not p.exists() or not p.is_file():
                    ok = False
                    messages.append(f"text_contains_checks[{idx}] missing file: {rel_path}")
                    continue
                try:
                    text = p.read_text(encoding="utf-8", errors="replace")
                except Exception as e:
                    ok = False
                    messages.append(f"text_contains_checks[{idx}] could not read file: {rel_path} ({e})")
                    continue
                for j, needle in enumerate(needles):
                    if not isinstance(needle, str):
                        ok = False
                        messages.append(f"text_contains_checks[{idx}].contains[{j}] must be a string")
                        continue
                    if needle not in text:
                        ok = False
                        messages.append(f"text_contains_checks[{idx}] missing substring {needle!r} in {rel_path}")

    zip_checks = acceptance.get("zip_contains_checks") or []
    if zip_checks:
        if not isinstance(zip_checks, list):
            ok = False
            messages.append("acceptance.zip_contains_checks must be a list")
        else:
            for idx, check in enumerate(zip_checks):
                if not isinstance(check, dict):
                    ok = False
                    messages.append(f"zip_contains_checks[{idx}] must be an object")
                    continue
                rel_path = check.get("path")
                required = check.get("required_entries") or []
                if not rel_path:
                    ok = False
                    messages.append(f"zip_contains_checks[{idx}] requires 'path'")
                    continue
                if not isinstance(required, list):
                    ok = False
                    messages.append(f"zip_contains_checks[{idx}].required_entries must be a list")
                    continue
                p = repo_root / str(rel_path)
                if not p.exists() or not p.is_file():
                    ok = False
                    messages.append(f"zip_contains_checks[{idx}] missing zip file: {rel_path}")
                    continue
                try:
                    with zipfile.ZipFile(p, "r") as zf:
                        names = {n.replace("\\", "/") for n in zf.namelist()}
                except Exception as e:
                    ok = False
                    messages.append(f"zip_contains_checks[{idx}] could not read zip: {rel_path} ({e})")
                    continue
                for j, ent in enumerate(required):
                    if not isinstance(ent, str):
                        ok = False
                        messages.append(f"zip_contains_checks[{idx}].required_entries[{j}] must be a string")
                        continue
                    needle = ent.replace("\\", "/").strip()
                    if needle not in names:
                        ok = False
                        messages.append(f"zip_contains_checks[{idx}] missing entry {needle!r} in {rel_path}")

    if ok:
        messages.append("PASS")
    return CaseResult(case_id=case_id, workflow=workflow, ok=ok, messages=messages)


def run_all_evals(
    *,
    repo_root: Path,
    cases_root: Path,
    selected_case_ids: set[str] | None = None,
) -> list[CaseResult]:
    results: list[CaseResult] = []
    for case_dir in sorted(cases_root.iterdir()):
        if not case_dir.is_dir():
            continue
        case_path = case_dir / "case.json"
        if not case_path.exists():
            continue
        case = read_json(case_path)
        case_id = str(case.get("case_id") or case_dir.name)
        if selected_case_ids and case_id not in selected_case_ids:
            continue
        results.append(run_eval_case(case_dir, repo_root=repo_root))
    return results


def write_eval_artifacts(
    *,
    repo_root: Path,
    tag: str,
    results: list[CaseResult],
) -> dict[str, str]:
    created_at = utc_now_iso()
    out_dir = repo_root / "artifacts" / "runs" / tag / "evals"
    manifest_path = out_dir / "manifest.json"
    summary_path = out_dir / "summary.json"
    analysis_path = out_dir / "analysis.json"
    report_path = out_dir / "report.md"

    passed = sum(1 for r in results if r.ok)
    failed = sum(1 for r in results if not r.ok)

    manifest: dict[str, Any] = {
        "schema_version": 1,
        "created_at": created_at,
        "command": "python3 scripts/run_evals.py",
        "cwd": manifest_cwd(repo_root=repo_root, cwd=repo_root),
        "params": {"tag": tag},
        "versions": {"python": os.sys.version.split()[0]},
        "outputs": [
            os.fspath(manifest_path.relative_to(repo_root)),
            os.fspath(summary_path.relative_to(repo_root)),
            os.fspath(analysis_path.relative_to(repo_root)),
            os.fspath(report_path.relative_to(repo_root)),
        ],
    }
    git_meta = try_get_git_metadata(repo_root)
    if git_meta:
        manifest["git"] = git_meta

    summary: dict[str, Any] = {
        "schema_version": 1,
        "created_at": created_at,
        "definitions": {"kind": "eval_run"},
        "stats": {"passed": passed, "failed": failed, "total": len(results)},
        "outputs": {
            "passed_cases": [r.case_id for r in results if r.ok],
            "failed_cases": [r.case_id for r in results if not r.ok],
        },
    }

    analysis: dict[str, Any] = {
        "schema_version": 1,
        "created_at": created_at,
        "inputs": {"tag": tag},
        "results": {
            "ok": failed == 0,
            "cases": [
                {
                    "case_id": r.case_id,
                    "workflow": r.workflow,
                    "ok": r.ok,
                    "messages": r.messages,
                }
                for r in results
            ],
        },
    }

    write_json(manifest_path, manifest)
    write_json(summary_path, summary)
    write_json(analysis_path, analysis)
    report_rel = write_artifact_report(repo_root=repo_root, artifact_dir=out_dir, manifest=manifest, summary=summary, analysis=analysis)
    return {
        "manifest": os.fspath(manifest_path.relative_to(repo_root)),
        "summary": os.fspath(summary_path.relative_to(repo_root)),
        "analysis": os.fspath(analysis_path.relative_to(repo_root)),
        "report": report_rel,
    }
