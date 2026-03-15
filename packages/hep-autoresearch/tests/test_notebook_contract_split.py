import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


def _src_root() -> Path:
    return Path(__file__).resolve().parents[1] / "src"


class TestNotebookContractSplit(unittest.TestCase):
    def test_contract_sync_and_context_pack_use_new_surface(self) -> None:
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            env = dict(os.environ)
            env["PYTHONPATH"] = str(_src_root()) + os.pathsep + env.get("PYTHONPATH", "")
            proc = subprocess.run(
                [
                    sys.executable,
                    "-c",
                    (
                        "import json, sys\n"
                        "from pathlib import Path\n"
                        "from hep_autoresearch.toolkit.context_pack import ContextPackInputs, build_context_pack\n"
                        "from hep_autoresearch.toolkit.project_scaffold import ensure_project_scaffold\n"
                        "from hep_autoresearch.toolkit.research_contract import sync_research_contract\n"
                        "root = Path(sys.argv[1])\n"
                        "ensure_project_scaffold(repo_root=root, project_name='Notebook Split')\n"
                        "notebook = root / 'research_notebook.md'\n"
                        "notebook.write_text("
                        "'# research_notebook.md\\n\\n'"
                        "'## Goal\\n\\n'"
                        "'- Make the notebook human-readable.\\n\\n'"
                        "'## Results\\n\\n'"
                        "'- Main result lives here.\\n\\n'"
                        "'## References\\n\\n'"
                        "'- [DemoRef](knowledge_base/literature/demo.md)\\n',"
                        "encoding='utf-8')\n"
                        "result = sync_research_contract(repo_root=root, create_missing=False)\n"
                        "payload = build_context_pack(ContextPackInputs(run_id='M0-context'), repo_root=root)\n"
                        "print(json.dumps({'result': result, 'payload': payload}))\n"
                    ),
                    str(root),
                ],
                capture_output=True,
                check=False,
                env=env,
                text=True,
            )
            self.assertEqual(proc.returncode, 0, msg=proc.stdout + proc.stderr)
            payload = json.loads(proc.stdout)
            result = payload["result"]
            context_payload = payload["payload"]
            contract_text = (root / "research_contract.md").read_text(encoding="utf-8")

            self.assertIn("Source notebook: `research_notebook.md`", contract_text)
            self.assertIn("Notebook sections", contract_text)
            self.assertIn("- Goal", contract_text)
            self.assertIn("- Results", contract_text)
            self.assertIn("- [DemoRef](knowledge_base/literature/demo.md)", contract_text)
            self.assertIn("REPRO_CAPSULE_START", contract_text)
            self.assertIn("notebook_sha256", json.dumps(result))

            files = {item["path"]: item for item in context_payload["project"]["context_files"]}
            self.assertIn("research_notebook.md", files)
            self.assertIn("research_contract.md", files)
            self.assertEqual(context_payload["project"]["required_context_ok"], 1)
