from __future__ import annotations

from dataclasses import dataclass
import os
from pathlib import Path
from queue import Empty, Queue
from threading import Event, Thread
import time
from typing import Any, Callable, Iterable, Protocol

from idea_core.engine.utils import payload_hash

from .control_plane import HeparControlPlaneStore, WorkOrder, WorkResult
from .fs_ops import safe_resolve_under
from .retry_ops import RetryPolicy, call_with_retry


_HIGH_RISK_TOOLS = {"shell", "fs", "mcp"}


class OpenCodeClient(Protocol):
    def create_session(self, *, work_id: str, input_artifacts: list[str], tool_policy: dict[str, Any]) -> str: ...

    def post_message(self, *, session_id: str, message: str) -> dict[str, Any]: ...

    def post_permission(
        self,
        *,
        session_id: str,
        permission_id: str,
        action: str,
        remember: bool,
    ) -> None: ...

    def stream_global_events(self, *, session_id: str) -> Iterable[dict[str, Any]]: ...


@dataclass(frozen=True)
class ToolPolicyEnforcer:
    allow_tools: frozenset[str]
    write_roots: tuple[Path, ...]

    @classmethod
    def from_work_order(cls, work_order: WorkOrder) -> "ToolPolicyEnforcer":
        policy = work_order.tool_policy
        allowed = frozenset(str(tool).strip().lower() for tool in policy.get("allow", []))
        roots: list[Path] = []
        for raw_path in policy.get("write_roots", []):
            try:
                roots.append(Path(raw_path).resolve(strict=True))
            except OSError:
                continue
        return cls(allow_tools=allowed, write_roots=tuple(roots))

    def is_tool_allowed(self, tool: str, *, requested_path: str | None, gate_approved: bool) -> bool:
        tool = str(tool).strip().lower()
        if tool in _HIGH_RISK_TOOLS and not gate_approved:
            return False

        if tool not in self.allow_tools:
            return False

        if tool != "fs":
            return True

        if requested_path is None:
            return False

        for root in self.write_roots:
            try:
                _ = safe_resolve_under(root, requested_path)
                return True
            except ValueError:
                continue
        return False


class OpenCodeRuntimeAdapter:
    def __init__(
        self,
        *,
        control_plane_store: HeparControlPlaneStore,
        client: OpenCodeClient,
        external_timeout_s: float = 15.0,
        external_max_attempts: int = 3,
        external_backoff_initial_s: float = 0.05,
        external_backoff_max_s: float = 0.5,
    ) -> None:
        self.control_plane_store = control_plane_store
        self.client = client
        self._external_retry_policy = RetryPolicy(
            timeout_s=external_timeout_s,
            max_attempts=external_max_attempts,
            backoff_initial_s=external_backoff_initial_s,
            backoff_max_s=external_backoff_max_s,
        )

    def _call_external(self, op_name: str, fn: Callable[[], Any]) -> Any:
        return call_with_retry(fn, op_name=op_name, policy=self._external_retry_policy)

    @staticmethod
    def _prepare_runtime_tool_policy(tool_policy: dict[str, Any]) -> dict[str, Any]:
        prepared = dict(tool_policy)
        raw_whitelist = prepared.get("env_whitelist")
        if not isinstance(raw_whitelist, list):
            return prepared

        whitelist = [str(name).strip() for name in raw_whitelist if str(name).strip()]
        prepared["env_whitelist"] = whitelist
        prepared["env"] = {name: value for name, value in os.environ.items() if name in whitelist}
        return prepared

    def execute_work_order(
        self,
        work_order: WorkOrder,
        *,
        role_message: str,
        permission_resolver: Callable[[dict[str, Any]], dict[str, Any] | None] | None = None,
    ) -> WorkResult:
        order_record = self.control_plane_store.record_work_order(work_order)
        session_id: str | None = None
        execution: dict[str, Any]
        try:
            runtime_tool_policy = self._prepare_runtime_tool_policy(work_order.tool_policy)
            session_id = self._call_external(
                "runtime.create_session",
                lambda: self.client.create_session(
                    work_id=work_order.work_id,
                    input_artifacts=work_order.input_artifacts,
                    tool_policy=runtime_tool_policy,
                ),
            )
            self.control_plane_store.append_ledger_event(
                "runtime.session_started",
                work_id=work_order.work_id,
                session_id=session_id,
                artifact_ref=order_record["artifact_ref"],
                artifact_hash=order_record["artifact_hash"],
            )

            execution_done = Event()
            execution_payload: dict[str, Any] = {}
            execution_error: list[Exception] = []

            def _post_message() -> None:
                try:
                    result = self._call_external(
                        "runtime.post_message",
                        lambda: self.client.post_message(session_id=session_id, message=role_message),
                    )
                    execution_payload["result"] = dict(result)
                except Exception as exc:
                    execution_error.append(exc)
                finally:
                    execution_done.set()

            post_thread = Thread(target=_post_message, daemon=True)
            post_thread.start()
            self.ingest_sse_events(
                work_order=work_order,
                session_id=session_id,
                on_permission_request=permission_resolver,
                stop_when=execution_done.is_set,
            )
            expected_max_post_s = (
                self._external_retry_policy.timeout_s * self._external_retry_policy.max_attempts
                + self._external_retry_policy.backoff_max_s
                * max(self._external_retry_policy.max_attempts - 1, 0)
                + 1.0
            )
            post_thread.join(timeout=max(expected_max_post_s, 0.1))
            if post_thread.is_alive():
                raise TimeoutError("runtime.post_message did not complete before join timeout")
            if execution_error:
                raise execution_error[-1]
            execution = execution_payload.get("result", {})
        except Exception as exc:
            execution = {
                "status": "failed",
                "outputs": [],
                "summary": f"{type(exc).__name__}: {exc}",
                "model": "runtime_error",
            }
            self.control_plane_store.append_ledger_event(
                "runtime.session_failed",
                work_id=work_order.work_id,
                session_id=session_id,
                error_type=type(exc).__name__,
                error_message=str(exc),
                artifact_hash=payload_hash(execution),
            )

        status = str(execution.get("status", "failed"))
        result = WorkResult(
            work_id=work_order.work_id,
            status=status,
            outputs=[str(uri) for uri in execution.get("outputs", [])],
            summary=str(execution.get("summary", "")),
            provenance={
                "runtime": "opencode",
                "session_id": session_id,
                "model": str(execution.get("model", "unknown")),
                "role": work_order.role_id,
            },
        )
        result_record = self.control_plane_store.record_work_result(result)

        self.control_plane_store.append_ledger_event(
            "runtime.execution_summary",
            work_id=work_order.work_id,
            session_id=session_id,
            artifact_ref=result_record["artifact_ref"],
            artifact_hash=payload_hash(execution),
            status=status,
            output_count=len(result.outputs),
        )

        return result

    def handle_permission_request(
        self,
        *,
        work_order: WorkOrder,
        session_id: str,
        request_event: dict[str, Any],
        gate_decision: dict[str, Any],
        record_requested_event: bool = True,
    ) -> dict[str, Any]:
        permission_id = str(request_event.get("permission_id", ""))
        tool = str(request_event.get("tool", ""))
        path = request_event.get("path")

        if record_requested_event:
            self.control_plane_store.append_ledger_event(
                "runtime.permission_requested",
                work_id=work_order.work_id,
                session_id=session_id,
                permission_id=permission_id,
                tool=tool,
                path=path,
                artifact_hash=payload_hash(request_event),
            )

        requested_action = str(gate_decision.get("action", "ask"))
        remember = bool(gate_decision.get("remember", False))
        if requested_action not in {"allow", "deny", "ask"}:
            requested_action = "ask"

        resolved_action = requested_action
        if requested_action == "allow":
            enforcer = ToolPolicyEnforcer.from_work_order(work_order)
            if not enforcer.is_tool_allowed(tool, requested_path=path, gate_approved=True):
                resolved_action = "deny"

        try:
            self._call_external(
                "runtime.post_permission",
                lambda: self.client.post_permission(
                    session_id=session_id,
                    permission_id=permission_id,
                    action=resolved_action,
                    remember=remember,
                ),
            )
        except Exception as exc:
            self.control_plane_store.append_ledger_event(
                "runtime.permission_failed",
                work_id=work_order.work_id,
                session_id=session_id,
                permission_id=permission_id,
                tool=tool,
                action=resolved_action,
                error_type=type(exc).__name__,
                error_message=str(exc),
            )
            return {"action": "deny", "remember": False, "error": str(exc)}

        self.control_plane_store.append_ledger_event(
            "runtime.permission_resolved",
            work_id=work_order.work_id,
            session_id=session_id,
            permission_id=permission_id,
            tool=tool,
            action=resolved_action,
            remember=remember,
        )
        return {"action": resolved_action, "remember": remember}

    def _sse_event_key(self, event: dict[str, Any]) -> str:
        event_type = str(event.get("type", "runtime_event")).strip().lower()
        event_id = event.get("event_id")
        if isinstance(event_id, str) and event_id.strip():
            return f"{event_type}:{event_id}"
        return f"{event_type}:{payload_hash(event)}"

    def ingest_sse_events(
        self,
        *,
        work_order: WorkOrder,
        session_id: str,
        max_events: int = 1000,
        max_wall_s: float = 60.0,
        on_permission_request: Callable[[dict[str, Any]], dict[str, Any] | None] | None = None,
        stop_when: Callable[[], bool] | None = None,
    ) -> int:
        started = time.monotonic()
        stream_queue: Queue[dict[str, Any] | object] = Queue()
        stream_done = object()
        stream_error: list[Exception] = []
        seen_event_keys = self.control_plane_store.session_event_keys(session_id=session_id)

        def _producer() -> None:
            try:
                stream = self._call_external(
                    "runtime.stream_global_events",
                    lambda: self.client.stream_global_events(session_id=session_id),
                )
                for event in stream:
                    stream_queue.put(event)
            except Exception as exc:  # pragma: no cover - exercised in integration paths
                stream_error.append(exc)
            finally:
                stream_queue.put(stream_done)

        Thread(target=_producer, daemon=True).start()
        count = 0
        while True:
            if count >= max_events:
                self.control_plane_store.append_ledger_event(
                    "runtime.sse_limit_reached",
                    work_id=work_order.work_id,
                    session_id=session_id,
                    reason="max_events",
                    events_consumed=count,
                    max_events=max_events,
                )
                break
            if time.monotonic() - started > max_wall_s:
                self.control_plane_store.append_ledger_event(
                    "runtime.sse_limit_reached",
                    work_id=work_order.work_id,
                    session_id=session_id,
                    reason="max_wall_s",
                    events_consumed=count,
                    max_wall_s=max_wall_s,
                )
                break

            timeout_s = max(min(max_wall_s - (time.monotonic() - started), 0.1), 0.0)
            try:
                queued = stream_queue.get(timeout=timeout_s if timeout_s > 0 else 0.01)
            except Empty:
                if stop_when is not None and stop_when():
                    break
                continue

            if queued is stream_done:
                break
            if not isinstance(queued, dict):
                continue
            event = queued

            event_key = self._sse_event_key(event)
            if event_key in seen_event_keys:
                continue

            event_type = str(event.get("type", "runtime_event"))
            if event_type == "permission_request":
                self.control_plane_store.append_ledger_event(
                    "runtime.permission_requested",
                    work_id=work_order.work_id,
                    session_id=session_id,
                    event_key=event_key,
                    permission_id=event.get("permission_id"),
                    tool=event.get("tool"),
                    path=event.get("path"),
                    artifact_hash=payload_hash(event),
                )
                if on_permission_request is not None:
                    try:
                        gate_decision = on_permission_request(event)
                        if gate_decision is not None:
                            self.handle_permission_request(
                                work_order=work_order,
                                session_id=session_id,
                                request_event=event,
                                gate_decision=gate_decision,
                                record_requested_event=False,
                            )
                    except Exception as exc:
                        self.control_plane_store.append_ledger_event(
                            "runtime.permission_callback_failed",
                            work_id=work_order.work_id,
                            session_id=session_id,
                            permission_id=event.get("permission_id"),
                            error_type=type(exc).__name__,
                            error_message=str(exc),
                        )
            elif event_type == "execution_summary":
                self.control_plane_store.append_ledger_event(
                    "runtime.execution_summary",
                    work_id=work_order.work_id,
                    session_id=session_id,
                    event_key=event_key,
                    summary=event.get("summary", ""),
                    output_count=len(event.get("outputs", [])),
                    artifact_hash=payload_hash(event),
                )
            else:
                self.control_plane_store.append_ledger_event(
                    "runtime.event_observed",
                    work_id=work_order.work_id,
                    session_id=session_id,
                    event_key=event_key,
                    runtime_event_type=event_type,
                    artifact_hash=payload_hash(event),
                )
            seen_event_keys.add(event_key)
            count += 1
        if stream_error:
            exc = stream_error[-1]
            self.control_plane_store.append_ledger_event(
                "runtime.sse_stream_failed",
                work_id=work_order.work_id,
                session_id=session_id,
                error_type=type(exc).__name__,
                error_message=str(exc),
            )
        return count
