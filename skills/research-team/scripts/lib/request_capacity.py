"""Bind bounded requests to conservative bytes or actual observed usage.

The window is caller configured. Captured Claude events provide a compaction
witness; other routes have no equivalent event witness here.
"""
from __future__ import annotations

import json
import hashlib
import sys
from pathlib import Path

_CAPTURE_BIN = Path(__file__).resolve().parents[3] / "review-swarm/scripts/bin"
if str(_CAPTURE_BIN) not in sys.path:
    sys.path.insert(0, str(_CAPTURE_BIN))
from runtime_capture_observation import verify_capture_observation
from complete_assistant_text import validate_stream_report

PROTOCOL_RESERVE = 8192
OUTPUT_RESERVE = 32768


def request_budgets(context_tokens: int = 200000, context_bytes: int | None = None) -> dict:
    if type(context_tokens) is not int or context_tokens <= PROTOCOL_RESERVE + OUTPUT_RESERVE:
        raise ValueError("unavailable: invalid configured request token window")
    if context_bytes is None:
        context_bytes = min(160000, context_tokens - PROTOCOL_RESERVE - OUTPUT_RESERVE)
    if type(context_bytes) is not int or context_bytes < 12000:
        raise ValueError("unavailable: invalid configured request byte budget")
    return {"context_tokens": context_tokens, "context_bytes": context_bytes}


def validate_request_bytes(system: str, prompt: str, budgets: dict) -> int:
    bound = len(system.encode("utf-8")) + len(prompt.encode("utf-8")) + PROTOCOL_RESERVE
    if bound > budgets["context_bytes"]:
        raise ValueError("unavailable: complete original request exceeds configured byte budget; no truncation")
    return bound


def _per_call_usage(stream: Path) -> list[dict]:
    """Window occupancy of each model call in one stream: the result event sums all calls of a
    multi-turn session, so each call's own message_delta usage is read instead."""
    observed = []
    for line in stream.read_text(encoding="utf-8").splitlines():
        try:
            event = json.loads(line)
        except json.JSONDecodeError:
            continue
        inner = event.get("event") if isinstance(event, dict) and event.get("type") == "stream_event" else None
        usage = inner.get("usage") if isinstance(inner, dict) and inner.get("type") == "message_delta" else None
        if not isinstance(usage, dict):
            continue
        fields = [usage.get(k, 0) for k in ("input_tokens", "cache_creation_input_tokens", "cache_read_input_tokens")]
        emitted = usage.get("output_tokens", 0)
        if any(type(n) is not int or n < 0 for n in fields) or type(emitted) is not int or emitted < 0:
            raise ValueError("unavailable: invalid per-call usage in the original capture")
        observed.append({"input_tokens": sum(fields), "output_tokens": emitted})
    return observed


def validate_request_capacity(system: str, prompt: str, invocation: dict, budgets: dict, *, expected_working_directory: str | Path | None = None, usage_per_call: bool = False) -> dict:
    """With usage_per_call, a multi-turn session (e.g. a comparator reading frozen files) is bounded by
    each model call's own usage; without per-call records it falls back to the summed result usage."""
    bound = validate_request_bytes(system, prompt, budgets)
    if type(invocation.get("exit_code")) is not int or invocation["exit_code"] != 0:
        raise ValueError("unavailable: actual request invocation did not complete successfully")
    output = Path(invocation["output"])
    observations = []
    capture_root = None
    receipt_path = None
    meta_path = output.parent / "meta.json"
    if meta_path.is_file():
        meta = json.loads(meta_path.read_text(encoding="utf-8"))
        agents = meta.get("agents", [])
        if len(agents) != 1 or agents[0].get("success") is not True or Path(agents[0].get("out", "")).resolve() != output.resolve():
            raise ValueError("unavailable: request capture belongs to another or failed invocation")
        receipt = agents[0].get("capture_receipt")
        if receipt:
            receipt_path = Path(receipt)
            capture_root = Path(receipt).parent
            if not Path(receipt).is_file() or not capture_root.resolve().is_relative_to(output.parent.resolve()):
                raise ValueError("unavailable: original capture receipt is missing or outside this invocation")
            budget = json.loads(Path(receipt).read_text(encoding="utf-8"))
            original_hashes = sorted(hashlib.sha256(text.encode("utf-8")).hexdigest() for text in (system, prompt))
            attempts = budget.get("attempts")
            if (budget.get("status") != "completed" or type(budget.get("runner_exit_code")) is not int
                    or budget["runner_exit_code"] != 0 or not isinstance(budget.get("input_sha256"), list)
                    or sorted(budget["input_sha256"]) != original_hashes or not isinstance(attempts, list)
                    or not any(isinstance(a, dict) and a.get("status") == "exited" and type(a.get("exit_code")) is int and a["exit_code"] == 0 for a in attempts)):
                raise ValueError("unavailable: capacity receipt is not the exact successful original request")
    original_hashes = sorted(hashlib.sha256(text.encode("utf-8")).hexdigest() for text in (system, prompt))
    observation = verify_capture_observation(receipt_path, output, original_hashes,
        str(expected_working_directory) if expected_working_directory is not None else None,
        expected_context_tokens=budgets["context_tokens"])
    event_files = list(capture_root.glob("*.events.jsonl")) if capture_root else []
    result_files = []
    stream = None
    if capture_root is not None:
        complete = validate_stream_report(capture_root, output.read_bytes().decode("utf-8"))
        if observation.get("complete_output") != complete:
            raise ValueError("unavailable: complete output is not bound by the original runtime observation")
        result_files = [capture_root / complete["terminal"]]
        stream = capture_root / complete["events"]
    for file in event_files:
        for line in file.read_text(encoding="utf-8").splitlines():
            try:
                event = json.loads(line)
            except json.JSONDecodeError:
                continue
            if event.get("type") == "system" and "compact" in str(event.get("subtype", "")).lower():
                raise ValueError("unavailable: original request context was observably compacted")
    if usage_per_call and stream is not None:
        observations = _per_call_usage(stream)
    for file in result_files if not observations else []:
        event = json.loads(file.read_text(encoding="utf-8"))
        if event.get("type") != "result" or event.get("is_error") is not False:
            continue
        usage = event.get("usage", {})
        fields = [usage.get(k, 0) for k in ("input_tokens", "cache_creation_input_tokens", "cache_read_input_tokens")]
        emitted = usage.get("output_tokens", 0)
        if any(type(n) is not int or n < 0 for n in fields) or type(emitted) is not int or emitted <= 0 or sum(fields) <= 0:
            continue
        observations.append({"input_tokens": sum(fields), "output_tokens": emitted})
    if any(item["input_tokens"] + item["output_tokens"] > budgets["context_tokens"] for item in observations):
        raise ValueError("unavailable: observed request usage exceeds configured token window")
    if not observations and bound + OUTPUT_RESERVE > budgets["context_tokens"]:
        raise ValueError("unavailable: larger original request has no observed token capacity witness")
    return {**budgets, "conservative_input_bound": bound, "observed_usage": observations,
            "capacity_evidence": "observed_usage" if observations else "conservative_configured_bound",
            "compaction_witness": "captured_claude_events" if event_files else "unavailable",
            "usage_scope": "per_call" if usage_per_call and stream is not None and observations else "result",
            "capture_stream": str(stream) if stream is not None else None}
