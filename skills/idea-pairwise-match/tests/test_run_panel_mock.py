"""End-to-end tests for run_panel.py with stub judge runners.

Stubs stand in for the real family runners ONLY here: a real match must use
the real cross-family runners. The stub prints a fenced JSON vote (or noise)
to stdout, which is the documented --runner override contract.
"""

import json
import shlex
import subprocess
import sys
from pathlib import Path

import pytest

import assemble_match
import commit_criteria
import run_panel

SCRIPT = Path(run_panel.__file__)
SKILL_DIR = SCRIPT.parents[1]
CARD_A = SKILL_DIR / "examples" / "idea_card_a.json"
CARD_B = SKILL_DIR / "examples" / "idea_card_b.json"

IDEA_A = json.loads(CARD_A.read_text(encoding="utf-8"))["node_id"]
IDEA_B = json.loads(CARD_B.read_text(encoding="utf-8"))["node_id"]
CAMPAIGN_ID = "3b8e1f70-6c4d-4e0f-9a5b-1c2d3e4f5a6b"

STUB_SOURCE = '''#!/usr/bin/env python3
import json
import os
import sys

mode = sys.argv[2]
if mode == "garbage":
    print("no json here at all")
    sys.exit(0)
if mode.startswith("flaky:"):
    marker = mode.split(":", 1)[1]
    if not os.path.exists(marker):
        with open(marker, "w", encoding="utf-8") as handle:
            handle.write("first attempt\\n")
        print("transient failure")
        sys.exit(1)
    mode = "a"
payload = {
    "vote": mode,
    "anchored_arguments": [
        {
            "argument": "stub decisive point",
            "anchor_type": "computation",
            "anchor_ref": "artifact://campaign/toy/computations/stub.json",
        }
    ],
    "unanchored_arguments_discarded": 1,
    "extra_comment": "judges sometimes volunteer keys; they must be dropped",
}
print("stub preamble prose")
print("```json")
print(json.dumps(payload))
print("```")
'''


@pytest.fixture()
def stub(tmp_path):
    path = tmp_path / "stub_judge.py"
    path.write_text(STUB_SOURCE, encoding="utf-8")
    return path


def runner_arg(stub_path, mode):
    return "%s %s {prompt} %s" % (
        shlex.quote(sys.executable),
        shlex.quote(str(stub_path)),
        mode,
    )


def build_materials(tmp_path):
    materials = tmp_path / "materials"
    materials.mkdir()
    commitment = commit_criteria.build_commitment(
        ["tension resolution", "verification cost"]
    )
    commit_criteria.write_json_atomic(materials / "commitment.json", commitment)
    for side, card in (("a", CARD_A), ("b", CARD_B)):
        summary = run_panel.render_card_summary(side, card.read_text(encoding="utf-8"))
        (materials / ("card_summary_%s.md" % side)).write_text(summary, encoding="utf-8")
    for side, node in (("a", IDEA_A), ("b", IDEA_B)):
        statement = (
            "criteria_commitment: %s\n"
            "idea_node_id: %s\n\n"
            "# Advocacy statement: Idea %s\n\n"
            "## tension resolution\n\n"
            "The approach addresses the standing tension directly. "
            "[anchor: literature -> https://example.org/reference]\n\n"
            "## verification cost\n\n"
            "A pilot run bounds the verification effort. "
            "[anchor: computation -> artifact://campaign/toy/computations/pilot.json]\n\n"
            "## Honest weaknesses\n\n"
            "The pilot covers a narrow configuration family.\n"
            % (commitment["commitment_hash"], node, side.upper())
        )
        (materials / ("statement_%s.md" % side)).write_text(statement, encoding="utf-8")
    return materials, commitment


def run_panel_cli(materials, out_dir, extra):
    argv = [
        sys.executable,
        str(SCRIPT),
        "--materials-dir",
        str(materials),
        "--out-dir",
        str(out_dir),
        "--timeout-secs",
        "60",
    ] + extra
    return subprocess.run(argv, capture_output=True, text=True)


def test_full_panel_collects_four_family_votes(tmp_path, stub):
    materials, commitment = build_materials(tmp_path)
    out_dir = tmp_path / "panel"
    result = run_panel_cli(
        materials,
        out_dir,
        [
            "--runner", "claude=" + runner_arg(stub, "a"),
            "--runner", "codex=" + runner_arg(stub, "a"),
            "--runner", "opencode=" + runner_arg(stub, "b"),
            "--runner", "kimi=" + runner_arg(stub, "tie"),
            "--model-label", "codex=stub-model-for-test",
        ],
    )
    assert result.returncode == 0, result.stderr
    votes = sorted(path.name for path in (out_dir / "votes").glob("*.json"))
    assert votes == ["claude.json", "codex.json", "kimi.json", "opencode.json"]

    codex_vote = json.loads((out_dir / "votes" / "codex.json").read_text(encoding="utf-8"))
    assert codex_vote["reviewer_family"] == "codex"
    assert codex_vote["model"] == "stub-model-for-test"
    assert codex_vote["vote"] == "a"
    assert codex_vote["commitment_hash"] == commitment["commitment_hash"]
    assert codex_vote["unanchored_arguments_discarded"] == 1
    assert "extra_comment" not in codex_vote

    report = json.loads((out_dir / "panel_run_report.json").read_text(encoding="utf-8"))
    assert report["panel_valid"] is True
    assert report["absent"] == []

    campaign = tmp_path / "campaign"
    campaign.mkdir()
    artifact_path, artifact, tier, _ = assemble_match.assemble(
        materials / "commitment.json",
        out_dir / "votes",
        campaign,
        CAMPAIGN_ID,
        IDEA_A,
        IDEA_B,
        materials_dir=materials,
    )
    assert not assemble_match.validate_pairwise_match(artifact)
    assert artifact["outcome"]["winner"] == "a"
    assert artifact["outcome"]["vote_margin"] == pytest.approx(0.25)
    assert tier == 3


def test_injected_claude_vote(tmp_path, stub):
    materials, commitment = build_materials(tmp_path)
    injected = tmp_path / "claude_reply.txt"
    injected.write_text(
        'Prose before.\n```json\n{"vote": "a", "anchored_arguments": [], '
        '"unanchored_arguments_discarded": 0}\n```\n',
        encoding="utf-8",
    )
    out_dir = tmp_path / "panel"
    result = run_panel_cli(
        materials,
        out_dir,
        [
            "--claude-vote", str(injected),
            "--runner", "codex=" + runner_arg(stub, "a"),
            "--runner", "opencode=" + runner_arg(stub, "b"),
            "--runner", "kimi=" + runner_arg(stub, "a"),
        ],
    )
    assert result.returncode == 0, result.stderr
    claude_vote = json.loads((out_dir / "votes" / "claude.json").read_text(encoding="utf-8"))
    assert claude_vote["model"] == "claude/host-subagent"
    assert claude_vote["collection"]["source"] == "injected"


def test_absent_family_degrades_to_three(tmp_path, stub):
    materials, _ = build_materials(tmp_path)
    out_dir = tmp_path / "panel"
    result = run_panel_cli(
        materials,
        out_dir,
        [
            "--runner", "claude=" + runner_arg(stub, "a"),
            "--runner", "codex=" + runner_arg(stub, "a"),
            "--runner", "opencode=" + runner_arg(stub, "b"),
            "--runner", "kimi=" + runner_arg(stub, "garbage"),
        ],
    )
    assert result.returncode == 0, result.stderr
    report = json.loads((out_dir / "panel_run_report.json").read_text(encoding="utf-8"))
    assert report["panel_valid"] is True
    assert [item["family"] for item in report["absent"]] == ["kimi"]
    assert "no JSON object" in report["absent"][0]["reason"]
    assert "family absent: kimi" in result.stdout


def test_panel_invalid_below_three_families(tmp_path, stub):
    materials, _ = build_materials(tmp_path)
    out_dir = tmp_path / "panel"
    result = run_panel_cli(
        materials,
        out_dir,
        [
            "--runner", "claude=" + runner_arg(stub, "a"),
            "--runner", "codex=" + runner_arg(stub, "garbage"),
            "--runner", "opencode=" + runner_arg(stub, "garbage"),
            "--runner", "kimi=" + runner_arg(stub, "tie"),
        ],
    )
    assert result.returncode == 2
    assert "match is terminated" in result.stderr
    report = json.loads((out_dir / "panel_run_report.json").read_text(encoding="utf-8"))
    assert report["panel_valid"] is False
    assert len(report["votes_collected"]) == 2
    assert len(report["absent"]) == 2


def test_retry_recovers_a_flaky_family(tmp_path, stub):
    materials, _ = build_materials(tmp_path)
    out_dir = tmp_path / "panel"
    marker = tmp_path / "flaky_marker"
    result = run_panel_cli(
        materials,
        out_dir,
        [
            "--runner", "claude=" + runner_arg(stub, "a"),
            "--runner", "codex=" + runner_arg(stub, "flaky:%s" % marker),
            "--runner", "opencode=" + runner_arg(stub, "b"),
            "--runner", "kimi=" + runner_arg(stub, "a"),
        ],
    )
    assert result.returncode == 0, result.stderr
    codex_vote = json.loads((out_dir / "votes" / "codex.json").read_text(encoding="utf-8"))
    attempts = codex_vote["collection"]["attempts"]
    assert len(attempts) == 2
    assert "failure" in attempts[0]
    assert attempts[1].get("ok") is True
    assert marker.exists()


def test_render_prompt_only(tmp_path):
    materials, commitment = build_materials(tmp_path)
    out_dir = tmp_path / "panel"
    result = run_panel_cli(materials, out_dir, ["--render-prompt-only"])
    assert result.returncode == 0, result.stderr
    prompt = (out_dir / "judge_prompt.md").read_text(encoding="utf-8")
    assert commitment["commitment_hash"] in prompt
    assert "Advocacy statement for Idea A" in prompt
    assert "standing tension directly" in prompt
    assert "{{" not in prompt
    assert (out_dir / "judge_system.md").is_file()
    assert not (out_dir / "votes").exists()


def test_materials_violation_blocks_before_any_runner(tmp_path, stub):
    materials, commitment = build_materials(tmp_path)
    statement_b = materials / "statement_b.md"
    text = statement_b.read_text(encoding="utf-8")
    statement_b.write_text(
        text.replace(commitment["commitment_hash"], "sha256:" + "0" * 64),
        encoding="utf-8",
    )
    sentinels = {
        family: tmp_path / ("invoked_%s" % family)
        for family in ("claude", "codex", "opencode", "kimi")
    }
    out_dir = tmp_path / "panel"
    result = run_panel_cli(
        materials,
        out_dir,
        [
            "--runner", "claude=" + runner_arg(stub, "flaky:%s" % sentinels["claude"]),
            "--runner", "codex=" + runner_arg(stub, "flaky:%s" % sentinels["codex"]),
            "--runner", "opencode=" + runner_arg(stub, "flaky:%s" % sentinels["opencode"]),
            "--runner", "kimi=" + runner_arg(stub, "flaky:%s" % sentinels["kimi"]),
        ],
    )
    assert result.returncode == 1
    assert "mismatched materials" in result.stderr
    for family, sentinel in sentinels.items():
        assert not sentinel.exists(), "runner for %s ran despite the violation" % family


def test_statement_without_hash_line_is_rejected(tmp_path):
    materials, _ = build_materials(tmp_path)
    (materials / "statement_a.md").write_text("Just prose.\n", encoding="utf-8")
    result = run_panel_cli(materials, tmp_path / "panel", ["--render-prompt-only"])
    assert result.returncode == 1
    assert "does not open with" in result.stderr


def test_unknown_family_is_rejected(tmp_path):
    materials, _ = build_materials(tmp_path)
    result = run_panel_cli(
        materials, tmp_path / "panel", ["--families", "claude,foo"]
    )
    assert result.returncode == 1
    assert "unknown family" in result.stderr


def test_render_card_summaries_and_statement_prompts(tmp_path):
    materials = tmp_path / "materials"
    materials.mkdir()

    # Rendering modes refuse to run before the commitment exists.
    early = run_panel_cli(
        materials,
        tmp_path / "unused",
        [
            "--render-statement-prompts",
            "--card-a", str(CARD_A),
            "--card-b", str(CARD_B),
        ],
    )
    assert early.returncode == 1
    assert "commit_criteria.py first" in early.stderr

    commitment = commit_criteria.build_commitment(["mechanism insight"])
    commit_criteria.write_json_atomic(materials / "commitment.json", commitment)

    result = run_panel_cli(
        materials,
        tmp_path / "unused",
        [
            "--render-card-summaries",
            "--render-statement-prompts",
            "--card-a", str(CARD_A),
            "--card-b", str(CARD_B),
            "--word-cap", "500",
        ],
    )
    assert result.returncode == 0, result.stderr
    summary_a = (materials / "card_summary_a.md").read_text(encoding="utf-8")
    assert "Adaptive basis enrichment" in summary_a
    assert IDEA_A in summary_a
    request_a = (materials / "statement_request_a.md").read_text(encoding="utf-8")
    assert commitment["commitment_hash"] in request_a
    assert IDEA_A in request_a
    assert "at most 500 words" in request_a
    request_b = (materials / "statement_request_b.md").read_text(encoding="utf-8")
    assert IDEA_B in request_b
    assert "{{" not in request_a and "{{" not in request_b
