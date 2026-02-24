from __future__ import annotations

import os
import subprocess
from pathlib import Path


SKILL_DIR = Path(__file__).resolve().parents[1]
RUNNER = SKILL_DIR / "scripts" / "run_opencode.sh"


def _write_fake_opencode(bin_dir: Path) -> Path:
    fake = bin_dir / "opencode"
    fake.write_text(
        """#!/usr/bin/env bash
set -euo pipefail

mode="${FAKE_MODE:-success}"
model=""
stdin_file="$(mktemp)"
trap 'rm -f "${stdin_file}"' EXIT

if [[ "${1:-}" == "run" ]]; then
  shift
fi

while [[ $# -gt 0 ]]; do
  case "$1" in
    -m|--model)
      model="${2:-}"
      shift 2
      ;;
    --format|--agent|--variant|--attach|--dir|--session|--title)
      shift 2
      ;;
    --thinking|--continue|--fork|--share|--print-logs)
      shift
      ;;
    *)
      shift
      ;;
  esac
done

# Consume stdin to mimic real CLI behavior.
cat >"${stdin_file}" || true

case "${mode}" in
  echo_input)
    python3 - "${stdin_file}" <<'PY'
import json
import sys
from pathlib import Path

text = Path(sys.argv[1]).read_text(encoding="utf-8")
print(json.dumps({"type": "text", "part": {"text": text}}, ensure_ascii=False))
PY
    exit 0
    ;;
  multi_text)
    echo '{"type":"text","part":{"text":"A"}}'
    echo '{"type":"text","part":{"text":"B"}}'
    exit 0
    ;;
  nonzero_with_text)
    echo '{"type":"text","part":{"text":"OK_NONZERO"}}'
    exit 7
    ;;
  model_not_found_with_fallback)
    if [[ -n "${model}" ]]; then
      echo '{"type":"error","error":{"data":{"message":"Model not found: invalid/provider-model."}}}'
      exit 0
    fi
    echo '{"type":"text","part":{"text":"OK_FALLBACK"}}'
    exit 0
    ;;
  generic_error_with_model)
    if [[ -n "${model}" ]]; then
      echo '{"type":"error","error":{"data":{"message":"Rate limited by provider."}}}'
      exit 0
    fi
    echo '{"type":"text","part":{"text":"SHOULD_NOT_FALLBACK"}}'
    exit 0
    ;;
  stderr_noise)
    echo '{"type":"text","part":{"text":"OK_STDERR"}}'
    echo 'diagnostic noise on stderr' >&2
    exit 0
    ;;
  *)
    echo '{"type":"text","part":{"text":"OK_DEFAULT"}}'
    exit 0
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
    fake_mode: str,
    prompt_text: str = "hello\n",
    system_text: str | None = None,
) -> tuple[subprocess.CompletedProcess[str], Path]:
    bin_dir = tmp_path / "bin"
    bin_dir.mkdir(parents=True, exist_ok=True)
    _write_fake_opencode(bin_dir)

    prompt = tmp_path / "prompt.txt"
    prompt.write_text(prompt_text, encoding="utf-8")
    out = tmp_path / "out.txt"
    system = tmp_path / "system.txt"

    env = os.environ.copy()
    env["PATH"] = f"{bin_dir}:{env.get('PATH', '')}"
    env["FAKE_MODE"] = fake_mode

    cmd = [
        "bash",
        str(RUNNER),
        "--prompt-file",
        str(prompt),
        "--out",
        str(out),
    ]
    if system_text is not None:
        system.write_text(system_text, encoding="utf-8")
        cmd.extend(
            [
                "--system-prompt-file",
                str(system),
            ]
        )
    cmd.extend(
        [
        *args,
        ]
    )
    proc = subprocess.run(cmd, text=True, capture_output=True, env=env, check=False)
    return proc, out


def _out_text(out_path: Path) -> str:
    if not out_path.exists():
        return ""
    return out_path.read_text(encoding="utf-8")


def test_succeeds_when_text_exists_even_if_opencode_exit_nonzero(tmp_path: Path) -> None:
    proc, out_path = _run_runner(tmp_path, args=[], fake_mode="nonzero_with_text")
    assert proc.returncode == 0, proc.stderr
    assert _out_text(out_path) == "OK_NONZERO\n"


def test_falls_back_to_default_model_on_model_not_found(tmp_path: Path) -> None:
    proc, out_path = _run_runner(
        tmp_path,
        args=["--model", "invalid/provider-model"],
        fake_mode="model_not_found_with_fallback",
    )
    assert proc.returncode == 0, proc.stderr
    assert _out_text(out_path) == "OK_FALLBACK\n"


def test_no_fallback_fails_on_model_not_found(tmp_path: Path) -> None:
    proc, out_path = _run_runner(
        tmp_path,
        args=["--model", "invalid/provider-model", "--no-fallback"],
        fake_mode="model_not_found_with_fallback",
    )
    assert proc.returncode != 0
    assert _out_text(out_path) == ""


def test_rejects_missing_option_value(tmp_path: Path) -> None:
    prompt = tmp_path / "prompt.txt"
    prompt.write_text("hello\n", encoding="utf-8")
    out = tmp_path / "out.txt"

    bin_dir = tmp_path / "bin"
    bin_dir.mkdir(parents=True, exist_ok=True)
    _write_fake_opencode(bin_dir)

    env = os.environ.copy()
    env["PATH"] = f"{bin_dir}:{env.get('PATH', '')}"
    env["FAKE_MODE"] = "success"

    proc = subprocess.run(
        [
            "bash",
            str(RUNNER),
            "--prompt-file",
            str(prompt),
            "--out",
            str(out),
            "--agent",
        ],
        text=True,
        capture_output=True,
        env=env,
        check=False,
    )
    assert proc.returncode == 2
    assert "Missing value for --agent" in proc.stderr


def test_does_not_fallback_for_non_model_errors(tmp_path: Path) -> None:
    proc, out_path = _run_runner(
        tmp_path,
        args=["--model", "zhipuglm/glm-5"],
        fake_mode="generic_error_with_model",
    )
    assert proc.returncode != 0
    assert _out_text(out_path) == ""
    assert "retrying with CLI default model" not in proc.stderr


def test_rejects_invalid_model_format(tmp_path: Path) -> None:
    proc, _ = _run_runner(
        tmp_path,
        args=["--model", "invalid-format-without-slash"],
        fake_mode="success",
    )
    assert proc.returncode == 2
    assert "Invalid --model format" in proc.stderr


def test_rejects_excessive_max_attempts(tmp_path: Path) -> None:
    proc, _ = _run_runner(
        tmp_path,
        args=["--max-attempts", "99999"],
        fake_mode="success",
    )
    assert proc.returncode == 2
    assert "--max-attempts must be <= 20" in proc.stderr


def test_dry_run_outputs_key_fields(tmp_path: Path) -> None:
    proc, out_path = _run_runner(
        tmp_path,
        args=["--dry-run", "--model", "zhipuglm/glm-5"],
        fake_mode="success",
    )
    assert proc.returncode == 0
    assert "dry_run: 1" in proc.stdout
    assert "command: opencode run --format json -m zhipuglm/glm-5" in proc.stdout
    assert _out_text(out_path) == ""


def test_system_prompt_prepended_with_single_blank_line(tmp_path: Path) -> None:
    proc, out_path = _run_runner(
        tmp_path,
        args=[],
        fake_mode="echo_input",
        prompt_text="PROMPT\n",
        system_text="SYSTEM\n",
    )
    assert proc.returncode == 0
    assert _out_text(out_path) == "SYSTEM\n\nPROMPT\n"


def test_max_retries_alias_still_works(tmp_path: Path) -> None:
    proc, out_path = _run_runner(
        tmp_path,
        args=["--max-retries", "1"],
        fake_mode="success",
    )
    assert proc.returncode == 0
    assert _out_text(out_path) == "OK_DEFAULT\n"


def test_merges_multiple_text_chunks(tmp_path: Path) -> None:
    proc, out_path = _run_runner(
        tmp_path,
        args=[],
        fake_mode="multi_text",
    )
    assert proc.returncode == 0
    assert _out_text(out_path) == "AB\n"


def test_rejects_excessive_sleep_secs(tmp_path: Path) -> None:
    proc, _ = _run_runner(
        tmp_path,
        args=["--sleep-secs", "301"],
        fake_mode="success",
    )
    assert proc.returncode == 2
    assert "--sleep-secs must be <= 300" in proc.stderr
