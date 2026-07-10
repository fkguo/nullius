import importlib.util
import json
import os
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


def _read_trace_events(trace_path: Path) -> list[dict]:
    if not trace_path.exists():
        return []
    return [json.loads(line) for line in trace_path.read_text(encoding="utf-8").splitlines() if line.strip()]


def _write_valid_runner(path: Path) -> None:
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
VERDICT: READY
TXT
""",
        encoding="utf-8",
    )
    path.chmod(0o755)


def _write_crashing_runner(path: Path, *, exit_code: int = 3) -> None:
    path.write_text(
        f"""#!/usr/bin/env bash
exit {exit_code}
""",
        encoding="utf-8",
    )
    path.chmod(0o755)


def _write_empty_output_runner(path: Path) -> None:
    """Runner that exits 0 but writes an empty output file (every call)."""
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
: >"${out}"
""",
        encoding="utf-8",
    )
    path.chmod(0o755)


def _write_empty_then_valid_runner(path: Path, state_dir: Path) -> None:
    """Runner that writes an empty file on the first call, valid output after."""
    state_dir.mkdir(parents=True, exist_ok=True)
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
count_file="{state_dir}/count"
n=0
if [[ -f "${{count_file}}" ]]; then
  n=$(cat "${{count_file}}")
fi
n=$((n + 1))
echo "${{n}}" >"${{count_file}}"
if [[ "${{n}}" -ge 2 ]]; then
  printf 'VERDICT: READY\\n' >"${{out}}"
else
  : >"${{out}}"
fi
""",
        encoding="utf-8",
    )
    path.chmod(0o755)


def _run_main_with_argv(mod, argv: list[str]) -> int:
    import sys as _sys

    old_argv = _sys.argv
    try:
        _sys.argv = argv
        return mod.main()
    finally:
        _sys.argv = old_argv


def _result(index: int, backend: str, model: str, *, resolved_backend=None, variant="canonical", fallback_reason=None):
    resolved = {"backend": resolved_backend or backend, "model": model}
    return {
        "index": index,
        "requested": {"backend": backend, "model": model},
        "resolved": resolved,
        "variant": variant,
        "fallback_reason": fallback_reason,
    }


class FailureClassificationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.mod = _load_run_multi_task_module()

    def test_classify_failure_reasons(self):
        classify = self.mod._classify_failure
        self.assertIsNone(classify(None))
        for reason in ("timeout", "empty_output", "exit_code_3", "exit_code_unknown",
                       "phase1_command_failed", "phase1_empty_output"):
            self.assertEqual(classify(reason), "infrastructure", reason)
        self.assertEqual(classify("phase1_criteria_invalid"), "content")
        # Unknown reasons must not read as outages.
        self.assertEqual(classify("something_new"), "content")


class DualReviewSummaryTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.mod = _load_run_multi_task_module()

    def test_any_two_distinct_backends_are_summarized(self):
        results = [
            _result(0, "codex", "codex/default"),
            _result(1, "gemini", "gemini/default"),
        ]
        summary = self.mod._dual_review_summary(results)
        self.assertIsNotNone(summary)
        self.assertEqual(summary["reviewer_a"]["requested"]["backend"], "codex")
        self.assertEqual(summary["reviewer_b"]["requested"]["backend"], "gemini")
        self.assertEqual(summary["diversity"], "ok")

    def test_legacy_claude_gemini_pair_still_works(self):
        results = [
            _result(0, "claude", "claude/default"),
            _result(1, "gemini", "gemini/default"),
        ]
        summary = self.mod._dual_review_summary(results)
        self.assertIsNotNone(summary)
        self.assertEqual(summary["reviewer_a"]["requested"]["backend"], "claude")
        self.assertEqual(summary["reviewer_b"]["requested"]["backend"], "gemini")
        self.assertEqual(summary["diversity"], "ok")

    def test_same_backend_only_yields_no_summary(self):
        results = [
            _result(0, "codex", "codex/default"),
            _result(1, "codex", "codex/other"),
        ]
        self.assertIsNone(self.mod._dual_review_summary(results))

    def test_skips_duplicates_until_distinct_backend(self):
        results = [
            _result(0, "codex", "codex/default"),
            _result(1, "codex", "codex/other"),
            _result(2, "kimi", "kimi/default"),
        ]
        summary = self.mod._dual_review_summary(results)
        self.assertIsNotNone(summary)
        self.assertEqual(summary["reviewer_a"]["requested"]["backend"], "codex")
        self.assertEqual(summary["reviewer_b"]["requested"]["backend"], "kimi")

    def test_diversity_degrades_when_resolved_families_coincide(self):
        results = [
            _result(0, "codex", "codex/default"),
            _result(
                1,
                "gemini",
                "gemini/default",
                resolved_backend="codex",
                variant="fallback",
                fallback_reason="timeout",
            ),
        ]
        summary = self.mod._dual_review_summary(results)
        self.assertIsNotNone(summary)
        self.assertEqual(summary["diversity"], "degraded")

    def test_fewer_than_two_reviewers_yields_no_summary(self):
        self.assertIsNone(self.mod._dual_review_summary([]))
        self.assertIsNone(self.mod._dual_review_summary([_result(0, "codex", "codex/default")]))

    def test_end_to_end_codex_gemini_meta_summary(self):
        with tempfile.TemporaryDirectory() as td:
            td_path = Path(td)
            out_dir = td_path / "out"
            system = td_path / "system.md"
            prompt = td_path / "prompt.md"
            system.write_text("SYSTEM\n", encoding="utf-8")
            prompt.write_text("PROMPT\n", encoding="utf-8")
            codex_runner = td_path / "run_codex.sh"
            gemini_runner = td_path / "run_gemini.sh"
            opencode_runner = td_path / "run_opencode.sh"
            _write_valid_runner(codex_runner)
            _write_valid_runner(gemini_runner)
            _write_valid_runner(opencode_runner)

            argv = [
                "run_multi_task.py",
                "--out-dir", str(out_dir),
                "--opencode-runner", str(opencode_runner),
                "--codex-runner", str(codex_runner),
                "--gemini-runner", str(gemini_runner),
                "--system", str(system),
                "--prompt", str(prompt),
                "--models", "codex/default,gemini/default",
                "--no-parallel",
            ]
            code = _run_main_with_argv(self.mod, argv)
            self.assertEqual(code, 0)
            meta = json.loads((out_dir / "meta.json").read_text(encoding="utf-8"))
            self.assertEqual(meta["reviewer_a"]["requested"]["backend"], "codex")
            self.assertEqual(meta["reviewer_b"]["requested"]["backend"], "gemini")
            self.assertEqual(meta["diversity"], "ok")
            self.assertIn("reviewer_a_output", meta["paths"])
            self.assertIn("reviewer_b_output", meta["paths"])


class RetryEmptyOutputTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.mod = _load_run_multi_task_module()
        os.environ["REVIEW_SWARM_NO_AUTO_CONFIG"] = "1"

    @classmethod
    def tearDownClass(cls):
        os.environ.pop("REVIEW_SWARM_NO_AUTO_CONFIG", None)

    def _argv(self, td_path: Path, out_dir: Path, runner: Path, *extra: str) -> list[str]:
        system = td_path / "system.md"
        prompt = td_path / "prompt.md"
        if not system.exists():
            system.write_text("SYSTEM\n", encoding="utf-8")
            prompt.write_text("PROMPT\n", encoding="utf-8")
        opencode_runner = td_path / "run_opencode.sh"
        if not opencode_runner.exists():
            _write_valid_runner(opencode_runner)
        return [
            "run_multi_task.py",
            "--out-dir", str(out_dir),
            "--opencode-runner", str(opencode_runner),
            "--codex-runner", str(runner),
            "--system", str(system),
            "--prompt", str(prompt),
            "--models", "codex/default",
            "--no-parallel",
            *extra,
        ]

    def test_empty_output_recovers_with_explicit_retry(self):
        with tempfile.TemporaryDirectory() as td:
            td_path = Path(td)
            out_dir = td_path / "out"
            runner = td_path / "run_codex.sh"
            _write_empty_then_valid_runner(runner, td_path / "state")

            code = _run_main_with_argv(
                self.mod, self._argv(td_path, out_dir, runner, "--retry-empty-output", "1")
            )
            self.assertEqual(code, 0)

            meta = json.loads((out_dir / "meta.json").read_text(encoding="utf-8"))
            agent = meta["agents"][0]
            self.assertTrue(agent["success"])
            self.assertIsNone(agent["failure_reason"])
            self.assertEqual(agent["empty_output_retries"], 1)
            self.assertEqual(meta["unavailable_backends"], [])

            events = _read_trace_events(out_dir / "trace.jsonl")
            retries = [e for e in events if e.get("event") == "empty_output_retry"]
            self.assertEqual(len(retries), 1)
            self.assertEqual(retries[0]["model"], "codex/default")

    def test_default_is_no_retry(self):
        # The launcher default must stay 0 (strictly additive for path-pinned
        # consumers such as derivation-verify's run_multi_backend.py): a runner
        # that WOULD recover on a second call must not be retried by default.
        with tempfile.TemporaryDirectory() as td:
            td_path = Path(td)
            out_dir = td_path / "out"
            runner = td_path / "run_codex.sh"
            _write_empty_then_valid_runner(runner, td_path / "state")

            code = _run_main_with_argv(self.mod, self._argv(td_path, out_dir, runner))
            self.assertEqual(code, 2)
            meta = json.loads((out_dir / "meta.json").read_text(encoding="utf-8"))
            agent = meta["agents"][0]
            self.assertEqual(agent["failure_reason"], "empty_output")
            self.assertNotIn("empty_output_retries", agent)
            events = _read_trace_events(out_dir / "trace.jsonl")
            self.assertFalse([e for e in events if e.get("event") == "empty_output_retry"])

    def test_retry_disabled_records_empty_output_without_retry(self):
        with tempfile.TemporaryDirectory() as td:
            td_path = Path(td)
            out_dir = td_path / "out"
            runner = td_path / "run_codex.sh"
            _write_empty_output_runner(runner)

            code = _run_main_with_argv(
                self.mod, self._argv(td_path, out_dir, runner, "--retry-empty-output", "0")
            )
            self.assertEqual(code, 2)
            meta = json.loads((out_dir / "meta.json").read_text(encoding="utf-8"))
            agent = meta["agents"][0]
            self.assertEqual(agent["failure_reason"], "empty_output")
            self.assertNotIn("empty_output_retries", agent)
            events = _read_trace_events(out_dir / "trace.jsonl")
            self.assertFalse([e for e in events if e.get("event") == "empty_output_retry"])

    def test_persistently_empty_backend_is_reported_unavailable(self):
        with tempfile.TemporaryDirectory() as td:
            td_path = Path(td)
            out_dir = td_path / "out"
            runner = td_path / "run_codex.sh"
            _write_empty_output_runner(runner)

            code = _run_main_with_argv(
                self.mod, self._argv(td_path, out_dir, runner, "--retry-empty-output", "1")
            )
            self.assertEqual(code, 2)
            meta = json.loads((out_dir / "meta.json").read_text(encoding="utf-8"))
            agent = meta["agents"][0]
            self.assertEqual(agent["failure_reason"], "empty_output")
            self.assertEqual(agent["failure_class"], "infrastructure")
            self.assertEqual(agent["empty_output_retries"], 1)
            self.assertEqual(
                meta["unavailable_backends"],
                [{"spec": "codex/default", "runs": 1, "failure_reasons": ["empty_output"]}],
            )

    def test_successful_retry_does_not_trigger_fallback(self):
        # Help-text claim under test: retries run BEFORE fallback is considered.
        # A retry that recovers must leave the agent canonical — no fallback
        # event, no fallback substitution — even with auto fallback armed for
        # exactly this backend.
        with tempfile.TemporaryDirectory() as td:
            td_path = Path(td)
            out_dir = td_path / "out"
            runner = td_path / "run_codex.sh"
            _write_empty_then_valid_runner(runner, td_path / "state")

            code = _run_main_with_argv(
                self.mod,
                self._argv(
                    td_path, out_dir, runner,
                    "--retry-empty-output", "1",
                    "--fallback-mode", "auto",
                    "--fallback-target-backends", "codex",
                ),
            )
            self.assertEqual(code, 0)

            meta = json.loads((out_dir / "meta.json").read_text(encoding="utf-8"))
            agent = meta["agents"][0]
            self.assertTrue(agent["success"])
            self.assertEqual(agent["variant"], "canonical")
            self.assertIsNone(agent["fallback_reason"])
            self.assertEqual(agent["resolved"], {"backend": "codex", "model": "codex/default"})
            self.assertEqual(agent["empty_output_retries"], 1)
            self.assertEqual(meta["unavailable_backends"], [])

            events = _read_trace_events(out_dir / "trace.jsonl")
            self.assertEqual(
                [e for e in events if str(e.get("event", "")).startswith("fallback_")], []
            )
            self.assertEqual(
                len([e for e in events if e.get("event") == "empty_output_retry"]), 1
            )

    def test_negative_retry_count_is_input_error(self):
        with tempfile.TemporaryDirectory() as td:
            td_path = Path(td)
            out_dir = td_path / "out"
            runner = td_path / "run_codex.sh"
            _write_valid_runner(runner)
            code = _run_main_with_argv(
                self.mod, self._argv(td_path, out_dir, runner, "--retry-empty-output", "-1")
            )
            self.assertEqual(code, 2)
            events = _read_trace_events(out_dir / "trace.jsonl")
            input_errors = [e for e in events if e.get("event") == "input_error"]
            self.assertTrue(input_errors)
            self.assertIn("--retry-empty-output", input_errors[-1].get("error", ""))


class UnavailableBackendsTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.mod = _load_run_multi_task_module()
        os.environ["REVIEW_SWARM_NO_AUTO_CONFIG"] = "1"

    @classmethod
    def tearDownClass(cls):
        os.environ.pop("REVIEW_SWARM_NO_AUTO_CONFIG", None)

    def test_crashed_backend_listed_healthy_backend_not(self):
        with tempfile.TemporaryDirectory() as td:
            td_path = Path(td)
            out_dir = td_path / "out"
            system = td_path / "system.md"
            prompt = td_path / "prompt.md"
            system.write_text("SYSTEM\n", encoding="utf-8")
            prompt.write_text("PROMPT\n", encoding="utf-8")
            codex_runner = td_path / "run_codex.sh"
            gemini_runner = td_path / "run_gemini.sh"
            opencode_runner = td_path / "run_opencode.sh"
            _write_crashing_runner(codex_runner, exit_code=3)
            _write_valid_runner(gemini_runner)
            _write_valid_runner(opencode_runner)

            argv = [
                "run_multi_task.py",
                "--out-dir", str(out_dir),
                "--opencode-runner", str(opencode_runner),
                "--codex-runner", str(codex_runner),
                "--gemini-runner", str(gemini_runner),
                "--system", str(system),
                "--prompt", str(prompt),
                "--models", "codex/default,gemini/default",
                "--no-parallel",
            ]
            code = _run_main_with_argv(self.mod, argv)
            self.assertEqual(code, 1)

            meta = json.loads((out_dir / "meta.json").read_text(encoding="utf-8"))
            self.assertEqual(
                meta["unavailable_backends"],
                [{"spec": "codex/default", "runs": 1, "failure_reasons": ["exit_code_3"]}],
            )
            by_backend = {a["backend"]: a for a in meta["agents"]}
            self.assertEqual(by_backend["codex"]["failure_class"], "infrastructure")
            self.assertIsNone(by_backend["gemini"]["failure_class"])


class FallbackTargetValidationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.mod = _load_run_multi_task_module()
        os.environ["REVIEW_SWARM_NO_AUTO_CONFIG"] = "1"

    @classmethod
    def tearDownClass(cls):
        os.environ.pop("REVIEW_SWARM_NO_AUTO_CONFIG", None)

    def _argv(self, td_path: Path, out_dir: Path, *extra: str) -> list[str]:
        system = td_path / "system.md"
        prompt = td_path / "prompt.md"
        runner = td_path / "run_opencode.sh"
        if not runner.exists():
            _write_valid_runner(runner)
            system.write_text("SYSTEM\n", encoding="utf-8")
            prompt.write_text("PROMPT\n", encoding="utf-8")
        return [
            "run_multi_task.py",
            "--out-dir", str(out_dir),
            "--opencode-runner", str(runner),
            "--system", str(system),
            "--prompt", str(prompt),
            "--model", "default",
            "--no-parallel",
            *extra,
        ]

    def test_fallback_mode_without_targets_is_input_error(self):
        for mode in ("auto", "ask"):
            with tempfile.TemporaryDirectory() as td:
                td_path = Path(td)
                out_dir = td_path / "out"
                code = _run_main_with_argv(
                    self.mod, self._argv(td_path, out_dir, "--fallback-mode", mode)
                )
                self.assertEqual(code, 2, mode)
                events = _read_trace_events(out_dir / "trace.jsonl")
                input_errors = [e for e in events if e.get("event") == "input_error"]
                self.assertTrue(input_errors, mode)
                self.assertIn("--fallback-target-backends", input_errors[-1].get("error", ""))

    def test_fallback_off_without_targets_is_fine(self):
        with tempfile.TemporaryDirectory() as td:
            td_path = Path(td)
            out_dir = td_path / "out"
            code = _run_main_with_argv(self.mod, self._argv(td_path, out_dir))
            self.assertEqual(code, 0)

    def test_fallback_mode_with_explicit_targets_is_accepted(self):
        with tempfile.TemporaryDirectory() as td:
            td_path = Path(td)
            out_dir = td_path / "out"
            code = _run_main_with_argv(
                self.mod,
                self._argv(
                    td_path,
                    out_dir,
                    "--fallback-mode", "auto",
                    "--fallback-target-backends", "gemini",
                ),
            )
            self.assertEqual(code, 0)


if __name__ == "__main__":
    unittest.main()
