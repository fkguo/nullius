# Design: NEW-01 Cross-Language Type Code Generation

> **Status**: Draft
> **Author**: Claude (Phase 1 kickoff)
> **Date**: 2026-02-25
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
| **Draft 2020-12 support** | Partial — `if-then-else` handled as intersection types (imprecise but usable) |
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
| **`if-then-else`** | Generates discriminated unions with Pydantic `Discriminator` |
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
// meta/scripts/codegen.ts
import { compile } from 'json-schema-to-typescript';

const options = {
  additionalProperties: false,   // match schema convention
  bannerComment: '/* AUTO-GENERATED — DO NOT EDIT. Source: meta/schemas/ */',
  style: {                        // match project style
    singleQuote: true,
    semi: true,
    tabWidth: 2,
  },
  declareExternallyReferenced: true,  // emit $defs as separate types
  enableConstEnums: false,
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
  --use-standard-collections
```

**Note**: Python output location is flexible. Since the legacy Python packages (`hep-autoresearch`, `idea-core`) are being retired, the Python stubs serve primarily as reference types for remaining Python code and for cross-language contract testing. A `meta/generated/python/` directory may be more appropriate than placing them in `packages/shared/`.

### 4.4 Zod Schema Generation (Runtime Validation)

The existing codebase uses **Zod** as the runtime validation SSOT for MCP tool parameters. Generated TS types should complement, not replace, the hand-written Zod schemas.

**Strategy**: Generated types serve as **compile-time contracts**. Zod schemas remain as **runtime validation**. A conformance test ensures generated types and Zod schemas agree:

```typescript
// packages/shared/src/__tests__/codegen-conformance.test.ts
import type { ArtifactRefV1 } from '../generated/artifact-ref-v1.js';
import { ArtifactRefV1Schema } from '../types/artifact-ref.js';  // existing Zod
import type { z } from 'zod';

// Compile-time check: Zod inferred type must be assignable to generated type
type _check = z.infer<typeof ArtifactRefV1Schema> extends ArtifactRefV1 ? true : never;
```

### 4.5 Orchestration Script

```bash
# meta/scripts/codegen.sh
#!/usr/bin/env bash
set -euo pipefail

SCHEMA_DIR="meta/schemas"
TS_OUT="packages/shared/src/generated"
PY_OUT="meta/generated/python"

mkdir -p "$TS_OUT" "$PY_OUT"

# TS generation
npx tsx meta/scripts/codegen-ts.ts "$SCHEMA_DIR" "$TS_OUT"

# Python generation
for schema in "$SCHEMA_DIR"/*.schema.json; do
  base=$(basename "$schema" .schema.json)
  datamodel-codegen \
    --input "$schema" \
    --output "$PY_OUT/${base}.py" \
    --input-file-type jsonschema \
    --output-model-type pydantic_v2.BaseModel \
    --target-python-version 3.11 \
    --use-annotated
done

# Generate barrel exports
npx tsx meta/scripts/codegen-barrel.ts "$TS_OUT"
echo "Codegen complete: $(ls "$TS_OUT"/*.ts | wc -l) TS files, $(ls "$PY_OUT"/*.py | wc -l) Python files"
```

## 5. CI Gate: `make codegen-check`

### 5.1 Mechanism

The CI gate verifies that generated code is in sync with schemas:

```makefile
# Makefile
codegen:
	bash meta/scripts/codegen.sh

codegen-check:
	bash meta/scripts/codegen.sh
	git diff --exit-code packages/shared/src/generated/ meta/generated/python/
	@echo "codegen-check: OK — generated code is in sync with schemas"
```

### 5.2 Workflow

1. Developer modifies `meta/schemas/foo_v1.schema.json`
2. Developer runs `make codegen` to regenerate types
3. Developer commits both the schema change and generated files
4. CI runs `make codegen-check` — fails if generated files don't match

### 5.3 Pre-commit Hook (Optional)

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
│       ├── artifact_ref_v1.py
│       └── ...
└── scripts/
    ├── codegen.sh          # NEW: Orchestration script
    ├── codegen-ts.ts       # NEW: TS generation wrapper
    └── codegen-barrel.ts   # NEW: Barrel export generator
```

## 7. Migration Strategy

### Phase 1 (This PR)
- Install `json-schema-to-typescript` and `datamodel-code-generator`
- Create `meta/scripts/codegen.sh` + helpers
- Generate types for all 18 schemas
- Add `make codegen` and `make codegen-check` targets
- Add conformance tests for schemas that have existing Zod equivalents

### Phase 2 (Downstream PRs — blocked by NEW-01)
- H-01, H-03, H-04, H-15a, H-18: Consume generated types instead of hand-writing
- NEW-R05a: Evaluate Pydantic v2 output quality, decide if Python stubs replace legacy types
- NEW-R06: Migrate analysis type schemas to `meta/schemas/` and include in codegen

## 8. Risks & Mitigations

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|-----------|
| `if-then-allOf` generates imprecise TS types | Medium | Low | Post-process with manual discriminated union overrides for `research_event_v1` |
| `datamodel-code-generator` output differs from existing Python types | Low | Low | Python types are reference-only; runtime validation stays in Zod/TS |
| Schema evolution breaks generated code | Low | Medium | `make codegen-check` CI gate catches immediately |
| Large generated files increase repo size | Low | Low | 18 schemas -> ~18 files, minimal size |
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

## 10. Open Questions

1. **Python output location**: `meta/generated/python/` vs `packages/hep-autoresearch/src/generated/`? Given retirement of Python packages, `meta/generated/python/` seems cleaner.

2. **Generated file versioning**: Should generated files be committed to git (recommended for reproducibility and CI speed) or `.gitignore`'d and regenerated in CI?
   - **Recommendation**: Commit generated files. `make codegen-check` ensures they stay in sync.

3. **Zod schema generation from JSON Schema**: Should we auto-generate Zod schemas too (e.g., via `json-schema-to-zod`)?
   - **Recommendation**: Not initially. Zod schemas carry runtime validation logic (transforms, refinements) that can't be auto-generated. Keep them hand-written with conformance tests.
