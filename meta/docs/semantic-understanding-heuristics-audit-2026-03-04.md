# Semantic Understanding Heuristics Audit (2026-03-04)

## Scope and Goal

This audit identifies places in `autoresearch-lab` where semantic understanding is currently implemented via enum/regex/hardcoded logic but should likely be handled by LLM-based semantic interpretation.

Working definition used in this audit:

- **Semantic understanding** = meaning-level inference (stance, entailment, paraphrase alignment, implicit assumptions, discourse-level contradiction, semantic relevance ranking).
- **Non-target by default** = deterministic syntax/format parsing (LaTeX/BibTeX/JSON/schema/path validation) *unless* it is incorrectly treated as semantic proof or used as a gate source-of-truth.

Method (2026-03-04):

- Static scan for keyword lists / synonym maps / regex catalogs / heuristic scoring in the focus scope.
- Manual read of high-impact modules and their downstream usage paths.
- External cross-check reviews (Claude Opus + OpenCode/GLM-5 + OpenCode/Kimi K2.5) and integration of converged critique.

Requested focus scope:

- `packages/hep-mcp/src/core/` (measurements, evidence, conflicts, enrichment)
- `packages/hep-mcp/src/tools/research/` (extraction, conflict detection, config)
- `packages/shared/` (shared normalization)
- `skills/research-team/scripts/` (claim extraction, convergence gate)
- `skills/research-writer/` (evidence grounding)

Known references (confirmed):

- `measurements.ts` quantity synonym + substring matching
- `information_membrane.py` V1 vs V2 pattern (V2 is now LLM-based)

---

## Round 1 Findings (Primary)

### 1) Quantity semantic normalization via keyword/synonym match

- Location:
  - `packages/hep-mcp/src/core/hep/measurements.ts:172`
  - `packages/hep-mcp/src/core/hep/measurements.ts:187`
  - `packages/hep-mcp/src/core/hep/measurements.ts:197`
  - `packages/hep-mcp/src/core/hep/measurements.ts:215`
  - `packages/hep-mcp/src/core/hep/measurements.ts:221`
- Current approach:
  - `QUANTITY_KEYWORDS` + `QUANTITY_SYNONYMS` + `includes()`
  - `extractQuantityHint()` and `normalizeQuantityHint()` on lexical hints
- Problem:
  - Symbol ambiguity and context dependence cause false mapping and misses.
  - Synonym lists are static and brittle for new literature phrasing.
- Recommendation:
  - Introduce LLM quantity/entity adjudication (`canonical quantity + confidence + rationale + alternatives`) and keep deterministic unit/schema checks as post-guards.
- Severity: **Critical**

### 2) Measurement extraction quantity hinting still lexical

- Location:
  - `packages/hep-mcp/src/tools/research/measurementExtractor.ts:160`
  - `packages/hep-mcp/src/tools/research/measurementExtractor.ts:200`
  - `packages/hep-mcp/src/tools/research/measurementExtractor.ts:208`
- Current approach:
  - `QUANTITY_KEYWORDS`, title/context `includes()` and unit regex hints.
- Problem:
  - Semantic linking between value/unit/physical-quantity is not robust.
- Recommendation:
  - Keep regex as candidate extraction, move final quantity/entity linking to LLM judge.
- Severity: **High**

### 3) Conflict detector quantity normalization and thresholding depend on lexical mapping

- Location:
  - `packages/hep-mcp/src/tools/research/conflictDetector.ts:104`
  - `packages/hep-mcp/src/tools/research/conflictDetector.ts:221`
  - `packages/hep-mcp/src/tools/research/conflictDetector.ts:234`
  - `packages/hep-mcp/src/tools/research/conflictDetector.ts:237`
- Current approach:
  - `QUANTITY_SYNONYMS` + `normalizeQuantity()` using substring checks.
  - Fixed hard/soft sigma threshold conflict typing.
- Problem:
  - Wrong quantity grouping contaminates tension computations and conflict labels.
- Recommendation:
  - First perform LLM semantic alignment of compared measurements, then apply deterministic statistical thresholding.
- Severity: **High**

### 4) Assumption extraction/challenge detection uses keyword buckets

- Location:
  - `packages/hep-mcp/src/tools/research/assumptionTracker.ts:91`
  - `packages/hep-mcp/src/tools/research/assumptionTracker.ts:102`
  - `packages/hep-mcp/src/tools/research/assumptionTracker.ts:112`
  - `packages/hep-mcp/src/tools/research/assumptionTracker.ts:121`
  - `packages/hep-mcp/src/tools/research/assumptionTracker.ts:129`
  - `packages/hep-mcp/src/tools/research/assumptionTracker.ts:161`
  - `packages/hep-mcp/src/tools/research/assumptionTracker.ts:206`
  - `packages/hep-mcp/src/tools/research/assumptionTracker.ts:238`
- Current approach:
  - Explicit/implicit assumption keywords; challenge/validation keyword queries.
- Problem:
  - Implicit assumptions, negation scope, and rhetorical phrasing are often missed.
- Recommendation:
  - LLM assumption graph extraction (claim-assumption-challenge links), with deterministic schema validation.
- Severity: **High**

### 5) Review type and authority estimation by keyword scoring

- Location:
  - `packages/hep-mcp/src/tools/research/reviewClassifier.ts:78`
  - `packages/hep-mcp/src/tools/research/reviewClassifier.ts:97`
  - `packages/hep-mcp/src/tools/research/reviewClassifier.ts:106`
  - `packages/hep-mcp/src/tools/research/reviewClassifier.ts:135`
  - `packages/hep-mcp/src/tools/research/reviewClassifier.ts:314`
- Current approach:
  - Keyword sets (`CONSENSUS/CRITICAL/CATALOG`) + weighted scoring and rule-based confidence.
- Problem:
  - Style-sensitive; semantic intent can diverge from lexical cues.
- Recommendation:
  - LLM semantic classification with confidence calibration; metadata priors as deterministic features.
- Severity: **High**

### 6) Paper type -> question template selection is lexical

- Location:
  - `packages/hep-mcp/src/tools/research/criticalQuestions.ts:88`
  - `packages/hep-mcp/src/tools/research/criticalQuestions.ts:119`
  - `packages/hep-mcp/src/tools/research/criticalQuestions.ts:292`
  - `packages/hep-mcp/src/tools/research/criticalQuestions.ts:305`
  - `packages/hep-mcp/src/tools/research/criticalQuestions.ts:585`
- Current approach:
  - `PAPER_TYPE_KEYWORDS` and fixed `QUESTION_TEMPLATES`.
- Problem:
  - Multi-contribution papers are flattened into one type; generated questions can mismatch actual contribution.
- Recommendation:
  - LLM contribution decomposition first, then question generation.
- Severity: **High**

### 7) Stance detection heavily rule-driven

- Location:
  - `packages/hep-mcp/src/tools/research/stance/patterns.ts:15`
  - `packages/hep-mcp/src/tools/research/stance/patterns.ts:111`
  - `packages/hep-mcp/src/tools/research/stance/analyzer.ts:214`
  - `packages/hep-mcp/src/tools/research/stance/analyzer.ts:307`
  - `packages/hep-mcp/src/tools/research/stance/analyzer.ts:367`
- Current approach:
  - Large regex pattern catalog + weight rules + negation handling + review threshold.
- Problem:
  - Rule interaction complexity; brittle for long/implicit/cross-sentence argumentation.
- Recommendation:
  - LLM-first stance adjudicator with schema-constrained output and explicit confidence.
  - Regex patterns should be **prefilter/signals only** (not the decision authority); low-confidence / LLM-failure cases should fail-closed or route to human review (depending on consumer).
- Severity: **Critical**

### 8) Evidence grading pipeline is keyword/regex driven

- Location:
  - `packages/hep-mcp/src/tools/research/evidenceGrading.ts:87`
  - `packages/hep-mcp/src/tools/research/evidenceGrading.ts:105`
  - `packages/hep-mcp/src/tools/research/evidenceGrading.ts:113`
  - `packages/hep-mcp/src/tools/research/evidenceGrading.ts:120`
  - `packages/hep-mcp/src/tools/research/evidenceGrading.ts:192`
  - `packages/hep-mcp/src/tools/research/evidenceGrading.ts:291`
  - `packages/hep-mcp/src/tools/research/config.ts:876` (imports stance/negation lexicon)
- Current approach:
  - Claim extraction by sentence split + `CLAIM_KEYWORDS.some(includes)`
  - Evidence level classification via `SIGMA_PATTERNS` + `THEORETICAL_KEYWORDS` + `HINT_KEYWORDS`
  - Citation stance by pattern-match (`DEFAULT_STANCE_DETECTION`) + local negation window
  - Overall confidence/reliability via fixed additive heuristics ("magic numbers")
- Problem:
  - Negation and scope can invert meaning (e.g., “we do not find evidence …” still hits `find`/`evidence` keywords).
  - Claim boundaries and stance are discourse-level; sentence-local keyword checks systematically miss implicit/hedged cases.
  - Duplicates stance logic with the standalone stance engine, risking divergence and inconsistent semantics.
- Recommendation:
  - LLM-first claim extraction + evidence-level + stance adjudication with strict JSON schema (`claim`, `stance`, `evidence_level`, `confidence`, `rationale`, `alternatives`).
  - Keep deterministic sigma extraction and unit/schema validation as post-guards; define explicit fail-closed behavior for gate consumers.
- Severity: **Critical**

### 9) Theoretical conflict signal extraction is lexical/regex

- Location:
  - `packages/hep-mcp/src/tools/research/theoreticalConflicts.ts:243`
  - `packages/hep-mcp/src/tools/research/theoreticalConflicts.ts:254`
  - `packages/hep-mcp/src/tools/research/theoreticalConflicts.ts:356`
  - `packages/hep-mcp/src/tools/research/theoreticalConflict/lexicon.ts:14`
  - `packages/hep-mcp/src/tools/research/theoreticalConflict/lexicon.ts:216`
- Current approach:
  - Trigger regex + polarity guess + static position lexicon.
- Problem:
  - Deep contradiction is often discourse-level, not keyword-level.
- Recommendation:
  - LLM claim-pair contradiction adjudication with explicit rationale; keep lexical triggers as retrieval prefilter.
- Severity: **High**

### 10) Evidence retrieval in core is lexical term overlap

- Location:
  - `packages/hep-mcp/src/core/evidence.ts:887`
  - `packages/hep-mcp/src/core/evidence.ts:905`
  - `packages/hep-mcp/src/core/evidence.ts:939`
  - `packages/hep-mcp/src/core/evidence.ts:940`
- Current approach:
  - `scoreMatch(normalized.includes(term))` ranking.
- Problem:
  - Strongly limited on paraphrase/implicit relevance; quality loss in evidence recall precision.
- Recommendation:
  - Default to semantic retrieval + rerank; lexical kept for fallback.
- Severity: **High**

### 11) Writing evidence “semantic” path still hashing lexical tokens + fixed priors

- Location:
  - `packages/hep-mcp/src/core/writing/evidence.ts:114`
  - `packages/hep-mcp/src/core/writing/evidence.ts:133`
  - `packages/hep-mcp/src/core/writing/evidence.ts:186`
  - `packages/hep-mcp/src/core/writing/evidence.ts:207`
  - `packages/hep-mcp/src/core/writing/evidence.ts:860`
- Current approach:
  - Hashing sparse vectors from tokenized text; fixed type weights for importance scoring.
- Problem:
  - Lexical similarity remains dominant; fixed salience priors not task-aware.
- Recommendation:
  - Add LLM-based salience and entailment-aware reranking for writing-stage evidence selection.
- Severity: **Medium-High**

### 12) Team convergence gates parse prose verdicts by regex/format contracts

- Location:
  - `skills/research-team/scripts/gates/check_team_convergence.py:92`
  - `skills/research-team/scripts/gates/check_team_convergence.py:110`
  - `skills/research-team/scripts/gates/check_team_convergence.py:177`
  - `skills/research-team/scripts/gates/check_team_convergence.py:347`
  - `skills/research-team/scripts/gates/check_draft_convergence.py:55`
  - `skills/research-team/scripts/gates/check_draft_convergence.py:162`
  - `skills/research-team/scripts/gates/check_draft_convergence.py:312`
- Current approach:
  - Parse `Verdict`, `Blocking issues count`, `Step verdict` text and list counts.
- Problem:
  - Semantics coupled to formatting; wording drift can cause false non-convergence.
- Recommendation:
  - Gate on structured JSON fields only; keep markdown parsing for display diagnostics.
- Severity: **High**

### 13) Draft packet focus and risk highlighting rely on keyword/score heuristics

- Location:
  - `skills/research-team/scripts/bin/build_draft_packet.py:83`
  - `skills/research-team/scripts/bin/build_draft_packet.py:92`
  - `skills/research-team/scripts/bin/build_draft_packet.py:162`
  - `skills/research-team/scripts/bin/build_draft_packet.py:167`
  - `skills/research-team/scripts/bin/build_draft_packet.py:320`
- Current approach:
  - Regex patterns for provenance/uncertainty risk + section scoring by keyword and structural density.
- Problem:
  - Can miss high-risk claims with atypical wording; can over-highlight lexical false positives.
- Recommendation:
  - LLM-based packet curation and risk ranking with deterministic caps/format output.
- Severity: **Medium-High**

### 14) Writer evidence gate is keyword+anchor pattern matching

- Location:
  - `skills/research-writer/scripts/bin/check_latex_evidence_gate.py:101`
  - `skills/research-writer/scripts/bin/check_latex_evidence_gate.py:193`
  - `skills/research-writer/scripts/bin/check_latex_evidence_gate.py:203`
  - `skills/research-writer/scripts/bin/check_latex_evidence_gate.py:224`
- Current approach:
  - Risky keyword regex + locator/citation/path-like anchor heuristic.
- Problem:
  - Anchor presence is not semantic support; potential false pass/false fail.
- Recommendation:
  - LLM claim-to-evidence entailment gate (fail-closed), with regex as prefilter.
- Severity: **High**

### 15) Discussion distillation/tagging uses static keyword taxonomy

- Location:
  - `skills/research-writer/scripts/bin/distill_discussion_logic.py:19`
  - `skills/research-writer/scripts/bin/distill_discussion_logic.py:118`
  - `skills/research-writer/scripts/bin/distill_discussion_logic.py:244`
- Current approach:
  - `_TAG_RULES` keyword matching into consensus/disagreement tags.
- Problem:
  - Fragile to paraphrase and context polarity.
- Recommendation:
  - LLM semantic tagger + schema-constrained outputs.
- Severity: **Medium**

### 16) Discussion logic learner uses keyword-selected diagnostics sections

- Location:
  - `skills/research-writer/scripts/bin/research_writer_learn_discussion_logic.py:336`
  - `skills/research-writer/scripts/bin/research_writer_learn_discussion_logic.py:359`
  - `skills/research-writer/scripts/bin/research_writer_learn_discussion_logic.py:367`
- Current approach:
  - Keyword hit counts and simple scoring for uncertainty/diagnostic paragraph selection.
- Problem:
  - Important semantic content can be missed if lexical cues differ.
- Recommendation:
  - Replace with LLM relevance selection over candidate paragraph set.
- Severity: **Medium**

### 17) Information membrane status note (reference pattern)

- Location:
  - `skills/research-team/scripts/lib/information_membrane.py:26`
- Current approach:
  - `MEMBRANE_VERSION = "v2_llm"` (already LLM-based with fail-closed posture).
- Audit note:
  - This is a positive reference pattern and should be reused for other semantic-gate modules.
- Severity: N/A (already migrated in the right direction)

---

## Round 2 Deep-Dive Supplements (Additional Findings)

Round 2 expanded beyond first-pass hotspots and found additional semantic-heuristic zones not listed above.

### A1) Deep analysis section extraction by title keywords

- Location:
  - `packages/hep-mcp/src/tools/research/deepAnalyze.ts:132`
  - `packages/hep-mcp/src/tools/research/deepAnalyze.ts:139`
  - `packages/hep-mcp/src/tools/research/deepAnalyze.ts:150`
  - `packages/hep-mcp/src/tools/research/deepAnalyze.ts:156`
  - `packages/hep-mcp/src/tools/research/deepAnalyze.ts:170`
  - `packages/hep-mcp/src/tools/research/deepAnalyze.ts:180`
- Current approach:
  - `METHODOLOGY/CONCLUSION/RESULTS/DISCUSSION_KEYWORDS` + section title `includes()`.
- Problem:
  - Semantic section intent is inferred from heading wording only.
- Recommendation:
  - Use LLM section role classifier (method/result/discussion/conclusion) over heading+content.
- Severity: **High**

### A2) Synthesis grouping fallback uses hardcoded method terms + includes

- Location:
  - `packages/hep-mcp/src/tools/research/synthesis/grouping.ts:10`
  - `packages/hep-mcp/src/tools/research/synthesis/grouping.ts:33`
  - `packages/hep-mcp/src/tools/research/synthesis/grouping.ts:42`
  - `packages/hep-mcp/src/tools/research/synthesis/grouping.ts:225`
  - `packages/hep-mcp/src/tools/research/synthesis/grouping.ts:230`
- Current approach:
  - Static `METHOD_TERMS` and lexical includes fallback when TF-IDF clusters are weak.
- Problem:
  - Methodological taxonomy cannot keep pace with new terms; mixed-method papers can be misgrouped.
- Recommendation:
  - Add LLM method ontology assignment and allow multi-label grouping.
- Severity: **High**

### A3) Impact grouping uses fixed citation thresholds as semantic significance proxy

- Location:
  - `packages/hep-mcp/src/tools/research/synthesis/grouping.ts:268`
  - `packages/hep-mcp/src/tools/research/synthesis/grouping.ts:269`
  - `packages/hep-mcp/src/tools/research/synthesis/grouping.ts:270`
- Current approach:
  - `seminal >=100`, `important >=20`, `recent <20` thresholds.
- Problem:
  - Field-size/time-window dependent and semantically blunt.
- Recommendation:
  - Use relative percentiles (deterministic) for field/time normalization, and optionally add LLM narrative significance synthesis; avoid fixed global cutoffs.
- Severity: **Medium-High**

### A4) Topic extraction is "top keyword counts" only

- Location:
  - `packages/hep-mcp/src/tools/research/analyzePapers.ts:128`
  - `packages/hep-mcp/src/tools/research/analyzePapers.ts:129`
  - `packages/hep-mcp/src/tools/research/analyzePapers.ts:145`
  - `packages/hep-mcp/src/tools/research/analyzePapers.ts:152`
- Current approach:
  - Count `paper.keywords`, keep top terms, return single topic cluster.
- Problem:
  - Loses latent themes and cross-keyword semantics.
- Recommendation:
  - LLM topic induction over abstracts/claims with structured topic labels.
- Severity: **High**

### A5) Source-tracing confidence is weighted rule score

- Location:
  - `packages/hep-mcp/src/tools/research/traceSource.ts:136`
  - `packages/hep-mcp/src/tools/research/traceSource.ts:147`
  - `packages/hep-mcp/src/tools/research/traceSource.ts:167`
  - `packages/hep-mcp/src/tools/research/traceSource.ts:255`
- Current approach:
  - Additive score with fixed increments (`chainCount`, depth, review flag, older refs, self-citation adjustment).
- Problem:
  - Confidence labels (`original`, `likely_original`) are sensitive to arbitrary score cutoffs.
- Recommendation:
  - LLM-assisted provenance reasoning over citation paths + transparent deterministic priors.
- Severity: **Medium-High**

### A6) Physics validator uses regex claim/exception heuristics

- Location:
  - `packages/hep-mcp/src/tools/research/physicsValidator.ts:137`
  - `packages/hep-mcp/src/tools/research/physicsValidator.ts:144`
  - `packages/hep-mcp/src/tools/research/physicsValidator.ts:325`
  - `packages/hep-mcp/src/tools/research/physicsValidator.ts:332`
  - `packages/hep-mcp/src/tools/research/physicsValidator.ts:386`
  - `packages/hep-mcp/src/tools/research/physicsValidator.ts:444`
  - `packages/hep-mcp/src/tools/research/physicsValidator.ts:532`
- Current approach:
  - Discussion-vs-claim regex, violation patterns, allowed-context patterns.
- Problem:
  - Semantic exception handling is lexical and can fail on nuanced scientific phrasing.
- Recommendation:
  - Keep deterministic safety checks for numeric impossible cases, but move claim-context adjudication to LLM verifier.
- Severity: **High**

### A7) Paper content-type classifier fallback is giant keyword lists

- Location:
  - `packages/hep-mcp/src/tools/research/paperClassifier.ts:41`
  - `packages/hep-mcp/src/tools/research/paperClassifier.ts:153`
  - `packages/hep-mcp/src/tools/research/paperClassifier.ts:297`
  - `packages/hep-mcp/src/tools/research/paperClassifier.ts:555`
  - `packages/hep-mcp/src/tools/research/paperClassifier.ts:567`
- Current approach:
  - Massive experimental/theoretical keyword lists; review/conference heuristic scoring.
- Problem:
  - High maintenance burden; lexical dependence under domain drift.
- Recommendation:
  - Transition to metadata+LLM hybrid classifier with calibration and evaluation set.
- Severity: **High** (borderline critical if it gates downstream extraction/question paths)

### A8) Team report summarization parses headings/lists by regex

- Location:
  - `skills/research-team/scripts/bin/summarize_team_reports.py:31`
  - `skills/research-team/scripts/bin/summarize_team_reports.py:42`
  - `skills/research-team/scripts/bin/summarize_team_reports.py:51`
- Current approach:
  - Fixed heading/list extraction from markdown contract.
- Problem:
  - Not a deep semantic model issue, but brittle when report style drifts.
- Recommendation:
  - Drive this from structured JSON artifacts generated by reviewers.
- Severity: **Medium**

### A9) Key equation identification relies on keyword/section heuristics

- Location:
  - `packages/hep-mcp/src/tools/research/latex/keyEquationIdentifier.ts:52`
  - `packages/hep-mcp/src/tools/research/latex/keyEquationIdentifier.ts:62`
  - `packages/hep-mcp/src/tools/research/latex/keyEquationIdentifier.ts:68`
  - `packages/hep-mcp/src/tools/research/latex/keyEquationIdentifier.ts:150`
  - `packages/hep-mcp/src/tools/research/latex/keyEquationIdentifier.ts:210`
- Current approach:
  - Reference count + key-section prior + `IMPORTANCE_KEYWORDS` proximity + weighted scoring.
- Problem:
  - “Importance” is context- and paper-structure-dependent; keyword boosters miss novel central equations that do not use canonical phrasing.
- Recommendation:
  - Keep reference counts as deterministic signals; add LLM-based equation importance ranking (context-aware) with structured output and explicit confidence.
- Severity: **Medium** (upgrade if used to gate evidence selection)

### A10) Equation semantic classification via a large pattern catalog (ontology/heuristic hybrid)

- Location:
  - `packages/hep-mcp/src/tools/research/latex/equationTypeSignals.ts` (large hand-built catalog)
  - `packages/hep-mcp/src/tools/research/latex/equationExtractor.ts:22` (consumes the catalog)
- Current approach:
  - Large signal/regex dictionaries to classify “physics equation types” and extract related hints.
- Problem:
  - Pattern explosion and notation drift create silent coverage gaps.
  - Conflates a useful deterministic ontology (high-precision matches) with semantic inference (novel/mixed cases).
- Recommendation:
  - Treat catalog hits as **hints** (not ground truth) and add an LLM adjudication/fallback path for ambiguous/novel equations; measure coverage and error modes on a sampled set.
- Severity: **Medium-High**

### A11) Conference → journal matching uses Jaccard title similarity (lexical semantic matching)

- Location:
  - `packages/hep-mcp/src/tools/research/traceToOriginal.ts:74`
  - `packages/hep-mcp/src/tools/research/traceToOriginal.ts:95`
  - `packages/hep-mcp/src/tools/research/traceToOriginal.ts:106`
  - `packages/hep-mcp/src/tools/research/traceToOriginal.ts:175`
- Current approach:
  - Stopword-filtered title keywords + Jaccard similarity + author overlap thresholds.
- Problem:
  - Title paraphrase and author-list drift are common across conference/journal versions; lexical overlap thresholds cause false negatives (and occasional false positives).
- Recommendation:
  - Use semantic matching (embeddings/LLM) over title + abstract + author/venue metadata with deterministic guardrails; return confidence + rationale and avoid using lexical similarity as a hard gate.
- Severity: **High**

### A12) Review detection in survey tool is a minimal title-substring heuristic

- Location:
  - `packages/hep-mcp/src/tools/research/survey.ts:76`
- Current approach:
  - `title.includes('review'|'status'|'overview')`.
- Problem:
  - Misses common review phrasing (“survey”, “progress”, “recent developments”, “state of the art”) and language variation.
- Recommendation:
  - Unify on the shared paper/review classifier (metadata priors + LLM adjudication), and avoid duplicating partial heuristics in multiple modules.
- Severity: **Medium**

### A13) Review filtering in seminal paper detection is heuristic and duplicates other classifiers

- Location:
  - `packages/hep-mcp/src/tools/research/seminalPapers.ts:84`
  - `packages/hep-mcp/src/tools/research/seminalPapers.ts:93`
- Current approach:
  - Title-regex “review signals” + `publication_type.includes('review')` additive scoring.
- Problem:
  - Duplicated, drifting logic across `survey.ts`, `paperClassifier.ts`, and `seminalPapers.ts` creates inconsistent downstream behavior.
- Recommendation:
  - Centralize review/content-type classification and reuse everywhere; use LLM adjudication only for ambiguous cases and validate on a labeled set.
- Severity: **Medium**

### A14) Synthesis narrative extracts “method challenges” by keyword includes

- Location:
  - `packages/hep-mcp/src/tools/research/synthesis/narrative.ts:197`
  - `packages/hep-mcp/src/tools/research/synthesis/narrative.ts:206`
- Current approach:
  - Keyword-triggered extraction from `paper.methodology` text (`includes('systematic'|'uncertainty'|...)`).
- Problem:
  - Challenges are often phrased implicitly; keyword-only extraction misses central difficulties and over-represents repeated lexical cues.
- Recommendation:
  - LLM-based challenge extraction over paragraph context with a small structured taxonomy (challenge type + evidence span + confidence).
- Severity: **Medium**

---

## Round 3 External Review Cross-Checks (Opus / GLM-5 / Kimi K2.5)

External reviewers were asked to critique completeness, severity calibration, and whether recommendations cleanly separate semantic inference from deterministic parsing.

Converged critique (high confidence):

- **Structural gap fixed in this doc:** `evidenceGrading.ts` was listed as critical in the severity summary but previously lacked a dedicated finding section (phantom finding).
- **Missing long-tail semantic heuristics:** key-equation importance, equation-type signal catalog, and conference→journal matching needed explicit coverage.
- **Regex should not be “fallback decision authority”** for meaning-level judgement (especially stance/entailment). Prefer regex as prefilter/signals; low-confidence should fail-closed or route to human review.
- **Acceptance criteria were too vague:** most NEW-SEM items need explicit evaluation sets, baseline measurement, target metrics, and a failure policy (LLM timeout/low-confidence handling + fallback-rate monitoring).
- **Classifier duplication risk:** multiple modules implement partial “is review?” logic (`survey.ts`, `seminalPapers.ts`, `paperClassifier.ts`), which increases drift and inconsistency.

Notable nuance/disagreement to carry forward explicitly:

- `equationTypeSignals.ts` can be viewed as either a brittle semantic heuristic or a useful deterministic domain ontology. Treating it as **high-precision hints + LLM adjudication for ambiguous/novel cases** is the most robust compromise.

---

## Severity Summary (Overall Impact on Final Output Quality)

### Critical

1. Quantity semantic normalization and matching (`measurements.ts`, coupled with extraction/conflict flow)
2. Evidence grading semantic chain (`evidenceGrading.ts`)
3. Rule-based stance engine (`stance/patterns.ts` + `stance/analyzer.ts`)

### High

1. `measurementExtractor.ts` lexical quantity hinting
2. `conflictDetector.ts` lexical quantity harmonization
3. `assumptionTracker.ts` keyword-based assumption/challenge extraction
4. `reviewClassifier.ts` keyword-based review type/authority scoring
5. `criticalQuestions.ts` paper-type keyword to template mapping
6. `paperClassifier.ts` giant keyword fallback for content typing
7. `theoreticalConflicts.ts` trigger/polarity lexicon logic
8. `core/evidence.ts` lexical evidence retrieval ranking
9. team convergence gates parsing prose verdicts (`check_team_convergence.py`, `check_draft_convergence.py`) *(format coupling; not “semantic understanding”, but outcome-critical)*
10. writer evidence gate keyword/anchor checks (`check_latex_evidence_gate.py`)
11. deepAnalyze section role by heading keyword
12. analyzePapers topic extraction by top keyword counts
13. physicsValidator regex claim/exception heuristics
14. synthesis/grouping method fallback keyword matching
15. conference→journal provenance matching by Jaccard similarity (`traceToOriginal.ts`)

### Medium-High

1. writing evidence hashing sparse vector + fixed importance priors (`core/writing/evidence.ts`)
2. build_draft_packet keyword risk/focus scoring
3. traceSource weighted confidence cutoffs
4. citation-threshold significance buckets in synthesis grouping
5. equation-type signal catalog used for physics meta classification (`equationTypeSignals.ts`)

### Medium / Low-Medium

1. writer discussion distillation tag rules
2. team summary markdown heading parser
3. shared-format utilities (normalization/formatters) mostly formatting-layer, not top semantic-risk target
4. key-equation importance scoring keywords/section priors (`keyEquationIdentifier.ts`)
5. minimal “is review?” heuristics duplicated across modules (`survey.ts`, `seminalPapers.ts`)
6. synthesis narrative method-challenge extraction by keyword includes (`synthesis/narrative.ts`)

---

## Recommended REDESIGN_PLAN Items

Proposed items below are intentionally aligned with existing `REDESIGN_PLAN.md` style and can be scheduled as a semantic-quality track.

Acceptance criteria note (actionable, testable requirements):

- Define a strict structured output schema for each semantic module (inputs/outputs).
- Create a small labeled evaluation set (even n=50–200) and record how it was labeled.
- Measure the current heuristic baseline on that set.
- Specify target metrics (and a required delta over baseline) before implementation.
- Define LLM failure policy (timeouts/errors/low-confidence) and whether the consumer is a gate (fail-closed).
- Track and cap fallback rate, latency, and cost; alert if fallback spikes.

1. **NEW-SEM-01: Quantity Semantics Adjudicator**
   - Scope: `core/hep/measurements.ts`, `tools/research/measurementExtractor.ts`, `tools/research/conflictDetector.ts`, `core/hep/compareMeasurements.ts`
   - Goal: Replace lexical quantity normalization with LLM adjudication + deterministic unit/schema guards
   - Acceptance: build a labeled quantity-clustering benchmark (pairs/groups), measure baseline, and reduce wrong-merge/false-split errors with a documented target metric

2. **NEW-SEM-02: Evidence/Claim Semantic Grading V2**
   - Scope: `tools/research/evidenceGrading.ts`
   - Goal: LLM claim extraction + evidence-level + stance with strict JSON schema and fail-closed behavior
   - Acceptance: build a human-labeled claim→evidence→stance set; quantify agreement vs baseline and eliminate systematic negation inversions

3. **NEW-SEM-03: LLM-First Stance Engine**
   - Scope: `tools/research/stance/*`
   - Goal: LLM primary inference with confidence; regex patterns are prefilter/signals only (not the decision authority)
   - Acceptance: build a stance test set (incl. scoped negation + multi-citation contexts), measure baseline, and hit a defined target error-rate and fallback-rate

4. **NEW-SEM-04: Theoretical Conflict Reasoner**
   - Scope: `tools/research/theoreticalConflicts.ts`, `tools/research/theoreticalConflict/*`
   - Goal: claim-pair contradiction adjudication with rationale and confidence calibration
   - Acceptance: build a contradiction/“not comparable” eval set; reduce false hard-conflict flags and require rationale for every hard conflict

5. **NEW-SEM-05: Hybrid Paper/Review/Content Classifier**
   - Scope: `reviewClassifier.ts`, `paperClassifier.ts`, `criticalQuestions.ts`
   - Goal: metadata priors + LLM semantic classification; reduce giant hardcoded keyword dependencies
   - Acceptance: build a labeled paper-type set (mixed/edge cases included) and quantify robustness under terminology drift

6. **NEW-SEM-06: Evidence Retrieval Upgrade (Quality-First Default)**
   - Scope: `core/evidence.ts`, `core/writing/evidence.ts`, `core/evidenceSemantic.ts`
   - Goal: semantic retrieval + rerank as default; lexical path fallback only
   - Acceptance: create a claim→evidence relevance benchmark (P@k/R@k or similar), measure baseline, and set a target threshold; document failure policy and fallback rates

7. **NEW-SEM-07: Structured Gate Semantics (No Prose Parsing as Source of Truth)**
   - Scope: `check_team_convergence.py`, `check_draft_convergence.py`, `summarize_team_reports.py`, `check_latex_evidence_gate.py`
   - Goal: gate decisions read schema-validated JSON, not markdown prose regex parsing
   - Acceptance: migration plan (dual-output → JSON source-of-truth → remove prose parsing) and a regression test proving formatting drift cannot change converge/pass decisions

8. **NEW-SEM-08: Semantic Packet Curation for Review/Writer**
   - Scope: `build_draft_packet.py`, `research_writer_learn_discussion_logic.py`, `distill_discussion_logic.py`
   - Goal: LLM relevance/diagnostic section selection and semantic tagging with deterministic output schema
   - Acceptance: build a “missed critical section” audit set and measure recall/precision vs baseline

9. **NEW-SEM-09: Deep Analysis Section Role Classifier**
   - Scope: `tools/research/deepAnalyze.ts`
   - Goal: replace heading-keyword section role inference with LLM role labeling over heading+content
   - Acceptance: build a section-role labeled set and measure extraction precision/recall vs baseline

10. **NEW-SEM-10: Topic/Method Grouping Semanticizer**
    - Scope: `tools/research/analyzePapers.ts`, `tools/research/synthesis/grouping.ts`, `tools/research/synthesis/narrative.ts`
    - Goal: move from top-keyword and fixed citation thresholds to semantic topic clustering + adaptive significance scoring
    - Acceptance: define topic/method grouping metrics (coherence/stability) and compare against baseline on a fixed paper set

11. **NEW-SEM-11: Key Equation Semantic Importance**
    - Scope: `tools/research/latex/keyEquationIdentifier.ts`, `tools/research/latex/equationTypeSignals.ts`
    - Goal: replace keyword/section-weighted equation importance with context-aware LLM ranking (keep reference-count as a deterministic feature)
    - Acceptance: labeled “key equation” set with top-k accuracy vs baseline

12. **NEW-SEM-12: Paper Version / Provenance Matcher**
    - Scope: `tools/research/traceToOriginal.ts`, `tools/research/survey.ts`, `tools/research/seminalPapers.ts`
    - Goal: semantic matching for conference→journal provenance and centralized review-type detection (remove duplicated partial heuristics)
    - Acceptance: curated matched-pairs dataset with precision/recall targets and explicit “not comparable / unsure” handling

13. **NEW-SEM-13: Synthesis Challenge Extractor**
    - Scope: `tools/research/synthesis/narrative.ts`
    - Goal: LLM-based methodological-challenge extraction with structured taxonomy and confidence
    - Acceptance: manual audit set showing fewer missed challenges vs baseline

Suggested dependency ordering (non-binding but pragmatic):

- P0: NEW-SEM-07 (structured gates) + define eval sets/metrics
- P1: NEW-SEM-01 (quantity) → NEW-SEM-06 (retrieval) → NEW-SEM-02 (grading) → NEW-SEM-03 (stance)
- P2: NEW-SEM-05 (classifier) + NEW-SEM-04 (theoretical conflicts) + NEW-SEM-09/10 (analysis/grouping)
- P3: NEW-SEM-11/12/13 (equations/provenance/synthesis long tail)

---

## Research-Informed Addendum (Latest Literature, 2026-03)

This section summarizes recent research that reinforces (and sharpens) the core recommendation of this audit:

```
[Lexical prefilter/signals] → [LLM adjudication] → [Deterministic post-guards]
```

The key shift in the last ~2 years is that **structured output validity** is increasingly “solved” via constrained decoding / verification, while **semantic correctness** and **calibrated abstention** remain the hard problems. For quality-first systems, that argues for migrating meaning-level decisions to LLMs (with eval + fail-closed policies), rather than “degrading” to simpler heuristics.

### A) Structured outputs: validity is tractable; semantic correctness still dominates failures

- Benchmarks like **JSONSchemaBench** evaluate constrained-decoding approaches on **10K real-world JSON Schemas + the JSON Schema test suite**, and show that even when output validity improves, there are still meaningful tradeoffs in coverage/efficiency/output quality across frameworks. (<https://arxiv.org/abs/2501.10868>)
- **LLMStructBench** highlights a practical pitfall: prompting strategies that increase *structural validity* can increase *semantic errors*, and “the best prompt strategy can matter more than the model choice”. (<https://arxiv.org/abs/2602.14743>)
- Engineering implication for this repo:
  - Every semantic module should have **schema-constrained output** (or strict validation + retry) *and* a separate semantic accuracy eval (not “JSON parse rate” as the main metric).
  - Treat “valid JSON” as a **necessary** condition, never sufficient.

### B) LLM-as-a-judge: scalable but biased; do not use a single judge as gate source-of-truth

- Recent surveys summarize the state of LLM-as-a-judge and emphasize evaluation pitfalls and bias modes. (<https://arxiv.org/abs/2411.15594>)
- Empirical work shows that judge models can be influenced by **superficial cues** (e.g., provenance/recency-like shortcuts) while producing plausible rationales that do not acknowledge the shortcut. (<https://arxiv.org/abs/2509.26072>)
- Cognitive-bias benchmarking suggests that evaluator LLMs are not reliably “neutral arbiters” and can exhibit systematic preference distortions. (<https://arxiv.org/abs/2309.17012>)
- Engineering implication for this repo:
  - Do not let an LLM judge be the sole arbiter for approval gates. If an LLM must judge, use multi-judge (cross-vendor) ensembles, randomize order, log prompts/versions, and calibrate against a small human-labeled set.
  - Prefer deterministic validators wherever a validator can be written (schema checks, citation presence rules, numeric sanity bounds), reserving LLM judgment for irreducibly semantic tasks (entailment/stance/assumptions).

### C) Uncertainty, calibration, abstention: self-reported confidence is not a safety signal

- Work on uncertainty expression shows that instruction-tuned LLMs are often **poor at expressing intrinsic uncertainty in words**. (<https://aclanthology.org/2024.emnlp-main.443/>)
- Calibration research (e.g., **Thermometer**) proposes methods for producing better-calibrated confidence signals across tasks. (<https://arxiv.org/abs/2403.08819>)
- Conformal/abstention work provides statistical tools for **selective generation** (abstain when risk is high) rather than forcing a guess. (e.g., <https://arxiv.org/abs/2306.10193>, <https://arxiv.org/abs/2502.06884>, <https://aclanthology.org/2025.acl-long.934/>)
- Engineering implication for this repo:
  - For any semantic module used by a gate, require an explicit abstention surface (`confidence`, `is_confident`, `alternatives`, `rationale`) and define fail-closed behavior.
  - Treat hedging words (“likely”, “possibly”) as *non-authoritative*; rely on measured calibration/abstention rates on a fixed eval set.

### D) RAG + citations: grounding quality needs dedicated evaluation (not only retrieval metrics)

- Community benchmarks increasingly evaluate not only relevance but also **citation/support** quality (e.g., TREC RAG tracks include citation/support assessments). (<https://trec.nist.gov/data/rag2024.html>)
- ALCE-style datasets and metrics show that even strong systems can lack complete citation support a large fraction of the time on some tasks. (<https://arxiv.org/abs/2305.14627>)
- Engineering implication for this repo:
  - Writer “evidence gates” should be evaluated on **claim→evidence support** (entailment/attribution) in addition to retrieval P@k/R@k.
  - Keyword/anchor heuristics are not a proxy for support; they should be prefilters only.

### E) “Degrade heuristics” vs “rewrite to LLM”: quality-first implies an LLM-first semantic layer

For the modules flagged in this audit, a “simplify heuristics” approach usually reduces *maintainability* only temporarily and reduces *quality* immediately:

- Heuristic catalogs grow without principled coverage guarantees (silent failure under domain drift).
- Many failures are semantic (negation scope, discourse-level entailment, implicit assumptions) and therefore not repairable by more enums/regex.
- Structured generation advances reduce the engineering risk of LLM-first rewrites (validity and schema adherence are increasingly enforceable).

**Recommendation (quality-first):** treat these semantic subsystems as needing an **LLM-first rewrite**, but keep deterministic logic as post-guards and invariants. Prefer incremental migration module-by-module with eval harnesses, rather than a “big bang” rewrite across the whole system.

## LLM vs Deterministic Boundary Principles

When LLM is required (semantic inference):

1. Semantic alignment across paraphrase/notation variation (quantities, titles, claim rephrasings)
2. Context-dependent judgement (importance, stance/hedging/negation scope, implicit assumptions)
3. Open taxonomies (paper type/topic/method categories that drift)
4. Discourse-level contradiction/entailment (cross-sentence, multi-citation arguments)

When deterministic logic is appropriate (post-guards / parsing / safety rails):

1. Syntax/format validation (JSON schema, LaTeX/BibTeX parsing, artifact naming)
2. Numerical/statistical computation once semantics are aligned (z-scores, uncertainty propagation)
3. Protocol normalization (run state, IDs, paths, permissions)
4. Fail-closed guardrails (hard bounds, forbidden patterns, safety policies)

Recommended hybrid pattern:

```
[Lexical prefilter] → [LLM adjudication] → [Deterministic post-guards]
```

- Prefilter narrows candidates (regex/keywords) but should not “decide meaning”.
- LLM returns structured judgments with confidence + rationale + alternatives.
- Post-guards enforce non-negotiable constraints (units/schemas/policies) and define fail-closed behavior.

Recommended failure policy (must be explicit per module):

- If the consumer is a **gate**: any LLM error or low-confidence outcome ⇒ **fail-closed** with clear diagnostics.
- If the consumer is **advisory**: low-confidence ⇒ return “unsure” + alternatives; do not silently delegate meaning-level decisions to brittle regex fallbacks.
- Monitor: error/timeout rate, low-confidence rate, and prefilter→LLM coverage gaps.

---

## Non-target / Borderline Items (Do Not Prioritize for LLM Migration)

The focus scope included `packages/shared/`. A scan suggests it is mostly protocol/format normalization (not meaning-level inference). These items are hardcoded/regex by design and are not core semantic understanding targets:

- `packages/shared/src/run-state.ts:72` legacy status mapping (protocol normalization)
- `packages/shared/src/graph-viz/parse-progress.ts:14` markdown task-board parsing (format parsing)
- `packages/shared/src/utils/textUtils.ts:31`, `packages/shared/src/utils/formatters.ts:5`, `packages/shared/src/utils/mathTitle.ts:11` (normalization/format conversion)

They can be improved for robustness, but they are not the highest-leverage “LLM semantic migration” priorities.

---

## Notes

- This document captures three rounds:
  - Round 1: requested primary scan and recommendations
  - Round 2: deeper supplementary investigation with additional hotspots
  - Round 3: external cross-check reviews and integration
- Information membrane confirms expected migration direction:
  - `skills/research-team/scripts/lib/information_membrane.py:26` is already `v2_llm`.
