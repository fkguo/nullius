"""Shared test wiring: scripts importable + candidate fixtures via pytest injection.

Deliberately no importable names here (`from conftest import ...` collides in
sys.modules when several skills' suites run in one pytest invocation); shared
builders are exposed as pytest FIXTURES instead.
"""

from __future__ import annotations

import copy
import sys
from pathlib import Path

import pytest

SKILL_ROOT = Path(__file__).resolve().parents[1]
_SCRIPTS_DIR = SKILL_ROOT / "scripts"
if str(_SCRIPTS_DIR) not in sys.path:
    sys.path.insert(0, str(_SCRIPTS_DIR))

_URI_A = "https://example.com/paper-a"
_URI_B = "https://example.com/paper-b"

# Prompt provenance is mandatory at import: fixture candidates hash this fixed
# rendered-prompt text, and tests write it to a file for --prompt-snapshot.
import hashlib as _hashlib

PROMPT_SNAPSHOT_TEXT = "rendered generation prompt for the fixture tension burst"
PROMPT_SNAPSHOT_HASH = "sha256:" + _hashlib.sha256(PROMPT_SNAPSHOT_TEXT.encode("utf-8")).hexdigest()

_TENSION_CANDIDATE = {
    "card_fields": {
        "claims": [
            {
                "claim_text": "source A and source B disagree on the magnitude of effect X",
                "evidence_uris": [_URI_A, _URI_B],
                "support_type": "literature",
            },
            {
                "claim_text": "the proposed mechanism would separate the two accounts",
                "evidence_uris": [],
                "support_type": "llm_inference",
                "verification_plan": "run the bounded first check and compare against both sources",
            },
        ],
        "minimal_compute_plan": [
            {
                "estimated_difficulty": "moderate",
                "method": "toy estimate",
                "step": "bounded first check separating the two accounts",
            },
        ],
        "required_observables": ["discriminating-observable-1"],
        "testable_hypotheses": ["under condition Z the two accounts predict opposite signs"],
    },
    "novelty_delta": {
        "closest_prior": _URI_A,
        "delta_type": "new_mechanism",
        "falsifiable_delta_statement": (
            "unlike the closest prior, predicts a sign flip under condition Z; absence of the flip kills the idea"
        ),
        "overlap_summary": "both study effect X in the same regime",
    },
    "provenance": {
        "evidence_uris_used": [_URI_A, _URI_B],
        "operator_family": "LiteratureMining",
        "operator_id": "litmine.tension_resolution.v1",
        "origin": {
            "model": "test-generator-model",
            "prompt_hash": PROMPT_SNAPSHOT_HASH,
            "role": "Generator",
            "temperature": 0.7,
            "timestamp": "2026-07-06T00:00:00Z",
        },
        "parent_node_ids": [],
        "trace_inputs": {
            "anchor": {
                "kind": "tension",
                "ref_keys": ["refA", "refB"],
                "statement": "A and B disagree on the magnitude of effect X",
            },
            "retrieval_receipts": [
                {"source": "literature_survey_v1#papers/refA", "uri": _URI_A},
                {"source": "literature_survey_v1#papers/refB", "uri": _URI_B},
            ],
        },
        "trace_params": {"operator_contract": "litmine.v1"},
    },
    "rationale_draft": {
        "kill_criteria": ["the discriminating observable shows no difference between accounts"],
        "rationale": (
            "The two accounts of effect X disagree; a mechanism with a bounded discriminating check "
            "would resolve the tension."
        ),
        "risks": ["the bounded check may not separate the two accounts"],
        "title": "Resolve the anchored X tension",
    },
    "target_admission_route": "open_problem",
}


@pytest.fixture()
def make_candidate():
    """Deep-copied valid LiteratureMining tension candidate (pre-dedup)."""
    def _make(**top_level_overrides):
        candidate = copy.deepcopy(_TENSION_CANDIDATE)
        candidate.update(top_level_overrides)
        return candidate
    return _make


@pytest.fixture()
def prompt_snapshot():
    """(text, sha256 hash) of the fixture rendered prompt; matches the fixture
    candidates' origin.prompt_hash so mandatory prompt provenance validates."""
    return PROMPT_SNAPSHOT_TEXT, PROMPT_SNAPSHOT_HASH


@pytest.fixture()
def engine_contract_dir():
    """Engine contract directory; skips when the skill runs standalone."""
    contract_dir = SKILL_ROOT.parents[1] / "packages" / "idea-engine" / "contracts" / "idea-runtime-contracts" / "schemas"
    if not contract_dir.is_dir():
        pytest.skip("engine contract tree not present (standalone install)")
    return contract_dir


@pytest.fixture()
def engine_src_dir():
    """Engine TS source directory; skips when the skill runs standalone."""
    src_dir = SKILL_ROOT.parents[1] / "packages" / "idea-engine" / "src"
    if not src_dir.is_dir():
        pytest.skip("engine source tree not present (standalone install)")
    return src_dir
