#!/usr/bin/env python3
"""Display-acceptance gate: refuse the display surface until every plotted
quantity is bound to a verification verdict and an all-component overview
figure is archived.

Why this gate exists: an agent naturally builds acceptance checks only for the
conclusions it has declared, so output components that were never declared are
never checked; and a figure that enters a manuscript before its verification
("ship the figure now, backfill the check later") lets an error survive behind
a smooth-looking rendering. This gate closes both holes at the moment a figure
or table becomes durable or outward-facing.

The gate reads the figure's provenance manifest and judges its
`display_acceptance` block:

- every declared plotted quantity must carry a verdict binding whose artifact
  exists, hashes to the recorded SHA-256 digest, explicitly covers that
  quantity, and records an accepted outcome;
- a human-review overview figure spanning all output components must be
  declared as archived and present on disk.

The verdict is computed here and only here; callers must not self-assess.
Fail-closed: missing or unverifiable evidence is a failure, never a pass.

Exit codes: 0 pass, 1 gate failure (findings), 2 usage / unreadable manifest.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
from pathlib import Path
from typing import Any

SCHEMA_VERSION = 1

RESULT_PASS = "pass"
RESULT_MISSING_VERDICT_BINDING = "missing_verdict_binding"
RESULT_VERDICT_MISMATCH = "verdict_mismatch"
RESULT_MISSING_OVERVIEW_FIGURE = "missing_overview_figure"
RESULT_INVALID_MANIFEST = "invalid_manifest"

# Order determines the roll-up when findings span several categories.
CATEGORY_PRIORITY = (
    RESULT_INVALID_MANIFEST,
    RESULT_MISSING_VERDICT_BINDING,
    RESULT_VERDICT_MISMATCH,
    RESULT_MISSING_OVERVIEW_FIGURE,
)

RESULT_VALUES = (RESULT_PASS,) + tuple(
    c for c in CATEGORY_PRIORITY if c != RESULT_INVALID_MANIFEST
) + (RESULT_INVALID_MANIFEST,)

DEFAULT_ACCEPTED_VERDICTS = ("pass",)

_SHA256 = re.compile(r"(?:sha256:)?([0-9a-fA-F]{64})\Z")


def _normalise_sha256(raw: Any) -> str | None:
    if not isinstance(raw, str):
        return None
    match = _SHA256.fullmatch(raw.strip())
    return match.group(1).lower() if match else None


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _finding(kind: str, category: str, message: str, *, quantity: str | None = None, path: str | None = None) -> dict[str, Any]:
    out: dict[str, Any] = {"kind": kind, "category": category, "message": message}
    if quantity is not None:
        out["quantity"] = quantity
    if path is not None:
        out["path"] = path
    return out


def _string_list(value: Any) -> list[str] | None:
    if not isinstance(value, list) or not value:
        return None
    if any(not isinstance(item, str) or not item.strip() for item in value):
        return None
    return [item.strip() for item in value]


def _resolve(base_dir: Path, path_s: str) -> Path:
    p = Path(path_s)
    return p if p.is_absolute() else base_dir / p


def _check_binding(
    binding: Any,
    index: int,
    plotted: list[str],
    base_dir: Path,
    findings: list[dict[str, Any]],
) -> str | None:
    """Judge one verdict binding. Returns the bound quantity when the binding
    is well-formed enough to claim one, else None."""
    label = f"verdict_bindings[{index}]"
    if not isinstance(binding, dict):
        findings.append(_finding("binding-malformed", RESULT_MISSING_VERDICT_BINDING, f"{label} is not an object"))
        return None

    quantity = binding.get("quantity")
    if not isinstance(quantity, str) or not quantity.strip():
        findings.append(
            _finding("binding-malformed", RESULT_MISSING_VERDICT_BINDING, f"{label} has no quantity identifier")
        )
        return None
    quantity = quantity.strip()

    if quantity not in plotted:
        findings.append(
            _finding(
                "binding-unknown-quantity",
                RESULT_VERDICT_MISMATCH,
                f"{label} binds {quantity!r}, which is not among the declared plotted quantities",
                quantity=quantity,
            )
        )
        return quantity

    verdict_path_s = binding.get("verdict_path")
    if not isinstance(verdict_path_s, str) or not verdict_path_s.strip():
        findings.append(
            _finding(
                "binding-malformed",
                RESULT_MISSING_VERDICT_BINDING,
                f"{label} ({quantity!r}) has no verdict_path",
                quantity=quantity,
            )
        )
        return quantity

    declared_hash = _normalise_sha256(binding.get("verdict_sha256"))
    if declared_hash is None:
        findings.append(
            _finding(
                "verdict-hash-malformed",
                RESULT_VERDICT_MISMATCH,
                f"{label} ({quantity!r}) verdict_sha256 is missing or not a SHA-256 digest",
                quantity=quantity,
            )
        )
        return quantity

    accepted_raw = binding.get("accepted_verdicts", list(DEFAULT_ACCEPTED_VERDICTS))
    accepted = _string_list(accepted_raw)
    if accepted is None:
        findings.append(
            _finding(
                "binding-malformed",
                RESULT_MISSING_VERDICT_BINDING,
                f"{label} ({quantity!r}) accepted_verdicts must be a non-empty list of non-empty strings",
                quantity=quantity,
            )
        )
        return quantity

    verdict_path = _resolve(base_dir, verdict_path_s.strip())
    if not verdict_path.is_file():
        findings.append(
            _finding(
                "verdict-not-found",
                RESULT_MISSING_VERDICT_BINDING,
                f"{label} ({quantity!r}) verdict artifact not found: {verdict_path}",
                quantity=quantity,
                path=str(verdict_path),
            )
        )
        return quantity

    try:
        actual_hash = _sha256_file(verdict_path)
    except OSError as exc:
        findings.append(
            _finding(
                "verdict-unreadable",
                RESULT_VERDICT_MISMATCH,
                f"{label} ({quantity!r}) verdict artifact unreadable: {exc}",
                quantity=quantity,
                path=str(verdict_path),
            )
        )
        return quantity

    if actual_hash != declared_hash:
        findings.append(
            _finding(
                "verdict-hash-mismatch",
                RESULT_VERDICT_MISMATCH,
                f"{label} ({quantity!r}) verdict artifact hash {actual_hash} does not match the "
                f"digest recorded in the figure manifest ({declared_hash}); the bound verdict is "
                "stale or was replaced after binding",
                quantity=quantity,
                path=str(verdict_path),
            )
        )
        return quantity

    try:
        artifact = json.loads(verdict_path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        findings.append(
            _finding(
                "verdict-unreadable",
                RESULT_VERDICT_MISMATCH,
                f"{label} ({quantity!r}) verdict artifact is not valid JSON: {exc}",
                quantity=quantity,
                path=str(verdict_path),
            )
        )
        return quantity
    if not isinstance(artifact, dict):
        findings.append(
            _finding(
                "verdict-unreadable",
                RESULT_VERDICT_MISMATCH,
                f"{label} ({quantity!r}) verdict artifact is not a JSON object",
                quantity=quantity,
                path=str(verdict_path),
            )
        )
        return quantity

    covered = _string_list(artifact.get("quantities"))
    if covered is None:
        findings.append(
            _finding(
                "verdict-quantities-undeclared",
                RESULT_VERDICT_MISMATCH,
                f"{label} ({quantity!r}) verdict artifact declares no quantities[] list, so it "
                "cannot demonstrate that it covers the plotted quantity",
                quantity=quantity,
                path=str(verdict_path),
            )
        )
        return quantity

    if quantity not in covered:
        findings.append(
            _finding(
                "quantity-not-covered",
                RESULT_VERDICT_MISMATCH,
                f"{label} verdict artifact covers {covered!r} but not the plotted quantity {quantity!r}",
                quantity=quantity,
                path=str(verdict_path),
            )
        )
        return quantity

    outcome = artifact.get("verdict")
    if not isinstance(outcome, str) or outcome not in accepted:
        findings.append(
            _finding(
                "verdict-not-accepted",
                RESULT_VERDICT_MISMATCH,
                f"{label} ({quantity!r}) verdict artifact records outcome {outcome!r}, which is not "
                f"among the accepted outcomes {accepted!r}",
                quantity=quantity,
                path=str(verdict_path),
            )
        )
        return quantity

    return quantity


def _check_overview(overview: Any, base_dir: Path, findings: list[dict[str, Any]]) -> str | None:
    if overview is None:
        findings.append(
            _finding(
                "overview-undeclared",
                RESULT_MISSING_OVERVIEW_FIGURE,
                "display_acceptance.overview_figure is missing: a human-review overview figure "
                "spanning all output components must be generated and archived before the figure "
                "enters any display surface",
            )
        )
        return None
    if not isinstance(overview, dict):
        findings.append(
            _finding(
                "overview-undeclared",
                RESULT_MISSING_OVERVIEW_FIGURE,
                "display_acceptance.overview_figure must be an object with path and archived fields",
            )
        )
        return None

    path_s = overview.get("path")
    declared_path = path_s.strip() if isinstance(path_s, str) and path_s.strip() else None
    if declared_path is None:
        findings.append(
            _finding(
                "overview-path-undeclared",
                RESULT_MISSING_OVERVIEW_FIGURE,
                "display_acceptance.overview_figure.path is missing or empty",
            )
        )
        return None

    if overview.get("archived") is not True:
        findings.append(
            _finding(
                "overview-not-archived",
                RESULT_MISSING_OVERVIEW_FIGURE,
                "display_acceptance.overview_figure.archived is not true: the overview figure "
                "checkbox must be an explicit, affirmed archival statement",
                path=declared_path,
            )
        )

    resolved = _resolve(base_dir, declared_path)
    if not resolved.is_file():
        findings.append(
            _finding(
                "overview-file-missing",
                RESULT_MISSING_OVERVIEW_FIGURE,
                f"overview figure not found on disk: {resolved}",
                path=str(resolved),
            )
        )
        return declared_path

    declared_hash = overview.get("sha256")
    if declared_hash is not None:
        normalised = _normalise_sha256(declared_hash)
        if normalised is None:
            findings.append(
                _finding(
                    "overview-hash-malformed",
                    RESULT_MISSING_OVERVIEW_FIGURE,
                    "display_acceptance.overview_figure.sha256 is not a SHA-256 digest",
                    path=str(resolved),
                )
            )
        else:
            try:
                actual = _sha256_file(resolved)
            except OSError as exc:
                findings.append(
                    _finding(
                        "overview-file-missing",
                        RESULT_MISSING_OVERVIEW_FIGURE,
                        f"overview figure unreadable: {exc}",
                        path=str(resolved),
                    )
                )
                return declared_path
            if actual != normalised:
                findings.append(
                    _finding(
                        "overview-hash-mismatch",
                        RESULT_MISSING_OVERVIEW_FIGURE,
                        f"overview figure hash {actual} does not match the recorded digest {normalised}",
                        path=str(resolved),
                    )
                )
    return declared_path


def check_manifest(manifest_path: Path) -> dict[str, Any]:
    """Judge the display_acceptance block of one figure provenance manifest.

    Returns a display_gate_result_v1 payload. This function is the single
    authority for the verdict; callers consume `result` and must not re-derive
    or override it.
    """
    findings: list[dict[str, Any]] = []
    quantities_declared = 0
    bindings_checked = 0
    overview_path: str | None = None
    base_dir = manifest_path.resolve().parent

    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        findings.append(
            _finding("manifest-unreadable", RESULT_INVALID_MANIFEST, f"cannot read manifest as JSON: {exc}")
        )
        manifest = None
    if manifest is not None and not isinstance(manifest, dict):
        findings.append(
            _finding("manifest-unreadable", RESULT_INVALID_MANIFEST, "manifest is not a JSON object")
        )
        manifest = None

    if manifest is not None:
        block = manifest.get("display_acceptance")
        if not isinstance(block, dict):
            findings.append(
                _finding(
                    "display-acceptance-missing",
                    RESULT_MISSING_VERDICT_BINDING,
                    "manifest has no display_acceptance block: the figure has never been declared "
                    "for acceptance, so nothing it plots has demonstrably been checked",
                )
            )
        else:
            plotted = _string_list(block.get("plotted_quantities"))
            if plotted is None:
                findings.append(
                    _finding(
                        "plotted-quantities-undeclared",
                        RESULT_MISSING_VERDICT_BINDING,
                        "display_acceptance.plotted_quantities must be a non-empty list of quantity "
                        "identifiers: a figure with no declared quantities has an empty acceptance "
                        "surface, which is exactly the failure this gate exists to refuse",
                    )
                )
                plotted = []
            else:
                quantities_declared = len(plotted)
                duplicates = sorted({q for q in plotted if plotted.count(q) > 1})
                for q in duplicates:
                    findings.append(
                        _finding(
                            "duplicate-plotted-quantity",
                            RESULT_MISSING_VERDICT_BINDING,
                            f"plotted quantity {q!r} is declared more than once",
                            quantity=q,
                        )
                    )

            bindings = block.get("verdict_bindings")
            bound: list[str] = []
            if not isinstance(bindings, list):
                if plotted:
                    findings.append(
                        _finding(
                            "bindings-undeclared",
                            RESULT_MISSING_VERDICT_BINDING,
                            "display_acceptance.verdict_bindings must be a list with one entry per "
                            "plotted quantity",
                        )
                    )
            else:
                bindings_checked = len(bindings)
                for index, binding in enumerate(bindings):
                    quantity = _check_binding(binding, index, plotted, base_dir, findings)
                    if quantity is not None:
                        if quantity in bound:
                            findings.append(
                                _finding(
                                    "duplicate-binding",
                                    RESULT_VERDICT_MISMATCH,
                                    f"plotted quantity {quantity!r} has more than one verdict binding; "
                                    "the correspondence between quantity and verdict is ambiguous",
                                    quantity=quantity,
                                )
                            )
                        else:
                            bound.append(quantity)

            for quantity in plotted:
                if quantity not in bound:
                    findings.append(
                        _finding(
                            "missing-binding",
                            RESULT_MISSING_VERDICT_BINDING,
                            f"plotted quantity {quantity!r} has no verdict binding: it would enter "
                            "the display surface without ever having been checked",
                            quantity=quantity,
                        )
                    )

            overview_path = _check_overview(block.get("overview_figure"), base_dir, findings)

    categories = {f["category"] for f in findings}
    result = RESULT_PASS
    for category in CATEGORY_PRIORITY:
        if category in categories:
            result = category
            break

    return {
        "schema_version": SCHEMA_VERSION,
        "manifest": str(manifest_path),
        "result": result,
        "findings": findings,
        "quantities_declared": quantities_declared,
        "bindings_checked": bindings_checked,
        "overview_figure": overview_path,
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--manifest", required=True, help="figure provenance manifest (JSON sidecar)")
    parser.add_argument("--json", action="store_true", help="emit the display_gate_result_v1 payload on stdout")
    parser.add_argument("--out-json", type=Path, default=None, help="also persist the payload to this path")
    args = parser.parse_args(argv)

    result = check_manifest(Path(args.manifest))

    if args.out_json is not None:
        args.out_json.parent.mkdir(parents=True, exist_ok=True)
        args.out_json.write_text(json.dumps(result, ensure_ascii=False, indent=2, sort_keys=True) + "\n", encoding="utf-8")

    if args.json:
        print(json.dumps(result, ensure_ascii=False, indent=2, sort_keys=True))
    else:
        for finding in result["findings"]:
            print(f"{finding['kind']} [{finding['category']}]: {finding['message']}")
        summary = (
            f"display acceptance {result['result']}: "
            f"{result['quantities_declared']} plotted quantities, "
            f"{result['bindings_checked']} bindings checked, "
            f"overview={result['overview_figure'] or 'undeclared'}"
        )
        print(summary)

    if result["result"] == RESULT_PASS:
        return 0
    if result["result"] == RESULT_INVALID_MANIFEST:
        return 2
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
