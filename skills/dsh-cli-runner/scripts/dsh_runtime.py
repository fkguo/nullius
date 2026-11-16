"""Current desktop CLI discovery and explicit tool-free profile composition."""
from __future__ import annotations
import hashlib
import json
import os
import re
from pathlib import Path
import shutil
import subprocess
import time

# Only the infrastructure needed for a single text request remains active.
# Unknown/new profile rows are disabled, never implicitly admitted.
ALLOWED_IDS = frozenset('timer llm session session-title user-questions agent agent-default-model llm-retry llm-pi-ai session-persistence-jsonl attachment-local working-directory session-projection storage storage-json storage-domain session-projection-cache subprocess tools system-prompt agent-loop headless-startup headless-runner'.split())
REQUIRED_IDS = frozenset('agent-instructions skill-filesystem plan-mode settings authorization credentials deepseek-account llm-deepseek llm-deepseek-account session-title-llm llm-pi-ai agent-default-model session-persistence-jsonl system-prompt tools agent-loop headless-startup headless-runner'.split())

class RunError(Exception):
    pass

PROFILE_FIELDS = {
    "tools": {"mode"}, "system-prompt": {"includeHarnessIdentity", "includeRuntimeContext", "personaPrefix", "personaSuffix"},
    "llm-pi-ai": {"providers"}, "agent-default-model": {"provider", "model"},
    "session-persistence-jsonl": {"root", "compression"},
}
PLUGIN_NAMES = {"timer": "@deepseek-ai/cordis-plugin-timer", "subprocess": "@deepseek-ai/dsh-subprocess-local",
                "headless-startup": "@deepseek-ai/dsh-headless/startup", "headless-runner": "@deepseek-ai/dsh-headless"}


def incompatible(version, detail):
    # The first tested desktop build is used only to suggest the direction
    # of an update. Matching the version never grants admission.
    release = re.fullmatch(r"(\d+)\.(\d+)\.(\d+)(?:-rc\.(\d+))?(?:\+[a-zA-Z0-9.-]+)?", version)
    older = release and (tuple(map(int, release.groups()[:3])), int(release[4]) if release[4] else float('inf')) < ((0, 2, 1), 2)
    update = "update the DSH client" if older else "update Nullius for this DSH protocol"
    return RunError(f"DSH {version}: {detail}; {update}")


def alternatives(schema):
    if isinstance(schema, dict):
        yield schema
        branches = schema.get("anyOf")
        if isinstance(branches, list):
            for branch in branches:
                yield from alternatives(branch)


def profile_entries(schema, version):
    catalog = schema.get("x-cordis", {}) if isinstance(schema, dict) else {}
    entries = catalog.get("entries") if isinstance(catalog, dict) else None
    if not isinstance(entries, list) or catalog.get("complete") is not True or catalog.get("profile") != "headless":
        raise incompatible(version, "missing complete headless profile schema")
    ids = [item.get("id") if isinstance(item, dict) else None for item in entries]
    if any(not isinstance(i, str) or not i for i in ids) or len(set(ids)) != len(ids):
        raise incompatible(version, "malformed or repeated headless profile IDs")
    missing = (REQUIRED_IDS | ALLOWED_IDS) - set(ids)
    if missing:
        raise incompatible(version, "isolation contract missing profile row(s): " + ", ".join(sorted(missing)))
    definitions = schema.get("$defs")
    if not isinstance(definitions, dict):
        raise incompatible(version, "missing headless configuration schema definitions")
    mode = None
    for entry in entries:
        name = entry["id"]
        if name in ALLOWED_IDS and entry.get("name") != PLUGIN_NAMES.get(name, "@deepseek-ai/dsh-" + name):
            raise incompatible(version, f"unrecognized package for enabled row {name}")
        if name not in PROFILE_FIELDS:
            continue
        ref = entry.get("configRef", "")
        definition = definitions.get(ref[8:]) if isinstance(ref, str) and ref.startswith("#/$defs/") else None
        # Cordis exposes the object schema alongside its loader expression.
        properties = next((b["properties"] for b in alternatives(definition)
                           if isinstance(b.get("properties"), dict)), {})
        missing_fields = PROFILE_FIELDS[name] - properties.keys()
        if missing_fields:
            raise incompatible(version, f"missing headless configuration fields for {name}: " + ", ".join(sorted(missing_fields)))
        if name == "tools":
            mode = properties["mode"]
    if not isinstance(mode, dict):
        raise incompatible(version, "missing schema for tools.mode")
    if mode.get("default") == "native" and any(b.get("const") == "native" for b in alternatives(mode)):
        tools_profile = "native_mode"
    elif mode.get("anyOf") == [{"type": "null"}, {"$ref": "#/$defs/loaderExpression"}] and {
            "tool-executor-native", "tool-executor-ptc"} <= set(ids):
        implementation = next(e for e in entries if e["id"] == "tool-executor-native")
        if implementation.get("name") != "@deepseek-ai/dsh-tool-executor-native":
            raise incompatible(version, "unrecognized native executor package")
        tools_profile = "separate_executors"
    else:
        raise incompatible(version, "unknown tools.mode or tool executor isolation protocol")
    return entries, tools_profile


def hash_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open('rb') as stream:
        before = os.fstat(stream.fileno())
        if not path.is_file():
            raise RunError('runtime identity requires regular files')
        while chunk := stream.read(1024 * 1024):
            h.update(chunk)
        after = os.fstat(stream.fileno())
    if (before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns, before.st_ctime_ns) != (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns, after.st_ctime_ns):
        raise RunError('runtime changed while hashing')
    return h.hexdigest()

def check_runtime_identity(identity: dict) -> None:
    for item in identity['files']:
        if hash_file(Path(item['path'])) != item['sha256']:
            raise RunError('DSH runtime changed during the bounded call')

def runtime(entry: str | None, run: Path, env: dict, deadline: float) -> tuple[list[str], list[dict], dict]:
    binary = entry or shutil.which('dsh')
    if not binary:
        raise RunError('dsh not found; select the installed desktop dsh launcher with --cli-entry')
    launcher = Path(binary).expanduser().resolve(strict=True)
    if not os.access(launcher, os.X_OK) or len(launcher.parents) < 4:
        raise RunError('DSH launcher must be an installed executable')
    resources = launcher.parents[3]
    marker = 'ELECTRON_RUN_AS_NODE=1 exec "$resources/../MacOS/DeepSeek Harness" --expose-internals "$resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/cli.js" "$@"'
    if launcher.relative_to(resources).as_posix() != 'runtime/cli/bin/dsh' or marker not in launcher.read_text(encoding='utf-8'):
        raise RunError('unsupported DSH installation layout; this runner requires the current desktop launcher')
    files = [launcher, resources / 'app.asar', resources.parent / 'MacOS/DeepSeek Harness', resources / 'runtime/versions.json']
    identity = {'installation': 'desktop', 'entry': str(launcher),
                'files': [{'path': str(p), 'sha256': hash_file(p)} for p in files]}
    command = [str(launcher)]
    def probe(arguments: list[str], name: str) -> str:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            raise RunError('deadline exhausted during DSH runtime preflight')
        try:
            result = subprocess.run(command + arguments, cwd=run / 'workspace', env=env,
                                    capture_output=True, timeout=remaining)
        except subprocess.TimeoutExpired as exc:
            raise RunError('deadline exhausted during DSH runtime preflight') from exc
        (run / f'{name}.stderr').write_bytes(result.stderr)
        if result.returncode or len(result.stdout) > 8_000_000:
            raise RunError('DSH runtime metadata probe failed; inspect retained probe diagnostics')
        (run / f'{name}.txt').write_bytes(result.stdout)
        return result.stdout.decode('utf-8')
    version = probe(['--version'], 'runtime-version').strip()
    if not re.fullmatch(r"[0-9]+\.[0-9]+\.[0-9]+(?:[-+][a-zA-Z0-9.+-]+)?", version):
        raise incompatible(repr(version)[:100], "unrecognized client version output")
    identity['version'] = version
    try:
        schema_text = probe(['--profile', 'headless', '--dump-config-schema'], 'runtime-schema')
        schema = json.loads(schema_text)
    except (ValueError, RunError) as exc:
        raise incompatible(version, f"cannot read headless --dump-config-schema ({exc})") from exc
    entries, tools_profile = profile_entries(schema, version)
    identity["tool_profile"] = tools_profile
    identity['profile_schema_sha256'] = hashlib.sha256(schema_text.encode()).hexdigest()
    return command, entries, identity

def overlay(entries: list[dict], run: Path, profile: dict, provider: str, model: str, persona: str, tools_profile: str) -> list[dict]:
    enabled = ALLOWED_IDS | ({'tool-executor-native'} if tools_profile == 'separate_executors' else set())
    rows = [{'id': item['id'], 'disabled': item['id'] not in enabled} for item in entries]
    if tools_profile == 'native_mode':
        rows.append({'id': 'tools', 'config': {'mode': 'native'}})
    rows += [
        {'id': 'system-prompt', 'config': {'personaPrefix': persona, 'personaSuffix': '', 'includeHarnessIdentity': False, 'includeRuntimeContext': False}},
        {'id': 'llm-pi-ai', 'config': {'providers': {provider: profile}}},
        {'id': 'agent-default-model', 'config': {'provider': provider, 'model': model}},
        {'id': 'session-persistence-jsonl', 'config': {'root': str(run / 'home/sessions'), 'compression': 'none'}},
    ]
    return rows
