"""Actual checked-in JS script execution with injected host APIs, not a real Workflow platform."""
from pathlib import Path
import subprocess


def test_native_script_transport_protocol():
    script = Path(__file__).with_name('test_native_workflow_transport.mjs')
    proc = subprocess.run(['node', str(script)], capture_output=True, text=True, timeout=20)
    assert proc.returncode == 0, proc.stdout + proc.stderr
    assert '6 Native script host-protocol behavior cases passed' in proc.stdout

    assert '4 line-ending quote cases passed' in proc.stdout

    assert '2 original-claim failure-retention behavior cases passed' in proc.stdout

    assert '4 body-only scientific-axis and transport-only provenance cases passed' in proc.stdout
