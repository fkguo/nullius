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


def _run_cli(repo_root: Path, args: list[str]) -> tuple[int, str, str]:
    env = dict(os.environ)
    src = str(_src_root())
    prev = env.get("PYTHONPATH", "").strip()
    env["PYTHONPATH"] = src + (os.pathsep + prev if prev else "")
    cp = subprocess.run(
        [sys.executable, "-m", "hep_autoresearch.orchestrator_cli", "--project-root", str(repo_root), *args],
        cwd=str(repo_root),
        env=env,
        capture_output=True,
        text=True,
        check=False,
    )
    return int(cp.returncode), str(cp.stdout), str(cp.stderr)


class TestMethodDesignCLI(unittest.TestCase):
    def test_method_design_minimal_ok_generates_runnable_project(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            repo_root = Path(td)

            # Init is required to run W_compute through hepar (approval policy, runtime dirs).
            rc, out, err = _run_cli(repo_root, ["init"])
            self.assertEqual(rc, 0, msg=out + err)

            # Disable A3 compute approval for this integration-style test.
            policy_path = repo_root / ".autopilot" / "approval_policy.json"
            policy = json.loads(policy_path.read_text(encoding="utf-8"))
            policy.setdefault("require_approval_for", {})["compute_runs"] = False
            policy_path.write_text(json.dumps(policy, indent=2, sort_keys=True) + "\n", encoding="utf-8")

            tag = "M75-c2-minimal-test"
            rc, out, err = _run_cli(
                repo_root,
                [
                    "method-design",
                    "--tag",
                    tag,
                    "--template",
                    "minimal_ok",
                    "--project-id",
                    "demo_minimal",
                ],
            )
            self.assertEqual(rc, 0, msg=out + err)
            self.assertIn("method-design", out)

            out_dir = repo_root / "artifacts" / "runs" / tag / "method_design"
            self.assertTrue((out_dir / "manifest.json").exists())
            self.assertTrue((out_dir / "summary.json").exists())
            self.assertTrue((out_dir / "analysis.json").exists())

            proj_dir = out_dir / "project"
            run_card_path = proj_dir / "run_cards" / "main.json"
            self.assertTrue(run_card_path.exists())

            # Validate the generated run-card.
            rc, out, err = _run_cli(repo_root, ["run-card", "validate", "--run-card", str(run_card_path)])
            self.assertEqual(rc, 0, msg=out + err)

            # Run the generated W_compute project.
            rc, out, err = _run_cli(
                repo_root,
                [
                    "run",
                    "--run-id",
                    tag,
                    "--workflow-id",
                    "W_compute",
                    "--run-card",
                    str(run_card_path),
                    "--trust-project",
                ],
            )
            self.assertEqual(rc, 0, msg=out + err)

            w_out = repo_root / "artifacts" / "runs" / tag / "w_compute"
            analysis = json.loads((w_out / "analysis.json").read_text(encoding="utf-8"))
            self.assertEqual(((analysis.get("results") or {}).get("status")), "completed")
            self.assertTrue((w_out / "phases" / "write_ok" / "results" / "ok.json").exists())

    def test_method_design_spec_v1_materializes_project(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            repo_root = Path(td)

            rc, out, err = _run_cli(repo_root, ["init"])
            self.assertEqual(rc, 0, msg=out + err)

            # Disable A3 compute approval for this integration-style test.
            policy_path = repo_root / ".autopilot" / "approval_policy.json"
            policy = json.loads(policy_path.read_text(encoding="utf-8"))
            policy.setdefault("require_approval_for", {})["compute_runs"] = False
            policy_path.write_text(json.dumps(policy, indent=2, sort_keys=True) + "\n", encoding="utf-8")

            spec = {
                "schema_version": 1,
                "project": {
                    "project_id": "demo_spec",
                    "title": "spec_v1 demo",
                    "description": "materialized from a method_spec bundle",
                    "required_references": [],
                    "eval_cases": [],
                },
                "run_card_path": "run_cards/main.json",
                "files": [
                    {
                        "path": "scripts/write_ok.py",
                        "content": (
                            "from __future__ import annotations\n"
                            "\n"
                            "import json\n"
                            "from pathlib import Path\n"
                            "\n"
                            "Path('results').mkdir(parents=True, exist_ok=True)\n"
                            "Path('results/ok.json').write_text(json.dumps({'ok': True}) + '\\n', encoding='utf-8')\n"
                        ),
                    }
                ],
                "run_card": {
                    "schema_version": 2,
                    "run_id": "IGNORED",
                    "workflow_id": "W_compute",
                    "title": "spec_v1 run",
                    "phases": [
                        {
                            "phase_id": "p1",
                            "backend": {"kind": "shell", "argv": ["python3", "scripts/write_ok.py"], "cwd": ".", "timeout_seconds": 30},
                            "outputs": ["results/ok.json"],
                        }
                    ],
                },
            }

            spec_path = repo_root / "spec.json"
            spec_path.write_text(json.dumps(spec, indent=2) + "\n", encoding="utf-8")

            tag = "M77-c2-spec-v1"
            rc, out, err = _run_cli(
                repo_root,
                [
                    "method-design",
                    "--tag",
                    tag,
                    "--template",
                    "spec_v1",
                    "--spec",
                    str(spec_path),
                    "--project-id",
                    "demo_spec",
                ],
            )
            self.assertEqual(rc, 0, msg=out + err)

            proj_dir = repo_root / "artifacts" / "runs" / tag / "method_design" / "project"
            run_card_path = proj_dir / "run_cards" / "main.json"
            self.assertTrue(run_card_path.exists())

            rc, out, err = _run_cli(repo_root, ["run-card", "validate", "--run-card", str(run_card_path)])
            self.assertEqual(rc, 0, msg=out + err)

            rc, out, err = _run_cli(
                repo_root,
                [
                    "run",
                    "--run-id",
                    tag,
                    "--workflow-id",
                    "W_compute",
                    "--run-card",
                    str(run_card_path),
                    "--trust-project",
                ],
            )
            self.assertEqual(rc, 0, msg=out + err)
            w_out = repo_root / "artifacts" / "runs" / tag / "w_compute"
            self.assertTrue((w_out / "phases" / "p1" / "results" / "ok.json").exists())

    def test_method_design_pdg_snapshot_requires_mcp_config(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            repo_root = Path(td)
            tag = "M75-c2-pdg-missing"
            rc, out, err = _run_cli(
                repo_root,
                [
                    "method-design",
                    "--tag",
                    tag,
                    "--template",
                    "pdg_snapshot",
                    "--project-id",
                    "demo_pdg",
                    "--pdg-particle-name",
                    "pi0",
                    "--pdg-property",
                    "mass",
                ],
            )
            # The command is best-effort: it should return rc=2 and still write artifacts.
            self.assertEqual(rc, 2, msg=out + err)
            out_dir = repo_root / "artifacts" / "runs" / tag / "method_design"
            self.assertTrue((out_dir / "analysis.json").exists())

    def test_method_design_pdg_snapshot_with_stub_mcp(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            repo_root = Path(td)

            # Init so we can also run W_compute afterwards.
            rc, out, err = _run_cli(repo_root, ["init"])
            self.assertEqual(rc, 0, msg=out + err)

            # Disable A3 compute approval for this integration-style test.
            policy_path = repo_root / ".autopilot" / "approval_policy.json"
            policy = json.loads(policy_path.read_text(encoding="utf-8"))
            policy.setdefault("require_approval_for", {})["compute_runs"] = False
            policy_path.write_text(json.dumps(policy, indent=2, sort_keys=True) + "\n", encoding="utf-8")

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

            tag = "M75-c2-pdg-stub"
            rc, out, err = _run_cli(
                repo_root,
                [
                    "method-design",
                    "--tag",
                    tag,
                    "--template",
                    "pdg_snapshot",
                    "--project-id",
                    "demo_pdg",
                    "--pdg-particle-name",
                    "pi0",
                    "--pdg-property",
                    "mass",
                ],
            )
            self.assertEqual(rc, 0, msg=out + err)

            proj_dir = repo_root / "artifacts" / "runs" / tag / "method_design" / "project"
            snapshot_path = proj_dir / "inputs" / "pdg_snapshot.json"
            self.assertTrue(snapshot_path.exists())
            snap = json.loads(snapshot_path.read_text(encoding="utf-8"))
            self.assertEqual(((snap.get("query") or {}).get("particle_name")), "pi0")
            self.assertEqual(((snap.get("query") or {}).get("property")), "mass")

            run_card_path = proj_dir / "run_cards" / "main.json"
            rc, out, err = _run_cli(repo_root, ["run-card", "validate", "--run-card", str(run_card_path)])
            self.assertEqual(rc, 0, msg=out + err)

            rc, out, err = _run_cli(
                repo_root,
                [
                    "run",
                    "--run-id",
                    tag,
                    "--workflow-id",
                    "W_compute",
                    "--run-card",
                    str(run_card_path),
                    "--trust-project",
                ],
            )
            self.assertEqual(rc, 0, msg=out + err)
            w_out = repo_root / "artifacts" / "runs" / tag / "w_compute"
            self.assertTrue((w_out / "phases" / "emit_snapshot" / "results" / "pdg_snapshot.json").exists())

    def test_method_design_pdg_runtime_with_stub_mcp(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            repo_root = Path(td)

            # Init so we can also run W_compute afterwards.
            rc, out, err = _run_cli(repo_root, ["init"])
            self.assertEqual(rc, 0, msg=out + err)

            # Disable A3 compute approval for this integration-style test.
            policy_path = repo_root / ".autopilot" / "approval_policy.json"
            policy = json.loads(policy_path.read_text(encoding="utf-8"))
            policy.setdefault("require_approval_for", {})["compute_runs"] = False
            policy_path.write_text(json.dumps(policy, indent=2, sort_keys=True) + "\n", encoding="utf-8")

            tag = "M82-c2-pdg-runtime-stub"
            rc, out, err = _run_cli(
                repo_root,
                [
                    "method-design",
                    "--tag",
                    tag,
                    "--template",
                    "pdg_runtime",
                    "--project-id",
                    "demo_pdg_runtime",
                    "--pdg-particle-name",
                    "pi0",
                    "--pdg-property",
                    "mass",
                ],
            )
            self.assertEqual(rc, 0, msg=out + err)

            proj_dir = repo_root / "artifacts" / "runs" / tag / "method_design" / "project"
            run_card_path = proj_dir / "run_cards" / "main.json"
            self.assertTrue(run_card_path.exists())

            # Provide a local MCP config inside the generated project (runtime dependency).
            mcp_cfg = {
                "mcpServers": {
                    "hep-research": {
                        "command": sys.executable,
                        "args": ["-u", str(_stub_server_path())],
                        "env": {},
                    }
                }
            }
            (proj_dir / ".mcp.json").write_text(json.dumps(mcp_cfg, indent=2) + "\n", encoding="utf-8")

            rc, out, err = _run_cli(repo_root, ["run-card", "validate", "--run-card", str(run_card_path)])
            self.assertEqual(rc, 0, msg=out + err)

            rc, out, err = _run_cli(
                repo_root,
                [
                    "run",
                    "--run-id",
                    tag,
                    "--workflow-id",
                    "W_compute",
                    "--run-card",
                    str(run_card_path),
                    "--trust-project",
                ],
            )
            self.assertEqual(rc, 0, msg=out + err)

            out_path = repo_root / "artifacts" / "runs" / tag / "w_compute" / "phases" / "query_pdg" / "results" / "pdg_property.json"
            self.assertTrue(out_path.exists())
            payload = json.loads(out_path.read_text(encoding="utf-8"))
            self.assertEqual(payload.get("schema_version"), 1)
            self.assertEqual(((payload.get("query") or {}).get("particle_name")), "pi0")
            self.assertEqual(((payload.get("query") or {}).get("property")), "mass")
            self.assertEqual(((payload.get("result") or {}).get("ok")), True)
            raw = (payload.get("result") or {}).get("raw") or {}
            self.assertAlmostEqual(float(raw.get("value") or 0.0), 0.1349768, places=7)
