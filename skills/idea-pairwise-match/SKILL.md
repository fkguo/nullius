---
name: idea-pairwise-match
description: Judged pairwise comparison between two research ideas in a campaign. Commit the comparison criteria to disk first (sha256 over the canonicalized list), generate symmetric anchored advocacy statements, collect independent votes from a cross-family judge panel (claude / codex / opencode / kimi, at least three families for a valid match), and write a pairwise_match_v1 artifact whose outcome enters the belief layer as one observation. Arguments without a literature or computation anchor are discarded and counted, never weighed. Use when a campaign needs a relative-merit signal between two idea nodes beyond their individual posteriors, when choosing which of two competing ideas to advance, or when a newly admitted idea needs a calibrated first comparison.
---

# Idea Pairwise Match (criteria-committed, cross-family judged)

Compare exactly two idea nodes of a campaign under criteria that were
committed to disk before any advocacy was drafted and before any judge ran,
with a judge panel drawn from different model families, and record the result
as a `pairwise_match_v1` artifact. The outcome is an observation for the
belief layer, never an elimination: the loser keeps living in the campaign
with a lowered worth, and can win a later match when new evidence arrives.

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

- `node_id`: lowercase dashed uuid.
- `title`, `gist`, `status`: short descriptive strings; the node should be
  active.
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

Mint a fresh uuid for `match_id` when creating WORK, and keep it for the
artifact.

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

The contract is not merely requested of the author: before a statement is
substituted into the judge prompt, `run_panel.load_materials` calls
`verify_statement_contract` on both statements and refuses the match, before
any judge runs, if a statement (a) carries a heading that forges one of the
judge prompt's own section markers (for example a fake `## Required output`,
`## Binding rules`, or `### Advocacy statement for Idea B` section that could
hijack the judge's output), (b) exceeds the word cap, or (c) holds no
anchored argument line at all. Rejection is the default: a statement that is
not demonstrably compliant does not reach a judge. The same parser
independently counts the unanchored argument lines it drops per side (it does
not take the author's or a judge's word for the count); those counts, and a
per-judge reconciliation against each judge's self-reported
`unanchored_arguments_discarded`, are recorded in `panel_run_report.json`,
and a disagreement is printed as a warning.

### Step 3: run the judge panel (cross-family, independent)

Judges from a single model family correlate: they share training lineage,
blind spots, and failure shapes, so their agreement overstates the evidence.
Family diversity is therefore a validity requirement of this protocol, not a
preference. The four seats, and how each one runs:

- claude: preferred as a host subagent; its raw reply is injected with
  `--claude-vote FILE`. The claude CLI through the launcher is the fallback.
- codex: through the review-swarm launcher
  (`skills/review-swarm/scripts/bin/run_multi_task.py`).
- opencode: through the review-swarm launcher.
- kimi: directly through `skills/kimi-cli-runner/scripts/run_kimi.sh`, in its
  isolated working directory; the launcher has no kimi runner today.

Launcher subprocesses always get `REVIEW_SWARM_NO_AUTO_CONFIG=1`, so a
project-level review-swarm configuration can never silently change panel
composition, models, or fallback behavior. Model specs default to each CLI's
own configured default; pin one explicitly with, for example,
`--model-spec opencode=some-provider/some-model` when the run must record a
specific model.

```bash
python3 scripts/run_panel.py --materials-dir WORK --out-dir WORK/panel \
  --render-prompt-only
# host subagent answers WORK/panel/judge_prompt.md (system prompt:
# WORK/panel/judge_system.md); save its raw reply, then:
python3 scripts/run_panel.py --materials-dir WORK --out-dir WORK/panel \
  --claude-vote WORK/panel/claude_vote_raw.txt
```

Every judge receives the identical self-contained prompt (commitment, both
card summaries, both statements) and no file access. The prompt pins three
binding rules: judge only against the committed criteria; discard and count
any argument that lacks an anchor; a tie is a legal outcome. Votes are
strict JSON, parsed fence-first; each family gets one retry on any failure,
after which it is recorded absent with its reason in
`panel_run_report.json`.

Validity and honest degradation:

- A match is valid only with votes from at least 3 distinct families.
- With exactly 3, proceed, and keep the absent family on record.
- Below 3, `run_panel.py` exits nonzero and the match is terminated; the run
  report remains as the record of the attempt. `assemble_match.py` enforces
  the same floor independently.
- An absent family is never backfilled by a second vote from a present
  family, and never silently substituted by another model of the same
  family lineage.
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
  --campaign-id CAMPAIGN_UUID --idea-a NODE_A_UUID --idea-b NODE_B_UUID \
  --match-id MATCH_UUID
```

The winner is the side with more votes; equal counts make the outcome a tie.
`vote_margin` is the absolute vote difference divided by the number of votes
cast (tie votes included in the denominator). Before writing anything,
`assemble_match.py` re-verifies the commitment hash on every vote, the vote
timestamps, family uniqueness, and the three-family floor; it then validates
the assembled artifact field by field and writes it with
`observation_write.written = false`.

`--materials-dir` is required, not optional. Assembly cross-checks both
statements' declared hash and node ids against the commitment and the pair
being assembled, and binds a `statement_binding` block into the artifact: for
each side, the node id and a sha256 over the exact statement content the
judges saw. This makes "the votes correspond to the criteria-bound advocacy
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

- Eligible: active nodes with a complete idea card.
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
  (idea_a_node_id, idea_b_node_id): lowercase dashed uuids; the two node ids
  must differ.
- `criteria_commitment`: exactly `{committed_at, criteria, commitment_hash}`
  as written in Step 1; the validator recomputes the hash.
- `panel`: array with one entry per voting family, each exactly
  `{reviewer_family, model, vote, anchored_arguments,
  unanchored_arguments_discarded}`; `reviewer_family` one of claude, codex,
  opencode, kimi, no family twice, at least 3 families for a valid match;
  `vote` one of `"a"`, `"b"`, `"tie"`; each anchored argument exactly
  `{argument, anchor_type, anchor_ref}` with `anchor_type` literature or
  computation.
- `outcome`: exactly `{winner, vote_margin, decided_at}`; the validator
  recomputes winner and margin from the panel and rejects disagreement.
- `observation_write`: `{written}` plus optional `gaia_package_ref`.
- `rationale` (optional): the new-evidence reason recorded for a rematch.

Example:

```json
{
  "match_id": "4c9a2d10-7e5f-4b8a-9c3d-6e1f2a3b4c5d",
  "campaign_id": "3b8e1f70-6c4d-4e0f-9a5b-1c2d3e4f5a6b",
  "idea_a_node_id": "1f6c9d5e-4a2b-4c8d-9e3f-7a1b2c3d4e5f",
  "idea_b_node_id": "2a7d0e6f-5b3c-4d9e-8f4a-0b1c2d3e4f5a",
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
at least three, from three distinct families. An artifact assembled with the
required `--materials-dir` also carries a top-level `statement_binding` block
— per-side node id and a sha256 of the statement content — omitted here for
brevity.)

The authoritative check on an assembled match is `validate_pairwise_match` in
`scripts/assemble_match.py`: a standalone, field-by-field check that a match
can be verified against without any package installed. It is the binding
judge of panel validity, including the rule that the panel holds at least
three DISTINCT families — a constraint a JSON Schema cannot express directly.
A machine-readable `pairwise_match_v1` JSON Schema also lives with the
campaign engine's contracts for downstream consumers; because a schema cannot
require distinct families, its `panel` array must set `minItems: 3` (not 1)
and its description must defer to `validate_pairwise_match` as the
authoritative family-diversity check, so a schema-only consumer cannot accept
a sub-three-family artifact that the Python validator would reject.

## Scripts

All three are standard-library-only Python (3.9 or newer):

- `scripts/commit_criteria.py`: canonicalize, hash, and write the criteria
  commitment. Refuses overwrites.
- `scripts/run_panel.py`: verify materials (including the statement contract,
  enforced before any judge runs), render the judge prompt, run the four
  family seats (with the rendering modes shown above), collect and validate
  votes, write `panel_run_report.json`. `--runner FAMILY=COMMAND` replaces a
  family's runner with a command template (`{prompt}` and `{system}` expand to
  the rendered prompt paths; stdout is taken as the judge's raw reply); this
  hook exists for tests and custom runners, and a real match must use the real
  families. Pointing several seats at the same command is refused unless
  `IDEA_PAIRWISE_ALLOW_STUB_RUNNERS=1` is set, which stamps the run report
  `independent_runners = false`.
- `scripts/assemble_match.py`: re-verify the integrity thread, tally, map
  the outcome to the observation tier, validate, and write the artifact.
  Requires `--materials-dir` and binds a per-side statement digest into the
  artifact.

## Tests

```bash
python3 -m pytest skills/idea-pairwise-match/tests/
```

The tests cover hash stability, stage-order enforcement (sentinel proof that
no runner executes when materials fail verification), tally and mapping
edges, artifact validation field by field, the rematch guard, and a mocked
end-to-end panel. The adversarial cases pin the statement-contract wall:
a forged judge-prompt heading, a zero-anchor statement, and an over-length
statement each stop the match before any judge runs; an unanchored flood is
counted by the parser and flagged against the judges' self-reports; a shared
`--runner` command is refused without the escape hatch; a claimless idea card
is rejected on both the summary and statement paths; and a symmetry test
checks that content-identical statements render a symmetric judge prompt.
Mocked judges appear only in tests; any real match must collect real
cross-family votes or honestly record the absent families.

## Honest limits

- The two advocacy statements are generated by host subagents, so statement
  authorship shares a family with one judge seat. Statements are inputs
  (advocacy under a fixed template), not votes; the independence requirement
  applies to the panel. Noted openly rather than hidden.
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
