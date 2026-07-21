from __future__ import annotations

import json
import hashlib
import importlib.util
import os
import shlex
import shutil
import subprocess
from pathlib import Path

import pytest


SKILL_ROOT = Path(__file__).resolve().parents[1]
RUNNER = SKILL_ROOT / "scripts" / "run_hep_calc.sh"
VALIDATOR = SKILL_ROOT / "scripts" / "validate_stage_postconditions.py"
GENERATE_REPORT = SKILL_ROOT / "scripts" / "generate_report.py"


def load_json(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def write_json(path: Path, value: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2) + "\n", encoding="utf-8")


def file_witness(path: Path) -> dict:
    return {
        "bytes": path.stat().st_size,
        "sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
    }


def require_full_toolchain() -> Path:
    real_wolframscript = shutil.which("wolframscript")
    if real_wolframscript is None:
        pytest.skip("wolframscript is unavailable")
    return Path(real_wolframscript).resolve()


def make_auto_qft_shim(tmp_path: Path, real_wolframscript: Path) -> Path:
    shim_dir = tmp_path / "stateful-bin"
    shim_dir.mkdir()
    shim = shim_dir / "wolframscript"
    shim.write_text(
        "#!/usr/bin/env python3\n"
        "import json\n"
        "import os\n"
        "import sys\n"
        "from pathlib import Path\n"
        f"real = {str(real_wolframscript)!r}\n"
        "if any(arg.endswith('run_auto_qft.wls') for arg in sys.argv):\n"
        "    mode = os.environ.get('HEP_CALC_TEST_AUTO_QFT_MODE')\n"
        "    job_path = Path(sys.argv[-4])\n"
        "    out_dir = Path(sys.argv[-3])\n"
        "    if mode in {'pass', 'pass_nonzero'}:\n"
        "        auto_dir = out_dir / 'auto_qft'\n"
        "        amp = auto_dir / 'amplitude' / 'amplitude_summed.m'\n"
        "        raw = auto_dir / 'amplitude' / 'amps_raw.m'\n"
        "        amp.parent.mkdir(parents=True, exist_ok=True)\n"
        "        amp.write_text('currentRunAmplitude\\n', encoding='utf-8')\n"
        "        raw.write_text('currentRunRawAmplitude\\n', encoding='utf-8')\n"
        "        job_record = {\n"
        "            'path': 'auto_qft/formcalc/job_snapshot.json',\n"
        "            'bytes': int(sys.argv[-2]),\n"
        "            'sha256': sys.argv[-1],\n"
        "        }\n"
        "        token = 'current-run-token'\n"
        "        producer = {\n"
        "            'stage': 'auto_qft_feynarts_producer',\n"
        "            'status': 'PASS',\n"
        "            'token': token,\n"
        "            'job': job_record,\n"
        "            'handoff': 'auto_qft/formcalc/handoff.json',\n"
        "            'amplitude': {\n"
        "                'path': 'auto_qft/amplitude/amps_raw.m',\n"
        "                'amp_count': 1,\n"
        "                'bytes': raw.stat().st_size,\n"
        "                'sha256': __import__('hashlib').sha256(raw.read_bytes()).hexdigest(),\n"
        "            },\n"
        "        }\n"
        "        handoff = {\n"
        "            'stage': 'auto_qft_formcalc_handoff',\n"
        "            'status': 'PASS',\n"
        "            'token': token,\n"
        "            'job': job_record,\n"
        "        }\n"
        "        status = {\n"
        "            'stage': 'auto_qft_one_loop',\n"
        "            'status': 'PASS',\n"
        "            'job': job_record,\n"
        "            'amplitude_level': 'feynarts',\n"
        "            'formcalc': {'status': 'SKIPPED', 'reason': 'not_requested'},\n"
        "        }\n"
        "        summary = {\n"
        "            'status': 'PASS',\n"
        "            'job': job_record,\n"
        "            'options': {\n"
        "                'formcalc': {'enable': False, 'status': 'SKIPPED'}\n"
        "            },\n"
        "        }\n"
        "        (auto_dir / 'producer_status.json').write_text(json.dumps(producer), encoding='utf-8')\n"
        "        handoff_path = auto_dir / 'formcalc' / 'handoff.json'\n"
        "        handoff_path.parent.mkdir(parents=True, exist_ok=True)\n"
        "        handoff_path.write_text(json.dumps(handoff), encoding='utf-8')\n"
        "        (auto_dir / 'status.json').write_text(json.dumps(status), encoding='utf-8')\n"
        "        (auto_dir / 'summary.json').write_text(json.dumps(summary), encoding='utf-8')\n"
        "        raise SystemExit(17 if mode == 'pass_nonzero' else 0)\n"
        "    if mode == 'abort':\n"
        "        print('$Aborted')\n"
        "        raise SystemExit(0)\n"
        "os.execv(real, [real, *sys.argv[1:]])\n",
        encoding="utf-8",
    )
    shim.chmod(0o755)
    return shim_dir


def test_enabled_auto_qft_missing_artifacts_fails_documented_runner(tmp_path: Path) -> None:
    real_wolframscript = require_full_toolchain()
    shim_dir = tmp_path / "bin"
    shim_dir.mkdir()
    shim = shim_dir / "wolframscript"
    shim.write_text(
        "#!/usr/bin/env bash\n"
        "for arg in \"$@\"; do\n"
        "  case \"$arg\" in\n"
        "    */run_auto_qft.wls) printf '%s\\n' '$Aborted'; exit 0 ;;\n"
        "  esac\n"
        "done\n"
        f"exec {shlex.quote(str(real_wolframscript))} \"$@\"\n",
        encoding="utf-8",
    )
    shim.chmod(0o755)

    job_path = tmp_path / "job.json"
    out_dir = tmp_path / "out"
    write_json(
        job_path,
        {
            "schema_version": 1,
            "name": "auto-qft-missing-artifact-seed",
            "auto_qft": {
                "enable": True,
                "feynarts_model": "QED",
                "feynarts_generic_model": "QED",
                "process": {
                    "in_fa": ["-F[1,{1}]", "F[1,{1}]"],
                    "out_fa": ["-F[1,{1}]", "F[1,{1}]"],
                },
                "formcalc": {"enable": True, "pave_reduce": "LoopTools"},
            },
            "numeric": {"enable": False},
            "latex": {"targets": []},
        },
    )
    env = dict(os.environ)
    env["PATH"] = f"{shim_dir}{os.pathsep}{env.get('PATH', '')}"
    proc = subprocess.run(
        ["bash", str(RUNNER), "--job", str(job_path), "--out", str(out_dir)],
        cwd=SKILL_ROOT,
        env=env,
        check=False,
        capture_output=True,
        text=True,
    )

    status = load_json(out_dir / "auto_qft" / "status.json")
    summary = load_json(out_dir / "summary.json")
    run_log = (out_dir / "logs" / "run_hep_calc.log").read_text(encoding="utf-8")

    assert proc.returncode != 0
    assert status["status"] == "ERROR"
    assert status["reason"] == "formcalc_failed"
    assert status["postconditions"]["status"] == "FAIL"
    assert status["postconditions"]["formcalc_requested"] is True
    errors = status["postconditions"]["errors"]
    assert "auto_qft_status_not_pass" in errors
    assert "auto_qft_summary_not_pass" in errors
    assert "amplitude_summed_missing_or_empty" in errors
    assert "formcalc_status_not_explicit_pass" in errors
    assert "formcalc_summary_not_explicit_pass" in errors
    assert "formcalc_amplitude_level_not_confirmed" in errors
    assert "formcalc_reducer_status_not_pass" in errors
    assert summary["overall_status"] == "ERROR"
    assert "auto_qft producer exited zero" in run_log
    assert "fresh-kernel FormCalc reducer ERROR" in run_log
    assert "auto_qft postcondition FAIL" in run_log
    assert "auto_qft stage OK" not in run_log


def test_reused_output_cannot_replay_stale_auto_qft_pass(tmp_path: Path) -> None:
    real_wolframscript = require_full_toolchain()
    shim_dir = make_auto_qft_shim(tmp_path, real_wolframscript)
    job_path = tmp_path / "reused-job.json"
    out_dir = tmp_path / "reused-out"
    write_json(
        job_path,
        {
            "schema_version": 1,
            "name": "auto-qft-reused-output-seed",
            "auto_qft": {
                "enable": True,
                "feynarts_model": "QED",
                "feynarts_generic_model": "QED",
                "process": {
                    "in_fa": ["-F[1,{1}]", "F[1,{1}]"],
                    "out_fa": ["-F[1,{1}]", "F[1,{1}]"],
                },
                "formcalc": {"enable": False},
            },
            "numeric": {"enable": False},
            "latex": {"targets": []},
        },
    )
    env = dict(os.environ)
    env["PATH"] = f"{shim_dir}{os.pathsep}{env.get('PATH', '')}"
    env["HEP_CALC_TEST_AUTO_QFT_MODE"] = "pass"
    first = subprocess.run(
        ["bash", str(RUNNER), "--job", str(job_path), "--out", str(out_dir)],
        cwd=SKILL_ROOT,
        env=env,
        check=False,
        capture_output=True,
        text=True,
    )
    assert first.returncode == 0, first.stdout + first.stderr
    assert load_json(out_dir / "auto_qft" / "status.json")["status"] == "PASS"
    amplitude = out_dir / "auto_qft" / "amplitude" / "amplitude_summed.m"
    assert amplitude.read_text(encoding="utf-8") == "currentRunAmplitude\n"

    env["HEP_CALC_TEST_AUTO_QFT_MODE"] = "abort"
    second = subprocess.run(
        ["bash", str(RUNNER), "--job", str(job_path), "--out", str(out_dir)],
        cwd=SKILL_ROOT,
        env=env,
        check=False,
        capture_output=True,
        text=True,
    )
    assert second.returncode != 0
    status = load_json(out_dir / "auto_qft" / "status.json")
    summary = load_json(out_dir / "summary.json")
    assert status["status"] == "ERROR"
    assert status["reason"] == "auto_qft_postcondition_failed"
    assert "auto_qft_status_missing" in status["postconditions"]["errors"]
    assert "auto_qft_summary_missing" in status["postconditions"]["errors"]
    assert "amplitude_summed_missing_or_empty" in status["postconditions"]["errors"]
    assert not amplitude.exists()
    assert summary["overall_status"] == "ERROR"


def test_nonzero_auto_qft_process_cannot_publish_root_pass(tmp_path: Path) -> None:
    real_wolframscript = require_full_toolchain()
    shim_dir = make_auto_qft_shim(tmp_path, real_wolframscript)
    job_path = tmp_path / "nonzero-pass-artifacts-job.json"
    out_dir = tmp_path / "nonzero-pass-artifacts-out"
    write_json(
        job_path,
        {
            "schema_version": 1,
            "name": "nonzero-process-pass-artifacts-seed",
            "auto_qft": {
                "enable": True,
                "feynarts_model": "QED",
                "feynarts_generic_model": "QED",
                "process": {
                    "in_fa": ["-F[1,{1}]", "F[1,{1}]"],
                    "out_fa": ["-F[1,{1}]", "F[1,{1}]"],
                },
                "formcalc": {"enable": False},
            },
            "numeric": {"enable": False},
            "latex": {"targets": []},
        },
    )
    env = dict(os.environ)
    env["PATH"] = f"{shim_dir}{os.pathsep}{env.get('PATH', '')}"
    env["HEP_CALC_TEST_AUTO_QFT_MODE"] = "pass_nonzero"
    proc = subprocess.run(
        ["bash", str(RUNNER), "--job", str(job_path), "--out", str(out_dir)],
        cwd=SKILL_ROOT,
        env=env,
        check=False,
        capture_output=True,
        text=True,
    )

    status = load_json(out_dir / "auto_qft" / "status.json")
    summary = load_json(out_dir / "summary.json")
    assert proc.returncode != 0
    assert status["status"] == "ERROR"
    assert "auto_qft_process_rc_nonzero:17" in status["postconditions"]["errors"]
    assert status["postconditions"]["observed_process_rc"] == 17
    assert summary["overall_status"] == "ERROR"
    assert summary["compute_passed"] is False


@pytest.mark.parametrize("link_kind", ["direct", "ancestor"])
def test_runner_rejects_out_dir_symlink_before_cleanup(
    tmp_path: Path,
    link_kind: str,
) -> None:
    job_path = tmp_path / "job.json"
    write_json(job_path, {"schema_version": 1})
    external_root = tmp_path / "external"
    external_out = external_root / "out"
    external_log = external_out / "logs" / "env_check.log"
    external_log.parent.mkdir(parents=True)
    external_log.write_text("do-not-touch\n", encoding="utf-8")

    if link_kind == "direct":
        out_dir = tmp_path / "out-link"
        out_dir.symlink_to(external_out, target_is_directory=True)
    else:
        linked_parent = tmp_path / "parent-link"
        linked_parent.symlink_to(external_root, target_is_directory=True)
        out_dir = linked_parent / "out"

    proc = subprocess.run(
        ["bash", str(RUNNER), "--job", str(job_path), "--out", str(out_dir)],
        cwd=SKILL_ROOT,
        check=False,
        capture_output=True,
        text=True,
    )
    assert proc.returncode != 0
    assert "unsafe --out path" in proc.stderr
    assert external_log.read_text(encoding="utf-8") == "do-not-touch\n"


@pytest.mark.parametrize(
    ("relative_path", "is_directory"),
    [
        ("meta/command_line.txt", False),
        ("job.resolved.json", False),
        ("inputs/job.original.json", False),
        ("auto_qft/feynarts_model", True),
    ],
)
def test_runner_rejects_every_existing_output_symlink_before_any_write(
    tmp_path: Path,
    relative_path: str,
    is_directory: bool,
) -> None:
    job_path = tmp_path / "job.json"
    write_json(job_path, {"schema_version": 1})
    out_dir = tmp_path / "out"
    link_path = out_dir / relative_path
    link_path.parent.mkdir(parents=True, exist_ok=True)
    external = tmp_path / "external-target"
    sentinel = external / "sentinel.txt" if is_directory else external
    if is_directory:
        external.mkdir()
    sentinel.write_text("do-not-touch\n", encoding="utf-8")
    link_path.symlink_to(external, target_is_directory=is_directory)

    proc = subprocess.run(
        ["bash", str(RUNNER), "--job", str(job_path), "--out", str(out_dir)],
        cwd=SKILL_ROOT,
        check=False,
        capture_output=True,
        text=True,
    )

    assert proc.returncode != 0
    assert "unsafe --out path" in proc.stderr
    assert sentinel.read_text(encoding="utf-8") == "do-not-touch\n"


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("auto_qft.enable", 1),
        ("auto_qft.enable", "true"),
        ("auto_qft.formcalc.enable", 1),
        ("auto_qft.formcalc.enable", "true"),
    ],
)
def test_malformed_auto_qft_enable_fails_before_computation(
    tmp_path: Path,
    field: str,
    value: object,
) -> None:
    job_path = tmp_path / "invalid-enable-job.json"
    out_dir = tmp_path / "invalid-enable-out"
    auto = {"enable": True, "formcalc": {"enable": False}}
    if field == "auto_qft.enable":
        auto["enable"] = value
    else:
        auto["formcalc"]["enable"] = value
    write_json(
        job_path,
        {
            "schema_version": 1,
            "auto_qft": auto,
            "numeric": {"enable": False},
            "latex": {"targets": []},
        },
    )

    write_json(out_dir / "auto_qft" / "status.json", {"status": "PASS"})
    write_json(out_dir / "auto_qft" / "summary.json", {"status": "PASS"})
    write_json(out_dir / "summary.json", {"overall_status": "PASS"})
    stale_amplitude = out_dir / "auto_qft" / "amplitude" / "amplitude_summed.m"
    stale_amplitude.parent.mkdir(parents=True, exist_ok=True)
    stale_amplitude.write_text("staleAmplitude\n", encoding="utf-8")
    stale_snapshot = out_dir / "auto_qft" / "formcalc" / "input_snapshot.m"
    stale_snapshot.parent.mkdir(parents=True, exist_ok=True)
    stale_snapshot.write_text("staleSnapshot\n", encoding="utf-8")
    stale_snapshot_tmp = out_dir / "auto_qft" / "formcalc" / ".input_snapshot.m.tmp"
    stale_snapshot_tmp.write_text("staleSnapshotTmp\n", encoding="utf-8")

    proc = subprocess.run(
        ["bash", str(RUNNER), "--job", str(job_path), "--out", str(out_dir)],
        cwd=SKILL_ROOT,
        check=False,
        capture_output=True,
        text=True,
    )
    assert proc.returncode != 0
    assert f"{field} must be a Boolean" in proc.stderr
    assert not (out_dir / "meta" / "env.json").exists()
    assert not (out_dir / "auto_qft" / "status.json").exists()
    assert not (out_dir / "auto_qft" / "summary.json").exists()
    assert not (out_dir / "summary.json").exists()
    assert not stale_amplitude.exists()
    assert not stale_snapshot.exists()
    assert not stale_snapshot_tmp.exists()


def test_exact_decimal_and_wide_integer_assertion_reconstruction(tmp_path: Path) -> None:
    out_dir = tmp_path / "exact-numbers"
    symbolic_path = out_dir / "symbolic" / "symbolic.json"
    symbolic_path.parent.mkdir(parents=True)
    symbolic_path.write_text(
        """{
  "schema_version": 1,
  "data": {
    "assertions": [
      {"id": "exact_boundary", "passed": true, "residual": 1e-12, "tolerance": 1e-12},
      {"id": "sub_float_ulp", "passed": true, "residual": 1.00000000000000001e-12, "tolerance": 1e-12},
      {"id": "wide_integer", "passed": true, "residual": 9007199254740993, "tolerance": 9007199254740992}
    ]
  }
}
""",
        encoding="utf-8",
    )
    write_json(
        out_dir / "symbolic" / "status.json",
        {"stage": "mathematica_symbolic", "status": "PASS"},
    )
    proc = subprocess.run(
        ["python3", str(VALIDATOR), "--stage", "symbolic", "--out", str(out_dir)],
        check=False,
    )
    assert proc.returncode != 0
    status = load_json(out_dir / "symbolic" / "status.json")
    assertions = status["assertions"]
    assert status["status"] == "FAIL"
    assert assertions["total"] == 3
    assert assertions["pass"] == 1
    assert assertions["fail"] == 2
    assert assertions["invalid"] == 2
    assert assertions["failed_ids"] == ["sub_float_ulp", "wide_integer"]
    assert "sub_float_ulp:passed_residual_mismatch" in assertions["contract_errors"]
    assert "wide_integer:passed_residual_mismatch" in assertions["contract_errors"]


def test_nonzero_symbolic_process_invalidates_complete_pass_artifacts(tmp_path: Path) -> None:
    out_dir = tmp_path / "nonzero-symbolic-process"
    write_json(
        out_dir / "symbolic" / "symbolic.json",
        {"schema_version": 1, "data": {"tasks": [], "assertions": []}},
    )
    write_json(
        out_dir / "symbolic" / "status.json",
        {"stage": "mathematica_symbolic", "status": "PASS"},
    )
    proc = subprocess.run(
        [
            "python3",
            str(VALIDATOR),
            "--stage",
            "symbolic",
            "--out",
            str(out_dir),
            "--observed-process-rc",
            "31",
        ],
        check=False,
    )

    status = load_json(out_dir / "symbolic" / "status.json")
    assert proc.returncode != 0
    assert status["status"] == "ERROR"
    assert "symbolic_process_rc_nonzero:31" in status["postconditions"]["errors"]
    assert status["postconditions"]["observed_process_rc"] == 31


def auto_qft_job() -> dict:
    return {
        "schema_version": 1,
        "auto_qft": {"enable": True, "formcalc": {"enable": True}},
    }


def auto_qft_validator_command(job_path: Path, out_dir: Path) -> list[str]:
    witness = file_witness(job_path)
    return [
        "python3",
        str(VALIDATOR),
        "--stage",
        "auto_qft",
        "--job",
        str(job_path),
        "--out",
        str(out_dir),
        "--expected-job-bytes",
        str(witness["bytes"]),
        "--expected-job-sha256",
        witness["sha256"],
    ]


def seed_formcalc_pass(out_dir: Path) -> dict[str, Path]:
    job_path = out_dir / "job.resolved.json"
    raw_path = out_dir / "auto_qft" / "amplitude" / "amps_raw.m"
    snapshot_path = out_dir / "auto_qft" / "formcalc" / "input_snapshot.m"
    amplitude_path = out_dir / "auto_qft" / "amplitude" / "amplitude_summed.m"
    producer_status_path = out_dir / "auto_qft" / "producer_status.json"
    handoff_path = out_dir / "auto_qft" / "formcalc" / "handoff.json"
    reducer_status_path = out_dir / "auto_qft" / "formcalc" / "status.json"
    token = "seeded-current-run-token"

    write_json(job_path, auto_qft_job())
    raw_path.parent.mkdir(parents=True, exist_ok=True)
    raw_path.write_text("seededRawAmplitude\n", encoding="utf-8")
    snapshot_path.parent.mkdir(parents=True, exist_ok=True)
    snapshot_path.write_bytes(raw_path.read_bytes())
    amplitude_path.write_text("seededReducedAmplitude\n", encoding="utf-8")
    raw_witness = file_witness(raw_path)
    output_witness = file_witness(amplitude_path)
    job_witness = file_witness(job_path)

    write_json(
        producer_status_path,
        {
            "stage": "auto_qft_feynarts_producer",
            "status": "PASS",
            "token": token,
            "job": {"path": "job.resolved.json", **job_witness},
            "handoff": "auto_qft/formcalc/handoff.json",
            "amplitude": {
                "path": "auto_qft/amplitude/amps_raw.m",
                "amp_count": 1,
                **raw_witness,
            },
        },
    )
    write_json(
        handoff_path,
        {
            "schema_version": 1,
            "stage": "auto_qft_formcalc_handoff",
            "status": "PASS",
            "token": token,
            "job": {"path": "job.resolved.json", **job_witness},
            "raw_path": "auto_qft/amplitude/amps_raw.m",
            "raw_bytes": raw_witness["bytes"],
            "raw_sha256": raw_witness["sha256"],
            "amp_count": 1,
            "pave_reduce": "LoopTools",
            "memory_limit_mb": 2048,
        },
    )
    write_json(
        reducer_status_path,
        {
            "stage": "auto_qft_formcalc_reducer",
            "status": "PASS",
            "memory_limit_mb": 2048,
            "pave_reduce": "LoopTools",
            "job": {"path": "job.resolved.json", **job_witness},
            "producer_token": token,
            "input": {
                "token": token,
                "path": "auto_qft/amplitude/amps_raw.m",
                **raw_witness,
            },
            "snapshot": {
                "token": token,
                "path": "auto_qft/formcalc/input_snapshot.m",
                "source_path": "auto_qft/amplitude/amps_raw.m",
                **raw_witness,
            },
            "input_chain_checks": {
                "after_snapshot_publish": "PASS",
                "after_snapshot_read": "PASS",
                "after_reduction": "PASS",
                "before_pass_publish": "PASS",
            },
            "output": {
                "path": "auto_qft/amplitude/amplitude_summed.m",
                **output_witness,
            },
        },
    )
    write_json(
        out_dir / "auto_qft" / "status.json",
        {
            "stage": "auto_qft_one_loop",
            "status": "PASS",
            "amplitude_level": "formcalc",
            "formcalc": {
                "status": "PASS",
                "reason": "",
                "reducer_status": "auto_qft/formcalc/status.json",
                "pave_reduce": "LoopTools",
                "memory_limit_mb": 2048,
                "job": {"path": "job.resolved.json", **job_witness},
                "producer_token": token,
                "input_path": "auto_qft/amplitude/amps_raw.m",
                "snapshot_path": "auto_qft/formcalc/input_snapshot.m",
                "input_bytes": raw_witness["bytes"],
                "input_sha256": raw_witness["sha256"],
                "output_path": "auto_qft/amplitude/amplitude_summed.m",
                "output_bytes": output_witness["bytes"],
                "output_sha256": output_witness["sha256"],
            },
        },
    )
    write_json(
        out_dir / "auto_qft" / "summary.json",
        {
            "status": "PASS",
            "job": {"path": "job.resolved.json", **job_witness},
            "options": {
                "formcalc": {
                    "enable": True,
                    "status": "PASS",
                    "pave_reduce": "LoopTools",
                    "memory_limit_mb": 2048,
                    "reducer_status": "auto_qft/formcalc/status.json",
                    "job": {"path": "job.resolved.json", **job_witness},
                    "output_path": "auto_qft/amplitude/amplitude_summed.m",
                    "output_bytes": output_witness["bytes"],
                    "output_sha256": output_witness["sha256"],
                }
            },
            "formcalc_reducer": load_json(reducer_status_path),
        },
    )
    return {
        "job": job_path,
        "raw": raw_path,
        "snapshot": snapshot_path,
        "output": amplitude_path,
        "status": out_dir / "auto_qft" / "status.json",
        "summary": out_dir / "auto_qft" / "summary.json",
        "producer": producer_status_path,
        "handoff": handoff_path,
        "reducer": reducer_status_path,
    }


def seed_nonformcalc_pass(out_dir: Path) -> dict[str, Path]:
    job_path = out_dir / "job.resolved.json"
    amplitude_path = out_dir / "auto_qft" / "amplitude" / "amplitude_summed.m"
    producer_path = out_dir / "auto_qft" / "producer_status.json"
    handoff_path = out_dir / "auto_qft" / "formcalc" / "handoff.json"
    status_path = out_dir / "auto_qft" / "status.json"
    summary_path = out_dir / "auto_qft" / "summary.json"
    write_json(
        job_path,
        {"schema_version": 1, "auto_qft": {"enable": True, "formcalc": {"enable": False}}},
    )
    job_witness = file_witness(job_path)
    job_record = {"path": "job.resolved.json", **job_witness}
    amplitude_path.parent.mkdir(parents=True, exist_ok=True)
    amplitude_path.write_text("seededRawFeynArtsAmplitude\n", encoding="utf-8")
    write_json(
        producer_path,
        {"stage": "auto_qft_feynarts_producer", "status": "PASS", "job": job_record},
    )
    write_json(handoff_path, {"stage": "auto_qft_formcalc_handoff", "status": "PASS", "job": job_record})
    write_json(
        status_path,
        {"stage": "auto_qft_one_loop", "status": "PASS", "job": job_record},
    )
    write_json(summary_path, {"status": "PASS", "job": job_record})
    return {
        "job": job_path,
        "amplitude": amplitude_path,
        "producer": producer_path,
        "handoff": handoff_path,
        "status": status_path,
        "summary": summary_path,
    }


def test_requested_formcalc_requires_explicit_pass(tmp_path: Path) -> None:
    failed_out = tmp_path / "failed"
    failed_job = failed_out / "job.resolved.json"
    write_json(failed_job, auto_qft_job())
    write_json(
        failed_out / "auto_qft" / "status.json",
        {
            "stage": "auto_qft_one_loop",
            "status": "PASS",
            "amplitude_level": "feynarts",
            "formcalc": {"status": "ERROR", "reason": "seeded"},
        },
    )
    write_json(
        failed_out / "auto_qft" / "summary.json",
        {
            "status": "PASS",
            "options": {"formcalc": {"enable": True, "status": "ERROR"}},
        },
    )
    amplitude = failed_out / "auto_qft" / "amplitude" / "amplitude_summed.m"
    amplitude.parent.mkdir(parents=True)
    amplitude.write_text("seededAmplitude\n", encoding="utf-8")

    failed = subprocess.run(
        auto_qft_validator_command(failed_job, failed_out),
        check=False,
    )
    failed_status = load_json(failed_out / "auto_qft" / "status.json")
    assert failed.returncode != 0
    assert failed_status["status"] == "ERROR"
    assert "formcalc_status_not_explicit_pass" in failed_status["postconditions"]["errors"]
    assert "formcalc_summary_not_explicit_pass" in failed_status["postconditions"]["errors"]
    assert "formcalc_amplitude_level_not_confirmed" in failed_status["postconditions"]["errors"]

    passed_out = tmp_path / "passed"
    passed_paths = seed_formcalc_pass(passed_out)
    passed_job = passed_paths["job"]

    passed = subprocess.run(
        auto_qft_validator_command(passed_job, passed_out),
        check=False,
    )
    passed_status = load_json(passed_out / "auto_qft" / "status.json")
    assert passed.returncode == 0
    assert passed_status["status"] == "PASS"
    assert passed_status["postconditions"]["status"] == "PASS"
    assert passed_status["postconditions"]["errors"] == []

    for name, malformed_job, expected_error in (
        (
            "malformed-auto-enable",
            {"auto_qft": {"enable": 1, "formcalc": {"enable": False}}},
            "auto_qft.enable_not_boolean",
        ),
        (
            "malformed-formcalc-enable",
            {"auto_qft": {"enable": True, "formcalc": {"enable": 1}}},
            "auto_qft.formcalc.enable_not_boolean",
        ),
    ):
        malformed_out = tmp_path / name
        malformed_job_path = malformed_out / "job.resolved.json"
        write_json(malformed_job_path, malformed_job)
        malformed = subprocess.run(
            auto_qft_validator_command(malformed_job_path, malformed_out),
            check=False,
        )
        malformed_status = load_json(malformed_out / "auto_qft" / "status.json")
        assert malformed.returncode != 0
        assert malformed_status["reason"] == "auto_qft_postcondition_validator_error"
        assert expected_error in malformed_status["postconditions"]["errors"][0]


def test_nonzero_formcalc_process_invalidates_complete_pass_artifacts(tmp_path: Path) -> None:
    out_dir = tmp_path / "nonzero-formcalc-process"
    paths = seed_formcalc_pass(out_dir)
    command = auto_qft_validator_command(paths["job"], out_dir)
    command.extend(["--observed-process-rc", "23"])
    proc = subprocess.run(command, check=False)

    status = load_json(paths["status"])
    summary = load_json(paths["summary"])
    assert proc.returncode != 0
    assert status["status"] == "ERROR"
    assert status["reason"] == "formcalc_failed"
    assert "auto_qft_process_rc_nonzero:23" in status["postconditions"]["errors"]
    assert status["postconditions"]["observed_process_rc"] == 23
    assert summary["status"] == "ERROR"


@pytest.mark.parametrize(
    ("mutated_link", "expected_error"),
    [
        ("current_raw", "formcalc_current_raw_bytes_mismatch"),
        ("producer_status", "formcalc_handoff_token_mismatch"),
        ("handoff", "formcalc_handoff_raw_sha256_mismatch"),
        ("input_snapshot", "formcalc_input_snapshot_bytes_mismatch"),
        ("reducer_status", "formcalc_reducer_input_sha256_mismatch"),
    ],
)
def test_formcalc_chain_mutation_is_rejected_without_wolfram(
    tmp_path: Path,
    mutated_link: str,
    expected_error: str,
) -> None:
    out_dir = tmp_path / mutated_link
    paths = seed_formcalc_pass(out_dir)

    if mutated_link == "current_raw":
        paths["raw"].write_bytes(paths["raw"].read_bytes() + b"mutated\n")
    elif mutated_link == "producer_status":
        value = load_json(paths["producer"])
        value["token"] = "replacement-producer-token"
        write_json(paths["producer"], value)
    elif mutated_link == "handoff":
        value = load_json(paths["handoff"])
        value["raw_sha256"] = "0" * 64
        write_json(paths["handoff"], value)
    elif mutated_link == "input_snapshot":
        paths["snapshot"].write_bytes(paths["snapshot"].read_bytes() + b"mutated\n")
    elif mutated_link == "reducer_status":
        value = load_json(paths["reducer"])
        value["input"]["sha256"] = "0" * 64
        write_json(paths["reducer"], value)
    else:  # pragma: no cover - parametrization is exhaustive
        raise AssertionError(mutated_link)

    proc = subprocess.run(
        auto_qft_validator_command(paths["job"], out_dir),
        check=False,
        capture_output=True,
        text=True,
    )
    status = load_json(out_dir / "auto_qft" / "status.json")
    assert proc.returncode != 0
    assert status["status"] == "ERROR"
    assert status["postconditions"]["status"] == "FAIL"
    assert expected_error in status["postconditions"]["errors"]


@pytest.mark.parametrize(
    ("surface", "field_path", "value", "expected_error"),
    [
        ("reducer", ("pave_reduce",), "False", "formcalc_reducer_pave_reduce_mismatch"),
        ("reducer", ("memory_limit_mb",), 1024, "formcalc_reducer_memory_limit_mismatch"),
        ("status", ("formcalc", "pave_reduce"), "False", "formcalc_top_pave_reduce_mismatch"),
        ("status", ("formcalc", "memory_limit_mb"), 1024, "formcalc_top_memory_limit_mismatch"),
        ("status", ("formcalc", "reducer_status"), "wrong.json", "formcalc_top_reducer_status_path_mismatch"),
        ("status", ("formcalc", "output_sha256"), "0" * 64, "formcalc_top_output_sha256_mismatch"),
        ("summary", ("options", "formcalc", "pave_reduce"), "False", "formcalc_summary_pave_reduce_mismatch"),
        ("summary", ("options", "formcalc", "memory_limit_mb"), 1024, "formcalc_summary_memory_limit_mismatch"),
        ("summary", ("options", "formcalc", "reducer_status"), "wrong.json", "formcalc_summary_reducer_status_path_mismatch"),
        ("summary", ("options", "formcalc", "output_sha256"), "0" * 64, "formcalc_summary_output_sha256_mismatch"),
    ],
)
def test_formcalc_configuration_and_output_field_mutations_fail_closed(
    tmp_path: Path,
    surface: str,
    field_path: tuple[str, ...],
    value: object,
    expected_error: str,
) -> None:
    out_dir = tmp_path / f"{surface}-{'-'.join(field_path)}"
    paths = seed_formcalc_pass(out_dir)
    target = paths[surface]
    payload = load_json(target)
    cursor = payload
    for key in field_path[:-1]:
        cursor = cursor[key]
    cursor[field_path[-1]] = value
    write_json(target, payload)
    proc = subprocess.run(
        auto_qft_validator_command(paths["job"], out_dir),
        check=False,
    )
    status = load_json(out_dir / "auto_qft" / "status.json")
    assert proc.returncode != 0
    assert expected_error in status["postconditions"]["errors"]


def test_formcalc_exact_job_binding_rejects_replacement(tmp_path: Path) -> None:
    out_dir = tmp_path / "job-binding"
    paths = seed_formcalc_pass(out_dir)
    original = file_witness(paths["job"])
    job = load_json(paths["job"])
    job["replacement"] = True
    write_json(paths["job"], job)
    proc = subprocess.run(
        [
            "python3",
            str(VALIDATOR),
            "--stage",
            "auto_qft",
            "--job",
            str(paths["job"]),
            "--out",
            str(out_dir),
            "--expected-job-bytes",
            str(original["bytes"]),
            "--expected-job-sha256",
            original["sha256"],
        ],
        check=False,
    )
    assert proc.returncode != 0
    status = load_json(out_dir / "auto_qft" / "status.json")
    assert "job_resolved_" in status["postconditions"]["errors"][0]


@pytest.mark.parametrize("missing", ["bytes", "sha256"])
def test_auto_qft_validator_requires_both_job_witnesses(tmp_path: Path, missing: str) -> None:
    out_dir = tmp_path / missing
    paths = seed_nonformcalc_pass(out_dir)
    witness = file_witness(paths["job"])
    command = [
        "python3",
        str(VALIDATOR),
        "--stage",
        "auto_qft",
        "--job",
        str(paths["job"]),
        "--out",
        str(out_dir),
    ]
    if missing != "bytes":
        command.extend(["--expected-job-bytes", str(witness["bytes"])])
    if missing != "sha256":
        command.extend(["--expected-job-sha256", witness["sha256"]])
    proc = subprocess.run(command, check=False)
    status = load_json(out_dir / "auto_qft" / "status.json")
    assert proc.returncode != 0
    assert f"expected_job_{missing}_required" in status["postconditions"]["errors"][0]


@pytest.mark.parametrize("link_kind", ["direct", "parent"])
def test_nonformcalc_amplitude_symlinks_fail_closed(tmp_path: Path, link_kind: str) -> None:
    out_dir = tmp_path / link_kind
    paths = seed_nonformcalc_pass(out_dir)
    if link_kind == "direct":
        real_amplitude = out_dir / "real-amplitude.m"
        real_amplitude.write_bytes(paths["amplitude"].read_bytes())
        paths["amplitude"].unlink()
        paths["amplitude"].symlink_to(real_amplitude)
    else:
        real_amplitude_dir = out_dir / "real-amplitude-dir"
        shutil.move(str(paths["amplitude"].parent), real_amplitude_dir)
        paths["amplitude"].parent.symlink_to(real_amplitude_dir, target_is_directory=True)
    proc = subprocess.run(
        auto_qft_validator_command(paths["job"], out_dir),
        check=False,
    )
    status = load_json(out_dir / "auto_qft" / "status.json")
    assert proc.returncode != 0
    assert any(
        error.startswith("amplitude_summed_")
        for error in status["postconditions"]["errors"]
    )


def test_nonformcalc_secure_amplitude_witness_passes(tmp_path: Path) -> None:
    out_dir = tmp_path / "pass"
    paths = seed_nonformcalc_pass(out_dir)
    proc = subprocess.run(auto_qft_validator_command(paths["job"], out_dir), check=False)
    status = load_json(out_dir / "auto_qft" / "status.json")
    assert proc.returncode == 0
    assert status["postconditions"]["status"] == "PASS"


@pytest.mark.parametrize("link_kind", ["direct", "parent"])
def test_formcalc_symlink_surfaces_fail_closed(tmp_path: Path, link_kind: str) -> None:
    out_dir = tmp_path / link_kind
    paths = seed_formcalc_pass(out_dir)
    if link_kind == "direct":
        real_raw = out_dir / "real-raw.m"
        real_raw.write_bytes(paths["raw"].read_bytes())
        paths["raw"].unlink()
        paths["raw"].symlink_to(real_raw)
    else:
        real_formcalc = out_dir / "real-formcalc"
        shutil.move(str(out_dir / "auto_qft" / "formcalc"), real_formcalc)
        (out_dir / "auto_qft" / "formcalc").symlink_to(real_formcalc, target_is_directory=True)
    proc = subprocess.run(
        auto_qft_validator_command(paths["job"], out_dir),
        check=False,
    )
    assert proc.returncode != 0


@pytest.mark.parametrize(
    "phase",
    ["producer_job_read", "snapshot_publish", "snapshot_read", "after_reduction", "before_pass"],
)
def test_secure_read_pins_file_object_across_replace_restore(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    phase: str,
) -> None:
    spec = importlib.util.spec_from_file_location(f"validator_{phase}", VALIDATOR)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    target = tmp_path / f"{phase}.m"
    target.write_bytes(b"producer-bound-bytes\n")
    expected = target.read_bytes()
    attacker = tmp_path / f"{phase}.attacker"
    attacker.write_bytes(b"replacement-bytes\n")
    saved = tmp_path / f"{phase}.saved"
    real_open = module.os.open
    replaced = False

    def hooked_open(path: object, flags: int, *args: object, **kwargs: object) -> int:
        nonlocal replaced
        fd = real_open(path, flags, *args, **kwargs)
        if path == target.name and not replaced:
            replaced = True
            os.replace(target, saved)
            os.replace(attacker, target)
            os.replace(saved, target)
        return fd

    monkeypatch.setattr(module.os, "open", hooked_open)
    data, witness, error = module.read_bytes_secure(target)
    assert error is None
    assert data == expected
    assert witness["sha256"] == hashlib.sha256(expected).hexdigest()


def test_formcalc_reducer_reads_only_atomic_snapshot_without_wolfram() -> None:
    reducer_source = (
        SKILL_ROOT / "scripts" / "mma" / "run_formcalc_reducer.wls"
    ).read_text(encoding="utf-8")
    runner_source = RUNNER.read_text(encoding="utf-8")
    validator_source = VALIDATOR.read_text(encoding="utf-8")

    assert '"--stage", "publish_snapshot"' in reducer_source
    assert "HepCalcDecodeSecureBytes[snapshotPayloadForReduction]" in reducer_source
    assert "ToExpression[snapshotText, InputForm, HoldComplete]" in reducer_source
    assert "Get[$HepCalcInputSnapshotPath]" not in reducer_source
    assert "Get[$HepCalcAmpsRawPath]" not in reducer_source
    for phase in (
        "after_snapshot_publish",
        "after_snapshot_read",
        "after_reduction",
        "before_pass_publish",
    ):
        assert f'HepCalcVerifyInputChain["{phase}"]' in reducer_source
    assert '"auto_qft/formcalc/input_snapshot.m"' in validator_source
    assert '"auto_qft/formcalc/.input_snapshot.m.tmp"' in validator_source


def test_auto_qft_producer_binds_secure_job_bytes_without_wolfram() -> None:
    producer_source = (SKILL_ROOT / "scripts" / "mma" / "run_auto_qft.wls").read_text(
        encoding="utf-8"
    )
    runner_source = RUNNER.read_text(encoding="utf-8")
    assert "If[Length[args] < 4" in producer_source
    assert "jobPayload = HepCalcSecureRead[jobPath]" in producer_source
    assert 'Lookup[jobPayload, "bytes", Null] =!= $HepCalcJobBytes' in producer_source
    assert 'Lookup[jobPayload, "sha256", Null] =!= $HepCalcJobSHA' in producer_source
    assert "job = Quiet@Check[ImportString[jobText, \"RawJSON\"], $Failed]" in producer_source
    assert 'Import[jobPath, "RawJSON"]' not in producer_source
    assert 'HEP_CALC_POSTCONDITION_VALIDATOR="${POSTCONDITION_VALIDATOR}" wolframscript' in runner_source
    assert '"${auto_qft_job_bytes}" "${auto_qft_job_sha256}" "${POSTCONDITION_VALIDATOR}"' not in runner_source
    assert '$HepCalcValidatorPath = Environment["HEP_CALC_POSTCONDITION_VALIDATOR"]' in producer_source


def test_auto_qft_export_does_not_treat_nonfatal_messages_as_failure_without_wolfram() -> None:
    producer_source = (SKILL_ROOT / "scripts" / "mma" / "run_auto_qft.wls").read_text(
        encoding="utf-8"
    )

    assert "writeFeynArtsResult = Quiet@CheckAbort[" in producer_source
    assert "writeFeynArtsResult === $Aborted || writeFeynArtsResult === $Failed" in producer_source
    prepare_call = 'HepCalcFeynArtsModelStage["prepare_feynarts_model", modelName]'
    verify_call = 'HepCalcFeynArtsModelStage["verify_feynarts_model", modelName]'
    export_call = "FeynRules`WriteFeynArtsOutput["
    assert prepare_call in producer_source
    assert verify_call in producer_source
    assert producer_source.index(prepare_call) < producer_source.index(export_call)
    assert producer_source.index(export_call) < producer_source.index(verify_call)
    assert "Quiet@Check[\n    FeynRules`WriteFeynArtsOutput" not in producer_source


def test_feynarts_model_stale_files_cannot_pass_a_no_write_export(tmp_path: Path) -> None:
    out_dir = tmp_path / "out"
    model_dir = out_dir / "auto_qft" / "feynarts_model"
    model_dir.mkdir(parents=True)
    model_name = "hep_calc_auto_model"
    model_paths = [model_dir / f"{model_name}{suffix}" for suffix in (".mod", ".gen", ".pars")]
    for path in model_paths:
        path.write_text("stale-model\n", encoding="utf-8")

    prepare = subprocess.run(
        [
            "python3",
            str(VALIDATOR),
            "--stage",
            "prepare_feynarts_model",
            "--out",
            str(out_dir),
            "--model-name",
            model_name,
        ],
        check=False,
        capture_output=True,
        text=True,
    )
    assert prepare.returncode == 0, prepare.stdout + prepare.stderr
    assert json.loads(prepare.stdout)["removed"] == 3
    assert all(not path.exists() for path in model_paths)

    no_write_verify = subprocess.run(
        [
            "python3",
            str(VALIDATOR),
            "--stage",
            "verify_feynarts_model",
            "--out",
            str(out_dir),
            "--model-name",
            model_name,
        ],
        check=False,
        capture_output=True,
        text=True,
    )
    assert no_write_verify.returncode != 0
    assert json.loads(no_write_verify.stdout)["reason"] == "feynarts_model_files_invalid"

    for path in model_paths:
        path.write_text(f"fresh:{path.suffix}\n", encoding="utf-8")
    fresh_verify = subprocess.run(
        [
            "python3",
            str(VALIDATOR),
            "--stage",
            "verify_feynarts_model",
            "--out",
            str(out_dir),
            "--model-name",
            model_name,
        ],
        check=False,
        capture_output=True,
        text=True,
    )
    assert fresh_verify.returncode == 0, fresh_verify.stdout + fresh_verify.stderr
    assert len(json.loads(fresh_verify.stdout)["files"]) == 3


def test_git_info_binds_tracked_changes_and_untracked_source_bytes(tmp_path: Path) -> None:
    spec = importlib.util.spec_from_file_location("hep_calc_generate_report", GENERATE_REPORT)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)

    repo = tmp_path / "repo"
    repo.mkdir()
    subprocess.run(["git", "init", "-q"], cwd=repo, check=True)
    subprocess.run(["git", "config", "user.name", "Test User"], cwd=repo, check=True)
    subprocess.run(["git", "config", "user.email", "test@example.invalid"], cwd=repo, check=True)
    tracked = repo / "tracked.py"
    tracked.write_text("original\n", encoding="utf-8")
    subprocess.run(["git", "add", "tracked.py"], cwd=repo, check=True)
    subprocess.run(
        ["git", "-c", "commit.gpgsign=false", "commit", "-q", "-m", "seed"],
        cwd=repo,
        check=True,
    )
    tracked.write_text("modified\n", encoding="utf-8")
    untracked = repo / "untracked.py"
    untracked.write_text("new-source\n", encoding="utf-8")

    report_dir = tmp_path / "out" / "report"
    info = module.git_info(str(repo), report_dir)
    manifest_path = report_dir / "source_tree_manifest.json"
    manifest = load_json(manifest_path)
    entries = {entry["path"]: entry for entry in manifest["entries"]}

    assert info["dirty"] is True
    assert info["source_manifest_path"] == "report/source_tree_manifest.json"
    assert info["source_manifest_sha256"] == hashlib.sha256(manifest_path.read_bytes()).hexdigest()
    assert entries["tracked.py"]["state"] == "tracked_changed"
    assert entries["tracked.py"]["sha256"] == hashlib.sha256(tracked.read_bytes()).hexdigest()
    assert entries["untracked.py"]["state"] == "untracked"
    assert entries["untracked.py"]["sha256"] == hashlib.sha256(untracked.read_bytes()).hexdigest()


def test_fresh_formcalc_reducer_load_abort_is_nonzero_and_fail_closed(tmp_path: Path) -> None:
    real_wolframscript = require_full_toolchain()
    reducer = SKILL_ROOT / "scripts" / "mma" / "run_formcalc_reducer.wls"
    out_dir = tmp_path / "negative-load-abort"
    job_path = out_dir / "job.resolved.json"
    raw_path = out_dir / "auto_qft" / "amplitude" / "amps_raw.m"
    raw_path.parent.mkdir(parents=True)
    raw_path.write_text("FeynAmpList[]\n", encoding="utf-8")
    witness = file_witness(raw_path)
    token = "negative-load-abort-token"
    write_json(
        job_path,
        {
            "auto_qft": {
                "enable": True,
                "formcalc": {
                    "enable": True,
                    "pave_reduce": "LoopTools",
                    "memory_limit_mb": 2048,
                },
                "export": {"amplitude_md": False, "amplitude_tex": False},
            }
        },
    )
    write_json(
        out_dir / "auto_qft" / "producer_status.json",
        {
            "stage": "auto_qft_feynarts_producer",
            "status": "PASS",
            "started_at": "seeded",
            "token": token,
            "handoff": "auto_qft/formcalc/handoff.json",
            "amplitude": {
                "path": "auto_qft/amplitude/amps_raw.m",
                "amp_count": 1,
                **witness,
            },
        },
    )
    write_json(
        out_dir / "auto_qft" / "formcalc" / "handoff.json",
        {
            "stage": "auto_qft_formcalc_handoff",
            "status": "PASS",
            "token": token,
            "raw_path": "auto_qft/amplitude/amps_raw.m",
            "raw_bytes": witness["bytes"],
            "raw_sha256": witness["sha256"],
            "amp_count": 1,
            "pave_reduce": "LoopTools",
            "memory_limit_mb": 2048,
        },
    )
    write_json(
        out_dir / "auto_qft" / "summary.json",
        {
            "status": "NOT_RUN",
            "options": {"formcalc": {"enable": True, "status": "NOT_RUN"}},
        },
    )

    shadow_dir = tmp_path / "shadow-package"
    shadow_dir.mkdir()
    (shadow_dir / "FormCalc.m").write_text(
        'BeginPackage["FormCalc`"]\nPrint["seeded_formcalc_abort"]\nAbort[]\n',
        encoding="utf-8",
    )
    reducer_code = (
        f"PrependTo[$Path,{json.dumps(str(shadow_dir))}];"
        "Unprotect[$ScriptCommandLine];$ScriptCommandLine={"
        f"{json.dumps(str(reducer))},{json.dumps(str(job_path))},{json.dumps(str(out_dir))},"
        f"{json.dumps(str(file_witness(job_path)['bytes']))},{json.dumps(file_witness(job_path)['sha256'])}"
        "};Protect[$ScriptCommandLine];"
        f"Get[{json.dumps(str(reducer))}]"
    )
    proc = subprocess.run(
        [str(real_wolframscript), "-noprompt", "-code", reducer_code],
        cwd=shadow_dir,
        check=False,
        capture_output=True,
        text=True,
        timeout=180,
        env={**os.environ, "HEP_CALC_POSTCONDITION_VALIDATOR": str(VALIDATOR)},
    )

    formcalc_status = load_json(out_dir / "auto_qft" / "formcalc" / "status.json")
    top_status = load_json(out_dir / "auto_qft" / "status.json")
    combined = proc.stdout + proc.stderr
    assert proc.returncode != 0
    assert formcalc_status["status"] == "ERROR"
    assert formcalc_status["reason"] == "formcalc_load_aborted"
    assert top_status["status"] == "ERROR"
    assert "phase=formcalc_load begin" in combined
    assert "seeded_formcalc_abort" in combined
    assert not (out_dir / "auto_qft" / "amplitude" / "amplitude_summed.m").exists()


@pytest.mark.parametrize(
    ("entry_source", "expected_reason", "preseed_symbolic"),
    [
        ("$Aborted\n", "entry_execution_aborted", False),
        ("1 + 1\n", "missing_required_symbolic_output", False),
        ("1 + 1\n", "missing_required_symbolic_output", True),
    ],
)
def test_symbolic_missing_required_output_is_nonzero_and_fail_closed(
    tmp_path: Path,
    entry_source: str,
    expected_reason: str,
    preseed_symbolic: bool,
) -> None:
    real_wolframscript = require_full_toolchain()
    runner = SKILL_ROOT / "scripts" / "mma" / "run_job.wls"
    entry = tmp_path / "missing-output.wls"
    entry.write_text(entry_source, encoding="utf-8")
    job_path = tmp_path / "job.resolved.json"
    write_json(job_path, {"mathematica": {"entry": str(entry)}})
    out_dir = tmp_path / "out"
    if preseed_symbolic:
        write_json(
            out_dir / "symbolic" / "symbolic.json",
            {"schema_version": 1, "data": {"tasks": [], "assertions": []}},
        )
        write_json(
            out_dir / "symbolic" / "status.json",
            {"stage": "mathematica_symbolic", "status": "PASS"},
        )

    proc = subprocess.run(
        [
            str(real_wolframscript),
            "-noprompt",
            "-file",
            str(runner),
            "--",
            str(job_path),
            str(out_dir),
        ],
        cwd=SKILL_ROOT,
        check=False,
        capture_output=True,
        text=True,
        timeout=180,
    )

    status = load_json(out_dir / "symbolic" / "status.json")
    assert proc.returncode != 0
    assert status["status"] == "ERROR"
    assert status["reason"] == expected_reason
    assert (out_dir / "symbolic" / "symbolic.json").exists()
