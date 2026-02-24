"""H-14a: McpToolCallResult.error_code preservation tests."""

from __future__ import annotations

from hep_autoresearch.toolkit.mcp_stdio_client import McpToolCallResult


def test_error_code_from_json() -> None:
    result = McpToolCallResult(
        ok=False,
        is_error=True,
        raw_text='{"error_code": "RATE_LIMIT", "message": "too many requests"}',
        json={"error_code": "RATE_LIMIT", "message": "too many requests"},
        error_code="RATE_LIMIT",
    )
    assert result.error_code == "RATE_LIMIT"


def test_error_code_none_on_success() -> None:
    result = McpToolCallResult(
        ok=True,
        is_error=False,
        raw_text='{"data": "ok"}',
        json={"data": "ok"},
    )
    assert result.error_code is None


def test_error_code_from_text_line() -> None:
    result = McpToolCallResult(
        ok=False,
        is_error=True,
        raw_text="INVALID_PARAMS: missing required field 'query'",
        json=None,
        error_code="INVALID_PARAMS",
    )
    assert result.error_code == "INVALID_PARAMS"


def test_default_error_code_is_none() -> None:
    result = McpToolCallResult(
        ok=True,
        is_error=False,
        raw_text="ok",
        json=None,
    )
    assert result.error_code is None
