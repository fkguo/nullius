// Execute the checked-in script with the host protocol injected. This tests transport behavior,
// not an installed Workflow platform or a semantic model reviewer.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
const source = readFileSync(new URL('../workflows/derivation_verify.js', import.meta.url), 'utf8')
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
const execute = new AsyncFunction('args', 'agent', 'parallel', 'phase', 'log', source.replace('export const meta =', 'const meta ='))
const axes = ['input','execution','construction','applicability','diagnostic']
async function check(kind, requireRisk = false) {
  let calls = []
  const plain = 'Raw operands are 17 and 25. Independently expand 25=20+5, add 17+20=37 then add 5=42. Exact integers have no rounding error; a one-unit mismatch is detectable.\n' + 'Original intermediate step.\n'.repeat(200) + 'FULL_FINAL_ANCHOR'
  // CRLF lanes are quoted with plain newlines: only line endings may differ from the original.
  const complete = kind.startsWith('crlf-') ? plain.replace(/\n/g, '\r\n') : plain
  const claim = { id: 'anonymous', statement: 'Compute the sum of raw integers 17 and 25.', report_format: 'integer', method0: 'name one', method1: 'different name', requires_method_diversity: requireRisk }
  const agent = async (prompt, options) => {
    calls.push({ prompt, options })
    if (options.label.startsWith('verify:')) {
      assert(options.schema.required.includes('derivation'))
      if (kind === 'failed' && options.label.endsWith('#1')) return null
      const d = { canonical_answer: '42', derivation: complete, derivation_summary: 'short navigation summary', confidence: 'high' }
      if (kind === 'missing') delete d.derivation
      // Author-supplied provenance must never overwrite runtime-owned observation.
      d.transport = { exit_code: 0, request: {prompt: 'author claims fresh'}, raw_output: 'author claims fresh' }
      return d
    }
    const packet = JSON.parse(prompt.split('FULL_DERIVATION_RECORDS_JSON:\n')[1].split('\n\n')[0])
    if (kind !== 'missing') assert(packet.every(d => d.derivation === complete && d.derivation.includes('FULL_FINAL_ANCHOR')))
    assert(packet.every(d => d.transport.request.prompt.includes(claim.statement)))
    assert(packet.every(d => JSON.parse(d.transport.raw_output).canonical_answer === '42'))
    const assessment = packet.map((d, index) => ({ index, observed_method: 'exact addition from raw operands',
      input_independent: kind !== 'polluted', execution_independent: true, construction_independent: true,
      method_applicable: true, diagnostic: true, unresolved_defects: [],
      evidence: Object.fromEntries(axes.map(k => [k, { source_span: d.derivation?.slice(0, 200) || 'author claims fresh', reason: 'The mock source examiner inspects the complete raw operands and actual lane steps for ' + k }])) }))
    if (kind.startsWith('crlf-')) assessment.forEach(a => axes.forEach(k => {
      const quote = plain.slice(0, 200)
      assert(quote.includes('\n') && !complete.includes(quote))
      a.evidence[k].source_span = kind === 'crlf-altered' ? quote.replace('5=42', '5=43')
        : kind === 'crlf-spacing' ? quote.replace('Raw operands are', 'Raw  operands are') : quote
    }))
    if (kind.startsWith('metadata-')) {
      const axis = kind.slice('metadata-'.length)
      assessment.forEach(a => { a.evidence[axis].source_span = claim.statement })
    }
    if (kind === 'transport-anchors-allowed') assessment.forEach(a => {
      a.evidence.input.source_span = claim.statement; a.evidence.execution.source_span = claim.statement
    })
    const risk = requireRisk ? [{indices: [0,1], addresses_shared_failure: true, methods_distinct: ['risk-accepted','crlf-accepted'].includes(kind),
      risk: 'Operand mistranscription is a known shared failure to diagnose with independently inspected inputs.',
      method_analysis: 'Two actual raw-operand constructions independently inspect the input and address the declared shared failure.',
      evidence: packet.map((d,index) => ({index,source_span: kind.startsWith('crlf-') ? plain : d.derivation,reason:'The actual raw-operand steps explain this diagnostic independently of route names.'}))}] : []
    return { majority_answer: '42', majority_size: packet.length, majority_indices: packet.map((_,i)=>i),
      all_equivalent: true, adjudicated_matches_majority: true, correct_answer_adjudicated: '42', outliers: 'none',
      independence_assessments: assessment, method_risk_assessments: risk }
  }
  const result = await execute({context:'Neutral raw inputs only.',max_iter:0,claims:[claim]},agent,fs=>Promise.all(fs.map(f=>f())),()=>{},()=>{})
  assert.equal(result.matrix[0].converged, ['accepted','risk-accepted','transport-anchors-allowed','crlf-accepted'].includes(kind))
  if (!result.matrix[0].converged) {
    assert.equal(result.matrix[0].agreed_answer, null)
    assert.equal(result.matrix[0].adjudicated_correct, null)
    assert.equal(typeof result.matrix[0].comparator_diagnostics.majority_answer, 'string')
  }
  assert.equal(calls.filter(x=>x.options.label.startsWith('verify:')).length,2)
  return result
}
await check('accepted')
await check('different-hints-same-method',true)
await check('risk-accepted',true)
await check('polluted')
await check('failed')
await check('missing')
console.log('6 Native script host-protocol behavior cases passed; installed Workflow platform unavailable.')
await check('crlf-accepted')
await check('crlf-accepted', true)
await check('crlf-altered')
await check('crlf-spacing')
console.log('4 line-ending quote cases passed; only CRLF/CR/LF may differ from the original.')

// Scope completeness: a successful sibling cannot hide an unavailable original claim.
// These execute the real script, independently of the six single-claim protocol cases above.
async function checkOriginalClaimRetention(failure) {
  const claims = ['complete-original', 'failed-original'].map(id => ({ id,
    statement: 'Derive the sum of raw integers 17 and 25.', report_format: 'integer', method0: 'addition', method1: 'addition' }))
  const original = 'Read raw integers 17 and 25; decompose 25 as 20+5, compute 17+20=37 and 37+5=42. Exact integer arithmetic applies.'
  let outer = true
  const hostParallel = async tasks => {
    if (outer) {
      outer = false
      const rows = await Promise.all(tasks.map(task => task()))
      if (failure === 'host-null') rows[1] = null
      return rows
    }
    return Promise.all(tasks.map(task => task()))
  }
  const agent = async (prompt, options) => {
    if (options.label.startsWith('verify:')) {
      if (failure === 'throw' && options.label.includes('failed-original')) throw new Error('Actual injected host transport failure')
      return { canonical_answer: '42', derivation: original, confidence: 'high' }
    }
    const ds = JSON.parse(prompt.split('FULL_DERIVATION_RECORDS_JSON:\n')[1].split('\n\n')[0])
    return { majority_answer: '42', majority_size: ds.length, majority_indices: ds.map((_,i)=>i),
      adjudicated_matches_majority: true, all_equivalent: true, outliers: 'none', correct_answer_adjudicated: '42', method_risk_assessments: [],
      independence_assessments: ds.map((d,index) => ({ index, observed_method: 'exact integer addition',
        input_independent: true, execution_independent: true, construction_independent: true, method_applicable: true, diagnostic: true,
        unresolved_defects: [], evidence: Object.fromEntries(axes.map(axis => [axis, {
          source_span: d.derivation, reason: 'Mock examiner inspects the actual complete raw-operand construction and successful invocation for ' + axis,
        }])) })) }
  }
  const result = await execute({context:'Neutral raw inputs only.',max_iter:0,claims},agent,hostParallel,()=>{},()=>{})
  assert.equal(result.total_claims, 2)
  assert.equal(result.matrix.length, 2)
  assert.deepEqual(result.matrix.map(row => row.claim), claims.map(c => c.id))
  assert.equal(result.converged, 1)
  assert.equal(result.converged === result.total_claims, false)
  assert.deepEqual(result.unconverged, ['failed-original'])
  const row = result.matrix[1]
  assert.equal(row.status, 'unavailable')
  assert.equal(row.converged, false)
  assert.equal(row.independent_confirmations, 0)
  assert.deepEqual(row.independence_evidence.accepted_evidence_indices, [])
  assert.equal(row.agreed_answer, null)
  assert.equal(row.adjudicated_correct, null)
  assert.equal(typeof row.failure_reason, 'string')
  assert(row.failure_reason.length > 0)
  return result
}
await checkOriginalClaimRetention('throw')
await checkOriginalClaimRetention('host-null')
console.log('2 original-claim failure-retention behavior cases passed; no failed original claim omitted or accepted.')

await check('metadata-construction')
await check('metadata-applicability')
await check('metadata-diagnostic')
await check('transport-anchors-allowed')
console.log('4 body-only scientific-axis and transport-only provenance cases passed.')

// An uneligible agreeing candidate cannot erase two good confirmations; raw cluster cardinality remains exact.
async function checkThreeCandidateCluster(forgeCardinality) {
  const body = 'Read raw operands 17 and 25, compute 17+20=37 then 37+5=42 using exact integer addition; operand mismatches are detectable.'
  const agent = async (prompt, options) => {
    if (options.label.startsWith('verify:') || options.label.startsWith('tiebreak:')) return { canonical_answer:'42',derivation:body,confidence:'high' }
    const ds = JSON.parse(prompt.split('FULL_DERIVATION_RECORDS_JSON:\n')[1].split('\n\n')[0])
    return {majority_answer:'42',majority_indices:ds.map((_,i)=>i),majority_size:forgeCardinality && ds.length===3 ? 2 : ds.length,
      adjudicated_matches_majority:ds.length===3,correct_answer_adjudicated:'42',all_equivalent:true,outliers:'none',method_risk_assessments:[],
      independence_assessments:ds.map((d,index)=>({index,observed_method:'exact integer addition',input_independent:true,execution_independent:true,
        construction_independent:index!==2,method_applicable:true,diagnostic:true,unresolved_defects:[],evidence:Object.fromEntries(axes.map(axis=>[axis,{source_span:body,reason:'Mock examiner checks complete raw steps and actual original execution for '+axis}]))}))}
  }
  const result=await execute({context:'Raw inputs only.',max_iter:1,claims:[{id:'three',statement:'Add raw17 and25.',report_format:'integer'}]},agent,fs=>Promise.all(fs.map(f=>f())),()=>{},()=>{})
  const row=result.matrix[0]
  assert.equal(row.converged,!forgeCardinality)
  assert.equal(row.independent_confirmations,forgeCardinality ? 0 : 2)
  assert.deepEqual(row.independence_evidence.accepted_evidence_indices,forgeCardinality ? [] : [0,1])
}
await checkThreeCandidateCluster(false)
await checkThreeCandidateCluster(true)
console.log('2 exact raw-cardinality and eligible-confirmation protocol cases passed.')

// Full visible request capacity is enforced before any comparator host invocation.
async function checkCapacity(kind) {
  const complete = 'Use neutral raw operands and derive the exact result with explicit domain and diagnostic limits.' + (kind === 'byte-budget' ? '\nComplete original λ step.'.repeat(20000) : '')
  let comparisons = 0
  const agent = async (prompt, options) => {
    if (options.label.startsWith('verify:')) return { canonical_answer:'42', derivation:complete, confidence:'high', transport:{capture:'author JSON cannot create a capture'} }
    comparisons++
    const ds = JSON.parse(prompt.split('FULL_DERIVATION_RECORDS_JSON:\n')[1].split('\n\n')[0])
    assert(ds.every(d => d.derivation === complete))
    return {majority_answer:'42',majority_size:2,majority_indices:[0,1],adjudicated_matches_majority:true,
      correct_answer_adjudicated:kind === 'output-budget' ? 'x'.repeat(40000) : '42',all_equivalent:true,outliers:'none',method_risk_assessments:[],
      independence_assessments:ds.map((d,index) => ({index,input_independent:true,execution_independent:true,construction_independent:true,method_applicable:true,diagnostic:true,unresolved_defects:[],
        evidence:Object.fromEntries(axes.map(axis=>[axis,{source_span:d.derivation.slice(0,160),reason:'The injected host examiner inspects complete original raw evidence for '+axis}]))}))}
  }
  const config = {context:'Neutral original input.',max_iter:0,claims:[{id:'capacity',statement:'Derive from raw inputs.',report_format:'integer'}]}
  if (kind === 'token-window') Object.assign(config,{context_tokens:41000,context_bytes:200000})
  if (kind === 'invalid-budget') Object.assign(config,{context_tokens:0})
  const result = await execute(config,agent,fs=>Promise.all(fs.map(f=>f())),()=>{},()=>{})
  const row = result.matrix[0]
  assert.equal(row.converged,kind === 'small')
  assert.equal(comparisons,['small','output-budget'].includes(kind) ? 1 : 0)
  assert.equal(row.comparator_diagnostics.request_capacity.capture_observation,'unavailable')
  assert.equal(row.comparator_diagnostics.request_capacity.compaction_witness,'unavailable')
  if (kind !== 'small') assert.equal(row.independent_confirmations,0)
}
for (const kind of ['small','byte-budget','token-window','invalid-budget','output-budget']) await checkCapacity(kind)

// Long material in this executor: no capture of reads exists, so it is unavailable as content not completely
// read, before any comparator call, and the complete lane text is kept, never cut.
async function checkNativeLongMaterialUnavailable() {
  const complete = 'Use neutral raw operands and derive the exact result.' + '\nComplete original λ step.'.repeat(20000)
  let comparisons = 0
  const agent = async (prompt, options) => {
    if (options.label.startsWith('verify:')) return { canonical_answer:'42', derivation:complete, confidence:'high' }
    comparisons++
    return null
  }
  const result = await execute({context:'Neutral original input.',max_iter:0,claims:[{id:'long',statement:'Derive from raw inputs.',report_format:'integer'}]},agent,fs=>Promise.all(fs.map(f=>f())),()=>{},()=>{})
  const row = result.matrix[0]
  assert.equal(comparisons, 0)
  assert.equal(row.converged, false)
  assert.equal(row.independent_confirmations, 0)
  assert.match(row.comparator_diagnostics.request_capacity.reason, /^Content not completely read: .*cannot show which file bytes a comparator was returned; nothing is truncated\.$/)
  assert(row.derivation_records.every(d => d.derivation === complete))
}
await checkNativeLongMaterialUnavailable()
console.log('1 native long-material read-coverage-unavailable case passed.')
console.log('5 full original request/window/output Native capacity cases passed; token/capture/compaction witness unavailable.')


// Claim-control types are checked before the actual host dispatch boundary.
for (const [key, values] of [['requires_method_diversity', ['true', 1, null, [], {}]], ['method_diversity_risk', [true, 1, null, [], {}]]]) {
  for (const value of values) {
    let calls = 0
    const claim = {id:'invalid-controls',statement:'Derive from raw inputs.',[key]:value}
    const result = await execute({claims:[claim],max_iter:0},async()=>{calls++;throw new Error('must not dispatch')},fs=>Promise.all(fs.map(f=>f())),()=>{},()=>{})
    assert.equal(calls,0)
    assert.equal(result.total_claims,1)
    assert.deepEqual(result.unconverged,['invalid-controls'])
    const row=result.matrix[0]
    assert.equal(row.status,'unavailable')
    assert.equal(row.independent_confirmations,0)
    assert.equal(row.agreed_answer,null)
    assert.equal(row.adjudicated_correct,null)
  }
}
console.log('10 invalid claim-control cases rejected before host dispatch; literal boolean positive cases retained above.')

// The comparator packet carries each lane's text once as derivation and once inside transport.raw_output;
// no other field repeats it (assessment_source is no longer shipped). Input/execution spans may come from
// the derivation, the summary, or the transport record as encoded or as decoded values; construction may not.
const PACKET_ANCHOR = 'PACKET_COPY_ANCHOR'
async function packetRun(spans, reply = {}) {
  let packet = null
  const body = 'Read raw operands 17 and 25; expand 25=20+5, add 17+20=37 then 37+5=42; exact integers detect a one-unit error.\n' + 'Original intermediate step.\n'.repeat(50) + PACKET_ANCHOR
  const claim = { id: 'packet', statement: 'Compute the sum of raw integers 17 and 25.', report_format: 'integer' }
  const agent = async (prompt, options) => {
    // The summary carries a quote and a newline: JSON-escaped inside raw_output, so only the summary source matches it.
    if (options.label.startsWith('verify:')) return { canonical_answer: '42', derivation: body, derivation_summary: 'Navigation "summary"\nonly', confidence: 'high', ...reply }
    packet = { text: prompt, records: JSON.parse(prompt.split('FULL_DERIVATION_RECORDS_JSON:\n')[1].split('\n\n')[0]) }
    return { majority_answer: '42', majority_size: 2, majority_indices: [0, 1], adjudicated_matches_majority: true, all_equivalent: true,
      outliers: 'none', correct_answer_adjudicated: '42', method_risk_assessments: [],
      independence_assessments: packet.records.map((d, index) => ({ index, observed_method: 'exact integer addition', input_independent: true,
        execution_independent: true, construction_independent: true, method_applicable: true, diagnostic: true, unresolved_defects: [],
        evidence: Object.fromEntries(axes.map(axis => [axis, { source_span: spans(d)[axis] ?? body.slice(0, 120),
          reason: 'The mock examiner inspects the complete actual lane material and transport for ' + axis }])) })) }
  }
  const result = await execute({ context: 'Neutral raw inputs only.', max_iter: 0, claims: [claim] }, agent, fs => Promise.all(fs.map(f => f())), () => {}, () => {})
  return { row: result.matrix[0], packet, body }
}
async function checkPacketCopies() {
  const { row, packet } = await packetRun(() => ({}))
  assert.equal(row.converged, true)
  for (const record of packet.records) {
    const copies = Object.fromEntries(Object.entries(record).map(([k, v]) => [k, JSON.stringify(v).split(PACKET_ANCHOR).length - 1]).filter(([, n]) => n > 0))
    assert.deepEqual(copies, { derivation: 1, transport: 1 })
    assert(!('assessment_source' in record))
  }
  assert.equal(packet.text.split(PACKET_ANCHOR).length - 1, 2 * packet.records.length)
}
await checkPacketCopies()
// The native host protocol observes no capture stream: agent() returns one object. The packet's transport
// therefore holds exactly the runtime-owned request and raw output, and carries no captured_records to
// inline or reference, even when the reply claims a capture of its own.
async function checkNativeCapturedRecords() {
  const { row, packet } = await packetRun(() => ({}), { transport: { captured_records: { 'attempt_1.events.jsonl': '{"type":"result"}' } } })
  assert.equal(row.converged, true)
  for (const record of packet.records) {
    assert.deepEqual(Object.keys(record.transport).sort(), ['execution_id', 'exit_code', 'raw_output', 'request'])
    assert.deepEqual(Object.fromEntries(Object.entries(record).map(([k, v]) => [k, JSON.stringify(v).split(PACKET_ANCHOR).length - 1]).filter(([, n]) => n > 0)), { derivation: 1, transport: 1 })
  }
}
await checkNativeCapturedRecords()
async function checkSpanSources(axis, pick, converged) {
  const { row } = await packetRun(d => ({ [axis]: pick(d) }))
  assert.equal(row.converged, converged, `${axis}: ${converged ? 'accepted' : 'refused'}`)
}
await checkSpanSources('input', d => d.derivation_summary, true)                       // summary (quote + newline)
await checkSpanSources('execution', d => JSON.stringify(d.transport).slice(0, 60), true) // transport as the packet encodes it
await checkSpanSources('input', d => d.transport.request.prompt, true)                   // decoded transport value
await checkSpanSources('execution', d => 'text in no lane material at all', false)
await checkSpanSources('construction', d => d.derivation_summary, false)                 // body only for the scientific axes
await checkSpanSources('construction', d => d.transport.request.prompt, false)
console.log('1 native packet copy-count case, 1 native no-capture transport case and 6 input/execution span-source cases passed.')
