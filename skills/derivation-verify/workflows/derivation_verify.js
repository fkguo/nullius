// ============================================================================
// derivation_verify.js — REUSABLE convergence-gate harness for derivation-heavy tasks.
//
// Generic version of the N²LO `verify-converge` run: for EACH atomic claim, spawn >=2 INDEPENDENT
// BLIND re-derivations (method-diverse), an adversarial comparator detects mathematical
// (dis)agreement, and a tie-break loop adds fresh independent derivations until >=2 agree —
// implementing the standing rule "every derivation needs >=2 independent verifications; iterate
// every disagreement to convergence; the leader never self-declares convergence."
//
// USAGE (from the Workflow tool):
//   Workflow({ scriptPath: "tools/workflows/derivation_verify.js", args: {
//     context: "shared ground-truth equations / conventions (string, given to every deriver)",
//     max_iter: 3,                                   // optional, default 3
//     claims: [ {
//       id: "A1",
//       statement: "what to DERIVE BLIND (do not assume the answer)",
//       report_format: "the exact canonical format to report the answer in (e.g. a single rational, or an expression)",
//       method0: "method hint for deriver #0 (a distinct route)",
//       method1: "method hint for deriver #1 (a different distinct route)"
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
    { title: 'Verify',     detail: '2 independent blind re-derivations per claim (method-diverse)' },
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
const MAX_ITER = Number.isInteger(A.max_iter) ? A.max_iter : 3
if (CLAIMS.length === 0) {
  log('derivation-verify: no claims supplied in args.claims — nothing to do.')
  return { total_claims: 0, converged: 0, unconverged: [], clean_first_pass: 0, needed_iteration: [], matrix: [] }
}

const VERDICT = {
  type: 'object', additionalProperties: false,
  properties: {
    canonical_answer: { type: 'string', description: 'the single canonical result in the exact requested format' },
    derivation_summary: { type: 'string', description: '2-6 sentences of the actual steps incl. any computation run and its output' },
    confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
  },
  required: ['canonical_answer', 'derivation_summary', 'confidence'],
}
const COMPARE = {
  type: 'object', additionalProperties: false,
  properties: {
    majority_answer: { type: 'string', description: 'the canonical answer the largest mathematically-equivalent cluster agrees on' },
    majority_size: { type: 'integer', description: 'how many supplied derivations are mathematically equivalent to majority_answer' },
    all_equivalent: { type: 'boolean' },
    outliers: { type: 'string', description: 'for each derivation NOT in the majority: its index and the specific error; "none" if all agree' },
    correct_answer_adjudicated: { type: 'string', description: 'the answer YOU independently judge correct (recompute if needed), with a one-line reason' },
  },
  required: ['majority_answer', 'majority_size', 'all_equivalent', 'outliers', 'correct_answer_adjudicated'],
}

function vPrompt(c, method) {
  return `${CTX}\nBLIND TASK (do NOT assume the answer; derive it from scratch):\n${c.statement}\n\n${method || ''}\n\nOUTPUT: report canonical_answer in EXACTLY this format: ${c.report_format}\nAlso give a short derivation_summary (include any sympy/mpmath/julia output you ran) and your confidence. You MAY use python/julia via Bash to verify integrals/algebra/numerics.`
}
function cmpPrompt(c, ds) {
  const listing = ds.map((d, i) => `[#${i}] canonical_answer="${d.canonical_answer}" | summary: ${d.derivation_summary}`).join('\n')
  return `${CTX}\nYou are an impartial comparator+adjudicator for the claim:\n${c.statement}\nExpected canonical format: ${c.report_format}\n\n${ds.length} independent derivations:\n${listing}\n\nDecide which are MATHEMATICALLY EQUIVALENT (not just string-equal). Report the largest equivalent cluster (majority_answer, majority_size), whether all agree, the outliers WITH their specific error, and the answer YOU independently adjudicate correct (recompute if needed). Be rigorous about signs and factors.`
}
function tiePrompt(c, method, ds) {
  const listing = ds.map((d, i) => `[#${i}] "${d.canonical_answer}"`).join('  ;  ')
  return `${CTX}\nINDEPENDENT TIE-BREAK derivation. Prior attempts disagreed: ${listing}. IGNORE them; derive the claim yourself from scratch, then state your canonical answer.\n${c.statement}\n\n${method || ''}\n\nOUTPUT canonical_answer as: ${c.report_format}\nPlus derivation_summary (show your computation) + confidence.`
}

phase('Verify')
const matrix = await parallel(CLAIMS.map(c => async () => {
  let ds = (await parallel([
    () => agent(vPrompt(c, c.method0), { label: `verify:${c.id}#0`, phase: 'Verify', schema: VERDICT }),
    () => agent(vPrompt(c, c.method1), { label: `verify:${c.id}#1`, phase: 'Verify', schema: VERDICT }),
  ])).filter(Boolean)
  let cmp = await agent(cmpPrompt(c, ds.length ? ds : [{ canonical_answer: '(none)', derivation_summary: 'both verifiers failed' }]),
    { label: `compare:${c.id}`, phase: 'Verify', schema: COMPARE })
  let rounds = 0
  while (cmp.majority_size < 2 && rounds < MAX_ITER) {
    rounds++
    const method = rounds % 2 === 1 ? c.method1 : c.method0
    const extra = await agent(tiePrompt(c, method, ds), { label: `tiebreak:${c.id}#r${rounds}`, phase: 'Iterate', schema: VERDICT })
    if (extra) ds.push(extra)
    cmp = await agent(cmpPrompt(c, ds), { label: `compare:${c.id}#r${rounds}`, phase: 'Iterate', schema: COMPARE })
  }
  return {
    claim: c.id,
    converged: cmp.majority_size >= 2,
    independent_confirmations: cmp.majority_size,
    total_derivations: ds.length,
    iterate_rounds: rounds,
    agreed_answer: cmp.majority_answer,
    adjudicated_correct: cmp.correct_answer_adjudicated,
    outliers: cmp.outliers,
  }
}))

phase('Synthesize')
const unconverged = matrix.filter(m => !m.converged).map(m => m.claim)
const summary = {
  total_claims: matrix.length,
  converged: matrix.filter(m => m.converged).length,
  unconverged,
  clean_first_pass: matrix.filter(m => m.iterate_rounds === 0 && m.converged).length,
  needed_iteration: matrix.filter(m => m.iterate_rounds > 0).map(m => ({ claim: m.claim, rounds: m.iterate_rounds })),
  matrix,
}
log(`derivation-verify: ${summary.converged}/${summary.total_claims} claims have >=2 independent agreeing derivations; iteration on ${summary.needed_iteration.length}; unconverged: ${JSON.stringify(unconverged)}`)
return summary
