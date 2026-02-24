import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "relay.py"


def _run(profile_path: Path, mode: str, state_dir: Path, extra_args=None):
    cmd = [
        sys.executable,
        str(SCRIPT),
        "--profile",
        str(profile_path),
        "--mode",
        mode,
        "--state-dir",
        str(state_dir),
    ]
    if extra_args:
        cmd.extend(extra_args)
    env = os.environ.copy()
    env["PYTHONUNBUFFERED"] = "1"
    return subprocess.run(cmd, capture_output=True, text=True, env=env)


def _write_json(path: Path, payload):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2), encoding="utf-8")


def _write_script(path: Path, content: str):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")


def _base_profile(tmp_path: Path, tracker_path: Path, board_path: Path | None = None):
    profile = {
        "project_id": "sample-project",
        "repos": [str(tmp_path)],
        "tracker": {
            "path": str(tracker_path),
            "format": "json",
            "parse": {
                "tasks_key": "tasks",
                "id_field": "id",
                "status_field": "status",
                "milestone_field": "milestone",
            },
        },
        "board": {
            "platform": "file",
            "project_id": "board-1",
            "path": str(board_path) if board_path else "",
            "status_field": "status",
            "status_map": {
                "todo": "todo",
                "in_progress": "in_progress",
                "done": "done",
                "blocked": "blocked",
            },
        },
        "queue": {
            "order": ["task-1", "task-2"],
            "dependencies": {"task-2": ["task-1"]},
            "tasks": [
                {
                    "id": "task-1",
                    "depends_on": [],
                    "execute": ["python -c \"print('task-1')\""],
                },
                {
                    "id": "task-2",
                    "depends_on": ["task-1"],
                    "execute": ["python -c \"print('task-2')\""],
                },
            ],
        },
        "gates": {
            "verify_commands": ["python -c \"print('verify')\""],
            "review": {"required": False, "strategy": "stub"},
            "model_constraints": ["gpt-5.3-codex"],
        },
        "push_policy": {
            "env_inject": {"AUTO_RELAY": "1"},
            "session_launcher": {
                "mode": "inline",
                "command": "inline://continue",
            },
        },
        "stop_conditions": {
            "blocker_statuses": ["blocked"],
            "max_failures": 1,
            "require_human_on": ["permission_denied", "command_failed"],
        },
        "output_contract": {
            "required_fields": ["task_id", "phase", "status", "timestamp"],
        },
        "permissions": {
            "allow_commands": ["^python", "^echo"],
            "deny_commands": ["rm -rf", "git reset --hard"],
            "allow_paths": [str(tmp_path)],
            "deny_paths": [],
        },
    }
    return profile


def _setup_tracker(tmp_path: Path, status_1="todo", status_2="todo"):
    tracker_path = tmp_path / "tracker.json"
    _write_json(
        tracker_path,
        {
            "tasks": [
                {
                    "id": "task-1",
                    "status": status_1,
                    "milestone": "m1",
                    "description": "first",
                },
                {
                    "id": "task-2",
                    "status": status_2,
                    "milestone": "m2",
                    "description": "second",
                },
            ]
        },
    )
    return tracker_path


def _setup_board(tmp_path: Path, status_1="todo", status_2="todo"):
    board_path = tmp_path / "board.json"
    _write_json(
        board_path,
        {
            "tasks": [
                {"id": "task-1", "status": status_1},
                {"id": "task-2", "status": status_2},
            ]
        },
    )
    return board_path


def test_queue_progression_in_order(tmp_path: Path):
    tracker = _setup_tracker(tmp_path)
    board = _setup_board(tmp_path)
    profile_path = tmp_path / "profile.json"
    _write_json(profile_path, _base_profile(tmp_path, tracker, board))

    state_dir = tmp_path / "state"
    result = _run(profile_path, "run", state_dir)
    assert result.returncode == 0, result.stderr

    tracker_after = json.loads(tracker.read_text(encoding="utf-8"))
    statuses = [t["status"] for t in tracker_after["tasks"]]
    assert statuses == ["done", "done"]

    handoff_payload = json.loads((state_dir / "handoff_payload.json").read_text(encoding="utf-8"))
    assert handoff_payload["completed"] is True
    assert handoff_payload["degraded_reason"] is None

    review_meta = json.loads((state_dir / "review_meta.json").read_text(encoding="utf-8"))
    assert "fallback_reason" in review_meta
    assert review_meta["fallback_reason"] is None



def test_generates_next_prompt_with_milestone(tmp_path: Path):
    tracker = _setup_tracker(tmp_path, status_1="done", status_2="todo")
    board = _setup_board(tmp_path, status_1="done", status_2="todo")
    profile_path = tmp_path / "profile.json"
    _write_json(profile_path, _base_profile(tmp_path, tracker, board))

    state_dir = tmp_path / "state"
    result = _run(profile_path, "plan", state_dir)
    assert result.returncode == 0, result.stderr

    next_prompt = (state_dir / "next_prompt.md").read_text(encoding="utf-8")
    assert "task-2" in next_prompt
    assert "m2" in next_prompt



def test_blocker_stops_and_writes_minimal_decision_request(tmp_path: Path):
    tracker = _setup_tracker(tmp_path)
    board = _setup_board(tmp_path)
    profile = _base_profile(tmp_path, tracker, board)
    profile["queue"]["tasks"][0]["execute"] = ["python -c \"import sys; sys.exit(3)\""]

    profile_path = tmp_path / "profile.json"
    _write_json(profile_path, profile)

    state_dir = tmp_path / "state"
    result = _run(profile_path, "run", state_dir)
    assert result.returncode != 0

    blocker_report = json.loads((state_dir / "blocker_report.json").read_text(encoding="utf-8"))
    assert blocker_report["state"] == "BLOCKED"
    assert blocker_report["requires_human_intervention"] is True
    assert blocker_report["minimal_decision_request"]["question"]



def test_resume_from_previous_state(tmp_path: Path):
    tracker = _setup_tracker(tmp_path)
    board = _setup_board(tmp_path)
    profile = _base_profile(tmp_path, tracker, board)
    profile["push_policy"]["session_launcher"] = {
        "mode": "command",
        "command": "",
    }
    profile_path = tmp_path / "profile.json"
    _write_json(profile_path, profile)

    state_dir = tmp_path / "state"
    first = _run(profile_path, "run", state_dir)
    assert first.returncode == 0, first.stderr

    profile["push_policy"]["session_launcher"] = {
        "mode": "inline",
        "command": "inline://continue",
    }
    _write_json(profile_path, profile)

    second = _run(profile_path, "resume", state_dir)
    assert second.returncode == 0, second.stderr

    tracker_after = json.loads(tracker.read_text(encoding="utf-8"))
    assert [t["status"] for t in tracker_after["tasks"]] == ["done", "done"]



def test_reconcile_board_tracker_mismatch_before_continue(tmp_path: Path):
    tracker = _setup_tracker(tmp_path, status_1="todo", status_2="todo")
    board = _setup_board(tmp_path, status_1="done", status_2="todo")
    profile_path = tmp_path / "profile.json"
    _write_json(profile_path, _base_profile(tmp_path, tracker, board))

    state_dir = tmp_path / "state"
    result = _run(profile_path, "run", state_dir)
    assert result.returncode == 0, result.stderr

    trace_lines = (state_dir / "relay_trace.jsonl").read_text(encoding="utf-8").splitlines()
    events = [json.loads(line)["event"] for line in trace_lines if line.strip()]
    assert "board_tracker_reconciled" in events



def test_degrades_when_no_session_launcher(tmp_path: Path):
    tracker = _setup_tracker(tmp_path)
    board = _setup_board(tmp_path)
    profile = _base_profile(tmp_path, tracker, board)
    profile["push_policy"]["session_launcher"] = {
        "mode": "command",
        "command": "",
    }
    profile_path = tmp_path / "profile.json"
    _write_json(profile_path, profile)

    state_dir = tmp_path / "state"
    result = _run(profile_path, "run", state_dir)
    assert result.returncode == 0, result.stderr

    payload = json.loads((state_dir / "handoff_payload.json").read_text(encoding="utf-8"))
    assert payload["awaiting_launcher"] is True
    assert payload["launch_command"]
    assert payload["degraded_reason"]



def test_audit_artifacts_integrity(tmp_path: Path):
    tracker = _setup_tracker(tmp_path)
    board = _setup_board(tmp_path)
    profile_path = tmp_path / "profile.json"
    _write_json(profile_path, _base_profile(tmp_path, tracker, board))

    state_dir = tmp_path / "state"
    result = _run(profile_path, "dry-run", state_dir)
    assert result.returncode == 0, result.stderr

    expected = [
        "relay_state.json",
        "relay_trace.jsonl",
        "next_prompt.md",
        "handoff_payload.json",
        "verification_log.txt",
        "review_meta.json",
    ]
    for filename in expected:
        target = state_dir / filename
        assert target.exists(), f"missing artifact: {filename}"
        assert target.stat().st_size > 0, f"empty artifact: {filename}"

    trace_lines = (state_dir / "relay_trace.jsonl").read_text(encoding="utf-8").splitlines()
    assert trace_lines
    parsed = [json.loads(line) for line in trace_lines if line.strip()]
    assert all("timestamp" in item and "phase" in item for item in parsed)


def test_max_failures_reached_marks_exceeded(tmp_path: Path):
    tracker = _setup_tracker(tmp_path)
    board = _setup_board(tmp_path)
    profile = _base_profile(tmp_path, tracker, board)
    profile["stop_conditions"]["max_failures"] = 1
    profile["queue"]["tasks"][0]["execute"] = ["python -c \"import sys; sys.exit(8)\""]
    profile_path = tmp_path / "profile.json"
    _write_json(profile_path, profile)

    state_dir = tmp_path / "state"
    result = _run(profile_path, "run", state_dir)
    assert result.returncode != 0

    blocker_report = json.loads((state_dir / "blocker_report.json").read_text(encoding="utf-8"))
    assert blocker_report["failure_count"] == 1
    assert blocker_report["max_failures"] == 1
    assert blocker_report["max_failures_exceeded"] is True


def test_yaml_profile_and_tracker_supported(tmp_path: Path):
    yaml = pytest.importorskip("yaml")

    tracker_path = tmp_path / "tracker.yaml"
    tracker_payload = {
        "tasks": [
            {"id": "task-1", "status": "todo", "milestone": "m1", "description": "first"},
            {"id": "task-2", "status": "todo", "milestone": "m2", "description": "second"},
        ]
    }
    tracker_path.write_text(yaml.safe_dump(tracker_payload, sort_keys=False), encoding="utf-8")

    board = _setup_board(tmp_path)
    profile = _base_profile(tmp_path, tracker_path, board)
    profile["tracker"]["format"] = "yaml"
    profile_path = tmp_path / "profile.yaml"
    profile_path.write_text(yaml.safe_dump(profile, sort_keys=False), encoding="utf-8")

    state_dir = tmp_path / "state"
    result = _run(profile_path, "run", state_dir)
    assert result.returncode == 0, result.stderr

    tracker_after = yaml.safe_load(tracker_path.read_text(encoding="utf-8"))
    assert [task["status"] for task in tracker_after["tasks"]] == ["done", "done"]


def test_invalid_profile_fails_fast(tmp_path: Path):
    tracker = _setup_tracker(tmp_path)
    board = _setup_board(tmp_path)
    bad_profile = _base_profile(tmp_path, tracker, board)
    bad_profile.pop("repos")
    profile_path = tmp_path / "profile.json"
    _write_json(profile_path, bad_profile)

    state_dir = tmp_path / "state"
    result = _run(profile_path, "plan", state_dir)
    assert result.returncode != 0
    assert "repos" in result.stderr


def test_plan_mode_handoff_payload_uses_routed_model(tmp_path: Path):
    tracker = _setup_tracker(tmp_path, status_1="done", status_2="todo")
    board = _setup_board(tmp_path, status_1="done", status_2="todo")
    profile = _base_profile(tmp_path, tracker, board)
    profile["model_routing"] = {
        "default": "gpt-5.3-codex-xhigh",
        "rules": [
            {"task_ids": ["task-2"], "model": "gpt-5.2-xhigh"},
        ],
    }
    profile_path = tmp_path / "profile.json"
    _write_json(profile_path, profile)

    state_dir = tmp_path / "state"
    result = _run(profile_path, "plan", state_dir)
    assert result.returncode == 0, result.stderr

    payload = json.loads((state_dir / "handoff_payload.json").read_text(encoding="utf-8"))
    assert payload["next_task_id"] == "task-2"
    assert payload["selected_model"] == "gpt-5.2-xhigh"
    assert payload["selected_model_reason"] == "model_routing.rules[0]"

    next_prompt = (state_dir / "next_prompt.md").read_text(encoding="utf-8")
    assert "Selected Model: gpt-5.2-xhigh" in next_prompt


def test_plan_mode_handoff_payload_uses_default_model_fallback(tmp_path: Path):
    tracker = _setup_tracker(tmp_path, status_1="done", status_2="todo")
    board = _setup_board(tmp_path, status_1="done", status_2="todo")
    profile = _base_profile(tmp_path, tracker, board)
    profile.pop("model_routing", None)
    profile_path = tmp_path / "profile.json"
    _write_json(profile_path, profile)

    state_dir = tmp_path / "state"
    result = _run(profile_path, "plan", state_dir)
    assert result.returncode == 0, result.stderr

    payload = json.loads((state_dir / "handoff_payload.json").read_text(encoding="utf-8"))
    assert payload["selected_model"] == "gpt-5.3-codex"
    assert payload["selected_model_reason"] == "default"


def test_command_launcher_formats_model_placeholder(tmp_path: Path):
    # Intention: run mode executes task-1 first, then handoff targets next task (task-2).
    # The selected model should therefore come from task-2 routing, not task-1.
    tracker = _setup_tracker(tmp_path, status_1="todo", status_2="todo")
    board = _setup_board(tmp_path, status_1="todo", status_2="todo")
    profile = _base_profile(tmp_path, tracker, board)
    profile["model_routing"] = {
        "default": "gpt-5.3-codex-xhigh",
        "rules": [
            {"task_ids": ["task-2"], "model": "gpt-5.2-xhigh"},
        ],
    }
    profile["push_policy"]["session_launcher"] = {
        "mode": "command",
        "command": (
            "python -c \"from pathlib import Path; "
            "Path(r'{state_dir}/launcher_model.txt').write_text(r'{model}', encoding='utf-8')\""
        ),
    }
    profile_path = tmp_path / "profile.json"
    _write_json(profile_path, profile)

    state_dir = tmp_path / "state"
    result = _run(profile_path, "run", state_dir)
    assert result.returncode == 0, result.stderr

    launcher_out = (state_dir / "launcher_model.txt").read_text(encoding="utf-8")
    assert launcher_out == "gpt-5.2-xhigh"

    payload = json.loads((state_dir / "handoff_payload.json").read_text(encoding="utf-8"))
    assert payload["selected_model"] == "gpt-5.2-xhigh"
    assert payload["next_task_id"] == "task-2"
    assert payload["selected_model_reason"] == "model_routing.rules[0]"
    assert "--model gpt-5.2-xhigh" not in payload["launch_command"]


def test_handoff_permission_denied_degrades_instead_of_blocking(tmp_path: Path):
    tracker = _setup_tracker(tmp_path, status_1="todo", status_2="todo")
    board = _setup_board(tmp_path, status_1="todo", status_2="todo")
    profile = _base_profile(tmp_path, tracker, board)
    profile["queue"]["tasks"][0]["execute"] = ["echo task-1"]
    profile["queue"]["tasks"][1]["execute"] = ["echo task-2"]
    profile["gates"]["verify_commands"] = ["echo verify"]
    profile["permissions"]["allow_commands"] = ["^echo"]
    profile["push_policy"]["session_launcher"] = {
        "mode": "command",
        "command": "python -c \"print('launch')\"",
    }
    profile_path = tmp_path / "profile.json"
    _write_json(profile_path, profile)

    state_dir = tmp_path / "state"
    result = _run(profile_path, "run", state_dir)
    assert result.returncode == 0, result.stderr

    payload = json.loads((state_dir / "handoff_payload.json").read_text(encoding="utf-8"))
    assert payload["awaiting_launcher"] is True
    assert payload["degraded_reason"] == "launcher_permission_denied"
    assert "permission_error" in json.dumps(payload)
    assert not (state_dir / "blocker_report.json").exists()


def test_review_strategy_unknown_degrades_to_stub(tmp_path: Path):
    tracker = _setup_tracker(tmp_path)
    board = _setup_board(tmp_path)
    profile = _base_profile(tmp_path, tracker, board)
    profile["gates"]["review"] = {"required": True, "strategy": "review-swarm"}
    profile_path = tmp_path / "profile.json"
    _write_json(profile_path, profile)

    state_dir = tmp_path / "state"
    result = _run(profile_path, "run", state_dir)
    assert result.returncode == 0, result.stderr

    review_meta = json.loads((state_dir / "review_meta.json").read_text(encoding="utf-8"))
    assert review_meta["status"] == "degraded"
    assert review_meta["strategy"] == "stub"
    assert review_meta["requested_strategy"] == "review-swarm"
    assert review_meta["degraded_reason"] == "unsupported_review_strategy"


def test_output_contract_non_strict_missing_fields_warn_only(tmp_path: Path):
    tracker = _setup_tracker(tmp_path)
    board = _setup_board(tmp_path)
    profile = _base_profile(tmp_path, tracker, board)
    profile["output_contract"] = {
        "strict": False,
        "required_fields": ["task_id", "phase", "status", "timestamp", "review_url"],
    }
    profile_path = tmp_path / "profile.json"
    _write_json(profile_path, profile)

    state_dir = tmp_path / "state"
    result = _run(profile_path, "run", state_dir)
    assert result.returncode == 0, result.stderr

    state = json.loads((state_dir / "relay_state.json").read_text(encoding="utf-8"))
    assert state["history"]
    assert "output_contract_missing" in state["history"][-1]
    assert "review_url" in state["history"][-1]["output_contract_missing"]

    trace_lines = (state_dir / "relay_trace.jsonl").read_text(encoding="utf-8").splitlines()
    events = [json.loads(line)["event"] for line in trace_lines if line.strip()]
    assert "output_contract_missing_nonblocking" in events


def test_execute_retries_transient_failure_then_succeeds(tmp_path: Path):
    tracker = _setup_tracker(tmp_path)
    board = _setup_board(tmp_path)
    profile = _base_profile(tmp_path, tracker, board)
    flag = tmp_path / "exec_retry.flag"
    flaky_exec = tmp_path / "flaky_exec.py"
    _write_script(
        flaky_exec,
        "\n".join(
            [
                "from pathlib import Path",
                "import sys",
                f"flag = Path(r'{flag}')",
                "if flag.exists():",
                "    sys.exit(0)",
                "flag.write_text('1', encoding='utf-8')",
                "sys.exit(17)",
                "",
            ]
        ),
    )
    profile["queue"]["tasks"][0]["execute"] = [f"python {flaky_exec}"]
    profile["gates"]["command_retries"] = {
        "execute_max_retries": 1,
        "verify_max_retries": 0,
        "backoff_seconds": 0,
    }
    profile_path = tmp_path / "profile.json"
    _write_json(profile_path, profile)

    state_dir = tmp_path / "state"
    result = _run(profile_path, "run", state_dir)
    assert result.returncode == 0, result.stderr

    trace_lines = (state_dir / "relay_trace.jsonl").read_text(encoding="utf-8").splitlines()
    events = [json.loads(line)["event"] for line in trace_lines if line.strip()]
    assert "command_retry_scheduled" in events


def test_verify_retries_transient_failure_then_succeeds(tmp_path: Path):
    tracker = _setup_tracker(tmp_path)
    board = _setup_board(tmp_path)
    profile = _base_profile(tmp_path, tracker, board)
    flag = tmp_path / "verify_retry.flag"
    flaky_verify = tmp_path / "flaky_verify.py"
    _write_script(
        flaky_verify,
        "\n".join(
            [
                "from pathlib import Path",
                "import sys",
                f"flag = Path(r'{flag}')",
                "if flag.exists():",
                "    sys.exit(0)",
                "flag.write_text('1', encoding='utf-8')",
                "sys.exit(19)",
                "",
            ]
        ),
    )
    profile["gates"]["verify_commands"] = [f"python {flaky_verify}"]
    profile["gates"]["command_retries"] = {
        "execute_max_retries": 0,
        "verify_max_retries": 1,
        "backoff_seconds": 0,
    }
    profile_path = tmp_path / "profile.json"
    _write_json(profile_path, profile)

    state_dir = tmp_path / "state"
    result = _run(profile_path, "run", state_dir)
    assert result.returncode == 0, result.stderr

    trace_lines = (state_dir / "relay_trace.jsonl").read_text(encoding="utf-8").splitlines()
    events = [json.loads(line)["event"] for line in trace_lines if line.strip()]
    assert "verify_retry_scheduled" in events
