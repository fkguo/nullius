---
name: review-swarm
description: Use when a result, manuscript, derivation, or diff needs independent review. Runs clean-room multi-agent review loops across Claude/Gemini/Codex/OpenCode/Kimi with strict review-contract checks, fallback policy, and convergence gates.
---

# Review Swarm (multi-backend)

This skill provides a reusable clean-room swarm harness for independent reviewers/analysts.

Core capabilities:
- Run **N agents** with `run_multi_task.py`.
- One-command **single-reviewer** entry with `review_one.py` (advisory; packet auto-assembled).
- Mix backends: OpenCode, Claude CLI, Codex CLI, Gemini CLI, Kimi CLI.
- Enforce strict review output contract (optional).
- Opt-in two-phase commit-then-review protocol (`--two-phase`).
- Apply fallback policy when a target backend fails/returns invalid output.
- Retry empty-output runs and report unreachable backends (`unavailable_backends`) so
  a degraded run reads as a backend outage, never as review disagreement.
- Record deterministic artifacts (`trace.jsonl`, `meta.json`, outputs).
- Gate on convergence (optional Jaccard similarity).

## Canonical entrypoint

Use `scripts/bin/run_multi_task.py` for all new multi-reviewer workflows, and
`scripts/bin/review_one.py` for a one-command single-reviewer pass (it delegates
into `run_multi_task.py` — one orchestration path).

Primary public skill name: `review-swarm`.
Use `review-swarm` consistently in documentation and automation references.

## Requirements

Install runner skills for any backends you plan to use:
- `opencode-cli-runner` (for OpenCode backend)
- `claude-cli-runner` (for `claude/...` models)
- `codex-cli-runner` (for `codex/...` models)
- `gemini-cli-runner` (for `gemini/...` models)
- `kimi-cli-runner` (for `kimi/...` models)

CLIs should be available in `PATH` according to the chosen backends.

## Host-aware execution (your own family runs native; quality first)

`run_multi_task.py` shells out to CLIs. Select reviewer models using identity evidence; a different
route does not establish a different family or independent inputs. Same-family reviews normally run
natively in-host. Host capabilities vary; gate on what your host exposes:

- **Single-family review → keep it in-host, not via that family's CLI.** If you only need YOUR family's
  reviewer (no cross-family swarm aggregation), run it in-host: use a native child-agent/sub-agent
  primitive if your host has one (your host's sub-agent / Agent-Task mechanism; OpenCode subagents), else run it inline
  in your own loop — don't `claude exec` a model you are already running as (latency, separate
  auth/session, context loss). Plain Claude Desktop / the Gemini CLI may have no sub-agent primitive →
  inline.
- **Aggregation includes only launcher-executed reviewers.** Its convergence and contract checks use
  the launcher's own output files. Keep native reviewers' reports separate; do not inject their files
  as completed launcher seats. If every intended seat must appear in one launcher report, execute those
  seats through its configured CLI runners, including a same-family CLI seat when necessary. That seat
  still needs exact identity evidence and supplies no additional family diversity.
- **Reasoning effort scales with review difficulty — quality first, not token thrift.** High-stakes,
  cross-package, or security-sensitive reviews warrant maximum thinking (extended thinking / high–xhigh
  reasoning effort / a stronger model); trivial diffs do not. Never accept a missed defect to save tokens.
- For a long/expensive swarm, prefer a steerable **background task chip** (e.g. your host's spawn-task / sub-agent launch)
  the user can inspect and adjust mid-run, when the host supports one; otherwise run inline and
  checkpoint. Capability varies by host — degrade gracefully.

## Agents file and honest degradation (below the cross-family minimum)

A machine may carry a third-party agents file (project level `.nullius/agents.json`, else user level
`~/.nullius/agents.json`; format and discovery order in the repository page docs/AGENTS_FILE.md)
mapping model families to execution routes and model strings. When one is present,
`run_multi_task.py` accepts `family:<name>` and `family:<name>:<tier>` model specs and resolves them
through the file. `meta.json` separates machine roster availability from completed eligible review
participation. Only a successful, contract-checked, uncontaminated delivery with exact identity evidence
counts toward the completed quorum; failed, partial, contract-invalid and unchecked deliveries do not.
A missing file still permits explicit model specs, but leaves their family evidence unknown.

The launcher records availability and participation separately; the degradation decision is yours
(the agent driving this skill):

- If the file declares fewer usable families than its cross-family minimum, or a `family:` request
  fails because that family is declared unavailable or its runner executable is absent, do NOT
  substitute another family and do NOT silently shrink the review. Follow the file's policy value
  (native subagents): run the review as a panel of your host's own subagents — multiple instances
  with distinct review perspectives (correctness, numerics, portability, ...).
- Label the outcome honestly in whatever you hand back: state the independence level (single-family)
  and list the absent families, so a degraded round is never mistaken for a cross-family one.
  Single-model agreement is the floor; cross-family agreement is the ceiling.
- A family configured with a native runner runs in-host and stays outside this launcher's aggregation
  (see Host-aware execution above).

## Identity and completed quorum

Each lane records the requested model spec, resolved dispatch route/model argument, separately reported
CLI model identity (or `null`) and named `family_evidence`. A resolved alias is not a provider identity.
Exact agents-file model mappings are declared evidence, not independent provider attestation. Unmatched
identities and provider-prefix guesses remain `unknown`; a successful fallback replaces the resolved
route/model and reported identity. Two different CLI routes never establish two model families.

`independence.participating_families`, `completed_eligible_count` and `below_minimum` describe completed
eligible participation. `declared_available_families` and `machine_below_minimum` describe roster/executable
availability. Neither can supply missing completed seats. `diversity` uses named family evidence;
`route_diversity` describes routes only. A useful terminal delivery can remain family-unknown.

`independence_evidence` keeps model-family evidence, tool exposure, input framing and method independence
separate. Unmarked input framing and method independence remain `not_machine_verified`; absence of a
contamination flag is not proof of clean inputs. Capture artifacts live beneath the seat's output prefix
in `OUT.attempts/run.*`; do not include them in a peer packet or workspace. Caller-owned workspace/read-path
membranes must deny peer and prior review payloads. Read-only built-in tools alone are not an OS filesystem
sandbox, so unrestricted browsing cannot attest isolation of private capture files.

## Quick start (single reviewer, one command — advisory)

For one reviewer, `review_one.py` assembles the whole packet for you (no
hand-written prompt files). Its model family remains unknown until evidenced;
treat its verdict as **advisory only** for artifacts that warrant a second
seat (the packet itself carries that caveat as its first line). **Cross-family
review is preferred, not required**, and which artifacts warrant a second seat
at all is a scoping decision, not a blanket rule: a second seat is for
result-bearing, public-surface, or irreversible artifacts — headline claims and
the derivations/numbers they rest on, cross-package contracts, default-entry
behavior (the same scoping the two-phase formal review section uses). Take that
seat from another model family when the machine has one (the launcher's
preflight over the agents file says which families are usable here: declared,
runner executable present; the family of a seat that ran is what its captured
identity evidence says, not what the file promised). When it has only one, the
second seat comes from the same family: it cannot establish model-family
independence, so the round is a degraded one and is recorded as
`single_family` (the launcher's independence record does this; never relabel
it). The other two axes are then recorded on their own terms, not assumed:
where the claim admits a candidate-withheld route (`--role source-extraction`
for a transcription, `derivation-verify` for a derivation, an independent
reproduction for a number), that route — raw inputs and a neutral question,
the candidate withheld — is the second seat, with the candidate-visible
comparison only afterwards, and the input axis is then genuinely independent;
where it does not (a manuscript, a design, a diff), the second seat is a fresh
reader that receives the artifact and the question but not the first seat's
report, any prior verdict, or the author's framing beyond the artifact, and
its input axis is recorded as candidate-visible — a review, not a
reproduction. A degraded round closes the artifact under this policy because
the alternative on a one-family machine is no second seat at all, not because
the label makes it equivalent to a cross-family one. Internal
implementation variants — writers, fixtures, launchers, schema plumbing —
close on a single-family review plus local tests either way (an implementation
never closes on its author's own tests alone). Reviewer investment scales with
the artifact's stakes the same way reasoning effort does; spending a
cross-family panel on every internal diff is the recorded waste pattern, not
the safe default.

```bash
python3 scripts/bin/review_one.py \
  --model codex/default \
  --artifact /path/to/notes.md \
  --role correctness
```

See "Single-reviewer entry" below for the full flag set.

## Quick start (reviewer selection and family evidence)

Select the intended models explicitly and map their exact model identifiers in an agents file when
family attribution is required. Same-family native reviews stay separate unless deliberately executed
as CLI seats for aggregation (see Host-aware execution above). Wired routes are `claude/...`,
`codex/...`, `gemini/...`, `kimi/...`, and any OpenCode `provider/model`. The examples below suggest
routes from each host; the route labels alone do not prove the executed families:

- From a **Claude** host → `codex/...`, `gemini/...`, `zhipuai-coding-plan/glm-5.2` (not `claude/...`).
- From a **Codex** host → `claude/...`, `gemini/...`, `zhipuai-coding-plan/glm-5.2` (not `codex/...`).
- From an **OpenCode/GLM** host → `claude/...`, `codex/...`, `gemini/...` (not the OpenCode lane).

Example, driven from a Claude host (three non-Claude reviewers):

```bash
python3 scripts/bin/run_multi_task.py \
  --out-dir /tmp/cross_family_review \
  --system /path/to/reviewer_system.md \
  --prompt /path/to/packet.md \
  --models codex/default,gemini/default,zhipuai-coding-plan/glm-5.2 \
  --agents-file /path/to/agents.json \
  --check-review-contract
```

Choose the intended reviewer models explicitly. Verify actual identity and input/method independence
before crediting the review; there is no automatic family rotation to rely on.

## Convergence check

```bash
python3 scripts/bin/run_multi_task.py \
  --out-dir /tmp/multi_review \
  --system /path/to/system.md \
  --prompt /path/to/task.md \
  --models codex/default,gemini/default,zhipuai-coding-plan/glm-5.2 \
  --check-convergence \
  --check-review-contract \
  --agents-file /path/to/agents.json \
  --convergence-threshold 0.8
```

`--check-convergence` measures **lexical similarity** between completed eligible reviewer outputs
(Jaccard). It is a signal that reviewers are talking about the same things —
it is **not** the acceptance convergence defined in the gate-loop discipline
below: two similar NOT_READY reviews sharing the same blockers score high
similarity while the artifact is not accepted at all. Acceptance convergence
is always read from **contract-valid** verdicts (zero BLOCKING findings on the
current artifact, dispositions complete), never from this similarity score; a
malformed delivery joins the count only after its same-model normalization
rerun (see the disposition rule under Contract checking). `convergence.converged` additionally requires
at least two eligible outputs and the declared completed-family quorum. Unknown identities, unchecked
contracts and unavailable roster entries cannot supply that quorum. `quorum_satisfied` records this
condition separately from the similarity value.

### Re-review after every fix (gate-loop discipline)

Convergence is a property of the **reviewers' agreement on the current artifact**, never a
self-pronouncement after applying a fix. The gate loop is review → fix → **re-run the independent
reviewers on the fixed artifact** → repeat, and it converges only when the reviewers themselves return
clean. Re-review after **every** correction round, including ones that look trivial or single-line: a fix
can introduce a **new** defect — a corrected transcription line that silently drops a magnitude factor, or
a refactor that re-breaks an invariant — that exists only after the fix and is caught only by the next
independent round. Skipping the confirmation round because the change "obviously" closed the finding is the
failure mode this rule exists to stop. The leader integrates and decides, but does **not** declare
convergence in place of the reviewers.

**"Clean" is defined by severity, and the loop has a stop condition.** Reviewers grade every finding
on a shared three-level scale:

- **BLOCKING** — changes a result, claim, or contract; violates input identity, target-value
  isolation, or origin traceability; turns a silent failure into an apparent success; or is a
  quantitative discrepancy of the reference-reproduction kind (the order-of-magnitude/sign-reversal
  rule below is the exemplar). BLOCKING findings must be fixed and re-reviewed.
- **HIGH** — a correctness risk inside the declared scope that does not change current results
  (e.g. a declared failure mode with no regression test). Fix before the artifact's acceptance
  point; a batch of HIGH fixes takes one confirmation round together, and does not restart the
  full independent panel unless production logic changed.
- **LOW** — hardening beyond the declared scope, mutation-style test strengthening, style. Never
  blocks by itself; each LOW finding gets an explicit disposition (fix now / attach to a named
  acceptance point / discard with a stated reason) — dispositioned, not silently dropped.

Convergence = zero BLOCKING findings on the current artifact, every HIGH fixed or scheduled at its
named acceptance point, and every LOW dispositioned. When another workflow's severity scheme also
applies to the same artifact (e.g. a member-cycle blocking/non-blocking grading), the stricter
classification governs: an in-scope correctness risk that is HIGH here never demotes to a
deferrable non-blocking finding there — it blocks the artifact's acceptance point either way. A round that produces only LOW findings is a
converging round, not grounds for another full cycle. Once an artifact has passed a full review pair,
later findings re-open it only if they meet the BLOCKING bar — "keep reviewing until no reviewer can
imagine a stronger test" is an unbounded loop, not a standard. A later non-BLOCKING finding still
receives the standard disposition (fix now / attach to a named acceptance point / discard with a
stated reason): not re-opening the artifact is not discarding the finding.

The loop is also **bounded**: cap review rounds per artifact (default 5, counting every round that
reviewed a candidate of this artifact). Hitting the cap is not a license for one more round — it
forces the narrowing rule: narrow the artifact's scope, reduce the claim's strength, or take the
blocking question to the project owner. The mandatory confirmation round after an applied fix batch
is unaffected — the cap bounds how many candidate revisions the loop may consume, not whether a
revision gets its confirmation. Batch fixes: one confirmation round
covers the whole accumulated fix batch, scoped to the exact delta by default (see packet composition
above). Review verdicts are judged on content: a source-grounded READY whose verdict string or label
spelling deviates from the requested format is a normalization task, never a new blocking round —
a same-model rerun re-emits it in contract shape (the disposition rule under Contract checking).
Leader transcription is NOT a convergence path: an output the reviewer did not re-deliver in
contract shape stays out of the count no matter how unambiguous its verdict reads — archive the
original for diagnosis and rerun the seat. An ambiguous verdict is never normalized into a pass;
it fails closed as usual.

The verdict is scoped to the exact hashes in `inputs/review_input_manifest.json`.
Before counting an older run toward a later convergence or closeout, rerun the
freshness check:

```bash
python3 <nullius-root>/skills/review-swarm/scripts/bin/verify_review_freshness.py \
  --review-dir /path/to/review-out
```

Require `status: FRESH`. A target, source, correction record, context, system prompt,
packet, or diff mismatch is `STALE`, even if the edit is one character and the prior
model output says READY. Re-review the full current artifact or the complete exact delta
from the reviewed hash. Running the checker once does not authorize later edits; any
post-check mutation invalidates the acceptance state.

The standalone checker returns `0` for `FRESH`, `3` for `STALE`, and `2` for an invalid
or unreadable manifest. The `review_one.py` entry instead returns `86` when its model run
succeeded but acceptance is `STALE` or `UNVERIFIABLE`, so it remains distinguishable from
the delegated model result. Automation should treat the JSON `status` as authoritative
rather than assuming both entry points share one numeric convention.

The manifest is a trusted launch record, not a cryptographic signature over itself.
This gate catches accidental or uncoordinated post-review drift. If deliberate co-editing
of both an input and its manifest is in scope, commit the review directory or persist the
reported manifest SHA-256 in an external closeout record before accepting the verdict.

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
notebook and dependencies; the generic delta-only option below is not a
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

`scripts/bin/review_one.py` is the one-command way to get a single independent
reviewer with zero hand-written files. It builds the system prompt from a role
template, embeds your artifacts (or a git diff) into an auto-assembled packet,
then delegates to `run_multi_task.py` (same directory), inheriting runner
discovery, per-backend read-only tool modes, the process-group timeout,
`trace.jsonl`/`meta.json` artifacts and contract checking. Its delegated run
also opts in to one orchestrator-level empty-output retry except for the notebook
role, which always uses zero retries (`--retry-empty-output 0`). The launcher
default is `0`; other review_one roles use `1`.

```bash
python3 scripts/bin/review_one.py \
  --model gemini/default \
  --artifact /path/to/extraction_note.md \
  --source /path/to/exact_source_excerpt.tex \
  --source-text-origin direct-original-text \
  --correction-status checked-corrections-included \
  --correction-source /path/to/exact_erratum_excerpt.tex \
  --correction-search-evidence /path/to/correction_search_record.md \
  --role source-fidelity \
  --out-dir /tmp/one_review
```

For the candidate-withheld pass that must precede comparison of a load-bearing
source item, use the separate role. Its packet structure accepts a neutral
request but rejects candidate artifacts, diffs, and additional context:

```bash
python3 scripts/bin/review_one.py \
  --model gemini/default \
  --extraction-request /path/to/neutral_questions.md \
  --source /path/to/visually_transcribed_source.txt \
  --source-text-origin visually-verified-transcription \
  --source-provenance-evidence /path/to/page_crop_check.md \
  --correction-status checked-none-found \
  --correction-search-evidence /path/to/correction_search_record.md \
  --role source-extraction \
  --out-dir /tmp/source_extraction
```

Read [`references/review-one-flags.md`](references/review-one-flags.md) when choosing or checking a `review_one.py` flag (packet inputs, source-role declarations, candidate-commit binding, confirmation-round deltas, output and budget options) (the `Flags:` list, moved there verbatim).

The assembled packet's first line is a single-reviewer advisory caveat. One route or alias does
not establish a named model family; family and other independence evidence must be checked separately. When the reviewer returns,
the launcher recomputes every manifest hash, writes `post_review_freshness.json`,
records the status in `meta.json`, and prints `acceptance_status` with the model
verdict, `contract_ok`, and the output/packet/meta/trace paths. A successful model
verdict with stale or unverifiable inputs exits with the dedicated status `86`; the
model verdict remains historical evidence, not a verdict on the changed artifact.
This immediate `FRESH` status means only that the inputs did not change while that
review ran. Durable closeout still requires rerunning the standalone checker immediately
before the verdict is folded into a conclusion.

Read [`references/backend-overrides-and-tool-modes.md`](references/backend-overrides-and-tool-modes.md) when overriding a backend's prompt, system prompt, output, tool mode or deadline, or granting a reviewer tool access (the `Backend overrides` and `Reviewer Tool Modes` sections, moved there verbatim).

### Execution adversary (mandatory for correctness-critical / method-precondition reviews)

A read-only review is a *static read*; it cannot confirm a runtime property. When a review must establish
that a method's load-bearing precondition actually holds — an operator identity (commutation with a
projector/symmetrizer, Hermiticity, self-adjointness, idempotency, unitarity, variational/Galerkin-subspace
invariance), a numerical invariant, or a true-operator eigen-residual — at least **one reviewer must take an
"execution adversary" role**: load the artifact and *execute* the disconfirming test at the **production
scale/configuration**, not statically read the code. Give that reviewer real execution access (a host-native
sub-agent with run/Bash, or a sandbox that can execute), and record in `meta.json` whether each reviewer
**executed vs. only read** the precondition checks. A swarm in which *no* reviewer executed the precondition
is a **static-only** swarm and must be labeled as such — it does **not** count as a precondition pass. (A
static read can certify code shape; only execution at the production scale can certify that a discretized /
implemented property actually holds — a property can read as correct and still fail numerically above the
minimal size.)

### Source-fidelity reviewer (mandatory for transcription / source-extraction artifacts)

A **source-extraction / transcription note** — a deep-read / knowledge-base note that transcribes
equations, numeric values, source locators, and term-by-term mappings onto a consuming artifact from a
primary source — is a **valid gate target**, not a gate-exempt "reading task." Its primary observable is
**fidelity to the source**, so the review is a different shape from a code/design review: at least **one
reviewer must do a LITERAL, line-by-line comparison of the note against the primary source with "do not
trust the note."** Loose semantic agreement is insufficient — transcription drift (a flipped sign, a
dropped magnitude factor, a transposed digit, a stale locator, or a stale mapping to the consuming
artifact) reads as plausible and is caught only by literal comparison. Draw that reviewer from another
model family when the machine has one (preferred: two families rarely share a transcription habit, and a
same-family looser read tends to pass exactly the defects it is meant to catch); when it has only one, the
literal comparison is done by a fresh same-family reader after a candidate-withheld extraction, and the
gate is recorded as single-family — a degraded gate, never relabeled.

Give that reviewer the **persisted primary source** (the exact text that was transcribed), not the note
alone, plus the transcription/extraction failure checklist (`research-integrity` → *Extraction /
transcription fidelity*). Declare whether those bytes are direct original text or a visual transcription;
the latter also requires separate source-provenance evidence. With `review_one.py`, first run
`source-extraction` with repeatable `--source`, an exact `--extraction-request`, explicit
`--source-text-origin`, explicit `--correction-status`, and the required correction-search
evidence. This role rejects candidate artifacts, diffs, and additional context and writes
`inputs/source_extraction_manifest.json`. Then run the candidate-visible `source-fidelity` comparison,
passing the candidate via `--artifact`/`--diff`, the same source separately through repeatable `--source`,
and each applicable correction through repeatable `--correction-source`. The launcher writes
`inputs/source_fidelity_manifest.json` with primary/correction/search-evidence and target hashes, diff range
when applicable, ordered additional-context paths and hashes, correction status, and candidate visibility. Context content is
explicitly marked as not machine-classified because the launcher cannot know whether it contains a prior
verdict or proposed answer. Both roles fail closed before model launch if required source, correction,
or correction-search evidence is absent or invalid. Both manifests mark source dependency closure as
`not_machine_verified`, and the extraction manifest marks request neutrality `not_machine_verified` (the
fidelity manifest records it as `not_applicable`, since that pass carries no neutral request); the reviewer,
not the packet assembler, must decide whether the question leaks an answer and whether all required
domain/branch/convention premises are present.
The extraction input manifest certifies only that a candidate-withheld packet was constructed; it does not
claim the extraction was completed. Completion belongs to the reviewer output and `meta.json` verdict.

The source set must include the applicable correction chain. For a load-bearing paper,
record whether an erratum, corrigendum, expression of concern, retraction, revised
version, or later explicit author correction was searched and found. If a correction
supersedes a formula or statement, give the reviewer both the printed source and the
correction, and require the artifact to distinguish the pre-correction and corrected
forms. A literal match to the original but superseded text is not a fidelity pass.

The reverse case needs equal care: a search that found no erratum does not certify the
printed source as scientifically correct. If an equation or statement appears internally
inconsistent, preserve the exact printed form and open a separate suspected-source-error
record. Keep `PRINTED_FORM`/`SOURCE_FIDELITY_STATUS` distinct from
`SCIENTIFIC_STATUS`/`PROPOSED_CORRECTION`/`EVIDENCE_AND_COUNTERCHECKS`/
`DOWNSTREAM_POLICY`. Source-fidelity checks the first track only. For a re-derivable item,
the second track needs candidate-withheld independent re-derivation through
`derivation-verify`, with every premise checked to exclude downstream consequences of the
disputed item. For an empirical or reported numerical item, it needs independent
reproduction from the underlying data, calculation, or measurement; downstream sources
that merely repeat the claim are not independent. For a non-derivable convention, label,
or prose statement, require independent primary records, internal definitional closure,
or author clarification; repetition and citation count are not votes. Agreement with a
conjectured repair does not turn it into source text, a published correction, or an
author-confirmed correction. If the repair is not unique, retain
`unresolved_source_error` and block silent downstream selection.

The manifest distinguishes each original file's SHA-256 from the SHA-256 of the UTF-8 text embedded in the
packet. Primary-source text is strict UTF-8 and is inserted without trimming, so those two hashes agree;
artifact/context decoding may use replacement characters and therefore records both hashes explicitly.
Diff targets likewise record raw and embedded-text hash fields for schema symmetry; because `git diff`
is decoded and embedded as the same UTF-8 text, those two values currently agree.
Each entry also records whether one delimiter newline was added after a payload that lacked a terminal
newline; that delimiter is packet framing and is not part of the embedded-text hash.

Keep four layers separate in both the packet and the verdict: **literal source**, **normalized
transcription**, **symbol dictionary**, and **derived mapping/inference**. A correct derivation from a
wrongly transcribed formula does not certify the transcription. Require the reviewer to localize the first
divergent source token or mapping step rather than only compare final formulas.

Conflicting visual transcriptions do not become source truth by vote. Reinspect the original page or a
lossless crop; if the surviving pixels still do not distinguish the disputed glyph, keep the inventory item
`AMBIGUOUS` and require the candidate artifact to preserve that uncertainty. Do not collapse it to the
mathematically expected sign, exponent, relation operator, or endpoint convention.

An exhaustive source-fidelity claim needs an exhaustive comparison surface. If the verdict says that all
formulas in a paper or section were checked, persist a locator inventory of every displayed equation and
every adjacent formula-like condition in that scope, with an item-level status. A selected-item pass cannot
be promoted to complete coverage. In either scope, explicitly sweep signs, coefficients or factors,
operators, indices or subscripts, relation operators or interval endpoints, numerator/denominator
placement, exponents, primes, function arguments, and integration limits; algebraic or dimensional
consistency is a separate check.

Model-family independence, method independence, and input/framing independence are different axes. A
cross-family reviewer that sees the same faulty note, prior verdict, or proposed correction is not an
input-independent extraction. For a load-bearing source item, first obtain at least one
**candidate-withheld extraction** with the `source-extraction` role; only then show the candidate note for
the literal `source-fidelity` comparison. The extraction manifest records
`candidate_visibility=withheld_by_packet_structure`, while also stating that request neutrality is not
machine-verified. Feedback iterations state a discrepancy and source locator as a hypothesis; they must
not feed the desired corrected formula back as an assumption.

Record whether a literal cross-family source comparison was performed; a swarm that only read the note,
stayed within one model family, or shared one candidate-anchored input without a candidate-withheld pass is
**not** a full fidelity pass and must be labeled as such.

For PDF or scanned sources, a text-only packet cannot establish source fidelity by itself. The gate also
requires a PDF/image-capable reader to compare the original rendered page (or a lossless page crop) with
the persisted excerpt. Record both the original file/page hash and crop hash. OCR or `pdftotext` output is
a discovery aid only; agreement between the note and OCR cannot certify a formula that OCR misread.

### Artifact-integration reviewer (for rendered research artifacts)

When a workflow turns source-read notes into a rendered artifact — for example an interactive literature
graph, slide deck, dashboard, or browsable note bundle — include at least one reviewer whose task is to
inspect the **current rendered artifact and its source files**, not merely the synthesis prose. This reviewer
checks integration failures that source-fidelity review alone cannot see: broken relative links, missing
images, unrendered math, non-clickable connected references, stale note paths, layout collisions, and a
renderer that displays placeholders or filenames instead of the intended evidence.

Write reusable workflows in terms of reviewer roles and capabilities, not specific model names. A concrete
run may choose particular models, but the skill or project contract should say "independent cross-model
artifact reviewer" or "source-fidelity reviewer" unless a user explicitly pins a model for that run.
After any artifact fix, rerun the reviewers on the fixed artifact before calling convergence
(the confirmation round follows the gate-loop discipline below: delta-scoped by default,
severity-graded, one round per fix batch).

### Reference-reproduction reviewer (mandatory for "matches / reproduces a published value" claims)

A claim that a result **reproduces / matches / agrees with a published reference value** is a *quantitative*
claim a static read cannot certify — reading the prose only confirms the prose. When a packet asserts such a
match, at least **one reviewer must take a "reference-reproduction" role** and cover three distinct dimensions
that a correctness / methodology / honesty review routinely passes over:

- **D1 — recompute and compare.** **Compute the claimed observable on a comparable state / regime /
  configuration and compare to the published number numerically** — do not accept a qualitative "same order
  of magnitude / same sign / right scale" assertion, and do not accept the citation as if citing the source
  proved the match. Compare **term by term** where the claim is term-level (a net total can agree while
  individual contributions are suppressed or sign-flipped). **An order-of-magnitude same-direction
  discrepancy, or a sign reversal, is a BLOCKING finding, not a pass.** Give this reviewer real execution
  access (a host-native sub-agent with run/Bash, or an executing sandbox) when the comparison requires
  computation.
- **D2 — the independent cross-check did not silently lapse.** Confirm that any cross-validation evaluates
  the *same* model with independently constructed and executed checks. Record the actual method and shared-failure risks. A structurally **different-model** engine, or a check valid only in
  a degenerate / limit regime, must be **labeled as a different-model / limit-regime comparison, not
  presented as validation**; and when no apples-to-apples independent check is feasible, the **absence is
  recorded as an explicit stated limitation** rather than an established cross-check being allowed to
  silently disappear.
- **D3 — the transcription axis was gated (when the source's own prescription is claimed).** When the
  packet claims the source's *own prescription* was solved or reproduced, confirm it demonstrates that the
  model being solved IS the source's — the frame-map / elementwise-identity / as-printed-run evidence
  defined by the `research-integrity` *Reference-reproduction fidelity* D3 dimension and
  `numerical-reliability-gate` G2's shared-model-definition clause. Internal convergence and cross-method
  agreement cannot certify this (every internal route shares the model definition), so such a reproduction
  claim with an ungated transcription axis is unverified regardless of how well the numbers agree. A
  comparison that does not assert the source's prescription owes no frame map — a different-model
  comparison is covered by D2's labeling, and a comparison against measured/experimental data is a
  measurement comparison, not a model reproduction.

Record in `meta.json` whether a reviewer **computed-and-compared vs. only read** the match assertion; a
swarm in which *no* reviewer recomputed the claimed observable on the comparable state is a **static-only**
swarm for that claim and must be labeled as such — it does **not** count as a reference-match pass.
Cross-model-family diversity strengthens this gate. Pair it with `numerical-reliability-gate` **G8** (the
compute-and-compare gate, returning `reference_mismatch` on an order-of-magnitude or sign gap) and the
`research-integrity` *Reference-reproduction fidelity* dimensions.

### Independent-recomputation reviewer (mandatory for load-bearing structural claims)

A cross-family review that only re-reads evidence supplied by the claimant is an **argument audit**, not a
verification: its "confirm" can sit entirely inside the claimant's blind spot, because the supplied
evidence may probe the wrong axis altogether. The reference-reproduction reviewer above is the special
case where a published number anchors the check; the general contract covers any **load-bearing
structural claim** — a claim about what a computed object *is* (its shape, degeneracy structure, scaling,
sign structure, convergence behavior) on which downstream conclusions rest. For such a claim, at least
at least two evidence lanes must independently construct or derive and execute the check,
receiving **only the problem statement and the raw inputs** — never the claimant's answer, evidence selection, or initial judgment. Same or similar sound methods may count; method diversity, model-family diversity, execution independence and input independence are separate dimensions. An explicit project shared-failure risk may require a different mechanism that tests that risk. Record in `meta.json`
**which axis the independent recomputation actually probed** (what it could have falsified); a
recomputation whose probed axis does not intersect the claim's load-bearing axis leaves the swarm
static-only for that claim, and it must be labeled as such rather than counted as a verification pass.

### Reviewer context isolation and sealed-first-phase discipline

Input-framing independence dies through the environment, not just the packet. Two rules, both learned
from real contamination events that voided otherwise-clean review rounds:

- **Strip ambient work-state from the reviewer's context.** A reviewer must not receive agent
  rosters, task listings, other workstreams' status lines, or any environment surface that can carry
  another lane's conclusions — one leaked status line about a sibling result is enough to anchor the
  reviewer and void the round. The dispatch assembles a context containing the packet and nothing
  else, and records in `meta.json` which surfaces the reviewer could see. Contamination is about
  receiving **conclusions**, not about reading **source**: a source-grounded review lane is required
  to read the real code, and read-only repository access never forfeits its independence credit.
  Failed, partial and contract-invalid deliveries cannot supply completed seats. Three additional lane
  classes lose comparison credit: lanes running a *writable* workspace tool mode
  (discovery-grade — the reviewer read-only rule cannot be attested for them), lanes whose ambient
  context carried another workstream's conclusions, and fallback lanes with no recorded execution
  model (reason `model_unattributed`: a backend-default recovery leaves the executed family
  unattested, and on a multi-family provider that would let an unknown family pair into a false
  cross-family claim — explicit fallback-model flags exist for the codex and claude backends;
  other backends' default recoveries stay unattributed, which is the conservative direction). Sealed
  derivation/recomputation lanes obey the stricter frozen-inputs-only contract of their own
  protocols (the sealed-derivation rule below and the independent-recomputation section above):
  launch those ONLY on backends whose modeled tool mode is explicitly a no-repo-access mode. The
  per-result `execution_tool_mode` field in `meta.json` records the launcher-modeled mode of the
  resolved execution backend — `null` means the backend is unmodeled and **attests nothing**, and
  a backend whose runner is inherently repository-readable (a read-only sandbox, recorded as
  `review`) is a browsing lane: fine for source-grounded review, never for a sealed derivation.
  When ambient listings reached the reviewer anyway, the
  round's disposition is `AMBIENT_CONTEXT_CONTAMINATED`: it earns **zero** independence,
  comparison, acceptance, or convergence credit, and its output is retained for diagnosis only.
  (This disposition is distinct from the legitimate *candidate-visible* second pass of the
  source-fidelity protocol — a contaminated round never becomes a valid candidate-visible
  comparison by relabeling.) Machine support: `run_multi_task.py` decides credit per lane from the
  **resolved post-fallback** execution backend — a lane recovered onto another backend is judged by
  where it actually ran, and a failed lane never earns a seat or convergence input. Excluded lanes
  (reason `tool_mode:workspace` or `model_unattributed` automatically, or reason
  `AMBIENT_CONTEXT_CONTAMINATED` via the repeatable `--contaminated <selector>` flag, matching the
  model spec as given, the resolved spec, the backend, the family name, or `backend/model`) appear
  with their lane index under `independence.non_independent_lanes`, never count toward the
  cross-family level, are filtered out of the convergence similarity set
  (`convergence.excluded_non_independent` names them), and never occupy a dual-review comparison
  seat. A `--contaminated` selector that matches no lane aborts the run before execution — a
  declared contamination must never silently fail to bind.
- **Keep the operator's own context out of the lane.** Input-framing independence also means the lane
  carries no operator memory: no user-level instruction files, no project instruction files of the
  operator's checkout (`CLAUDE.md`, `AGENTS.md` and the like), and no auto memory of earlier sessions.
  Those files routinely record the conclusion under test or the author's initial judgment, and their
  style rules change the lane's language. Anything a lane legitimately needs belongs in its own request.
  The Claude runner enforces this by default (`--safe-mode`; `claude-cli-runner` SKILL.md, **Context
  sources**) and records the allowed sources per invocation in `OUT.attempts/run.*/context_sources.json`,
  plus the observed init-event check under live capture. Other backends' runners do not yet record this;
  their lanes carry no such attestation.
- **Seal the independent phase from the first round (sealed-derivation protocol).** Whenever a
  review both (i) derives or recomputes a target quantity and (ii) will afterwards read the
  candidate, run the sealed-derivation protocol from round one: the reviewer receives only the
  frozen problem statement and raw inputs, derives, persists that derivation (content hash
  recorded) and **terminates**; only then does a comparison pass open the candidate. This is NOT
  the `--two-phase` flag below — that protocol commits *review criteria* before revealing the
  packet and never seals a derivation; invoking it does not satisfy this rule. Retrofitting the
  sealed order only after a contamination event pays for the same round twice; opening the
  candidate before the sealed derivation exists voids the independence claim regardless of intent.

## Model selection

- `--models a,b,c`: explicit model specs for launcher-executed seats; exact identity mappings
  are required before those seats supply family quorum.
- `--agents N`: rotate through available OpenCode config models (legacy convenience;
  prefer explicit `--models` for reviewer runs).
- `--model default`: one OpenCode agent, CLI default model.
- Mixed backends supported: `claude/...`, `codex/...`, `gemini/...`, `kimi/...`, OpenCode `provider/model`.

### Default-model policy (hard rule)

When model is omitted or set to `default`, **do not inject historical model names**.
Always delegate to each backend CLI's configured default model.

This rule applies to all backends:
- OpenCode
- Claude CLI
- Codex CLI
- Gemini CLI
- Kimi CLI

Read [`references/fallback-and-outages.md`](references/fallback-and-outages.md) when a backend is unavailable, a fallback must be chosen or recorded, or a packet approaches the prompt-size limit (the `Fallback policy`, `Backend outage handling` and `Prompt-size guardrail` sections, moved there verbatim).


## Contract checking (delivery shape)

`--check-review-contract` validates output format compliance and records results in `meta.json`.
Contract failures never trigger backend fallback and never mark the lane failed — content
matters more than format, and the output is always retained. They DO withhold the lane from
convergence/credit aggregation (`excluded_contract_invalid` in the convergence record, and no
dual-review comparison seat): an unfinished delivery cannot occupy a seat. The remedy is the
disposition rule below, never silent exclusion.

If you want models to output a specific format, include format instructions in your system/user prompt.

### Malformed delivery ≠ rejected opinion (disposition rule)

A failed contract check means the reviewer has not finished **delivering** — never that the
review's substance was weighed and found wanting. The contract validates delivery shape
(parseable verdict line, the fixed severity homes, archivability against the next round);
it has no opinion about the reasoning inside. Dispose of a contract-invalid review in
exactly one way:

- **Rerun same-model with the missing pieces named** (the runner records them in
  `contract_errors` and a `contract_remedy` hint). The reviewer already did the reading;
  re-emitting in contract shape is one cheap round. The Gemini and OpenCode caveats above
  are instances of this rule, not backend-specific allowances.
- **Never record a hybrid terminal state.** "Format-invalid but substantively supportive"
  must not enter a convergence count, a formal status line, or a closeout packet — not as
  a downgraded vote, not as a qualified-consensus footnote. Convergence counts
  contract-valid verdicts only; every other seat is either rerun until valid or honestly
  recorded as "this seat delivered no valid review". Once same-model rerun attempts are
  exhausted (bounded by your retry budget), the leader applies the fallback policy exactly
  as for any other failed seat — substitution or honest degradation; the runner itself
  never auto-falls-back on contract grounds. The invalid output is retained for diagnosis.
- **The inverse also holds.** Contract-valid says nothing about substance: a well-formed
  placeholder verdict is still rejected by the substantive checks (blank/short-output
  detection, source-grounding requirements).

The failure mode this rule closes: a reviewer reads the material, reaches a grounded
verdict, misses required sections — and the leader "honestly downgrades" it to a
format-disqualified side opinion, excluded from convergence yet still cited. That inverts
substance-over-format twice: the substance is discarded where it counts (the gate) and
kept where it cannot be checked (the prose). Rerun the seat; count only what is both
contract-valid and substantively grounded.

Standalone checker:

```bash
python3 scripts/bin/check_review_output_contract.py /tmp/dual_review/claude_output.md
```

Contract auto-detects output format:
- **Markdown**: `VERDICT: READY/NOT_READY` first line + required headers (`## Blockers`, `## High-severity`, `## Non-blocking`, etc.) — the three severity buckets give every grade of the canonical ladder a fixed home
- **JSON**: Valid JSON object with `blocking_issues` (array), `verdict` (`PASS`/`FAIL`), `summary`

JSON outputs wrapped in markdown code fences (`` ```json ... ``` ``) are automatically unwrapped.

Read [`references/two-phase-protocol.md`](references/two-phase-protocol.md) when a review is run with the opt-in `--two-phase` protocol or declared review criteria (the `Two-phase review protocol` section, moved there verbatim).

Read [`references/outputs-and-runner-parity.md`](references/outputs-and-runner-parity.md) when locating a review's output files or weighing how the backends differ in system-prompt delivery and file access (the `Outputs` and `Runner parity notes` sections, moved there verbatim).

## Skill name note

Use `review-swarm` as the canonical external name.
Use `review-swarm` consistently during migration and in new integrations.

Capacity evidence requires an adjacent runtime observation of the actual successful invocation, including requests that fit the conservative byte bound. The local runtime binds the complete original request, actual report locator, working directory and captured bytes using its host authority; recalculating project artifact hashes cannot create that observation. Verification trusts the runtime and owning OS account, and does not authenticate provider truth or scientific correctness. Historical unsigned records remain readable, but cannot supply new capacity acceptance; they are never retrospectively signed.

Runtime observations bind the actual report location, so copying signed capture bytes cannot authenticate a new invocation elsewhere. Member episodes freeze every observed file into durable original storage before publication; successful workspace cleanup preserves subsequent verification. Records lacking these bindings remain readable and unavailable for new acceptance.

Member origin trusts the configured runner and owning host runtime: the complete runner bytes are recorded, but no runner allowlist or provider attestation is claimed. Offline or injected host execution establishes a local process/callable observation; actual provider capacity evidence requires the corresponding CLI capture. The canonical team cycle performs a postflight source assessment and a separate fresh assessment at the final consumer; both use the configured assessor request/execution budgets.

The owning account can read the authority key, including code executed by a member under that account; this authenticates against non-executing artifact tampering, not hostile same-account code. No OS sandbox or provider attestation is supplied.

The configured token window is frozen before the original reviewer subprocess starts and bound into its authenticated runtime observation. Changing historical window metadata cannot admit that receipt. Older observations without this policy remain readable and require a fresh execution for capacity acceptance.
