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
grep -F 'Inline code $\Delta$ stays as code.' "${DOC}" >/dev/null
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
printf '# Linked note with spaces\n' >"${LINKS_DIR}/notes/source with spaces.md"
cat >"${LINKS_DIR}/good-links.md" <<'MD'
[source note](notes/source.md)
[source note with parentheses](notes/source(1).md)
<a href="notes/source.md">source note</a>
[reference link][source-ref]
[reference link with spaces][source-space-ref]

[source-ref]: notes/source.md
[source-space-ref]: <notes/source with spaces.md>
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

cat >"${LINKS_DIR}/raw-math-inline-code-ok.md" <<'MD'
Inline code `literal_code`, `cmd --flag`, `2026-07-09`, `src/foo`, `C++`, and `\n` should not trigger math checks.
MD
python3 "${SKILL_DIR}/scripts/bin/markdown_hygiene.py" check --root "${LINKS_DIR}/raw-math-inline-code-ok.md" --raw-math-preset ascii-math

CODE_MATH="${TMP_DIR}/code-math.md"
cat >"${CODE_MATH}" <<'MD'
Inline code `\Omega`, `C(k)`, `m^2`, `a0/r_eff`, and `a -> b` should become math.

`\[\Omega = m^2\]`
MD
if python3 "${SKILL_DIR}/scripts/bin/markdown_hygiene.py" check --root "${CODE_MATH}" --check-code-math; then
  echo "expected check to fail for code-wrapped math" >&2
  exit 1
fi
python3 "${SKILL_DIR}/scripts/bin/markdown_hygiene.py" fix --root "${CODE_MATH}"
python3 "${SKILL_DIR}/scripts/bin/markdown_hygiene.py" check --root "${CODE_MATH}" --human-facing
grep -F '$\Omega$' "${CODE_MATH}" >/dev/null
grep -F '$C(k)$' "${CODE_MATH}" >/dev/null
grep -F '$m^2$' "${CODE_MATH}" >/dev/null
grep -F '$a0/r_eff$' "${CODE_MATH}" >/dev/null
grep -F '$a -> b$' "${CODE_MATH}" >/dev/null
grep -F '\Omega = m^2' "${CODE_MATH}" >/dev/null

HUMAN_DIR="${TMP_DIR}/human-facing"
mkdir -p "${HUMAN_DIR}/notes"
printf '# Note\n' >"${HUMAN_DIR}/notes/source.md"
cat >"${HUMAN_DIR}/good-human-facing.md" <<'MD'
[project page](https://example.org/project)
<https://example.org/autolink>
<a href="https://example.org/html">HTML link</a>
<a href="https://example.org/html-tag-only">
https://example.org/html-link-text and arXiv:2401.12345 inside anchor text
</a>
<img
  src="https://example.org/image.png"
  alt="linked image">
[paper DOI](https://doi.org/10.1000/example)
[arXiv paper](https://arxiv.org/abs/2401.12345)
[titled link](https://example.org/titled "title")
[local note](notes/source.md)
[reference page][page-ref]
[reference DOI][doi-ref]
[reference arXiv][arxiv-ref]
[collapsed empty][]
[collapsed reference]
Inline math $a -> b$ and $m^2$ is already renderable.

$$
E = m^2
$$

Inline code `https://example.org/code`, `10.1000/code`, and `arXiv:2401.12345` are ignored.

[page-ref]: https://example.org/reference
[doi-ref]: https://doi.org/10.1000/reference
[arxiv-ref]: https://arxiv.org/abs/2401.54321
[collapsed empty]: https://example.org/collapsed-empty
[collapsed reference]: https://example.org/collapsed
MD
python3 "${SKILL_DIR}/scripts/bin/markdown_hygiene.py" check --root "${HUMAN_DIR}" --human-facing

cat >"${HUMAN_DIR}/bad-bare-url.md" <<'MD'
Read (https://example.org/not-linked) for context.
MD
if python3 "${SKILL_DIR}/scripts/bin/markdown_hygiene.py" check --root "${HUMAN_DIR}/bad-bare-url.md" --check-clickable-refs; then
  echo "expected check to fail for a bare web URL" >&2
  exit 1
fi
if python3 "${SKILL_DIR}/scripts/bin/markdown_hygiene.py" check --root "${HUMAN_DIR}/bad-bare-url.md" --human-facing; then
  echo "expected human-facing check to fail for a bare web URL" >&2
  exit 1
fi

cat >"${HUMAN_DIR}/bad-bare-doi.md" <<'MD'
The result follows 10.1000/example and doi:10.1000/example2.
MD
if python3 "${SKILL_DIR}/scripts/bin/markdown_hygiene.py" check --root "${HUMAN_DIR}/bad-bare-doi.md" --check-clickable-refs; then
  echo "expected check to fail for a bare DOI" >&2
  exit 1
fi

cat >"${HUMAN_DIR}/bad-bare-arxiv.md" <<'MD'
Compare with (arXiv:2401.12345), arXiv:hep-th/9905100, and arXiv:cond-mat.mes-hall/0601234.
MD
if python3 "${SKILL_DIR}/scripts/bin/markdown_hygiene.py" check --root "${HUMAN_DIR}/bad-bare-arxiv.md" --check-clickable-refs; then
  echo "expected check to fail for a bare arXiv identifier" >&2
  exit 1
fi

cat >"${HUMAN_DIR}/bad-non-http-autolink.md" <<'MD'
Compare <doi:10.1000/not-linked> and <arXiv:2401.12345>.
MD
if python3 "${SKILL_DIR}/scripts/bin/markdown_hygiene.py" check --root "${HUMAN_DIR}/bad-non-http-autolink.md" --check-clickable-refs; then
  echo "expected check to fail for non-HTTP DOI/arXiv autolinks" >&2
  exit 1
fi

cat >"${HUMAN_DIR}/bad-human-raw-math.md" <<'MD'
The transition a -> b has scale m^2.
MD
if python3 "${SKILL_DIR}/scripts/bin/markdown_hygiene.py" check --root "${HUMAN_DIR}/bad-human-raw-math.md" --human-facing; then
  echo "expected human-facing check to fail for raw ASCII math" >&2
  exit 1
fi

cat >"${HUMAN_DIR}/bad-display-spacing.md" <<'MD'
Text before display.
$$
x
$$
Text after display.
MD
if python3 "${SKILL_DIR}/scripts/bin/markdown_hygiene.py" check --root "${HUMAN_DIR}/bad-display-spacing.md" --check-display-spacing; then
  echo "expected check to fail for missing display math blank lines" >&2
  exit 1
fi
python3 "${SKILL_DIR}/scripts/bin/markdown_hygiene.py" fix --root "${HUMAN_DIR}/bad-display-spacing.md"
python3 "${SKILL_DIR}/scripts/bin/markdown_hygiene.py" check --root "${HUMAN_DIR}/bad-display-spacing.md" --check-display-spacing

cat >"${HUMAN_DIR}/bad-inline-display.md" <<'MD'
Inline display $$x$$ is not portable.
MD
if python3 "${SKILL_DIR}/scripts/bin/markdown_hygiene.py" check --root "${HUMAN_DIR}/bad-inline-display.md" --check-display-spacing; then
  echo "expected check to fail for inline display delimiters" >&2
  exit 1
fi

cat >"${HUMAN_DIR}/bad-table-math-pipe.md" <<'MD'
| State |
| --- |
| $\langle a|b\rangle$ |
MD
if python3 "${SKILL_DIR}/scripts/bin/markdown_hygiene.py" check --root "${HUMAN_DIR}/bad-table-math-pipe.md" --check-table-math-pipes; then
  echo "expected check to fail for literal pipe inside table math" >&2
  exit 1
fi

cat >"${HUMAN_DIR}/prose-math-pipe-ok.md" <<'MD'
The prose expression $|x|$ is not a Markdown table row.
MD
python3 "${SKILL_DIR}/scripts/bin/markdown_hygiene.py" check --root "${HUMAN_DIR}/prose-math-pipe-ok.md" --check-table-math-pipes

cat >"${HUMAN_DIR}/bad-github-math.md" <<'MD'
GitHub fragile math: $B_{s0}^*$), $\bar{D}_s$.
MD
if python3 "${SKILL_DIR}/scripts/bin/markdown_hygiene.py" check --root "${HUMAN_DIR}/bad-github-math.md" --check-github-math; then
  echo "expected check to fail for GitHub-fragile math" >&2
  exit 1
fi

JSON_ONLY_DIR="${TMP_DIR}/json-only"
mkdir -p "${JSON_ONLY_DIR}"
cat >"${JSON_ONLY_DIR}/agent-artifact.json" <<'JSON'
{
  "url": "https://example.org/not-markdown",
  "doi": "10.1000/not-markdown",
  "arxiv": "arXiv:2401.12345"
}
JSON
python3 "${SKILL_DIR}/scripts/bin/markdown_hygiene.py" check --root "${JSON_ONLY_DIR}" --human-facing

echo "[ok] markdown-hygiene smoke tests passed"
