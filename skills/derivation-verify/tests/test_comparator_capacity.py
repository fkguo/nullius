"""Current subprocess/capacity protocol checks; no model-semantic judgment."""
import hashlib
import importlib.util
import json
import os
import sys
from pathlib import Path

import pytest
from assessment_fixture import SUMMARY, assessments

SCRIPT = Path(__file__).resolve().parents[1] / 'scripts/run_multi_backend.py'
spec = importlib.util.spec_from_file_location('capacity_derivation_executor', SCRIPT)
mb = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mb)
import runtime_capture_observation as runtime
import run_multi_task

CLAIM = {'id':'anonymous','statement':'Derive from neutral raw integers.','report_format':'integer'}

def lanes():
    raw = json.dumps({'canonical_answer':'42','derivation':SUMMARY,'checkable_form':'42','confidence':'high'})
    return [mb._execute_derivation(lambda *a:raw,'claude/offline','neutral','raw operands',f'original-{i}') for i in range(2)]

def compare(run, ds=None):
    ds = ds or lanes()
    result,count = mb._compare(CLAIM,'Neutral original inputs.',ds,['host','host'],['claude/offline'],run,tag='compare')
    return ds,result,count

def actual(tmp_path, monkeypatch, mode='complete', *, budget=None):
    monkeypatch.setattr(runtime,'_authority_dir',lambda:tmp_path/'host-authority')
    def run(model, system, prompt, tag):
        # One directory per comparator request: the joint request and each per-lane request.
        d=tmp_path/'current'/tag.replace('/','__');d.mkdir(parents=True)
        reply={'majority_answer':'42','majority_size':2,'majority_indices':[0,1],'adjudicated_matches_majority':True}
        if 'FULL_DERIVATION_RECORDS_JSON:\n' in prompt:
            ds,_=json.JSONDecoder().raw_decode(prompt.split('FULL_DERIVATION_RECORDS_JSON:\n')[1])
            reply={'independence_assessments':assessments(ds)}
        report=json.dumps(reply)
        systemp,promptp,out=d/'system.txt',d/'prompt.txt',d/'out.txt'
        systemp.write_text(system);promptp.write_text(prompt)
        cap=Path(str(out)+'.attempts')/'run.current';receipt=cap/'budget.json'
        budget_record={'status':'completed','runner_exit_code':0,'input_sha256':[hashlib.sha256(t.encode()).hexdigest() for t in (system,prompt)],'attempts':[{'status':'exited','exit_code':0}]}
        usage={'input_tokens':100,'output_tokens':20}
        if mode=='over-window':usage={'input_tokens':180000,'cache_read_input_tokens':10000,'output_tokens':20000}
        if mode=='output-budget':usage={'input_tokens':100,'output_tokens':32769}
        if mode=='multipart-crlf':report=json.dumps(json.loads(report),indent=2).replace('\n','\r\n')
        terminal=report[len(report)//2:] if mode in ('multipart','multipart-crlf') else report
        event={'type':'result','subtype':'success','is_error':False,'result':terminal,'usage':usage}
        records=[event]
        if mode in ('multipart','multipart-crlf'):
            records=[{'type':'assistant','message':{'id':mid,'content':[{'type':'text','text':body}]}}
                     for mid,body in [('first',report[:len(report)//2]),('last',terminal)]]+[event]
        # A compacted capture still ends in its terminal result event, which the result sidecar must match.
        if mode=='compacted':records=[{'type':'system','subtype':'compact_boundary'}]+records
        event_line='\n'.join(json.dumps(r) for r in records)
        script=d/'transport.py';script.write_text('from pathlib import Path\nimport sys\n'
            +f'cap=Path({str(cap)!r});cap.mkdir(parents=True)\n'
            +f'Path({str(out)!r}).write_text({report!r})\n'
            +f'(cap/"budget.json").write_text({json.dumps(budget_record)!r})\n'
            +f'(cap/"attempt_1.events.jsonl").write_text({(event_line+chr(10))!r})\n'
            +f'(cap/"attempt_1.events.result.json").write_text({json.dumps(event)!r})\n'
            +f'sys.exit({9 if mode=="failed" else 0})\n')
        cmd=[sys.executable,str(script),'--system-prompt-file',str(systemp),'--prompt-file',str(promptp),'--out',str(out)]
        old=Path.cwd()
        try:
            if mode=='foreign-cwd':os.chdir(tmp_path)
            window = None if mode == 'unsigned-window' else (50000 if mode == 'relabeled-window' else run.request_budgets['context_tokens'])
            process=run_multi_task._run_with_timeout(cmd,timeout_secs=10,context_tokens=window)
        finally:os.chdir(old)
        (d/'meta.json').write_text(json.dumps({'agents':[{'success':True,'out':str(out),'capture_receipt':str(receipt)}]}))
        run.invocations[tag]={'exit_code':process['exit_code'],'output':str(out)}
        if mode=='missing-observation':Path(str(out)+'.runtime-observation.json').unlink()
        if mode=='rehashed-output':out.write_text(report+'\n')
        if mode=='changed-request':
            rec=json.loads(receipt.read_text());rec['input_sha256']=['0'*64,'1'*64];receipt.write_text(json.dumps(rec))
        return report
    run.invocations={}
    run.request_budgets=budget or mb.request_budgets()
    return run

def test_actual_current_capacity_binds_complete_original_request_and_report(tmp_path,monkeypatch):
    ds,cmp,count=compare(actual(tmp_path,monkeypatch))
    assert count==1 and mb.claim_status(cmp,ds,['host','host'])[0]
    assert cmp['request_capacity']['judges'][0]['capacity']['capacity_evidence']=='observed_usage'
    # Each lane's own request holds that lane's complete material, and only that lane.
    for i in range(2):
        packet=(tmp_path/f'current/compare_j0_claude_lane{i}/prompt.txt').read_text()
        decoded,_=json.JSONDecoder().raw_decode(packet.split('FULL_DERIVATION_RECORDS_JSON:\n')[1])
        assert [d['index'] for d in decoded]==[i] and decoded[0]['derivation']==SUMMARY
    assert 'FULL_DERIVATION_RECORDS_JSON' not in (tmp_path/'current/compare_j0_claude/prompt.txt').read_text()

REFUSAL_REASONS={'over-window':'observed request usage exceeds configured token window',
    'output-budget':'observed comparator output exceeds configured output budget',
    'compacted':'original request context was observably compacted',
    'failed':'actual request invocation did not complete successfully',
    'foreign-cwd':'runtime observation working directory mismatch',
    'missing-observation':'unavailable: runtime observation missing',
    'rehashed-output':'runtime observation captured/report bytes mismatch',
    'changed-request':'capacity receipt is not the exact successful original request',
    'unsigned-window':'runtime observation capacity policy absent or mismatched',
    'relabeled-window':'runtime observation capacity policy absent or mismatched'}

@pytest.mark.parametrize('mode',sorted(REFUSAL_REASONS))
def test_actual_capacity_failure_cannot_supply_confirmation(tmp_path,monkeypatch,mode):
    ds,cmp,count=compare(actual(tmp_path,monkeypatch,mode))
    assert count==0 and not mb.claim_status(cmp,ds,['host','host'])[0]
    assert cmp['accepted_indices']==[]
    judge=cmp['request_capacity']['judges'][0]
    assert judge['status']=='unavailable'
    assert REFUSAL_REASONS[mode] in judge['reason']  # each mode is refused for its own reason

def test_full_packet_byte_budget_refuses_before_any_comparator_dispatch():
    calls=[]
    def run(*a):calls.append(a);return '{}'
    run.request_budgets=mb.request_budgets(context_bytes=12000)
    ds=lanes();ds[0]['derivation']='Original complete bytes λ\n'*1000
    _,cmp,count=compare(run,ds)
    assert not calls and count==0
    assert 'content not completely read' in cmp['request_capacity']['judges'][0]['reason']
    assert ds[0]['derivation'].endswith('λ\n')

def test_host_token_window_refuses_before_dispatch_without_capture():
    calls=[]
    def run(*a):calls.append(a);return '{}'
    run.request_budgets=mb.request_budgets(41000,200000)
    _,cmp,count=compare(run)
    assert not calls and count==0
    assert 'conservative token window' in cmp['request_capacity']['judges'][0]['reason']

def test_binding_omission_and_change_cannot_skip_current_original_input():
    ds=lanes();aa=assessments(ds)
    cmp={'majority_answer':'42','majority_size':2,'majority_indices':[0,1],'adjudicated_matches_majority':True,'independence_assessments':aa}
    assert not mb.claim_status(cmp,ds,['host','host'])[0]
    assert not mb.decide_converged(cmp,['host','host'],derivations=ds)
    cmp['assessment_input_sha256']=hashlib.sha256(json.dumps(ds,ensure_ascii=False,sort_keys=True).encode()).hexdigest()
    assert mb.decide_converged(cmp,['host','host'],derivations=ds)
    cmp['assessment_input_sha256']='0'*64
    assert not mb.decide_converged(cmp,['host','host'],derivations=ds)

def test_invalid_cli_window_refuses_before_creating_runtime_records(tmp_path,capsys):
    claims=tmp_path/'claims.json';claims.write_text(json.dumps({'claims':[CLAIM]}))
    out=tmp_path/'matrix.json'
    assert mb.main(['--claims',str(claims),'--out',str(out),'--context-tokens','0'])==2
    assert 'invalid configured request token window' in capsys.readouterr().err
    assert not out.exists() and not Path(str(out)+'.derivation-records').exists()

def test_gate_tracking_wrapper_keeps_caller_capacity_and_refuses_before_compare():
    calls=[]
    body=SUMMARY+'\n'+('Complete original step λ.\n'*500)
    def run(model,system,prompt,tag):
        if 'compare' in tag:
            calls.append(tag)
            return '{}'
        return json.dumps({'canonical_answer':'42','derivation':body,'checkable_form':'42','confidence':'high'})
    run.request_budgets=mb.request_budgets(context_bytes=12000)
    result=mb.run_gate({'context':'Neutral raw input.','max_iter':0,'claims':[CLAIM]},pool=['claude/offline'],comparators=['claude/offline'],run=run)
    assert not calls and result['converged']==0
    capacity=result['matrix'][0]['comparator_diagnostics']['request_capacity']
    assert capacity['configured']['context_bytes']==12000
    assert capacity['judges'][0]['status']=='unavailable'
    assert all(d['derivation']==body for d in result['matrix'][0]['derivation_records'])

@pytest.mark.parametrize('mode',['multipart','multipart-crlf'])
def test_complete_multipart_report_reaches_actual_comparator_capacity(tmp_path,monkeypatch,mode):
    ds,cmp,count=compare(actual(tmp_path,monkeypatch,mode))
    assert count==1 and mb.claim_status(cmp,ds,['host','host'])[0]
    output=(tmp_path/'current/compare_j0_claude/out.txt').read_bytes().decode('utf-8')
    sidecar=json.loads(next((tmp_path/'current/compare_j0_claude/out.txt.attempts').glob('run.*/*.events.result.json')).read_text())
    assert output != sidecar['result']
    assert cmp['request_capacity']['judges'][0]['capacity']['observed_usage']==[{'input_tokens':100,'output_tokens':20}]
    if mode=='multipart-crlf':assert '\r\n' in output


def lane_packets(ds):
    """The lane entries as their own per-lane requests carry them, one lane per request."""
    decoded=[]
    for i,d in enumerate(ds):
        packet=mb._assess_prompt('Raw inputs only.',CLAIM,mb._lane_entry(d,'host',i))
        entries,_=json.JSONDecoder().raw_decode(packet.split('FULL_DERIVATION_RECORDS_JSON:\n')[1])
        assert [e['index'] for e in entries]==[i]
        decoded+=entries
    return decoded


def test_comparator_receives_steps_outside_selected_json_field():
    early='An earlier original premise and necessary step.\r\n'
    raw=early+json.dumps({'canonical_answer':'42','derivation':SUMMARY,'checkable_form':'42','confidence':'high'})
    ds=[mb._execute_derivation(lambda *a:raw,'claude/offline','neutral','raw operands',f'original-{i}') for i in range(2)]
    decoded=lane_packets(ds)
    assert all(d['derivation_context']==raw and d['derivation']==SUMMARY for d in decoded)
    assert all(mb.valid_derivation_transport(d) for d in ds)



def decoded_packet(raw):
    ds=[mb._execute_derivation(lambda *a:raw,'claude/offline','neutral','raw operands',f'original-{i}') for i in range(2)]
    return ds,lane_packets(ds)


def test_comparator_request_omits_byte_identical_copies_of_the_original_output():
    raw=json.dumps({'canonical_answer':'42','derivation':SUMMARY,'checkable_form':'42','confidence':'high'})
    ds,decoded=decoded_packet(raw)
    # Without assistant text outside the JSON object, the structured derivation is the whole context.
    assert all('derivation_context' not in d and 'original_assistant_output' not in d for d in decoded)
    assert all(d['transport']['raw_output']==raw and d['derivation']==SUMMARY for d in decoded)
    assert all(ds[i]['original_assistant_output']==raw for i in range(2))
    early='An earlier original premise and necessary step.\r\n'
    ds,decoded=decoded_packet(early+raw)
    # With such text, derivation_context is the complete original output and transport names it.
    assert all(d['derivation_context']==early+raw and 'raw_output' not in d['transport'] for d in decoded)
    assert all(d['transport']['raw_output_given_as']=='derivation_context' for d in decoded)
    assert all(ds[i]['transport']['raw_output']==early+raw and mb.valid_derivation_transport(ds[i]) for i in range(2))
