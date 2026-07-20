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

Exit codes: 0 pass, 1 gate failure (findings), 2 usage, unreadable manifest,
or unsafe/unwritable --out-json.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sys
import tempfile
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

# Mirrors the result enum order in display_gate_result_v1.schema.json; the
# behavior tests and the anti-drift lock hold the two in sync.
RESULT_VALUES = (
    RESULT_PASS,
    RESULT_MISSING_VERDICT_BINDING,
    RESULT_VERDICT_MISMATCH,
    RESULT_MISSING_OVERVIEW_FIGURE,
    RESULT_INVALID_MANIFEST,
)

# The accepted outcome is fixed by the gate, never by the manifest: letting the
# caller widen acceptance would hand the verdict back to the party being judged.
ACCEPTED_VERDICT = "pass"
VERDICT_SCHEMA_ID = "quantity_verdict_v1"
VERDICT_SCHEMA_VERSION = 1
VERDICT_VALUES = frozenset({"pass", "fail"})

_BLOCK_FIELDS = frozenset({"plotted_quantities", "verdict_bindings", "overview_figure"})
_BINDING_FIELDS = frozenset({"quantity", "verdict_path", "verdict_sha256"})
_OVERVIEW_FIELDS = frozenset({"path", "archived", "sha256"})
_VERDICT_FIELDS = frozenset({"schema_id", "schema_version", "quantities", "verdict"})

_SHA256 = re.compile(r"(?:sha256:)?([0-9a-fA-F]{64})\Z", re.IGNORECASE)


class DuplicateJsonKeyError(ValueError):
    """Raised when any object in a consumed JSON document repeats a key."""


def _reject_duplicate_json_keys(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    obj: dict[str, Any] = {}
    for key, value in pairs:
        if key in obj:
            raise DuplicateJsonKeyError(f"duplicate JSON key {key!r}")
        obj[key] = value
    return obj


def _read_json_document(path: Path) -> Any:
    """Decode one JSON document with recursive duplicate-key rejection."""
    return json.loads(
        path.read_text(encoding="utf-8"),
        object_pairs_hook=_reject_duplicate_json_keys,
    )


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


def _validate_quantity_verdict_v1(artifact: Any) -> tuple[list[str] | None, str | None, str | None]:
    """Validate the complete closed shape of quantity_verdict_v1.

    The checked-in JSON Schema is the public contract and generates shared
    Python/TypeScript surfaces. This dependency-free runtime validation keeps
    the installed skill fail-closed without requiring a JSON-Schema package.
    """
    if not isinstance(artifact, dict):
        return None, None, "artifact must be a JSON object"

    unexpected = sorted(set(artifact) - _VERDICT_FIELDS)
    missing = sorted(_VERDICT_FIELDS - set(artifact))
    if unexpected:
        return None, None, f"unsupported fields: {unexpected!r}"
    if missing:
        return None, None, f"missing required fields: {missing!r}"
    if artifact.get("schema_id") != VERDICT_SCHEMA_ID:
        return None, None, f"schema_id must be {VERDICT_SCHEMA_ID!r}"
    version = artifact.get("schema_version")
    if type(version) is not int or version != VERDICT_SCHEMA_VERSION:
        return None, None, f"schema_version must be integer {VERDICT_SCHEMA_VERSION}"

    quantities = _string_list(artifact.get("quantities"))
    if quantities is None:
        return None, None, "quantities must be a non-empty list of non-blank strings"
    if len(set(quantities)) != len(quantities):
        return None, None, "quantities must contain unique identifiers"

    verdict = artifact.get("verdict")
    if not isinstance(verdict, str) or verdict not in VERDICT_VALUES:
        return None, None, f"verdict must be one of {sorted(VERDICT_VALUES)!r}"
    return quantities, verdict, None


def _protected_input_paths(manifest_path: Path) -> tuple[list[Path], bool]:
    """Return every on-disk input that --out-json must never replace.

    Manifest inspection is best-effort because an invalid manifest still has
    to produce a fail-closed result. The manifest itself is always protected.
    """
    protected = [manifest_path]
    try:
        manifest = _read_json_document(manifest_path)
    except (OSError, ValueError):
        return protected, False
    if not isinstance(manifest, dict):
        return protected, False
    block = manifest.get("display_acceptance")
    if not isinstance(block, dict):
        return protected, True

    base_dir = manifest_path.resolve().parent
    bindings = block.get("verdict_bindings")
    if isinstance(bindings, list):
        for binding in bindings:
            if not isinstance(binding, dict):
                continue
            value = binding.get("verdict_path")
            if isinstance(value, str) and value.strip():
                protected.append(_resolve(base_dir, value.strip()))
    overview = block.get("overview_figure")
    if isinstance(overview, dict):
        value = overview.get("path")
        if isinstance(value, str) and value.strip():
            protected.append(_resolve(base_dir, value.strip()))
    return protected, True


def _path_conflicts_with_input_slot(output: Path, input_slot: Path) -> bool:
    """Detect aliases and ancestor/descendant paths that could mutate a slot.

    Descendants matter even when an input is currently missing: creating
    ``missing-input/result.json`` would turn the declared file slot into a
    directory before the gate reports that the evidence is absent. Ancestors
    matter too: writing ``missing-dir`` would turn the required parent of
    ``missing-dir/verdict.json`` into a file.
    """
    try:
        canonical_output = output.expanduser().resolve(strict=False)
        canonical_input = input_slot.expanduser().resolve(strict=False)
        if (
            canonical_output == canonical_input
            or canonical_input in canonical_output.parents
            or canonical_output in canonical_input.parents
        ):
            return True
    except (OSError, RuntimeError):
        pass
    try:
        return output.exists() and input_slot.exists() and os.path.samefile(output, input_slot)
    except OSError:
        return False


def _atomic_write_text(path: Path, text: str) -> None:
    """Persist text through a same-directory temporary file and os.replace."""
    target = path.expanduser()
    parent = target.parent
    parent.mkdir(parents=True, exist_ok=True)
    if target.is_dir():
        raise IsADirectoryError(str(target))

    temp_path: Path | None = None
    try:
        fd, temp_name = tempfile.mkstemp(prefix=f".{target.name}.", suffix=".tmp", dir=str(parent))
        temp_path = Path(temp_name)
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as handle:
            handle.write(text)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temp_path, target)
        temp_path = None
    finally:
        if temp_path is not None:
            try:
                temp_path.unlink()
            except FileNotFoundError:
                pass


def _out_json_failure(manifest_path: Path, kind: str, message: str) -> dict[str, Any]:
    return {
        "schema_version": SCHEMA_VERSION,
        "manifest": str(manifest_path),
        "result": RESULT_INVALID_MANIFEST,
        "findings": [_finding(kind, RESULT_INVALID_MANIFEST, message)],
        "quantities_declared": 0,
        "bindings_checked": 0,
        "overview_figure": None,
    }


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

    for key in sorted(set(binding) - _BINDING_FIELDS):
        findings.append(
            _finding(
                "unexpected-field",
                RESULT_MISSING_VERDICT_BINDING,
                f"{label} declares unsupported field {key!r}: the gate's acceptance contract is "
                "fixed and cannot be widened or reconfigured from the manifest",
            )
        )

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
        artifact = _read_json_document(verdict_path)
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
    covered, outcome, schema_error = _validate_quantity_verdict_v1(artifact)
    if schema_error is not None:
        findings.append(
            _finding(
                "verdict-schema-invalid",
                RESULT_VERDICT_MISMATCH,
                f"{label} ({quantity!r}) verdict artifact does not satisfy "
                f"{VERDICT_SCHEMA_ID}: {schema_error}",
                quantity=quantity,
                path=str(verdict_path),
            )
        )
        return quantity

    assert covered is not None

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

    if outcome != ACCEPTED_VERDICT:
        findings.append(
            _finding(
                "verdict-not-accepted",
                RESULT_VERDICT_MISMATCH,
                f"{label} ({quantity!r}) verdict artifact records outcome {outcome!r}; only "
                f"{ACCEPTED_VERDICT!r} is accepted, and the accepted outcome is fixed by the gate, "
                "never by the manifest",
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

    for key in sorted(set(overview) - _OVERVIEW_FIELDS):
        findings.append(
            _finding(
                "unexpected-field",
                RESULT_MISSING_OVERVIEW_FIGURE,
                f"overview_figure declares unsupported field {key!r}: the gate's acceptance "
                "contract is fixed and cannot be widened or reconfigured from the manifest",
            )
        )

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
        manifest = _read_json_document(manifest_path)
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
            for key in sorted(set(block) - _BLOCK_FIELDS):
                findings.append(
                    _finding(
                        "unexpected-field",
                        RESULT_MISSING_VERDICT_BINDING,
                        f"display_acceptance declares unsupported field {key!r}: the gate's "
                        "acceptance contract is fixed and cannot be widened or reconfigured "
                        "from the manifest",
                    )
                )
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
    try:
        args = parser.parse_args(argv)
    except SystemExit as exc:
        if exc.code == 0:  # --help
            return 0
        # A machine consumer reading only the payload must still see a
        # fail-closed verdict when the invocation itself was malformed.
        payload = {
            "schema_version": SCHEMA_VERSION,
            "manifest": "(usage-error)",
            "result": RESULT_INVALID_MANIFEST,
            "findings": [
                _finding(
                    "usage-error",
                    RESULT_INVALID_MANIFEST,
                    "invalid command-line invocation (see stderr); no manifest was judged",
                )
            ],
            "quantities_declared": 0,
            "bindings_checked": 0,
            "overview_figure": None,
        }
        print(json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True))
        return 2

    result = check_manifest(Path(args.manifest))

    if args.out_json is not None:
        manifest_path = Path(args.manifest)
        protected_inputs, declarations_recovered = _protected_input_paths(manifest_path)
        if not declarations_recovered:
            failure = _out_json_failure(
                manifest_path,
                "out-json-input-discovery-failed",
                "refusing --out-json because manifest input declarations could not be recovered unambiguously",
            )
            print(json.dumps(failure, ensure_ascii=False, indent=2, sort_keys=True))
            return 2
        if any(_path_conflicts_with_input_slot(args.out_json, input_path) for input_path in protected_inputs):
            failure = _out_json_failure(
                manifest_path,
                "out-json-protected-input",
                "--out-json must not alias, contain, or be contained by the manifest, "
                "a bound verdict artifact, or the overview input",
            )
            print(json.dumps(failure, ensure_ascii=False, indent=2, sort_keys=True))
            return 2
        try:
            _atomic_write_text(
                args.out_json,
                json.dumps(result, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
            )
        except Exception:
            failure = _out_json_failure(
                manifest_path,
                "out-json-write-failed",
                "could not persist --out-json through a same-directory atomic write",
            )
            print(json.dumps(failure, ensure_ascii=False, indent=2, sort_keys=True))
            return 2

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
