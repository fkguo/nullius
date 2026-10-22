#!/usr/bin/env python3
"""Bind an authored task brief to selected file bytes; this is not content review."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import stat
import sys
import tempfile

PREFIX = b'<!-- nullius-task-brief\n'
END = b'\n-->\n\n'
FORMAT = 'nullius-task-brief'


class Invalid(ValueError):
    pass


class Stale(ValueError):
    pass


def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def unique_object(pairs):
    obj = {}
    for key, value in pairs:
        if key in obj:
            raise Invalid('duplicate metadata key: ' + key)
        obj[key] = value
    return obj


def relative(value: str) -> str:
    if not isinstance(value, str) or not value or '\\' in value or '\0' in value:
        raise Invalid('expected a project-relative path')
    if any(part in ('', '.', '..') for part in value.split('/')) or Path(value).is_absolute():
        raise Invalid('path must be relative without empty, dot or parent components')
    return value


def safe_file(root: Path, value: str) -> Path:
    relative(value)
    path = root
    for component in value.split('/'):
        path = path / component
        info = path.lstat()
        if stat.S_ISLNK(info.st_mode):
            raise Invalid('symlink paths are not allowed: ' + value)
    if not stat.S_ISREG(info.st_mode):
        raise Invalid('expected a regular file: ' + value)
    return path


def file_identity(info):
    return info.st_dev, info.st_ino


def signature(info):
    return (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns, info.st_mode)


def snapshot(root: Path, value: str):
    path = safe_file(root, value)
    before = path.stat()
    data = path.read_bytes()
    after = safe_file(root, value).stat()
    if signature(before) != signature(after) or len(data) != after.st_size:
        raise Stale('file changed while reading: ' + value)
    return data, after


def hash_string(value):
    return isinstance(value, str) and len(value) == 64 and all(c in '0123456789abcdef' for c in value)


def unpack(data: bytes):
    try:
        data.decode('utf-8')
    except UnicodeDecodeError as exc:
        raise Invalid('brief must be UTF-8') from exc
    if not data.startswith(b'<!-- nullius-task-brief'):
        if PREFIX in data:
            raise Invalid('reserved task-brief metadata prefix in authored body')
        return None, data
    if not data.startswith(PREFIX) or END not in data[len(PREFIX):]:
        raise Invalid('malformed task-brief metadata')
    raw, body = data[len(PREFIX):].split(END, 1)
    if PREFIX in body:
        raise Invalid('duplicate task-brief metadata comment')
    try:
        meta = json.loads(raw, object_pairs_hook=unique_object)
    except (ValueError, UnicodeDecodeError) as exc:
        raise Invalid('malformed task-brief metadata: ' + str(exc)) from exc
    if not isinstance(meta, dict) or set(meta) != {'format', 'format_version', 'body_sha256', 'sources'}:
        raise Invalid('unexpected task-brief metadata fields')
    if meta['format'] != FORMAT or type(meta['format_version']) is not int or meta['format_version'] != 1:
        raise Invalid('unsupported task-brief format/version')
    if not hash_string(meta['body_sha256']) or not isinstance(meta['sources'], list) or not meta['sources']:
        raise Invalid('invalid body hash or sources')
    seen = set()
    for source in meta['sources']:
        if not isinstance(source, dict) or set(source) != {'path', 'sha256', 'bytes'}:
            raise Invalid('invalid source metadata fields')
        path = relative(source['path'])
        if path in seen or not hash_string(source['sha256']) or type(source['bytes']) is not int or source['bytes'] < 0:
            raise Invalid('invalid or duplicate source record')
        seen.add(path)
    return meta, body


def run(args):
    root = Path(args.project_root)
    if not root.is_absolute() or not root.is_dir():
        raise Invalid('project root must be an existing absolute directory')
    root = root.resolve()
    brief = relative(args.brief)
    parts = brief.split('/')
    if len(parts) < 4 or parts[:2] != ['artifacts', 'runs'] or not brief.endswith('.md'):
        raise Invalid('brief must be Markdown under artifacts/runs/<run-id>/')
    original, original_stat = snapshot(root, brief)
    meta, body = unpack(original)
    if not body.decode('utf-8').strip():
        raise Invalid('brief body must be authored and nonblank')
    if args.command == 'check':
        if meta is None:
            raise Invalid('brief has no capture metadata')
        if any(item['path'] == brief for item in meta['sources']):
            raise Invalid('brief cannot be its own source')
        changes = []
        if digest(body) != meta['body_sha256']:
            changes.append({'path': brief, 'reason': 'body_changed'})
        seen_files = set()
        for source in meta['sources']:
            try:
                data, source_stat = snapshot(root, source['path'])
            except FileNotFoundError:
                changes.append({'path': source['path'], 'reason': 'missing'})
                continue
            identity = file_identity(source_stat)
            if identity == file_identity(original_stat) or identity in seen_files:
                raise Invalid('sources must be distinct files and cannot alias the brief')
            seen_files.add(identity)
            if len(data) != source['bytes'] or digest(data) != source['sha256']:
                changes.append({'path': source['path'], 'reason': 'source_changed'})
        return ({'status': 'stale' if changes else 'fresh', 'brief': brief, 'sources': len(meta['sources']), 'changes': changes}, 1 if changes else 0)
    paths = [relative(value) for value in args.source]
    if len(set(paths)) != len(paths) or brief in paths:
        raise Invalid('sources must be distinct and cannot include the brief')
    sources, snapshots = [], []
    seen_files = set()
    for path in paths:
        data, info = snapshot(root, path)
        identity = file_identity(info)
        if identity == file_identity(original_stat) or identity in seen_files:
            raise Invalid('sources must be distinct files and cannot alias the brief')
        seen_files.add(identity)
        sources.append({'path': path, 'sha256': digest(data), 'bytes': len(data)})
        snapshots.append((path, info))
    meta = {'format': FORMAT, 'format_version': 1, 'body_sha256': digest(body), 'sources': sources}
    payload = PREFIX + json.dumps(meta, indent=2, ensure_ascii=False).encode('utf-8') + END + body
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(prefix='.task-brief-', dir=(root / brief).parent, delete=False) as stream:
            temporary = stream.name
            os.fchmod(stream.fileno(), stat.S_IMODE(original_stat.st_mode))
            stream.write(payload)
            stream.flush()
            os.fsync(stream.fileno())
        for path, info in [(brief, original_stat), *snapshots]:
            if signature(safe_file(root, path).stat()) != signature(info):
                raise Stale('file changed before capture: ' + path)
        os.replace(temporary, root / brief)
        temporary = None
    finally:
        if temporary is not None:
            os.unlink(temporary)
    return {'status': 'captured', 'brief': brief, 'sources': len(sources)}, 0


class Parser(argparse.ArgumentParser):
    def error(self, message):
        raise Invalid(message)


def main(argv=None):
    try:
        parser = Parser(description=__doc__)
        commands = parser.add_subparsers(dest='command', required=True, parser_class=Parser)
        for command in ('capture', 'check'):
            sub = commands.add_parser(command)
            sub.add_argument('--project-root', required=True, help='existing absolute project root (from that directory: pwd -P)')
            sub.add_argument('--brief', required=True, help='project-relative Markdown path under artifacts/runs/<run-id>/')
            if command == 'capture':
                sub.add_argument('--source', action='append', required=True, help='selected project-relative source file; repeat for each file')
        result, code = run(parser.parse_args(argv))
    except Stale as exc:
        result, code = {'status': 'stale', 'error': str(exc)}, 1
    except (Invalid, OSError) as exc:
        result, code = {'status': 'invalid', 'error': str(exc)}, 2
    print(json.dumps(result, ensure_ascii=False))
    return code


if __name__ == '__main__':
    sys.exit(main())
