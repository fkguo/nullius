#!/usr/bin/env python3
"""Export selected research files with their local document dependencies.

Files keep project-relative paths and original bytes. The existing MANIFEST.md
describes the selection; it is not scientific acceptance or a user download URL.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import sys
import tempfile
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import quote, unquote, urlsplit

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "lib"))
from md_utils import strip_inline_code_spans
from run_paths import canonical_run_root, read_run_directory

CORE_DOCS = (
    "project_index.md", "project_charter.md", "research_plan.md",
    "research_preflight.md", "research_contract.md", "research_notebook.md",
)
_RE_TEX = re.compile(r"\\(input|include|includegraphics\*?|bibliography|addbibresource)\s*(?:\[[^\]]*\])?\s*\{([^}]+)\}")
_RE_MD_LINK = re.compile(r"!?\[[^\]\n]*\]\(\s*(<[^>\n]*>|(?:\\.|[^()\s]|\([^()\n]*\))+)(?:\s+(?:\"[^\"\n]*\"|'[^'\n]*'))?\s*\)")
_RE_MD_DEF = re.compile(r"(?m)^ {0,3}\[([^\]\n]+)\]:\s*(<[^>\n]*>|\S+)(?:\s+.*)?$")
_RE_MD_REF = re.compile(r"!?\[([^\]\n]+)\](?:\[([^\]\n]*)\])?")
_GRAPHICS_EXTS = (".pdf", ".png", ".jpg", ".jpeg", ".eps", ".ps")


def _find_project_root(seed: Path) -> Path:
    cur = seed.resolve()
    for parent in (cur, *cur.parents):
        if (parent / "project_charter.md").is_file() and (parent / "research_contract.md").is_file():
            return parent
    return cur


def _visible_markdown(text: str) -> str:
    lines = []
    fence = ""
    length = 0
    for line in text.splitlines():
        match = re.match(r"^ {0,3}(\x60{3,}|~{3,})", line)
        if match:
            token = match.group(1)
            if not fence:
                fence, length = token[0], len(token)
            elif token[0] == fence and len(token) >= length:
                fence = ""
            lines.append("")
        elif fence or line.startswith("    ") or line.startswith("\t"):
            lines.append("")
        else:
            lines.append(strip_inline_code_spans(line))
    return re.sub(r"<!--.*?-->", "", "\n".join(lines), flags=re.S)


class _HtmlLinks(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self.targets: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        for key, value in attrs:
            if key in {"href", "src"} and value:
                self.targets.append(value)


def _markdown_targets(text: str) -> list[str]:
    visible = _visible_markdown(text)
    definitions: dict[str, str] = {}
    for match in _RE_MD_DEF.finditer(visible):
        # CommonMark uses the first definition of a reference label.
        definitions.setdefault(match.group(1).casefold(), match.group(2))
    targets = [m.group(1) for m in _RE_MD_LINK.finditer(visible)]
    remaining = _RE_MD_LINK.sub("", _RE_MD_DEF.sub("", visible))
    for match in _RE_MD_REF.finditer(remaining):
        key = (match.group(2) or match.group(1)).casefold()
        if key in definitions:
            targets.append(definitions[key])
        elif match.group(2) is not None:
            raise ValueError(f"undefined Markdown reference [{key}]")
    html = _HtmlLinks()
    html.feed(visible)
    targets.extend(html.targets)
    return targets


def _tex_code(text: str) -> str:
    lines = []
    for line in text.splitlines():
        cut = len(line)
        for i, ch in enumerate(line):
            if ch == "%":
                j = i
                while j > 0 and line[j - 1] == "\\":
                    j -= 1
                if (i - j) % 2 == 0:
                    cut = i
                    break
        lines.append(line[:cut])
    return "\n".join(lines)


def _tex_dependencies(tex: Path, build_root: Path) -> list[Path]:
    dependencies = []
    text = _tex_code(tex.read_text(encoding="utf-8"))
    for match in _RE_TEX.finditer(text):
        command, raw = match.groups()
        for name in raw.split(",") if command == "bibliography" else [raw]:
            name = name.strip()
            if not name or "\\" in name or "#" in name:
                raise ValueError(f"{tex}: unresolved TeX dependency {raw!r}; supply a literal local reference")
            target = build_root / name
            if command.startswith("includegraphics") and not target.suffix:
                matches = [target.with_suffix(ext) for ext in _GRAPHICS_EXTS if target.with_suffix(ext).is_file()]
                if not matches:
                    raise ValueError(f"{tex}: missing graphic {name}")
                target = matches[0]
            elif not target.suffix:
                target = target.with_suffix(".bib" if command in {"bibliography", "addbibresource"} else ".tex")
            if not target.is_file():
                raise ValueError(f"{tex}: missing {command} dependency {name}")
            dependencies.append(Path(os.path.abspath(target)))
    # Project-local style/class files are ordinary dependencies. System TeX
    # packages remain requirements of the build environment, not copied guesses.
    for match in re.finditer(r"\\(usepackage|documentclass)\s*(?:\[[^\]]*\])?\s*\{([^}]+)\}", text):
        suffix = ".sty" if match.group(1) == "usepackage" else ".cls"
        for name in match.group(2).split(","):
            target = build_root / (name.strip() + suffix)
            if target.is_file():
                dependencies.append(target)
    return dependencies


def collect_tex_dependencies(main_tex: Path) -> tuple[list[Path], list[str]]:
    """Collect literal TeX inputs/figures/bibliographies relative to its build root."""
    seen: set[Path] = set()
    pending = [main_tex.absolute()]
    warnings = []
    while pending:
        item = pending.pop()
        if item in seen:
            continue
        if not item.is_file():
            warnings.append(f"missing TeX input: {item}")
            continue
        seen.add(item)
        if item.suffix.lower() in {".tex", ".sty", ".cls"}:
            try:
                pending.extend(_tex_dependencies(item, main_tex.parent))
            except ValueError as exc:
                warnings.append(str(exc))
    first = main_tex.absolute()
    return ([first] if first in seen else []) + sorted(seen - {first}), warnings


class Selection:
    def __init__(self, project_root: Path, destination: Path) -> None:
        self.root = project_root.resolve()
        self.destination = destination.resolve()
        self.files: dict[Path, Path] = {}
        self.directories: set[Path] = set()
        self.pending: list[tuple[Path, Path | None]] = []
        self.scanned: set[tuple[Path, Path | None]] = set()
        self.remote_links: set[str] = set()
        self.tex_roots: dict[Path, Path] = {}
        self.expected_hashes: dict[Path, str] = {}
        self.reading_files: list[Path] = []

    def _admit(self, source: Path) -> Path:
        source = Path(os.path.abspath(source))
        try:
            rel = source.relative_to(self.root)
            real = source.resolve(strict=True)
        except (ValueError, OSError, RuntimeError) as exc:
            raise ValueError(f"missing or outside-project dependency: {source}") from exc
        if not real.is_relative_to(self.root):
            raise ValueError(f"dependency escapes project through symlink: {source}")
        if ".git" in rel.parts:
            raise ValueError(f"repository internals are not research dependencies: {source}")
        if source == self.destination or self.destination in source.parents:
            raise ValueError(f"dependency points into the export destination: {source}")
        return source

    def add(self, source: Path, *, tex_root: Path | None = None, ancestors: frozenset[Path] = frozenset()) -> None:
        source = self._admit(source)
        rel = source.relative_to(self.root)
        real = source.resolve()
        if source.is_dir():
            if real in ancestors:
                raise ValueError(f"directory symlink cycle: {source}")
            if rel in self.directories:
                return
            self.directories.add(rel)
            for child in sorted(source.iterdir()):
                self.add(child, tex_root=tex_root, ancestors=ancestors | {real})
        elif source.is_file():
            self.files[rel] = source
            if tex_root is not None:
                self.tex_roots[source] = tex_root
            elif source.suffix.lower() == ".tex" and "\\documentclass" in _tex_code(source.read_text(encoding="utf-8")):
                self.tex_roots[source] = source.parent
            self.pending.append((source, tex_root))
        else:
            raise ValueError(f"unsupported non-file dependency: {source}")

    def close(self) -> None:
        while self.pending:
            source, tex_root = self.pending.pop()
            key = (source, tex_root)
            if key in self.scanned:
                continue
            self.scanned.add(key)
            suffix = source.suffix.lower()
            if suffix in {".md", ".markdown"}:
                for target in _markdown_targets(source.read_text(encoding="utf-8")):
                    target = target[1:-1] if target.startswith("<") and target.endswith(">") else target
                    target = re.sub(r"\\([\\ ()])", r"\1", target)
                    url = urlsplit(target)
                    if url.scheme or url.netloc:
                        if url.scheme == "file":
                            raise ValueError(f"{source}: absolute file URI is not portable: {target}")
                        self.remote_links.add(target)
                        continue
                    name = unquote(url.path)
                    if not name:
                        continue
                    if Path(name).is_absolute() or re.match(r"^[A-Za-z]:", name):
                        raise ValueError(f"{source}: absolute file link is not portable: {target}")
                    self.add(source.parent / name)
            elif suffix in {".tex", ".sty", ".cls"}:
                candidate_roots = [root for root in self.tex_roots.values() if source.is_relative_to(root)]
                build_root = tex_root or self.tex_roots.get(source) or (max(candidate_roots, key=lambda p: len(p.parts)) if candidate_roots else source.parent)
                self.tex_roots[source] = build_root
                for dependency in _tex_dependencies(source, build_root):
                    self.add(dependency, tex_root=build_root)

    def writer_export(self, manifest_path: Path) -> None:
        manifest_path = self._admit(manifest_path)
        manifest_bytes = manifest_path.read_bytes()
        payload = json.loads(manifest_bytes)
        if not isinstance(payload, dict):
            raise ValueError(f"writer export must be an object: {manifest_path}")
        if payload.get("tool") != "research-writer":
            raise ValueError(f"not a research-writer export manifest: {manifest_path}")
        if payload.get("status") in {"failed", "in_progress"}:
            raise ValueError(f"writer output is not complete: {manifest_path}")
        compilation = payload.get("compile", {})
        if not isinstance(compilation, dict):
            raise ValueError(f"invalid writer compilation record: {manifest_path}")
        if compilation.get("requested") and compilation.get("status") != "ok":
            raise ValueError(f"requested writer compilation is incomplete: {manifest_path}")
        self.add(manifest_path)
        self.expected_hashes[manifest_path.relative_to(self.root)] = hashlib.sha256(manifest_bytes).hexdigest()
        base = manifest_path.parent
        if compilation.get("status") == "ok":
            inputs, outputs = payload.get("input_hashes"), payload.get("output_hashes")
            pdf = compilation.get("pdf")
            if not isinstance(inputs, dict) or not inputs or not isinstance(outputs, dict) or not pdf or pdf not in outputs:
                raise ValueError(f"compiled writer output has no current input/PDF byte bindings: {manifest_path}; rebuild or explicitly select reviewed files")
            for key, expected in [*inputs.items(), *outputs.items()]:
                if not isinstance(key, str) or not isinstance(expected, str) or not re.fullmatch(r"[0-9a-f]{64}", expected):
                    raise ValueError(f"invalid build byte binding: {manifest_path}")
                bound = self._admit(base / key)
                if not bound.is_file() or hashlib.sha256(bound.read_bytes()).hexdigest() != expected:
                    raise ValueError(f"writer input/output changed since compilation: {bound}")
                self.expected_hashes[bound.relative_to(self.root)] = expected
                self.add(bound, tex_root=base if bound.suffix.lower() in {".tex", ".sty", ".cls"} else None)

        def add_path(value: object, *, tex: bool = False) -> None:
            if value is None:
                return
            if not isinstance(value, str) or not value.strip():
                raise ValueError(f"invalid path in writer export: {manifest_path}")
            target = self._admit(base / value)
            self.add(target, tex_root=base if tex else None)

        paper = payload.get("paper", {})
        if not isinstance(paper, dict) or not paper.get("main_tex"):
            raise ValueError(f"writer export has no declared main_tex: {manifest_path}")
        if compilation.get("status") == "ok" and paper["main_tex"] not in inputs:
            raise ValueError(f"compiled writer output does not bind main_tex: {manifest_path}")
        if compilation.get("status") == "ok":
            dependencies, issues = collect_tex_dependencies(base / paper["main_tex"])
            if issues:
                raise ValueError("cannot verify current manuscript dependencies: " + "; ".join(issues))
            for dependency in dependencies:
                relative = self._admit(dependency).relative_to(self.root)
                if relative not in self.expected_hashes:
                    raise ValueError(f"current build receipt does not bind TeX input: {dependency}; rebuild before automatic PDF export")
        reading = compilation.get("pdf") if compilation.get("status") == "ok" else paper["main_tex"]
        self.reading_files.append(self._admit(base / reading).relative_to(self.root))
        for field in ("main_tex", "latexmkrc", "figures_dir"):
            add_path(paper.get(field), tex=field == "main_tex")
        bibliography = paper.get("bib", [])
        if isinstance(bibliography, dict):
            bibliography = bibliography.values()
        elif not isinstance(bibliography, list):
            raise ValueError(f"invalid writer bibliography paths: {manifest_path}")
        for item in bibliography:
            add_path(item)
        for field in ("pdf", "log"):
            if compilation.get("status") == "ok":
                add_path(compilation.get(field))
        add_path(payload.get("paper_manifest"))
        for item in payload.get("trace", {}).values():
            add_path(item)
        run_card = payload.get("run_card")
        if isinstance(run_card, dict):
            add_path(run_card.get("path"))
        # Ordinary JSON is not guessed for dependencies. These are the declared
        # output fields of the existing writer export contract.

    def copy_to(self, staging: Path) -> None:
        for rel in sorted(self.directories):
            (staging / rel).mkdir(parents=True, exist_ok=True)
        for rel, source in sorted(self.files.items()):
            dest = staging / rel
            dest.parent.mkdir(parents=True, exist_ok=True)
            # Recheck immediately before reading; never preserve a symlink that
            # will depend on the source project after the bundle is moved.
            self._admit(source)
            shutil.copy2(source, dest, follow_symlinks=True)
            if hashlib.sha256(source.read_bytes()).digest() != hashlib.sha256(dest.read_bytes()).digest():
                raise ValueError(f"source changed while copying: {source}")
            if rel in self.expected_hashes and hashlib.sha256(dest.read_bytes()).hexdigest() != self.expected_hashes[rel]:
                raise ValueError(f"bound build input/output changed while exporting: {source}")
        # Re-resolve all supported document links from the isolated copy. This
        # checks moved paths without access to the source project's files.
        check = Selection(staging, staging / "__export_destination__")
        for rel in self.files:
            root = self.tex_roots.get(self.root / rel)
            check.add(staging / rel, tex_root=staging / root.relative_to(self.root) if root else None)
        check.close()
        missing = set(check.files) - set(self.files)
        if missing:
            raise ValueError(f"copied dependency set changed during export: {sorted(map(str, missing))}")


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--tag", required=True, help="Run tag / bundle label.")
    ap.add_argument("--out", default="export", help="Output directory (default: export).")
    ap.add_argument("--tex", default="", help="Main TeX file; collect its literal inputs, figures and bibliography.")
    ap.add_argument("--bib", default="", help="Additional project-local bibliography.")
    ap.add_argument("--include", action="append", default=[], help="Explicit project-relative result or dependency; repeat as needed.")
    ap.add_argument("--writer-export", action="append", default=[], help="Existing research-writer export_manifest.json to ingest.")
    ap.add_argument("--without-project-docs", action="store_true", help="Export only explicit selections; do not seed root documents or the selected run.")
    ap.add_argument("--force", action="store_true", help="Replace an existing bundle only after the new copy is complete.")
    args = ap.parse_args()
    project = _find_project_root(Path.cwd())
    tag = args.tag.strip()
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]*", tag) or ".." in tag:
        print("ERROR: tag must be one safe path segment", file=sys.stderr)
        return 2
    destination = (project / args.out / f"paper_bundle_{tag}").resolve()
    staging: Path | None = None
    try:
        canonical_run_root(project)
        if destination == project or destination in project.parents:
            raise ValueError("export destination must not equal or contain the source project")
        folded = tuple(part.lower() for part in destination.parts)
        if any(part == "team" and folded[i + 1:i + 2] == ("runs",) for i, part in enumerate(folded)):
            raise ValueError("historical run evidence is read-only; cannot export there")
        selected_run = read_run_directory(project, tag)
        if selected_run and (destination == selected_run or selected_run in destination.parents or destination in selected_run.parents):
            raise ValueError("export destination overlaps the selected run")
        if destination.exists() and not args.force:
            raise ValueError(f"bundle already exists: {destination} (use --force to replace)")
        selected = Selection(project, destination)
        notes = []
        if not args.without_project_docs:
            for name in CORE_DOCS:
                source = project / name
                if source.exists():
                    selected.add(source)
                else:
                    notes.append(f"Not present in source project: {name}")
            if selected_run:
                selected.add(selected_run)
            else:
                notes.append(f"No run directory found for {tag}; only the selected documents are included.")
        for name in args.include:
            selected.add(project / name)
        if args.tex:
            main_tex = project / args.tex
            selected.add(main_tex, tex_root=main_tex.parent)
        if args.bib:
            selected.add(project / args.bib)
        for name in args.writer_export:
            selected.writer_export(project / name)
        if not selected.files:
            raise ValueError("no files selected; use --include, --tex or --writer-export")
        selected.close()
        if Path("MANIFEST.md") in selected.files:
            raise ValueError("selected project MANIFEST.md would collide with the bundle manifest")
        destination.parent.mkdir(parents=True, exist_ok=True)
        staging = Path(tempfile.mkdtemp(prefix=f".{destination.name}-", dir=destination.parent))
        selected.copy_to(staging)
        lines = [
            f"# Research bundle — {tag}", "",
            "Files retain their project-relative paths and original bytes.",
            "This is a local file bundle, not scientific acceptance or confirmation of host delivery.", "",
            "## Read first", "",
        ]
        if Path("research_notebook.md") in selected.files:
            lines.append("- [Research notebook](research_notebook.md)")
        for name in args.include:
            rel = Path(os.path.abspath(project / name)).relative_to(project).as_posix()
            label = rel.replace("\\", "\\\\").replace("[", "\\[").replace("]", "\\]")
            lines.append(f"- [{label}]({quote(rel, safe='/')})")
        for reading in selected.reading_files:
            rel = reading.as_posix()
            label = rel.replace("\\", "\\\\").replace("[", "\\[").replace("]", "\\]")
            lines.append(f"- [{label}]({quote(rel, safe='/')})")
        if Path("project_index.md") in selected.files:
            lines.append("- [Project index](project_index.md)")
        lines += ["", "## Included files", "", f"- File count: {len(selected.files)}",
                  "- Collection follows supported local Markdown and literal TeX file references.",
                  "- Links may bring in other runs or whole referenced directories; their files are listed below.",
                  "- Runtime imports, arbitrary JSON strings and remote source content are not inferred.", ""]
        for rel, source in sorted(selected.files.items()):
            digest = hashlib.sha256((staging / rel).read_bytes()).hexdigest()
            lines.append(f"- {rel.as_posix()} — sha256:{digest}")
        if notes:
            lines += ["", "## Source availability", "", *[f"- {note}" for note in notes]]
        if selected.remote_links:
            lines += ["", "## Remote links (not copied or verified)", "", *[f"- {url}" for url in sorted(selected.remote_links)]]
        (staging / "MANIFEST.md").write_text("\n".join(lines) + "\n", encoding="utf-8")
        if destination.exists():
            shutil.rmtree(destination)
        staging.rename(destination)
        staging = None
        print(f"[ok] wrote bundle: {destination}")
        print(f"[ok] wrote manifest: {destination / 'MANIFEST.md'}")
        return 0
    except (ValueError, OSError, RuntimeError) as exc:
        print(f"ERROR: incomplete bundle: {exc}", file=sys.stderr)
        return 2
    finally:
        if staging is not None:
            shutil.rmtree(staging, ignore_errors=True)


if __name__ == "__main__":
    raise SystemExit(main())
