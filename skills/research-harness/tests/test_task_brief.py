"""Behavioral checks for authored task briefs and their byte-freshness metadata.

These tests exercise the public CLI. A fresh brief is a byte-level claim only;
its prose need not follow a checklist and receives no scientific endorsement.
"""
from __future__ import annotations

import json
import os
import re
import stat
import subprocess
import sys
from pathlib import Path

import pytest


SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "task_brief.py"
BRIEF = "artifacts/runs/focused-task/brief.md"
BODY = "已有事实：输入已保存。\r\n\r\n<!-- ordinary authored comment -->\r\n未知项留待核查。\r\n".encode("utf-8")


def project(tmp_path: Path, body: bytes = BODY) -> Path:
    root = tmp_path / "project"
    (root / BRIEF).parent.mkdir(parents=True)
    (root / BRIEF).write_bytes(body)
    (root / "research_plan.md").write_bytes(b"Original plan\n")
    (root / "inputs").mkdir()
    (root / "inputs" / "raw sample.bin").write_bytes(b"\x00\xff\r\noriginal input\x00")
    return root


def invoke(root: Path, action: str, *sources: str, brief: str = BRIEF, extra=()):
    argv = [sys.executable, str(SCRIPT), action, "--project-root", str(root), "--brief", brief]
    for source in sources:
        argv.extend(["--source", source])
    argv.extend(extra)
    result = subprocess.run(argv, capture_output=True, timeout=15,
                            env={**os.environ, "PYTHONDONTWRITEBYTECODE": "1"})
    try:
        report = json.loads(result.stdout)
    except (ValueError, UnicodeDecodeError) as exc:
        pytest.fail(f"CLI did not emit JSON: exit={result.returncode}, stdout={result.stdout!r}, stderr={result.stderr!r}: {exc}")
    assert isinstance(report, dict)
    return result.returncode, report


def expect(root: Path, action: str, *sources: str, status: str, code: int, **kwargs):
    actual, report = invoke(root, action, *sources, **kwargs)
    assert (actual, report.get("status")) == (code, status), report
    return report


def capture(root: Path, *sources: str):
    return expect(root, "capture", *(sources or ("research_plan.md",)), status="captured", code=0)


def snapshot(root: Path):
    """Exclude access time; opening a source must not otherwise alter it."""
    result = {}
    for path in root.rglob("*"):
        info = path.lstat()
        result[path.relative_to(root).as_posix()] = (
            stat.S_IFMT(info.st_mode), stat.S_IMODE(info.st_mode), info.st_mtime_ns,
            path.read_bytes() if stat.S_ISREG(info.st_mode) else None,
        )
    return result


def metadata_json_span(brief: Path):
    """Locate the added JSON comment without depending on its private marker."""
    content = brief.read_bytes()
    decoder = json.JSONDecoder()
    for comment in re.finditer(rb"<!--.*?-->", content, re.DOTALL):
        for brace in re.finditer(rb"\{", comment.group()):
            start = comment.start() + brace.start()
            try:
                text = content[start:comment.end() - 3].decode("utf-8")
                value, length = decoder.raw_decode(text)
            except (ValueError, UnicodeDecodeError):
                continue
            if isinstance(value, dict):
                return content, start, start + len(text[:length].encode("utf-8")), value
    pytest.fail("capture did not attach JSON comment metadata")


def alter_metadata(brief: Path, transform):
    content, start, end, value = metadata_json_span(brief)
    replacement = transform(value)
    if not isinstance(replacement, bytes):
        replacement = json.dumps(replacement, ensure_ascii=False).encode("utf-8")
    brief.write_bytes(content[:start] + replacement + content[end:])


def test_capture_preserves_authored_bytes_mode_and_original_sources(tmp_path):
    root = project(tmp_path)
    brief = root / BRIEF
    brief.chmod(0o640)
    before = snapshot(root)
    capture(root, "research_plan.md", "inputs/raw sample.bin")
    after = snapshot(root)
    assert brief.read_bytes().endswith(BODY)
    assert stat.S_IMODE(brief.stat().st_mode) == 0o640
    assert before.keys() == after.keys(), "capture must not leave sidecar files"
    assert {key: value for key, value in before.items() if key != BRIEF and value[0] == stat.S_IFREG} == {
        key: value for key, value in after.items() if key != BRIEF and value[0] == stat.S_IFREG
    }
    captured = snapshot(root)
    expect(root, "check", status="fresh", code=0)
    assert snapshot(root) == captured, "check must be read-only"


@pytest.mark.parametrize("body", [b"one freeform sentence", "事实与下一步，没有固定标题。\n".encode()])
def test_no_required_heading_or_final_newline(tmp_path, body):
    root = project(tmp_path, body)
    capture(root)
    assert (root / BRIEF).read_bytes().endswith(body)
    expect(root, "check", status="fresh", code=0)


def test_nonselected_changes_do_not_make_a_brief_stale(tmp_path):
    root = project(tmp_path)
    capture(root)
    (root / "inputs/raw sample.bin").write_bytes(b"unselected replacement")
    (root / "new-unselected-note.md").write_text("new note", encoding="utf-8")
    expect(root, "check", status="fresh", code=0)


@pytest.mark.parametrize("target", [BRIEF, "research_plan.md", "inputs/raw sample.bin"])
def test_any_selected_byte_change_is_stale_even_if_size_and_mtime_match(tmp_path, target):
    root = project(tmp_path)
    capture(root, "research_plan.md", "inputs/raw sample.bin")
    path = root / target
    before = path.stat()
    data = path.read_bytes()
    if target == BRIEF:
        replacement = BODY.replace(b"ordinary", b"changed!", 1)
        assert len(replacement) == len(BODY)
        data = data.replace(BODY, replacement, 1)
    else:
        data = bytes([data[0] ^ 1]) + data[1:]
    path.write_bytes(data)
    os.utime(path, ns=(before.st_atime_ns, before.st_mtime_ns))
    frozen = snapshot(root)
    expect(root, "check", status="stale", code=1)
    assert snapshot(root) == frozen


def test_missing_selected_source_is_stale_and_check_does_not_recreate_it(tmp_path):
    root = project(tmp_path)
    capture(root, "research_plan.md", "inputs/raw sample.bin")
    (root / "research_plan.md").unlink()
    before = snapshot(root)
    expect(root, "check", status="stale", code=1)
    assert snapshot(root) == before


def test_refresh_rebinds_edited_body_and_a_new_explicit_source_set(tmp_path):
    root = project(tmp_path)
    capture(root)
    brief = root / BRIEF
    edited = BODY + "新问题与下一步。\n".encode()
    brief.write_bytes(brief.read_bytes().replace(BODY, edited, 1))
    (root / "inputs/raw sample.bin").write_bytes(b"revised input")
    expect(root, "check", status="stale", code=1)
    capture(root, "inputs/raw sample.bin")
    assert brief.read_bytes().endswith(edited)
    expect(root, "check", status="fresh", code=0)
    (root / "research_plan.md").write_bytes(b"no longer selected")
    expect(root, "check", status="fresh", code=0)
    (root / "inputs/raw sample.bin").write_bytes(b"changed again")
    expect(root, "check", status="stale", code=1)


def test_capture_can_refresh_changed_selected_source_without_rewriting_body(tmp_path):
    root = project(tmp_path)
    capture(root)
    (root / "research_plan.md").write_bytes(b"Updated plan\n")
    expect(root, "check", status="stale", code=1)
    capture(root)
    assert (root / BRIEF).read_bytes().endswith(BODY)
    expect(root, "check", status="fresh", code=0)


def test_recorded_paths_remain_portable_when_project_moves(tmp_path):
    root = project(tmp_path)
    capture(root, "research_plan.md", "inputs/raw sample.bin")
    relocated = tmp_path / "relocated project"
    root.rename(relocated)
    expect(relocated, "check", status="fresh", code=0)


@pytest.mark.parametrize("bad_source", ["../outside.md", "/absolute.md", "inputs/../research_plan.md", BRIEF])
def test_capture_rejects_escaping_or_self_referencing_sources(tmp_path, bad_source):
    root = project(tmp_path)
    before = snapshot(root)
    expect(root, "capture", bad_source, status="invalid", code=2)
    assert snapshot(root) == before


def test_duplicate_sources_are_rejected_without_mutation(tmp_path):
    root = project(tmp_path)
    before = snapshot(root)
    expect(root, "capture", "research_plan.md", "research_plan.md", status="invalid", code=2)
    assert snapshot(root) == before


@pytest.mark.parametrize("bad_brief", ["../brief.md", "/absolute.md", "brief.md", "artifacts/runs/brief.md", "artifacts/runs/../brief.md"])
def test_brief_must_be_in_a_project_run_directory(tmp_path, bad_brief):
    root = project(tmp_path)
    before = snapshot(root)
    expect(root, "capture", "research_plan.md", brief=bad_brief, status="invalid", code=2)
    assert snapshot(root) == before


@pytest.mark.parametrize("invalid_body", [b"", b" \r\n\t", b"\xff not UTF-8"])
def test_capture_rejects_blank_or_non_utf8_authored_body(tmp_path, invalid_body):
    root = project(tmp_path, invalid_body)
    before = snapshot(root)
    expect(root, "capture", "research_plan.md", status="invalid", code=2)
    assert snapshot(root) == before


def test_capture_requires_at_least_one_explicit_existing_regular_source(tmp_path):
    root = project(tmp_path)
    expect(root, "capture", status="invalid", code=2)
    expect(root, "capture", "missing.md", status="invalid", code=2)
    expect(root, "capture", "inputs", status="invalid", code=2)


def test_check_without_attached_metadata_is_invalid(tmp_path):
    root = project(tmp_path)
    expect(root, "check", status="invalid", code=2)


@pytest.mark.parametrize("operation", ["capture", "check"])
@pytest.mark.parametrize("link_kind", ["source-file", "source-directory", "brief-file", "brief-directory"])
def test_all_symlink_components_are_rejected(tmp_path, operation, link_kind):
    root = project(tmp_path)
    if operation == "check":
        capture(root)
    if link_kind == "source-file":
        target = root / "research_plan.md"
    elif link_kind == "source-directory":
        target = root / "inputs"
    elif link_kind == "brief-file":
        target = root / BRIEF
    else:
        target = (root / BRIEF).parent
    saved = tmp_path / "symlink-target"
    target.rename(saved)
    target.symlink_to(saved, target_is_directory=saved.is_dir())
    source = "inputs/raw sample.bin" if link_kind == "source-directory" else "research_plan.md"
    if operation == "check" and link_kind == "source-directory":
        # Ensure the replaced directory is one of the recorded source paths.
        root2 = project(tmp_path / "selected-directory")
        capture(root2, "inputs/raw sample.bin")
        selected = root2 / "inputs"
        moved = tmp_path / "selected-inputs"
        selected.rename(moved)
        selected.symlink_to(moved, target_is_directory=True)
        root = root2
    expect(root, operation, *((source,) if operation == "capture" else ()), status="invalid", code=2)


@pytest.mark.parametrize("operation", ["capture", "check"])
@pytest.mark.parametrize("corruption", ["unknown-field", "malformed-json", "version", "duplicate-key", "duplicate-comment"])
def test_invalid_existing_metadata_is_never_silently_replaced(tmp_path, operation, corruption):
    root = project(tmp_path)
    capture(root)
    brief = root / BRIEF
    if corruption == "unknown-field":
        alter_metadata(brief, lambda doc: {**doc, "unexpected_test_field": True})
    elif corruption == "malformed-json":
        alter_metadata(brief, lambda doc: b"{ not valid JSON }")
    elif corruption == "duplicate-key":
        def duplicate_key(doc):
            key = next(iter(doc))
            encoded = json.dumps(doc, ensure_ascii=False)
            return (encoded[:-1] + "," + json.dumps(key) + ":" + json.dumps(doc[key]) + "}").encode()
        alter_metadata(brief, duplicate_key)
    elif corruption == "version":
        def unsupported_version(doc):
            # Discover the version discriminant from the generated record;
            # its name and original spelling are not an asserted contract.
            for key, value in doc.items():
                if "version" in key.lower() or key.lower() == "schema":
                    doc[key] = 999999 if isinstance(value, int) else "unsupported-test-schema"
                    return doc
            pytest.fail("attached metadata has no discoverable version discriminator")
        alter_metadata(brief, unsupported_version)
    else:
        content = brief.read_bytes()
        comment = next(re.finditer(rb"<!--.*?-->", content, re.DOTALL)).group()
        brief.write_bytes(comment + b"\n\n" + content)
    before = snapshot(root)
    expect(root, operation, *(("research_plan.md",) if operation == "capture" else ()), status="invalid", code=2)
    assert snapshot(root) == before


@pytest.mark.parametrize("body", [
    b"Authored text\n<!-- nullius-task-brief\n{}\n-->\n",
    b"# Work\n\n<!-- nullius-task-brief\nnot JSON\n-->\n",
])
def test_capture_refuses_reserved_metadata_inside_uncaptured_body(tmp_path, body):
    root = project(tmp_path, body=body)
    before = snapshot(root)
    expect(root, "capture", "research_plan.md", status="invalid", code=2)
    assert snapshot(root) == before
