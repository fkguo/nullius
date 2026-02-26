# Codebase Gotchas

## [2026-02-24] Background Agent Line-Merging Corruption Pattern

**Context**: NEW-R03a silent exception audit used a background agent to annotate `except Exception:` blocks with `# CONTRACT-EXEMPT: CODE-01.5 {reason}` comments.

**Discovery**: The background agent (Task tool with subagent) systematically corrupted code when annotating `except Exception:` lines. The pattern:

1. When the agent added `# CONTRACT-EXEMPT` annotation to `except Exception:`, it frequently **deleted the line immediately following** the except clause's body. 
2. The corruption specifically hit lines that came after `pass`, `return None`, `return False`, `continue`, `lines = []`, `argv2 = []` etc. — i.e., the last statement in the except block.
3. The agent also renamed functions (`_require_trust_project` → `_v3_trust_audit`, `_paper_reviser_round_ok` → `_validate_round_output`) without updating call sites.
4. The agent removed type annotations (`versions: dict[str, Any] = {` → `versions = {`).

**Files affected**: 12+ files across the codebase:
- `literature_survey.py`: 3 corruptions (missing `title` extraction, missing `rk` extraction, missing blank lines)
- `method_design.py`: 2 corruptions (missing `if pp.is_absolute():`, missing `_act("write_file", "ok", ...)`)
- `run_card_schema.py`: 1 corruption (missing `if pp.is_absolute():`)
- `skill_proposal.py`: 1 corruption (missing `if not isinstance(rc, dict):`)
- `w3_paper_reviser_evidence.py`: 1 corruption (missing `raise ValueError(...)`)
- `w3_paper_reviser.py`: 3 corruptions (missing `for v in kb_vals:`, missing `gate_satisfied = gate_satisfied or {}`, removed type annotation)
- `w_compute.py`: 1 corruption (function renamed without updating call site)
- `ecosystem_bundle.py`: 1 corruption (removed `.strip()` from list comprehension)
- `orchestrator_cli.py`: 1 corruption (missing `return None`)
- `orchestrator_state.py`: 1 corruption (merged `return None` with next `if` statement)
- `w3_paper_reviser_utils.py`: 1 corruption (merged `return None` with next function def + renamed function)

**Impact**: Tests caught most corruptions (UnboundLocalError, NameError, ImportError), but some were silent behavioral changes (e.g., removed `.strip()`, removed `if pp.is_absolute():` guard).

**Lesson**: 
- NEVER use background agents for bulk edits across many files
- If a background agent is used for annotations, run comprehensive tests AND manually verify the git diff for unexpected deletions
- The specific pattern of "deleted the line after the except block" should be checked with: `git diff | grep '^-[^-]' | grep -v 'except Exception:'`
