#!/usr/bin/env python3
# CONTRACT-EXEMPT: CODE-01.1 sunset:2026-06-01 — cross-session orchestrator; split into phase modules planned
"""Cross-session auto relay orchestrator (general skill, profile-driven)."""

from __future__ import annotations

import argparse
import copy
import dataclasses
import datetime as dt
import json
import os
import re
import shlex
import subprocess
import sys
import time
import traceback
from pathlib import Path
from typing import Any

PHASE_IDLE = "IDLE"
PHASE_PREFLIGHT = "PREFLIGHT"
PHASE_EXECUTE = "EXECUTE"
PHASE_VERIFY = "VERIFY"
PHASE_REVIEW = "REVIEW"
PHASE_SYNC = "SYNC"
PHASE_HANDOFF = "HANDOFF"
PHASE_BLOCKED = "BLOCKED"

RUN_MODES = {"plan", "run", "resume", "dry-run", "handoff-only"}
CANONICAL_DONE = "done"
CANONICAL_BLOCKED = "blocked"


def now_iso() -> str:
    return dt.datetime.now(dt.timezone.utc).isoformat()


def ensure_dir(path: Path) -> None:
    path.mkdir(parents=True, exist_ok=True)


def write_text(path: Path, text: str) -> None:
    ensure_dir(path.parent)
    path.write_text(text, encoding="utf-8")


def write_json(path: Path, payload: Any) -> None:
    write_text(path, json.dumps(payload, indent=2, ensure_ascii=False) + "\n")


def append_jsonl(path: Path, payload: dict[str, Any]) -> None:
    ensure_dir(path.parent)
    with path.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(payload, ensure_ascii=False) + "\n")


def load_data(path: Path, data_format: str | None = None) -> Any:
    fmt = (data_format or path.suffix.lstrip(".") or "json").lower()
    raw = path.read_text(encoding="utf-8")
    if fmt == "json":
        return json.loads(raw)
    if fmt in {"yaml", "yml"}:
        try:
            import yaml  # type: ignore
        except Exception as exc:  # pragma: no cover - defensive branch
            raise RuntimeError(
                "YAML support requires PyYAML (pip install pyyaml)"
            ) from exc
        return yaml.safe_load(raw)
    raise ValueError(f"Unsupported format: {fmt}")


def dump_data(path: Path, payload: Any, data_format: str | None = None) -> None:
    fmt = (data_format or path.suffix.lstrip(".") or "json").lower()
    if fmt == "json":
        write_json(path, payload)
        return
    if fmt in {"yaml", "yml"}:
        try:
            import yaml  # type: ignore
        except Exception as exc:  # pragma: no cover - defensive branch
            raise RuntimeError(
                "YAML support requires PyYAML (pip install pyyaml)"
            ) from exc
        write_text(path, yaml.safe_dump(payload, sort_keys=False))
        return
    raise ValueError(f"Unsupported format: {fmt}")


def load_profile(path: Path) -> dict[str, Any]:
    profile = load_data(path)
    if not isinstance(profile, dict):
        raise ValueError("Profile root must be an object")

    schema_path = Path(__file__).resolve().parents[1] / "schemas" / "profile.schema.json"
    if schema_path.exists():
        try:
            import jsonschema  # type: ignore

            schema_payload = load_data(schema_path, "json")
            jsonschema.validate(profile, schema_payload)
        except ImportError:
            # Optional dependency. Keep runtime usable without jsonschema.
            pass

    required_top = [
        "project_id",
        "repos",
        "tracker",
        "board",
        "queue",
        "gates",
        "push_policy",
        "stop_conditions",
        "output_contract",
        "permissions",
    ]
    missing = [key for key in required_top if key not in profile]
    if missing:
        raise ValueError(f"Profile missing required keys: {', '.join(missing)}")

    if not isinstance(profile["repos"], list) or not profile["repos"]:
        raise ValueError("Profile field 'repos' must be a non-empty list")

    tracker = profile["tracker"]
    if not isinstance(tracker, dict) or "path" not in tracker:
        raise ValueError("Profile field 'tracker.path' is required")

    queue = profile["queue"]
    if not isinstance(queue, dict):
        raise ValueError("Profile field 'queue' must be an object")

    if "tasks" not in queue or not isinstance(queue["tasks"], list) or not queue["tasks"]:
        raise ValueError("Profile field 'queue.tasks' must be a non-empty list")

    output_contract = profile["output_contract"]
    required_fields = output_contract.get("required_fields", [])
    if not isinstance(required_fields, list):
        raise ValueError("output_contract.required_fields must be a list")

    return profile


@dataclasses.dataclass
class Blocker(Exception):
    reason_code: str
    phase: str
    task_id: str | None
    message: str
    details: dict[str, Any]
    minimal_question: str


class RelayRuntime:
    def __init__(self, profile: dict[str, Any], profile_path: Path, mode: str, state_dir: Path):
        if mode not in RUN_MODES:
            raise ValueError(f"Unsupported mode: {mode}")
        self.profile = profile
        self.profile_path = profile_path
        self.mode = mode
        self.state_dir = state_dir
        ensure_dir(self.state_dir)

        self.paths = {
            "state": self.state_dir / "relay_state.json",
            "trace": self.state_dir / "relay_trace.jsonl",
            "next_prompt": self.state_dir / "next_prompt.md",
            "handoff_payload": self.state_dir / "handoff_payload.json",
            "verify_log": self.state_dir / "verification_log.txt",
            "review_meta": self.state_dir / "review_meta.json",
            "blocker": self.state_dir / "blocker_report.json",
        }

        self.script_root = Path(__file__).resolve().parents[1]
        self.default_template = self.script_root / "templates" / "next_prompt.md.j2"

        self.state = self._load_or_init_state()
        self._save_state()

    def _load_or_init_state(self) -> dict[str, Any]:
        state_path = self.paths["state"]
        if self.mode == "resume":
            if not state_path.exists():
                raise ValueError("resume mode requires existing relay_state.json")
            state = load_data(state_path, "json")
            if not isinstance(state, dict):
                raise ValueError("Invalid relay_state.json")
            state["mode"] = self.mode
            state["updated_at"] = now_iso()
            state.setdefault("round", 0)
            state.setdefault("history", [])
            state.setdefault("failure_count", 0)
            return state

        return {
            "project_id": self.profile["project_id"],
            "mode": self.mode,
            "machine_state": PHASE_IDLE,
            "current_task_id": None,
            "round": 0,
            "history": [],
            "failure_count": 0,
            "awaiting_launcher": False,
            "all_done": False,
            "blocker": None,
            "started_at": now_iso(),
            "updated_at": now_iso(),
        }

    def _trace(self, phase: str, event: str, **extra: Any) -> None:
        item = {
            "timestamp": now_iso(),
            "phase": phase,
            "event": event,
            "mode": self.mode,
            "project_id": self.profile["project_id"],
        }
        item.update(extra)
        append_jsonl(self.paths["trace"], item)

    def _save_state(self) -> None:
        self.state["updated_at"] = now_iso()
        write_json(self.paths["state"], self.state)

    def _set_phase(self, phase: str, task_id: str | None = None) -> None:
        self.state["machine_state"] = phase
        self.state["current_task_id"] = task_id
        self._save_state()

    def _block(self, blocker: Blocker) -> int:
        self._set_phase(PHASE_BLOCKED, blocker.task_id)
        self.state["failure_count"] = int(self.state.get("failure_count", 0)) + 1
        stop_cfg = self.profile.get("stop_conditions", {})
        max_failures = stop_cfg.get("max_failures")
        max_failures_exceeded = False
        if max_failures is not None:
            try:
                max_failures_exceeded = self.state["failure_count"] >= int(max_failures)
            except Exception:
                max_failures_exceeded = False
        human_on = set(str(item) for item in stop_cfg.get("require_human_on", []))
        requires_human = blocker.reason_code in human_on
        payload = {
            "state": PHASE_BLOCKED,
            "project_id": self.profile["project_id"],
            "timestamp": now_iso(),
            "phase": blocker.phase,
            "task_id": blocker.task_id,
            "reason_code": blocker.reason_code,
            "message": blocker.message,
            "details": blocker.details,
            "failure_count": self.state["failure_count"],
            "max_failures": max_failures,
            "max_failures_exceeded": max_failures_exceeded,
            "requires_human_intervention": requires_human,
            "minimal_decision_request": {
                "question": blocker.minimal_question,
                "options": [
                    {
                        "id": "retry",
                        "description": "Fix external condition then retry the same task.",
                    },
                    {
                        "id": "skip_task",
                        "description": "Explicitly approve skipping this task and continue.",
                    },
                    {
                        "id": "abort",
                        "description": "Stop relay and close this run.",
                    },
                ],
                "recommended_option": "retry",
            },
        }
        write_json(self.paths["blocker"], payload)
        self.state["blocker"] = payload
        self.state["awaiting_launcher"] = False
        self.state["all_done"] = False
        self._save_state()
        self._trace(PHASE_BLOCKED, "blocker", reason=blocker.reason_code, task_id=blocker.task_id)
        return 2

    def _check_permissions_for_repo(self, repo_path: Path) -> None:
        perms = self.profile.get("permissions", {})
        allow_paths = [Path(p).resolve() for p in perms.get("allow_paths", [])]
        deny_paths = [Path(p).resolve() for p in perms.get("deny_paths", [])]

        resolved = repo_path.resolve()
        def _under(base: Path, target: Path) -> bool:
            return target == base or target.is_relative_to(base)

        if allow_paths:
            if not any(_under(base, resolved) for base in allow_paths):
                raise Blocker(
                    reason_code="permission_denied",
                    phase=PHASE_PREFLIGHT,
                    task_id=None,
                    message=f"Repo path '{resolved}' is outside allow_paths",
                    details={"repo": str(resolved), "allow_paths": [str(p) for p in allow_paths]},
                    minimal_question="Approve expanding permissions.allow_paths to include this repo?",
                )

        if any(_under(base, resolved) for base in deny_paths):
            raise Blocker(
                reason_code="permission_denied",
                phase=PHASE_PREFLIGHT,
                task_id=None,
                message=f"Repo path '{resolved}' is under deny_paths",
                details={"repo": str(resolved), "deny_paths": [str(p) for p in deny_paths]},
                minimal_question="Should this run move to an allowed repo path?",
            )

    def _assert_command_allowed(self, command: str, phase: str, task_id: str | None) -> None:
        perms = self.profile.get("permissions", {})
        deny_patterns = [re.compile(p) for p in perms.get("deny_commands", [])]
        allow_patterns = [re.compile(p) for p in perms.get("allow_commands", [])]

        if any(pattern.search(command) for pattern in deny_patterns):
            raise Blocker(
                reason_code="permission_denied",
                phase=phase,
                task_id=task_id,
                message=f"Command denied by permissions.deny_commands: {command}",
                details={"command": command},
                minimal_question="Should permissions be updated to allow this command?",
            )

        if allow_patterns and not any(pattern.search(command) for pattern in allow_patterns):
            raise Blocker(
                reason_code="permission_denied",
                phase=phase,
                task_id=task_id,
                message=f"Command not allowed by allow_commands: {command}",
                details={"command": command},
                minimal_question="Approve this command by adding a matching allow_commands pattern?",
            )

    def _tracker_settings(self) -> tuple[Path, str, dict[str, Any]]:
        cfg = self.profile["tracker"]
        path = Path(cfg["path"]).expanduser()
        fmt = (cfg.get("format") or path.suffix.lstrip(".") or "json").lower()
        parse = cfg.get("parse", {})
        if not isinstance(parse, dict):
            parse = {}
        return path, fmt, parse

    def _load_tracker(self) -> tuple[dict[str, Any], list[dict[str, Any]], dict[str, str]]:
        path, fmt, parse = self._tracker_settings()
        data = load_data(path, fmt)
        tasks_key = parse.get("tasks_key", "tasks")
        id_field = parse.get("id_field", "id")

        tasks = data.get(tasks_key, []) if isinstance(data, dict) else []
        if not isinstance(tasks, list):
            raise Blocker(
                reason_code="tracker_parse_error",
                phase=PHASE_PREFLIGHT,
                task_id=None,
                message="Tracker tasks must be a list",
                details={"tracker_path": str(path), "tasks_key": tasks_key},
                minimal_question="Should tracker.parse.tasks_key be changed to the correct field?",
            )

        by_id: dict[str, str] = {}
        for item in tasks:
            if not isinstance(item, dict):
                continue
            task_id = str(item.get(id_field, "")).strip()
            if task_id:
                by_id[task_id] = task_id

        return data, tasks, {
            "tasks_key": tasks_key,
            "id_field": id_field,
            "status_field": parse.get("status_field", "status"),
            "milestone_field": parse.get("milestone_field", "milestone"),
            "description_field": parse.get("description_field", "description"),
        }

    def _save_tracker(self, tracker_data: dict[str, Any]) -> None:
        path, fmt, _ = self._tracker_settings()
        dump_data(path, tracker_data, fmt)

    def _load_board(self) -> tuple[dict[str, Any] | None, Path | None, str | None]:
        board = self.profile.get("board", {})
        board_path_raw = board.get("path")
        if not board_path_raw:
            return None, None, None
        path = Path(board_path_raw).expanduser()
        if not path.exists():
            return None, path, "json"
        fmt = (board.get("format") or path.suffix.lstrip(".") or "json").lower()
        data = load_data(path, fmt)
        return data, path, fmt

    def _save_board(self, board_data: dict[str, Any], path: Path, fmt: str) -> None:
        dump_data(path, board_data, fmt)

    def _canonical_from_board(self, status: str) -> str:
        status_map = self.profile.get("board", {}).get("status_map", {})
        reverse_map = {str(v): str(k) for k, v in status_map.items()}
        return reverse_map.get(status, status)

    def _board_from_canonical(self, status: str) -> str:
        status_map = self.profile.get("board", {}).get("status_map", {})
        return str(status_map.get(status, status))

    def _reconcile_board_tracker(
        self,
        tracker_data: dict[str, Any],
        tracker_tasks: list[dict[str, Any]],
        fields: dict[str, str],
        apply_changes: bool,
    ) -> list[dict[str, str]]:
        board_data, board_path, board_fmt = self._load_board()
        if board_data is None or board_path is None or board_fmt is None:
            return []

        board_tasks = board_data.get("tasks", []) if isinstance(board_data, dict) else []
        if not isinstance(board_tasks, list):
            return []

        tracker_status_field = fields["status_field"]
        tracker_id_field = fields["id_field"]
        board_status_field = self.profile.get("board", {}).get("status_field", "status")

        tracker_map: dict[str, str] = {}
        for task in tracker_tasks:
            tid = str(task.get(tracker_id_field, "")).strip()
            if tid:
                tracker_map[tid] = str(task.get(tracker_status_field, "todo"))

        mismatches: list[dict[str, str]] = []
        for item in board_tasks:
            if not isinstance(item, dict):
                continue
            tid = str(item.get("id", "")).strip()
            if not tid or tid not in tracker_map:
                continue
            board_raw = str(item.get(board_status_field, "todo"))
            board_canonical = self._canonical_from_board(board_raw)
            tracker_status = tracker_map[tid]
            if board_canonical != tracker_status:
                mismatches.append(
                    {
                        "task_id": tid,
                        "tracker_status": tracker_status,
                        "board_status": board_raw,
                    }
                )
                item[board_status_field] = self._board_from_canonical(tracker_status)

        if mismatches and apply_changes:
            self._save_board(board_data, board_path, board_fmt)
            self._trace(
                PHASE_PREFLIGHT,
                "board_tracker_reconciled",
                mismatch_count=len(mismatches),
                mismatches=mismatches,
            )
        elif mismatches:
            self._trace(
                PHASE_PREFLIGHT,
                "board_tracker_mismatch_detected",
                mismatch_count=len(mismatches),
                mismatches=mismatches,
            )

        return mismatches

    def _task_specs(self) -> tuple[list[str], dict[str, dict[str, Any]], dict[str, list[str]]]:
        queue = self.profile["queue"]
        tasks = queue.get("tasks", [])
        order = queue.get("order", [])
        dependencies = queue.get("dependencies", {})

        if not isinstance(tasks, list):
            raise ValueError("queue.tasks must be a list")

        by_id: dict[str, dict[str, Any]] = {}
        for task in tasks:
            if not isinstance(task, dict):
                continue
            task_id = str(task.get("id", "")).strip()
            if not task_id:
                continue
            by_id[task_id] = copy.deepcopy(task)

        if not order:
            order = list(by_id.keys())

        deps_by_id: dict[str, list[str]] = {k: [] for k in by_id}
        for task_id, task in by_id.items():
            depends_on = task.get("depends_on", [])
            if isinstance(depends_on, list):
                deps_by_id[task_id].extend([str(item) for item in depends_on])

        if isinstance(dependencies, dict):
            for task_id, dep_list in dependencies.items():
                if task_id not in deps_by_id:
                    continue
                if isinstance(dep_list, list):
                    deps_by_id[task_id] = [str(item) for item in dep_list]

        return [str(item) for item in order], by_id, deps_by_id

    def _task_status_map(self, tracker_tasks: list[dict[str, Any]], fields: dict[str, str]) -> dict[str, str]:
        status_map: dict[str, str] = {}
        for item in tracker_tasks:
            if not isinstance(item, dict):
                continue
            task_id = str(item.get(fields["id_field"], "")).strip()
            if not task_id:
                continue
            status_map[task_id] = str(item.get(fields["status_field"], "todo"))
        return status_map

    def _task_metadata(
        self,
        task_id: str | None,
        tracker_tasks: list[dict[str, Any]],
        fields: dict[str, str],
    ) -> dict[str, str]:
        if not task_id:
            return {"task_id": "", "milestone": "", "description": ""}
        for item in tracker_tasks:
            if str(item.get(fields["id_field"], "")).strip() != task_id:
                continue
            return {
                "task_id": task_id,
                "milestone": str(item.get(fields["milestone_field"], "")),
                "description": str(item.get(fields["description_field"], "")),
            }
        return {"task_id": task_id, "milestone": "", "description": ""}

    def _default_model(self) -> str:
        model_routing = self.profile.get("model_routing", {})
        if isinstance(model_routing, dict):
            configured_default = model_routing.get("default")
            if isinstance(configured_default, str) and configured_default.strip():
                return configured_default.strip()

        preferred = self.profile.get("preferred_models", {})
        if isinstance(preferred, dict):
            coding_model = preferred.get("coding_orchestration")
            if isinstance(coding_model, str) and coding_model.strip():
                return coding_model.strip()

        constraints = self.profile.get("gates", {}).get("model_constraints", [])
        if isinstance(constraints, list):
            for item in constraints:
                if isinstance(item, str) and item.strip():
                    return item.strip()
        return "gpt-5.3-codex-xhigh"

    def _select_model_for_task(
        self,
        task_id: str | None,
        tracker_tasks: list[dict[str, Any]],
        fields: dict[str, str],
    ) -> tuple[str, str]:
        selected = self._default_model()
        reason = "default"
        if not task_id:
            return selected, reason

        metadata = self._task_metadata(task_id, tracker_tasks, fields)
        model_routing = self.profile.get("model_routing", {})
        rules = []
        if isinstance(model_routing, dict):
            candidate_rules = model_routing.get("rules", [])
            if isinstance(candidate_rules, list):
                rules = candidate_rules

        for index, rule in enumerate(rules):
            if not isinstance(rule, dict):
                continue
            model = str(rule.get("model", "")).strip()
            if not model:
                continue

            matched = False

            ids = rule.get("task_ids")
            if isinstance(ids, list) and metadata["task_id"] in [str(x) for x in ids]:
                matched = True

            task_pattern = rule.get("task_pattern")
            if not matched and isinstance(task_pattern, str) and task_pattern:
                try:
                    matched = re.search(task_pattern, metadata["task_id"]) is not None
                except re.error:
                    matched = False

            milestone_pattern = rule.get("milestone_pattern")
            if (
                not matched
                and isinstance(milestone_pattern, str)
                and milestone_pattern
                and metadata["milestone"]
            ):
                try:
                    matched = re.search(milestone_pattern, metadata["milestone"]) is not None
                except re.error:
                    matched = False

            if matched:
                return model, f"model_routing.rules[{index}]"

        return selected, reason

    def _choose_next_task(
        self,
        order: list[str],
        deps_by_id: dict[str, list[str]],
        status_map: dict[str, str],
    ) -> str | None:
        stop_cfg = self.profile.get("stop_conditions", {})
        configured_blockers = stop_cfg.get("blocker_statuses", [CANONICAL_BLOCKED])
        blocker_statuses = {str(item) for item in configured_blockers}
        blocker_statuses.add(CANONICAL_BLOCKED)

        pending_found = False
        for task_id in order:
            status = status_map.get(task_id, "todo")
            if status == CANONICAL_DONE:
                continue
            if status in blocker_statuses:
                raise Blocker(
                    reason_code="upstream_task_blocked",
                    phase=PHASE_PREFLIGHT,
                    task_id=task_id,
                    message=f"Task '{task_id}' is blocked in tracker",
                    details={"task_id": task_id, "status": status},
                    minimal_question="Should this blocked task be manually resolved before continuing?",
                )

            pending_found = True
            deps = deps_by_id.get(task_id, [])
            if all(status_map.get(dep) == CANONICAL_DONE for dep in deps):
                return task_id

        if pending_found:
            unresolved = {
                task_id: [dep for dep in deps_by_id.get(task_id, []) if status_map.get(dep) != CANONICAL_DONE]
                for task_id in order
                if status_map.get(task_id) != CANONICAL_DONE
            }
            raise Blocker(
                reason_code="dependency_cycle_or_missing",
                phase=PHASE_PREFLIGHT,
                task_id=None,
                message="No runnable tasks found due to unresolved dependencies",
                details={"unresolved_dependencies": unresolved},
                minimal_question="Should queue.dependencies be corrected to break dependency deadlock?",
            )
        return None

    def _render_template(self, template_path: Path, context: dict[str, Any]) -> str:
        template = template_path.read_text(encoding="utf-8")

        def repl(match: re.Match[str]) -> str:
            key = match.group(1).strip()
            value = context.get(key, "")
            if isinstance(value, (dict, list)):
                return json.dumps(value, ensure_ascii=False)
            return str(value)

        return re.sub(r"\{\{\s*([^}]+?)\s*\}\}", repl, template)

    def _build_next_prompt(
        self,
        current_task_id: str | None,
        next_task_id: str | None,
        tracker_tasks: list[dict[str, Any]],
        fields: dict[str, str],
        selected_model: str | None = None,
        selected_model_reason: str | None = None,
    ) -> str:
        template_path = Path(
            self.profile.get("push_policy", {}).get("prompt_template", self.default_template)
        ).expanduser()
        if not template_path.exists():
            template_path = self.default_template

        milestone = ""
        description = ""
        if next_task_id:
            for item in tracker_tasks:
                if str(item.get(fields["id_field"], "")).strip() == next_task_id:
                    milestone = str(item.get(fields["milestone_field"], ""))
                    description = str(item.get(fields["description_field"], ""))
                    break

        pending = []
        status_map = self._task_status_map(tracker_tasks, fields)
        for task_id, status in status_map.items():
            if status != CANONICAL_DONE:
                pending.append(task_id)

        context = {
            "project_id": self.profile["project_id"],
            "generated_at": now_iso(),
            "current_task_id": current_task_id or "",
            "next_task_id": next_task_id or "",
            "next_task_milestone": milestone,
            "next_task_description": description,
            "selected_model": selected_model or "",
            "selected_model_reason": selected_model_reason or "",
            "mode": self.mode,
            "pending_tasks": ", ".join(pending),
            "profile_path": str(self.profile_path),
            "state_dir": str(self.state_dir),
        }
        return self._render_template(template_path, context)

    def _apply_env(self) -> dict[str, str]:
        env = os.environ.copy()
        inject = self.profile.get("push_policy", {}).get("env_inject", {})
        if isinstance(inject, dict):
            for key, value in inject.items():
                env[str(key)] = str(value)
        return env

    def _run_shell(self, command: str, cwd: Path, env: dict[str, str], phase: str, task_id: str | None) -> subprocess.CompletedProcess[str]:
        self._assert_command_allowed(command, phase, task_id)
        return subprocess.run(
            command,
            shell=True,
            cwd=str(cwd),
            env=env,
            capture_output=True,
            text=True,
        )

    def _retry_settings(self) -> tuple[int, int, float]:
        cfg = self.profile.get("gates", {}).get("command_retries", {})
        execute_max = 0
        verify_max = 0
        backoff_seconds = 0.0
        if isinstance(cfg, dict):
            try:
                execute_max = max(0, int(cfg.get("execute_max_retries", 0)))
            except Exception:
                execute_max = 0
            try:
                verify_max = max(0, int(cfg.get("verify_max_retries", 0)))
            except Exception:
                verify_max = 0
            try:
                backoff_seconds = max(0.0, float(cfg.get("backoff_seconds", 0.0)))
            except Exception:
                backoff_seconds = 0.0
        return execute_max, verify_max, backoff_seconds

    def _record_verification(self, command: str, result: subprocess.CompletedProcess[str]) -> None:
        body = [
            f"$ {command}",
            f"exit_code={result.returncode}",
            "[stdout]",
            result.stdout.rstrip(),
            "[stderr]",
            result.stderr.rstrip(),
            "",
        ]
        with self.paths["verify_log"].open("a", encoding="utf-8") as handle:
            handle.write("\n".join(body))

    def _update_tracker_task_status(
        self,
        tracker_data: dict[str, Any],
        tracker_tasks: list[dict[str, Any]],
        fields: dict[str, str],
        task_id: str,
        new_status: str,
    ) -> None:
        changed = False
        for task in tracker_tasks:
            if str(task.get(fields["id_field"], "")).strip() == task_id:
                task[fields["status_field"]] = new_status
                changed = True
                break
        if not changed:
            tracker_tasks.append(
                {
                    fields["id_field"]: task_id,
                    fields["status_field"]: new_status,
                }
            )
        tracker_data[fields["tasks_key"]] = tracker_tasks

    def _sync_board_task_status(self, task_id: str, new_status: str) -> None:
        board_data, board_path, board_fmt = self._load_board()
        if board_data is None or board_path is None or board_fmt is None:
            return
        tasks = board_data.get("tasks", [])
        if not isinstance(tasks, list):
            return
        status_field = self.profile.get("board", {}).get("status_field", "status")
        updated = False
        for item in tasks:
            if not isinstance(item, dict):
                continue
            if str(item.get("id", "")).strip() == task_id:
                item[status_field] = self._board_from_canonical(new_status)
                updated = True
                break
        if not updated:
            tasks.append({"id": task_id, status_field: self._board_from_canonical(new_status)})
        board_data["tasks"] = tasks
        self._save_board(board_data, board_path, board_fmt)

    def _review(self, task_id: str) -> dict[str, Any]:
        review_cfg = self.profile.get("gates", {}).get("review", {})
        required = bool(review_cfg.get("required", False))
        strategy = str(review_cfg.get("strategy", "stub"))
        constraints = self.profile.get("gates", {}).get("model_constraints", [])

        if not required:
            meta = {
                "timestamp": now_iso(),
                "task_id": task_id,
                "required": False,
                "strategy": strategy,
                "status": "skipped",
                "fallback_reason": None,
                "model_constraints": constraints,
            }
            write_json(self.paths["review_meta"], meta)
            return meta

        if strategy == "stub":
            meta = {
                "timestamp": now_iso(),
                "task_id": task_id,
                "required": True,
                "strategy": strategy,
                "status": "passed",
                "reviewers": [],
                "fallback_reason": None,
                "model_constraints": constraints,
            }
            write_json(self.paths["review_meta"], meta)
            return meta

        # Degrade unsupported strategies to stub to preserve unattended relay continuity.
        meta = {
            "timestamp": now_iso(),
            "task_id": task_id,
            "required": True,
            "strategy": "stub",
            "requested_strategy": strategy,
            "status": "degraded",
            "degraded_reason": "unsupported_review_strategy",
            "reviewers": [],
            "fallback_reason": None,
            "model_constraints": constraints,
        }
        write_json(self.paths["review_meta"], meta)
        self._trace(
            PHASE_REVIEW,
            "review_strategy_degraded",
            task_id=task_id,
            requested_strategy=strategy,
            actual_strategy="stub",
        )
        return meta

    def _validate_output_contract(self, round_result: dict[str, Any], task_id: str) -> list[str]:
        contract_cfg = self.profile.get("output_contract", {})
        required_fields = contract_cfg.get("required_fields", [])
        strict = bool(contract_cfg.get("strict", True))
        missing = [key for key in required_fields if key not in round_result]
        if missing:
            if strict:
                raise Blocker(
                    reason_code="output_contract_violation",
                    phase=PHASE_SYNC,
                    task_id=task_id,
                    message=f"Round result missing required fields: {', '.join(missing)}",
                    details={"required_fields": required_fields, "round_result": round_result},
                    minimal_question="Should output_contract.required_fields be updated or the result formatter fixed?",
                )
            self._trace(
                PHASE_SYNC,
                "output_contract_missing_nonblocking",
                task_id=task_id,
                missing_fields=missing,
            )
            return missing
        return []

    def _build_launch_command(self, prompt_path: Path, selected_model: str | None = None) -> str:
        profile_quoted = shlex.quote(str(self.profile_path))
        state_quoted = shlex.quote(str(self.state_dir))
        prompt_quoted = shlex.quote(str(prompt_path))
        cwd_quoted = shlex.quote(str(Path.cwd()))
        script_quoted = shlex.quote(str(Path(__file__).resolve()))
        model_env = ""
        if selected_model:
            model_quoted = shlex.quote(selected_model)
            model_env = f"AUTO_RELAY_MODEL={model_quoted} "
        return (
            f"cd {cwd_quoted} && {model_env}AUTO_RELAY_PROMPT={prompt_quoted} "
            f"python {script_quoted} --profile {profile_quoted} --mode resume --state-dir {state_quoted}"
        )

    def _handoff(
        self,
        current_task_id: str | None,
        next_task_id: str | None,
        tracker_tasks: list[dict[str, Any]],
        fields: dict[str, str],
    ) -> tuple[bool, bool]:
        """Returns (continue_inline, awaiting_launcher)."""
        selected_model: str | None = None
        selected_model_reason: str | None = None
        if next_task_id:
            selected_model, selected_model_reason = self._select_model_for_task(
                next_task_id, tracker_tasks, fields
            )

        prompt_text = self._build_next_prompt(
            current_task_id,
            next_task_id,
            tracker_tasks,
            fields,
            selected_model=selected_model,
            selected_model_reason=selected_model_reason,
        )
        write_text(self.paths["next_prompt"], prompt_text)

        launcher_cfg = self.profile.get("push_policy", {}).get("session_launcher", {})
        launcher_mode = str(launcher_cfg.get("mode", "command"))
        launcher_cmd = str(launcher_cfg.get("command", "")).strip()

        if not next_task_id:
            payload = {
                "timestamp": now_iso(),
                "project_id": self.profile["project_id"],
                "current_task_id": current_task_id,
                "next_task_id": None,
                "prompt_file": str(self.paths["next_prompt"]),
                "launch_command": "",
                "selected_model": None,
                "selected_model_reason": None,
                "awaiting_launcher": False,
                "degraded_reason": None,
                "completed": True,
            }
            write_json(self.paths["handoff_payload"], payload)
            self._trace(PHASE_HANDOFF, "relay_complete")
            return False, False

        # plan/dry-run/handoff-only never fire external launcher.
        if self.mode in {"plan", "dry-run", "handoff-only"}:
            payload = {
                "timestamp": now_iso(),
                "project_id": self.profile["project_id"],
                "current_task_id": current_task_id,
                "next_task_id": next_task_id,
                "prompt_file": str(self.paths["next_prompt"]),
                "launch_command": self._build_launch_command(
                    self.paths["next_prompt"], selected_model
                ),
                "selected_model": selected_model,
                "selected_model_reason": selected_model_reason,
                "awaiting_launcher": self.mode == "handoff-only",
                "degraded_reason": (
                    "handoff_only_mode" if self.mode == "handoff-only" else None
                ),
                "completed": False,
            }
            write_json(self.paths["handoff_payload"], payload)
            self._trace(PHASE_HANDOFF, "handoff_prepared", next_task_id=next_task_id)
            return False, payload["awaiting_launcher"]

        if launcher_mode == "inline" or launcher_cmd.startswith("inline://"):
            payload = {
                "timestamp": now_iso(),
                "project_id": self.profile["project_id"],
                "current_task_id": current_task_id,
                "next_task_id": next_task_id,
                "prompt_file": str(self.paths["next_prompt"]),
                "launch_command": "inline://continue",
                "selected_model": selected_model,
                "selected_model_reason": selected_model_reason,
                "awaiting_launcher": False,
                "degraded_reason": None,
                "completed": False,
            }
            write_json(self.paths["handoff_payload"], payload)
            self._trace(PHASE_HANDOFF, "handoff_inline_continue", next_task_id=next_task_id)
            return True, False

        if launcher_mode == "command" and launcher_cmd:
            env = self._apply_env()
            command = launcher_cmd.format(
                cwd=str(Path.cwd()),
                prompt_file=str(self.paths["next_prompt"]),
                profile=str(self.profile_path),
                state_dir=str(self.state_dir),
                model=shlex.quote(selected_model) if selected_model else "",
                model_reason=selected_model_reason or "",
            )
            try:
                self._assert_command_allowed(command, PHASE_HANDOFF, next_task_id)
            except Blocker as permission_block:
                if permission_block.reason_code != "permission_denied":
                    raise
                degraded_reason = "launcher_permission_denied"
                fallback = self._build_launch_command(self.paths["next_prompt"], selected_model)
                payload = {
                    "timestamp": now_iso(),
                    "project_id": self.profile["project_id"],
                    "current_task_id": current_task_id,
                    "next_task_id": next_task_id,
                    "prompt_file": str(self.paths["next_prompt"]),
                    "launch_command": fallback,
                    "selected_model": selected_model,
                    "selected_model_reason": selected_model_reason,
                    "awaiting_launcher": True,
                    "degraded_reason": degraded_reason,
                    "launcher_permission_error": permission_block.message,
                    "completed": False,
                }
                write_json(self.paths["handoff_payload"], payload)
                self._trace(
                    PHASE_HANDOFF,
                    "handoff_degraded",
                    reason=degraded_reason,
                    message=permission_block.message,
                )
                return False, True
            launched = subprocess.run(
                command,
                shell=True,
                capture_output=True,
                text=True,
                env=env,
            )
            if launched.returncode == 0:
                payload = {
                    "timestamp": now_iso(),
                    "project_id": self.profile["project_id"],
                    "current_task_id": current_task_id,
                    "next_task_id": next_task_id,
                    "prompt_file": str(self.paths["next_prompt"]),
                    "launch_command": command,
                    "selected_model": selected_model,
                    "selected_model_reason": selected_model_reason,
                    "awaiting_launcher": False,
                    "degraded_reason": None,
                    "completed": False,
                }
                write_json(self.paths["handoff_payload"], payload)
                self._trace(PHASE_HANDOFF, "handoff_launcher_executed", next_task_id=next_task_id)
                return False, False

            degraded_reason = f"launcher_command_failed_exit_{launched.returncode}"
            fallback = self._build_launch_command(self.paths["next_prompt"], selected_model)
            payload = {
                "timestamp": now_iso(),
                "project_id": self.profile["project_id"],
                "current_task_id": current_task_id,
                "next_task_id": next_task_id,
                "prompt_file": str(self.paths["next_prompt"]),
                "launch_command": fallback,
                "selected_model": selected_model,
                "selected_model_reason": selected_model_reason,
                "awaiting_launcher": True,
                "degraded_reason": degraded_reason,
                "launcher_stderr": launched.stderr,
                "completed": False,
            }
            write_json(self.paths["handoff_payload"], payload)
            self._trace(PHASE_HANDOFF, "handoff_degraded", reason=degraded_reason)
            return False, True

        degraded_reason = "no_session_launcher_available"
        payload = {
            "timestamp": now_iso(),
            "project_id": self.profile["project_id"],
            "current_task_id": current_task_id,
            "next_task_id": next_task_id,
            "prompt_file": str(self.paths["next_prompt"]),
            "launch_command": self._build_launch_command(self.paths["next_prompt"], selected_model),
            "selected_model": selected_model,
            "selected_model_reason": selected_model_reason,
            "awaiting_launcher": True,
            "degraded_reason": degraded_reason,
            "completed": False,
        }
        write_json(self.paths["handoff_payload"], payload)
        self._trace(PHASE_HANDOFF, "handoff_degraded", reason=degraded_reason)
        return False, True

    def _preflight(self) -> tuple[dict[str, Any], list[dict[str, Any]], dict[str, str], list[str], dict[str, dict[str, Any]], dict[str, list[str]]]:
        self._set_phase(PHASE_PREFLIGHT)

        for repo in self.profile["repos"]:
            repo_path = Path(str(repo)).expanduser()
            self._check_permissions_for_repo(repo_path)

        tracker_data, tracker_tasks, fields = self._load_tracker()
        order, specs, deps = self._task_specs()

        apply_reconcile = self.mode in {"run", "resume"}
        self._reconcile_board_tracker(
            tracker_data=tracker_data,
            tracker_tasks=tracker_tasks,
            fields=fields,
            apply_changes=apply_reconcile,
        )
        if apply_reconcile:
            # Persist tracker as the single source of truth after preflight reconciliation.
            self._save_tracker(tracker_data)

        self._trace(PHASE_PREFLIGHT, "preflight_ok", queue_size=len(order))
        return tracker_data, tracker_tasks, fields, order, specs, deps

    def _write_non_exec_placeholders(self, task_id: str | None) -> None:
        if not self.paths["verify_log"].exists():
            write_text(
                self.paths["verify_log"],
                f"[{now_iso()}] mode={self.mode}; no execution/verification in this mode\n",
            )
        if not self.paths["review_meta"].exists():
            meta = {
                "timestamp": now_iso(),
                "task_id": task_id,
                "required": False,
                "strategy": "none",
                "status": "skipped",
                "fallback_reason": None,
            }
            write_json(self.paths["review_meta"], meta)

    def _run_execute(self, task_id: str, task_spec: dict[str, Any]) -> None:
        self._set_phase(PHASE_EXECUTE, task_id)
        commands = task_spec.get("execute", [])
        if isinstance(commands, str):
            commands = [commands]
        if not isinstance(commands, list):
            commands = []

        if self.mode == "plan":
            self._trace(PHASE_EXECUTE, "plan_mode_skip_execute", task_id=task_id)
            return

        if self.mode == "dry-run":
            self._trace(PHASE_EXECUTE, "dry_run_skip_execute", task_id=task_id, commands=commands)
            return

        if self.mode == "handoff-only":
            self._trace(PHASE_EXECUTE, "handoff_only_skip_execute", task_id=task_id)
            return

        repo_cwd = Path(str(self.profile["repos"][0])).expanduser()
        env = self._apply_env()
        execute_max_retries, _, backoff_seconds = self._retry_settings()

        for command in commands:
            total_attempts = execute_max_retries + 1
            result: subprocess.CompletedProcess[str] | None = None
            for attempt in range(1, total_attempts + 1):
                result = self._run_shell(command, repo_cwd, env, PHASE_EXECUTE, task_id)
                self._trace(
                    PHASE_EXECUTE,
                    "command_executed",
                    task_id=task_id,
                    command=command,
                    attempt=attempt,
                    max_attempts=total_attempts,
                    exit_code=result.returncode,
                )
                if result.returncode == 0:
                    break
                if attempt < total_attempts:
                    delay = backoff_seconds * (2 ** (attempt - 1))
                    self._trace(
                        PHASE_EXECUTE,
                        "command_retry_scheduled",
                        task_id=task_id,
                        command=command,
                        next_attempt=attempt + 1,
                        delay_seconds=delay,
                    )
                    if delay > 0:
                        time.sleep(delay)

            assert result is not None
            if result.returncode != 0:
                raise Blocker(
                    reason_code="command_failed",
                    phase=PHASE_EXECUTE,
                    task_id=task_id,
                    message=f"Task command failed (exit {result.returncode})",
                    details={
                        "command": command,
                        "stdout": result.stdout,
                        "stderr": result.stderr,
                        "exit_code": result.returncode,
                        "max_attempts": total_attempts,
                    },
                    minimal_question=f"Retry task '{task_id}' after fixing the command failure?",
                )

    def _run_verify(self, task_id: str) -> None:
        self._set_phase(PHASE_VERIFY, task_id)
        verify_commands = self.profile.get("gates", {}).get("verify_commands", [])
        if not isinstance(verify_commands, list):
            verify_commands = []

        if self.mode in {"plan", "dry-run", "handoff-only"}:
            write_text(self.paths["verify_log"], f"[{now_iso()}] mode={self.mode}; verify skipped\n")
            self._trace(PHASE_VERIFY, "verify_skipped", mode=self.mode, task_id=task_id)
            return

        if not verify_commands:
            write_text(self.paths["verify_log"], f"[{now_iso()}] no verify_commands configured\n")
            self._trace(PHASE_VERIFY, "verify_no_commands", task_id=task_id)
            return

        repo_cwd = Path(str(self.profile["repos"][0])).expanduser()
        env = self._apply_env()
        _, verify_max_retries, backoff_seconds = self._retry_settings()

        for command in verify_commands:
            total_attempts = verify_max_retries + 1
            result: subprocess.CompletedProcess[str] | None = None
            for attempt in range(1, total_attempts + 1):
                result = self._run_shell(command, repo_cwd, env, PHASE_VERIFY, task_id)
                self._record_verification(command, result)
                self._trace(
                    PHASE_VERIFY,
                    "verify_command_executed",
                    task_id=task_id,
                    command=command,
                    attempt=attempt,
                    max_attempts=total_attempts,
                    exit_code=result.returncode,
                )
                if result.returncode == 0:
                    break
                if attempt < total_attempts:
                    delay = backoff_seconds * (2 ** (attempt - 1))
                    self._trace(
                        PHASE_VERIFY,
                        "verify_retry_scheduled",
                        task_id=task_id,
                        command=command,
                        next_attempt=attempt + 1,
                        delay_seconds=delay,
                    )
                    if delay > 0:
                        time.sleep(delay)

            assert result is not None
            if result.returncode != 0:
                raise Blocker(
                    reason_code="verification_failed",
                    phase=PHASE_VERIFY,
                    task_id=task_id,
                    message=f"Verification command failed (exit {result.returncode})",
                    details={
                        "command": command,
                        "exit_code": result.returncode,
                        "stdout": result.stdout,
                        "stderr": result.stderr,
                        "max_attempts": total_attempts,
                    },
                    minimal_question=f"Fix verification failure for task '{task_id}' and retry?",
                )

    def _run_review(self, task_id: str) -> None:
        self._set_phase(PHASE_REVIEW, task_id)
        if self.mode == "handoff-only":
            meta = {
                "timestamp": now_iso(),
                "task_id": task_id,
                "required": False,
                "strategy": "none",
                "status": "skipped",
                "fallback_reason": None,
            }
            write_json(self.paths["review_meta"], meta)
            self._trace(PHASE_REVIEW, "review_skipped_handoff_only", task_id=task_id)
            return

        meta = self._review(task_id)
        self._trace(PHASE_REVIEW, "review_recorded", task_id=task_id, status=meta.get("status"))

    def _run_sync(
        self,
        task_id: str,
        tracker_data: dict[str, Any],
        tracker_tasks: list[dict[str, Any]],
        fields: dict[str, str],
    ) -> None:
        self._set_phase(PHASE_SYNC, task_id)

        if self.mode not in {"plan", "handoff-only"}:
            self._update_tracker_task_status(
                tracker_data=tracker_data,
                tracker_tasks=tracker_tasks,
                fields=fields,
                task_id=task_id,
                new_status=CANONICAL_DONE,
            )
            self._save_tracker(tracker_data)
            self._sync_board_task_status(task_id, CANONICAL_DONE)

        round_result = {
            "timestamp": now_iso(),
            "task_id": task_id,
            "phase": PHASE_SYNC,
            "status": "done" if self.mode != "plan" else "planned",
            "mode": self.mode,
        }
        missing_optional = self._validate_output_contract(round_result, task_id)
        if missing_optional:
            round_result["output_contract_missing"] = missing_optional
        self.state["history"].append(round_result)
        self._save_state()
        self._trace(PHASE_SYNC, "sync_complete", task_id=task_id)

    def run(self) -> int:
        try:
            tracker_data, tracker_tasks, fields, order, specs, deps = self._preflight()

            while True:
                status_map = self._task_status_map(tracker_tasks, fields)
                next_task = self._choose_next_task(order, deps, status_map)

                if next_task is None:
                    self._write_non_exec_placeholders(None)
                    self._set_phase(PHASE_HANDOFF, None)
                    _, awaiting = self._handoff(None, None, tracker_tasks, fields)
                    self.state["awaiting_launcher"] = awaiting
                    self.state["all_done"] = True
                    self.state["machine_state"] = PHASE_IDLE
                    self._save_state()
                    return 0

                if next_task not in specs:
                    raise Blocker(
                        reason_code="queue_task_missing_spec",
                        phase=PHASE_PREFLIGHT,
                        task_id=next_task,
                        message=f"Task '{next_task}' exists in order but not in queue.tasks",
                        details={"task_id": next_task},
                        minimal_question="Should queue.tasks include this missing task definition?",
                    )

                self.state["round"] = int(self.state.get("round", 0)) + 1
                self._save_state()

                if self.mode == "handoff-only":
                    self._write_non_exec_placeholders(next_task)
                    self._set_phase(PHASE_HANDOFF, next_task)
                    _, awaiting = self._handoff(None, next_task, tracker_tasks, fields)
                    self.state["awaiting_launcher"] = awaiting
                    self.state["all_done"] = False
                    self._save_state()
                    return 0

                if self.mode == "plan":
                    self._write_non_exec_placeholders(next_task)
                    self._set_phase(PHASE_HANDOFF, next_task)
                    _, awaiting = self._handoff(None, next_task, tracker_tasks, fields)
                    self.state["awaiting_launcher"] = awaiting
                    self.state["all_done"] = False
                    self._save_state()
                    return 0

                task_spec = specs[next_task]
                self._run_execute(next_task, task_spec)
                self._run_verify(next_task)
                self._run_review(next_task)
                self._run_sync(next_task, tracker_data, tracker_tasks, fields)

                status_map = self._task_status_map(tracker_tasks, fields)
                upcoming = self._choose_next_task(order, deps, status_map)

                self._set_phase(PHASE_HANDOFF, next_task)
                continue_inline, awaiting = self._handoff(next_task, upcoming, tracker_tasks, fields)
                self.state["awaiting_launcher"] = awaiting
                self.state["all_done"] = upcoming is None
                self._save_state()

                if awaiting:
                    return 0
                if not continue_inline:
                    return 0

                # Inline mode simulates opening the next session by immediately
                # continuing the state machine within the same process.
                self._trace(PHASE_HANDOFF, "inline_session_transition", from_task=next_task, to_task=upcoming)
                continue

        except Blocker as blocker:
            return self._block(blocker)
        except Exception as exc:  # pragma: no cover - guardrail path
            fallback = Blocker(
                reason_code="unhandled_exception",
                phase=self.state.get("machine_state", PHASE_PREFLIGHT),
                task_id=self.state.get("current_task_id"),
                message=str(exc),
                details={"traceback": traceback.format_exc()},
                minimal_question="Should the run stop and request manual inspection of the exception?",
            )
            return self._block(fallback)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Auto relay orchestrator")
    parser.add_argument("--profile", required=True, help="Path to profile YAML/JSON")
    parser.add_argument(
        "--mode",
        required=True,
        choices=sorted(RUN_MODES),
        help="Execution mode",
    )
    parser.add_argument(
        "--state-dir",
        required=False,
        default=".auto-relay",
        help="Directory for relay artifacts",
    )
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)

    profile_path = Path(args.profile).expanduser().resolve()
    state_dir = Path(args.state_dir).expanduser().resolve()

    profile = load_profile(profile_path)
    runtime = RelayRuntime(profile=profile, profile_path=profile_path, mode=args.mode, state_dir=state_dir)
    return runtime.run()


if __name__ == "__main__":
    raise SystemExit(main())
