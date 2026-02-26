# Phase 2 Batch 5 — Review Packet (R3, Full)

## Scope

4 items: NEW-02, NEW-03, NEW-04, NEW-R08

### Verification results

- `python -m pytest packages/hep-autoresearch/tests/ -q`: 160 passed, 0 failed
- 12 new tests (7 approval_packet + 5 report_renderer)

### R1→R2 fixes applied

1. **Shebang / CONTRACT-EXEMPT order** (Codex R1 BLOCKING): All 6 scripts now have shebang on line 1, CONTRACT-EXEMPT on line 2
2. **render_short overflow** (Codex R1 BLOCKING): Overflow note lines subtracted from truncation point; regression test added
3. **`approvals show --format json` output** (Codex R2 BLOCKING): Changed from concatenated JSON blobs to a single JSON array via `json_packets: list[dict]` collector + `json.dumps(json_packets, ...)`

### R1 Gemini false positives (dismissed)

1. `write_trio` already has `approval_dir.mkdir(parents=True, exist_ok=True)`
2. `_sha256_file` already uses `open(path, "rb")`

---

## IMPORTANT: How to review

**Read the actual source files listed below.** Each path is an absolute path in the repository. Read the file contents directly — do NOT rely on code snippets in this packet.

---

## NEW-02: Approval Packet Trio

New JSON Schema + Python renderer + CLI integration.

**Files to read and review:**
- `/home/user/Coding/Agents/autoresearch-lab/meta/schemas/approval_packet_v1.schema.json` — new schema
- `/home/user/Coding/Agents/autoresearch-lab/packages/hep-autoresearch/src/hep_autoresearch/toolkit/approval_packet.py` — renderer (ApprovalPacketData dataclass + render_short/render_full/render_json/write_trio)
- `/home/user/Coding/Agents/autoresearch-lab/packages/shared/src/generated/approval-packet-v1.ts` — codegen output (sanity check)
- `/home/user/Coding/Agents/autoresearch-lab/meta/generated/python/approval_packet_v1.py` — codegen output (sanity check)

**Key design decisions:**
- Zero external dependencies — uses Python string formatting
- `render_short` enforces ≤60 line limit with overflow pointer to packet.md
- `render_json` only includes optional fields when non-empty (sparse JSON)
- `write_trio` writes 3 files: packet_short.md, packet.md, approval_packet_v1.json

## NEW-03: Approvals CLI Show Command

**Files to read and review:**
- `/home/user/Coding/Agents/autoresearch-lab/packages/hep-autoresearch/src/hep_autoresearch/orchestrator_cli.py` — focus on `cmd_approvals_show()` (around line 1574) + argparse wiring for `approvals show`

**Key points:**
- Supports `--run-id`, `--gate` filter, `--format short|full|json`
- `--format json` outputs a single valid JSON array (fixed in R2→R3)
- Falls back gracefully: short→full→warn if files missing
- Returns 0 even when no approvals found (info message, not error)

## NEW-04: Self-Contained Human Report

**Files to read and review:**
- `/home/user/Coding/Agents/autoresearch-lab/packages/hep-autoresearch/src/hep_autoresearch/toolkit/report_renderer.py` — RunResult dataclass + collect_run_result + render_md + render_tex
- `/home/user/Coding/Agents/autoresearch-lab/packages/hep-autoresearch/src/hep_autoresearch/orchestrator_cli.py` — focus on `cmd_report_render()` + argparse wiring for `report render`

**Key points:**
- `collect_run_result` reads analysis.json + computes SHA256 for all artifacts
- `render_md` produces Markdown with audit pointer table (URI + SHA256)
- `render_tex` produces compilable LaTeX with booktabs tables
- `_tex_escape` handles all LaTeX special characters

## NEW-R08: Skills LOC Budget (CONTRACT-EXEMPT)

**Files to read and review (check line 1-2 of each):**
- `/home/user/Coding/Agents/autoresearch-lab/skills/auto-relay/scripts/relay.py`
- `/home/user/Coding/Agents/autoresearch-lab/skills/paper-reviser/scripts/bin/paper_reviser_edit.py`
- `/home/user/Coding/Agents/autoresearch-lab/skills/research-team/scripts/bin/build_team_packet.py`
- `/home/user/Coding/Agents/autoresearch-lab/skills/research-team/scripts/bin/literature_fetch.py`
- `/home/user/Coding/Agents/autoresearch-lab/skills/research-writer/scripts/bin/research_writer_learn_discussion_logic.py`
- `/home/user/Coding/Agents/autoresearch-lab/skills/review-swarm/scripts/bin/run_multi_task.py`

**Pattern:** Line 1 = `#!/usr/bin/env python3`, Line 2 = `# CONTRACT-EXEMPT: CODE-01.1 sunset:2026-06-01 — <reason>`

## Tests

**Files to read and review:**
- `/home/user/Coding/Agents/autoresearch-lab/packages/hep-autoresearch/tests/test_approval_packet.py` — 7 tests
- `/home/user/Coding/Agents/autoresearch-lab/packages/hep-autoresearch/tests/test_report_renderer.py` — 5 tests
