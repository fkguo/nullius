"""Which bytes of frozen lane material a comparator was actually shown, read from its own capture.

Lane material that does not fit one comparator request is frozen to disk before the comparator
starts: the lane's packet entry, encoded exactly as an inline packet encodes it, cut into lines
(after each JSON ``\\n`` escape and at most WRAP_CHARS characters, never inside an escape and never
before U+FEFF, which Read would strip at a file start; a line may exceed WRAP_CHARS by the characters
of a run of U+FEFF) and grouped into part files of at most PART_BYTES bytes and PART_LINES lines. Joining every line of every part, in order,
with nothing between them gives back the encoded entry byte for byte.

The comparator reads the parts with read-only file tools. Its captured stream records each tool call
and the exact tool result returned to it. A file byte counts as read only when a Read result returned
the line holding it, numbered as that line, with exactly the frozen text. Any returned line that
differs from the frozen bytes refuses the whole request; so does a tool outside the read-only set, a
context edit that removed earlier tool results, or a verdict not given in the final message after
the last read.
"""
from __future__ import annotations

import hashlib
import json
import os
import re
from pathlib import Path

WRAP_CHARS = 2000
PART_BYTES = 24000
# The Read tool returns at most 2000 lines per call by default; a part stays below that so one call reads it.
PART_LINES = 1500
READ_ONLY_TOOLS = frozenset({"Read", "Glob", "Grep"})
NOT_READ = "unavailable: content not completely read"
# Read returns each line as "<number>\t<text>" or, in its older layout, "<padded number>→<text>".
_NUMBERED = (re.compile(r"(\d+)\t(.*)\Z", re.DOTALL), re.compile(r" *(\d+)→(.*)\Z", re.DOTALL))


def material_lines(encoded: str) -> list[str]:
    """Cut encoded JSON text into lines without changing a byte: a cut follows each ``\\n`` escape and
    falls at most every WRAP_CHARS characters, never inside an escape sequence."""
    lines, start, i, n = [], 0, 0, len(encoded)
    while i < n:
        step = (6 if encoded[i + 1:i + 2] == "u" else 2) if encoded[i] == "\\" else 1
        # Read strips a byte-order mark at the start of a file, so no line (and no part) starts with U+FEFF.
        if i > start and i + step - start > WRAP_CHARS and encoded[i] != "\ufeff":
            lines.append(encoded[start:i])
            start = i
        newline_escape = encoded[i:i + 2] == "\\n"
        i += step
        if newline_escape and encoded[i:i + 1] != "\ufeff":
            lines.append(encoded[start:i])
            start = i
    if start < n:
        lines.append(encoded[start:])
    return lines


def freeze_material(encoded: str, directory: Path, stem: str) -> list[dict]:
    """Write the parts of one lane's encoded material once, read-only, and return their identities."""
    lines = material_lines(encoded)
    if "".join(lines) != encoded:
        raise ValueError("unavailable: lane material lines do not reconstruct the encoded material")
    parts, current, size = [], [], 0
    for line in lines:
        cost = len(line.encode("utf-8")) + (1 if current else 0)
        if current and (size + cost > PART_BYTES or len(current) >= PART_LINES):
            parts.append(current)
            current, size = [], 0
            cost = len(line.encode("utf-8"))
        current.append(line)
        size += cost
    if current:
        parts.append(current)
    directory.mkdir(parents=True, exist_ok=True)
    frozen = []
    for k, part in enumerate(parts, 1):
        path = (directory / f"{stem}.part-{k:03d}-of-{len(parts):03d}.txt").resolve()
        data = "\n".join(part).encode("utf-8")
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0), 0o444)
        with os.fdopen(fd, "wb") as stream:
            stream.write(data)
        frozen.append({"path": str(path), "sha256": hashlib.sha256(data).hexdigest(), "size": len(data),
                       "lines": len(part)})
    return frozen


def unchanged(frozen: list[dict]) -> bool:
    try:
        return all(hashlib.sha256(Path(f["path"]).read_bytes()).hexdigest() == f["sha256"] for f in frozen)
    except OSError:
        return False


def _result_texts(content) -> list[str]:
    if isinstance(content, str):
        return [content]
    if isinstance(content, list):
        return [b["text"] for b in content if isinstance(b, dict) and b.get("type") == "text" and isinstance(b.get("text"), str)]
    return []


def _numbered_run(text: str) -> list[tuple[int, str]]:
    """The consecutive run of numbered lines a Read result returned, in one layout, from its first numbered line."""
    run, layout = [], None
    for line in text.split("\n"):
        match = None
        for k, pattern in enumerate(_NUMBERED):
            if layout in (None, k):
                match = pattern.match(line)
                if match:
                    layout = k
                    break
        if match is None or (run and int(match.group(1)) != run[-1][0] + 1):
            if run:
                break
            continue
        run.append((int(match.group(1)), match.group(2)))
    return run


def observed_session(stream_text: str) -> dict:
    """Tool calls, their returned results, context edits and the final message of one top-level session."""
    calls, results, edits = {}, [], 0
    final = {"id": None, "text": [], "tool_use": False}
    # Only "\n" ends a captured event: U+2028, U+2029 and U+0085 may stand unescaped inside event JSON.
    for line in stream_text.split("\n"):
        if not line.strip():
            continue
        try:
            event = json.loads(line)
        except ValueError:
            continue
        if not isinstance(event, dict) or event.get("parent_tool_use_id") is not None:
            continue
        kind = event.get("type")
        if kind == "stream_event" and isinstance(event.get("event"), dict):
            inner = event["event"]
            management = inner.get("context_management")
            if isinstance(management, dict) and management.get("applied_edits"):
                edits += 1
            continue
        message = event.get("message") if isinstance(event.get("message"), dict) else None
        content = message.get("content") if message else None
        if kind == "assistant" and isinstance(content, list):
            if message.get("id") != final["id"]:
                final = {"id": message.get("id"), "text": [], "tool_use": False}
            for block in content:
                if not isinstance(block, dict):
                    continue
                if block.get("type") == "tool_use":
                    final["tool_use"] = True
                    calls[block.get("id")] = {"name": block.get("name"), "input": block.get("input")}
                elif block.get("type") == "text" and isinstance(block.get("text"), str):
                    final["text"].append(block["text"])
        elif kind == "user" and isinstance(content, list):
            for block in content:
                if isinstance(block, dict) and block.get("type") == "tool_result":
                    results.append({"tool_use_id": block.get("tool_use_id"), "is_error": block.get("is_error") is True,
                                    "texts": _result_texts(block.get("content"))})
    return {"calls": calls, "results": results, "context_edits": edits, "final_text": "".join(final["text"]),
            "final_has_tool_use": final["tool_use"]}


def read_coverage(stream_text: str, frozen: list[dict], working_directory: Path) -> dict:
    """Byte coverage of every frozen file by the Read results actually returned in this capture.
    complete is True only when every byte of every file is covered, every returned line of a frozen
    file equals its frozen text, only read-only tools were used, and no context edit removed results."""
    session = observed_session(stream_text)
    files = {}
    for f in frozen:
        data = Path(f["path"]).read_bytes()
        if hashlib.sha256(data).hexdigest() != f["sha256"]:
            return {"complete": False, "reason": NOT_READ + ": frozen material changed after freezing", "files": []}
        lines = data.decode("utf-8").split("\n")
        spans, cursor = [], 0
        for line in lines:
            end = cursor + len(line.encode("utf-8"))
            spans.append((cursor, end + 1 if end < len(data) else end))
            cursor = end + 1
        files[str(Path(f["path"]).resolve())] = {"lines": lines, "spans": spans, "size": len(data), "covered": set()}
    foreign = sorted({str(c.get("name")) for c in session["calls"].values()} - READ_ONLY_TOOLS)
    if foreign:
        return {"complete": False, "reason": NOT_READ + ": comparator used tools outside the read-only set: " + ", ".join(foreign), "files": []}
    if session["context_edits"]:
        return {"complete": False, "reason": NOT_READ + ": the provider edited the comparator context during the session (applied context edits), so returned content may not have stayed in view", "files": []}
    for result in session["results"]:
        call = session["calls"].get(result["tool_use_id"])
        if not call or call["name"] != "Read" or result["is_error"] or not isinstance(call.get("input"), dict):
            continue
        raw_path = call["input"].get("file_path")
        if not isinstance(raw_path, str):
            continue
        path = Path(raw_path)
        target = files.get(str((path if path.is_absolute() else working_directory / path).resolve()))
        if target is None:
            continue
        for text in result["texts"]:
            for number, line in _numbered_run(text):
                if not 1 <= number <= len(target["lines"]) or target["lines"][number - 1] != line:
                    return {"complete": False, "reason": NOT_READ + ": a returned line differs from the frozen bytes of " + Path(raw_path).name, "files": []}
                target["covered"].add(number - 1)
    report, complete = [], True
    for path, target in files.items():
        missing = [list(target["spans"][k]) for k in range(len(target["lines"])) if k not in target["covered"]]
        covered = sum(b - a for k, (a, b) in enumerate(target["spans"]) if k in target["covered"])
        report.append({"path": path, "size": target["size"], "covered_bytes": covered, "missing_byte_ranges": missing})
        complete &= not missing and covered == target["size"]
    if not complete:
        return {"complete": False, "reason": NOT_READ + ": some bytes of the frozen material were never returned to the comparator", "files": report}
    if session["final_has_tool_use"] or not session["final_text"].strip():
        return {"complete": False, "reason": NOT_READ + ": the verdict was not given in a final message after the last read", "files": report}
    return {"complete": True, "reason": None, "files": report, "final_text": session["final_text"]}
