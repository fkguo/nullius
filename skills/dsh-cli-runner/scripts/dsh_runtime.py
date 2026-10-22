"""Current desktop CLI discovery and explicit tool-free profile composition."""
from __future__ import annotations
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import time

SUPPORTED_VERSION = '0.2.1-rc.2'
# Only the infrastructure needed for a single text request remains active.
# Unknown/new profile rows are disabled, never implicitly admitted.
ALLOWED_IDS = frozenset('timer llm session session-title user-questions agent agent-default-model llm-retry llm-pi-ai session-persistence-jsonl attachment-local working-directory session-projection storage storage-json storage-domain session-projection-cache subprocess tools system-prompt agent-loop headless-startup headless-runner'.split())
REQUIRED_IDS = frozenset('agent-instructions skill-filesystem plan-mode settings authorization credentials deepseek-account llm-deepseek llm-deepseek-account session-title-llm llm-pi-ai agent-default-model session-persistence-jsonl system-prompt tools agent-loop headless-startup headless-runner'.split())

class RunError(Exception):
    pass

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
    identity = {'version': SUPPORTED_VERSION, 'installation': 'desktop', 'entry': str(launcher),
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
    if version != SUPPORTED_VERSION:
        raise RunError(f'unsupported DSH runtime version; expected {SUPPORTED_VERSION}')
    schema_text = probe(['--profile', 'headless', '--dump-config-schema'], 'runtime-schema')
    schema = json.loads(schema_text)
    catalog = schema.get('x-cordis', {})
    entries = catalog.get('entries')
    if catalog.get('complete') is not True or catalog.get('profile') != 'headless' or not isinstance(entries, list):
        raise RunError('DSH profile schema is incomplete or not headless')
    ids = [item.get('id') for item in entries if isinstance(item, dict)]
    if len(ids) != len(entries) or any(not isinstance(i, str) or not i for i in ids) or len(set(ids)) != len(ids) or not REQUIRED_IDS <= set(ids):
        raise RunError('DSH profile rows do not match the supported isolation contract')
    identity['profile_schema_sha256'] = hashlib.sha256(schema_text.encode()).hexdigest()
    return command, entries, identity

def overlay(entries: list[dict], run: Path, profile: dict, provider: str, model: str, persona: str) -> list[dict]:
    rows = [{'id': item['id'], 'disabled': item['id'] not in ALLOWED_IDS} for item in entries]
    rows += [
        {'id': 'tools', 'config': {'mode': 'native'}},
        {'id': 'system-prompt', 'config': {'personaPrefix': persona, 'personaSuffix': '', 'includeHarnessIdentity': False, 'includeRuntimeContext': False}},
        {'id': 'llm-pi-ai', 'config': {'providers': {provider: profile}}},
        {'id': 'agent-default-model', 'config': {'provider': provider, 'model': model}},
        {'id': 'session-persistence-jsonl', 'config': {'root': str(run / 'home/sessions'), 'compression': 'none'}},
    ]
    return rows
