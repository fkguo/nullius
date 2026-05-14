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

echo "[ok] markdown-hygiene smoke tests passed"
