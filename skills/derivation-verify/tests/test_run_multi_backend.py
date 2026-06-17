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


def test_extract_json_prefer_keys_selects_keyed_object():
    # prefer_keys picks the object carrying the required key, regardless of position (B1 fix):
    # leading stray dict must not shadow the real verdict...
    assert mb.extract_json('{"a": 1} then {"canonical_answer": "x"}',
                           prefer_keys={"canonical_answer"}) == {"canonical_answer": "x"}
    # ...and a fenced verdict must win over TRAILING prose containing a stray brace.
    txt = '```json\n{"canonical_answer": "3*x^2"}\n```\nFor reference I also got {"sanity": 999}.'
    assert mb.extract_json(txt, prefer_keys={"canonical_answer"}) == {"canonical_answer": "3*x^2"}


# ---------------------------------------------------------------- parse_derivation
def test_parse_derivation_valid():
    d = mb.parse_derivation('```json\n{"canonical_answer":"42","derivation_summary":"17+25","confidence":"high","checkable_form":"42"}\n```')
    assert d == {"canonical_answer": "42", "derivation_summary": "17+25", "confidence": "high", "checkable_form": "42"}


def test_parse_derivation_checkable_form_optional():
    d = mb.parse_derivation('{"canonical_answer":"x","derivation_summary":"s","confidence":"high"}')
    assert d["checkable_form"] == ""  # absent -> "" (CAS abstains, gate uses LLM path)


def test_parse_derivation_bad_confidence_coerced():
    d = mb.parse_derivation('{"canonical_answer":"42","derivation_summary":"s","confidence":"certain"}')
    assert d["confidence"] == "low"


def test_parse_derivation_missing_answer_is_none():
    assert mb.parse_derivation('{"derivation_summary":"s","confidence":"high"}') is None
    assert mb.parse_derivation('{"canonical_answer":"   ","confidence":"high"}') is None
    assert mb.parse_derivation("not json") is None


def test_parse_derivation_survives_trailing_brace_prose():
    # B1 regression: clean fenced verdict FOLLOWED by prose containing a stray {...} must still parse
    # to the verdict (a naive last-balanced-wins scan returned the trailing junk -> silent drop).
    txt = ('```json\n{"canonical_answer":"42","derivation_summary":"17+25","confidence":"high"}\n```\n'
           'I also double-checked and computed {"check": "ok", "n": 999}.')
    d = mb.parse_derivation(txt)
    assert d is not None and d["canonical_answer"] == "42"


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


def test_verify_claim_independent_confirmations_from_indices_not_inflated():
    # N2: a comparator inflating majority_size must NOT inflate the reported confirmation count;
    # the audited number is the size of the enumerated agreeing cluster (majority_indices).
    inflated = {
        "majority_answer": "42", "majority_size": 99, "majority_indices": [0, 1], "all_equivalent": True,
        "outliers": "none", "correct_answer_adjudicated": "42", "adjudicated_matches_majority": True,
    }
    run = _mk_run([inflated])
    row = mb.verify_claim(CLAIM, ctx="ctx", pool=POOL, comparator="codex/default", max_iter=1, run=run)
    assert row["independent_confirmations"] == 2  # len(majority_indices), not 99
    assert row["converged"] is True


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


# ---------------------------------------------------------------- deterministic equivalence (CAS)
import pytest

sympy = pytest.importorskip("sympy")  # CAS path tests need sympy; skip cleanly if absent


def test_equivalent_forms_decides_true():
    assert mb.equivalent_forms("3*x**2", "x*x*3") is True
    assert mb.equivalent_forms("-pi/(4*mu)", "-(1/4)*pi/mu") is True
    assert mb.equivalent_forms("sqrt(2)/2", "1/sqrt(2)") is True
    assert mb.equivalent_forms("2/3", "4/6") is True


def test_equivalent_forms_decides_false():
    assert mb.equivalent_forms("42", "43") is False
    assert mb.equivalent_forms("3*x**2", "2*x**2") is False
    assert mb.equivalent_forms("-pi/(4*mu)", "pi/(4*mu)") is False


def test_equivalent_forms_abstains_on_non_algebraic():
    # undefined functions / asymptotic notation / non-expressions / prose / mismatched symbols -> None.
    # A wrong CAS verdict here would be worse than abstaining, so abstention is the contract.
    for a, b in [("Theta(n*log(n))", "Theta(n*log(n))"), ("O(n**2)", "O(n**2)"),
                 ("arctan(x)", "arctan(x)"), ("[1,2]", "[1,2]"), ("x>0", "x>0"),
                 ("the limit is 1", "the limit is 1"), ("", ""), ("x**2", "y**2")]:
        assert mb.equivalent_forms(a, b) is None


def test_equivalent_forms_no_periodic_false_positive():
    # sin(pi*x) is 0 at every INTEGER but is NOT identically 0; a naive integer-sample numeric test
    # would wrongly return True. sympy .equals samples generic points -> must NOT say equal.
    assert mb.equivalent_forms("sin(pi*x)", "0") in (False, None)
    assert mb.equivalent_forms("sin(pi*x)", "0") is not True


def test_strict_expr_blocks_code_execution(tmp_path):
    # SECURITY: checkable_form is untrusted cross-model output; parse_expr eval()s it. The restricted
    # namespace + denylist must reject gadgets AND fire no side effect.
    sentinel = tmp_path / "pwned.txt"
    payloads = [
        f"__import__('os').system('touch {sentinel}')",
        f"exec(\"open(r'{sentinel}','w').write('x')\")",
        f"open(r'{sentinel}','w')",
        "(1).__class__.__mro__[-1].__subclasses__()",
    ]
    for p in payloads:
        assert mb._strict_expr(p) is None
        assert mb.equivalent_forms(p, "0") is None
    assert not sentinel.exists()  # no payload executed


def test_strict_expr_blocks_sympify_reentry(tmp_path, capsys, monkeypatch):
    # SECURITY (re-entry): the builtins-stripped namespace does NOT cover S("...")/sympify("...")/
    # parse_expr("..."), which RE-PARSE the inner string with sympy's own default (builtins-exposed)
    # globals. The denylist only catches inner tokens it happens to name (__, open, exec, ...); arbitrary
    # OTHER builtins still execute through that re-entry — a DoS surface (breakpoint/help) and a
    # denylist-completeness-dependent RCE surface. The quote rule closes the whole class structurally:
    # no quote char -> no string literal -> no re-entry. `print`/`breakpoint` are NOT on the denylist, so
    # these payloads are stopped ONLY by the quote rule (they'd execute under a namespace-only fix).
    fired = []
    monkeypatch.setattr("sys.breakpointhook", lambda *a, **k: fired.append("bp"))
    sentinel = tmp_path / "reentry.txt"
    payloads = [
        'S("print(chr(120))")',                       # side-effecting builtin absent from the denylist
        'sympify("print(chr(121))")',
        'parse_expr("print(chr(122))")',
        'S("breakpoint()")',                          # DoS: would drop into pdb under the default hook
        f'S("open(\'{sentinel}\',\'w\').write(\'x\')")',  # file write via re-entry
    ]
    for p in payloads:
        assert mb._strict_expr(p) is None
        assert mb.equivalent_forms(p, "0") is None
    assert capsys.readouterr().out == ""          # no print re-entry executed (channel truly closed)
    assert fired == []                            # no breakpoint re-entry executed
    assert not sentinel.exists()                  # no file written


def test_strict_expr_blocks_side_effecting_sympy_calls(capsys, monkeypatch):
    # SECURITY (side-effect class, distinct from string re-entry): sympy's own plotting/printing/
    # interactive/utilities callables (plot/preview/pprint/print_latex/lambdify) have no quotes/dunders
    # and aren't all denylisted, yet parse_expr(evaluate=True) would CALL them — rendering, shelling out
    # to latex (preview), or polluting stdout. The math-only namespace (side-effecting modules dropped)
    # makes them auto-symbolize -> AppliedUndef -> rejected, NEVER executed.
    import subprocess
    spawned = []

    def _spy(*a, **k):
        spawned.append(a[0] if a else k.get("args"))
        raise OSError("blocked-in-test")

    monkeypatch.setattr(subprocess, "Popen", _spy)
    for p in ["plot(x)", "pprint(x*2)", "print_latex(x)", "preview(x)", "init_printing()", "lambdify(x, x)"]:
        assert mb._strict_expr(p) is None
    assert capsys.readouterr().out == ""   # nothing rendered/printed
    assert spawned == []                   # no latex/viewer subprocess spawned


def test_equivalent_forms_abstains_on_integral_constant():
    # Indefinite integrals differ by +C; must ABSTAIN (-> LLM path), not falsely refute.
    assert mb.equivalent_forms("Integral(2*x, x)", "x**2 + 5") is None
    assert mb.equivalent_forms("Integral(x, x)", "x**2/2") is None


def test_verified_cross_family():
    # two families, CAS-equal forms -> xfam 2, decidable
    xfam, decidable = mb.verified_cross_family(["3*x**2", "x*x*3"], ["claude", "codex"])
    assert xfam == 2 and decidable is True
    # CAS-unequal -> each its own class -> xfam 1, still decidable
    xfam, decidable = mb.verified_cross_family(["42", "43"], ["claude", "codex"])
    assert xfam == 1 and decidable is True
    # non-checkable -> abstain entirely
    xfam, decidable = mb.verified_cross_family(["Theta(n)", "Theta(n)"], ["claude", "codex"])
    assert decidable is False


def _drv(ans, form, fam_summary="s"):
    return {"canonical_answer": ans, "derivation_summary": fam_summary, "confidence": "high", "checkable_form": form}


def test_claim_status_cas_path_is_llm_independent():
    # CAS converges on >=2 cross-family equal forms EVEN IF the comparator says nothing (de-anchored).
    derivations = [_drv("42", "42"), _drv("42", "6*7")]
    conv, verification, xfam = mb.claim_status(dict(mb.SAFE_CMP), derivations, ["claude", "codex"])
    assert conv is True and verification == "cas" and xfam == 2


def test_claim_status_cas_overrides_wrong_llm_consensus():
    # Derivers disagree by CAS (42 vs 43) but a hallucinating comparator clusters them as agreeing.
    # The consensus-trap guard: CAS is authoritative -> NOT converged.
    derivations = [_drv("42", "42"), _drv("43", "43")]
    lying_cmp = {**mb.SAFE_CMP, "majority_answer": "42", "majority_size": 2,
                 "majority_indices": [0, 1], "adjudicated_matches_majority": True}
    conv, verification, xfam = mb.claim_status(lying_cmp, derivations, ["claude", "codex"])
    assert conv is False and verification == "cas" and xfam == 1


def test_claim_status_falls_back_to_llm_when_not_checkable():
    derivations = [_drv("Θ(n log n)", ""), _drv("Θ(n log n)", "")]
    good_cmp = {**mb.SAFE_CMP, "majority_size": 2, "majority_indices": [0, 1],
                "adjudicated_matches_majority": True}
    conv, verification, xfam = mb.claim_status(good_cmp, derivations, ["claude", "codex"])
    assert verification == "llm" and conv is True  # R1+R2 on the LLM path


def test_verify_claim_cas_path_end_to_end():
    # derivers emit checkable_form -> gate converges via CAS independent of the comparator.
    def run(spec, system, prompt, tag):
        if "compare" in tag:
            return json.dumps(dict(mb.SAFE_CMP))  # comparator contributes nothing
        return json.dumps({"canonical_answer": "42", "derivation_summary": "17+25",
                           "confidence": "high", "checkable_form": "42"})
    row = mb.verify_claim(CLAIM, ctx="ctx", pool=POOL, comparator="codex/default", max_iter=1, run=run)
    assert row["converged"] is True and row["verification"] == "cas"
    assert row["cross_family_confirmations"] == 2


# ---------------------------------------------------------------- runner resolution (review-swarm dep)
def test_resolve_runner_order(tmp_path, monkeypatch):
    explicit = tmp_path / "explicit.py"
    envp = tmp_path / "env.py"
    explicit.write_text("# x")
    envp.write_text("# x")
    # explicit --runner wins
    monkeypatch.setenv("DERIVATION_VERIFY_RUNNER", str(envp))
    assert mb._resolve_runner(explicit) == explicit
    # else env var
    assert mb._resolve_runner(None) == envp
    # missing explicit + missing env -> None (no sibling in tmp); never crashes
    monkeypatch.delenv("DERIVATION_VERIFY_RUNNER", raising=False)
    assert mb._resolve_runner(tmp_path / "nope.py") in (None, mb._DEFAULT_RUNNER if mb._DEFAULT_RUNNER.exists() else None)


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
                        "needed_iteration", "dropped_claims", "family_pool", "matrix"}
    assert out["total_claims"] == 1   # 2 malformed claims skipped
    assert out["dropped_claims"] == 2
    assert out["converged"] == 1
    assert out["clean_first_pass"] == 1
    assert out["family_pool"] == ["claude", "codex", "gemini"]  # N4: pool families surfaced


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
