# SOTA Notes — Structured Gate Semantics (2026-03-05)

## Scope

This note summarizes implementation-facing best practices for multi-agent convergence gates, with focus on:
- JSON schema contract
- fail-closed parsing behavior
- format-drift hardening
- adjudication pipeline wiring

## Sources

1. JSON Schema Draft 2020-12 (Core/Validation)
   - https://json-schema.org/draft/2020-12
   - https://json-schema.org/draft/2020-12/json-schema-validation
2. OWASP secure design principles (Fail Safe / Secure by Default)
   - https://devguide.owasp.org/hi/02-foundations/03-security-principles/
3. OpenAI Structured Outputs + strict schema requirements
   - https://platform.openai.com/docs/guides/function-calling/how-do-i-ensure-the-model-calls-the-correct-function
   - https://platform.openai.com/docs/guides/structured-outputs/supported-schemas.gz?api-mode=responses
4. Anthropic tool-use schema guidance
   - https://platform.claude.com/docs/en/agents-and-tools/tool-use/implement-tool-use

## SOTA takeaways (implementation-relevant)

1. **Schema-first machine interface**
   - Gate outputs should be represented as a strict JSON object contract (required keys + bounded enums + explicit typing).
   - Consumer logic should read structured fields, not prose labels/headings.

2. **Fail-closed on parse drift**
   - Missing or unparseable contract fields must produce an explicit parse-error state.
   - Parse errors should map to a dedicated non-success exit code and must not silently degrade to pass.

3. **Structure over JSON validity**
   - JSON validity alone is insufficient; gate safety requires schema adherence.
   - Strict-mode constraints (e.g., complete required sets, controlled properties) improve deterministic consumption and reduce ambiguity.

4. **Output-channel separation**
   - Human-readable markdown logs can be kept for inspection.
   - Pass/fail and automation decisions must rely on structured JSON SoT only.

5. **Adjudication hardening**
   - Consumer should verify status/exit-code consistency from structured payload before control-flow transitions.
   - Unknown status values should be treated as parse-error (fail-closed), not best-effort fallback.

## Applied decisions in NEW-SEM-07

- Unified convergence result schema (`convergence_gate_result_v1`) with explicit `status` / `exit_code` / `report_status` / `meta`.
- Both team and draft convergence gates now emit structured JSON and validate before returning.
- Parse drift in key fields now returns `parse_error` (`exit_code=2`).
- Shell consumers switched to read structured JSON artifact and enforce status/exit consistency checks.
- Markdown log/summary outputs remain optional and decoupled from gate control flow.
