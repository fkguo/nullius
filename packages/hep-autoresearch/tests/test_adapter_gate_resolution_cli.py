import json
import tempfile
import unittest
from pathlib import Path


def _src_root() -> Path:
    return Path(__file__).resolve().parents[1] / "src"


class TestAdapterGateResolutionMode(unittest.TestCase):
    def _run_cli(self, argv: list[str]) -> tuple[int, str, str]:
        import sys
        from contextlib import redirect_stderr, redirect_stdout
        from io import StringIO

        src_root = str(_src_root())
        added_path = False
        if src_root not in sys.path:
            sys.path.insert(0, src_root)
            added_path = True

        from hep_autoresearch.orchestrator_cli import main as cli_main

        argv0 = list(sys.argv)
        try:
            sys.argv = list(argv)
            buf_out, buf_err = StringIO(), StringIO()
            with redirect_stdout(buf_out), redirect_stderr(buf_err):
                rc = int(cli_main())
            return rc, buf_out.getvalue(), buf_err.getvalue()
        finally:
            sys.argv = argv0
            if added_path:
                try:
                    sys.path.remove(src_root)
                except ValueError:
                    pass

    def _init_and_policy(self, repo_root: Path) -> None:
        rc, out, err = self._run_cli(["hepar", "--project-root", str(repo_root), "init"])
        self.assertEqual(rc, 0, msg=out + err)
        policy_path = repo_root / ".autoresearch" / "approval_policy.json"
        policy = json.loads(policy_path.read_text(encoding="utf-8"))
        policy.setdefault("require_approval_for", {})["compute_runs"] = True
        policy_path.write_text(json.dumps(policy, indent=2, sort_keys=True) + "\n", encoding="utf-8")

    def _card(self, *, mode: str, gates: list[str]) -> dict:
        import sys

        return {
            "schema_version": 1,
            "run_id": "IGNORED",
            "workflow_id": "ADAPTER_shell_smoke",
            "adapter_id": "shell",
            "artifact_step": "adapter_shell_smoke",
            "required_gates": list(gates),
            "gate_resolution_mode": mode,
            "budgets": {"timeout_seconds": 30},
            "prompt": {"system": "", "user": "smoke"},
            "tools": [],
            "evidence_bundle": {},
            "backend": {
                "kind": "shell",
                "argv": [sys.executable, "-c", "print('ok')"],
                "cwd": ".",
                "env": {},
            },
        }

    def _pending_category(self, repo_root: Path) -> str | None:
        state = json.loads((repo_root / ".autoresearch" / "state.json").read_text(encoding="utf-8"))
        pending = state.get("pending_approval") if isinstance(state.get("pending_approval"), dict) else None
        return str((pending or {}).get("category")) if pending else None

    def _packet_path(self, repo_root: Path) -> Path | None:
        state = json.loads((repo_root / ".autoresearch" / "state.json").read_text(encoding="utf-8"))
        pending = state.get("pending_approval") if isinstance(state.get("pending_approval"), dict) else None
        packet_rel = (pending or {}).get("packet_path") if pending else None
        if not isinstance(packet_rel, str):
            return None
        return repo_root / packet_rel

    def test_union_mode_enforces_policy_floor_and_trace(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            repo_root = Path(td)
            self._init_and_policy(repo_root)
            card = self._card(mode="union", gates=[])
            card_path = repo_root / "card_union.json"
            card_path.write_text(json.dumps(card, indent=2) + "\n", encoding="utf-8")

            rc, out, err = self._run_cli(
                [
                    "hepar",
                    "--project-root",
                    str(repo_root),
                    "run",
                    "--run-id",
                    "R-UNION",
                    "--workflow-id",
                    "ADAPTER_shell_smoke",
                    "--run-card",
                    str(card_path),
                ]
            )
            self.assertEqual(rc, 3, msg=out + err)
            self.assertEqual(self._pending_category(repo_root), "A3")
            packet_path = self._packet_path(repo_root)
            self.assertIsNotNone(packet_path)
            packet = (packet_path or Path()).read_text(encoding="utf-8")
            self.assertIn("Gate resolution trace", packet)
            self.assertIn("gate=A3", packet)

            manifest_path = repo_root / "artifacts" / "runs" / "R-UNION" / "adapter_shell_smoke" / "manifest.json"
            self.assertTrue(manifest_path.exists())
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            self.assertEqual(manifest.get("gate_resolution_mode"), "union")
            trace = manifest.get("gate_resolution_trace") or []
            self.assertTrue(any((isinstance(x, dict) and x.get("gate_id") == "A3") for x in trace))

    def test_policy_only_ignores_run_card_required_gates(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            repo_root = Path(td)
            self._init_and_policy(repo_root)
            card = self._card(mode="policy_only", gates=["A4"])
            card_path = repo_root / "card_policy_only.json"
            card_path.write_text(json.dumps(card, indent=2) + "\n", encoding="utf-8")

            rc, out, err = self._run_cli(
                [
                    "hepar",
                    "--project-root",
                    str(repo_root),
                    "run",
                    "--run-id",
                    "R-POLICY",
                    "--workflow-id",
                    "ADAPTER_shell_smoke",
                    "--run-card",
                    str(card_path),
                ]
            )
            self.assertEqual(rc, 3, msg=out + err)
            self.assertEqual(self._pending_category(repo_root), "A3")
            packet_path = self._packet_path(repo_root)
            self.assertIsNotNone(packet_path)
            packet = (packet_path or Path()).read_text(encoding="utf-8")
            self.assertNotIn("gate=A4", packet)
            self.assertIn("gate=A3", packet)

    def test_run_card_only_empty_warns_and_runs(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            repo_root = Path(td)
            self._init_and_policy(repo_root)
            card = self._card(mode="run_card_only", gates=[])
            card_path = repo_root / "card_run_card_only.json"
            card_path.write_text(json.dumps(card, indent=2) + "\n", encoding="utf-8")

            rc, out, err = self._run_cli(
                [
                    "hepar",
                    "--project-root",
                    str(repo_root),
                    "run",
                    "--run-id",
                    "R-RC",
                    "--workflow-id",
                    "ADAPTER_shell_smoke",
                    "--run-card",
                    str(card_path),
                ]
            )
            self.assertEqual(rc, 0, msg=out + err)
            self.assertIn("gate_resolution_policy_suppressed", err)

            manifest_path = repo_root / "artifacts" / "runs" / "R-RC" / "adapter_shell_smoke" / "manifest.json"
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            self.assertEqual(manifest.get("gate_resolution_mode"), "run_card_only")
            trace = manifest.get("gate_resolution_trace") or []
            self.assertTrue(any((isinstance(x, dict) and x.get("reason") and "suppressed" in str(x.get("reason"))) for x in trace))

    def test_run_card_only_empty_strict_errors(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            repo_root = Path(td)
            self._init_and_policy(repo_root)
            card = self._card(mode="run_card_only", gates=[])
            card_path = repo_root / "card_run_card_only_strict.json"
            card_path.write_text(json.dumps(card, indent=2) + "\n", encoding="utf-8")

            rc, out, err = self._run_cli(
                [
                    "hepar",
                    "--project-root",
                    str(repo_root),
                    "run",
                    "--run-id",
                    "R-RC-STRICT",
                    "--workflow-id",
                    "ADAPTER_shell_smoke",
                    "--run-card",
                    str(card_path),
                    "--strict-gate-resolution",
                ]
            )
            self.assertEqual(rc, 2, msg=out + err)
            state = json.loads((repo_root / ".autoresearch" / "state.json").read_text(encoding="utf-8"))
            self.assertEqual(state.get("run_status"), "failed")
            self.assertIn("run_card_only", str(state.get("notes") or ""))


if __name__ == "__main__":
    unittest.main()
