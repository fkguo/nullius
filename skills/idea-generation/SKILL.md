---
name: idea-generation
description: "Generate derived (non-seed) idea nodes for an idea campaign from research-progress evidence deltas — V0 operator: LiteratureMining over a deep literature survey's tensions and re-anchored gaps (FailureRouting when a failed-approach ledger exists) — and import them through the engine's node.import_generated RPC as an auditable generation pack. Retrieval-first by construction (no retrieval receipt, no evidence URI), one candidate per structurally distinct anchor, mechanical dedup against every campaign node, novelty stated as a falsifiable closest-prior delta claim (never an LLM novelty score), zero generator-side scoring: nodes are born with posterior null and face the same idea-posterior admission gate as seeds. Use when a new or updated literature survey lands, when failed-approach entries accumulate, or when the operator deliberately runs a manual generation burst on a campaign."
---

# Idea Generation (evidence-born, pack-imported)

Generate candidate idea nodes FROM recorded evidence and import them into a
campaign as one auditable burst. This skill owns the Explain stage only: it
authors rationale drafts, card fields, anchors, receipts, dedup records, and
novelty-delta claims, assembles them into a `generation_pack_v1`, and submits
the pack to the engine. The engine owns the Formalize stage (deterministic
idea-card assembly + the formalization trace) and every store write.

## Scope and boundaries

- **No scoring, ever.** Scoring authority is the belief layer (`idea-posterior`
  admission gate → argument graph → `node.set_posterior`). Generated nodes are
  born with `posterior: null` and `grounding_audit: null`; this skill never
  writes either, never ranks its own output, and never emits an LLM novelty
  score anywhere (LLM judgments of idea novelty run at or below chance and are
  non-diagnostic; novelty is handled as an auditable claim instead, below).
- **Retrieval-first grounding.** An evidence URI may enter a candidate ONLY
  from a retrieval the generator actually performed or an artifact it actually
  read, recorded as a receipt (`trace_inputs.retrieval_receipts`: `{uri,
  source}`). No receipt, no URI — the engine refuses. Model memory is never a
  source; the seed placeholder URI is banned outright.
- **Opt-in, event-driven, no daemon.** A burst runs when the operating agent
  or the maintainer invokes it on a named trigger (below) — never on a timer,
  never auto-invoked, no MCP surface.
- **Domain-agnostic.** Anchors, prompts, and examples carry no field-specific
  nouns; domain content arrives only through the evidence artifacts of the
  external research project.
- The engine RPC (`node.import_generated`, contract
  `generation_pack_v1.schema.json` in the idea-engine contracts directory) is
  the sole import path and the enforcement authority; this skill's client-side
  checks only fail fast.

## Triggers — when a burst is justified

Every pack names the evidence delta that justified it (`trigger.kind` +
`artifact_ref`). One burst per delta; no new delta, no new burst. More
sampling on unchanged inputs yields duplicates, not ideas (duplicate-collapse
evidence is unambiguous), so a burst is bounded (default ≤ 8 candidates,
≤ 2 candidates per anchor) and runs at most one revision round on its
evidence snapshot.

| kind | delta | V0 status |
| --- | --- | --- |
| `survey_updated` | a new or updated `literature_survey_v1` (new tensions/gaps) | enabled |
| `failure_recorded` | new `failed_approach_v1` ledger entries | enabled |
| `manual` | maintainer-initiated burst (state the reason in the pack) | enabled |
| `computation_gated` | a gate-passed trial/reconnaissance computation | reserved |
| `match_concluded` | a pairwise tournament outcome | reserved (until the tournament seam is exercised on a real campaign) |
| `activation_satisfied` | a waiting idea's condition became true | reserved |
| `milestone_reached` | a research-team milestone artifact | reserved |
| `posterior_moved` | a significant posterior change on an existing node | reserved |

Reserved kinds are schema-legal vocabulary the engine rejects at import
(`trigger_not_enabled`) — recorded now so enabling one later is a policy
change, not a redesign.

## The V0 operator family: LiteratureMining

One candidate per structurally distinct anchor in the survey — this is where
diversity comes from (input-side construction), not from sampling temperature
and not from model ensembles.

**Tension anchors (preferred).** Each entry of the survey's
`synthesis.tensions[]` carries a statement plus integrity-checked `ref_keys`.
A tension-born candidate records `trace_inputs.anchor = {kind: "tension",
statement, ref_keys}` and cites the tension's underlying sources (via the
survey's papers and notes) with receipts. Such a candidate arrives at the
admission gate pre-anchored for its strongest route (resolving an anchored
open tension).

**Gap anchors (re-anchoring required).** `synthesis.gaps[]` entries are bare
strings with no references. A gap-born candidate must first RESOLVE the gap
to at least one real reference (a retrieval that establishes the gap's
subject matter and its openness), recorded as `anchor = {kind: "gap",
statement, resolved_refs}` with a receipt per ref. No resolved references, no
gap idea — the engine refuses (`gap_unanchored`).

**Prompt contract** (what a LiteratureMining candidate MUST contain; the
import validator enforces the checkable parts):

- Required outputs: a faithful `rationale_draft` — title, the idea stated
  plainly (no pre-narrowing; admission and decomposition belong to the
  evaluation skills), real `risks[]`, real `kill_criteria[]`, `mechanism`
  where the idea proposes one (any `references[]` you list are evidence URIs
  and need receipts like everything else); `card_fields` whose FIRST
  `minimal_compute_plan` step is a bounded, decisive check; claims typed
  under the card evidence discipline (evidence-typed claims carry receipted
  URIs; the idea's NEW part — the resolution mechanism, the delta — is
  exactly its unanchored part and must be typed `llm_inference` or
  `assumption` WITH a `verification_plan`); and honest `provenance`:
  `origin` records the REAL generator model id, the real sampling
  temperature, a sha256 over the real rendered prompt (`prompt_hash`), the
  generation timestamp, and role `Generator` — never backend labels or
  invented values. Save the full rendered prompt to a file and pass it as
  `--prompt-snapshot` at pack build time: it is archived inside the pack and
  the engine verifies `prompt_snapshot_hash` against it, which is what makes
  "a third party can reconstruct exactly what the generator saw" checkable.
  The engine restates your `novelty_delta.falsifiable_delta_statement` as an
  `llm_inference` claim on the card automatically (deterministic Formalize),
  and copies `novelty_delta`, the dedup record, and `target_admission_route`
  onto the node's trace — do not put them in `trace_inputs` yourself (those
  keys are engine-owned).
- Mandatory validations (before the pack is built): every URI has a receipt;
  the anchor is real (read the survey entry, do not paraphrase one into
  existence); a freshness retrieval checked whether literature AFTER the
  survey snapshot already resolved the tension/gap (a hit demotes the
  candidate to `rejected_candidates` with reason).
- Common misjudgments (reject your own candidate when you see them): wording
  disagreements dressed as tensions (a tension is an evidence-level
  contradiction); "gap" claims that are actually just unread literature;
  proposals whose only delta is a parameter tweak or rewording (declared
  non-novel by construction — `delta_type` values `parameter_tweak` and
  `rewording` are import-rejected); plans whose first step is unbounded.

**FailureRouting (enabled when ledger data exists).** Mines
`failed_approach_v1` entries (prefer `reuse_potential: high`) or an archived
node's kill criteria, and proposes a route AROUND the recorded failure with a
positive thesis of its own. A parentless candidate records
`trace_inputs.failed_approach_refs`; a candidate rerouting an archived node
records that node as its single parent. "Not the failed thing" is not a
thesis — the candidate must state the new mechanism/method and the first
check that would falsify the workaround.

Other committed families (`Mutation`, `Recombination`, `AnalogyTransfer`)
are contract-ready (arity table in the engine) but deliberately later-phase —
and the ENGINE enforces that, exactly as it does for reserved trigger kinds:
importing them today is refused with `operator_family_not_enabled` until each
family's evidence discipline lands in the import validator. Prose is not a
gate. LiteratureMining packs must also pin the mined survey in
`evidence_snapshot` (`survey_artifact_ref` + `survey_content_hash`;
`build_pack.py --survey-artifact-ref/--survey-file` does this).

## Novelty as an auditable claim (never a score)

Every candidate carries `novelty_delta`: the closest prior work found BY
RETRIEVAL (`closest_prior` — URI or survey ref_key), an `overlap_summary`, a
`delta_type`, and a `falsifiable_delta_statement` (what is different and what
observation would kill that difference). Parametric-memory novelty checks and
LLM novelty scores are forbidden — mechanical retrieval + the admission
reviewers audit novelty the way they audit any other claim. Restate the delta
inside the card as an `llm_inference` claim so `claim-grounding` and the gate
see it.

## Procedure

1. **Name the trigger.** Identify the evidence delta and its artifact. No
   delta, no burst.
2. **Enumerate anchors.** From the survey: unresolved tensions first, then
   gaps you can re-anchor. From the ledger: high-reuse failures. Respect the
   per-anchor quota (≤ 2) and the burst bound (≤ 8).
3. **Author candidates** per the prompt contract, collecting a receipt for
   every retrieval as you go. Run the freshness check per candidate.
4. **Dedup mechanically** against the campaign store:

   ```bash
   python3 skills/idea-generation/scripts/dedup_check.py \
     --nodes <store_root>/campaigns/<campaign_id>/nodes_latest.json \
     --candidates candidates.json --out dedup_report.json
   ```

   Hashed character-3-gram cosine (with an exact normalized-text
   short-circuit) against every node (active, waiting, archived) AND against
   the burst's own earlier candidates — same-anchor twins are the most likely
   duplicates and a store-only comparison cannot see them: ≥ 0.95 auto-drop,
   ≥ 0.80 flagged. Flagged candidates import only with an explicit human
   `--override INDEX=REASON`; the mechanical record (method, nearest
   neighbor — a store node id or an intra-burst candidate index —
   similarity) travels in the pack either way. The engine additionally
   refuses exact intra-pack twins and self-contradictory records
   (decision=unique at ≥ 0.95). This is a near-duplicate filter, not a
   novelty proof.
5. **Build the pack** (folds dedup in, moves drops/unoverridden flags to
   `rejected_candidates` with reasons, validates fail-fast):

   ```bash
   python3 skills/idea-generation/scripts/build_pack.py \
     --campaign-id <campaign_id> --candidates candidates.json \
     --dedup-report dedup_report.json \
     --trigger-kind survey_updated --trigger-artifact-ref <survey_ref> \
     --survey-artifact-ref <survey_ref> --survey-file <survey_file> \
     --prompt-snapshot rendered_prompt.txt \
     --out pack.json
   ```

   The pack records what was dropped and why — a burst cannot silently
   discard work.
6. **Submit** through the engine bridge (idempotent; safe to retry):

   ```bash
   python3 skills/idea-generation/scripts/submit_pack.py \
     --pack pack.json --campaign-id <campaign_id> \
     --store-root <store_root> \
     --idea-rpc <repo>/packages/idea-engine/bin/idea-rpc.mjs
   ```

   The engine validates everything again (it is the authority), mints ids,
   assembles cards, archives the pack verbatim as a campaign artifact, and
   enforces the campaign's `max_nodes` budget batch-atomically.
7. **Hand off to evaluation.** Imported nodes enter `idea-posterior`'s
   admission gate like any seed (their `target_admission_route` is a triage
   hint, not authority). Nodes that fail admission are archived with their
   gate record — and become FailureRouting inputs later. Allocation's
   reconnaissance slots are where an admitted node's bounded first check
   gets scheduled.

## Interfaces to the sibling machinery

- `deep-literature-review` produces the `literature_survey_v1` this skill
  mines; run it first when the survey is thin.
- `claim-grounding` verifies the candidate claims downstream — generation
  receipts make its job checkable, not redundant.
- `idea-posterior` / `idea-pairwise-match` / `idea-allocation` are unchanged
  consumers: belief, relative merit, and investment stay theirs.
- The engine contract documents every import-rejection reason
  (`node.import_generated` in the OpenRPC file); this skill's `build_pack.py`
  mirrors those checks only to fail fast locally.

## Tests

```bash
python3 -m pytest skills/idea-generation/tests/
```

Covers dedup determinism and thresholds, pack assembly (drops, flags,
overrides, rejected-candidate folding), each fail-fast validation rule, the
pinned submit request shape against a mock engine bridge, and anti-drift
locks that read the ENGINE contract at test time (trigger vocabulary, delta
types, admission routes, the id pattern, the placeholder URI) so a contract
change cannot silently diverge from this skill's mirrors.

## Honest limits

- The dedup vector is a mechanical character-n-gram filter: strong on
  near-verbatim and light paraphrase, weak on deep semantic duplicates —
  recorded as `method` in every record so a better embedding backend can
  supersede it visibly. It is a filter, never evidence of novelty.
- The freshness check and anchor reading are agent judgment guided by this
  discipline; the engine can verify receipts exist, not that the reading was
  careful. Admission review audits the anchors themselves.
- A burst on a fixed snapshot saturates fast; the bound (≤ 8, ≤ 2 per anchor,
  one revision round) is deliberately small. Generation earns more rounds by
  the research producing new evidence, not by re-sampling.
