"""Lossless ordered assistant text; raw tool/thinking events remain in the log."""
from __future__ import annotations
import hashlib
import json
import re
from collections import OrderedDict
from pathlib import Path


class CompleteTextError(ValueError):
    pass


class AssistantText:
    def __init__(self):
        self.messages = OrderedDict()
        self.active = None
        self.terminal = None
        self.error_seen = False
        self.identities = {}
        self.last_started = {}
        self.provider_stops = []

    def _message(self, identity):
        if not isinstance(identity, str) or not identity:
            raise CompleteTextError("assistant message identity missing")
        return self.messages.setdefault(identity, {})

    def _block(self, identity, index):
        if type(index) is not int or index < 0:
            raise CompleteTextError("invalid content block index")
        return self._message(identity).setdefault(index, {"kind": None, "snapshot": None,
                                                        "delta": "", "stopped": False})

    @staticmethod
    def _text(block):
        snapshot, delta = block["snapshot"], block["delta"]
        try:
            delta.encode("utf-8")
            if snapshot is not None:
                snapshot.encode("utf-8")
        except UnicodeError as exc:
            raise CompleteTextError("assistant text is not valid UTF-8") from exc
        if snapshot is None:
            return delta
        if snapshot.startswith(delta):
            return snapshot
        if delta.startswith(snapshot):
            return delta
        raise CompleteTextError("snapshot and deltas disagree")

    def add(self, record):
        try:
            return self._add(record)
        except CompleteTextError:
            self.error_seen = True
            raise

    def _add(self, record):
        if not isinstance(record, dict):
            raise CompleteTextError("stream record is not an object")
        identity = record.get("uuid")
        if isinstance(identity, str) and identity:
            fingerprint = json.dumps(record, ensure_ascii=False, sort_keys=True)
            if identity in self.identities:
                if self.identities[identity] != fingerprint:
                    raise CompleteTextError("changed event with repeated identity")
                return False
            self.identities[identity] = fingerprint
        kind = record.get("type")
        if self.terminal is not None and kind in ("assistant", "stream_event"):
            raise CompleteTextError("assistant content after terminal result")
        if kind == "error":
            self.error_seen = True
        if kind == "result":
            if self.terminal is not None and self.terminal != record:
                raise CompleteTextError("multiple different terminal results")
            self.terminal = record
            self.error_seen |= record.get("is_error") is not False
            if record.get("stop_reason") == "refusal":
                self.provider_stops.append("result")
        if kind == "assistant":
            message = record.get("message")
            if not isinstance(message, dict) or not isinstance(message.get("content"), list):
                raise CompleteTextError("invalid assistant snapshot")
            mid = message.get("id")
            self._message(mid)
            if message.get("stop_reason") == "refusal":
                self.provider_stops.append(mid)
            # A snapshot may carry only the block(s) just completed (Claude Code sends one
            # snapshot per block: thinking, then text, under one message id). When the stream
            # has started blocks of this message, the snapshot ends at the latest started block.
            content = message["content"]
            last = self.last_started.get(mid)
            offset = 0 if last is None else last + 1 - len(content)
            if offset < 0:
                raise CompleteTextError("assistant snapshot has more blocks than the stream started")
            updates = []
            for position, item in enumerate(content):
                block = self._block(mid, offset + position)
                if not isinstance(item, dict) or not isinstance(item.get("type"), str) or not item["type"]:
                    raise CompleteTextError("invalid assistant block type")
                if block["kind"] not in (None, item["type"]):
                    raise CompleteTextError("content block type changed")
                candidate = {**block, "kind": item["type"]}
                if item["type"] != "text":
                    updates.append((block, candidate))
                    continue
                text = item.get("text")
                if not isinstance(text, str):
                    raise CompleteTextError("non-text assistant block")
                if offset and not block["delta"] and text:
                    # Real per-block snapshots follow their block's deltas; one arriving before any
                    # delta could belong to an earlier block and would be counted twice.
                    raise CompleteTextError("snapshot precedes its stream deltas")
                prior = block["snapshot"]
                if prior is not None and not (prior.startswith(text) or text.startswith(prior)):
                    raise CompleteTextError("assistant snapshot changed non-prefix text")
                candidate["snapshot"] = text if prior is None or len(text) >= len(prior) else prior
                self._text(candidate)
                updates.append((block, candidate))
            for block, candidate in updates:
                block.update(candidate)
        if kind != "stream_event":
            return True
        event = record.get("event")
        if not isinstance(event, dict):
            raise CompleteTextError("invalid stream event")
        typ = event.get("type")
        if typ == "message_start":
            message = event.get("message")
            if not isinstance(message, dict):
                raise CompleteTextError("invalid message start")
            mid = message.get("id")
            if self.active is not None:
                raise CompleteTextError("overlapping message starts")
            self._message(mid)
            self.active = mid
        elif typ == "content_block_start":
            block = self._block(self.active, event.get("index"))
            item = event.get("content_block", {})
            if not isinstance(item, dict):
                raise CompleteTextError("invalid content block start")
            kind = item.get("type")
            if block["stopped"] or not isinstance(kind, str) or not kind or block["kind"] not in (None, kind):
                raise CompleteTextError("content block type changed or missing")
            if kind == "text":
                text = item.get("text", "")
                if not isinstance(text, str):
                    raise CompleteTextError("invalid initial text")
                if block["delta"] and block["delta"] != text:
                    raise CompleteTextError("restarted text block")
                candidate = {**block, "delta": text}
                self._text(candidate)  # Refuse before altering retained content.
                block["delta"] = text
            block["kind"] = kind
            index = event["index"]
            self.last_started[self.active] = max(self.last_started.get(self.active, index), index)
        elif typ == "content_block_delta":
            delta = event.get("delta", {})
            if not isinstance(delta, dict):
                raise CompleteTextError("invalid content block delta")
            expected = {"text_delta": ("text",), "thinking_delta": ("thinking",),
                        "signature_delta": ("thinking",), "input_json_delta": ("tool_use", "server_tool_use"),
                        "citations_delta": ("text",)}.get(delta.get("type"))
            if expected is not None:
                block = self._block(self.active, event.get("index"))
                if block["stopped"] or block["kind"] not in expected:
                    raise CompleteTextError("content delta outside its original block type")
            if delta.get("type") == "text_delta":
                block = self._block(self.active, event.get("index"))
                if block["stopped"] or block["kind"] != "text" or not isinstance(delta.get("text"), str):
                    raise CompleteTextError("text delta outside text block")
                candidate = {**block, "delta": block["delta"] + delta["text"]}
                self._text(candidate)
                block.update(candidate)
        elif typ == "message_delta":
            delta = event.get("delta")
            if isinstance(delta, dict) and delta.get("stop_reason") == "refusal":
                self.provider_stops.append(self.active)
        elif typ == "content_block_stop":
            self._block(self.active, event.get("index"))["stopped"] = True
        elif typ == "message_stop":
            if self.active is None:
                raise CompleteTextError("message stop without message start")
            self.active = None
        return True

    def blocks(self, *, require_complete=False):
        result = []
        for mid, content in self.messages.items():
            for index, block in sorted(content.items()):
                if block["kind"] != "text":
                    continue
                if require_complete and block["snapshot"] is None and not block["stopped"]:
                    raise CompleteTextError("unfinished text block")
                text = self._text(block)
                result.append({"message_id": mid, "index": index, "text": text})
        return result

    def text(self):
        return "".join(b["text"] for b in self.blocks())

    def success_text(self, exit_code):
        terminal = self.terminal
        if exit_code != 0 or self.error_seen or not terminal or terminal.get("subtype") != "success" or terminal.get("is_error") is not False:
            raise CompleteTextError("unsuccessful or incomplete invocation")
        if self.provider_stops:
            # The withheld remainder of a stopped response is unknown; a continuation the CLI
            # appends after the stop is not the requested output either.
            raise CompleteTextError("provider safeguard stopped a response")
        if self.active is not None:
            raise CompleteTextError("unfinished assistant message")
        original = terminal.get("result")
        if not isinstance(original, str) or not original.strip():
            raise CompleteTextError("missing terminal text")
        try:
            original.encode("utf-8")
        except UnicodeError as exc:
            raise CompleteTextError("terminal text is not valid UTF-8") from exc
        blocks = self.blocks(require_complete=True)
        complete = "".join(b["text"] for b in blocks) if blocks else original
        last_message = "".join(b["text"] for b in blocks if b["message_id"] == blocks[-1]["message_id"]) if blocks else original
        if original not in (complete, last_message):
            raise CompleteTextError("terminal result disagrees with original assistant text")
        return complete


def read_stream(path):
    collector = AssistantText()
    with Path(path).open(encoding="utf-8", newline="") as stream:
        for line in stream:
            if not line.strip():
                continue
            try:
                collector.add(json.loads(line))
            except (json.JSONDecodeError, UnicodeError) as exc:
                raise CompleteTextError("malformed original stream") from exc
    return collector


def capture_profile(root):
    """Select an original transport, never convert one provider's events to another's."""
    root = Path(root)
    claude = any(root.glob("*.events.jsonl")) or any(root.glob("*.events.result.json"))
    native = any(root.glob("*.stdout")) or any(root.glob("*.stderr"))
    if claude and native:
        raise CompleteTextError("mixed original capture formats")
    if claude:
        return "claude_stream_json"
    if native:
        return "kimi_prompt_stream_json"
    raise CompleteTextError("unsupported original capture format")


def kimi_capture_files(root):
    """The supported native prompt profile is one supervised, successful call."""
    root = Path(root)
    budget = json.loads((root / "budget.json").read_text(encoding="utf-8"))
    attempts = budget.get("attempts")
    if (budget.get("status") != "completed" or type(budget.get("runner_exit_code")) is not int
            or budget["runner_exit_code"] != 0 or not isinstance(attempts, list) or len(attempts) != 1):
        raise CompleteTextError("unsupported or unsuccessful native prompt attempt")
    attempt = attempts[0]
    if (not isinstance(attempt, dict) or type(attempt.get("index")) is not int or attempt["index"] != 1
            or attempt.get("status") != "exited" or type(attempt.get("exit_code")) is not int
            or attempt["exit_code"] != 0 or attempt.get("stdout") != "attempt_1.stdout"
            or attempt.get("stderr") != "attempt_1.stderr"):
        raise CompleteTextError("incomplete native prompt process receipt")
    names = {"budget.json", "attempt_1.stdout", "attempt_1.stderr"}
    entries = list(root.iterdir())
    if {p.name for p in entries} != names or any(not p.is_file() or p.is_symlink() for p in entries):
        raise CompleteTextError("unsupported native prompt capture files")
    return [root / "attempt_1.stdout", root / "attempt_1.stderr"]


def _unique_object(pairs):
    record = {}
    for key, value in pairs:
        if key in record:
            raise CompleteTextError("duplicate key in native prompt stream")
        record[key] = value
    return record


def _invalid_constant(value):
    raise CompleteTextError("non-finite value in native prompt stream")


def _validate_kimi_prompt_report(root, report):
    stdout, stderr = kimi_capture_files(root)
    data = stdout.read_bytes()
    # A partial last JSON record or missing line terminator is never completion.
    if not data.endswith(b"\n"):
        raise CompleteTextError("truncated native prompt JSONL")
    try:
        # JSON strings may contain literal Unicode line/paragraph separators.
        # Only the transport's newline byte delimits records.
        lines = data.decode("utf-8").split("\n")[:-1]
        records = [json.loads(line, object_pairs_hook=_unique_object, parse_constant=_invalid_constant)
                   for line in lines]
        # Comparator transport carries text verbatim; binary diagnostics need a separate profile.
        stderr.read_bytes().decode("utf-8")
        json.dumps(records, ensure_ascii=False).encode("utf-8")
    except (ValueError, UnicodeError) as exc:
        raise CompleteTextError("malformed original native prompt stream") from exc
    if not records or not isinstance(records[0], dict):
        raise CompleteTextError("Kimi capture lacks its system.version record; check the original stdout")
    header = records[0]
    if header.get("role") != "meta" or header.get("type") != "system.version":
        raise CompleteTextError("Kimi capture lacks its system.version record; check the original stdout")
    version = header.get("version")
    if not isinstance(version, str) or re.fullmatch(r"[0-9A-Za-z.+-]{1,64}", version) is None:
        raise CompleteTextError("Kimi capture has no valid reported CLI version; check the original stdout")
    update_hint = f"Kimi Code {version}: update Nullius for this stream-json format"
    if re.fullmatch(r"2\.6\.(?:0|[1-9][0-9]*)", version) is None:
        raise CompleteTextError(f"{update_hint} (supported CLI series: stable 2.6.x)")
    if set(header) != {"role", "type", "version"}:
        raise CompleteTextError(f"{update_hint} (unrecognized system.version fields)")
    if len(records) not in (2, 3) or any(not isinstance(record, dict) for record in records):
        raise CompleteTextError(f"Kimi Code {version}: expected one assistant text record and an optional resume hint")
    assistant = records[1]
    if assistant.get("role") in {"error", "tool"} or "tool_calls" in assistant:
        raise CompleteTextError(f"Kimi Code {version}: an error or tool call cannot supply a text-only receipt")
    if set(assistant) != {"role", "content"} or assistant.get("role") != "assistant":
        raise CompleteTextError(f"{update_hint} (unrecognized assistant record)")
    if not isinstance(assistant["content"], str) or not assistant["content"].strip():
        raise CompleteTextError(f"Kimi Code {version}: incomplete or non-text assistant output")
    if len(records) == 3:
        hint = records[2]
        if hint.get("role") in {"assistant", "error", "tool"}:
            raise CompleteTextError(f"Kimi Code {version}: additional assistant, error or tool record in text-only capture")
        if (set(hint) != {"role", "type", "session_id", "command", "content"}
                or hint.get("role") != "meta" or hint.get("type") != "session.resume_hint"
                or any(not isinstance(hint.get(key), str) or not hint[key].strip()
                       for key in ("session_id", "command", "content"))):
            raise CompleteTextError(f"{update_hint} (unrecognized resume hint)")
    # This is the original runner's documented text policy. Keep both identities;
    # the original unnormalized assistant and all metadata remain in stdout.
    text = assistant["content"]
    if report != text.rstrip() + "\n":
        raise CompleteTextError("report differs from complete original native assistant output")
    return {"protocol": "kimi_prompt_stream_json", "cli_version": header["version"],
            "stdout": stdout.name, "stderr": stderr.name,
            "completion_authority": "observed_process_exit_zero", "provider_terminal_event": False,
            "text_policy": "rstrip_then_final_newline",
            "assistant_text_sha256": hashlib.sha256(text.encode("utf-8")).hexdigest(),
            "report_text_sha256": hashlib.sha256(report.encode("utf-8")).hexdigest()}


def validate_stream_report(root, report):
    """Reconstruct from unchanged originals before runtime signing, never from a header."""
    if capture_profile(root) == "kimi_prompt_stream_json":
        return _validate_kimi_prompt_report(root, report)
    matches = []
    for terminal_path in sorted(Path(root).glob("*.events.result.json")):
        terminal = json.loads(terminal_path.read_text(encoding="utf-8"))
        if not isinstance(terminal, dict) or terminal.get("type") != "result" or terminal.get("is_error") is not False or terminal.get("subtype") != "success":
            continue
        events = terminal_path.with_name(terminal_path.name.replace(".events.result.json", ".events.jsonl"))
        capture = read_stream(events)
        if capture.terminal != terminal:
            raise CompleteTextError("terminal sidecar differs from original stream")
        complete = capture.success_text(0)
        if report != complete:
            continue
        matches.append({"protocol": "complete_assistant_text_v1", "events": events.name,
                        "terminal": terminal_path.name,
                        "blocks_sha256": hashlib.sha256(json.dumps(capture.blocks(), ensure_ascii=False, sort_keys=True).encode()).hexdigest(),
                        "terminal_text_sha256": hashlib.sha256(terminal["result"].encode()).hexdigest()})
    if len(matches) != 1:
        raise CompleteTextError("report differs from complete original output, or capture is ambiguous")
    return matches[0]
