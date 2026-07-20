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
import os
import subprocess
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[3]
GATE = REPO_ROOT / "skills" / "figure-hygiene" / "scripts" / "bin" / "check_display_acceptance.py"
SCHEMA = REPO_ROOT / "meta" / "schemas" / "display_gate_result_v1.schema.json"
VERDICT_SCHEMA = REPO_ROOT / "meta" / "schemas" / "quantity_verdict_v1.schema.json"


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
    from meta.generated import python as aggregate
    from meta.generated.python.launch_authorization_v1 import Verdict as LaunchAuthorizationVerdict
    from meta.generated.python import quantity_verdict_v1
    from meta.generated.python.quantity_verdict_v1 import (
        QuantityVerdictIdentifier,
        QuantityVerdictOutcome,
        QuantityVerdictV1,
    )

    assert aggregate.Verdict is LaunchAuthorizationVerdict
    assert not hasattr(quantity_verdict_v1, "Verdict")
    assert not hasattr(quantity_verdict_v1, "Quantity")
    assert aggregate.QuantityVerdictIdentifier is QuantityVerdictIdentifier
    assert aggregate.QuantityVerdictOutcome is QuantityVerdictOutcome
    assert aggregate.QuantityVerdictV1 is QuantityVerdictV1


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
