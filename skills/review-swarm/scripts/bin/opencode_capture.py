"""Reconstruct the final report from the supervised OpenCode responses."""

import hashlib
import json
from pathlib import Path


def _events(path: Path) -> list[dict]:
    events = []
    for line in path.read_text(encoding="utf-8").split("\n"):
        if not line.strip():
            continue
        item = json.loads(line)
        if not isinstance(item, dict) or item.get("type") == "error" or item.get("error"):
            raise ValueError("unavailable: invalid OpenCode response event")
        part = item.get("part")
        if item.get("type") == "compaction" or isinstance(part, dict) and part.get("type") == "compaction":
            raise ValueError("unavailable: observed OpenCode context compaction")
        events.append(item)
    return events


def _step_usage(part: dict) -> dict | None:
    tokens = part.get("tokens")
    if tokens is None:
        return None
    if not isinstance(tokens, dict) or not isinstance(tokens.get("cache"), dict):
        raise ValueError("unavailable: invalid OpenCode step token usage")
    inputs = [tokens.get("input"), tokens["cache"].get("read"), tokens["cache"].get("write")]
    outputs = [tokens.get("output"), tokens.get("reasoning")]
    total = tokens.get("total")
    if any(type(value) is not int or value < 0 for value in inputs + outputs) or (
        total is not None and (type(total) is not int or total < 0)
    ):
        raise ValueError("unavailable: invalid OpenCode step token usage")
    # OpenCode normalizes input and output to exclude cached and reasoning tokens.
    input_tokens, output_tokens = sum(inputs), sum(outputs)
    window_tokens = max(total or 0, input_tokens + output_tokens)
    if window_tokens == 0:
        return None
    return {"window_tokens": window_tokens, "input_tokens": input_tokens, "output_tokens": output_tokens}


def validate_opencode_capture(root: Path, report: str) -> tuple[list[Path], dict]:
    budget_path = root / "budget.json"
    if budget_path.is_symlink():
        raise ValueError("unavailable: linked OpenCode capture budget")
    budget = json.loads(budget_path.read_text(encoding="utf-8"))
    attempts = budget.get("attempts")
    if not isinstance(attempts, list) or not 1 <= len(attempts) <= 3:
        raise ValueError("unavailable: unsupported OpenCode capture attempt count")
    model = attempts[0].get("requested_model") if isinstance(attempts[0], dict) else None
    session = None
    messages = set()
    files = []
    usage = []
    text = ""
    for i, attempt in enumerate(attempts, 1):
        stdout, stderr = root / f"attempt_{i}.stdout", root / f"attempt_{i}.stderr"
        if (not isinstance(attempt, dict) or attempt.get("index") != i or attempt.get("status") != "exited"
                or type(attempt.get("exit_code")) is not int or attempt["exit_code"] != 0
                or attempt.get("requested_model") != model or attempt.get("stdout") != stdout.name
                or attempt.get("stderr") != stderr.name or not stderr.is_file()
                or stdout.is_symlink() or stderr.is_symlink()):
            raise ValueError("unavailable: unsuccessful or mixed OpenCode capture attempts")
        files.extend((stdout, stderr))
        events = _events(stdout)
        activity = [item for item in events if item.get("type") in {"step_start", "step_finish", "text", "reasoning", "tool_use"}]
        finish = activity[-1] if activity else {}
        finish_part = finish.get("part")
        reason = "length" if i < len(attempts) else "stop"
        if finish.get("type") != "step_finish" or not isinstance(finish_part, dict) or finish_part.get("reason") != reason:
            raise ValueError("unavailable: OpenCode response lacks its expected terminal event")
        sid = finish.get("sessionID")
        if not isinstance(sid, str) or not sid or (session is not None and sid != session):
            raise ValueError("unavailable: missing or foreign OpenCode response session")
        session = sid
        message = finish_part.get("messageID")
        if not isinstance(message, str) or not message or message in messages:
            raise ValueError("unavailable: missing or replayed OpenCode terminal message ID")
        messages.add(message)
        for item in events:
            part = item.get("part")
            part_id = part.get("sessionID") if isinstance(part, dict) else None
            if item.get("sessionID") not in (None, session) or part_id not in (None, session):
                raise ValueError("unavailable: foreign event in OpenCode session")
            if item.get("type") == "step_finish" and isinstance(part, dict):
                usage.append(_step_usage(part))
        if i == len(attempts):
            chunks = [item["part"]["text"] for item in events if item.get("type") == "text"
                      and isinstance(item.get("part"), dict) and isinstance(item["part"].get("text"), str)
                      and item["part"].get("messageID") == message]
            text = "".join(chunks)
    if len(attempts) > 1:
        prompt = root / "continuation_prompt.log"
        if prompt.is_symlink() or not prompt.read_text(encoding="utf-8").strip():
            raise ValueError("unavailable: missing OpenCode continuation prompt")
        files.append(prompt)
    if set(root.iterdir()) != {*files, budget_path}:
        raise ValueError("unavailable: unexpected OpenCode capture material")
    if not text.strip() or report != text:
        raise ValueError("unavailable: OpenCode report differs from the complete final response")
    return files, {"protocol": "opencode_review_stream_json", "responses": len(attempts),
                   "session_id": session, "provider_terminal_event": True,
                   "report_text_sha256": hashlib.sha256(text.encode()).hexdigest(), "step_usage": usage}
