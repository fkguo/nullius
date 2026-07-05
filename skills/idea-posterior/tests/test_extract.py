"""Tests for run_infer_and_extract.py parsing against checked-in fixtures."""

from __future__ import annotations

import json
import shutil

import pytest

import run_infer_and_extract as extract


@pytest.fixture()
def beliefs(fixtures_dir) -> dict:
    return json.loads((fixtures_dir / "beliefs_sample.json").read_text())


@pytest.fixture()
def ir(fixtures_dir) -> dict:
    return json.loads((fixtures_dir / "ir_sample.json").read_text())


def test_worth_belief_extracted_by_label(beliefs) -> None:
    value = extract.extract_worth_belief(beliefs, "worth")
    assert value == pytest.approx(0.8499370175790979)


def test_custom_worth_label(beliefs) -> None:
    value = extract.extract_worth_belief(beliefs, "tension_resolution")
    assert value == pytest.approx(0.9374212719738726)


def test_missing_worth_label_lists_available_labels(beliefs) -> None:
    for entry in beliefs["beliefs"]:
        if entry["label"] == "worth":
            entry["label"] = "renamed"
    with pytest.raises(ValueError) as excinfo:
        extract.extract_worth_belief(beliefs, "worth")
    message = str(excinfo.value)
    assert "ev_tension" in message and "renamed" in message


def test_out_of_range_belief_rejected(beliefs) -> None:
    for entry in beliefs["beliefs"]:
        if entry["label"] == "worth":
            entry["belief"] = 1.7
    with pytest.raises(ValueError, match="not in"):
        extract.extract_worth_belief(beliefs, "worth")


def test_observation_count_from_ir(ir) -> None:
    assert extract.count_observations(ir) == 2


def test_observation_count_ignores_non_observation_supports(ir) -> None:
    ir["knowledges"][2]["metadata"]["supported_by"][0]["pattern"] = "inference"
    assert extract.count_observations(ir) == 1


def test_extract_posterior_end_shape(tmp_path, fixtures_dir) -> None:
    gaia_dir = tmp_path / "pkg" / ".gaia"
    gaia_dir.mkdir(parents=True)
    shutil.copy(fixtures_dir / "beliefs_sample.json", gaia_dir / "beliefs.json")
    shutil.copy(fixtures_dir / "ir_sample.json", gaia_dir / "ir.json")

    posterior = extract.extract_posterior(tmp_path / "pkg", "worth")

    assert set(posterior) == {"value", "evidence_count", "gaia_package_ref"}
    assert posterior["value"] == pytest.approx(0.8499370175790979)
    assert posterior["evidence_count"] == 2
    ref = posterior["gaia_package_ref"]
    assert ref.startswith(str((tmp_path / "pkg").resolve()))
    assert ref.endswith(
        "#sha256:e314d88c63c80b8845d2c1347e0f20b77db5825076d847ecd1c143a925afc676"
    )


def test_extract_posterior_requires_artifacts(tmp_path) -> None:
    (tmp_path / "pkg").mkdir()
    with pytest.raises(FileNotFoundError, match="run the inference stages"):
        extract.extract_posterior(tmp_path / "pkg", "worth")


CLEAN_MODULE = '''
from gaia.engine.lang import claim, infer, observe, register_prior

worth = claim("The idea merits sustained verification effort.", title="worth")
sub = claim("A sub-criterion holds.", title="sub")
ev = observe("An anchored fact.", rationale="context. anchor: survey artifact")
infer(ev, hypothesis=sub, p_e_given_h=0.90, p_e_given_not_h=0.09,
      rationale="substantial grade. anchor: survey artifact")
register_prior(sub, value=0.7,
               justification="external estimate. anchor: cited source")
'''


def test_discipline_scan_passes_clean_module() -> None:
    assert extract.scan_discipline(CLEAN_MODULE) == ([], [])


def test_discipline_scan_flags_off_grade_pair() -> None:
    source = CLEAN_MODULE.replace("p_e_given_h=0.90", "p_e_given_h=0.85")
    violations, _ = extract.scan_discipline(source)
    assert any("off-grade pair" in v for v in violations)


def test_discipline_scan_flags_missing_anchor_note() -> None:
    source = CLEAN_MODULE.replace(
        'rationale="context. anchor: survey artifact"',
        'rationale="context with no note"',
    )
    violations, _ = extract.scan_discipline(source)
    assert any("does not end with an 'anchor:" in v for v in violations)


def test_discipline_scan_requires_anchor_on_the_last_line() -> None:
    # An anchor note followed by a further line is statically decidable as
    # non-trailing (same-line trailing words are indistinguishable from a
    # multi-word reference and stay a reviewer question).
    source = CLEAN_MODULE.replace(
        'rationale="context. anchor: survey artifact"',
        'rationale="anchor: survey artifact\\nplus a second line of prose"',
    )
    violations, _ = extract.scan_discipline(source)
    assert any("does not end with an 'anchor:" in v for v in violations)


def test_discipline_scan_flags_missing_justification_anchor() -> None:
    source = CLEAN_MODULE.replace(
        'justification="external estimate. anchor: cited source"',
        'justification="just a feeling"',
    )
    violations, _ = extract.scan_discipline(source)
    assert any(
        "register_prior" in v and "anchor" in v for v in violations
    )


def test_discipline_scan_rejects_non_literal_note() -> None:
    # The discipline requires literal notes; indirection is a violation,
    # not a pass-through.
    source = CLEAN_MODULE + "\nnote = 'anchor: x'\nobserve('More.', rationale=note)\n"
    violations, _ = extract.scan_discipline(source)
    assert any("not a literal string" in v for v in violations)


def test_discipline_scan_rejects_non_literal_probabilities() -> None:
    source = CLEAN_MODULE.replace(
        "p_e_given_h=0.90, p_e_given_not_h=0.09",
        "p_e_given_h=grade, p_e_given_not_h=0.09",
    )
    violations, _ = extract.scan_discipline(source)
    assert any("not literal numbers" in v for v in violations)


def test_discipline_scan_resolves_import_aliases() -> None:
    source = (
        "from gaia.engine.lang import claim, infer as i\n"
        "h = claim('H.', title='h')\n"
        "e = claim('E.', title='e')\n"
        "i(e, hypothesis=h, p_e_given_h=0.85, p_e_given_not_h=0.15,\n"
        "  rationale='off grade. anchor: x')\n"
    )
    violations, _ = extract.scan_discipline(source)
    assert any("off-grade pair" in v for v in violations)


def test_discipline_scan_resolves_module_aliases() -> None:
    source = (
        "import gaia.engine.lang as lang\n"
        "h = lang.claim('H.', title='h')\n"
        "lang.observe('Fact.', rationale='no note here')\n"
    )
    violations, _ = extract.scan_discipline(source)
    assert any("does not end with an 'anchor:" in v for v in violations)


STRONG_REACH = (
    "from gaia.engine.lang import claim, infer, observe\n"
    "worth = claim('Worth.', title='worth')\n"
    "downstream_reach = claim('Reach.', title='downstream_reach')\n"
    "ev = observe('Chains recorded.', rationale='ctx. anchor: idea card')\n"
    "infer(ev, hypothesis=downstream_reach, p_e_given_h=0.90,\n"
    "      p_e_given_not_h=0.03,\n"
    "      rationale='{clause}broad reach. anchor: idea card')\n"
)


def test_strong_reach_requires_domains_clause() -> None:
    violations, _ = extract.scan_discipline(STRONG_REACH.format(clause=""))
    assert any("domains:" in v for v in violations)


def test_strong_reach_with_three_domains_passes() -> None:
    source = STRONG_REACH.format(
        clause="domains: first domain; second domain; third domain. "
    )
    violations, _ = extract.scan_discipline(source)
    assert violations == []


def test_strong_reach_with_two_domains_is_rejected() -> None:
    source = STRONG_REACH.format(clause="domains: first domain; second domain. ")
    violations, _ = extract.scan_discipline(source)
    assert any("domains:" in v for v in violations)


def test_domains_clause_does_not_count_the_anchor_as_a_domain() -> None:
    # "domains: one; two; anchor: ref" is two domains, not three.
    assert not extract.has_domains_clause(
        "domains: first domain; second domain; anchor: idea card"
    )
    assert extract.has_domains_clause(
        "domains: first domain; second domain; third domain. anchor: idea card"
    )


def test_scan_rejects_assignment_aliases() -> None:
    source = (
        "from gaia.engine.lang import claim, infer\n"
        "h = claim('H.', title='h')\n"
        "e = claim('E.', title='e')\n"
        "i = infer\n"
        "i(e, hypothesis=h, p_e_given_h=0.85, p_e_given_not_h=0.15,\n"
        "  rationale='off grade. anchor: x')\n"
    )
    violations, _ = extract.scan_discipline(source)
    assert any("without being called" in v for v in violations)


def test_scan_rejects_passing_statements_as_values() -> None:
    source = (
        "from gaia.engine.lang import observe\n"
        "helpers = {'obs': observe}\n"
    )
    violations, _ = extract.scan_discipline(source)
    assert any("without being called" in v for v in violations)


def test_scan_rejects_non_literal_prior_value() -> None:
    source = CLEAN_MODULE.replace("value=0.7", "value=prior_guess")
    violations, _ = extract.scan_discipline(source)
    assert any("register_prior value" in v for v in violations)


def test_strong_grade_on_other_claims_needs_no_domains() -> None:
    source = STRONG_REACH.replace("downstream_reach", "mechanism_insight")
    violations, _ = extract.scan_discipline(source.format(clause=""))
    assert violations == []


def test_strong_raise_requires_plain_hypothesis_variable() -> None:
    source = STRONG_REACH.format(clause="").replace(
        "hypothesis=downstream_reach", "hypothesis=claims['reach']"
    )
    violations, _ = extract.scan_discipline(source)
    assert any("plain claim variable" in v for v in violations)


def test_non_strong_indirect_hypothesis_is_a_review_flag() -> None:
    source = CLEAN_MODULE.replace("hypothesis=sub", "hypothesis=graph['sub']")
    violations, review_flags = extract.scan_discipline(source)
    assert violations == []
    assert any("confirm the update target" in f for f in review_flags)


def test_discipline_scan_accepts_reversed_grades() -> None:
    source = CLEAN_MODULE.replace(
        "p_e_given_h=0.90, p_e_given_not_h=0.09",
        "p_e_given_h=0.09, p_e_given_not_h=0.90",
    )
    assert extract.scan_discipline(source) == ([], [])


def test_discipline_scan_covers_generated_template() -> None:
    import gaia_package_scaffold as scaffold

    assert extract.scan_discipline(scaffold.render_template("x-idea")) == ([], [])


# --- Regressions for the round-5 static-scan bypasses -----------------------
#
# Each of the three cases below leaked before the fix (the scan returned no
# violation) and must now be caught. Each is paired with a legitimate variant
# that must stay clean, so the fix binds to the whole bypass class and not to
# one literal string.


def test_scan_rejects_module_attribute_assignment_alias() -> None:
    # Bypass 1: an alias built from a module attribute (`i = lang.infer`) let
    # an off-grade, unanchored call through, because the reference lived in an
    # ast.Attribute rather than a scanned bare name.
    source = (
        "import gaia.engine.lang as lang\n"
        "h = lang.claim('H.', title='h')\n"
        "e = lang.claim('E.', title='e')\n"
        "i = lang.infer\n"
        "i(e, hypothesis=h, p_e_given_h=0.85, p_e_given_not_h=0.15,\n"
        "  rationale='off grade no anchor')\n"
    )
    violations, _ = extract.scan_discipline(source)
    assert any("without being called" in v for v in violations)


def test_scan_still_allows_direct_module_attribute_call() -> None:
    # The fix must not flag a legitimate direct call through a module alias:
    # there the attribute sits in the call's function position.
    source = (
        "import gaia.engine.lang as lang\n"
        "h = lang.claim('H.', title='h')\n"
        "e = lang.observe('Fact.', rationale='ctx. anchor: x')\n"
        "lang.infer(e, hypothesis=h, p_e_given_h=0.90, p_e_given_not_h=0.09,\n"
        "           rationale='ctx. anchor: x')\n"
    )
    assert extract.scan_discipline(source) == ([], [])


def test_strong_reach_identified_by_claim_title_needs_domains() -> None:
    # Bypass 2: naming the claim variable anything but downstream_reach
    # (`reach = claim(..., title="downstream_reach")`) skipped the >= 3-domain
    # gate, which keyed only on the variable name. Identity is the title.
    source = (
        "from gaia.engine.lang import claim, infer, observe\n"
        "worth = claim('Worth.', title='worth')\n"
        "reach = claim('Reach.', title='downstream_reach')\n"
        "ev = observe('Chains.', rationale='ctx. anchor: idea card')\n"
        "infer(ev, hypothesis=reach, p_e_given_h=0.90, p_e_given_not_h=0.03,\n"
        "      rationale='broad reach. anchor: idea card')\n"
    )
    violations, _ = extract.scan_discipline(source)
    assert any("downstream_reach update without" in v for v in violations)


def test_strong_reach_by_title_with_domains_passes() -> None:
    # Same title-based identity, but now with a proper domains clause: it is a
    # genuine three-domain reach update and must pass.
    source = (
        "from gaia.engine.lang import claim, infer, observe\n"
        "worth = claim('Worth.', title='worth')\n"
        "reach = claim('Reach.', title='downstream_reach')\n"
        "ev = observe('Chains.', rationale='ctx. anchor: idea card')\n"
        "infer(ev, hypothesis=reach, p_e_given_h=0.90, p_e_given_not_h=0.03,\n"
        "      rationale='domains: first; second; third. anchor: idea card')\n"
    )
    assert extract.scan_discipline(source) == ([], [])


def test_domains_clause_inside_anchor_note_does_not_count() -> None:
    # Bypass 3: SKILL.md requires the domains clause BEFORE the trailing
    # anchor note. A domains clause embedded inside the anchor note must not
    # satisfy the gate.
    assert not extract.has_domains_clause(
        "broad reach. anchor: idea card; domains: first; second; third"
    )
    # A clause that genuinely precedes the anchor note still counts.
    assert extract.has_domains_clause(
        "domains: first; second; third. anchor: idea card"
    )


def test_strong_reach_with_domains_hidden_in_anchor_is_rejected() -> None:
    # The same bypass exercised through the full scan: hiding the domains
    # inside the anchor note leaves the strong reach update unsupported.
    source = (
        "from gaia.engine.lang import claim, infer, observe\n"
        "worth = claim('Worth.', title='worth')\n"
        "downstream_reach = claim('Reach.', title='downstream_reach')\n"
        "ev = observe('Chains.', rationale='ctx. anchor: idea card')\n"
        "infer(ev, hypothesis=downstream_reach, p_e_given_h=0.90,\n"
        "      p_e_given_not_h=0.03,\n"
        "      rationale='reach. anchor: idea card; domains: a; b; c')\n"
    )
    violations, _ = extract.scan_discipline(source)
    assert any("downstream_reach update without" in v for v in violations)


def write_fake_gaia(tmp_path, fixtures_dir=None):
    """Stub gaia: correct version banner; optionally fakes `run infer` by
    copying fixture artifacts into the package's .gaia directory."""
    fake = tmp_path / "fake-gaia"
    lines = [
        "#!/bin/sh",
        'if [ "$1" = "--version" ]; then echo "gaia-lang 0.5.0a4"; exit 0; fi',
    ]
    if fixtures_dir is not None:
        lines += [
            'eval "last=\\${$#}"',
            'if [ "$1" = "run" ]; then',
            '  mkdir -p "$last/.gaia"',
            f'  cp "{fixtures_dir}/beliefs_sample.json" "$last/.gaia/beliefs.json"',
            f'  cp "{fixtures_dir}/ir_sample.json" "$last/.gaia/ir.json"',
            "fi",
        ]
    lines.append("exit 0")
    fake.write_text("\n".join(lines) + "\n", encoding="utf-8")
    fake.chmod(0o755)
    return fake


def write_violating_package(tmp_path):
    module = tmp_path / "pkg" / "src" / "bad_idea"
    module.mkdir(parents=True)
    (module / "__init__.py").write_text(
        CLEAN_MODULE.replace("p_e_given_h=0.90", "p_e_given_h=0.85"),
        encoding="utf-8",
    )
    return tmp_path / "pkg"


def test_main_refuses_on_discipline_violation(tmp_path, capsys) -> None:
    package = write_violating_package(tmp_path)
    fake_gaia = write_fake_gaia(tmp_path)
    code = extract.main(
        ["--package", str(package), "--gaia-bin", str(fake_gaia)]
    )
    assert code == 2
    err = capsys.readouterr().err
    assert "discipline violation" in err
    assert "Refusing to extract" in err
    assert "ok: build compile" not in err  # stopped before any gaia stage


def test_main_explicit_exception_marks_exploration_only(
    tmp_path, fixtures_dir, capsys
) -> None:
    package = write_violating_package(tmp_path)
    fake_gaia = write_fake_gaia(tmp_path, fixtures_dir=fixtures_dir)
    code = extract.main(
        [
            "--package", str(package),
            "--gaia-bin", str(fake_gaia),
            "--allow-discipline-warnings",
        ]
    )
    out = capsys.readouterr()
    assert "allowed by --allow-discipline-warnings" in out.err
    assert code == 0
    posterior = json.loads(out.out)
    # The exception is explicit and the product is quarantined: the
    # reference is marked so the writeback contract refuses it.
    assert posterior["gaia_package_ref"].startswith("exploration-only:")
    assert posterior["value"] == pytest.approx(0.8499370175790979)


def test_extract_posterior_requires_ir_hash(tmp_path, fixtures_dir) -> None:
    gaia_dir = tmp_path / "pkg" / ".gaia"
    gaia_dir.mkdir(parents=True)
    shutil.copy(fixtures_dir / "beliefs_sample.json", gaia_dir / "beliefs.json")
    ir = json.loads((fixtures_dir / "ir_sample.json").read_text())
    del ir["ir_hash"]
    (gaia_dir / "ir.json").write_text(json.dumps(ir), encoding="utf-8")
    with pytest.raises(ValueError, match="ir_hash"):
        extract.extract_posterior(tmp_path / "pkg", "worth")
