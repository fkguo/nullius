#!/usr/bin/env python3
"""Tests for RT-04 idea-source injection and lead export in build_team_packet.py."""
from __future__ import annotations

import json
import sys
from pathlib import Path

# Add the bin directory so we can import from build_team_packet
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts" / "bin"))

from build_team_packet import (
    _load_idea_seeds,
    _format_idea_seed_section,
    _parse_innovation_leads,
    _leads_to_idea_cards,
)


class TestLoadIdeaSeeds:
    """Test _load_idea_seeds()."""

    def test_load_idea_pack(self, tmp_path):
        data = {
            "ideas": [
                {
                    "thesis_statement": "Test thesis about QCD",
                    "testable_hypotheses": ["H1"],
                    "required_observables": ["sigma_tot"],
                    "candidate_formalisms": ["qcd/lattice"],
                    "minimal_compute_plan": [{"step": "s1", "method": "m1", "estimated_difficulty": "moderate"}],
                    "claims": [{"claim_text": "QCD is confining", "support_type": "literature", "evidence_uris": ["https://example.com"]}],
                }
            ]
        }
        p = tmp_path / "ideas.json"
        p.write_text(json.dumps(data))
        seeds = _load_idea_seeds(p)
        assert len(seeds) == 1
        assert seeds[0]["thesis_statement"] == "Test thesis about QCD"

    def test_load_bare_array(self, tmp_path):
        data = [{"thesis_statement": "Idea 1"}, {"thesis_statement": "Idea 2"}]
        p = tmp_path / "ideas.json"
        p.write_text(json.dumps(data))
        seeds = _load_idea_seeds(p)
        assert len(seeds) == 2

    def test_load_single_card(self, tmp_path):
        data = {"thesis_statement": "Single idea"}
        p = tmp_path / "ideas.json"
        p.write_text(json.dumps(data))
        seeds = _load_idea_seeds(p)
        assert len(seeds) == 1
        assert seeds[0]["thesis_statement"] == "Single idea"

    def test_load_missing_file(self, tmp_path):
        p = tmp_path / "nonexistent.json"
        seeds = _load_idea_seeds(p)
        assert seeds == []

    def test_load_invalid_json(self, tmp_path):
        p = tmp_path / "bad.json"
        p.write_text("not valid json {{{")
        seeds = _load_idea_seeds(p)
        assert seeds == []


class TestFormatIdeaSeedSection:
    """Test _format_idea_seed_section()."""

    def test_format_single_seed(self):
        seeds = [
            {
                "thesis_statement": "Test thesis",
                "testable_hypotheses": ["H1: something", "H2: else"],
                "required_observables": ["sigma"],
                "claims": [
                    {"claim_text": "Main claim", "support_type": "literature"},
                ],
            }
        ]
        lines = _format_idea_seed_section(seeds)
        text = "\n".join(lines)
        assert "## 0.3) External Idea Seeds" in text
        assert "Test thesis" in text
        assert "H1: something" in text
        assert "sigma" in text
        assert "[literature] Main claim" in text

    def test_format_truncates_at_10(self):
        seeds = [{"thesis_statement": f"Idea {i}"} for i in range(15)]
        lines = _format_idea_seed_section(seeds)
        text = "\n".join(lines)
        assert "Seed 10" in text
        assert "Seed 11" not in text

    def test_format_empty(self):
        lines = _format_idea_seed_section([])
        text = "\n".join(lines)
        assert "## 0.3) External Idea Seeds" in text


class TestParseInnovationLeads:
    """Test _parse_innovation_leads()."""

    def test_parse_leads(self, tmp_path):
        log = tmp_path / "INNOVATION_LOG.md"
        log.write_text(
            "# Innovation Log\n\n"
            "## Lead 1: Novel dispersion relation\n"
            "- Baseline it must beat: Standard linear dispersion\n"
            "- Discriminant: Non-zero cubic coefficient\n"
            "- Minimal test: Compute dispersion at k=0.5\n"
            "- Kill criterion: Cubic coefficient < 1e-6\n"
            "\n"
            "## Lead 2: New symmetry breaking pattern\n"
            "- Baseline it must beat: Conventional SSB\n"
            "- Discriminant: Order parameter anomaly\n"
            "- Minimal test: Check Ward identity\n"
            "- Kill criterion: Ward identity holds exactly\n"
        )
        leads = _parse_innovation_leads(log)
        assert len(leads) == 2
        assert leads[0]["title"] == "Novel dispersion relation"
        assert leads[0]["baseline"] == "Standard linear dispersion"
        assert leads[0]["kill_criterion"] == "Cubic coefficient < 1e-6"
        assert leads[1]["title"] == "New symmetry breaking pattern"

    def test_parse_empty_log(self, tmp_path):
        log = tmp_path / "INNOVATION_LOG.md"
        log.write_text("# Innovation Log\n\nNo leads yet.\n")
        leads = _parse_innovation_leads(log)
        assert leads == []

    def test_parse_missing_file(self, tmp_path):
        leads = _parse_innovation_leads(tmp_path / "nonexistent.md")
        assert leads == []


class TestLeadsToIdeaCards:
    """Test _leads_to_idea_cards()."""

    def test_convert_lead(self):
        leads = [
            {
                "title": "Novel approach to X",
                "baseline": "Standard method",
                "discriminant": "Measurable difference in Y",
                "minimal_test": "Compute Y at point P",
                "kill_criterion": "Y deviation < threshold",
            }
        ]
        cards = _leads_to_idea_cards(leads)
        assert len(cards) == 1
        card = cards[0]
        # Validate idea_card_v1 required fields
        assert "thesis_statement" in card
        assert "testable_hypotheses" in card
        assert "required_observables" in card
        assert "candidate_formalisms" in card
        assert "minimal_compute_plan" in card
        assert "claims" in card
        assert card["thesis_statement"] == "Novel approach to X"
        assert card["testable_hypotheses"][0] == "Measurable difference in Y"
        assert card["required_observables"][0] == "Compute Y at point P"
        # Should have 2 claims: main + baseline
        assert len(card["claims"]) == 2
        assert "Standard method" in card["claims"][1]["claim_text"]

    def test_convert_lead_no_baseline(self):
        leads = [{"title": "Simple lead", "baseline": "", "discriminant": "D", "minimal_test": "T", "kill_criterion": "K"}]
        cards = _leads_to_idea_cards(leads)
        assert len(cards) == 1
        # Only 1 claim (no baseline claim)
        assert len(cards[0]["claims"]) == 1

    def test_roundtrip_export(self, tmp_path):
        """Test that exported cards can be loaded back as idea seeds."""
        leads = [
            {
                "title": "Test lead",
                "baseline": "Old method",
                "discriminant": "New signal",
                "minimal_test": "Quick check",
                "kill_criterion": "Signal absent",
            }
        ]
        cards = _leads_to_idea_cards(leads)
        export_path = tmp_path / "exported.json"
        export_path.write_text(json.dumps({"ideas": cards}, indent=2))

        # Reload
        reloaded = _load_idea_seeds(export_path)
        assert len(reloaded) == 1
        assert reloaded[0]["thesis_statement"] == "Test lead"
