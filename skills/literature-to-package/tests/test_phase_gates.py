#!/usr/bin/env python3
"""Behavior tests for the literature-to-package phase gates.

Each phase gets at least one pass case and one case per load-bearing
falsification label. The gate is exercised as a subprocess (stdout = machine
verdict, stderr = diagnostics), the way callers run it."""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

SKILL_ROOT = Path(__file__).resolve().parent.parent
GATE = SKILL_ROOT / "scripts" / "gates" / "check_phase.py"


def _write(path: Path, content: str) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")
    return path


def _wjson(path: Path, obj: object) -> Path:
    return _write(path, json.dumps(obj, indent=2))


def _run(phase: str, artifact: Path, root: Path | None = None) -> tuple[int, dict, str]:
    cmd = [sys.executable, str(GATE), "--phase", phase, "--artifact", str(artifact)]
    if root is not None:
        cmd += ["--package-root", str(root)]
    proc = subprocess.run(cmd, capture_output=True, text=True, check=False)
    payload = json.loads(proc.stdout.strip())
    assert payload["schema_id"] == "literature_to_package_gate_result_v1"
    assert payload["exit_code"] == proc.returncode
    return proc.returncode, payload, proc.stderr


def _assert_label(payload: dict, label: str) -> None:
    assert label in payload["labels"], f"expected {label} in {payload['labels']}\nreasons: {payload['reasons']}"


# ---------------------------------------------------------------------------
# survey
# ---------------------------------------------------------------------------


def _survey(components: list[dict]) -> dict:
    return {"schema_id": "survey_decision_v1", "components": components}


def _component(**over: object) -> dict:
    base: dict = {
        "id": "solver",
        "decision": "build",
        "searches": [{"query": "integral equation solver", "venue": "GitHub", "date": "2026-07-07"}],
        "strongest_prior_art": [{"statement": "closest existing method", "source": "paperA", "locator": "Sec 3"}],
        "originality_claim": False,
        "no_public_code_found": False,
    }
    base.update(over)
    return base


def test_survey_pass(tmp_path: Path):
    rc, payload, _ = _run("survey", _wjson(tmp_path / "s.json", _survey([_component()])))
    assert rc == 0 and payload["status"] == "pass"


def test_survey_empty_fails(tmp_path: Path):
    rc, payload, _ = _run("survey", _wjson(tmp_path / "s.json", _survey([])))
    assert rc == 1
    _assert_label(payload, "EMPTY_SURVEY")


def test_survey_missing_search_log(tmp_path: Path):
    rc, payload, _ = _run("survey", _wjson(tmp_path / "s.json", _survey([_component(searches=[])])))
    assert rc == 1
    _assert_label(payload, "MISSING_SEARCH_LOG")


def test_survey_originality_needs_strongest_prior(tmp_path: Path):
    rc, payload, _ = _run(
        "survey",
        _wjson(tmp_path / "s.json", _survey([_component(originality_claim=True, strongest_prior_art=[])])),
    )
    assert rc == 1
    _assert_label(payload, "ORIGINALITY_WITHOUT_STRONGEST_PRIOR")


def test_survey_absence_not_novelty(tmp_path: Path):
    rc, payload, _ = _run(
        "survey",
        _wjson(
            tmp_path / "s.json",
            _survey([_component(originality_claim=True, no_public_code_found=True, strongest_prior_art=[])]),
        ),
    )
    assert rc == 1
    _assert_label(payload, "ABSENCE_PROMOTED_TO_NOVELTY")


# ---------------------------------------------------------------------------
# extraction
# ---------------------------------------------------------------------------


def _extraction(items: list[dict], sources: list[dict] | None = None) -> dict:
    return {
        "schema_id": "extraction_manifest_v1",
        "sources": sources if sources is not None else [{"id": "paperA", "kind": "paper", "citation": "A et al."}],
        "items": items,
    }


def _item(**over: object) -> dict:
    base: dict = {
        "id": "eq_1",
        "kind": "equation",
        "verbatim": "T = K + K G T",
        "source": "paperA",
        "locator": "Eq. (12)",
    }
    base.update(over)
    return base


def test_extraction_pass(tmp_path: Path):
    rc, payload, _ = _run(
        "extraction",
        _wjson(tmp_path / "e.json", _extraction([_item(), _item(id="c_1", kind="constant", units="MeV")])),
    )
    assert rc == 0 and payload["status"] == "pass"


def test_extraction_empty_fails(tmp_path: Path):
    rc, payload, _ = _run("extraction", _wjson(tmp_path / "e.json", _extraction([])))
    assert rc == 1
    _assert_label(payload, "EMPTY_EXTRACTION")


def test_extraction_missing_verbatim_and_locator(tmp_path: Path):
    rc, payload, _ = _run(
        "extraction",
        _wjson(tmp_path / "e.json", _extraction([_item(verbatim=""), _item(id="eq_2", locator="")])),
    )
    assert rc == 1
    _assert_label(payload, "MISSING_VERBATIM")
    _assert_label(payload, "MISSING_LOCATOR")


def test_extraction_constant_requires_units(tmp_path: Path):
    rc, payload, _ = _run(
        "extraction", _wjson(tmp_path / "e.json", _extraction([_item(kind="constant")]))
    )
    assert rc == 1
    _assert_label(payload, "MISSING_UNITS")


def test_extraction_memory_is_not_a_source(tmp_path: Path):
    rc, payload, _ = _run(
        "extraction",
        _wjson(
            tmp_path / "e.json",
            _extraction(
                [_item(source="recall")],
                sources=[{"id": "recall", "kind": "memory", "citation": "as remembered"}],
            ),
        ),
    )
    assert rc == 1
    _assert_label(payload, "MEMORY_CITED_AS_SOURCE")


def test_extraction_unknown_source(tmp_path: Path):
    rc, payload, _ = _run(
        "extraction", _wjson(tmp_path / "e.json", _extraction([_item(source="ghost")]))
    )
    assert rc == 1
    _assert_label(payload, "UNKNOWN_SOURCE")


# ---------------------------------------------------------------------------
# skeleton
# ---------------------------------------------------------------------------


def _make_pkg(tmp_path: Path) -> Path:
    root = tmp_path / "pkg"
    _write(root / "README.md", "# Example package\n")
    _write(root / "tests" / "test_example.py", "def test_placeholder():\n    assert True\n")
    _write(root / "docs" / "api.md", "## example_export\n")
    _write(root / "src" / "example.py", "def example_export():\n    return 1\n")
    _wjson(
        root / "traceability_ledger.json",
        {"entries": [{"artifact": "src/example.py#example_export", "extraction_ids": ["eq_1"], "status": "pending"}]},
    )
    return root


def _skeleton_manifest() -> dict:
    return {
        "schema_id": "skeleton_manifest_v1",
        "traceability_ledger": "traceability_ledger.json",
        "reference_asset_dirs": [],
        "exports": [{"name": "example_export", "doc_path": "docs/api.md", "test_path": "tests/test_example.py"}],
    }


def test_skeleton_pass(tmp_path: Path):
    root = _make_pkg(tmp_path)
    rc, payload, _ = _run("skeleton", _wjson(tmp_path / "sk.json", _skeleton_manifest()), root)
    assert rc == 0, payload["reasons"]


def test_skeleton_requires_package_root(tmp_path: Path):
    rc, payload, _ = _run("skeleton", _wjson(tmp_path / "sk.json", _skeleton_manifest()))
    assert rc == 2 and payload["status"] == "error"


def test_skeleton_absolute_path_fails(tmp_path: Path):
    root = _make_pkg(tmp_path)
    # Build the machine-specific path dynamically so no literal ships in a
    # committed file.
    bad = "/" + "Users" + "/someone/data.csv"
    _write(root / "src" / "loader.py", f'DATA = "{bad}"\n')
    rc, payload, _ = _run("skeleton", _wjson(tmp_path / "sk.json", _skeleton_manifest()), root)
    assert rc == 1
    _assert_label(payload, "ABSOLUTE_PATH_IN_PACKAGE")


def test_skeleton_missing_readme_and_tests(tmp_path: Path):
    root = tmp_path / "bare"
    _wjson(root / "traceability_ledger.json", {"entries": [{"artifact": "x", "extraction_ids": ["e"], "status": "pending"}]})
    manifest = _skeleton_manifest()
    manifest["exports"] = []
    rc, payload, _ = _run("skeleton", _wjson(tmp_path / "sk.json", manifest), root)
    assert rc == 1
    _assert_label(payload, "MISSING_README")
    _assert_label(payload, "MISSING_TEST_SKELETON")
    _assert_label(payload, "MISSING_EXPORT_MAP")


def test_skeleton_untraced_ledger_item(tmp_path: Path):
    root = _make_pkg(tmp_path)
    _wjson(root / "traceability_ledger.json", {"entries": [{"artifact": "src/orphan.py", "status": "pending"}]})
    rc, payload, _ = _run("skeleton", _wjson(tmp_path / "sk.json", _skeleton_manifest()), root)
    assert rc == 1
    _assert_label(payload, "UNTRACED_LEDGER_ITEM")


def test_skeleton_export_legs_must_exist(tmp_path: Path):
    root = _make_pkg(tmp_path)
    manifest = _skeleton_manifest()
    manifest["exports"] = [{"name": "ghost", "doc_path": "docs/none.md", "test_path": "tests/none.py"}]
    rc, payload, _ = _run("skeleton", _wjson(tmp_path / "sk.json", manifest), root)
    assert rc == 1
    _assert_label(payload, "EXPORT_MISSING_DOC")
    _assert_label(payload, "EXPORT_MISSING_TEST")


def test_skeleton_exclusion_covering_root_rejected(tmp_path: Path):
    root = _make_pkg(tmp_path)
    bad = "/" + "Users" + "/someone/data.csv"
    _write(root / "src" / "loader.py", f'DATA = "{bad}"\n')
    manifest = _skeleton_manifest()
    manifest["reference_asset_dirs"] = ["."]  # would hollow out the scan
    rc, payload, _ = _run("skeleton", _wjson(tmp_path / "sk.json", manifest), root)
    assert rc == 1
    _assert_label(payload, "EXCLUSION_COVERS_ROOT")
    _assert_label(payload, "ABSOLUTE_PATH_IN_PACKAGE")  # the scan still ran


def test_skeleton_manifest_absolute_path_rejected(tmp_path: Path):
    root = _make_pkg(tmp_path)
    manifest = _skeleton_manifest()
    manifest["traceability_ledger"] = str(root / "traceability_ledger.json")
    rc, payload, _ = _run("skeleton", _wjson(tmp_path / "sk.json", manifest), root)
    assert rc == 1
    _assert_label(payload, "ABSOLUTE_PATH_IN_MANIFEST")


# ---------------------------------------------------------------------------
# reimplementation
# ---------------------------------------------------------------------------


def _make_reimpl_pkg(tmp_path: Path, verdict: str = "VERDICT: READY\n\n## Blockers\n(none)\n") -> Path:
    root = tmp_path / "pkg"
    _write(root / "specs" / "method_spec.md", "# SPEC\nSolve the integral equation from the cited items.\n")
    _write(root / "src" / "impl_main.py", "def solve():\n    return 42\n")
    _write(root / "checks" / "impl_alt.jl", "solve() = 42\n")
    _write(root / "reviews" / "verdict.md", verdict)
    _write(root / "reference_assets" / "original_solver.py", "def solve():\n    return 42\n")
    return root


def _independence(**over: object) -> dict:
    base: dict = {
        "schema_id": "independence_manifest_v1",
        "reference_code_paths": ["reference_assets/original_solver.py"],
        "methods": [
            {
                "id": "method_a",
                "spec_path": "specs/method_spec.md",
                "implementations": [
                    {"path": "src/impl_main.py", "origin": "fresh", "independent": True},
                    {"path": "checks/impl_alt.jl", "origin": "fresh", "independent": True},
                ],
                "review_verdicts": ["reviews/verdict.md"],
            }
        ],
    }
    base.update(over)
    return base


def test_reimplementation_pass(tmp_path: Path):
    root = _make_reimpl_pkg(tmp_path)
    rc, payload, _ = _run("reimplementation", _wjson(tmp_path / "i.json", _independence()), root)
    assert rc == 0, payload["reasons"]


def test_reimplementation_port_never_independent(tmp_path: Path):
    root = _make_reimpl_pkg(tmp_path)
    manifest = _independence()
    manifest["methods"][0]["implementations"][1]["origin"] = "ported_from_reference"
    rc, payload, _ = _run("reimplementation", _wjson(tmp_path / "i.json", manifest), root)
    assert rc == 1
    _assert_label(payload, "PORT_CLAIMED_INDEPENDENT")
    _assert_label(payload, "INSUFFICIENT_INDEPENDENT_IMPLEMENTATIONS")


def test_reimplementation_floor_is_two(tmp_path: Path):
    root = _make_reimpl_pkg(tmp_path)
    manifest = _independence()
    manifest["methods"][0]["implementations"] = manifest["methods"][0]["implementations"][:1]
    rc, payload, _ = _run("reimplementation", _wjson(tmp_path / "i.json", manifest), root)
    assert rc == 1
    _assert_label(payload, "INSUFFICIENT_INDEPENDENT_IMPLEMENTATIONS")


def test_reimplementation_coupling_between_implementations(tmp_path: Path):
    root = _make_reimpl_pkg(tmp_path)
    _write(root / "checks" / "impl_alt.jl", 'include("../src/impl_main.py")\n')
    rc, payload, _ = _run("reimplementation", _wjson(tmp_path / "i.json", _independence()), root)
    assert rc == 1
    _assert_label(payload, "IMPLEMENTATION_COUPLING")


def test_reimplementation_same_stem_pair_not_false_flagged(tmp_path: Path):
    # Two implementations both named solver.* each mention their own name;
    # identical stems are skipped (documented approximation), so this passes.
    root = tmp_path / "pkg"
    _write(root / "specs" / "method_spec.md", "# SPEC\nFrom the cited items.\n")
    _write(root / "src" / "solver.py", "def solver():\n    return 42\n")
    _write(root / "checks" / "solver.jl", "solver() = 42\n")
    _write(root / "reviews" / "verdict.md", "VERDICT: READY\n")
    manifest = _independence()
    manifest["reference_code_paths"] = []
    manifest["methods"][0]["implementations"] = [
        {"path": "src/solver.py", "origin": "fresh", "independent": True},
        {"path": "checks/solver.jl", "origin": "fresh", "independent": True},
    ]
    rc, payload, _ = _run("reimplementation", _wjson(tmp_path / "i.json", manifest), root)
    assert rc == 0, payload["reasons"]


def test_reimplementation_reference_code_coupling(tmp_path: Path):
    root = _make_reimpl_pkg(tmp_path)
    _write(root / "src" / "impl_main.py", "from original_solver import solve\n")
    rc, payload, _ = _run("reimplementation", _wjson(tmp_path / "i.json", _independence()), root)
    assert rc == 1
    _assert_label(payload, "REFERENCE_CODE_COUPLING")


def test_reimplementation_spec_must_not_cite_reference_code(tmp_path: Path):
    root = _make_reimpl_pkg(tmp_path)
    _write(root / "specs" / "method_spec.md", "# SPEC\nFollow original_solver.py closely.\n")
    rc, payload, _ = _run("reimplementation", _wjson(tmp_path / "i.json", _independence()), root)
    assert rc == 1
    _assert_label(payload, "SPEC_REFERENCES_SOURCE_CODE")


def test_reimplementation_review_not_approved(tmp_path: Path):
    root = _make_reimpl_pkg(tmp_path, verdict="VERDICT: NOT_READY\n\n## Blockers\n- divergence unresolved\n")
    rc, payload, _ = _run("reimplementation", _wjson(tmp_path / "i.json", _independence()), root)
    assert rc == 1
    _assert_label(payload, "REVIEW_NOT_APPROVED")


def test_reimplementation_json_pass_verdict_accepted(tmp_path: Path):
    root = _make_reimpl_pkg(tmp_path)
    _wjson(root / "reviews" / "verdict.md", {"verdict": "PASS", "blocking_issues": [], "summary": "ok"})
    rc, payload, _ = _run("reimplementation", _wjson(tmp_path / "i.json", _independence()), root)
    assert rc == 0, payload["reasons"]


def test_reimplementation_missing_review(tmp_path: Path):
    root = _make_reimpl_pkg(tmp_path)
    manifest = _independence()
    manifest["methods"][0]["review_verdicts"] = []
    rc, payload, _ = _run("reimplementation", _wjson(tmp_path / "i.json", manifest), root)
    assert rc == 1
    _assert_label(payload, "MISSING_INDEPENDENT_REVIEW")


# ---------------------------------------------------------------------------
# reference-check
# ---------------------------------------------------------------------------


def _check_row(**over: object) -> dict:
    base: dict = {
        "id": "anchor_1",
        "quantity": "binding energy",
        "representation": "grid_A",
        "computed": {"value": 1.2345, "error": 0.0004},
        "reference": {"value": 1.2340, "error": 0.0006, "source": "paperA", "locator": "Table 2"},
        "tolerance": 0.0007,
        "error_scale": 0.00072,
        "error_scale_basis": "combined quoted uncertainties",
    }
    base.update(over)
    return base


def _reference_check(checks: list[dict], **over: object) -> dict:
    base: dict = {
        "schema_id": "reference_check_v1",
        "checks": checks,
        "reference_only": [],
        "runtime_dep_files": [],
    }
    base.update(over)
    return base


def test_reference_check_pass(tmp_path: Path):
    root = tmp_path / "pkg"
    root.mkdir()
    checks = [_check_row(), _check_row(id="anchor_2", representation="basis_B")]
    rc, payload, _ = _run("reference-check", _wjson(tmp_path / "r.json", _reference_check(checks)), root)
    assert rc == 0, payload["reasons"]


def test_reference_check_recomputes_mismatch(tmp_path: Path):
    root = tmp_path / "pkg"
    root.mkdir()
    checks = [
        _check_row(computed={"value": 1.5000, "error": 0.0004}),
        _check_row(id="anchor_2", representation="basis_B"),
    ]
    rc, payload, _ = _run("reference-check", _wjson(tmp_path / "r.json", _reference_check(checks)), root)
    assert rc == 1
    _assert_label(payload, "VALUE_MISMATCH")


def test_reference_check_non_diagnostic_tolerance(tmp_path: Path):
    root = tmp_path / "pkg"
    root.mkdir()
    checks = [
        _check_row(tolerance=0.5),  # far coarser than error_scale
        _check_row(id="anchor_2", representation="basis_B"),
    ]
    rc, payload, _ = _run("reference-check", _wjson(tmp_path / "r.json", _reference_check(checks)), root)
    assert rc == 1
    _assert_label(payload, "NON_DIAGNOSTIC_TOLERANCE")


def test_reference_check_error_scale_inflation(tmp_path: Path):
    root = tmp_path / "pkg"
    root.mkdir()
    checks = [
        _check_row(tolerance=0.4, error_scale=0.5),  # tol <= scale but scale >> combined errors
        _check_row(id="anchor_2", representation="basis_B"),
    ]
    rc, payload, _ = _run("reference-check", _wjson(tmp_path / "r.json", _reference_check(checks)), root)
    assert rc == 1
    _assert_label(payload, "ERROR_SCALE_INFLATED")


def test_reference_check_single_sided_error_still_caps_scale(tmp_path: Path):
    # Omitting one error must TIGHTEN the error-scale ceiling, not disable it.
    root = tmp_path / "pkg"
    root.mkdir()
    checks = [
        _check_row(
            computed={"value": 1.2345, "error": 0.0004},
            reference={"value": 1.2340, "source": "paperA", "locator": "Table 2"},  # no error quoted
            tolerance=0.0004,
            error_scale=0.01,  # far above the single quoted error
        ),
        _check_row(id="anchor_2", representation="basis_B"),
    ]
    rc, payload, _ = _run("reference-check", _wjson(tmp_path / "r.json", _reference_check(checks)), root)
    assert rc == 1
    _assert_label(payload, "ERROR_SCALE_INFLATED")


def test_reference_check_single_representation(tmp_path: Path):
    root = tmp_path / "pkg"
    root.mkdir()
    checks = [_check_row(), _check_row(id="anchor_2")]  # same representation
    rc, payload, _ = _run("reference-check", _wjson(tmp_path / "r.json", _reference_check(checks)), root)
    assert rc == 1
    _assert_label(payload, "SINGLE_REPRESENTATION")


def test_reference_check_reference_asset_in_runtime_deps(tmp_path: Path):
    root = tmp_path / "pkg"
    _write(root / "Project.toml", '[deps]\nOriginalSolverPkg = "00000000-0000-0000-0000-000000000000"\n')
    checks = [_check_row(), _check_row(id="anchor_2", representation="basis_B")]
    artifact = _reference_check(checks, reference_only=["OriginalSolverPkg"], runtime_dep_files=["Project.toml"])
    rc, payload, _ = _run("reference-check", _wjson(tmp_path / "r.json", artifact), root)
    assert rc == 1
    _assert_label(payload, "REFERENCE_IN_RUNTIME_DEPS")


def test_reference_check_reference_assets_need_dep_files(tmp_path: Path):
    root = tmp_path / "pkg"
    root.mkdir()
    checks = [_check_row(), _check_row(id="anchor_2", representation="basis_B")]
    artifact = _reference_check(checks, reference_only=["OriginalSolverPkg"], runtime_dep_files=[])
    rc, payload, _ = _run("reference-check", _wjson(tmp_path / "r.json", artifact), root)
    assert rc == 1
    _assert_label(payload, "REFERENCE_IN_RUNTIME_DEPS")


def test_reference_check_self_claimed_pass_is_ignored(tmp_path: Path):
    root = tmp_path / "pkg"
    root.mkdir()
    row = _check_row(computed={"value": 9.0}, passed=True)  # claims pass, values disagree
    checks = [row, _check_row(id="anchor_2", representation="basis_B")]
    rc, payload, _ = _run("reference-check", _wjson(tmp_path / "r.json", _reference_check(checks)), root)
    assert rc == 1
    _assert_label(payload, "VALUE_MISMATCH")


# ---------------------------------------------------------------------------
# composite-gates
# ---------------------------------------------------------------------------


def _make_gate_files(root: Path, *, derivation_ok=True, reliability_ok=True, perf_ok=True) -> None:
    _wjson(
        root / "gates" / "derivation_verify_output.json",
        {"total_claims": 3, "converged": 3 if derivation_ok else 2, "unconverged": [] if derivation_ok else ["A3"]},
    )
    _wjson(
        root / "gates" / "reliability_matrix.json",
        {
            "reliable": 2 if reliability_ok else 1,
            "not_reliable": [] if reliability_ok else ["pole_R1"],
            "matrix": [{"id": "x", "verdict": "reliable"}, {"id": "y", "verdict": "reliable" if reliability_ok else "unconverged"}],
        },
    )
    _wjson(root / "gates" / "performance_verdict.json", {"verdict": "pass" if perf_ok else "inconclusive"})


def _composite(perf: object = "gates/performance_verdict.json") -> dict:
    return {
        "schema_id": "composite_gates_v1",
        "gates": {
            "derivation": "gates/derivation_verify_output.json",
            "numerical_reliability": "gates/reliability_matrix.json",
            "performance": perf,
        },
    }


def test_composite_gates_pass(tmp_path: Path):
    root = tmp_path / "pkg"
    _make_gate_files(root)
    rc, payload, _ = _run("composite-gates", _wjson(tmp_path / "c.json", _composite()), root)
    assert rc == 0, payload["reasons"]


def test_composite_gates_each_failure_detected(tmp_path: Path):
    for kw in ({"derivation_ok": False}, {"reliability_ok": False}, {"perf_ok": False}):
        root = tmp_path / f"pkg_{list(kw)[0]}"
        _make_gate_files(root, **kw)
        rc, payload, _ = _run("composite-gates", _wjson(root / "c.json", _composite()), root)
        assert rc == 1, kw
        _assert_label(payload, "GATE_NOT_PASSED")


def test_composite_gates_missing_verdict(tmp_path: Path):
    root = tmp_path / "pkg"
    _make_gate_files(root)
    (root / "gates" / "performance_verdict.json").unlink()
    rc, payload, _ = _run("composite-gates", _wjson(tmp_path / "c.json", _composite()), root)
    assert rc == 1
    _assert_label(payload, "MISSING_GATE_VERDICT")


def test_composite_gates_explicit_waiver_passes(tmp_path: Path):
    root = tmp_path / "pkg"
    _make_gate_files(root)
    rc, payload, _ = _run(
        "composite-gates",
        _wjson(tmp_path / "c.json", _composite(perf={"waived": True, "reason": "no performance claim is made"})),
        root,
    )
    assert rc == 0, payload["reasons"]


def test_composite_gates_silent_waiver_fails(tmp_path: Path):
    root = tmp_path / "pkg"
    _make_gate_files(root)
    rc, payload, _ = _run(
        "composite-gates", _wjson(tmp_path / "c.json", _composite(perf={"waived": True})), root
    )
    assert rc == 1
    _assert_label(payload, "SILENT_WAIVER")


# ---------------------------------------------------------------------------
# closeout
# ---------------------------------------------------------------------------


def _make_closeout_pkg(tmp_path: Path) -> Path:
    root = tmp_path / "pkg"
    _write(root / "README.md", "# Example\nRun the quickstart.\n")
    _write(root / "src" / "example.py", "def example():\n    return 1\n")
    _write(root / "closeout" / "quickstart_run.log", "quickstart ok\n")
    _wjson(
        root / "traceability_ledger.json",
        {"entries": [{"artifact": "src/example.py#example", "extraction_ids": ["eq_1"], "status": "verified"}]},
    )
    return root


def _closeout(**over: object) -> dict:
    base: dict = {
        "schema_id": "closeout_v1",
        "readme_examples": [{"id": "quickstart", "log": "closeout/quickstart_run.log"}],
        "scrub_lexicon": ["internalcodename"],
        "traceability_ledger": "traceability_ledger.json",
    }
    base.update(over)
    return base


def test_closeout_pass(tmp_path: Path):
    root = _make_closeout_pkg(tmp_path)
    rc, payload, _ = _run("closeout", _wjson(tmp_path / "co.json", _closeout()), root)
    assert rc == 0, payload["reasons"]


def test_closeout_unexecuted_example(tmp_path: Path):
    root = _make_closeout_pkg(tmp_path)
    (root / "closeout" / "quickstart_run.log").write_text("", encoding="utf-8")
    rc, payload, _ = _run("closeout", _wjson(tmp_path / "co.json", _closeout()), root)
    assert rc == 1
    _assert_label(payload, "UNEXECUTED_README_EXAMPLE")


def test_closeout_scrub_lexicon_hit(tmp_path: Path):
    root = _make_closeout_pkg(tmp_path)
    _write(root / "src" / "notes.md", "This module started from the internalcodename draft.\n")
    rc, payload, _ = _run("closeout", _wjson(tmp_path / "co.json", _closeout()), root)
    assert rc == 1
    _assert_label(payload, "SCRUB_LEXICON_HIT")


def test_closeout_unresolved_traceability(tmp_path: Path):
    root = _make_closeout_pkg(tmp_path)
    _wjson(
        root / "traceability_ledger.json",
        {"entries": [{"artifact": "src/example.py#example", "extraction_ids": ["eq_1"], "status": "pending"}]},
    )
    rc, payload, _ = _run("closeout", _wjson(tmp_path / "co.json", _closeout()), root)
    assert rc == 1
    _assert_label(payload, "UNRESOLVED_TRACEABILITY")


def test_closeout_requires_lexicon_or_reason(tmp_path: Path):
    root = _make_closeout_pkg(tmp_path)
    rc, payload, _ = _run("closeout", _wjson(tmp_path / "co.json", _closeout(scrub_lexicon=[])), root)
    assert rc == 1
    _assert_label(payload, "MISSING_CLOSEOUT_FIELDS")


def test_closeout_examples_or_reason(tmp_path: Path):
    root = _make_closeout_pkg(tmp_path)
    rc, payload, _ = _run("closeout", _wjson(tmp_path / "co.json", _closeout(readme_examples=[])), root)
    assert rc == 1
    _assert_label(payload, "MISSING_CLOSEOUT_FIELDS")


def test_closeout_final_tree_scans_reference_dirs_too(tmp_path: Path):
    root = _make_closeout_pkg(tmp_path)
    bad = "/" + "Users" + "/someone/notebook_export.py"
    _write(root / "reference_assets" / "leftover.py", f'ORIGIN = "{bad}"\n')
    rc, payload, _ = _run("closeout", _wjson(tmp_path / "co.json", _closeout()), root)
    assert rc == 1
    _assert_label(payload, "ABSOLUTE_PATH_IN_PACKAGE")


# ---------------------------------------------------------------------------
# executor plumbing
# ---------------------------------------------------------------------------


def test_missing_artifact_is_input_error(tmp_path: Path):
    rc, payload, _ = _run("survey", tmp_path / "missing.json")
    assert rc == 2 and payload["status"] == "error"
    _assert_label(payload, "INPUT_ERROR")


def test_invalid_json_is_input_error(tmp_path: Path):
    art = _write(tmp_path / "bad.json", "{not json")
    rc, payload, _ = _run("survey", art)
    assert rc == 2 and payload["status"] == "error"


def test_out_json_matches_stdout(tmp_path: Path):
    art = _wjson(tmp_path / "s.json", _survey([_component()]))
    out = tmp_path / "verdict.json"
    proc = subprocess.run(
        [sys.executable, str(GATE), "--phase", "survey", "--artifact", str(art), "--out-json", str(out)],
        capture_output=True, text=True, check=False,
    )
    assert proc.returncode == 0
    assert json.loads(out.read_text(encoding="utf-8")) == json.loads(proc.stdout.strip())


def test_templates_are_valid_json():
    tdir = SKILL_ROOT / "assets" / "templates"
    templates = sorted(tdir.glob("*.json"))
    assert len(templates) >= 8
    for t in templates:
        json.loads(t.read_text(encoding="utf-8"))
