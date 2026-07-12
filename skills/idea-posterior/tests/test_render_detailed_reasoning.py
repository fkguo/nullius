"""Regression tests for the standalone detailed-reasoning browser page."""

from __future__ import annotations

import json
import re
import shutil
import subprocess
import sys
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import unquote, urlsplit

import pytest

import render_detailed_reasoning as rdr

SCRIPT = (
    Path(__file__).resolve().parent.parent / "scripts" / "render_detailed_reasoning.py"
)
GRAPH_SCRIPT = (
    Path(__file__).resolve().parent.parent / "scripts" / "render_argument_graph.py"
)


class PageProbe(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.tags: list[str] = []
        self.ids: set[str] = set()
        self.hrefs: list[str] = []
        self.sources: list[str] = []
        self.attrs: list[tuple[str, str | None]] = []

    def handle_starttag(self, tag: str, attrs) -> None:
        self.tags.append(tag)
        self.attrs.extend(attrs)
        values = dict(attrs)
        if values.get("id"):
            self.ids.add(values["id"])
        if values.get("href"):
            self.hrefs.append(values["href"])
        if values.get("src"):
            self.sources.append(values["src"])


def browser_tools() -> tuple[str, str, str]:
    uv = shutil.which("uv")
    pandoc = shutil.which("pandoc")
    mmdc = shutil.which("mmdc")
    if not uv or not pandoc or not mmdc:
        pytest.skip(
            "optional detailed-page dependencies unavailable: need uv, Pandoc, and mmdc"
        )
    return uv, pandoc, mmdc


def write_version_wrapper(tmp_path: Path, real_tool: str, version_banner: str) -> Path:
    wrapper = tmp_path / "pandoc-version-wrapper"
    wrapper.write_text(
        "\n".join(
            [
                f"#!{sys.executable}",
                "import os",
                "import sys",
                f"REAL_TOOL = {real_tool!r}",
                f"VERSION_BANNER = {version_banner!r}",
                "if sys.argv[1:] == ['--version']:",
                "    print(VERSION_BANNER)",
                "    raise SystemExit(0)",
                "os.execv(REAL_TOOL, [REAL_TOOL, *sys.argv[1:]])",
                "",
            ]
        ),
        encoding="utf-8",
    )
    wrapper.chmod(0o755)
    return wrapper


def write_package(tmp_path: Path, markdown: str) -> Path:
    package = tmp_path / "generic-browser-gaia"
    docs = package / "docs"
    gaia = package / ".gaia"
    docs.mkdir(parents=True)
    gaia.mkdir()
    (docs / rdr.MARKDOWN_NAME).write_text(markdown, encoding="utf-8")
    (docs / "reference-note.md").write_text("# Safe note\n", encoding="utf-8")
    knowledge_id = "github:generic_browser::MixedCase_Claim"
    (gaia / "beliefs.json").write_text(
        json.dumps(
            {
                "beliefs": [
                    {
                        "knowledge_id": knowledge_id,
                        "label": "MixedCase_Claim",
                        "belief": 0.75,
                    }
                ]
            }
        ),
        encoding="utf-8",
    )
    (gaia / "ir.json").write_text(
        json.dumps(
            {
                "ir_hash": "sha256:" + "ab" * 32,
                "namespace": "github:generic_browser",
                "package_name": "generic-browser-gaia",
                "knowledges": [
                    {
                        "id": knowledge_id,
                        "label": "MixedCase_Claim",
                        "type": "claim",
                        "content": "A generic claim with a browser-readable explanation.",
                        "declaration_index": 0,
                        "metadata": {},
                    }
                ],
                "strategies": [],
            }
        ),
        encoding="utf-8",
    )
    return package


def run_renderer(
    package: Path, uv: str, pandoc: str, mmdc: str
) -> subprocess.CompletedProcess:
    return subprocess.run(
        [
            uv,
            "run",
            "--quiet",
            "--script",
            str(SCRIPT),
            "--package",
            str(package),
            "--pandoc-bin",
            pandoc,
            "--mmdc-bin",
            mmdc,
        ],
        capture_output=True,
        text=True,
        timeout=180,
        check=False,
    )


def run_graph(package: Path) -> dict:
    result = subprocess.run(
        [sys.executable, str(GRAPH_SCRIPT), "--package", str(package)],
        capture_output=True,
        text=True,
        timeout=120,
        check=False,
    )
    assert result.returncode == 0, result.stderr
    page = (package / "argument-graph.html").read_text(encoding="utf-8")
    match = re.search(
        r'<script id="graph-data" type="application/json">(.*?)</script>',
        page,
        re.S,
    )
    assert match
    return json.loads(match.group(1))


def test_static_page_renders_math_mermaid_links_and_strips_active_content(
    tmp_path, fixtures_dir
) -> None:
    uv, pandoc, mmdc = browser_tools()
    markdown = (fixtures_dir / "detailed_reasoning_sample.md").read_text(
        encoding="utf-8"
    )
    package = write_package(tmp_path, markdown)
    banner_path = "/" + "runtime/tool-wrapper/pandoc"
    banner = f"wrapper 1.2.3 at {banner_path}: pandoc 3.6.4"
    pandoc_wrapper = write_version_wrapper(tmp_path, pandoc, banner)

    first = run_renderer(package, uv, str(pandoc_wrapper), mmdc)
    assert first.returncode == 0, first.stderr
    docs = package / "docs"
    html_path = docs / rdr.HTML_NAME
    manifest_path = docs / rdr.MANIFEST_NAME
    first_html = html_path.read_bytes()
    first_manifest = manifest_path.read_bytes()
    page = first_html.decode("utf-8")
    manifest = json.loads(first_manifest)

    probe = PageProbe()
    probe.feed(page)
    assert "math" in probe.tags
    assert "MixedCase_Claim" in probe.ids
    assert "reference-note.md" in probe.hrefs
    assert "https://example.org/reference" in probe.hrefs
    assert all(
        href.lower().startswith(("http://", "https://", "mailto:")) or ":" not in href
        for href in probe.hrefs
    )
    assert len(probe.sources) == 1
    assert probe.sources[0].startswith("data:image/svg+xml;base64,")
    assert "script" not in probe.tags
    assert all(not name.lower().startswith("on") for name, _value in probe.attrs)
    assert "javascript:" not in page.lower()
    assert "```mermaid" not in page
    assert '<math display="inline"' in page
    assert '<math display="block"' in page
    assert page.count('id="MixedCase_Claim"') == 1
    assert "render-meta" not in page

    beliefs = (package / ".gaia" / "beliefs.json").read_bytes()
    source = (docs / rdr.MARKDOWN_NAME).read_bytes()
    assert manifest["artifact"] == rdr.ARTIFACT
    assert manifest["beliefs_sha256"] == rdr.sha256_bytes(beliefs)
    assert manifest["markdown_sha256"] == rdr.sha256_bytes(source)
    assert manifest["html_sha256"] == rdr.sha256_bytes(first_html)
    assert manifest["fragments"] == ["MixedCase_Claim"]
    assert manifest["renderer"] == {
        "mermaid_cli": rdr._tool_version(mmdc, "Mermaid CLI", 30),
        "nh3": rdr.NH3_PIN,
        "pandoc": "3.6.4",
    }
    assert manifest["beliefs_sha256"] not in page
    assert manifest["markdown_sha256"] not in page
    assert manifest["html_sha256"] not in page
    assert "Pandoc" not in page
    assert "Mermaid CLI" not in page

    # Tool discovery paths and process-local temporary paths are transient;
    # only names/versions may be persisted.
    for forbidden in (
        str(Path(pandoc).resolve()),
        str(pandoc_wrapper.resolve()),
        str(Path(mmdc).resolve()),
        str(tmp_path),
        banner_path,
        "/" + "Users" + "/",
        "file://",
    ):
        assert forbidden not in page
        assert forbidden not in first_manifest.decode("utf-8")

    # Same inputs under the same recorded toolchain are byte-deterministic.
    second = run_renderer(package, uv, str(pandoc_wrapper), mmdc)
    assert second.returncode == 0, second.stderr
    assert html_path.read_bytes() == first_html
    assert manifest_path.read_bytes() == first_manifest


def _raw_anchor(label: str) -> dict:
    return {
        "t": "Para",
        "c": [
            {"t": "RawInline", "c": ["html", f'<a id="{label}">']},
            {"t": "RawInline", "c": ["html", "</a>"]},
        ],
    }


def _header(label: str, automatic_id: str, *, root: bool = False) -> dict:
    inlines = [{"t": "Str", "c": label}]
    if root:
        inlines.extend([{"t": "Space"}, {"t": "Str", "c": "★"}])
    return {"t": "Header", "c": [4, [automatic_id, [], []], inlines]}


def test_explicit_anchor_selects_real_gaia_root_duplicate_and_ignores_later_heading() -> (
    None
):
    introduction = _header("worth", "worth-", root=True)
    node_heading = _header("worth", "worth--1", root=True)
    enriched_heading = _header("worth", "worth--2", root=True)
    document = {
        "blocks": [
            introduction,
            _raw_anchor("worth"),
            node_heading,
            enriched_heading,
        ]
    }
    assert rdr._assign_exact_fragment_ids(document, {"worth"}) == {"worth"}
    assert introduction["c"][1][0] == "worth-"
    assert node_heading["c"][1][0] == "worth"
    assert enriched_heading["c"][1][0] == "worth--2"


@pytest.mark.parametrize("failure", ("missing", "duplicate", "mismatch"))
def test_ambiguous_or_unpaired_explicit_anchor_fails_closed(failure) -> None:
    heading = _header("MixedCase_Claim", "mixedcase_claim")
    if failure == "missing":
        blocks = [heading]
    elif failure == "duplicate":
        blocks = [
            _raw_anchor("MixedCase_Claim"),
            heading,
            _raw_anchor("MixedCase_Claim"),
            _header("MixedCase_Claim", "mixedcase_claim-1"),
        ]
    else:
        blocks = [
            _raw_anchor("MixedCase_Claim"),
            _header("Different_Claim", "different_claim"),
        ]
    document = {"blocks": blocks}
    assert rdr._assign_exact_fragment_ids(document, {"MixedCase_Claim"}) == set()


@pytest.mark.parametrize("event_name", ("onclick", "onfocus", "onbegin"))
def test_mermaid_svg_rejects_every_event_attribute(
    tmp_path, monkeypatch, event_name
) -> None:
    svg = f'<svg xmlns="http://www.w3.org/2000/svg"><g {event_name}="run()"/></svg>'
    monkeypatch.setattr(rdr, "_run", lambda *_args, **_kwargs: svg.encode())
    with pytest.raises(RuntimeError, match="active content"):
        rdr._render_mermaid(
            "flowchart LR\n  A --> B",
            mmdc="mmdc",
            config_path=tmp_path / "config.json",
            index=0,
            timeout=1,
        )


def test_unparseable_tool_version_fails_closed(monkeypatch) -> None:
    monkeypatch.setattr(rdr, "_run", lambda *_args, **_kwargs: b"unknown\n")
    with pytest.raises(RuntimeError, match="unrecognized version banner"):
        rdr._tool_version("pandoc", "Pandoc", 1)


def test_post_edit_requires_html_rerender_before_graph_link_returns(
    tmp_path, fixtures_dir
) -> None:
    uv, pandoc, mmdc = browser_tools()
    package = write_package(
        tmp_path,
        (fixtures_dir / "detailed_reasoning_sample.md").read_text(encoding="utf-8"),
    )
    result = run_renderer(package, uv, pandoc, mmdc)
    assert result.returncode == 0, result.stderr
    node_id = "github:generic_browser::MixedCase_Claim"
    href = run_graph(package)["nodes"][node_id]["doc_href"]
    assert href == "docs/detailed-reasoning.html#MixedCase_Claim"

    # This is the direct-file navigation contract: the graph's package-relative
    # URL resolves from argument-graph.html to the standalone sibling document,
    # and its exact case-preserving fragment exists in that document.
    parts = urlsplit(href)
    assert not parts.scheme and not parts.netloc
    local_target = (package / unquote(parts.path)).resolve()
    assert local_target == (package / "docs" / rdr.HTML_NAME).resolve()
    probe = PageProbe()
    probe.feed(local_target.read_text(encoding="utf-8"))
    assert unquote(parts.fragment) in probe.ids

    markdown = package / "docs" / rdr.MARKDOWN_NAME
    markdown.write_text(
        markdown.read_text(encoding="utf-8") + "\nA safe post-render clarification.\n",
        encoding="utf-8",
    )
    assert "doc_href" not in run_graph(package)["nodes"][node_id]

    rerender = run_renderer(package, uv, pandoc, mmdc)
    assert rerender.returncode == 0, rerender.stderr
    assert run_graph(package)["nodes"][node_id]["doc_href"] == (
        "docs/detailed-reasoning.html#MixedCase_Claim"
    )


@pytest.mark.parametrize("missing_tool", ("pandoc", "mmdc"))
def test_missing_required_renderer_invalidates_page_and_manifest(
    tmp_path, fixtures_dir, missing_tool
) -> None:
    uv, pandoc, mmdc = browser_tools()
    package = write_package(
        tmp_path,
        (fixtures_dir / "detailed_reasoning_sample.md").read_text(encoding="utf-8"),
    )
    assert run_renderer(package, uv, pandoc, mmdc).returncode == 0
    missing = str(tmp_path / f"missing-{missing_tool}")
    failed = run_renderer(
        package,
        uv,
        missing if missing_tool == "pandoc" else pandoc,
        missing if missing_tool == "mmdc" else mmdc,
    )
    assert failed.returncode == 2
    assert not (package / "docs" / rdr.HTML_NAME).exists()
    assert not (package / "docs" / rdr.MANIFEST_NAME).exists()
    assert (package / "docs" / rdr.MARKDOWN_NAME).is_file()


def test_machine_specific_markdown_is_refused_without_persisted_browser_output(
    tmp_path, fixtures_dir
) -> None:
    uv, pandoc, mmdc = browser_tools()
    machine_local = "/" + "Users" + "/example/private-note.md"
    markdown = (fixtures_dir / "detailed_reasoning_sample.md").read_text(
        encoding="utf-8"
    ) + f"\nA forbidden local reference: {machine_local}\n"
    package = write_package(tmp_path, markdown)
    result = run_renderer(package, uv, pandoc, mmdc)
    assert result.returncode == 2
    assert "machine-local" in result.stderr
    assert not (package / "docs" / rdr.HTML_NAME).exists()
    assert not (package / "docs" / rdr.MANIFEST_NAME).exists()


def test_docs_symlink_escape_preserves_external_sentinels(
    tmp_path, fixtures_dir, capsys
) -> None:
    package = write_package(
        tmp_path,
        (fixtures_dir / "detailed_reasoning_sample.md").read_text(encoding="utf-8"),
    )
    docs = package / "docs"
    external_docs = tmp_path / "external-docs"
    docs.rename(external_docs)
    try:
        docs.symlink_to(external_docs, target_is_directory=True)
    except OSError as exc:
        pytest.skip(f"directory symlinks unavailable: {exc}")
    html_sentinel = external_docs / rdr.HTML_NAME
    manifest_sentinel = external_docs / rdr.MANIFEST_NAME
    html_sentinel.write_text("external html sentinel\n", encoding="utf-8")
    manifest_sentinel.write_text("external manifest sentinel\n", encoding="utf-8")

    assert rdr.main(["--package", str(package)]) == 2
    captured = capsys.readouterr()
    assert "indirect package docs directory" in captured.err
    assert html_sentinel.read_text(encoding="utf-8") == "external html sentinel\n"
    assert manifest_sentinel.read_text(encoding="utf-8") == (
        "external manifest sentinel\n"
    )
