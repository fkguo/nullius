"""Repository-test bridge to the shared marked-reference reader, not package runtime."""
import json
from pathlib import Path
import subprocess


def read_instruction_documents(entry, root=None):
    # One parser owns the convention used by both Python and Node contract locks.
    # Only repository tests import this helper; installed skills do not need Node.
    module = Path(__file__).with_name('instruction-documents.mjs').resolve().as_uri()
    program = (
        'import { readInstructionDocuments } from ' + json.dumps(module) + ';'
        'process.stdout.write(readInstructionDocuments(process.argv[1],'
        'process.argv[2] ? {root:process.argv[2]} : {}));'
    )
    arguments = ['node', '--input-type=module', '-e', program, str(Path(entry).absolute())]
    if root is not None:
        arguments.append(str(Path(root).absolute()))
    result = subprocess.run(arguments, capture_output=True, text=True, encoding='utf-8')
    if result.returncode:
        raise ValueError('instruction reference resolution failed: ' + result.stderr.strip())
    return result.stdout
