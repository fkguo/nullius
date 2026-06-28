#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_DIR="$(cd "${SCRIPT_DIR}/../.." && pwd)"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "${TMP_DIR}"' EXIT

DOC="${TMP_DIR}/toc.md"
cat >"${DOC}" <<'MD'
## Table of Contents

- [$\\gamma\\_{\\rm lin}$](#gamma)
- [$G\\_R$ and $k^\\*$](#more)

---

Body math: $\\Delta + \\alpha$.

Inline code `$\\Delta$` stays as code.

```text
$\\Delta$ stays as code.
```

\[
V
=\frac12 C.
\]
MD

if python3 "${SKILL_DIR}/scripts/bin/markdown_hygiene.py" check --root "${DOC}"; then
  echo "expected check to fail before fixes" >&2
  exit 1
fi

python3 "${SKILL_DIR}/scripts/bin/markdown_hygiene.py" fix --root "${DOC}"
python3 "${SKILL_DIR}/scripts/bin/markdown_hygiene.py" check --root "${DOC}"

grep -F '$\gamma_{\rm lin}$' "${DOC}" >/dev/null
grep -F '$G_R$ and $k^*$' "${DOC}" >/dev/null
grep -F 'Body math: $\Delta + \alpha$.' "${DOC}" >/dev/null
grep -F 'Inline code `$\\Delta$` stays as code.' "${DOC}" >/dev/null
grep -F '$\\Delta$ stays as code.' "${DOC}" >/dev/null
grep -F '{}=\frac12 C.' "${DOC}" >/dev/null

BAD_DISPLAY="${TMP_DIR}/bad-display.md"
cat >"${BAD_DISPLAY}" <<'MD'
Valid text.

$$
E
= mc^2
+ p^2
- q^2
$$

```text
$$
= code is ignored
+ code is ignored
- code is ignored
$$
```
MD

if python3 "${SKILL_DIR}/scripts/bin/markdown_hygiene.py" check --root "${BAD_DISPLAY}"; then
  echo "expected check to fail for display math continuation lines" >&2
  exit 1
fi

python3 "${SKILL_DIR}/scripts/bin/markdown_hygiene.py" fix --root "${BAD_DISPLAY}"
python3 "${SKILL_DIR}/scripts/bin/markdown_hygiene.py" check --root "${BAD_DISPLAY}"

grep -F '{}= mc^2' "${BAD_DISPLAY}" >/dev/null
grep -F '{}+ p^2' "${BAD_DISPLAY}" >/dev/null
grep -F '{}- q^2' "${BAD_DISPLAY}" >/dev/null
grep -F '= code is ignored' "${BAD_DISPLAY}" >/dev/null
grep -F '+ code is ignored' "${BAD_DISPLAY}" >/dev/null
grep -F -- '- code is ignored' "${BAD_DISPLAY}" >/dev/null

BAD_PLUS_MINUS="${TMP_DIR}/bad-plus-minus.md"
cat >"${BAD_PLUS_MINUS}" <<'MD'
$$
x
+ y
- z
$$
MD

if python3 "${SKILL_DIR}/scripts/bin/markdown_hygiene.py" check --root "${BAD_PLUS_MINUS}"; then
  echo "expected check to fail for plus/minus display math continuation lines" >&2
  exit 1
fi
python3 "${SKILL_DIR}/scripts/bin/markdown_hygiene.py" fix --root "${BAD_PLUS_MINUS}"
python3 "${SKILL_DIR}/scripts/bin/markdown_hygiene.py" check --root "${BAD_PLUS_MINUS}"
grep -F '{}+ y' "${BAD_PLUS_MINUS}" >/dev/null
grep -F '{}- z' "${BAD_PLUS_MINUS}" >/dev/null

LINKS_DIR="${TMP_DIR}/links"
mkdir -p "${LINKS_DIR}/notes"
printf '# Linked note\n' >"${LINKS_DIR}/notes/source.md"
cat >"${LINKS_DIR}/good-links.md" <<'MD'
[source note](notes/source.md)
[source note with parentheses](notes/source(1).md)
<a href="notes/source.md">source note</a>
[reference link][source-ref]

[source-ref]: notes/source.md
MD
printf '# Linked note with parentheses\n' >"${LINKS_DIR}/notes/source(1).md"
python3 "${SKILL_DIR}/scripts/bin/markdown_hygiene.py" check --root "${LINKS_DIR}" --check-local-links --check-bare-md-paths

cat >"${LINKS_DIR}/bad-missing-link.md" <<'MD'
[missing note](notes/missing.md)
MD
if python3 "${SKILL_DIR}/scripts/bin/markdown_hygiene.py" check --root "${LINKS_DIR}/bad-missing-link.md" --check-local-links; then
  echo "expected check to fail for a missing local link" >&2
  exit 1
fi

cat >"${LINKS_DIR}/bad-absolute-link.md" <<'MD'
[absolute note](/tmp/not-portable.md)
MD
if python3 "${SKILL_DIR}/scripts/bin/markdown_hygiene.py" check --root "${LINKS_DIR}/bad-absolute-link.md" --check-local-links; then
  echo "expected check to fail for an absolute local link" >&2
  exit 1
fi

cat >"${LINKS_DIR}/bad-file-url.md" <<'MD'
<a href="file:///tmp/not-portable.md">not portable</a>
MD
if python3 "${SKILL_DIR}/scripts/bin/markdown_hygiene.py" check --root "${LINKS_DIR}/bad-file-url.md" --check-local-links; then
  echo "expected check to fail for a file URL" >&2
  exit 1
fi

cat >"${LINKS_DIR}/bad-bare-path.md" <<'MD'
`notes/source.md`
`../notes/source.md`
MD
if python3 "${SKILL_DIR}/scripts/bin/markdown_hygiene.py" check --root "${LINKS_DIR}/bad-bare-path.md" --check-bare-md-paths; then
  echo "expected check to fail for a bare Markdown path" >&2
  exit 1
fi

cat >"${LINKS_DIR}/bad-raw-token.md" <<'MD'
plain raw token: RAW_MATH_TOKEN
MD
if python3 "${SKILL_DIR}/scripts/bin/markdown_hygiene.py" check --root "${LINKS_DIR}/bad-raw-token.md" --raw-token 'RAW_MATH_TOKEN'; then
  echo "expected check to fail for a configured raw token" >&2
  exit 1
fi

cat >"${LINKS_DIR}/bad-raw-math.md" <<'MD'
The process a -> b depends on m^2.

```text
code -> ignored
code^2 ignored
```
MD
if python3 "${SKILL_DIR}/scripts/bin/markdown_hygiene.py" check --root "${LINKS_DIR}/bad-raw-math.md" --raw-math-preset ascii-math; then
  echo "expected check to fail for ASCII raw-math patterns" >&2
  exit 1
fi

echo "[ok] markdown-hygiene smoke tests passed"
