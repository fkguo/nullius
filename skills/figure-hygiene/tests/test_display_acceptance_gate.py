"""Behavior tests for the display-acceptance gate.

The gate refuses durable/outward-facing use of a figure until every plotted
quantity is bound to a verification verdict artifact (existing, byte-pinned,
covering the quantity, with an accepted outcome) and an all-component
human-review overview figure is archived. Negative controls assert that each
leg of the discipline actually fails when its evidence is removed or
tampered with; the gate must be fail-closed, never pass-by-default.
"""

from __future__ import annotations

import hashlib
import importlib.util
import json
import subprocess
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[3]
GATE = REPO_ROOT / "skills" / "figure-hygiene" / "scripts" / "bin" / "check_display_acceptance.py"
SCHEMA = REPO_ROOT / "meta" / "schemas" / "display_gate_result_v1.schema.json"


def _load_gate_module():
    spec = importlib.util.spec_from_file_location("check_display_acceptance", GATE)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _write_verdict(path: Path, quantities: list[str], verdict: str = "pass") -> str:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps({"quantities": quantities, "verdict": verdict}), encoding="utf-8")
    return _sha256(path)


def _bundle(tmp_path: Path) -> dict:
    """Full passing fixture: two plotted quantities, two verdict artifacts,
    one archived overview figure. Returns the display_acceptance block; the
    manifest is written by _write_manifest."""
    hash_a = _write_verdict(tmp_path / "gates" / "quantity_a.verdict.json", ["quantity_a"])
    hash_b = _write_verdict(tmp_path / "gates" / "quantity_b.verdict.json", ["quantity_a", "quantity_b"])
    overview = tmp_path / "figs" / "review" / "overview_all_components.pdf"
    overview.parent.mkdir(parents=True, exist_ok=True)
    overview.write_bytes(b"%PDF-1.4 overview placeholder")
    return {
        "plotted_quantities": ["quantity_a", "quantity_b"],
        "verdict_bindings": [
            {
                "quantity": "quantity_a",
                "verdict_path": "gates/quantity_a.verdict.json",
                "verdict_sha256": hash_a,
            },
            {
                "quantity": "quantity_b",
                "verdict_path": "gates/quantity_b.verdict.json",
                "verdict_sha256": hash_b,
            },
        ],
        "overview_figure": {
            "path": "figs/review/overview_all_components.pdf",
            "archived": True,
        },
    }


def _write_manifest(tmp_path: Path, display_acceptance) -> Path:
    manifest = {
        "figure": "figs/scan_summary.pdf",
        "data": ["data/scan_results.csv"],
        "script": "figs/src/scan_summary.py",
        "command": "python3 figs/src/scan_summary.py",
    }
    if display_acceptance is not None:
        manifest["display_acceptance"] = display_acceptance
    path = tmp_path / "scan_summary.provenance.json"
    path.write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    return path


def _run(manifest: Path) -> tuple[int, dict]:
    proc = subprocess.run(
        [sys.executable, str(GATE), "--manifest", str(manifest), "--json"],
        capture_output=True,
        text=True,
        check=False,
    )
    payload = json.loads(proc.stdout)
    return proc.returncode, payload


def _kinds(payload: dict) -> set[str]:
    return {finding["kind"] for finding in payload["findings"]}


def test_full_bundle_passes(tmp_path: Path) -> None:
    manifest = _write_manifest(tmp_path, _bundle(tmp_path))
    code, payload = _run(manifest)
    assert code == 0
    assert payload["result"] == "pass"
    assert payload["findings"] == []
    assert payload["quantities_declared"] == 2
    assert payload["bindings_checked"] == 2
    assert payload["overview_figure"] == "figs/review/overview_all_components.pdf"


def test_missing_verdict_binding_fails(tmp_path: Path) -> None:
    block = _bundle(tmp_path)
    block["verdict_bindings"] = block["verdict_bindings"][:1]  # drop quantity_b's binding
    manifest = _write_manifest(tmp_path, block)
    code, payload = _run(manifest)
    assert code == 1
    assert payload["result"] == "missing_verdict_binding"
    assert "missing-binding" in _kinds(payload)


def test_display_acceptance_block_absent_fails(tmp_path: Path) -> None:
    manifest = _write_manifest(tmp_path, None)
    code, payload = _run(manifest)
    assert code == 1
    assert payload["result"] == "missing_verdict_binding"
    assert "display-acceptance-missing" in _kinds(payload)


def test_empty_plotted_quantities_fails(tmp_path: Path) -> None:
    block = _bundle(tmp_path)
    block["plotted_quantities"] = []
    manifest = _write_manifest(tmp_path, block)
    code, payload = _run(manifest)
    assert code == 1
    assert payload["result"] == "missing_verdict_binding"
    assert "plotted-quantities-undeclared" in _kinds(payload)


def test_verdict_hash_mismatch_fails(tmp_path: Path) -> None:
    block = _bundle(tmp_path)
    manifest = _write_manifest(tmp_path, block)
    # Tamper with the bound verdict artifact after its digest was recorded in
    # the figure manifest: the stale binding must be refused.
    tampered = tmp_path / "gates" / "quantity_a.verdict.json"
    tampered.write_text(json.dumps({"quantities": ["quantity_a"], "verdict": "pass", "note": "edited"}), encoding="utf-8")
    code, payload = _run(manifest)
    assert code == 1
    assert payload["result"] == "verdict_mismatch"
    assert "verdict-hash-mismatch" in _kinds(payload)


def test_verdict_not_covering_quantity_fails(tmp_path: Path) -> None:
    block = _bundle(tmp_path)
    # Rebind quantity_a to an artifact that only covers quantity_b: the verdict
    # exists and hashes correctly but does not correspond to the plotted quantity.
    other_hash = _write_verdict(tmp_path / "gates" / "other.verdict.json", ["quantity_b"])
    block["verdict_bindings"][0]["verdict_path"] = "gates/other.verdict.json"
    block["verdict_bindings"][0]["verdict_sha256"] = other_hash
    manifest = _write_manifest(tmp_path, block)
    code, payload = _run(manifest)
    assert code == 1
    assert payload["result"] == "verdict_mismatch"
    assert "quantity-not-covered" in _kinds(payload)


def test_failing_verdict_outcome_fails(tmp_path: Path) -> None:
    block = _bundle(tmp_path)
    failing_hash = _write_verdict(tmp_path / "gates" / "quantity_a.verdict.json", ["quantity_a"], verdict="fail")
    block["verdict_bindings"][0]["verdict_sha256"] = failing_hash
    manifest = _write_manifest(tmp_path, block)
    code, payload = _run(manifest)
    assert code == 1
    assert payload["result"] == "verdict_mismatch"
    assert "verdict-not-accepted" in _kinds(payload)


def test_missing_overview_figure_file_fails(tmp_path: Path) -> None:
    block = _bundle(tmp_path)
    (tmp_path / "figs" / "review" / "overview_all_components.pdf").unlink()
    manifest = _write_manifest(tmp_path, block)
    code, payload = _run(manifest)
    assert code == 1
    assert payload["result"] == "missing_overview_figure"
    assert "overview-file-missing" in _kinds(payload)


def test_overview_not_archived_fails(tmp_path: Path) -> None:
    block = _bundle(tmp_path)
    block["overview_figure"]["archived"] = False
    manifest = _write_manifest(tmp_path, block)
    code, payload = _run(manifest)
    assert code == 1
    assert payload["result"] == "missing_overview_figure"
    assert "overview-not-archived" in _kinds(payload)


def test_overview_undeclared_fails(tmp_path: Path) -> None:
    block = _bundle(tmp_path)
    del block["overview_figure"]
    manifest = _write_manifest(tmp_path, block)
    code, payload = _run(manifest)
    assert code == 1
    assert payload["result"] == "missing_overview_figure"
    assert "overview-undeclared" in _kinds(payload)


def test_binding_priority_over_overview(tmp_path: Path) -> None:
    # When both a binding and the overview are missing, the roll-up names the
    # binding failure first (deterministic category priority).
    block = _bundle(tmp_path)
    block["verdict_bindings"] = []
    del block["overview_figure"]
    manifest = _write_manifest(tmp_path, block)
    code, payload = _run(manifest)
    assert code == 1
    assert payload["result"] == "missing_verdict_binding"
    assert "overview-undeclared" in _kinds(payload)


def test_unreadable_manifest_is_invalid(tmp_path: Path) -> None:
    manifest = tmp_path / "broken.provenance.json"
    manifest.write_text("{not json", encoding="utf-8")
    code, payload = _run(manifest)
    assert code == 2
    assert payload["result"] == "invalid_manifest"


def test_result_enum_matches_schema_authority() -> None:
    # The falsification labels in the script and the shared schema SSOT must
    # not drift apart; the anti-drift lock enforces the same invariant in CI.
    module = _load_gate_module()
    schema = json.loads(SCHEMA.read_text(encoding="utf-8"))
    schema_enum = schema["properties"]["result"]["enum"]
    assert list(module.RESULT_VALUES) == schema_enum
    category_enum = schema["$defs"]["DisplayGateFinding"]["properties"]["category"]["enum"]
    assert set(module.CATEGORY_PRIORITY) == set(category_enum)


def test_payload_satisfies_schema_required_fields(tmp_path: Path) -> None:
    manifest = _write_manifest(tmp_path, _bundle(tmp_path))
    _, payload = _run(manifest)
    schema = json.loads(SCHEMA.read_text(encoding="utf-8"))
    for key in schema["required"]:
        assert key in payload
    assert set(payload) <= set(schema["properties"])
