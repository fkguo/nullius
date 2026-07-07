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
# Code files that must be covered by the traceability ledger (prose/config
# files carry no algorithmic content to trace).
_CODE_EXTS = _SCAN_EXTS - {".md", ".txt", ".json", ".toml", ".yaml", ".yml", ".cfg", ".ini"}
_MAX_SCAN_BYTES = 2_000_000
# The metacharacter right after each prefix is deliberate: it marks this as a
# detector pattern, not a machine-specific path.
_ABS_PATH_RE = re.compile(r"(?:/Users/|/home/|[A-Za-z]:\\Users\\)[A-Za-z0-9._-]+")

# Reviewer verdict formats accepted for the reimplementation phase.
# MIRRORED from the review-swarm output contract
# (skills/review-swarm/scripts/bin/review_contract.py) — the anti-drift lock
# cross-checks this mirror against the source, so contract evolution there
# fails CI here instead of silently diverging.
_REVIEW_MD_RE = re.compile(r"^\s*VERDICT:\s*([A-Z_]+)\b")
_REVIEW_REQUIRED_HEADERS = [
    "## Blockers",
    "## Non-blocking",
    "## Real-research fit",
    "## Robustness & safety",
    "## Specific patch suggestions",
]
_REVIEW_JSON_REQUIRED_FIELDS = {"blocking_issues", "verdict", "summary"}
_FENCED_JSON_RE = re.compile(r"^```(?:json)?\s*\n(.*)\n```\s*$", re.DOTALL)
# Absence statements offered as "prior art" for an originality claim.
# Anchored to the START of the statement: a genuine prior-art statement that
# ALSO notes missing code ("Paper A derives an equivalent algorithm; no
# public code was released") is not absence-only.
_ABSENCE_STATEMENT_RE = re.compile(
    r"(?i)^\s*no\s+(?:public\s+|open[- ]source\s+)?(?:code|implementation|package|software)\b"
)

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

    def note(self, reason: str) -> None:
        """A non-failing audit note: lands in reasons (visible in the machine
        verdict) without a label, so it does not fail the phase."""
        self.reasons.append(f"NOTE: {reason}")


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
    paths in manifests are non-portable, and a relative path that escapes the
    package root (via '..') could satisfy a check with a file the package does
    not contain; both fail closed."""
    p = raw.strip()
    if not p:
        f.add("MISSING_PATH", f"{ctx}: empty path")
        return None
    if Path(p).is_absolute() or _ABS_PATH_RE.search(p):
        f.add("ABSOLUTE_PATH_IN_MANIFEST", f"{ctx}: manifest path must be package-root-relative: {p!r}")
        return None
    resolved = (root / p).resolve()
    if not resolved.is_relative_to(root.resolve()):
        f.add(
            "PATH_ESCAPES_PACKAGE_ROOT",
            f"{ctx}: {p!r} resolves outside the package root — a check satisfied by an external "
            "file certifies nothing about the package",
        )
        return None
    return resolved


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
            if isinstance(s, dict)
            and _nonempty_str(s, "query") and _nonempty_str(s, "venue") and _nonempty_str(s, "date")
        ]
        if not ok_searches:
            f.add("MISSING_SEARCH_LOG", f"{cid}: no fully recorded searches (each needs query + venue + date)")
        prior = _as_list(comp, "strongest_prior_art")
        prior_ok = [
            p for p in prior
            if isinstance(p, dict)
            and _nonempty_str(p, "statement") and _nonempty_str(p, "source") and _nonempty_str(p, "locator")
        ]
        originality = bool(comp.get("originality_claim", False)) if isinstance(comp, dict) else False
        if originality and not prior_ok:
            f.add(
                "ORIGINALITY_WITHOUT_STRONGEST_PRIOR",
                f"{cid}: originality_claim requires naming the strongest existing statement found "
                "by a focused search (strongest_prior_art entries need statement + source + locator)",
            )
        # An originality claim propped up only by absence statements is the
        # absence being laundered through the prior-art field.
        if originality and prior_ok and all(
            _ABSENCE_STATEMENT_RE.search(_nonempty_str(p, "statement")) for p in prior_ok
        ):
            f.add(
                "ABSENCE_PROMOTED_TO_NOVELTY",
                f"{cid}: every strongest_prior_art statement is an absence statement ('no public "
                "code/implementation found') — absence is a search RESULT, not prior art; name the "
                "closest existing METHOD statement instead",
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
            if p is None:
                continue
            # A scan exclusion must be a STRICT subdirectory of the package
            # root: "." (or any path resolving to the root or escaping it)
            # would hollow out the entire absolute-path scan.
            if p == root or not p.is_relative_to(root):
                f.add(
                    "EXCLUSION_COVERS_ROOT",
                    f"reference_asset_dirs entry {raw!r} resolves to the package root or outside "
                    "it — an exclusion that broad would disable the path scan entirely",
                )
                continue
            exclude.append(p)
    _scan_absolute_paths(root, f, exclude)
    # An exclusion is a declared blind spot: make its size auditable in the
    # machine verdict (the closeout phase re-scans with NO exclusions).
    for e in exclude:
        n = sum(1 for p in e.rglob("*") if p.is_file() and p.suffix in _SCAN_EXTS)
        f.note(
            f"reference_asset_dirs {str(e.relative_to(root))!r} excluded {n} text file(s) from "
            "the skeleton path scan; the closeout scan has no exclusions"
        )

    if not any((root / name).is_file() for name in ("README.md", "README.rst", "README.txt")):
        f.add("MISSING_README", "package root has no README")
    if not any((root / d).is_dir() for d in ("tests", "test")):
        f.add("MISSING_TEST_SKELETON", "package root has no tests/ (or test/) directory")

    # Source dirs: the set of directories whose code the ledger must cover.
    source_dirs: list[Path] = []
    for raw in _as_list(artifact, "source_dirs"):
        if isinstance(raw, str) and raw.strip():
            p = _rel_path(root, raw, f, "source_dirs")
            if p is not None and p.is_dir():
                source_dirs.append(p)
    if not source_dirs:
        f.add(
            "MISSING_SOURCE_DIRS",
            "source_dirs must name at least one existing directory — without it, ledger coverage "
            "and export anchoring cannot be verified",
        )

    # Code files under source_dirs, collected up front: the ledger loop below
    # accepts a "path#export" fragment only when its path part names one of
    # these real source files — "#ghost" or "docs/api.md#ghost" cannot anchor
    # an export.
    source_files: list[Path] = []
    for sd in source_dirs:
        source_files.extend(
            p for p in sorted(sd.rglob("*"))
            if p.is_file() and p.suffix in _CODE_EXTS
            and not any(part in _SCAN_SKIP_DIRS for part in p.relative_to(root).parts)
        )
    f.checked["source_files"] = len(source_files)
    source_rel_set = {p.relative_to(root).as_posix() for p in source_files}

    covered_paths: set[str] = set()
    ledger_fragments: set[str] = set()
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
            art = _nonempty_str(e, "artifact")
            path_part = art.split("#", 1)[0]
            covered_paths.add(path_part)
            if "#" in art and path_part in source_rel_set:
                ledger_fragments.add(art.split("#", 1)[1])
            has_extraction = bool([x for x in _as_list(e, "extraction_ids") if isinstance(x, str) and x.strip()])
            has_reuse = bool(_nonempty_str(e, "reuse_source"))
            if not has_extraction and not has_reuse:
                f.add(
                    "UNTRACED_LEDGER_ITEM",
                    f"{eid}: every ledger entry needs extraction_ids (built from literature) or "
                    "reuse_source (adopted from an existing package)",
                )

    # Coverage is two-way: declared entries must have origins (above), and
    # every code file under source_dirs must have a ledger entry — otherwise
    # "nothing enters the package without an origin" is a one-way promise.
    for p in source_files:
        rel = p.relative_to(root).as_posix()
        if rel not in covered_paths:
            f.add(
                "UNTRACED_PACKAGE_FILE",
                f"{rel}: code file under source_dirs has no traceability-ledger entry — nothing "
                "enters the package without an origin",
            )

    source_texts: list[str] | None = None
    exports = _as_list(artifact, "exports")
    f.checked["exports"] = len(exports)
    if not exports:
        f.add("MISSING_EXPORT_MAP", "no exports declared — the export <-> doc <-> test map is required")
    for i, ex in enumerate(exports):
        name = _nonempty_str(ex, "name") or f"exports[{i}]"
        name_re = re.compile(rf"\b{re.escape(name)}\b")
        doc = _nonempty_str(ex, "doc_path")
        doc_p = _rel_path(root, doc, f, f"exports[{name}].doc_path") if doc else None
        if doc_p is None or not doc_p.is_file():
            f.add("EXPORT_MISSING_DOC", f"{name}: documented-at file not found: {doc!r}")
        elif not name_re.search(_read_text(doc_p) or ""):
            f.add("EXPORT_DOC_UNANCHORED", f"{name}: doc file {doc!r} never mentions the export")
        test = _nonempty_str(ex, "test_path")
        test_p = _rel_path(root, test, f, f"exports[{name}].test_path") if test else None
        if test_p is None or not test_p.is_file():
            f.add("EXPORT_MISSING_TEST", f"{name}: test-skeleton file not found: {test!r}")
        elif not name_re.search(_read_text(test_p) or ""):
            f.add("EXPORT_TEST_UNANCHORED", f"{name}: test file {test!r} never mentions the export")
        if source_dirs:
            if source_texts is None:
                source_texts = [_read_text(p) or "" for p in source_files]
            if not any(name_re.search(t) for t in source_texts):
                f.add(
                    "EXPORT_NOT_IN_SOURCE",
                    f"{name}: export name appears nowhere under source_dirs — the map must anchor "
                    "to code that exists",
                )
        # The load-bearing source leg: the export must be a traceability-ledger
        # artifact "path#export" whose path names a REAL code file under
        # source_dirs. A word-boundary mention in a source comment cannot fake
        # this leg, and neither can "#export" with an empty or non-source path.
        if name not in ledger_fragments:
            f.add(
                "EXPORT_NOT_IN_LEDGER",
                f"{name}: no traceability-ledger entry '<source file>#{name}' whose path part names "
                "an existing code file under source_dirs — every export is a package artifact and "
                "needs an origin like any other",
            )


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
                # Identical stems cannot be textually distinguished from
                # self-reference (two files both named solver.* each mention
                # their own name), and very short stems match everywhere;
                # both cases are documented approximations in contract.md.
                if other_p.stem == impl_p.stem or len(other_p.stem) < 3:
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
            state, why = _review_state(v_p)
            if state == "unrecognized":
                f.add(
                    "REVIEW_VERDICT_UNRECOGNIZED",
                    f"{mid}: review verdict {raw!r} does not follow the review output contract "
                    f"({why}) — a misformatted verdict is diagnosed as such, not silently approved",
                )
            elif state == "not_approved":
                f.add(
                    "REVIEW_NOT_APPROVED",
                    f"{mid}: review verdict {raw!r} is not an approval ({why}) — convergence is "
                    "declared by the reviewer, not by the implementer",
                )


def _review_state(path: Path) -> tuple[str, str]:
    """Classify a reviewer verdict file: approved / not_approved / unrecognized.

    Accepted formats (mirrored from the review-swarm output contract; see
    _REVIEW_REQUIRED_HEADERS / _REVIEW_JSON_REQUIRED_FIELDS above):
    - JSON (optionally in a ```json fence): required fields `verdict`,
      `blocking_issues`, `summary`; approval needs verdict PASS AND an empty
      blocking_issues list.
    - Markdown: first non-empty line `VERDICT: READY|NOT_READY`, ALL required
      report headers present (a bare VERDICT line is a stub, not a review),
      and — for approval — no blocker items under `## Blockers`.
    Anything else is `unrecognized` (diagnosed, never approved).
    """
    text = _read_text(path)
    if text is None:
        return "unrecognized", "unreadable file"
    stripped = text.strip()
    fenced = _FENCED_JSON_RE.match(stripped)
    if fenced:
        stripped = fenced.group(1).strip()
    if stripped.startswith("{"):
        try:
            obj = json.loads(stripped)
        except json.JSONDecodeError as e:
            return "unrecognized", f"invalid JSON ({e})"
        if not isinstance(obj, dict):
            return "unrecognized", "JSON verdict must be an object"
        missing = sorted(_REVIEW_JSON_REQUIRED_FIELDS - set(obj))
        if missing:
            return "unrecognized", f"JSON verdict is missing required field(s): {', '.join(missing)}"
        verdict = str(obj.get("verdict", "")).strip().upper()
        blocking = obj.get("blocking_issues")
        if not isinstance(blocking, list):
            return "unrecognized", "blocking_issues must be a list"
        if verdict == "PASS":
            if blocking:
                return "not_approved", f"verdict PASS but {len(blocking)} blocking issue(s) recorded"
            return "approved", ""
        if verdict == "FAIL":
            return "not_approved", "verdict FAIL"
        return "unrecognized", f"unknown JSON verdict {obj.get('verdict')!r}"
    # Fenced code blocks are quoted content, not report structure: a heading
    # or a VERDICT line inside ``` fences must not count.
    lines = _unfenced_lines(stripped.splitlines())
    first = next((ln for ln in lines if ln.strip()), "")
    m = _REVIEW_MD_RE.match(first)
    if not m:
        return "unrecognized", "first non-empty line is not a 'VERDICT: ...' line"
    # Required headers must be real heading LINES: a prose mention of
    # "## Blockers" inside a paragraph is not a report section.
    heading_lines = {ln.strip() for ln in lines if ln.strip().startswith("#")}
    missing_headers = [h for h in _REVIEW_REQUIRED_HEADERS if h not in heading_lines]
    if missing_headers:
        return "unrecognized", (
            "Markdown verdict is missing required header line(s): "
            + ", ".join(missing_headers)
            + " — a bare VERDICT line without the contract sections is not a review report"
        )
    token = m.group(1)
    if token == "NOT_READY":
        return "not_approved", "verdict NOT_READY"
    if token != "READY":
        return "unrecognized", f"unknown Markdown verdict {token!r}"
    blockers = _md_section_items(lines, "blockers")
    if blockers:
        return "not_approved", f"verdict READY but {len(blockers)} blocker item(s) listed"
    return "approved", ""


def _unfenced_lines(lines: list[str]) -> list[str]:
    out: list[str] = []
    in_fence = False
    for ln in lines:
        if ln.strip().startswith("```"):
            in_fence = not in_fence
            continue
        if not in_fence:
            out.append(ln)
    return out


def _md_section_items(lines: list[str], heading: str) -> list[str]:
    """Non-trivial bullet/numbered items under a '## <heading>' section."""
    items: list[str] = []
    in_section = False
    for ln in lines:
        s = ln.strip()
        if s.startswith("#"):
            in_section = s.lstrip("#").strip().lower().startswith(heading)
            continue
        if not in_section or not s:
            continue
        if re.match(r"^(?:[-*+]|\d+[.)])\s+", s):
            body = re.sub(r"^(?:[-*+]|\d+[.)])\s+", "", s).strip().lower()
            if body and body not in {"(none)", "none", "none.", "n/a"}:
                items.append(s)
    return items


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
        # A missing error counts as 0: that SHRINKS the combined uncertainty,
        # i.e. tightens the ceiling on error_scale (omitting an error can
        # never loosen the check). And the ceiling must be ANCHORED: with no
        # non-zero quoted uncertainty at all, any positive error_scale is a
        # free parameter that could launder any tolerance.
        combined = math.hypot(ce or 0.0, re_ or 0.0)
        if combined <= 0:
            f.add(
                "NON_DIAGNOSTIC_TOLERANCE",
                f"{cid}: no non-zero quoted uncertainty anchors error_scale — quote at least the "
                "numerical precision of the computed value as computed.error (an exact reference "
                "still leaves the computation with finite precision)",
            )
        elif scale > combined * (1 + _REL_SLACK):
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
            # Identity + consistency of the sibling artifact
            # (numerical_reliability_matrix_v1): schema_version 1, counts
            # that agree with the rows, and per-row id + verdict. Full
            # per-row evidence rules stay owned by the sibling contract.
            def _strict_int(v: Any) -> int | None:
                # JSON true == 1 in Python; a boolean is never a count.
                return v if isinstance(v, int) and not isinstance(v, bool) else None

            matrix = obj.get("matrix")
            not_reliable = obj.get("not_reliable")
            if _strict_int(obj.get("schema_version")) != 1:
                f.add(
                    "GATE_NOT_PASSED",
                    f"numerical_reliability: schema_version must be 1 "
                    f"(got {obj.get('schema_version')!r}) — an unversioned object is not a "
                    "numerical_reliability_matrix_v1 artifact",
                )
            elif not (isinstance(matrix, list) and len(matrix) >= 1 and isinstance(not_reliable, list)):
                f.add(
                    "GATE_NOT_PASSED",
                    f"numerical_reliability: requires a non-empty matrix and a not_reliable list "
                    f"(got matrix={'list[' + str(len(matrix)) + ']' if isinstance(matrix, list) else matrix!r}, "
                    f"not_reliable={not_reliable!r})",
                )
            else:
                malformed = [
                    f"matrix[{i}]" for i, row in enumerate(matrix)
                    if not (isinstance(row, dict) and str(row.get("id", "")).strip() and str(row.get("verdict", "")).strip())
                ]
                # Recompute from the rows: the summary fields are not trusted.
                bad_rows = [
                    str(row.get("id", f"matrix[{i}]"))
                    for i, row in enumerate(matrix)
                    if isinstance(row, dict) and row.get("verdict") != "reliable"
                ]
                reliable_rows = sum(
                    1 for row in matrix if isinstance(row, dict) and row.get("verdict") == "reliable"
                )
                if malformed:
                    f.add(
                        "GATE_NOT_PASSED",
                        f"numerical_reliability: malformed matrix row(s) {malformed[:5]!r} — every row "
                        "needs a non-empty id and verdict",
                    )
                elif bad_rows:
                    f.add(
                        "GATE_NOT_PASSED",
                        f"numerical_reliability: matrix row(s) not 'reliable': {bad_rows[:5]!r} — "
                        "row verdicts are recomputed here; the summary list is not trusted",
                    )
                elif not_reliable:
                    f.add(
                        "GATE_NOT_PASSED",
                        f"numerical_reliability: not_reliable={not_reliable!r} while every matrix row "
                        "reads 'reliable' — the verdict file is self-inconsistent",
                    )
                elif _strict_int(obj.get("reliable")) != reliable_rows or (
                    "total" in obj and _strict_int(obj.get("total")) != len(matrix)
                ):
                    f.add(
                        "GATE_NOT_PASSED",
                        f"numerical_reliability: count fields disagree with the rows "
                        f"(reliable={obj.get('reliable')!r} vs {reliable_rows} reliable row(s); "
                        f"total={obj.get('total')!r} vs {len(matrix)} row(s)) — the artifact is "
                        "self-inconsistent",
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

    covered_paths: set[str] = set()
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
            covered_paths.add(_nonempty_str(e, "artifact").split("#", 1)[0])
            status = _nonempty_str(e, "status")
            if status not in {"verified", "reused"}:
                f.add(
                    "UNRESOLVED_TRACEABILITY",
                    f"{eid}: status must be 'verified' or 'reused' at closeout, got {status!r} — "
                    "no pending provenance may ship",
                )

    # Coverage re-check on the FINAL tree: every code file under source_dirs
    # must still be traced (a file added after the skeleton phase must not
    # ship without an origin).
    source_dirs: list[Path] = []
    for raw in _as_list(artifact, "source_dirs"):
        if isinstance(raw, str) and raw.strip():
            p = _rel_path(root, raw, f, "source_dirs")
            if p is not None and p.is_dir():
                source_dirs.append(p)
    if not source_dirs:
        f.add(
            "MISSING_SOURCE_DIRS",
            "source_dirs must name at least one existing directory — the closeout coverage "
            "re-check cannot run without it",
        )
    for sd in source_dirs:
        for p in sorted(sd.rglob("*")):
            if not (p.is_file() and p.suffix in _CODE_EXTS):
                continue
            if any(part in _SCAN_SKIP_DIRS for part in p.relative_to(root).parts):
                continue
            rel = p.relative_to(root).as_posix()
            if rel not in covered_paths:
                f.add(
                    "UNTRACED_PACKAGE_FILE",
                    f"{rel}: code file under source_dirs has no traceability-ledger entry at "
                    "closeout — nothing ships without an origin",
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

_PHASE_SCHEMA_IDS = {
    "survey": "survey_decision_v1",
    "extraction": "extraction_manifest_v1",
    "skeleton": "skeleton_manifest_v1",
    "reimplementation": "independence_manifest_v1",
    "reference-check": "reference_check_v1",
    "composite-gates": "composite_gates_v1",
    "closeout": "closeout_v1",
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
        # _emit must never raise: the stdout verdict above is already the
        # contract, and a crash here would re-enter the error path and print
        # a second (unparseable) verdict.
        try:
            out_json.parent.mkdir(parents=True, exist_ok=True)
            out_json.write_text(json.dumps(result, ensure_ascii=False, indent=2, sort_keys=True) + "\n", encoding="utf-8")
        except OSError as e:
            print(f"WARNING: could not write --out-json {out_json}: {e}", file=sys.stderr)
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
        expected_schema = _PHASE_SCHEMA_IDS[args.phase]
        if artifact.get("schema_id") != expected_schema:
            return _error(
                f"artifact schema_id must be {expected_schema!r} for phase {args.phase} "
                f"(got {artifact.get('schema_id')!r}) — the wrong artifact handed to the wrong "
                "phase must not be silently accepted"
            )

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
