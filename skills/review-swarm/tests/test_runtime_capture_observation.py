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


def observed(tmp_path, capture=True, exit_code=0, context_tokens=None, backend="claude"):
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
    process=run_multi_task._run_with_timeout(cmd,timeout_secs=10,context_tokens=context_tokens,backend=backend)
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
    request={'budget_path':str(budget),'report_path':str(output),'input_sha256':hashes,'expected_working_directory':str(Path.cwd()),'expected_backend':'claude'}
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


def native_records(hint=True, text="Original complete report λ\n"):
    records = [{"role": "meta", "type": "system.version", "version": "2.6.0"},
               {"role": "assistant", "content": text}]
    if hint:
        records.append({"role": "meta", "type": "session.resume_hint", "session_id": "neutral-session",
                        "command": "continue neutral-session", "content": "Resume the session."})
    return records


def observed_native(tmp_path, *, records=None, raw=None, report=None, exit_code=0,
                    budget_changes=None, mutate_input=False, extra_files=None, backend="kimi"):
    """Fresh actual subprocess bytes; these fixtures never call a model or import saved captures."""
    project = tmp_path / "project"; project.mkdir()
    system = project / "system"; system.write_bytes(b"Neutral system\r\n")
    prompt = project / "prompt"; prompt.write_text("Original neutral request λ\n")
    output = project / "report"
    root = Path(str(output) + ".attempts") / "run.fresh"
    hashes = [hashlib.sha256(p.read_bytes()).hexdigest() for p in (system, prompt)]
    records = native_records() if records is None else records
    raw = ("".join(json.dumps(r, ensure_ascii=False) + "\n" for r in records).encode()
           if raw is None else raw)
    report = records[1]["content"].rstrip() + "\n" if report is None else report
    budget = {"status": "completed", "runner_exit_code": 0, "input_sha256": hashes,
              "attempts": [{"index": 1, "status": "exited", "exit_code": 0,
                            "stdout": "attempt_1.stdout", "stderr": "attempt_1.stderr"}]}
    budget.update(budget_changes or {})
    files = {"budget.json": json.dumps(budget).encode(), "attempt_1.stdout": raw,
             "attempt_1.stderr": b"Original diagnostic bytes\r\n"}
    files.update(extra_files or {})
    script = project / "runner.py"
    code = 'from pathlib import Path\nimport sys\n'
    code += f'root=Path({str(root)!r});root.mkdir(parents=True)\n'
    for name, data in files.items():
        code += f'(root/{name!r}).write_bytes({data!r})\n'
    code += f'Path({str(output)!r}).write_bytes({report.encode()!r})\n'
    if mutate_input:
        code += f'Path({str(prompt)!r}).write_text("Changed original request")\n'
    code += f'sys.exit({exit_code})\n'
    script.write_text(code)
    cmd = [sys.executable, str(script), "--system-prompt-file", str(system),
           "--prompt-file", str(prompt), "--out", str(output)]
    process = run_multi_task._run_with_timeout(cmd, timeout_secs=10, context_tokens=50000, backend=backend)
    return output, root / "budget.json", hashes, process, cmd, files


@pytest.mark.parametrize("hint", [True, False])
def test_native_prompt_observes_original_process_and_complete_raw_identity(tmp_path, hint):
    text = "Earlier original reasoning.\r\nUnicode separators:\u0085\u2028\u2029Complete final report λ\n\n  "
    output, budget, hashes, process, _, originals = observed_native(
        tmp_path, records=native_records(hint, text))
    assert process["exit_code"] == 0
    verified = runtime.verify_capture_observation(budget, output, hashes, str(Path.cwd()), 50000)
    complete = verified["complete_output"]
    assert complete["protocol"] == "kimi_prompt_stream_json"
    assert complete["completion_authority"] == "observed_process_exit_zero"
    assert complete["provider_terminal_event"] is False
    assert complete["text_policy"] == "rstrip_then_final_newline"
    assert complete["assistant_text_sha256"] == hashlib.sha256(text.encode()).hexdigest()
    assert output.read_bytes() == (text.rstrip() + "\n").encode()
    capture = json.loads(budget.read_text())["runtime_observation"]["payload"]["capture"]
    assert set(capture["files"]) == {"attempt_1.stdout", "attempt_1.stderr"}
    assert not list(budget.parent.glob("*.events.*"))
    for name in capture["files"]:
        assert (budget.parent / name).read_bytes() == originals[name]
        assert capture["files"][name] == {"sha256": hashlib.sha256(originals[name]).hexdigest(),
                                           "size_bytes": len(originals[name])}


@pytest.mark.parametrize("change", ["stdout", "stderr", "budget", "extra", "report", "request", "hmac"])
def test_native_prompt_mutations_never_verify(tmp_path, change):
    output, budget, hashes, _, _, _ = observed_native(tmp_path)
    if change in ("stdout", "stderr"):
        path = budget.parent / ("attempt_1." + change)
        path.write_bytes(path.read_bytes() + b"changed\n")
    elif change == "budget":
        record = json.loads(budget.read_text()); record["attempts"][0]["elapsed_secs"] = 1
        budget.write_text(json.dumps(record))
    elif change == "extra":
        (budget.parent / "attempt_2.stdout").write_text("additional original bytes\n")
    elif change == "report":
        output.write_text("replacement report\n")
    elif change == "request":
        hashes = ["0" * 64, "1" * 64]
    elif change == "hmac":
        sidecar = Path(str(output) + ".runtime-observation.json")
        record = json.loads(sidecar.read_text()); record["hmac_sha256"] = "0" * 64
        sidecar.write_text(json.dumps(record))
    with pytest.raises((ValueError, OSError)):
        runtime.verify_capture_observation(budget, output, hashes)


@pytest.mark.parametrize("invalid", ["truncated", "missing_newline", "malformed", "duplicate_key", "invalid_utf8",
    "error", "tool", "tool_call", "array", "unknown_role", "unknown_meta", "unknown_version", "extra_assistant",
    "extra_field", "empty", "missing_header", "bad_hint", "nonfinite", "report_mismatch", "extra_file",
    "nonzero_inner", "unknown_receipt", "wrong_input", "input_mutation"])
def test_native_prompt_rejects_incomplete_unknown_and_unbound_shapes(tmp_path, invalid):
    records = native_records(); kwargs = {}; raw = None
    if invalid == "truncated": raw = b'{"role":"assistant","content":"unfinished'
    elif invalid == "missing_newline": raw = "\n".join(map(json.dumps, records)).encode()
    elif invalid == "malformed": raw = b'not JSON\n'
    elif invalid == "duplicate_key": raw = (json.dumps(records[0]) + '\n{"role":"assistant","content":"old","content":"Original complete report λ\\n"}\n').encode()
    elif invalid == "invalid_utf8": raw = b'\xff\n'
    elif invalid == "error": records.append({"role": "error", "content": "failed"})
    elif invalid == "tool": records.insert(2, {"role": "tool", "tool_call_id": "pending", "content": "unresolved"})
    elif invalid == "tool_call": records[1]["tool_calls"] = [{"id": "pending"}]
    elif invalid == "array": records[1]["content"] = [{"type": "text", "text": "unsupported"}]
    elif invalid == "unknown_role": records[1]["role"] = "unrecognized"
    elif invalid == "unknown_meta": records[2]["type"] = "session.unknown"
    elif invalid == "unknown_version": records[0]["version"] = "unrecognized"
    elif invalid == "extra_assistant": records.insert(2, {"role": "assistant", "content": "extra"})
    elif invalid == "extra_field": records[1]["unknown"] = "cannot be silently omitted"
    elif invalid == "empty": records[1]["content"] = "  "
    elif invalid == "missing_header": records = records[1:]
    elif invalid == "bad_hint": records[2]["content"] = {}
    elif invalid == "nonfinite": records[1]["unknown"] = float("nan")
    elif invalid == "report_mismatch": kwargs["report"] = "different report\n"
    elif invalid == "extra_file": kwargs["extra_files"] = {"unknown.txt": b"unobserved?"}
    elif invalid == "nonzero_inner": kwargs["budget_changes"] = {"attempts": [{"status": "exited", "exit_code": 9}]}
    elif invalid == "unknown_receipt": kwargs["budget_changes"] = {"runner_exit_code": 0, "attempts": [{"status": "exited", "exit_code": 0}]}
    elif invalid == "wrong_input": kwargs["budget_changes"] = {"input_sha256": ["0" * 64, "1" * 64]}
    elif invalid == "input_mutation": kwargs["mutate_input"] = True
    # Keep the report neutral even when the deliberately invalid assistant has no string content.
    kwargs.setdefault("report", "Original complete report λ\n")
    with pytest.raises((ValueError, OSError)):
        observed_native(tmp_path, records=records, raw=raw, **kwargs)
    assert not (tmp_path / "project/report.runtime-observation.json").exists()


def test_native_nonzero_process_cannot_issue_successful_capture(tmp_path):
    output, budget, hashes, process, _, _ = observed_native(tmp_path, exit_code=9)
    assert process["exit_code"] == 9
    assert not Path(str(output) + ".runtime-observation.json").exists()
    with pytest.raises(ValueError, match="runtime observation missing"):
        runtime.verify_capture_observation(budget, output, hashes)


def test_native_saved_capture_cannot_be_reobserved_by_successful_noop(tmp_path):
    output, budget, hashes, _, cmd, _ = observed_native(tmp_path)
    sidecar = Path(str(output) + ".runtime-observation.json"); sidecar.unlink()
    assert runtime._prepare(cmd) is None
    assert runtime._finish(None, object()) is None
    with pytest.raises(ValueError, match="runtime observation missing"):
        runtime.verify_capture_observation(budget, output, hashes)


def test_native_raw_files_cannot_be_relabelled_as_claude_events(tmp_path):
    output, budget, hashes, _, _, _ = observed_native(tmp_path)
    (budget.parent / "attempt_1.stdout").rename(budget.parent / "attempt_1.events.jsonl")
    with pytest.raises((ValueError, OSError)):
        runtime.verify_capture_observation(budget, output, hashes)

@pytest.mark.parametrize("backend", ["claude", "opencode", None])
def test_other_runner_cannot_issue_native_prompt_receipt(tmp_path, backend):
    with pytest.raises(ValueError, match="does not match the invoked runner"):
        observed_native(tmp_path, backend=backend)
    assert not (tmp_path / "project/report.runtime-observation.json").exists()


def test_kimi_runner_cannot_issue_claude_event_receipt(tmp_path):
    with pytest.raises(ValueError, match="does not match the invoked runner"):
        observed(tmp_path, backend="kimi")
    assert not (tmp_path / "project/report.txt.runtime-observation.json").exists()


def test_mixed_capture_rejected_before_signing(tmp_path):
    with pytest.raises(ValueError, match="mixed original capture formats"):
        observed_native(tmp_path, extra_files={"attempt_1.events.jsonl": b"{}\\n"})
    assert not (tmp_path / "project/report.runtime-observation.json").exists()

@pytest.mark.parametrize("version", ["2.6.0", "2.6.1", "2.6.17"])
def test_compatible_patch_records_its_actual_version(tmp_path, version):
    records = native_records()
    records[0]["version"] = version
    output, budget, hashes, _, _, _ = observed_native(tmp_path, records=records)
    observation = runtime.verify_capture_observation(budget, output, hashes, expected_backend="kimi")
    assert observation["complete_output"]["cli_version"] == version


@pytest.mark.parametrize("version", ["2.5.9", "2.7.0", "2.6.10-beta.1"])
def test_unknown_cli_series_names_observed_version_and_reader_update(tmp_path, version):
    records = native_records()
    records[0]["version"] = version
    with pytest.raises(ValueError) as failure:
        observed_native(tmp_path, records=records)
    assert version in str(failure.value) and "update Nullius" in str(failure.value)
    assert not (tmp_path / "project/report.runtime-observation.json").exists()


def test_new_patch_still_rejects_new_record_fields(tmp_path):
    records = native_records()
    records[0]["version"] = "2.6.17"
    records[1]["unrecognized"] = "additional original material"
    with pytest.raises(ValueError, match="Kimi Code 2.6.17: update Nullius"):
        observed_native(tmp_path, records=records)
