# EVO-17: REP SDK Detailed Technical Design

> **Version**: 1.0.0-draft
> **Date**: 2026-02-21
> **Author**: Claude Opus 4.6
> **Status**: Draft -- pending dual-model review
> **Package**: `@autoresearch/rep-sdk` (npm, MIT license)
> **Constraint**: PLUG-01 -- zero Autoresearch internal dependencies
> **Language**: English (LANG-01)

## Table of Contents

1. [Overview and Motivation](#1-overview-and-motivation)
2. [Wire Protocol](#2-wire-protocol)
3. [Core TypeScript Interfaces](#3-core-typescript-interfaces)
4. [RDI Scoring Formula](#4-rdi-scoring-formula)
5. [Transport Layer](#5-transport-layer)
6. [Sub-path Export Design](#6-sub-path-export-design)
7. [Package Design](#7-package-design)
8. [Algorithms and Pseudocode](#8-algorithms-and-pseudocode)
9. [Integration Points](#9-integration-points)
10. [Open Questions](#10-open-questions)

---

## 1. Overview and Motivation

### 1.1 What REP Is

REP (Research Evolution Protocol) is to AI scientific research what MCP (Model Context Protocol) is to LLM tool use. Where MCP answers "what tools are available?", REP answers "why does this research strategy work, and how should it evolve?"

REP is the core protocol for Track A (research evolution) in the Autoresearch dual-track architecture:

| Track | Protocol | Domain | Assets |
|---|---|---|---|
| **Track A (Research Evolution)** | **REP** | Theoretical physics research | ResearchStrategy, ResearchOutcome, ResearchEvent, IntegrityReport |
| **Track B (Tool Evolution)** | **GEP** (Evolver) | Software engineering | Gene, Capsule, EvolutionEvent |

### 1.2 Design Lineage

REP borrows proven design patterns from GEP (Genome Evolution Protocol) while adapting them for the scientific research domain:

| GEP Pattern | REP Adaptation |
|---|---|
| Content addressing (SHA-256) | Adopted directly, unified with ArtifactRef V1 (H-18) |
| Envelope format (7 fields) | Same structure, `protocol` field changed to `rep-a2a` |
| 6 message types | Retained 5, changed `decision` to `review` (peer review semantics) |
| GDI scoring | Replaced with RDI: fail-closed gate + ranking score (dual-layer) |
| Signal extraction | From error/opportunity signals to research signals |
| Natural selection | From usage feedback to scientific verification feedback |

### 1.3 Relationship to MCP

```
MCP (Interface Layer)      -- "What tools are available?"
  |
REP (Evolution Layer)      -- "Why does this strategy work? How to evolve?"
  |
Orchestrator (Execution)   -- "Execute the chosen strategy"
  |
Agent-arXiv (Publication)  -- "Publish and cite verified results"
```

REP does not replace MCP. Agents use MCP to call tools for computation, and REP to record and share the evolution of research strategies across cycles.

### 1.4 PLUG-01 Constraint

`@autoresearch/rep-sdk` must be independently installable with zero Autoresearch internal dependencies. Any AI research platform should be able to `npm install @autoresearch/rep-sdk` and use the protocol. Only Node.js built-in modules are permitted as hard dependencies. Optional peer dependencies may be declared for extended functionality.

---

## 2. Wire Protocol

### 2.1 REP Envelope

The REP envelope adapts GEP's 7-field mandatory envelope (from Evolver `a2aProtocol.js`) for research evolution semantics.

#### Field Definitions

| Field | Type | Required | Description |
|---|---|---|---|
| `protocol` | string literal | Yes | Always `"rep-a2a"` |
| `protocol_version` | string | Yes | SemVer, currently `"1.0"` |
| `message_type` | enum | Yes | One of: `hello`, `publish`, `fetch`, `report`, `review`, `revoke` |
| `message_id` | string (UUID v4) | Yes | Unique identifier for this message |
| `sender_id` | string | Yes | Identifier of the sending agent/node |
| `recipient_id` | string | No | Target agent/node; omitted for broadcast |
| `timestamp` | string (ISO 8601) | Yes | UTC with Z suffix, e.g., `"2026-02-21T14:30:00.000Z"` |
| `content_hash` | string (hex) | No | SHA-256 of the canonical JSON serialization of `payload` |
| `payload` | object | Yes | Type-specific payload (discriminated by `message_type` via allOf+if/then in schema) |

#### Message Type Semantics

| Message Type | Direction | Wire Payload (SSOT) | Description |
|---|---|---|---|
| `hello` | Bidirectional | `HelloPayload` (`capabilities`, `domain`) | Agent registration and capability advertisement |
| `publish` | Sender -> Store | `PublishPayload` (`asset_type`, `asset`) | Publish a new research asset (strategy/outcome/integrity_report) |
| `fetch` | Requester -> Store | `FetchPayload` (`asset_type`, `filters?`, `limit?`) | Request research assets matching criteria |
| `report` | Agent -> Store | `ReportPayload` (`event`) | Report a research event for the audit trail |
| `review` | Reviewer -> Store | `ReviewPayload` (`target_asset_id`, `decision`) | Submit peer review of a research outcome |
| `revoke` | Owner -> Store | `RevokePayload` (`target_asset_id`, `reason`) | Revoke a previously published asset |

**Difference from GEP**: GEP uses `decision` for binary accept/reject rulings. REP uses `review` because scientific peer review produces structured feedback (not just accept/reject) and may result in status changes from `verified` to `superseded` rather than simple revocation.

### 2.2 Envelope TypeScript Interface

```typescript
/**
 * REP envelope -- the wire format for all REP messages.
 * Adapted from GEP a2aProtocol.js envelope construction.
 */
// (Illustrative — rep_envelope_v1.schema.json is the normative SSOT)
export interface RepEnvelope {
  /** Always "rep-a2a" */
  readonly protocol: "rep-a2a";

  /** SemVer protocol version, currently "1.0" */
  readonly protocol_version: string;

  /** Message type enum */
  readonly message_type: RepMessageType;

  /** UUID v4 unique message identifier */
  readonly message_id: string;

  /** Identifier of the sending agent or node */
  readonly sender_id: string;

  /** Target agent or node; omitted for broadcast */
  readonly recipient_id?: string;

  /** ISO 8601 UTC timestamp with Z suffix */
  readonly timestamp: string;

  /** SHA-256 hex digest of canonical JSON payload */
  readonly content_hash?: string;

  /** Trace ID for cross-system correlation. UUID v4. */
  readonly trace_id?: string;

  /** Type-specific payload object (discriminated by message_type via allOf+if/then in schema) */
  readonly payload: RepPayload;

  /** Optional signature (network mode only) */
  readonly signature?: {
    readonly algorithm?: "hmac-sha256" | "none";
    readonly value?: string;
    readonly key_id?: string;
  };
}

export type RepMessageType =
  | "hello"
  | "publish"
  | "fetch"
  | "report"
  | "review"
  | "revoke";

/** SDK-internal payload type discriminant (not present on the wire — used by SDK helpers
 *  like createEnvelope() for routing and asset storage). */
export type RepPayloadType =
  | "strategy"
  | "outcome"
  | "event"
  | "integrity_report"
  | "query"
  | "control";

/** Wire payload for "hello" messages. Matches rep_envelope_v1.schema.json#/$defs/HelloPayload. */
export interface HelloPayload {
  readonly capabilities: readonly string[];
  readonly domain: string;
  readonly agent_name?: string;
  readonly agent_version?: string;
  readonly supported_check_domains?: readonly string[];
}

/** Wire payload for "publish" messages. Matches rep_envelope_v1.schema.json#/$defs/PublishPayload. */
export interface PublishPayload {
  readonly asset_type: "strategy" | "outcome" | "integrity_report";
  readonly asset: ResearchStrategy | ResearchOutcome | IntegrityReport;
  readonly rdi_gate_result?: {
    readonly passed: boolean;
    readonly checks?: ReadonlyArray<{ readonly name: string; readonly passed: boolean }>;
  };
  readonly revision_of?: {
    readonly original_asset_id: string;
    readonly review_message_id?: string;
  };
}

/** Wire payload for "fetch" messages. Matches rep_envelope_v1.schema.json#/$defs/FetchPayload. */
export interface FetchPayload {
  readonly asset_type: "strategy" | "outcome" | "integrity_report";
  readonly filters?: {
    readonly domain?: string;
    readonly preset?: string;
    readonly status?: string;
    readonly min_rdi_rank?: number;
    readonly since?: string;
  };
  readonly limit?: number;
}

/** Wire payload for "report" messages. Matches rep_envelope_v1.schema.json#/$defs/ReportPayload. */
export interface ReportPayload {
  readonly event: ResearchEvent;
}

/** Wire payload for "review" messages. Matches rep_envelope_v1.schema.json#/$defs/ReviewPayload. */
export interface ReviewPayload {
  readonly target_asset_id: string;
  readonly decision: "approve" | "reject" | "revise";
  readonly review_comments?: string;
  readonly reviewer_id?: string;
  readonly integrity_report_ref?: string;
}

/** Wire payload for "revoke" messages. Matches rep_envelope_v1.schema.json#/$defs/RevokePayload. */
export interface RevokePayload {
  readonly target_asset_id: string;
  readonly reason: string;
  readonly superseded_by?: string;
}

/** Union of all SSOT wire payload types (discriminated by message_type). */
export type RepPayload =
  | HelloPayload
  | PublishPayload
  | FetchPayload
  | ReportPayload
  | ReviewPayload
  | RevokePayload;
```

### 2.3 Content Addressing

All content-addressed assets use SHA-256 over RFC 8785 (JCS) canonical JSON serialization.

**Canonical JSON specification** (RFC 8785 — JSON Canonicalization Scheme):
1. Keys sorted lexicographically (Unicode code point order)
2. No whitespace between tokens (no spaces after `:` or `,`)
3. No trailing commas
4. Unicode escape sequences normalized per RFC 8785 §3.2.2.2
5. Numbers serialized per RFC 8785 §3.2.2.3 (IEEE 754 double-precision rules)

```typescript
/**
 * Compute SHA-256 content hash of a payload.
 * Uses RFC 8785 (JCS) canonical JSON serialization.
 */
export function contentHash(payload: Record<string, unknown>): string {
  const canonical = canonicalJsonSerialize(payload);
  // Node.js built-in crypto module (zero external deps)
  const hash = createHash("sha256");
  hash.update(canonical, "utf8");
  return hash.digest("hex");
}

/**
 * Canonical JSON serialization: sorted keys, no whitespace.
 * Recursive sort for nested objects.
 */
export function canonicalJsonSerialize(
  value: unknown
): string {
  if (value === null || value === undefined) {
    return "null";
  }
  if (typeof value === "boolean" || typeof value === "number") {
    return JSON.stringify(value);
  }
  if (typeof value === "string") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    const items = value.map((item) => canonicalJsonSerialize(item));
    return "[" + items.join(",") + "]";
  }
  if (typeof value === "object") {
    const sortedKeys = Object.keys(value as Record<string, unknown>).sort();
    const pairs = sortedKeys.map((key) => {
      const v = (value as Record<string, unknown>)[key];
      if (v === undefined) return null;
      return JSON.stringify(key) + ":" + canonicalJsonSerialize(v);
    }).filter((pair): pair is string => pair !== null);
    return "{" + pairs.join(",") + "}";
  }
  return JSON.stringify(value);
}
```

### 2.4 Envelope Construction

```typescript
import { randomUUID } from "node:crypto";

/**
 * Construct a REP envelope with content hash.
 * Ported from Evolver a2aProtocol.js envelope construction,
 * adapted for REP protocol semantics.
 *
 * MIT attribution: envelope construction pattern from
 * autogame-17/evolver (MIT License).
 */
export function createEnvelope(params: {
  message_type: RepMessageType;
  sender_id: string;
  recipient_id?: string;
  payload: RepPayload;
  signature?: { algorithm?: "hmac-sha256" | "none"; value?: string; key_id?: string };
}): RepEnvelope {
  const { message_type, sender_id, payload } = params;

  return {
    protocol: "rep-a2a",
    protocol_version: "1.0",
    message_type,
    message_id: randomUUID(),
    sender_id,
    ...(params.recipient_id ? { recipient_id: params.recipient_id } : {}),
    timestamp: new Date().toISOString(),
    content_hash: contentHash(payload as Record<string, unknown>),
    payload,
    ...(params.signature ? { signature: params.signature } : {}),
  };
}
```

### 2.5 Signature and Verification

REP defines two security modes:

| Mode | Signature | Use Case |
|---|---|---|
| **Local mode** | None required | Single-machine, single-user. `content_hash` provides tamper detection. |
| **Network mode** | HMAC-SHA256 (optional) | Multi-node, multi-agent. Shared secret per agent pair. |

**Local mode** (default): The `content_hash` field provides integrity verification. No cryptographic signature is needed because the transport is trusted (local filesystem). Verification consists of recomputing the SHA-256 hash and comparing.

**Network mode** (future): When REP messages traverse a network boundary, HMAC-SHA256 signatures prevent tampering and authenticate the sender.

```typescript
import { createHmac } from "node:crypto";

/**
 * Sign an envelope payload using HMAC-SHA256.
 * Only required in network mode.
 */
export function signEnvelope(
  envelope: RepEnvelope,
  sharedSecret: string
): string {
  const canonical = canonicalJsonSerialize(
    envelope.payload as Record<string, unknown>
  );
  const hmac = createHmac("sha256", sharedSecret);
  hmac.update(canonical, "utf8");
  return hmac.digest("hex");
}

/**
 * Verify an envelope signature.
 * Returns true if the signature matches, false otherwise.
 * In local mode (no signature field), always returns true.
 */
export function verifyEnvelope(
  envelope: RepEnvelope,
  sharedSecret: string
): boolean {
  if (!envelope.signature || envelope.signature.algorithm === "none") {
    // Local mode: no signature required, rely on content_hash
    return true;
  }
  const expected = signEnvelope(envelope, sharedSecret);
  const sigBuffer = Buffer.from(envelope.signature.value ?? "", "hex");
  const expectedBuffer = Buffer.from(expected, "hex");
  // Guard against RangeError: timingSafeEqual requires equal-length buffers
  if (sigBuffer.length !== expectedBuffer.length) return false;
  // Constant-time comparison to prevent timing attacks
  return timingSafeEqual(sigBuffer, expectedBuffer);
}
```

### 2.6 Envelope Validation

```typescript
/**
 * Validate a received REP envelope.
 * Returns a list of validation errors (empty if valid).
 */
export function validateEnvelope(
  envelope: RepEnvelope
): string[] {
  const errors: string[] = [];

  if (envelope.protocol !== "rep-a2a") {
    errors.push(`Invalid protocol: expected "rep-a2a", got "${envelope.protocol}"`);
  }

  const validMessageTypes: RepMessageType[] = [
    "hello", "publish", "fetch", "report", "review", "revoke",
  ];
  if (!validMessageTypes.includes(envelope.message_type)) {
    errors.push(`Invalid message_type: "${envelope.message_type}"`);
  }

  // UUID v4 format check
  const uuidV4Regex =
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  if (!uuidV4Regex.test(envelope.message_id)) {
    errors.push(`Invalid message_id: not a valid UUID v4`);
  }

  // ISO 8601 UTC Z timestamp check
  const isoRegex = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
  if (!isoRegex.test(envelope.timestamp)) {
    errors.push(`Invalid timestamp: must be ISO 8601 UTC with Z suffix`);
  }

  // Content hash verification (only when present — content_hash is optional in SSOT)
  if (envelope.content_hash !== undefined) {
    const computed = contentHash(
      envelope.payload as Record<string, unknown>
    );
    if (computed !== envelope.content_hash) {
      errors.push(
        `Content hash mismatch: expected ${computed}, got ${envelope.content_hash}`
      );
    }
  }

  return errors;
}
```

### 2.7 Inner Payload Validation (Normative)

The REP envelope schema (`rep_envelope_v1.schema.json`) intentionally types `PublishPayload.asset` and `ReportPayload.event` as `{"type": "object"}`. This follows the [CloudEvents `dataschema` pattern](https://github.com/cloudevents/spec): the envelope validates envelope-level fields; the SDK validates inner payload content at runtime.

**Requirement**: The REP SDK **MUST** validate inner payloads against their corresponding SSOT schemas before accepting or forwarding a message:

| `message_type` | Discriminant | Inner Schema |
|---|---|---|
| `publish` | `payload.asset_type = "strategy"` | `research_strategy_v1.schema.json` |
| `publish` | `payload.asset_type = "outcome"` | `research_outcome_v1.schema.json` |
| `publish` | `payload.asset_type = "integrity_report"` | `integrity_report_v1.schema.json` |
| `report` | (always) | `research_event_v1.schema.json` |

**Failure semantics**: If inner payload validation fails, the SDK **MUST** reject the message with a structured error (validation errors array) and **MUST NOT** persist, forward, or index the message. The envelope itself remains valid — the rejection is at the application layer, not the transport layer.

---

## 3. Core TypeScript Interfaces

All interfaces below are designed to be compilable TypeScript. They are **illustrative** — the JSON Schema files in `autoresearch-meta/schemas/` are the normative Single Source of Truth (SSOT). In case of conflict, the JSON Schema takes precedence.

### 3.1 Common Types

```typescript
/**
 * Reference to an artifact, aligned with ArtifactRef V1 (H-18).
 */
export interface ArtifactRef {
  /** URI following the hep:// or rep:// scheme */
  readonly uri: string;

  /** Kind of artifact */
  readonly kind: string;

  /** JSON Schema version of the referenced artifact */
  readonly schema_version: number;

  /** SHA-256 hex digest of the artifact content */
  readonly sha256: string;

  /** Size of the artifact in bytes */
  readonly size_bytes: number;

  /** Tool or agent that produced this artifact */
  readonly produced_by: string;

  /** ISO 8601 UTC creation timestamp */
  readonly created_at: string;
}

/**
 * Key-value map for computed physical quantities.
 */
export interface MetricValue {
  /** The computed value (number, string expression, array, or other domain-specific type). */
  readonly value: unknown;
  /** Numerical/statistical uncertainty. */
  readonly uncertainty?: number;
  /** Unit of measurement. Omit for dimensionless quantities. */
  readonly unit?: string;
  /** How this quantity was computed. */
  readonly method?: string;
}

export interface MetricsMap {
  readonly [key: string]: MetricValue;
}

/**
 * RDI (Research Desirability Index) scores. Matches research_outcome_v1.schema.json#/properties/rdi_scores.
 */
export interface RdiScores {
  /** Whether this outcome passed the RDI fail-closed gate. */
  readonly gate_passed: boolean;
  /** Novelty score (0-1). Higher means more novel. */
  readonly novelty: number;
  /** Methodological generality score (0-1). */
  readonly generality: number;
  /** Problem significance score (0-1). */
  readonly significance: number;
  /** Local citation impact score (0-1). */
  readonly citation_impact: number;
  /** Composite ranking score: w_n*novelty + w_g*generality + w_s*significance + w_c*citation_impact. */
  readonly rank_score: number;
}

/**
 * Parameter range specification for applicability constraints.
 * SSOT uses a map from parameter name to range object (additionalProperties),
 * so there is no explicit `name` field inside the range object.
 */
export interface ParameterRange {
  /** Minimum value (inclusive), omitted if unbounded below */
  readonly min?: number;

  /** Maximum value (inclusive), omitted if unbounded above */
  readonly max?: number;

  /** Unit of measurement (e.g., "GeV", "dimensionless") */
  readonly unit?: string;
}

/**
 * An approximation used by a strategy, with validity conditions.
 */
export interface Approximation {
  /** Approximation name (e.g., "massless light quarks", "narrow-width approximation") */
  readonly name: string;
  /** Condition under which this approximation is valid */
  readonly validity_condition: string;
  /** Estimated error introduced by this approximation */
  readonly estimated_error?: string;
}

/**
 * Expected output quantity from a strategy.
 */
export interface ExpectedQuantity {
  /** Quantity name (e.g., "differential cross-section", "anomalous dimension") */
  readonly name: string;
  /** Type: scalar, vector, matrix, function, distribution */
  readonly type?: "scalar" | "vector" | "matrix" | "function" | "distribution";
  /** Unit of measurement */
  readonly unit?: string;
}

/**
 * A validation criterion for verifying strategy outcomes.
 */
export interface ValidationCriterion {
  /** Criterion name (e.g., "gauge_invariance", "known_limit_check") */
  readonly name: string;
  /** How to verify (e.g., "compare Feynman vs unitary gauge results") */
  readonly method: string;
  /** Acceptable deviation (relative) */
  readonly tolerance?: number;
  /** Whether this criterion is required for outcome verification. Default: true. */
  readonly required?: boolean;
}

/**
 * REP query payload for fetch messages.
 */
export interface RepQuery {
  /** Type of asset being queried */
  readonly asset_type: "strategy" | "outcome" | "integrity_report";

  /** Filter criteria */
  readonly filters: Record<string, unknown>;

  /** Maximum number of results */
  readonly limit?: number;

  /** Offset for pagination */
  readonly offset?: number;

  /** Sort field and direction */
  readonly sort_by?: string;
  readonly sort_order?: "asc" | "desc";
}

/**
 * REP control payload for hello and revoke messages.
 */
export interface RepControl {
  /** Control action */
  readonly action: "register" | "heartbeat" | "revoke" | "capabilities";

  /** Agent capabilities (for hello/register) */
  readonly capabilities?: string[];

  /** Target asset ID (for revoke) */
  readonly target_id?: string;

  /** Revocation reason */
  readonly reason?: string;

  /** Additional control data */
  readonly data?: Record<string, unknown>;
}
```

### 3.2 ResearchStrategy

> **SSOT note**: The JSON Schema files in `schemas/` are the normative Single Source of Truth for data shapes. The TypeScript interfaces below are illustrative and are aligned with the corresponding schema where possible. In case of conflict, the JSON schema takes precedence. Field names removed from the schema (e.g., `parent_strategy_ref`) are not part of the normative contract.

Replaces GEP's Gene concept. A ResearchStrategy is a reusable research strategy template containing methodology, constraints, and validation criteria.

```typescript
/**
 * ResearchStrategy -- a reusable research strategy template.
 *
 * Replaces GEP Gene for the scientific research domain.
 * Content-addressed by strategy_id (SHA-256 of canonical JSON,
 * excluding strategy_id field itself).
 *
 * @example
 * {
 *   strategy_id: "a3f2c...",
 *   name: "NLO QCD corrections to top-quark pair production",
 *   description: "Compute next-to-leading order QCD corrections...",
 *   objective: "Determine O(alpha_s) corrections to the tt-bar cross section",
 *   method: {
 *     approach: "one-loop perturbative calculation",
 *     tools: ["FeynCalc", "LoopTools"],
 *     model: "Standard Model"
 *   },
 *   constraints: {
 *     parameter_ranges: {
 *       sqrt_s: { min: 13000, max: 14000, unit: "GeV" },
 *       mu_R: { min: 50, max: 500, unit: "GeV" }
 *     },
 *     approximations: [
 *       { name: "dimensional_regularization", validity_condition: "d = 4 - 2*epsilon" }
 *     ],
 *     assumptions: ["massless light quarks", "on-shell top quarks"]
 *   },
 *   expected_outcome_form: {
 *     quantities: [
 *       { name: "dsigma_dpT", type: "function", unit: "pb/GeV" }
 *     ],
 *     format: "analytic_expression"
 *   },
 *   domain: "hep-ph",
 *   applicable_when: [
 *     "target process involves QCD color-charged final states",
 *     "tree-level cross section already computed"
 *   ],
 *   validation_criteria: [
 *     { name: "ward_identity", method: "check Ward identity to 10^-10 relative precision" },
 *     { name: "uv_pole_cancellation", method: "verify UV poles cancel after renormalization" },
 *     { name: "ir_pole_check", method: "compare IR poles against Catani-Seymour prediction" }
 *   ],
 *   tags: ["QCD", "NLO", "top-quark"],
 *   schema_version: 1
 * }
 */
export interface ResearchStrategy {
  /**
   * Content-addressed identifier.
   * SHA-256 of the canonical JSON serialization of all fields
   * EXCEPT strategy_id itself.
   */
  readonly strategy_id: string;

  /** Human-readable name of the strategy */
  readonly name: string;

  /** Detailed description of the strategy */
  readonly description: string;

  /** What this strategy aims to achieve */
  readonly objective: string;

  /**
   * Research method specification (structured).
   * See `research_strategy_v1.schema.json` for the full schema.
   */
  readonly method: {
    /** Research approach name, used by generality scorer and method taxonomy lookup. */
    readonly approach: string;
    /** Required computation or analysis tools. */
    readonly tools: readonly string[];
    /** Optional theoretical model or framework. */
    readonly model?: string;
    /** Domain Packs may add additional method fields. */
    readonly [key: string]: unknown;
  };

  /**
   * Applicability constraints (structured).
   * Includes parameter ranges, approximations, and assumptions.
   */
  readonly constraints?: {
    /** Valid parameter ranges (keyed by parameter name). */
    readonly parameter_ranges?: Readonly<Record<string, ParameterRange>>;
    /** Approximations used, with validity conditions. */
    readonly approximations?: readonly Approximation[];
    /** Physical or mathematical assumptions (free-text list). */
    readonly assumptions?: readonly string[];
    /** Domain Packs may add additional constraint fields. */
    readonly [key: string]: unknown;
  };

  /**
   * What form the results should take.
   */
  readonly expected_outcome_form?: {
    /** Expected output quantities. */
    readonly quantities?: readonly ExpectedQuantity[];
    /** Expected result format (e.g., 'analytic_expression', 'numerical_table', 'formal_proof'). */
    readonly format?: string;
  };

  /**
   * Research domain identifier.
   * Examples: "hep-th", "hep-ph", "hep-lat", "gr-qc"
   */
  readonly domain: string;

  /**
   * Conditions under which this strategy applies.
   * Natural-language preconditions that must hold before
   * applying this strategy.
   */
  readonly applicable_when?: readonly string[];

  /**
   * Criteria for verifying outcomes produced by this strategy.
   * Each criterion specifies a check name, method, optional tolerance,
   * and whether it's required.
   */
  readonly validation_criteria: readonly ValidationCriterion[];

  /** Classification tags for search and filtering */
  readonly tags?: readonly string[];

  /** Strategy preset category for signal engine */
  readonly preset?: "explore" | "deepen" | "verify" | "consolidate";

  /** Schema version, always 1 for this version */
  readonly schema_version: 1;
}
```

### 3.3 ResearchOutcome

Replaces GEP's Capsule concept. A ResearchOutcome is a verified research result produced by applying a ResearchStrategy.

```typescript
/**
 * Verification status of a research outcome.
 */
export type OutcomeStatus =
  | "verified"     // Passed all verification checks
  | "pending"      // Awaiting verification
  | "rejected"     // Failed verification
  | "superseded";  // Replaced by a more precise/general result

/**
 * ResearchOutcome -- a verified research result.
 *
 * Replaces GEP Capsule for the scientific research domain.
 * Content-addressed by outcome_id (SHA-256 of canonical JSON,
 * excluding outcome_id itself).
 *
 * @example
 * {
 *   outcome_id: "b7e4d...",
 *   lineage_id: "550e8400-e29b-41d4-a716-446655440000",
 *   version: 1,
 *   strategy_ref: "a3f2c...",
 *   status: "verified",
 *   metrics: {
 *     "sigma_NLO_pb": { value: 831.76, uncertainty: 44.1, unit: "pb", method: "NLO fixed-order" },
 *     "K_factor": { value: 1.42, method: "NLO/LO ratio" },
 *     "scale_uncertainty_percent": { value: 5.3, method: "7-point variation" }
 *   },
 *   artifacts: [...],
 *   integrity_report_ref: "c9f1a...",
 *   confidence: 0.95,
 *   applicability_range: [...],
 *   produced_by: { agent_id: "hep-calc@1.2.0", tool_versions: { "FeynCalc": "10.0" } },
 *   supersedes: null,
 *   superseded_by: null,
 *   schema_version: 1
 * }
 */
export interface ResearchOutcome {
  /**
   * Content-addressed identifier.
   * SHA-256 of the canonical JSON serialization of all fields
   * EXCEPT outcome_id itself.
   */
  readonly outcome_id: string;

  /**
   * Stable identity across revisions (analogous to arXiv paper ID, e.g., 2301.12345).
   * Generated as UUID v4 on first publication. All subsequent versions within
   * the same research line inherit this value.
   * Query by lineage_id returns all versions; query by outcome_id returns one specific version.
   */
  readonly lineage_id: string;

  /**
   * Version number within the lineage, monotonically increasing.
   * First publication is version 1. Each revision increments by 1.
   * Invariant: within a lineage, version numbers are unique and contiguous.
   */
  readonly version: number;

  /**
   * Reference to the ResearchStrategy that produced this outcome.
   * This is the strategy_id of the applied strategy.
   */
  readonly strategy_ref: string;

  /** Verification status */
  readonly status: OutcomeStatus;

  /**
   * Key-value map of research results (physical quantities, derived
   * relations, proven statements, classification results, or other
   * domain-specific outcomes).
   * Keys are descriptive names; values are MetricValue objects with
   * value, optional uncertainty, unit, and method.
   *
   * @example
   * {
   *   "sigma_NLO_pb": { value: 831.76, uncertainty: 44.1, unit: "pb" },
   *   "K_factor": { value: 1.42, method: "NLO/LO ratio" },
   *   "mu_R_GeV": { value: 172.5, unit: "GeV" },
   *   "scheme": { value: "MSbar" }
   * }
   */
  readonly metrics: MetricsMap;

  /**
   * Evidence pointers -- references to artifacts that support
   * this outcome (calculation logs, notebooks, plots, etc.).
   */
  readonly artifacts: readonly ArtifactRef[];

  /**
   * Reference to the IntegrityReport that assessed this outcome.
   * This is the report_id of the associated IntegrityReport.
   * Null if integrity check has not been performed yet.
   */
  readonly integrity_report_ref?: string;

  /**
   * Confidence score in [0, 1].
   * 1.0 = fully verified by independent methods.
   * 0.0 = no verification performed.
   * Intermediate values reflect partial verification
   * (e.g., 0.7 = passed internal consistency check but not independently reproduced).
   */
  readonly confidence?: number;

  /**
   * Parameter space where this result is valid.
   * Keys are parameter names; values specify range and unit.
   */
  readonly applicability_range?: Record<string, { min?: number; max?: number; unit?: string }>;

  /**
   * Provenance: identification of the agent/tool that produced this outcome.
   */
  readonly produced_by: {
    readonly agent_id: string;
    readonly run_id?: string;
    readonly tool_versions?: Record<string, string>;
  };

  /**
   * Reproducibility verification status.
   * 'not_applicable' for formal proofs / non-computational outcomes.
   */
  readonly reproducibility_status?: "verified" | "pending" | "failed" | "not_applicable";

  /**
   * Content-addressed ID of the ReproducibilityReport (if any).
   */
  readonly reproducibility_report_ref?: string;

  /**
   * RDI (Research Desirability Index) scores.
   * Only populated after RDI evaluation; required when status is "verified".
   */
  readonly rdi_scores?: RdiScores;

  /**
   * ID of the outcome this one supersedes (if any).
   */
  readonly supersedes?: string;

  /**
   * ID of the outcome that superseded this one (if any).
   */
  readonly superseded_by?: string;

  /** ISO 8601 UTC Z timestamp of creation. */
  readonly created_at: string;

  /** Tags for classification and filtering. */
  readonly tags?: readonly string[];

  /** Schema version, always 1 for this version */
  readonly schema_version: 1;
}
```

### 3.4 ResearchEvent

Audit record of the research process. The event stream drives the REP signal engine (EVO-18).

```typescript
/**
 * Research event type enumeration.
 * Covers the full lifecycle of research strategy evolution.
 */
export type ResearchEventType =
  // Strategy lifecycle
  | "strategy_proposed"     // A new strategy has been proposed
  | "strategy_selected"     // A strategy has been selected for execution
  | "strategy_rejected"     // A proposed strategy was rejected (not viable)

  // Computation lifecycle
  | "computation_started"   // Computation has begun
  | "computation_completed" // Computation finished successfully
  | "computation_failed"    // Computation encountered an error

  // Verification lifecycle
  | "verification_started"  // Verification checks have begun
  | "verification_passed"   // All verification checks passed
  | "verification_failed"   // One or more verification checks failed

  // Outcome lifecycle
  | "outcome_published"     // Outcome has been published
  | "outcome_superseded"    // Outcome was superseded by a better result
  | "outcome_revoked"       // Outcome was revoked (found to be incorrect)

  // Integrity lifecycle
  | "integrity_check_started"   // Integrity assessment has begun
  | "integrity_check_completed" // Integrity assessment finished

  // Signal events (consumed by EVO-18 signal engine)
  | "signal_detected"       // A research signal was detected
  | "stagnation_detected"   // Research progress has stalled
  | "diagnostic_emitted";   // Non-signal diagnostic (e.g., taxonomy_miss)

/**
 * Type-specific event payload schemas.
 *
 * SSOT Note: The normative schema for ResearchEvent payloads is
 * schemas/research_event_v1.schema.json (discriminated union on event_type).
 * Interfaces below are illustrative and may include additional runtime fields.
 * When in doubt, the JSON Schema is authoritative.
 */
export interface StrategyProposedPayload {
  readonly strategy_id: string;
  readonly strategy_name: string;
  readonly preset: "explore" | "deepen" | "verify" | "consolidate";
  readonly triggering_signals?: readonly string[];
  readonly score?: number;
}

export interface StrategySelectedPayload {
  readonly strategy_id: string;
  readonly reason: string;
  readonly competing_strategies?: Array<{
    strategy_id?: string;
    score?: number;
  }>;
}

export interface StrategyRejectedPayload {
  readonly strategy_id: string;
  readonly reason: string;
}

export interface ComputationStartedPayload {
  readonly computation_id: string;
  readonly strategy_ref: string;
  readonly method: string;
  readonly tools?: readonly string[];
  readonly parameters?: Record<string, unknown>;
}

export interface ComputationCompletedPayload {
  readonly computation_id: string;
  readonly artifact_ref: Record<string, unknown>;  // ArtifactRef V1
  readonly metrics_summary?: Record<string, unknown>;
  readonly duration_ms?: number;
}

export interface ComputationFailedPayload {
  readonly computation_id: string;
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly retryable?: boolean;
  };
  /** Any partial results produced before the failure. */
  readonly partial_results?: Record<string, unknown>;
}

export interface VerificationStartedPayload {
  readonly verification_id: string;
  readonly original_computation_id: string;
  readonly method: string;   // Domain Pack defines available types
}

export interface VerificationPassedPayload {
  readonly verification_id: string;
  readonly deviation_report_ref: string;
  readonly max_relative_deviation?: number;
}

export interface VerificationFailedPayload {
  readonly verification_id: string;
  readonly deviation_report_ref: string;
  readonly reason: string;
  readonly max_relative_deviation?: number;
}

export interface OutcomePublishedPayload {
  readonly outcome_id: string;
  readonly strategy_ref: string;
  readonly rdi_rank_score?: number;
}

export interface OutcomeSupersededPayload {
  readonly outcome_id: string;
  readonly superseded_by: string;
  readonly reason: string;
}

export interface OutcomeRevokedPayload {
  readonly outcome_id: string;
  readonly reason: string;
}

export interface IntegrityCheckStartedPayload {
  readonly report_id: string;
  readonly target_ref: ArtifactRef;
  readonly domain: string;
  readonly checks?: readonly string[];   // Check IDs to be executed
}

export interface IntegrityCheckCompletedPayload {
  readonly report_id: string;
  readonly overall_status: "pass" | "fail" | "advisory_only";
  readonly blocking_failures?: readonly string[];
  readonly check_count?: number;
  readonly pass_count?: number;
  readonly fail_count?: number;
}

export interface SignalDetectedPayload {
  /** Reference to the ResearchSignal (UUID v4, matches ResearchSignal.signal_id) */
  readonly signal_id: string;
  /** Signal type from the EVO-18 signal engine */
  readonly signal_type:
    | "gap_detected"
    | "calculation_divergence"
    | "known_result_match"
    | "integrity_violation"
    | "method_plateau"
    | "parameter_sensitivity"
    | "cross_check_opportunity"
    | "stagnation";
  readonly confidence: number;
  readonly fingerprint?: string;
  readonly source_event_ids?: readonly string[];
}

export interface StagnationDetectedPayload {
  /** Number of consecutive empty evolution cycles */
  readonly consecutive_empty_cycles: number;
  /** Threshold that was exceeded */
  readonly threshold: number;
  /** Current strategy identifier */
  readonly current_strategy?: string;
  /** Recommended action */
  readonly recommended_action?: "switch_strategy" | "abandon_direction" | "request_guidance";
}

export interface DiagnosticEmittedPayload {
  /** Diagnostic type identifier (e.g., "taxonomy_miss", "config_warning"). */
  readonly diagnostic_type: string;
  /** Human-readable diagnostic message. */
  readonly message: string;
  /** Optional structured context data. */
  readonly context?: Record<string, unknown>;
  /** Severity level. */
  readonly severity?: "info" | "warning" | "error";
}

/**
 * Union type for all event payloads.
 * The discriminant is the event_type field on ResearchEvent.
 */
export type ResearchEventPayload =
  | StrategyProposedPayload
  | StrategySelectedPayload
  | StrategyRejectedPayload
  | ComputationStartedPayload
  | ComputationCompletedPayload
  | ComputationFailedPayload
  | VerificationStartedPayload
  | VerificationPassedPayload
  | VerificationFailedPayload
  | OutcomePublishedPayload
  | OutcomeSupersededPayload
  | OutcomeRevokedPayload
  | IntegrityCheckStartedPayload
  | IntegrityCheckCompletedPayload
  | SignalDetectedPayload
  | StagnationDetectedPayload
  | DiagnosticEmittedPayload;

/**
 * ResearchEvent -- audit record of the research process.
 *
 * Events are the primary input for the REP signal engine (EVO-18).
 * They form an append-only stream that drives strategy evolution.
 *
 * @example
 * {
 *   event_id: "a1b2c3d4-...",
 *   event_type: "computation_completed",
 *   timestamp: "2026-02-21T14:30:00.000Z",
 *   run_id: "run_550e8400-...",
 *   trace_id: "trace_a1b2c3d4-...",
 *   payload: {
 *     strategy_ref: "a3f2c...",
 *     outcome_id: "b7e4d...",
 *     duration_seconds: 3600,
 *     resource_usage: { cpu_seconds: 3200, memory_peak_mb: 4096 }
 *   },
 *   schema_version: 1
 * }
 */
export interface ResearchEvent {
  /** UUID v4 unique event identifier */
  readonly event_id: string;

  /** Type of research event */
  readonly event_type: ResearchEventType;

  /** ISO 8601 UTC timestamp of when the event occurred */
  readonly timestamp: string;

  /**
   * Run identifier for correlation.
   * Links this event to a specific research run.
   */
  readonly run_id: string;

  /**
   * Trace identifier for cross-component correlation.
   * Aligned with H-02 trace_id format (UUID v4).
   */
  readonly trace_id?: string;

  /**
   * Monotonically increasing integer for event ordering within a run.
   * event_id (UUID) is for dedup only — ordering uses sequence_number.
   */
  readonly sequence_number?: number;

  /**
   * Type-specific event data.
   * The shape of this object is determined by event_type.
   */
  readonly payload: ResearchEventPayload;

  /** Schema version, always 1 for this version */
  readonly schema_version: 1;
}
```

### 3.5 IntegrityReport

Scientific integrity assessment with no GEP equivalent. This is the structured output of the EVO-06 integrity check framework.

```typescript
/**
 * Severity level of an integrity check (SSOT enum).
 */
export type IntegrityCheckSeverity = "blocking" | "advisory";

/**
 * Result of a single integrity check.
 * (Illustrative — integrity_report_v1.schema.json IntegrityCheckResult is the normative SSOT)
 */
export interface IntegrityCheckResult {
  /** Unique identifier for this check */
  readonly check_id: string;

  /** Human-readable name of the check. */
  readonly check_name: string;

  /** Outcome of the check. */
  readonly status: "pass" | "fail" | "advisory" | "skipped";

  /** Whether this check is blocking (prevents publication) or advisory (informational). */
  readonly severity: IntegrityCheckSeverity;

  /** Confidence in the check result (0-1). */
  readonly confidence?: number;

  /** Supporting evidence for this check result. */
  readonly evidence?: readonly Evidence[];

  /** Human-readable explanation of the result. */
  readonly message: string;

  /** Suggested remediation if check failed. */
  readonly remediation?: string;

  /** Wall-clock duration of the check in milliseconds. */
  readonly duration_ms?: number;
}

/**
 * IntegrityReport -- scientific integrity assessment.
 *
 * No GEP equivalent. This is the structured output of the
 * EVO-06 integrity check framework. It aggregates results from
 * multiple domain-specific integrity checks into a single report.
 *
 * The RDI fail-closed gate (Section 4) uses IntegrityReport
 * as one of its mandatory inputs.
 *
 * @example
 * {
 *   schema_version: 1,
 *   report_id: "c9f1a...",
 *   target_ref: { uri: "rep://outcomes/b7e4d...", sha256: "a1b2c..." },
 *   checks: [...],
 *   overall_status: "pass",
 *   blocking_failures: [],
 *   domain: "hep-ph",
 *   created_at: "2026-02-21T15:00:00.000Z"
 * }
 */
// (Illustrative — integrity_report_v1.schema.json is the normative SSOT)
export interface IntegrityReport {
  readonly schema_version: 1;

  /**
   * Content-addressed identifier.
   * SHA-256 of the canonical JSON serialization of all fields
   * EXCEPT report_id itself.
   */
  readonly report_id: string;

  /** Reference to the artifact that was assessed. */
  readonly target_ref: ArtifactRef;

  /** Individual check results from domain pack checks. */
  readonly checks: readonly IntegrityCheckResult[];

  /**
   * Aggregated status across all checks.
   * "fail" if any blocking check failed.
   * "pass" if all blocking checks passed and no failures.
   * "advisory_only" if no blocking checks exist and some advisory findings.
   */
  readonly overall_status: "pass" | "fail" | "advisory_only";

  /** IDs of blocking checks that failed. Empty = gate is open. */
  readonly blocking_failures?: readonly string[];

  /** Research domain of this report. */
  readonly domain: string;

  /** Version of the domain pack used for checks. */
  readonly domain_pack_version?: string;

  /** Run in which this report was generated. */
  readonly run_id?: string;

  /** Trace ID for cross-layer correlation. */
  readonly trace_id?: string;

  /** ISO 8601 UTC Z timestamp of report creation. */
  readonly created_at: string;

  /** Total time taken for all checks in milliseconds. */
  readonly duration_ms?: number;
}
```

---

## 4. RDI Scoring Formula

RDI (Research Desirability Index) replaces GEP's GDI (Global Desirability Index) with a dual-layer structure specifically designed for scientific research.

### 4.1 Design Principles

1. **Fail-closed gate**: No override mechanism. If the gate fails, the asset cannot be published or reused, period.
2. **Ranking score only for gated assets**: The ranking score is irrelevant for assets that have not passed the gate.
3. **Locally computable**: All RDI inputs must be computable from local data (no dependency on external ranking services).
4. **Deterministic**: Given the same inputs, RDI always produces the same output.

### 4.2 Fail-Closed Gate (Binary Pass/Fail)

The gate consists of four mandatory checks. ALL must pass for the asset to proceed.

```typescript
/**
 * RDI gate check result.
 */
export interface RdiGateResult {
  /** Whether the gate passed */
  readonly passed: boolean;

  /** Individual check results */
  readonly checks: {
    readonly integrity_status: boolean;
    readonly blocking_checks: boolean;
    readonly reproducibility: boolean;
    readonly content_hash: boolean;
  };

  /** IDs of failed checks (empty if passed) */
  readonly failed_checks: readonly string[];

  /** ISO 8601 timestamp of gate evaluation */
  readonly evaluated_at: string;
}
```

**Gate check definitions**:

| # | Check | Condition | Failure Meaning |
|---|---|---|---|
| G1 | Integrity report status | `integrity_report.overall_status !== "fail"` | The integrity assessment found critical violations |
| G2 | Blocking checks passed | All checks where `blocking === true` have `status === "pass"` | A mandatory scientific check failed |
| G3 | Reproducibility verified | `reproducibility_verified === true` OR `reproducibility_not_applicable === true` | Result cannot be independently reproduced |
| G4 | Content hash valid | SHA-256 of asset matches `content_hash` in the envelope | Asset has been tampered with or corrupted |

**Pseudocode for gate evaluation**:

```
function evaluateRdiGate(
  outcome: ResearchOutcome,
  integrityReport: IntegrityReport | null,
  envelope: RepEnvelope,
  reproducibilityStatus: { verified: boolean; not_applicable: boolean }
): RdiGateResult {

  failed_checks = []

  // G1: Integrity report status
  if integrityReport is null:
    failed_checks.push("G1_NO_INTEGRITY_REPORT")
  else if integrityReport.overall_status === "fail":
    failed_checks.push("G1_INTEGRITY_FAILED")

  // G2: All blocking checks passed
  if integrityReport is not null:
    for check in integrityReport.checks:
      if check.blocking and check.status !== "pass":
        failed_checks.push("G2_BLOCKING_CHECK_" + check.check_id)

  // G3: Reproducibility verified (if applicable)
  if not reproducibilityStatus.not_applicable:
    if not reproducibilityStatus.verified:
      failed_checks.push("G3_NOT_REPRODUCED")

  // G4: Content hash valid
  computed_hash = contentHash(outcome excluding outcome_id)
  if computed_hash !== outcome.outcome_id:
    failed_checks.push("G4_HASH_MISMATCH")

  // Also verify envelope content_hash (when present — optional in SSOT)
  if envelope.content_hash !== undefined:
    envelope_hash = contentHash(envelope.payload)
    if envelope_hash !== envelope.content_hash:
      failed_checks.push("G4_ENVELOPE_HASH_MISMATCH")

  return {
    passed: failed_checks.length === 0,
    checks: {
      integrity_status: not failed_checks.any(startsWith("G1")),
      blocking_checks: not failed_checks.any(startsWith("G2")),
      reproducibility: not failed_checks.any(startsWith("G3")),
      content_hash: not failed_checks.any(startsWith("G4")),
    },
    failed_checks: failed_checks,
    evaluated_at: now_iso()
  }
}
```

**Critical constraint**: There is no override mechanism for the gate. If ANY check fails, the asset is rejected. This is the GATE rule from the Ecosystem Development Contract applied to research evolution. The gate is evaluated at `publish` time and at `fetch` time (re-verification).

### 4.3 Ranking Score (0-1, For Passed Assets Only)

Assets that have passed the fail-closed gate are ranked using a four-dimensional weighted formula:

```
RDI_rank = w_n * novelty + w_g * generality + w_s * significance + w_c * citation_impact

where (default weights):
  w_n = 0.40  (novelty weight)
  w_g = 0.20  (methodological generality weight)
  w_s = 0.20  (problem significance weight)
  w_c = 0.20  (local citation impact weight)
```

**Design rationale (four orthogonal dimensions)**:

These four dimensions correspond to genuinely independent aspects of research quality, aligned with the UK Research Excellence Framework (REF) assessment criteria:

| RDI Dimension | Measures | REF Analogue |
|---|---|---|
| Novelty | How different is this result from known literature? | Originality |
| Generality | How broadly applicable is the methodology? | Rigour (method soundness) |
| Significance | How important is the problem being addressed? | Significance |
| Citation Impact | How valued is this result by the community? | (empirical validation) |

Significance is separated from Generality because they are orthogonal: a study can address a fundamental problem (high significance) with a highly specific method (low generality), or vice versa. Conflating the two would systematically undervalue focused-but-important research (e.g., confinement mechanism, muon g-2 HVP contributions).

```typescript
/**
 * RDI ranking score configuration.
 * Domain Packs may override defaults within allowed bounds.
 */
export interface RdiWeights {
  readonly novelty: number;        // Default: 0.40, range: [0.30, 0.55]
  readonly generality: number;     // Default: 0.20, range: [0.10, 0.30]
  readonly significance: number;   // Default: 0.20, range: [0.10, 0.30]
  readonly citation_impact: number; // Default: 0.20, range: [0.10, 0.30]
  // Invariant: sum of all weights must equal 1.0
}

export const DEFAULT_RDI_WEIGHTS: RdiWeights = {
  novelty: 0.40,
  generality: 0.20,
  significance: 0.20,
  citation_impact: 0.20,
};

/**
 * Allowed weight override bounds (enforced at config validation time).
 * Domain Pack weight overrides outside these bounds are rejected.
 */
export const RDI_WEIGHT_BOUNDS: Record<keyof RdiWeights, [number, number]> = {
  novelty: [0.30, 0.55],
  generality: [0.10, 0.30],
  significance: [0.10, 0.30],
  citation_impact: [0.10, 0.30],
};

/**
 * RDI ranking score result.
 */
export interface RdiRankResult {
  /** Overall ranking score in [0, 1] */
  readonly score: number;

  /** Individual component scores */
  readonly components: {
    readonly novelty: number;        // [0, 1]
    readonly generality: number;     // [0, 1]
    readonly significance: number;   // [0, 1]
    readonly citation_impact: number; // [0, 1]
  };

  /** Weights used for this calculation */
  readonly weights: RdiWeights;

  /** ISO 8601 timestamp of score calculation */
  readonly scored_at: string;
}
```

#### 4.3.1 Novelty Score (0-1)

**Definition**: `novelty = 1 - max_similarity(outcome, known_results_corpus)`

The novelty score measures how different this outcome is from all known results. A completely novel result scores 1.0; a result identical to existing literature scores 0.0.

**Normalization method**:

```
novelty(outcome) = 1 - max(cosine_similarity(fingerprint(outcome), fingerprint(known_i))
                          for known_i in known_results_corpus)
```

Where `fingerprint(outcome)` produces a vector encoding:
- Method signature: the research approach (one-hot or embedding)
- Result type: the kind of quantity or statement produced
- Parameter regime: the applicable range of parameters
- Key results: the headline numbers or statements

**Known results corpus**: Two sources contribute to the corpus:

1. **Local corpus**: All previously published `ResearchOutcome` instances in the local store.
2. **External literature service**: Query results from a `LiteratureService` provider configured by the Domain Pack (see below).

```typescript
/**
 * Domain-agnostic interface for querying external literature.
 * Implementations are provided by the Domain Pack or configured at runtime.
 *
 * Known implementations:
 *   - HEP: INSPIRE (inspirehep.net/api) — via hep-research MCP server
 *   - General academic: CrossRef (api.crossref.org), OpenAlex (api.openalex.org),
 *     Semantic Scholar (api.semanticscholar.org)
 *   - Mathematics: zbMATH (zbmath.org/api)
 */
export interface LiteratureService {
  /**
   * Search for results similar to the given outcome.
   * Returns records that the novelty scorer can fingerprint and compare.
   */
  searchSimilar(outcome: ResearchOutcome, limit?: number): Promise<LiteratureRecord[]>;

  /** Service identifier for diagnostics (e.g., "inspire", "crossref", "openalex"). */
  readonly serviceId: string;
}

/**
 * A record from an external literature service, normalized to a common shape.
 * Domain Packs define how to map service-specific responses to this type.
 */
export interface LiteratureRecord {
  /** Service-specific identifier (e.g., INSPIRE recid, CrossRef DOI, OpenAlex work ID) */
  readonly record_id: string;
  /** Title of the work */
  readonly title: string;
  /** Service identifier matching LiteratureService.serviceId (e.g., "inspire", "crossref") */
  readonly source: string;
  /** Structured metadata for fingerprinting (method, results, parameter ranges) */
  readonly metadata: Record<string, unknown>;
}
```

**Pseudocode**:

```
function computeNovelty(
  outcome: ResearchOutcome,
  knownCorpus: ResearchOutcome[],
  literatureRecords: LiteratureRecord[],
  fingerprintConfig?: FingerprintConfig
): number {

  // Build fingerprint for the target outcome
  target_fp = buildFingerprint(outcome)

  max_sim = 0.0

  // Compare against local known outcomes
  for known in knownCorpus:
    known_fp = buildFingerprint(known)
    sim = cosineSimilarity(target_fp, known_fp)
    max_sim = max(max_sim, sim)

  // Compare against external literature
  for record in literatureRecords:
    record_fp = buildLiteratureFingerprint(record, fingerprintConfig)
    sim = cosineSimilarity(target_fp, record_fp)
    max_sim = max(max_sim, sim)

  return clamp(1.0 - max_sim, 0.0, 1.0)
}

function buildFingerprint(outcome: ResearchOutcome): number[] {
  // Concatenate normalized features into a fixed-length vector:
  // [method_embedding(64d), result_type(16d), param_range(8d), headline_numbers(8d)]
  // Total: 96-dimensional fingerprint vector
  // The embedding functions are provided by the Domain Pack's fingerprint_config.
  return concat(
    methodEmbedding(outcome.strategy_ref),   // 64 dims
    resultTypeEncoding(outcome.metrics),      // 16 dims
    paramRangeEncoding(outcome.applicability_range), // 8 dims
    headlineEncoding(outcome.metrics)         // 8 dims
  )
}

/**
 * Build a fingerprint from an external literature record.
 * Uses the Domain Pack's fingerprint_config to extract structured features
 * from the record's unstructured metadata.
 *
 * The fingerprint_config defines extraction adapters for each service:
 *   - method_vectors: maps service-specific metadata fields to method embeddings
 *   - observable_vocabulary: maps metadata fields to result-type encodings
 *
 * When fingerprint_config is not available, falls back to a zero-padded
 * vector with only the title-based embedding populated.
 */
function buildLiteratureFingerprint(
  record: LiteratureRecord,
  fingerprintConfig: FingerprintConfig | undefined
): number[] {
  if fingerprintConfig is not undefined:
    // Use Domain Pack adapter to extract structured features.
    // SDK implementation note: each extract* method is an SDK helper that reads the
    // field path declared in `domain_pack_manifest.fingerprint_config.literature_record_adapter`
    // (e.g., method_field: "arxiv_categories"), extracts the raw value from record.metadata,
    // and applies the domain's vector embedding/encoding to produce fixed-dim floats.
    method_emb = fingerprintConfig.extractMethodEmbedding(record.metadata)  // 64 dims
    result_enc = fingerprintConfig.extractResultType(record.metadata)       // 16 dims
    param_enc  = fingerprintConfig.extractParamRange(record.metadata)       // 8 dims
    headline   = fingerprintConfig.extractHeadline(record.metadata)         // 8 dims
    return concat(method_emb, result_enc, param_enc, headline)
  else:
    // Fallback: title-only fingerprint (reduced accuracy, non-zero)
    return concat(
      titleEmbedding(record.title),  // 64 dims (simple bag-of-words or hash)
      zeros(16),                     // no result type info
      zeros(8),                      // no param range info
      zeros(8)                       // no headline info
    )
}

function cosineSimilarity(a: number[], b: number[]): number {
  dot = sum(a[i] * b[i] for i in range(len(a)))
  norm_a = sqrt(sum(a[i]^2 for i in range(len(a))))
  norm_b = sqrt(sum(b[i]^2 for i in range(len(b))))
  if norm_a == 0 or norm_b == 0:
    return 0.0
  return dot / (norm_a * norm_b)
}
```

**Fallback when literature service is unavailable**: If the external literature service fails (network error, rate limit, service not configured), novelty is computed against only the local corpus. If the local corpus is also empty, novelty defaults to 0.5 (neutral -- neither novel nor duplicate).

#### 4.3.2 Generality Score (0-1)

**Definition**: Methodological generality — how broadly applicable is the method and how transferable are the results?

With significance extracted as an independent dimension (Section 4.3.3), generality now purely measures methodological properties. It uses a three-factor weighted score:

```
generality = 0.50 * method_class + 0.25 * result_breadth + 0.25 * assumption_lightness
```

**Factor 1: Method Class (weight 0.50)**

The method's inherent generality, looked up from the Domain Pack's `scoring_config.method_taxonomy`. This reflects how broadly applicable the computational/analytical approach is, independent of the specific problem.

```
method_class(strategy) = scoring_config.method_taxonomy[strategy.method.approach]
                         ?? 0.5  // fallback for unknown methods + taxonomy_miss diagnostic event
```

> **Domain Pack example (HEP)**: Lattice QCD → 0.90 (first-principles, applies broadly), fixed-order pQCD → 0.70 (wide applicability but limited to perturbative regime), specific kinematic approximation → 0.30.

**Factor 2: Result Breadth (weight 0.25)**

How many semantically distinct result types does the outcome produce, relative to a reference count for the domain? Uses the Domain Pack's `fingerprint_config.observable_vocabulary` to classify metric keys into distinct observable classes, preventing gaming via artificial key splitting.

```
result_breadth(outcome) = clamp(
  |distinct_observable_classes(outcome.metrics, fingerprintConfig)| / reference_metric_count,
  0.0, 1.0
)
```

Where `distinct_observable_classes()` maps each metric key to an observable class via `fingerprint_config.observable_vocabulary`. If the Domain Pack provides no `observable_vocabulary` (i.e., `fingerprintConfig` is undefined), `result_breadth` defaults to 0.5 (neutral) to prevent trivial key-splitting gaming. `reference_metric_count` comes from `scoring_config.reference_metric_count` (Domain Pack configurable, default: 10).

**Factor 3: Assumption Lightness (weight 0.25)**

Fewer approximations and assumptions yield a higher score (less restrictive = more general). Uses exponential decay to avoid a hard cliff at `ref_max`:

```
assumption_lightness(strategy) = exp(
  -ln(2) * (|strategy.constraints.approximations| + |strategy.constraints.assumptions|) / ref_max
)
)
```

Where `ref_max` comes from `scoring_config.reference_assumption_count` (Domain Pack configurable, default: 10).

**Pseudocode**:

```
function computeGenerality(
  outcome: ResearchOutcome,
  strategy: ResearchStrategy,
  scoringConfig: ScoringConfig,
  fingerprintConfig?: FingerprintConfig
): number {

  // Factor 1: Method Class — taxonomy lookup (method_taxonomy may be undefined)
  method_class = (scoringConfig.method_taxonomy ?? {})[strategy.method.approach] ?? 0.5
  if method_class was fallback:
    emit diagnostic_emitted event { diagnostic_type: "taxonomy_miss", message: "Unknown method approach: " + strategy.method.approach, context: { approach: strategy.method.approach } }

  // Factor 2: Result Breadth — distinct observable class count (anti-gaming)
  if fingerprintConfig is undefined:
    result_breadth = 0.5  // neutral fallback, prevents key-splitting gaming
  else:
    observable_classes = distinctObservableClasses(outcome.metrics, fingerprintConfig)
    ref_metric_count = scoringConfig.reference_metric_count ?? 10
    result_breadth = clamp(observable_classes.size / max(1, ref_metric_count), 0.0, 1.0)

  // Factor 3: Assumption Lightness — fewer assumptions = more general (exponential decay)
  n_approx = (strategy.constraints?.approximations ?? []).length
  n_assume = (strategy.constraints?.assumptions ?? []).length
  ref_max = scoringConfig.reference_assumption_count ?? 10
  assumption_lightness = exp(-ln(2) * (n_approx + n_assume) / ref_max)

  // Weighted combination
  return 0.50 * method_class + 0.25 * result_breadth + 0.25 * assumption_lightness
}
```

#### 4.3.3 Significance Score (0-1)

**Definition**: How important is the research problem being addressed to the field?

This dimension captures the centrality and downstream impact potential of the problem, independent of the method used or the breadth of outputs. It addresses a fundamental limitation of breadth-only metrics: highly specific but foundational research (e.g., confinement mechanism, muon g-2 HVP) would be systematically undervalued by breadth measures alone.

**Design motivation**: The UK Research Excellence Framework (REF) evaluates significance as an independent dimension alongside originality and rigour. This separation reflects the observation that significance and generality are orthogonal — a study can address a fundamental problem (high significance) using a highly specific method (low generality), or vice versa.

**Primary signal: Problem taxonomy lookup**

The Domain Pack's `scoring_config.problem_taxonomy` classifies research problems by significance tier:

```jsonc
// Example: HEP Domain Pack scoring_config.problem_taxonomy
{
  "problem_classes": {
    "fundamental_mechanism": {
      "base_significance": 0.90,
      "description": "Resolution would reshape field understanding",
      "examples": ["confinement", "mass_gap", "strong_cp", "hierarchy_problem"]
    },
    "precision_frontier": {
      "base_significance": 0.85,
      "description": "Standard Model precision tests at the frontier",
      "examples": ["muon_g-2_hvp", "alpha_s_determination", "ckm_unitarity"]
    },
    "bsm_search": {
      "base_significance": 0.80,
      "description": "Direct searches for physics beyond the Standard Model",
      "examples": ["dark_matter_direct", "neutrinoless_double_beta", "proton_decay"]
    },
    "formal_development": {
      "base_significance": 0.75,
      "description": "Mathematical structure, dualities, and formal results",
      "examples": ["ads_cft_correspondence", "amplitude_bootstrap", "swampland_conjecture"]
    },
    "phenomenology_tool": {
      "base_significance": 0.50,
      "description": "Predictions and tools for experimental analysis",
      "examples": ["nlo_cross_section", "parton_shower_tuning", "pdf_fitting"]
    }
  }
}
```

**Fallback: Unknown problems**

When the outcome does not match any taxonomy entry, significance defaults to 0.5 (neutral) with a `diagnostic_emitted` event (type `taxonomy_miss`) emitted via the ResearchEvent stream. This is the same fallback strategy used for Method Class in the generality score.

**Pseudocode**:

```
function computeSignificance(
  outcome: ResearchOutcome,
  strategy: ResearchStrategy,
  scoringConfig: ScoringConfig
): number {

  // Step 1: Classify the problem via taxonomy (problem_taxonomy may be undefined)
  problem_class = classifyProblem(outcome, strategy, scoringConfig.problem_taxonomy ?? { problem_classes: {} })

  if problem_class is not null:
    return problem_class.base_significance

  // Step 2: Fallback — neutral score + signal
  emit diagnostic_emitted event { diagnostic_type: "taxonomy_miss", message: "No matching problem class for outcome", context: { outcome, strategy } }
  return 0.5
}

function classifyProblem(
  outcome: ResearchOutcome,
  strategy: ResearchStrategy,
  taxonomy: ProblemTaxonomy
): ProblemClass | null {

  // Collect all candidate matches with scores.
  // Uses structured matching (not substring) to avoid gaming.
  candidates: Array<{ class_def: ProblemClass, match_score: number }> = []

  for class_id, class_def in taxonomy.problem_classes:
    match_score = 0.0

    // Signal 1: Exact tag match (strongest signal, hard to game)
    tag_hits = count(example for example in class_def.examples if example in (strategy.tags ?? []))
    match_score += tag_hits * 1.0

    // Signal 2: Outcome metric key exact match with class examples (normalized)
    metric_keys = Set(lowercase(Object.keys(outcome.metrics)))
    metric_hits = count(example for example in class_def.examples if lowercase(example) in metric_keys)
    match_score += metric_hits * 0.5

    // Note: Objective text is NOT used for matching (too easy to game via prompt injection).
    // If LLM-based classification is available, it can be added as Signal 3 in a future version.

    if match_score > 0:
      candidates.push({ class_def, match_score })

  if candidates.length == 0:
    return null

  // Deterministic tie-breaking: sort by match_score desc, then by base_significance desc
  candidates.sort(by: (a, b) => {
    if a.match_score != b.match_score: return b.match_score - a.match_score
    return b.class_def.base_significance - a.class_def.base_significance
  })

  return candidates[0].class_def
}
```

**Future extension: Connectivity graph**

For domains with well-defined problem dependency graphs (where resolving problem A enables progress on problems B, C, D...), the Domain Pack may optionally provide a `connectivity_graph`. This would allow significance to be estimated from the number of downstream problems a result unblocks, rather than relying solely on the taxonomy. This is deferred to a future version.

**Future extension: Automatic Taxonomy Expansion**

Static taxonomies (`method_taxonomy`, `problem_taxonomy`) are sufficient for well-established domains but become a maintenance bottleneck as the agent explores novel territory. When the SDK encounters an unknown method approach or problem that triggers a `taxonomy_miss` diagnostic, no scoring information is captured — the neutral 0.5 fallback is applied and the miss is logged, but the taxonomy itself never grows.

Automatic taxonomy expansion closes this gap by consuming `taxonomy_miss` events and proposing new taxonomy entries for human or automated approval. The design follows a three-stage pipeline:

**Stage 1 — Accumulation**: The `TaxonomyExpansionService` subscribes to the `diagnostic_emitted` event stream and filters for `diagnostic_type: "taxonomy_miss"`. Each miss is accumulated with its full context (strategy, outcome, method approach, metric keys). Accumulation is batched: a proposal is generated only after `min_miss_count` (default: 3) distinct misses share a common pattern (e.g., same `method.approach` value, or outcomes with overlapping metric keys).

**Stage 2 — Classification & Proposal**: Once a batch threshold is met, the service generates a `TaxonomyProposal`:

```typescript
interface TaxonomyProposal {
  readonly proposal_id: string;
  readonly taxonomy_target: "method_taxonomy" | "problem_taxonomy";
  readonly proposed_key: string;          // e.g., "neural_operator" or "phase_transition"
  readonly proposed_value: number | ProblemClass;  // generality score or problem class def
  readonly evidence: ReadonlyArray<{
    event_id: string;                     // originating taxonomy_miss event
    strategy_summary: string;
    outcome_summary: string;
  }>;
  readonly classification_method: "rule_based" | "llm_assisted" | "clustering";
  readonly confidence: number;            // 0-1
  readonly created_at: string;            // ISO-8601
}
```

Classification methods (in order of preference):
1. **Rule-based**: Exact tag/metric-key matching against existing taxonomy entries to find the nearest neighbor; interpolate score.
2. **Clustering**: Group accumulated misses by feature similarity (method approach, metric keys, tags); assign score from cluster centroid.
3. **LLM-assisted**: When available, use the agent's LLM to classify the unknown method/problem against the existing taxonomy and propose a score. The LLM prompt includes the full taxonomy and the miss context. This is optional and requires `llm_classification_enabled: true` in the Domain Pack config.

**Stage 3 — Approval Gate**: Proposals are surfaced via a `taxonomy_expansion_proposed` diagnostic event. The approval policy is configured in the Domain Pack manifest:

```jsonc
// domain_pack_manifest_v1 — scoring_config extension
{
  "scoring_config": {
    "method_taxonomy": { /* ... existing ... */ },
    "problem_taxonomy": { /* ... existing ... */ },
    "taxonomy_expansion": {
      "enabled": true,
      "min_miss_count": 3,
      "auto_approve_threshold": 0.9,   // confidence >= 0.9 → auto-commit
      "require_human_review": false,    // when true, all proposals require explicit approval
      "max_pending_proposals": 50
    }
  }
}
```

Approval modes:
- **Auto-approve**: If `confidence >= auto_approve_threshold` and `require_human_review` is `false`, the entry is committed directly to the runtime `ScoringConfig`. A `taxonomy_entry_added` diagnostic event is emitted for auditability.
- **Human review**: The proposal is held in a pending queue. An external review interface (out of SDK scope) consumes pending proposals and calls `sdk.approveTaxonomyProposal(proposal_id)` or `sdk.rejectTaxonomyProposal(proposal_id, reason)`.
- **Batch review**: At the end of a research cycle, all pending proposals can be reviewed together.

**Runtime behavior**: Approved entries are merged into the in-memory `ScoringConfig` and persisted to the Domain Pack's `scoring_config` file. Subsequent scoring calls immediately benefit from the expanded taxonomy. The original `taxonomy_miss` fallback of 0.5 remains unchanged for entries that have not yet been proposed or approved.

**Auditability**: Every taxonomy change (add, update, reject) is recorded as a `diagnostic_emitted` event with `diagnostic_type` values: `taxonomy_expansion_proposed`, `taxonomy_entry_added`, `taxonomy_entry_rejected`. This provides a full audit trail from miss → proposal → decision.

**Pseudocode**:

```
class TaxonomyExpansionService {
  private missAccumulator: Map<string, TaxonomyMissRecord[]> = new Map()
  private pendingProposals: Map<string, TaxonomyProposal> = new Map()
  private config: TaxonomyExpansionConfig

  onDiagnosticEvent(event: ResearchEvent): void {
    if event.payload.diagnostic_type != "taxonomy_miss": return

    key = extractMissKey(event)  // e.g., method.approach or problem tag set
    this.missAccumulator.get(key)?.push(event) ?? this.missAccumulator.set(key, [event])

    if this.missAccumulator.get(key).length >= this.config.min_miss_count:
      proposal = this.generateProposal(key, this.missAccumulator.get(key))
      this.pendingProposals.set(proposal.proposal_id, proposal)
      emit diagnostic_emitted { diagnostic_type: "taxonomy_expansion_proposed", context: proposal }

      if proposal.confidence >= this.config.auto_approve_threshold
         && !this.config.require_human_review:
        this.commitProposal(proposal)

  private commitProposal(proposal: TaxonomyProposal): void {
    // Ensure taxonomy objects exist (scoring_config and its sub-fields are optional in SSOT)
    if proposal.taxonomy_target == "method_taxonomy":
      scoringConfig.method_taxonomy ??= {}
      scoringConfig.method_taxonomy[proposal.proposed_key] = proposal.proposed_value
    else:
      scoringConfig.problem_taxonomy ??= { problem_classes: {} }
      scoringConfig.problem_taxonomy.problem_classes ??= {}
      scoringConfig.problem_taxonomy.problem_classes[proposal.proposed_key] = proposal.proposed_value
    emit diagnostic_emitted { diagnostic_type: "taxonomy_entry_added", context: proposal }
    this.missAccumulator.delete(extractMissKey(proposal))
    this.pendingProposals.delete(proposal.proposal_id)
}
```

#### 4.3.4 Local Citation Impact Score (0-1)

**Definition**: `citation_impact = local_citations / max(local_citations_in_corpus)`

This measures how frequently this outcome is referenced by other outcomes in the local agent-arxiv. A result that is foundational (many references) scores high; an unreferenced result scores 0.0.

**Normalization method**:

```
citation_impact(outcome) = C(outcome) / C_max

where:
  C(outcome) = number of ResearchOutcomes in the local corpus
               whose artifacts or strategy_ref reference this outcome
  C_max      = max(C(o) for o in local_corpus)
```

**Pseudocode**:

```
function computeCitationImpact(
  outcome: ResearchOutcome,
  localCorpus: ResearchOutcome[]
): number {

  // Count how many outcomes reference this one
  target_id = outcome.outcome_id
  citation_count = 0
  max_citations = 0

  // Build citation index
  citation_counts = {}
  for o in localCorpus:
    refs = extractReferences(o)  // from artifacts, strategy_ref, supersedes
    for ref_id in refs:
      citation_counts[ref_id] = (citation_counts[ref_id] or 0) + 1

  // Find max citations in corpus
  for count in citation_counts.values():
    max_citations = max(max_citations, count)

  if max_citations == 0:
    return 0.0

  my_citations = citation_counts[target_id] or 0
  return clamp(my_citations / max_citations, 0.0, 1.0)
}

function extractReferences(outcome: ResearchOutcome): string[] {
  refs = []
  refs.push(outcome.strategy_ref)
  if outcome.supersedes:
    refs.push(outcome.supersedes)
  for artifact in outcome.artifacts:
    // Extract outcome IDs referenced in artifact URIs
    if artifact.uri contains "outcomes/":
      refs.push(extractOutcomeId(artifact.uri))
  return refs
}
```

**Cold start**: When the local corpus is empty or has no cross-references, all outcomes receive a citation_impact of 0.0. This is expected -- citation impact is a lagging indicator that becomes meaningful as the corpus grows.

### 4.4 Complete RDI Computation

```typescript
/**
 * Configuration for RDI scoring, provided by the Domain Pack.
 * Contains method taxonomy, problem taxonomy, reference values,
 * and literature service configuration.
 *
 * All fields are optional. When omitted, the SDK materializes defaults:
 * - method_taxonomy: empty (all methods fall back to 0.5)
 * - problem_taxonomy: empty (all problems fall back to 0.5)
 * - reference_metric_count: 10
 * - reference_assumption_count: 10
 * - literature_service_id: undefined (novelty uses local corpus only)
 *
 * The domain_pack_manifest_v1 schema treats scoring_config as optional;
 * the SDK must tolerate its absence.
 */
export interface ScoringConfig {
  /** Method approach → generality score (0-1). Default: {} (fallback 0.5). */
  readonly method_taxonomy?: Record<string, number>;

  /** Problem classification for significance scoring. Default: empty taxonomy (fallback 0.5). */
  readonly problem_taxonomy?: ProblemTaxonomy;

  /** Reference metric count for result_breadth normalization. Default: 10. */
  readonly reference_metric_count?: number;

  /** Reference assumption count for assumption_lightness normalization. Default: 10. */
  readonly reference_assumption_count?: number;

  /**
   * Literature service identifier for novelty scoring.
   * The Domain Pack specifies which external service to use for
   * querying published results. If not set, novelty uses local corpus only.
   *
   * Known service IDs: "inspire" (HEP), "crossref", "openalex",
   * "semantic_scholar", "zbmath" (mathematics).
   * Implementations are provided by the runtime environment (e.g., MCP servers).
   */
  readonly literature_service_id?: string;

  /**
   * Automatic taxonomy expansion configuration.
   * When enabled, taxonomy_miss diagnostics are accumulated and new entries
   * are proposed (and optionally auto-approved) to grow the taxonomy over time.
   * Default: disabled (taxonomies remain static).
   */
  readonly taxonomy_expansion?: TaxonomyExpansionConfig;
}

export interface TaxonomyExpansionConfig {
  readonly enabled: boolean;
  /** Minimum distinct misses with a common pattern before a proposal is generated. Default: 3. */
  readonly min_miss_count?: number;
  /** Confidence threshold for auto-approval without human review. Default: 0.9. */
  readonly auto_approve_threshold?: number;
  /** When true, all proposals require explicit human approval regardless of confidence. Default: false. */
  readonly require_human_review?: boolean;
  /** Maximum number of pending (unapproved) proposals to retain. Default: 50. */
  readonly max_pending_proposals?: number;
}

export interface ProblemTaxonomy {
  readonly problem_classes: Record<string, {
    readonly base_significance: number;
    readonly description: string;
    readonly examples: readonly string[];
  }>;
}

/**
 * Compute the complete RDI (gate + rank) for a research outcome.
 */
export function computeRdi(params: {
  outcome: ResearchOutcome;
  strategy: ResearchStrategy;
  integrityReport: IntegrityReport | null;
  envelope: RepEnvelope;
  reproducibilityStatus: { verified: boolean; not_applicable: boolean };
  localCorpus: ResearchOutcome[];
  literatureRecords?: LiteratureRecord[];
  scoringConfig: ScoringConfig;   // SDK materializes defaults for any omitted fields
  fingerprintConfig?: FingerprintConfig;
  weights?: RdiWeights;
}): { gate: RdiGateResult; rank: RdiRankResult | null } {
  const {
    outcome,
    strategy,
    integrityReport,
    envelope,
    reproducibilityStatus,
    localCorpus,
    literatureRecords = [],
    scoringConfig,
    fingerprintConfig,
    weights = DEFAULT_RDI_WEIGHTS,
  } = params;

  // Step 1: Evaluate fail-closed gate
  const gate = evaluateRdiGate(
    outcome,
    integrityReport,
    envelope,
    reproducibilityStatus
  );

  // Step 2: If gate failed, no ranking score
  if (!gate.passed) {
    return { gate, rank: null };
  }

  // Step 3: Compute ranking components (four dimensions)
  const novelty = computeNovelty(outcome, localCorpus, literatureRecords, fingerprintConfig);
  const generality = computeGenerality(outcome, strategy, scoringConfig, fingerprintConfig);
  const significance = computeSignificance(outcome, strategy, scoringConfig);
  const citationImpact = computeCitationImpact(outcome, localCorpus);

  // Step 4: Weighted sum
  const score =
    weights.novelty * novelty +
    weights.generality * generality +
    weights.significance * significance +
    weights.citation_impact * citationImpact;

  return {
    gate,
    rank: {
      score: clamp(score, 0.0, 1.0),
      components: {
        novelty,
        generality,
        significance,
        citation_impact: citationImpact,
      },
      weights,
      scored_at: new Date().toISOString(),
    },
  };
}
```

---

## 5. Transport Layer

### 5.1 RepTransport Interface

All transports implement a common interface, enabling future extension from local files to HTTP without changing consumer code.

```typescript
/**
 * Filter for receiving messages.
 */
export interface MessageFilter {
  /** Filter by message type */
  readonly message_type?: RepMessageType | RepMessageType[];

  /** Filter by sender */
  readonly sender_id?: string;

  /** Filter by time range (ISO 8601) */
  readonly after?: string;
  readonly before?: string;

  /** Maximum number of messages to return */
  readonly limit?: number;
}

/**
 * Transport interface for REP message exchange.
 * Implementations: FileTransport (JSONL), future HttpTransport.
 */
export interface RepTransport {
  /**
   * Send a REP envelope through this transport.
   * The transport is responsible for serialization and delivery.
   */
  send(envelope: RepEnvelope): Promise<void>;

  /**
   * Receive REP envelopes matching the given filter.
   * Returns an async iterable for streaming consumption.
   */
  receive(filter?: MessageFilter): AsyncIterableIterator<RepEnvelope>;

  /**
   * Close the transport and release resources.
   */
  close(): Promise<void>;
}
```

### 5.2 FileTransport (JSONL)

The primary transport for local mode. One line per message/event, organized by date.

#### File Organization

```
{data_dir}/
  rep/
    events/
      2026-02-21.jsonl        # Research events for this date
      2026-02-22.jsonl
      ...
    assets/
      strategies/
        {content_hash}.json   # Individual strategy assets
      outcomes/
        {content_hash}.json   # Individual outcome assets
      integrity_reports/
        {content_hash}.json   # Individual integrity reports
    messages/
      2026-02-21.jsonl        # REP envelope messages for this date
      ...
```

**Design rationale**:
- Events and messages in JSONL (one line per record) for append-only streaming
- Assets in individual JSON files keyed by content hash for direct access
- Daily rotation for events/messages enables retention policies
- Asset files are immutable (content-addressed) -- never modified, only created

#### FileTransport Implementation

```typescript
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, rename, stat } from "node:fs/promises";
import { join, dirname } from "node:path";
import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";

/**
 * FileTransport configuration.
 */
export interface FileTransportConfig {
  /** Base data directory for REP storage */
  readonly dataDir: string;

  /** Retention period in days for event/message files (0 = no rotation) */
  readonly retentionDays?: number;

  /** Maximum file size in bytes before rotation (0 = no size limit) */
  readonly maxFileBytes?: number;
}

/**
 * JSONL-based local file transport for REP.
 *
 * Design principles:
 * - Append-only event/message files (JSONL)
 * - Content-addressed asset files (individual JSON)
 * - Atomic writes via write-to-tmp-then-rename (ART-03)
 * - Daily file rotation with configurable retention
 */
export class FileTransport implements RepTransport {
  private readonly config: FileTransportConfig;
  private closed = false;

  constructor(config: FileTransportConfig) {
    this.config = config;
  }

  /**
   * Send a REP envelope.
   *
   * For event/report messages: append to daily JSONL file.
   * For publish messages: also write the asset to its
   * content-addressed location.
   */
  async send(envelope: RepEnvelope): Promise<void> {
    this.ensureNotClosed();

    // Write envelope to daily message log
    const messageFile = this.messageFilePath(envelope.timestamp);
    await this.appendJsonl(messageFile, envelope);

    // For report messages (events), also write to event log
    if (envelope.message_type === "report") {
      const eventFile = this.eventFilePath(envelope.timestamp);
      await this.appendJsonl(eventFile, envelope);
    }

    // For publish messages, write the asset to content-addressed storage
    if (envelope.message_type === "publish") {
      await this.writeAsset(envelope);
    }
  }

  /**
   * Receive envelopes matching a filter by scanning JSONL files.
   */
  async *receive(
    filter?: MessageFilter
  ): AsyncIterableIterator<RepEnvelope> {
    this.ensureNotClosed();

    const messageDir = join(this.config.dataDir, "rep", "messages");
    const files = await this.listJsonlFiles(messageDir, filter);

    for (const filePath of files) {
      const stream = createReadStream(filePath, { encoding: "utf8" });
      const rl = createInterface({ input: stream });

      for await (const line of rl) {
        if (this.closed) return;
        const trimmed = line.trim();
        if (!trimmed) continue;

        try {
          const envelope = JSON.parse(trimmed) as RepEnvelope;
          if (this.matchesFilter(envelope, filter)) {
            yield envelope;
          }
        } catch {
          // Skip malformed lines (log warning in production)
          continue;
        }
      }
    }
  }

  /**
   * Close the transport.
   */
  async close(): Promise<void> {
    this.closed = true;
  }

  // --- Private helpers ---

  private eventFilePath(timestamp: string): string {
    const date = timestamp.slice(0, 10); // YYYY-MM-DD
    return join(this.config.dataDir, "rep", "events", `${date}.jsonl`);
  }

  private messageFilePath(timestamp: string): string {
    const date = timestamp.slice(0, 10);
    return join(this.config.dataDir, "rep", "messages", `${date}.jsonl`);
  }

  private assetFilePath(
    payloadType: RepPayloadType,
    contentHash: string
  ): string {
    const typeDir = this.assetTypeDir(payloadType);
    return join(
      this.config.dataDir,
      "rep",
      "assets",
      typeDir,
      `${contentHash}.json`
    );
  }

  private assetTypeDir(payloadType: RepPayloadType): string {
    switch (payloadType) {
      case "strategy":
        return "strategies";
      case "outcome":
        return "outcomes";
      case "integrity_report":
        return "integrity_reports";
      default:
        return "misc";
    }
  }

  /**
   * Atomic append to JSONL file.
   * Ensures directory exists. Appends a single line.
   *
   * Note: For true atomic append on all platforms, a file lock
   * (H-05 AdvisoryLock) should be used in production.
   * This implementation uses fs.appendFile which is atomic for
   * single writes under POSIX guarantees when data < PIPE_BUF.
   */
  private async appendJsonl(
    filePath: string,
    data: unknown
  ): Promise<void> {
    await mkdir(dirname(filePath), { recursive: true });
    const line = JSON.stringify(data) + "\n";
    const { appendFile } = await import("node:fs/promises");
    await appendFile(filePath, line, { encoding: "utf8" });
  }

  /**
   * Atomic write of an asset to its content-addressed location.
   * Write to .tmp then rename (per ART-03).
   */
  private async writeAsset(envelope: RepEnvelope): Promise<void> {
    const publishPayload = envelope.payload as { asset_type: string };
    const filePath = this.assetFilePath(
      publishPayload.asset_type,
      envelope.content_hash
    );
    const tmpPath = filePath + `.tmp.${randomUUID().slice(0, 8)}`;

    await mkdir(dirname(filePath), { recursive: true });

    const { writeFile } = await import("node:fs/promises");
    const content = JSON.stringify(envelope.payload, null, 2) + "\n";
    await writeFile(tmpPath, content, { encoding: "utf8" });

    // fsync equivalent: Node.js writeFile with flush option (Node 21.2+)
    // For older Node versions, open + write + fsync + close manually
    await rename(tmpPath, filePath);
  }

  private matchesFilter(
    envelope: RepEnvelope,
    filter?: MessageFilter
  ): boolean {
    if (!filter) return true;

    if (filter.message_type) {
      const types = Array.isArray(filter.message_type)
        ? filter.message_type
        : [filter.message_type];
      if (!types.includes(envelope.message_type)) return false;
    }

    if (filter.sender_id && envelope.sender_id !== filter.sender_id) {
      return false;
    }

    if (filter.after && envelope.timestamp < filter.after) {
      return false;
    }

    if (filter.before && envelope.timestamp > filter.before) {
      return false;
    }

    return true;
  }

  private async listJsonlFiles(
    dir: string,
    filter?: MessageFilter
  ): Promise<string[]> {
    try {
      const { readdir } = await import("node:fs/promises");
      const entries = await readdir(dir);
      let jsonlFiles = entries
        .filter((f) => f.endsWith(".jsonl"))
        .sort();

      // Filter by date range if specified
      if (filter?.after) {
        const afterDate = filter.after.slice(0, 10);
        jsonlFiles = jsonlFiles.filter((f) => f >= afterDate);
      }
      if (filter?.before) {
        const beforeDate = filter.before.slice(0, 10);
        jsonlFiles = jsonlFiles.filter((f) => f <= beforeDate + ".jsonl");
      }

      return jsonlFiles.map((f) => join(dir, f));
    } catch {
      return []; // Directory does not exist yet
    }
  }

  private ensureNotClosed(): void {
    if (this.closed) {
      throw new Error("FileTransport is closed");
    }
  }
}
```

### 5.3 HTTP Transport Interface (Future)

The HTTP transport is defined as an interface only. Implementation is deferred to when multi-node REP communication is needed (post-EVO-04 Agent Registry).

```typescript
/**
 * HTTP transport configuration (future implementation).
 */
export interface HttpTransportConfig {
  /** Base URL of the REP server */
  readonly baseUrl: string;

  /** Authentication token or shared secret */
  readonly authToken?: string;

  /** Request timeout in milliseconds */
  readonly timeoutMs?: number;

  /** Maximum retry attempts */
  readonly maxRetries?: number;

  /** Whether to use HMAC-SHA256 signatures */
  readonly enableSignature?: boolean;

  /** Shared secret for HMAC-SHA256 (required if enableSignature is true) */
  readonly sharedSecret?: string;
}

/**
 * HTTP transport for REP (interface definition only).
 *
 * Future implementation will use fetch() (Node.js built-in since 18.x)
 * to send/receive REP envelopes over HTTPS.
 *
 * Endpoints:
 *   POST /rep/v1/messages     -- Send an envelope
 *   GET  /rep/v1/messages     -- Receive envelopes (SSE or polling)
 *   GET  /rep/v1/assets/:hash -- Fetch a specific asset by content hash
 */
// export class HttpTransport implements RepTransport { ... }
```

---

## 6. Sub-path Export Design

The `@autoresearch/rep-sdk` package follows the MCP SDK pattern of sub-path exports, enabling consumers to import only the modules they need.

### 6.1 Export Map

```
@autoresearch/rep-sdk
|
|-- /                   Core types + RepEnvelope + contentHash()
|                       + canonicalJsonSerialize() + validateEnvelope()
|
|-- /client             RepClient: high-level client API
|                       fetchStrategy(), reportOutcome(), consumeEvents()
|
|-- /server             RepServer: high-level server API
|                       publishStrategy(), validateOutcome(), manageRdiGate()
|
|-- /transport          FileTransport + RepTransport interface
|                       + FileTransportConfig + HttpTransportConfig
|
|-- /validation         RdiGate + RdiRank + JSON Schema validators
|                       evaluateRdiGate(), computeRdi(), validateSchema()
|
|-- /experimental       Reserved for future features
|                       (personality evolution, memory graph integration)
```

### 6.2 Client API Surface

```typescript
/**
 * RepClient -- high-level client for consuming REP services.
 *
 * Usage:
 *   import { RepClient } from "@autoresearch/rep-sdk/client";
 *   const client = new RepClient({ transport, agentId });
 *   const strategies = await client.fetchStrategies({ domain: "hep-ph" });
 */
export class RepClient {
  constructor(config: {
    transport: RepTransport;
    agentId: string;
  });

  /**
   * Fetch research strategies matching the given criteria.
   */
  fetchStrategies(query: {
    domain?: string;
    tags?: string[];
    method?: string;
    limit?: number;
  }): Promise<ResearchStrategy[]>;

  /**
   * Report a research outcome.
   * Triggers RDI gate evaluation on the server side.
   */
  reportOutcome(outcome: ResearchOutcome): Promise<{
    accepted: boolean;
    gate: RdiGateResult;
    rank?: RdiRankResult;
  }>;

  /**
   * Submit an integrity report for a research artifact.
   */
  submitIntegrityReport(report: IntegrityReport): Promise<void>;

  /**
   * Consume the research event stream.
   * Returns an async iterable of events matching the filter.
   */
  consumeEvents(filter?: {
    event_types?: ResearchEventType[];
    run_id?: string;
    after?: string;
  }): AsyncIterableIterator<ResearchEvent>;

  /**
   * Submit a peer review of a research outcome.
   */
  submitReview(params: {
    outcome_id: string;
    verdict: "accept" | "revise" | "reject";
    comments: string;
    suggested_checks?: string[];
  }): Promise<void>;

  /**
   * Register this agent with the REP network (hello message).
   */
  register(capabilities: string[]): Promise<void>;

  /**
   * Revoke a previously published asset.
   */
  revoke(assetId: string, reason: string): Promise<void>;
}
```

### 6.3 Server API Surface

```typescript
/**
 * RepServer -- high-level server for providing REP services.
 *
 * Usage:
 *   import { RepServer } from "@autoresearch/rep-sdk/server";
 *   const server = new RepServer({ transport, agentId, scoringConfig });
 *   server.onPublish(async (envelope) => { ... });
 *   await server.start();
 */
export class RepServer {
  constructor(config: {
    transport: RepTransport;
    agentId: string;
    scoringConfig: ScoringConfig;
    rdiWeights?: RdiWeights;
  });

  /**
   * Publish a new research strategy.
   * Validates the strategy schema and stores it.
   */
  publishStrategy(strategy: ResearchStrategy): Promise<{
    envelope: RepEnvelope;
    strategy_id: string;
  }>;

  /**
   * Validate and publish a research outcome.
   * Runs the RDI gate before accepting.
   *
   * If revision_of is provided, this publish is a revision of a previously
   * published asset, triggered by a review. The revision_of links the causal
   * chain: review -> revision -> re-review.
   */
  validateAndPublishOutcome(params: {
    outcome: ResearchOutcome;
    integrityReport: IntegrityReport | null;
    reproducibilityStatus: { verified: boolean; not_applicable: boolean };
    revision_of?: {
      original_asset_id: string;   // content-addressed ID of the asset being revised
      review_message_id?: string;  // message_id of the review that triggered this revision
    };
  }): Promise<{
    accepted: boolean;
    gate: RdiGateResult;
    rank?: RdiRankResult;
    envelope?: RepEnvelope;
  }>;

  /**
   * Process an incoming REP envelope.
   * Dispatches to the appropriate handler based on message_type.
   */
  processEnvelope(envelope: RepEnvelope): Promise<void>;

  /**
   * Register a handler for a specific message type.
   */
  onMessage(
    messageType: RepMessageType,
    handler: (envelope: RepEnvelope) => Promise<void>
  ): void;

  /**
   * Start the server (begins consuming from transport).
   */
  start(): Promise<void>;

  /**
   * Stop the server.
   */
  stop(): Promise<void>;
}
```

---

## 7. Package Design

### 7.1 package.json Structure

```json
{
  "name": "@autoresearch/rep-sdk",
  "version": "0.1.0",
  "description": "Research Evolution Protocol (REP) SDK -- research strategy evolution for AI scientific research",
  "license": "MIT",
  "author": "Autoresearch Contributors",
  "type": "module",
  "engines": {
    "node": ">=18.0.0"
  },
  "exports": {
    ".": {
      "import": "./dist/esm/index.js",
      "require": "./dist/cjs/index.js",
      "types": "./dist/types/index.d.ts"
    },
    "./client": {
      "import": "./dist/esm/client/index.js",
      "require": "./dist/cjs/client/index.js",
      "types": "./dist/types/client/index.d.ts"
    },
    "./server": {
      "import": "./dist/esm/server/index.js",
      "require": "./dist/cjs/server/index.js",
      "types": "./dist/types/server/index.d.ts"
    },
    "./transport": {
      "import": "./dist/esm/transport/index.js",
      "require": "./dist/cjs/transport/index.js",
      "types": "./dist/types/transport/index.d.ts"
    },
    "./validation": {
      "import": "./dist/esm/validation/index.js",
      "require": "./dist/cjs/validation/index.js",
      "types": "./dist/types/validation/index.d.ts"
    },
    "./experimental": {
      "import": "./dist/esm/experimental/index.js",
      "require": "./dist/cjs/experimental/index.js",
      "types": "./dist/types/experimental/index.d.ts"
    }
  },
  "main": "./dist/cjs/index.js",
  "module": "./dist/esm/index.js",
  "types": "./dist/types/index.d.ts",
  "files": [
    "dist/",
    "schemas/",
    "LICENSE",
    "README.md"
  ],
  "scripts": {
    "build": "npm run build:esm && npm run build:cjs && npm run build:types",
    "build:esm": "tsc -p tsconfig.esm.json",
    "build:cjs": "tsc -p tsconfig.cjs.json",
    "build:types": "tsc -p tsconfig.types.json",
    "test": "node --test dist/esm/**/*.test.js",
    "lint": "tsc --noEmit",
    "clean": "rm -rf dist/"
  },
  "dependencies": {},
  "peerDependencies": {},
  "devDependencies": {
    "typescript": "^5.4.0"
  },
  "keywords": [
    "research",
    "evolution",
    "protocol",
    "scientific-research",
    "hep",
    "mcp",
    "agent",
    "a2a"
  ],
  "repository": {
    "type": "git",
    "url": "https://github.com/autoresearch-lab/autoresearch",
    "directory": "packages/rep-sdk"
  }
}
```

### 7.2 Zero Dependency Design (PLUG-01)

The REP SDK uses ONLY Node.js built-in modules:

| Built-in Module | Usage |
|---|---|
| `node:crypto` | SHA-256 hashing, HMAC-SHA256 signatures, UUID v4 generation, timing-safe comparison |
| `node:fs` | File read/write for FileTransport |
| `node:fs/promises` | Async file operations |
| `node:path` | Path manipulation |
| `node:readline` | JSONL line-by-line parsing |

**No external dependencies**. This means:
- No JSON Schema validation library (use `node:assert` or manual validation)
- No UUID library (use `crypto.randomUUID()`)
- No date library (use `Date.toISOString()`)

**Optional peer dependencies** (consumers may install for extended functionality):
- `ajv` -- for JSON Schema validation if consumers want schema-level validation
- `better-sqlite3` -- for SQLite-backed asset indexing (future optimization)

### 7.3 Source Directory Structure

```
packages/rep-sdk/
  src/
    index.ts                     # Root export: types + envelope + contentHash
    types.ts                     # All type definitions (Section 3)
    envelope.ts                  # Envelope construction + validation (Section 2)
    content-hash.ts              # SHA-256 canonical JSON hashing
    signature.ts                 # HMAC-SHA256 signing/verification

    client/
      index.ts                   # RepClient class
      fetch.ts                   # Strategy/outcome fetching
      report.ts                  # Outcome reporting
      events.ts                  # Event stream consumption

    server/
      index.ts                   # RepServer class
      publish.ts                 # Strategy/outcome publishing
      validate.ts                # Outcome validation pipeline
      dispatch.ts                # Message dispatching

    transport/
      index.ts                   # RepTransport interface + FileTransport
      file.ts                    # FileTransport implementation
      types.ts                   # Transport configuration types

    validation/
      index.ts                   # RDI gate + rank + schema validation
      rdi-gate.ts                # Fail-closed gate implementation
      rdi-rank.ts                # Ranking score computation
      novelty.ts                 # Novelty scoring
      generality.ts              # Generality scoring (three-factor)
      significance.ts            # Significance scoring (problem taxonomy)
      citation-impact.ts         # Citation impact scoring
      schema-validator.ts        # JSON Schema validation utilities

    experimental/
      index.ts                   # Reserved exports
      personality.ts             # Reserved: personality evolution (from GEP)
      memory-graph.ts            # Reserved: memory graph integration (EVO-20)

  schemas/
    research_strategy_v1.schema.json
    research_outcome_v1.schema.json
    research_event_v1.schema.json
    integrity_report_v1.schema.json
    rep_envelope_v1.schema.json

  tsconfig.json                  # Base config
  tsconfig.esm.json              # ESM build
  tsconfig.cjs.json              # CJS build
  tsconfig.types.json            # Type declarations
  package.json
  LICENSE                        # MIT
  README.md
```

### 7.4 MIT License and Evolver Attribution

The REP SDK is released under the MIT license. Code ported from Evolver retains attribution:

```
MIT License

Copyright (c) 2026 Autoresearch Contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

---

Portions of this software are derived from the Evolver project
(https://github.com/autogame-17/evolver), which is licensed under the MIT
License. Specifically:
- Envelope construction pattern (adapted from src/gep/a2aProtocol.js)
- Signal deduplication logic (adapted from src/gep/signals.js)
- Scoring pipeline structure (adapted from src/gep/selector.js)

Original Copyright (c) AutoGame Limited. Used under MIT License.
```

---

## 8. Algorithms and Pseudocode

### 8.1 Asset Publishing Pipeline

```
publishOutcome(outcome, integrityReport, reproducibilityStatus):
  1. Validate outcome schema
     - All required fields present
     - strategy_ref exists in strategy store
     - metrics map non-empty
     - confidence in [0, 1]
     - schema_version === 1

  1a. Assign lineage identity
      - If outcome.supersedes is null (first publication):
          - outcome.lineage_id = uuid_v4()
          - outcome.version = 1
      - Else (revision of existing outcome):
          - parent = fetchOutcome(outcome.supersedes)
          - outcome.lineage_id = parent.lineage_id
          - outcome.version = parent.version + 1
          - Verify: no other outcome in this lineage has the same version

  2. Compute content-addressed ID
     - Serialize outcome (excluding outcome_id) to canonical JSON
     - outcome_id = SHA-256(canonical_json)
     - Verify no collision with existing outcome

  3. Evaluate RDI fail-closed gate
     - G1: integrityReport.overall_status !== "fail"
     - G2: all blocking checks passed
     - G3: reproducibility verified (or not applicable)
     - G4: content hash matches
     - If ANY gate check fails -> REJECT, emit outcome_published event
       with rdi_gate_passed=false

  4. Compute RDI ranking score (only if gate passed)
     - novelty = 1 - max_similarity(outcome, corpus + literature_service)
     - generality = 0.50*method_class + 0.25*result_breadth + 0.25*assumption_lightness
     - significance = problem_taxonomy_lookup(outcome, strategy)
     - citation_impact = local_citations / max_local_citations
     - score = 0.40*novelty + 0.20*generality + 0.20*significance + 0.20*citation_impact

  5. Construct REP envelope
     - protocol: "rep-a2a"
     - message_type: "publish"
     - content_hash: SHA-256 of canonical JSON payload (RFC 8785 JCS)
     - payload: outcome with computed outcome_id

  6. Write to transport
     - FileTransport: append envelope to messages JSONL
     - FileTransport: write asset to outcomes/{hash}.json (atomic)
     - If revision: mark parent outcome superseded_by = outcome.outcome_id

  7. Emit research events
     - outcome_published event with rdi_gate_passed=true, rdi_rank_score
     - If revision: outcome_superseded event for parent

  8. Return { accepted: true, gate, rank, envelope }
```

### 8.2 Strategy Selection Pipeline

This pipeline is consumed by EVO-18 (Signal Engine) and interfaces with EVO-11 (Bandit).

```
selectStrategy(signals, availableStrategies, memoryGraph):
  1. Filter applicable strategies
     - For each signal in signals:
       - Match signal type to strategy applicable_when conditions
       - Filter by domain compatibility
       - Filter by constraint satisfaction (parameter ranges)
     -> candidateStrategies

  2. Score candidates using RDI rank
     - For each candidate in candidateStrategies:
       - pastOutcomes = memoryGraph.queryOutcomes(candidate.strategy_id)
       - avgRdiScore = mean(pastOutcomes.map(o -> o.rdi_rank_score))
       - successRate = count(pastOutcomes where status=="verified")
                       / count(pastOutcomes)
       - signalMatch = matchScore(signal, candidate.applicable_when)
       - candidateScore = 0.40*avgRdiScore + 0.30*successRate + 0.30*signalMatch

  3. Apply bandit selection (EVO-11 interface)
     - If banditDistributor is available:
       - selectedArm = banditDistributor.selectArm(candidateScores)
       - return candidateStrategies[selectedArm]
     - Else (fallback):
       - return candidateStrategies.maxBy(candidateScore)

  4. Emit events
     - strategy_selected event for the chosen strategy
     - strategy_rejected events for non-selected candidates (if scored)

  5. Return selected strategy
```

### 8.3 Stagnation Detection

Ported from Evolver `signals.js` consecutiveEmptyCycles logic, adapted for research evolution.

```
detectStagnation(eventStream, config):
  config defaults:
    emptyThreshold = 3    # cycles with no new verified outcomes
    loopThreshold = 2     # times the same strategy fails consecutively
    presetOrder = ["explore", "deepen", "verify", "consolidate"]

  state:
    consecutiveEmptyCycles = 0
    strategyFailCounts = {}  # strategy_id -> consecutive fail count
    currentPreset = "explore"

  for each cycle:
    # outcome_published events only occur after RDI gate pass
    newVerifiedOutcomes = eventStream.filter(
      event_type == "outcome_published"
    ).count()

    if newVerifiedOutcomes == 0:
      consecutiveEmptyCycles += 1
    else:
      consecutiveEmptyCycles = 0

    # Check for strategy loop (same strategy failing repeatedly)
    failedStrategies = eventStream.filter(
      event_type == "computation_failed" OR event_type == "verification_failed"
    )
    for failure in failedStrategies:
      # computation_id -> strategy mapping maintained by orchestrator.
      # IMPORTANT: This mapping must be persisted (e.g., in EVO-20 Memory Graph or
      # artifact store) to survive orchestrator process restarts.
      sid = computationToStrategy[failure.payload.computation_id]
      strategyFailCounts[sid] = (strategyFailCounts[sid] or 0) + 1
      if strategyFailCounts[sid] >= loopThreshold:
        emit stagnation_detected event:
          consecutive_empty_cycles: consecutiveEmptyCycles
          current_preset: currentPreset
          recommended_action: "switch_preset"
        # Reset fail count for this strategy
        strategyFailCounts[sid] = 0

    # Check for overall stagnation
    if consecutiveEmptyCycles >= emptyThreshold:
      nextPresetIndex = (presetOrder.indexOf(currentPreset) + 1)
                        % presetOrder.length
      nextPreset = presetOrder[nextPresetIndex]

      emit stagnation_detected event:
        consecutive_empty_cycles: consecutiveEmptyCycles
        current_preset: currentPreset
        recommended_action:
          if nextPreset == currentPreset: "halt"
          else: "switch_preset"

      currentPreset = nextPreset
      consecutiveEmptyCycles = 0
```

---

## 9. Integration Points

### 9.1 Dependencies on Existing Infrastructure

| Dependency | Item | What REP Needs | Status |
|---|---|---|---|
| H-18 | ArtifactRef V1 | Content-addressing scheme, URI format | Phase 1 |
| H-02 | trace_id | UUID v4 trace correlation | Phase 1 |
| H-10 | Ledger events | JSONL event format compatibility | Phase 2 |
| H-07 | Atomic file write | ART-03 write-to-tmp-then-rename | Phase 2 |
| M-06 | SQLite WAL | Future asset index storage | Phase 2 |
| NEW-07 | A2A adapter | Transport layer for multi-node REP | Phase 4 |

### 9.2 Consumers of REP SDK

| Consumer | Item | How It Uses REP |
|---|---|---|
| EVO-04 | Agent Registry | REP `hello` messages for capability advertisement |
| EVO-06 | Integrity Framework | Produces IntegrityReport assets consumed by RDI gate |
| EVO-07 | Reproducibility | Provides reproducibility_verified status for RDI gate |
| EVO-09 | Failure Library | Queries ResearchEvent stream for failure patterns |
| EVO-10 | Evolution Loop | Five-stage pipeline uses REP assets throughout |
| EVO-11 | Bandit | Interfaces with strategy selection via RDI rank scores |
| EVO-15 | Agent-arXiv | Stores and retrieves ResearchOutcomes |
| EVO-18 | Signal Engine | Consumes ResearchEvent stream, produces signals |
| EVO-20 | Memory Graph | Persists REP asset relationships across cycles |

### 9.3 Dependency Linearization

The dependency chain for EVO-17 implementation:

```
H-18 (ArtifactRef V1)  ----+
                            |
NEW-07 (A2A adapter)   ----+---> EVO-17 (REP SDK) ---> EVO-04 (Agent Registry)
                            |                      |
H-02 (trace_id)        ----+                      +---> EVO-18 (Signal Engine)
                                                   |
                                                   +---> EVO-15 (Agent-arXiv)
```

This eliminates the circular dependency previously identified in the EvoMap/GEP analysis (Section 7.3): NEW-07 -> EVO-17 -> EVO-04.

### 9.4 REP and MCP Coexistence

REP does not replace MCP. They operate at different layers:

| Concern | MCP | REP |
|---|---|---|
| Tool discovery | `listTools()` | Not applicable |
| Tool invocation | `callTool()` | Not applicable |
| Strategy evolution | Not applicable | `publish`, `fetch`, `review` |
| Research audit | Not applicable | ResearchEvent stream |
| Integrity checking | Not applicable | IntegrityReport + RDI gate |
| Transport | stdio (JSON-RPC 2.0) | JSONL files (local), HTTP (future) |

A REP server is NOT an MCP server. They are independent services. The orchestrator may coordinate both: using MCP to invoke computation tools, and REP to record and evolve research strategies.

---

## 10. Open Questions

### 10.1 Fingerprint Vector Construction

The novelty scoring (Section 4.3.1) requires a 96-dimensional fingerprint vector. The `methodEmbedding(64d)` component needs a mapping from method descriptions to vectors. Options:

1. **Pre-computed lookup table**: Map known methods to fixed vectors. Simple but limited to known methods.
2. **TF-IDF over method vocabulary**: Build a vocabulary from all known methods, use TF-IDF weights. Requires a method corpus.
3. **LLM embedding**: Use an embedding model to encode method descriptions. Requires an external API call (conflicts with local-first principle).

**Recommendation**: Start with option 1 (lookup table) for Phase 5 launch, with option 2 as the upgrade path. Option 3 is deferred until a local embedding model is available.

### 10.2 Scoring Configuration (Method + Problem Taxonomy)

The generality scoring (Section 4.3.2) requires a method taxonomy, and the significance scoring (Section 4.3.3) requires a problem taxonomy. Both are provided by the Domain Pack's `scoring_config`. The initial HEP Domain Pack should ship with:

1. **Method taxonomy**: Coverage for standard HEP methods (lattice QCD, perturbative QCD at various orders, effective field theories, dispersive methods, formal/algebraic methods, numerical bootstrap).
2. **Problem taxonomy**: Classification of major HEP problem classes (fundamental mechanisms, precision frontier, BSM searches, formal developments, phenomenology tools).
3. **Reference values**: `reference_metric_count` and `reference_assumption_count` calibrated for HEP.

Open sub-questions:
- How granular should the problem taxonomy be? Coarse classes (5-10) provide stability; fine-grained classes (50+) provide precision but require more curation.
- Should the taxonomy support hierarchical classification (class → subclass → specific problem)?
- How should the connectivity graph (future extension) be bootstrapped — from citation networks, from expert curation, or both?

### 10.3 Event Stream Scalability

For long-running research campaigns, the JSONL event files may grow large. Consider:
- Daily rotation with configurable retention (already in FileTransport config)
- SQLite-backed event index for efficient querying (future optimization, uses M-06 SQLite WAL)
- Event compaction: periodic summarization of old events into aggregate records

### 10.4 Schema Versioning Strategy

All REP types use `schema_version: 1`. When schema evolution is needed:
- New fields are added as optional (backward compatible)
- Breaking changes increment schema_version
- Migration functions follow MIG-01 (Schema Migration Chain)
- Old versions remain readable for at least 2 minor versions

### 10.5 Experimental Sub-path Scope

The `/experimental` sub-path is reserved for:
- **Personality evolution**: Ported from GEP `personality.js`. Research strategy parameters that self-tune through natural selection. Deferred until EVO-20 (Memory Graph) provides the persistence layer.
- **Memory graph integration**: Direct integration with the EVO-20 cross-cycle memory graph for signal frequency tracking and strategy success history.

These features are explicitly marked experimental and may change without notice until promoted to a stable sub-path.

---

## Appendix A: JSON Schema Locations

The following JSON Schema files serve as the SSOT for REP types. They are stored in `autoresearch-meta/schemas/` and used by the codegen pipeline (NEW-01) to generate TypeScript and Python types.

| Schema File | REP Type | Notes |
|---|---|---|
| `research_strategy_v1.schema.json` | ResearchStrategy | Content-addressed, schema_version: 1 |
| `research_outcome_v1.schema.json` | ResearchOutcome | Content-addressed, schema_version: 1 |
| `research_event_v1.schema.json` | ResearchEvent | UUID v4 event_id, schema_version: 1 |
| `integrity_report_v1.schema.json` | IntegrityReport | Content-addressed, schema_version: 1 |
| `rep_envelope_v1.schema.json` | RepEnvelope | Wire format envelope |

All schemas follow JSON Schema Draft 2020-12.

## Appendix B: GEP to REP Concept Mapping

| GEP Concept | REP Equivalent | Key Differences |
|---|---|---|
| Gene | ResearchStrategy | Scientific method instead of code repair pattern |
| Capsule | ResearchOutcome | Physical quantities instead of code patches |
| EvolutionEvent | ResearchEvent | Research lifecycle events instead of code evolution events |
| (none) | IntegrityReport | Scientific integrity has no GEP equivalent |
| GDI | RDI | Dual-layer (gate + rank) instead of single score |
| Mutation (repair/optimize/innovate) | Strategy presets (explore/deepen/verify/consolidate) | Research-domain strategy modes |
| PersonalityState | (experimental) | Deferred to /experimental sub-path |
| MemoryGraph | (experimental, EVO-20) | Shared infrastructure with Track B |
| `decision` message | `review` message | Peer review semantics instead of binary ruling |

## Appendix C: Contract Rule Compliance

| Rule | How REP Complies |
|---|---|
| PLUG-01 | Zero internal dependencies; only Node.js built-ins |
| ART-03 | FileTransport uses write-to-tmp-then-rename for all asset writes |
| ERR-01 | All errors use structured envelope format with domain/code/retryable |
| LANG-01 | All source code, comments, and documentation in English |
| CODE-01 | Each source file targets <=200 eLOC; no banned filenames |
| ART-02 | All assets carry schema_version in both filename and content |
| LOG-02 | trace_id propagated through all events and envelopes |
| ID-03 | Asset references use ArtifactRef V1 with sha256 + size_bytes |
| GATE-01 | RDI gate registered in the gate registry as a fail-closed gate |
