# EVO-18: REP Signal Engine -- Detailed Technical Design

> **Date**: 2026-02-21
> **Author**: Opus 4.6
> **Status**: Draft -- pending dual-model review
> **Track**: A (Research Evolution)
> **Dependencies**: EVO-17 (REP SDK / FileTransport), EVO-06 (IntegrityReport), EVO-07 (Reproducibility Pipeline), EVO-11 (Bandit Distributor), EVO-20 (Memory Graph)
> **Porting basis**: Evolver `src/gep/signals.js` (~15K LOC) + `src/gep/selector.js` (~7K LOC)

---

## 1. Overview

EVO-18 provides the signal extraction and strategy selection layer for research evolution in Track A. It consumes the ResearchEvent stream (produced by EVO-17 FileTransport), detects actionable research signals, deduplicates and aggregates them, detects stagnation, and selects the appropriate research strategy in response.

The design ports core algorithms from two Evolver modules:
- **`signals.js`**: Signal extraction, fingerprint-based deduplication, stagnation detection (consecutiveEmptyCycles)
- **`selector.js`**: Signal-to-strategy mapping, weighted scoring pipeline, strategy selection

All GEP software-engineering concepts (Gene, Capsule, error patterns, test commands) are replaced with research-domain equivalents (ResearchStrategy, ResearchOutcome, knowledge gaps, scientific verification).

### 1.1 Design Principles

1. **Event-driven**: All signals are derived from the ResearchEvent stream. No polling, no side-channel data.
2. **Deterministic dedup**: Fingerprint-based deduplication ensures the same underlying phenomenon does not produce duplicate signals, regardless of how many events report it.
3. **Adaptive strategy**: Strategy selection responds to the current signal landscape, not just the most recent event.
4. **Separation of concerns**: The Signal Engine selects strategy TYPE; the EVO-11 Bandit selects specific OPERATOR/BACKEND within that type.
5. **Cross-cycle memory**: Signal frequencies and strategy effectiveness persist across runs via EVO-20 Memory Graph.

### 1.2 MIT Attribution

Core deduplication and stagnation detection algorithms ported from:
```
Evolver (https://github.com/autogame-17/evolver)
Copyright (c) AutoGame Limited
Licensed under MIT License
```

---

## 2. Research Signal Type System

### 2.1 Signal Type Enumeration

```typescript
/**
 * All signal types detectable by the REP Signal Engine.
 * Each type has a dedicated detector, payload schema, and default priority.
 */
type ResearchSignalType =
  | "gap_detected"              // knowledge gap found in literature or computation coverage
  | "calculation_divergence"    // two computations disagree beyond tolerance (from EVO-07)
  | "known_result_match"        // result matches known literature value (from EVO-06 novelty_verifier)
  | "integrity_violation"       // integrity check failed (from EVO-06 IntegrityReport)
  | "method_plateau"            // current method not making progress toward goal
  | "parameter_sensitivity"     // result highly sensitive to parameter variation
  | "cross_check_opportunity"   // new result enables cross-checking existing ones
  | "stagnation";               // no meaningful progress for N consecutive cycles
```

### 2.2 Core Signal Interface

> **SSOT Note**: The normative schema for `ResearchSignal` is `schemas/research_signal_v1.schema.json`. TypeScript interfaces in this document are **illustrative** and may include runtime-only fields (e.g., `frequency`) not present in the SSOT schema. When in doubt, the JSON Schema is authoritative.

```typescript
interface ResearchSignal {
  /** Unique identifier for this signal instance. UUID v4. */
  signal_id: string;

  /** Which type of signal this is. */
  signal_type: ResearchSignalType;

  /** Which ResearchEvent(s) triggered this signal detection. */
  source_event_ids: string[];

  /**
   * Deduplication fingerprint.
   * Computed as: SHA-256(signal_type + ":" + distinguishing_key)
   * Two signals with the same fingerprint within the dedup window are merged.
   */
  fingerprint: string;

  /** Confidence in the signal's validity, 0.0 to 1.0. */
  confidence: number;

  /** Priority level for strategy selection weighting. */
  priority: "critical" | "high" | "medium" | "low";

  /** Type-specific payload data. Discriminated by signal_type. */
  payload: SignalPayload;

  /** When this signal was detected. ISO 8601. */
  detected_at: string;

  /**
   * Optional expiry time. After this, the signal is no longer active
   * and will not influence strategy selection.
   * Used for time-sensitive signals like cross_check_opportunity.
   */
  expires_at?: string;

  /** Run identifier for correlation. */
  run_id?: string;

  /** Whether this signal has been suppressed (deduped or manually dismissed). */
  suppressed?: boolean;

  /** Schema version for forward compatibility. */
  schema_version: 1;
}
```

> **Runtime-only field note:** The Aggregator stage (§3.5) tracks per-fingerprint
> `frequency` counts in-memory. This counter is **not** part of the wire schema
> (`additionalProperties: false` in SSOT) and is never serialized into `ResearchSignal`
> objects. It exists only as internal Aggregator state.

### 2.3 Signal Payloads (per type)

Each signal type carries a type-specific payload. The payload is discriminated by `signal_type`.

```typescript
type SignalPayload =
  | GapDetectedPayload
  | CalculationDivergencePayload
  | KnownResultMatchPayload
  | IntegrityViolationPayload
  | MethodPlateauPayload
  | ParameterSensitivityPayload
  | CrossCheckOpportunityPayload
  | StagnationPayload;
```

#### 2.3.1 GapDetectedPayload

```typescript
interface GapDetectedPayload {
  /**
   * Description of the knowledge gap.
   * e.g., "No NLO QCD corrections computed for this process at sqrt(s) = 14 TeV"
   */
  gap_description: string;

  /**
   * Area of the domain where the gap exists.
   * e.g., "NLO corrections", "heavy quark decays", "lattice QCD"
   */
  domain_area: string;

  /**
   * If detected via literature: records from the LiteratureService
   * identifying papers that reference or imply this gap.
   */
  related_literature?: Array<{ record_id: string; source: string }>;

  /**
   * Estimated scientific impact of filling this gap.
   */
  estimated_impact?: "high" | "medium" | "low";

  // --- Runtime-only fields (not in SSOT schema) ---

  /**
   * How the gap was detected (runtime classification, not stored in schema):
   * - "literature_survey": gap found by searching external literature (via LiteratureService)
   * - "computation_coverage": gap in parameter space or perturbative order coverage
   * - "cross_reference": referenced by another paper but no existing computation
   */
  detection_method?: "literature_survey" | "computation_coverage" | "cross_reference";

  /**
   * The distinguishing key used for fingerprint computation.
   * Runtime-only: top-level `fingerprint` = SHA-256(signal_type + ":" + fingerprint_key).
   */
  fingerprint_key?: string;
}
```

#### 2.3.2 CalculationDivergencePayload

```typescript
interface CalculationDivergencePayload {
  /** Reference to the first outcome. */
  outcome_a_ref: string;

  /** Reference to the second outcome. */
  outcome_b_ref: string;

  /** Quantities that diverge beyond tolerance. */
  divergent_quantities: Array<{
    name: string;
    value_a: number;
    value_b: number;
    relative_deviation: number;
  }>;

  /** Reference to the EVO-07 DeviationReport that triggered this signal. */
  deviation_report_ref?: string;

  // --- Runtime-only fields (not in SSOT schema) ---

  /**
   * The re-run method that produced the disagreement.
   * Runtime-only: extracted from DeviationReport's rerun_spec.
   */
  rerun_method?: {
    type: string;
    detail: string;
  };

  /**
   * Classification of the likely cause.
   * Runtime-only: computed by the detector.
   */
  likely_cause?: "numerical" | "methodological" | "error" | "unknown";

  fingerprint_key?: string;
}
```

#### 2.3.3 KnownResultMatchPayload

```typescript
interface KnownResultMatchPayload {
  /** Reference to the ResearchOutcome that matched known literature. */
  outcome_ref: string;

  /**
   * Literature records matching this outcome.
   * Each entry identifies a published result that is similar to our outcome.
   */
  matching_literature: Array<{
    /** Record ID from the LiteratureService. */
    record_id: string;
    /** Which LiteratureService provided this record. */
    source: string;
    /** Title of the matching work. */
    title?: string;
    /** Similarity score (0-1). */
    similarity_score: number;
    /** Specific quantities that matched. */
    matched_quantities?: string[];
  }>;

  // --- Runtime-only fields (not in SSOT schema) ---

  /**
   * Whether this means our result is NOT novel.
   * Runtime-only: computed by the detector.
   */
  novelty_assessment?: "exact_match" | "consistent" | "extends";

  fingerprint_key?: string;
}
```

#### 2.3.4 IntegrityViolationPayload

```typescript
interface IntegrityViolationPayload {
  /** Reference to the EVO-06 IntegrityReport containing the violation. */
  integrity_report_ref: string;

  /** Which check(s) failed. */
  failed_checks: Array<{
    check_id: string;         // e.g., "param_bias_checker", "approx_validator"
    severity: "blocking" | "advisory";
    message?: string;
  }>;

  // --- Runtime-only fields (not in SSOT schema) ---

  /** The artifact that failed the check. Runtime-only. */
  artifact_ref?: string;

  fingerprint_key?: string;
}
```

#### 2.3.5 MethodPlateauPayload

```typescript
interface MethodPlateauPayload {
  /**
   * The method/approach that has plateaued.
   */
  current_method: string;

  /**
   * Number of consecutive cycles without meaningful improvement
   * in the tracked metric(s).
   */
  cycles_without_improvement: number;

  /** Best metric value achieved. */
  best_achieved_metric?: string;

  /** Alternative methods that might break through the plateau. */
  suggested_alternatives?: string[];
}
```

#### 2.3.6 ParameterSensitivityPayload

```typescript
interface ParameterSensitivityPayload {
  /** The parameter that exhibits sensitivity. Maps to schema `parameter_name`. */
  parameter_name: string;

  /**
   * Sensitivity measure: relative change in result per relative change in parameter.
   * Maps to schema `sensitivity_measure`.
   */
  sensitivity_measure: number;

  /** Parameter range over which sensitivity was measured. */
  parameter_range_tested?: { min: number; max: number };

  /** Quantities affected by this parameter. */
  affected_quantities?: string[];

  // --- Runtime-only fields (not in SSOT schema) ---

  /** Detailed per-parameter sensitivity data. Runtime-only. */
  sensitive_parameters?: Array<{
    parameter_name: string;
    log_derivative: number;
    range: { min: number; max: number };
  }>;

  sensitivity_grade?: "extreme" | "high" | "moderate";

  fingerprint_key?: string;
}
```

#### 2.3.7 CrossCheckOpportunityPayload

```typescript
interface CrossCheckOpportunityPayload {
  /** The new result that enables cross-checking. Maps to schema `new_outcome_ref`. */
  new_outcome_ref: string;

  /** Existing results that can now be cross-checked against the new one. Maps to schema `existing_outcome_refs`. */
  existing_outcome_refs: string[];

  /** Type of cross-check. Domain Pack defines available types. */
  cross_check_type?: string;

  // --- Runtime-only fields (not in SSOT schema) ---

  /** Detailed cross-checkable result info. Runtime-only. */
  crosscheckable_results?: Array<{
    result_ref: string;
    quantity_name: string;
    cross_check_type: string;
    expected_relation: string;
  }>;

  fingerprint_key?: string;
}
```

#### 2.3.8 StagnationPayload

```typescript
interface StagnationPayload {
  /** Number of consecutive empty (no-signal, no-progress) cycles. */
  consecutive_empty_cycles: number;

  /** Threshold that was exceeded to trigger this signal. */
  threshold: number;

  /** The strategy that was active during the stagnant period. */
  current_strategy?: string;

  /** Last time a productive cycle occurred. */
  last_productive_cycle?: string;  // ISO 8601

  /**
   * Suggested action:
   * - "switch_strategy": try a different research strategy
   * - "abandon_direction": the current research direction may be unproductive
   * - "request_guidance": the system cannot determine a productive path
   */
  recommended_action?: "switch_strategy" | "abandon_direction" | "request_guidance";

  // --- Runtime-only fields (not in SSOT schema) ---

  fingerprint_key?: string;
}
```

### 2.4 Default Priority and Confidence Mapping

| Signal Type | Default Priority | Default Confidence | Rationale |
|---|---|---|---|
| `integrity_violation` | critical | 0.95 | Integrity failures demand immediate attention |
| `calculation_divergence` | high | 0.85 | Disagreements must be resolved but may have benign causes |
| `stagnation` | high | 0.90 | Clear evidence of lack of progress |
| `method_plateau` | medium | 0.70 | Requires metric analysis, may be temporary |
| `gap_detected` | medium | 0.60 | Gaps may be intentional or out of scope |
| `known_result_match` | medium | 0.80 | Match confidence depends on comparison precision |
| `parameter_sensitivity` | medium | 0.75 | Sensitivity may be physical (not an error) |
| `cross_check_opportunity` | low | 0.65 | Opportunity, not urgency |

Detectors may override these defaults based on evidence strength.

---

## 3. Signal Extraction Pipeline

### 3.1 Pipeline Architecture

```
Input: ResearchEvent stream (JSONL from EVO-17 FileTransport)
  |
  v
[Stage 1: Event Filter]
  Filter events by type. Only pass events relevant to signal detection.
  |
  v
[Stage 2: Signal Detector]
  One detector per signal type. Pattern-match on filtered events.
  Output: raw (undeduped) signals.
  |
  v
[Stage 3: Dedup Engine]
  Fingerprint-based deduplication within a configurable time window.
  Same fingerprint within window -> merge, don't create new signal.
  (Ported from Evolver signals.js)
  |
  v
[Stage 4: Aggregator]
  Merge related signals, update frequency counts per signal type per window.
  |
  v
[Stage 5: Stagnation Detector]
  Track consecutive cycles with no meaningful signals.
  If threshold exceeded -> emit "stagnation" signal.
  (Ported from Evolver signals.js consecutiveEmptyCycles)
  |
  v
Output: ResearchSignal[]
```

### 3.2 Stage 1: Event Filter

The Event Filter routes incoming ResearchEvent objects to the appropriate signal detectors based on event type.

```typescript
/**
 * Maps ResearchEvent types (from SSOT research_event_v1.schema.json `event_type` enum)
 * to the signal detectors they can trigger.
 * An event type may trigger multiple detectors.
 *
 * NOTE: Only SSOT event types are used here. Domain Packs may register additional
 * event→detector mappings via the Domain Pack extension mechanism.
 */
const EVENT_DETECTOR_MAP: Record<string, ResearchSignalType[]> = {
  // Computation lifecycle events
  "computation_completed":     ["cross_check_opportunity", "parameter_sensitivity"],
  "computation_failed":        ["method_plateau"],

  // Verification events (from EVO-07 reproducibility pipeline)
  "verification_failed":       ["calculation_divergence"],

  // Integrity events (from EVO-06 integrity framework)
  "integrity_check_completed": ["integrity_violation", "known_result_match"],

  // Strategy lifecycle events
  "strategy_rejected":         ["method_plateau"],

  // Outcome lifecycle events
  "outcome_published":         ["cross_check_opportunity"],
};

// Future subsystems (literature search, parameter scan) will add event types to the
// SSOT event_type enum and register their detector mappings here. For example:
//   "literature_search_completed": ["gap_detected", "known_result_match"],
//   "parameter_scan_completed":    ["parameter_sensitivity"],

function filterEvents(event: ResearchEvent): ResearchSignalType[] {
  return EVENT_DETECTOR_MAP[event.event_type] ?? [];
}
```

Events not listed in the map are silently dropped. This is intentional: not every event is signal-relevant. The `gap_detected` signal type has no triggering event in the current SSOT; it will be activated when the literature search subsystem is designed and adds its event types.

> **Note on stagnation**: The `stagnation` signal is **not** generated by Stage 2 event-driven detectors. It is produced exclusively by the Stage 5 Stagnation Detector (§3.6), which operates on aggregate cycle-level data (consecutive empty cycles) rather than individual events. This is why `stagnation` does not appear in `EVENT_DETECTOR_MAP`.

### 3.3 Stage 2: Signal Detectors

Each signal type has a dedicated detector function. The detector receives a ResearchEvent and returns zero or one **signal candidate** — a partial object containing `signal_type`, `confidence`, `priority`, and `payload`. The pipeline wrapper completes each candidate into a full SSOT-compliant `ResearchSignal` by adding the required top-level fields:

- `signal_id` — UUID v4, generated by the pipeline
- `schema_version` — `1`
- `source_event_ids` — `[event.event_id]` from the triggering event
- `fingerprint` — `SHA-256(signal_type + ":" + fingerprint_key)`, computed by pipeline wrapper before passing to Stage 3 Dedup
- `detected_at` — ISO 8601 UTC Z timestamp at detection time

The pipeline wrapper converts each `SignalCandidate` into a full SSOT-compliant `ResearchSignal` **before** passing it to Stage 3 (Dedup). Stage 3 receives only `ResearchSignal` objects.

```typescript
// Partial signal returned by detector functions (not yet a full ResearchSignal)
type SignalCandidate = Pick<ResearchSignal, "signal_type" | "confidence" | "priority" | "payload"> & {
  fingerprint_key?: string;  // detector-provided key for dedup fingerprinting
  expires_at?: string;
};
```

#### 3.3.1 gap_detected Detector

> **Note**: The `gap_detected` signal currently has no triggering SSOT event type. It will be activated
> when the literature search subsystem adds `literature_search_completed` (and optionally
> `literature_gap_identified`) to the `research_event_v1.schema.json` event_type enum.
> The pseudocode below shows the intended detection logic for that future integration.

```
detector_gap_detected(event: ResearchEvent): SignalCandidate | null {
  // "gap_detected" requires a future "literature_search_completed" event type
  // not yet in the SSOT research_event_v1.schema.json event_type enum.
  // This detector is a true no-op until the literature search subsystem is designed
  // and its event types are added to the SSOT.
  //
  // Future implementation (when "literature_search_completed" is in SSOT):
  //   if (event.event_type == "literature_search_completed") {
  //     results = event.payload.search_results
  //     query = event.payload.query
  //     if (results.length == 0 || all results are only tangentially related) {
  //       return { signal_type: "gap_detected", ... }
  //     }
  //   }

  return null
}
```

#### 3.3.2 calculation_divergence Detector

```
detector_calculation_divergence(event: ResearchEvent): SignalCandidate | null {
  if (event.event_type != "verification_failed") return null

  // Dereference the reproducibility report via the payload's deviation_report_ref
  report = resolve(event.payload.deviation_report_ref)  // → ReproducibilityReport
  if (report.overall_agreement == "agree") return null

  failing = report.quantities.filter(q => !q.within_tolerance)
  if (failing.length == 0) return null

  max_dev = max(failing.map(q => q.relative_deviation))

  // Build SSOT-compliant CalculationDivergencePayload
  // Required fields: outcome_a_ref, outcome_b_ref, divergent_quantities
  return {
    signal_type: "calculation_divergence",
    confidence: min(0.95, 0.7 + 0.1 * log10(max_dev / 1e-6)),
    priority: max_dev > 0.1 ? "critical" : "high",
    fingerprint_key: report.original_ref.uri + ":" + report.rerun_ref.uri,
    payload: {
      outcome_a_ref: report.original_ref.uri,
      outcome_b_ref: report.rerun_ref.uri,
      divergent_quantities: failing.map(q => ({
        name: q.quantity_name,
        value_a: q.original_value.central,
        value_b: q.rerun_value.central,
        relative_deviation: q.relative_deviation
      }))
    }
  }
}
```

#### 3.3.3 known_result_match Detector

```
detector_known_result_match(event: ResearchEvent): SignalCandidate | null {
  if (event.event_type != "integrity_check_completed") return null

  // SSOT IntegrityCheckCompletedPayload: { report_id, overall_status, ... }
  summary = event.payload

  // Dereference the full IntegrityReport to find novelty check results
  report = resolve(summary.report_id)  // → IntegrityReport
  novelty_checks = report.checks.filter(c => c.check_id.endsWith("novelty_verifier"))
  if (novelty_checks.length == 0) return null

  for each check in novelty_checks {
    if (check.status != "advisory" || !check.evidence) continue

    // Extract literature matches from check evidence
    lit_evidence = check.evidence.filter(e => e.type == "reference" && e.data?.match_found)
    if (lit_evidence.length == 0) continue

    matches = lit_evidence.flatMap(e => e.data.matches ?? [])
    if (matches.length == 0) continue

    // Build the outcome_ref from the report's target
    outcome_ref = report.target_ref.uri

    return {
      signal_type: "known_result_match",
      confidence: min(0.95, 0.5 + 0.5 * matches[0].similarity_score),
      priority: matches[0].similarity_score > 0.95 ? "high" : "medium",
      fingerprint_key: outcome_ref + ":" + matches[0].record_id,
      payload: {
        // SSOT: KnownResultMatchPayload (research_signal_v1.schema.json)
        outcome_ref: outcome_ref,
        matching_literature: matches.map(m => ({
          record_id: m.record_id,
          source: m.source,
          title: m.title,
          similarity_score: m.similarity_score,
          matched_quantities: m.matched_quantities
        }))
      }
    }
  }

  return null
}
```

#### 3.3.4 integrity_violation Detector

```
detector_integrity_violation(event: ResearchEvent): SignalCandidate | null {
  if (event.event_type != "integrity_check_completed") return null

  // SSOT IntegrityCheckCompletedPayload provides summary only: report_id, overall_status
  summary = event.payload
  if (summary.overall_status == "pass") return null

  // Dereference the full IntegrityReport via report_id to get check details
  report = resolve(summary.report_id)  // → IntegrityReport
  failed_checks = report.checks.filter(r => r.severity == "blocking" || r.severity == "advisory")
  if (failed_checks.length == 0) return null

  has_blocking = failed_checks.some(r => r.severity == "blocking")

  // Build SSOT-compliant IntegrityViolationPayload
  // Required fields: integrity_report_ref, failed_checks
  return {
    signal_type: "integrity_violation",
    confidence: 0.95,
    priority: has_blocking ? "critical" : "high",
    fingerprint_key: summary.report_id,
    payload: {
      integrity_report_ref: summary.report_id,
      failed_checks: failed_checks.map(f => ({
        check_id: f.check_id,
        severity: f.severity == "blocking" ? "blocking" : "advisory",
        message: f.message
      }))
    }
  }
}
```

#### 3.3.5 method_plateau Detector

```
detector_method_plateau(event: ResearchEvent): SignalCandidate | null {
  if (event.event_type == "strategy_rejected") {
    // SSOT StrategyRejectedPayload: { strategy_id, reason }
    // Plateau detection uses historical metric data keyed by strategy_id
    strategy_id = event.payload.strategy_id
    history = get_metric_history(strategy_id, window=10)  // last 10 cycles from local store

    if (history.length < 3) return null  // not enough data

    // Group by metric name and check for plateau
    metric_names = unique(history.map(h => h.metric_name))
    for each metric_name in metric_names {
      recent_values = history.filter(h => h.metric_name == metric_name).map(h => h.value)
      if (recent_values.length < 3) continue

      // Check if recent values show no improvement
      improvement_threshold = 0.01  // 1% improvement considered meaningful
      improvements = []
      for i in 1..recent_values.length {
        improvement = (recent_values[i] - recent_values[i-1]) / |recent_values[i-1]|
        improvements.push(improvement)
      }

      // Plateau = all recent improvements below threshold
      consecutive_flat = count_trailing(improvements, v => |v| < improvement_threshold)
      if (consecutive_flat >= 3) {
        fingerprint_key = strategy_id + ":" + metric_name

        return {
          signal_type: "method_plateau",
          confidence: min(0.9, 0.5 + 0.1 * consecutive_flat),
          priority: "medium",
          fingerprint_key,
          payload: {
            // SSOT: MethodPlateauPayload (research_signal_v1.schema.json)
            current_method: strategy_id,
            cycles_without_improvement: consecutive_flat,
            best_achieved_metric: metric_name + "=" + String(max(recent_values)),
            suggested_alternatives: []  // populated by downstream strategy selector
          }
        }
      }
    }
  }

  if (event.event_type == "computation_failed") {
    // SSOT ComputationFailedPayload: { computation_id, error, partial_results }
    // Repeated failures of the same computation_id prefix indicate a plateau
    failure_count = count_recent_failures(event.payload.computation_id, window=5)
    if (failure_count >= 3) {
      fingerprint_key = "failure_plateau:" + event.payload.computation_id

      return {
        signal_type: "method_plateau",
        confidence: 0.8,
        priority: "high",
        fingerprint_key,
        payload: {
          // SSOT: MethodPlateauPayload (research_signal_v1.schema.json)
          current_method: event.payload.computation_id,
          cycles_without_improvement: failure_count,
          best_achieved_metric: undefined,  // no metric data for failure-based plateau
          suggested_alternatives: []
        }
      }
    }
  }

  return null
}
```

#### 3.3.6 parameter_sensitivity Detector

```
detector_parameter_sensitivity(event: ResearchEvent): SignalCandidate | null {
  // SSOT ComputationCompletedPayload: { computation_id, artifact_ref, metrics_summary?, duration_ms? }
  // Parameter scan data is retrieved from the artifact via artifact_ref, not from the event payload directly.
  if (event.event_type != "computation_completed") return null

  // Fetch scan data from the computation artifact (stored externally)
  scan_data = load_artifact(event.payload.artifact_ref)
  if (!scan_data || !scan_data.scan_results) return null  // not a parameter scan computation

  sensitive_params = []

  for each param in scan_data.varied_parameters {
    values = scan_data.results.map(r => r.parameters[param.name])
    quantities = scan_data.results.map(r => r.quantities[scan_data.target_quantity])

    // Compute log-derivative: d(log Q) / d(log p)
    log_deriv = compute_log_derivative(values, quantities)

    if (|log_deriv| > 1.0) {
      grade = "moderate"
      if (|log_deriv| > 2.0) grade = "high"
      if (|log_deriv| > 10.0) grade = "extreme"

      sensitive_params.push({
        parameter_name: param.name,
        log_derivative: log_deriv,
        range: { min: min(values), max: max(values) }
      })
    }
  }

  if (sensitive_params.length == 0) return null

  max_grade = max_by(sensitive_params, p => |p.log_derivative|)
  overall_grade = |max_grade.log_derivative| > 10 ? "extreme"
                : |max_grade.log_derivative| > 2  ? "high"
                : "moderate"

  fingerprint_key = scan_data.target_quantity + ":"
                  + sensitive_params.map(p => p.parameter_name).sort().join(",")

  return {
    signal_type: "parameter_sensitivity",
    confidence: min(0.9, 0.6 + 0.1 * sensitive_params.length),
    priority: overall_grade == "extreme" ? "high" : "medium",
    fingerprint_key,
    payload: {
      // SSOT: ParameterSensitivityPayload (research_signal_v1.schema.json)
      parameter_name: max_grade.parameter_name,
      sensitivity_measure: max_grade.log_derivative,
      parameter_range_tested: { min: min(max_grade.range.min), max: max(max_grade.range.max) },
      affected_quantities: [scan_data.target_quantity]
    }
  }
}
```

#### 3.3.7 cross_check_opportunity Detector

```
detector_cross_check_opportunity(event: ResearchEvent): SignalCandidate | null {
  // SSOT ComputationCompletedPayload: { computation_id, artifact_ref, metrics_summary?, duration_ms? }
  // SSOT OutcomePublishedPayload: { outcome_id, strategy_ref, rdi_rank_score? }
  if (event.event_type != "computation_completed"
   && event.event_type != "outcome_published") return null

  // Derive a stable ref from SSOT wire fields
  new_ref = event.event_type == "outcome_published"
    ? event.payload.outcome_id
    : event.payload.computation_id

  // Retrieve strategy context to find related results for cross-checking
  strategy_ref = event.event_type == "outcome_published"
    ? event.payload.strategy_ref
    : lookup_strategy_ref(event.payload.computation_id)  // local index

  existing_results = query_related_outcomes(strategy_ref)

  opportunities = []

  for each existing in existing_results {
    // Check cross-validation opportunities (Domain Pack defines check types)
    // HEP example: Ward identity check between related Green's functions
    if (can_form_ward_identity(new_ref, existing)) {
      opportunities.push({
        result_ref: existing.outcome_id,
        quantity_name: existing.quantity_name,
        cross_check_type: "Ward identity",  // HEP Domain Pack cross-check type
        expected_relation: describe_ward_relation(new_ref, existing)
      })
    }

    // Check known-limit opportunities
    if (is_limiting_case(new_ref, existing) || is_limiting_case(existing, new_ref)) {
      opportunities.push({
        result_ref: existing.outcome_id,
        quantity_name: existing.quantity_name,
        cross_check_type: "known limit",
        expected_relation: describe_limit_relation(new_ref, existing)
      })
    }

    // Check sum-rule opportunities
    if (can_form_sum_rule(new_ref, existing)) {
      opportunities.push({
        result_ref: existing.outcome_id,
        quantity_name: existing.quantity_name,
        cross_check_type: "sum rule",
        expected_relation: describe_sum_rule(new_ref, existing)
      })
    }
  }

  if (opportunities.length == 0) return null

  fingerprint_key = new_ref + ":" + opportunities.map(o => o.result_ref).sort().join(",")

  return {
    signal_type: "cross_check_opportunity",
    confidence: 0.65,
    priority: "low",
    fingerprint_key,
    payload: {
      // SSOT: CrossCheckOpportunityPayload (research_signal_v1.schema.json)
      new_outcome_ref: new_ref,
      existing_outcome_refs: opportunities.map(o => o.result_ref),
      cross_check_type: opportunities[0].cross_check_type  // primary type
    },
    expires_at: iso8601(now() + 7 * 24 * 3600)  // expires in 7 days
  }
}
```

### 3.4 Stage 3: Dedup Engine

Ported from Evolver `signals.js` deduplication logic.

The Dedup Engine prevents the same underlying phenomenon from generating multiple active signals. It operates on the `fingerprint` field, which is computed by the pipeline wrapper as:

```
fingerprint = SHA-256(signal_type + ":" + fingerprint_key)
```

If the detector does not provide `fingerprint_key`, the pipeline wrapper falls back to a deterministic default: `SHA-256(signal_type + ":" + JCS(candidate.payload))`, where JCS is RFC 8785 canonical JSON of the payload. This ensures every signal gets a stable, unique fingerprint even when the detector omits `fingerprint_key`.

#### 3.4.1 Dedup Algorithm

```typescript
interface DedupConfig {
  /** Time window for deduplication. Signals with the same fingerprint
   *  within this window are merged. Default: 24 hours. */
  dedup_window_seconds: number;

  /** Maximum number of active fingerprints to track.
   *  LRU eviction when exceeded. Default: 10000. */
  max_tracked_fingerprints: number;
}

// In-memory fingerprint registry
const fingerprint_registry: Map<string, {
  first_seen: string;       // ISO 8601
  last_seen: string;        // ISO 8601
  count: number;            // times this fingerprint appeared
  active_signal_id: string; // the signal ID that represents this fingerprint
}> = new Map();

function dedup(signal: ResearchSignal, config: DedupConfig): ResearchSignal | null {
  const fp = signal.fingerprint;
  const now = Date.now();

  if (fingerprint_registry.has(fp)) {
    const entry = fingerprint_registry.get(fp)!;
    const age_seconds = (now - Date.parse(entry.first_seen)) / 1000;

    if (age_seconds < config.dedup_window_seconds) {
      // Within dedup window: merge into existing signal
      entry.last_seen = signal.detected_at;
      entry.count += 1;

      // Update the existing signal's confidence in Aggregator state
      // (Higher frequency -> higher confidence, capped at 0.99)
      // Note: frequency is tracked only in fingerprint_registry, never on the wire signal
      update_aggregator_state(entry.active_signal_id, {
        confidence: Math.min(0.99, signal.confidence + 0.05 * Math.log2(entry.count))
      });

      return null;  // suppress duplicate
    } else {
      // Outside dedup window: allow as new signal, reset entry
      fingerprint_registry.set(fp, {
        first_seen: signal.detected_at,
        last_seen: signal.detected_at,
        count: 1,
        active_signal_id: signal.signal_id
      });
      return signal;
    }
  } else {
    // New fingerprint: register and pass through
    fingerprint_registry.set(fp, {
      first_seen: signal.detected_at,
      last_seen: signal.detected_at,
      count: 1,
      active_signal_id: signal.signal_id
    });

    // LRU eviction
    if (fingerprint_registry.size > config.max_tracked_fingerprints) {
      evict_oldest(fingerprint_registry);
    }

    return signal;
  }
}
```

#### 3.4.2 Dedup Window Configuration

| Signal Type | Recommended Dedup Window | Rationale |
|---|---|---|
| `integrity_violation` | 1 hour | Critical signals should re-fire quickly if not resolved |
| `calculation_divergence` | 24 hours | Divergences are expensive to investigate; don't flood |
| `gap_detected` | 7 days | Gaps change slowly; weekly re-evaluation sufficient |
| `known_result_match` | 7 days | Literature doesn't change quickly |
| `method_plateau` | 12 hours | Plateaus should be re-evaluated after each strategy cycle |
| `parameter_sensitivity` | 24 hours | Sensitivity is stable unless parameters change |
| `cross_check_opportunity` | 7 days | Opportunities persist but shouldn't repeat |
| `stagnation` | 6 hours | Stagnation needs frequent re-checking |

### 3.5 Stage 4: Aggregator

The Aggregator merges related signals and maintains frequency statistics per signal type within configurable time windows.

```typescript
interface AggregatorState {
  /** Per signal type: frequency count within the current window. */
  type_frequencies: Record<ResearchSignalType, {
    count: number;
    window_start: string;      // ISO 8601
    window_duration_seconds: number;
  }>;

  /** Active signals grouped by type, ordered by priority then confidence. */
  active_signals: Record<ResearchSignalType, ResearchSignal[]>;
}

function aggregate(
  signal: ResearchSignal,
  state: AggregatorState,
  window_duration: number = 86400  // 24 hours
): AggregatorState {
  const type = signal.signal_type;
  const now = Date.now();

  // Initialize type entry if needed
  if (!state.type_frequencies[type]) {
    state.type_frequencies[type] = {
      count: 0,
      window_start: signal.detected_at,
      window_duration_seconds: window_duration
    };
    state.active_signals[type] = [];
  }

  const freq = state.type_frequencies[type];

  // Check if we need to rotate the window
  if ((now - Date.parse(freq.window_start)) / 1000 > freq.window_duration_seconds) {
    // Window expired: write historical count to EVO-20 Memory Graph, reset
    write_to_memory_graph("signal_frequency", {
      signal_type: type,
      count: freq.count,
      window_start: freq.window_start,
      window_end: new Date(now).toISOString()
    });
    freq.count = 0;
    freq.window_start = signal.detected_at;
  }

  // Update frequency
  freq.count += 1;

  // Add to active signals (maintain sorted order: critical > high > medium > low)
  insert_sorted(state.active_signals[type], signal, compare_priority_confidence);

  // Prune expired signals
  state.active_signals[type] = state.active_signals[type]
    .filter(s => !s.expires_at || Date.parse(s.expires_at) > now);

  return state;
}
```

### 3.6 Stage 5: Stagnation Detector

Ported from Evolver `signals.js` `consecutiveEmptyCycles` logic.

The Stagnation Detector tracks cycles that produce no meaningful signals and emits a `stagnation` signal when the count exceeds a configurable threshold.

```typescript
interface StagnationDetectorState {
  /** Number of consecutive strategy cycles that produced no actionable signals. */
  consecutive_empty_cycles: number;

  /** Threshold: emit stagnation signal when exceeded. Default: 5. */
  threshold: number;

  /** Last cycle that produced at least one signal. */
  last_productive_cycle: number;

  /** Current cycle number. */
  current_cycle: number;

  /** The strategy that has been active during the stagnant period. */
  active_strategy: string;

  /** The goal that has been pursued during the stagnant period. */
  active_goal: string;
}

function check_stagnation(
  cycle_signals: ResearchSignal[],
  state: StagnationDetectorState
): { state: StagnationDetectorState; stagnation_signal: ResearchSignal | null } {

  state.current_cycle += 1;

  // A cycle is "empty" if it produced no signals, or only low-priority signals
  const meaningful_signals = cycle_signals.filter(
    s => s.priority === "critical" || s.priority === "high" || s.priority === "medium"
  );

  if (meaningful_signals.length > 0) {
    // Productive cycle: reset counter
    state.consecutive_empty_cycles = 0;
    state.last_productive_cycle = state.current_cycle;
    return { state, stagnation_signal: null };
  }

  // Empty cycle: increment counter
  state.consecutive_empty_cycles += 1;

  if (state.consecutive_empty_cycles >= state.threshold) {
    // Emit stagnation signal
    const stagnation_signal: ResearchSignal = {
      signal_id: uuid_v4(),
      signal_type: "stagnation",
      source_event_ids: [last_processed_event_id],  // reference last event in this cycle
      fingerprint: sha256("stagnation:" + state.active_strategy + ":" + state.active_goal),
      confidence: Math.min(0.99, 0.7 + 0.05 * state.consecutive_empty_cycles),
      priority: "high",
      payload: {
        // SSOT: StagnationPayload (research_signal_v1.schema.json)
        consecutive_empty_cycles: state.consecutive_empty_cycles,
        threshold: state.threshold,
        current_strategy: state.active_strategy,
        recommended_action: state.consecutive_empty_cycles >= state.threshold * 2
          ? "abandon_direction"
          : "switch_strategy"
      },
      detected_at: new Date().toISOString(),
      schema_version: 1
    };

    // Reset counter after emitting (to avoid immediate re-fire)
    // But keep the cycle count for escalation logic
    state.consecutive_empty_cycles = 0;

    return { state, stagnation_signal };
  }

  return { state, stagnation_signal: null };
}
```

---

## 4. Strategy Selector

Ported from Evolver `selector.js` scoring pipeline, with GEP concepts replaced by research-domain equivalents.

### 4.1 Strategy Presets

```typescript
/**
 * Pre-defined research strategy types.
 * The Signal Engine selects one of these; the EVO-11 Bandit selects
 * specific operators/backends within the chosen type.
 */
type ResearchStrategyPreset = "explore" | "deepen" | "verify" | "consolidate";

/**
 * The 4 raw RDI dimension scores (without gate_passed / rank_score).
 * Used by the strategy selector and bandit for RDI alignment computation.
 * The full `rdi_scores` object in research_outcome_v1.schema.json
 * extends this with gate_passed and rank_score.
 */
interface RdiDimensionScores {
  novelty: number;         // 0-1
  generality: number;      // 0-1
  significance: number;    // 0-1
  citation_impact: number; // 0-1
}
```

| Preset | Description | When Selected | RDI Emphasis |
|---|---|---|---|
| **explore** | Broad search for new directions. High novelty weight. Prioritizes finding untouched parameter space, unexplored processes, or new theoretical approaches. | `gap_detected`, `known_result_match` (pivot away), `stagnation`, `method_plateau` | novelty: 0.55, generality: 0.15, significance: 0.20, citation_impact: 0.10 |
| **deepen** | Focus on a promising direction. High method-quality weight. Pushes for higher precision, more complete calculations, or deeper parameter scans. | `parameter_sensitivity` (investigate further), productive ongoing computation | novelty: 0.15, generality: 0.35, significance: 0.25, citation_impact: 0.25 |
| **verify** | Cross-check and reproduce existing results. High integrity weight. Triggers EVO-07 re-runs, resolves disagreements, validates against known limits. | `calculation_divergence`, `integrity_violation`, `cross_check_opportunity` | novelty: 0.10, generality: 0.20, significance: 0.20, citation_impact: 0.50 |
| **consolidate** | Write up and formalize results. Prepare for publication. Organize evidence, run final integrity checks, draft paper sections. | Sufficient verified results accumulated, approaching A5 gate | novelty: 0.20, generality: 0.30, significance: 0.25, citation_impact: 0.25 |

### 4.2 Strategy Emphasis Weights

Each strategy preset defines emphasis weights over the four RDI ranking dimensions:

```typescript
interface StrategyEmphasis {
  novelty: number;         // weight on novelty (new results)
  generality: number;      // weight on method generality (broad applicability)
  significance: number;    // weight on problem significance (importance to field)
  citation_impact: number; // weight on citation impact (influence on field)
}

const STRATEGY_EMPHASIS: Record<ResearchStrategyPreset, StrategyEmphasis> = {
  explore:      { novelty: 0.55, generality: 0.15, significance: 0.20, citation_impact: 0.10 },
  deepen:       { novelty: 0.15, generality: 0.35, significance: 0.25, citation_impact: 0.25 },
  verify:       { novelty: 0.10, generality: 0.20, significance: 0.20, citation_impact: 0.50 },
  consolidate:  { novelty: 0.20, generality: 0.30, significance: 0.25, citation_impact: 0.25 },
};
```

### 4.3 Signal-to-Strategy Mapping

```typescript
/**
 * Maps each signal type to the strategy it recommends.
 * A signal may recommend different strategies depending on context;
 * the primary mapping is used in the scoring algorithm.
 */
const SIGNAL_STRATEGY_MAP: Record<ResearchSignalType, {
  primary: ResearchStrategyPreset;
  rationale: string;
}> = {
  gap_detected: {
    primary: "explore",
    rationale: "Knowledge gap found -- explore new approaches to fill it"
  },
  calculation_divergence: {
    primary: "verify",
    rationale: "Computations disagree -- verify by resolving the disagreement"
  },
  known_result_match: {
    primary: "explore",
    rationale: "Result matches known literature -- pivot to avoid duplication"
  },
  integrity_violation: {
    primary: "verify",
    rationale: "Integrity check failed -- verify and fix the issue"
  },
  method_plateau: {
    primary: "explore",
    rationale: "Current method not making progress -- explore alternatives"
  },
  parameter_sensitivity: {
    primary: "deepen",
    rationale: "Result is parameter-sensitive -- deepen investigation"
  },
  cross_check_opportunity: {
    primary: "verify",
    rationale: "Cross-check opportunity available -- verify existing results"
  },
  stagnation: {
    primary: "explore",
    rationale: "No progress for multiple cycles -- explore new direction"
  }
};
```

### 4.4 Selection Algorithm

```typescript
interface StrategySelectionInput {
  /** Active signals from the pipeline. */
  signals: ResearchSignal[];

  /** Currently active strategy. */
  current_strategy: ResearchStrategyPreset;

  /** History of strategy selections (most recent first). */
  strategy_history: Array<{
    strategy: ResearchStrategyPreset;
    selected_at: string;       // ISO 8601
    cycles_active: number;     // how many cycles this strategy ran
    outcome_quality: number;   // 0-1, quality of outcomes during this strategy
  }>;

  /** Current RDI dimension scores of the research project (4-dimensional, aligned with EVO-17 Section 4.3).
   *  Note: This is `RdiDimensionScores` (the 4 raw dimensions), not the full `rdi_scores` object
   *  from research_outcome_v1.schema.json which also includes gate_passed and rank_score.
   */
  rdi_scores: RdiDimensionScores;
}

interface StrategySelectionResult {
  /** The selected strategy. */
  selected_strategy: ResearchStrategyPreset;

  /** Score breakdown for the selected strategy. */
  score: number;

  /** Scores for all candidates (for transparency/debugging). */
  all_scores: Record<ResearchStrategyPreset, {
    signal_match_score: number;
    rdi_alignment: number;
    history_penalty: number;
    final_score: number;
  }>;

  /** Human-readable reasoning for the selection. */
  reasoning: string;

  /** The signals that most influenced this selection. */
  decisive_signals: string[];  // signal_ids
}
```

```
function select_strategy(input: StrategySelectionInput): StrategySelectionResult {

  candidates: ResearchStrategyPreset[] = ["explore", "deepen", "verify", "consolidate"]
  scores: Record<string, object> = {}

  for each strategy in candidates {

    // --- Step 1: Signal Match Score ---
    // Sum of (confidence * signal_weight) for signals that recommend this strategy
    signal_match_score = 0.0
    decisive_signals = []

    for each signal in input.signals {
      mapping = SIGNAL_STRATEGY_MAP[signal.signal_type]
      if (mapping.primary == strategy) {
        // Weight by priority
        priority_weight = {
          "critical": 4.0,
          "high": 2.0,
          "medium": 1.0,
          "low": 0.5
        }[signal.priority]

        contribution = signal.confidence * priority_weight
        signal_match_score += contribution
        decisive_signals.push(signal.signal_id)
      }
    }

    // Normalize signal_match_score to 0-1 range
    // (divide by theoretical max: all signals at critical priority, confidence 1.0)
    max_possible = input.signals.length * 4.0 * 1.0  // worst case normalization
    if (max_possible > 0) {
      signal_match_score = signal_match_score / max_possible
    }

    // --- Step 2: RDI Alignment ---
    // Dot product of strategy emphasis weights with current RDI scores.
    // High alignment = this strategy focuses on RDI dimensions that currently need improvement.
    emphasis = STRATEGY_EMPHASIS[strategy]

    // INVERT the RDI scores: low RDI score = high need for improvement = high alignment
    rdi_need = {
      novelty: 1.0 - input.rdi_scores.novelty,
      generality: 1.0 - input.rdi_scores.generality,
      significance: 1.0 - input.rdi_scores.significance,
      citation_impact: 1.0 - input.rdi_scores.citation_impact
    }

    rdi_alignment = emphasis.novelty * rdi_need.novelty
                  + emphasis.generality * rdi_need.generality
                  + emphasis.significance * rdi_need.significance
                  + emphasis.citation_impact * rdi_need.citation_impact

    // Normalize to 0-1 (max possible is 1.0 when all needs are 1.0 and all weights are 1.0)
    // Already normalized since emphasis weights sum to 1.0 and needs are in [0,1]

    // --- Step 3: History Penalty ---
    // Penalize recently-used strategies to encourage diversity.
    // Decay function: penalty = exp(-lambda * cycles_since_last_use)
    lambda = 0.5
    recent_uses = input.strategy_history
      .filter(h => h.strategy == strategy)
      .slice(0, 5)  // look at last 5 uses

    if (recent_uses.length == 0) {
      history_penalty = 1.0  // never used: no penalty
    } else {
      // Weighted penalty: more recent uses penalize more
      total_penalty = 0.0
      for (i, use) in enumerate(recent_uses) {
        recency = i + 1  // 1 = most recent
        quality_factor = use.outcome_quality  // good outcomes reduce penalty
        total_penalty += exp(-lambda * recency) * (1.0 - 0.5 * quality_factor)
      }
      history_penalty = max(0.1, 1.0 - total_penalty / recent_uses.length)
    }

    // --- Step 4: Combine ---
    // Weights: signal match is most important (50%), then RDI alignment (30%),
    // then history penalty (20% -- only a soft preference for diversity)
    final_score = 0.50 * signal_match_score
                + 0.30 * rdi_alignment
                + 0.20 * history_penalty

    scores[strategy] = {
      signal_match_score,
      rdi_alignment,
      history_penalty,
      final_score,
      decisive_signals
    }
  }

  // --- Step 5: Select ---
  // Select highest-scoring strategy.
  // Tie-breaking: prefer less-recently-used strategy.
  sorted = sort(candidates, by: (a, b) => {
    if (scores[a].final_score != scores[b].final_score) {
      return scores[b].final_score - scores[a].final_score  // higher score first
    }
    // Tie: prefer less recently used
    a_last = last_use_index(input.strategy_history, a)
    b_last = last_use_index(input.strategy_history, b)
    return b_last - a_last  // higher index (less recent) first
  })

  selected = sorted[0]

  // --- Step 6: Generate reasoning ---
  reasoning = generate_reasoning(selected, scores, input.signals)

  return {
    selected_strategy: selected,
    score: scores[selected].final_score,
    all_scores: scores,
    reasoning: reasoning,
    decisive_signals: scores[selected].decisive_signals
  }
}
```

### 4.5 Reasoning Generation

```
function generate_reasoning(
  selected: ResearchStrategyPreset,
  scores: Record<string, ScoreBreakdown>,
  signals: ResearchSignal[]
): string {
  s = scores[selected]

  parts = []
  parts.push(`Selected strategy: "${selected}" (score: ${s.final_score.toFixed(3)})`)

  // Signal-driven reasons
  matching_signals = signals.filter(sig =>
    SIGNAL_STRATEGY_MAP[sig.signal_type].primary == selected
  )
  if (matching_signals.length > 0) {
    types = unique(matching_signals.map(s => s.signal_type))
    parts.push(`Driven by ${matching_signals.length} signal(s): ${types.join(", ")}`)
  }

  // RDI alignment reason
  if (s.rdi_alignment > 0.5) {
    parts.push(`Strong RDI alignment (${s.rdi_alignment.toFixed(2)}): ` +
               `this strategy addresses dimensions that need improvement`)
  }

  // History context
  if (s.history_penalty < 0.5) {
    parts.push(`Note: strategy recently used (history penalty ${s.history_penalty.toFixed(2)})`)
  }

  // Runner-up
  runner_up = sort_by_score(scores).filter(k => k != selected)[0]
  if (runner_up) {
    gap = s.final_score - scores[runner_up].final_score
    parts.push(`Runner-up: "${runner_up}" (gap: ${gap.toFixed(3)})`)
  }

  return parts.join(". ") + "."
}
```

---

## 5. Interface with EVO-11 Bandit

### 5.1 Separation of Concerns

The Signal Engine and the Bandit operate at different levels of abstraction:

| Layer | Component | Selects | Granularity |
|---|---|---|---|
| **Strategy** | EVO-18 Signal Engine | Strategy TYPE (explore/deepen/verify/consolidate) | Coarse: overall research direction |
| **Operator** | EVO-11 Bandit | Specific operator + backend within strategy | Fine: which tool, which method, which parameters |

The Signal Engine does NOT select operators. The Bandit does NOT consider research signals directly. They communicate through a well-defined interface.

### 5.2 Strategy Context Interface

The Signal Engine provides a `StrategyContext` object to the Bandit on each strategy selection. The Bandit uses this to constrain its arm selection.

```typescript
/**
 * Context passed from Signal Engine to Bandit.
 * The Bandit uses this to filter and weight available arms.
 */
interface StrategyContext {
  /** The selected strategy type. */
  selected_strategy: ResearchStrategyPreset;

  /**
   * Active signals that influenced the strategy selection.
   * The Bandit may use these for fine-grained operator selection.
   * e.g., a "calculation_divergence" signal tells the Bandit to prefer
   * operators that use different packages from the divergent computation.
   */
  active_signals: ResearchSignal[];

  /**
   * Current RDI dimension scores (4-dimensional). The Bandit may use these to prefer operators
   * that are expected to improve weak dimensions.
   */
  rdi_scores: RdiDimensionScores;

  /** Timestamp of this strategy selection. ISO 8601. */
  selected_at: string;

  /** How many cycles this strategy has been active. */
  cycles_active: number;

  /**
   * Score breakdown from the strategy selector.
   * Informational for the Bandit's logging/debugging.
   */
  selection_scores: Record<ResearchStrategyPreset, number>;
}
```

### 5.3 Bandit Response Interface

The Bandit returns a specific operator selection:

```typescript
/**
 * Bandit's response to a StrategyContext.
 * Specifies which operator and parameters to use for the next research cycle.
 */
interface BanditSelection {
  /** The selected operator (arm). */
  operator_id: string;

  /** Parameters for the operator. */
  operator_params: Record<string, unknown>;

  /**
   * The backend to use (e.g., "FeynCalc", "FormCalc", "LoopTools.jl").
   * May be null if the operator handles backend selection internally.
   */
  backend?: string;

  /** UCB/Thompson score of the selected arm. */
  arm_score: number;

  /** Exploration vs exploitation: which mode produced this selection. */
  selection_mode: "exploit" | "explore";
}
```

### 5.4 Interaction Flow

```
[Signal Engine]
  1. Process ResearchEvent stream
  2. Extract signals
  3. Select strategy
  4. Package StrategyContext
       |
       v
[Bandit Distributor (EVO-11)]
  5. Receive StrategyContext
  6. Filter available arms to match strategy type
     (e.g., "verify" strategy -> only verification-related operators)
  7. Select arm using UCB-V / Thompson Sampling
  8. Return BanditSelection
       |
       v
[Execution Engine]
  9. Execute operator with selected backend and parameters
  10. Produce ResearchEvent(s) describing the outcome
  11. Feed events back to Signal Engine (loop)
       |
       v
[Reward Feedback to Bandit]
  12. Measure outcome quality
  13. Bandit.update_reward(arm, reward)
```

---

## 6. Interface with EVO-20 Memory Graph

### 6.1 Track A Node Types

The Signal Engine reads from and writes to the EVO-20 Memory Graph. Track A defines the following node types, all namespaced with the `rep:` prefix to avoid collision with Track B (`gep:` prefix).

```typescript
/**
 * Track A node types in the Memory Graph.
 * Each node type has a defined schema and lifecycle.
 */
type TrackANodeType =
  | "rep:strategy"          // strategy instance + execution history
  | "rep:outcome"           // verified research outcome
  | "rep:signal"            // detected signal + frequency count
  | "rep:integrity";        // integrity check result

interface StrategyNode {
  node_type: "rep:strategy";
  node_id: string;                        // SHA-256 of strategy definition
  strategy_preset: ResearchStrategyPreset;
  activated_at: string;                   // ISO 8601
  deactivated_at?: string;               // ISO 8601 (null if still active)
  cycles_active: number;
  outcomes_produced: number;
  average_outcome_quality: number;        // running average 0-1
  times_selected: number;                 // how many times this strategy was chosen
  last_selected_at: string;              // ISO 8601
  /** TTL-decayed effectiveness score. Older uses decay. */
  effectiveness_score: number;
}

interface OutcomeNode {
  node_type: "rep:outcome";
  node_id: string;                        // SHA-256 of outcome artifact
  outcome_ref: string;                    // ArtifactRef to the ResearchOutcome
  quantity_names: string[];               // which quantities this outcome provides
  rdi_scores: RdiDimensionScores;
  verified: boolean;                      // has passed EVO-07 reproducibility check
  created_at: string;                     // ISO 8601
}

interface SignalNode {
  node_type: "rep:signal";
  node_id: string;                        // fingerprint of the signal
  signal_type: ResearchSignalType;
  /** Total times this signal has been detected, across all runs. */
  total_frequency: number;
  /** Frequency within the most recent window. */
  recent_frequency: number;
  /** TTL-decayed weight. Signals not seen recently decay toward 0. */
  decayed_weight: number;
  first_seen: string;                     // ISO 8601
  last_seen: string;                      // ISO 8601
}

interface IntegrityNode {
  node_type: "rep:integrity";
  node_id: string;                        // SHA-256 of integrity report
  report_ref: string;                     // ArtifactRef to IntegrityReport
  check_ids: string[];                    // which checks were run
  overall_status: "pass" | "fail" | "advisory";
  created_at: string;                     // ISO 8601
}
```

### 6.2 Track A Edge Types

```typescript
/**
 * Track A edge types in the Memory Graph.
 * Edges connect nodes to form the research knowledge graph.
 */
type TrackAEdgeType =
  | "rep:produced"          // strategy -> outcome
  | "rep:triggered"         // signal -> strategy
  | "rep:validated_by"      // outcome -> integrity
  | "rep:supersedes"        // outcome -> outcome (newer supersedes older)
  | "rep:references";       // outcome -> outcome (citation)

interface MemoryGraphEdge {
  edge_type: TrackAEdgeType;
  source_id: string;        // node_id of the source node
  target_id: string;        // node_id of the target node
  created_at: string;       // ISO 8601
  metadata?: Record<string, unknown>;  // edge-specific metadata
}
```

Edge semantics:

| Edge Type | Source | Target | Semantics |
|---|---|---|---|
| `rep:produced` | strategy | outcome | "This strategy produced this outcome" |
| `rep:triggered` | signal | strategy | "This signal triggered the selection of this strategy" |
| `rep:validated_by` | outcome | integrity | "This outcome was validated by this integrity check" |
| `rep:supersedes` | outcome | outcome | "This newer outcome supersedes the older one (same quantity, better precision or corrected error)" |
| `rep:references` | outcome | outcome | "This outcome references/cites the other (cross-check, comparison, extension)" |

### 6.3 Read Operations

The Signal Engine queries the Memory Graph for:

1. **Historical signal frequencies**: "How often has this signal type appeared in the last 30 days?"
   ```
   query: SELECT * FROM signal_nodes
     WHERE signal_type = ? AND last_seen > (now - 30 days)
     ORDER BY total_frequency DESC
     LIMIT 10
   ```
   Used by: Aggregator (to detect persistent vs transient signals)

2. **Strategy effectiveness**: "How effective has each strategy been historically?"
   ```
   query: SELECT s.strategy_preset, AVG(s.average_outcome_quality) as effectiveness,
                 SUM(s.outcomes_produced) as total_outcomes
     FROM strategy_nodes s
     WHERE s.deactivated_at > (now - 90 days)
     GROUP BY s.strategy_preset
   ```
   Used by: Strategy Selector (to weight history penalty)

3. **Outcome provenance**: "What strategy and signals led to this outcome?"
   ```
   query: SELECT sig.signal_type, sig.total_frequency
     FROM signal_nodes sig
     JOIN edges e1 ON e1.source_id = sig.node_id AND e1.edge_type = 'rep:triggered'
     JOIN strategy_nodes strat ON e1.target_id = strat.node_id
     JOIN edges e2 ON e2.source_id = strat.node_id AND e2.edge_type = 'rep:produced'
     WHERE e2.target_id = ?
   ```
   Used by: Reward feedback to Bandit (trace outcome quality back to signal/strategy)

### 6.4 Write Operations

The Signal Engine writes to the Memory Graph:

1. **Record new signal**: When a new signal passes dedup, create or update its SignalNode.
   ```
   upsert signal_node SET
     total_frequency = total_frequency + 1,
     recent_frequency = recent_frequency + 1,
     decayed_weight = 1.0,  // reset decay on new observation
     last_seen = now()
   WHERE node_id = signal.fingerprint
   ```

2. **Record strategy selection**: When a strategy is selected, create a StrategyNode and link to triggering signals.
   ```
   insert strategy_node { ... }
   for each decisive_signal in selection.decisive_signals:
     insert edge { type: "rep:triggered", source: signal.fingerprint, target: strategy.node_id }
   ```

3. **Record outcome**: When a research cycle completes with results, create an OutcomeNode.
   ```
   insert outcome_node { ... }
   insert edge { type: "rep:produced", source: active_strategy.node_id, target: outcome.node_id }
   ```

4. **Update signal frequencies**: Periodic batch job to decay old signal weights.
   ```
   update signal_nodes SET
     decayed_weight = decayed_weight * exp(-lambda * days_since_last_seen)
   WHERE last_seen < (now - 1 day)
   ```

### 6.5 TTL Decay Algorithm

Ported from Evolver `memoryGraph.js` decay logic.

```typescript
/**
 * TTL decay parameters for Memory Graph nodes.
 * Nodes not observed recently have their weight reduced.
 */
interface DecayConfig {
  /** Decay rate (lambda). Higher = faster decay. Default: 0.03 (per day). */
  lambda: number;

  /** Minimum weight. Nodes below this are candidates for eviction. Default: 0.01. */
  min_weight: number;

  /** Eviction threshold: nodes below min_weight for this many days are removed. */
  eviction_grace_days: number;
}

function apply_decay(node: SignalNode, config: DecayConfig): SignalNode {
  const days_since_last_seen = (Date.now() - Date.parse(node.last_seen)) / 86400000;
  node.decayed_weight = Math.max(
    config.min_weight,
    node.decayed_weight * Math.exp(-config.lambda * days_since_last_seen)
  );
  return node;
}

function should_evict(node: SignalNode, config: DecayConfig): boolean {
  if (node.decayed_weight > config.min_weight) return false;
  const days_below_min = (Date.now() - Date.parse(node.last_seen)) / 86400000;
  return days_below_min > config.eviction_grace_days;
}
```

Default decay parameters:
- `lambda = 0.03` (half-life approximately 23 days)
- `min_weight = 0.01`
- `eviction_grace_days = 90` (nodes below min_weight for 90 days are evicted)

### 6.6 Boundary with Track B

Track A and Track B share the EVO-20 Memory Graph infrastructure but maintain strict namespace isolation:

| Aspect | Track A (Research) | Track B (Tool) |
|---|---|---|
| **Node prefix** | `rep:` | `gep:` |
| **Edge prefix** | `rep:` | `gep:` |
| **Storage** | Same SQLite database | Same SQLite database |
| **TTL decay** | Same algorithm, separate config | Same algorithm, separate config |
| **Frequency tracking** | Same table schema, filtered by prefix | Same table schema, filtered by prefix |
| **Cross-track edges** | NOT allowed by default | NOT allowed by default |

Cross-track edges (e.g., "this tool fix enabled this research outcome") may be introduced in the future via an explicit opt-in mechanism. This requires:
1. A new edge type prefix: `cross:`
2. Both Track A and Track B coordinators agreeing to the edge creation
3. The edge carrying metadata identifying which tracks are connected

This is deferred to a future iteration and is NOT part of the initial implementation.

---

## 7. Configuration

### 7.1 Signal Engine Configuration

```typescript
interface SignalEngineConfig {
  /** Dedup configuration per signal type. */
  dedup: Record<ResearchSignalType, DedupConfig>;

  /** Stagnation detector configuration. */
  stagnation: {
    threshold: number;            // default: 5 consecutive empty cycles
    escalation_threshold: number; // default: 10 (triggers "abandon_direction")
  };

  /** Strategy selector weights. */
  selector: {
    signal_match_weight: number;  // default: 0.50
    rdi_alignment_weight: number; // default: 0.30
    history_penalty_weight: number; // default: 0.20
    history_lambda: number;       // decay rate for history penalty. default: 0.5
  };

  /** Aggregator window duration in seconds. */
  aggregator_window_seconds: number;  // default: 86400 (24 hours)

  /** Memory Graph decay configuration. */
  memory_decay: DecayConfig;

  /** Event types to process (whitelist). Empty = process all mapped types. */
  event_type_whitelist?: string[];
}
```

### 7.2 Default Configuration

```json
{
  "dedup": {
    "integrity_violation": { "dedup_window_seconds": 3600, "max_tracked_fingerprints": 10000 },
    "calculation_divergence": { "dedup_window_seconds": 86400, "max_tracked_fingerprints": 10000 },
    "gap_detected": { "dedup_window_seconds": 604800, "max_tracked_fingerprints": 10000 },
    "known_result_match": { "dedup_window_seconds": 604800, "max_tracked_fingerprints": 10000 },
    "method_plateau": { "dedup_window_seconds": 43200, "max_tracked_fingerprints": 10000 },
    "parameter_sensitivity": { "dedup_window_seconds": 86400, "max_tracked_fingerprints": 10000 },
    "cross_check_opportunity": { "dedup_window_seconds": 604800, "max_tracked_fingerprints": 10000 },
    "stagnation": { "dedup_window_seconds": 21600, "max_tracked_fingerprints": 10000 }
  },
  "stagnation": {
    "threshold": 5,
    "escalation_threshold": 10
  },
  "selector": {
    "signal_match_weight": 0.50,
    "rdi_alignment_weight": 0.30,
    "history_penalty_weight": 0.20,
    "history_lambda": 0.5
  },
  "aggregator_window_seconds": 86400,
  "memory_decay": {
    "lambda": 0.03,
    "min_weight": 0.01,
    "eviction_grace_days": 90
  }
}
```

---

## 8. File Layout

```
packages/rep-sdk/src/
  signals.ts                    # Signal extraction pipeline (this design)
    ├── types                   # ResearchSignal, SignalPayload, all payload types
    ├── detectors/              # One detector per signal type
    │   ├── gap.ts
    │   ├── divergence.ts
    │   ├── known-match.ts
    │   ├── integrity.ts
    │   ├── plateau.ts
    │   ├── sensitivity.ts
    │   ├── cross-check.ts
    │   └── stagnation.ts
    ├── dedup.ts                # Fingerprint-based dedup engine
    ├── aggregator.ts           # Signal aggregation + frequency counting
    └── stagnation-detector.ts  # Consecutive empty cycle tracking

  selector.ts                   # Strategy selector (this design)
    ├── types                   # StrategyPreset, StrategyContext, BanditSelection
    ├── scoring.ts              # Scoring algorithm
    ├── reasoning.ts            # Reasoning generation
    └── strategy-map.ts         # Signal-to-strategy mapping

autoresearch-meta/schemas/
  research_signal_v1.schema.json          # ResearchSignal JSON Schema
  signal_engine_config_v1.schema.json     # SignalEngineConfig JSON Schema
```

Each file stays within the 200 eLOC CODE-01 limit. The detector directory separates each detector into its own file.

---

## 9. JSON Schemas

The following JSON Schema files (Draft 2020-12) will be created in `autoresearch-meta/schemas/`:

- `research_signal_v1.schema.json` -- ResearchSignal including all payload types (Section 2)
- `signal_engine_config_v1.schema.json` -- SignalEngineConfig (Section 7)
- `strategy_context_v1.schema.json` -- StrategyContext interface (Section 5.2)

---

## 10. Integration Test Strategy

### 10.1 Unit Tests

- Each detector: given a specific ResearchEvent, verify correct signal extraction or null
- Dedup engine: verify fingerprint matching within/outside window, frequency counting, LRU eviction
- Stagnation detector: verify counter increment, threshold detection, reset after emission
- Strategy selector: verify scoring with known inputs, tie-breaking, history penalty decay

### 10.2 Integration Tests

- Full pipeline: feed a sequence of ResearchEvents, verify correct signals emitted in order
- Dedup + Aggregator: feed duplicate events, verify only one signal with updated frequency
- Stagnation + Strategy: feed empty cycles, verify stagnation signal triggers "explore" strategy

### 10.3 End-to-End Test

A complete research evolution cycle:
1. Feed `computation_completed` event -> no signal (first computation, nothing to compare)
2. Feed `verification_failed` event with disagreement -> `calculation_divergence` signal
3. Strategy selector -> "verify" strategy
4. Feed `integrity_check_completed` event with failure -> `integrity_violation` signal
5. Strategy selector -> "verify" strategy (reinforced by two verify-oriented signals)
6. Feed `verification_passed` event with agreement -> signal deduped (same fingerprint, within window)
7. Feed 5 empty cycles -> `stagnation` signal -> strategy switches to "explore"

---

## 11. Acceptance Criteria

From REDESIGN_PLAN.md EVO-18:

> - 4 research signal types extractable from ResearchEvent stream
> - Signal dedup + stagnation detection (consecutiveEmptyCycles) working correctly
> - Strategy selector matches best ResearchStrategy based on signals

Extended criteria (from this design):

1. All 8 signal types have functional detectors with test coverage.
2. Fingerprint-based dedup correctly merges duplicate signals within the configured window.
3. Stagnation detector fires after N consecutive empty cycles (configurable, default 5).
4. Strategy selector produces a scored selection with human-readable reasoning.
5. StrategyContext is correctly passed to EVO-11 Bandit interface.
6. Signal frequencies persist in EVO-20 Memory Graph across runs.
7. TTL decay reduces old signal weights according to configured lambda.
8. Track A nodes/edges are namespaced with `rep:` prefix and isolated from Track B.

---

## Appendix A: Mapping from Evolver signals.js

| Evolver signals.js Concept | REP Signal Engine Equivalent | Changes |
|---|---|---|
| Error signals (test failure, lint error) | `integrity_violation`, `calculation_divergence` | Software errors -> scientific verification failures |
| Opportunity signals (code smell, perf regression) | `gap_detected`, `cross_check_opportunity` | Code quality -> research opportunity |
| Stagnation detection (consecutiveEmptyCycles) | Stagnation Detector (Section 3.6) | Identical algorithm, different cycle definition |
| Signal fingerprint (hash of type + key) | Signal fingerprint (hash of type + fingerprint_key) | Same mechanism |
| Dedup window (configurable per signal type) | Dedup window (Section 3.4.2) | Same mechanism, different default values |
| Signal frequency counting | Aggregator (Section 3.5) | Same concept, integrated with Memory Graph |

## Appendix B: Mapping from Evolver selector.js

| Evolver selector.js Concept | REP Strategy Selector Equivalent | Changes |
|---|---|---|
| Strategy presets (balanced/innovate/harden/repair-only) | Research presets (explore/deepen/verify/consolidate) | Domain-appropriate names and semantics |
| GDI scoring (quality 35% + usage 30% + social 20% + freshness 15%) | RDI scoring (novelty 40% + generality 20% + significance 20% + citation_impact 20%) | Research-appropriate dimensions, 4-dimensional |
| Signal-to-gene matching | Signal-to-strategy mapping (Section 4.3) | Genes -> strategies |
| Scoring pipeline (match + GDI + history) | Scoring pipeline (match + RDI alignment + history penalty) | Same structure, different weights |
| History penalty (times_recently_used decay) | History penalty (exponential decay, Section 4.4) | Same concept, formalized |

## Appendix C: Relationship to Other EVO Items

| EVO Item | Relationship to EVO-18 |
|---|---|
| **EVO-06** | Provides `integrity_violation` and `known_result_match` signals via IntegrityCheck results |
| **EVO-07** | Provides `calculation_divergence` signals via DeviationReport |
| **EVO-11** | Receives StrategyContext from Signal Engine; selects specific operator/backend |
| **EVO-17** | Provides ResearchEvent stream via FileTransport (input to Signal Engine) |
| **EVO-20** | Stores signal frequencies, strategy effectiveness, outcome provenance (shared infra) |
