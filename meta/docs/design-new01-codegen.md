# Design: NEW-01 Cross-Language Type Code Generation

> **Status**: Approved (R3 CONVERGED)
> **Author**: Claude (Phase 1 kickoff)
> **Date**: 2026-02-25
> **Review**: R1 NOT_CONVERGED → R2 NOT_CONVERGED → R3 CONVERGED (Codex PASS / Gemini PASS)
> **Scope**: JSON Schema -> TS / Python code generation pipeline for `meta/schemas/`

---

## 1. Problem Statement

The monorepo has **18 JSON Schema files** in `meta/schemas/` that define shared data contracts used across TS and Python components. Currently:

- TS types are **hand-written** in `packages/shared/src/types/` using Zod as SSOT
- Python types (in `hep-autoresearch`, `idea-core`) are hand-written dataclasses/dicts
- JSON Schemas in `meta/schemas/` are maintained separately and **not automatically synced** to either language
- Risk: drift between JSON Schema definitions and runtime types in both languages

**Goal**: Establish a codegen pipeline that generates TS types and Python stubs from `meta/schemas/*.schema.json` as the single source of truth.

## 2. Schema Inventory

18 schemas, all following `https://json-schema.org/draft/2020-12/schema`:

| Schema | Complexity | Features Used |
|--------|-----------|---------------|
| `artifact_ref_v1` | Low | Basic object, required fields |
| `research_event_v1` | High | `$defs`, `if-then-allOf` discriminated unions, ~15 payload types |
| `integrity_check_v1` | Medium | Enums, nested objects |
| `integrity_report_v1` | Medium | Arrays, nested objects |
| `reproducibility_report_v1` | Medium | UUID format, date-time |
| `research_outcome_v1` | Medium | Nested objects |
| `research_strategy_v1` | Medium | Arrays of complex objects |
| `research_signal_v1` | Medium | Enums, nested payloads |
| `rep_envelope_v1` | Low | URI format, basic wrapping |
| `domain_pack_manifest_v1` | Medium | Arrays, version strings |
| `gene_v1` | Medium | Nested objects, enums |
| `capsule_v1` | Low | Basic object |
| `memory_graph_node_v1` | Medium | Enums, metadata |
| `memory_graph_edge_v1` | Medium | Relationships, weights |
| `memory_graph_event_v1` | Medium | Event types, timestamps |
| `mutation_proposal_v1` | Medium | Enums, nested strategies |
| `skill_proposal_v2` | Medium | Arrays, conditional fields |
| `strategy_state_v1` | High | Nested state tracking |

**Key challenge**: `research_event_v1` uses `if-then-allOf` conditional schemas (discriminated unions), which not all codegen tools handle well.

## 3. Candidate Tool Evaluation

### 3.1 `json-schema-to-typescript` (TS-only)

| Aspect | Assessment |
|--------|-----------|
| **TS output quality** | Good — generates interfaces with JSDoc, handles `$ref`, `allOf`, `anyOf` |
| **Draft 2020-12 support** | Partial — `if-then-else` handled as intersection types (imprecise). **Requires golden test validation per §4.6** |
| **`$defs` support** | Yes |
| **additionalProperties: false** | Yes (generates strict types) |
| **format validation** | Type-level only (no runtime) |
| **Python** | N/A |
| **Maintenance** | Active, widely used |

**Verdict**: Strong candidate for TS generation. Does not cover Python.

### 3.2 `quicktype`

| Aspect | Assessment |
|--------|-----------|
| **TS output** | Good — generates interfaces or classes |
| **Python output** | Generates dataclasses with type annotations |
| **Draft 2020-12** | Limited — best with Draft 7 / 2019-09 |
| **`if-then-else`** | Flattens to union types (loses discriminant information) |
| **`$defs`** | Partial |
| **format validation** | Runtime converters for some formats |
| **Maintenance** | Community-maintained, slower release cadence |

**Verdict**: Multi-language, but Draft 2020-12 support is a concern. `if-then-allOf` patterns would need manual post-processing.

### 3.3 `datamodel-code-generator` (Python-only)

| Aspect | Assessment |
|--------|-----------|
| **Python output** | Excellent — generates Pydantic v2 models with validators |
| **Draft 2020-12** | Good support |
| **`if-then-else`** | Nominally supports Pydantic `Discriminator`, but behavior varies with schema structure. **Requires spike validation per §4.6** |
| **`$defs`** | Yes |
| **format validation** | Full Pydantic validation |
| **TS** | N/A |
| **Maintenance** | Active, well-maintained |

**Verdict**: Best-in-class for Python/Pydantic output. Does not cover TS.

### 3.4 Custom Transformer

| Aspect | Assessment |
|--------|-----------|
| **Control** | Full control over output format and conventions |
| **Effort** | High — must handle all JSON Schema features ourselves |
| **Draft 2020-12** | Must implement ourselves |
| **Maintenance** | Must maintain ourselves |

**Verdict**: Only justified if existing tools fail on our schema patterns. Not recommended as first choice.

## 4. Recommended Approach: Dual-Tool Pipeline

Use **`json-schema-to-typescript`** for TS and **`datamodel-code-generator`** for Python, with a thin orchestration layer.

### 4.1 Architecture

```
meta/schemas/*.schema.json          (SSOT)
         │
    ┌────┴────┐
    ▼         ▼
json-schema-  datamodel-code-
to-typescript generator
    │         │
    ▼         ▼
packages/     packages/
shared/src/   shared/src/
generated/    generated/
  *.ts          *.py
```

### 4.2 TS Generation

**Tool**: `json-schema-to-typescript` (npm: `json-schema-to-typescript`)

**Output**: `packages/shared/src/generated/*.ts`

**Configuration**:
```typescript
// meta/scripts/codegen-ts.ts
import { compile } from 'json-schema-to-typescript';

const options = {
  // Let each schema's own additionalProperties control strictness
  bannerComment: '/* AUTO-GENERATED — DO NOT EDIT. Source: meta/schemas/ */',
  style: {                        // match project style
    singleQuote: true,
    semi: true,
    tabWidth: 2,
  },
  declareExternallyReferenced: true,  // emit $defs as separate types
  enableConstEnums: false,
  cwd: path.resolve('meta/schemas'),  // resolve $ref URIs relative to schema dir
};
```

**Generated file naming**: `meta/schemas/artifact_ref_v1.schema.json` -> `packages/shared/src/generated/artifact-ref-v1.ts`

**Re-export**: `packages/shared/src/generated/index.ts` barrel export, then added to `packages/shared/src/index.ts`.

### 4.3 Python Generation

**Tool**: `datamodel-code-generator` (pip: `datamodel-code-generator`)

**Output**: `packages/shared/src/generated/*.py` (or a dedicated Python location if preferred)

**Configuration**:
```bash
datamodel-codegen \
  --input meta/schemas/artifact_ref_v1.schema.json \
  --output packages/shared/src/generated/artifact_ref_v1.py \
  --input-file-type jsonschema \
  --output-model-type pydantic_v2.BaseModel \
  --target-python-version 3.11 \
  --use-annotated \
  --field-constraints \
  --enum-field-as-literal all \
  --use-standard-collections \
  --disable-timestamp
```

**Note**: Python output goes to `meta/generated/python/`. Since the legacy Python packages (`hep-autoresearch`, `idea-core`) are being retired, the Python stubs serve as cross-language reference types and contract testing artifacts. An auto-generated `__init__.py` makes the directory importable as a Python module.

### 4.4 Zod Schema Generation (Runtime Validation)

The existing codebase uses **Zod** as the runtime validation SSOT for MCP tool parameters. Generated TS types should complement, not replace, the hand-written Zod schemas.

**Strategy**: Generated types serve as **compile-time contracts**. Zod schemas remain as **runtime validation**. A bidirectional conformance test ensures generated types and Zod schemas agree exactly:

```typescript
// packages/shared/src/__tests__/codegen-conformance.test.ts
import type { ArtifactRefV1 } from '../generated/artifact-ref-v1.js';
import { ArtifactRefV1Schema } from '../types/artifact-ref.js';  // existing Zod
import type { z } from 'zod';

// Bidirectional exact type equivalence — fails compilation if types drift in either direction
type Exact<T, U> = [T] extends [U] ? ([U] extends [T] ? true : false) : false;
const _checkArtifact: Exact<z.infer<typeof ArtifactRefV1Schema>, ArtifactRefV1> = true;
```

CI must run `tsc --noEmit` on these conformance files to catch mismatches.

### 4.5 Orchestration Script

```bash
# meta/scripts/codegen.sh
#!/usr/bin/env bash
set -euo pipefail

SCHEMA_DIR="meta/schemas"
TS_OUT="packages/shared/src/generated"
PY_OUT="meta/generated/python"
RESOLVED_DIR="$(mktemp -d)"

# Clean output directories to detect stale files after schema rename/delete
rm -rf "$TS_OUT" "$PY_OUT"
mkdir -p "$TS_OUT" "$PY_OUT"

# Step 0: Shared pre-resolution — bundle all $ref URIs to local paths (offline-safe)
# Produces fully-resolved schemas consumed by BOTH TS and Python generators.
# Maps absolute URI $refs (e.g. https://autoresearch.dev/schemas/*.schema.json)
# to local meta/schemas/ files. Fails if any external $ref cannot be resolved locally.
npx tsx meta/scripts/codegen-resolve-refs.ts "$SCHEMA_DIR" "$RESOLVED_DIR"

# Step 1: TS generation (from resolved schemas)
npx tsx meta/scripts/codegen-ts.ts "$RESOLVED_DIR" "$TS_OUT"

# Step 2: Python generation (from resolved schemas, with determinism flags)
for schema in "$RESOLVED_DIR"/*.schema.json; do
  base=$(basename "$schema" .schema.json)
  datamodel-codegen \
    --input "$schema" \
    --output "$PY_OUT/${base}.py" \
    --input-file-type jsonschema \
    --output-model-type pydantic_v2.BaseModel \
    --target-python-version 3.11 \
    --use-annotated \
    --disable-timestamp
done

# Step 3: Generate __init__.py for Python module importability
npx tsx meta/scripts/codegen-py-init.ts "$PY_OUT"

# Step 4: Generate barrel exports for TS
npx tsx meta/scripts/codegen-barrel.ts "$TS_OUT"

# Step 5: Format generated code (fail on errors — no silent suppression)
npx prettier --write "$TS_OUT/**/*.ts"
if command -v ruff &>/dev/null; then
  ruff check --fix "$PY_OUT"
  ruff format "$PY_OUT"
fi

# Step 6: Validate generated code compiles/parses correctly
npx tsc --noEmit --project packages/shared/tsconfig.json
python3 -m py_compile "$PY_OUT"/*.py

# Cleanup
rm -rf "$RESOLVED_DIR"

echo "Codegen complete: $(ls "$TS_OUT"/*.ts | wc -l) TS files, $(ls "$PY_OUT"/*.py | wc -l) Python files"
```

### 4.6 Mandatory Spike: Conditional Schema Validation (Gate)

Before adopting the dual-tool pipeline, a **mandatory spike** must validate that both tools produce acceptable output for conditional schemas. This gates the entire design.

**Target schemas** (highest complexity with `if-then-allOf`):
- `research_event_v1` — 15 payload types via conditional schemas
- `research_signal_v1` — nested payloads with enums
- `memory_graph_node_v1` — enum-driven metadata

**Spike procedure**:
1. Run both generators on the 3 target schemas
2. Inspect TS output: do `if-then-allOf` patterns produce useful discriminated union types, or degrade to `any`/`unknown`/flat intersections?
3. Inspect Python output: does `datamodel-code-generator` produce Pydantic `Discriminator`-based unions, or fall back to `Union[...]` without discrimination?
4. For each schema, create a golden-file test that asserts key type structure properties

**Decision criteria**:
- **If both tools produce acceptable output**: proceed with Phase 1A
- **If TS output degrades**: add an automated AST post-processor (via `ts-morph`) in `codegen-ts.ts` to rewrite imprecise intersections as proper discriminated unions. **No manual edits in generated files.**
- **If Python output degrades**: refactor the source schemas to use `oneOf` + `const` discriminator (compatible with both tools) instead of `if-then-allOf`
- **If both tools fail badly**: fall back to §3.4 Custom Transformer for affected schemas only

## 5. CI Gate: `make codegen-check`

### 5.1 Mechanism

The CI gate verifies that generated code is in sync with schemas, including untracked files, stale artifacts, and syntactic validity:

```makefile
# Makefile
codegen:
	bash meta/scripts/codegen.sh

codegen-check:
	bash meta/scripts/codegen.sh
	# Check tracked files for modifications
	git diff --exit-code packages/shared/src/generated/ meta/generated/python/
	# Check for untracked files (new schemas added but codegen not committed)
	@if git ls-files --others --exclude-standard -- packages/shared/src/generated/ meta/generated/python/ | grep -q .; then \
		echo "codegen-check: FAIL — untracked generated files detected"; exit 1; fi
	@echo "codegen-check: OK — generated code is in sync with schemas"

codegen-determinism:
	# Double-run determinism check: run codegen twice and compare
	bash meta/scripts/codegen.sh
	cp -r packages/shared/src/generated/ "$$(mktemp -d)/codegen-run1-ts"
	cp -r meta/generated/python/ "$$(mktemp -d)/codegen-run1-py"
	bash meta/scripts/codegen.sh
	diff -r "$$(mktemp -d)/codegen-run1-ts" packages/shared/src/generated/
	diff -r "$$(mktemp -d)/codegen-run1-py" meta/generated/python/
	@echo "codegen-determinism: OK — output is identical across runs"
```

Note: `codegen.sh` itself already validates that generated code compiles/parses (`tsc --noEmit` + `python3 -m py_compile`), so `codegen-check` inherits those checks.

### 5.2 Determinism Controls

Generated code must be deterministic across environments:
- **Pin exact versions**: `json-schema-to-typescript` and `datamodel-code-generator` versions pinned in `package.json` / `requirements.txt` lockfiles
- **Disable timestamps**: `--disable-timestamp` flag for `datamodel-code-generator`
- **Stable formatting**: Generated output piped through project formatters (Prettier/Ruff)
- **CI verification**: `make codegen-determinism` (optional, run on PRs that modify generator config)

### 5.3 Workflow

1. Developer modifies `meta/schemas/foo_v1.schema.json`
2. Developer runs `make codegen` to regenerate types
3. Developer commits both the schema change and generated files
4. CI runs `make codegen-check` — fails if generated files don't match

### 5.4 Pre-commit Hook (Optional)

```bash
# .husky/pre-commit (optional)
if git diff --cached --name-only | grep -q 'meta/schemas/'; then
  make codegen-check
fi
```

## 6. Directory Structure (Post-Implementation)

```
packages/shared/src/
├── generated/              # NEW: Auto-generated from meta/schemas/
│   ├── index.ts            # Barrel export
│   ├── artifact-ref-v1.ts
│   ├── research-event-v1.ts
│   ├── ...
│   └── strategy-state-v1.ts
├── types/                  # Existing hand-written Zod schemas
│   ├── index.ts
│   ├── paper.ts
│   └── ...
├── tool-names.ts           # H-16a tool name constants
├── index.ts                # Main barrel (adds generated/ export)
└── ...

meta/
├── schemas/                # SSOT JSON Schemas
│   ├── artifact_ref_v1.schema.json
│   └── ...
├── generated/
│   └── python/             # NEW: Generated Python stubs
│       ├── __init__.py     # Auto-generated for module importability
│       ├── artifact_ref_v1.py
│       └── ...
└── scripts/
    ├── codegen.sh              # NEW: Orchestration script
    ├── codegen-resolve-refs.ts # NEW: Shared $ref resolver/bundler (offline-safe)
    ├── codegen-ts.ts           # NEW: TS generation wrapper (incl. post-processor)
    ├── codegen-barrel.ts       # NEW: Barrel export generator
    └── codegen-py-init.ts      # NEW: Python __init__.py generator
```

## 7. Migration Strategy

### Phase 1A: Toolchain Spike (Gate — must pass before 1B)
- Install `json-schema-to-typescript` and `datamodel-code-generator` (pinned versions)
- Run spike on 3 hardest schemas: `research_event_v1`, `research_signal_v1`, `memory_graph_node_v1` (per §4.6)
- Create golden-file tests validating discriminated union output
- Decide: adopt as-is, add automated post-processor, or refactor schemas to `oneOf` + `const`
- Set up `$ref` resolver for any absolute URI references

### Phase 1B: Full Rollout (blocked by 1A passing)
- Create `meta/scripts/codegen.sh` + helpers (incl. Prettier/Ruff formatting)
- Generate types for all 18 schemas
- Add `make codegen`, `make codegen-check`, `make codegen-determinism` targets
- Add bidirectional conformance tests for schemas with existing Zod equivalents
- Generate Python `__init__.py`

### Phase 2 (Downstream PRs — blocked by Phase 1B)
- H-01, H-03, H-04, H-15a, H-18: Consume generated types instead of hand-writing
- NEW-R05a: Evaluate Pydantic v2 output quality, decide if Python stubs replace legacy types
- NEW-R06: Migrate analysis type schemas to `meta/schemas/` and include in codegen

## 8. Risks & Mitigations

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|-----------|
| `if-then-allOf` generates imprecise TS types | Medium | Medium | Phase 1A spike validates output; automated AST post-processor via `ts-morph` in `codegen-ts.ts` (no manual edits in generated files) |
| `datamodel-code-generator` `if-then-else` degrades to weak models | Medium | Medium | Phase 1A spike validates Pydantic output; fallback: refactor schemas to `oneOf` + `const` discriminator |
| `$ref` resolution fails in offline/hermetic CI | Medium | High | **Resolved**: Shared pre-resolution step (`codegen-resolve-refs.ts`) bundles all `$ref` URIs to local paths before either generator runs. Both TS and Python consume resolved schemas. |
| CI gate misses untracked/stale files | — | — | **Resolved**: CI checks `git diff --exit-code` + `git ls-files --others` for untracked files |
| Non-deterministic output across environments | Low | Medium | Pin exact tool versions, `--disable-timestamp`, Prettier/Ruff formatting, `mktemp -d` for temp paths, optional `make codegen-determinism` |
| Zod conformance test silently passes on mismatch | — | — | **Resolved**: Bidirectional `Exact<T, U>` type assertion with `tsc --noEmit` in CI |
| Formatter failure masks broken generated code | — | — | **Resolved**: Formatters run without `|| true`; `codegen.sh` includes `tsc --noEmit` and `python3 -m py_compile` validation |
| Schema evolution breaks generated code | Low | Medium | `make codegen-check` CI gate catches immediately |
| Tool dependency maintenance burden | Low | Low | Both tools are well-maintained with large communities |

## 9. Alternatives Considered

### 9.1 Zod as Universal SSOT (Schema -> Zod -> JSON Schema -> Python)

Generate JSON Schemas from Zod, then Python from JSON Schemas. This inverts the current `meta/schemas/` SSOT.

**Rejected because**: The 18 schemas in `meta/schemas/` were designed as cross-language contracts during Track A/B design. They use Draft 2020-12 features (conditional schemas, `$defs`) that Zod-to-JSON-Schema conversion would lose or approximate. Keeping JSON Schema as SSOT preserves the design intent.

### 9.2 Single Tool (quicktype)

Use quicktype for both TS and Python.

**Rejected because**: quicktype's Draft 2020-12 support is weaker than the dedicated tools, and its Python output is less idiomatic than `datamodel-code-generator`'s Pydantic v2 output.

### 9.3 TypeBox (Runtime TS Schema that outputs JSON Schema)

Use TypeBox as the TS-native schema definition that also produces JSON Schema.

**Rejected because**: Would require rewriting all 18 schemas in TypeBox syntax, adding a new dependency alongside Zod. The existing Zod + JSON Schema dual approach is well-established.

## 10. Resolved Questions (from R1 review)

1. **Python output location**: **Decided**: `meta/generated/python/`. Cleanly separates cross-language contracts from application logic. Includes `__init__.py` for module importability.

2. **Generated file versioning**: **Decided**: Commit generated files. Enables PR review of schema-to-type impact. `make codegen-check` ensures sync.

3. **Zod schema generation from JSON Schema**: **Decided**: Not auto-generated. Zod schemas carry runtime validation logic (`.refine()`, `.transform()`, error messages) that JSON Schema cannot express. Bidirectional conformance tests bridge the two.

## 11. Review History

| Round | Codex Verdict | Gemini Verdict | Convergence | Changes |
|-------|--------------|----------------|-------------|---------|
| R1 | FAIL (6 blocking) | PASS w/ revisions (3 blocking) | NOT_CONVERGED | Initial draft |
| R2 | FAIL (2 blocking) | PASS | NOT_CONVERGED | Addressed R1: spike gate, bidirectional conformance, CI untracked files, `$ref` resolution, determinism, automated post-processing |
| R3 | PASS (0 blocking) | PASS (0 blocking) | **CONVERGED** | Addressed R2: shared `$ref` pre-resolution for both generators, removed `|| true` from formatters, added `tsc --noEmit` + `py_compile` validation, `git ls-files --others` instead of `git add`, `mktemp -d` for temp paths |

### R3 Non-Blocking Recommendations (for implementation tracking)

1. Add a formal supported-keyword matrix for Draft 2020-12 and a schema-lint gate
2. Fix `codegen-determinism` Make target to use shell variables for `mktemp -d` paths
3. Add import smoke test beyond `py_compile` syntax-only check
4. Make Ruff a required (not optional) dependency
5. Spike per-file vs bundled `datamodel-codegen` generation for shared `$defs`
