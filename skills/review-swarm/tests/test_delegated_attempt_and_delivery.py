"""Delegated attempt budgets reach the backend runner, and a lane that only
points at a deliverable it left elsewhere is not a success.

Both defects were reported from a live cross-family review whose frozen
delegation budget stated "one attempt per reviewer, fallback off, no
spontaneous rerun":

1. ``_build_cmd`` forwarded no attempt-limit argument, so every backend
   runner kept its own default (3 for kimi/opencode, 6 for claude/codex) and
   re-ran a permanently failed provider call three times after a 403
   billing-cycle quota error. ``--retry-empty-output 0`` governs only the
   orchestration loop and cannot reach inside a runner.
2. A reviewer returned 188 bytes announcing that its report had been written
   to a file in its own workspace. The file never came back, but the lane
   exited 0 with a non-blank output and was scored a success, letting a
   non-delivery occupy a reviewer seat.
"""

import importlib.util
import json
import sys
import tempfile
import unittest
from pathlib import Path


def _load_run_multi_task_module():
    repo_root = Path(__file__).resolve().parents[1]
    module_path = repo_root / "scripts" / "bin" / "run_multi_task.py"
    spec = importlib.util.spec_from_file_location("run_multi_task", module_path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"Failed to load module spec: {module_path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _run_main_with_argv(mod, argv: list[str]) -> int:
    old_argv = sys.argv
    try:
        sys.argv = argv
        return mod.main()
    finally:
        sys.argv = old_argv


def _write_quota_failing_runner(path: Path, call_log: Path) -> None:
    """Runner that always fails with the observed permanent quota error and
    records every invocation, so the test can count real process launches."""
    path.write_text(
        f"""#!/usr/bin/env bash
echo "call" >> {json.dumps(str(call_log))}
echo "provider.api_error: 403 You've reached your usage limit for this billing cycle." >&2
exit 1
""",
        encoding="utf-8",
    )
    path.chmod(0o755)


def _write_attempt_honoring_runner(path: Path, call_log: Path) -> None:
    """Runner with a real internal attempt loop bounded by --max-attempts,
    mirroring run_kimi.sh / run_opencode.sh semantics (total attempts)."""
    path.write_text(
        f"""#!/usr/bin/env bash
set -uo pipefail
max_attempts=3
while [[ $# -gt 0 ]]; do
  case "$1" in
    --max-attempts) max_attempts="$2"; shift 2 ;;
    --max-retries) max_attempts="$2"; shift 2 ;;
    *) shift ;;
  esac
done
attempt=1
while [[ ${{attempt}} -le ${{max_attempts}} ]]; do
  echo "call" >> {json.dumps(str(call_log))}
  attempt=$((attempt + 1))
done
echo "provider.api_error: 403 You've reached your usage limit for this billing cycle." >&2
exit 1
""",
        encoding="utf-8",
    )
    path.chmod(0o755)


def _write_pointer_output_runner(path: Path) -> None:
    """Runner reproducing the observed non-delivery: exit 0, non-blank output
    that merely announces the report was written into the agent's workspace."""
    path.write_text(
        """#!/usr/bin/env bash
set -euo pipefail
out=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --out) out="$2"; shift 2 ;;
    *) shift ;;
  esac
done
cat >"${out}" <<'TXT'
I'll write the self-contained verification report to a file now.Report written to `blind_verification_report.md`. Verdict: `BLIND_THREE_CLAIMS_VERIFIED` (off-diagonal `a != b`, `B < A`).
TXT
""",
        encoding="utf-8",
    )
    path.chmod(0o755)


def _write_substantive_runner(path: Path) -> None:
    """A genuine review that ALSO mentions writing results to a file: it must
    keep passing, so the delivery gate cannot swallow real content."""
    body = "Substantive reasoning about the operator identity and its residual. " * 40
    path.write_text(
        f"""#!/usr/bin/env bash
set -euo pipefail
out=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --out) out="$2"; shift 2 ;;
    *) shift ;;
  esac
done
cat >"${{out}}" <<'TXT'
VERDICT: READY

## Blockers
- none

## High-severity
- Step 3 assumes a commuting projector without establishing it.

{body}
The harness writes its results to output.json for later inspection.
TXT
""",
        encoding="utf-8",
    )
    path.chmod(0o755)


class BackendAttemptBudgetTest(unittest.TestCase):
    def setUp(self):
        self.mod = _load_run_multi_task_module()

    def _plan(self, td_path: Path, backend: str):
        return self.mod.AgentPlan(
            index=0,
            backend=backend,
            requested_model=f"{backend}/default",
            runner_model=None,
            runner_path=td_path / f"run_{backend}.sh",
        )

    def _cmd(self, td_path: Path, backend: str, backend_max_attempts):
        return self.mod._build_cmd(
            plan=self._plan(td_path, backend),
            system=None,
            prompt=td_path / "prompt.md",
            out=td_path / "out.txt",
            opencode_agent=None,
            opencode_variant=None,
            backend_tool_modes={},
            review_workspace_dir=td_path,
            gemini_cli_home=None,
            backend_max_attempts=backend_max_attempts,
        )

    def test_attempt_limit_reaches_each_runner_under_its_own_flag_name(self):
        # The reported defect: the emitted Kimi command carried no attempt
        # argument at all, so run_kimi.sh used its default MAX_ATTEMPTS=3.
        with tempfile.TemporaryDirectory() as td:
            td_path = Path(td)
            for backend, flag in (
                ("kimi", "--max-attempts"),
                ("opencode", "--max-attempts"),
                ("claude", "--max-retries"),
                ("codex", "--max-retries"),
            ):
                cmd = self._cmd(td_path, backend, 1)
                self.assertIn(flag, cmd, f"{backend}: missing {flag}")
                self.assertEqual(
                    cmd[cmd.index(flag) + 1], "1", f"{backend}: wrong attempt value"
                )

    def test_gemini_takes_no_attempt_flag(self):
        # run_gemini.sh has no attempt loop; forwarding an unknown flag is how
        # a sibling defect once broke every codex lane.
        with tempfile.TemporaryDirectory() as td:
            cmd = self._cmd(Path(td), "gemini", 1)
            self.assertNotIn("--max-attempts", cmd)
            self.assertNotIn("--max-retries", cmd)

    def test_unset_budget_changes_no_command_line(self):
        # Backward compatibility: callers that do not bind attempts keep the
        # exact command line they had before.
        with tempfile.TemporaryDirectory() as td:
            td_path = Path(td)
            for backend in ("kimi", "opencode", "claude", "codex", "gemini"):
                cmd = self._cmd(td_path, backend, None)
                self.assertNotIn("--max-attempts", cmd)
                self.assertNotIn("--max-retries", cmd)

    def test_permanent_quota_failure_is_invoked_once_under_single_attempt(self):
        # End-to-end with a runner whose internal loop honors the flag, as the
        # real kimi/opencode runners do: a permanent quota failure must launch
        # exactly one process, not three.
        with tempfile.TemporaryDirectory() as td:
            td_path = Path(td)
            out_dir = td_path / "out"
            call_log = td_path / "calls.txt"
            system = td_path / "system.md"
            prompt = td_path / "prompt.md"
            system.write_text("SYSTEM\n", encoding="utf-8")
            prompt.write_text("PROMPT\n", encoding="utf-8")
            runner = td_path / "run_opencode.sh"
            _write_attempt_honoring_runner(runner, call_log)

            code = _run_main_with_argv(
                self.mod,
                [
                    "run_multi_task.py",
                    "--out-dir", str(out_dir),
                    "--opencode-runner", str(runner),
                    "--system", str(system),
                    "--prompt", str(prompt),
                    "--models", "opencode/default",
                    "--no-parallel",
                    "--retry-empty-output", "0",
                    "--fallback-mode", "off",
                    "--backend-max-attempts", "1",
                ],
            )
            self.assertNotEqual(code, 0)
            calls = call_log.read_text(encoding="utf-8").split()
            self.assertEqual(
                len(calls), 1, f"expected exactly one invocation, got {len(calls)}"
            )

    def test_meta_records_the_three_budgets_separately(self):
        with tempfile.TemporaryDirectory() as td:
            td_path = Path(td)
            out_dir = td_path / "out"
            call_log = td_path / "calls.txt"
            system = td_path / "system.md"
            prompt = td_path / "prompt.md"
            system.write_text("SYSTEM\n", encoding="utf-8")
            prompt.write_text("PROMPT\n", encoding="utf-8")
            runner = td_path / "run_opencode.sh"
            _write_quota_failing_runner(runner, call_log)

            _run_main_with_argv(
                self.mod,
                [
                    "run_multi_task.py",
                    "--out-dir", str(out_dir),
                    "--opencode-runner", str(runner),
                    "--system", str(system),
                    "--prompt", str(prompt),
                    "--models", "opencode/default",
                    "--no-parallel",
                    "--retry-empty-output", "0",
                    "--fallback-mode", "off",
                    "--backend-max-attempts", "1",
                ],
            )
            meta = json.loads((out_dir / "meta.json").read_text(encoding="utf-8"))
            budgets = meta["attempt_budgets"]
            # Three budgets, three fields — never one conflated number.
            self.assertEqual(budgets["backend_max_attempts"], 1)
            self.assertEqual(budgets["orchestration_empty_output_retries"], 0)
            self.assertEqual(budgets["fallback_mode"], "off")
            self.assertEqual(budgets["backend_attempt_flags"]["opencode"], "--max-attempts")

    def test_rejects_attempt_budget_below_one(self):
        with tempfile.TemporaryDirectory() as td:
            td_path = Path(td)
            out_dir = td_path / "out"
            system = td_path / "system.md"
            prompt = td_path / "prompt.md"
            system.write_text("SYSTEM\n", encoding="utf-8")
            prompt.write_text("PROMPT\n", encoding="utf-8")
            runner = td_path / "run_opencode.sh"
            _write_quota_failing_runner(runner, td_path / "calls.txt")
            code = _run_main_with_argv(
                self.mod,
                [
                    "run_multi_task.py",
                    "--out-dir", str(out_dir),
                    "--opencode-runner", str(runner),
                    "--system", str(system),
                    "--prompt", str(prompt),
                    "--models", "opencode/default",
                    "--no-parallel",
                    "--backend-max-attempts", "0",
                ],
            )
            self.assertNotEqual(code, 0)


class DeliveryGateTest(unittest.TestCase):
    def setUp(self):
        self.mod = _load_run_multi_task_module()

    def _run(self, td_path: Path, out_dir: Path, runner_writer, *extra: str) -> int:
        system = td_path / "system.md"
        prompt = td_path / "prompt.md"
        system.write_text("SYSTEM\n", encoding="utf-8")
        prompt.write_text("PROMPT\n", encoding="utf-8")
        runner = td_path / "run_opencode.sh"
        runner_writer(runner)
        return _run_main_with_argv(
            self.mod,
            [
                "run_multi_task.py",
                "--out-dir", str(out_dir),
                "--opencode-runner", str(runner),
                "--system", str(system),
                "--prompt", str(prompt),
                "--models", "opencode/default",
                "--no-parallel",
                "--fallback-mode", "off",
                *extra,
            ],
        )

    def test_pointer_only_output_is_not_a_success(self):
        with tempfile.TemporaryDirectory() as td:
            td_path = Path(td)
            out_dir = td_path / "out"
            code = self._run(td_path, out_dir, _write_pointer_output_runner)
            self.assertNotEqual(code, 0)
            meta = json.loads((out_dir / "meta.json").read_text(encoding="utf-8"))
            agent = meta["agents"][0]
            self.assertFalse(agent["success"])
            self.assertEqual(agent["failure_reason"], "externalized_output")
            # A non-delivery is an outage, not review disagreement.
            self.assertEqual(agent["failure_class"], "infrastructure")
            self.assertIn("blind_verification_report.md", agent["externalized_output_reason"])
            self.assertEqual(meta["success_count"], 0)

    def test_substantive_review_mentioning_a_file_still_passes(self):
        with tempfile.TemporaryDirectory() as td:
            td_path = Path(td)
            out_dir = td_path / "out"
            code = self._run(td_path, out_dir, _write_substantive_runner)
            self.assertEqual(code, 0)
            meta = json.loads((out_dir / "meta.json").read_text(encoding="utf-8"))
            agent = meta["agents"][0]
            self.assertTrue(agent["success"])
            self.assertIsNone(agent["failure_reason"])
            self.assertNotIn("externalized_output_reason", agent)

    def test_escape_hatch_accepts_pointer_output(self):
        # Unconditional opt-out for tasks where a pointer answer is the
        # intended deliverable — the gate is a heuristic and must not be
        # inescapable.
        with tempfile.TemporaryDirectory() as td:
            td_path = Path(td)
            out_dir = td_path / "out"
            code = self._run(
                td_path, out_dir, _write_pointer_output_runner, "--allow-pointer-output"
            )
            self.assertEqual(code, 0)
            meta = json.loads((out_dir / "meta.json").read_text(encoding="utf-8"))
            self.assertTrue(meta["agents"][0]["success"])

    def test_detector_unit_cases(self):
        reason = self.mod._externalized_deliverable_reason
        # Positive: English and Chinese pointer stubs.
        self.assertIsNotNone(
            reason("Report written to `verification.md`. Verdict: VERIFIED.")
        )
        self.assertIsNotNone(reason("我已完成核验。报告已写入 verification.md。结论：成立。"))
        # Negative: no filename-like target, no write verb, or long content.
        self.assertIsNone(reason("The solver writes checkpoints every 100 steps."))
        self.assertIsNone(reason("See config.json for the parameter set; the value is 0.31."))
        self.assertIsNone(reason("x" * 900 + " report written to out.md"))
        self.assertIsNone(reason(""))


if __name__ == "__main__":
    unittest.main()
