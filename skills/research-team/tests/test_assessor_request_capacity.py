"""Original-input capacity counterexamples, not scientific-semantic reviews."""
import importlib.util
import json
import hashlib
import sys
from pathlib import Path

import pytest

SOURCE = Path(__file__).resolve().parents[1] / "scripts/lib/request_capacity.py"
spec = importlib.util.spec_from_file_location("source_request_capacity", SOURCE)
capacity = importlib.util.module_from_spec(spec)
spec.loader.exec_module(capacity)
import runtime_capture_observation as runtime
import run_multi_task


@pytest.fixture(autouse=True)
def host_authority(tmp_path, monkeypatch):
    monkeypatch.setattr(runtime, "_authority_dir", lambda: tmp_path / "host-authority")


def observation(tmp_path, usage=None, compact=False, *, system="neutral", prompt="small original", context_tokens=200000):
    from uuid import uuid4
    run = tmp_path / uuid4().hex
    run.mkdir()
    output = run / "actual_output.txt"
    capture = Path(str(output) + ".attempts") / "run.current"
    system_path, prompt_path = run / "system.md", run / "prompt.md"
    system_path.write_text(system); prompt_path.write_text(prompt)
    receipt = capture / "budget.json"
    budget = {"status":"completed", "runner_exit_code":0,
        "input_sha256":[hashlib.sha256(x.encode()).hexdigest() for x in (system,prompt)],
        "attempts":[{"status":"exited", "exit_code":0}]}
    event = {"type": "result", "subtype": "success", "is_error": False, "usage": usage or {}, "result": "original model result"}
    # A compacted capture still ends in its terminal result event: the result
    # sidecar is reconstructed from the stream and must agree with it.
    stream = (json.dumps({"type": "system", "subtype": "compact_boundary"}) + "\n" if compact else "") + json.dumps(event) + "\n"
    script = run / "observed_fixture_runner.py"
    script.write_text('from pathlib import Path\nimport json\n'
        + f'capture=Path({str(capture)!r});capture.mkdir(parents=True)\n'
        + f'Path({str(output)!r}).write_text("original model result")\n'
        + f'(capture/"budget.json").write_text({json.dumps(budget)!r})\n'
        + f'(capture/"attempt_1.events.result.json").write_text({json.dumps(event)!r})\n'
        + f'(capture/"attempt_1.events.jsonl").write_text({stream!r})\n')
    process = run_multi_task._run_with_timeout([sys.executable,str(script),'--system-prompt-file',str(system_path),'--prompt-file',str(prompt_path),'--out',str(output)],timeout_secs=10, context_tokens=context_tokens)
    assert process['exit_code'] == 0
    (run / "meta.json").write_text(json.dumps({"agents": [{"success": True, "out": str(output), "capture_receipt": str(receipt)}]}))
    return {"exit_code": 0, "output": str(output)}


def test_complete_original_request_is_refused_without_sufficient_byte_budget(tmp_path):
    original = "Original reasoning and raw inputs.\n" * 10000
    with pytest.raises(ValueError, match="complete original request"):
        capacity.validate_request_capacity("neutral source examiner", original, observation(tmp_path), capacity.request_budgets())


def test_large_explicit_request_needs_actual_usage_not_author_sizing(tmp_path):
    original = "完整原文和输入\n" * 10000
    budgets = capacity.request_budgets(200000, 500000)
    with pytest.raises(ValueError, match="no observed token"):
        capacity.validate_request_capacity("neutral", original, observation(tmp_path, prompt=original), budgets)
    actual = observation(tmp_path, {"input_tokens": 62000, "cache_read_input_tokens": 32000, "output_tokens": 3000}, prompt=original)
    result = capacity.validate_request_capacity("neutral", original, actual, budgets)
    assert result["capacity_evidence"] == "observed_usage"


@pytest.mark.parametrize("usage", [{"input_tokens": 198000, "output_tokens": 3000},
                                     {"input_tokens": 10, "cache_creation_input_tokens": 199000, "output_tokens": 2000}])
def test_actual_input_output_or_cache_usage_over_window_cannot_accept(tmp_path, usage):
    with pytest.raises(ValueError, match="exceeds configured token"):
        capacity.validate_request_capacity("neutral", "small original", observation(tmp_path, usage), capacity.request_budgets())


def test_compaction_rejects_even_a_small_successful_request(tmp_path):
    with pytest.raises(ValueError, match="observably compacted"):
        capacity.validate_request_capacity("neutral", "small original", observation(tmp_path, compact=True), capacity.request_budgets())


def test_actual_observation_binds_the_execution_working_directory(tmp_path):
    actual = observation(tmp_path)
    capacity.validate_request_capacity("neutral", "small original", actual, capacity.request_budgets(), expected_working_directory=Path.cwd())
    foreign = tmp_path / "different-project"
    foreign.mkdir()
    with pytest.raises(ValueError, match="working directory"):
        capacity.validate_request_capacity("neutral", "small original", actual, capacity.request_budgets(), expected_working_directory=foreign)


@pytest.mark.parametrize("original_window", [None, 50000])
def test_missing_or_relabelled_signed_window_cannot_admit_old_request(tmp_path, original_window):
    actual = observation(tmp_path, context_tokens=original_window)
    signed = Path(actual["output"] + ".runtime-observation.json").read_bytes()
    with pytest.raises(ValueError, match="capacity policy"):
        capacity.validate_request_capacity("neutral", "small original", actual, capacity.request_budgets(3000000))
    assert Path(actual["output"] + ".runtime-observation.json").read_bytes() == signed


def test_failed_invocation_and_string_usage_do_not_supply_capacity(tmp_path):
    actual = observation(tmp_path, {"input_tokens": "2", "output_tokens": 2})
    actual["exit_code"] = 1
    with pytest.raises(ValueError, match="did not complete"):
        capacity.validate_request_capacity("neutral", "raw inputs", actual, capacity.request_budgets())


def test_unrelated_old_capture_cannot_supply_new_large_request_capacity(tmp_path):
    actual = observation(tmp_path, prompt="original evidence\n" * 13000)
    (tmp_path / "old.events.result.json").write_text(json.dumps({"type": "result", "is_error": False,
        "usage": {"input_tokens": 100, "output_tokens": 30}, "result": "original model result"}))
    with pytest.raises(ValueError, match="no observed token"):
        capacity.validate_request_capacity("neutral", "original evidence\n" * 13000, actual, capacity.request_budgets(200000, 500000))


@pytest.mark.parametrize("corruption", ["failed", "foreign", "duplicate-input"])
def test_result_text_and_usage_cannot_replace_successful_exact_request_receipt(tmp_path, corruption):
    original = 'neutral raw original.\n' * 4000
    actual = observation(tmp_path, {'input_tokens':1,'output_tokens':1}, prompt=original, context_tokens=50000)
    receipt = Path(json.loads((Path(actual['output']).parent/'meta.json').read_text())['agents'][0]['capture_receipt'])
    record = json.loads(receipt.read_text())
    if corruption == 'failed':
        record.update(status='failed',runner_exit_code=9,attempts=[{'status':'exited','exit_code':9}])
    elif corruption == 'foreign':
        record['input_sha256'] = ['0' * 64]
    else:
        record['input_sha256'] *= 2
    receipt.write_text(json.dumps(record))
    with pytest.raises(ValueError,match='exact successful original request'):
        capacity.validate_request_capacity('neutral',original,actual,capacity.request_budgets(50000,120000))
