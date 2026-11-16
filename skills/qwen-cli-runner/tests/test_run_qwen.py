from __future__ import annotations

import os
import json
import signal
import subprocess
import time
from pathlib import Path

import pytest


SKILL_DIR = Path(__file__).resolve().parents[1]
RUNNER = SKILL_DIR / "scripts" / "run_qwen.sh"


def _write_fake_qwen(bin_dir: Path) -> Path:
    fake = bin_dir / "qwen"
    fake.write_text(
        """#!/usr/bin/env bash
set -euo pipefail

if [[ "${1:-}" == "--version" ]]; then echo "0.10.0"; exit 0; fi
mode="${FAKE_MODE:-success}"
log_file="${FAKE_LOG:-}"
state_file="${FAKE_STATE:-}"
model=""
output_format=""
approval_mode=""
system_prompt=""
resume=""
include_dirs=()
extensions_disabled=0
safe_mode=0
original_args=("$@")

while [[ $# -gt 0 ]]; do
  case "$1" in
    -m|--model)
      model="${2:-}"
      shift 2
      ;;
    -o|--output-format)
      output_format="${2:-}"
      shift 2
      ;;
    --approval-mode)
      approval_mode="${2:-}"
      shift 2
      ;;
    --system-prompt)
      system_prompt="${2:-}"
      shift 2
      ;;
    --include-directories)
      include_dirs+=("${2:-}")
      shift 2
      ;;
    -e|--extensions)
      if [[ "${2:-}" == "none" ]]; then
        extensions_disabled=1
      fi
      shift 2
      ;;
    --safe-mode)
      safe_mode=1
      extensions_disabled=1
      shift
      ;;
    -r|--resume)
      resume="${2:-}"
      shift 2
      ;;
    *)
      shift
      ;;
  esac
done

stdin_text="$(cat)"

if [[ -n "${log_file}" ]]; then
  {
    printf 'cwd=%s\\n' "$(pwd)"
    printf 'args='
    printf '%q ' "${original_args[@]}"
    printf '\\n'
    printf 'stdin=%s\\n' "${stdin_text}"
    printf 'model=%s approval=%s format=%s ext_disabled=%s include_count=%s resume=%s safe=%s\\n' \\
      "${model}" "${approval_mode}" "${output_format}" "${extensions_disabled}" "${#include_dirs[@]}" "${resume}" "${safe_mode}"
  } >>"${log_file}"
fi

emit_array() {
  python3 - "$@" <<'PY'
import json
import sys
messages = [json.loads(arg) for arg in sys.argv[1:]]
print(json.dumps(messages, ensure_ascii=False))
PY
}

result_ok() {
  printf '{"type":"result","subtype":"success","is_error":false,"session_id":"s-1","result":%s}' \\
    "$(python3 -c 'import json,sys; print(json.dumps(sys.argv[1]))' "$1")"
}

case "${mode}" in
  echo_stdin)
    emit_array "$(result_ok "${stdin_text}")"
    ;;
  echo_system)
    emit_array "$(result_ok "${system_prompt}")"
    ;;
  with_assistant_events)
    emit_array \\
      '{"type":"system","subtype":"init","session_id":"s-1"}' \\
      '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"IGNORED_EARLIER"}]}}' \\
      '{"type":"user","message":{"role":"user","content":[{"type":"tool_result","content":"ignored"}]}}' \\
      "$(result_ok "FINAL_TEXT")"
    ;;
  blank_result_with_assistant)
    emit_array \\
      '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"FALLBACK_ASSISTANT"}]}}' \\
      "$(result_ok "")"
    ;;
  empty_result)
    emit_array "$(result_ok "")"
    ;;
  error_result)
    emit_array '{"type":"result","subtype":"error_during_execution","is_error":true,"error":{"message":"provider exploded"}}'
    ;;
  unknown_format)
    echo '{"type":"new-output-envelope"}'
    ;;
  unknown_option)
    echo "Unknown argument: safe-mode" >&2; exit 2
    ;;
  no_result)
    emit_array '{"type":"system","subtype":"init","session_id":"s-1"}'
    ;;
  not_json)
    echo "this is not json"
    ;;
  jsonl_instead_of_array)
    echo '{"type":"system","subtype":"init"}'
    echo "$(result_ok "JSONL_TEXT")"
    ;;
  sleep_then_success)
    sleep "${FAKE_SLEEP_SECS:-5}"
    emit_array "$(result_ok "OK_AFTER_SLEEP")"
    ;;
  fail_once_then_success)
    if [[ -n "${state_file}" && ! -f "${state_file}" ]]; then
      printf 'failed\\n' >"${state_file}"
      echo "transient failure" >&2
      exit 8
    fi
    emit_array "$(result_ok "OK_RETRY")"
    ;;
  tool_activity_then_disconnect)
    # Batch array never closed: the run executed a tool, emitted assistant
    # text, then the connection dropped before the result message.
    printf '[{"type":"system","subtype":"init","session_id":"s-tool"},'
    printf '{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"t1","name":"write_file","input":{}}]}},'
    printf '{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"t1","content":"written"}]}},'
    printf '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"PARTIAL_AFTER_TOOL"}]}}'
    echo "connection reset by peer" >&2
    exit 1
    ;;
  tool_activity_jsonl_then_disconnect)
    echo '{"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"t1","name":"run_shell","input":{}}]}}'
    echo '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"PARTIAL_JSONL"}]}}'
    echo "connection reset by peer" >&2
    exit 1
    ;;
  tool_activity_error_result_zero_exit)
    python3 - <<'PY'
import json
import os

print(json.dumps([
    {"type": "assistant", "message": {"role": "assistant", "content": [
        {"type": "tool_use", "id": "t1", "name": "write_file", "input": {}}
    ]}},
    {"type": "user", "message": {"role": "user", "content": [
        {"type": "tool_result", "tool_use_id": "t1", "content": "written"}
    ]}},
    {"type": "assistant", "message": {"role": "assistant", "content": [
        {"type": "text", "text": "PARTIAL_BEFORE_ERROR_RESULT"}
    ]}},
    {"type": "result", "subtype": "error_during_execution", "is_error": True,
     "error": {"message": os.environ["FAKE_TOOL_ERROR"]}},
]))
PY
    ;;
  text_only_disconnect)
    printf '[{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"PARTIAL_NO_TOOL"}]}}'
    echo "connection reset by peer" >&2
    exit 1
    ;;
  model_not_found)
    if [[ -n "${model}" ]]; then
      echo "Model not found: ${model}" >&2
      exit 7
    fi
    emit_array "$(result_ok "OK_FALLBACK")"
    ;;
  deterministic_stderr_diagnostic)
    echo "Error: invalid api key" >&2
    exit 1
    ;;
  connection_reset_once_then_success)
    if [[ -n "${state_file}" && ! -f "${state_file}" ]]; then
      printf 'failed\\n' >"${state_file}"
      echo "fetch failed: connection reset by peer" >&2
      exit 1
    fi
    emit_array "$(result_ok "OK_AFTER_RESET")"
    ;;
  quota_error)
    emit_array '{"type":"result","subtype":"error_during_execution","is_error":true,"error":{"message":"You have reached your usage limit for this billing cycle."}}'
    ;;
  quota_quote_in_body)
    emit_array "$(result_ok "Documentation says: reached your usage limit for this billing cycle. A network error can also be transient.")"
    ;;
  emit_metadata)
    python3 - "${model}" "${approval_mode}" "${output_format}" "${extensions_disabled}" "${#include_dirs[@]}" "${resume}" "${safe_mode}" <<'PY'
import json
import sys
payload = {
    "model": sys.argv[1],
    "approval_mode": sys.argv[2],
    "output_format": sys.argv[3],
    "extensions_disabled": sys.argv[4] == "1",
    "include_dir_count": int(sys.argv[5]),
    "resume": sys.argv[6],
    "safe_mode": sys.argv[7] == "1",
}
print(json.dumps([{"type": "result", "subtype": "success", "is_error": False,
                   "result": json.dumps(payload, sort_keys=True)}], ensure_ascii=False))
PY
    ;;
  *)
    emit_array "$(result_ok "OK_DEFAULT")"
    ;;
esac
""",
        encoding="utf-8",
    )
    fake.chmod(0o755)
    return fake


def _run_runner(
    tmp_path: Path,
    *,
    args: list[str],
    fake_mode: str = "success",
    prompt_text: str = "hello\n",
    system_text: str | None = None,
    extra_env: dict[str, str] | None = None,
) -> tuple[subprocess.CompletedProcess[str], Path, Path]:
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir(parents=True, exist_ok=True)
    _write_fake_qwen(bin_dir)

    prompt = tmp_path / "prompt.txt"
    prompt.write_text(prompt_text, encoding="utf-8")
    out = tmp_path / "out.txt"
    system = tmp_path / "system.txt"
    log = tmp_path / "fake_qwen.log"

    env = os.environ.copy()
    env["PATH"] = f"{bin_dir}:{env.get('PATH', '')}"
    env["FAKE_MODE"] = fake_mode
    env["FAKE_LOG"] = str(log)
    env["FAKE_STATE"] = str(tmp_path / "fake_state")
    if extra_env:
        env.update(extra_env)

    cmd = [
        "bash",
        str(RUNNER),
        "--prompt-file",
        str(prompt),
        "--out",
        str(out),
        "--max-attempts",
        "1",
    ]
    if system_text is not None:
        system.write_text(system_text, encoding="utf-8")
        cmd.extend(["--system-prompt-file", str(system)])
    cmd.extend(args)
    proc = subprocess.run(
        cmd,
        text=True,
        capture_output=True,
        env=env,
        cwd=tmp_path,
        check=False,
    )
    return proc, out, log


def _out_text(out_path: Path) -> str:
    if not out_path.exists():
        return ""
    return out_path.read_text(encoding="utf-8")


def _log_text(log_path: Path) -> str:
    if not log_path.exists():
        return ""
    return log_path.read_text(encoding="utf-8")


def test_default_dry_run_is_isolated_plan_with_extensions_disabled(tmp_path: Path) -> None:
    proc, out_path, _ = _run_runner(
        tmp_path,
        args=["--dry-run", "--model", "qwen3-coder-plus"],
    )
    assert proc.returncode == 0, proc.stderr
    assert "Tool mode: isolated" in proc.stdout
    assert "Approval mode: plan" in proc.stdout
    assert "Work dir: (temporary isolated directory)" in proc.stdout
    assert "Workspace dirs: (none)" in proc.stdout
    assert "Safe mode: on" in proc.stdout
    assert "Extensions: disabled (--safe-mode)" in proc.stdout
    assert "--safe-mode" in proc.stdout
    assert "Timeout: 900s total invocation deadline" in proc.stdout
    assert "-o json" in proc.stdout
    assert "--include-directories" not in proc.stdout
    assert "--yolo" not in proc.stdout
    assert _out_text(out_path) == ""


def test_default_model_is_qwen4_max_preview(tmp_path: Path) -> None:
    proc, out_path, log_path = _run_runner(tmp_path, args=[], fake_mode="emit_metadata")
    assert proc.returncode == 0, proc.stderr
    assert '"model": "qwen4-max-preview"' in _out_text(out_path)
    assert "-m qwen4-max-preview" in _log_text(log_path)


def test_explicit_model_overrides_default(tmp_path: Path) -> None:
    proc, out_path, _ = _run_runner(
        tmp_path,
        args=["--model", "other-alias"],
        fake_mode="emit_metadata",
    )
    assert proc.returncode == 0, proc.stderr
    assert '"model": "other-alias"' in _out_text(out_path)


def test_default_run_uses_isolated_workdir_and_feeds_prompt_via_stdin(tmp_path: Path) -> None:
    proc, out_path, log_path = _run_runner(tmp_path, args=[], fake_mode="echo_stdin")
    assert proc.returncode == 0, proc.stderr
    assert _out_text(out_path) == "hello\n"
    log = _log_text(log_path)
    assert f"cwd={tmp_path}" not in log
    assert "stdin=hello" in log
    assert "approval=plan" in log
    assert "ext_disabled=1" in log
    assert "include_count=0" in log
    assert "safe=1" in log


def test_system_prompt_file_goes_through_system_prompt_flag(tmp_path: Path) -> None:
    proc, out_path, log_path = _run_runner(
        tmp_path,
        args=[],
        fake_mode="echo_system",
        system_text="SYSTEM RULES\n",
    )
    assert proc.returncode == 0, proc.stderr
    assert _out_text(out_path) == "SYSTEM RULES\n"
    assert "--system-prompt" in _log_text(log_path)


def test_workspace_mode_passes_include_directories_and_default_approval(tmp_path: Path) -> None:
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    proc, out_path, log_path = _run_runner(
        tmp_path,
        args=["--tool-mode", "workspace", "--workspace-dir", str(workspace)],
        fake_mode="emit_metadata",
    )
    assert proc.returncode == 0, proc.stderr
    assert '"include_dir_count": 1' in _out_text(out_path)
    assert '"approval_mode": "default"' in _out_text(out_path)
    assert '"safe_mode": false' in _out_text(out_path)
    assert '"extensions_disabled": true' in _out_text(out_path)
    log = _log_text(log_path)
    assert f"cwd={tmp_path}" not in log
    assert str(workspace) in log
    assert "--safe-mode" not in log


def test_rejects_workspace_dir_without_workspace_mode(tmp_path: Path) -> None:
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    proc, _, _ = _run_runner(tmp_path, args=["--workspace-dir", str(workspace)])
    assert proc.returncode == 2
    assert "requires --tool-mode workspace" in proc.stderr


def test_allow_extensions_omits_none_sentinel_in_workspace_mode(tmp_path: Path) -> None:
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    proc, out_path, _ = _run_runner(
        tmp_path,
        args=["--tool-mode", "workspace", "--workspace-dir", str(workspace), "--allow-extensions"],
        fake_mode="emit_metadata",
    )
    assert proc.returncode == 0, proc.stderr
    assert '"extensions_disabled": false' in _out_text(out_path)
    assert '"safe_mode": false' in _out_text(out_path)


def test_no_safe_mode_falls_back_to_none_sentinel(tmp_path: Path) -> None:
    proc, out_path, log_path = _run_runner(
        tmp_path,
        args=["--no-safe-mode"],
        fake_mode="emit_metadata",
    )
    assert proc.returncode == 0, proc.stderr
    assert '"safe_mode": false' in _out_text(out_path)
    assert '"extensions_disabled": true' in _out_text(out_path)
    assert "--safe-mode" not in _log_text(log_path)


def test_no_safe_mode_rejected_in_workspace_mode(tmp_path: Path) -> None:
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    proc, out_path, _ = _run_runner(
        tmp_path,
        args=["--tool-mode", "workspace", "--workspace-dir", str(workspace), "--no-safe-mode"],
    )
    assert proc.returncode == 2
    assert "only applies to --tool-mode isolated" in proc.stderr
    assert _out_text(out_path) == ""


def test_auto_approval_mode_accepted_as_explicit_override(tmp_path: Path) -> None:
    proc, out_path, _ = _run_runner(
        tmp_path,
        args=["--approval-mode", "auto"],
        fake_mode="emit_metadata",
    )
    assert proc.returncode == 0, proc.stderr
    assert '"approval_mode": "auto"' in _out_text(out_path)


def test_result_message_is_authoritative_over_earlier_assistant_events(tmp_path: Path) -> None:
    proc, out_path, _ = _run_runner(tmp_path, args=[], fake_mode="with_assistant_events")
    assert proc.returncode == 0, proc.stderr
    assert _out_text(out_path) == "FINAL_TEXT\n"


def test_blank_result_falls_back_to_assistant_text(tmp_path: Path) -> None:
    proc, out_path, _ = _run_runner(tmp_path, args=[], fake_mode="blank_result_with_assistant")
    assert proc.returncode == 0, proc.stderr
    assert _out_text(out_path) == "FALLBACK_ASSISTANT\n"


def test_empty_result_is_not_completed_output(tmp_path: Path) -> None:
    proc, out_path, _ = _run_runner(tmp_path, args=[], fake_mode="empty_result")
    assert proc.returncode == 12
    assert _out_text(out_path) == ""


def test_error_result_fails_even_with_zero_exit(tmp_path: Path) -> None:
    proc, out_path, _ = _run_runner(tmp_path, args=[], fake_mode="error_result")
    assert proc.returncode == 11
    assert "provider exploded" in proc.stderr
    assert _out_text(out_path) == ""


def test_missing_result_message_is_deterministic_parse_failure(tmp_path: Path) -> None:
    proc, out_path, log_path = _run_runner(
        tmp_path,
        args=["--max-attempts", "2", "--sleep-secs", "1"],
        fake_mode="no_result",
    )
    assert proc.returncode == 13
    assert "not retrying identical output" in proc.stderr
    assert _log_text(log_path).count("args=") == 1
    assert _out_text(out_path) == ""


def test_non_json_stdout_is_deterministic_parse_failure(tmp_path: Path) -> None:
    proc, out_path, log_path = _run_runner(
        tmp_path,
        args=["--max-attempts", "2", "--sleep-secs", "1"],
        fake_mode="not_json",
    )
    assert proc.returncode == 13
    assert _log_text(log_path).count("args=") == 1
    assert _out_text(out_path) == ""


def test_jsonl_output_is_rejected_not_silently_accepted(tmp_path: Path) -> None:
    proc, out_path, _ = _run_runner(tmp_path, args=[], fake_mode="jsonl_instead_of_array")
    assert proc.returncode == 13
    assert _out_text(out_path) == ""


def test_retries_within_run_mode_then_succeeds(tmp_path: Path) -> None:
    proc, out_path, _ = _run_runner(
        tmp_path,
        args=["--max-attempts", "2", "--sleep-secs", "1"],
        fake_mode="fail_once_then_success",
    )
    assert proc.returncode == 0, proc.stderr
    assert "Attempt 1 failed in requested-model mode" in proc.stderr
    assert _out_text(out_path) == "OK_RETRY\n"


def test_timeout_kills_hung_attempt(tmp_path: Path) -> None:
    proc, out_path, _ = _run_runner(
        tmp_path,
        args=["--timeout-secs", "1"],
        fake_mode="sleep_then_success",
        extra_env={"FAKE_SLEEP_SECS": "5"},
    )
    assert proc.returncode == 124
    assert "total deadline" in proc.stderr
    assert _out_text(out_path) == ""


def test_timeout_can_preserve_raw_stdout_and_stderr(tmp_path: Path) -> None:
    raw_out = tmp_path / "raw.json"
    stderr_out = tmp_path / "raw.stderr"
    proc, out_path, _ = _run_runner(
        tmp_path,
        args=[
            "--timeout-secs", "1",
            "--raw-out", str(raw_out),
            "--stderr-out", str(stderr_out),
        ],
        fake_mode="sleep_then_success",
        extra_env={"FAKE_SLEEP_SECS": "5"},
    )
    assert proc.returncode == 124
    assert _out_text(out_path) == ""
    assert "total deadline" in stderr_out.read_text(encoding="utf-8")


def test_falls_back_to_default_model_on_model_not_found(tmp_path: Path) -> None:
    proc, out_path, _ = _run_runner(
        tmp_path,
        args=["--model", "missing-model", "--max-attempts", "2"],
        fake_mode="model_not_found",
    )
    assert proc.returncode == 0, proc.stderr
    assert _out_text(out_path) == "OK_FALLBACK\n"
    assert "retrying with CLI default model" in proc.stderr


def test_no_fallback_fails_on_model_not_found(tmp_path: Path) -> None:
    proc, out_path, _ = _run_runner(
        tmp_path,
        args=["--model", "missing-model", "--no-fallback"],
        fake_mode="model_not_found",
    )
    assert proc.returncode != 0
    assert _out_text(out_path) == ""


def test_resume_session_passes_explicit_session_id(tmp_path: Path) -> None:
    work = tmp_path / "work"
    work.mkdir()
    proc, out_path, _ = _run_runner(
        tmp_path,
        args=["--resume-session", "abc-123", "--work-dir", str(work)],
        fake_mode="emit_metadata",
    )
    assert proc.returncode == 0, proc.stderr
    assert '"resume": "abc-123"' in _out_text(out_path)


def test_resume_session_requires_work_dir(tmp_path: Path) -> None:
    proc, out_path, _ = _run_runner(
        tmp_path,
        args=["--resume-session", "abc-123"],
        fake_mode="emit_metadata",
    )
    assert proc.returncode == 2
    assert "--resume-session requires --work-dir" in proc.stderr
    assert _out_text(out_path) == ""


def test_tool_activity_failure_is_not_redispatched_and_keeps_partial(tmp_path: Path) -> None:
    proc, out_path, log_path = _run_runner(
        tmp_path,
        args=["--max-attempts", "3", "--sleep-secs", "1"],
        fake_mode="tool_activity_then_disconnect",
    )
    assert proc.returncode == 1
    assert _log_text(log_path).count("args=") == 1, "must not re-dispatch after recorded tool activity"
    assert "recorded tool activity" in proc.stderr
    assert not out_path.exists()
    partial = Path(str(out_path) + ".partial")
    assert partial.exists()
    assert "PARTIAL_AFTER_TOOL" in partial.read_text(encoding="utf-8")
    assert "tool_activity:" not in partial.read_text(encoding="utf-8")


def test_tool_activity_in_jsonl_salvage_also_stops_redispatch(tmp_path: Path) -> None:
    proc, out_path, log_path = _run_runner(
        tmp_path,
        args=["--max-attempts", "3", "--sleep-secs", "1"],
        fake_mode="tool_activity_jsonl_then_disconnect",
    )
    assert proc.returncode == 1
    assert _log_text(log_path).count("args=") == 1
    assert "recorded tool activity" in proc.stderr
    partial = Path(str(out_path) + ".partial")
    assert partial.exists()
    assert "PARTIAL_JSONL" in partial.read_text(encoding="utf-8")


@pytest.mark.parametrize("error_text", ["connection reset by peer", "Model not found: fixture-model"])
def test_zero_exit_error_after_tool_stops_retry_and_fallback(tmp_path: Path, error_text: str) -> None:
    proc, out_path, log_path = _run_runner(
        tmp_path,
        args=["--max-attempts", "2", "--sleep-secs", "1", "--timeout-secs", "10"],
        fake_mode="tool_activity_error_result_zero_exit",
        extra_env={"FAKE_TOOL_ERROR": error_text},
    )
    assert proc.returncode == 11, proc.stderr
    assert _log_text(log_path).count("args=") == 1
    assert "recorded tool activity" in proc.stderr
    assert "retrying" not in proc.stderr
    assert not out_path.exists()
    partial = Path(str(out_path) + ".partial").read_text(encoding="utf-8")
    assert partial == "PARTIAL_BEFORE_ERROR_RESULT\n"
    receipt_path = next(Path(str(out_path) + ".attempts").glob("run.*/budget.json"))
    receipt = json.loads(receipt_path.read_text(encoding="utf-8"))
    assert receipt["status"] == "failed"
    assert receipt["attempts_used"] == 1
    assert receipt["attempts"][0]["exit_code"] == 0


def test_text_only_disconnect_keeps_partial_without_tool_stop(tmp_path: Path) -> None:
    proc, out_path, log_path = _run_runner(
        tmp_path,
        args=["--max-attempts", "1"],
        fake_mode="text_only_disconnect",
    )
    assert proc.returncode != 0
    assert "recorded tool activity" not in proc.stderr
    partial = Path(str(out_path) + ".partial")
    assert partial.exists()
    assert "PARTIAL_NO_TOOL" in partial.read_text(encoding="utf-8")
    assert not out_path.exists()


def test_raw_out_cannot_alias_prompt_file(tmp_path: Path) -> None:
    prompt = tmp_path / "prompt.txt"
    prompt.write_text("task input\n", encoding="utf-8")
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    _write_fake_qwen(bin_dir)
    env = os.environ.copy()
    env["PATH"] = f"{bin_dir}:{env.get('PATH', '')}"
    proc = subprocess.run(
        ["bash", str(RUNNER), "--prompt-file", str(prompt), "--out", str(tmp_path / "out.txt"),
         "--raw-out", str(prompt)],
        text=True, capture_output=True, env=env, cwd=tmp_path, check=False,
    )
    assert proc.returncode == 2
    assert "must differ from prompt inputs" in proc.stderr
    assert prompt.read_text(encoding="utf-8") == "task input\n"


def test_stderr_out_cannot_alias_prompt_file(tmp_path: Path) -> None:
    prompt = tmp_path / "prompt.txt"
    prompt.write_text("task input\n", encoding="utf-8")
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir()
    _write_fake_qwen(bin_dir)
    env = os.environ.copy()
    env["PATH"] = f"{bin_dir}:{env.get('PATH', '')}"
    proc = subprocess.run(
        ["bash", str(RUNNER), "--prompt-file", str(prompt), "--out", str(tmp_path / "out.txt"),
         "--stderr-out", str(prompt)],
        text=True, capture_output=True, env=env, cwd=tmp_path, check=False,
    )
    assert proc.returncode == 2
    assert "must differ from prompt inputs" in proc.stderr
    assert prompt.read_text(encoding="utf-8") == "task input\n"


def test_out_cannot_alias_system_prompt_file(tmp_path: Path) -> None:
    proc, out_path, _ = _run_runner(
        tmp_path,
        args=[],
        system_text="SYSTEM\n",
    )
    # separate invocation where --out points at the system file
    system = tmp_path / "system.txt"
    bin_dir = tmp_path / "bin"
    _write_fake_qwen(bin_dir)
    env = os.environ.copy()
    env["PATH"] = f"{bin_dir}:{env.get('PATH', '')}"
    proc = subprocess.run(
        ["bash", str(RUNNER), "--prompt-file", str(tmp_path / "prompt.txt"),
         "--system-prompt-file", str(system), "--out", str(system)],
        text=True, capture_output=True, env=env, cwd=tmp_path, check=False,
    )
    assert proc.returncode == 2
    assert "must differ from prompt inputs" in proc.stderr
    assert system.read_text(encoding="utf-8") == "SYSTEM\n"


def test_rejects_prompt_over_configured_limit(tmp_path: Path) -> None:
    proc, out_path, _ = _run_runner(
        tmp_path,
        args=[],
        prompt_text="12345",
        extra_env={"QWEN_MAX_PROMPT_BYTES": "4"},
    )
    assert proc.returncode == 2
    assert "exceeds the Qwen runner limit" in proc.stderr
    assert _out_text(out_path) == ""


def test_deterministic_failure_is_not_retried_even_with_attempts_left(tmp_path: Path) -> None:
    proc, out_path, log_path = _run_runner(
        tmp_path,
        args=["--max-attempts", "2", "--sleep-secs", "1"],
        fake_mode="deterministic_stderr_diagnostic",
    )
    assert proc.returncode == 1
    assert _log_text(log_path).count("args=") == 1
    assert "deterministic error" in proc.stderr
    assert _out_text(out_path) == ""


def test_transient_connection_reset_is_retried_then_succeeds(tmp_path: Path) -> None:
    proc, out_path, log_path = _run_runner(
        tmp_path,
        args=["--max-attempts", "2", "--sleep-secs", "1"],
        fake_mode="connection_reset_once_then_success",
    )
    assert proc.returncode == 0, proc.stderr
    assert _log_text(log_path).count("args=") == 2
    assert _out_text(out_path) == "OK_AFTER_RESET\n"


def test_quota_error_stops_without_retry(tmp_path: Path) -> None:
    proc, out_path, log_path = _run_runner(
        tmp_path,
        args=["--max-attempts", "3", "--sleep-secs", "1"],
        fake_mode="quota_error",
    )
    assert proc.returncode == 11
    assert _log_text(log_path).count("args=") == 1
    assert "deterministic error" in proc.stderr
    assert not out_path.exists()


def test_quota_words_in_normal_body_do_not_classify_failure(tmp_path: Path) -> None:
    proc, out_path, log_path = _run_runner(tmp_path, args=[], fake_mode="quota_quote_in_body")
    assert proc.returncode == 0, proc.stderr
    assert "billing cycle" in _out_text(out_path)
    assert _log_text(log_path).count("args=") == 1


def test_cancel_during_backoff_does_not_wait_or_start_retry(tmp_path: Path) -> None:
    bindir = tmp_path / "bin"
    bindir.mkdir()
    _write_fake_qwen(bindir)
    prompt = tmp_path / "prompt"
    prompt.write_text("Review the input.")
    out = tmp_path / "out"
    log = tmp_path / "calls"
    env = os.environ.copy()
    env.update(
        PATH=str(bindir) + os.pathsep + env.get("PATH", ""),
        FAKE_MODE="fail_once_then_success",
        FAKE_LOG=str(log),
        FAKE_STATE=str(tmp_path / "state"),
    )
    cmd = [
        "bash", str(RUNNER), "--prompt-file", str(prompt), "--out", str(out),
        "--max-attempts", "2", "--sleep-secs", "20",
    ]
    proc = subprocess.Popen(
        cmd, env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        text=True, start_new_session=True,
    )
    try:
        deadline = time.monotonic() + 5
        roots = []
        while time.monotonic() < deadline:
            roots = list(Path(str(out) + ".attempts").glob("run.*"))
            if roots and (roots[0] / "budget.json").exists():
                budget = json.loads((roots[0] / "budget.json").read_text())
                if budget["attempts"] and budget["attempts"][-1]["status"] != "running":
                    break
            time.sleep(0.02)
        assert roots and log.exists()
        time.sleep(0.15)
        assert proc.poll() is None
        start = time.monotonic()
        proc.send_signal(signal.SIGTERM)
        stdout, stderr = proc.communicate(timeout=5)
        assert time.monotonic() - start < 5
        assert proc.returncode == 143, stdout + stderr
        assert log.read_text().count("cwd=") == 1
        assert json.loads((roots[0] / "budget.json").read_text())["status"] == "cancelled"
        assert not out.exists()
    finally:
        if proc.poll() is None:
            os.killpg(proc.pid, signal.SIGTERM)
            proc.communicate(timeout=5)


@pytest.mark.parametrize(("mode", "diagnostic"), [
    ("unknown_format", "unsupported Qwen batch JSON"),
    ("unknown_option", "rejected the option safe-mode"),
])
def test_client_diagnostics_include_actual_version(tmp_path, mode, diagnostic):
    proc, _, _ = _run_runner(tmp_path, args=[], fake_mode=mode)
    assert proc.returncode and diagnostic in proc.stderr and "version 0.10.0" in proc.stderr
