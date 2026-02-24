import contextlib
import importlib.util
import json
import os
import tempfile
import unittest
from hashlib import sha256
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


def _write_stub_runner(path: Path, body: str | None = None) -> None:
    if body is None:
        body = """#!/usr/bin/env bash
set -euo pipefail

out=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --out) out="$2"; shift 2 ;;
    *) shift ;;
  esac
done

if [[ -z "${out}" ]]; then
  echo "stub runner missing --out" >&2
  exit 2
fi

cat >"${out}" <<'TXT'
VERDICT: READY
TXT
"""
    path.write_text(body, encoding="utf-8")
    path.chmod(0o755)


def _write_stub_runner_records_inputs(path: Path) -> None:
    path.write_text(
        """#!/usr/bin/env bash
set -euo pipefail

out=""
system=""
prompt=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --out) out="$2"; shift 2 ;;
    --system-prompt-file) system="$2"; shift 2 ;;
    --prompt-file) prompt="$2"; shift 2 ;;
    *) shift ;;
  esac
done

if [[ -z "${out}" || -z "${prompt}" ]]; then
  echo "missing required args" >&2
  exit 2
fi

has_system=0
if [[ -n "${system}" ]]; then
  has_system=1
fi

cat >"${out}" <<TXT
HAS_SYSTEM=${has_system}
SYSTEM_BASENAME=$(basename "${system:-none}")
PROMPT_BASENAME=$(basename "${prompt}")
TXT
""",
        encoding="utf-8",
    )
    path.chmod(0o755)


@contextlib.contextmanager
def _temp_env(**updates: str):
    old = {}
    for k, v in updates.items():
        old[k] = os.environ.get(k)
        os.environ[k] = v
    try:
        yield
    finally:
        for k, v in old.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v


def _run_main_with_argv(mod, argv: list[str]) -> int:
    import sys as _sys

    old_argv = _sys.argv
    try:
        _sys.argv = argv
        return mod.main()
    finally:
        _sys.argv = old_argv


class MultiTaskTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.mod = _load_run_multi_task_module()

    def test_prompt_guard_bytes_over_limit_truncate_records_audit_fields(self):
        with tempfile.TemporaryDirectory() as td:
            td_path = Path(td)
            src = td_path / "prompt.txt"

            # 9 ASCII bytes + 1 byte of a 4-byte emoji => truncation drops invalid boundary byte.
            src_bytes = ("A" * 9 + "😀" + "Z" * 5).encode("utf-8")
            src.write_bytes(src_bytes)

            trace = td_path / "trace.jsonl"
            out_dir = td_path / "inputs"

            out = self.mod._apply_prompt_limit(
                src,
                label="test",
                out_dir=out_dir,
                trace_path=trace,
                max_bytes=10,
                max_chars=None,
                overflow="truncate",
            )

            self.assertNotEqual(out, src)
            self.assertTrue(out.exists())
            self.assertLessEqual(out.stat().st_size, 10)

            events = _read_trace_events(trace)
            self.assertEqual(events[-1]["event"], "prompt_guard_truncate")
            self.assertEqual(events[-1]["action"], "truncate")
            self.assertIn("source_prefix_bytes", events[-1])
            self.assertIn("source_prefix_sha256", events[-1])
            self.assertIn("dropped_invalid_utf8_bytes", events[-1])

            raw_prefix = src_bytes[:10]
            self.assertEqual(events[-1]["source_prefix_bytes"], 10)
            self.assertEqual(events[-1]["source_prefix_sha256"], sha256(raw_prefix).hexdigest())
            self.assertEqual(events[-1]["dropped_invalid_utf8_bytes"], 1)
            self.assertEqual(events[-1]["truncated_sha256"], sha256(out.read_bytes()).hexdigest())

    def test_invalid_max_prompt_bytes_is_input_error(self):
        with tempfile.TemporaryDirectory() as td:
            td_path = Path(td)
            out_dir = td_path / "out"
            trace = out_dir / "trace.jsonl"
            sys_prompt = td_path / "system.md"
            user_prompt = td_path / "prompt.md"
            runner = td_path / "run_opencode.sh"
            _write_stub_runner(runner)
            sys_prompt.write_text("SYSTEM\n", encoding="utf-8")
            user_prompt.write_text("USER\n", encoding="utf-8")

            argv = [
                "run_multi_task.py",
                "--out-dir",
                str(out_dir),
                "--opencode-runner",
                str(runner),
                "--system",
                str(sys_prompt),
                "--prompt",
                str(user_prompt),
                "--model",
                "default",
                "--max-prompt-bytes",
                "0",
            ]
            code = _run_main_with_argv(self.mod, argv)
            self.assertEqual(code, 2)
            events = _read_trace_events(trace)
            self.assertTrue(any(e.get("event") == "input_error" for e in events))

    def test_no_parallel_flag_disables_parallel_execution(self):
        with tempfile.TemporaryDirectory() as td:
            td_path = Path(td)
            out_dir = td_path / "out"
            trace = out_dir / "trace.jsonl"
            sys_prompt = td_path / "system.md"
            user_prompt = td_path / "prompt.md"
            runner = td_path / "run_opencode.sh"
            _write_stub_runner(runner)
            sys_prompt.write_text("SYSTEM\n", encoding="utf-8")
            user_prompt.write_text("USER\n", encoding="utf-8")

            argv = [
                "run_multi_task.py",
                "--out-dir",
                str(out_dir),
                "--opencode-runner",
                str(runner),
                "--system",
                str(sys_prompt),
                "--prompt",
                str(user_prompt),
                "--models",
                "minimax/MiniMax-M2.5,qwen-cp/qwen3-coder-plus",
                "--no-parallel",
            ]
            code = _run_main_with_argv(self.mod, argv)
            self.assertEqual(code, 0)

            events = _read_trace_events(trace)
            config_events = [e for e in events if e.get("event") == "config"]
            self.assertTrue(config_events)
            self.assertFalse(config_events[-1]["parallel"])

    def test_missing_codex_runner_is_detected_before_execution(self):
        with tempfile.TemporaryDirectory() as td:
            td_path = Path(td)
            out_dir = td_path / "out"
            trace = out_dir / "trace.jsonl"
            sys_prompt = td_path / "system.md"
            user_prompt = td_path / "prompt.md"
            opencode_runner = td_path / "run_opencode.sh"
            _write_stub_runner(opencode_runner)
            sys_prompt.write_text("SYSTEM\n", encoding="utf-8")
            user_prompt.write_text("USER\n", encoding="utf-8")

            fake_codex_home = td_path / ".codex"
            fake_codex_home.mkdir(parents=True, exist_ok=True)

            argv = [
                "run_multi_task.py",
                "--out-dir",
                str(out_dir),
                "--opencode-runner",
                str(opencode_runner),
                "--system",
                str(sys_prompt),
                "--prompt",
                str(user_prompt),
                "--models",
                "codex/gpt-5",
            ]
            with _temp_env(CODEX_HOME=str(fake_codex_home)):
                code = _run_main_with_argv(self.mod, argv)

            self.assertEqual(code, 2)
            events = _read_trace_events(trace)
            input_errors = [e for e in events if e.get("event") == "input_error"]
            self.assertTrue(input_errors)
            self.assertIn("Codex runner", input_errors[-1].get("error", ""))

    def test_missing_claude_runner_is_detected_before_execution(self):
        with tempfile.TemporaryDirectory() as td:
            td_path = Path(td)
            out_dir = td_path / "out"
            trace = out_dir / "trace.jsonl"
            sys_prompt = td_path / "system.md"
            user_prompt = td_path / "prompt.md"
            opencode_runner = td_path / "run_opencode.sh"
            _write_stub_runner(opencode_runner)
            sys_prompt.write_text("SYSTEM\n", encoding="utf-8")
            user_prompt.write_text("USER\n", encoding="utf-8")

            fake_codex_home = td_path / ".codex"
            fake_codex_home.mkdir(parents=True, exist_ok=True)

            argv = [
                "run_multi_task.py",
                "--out-dir",
                str(out_dir),
                "--opencode-runner",
                str(opencode_runner),
                "--system",
                str(sys_prompt),
                "--prompt",
                str(user_prompt),
                "--models",
                "claude/default",
            ]
            with _temp_env(CODEX_HOME=str(fake_codex_home)):
                code = _run_main_with_argv(self.mod, argv)

            self.assertEqual(code, 2)
            events = _read_trace_events(trace)
            input_errors = [e for e in events if e.get("event") == "input_error"]
            self.assertTrue(input_errors)
            self.assertIn("Claude runner", input_errors[-1].get("error", ""))

    def test_agents_without_opencode_config_use_default_sentinel(self):
        with tempfile.TemporaryDirectory() as td:
            td_path = Path(td)
            out_dir = td_path / "out"
            sys_prompt = td_path / "system.md"
            user_prompt = td_path / "prompt.md"
            runner = td_path / "run_opencode.sh"
            _write_stub_runner(runner)
            sys_prompt.write_text("SYSTEM\n", encoding="utf-8")
            user_prompt.write_text("USER\n", encoding="utf-8")

            fake_home = td_path / "home"
            fake_home.mkdir(parents=True, exist_ok=True)

            argv = [
                "run_multi_task.py",
                "--out-dir",
                str(out_dir),
                "--opencode-runner",
                str(runner),
                "--system",
                str(sys_prompt),
                "--prompt",
                str(user_prompt),
                "--agents",
                "2",
                "--no-parallel",
            ]
            with _temp_env(HOME=str(fake_home)):
                code = _run_main_with_argv(self.mod, argv)

            self.assertEqual(code, 0)
            meta = json.loads((out_dir / "meta.json").read_text(encoding="utf-8"))
            self.assertEqual(meta.get("models"), ["default", "default"])

    def test_backend_prompt_system_output_overrides_apply(self):
        with tempfile.TemporaryDirectory() as td:
            td_path = Path(td)
            out_dir = td_path / "out"
            sys_prompt = td_path / "system.md"
            user_prompt = td_path / "prompt.md"
            gemini_prompt = td_path / "gemini_prompt.txt"
            claude_runner = td_path / "run_claude.sh"
            gemini_runner = td_path / "run_gemini.sh"
            opencode_runner = td_path / "run_opencode.sh"
            codex_runner = td_path / "run_codex.sh"

            _write_stub_runner_records_inputs(claude_runner)
            _write_stub_runner_records_inputs(gemini_runner)
            _write_stub_runner(opencode_runner)
            _write_stub_runner(codex_runner)
            sys_prompt.write_text("SYSTEM\n", encoding="utf-8")
            user_prompt.write_text("GLOBAL PROMPT\n", encoding="utf-8")
            gemini_prompt.write_text("GEMINI PROMPT\n", encoding="utf-8")

            argv = [
                "run_multi_task.py",
                "--out-dir",
                str(out_dir),
                "--opencode-runner",
                str(opencode_runner),
                "--claude-runner",
                str(claude_runner),
                "--gemini-runner",
                str(gemini_runner),
                "--codex-runner",
                str(codex_runner),
                "--system",
                str(sys_prompt),
                "--prompt",
                str(user_prompt),
                "--models",
                "claude/default,gemini/default",
                "--backend-prompt",
                f"gemini={gemini_prompt}",
                "--backend-system",
                "gemini=none",
                "--backend-output",
                "claude=claude_output.md",
                "--backend-output",
                "gemini=gemini_output.md",
                "--no-parallel",
            ]
            code = _run_main_with_argv(self.mod, argv)
            self.assertEqual(code, 0)

            claude_out = out_dir / "claude_output.md"
            gemini_out = out_dir / "gemini_output.md"
            self.assertTrue(claude_out.exists())
            self.assertTrue(gemini_out.exists())

            claude_text = claude_out.read_text(encoding="utf-8")
            gemini_text = gemini_out.read_text(encoding="utf-8")
            self.assertIn("HAS_SYSTEM=1", claude_text)
            self.assertIn("PROMPT_BASENAME=prompt.md", claude_text)
            self.assertIn("HAS_SYSTEM=0", gemini_text)
            self.assertIn("PROMPT_BASENAME=gemini_prompt.txt", gemini_text)

    def test_backend_prompt_json_batch_overrides_apply(self):
        with tempfile.TemporaryDirectory() as td:
            td_path = Path(td)
            out_dir = td_path / "out"
            sys_prompt = td_path / "system.md"
            user_prompt = td_path / "prompt.md"
            gemini_prompt = td_path / "gemini_prompt.txt"
            claude_runner = td_path / "run_claude.sh"
            gemini_runner = td_path / "run_gemini.sh"
            opencode_runner = td_path / "run_opencode.sh"
            codex_runner = td_path / "run_codex.sh"
            overrides_json = td_path / "overrides.json"

            _write_stub_runner_records_inputs(claude_runner)
            _write_stub_runner_records_inputs(gemini_runner)
            _write_stub_runner(opencode_runner)
            _write_stub_runner(codex_runner)
            sys_prompt.write_text("SYSTEM\n", encoding="utf-8")
            user_prompt.write_text("GLOBAL PROMPT\n", encoding="utf-8")
            gemini_prompt.write_text("GEMINI PROMPT\n", encoding="utf-8")
            overrides_json.write_text(
                json.dumps(
                    {
                        "prompt": {"gemini": str(gemini_prompt)},
                        "system": {"gemini": None},
                        "output": {"claude": "claude_from_json.md", "gemini": "gemini_from_json.md"},
                    }
                ),
                encoding="utf-8",
            )

            argv = [
                "run_multi_task.py",
                "--out-dir",
                str(out_dir),
                "--opencode-runner",
                str(opencode_runner),
                "--claude-runner",
                str(claude_runner),
                "--gemini-runner",
                str(gemini_runner),
                "--codex-runner",
                str(codex_runner),
                "--system",
                str(sys_prompt),
                "--prompt",
                str(user_prompt),
                "--models",
                "claude/default,gemini/default",
                "--backend-prompt",
                f"@{overrides_json}",
                "--no-parallel",
            ]
            code = _run_main_with_argv(self.mod, argv)
            self.assertEqual(code, 0)

            claude_out = out_dir / "claude_from_json.md"
            gemini_out = out_dir / "gemini_from_json.md"
            self.assertTrue(claude_out.exists())
            self.assertTrue(gemini_out.exists())

            claude_text = claude_out.read_text(encoding="utf-8")
            gemini_text = gemini_out.read_text(encoding="utf-8")
            self.assertIn("HAS_SYSTEM=1", claude_text)
            self.assertIn("PROMPT_BASENAME=prompt.md", claude_text)
            self.assertIn("HAS_SYSTEM=0", gemini_text)
            self.assertIn("PROMPT_BASENAME=gemini_prompt.txt", gemini_text)

    def test_backend_prompt_json_shorthand_prompt_mapping_apply(self):
        with tempfile.TemporaryDirectory() as td:
            td_path = Path(td)
            out_dir = td_path / "out"
            sys_prompt = td_path / "system.md"
            user_prompt = td_path / "prompt.md"
            gemini_prompt = td_path / "gemini_prompt.txt"
            gemini_runner = td_path / "run_gemini.sh"
            opencode_runner = td_path / "run_opencode.sh"
            overrides_json = td_path / "prompts_only.json"

            _write_stub_runner_records_inputs(gemini_runner)
            _write_stub_runner(opencode_runner)
            sys_prompt.write_text("SYSTEM\n", encoding="utf-8")
            user_prompt.write_text("GLOBAL PROMPT\n", encoding="utf-8")
            gemini_prompt.write_text("GEMINI PROMPT\n", encoding="utf-8")
            overrides_json.write_text(
                json.dumps({"gemini": str(gemini_prompt)}),
                encoding="utf-8",
            )

            argv = [
                "run_multi_task.py",
                "--out-dir",
                str(out_dir),
                "--opencode-runner",
                str(opencode_runner),
                "--gemini-runner",
                str(gemini_runner),
                "--system",
                str(sys_prompt),
                "--prompt",
                str(user_prompt),
                "--models",
                "gemini/default",
                "--backend-prompt",
                f"@{overrides_json}",
                "--no-parallel",
            ]
            code = _run_main_with_argv(self.mod, argv)
            self.assertEqual(code, 0)
            meta = json.loads((out_dir / "meta.json").read_text(encoding="utf-8"))
            out_path = Path(meta["agents"][0]["out"])
            txt = out_path.read_text(encoding="utf-8")
            self.assertIn("HAS_SYSTEM=1", txt)
            self.assertIn("PROMPT_BASENAME=gemini_prompt.txt", txt)

    def test_backend_output_override_rejects_repeated_backend(self):
        with tempfile.TemporaryDirectory() as td:
            td_path = Path(td)
            out_dir = td_path / "out"
            sys_prompt = td_path / "system.md"
            user_prompt = td_path / "prompt.md"
            gemini_runner = td_path / "run_gemini.sh"
            opencode_runner = td_path / "run_opencode.sh"

            _write_stub_runner_records_inputs(gemini_runner)
            _write_stub_runner(opencode_runner)
            sys_prompt.write_text("SYSTEM\n", encoding="utf-8")
            user_prompt.write_text("PROMPT\n", encoding="utf-8")

            argv = [
                "run_multi_task.py",
                "--out-dir",
                str(out_dir),
                "--opencode-runner",
                str(opencode_runner),
                "--gemini-runner",
                str(gemini_runner),
                "--system",
                str(sys_prompt),
                "--prompt",
                str(user_prompt),
                "--models",
                "gemini/default,gemini/default",
                "--backend-output",
                "gemini=gemini_output.md",
                "--no-parallel",
            ]
            code = _run_main_with_argv(self.mod, argv)
            self.assertEqual(code, 2)
            trace = _read_trace_events(out_dir / "trace.jsonl")
            input_errors = [e for e in trace if e.get("event") == "input_error"]
            self.assertTrue(input_errors)
            self.assertIn("repeated backend", input_errors[-1].get("error", ""))

    def test_codex_default_does_not_pass_model_arg(self):
        with tempfile.TemporaryDirectory() as td:
            td_path = Path(td)
            out_dir = td_path / "out"
            sys_prompt = td_path / "system.md"
            user_prompt = td_path / "prompt.md"
            opencode_runner = td_path / "run_opencode.sh"
            _write_stub_runner(opencode_runner)
            sys_prompt.write_text("SYSTEM\n", encoding="utf-8")
            user_prompt.write_text("USER\n", encoding="utf-8")

            fake_codex_home = td_path / ".codex"
            codex_runner = fake_codex_home / "skills" / "codex-cli-runner" / "scripts" / "run_codex.sh"
            codex_runner.parent.mkdir(parents=True, exist_ok=True)
            codex_runner.write_text(
                """#!/usr/bin/env bash
set -euo pipefail
out=""
has_model=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --out) out="$2"; shift 2 ;;
    --model) has_model=1; shift 2 ;;
    *) shift ;;
  esac
done
if [[ "${has_model}" -ne 0 ]]; then
  echo "unexpected --model for codex/default" >&2
  exit 11
fi
cat >"${out}" <<'TXT'
OK
TXT
""",
                encoding="utf-8",
            )
            codex_runner.chmod(0o755)

            argv = [
                "run_multi_task.py",
                "--out-dir",
                str(out_dir),
                "--opencode-runner",
                str(opencode_runner),
                "--system",
                str(sys_prompt),
                "--prompt",
                str(user_prompt),
                "--models",
                "codex/default",
                "--no-parallel",
            ]
            with _temp_env(CODEX_HOME=str(fake_codex_home)):
                code = _run_main_with_argv(self.mod, argv)

            self.assertEqual(code, 0)
            meta = json.loads((out_dir / "meta.json").read_text(encoding="utf-8"))
            self.assertEqual(meta["success_count"], 1)


if __name__ == "__main__":
    unittest.main()
