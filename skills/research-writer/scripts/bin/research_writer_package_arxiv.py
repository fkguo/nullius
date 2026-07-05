#!/usr/bin/env python3
"""
research_writer_package_arxiv.py

Offline, deterministic arXiv-packaging step for a research-writer paper build.

Goal: turn a working paper build directory (as produced by
research_writer_scaffold.py / consume_paper_manifest.py, possibly compiled by
latexmk) into a clean, self-contained staging directory that is ready to be
tarred and uploaded to arXiv — with no network access, no LaTeX invocation, and
a byte-level checksum manifest of exactly what would be shipped.

Why this exists: arXiv rejects (or silently mishandles) a surprising number of
avoidable things — figures that are symlinks (the tarball then carries a dangling
link, not the bytes), leftover build cruft (*.aux/*.log/*.out/latexmkrc), a
missing pre-built bibliography (arXiv does not always re-run BibTeX the way you
expect), and filenames whose case or spacing does not survive a case-sensitive
Linux TeX install. This step makes each of those deterministic and auditable.

What it does (given --build-dir, staging into --out-dir):
1. Copy the build tree into --out-dir, DEREFERENCING symlinks to real bytes
   (a symlinked figure becomes the actual file). Excludes build cruft
   (latexmkrc, *.bak, *.aux, *.log, *.out, *.synctex.gz, *.blg, *.fdb_latexmk,
   *.fls, *.run.xml, *.bcf, and VCS/OS junk).
2. Inline a pre-built bibliography: if a <stem>.bbl exists next to the main
   .tex, splice its contents in place of the \\bibliography{...} line (arXiv
   then needs no .bib / BibTeX pass). If no .bbl is present, the .bib is copied
   alongside and the \\bibliography line is left untouched.
3. Scan every \\includegraphics / \\input / \\include reference in the staged
   .tex files and FAIL CLOSED (exit 2) on anything arXiv cannot portably build:
   a referenced path containing spaces, an absolute path, or an
   extension-case mismatch against the file actually staged on disk
   (e.g. \\includegraphics{fig.PDF} but the file is fig.pdf).
4. Emit a sha256 checksum manifest (SHA256SUMS.txt + arxiv_package.json) over
   every staged file, so the shipped bytes are traceable.

Fail-closed semantics: any portability defect, a missing main .tex, or an
unreadable input is a hard failure (exit 2). There is no warn-only mode; the
whole point is that a green run means "safe to upload".

Exit codes:
- 0: OK (staging written, no portability defects)
- 2: defect found, or usage/input error
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import sys
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterable

# Build cruft that must never enter an arXiv upload. latexmkrc is dropped by
# name; the rest are matched by suffix (lowercased). Kept conservative and
# explicit rather than heuristic.
_DROP_NAMES = frozenset({"latexmkrc", ".ds_store", "thumbs.db"})
_DROP_SUFFIXES = (
    ".bak",
    ".aux",
    ".log",
    ".out",
    ".synctex.gz",
    ".blg",
    ".fdb_latexmk",
    ".fls",
    ".run.xml",
    ".bcf",
    ".toc",
    ".lof",
    ".lot",
    ".nav",
    ".snm",
    ".pyc",
)
# Directory names never worth shipping.
_DROP_DIRS = frozenset({".git", ".svn", ".hg", "__pycache__", ".ipynb_checkpoints"})

# Graphics/input reference scanners. \includegraphics matches the check_result_
# traceability.py convention; \input/\include match consume_paper_manifest.py.
_RE_INCLUDEGRAPHICS = re.compile(r"\\includegraphics\*?\s*(?:\[[^\]]*\])?\s*\{([^}]+)\}")
_RE_INPUT = re.compile(r"\\(?:input|include)\s*\{([^}]+)\}")
_RE_BIBLIOGRAPHY = re.compile(r"^[^%\n]*\\bibliography\s*\{([^}]*)\}", re.MULTILINE)

# Extensions LaTeX will silently supply for \includegraphics{stem} (no dot in
# the final path component). Order matches a typical pdflatex graphics.cfg.
_GRAPHICS_EXTS = (".pdf", ".png", ".jpg", ".jpeg", ".eps", ".ps")


def _read_text(path: Path) -> str:
    return path.read_text(encoding="utf-8", errors="replace").replace("\r\n", "\n").replace("\r", "\n")


def _write_text(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")


def _write_json(path: Path, obj: object) -> None:
    _write_text(path, json.dumps(obj, indent=2, sort_keys=True) + "\n")


def _sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _should_drop(name: str) -> bool:
    """True iff a file basename is build cruft that must not be staged."""
    low = name.lower()
    if low in _DROP_NAMES:
        return True
    return any(low.endswith(suf) for suf in _DROP_SUFFIXES)


def _normalize_ref(raw: str) -> str:
    """Normalize a graphics/input reference the way it is written in the .tex."""
    return re.sub(r"\s+", "", raw).replace("\\", "/")


@dataclass(frozen=True)
class Ref:
    """A \\includegraphics / \\input reference and where it was written."""

    path_as_written: str
    tex_file: Path  # relative to the staging root
    line: int
    kind: str  # "graphics" | "input"


@dataclass
class PackageResult:
    staged_files: list[Path] = field(default_factory=list)  # relative to out_dir
    defects: list[str] = field(default_factory=list)
    dropped: list[str] = field(default_factory=list)  # relative to build_dir
    dereferenced: list[str] = field(default_factory=list)  # relative to out_dir
    bbl_inlined: str | None = None
    bib_copied: bool = False
    main_tex_rel: str | None = None

    @property
    def ok(self) -> bool:
        return not self.defects


def _iter_build_files(build_dir: Path) -> Iterable[Path]:
    """
    Yield files under build_dir (recursively), skipping cruft directories.
    Deterministic order (sorted). Symlinked directories are not descended into
    (a symlinked figures/ dir is copied as its real contents at file level).
    """
    stack: list[Path] = [build_dir]
    while stack:
        d = stack.pop()
        try:
            children = sorted(d.iterdir(), key=lambda p: p.name)
        except OSError:
            continue
        for child in children:
            if child.is_dir() and not child.is_symlink():
                if child.name in _DROP_DIRS:
                    continue
                stack.append(child)
            else:
                yield child


def _stage_tree(build_dir: Path, out_dir: Path, res: PackageResult) -> None:
    """
    Copy build_dir into out_dir, dereferencing symlinks to real bytes and
    dropping build cruft. Records staged/dropped/dereferenced paths on res.
    """
    for src in _iter_build_files(build_dir):
        rel = src.relative_to(build_dir)
        # Never stage a checksum manifest we ourselves emit (idempotent reruns).
        if rel.as_posix() in ("SHA256SUMS.txt", "arxiv_package.json"):
            continue
        if _should_drop(src.name):
            res.dropped.append(rel.as_posix())
            continue
        was_symlink = src.is_symlink()
        # Resolve the real bytes (dereference). A dangling symlink is a hard
        # failure: arXiv would otherwise ship a broken link.
        real = src.resolve()
        if not real.is_file():
            res.defects.append(
                f"{rel.as_posix()}: symlink/target does not resolve to a real file "
                f"({real}); arXiv cannot ship a dangling link"
            )
            continue
        dst = out_dir / rel
        dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(real, dst)  # copyfile: bytes only, never a link
        res.staged_files.append(rel)
        if was_symlink:
            res.dereferenced.append(rel.as_posix())


def _find_main_tex(out_dir: Path, override: str | None) -> tuple[Path | None, str | None]:
    """
    Resolve the main .tex under the (already staged) out_dir.
    Returns (path, error). Prefers an explicit override, then main.tex, then a
    unique \\documentclass-bearing .tex.
    """
    if override is not None:
        cand = (out_dir / override).resolve()
        if not cand.is_file():
            return None, f"--main-tex not found in staged tree: {override}"
        try:
            cand.relative_to(out_dir.resolve())
        except ValueError:
            return None, f"--main-tex escapes the staging directory: {override}"
        return cand, None
    default = out_dir / "main.tex"
    if default.is_file():
        return default, None
    with_docclass = [
        p
        for p in sorted(out_dir.rglob("*.tex"))
        if p.is_file() and "\\documentclass" in _read_text(p)
    ]
    if len(with_docclass) == 1:
        return with_docclass[0], None
    if not with_docclass:
        return None, "no main .tex found (no main.tex and no \\documentclass in any staged .tex)"
    names = ", ".join(sorted(p.relative_to(out_dir).as_posix() for p in with_docclass))
    return None, f"multiple candidate main .tex files; pass --main-tex to disambiguate: {names}"


def _inline_bbl(out_dir: Path, main_tex: Path, res: PackageResult) -> None:
    """
    If a <stem>.bbl sits next to the main .tex, splice its contents in place of
    the \\bibliography{...} line so arXiv needs no BibTeX pass. Otherwise leave
    the .tex untouched (the .bib was already staged by _stage_tree).
    """
    bbl = main_tex.with_suffix(".bbl")
    if not bbl.is_file():
        # No pre-built bibliography; the .bib (if any) travels alongside.
        res.bib_copied = any(p.suffix.lower() == ".bib" for p in res.staged_files)
        return
    text = _read_text(main_tex)
    m = _RE_BIBLIOGRAPHY.search(text)
    bbl_body = _read_text(bbl).strip("\n")
    inlined_block = (
        "% __bbl_inlined_by_research_writer_package_arxiv__: "
        f"contents of {bbl.name} spliced in for arXiv (no BibTeX pass needed)\n"
        + bbl_body
        + "\n"
    )
    if m is not None:
        new_text = text[: m.start()] + inlined_block + text[m.end():]
    else:
        # No \bibliography line to replace (e.g. already inlined): drop the .bbl
        # in just before \end{document} so the bibliography still ships.
        end_doc = text.rfind("\\end{document}")
        if end_doc == -1:
            new_text = text.rstrip("\n") + "\n" + inlined_block
        else:
            new_text = text[:end_doc] + inlined_block + text[end_doc:]
    _write_text(main_tex, new_text)
    res.bbl_inlined = bbl.relative_to(out_dir).as_posix()
    # The .bbl is now inlined; drop the standalone copy so it is not duplicated.
    staged_bbl_rel = bbl.relative_to(out_dir)
    if staged_bbl_rel in res.staged_files and bbl.is_file():
        bbl.unlink()
        res.staged_files.remove(staged_bbl_rel)
        res.dropped.append(staged_bbl_rel.as_posix())


def _scan_refs(out_dir: Path) -> list[Ref]:
    """Collect \\includegraphics and \\input/\\include references from staged .tex files."""
    refs: list[Ref] = []
    for tex in sorted(out_dir.rglob("*.tex")):
        if not tex.is_file():
            continue
        rel_tex = tex.relative_to(out_dir)
        text = _read_text(tex)
        # Strip comments line-by-line so a commented-out \includegraphics does
        # not trip the portability gate.
        code_lines: list[str] = []
        for line in text.splitlines():
            cut = _comment_start(line)
            code_lines.append(line if cut is None else line[:cut])
        code_text = "\n".join(code_lines)
        for regex, kind in ((_RE_INCLUDEGRAPHICS, "graphics"), (_RE_INPUT, "input")):
            for m in regex.finditer(code_text):
                line = code_text.count("\n", 0, m.start()) + 1
                refs.append(
                    Ref(
                        path_as_written=m.group(1),
                        tex_file=rel_tex,
                        line=line,
                        kind=kind,
                    )
                )
    return refs


def _comment_start(line: str) -> int | None:
    """
    Index of the '%' starting a TeX comment on this line, or None. A '%'
    preceded by an even number of backslashes (incl. zero) starts a comment;
    an odd number is an escaped literal percent. Mirrors the parity rule in
    check_result_traceability.py.
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


def _actual_entry_name(dir_path: Path, name: str) -> str | None:
    """
    Return the on-disk basename in dir_path that matches `name` case-insensitively,
    preserving its true case — or None if no such entry exists. This is how we
    detect case mismatches on a case-INSENSITIVE host FS (macOS/Windows), where
    Path.is_file() would happily match "plot.PDF" against an on-disk "plot.pdf"
    and hide the very defect a case-sensitive Linux TeX install would trip on.
    """
    if not dir_path.is_dir():
        return None
    lname = name.lower()
    for child in dir_path.iterdir():
        if child.name == name:
            return name  # exact match: no mismatch to report
        if child.name.lower() == lname and child.is_file():
            return child.name
    return None


def _resolve_ref_on_disk(out_dir: Path, ref: Ref) -> Path | None:
    """
    Resolve a normalized (space-free) reference to the file actually staged,
    trying LaTeX's implicit extension search for extension-less graphics.
    Returns the real on-disk path (with the directory's true-case basename), or
    None if nothing matches. Case-preserving so a case check can compare the
    written name against the actual entry even on a case-insensitive host FS.
    """
    norm = _normalize_ref(ref.path_as_written)
    dirname = os.path.dirname(norm)
    parent = out_dir / dirname if dirname else out_dir
    written_name = os.path.basename(norm)

    # Reference carries an explicit extension (dot in the basename): look it up
    # directly, preserving the on-disk case.
    if "." in written_name:
        actual = _actual_entry_name(parent, written_name)
        return parent / actual if actual is not None else None
    # Extension-less \input{stem} -> stem.tex
    if ref.kind == "input":
        actual = _actual_entry_name(parent, written_name + ".tex")
        return parent / actual if actual is not None else None
    # Extension-less \includegraphics{stem} -> LaTeX's implicit extension search.
    if ref.kind == "graphics":
        for ext in _GRAPHICS_EXTS:
            actual = _actual_entry_name(parent, written_name + ext)
            if actual is not None:
                return parent / actual
    return None


def _cmd_label(kind: str) -> str:
    """Human-facing macro name for a reference kind (for defect messages)."""
    return "includegraphics" if kind == "graphics" else "input/include"


def _check_ref_portability(out_dir: Path, ref: Ref) -> list[str]:
    """
    Fail-closed portability checks for one reference: spaces, absolute path,
    or a filename-case mismatch against the file actually staged. Returns defect
    strings (empty => clean).
    """
    where = f"{ref.tex_file.as_posix()}:{ref.line}"
    cmd = _cmd_label(ref.kind)
    raw = ref.path_as_written
    out: list[str] = []
    if re.search(r"\S\s+\S", raw.strip()) or raw != raw.strip():
        out.append(
            f"{where}: \\{cmd} target {raw!r} contains whitespace; "
            "arXiv's tarball path handling is unreliable with spaces — rename the file"
        )
    norm = _normalize_ref(raw)
    if norm.startswith("/") or re.match(r"^[A-Za-z]:", norm):
        out.append(
            f"{where}: \\{cmd} target {norm!r} is an absolute path; "
            "use a path relative to the paper directory"
        )
        return out  # cannot meaningfully case-check an absolute path
    # Case check: the basename as written (extension included, if any) must match
    # the on-disk entry exactly. On a case-sensitive Linux TeX install a mismatch
    # (\includegraphics{fig.PDF} vs staged fig.pdf, or Fig vs fig) is a build
    # failure; a case-insensitive host FS would otherwise hide it, so we compare
    # against the true-case directory entry, never a constructed path.
    on_disk = _resolve_ref_on_disk(out_dir, ref)
    if on_disk is not None:
        written_name = os.path.basename(norm)
        actual_name = on_disk.name
        # Extension-less \includegraphics{stem}: written_name has no extension,
        # so compare only the stem the author wrote against the entry's stem.
        if "." not in written_name and ref.kind == "graphics":
            actual_name = os.path.splitext(actual_name)[0]
        if written_name != actual_name and written_name.lower() == actual_name.lower():
            out.append(
                f"{where}: \\{cmd} target {norm!r} does not match the staged file "
                f"{on_disk.relative_to(out_dir).as_posix()!r} in case "
                f"({written_name!r} vs {actual_name!r}); case-sensitive TeX installs will not find it"
            )
    return out


def _emit_checksums(out_dir: Path, res: PackageResult) -> dict:
    """
    Write SHA256SUMS.txt (sha256<space><space>relpath, sorted) over every staged
    file and return the manifest dict (also written as arxiv_package.json).
    """
    files_sorted = sorted(res.staged_files, key=lambda p: p.as_posix())
    lines: list[str] = []
    entries: list[dict] = []
    for rel in files_sorted:
        digest = _sha256_file(out_dir / rel)
        lines.append(f"{digest}  {rel.as_posix()}")
        entries.append({"path": rel.as_posix(), "sha256": digest})
    _write_text(out_dir / "SHA256SUMS.txt", "\n".join(lines) + ("\n" if lines else ""))
    manifest = {
        "schemaVersion": 1,
        "tool": "research-writer",
        "entrypoint": "package_arxiv",
        "generated_at_utc": _utc_now(),
        "main_tex": res.main_tex_rel,
        "bbl_inlined": res.bbl_inlined,
        "bib_copied": res.bib_copied,
        "dereferenced_symlinks": sorted(res.dereferenced),
        "dropped": sorted(res.dropped),
        "n_staged_files": len(files_sorted),
        "files": entries,
        "checksums": "SHA256SUMS.txt",
    }
    _write_json(out_dir / "arxiv_package.json", manifest)
    # SHA256SUMS.txt and arxiv_package.json are metadata about the package, not
    # part of it; they are intentionally excluded from staged_files/checksums.
    return manifest


def package(build_dir: Path, out_dir: Path, *, main_tex_override: str | None, force: bool) -> tuple[PackageResult, str | None]:
    """Run the full offline packaging. Returns (result, fatal_error_or_None)."""
    if not build_dir.is_dir():
        return PackageResult(), f"--build-dir is not a directory: {build_dir}"
    if out_dir.resolve() == build_dir.resolve():
        return PackageResult(), "--out-dir must differ from --build-dir (staging is a separate clean copy)"
    try:
        out_dir.resolve().relative_to(build_dir.resolve())
        return PackageResult(), "--out-dir must not be inside --build-dir"
    except ValueError:
        pass
    if out_dir.exists():
        if not force:
            return PackageResult(), f"--out-dir already exists: {out_dir} (use --force to overwrite)"
        shutil.rmtree(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    res = PackageResult()
    _stage_tree(build_dir, out_dir, res)
    if res.defects:
        return res, None  # dangling-symlink defects: report before touching .tex

    main_tex, err = _find_main_tex(out_dir, main_tex_override)
    if err is not None:
        res.defects.append(err)
        return res, None
    assert main_tex is not None
    res.main_tex_rel = main_tex.relative_to(out_dir).as_posix()

    _inline_bbl(out_dir, main_tex, res)

    for ref in _scan_refs(out_dir):
        res.defects.extend(_check_ref_portability(out_dir, ref))

    # Always emit the manifest so a failed run still records what was staged.
    _emit_checksums(out_dir, res)
    return res, None


def main() -> int:
    ap = argparse.ArgumentParser(
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    ap.add_argument("--build-dir", type=Path, required=True, help="Paper build directory to package (read-only input).")
    ap.add_argument("--out-dir", type=Path, required=True, help="Staging directory to write the arXiv-ready copy into.")
    ap.add_argument("--main-tex", default=None, help="Main .tex relative to --build-dir (default: main.tex, else the unique \\documentclass file).")
    ap.add_argument("--force", action="store_true", help="Overwrite --out-dir if it exists.")
    args = ap.parse_args()

    build_dir = args.build_dir.expanduser().resolve()
    out_dir = args.out_dir.expanduser().resolve()

    res, fatal = package(build_dir, out_dir, main_tex_override=args.main_tex, force=args.force)
    if fatal is not None:
        print(f"ERROR: {fatal}", file=sys.stderr)
        return 2

    for d in res.dereferenced:
        print(f"[package-arxiv] dereferenced symlink -> bytes: {d}")
    if res.bbl_inlined:
        print(f"[package-arxiv] inlined bibliography: {res.bbl_inlined} (no BibTeX pass needed on arXiv)")
    elif res.bib_copied:
        print("[package-arxiv] no .bbl found; .bib staged alongside (arXiv will run BibTeX)")

    if not res.ok:
        for d in res.defects:
            print(f"[package-arxiv] DEFECT {d}")
        print(f"[package-arxiv] NOT_READY: {len(res.defects)} portability defect(s); staging at {out_dir} is NOT safe to upload")
        return 2

    print(
        f"[package-arxiv] OK: staged {len(res.staged_files)} file(s) into {out_dir}; "
        f"dropped {len(res.dropped)} cruft file(s); checksums in SHA256SUMS.txt"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
