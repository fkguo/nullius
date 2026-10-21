"""Observed exact-byte inputs for the workflow literature checker."""
from __future__ import annotations

import hashlib
import json
import os
import stat
from pathlib import Path


class EvidenceMissing(Exception):
    pass


class EvidenceInvalid(Exception):
    pass


def identity(info: os.stat_result) -> tuple[int, ...]:
    return (info.st_dev, info.st_ino, info.st_mode, info.st_size,
            info.st_mtime_ns, info.st_ctime_ns, info.st_nlink)


class ObservedProjectReads:
    """No symlink traversal, stable opened inode, repeated-byte and final checks."""
    def __init__(self, root: Path):
        if not root.is_absolute() or root != root.resolve():
            raise EvidenceInvalid('project_root must be an absolute canonical directory')
        self.root = root
        self.observed: dict[str, tuple[str, tuple[int, ...]]] = {}

    def relative(self, path: Path | str) -> str:
        path = Path(path)
        if path.is_absolute():
            try:
                path = path.relative_to(self.root)
            except ValueError as exc:
                raise EvidenceInvalid('evidence escapes project root') from exc
        text = path.as_posix()
        if text in {'', '.'} or '\\' in text or any(p in {'', '.', '..'} for p in text.split('/')):
            raise EvidenceInvalid(f'noncanonical evidence path: {text}')
        return text

    def read(self, path: Path | str) -> bytes:
        rel = self.relative(path)
        fds: list[int] = []
        try:
            current = os.open(self.root, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
            fds.append(current)
            parts = rel.split('/')
            for part in parts[:-1]:
                current = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=current)
                fds.append(current)
            file_fd = os.open(parts[-1], os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=current)
            fds.append(file_fd)
            before = os.fstat(file_fd)
            if not stat.S_ISREG(before.st_mode) or before.st_nlink != 1:
                raise EvidenceInvalid(f'evidence must be an unaliased regular file: {rel}')
            chunks = []
            while chunk := os.read(file_fd, 1024 * 1024):
                chunks.append(chunk)
            after = os.fstat(file_fd)
            if identity(before) != identity(after):
                raise EvidenceInvalid(f'evidence changed during read: {rel}')
            payload = b''.join(chunks)
            digest = hashlib.sha256(payload).hexdigest()
            observed = (digest, identity(after))
            if rel in self.observed and self.observed[rel] != observed:
                raise EvidenceInvalid(f'evidence changed between reads: {rel}')
            self.observed[rel] = observed
            return payload
        except FileNotFoundError as exc:
            raise EvidenceMissing(f'missing evidence file: {rel}') from exc
        except OSError as exc:
            raise EvidenceInvalid(f'cannot safely bind evidence {rel}: {exc}') from exc
        finally:
            for fd in reversed(fds):
                os.close(fd)

    def finish(self) -> list[dict[str, str]]:
        for rel in list(self.observed):
            self.read(rel)
        return [{'path': rel, 'sha256': digest} for rel, (digest, _) in sorted(self.observed.items())]


class ObservedNote:
    """The existing note validator reads the exact bytes already observed."""
    def __init__(self, path: str, payload: bytes):
        self.path = path
        self.payload = payload

    def read_text(self, **kwargs: object) -> str:
        return self.payload.decode('utf-8', errors='strict')

    def __str__(self) -> str:
        return self.path


def require_matching_candidate_pool(payload: bytes, ledger: object) -> None:
    """Compare the candidate archive and inline disposition records by exact IDs.

    JSON object member order and candidate order carry no meaning; every field
    and value must agree. Both arrays and newline-delimited objects are accepted.
    """
    def unique_object(pairs: list[tuple[str, object]]) -> dict:
        result = {}
        for key, value in pairs:
            if key in result:
                raise EvidenceInvalid(f'candidate archive contains duplicate JSON member: {key}')
            result[key] = value
        return result

    def non_json_constant(value: str) -> None:
        raise EvidenceInvalid(f'candidate archive contains non-JSON constant: {value}')

    def decode(text: str) -> object:
        return json.loads(text, object_pairs_hook=unique_object, parse_constant=non_json_constant)

    try:
        text = payload.decode('utf-8')
        try:
            parsed = decode(text)
            archived = parsed if isinstance(parsed, list) else [parsed]
        except json.JSONDecodeError:
            archived = [decode(line) for line in text.splitlines() if line.strip()]
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise EvidenceInvalid(f'candidate pool artifact must contain JSON candidate array or JSONL objects: {exc}') from exc

    def indexed(records: object, label: str) -> dict[str, str]:
        if not isinstance(records, list) or not records:
            raise EvidenceInvalid(f'{label} must contain non-empty candidate objects')
        result: dict[str, str] = {}
        for record in records:
            if not isinstance(record, dict) or not isinstance(record.get('id'), str) or not record['id']:
                raise EvidenceInvalid(f'{label} entries must be candidate objects with id')
            if record['id'] in result:
                raise EvidenceInvalid(f'{label} contains duplicate candidate id: {record["id"]}')
            try:
                result[record['id']] = json.dumps(record, sort_keys=True, separators=(',', ':'), allow_nan=False)
            except (ValueError, TypeError) as exc:
                raise EvidenceInvalid(f'{label} contains a non-JSON candidate value') from exc
        return result

    if indexed(archived, 'candidate pool artifact') != indexed(ledger, 'inline candidate disposition ledger'):
        raise EvidenceInvalid('candidate pool artifact must match inline candidate disposition ledger exactly')
