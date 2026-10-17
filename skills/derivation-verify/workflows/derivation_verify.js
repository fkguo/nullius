// ============================================================================
// derivation_verify.js — REUSABLE convergence-gate harness for derivation-heavy tasks.
//
// For for EACH atomic claim, spawn >=2 INDEPENDENT
// BLIND re-derivations (independence-assessed), an adversarial comparator detects mathematical
// (dis)agreement, and a tie-break loop adds fresh independent derivations until >=2 agree —
// implementing the standing rule "every derivation needs >=2 independent verifications; iterate
// every disagreement to convergence; the leader never self-declares convergence."
//
// USAGE (from the Workflow tool):
//   Workflow({ scriptPath: "skills/derivation-verify/workflows/derivation_verify.js", args: {
//     context: "shared ground-truth equations / conventions (string, given to every deriver)",
//     max_iter: 3,                                   // optional, default 3
//     claims: [ {
//       id: "A1",
//       statement: "what to DERIVE BLIND (do not assume the answer)",
//       report_format: "the exact canonical format to report the answer in (e.g. a single rational, or an expression)",
//       method0: "method hint for deriver #0 (optional route hint)",
//       method1: "method hint for deriver #1 (optional route hint; may be same/similar)"
//     }, ... ]
//   }})
//
// Returns { total_claims, converged, unconverged:[ids], clean_first_pass, needed_iteration:[{claim,rounds}], matrix:[...] }.
// Each matrix row: { claim, converged, independent_confirmations, total_derivations, iterate_rounds,
//                    agreed_answer, adjudicated_correct, outliers }.
// Derivers MAY run python(sympy/mpmath)/julia via Bash; they are told to SHOW the computation.
// ============================================================================
export const meta = {
  name: 'derivation-verify',
  description: 'Reusable >=2-independent-blind-derivation convergence gate for a supplied list of atomic claims; iterate disagreements to convergence; emit a verification matrix',
  phases: [
    { title: 'Verify',     detail: '2 independent blind re-derivations per claim (independence-assessed)' },
    { title: 'Iterate',    detail: 'adversarial reconcile + tie-break derivers until >=2 agree' },
    { title: 'Synthesize', detail: 'verification matrix: claim x independent confirmations x convergence' },
  ],
}

// `args` may arrive as a JS object OR as a JSON string — the Workflow tool serializes complex args
// to a string in some environments. Accept both so a caller can pass either form. (Found by smoke-test:
// without this, a stringified args silently yielded zero claims — total_claims:0, no agents spawned.)
let A = args
if (typeof A === 'string') { try { A = JSON.parse(A) } catch (e) { A = {} } }
A = (A && typeof A === 'object') ? A : {}
const CTX = String(A.context || '')
const CLAIMS = Array.isArray(A.claims) ? A.claims : []
const MAX_ITER = Number.isInteger(A.max_iter) && A.max_iter >= 0 ? A.max_iter : 3 // max_iter:0 disables iteration; negative/non-int -> default 3
const PROTOCOL_RESERVE = 8192
const OUTPUT_RESERVE = 32768
const CONTEXT_TOKENS = A.context_tokens === undefined ? 200000 : A.context_tokens
const CONTEXT_BYTES = A.context_bytes === undefined ? Math.min(160000, CONTEXT_TOKENS - PROTOCOL_RESERVE - OUTPUT_RESERVE) : A.context_bytes
const validBudgets = Number.isSafeInteger(CONTEXT_TOKENS) && CONTEXT_TOKENS > PROTOCOL_RESERVE + OUTPUT_RESERVE && Number.isSafeInteger(CONTEXT_BYTES) && CONTEXT_BYTES >= 12000
const utf8Bytes = text => new TextEncoder().encode(text).length
if (CLAIMS.length === 0) {
  log('derivation-verify: no claims supplied in args.claims — nothing to do.')
  return { total_claims: 0, converged: 0, unconverged: [], clean_first_pass: 0, needed_iteration: [], matrix: [] }
}

const VERDICT = {
  type: 'object', additionalProperties: false,
  properties: {
    canonical_answer: { type: 'string', description: 'the single canonical result in the exact requested format' },
    derivation_summary: { type: 'string', description: 'Optional navigation summary, never assessment evidence by itself' },
    derivation: { type: 'string', description: 'the full written derivation, as in a paper appendix: every mathematical step stated explicitly, premises, applicability/limits and actual computation source/output if used; not abbreviated' },
    confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
  },
  required: ['canonical_answer', 'derivation', 'confidence'],
}
const EVIDENCE_ITEM = { type: 'object', properties: {
  source_span: { type: 'string' }, reason: { type: 'string' },
}, required: ['source_span', 'reason'], additionalProperties: false }
const ASSESSMENT = { type: 'object', properties: {
  observed_method: { type: 'string' }, index: { type: 'integer' }, input_independent: { type: 'boolean' },
  execution_independent: { type: 'boolean' }, construction_independent: { type: 'boolean' },
  method_applicable: { type: 'boolean' }, diagnostic: { type: 'boolean' },
  unresolved_defects: { type: 'array', items: { type: 'string' } },
  evidence: { type: 'object', properties: Object.fromEntries(
    ['input','execution','construction','applicability','diagnostic'].map(k => [k, EVIDENCE_ITEM])),
    required: ['input','execution','construction','applicability','diagnostic'], additionalProperties: false },
}, required: ['index','input_independent','execution_independent','construction_independent',
  'method_applicable','diagnostic','unresolved_defects','evidence'], additionalProperties: false }
const COMPARE = {
  type: 'object', additionalProperties: false,
  properties: {
    majority_answer: { type: 'string', description: 'the canonical answer the largest mathematically-equivalent cluster agrees on' },
    majority_indices: { type: 'array', items: { type: 'integer' } },
    adjudicated_matches_majority: { type: 'boolean' },
    independence_assessments: { type: 'array', items: ASSESSMENT },
    method_risk_assessments: { type: 'array', items: { type: 'object', properties: {
      indices: { type: 'array', items: { type: 'integer' } }, addresses_shared_failure: { type: 'boolean' }, methods_distinct: { type: 'boolean' },
      risk: { type: 'string' }, method_analysis: { type: 'string' }, evidence: { type: 'array', items: {
        type: 'object', properties: { index: { type: 'integer' }, source_span: { type: 'string' }, reason: { type: 'string' } },
        required: ['index','source_span','reason'], additionalProperties: false } },
    }, required: ['indices','addresses_shared_failure','methods_distinct','risk','method_analysis','evidence'], additionalProperties: false } },
    majority_size: { type: 'integer', description: 'how many supplied derivations are mathematically equivalent to majority_answer' },
    all_equivalent: { type: 'boolean' },
    outliers: { type: 'string', description: 'for each derivation NOT in the majority: its index and the specific error; "none" if all agree' },
    correct_answer_adjudicated: { type: 'string', description: 'the answer YOU independently judge correct (recompute if needed), with a one-line reason' },
  },
  required: ['method_risk_assessments','majority_indices','adjudicated_matches_majority','independence_assessments','majority_answer', 'majority_size', 'all_equivalent', 'outliers', 'correct_answer_adjudicated'],
}

function vPrompt(c, method) {
  return `${CTX}\nBLIND TASK (do NOT assume the answer; derive it from scratch):\n${c.statement}\n\n${method || ''}\n\nOUTPUT: canonical_answer in EXACTLY this format: ${c.report_format}. Give derivation as the full written derivation, as it would appear in a paper appendix: every mathematical step stated explicitly, with conventions, raw input, method applicability and diagnostic limits; do not abbreviate it. If you used computation, include complete source and actual records, never invent execution. A short derivation_summary may help navigation but is not the evidence. Give confidence.`
}
function stringValues(value) {
  if (typeof value === 'string') return [value]
  if (Array.isArray(value)) return value.flatMap(stringValues)
  if (value && typeof value === 'object') return Object.values(value).flatMap(stringValues)
  return []
}
// Texts an input/execution span may quote verbatim: the original derivation body, the navigation summary,
// and the observed transport record both as the packet encodes it and as its decoded string values.
// The packet carries each lane's text once as derivation and once inside transport.raw_output; no field repeats it.
// The host protocol observes no capture stream, so the native transport holds no captured_records to carry.
function sourceMaterial(d) {
  return [d.derivation || '', d.derivation_summary || '', JSON.stringify(d.transport || {}), ...stringValues(d.transport || {})]
}
function cmpPrompt(c, ds) {
  return `${CTX}\nClaim: ${c.statement}\nExpected canonical format: ${c.report_format}\nFULL_DERIVATION_RECORDS_JSON:\n${JSON.stringify(ds)}\n\nRead COMPLETE original derivations, runtime-observed requests/raw outputs and successful call records. A summary alone, a self-filled freshness checkbox or a name is not provenance. Cluster mathematical equivalence and independently recompute. majority_answer must copy an actual canonical_answer from majority_indices, and majority_size must equal their enumerated cardinality; empty or contradictory clusters are unavailable. For every lane provide independence_assessments for input/execution/construction, applicability, diagnostic power and unresolved defects, plus observed_method grounded in actual steps. Every evidence item quotes an exact source_span with a substantive reason. Construction/applicability/diagnostic MUST anchor the COMPLETE original derivation BODY itself; only input/execution may also anchor the transport record exactly as shown (request, raw_output) or any of its decoded values, or derivation_summary. Missing original steps, failed invocation, contaminated input, copied reasoning, relevant defects or non-diagnostic checks refuse. Same/similar methods, same family and legitimate shared libraries alone do not reject. Explicit method risk required: ${c.requires_method_diversity === true}; declared risk: ${c.method_diversity_risk || 'assess shared failure modes substantively'}. Give method_risk_assessments with indices [i,j], addresses_shared_failure and methods_distinct booleans (actual mechanisms, never labels), specific risk and method_analysis, plus evidence [{index,source_span,reason}] from BOTH COMPLETE original derivation BODIES, never metadata. Explain why the shared failure mode is independently tested or avoided; distinct hint names or wording do not establish orthogonality. Unsupported evidence is unavailable.`
}
const runtimeObservations = new WeakSet()

// Exact quotation with line endings (CRLF, CR, LF) compared as equal; they are not content.
const sameLineEndings = text => text.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
function occursIn(span, text) {
  return typeof span === 'string' && typeof text === 'string' && sameLineEndings(text).includes(sameLineEndings(span))
}

function validTransport(d) {
  if (!runtimeObservations.has(d)) return false
  const t = d.transport
  if (typeof d.derivation !== 'string' || !d.derivation.trim() || !t || t.exit_code !== 0 || t.execution_id !== d.execution_id) return false
  if (!t.request || typeof t.request.prompt !== 'string' || !t.request.prompt.trim() || typeof t.raw_output !== 'string') return false
  try { const raw = JSON.parse(t.raw_output); return raw.derivation === d.derivation && raw.canonical_answer === d.canonical_answer } catch { return false }
}
function riskPasses(c, ds, idx, cmp) {
  if (c.requires_method_diversity !== true) return true
  return (Array.isArray(cmp.method_risk_assessments) ? cmp.method_risk_assessments : []).some(r => {
    if (!r || r.addresses_shared_failure !== true || r.methods_distinct !== true || !Array.isArray(r.indices) || r.indices.length !== 2 || r.indices[0] === r.indices[1] || r.indices.some(i => !Number.isInteger(i) || !idx.includes(i))) return false
    if (['risk','method_analysis'].some(k => typeof r[k] !== 'string' || r[k].trim().length < 20) || !Array.isArray(r.evidence) || r.evidence.length !== 2) return false
    return r.indices.every(i => r.evidence.some(e => e && e.index === i && typeof e.source_span === 'string' && e.source_span.trim() && occursIn(e.source_span, ds[i].derivation) && typeof e.reason === 'string' && e.reason.trim().length >= 20))
  })
}
function accepted(c, ds, cmp) {
  if (cmp.assessment_input !== JSON.stringify(ds)) return []
  const records = Array.isArray(cmp.independence_assessments) ? cmp.independence_assessments : []
  const good = new Set()
  for (const a of records) {
    if (!a) continue
    const i = a.index
    if (!Number.isInteger(i) || i < 0 || i >= ds.length || !validTransport(ds[i]) || records.filter(x => x && x.index === i).length !== 1) continue
    if (['input_independent','execution_independent','construction_independent','method_applicable','diagnostic'].some(k => a[k] !== true)) continue
    if (!Array.isArray(a.unresolved_defects) || a.unresolved_defects.length) continue
    if (['input','execution','construction','applicability','diagnostic'].every(k => {
      const e = (a.evidence || {})[k]
      return e && typeof e.reason === 'string' && e.reason.trim().length >= 20 && typeof e.source_span === 'string' && e.source_span.trim() && (['input','execution'].includes(k) ? sourceMaterial(ds[i]).some(text => occursIn(e.source_span, text)) : occursIn(e.source_span, ds[i].derivation))
    })) good.add(i)
  }
  const rawIndices = cmp.majority_indices
  if (!Array.isArray(rawIndices) || rawIndices.some(i => !Number.isInteger(i) || i < 0 || i >= ds.length) || new Set(rawIndices).size !== rawIndices.length) return []
  const idx = rawIndices.filter(i => good.has(i))
  const representative = typeof cmp.majority_answer === 'string' && cmp.majority_answer.trim() && idx.some(i => typeof ds[i].canonical_answer === 'string' && ds[i].canonical_answer.trim() === cmp.majority_answer.trim())
  return idx.length >= 2 && Number.isInteger(cmp.majority_size) && cmp.majority_size === rawIndices.length && representative && cmp.adjudicated_matches_majority === true && riskPasses(c, ds, idx, cmp) ? idx : []
}
async function derive(c, method, label, stage) {
  const prompt = vPrompt(c, method)
  const d = await agent(prompt, { label, phase: stage, schema: VERDICT })
  // Host agent() object=completed invocation / null=terminal failure is the actual API boundary.
  // Capture the complete returned object before adding runtime-owned provenance. No author label certifies it.
  if (!d) return null
  const observed = { ...d, execution_id: label, method_hint: method || 'unspecified', transport: {
    execution_id: label, exit_code: 0, request: { prompt }, raw_output: JSON.stringify(d),
  } }
  runtimeObservations.add(observed)
  return observed
}


async function compare(c, ds, label, stage) {
  const prompt = cmpPrompt(c, ds)
  const inputBound = utf8Bytes(prompt) + utf8Bytes(JSON.stringify(COMPARE)) + PROTOCOL_RESERVE
  const configured = { context_tokens: CONTEXT_TOKENS, context_bytes: CONTEXT_BYTES, output_reserve: OUTPUT_RESERVE }
  const unavailable = reason => ({ ...SAFE_CMP, assessment_input: JSON.stringify(ds), request_capacity: {
    ...configured, status: 'unavailable', reason, conservative_input_bound: inputBound,
    observed_usage: null, capture_observation: 'unavailable', compaction_witness: 'unavailable',
  } })
  if (!validBudgets) return unavailable('Invalid configured comparator request budget.')
  // Length decides only carriage. This host protocol returns one object per agent() call and no capture of
  // tool calls or their results, so it cannot show which bytes of frozen files a comparator was returned:
  // material that does not fit one complete request stays unavailable as content not completely read.
  if (inputBound > CONTEXT_BYTES) return unavailable('Content not completely read: the complete comparator material does not fit one request, and this host protocol cannot show which file bytes a comparator was returned; nothing is truncated.')
  // agent() has no authenticated provider token/capture API in this host protocol.
  // Conservatively bound the entire visible request and output before dispatch.
  if (inputBound + OUTPUT_RESERVE > CONTEXT_TOKENS) return unavailable('Complete original comparator request and output reserve exceed configured token window.')
  const reply = await agent(prompt, { label, phase: stage, schema: COMPARE })
  if (!reply || typeof reply !== 'object' || Array.isArray(reply)) return unavailable('Host comparator returned no complete object.')
  const outputBound = utf8Bytes(JSON.stringify(reply))
  if (outputBound > OUTPUT_RESERVE || inputBound + outputBound > CONTEXT_TOKENS) return unavailable('Host comparator output exceeds conservative output/window budget.')
  return { ...reply, assessment_input: JSON.stringify(ds), request_capacity: {
    ...configured, status: 'completed', conservative_input_bound: inputBound, conservative_output_bound: outputBound,
    capacity_evidence: 'conservative_host_bound', observed_usage: null,
    capture_observation: 'unavailable', compaction_witness: 'unavailable',
  } }
}

// A dead comparator (agent() returns null on a terminal backend error) must degrade to "unconverged
// for THIS claim", never crash the run — else one failed adjudicator would throw in Synthesize and lose
// every other claim's verified result. majority_size:0 keeps the claim honestly unconverged (cf.
// contract.md "transient executor failures must NOT count; report unconverged honestly").
const SAFE_CMP = {
  majority_answer: '(comparator unavailable)', majority_size: 0, majority_indices: [],
  adjudicated_matches_majority: false, independence_assessments: [], all_equivalent: false,
  outliers: 'comparator subagent returned null (terminal backend error)',
  correct_answer_adjudicated: '(unadjudicated — comparator unavailable)',
}

function unavailableRow(c, reason, derivations = [], rounds = 0) {
  return {
    claim: c?.id ?? null,
    status: 'unavailable',
    converged: false,
    independent_confirmations: 0,
    independence_evidence: { accepted_evidence_indices: [], method_diversity: [], method_hints: [],
      model_family_diversity: ['host'], execution_independence: 'unavailable', input_independence: 'unavailable' },
    method_risk_assessments: [],
    total_derivations: derivations.length,
    derivation_records: derivations,
    iterate_rounds: rounds,
    agreed_answer: null,
    adjudicated_correct: null,
    outliers: null,
    failure_reason: reason,
  }
}

phase('Verify')
const matrix = await parallel(CLAIMS.map(c => async () => {
  const invalid = [['requires_method_diversity', 'boolean'], ['method_diversity_risk', 'string']]
    .filter(([key, expected]) => Object.prototype.hasOwnProperty.call(c, key) && typeof c[key] !== expected)
    .map(([key]) => key)
  if (invalid.length) return unavailableRow(c, `Invalid claim control types: ${invalid.join(', ')}`)
  let ds = []
  let rounds = 0
  try {
    ds = (await parallel([
      () => derive(c, c.method0, `verify:${c.id}#0`, 'Verify'),
      () => derive(c, c.method1, `verify:${c.id}#1`, 'Verify'),
    ])).filter(Boolean)
    let cmp = await compare(c, ds, `compare:${c.id}`, 'Verify')
    while (accepted(c, ds, cmp).length < 2 && rounds < MAX_ITER) {
      rounds++
      // Tie-break re-uses the two supplied method hints (fresh blind construction, with methods recorded separately) — the
      // contract carries exactly method0/method1. Independence still requires substantive assessment; prior answers are withheld.
      const method = rounds % 2 === 1 ? c.method1 : c.method0
      const extra = await derive(c, method, `tiebreak:${c.id}#r${rounds}`, 'Iterate')
      if (extra) ds.push(extra)
      cmp = await compare(c, ds, `compare:${c.id}#r${rounds}`, 'Iterate')
    }
    return {
      claim: c.id,
      status: accepted(c, ds, cmp).length >= 2 ? 'converged' : (ds.length === 0 || cmp.majority_size === 0 ? 'unavailable' : 'unconverged'),
      converged: accepted(c, ds, cmp).length >= 2,
      independent_confirmations: accepted(c, ds, cmp).length,
      independence_evidence: { accepted_evidence_indices: accepted(c, ds, cmp),
        method_diversity: [...new Set((cmp.independence_assessments || []).map(a => a.observed_method).filter(m => typeof m === 'string' && m.trim()))],
        method_hints: ds.map(d => d.method_hint), model_family_diversity: ['host'],
        execution_independence: accepted(c, ds, cmp).length ? 'assessed' : 'unavailable', input_independence: accepted(c, ds, cmp).length ? 'assessed' : 'unavailable' },
      method_risk_assessments: cmp.method_risk_assessments || [],
      total_derivations: ds.length,
      derivation_records: ds,
      iterate_rounds: rounds,
      agreed_answer: accepted(c, ds, cmp).length >= 2 ? cmp.majority_answer : null,
      adjudicated_correct: accepted(c, ds, cmp).length >= 2 ? cmp.correct_answer_adjudicated : null,
      comparator_diagnostics: { majority_answer: cmp.majority_answer,
        correct_answer_adjudicated: cmp.correct_answer_adjudicated, request_capacity: cmp.request_capacity },
      outliers: cmp.outliers,
    }
  } catch (error) {
    // Preserve any completed original evidence; a transport failure supplies no scientific verdict.
    return unavailableRow(c, `Claim execution failed: ${error instanceof Error ? error.message : String(error)}`, ds, rounds)
  }
}))

phase('Synthesize')
// The host may return null for a failed claim thunk. Preserve the original scope and id at each
// position: omitted evidence cannot make the surviving subset appear fully converged.
const returned = Array.isArray(matrix) ? matrix : []
const rows = CLAIMS.map((c, i) => {
  const row = returned[i]
  return row && row.claim === (c?.id ?? null) ? row : unavailableRow(c, 'Host returned no complete result for this original claim.')
})
const unconverged = rows.filter(m => !m.converged).map(m => m.claim)
const summary = {
  total_claims: CLAIMS.length,
  converged: rows.filter(m => m.converged).length,
  unconverged,
  clean_first_pass: rows.filter(m => m.iterate_rounds === 0 && m.converged).length,
  needed_iteration: rows.filter(m => m.iterate_rounds > 0).map(m => ({ claim: m.claim, rounds: m.iterate_rounds })),
  matrix: rows,
}
log(`derivation-verify: ${summary.converged}/${summary.total_claims} claims have >=2 independent agreeing derivations; iteration on ${summary.needed_iteration.length}; unconverged: ${JSON.stringify(unconverged)}`)
return summary
