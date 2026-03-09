from __future__ import annotations

import json
import re
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from typing import Any


_RUN_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")
_PHASE_ID_RE = re.compile(r"^[a-z][a-z0-9_]*$")
_PARAM_NAME_RE = re.compile(r"^[a-z][a-z0-9_]*$")
_JSON_PTR_RE = re.compile(r"^#(/([^~/]|~[01])+)+$")
_PARAM_REF_RE = re.compile(r"\$\{([a-z][a-z0-9_]*)\}")


def _is_safe_relpath_posix(path: str) -> bool:
    """Return True if `path` is a safe POSIX-ish relative path (no abs, no '..')."""
    s = str(path).strip().replace("\\", "/")
    if not s:
        return False
    if s.startswith("/"):
        return False
    try:
        pp = PurePosixPath(s)
    except Exception:  # CONTRACT-EXEMPT: CODE-01.5 deny-by-default path validation
        return False
    if pp.is_absolute():
        return False
    parts = [p for p in pp.parts if p not in {"", "."}]
    if any(p == ".." for p in parts):
        return False
    return True


def _extra_keys(obj: dict[str, Any], allowed: set[str]) -> list[str]:
    return sorted([k for k in obj.keys() if k not in allowed])


def _json_pointer_get(payload: Any, pointer: str) -> Any:
    """Resolve RFC 6901 JSON Pointer in URI fragment form (e.g. #/a/b/0)."""
    if not isinstance(pointer, str) or not pointer.strip():
        raise KeyError("empty pointer")
    s = pointer.strip()
    if s.startswith("#"):
        s = s[1:]
    if not s:
        return payload
    if not s.startswith("/"):
        raise KeyError("pointer must start with '#/'")

    def unescape(tok: str) -> str:
        return tok.replace("~1", "/").replace("~0", "~")

    tokens = [unescape(t) for t in s.lstrip("/").split("/") if t != ""]
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


def _schema_bool(v: Any) -> bool:
    return isinstance(v, bool)


def _schema_int(v: Any) -> bool:
    return isinstance(v, int) and not isinstance(v, bool)


def _schema_number(v: Any) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool)


def _schema_string(v: Any) -> bool:
    return isinstance(v, str)


def _coerce_param_value(raw: Any, *, typ: str) -> Any:
    if typ == "string":
        if not isinstance(raw, str):
            return str(raw)
        return raw
    if typ == "boolean":
        if isinstance(raw, bool):
            return raw
        if isinstance(raw, str):
            s = raw.strip().lower()
            if s in {"1", "true", "yes", "y", "on"}:
                return True
            if s in {"0", "false", "no", "n", "off"}:
                return False
        raise ValueError(f"invalid boolean value: {raw!r}")
    if typ == "integer":
        if _schema_int(raw):
            return raw
        if isinstance(raw, str):
            s = raw.strip()
            if not s:
                raise ValueError("empty integer string")
            return int(s, 10)
        raise ValueError(f"invalid integer value: {raw!r}")
    if typ == "number":
        if _schema_number(raw):
            return float(raw)
        if isinstance(raw, str):
            s = raw.strip()
            if not s:
                raise ValueError("empty number string")
            return float(s)
        raise ValueError(f"invalid number value: {raw!r}")
    raise ValueError(f"unknown parameter type: {typ!r}")


@dataclass(frozen=True)
class RunCardV2:
    raw: dict[str, Any]
    normalized: dict[str, Any]
    param_values: dict[str, Any]


def load_run_card_v2(path: Path) -> dict[str, Any]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(payload, dict):
        raise ValueError("run_card v2 JSON must be an object")
    return payload


def normalize_and_validate_run_card_v2(
    payload: dict[str, Any],
    *,
    run_id_override: str | None = None,
    param_overrides: dict[str, Any] | None = None,
) -> RunCardV2:
    """Validate a run_card v2 payload and return a normalized view + resolved parameters.

    Strict-by-default:
    - Unknown fields are errors.
    - Parameter references in argv must be declared and resolvable (default or override).
    """
    if not isinstance(payload, dict):
        raise TypeError("run_card payload must be an object")

    allowed_top = {
        "schema_version",
        "run_id",
        "workflow_id",
        "title",
        "description",
        "parameters",
        "on_failure",
        "phases",
        "headline_numbers",
        "acceptance",
    }
    extra = _extra_keys(payload, allowed_top)
    if extra:
        raise ValueError(f"run_card: unexpected top-level fields: {extra}")

    schema_version = payload.get("schema_version")
    if not _schema_int(schema_version) or int(schema_version) != 2:
        raise ValueError("run_card.schema_version must be integer const 2")

    run_id_raw = payload.get("run_id")
    if not _schema_string(run_id_raw) or not run_id_raw.strip() or not _RUN_ID_RE.match(run_id_raw.strip()):
        raise ValueError("run_card.run_id must be a safe non-empty id string (1-128 chars)")

    workflow_id = payload.get("workflow_id")
    if workflow_id != "computation":
        raise ValueError("run_card.workflow_id must be 'computation'")

    title = payload.get("title")
    if not _schema_string(title) or not title.strip():
        raise ValueError("run_card.title must be a non-empty string")

    on_failure = payload.get("on_failure", "fail-fast")
    if on_failure not in {"fail-fast", "continue"}:
        raise ValueError("run_card.on_failure must be 'fail-fast' or 'continue'")

    params_def = payload.get("parameters") if payload.get("parameters") is not None else {}
    if not isinstance(params_def, dict):
        raise ValueError("run_card.parameters must be an object if present")

    normalized_params_def: dict[str, dict[str, Any]] = {}
    for name, d in params_def.items():
        if not isinstance(name, str) or not name or not _PARAM_NAME_RE.match(name):
            raise ValueError(f"run_card.parameters: invalid parameter name: {name!r}")
        if not isinstance(d, dict):
            raise ValueError(f"run_card.parameters.{name}: must be an object")
        allowed_param = {"type", "default", "description"}
        extra_p = _extra_keys(d, allowed_param)
        if extra_p:
            raise ValueError(f"run_card.parameters.{name}: unexpected fields: {extra_p}")
        typ = d.get("type")
        if typ not in {"integer", "number", "string", "boolean"}:
            raise ValueError(f"run_card.parameters.{name}.type must be integer/number/string/boolean")
        if "default" in d:
            try:
                _coerce_param_value(d.get("default"), typ=str(typ))
            except Exception as e:
                raise ValueError(f"run_card.parameters.{name}.default invalid for type {typ}: {e}") from e
        if "description" in d and not isinstance(d.get("description"), str):
            raise ValueError(f"run_card.parameters.{name}.description must be a string if present")
        normalized_params_def[name] = dict(d)

    # Resolve param values: defaults first, then overrides.
    param_values: dict[str, Any] = {}
    for name, d in normalized_params_def.items():
        if "default" in d:
            param_values[name] = _coerce_param_value(d.get("default"), typ=str(d.get("type")))

    overrides = param_overrides or {}
    if not isinstance(overrides, dict):
        raise ValueError("param_overrides must be an object")
    for name, raw in overrides.items():
        if name not in normalized_params_def:
            raise ValueError(f"unknown parameter override: {name!r} (not declared in run_card.parameters)")
        typ = str(normalized_params_def[name].get("type"))
        param_values[name] = _coerce_param_value(raw, typ=typ)

    phases = payload.get("phases")
    if not isinstance(phases, list) or not phases:
        raise ValueError("run_card.phases must be a non-empty array")

    seen_phase_ids: set[str] = set()
    normalized_phases: list[dict[str, Any]] = []
    for idx, ph in enumerate(phases):
        if not isinstance(ph, dict):
            raise ValueError(f"run_card.phases[{idx}] must be an object")
        allowed_phase = {
            "phase_id",
            "description",
            "inputs",
            "backend",
            "outputs",
            "gates",
            "depends_on",
            "retries",
        }
        extra_ph = _extra_keys(ph, allowed_phase)
        if extra_ph:
            raise ValueError(f"run_card.phases[{idx}]: unexpected fields: {extra_ph}")

        phase_id = ph.get("phase_id")
        if not isinstance(phase_id, str) or not phase_id.strip() or not _PHASE_ID_RE.match(phase_id.strip()):
            raise ValueError(f"run_card.phases[{idx}].phase_id invalid (expected ^[a-z][a-z0-9_]*$)")
        phase_id = phase_id.strip()
        if phase_id in seen_phase_ids:
            raise ValueError(f"duplicate phase_id: {phase_id}")
        seen_phase_ids.add(phase_id)

        if "description" in ph and ph.get("description") is not None and not isinstance(ph.get("description"), str):
            raise ValueError(f"run_card.phases[{idx}].description must be a string if present")

        inputs = ph.get("inputs", [])
        if not isinstance(inputs, list):
            raise ValueError(f"run_card.phases[{idx}].inputs must be an array if present")
        inputs_norm: list[str] = []
        seen_in: set[str] = set()
        for p in inputs:
            if not isinstance(p, str) or not p.strip() or not _is_safe_relpath_posix(p):
                raise ValueError(f"run_card.phases[{idx}].inputs contains invalid path: {p!r}")
            s = p.strip().replace("\\", "/")
            if s in seen_in:
                continue
            seen_in.add(s)
            inputs_norm.append(s)

        outputs = ph.get("outputs")
        if not isinstance(outputs, list) or not outputs:
            raise ValueError(f"run_card.phases[{idx}].outputs must be a non-empty array")
        outputs_norm: list[str] = []
        seen_out: set[str] = set()
        for p in outputs:
            if not isinstance(p, str) or not p.strip() or not _is_safe_relpath_posix(p):
                raise ValueError(f"run_card.phases[{idx}].outputs contains invalid path: {p!r}")
            s = p.strip().replace("\\", "/")
            if s in seen_out:
                continue
            seen_out.add(s)
            outputs_norm.append(s)

        gates = ph.get("gates", [])
        if not isinstance(gates, list):
            raise ValueError(f"run_card.phases[{idx}].gates must be an array if present")
        gates_norm: list[str] = []
        seen_gate: set[str] = set()
        for g in gates:
            if not isinstance(g, str) or not g.strip():
                raise ValueError(f"run_card.phases[{idx}].gates contains invalid gate: {g!r}")
            s = g.strip()
            if s in seen_gate:
                continue
            seen_gate.add(s)
            gates_norm.append(s)

        depends_on = ph.get("depends_on", [])
        if not isinstance(depends_on, list):
            raise ValueError(f"run_card.phases[{idx}].depends_on must be an array if present")
        deps_norm: list[str] = []
        seen_dep: set[str] = set()
        for d in depends_on:
            if not isinstance(d, str) or not d.strip() or not _PHASE_ID_RE.match(d.strip()):
                raise ValueError(f"run_card.phases[{idx}].depends_on contains invalid phase_id: {d!r}")
            s = d.strip()
            if s in seen_dep:
                continue
            seen_dep.add(s)
            deps_norm.append(s)

        retries = ph.get("retries", 0)
        if not _schema_int(retries) or int(retries) < 0:
            raise ValueError(f"run_card.phases[{idx}].retries must be an integer >= 0 if present")

        backend = ph.get("backend")
        if not isinstance(backend, dict):
            raise ValueError(f"run_card.phases[{idx}].backend must be an object")
        allowed_backend = {"kind", "argv", "cwd", "timeout_seconds"}
        extra_be = _extra_keys(backend, allowed_backend)
        if extra_be:
            raise ValueError(f"run_card.phases[{idx}].backend: unexpected fields: {extra_be}")
        if backend.get("kind") != "shell":
            raise ValueError(f"run_card.phases[{idx}].backend.kind must be 'shell'")
        argv = backend.get("argv")
        if not isinstance(argv, list) or not argv or not all(isinstance(x, str) and x.strip() for x in argv):
            raise ValueError(f"run_card.phases[{idx}].backend.argv must be a non-empty string array")
        cwd = backend.get("cwd", ".")
        if not isinstance(cwd, str) or not cwd.strip() or not _is_safe_relpath_posix(cwd):
            raise ValueError(f"run_card.phases[{idx}].backend.cwd must be a safe relative path string")
        timeout = backend.get("timeout_seconds")
        if timeout is not None:
            if not _schema_int(timeout) or int(timeout) < 1:
                raise ValueError(f"run_card.phases[{idx}].backend.timeout_seconds must be integer >= 1 if present")

        normalized_phases.append(
            {
                "phase_id": phase_id,
                "description": ph.get("description"),
                "inputs": inputs_norm,
                "backend": {
                    "kind": "shell",
                    "argv": [str(x) for x in argv],
                    "cwd": cwd.strip().replace("\\", "/"),
                    "timeout_seconds": int(timeout) if timeout is not None else None,
                },
                "outputs": outputs_norm,
                "gates": gates_norm,
                "depends_on": deps_norm,
                "retries": int(retries),
            }
        )

    # Dependency references must exist.
    for ph in normalized_phases:
        for d in ph.get("depends_on", []):
            if d not in seen_phase_ids:
                raise ValueError(f"phase {ph['phase_id']}: depends_on references unknown phase_id: {d}")

    # headline_numbers and acceptance are optional, but if present must validate.
    headline_numbers = payload.get("headline_numbers")
    normalized_headline_numbers: dict[str, Any] | None = None
    if headline_numbers is not None:
        if not isinstance(headline_numbers, dict):
            raise ValueError("run_card.headline_numbers must be an object if present")
        allowed_hn = {"source", "extract"}
        extra_hn = _extra_keys(headline_numbers, allowed_hn)
        if extra_hn:
            raise ValueError(f"run_card.headline_numbers: unexpected fields: {extra_hn}")
        source = headline_numbers.get("source")
        if not isinstance(source, str) or not source.strip() or not _is_safe_relpath_posix(source):
            raise ValueError("run_card.headline_numbers.source must be a safe relative path string")
        extract = headline_numbers.get("extract")
        if not isinstance(extract, list) or not extract:
            raise ValueError("run_card.headline_numbers.extract must be a non-empty array")
        out_extract: list[dict[str, Any]] = []
        for i, ex in enumerate(extract):
            if not isinstance(ex, dict):
                raise ValueError(f"run_card.headline_numbers.extract[{i}] must be an object")
            allowed_ex = {"pointer", "label", "tier"}
            extra_ex = _extra_keys(ex, allowed_ex)
            if extra_ex:
                raise ValueError(f"run_card.headline_numbers.extract[{i}]: unexpected fields: {extra_ex}")
            ptr = ex.get("pointer")
            if not isinstance(ptr, str) or not _JSON_PTR_RE.match(ptr.strip()):
                raise ValueError(f"run_card.headline_numbers.extract[{i}].pointer must be RFC6901 '#/..' form")
            label = ex.get("label")
            if not isinstance(label, str) or not label.strip():
                raise ValueError(f"run_card.headline_numbers.extract[{i}].label must be non-empty string")
            tier = ex.get("tier")
            if tier not in {"T1", "T2", "T3"}:
                raise ValueError(f"run_card.headline_numbers.extract[{i}].tier must be T1/T2/T3")
            out_extract.append({"pointer": ptr.strip(), "label": label.strip(), "tier": str(tier)})
        normalized_headline_numbers = {"source": source.strip().replace("\\", "/"), "extract": out_extract}

    acceptance = payload.get("acceptance")
    normalized_acceptance: dict[str, Any] | None = None
    if acceptance is not None:
        if not isinstance(acceptance, dict):
            raise ValueError("run_card.acceptance must be an object if present")
        allowed_acc = {"json_numeric_checks"}
        extra_acc = _extra_keys(acceptance, allowed_acc)
        if extra_acc:
            raise ValueError(f"run_card.acceptance: unexpected fields: {extra_acc}")
        checks = acceptance.get("json_numeric_checks")
        if not isinstance(checks, list) or not checks:
            raise ValueError("run_card.acceptance.json_numeric_checks must be a non-empty array")
        out_checks: list[dict[str, Any]] = []
        for i, chk in enumerate(checks):
            if not isinstance(chk, dict):
                raise ValueError(f"run_card.acceptance.json_numeric_checks[{i}] must be an object")
            allowed_chk = {"path", "pointer", "min", "max"}
            extra_chk = _extra_keys(chk, allowed_chk)
            if extra_chk:
                raise ValueError(f"run_card.acceptance.json_numeric_checks[{i}]: unexpected fields: {extra_chk}")
            path = chk.get("path")
            if not isinstance(path, str) or not path.strip() or not _is_safe_relpath_posix(path):
                raise ValueError(f"run_card.acceptance.json_numeric_checks[{i}].path must be safe relative path string")
            ptr = chk.get("pointer")
            if not isinstance(ptr, str) or not _JSON_PTR_RE.match(ptr.strip()):
                raise ValueError(f"run_card.acceptance.json_numeric_checks[{i}].pointer must be RFC6901 '#/..' form")
            mn = chk.get("min")
            mx = chk.get("max")
            if mn is None and mx is None:
                raise ValueError(f"run_card.acceptance.json_numeric_checks[{i}] requires min or max")
            if mn is not None and not _schema_number(mn):
                raise ValueError(f"run_card.acceptance.json_numeric_checks[{i}].min must be a number if present")
            if mx is not None and not _schema_number(mx):
                raise ValueError(f"run_card.acceptance.json_numeric_checks[{i}].max must be a number if present")
            out_checks.append(
                {
                    "path": path.strip().replace("\\", "/"),
                    "pointer": ptr.strip(),
                    "min": float(mn) if mn is not None else None,
                    "max": float(mx) if mx is not None else None,
                }
            )
        normalized_acceptance = {"json_numeric_checks": out_checks}

    # Verify that any parameter reference in argv is declared and resolvable.
    for ph in normalized_phases:
        argv = ph.get("backend", {}).get("argv") or []
        for arg in argv:
            for m in _PARAM_REF_RE.finditer(str(arg)):
                name = m.group(1)
                if name not in normalized_params_def:
                    raise ValueError(f"phase {ph['phase_id']}: argv references undeclared parameter: {name!r}")
                if name not in param_values:
                    raise ValueError(f"phase {ph['phase_id']}: argv references parameter without value/default: {name!r}")

    # Normalize the whole card for engine consumption.
    eff_run_id = str(run_id_override).strip() if run_id_override is not None else str(run_id_raw).strip()
    if not eff_run_id or not _RUN_ID_RE.match(eff_run_id):
        raise ValueError(f"run_id_override invalid: {eff_run_id!r}")

    normalized: dict[str, Any] = {
        "schema_version": 2,
        "run_id": eff_run_id,
        "workflow_id": "computation",
        "title": str(title).strip(),
        "description": payload.get("description") if isinstance(payload.get("description"), str) else None,
        "parameters": normalized_params_def,
        "param_values": param_values,
        "on_failure": on_failure,
        "phases": normalized_phases,
        "headline_numbers": normalized_headline_numbers,
        "acceptance": normalized_acceptance,
    }
    return RunCardV2(raw=dict(payload), normalized=normalized, param_values=param_values)


def expand_argv(
    argv: list[str],
    *,
    param_values: dict[str, Any],
    workspace_dir: Path,
) -> list[str]:
    """Apply ${param} substitution and resolve `phases/...` args to absolute workspace paths."""
    out: list[str] = []
    for raw in argv:
        s = str(raw)

        def repl(m: re.Match[str]) -> str:
            key = m.group(1)
            if key not in param_values:
                raise KeyError(key)
            v = param_values[key]
            if isinstance(v, bool):
                return "true" if v else "false"
            if isinstance(v, (int, float)) and not isinstance(v, bool):
                # Avoid scientific notation surprises for ints.
                return str(v)
            return str(v)

        try:
            s2 = _PARAM_REF_RE.sub(repl, s)
        except KeyError as e:
            raise ValueError(f"argv references missing parameter: {e}") from e

        # Special case: upstream outputs are addressed as phases/<id>/<path> relative to workspace.
        p = s2.replace("\\", "/").strip()
        if p.startswith("phases/") and _is_safe_relpath_posix(p):
            out.append(str((workspace_dir / p).resolve()))
        else:
            out.append(s2)
    return out


def extract_headline_numbers(
    *,
    workspace_dir: Path,
    headline_numbers: dict[str, Any],
) -> tuple[list[dict[str, Any]], list[str]]:
    """Return (headline_numbers_rows, errors)."""
    errors: list[str] = []
    rows: list[dict[str, Any]] = []

    src_rel = headline_numbers.get("source")
    if not isinstance(src_rel, str) or not src_rel.strip():
        return [], ["headline_numbers.source missing/invalid"]
    src_rel = src_rel.strip().replace("\\", "/")
    if not _is_safe_relpath_posix(src_rel):
        return [], [f"headline_numbers.source is not a safe relative path: {src_rel!r}"]
    src_path = workspace_dir / src_rel
    if not src_path.exists():
        return [], [f"headline_numbers.source missing: {src_rel}"]
    try:
        payload = json.loads(src_path.read_text(encoding="utf-8"))
    except Exception as e:
        return [], [f"failed to parse headline_numbers.source JSON: {src_rel}: {e}"]

    extract = headline_numbers.get("extract")
    if not isinstance(extract, list) or not extract:
        return [], ["headline_numbers.extract missing/invalid"]

    for idx, ex in enumerate(extract):
        if not isinstance(ex, dict):
            errors.append(f"headline_numbers.extract[{idx}] not an object")
            continue
        ptr = ex.get("pointer")
        label = ex.get("label")
        tier = ex.get("tier")
        if not isinstance(ptr, str) or not _JSON_PTR_RE.match(ptr.strip()):
            errors.append(f"headline_numbers.extract[{idx}].pointer invalid")
            continue
        if not isinstance(label, str) or not label.strip():
            errors.append(f"headline_numbers.extract[{idx}].label invalid")
            continue
        if tier not in {"T1", "T2", "T3"}:
            errors.append(f"headline_numbers.extract[{idx}].tier invalid")
            continue
        try:
            v = _json_pointer_get(payload, str(ptr).strip())
        except Exception as e:
            errors.append(f"headline_numbers.extract[{idx}] missing pointer: {src_rel}{ptr} ({e})")
            continue

        rows.append(
            {
                "label": str(label).strip(),
                "tier": str(tier),
                "value": v,
                "source": src_rel,
                "pointer": str(ptr).strip(),
            }
        )
    return rows, errors


def evaluate_acceptance_json_numeric_checks(
    *,
    workspace_dir: Path,
    acceptance: dict[str, Any],
) -> tuple[list[dict[str, Any]], list[str]]:
    """Return (check_rows, errors)."""
    errors: list[str] = []
    rows: list[dict[str, Any]] = []

    checks = acceptance.get("json_numeric_checks")
    if not isinstance(checks, list) or not checks:
        return [], ["acceptance.json_numeric_checks missing/invalid"]

    for idx, chk in enumerate(checks):
        if not isinstance(chk, dict):
            errors.append(f"acceptance.json_numeric_checks[{idx}] not an object")
            continue
        rel = chk.get("path")
        ptr = chk.get("pointer")
        mn = chk.get("min")
        mx = chk.get("max")
        if not isinstance(rel, str) or not rel.strip() or not _is_safe_relpath_posix(rel):
            errors.append(f"acceptance.json_numeric_checks[{idx}].path invalid")
            continue
        if not isinstance(ptr, str) or not _JSON_PTR_RE.match(ptr.strip()):
            errors.append(f"acceptance.json_numeric_checks[{idx}].pointer invalid")
            continue
        rel = rel.strip().replace("\\", "/")
        p = workspace_dir / rel
        if not p.exists():
            errors.append(f"acceptance.json_numeric_checks[{idx}] missing file: {rel}")
            continue
        try:
            payload = json.loads(p.read_text(encoding="utf-8"))
        except Exception as e:
            errors.append(f"acceptance.json_numeric_checks[{idx}] failed to parse JSON: {rel}: {e}")
            continue
        try:
            v = _json_pointer_get(payload, ptr.strip())
        except Exception as e:
            errors.append(f"acceptance.json_numeric_checks[{idx}] missing pointer: {rel}{ptr} ({e})")
            continue
        if not isinstance(v, (int, float)) or isinstance(v, bool):
            errors.append(f"acceptance.json_numeric_checks[{idx}] value is not numeric: {rel}{ptr} ({type(v).__name__})")
            continue
        v_f = float(v)
        ok = True
        if mn is not None:
            try:
                if v_f < float(mn):
                    ok = False
            except Exception:  # CONTRACT-EXEMPT: CODE-01.5 intentional fallback
                ok = False
        if mx is not None:
            try:
                if v_f > float(mx):
                    ok = False
            except Exception:  # CONTRACT-EXEMPT: CODE-01.5 intentional fallback
                ok = False
        if not ok:
            errors.append(f"acceptance.json_numeric_checks[{idx}] out of range: {rel}{ptr} value={v_f}")

        rows.append(
            {
                "path": rel,
                "pointer": ptr.strip(),
                "value": v_f,
                "min": float(mn) if mn is not None else None,
                "max": float(mx) if mx is not None else None,
                "ok": bool(ok),
            }
        )

    return rows, errors

