#!/usr/bin/env bash
set -euo pipefail

SCHEMA_DIR="meta/schemas"
TS_OUT="packages/shared/src/generated"
PY_OUT="meta/generated/python"
RESOLVED_DIR="$(mktemp -d)"

# Preflight: enumerate ALL missing required tools at once so a fresh-clone user
# sees the full set of preconditions on a single run, not one at a time per step.
MISSING=()
HINTS=()

if ! command -v python3 &>/dev/null; then
  MISSING+=("python3")
  HINTS+=("python3: install Python 3.11+ via your OS package manager")
fi
if ! command -v datamodel-codegen &>/dev/null; then
  MISSING+=("datamodel-codegen")
  HINTS+=("datamodel-codegen: python3 -m pip install -r meta/scripts/codegen-requirements.txt")
fi
if [[ ! -x "node_modules/.bin/tsx" ]]; then
  MISSING+=("node_modules/.bin/tsx")
  HINTS+=("tsx (workspace devDep): run 'pnpm install' from the repo root")
fi
if [[ ! -x "node_modules/.bin/prettier" ]]; then
  MISSING+=("node_modules/.bin/prettier")
  HINTS+=("prettier (workspace devDep): run 'pnpm install' from the repo root")
fi
if ! command -v ruff &>/dev/null; then
  if [[ -n "${CI:-}" ]]; then
    MISSING+=("ruff")
    HINTS+=("ruff (required in CI): python3 -m pip install -r meta/scripts/codegen-requirements.txt")
  fi
  # local: ruff missing is a soft warning, handled in Step 5
fi

if [[ ${#MISSING[@]} -gt 0 ]]; then
  echo "ERROR: codegen.sh preflight found ${#MISSING[@]} missing tool(s):" >&2
  for hint in "${HINTS[@]}"; do
    echo "  - ${hint}" >&2
  done
  exit 1
fi

# Clean output directories to detect stale files after schema rename/delete
rm -rf "$TS_OUT" "$PY_OUT"
mkdir -p "$TS_OUT" "$PY_OUT"

echo "=== Step 0: Resolve \$ref URIs ==="
npx tsx meta/scripts/codegen-resolve-refs.ts "$SCHEMA_DIR" "$RESOLVED_DIR"

echo "=== Step 1: TS generation ==="
npx tsx meta/scripts/codegen-ts.ts "$RESOLVED_DIR" "$TS_OUT"

echo "=== Step 2: Python generation ==="
if ! command -v datamodel-codegen &>/dev/null; then
  echo "ERROR: datamodel-codegen (Python) is required but not on PATH." >&2
  echo "Install with: python3 -m pip install -r meta/scripts/codegen-requirements.txt" >&2
  exit 1
fi
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
echo "  PY: generated $(ls "$PY_OUT"/*.py 2>/dev/null | wc -l | tr -d ' ') files"

echo "=== Step 3: Generate Python __init__.py ==="
npx tsx meta/scripts/codegen-py-init.ts "$PY_OUT"

echo "=== Step 4: Generate TS barrel exports ==="
npx tsx meta/scripts/codegen-barrel.ts "$TS_OUT"

echo "=== Step 5: Format generated code ==="
# prettier is a devDependency of the workspace; if it's missing the host doesn't have pnpm install
# completed, which is a real precondition failure for codegen.
npx --no-install prettier --write "$TS_OUT/**/*.ts"
if command -v ruff &>/dev/null; then
  # ruff is optional but if present must succeed; previously `|| true` and stderr-silencing
  # hid real format/lint regressions in generated Python.
  ruff check --fix "$PY_OUT"
  ruff format "$PY_OUT"
elif [[ -n "${CI:-}" ]]; then
  echo "ERROR: ruff is required when CI is set (CI=${CI}) but not on PATH." >&2
  echo "Install with: python3 -m pip install -r meta/scripts/codegen-requirements.txt" >&2
  exit 1
else
  echo "  ruff: not installed locally, skipping Python format (codegen output is still valid). CI runs will require ruff."
fi

echo "=== Step 6: Validate generated code ==="
# tsc is a per-package devDep, not hoisted to the workspace root. `npx tsc` on a
# fresh CI runner falls back to the npm registry and downloads an unrelated
# placeholder `tsc@2.0.4` instead of TypeScript. Use pnpm's workspace resolution
# to call the @autoresearch/shared package's bundled tsc directly.
pnpm --filter @autoresearch/shared exec tsc --noEmit
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
