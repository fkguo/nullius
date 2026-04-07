import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


def _src_root() -> Path:
    return Path(__file__).resolve().parents[1] / "src"


def _stub_server_path() -> Path:
    return Path(__file__).resolve().parent / "mcp_stub_server.py"


def _run_cli(repo_root: Path, args: list[str], *, env_overrides: dict[str, str] | None = None) -> tuple[int, str, str]:
    env = dict(os.environ)
    src = str(_src_root())
    prev = env.get("PYTHONPATH", "").strip()
    env["PYTHONPATH"] = src + (os.pathsep + prev if prev else "")
    if isinstance(env_overrides, dict):
        for k, v in env_overrides.items():
            env[str(k)] = str(v)
    cp = subprocess.run(
        [sys.executable, "-m", "hep_autoresearch.orchestrator_cli", "--project-root", str(repo_root), *args],
        cwd=str(repo_root),
        env=env,
        capture_output=True,
        text=True,
        check=False,
    )
    return int(cp.returncode), str(cp.stdout), str(cp.stderr)


class TestMcpDoctorAndBridgeCLI(unittest.TestCase):
    def test_doctor_missing_config(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            repo_root = Path(td)
            rc, out, err = _run_cli(repo_root, ["doctor"])
            self.assertNotEqual(rc, 0)
            self.assertIn("missing MCP config", out + err)

    def test_doctor_allow_missing_config(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            repo_root = Path(td)
            rc, out, err = _run_cli(repo_root, ["doctor", "--allow-missing-mcp-config"])
            self.assertEqual(rc, 0, msg=out + err)
            self.assertIn("missing MCP config", out + err)

    def test_doctor_entrypoints_only_skips_mcp(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            repo_root = Path(td)
            rc, out, err = _run_cli(repo_root, ["doctor", "--entrypoints-only"])
            self.assertEqual(rc, 0, msg=out + err)
            self.assertIn("entrypoint_discovery", out + err)
            self.assertNotIn("missing MCP config", out + err)

    def test_init_scaffolds_mcp_example(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            repo_root = Path(td)
            rc, out, err = _run_cli(repo_root, ["init"])
            self.assertEqual(rc, 0, msg=out + err)
            ex = repo_root / ".mcp.json.example"
            self.assertTrue(ex.exists(), msg="init should scaffold .mcp.json.example")
            payload = json.loads(ex.read_text(encoding="utf-8"))
            self.assertIsInstance(payload, dict)
            self.assertIn("mcpServers", payload)
            servers = payload.get("mcpServers")
            self.assertEqual(sorted((servers or {}).keys()), ["example-provider"])
            rendered = json.dumps(payload, sort_keys=True)
            self.assertNotIn("hep-research", rendered)
            self.assertNotIn("HEP_DATA_DIR", rendered)

    def test_doctor_entrypoint_discovery_warning_non_strict(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            repo_root = Path(td)
            rc, out, err = _run_cli(repo_root, ["doctor", "--json"], env_overrides={"PATH": "/usr/bin:/bin"})
            self.assertEqual(rc, 0, msg=out + err)
            payload = json.loads(out)
            self.assertIn("entrypoint_discovery", payload)
            warnings = payload.get("warnings") if isinstance(payload.get("warnings"), list) else []
            self.assertTrue(any((isinstance(w, dict) and w.get("code") == "entrypoints_missing") for w in warnings))

    def test_doctor_entrypoint_discovery_strict_nonzero(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            repo_root = Path(td)
            rc, out, err = _run_cli(
                repo_root,
                ["doctor", "--json", "--strict-entrypoints"],
                env_overrides={"PATH": "/usr/bin:/bin"},
            )
            self.assertEqual(rc, 2, msg=out + err)
            payload = json.loads(out)
            self.assertFalse(bool(payload.get("ok")))

    def test_doctor_rejects_unsupported_protocol_version(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            repo_root = Path(td)

            mcp_cfg = {
                "mcpServers": {
                    "hep-research": {
                        "command": sys.executable,
                        "args": ["-u", str(_stub_server_path())],
                        "env": {"MCP_STUB_FORCE_PROTOCOL_VERSION": "2099-01-01"},
                    }
                }
            }
            (repo_root / ".mcp.json").write_text(json.dumps(mcp_cfg, indent=2) + "\n", encoding="utf-8")

            rc, out, err = _run_cli(repo_root, ["doctor"])
            self.assertNotEqual(rc, 0)
            self.assertIn("unsupported protocol version", (out + err).lower())

    def test_doctor_and_bridge_with_stub_mcp(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            repo_root = Path(td)

            # Minimal init scaffold for computation run.
            self.assertEqual(_run_cli(repo_root, ["init"])[0], 0)

            # Disable A3 compute approval for this test.
            policy_path = repo_root / ".autoresearch" / "approval_policy.json"
            policy = json.loads(policy_path.read_text(encoding="utf-8"))
            policy.setdefault("require_approval_for", {})["compute_runs"] = False
            policy_path.write_text(json.dumps(policy, indent=2, sort_keys=True) + "\n", encoding="utf-8")

            # Create stub MCP config under the test project root.
            mcp_cfg = {
                "mcpServers": {
                    "hep-research": {
                        "command": sys.executable,
                        "args": ["-u", str(_stub_server_path())],
                        "env": {},
                    }
                }
            }
            (repo_root / ".mcp.json").write_text(json.dumps(mcp_cfg, indent=2) + "\n", encoding="utf-8")

            # Doctor should pass.
            rc, out, err = _run_cli(repo_root, ["doctor"])
            self.assertEqual(rc, 0, msg=out)

            # Minimal computation project + run_card v2.
            proj = repo_root / "proj"
            (proj / "run_cards").mkdir(parents=True, exist_ok=True)
            (proj / "scripts").mkdir(parents=True, exist_ok=True)
            (proj / "results").mkdir(parents=True, exist_ok=True)

            script = proj / "scripts" / "write_ok.py"
            script.write_text(
                "from __future__ import annotations\n"
                "import json\n"
                "from pathlib import Path\n"
                "Path('results').mkdir(parents=True, exist_ok=True)\n"
                "Path('results/value.json').write_text(json.dumps({'value': 1.0}) + '\\n', encoding='utf-8')\n",
                encoding="utf-8",
            )

            run_card = {
                "schema_version": 2,
                "run_id": "IGNORED",
                "workflow_id": "computation",
                "title": "mcp bridge test",
                "phases": [
                    {
                        "phase_id": "p1",
                        "backend": {"kind": "shell", "argv": [sys.executable, "scripts/write_ok.py"], "cwd": "."},
                        "outputs": ["results/value.json"],
                    }
                ],
                "headline_numbers": {
                    "source": "phases/p1/results/value.json",
                    "extract": [
                        {
                            "pointer": "#/value",
                            "label": "value",
                            "tier": "T2",
                        }
                    ],
                },
                "acceptance": {
                    "json_numeric_checks": [
                        {
                            "path": "phases/p1/results/value.json",
                            "pointer": "#/value",
                            "min": 0.5,
                            "max": 1.5,
                        }
                    ]
                },
            }
            run_card_path = proj / "run_cards" / "basic.json"
            run_card_path.write_text(json.dumps(run_card, indent=2) + "\n", encoding="utf-8")

            run_id = "M1-test-bridge"
            rc, _, _ = _run_cli(
                repo_root,
                ["run", "--run-id", run_id, "--workflow-id", "computation", "--run-card", str(run_card_path), "--trust-project"],
            )
            self.assertEqual(rc, 0)

            # Bridge should pass and write bridge artifacts.
            rc, _, _ = _run_cli(repo_root, ["bridge", "--run-id", run_id])
            self.assertEqual(rc, 0)

            bridge_dir = repo_root / "artifacts" / "runs" / run_id / "bridge_mcp"
            self.assertTrue((bridge_dir / "bridge_report.json").exists())
            self.assertTrue((bridge_dir / "bridge_state.json").exists())
            report = json.loads((bridge_dir / "bridge_report.json").read_text(encoding="utf-8"))
            self.assertEqual(report.get("bridge_status"), "success")
            gate = report.get("outcome_gate") or {}
            self.assertEqual(sorted(gate.get("required_failed") or []), [])
            self.assertIn("run_registered", set(gate.get("required_passed") or []))

            state = json.loads((bridge_dir / "bridge_state.json").read_text(encoding="utf-8"))
            self.assertEqual(state.get("status"), "success")
