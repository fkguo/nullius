#!/usr/bin/env python3
"""
Parameter-scan dependency gate (rules-file driven).

Goal:
- Catch common scan-semantics mistakes (e.g. scanning X but keeping a dependent Y fixed)
  *before* running expensive dual audits.
- Keep the engine generic: domain knowledge lives in a per-project rules file.

Inputs:
- Prefer --notes research_contract.md so we can:
  (a) find the Reproducibility Capsule, especially section G) "Sweep semantics"
  (b) auto-detect scan CSV + manifest JSON from capsule outputs
  (c) auto-find rules file in project root (unless explicitly set)

Rules file:
- JSON is dependency-free (recommended default): scan_dependency_rules.json
- YAML is also supported if PyYAML is installed: scan_dependency_rules.yaml / .yml

Exit codes:
  0  ok, or not applicable (no scan detected / no rules file found and --require-rules not set)
  1  dependency violations detected (fail-fast)
  2  input/config error (missing file, unreadable/invalid rules file, etc.)
"""

from __future__ import annotations

import argparse
import csv
import json
import re
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "lib"))

from team_config import load_team_config  # type: ignore

CAPSULE_START = "<!-- REPRO_CAPSULE_START -->"
CAPSULE_END = "<!-- REPRO_CAPSULE_END -->"


DEFAULT_RULES_BASENAMES = [
    "scan_dependency_rules.json",
    "scan_dependency_rules.yaml",
    "scan_dependency_rules.yml",
]


@dataclass(frozen=True)
class ScanArtifacts:
    csv_path: Path | None
    manifest_path: Path | None
    rules_path: Path | None
    capsule_g_section: str


def _extract_capsule(text: str) -> str | None:
    if CAPSULE_START not in text or CAPSULE_END not in text:
        return None
    a = text.index(CAPSULE_START) + len(CAPSULE_START)
    b = text.index(CAPSULE_END)
    capsule = text[a:b].strip()
    return capsule if capsule else ""


def _extract_section(markdown: str, heading_pattern: str) -> str:
    m = re.search(rf"^###\s+{heading_pattern}.*?$", markdown, flags=re.MULTILINE)
    if not m:
        return ""
    start = m.end()
    m2 = re.search(r"^###\s+", markdown[start:], flags=re.MULTILINE)
    end = start + (m2.start() if m2 else len(markdown[start:]))
    return markdown[start:end].strip()


def _parse_capsule_outputs(capsule: str) -> list[str]:
    sec = _extract_section(capsule, r"D\)\s+Expected outputs")
    if not sec:
        return []
    outs: list[str] = []
    for ln in sec.splitlines():
        m = re.match(r"^\s*-\s*(\S+)\s*$", ln)
        if m:
            outs.append(m.group(1))
    return outs


def _parse_rules_file_from_g_section(g_sec: str) -> str | None:
    """
    Optional convention (not mandatory):
      - Rules file: scan_dependency_rules.json
    """
    for ln in g_sec.splitlines():
        s = ln.strip()
        m = re.match(r"^(?:-\s*)?Rules file\s*\(?.*?\)?:\s*(\S+)\s*$", s, flags=re.IGNORECASE)
        if m:
            return m.group(1).strip()
        m2 = re.match(r"^(?:-\s*)?Rules file:\s*(\S+)\s*$", s, flags=re.IGNORECASE)
        if m2:
            return m2.group(1).strip()
    return None


def _parse_audit_override_from_g_section(g_sec: str) -> str:
    """
    Allow an explicit escape hatch recorded in the notebook, e.g.:
      - AUDIT_OVERRIDE: warn-only
      - AUDIT_OVERRIDE: disable-scan-dep
    """
    m = re.search(r"AUDIT_OVERRIDE\s*:\s*([A-Za-z0-9._-]+)", g_sec)
    return (m.group(1).strip().lower() if m else "")


def _parse_scanned_vars_from_g_section(g_sec: str) -> list[str]:
    """
    Heuristic parse of:
      Scanned variables: a in [..], b ...
    We only need variable *identifiers* to map to rule triggers.
    """
    line = ""
    for ln in g_sec.splitlines():
        if re.search(r"\bScanned variables\s*:", ln, flags=re.IGNORECASE):
            line = ln
            break
    if not line:
        return []
    # Extract after ':' and parse identifiers.
    after = line.split(":", 1)[1]
    toks = re.findall(r"[A-Za-z_][A-Za-z0-9_]*", after)
    # Deduplicate while preserving order.
    out: list[str] = []
    seen: set[str] = set()
    for t in toks:
        if t not in seen:
            seen.add(t)
            out.append(t)
    return out


def _guess_artifacts_from_capsule(capsule: str, project_root: Path) -> tuple[Path | None, Path | None]:
    outs = _parse_capsule_outputs(capsule)
    csv_path: Path | None = None
    manifest_path: Path | None = None

    for p in outs:
        path = Path(p)
        if not path.is_absolute():
            path = project_root / path
        if csv_path is None and path.suffix.lower() == ".csv" and path.exists():
            csv_path = path
        if (
            manifest_path is None
            and path.suffix.lower() == ".json"
            and "manifest" in path.name.lower()
            and path.exists()
        ):
            manifest_path = path

    if manifest_path is None:
        for p in outs:
            path = Path(p)
            if not path.is_absolute():
                path = project_root / path
            if path.suffix.lower() == ".json" and path.exists():
                manifest_path = path
                break

    return (csv_path, manifest_path)


def _find_rules_file(project_root: Path, capsule_g: str) -> Path | None:
    explicit = _parse_rules_file_from_g_section(capsule_g)
    if explicit:
        p = Path(explicit)
        if not p.is_absolute():
            p = project_root / p
        return p
    for bn in DEFAULT_RULES_BASENAMES:
        cand = project_root / bn
        if cand.exists():
            return cand
    return None


def _read_csv(path: Path, max_rows: int = 5000) -> tuple[list[str], dict[str, list[str]]]:
    with path.open("r", encoding="utf-8", newline="") as f:
        reader = csv.DictReader(f)
        if reader.fieldnames is None:
            raise ValueError("CSV has no header row")
        cols = list(reader.fieldnames)
        values: dict[str, list[str]] = {c: [] for c in cols}
        for i, row in enumerate(reader):
            if i >= max_rows:
                break
            for c in cols:
                values[c].append((row.get(c) or "").strip())
    return cols, values


def _varying_columns(values: dict[str, list[str]]) -> set[str]:
    varying: set[str] = set()
    for col, vs in values.items():
        uniq = {v for v in vs if v != ""}
        if len(uniq) > 1:
            varying.add(col)
    return varying


def _load_rules(path: Path) -> dict[str, Any]:
    if not path.exists():
        raise FileNotFoundError(path)
    suf = path.suffix.lower()
    if suf == ".json":
        return json.loads(path.read_text(encoding="utf-8"))
    if suf in (".yaml", ".yml"):
        try:
            import yaml  # type: ignore
        except Exception as e:  # pragma: no cover
            raise RuntimeError(
                f"YAML rules file requires PyYAML. Install it or use JSON rules. Original error: {e}"
            ) from e
        return yaml.safe_load(path.read_text(encoding="utf-8"))  # type: ignore
    raise ValueError(f"Unsupported rules file extension: {path}")


def _validate_rules_schema(rules: dict[str, Any]) -> list[str]:
    """
    Lightweight schema validation (dependency-free).
    Goal: catch typos/structural mistakes that would otherwise silently disable checks.
    """
    errors: list[str] = []
    if not isinstance(rules, dict):
        return ["rules file root must be an object/dict"]

    if "rules" not in rules:
        errors.append("rules file missing required key: 'rules' (must be a list)")
        return errors

    rl = rules.get("rules")
    if not isinstance(rl, list):
        errors.append("rules file key 'rules' must be a list")
        return errors

    allowed_rule_keys = {
        "id",
        "description",
        "trigger",
        "required_columns",
        "required_manifest",
        "exemptions",
        "error_message",
    }

    for i, r in enumerate(rl):
        if not isinstance(r, dict):
            errors.append(f"rules[{i}] must be an object/dict")
            continue
        unknown = sorted([k for k in r.keys() if k not in allowed_rule_keys])
        if unknown:
            errors.append(f"rules[{i}] has unknown keys (possible typos): {', '.join(unknown)}")
        trig = r.get("trigger")
        if not isinstance(trig, dict):
            errors.append(f"rules[{i}] missing/invalid 'trigger' (must be an object)")
            continue
        sv = trig.get("scanned_variable")
        if not isinstance(sv, dict):
            errors.append(f"rules[{i}].trigger missing/invalid 'scanned_variable' (must be an object)")
        else:
            has_match = isinstance(sv.get("match") or sv.get("name"), str) and bool(str(sv.get("match") or sv.get("name")).strip())
            has_regex = isinstance(sv.get("regex"), str) and bool(str(sv.get("regex")).strip())
            if not (has_match or has_regex):
                errors.append(f"rules[{i}].trigger.scanned_variable must include 'match' (or 'name') or 'regex'")
        req_cols = r.get("required_columns", [])
        if req_cols is not None and not isinstance(req_cols, list):
            errors.append(f"rules[{i}].required_columns must be a list if present")
        if isinstance(req_cols, list):
            for j, it in enumerate(req_cols):
                if not isinstance(it, dict):
                    errors.append(f"rules[{i}].required_columns[{j}] must be an object/dict")
                    continue
                if not isinstance(it.get("name"), str) or not it.get("name", "").strip():
                    errors.append(f"rules[{i}].required_columns[{j}] missing non-empty 'name'")
        req_m = r.get("required_manifest", [])
        if req_m is not None and not isinstance(req_m, list):
            errors.append(f"rules[{i}].required_manifest must be a list if present")
        if isinstance(req_m, list):
            for j, it in enumerate(req_m):
                if not isinstance(it, dict):
                    errors.append(f"rules[{i}].required_manifest[{j}] must be an object/dict")
                    continue
                if not isinstance(it.get("path"), str) or not it.get("path", "").strip():
                    errors.append(f"rules[{i}].required_manifest[{j}] missing non-empty 'path'")
        ex = r.get("exemptions", [])
        if ex is not None and not isinstance(ex, list):
            errors.append(f"rules[{i}].exemptions must be a list if present")
    return errors


def _json_get(obj: object, dotted_path: str) -> object | None:
    cur: object = obj
    for tok in [t for t in dotted_path.split(".") if t]:
        if isinstance(cur, dict) and tok in cur:
            cur = cur[tok]
        else:
            return None
    return cur


def _match_name(
    actual: list[str],
    name: str,
    aliases: list[str] | None,
    regex: str | None,
    ignore_case: bool = True,
) -> str | None:
    if ignore_case:
        lower_map = {a.lower(): a for a in actual}
        if name.lower() in lower_map:
            return lower_map[name.lower()]
        if aliases:
            for al in aliases:
                if al.lower() in lower_map:
                    return lower_map[al.lower()]
        if regex:
            pat = re.compile(regex, flags=re.IGNORECASE)
            for a in actual:
                if pat.match(a):
                    return a
        return None

    if name in actual:
        return name
    if aliases:
        for al in aliases:
            if al in actual:
                return al
    if regex:
        pat = re.compile(regex)
        for a in actual:
            if pat.match(a):
                return a
    return None


def _normalize_aliases_block(rules: dict[str, Any]) -> dict[str, list[str]]:
    raw = rules.get("aliases", {})
    if not isinstance(raw, dict):
        return {}
    out: dict[str, list[str]] = {}
    for k, v in raw.items():
        if isinstance(v, list) and all(isinstance(x, str) for x in v):
            out[str(k)] = list(v)
    return out


def _is_exempt(rule: dict[str, Any], manifest: object) -> tuple[bool, str]:
    """
    Supported exemption schema (minimal, safe; no eval):
      exemptions:
        - manifest:
            path: "approximation"
            equals: "leading_order"
        - manifest:
            path: "config.debug_mode"
            equals: true
        - manifest:
            path: "physics.model"
            regex: "^linear_"
    """
    exs = rule.get("exemptions", [])
    if not isinstance(exs, list):
        return (False, "")
    for ex in exs:
        if not isinstance(ex, dict):
            continue
        m = ex.get("manifest")
        if not isinstance(m, dict):
            continue
        path = str(m.get("path", "")).strip()
        if not path:
            continue
        val = _json_get(manifest, path)
        if val is None:
            continue
        if "equals" in m:
            if val == m.get("equals"):
                return (True, f"exempted by {path} == {m.get('equals')!r}")
        if "regex" in m and isinstance(m.get("regex"), str):
            if re.search(str(m["regex"]), str(val)):
                return (True, f"exempted by {path} =~ /{m['regex']}/")
    return (False, "")


def _should_trigger_rule(
    rule: dict[str, Any],
    scanned_vars_declared: list[str],
    varying_cols: set[str],
    all_cols: list[str],
    aliases_block: dict[str, list[str]],
) -> bool:
    trig = rule.get("trigger", {})
    if not isinstance(trig, dict):
        return False
    sv = trig.get("scanned_variable")
    if not isinstance(sv, dict):
        return False

    name = str(sv.get("match", "") or sv.get("name", "") or "").strip()
    if not name:
        return False
    aliases = sv.get("aliases")
    if not (isinstance(aliases, list) and all(isinstance(x, str) for x in aliases)):
        aliases = aliases_block.get(name, [])
    regex = sv.get("regex")
    regex_s = str(regex) if isinstance(regex, str) and regex.strip() else None

    # If we can parse declared scanned vars, prefer trigger by declaration (author intent).
    if scanned_vars_declared:
        return _match_name(scanned_vars_declared, name, list(aliases) if aliases else [], regex_s) is not None

    # Otherwise, trigger by evidence in CSV (something is actually varying).
    var_cols = sorted(varying_cols)
    matched = _match_name(var_cols, name, list(aliases) if aliases else [], regex_s)
    if matched:
        return True
    # If variable name isn't a column name but aliases exist, check all columns.
    matched2 = _match_name(all_cols, name, list(aliases) if aliases else [], regex_s)
    return matched2 is not None


def _apply_rule(
    rule: dict[str, Any],
    cols: list[str],
    varying: set[str],
    manifest: object,
    aliases_block: dict[str, list[str]],
) -> tuple[list[str], list[str]]:
    """
    Returns (errors, warnings) for this rule.
    """
    errors: list[str] = []
    warnings: list[str] = []

    rule_id = str(rule.get("id", "") or "").strip() or "(unnamed-rule)"

    exempted, why = _is_exempt(rule, manifest)
    if exempted:
        warnings.append(f"[RULE:{rule_id}] skipped ({why})")
        return (errors, warnings)

    req_cols = rule.get("required_columns", [])
    if isinstance(req_cols, list):
        for item in req_cols:
            if not isinstance(item, dict):
                continue
            name = str(item.get("name", "")).strip()
            if not name:
                continue
            aliases = item.get("aliases")
            if not (isinstance(aliases, list) and all(isinstance(x, str) for x in aliases)):
                aliases = aliases_block.get(name, [])
            regex = item.get("regex")
            regex_s = str(regex) if isinstance(regex, str) and regex.strip() else None
            matched = _match_name(cols, name, list(aliases) if aliases else [], regex_s)
            cond = str(item.get("condition", "present")).strip().lower()
            if matched is None:
                errors.append(f"[RULE:{rule_id}] missing required CSV column: {name}")
                continue
            if cond in ("must_vary", "vary", "nonconstant"):
                if matched not in varying:
                    errors.append(f"[RULE:{rule_id}] column '{matched}' is present but does not vary across the scan")

    req_m = rule.get("required_manifest", [])
    if isinstance(req_m, list):
        for item in req_m:
            if not isinstance(item, dict):
                continue
            path = str(item.get("path", "")).strip()
            if not path:
                continue
            val = _json_get(manifest, path)
            must_exist = bool(item.get("must_exist", True))
            if val is None:
                if must_exist:
                    errors.append(f"[RULE:{rule_id}] missing required manifest key: {path}")
                continue
            allowed = item.get("allowed_values")
            forbidden = item.get("forbidden_values")
            if isinstance(allowed, list) and allowed:
                if str(val) not in [str(x) for x in allowed]:
                    errors.append(f"[RULE:{rule_id}] manifest key {path}={val!r} not in allowed_values={allowed}")
            if isinstance(forbidden, list) and forbidden:
                if str(val) in [str(x) for x in forbidden]:
                    errors.append(f"[RULE:{rule_id}] manifest key {path}={val!r} is forbidden (forbidden_values={forbidden})")

    return (errors, warnings)


def _render_error_message(rule: dict[str, Any], errors: list[str]) -> list[str]:
    msg = rule.get("error_message")
    if isinstance(msg, str) and msg.strip():
        rid = str(rule.get("id", "") or "").strip()
        rendered = msg.replace("{id}", rid).replace("{errors}", "\\n".join(errors))
        return [rendered.strip()]
    return errors


def _collect_from_notes(notes: Path) -> ScanArtifacts:
    project_root = notes.parent.resolve()
    text = notes.read_text(encoding="utf-8", errors="replace")
    capsule = _extract_capsule(text)
    if capsule is None:
        return ScanArtifacts(csv_path=None, manifest_path=None, rules_path=None, capsule_g_section="")
    g_sec = _extract_section(capsule, r"G\)\s+Sweep semantics\s*/\s*parameter dependence")
    csv_path, manifest_path = _guess_artifacts_from_capsule(capsule, project_root)
    rules_path = _find_rules_file(project_root, g_sec)
    return ScanArtifacts(csv_path=csv_path, manifest_path=manifest_path, rules_path=rules_path, capsule_g_section=g_sec)


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--notes", type=Path, default=None, help="Notebook path (preferred): research_contract.md.")
    p.add_argument("--csv", type=Path, default=None, help="Scan CSV path (optional; overrides capsule guessing).")
    p.add_argument("--manifest", type=Path, default=None, help="Run manifest JSON path (optional; overrides capsule guessing).")
    p.add_argument("--rules", type=Path, default=None, help="Rules file path (optional; overrides auto-detect).")
    p.add_argument(
        "--require-rules",
        action="store_true",
        help="If a scan is detected, missing rules file becomes an error (exit 1).",
    )
    p.add_argument(
        "--strict",
        action="store_true",
        help="Treat warnings as errors (exit 1).",
    )
    p.add_argument(
        "--scanned-vars",
        type=str,
        default="",
        help="Override scanned variables (comma-separated). If omitted, parsed from capsule section G).",
    )
    args = p.parse_args()

    if args.notes is None and (args.csv is None or args.manifest is None):
        print("ERROR: provide --notes, or provide both --csv and --manifest", flush=True)
        return 2

    capsule_g = ""
    audit_override = ""
    require_rules_config = False

    if args.notes is not None:
        if not args.notes.is_file():
            print(f"ERROR: notes not found: {args.notes}", flush=True)
            return 2

        cfg = load_team_config(args.notes)
        if not cfg.feature_enabled("scan_dependency_gate", default=True):
            print("[skip] scan dependency gate disabled by research_team_config", flush=True)
            return 0
        require_rules_config = bool(cfg.data.get("scan_dependency", {}).get("require_rules_file_when_scan_detected", False))

        detected = _collect_from_notes(args.notes)
        capsule_g = detected.capsule_g_section
        audit_override = _parse_audit_override_from_g_section(capsule_g)
        csv_path = detected.csv_path
        manifest_path = detected.manifest_path
        rules_path = detected.rules_path
        project_root = args.notes.parent.resolve()
    else:
        csv_path = args.csv
        manifest_path = args.manifest
        rules_path = None
        project_root = Path.cwd()

    if args.csv is not None:
        csv_path = args.csv if args.csv.is_absolute() else (project_root / args.csv)
    if args.manifest is not None:
        manifest_path = args.manifest if args.manifest.is_absolute() else (project_root / args.manifest)
    if args.rules is not None:
        rules_path = args.rules if args.rules.is_absolute() else (project_root / args.rules)

    if audit_override in ("disable-scan-dep", "disable", "off"):
        print("[ok] scan dependency check disabled by AUDIT_OVERRIDE in capsule", flush=True)
        return 0

    if csv_path is None or manifest_path is None:
        print("[ok] scan dependency check not applicable (missing scan CSV or manifest in capsule outputs)", flush=True)
        return 0
    if not csv_path.exists():
        print(f"[ok] scan dependency check not applicable (CSV not found): {csv_path}", flush=True)
        return 0
    if not manifest_path.exists():
        print(f"[ok] scan dependency check not applicable (manifest not found): {manifest_path}", flush=True)
        return 0

    cols, vals = _read_csv(csv_path)
    varying = _varying_columns(vals)
    if not varying:
        print("[ok] no varying columns detected in scan CSV; dependency rules not applicable", flush=True)
        return 0

    scanned_vars_declared: list[str] = []
    if args.scanned_vars.strip():
        scanned_vars_declared = [s.strip() for s in args.scanned_vars.split(",") if s.strip()]
    else:
        scanned_vars_declared = _parse_scanned_vars_from_g_section(capsule_g)

    if rules_path is None or not rules_path.exists():
        msg = f"[warn] scan detected (varying cols={len(varying)}), but no rules file found under {project_root}"
        print(msg, flush=True)
        if args.require_rules or require_rules_config:
            print("[fail] missing rules file and --require-rules is set", flush=True)
            return 1
        return 0

    try:
        rules = _load_rules(rules_path)
    except Exception as e:
        print(f"[fail] failed to load rules file: {rules_path}", flush=True)
        print(f"[error] {e}", flush=True)
        return 2

    if not isinstance(rules, dict):
        print(f"[fail] rules file must parse to an object/dict: {rules_path}", flush=True)
        return 2

    schema_errors = _validate_rules_schema(rules)
    if schema_errors:
        print(f"[fail] rules file schema validation failed: {rules_path}", flush=True)
        for e in schema_errors[:25]:
            print(f"[error] {e}", flush=True)
        if len(schema_errors) > 25:
            print(f"[error] ... ({len(schema_errors)-25} more)", flush=True)
        return 2

    aliases_block = _normalize_aliases_block(rules)
    rules_list = rules.get("rules", [])
    if not isinstance(rules_list, list):
        print(f"[fail] rules.rules must be a list: {rules_path}", flush=True)
        return 2

    try:
        manifest_obj = json.loads(manifest_path.read_text(encoding="utf-8"))
    except Exception as e:
        print(f"[fail] failed to read manifest JSON: {manifest_path}", flush=True)
        print(f"[error] {e}", flush=True)
        return 2

    all_errors: list[str] = []
    all_warnings: list[str] = []
    applied_rules = 0

    for rule in rules_list:
        if not isinstance(rule, dict):
            continue
        if not _should_trigger_rule(rule, scanned_vars_declared, varying, cols, aliases_block):
            continue
        applied_rules += 1
        errs, warns = _apply_rule(rule, cols, varying, manifest_obj, aliases_block)
        if errs:
            all_errors.extend(_render_error_message(rule, errs))
        all_warnings.extend(warns)

    print("[scan] inputs:", flush=True)
    print(f"- csv: {csv_path}", flush=True)
    print(f"- manifest: {manifest_path}", flush=True)
    print(f"- rules: {rules_path}", flush=True)
    if scanned_vars_declared:
        print(f"- scanned vars (declared): {', '.join(scanned_vars_declared)}", flush=True)
    print(f"- varying cols (detected): {', '.join(sorted(list(varying))[:12])}" + (" ..." if len(varying) > 12 else ""), flush=True)
    print(f"- applied rules: {applied_rules}", flush=True)

    # If we have a scan but applied no rules, warn loudly (likely misconfigured triggers).
    if applied_rules == 0:
        all_warnings.append("no rules were triggered for the detected scan; check triggers/aliases or provide --scanned-vars")

    if all_errors or (args.strict and all_warnings):
        if audit_override in ("warn-only", "warn", "soft"):
            print("[warn] dependency violations found, but AUDIT_OVERRIDE=warn-only is set; continuing", flush=True)
            for e in all_errors:
                print(f"[warn] {e}", flush=True)
            for w in all_warnings:
                print(f"[warn] {w}", flush=True)
            return 0

        print("[fail] scan dependency check failed", flush=True)
        for e in all_errors[:50]:
            print(f"[error] {e}", flush=True)
        if len(all_errors) > 50:
            print(f"[error] ... ({len(all_errors)-50} more)", flush=True)
        for w in all_warnings[:50]:
            print(f"[warn] {w}", flush=True)
        return 1

    print("[ok] scan dependency check passed", flush=True)
    for w in all_warnings[:50]:
        print(f"[warn] {w}", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
