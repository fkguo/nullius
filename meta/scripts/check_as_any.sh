#!/usr/bin/env bash
# NEW-R02: Diff-scoped `as any` / `.catch(() => {})` gate.
#
# Checks that new code (staged or current worktree/index vs main) does not introduce:
#   - `as any` casts
#   - `.catch(() => {})` swallowed errors
#
# Existing instances in the codebase are NOT flagged (diff-scoped).
#
# Usage:
#   bash meta/scripts/check_as_any.sh              # Check staged changes
#   bash meta/scripts/check_as_any.sh --vs-main    # Worktree + untracked AND index vs main
#   bash meta/scripts/check_as_any.sh --staged     # Check staged (default)

set -euo pipefail

input_error() {
  echo "NEW-R02 ERROR: $*" >&2
  exit 2
}

[[ $# -le 1 ]] || input_error "expected --staged or --vs-main"
case "${1:---staged}" in
  --staged) MODE="staged" ;;
  --vs-main) MODE="vs-main" ;;
  *) input_error "unknown argument: $1" ;;
esac

# Retain even a trailing newline in the repository's directory name. Run every
# pathspec and untracked-file read from the same root, including subdir callers.
if ! root_output=$(git rev-parse --show-toplevel && printf '.'); then
  input_error "cannot locate the Git working tree"
fi
project_root=${root_output%$'\n.'}
cd -- "$project_root" || input_error "cannot enter the Git working tree"
temporary=$(mktemp -d "${TMPDIR:-/tmp}/nullius-type-check.XXXXXX") || input_error "cannot create temporary inputs"
trap 'rm -rf -- "$temporary"' EXIT

pathspecs=('*.ts' '*.tsx' ':!*.test.ts' ':!*.test.tsx')
diff_flags=(--no-ext-diff --no-textconv --no-color --text --unified=0)
if [[ "$MODE" == "vs-main" ]]; then
  base=$(git merge-base origin/main HEAD) || input_error "cannot resolve merge-base with origin/main"
  scopes=(worktree index)
  git diff "${diff_flags[@]}" "$base" -- "${pathspecs[@]}" > "$temporary/worktree.diff" \
    || input_error "cannot read the selected working-tree Git diff"
  # A repair that has not been staged cannot excuse a violation still in the
  # index: git commit would publish that distinct candidate.
  git diff "${diff_flags[@]}" --cached "$base" -- "${pathspecs[@]}" > "$temporary/index.diff" \
    || input_error "cannot read the selected index Git diff"
else
  scopes=(staged)
  git diff "${diff_flags[@]}" --cached -- "${pathspecs[@]}" > "$temporary/staged.diff" \
    || input_error "cannot read the selected staged Git diff"
fi

if [[ "$MODE" == "vs-main" ]]; then
  enumeration_status=0
  git ls-files --others --exclude-standard -z -- "${pathspecs[@]}" \
    > "$temporary/untracked" 2> "$temporary/enumeration.stderr" || enumeration_status=$?
  # Git may report an unreadable directory as a warning with exit zero. Such
  # a partial enumeration cannot establish that no new source was omitted.
  if [[ "$enumeration_status" -ne 0 || -s "$temporary/enumeration.stderr" ]]; then
    cat "$temporary/enumeration.stderr" >&2 || input_error "cannot read enumeration diagnostics"
    input_error "cannot completely enumerate untracked TypeScript files"
  fi
  while IFS= read -r -d '' file; do
    [[ -f "$file" && ! -L "$file" ]] || input_error "untracked source is not a regular file: $file"
    sed 's/^/+/' -- "$file" >> "$temporary/worktree.diff" || input_error "cannot read untracked source: $file"
    # Separate files even when a source lacks a final newline.
    printf '\n' >> "$temporary/worktree.diff" || input_error "cannot retain untracked source"
  done < "$temporary/untracked"
fi

VIOLATIONS=0
check_pattern() {
  local pattern="$1" label="$2" scope="$3" match_status=0 count
  grep -aE "$pattern" "$temporary/added" > "$temporary/matches" || match_status=$?
  [[ "$match_status" -le 1 ]] || input_error "cannot inspect added TypeScript lines"
  count=$(wc -l < "$temporary/matches") || input_error "cannot count matching lines"
  if [[ "$count" -gt 0 ]]; then
    echo "NEW-R02 FAIL [$scope]: $count new $label detected in added lines:" >&2
    head -n 20 "$temporary/matches" >&2 || input_error "cannot report matching lines"
    VIOLATIONS=$((VIOLATIONS + count))
  fi
}

for scope in "${scopes[@]}"; do
  # Only grep's documented no-match status is benign. Git/read errors never
  # become an empty, apparently successful inspection.
  filter_status=0
  grep -a '^\+[^+]' "$temporary/$scope.diff" > "$temporary/added" || filter_status=$?
  [[ "$filter_status" -le 1 ]] || input_error "cannot select added TypeScript lines ($scope)"
  if [[ ! -s "$temporary/added" ]]; then
    echo "NEW-R02: no new TS lines to check ($scope)"
    continue
  fi
  check_pattern '\bas any\b' "'as any' cast(s)" "$scope"
  check_pattern '\.catch\(\s*\(\)\s*=>\s*\{\s*\}\s*\)' 'swallowed .catch(() => {})' "$scope"
done
if [[ "$VIOLATIONS" -gt 0 ]]; then
  echo "NEW-R02: total $VIOLATIONS violation(s). Fix before committing." >&2
  exit 1
fi
echo "NEW-R02 PASS: no new 'as any' or swallowed .catch() in selected changes ($MODE)"
