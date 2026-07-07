"""Tests for robust, clickable Markdown report links."""

from __future__ import annotations

from pathlib import Path

import normalize_report_links as links


def test_normalizes_doc_relative_and_sibling_links(tmp_path: Path) -> None:
    project = tmp_path / "project"
    report_dir = project / "artifacts" / "campaign"
    gaia_dir = project / "ideas" / "gaia" / "demo-gaia" / "docs"
    report_dir.mkdir(parents=True)
    gaia_dir.mkdir(parents=True)
    (project / "ideas" / "gaia" / "demo-gaia" / "starmap.html").write_text("html", encoding="utf-8")
    (gaia_dir / "detailed-reasoning.md").write_text("reasoning", encoding="utf-8")
    (report_dir / "posterior.json").write_text("{}", encoding="utf-8")
    report = report_dir / "posterior_report.md"
    report.write_text(
        "\n".join(
            [
                "[Posterior](posterior.json)",
                "[Starmap](../../ideas/gaia/demo-gaia/starmap.html)",
                "[Reasoning](../../ideas/gaia/demo-gaia/docs/detailed-reasoning.md)",
            ]
        ),
        encoding="utf-8",
    )

    changed = links.normalize_file(report, project)

    assert changed is False
    assert report.read_text(encoding="utf-8").splitlines() == [
        "[Posterior](posterior.json)",
        "[Starmap](../../ideas/gaia/demo-gaia/starmap.html)",
        "[Reasoning](../../ideas/gaia/demo-gaia/docs/detailed-reasoning.md)",
    ]


def test_converts_project_root_relative_links_for_nested_reports(tmp_path: Path) -> None:
    project = tmp_path / "project"
    report_dir = project / "artifacts" / "femtoscopy-model-dependence"
    starmap = project / "ideas" / "gaia" / "demo-gaia" / "starmap.html"
    report_dir.mkdir(parents=True)
    starmap.parent.mkdir(parents=True)
    starmap.write_text("html", encoding="utf-8")
    (report_dir / "posterior.json").write_text("{}", encoding="utf-8")
    report = report_dir / "posterior_report.md"
    report.write_text(
        "[Posterior](artifacts/femtoscopy-model-dependence/posterior.json)\n"
        "[Starmap](ideas/gaia/demo-gaia/starmap.html)\n"
        "[DOI](https://doi.org/10.123/demo)",
        encoding="utf-8",
    )

    changed = links.normalize_file(report, project)

    assert changed is True
    assert report.read_text(encoding="utf-8") == (
        "[Posterior](posterior.json)\n"
        "[Starmap](../../ideas/gaia/demo-gaia/starmap.html)\n"
        "[DOI](https://doi.org/10.123/demo)"
    )


def test_converts_file_uri_inside_project(tmp_path: Path) -> None:
    project = tmp_path / "project"
    report_dir = project / "artifacts" / "campaign"
    target = project / "ideas" / "gaia" / "demo-gaia" / "starmap.html"
    report_dir.mkdir(parents=True)
    target.parent.mkdir(parents=True)
    target.write_text("html", encoding="utf-8")
    report = report_dir / "posterior_report.md"
    report.write_text(f"[Starmap]({target.as_uri()})", encoding="utf-8")

    changed = links.normalize_file(report, project)

    assert changed is True
    assert report.read_text(encoding="utf-8") == "[Starmap](../../ideas/gaia/demo-gaia/starmap.html)"


def test_converts_project_uri_inside_project_and_keeps_pin(tmp_path: Path) -> None:
    project = tmp_path / "project"
    report_dir = project / "artifacts" / "campaign"
    package = project / "ideas" / "gaia" / "demo-gaia"
    report_dir.mkdir(parents=True)
    package.mkdir(parents=True)
    pin = "sha256:" + "a" * 64
    report = report_dir / "posterior_report.md"
    report.write_text(
        f"[Gaia package](project://ideas/gaia/demo-gaia#{pin})",
        encoding="utf-8",
    )

    changed = links.normalize_file(report, project)

    assert changed is True
    assert report.read_text(encoding="utf-8") == f"[Gaia package](../../ideas/gaia/demo-gaia#{pin})"


def test_autolinks_bare_local_paths_and_literature_ids(tmp_path: Path) -> None:
    project = tmp_path / "project"
    report_dir = project / "artifacts" / "campaign"
    report_dir.mkdir(parents=True)
    (report_dir / "matrix.json").write_text("{}", encoding="utf-8")
    (project / "ideas" / "gaia" / "demo-gaia").mkdir(parents=True)
    report = report_dir / "posterior_report.md"
    report.write_text(
        "\n".join(
            [
                "Matrix artifact: artifacts/campaign/matrix.json",
                "Graph directory: ideas/gaia/demo-gaia",
                "Close prior: arXiv:2411.18257, DOI:10.1000/demo, INSPIRE recid 2853359.",
                "`artifacts/campaign/matrix.json` and `arXiv:2411.18257` are still clickable.",
                "[Already linked arXiv:2411.18257](https://arxiv.org/abs/2411.18257)",
            ]
        ),
        encoding="utf-8",
    )

    changed = links.normalize_file(report, project)

    assert changed is True
    assert report.read_text(encoding="utf-8").splitlines() == [
        "Matrix artifact: [artifacts/campaign/matrix.json](matrix.json)",
        "Graph directory: [ideas/gaia/demo-gaia](../../ideas/gaia/demo-gaia)",
        "Close prior: [arXiv:2411.18257](https://arxiv.org/abs/2411.18257), "
        "[DOI:10.1000/demo](https://doi.org/10.1000/demo), "
        "[INSPIRE recid 2853359](https://inspirehep.net/literature/2853359).",
        "[artifacts/campaign/matrix.json](matrix.json) and "
        "[arXiv:2411.18257](https://arxiv.org/abs/2411.18257) are still clickable.",
        "[Already linked arXiv:2411.18257](https://arxiv.org/abs/2411.18257)",
    ]


def test_reports_broken_local_markdown_links(tmp_path: Path) -> None:
    project = tmp_path / "project"
    report_dir = project / "artifacts" / "campaign"
    report_dir.mkdir(parents=True)
    report = report_dir / "posterior_report.md"
    report.write_text(
        "\n".join(
            [
                "[Missing starmap](ideas/gaia/demo-gaia/starmap.html)",
                "[External](https://example.org/ok)",
                "[Anchor](#close-prior-matrix)",
            ]
        ),
        encoding="utf-8",
    )

    issues = links.report_link_issues(report, project)

    assert len(issues) == 1
    assert "local link target does not exist" in issues[0]
    assert "ideas/gaia/demo-gaia/starmap.html" in issues[0]
