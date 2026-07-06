# Idea Generation Operator — Design

Status: DESIGN (approved evaluation pipeline exists; generation is the missing half).
Scope: `packages/idea-engine` + a new `skills/idea-generation` skill. Opt-in lane —
not a default capability-expansion surface, not a front door, no daemon.

This document specifies how derived (non-seed) idea nodes enter an idea campaign:
which generation strategies are adopted (judged by a four-seat panel including one
cross-model seat), how the operator wires into the existing store / RPC / evaluation
skills, what provenance every generated node must carry, and the smallest first
slice that produces real admitted ideas end to end.

## 1. Constraints (non-negotiable)

1. **Scoring authority is the existing belief posterior, reused end to end.** The
   generation side emits candidates + evidence anchors + provenance only. Generated
   nodes enter with `posterior: null` and pass the same `idea-posterior` admission
   gate → five sub-criteria belief graph → `node.set_posterior` writeback as seeds
   do. No generator-side scores of any kind — the archived runtime was retired
   precisely because deterministic pseudo-scores "made unsupported ideas look more
   precisely evaluated than the evidence allowed" (commit `0bc6b7a0`), and the
   surveyed external evidence says LLM judgments of idea novelty are at or below
   chance (balanced accuracy 43.3–53.3 vs human–human 56.1, arXiv:2409.04109 §7.2,
   2024-era models) and may anti-correlate with real downstream impact.
   Temporal honesty: model capability moves fast and the headline number is
   2024-era. The posture does not rest on that number alone: (a) the 2025
   pre-registered execution RCT (arXiv:2506.20803) found idea-stage scores —
   humans' included — carry ≈no predictive validity for execution outcomes, which
   bounds what ANY judge can extract at the idea stage; (b) human–human agreement
   on idea novelty is itself weak (56.1; κ≈0.45), a low ceiling for the construct;
   (c) 2026-era results (flagged preprints, incl. current-generation judges) still
   show systematic upward novelty bias. Revisit condition: if a validated
   benchmark shows idea-novelty judging reliably above human–human agreement AND
   positively correlated with realized downstream impact, the place to absorb it
   is the pairwise panel's evidence-tier policy (a capped-weight knob), not a
   generator-side score — the architecture does not change.
2. **Retrieval-first grounding by construction.** An evidence URI may enter a
   generated node only from a resolved retrieval receipt already in hand (a survey
   artifact, a deep-read note, a provider fetch recorded in the trace) — never from
   model memory. The peer-reviewed anchors: closed-book models fabricate 18–55% of
   citations with a further large fraction of the real ones substantively wrong
   (Sci Rep 10.1038/s41598-023-41032-5), and fabrication peaks exactly on niche
   topics where novel ideas live (6% mainstream vs 28–29% niche,
   JMIR 10.2196/80371). Directional corroboration from flagged 2026 preprints
   (re-verify before further reliance): an audit of five autonomous research
   systems found the only zero-fabrication bibliographies were those forcing every
   citation through cached retrieval before writing, while free-generating systems
   fabricated up to ~21% (arXiv:2605.26340), and LLM self-validation of citations
   ran below chance (arXiv:2602.06718). Citation validation therefore reuses the
   two in-repo skills, never LLM attestation: `claim-grounding` (span-level
   content-support verdicts — does the cited source actually substantiate the
   claim) and `citation-triangulation` (cross-index metadata agreement — does the
   cited work exist as described; catches wrong-version/spliced/hallucinated
   entries). Existence/identity checks route through citation-triangulation;
   content-support checks route through claim-grounding.
3. **Diversity is engineered on the input side.** One candidate per structurally
   distinct anchor (a specific tension, a specific parent pair, a specific recorded
   failure), per-anchor quotas, embedding dedup. Not by repeated sampling (4 000
   samples → ~200 unique ideas, arXiv:2409.04109) and not by model ensembles (a
   7-vendor ensemble is statistically indistinguishable from a single family,
   p = 0.41, arXiv:2501.19361). Cross-family diversity remains the tool for
   JUDGING, not for generating.
4. **Per-burst saturation bound; event-driven across time.** One generation burst
   runs on a fixed evidence snapshot and is bounded (external evidence: iterative
   expansion on unchanged inputs stalls within ~3 rounds, arXiv:2410.14255).
   Campaign-lifetime generation is unbounded but every burst must name the NEW
   evidence delta that justifies it (trigger vocabulary, §6.4) — the portfolio
   stays coupled to live research instead of becoming an ideation island.
5. **Quality over volume.** Every candidate faces the same admission gate; the
   campaign `max_nodes` budget applies to imported nodes; a burst's rejected
   candidates are recorded with reasons, not silently dropped.
6. **Domain-agnostic.** The operator ships in the reusable skills toolchain with
   zero project-specific nouns. Domain knowledge arrives only through the evidence
   artifacts of the external research project.
7. **Faithful presentation.** The generator states each idea plainly in its
   `rationale_draft` (the Explain stage); admission and decomposition belong to the
   evaluation skills. Formalization into the `idea_card` is deterministic and
   engine-side (§6.2).

## 2. Current state (source-verified)

- The only node-creating path is `campaign.init` seed import
  (`src/service/seed-node.ts`; `operator_family: 'Seed'`, `operator_id:
  'seed.import'`, `parent_node_ids: []`). The RPC surface has no derived-node
  entry point.
- The node contract (`idea_node_v1.schema.json`) already carries the derivation
  hooks unfilled: `parent_node_ids`, free-string `operator_family` (no enum — new
  families need no schema change), immutable `origin` {model, temperature,
  prompt_hash, timestamp, role} and `operator_trace` {inputs, params,
  evidence_uris_used, random_seed?, prompt_snapshot_hash?}, plus a required
  `rationale_draft` that already includes `mechanism`, `analogy_mapping[]`
  {source, target, mapping} and `references[]`.
- `node.promote` enforces an explain-then-formalize trace:
  `operator_trace.params.formalization.mode ==
  'explain_then_formalize_deterministic_v1'`, `source_artifact == 'rationale_draft'`
  and `rationale_hash == sha256(sanitize(title)|sanitize(rationale))` computed over
  the ENGINE's own text sanitization (`node-shared.ts`). Any node built outside the
  engine would have to replicate that sanitization byte-for-byte in another
  language; a single whitespace difference yields a permanently unpromotable node.
  This alone rules out skill-side direct file writes.
- Claim evidence discipline exists: `support_type ∈ {literature, data, calculation,
  expert_consensus}` requires ≥1 evidence URI; `{llm_inference, assumption}`
  requires a `verification_plan`. Placeholder URIs are stripped at promotion and
  evidence-typed claims left empty then fail — evidence-free ideas can exist but
  can never be promoted.
- The evaluation pipeline is complete and stays untouched: `idea-posterior`
  (anchored four-route admission gate; five sub-criteria; three Jeffreys evidence
  grades; MaxEnt fallback; `node.set_posterior` writeback), `idea-pairwise-match`
  (criteria committed to disk first; ≥3 model families; capped tier-10
  observations), `idea-allocation` (Thompson sampling over posteriors; recon /
  deep / hold slots; activation monitor).
- `deep-literature-review` produces `literature_survey_v1`
  (`packages/shared/src/literature-survey.ts`): `synthesis.tensions[]` carry
  integrity-checked `ref_keys`; **`synthesis.gaps[]` are bare strings without
  references** — this asymmetry drives a validation rule in §5.2.
- Campaign budgets already include `max_nodes` with usage accounting and
  `budget_exhausted` semantics; all mutations run under a per-campaign lock with
  idempotency record/replay (prepared → committed).

## 3. Prior art and what it decided

### 3.1 The archived island-evolution runtime (reuse-vs-rebuild)

Git archaeology (last full state `abe9fcba`, archived in `6eba3187`) shows the old
"island-evolution search" never had an LLM in the loop: all six implemented
operators were deterministic template renderers; the "Librarian" fabricated
search-landing-page URLs with hard-coded relevance priors; `rank.compute`'s "elo"
never played a match; the bandit's reward (a node committed = 1.0 per tick) was
saturated by construction. Migration between islands was never implemented.

**Reused from the archive (design assets, never exercised, not falsified):**

- the 12-family discovery-operator taxonomy (per-family required outputs,
  mandatory validations, common misjudgments) as PROMPT contracts for the new
  LLM-backed operators;
- the explain-then-formalize two-stage discipline (already enforced by
  `node.promote`);
- the immutable provenance contract itself — now filled with real values (real
  model id, real temperature, hash over the real prompt);
- the negative-result ledger discipline (exact-tag, negative-only, avoidance
  context at generation time, never a score input);
- the novelty-delta-table design (closest prior + delta type + falsifiable delta
  statement + non-novelty flags) — reborn as a claim checked by `claim-grounding`
  (§5.3).

**Left archived (superseded or structurally broken):** the heuristic 0/1 scoring
and fake elo/pareto; the island state machine and repopulation counters
(`island_id` stays a historical lineage tag); the template operators and template
Librarian; the UCB-V distributor; engine-side domain packs.

### 3.2 External state of the art (2023–2026)

A five-cluster survey (verified against primary sources; 2026 preprints flagged
and their numbers to be re-verified before further reliance) fixed the design
constraints in §1. The load-bearing findings:

- **Ideation–execution gap** (arXiv:2506.20803, pre-registered RCT): AI ideas'
  novelty advantage disappears after ~103 h of real execution (drops of 1.0–1.9
  on all metrics; ideation scores have no predictive validity for execution
  scores). Consequence: admission must weigh bounded first checks and kill
  criteria, not idea-stage brilliance.
- **LLM idea-judging is non-diagnostic** (arXiv:2409.04109 Table 11; corroborating
  2026 preprints): never authoritative anywhere in this design.
- **Grounding rigor has a ladder**: exact graders > temporal-split validation >
  external experiment > forced-retrieval span-anchored citation >
  citation-list RAG > LLM self-eval/Elo > closed book. Existing idea systems live
  at the citation-list tier; generating directly from span-anchored survey
  artifacts puts this stack one tier higher BY CONSTRUCTION — the clearest
  beyond-parity opportunity.
- **Evolutionary search transfers only partially**: FunSearch / AlphaEvolve-class
  results rest on exact machine-gradeable fitness. Our fitness (posterior +
  tournament) is an expensive, imperfect proxy — the operative failure modes are
  reward hacking (documented concretely in Darwin-Gödel-Machine node 114), winner's
  curse on noise, Goodhart drift, and diversity collapse. What transfers:
  evaluation cascades (cheap screens before expensive judges), open archives with
  novelty-weighted parent selection, multi-parent in-context recombination, and
  keeping any novelty check OUT of the scoring path.

## 4. Strategy evaluation (four-seat panel)

Six candidate strategies were scored independently against eight criteria
(evidence-groundability, admission-gate fit, novelty yield, feasibility yield,
contract fit, cost per admitted idea, domain-agnosticism, failure-mode profile) by
four judges: three host-model seats with distinct lenses (evidence integrity;
contracts and wiring; portfolio selection dynamics) and one cross-family seat
(GPT-family, read-only). Full judgments live in the maintainer review records.

| Strategy | J1 evidence | J2 engineering | J3 dynamics | J4 cross-family | Consensus |
|---|---|---|---|---|---|
| S3 tension/gap mining | 1st | 1st | 1st | 1st | **V0 core** |
| S6 failure-ledger rerouting | 2nd | 3rd | 3rd | 2nd | V1 (or V0.1 when ledger data exists) |
| S1 single-parent mutation | 3rd | 2nd | 2nd | 3rd | V1 |
| S2 multi-parent recombination | 4th | 4th | 4th | 4th | V1.5 (constrained) |
| S4 cross-domain analogy | 5th | 5th | 5th | 5th | V2 (gated) |
| S5 revive island-evolution runtime | 6th | 6th | 6th | 6th | **Never as runtime** |

Unanimous verdicts: S3 first; S5 last and excluded as a runtime (it structurally
requires a cheap fitness proxy, which constraint §1.1 forbids; its salvageable
mechanisms are absorbed as policies in §5.4/§6.5). The residual dissent, named
explicitly: J2 recommended S1 as a V0 secondary operator on the same import
track; J3 placed S1+S6 together in V1; the cross-family seat made S6 conditional
V0/V0.1 (iff real failure-ledger inputs exist) and deferred S1. The synthesis
adopts the majority: V0 ships S3 (plus `FailureRouting` only when ledger data
exists), and S1's only self-anchored variant — rerouting a parent's RECORDED
risks/kill criteria — ships first among the V1 operators; the rest of S1's
variants and S6 activate as posteriors and failure-ledger entries accumulate.

Panel findings folded into the design:

- The novel part of a mutated/recombined/analogized idea (the delta, the bridge
  claim, the mapping) is exactly its unanchored part; inherited parent anchors make
  it LOOK grounded. Rule: the delta must be stated as an explicit claim with
  `support_type: llm_inference` or `assumption` plus a `verification_plan` and a
  kill criterion — the existing card schema already enforces this shape (J1).
- Winner's curse must be designed away at parent selection: sample parents from the
  Thompson layer (variance-aware), discount by children already spawned
  (× 1/(1+N_children)), cap children per parent — never argmax over noisy
  posteriors (J3; mechanism borrowed from open-archive evolutionary systems).
- Near-duplicate siblings are posterior-neighbors, and the pairwise layer pairs
  posterior-neighbors first — so weak dedup converts directly into wasted
  cross-family tournament spend on split/tie matches. Embedding dedup is V0
  infrastructure, not polish (J3).
- `gaps[]` entries are bare strings: a gap-derived candidate must first RESOLVE
  the gap to at least one real reference with a retrieval receipt, or be rejected
  at pack validation — "no resolved references, no gap idea" (J2, J1).
- Derived nodes must record the parents' `revision` at read time
  (`parent_revisions`), since parents' mutable fields move and the generator's
  actual input could otherwise not be reconstructed (J2).

## 5. The operator set

Six operator families (free-string `operator_family`; arity enforced by the import
validator, not the schema). `operator_id` = `<family-tag>.<variant>.v<N>`.

| operator_family | strategy | parent_node_ids | born-with anchors |
|---|---|---|---|
| `Seed` | (existing import) | exactly 0 | seed `source_uris` |
| `LiteratureMining` | S3 | exactly 0 | survey tension `ref_keys` → note paths → evidence URIs; re-anchored gap references |
| `Mutation` | S1 | exactly 1 | parent's anchors + the trigger artifact; delta claim marked `llm_inference`/`assumption` |
| `Recombination` | S2 | ≥ 2 | all parents' anchors; explicit bridge claim marked `llm_inference` + verification plan |
| `AnalogyTransfer` | S4 | 0–1 | source-domain retrieval receipts + target anchors; `analogy_mapping[]` required non-empty |
| `FailureRouting` | S6 | 0–1 | `failed_approach_v1` entries (failure_evidence_uris) and/or an archived parent's kill_criteria |

### 5.1 Shared generation discipline (all families)

Every candidate must carry, at generation time:

1. a faithful `rationale_draft` (title, rationale, risks, kill_criteria; mechanism
   and analogy_mapping where applicable) — the idea stated as-is, not pre-narrowed;
2. card fields: testable hypotheses, required observables, a minimal compute plan
   whose FIRST step is a bounded, decisive check, and claims typed under the
   existing evidence discipline;
3. anchors with retrieval receipts (§1.2) — every evidence URI names the artifact
   or fetch it came from in `operator_trace.evidence_uris_used` and
   `operator_trace.inputs.retrieval_receipts`;
4. a `target_admission_route` (`open_problem | mechanism | method | framework`) —
   the generator's declaration of which admission route the idea should be judged
   under; carries no authority, aids triage;
5. a novelty-delta record (§5.3) and a dedup record (§5.2);
6. the burst's trigger (§6.4).

### 5.2 Dedup (mechanical, retrieval/embedding only)

- Mechanical similarity against ALL campaign nodes (active, waiting, archived)
  AND against the burst's own earlier candidates (same-anchor twins are the
  most likely duplicates; a store-only comparison cannot see them) over thesis
  + rationale + claims: ≥ 0.95 auto-drop (recorded), 0.80–0.95 flagged for
  human review; nearest neighbor (store node id or intra-burst candidate
  index) recorded per candidate. As built in V0: a deterministic hashed
  character-3-gram cosine with an exact normalized-text short-circuit,
  recorded as a method id — honest about not being a neural embedding (backend
  upgrade stays open question 3). The engine additionally refuses exact
  intra-pack twins and self-contradictory dedup records (decision unique at
  ≥ 0.95).
- Exact-hash check on normalized title/rationale (the short-circuit above).
- Gap re-anchoring rule: no resolved references, no gap idea.
- One bounded freshness retrieval per candidate: has the tension/gap been resolved
  by literature published after the survey snapshot? (Receipt recorded; a hit
  demotes the candidate to rejected-with-reason.)
- NEVER parametric-memory novelty checks (1.3–32.7% accuracy) and never an LLM
  novelty score anywhere.

### 5.3 Novelty as an auditable claim, not a score

Each candidate carries a closest-prior record: `{closest_prior (URI or ref_key),
overlap_summary, delta_type, falsifiable_delta_statement}` — the archived
novelty-delta-table design reborn. The delta statement enters the idea card as a
claim (typed `llm_inference` with a verification plan), so `claim-grounding` and
the admission reviewers audit novelty the same way they audit any other claim.
Parameter tweaks and rewordings are declared non-novel by construction.

### 5.4 Diversity and saturation (per burst)

- One candidate per structurally distinct anchor; per-anchor quota ≤ 2.
- Per-parent child quota (V1 families); parent selection via Thompson draw ×
  1/(1+N_children) discount — variance-aware, never argmax.
- A burst runs once on its evidence snapshot (at most one revision round), and its
  size defaults small (≤ 8 candidates) — scaled to reconnaissance capacity, since
  every admitted idea's first check lands in a recon slot.
- The enumerable anchor set is simultaneously the saturation clock (no new anchors
  → nothing to generate), the trigger vocabulary (§6.4), and the anti-island
  coupling — this replaces the archived island state machine outright.

### 5.5 Where breakthrough-scale ideas can come from (the door stays open)

Tension/gap mining (V0) is the highest evidence-per-cost strategy, and resolving
an anchored standing tension is itself a classic breakthrough route — but S3 does
bias toward agendas already visible in the literature. The design keeps four
explicit channels for larger jumps rather than optimizing them away:

1. **The high-ceiling operators are phased, not excluded**: `AnalogyTransfer`
   (highest novelty ceiling, strictest gates) and cross-family `Recombination`
   arrive in V1.5/V2; `Mutation`'s claim-inversion variant covers counterfactual
   jumps. Their gating is an evidence discipline, not a novelty ceiling.
2. **The admission gate has a framework route** (route 4: equivalence obligation +
   generative obligation) — paradigm-scale ideas have a first-class entry that
   does not require them to look like incremental tension resolutions.
3. **Low posterior is survivable by design**: MaxEnt fallback, waiting_activation
   with activation conditions, non-eliminating tournaments, and Thompson
   sampling's nonzero draw probability mean a bold, weakly-evidenced idea persists
   and revives when evidence arrives, instead of being culled at birth. The
   portfolio's exploration pressure is structural, not a generator prompt trick.
4. **Seeds remain a first-class channel**: human-originated bold ideas enter via
   seed_pack (and the re-scoped research_brainstorm handoff) at any time — the
   generation operator adds to that channel; it never becomes the only source.

What V0 alone will NOT do is manufacture paradigm shifts on demand — no surveyed
external system does either; the honest claim is that this design keeps
breakthrough-scale candidates admissible, survivable, and cheaply revivable,
while everything it generates stays auditable.

## 6. Wiring

```
deep-literature-review ──▶ literature_survey_v1 ─┐  (tensions/gaps + ref_keys)
failed_approach_v1 ledger ───────────────────────┤
existing nodes (posterior, risks, kill_criteria) ┤            [triggers §6.4]
                                                 ▼
                         skills/idea-generation  (NEW; Explain stage)
                           strategy prompts (from the archived taxonomy),
                           retrieval receipts, dedup, novelty-delta records
                                                 │  writes
                                                 ▼
                             generation_pack_v1  (NEW artifact)
                                                 │  stdin → bin/idea-rpc.mjs
                                                 ▼
                    engine RPC  node.import_generated  (NEW; Formalize stage)
                      validate pack + arity table + anchors; mint ids;
                      deterministic idea_card assembly + formalization trace;
                      max_nodes budget; mutation lock; idempotency (value-
                      equality recovery probe); atomic all-or-nothing batch;
                      archive pack as campaign artifact; append node log
                                                 │  nodes (posterior: null)
                                                 ▼
      idea-posterior admission gate ──▶ Gaia graph ──▶ node.set_posterior
                     │ (fail → node.set_lifecycle archived, gate_result recorded)
                     ▼
      idea-pairwise-match (cross-family, capped)  ⇄  idea-posterior absorption
                     ▼
      idea-allocation (Thompson; recon slot = the idea's first bounded check)
                     ▼
      research-team execution → evidence artifacts → posteriors move,
      failures logged → NEW TRIGGERS → next generation burst
```

### 6.1 `generation_pack_v1` (new contract, engine-side authority)

One pack = one burst = one audit unit. Contents: campaign_id; trigger; evidence
snapshot references (survey artifact ref + hash, ledger refs, parent ids +
`parent_revisions`); per-candidate {rationale_draft, card fields, provenance
(operator_family/operator_id/origin/trace inputs+params), dedup record,
novelty-delta record, target_admission_route}; and the burst's REJECTED candidates
with dispositions (dedup hit, unresolved gap, freshness hit, anchor validation
failure). The pack is archived verbatim as a campaign artifact on import.

### 6.2 `node.import_generated` (new engine RPC — panel-unanimous choice)

Mirrors the seed-import path (option (b)); direct skill-side file writes are
excluded because they would bypass the mutation lock, idempotency recovery, budget
accounting, the append-only node log, and would have to replicate the engine's
text sanitization for `rationale_hash` byte-for-byte (§2). A per-node RPC is
excluded because the burst is the natural transaction: single idempotency key,
batch-atomic `max_nodes` check, one dedup/quota report.

Engine responsibilities: validate the pack (schema + arity table + per-family
anchor rules + §5.2 rule for gaps); refuse when the campaign is not running or the
batch would exceed `max_nodes` (`budget_exhausted`); mint node/idea ids
(collision-safe short ids); assemble `idea_card` deterministically from the pack's
card fields with the engine's own sanitization; compute
`operator_trace.params.formalization` (mode, source_artifact, rationale_hash)
engine-side so promotion can never drift; validate every node against
`idea_node_v1`; then perform all store writes under the campaign mutation lock
with prepared→committed idempotency.

Crash-recovery semantics (stated precisely — the store's writes are separate
file operations for the pack artifact, `nodes_latest.json`, the node log, and
`campaign.json`, so there is no filesystem-level transaction): the PREPARED
idempotency record carries the full planned effect — the minted node ids with
their complete node payloads, the pack artifact name+hash, the node-log entries,
and the planned `usage.nodes_used`. A replay of the same import commits only if
ALL four effect classes are value-equal to the prepared record (nodes present and
byte-equal, pack artifact present with matching hash, log entries present,
`nodes_used` consistent). On partial state after a crash, the recovery path
COMPLETES the missing writes from the prepared payload — it never re-mints ids
and never regenerates content — and only then marks the record committed; any
inconsistency that cannot be completed from the prepared payload (a value
mismatch rather than an absence) refuses with an explicit error for manual
repair. The guarantee is thus all-or-nothing at the idempotency-protocol level —
no partially imported burst is ever observable as committed — not filesystem
atomicity. Implementation note: the engine's generic prepared-record recovery
DELETES an incomplete prepared record and re-executes the method
(`idempotency.ts`), which would re-mint ids for an import — `node.import_generated`
must therefore register its own method-specific recovery branch implementing the
completion rule above instead of inheriting the generic path.

As-built refinements (V0 implementation, post-review): (1) the completion
SOURCE is the archived pack artifact rather than an enlarged prepared record —
the prepared record carries the minted ids, `created_at`, `pack_artifact_ref`
and `pack_hash` (probe data), while the full node payloads ride the pack
artifact, whose hash the record pins; same guarantee, smaller record. (2) Node
equality is checked on the IMMUTABLE projection only (lineage, origin, trace,
rationale draft, created_at) so a legitimate posterior/lifecycle mutation that
landed between crash and retry is never misread as corruption. (3) `nodes_used`
is derived state (total node count) and recovery recomputes it rather than
comparing recorded counters. (4) Recovery completion deliberately does NOT
re-check the nodes budget or campaign lifecycle: the burst's budget decision
was made at prepare time, so completing an approved burst after an interleaved
import may transiently overshoot `max_nodes` — the recomputed usage makes the
overshoot visible and flips a running campaign to exhausted; refusing
completion would strand approved effects, which is worse. (5) Node-log appends
heal a torn trailing line (crash mid-append) by starting a fresh line instead
of gluing onto the fragment, and stale campaign locks from provably dead
processes are reclaimed (live holders surface as `store_locked`), so the
retry that recovery depends on can actually run after a hard kill.

Non-surfaces: no MCP exposure (matches the deliberately narrow `idea-mcp`
posture); no auto-invocation; generated nodes never carry a posterior or a
grounding_audit at birth — those fields belong to the evaluation side.

### 6.3 `skills/idea-generation` (new skill — the only new agent surface)

Owns the Explain stage: strategy prompt contracts (instantiated from the archived
taxonomy's per-family required-outputs/validations/misjudgments), retrieval and
receipts, dedup and novelty-delta records, pack assembly, and the `idea-rpc.mjs`
call. Explicitly does NOT: score, write posteriors or lifecycle states, invoke
admission itself, or loop unattended. Its SKILL.md carries the trigger vocabulary
and the per-family checklists.

### 6.4 Triggers (event-driven coupling to live research)

`operator_trace.inputs.trigger = {kind, artifact_ref}` with kind ∈
`survey_updated | computation_gated | failure_recorded | match_concluded |
activation_satisfied | milestone_reached | posterior_moved | manual`.
V0 accepts `manual`, `survey_updated`, `failure_recorded`; the rest enter the
vocabulary now so later automation is a policy change, not a redesign.
`match_concluded` stays disabled until the tournament seam has been exercised
end to end on a real campaign (§8.1 — the id-convention fix itself has landed,
but an unexercised seam is not an enabled one).

### 6.5 Seams to the evaluation stack

- **idea-posterior**: generated nodes declare their target admission route and
  arrive with the route's anchors already resolvable (a `LiteratureMining` node's
  tension anchor IS admission route 1's required recorded statement). Nodes that
  fail admission are archived with their `gate_result` — and become `FailureRouting`
  inputs, closing a second loop.
- **idea-pairwise-match**: no change; dedup upstream protects tournament economics.
- **idea-allocation**: no change in V0; the w_i-style parent-selection policy
  (§5.4) lives in the generation skill's parent-sampling step, reading the same
  `nodes_latest.json`. A future allocation extension may schedule generation
  bursts as a decision-layer action.
- **research_brainstorm** (workflow-plan recipe): re-scoped, not retired.
  `emit_next_contract` gains one legal handoff target — exporting accepted angles
  (and their rejected alternatives, as negative space) into a `seed_pack_v1` for
  `campaign.init` / a future `seed.append`. Angles become SEEDS (human-initiated
  triage), never generated nodes; the recipe keeps its planning-only, no-runtime
  contract, and the pack stays the single boundary object between the two
  vocabularies.

## 7. Provenance and reproducibility (per generated node)

| Field | Content (generated nodes) |
|---|---|
| `origin.model` | real generator model id (never a backend label) |
| `origin.temperature` | real sampling temperature |
| `origin.prompt_hash` | sha256 over the rendered generation prompt |
| `origin.role` | `'Generator'` |
| `operator_trace.inputs` | trigger {kind, artifact_ref}; parent ids + `parent_revisions`; survey/ledger artifact refs + content hashes; anchor identifiers (tension index/ref_keys, failure tags); `target_admission_route`; `retrieval_receipts`; dedup record (nearest neighbor + cosine); novelty-delta record |
| `operator_trace.params` | operator prompt-contract version; strategy parameters (quotas, thresholds); `formalization` (engine-stamped) |
| `operator_trace.evidence_uris_used` | exactly the resolved URIs backing the candidate's claims |
| `operator_trace.random_seed` | when sampling among anchors/parents |
| `operator_trace.prompt_snapshot_hash` | sha256 of the full prompt snapshot archived with the pack |
| `rationale_draft` | the faithful Explain-stage statement (immutable) |

Reproducibility statement: given the pack artifact (archived on import), the
prompt snapshot, the evidence snapshot hashes, and the recorded seeds, a third
party can reconstruct exactly what the generator saw and check every anchor
without re-running any model.

## 8. Integration debts discovered during this design (separate lanes)

1. **`idea-pairwise-match` id-convention defect (was blocking the tournament
   seam)**: the skill validator required dashed uuids while the engine
   `pairwise_match_v1` schema requires 8-char short ids — mutually exclusive, no
   artifact could satisfy both. FIXED and merged: the skill converged to the
   engine convention with an anti-drift lock asserting the skill regex equals the
   engine schema pattern at test time (independent review: SAFE-TO-SHIP over two
   rounds). `match_concluded` triggers (§6.4) may be enabled once the tournament
   seam is exercised end to end on a real campaign.
2. **`idea-allocation` has the same defect class in code** (`uuid5` decision ids +
   uuid validation vs the engine's 8-char contract): second fix lane in progress,
   preserving decision-id determinism via a digest-derived short id.
3. `node.list` lacks an `operator_family` filter (lineage queries need client-side
   filtering) — backlog; V0 unaffected.
4. `idea-pairwise-match` SKILL.md describes node inputs with fields
   (`title`/`gist`/`status`) that `idea_node_v1` does not have — wording alignment,
   backlog. Same-lane hygiene backlog from review: convert the remaining
   `re.match` on `content_sha256` to `fullmatch`; the skill's shared-mapping-table
   prose says "shared verbatim with idea-posterior" while the mechanical lock
   actually pins SKILL.md ↔ `assemble_match.py` — align the wording.
5. Skill-level pytest suites (`skills/*/tests/`) are not run by repository CI —
   a pre-existing arrangement, so the new anti-drift locks bind only locally;
   whether to add a skills-test CI job is a separate lane's decision.

## 9. V0 — the smallest honest slice

**Build:** `generation_pack_v1` contract + `node.import_generated` RPC (with the
arity/anchor validator, budget, idempotency probe, pack archival) +
`skills/idea-generation` implementing `LiteratureMining` only (tension-first;
gap branch behind the re-anchoring rule) + the shared discipline (§5.1–5.4) +
trigger recording. Optionally in the same slice, `FailureRouting` activates iff
real `failed_approach_v1` entries exist — same import path, no extra architecture.

**Explicitly not in V0:** `Mutation`/`Recombination`/`AnalogyTransfer` (V1/V1.5/V2
per §4) — and the ENGINE enforces this exactly as it does reserved trigger
kinds (`operator_family_not_enabled` until each family's evidence discipline
lands in the import validator; prose is not a gate); any generation-side
score; auto-triggering; MCP exposure; `operator_family` schema enum;
tournament-dependent triggers. Prompt snapshots are implemented end to end in
V0: the full rendered prompt is archived inside the pack
(`pack.prompt_snapshots`) and the engine verifies every declared
`prompt_snapshot_hash` against it at import.

**Acceptance:** (a) a real external-project campaign where one survey update
produces a pack whose every candidate has resolvable anchors and receipts
(mechanical zero-fabrication audit); (b) ≥1 generated node passes the admission
gate and receives a posterior with the generation trace intact end to end;
(c) unique-yield ≥ the per-anchor construction implies (no near-duplicate pair
above 0.95 imported); (d) a deliberately anchor-less candidate, a gap candidate
without re-anchored references, and an over-budget pack are each refused with
the correct error; (e) replaying the same pack import is a no-op (idempotency),
and a simulated crash between store writes recovers by completing the prepared
payload — same node ids, no duplicates, consistent `nodes_used`; (f) the
imported pack is archived verbatim as a campaign artifact INCLUDING its
rejected candidates with dispositions, the prompt snapshot artifact exists and
matches `prompt_snapshot_hash`, one node-log `create` entry exists per imported
node, and `usage.nodes_used` advanced by exactly the imported count.

**V1+:** `Mutation` (risk/kill-criterion rerouting variant first) once
posterior-bearing nodes accumulate; `FailureRouting` fully; then constrained
`Recombination` (mechanism/tension-sharing pairs only, bridge claim mandatory)
after the pairwise seam fix ships; `AnalogyTransfer` last, gated on per-edge
source verification + mapping table + breakpoint risks + a toy target check.

**Never:** a revived island-evolution scheduler; cheap fitness proxies; LLM
novelty scores; generator-written posteriors/audits; free-text failure-library
retrieval; a generation daemon.

## 10. Beyond-SOTA claims this design can actually test

1. **Grounding tier**: generated ideas are born at the forced-retrieval,
   span-anchored tier (external gap-mining systems operate one tier below).
   Test: the mechanical zero-fabrication audit on every pack.
2. **Selection integrity**: criteria-committed cross-family judging + anchor-
   audited posteriors replace self-graded Elo. Test: no monotonic internal score
   drift without new external evidence; post-execution retention of generated
   ideas tracked against the ideation-execution-gap pattern.
3. **Unique yield**: per-anchor construction + dedup targets ≥ the best reported
   non-duplicate rates (>80%) rather than the ~5% naive-sampling baseline.
   Test: dedup reports per burst.
4. **Failure-ledger generation** (`FailureRouting`) has no external equivalent.
   Test: lineage cases where an ancestor died on a recorded failure and a
   rerouted descendant is admitted with a rising posterior.
5. **Honest ignorance is a first-class state** (MaxEnt fallback, placeholder
   stripping, coverage debt) — absent from all 27 surveyed systems.

## 11. Open questions

1. Should `seed.append` (adding seeds to a RUNNING campaign) ship with the
   `research_brainstorm` handoff, or is campaign re-init acceptable until then?
2. Pack-level human approval: V0 keeps import manual (operator runs the skill and
   the RPC); is a two-step propose→approve flow wanted before import, or is the
   admission gate the approval?
3. Embedding backend for dedup: pin a local model (reproducible, offline) vs
   provider embeddings (better quality, external dependency) — V0 default is
   local + recorded model id/version.
4. When allocation later schedules generation bursts as decision-layer actions,
   does burst budget draw from recon slots or a new slot class?

## 12. References

Engine/contract authority: `packages/idea-engine/contracts/idea-runtime-contracts/
schemas/` (`idea_node_v1`, `idea_card_v1`, `rationale_draft_v1`, `seed_pack_v1`,
`failed_approach_v1`, `pairwise_match_v1`, `allocation_decision_v1`,
`idea_runtime_rpc_v1.openrpc.json`); `packages/idea-engine/src/service/`
(`seed-node.ts`, `node-shared.ts`, `campaign-init-executor.ts`,
`node-promote-executor.ts`); `packages/shared/src/literature-survey.ts`.
Archived runtime: `git show abe9fcba:packages/idea-engine/src/service/`,
design docs at `git show a0b3cb99:packages/idea-generator/docs/plans/`
(operator taxonomy: `2026-02-12-executable-discovery-operators.md`).
External evidence (load-bearing, peer-reviewed or independently verified):
arXiv:2409.04109; arXiv:2506.20803; arXiv:2502.18864 (Nature 2026); FunSearch
Nature 625 (2024); arXiv:2506.13131; arXiv:2505.22954; arXiv:2509.19349;
arXiv:2501.09891; arXiv:2409.05556 + arXiv:2403.11996; arXiv:2410.07076;
arXiv:2410.13185; arXiv:2305.14259; arXiv:2410.14255; arXiv:2412.17596
(Nat. Commun.); arXiv:2502.14297; Sci Rep 10.1038/s41598-023-41032-5;
JMIR Mental Health 10.2196/80371; arXiv:2501.19361; arXiv:2310.13032.
Flagged 2026 preprints cited in the body as directional corroboration only
(numbers to be re-verified before further reliance): arXiv:2605.26340
(five-system bibliography audit); arXiv:2602.06718 (GhostCite).
