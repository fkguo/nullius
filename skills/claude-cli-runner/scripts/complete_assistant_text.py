"""Lossless ordered assistant text; raw tool/thinking events remain in the log."""
from __future__ import annotations
import hashlib
import json
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
        if kind == "assistant":
            message = record.get("message")
            if not isinstance(message, dict) or not isinstance(message.get("content"), list):
                raise CompleteTextError("invalid assistant snapshot")
            mid = message.get("id")
            self._message(mid)
            updates = []
            for index, item in enumerate(message["content"]):
                block = self._block(mid, index)
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


def validate_stream_report(root, report):
    """Reconstruct from unchanged originals before runtime signing, never from a header."""
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
