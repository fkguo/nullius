"""Host-runtime observations of newly completed captures, never project attestations.

Trust boundary: the local runtime, owner account and its private authority key.
This authenticates observed transport bytes, not model truth or provider identity.
There is deliberately no signing CLI, caller key, environment override or migration
that signs old captures. Verification reads the fixed native host authority only.
"""
from __future__ import annotations

import hashlib
import fcntl
import hmac
import json
import os
import pwd
import secrets
import stat
import subprocess
import sys
import uuid
from datetime import datetime, timezone
from pathlib import Path

_LIVE: dict[int, tuple[object, subprocess.Popen]] = {}
from complete_assistant_text import validate_stream_report

_DOMAIN = b"nullius-runtime-capture-observation\x00"
_MEMBER_DOMAIN = b"nullius-runtime-member-episode\x00"
_MEMBER_EPISODES: dict[int, dict] = {}


def _member_state(token: object) -> dict:
    state = _MEMBER_EPISODES.get(id(token))
    if state is None or state["token"] is not token or state["pid"] != os.getpid():
        raise ValueError("unavailable: no live member producer episode")
    return state


def _begin_member_episode(project_root: Path, member_id: str, original_inputs: list[Path]) -> object:
    """Private producer-only capability; no serialized state can create it."""
    entry = Path(__file__).resolve().parents[3] / "research-team/scripts/bin/run_member_review.py"
    main_file = getattr(sys.modules.get("__main__"), "__file__", "")
    if not main_file or Path(main_file).resolve() != entry.resolve():
        raise ValueError("unavailable: member observation requires actual producer entry")
    token = object()
    state = {"token": token, "pid": os.getpid(), "root": project_root.resolve(),
             "member_id": member_id, "working_directory": str(Path.cwd().resolve()),
             "files": {}, "operations": [], "models": {}, "pending": {},
             "producer": _identity(entry)}
    _MEMBER_EPISODES[id(token)] = state
    _member_files(token, "original_inputs", original_inputs)
    return token


def _member_files(token: object, operation: str, paths: list[Path], detail: dict | None = None) -> None:
    state = _member_state(token)
    identities = {}
    for path in paths:
        path = path.resolve()
        identity = _identity(path)
        previous = state["files"].get(str(path))
        if previous is not None and previous != identity:
            raise ValueError("unavailable: observed member material changed during episode")
        state["files"][str(path)] = identity
        identities[str(path)] = identity
    state["operations"].append({"operation": operation, "files": identities, "detail": detail or {}})


def _member_prepare_process(token: object, kind: str, cmd: list[str], inputs: list[Path], output: Path | None = None, cwd: Path | None = None) -> object:
    state = _member_state(token)
    pending = object()
    _member_files(token, kind + ".inputs", inputs)
    if output is not None and output.exists():
        raise ValueError("unavailable: preseeded member model output")
    state["pending"][id(pending)] = {"token": pending, "kind": kind, "argv": list(cmd),
        "inputs": {str(p.resolve()): _identity(p) for p in inputs}, "output": output,
        "cwd": str((cwd or Path.cwd()).resolve()), "proc": None}
    return pending


def _member_bind_process(token: object, pending: object, proc: subprocess.Popen) -> None:
    state = _member_state(token)
    record = state["pending"].get(id(pending))
    if record is None or record["token"] is not pending or not isinstance(proc, subprocess.Popen) or proc.pid <= 0:
        raise ValueError("unavailable: no actual member subprocess")
    record["proc"] = proc


def _member_finish_process(token: object, pending: object, proc: subprocess.Popen, raw_output: bytes | None = None) -> None:
    state = _member_state(token)
    record = state["pending"].pop(id(pending), None)
    if record is None or record["token"] is not pending or record["proc"] is not proc or proc.returncode is None or proc.poll() != proc.returncode:
        raise ValueError("unavailable: unobserved member subprocess completion")
    if any(_identity(Path(path)) != identity for path, identity in record["inputs"].items()):
        raise ValueError("unavailable: actual member invocation inputs changed")
    observed = {"kind": record["kind"], "argv": record["argv"], "cwd": record["cwd"],
                "process_id": proc.pid, "exit_code": proc.returncode, "inputs": record["inputs"]}
    output = record["output"]
    if output is not None and proc.returncode == 0:
        if not output.is_file() or not output.read_bytes().strip():
            raise ValueError("unavailable: missing actual member model output")
        material = [output]
        capture = Path(str(output) + ".attempts")
        if capture.is_dir():
            material.extend(p for p in capture.rglob("*") if p.is_file())
        _member_files(token, record["kind"] + ".output", material)
        observed["output"] = {"path": str(output.resolve()), **_identity(output)}
    if raw_output is not None:
        observed["raw_output"] = {"sha256": hashlib.sha256(raw_output).hexdigest(), "size_bytes": len(raw_output)}
    state["operations"].append(observed)
    if record["kind"] in ("requests", "final"):
        if record["kind"] in state["models"]:
            raise ValueError("unavailable: duplicate model stage in member episode")
        state["models"][record["kind"]] = observed


def _member_evidence_body(evidence: dict) -> dict:
    body = json.loads(_canonical(evidence))
    transport = body.get("original_transport")
    if isinstance(transport, dict):
        transport.pop("runtime_observation", None)
    return body


def _finish_member_episode(token: object, evidence: dict, observation_path: Path, closure_paths: list[Path]) -> dict:
    state = _member_state(token)
    if evidence.get("original_transport", {}).get("pending_operations"):
        raise ValueError("unavailable: incomplete member proxy requests")
    if state["pending"] or set(state["models"]) != {"requests", "final"} or any(model["exit_code"] != 0 for model in state["models"].values()):
        raise ValueError("unavailable: member episode lacks two actual successful model stages")
    _member_files(token, "complete_evidence_closure", closure_paths)
    if any(_identity(Path(path)) != identity for path, identity in state["files"].items()):
        raise ValueError("unavailable: original member material changed before publication")
    observation_path = observation_path.resolve()
    if not observation_path.is_relative_to(state["root"]) or observation_path.exists():
        raise ValueError("unavailable: member observation destination is not fresh project storage")
    # Temporary workspaces are removed after a successful team cycle. Preserve
    # every observed byte before sealing, including actual runner inputs and
    # captured events; an output list alone does not contain that full closure.
    snapshot_dir = observation_path.with_suffix(".originals")
    snapshot_dir.mkdir(mode=0o700, exist_ok=False)
    snapshots = {}
    for index, (original, identity) in enumerate(sorted(state["files"].items())):
        data = Path(original).read_bytes()
        if {"sha256": hashlib.sha256(data).hexdigest(), "size_bytes": len(data)} != identity:
            raise ValueError("unavailable: member material changed while freezing originals")
        snapshot = snapshot_dir / f"file-{index:06d}"
        with snapshot.open("xb") as stream:
            stream.write(data)
        snapshots[original] = {"path": snapshot.relative_to(state["root"]).as_posix(), **identity}
    payload = {"kind": "runtime_member_episode", "episode_id": str(uuid.uuid4()),
        "issued_at": datetime.now(timezone.utc).isoformat(), "producer": state["producer"],
        "producer_pid": state["pid"], "project_root": str(state["root"]), "member_id": state["member_id"],
        "working_directory": state["working_directory"], "models": state["models"],
        "operations": state["operations"], "files": state["files"], "original_snapshots": snapshots,
        "evidence_sha256": hashlib.sha256(_canonical(_member_evidence_body(evidence))).hexdigest()}
    signature = hmac.new(_key(create=True), _MEMBER_DOMAIN + _canonical(payload), hashlib.sha256).hexdigest()
    with observation_path.open("x", encoding="utf-8") as stream:
        stream.write(json.dumps({"payload": payload, "hmac_sha256": signature}, sort_keys=True, indent=2) + "\n")
    _MEMBER_EPISODES.pop(id(token), None)
    return _identity(observation_path)


def verify_member_episode(evidence: dict, project_root: Path) -> dict:
    root = project_root.resolve()
    reference = evidence.get("original_transport", {}).get("runtime_observation")
    if not isinstance(reference, dict) or not isinstance(reference.get("path"), str):
        raise ValueError("unavailable: absent runtime member episode observation")
    path = (root / reference["path"]).resolve()
    if not path.is_relative_to(root) or path.relative_to(root).as_posix() != reference["path"] or _identity(path) != {key: reference.get(key) for key in ("sha256", "size_bytes")}:
        raise ValueError("unavailable: stale runtime member episode observation")
    observation = json.loads(path.read_text(encoding="utf-8"));payload = observation.get("payload")
    if not isinstance(payload, dict) or not isinstance(observation.get("hmac_sha256"), str):
        raise ValueError("unavailable: invalid runtime member episode observation")
    expected = hmac.new(_key(create=False), _MEMBER_DOMAIN + _canonical(payload), hashlib.sha256).hexdigest()
    if not hmac.compare_digest(expected, observation["hmac_sha256"]):
        raise ValueError("unavailable: forged runtime member episode observation")
    if payload.get("kind") != "runtime_member_episode" or payload.get("project_root") != str(root) or payload.get("member_id") != evidence.get("member_id"):
        raise ValueError("unavailable: foreign runtime member episode observation")
    if payload.get("evidence_sha256") != hashlib.sha256(_canonical(_member_evidence_body(evidence))).hexdigest():
        raise ValueError("unavailable: rehashed member evidence differs from actual producer episode")
    files, snapshots = payload.get("files"), payload.get("original_snapshots")
    if not isinstance(files, dict) or not files or not isinstance(snapshots, dict) or set(snapshots) != set(files):
        raise ValueError("unavailable: runtime member episode lacks the complete durable original closure")
    snapshot_dir = path.with_suffix(".originals")
    for original, identity in files.items():
        snapshot = snapshots[original]
        if not isinstance(snapshot, dict) or {key: snapshot.get(key) for key in ("sha256", "size_bytes")} != identity:
            raise ValueError("unavailable: member original snapshot identity mismatch")
        relative = snapshot.get("path")
        if not isinstance(relative, str):
            raise ValueError("unavailable: member original snapshot locator missing")
        frozen = (root / relative).resolve()
        if not frozen.is_relative_to(snapshot_dir) or frozen.relative_to(root).as_posix() != relative or _identity(frozen) != identity:
            raise ValueError("unavailable: member original material differs from runtime observation")
    return {"valid": True, "episode_id": payload["episode_id"]}


def _authority_dir() -> Path:
    home = Path(pwd.getpwuid(os.getuid()).pw_dir)
    base = home / "Library/Application Support" if sys.platform == "darwin" else home / ".local/state"
    return base / "nullius/capture-observation"


def _key(*, create: bool) -> bytes:
    directory = _authority_dir()
    if create:
        directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    ds = directory.lstat()
    if not stat.S_ISDIR(ds.st_mode) or ds.st_uid != os.getuid() or ds.st_mode & 0o077:
        raise ValueError("unavailable: unsafe host observation authority directory")
    path = directory / "authority.key"
    # Creation and reads serialize on a lock file beside the key, so a concurrent first use never
    # reads a key that another creator has opened but not yet completely written.
    lock_fd = os.open(directory / "authority.lock", os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    try:
        fcntl.flock(lock_fd, fcntl.LOCK_EX if create else fcntl.LOCK_SH)
        if create:
            try:
                fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
            except FileExistsError:
                pass
            else:
                with os.fdopen(fd, "wb") as stream:
                    stream.write(secrets.token_bytes(32)); stream.flush(); os.fsync(stream.fileno())
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
        with os.fdopen(fd, "rb") as stream:
            fs = os.fstat(stream.fileno())
            if not stat.S_ISREG(fs.st_mode) or fs.st_uid != os.getuid() or fs.st_mode & 0o077 or fs.st_nlink != 1:
                raise ValueError("unavailable: unsafe host observation authority key")
            key = stream.read()
    finally:
        os.close(lock_fd)
    if len(key) != 32:
        raise ValueError("unavailable: invalid host observation authority key")
    return key


def _canonical(value: object) -> bytes:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False, allow_nan=False).encode("utf-8")


def _identity(path: Path) -> dict:
    data = path.read_bytes()
    return {"sha256": hashlib.sha256(data).hexdigest(), "size_bytes": len(data)}


def _flag(cmd: list[str], name: str) -> Path:
    if cmd.count(name) != 1:
        raise ValueError("not an original runner request")
    return Path(cmd[cmd.index(name) + 1]).resolve()


def _validate_context_tokens(value: int | None) -> None:
    if value is not None and (type(value) is not int or value <= 0 or value > 2**53 - 1):
        raise ValueError("unavailable: capacity policy context_tokens must be a positive safe integer")


def _prepare(cmd: list[str], *, context_tokens: int | None = None) -> dict | None:
    """Before Popen, freeze request bytes, caller policy and prior captures."""
    _validate_context_tokens(context_tokens)
    try:
        system, prompt, output = (_flag(cmd, name) for name in ("--system-prompt-file", "--prompt-file", "--out"))
        inputs = {"system": _identity(system), "prompt": _identity(prompt)}
        # A successful no-op must not certify an author's preseeded report.
        # Fresh invocation directories are the current contract; an empty
        # failed-attempt output may still receive the existing empty retry.
        if output.is_file() and output.read_bytes().strip():
            return None
        return {"nonce": object(), "cmd": list(cmd), "inputs": inputs,
                "capacity_policy": {"context_tokens": context_tokens} if context_tokens is not None else None,
                "input_paths": [system, prompt], "output": output,
                "working_directory": str(Path.cwd().resolve()),
                "prior": set(Path(str(output) + ".attempts").glob("run.*")),
                "runner": _identity(Path(cmd[1]).resolve())}
    except (ValueError, OSError, IndexError):
        return None


def _bind(state: dict | None, proc: subprocess.Popen) -> None:
    if state is not None and isinstance(proc, subprocess.Popen) and proc.pid > 0:
        _LIVE[id(state)] = (state["nonce"], proc)


def _capture_files(root: Path) -> dict:
    files = sorted({*root.glob("*.events.jsonl"), *root.glob("*.events.result.json")})
    if not files or not any(p.name.endswith(".events.jsonl") for p in files) or not any(p.name.endswith(".events.result.json") for p in files):
        raise ValueError("unavailable: incomplete original captured events/result")
    return {p.name: _identity(p) for p in files}


def _successful_budget(budget: dict, hashes: list[str]) -> None:
    attempts = budget.get("attempts")
    if (budget.get("status") != "completed" or type(budget.get("runner_exit_code")) is not int
            or budget["runner_exit_code"] != 0 or sorted(budget.get("input_sha256", [])) != sorted(hashes)
            or not isinstance(attempts, list) or not attempts
            or not any(isinstance(a, dict) and a.get("status") == "exited" and type(a.get("exit_code")) is int and a["exit_code"] == 0 for a in attempts)):
        raise ValueError("unavailable: capture is not the successful complete original request")


def _unchanged_original_request(state: dict) -> None:
    if [_identity(p) for p in state["input_paths"]] != list(state["inputs"].values()):
        raise ValueError("unavailable: original request changed during invocation")


def _finish(state: dict | None, proc: subprocess.Popen) -> dict | None:
    """Called only after the actual bound process has been reaped successfully."""
    if state is None:
        return None
    actual = _LIVE.pop(id(state), None)
    if actual is None or actual[0] is not state["nonce"] or actual[1] is not proc:
        raise ValueError("unavailable: no live runtime-owned subprocess observation")
    if proc.returncode != 0 or proc.poll() != 0:
        return None
    hashes = [entry["sha256"] for entry in state["inputs"].values()]
    _unchanged_original_request(state)
    current = set(Path(str(state["output"]) + ".attempts").glob("run.*")) - state["prior"]
    report = state["output"].read_bytes().decode("utf-8")
    if not report.strip():
        return None
    if len(current) > 1:
        raise ValueError("unavailable: ambiguous current capture observation")
    capture = None
    receipt = None
    if current:
        root = next(iter(current)).resolve()
        receipt = root / "budget.json"
        budget = json.loads(receipt.read_text(encoding="utf-8"))
        if "runtime_observation" in budget:
            raise ValueError("unavailable: capture already contains an authored observation")
        _successful_budget(budget, hashes)
        files = _capture_files(root)
        complete_output = validate_stream_report(root, report)
        capture = {"budget_relative": str(receipt.relative_to(state["output"].parent)),
                   "budget_sha256": hashlib.sha256(_canonical(budget)).hexdigest(), "files": files,
                   "complete_output": complete_output}
    payload = {"kind": "runtime_capture_observation", "observation_id": str(uuid.uuid4()),
               "issued_at": datetime.now(timezone.utc).isoformat(), "process_id": proc.pid,
               "process_exit_code": proc.returncode, "request": state["inputs"],
               "capacity_policy": state["capacity_policy"],
               "working_directory": state["working_directory"],
               "runner": state["runner"], "command_sha256": hashlib.sha256(_canonical(state["cmd"])).hexdigest(),
               "capture": capture, "report_path": str(state["output"].resolve()), "report": _identity(state["output"])}
    signature = hmac.new(_key(create=True), _DOMAIN + _canonical(payload), hashlib.sha256).hexdigest()
    observation = {"payload": payload, "hmac_sha256": signature}
    # Never replace a previous invocation's authority. Current callers allocate
    # fresh immutable invocation directories; retries of empty output do not sign.
    sidecar = Path(str(state["output"]) + ".runtime-observation.json")
    with sidecar.open("x", encoding="utf-8") as stream:
        stream.write(json.dumps(observation, indent=2, sort_keys=True) + "\n")
    if receipt is not None:
        budget["runtime_observation"] = observation
        temp = receipt.with_name("budget.observed." + uuid.uuid4().hex + ".tmp")
        temp.write_text(json.dumps(budget, indent=2, sort_keys=True) + "\n", encoding="utf-8")
        temp.replace(receipt)
    return payload


def _discard(state: dict | None) -> None:
    if state is not None:
        _LIVE.pop(id(state), None)


def verify_capture_observation(budget_path: Path | None, report_path: Path, input_sha256: list[str], expected_working_directory: str | None = None, expected_context_tokens: int | None = None) -> dict:
    _validate_context_tokens(expected_context_tokens)
    if not isinstance(input_sha256, list) or len(input_sha256) != 2 or any(not isinstance(h, str) or len(h) != 64 or any(c not in "0123456789abcdef" for c in h) for h in input_sha256):
        raise ValueError("unavailable: invalid complete original request hashes")
    sidecar = Path(str(report_path) + ".runtime-observation.json")
    try:
        observation = json.loads(sidecar.read_text(encoding="utf-8"))
    except FileNotFoundError:
        raise ValueError(f"unavailable: runtime observation missing: {sidecar}") from None
    if not isinstance(observation, dict) or not isinstance(observation.get("payload"), dict) or not isinstance(observation.get("hmac_sha256"), str):
        raise ValueError("unavailable: absent runtime capture observation")
    payload = observation["payload"]
    expected = hmac.new(_key(create=False), _DOMAIN + _canonical(payload), hashlib.sha256).hexdigest()
    if not hmac.compare_digest(expected, observation["hmac_sha256"]):
        raise ValueError("unavailable: forged runtime capture observation")
    if payload.get("kind") != "runtime_capture_observation" or type(payload.get("process_exit_code")) is not int or payload["process_exit_code"] != 0:
        raise ValueError("unavailable: unsuccessful runtime capture observation")
    policy = payload.get("capacity_policy")
    if policy is not None:
        if not isinstance(policy, dict) or set(policy) != {"context_tokens"}:
            raise ValueError("unavailable: invalid runtime capacity policy")
        _validate_context_tokens(policy["context_tokens"])
        if policy["context_tokens"] is None:
            raise ValueError("unavailable: invalid runtime capacity policy")
    if expected_context_tokens is not None and policy != {"context_tokens": expected_context_tokens}:
        raise ValueError("unavailable: runtime observation capacity policy absent or mismatched")
    signed_hashes = sorted(v["sha256"] for v in payload["request"].values())
    if not isinstance(input_sha256, list) or len(input_sha256) != 2 or sorted(input_sha256) != signed_hashes:
        raise ValueError("unavailable: runtime observation request mismatch")
    if expected_working_directory is not None and str(Path(expected_working_directory).resolve()) != payload.get("working_directory"):
        raise ValueError("unavailable: runtime observation working directory mismatch")
    if payload.get("report_path") != str(report_path.resolve()):
        raise ValueError("unavailable: foreign runtime observation report locator")
    if _identity(report_path) != payload["report"]:
        raise ValueError("unavailable: runtime observation captured/report bytes mismatch")
    capture = payload.get("capture")
    if capture is None:
        if budget_path is not None:
            raise ValueError("unavailable: runtime observation did not observe this capture")
    else:
        expected_path = (report_path.parent / capture["budget_relative"]).resolve()
        if budget_path is None or budget_path.resolve() != expected_path:
            raise ValueError("unavailable: runtime observation capture locator mismatch")
        budget = json.loads(budget_path.read_text(encoding="utf-8"))
        if budget.get("runtime_observation") != observation:
            raise ValueError("unavailable: runtime observation capture receipt mismatch")
        _successful_budget(budget, input_sha256)
        unsigned = {key: value for key, value in budget.items() if key != "runtime_observation"}
        if hashlib.sha256(_canonical(unsigned)).hexdigest() != capture["budget_sha256"]:
            raise ValueError("unavailable: runtime observation budget mismatch")
        if _capture_files(budget_path.parent) != capture["files"]:
            raise ValueError("unavailable: runtime observation captured/report bytes mismatch")
        if "complete_output" in capture:
            if validate_stream_report(budget_path.parent, report_path.read_bytes().decode("utf-8")) != capture["complete_output"]:
                raise ValueError("unavailable: original complete-output binding mismatch")
    return {"valid": True, "capacity_policy": policy, "observation_id": payload["observation_id"], "request": payload["request"], "report": payload["report"], "working_directory": payload["working_directory"], "complete_output": capture.get("complete_output") if capture else None}
