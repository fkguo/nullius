"""Activation monitor: grouping, guidance, suggested-command shape, mock rpc."""

from __future__ import annotations

import json
import shutil
import subprocess
import sys
import uuid
from pathlib import Path

import pytest

import activation_monitor as am
# Paths derived locally rather than imported from conftest: pytest loads each
# directory's conftest for sys.path wiring, but importing conftest AS A MODULE
# collides when several skills' suites run in one pytest invocation (the first
# loaded conftest shadows the rest in sys.modules).
SCRIPTS_DIR = Path(__file__).resolve().parents[1] / "scripts"
FIXTURES_DIR = Path(__file__).resolve().parent / "fixtures"

FIXTURE = FIXTURES_DIR / "nodes_latest.json"
# Engine short id: 8 chars of lowercase Crockford base32.
CAMPAIGN_ID = "0f3c2c8e"
SCRIPT = SCRIPTS_DIR / "activation_monitor.py"

MOCK_RPC_SOURCE = """\
#!/usr/bin/env node
// Mock of packages/idea-engine/bin/idea-rpc.mjs — pinned interface shape only.
// Id params mirror the engine openrpc contract: campaign_id/node_id are
// engine short ids; idempotency_key is a free-form non-empty string.
const SHORT_ID_RE = /^[0123456789abcdefghjkmnpqrstvwxyz]{8}$/;
let raw = '';
process.stdin.on('data', (chunk) => { raw += chunk; });
process.stdin.on('end', () => {
  const request = JSON.parse(raw);
  const problems = [];
  if (request.method !== 'node.set_lifecycle') problems.push('bad method');
  const params = request.params || {};
  for (const key of ['campaign_id', 'node_id', 'idempotency_key', 'lifecycle_state']) {
    if (typeof params[key] !== 'string' || params[key].length === 0) {
      problems.push(`missing params.${key}`);
    }
  }
  for (const key of ['campaign_id', 'node_id']) {
    if (typeof params[key] === 'string' && !SHORT_ID_RE.test(params[key])) {
      problems.push(`params.${key} fails the engine short-id pattern`);
    }
  }
  if (typeof request.store_root !== 'string') problems.push('missing store_root');
  if ('store_root' in params) problems.push('store_root must not sit inside params');
  if (problems.length > 0) {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', error: { message: problems.join('; ') } }));
    process.exit(1);
  }
  process.stdout.write(JSON.stringify({
    jsonrpc: '2.0',
    result: { ok: true, node_id: params.node_id, lifecycle_state: params.lifecycle_state },
  }));
});
"""


def run_monitor(args, cwd: Path):
    return subprocess.run(
        [sys.executable, str(SCRIPT)] + args,
        cwd=str(cwd),
        capture_output=True,
        text=True,
    )


def monitor_report(tmp_path: Path, rpc_path: str = "packages/idea-engine/bin/idea-rpc.mjs"):
    result = run_monitor(
        [
            "--nodes", str(FIXTURE),
            "--store-root", "/campaigns/example-store",
            "--rpc-path", rpc_path,
        ],
        cwd=tmp_path,
    )
    assert result.returncode == 0, result.stderr
    return result.stdout


def extract_commands(report: str):
    return [line.strip() for line in report.splitlines() if line.strip().startswith("echo '")]


# ---------------------------------------------------------------------------
# Report structure
# ---------------------------------------------------------------------------

def test_report_groups_by_kind_with_guidance(tmp_path):
    report = monitor_report(tmp_path)
    assert f"campaign {CAMPAIGN_ID}" in report
    assert "waiting_activation nodes: 5" in report
    for kind in ("tool_readiness", "data_release", "stage_reached",
                 "exploratory_computation", "other"):
        assert f"== {kind} (1) ==" in report
        assert am.CHECK_GUIDANCE[kind].split(".")[0] in report
    # Each waiting node appears under its kind with its description.
    assert "de1ta000" in report and "seeded smoke run" in report
    assert "1ambda00" in report and "instrument logbook" in report
    # Non-waiting nodes never appear.
    for absent in ("a1pha000", "gamma000", "zeta0000"):
        assert absent not in report


def test_last_checked_at_shown_and_note_present(tmp_path):
    report = monitor_report(tmp_path)
    assert "last_checked_at=2026-06-28T16:00:00Z" in report  # de1ta000
    assert "last_checked_at=never" in report                 # nodes without the field
    assert "NOTE on last_checked_at" in report
    assert "updates last_checked_at in the campaign store" in report


def test_only_satisfied_nodes_get_commands(tmp_path):
    report = monitor_report(tmp_path)
    commands = extract_commands(report)
    assert len(commands) == 1  # only eps110n0 has satisfied=true
    assert "eps110n0" in commands[0]
    ready_section = report.split("READY TO ACTIVATE")[1]
    assert "eps110n0" in ready_section
    assert "de1ta000" not in ready_section.split("NOTE on last_checked_at")[0]


# ---------------------------------------------------------------------------
# Suggested command shape (the pinned rpc interface)
# ---------------------------------------------------------------------------

def parse_command(command: str):
    assert command.startswith("echo '")
    payload_text, _, rest = command[len("echo '"):].partition("'")
    assert rest.strip().startswith("| node ")
    rpc_path = rest.strip()[len("| node "):]
    return json.loads(payload_text), rpc_path


def test_suggested_command_shape_matches_pinned_interface(tmp_path):
    report = monitor_report(tmp_path)
    payload, rpc_path = parse_command(extract_commands(report)[0])
    assert rpc_path == "packages/idea-engine/bin/idea-rpc.mjs"
    assert set(payload) == {"method", "params", "store_root"}
    assert payload["method"] == "node.set_lifecycle"
    assert payload["store_root"] == "/campaigns/example-store"
    params = payload["params"]
    assert set(params) == {"campaign_id", "node_id", "idempotency_key", "lifecycle_state"}
    assert params["campaign_id"] == CAMPAIGN_ID
    assert params["node_id"] == "eps110n0"
    assert params["lifecycle_state"] == "active"
    # The engine RPC contract pins idempotency_key as a free-form non-empty
    # string (NOT an engine short id); the monitor's deterministic uuid5
    # derivation is deliberate and stays.
    uuid.UUID(params["idempotency_key"])  # parseable uuid


def test_idempotency_key_is_deterministic(tmp_path):
    report_one = monitor_report(tmp_path)
    report_two = monitor_report(tmp_path)
    assert extract_commands(report_one) == extract_commands(report_two)
    payload, _ = parse_command(extract_commands(report_one)[0])
    rebuilt = am.build_rpc_payload(CAMPAIGN_ID, "eps110n0", "/campaigns/example-store")
    assert payload == rebuilt


def test_unquotable_payload_degrades_to_plain_json():
    # Node and campaign ids can no longer carry a single quote (engine short
    # ids), but store_root still can — the degradation path must survive.
    payload = am.build_rpc_payload(CAMPAIGN_ID, "eps110n0", "/campaigns/o'brien-store")
    assert am.suggest_activation_command(payload, "rpc.mjs") is None


# ---------------------------------------------------------------------------
# Mock rpc round trip: the suggested command actually runs and the mock
# accepts the pinned shape
# ---------------------------------------------------------------------------

@pytest.mark.skipif(
    shutil.which("node") is None,
    reason="node not on PATH (repo toolchain requires it; guard for minimal envs)",
)
def test_suggested_command_round_trips_through_mock_rpc(tmp_path):
    mock_rpc = tmp_path / "mock-idea-rpc.mjs"
    mock_rpc.write_text(MOCK_RPC_SOURCE, encoding="utf-8")
    report = monitor_report(tmp_path, rpc_path=str(mock_rpc))
    command = extract_commands(report)[0]
    completed = subprocess.run(
        command, shell=True, cwd=str(tmp_path), capture_output=True, text=True
    )
    assert completed.returncode == 0, completed.stdout + completed.stderr
    response = json.loads(completed.stdout)
    assert response["result"]["ok"] is True
    assert response["result"]["node_id"] == "eps110n0"
    assert response["result"]["lifecycle_state"] == "active"


@pytest.mark.skipif(
    shutil.which("node") is None,
    reason="node not on PATH (repo toolchain requires it; guard for minimal envs)",
)
def test_mock_rpc_rejects_malformed_request(tmp_path):
    mock_rpc = tmp_path / "mock-idea-rpc.mjs"
    mock_rpc.write_text(MOCK_RPC_SOURCE, encoding="utf-8")
    bad = {"method": "node.set_lifecycle", "params": {"node_id": "idea-x"}}
    completed = subprocess.run(
        ["node", str(mock_rpc)],
        input=json.dumps(bad),
        capture_output=True,
        text=True,
    )
    assert completed.returncode == 1
    response = json.loads(completed.stdout)
    assert "error" in response
