#!/usr/bin/env python3
"""
check_result_traceability.py

Deterministic, fail-closed result-traceability gate for manuscript deliverables.

Goal: every result that enters the manuscript — each included figure and each
number annotated as a result value — must be machine-traceable to the run that
produced it (run id + code revision + environment fingerprint), via a
traceability manifest (default: traceability_manifest.json next to the scanned
manuscript).

What is checked (all deterministic):
- Every \\includegraphics target in the scanned .tex files must have a
  manifest entry with kind="figure" whose "artifact" path matches the path as
  written in the manuscript (extension-optional). If the entry records a
  checksum, the artifact file on disk must match it.
- Every result-number anchor in the manuscript — a LaTeX comment of the form
  `% origin: <id>` placed adjacent to the reported value — must resolve to
  a manifest entry with kind="number".
- Every matched entry must carry non-empty run_id, code_rev and
  env_fingerprint (all three; no partial credit).
- In --root mode (the intended delivery-gate invocation, scanning the whole
  paper directory) manifest entries that bind to nothing in the manuscript are
  stale metadata and are violations; in --tex mode (partial scan) they are
  reported as warnings only.

What is intentionally NOT checked:
- Whether every result number in prose carries an anchor. That is an authoring
  discipline (see the research-writer SKILL.md Result Traceability section);
  detecting unannotated numbers deterministically is not possible without
  heuristics, which this gate deliberately avoids.
- Anchor placement/adjacency to the value it annotates (a comment cannot be
  tied to a token deterministically). The gate makes the declared binding
  auditable; reviewers check placement.

Fail-closed semantics (deliberately different from check_latex_evidence_gate.py,
which defaults to warn-only with an opt-in --fail): this gate ALWAYS exits
non-zero on violations and prints a NOT_READY status. There is no warn-only
mode. The only escape hatch for legacy manuscripts under incremental adoption
is an explicit exemption list (--exempt-id / --exempt-file) whose tokens are
manifest entry ids — or, for a figure with no manifest entry, the figure path
as written in the manuscript. Wildcard tokens are rejected, and structural
failures (missing/invalid manifest, anchors with a missing or malformed id)
are never exemptible. Figure artifact paths must stay
inside the manuscript directory (no absolute paths, no '..' segments); they
are resolved against the manuscript root — the --root directory, else the
directory of the first --tex file, never the manifest's own location — and
the artifact on disk must itself resolve inside that root (a symlink whose
target escapes it is a violation). A checksum therefore verifies exactly the
bytes that enter the manuscript, never bytes outside the paper root.

Exit codes:
- 0: READY (no unexempted violations)
- 2: NOT_READY (violations found), or usage/input error
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Iterable

MANIFEST_DEFAULT_NAME = "traceability_manifest.json"
SUPPORTED_MANIFEST_VERSION = 1
REQUIRED_RUN_FIELDS = ("run_id", "code_rev", "env_fingerprint")
KNOWN_KINDS = ("figure", "number")

# Anchor/entry id charset: conservative, unambiguous inside a TeX comment.
_RE_ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9._:-]*")
_RE_ID_FULL = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]*$")
_RE_ANCHOR = re.compile(r"^\s*origin:\s*(\S*)")
_RE_INCLUDEGRAPHICS = re.compile(r"\\includegraphics\*?\s*(?:\[[^\]]*\])?\s*\{([^}]+)\}")
_RE_SHA256_HEX = re.compile(r"^[0-9a-fA-F]{64}$")


def _read_text(path: Path) -> str:
    return path.read_text(encoding="utf-8", errors="replace").replace("\r\n", "\n").replace("\r", "\n")


def _comment_start(line: str) -> int | None:
    """
    Return the index of the '%' that starts a TeX comment on this line, or None.

    Mirrors the parity rule used by check_latex_evidence_gate.py: a '%'
    preceded by an odd number of backslashes is an escaped literal percent;
    an even number (incl. zero) starts a comment.
    """
    for i, ch in enumerate(line):
        if ch != "%":
            continue
        j = i - 1
        n_bs = 0
        while j >= 0 and line[j] == "\\":
            n_bs += 1
            j -= 1
        if n_bs % 2 == 0:
            return i
    return None


def _normalize_relpath(p: str) -> str:
    """Normalize a manuscript-relative path for matching (POSIX, no leading ./)."""
    s = p.strip().replace("\\", "/")
    while s.startswith("./"):
        s = s[2:]
    while "//" in s:
        s = s.replace("//", "/")
    return s


def _is_contained_relpath(norm: str) -> bool:
    """
    True iff a normalized path is manuscript-relative AND stays inside the
    manuscript directory: no absolute path, no drive prefix, no '..' segment.
    Escaping paths must never satisfy the gate (they would let the checksum be
    computed outside the paper root).
    """
    if not norm or norm.startswith("/"):
        return False
    if re.match(r"^[A-Za-z]:", norm):
        return False
    return ".." not in norm.split("/")


@dataclass(frozen=True)
class GraphicRef:
    # The brace-group content with whitespace collapsed (multi-line macro
    # calls are joined), i.e. the path as the author wrote it modulo layout.
    path_as_written: str
    tex_file: Path
    line: int


@dataclass(frozen=True)
class AnchorRef:
    anchor_id: str
    tex_file: Path
    line: int


@dataclass(frozen=True)
class Violation:
    kind: str
    exemption_key: str | None  # None => never exemptible (structural)
    where: str
    detail: str


@dataclass
class GateResult:
    violations: list[Violation] = field(default_factory=list)
    exempted: list[Violation] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)
    n_tex: int = 0
    n_entries: int = 0
    n_figure_entries: int = 0
    n_number_entries: int = 0

    @property
    def ready(self) -> bool:
        return not self.violations


def scan_tex_file(path: Path) -> tuple[list[GraphicRef], list[AnchorRef]]:
    """
    Extract \\includegraphics targets (from non-comment text) and origin
    anchors (from comment text) of a single .tex file.

    The \\includegraphics scan runs on the comment-stripped text as a whole
    (not per line), so a macro call split across lines — e.g. with a trailing
    '%' line-continuation before the brace group — is still bound by the gate
    rather than silently escaping it.
    """
    text = _read_text(path)
    code_lines: list[str] = []
    anchors: list[AnchorRef] = []
    for lineno, line in enumerate(text.splitlines(), start=1):
        cut = _comment_start(line)
        code_lines.append(line if cut is None else line[:cut])
        comment = "" if cut is None else line[cut:].lstrip("%")
        am = _RE_ANCHOR.match(comment)
        if am:
            anchors.append(AnchorRef(anchor_id=am.group(1), tex_file=path, line=lineno))
    code_text = "\n".join(code_lines)
    graphics: list[GraphicRef] = []
    for m in _RE_INCLUDEGRAPHICS.finditer(code_text):
        lineno = code_text.count("\n", 0, m.start()) + 1
        raw_path = re.sub(r"\s+", "", m.group(1))
        graphics.append(GraphicRef(path_as_written=raw_path, tex_file=path, line=lineno))
    return graphics, anchors


def _iter_tex_files(root: Path) -> Iterable[Path]:
    for p in sorted(root.rglob("*.tex")):
        if p.is_file():
            yield p


def _sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def _parse_checksum(raw: str) -> str | None:
    """Return the lowercase sha256 hex digest, or None if unsupported format."""
    s = raw.strip()
    if s.lower().startswith("sha256:"):
        s = s.split(":", 1)[1].strip()
    if _RE_SHA256_HEX.match(s):
        return s.lower()
    return None


def load_manifest(path: Path) -> tuple[list[dict[str, Any]] | None, list[Violation]]:
    """
    Load and shape-validate the manifest. Returns (entries, violations).
    entries is None when the manifest is structurally unusable (missing/invalid).
    """
    if not path.is_file():
        return None, [
            Violation(
                kind="manifest_missing",
                exemption_key=None,
                where=str(path),
                detail="traceability manifest not found; every delivered figure/result number must be registered",
            )
        ]
    try:
        obj = json.loads(_read_text(path))
    except json.JSONDecodeError as e:
        return None, [
            Violation(
                kind="manifest_invalid",
                exemption_key=None,
                where=str(path),
                detail=f"manifest is not valid JSON: {e}",
            )
        ]
    if not isinstance(obj, dict) or not isinstance(obj.get("entries"), list):
        return None, [
            Violation(
                kind="manifest_invalid",
                exemption_key=None,
                where=str(path),
                detail='manifest must be a JSON object with an "entries" list (and "version")',
            )
        ]
    if obj.get("version") != SUPPORTED_MANIFEST_VERSION:
        return None, [
            Violation(
                kind="manifest_invalid",
                exemption_key=None,
                where=str(path),
                detail=f'unsupported manifest "version": {obj.get("version")!r} (expected {SUPPORTED_MANIFEST_VERSION})',
            )
        ]
    entries: list[dict[str, Any]] = []
    violations: list[Violation] = []
    for idx, ent in enumerate(obj["entries"]):
        if not isinstance(ent, dict):
            violations.append(
                Violation(
                    kind="invalid_entry",
                    exemption_key=None,
                    where=f"{path}#entries[{idx}]",
                    detail="entry must be a JSON object",
                )
            )
            continue
        entries.append(ent)
    return entries, violations


def _validate_entry(ent: dict[str, Any], idx: int, manifest_path: Path) -> list[Violation]:
    """Field-level validation of one manifest entry (id/kind/artifact/checksum/run fields)."""
    where = f"{manifest_path}#entries[{idx}]"
    out: list[Violation] = []
    ent_id = ent.get("id")
    if not isinstance(ent_id, str) or not _RE_ID_FULL.match(ent_id):
        out.append(
            Violation(
                kind="invalid_entry",
                exemption_key=None,
                where=where,
                detail=f'entry "id" missing or not matching {_RE_ID.pattern}: {ent_id!r}',
            )
        )
        return out  # without a usable id, nothing else is checkable or exemptible
    key = ent_id
    kind = ent.get("kind")
    if kind not in KNOWN_KINDS:
        out.append(
            Violation(
                kind="invalid_entry",
                exemption_key=key,
                where=where,
                detail=f'entry "kind" must be one of {list(KNOWN_KINDS)}: got {kind!r}',
            )
        )
        return out
    if kind == "figure":
        artifact = ent.get("artifact")
        if not isinstance(artifact, str) or not artifact.strip():
            out.append(
                Violation(
                    kind="invalid_entry",
                    exemption_key=key,
                    where=where,
                    detail='figure entry requires a non-empty "artifact" (manuscript-relative path)',
                )
            )
        elif not _is_contained_relpath(_normalize_relpath(artifact)):
            out.append(
                Violation(
                    kind="invalid_entry",
                    exemption_key=key,
                    where=where,
                    detail=(
                        f'figure "artifact" must be a manuscript-relative path inside the paper directory '
                        f'(no absolute path, no ".." segment): {artifact!r}'
                    ),
                )
            )
        if "checksum" in ent:
            raw = ent.get("checksum")
            if not isinstance(raw, str) or _parse_checksum(raw) is None:
                out.append(
                    Violation(
                        kind="invalid_entry",
                        exemption_key=key,
                        where=where,
                        detail='figure "checksum" must be a sha256 hex digest (optionally "sha256:"-prefixed)',
                    )
                )
    else:  # number
        if "checksum" in ent:
            out.append(
                Violation(
                    kind="invalid_entry",
                    exemption_key=key,
                    where=where,
                    detail='number entries do not take a "checksum" (nothing on disk to hash); use "notes" for data pointers',
                )
            )
        if "artifact" in ent:
            out.append(
                Violation(
                    kind="invalid_entry",
                    exemption_key=key,
                    where=where,
                    detail='number entries bind via their "id" (the in-manuscript anchor); "artifact" is not accepted',
                )
            )
    missing = [f for f in REQUIRED_RUN_FIELDS if not (isinstance(ent.get(f), str) and ent.get(f).strip())]
    if missing:
        out.append(
            Violation(
                kind="missing_fields",
                exemption_key=key,
                where=where,
                detail=f"entry {ent_id!r} lacks non-empty required field(s): {', '.join(missing)}",
            )
        )
    return out


def evaluate(
    *,
    tex_files: list[Path],
    manifest_path: Path,
    paper_root: Path,
    exempt_ids: set[str],
    strict_unused: bool,
) -> GateResult:
    res = GateResult()
    all_violations: list[Violation] = []

    entries, structural = load_manifest(manifest_path)
    all_violations.extend(structural)

    graphics: list[GraphicRef] = []
    anchors: list[AnchorRef] = []
    for p in tex_files:
        g, a = scan_tex_file(p)
        graphics.extend(g)
        anchors.extend(a)
    res.n_tex = len(tex_files)

    by_id: dict[str, dict[str, Any]] = {}
    figure_by_artifact: dict[str, list[dict[str, Any]]] = {}
    if entries is not None:
        res.n_entries = len(entries)
        seen_ids: set[str] = set()
        for idx, ent in enumerate(entries):
            all_violations.extend(_validate_entry(ent, idx, manifest_path))
            ent_id = ent.get("id")
            if not isinstance(ent_id, str) or not _RE_ID_FULL.match(ent_id):
                continue
            if ent_id in seen_ids:
                all_violations.append(
                    Violation(
                        kind="duplicate_id",
                        exemption_key=ent_id,
                        where=f"{manifest_path}#entries[{idx}]",
                        detail=f"entry id {ent_id!r} appears more than once (the origin record would be ambiguous)",
                    )
                )
                continue
            seen_ids.add(ent_id)
            by_id[ent_id] = ent
            if ent.get("kind") == "figure":
                res.n_figure_entries += 1
                artifact = ent.get("artifact")
                if isinstance(artifact, str) and artifact.strip():
                    norm_artifact = _normalize_relpath(artifact)
                    # Escaping paths (absolute / '..') are flagged as invalid
                    # entries and must never become a binding target.
                    if _is_contained_relpath(norm_artifact):
                        figure_by_artifact.setdefault(norm_artifact, []).append(ent)
            elif ent.get("kind") == "number":
                res.n_number_entries += 1

        # --- figures: every \includegraphics must bind to exactly one figure entry ---
        # Artifacts resolve against the manuscript root (where LaTeX resolves
        # \includegraphics from), NOT the manifest's own directory: with an
        # out-of-tree --manifest the two differ, and hashing relative to the
        # manifest would verify the wrong bytes.
        bound_entry_ids: set[str] = set()
        resolved_root = paper_root.resolve()
        for ref in graphics:
            norm = _normalize_relpath(ref.path_as_written)
            candidates = list(figure_by_artifact.get(norm, []))
            if not candidates and "." not in norm.rsplit("/", 1)[-1]:
                # LaTeX allows extension-less \includegraphics{figures/foo};
                # match manifest artifacts by stem path.
                candidates = [
                    e
                    for art, ents in figure_by_artifact.items()
                    for e in ents
                    if art.rsplit(".", 1)[0] == norm
                ]
            where = f"{ref.tex_file}:{ref.line}"
            if not candidates:
                all_violations.append(
                    Violation(
                        kind="unbound_figure",
                        exemption_key=ref.path_as_written,
                        where=where,
                        detail=f"\\includegraphics{{{ref.path_as_written}}} has no figure entry in the traceability manifest",
                    )
                )
                continue
            if len(candidates) > 1:
                ids = ", ".join(sorted(str(e.get("id")) for e in candidates))
                all_violations.append(
                    Violation(
                        kind="ambiguous_figure_binding",
                        exemption_key=ref.path_as_written,
                        where=where,
                        detail=f"\\includegraphics{{{ref.path_as_written}}} matches multiple manifest entries: {ids}",
                    )
                )
                # The ambiguity itself is the violation; do not additionally
                # report every candidate as an unused entry.
                for e in candidates:
                    bound_entry_ids.add(str(e.get("id")))
                continue
            ent = candidates[0]
            ent_id = str(ent.get("id"))
            bound_entry_ids.add(ent_id)
            raw_checksum = ent.get("checksum")
            want = _parse_checksum(raw_checksum) if isinstance(raw_checksum, str) else None
            artifact_fs = paper_root / _normalize_relpath(str(ent.get("artifact")))
            if artifact_fs.is_file():
                # Resolved-path containment applies to EVERY bound artifact
                # that exists on disk, checksummed or not: lexical containment
                # cannot stop a symlink whose target escapes the paper root,
                # and at delivery time the paper directory must carry the
                # real bytes.
                resolved_fs = artifact_fs.resolve()
                if not resolved_fs.is_relative_to(resolved_root):
                    all_violations.append(
                        Violation(
                            kind="artifact_outside_root",
                            exemption_key=ent_id,
                            where=where,
                            detail=(
                                f"figure entry {ent_id!r}: {ent.get('artifact')!r} resolves outside the paper "
                                f"directory ({resolved_fs}); copy the real bytes into the paper directory "
                                "before delivery"
                            ),
                        )
                    )
                    continue
                if want is not None:
                    got = _sha256_file(resolved_fs)
                    if got != want:
                        all_violations.append(
                            Violation(
                                kind="checksum_mismatch",
                                exemption_key=ent_id,
                                where=where,
                                detail=(
                                    f"figure entry {ent_id!r}: sha256 mismatch for {ent.get('artifact')!r} "
                                    f"(manifest {want[:12]}…, on disk {got[:12]}…); figure and manifest are out of sync"
                                ),
                            )
                        )
            elif want is not None:
                # A recorded (well-formed) checksum requires the bytes to be
                # present; a malformed checksum was already flagged by
                # _validate_entry, and an entry without a checksum does not
                # promise on-disk verification (compilation is out of scope).
                all_violations.append(
                    Violation(
                        kind="artifact_missing",
                        exemption_key=ent_id,
                        where=where,
                        detail=f"figure entry {ent_id!r}: artifact not found on disk, checksum cannot be verified: {artifact_fs}",
                    )
                )

        # --- numbers: every anchor must bind to a number entry ---
        anchored_ids: set[str] = set()
        for ref in anchors:
            where = f"{ref.tex_file}:{ref.line}"
            if not ref.anchor_id:
                all_violations.append(
                    Violation(
                        kind="invalid_anchor",
                        exemption_key=None,  # nothing meaningful to exempt: fix the anchor
                        where=where,
                        detail="anchor 'origin:' has no id; write '% origin: <id>' matching a manifest entry",
                    )
                )
                continue
            if not _RE_ID_FULL.match(ref.anchor_id):
                all_violations.append(
                    Violation(
                        kind="invalid_anchor",
                        # A malformed id can never name a manifest entry, so
                        # this is a structural parse failure: not exemptible.
                        exemption_key=None,
                        where=where,
                        detail=f"anchor id {ref.anchor_id!r} does not match {_RE_ID.pattern}; fix the anchor",
                    )
                )
                continue
            ent = by_id.get(ref.anchor_id)
            if ent is None:
                all_violations.append(
                    Violation(
                        kind="unbound_anchor",
                        exemption_key=ref.anchor_id,
                        where=where,
                        detail=f"anchor 'origin: {ref.anchor_id}' has no manifest entry",
                    )
                )
                continue
            if ent.get("kind") != "number":
                all_violations.append(
                    Violation(
                        kind="kind_mismatch",
                        exemption_key=ref.anchor_id,
                        where=where,
                        detail=(
                            f"anchor 'origin: {ref.anchor_id}' resolves to a {ent.get('kind')!r} entry; "
                            "result-number anchors must bind to kind=\"number\""
                        ),
                    )
                )
                continue
            anchored_ids.add(ref.anchor_id)

        # --- stale manifest entries (bound to nothing in the scanned manuscript) ---
        # Entries already flagged as structurally invalid are not additionally
        # reported as unused: the invalid_entry violation is the actionable one.
        structurally_invalid_ids = {
            v.exemption_key for v in all_violations if v.kind == "invalid_entry" and v.exemption_key
        }
        for ent_id, ent in sorted(by_id.items()):
            kind = ent.get("kind")
            used = ent_id in bound_entry_ids if kind == "figure" else ent_id in anchored_ids
            if used or kind not in KNOWN_KINDS or ent_id in structurally_invalid_ids:
                continue
            msg = (
                f"manifest entry {ent_id!r} (kind={kind}) binds to nothing in the scanned manuscript "
                "(stale entry, or missing \\includegraphics/anchor)"
            )
            if strict_unused:
                all_violations.append(
                    Violation(
                        kind="unused_entry",
                        exemption_key=ent_id,
                        where=str(manifest_path),
                        detail=msg,
                    )
                )
            else:
                res.warnings.append(f"[unused_entry] {msg} (warning only: partial --tex scan)")

    # --- exemptions: explicit ids only; structural violations are never exemptible ---
    used_exemptions: set[str] = set()
    for v in all_violations:
        if v.exemption_key is not None and v.exemption_key in exempt_ids:
            res.exempted.append(v)
            used_exemptions.add(v.exemption_key)
        else:
            res.violations.append(v)
    for tok in sorted(exempt_ids - used_exemptions):
        res.warnings.append(f"[unused_exemption] exemption {tok!r} matched no violation (fixed already? remove it)")
    return res


def _load_exemptions(args: argparse.Namespace) -> tuple[set[str] | None, str | None]:
    """Return (ids, error). Wildcard or empty tokens are rejected (fail-closed)."""
    toks: list[str] = list(args.exempt_id or [])
    if args.exempt_file is not None:
        p = args.exempt_file.expanduser()
        if not p.is_file():
            return None, f"--exempt-file not found: {p}"
        for ln in _read_text(p).splitlines():
            s = ln.split("#", 1)[0].strip()
            if s:
                toks.append(s)
    out: set[str] = set()
    for t in toks:
        t = t.strip()
        if not t or any(c in t for c in "*?[]"):
            return None, f"exemption tokens must be explicit ids (no wildcards/empties): {t!r}"
        out.add(t)
    return out, None


def _write_report_atomic(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + f".tmp.{os.getpid()}")
    tmp.write_text(text, encoding="utf-8")
    tmp.replace(path)


def _render_report(res: GateResult, manifest_path: Path) -> str:
    status = "READY" if res.ready else "NOT_READY"
    lines: list[str] = []
    lines.append("# Result Traceability Report")
    lines.append("")
    lines.append(f"- status: {status}")
    lines.append(f"- manifest: {manifest_path}")
    lines.append(f"- scanned tex files: {res.n_tex}")
    lines.append(f"- manifest entries: {res.n_entries} (figures: {res.n_figure_entries}, numbers: {res.n_number_entries})")
    lines.append(f"- violations: {len(res.violations)} (exempted: {len(res.exempted)})")
    lines.append(f"- warnings: {len(res.warnings)}")
    if res.violations:
        lines.append("")
        lines.append("## Violations")
        for v in res.violations:
            lines.append(f"- [{v.kind}] {v.where} — {v.detail}")
    if res.exempted:
        lines.append("")
        lines.append("## Exempted (explicit baseline exemptions)")
        for v in res.exempted:
            lines.append(f"- [{v.kind}] (exempt: {v.exemption_key}) {v.where} — {v.detail}")
    if res.warnings:
        lines.append("")
        lines.append("## Warnings")
        for w in res.warnings:
            lines.append(f"- {w}")
    lines.append("")
    return "\n".join(lines)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--root", type=Path, default=None, help="Scan all *.tex under this directory (recursive). Intended gate invocation: the paper/ directory.")
    ap.add_argument("--tex", type=Path, action="append", default=[], help="Scan a specific .tex file (can repeat). Partial scan: unused manifest entries downgrade to warnings.")
    ap.add_argument("--manifest", type=Path, default=None, help=f"Traceability manifest path (default: {MANIFEST_DEFAULT_NAME} next to --root, else next to the first --tex).")
    ap.add_argument("--exempt-id", action="append", default=[], help="Baseline exemption: exempt violations keyed by this explicit id/path (can repeat). No wildcards.")
    ap.add_argument("--exempt-file", type=Path, default=None, help="File with one exemption id per line ('#' comments allowed). No wildcards.")
    ap.add_argument("--report", type=Path, default=None, help="Also write a Markdown report to this path (atomic write).")
    args = ap.parse_args()

    tex_files: list[Path] = []
    if args.root is not None:
        root = args.root.expanduser().resolve()
        if not root.is_dir():
            print(f"ERROR: --root is not a directory: {root}", file=sys.stderr)
            return 2
        tex_files.extend(list(_iter_tex_files(root)))
    for p in args.tex:
        pp = p.expanduser().resolve()
        if not pp.is_file():
            print(f"ERROR: --tex not found: {pp}", file=sys.stderr)
            return 2
        tex_files.append(pp)
    if not tex_files:
        print("ERROR: provide --root or --tex (no .tex files to scan)", file=sys.stderr)
        return 2
    tex_files = sorted(set(tex_files))

    # The manuscript root: where LaTeX resolves \includegraphics paths from
    # and where manifest artifacts are resolved for checksum verification.
    paper_root = args.root.expanduser().resolve() if args.root is not None else tex_files[0].parent

    if args.manifest is not None:
        manifest_path = args.manifest.expanduser().resolve()
    else:
        manifest_path = paper_root / MANIFEST_DEFAULT_NAME

    exempt_ids, err = _load_exemptions(args)
    if err is not None:
        print(f"ERROR: {err}", file=sys.stderr)
        return 2

    res = evaluate(
        tex_files=tex_files,
        manifest_path=manifest_path,
        paper_root=paper_root,
        exempt_ids=exempt_ids or set(),
        strict_unused=args.root is not None,
    )

    report = _render_report(res, manifest_path)
    if args.report is not None:
        _write_report_atomic(args.report.expanduser(), report)

    for v in res.violations:
        print(f"[result-traceability] VIOLATION [{v.kind}] {v.where} — {v.detail}")
    for v in res.exempted:
        print(f"[result-traceability] exempted [{v.kind}] (exempt: {v.exemption_key}) {v.where}")
    for w in res.warnings:
        print(f"[result-traceability] warning: {w}")

    if not res.ready:
        print(f"[result-traceability] NOT_READY: {len(res.violations)} violation(s); see report above (fail-closed, no warn-only mode)")
        return 2
    print(
        f"[result-traceability] READY: {res.n_tex} tex file(s), "
        f"{res.n_figure_entries} figure + {res.n_number_entries} number entr(y/ies) bound"
        + (f", {len(res.exempted)} exempted" if res.exempted else "")
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
