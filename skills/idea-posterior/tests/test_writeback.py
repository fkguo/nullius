"""Tests for posterior_writeback.py against the stand-in RPC caller."""

from __future__ import annotations

import json
import re
import sys

import pytest

import posterior_writeback as writeback

PIN = "sha256:e314d88c63c80b8845d2c1347e0f20b77db5825076d847ecd1c143a925afc676"

POSTERIOR = {
    "value": 0.8499370175790979,
    "evidence_count": 2,
    # Machine-portable: relative to the project root, pinned by content.
    "gaia_package_ref": f"project://example-idea-gaia#{PIN}",
}


def write_posterior_file(tmp_path):
    path = tmp_path / "posterior.json"
    path.write_text(json.dumps(POSTERIOR), encoding="utf-8")
    return path


def make_package(tmp_path, rel="example-idea-gaia", ir_hash=PIN):
    """A package on disk that the reference under test resolves to."""
    gaia_dir = tmp_path / rel / ".gaia"
    gaia_dir.mkdir(parents=True, exist_ok=True)
    (gaia_dir / "ir.json").write_text(
        json.dumps({"ir_hash": ir_hash}), encoding="utf-8"
    )


def run_main(tmp_path, fixtures_dir, extra_args=(), *, package=True,
             project_root=True):
    if package:
        make_package(tmp_path)
    root_args = ("--project-root", str(tmp_path)) if project_root else ()
    return writeback.main(
        [
            "--posterior-json", str(write_posterior_file(tmp_path)),
            "--campaign-id", "campaign-1",
            "--node-id", "node-7",
            "--store-root", str(tmp_path / "store"),
            *root_args,
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
    # The fake mirrors the real caller: error envelope on stdout AND exit 1.
    # A store rejection must be reported as such (exit 1), not as an
    # infrastructure failure of the caller (exit 2).
    monkeypatch.setenv("FAKE_RPC_FAIL", "1")
    assert run_main(tmp_path, fixtures_dir) == 1
    err = capsys.readouterr().err
    assert "store rejected" in err


def test_caller_crash_is_infrastructure_failure(
    tmp_path, fixtures_dir, capsys, monkeypatch
) -> None:
    monkeypatch.setenv("FAKE_RPC_CRASH", "1")
    assert run_main(tmp_path, fixtures_dir) == 2
    err = capsys.readouterr().err
    assert "RPC caller exited 3" in err


def test_key_is_printed_before_the_write_attempt(
    tmp_path, fixtures_dir, capsys, monkeypatch
) -> None:
    # If the caller dies after the store committed but before the response
    # was read, the pre-write key line is the only way to retry THAT write
    # via --idempotency-key — a --new-write salt cannot be re-derived.
    monkeypatch.setenv("FAKE_RPC_FAIL", "1")
    assert run_main(tmp_path, fixtures_dir, ("--new-write",)) == 1
    err = capsys.readouterr().err
    match = re.search(r"using idempotency key (\S+)", err)
    assert match is not None
    assert "-fresh-" in match.group(1)


def test_explicit_idempotency_key_wins(tmp_path, fixtures_dir, capsys) -> None:
    assert run_main(
        tmp_path, fixtures_dir, ("--idempotency-key", "explicit-key-1")
    ) == 0
    response = json.loads(capsys.readouterr().out)
    assert response["result"]["echo"]["params"]["idempotency_key"] == "explicit-key-1"


def test_new_write_mints_unique_keys(tmp_path, fixtures_dir, capsys) -> None:
    deterministic = writeback.derive_idempotency_key(
        "campaign-1", "node-7", writeback.validate_posterior(dict(POSTERIOR))
    )
    keys = []
    for _ in range(2):
        assert run_main(tmp_path, fixtures_dir, ("--new-write",)) == 0
        response = json.loads(capsys.readouterr().out)
        keys.append(response["result"]["echo"]["params"]["idempotency_key"])
    # Distinct per invocation (a fresh write each time), but still carrying
    # the deterministic digest as an auditable prefix.
    assert keys[0] != keys[1]
    for key in keys:
        assert key.startswith(deterministic + "-fresh-")


def test_new_write_conflicts_with_explicit_key(tmp_path, fixtures_dir) -> None:
    with pytest.raises(SystemExit) as excinfo:
        run_main(
            tmp_path,
            fixtures_dir,
            ("--new-write", "--idempotency-key", "explicit-key-1"),
        )
    assert excinfo.value.code == 2


def test_replayed_write_is_surfaced(
    tmp_path, fixtures_dir, capsys, monkeypatch
) -> None:
    # A duplicate-key hit is NOT silent: the store replays the archived
    # response (no new revision), and the script must say so and point at
    # --new-write instead of reporting a fresh write.
    monkeypatch.setenv("FAKE_RPC_REPLAY", "1")
    assert run_main(tmp_path, fixtures_dir) == 0
    out = capsys.readouterr()
    assert "REPLAYED" in out.err
    assert "--new-write" in out.err
    assert "posterior written" not in out.err


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
        "project://example-idea-gaia",  # no hash at all
        "project://example-idea-gaia#sha256:abc123",  # hash too short
        "project://example-idea-gaia#md5:" + "a" * 32,  # wrong algorithm tag
        "project:///#sha256:" + "a" * 64,  # absolute path smuggled in
        # Machine-absolute forms are refused outright: synced projects land
        # at different absolute paths, so a file:// URI or a bare path goes
        # stale on every machine but this one (live-project feedback,
        # 2026-07). The relative form plus the content pin stays valid.
        "file:///tmp/example-idea-gaia#sha256:" + "a" * 64,
        "/tmp/example-idea-gaia#sha256:" + "a" * 64,
    ):
        with pytest.raises(ValueError, match="pin the compiled graph"):
            writeback.validate_posterior(
                dict(POSTERIOR, gaia_package_ref=bad_ref)
            )


def test_validate_posterior_rejects_path_escapes() -> None:
    for bad_ref in (
        f"project://../outside-gaia#{PIN}",
        f"project://a/../../outside-gaia#{PIN}",
        f"project://a//b#{PIN}",
    ):
        with pytest.raises(ValueError, match="segments"):
            writeback.validate_posterior(
                dict(POSTERIOR, gaia_package_ref=bad_ref)
            )


def test_ref_must_resolve_under_the_project_root(
    tmp_path, fixtures_dir, capsys
) -> None:
    # No package on disk: archiving a reference nobody can follow is
    # refused, with the refresh command in the message.
    assert run_main(tmp_path, fixtures_dir, package=False) == 2
    err = capsys.readouterr().err
    assert "does not resolve" in err
    assert "run_infer_and_extract.py" in err


def test_ref_pin_must_match_package_state(
    tmp_path, fixtures_dir, capsys
) -> None:
    make_package(tmp_path, ir_hash="sha256:" + "b" * 64)
    assert run_main(tmp_path, fixtures_dir, package=False) == 2
    err = capsys.readouterr().err
    assert "does not match the package's current compiled state" in err


def test_project_root_defaults_to_nullius_ancestor_of_store(
    tmp_path, fixtures_dir, capsys
) -> None:
    (tmp_path / ".nullius").mkdir()
    assert run_main(tmp_path, fixtures_dir, project_root=False) == 0
    assert "posterior written" in capsys.readouterr().err


def test_missing_project_root_fails_with_guidance(
    tmp_path, fixtures_dir, capsys
) -> None:
    assert run_main(tmp_path, fixtures_dir, project_root=False) == 2
    assert "no project root found" in capsys.readouterr().err


def test_validate_posterior_refuses_exploration_only_refs() -> None:
    ref = "exploration-only:" + POSTERIOR["gaia_package_ref"]
    with pytest.raises(ValueError, match="not writable to the idea store"):
        writeback.validate_posterior(dict(POSTERIOR, gaia_package_ref=ref))


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
    make_package(tmp_path)
    code = writeback.main(
        [
            "--posterior-json", str(write_posterior_file(tmp_path)),
            "--campaign-id", "c",
            "--node-id", "n",
            "--store-root", str(tmp_path),
            "--project-root", str(tmp_path),
            "--idea-rpc", str(tmp_path / "missing-rpc.mjs"),
        ]
    )
    assert code == 2
    assert "RPC caller not found" in capsys.readouterr().err
