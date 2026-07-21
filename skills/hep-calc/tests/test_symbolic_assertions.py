from __future__ import annotations

import json
import subprocess
from pathlib import Path

import pytest


SKILL_ROOT = Path(__file__).resolve().parents[1]
RUNNER = SKILL_ROOT / "scripts" / "run_hep_calc.sh"
ENV_CHECK = SKILL_ROOT / "scripts" / "check_env.sh"
FIXTURES = Path(__file__).resolve().parent / "fixtures"


@pytest.fixture(scope="module", autouse=True)
def require_full_toolchain(tmp_path_factory: pytest.TempPathFactory) -> None:
    env_path = tmp_path_factory.mktemp("hepcalc-env") / "env.json"
    proc = subprocess.run(
        ["bash", str(ENV_CHECK), "--json", str(env_path)],
        cwd=SKILL_ROOT,
        check=False,
        capture_output=True,
        text=True,
    )
    if proc.returncode != 0 or not env_path.is_file():
        pytest.skip("full hep-calc toolchain is unavailable")
    env = json.loads(env_path.read_text(encoding="utf-8"))
    if not env.get("ok_full_toolchain"):
        pytest.skip("full hep-calc toolchain is unavailable")


def run_seed(
    tmp_path: Path,
    fixture_name: str,
    *,
    numeric_enable: bool = False,
    out_dir: Path | None = None,
) -> tuple[subprocess.CompletedProcess[str], Path]:
    entry = FIXTURES / fixture_name
    job = tmp_path / f"job-{entry.stem}.json"
    out_dir = out_dir or (tmp_path / "out")
    job.write_text(
        json.dumps(
            {
                "schema_version": 1,
                "name": f"symbolic-assertion-{entry.stem}",
                "mathematica": {"entry": str(entry)},
                "numeric": {"enable": numeric_enable},
                "latex": {"targets": []},
            },
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )
    proc = subprocess.run(
        ["bash", str(RUNNER), "--job", str(job), "--out", str(out_dir)],
        cwd=SKILL_ROOT,
        check=False,
        capture_output=True,
        text=True,
    )
    return proc, out_dir


def load_json(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def test_passing_assertions_and_legacy_checks(tmp_path: Path) -> None:
    proc, out_dir = run_seed(tmp_path, "assertions_pass.wls")
    assert proc.returncode == 0, proc.stdout + proc.stderr

    status = load_json(out_dir / "symbolic" / "status.json")
    summary = load_json(out_dir / "summary.json")
    symbolic = load_json(out_dir / "symbolic" / "symbolic.json")
    report = (out_dir / "report" / "audit_report.md").read_text(encoding="utf-8")

    expected = {
        "contract_valid": True,
        "total": 2,
        "pass": 2,
        "fail": 0,
        "invalid": 0,
        "failed_ids": [],
        "contract_errors": [],
    }
    assert status["status"] == "PASS"
    assert status["assertions"] == expected
    assert summary["overall_status"] == "PASS"
    assert summary["symbolic_assertions"] == expected
    assert symbolic["data"]["checks"] == {"legacy_anchor": 17.25, "legacy_zero_value": 0}
    assert "- assertions_total: 2" in report
    assert "- failed_ids: None" in report


def test_failing_assertion_fails_runner_and_overall_status(tmp_path: Path) -> None:
    proc, out_dir = run_seed(tmp_path, "assertions_fail.wls")
    assert proc.returncode != 0

    status = load_json(out_dir / "symbolic" / "status.json")
    summary = load_json(out_dir / "summary.json")
    symbolic = load_json(out_dir / "symbolic" / "symbolic.json")
    report = (out_dir / "report" / "audit_report.md").read_text(encoding="utf-8")

    expected = {
        "contract_valid": True,
        "total": 2,
        "pass": 1,
        "fail": 1,
        "invalid": 0,
        "failed_ids": ["seeded_failure"],
        "contract_errors": [],
    }
    assert status["status"] == "FAIL"
    assert status["reason"] == "symbolic_assertions_failed"
    assert status["assertions"] == expected
    assert summary["overall_status"] == "FAIL"
    assert summary["symbolic_assertions"] == expected
    assert symbolic["data"]["checks"] == {"legacy_anchor": 17.25, "legacy_zero_value": 0}
    assert "- fail: 1" in report
    assert "- failed_ids: seeded_failure" in report


def test_early_zero_exit_cannot_bypass_assertion_or_mask_with_later_error(tmp_path: Path) -> None:
    proc, out_dir = run_seed(tmp_path, "assertions_early_quit.wls", numeric_enable=True)
    assert proc.returncode != 0

    status = load_json(out_dir / "symbolic" / "status.json")
    numeric_status = load_json(out_dir / "numeric" / "status.json")
    summary = load_json(out_dir / "summary.json")

    assert status["status"] == "FAIL"
    assert status["reason"] == "symbolic_assertions_failed"
    assert status["assertions"]["failed_ids"] == ["early_quit_failure"]
    assert "symbolic_status_missing" in status["postconditions"]["errors"]
    assert numeric_status["status"] == "ERROR"
    assert summary["overall_status"] == "FAIL"


def test_reused_output_cannot_replay_stale_symbolic_pass(tmp_path: Path) -> None:
    first, out_dir = run_seed(tmp_path, "assertions_pass.wls")
    assert first.returncode == 0, first.stdout + first.stderr
    assert load_json(out_dir / "symbolic" / "status.json")["status"] == "PASS"

    second, _ = run_seed(tmp_path, "early_quit_no_export.wls", out_dir=out_dir)
    assert second.returncode != 0

    status = load_json(out_dir / "symbolic" / "status.json")
    summary = load_json(out_dir / "summary.json")
    assert status["status"] == "FAIL"
    assert status["reason"] == "invalid_symbolic_assertions_contract"
    assert status["assertions"]["contract_errors"] == ["symbolic_json_missing"]
    assert "symbolic_status_missing" in status["postconditions"]["errors"]
    assert not (out_dir / "symbolic" / "symbolic.json").exists()
    assert summary["overall_status"] == "FAIL"


def test_entry_message_preserves_assertion_counts_and_failure(tmp_path: Path) -> None:
    proc, out_dir = run_seed(tmp_path, "assertions_message_error.wls")
    assert proc.returncode != 0

    status = load_json(out_dir / "symbolic" / "status.json")
    summary = load_json(out_dir / "summary.json")

    assert status["status"] == "FAIL"
    assert status["assertions"]["total"] == 1
    assert status["assertions"]["fail"] == 1
    assert status["assertions"]["failed_ids"] == ["message_path_failure"]
    assert status["execution_observed"]["status"] == "ERROR"
    assert status["execution_observed"]["reason"] == "entry_execution_failed"
    assert summary["overall_status"] == "FAIL"


def test_missing_top_level_data_is_invalid_not_zero_assertions(tmp_path: Path) -> None:
    proc, out_dir = run_seed(tmp_path, "symbolic_missing_data.wls")
    assert proc.returncode != 0

    status = load_json(out_dir / "symbolic" / "status.json")
    summary = load_json(out_dir / "summary.json")

    assert status["status"] == "FAIL"
    assert status["reason"] == "invalid_symbolic_assertions_contract"
    assert status["assertions"]["total"] == 1
    assert status["assertions"]["invalid"] == 1
    assert status["assertions"]["contract_errors"] == ["missing_data"]
    assert summary["overall_status"] == "FAIL"


def test_duplicate_assertion_ids_are_invalid(tmp_path: Path) -> None:
    proc, out_dir = run_seed(tmp_path, "assertions_duplicate.wls")
    assert proc.returncode != 0

    status = load_json(out_dir / "symbolic" / "status.json")
    summary = load_json(out_dir / "summary.json")

    assert status["status"] == "FAIL"
    assert status["assertions"]["total"] == 2
    assert status["assertions"]["pass"] == 0
    assert status["assertions"]["fail"] == 2
    assert status["assertions"]["invalid"] == 2
    assert status["assertions"]["failed_ids"] == ["duplicate_id"]
    assert "duplicate_id:duplicate_id" in status["assertions"]["contract_errors"]
    assert summary["overall_status"] == "FAIL"


def test_legacy_payload_without_assertions_remains_valid(tmp_path: Path) -> None:
    proc, out_dir = run_seed(tmp_path, "legacy_checks_only.wls")
    assert proc.returncode == 0, proc.stdout + proc.stderr

    status = load_json(out_dir / "symbolic" / "status.json")
    symbolic = load_json(out_dir / "symbolic" / "symbolic.json")
    summary = load_json(out_dir / "summary.json")

    assert status["status"] == "PASS"
    assert status["assertions"]["total"] == 0
    assert status["assertions"]["fail"] == 0
    assert symbolic["data"]["checks"] == {"legacy_anchor": 17.25, "legacy_zero_value": 0}
    assert summary["overall_status"] == "PASS"


def test_residual_tolerance_boundary_and_inconsistency(tmp_path: Path) -> None:
    proc, out_dir = run_seed(tmp_path, "assertions_residual_edges.wls")
    assert proc.returncode != 0

    status = load_json(out_dir / "symbolic" / "status.json")
    summary = load_json(out_dir / "summary.json")

    assert status["status"] == "FAIL"
    assert status["assertions"]["total"] == 2
    assert status["assertions"]["pass"] == 1
    assert status["assertions"]["fail"] == 1
    assert status["assertions"]["invalid"] == 1
    assert status["assertions"]["failed_ids"] == ["inconsistent_residual"]
    assert "inconsistent_residual:passed_residual_mismatch" in status["assertions"]["contract_errors"]
    assert summary["overall_status"] == "FAIL"
