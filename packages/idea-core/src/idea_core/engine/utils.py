from __future__ import annotations

import hashlib
from datetime import UTC, datetime
from typing import Any

import jcs


def utc_now_iso() -> str:
    return datetime.now(UTC).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def sha256_hex(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def canonical_json(data: Any) -> str:
    """RFC 8785 canonical JSON string for idempotency payload hashing."""
    return jcs.canonicalize(data).decode("utf-8")


def payload_hash(params_without_idempotency: Any) -> str:
    return f"sha256:{sha256_hex(canonical_json(params_without_idempotency))}"
