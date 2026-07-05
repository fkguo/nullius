from __future__ import annotations

import os
import subprocess
from pathlib import Path


SKILL_DIR = Path(__file__).resolve().parents[1]
RUNNER = SKILL_DIR / "scripts" / "run_kimi.sh"


def _write_fake_kimi(bin_dir: Path) -> Path:
    fake = bin_dir / "kimi"
    fake.write_text(
        """#!/usr/bin/env bash
set -euo pipefail

mode="${FAKE_MODE:-success}"
log_file="${FAKE_LOG:-}"
state_file="${FAKE_STATE:-}"
model=""
prompt=""
output_format=""
add_dirs=()
skills_dirs=()
original_args=("$@")

record_call() {
  if [[ -n "${log_file}" ]]; then
    printf 'cwd=%s\\n' "$(pwd)" >>"${log_file}"
    printf 'args=' >>"${log_file}"
    printf '%q ' "$@" >>"${log_file}"
    printf '\\n' >>"${log_file}"
  fi
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    -m|--model)
      model="${2:-}"
      shift 2
      ;;
    --output-format)
      output_format="${2:-}"
      shift 2
      ;;
    --add-dir)
      add_dirs+=("${2:-}")
      shift 2
      ;;
    --skills-dir)
      skills_dirs+=("${2:-}")
      shift 2
      ;;
    -p|--prompt)
      prompt="${2:-}"
      shift 2
      ;;
    *)
      shift
      ;;
  esac
done

record_call "${original_args[@]}"

case "${mode}" in
  echo_prompt)
    python3 - "${prompt}" <<'PY'
import json
import sys
print(json.dumps({"role": "assistant", "content": sys.argv[1]}, ensure_ascii=False))
PY
    ;;
  multi_json)
    echo '{"role":"assistant","content":"A"}'
    echo '{"role":"tool","tool_call_id":"t1","content":"ignored"}'
    echo '{"role":"meta","type":"session.resume_hint","content":"ignored"}'
    echo '{"role":"assistant","content":"B"}'
    ;;
  array_content)
    echo '{"role":"assistant","content":[{"type":"text","text":"A"},{"type":"text","text":"B"}]}'
    ;;
  empty_assistant)
    echo '{"role":"assistant","content":""}'
    ;;
  stream_error)
    echo '{"type":"error","error":{"message":"bad stream"}}'
    ;;
  role_error)
    echo '{"role":"error","content":"role bad"}'
    ;;
  null_error_metadata)
    echo '{"role":"meta","error":null,"content":"not an error"}'
    echo '{"role":"assistant","content":"OK_AFTER_NULL_ERROR"}'
    ;;
  sleep_then_success)
    sleep "${FAKE_SLEEP_SECS:-5}"
    echo '{"role":"assistant","content":"OK_AFTER_SLEEP"}'
    ;;
  partial_then_sleep)
    echo '{"role":"assistant","content":"PARTIAL_BEFORE_SLEEP"}'
    sleep "${FAKE_SLEEP_SECS:-5}"
    echo '{"role":"assistant","content":"OK_AFTER_SLEEP"}'
    ;;
  unknown_assistant_shape)
    echo '{"role":"assistant","content":{"unexpected":true}}'
    ;;
  fail_once_then_success)
    if [[ -n "${state_file}" && ! -f "${state_file}" ]]; then
      printf 'failed\\n' >"${state_file}"
      echo "transient failure" >&2
      exit 8
    fi
    echo '{"role":"assistant","content":"OK_RETRY"}'
    ;;
  model_not_found)
    if [[ -n "${model}" ]]; then
      echo "Model not found: ${model}" >&2
      exit 7
    fi
    echo '{"role":"assistant","content":"OK_FALLBACK"}'
    ;;
  model_not_found_then_other_failure)
    if [[ -n "${model}" ]]; then
      if [[ -n "${state_file}" && ! -f "${state_file}" ]]; then
        printf 'model-missing\\n' >"${state_file}"
        echo "Model not found: ${model}" >&2
        exit 7
      fi
      echo "different failure after missing model" >&2
      exit 8
    fi
    echo '{"role":"assistant","content":"OK_FALLBACK_AFTER_ANY_MODEL_MISS"}'
    ;;
  emit_metadata)
    python3 - "${model}" "${output_format}" "${#add_dirs[@]}" "${#skills_dirs[@]}" <<'PY'
import json
import sys
payload = {
    "model": sys.argv[1],
    "output_format": sys.argv[2],
    "add_dir_count": int(sys.argv[3]),
    "skills_dir_count": int(sys.argv[4]),
}
print(json.dumps({"role": "assistant", "content": json.dumps(payload, sort_keys=True)}, ensure_ascii=False))
PY
    ;;
  *)
    echo '{"role":"assistant","content":"OK_DEFAULT"}'
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
    _write_fake_kimi(bin_dir)

    prompt = tmp_path / "prompt.txt"
    prompt.write_text(prompt_text, encoding="utf-8")
    out = tmp_path / "out.txt"
    system = tmp_path / "system.txt"
    log = tmp_path / "fake_kimi.log"

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


def test_default_dry_run_uses_isolated_mode_no_workspace_and_empty_skills(tmp_path: Path) -> None:
    proc, out_path, _ = _run_runner(
        tmp_path,
        args=["--dry-run", "--model", "kimi-k2"],
    )
    assert proc.returncode == 0, proc.stderr
    assert "Tool mode: isolated" in proc.stdout
    assert "Work dir: (temporary isolated directory)" in proc.stdout
    assert "Workspace dirs: (none)" in proc.stdout
    assert "Skills dirs: (empty temporary directory)" in proc.stdout
    assert "Timeout: 900s per attempt" in proc.stdout
    assert "--output-format stream-json" in proc.stdout
    assert "--add-dir" not in proc.stdout
    assert "--skills-dir" in proc.stdout
    assert "empty_temp_skills_dir" in proc.stdout
    assert "--yolo" not in proc.stdout
    assert "--auto" not in proc.stdout
    assert "--plan" not in proc.stdout
    assert _out_text(out_path) == ""


def test_default_run_does_not_use_current_cwd_as_kimi_workdir(tmp_path: Path) -> None:
    proc, out_path, log_path = _run_runner(tmp_path, args=[])
    assert proc.returncode == 0, proc.stderr
    assert _out_text(out_path) == "OK_DEFAULT\n"
    log = _log_text(log_path)
    assert f"cwd={tmp_path}" not in log
    assert "--add-dir" not in log
    assert "--skills-dir" in log


def test_workspace_mode_passes_add_dir_but_keeps_isolated_workdir(tmp_path: Path) -> None:
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    proc, out_path, log_path = _run_runner(
        tmp_path,
        args=["--tool-mode", "workspace", "--workspace-dir", str(workspace)],
        fake_mode="emit_metadata",
    )
    assert proc.returncode == 0, proc.stderr
    assert '"add_dir_count": 1' in _out_text(out_path)
    log = _log_text(log_path)
    assert f"cwd={tmp_path}" not in log
    assert "--add-dir" in log
    assert str(workspace) in log


def test_auto_skills_omits_default_empty_skills_dir(tmp_path: Path) -> None:
    proc, out_path, log_path = _run_runner(
        tmp_path,
        args=["--auto-skills"],
        fake_mode="emit_metadata",
    )
    assert proc.returncode == 0, proc.stderr
    assert '"skills_dir_count": 0' in _out_text(out_path)
    assert "--skills-dir" not in _log_text(log_path)


def test_rejects_auto_skills_with_explicit_skills_dir(tmp_path: Path) -> None:
    skills_dir = tmp_path / "skills"
    skills_dir.mkdir()
    proc, out_path, _ = _run_runner(
        tmp_path,
        args=["--auto-skills", "--skills-dir", str(skills_dir)],
        fake_mode="emit_metadata",
    )
    assert proc.returncode == 2
    assert "cannot be combined" in proc.stderr
    assert _out_text(out_path) == ""


def test_rejects_workspace_dir_without_workspace_mode(tmp_path: Path) -> None:
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    proc, _, _ = _run_runner(
        tmp_path,
        args=["--workspace-dir", str(workspace)],
    )
    assert proc.returncode == 2
    assert "requires --tool-mode workspace" in proc.stderr


def test_accepts_none_as_isolated_legacy_alias(tmp_path: Path) -> None:
    proc, out_path, log_path = _run_runner(
        tmp_path,
        args=["--tool-mode", "none"],
    )
    assert proc.returncode == 0, proc.stderr
    assert _out_text(out_path) == "OK_DEFAULT\n"
    assert f"cwd={tmp_path}" not in _log_text(log_path)


def test_system_prompt_is_prepended_to_merged_prompt(tmp_path: Path) -> None:
    proc, out_path, _ = _run_runner(
        tmp_path,
        args=[],
        fake_mode="echo_prompt",
        prompt_text="USER\n",
        system_text="SYSTEM\n",
    )
    assert proc.returncode == 0, proc.stderr
    text = _out_text(out_path)
    assert "=== System Instructions ===\nSYSTEM\n" in text
    assert "=== Task ===\nUSER\n" in text


def test_parses_assistant_messages_and_ignores_tool_and_meta_events(tmp_path: Path) -> None:
    proc, out_path, _ = _run_runner(
        tmp_path,
        args=[],
        fake_mode="multi_json",
    )
    assert proc.returncode == 0, proc.stderr
    assert _out_text(out_path) == "A\nB\n"


def test_parses_text_block_array_assistant_content(tmp_path: Path) -> None:
    proc, out_path, _ = _run_runner(
        tmp_path,
        args=[],
        fake_mode="array_content",
    )
    assert proc.returncode == 0, proc.stderr
    assert _out_text(out_path) == "AB\n"


def test_empty_assistant_content_is_valid_output(tmp_path: Path) -> None:
    proc, out_path, _ = _run_runner(
        tmp_path,
        args=[],
        fake_mode="empty_assistant",
    )
    assert proc.returncode == 0, proc.stderr
    assert _out_text(out_path) == "\n"


def test_stream_json_error_event_fails_even_with_zero_exit(tmp_path: Path) -> None:
    proc, out_path, _ = _run_runner(
        tmp_path,
        args=[],
        fake_mode="stream_error",
    )
    assert proc.returncode != 0
    assert "bad stream" in proc.stderr
    assert _out_text(out_path) == ""


def test_role_error_event_fails_even_with_zero_exit(tmp_path: Path) -> None:
    proc, out_path, _ = _run_runner(
        tmp_path,
        args=[],
        fake_mode="role_error",
    )
    assert proc.returncode != 0
    assert "role bad" in proc.stderr
    assert _out_text(out_path) == ""


def test_null_error_metadata_is_not_treated_as_failure(tmp_path: Path) -> None:
    proc, out_path, _ = _run_runner(
        tmp_path,
        args=[],
        fake_mode="null_error_metadata",
    )
    assert proc.returncode == 0, proc.stderr
    assert _out_text(out_path) == "OK_AFTER_NULL_ERROR\n"


def test_unknown_assistant_content_shape_fails_explicitly(tmp_path: Path) -> None:
    proc, out_path, _ = _run_runner(
        tmp_path,
        args=[],
        fake_mode="unknown_assistant_shape",
    )
    assert proc.returncode != 0
    assert "Unsupported assistant content shape" in proc.stderr
    assert _out_text(out_path) == ""


def test_deterministic_parse_error_is_not_retried(tmp_path: Path) -> None:
    proc, out_path, log_path = _run_runner(
        tmp_path,
        args=["--max-attempts", "2", "--sleep-secs", "1"],
        fake_mode="unknown_assistant_shape",
    )
    assert proc.returncode != 0
    assert "not retrying identical output" in proc.stderr
    assert _log_text(log_path).count("args=") == 1
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


def test_timeout_kills_hung_kimi_attempt(tmp_path: Path) -> None:
    proc, out_path, _ = _run_runner(
        tmp_path,
        args=["--timeout-secs", "1"],
        fake_mode="sleep_then_success",
        extra_env={"FAKE_SLEEP_SECS": "5"},
    )
    assert proc.returncode == 124
    assert "timed out after 1s" in proc.stderr
    assert _out_text(out_path) == ""


def test_timeout_can_preserve_raw_stdout_and_stderr(tmp_path: Path) -> None:
    raw_out = tmp_path / "raw.jsonl"
    stderr_out = tmp_path / "raw.stderr"
    proc, out_path, _ = _run_runner(
        tmp_path,
        args=[
            "--timeout-secs",
            "1",
            "--raw-out",
            str(raw_out),
            "--stderr-out",
            str(stderr_out),
        ],
        fake_mode="partial_then_sleep",
        extra_env={"FAKE_SLEEP_SECS": "5"},
    )
    assert proc.returncode == 124
    assert _out_text(out_path) == ""
    assert "PARTIAL_BEFORE_SLEEP" in raw_out.read_text(encoding="utf-8")
    assert "timed out after 1s" in stderr_out.read_text(encoding="utf-8")


def test_falls_back_to_default_model_on_model_not_found(tmp_path: Path) -> None:
    proc, out_path, _ = _run_runner(
        tmp_path,
        args=["--model", "missing-model"],
        fake_mode="model_not_found",
    )
    assert proc.returncode == 0, proc.stderr
    assert _out_text(out_path) == "OK_FALLBACK\n"
    assert "retrying with CLI default model" in proc.stderr


def test_fallback_uses_model_not_found_from_any_attempt(tmp_path: Path) -> None:
    proc, out_path, _ = _run_runner(
        tmp_path,
        args=["--model", "missing-model", "--max-attempts", "2", "--sleep-secs", "1"],
        fake_mode="model_not_found_then_other_failure",
    )
    assert proc.returncode == 0, proc.stderr
    assert _out_text(out_path) == "OK_FALLBACK_AFTER_ANY_MODEL_MISS\n"
    assert "retrying with CLI default model" in proc.stderr


def test_no_fallback_fails_on_model_not_found(tmp_path: Path) -> None:
    proc, out_path, _ = _run_runner(
        tmp_path,
        args=["--model", "missing-model", "--no-fallback"],
        fake_mode="model_not_found",
    )
    assert proc.returncode != 0
    assert _out_text(out_path) == ""


def test_rejects_merged_prompt_over_configured_limit(tmp_path: Path) -> None:
    proc, out_path, _ = _run_runner(
        tmp_path,
        args=[],
        prompt_text="12345",
        extra_env={"KIMI_MAX_PROMPT_BYTES": "4"},
    )
    assert proc.returncode == 2
    assert "Merged prompt is" in proc.stderr
    assert _out_text(out_path) == ""
