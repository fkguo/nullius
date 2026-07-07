"""Tests for human-facing posterior rounding in Markdown reports."""

from __future__ import annotations

from pathlib import Path

import normalize_report_posteriors as posteriors


def test_rounds_posterior_value_line_without_touching_json(tmp_path: Path) -> None:
    report = tmp_path / "posterior_report.md"
    report.write_text(
        "\n".join(
            [
                "# Posterior Report",
                "",
                "Posterior value: `0.9255435028366992`.",
                "",
                "Extracted posterior: [posterior.json](artifacts/campaign/posterior.json).",
            ]
        ),
        encoding="utf-8",
    )
    machine = tmp_path / "posterior.json"
    machine.write_text('{"value":0.9255435028366992}\n', encoding="utf-8")

    changed = posteriors.normalize_file(report)

    assert changed is True
    assert "Posterior value: `0.926`." in report.read_text(encoding="utf-8")
    assert machine.read_text(encoding="utf-8") == '{"value":0.9255435028366992}\n'


def test_check_mode_reports_change_without_writing(tmp_path: Path) -> None:
    report = tmp_path / "posterior_report.md"
    report.write_text("Posterior value: 0.123456\n", encoding="utf-8")

    changed = posteriors.normalize_file(report, check=True)

    assert changed is True
    assert report.read_text(encoding="utf-8") == "Posterior value: 0.123456\n"


def test_already_rounded_report_is_unchanged(tmp_path: Path) -> None:
    report = tmp_path / "posterior_report.md"
    report.write_text("- **Posterior value**: `1.000`.\n", encoding="utf-8")

    changed = posteriors.normalize_file(report)

    assert changed is False
    assert report.read_text(encoding="utf-8") == "- **Posterior value**: `1.000`.\n"


def test_rejects_out_of_range_posterior_value() -> None:
    try:
        posteriors.normalize_text("Posterior value: `1.234`.\n")
    except ValueError as exc:
        assert "must be in [0, 1]" in str(exc)
    else:
        raise AssertionError("expected out-of-range posterior to be rejected")
