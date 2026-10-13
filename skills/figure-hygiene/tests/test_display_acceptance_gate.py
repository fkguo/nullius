"""Behavior tests for the display-acceptance gate.

The gate refuses durable/outward-facing use of a figure until every plotted
quantity is bound to a verification verdict artifact (existing, byte-pinned,
covering the quantity, with an accepted outcome) and an all-component
human-review overview figure is archived. Negative controls assert that each
leg of the discipline actually fails when its evidence is removed or
tampered with; the gate must be fail-closed, never pass-by-default.
"""

from __future__ import annotations

import ast
import hashlib
from html import escape
import importlib.util
import json
import os
import subprocess
import sys
import symtable
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[3]
GATE = REPO_ROOT / "skills" / "figure-hygiene" / "scripts" / "bin" / "check_display_acceptance.py"
SCHEMA = REPO_ROOT / "meta" / "schemas" / "display_gate_result_v1.schema.json"
VERDICT_SCHEMA = REPO_ROOT / "meta" / "schemas" / "quantity_verdict_v1.schema.json"
GENERATED_PYTHON = REPO_ROOT / "meta" / "generated" / "python"


def _load_gate_module():
    spec = importlib.util.spec_from_file_location("check_display_acceptance", GATE)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _write_verdict(path: Path, quantities: list[str], verdict: str = "pass") -> str:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(
            {
                "schema_id": "quantity_verdict_v1",
                "schema_version": 1,
                "quantities": quantities,
                "verdict": verdict,
            }
        ),
        encoding="utf-8",
    )
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
        "final_display": _semantic_bundle(tmp_path),
    }


def _semantic_bundle(tmp_path: Path) -> dict:
    """Raw observations and final HTML, independently written fixture inputs."""
    source = tmp_path / "quantities.json"
    source.write_text(json.dumps({"quantities": [
        {"id": "quantity_a", "identity": {"object": "sample a", "conditions": "fixed",
         "reference": "origin", "definition": "elapsed interval"}, "role": "result",
         "raw": {"value": "1234", "unit": "ms"}},
        {"id": "quantity_b", "identity": {"object": "sample b", "conditions": "fixed",
         "reference": "origin", "definition": "elapsed interval"}, "role": "result",
         "raw": {"value": "2345", "unit": "ms"}}
    ]}), encoding="utf-8")
    final = tmp_path / "figs" / "summary.html"
    final.parent.mkdir(parents=True, exist_ok=True)
    # Values below are explicit expected observations, not calculated by the gate.
    final.write_text(_html_cells([
        {"id": "a", "label": "Interval A", "value": "1.23", "unit": "s"},
        {"id": "b", "label": "Interval B", "value": "2.35", "unit": "s"}
    ]), encoding="utf-8")
    digest = _sha256(final)
    return {
        "purpose": "compare two measured intervals", "source": {"path": "quantities.json", "sha256": _sha256(source)},
        "selection": ["quantity_a", "quantity_b"],
        "cells": [{"id": cid, "quantity": qid, "unit": "s",
                   "transform": {"kind": "identity", "definition": "convert the source unit"}}
                  for cid, qid in [("a", "quantity_a"), ("b", "quantity_b")]],
        "surfaces": [{"path": "figs/summary.html", "sha256": digest, "format": "html", "language": "en",
                      "labels": {"a": "Interval A", "b": "Interval B"}, "unit_labels": {"s": "s"},
                      "review": {"sha256": digest, "readability": True, "semantics": True}}],
    }


def _html_cells(cells: list[dict]) -> str:
    return '<table data-results>' + ''.join(
        '<tr><td data-display-id="' + escape(cell["id"], quote=True) + '">' + ''.join(
            '<span data-field="' + key + '">' + escape(cell[key]) + '</span>'
            for key in ["label", "value", "unit"]
        ) + '</td></tr>' for cell in cells
    ) + '</table>'


def _write_manifest(tmp_path: Path, display_acceptance) -> Path:
    manifest = {
        "figure": "figs/summary.html",
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


def test_caller_cannot_widen_accepted_verdicts(tmp_path: Path) -> None:
    # The accepted outcome is fixed by the gate. A manifest that tries to
    # declare its own acceptance vocabulary (the caller judging itself) must
    # fail twice over: the unsupported field is refused, and the failing
    # outcome stays refused.
    block = _bundle(tmp_path)
    failing_hash = _write_verdict(tmp_path / "gates" / "quantity_a.verdict.json", ["quantity_a"], verdict="fail")
    block["verdict_bindings"][0]["verdict_sha256"] = failing_hash
    block["verdict_bindings"][0]["accepted_verdicts"] = ["fail"]
    manifest = _write_manifest(tmp_path, block)
    code, payload = _run(manifest)
    assert code == 1
    assert payload["result"] != "pass"
    assert {"unexpected-field", "verdict-not-accepted"} <= _kinds(payload)


def test_unexpected_block_field_fails(tmp_path: Path) -> None:
    block = _bundle(tmp_path)
    block["gate_disabled"] = True
    manifest = _write_manifest(tmp_path, block)
    code, payload = _run(manifest)
    assert code == 1
    assert payload["result"] == "missing_verdict_binding"
    assert "unexpected-field" in _kinds(payload)


def test_binding_unknown_quantity_fails(tmp_path: Path) -> None:
    block = _bundle(tmp_path)
    extra_hash = _write_verdict(tmp_path / "gates" / "extra.verdict.json", ["quantity_c"])
    block["verdict_bindings"].append(
        {"quantity": "quantity_c", "verdict_path": "gates/extra.verdict.json", "verdict_sha256": extra_hash}
    )
    manifest = _write_manifest(tmp_path, block)
    code, payload = _run(manifest)
    assert code == 1
    assert payload["result"] == "verdict_mismatch"
    assert "binding-unknown-quantity" in _kinds(payload)


def test_duplicate_binding_fails(tmp_path: Path) -> None:
    block = _bundle(tmp_path)
    block["verdict_bindings"].append(dict(block["verdict_bindings"][0]))
    manifest = _write_manifest(tmp_path, block)
    code, payload = _run(manifest)
    assert code == 1
    assert payload["result"] == "verdict_mismatch"
    assert "duplicate-binding" in _kinds(payload)


def test_duplicate_plotted_quantity_fails(tmp_path: Path) -> None:
    block = _bundle(tmp_path)
    block["plotted_quantities"].append("quantity_a")
    manifest = _write_manifest(tmp_path, block)
    code, payload = _run(manifest)
    assert code == 1
    assert payload["result"] == "missing_verdict_binding"
    assert "duplicate-plotted-quantity" in _kinds(payload)


def test_unreadable_verdict_artifact_fails(tmp_path: Path) -> None:
    # The artifact hashes correctly (the pin is honest) but is not readable
    # as a JSON verdict: it cannot demonstrate coverage, so it must fail.
    block = _bundle(tmp_path)
    garbled = tmp_path / "gates" / "quantity_a.verdict.json"
    garbled.write_bytes(b"\x00not json")
    block["verdict_bindings"][0]["verdict_sha256"] = _sha256(garbled)
    manifest = _write_manifest(tmp_path, block)
    code, payload = _run(manifest)
    assert code == 1
    assert payload["result"] == "verdict_mismatch"
    assert "verdict-unreadable" in _kinds(payload)


def test_verdict_without_schema_identity_fails(tmp_path: Path) -> None:
    block = _bundle(tmp_path)
    verdict_path = tmp_path / "gates" / "quantity_a.verdict.json"
    verdict_path.write_text(
        json.dumps({"schema_version": 1, "quantities": ["quantity_a"], "verdict": "pass"}),
        encoding="utf-8",
    )
    block["verdict_bindings"][0]["verdict_sha256"] = _sha256(verdict_path)
    manifest = _write_manifest(tmp_path, block)
    code, payload = _run(manifest)
    assert code == 1
    assert payload["result"] == "verdict_mismatch"
    assert "verdict-schema-invalid" in _kinds(payload)


def test_verdict_wrong_schema_version_fails(tmp_path: Path) -> None:
    block = _bundle(tmp_path)
    verdict_path = tmp_path / "gates" / "quantity_a.verdict.json"
    verdict = json.loads(verdict_path.read_text(encoding="utf-8"))
    verdict["schema_version"] = 2
    verdict_path.write_text(json.dumps(verdict), encoding="utf-8")
    block["verdict_bindings"][0]["verdict_sha256"] = _sha256(verdict_path)
    manifest = _write_manifest(tmp_path, block)
    code, payload = _run(manifest)
    assert code == 1
    assert payload["result"] == "verdict_mismatch"
    assert "verdict-schema-invalid" in _kinds(payload)


def test_verdict_with_extra_field_fails_closed_shape(tmp_path: Path) -> None:
    block = _bundle(tmp_path)
    verdict_path = tmp_path / "gates" / "quantity_a.verdict.json"
    verdict = json.loads(verdict_path.read_text(encoding="utf-8"))
    verdict["accepted_by_caller"] = True
    verdict_path.write_text(json.dumps(verdict), encoding="utf-8")
    block["verdict_bindings"][0]["verdict_sha256"] = _sha256(verdict_path)
    manifest = _write_manifest(tmp_path, block)
    code, payload = _run(manifest)
    assert code == 1
    assert payload["result"] == "verdict_mismatch"
    assert "verdict-schema-invalid" in _kinds(payload)


def test_duplicate_verdict_key_fails_closed(tmp_path: Path) -> None:
    block = _bundle(tmp_path)
    verdict_path = tmp_path / "gates" / "quantity_a.verdict.json"
    verdict_path.write_text(
        '{"schema_id":"quantity_verdict_v1","schema_version":1,'
        '"quantities":["quantity_a"],"verdict":"fail","verdict":"pass"}',
        encoding="utf-8",
    )
    block["verdict_bindings"][0]["verdict_sha256"] = _sha256(verdict_path)
    manifest = _write_manifest(tmp_path, block)
    code, payload = _run(manifest)
    assert code == 1
    assert payload["result"] == "verdict_mismatch"
    assert "verdict-unreadable" in _kinds(payload)


def test_overview_hash_pinned_passes(tmp_path: Path) -> None:
    block = _bundle(tmp_path)
    overview = tmp_path / "figs" / "review" / "overview_all_components.pdf"
    block["overview_figure"]["sha256"] = _sha256(overview)
    manifest = _write_manifest(tmp_path, block)
    code, payload = _run(manifest)
    assert code == 0
    assert payload["result"] == "pass"


def test_overview_hash_mismatch_fails(tmp_path: Path) -> None:
    block = _bundle(tmp_path)
    block["overview_figure"]["sha256"] = "0" * 64
    manifest = _write_manifest(tmp_path, block)
    code, payload = _run(manifest)
    assert code == 1
    assert payload["result"] == "missing_overview_figure"
    assert "overview-hash-mismatch" in _kinds(payload)


def test_overview_hash_malformed_fails(tmp_path: Path) -> None:
    block = _bundle(tmp_path)
    block["overview_figure"]["sha256"] = "not-a-digest"
    manifest = _write_manifest(tmp_path, block)
    code, payload = _run(manifest)
    assert code == 1
    assert payload["result"] == "missing_overview_figure"
    assert "overview-hash-malformed" in _kinds(payload)


def test_binding_not_object_fails(tmp_path: Path) -> None:
    block = _bundle(tmp_path)
    block["verdict_bindings"][0] = "gates/quantity_a.verdict.json"
    manifest = _write_manifest(tmp_path, block)
    code, payload = _run(manifest)
    assert code == 1
    assert payload["result"] == "missing_verdict_binding"
    assert "binding-malformed" in _kinds(payload)


def test_verdict_artifact_not_found_fails(tmp_path: Path) -> None:
    block = _bundle(tmp_path)
    (tmp_path / "gates" / "quantity_a.verdict.json").unlink()
    manifest = _write_manifest(tmp_path, block)
    code, payload = _run(manifest)
    assert code == 1
    assert payload["result"] == "missing_verdict_binding"
    assert "verdict-not-found" in _kinds(payload)


def test_empty_display_acceptance_block_fails(tmp_path: Path) -> None:
    manifest = _write_manifest(tmp_path, {})
    code, payload = _run(manifest)
    assert code == 1
    assert payload["result"] == "missing_verdict_binding"
    assert {"plotted-quantities-undeclared", "overview-undeclared"} <= _kinds(payload)


def test_out_json_persists_same_payload(tmp_path: Path) -> None:
    manifest = _write_manifest(tmp_path, _bundle(tmp_path))
    out_path = tmp_path / "artifacts" / "display_gate.json"
    proc = subprocess.run(
        [sys.executable, str(GATE), "--manifest", str(manifest), "--json", "--out-json", str(out_path)],
        capture_output=True,
        text=True,
        check=False,
    )
    assert proc.returncode == 0
    assert json.loads(proc.stdout) == json.loads(out_path.read_text(encoding="utf-8"))
    assert not list(out_path.parent.glob(f".{out_path.name}.*.tmp"))


def test_out_json_rejects_manifest_alias_without_clobbering(tmp_path: Path) -> None:
    manifest = _write_manifest(tmp_path, _bundle(tmp_path))
    before = manifest.read_bytes()
    proc = subprocess.run(
        [sys.executable, str(GATE), "--manifest", str(manifest), "--out-json", str(manifest)],
        capture_output=True,
        text=True,
        check=False,
    )
    payload = json.loads(proc.stdout)
    assert proc.returncode == 2
    assert payload["result"] == "invalid_manifest"
    assert "out-json-protected-input" in _kinds(payload)
    assert manifest.read_bytes() == before


def test_out_json_rejects_bound_verdict_alias_without_clobbering(tmp_path: Path) -> None:
    block = _bundle(tmp_path)
    manifest = _write_manifest(tmp_path, block)
    verdict_path = tmp_path / block["verdict_bindings"][0]["verdict_path"]
    before = verdict_path.read_bytes()
    proc = subprocess.run(
        [sys.executable, str(GATE), "--manifest", str(manifest), "--out-json", str(verdict_path)],
        capture_output=True,
        text=True,
        check=False,
    )
    payload = json.loads(proc.stdout)
    assert proc.returncode == 2
    assert payload["result"] == "invalid_manifest"
    assert "out-json-protected-input" in _kinds(payload)
    assert verdict_path.read_bytes() == before


def test_out_json_rejects_overview_alias_without_clobbering(tmp_path: Path) -> None:
    block = _bundle(tmp_path)
    manifest = _write_manifest(tmp_path, block)
    overview_path = tmp_path / block["overview_figure"]["path"]
    before = overview_path.read_bytes()
    proc = subprocess.run(
        [sys.executable, str(GATE), "--manifest", str(manifest), "--out-json", str(overview_path)],
        capture_output=True,
        text=True,
        check=False,
    )
    payload = json.loads(proc.stdout)
    assert proc.returncode == 2
    assert payload["result"] == "invalid_manifest"
    assert "out-json-protected-input" in _kinds(payload)
    assert overview_path.read_bytes() == before


def test_out_json_rejects_existing_hard_link_alias(tmp_path: Path) -> None:
    block = _bundle(tmp_path)
    manifest = _write_manifest(tmp_path, block)
    verdict_path = tmp_path / block["verdict_bindings"][0]["verdict_path"]
    hard_link = tmp_path / "hard-link-output.json"
    os.link(verdict_path, hard_link)
    before = verdict_path.read_bytes()
    proc = subprocess.run(
        [sys.executable, str(GATE), "--manifest", str(manifest), "--out-json", str(hard_link)],
        capture_output=True,
        text=True,
        check=False,
    )
    payload = json.loads(proc.stdout)
    assert proc.returncode == 2
    assert payload["result"] == "invalid_manifest"
    assert "out-json-protected-input" in _kinds(payload)
    assert verdict_path.read_bytes() == before


def test_out_json_rejects_missing_verdict_slot_without_creating_it(tmp_path: Path) -> None:
    block = _bundle(tmp_path)
    manifest = _write_manifest(tmp_path, block)
    missing_verdict = tmp_path / block["verdict_bindings"][0]["verdict_path"]
    missing_verdict.unlink()
    proc = subprocess.run(
        [sys.executable, str(GATE), "--manifest", str(manifest), "--out-json", str(missing_verdict)],
        capture_output=True,
        text=True,
        check=False,
    )
    payload = json.loads(proc.stdout)
    assert proc.returncode == 2
    assert payload["result"] == "invalid_manifest"
    assert "out-json-protected-input" in _kinds(payload)
    assert not missing_verdict.exists()


def test_out_json_rejects_ancestor_of_missing_verdict_slot(tmp_path: Path) -> None:
    block = _bundle(tmp_path)
    missing_verdict = tmp_path / "missing-verdict-dir" / "verdict.json"
    block["verdict_bindings"][0]["verdict_path"] = "missing-verdict-dir/verdict.json"
    manifest = _write_manifest(tmp_path, block)
    ancestor = missing_verdict.parent
    proc = subprocess.run(
        [sys.executable, str(GATE), "--manifest", str(manifest), "--out-json", str(ancestor)],
        capture_output=True,
        text=True,
        check=False,
    )
    payload = json.loads(proc.stdout)
    assert proc.returncode == 2
    assert payload["result"] == "invalid_manifest"
    assert "out-json-protected-input" in _kinds(payload)
    assert not ancestor.exists()
    assert not missing_verdict.exists()


def test_out_json_rejects_descendant_of_missing_overview_slot(tmp_path: Path) -> None:
    block = _bundle(tmp_path)
    manifest = _write_manifest(tmp_path, block)
    missing_overview = tmp_path / block["overview_figure"]["path"]
    missing_overview.unlink()
    descendant = missing_overview / "result.json"
    proc = subprocess.run(
        [sys.executable, str(GATE), "--manifest", str(manifest), "--out-json", str(descendant)],
        capture_output=True,
        text=True,
        check=False,
    )
    payload = json.loads(proc.stdout)
    assert proc.returncode == 2
    assert payload["result"] == "invalid_manifest"
    assert "out-json-protected-input" in _kinds(payload)
    assert not missing_overview.exists()
    assert not descendant.exists()


def test_out_json_directory_failure_emits_deterministic_json(tmp_path: Path) -> None:
    manifest = _write_manifest(tmp_path, _bundle(tmp_path))
    out_path = tmp_path / "output-directory"
    out_path.mkdir()
    command = [sys.executable, str(GATE), "--manifest", str(manifest), "--out-json", str(out_path)]
    first = subprocess.run(command, capture_output=True, text=True, check=False)
    second = subprocess.run(command, capture_output=True, text=True, check=False)
    assert first.returncode == second.returncode == 2
    assert first.stdout == second.stdout
    payload = json.loads(first.stdout)
    assert payload["result"] == "invalid_manifest"
    assert "out-json-write-failed" in _kinds(payload)
    assert first.stderr == second.stderr == ""


def test_atomic_writer_uses_same_directory_replace(tmp_path: Path, monkeypatch) -> None:
    module = _load_gate_module()
    target = tmp_path / "nested" / "result.json"
    target.parent.mkdir()
    calls = []
    real_replace = module.os.replace

    def recording_replace(source, destination):
        calls.append((Path(source), Path(destination)))
        real_replace(source, destination)

    monkeypatch.setattr(module.os, "replace", recording_replace)
    module._atomic_write_text(target, "{}\n")
    assert target.read_text(encoding="utf-8") == "{}\n"
    assert len(calls) == 1
    assert calls[0][0].parent == target.parent
    assert calls[0][1] == target
    assert not list(target.parent.glob(f".{target.name}.*.tmp"))


def test_human_output_states_verdict(tmp_path: Path) -> None:
    manifest = _write_manifest(tmp_path, _bundle(tmp_path))
    proc = subprocess.run(
        [sys.executable, str(GATE), "--manifest", str(manifest)],
        capture_output=True,
        text=True,
        check=False,
    )
    assert proc.returncode == 0
    assert "display acceptance pass" in proc.stdout


def test_usage_error_emits_invalid_manifest_payload(tmp_path: Path) -> None:
    proc = subprocess.run(
        [sys.executable, str(GATE)],  # missing required --manifest
        capture_output=True,
        text=True,
        check=False,
    )
    assert proc.returncode == 2
    payload = json.loads(proc.stdout)
    assert payload["result"] == "invalid_manifest"
    assert payload["findings"]


def test_unreadable_manifest_is_invalid(tmp_path: Path) -> None:
    manifest = tmp_path / "broken.provenance.json"
    manifest.write_text("{not json", encoding="utf-8")
    code, payload = _run(manifest)
    assert code == 2
    assert payload["result"] == "invalid_manifest"


def test_nested_duplicate_manifest_key_suppresses_output_persistence(tmp_path: Path) -> None:
    manifest = tmp_path / "ambiguous.provenance.json"
    manifest.write_text(
        '{"display_acceptance":{"plotted_quantities":["quantity_a"],'
        '"verdict_bindings":[],"overview_figure":{'
        '"path":"first.pdf","path":"second.pdf","archived":true}}}',
        encoding="utf-8",
    )
    code, semantic_payload = _run(manifest)
    assert code == 2
    assert semantic_payload["result"] == "invalid_manifest"
    assert "manifest-unreadable" in _kinds(semantic_payload)

    out_path = tmp_path / "result.json"
    proc = subprocess.run(
        [sys.executable, str(GATE), "--manifest", str(manifest), "--json", "--out-json", str(out_path)],
        capture_output=True,
        text=True,
        check=False,
    )
    payload = json.loads(proc.stdout)
    assert proc.returncode == 2
    assert payload["result"] == "invalid_manifest"
    assert "out-json-input-discovery-failed" in _kinds(payload)
    assert not out_path.exists()


def test_result_enum_matches_schema_authority() -> None:
    # The falsification labels in the script and the shared schema SSOT must
    # not drift apart; the anti-drift lock enforces the same invariant in CI.
    module = _load_gate_module()
    schema = json.loads(SCHEMA.read_text(encoding="utf-8"))
    schema_enum = schema["properties"]["result"]["enum"]
    assert list(module.RESULT_VALUES) == schema_enum
    category_enum = schema["$defs"]["DisplayGateFinding"]["properties"]["category"]["enum"]
    assert set(module.CATEGORY_PRIORITY) == set(category_enum)


def test_quantity_verdict_schema_matches_runtime_contract() -> None:
    module = _load_gate_module()
    schema = json.loads(VERDICT_SCHEMA.read_text(encoding="utf-8"))
    assert schema["properties"]["schema_id"]["const"] == module.VERDICT_SCHEMA_ID
    assert schema["properties"]["schema_version"]["const"] == module.VERDICT_SCHEMA_VERSION
    assert set(schema["required"]) == set(module._VERDICT_FIELDS)
    assert schema["additionalProperties"] is False
    assert set(schema["$defs"]["QuantityVerdictOutcome"]["enum"]) == module.VERDICT_VALUES


def test_generated_quantity_verdict_api_has_schema_specific_symbols() -> None:
    aggregate_tree = ast.parse((GENERATED_PYTHON / "__init__.py").read_text(encoding="utf-8"))
    aggregate_modules = [
        node.module
        for node in aggregate_tree.body
        if isinstance(node, ast.ImportFrom)
        and node.level == 1
        and node.module is not None
        and any(alias.name == "*" for alias in node.names)
    ]
    assert "quantity_verdict_v1" in aggregate_modules

    class_names_by_module = {}
    public_names_by_module = {}
    for module_name in aggregate_modules:
        module_path = GENERATED_PYTHON / f"{module_name}.py"
        module_source = module_path.read_text(encoding="utf-8")
        module_tree = ast.parse(module_source)
        leaf_wildcard_imports = [
            node
            for node in module_tree.body
            if isinstance(node, ast.ImportFrom)
            and any(alias.name == "*" for alias in node.names)
        ]
        assert not leaf_wildcard_imports
        class_names_by_module[module_name] = {
            node.name for node in module_tree.body if isinstance(node, ast.ClassDef)
        }
        future_imports = {
            alias.asname or alias.name
            for node in module_tree.body
            if isinstance(node, ast.ImportFrom) and node.module == "__future__"
            for alias in node.names
        }
        symbol_table = symtable.symtable(module_source, str(module_path), "exec")
        bound_names = {
            name
            for name in symbol_table.get_identifiers()
            if symbol_table.lookup(name).is_assigned() or symbol_table.lookup(name).is_imported()
        } - future_imports
        assert "__all__" not in bound_names
        public_names_by_module[module_name] = {
            name for name in bound_names if not name.startswith("_")
        }

    quantity_classes = class_names_by_module["quantity_verdict_v1"]
    quantity_public_names = public_names_by_module["quantity_verdict_v1"]
    assert {
        "QuantityVerdictIdentifier",
        "QuantityVerdictOutcome",
        "QuantityVerdictV1",
    } <= quantity_classes
    assert quantity_public_names.isdisjoint({"Verdict", "Quantity"})

    def _last_exporting_module(symbol: str) -> str:
        exporting_modules = [
            module_name
            for module_name in aggregate_modules
            if symbol in public_names_by_module[module_name]
        ]
        assert exporting_modules
        return exporting_modules[-1]

    assert _last_exporting_module("Verdict") == "launch_authorization_v1"
    assert _last_exporting_module("QuantityVerdictIdentifier") == "quantity_verdict_v1"
    assert _last_exporting_module("QuantityVerdictOutcome") == "quantity_verdict_v1"
    assert _last_exporting_module("QuantityVerdictV1") == "quantity_verdict_v1"


def _assert_payload_matches_schema(payload: dict) -> None:
    """Structural validation against the schema SSOT without an external
    jsonschema dependency: required keys, closed key set, enum membership,
    finding shape, and field types."""
    schema = json.loads(SCHEMA.read_text(encoding="utf-8"))
    for key in schema["required"]:
        assert key in payload
    assert set(payload) <= set(schema["properties"])
    assert payload["schema_version"] == 1
    assert isinstance(payload["manifest"], str) and payload["manifest"]
    assert payload["result"] in schema["properties"]["result"]["enum"]
    assert isinstance(payload["quantities_declared"], int) and payload["quantities_declared"] >= 0
    assert isinstance(payload["bindings_checked"], int) and payload["bindings_checked"] >= 0
    assert payload["overview_figure"] is None or isinstance(payload["overview_figure"], str)
    finding_schema = schema["$defs"]["DisplayGateFinding"]
    category_enum = finding_schema["properties"]["category"]["enum"]
    for finding in payload["findings"]:
        assert set(finding) <= set(finding_schema["properties"])
        for key in finding_schema["required"]:
            assert key in finding
        assert isinstance(finding["kind"], str) and finding["kind"]
        assert finding["category"] in category_enum
        assert isinstance(finding["message"], str) and finding["message"]
        if "quantity" in finding:
            assert isinstance(finding["quantity"], str) and finding["quantity"]
        if "path" in finding:
            assert isinstance(finding["path"], str) and finding["path"]
    # Invariant the schema cannot express: a non-pass verdict is always
    # explained by at least one finding.
    if payload["result"] != "pass":
        assert payload["findings"]


def test_payload_satisfies_schema(tmp_path: Path) -> None:
    manifest = _write_manifest(tmp_path, _bundle(tmp_path))
    _, payload = _run(manifest)
    _assert_payload_matches_schema(payload)


def test_failing_payload_satisfies_schema_and_explains_itself(tmp_path: Path) -> None:
    block = _bundle(tmp_path)
    block["verdict_bindings"] = []
    del block["overview_figure"]
    manifest = _write_manifest(tmp_path, block)
    _, payload = _run(manifest)
    assert payload["result"] != "pass"
    _assert_payload_matches_schema(payload)


# These controls change the actual source/rendered cells and re-pin them. Thus
# any refusal below must come from semantics, not merely stale evidence hashes.
def _change_source(tmp_path: Path, block: dict, change) -> None:
    source = tmp_path / block["final_display"]["source"]["path"]
    record = json.loads(source.read_text(encoding="utf-8"))
    change(record)
    source.write_text(json.dumps(record), encoding="utf-8")
    block["final_display"]["source"]["sha256"] = _sha256(source)


def _change_html(tmp_path: Path, block: dict, before: str, after: str, index: int = 0) -> None:
    surface = block["final_display"]["surfaces"][index]
    path = tmp_path / surface["path"]
    text = path.read_text(encoding="utf-8")
    assert before in text
    path.write_text(text.replace(before, after), encoding="utf-8")
    surface["sha256"] = surface["review"]["sha256"] = _sha256(path)


def _semantic_result(tmp_path: Path, block: dict, expected_kind: str | None) -> None:
    code, payload = _run(_write_manifest(tmp_path, block))
    if expected_kind is None:
        assert code == 0, payload
        assert payload["result"] == "pass"
    else:
        assert code == 1, payload
        assert payload["result"] == "verdict_mismatch"
        assert expected_kind in _kinds(payload), payload
    _assert_payload_matches_schema(payload)


def test_final_semantics_is_required_not_evidence_only(tmp_path: Path) -> None:
    block = _bundle(tmp_path)
    del block["final_display"]
    _semantic_result(tmp_path, block, "semantics-malformed")


def test_main_display_cannot_be_omitted_from_checked_surfaces(tmp_path: Path) -> None:
    manifest = _write_manifest(tmp_path, _bundle(tmp_path))
    record = json.loads(manifest.read_text())
    record["figure"] = "figs/uninspected.pdf"
    manifest.write_text(json.dumps(record))
    code, payload = _run(manifest)
    assert code == 1
    assert "main-surface-not-covered" in _kinds(payload)


@pytest.mark.parametrize("before,after", [
    ('>1.23<', '>1234<'),  # final value in milliseconds, still labelled seconds
    ('>s<', '>ms<'),       # late unit edit without changing the seconds values
    ('>1.23<', '>1.24<'),  # exceeds the printed rounding interval
])
def test_final_value_unit_corruption_refused_after_repin(tmp_path: Path, before: str, after: str) -> None:
    block = _bundle(tmp_path)
    _change_html(tmp_path, block, before, after)
    _semantic_result(tmp_path, block, "value-unit-mismatch")


def test_known_wrong_unit_cannot_be_whitelisted_as_translation(tmp_path: Path) -> None:
    block = _bundle(tmp_path)
    _change_html(tmp_path, block, '>s<', '>ms<')
    block["final_display"]["surfaces"][0]["unit_labels"] = {"s": "ms"}
    _semantic_result(tmp_path, block, "value-unit-mismatch")


def test_late_source_override_must_carry_units(tmp_path: Path) -> None:
    block = _bundle(tmp_path)
    # Replacement was already converted to seconds but retained the old ms unit.
    _change_source(tmp_path, block, lambda s: s["quantities"][0]["raw"].update(value="1.234"))
    _semantic_result(tmp_path, block, "value-unit-mismatch")


def test_source_override_value_unit_pair_accepted(tmp_path: Path) -> None:
    block = _bundle(tmp_path)
    _change_source(tmp_path, block, lambda s: s["quantities"][0]["raw"].update(value="1.234", unit="s"))
    _semantic_result(tmp_path, block, None)


def test_rounding_intervals_do_not_demand_raw_precision(tmp_path: Path) -> None:
    block = _bundle(tmp_path)
    _change_html(tmp_path, block, '>1.23<', '>1.2<')
    _change_html(tmp_path, block, '>2.35<', '>2.3<')
    _semantic_result(tmp_path, block, None)


def test_affine_forward_map_and_rounding(tmp_path: Path) -> None:
    block = _bundle(tmp_path)
    block["final_display"]["cells"][0]["transform"] = {
        "kind": "affine", "definition": "double the canonical interval and shift by one second",
        "scale": "2", "offset": "1"}
    _change_html(tmp_path, block, '>1.23<', '>3.47<')
    _semantic_result(tmp_path, block, None)


def test_noninvertible_map_uses_defined_forward_image(tmp_path: Path) -> None:
    block = _bundle(tmp_path)
    _change_source(tmp_path, block, lambda s: s["quantities"][0]["raw"].update(value="-1234"))
    block["final_display"]["cells"][0]["transform"] = {
        "kind": "absolute", "definition": "magnitude of the signed interval"}
    _semantic_result(tmp_path, block, None)


def _add_dual(tmp_path: Path, block: dict) -> None:
    final = block["final_display"]
    final["cells"].append({"id": "a_milli", "quantity": "quantity_a", "unit": "ms",
                          "transform": {"kind": "identity", "definition": "native unit representation"}})
    surface = final["surfaces"][0]
    surface["labels"]["a_milli"] = "Interval A in source units"
    surface["unit_labels"]["ms"] = "ms"
    cell_html = _html_cells([{"id": "a_milli", "label": "Interval A in source units", "value": "1234", "unit": "ms"}])
    _change_html(tmp_path, block, '</table>', cell_html.removeprefix('<table data-results>'))


def test_unintended_reversible_duplicate_representation_refused(tmp_path: Path) -> None:
    block = _bundle(tmp_path)
    _add_dual(tmp_path, block)
    _semantic_result(tmp_path, block, "duplicate-representation")


def test_declared_useful_dual_representation_accepted(tmp_path: Path) -> None:
    block = _bundle(tmp_path)
    _add_dual(tmp_path, block)
    block["final_display"]["dual_representations"] = [
        {"cells": ["a", "a_milli"], "purpose": "compare the reported value with a source-unit instrument reading"}]
    _semantic_result(tmp_path, block, None)


def test_alias_quantity_ids_do_not_evade_identity_dedup(tmp_path: Path) -> None:
    block = _bundle(tmp_path)
    def change(source):
        source["quantities"][1]["identity"] = source["quantities"][0]["identity"].copy()
        source["quantities"][1]["raw"]["value"] = "1234"
    _change_source(tmp_path, block, change)
    _change_html(tmp_path, block, '>2.35<', '>1.23<')
    _semantic_result(tmp_path, block, "duplicate-representation")


@pytest.mark.parametrize("context", ["reference", "parameter", "model", "basis", "definition"])
def test_equal_values_with_different_identity_are_not_deduped(tmp_path: Path, context: str) -> None:
    block = _bundle(tmp_path)
    def change(source):
        source["quantities"][1]["identity"] = source["quantities"][0]["identity"].copy()
        source["quantities"][1]["identity"][context] = "different context"
        source["quantities"][1]["raw"]["value"] = "1234"
    _change_source(tmp_path, block, change)
    _change_html(tmp_path, block, '>2.35<', '>1.23<')
    _semantic_result(tmp_path, block, None)


def test_diagnostic_requires_reader_purpose_even_if_verified(tmp_path: Path) -> None:
    block = _bundle(tmp_path)
    _change_source(tmp_path, block, lambda s: s["quantities"][0].update(role="diagnostic"))
    _semantic_result(tmp_path, block, "diagnostic-in-display")


def test_diagnostic_is_allowed_when_it_is_the_readers_subject(tmp_path: Path) -> None:
    block = _bundle(tmp_path)
    _change_source(tmp_path, block, lambda s: s["quantities"][0].update(role="diagnostic"))
    block["final_display"]["diagnostic_purposes"] = {"quantity_a": "study the instrument settling interval"}
    _semantic_result(tmp_path, block, None)


def test_intermediate_cannot_enter_limited_reader_selection(tmp_path: Path) -> None:
    block = _bundle(tmp_path)
    _change_source(tmp_path, block, lambda s: s["quantities"].append({
        "id": "internal", "identity": {"object": "instrument", "conditions": "fixed", "reference": "start",
                                       "definition": "iteration count"}, "role": "intermediate",
        "raw": {"value": "7", "unit": "1"}}))
    block["final_display"]["cells"].append({"id": "internal", "quantity": "internal", "unit": "1",
                                          "transform": {"kind": "identity", "definition": "raw count"}})
    _semantic_result(tmp_path, block, "display-selection-mismatch")


def _vector_bundle(tmp_path: Path) -> dict:
    block = _bundle(tmp_path)
    def change(source):
        quantity = source["quantities"][0]
        del quantity["raw"]
        quantity.update(component_definition="ordered signed coordinates", normalization="unnormalized",
                        components=[{"id": "first", "definition": "first coordinate", "raw": {"value": "-2", "unit": "m"}},
                                    {"id": "second", "definition": "second coordinate", "raw": {"value": "3", "unit": "m"}}])
    _change_source(tmp_path, block, change)
    block["final_display"]["cells"] = [
        {"id": "first", "quantity": "quantity_a", "component": "first", "unit": "m",
         "transform": {"kind": "identity", "definition": "signed coordinate"}},
        {"id": "second", "quantity": "quantity_a", "component": "second", "unit": "m",
         "transform": {"kind": "identity", "definition": "signed coordinate"}},
        block["final_display"]["cells"][1]]
    surface = block["final_display"]["surfaces"][0]
    surface["labels"] = {"first": "First coordinate", "second": "Second coordinate", "b": "Interval B"}
    surface["unit_labels"] = {"s": "s", "m": "m"}
    path = tmp_path / surface["path"]
    path.write_text(_html_cells([
        {"id": "first", "label": "First coordinate", "value": "-2.0", "unit": "m"},
        {"id": "second", "label": "Second coordinate", "value": "3.0", "unit": "m"},
        {"id": "b", "label": "Interval B", "value": "2.35", "unit": "s"}]), encoding="utf-8")
    surface["sha256"] = surface["review"]["sha256"] = _sha256(path)
    return block


def test_signed_vector_needs_no_probability_normalization(tmp_path: Path) -> None:
    block = _vector_bundle(tmp_path)
    _semantic_result(tmp_path, block, None)


@pytest.mark.parametrize("missing", ["component_definition", "normalization"])
def test_vector_requires_complete_definition(tmp_path: Path, missing: str) -> None:
    block = _vector_bundle(tmp_path)
    _change_source(tmp_path, block, lambda s: s["quantities"][0].pop(missing))
    _semantic_result(tmp_path, block, "component-identity-missing")


def test_vector_leaf_without_identity_is_refused(tmp_path: Path) -> None:
    block = _vector_bundle(tmp_path)
    del block["final_display"]["cells"][0]["component"]
    _semantic_result(tmp_path, block, "component-identity-missing")


def test_final_component_order_corruption_is_refused(tmp_path: Path) -> None:
    block = _vector_bundle(tmp_path)
    _change_html(tmp_path, block, 'data-display-id="first"', 'data-display-id="swap"')
    _change_html(tmp_path, block, 'data-display-id="second"', 'data-display-id="first"')
    _change_html(tmp_path, block, 'data-display-id="swap"', 'data-display-id="second"')
    _semantic_result(tmp_path, block, "final-cell-order-mismatch")


def test_inventory_component_order_is_not_only_final_file_order(tmp_path: Path) -> None:
    block = _vector_bundle(tmp_path)
    block["final_display"]["cells"][:2] = reversed(block["final_display"]["cells"][:2])
    _semantic_result(tmp_path, block, "component-order-mismatch")


def _add_vector_dual(tmp_path: Path, block: dict, order: list[str]) -> None:
    final = block["final_display"]
    # The expected cells are explicit source-coordinate observations in cm.
    extra = {"first": ("First coordinate in cm", "-200.0"),
             "second": ("Second coordinate in cm", "300.0")}
    final["cells"][0]["representation"] = final["cells"][1]["representation"] = "native"
    surface = final["surfaces"][0]
    added = []
    for component in order:
        cid = component + "_cm"
        final["cells"].append({"id": cid, "quantity": "quantity_a", "component": component,
                               "representation": "centimetres", "unit": "cm",
                               "transform": {"kind": "identity", "definition": "coordinates in centimetres"}})
        label, value = extra[component]
        surface["labels"][cid] = label
        added.append({"id": cid, "label": label, "value": value, "unit": "cm"})
    surface["unit_labels"]["cm"] = "cm"
    final["dual_representations"] = [
        {"cells": [component, component + "_cm"], "purpose": "compare coordinate unit systems"}
        for component in ["first", "second"]]
    _change_html(tmp_path, block, '</table>', _html_cells(added).removeprefix('<table data-results>'))


def test_each_vector_representation_needs_declared_component_order(tmp_path: Path) -> None:
    block = _vector_bundle(tmp_path)
    _add_vector_dual(tmp_path, block, ["second", "first"])
    _semantic_result(tmp_path, block, "component-order-mismatch")


def test_component_major_dual_table_is_valid(tmp_path: Path) -> None:
    block = _vector_bundle(tmp_path)
    _add_vector_dual(tmp_path, block, ["first", "second"])
    final = block["final_display"]
    final["cells"] = [final["cells"][i] for i in [0, 3, 1, 4, 2]]
    surface = final["surfaces"][0]
    path = tmp_path / surface["path"]
    path.write_text(_html_cells([
        {"id": "first", "label": "First coordinate", "value": "-2.0", "unit": "m"},
        {"id": "first_cm", "label": "First coordinate in cm", "value": "-200.0", "unit": "cm"},
        {"id": "second", "label": "Second coordinate", "value": "3.0", "unit": "m"},
        {"id": "second_cm", "label": "Second coordinate in cm", "value": "300.0", "unit": "cm"},
        {"id": "b", "label": "Interval B", "value": "2.35", "unit": "s"}]), encoding="utf-8")
    surface["sha256"] = surface["review"]["sha256"] = _sha256(path)
    _semantic_result(tmp_path, block, None)


def _add_translation(tmp_path: Path, block: dict) -> None:
    surface = json.loads(json.dumps(block["final_display"]["surfaces"][0]))
    surface.update(path="figs/summary-zh.html", language="zh", labels={"a": "间隔甲", "b": "间隔乙"}, unit_labels={"s": "秒"})
    path = tmp_path / surface["path"]
    path.write_text(_html_cells([
        {"id": "a", "label": "间隔甲", "value": "1.23", "unit": "秒"},
        {"id": "b", "label": "间隔乙", "value": "2.35", "unit": "秒"}]), encoding="utf-8")
    surface["sha256"] = surface["review"]["sha256"] = _sha256(path)
    block["final_display"]["surfaces"].append(surface)


def test_equivalent_multilingual_final_output_is_accepted(tmp_path: Path) -> None:
    block = _bundle(tmp_path)
    _add_translation(tmp_path, block)
    _semantic_result(tmp_path, block, None)


def test_wrong_translated_value_refused_even_if_other_language_correct(tmp_path: Path) -> None:
    block = _bundle(tmp_path)
    _add_translation(tmp_path, block)
    _change_html(tmp_path, block, '>1.23<', '>1234<', index=1)
    _semantic_result(tmp_path, block, "value-unit-mismatch")


@pytest.mark.parametrize("status,visible", [("failed", "failed"), ("missing", "missing"), ("not_applicable", "not_applicable")])
def test_distinct_unavailable_statuses_preserved(tmp_path: Path, status: str, visible: str) -> None:
    block = _bundle(tmp_path)
    _change_source(tmp_path, block, lambda s: s["quantities"][0]["raw"].update(value=None, status=status))
    _change_html(tmp_path, block, '>1.23<', f'>{visible}<')
    _semantic_result(tmp_path, block, None)


def test_failure_cannot_be_relabelled_as_missing(tmp_path: Path) -> None:
    block = _bundle(tmp_path)
    _change_source(tmp_path, block, lambda s: s["quantities"][0]["raw"].update(value=None, status="failed"))
    _change_html(tmp_path, block, '>1.23<', '>missing<')
    _semantic_result(tmp_path, block, "status-mismatch")


def test_partial_status_translation_cannot_collapse_distinctions(tmp_path: Path) -> None:
    block = _bundle(tmp_path)
    def change(source):
        source["quantities"][0]["raw"].update(value=None, status="failed")
        source["quantities"][1]["raw"].update(value=None, status="missing")
    _change_source(tmp_path, block, change)
    _change_html(tmp_path, block, '>1.23<', '>missing<')
    _change_html(tmp_path, block, '>2.35<', '>missing<')
    block["final_display"]["surfaces"][0]["status_labels"] = {"failed": "missing"}
    _semantic_result(tmp_path, block, "status-mismatch")


def test_known_status_words_cannot_be_swapped_as_translation(tmp_path: Path) -> None:
    block = _bundle(tmp_path)
    def change(source):
        source["quantities"][0]["raw"].update(value=None, status="failed")
        source["quantities"][1]["raw"].update(value=None, status="missing")
    _change_source(tmp_path, block, change)
    _change_html(tmp_path, block, '>1.23<', '>missing<')
    _change_html(tmp_path, block, '>2.35<', '>failed<')
    block["final_display"]["surfaces"][0]["status_labels"] = {"failed": "missing", "missing": "failed"}
    _semantic_result(tmp_path, block, "status-mismatch")


def test_static_adapter_rejects_unmapped_table_cell(tmp_path: Path) -> None:
    block = _bundle(tmp_path)
    _change_html(tmp_path, block, '</table>', '<tr><td>7</td></tr></table>')
    _semantic_result(tmp_path, block, "cell-identity-missing")


def test_final_label_corruption_refused(tmp_path: Path) -> None:
    block = _bundle(tmp_path)
    _change_html(tmp_path, block, '>Interval A<', '>Interval B<')
    _semantic_result(tmp_path, block, "cell-label-mismatch")


def test_render_review_must_follow_final_bytes(tmp_path: Path) -> None:
    block = _bundle(tmp_path)
    block["final_display"]["surfaces"][0]["review"]["sha256"] = "0" * 64
    _semantic_result(tmp_path, block, "rendered-review-missing")


def test_small_table_serves_as_own_inspection_surface(tmp_path: Path) -> None:
    block = _bundle(tmp_path)
    block["overview_figure"] = {"path": "figs/summary.html", "archived": True}
    _semantic_result(tmp_path, block, None)


@pytest.mark.parametrize("slot", ["source", "surface", "extraction"])
def test_final_input_slots_cannot_be_clobbered_by_gate_output(tmp_path: Path, slot: str) -> None:
    block = _bundle(tmp_path)
    final = block["final_display"]
    if slot == "source":
        path = tmp_path / final["source"]["path"]
    elif slot == "surface":
        path = tmp_path / final["surfaces"][0]["path"]
    else:
        path = tmp_path / "missing-extraction.json"
        final["surfaces"][0].update(format="extracted", extraction={"path": path.name, "sha256": "0" * 64})
    before = path.read_bytes() if path.exists() else None
    manifest = _write_manifest(tmp_path, block)
    proc = subprocess.run([sys.executable, str(GATE), "--manifest", str(manifest), "--out-json", str(path)],
                          capture_output=True, text=True, check=False)
    payload = json.loads(proc.stdout)
    assert proc.returncode == 2
    assert "out-json-protected-input" in _kinds(payload)
    assert (path.read_bytes() if path.exists() else None) == before


@pytest.mark.parametrize("absent_or_malformed", [None, []])
def test_primary_surface_protected_even_without_valid_acceptance_block(tmp_path: Path, absent_or_malformed) -> None:
    _bundle(tmp_path)
    manifest = _write_manifest(tmp_path, absent_or_malformed)
    primary = tmp_path / "figs" / "summary.html"
    before = primary.read_bytes()
    proc = subprocess.run([sys.executable, str(GATE), "--manifest", str(manifest), "--out-json", str(primary)],
                          capture_output=True, text=True, check=False)
    assert proc.returncode == 2
    assert "out-json-protected-input" in _kinds(json.loads(proc.stdout))
    assert primary.read_bytes() == before


def test_reviewed_extracted_surface_has_semantic_checks(tmp_path: Path) -> None:
    block = _bundle(tmp_path)
    surface = block["final_display"]["surfaces"][0]
    extraction = tmp_path / "final-cells.json"
    extraction.write_text(json.dumps({"surface_sha256": surface["sha256"], "cells": [
        {"id": "a", "label": "Interval A", "value": "1.23", "unit": "s"},
        {"id": "b", "label": "Interval B", "value": "2.35", "unit": "s"}]}), encoding="utf-8")
    surface.update(format="extracted", extraction={"path": extraction.name, "sha256": _sha256(extraction)})
    _semantic_result(tmp_path, block, None)
    record = json.loads(extraction.read_text())
    record["cells"][0]["value"] = "1234"
    extraction.write_text(json.dumps(record), encoding="utf-8")
    surface["extraction"]["sha256"] = _sha256(extraction)
    _semantic_result(tmp_path, block, "value-unit-mismatch")


def test_builtin_units_cannot_be_redefined_to_mask_error(tmp_path: Path) -> None:
    block = _bundle(tmp_path)
    _change_source(tmp_path, block, lambda s: s.update(units={"ms": {"dimension": "time", "scale": "1", "offset": "0"}}))
    _semantic_result(tmp_path, block, "unit-invalid")


def test_semantic_json_also_rejects_duplicate_keys(tmp_path: Path) -> None:
    block = _bundle(tmp_path)
    source = tmp_path / block["final_display"]["source"]["path"]
    source.write_text('{"quantities": [], "quantities": []}', encoding="utf-8")
    block["final_display"]["source"]["sha256"] = _sha256(source)
    _semantic_result(tmp_path, block, "semantics-unreadable")
