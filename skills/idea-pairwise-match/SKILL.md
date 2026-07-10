---
name: idea-pairwise-match
description: Judged pairwise comparison between two research ideas in a campaign. Commit the comparison criteria to disk first (sha256 over the canonicalized list), generate symmetric anchored advocacy statements, collect independent votes from a judge panel drawn from the third-party agent roster (agents.json; at least three distinct model families for a cross-family match, with an honest single-family native subagent degradation when the roster cannot field that floor), and write a pairwise_match_v1 artifact whose outcome enters the belief layer as one observation. Arguments without a literature or computation anchor are discarded and counted, never weighed. Use when a campaign needs a relative-merit signal between two idea nodes beyond their individual posteriors, when choosing which of two competing ideas to advance, or when a newly admitted idea needs a calibrated first comparison.
---

# Idea Pairwise Match (criteria-committed, cross-family judged)

Compare exactly two idea nodes of a campaign under criteria that were
committed to disk before any advocacy was drafted and before any judge ran,
with a judge panel drawn from the model families of the third-party agent
roster, and record the result as a `pairwise_match_v1` artifact. The outcome
is an observation for the belief layer, never an elimination: the loser keeps
living in the campaign with a lowered worth, and can win a later match when
new evidence arrives.

## What a match measures, and what it does not

- The belief layer (skill `idea-posterior`, backed by the Gaia argument
  graph) owns each idea's overall worth posterior, built from literature and
  computation evidence attached to the idea's claims.
- A pairwise match measures only the residual relative merit that per-idea
  evidence does not settle: with both cards on the table and a fixed set of
  criteria, which idea is stronger right now.
- One match produces at most one observation (see the fixed mapping table
  below). It never deletes a node, never sets a posterior directly, and a
  single match is deliberately capped below the evidence weight that
  accumulated anchors can reach.

## Inputs

Two idea nodes from campaign storage, each with a complete idea card. The
fields this protocol consumes:

- `node_id`: engine short id — 8 chars of lowercase Crockford base32,
  pattern `^[0123456789abcdefghjkmnpqrstvwxyz]{8}$` (the idea_node_v1
  convention).
- `title`, `gist`, `status`: short descriptive strings; the node should not
  be archived or parked (a contest is effort spent on it).
- `claims`: non-empty array; each claim carries its `support_type`
  (literature or computation) and `evidence_uris`.

Claims are assumed to have passed content vetting upstream (the
`claim-grounding` skill). Judges weigh anchored arguments; they do not fetch
or re-verify sources during a match.

Synthetic demonstration cards live in `examples/`; they are placeholders for
tests and dry runs, not research content.

## Paths

Everything for one match lives under the campaign:

- `artifacts/matches/match-<match_id>.json`: the final artifact.
- `artifacts/matches/match-<match_id>.work/`: working materials, referred to
  as WORK below: `commitment.json`, `card_summary_a.md`, `card_summary_b.md`,
  `statement_a.md`, `statement_b.md`, and `panel/` (rendered judge prompt,
  votes, raw runner receipts, `panel_run_report.json`).

Mint a fresh engine short id for `match_id` when creating WORK (8 chars
drawn from the exact alphabet `0123456789abcdefghjkmnpqrstvwxyz`), and keep
it for the artifact:

```bash
python3 -c "import secrets; print(''.join(secrets.choice('0123456789abcdefghjkmnpqrstvwxyz') for _ in range(8)))"
```

(`assemble_match.py` mints one the same way when `--match-id` is omitted,
but WORK is usually named before assembly, so mint up front.)

## Protocol

### Step 1: commit the criteria, on disk, before anything else

The default criteria library holds five entries, aligned with the worth
decomposition used by the belief layer:

- tension resolution: does the idea resolve a standing tension,
  contradiction, or persistent puzzle rather than restate it?
- downstream reach and breadth of applicability: how much becomes possible
  or affected if the idea works?
- mechanism insight: does it explain why something happens, not only that it
  happens?
- testability and timing: can the core claim be probed with means available
  now or soon?
- verification cost: how much work separates the idea from its first decisive
  check?

The caller may add or remove criteria, but only before committing:

```bash
python3 scripts/commit_criteria.py --out WORK/commitment.json
python3 scripts/commit_criteria.py --out WORK/commitment.json \
  --criteria "tension resolution" "verification cost"
```

`commit_criteria.py` canonicalizes the list (Unicode NFC, whitespace
collapse, duplicate and empty rejection, code-point sort), hashes the
canonical JSON with sha256, and writes `{committed_at, criteria,
commitment_hash}`. The hash covers only the criteria list, so the same set
always yields the same hash. The script refuses to overwrite an existing
commitment; new criteria mean a new match.

The commitment file is the integrity anchor of the whole match: statements
must open by declaring this hash, the judge prompt embeds the commitment
verbatim, every vote record is stamped with the hash and a collection
timestamp, and `assemble_match.py` re-verifies all of it and refuses on any
mismatch or on votes collected before `committed_at`. Committing first is
what stops the criteria from drifting toward whichever side reads better
mid-match.

### Step 2: prepare symmetric materials

Card summaries are rendered deterministically (no model in the loop), same
template both sides:

```bash
python3 scripts/run_panel.py --materials-dir WORK \
  --render-card-summaries --card-a cardA.json --card-b cardB.json
```

Advocacy statements are written by two separate host subagents, one per
idea, each blind to the opposing card. Render the two symmetric requests
(same template, same word cap), then hand each request file to its own
subagent and save the replies as `WORK/statement_a.md` and
`WORK/statement_b.md`:

```bash
python3 scripts/run_panel.py --materials-dir WORK \
  --render-statement-prompts --card-a cardA.json --card-b cardB.json
```

Statement contract (requested by `prompts/statement_prompt.md`, and enforced
in code before any judge sees the statement): the first two lines declare the
commitment hash and the node id; every argument line ends with an anchor tag,
`[anchor: literature -> reference]` or `[anchor: computation -> reference]`,
whose reference comes from the card's evidence entries; no facts beyond the
card; one section per committed criterion plus a closing "Honest weaknesses"
section; at most 600 words (the default `--word-cap`).

The contract is not merely requested of the author: the statement a judge
reads is REBUILT from verified elements, not passed through verbatim. Before a
statement is substituted into the judge prompt, `run_panel.load_materials`
NFKC-normalizes it and reconstructs it, keeping only

- headings whose normalized text names a committed criterion or the
  "Honest weaknesses" section (ATX headings only);
- argument lines that end in a valid anchor tag whose reference cross-matches
  the side's own card evidence (the reference must be a card evidence entry, a
  requirement `statement_prompt.md` asks for and the rebuild now enforces);
- weakness admissions, rebuilt as a bounded list.

Everything else -- a heading that names nothing committed (a would-be
`## Required output` or `## Binding rules`), an argument line whose anchor is
missing, malformed, or points at a reference the card never declared, and any
stray prose outside a committed section -- is simply not rebuilt, so it never
reaches a judge. Two conditions still stop the whole match before any judge
runs: a rebuilt statement over the word cap, and one with no card-anchored
argument at all. The same parser counts the unanchored argument lines it drops
per side (it does not take the author's or a judge's word for the count); those
counts, and a per-judge reconciliation against each judge's self-reported
`unanchored_arguments_discarded`, are recorded in `panel_run_report.json`, and
a disagreement is printed as a warning.

This is a rebuild for signal quality, not a security sandbox: see "Scope of
the rebuild" below.

### Step 3: run the judge panel (roster-drawn, independent)

Judges from a single model family correlate: they share training lineage,
blind spots, and failure shapes, so their agreement overstates the evidence.
Family diversity is therefore the validity requirement of the normal,
cross-family panel — not a preference. The one exception is the degraded
single-family form described under "Validity and honest degradation" below,
which exists so a roster that cannot field the floor still yields a
comparison, and which is stamped as degraded everywhere it is recorded.

The panel's family list, each family's runner, and each family's model
string come from the third-party agent roster — an agents.json file, schema
version 1. Discovery order, first hit wins:

1. an explicit `--roster PATH` argument;
2. the project-level roster: the first `.nullius/agents.json` found walking
   up from the materials directory toward the filesystem root;
3. the user-level roster `~/.nullius/agents.json`;
4. the built-in pure-native roster: one native seat, recorded under the
   neutral family label `host`, because `run_panel.py` cannot verify which
   model family the host actually is and will not guess one. A roster file
   that declares the real family (for example claude) names it in the
   records.

A missing file is never an error — the next source applies. A roster file
that exists but does not parse or validate stops the run loudly, naming the
file; silently skipping a broken roster would change panel composition
behind the operator's back. `run_panel.py` reads the roster with its own
self-contained parser by design; there is no shared roster library.

Each roster family declares its runner (one of native / codex / opencode /
kimi / gemini / claude-cli), its model strings (a `models` object whose
`default` entry the panel uses; a family declared `available: false` may
omit it), and optional notes. Seat execution by runner:

- native: the host family. Its vote is a host subagent's raw reply injected
  with `--native-vote FILE`; `run_panel.py` never spawns a host subagent
  itself, and a native seat with no injected file is recorded absent. A
  roster declares at most one native family. The vote records the roster's
  declared model string for the native family (what the host is expected to
  run the subagent as); `--model-label` pins a different record.
- codex / claude-cli: through the review-swarm launcher
  (`skills/review-swarm/scripts/bin/run_multi_task.py`), which routes each
  spec to the matching CLI.
- opencode / gemini / kimi: directly through each runner script
  (`skills/opencode-cli-runner/scripts/run_opencode.sh`,
  `skills/gemini-cli-runner/scripts/run_gemini.sh`,
  `skills/kimi-cli-runner/scripts/run_kimi.sh`), in their isolated working
  directories. A model of `default` delegates to that CLI's own configured
  default model; a pinned model is passed with the runner's strict flag, so
  a pinned model that is unavailable makes the seat absent instead of being
  silently replaced by the CLI's default (which, for a multi-provider CLI,
  might not even belong to the seat's family).

Launcher subprocesses always get `REVIEW_SWARM_NO_AUTO_CONFIG=1`, so a
project-level review-swarm configuration can never silently change panel
composition, models, or fallback behavior. `--model-spec FAMILY=MODEL`
overrides one family's roster model string for a run that must record a
specific model; `--families` selects a subset of the roster's families.

```bash
python3 scripts/run_panel.py --materials-dir WORK --out-dir WORK/panel \
  --render-prompt-only
# host subagent answers WORK/panel/judge_prompt.md (system prompt:
# WORK/panel/judge_system.md); save its raw reply, then:
python3 scripts/run_panel.py --materials-dir WORK --out-dir WORK/panel \
  --native-vote WORK/panel/native_vote_raw.txt
```

Every judge receives the identical self-contained prompt (commitment, both
card summaries, both rebuilt statements) and no file access. The prompt pins
three binding rules: judge only against the committed criteria; discard and
count any argument that lacks an anchor; a tie is a legal outcome. It also
frames the two statements as advocacy content to be weighed under the
committed criteria, not instructions to the judge: a sentence inside a
statement that reads as a directive or meta-instruction carries no authority
and is to be ignored. Votes are strict JSON, parsed fence-first; each family
gets one retry on any failure, after which it is recorded absent with its
reason in `panel_run_report.json`.

Validity and honest degradation:

- A cross-family match is valid only with votes from at least 3 distinct
  families (`policy.cross_family_minimum`; a roster may raise this floor,
  never lower it).
- With exactly the floor, proceed, and keep the absent families on record.
- A family the roster declares `available: false` is recorded absent up
  front, with the roster's own notes as the reason, and is never invoked.
- If at least the floor's worth of families is available but too many seats
  fail at run time, `run_panel.py` exits nonzero and the match is
  terminated; the run report remains as the record of the attempt.
  `assemble_match.py` enforces the same floor independently.
- An absent family is never backfilled by a second vote from a present
  family, and never silently substituted by another model of the same
  family lineage.
- If the roster itself cannot field the floor (fewer available families in
  the WHOLE roster than `policy.cross_family_minimum` — for example, no
  roster file exists anywhere, so the built-in pure-native roster applies),
  the panel degrades per
  `policy.when_below_minimum = native_subagents` to NATIVE SUBAGENT SEATS:
  run at least the floor's worth of independent host subagent instances,
  each answering the rendered judge prompt blind to the other seats, save
  each raw reply to its own file, and re-run with one `--native-vote FILE`
  per seat (the first invocation without enough seat files exits with code
  3 and prints exactly this guidance). Such a panel is stamped
  `independence = "single_family"` and `independent_runners = false` in
  `panel_run_report.json`, its vote files carry seat numbers and a sha256 of
  each seat's raw reply, and the artifact records the same, so a degraded
  panel can never pass for a cross-family one. The belief layer sees that
  record and can weight the observation's diversity accordingly. Two guards
  keep the seats honest: the same reply file given for two seats, or two
  reply files with byte-identical content, stop the run — independent
  subagent seats cannot share one reply. A `--families` subset can never
  force degradation on a roster that could field the floor: such a request
  just runs a cross-family panel that fails the vote floor. The degraded
  seats always belong to the roster's native-runner family (which must be
  available), even when a `--families` subset did not name it; the report
  records the requested list and the native family side by side.
- Distinct family labels are not enough on their own: `run_panel.py` also
  checks that the family seats resolve to genuinely different underlying
  commands. If two or more `--runner` seats point at the same command (a
  single model wearing three labels), a real match is refused. The
  `IDEA_PAIRWISE_ALLOW_STUB_RUNNERS=1` escape hatch exists only for tests and
  single-model dry runs; when it is used, the run report is stamped
  `independent_runners = false`, so a stub-backed panel can never be mistaken
  for an independent cross-family one.

### Step 4: tally the votes and write the artifact

```bash
python3 scripts/assemble_match.py \
  --commitment WORK/commitment.json --votes-dir WORK/panel/votes \
  --materials-dir WORK --campaign-dir CAMPAIGN \
  --campaign-id CAMPAIGN_ID --idea-a NODE_A_ID --idea-b NODE_B_ID \
  --match-id MATCH_ID
```

The winner is the side with more votes; equal counts make the outcome a tie.
`vote_margin` is the absolute vote difference divided by the number of votes
cast (tie votes included in the denominator). Before writing anything,
`assemble_match.py` re-verifies the commitment hash on every vote, the vote
timestamps, and the panel composition against the run report: on a
cross-family panel, family uniqueness and the vote floor (the report's own
`min_families`, never below three); on a degraded single-family panel,
numbered distinct seats of the one native family. Assembly loads exactly the
vote files the report's `votes_collected` map names — a vote file in the
directory that the report does not name (a stale seat from an earlier run,
or a foreign file) stops assembly — and refuses a report whose `panel_valid`
is false. It then validates the assembled artifact field by field and writes
it with `observation_write.written = false`. It also copies the panel
composition record from `panel_run_report.json` next to the votes into the
artifact — `independent_runners`, plus a `panel_independence` block carrying
the mode (`cross_family` or `single_family`), the families that voted, and
the absent families with their reasons — refusing if the report is missing
or incomplete, and refusing a single-family report or artifact that claims
`independent_runners = true`, so a stub-backed, degraded, or thinned panel
is visible in the artifact itself and cannot dress itself up.

`--materials-dir` is required, not optional. Assembly cross-checks both
statements' declared hash and node ids against the commitment and the pair
being assembled, and binds a `statement_binding` block into the artifact: for
each side, the node id and a sha256 over the on-disk statement content. That
content is the sole source from which the judges' rebuilt view is
deterministically derived, so hashing it pins the judge input to an auditable
origin. This makes "the votes correspond to the criteria-bound advocacy
statements" an auditable line in the artifact, not just a check that ran once
and left no trace.

Rematch guard: if the campaign already holds a match for the same unordered
pair, assembly refuses unless `--rationale` states the new evidence that
justifies rerunning; the rationale is recorded in the artifact. A rerun
produces a second, independent artifact for the pair; this skill does not
deduplicate or supersede the earlier one. Reconciling multiple matches for a
pair (which to weigh, how to age the older observation) is the belief layer's
job (skill `idea-posterior`), not this skill's.

### Step 5: feed the outcome to the belief layer

<!-- shared-mapping-table:start -->
Fixed vote-outcome to likelihood-tier mapping, shared verbatim between this
skill and the belief-layer skill (idea-posterior); never edit one copy alone.

- Unanimous win: at least 3 valid votes were cast and the losing idea
  received zero votes. Maps to likelihood tier 10. Individual "tie" votes
  count toward the valid-vote total and are not votes for the losing idea,
  so a win with some tie votes but zero opposing votes is still unanimous.
- Split win: a majority winner exists and the losing idea received at least
  one vote. Maps to likelihood tier 3.
- Tie: equal vote counts for the two ideas. No observation is produced.

Direction is symmetric: one match yields one observation; "the winner's
worth rises" and "the loser's worth falls" are the same observation stated
two ways, absorbed once, never double-counted.

Why the tiers stop at 10: the tiers are Jeffreys-style Bayes-factor grades
(3 / 10 / 30). A single pairwise match is capped at the substantial grade
(10) and never earns the strong grade (30), so that one panel's votes cannot
overwhelm the literature and computation anchors accumulated in the argument
graph. The cap is part of the honesty discipline on evidence weights.
<!-- shared-mapping-table:end -->

The absorption itself belongs to the `idea-posterior` skill (its section on
absorbing pairwise match outcomes): that flow turns the artifact's outcome
into an observation package for the Gaia argument graph, then flips
`observation_write.written` to true and records the package reference in
`observation_write.gaia_package_ref`. This skill only writes the artifact
with `written = false`; if a match artifact still shows `written = false`,
its outcome has not yet influenced any posterior.

## Which pairs to run

The campaign's assignment layer (a selection script or the operating agent)
decides who plays. Defaults when nothing else is specified:

- Eligible: nodes that are neither archived nor parked (not waiting_activation / admission_blocked), with a complete idea card.
- Most informative first: among nodes with a non-empty posterior, pair
  posterior neighbors; adjacent worth means the match carries the most
  information.
- Cold start: a node with no posterior yet plays the node at the posterior
  median.
- No short-window rematches: the rematch guard in Step 4 refuses a repeat of
  an already-matched pair unless a new-evidence rationale is given.

## pairwise_match_v1 artifact

Top-level fields (unknown keys are rejected by the validator):

- `match_id`, `campaign_id`, and the two idea node id fields
  (idea_a_node_id, idea_b_node_id): engine short ids, exactly
  `^[0123456789abcdefghjkmnpqrstvwxyz]{8}$` (the same convention as
  idea_node_v1 ids); the two node ids must differ.
- `criteria_commitment`: exactly `{committed_at, criteria, commitment_hash}`
  as written in Step 1; the validator recomputes the hash.
- `panel`: array with one entry per vote, each
  `{reviewer_family, model, vote, anchored_arguments,
  unanchored_arguments_discarded}` plus, on a single-family panel only, a
  `seat` number. `reviewer_family` is a lowercase family label from the
  agent roster; on a cross-family panel no family appears twice and at least
  3 distinct families vote; on a single-family panel all entries carry the
  one native family and distinct seats, at least 3 of them. `vote` is one of
  `"a"`, `"b"`, `"tie"`; each anchored argument exactly
  `{argument, anchor_type, anchor_ref}` with `anchor_type` literature or
  computation.
- `panel_independence`: exactly `{mode, families_present, families_absent}`,
  copied from `panel_run_report.json` at assembly. `mode` is `cross_family`
  or `single_family`; `families_present` lists the families that voted;
  `families_absent` lists each requested family that did not vote as
  `{family, reason}`. The validator cross-checks this block against the
  panel array.
- `independent_runners`: boolean, read from `panel_run_report.json` at
  assembly. It is `false` when the panel was run under the stub/single-model
  escape hatch or as degraded native subagent seats, so a low-diversity
  panel is visible in the artifact itself and the belief layer can weight
  the observation's diversity from the record.
- `outcome`: exactly `{winner, vote_margin, decided_at}`; the validator
  recomputes winner and margin from the panel and rejects disagreement.
- `observation_write`: `{written}` plus optional `gaia_package_ref`.
- `rationale` (optional): the new-evidence reason recorded for a rematch.

Example:

```json
{
  "match_id": "4c9a2d10",
  "campaign_id": "3b8e1f70",
  "idea_a_node_id": "1f6c9d5e",
  "idea_b_node_id": "2a7d0e6f",
  "criteria_commitment": {
    "committed_at": "2026-07-05T08:00:00+00:00",
    "criteria": [
      "downstream reach and breadth of applicability",
      "mechanism insight",
      "tension resolution",
      "testability and timing",
      "verification cost"
    ],
    "commitment_hash": "sha256:a1e10a3bbabf4338396bbbc361aa9accc504f03221f2b12998b707772854fcd4"
  },
  "panel": [
    {
      "reviewer_family": "claude",
      "model": "claude/host-subagent",
      "vote": "a",
      "anchored_arguments": [
        {
          "argument": "the pilot computation bounds the verification effort",
          "anchor_type": "computation",
          "anchor_ref": "artifact://campaign/toy/computations/pilot.json"
        }
      ],
      "unanchored_arguments_discarded": 0
    }
  ],
  "panel_independence": {
    "mode": "cross_family",
    "families_present": ["claude", "glm", "gpt"],
    "families_absent": [
      {"family": "kimi", "reason": "runner exit code 1; runner exit code 1"}
    ]
  },
  "independent_runners": true,
  "outcome": {
    "winner": "a",
    "vote_margin": 0.25,
    "decided_at": "2026-07-05T09:00:00+00:00"
  },
  "observation_write": {
    "written": false
  }
}
```

(The example shows one panel entry for brevity; a real valid artifact holds
at least three — from three distinct families in cross-family mode, or three
numbered seats of the one native family in single-family mode. An artifact
assembled with the required `--materials-dir` also carries a top-level
`statement_binding` block — per-side node id and a sha256 of the statement
content — omitted here for brevity.)

The authoritative check on an assembled match is `validate_pairwise_match` in
`scripts/assemble_match.py`: a standalone, field-by-field check that a match
can be verified against without any package installed. It is the binding
judge of panel validity, including the composition rules a JSON Schema cannot
express directly: a cross-family panel holds at least three DISTINCT
families and no seat numbers; a single-family panel holds at least three
numbered, distinct seats of its one native family and never claims
`independent_runners = true`; and the `panel_independence` block must agree
with the panel array. A machine-readable `pairwise_match_v1` JSON Schema also
lives with the campaign engine's contracts for downstream consumers; because
a schema cannot require distinctness, its `panel` array must set
`minItems: 3` (not 1) and its description must defer to
`validate_pairwise_match` as the authoritative composition check, so a
schema-only consumer cannot accept a sub-three-vote artifact that the Python
validator would reject.

## Scripts

All three are standard-library-only Python (3.9 or newer):

- `scripts/commit_criteria.py`: canonicalize, hash, and write the criteria
  commitment. Refuses overwrites.
- `scripts/run_panel.py`: verify materials and rebuild each statement from
  verified elements before any judge runs, render the judge prompt from the
  rebuilt statements, resolve the agent roster, run the roster's family seats
  (with the rendering modes shown above) or the degraded native subagent
  seats, collect and validate votes, write `panel_run_report.json`.
  `--runner FAMILY=COMMAND` replaces a
  family's runner with a command template (`{prompt}` and `{system}` expand to
  the rendered prompt paths; stdout is taken as the judge's raw reply); this
  hook exists for tests and custom runners, and a real match must use the real
  families. Pointing several seats at the same command is refused unless
  `IDEA_PAIRWISE_ALLOW_STUB_RUNNERS=1` is set, which stamps the run report
  `independent_runners = false`.
- `scripts/assemble_match.py`: re-verify the integrity thread, tally, map
  the outcome to the observation tier, validate, and write the artifact.
  Requires `--materials-dir` and binds a per-side statement digest into the
  artifact; copies the panel composition record from the run report.

## Tests

```bash
python3 -m pytest skills/idea-pairwise-match/tests/
```

The tests cover hash stability, stage-order enforcement (sentinel proof that
no runner executes when materials fail verification), tally and mapping
edges, artifact validation field by field, the rematch guard, and a mocked
end-to-end panel. The agent-roster cases (inline fixtures, no template
dependency) pin roster parsing and validation, the discovery order with the
missing-file pure-native default and the loud error on a broken file, the
floor-met regression path, the below-floor degradation to native subagent
seats with its guidance exit and single-family record, and absence recording
for roster-declared unavailable families. The rebuild cases pin what a judge does and does not see: a
forged judge-prompt heading, an injection tucked into the weaknesses section, a
non-ATX/HTML/homoglyph pseudo-heading, and an argument line whose anchor points
at a reference the card never declared are each dropped from the rebuilt
statement (the panel still runs on the genuine anchored content, and the
injection string is asserted absent from the judge prompt); a statement that
rebuilds to zero card-anchored arguments, or over the word cap, stops the match
before any judge runs; an unanchored flood is counted by the parser and flagged
against the judges' self-reports; a shared `--runner` command is refused
without the escape hatch, and the resulting `independent_runners = false` flag
is carried into the artifact; a claimless idea card is rejected on both the
summary and statement paths; and a symmetry test checks that content-identical
statements rebuild to a symmetric judge prompt. Mocked judges appear only in
tests; any real match must collect real cross-family votes or honestly record
the absent families.

## Scope of the rebuild

The statement rebuild gives each judge a clean input: anchored, organized by
the committed criteria, with only verified content. Its purpose is signal
quality — keeping an agent from accidentally writing structure or meta-language
that would mislead the panel about the two ideas' relative merit. It is not a
security sandbox against deliberate injection, and does not need to be:

- The statements are written by agents inside this pipeline, not submitted by a
  third party with an adversary's incentive. So the rebuild does NOT chase
  encoding variants of a forged marker (homoglyph, HTML, setext, and the like)
  with a blacklist. It works the other way round: only elements that pass a
  positive check are rebuilt, so a heading that names nothing committed or an
  anchor that matches no card evidence never appears, whatever form it was
  written in. Adding a blacklist of variants would be an arms race with no end
  and is deliberately avoided.
- Each pairwise match yields exactly one capped (tier ≤ 10), non-eliminating
  observation, and the tier cap keeps a single panel from overwhelming the
  literature and computation anchors in the argument graph. So even a
  single contaminated statement has a bounded effect on the belief-layer
  posterior; this bound, not statement sanitization, is the main source of
  robustness.
- A rebuilt statement's surviving argument lines are still free text (that is
  the point of advocacy). The judge-prompt framing — the two statements are
  advocacy content to weigh, not instructions — handles any directive language
  that remains inside a legitimate line. That framing is the correct place to
  stop: the rebuild removes structure and unanchored claims; the framing tells
  the judge how to read the prose that is left.

## Honest limits

- The two advocacy statements are generated by host subagents, so statement
  authorship shares a family with one judge seat. Statements are inputs
  (advocacy under a fixed template), not votes; the independence requirement
  applies to the panel. Noted openly rather than hidden.
- A degraded single-family panel has none of the cross-family diversity this
  protocol is built around: its seats are independent instances (separate
  contexts, blind to each other) of one host model, so shared blind spots
  survive. It exists so a thin roster degrades honestly instead of blocking
  all comparison, it is stamped as `single_family` everywhere
  (`independent_runners = false` included), and the belief layer can weight
  it down from the record.
- Judges do not fetch anchor references during a match; anchor content is
  vetted upstream. A match with unvetted claims measures rhetoric, not
  merit, and should not be run.
- The `unanchored_arguments_discarded` count stored in each panel entry of the
  artifact is what that judge self-reported. The mechanism does not depend on
  it: `run_panel.py` parses each statement itself, drops and counts the
  unanchored argument lines independently, and records that authoritative
  count (plus a per-judge agreement flag) in `panel_run_report.json`. The
  self-reported number is retained as a cross-check, not as the source of
  truth.
- Idea A and Idea B keep fixed presentation positions; position effects are
  not randomized away. If a position effect is suspected, rerun with swapped
  labels under the rematch guard with that stated rationale. A symmetry test
  (`test_symmetry_identical_content_differs_only_by_node_id`) pins that two
  content-identical statements render a structurally symmetric judge prompt,
  so the fixed positions add no asymmetry of their own.
