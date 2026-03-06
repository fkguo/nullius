# SOTA Note — Phase 3 Batch 10 (SEM-01 + SEM-06) — 2026-03-05

Scope: evidence-first Autoresearch semantics track (Phase 3 Batch 10) covering:
- **NEW-SEM-01**: Quantity Semantics Adjudicator (quantity/entity alignment)
- **NEW-SEM-06**: Evidence Retrieval Upgrade (semantic-first retrieval + rerank + fallback)

This note records *recent* (priority 2024–2026) practices and concrete design implications for the implementation in `packages/hep-mcp/`.

---

## 1) Quantity normalization / entity alignment (SEM-01)

### Recent practice (2024–2026)

1) **Treat “quantity alignment” as entity matching / entity resolution (ER)**, not as keyword lookup.
   - Model the problem as deciding whether two surface forms refer to the *same underlying quantity*, with an explicit **abstention** option.
   - Prefer *structured* adjudication (multi-step reasoning, explicit attributes) over a single opaque label.

2) **Multi-step structured reasoning improves robustness on hard/OOD cases** (vs. single-shot prompts).
   - A practical template is: *surface alignment → key attributes → comparability → decision + confidence*.
   - Reference: arXiv:2511.22832 (“Structured Multi-Step Reasoning for Entity Matching Using LLM”). https://arxiv.org/abs/2511.22832

3) **Global consistency via clustering / collective decisions** can reduce pairwise error and cost.
   - Instead of adjudicating every pair independently, cluster mentions and only adjudicate “frontier” decisions.
   - Reference: arXiv:2506.02509 (“In-context Clustering-based Entity Resolution with LLM”). https://arxiv.org/abs/2506.02509

4) **Deterministic features (units, dimensional category, schema constraints)** should be *post-guards*, not the semantic authority.
   - Unit parsing/dimension checks are valuable for “cannot be same quantity” proofs (fail-closed / return `uncertain`).
   - Avoid using small closed lists of quantities/units as the *primary* adjudicator.

### Implementation implications for this repo

- Use a **structured adjudicator output** with an explicit abstention path:
  - `decision: match | split | uncertain`
  - `canonical_quantity` (stable string for grouping)
  - `unit_normalization` (if applicable; deterministic-only)
  - `confidence` (calibrated to [0,1])
  - `reason_code` (small operational enum; includes `other`; **not** a physics closed set)
- Prefer an **LLM-first** adjudication step (via MCP sampling `ctx.createMessage`) and follow with deterministic guards:
  - guard examples: unit category conflict, missing critical fields, schema violations.
- Introduce **caching** keyed on a stable hash of (inputs + prompt_version + model) to control cost and keep eval reproducible.
- Design outputs to be reusable by Batch 11/12 (claim→evidence→stance): keep `confidence`, `reason_code`, and provenance fields stable.

---

## 2) Semantic retrieval + reranking (SEM-06)

### Recent practice (2024–2026)

1) **Multi-stage retrieval is the default SOTA pattern**:
   - Stage A: fast candidate generation (sparse / dense / hybrid).
   - Stage B: reranking (cross-encoder or efficient interaction models).
   - Stage C: policy-driven fallback (timeouts / low-confidence / missing embeddings).

2) **Late interaction / multi-vector retrieval improves OOD robustness** compared to single-vector dense retrieval.
   - Practical option: ColBERT-style late interaction.
   - Reference: arXiv:2408.16672 (“Jina-ColBERT-v2: A General-Purpose Multilingual Late Interaction Retriever”). https://arxiv.org/abs/2408.16672

3) **Efficient interaction rerankers** aim to approach cross-encoder quality at lower latency.
   - Example: MICE cross-encoder variants with efficiency focus.
   - Reference: arXiv:2602.16299 (“MICE: … Minimal Interaction Cross-Encoder for Efficient Reranking”). https://arxiv.org/abs/2602.16299

4) **Hybrid retrieval with calibrated blending** (sparse+dense) remains strong in practice.
   - Useful when dense signals are brittle or when queries are short/ambiguous.
   - Reference: arXiv:2503.23013 (“Dynamic Alpha Tuning for Hybrid Retrieval in High-Risk RAG”). https://arxiv.org/abs/2503.23013
   - Reference: arXiv:2212.10528 (“HYRR: Hybrid Infused Reranking for Passage Retrieval”). https://arxiv.org/abs/2212.10528

5) **Query reformulation / expansion** can improve recall, but must be gated by policy to avoid drift and hallucinated terms.
   - In evidence-first settings, reformulation should be auditable and reversible.

### Implementation implications for this repo

- Make the **default** project evidence query semantic-first when embeddings exist; keep lexical as *fallback* only.
- Adopt a **rerank** stage that is:
  - cheap and deterministic by default (latency-friendly, local-only),
  - explicitly policy-driven (thresholds + observability),
  - able to incorporate multiple signals (semantic similarity, token overlap, importance priors).
- Always emit structured provenance:
  - `retrieval_mode`, `rank`, `score`, and a stable `evidence_id/source` identifier.
- Track and report `fallback_rate`, plus p50/p95 latency.

---

## 3) Fallback policy (SEM-01 + SEM-06)

### Recent practice (operational)

1) **Fail-closed / abstain by default** for low-confidence semantic decisions (especially alignment).
2) **Explicit triggers** for fallback:
   - timeout, missing embeddings, invalid model response, low confidence, insufficient context.
3) **Make fallback observable**:
   - counters: `fallback_rate`, `timeout_rate`, `invalid_response_rate`
   - attach per-case `reason_code` and provenance for debugging/eval analysis

### Implementation implications for this repo

- SEM-01:
  - If `ctx.createMessage` is unavailable, treat the semantic adjudicator as unavailable and return `uncertain` (or fail-closed for gates that require it).
  - Enforce deterministic guards (unit/schema) after LLM output.
- SEM-06:
  - If semantic prerequisites are missing (no embeddings artifact), fall back to lexical retrieval with an explicit `retrieval_mode='lexical_fallback'`.
  - If semantic score distribution is low/flat, trigger rerank-only or lexical fallback based on thresholds defined in code (and surfaced in eval).

---

## Checklist (to be reflected in Batch 10 implementation)

- [ ] SEM-01: structured adjudicator output + deterministic guards + explicit abstention
- [ ] SEM-01: eval set includes long-tail/OOD + locked holdout split
- [ ] SEM-06: semantic-first retrieval + rerank + explicit fallback policy + telemetry
- [ ] SEM-06: eval set includes citation/support/irrelevant + long-tail/OOD + locked holdout split
- [ ] Both: stable field naming for Batch 11/12 reuse (`confidence`, `reason_code`, provenance)

