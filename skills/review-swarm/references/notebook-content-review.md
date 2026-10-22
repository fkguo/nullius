Command, script and asset paths in this reference are relative to the `review-swarm` skill directory. Markdown links are relative to this reference. Cross-section names follow the routes in [SKILL.md](../SKILL.md).

## Single-reviewer entry (`review_one.py`)

### Full research-notebook review

Use the public `nullius notebook review --model <spec>` command for a
version-bound review of the whole research notebook. Its `notebook` role uses
this same `review_one.py` and `run_multi_task.py` execution path, records the
same `inputs/review_input_manifest.json`, and checks freshness before launch,
after execution, and again at current-version acceptance. The public command
defaults to a hard 1200-second budget and one attempt per bounded call. Declare
additional necessary files with repeated `--dependency <path>`; local linked
Markdown text dependencies are also discovered. It refuses unsupported text,
missing local files and resource shortfalls without truncation. Local directory
links leave original dependency closure pending and prevent acceptance. Remote
links are locators; a necessary unread dependency prevents acceptance.

Larger inputs use the `notebook-batch` role for each complete original interval
with adjacent raw context, followed by `notebook-crosscheck` receiving every
original byte of the full notebook and text dependency closure. All primary
intervals and every joint-audit inventory unit must be complete and fresh.
Every joint inventory unit requires exact original-byte anchors including substantive body text where present. Selected quotations or summaries cannot define or reduce that joint scope.
Storage (`--snapshot-bytes`, default 512 MiB; `--max-files`, default 256), per-call
byte/token context and the total execution budget (`--max-batches`, default 64)
are separate. Default context is a configured 200,000-token window with output
and protocol reserves; explicit larger byte packets need captured backend usage
when the conservative bound exceeds the window. Observed compaction or unverified capacity
supplies no acceptance. Resource shortfalls remain incomplete/unavailable and
report frozen/discovered material, pending scope and a `--resume` command.
Resume creates a new run, rechecks original receipts and material identity, and
never rewrites the old evidence. Batches do not constitute independent reviewers.

The coverage inventory partitions every line of the full UTF-8 notebook at
all top-level Markdown heading depths, including Setext and front matter.
No extraction removes comments, code or automatic blocks from the byte
binding. Automatic blocks remain navigation, not a derivation. The real
reviewer must read every section and supplied dependency, quote concrete
source anchors and explain the reasoning it examined: definitions,
assumptions, conventions, non-obvious intermediate steps, cross-section
logic, notation and validity limits. A selected-result review, links,
formula counts, self-evaluation, checklists or a hand-authored PASS cannot
substitute. Cross-file derivations cannot stand for necessary reasoning
inside the notebook. Notebook confirmation always covers the full current
notebook and dependencies; the [generic delta-only option](review-one-flags.md) is not a
whole-notebook acceptance route.

Evidence uses canonical verification subject/check-run/verdict/coverage and
ArtifactRef records. A notebook check-run is supporting semantic review,
never a placeholder decisive computation binding. `nullius notebook check`
reports structure and `content_review` separately and requires current
accepted full coverage by default. `--result` only scopes structure;
`--structure-only` only checks navigation. Missing, unavailable, failed,
partial, truncated, malformed or stale review evidence supplies no closeout
acceptance in either file or engine mode. Previous reports and original
verdicts remain readable. Record model family, method and input independence
separately; a single reviewer and fresh hashes do not establish scientific
truth or complete semantic independence.

The input manifest and execution records are content-bound evidence, not
cryptographic signatures against an owner who deliberately rewrites the
entire record and every hash. Preserve their hashes in a separately trusted
closeout record when that threat is in scope.
