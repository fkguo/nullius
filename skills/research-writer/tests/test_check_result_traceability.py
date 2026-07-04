"""Tests for the fail-closed manuscript result-traceability gate."""
from __future__ import annotations

import hashlib
import importlib.util
import json
import subprocess
import sys
from pathlib import Path

_MOD = Path(__file__).resolve().parent.parent / "scripts" / "bin" / "check_result_traceability.py"
_spec = importlib.util.spec_from_file_location("check_result_traceability", _MOD)
cpb = importlib.util.module_from_spec(_spec)
sys.modules[_spec.name] = cpb  # dataclasses on 3.12 needs the module registered
_spec.loader.exec_module(cpb)


def _sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _write_manifest(paper: Path, entries: list[dict], version: int = 1) -> Path:
    p = paper / "traceability_manifest.json"
    p.write_text(json.dumps({"version": version, "entries": entries}, indent=2), encoding="utf-8")
    return p


def _paper(tmp_path: Path, tex: str) -> Path:
    paper = tmp_path / "paper"
    (paper / "figures").mkdir(parents=True)
    (paper / "main.tex").write_text(tex, encoding="utf-8")
    return paper


_GREEN_TEX = r"""
\documentclass{revtex4-2}
\begin{document}
The fitted width is 12.3(4) units. % origin: num:fitted-width
\begin{figure}
  \includegraphics[width=0.8\linewidth]{figures/scan.pdf}
\end{figure}
\end{document}
"""


def _green_paper(tmp_path: Path) -> tuple[Path, Path]:
    paper = _paper(tmp_path, _GREEN_TEX)
    fig = paper / "figures" / "scan.pdf"
    fig.write_bytes(b"%PDF-1.4 fake figure bytes\n")
    manifest = _write_manifest(
        paper,
        [
            {
                "id": "fig:scan",
                "kind": "figure",
                "artifact": "figures/scan.pdf",
                "run_id": "M1-r2",
                "code_rev": "abc123def456",
                "env_fingerprint": "lockfile-sha256:deadbeef",
                "checksum": "sha256:" + _sha256(fig),
            },
            {
                "id": "num:fitted-width",
                "kind": "number",
                "run_id": "M1-r2",
                "code_rev": "abc123def456",
                "env_fingerprint": "lockfile-sha256:deadbeef",
                "notes": "headline width from summary.json",
            },
        ],
    )
    return paper, manifest


def _run_cli(args: list[str]) -> subprocess.CompletedProcess:
    return subprocess.run(
        [sys.executable, str(_MOD), *args],
        capture_output=True,
        text=True,
        check=False,
    )


# --- green path ---

def test_green_path_ready(tmp_path):
    paper, manifest = _green_paper(tmp_path)
    res = cpb.evaluate(
        tex_files=[paper / "main.tex"],
        manifest_path=manifest,
        paper_root=paper,
        exempt_ids=set(),
        strict_unused=True,
    )
    assert res.ready
    assert res.violations == []
    assert res.n_figure_entries == 1
    assert res.n_number_entries == 1


def test_green_path_cli_exit_zero_and_report(tmp_path):
    paper, _ = _green_paper(tmp_path)
    report = tmp_path / "out" / "traceability_report.md"
    r = _run_cli(["--root", str(paper), "--report", str(report)])
    assert r.returncode == 0, r.stdout + r.stderr
    assert "READY" in r.stdout
    text = report.read_text(encoding="utf-8")
    assert "- status: READY" in text


# --- fail-closed: manifest problems ---

def test_missing_manifest_is_not_ready(tmp_path):
    paper = _paper(tmp_path, _GREEN_TEX)
    r = _run_cli(["--root", str(paper)])
    assert r.returncode == 2
    assert "NOT_READY" in r.stdout
    assert "manifest_missing" in r.stdout


def test_missing_manifest_not_exemptible(tmp_path):
    paper = _paper(tmp_path, _GREEN_TEX)
    res = cpb.evaluate(
        tex_files=[paper / "main.tex"],
        manifest_path=paper / "traceability_manifest.json",
        paper_root=paper,
        exempt_ids={"num:fitted-width", "figures/scan.pdf", "manifest_missing"},
        strict_unused=True,
    )
    assert not res.ready
    assert any(v.kind == "manifest_missing" for v in res.violations)


def test_invalid_json_manifest(tmp_path):
    paper = _paper(tmp_path, _GREEN_TEX)
    (paper / "traceability_manifest.json").write_text("{not json", encoding="utf-8")
    r = _run_cli(["--root", str(paper)])
    assert r.returncode == 2
    assert "manifest_invalid" in r.stdout


def test_wrong_manifest_version_rejected(tmp_path):
    paper = _paper(tmp_path, _GREEN_TEX)
    _write_manifest(paper, [], version=2)
    res = cpb.evaluate(
        tex_files=[paper / "main.tex"],
        manifest_path=paper / "traceability_manifest.json",
        paper_root=paper,
        exempt_ids=set(),
        strict_unused=True,
    )
    assert any(v.kind == "manifest_invalid" for v in res.violations)


# --- fail-closed: incomplete / malformed entries ---

def test_missing_required_run_fields(tmp_path):
    paper, manifest = _green_paper(tmp_path)
    data = json.loads(manifest.read_text(encoding="utf-8"))
    for ent in data["entries"]:
        if ent["kind"] == "number":
            del ent["env_fingerprint"]
            ent["code_rev"] = "   "  # whitespace-only must not count
    manifest.write_text(json.dumps(data), encoding="utf-8")
    res = cpb.evaluate(
        tex_files=[paper / "main.tex"],
        manifest_path=manifest,
        paper_root=paper,
        exempt_ids=set(),
        strict_unused=True,
    )
    kinds = [v.kind for v in res.violations]
    assert "missing_fields" in kinds
    v = next(v for v in res.violations if v.kind == "missing_fields")
    assert "env_fingerprint" in v.detail and "code_rev" in v.detail


def test_unknown_kind_and_duplicate_id(tmp_path):
    paper, manifest = _green_paper(tmp_path)
    data = json.loads(manifest.read_text(encoding="utf-8"))
    data["entries"].append(dict(data["entries"][1]))  # duplicate num:fitted-width
    data["entries"].append(
        {"id": "x:weird", "kind": "table", "run_id": "r", "code_rev": "c", "env_fingerprint": "e"}
    )
    manifest.write_text(json.dumps(data), encoding="utf-8")
    res = cpb.evaluate(
        tex_files=[paper / "main.tex"],
        manifest_path=manifest,
        paper_root=paper,
        exempt_ids=set(),
        strict_unused=True,
    )
    kinds = {v.kind for v in res.violations}
    assert "duplicate_id" in kinds
    assert "invalid_entry" in kinds


def test_number_entry_rejects_checksum_and_artifact(tmp_path):
    paper, manifest = _green_paper(tmp_path)
    data = json.loads(manifest.read_text(encoding="utf-8"))
    for ent in data["entries"]:
        if ent["kind"] == "number":
            ent["checksum"] = "sha256:" + "0" * 64
            ent["artifact"] = "figures/scan.pdf"
    manifest.write_text(json.dumps(data), encoding="utf-8")
    res = cpb.evaluate(
        tex_files=[paper / "main.tex"],
        manifest_path=manifest,
        paper_root=paper,
        exempt_ids=set(),
        strict_unused=True,
    )
    details = "\n".join(v.detail for v in res.violations if v.kind == "invalid_entry")
    assert "checksum" in details
    assert "artifact" in details


# --- checksum verification ---

def test_checksum_mismatch(tmp_path):
    paper, manifest = _green_paper(tmp_path)
    (paper / "figures" / "scan.pdf").write_bytes(b"regenerated with different bytes")
    r = _run_cli(["--root", str(paper)])
    assert r.returncode == 2
    assert "checksum_mismatch" in r.stdout


def test_checksum_artifact_missing_on_disk(tmp_path):
    paper, manifest = _green_paper(tmp_path)
    (paper / "figures" / "scan.pdf").unlink()
    res = cpb.evaluate(
        tex_files=[paper / "main.tex"],
        manifest_path=manifest,
        paper_root=paper,
        exempt_ids=set(),
        strict_unused=True,
    )
    assert any(v.kind == "artifact_missing" for v in res.violations)


def test_bad_checksum_format_is_invalid_entry(tmp_path):
    paper, manifest = _green_paper(tmp_path)
    data = json.loads(manifest.read_text(encoding="utf-8"))
    for ent in data["entries"]:
        if ent["kind"] == "figure":
            ent["checksum"] = "md5:abcd"
    manifest.write_text(json.dumps(data), encoding="utf-8")
    res = cpb.evaluate(
        tex_files=[paper / "main.tex"],
        manifest_path=manifest,
        paper_root=paper,
        exempt_ids=set(),
        strict_unused=True,
    )
    assert any(v.kind == "invalid_entry" and "checksum" in v.detail for v in res.violations)


def test_figure_without_checksum_passes_without_file_hashing(tmp_path):
    paper, manifest = _green_paper(tmp_path)
    data = json.loads(manifest.read_text(encoding="utf-8"))
    for ent in data["entries"]:
        ent.pop("checksum", None)
    manifest.write_text(json.dumps(data), encoding="utf-8")
    (paper / "figures" / "scan.pdf").unlink()  # no checksum => no on-disk verification
    res = cpb.evaluate(
        tex_files=[paper / "main.tex"],
        manifest_path=manifest,
        paper_root=paper,
        exempt_ids=set(),
        strict_unused=True,
    )
    assert res.ready, [v.detail for v in res.violations]


def test_checksum_resolves_against_paper_root_not_manifest_dir(tmp_path):
    # With an out-of-tree --manifest, artifacts must hash the bytes inside the
    # paper root (what LaTeX embeds), not a same-named file next to the manifest.
    paper, _ = _green_paper(tmp_path)
    elsewhere = tmp_path / "elsewhere"
    (elsewhere / "figures").mkdir(parents=True)
    manifest = elsewhere / "traceability_manifest.json"
    manifest.write_text((paper / "traceability_manifest.json").read_text(encoding="utf-8"), encoding="utf-8")
    # Decoy next to the manifest with DIFFERENT bytes: must not be consulted.
    (elsewhere / "figures" / "scan.pdf").write_bytes(b"decoy bytes, not the manuscript figure")
    res = cpb.evaluate(
        tex_files=[paper / "main.tex"],
        manifest_path=manifest,
        paper_root=paper,
        exempt_ids=set(),
        strict_unused=True,
    )
    assert res.ready, [v.detail for v in res.violations]
    # Inverse: corrupt the paper-root bytes; the decoy still matches the
    # manifest checksum, but the gate must report the mismatch.
    (paper / "figures" / "scan.pdf").write_bytes(b"decoy bytes, not the manuscript figure")
    res2 = cpb.evaluate(
        tex_files=[paper / "main.tex"],
        manifest_path=manifest,
        paper_root=paper,
        exempt_ids=set(),
        strict_unused=True,
    )
    assert any(v.kind == "checksum_mismatch" for v in res2.violations), [v.detail for v in res2.violations]


def test_symlink_escaping_paper_root_is_violation(tmp_path):
    # Lexical containment cannot stop a symlink; the resolved artifact must
    # stay inside the paper root even when the outside bytes match the checksum.
    outside = tmp_path / "outside.pdf"
    outside.write_bytes(b"bytes kept outside the paper root")
    paper = _paper(tmp_path, "\\includegraphics{figures/scan.pdf}\n")
    (paper / "figures" / "scan.pdf").symlink_to(outside)
    _write_manifest(
        paper,
        [
            {"id": "fig:scan", "kind": "figure", "artifact": "figures/scan.pdf",
             "run_id": "r", "code_rev": "c", "env_fingerprint": "e",
             "checksum": _sha256(outside)},
        ],
    )
    res = cpb.evaluate(
        tex_files=[paper / "main.tex"],
        manifest_path=paper / "traceability_manifest.json",
        paper_root=paper,
        exempt_ids=set(),
        strict_unused=True,
    )
    kinds = [v.kind for v in res.violations]
    assert "artifact_outside_root" in kinds
    assert "checksum_mismatch" not in kinds  # no out-of-root hashing happened


def test_symlink_escape_is_violation_even_without_checksum(tmp_path):
    # Resolved containment applies to every bound artifact that exists on
    # disk, checksummed or not: the delivered paper directory must carry the
    # real bytes.
    outside = tmp_path / "outside.pdf"
    outside.write_bytes(b"bytes kept outside the paper root")
    paper = _paper(tmp_path, "\\includegraphics{figures/scan.pdf}\n")
    (paper / "figures" / "scan.pdf").symlink_to(outside)
    _write_manifest(
        paper,
        [
            {"id": "fig:scan", "kind": "figure", "artifact": "figures/scan.pdf",
             "run_id": "r", "code_rev": "c", "env_fingerprint": "e"},
        ],
    )
    res = cpb.evaluate(
        tex_files=[paper / "main.tex"],
        manifest_path=paper / "traceability_manifest.json",
        paper_root=paper,
        exempt_ids=set(),
        strict_unused=True,
    )
    assert any(v.kind == "artifact_outside_root" for v in res.violations)


def test_symlink_inside_paper_root_is_allowed(tmp_path):
    paper = _paper(tmp_path, "\\includegraphics{figures/scan.pdf}\n")
    real = paper / "figures" / "real_scan.pdf"
    real.write_bytes(b"real in-root bytes")
    (paper / "figures" / "scan.pdf").symlink_to(real)
    _write_manifest(
        paper,
        [
            {"id": "fig:scan", "kind": "figure", "artifact": "figures/scan.pdf",
             "run_id": "r", "code_rev": "c", "env_fingerprint": "e",
             "checksum": _sha256(real)},
        ],
    )
    res = cpb.evaluate(
        tex_files=[paper / "main.tex"],
        manifest_path=paper / "traceability_manifest.json",
        paper_root=paper,
        exempt_ids=set(),
        strict_unused=True,
    )
    assert res.ready, [v.detail for v in res.violations]


# --- unbound references ---

def test_unbound_figure_and_anchor(tmp_path):
    paper = _paper(tmp_path, _GREEN_TEX)
    _write_manifest(paper, [])
    res = cpb.evaluate(
        tex_files=[paper / "main.tex"],
        manifest_path=paper / "traceability_manifest.json",
        paper_root=paper,
        exempt_ids=set(),
        strict_unused=True,
    )
    kinds = {v.kind for v in res.violations}
    assert "unbound_figure" in kinds
    assert "unbound_anchor" in kinds


def test_anchor_kind_mismatch(tmp_path):
    paper = _paper(
        tmp_path,
        "Value 3.14 % origin: fig:scan\n",
    )
    _write_manifest(
        paper,
        [
            {
                "id": "fig:scan",
                "kind": "figure",
                "artifact": "figures/scan.pdf",
                "run_id": "r",
                "code_rev": "c",
                "env_fingerprint": "e",
            }
        ],
    )
    res = cpb.evaluate(
        tex_files=[paper / "main.tex"],
        manifest_path=paper / "traceability_manifest.json",
        paper_root=paper,
        exempt_ids=set(),
        strict_unused=True,
    )
    kinds = {v.kind for v in res.violations}
    assert "kind_mismatch" in kinds


# --- anchor / includegraphics parsing edges ---

def test_commented_out_includegraphics_is_ignored(tmp_path):
    paper = _paper(
        tmp_path,
        "% \\includegraphics{figures/old.pdf}\nplain text\n",
    )
    _write_manifest(paper, [])
    res = cpb.evaluate(
        tex_files=[paper / "main.tex"],
        manifest_path=paper / "traceability_manifest.json",
        paper_root=paper,
        exempt_ids=set(),
        strict_unused=True,
    )
    assert res.ready, [v.detail for v in res.violations]


def test_escaped_percent_is_not_an_anchor_or_comment(tmp_path):
    tex = tmp_path / "t.tex"
    tex.write_text(
        "a 5\\% origin: not-an-anchor\n"
        "b \\includegraphics{figures/real.pdf} % origin: from-trailing-comment\n",
        encoding="utf-8",
    )
    graphics, anchors = cpb.scan_tex_file(tex)
    assert [g.path_as_written for g in graphics] == ["figures/real.pdf"]
    # line 1: the '%' is escaped => literal text, not a comment, no anchor;
    # line 2: the trailing comment is a valid anchor.
    assert [a.anchor_id for a in anchors] == ["from-trailing-comment"]


def test_multiline_includegraphics_with_percent_continuation_is_bound(tmp_path):
    # A trailing '%' line-continuation before the brace group is a common
    # LaTeX idiom; the figure must not silently escape the gate.
    paper = _paper(
        tmp_path,
        "\\includegraphics[width=0.8\\linewidth]%\n{figures/split.pdf}\n",
    )
    _write_manifest(paper, [])
    res = cpb.evaluate(
        tex_files=[paper / "main.tex"],
        manifest_path=paper / "traceability_manifest.json",
        paper_root=paper,
        exempt_ids=set(),
        strict_unused=True,
    )
    unbound = [v for v in res.violations if v.kind == "unbound_figure"]
    assert len(unbound) == 1
    assert "figures/split.pdf" in unbound[0].detail


def test_multiline_includegraphics_binds_to_manifest_entry(tmp_path):
    paper = _paper(
        tmp_path,
        "\\includegraphics%\n[width=\\linewidth]%\n{figures/split.pdf}\n",
    )
    _write_manifest(
        paper,
        [
            {"id": "fig:split", "kind": "figure", "artifact": "figures/split.pdf",
             "run_id": "r", "code_rev": "c", "env_fingerprint": "e"},
        ],
    )
    res = cpb.evaluate(
        tex_files=[paper / "main.tex"],
        manifest_path=paper / "traceability_manifest.json",
        paper_root=paper,
        exempt_ids=set(),
        strict_unused=True,
    )
    assert res.ready, [v.detail for v in res.violations]


def test_double_percent_anchor_and_trailing_prose(tmp_path):
    tex = tmp_path / "t.tex"
    tex.write_text(
        "x = 1.0 %% origin: num:x (from the final fit)\n",
        encoding="utf-8",
    )
    _, anchors = cpb.scan_tex_file(tex)
    assert [a.anchor_id for a in anchors] == ["num:x"]


def test_invalid_anchor_charset_flagged_and_not_exemptible(tmp_path):
    # A malformed anchor id can never name a manifest entry: structural parse
    # failure, never exemptible — even by the malformed token itself.
    paper = _paper(tmp_path, "v % origin: bad,id\n")
    _write_manifest(paper, [])
    res = cpb.evaluate(
        tex_files=[paper / "main.tex"],
        manifest_path=paper / "traceability_manifest.json",
        paper_root=paper,
        exempt_ids={"bad,id"},
        strict_unused=True,
    )
    bad = [v for v in res.violations if v.kind == "invalid_anchor"]
    assert len(bad) == 1
    assert bad[0].exemption_key is None


def test_empty_anchor_id_fails_closed_and_is_not_exemptible(tmp_path):
    paper = _paper(tmp_path, "v = 1.2 % origin:\n")
    _write_manifest(paper, [])
    res = cpb.evaluate(
        tex_files=[paper / "main.tex"],
        manifest_path=paper / "traceability_manifest.json",
        paper_root=paper,
        exempt_ids={""},  # even a (nonsensical) empty exemption cannot cover it
        strict_unused=True,
    )
    bad = [v for v in res.violations if v.kind == "invalid_anchor"]
    assert len(bad) == 1
    assert bad[0].exemption_key is None


def test_escaping_artifact_paths_rejected_and_never_bind(tmp_path):
    # Absolute and '..'-escaping artifact paths are invalid entries and are
    # excluded from binding, so the checksum can never be computed outside
    # the paper root.
    outside = tmp_path / "outside.pdf"
    outside.write_bytes(b"outside bytes")
    paper = _paper(tmp_path, "\\includegraphics{../outside.pdf}\n")
    _write_manifest(
        paper,
        [
            {"id": "fig:escape", "kind": "figure", "artifact": "../outside.pdf",
             "run_id": "r", "code_rev": "c", "env_fingerprint": "e",
             "checksum": _sha256(outside)},
            {"id": "fig:abs", "kind": "figure", "artifact": str(outside),
             "run_id": "r", "code_rev": "c", "env_fingerprint": "e"},
        ],
    )
    res = cpb.evaluate(
        tex_files=[paper / "main.tex"],
        manifest_path=paper / "traceability_manifest.json",
        paper_root=paper,
        exempt_ids=set(),
        strict_unused=True,
    )
    kinds = [v.kind for v in res.violations]
    assert kinds.count("invalid_entry") == 2  # both escaping artifacts flagged
    assert "unbound_figure" in kinds  # the \includegraphics never binds
    assert "checksum_mismatch" not in kinds  # and no out-of-root hashing happened


def test_extensionless_includegraphics_matches_manifest_artifact(tmp_path):
    paper = _paper(tmp_path, "\\includegraphics{figures/scan}\n")
    fig = paper / "figures" / "scan.pdf"
    fig.write_bytes(b"bytes")
    _write_manifest(
        paper,
        [
            {
                "id": "fig:scan",
                "kind": "figure",
                "artifact": "figures/scan.pdf",
                "run_id": "r",
                "code_rev": "c",
                "env_fingerprint": "e",
                "checksum": _sha256(fig),  # bare hex accepted too
            }
        ],
    )
    res = cpb.evaluate(
        tex_files=[paper / "main.tex"],
        manifest_path=paper / "traceability_manifest.json",
        paper_root=paper,
        exempt_ids=set(),
        strict_unused=True,
    )
    assert res.ready, [v.detail for v in res.violations]


def test_ambiguous_extensionless_match_is_violation(tmp_path):
    paper = _paper(tmp_path, "\\includegraphics{figures/scan}\n")
    _write_manifest(
        paper,
        [
            {"id": "fig:a", "kind": "figure", "artifact": "figures/scan.pdf",
             "run_id": "r", "code_rev": "c", "env_fingerprint": "e"},
            {"id": "fig:b", "kind": "figure", "artifact": "figures/scan.png",
             "run_id": "r", "code_rev": "c", "env_fingerprint": "e"},
        ],
    )
    res = cpb.evaluate(
        tex_files=[paper / "main.tex"],
        manifest_path=paper / "traceability_manifest.json",
        paper_root=paper,
        exempt_ids=set(),
        strict_unused=True,
    )
    kinds = [v.kind for v in res.violations]
    assert "ambiguous_figure_binding" in kinds
    # the ambiguity is the single actionable violation; candidates are not
    # additionally reported as unused entries
    assert "unused_entry" not in kinds


def test_ambiguous_same_path_match_is_violation(tmp_path):
    paper = _paper(tmp_path, "\\includegraphics{figures/scan.pdf}\n")
    _write_manifest(
        paper,
        [
            {"id": "fig:a", "kind": "figure", "artifact": "figures/scan.pdf",
             "run_id": "r", "code_rev": "c", "env_fingerprint": "e"},
            {"id": "fig:b", "kind": "figure", "artifact": "figures/scan.pdf",
             "run_id": "r2", "code_rev": "c2", "env_fingerprint": "e2"},
        ],
    )
    res = cpb.evaluate(
        tex_files=[paper / "main.tex"],
        manifest_path=paper / "traceability_manifest.json",
        paper_root=paper,
        exempt_ids=set(),
        strict_unused=True,
    )
    assert any(v.kind == "ambiguous_figure_binding" for v in res.violations)


# --- unused entries: strict under --root, warning under --tex ---

def test_unused_entries_strict_in_root_mode(tmp_path):
    paper = _paper(tmp_path, "no figures, no anchors\n")
    _write_manifest(
        paper,
        [
            {"id": "num:orphan", "kind": "number",
             "run_id": "r", "code_rev": "c", "env_fingerprint": "e"},
            {"id": "fig:orphan", "kind": "figure", "artifact": "figures/x.pdf",
             "run_id": "r", "code_rev": "c", "env_fingerprint": "e"},
        ],
    )
    res = cpb.evaluate(
        tex_files=[paper / "main.tex"],
        manifest_path=paper / "traceability_manifest.json",
        paper_root=paper,
        exempt_ids=set(),
        strict_unused=True,
    )
    assert sum(1 for v in res.violations if v.kind == "unused_entry") == 2


def test_unused_entries_warn_only_in_tex_mode(tmp_path):
    paper = _paper(tmp_path, "no figures, no anchors\n")
    _write_manifest(
        paper,
        [
            {"id": "num:orphan", "kind": "number",
             "run_id": "r", "code_rev": "c", "env_fingerprint": "e"},
        ],
    )
    r = _run_cli(["--tex", str(paper / "main.tex")])
    assert r.returncode == 0, r.stdout + r.stderr
    assert "unused_entry" in r.stdout
    assert "READY" in r.stdout


# --- exemptions ---

def test_exemptions_cover_exactly_listed_ids(tmp_path):
    paper = _paper(tmp_path, _GREEN_TEX)
    _write_manifest(paper, [])
    res = cpb.evaluate(
        tex_files=[paper / "main.tex"],
        manifest_path=paper / "traceability_manifest.json",
        paper_root=paper,
        exempt_ids={"figures/scan.pdf", "num:fitted-width"},
        strict_unused=True,
    )
    assert res.ready
    assert {v.kind for v in res.exempted} == {"unbound_figure", "unbound_anchor"}


def test_partial_exemption_still_fails(tmp_path):
    paper = _paper(tmp_path, _GREEN_TEX)
    _write_manifest(paper, [])
    res = cpb.evaluate(
        tex_files=[paper / "main.tex"],
        manifest_path=paper / "traceability_manifest.json",
        paper_root=paper,
        exempt_ids={"figures/scan.pdf"},
        strict_unused=True,
    )
    assert not res.ready
    assert any(v.kind == "unbound_anchor" for v in res.violations)


def test_wildcard_exemption_rejected_by_cli(tmp_path):
    paper, _ = _green_paper(tmp_path)
    r = _run_cli(["--root", str(paper), "--exempt-id", "*"])
    assert r.returncode == 2
    assert "no wildcards" in (r.stdout + r.stderr)


def test_exempt_file_parsing_and_unused_exemption_warning(tmp_path):
    paper, _ = _green_paper(tmp_path)
    ex = tmp_path / "exempt.txt"
    ex.write_text("# baseline exemptions\nnum:never-used  # stale token\n", encoding="utf-8")
    r = _run_cli(["--root", str(paper), "--exempt-file", str(ex)])
    assert r.returncode == 0, r.stdout + r.stderr
    assert "unused_exemption" in r.stdout


def test_cli_missing_fields_exit_2_and_exemption_restores_ready(tmp_path):
    paper, manifest = _green_paper(tmp_path)
    data = json.loads(manifest.read_text(encoding="utf-8"))
    for ent in data["entries"]:
        if ent["kind"] == "number":
            del ent["run_id"]
    manifest.write_text(json.dumps(data), encoding="utf-8")
    r = _run_cli(["--root", str(paper)])
    assert r.returncode == 2
    assert "missing_fields" in r.stdout and "NOT_READY" in r.stdout
    # exempting exactly that id restores READY (exit 0) and logs the exemption
    r2 = _run_cli(["--root", str(paper), "--exempt-id", "num:fitted-width"])
    assert r2.returncode == 0, r2.stdout + r2.stderr
    assert "READY" in r2.stdout and "exempted" in r2.stdout


def test_cli_invalid_entry_shape_exit_2(tmp_path):
    paper, manifest = _green_paper(tmp_path)
    data = json.loads(manifest.read_text(encoding="utf-8"))
    data["entries"].append("not-an-object")
    manifest.write_text(json.dumps(data), encoding="utf-8")
    r = _run_cli(["--root", str(paper)])
    assert r.returncode == 2
    assert "invalid_entry" in r.stdout


# --- report file ---

def test_not_ready_report_written_atomically(tmp_path):
    paper = _paper(tmp_path, _GREEN_TEX)
    report = tmp_path / "report.md"
    r = _run_cli(["--root", str(paper), "--report", str(report)])
    assert r.returncode == 2
    text = report.read_text(encoding="utf-8")
    assert "- status: NOT_READY" in text
    assert "manifest_missing" in text
    leftovers = [p for p in tmp_path.iterdir() if p.name.startswith("report.md.tmp")]
    assert leftovers == []
