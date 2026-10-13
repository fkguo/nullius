"""Cell semantics for the display-acceptance gate; no scientific accuracy gate.

Read final HTML cells or a reviewed post-render extraction, then compare the
visible values, units, identities and order with the byte-pinned source.
See references/display-semantics.md for the small sidecar contract and limits.
"""

from __future__ import annotations

from decimal import Decimal, InvalidOperation, localcontext
from html.parser import HTMLParser
from pathlib import Path
import json
import re
from typing import Any


class SemanticError(ValueError):
    def __init__(self, kind: str, message: str):
        self.kind = kind
        super().__init__(message)


def _require(ok: bool, kind: str, message: str) -> None:
    if not ok:
        raise SemanticError(kind, message)


def _text(value: Any) -> bool:
    return isinstance(value, str) and bool(value.strip())


_NUMBER = re.compile(r"[+-]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?\Z")


def _decimal(value: Any) -> Decimal:
    # Strings preserve the precision actually printed; binary floats cannot.
    _require(isinstance(value, str) and bool(_NUMBER.fullmatch(value)),
             "number-invalid", f"expected a decimal numeric token, got {value!r}")
    number = Decimal(value)
    _require(number.is_finite() and abs(number.adjusted()) <= 1000,
             "number-invalid", "non-finite or excessive numeric exponent")
    _require(len(number.as_tuple().digits) <= 1000 and abs(number.as_tuple().exponent) <= 1000,
             "number-invalid", "excessive numeric precision")
    return number


def _closed(obj: Any, required: set[str], optional: set[str], label: str) -> None:
    _require(isinstance(obj, dict), "semantics-malformed", f"{label} must be an object")
    _require(required <= set(obj) <= required | optional, "semantics-malformed",
             f"{label}: missing or unsupported fields")


def _unique(items: Any, label: str) -> list[str]:
    _require(isinstance(items, list) and bool(items) and all(_text(x) for x in items),
             "semantics-malformed", f"{label} must be a non-empty string list")
    _require(len(set(items)) == len(items), "semantics-malformed", f"{label} has duplicates")
    return items


class _Cells(HTMLParser):
    """Extract visible spans in every td of a table marked data-results.

    This is deliberately a static, restricted adapter, not a browser. Dynamic
    DOM, CSS visibility and unmarked result regions require rendered extraction.
    """
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.tables: list[bool] = []
        self.cells: list[dict[str, str]] = []
        self.cell: dict[str, str] | None = None
        self.field: str | None = None

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        attributes = dict(attrs)
        _require(len(attributes) == len(attrs), "html-malformed", "duplicate HTML attribute")
        if tag == "table":
            _require(not self.tables, "html-malformed", "nested tables require rendered extraction")
            self.tables.append("data-results" in attributes)
        elif tag == "td" and self.tables and self.tables[-1]:
            _require(self.cell is None and _text(attributes.get("data-display-id")),
                     "cell-identity-missing", "every result td needs a unique data-display-id")
            self.cell = {"id": attributes["data-display-id"]}
        elif self.cell is not None:
            _require(tag == "span" and self.field is None,
                     "html-malformed", "result cells must contain flat data-field spans")
            field = attributes.get("data-field")
            _require(field in {"label", "value", "unit"} and field not in self.cell,
                     "cell-identity-missing", "each cell needs one label, value and unit span")
            self.field = field
            self.cell[field] = ""

    def handle_data(self, data: str) -> None:
        if self.cell is not None:
            if self.field is not None:
                self.cell[self.field] += data
            else:
                _require(not data.strip(), "html-malformed", "unmapped visible cell content")

    def handle_endtag(self, tag: str) -> None:
        if tag == "span" and self.field is not None:
            self.field = None
        elif tag == "td" and self.cell is not None:
            _require(self.field is None and set(self.cell) == {"id", "label", "value", "unit"},
                     "cell-identity-missing", "incomplete cell identity/value/unit mapping")
            self.cells.append({k: v.strip() for k, v in self.cell.items()})
            self.cell = None
        elif tag == "table" and self.tables:
            _require(self.cell is None, "html-malformed", "unclosed result cell")
            self.tables.pop()

    def finish(self, html: str) -> list[dict[str, str]]:
        self.feed(html)
        self.close()
        _require(not self.tables and self.cell is None and bool(self.cells),
                 "html-malformed", "unclosed or empty result table")
        return self.cells


# Small immutable unit vocabulary; custom units are explicit source definitions.
# A built-in symbol cannot be redefined to make an incorrect conversion pass.
_UNITS = {
    "1": ("dimensionless", "1", "0"), "%": ("dimensionless", ".01", "0"),
    "s": ("time", "1", "0"), "ms": ("time", ".001", "0"),
    "m": ("length", "1", "0"), "mm": ("length", ".001", "0"),
    "cm": ("length", ".01", "0"), "km": ("length", "1000", "0"),
    "kg": ("mass", "1", "0"), "g": ("mass", ".001", "0"),
}


def _units(custom: Any) -> dict[str, tuple[str, Decimal, Decimal]]:
    _require(isinstance(custom, dict), "unit-invalid", "units must be an object")
    units = {name: (dim, _decimal(scale), _decimal(offset))
             for name, (dim, scale, offset) in _UNITS.items()}
    for name, record in custom.items():
        _closed(record, {"dimension", "scale", "offset"}, set(), f"unit {name}")
        _require(_text(name) and name not in units and _text(record["dimension"]),
                 "unit-invalid", "custom unit must name a dimension and not redefine a built-in")
        scale, offset = _decimal(record["scale"]), _decimal(record["offset"])
        _require(scale > 0, "unit-invalid", "unit scale must be positive")
        units[name] = (record["dimension"], scale, offset)
    return units


def input_paths(block: Any, resolve) -> list[Path]:
    """Discover all declared input slots even when their files do not exist."""
    paths: list[Path] = []
    if not isinstance(block, dict):
        return paths
    records = [block.get("source")]
    surfaces = block.get("surfaces")
    if isinstance(surfaces, list):
        for surface in surfaces:
            if isinstance(surface, dict):
                records.extend([surface, surface.get("extraction")])
    for record in records:
        if isinstance(record, dict) and _text(record.get("path")):
            paths.append(resolve(record["path"]))
    return paths


def check(block: Any, plotted: list[str], base_dir: Path, read_json, sha256) -> list[dict[str, str]]:
    """Return findings in the existing verdict_mismatch result category."""
    try:
        # Precision is arithmetic working room, not a demanded scientific tolerance.
        with localcontext() as context:
            context.prec = 4096
            _check(block, plotted, base_dir, read_json, sha256)
        return []
    except (SemanticError, OSError, ValueError, InvalidOperation, TypeError, KeyError) as exc:
        kind = exc.kind if isinstance(exc, SemanticError) else "semantics-unreadable"
        return [{"kind": kind, "category": "verdict_mismatch", "message": str(exc)}]


def _check(block: Any, plotted: list[str], base_dir: Path, read_json, sha256) -> None:
    _closed(block, {"purpose", "source", "selection", "cells", "surfaces"},
            {"diagnostic_purposes", "dual_representations"}, "final_display")
    _require(_text(block["purpose"]), "purpose-missing", "state the reader's purpose")

    def pinned(record: Any, label: str) -> Path:
        _require(isinstance(record, dict) and _text(record.get("path")),
                 "semantics-malformed", f"{label} has no path")
        path = base_dir / record["path"]
        digest = record.get("sha256")
        _require(isinstance(digest, str) and bool(re.fullmatch(r"[a-f0-9]{64}", digest))
                 and path.is_file() and sha256(path) == digest,
                 "final-input-mismatch", f"{label} is missing or differs from its pinned bytes")
        return path

    _closed(block["source"], {"path", "sha256"}, set(), "source")
    source = read_json(pinned(block["source"], "source"))
    _closed(source, {"quantities"}, {"units"}, "source data")
    units = _units(source.get("units", {}))
    quantities: dict[str, dict] = {}
    leaves: dict[tuple[str, str | None], dict] = {}
    _require(isinstance(source["quantities"], list) and bool(source["quantities"]),
             "source-invalid", "source quantities must be a non-empty list")
    for q in source["quantities"]:
        _closed(q, {"id", "identity", "role"},
                {"raw", "components", "component_definition", "normalization"}, "quantity")
        qid = q["id"]
        _require(_text(qid) and qid not in quantities, "source-invalid", "quantity ids must be unique")
        identity = q["identity"]
        _require(isinstance(identity, dict)
                 and {"object", "conditions", "reference", "definition"} <= set(identity)
                 and all(_text(v) for v in identity.values()),
                 "quantity-identity-missing", f"{qid}: complete quantity identity is required")
        _require(q["role"] in {"result", "diagnostic", "intermediate"},
                 "source-invalid", f"{qid}: unknown role")
        quantities[qid] = q
        if "components" in q:
            _require("raw" not in q and _text(q.get("component_definition"))
                     and _text(q.get("normalization")), "component-identity-missing",
                     f"{qid}: components need a definition and normalization convention")
            _require(isinstance(q["components"], list) and bool(q["components"]),
                     "component-identity-missing", f"{qid}: empty component mapping")
            for component in q["components"]:
                _closed(component, {"id", "definition", "raw"}, set(), "component")
                cid = component["id"]
                _require(_text(cid) and _text(component["definition"]) and (qid, cid) not in leaves,
                         "component-identity-missing", f"{qid}: component identity is ambiguous")
                leaves[qid, cid] = component["raw"]
        else:
            _require("raw" in q, "source-invalid", f"{qid}: no raw value")
            leaves[qid, None] = q["raw"]
    for raw in leaves.values():
        _closed(raw, {"value", "unit"}, {"status"}, "raw value")
        _require(_text(raw["unit"]) and raw["unit"] in units, "unit-invalid", "unknown source unit")
        status = raw.get("status", "available")
        _require(status in {"available", "failed", "missing", "not_applicable"},
                 "source-invalid", "unknown source status")
        if status == "available":
            _decimal(raw["value"])
        else:
            _require(raw["value"] is None, "source-invalid", "unavailable source must not carry a number")

    selection = _unique(block["selection"], "selection")
    _require(set(selection) == set(plotted) and set(selection) <= set(quantities),
             "display-selection-mismatch", "selection must equal the verified display quantities")
    purposes = block.get("diagnostic_purposes", {})
    _require(isinstance(purposes, dict) and set(purposes) <= set(selection)
             and all(_text(v) for v in purposes.values()), "purpose-missing", "invalid diagnostic purposes")
    for qid in selection:
        _require(quantities[qid]["role"] == "result" or _text(purposes.get(qid)),
                 "diagnostic-in-display", f"{qid}: diagnostic/intermediate quantity needs a reader purpose")

    cells = block["cells"]
    _require(isinstance(cells, list) and bool(cells), "semantics-malformed", "cells must be non-empty")
    ids: list[str] = []
    expected: dict[str, tuple[Decimal | None, str, str]] = {}
    groups: dict[str, list[str]] = {}
    components_seen: dict[str, dict[str, list[str | None]]] = {q: {} for q in selection}
    for cell in cells:
        _closed(cell, {"id", "quantity", "unit", "transform"}, {"component", "representation"}, "cell")
        cell_id, qid, cid = cell["id"], cell["quantity"], cell.get("component")
        _require(_text(cell_id) and cell_id not in ids, "cell-identity-missing", "cell ids must be unique")
        _require(_text(qid) and (cid is None or _text(cid)), "cell-identity-missing", "invalid cell identity")
        _require(qid in selection, "display-selection-mismatch", f"{cell_id}: quantity outside reader selection")
        _require((qid, cid) in leaves, "component-identity-missing", f"{cell_id}: missing component identity")
        ids.append(cell_id)
        representation = cell.get("representation", "default")
        _require(_text(representation), "component-identity-missing", "name the component representation")
        components_seen[qid].setdefault(representation, []).append(cid)
        q, raw = quantities[qid], leaves[qid, cid]
        _require(_text(cell["unit"]) and cell["unit"] in units, "unit-invalid", "unknown display unit")
        dim, scale, offset = units[raw["unit"]]
        out_dim, out_scale, out_offset = units[cell["unit"]]
        _require(dim == out_dim, "unit-dimension-mismatch", f"{cell_id}: incompatible unit dimensions")
        transform = cell["transform"]
        _closed(transform, {"kind", "definition"}, {"scale", "offset"}, "transform")
        _require(_text(transform["definition"]), "transform-invalid", "define the display mapping")
        kind = transform["kind"]
        _require(kind in {"identity", "affine", "absolute"}, "transform-invalid", "unsupported display mapping")
        if kind == "affine":
            _require(set(transform) == {"kind", "definition", "scale", "offset"},
                     "transform-invalid", "affine mapping needs scale and offset in canonical units")
            factor, shift = _decimal(transform["scale"]), _decimal(transform["offset"])
            _require(factor != 0, "transform-invalid", "affine scale must be nonzero")
        else:
            _require(set(transform) == {"kind", "definition"}, "transform-invalid", "unexpected transform parameters")
            factor, shift = Decimal(1), Decimal(0)
        status = raw.get("status", "available")
        number = None
        if status == "available":
            canonical = _decimal(raw["value"]) * scale + offset
            mapped = abs(canonical) if kind == "absolute" else canonical * factor + shift
            number = (mapped - out_offset) / out_scale
        expected[cell_id] = number, cell["unit"], status
        if kind != "absolute":
            # Exact semantic identity, never numerical proximity. Additional
            # identity fields (parameter/model/basis/etc.) also distinguish results.
            identity_key = json.dumps([q["identity"], cid], sort_keys=True, ensure_ascii=False)
            groups.setdefault(identity_key, []).append(cell_id)
    for qid, representations in components_seen.items():
        wanted = [c["id"] for c in quantities[qid].get("components", [])] or [None]
        _require(bool(representations), "component-order-mismatch", f"{qid}: no displayed components")
        for representation, seen in representations.items():
            sequence = seen if "components" in quantities[qid] else list(dict.fromkeys(seen))
            _require(sequence == wanted, "component-order-mismatch",
                     f"{qid}/{representation}: components lack the complete declared identity/order mapping")

    duals = block.get("dual_representations", [])
    _require(isinstance(duals, list), "semantics-malformed", "dual_representations must be a list")
    declarations: set[frozenset[str]] = set()
    for dual in duals:
        _closed(dual, {"cells", "purpose"}, set(), "dual representation")
        group = frozenset(_unique(dual["cells"], "dual cells"))
        _require(len(group) > 1 and _text(dual["purpose"]) and group not in declarations,
                 "duplicate-representation", "dual representations need one explicit reader purpose")
        declarations.add(group)
    duplicates = {frozenset(group) for group in groups.values() if len(group) > 1}
    _require(declarations == duplicates, "duplicate-representation",
             "reversible duplicate representations need an exact cell group and reader purpose")

    surfaces = block["surfaces"]
    _require(isinstance(surfaces, list) and bool(surfaces), "semantics-malformed", "surfaces must be non-empty")
    surface_paths: set[Path] = set()
    for surface in surfaces:
        _closed(surface, {"path", "sha256", "format", "language", "labels", "unit_labels", "review"},
                {"extraction", "status_labels"}, "surface")
        path = pinned(surface, "final surface")
        _require(path.resolve() not in surface_paths and _text(surface["language"]),
                 "semantics-malformed", "surfaces must have distinct paths and named languages")
        surface_paths.add(path.resolve())
        review = surface["review"]
        _closed(review, {"sha256", "readability", "semantics"}, set(), "rendered review")
        _require(review["sha256"] == surface["sha256"] and review["readability"] is True
                 and review["semantics"] is True, "rendered-review-missing",
                 "inspect final rendering for readability, completeness and quantity meaning")
        if surface["format"] == "html":
            _require("extraction" not in surface, "semantics-malformed", "HTML adapter reads the final file directly")
            observed = _Cells().finish(path.read_text(encoding="utf-8"))
        else:
            _require(surface["format"] == "extracted", "semantics-malformed", "unsupported surface format")
            _closed(surface.get("extraction"), {"path", "sha256"}, set(), "extraction")
            extraction = read_json(pinned(surface["extraction"], "post-render extraction"))
            _closed(extraction, {"surface_sha256", "cells"}, set(), "extraction data")
            _require(extraction["surface_sha256"] == surface["sha256"], "final-input-mismatch",
                     "extraction must come from these final rendered bytes")
            observed = extraction["cells"]
        _require(isinstance(observed, list), "semantics-malformed", "observed cells must be a list")
        for record in observed:
            _closed(record, {"id", "label", "value", "unit"}, set(), "observed cell")
            _require(all(isinstance(v, str) for v in record.values()), "semantics-malformed", "cell fields must be strings")
        _require([c["id"] for c in observed] == ids, "final-cell-order-mismatch",
                 "final cell identities/order differ from the complete display inventory")
        labels, unit_labels = surface["labels"], surface["unit_labels"]
        _require(isinstance(labels, dict) and set(labels) == set(ids)
                 and all(_text(v) for v in labels.values()), "cell-identity-missing", "every final cell needs an identity label")
        used_units = {v[1] for v in expected.values()}
        _require(isinstance(unit_labels, dict) and set(unit_labels) == used_units
                 and all(_text(v) for v in unit_labels.values())
                 and len(set(unit_labels.values())) == len(unit_labels),
                 "unit-invalid", "visible unit labels must map unambiguously to the used units")
        for symbol, label in unit_labels.items():
            _require(label not in units or units[label] == units[symbol], "value-unit-mismatch",
                     "a visible known unit symbol cannot label a different unit mapping")
        statuses = surface.get("status_labels", {})
        _require(isinstance(statuses, dict) and set(statuses) <= {"failed", "missing", "not_applicable"}
                 and all(_text(v) for v in statuses.values())
                 and len(set(statuses.values())) == len(statuses),
                 "status-mismatch", "keep failure, absence and non-applicability distinguishable")
        effective_statuses = {status: statuses.get(status, status)
                              for status in {"failed", "missing", "not_applicable"}}
        _require(len(set(effective_statuses.values())) == len(effective_statuses),
                 "status-mismatch", "translated and default status labels must remain distinct")
        for status, label in effective_statuses.items():
            _require(label not in effective_statuses or label == status, "status-mismatch",
                     "a known status token cannot label a different source status")
        for record in observed:
            number, unit, status = expected[record["id"]]
            _require(record["label"] == labels[record["id"]], "cell-label-mismatch", "final quantity/component label differs")
            _require(record["unit"] == unit_labels[unit], "value-unit-mismatch", "final value carries the wrong unit")
            if number is None:
                _require(record["value"] == effective_statuses[status], "status-mismatch", "final status differs from source")
            else:
                printed = _decimal(record["value"])
                half_step = Decimal(10) ** printed.as_tuple().exponent / 2
                _require(abs(number - printed) <= half_step, "value-unit-mismatch",
                         f"{record['id']}: source mapping lies outside the final token's rounding interval")
