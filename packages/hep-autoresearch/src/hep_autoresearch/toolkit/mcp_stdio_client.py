from __future__ import annotations

import json
import queue
import subprocess
import threading
import time
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .mcp_config import McpServerConfig


# MCP protocol versions are date strings. Prefer the latest known-stable version, and fail-fast if
# the server negotiates something outside this allowlist.
_PREFERRED_PROTOCOL_VERSION = "2025-03-26"
_SUPPORTED_PROTOCOL_VERSIONS = (_PREFERRED_PROTOCOL_VERSION, "2024-11-05")


@dataclass(frozen=True)
class McpTool:
    name: str
    description: str | None
    input_schema: dict[str, Any] | None


@dataclass(frozen=True)
class McpToolCallResult:
    ok: bool
    is_error: bool
    raw_text: str
    json: Any | None
    error_code: str | None = None
    trace_id: str | None = None


class McpStdioClient:
    """A minimal MCP stdio client (NDJSON JSON-RPC over stdin/stdout).

    Notes:
    - The upstream MCP Node SDK uses one JSON message per line (no Content-Length framing).
    - This client is intentionally tiny and dependency-free (stdlib-only).
    """

    def __init__(
        self,
        *,
        cfg: McpServerConfig,
        cwd: Path,
        env: dict[str, str],
        startup_timeout_seconds: float = 8.0,
    ) -> None:
        self._cfg = cfg
        self._cwd = Path(cwd)
        self._env = dict(env)
        self._startup_timeout_seconds = float(startup_timeout_seconds)

        self._proc: subprocess.Popen[str] | None = None
        self._next_id = 1
        self._lock = threading.Lock()
        self._write_lock = threading.Lock()
        self._close_lock = threading.Lock()
        self._pending: dict[int, queue.Queue[dict[str, Any]]] = {}
        self._reader: threading.Thread | None = None
        self._stderr: list[str] = []
        self._stderr_reader: threading.Thread | None = None
        self._dropped_stdout_lines = 0

    def __enter__(self) -> "McpStdioClient":
        self.start()
        return self

    def __exit__(self, exc_type, exc, tb) -> None:
        self.close()

    @property
    def server_name(self) -> str:
        return self._cfg.name

    def start(self) -> None:
        # Serialize lifecycle operations (start/close) to avoid races around `_proc`.
        with self._close_lock:
            if self._proc is not None:
                return

            argv = [self._cfg.command, *self._cfg.args]
            self._proc = subprocess.Popen(
                argv,
                cwd=str(self._cwd),
                env=self._env,
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                encoding="utf-8",
                errors="replace",
                bufsize=1,  # line-buffered
            )
            assert self._proc.stdin is not None
            assert self._proc.stdout is not None
            assert self._proc.stderr is not None

            self._reader = threading.Thread(target=self._read_stdout_loop, name="mcp-stdout", daemon=True)
            self._reader.start()
            self._stderr_reader = threading.Thread(target=self._read_stderr_loop, name="mcp-stderr", daemon=True)
            self._stderr_reader.start()

            # Best-effort: catch immediate startup failures early (initialize is still the real check).
            grace = max(0.0, float(self._startup_timeout_seconds))
            if grace:
                time.sleep(min(grace, 0.1))
            if self._proc.poll() is not None:
                tail = "\n".join(self._stderr[-50:])
                raise RuntimeError(f"MCP server exited during startup (code={self._proc.returncode}); stderr_tail:\n{tail}")

    def close(self) -> None:
        # Ensure close() is single-flight: callers might trigger cleanup from multiple paths.
        with self._close_lock:
            proc = self._proc
            if proc is None:
                return

            t_out = self._reader
            t_err = self._stderr_reader
            try:
                if proc.stdin:
                    try:
                        proc.stdin.close()
                    except Exception:  # CONTRACT-EXEMPT: CODE-01.5 best-effort cleanup
                        pass
                proc.terminate()
                try:
                    proc.wait(timeout=2.0)
                except Exception:  # CONTRACT-EXEMPT: CODE-01.5 best-effort cleanup
                    proc.kill()
            finally:
                # Unblock any pending requests.
                with self._lock:
                    pending = dict(self._pending)
                    self._pending.clear()
                for q in pending.values():
                    try:
                        q.put_nowait({"jsonrpc": "2.0", "error": {"code": -32000, "message": "connection closed"}})
                    except Exception:  # CONTRACT-EXEMPT: CODE-01.5 best-effort cleanup in finally
                        pass
                for t in (t_out, t_err):
                    if t is not None:
                        try:
                            t.join(timeout=2.0)
                        except Exception:  # CONTRACT-EXEMPT: CODE-01.5 best-effort cleanup in finally
                            pass
                self._proc = None
                self._reader = None
                self._stderr_reader = None

    def _read_stderr_loop(self) -> None:
        proc = self._proc
        if proc is None or proc.stderr is None:
            return
        for line in proc.stderr:
            s = line.rstrip("\n")
            if not s:
                continue
            # Keep bounded; stderr is only used for diagnostics on failure.
            self._stderr.append(s)
            if len(self._stderr) > 200:
                self._stderr = self._stderr[-200:]

    def _read_stdout_loop(self) -> None:
        proc = self._proc
        if proc is None or proc.stdout is None:
            return
        for line in proc.stdout:
            raw = line.strip()
            if not raw:
                continue
            try:
                msg = json.loads(raw)
            except Exception:  # CONTRACT-EXEMPT: CODE-01.5 skip malformed JSON lines
                # Ignore non-JSON noise.
                self._dropped_stdout_lines += 1
                continue
            if not isinstance(msg, dict):
                self._dropped_stdout_lines += 1
                continue
            msg_id = msg.get("id")
            if isinstance(msg_id, int):
                with self._lock:
                    q = self._pending.get(int(msg_id))
                if q is not None:
                    try:
                        q.put_nowait(msg)
                    except Exception:  # CONTRACT-EXEMPT: CODE-01.5 caller will timeout on missing response
                        pass
                continue
            # notifications: ignored (could be logged later)

    def _request(self, method: str, params: dict[str, Any] | None, *, timeout_seconds: float) -> dict[str, Any]:
        proc = self._proc
        if proc is None or proc.stdin is None:
            raise RuntimeError("MCP client not started")

        if proc.poll() is not None:
            tail = "\n".join(self._stderr[-50:])
            raise RuntimeError(f"MCP server exited early (code={proc.returncode}); stderr_tail:\n{tail}")

        with self._lock:
            req_id = int(self._next_id)
            self._next_id += 1
            q: queue.Queue[dict[str, Any]] = queue.Queue(maxsize=1)
            self._pending[req_id] = q

        payload: dict[str, Any] = {"jsonrpc": "2.0", "id": req_id, "method": str(method)}
        if params is not None:
            payload["params"] = params
        try:
            with self._write_lock:
                proc.stdin.write(json.dumps(payload, ensure_ascii=False) + "\n")
                proc.stdin.flush()
        except Exception as e:
            with self._lock:
                self._pending.pop(req_id, None)
            raise RuntimeError(f"failed to write MCP request: {method!r}") from e

        try:
            msg = q.get(timeout=float(timeout_seconds))
        except queue.Empty as e:
            tail = "\n".join(self._stderr[-50:])
            raise TimeoutError(
                f"MCP request timeout: method={method!r} timeout={timeout_seconds}s "
                f"dropped_stdout_lines={self._dropped_stdout_lines}; stderr_tail:\n{tail}"
            ) from e
        finally:
            with self._lock:
                self._pending.pop(req_id, None)

        if not isinstance(msg, dict):
            raise RuntimeError(f"bad MCP response type: {type(msg).__name__}")
        if "error" in msg:
            err = msg.get("error")
            raise RuntimeError(f"MCP error response for {method!r}: {err!r}")
        res = msg.get("result")
        if not isinstance(res, dict):
            raise RuntimeError(f"bad MCP result shape for {method!r}: {type(res).__name__}")
        return res

    def _notify(self, method: str, params: dict[str, Any] | None = None) -> None:
        proc = self._proc
        if proc is None or proc.stdin is None:
            raise RuntimeError("MCP client not started")
        payload: dict[str, Any] = {"jsonrpc": "2.0", "method": str(method)}
        if params is not None:
            payload["params"] = params
        with self._write_lock:
            proc.stdin.write(json.dumps(payload, ensure_ascii=False) + "\n")
            proc.stdin.flush()

    def initialize(self, *, client_name: str, client_version: str, timeout_seconds: float = 8.0) -> dict[str, Any]:
        params = {
            "protocolVersion": str(_PREFERRED_PROTOCOL_VERSION),
            "capabilities": {},
            "clientInfo": {"name": str(client_name), "version": str(client_version)},
        }
        try:
            res = self._request("initialize", params, timeout_seconds=float(timeout_seconds))
        except Exception as e:
            raise RuntimeError(
                f"MCP initialize failed (requested_protocol={_PREFERRED_PROTOCOL_VERSION!r}). "
                "Update your MCP server/SDK if needed."
            ) from e

        negotiated = res.get("protocolVersion")
        if not isinstance(negotiated, str) or not negotiated.strip():
            raise RuntimeError("MCP initialize result missing protocolVersion")
        negotiated_s = negotiated.strip()
        if negotiated_s not in set(_SUPPORTED_PROTOCOL_VERSIONS):
            raise RuntimeError(
                f"MCP server negotiated unsupported protocol version: {negotiated_s!r} "
                f"(client_supported={list(_SUPPORTED_PROTOCOL_VERSIONS)})"
            )

        # Follow the protocol: client notifies initialized after receiving the initialize result.
        self._notify("notifications/initialized")
        return res

    def list_tools(self, *, timeout_seconds: float = 8.0) -> list[McpTool]:
        res = self._request("tools/list", {}, timeout_seconds=float(timeout_seconds))
        tools_raw = res.get("tools")
        if not isinstance(tools_raw, list):
            raise RuntimeError(f"bad tools/list result: tools={type(tools_raw).__name__}")
        out: list[McpTool] = []
        for t in tools_raw:
            if not isinstance(t, dict):
                continue
            name = t.get("name")
            if not isinstance(name, str) or not name.strip():
                continue
            desc = t.get("description")
            desc_s = str(desc) if isinstance(desc, str) and desc.strip() else None
            input_schema = t.get("inputSchema") if isinstance(t.get("inputSchema"), dict) else None
            out.append(McpTool(name=name.strip(), description=desc_s, input_schema=input_schema))
        return out

    def call_tool_json(
        self,
        *,
        tool_name: str,
        arguments: dict[str, Any],
        timeout_seconds: float = 60.0,
    ) -> McpToolCallResult:
        # H-02: inject _trace_id for cross-component correlation
        trace_id = str(uuid.uuid4())
        augmented_args = {**arguments, "_trace_id": trace_id}
        res = self._request(
            "tools/call",
            {"name": str(tool_name), "arguments": augmented_args},
            timeout_seconds=float(timeout_seconds),
        )
        is_error = bool(res.get("isError")) if isinstance(res.get("isError"), bool) else False
        content = res.get("content")
        raw_text = ""
        if isinstance(content, list):
            texts: list[str] = []
            for b in content:
                if isinstance(b, dict) and b.get("type") == "text" and isinstance(b.get("text"), str):
                    texts.append(b.get("text"))
            raw_text = "\n".join(texts).strip()
        parsed: Any | None = None
        if raw_text:
            try:
                parsed = json.loads(raw_text)
            except Exception:  # CONTRACT-EXEMPT: CODE-01.5 intentional fallback
                parsed = None

        # H-14a: extract structured error_code from error responses
        error_code: str | None = None
        if is_error and parsed is not None and isinstance(parsed, dict):
            error_code = parsed.get("error_code") if isinstance(parsed.get("error_code"), str) else None
        if is_error and error_code is None and raw_text:
            # Attempt to extract error code from structured text like "ERROR_CODE: ..."
            for line in raw_text.splitlines():
                stripped = line.strip()
                if ":" in stripped and stripped.split(":")[0].replace("_", "").isalpha():
                    candidate = stripped.split(":")[0].strip()
                    if candidate.isupper() and "_" in candidate:
                        error_code = candidate
                        break

        # H-02: extract trace_id from response (error responses include it)
        resp_trace_id: str | None = trace_id
        if parsed is not None and isinstance(parsed, dict):
            resp_tid = parsed.get("trace_id")
            if isinstance(resp_tid, str) and resp_tid.strip():
                resp_trace_id = resp_tid.strip()

        return McpToolCallResult(
            ok=not is_error,
            is_error=is_error,
            raw_text=raw_text,
            json=parsed,
            error_code=error_code,
            trace_id=resp_trace_id,
        )
