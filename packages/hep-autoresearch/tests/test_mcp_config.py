import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


def _src_root() -> Path:
    return Path(__file__).resolve().parents[1] / "src"


def _run_py(code: str, *argv: str) -> tuple[int, str, str]:
    env = dict(os.environ)
    src = str(_src_root())
    prev = env.get("PYTHONPATH", "").strip()
    env["PYTHONPATH"] = src + (os.pathsep + prev if prev else "")
    cp = subprocess.run(
        [sys.executable, "-c", code, *argv],
        env=env,
        capture_output=True,
        text=True,
        check=False,
    )
    return int(cp.returncode), str(cp.stdout), str(cp.stderr)


_LOAD_CFG_SNIPPET = (
    "import sys\n"
    "from pathlib import Path\n"
    "from hep_autoresearch.toolkit.mcp_config import load_mcp_server_config\n"
    "p = Path(sys.argv[1])\n"
    "try:\n"
    "    load_mcp_server_config(config_path=p, server_name='hep-research')\n"
    "except Exception as e:\n"
    "    print(type(e).__name__)\n"
    "    sys.exit(0)\n"
    "print('NO_EXCEPTION')\n"
    "sys.exit(1)\n"
)


class TestMcpConfig(unittest.TestCase):
    def test_import_mcp_modules(self) -> None:
        code = (
            "from hep_autoresearch.toolkit.mcp_config import McpServerConfig\n"
            "from hep_autoresearch.toolkit.mcp_stdio_client import McpStdioClient\n"
            "print('OK')\n"
        )
        rc, out, err = _run_py(code)
        self.assertEqual(rc, 0, msg=out + err)
        self.assertIn("OK", out)

    def test_load_mcp_server_config_missing_mcpServers(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            p = Path(td) / ".mcp.json"
            p.write_text(json.dumps({"x": 1}) + "\n", encoding="utf-8")
            rc, out, err = _run_py(_LOAD_CFG_SNIPPET, str(p))
            self.assertEqual(rc, 0, msg=out + err)
            self.assertIn("ValueError", out)

    def test_load_mcp_server_config_server_not_found(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            p = Path(td) / ".mcp.json"
            p.write_text(json.dumps({"mcpServers": {}}) + "\n", encoding="utf-8")
            rc, out, err = _run_py(_LOAD_CFG_SNIPPET, str(p))
            self.assertEqual(rc, 0, msg=out + err)
            self.assertIn("KeyError", out)

    def test_load_mcp_server_config_missing_command(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            p = Path(td) / ".mcp.json"
            p.write_text(json.dumps({"mcpServers": {"hep-research": {"args": []}}}) + "\n", encoding="utf-8")
            rc, out, err = _run_py(_LOAD_CFG_SNIPPET, str(p))
            self.assertEqual(rc, 0, msg=out + err)
            self.assertIn("ValueError", out)

    def test_merged_env_allowlist_and_overrides(self) -> None:
        code = (
            "import json\n"
            "from hep_autoresearch.toolkit.mcp_config import merged_env\n"
            "base = {\n"
            "  'PATH': '/bin',\n"
            "  'HOME': '/home/x',\n"
            "  'OPENAI_API_KEY': 'SECRET',\n"
            "  'UNRELATED': 'DROP',\n"
            "}\n"
            "env = merged_env(base=base, overrides={'HEP_DATA_DIR': '/tmp/hep', 'PATH': '/custom/bin'})\n"
            "print(json.dumps(env, sort_keys=True))\n"
        )
        rc, out, err = _run_py(code)
        self.assertEqual(rc, 0, msg=out + err)
        env = json.loads(out)
        self.assertEqual(env.get("PATH"), "/custom/bin")
        self.assertEqual(env.get("HEP_DATA_DIR"), "/tmp/hep")
        self.assertIn("HOME", env)
        self.assertNotIn("OPENAI_API_KEY", env)
        self.assertNotIn("UNRELATED", env)
