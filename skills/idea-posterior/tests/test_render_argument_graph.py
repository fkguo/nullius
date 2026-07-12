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
import html
import re
import textwrap
import subprocess
import sys
from pathlib import Path

import pytest

import render_argument_graph as rag

SCRIPT = Path(__file__).resolve().parent.parent / "scripts" / "render_argument_graph.py"

NS = "github:demo_idea"

WORTH = f"{NS}::worth"
TENSION = f"{NS}::tension_resolution"
REACH = f"{NS}::downstream_reach"
MECHANISM = f"{NS}::mechanism_insight"
TIMING = f"{NS}::testability_timing"
COST = f"{NS}::verification_cost"
EV_ANCHOR = f"{NS}::ev_anchor"
EV_SCOPE = f"{NS}::ev_scope_limit"
HELPER = f"{NS}::_anon_000"

WORTH_TEXT = (
    "The controlled comparison merits sustained verification because it can "
    "separate two recorded explanations."
)
TENSION_TEXT = (
    "The comparison can resolve which explanation accounts for the recorded "
    "effect within the tested range."
)
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
        "exported": kid == WORTH,
        "metadata": {},
    }
    if observed:
        entry["metadata"] = {
            "prior": 0.999,
            "supported_by": [
                {
                    "pattern": "observation",
                    "rationale": (
                        "evidence_family: graph-demo; correlation_model: single; "
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
            knowledge(
                REACH,
                "downstream_reach",
                "The resulting discriminator can be reused in two subsequent comparisons.",
                2,
            ),
            knowledge(
                MECHANISM,
                "mechanism_insight",
                "The compared mechanisms predict distinct responses under the recorded condition.",
                3,
            ),
            knowledge(
                TIMING,
                "testability_timing",
                "The required response and comparison records are available now.",
                4,
            ),
            knowledge(
                COST,
                "verification_cost",
                "One bounded comparison decides whether the response separation is present.",
                5,
            ),
            knowledge(EV_ANCHOR, "ev_anchor", ANCHOR_TEXT, 6, observed=True),
            knowledge(EV_SCOPE, "ev_scope_limit", SCOPE_TEXT, 7, observed=True),
            {"id": HELPER, "type": "claim", "exported": False},
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


def write_detailed_reasoning(package, body="#### worth\n", fragments=None):
    """Install a four-hash-bound detailed-page fixture for graph unit tests.

    Positive end-to-end coverage invokes the standalone renderer itself; this
    helper keeps graph-only tests fast while malformed/stale tests mutate the
    same public manifest shape.
    """
    docs = package / "docs"
    docs.mkdir(exist_ok=True)
    markdown = docs / rag.DETAILED_MARKDOWN_NAME
    html_page = docs / rag.DETAILED_HTML_NAME
    manifest = docs / rag.DETAILED_MANIFEST_NAME
    markdown.write_text(body, encoding="utf-8")
    if fragments is None:
        ir = json.loads((package / ".gaia" / "ir.json").read_text(encoding="utf-8"))
        fragments = sorted(
            item["label"]
            for item in ir.get("knowledges", [])
            if item.get("label")
            and not item["label"].startswith(rag.HELPER_LABEL_PREFIXES)
        )
    html_page.write_text(
        "<!doctype html>\n"
        + "\n".join(
            f'<h4 id="{html.escape(fragment)}">{html.escape(fragment)}</h4>'
            for fragment in fragments
        )
        + "\n",
        encoding="utf-8",
    )
    manifest.write_text(
        json.dumps(
            {
                "artifact": rag.DETAILED_ARTIFACT,
                "beliefs_sha256": rag.sha256_bytes(
                    (package / ".gaia" / "beliefs.json").read_bytes()
                ),
                "fragments": fragments,
                "html_sha256": rag.sha256_bytes(html_page.read_bytes()),
                "ir_sha256": rag.sha256_bytes(
                    (package / ".gaia" / "ir.json").read_bytes()
                ),
                "markdown_sha256": rag.sha256_bytes(markdown.read_bytes()),
                "renderer": {"fixture": "graph-unit-test"},
            },
            indent=2,
            sort_keys=True,
        )
        + "\n",
        encoding="utf-8",
    )
    return docs


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
        "The controlled comparison merits sustained",
        "The comparison can resolve which explanation",
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
        {"text": "artifacts/demo/survey_v1.json", "href": None},
        {"text": "artifacts/demo/close_prior_matrix_v1.json", "href": None},
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
    # Anchors are classified objects now; a JSON artifact stays plain text.
    assert update["anchors"] == [
        {"text": "artifacts/demo/survey_v1.json", "href": None}
    ]
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


def test_renderer_refuses_stale_package_without_unique_exported_worth(tmp_path) -> None:
    ir = base_ir()
    for item in ir["knowledges"]:
        if item.get("label") == "worth":
            item["exported"] = False
    package = write_package(tmp_path, ir, base_beliefs())
    result = run_renderer(package)
    assert result.returncode == 2
    assert '__all__ = ["worth"]' in result.stderr
    assert not (package / "argument-graph.html").exists()


def test_renderer_refuses_to_persist_machine_specific_paths(tmp_path) -> None:
    ir = base_ir()
    machine_local = "/" + "Users" + "/example/private-note.md"
    ir["knowledges"][0]["content"] = (
        f"A forbidden local reference appears at {machine_local}."
    )
    package = write_package(tmp_path, ir, base_beliefs())
    result = run_renderer(package)
    assert result.returncode == 2
    assert "machine-local" in result.stderr
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


# ---------------------------------------------------------------------------
# Render-audit follow-ups: full statements, chip separation, readable narrow
# view, clickable safe anchors, and deep-dive links into the detailed
# reasoning document.
# ---------------------------------------------------------------------------

LONG_SCOPE_TEXT = (
    "The executed verification covers only the leading-order kernel on the "
    "coarse operating point, so the extracted agreement cannot certify the "
    "resummed kernel, the fine operating point, or any configuration in "
    "which the subtracted background dominates the signal; every one of "
    "those regimes needs its own directly executed check before the claim "
    "may be reused there, because the agreement observed on the coarse "
    "point is compatible with several mechanisms that diverge from each "
    "other exactly where the background grows, and no interpolation "
    "argument bridges that gap without a further executed check; this "
    "limit is load-bearing for the whole argument and must stay visible "
    "in any overview of it."
)


def test_long_statement_is_never_shortened(tmp_path) -> None:
    # The overview card must carry the WHOLE statement (the render-audit
    # found the shortened card was typically the scope limit, the one
    # qualification an overview must not hide). Pre-fix, a fixed line
    # budget replaced the tail with an ellipsis.
    ir = base_ir()
    for entry in ir["knowledges"]:
        if entry.get("label") == "ev_scope_limit":
            entry["content"] = LONG_SCOPE_TEXT
    package = write_package(tmp_path, ir, base_beliefs())
    result = run_renderer(package)
    assert result.returncode == 0, result.stderr
    page = (package / "argument-graph.html").read_text(encoding="utf-8")
    # Every wrapped line of the long statement appears in the card; the
    # pre-fix line budget replaced the tail lines with a shortened one.
    # The expected lines are computed with textwrap directly -- NOT with
    # the renderer's own wrap_statement -- so a renderer that shortens
    # cannot also shorten the expectation (independent reference, the
    # same shared-kernel rule the verification gates enforce).
    expected_lines = textwrap.wrap(
        " ".join(LONG_SCOPE_TEXT.split()),
        width=38,
        break_long_words=True,
        break_on_hyphens=True,
    )
    assert len(expected_lines) > 12  # long enough to overflow the old budget
    # Pin the assertion to the SVG card tspans: the detail-panel JSON
    # always carries the full statement, so a bare substring check would
    # pass even on a shortened card.
    for line in expected_lines:
        assert f">{html.escape(line)}</tspan>" in page


def parse_chip_and_card_boxes(page: str):
    chips = []
    for match in re.finditer(
        r'<g class="chip chip-[a-z]+"[^>]*'
        r'transform="translate\(([-\d.]+),([-\d.]+)\)">'
        r'<rect width="([\d.]+)" height="([\d.]+)"',
        page,
    ):
        x, y, w, h = map(float, match.groups())
        chips.append((x, y, w, h))
    cards = []
    for match in re.finditer(
        r'<g class="node[^"]*"[^>]*'
        r'transform="translate\(([-\d.]+),([-\d.]+)\)">'
        r'<rect class="card" width="([\d.]+)" height="([\d.]+)"',
        page,
    ):
        x, y, w, h = map(float, match.groups())
        cards.append((x, y, w, h))
    return chips, cards


def test_grade_chips_clear_cards_and_each_other(tmp_path) -> None:
    # The render audit found chip-on-chip and chip-on-card collisions in
    # every real graph, worst where several weak updates converge on the
    # root claim. Reproduce that shape: five claims all updating the root.
    ir = base_ir()
    beliefs = base_beliefs()
    for i in range(3):
        cid = f"{NS}::extra_claim_{i}"
        ir["knowledges"].append(
            knowledge(cid, f"extra_claim_{i}", f"Extra converging judgment {i}.", 10 + i)
        )
        ir["strategies"].append(
            infer_strategy(
                cid, WORTH, 0.25, 0.75, f"lcs_extra_{i}",
                f"Weak converging update {i}. anchor: artifacts/demo/x{i}.json",
            )
        )
        beliefs["beliefs"].append(
            {"knowledge_id": cid, "label": f"extra_claim_{i}", "belief": 0.9}
        )
    package = write_package(tmp_path, ir, beliefs)
    result = run_renderer(package)
    assert result.returncode == 0, result.stderr
    page = (package / "argument-graph.html").read_text(encoding="utf-8")
    chips, cards = parse_chip_and_card_boxes(page)
    assert len(chips) >= 5 and len(cards) >= 6
    def overlap(a, b):
        ax, ay, aw, ah = a
        bx, by, bw, bh = b
        return not (ax + aw <= bx or bx + bw <= ax or ay + ah <= by or by + bh <= ay)
    for i, chip in enumerate(chips):
        for other in chips[i + 1:]:
            assert not overlap(chip, other), f"chip-chip overlap: {chip} vs {other}"
        for card in cards:
            assert not overlap(chip, card), f"chip-card overlap: {chip} vs {card}"


def test_narrow_view_keeps_a_readable_floor(tmp_path) -> None:
    # 390px-wide viewports must not open at fit-to-page card widths of
    # ~85px; the page opens at a readable floor and pans instead.
    page = rendered(tmp_path)
    assert "MIN_READABLE_SCALE" in page
    assert "Math.max(fitScale" in page


def test_classify_anchor_whitelist() -> None:
    web = rag.classify_anchor("https://example.org/paper#sec2")
    assert web["href"] == "https://example.org/paper#sec2"
    plain_http = rag.classify_anchor("http://example.org/x")
    assert plain_http["href"] == "http://example.org/x"
    assert rag.classify_anchor("../notes/deep_read.md")["href"] is None
    md2 = rag.classify_anchor("docs/detailed-reasoning.md")
    assert md2["href"] == "docs/detailed-reasoning.md"
    # The Markdown boundary applies to the PATH: a fragment after a .md
    # path is fine, a non-.md path is never rescued by a .md fragment.
    deep = rag.classify_anchor("docs/detailed-reasoning.md#Section_2")
    assert deep["href"] == "docs/detailed-reasoning.md#Section_2"
    assert rag.classify_anchor("artifacts/payload.html#x.md")["href"] is None
    assert rag.classify_anchor("docs/a.md#one#two")["href"] is None
    for opaque in (
        "artifacts/demo/survey_v1.json",
        "artifact://campaign/x/computations/y.json",
        "/absolute/path/notes.md",
        "javascript:alert(1)",
        "run 2026-07-08T03:10:30Z",
        "javascript:evil.md",
        "docs/./notes.md",
        "docs//notes.md",
    ):
        assert rag.classify_anchor(opaque)["href"] is None, opaque


def test_renderer_without_project_root_links_only_existing_package_markdown(
    tmp_path,
) -> None:
    ir = base_ir()
    ir["strategies"][1]["steps"][0]["reasoning"] = (
        "Weak worth update. anchor: notes/present.md; notes/missing.md"
    )
    package = write_package(tmp_path, ir, base_beliefs())
    notes = package / "notes"
    notes.mkdir()
    (notes / "present.md").write_text("evidence", encoding="utf-8")

    result = run_renderer(package)
    assert result.returncode == 0, result.stderr
    payload = payload_of((package / "argument-graph.html").read_text(encoding="utf-8"))
    update = next(
        edge
        for edge in payload["edges"]
        if edge["source"] == TENSION and edge["target"] == WORTH
    )
    assert update["anchors"] == [
        {"text": "notes/present.md", "href": "notes/present.md"},
        {"text": "notes/missing.md", "href": None},
    ]


def test_project_root_context_resolves_only_existing_in_project_markdown(tmp_path) -> None:
    project = tmp_path / "project"
    ir = base_ir()
    ir["strategies"][1]["steps"][0]["reasoning"] = (
        "Weak worth update. anchor: artifacts/demo/record_v1.md; "
        "notes/local.md; artifacts/demo/missing.md; ../outside.md"
    )
    package = write_package(project / "ideas" / "gaia", ir, base_beliefs())
    artifact = project / "artifacts" / "demo" / "record_v1.md"
    artifact.parent.mkdir(parents=True)
    artifact.write_text("evidence", encoding="utf-8")
    local = package / "notes" / "local.md"
    local.parent.mkdir()
    local.write_text("local", encoding="utf-8")
    (tmp_path / "outside.md").write_text("outside", encoding="utf-8")

    result = run_renderer(package, "--project-root", str(project))
    assert result.returncode == 0, result.stderr
    payload = payload_of((package / "argument-graph.html").read_text(encoding="utf-8"))
    update = next(
        edge
        for edge in payload["edges"]
        if edge["source"] == TENSION and edge["target"] == WORTH
    )
    assert update["anchors"] == [
        {
            "text": "artifacts/demo/record_v1.md",
            "href": "../../../artifacts/demo/record_v1.md",
        },
        {"text": "notes/local.md", "href": "notes/local.md"},
        {"text": "artifacts/demo/missing.md", "href": None},
        {"text": "../outside.md", "href": None},
    ]


def test_project_root_context_rejects_symlink_escape(tmp_path) -> None:
    project = tmp_path / "project"
    package = project / "ideas" / "gaia" / "demo-gaia"
    package.mkdir(parents=True)
    outside = tmp_path / "outside.md"
    outside.write_text("outside", encoding="utf-8")
    link = package / "outside-link.md"
    try:
        link.symlink_to(outside)
    except OSError as exc:
        pytest.skip(f"symlinks unavailable: {exc}")

    anchor = rag.classify_anchor(
        "outside-link.md",
        package_dir=package,
        output_dir=package,
        project_root=project,
    )
    assert anchor == {"text": "outside-link.md", "href": None}


def test_project_root_context_rejects_markdown_symlink_to_non_markdown(
    tmp_path,
) -> None:
    project = tmp_path / "project"
    package = project / "ideas" / "gaia" / "demo-gaia"
    package.mkdir(parents=True)
    target = project / "artifacts" / "record.txt"
    target.parent.mkdir()
    target.write_text("not Markdown", encoding="utf-8")
    link = package / "record.md"
    try:
        link.symlink_to(target)
    except OSError as exc:
        pytest.skip(f"symlinks unavailable: {exc}")

    anchor = rag.classify_anchor(
        "record.md",
        package_dir=package,
        output_dir=package,
        project_root=project,
    )
    assert anchor == {"text": "record.md", "href": None}


def test_project_root_must_contain_the_package(tmp_path) -> None:
    package = write_package(tmp_path / "package-parent", base_ir(), base_beliefs())
    other_root = tmp_path / "other-project"
    other_root.mkdir()
    result = run_renderer(package, "--project-root", str(other_root))
    assert result.returncode == 2
    assert "package directory is not under project root" in result.stderr


def test_detail_panel_links_the_detailed_reasoning_document(tmp_path) -> None:
    package = write_package(tmp_path, base_ir(), base_beliefs())
    write_detailed_reasoning(package)
    result = run_renderer(package)
    assert result.returncode == 0, result.stderr
    page = (package / "argument-graph.html").read_text(encoding="utf-8")
    payload = payload_of(page)
    worth = payload["nodes"][WORTH]
    assert worth["doc_href"] == "docs/detailed-reasoning.html#worth"
    # Junction relays never link.
    for node in payload["nodes"].values():
        if node["role"] == "junction":
            assert "doc_href" not in node


def test_no_doc_links_without_the_document_or_off_package_out(tmp_path) -> None:
    # No bound docs/detailed-reasoning.html -> no links at all.
    page = rendered(tmp_path)
    for node in payload_of(page)["nodes"].values():
        assert "doc_href" not in node
    # Document present but the page written outside the package: relative
    # links would dangle, so they are dropped.
    package = write_package(tmp_path / "second", base_ir(), base_beliefs())
    write_detailed_reasoning(package)
    out = tmp_path / "elsewhere" / "graph.html"
    out.parent.mkdir()
    result = run_renderer(package, "--out", str(out))
    assert result.returncode == 0, result.stderr
    for node in payload_of(out.read_text(encoding="utf-8"))["nodes"].values():
        assert "doc_href" not in node


# ---------------------------------------------------------------------------
# Review follow-ups on the render-audit fixes.
# ---------------------------------------------------------------------------

def test_classify_anchor_rejects_backslash_and_control_variants() -> None:
    # Browsers normalize backslashes to slashes (a leading "\\" or an
    # "\\\\host\\share" UNC form would become root- or protocol-relative)
    # and strip some control characters; the whitelist is a character-set
    # check, so none of these ever gets an href.
    for probe in (
        "\\\\evil.example\\share\\x.md",
        "\\evil.md",
        "notes\\sub.md",
        "\x01docs/x.md",
        "docs/x .md",
    ):
        assert rag.classify_anchor(probe)["href"] is None, repr(probe)


def test_doc_href_preserves_label_case_and_skips_helpers(tmp_path) -> None:
    # The detailed-page renderer installs the exact case-preserving IR label
    # on each node heading; lowercasing would break mixed-case fragments.
    # Referenced helper nodes have no section at all.
    ir = base_ir()
    mixed = f"{NS}::MixedCase_Claim"
    ir["knowledges"].append(knowledge(mixed, "MixedCase_Claim", "A mixed-case judgment.", 20))
    ir["strategies"].append(
        infer_strategy(mixed, WORTH, 0.3, 0.7, "lcs_mixed",
                       "Mixed. anchor: artifacts/demo/m.json")
    )
    beliefs = base_beliefs()
    beliefs["beliefs"].append(
        {"knowledge_id": mixed, "label": "MixedCase_Claim", "belief": 0.8}
    )
    # Reference the helper from a derive strategy so build_model keeps it
    # (unreferenced helpers are dropped and would make the assertion
    # vacuous), then require that the kept helper still gets no doc link.
    ir["strategies"].append(
        {
            "type": "derive",
            "premises": [HELPER, TENSION],
            "conclusion": WORTH,
            "steps": [{"reasoning": "Helper-backed derivation."}],
            "strategy_id": "derive_helper",
        }
    )
    package = write_package(tmp_path, ir, beliefs)
    write_detailed_reasoning(
        package,
        "#### MixedCase_Claim\n",
        fragments=["MixedCase_Claim"],
    )
    result = run_renderer(package)
    assert result.returncode == 0, result.stderr
    payload = payload_of((package / "argument-graph.html").read_text(encoding="utf-8"))
    assert payload["nodes"][mixed]["doc_href"] == (
        "docs/detailed-reasoning.html#MixedCase_Claim"
    )
    helper_nodes = [
        n for n in payload["nodes"].values()
        if n["raw_label"].startswith(("__", "_anon")) and n["role"] != "junction"
    ]
    assert helper_nodes, "a referenced helper must survive into the payload"
    for node in helper_nodes:
        assert "doc_href" not in node


def test_junctions_never_get_doc_links_and_join_chip_obstacles(tmp_path) -> None:
    # A derive strategy produces a junction relay. Junctions have no
    # detailed-reasoning section (no doc link) and participate in the chip
    # obstacle set like any card.
    ir = base_ir()
    ir["strategies"].append(
        {
            "type": "derive",
            "premises": [TENSION, EV_ANCHOR],
            "conclusion": WORTH,
            "steps": [{"reasoning": "Composed derivation."}],
            "strategy_id": "derive_1",
        }
    )
    package = write_package(tmp_path, ir, base_beliefs())
    write_detailed_reasoning(package, "x\n")
    result = run_renderer(package)
    assert result.returncode == 0, result.stderr
    payload = payload_of((package / "argument-graph.html").read_text(encoding="utf-8"))
    junctions = [n for n in payload["nodes"].values() if n["role"] == "junction"]
    assert junctions, "derive strategy must produce a junction relay"
    for node in junctions:
        assert "doc_href" not in node


def test_doc_links_survive_the_production_temp_sibling_out(tmp_path) -> None:
    # The production pipeline (run_infer_and_extract.render_to_file) renders
    # into an atomic-rename temp file that is a SIBLING of the final page,
    # i.e. its parent IS the package root; deep-dive links must be emitted
    # on exactly that shape.
    package = write_package(tmp_path, base_ir(), base_beliefs())
    write_detailed_reasoning(package, "x\n")
    out = package / "argument-graph.html.tmp"
    result = run_renderer(package, "--out", str(out))
    assert result.returncode == 0, result.stderr
    payload = payload_of(out.read_text(encoding="utf-8"))
    assert payload["nodes"][WORTH]["doc_href"] == "docs/detailed-reasoning.html#worth"


def test_place_chips_window_and_fallback_unit() -> None:
    # Direct unit check on the placement pass: chip_t always stays inside
    # the [0.10, 0.90] path window, and when every probed position overlaps
    # something (cards blanket the whole path), the least-overlap fallback
    # still assigns a position instead of failing.
    class Stub:
        pass

    def stub_edge(y):
        edge = Stub()
        edge.kind = "update"
        edge.effect = "supports"
        edge.grade = "weak"
        edge.lr = 3.0
        edge.strategy_id = f"s{y}"
        edge.source = "a"
        edge.target = "b"
        edge.points = (0.0, y, 400.0, y)
        edge.chip_t = 0.5
        return edge

    # A wall of cards covering the entire corridor forces the fallback.
    wall = Stub()
    wall.id = "wall"
    wall.junction = False
    wall.x, wall.y, wall.w, wall.h = -50.0, -50.0, 600.0, 200.0
    edges = [stub_edge(30.0), stub_edge(38.0)]
    rag.place_chips({"wall": wall}, edges)
    for edge in edges:
        assert 0.10 <= edge.chip_t <= 0.90
    # Two chips on parallel near-coincident paths started at the same t.
    # Unequal chip_t alone would not prove separation (nearby values can
    # still overlap), so assert the geometry directly: even under the
    # least-overlap fallback (the wall is inescapable) the two chips must
    # not overlap EACH OTHER -- and a no-op placement fails this too,
    # since at the same t these 8px-apart 17px-tall chips coincide.
    box_a = rag.chip_box(edges[0], edges[0].chip_t)
    box_b = rag.chip_box(edges[1], edges[1].chip_t)
    assert rag.overlap_area(box_a, box_b) == 0.0

    # Junctions are obstacles too: an ellipse relay in the corridor must
    # push the chip off its position exactly like a card would.
    relay = Stub()
    relay.id = "relay"
    relay.junction = True
    relay.x, relay.y, relay.w, relay.h = 180.0, 22.0, 40.0, 18.0
    free_edge = stub_edge(31.0)  # passes straight through the relay at t=0.5
    rag.place_chips({"relay": relay}, [free_edge])
    from_relay = rag.overlap_area(rag.chip_box(free_edge, free_edge.chip_t),
                                  (relay.x, relay.y, relay.w, relay.h))
    assert from_relay == 0.0


def test_stale_generation_reasoning_is_never_linked(tmp_path) -> None:
    # A manifest carrying another beliefs generation is stale even when its
    # Markdown and HTML files survive. A missing manifest is the same safe
    # side; there is no legacy beliefs-only fallback.
    package = write_package(tmp_path, base_ir(), base_beliefs())
    docs = write_detailed_reasoning(package)
    manifest_path = docs / rag.DETAILED_MANIFEST_NAME
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    manifest["beliefs_sha256"] = "sha256:" + "0" * 64
    manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
    result = run_renderer(package)
    assert result.returncode == 0, result.stderr
    page = (package / "argument-graph.html").read_text(encoding="utf-8")
    assert '"doc_href":' not in page

    manifest_path.unlink()
    result = run_renderer(package)
    assert result.returncode == 0, result.stderr
    page = (package / "argument-graph.html").read_text(encoding="utf-8")
    assert '"doc_href":' not in page


@pytest.mark.parametrize(
    "mutation",
    (
        "missing_html",
        "edited_html",
        "edited_markdown",
        "malformed_manifest",
        "manifest_fragment_missing_from_html",
    ),
)
def test_missing_or_stale_detailed_page_suppresses_all_deep_links(
    tmp_path, mutation
) -> None:
    package = write_package(tmp_path, base_ir(), base_beliefs())
    docs = write_detailed_reasoning(package)
    if mutation == "missing_html":
        (docs / rag.DETAILED_HTML_NAME).unlink()
    elif mutation == "edited_html":
        (docs / rag.DETAILED_HTML_NAME).write_text("STALE\n", encoding="utf-8")
    elif mutation == "edited_markdown":
        (docs / rag.DETAILED_MARKDOWN_NAME).write_text(
            "#### worth\nEdited after rendering.\n", encoding="utf-8"
        )
    elif mutation == "malformed_manifest":
        (docs / rag.DETAILED_MANIFEST_NAME).write_text("{not json", encoding="utf-8")
    else:
        html_path = docs / rag.DETAILED_HTML_NAME
        html_path.write_text(
            "<!doctype html><p>No node target.</p>\n", encoding="utf-8"
        )
        manifest_path = docs / rag.DETAILED_MANIFEST_NAME
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        manifest["html_sha256"] = rag.sha256_bytes(html_path.read_bytes())
        manifest_path.write_text(json.dumps(manifest), encoding="utf-8")

    result = run_renderer(package)
    assert result.returncode == 0, result.stderr
    page = (package / "argument-graph.html").read_text(encoding="utf-8")
    assert '"doc_href":' not in page


def test_edited_markdown_invalidates_link_until_html_is_regenerated(tmp_path) -> None:
    # The binding covers exact Markdown bytes as well as beliefs. Editing the
    # source correctly makes the old HTML stale until the standalone renderer
    # regenerates both the page and the manifest.
    package = write_package(tmp_path, base_ir(), base_beliefs())
    docs = write_detailed_reasoning(package)
    (docs / "detailed-reasoning.md").write_text(
        "#### worth\nHand-polished wording, same generation.\n", encoding="utf-8"
    )
    result = run_renderer(package)
    assert result.returncode == 0, result.stderr
    page = (package / "argument-graph.html").read_text(encoding="utf-8")
    assert '"doc_href":' not in page
