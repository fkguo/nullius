"""Actual launcher transport bytes stay original; offline reports are protocol only."""
import hashlib
import json
import shlex
import sys
from pathlib import Path

import pytest

BIN = Path(__file__).resolve().parents[1] / "scripts/bin"
sys.path.insert(0, str(BIN))
import review_one
import run_multi_task
import runtime_capture_observation as runtime


@pytest.fixture(autouse=True)
def host_authority(tmp_path, monkeypatch):
    monkeypatch.setattr(runtime, '_authority_dir', lambda: tmp_path/'host-authority')


def runner(tmp_path, body, *, capture):
    script=tmp_path/'offline_backend.py'
    script.write_text('''import argparse,hashlib,json
from pathlib import Path
p=argparse.ArgumentParser();p.add_argument('--out');p.add_argument('--system-prompt-file');p.add_argument('--prompt-file');a,_=p.parse_known_args()
out=Path(a.out)
''' + f'body={body!r}\nout.write_bytes(body.encode("utf8"))\n' + ('''
root=Path(str(out)+'.attempts')/'run.current';root.mkdir(parents=True)
budget={'status':'completed','runner_exit_code':0,'input_sha256':[hashlib.sha256(Path(x).read_bytes()).hexdigest() for x in (a.system_prompt_file,a.prompt_file)],'attempts':[{'status':'exited','exit_code':0}]}
event={'type':'result','subtype':'success','is_error':False,'result':body,'usage':{'input_tokens':31,'output_tokens':11}}
(root/'budget.json').write_text(json.dumps(budget))
(root/'attempt_1.events.result.json').write_text(json.dumps(event))
(root/'attempt_1.events.jsonl').write_text(json.dumps(event)+'\\n')
''' if capture else ''))
    shell=tmp_path/'offline_backend.sh'
    shell.write_text('#!/usr/bin/env bash\nexec '+shlex.quote(sys.executable)+' '+shlex.quote(str(script))+' "$@"\n');shell.chmod(0o755)
    return shell


@pytest.mark.parametrize('fenced',[False,True])
def test_review_one_contract_check_preserves_captured_exact_report_and_signature(tmp_path,fenced):
    body=json.dumps({'blocking_issues':[],'verdict':'PASS','summary':'Complete original output λ'},ensure_ascii=False)
    if fenced:body='```json\n'+body+'\n```'
    artifact=tmp_path/'neutral.md';artifact.write_text('Anonymous raw material.\n')
    output=tmp_path/'review'
    code=review_one.main(['--model','claude/offline','--artifact',str(artifact),'--out-dir',str(output),'--claude-runner',str(runner(tmp_path,body,capture=True))])
    assert code==0
    agent=json.loads((output/'meta.json').read_text())['agents'][0]
    report=Path(agent['out']);budget=Path(agent['capture_receipt'])
    assert report.read_bytes()==body.encode('utf8')
    original_bytes={p.name:p.read_bytes() for p in budget.parent.iterdir() if p.is_file()}
    sidecar=Path(str(report)+'.runtime-observation.json');signed_bytes=sidecar.read_bytes()
    hashes=[hashlib.sha256((output/'inputs'/name).read_bytes()).hexdigest() for name in ('system.md','packet.md')]
    assert runtime.verify_capture_observation(budget,report,hashes)['valid'] is True
    assert agent['contract_ok'] is True and agent['verdict']=='VERDICT: READY'
    run_multi_task._postprocess_result(agent,check_review_contract=True)
    assert report.read_bytes()==body.encode('utf8') and sidecar.read_bytes()==signed_bytes
    assert {p.name:p.read_bytes() for p in budget.parent.iterdir() if p.is_file()}==original_bytes


def test_gemini_contract_and_home_redaction_are_derived_views(tmp_path):
    home=tmp_path/'isolated-home';home.mkdir()
    body='MCP issues detected. Run /mcp list for status.\nthought: examining raw packet\n'+json.dumps({'blocking_issues':[],'verdict':'PASS','summary':'Original path '+str(home)})
    artifact=tmp_path/'neutral.md';artifact.write_text('Anonymous raw material.\n')
    output=tmp_path/'review'
    old_argv=sys.argv
    try:
        sys.argv=['run_multi_task.py','--models','gemini/offline','--system',str(artifact),'--prompt',str(artifact),'--out-dir',str(output),'--gemini-runner',str(runner(tmp_path,body,capture=False)),'--gemini-cli-home',str(home),'--check-review-contract']
        assert run_multi_task.main()==0
    finally:sys.argv=old_argv
    agent=json.loads((output/'meta.json').read_text())['agents'][0]
    report=Path(agent['out']);assert report.read_bytes()==body.encode('utf8')
    hashes=[hashlib.sha256(artifact.read_bytes()).hexdigest()]*2
    assert runtime.verify_capture_observation(None,report,hashes)['valid'] is True
    redacted=Path(str(report)+'.redacted-view.txt').read_text()
    assert '[Gemini home]' in redacted and str(home) not in redacted
    assert agent['contract_ok'] is True and agent['verdict']=='VERDICT: READY'


@pytest.mark.parametrize('body',[
    '{"verdict":"PASS","blocking_issues":[],"summary":"no final newline"}',
    '\r\n\r\n```json\r\n{"verdict":"PASS","blocking_issues":[],"summary":"original CRLF"}\r\n```',
    'Original preamble\r\nVERDICT: READY\r\n\r\n'+''.join('## '+h+'\r\n- none\r\n\r\n' for h in ['Blockers','High-severity','Non-blocking','Real-research fit','Robustness & safety','Specific patch suggestions'])
])
def test_in_memory_contract_view_never_rewrites_original_line_endings(tmp_path,body):
    output=tmp_path/'original.txt';output.write_bytes(body.encode('utf8'))
    result={'out':str(output),'backend':'claude','success':True,'exit_code':0}
    run_multi_task._postprocess_result(result,check_review_contract=True)
    assert output.read_bytes()==body.encode('utf8')
    assert result['contract_ok'] is True and result['verdict']=='VERDICT: READY'


def test_invalid_original_contract_remains_invalid_without_byte_rewrite(tmp_path):
    body='```json\n{"verdict":"PASS","summary":"missing blockers"}\n```'
    output=tmp_path/'original.txt';output.write_bytes(body.encode())
    result={'out':str(output),'backend':'claude','success':True,'exit_code':0}
    run_multi_task._postprocess_result(result,check_review_contract=True)
    assert output.read_bytes()==body.encode() and result['contract_ok'] is False


def test_native_launcher_publishes_observed_capture_to_capacity_consumer(tmp_path, monkeypatch):
    sys.path.insert(0, str(BIN.parents[2] / 'research-team/scripts/lib'))
    from request_capacity import request_budgets, validate_request_capacity
    shell = BIN.parents[2] / 'kimi-cli-runner/scripts/run_kimi.sh'
    cli = tmp_path / 'kimi'
    body = 'Complete λ\u0085first\u2028second\u2029end.\n'
    records = [
        {'role': 'meta', 'type': 'system.version', 'version': '2.6.2'},
        {'role': 'assistant', 'content': body},
        {'role': 'meta', 'type': 'session.resume_hint', 'session_id': 'offline',
         'command': 'kimi -r offline', 'content': 'To resume this session: kimi -r offline'},
    ]
    raw = ''.join(json.dumps(r, ensure_ascii=False) + '\n' for r in records).encode()
    cli.write_text(f'#!{sys.executable}\nimport sys\nsys.stdout.buffer.write({raw!r})\n')
    cli.chmod(0o755)
    monkeypatch.setenv('KIMI_BIN', str(cli))
    system=tmp_path/'system.txt';system.write_text('Neutral system.')
    prompt=tmp_path/'prompt.txt';prompt.write_text('Neutral question.')
    output=tmp_path/'native-output'
    old_argv=sys.argv
    try:
        sys.argv=['run_multi_task.py','--models','kimi/offline','--system',str(system),'--prompt',str(prompt),'--out-dir',str(output),'--kimi-runner',str(shell),'--context-tokens','200000']
        assert run_multi_task.main()==0
    finally:
        sys.argv=old_argv
    meta=json.loads((output/'meta.json').read_text())
    agent=meta['agents'][0]
    assert agent['success'] is True
    assert Path(agent['out']).read_bytes() == body.encode()
    budget = Path(agent['capture_receipt'])
    assert (budget.parent / 'attempt_1.stdout').read_bytes() == raw
    capture = json.loads(budget.read_text())['runtime_observation']['payload']
    assert capture['backend'] == 'kimi'
    assert capture['capture']['complete_output']['cli_version'] == '2.6.2'
    budgets=request_budgets(200000,None)
    result=validate_request_capacity(system.read_text(),prompt.read_text(),
        {'exit_code':0,'output':agent['out']},budgets,expected_working_directory=Path.cwd())
    assert result['capacity_evidence']=='conservative_configured_bound'
    assert result['observed_usage']==[]
    assert result['compaction_witness']=='unavailable'
    assert result['usage_scope']=='unavailable'

    agent['backend'] = 'claude'
    (output / 'meta.json').write_text(json.dumps(meta))
    with pytest.raises(ValueError, match='runner backend mismatch'):
        validate_request_capacity(system.read_text(),prompt.read_text(),
            {'exit_code':0,'output':agent['out']},budgets)
