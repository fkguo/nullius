#!/usr/bin/env python3
"""
Phase gates for the literature-to-package pipeline.

Each pipeline phase produces a JSON artifact (schemas in
references/contract.md); this gate validates the artifact — and, where the
phase touches files, the package tree — deterministically and emits a
machine-readable verdict. The CALLER NEVER SELF-JUDGES a phase: the verdict
comes from this script, numeric comparisons are recomputed here (any
self-claimed pass field in an artifact is ignored), and every check fails
closed — a missing artifact, an unreadable file, or an empty manifest is a
failure or an input error, never a silent pass.

Phases (pipeline order):
  survey            reuse-vs-build decisions; novelty claims must name the
                    strongest prior statement found; absence of public code
                    is a search result, never evidence of originality
  extraction        span-anchored extraction of equations / algorithms /
                    conventions / constants (verbatim + locator per item;
                    model memory is not a source)
  skeleton          package skeleton hygiene: no absolute paths, README,
                    test skeleton, non-empty traceability ledger, and the
                    export <-> doc <-> test three-way map
  reimplementation  >=2 independent implementations from a clean-room SPEC;
                    a port of reference code never counts as independent;
                    an independent review verdict must approve
  reference-check   numeric cross-validation against published values with
                    diagnostic tolerances (recomputed here) and >=2 distinct
                    representations across the checks
  composite-gates   the derivation, numerical-reliability, and performance
                    verdicts all pass (waivers must be explicit)
  closeout          executed README examples, scrub-lexicon sweep, absolute
                    path re-scan, fully resolved traceability ledger

Exit codes:
  0  phase passed
  1  phase failed (falsification labels in the verdict)
  2  input / execution error

The verdict JSON (`literature_to_package_gate_result_v1`) goes to stdout and
optionally to --out-json; human diagnostics go to stderr.
"""

from __future__ import annotations

import argparse
import datetime as _dt
import json
import math
import re
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

SCHEMA_ID = "literature_to_package_gate_result_v1"
SCHEMA_VERSION = 1

PHASES = (
    "survey",
    "extraction",
    "skeleton",
    "reimplementation",
    "reference-check",
    "composite-gates",
    "closeout",
)
# Phases whose checks read files under --package-root.
_PHASES_NEED_ROOT = {
    "skeleton",
    "reimplementation",
    "reference-check",
    "composite-gates",
    "closeout",
}

_EXTRACTION_KINDS = {"equation", "algorithm", "convention", "constant", "parameter"}
_UNIT_KINDS = {"constant", "parameter"}

# Text files scanned inside the package tree (absolute paths, scrub lexicon).
_SCAN_EXTS = {
    ".py", ".jl", ".sh", ".bash", ".zsh", ".r", ".R", ".m", ".wl", ".wls",
    ".c", ".cc", ".cpp", ".h", ".hpp", ".f", ".f90", ".f95", ".rs", ".go",
    ".js", ".ts", ".md", ".toml", ".yaml", ".yml", ".txt", ".json", ".cfg",
    ".ini",
}
_SCAN_SKIP_DIRS = {".git", "node_modules", ".venv", "venv", "__pycache__", ".pytest_cache"}
_MAX_SCAN_BYTES = 2_000_000
# The metacharacter right after each prefix is deliberate: it marks this as a
# detector pattern, not a machine-specific path.
_ABS_PATH_RE = re.compile(r"(?:/Users/|/home/|[A-Za-z]:\\Users\\)[A-Za-z0-9._-]+")

# Reviewer verdict formats accepted for the reimplementation phase
# (the review-swarm output contract): markdown first line or JSON verdict.
_REVIEW_MD_RE = re.compile(r"^\s*VERDICT:\s*(READY|NOT_READY)\b")

_REL_SLACK = 1e-12


@dataclass
class Findings:
    labels: list[str] = field(default_factory=list)
    reasons: list[str] = field(default_factory=list)
    checked: dict[str, int] = field(default_factory=dict)

    def add(self, label: str, reason: str) -> None:
        if label not in self.labels:
            self.labels.append(label)
        self.reasons.append(f"{label}: {reason}")


# ---------------------------------------------------------------------------
# Shared helpers
# ---------------------------------------------------------------------------


def _utc_now() -> str:
    return _dt.datetime.now(_dt.timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def _as_list(obj: Any, key: str) -> list[Any]:
    v = obj.get(key, []) if isinstance(obj, dict) else []
    return v if isinstance(v, list) else []


def _nonempty_str(obj: Any, key: str) -> str:
    v = obj.get(key, "") if isinstance(obj, dict) else ""
    return v.strip() if isinstance(v, str) else ""


def _num(obj: Any, key: str) -> float | None:
    v = obj.get(key) if isinstance(obj, dict) else None
    if isinstance(v, bool) or not isinstance(v, (int, float)):
        return None
    if isinstance(v, float) and not math.isfinite(v):
        return None
    return float(v)


def _rel_path(root: Path, raw: str, f: Findings, ctx: str) -> Path | None:
    """Resolve a manifest-declared path against the package root. Absolute
    paths in manifests are non-portable and fail closed."""
    p = raw.strip()
    if not p:
        f.add("MISSING_PATH", f"{ctx}: empty path")
        return None
    if Path(p).is_absolute() or _ABS_PATH_RE.search(p):
        f.add("ABSOLUTE_PATH_IN_MANIFEST", f"{ctx}: manifest path must be package-root-relative: {p!r}")
        return None
    return (root / p).resolve()


def _iter_package_files(root: Path) -> tuple[list[Path], list[str]]:
    files: list[Path] = []
    skipped: list[str] = []
    for p in sorted(root.rglob("*")):
        if not p.is_file() or p.suffix not in _SCAN_EXTS:
            continue
        rel_parts = p.relative_to(root).parts
        if any(part in _SCAN_SKIP_DIRS for part in rel_parts):
            continue
        try:
            if p.stat().st_size > _MAX_SCAN_BYTES:
                skipped.append(f"{p.relative_to(root)}: exceeds {_MAX_SCAN_BYTES}-byte scan cap")
                continue
        except OSError as e:
            skipped.append(f"{p.relative_to(root)}: unreadable ({e})")
            continue
        files.append(p)
    return files, skipped


def _read_text(p: Path) -> str | None:
    try:
        return p.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return None


def _scan_absolute_paths(root: Path, f: Findings, exclude: list[Path]) -> None:
    files, skipped = _iter_package_files(root)
    for msg in skipped:
        f.add("SCAN_INCOMPLETE", f"package scan could not read {msg}")
    for p in files:
        if any(p == e or e in p.parents for e in exclude):
            continue
        text = _read_text(p)
        if text is None:
            f.add("SCAN_INCOMPLETE", f"package scan could not read {p.relative_to(root)}")
            continue
        for lineno, line in enumerate(text.splitlines(), start=1):
            m = _ABS_PATH_RE.search(line)
            if m:
                f.add(
                    "ABSOLUTE_PATH_IN_PACKAGE",
                    f"{p.relative_to(root)}:{lineno}: machine-specific path {m.group(0)!r}",
                )
                break  # one finding per file is enough to fail


# ---------------------------------------------------------------------------
# Phase: survey (reuse-vs-build)
# ---------------------------------------------------------------------------


def check_survey(artifact: dict, root: Path | None, f: Findings) -> None:
    components = _as_list(artifact, "components")
    f.checked["components"] = len(components)
    if not components:
        f.add("EMPTY_SURVEY", "no components surveyed — a reuse-vs-build phase with no entries is not done")
        return
    for i, comp in enumerate(components):
        cid = _nonempty_str(comp, "id") or f"components[{i}]"
        decision = _nonempty_str(comp, "decision")
        if decision not in {"build", "reuse", "wrap"}:
            f.add("MISSING_DECISION", f"{cid}: decision must be one of build/reuse/wrap, got {decision!r}")
        searches = _as_list(comp, "searches")
        ok_searches = [
            s for s in searches
            if isinstance(s, dict) and _nonempty_str(s, "query") and _nonempty_str(s, "venue")
        ]
        if not ok_searches:
            f.add("MISSING_SEARCH_LOG", f"{cid}: no recorded searches (each needs query + venue)")
        prior = _as_list(comp, "strongest_prior_art")
        prior_ok = [
            p for p in prior
            if isinstance(p, dict) and _nonempty_str(p, "statement") and _nonempty_str(p, "source")
        ]
        originality = bool(comp.get("originality_claim", False)) if isinstance(comp, dict) else False
        if originality and not prior_ok:
            f.add(
                "ORIGINALITY_WITHOUT_STRONGEST_PRIOR",
                f"{cid}: originality_claim requires naming the strongest existing statement "
                "found by a focused search (strongest_prior_art must be non-empty)",
            )
        no_code = bool(comp.get("no_public_code_found", False)) if isinstance(comp, dict) else False
        if no_code and originality and not prior_ok:
            f.add(
                "ABSENCE_PROMOTED_TO_NOVELTY",
                f"{cid}: 'no public code found' is a search RESULT — it cannot be promoted to a "
                "method-originality claim",
            )


# ---------------------------------------------------------------------------
# Phase: extraction (span-anchored)
# ---------------------------------------------------------------------------


def check_extraction(artifact: dict, root: Path | None, f: Findings) -> None:
    sources = {_nonempty_str(s, "id"): s for s in _as_list(artifact, "sources") if isinstance(s, dict)}
    sources.pop("", None)
    items = _as_list(artifact, "items")
    f.checked["sources"] = len(sources)
    f.checked["items"] = len(items)
    if not items:
        f.add("EMPTY_EXTRACTION", "no extracted items — an extraction phase with no entries is not done")
        return
    for sid, s in sources.items():
        if _nonempty_str(s, "kind") == "memory":
            f.add("MEMORY_CITED_AS_SOURCE", f"source {sid!r}: model memory is not a source; cite the document")
        if not _nonempty_str(s, "citation"):
            f.add("UNKNOWN_SOURCE", f"source {sid!r}: missing citation")
    for i, it in enumerate(items):
        iid = _nonempty_str(it, "id") or f"items[{i}]"
        kind = _nonempty_str(it, "kind")
        if kind not in _EXTRACTION_KINDS:
            f.add("UNKNOWN_ITEM_KIND", f"{iid}: kind must be one of {sorted(_EXTRACTION_KINDS)}, got {kind!r}")
        if not _nonempty_str(it, "verbatim"):
            f.add("MISSING_VERBATIM", f"{iid}: verbatim span from the source is required (no paraphrase-only items)")
        if not _nonempty_str(it, "locator"):
            f.add("MISSING_LOCATOR", f"{iid}: locator (page / equation number / section / line range) is required")
        src = _nonempty_str(it, "source")
        if not src or src not in sources:
            f.add("UNKNOWN_SOURCE", f"{iid}: source {src!r} is not declared in sources[]")
        if kind in _UNIT_KINDS and not _nonempty_str(it, "units"):
            f.add(
                "MISSING_UNITS",
                f"{iid}: kind={kind} requires units (write 'dimensionless' explicitly when unitless)",
            )


# ---------------------------------------------------------------------------
# Phase: skeleton
# ---------------------------------------------------------------------------


def check_skeleton(artifact: dict, root: Path, f: Findings) -> None:
    exclude: list[Path] = []
    for raw in _as_list(artifact, "reference_asset_dirs"):
        if isinstance(raw, str):
            p = _rel_path(root, raw, f, "reference_asset_dirs")
            if p is not None:
                exclude.append(p)
    _scan_absolute_paths(root, f, exclude)

    if not any((root / name).is_file() for name in ("README.md", "README.rst", "README.txt")):
        f.add("MISSING_README", "package root has no README")
    if not any((root / d).is_dir() for d in ("tests", "test")):
        f.add("MISSING_TEST_SKELETON", "package root has no tests/ (or test/) directory")

    ledger_rel = _nonempty_str(artifact, "traceability_ledger")
    ledger_path = _rel_path(root, ledger_rel, f, "traceability_ledger") if ledger_rel else None
    if ledger_path is None or not ledger_path.is_file():
        f.add("MISSING_TRACEABILITY_LEDGER", f"traceability ledger not found: {ledger_rel!r}")
    else:
        try:
            ledger = json.loads(ledger_path.read_text(encoding="utf-8", errors="replace"))
        except (json.JSONDecodeError, OSError) as e:
            f.add("MISSING_TRACEABILITY_LEDGER", f"traceability ledger unreadable: {e}")
            ledger = {}
        entries = _as_list(ledger, "entries")
        f.checked["ledger_entries"] = len(entries)
        if not entries:
            f.add("EMPTY_TRACEABILITY_LEDGER", "traceability ledger has no entries")
        for i, e in enumerate(entries):
            eid = _nonempty_str(e, "artifact") or f"entries[{i}]"
            has_extraction = bool([x for x in _as_list(e, "extraction_ids") if isinstance(x, str) and x.strip()])
            has_reuse = bool(_nonempty_str(e, "reuse_source"))
            if not has_extraction and not has_reuse:
                f.add(
                    "UNTRACED_LEDGER_ITEM",
                    f"{eid}: every ledger entry needs extraction_ids (built from literature) or "
                    "reuse_source (adopted from an existing package)",
                )

    exports = _as_list(artifact, "exports")
    f.checked["exports"] = len(exports)
    if not exports:
        f.add("MISSING_EXPORT_MAP", "no exports declared — the export <-> doc <-> test map is required")
    for i, ex in enumerate(exports):
        name = _nonempty_str(ex, "name") or f"exports[{i}]"
        doc = _nonempty_str(ex, "doc_path")
        doc_p = _rel_path(root, doc, f, f"exports[{name}].doc_path") if doc else None
        if doc_p is None or not doc_p.is_file():
            f.add("EXPORT_MISSING_DOC", f"{name}: documented-at file not found: {doc!r}")
        test = _nonempty_str(ex, "test_path")
        test_p = _rel_path(root, test, f, f"exports[{name}].test_path") if test else None
        if test_p is None or not test_p.is_file():
            f.add("EXPORT_MISSING_TEST", f"{name}: test-skeleton file not found: {test!r}")


# ---------------------------------------------------------------------------
# Phase: reimplementation
# ---------------------------------------------------------------------------


def _stem_reference_re(path: Path) -> re.Pattern[str]:
    return re.compile(rf"\b{re.escape(path.stem)}\b")


def check_reimplementation(artifact: dict, root: Path, f: Findings) -> None:
    methods = _as_list(artifact, "methods")
    f.checked["methods"] = len(methods)
    if not methods:
        f.add("EMPTY_REIMPLEMENTATION", "no methods declared")
        return

    reference_paths: list[Path] = []
    for raw in _as_list(artifact, "reference_code_paths"):
        if isinstance(raw, str) and raw.strip():
            p = _rel_path(root, raw, f, "reference_code_paths")
            if p is not None:
                reference_paths.append(p)

    for i, m in enumerate(methods):
        mid = _nonempty_str(m, "id") or f"methods[{i}]"

        spec_rel = _nonempty_str(m, "spec_path")
        spec_p = _rel_path(root, spec_rel, f, f"{mid}.spec_path") if spec_rel else None
        spec_text = None
        if spec_p is None or not spec_p.is_file():
            f.add("MISSING_SPEC", f"{mid}: clean-room SPEC not found: {spec_rel!r}")
        else:
            spec_text = _read_text(spec_p)
            if spec_text is None:
                f.add("MISSING_SPEC", f"{mid}: clean-room SPEC unreadable: {spec_rel!r}")

        impls = _as_list(m, "implementations")
        independent: list[tuple[Path, str]] = []
        for j, impl in enumerate(impls):
            label = f"{mid}.implementations[{j}]"
            path_rel = _nonempty_str(impl, "path")
            impl_p = _rel_path(root, path_rel, f, label) if path_rel else None
            if impl_p is None or not impl_p.is_file():
                f.add("MISSING_IMPLEMENTATION", f"{label}: file not found: {path_rel!r}")
                continue
            origin = _nonempty_str(impl, "origin")
            claimed = bool(impl.get("independent", False)) if isinstance(impl, dict) else False
            if claimed and origin != "fresh":
                f.add(
                    "PORT_CLAIMED_INDEPENDENT",
                    f"{label}: independent=true requires origin='fresh' (got {origin!r}) — a port or "
                    "adaptation of reference code is a transcription, not an independent path",
                )
                continue
            if claimed:
                independent.append((impl_p, label))

        if len(independent) < 2:
            f.add(
                "INSUFFICIENT_INDEPENDENT_IMPLEMENTATIONS",
                f"{mid}: {len(independent)} independent implementation(s) — the floor is 2 "
                "(agreement of one path with itself confirms nothing)",
            )

        # Coupling checks: an "independent" implementation must not lean on a
        # sibling implementation or on the reference code. Textual stem
        # matching is an approximation (documented in contract.md); it is a
        # detector, not a proof of independence.
        for impl_p, label in independent:
            text = _read_text(impl_p)
            if text is None:
                f.add("MISSING_IMPLEMENTATION", f"{label}: unreadable: {impl_p.name}")
                continue
            for other_p, _other_label in independent:
                if other_p == impl_p:
                    continue
                if _stem_reference_re(other_p).search(text):
                    f.add(
                        "IMPLEMENTATION_COUPLING",
                        f"{label}: references sibling implementation {other_p.name!r} — "
                        "independent paths must not load or share each other's code",
                    )
            for ref_p in reference_paths:
                if _stem_reference_re(ref_p).search(text):
                    f.add(
                        "REFERENCE_CODE_COUPLING",
                        f"{label}: references reference code {ref_p.name!r} — the reproduction "
                        "must not call through the code it is meant to check",
                    )
        if spec_text is not None:
            for ref_p in reference_paths:
                if _stem_reference_re(ref_p).search(spec_text):
                    f.add(
                        "SPEC_REFERENCES_SOURCE_CODE",
                        f"{mid}: the clean-room SPEC mentions reference code {ref_p.name!r} — the SPEC "
                        "must be written from the literature, not from the reference implementation",
                    )

        verdicts = _as_list(m, "review_verdicts")
        if not verdicts:
            f.add("MISSING_INDEPENDENT_REVIEW", f"{mid}: no independent review verdict recorded")
        for raw in verdicts:
            if not isinstance(raw, str):
                continue
            v_p = _rel_path(root, raw, f, f"{mid}.review_verdicts")
            if v_p is None or not v_p.is_file():
                f.add("MISSING_INDEPENDENT_REVIEW", f"{mid}: review verdict file not found: {raw!r}")
                continue
            if not _review_approved(v_p):
                f.add(
                    "REVIEW_NOT_APPROVED",
                    f"{mid}: review verdict {raw!r} is not an approval — convergence is declared by "
                    "the reviewer, not by the implementer",
                )


def _review_approved(path: Path) -> bool:
    text = _read_text(path)
    if text is None:
        return False
    stripped = text.strip()
    if stripped.startswith("{"):
        try:
            obj = json.loads(stripped)
        except json.JSONDecodeError:
            return False
        return isinstance(obj, dict) and str(obj.get("verdict", "")).upper() == "PASS"
    for line in stripped.splitlines():
        if not line.strip():
            continue
        m = _REVIEW_MD_RE.match(line)
        return bool(m and m.group(1) == "READY")
    return False


# ---------------------------------------------------------------------------
# Phase: reference-check
# ---------------------------------------------------------------------------


def check_reference_check(artifact: dict, root: Path, f: Findings) -> None:
    checks = _as_list(artifact, "checks")
    f.checked["checks"] = len(checks)
    if not checks:
        f.add("EMPTY_REFERENCE_CHECK", "no reference checks — cross-validation against published values is required")
        return

    representations: set[str] = set()
    for i, c in enumerate(checks):
        cid = _nonempty_str(c, "id") or f"checks[{i}]"
        rep = _nonempty_str(c, "representation")
        if rep:
            representations.add(rep)

        computed = c.get("computed", {}) if isinstance(c, dict) else {}
        reference = c.get("reference", {}) if isinstance(c, dict) else {}
        cv = _num(computed, "value")
        rv = _num(reference, "value")
        tol = _num(c, "tolerance")
        scale = _num(c, "error_scale")

        if not _nonempty_str(reference, "source") or not _nonempty_str(reference, "locator"):
            f.add("MISSING_REFERENCE_LOCATOR", f"{cid}: reference needs source + locator (where the published value lives)")
        if cv is None or rv is None:
            f.add("MISSING_VALUES", f"{cid}: computed.value and reference.value must be finite numbers")
            continue
        if tol is None or tol <= 0:
            f.add("NON_DIAGNOSTIC_TOLERANCE", f"{cid}: tolerance must be a positive number")
            continue
        if scale is None or scale <= 0 or not _nonempty_str(c, "error_scale_basis"):
            f.add(
                "NON_DIAGNOSTIC_TOLERANCE",
                f"{cid}: error_scale (+ error_scale_basis) is required — a tolerance without a "
                "declared uncertainty scale cannot be judged diagnostic",
            )
            continue
        ce, re_ = _num(computed, "error"), _num(reference, "error")
        if ce is not None and re_ is not None:
            combined = math.hypot(ce, re_)
            if combined > 0 and scale > combined * (1 + _REL_SLACK):
                f.add(
                    "ERROR_SCALE_INFLATED",
                    f"{cid}: declared error_scale={scale:g} exceeds the combined declared "
                    f"uncertainty {combined:g} — inflating the scale launders a loose tolerance",
                )
        if tol > scale * (1 + _REL_SLACK):
            f.add(
                "NON_DIAGNOSTIC_TOLERANCE",
                f"{cid}: tolerance={tol:g} is coarser than the uncertainty scale {scale:g} — the "
                "check cannot detect a discrepancy at the scale that matters, so it proves nothing",
            )
        # Recompute the comparison; any self-claimed pass field is ignored.
        if abs(cv - rv) > tol:
            f.add(
                "VALUE_MISMATCH",
                f"{cid}: |computed - reference| = {abs(cv - rv):g} > tolerance {tol:g} "
                f"(computed={cv:g}, reference={rv:g}) — a mismatch is a finding to resolve, "
                "not a systematic to be renamed",
            )

    f.checked["representations"] = len(representations)
    if len(representations) < 2:
        f.add(
            "SINGLE_REPRESENTATION",
            f"only {len(representations)} distinct representation(s) across the checks — agreement "
            "within one representation cannot expose a representation-level error; the floor is 2",
        )

    dep_files = [x for x in _as_list(artifact, "runtime_dep_files") if isinstance(x, str) and x.strip()]
    ref_only = [x for x in _as_list(artifact, "reference_only") if isinstance(x, str) and x.strip()]
    if ref_only and not dep_files:
        f.add(
            "REFERENCE_IN_RUNTIME_DEPS",
            "reference_only assets are declared but no runtime_dep_files were given to scan — "
            "the no-reference-in-deps invariant cannot be verified",
        )
    for dep_rel in dep_files:
        dep_p = _rel_path(root, dep_rel, f, "runtime_dep_files")
        if dep_p is None or not dep_p.is_file():
            f.add("REFERENCE_IN_RUNTIME_DEPS", f"declared runtime dep file not found: {dep_rel!r}")
            continue
        text = _read_text(dep_p) or ""
        for name in ref_only:
            if re.search(rf"\b{re.escape(name)}\b", text):
                f.add(
                    "REFERENCE_IN_RUNTIME_DEPS",
                    f"{dep_rel}: reference-only asset {name!r} appears in a runtime dependency file — "
                    "reference material may feed benchmarks and tests, never the package runtime",
                )


# ---------------------------------------------------------------------------
# Phase: composite-gates
# ---------------------------------------------------------------------------


def _load_verdict(root: Path, rel: str, f: Findings, which: str) -> dict | None:
    p = _rel_path(root, rel, f, which)
    if p is None or not p.is_file():
        f.add("MISSING_GATE_VERDICT", f"{which}: verdict file not found: {rel!r}")
        return None
    try:
        obj = json.loads(p.read_text(encoding="utf-8", errors="replace"))
    except (json.JSONDecodeError, OSError) as e:
        f.add("UNPARSEABLE_GATE_VERDICT", f"{which}: {e}")
        return None
    if not isinstance(obj, dict):
        f.add("UNPARSEABLE_GATE_VERDICT", f"{which}: verdict must be a JSON object")
        return None
    return obj


def check_composite_gates(artifact: dict, root: Path, f: Findings) -> None:
    gates = artifact.get("gates", {}) if isinstance(artifact, dict) else {}
    if not isinstance(gates, dict):
        gates = {}

    def _entry(which: str) -> Any:
        return gates.get(which)

    for which in ("derivation", "numerical_reliability", "performance"):
        entry = _entry(which)
        if isinstance(entry, dict) and "waived" in entry:
            if entry.get("waived") is True and _nonempty_str(entry, "reason"):
                f.checked[f"{which}_waived"] = 1
                continue
            f.add("SILENT_WAIVER", f"{which}: a waiver requires waived=true AND a non-empty reason")
            continue
        rel = entry if isinstance(entry, str) else ""
        if not rel:
            f.add("MISSING_GATE_VERDICT", f"{which}: no verdict path (or explicit waiver) declared")
            continue
        obj = _load_verdict(root, rel, f, which)
        if obj is None:
            continue
        if which == "derivation":
            total = obj.get("total_claims")
            unconverged = obj.get("unconverged")
            ok = (
                isinstance(total, int) and total >= 1
                and isinstance(unconverged, list) and not unconverged
                and obj.get("converged") == total
            )
            if not ok:
                f.add(
                    "GATE_NOT_PASSED",
                    f"derivation: requires total_claims>=1 and converged==total_claims with empty "
                    f"unconverged (got total={total!r}, converged={obj.get('converged')!r}, "
                    f"unconverged={unconverged!r})",
                )
        elif which == "numerical_reliability":
            matrix = obj.get("matrix")
            not_reliable = obj.get("not_reliable")
            ok = (
                isinstance(matrix, list) and len(matrix) >= 1
                and isinstance(not_reliable, list) and not not_reliable
            )
            if not ok:
                f.add(
                    "GATE_NOT_PASSED",
                    f"numerical_reliability: requires a non-empty matrix with empty not_reliable "
                    f"(got matrix={'list[' + str(len(matrix)) + ']' if isinstance(matrix, list) else matrix!r}, "
                    f"not_reliable={not_reliable!r})",
                )
        else:  # performance
            verdict = str(obj.get("verdict", "")).lower()
            if verdict != "pass":
                f.add(
                    "GATE_NOT_PASSED",
                    f"performance: verdict must be 'pass' (got {obj.get('verdict')!r}); an "
                    "inconclusive or missing benchmark is not a pass",
                )


# ---------------------------------------------------------------------------
# Phase: closeout
# ---------------------------------------------------------------------------


def check_closeout(artifact: dict, root: Path, f: Findings) -> None:
    examples = _as_list(artifact, "readme_examples")
    f.checked["readme_examples"] = len(examples)
    if not examples and not _nonempty_str(artifact, "readme_examples_none_reason"):
        f.add(
            "MISSING_CLOSEOUT_FIELDS",
            "readme_examples is empty and no readme_examples_none_reason is given — a code-verified "
            "README needs executed examples or an explicit reason there are none",
        )
    for i, ex in enumerate(examples):
        eid = _nonempty_str(ex, "id") or f"readme_examples[{i}]"
        log_rel = _nonempty_str(ex, "log")
        log_p = _rel_path(root, log_rel, f, f"{eid}.log") if log_rel else None
        if log_p is None or not log_p.is_file() or log_p.stat().st_size == 0:
            f.add(
                "UNEXECUTED_README_EXAMPLE",
                f"{eid}: no non-empty execution log at {log_rel!r} — a README example that was never "
                "run is a claim, not documentation",
            )

    lexicon = [x for x in _as_list(artifact, "scrub_lexicon") if isinstance(x, str) and x.strip()]
    if not lexicon and not _nonempty_str(artifact, "scrub_lexicon_none_reason"):
        f.add(
            "MISSING_CLOSEOUT_FIELDS",
            "scrub_lexicon is empty and no scrub_lexicon_none_reason is given — declare the "
            "internal-process vocabulary that must not reach the public package, or say why none applies",
        )
    files, skipped = _iter_package_files(root)
    for msg in skipped:
        f.add("SCAN_INCOMPLETE", f"closeout scan could not read {msg}")
    lex_res = [(w, re.compile(rf"(?i)\b{re.escape(w)}\b")) for w in lexicon]
    for p in files:
        text = _read_text(p)
        if text is None:
            f.add("SCAN_INCOMPLETE", f"closeout scan could not read {p.relative_to(root)}")
            continue
        for lineno, line in enumerate(text.splitlines(), start=1):
            if _ABS_PATH_RE.search(line):
                f.add(
                    "ABSOLUTE_PATH_IN_PACKAGE",
                    f"{p.relative_to(root)}:{lineno}: machine-specific path in the final package",
                )
                break
        for w, wre in lex_res:
            for lineno, line in enumerate(text.splitlines(), start=1):
                if wre.search(line):
                    f.add(
                        "SCRUB_LEXICON_HIT",
                        f"{p.relative_to(root)}:{lineno}: internal-process word {w!r} in a public artifact",
                    )
                    break

    ledger_rel = _nonempty_str(artifact, "traceability_ledger")
    ledger_p = _rel_path(root, ledger_rel, f, "traceability_ledger") if ledger_rel else None
    if ledger_p is None or not ledger_p.is_file():
        f.add("UNRESOLVED_TRACEABILITY", f"traceability ledger not found: {ledger_rel!r}")
    else:
        try:
            ledger = json.loads(ledger_p.read_text(encoding="utf-8", errors="replace"))
        except (json.JSONDecodeError, OSError) as e:
            f.add("UNRESOLVED_TRACEABILITY", f"traceability ledger unreadable: {e}")
            ledger = {}
        entries = _as_list(ledger, "entries")
        f.checked["ledger_entries"] = len(entries)
        if not entries:
            f.add("UNRESOLVED_TRACEABILITY", "traceability ledger has no entries")
        for i, e in enumerate(entries):
            eid = _nonempty_str(e, "artifact") or f"entries[{i}]"
            status = _nonempty_str(e, "status")
            if status not in {"verified", "reused"}:
                f.add(
                    "UNRESOLVED_TRACEABILITY",
                    f"{eid}: status must be 'verified' or 'reused' at closeout, got {status!r} — "
                    "no pending provenance may ship",
                )


# ---------------------------------------------------------------------------
# Verdict emission
# ---------------------------------------------------------------------------


_CHECKERS = {
    "survey": check_survey,
    "extraction": check_extraction,
    "skeleton": check_skeleton,
    "reimplementation": check_reimplementation,
    "reference-check": check_reference_check,
    "composite-gates": check_composite_gates,
    "closeout": check_closeout,
}


def _emit(phase: str, status: str, exit_code: int, f: Findings, out_json: Path | None) -> int:
    result = {
        "schema_id": SCHEMA_ID,
        "schema_version": SCHEMA_VERSION,
        "phase": phase,
        "status": status,
        "exit_code": exit_code,
        "labels": sorted(f.labels),
        "reasons": f.reasons,
        "checked": f.checked,
        "generated_at": _utc_now(),
    }
    print(json.dumps(result, ensure_ascii=False, sort_keys=True))
    if out_json is not None:
        out_json.parent.mkdir(parents=True, exist_ok=True)
        out_json.write_text(json.dumps(result, ensure_ascii=False, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    return exit_code


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--phase", required=True, choices=PHASES)
    p.add_argument("--artifact", type=Path, required=True, help="Phase artifact JSON (schemas in references/contract.md).")
    p.add_argument("--package-root", type=Path, default=None, help="Package tree root (required for file-touching phases).")
    p.add_argument("--out-json", type=Path, default=None, help="Also write the verdict JSON here.")
    args = p.parse_args()

    f = Findings()

    def _error(reason: str) -> int:
        f.add("INPUT_ERROR", reason)
        print(f"ERROR: {reason}", file=sys.stderr)
        return _emit(args.phase, "error", 2, f, args.out_json)

    try:
        root: Path | None = None
        if args.phase in _PHASES_NEED_ROOT:
            if args.package_root is None:
                return _error(f"--package-root is required for phase {args.phase}")
            root = args.package_root.resolve()
            if not root.is_dir():
                return _error(f"package root is not a directory: {args.package_root}")
        elif args.package_root is not None:
            root = args.package_root.resolve()

        if not args.artifact.is_file():
            return _error(f"artifact not found: {args.artifact}")
        try:
            artifact = json.loads(args.artifact.read_text(encoding="utf-8", errors="replace"))
        except (json.JSONDecodeError, OSError) as e:
            return _error(f"artifact is not valid JSON: {e}")
        if not isinstance(artifact, dict):
            return _error("artifact must be a JSON object")

        _CHECKERS[args.phase](artifact, root, f)

        for reason in f.reasons:
            print(f"FINDING: {reason}", file=sys.stderr)
        if f.labels:
            print(f"- Phase {args.phase}: FAIL ({len(f.reasons)} finding(s))", file=sys.stderr)
            return _emit(args.phase, "fail", 1, f, args.out_json)
        print(f"- Phase {args.phase}: PASS", file=sys.stderr)
        return _emit(args.phase, "pass", 0, f, args.out_json)
    except Exception as e:  # fail-closed: a crash still leaves a machine verdict
        return _error(f"unexpected gate error: {type(e).__name__}: {e}")


if __name__ == "__main__":
    raise SystemExit(main())
