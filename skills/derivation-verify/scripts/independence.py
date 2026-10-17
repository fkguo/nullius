"""Count source-grounded independent evidence, separately from diversity.

The assessor is a fresh comparator invocation, not the author of a lane.
Its semantic judgments remain reviewer judgments; these checks bind them to
observed work and fail closed on absent or incomplete assessments.
"""
from __future__ import annotations

import functools
import hashlib
import json
import re
from pathlib import Path

_OBSERVATION_AUTHORITY = object()


class _ObservedDerivation(dict):
    """Process-local runtime capability; JSON fields cannot reconstruct this observation."""
    pass


def observe_runtime_derivation(d: dict) -> dict:
    """Called only after the executor actually invokes its trusted runner boundary."""
    observed = _ObservedDerivation(d)
    observed._observation_authority = _OBSERVATION_AUTHORITY
    observed._observed_transport_sha256 = hashlib.sha256(
        json.dumps(d.get("transport"), ensure_ascii=False, sort_keys=True).encode("utf-8")).hexdigest()
    return observed


def runtime_observed(d: dict) -> bool:
    if not isinstance(d, _ObservedDerivation) or getattr(d, "_observation_authority", None) is not _OBSERVATION_AUTHORITY:
        return False
    try:
        return d._observed_transport_sha256 == hashlib.sha256(
            json.dumps(d.get("transport"), ensure_ascii=False, sort_keys=True).encode("utf-8")).hexdigest()
    except (TypeError, ValueError):
        return False


def derivation_body(d: dict) -> str:
    """Original assistant context; assessors must identify the actual scientific steps."""
    transport = d.get("transport")
    if runtime_observed(d) and isinstance(transport, dict):
        from run_multi_backend import parse_derivation
        original = transport.get("raw_output")
        parsed = parse_derivation(original) if isinstance(original, str) else None
        if parsed and parsed["additional_assistant_text_present"]:
            return original
    body = d.get("derivation", d.get("derivation_body", ""))
    return body if isinstance(body, str) else ""


def _same_line_endings(text: str) -> str:
    return text.replace("\r\n", "\n").replace("\r", "\n")


def occurs_in(span: str, text) -> bool:
    """Exact quotation with line endings (CRLF, CR, LF) compared as equal; they are not content."""
    return isinstance(span, str) and isinstance(text, str) and _same_line_endings(span) in _same_line_endings(text)


_OBJECT_START = re.compile(r'\{[ \t\n\r]*["}]')


_ANSWER_KEYS = ("canonical_answer", "derivation_summary")


def _holds(value, selected: dict) -> bool:
    """Whether a decoded JSON value is the selected object or contains it at any depth."""
    pending = [value]
    while pending:
        item = pending.pop()
        if item == selected:
            return True
        pending.extend(item.values() if isinstance(item, dict) else item if isinstance(item, list) else ())
    return False


@functools.lru_cache(maxsize=256)
def _text_outside_answer_json(raw: str) -> tuple[str, ...]:
    """Assistant text around the answer-shaped JSON objects, line endings normalised.

    Removed are every copy of the selected object and every other decodable JSON object with a
    canonical_answer or derivation_summary key (drafts, wrappers, near-copies), so no answer
    object's summary, confidence, answer or JSON-quoted derivation is part of this text. If the
    selected object cannot be located, nothing is returned."""
    from run_multi_backend import extract_json
    selected = extract_json(raw, prefer_keys={"canonical_answer"})
    if not isinstance(selected, dict):
        return ()
    text, decoder = _same_line_endings(raw), json.JSONDecoder()
    parts, cursor, located = [], 0, False
    # A JSON object opens with a key or closes at once; other braces (e.g. LaTeX) are skipped
    # without a decode attempt, which would otherwise make long outputs quadratic.
    found = _OBJECT_START.search(text)
    while found:
        i = found.start()
        try:
            value, end = decoder.raw_decode(text, i)
        except (ValueError, RecursionError):
            value, end = None, i + 1
        if value == selected or (isinstance(value, dict) and any(key in value for key in _ANSWER_KEYS)):
            located = located or _holds(value, selected)
            parts.append(text[cursor:i])
            cursor = end
        else:
            end = i + 1
        found = _OBJECT_START.search(text, end)
    if not located:
        return ()
    return tuple(parts) + (text[cursor:],)


def quoted_in_derivation(span: str, d: dict, closure: tuple[str, ...] | None = None) -> bool:
    """A span quotes original derivation material when it occurs in one of the given closure texts
    (input and execution evidence, see source_material) or, for the other evidence, in the
    derivation context; in both cases also when it occurs in the structured derivation as read.

    When the context is the raw output (assistant text outside the selected JSON object), the
    derivation context for quoting is the text outside every answer-shaped JSON object: their
    fields, such as the navigation-only summary, are not derivation steps. Inside the raw output the structured
    derivation is JSON-quoted (newlines, quotes and non-ASCII escaped), so it is quoted as read.
    Line endings (CRLF, CR, LF) are not content and compare equal.
    valid_derivation_transport requires the structured field to equal the one parsed from that raw
    output before any lane counts."""
    body = derivation_body(d)
    structured = d.get("derivation")
    separate = runtime_observed(d) and isinstance(structured, str) and structured != body
    if closure is not None:
        texts = closure
    else:
        texts = _text_outside_answer_json(body) if separate else (body,)
    if any(occurs_in(span, text) for text in texts):
        return True
    return separate and occurs_in(span, structured)


AXES = ("input", "execution", "construction", "applicability", "diagnostic")


def assessed_indices(derivations: list[dict], assessments: list[dict]) -> list[int]:
    accepted: set[int] = set()
    seen: set[int] = set()
    duplicate: set[int] = set()
    for a in assessments if isinstance(assessments, list) else []:
        if not isinstance(a, dict):
            continue
        i = a.get("index")
        if type(i) is not int or not 0 <= i < len(derivations):
            continue
        if i in seen:
            duplicate.add(i)
        seen.add(i)
        if any(a.get(k) is not True for k in (
            "input_independent", "execution_independent", "construction_independent",
            "method_applicable", "diagnostic",
        )) or a.get("unresolved_defects") != []:
            continue
        evidence = a.get("evidence")
        if not isinstance(evidence, dict):
            continue
        source = source_material(derivations[i])
        valid = True
        for axis in AXES:
            item = evidence.get(axis)
            if not isinstance(item, dict):
                valid = False
                break
            span, reason = item.get("source_span"), item.get("reason")
            if (not isinstance(span, str) or not span.strip()
                    or not isinstance(reason, str) or len(reason.strip()) < 20):
                valid = False
                break
            if axis == "construction" and "construction_body" in derivations[i]:
                quoted = occurs_in(span, derivations[i]["construction_body"])
            else:
                quoted = quoted_in_derivation(span, derivations[i], source if axis in ("input", "execution") else None)
            if not quoted:
                valid = False
                break
        if valid:
            accepted.add(i)
    # Duplicate entries cannot conceal a contradictory assessment.
    accepted -= duplicate
    # Runtime-controlled execution ids identify evidence, never agent names.
    ids = [derivations[i].get("execution_id") for i in accepted]
    return sorted(i for i in accepted if isinstance(derivations[i].get("execution_id"), str)
                  and derivations[i]["execution_id"] and ids.count(derivations[i]["execution_id"]) == 1)


_STREAM_SUFFIX = ".events.jsonl"
_TERMINAL_SUFFIX = ".events.result.json"
# Stream event kinds that hold only bookkeeping (session start, token counters, rate limits).
_BOOKKEEPING_EVENTS = {"system", "rate_limit_event"}
# Event fields that identify or time an event; every other top-level field stays in the packet.
_EVENT_ENVELOPE = {"type", "message", "session_id", "uuid", "parent_tool_use_id", "timestamp", "request_id", "thinking_duration_ms"}
_DELTA_FIELDS = {"text_delta": "text", "thinking_delta": "thinking", "input_json_delta": "partial_json"}
STREAM_NOT_SHOWN = ("event envelopes, ids, usage and token counters, empty thinking blocks and thinking "
                    "signatures; the complete file is identified by ref")


def _sha256(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def _slice_of(text, shipped: tuple[tuple[str, str], ...]):
    """A reference to the exact slice of a shipped field equal to text, or None. str.find is exact
    code-point matching, so the returned slice is equal to text by construction of the search."""
    if not isinstance(text, str) or not text:
        return None
    for name, value in shipped:
        start = value.find(text)
        if start >= 0:
            return {"given_in": name, "start": start, "end": start + len(text), "sha256": _sha256(text)}
    return None


def _stream_blocks(text: str, shipped: tuple[tuple[str, str], ...]) -> list:
    """The content blocks of a captured stream in emission order. A text block, the streamed text of a
    block and the terminal result text are replaced by a reference to the slice of a shipped field
    they equal; every other content (tool use and results, thinking text, synthetic messages, extra
    event fields, unrecognized lines) stays verbatim. Bookkeeping in STREAM_NOT_SHOWN is not shown."""
    blocks, streamed, message_id = [], {}, None
    for line in text.splitlines():
        if not line.strip():
            continue
        try:
            event = json.loads(line)
        except ValueError:
            event = None
        kind = event.get("type") if isinstance(event, dict) else None
        if kind in _BOOKKEEPING_EVENTS:
            continue
        if kind == "stream_event" and isinstance(event.get("event"), dict):
            inner = event["event"]
            step = inner.get("type")
            if step == "message_start":
                message_id = (inner.get("message") or {}).get("id")
                continue
            if step in ("content_block_stop", "message_delta", "message_stop"):
                continue
            if step == "content_block_start" and isinstance(inner.get("content_block"), dict):
                entry = {"source": "stream", "block": {k: v for k, v in inner["content_block"].items() if k != "signature"}}
                streamed[(message_id, inner.get("index"))] = entry
                blocks.append(entry)
                continue
            delta = inner.get("delta") if step == "content_block_delta" else None
            entry = streamed.get((message_id, inner.get("index")))
            if isinstance(delta, dict) and delta.get("type") == "signature_delta" and entry is not None:
                continue
            field = _DELTA_FIELDS.get(delta.get("type")) if isinstance(delta, dict) else None
            if entry is not None and field and isinstance(delta.get(field), str):
                block = entry["block"]
                block[field] = (block.get(field) if isinstance(block.get(field), str) else "") + delta[field]
                continue
        elif kind in ("assistant", "user") and isinstance(event.get("message"), dict):
            content = event["message"].get("content")
            content = [{"type": "text", "text": content}] if isinstance(content, str) else content
            if isinstance(content, list):
                for item in content:
                    block = {k: v for k, v in item.items() if k != "signature"} if isinstance(item, dict) else item
                    blocks.append({"source": kind, "block": block})
                extra = {k: v for k, v in event.items() if k not in _EVENT_ENVELOPE}
                if extra:
                    blocks.append({"source": kind, "event_fields": extra})
                continue
        elif kind == "result":
            blocks.append({"source": "result", "block": {k: event[k] for k in ("subtype", "is_error", "stop_reason", "result") if k in event}})
            continue
        blocks.append({"source": "unrecognized_line", "line": line})
    shown, tool_inputs = [], {b["block"].get("id"): b["block"].get("input") for b in blocks
                              if isinstance(b.get("block"), dict) and b["source"] == "assistant" and b["block"].get("type") == "tool_use"}
    for entry in blocks:
        block = entry.get("block")
        if isinstance(block, dict):
            if block.get("type") == "thinking" and not block.get("thinking"):
                continue
            block = dict(block)
            for field in ("text", "result"):
                ref = _slice_of(block.get(field), shipped)
                if ref is not None:
                    block[field] = ref
            partial = block.get("partial_json")
            if entry["source"] == "stream" and isinstance(partial, str) and block.get("id") in tool_inputs:
                try:
                    same = json.loads(partial) == tool_inputs[block["id"]]
                except ValueError:
                    same = False
                if same:
                    block["partial_json"] = {"decodes_to_input_of_tool_use": block["id"]}
            entry = {**entry, "block": block}
        shown.append(entry)
    return shown


def _terminal_event(stream_text):
    lines = [line for line in (stream_text or "").splitlines() if line.strip()]
    try:
        event = json.loads(lines[-1]) if lines else None
    except ValueError:
        return None
    return event if isinstance(event, dict) and event.get("type") == "result" else None


@functools.lru_cache(maxsize=64)
def _carried_record(path: str, text: str, ref_json: str, shipped: tuple[tuple[str, str], ...], stream_text):
    """How one captured record enters the packet; every by-reference form is proven here, at assembly.
    The reference must identify these exact bytes (sha256 and size), otherwise the record stays inline."""
    ref = json.loads(ref_json)
    data = text.encode("utf-8")
    identified = isinstance(ref, dict) and ref.get("sha256") == hashlib.sha256(data).hexdigest() and ref.get("size") == len(data)
    if identified:
        for name, value in shipped:
            if text == value:
                return {"carried": "by_reference", "ref": ref, "proven": f"bytes equal {name}"}
        terminal = _terminal_event(stream_text) if path.endswith(_TERMINAL_SUFFIX) else None
        if terminal is not None and text == json.dumps(terminal, indent=2) + "\n":
            return {"carried": "by_reference", "ref": ref,
                    "proven": f"bytes equal the terminal event of {Path(path).name[:-len(_TERMINAL_SUFFIX)]}{_STREAM_SUFFIX} written with indent 2"}
        if path.endswith(_STREAM_SUFFIX):
            return {"carried": "content_blocks", "ref": ref, "not_shown": STREAM_NOT_SHOWN,
                    "blocks": _stream_blocks(text, shipped)}
    return {"carried": "inline", "content": text}


def packet_transport(d: dict):
    """The lane's transport as the comparator packet carries it. When derivation_context carries the
    raw output, raw_output is not repeated and raw_output_given_as names the field holding it.
    captured_records are carried per record (see _carried_record): by reference when the bytes are
    proven equal to a shipped field or to the stream's terminal event, as content blocks for a stream
    (text blocks by reference to the slice of a shipped field they equal), otherwise inline verbatim."""
    transport = d.get("transport")
    if not isinstance(transport, dict):
        return transport
    shown = dict(transport)
    context = derivation_body(d)
    raw = transport.get("raw_output")
    raw_field = "transport.raw_output"
    if context != d.get("derivation") and raw == context:
        del shown["raw_output"]
        shown["raw_output_given_as"] = raw_field = "derivation_context"
    captured = transport.get("captured_records")
    if isinstance(captured, dict) and captured:
        shipped = tuple((name, value) for name, value in ((raw_field, raw), ("derivation", d.get("derivation")))
                        if isinstance(value, str) and value)
        refs = {ref.get("path"): ref for ref in transport.get("artifact_refs", []) if isinstance(ref, dict)}
        carried = {}
        for path, text in captured.items():
            if not isinstance(text, str):
                carried[path] = {"carried": "inline", "content": text}
                continue
            stream = captured.get(path[:-len(_TERMINAL_SUFFIX)] + _STREAM_SUFFIX) if path.endswith(_TERMINAL_SUFFIX) else None
            carried[path] = _carried_record(path, text, json.dumps(refs.get(path), sort_keys=True), shipped,
                                            stream if isinstance(stream, str) else None)
        shown["captured_records"] = carried
    return shown


def _string_values(value) -> list[str]:
    if isinstance(value, str):
        return [value]
    if isinstance(value, dict):
        return [text for item in value.values() for text in _string_values(item)]
    if isinstance(value, list):
        return [text for item in value for text in _string_values(item)]
    return []


def source_material(d: dict) -> tuple[str, ...]:
    """Texts an input/execution span may quote verbatim, exactly those the comparator can read: the
    complete original context, the navigation summary, and the transport record as the packet carries
    it, both encoded (JSON with sorted keys, byte-identical to the packet) and as its decoded string
    values. Captured content carried by reference is not quotable from the packet; it equals a slice of
    a shipped field and is quoted through that field. The packet never repeats these as one field."""
    context = derivation_body(d)
    shown = packet_transport(d)
    texts = [context, str(d.get("derivation_summary", "")),
             json.dumps(shown, ensure_ascii=False, sort_keys=True), *_string_values(shown)]
    if context != d.get("derivation") and (d.get("transport") or {}).get("raw_output") == context:
        # The packet shows the raw output only as derivation_context; its JSON-escaped form, as it would
        # read inside the transport, is quotable exactly as for a lane whose transport shows raw_output.
        texts.append(json.dumps(context, ensure_ascii=False)[1:-1])
    return tuple(texts)


def valid_derivation_transport(d: dict) -> bool:
    """An author-provided name or fresh assertion is not a successful invocation receipt."""
    if not runtime_observed(d):
        return False
    t = d.get("transport")
    if not isinstance(d.get("derivation"), str) or not d["derivation"].strip() or not isinstance(t, dict):
        return False
    if type(t.get("exit_code")) is not int or t["exit_code"] != 0 or t.get("execution_id") != d.get("execution_id"):
        return False
    request, raw = t.get("request"), t.get("raw_output")
    if not isinstance(request, dict) or not isinstance(raw, str) or not raw.strip():
        return False
    if not isinstance(request.get("prompt"), str) or not request["prompt"].strip():
        return False
    digest = lambda x: hashlib.sha256(x.encode("utf-8")).hexdigest()
    if t.get("request_sha256") != digest(json.dumps(request, ensure_ascii=False, sort_keys=True)) or t.get("output_sha256") != digest(raw):
        return False
    # Parsed raw output must contain the complete derivation actually shown to the assessor.
    try:
        from run_multi_backend import extract_json, parse_derivation
        result = extract_json(raw, prefer_keys={"canonical_answer"})
        if not isinstance(result, dict) or result.get("derivation") != d["derivation"] or result.get("canonical_answer") != d["canonical_answer"]:
            return False
        if "original_assistant_output" in d:
            parsed = parse_derivation(raw)
            if (d["original_assistant_output"] != raw or not parsed
                    or d.get("additional_assistant_text_present") != parsed["additional_assistant_text_present"]):
                return False
        for ref in t.get("artifact_refs", []):
            path = Path(ref["path"])
            if hashlib.sha256(path.read_bytes()).hexdigest() != ref["sha256"]:
                return False
    except (KeyError, TypeError, OSError, UnicodeError):
        return False
    return True


def method_risk_passes(derivations: list[dict], eligible: list[int], records) -> bool:
    """An explicit shared-failure risk needs actual two-source examiner evidence, not distinct labels."""
    if not isinstance(records, list):
        return False
    for r in records:
        if not isinstance(r, dict) or r.get("addresses_shared_failure") is not True or r.get("methods_distinct") is not True:
            continue
        indices = r.get("indices")
        if not isinstance(indices, list) or len(indices) != 2 or any(type(i) is not int or i not in eligible for i in indices) or indices[0] == indices[1]:
            continue
        if any(not isinstance(r.get(k), str) or len(r[k].strip()) < 20 for k in ("risk", "method_analysis")):
            continue
        evidence = r.get("evidence")
        if not isinstance(evidence, list) or len(evidence) != 2:
            continue
        ok = set()
        for item in evidence:
            if not isinstance(item, dict) or type(item.get("index")) is not int or item["index"] not in indices:
                continue
            span, reason = item.get("source_span"), item.get("reason")
            if isinstance(span, str) and span.strip() and quoted_in_derivation(span, derivations[item["index"]]) and isinstance(reason, str) and len(reason.strip()) >= 20:
                ok.add(item["index"])
        if ok == set(indices):
            return True
    return False


def independence_record(derivations: list[dict], families: list[str], eligible: list[int], assessments=None) -> dict:
    return {
        "accepted_evidence_indices": eligible,
        "method_diversity": sorted({str(a["observed_method"]) for a in (assessments or []) if isinstance(a, dict) and isinstance(a.get("observed_method"), str) and a["observed_method"].strip()}),
        "method_hints": [d.get("method", "unspecified") for d in derivations],
        "model_family_diversity": sorted(set(families)),
        "execution_independence": "assessed" if eligible else "unavailable",
        "input_independence": "assessed" if eligible else "unavailable",
        "limitations": ["Method and model diversity do not establish independent construction or scientific truth."],
    }
