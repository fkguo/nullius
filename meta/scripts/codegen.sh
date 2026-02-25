#!/usr/bin/env bash
set -euo pipefail

SCHEMA_DIR="meta/schemas"
TS_OUT="packages/shared/src/generated"
PY_OUT="meta/generated/python"
RESOLVED_DIR="$(mktemp -d)"

# Clean output directories to detect stale files after schema rename/delete
rm -rf "$TS_OUT" "$PY_OUT"
mkdir -p "$TS_OUT" "$PY_OUT"

echo "=== Step 0: Resolve \$ref URIs ==="
npx tsx meta/scripts/codegen-resolve-refs.ts "$SCHEMA_DIR" "$RESOLVED_DIR"

echo "=== Step 1: TS generation ==="
npx tsx meta/scripts/codegen-ts.ts "$RESOLVED_DIR" "$TS_OUT"

echo "=== Step 2: Python generation ==="
for schema in "$RESOLVED_DIR"/*.schema.json; do
  base=$(basename "$schema" .schema.json)
  datamodel-codegen \
    --input "$schema" \
    --output "$PY_OUT/${base}.py" \
    --input-file-type jsonschema \
    --output-model-type pydantic_v2.BaseModel \
    --target-python-version 3.11 \
    --use-annotated \
    --disable-timestamp \
    2>/dev/null
done
echo "  PY: generated $(ls "$PY_OUT"/*.py 2>/dev/null | wc -l | tr -d ' ') files"

echo "=== Step 3: Generate Python __init__.py ==="
npx tsx meta/scripts/codegen-py-init.ts "$PY_OUT"

echo "=== Step 4: Generate TS barrel exports ==="
npx tsx meta/scripts/codegen-barrel.ts "$TS_OUT"

echo "=== Step 5: Format generated code ==="
npx prettier --write "$TS_OUT/**/*.ts" 2>/dev/null
if command -v ruff &>/dev/null; then
  ruff check --fix "$PY_OUT" 2>/dev/null || true
  ruff format "$PY_OUT" 2>/dev/null
fi

echo "=== Step 6: Validate generated code ==="
npx tsc --noEmit --project packages/shared/tsconfig.json
python3 -c "
import py_compile, glob, sys
errors = []
for f in glob.glob('$PY_OUT/*.py'):
    try:
        py_compile.compile(f, doraise=True)
    except py_compile.PyCompileError as e:
        errors.append(str(e))
if errors:
    for e in errors:
        print(e, file=sys.stderr)
    sys.exit(1)
print(f'  py_compile: {len(glob.glob(\"$PY_OUT/*.py\"))} files OK')
"

# Cleanup
rm -rf "$RESOLVED_DIR"

TS_COUNT=$(ls "$TS_OUT"/*.ts 2>/dev/null | grep -v index.ts | wc -l | tr -d ' ')
PY_COUNT=$(ls "$PY_OUT"/*.py 2>/dev/null | grep -v __init__.py | wc -l | tr -d ' ')
echo ""
echo "Codegen complete: ${TS_COUNT} TS files, ${PY_COUNT} Python files"
