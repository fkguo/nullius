"""Tests for posterior_writeback.py against the stand-in RPC caller."""

from __future__ import annotations

import json
import sys

import pytest

import posterior_writeback as writeback

POSTERIOR = {
    "value": 0.8499370175790979,
    "evidence_count": 2,
    "gaia_package_ref": (
        "/tmp/example-idea-gaia#sha256:"
        "e314d88c63c80b8845d2c1347e0f20b77db5825076d847ecd1c143a925afc676"
    ),
}


def write_posterior_file(tmp_path):
    path = tmp_path / "posterior.json"
    path.write_text(json.dumps(POSTERIOR), encoding="utf-8")
    return path


def run_main(tmp_path, fixtures_dir, extra_args=()):
    return writeback.main(
        [
            "--posterior-json", str(write_posterior_file(tmp_path)),
            "--campaign-id", "campaign-1",
            "--node-id", "node-7",
            "--store-root", str(tmp_path / "store"),
            "--idea-rpc", str(fixtures_dir / "fake_rpc.py"),
            "--runner", sys.executable,
            *extra_args,
        ]
    )


def test_successful_writeback_request_shape(tmp_path, fixtures_dir, capsys) -> None:
    assert run_main(tmp_path, fixtures_dir) == 0
    out = capsys.readouterr()
    response = json.loads(out.out)
    echo = response["result"]["echo"]
    assert echo["method"] == "node.set_posterior"
    assert echo["store_root"] == str(tmp_path / "store")
    params = echo["params"]
    assert params["campaign_id"] == "campaign-1"
    assert params["node_id"] == "node-7"
    assert params["idempotency_key"].startswith("idea-posterior-")
    assert params["posterior"] == POSTERIOR
    assert "posterior written" in out.err


def test_error_response_fails_loudly(tmp_path, fixtures_dir, capsys, monkeypatch) -> None:
    monkeypatch.setenv("FAKE_RPC_FAIL", "1")
    assert run_main(tmp_path, fixtures_dir) == 1
    err = capsys.readouterr().err
    assert "store rejected" in err


def test_explicit_idempotency_key_wins(tmp_path, fixtures_dir, capsys) -> None:
    assert run_main(
        tmp_path, fixtures_dir, ("--idempotency-key", "explicit-key-1")
    ) == 0
    response = json.loads(capsys.readouterr().out)
    assert response["result"]["echo"]["params"]["idempotency_key"] == "explicit-key-1"


def test_idempotency_key_is_deterministic_and_sensitive() -> None:
    key_a = writeback.derive_idempotency_key("c", "n", POSTERIOR)
    key_b = writeback.derive_idempotency_key("c", "n", POSTERIOR)
    assert key_a == key_b
    changed = dict(POSTERIOR, value=0.5)
    assert writeback.derive_idempotency_key("c", "n", changed) != key_a
    assert writeback.derive_idempotency_key("c2", "n", POSTERIOR) != key_a


def test_idempotency_key_distinguishes_any_two_float_values() -> None:
    # repr() is the shortest round-trip float representation: even values
    # differing in the last bit must yield different keys.
    close_a = dict(POSTERIOR, value=0.5)
    close_b = dict(POSTERIOR, value=0.5000000000000001)
    assert close_a["value"] != close_b["value"]
    assert writeback.derive_idempotency_key(
        "c", "n", close_a
    ) != writeback.derive_idempotency_key("c", "n", close_b)


def test_validate_posterior_requires_pinned_ref() -> None:
    for bad_ref in (
        "/tmp/example-idea-gaia",  # no hash at all
        "/tmp/example-idea-gaia#sha256:abc123",  # hash too short
        "/tmp/example-idea-gaia#md5:" + "a" * 32,  # wrong algorithm tag
        "#sha256:" + "a" * 64,  # hash with no package path
    ):
        with pytest.raises(ValueError, match="pin the compiled graph"):
            writeback.validate_posterior(
                dict(POSTERIOR, gaia_package_ref=bad_ref)
            )


def test_idempotency_key_immune_to_delimiter_injection() -> None:
    # A newline inside one field must not be confusable with the field
    # boundary: ("a\nb", "c") and ("a", "b\nc") are different writes.
    key_one = writeback.derive_idempotency_key("a\nb", "c", POSTERIOR)
    key_two = writeback.derive_idempotency_key("a", "b\nc", POSTERIOR)
    assert key_one != key_two


def test_validate_posterior_rejects_bad_payloads() -> None:
    with pytest.raises(ValueError, match="missing fields"):
        writeback.validate_posterior({"value": 0.5})
    with pytest.raises(ValueError, match="in \\[0, 1\\]"):
        writeback.validate_posterior(dict(POSTERIOR, value=1.5))
    with pytest.raises(ValueError, match="in \\[0, 1\\]"):
        writeback.validate_posterior(dict(POSTERIOR, value=True))
    with pytest.raises(ValueError, match="non-negative integer"):
        writeback.validate_posterior(dict(POSTERIOR, evidence_count=-1))
    with pytest.raises(ValueError, match="non-negative integer"):
        writeback.validate_posterior(dict(POSTERIOR, evidence_count=2.0))
    with pytest.raises(ValueError, match="non-empty string"):
        writeback.validate_posterior(dict(POSTERIOR, gaia_package_ref="  "))


def test_validate_posterior_drops_extra_fields() -> None:
    cleaned = writeback.validate_posterior(dict(POSTERIOR, stray="x"))
    assert set(cleaned) == {"value", "evidence_count", "gaia_package_ref"}


def test_missing_rpc_caller_is_diagnosed(tmp_path, capsys) -> None:
    code = writeback.main(
        [
            "--posterior-json", str(write_posterior_file(tmp_path)),
            "--campaign-id", "c",
            "--node-id", "n",
            "--store-root", str(tmp_path),
            "--idea-rpc", str(tmp_path / "missing-rpc.mjs"),
        ]
    )
    assert code == 2
    assert "RPC caller not found" in capsys.readouterr().err
