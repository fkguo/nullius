"""Tests for render_argument_graph.py — the statement-first interactive render.

The renderer's display contract, pinned here:
- every card shows the node's actual statement, not just its variable label;
- each ``infer`` is drawn as one arrow from the evidence to the hypothesis it
  updates (the IR stores the generative direction, hypothesis -> evidence);
- direction of effect and strength live on the edge (supports/lowers classes,
  a weak/substantial/strong chip with the likelihood ratio);
- compiler-minted helper nodes stay hidden; non-infer strategies go through a
  labelled junction; the page is self-contained and byte-deterministic.
"""

from __future__ import annotations

import json
import re
import subprocess
import sys
from pathlib import Path

import pytest

import render_argument_graph as rag

SCRIPT = Path(__file__).resolve().parent.parent / "scripts" / "render_argument_graph.py"

NS = "github:demo_idea"

WORTH = f"{NS}::worth"
TENSION = f"{NS}::tension_resolution"
EV_ANCHOR = f"{NS}::ev_anchor"
EV_SCOPE = f"{NS}::ev_scope_limit"
HELPER = f"{NS}::_anon_000"

WORTH_TEXT = "The idea merits sustained verification effort."
TENSION_TEXT = "The idea resolves an anchored open tension."
ANCHOR_TEXT = (
    "A grounded survey records the tension between calibration papers "
    "& regulator discussions."
)
SCOPE_TEXT = "The executed check covers a single channel only, not the full claim."


def knowledge(kid: str, label: str, content: str, index: int, observed: bool = False):
    entry: dict = {
        "id": kid,
        "label": label,
        "type": "claim",
        "content": content,
        "declaration_index": index,
        "metadata": {},
    }
    if observed:
        entry["metadata"] = {
            "prior": 0.999,
            "supported_by": [
                {
                    "pattern": "observation",
                    "rationale": (
                        "Recorded observation for the demo. "
                        "anchor: artifacts/demo/survey_v1.json; "
                        "artifacts/demo/close_prior_matrix_v1.json"
                    ),
                }
            ],
        }
    return entry


def infer_strategy(evidence: str, hypothesis: str, p_nh: float, p_h: float,
                   sid: str, reasoning: str):
    # IR keeps the generative direction: premises = [hypothesis],
    # conclusion = evidence, probabilities = [P(e|not h), P(e|h)].
    return {
        "type": "infer",
        "premises": [hypothesis],
        "conclusion": evidence,
        "conditional_probabilities": [p_nh, p_h],
        "steps": [{"reasoning": reasoning}],
        "strategy_id": sid,
    }


def base_ir() -> dict:
    return {
        "ir_hash": "sha256:" + "ab" * 32,
        "namespace": NS,
        "package_name": "demo-idea-gaia",
        "knowledges": [
            knowledge(WORTH, "worth", WORTH_TEXT, 0),
            knowledge(TENSION, "tension_resolution", TENSION_TEXT, 1),
            knowledge(EV_ANCHOR, "ev_anchor", ANCHOR_TEXT, 2, observed=True),
            knowledge(EV_SCOPE, "ev_scope_limit", SCOPE_TEXT, 3, observed=True),
            {"id": HELPER, "type": "claim"},
        ],
        "strategies": [
            infer_strategy(
                EV_ANCHOR, TENSION, 0.09, 0.90, "lcs_anchor",
                "Substantial support for the anchored tension. "
                "anchor: artifacts/demo/survey_v1.json",
            ),
            infer_strategy(
                TENSION, WORTH, 0.25, 0.75, "lcs_worth",
                "Weak worth update. anchor: artifacts/demo/record_v1.json",
            ),
            infer_strategy(
                EV_SCOPE, WORTH, 0.75, 0.25, "lcs_scope",
                "Weak lowering: the executed check does not cover the claim. "
                "anchor: artifacts/demo/scope_v1.json",
            ),
        ],
    }


def base_beliefs() -> dict:
    return {
        "beliefs": [
            {"knowledge_id": WORTH, "label": "worth", "belief": 0.847},
            {"knowledge_id": TENSION, "label": "tension_resolution", "belief": 0.931},
            {"knowledge_id": EV_ANCHOR, "label": "ev_anchor", "belief": 0.9993},
            {"knowledge_id": EV_SCOPE, "label": "ev_scope_limit", "belief": 0.9971},
            {"knowledge_id": HELPER, "label": None, "belief": 0.5},
        ]
    }


def write_package(tmp_path: Path, ir: dict, beliefs: dict | None) -> Path:
    package = tmp_path / "demo-idea-gaia"
    gaia_dir = package / ".gaia"
    gaia_dir.mkdir(parents=True)
    (gaia_dir / "ir.json").write_text(json.dumps(ir), encoding="utf-8")
    if beliefs is not None:
        (gaia_dir / "beliefs.json").write_text(json.dumps(beliefs), encoding="utf-8")
    (gaia_dir / "compile_metadata.json").write_text(
        json.dumps(
            {
                "compiled_at": "2026-07-08T03:10:30Z",
                "gaia_lang_version": "0.5.0a4",
                "ir_hash": ir["ir_hash"],
            }
        ),
        encoding="utf-8",
    )
    return package


def run_renderer(package: Path, *extra: str) -> subprocess.CompletedProcess:
    return subprocess.run(
        [sys.executable, str(SCRIPT), "--package", str(package), *extra],
        capture_output=True,
        text=True,
        timeout=120,
        check=False,
    )


def rendered(tmp_path: Path, *extra: str) -> str:
    package = write_package(tmp_path, base_ir(), base_beliefs())
    result = run_renderer(package, *extra)
    assert result.returncode == 0, result.stderr
    return (package / "argument-graph.html").read_text(encoding="utf-8")


def payload_of(page: str) -> dict:
    match = re.search(
        r'<script id="graph-data" type="application/json">(.*?)</script>',
        page,
        re.S,
    )
    assert match, "embedded graph-data payload missing"
    # Every "<" in the block is emitted as a < JSON escape, which
    # json.loads decodes back to the original character.
    assert "<" not in match.group(1)
    return json.loads(match.group(1))


def test_cards_show_full_statements(tmp_path) -> None:
    page = rendered(tmp_path)
    # Wrapping splits statements across tspans; check phrase fragments that
    # fit within one wrapped line.
    for fragment in (
        "The idea merits sustained",
        "The idea resolves an anchored open",
        "regulator discussions.",
        "single channel only,",
    ):
        assert fragment in page
    # A pure-infer graph has no structural (junction) arrows, so the legend
    # must not mention them (the phrase with the derive/compose gloss is
    # legend-only; the JS fallback wording is always present).
    assert "not a belief update" not in page


def test_effect_and_strength_on_edges(tmp_path) -> None:
    page = rendered(tmp_path)
    assert 'class="edge edge-supports"' in page
    assert 'class="edge edge-lowers"' in page
    assert "substantial ×10" in page
    assert "weak ×3" in page
    assert "weak ÷3" in page
    assert 'marker-end="url(#arrow-lowers)"' in page


def test_display_direction_is_evidence_into_hypothesis(tmp_path) -> None:
    payload = payload_of(rendered(tmp_path))
    updates = {(e["source"], e["target"]) for e in payload["edges"] if e["kind"] == "update"}
    # IR premises/conclusion run hypothesis -> evidence; display must invert.
    assert (EV_ANCHOR, TENSION) in updates
    assert (TENSION, WORTH) in updates
    assert (EV_SCOPE, WORTH) in updates


def test_roles_and_observation_marking(tmp_path) -> None:
    page = rendered(tmp_path)
    payload = payload_of(page)
    assert payload["nodes"][WORTH]["role"] == "root"
    assert payload["nodes"][TENSION]["role"] == "claim"
    assert payload["nodes"][EV_ANCHOR]["role"] == "evidence"
    assert payload["nodes"][EV_ANCHOR]["observed"] is True
    assert payload["nodes"][EV_ANCHOR]["pinned_prior"] == pytest.approx(0.999)
    assert payload["nodes"][EV_ANCHOR]["observation_anchors"] == [
        "artifacts/demo/survey_v1.json",
        "artifacts/demo/close_prior_matrix_v1.json",
    ]
    assert "recorded observation" in page
    assert "0.847" in page  # root posterior shown


def test_likelihoods_and_anchors_in_payload(tmp_path) -> None:
    payload = payload_of(rendered(tmp_path))
    update = next(
        e for e in payload["edges"] if (e["source"], e["target"]) == (EV_ANCHOR, TENSION)
    )
    assert update["p_e_given_h"] == pytest.approx(0.90)
    assert update["p_e_given_not_h"] == pytest.approx(0.09)
    assert update["grade"] == "substantial"
    assert update["effect"] == "supports"
    assert update["anchors"] == ["artifacts/demo/survey_v1.json"]
    lowering = next(
        e for e in payload["edges"] if (e["source"], e["target"]) == (EV_SCOPE, WORTH)
    )
    assert lowering["effect"] == "lowers"
    assert lowering["factor"] == "÷3"


def test_helper_nodes_hidden(tmp_path) -> None:
    page = rendered(tmp_path)
    assert "_anon_000" not in page


def test_junction_for_non_infer_strategies(tmp_path) -> None:
    ir = base_ir()
    derived = f"{NS}::derived_claim"
    ir["knowledges"].append(knowledge(derived, "derived_claim", "A derived synthesis.", 4))
    ir["strategies"].append(
        {
            "type": "derive",
            "premises": [TENSION, EV_ANCHOR],
            "conclusion": derived,
            "steps": [{"reasoning": "Forward derivation."}],
            "strategy_id": "lcs_derive",
        }
    )
    beliefs = base_beliefs()
    beliefs["beliefs"].append(
        {"knowledge_id": derived, "label": "derived_claim", "belief": 0.7}
    )
    package = write_package(tmp_path, ir, beliefs)
    result = run_renderer(package)
    assert result.returncode == 0, result.stderr
    page = (package / "argument-graph.html").read_text(encoding="utf-8")
    assert "node-junction" in page
    payload = payload_of(page)
    flows = {(e["source"], e["target"]) for e in payload["edges"] if e["kind"] == "flow"}
    junction = "junction::lcs_derive"
    # Non-infer strategies keep their forward direction through the junction.
    assert (TENSION, junction) in flows
    assert (EV_ANCHOR, junction) in flows
    assert (junction, derived) in flows
    assert ">derive<" in page  # junction ellipse carries the strategy type
    # The panel payload names the junction readably — flow edges must never
    # surface the internal junction::<strategy_id> string in the panel.
    assert payload["nodes"][junction]["label"] == "derive step"
    assert payload["nodes"][junction]["role"] == "junction"
    # The legend explains gray structural arrows only when they exist.
    assert "not a belief update" in page


def test_statements_are_escaped(tmp_path) -> None:
    # <!-- would flip an HTML parser into the script double-escaped state if
    # it survived raw inside the data block; </script> would end the block.
    evil = 'Claim with <!-- <script>alert("x")</script> inside.'
    ir = base_ir()
    ir["knowledges"][1]["content"] = evil
    package = write_package(tmp_path, ir, base_beliefs())
    result = run_renderer(package)
    assert result.returncode == 0, result.stderr
    page = (package / "argument-graph.html").read_text(encoding="utf-8")
    # Everything rendered as markup (the SVG cards and their ARIA labels)
    # carries the statement HTML-escaped; no raw <script> or comment opener
    # before the data block.
    svg_region = page.split('<script id="graph-data"', 1)[0]
    assert "<script>alert(" not in svg_region
    assert "<!--" not in svg_region
    assert "&lt;script&gt;alert(" in svg_region
    # The embedded JSON carries no raw "<" at all (payload_of asserts this)
    # and still round-trips the original statement; the page JS inserts it
    # via textContent, never innerHTML.
    payload = payload_of(page)
    assert payload["nodes"][TENSION]["statement"] == evil


def test_page_is_self_contained(tmp_path) -> None:
    page = rendered(tmp_path)
    assert 'src="http' not in page
    assert "<link" not in page
    assert "@import" not in page


def test_deterministic_output(tmp_path) -> None:
    first = rendered(tmp_path / "a")
    second = rendered(tmp_path / "b")
    assert first == second


def test_rendered_page_has_no_trailing_whitespace(tmp_path) -> None:
    page = rendered(tmp_path)
    assert all(line == line.rstrip() for line in page.splitlines())


def test_missing_beliefs_is_a_clear_error(tmp_path) -> None:
    package = write_package(tmp_path, base_ir(), beliefs=None)
    result = run_renderer(package)
    assert result.returncode == 2
    assert "beliefs" in result.stderr
    assert not (package / "argument-graph.html").exists()


def test_header_links_and_title(tmp_path) -> None:
    page = rendered(
        tmp_path, "--title", "Demo idea", "--link", "All graphs=../../index.html"
    )
    assert "<title>Demo idea</title>" in page
    assert '<a href="../../index.html">All graphs</a>' in page


def test_bad_link_argument_fails(tmp_path) -> None:
    package = write_package(tmp_path, base_ir(), base_beliefs())
    result = run_renderer(package, "--link", "no-equals-sign")
    assert result.returncode == 2
    assert "LABEL=HREF" in result.stderr


def test_display_cycle_is_refused(tmp_path) -> None:
    ir = base_ir()
    # A second inverted infer between the same pair creates a display cycle:
    # tension -> worth (existing) plus worth -> tension (this one).
    ir["strategies"].append(
        infer_strategy(WORTH, TENSION, 0.25, 0.75, "lcs_cycle", "cycle")
    )
    package = write_package(tmp_path, ir, base_beliefs())
    result = run_renderer(package)
    assert result.returncode == 2
    assert "cycle" in result.stderr.lower()


def test_grade_classification_boundaries() -> None:
    assert rag.grade_for(abs(rag.math.log10(3))) == "weak"
    assert rag.grade_for(abs(rag.math.log10(10))) == "substantial"
    assert rag.grade_for(abs(rag.math.log10(30))) == "strong"
    assert rag.grade_for(abs(rag.math.log10(5))) == "weak"
    assert rag.grade_for(abs(rag.math.log10(6))) == "substantial"


def test_factor_text_formats() -> None:
    assert rag.factor_text(10.0) == "×10"
    assert rag.factor_text(1 / 3) == "÷3"
    assert rag.factor_text(float("inf")) == "×∞"


def test_split_anchors() -> None:
    prose, anchors = rag.split_anchors(
        "Weak update. anchor: artifacts/a.json; artifacts/b.md"
    )
    assert prose == "Weak update."
    assert anchors == ["artifacts/a.json", "artifacts/b.md"]
    prose, anchors = rag.split_anchors("No anchor marker here.")
    assert prose == "No anchor marker here."
    assert anchors == []
