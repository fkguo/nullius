from __future__ import annotations

import importlib.util
from pathlib import Path


def _load_review_contract_module():
    repo_root = Path(__file__).resolve().parents[1]
    module_path = repo_root / "scripts" / "bin" / "review_contract.py"
    spec = importlib.util.spec_from_file_location("review_contract", module_path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"Failed to load module spec: {module_path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_markdown_contract_validation_accepts_required_shape() -> None:
    mod = _load_review_contract_module()
    text = """VERDICT: READY

## Blockers
- none

## High-severity
- none

## Non-blocking
- none

## Real-research fit
- yes

## Robustness & safety
- yes

## Specific patch suggestions
- none
"""
    assert mod.check_review_contract_text(text) == []


def test_json_contract_validation_accepts_fenced_json() -> None:
    mod = _load_review_contract_module()
    text = """```json
{"verdict":"PASS","blocking_issues":[],"summary":"usable"}
```"""
    assert mod.check_review_contract_text(text) == []
    assert mod.first_verdict(Path(__file__)) is None  # smoke: nonexistent contract data isn't inferred from this file


def test_sanitize_contract_text_strips_preamble_before_verdict() -> None:
    mod = _load_review_contract_module()
    text = "\n\npreamble\nVERDICT: NOT_READY\n\n## Blockers\n- one\n"
    assert mod.sanitize_contract_text(text).startswith("VERDICT: NOT_READY\n")


def test_sanitize_gemini_output_recovers_json_payload(tmp_path: Path) -> None:
    mod = _load_review_contract_module()
    out = tmp_path / "gemini_output.txt"
    out.write_text(
        "MCP issues detected. Run /mcp list for status.\n"
        "thought: checking packet\n"
        '{"verdict":"PASS","blocking_issues":[],"summary":"usable"}\n',
        encoding="utf-8",
    )

    changed = mod.sanitize_gemini_output(out)

    assert changed is True
    assert out.read_text(encoding="utf-8") == '{"verdict":"PASS","blocking_issues":[],"summary":"usable"}\n'


def test_first_verdict_maps_json_pass_to_ready(tmp_path: Path) -> None:
    mod = _load_review_contract_module()
    out = tmp_path / "review.json"
    out.write_text('{"verdict":"PASS","blocking_issues":[],"summary":"ok"}\n', encoding="utf-8")
    assert mod.first_verdict(out) == "VERDICT: READY"
