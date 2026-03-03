#!/usr/bin/env python3
"""Tests for RT-01 packet redaction functions in build_team_packet.py."""
from __future__ import annotations

import sys
from pathlib import Path

# Add the bin directory so we can import from build_team_packet
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts" / "bin"))

from build_team_packet import (
    _redact_critical_steps,
    _redact_headline_numbers,
    REDACTED_TAG,
    HIDDEN_TAG,
)


class TestRedactCriticalSteps:
    """Test _redact_critical_steps()."""

    SAMPLE_PACKET = (
        "## Step 1: Setup conventions\n"
        "We define the metric as (+,-,-,-).\n"
        "The coupling constant is g = 0.3.\n"
        "\n"
        "## Step 2: Derive amplitude\n"
        "Starting from the Lagrangian...\n"
        "The amplitude is M = g^2 / (s - m^2).\n"
        "\n"
        "## Step 3: Numerical evaluation\n"
        "Using the above, we compute sigma = 1.23 pb.\n"
    )

    def test_redact_by_number(self):
        result = _redact_critical_steps(self.SAMPLE_PACKET, ["2"])
        assert "## Step 2: Derive amplitude" in result
        assert REDACTED_TAG in result
        assert "Starting from the Lagrangian" not in result
        # Other steps preserved
        assert "coupling constant is g = 0.3" in result
        assert "sigma = 1.23 pb" in result

    def test_redact_by_title_substring(self):
        result = _redact_critical_steps(self.SAMPLE_PACKET, ["amplitude"])
        assert REDACTED_TAG in result
        assert "Starting from the Lagrangian" not in result

    def test_redact_multiple_steps(self):
        result = _redact_critical_steps(self.SAMPLE_PACKET, ["1", "3"])
        # Step 1 and 3 redacted
        assert result.count(REDACTED_TAG) == 2
        # Step 2 preserved
        assert "Starting from the Lagrangian" in result

    def test_no_redaction_empty_list(self):
        result = _redact_critical_steps(self.SAMPLE_PACKET, [])
        assert result == self.SAMPLE_PACKET

    def test_no_match(self):
        result = _redact_critical_steps(self.SAMPLE_PACKET, ["nonexistent"])
        assert result == self.SAMPLE_PACKET

    def test_case_insensitive_title(self):
        result = _redact_critical_steps(self.SAMPLE_PACKET, ["AMPLITUDE"])
        assert REDACTED_TAG in result


class TestRedactHeadlineNumbers:
    """Test _redact_headline_numbers()."""

    def test_redact_h_lines(self):
        text = (
            "Some text\n"
            "- H1: [T1] sigma = 1.23e-3 ± 0.01\n"
            "- H2: [T2] ratio = 0.567\n"
            "Other text = 42\n"
        )
        result = _redact_headline_numbers(text)
        assert HIDDEN_TAG in result
        assert "1.23e-3" not in result
        assert "0.567" not in result
        # Non-headline numbers preserved
        assert "Other text = 42" in result

    def test_redact_capsule_section_e(self):
        text = (
            "### E) Headline numbers\n"
            "- H1: sigma = 3.14\n"
            "- H2: rate = 2.71\n"
            "### F) Environment\n"
            "Python = 3.11\n"
        )
        result = _redact_headline_numbers(text)
        assert "3.14" not in result
        assert "2.71" not in result
        # Section F not redacted
        assert "Python = 3.11" in result

    def test_no_h_lines_no_change(self):
        text = "Regular text with x = 42 and y = 3.14\n"
        result = _redact_headline_numbers(text)
        assert result == text


class TestSidecarAutoDetection:
    """Test _has_numerical_artifacts() in sidecar probe."""

    def test_has_numerical_artifacts(self, tmp_path):
        # Import from sidecar probe
        sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts" / "bin"))
        from team_cycle_sidecar_probe import _has_numerical_artifacts

        notes = tmp_path / "Draft.md"
        notes.write_text(
            "# Analysis\n"
            "<!-- REPRO_CAPSULE_START -->\n"
            "### Expected outputs\n"
            "- results/data.csv\n"
            "- results/plot.png\n"
            "<!-- REPRO_CAPSULE_END -->\n"
        )
        assert _has_numerical_artifacts(notes) is True

    def test_no_numerical_artifacts(self, tmp_path):
        sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts" / "bin"))
        from team_cycle_sidecar_probe import _has_numerical_artifacts

        notes = tmp_path / "Draft.md"
        notes.write_text(
            "# Theory derivation\n"
            "Pure symbolic analysis, no data files.\n"
        )
        assert _has_numerical_artifacts(notes) is False

    def test_numerical_extension_in_prose(self, tmp_path):
        sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts" / "bin"))
        from team_cycle_sidecar_probe import _has_numerical_artifacts

        notes = tmp_path / "Draft.md"
        notes.write_text(
            "# Analysis\n"
            "We load data from `output.h5` and process it.\n"
        )
        assert _has_numerical_artifacts(notes) is True
