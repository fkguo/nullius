from __future__ import annotations

import hashlib
import json
import os
import urllib.request
from pathlib import Path
from typing import Any


def _http_mode() -> str:
    # Modes:
    # - live: normal network access
    # - record: network + write fixtures
    # - replay: fixtures only (no network)
    # - fail_all: always fail network
    v = (os.environ.get("HEPAR_HTTP_MODE") or "live").strip().lower()
    return v or "live"


def _fixtures_dir() -> Path | None:
    v = (os.environ.get("HEPAR_HTTP_FIXTURES_DIR") or "").strip()
    if not v:
        return None
    p = Path(v)
    return p if p.is_absolute() else Path.cwd() / p


def _fixture_key(url: str) -> str:
    return hashlib.sha256(url.encode("utf-8")).hexdigest()


def _fixture_path(url: str, *, kind: str) -> Path:
    fixtures = _fixtures_dir()
    if fixtures is None:
        raise RuntimeError("HEPAR_HTTP_FIXTURES_DIR is required for HEPAR_HTTP_MODE=record|replay")
    fixtures.mkdir(parents=True, exist_ok=True)
    sha = _fixture_key(url)
    ext = {"json": "json", "text": "txt", "bin": "bin"}.get(kind, "bin")
    return fixtures / f"{sha}.{ext}"


def _fixture_url_path(url: str) -> Path:
    fixtures = _fixtures_dir()
    if fixtures is None:
        raise RuntimeError("HEPAR_HTTP_FIXTURES_DIR is required for HEPAR_HTTP_MODE=record|replay")
    fixtures.mkdir(parents=True, exist_ok=True)
    sha = _fixture_key(url)
    return fixtures / f"{sha}.url.txt"


def _write_url_sidecar(url: str) -> None:
    try:
        p = _fixture_url_path(url)
        if p.exists():
            return
        p.write_text(url.strip() + "\n", encoding="utf-8")
    except Exception:
        # Best effort: sidecar is for humans, not correctness.
        return


def _maybe_replay(url: str, *, kind: str) -> bytes | None:
    mode = _http_mode()
    if mode not in {"replay", "record"}:
        return None
    p = _fixture_path(url, kind=kind)
    if mode == "replay":
        if not p.exists():
            raise FileNotFoundError(f"missing HTTP fixture: {p} (url={url})")
        return p.read_bytes()
    # record: replay if already present (idempotent)
    if p.exists():
        return p.read_bytes()
    return None


def _maybe_record(url: str, *, kind: str, payload: bytes) -> None:
    if _http_mode() != "record":
        return
    p = _fixture_path(url, kind=kind)
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_bytes(payload)
    _write_url_sidecar(url)


def _guard_network(url: str) -> None:
    mode = _http_mode()
    if mode in {"fail", "fail_all"}:
        raise RuntimeError(f"HTTP disabled by HEPAR_HTTP_MODE={mode} (url={url})")
    if mode == "replay":
        # replay mode should never reach the network path
        raise RuntimeError(f"unexpected network access in HEPAR_HTTP_MODE=replay (url={url})")


def http_get_json(url: str, timeout_seconds: float = 60.0) -> dict[str, Any]:
    replay = _maybe_replay(url, kind="json")
    if replay is not None:
        return json.loads(replay.decode("utf-8", "replace"))

    _guard_network(url)
    req = urllib.request.Request(
        url,
        headers={
            "User-Agent": "hep-autoresearch/0 (W1_ingest; https://inspirehep.net)",
            "Accept": "application/json",
        },
    )
    with urllib.request.urlopen(req, timeout=timeout_seconds) as r:
        raw = r.read()
        _maybe_record(url, kind="json", payload=raw)
        return json.loads(raw.decode("utf-8", "replace"))


def http_get_text(url: str, timeout_seconds: float = 60.0) -> str:
    replay = _maybe_replay(url, kind="text")
    if replay is not None:
        return replay.decode("utf-8", "replace")

    _guard_network(url)
    req = urllib.request.Request(
        url,
        headers={
            "User-Agent": "hep-autoresearch/0 (W1_ingest; https://inspirehep.net)",
            "Accept": "*/*",
        },
    )
    with urllib.request.urlopen(req, timeout=timeout_seconds) as r:
        raw = r.read()
        _maybe_record(url, kind="text", payload=raw)
        return raw.decode("utf-8", "replace")


def http_download(url: str, dest_path, timeout_seconds: float = 120.0) -> None:
    dest_path.parent.mkdir(parents=True, exist_ok=True)

    replay = _maybe_replay(url, kind="bin")
    if replay is not None:
        dest_path.write_bytes(replay)
        return

    _guard_network(url)
    req = urllib.request.Request(
        url,
        headers={
            "User-Agent": "hep-autoresearch/0 (W1_ingest; https://inspirehep.net)",
            "Accept": "*/*",
        },
    )
    with urllib.request.urlopen(req, timeout=timeout_seconds) as r:
        raw = r.read()
        _maybe_record(url, kind="bin", payload=raw)
        dest_path.write_bytes(raw)
