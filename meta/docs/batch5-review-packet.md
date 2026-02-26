# Phase 2 Batch 5 — Review Packet (R1)

## Scope

4 items: NEW-02, NEW-03, NEW-04, NEW-R08

### Verification results

- `pnpm -r build`: 8 packages built clean
- `python -m pytest packages/hep-autoresearch/tests/ -q`: 159 passed, 0 failed
- `bash meta/scripts/codegen.sh`: 22 schemas processed, approval-packet-v1.ts generated
- New tests: 11 (6 approval_packet + 5 report_renderer)

---

## NEW-02: Approval Packet Trio

New JSON Schema + Python renderer + CLI integration.

**Files to review:**
- `meta/schemas/approval_packet_v1.schema.json` — new schema
- `packages/hep-autoresearch/src/hep_autoresearch/toolkit/approval_packet.py` — new renderer (ApprovalPacketData dataclass + render_short/render_full/render_json/write_trio)
- `packages/shared/src/generated/approval-packet-v1.ts` — codegen output (auto-generated, sanity check only)
- `meta/generated/python/approval_packet_v1.py` — codegen output (auto-generated, sanity check only)

**Key design decisions:**
- Zero external dependencies (no Jinja2) — uses Python string formatting
- `render_short` enforces ≤60 line limit with overflow pointer to packet.md
- `render_json` only includes optional fields when non-empty (sparse JSON)
- `write_trio` writes 3 files: packet_short.md, packet.md, approval_packet_v1.json

**CLI integration (in orchestrator_cli.py):**
- `_request_approval()` now constructs `ApprovalPacketData` and calls `write_trio()` instead of inline packet generation
- Old gate_resolution_trace inline formatting replaced by dataclass field

## NEW-03: Approvals CLI Show Command

**Files to review:**
- `packages/hep-autoresearch/src/hep_autoresearch/orchestrator_cli.py` — `cmd_approvals_show()` function + argparse `approvals show` subcommand

**Key points:**
- Supports `--run-id`, `--gate` filter, `--format short|full|json`
- Falls back gracefully: short→full→warn if files missing
- Returns 0 even when no approvals found (info message, not error)

## NEW-04: Self-Contained Human Report

**Files to review:**
- `packages/hep-autoresearch/src/hep_autoresearch/toolkit/report_renderer.py` — RunResult dataclass + collect_run_result + render_md + render_tex
- `packages/hep-autoresearch/src/hep_autoresearch/orchestrator_cli.py` — `cmd_report_render()` function + argparse `report render` subcommand

**Key points:**
- `collect_run_result` reads analysis.json + computes SHA256 for all artifacts
- `render_md` produces Markdown with audit pointer table (URI + SHA256)
- `render_tex` produces compilable LaTeX with booktabs tables
- `_tex_escape` handles all LaTeX special characters

## NEW-R08: Skills LOC Budget (CONTRACT-EXEMPT)

**Files to review (1-line annotation each):**
- `skills/paper-reviser/scripts/bin/paper_reviser_edit.py` — line 1
- `skills/research-team/scripts/bin/literature_fetch.py` — line 1
- `skills/review-swarm/scripts/bin/run_multi_task.py` — line 1
- `skills/auto-relay/scripts/relay.py` — line 1
- `skills/research-writer/scripts/bin/research_writer_learn_discussion_logic.py` — line 1
- `skills/research-team/scripts/bin/build_team_packet.py` — line 1

**Pattern:** `# CONTRACT-EXEMPT: CODE-01.1 sunset:2026-06-01 — <reason>`

**Validation:** `meta/scripts/check_loc.py` already supports this pattern and sunset dates.

## Tests

**Files to review:**
- `packages/hep-autoresearch/tests/test_approval_packet.py` — 6 tests
- `packages/hep-autoresearch/tests/test_report_renderer.py` — 5 tests

## Full diff

Run `git diff` in the repo root to see all changes (14 files modified, ~300 insertions).

---

## Review checklist

1. Schema correctness: required fields, types, additionalProperties
2. Renderer correctness: render_short ≤60 lines, render_full all sections, render_json matches schema
3. CLI integration: argparse wiring, error handling, exit codes
4. Report renderer: SHA256 computation, LaTeX escaping, audit pointer format
5. Tests: coverage of key paths, assertion quality, no placeholder tests
6. CONTRACT-EXEMPT: correct pattern, reasonable sunset dates, accurate LOC counts in comments
