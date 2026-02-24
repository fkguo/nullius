from __future__ import annotations

import abc
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Literal


BackendKind = Literal["shell", "mcp", "internal"]


@dataclass(frozen=True)
class PrepareResult:
    artifact_dir: Path
    required_gates: tuple[str, ...]
    run_card: dict[str, Any]
    run_card_path: Path
    run_card_sha256: str
    skip_execute: bool = False
    skip_reason: str | None = None


@dataclass(frozen=True)
class ExecuteResult:
    ok: bool
    exit_code: int | None
    timed_out: bool
    duration_seconds: float | None
    stdout_path: Path | None
    stderr_path: Path | None
    stdout_preview: str | None
    stderr_preview: str | None
    provenance: dict[str, Any]
    errors: list[str]


@dataclass(frozen=True)
class CollectResult:
    artifact_dir: Path
    artifact_paths: dict[str, str]
    errors: list[str]


@dataclass(frozen=True)
class VerifyResult:
    ok: bool
    messages: list[str]


class Adapter(abc.ABC):
    """Adapter lifecycle: prepare -> execute -> collect -> verify.

    Notes:
    - Adapters must be deterministic and auditable: all executions must be captured into SSOT artifacts
      (manifest/summary/analysis) under artifacts/runs/<tag>/<step>/.
    - Adapters must be safe-by-default: any action that triggers network / code edits / paper edits / compute
      must be routed through Orchestrator approvals (A1–A5). Adapters express required gates via prepare().
    """

    @property
    @abc.abstractmethod
    def adapter_id(self) -> str: ...

    @property
    @abc.abstractmethod
    def backend_kind(self) -> BackendKind: ...

    @abc.abstractmethod
    def prepare(self, run_card: dict[str, Any], state: dict[str, Any], *, repo_root: Path, force: bool) -> PrepareResult: ...

    @abc.abstractmethod
    def execute(self, prep: PrepareResult, state: dict[str, Any], *, repo_root: Path) -> ExecuteResult: ...

    @abc.abstractmethod
    def collect(
        self,
        prep: PrepareResult,
        exec_result: ExecuteResult | None,
        state: dict[str, Any],
        *,
        repo_root: Path,
        status: str,
    ) -> CollectResult: ...

    @abc.abstractmethod
    def verify(self, collected: CollectResult, state: dict[str, Any], *, repo_root: Path) -> VerifyResult: ...

