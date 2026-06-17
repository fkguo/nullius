#!/usr/bin/env python3
"""
Offline unit tests for derivation-verify Executor 2 (run_multi_backend.py).

These exercise the PURE gate logic + orchestration with an injected MOCK runner — NO real CLI
backends are spawned, so the suite is fast, deterministic, and CI-safe. The contract the tests
lock: cross-family convergence (R1), adjudicator veto (R2), diversity-first tie-break (R3), robust
JSON extraction from noisy CLI text, and "never crash the matrix on a dead backend".
"""
from __future__ import annotations

import importlib.util
import json
from pathlib import Path

_MOD_PATH = Path(__file__).resolve().parents[1] / "scripts" / "run_multi_backend.py"
_spec = importlib.util.spec_from_file_location("run_multi_backend", _MOD_PATH)
mb = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(mb)


# ---------------------------------------------------------------- family_of
def test_family_of():
    assert mb.family_of("claude/default") == "claude"
    assert mb.family_of("codex/gpt-5.3") == "codex"
    assert mb.family_of("gemini/default") == "gemini"
    assert mb.family_of("default") == "opencode"
    assert mb.family_of("") == "opencode"
    assert mb.family_of("minimax/MiniMax-M2.5") == "opencode"


# ---------------------------------------------------------------- extract_json
def test_extract_json_fenced():
    assert mb.extract_json('```json\n{"a": 1}\n```') == {"a": 1}


def test_extract_json_raw():
    assert mb.extract_json('{"a": 2}') == {"a": 2}


def test_extract_json_embedded_in_prose():
    txt = 'Here is my answer.\n{"canonical_answer": "42"}\nThanks!'
    assert mb.extract_json(txt) == {"canonical_answer": "42"}


def test_extract_json_gemini_noise_prefix():
    txt = 'Hook registry initialized with 3 hook entries\n```json\n{"canonical_answer": "3*x^2"}\n```'
    assert mb.extract_json(txt) == {"canonical_answer": "3*x^2"}


def test_extract_json_none_on_garbage():
    assert mb.extract_json("no json here") is None
    assert mb.extract_json("") is None
    assert mb.extract_json(None) is None


def test_extract_json_last_balanced_wins():
    # two objects in prose: the LAST balanced one is returned
    assert mb.extract_json('{"a": 1} then {"canonical_answer": "x"}') == {"canonical_answer": "x"}


# ---------------------------------------------------------------- parse_derivation
def test_parse_derivation_valid():
    d = mb.parse_derivation('```json\n{"canonical_answer":"42","derivation_summary":"17+25","confidence":"high"}\n```')
    assert d == {"canonical_answer": "42", "derivation_summary": "17+25", "confidence": "high"}


def test_parse_derivation_bad_confidence_coerced():
    d = mb.parse_derivation('{"canonical_answer":"42","derivation_summary":"s","confidence":"certain"}')
    assert d["confidence"] == "low"


def test_parse_derivation_missing_answer_is_none():
    assert mb.parse_derivation('{"derivation_summary":"s","confidence":"high"}') is None
    assert mb.parse_derivation('{"canonical_answer":"   ","confidence":"high"}') is None
    assert mb.parse_derivation("not json") is None


# ---------------------------------------------------------------- parse_comparison
def _cmp_json(**kw):
    base = {
        "majority_answer": "42", "majority_size": 2, "majority_indices": [0, 1],
        "all_equivalent": True, "outliers": "none",
        "correct_answer_adjudicated": "42 because 17+25=42", "adjudicated_matches_majority": True,
    }
    base.update(kw)
    return json.dumps(base)


def test_parse_comparison_valid():
    c = mb.parse_comparison(_cmp_json(), 2)
    assert c["majority_size"] == 2 and c["majority_indices"] == [0, 1]
    assert c["adjudicated_matches_majority"] is True


def test_parse_comparison_filters_out_of_range_indices():
    c = mb.parse_comparison(_cmp_json(majority_indices=[0, 1, 5, -1]), 2)
    assert c["majority_indices"] == [0, 1]  # 5 and -1 dropped (n_derivations=2)


def test_parse_comparison_missing_size_is_none():
    assert mb.parse_comparison('{"majority_answer":"42"}', 2) is None
    assert mb.parse_comparison("garbage", 2) is None


def test_parse_comparison_missing_veto_defaults_false():
    raw = json.dumps({"majority_answer": "42", "majority_size": 2, "majority_indices": [0, 1]})
    c = mb.parse_comparison(raw, 2)
    assert c["adjudicated_matches_majority"] is False


# ---------------------------------------------------------------- cross_family / decide_converged
def test_cross_family_confirmations():
    cmp = {"majority_indices": [0, 1, 2]}
    assert mb.cross_family_confirmations(cmp, ["claude", "codex", "claude"]) == 2  # claude,codex
    assert mb.cross_family_confirmations(cmp, ["claude", "claude", "claude"]) == 1


def test_decide_converged_needs_two_families_and_veto():
    fams = ["claude", "codex"]
    ok = {"majority_indices": [0, 1], "adjudicated_matches_majority": True}
    assert mb.decide_converged(ok, fams) is True
    # R2: veto false blocks even with 2 families
    veto = {"majority_indices": [0, 1], "adjudicated_matches_majority": False}
    assert mb.decide_converged(veto, fams) is False
    # R1: same family twice is NOT cross-family
    same = {"majority_indices": [0, 1], "adjudicated_matches_majority": True}
    assert mb.decide_converged(same, ["claude", "claude"]) is False
    # single confirmation
    one = {"majority_indices": [0], "adjudicated_matches_majority": True}
    assert mb.decide_converged(one, fams) is False


# ---------------------------------------------------------------- pick_next_spec (R3)
def test_pick_next_spec_prefers_unused_family():
    pool = ["claude/default", "codex/default", "gemini/default"]
    assert mb.pick_next_spec(pool, ["claude/default"]) == "codex/default"
    assert mb.pick_next_spec(pool, ["claude/default", "codex/default"]) == "gemini/default"


def test_pick_next_spec_falls_back_to_least_used():
    pool = ["claude/default", "codex/default"]
    # both families used once -> least-used (tie) -> first
    nxt = mb.pick_next_spec(pool, ["claude/default", "codex/default"])
    assert nxt in pool
    # claude used twice, codex once -> codex
    assert mb.pick_next_spec(pool, ["claude/default", "claude/default", "codex/default"]) == "codex/default"


def test_pick_next_spec_empty_pool_none():
    assert mb.pick_next_spec([], ["claude/default"]) is None


# ---------------------------------------------------------------- verify_claim orchestration (mock runner)
POOL = ["claude/default", "codex/default", "gemini/default"]
CLAIM = {"id": "T1", "statement": "Compute 17+25.", "report_format": "an integer", "method0": "add", "method1": "regroup"}


def _mk_run(compare_scripts, derive_answer="42"):
    """Build a mock RunFn. compare_scripts: list of dicts returned by successive comparator calls."""
    state = {"compare_calls": 0}

    def run(spec, system, prompt, tag):
        if "compare" in tag:
            i = state["compare_calls"]
            state["compare_calls"] += 1
            payload = compare_scripts[min(i, len(compare_scripts) - 1)]
            return "```json\n" + json.dumps(payload) + "\n```"
        # a deriver
        return json.dumps({"canonical_answer": derive_answer, "derivation_summary": "did it", "confidence": "high"})

    return run


def test_verify_claim_clean_first_pass():
    run = _mk_run([{
        "majority_answer": "42", "majority_size": 2, "majority_indices": [0, 1], "all_equivalent": True,
        "outliers": "none", "correct_answer_adjudicated": "42", "adjudicated_matches_majority": True,
    }])
    row = mb.verify_claim(CLAIM, ctx="ctx", pool=POOL, comparator="codex/default", max_iter=3, run=run)
    assert row["converged"] is True
    assert row["iterate_rounds"] == 0
    assert row["cross_family_confirmations"] == 2
    assert set(row["families"]) == {"claude", "codex"}  # first two distinct families seeded


def test_verify_claim_veto_blocks_convergence():
    # derivers agree, but the adjudicator's recompute does NOT match -> never converges (R2)
    veto_cmp = {
        "majority_answer": "42", "majority_size": 2, "majority_indices": [0, 1], "all_equivalent": True,
        "outliers": "none", "correct_answer_adjudicated": "41 (adjudicator disagrees)",
        "adjudicated_matches_majority": False,
    }
    run = _mk_run([veto_cmp])
    row = mb.verify_claim(CLAIM, ctx="ctx", pool=POOL, comparator="codex/default", max_iter=2, run=run)
    assert row["converged"] is False
    assert row["iterate_rounds"] == 2  # exhausted tie-break budget


def test_verify_claim_disagree_then_converge():
    disagree = {
        "majority_answer": "42", "majority_size": 1, "majority_indices": [0], "all_equivalent": False,
        "outliers": "#1 wrong", "correct_answer_adjudicated": "42", "adjudicated_matches_majority": False,
    }
    converge = {
        "majority_answer": "42", "majority_size": 2, "majority_indices": [1, 2], "all_equivalent": False,
        "outliers": "#0 wrong", "correct_answer_adjudicated": "42", "adjudicated_matches_majority": True,
    }
    run = _mk_run([disagree, converge])
    row = mb.verify_claim(CLAIM, ctx="ctx", pool=POOL, comparator="codex/default", max_iter=3, run=run)
    assert row["converged"] is True
    assert row["iterate_rounds"] == 1
    assert row["total_derivations"] == 3  # 2 seed + 1 tie-break


def test_verify_claim_dead_comparator_degrades_not_crash():
    def run(spec, system, prompt, tag):
        if "compare" in tag:
            return None  # comparator backend died
        return json.dumps({"canonical_answer": "42", "derivation_summary": "s", "confidence": "high"})

    row = mb.verify_claim(CLAIM, ctx="ctx", pool=POOL, comparator="codex/default", max_iter=1, run=run)
    assert row["converged"] is False
    assert row["agreed_answer"] == "(comparator unavailable)"


def test_verify_claim_failed_derivers_filtered():
    # both seed derivers fail to parse; comparator (no derivations) -> SAFE_CMP -> unconverged, no crash
    def run(spec, system, prompt, tag):
        if "compare" in tag:
            return None
        return "garbage, not json"

    row = mb.verify_claim(CLAIM, ctx="ctx", pool=POOL, comparator="codex/default", max_iter=1, run=run)
    assert row["converged"] is False
    assert row["total_derivations"] == 0


# ---------------------------------------------------------------- run_gate (full input -> summary)
def test_run_gate_summary_schema_and_skips():
    spec = {
        "context": "trivial",
        "max_iter": 2,
        "claims": [
            CLAIM,
            {"id": "", "statement": "missing id"},          # skipped (no id)
            {"id": "T3"},                                    # skipped (no statement)
        ],
    }
    run = _mk_run([{
        "majority_answer": "42", "majority_size": 2, "majority_indices": [0, 1], "all_equivalent": True,
        "outliers": "none", "correct_answer_adjudicated": "42", "adjudicated_matches_majority": True,
    }])
    out = mb.run_gate(spec, pool=POOL, comparator="codex/default", run=run)
    assert set(out) == {"total_claims", "converged", "unconverged", "clean_first_pass",
                        "needed_iteration", "dropped_claims", "matrix"}
    assert out["total_claims"] == 1   # 2 malformed claims skipped
    assert out["dropped_claims"] == 2
    assert out["converged"] == 1
    assert out["clean_first_pass"] == 1


def test_run_gate_max_iter_override_zero_disables_iteration():
    # max_iter 0 => no tie-break even if first compare disagrees
    disagree = {
        "majority_answer": "42", "majority_size": 1, "majority_indices": [0], "all_equivalent": False,
        "outliers": "x", "correct_answer_adjudicated": "42", "adjudicated_matches_majority": False,
    }
    run = _mk_run([disagree])
    out = mb.run_gate({"context": "", "claims": [CLAIM]}, pool=POOL, comparator="codex/default",
                      run=run, max_iter_override=0)
    assert out["matrix"][0]["iterate_rounds"] == 0
    assert out["converged"] == 0
