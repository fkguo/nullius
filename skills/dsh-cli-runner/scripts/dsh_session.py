"""Strict admission of current tool-free v4 session evidence."""
from pathlib import Path
from dsh_runtime import RunError


def validate_stream_content(stream: list, content: list) -> None:
    """Cross-check compact streamed text and final blocks against committed text."""
    starts: dict[int, str] = {}
    ends: dict[int, dict] = {}
    chunks: dict[int, list[str]] = {}
    for item in stream:
        if not isinstance(item, dict):
            raise RunError('malformed packed stream entry')
        if item.get('type') in {'text-chunks', 'reasoning-chunks'}:
            index = item.get('index')
            texts = item.get('texts')
            if type(index) is not int or index not in starts or index in ends or not isinstance(texts, list) or any(not isinstance(v, str) for v in texts):
                raise RunError('malformed or out-of-order compact stream text')
            chunks.setdefault(index, []).extend(texts)
            continue
        if item.get('type') != 'chunk' or not isinstance(item.get('chunk'), dict):
            raise RunError('unsupported packed stream entry')
        chunk = item['chunk']
        kind = chunk.get('type')
        index = chunk.get('index')
        if kind == 'block-start':
            if type(index) is not int or index < 0 or index in starts or chunk.get('blockType') not in {'text', 'reasoning'}:
                raise RunError('invalid tool-free stream block start')
            starts[index] = chunk['blockType']
        elif kind in {'text-delta', 'reasoning-delta'}:
            if type(index) is not int or index not in starts or index in ends or not isinstance(chunk.get('delta'), str):
                raise RunError('invalid stream text delta')
            chunks.setdefault(index, []).append(chunk['delta'])
        elif kind == 'block-end':
            block = chunk.get('block')
            if type(index) is not int or index not in starts or index in ends or not isinstance(block, dict) or block.get('type') != starts[index] or not isinstance(block.get('text'), str):
                raise RunError('invalid tool-free stream block end')
            if ''.join(chunks.get(index, [])) != block['text']:
                raise RunError('stream deltas contradict final block text')
            ends[index] = block
        elif kind not in {'usage', 'finish'}:
            raise RunError('unsupported tool-free stream chunk')
    if sorted(starts) != list(range(len(content))) or sorted(ends) != list(range(len(content))) or [ends[i] for i in range(len(content))] != content:
        raise RunError('stream content contradicts committed assistant message')


def check_events(events: list[dict], provider: str, model: str, cap: int | None, effort: str | None, expected_cwd: str | None = None) -> tuple[str, dict]:
    if not events or events[0].get("type") != "session" or events[0].get("version") != 4:
        raise RunError("missing or unsupported session log header")
    header = events[0]
    if type(header.get("createdAt")) is not int or header["createdAt"] < 0:
        raise RunError("session creation timestamp is missing or invalid")
    if not isinstance(header.get('id'), str) or not header['id'].strip() or not isinstance(header.get('cwd'), str) or not Path(header['cwd']).is_absolute() or header.get('isSeeded') is not False or type(header.get('delegationDepth')) is not int or header['delegationDepth'] != 0:
        raise RunError('session header is not a complete fresh root session')
    if expected_cwd is not None and header['cwd'] != expected_cwd:
        raise RunError('session working directory differs from isolated workspace')
    seqs = [e.get("seq") for e in events[1:]]
    if not seqs or any(type(v) is not int for v in seqs) or seqs != list(range(len(seqs))):
        raise RunError("malformed session event sequence")
    headers = [e["data"]["header"] for e in events if e.get("type") == "request/header"]
    if len(headers) != 1 or any(e.get("type") in {"assistant/attempt", "llm/retry"} for e in events):
        raise RunError("expected exactly one model request without retries")
    configs = []
    for header in headers:
        config = header.get("config", {})
        # Current canonical request headers omit tools when the catalog is empty
        # (dsh-session/request-header); a present value must be the empty list.
        if header.get("tools", []) != [] or (config.get("provider"), config.get("model")) != (provider, model):
            raise RunError("unexpected model route or exposed tools")
        if cap is not None and config.get("maxTokens") != cap:
            raise RunError("requested output cap was not applied")
        if effort is not None and config.get("reasoningEffort") != effort:
            raise RunError("requested reasoning level was not applied")
        configs.append(config)
    turns = [e for e in events if e.get("type") == "turn/start"]
    ends = [e for e in events if e.get("type") == "turn/end"]
    if len(turns) != 1 or len(ends) != 1 or ends[0]["data"].get("reason", {}).get("kind") != "completed":
        raise RunError("DSH turn did not complete normally")
    if any(e["seq"] > ends[0]["seq"] and e.get("type") in ("assistant/message", "request/header", "assistant/chunk") for e in events[1:]):
        raise RunError("model events occur after the terminal event")
    texts = []
    sources = []
    for event in events:
        if event.get("type") != "assistant/message":
            continue
        if not turns[0]["seq"] < event["seq"] < ends[0]["seq"]:
            raise RunError("assistant message occurs outside the completed turn")
        message = event["data"]["message"]
        if message.get("role") != "assistant":
            raise RunError("model message role is not assistant")
        source = message.get("source", {})
        if source.get("kind") != "model" or (source.get("provider"), source.get("model")) != (provider, model):
            raise RunError("assistant message route differs from request")
        response = source.get("replayState", {}).get("response", {})
        if response.get("kind") != "pi-ai" or response.get("version") != 2 or not isinstance(response.get("api"), str) or not response["api"] or response.get("stopReason") != "stop" or (response.get("provider"), response.get("model")) != (provider, model):
            raise RunError("assistant message lacks a normal provider stop")
        validate_stream_content(event["data"].get("stream", []), message["content"])
        finishes = [item.get('chunk') for item in event['data'].get('stream', []) if item.get('type') == 'chunk' and item.get('chunk', {}).get('type') == 'finish']
        if len(finishes) != 1 or finishes[0].get('reason', {}).get('kind') != 'stop' or finishes[0].get('replayState') != source.get('replayState'):
            raise RunError('committed assistant stream lacks a matching normal finish')
        if any(b.get("type") == "tool-call" for b in message["content"]):
            raise RunError("unexpected assistant tool call")
        sources.append({k: response.get(k) for k in ("provider", "model", "responseId", "stopReason")})
        text = "".join(b["text"] for b in message["content"] if b.get("type") == "text")
        texts.append(text)
    if len(texts) != 1 or not texts[-1].strip():
        raise RunError("no complete nonblank assistant text")
    return texts[-1], {"requests": configs, "response_metadata": sources, "provider_attestation": "unknown", "assistant_messages": len(sources)}
