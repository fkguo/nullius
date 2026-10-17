"""Actual Popen protocol observations; offline stubs do not certify model semantics."""
import hashlib
import json
import shutil
import sys
from pathlib import Path

import pytest

BIN = Path(__file__).resolve().parents[1] / "scripts/bin"
sys.path.insert(0, str(BIN))
import runtime_capture_observation as runtime
import run_multi_task
_NATIVE_AUTHORITY_DIR = runtime._authority_dir


@pytest.fixture(autouse=True)
def authority(tmp_path, monkeypatch):
    monkeypatch.setattr(runtime, "_authority_dir", lambda: tmp_path / "native-host/authority")


def observed(tmp_path, capture=True, exit_code=0, context_tokens=None):
    project = tmp_path / "project"; project.mkdir()
    system = project / "system.md"; system.write_bytes(b"neutral original system\r\n")
    prompt = project / "prompt.md"; prompt.write_text("Complete original request λ\n")
    output = project / "report.txt"
    hashes = [hashlib.sha256(p.read_bytes()).hexdigest() for p in (system,prompt)]
    root = Path(str(output) + ".attempts") / "run.new"
    receipt = root / "budget.json"
    budget = {"status":"completed", "runner_exit_code":0, "input_sha256":hashes,
              "attempts":[{"status":"exited","exit_code":0}], "complete_budget_field":"original"}
    result = {"type":"result","subtype":"success","is_error":False,"result":"Original full report λ\n", "usage":{"input_tokens":17,"output_tokens":4}}
    script = project / "runner.py"
    code = 'from pathlib import Path\nimport sys\n'
    code += f'Path({str(output)!r}).write_text({result["result"]!r})\n'
    if capture:
        code += f'root=Path({str(root)!r});root.mkdir(parents=True)\n'
        code += f'(root/"budget.json").write_text({json.dumps(budget)!r})\n'
        code += f'(root/"attempt_1.events.result.json").write_text({json.dumps(result)!r})\n'
        code += f'(root/"attempt_1.events.jsonl").write_text({(json.dumps(result)+chr(10))!r})\n'
    code += f'sys.exit({exit_code})\n'; script.write_text(code)
    cmd = [sys.executable,str(script),'--system-prompt-file',str(system),'--prompt-file',str(prompt),'--out',str(output)]
    process=run_multi_task._run_with_timeout(cmd,timeout_secs=10,context_tokens=context_tokens)
    return output, receipt if capture else None, hashes, process, cmd


def test_actual_process_issues_full_request_capture_and_report_observation(tmp_path):
    output,budget,hashes,process,_=observed(tmp_path)
    assert process['exit_code']==0
    result=runtime.verify_capture_observation(budget,output,hashes,str(Path.cwd()))
    assert result['valid'] is True
    assert (runtime._authority_dir()/'authority.key').stat().st_mode & 0o077 == 0
    assert runtime._authority_dir().stat().st_mode & 0o077 == 0


@pytest.mark.parametrize('change',['budget','report','events','result','extra','hmac','request','cwd','skip_capture'])
def test_serialized_rehash_cannot_replace_runtime_observation(tmp_path,change):
    output,budget,hashes,_,_=observed(tmp_path)
    expected_cwd=None
    if change=='budget':
        record=json.loads(budget.read_text());record['complete_budget_field']='changed';budget.write_text(json.dumps(record))
    elif change=='report':output.write_text('Author replacement report')
    elif change in ('events','result'):
        file=budget.parent/('attempt_1.events.jsonl' if change=='events' else 'attempt_1.events.result.json');file.write_text('{}\n')
    elif change=='extra':(budget.parent/'extra.events.result.json').write_text('{}')
    elif change=='hmac':
        sidecar=Path(str(output)+'.runtime-observation.json');record=json.loads(sidecar.read_text());record['payload']['report']['sha256']=hashlib.sha256(output.read_bytes()).hexdigest();record['hmac_sha256']='0'*64;sidecar.write_text(json.dumps(record))
    elif change=='request':hashes=['0'*64,'1'*64]
    elif change=='cwd':expected_cwd=str(tmp_path)
    elif change=='skip_capture':budget=None
    with pytest.raises((ValueError,OSError)):
        runtime.verify_capture_observation(budget,output,hashes,expected_cwd)


def test_conservative_no_capture_still_requires_actual_process_origin(tmp_path):
    output,budget,hashes,_,_=observed(tmp_path,capture=False)
    assert runtime.verify_capture_observation(None,output,hashes)['valid']
    Path(str(output)+'.runtime-observation.json').unlink()
    with pytest.raises(ValueError,match='unavailable: runtime observation missing'):runtime.verify_capture_observation(None,output,hashes)


def test_failed_process_does_not_issue_even_if_serialized_receipt_says_success(tmp_path):
    output,budget,hashes,process,_=observed(tmp_path,exit_code=9)
    assert process['exit_code']==9
    assert not Path(str(output)+'.runtime-observation.json').exists()
    with pytest.raises(ValueError,match='unavailable: runtime observation missing'):runtime.verify_capture_observation(budget,output,hashes)


def test_preexisting_capture_is_not_retroactively_signed_and_guard_rejects_json(tmp_path):
    output,budget,hashes,_,cmd=observed(tmp_path)
    sidecar=Path(str(output)+'.runtime-observation.json');sidecar.unlink()
    state=runtime._prepare(cmd)
    assert state is None  # A preseeded nonempty report cannot enter issuance.
    assert runtime._finish(state,object()) is None
    with pytest.raises(ValueError,match='no live runtime-owned'):
        runtime._finish({'nonce':object()},object())
    assert 'runtime_observation' in json.loads(budget.read_text())
    assert not sidecar.exists()


def test_copied_signed_capture_cannot_mint_a_foreign_output_invocation(tmp_path):
    output,budget,hashes,_,_=observed(tmp_path)
    archive=tmp_path/'archive';shutil.copytree(output.parent,archive)
    archived_output=archive/output.name; archived_budget=archive/budget.relative_to(output.parent)
    assert runtime.verify_capture_observation(budget,output,hashes,str(Path.cwd()))['valid']
    with pytest.raises(ValueError,match='foreign.*report locator'):
        runtime.verify_capture_observation(archived_budget,archived_output,hashes,str(Path.cwd()))
    with pytest.raises(ValueError,match='working directory'):
        runtime.verify_capture_observation(archived_budget,archived_output,hashes,str(archive))


def test_actual_verification_cli_uses_fixed_native_authority(tmp_path,monkeypatch):
    import subprocess
    monkeypatch.setattr(runtime,'_authority_dir',_NATIVE_AUTHORITY_DIR)
    output,budget,hashes,_,_=observed(tmp_path)
    request={'budget_path':str(budget),'report_path':str(output),'input_sha256':hashes,'expected_working_directory':str(Path.cwd())}
    result=subprocess.run([sys.executable,str(BIN/'verify_capture_observation.py')],input=json.dumps(request),capture_output=True,text=True,timeout=10)
    assert result.returncode==0 and json.loads(result.stdout)['valid'] is True
    output.write_bytes(output.read_bytes()+b'\nchanged original bytes\n')
    result=subprocess.run([sys.executable,str(BIN/'verify_capture_observation.py')],input=json.dumps(request),capture_output=True,text=True,timeout=10)
    assert result.returncode==1 and json.loads(result.stdout)['valid'] is False


def test_preseeded_nonempty_report_cannot_be_signed_by_successful_noop(tmp_path):
    import subprocess
    system=tmp_path/'system';system.write_text('neutral')
    prompt=tmp_path/'prompt';prompt.write_text('raw original')
    output=tmp_path/'report';output.write_text('Author preseeded answer')
    runner=tmp_path/'runner.py';runner.write_text('pass\n')
    cmd=[sys.executable,str(runner),'--system-prompt-file',str(system),'--prompt-file',str(prompt),'--out',str(output)]
    assert run_multi_task._run_with_timeout(cmd,timeout_secs=10)['exit_code']==0
    assert not Path(str(output)+'.runtime-observation.json').exists()


def test_owner_only_authority_permission_failure_is_closed(tmp_path):
    runtime._authority_dir().mkdir(parents=True,mode=0o700)
    runtime._authority_dir().chmod(0o777)
    with pytest.raises(ValueError,match='unsafe host'):
        runtime._key(create=True)


def test_original_capacity_policy_cannot_be_relabelled(tmp_path):
    output,budget,hashes,_,_=observed(tmp_path,context_tokens=50000)
    sidecar=Path(str(output)+'.runtime-observation.json')
    original=sidecar.read_bytes()
    result=runtime.verify_capture_observation(budget,output,hashes,expected_context_tokens=50000)
    assert result['capacity_policy']=={'context_tokens':50000}
    with pytest.raises(ValueError,match='capacity policy'):
        runtime.verify_capture_observation(budget,output,hashes,expected_context_tokens=3000000)
    assert sidecar.read_bytes()==original
    record=json.loads(original);record['payload']['capacity_policy']['context_tokens']=3000000
    sidecar.write_text(json.dumps(record))
    with pytest.raises(ValueError,match='forged'):
        runtime.verify_capture_observation(budget,output,hashes,expected_context_tokens=3000000)


def test_unsigned_capacity_cannot_support_notebook_claim(tmp_path):
    output,budget,hashes,_,_=observed(tmp_path)
    assert runtime.verify_capture_observation(budget,output,hashes)['capacity_policy'] is None
    with pytest.raises(ValueError,match='capacity policy'):
        runtime.verify_capture_observation(budget,output,hashes,expected_context_tokens=50000)


@pytest.mark.parametrize('invalid',[True,False,0,-1,50000.0,'50000',2**53])
def test_invalid_capacity_is_refused_before_popen(monkeypatch,invalid):
    calls=[]
    monkeypatch.setattr(run_multi_task.subprocess,'Popen',lambda *a,**k:calls.append(a))
    with pytest.raises(ValueError,match='capacity policy'):
        run_multi_task._run_with_timeout([],timeout_secs=1,context_tokens=invalid)
    assert calls==[]


def test_concurrent_first_use_of_the_authority_key_never_reads_a_partial_key(monkeypatch):
    # Many comparator requests may start at once on a host that has no key yet. Without serialized
    # creation a reader can open the key after another creator's exclusive open but before its write,
    # read zero bytes and refuse; every concurrent first use must instead return the same complete key.
    import os
    import threading
    from concurrent.futures import ThreadPoolExecutor
    real_open, gate = os.open, threading.Barrier(8)
    def slow_open(path, flags, *args):
        fd = real_open(path, flags, *args)
        if str(path).endswith("authority.key") and flags & os.O_EXCL:
            threading.Event().wait(0.05)  # widen the window between exclusive create and write
        return fd
    monkeypatch.setattr(runtime.os, "open", slow_open)
    def first_use(_):
        gate.wait()
        return runtime._key(create=True)
    with ThreadPoolExecutor(max_workers=8) as pool:
        keys = list(pool.map(first_use, range(8)))
    assert len(set(keys)) == 1 and len(keys[0]) == 32


def test_an_empty_key_left_by_a_crashed_creator_is_replaced_by_a_complete_key():
    # A creator killed after creating the key name but before writing left zero bytes, which signed nothing.
    directory = runtime._authority_dir(); directory.mkdir(mode=0o700, parents=True)
    (directory / "authority.key").touch(mode=0o600)
    key = runtime._key(create=True)
    assert len(key) == 32 and runtime._key(create=False) == key
    assert sorted(p.name for p in directory.iterdir()) == ["authority.key", "authority.lock"]
