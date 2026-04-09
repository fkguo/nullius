import hashlib
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch


def _src_root() -> Path:
    return Path(__file__).resolve().parents[1] / "src"


def _write_stub_paper_reviser_skill(skills_root: Path) -> None:
    """
    Provide a minimal, offline stub for ~/.codex/skills/paper-reviser.

    The paper_reviser workflow shells out to:
    - paper-reviser/scripts/bin/paper_reviser_edit.py
    - paper-reviser/scripts/bin/build_verification_plan.py
    so the tests create local stubs and point --skills-dir to them.
    """
    skill_bin = skills_root / "paper-reviser" / "scripts" / "bin"
    skill_bin.mkdir(parents=True, exist_ok=True)

    edit_py = skill_bin / "paper_reviser_edit.py"
    edit_py.write_text(
        "import argparse\n"
        "import json\n"
        "from pathlib import Path\n"
        "\n"
        "\n"
        "def main() -> int:\n"
        "    p = argparse.ArgumentParser()\n"
        "    p.add_argument('--in', dest='in_path', required=True)\n"
        "    p.add_argument('--out-dir', required=True)\n"
        "    p.add_argument('--writer-backend', required=True)\n"
        "    p.add_argument('--writer-model', required=True)\n"
        "    p.add_argument('--auditor-backend', required=True)\n"
        "    p.add_argument('--auditor-model', required=True)\n"
        "    p.add_argument('--context-dir')\n"
        "    p.add_argument('--max-rounds', default='1')\n"
        "    p.add_argument('--stub-models', action='store_true')\n"
        "    p.add_argument('--dry-run', action='store_true')\n"
        "    p.add_argument('--run-models', action='store_true')\n"
        "    p.add_argument('--no-codex-verify', action='store_true')\n"
        "    p.add_argument('--min-clean-size-ratio', type=float)\n"
        "    p.add_argument('--codex-model')\n"
        "    p.add_argument('--codex-config', action='append', default=[])\n"
        "    p.add_argument('--fallback-auditor')\n"
        "    p.add_argument('--fallback-auditor-model')\n"
        "    p.add_argument('--secondary-deep-verify-backend')\n"
        "    p.add_argument('--secondary-deep-verify-model')\n"
        "    args = p.parse_args()\n"
        "\n"
        "    out_dir = Path(args.out_dir)\n"
        "    out_dir.mkdir(parents=True, exist_ok=True)\n"
        "    src = Path(args.in_path)\n"
        "    txt = src.read_text(encoding='utf-8', errors='replace')\n"
        "    # Deterministic 'clean' output: for round_02 (context_dir set), add a tiny marker line.\n"
        "    clean_txt = txt\n"
        "    if args.context_dir:\n"
        "        clean_txt = txt.rstrip('\\n') + '\\n% context applied\\n'\n"
        "    (out_dir / 'clean.tex').write_text(clean_txt, encoding='utf-8')\n"
        "    (out_dir / 'changes.diff').write_text('', encoding='utf-8')\n"
        "    (out_dir / 'verification_requests.json').write_text(json.dumps({'schema_version': 1, 'items': []}, indent=2) + '\\n', encoding='utf-8')\n"
        "    run = {\n"
        "        'schema_version': 1,\n"
        "        'exit_status': 0,\n"
        "        'converged': True,\n"
        "        'auditor_verdict': 'stub',\n"
        "        'deep_verifier_verdict': 'stub',\n"
        "        'meta': {\n"
        "            'writer_backend': args.writer_backend,\n"
        "            'writer_model': args.writer_model,\n"
        "            'auditor_backend': args.auditor_backend,\n"
        "            'auditor_model': args.auditor_model,\n"
        "            'max_rounds': int(args.max_rounds),\n"
        "            'min_clean_size_ratio': args.min_clean_size_ratio,\n"
        "            'codex_model': args.codex_model,\n"
        "            'codex_config': list(args.codex_config or []),\n"
        "            'fallback_auditor': args.fallback_auditor,\n"
        "            'fallback_auditor_model': args.fallback_auditor_model,\n"
        "            'secondary_deep_verify_backend': args.secondary_deep_verify_backend,\n"
        "            'secondary_deep_verify_model': args.secondary_deep_verify_model,\n"
        "        },\n"
        "    }\n"
        "    (out_dir / 'run.json').write_text(json.dumps(run, indent=2, sort_keys=True) + '\\n', encoding='utf-8')\n"
        "    return 0\n"
        "\n"
        "\n"
        "if __name__ == '__main__':\n"
        "    raise SystemExit(main())\n",
        encoding="utf-8",
    )

    plan_py = skill_bin / "build_verification_plan.py"
    plan_py.write_text(
        "import argparse\n"
        "import json\n"
        "from pathlib import Path\n"
        "\n"
        "\n"
        "def main() -> int:\n"
        "    p = argparse.ArgumentParser()\n"
        "    p.add_argument('--in', dest='in_path', required=True)\n"
        "    p.add_argument('--out', required=True)\n"
        "    p.add_argument('--kb-dir')\n"
        "    p.add_argument('--trace-path')\n"
        "    p.add_argument('--arxiv-src-dir')\n"
        "    args = p.parse_args()\n"
        "\n"
        "    out = Path(args.out)\n"
        "    out.parent.mkdir(parents=True, exist_ok=True)\n"
        "    plan = {\n"
        "        'schema_version': 1,\n"
        "        'generated_at': '2026-01-01T00:00:00Z',\n"
        "        'inputs': {\n"
        "            'verification_requests_json': {'path': str(args.in_path)},\n"
        "        },\n"
        "        'defaults': {},\n"
        "        'tasks': [],\n"
        "    }\n"
        "    out.write_text(json.dumps(plan, indent=2, sort_keys=True) + '\\n', encoding='utf-8')\n"
        "    return 0\n"
        "\n"
        "\n"
        "if __name__ == '__main__':\n"
        "    raise SystemExit(main())\n",
        encoding="utf-8",
    )


def _write_stub_literature_fetch(skills_root: Path) -> Path:
    """
    Provide a minimal, offline stub for research-team's literature_fetch.py.

    paper_reviser validates retrieval tasks by checking argv_resolved looks like:
      python <...>/literature_fetch.py <subcommand> ...
    so the tests write a stub script with that exact filename.
    """
    lit_fetch = skills_root / "research-team" / "scripts" / "bin" / "literature_fetch.py"
    lit_fetch.parent.mkdir(parents=True, exist_ok=True)
    lit_fetch.write_text(
        "import argparse\n"
        "import time\n"
        "from pathlib import Path\n"
        "\n"
        "\n"
        "def main() -> int:\n"
        "    p = argparse.ArgumentParser()\n"
        "    p.add_argument('cmd')\n"
        "    p.add_argument('--kb-dir')\n"
        "    p.add_argument('--trace-path')\n"
        "    p.add_argument('--out-dir')\n"
        "    p.add_argument('--write-note', action='store_true')\n"
        "    p.add_argument('--write-trace', action='store_true')\n"
        "    p.add_argument('--recid')\n"
        "    p.add_argument('--arxiv-id')\n"
        "    p.add_argument('--doi')\n"
        "    p.add_argument('--query')\n"
        "    p.add_argument('-n', '--max-results')\n"
        "    p.add_argument('--trace-note')\n"
        "    args, _ = p.parse_known_args()\n"
        "\n"
        "    if args.kb_dir:\n"
        "        kb = Path(args.kb_dir)\n"
        "        kb.mkdir(parents=True, exist_ok=True)\n"
        "        (kb / 'stub.txt').write_text('ok\\n', encoding='utf-8')\n"
        "    if args.trace_path:\n"
        "        tp = Path(args.trace_path)\n"
        "        tp.parent.mkdir(parents=True, exist_ok=True)\n"
        "        tp.write_text('trace\\n', encoding='utf-8')\n"
        "    if args.out_dir:\n"
        "        od = Path(args.out_dir)\n"
        "        od.mkdir(parents=True, exist_ok=True)\n"
        "        (od / 'stub.txt').write_text('ok\\n', encoding='utf-8')\n"
        "\n"
        "    print(time.time())\n"
        "    return 0\n"
        "\n"
        "\n"
        "if __name__ == '__main__':\n"
        "    raise SystemExit(main())\n",
        encoding="utf-8",
    )
    return lit_fetch


class TestPaperReviserWorkflow(unittest.TestCase):
    def test_offline_e2e_a1_gate_and_resume_skip(self) -> None:
        import sys
        from contextlib import redirect_stderr, redirect_stdout
        from io import StringIO

        sys.path.insert(0, str(_src_root()))
        from hep_autoresearch.cli import main as public_cli_main
        from hep_autoresearch.orchestrator_cli import main as internal_cli_main

        def run_cli(argv: list[str], *, public: bool) -> int:
            argv0 = list(sys.argv)
            try:
                sys.argv = list(argv)
                buf_out, buf_err = StringIO(), StringIO()
                with redirect_stdout(buf_out), redirect_stderr(buf_err):
                    entrypoint = public_cli_main if public else internal_cli_main
                    return int(entrypoint())
            finally:
                sys.argv = argv0

        with tempfile.TemporaryDirectory() as td:
            repo_root = Path(td)
            self.assertEqual(run_cli(["hep-autoresearch-internal", "--project-root", str(repo_root), "init"], public=False), 0)

            # Create an offline stub of the external paper-reviser skill.
            skills_root = repo_root / "skills"
            _write_stub_paper_reviser_skill(skills_root)
            lit_fetch = _write_stub_literature_fetch(skills_root)

            # Minimal LaTeX draft.
            paper_dir = repo_root / "paper"
            paper_dir.mkdir(parents=True, exist_ok=True)
            draft_path = paper_dir / "main.tex"
            draft_path.write_text(
                "\\documentclass{article}\n"
                "\\begin{document}\n"
                "Hello world.\n"
                "\\end{document}\n",
                encoding="utf-8",
            )

            run_id = "M1-test-paper-reviser"
            run_root = repo_root / "artifacts" / "runs" / run_id / "paper_reviser"

            # Provide an explicit, offline-safe verification_plan.json so Step C has at least one task.
            plan_src = repo_root / "verification_plan_src.json"
            kb_dir_rel = f"artifacts/runs/{run_id}/paper_reviser/verification/kb/literature"
            trace_path_rel = f"artifacts/runs/{run_id}/paper_reviser/verification/traces/literature_queries.md"
            argv = [
                sys.executable,
                str(lit_fetch),
                "inspire-get",
                "--recid",
                "1",
                "--write-note",
                "--kb-dir",
                kb_dir_rel,
                "--write-trace",
                "--trace-note",
                "paper-reviser:VR-LIT-001",
                "--trace-path",
                trace_path_rel,
            ]
            plan_obj = {
                "schema_version": 1,
                "generated_at": "2026-01-01T00:00:00Z",
                "inputs": {"note": "offline stub plan"},
                "defaults": {},
                "tasks": [
                    {
                        "task_id": "LF-001",
                        "tool": "research-team.literature_fetch",
                        "cmd": "stub",
                        "vr_ids": ["VR-LIT-001"],
                        "argv_template": argv,
                        "argv_resolved": argv,
                        "meta": {"note": "offline stub task"},
                    }
                ],
            }
            plan_src.write_text(json.dumps(plan_obj, indent=2, sort_keys=True) + "\n", encoding="utf-8")

            base = [
                "hep-autoresearch-internal",
                "--project-root",
                str(repo_root),
                "run",
                "--run-id",
                run_id,
                "--workflow-id",
                "paper_reviser",
                "--paper-reviser-mode",
                "stub-models",
                "--writer-backend",
                "claude",
                "--writer-model",
                "stub",
                "--auditor-backend",
                "gemini",
                "--auditor-model",
                "stub",
                "--evidence-synth-backend",
                "stub",
                "--evidence-synth-model",
                "stub",
                "--paper-reviser-min-clean-size-ratio",
                "0.7",
                "--paper-reviser-codex-model",
                "codex-test",
                "--paper-reviser-codex-config",
                "reasoning.effort=medium",
                "--paper-reviser-codex-config",
                "sandbox_mode=read-only",
                "--paper-reviser-fallback-auditor",
                "claude",
                "--paper-reviser-fallback-auditor-model",
                "claude-fallback-test",
                "--paper-reviser-secondary-deep-verify-backend",
                "gemini",
                "--paper-reviser-secondary-deep-verify-model",
                "gemini-secondary-test",
                "--verification-plan",
                str(plan_src),
                "--skills-dir",
                str(skills_root),
            ]

            # First run should request A1 approval (Step C) before running retrieval tasks.
            rc = run_cli(base, public=False)
            self.assertEqual(rc, 3)

            # SSOT should already be written even when blocked by the approval gate.
            analysis_blocked = json.loads((run_root / "analysis.json").read_text(encoding="utf-8"))
            self.assertEqual(((analysis_blocked.get("results") or {}).get("status")), "blocked_by_gate")
            blocked_info = ((analysis_blocked.get("results") or {}).get("blocked") or {})
            self.assertIn("A1", (blocked_info.get("missing_gates") or []))
            self.assertGreater(int(blocked_info.get("task_count") or 0), 0)
            tasks_list = blocked_info.get("tasks")
            self.assertIsInstance(tasks_list, list)
            self.assertTrue(any(isinstance(t, dict) and t.get("task_id") == "LF-001" for t in (tasks_list or [])))

            state = json.loads((repo_root / ".autoresearch" / "state.json").read_text(encoding="utf-8"))
            pending = state.get("pending_approval")
            self.assertIsInstance(pending, dict)
            self.assertEqual((pending or {}).get("category"), "A1")
            self.assertEqual(state.get("run_status"), "awaiting_approval")

            approval_id = (pending or {}).get("approval_id")
            self.assertIsInstance(approval_id, str)
            packet_rel = (pending or {}).get("packet_path")
            self.assertIsInstance(packet_rel, str)
            self.assertTrue((repo_root / str(packet_rel)).exists())
            packet_txt = (repo_root / str(packet_rel)).read_text(encoding="utf-8", errors="replace")
            self.assertIn("LF-001", packet_txt)

            # Ensure tasks did not execute before approval.
            self.assertFalse((run_root / "verification" / "task_state" / "LF-001.json").exists())

            self.assertEqual(
                run_cli(["hep-autoresearch-internal", "--project-root", str(repo_root), "approve", str(approval_id)], public=False),
                0,
            )

            # Second run should complete end-to-end (offline stub paths).
            rc2 = run_cli(base, public=False)
            self.assertEqual(rc2, 0)

            # SSOT structure.
            self.assertTrue((run_root / "manifest.json").exists())
            self.assertTrue((run_root / "report.md").exists())
            self.assertTrue((run_root / "round_01" / "run.json").exists())
            self.assertTrue((run_root / "round_02" / "run.json").exists())
            self.assertTrue((run_root / "verification" / "verification_plan.json").exists())

            analysis_done = json.loads((run_root / "analysis.json").read_text(encoding="utf-8"))
            self.assertEqual(((analysis_done.get("results") or {}).get("status")), "completed")
            self.assertTrue(bool((analysis_done.get("results") or {}).get("ok")))
            self.assertEqual(((analysis_done.get("results") or {}).get("errors") or []), [])
            run1 = json.loads((run_root / "round_01" / "run.json").read_text(encoding="utf-8"))
            run2 = json.loads((run_root / "round_02" / "run.json").read_text(encoding="utf-8"))
            for obj in [run1, run2]:
                meta = (obj.get("meta") or {})
                self.assertEqual(meta.get("min_clean_size_ratio"), 0.7)
                self.assertEqual(meta.get("codex_model"), "codex-test")
                self.assertEqual(meta.get("codex_config"), ["reasoning.effort=medium", "sandbox_mode=read-only"])
                self.assertEqual(meta.get("fallback_auditor"), "claude")
                self.assertEqual(meta.get("fallback_auditor_model"), "claude-fallback-test")
                self.assertEqual(meta.get("secondary_deep_verify_backend"), "gemini")
                self.assertEqual(meta.get("secondary_deep_verify_model"), "gemini-secondary-test")

            manifest_done = json.loads((run_root / "manifest.json").read_text(encoding="utf-8"))
            steps = manifest_done.get("steps") or {}
            self.assertIsInstance(steps, dict)
            for k in ["A", "B", "C", "D", "E"]:
                self.assertIn(k, steps)
                self.assertNotEqual(((steps.get(k) or {}).get("status")), "failed")

            # Step C task state/log.
            task_state = json.loads(
                (run_root / "verification" / "task_state" / "LF-001.json").read_text(encoding="utf-8")
            )
            self.assertEqual(int(task_state.get("exit_code", 999)), 0)
            log_path = run_root / "verification" / "logs" / "LF-001.log"
            self.assertTrue(log_path.exists())

            # Step D evidence synthesis SSOT outputs.
            vr_json = run_root / "verification" / "evidence" / "VR-LIT-001.json"
            vr_md = run_root / "verification" / "evidence" / "VR-LIT-001.md"
            self.assertTrue(vr_json.exists())
            self.assertTrue(vr_md.exists())

            # Resume/skip: rerun should not re-execute task or evidence synthesis.
            log_sha_1 = hashlib.sha256(log_path.read_bytes()).hexdigest()
            vr_sha_1 = hashlib.sha256(vr_json.read_bytes()).hexdigest()
            rc3 = run_cli(base, public=False)
            self.assertEqual(rc3, 0)
            log_sha_2 = hashlib.sha256(log_path.read_bytes()).hexdigest()
            vr_sha_2 = hashlib.sha256(vr_json.read_bytes()).hexdigest()
            self.assertEqual(log_sha_1, log_sha_2)
            self.assertEqual(vr_sha_1, vr_sha_2)

    def test_offline_e2e_a4_gate_apply_to_draft(self) -> None:
        import sys
        from contextlib import redirect_stderr, redirect_stdout
        from io import StringIO

        sys.path.insert(0, str(_src_root()))
        from hep_autoresearch.cli import main as public_cli_main
        from hep_autoresearch.orchestrator_cli import main as internal_cli_main

        def run_cli(argv: list[str], *, public: bool) -> int:
            argv0 = list(sys.argv)
            try:
                sys.argv = list(argv)
                buf_out, buf_err = StringIO(), StringIO()
                with redirect_stdout(buf_out), redirect_stderr(buf_err):
                    entrypoint = public_cli_main if public else internal_cli_main
                    return int(entrypoint())
            finally:
                sys.argv = argv0

        with tempfile.TemporaryDirectory() as td:
            repo_root = Path(td)
            self.assertEqual(run_cli(["hep-autoresearch-internal", "--project-root", str(repo_root), "init"], public=False), 0)

            skills_root = repo_root / "skills"
            _write_stub_paper_reviser_skill(skills_root)
            lit_fetch = _write_stub_literature_fetch(skills_root)

            paper_dir = repo_root / "paper"
            paper_dir.mkdir(parents=True, exist_ok=True)
            draft_path = paper_dir / "main.tex"
            draft_path.write_text(
                "\\documentclass{article}\n"
                "\\begin{document}\n"
                "Hello world.\n"
                "\\end{document}\n",
                encoding="utf-8",
            )

            run_id = "M1-test-paper-reviser-apply"
            run_root = repo_root / "artifacts" / "runs" / run_id / "paper_reviser"

            plan_src = repo_root / "verification_plan_src_apply.json"
            kb_dir_rel = f"artifacts/runs/{run_id}/paper_reviser/verification/kb/literature"
            trace_path_rel = f"artifacts/runs/{run_id}/paper_reviser/verification/traces/literature_queries.md"
            argv = [
                sys.executable,
                str(lit_fetch),
                "inspire-get",
                "--recid",
                "1",
                "--write-note",
                "--kb-dir",
                kb_dir_rel,
                "--write-trace",
                "--trace-note",
                "paper-reviser:VR-LIT-001",
                "--trace-path",
                trace_path_rel,
            ]
            plan_obj = {
                "schema_version": 1,
                "generated_at": "2026-01-01T00:00:00Z",
                "inputs": {"note": "offline stub plan"},
                "defaults": {},
                "tasks": [
                    {
                        "task_id": "LF-001",
                        "tool": "research-team.literature_fetch",
                        "cmd": "stub",
                        "vr_ids": ["VR-LIT-001"],
                        "argv_template": argv,
                        "argv_resolved": argv,
                        "meta": {"note": "offline stub task"},
                    }
                ],
            }
            plan_src.write_text(json.dumps(plan_obj, indent=2, sort_keys=True) + "\n", encoding="utf-8")

            base = [
                "hep-autoresearch-internal",
                "--project-root",
                str(repo_root),
                "run",
                "--run-id",
                run_id,
                "--workflow-id",
                "paper_reviser",
                "--paper-reviser-mode",
                "stub-models",
                "--writer-backend",
                "claude",
                "--writer-model",
                "stub",
                "--auditor-backend",
                "gemini",
                "--auditor-model",
                "stub",
                "--evidence-synth-backend",
                "stub",
                "--evidence-synth-model",
                "stub",
                "--verification-plan",
                str(plan_src),
                "--skills-dir",
                str(skills_root),
                "--apply-to-draft",
            ]

            # First run should request A1 approval.
            rc = run_cli(base, public=False)
            self.assertEqual(rc, 3)
            state = json.loads((repo_root / ".autoresearch" / "state.json").read_text(encoding="utf-8"))
            approval_a1 = ((state.get("pending_approval") or {}).get("approval_id"))
            self.assertIsInstance(approval_a1, str)
            self.assertEqual(
                run_cli(["hep-autoresearch-internal", "--project-root", str(repo_root), "approve", str(approval_a1)], public=False),
                0,
            )

            # Second run should request A4 approval to apply edits back to the draft.
            rc2 = run_cli(base, public=False)
            self.assertEqual(rc2, 3)
            state2 = json.loads((repo_root / ".autoresearch" / "state.json").read_text(encoding="utf-8"))
            pending2 = state2.get("pending_approval") or {}
            self.assertEqual(pending2.get("category"), "A4")
            approval_a4 = pending2.get("approval_id")
            self.assertIsInstance(approval_a4, str)

            # Draft should still be unchanged (apply step is gated).
            draft_txt_2 = draft_path.read_text(encoding="utf-8", errors="replace")
            self.assertNotIn("% context applied", draft_txt_2)

            self.assertEqual(
                run_cli(["hep-autoresearch-internal", "--project-root", str(repo_root), "approve", str(approval_a4)], public=False),
                0,
            )

            # Third run should complete and apply.
            rc3 = run_cli(base, public=False)
            self.assertEqual(rc3, 0)
            draft_txt_3 = draft_path.read_text(encoding="utf-8", errors="replace")
            self.assertIn("% context applied", draft_txt_3)
            self.assertTrue((run_root / "apply" / "draft.diff").exists())

    def test_internal_full_parser_fails_closed_on_structured_paper_reviser_errors(self) -> None:
        import sys
        from contextlib import redirect_stderr, redirect_stdout
        from io import StringIO

        sys.path.insert(0, str(_src_root()))
        from hep_autoresearch import orchestrator_cli
        from hep_autoresearch.cli import main as public_cli_main
        from hep_autoresearch.orchestrator_cli import main as internal_cli_main

        def run_cli(argv: list[str], *, public: bool) -> tuple[int, str, str]:
            argv0 = list(sys.argv)
            try:
                sys.argv = list(argv)
                buf_out, buf_err = StringIO(), StringIO()
                with redirect_stdout(buf_out), redirect_stderr(buf_err):
                    entrypoint = public_cli_main if public else internal_cli_main
                    rc = int(entrypoint())
                return rc, buf_out.getvalue(), buf_err.getvalue()
            finally:
                sys.argv = argv0

        with tempfile.TemporaryDirectory() as td:
            repo_root = Path(td)
            rc_init, _, _ = run_cli(["hep-autoresearch-internal", "--project-root", str(repo_root), "init"], public=False)
            self.assertEqual(rc_init, 0)

            paper_dir = repo_root / "paper"
            paper_dir.mkdir(parents=True, exist_ok=True)
            (paper_dir / "main.tex").write_text(
                "\\documentclass{article}\n"
                "\\begin{document}\n"
                "Hello world.\n"
                "\\end{document}\n",
                encoding="utf-8",
            )

            run_id = "M1-test-paper-reviser-fail"

            def _failing_paper_reviser(*_args, **_kwargs):
                run_root = repo_root / "artifacts" / "runs" / run_id / "paper_reviser"
                run_root.mkdir(parents=True, exist_ok=True)
                analysis_path = run_root / "analysis.json"
                analysis_path.write_text(
                    json.dumps(
                        {
                            "results": {
                                "status": "failed",
                                "ok": False,
                                "errors": ["stub failure"],
                            }
                        },
                        indent=2,
                        sort_keys=True,
                    )
                    + "\n",
                    encoding="utf-8",
                )
                return {
                    "errors": ["stub failure"],
                    "artifact_paths": {
                        "analysis": str(analysis_path.relative_to(repo_root)),
                    },
                }

            argv = [
                "hep-autoresearch-internal",
                "--project-root",
                str(repo_root),
                "run",
                "--run-id",
                run_id,
                "--workflow-id",
                "paper_reviser",
                "--paper-reviser-mode",
                "stub-models",
                "--writer-backend",
                "claude",
                "--writer-model",
                "stub",
                "--auditor-backend",
                "gemini",
                "--auditor-model",
                "stub",
                "--evidence-synth-backend",
                "stub",
                "--evidence-synth-model",
                "stub",
            ]

            with patch.object(orchestrator_cli, "paper_reviser_one", side_effect=_failing_paper_reviser):
                rc, _, err = run_cli(argv, public=False)

            self.assertEqual(rc, 2)
            self.assertNotIn("allow_errors", err)
            self.assertNotIn("AttributeError", err)

            state = json.loads((repo_root / ".autoresearch" / "state.json").read_text(encoding="utf-8"))
            self.assertEqual(state.get("run_status"), "failed")
            self.assertIn("completed with errors", str(state.get("notes") or ""))
