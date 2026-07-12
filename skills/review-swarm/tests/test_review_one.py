import contextlib
import importlib.util
import io
import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest import mock

_SKILL_ROOT = Path(__file__).resolve().parents[1]


def _load_module(name: str):
    module_path = _SKILL_ROOT / "scripts" / "bin" / f"{name}.py"
    spec = importlib.util.spec_from_file_location(name, module_path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"Failed to load module spec: {module_path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _read_trace_events(trace_path: Path) -> list[dict]:
    if not trace_path.exists():
        return []
    return [json.loads(line) for line in trace_path.read_text(encoding="utf-8").splitlines() if line.strip()]


def _write_stub_runner(path: Path) -> None:
    path.write_text(
        """#!/usr/bin/env bash
set -euo pipefail
out=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --out) out="$2"; shift 2 ;;
    *) shift ;;
  esac
done
cat >"${out}" <<'MD'
VERDICT: READY

## Blockers
- none

## Non-blocking
- none

## Real-research fit
- n/a

## Robustness & safety
- n/a

## Specific patch suggestions
- n/a
MD
""",
        encoding="utf-8",
    )
    path.chmod(0o755)


def _write_empty_then_valid_runner(path: Path, state_dir: Path) -> None:
    """Runner that writes an empty file on the first call, valid output after."""
    state_dir.mkdir(parents=True, exist_ok=True)
    path.write_text(
        f"""#!/usr/bin/env bash
set -euo pipefail
out=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --out) out="$2"; shift 2 ;;
    *) shift ;;
  esac
done
count_file="{state_dir}/count"
n=0
if [[ -f "${{count_file}}" ]]; then
  n=$(cat "${{count_file}}")
fi
n=$((n + 1))
echo "${{n}}" >"${{count_file}}"
if [[ "${{n}}" -ge 2 ]]; then
  printf 'VERDICT: READY\\n' >"${{out}}"
else
  : >"${{out}}"
fi
""",
        encoding="utf-8",
    )
    path.chmod(0o755)


@contextlib.contextmanager
def _temp_env(**updates):
    old = {}
    for k, v in updates.items():
        old[k] = os.environ.get(k)
        if v is None:
            os.environ.pop(k, None)
        else:
            os.environ[k] = v
    try:
        yield
    finally:
        for k, v in old.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v


@contextlib.contextmanager
def _chdir(path: Path):
    prior = Path.cwd()
    os.chdir(path)
    try:
        yield
    finally:
        os.chdir(prior)


class ReviewOneTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.mod = _load_module("review_one")
        # Hermetic: never let a real project config leak into these tests.
        os.environ["REVIEW_SWARM_NO_AUTO_CONFIG"] = "1"

    @classmethod
    def tearDownClass(cls):
        os.environ.pop("REVIEW_SWARM_NO_AUTO_CONFIG", None)

    def _basic_argv(self, td_path: Path, out_dir: Path, artifact: Path, *extra: str) -> list[str]:
        runner = td_path / "run_codex.sh"
        if not runner.exists():
            _write_stub_runner(runner)
        argv = [
            "--model",
            "codex/default",
            "--artifact",
            str(artifact),
            "--codex-runner",
            str(runner),
            "--out-dir",
            str(out_dir),
            *extra,
        ]
        if (
            ("source-fidelity" in extra or "source-extraction" in extra)
            and "--source" in extra
            and "--correction-status" not in extra
        ):
            argv.extend(["--correction-status", "not-applicable"])
        if (
            ("source-fidelity" in extra or "source-extraction" in extra)
            and "--source" in extra
            and "--source-text-origin" not in extra
        ):
            argv.extend(["--source-text-origin", "direct-original-text"])
        return argv

    def test_packet_assembly_banner_artifact_and_template(self):
        with tempfile.TemporaryDirectory() as td:
            td_path = Path(td)
            out_dir = td_path / "out"
            artifact = td_path / "artifact.md"
            artifact.write_text("ARTIFACT MARKER alpha-beta-gamma\n", encoding="utf-8")

            stdout = io.StringIO()
            with contextlib.redirect_stdout(stdout):
                rc = self.mod.main(self._basic_argv(td_path, out_dir, artifact))
            self.assertEqual(rc, 0)

            packet = (out_dir / "inputs" / "packet.md").read_text(encoding="utf-8")
            self.assertTrue(packet.startswith(self.mod.ADVISORY_BANNER))
            self.assertIn("ARTIFACT MARKER alpha-beta-gamma", packet)
            self.assertIn(f"=== ARTIFACT: {artifact.resolve()} ===", packet)

            # Default role: the delegated system prompt is templates/generic.md verbatim.
            system_text = (out_dir / "inputs" / "system.md").read_text(encoding="utf-8")
            template_text = (_SKILL_ROOT / "templates" / "generic.md").read_text(encoding="utf-8")
            self.assertEqual(system_text, template_text)
            self.assertIn("VERDICT: READY", template_text)
            self.assertIn("## Blockers", template_text)

            # stdout summary: verdict line, contract_ok, output paths.
            printed = stdout.getvalue()
            self.assertIn("verdict: VERDICT: READY", printed)
            self.assertIn("contract_ok: true", printed)
            self.assertIn("output: ", printed)
            self.assertIn("meta: ", printed)

    def test_meta_shape_for_single_run(self):
        with tempfile.TemporaryDirectory() as td:
            td_path = Path(td)
            out_dir = td_path / "out"
            artifact = td_path / "artifact.md"
            artifact.write_text("content\n", encoding="utf-8")

            with contextlib.redirect_stdout(io.StringIO()):
                rc = self.mod.main(self._basic_argv(td_path, out_dir, artifact))
            self.assertEqual(rc, 0)

            meta = json.loads((out_dir / "meta.json").read_text(encoding="utf-8"))
            self.assertEqual(meta["n_agents"], 1)
            self.assertEqual(meta["models"], ["codex/default"])
            self.assertEqual(meta["success_count"], 1)
            self.assertEqual(meta["unavailable_backends"], [])
            agent = meta["agents"][0]
            self.assertEqual(agent["verdict"], "VERDICT: READY")
            self.assertTrue(agent["contract_ok"])
            self.assertIsNone(agent["failure_reason"])
            self.assertIsNone(agent["failure_class"])
            self.assertEqual(len(meta["paths"]["outputs"]), 1)

    def test_role_selects_template(self):
        with tempfile.TemporaryDirectory() as td:
            td_path = Path(td)
            out_dir = td_path / "out"
            artifact = td_path / "artifact.md"
            source = td_path / "source.tex"
            artifact.write_text("content\n", encoding="utf-8")
            source.write_text("primary source content\n", encoding="utf-8")

            with mock.patch.object(
                self.mod, "_read_primary_source", wraps=self.mod._read_primary_source
            ) as source_reader:
                with contextlib.redirect_stdout(io.StringIO()):
                    rc = self.mod.main(
                        self._basic_argv(
                            td_path,
                            out_dir,
                            artifact,
                            "--role",
                            "source-fidelity",
                            "--source",
                            str(source),
                        )
                    )
            self.assertEqual(rc, 0)
            self.assertEqual(source_reader.call_count, 1)
            system_text = (out_dir / "inputs" / "system.md").read_text(encoding="utf-8")
            template_text = (_SKILL_ROOT / "templates" / "source-fidelity.md").read_text(encoding="utf-8")
            self.assertEqual(system_text, template_text)

    def test_source_fidelity_requires_primary_source_before_delegation(self):
        with tempfile.TemporaryDirectory() as td:
            td_path = Path(td)
            out_dir = td_path / "out"
            artifact = td_path / "artifact.md"
            artifact.write_text("content\n", encoding="utf-8")

            stderr = io.StringIO()
            with contextlib.redirect_stderr(stderr), contextlib.redirect_stdout(io.StringIO()):
                rc = self.mod.main(
                    self._basic_argv(td_path, out_dir, artifact, "--role", "source-fidelity")
                )
            self.assertEqual(rc, 2)
            self.assertIn("requires at least one --source", stderr.getvalue())
            self.assertFalse((out_dir / "meta.json").exists())

    def test_source_fidelity_requires_source_text_origin_before_delegation(self):
        with tempfile.TemporaryDirectory() as td:
            td_path = Path(td)
            artifact = td_path / "artifact.md"
            source = td_path / "source.tex"
            artifact.write_text("candidate\n", encoding="utf-8")
            source.write_text("source\n", encoding="utf-8")
            stderr = io.StringIO()
            with contextlib.redirect_stderr(stderr), contextlib.redirect_stdout(io.StringIO()):
                rc = self.mod.main(
                    [
                        "--model",
                        "codex/default",
                        "--artifact",
                        str(artifact),
                        "--role",
                        "source-fidelity",
                        "--source",
                        str(source),
                        "--correction-status",
                        "not-applicable",
                    ]
                )
            self.assertEqual(rc, 2)
            self.assertIn("requires --source-text-origin", stderr.getvalue())

    def test_visual_transcription_requires_provenance_evidence(self):
        with tempfile.TemporaryDirectory() as td:
            td_path = Path(td)
            artifact = td_path / "artifact.md"
            source = td_path / "source.txt"
            artifact.write_text("candidate\n", encoding="utf-8")
            source.write_text("manual transcription\n", encoding="utf-8")
            stderr = io.StringIO()
            with contextlib.redirect_stderr(stderr), contextlib.redirect_stdout(io.StringIO()):
                rc = self.mod.main(
                    self._basic_argv(
                        td_path,
                        td_path / "out",
                        artifact,
                        "--role",
                        "source-fidelity",
                        "--source",
                        str(source),
                        "--source-text-origin",
                        "visually-verified-transcription",
                    )
                )
            self.assertEqual(rc, 2)
            self.assertIn("requires at least one --source-provenance-evidence", stderr.getvalue())

    def test_visual_transcription_records_provenance_evidence(self):
        with tempfile.TemporaryDirectory() as td:
            td_path = Path(td)
            out_dir = td_path / "out"
            artifact = td_path / "artifact.md"
            source = td_path / "source.txt"
            evidence = td_path / "visual-evidence.md"
            artifact.write_text("candidate\n", encoding="utf-8")
            source.write_text("manual transcription\n", encoding="utf-8")
            evidence.write_text("page 7 and crop hashes checked visually\n", encoding="utf-8")
            with contextlib.redirect_stdout(io.StringIO()):
                rc = self.mod.main(
                    self._basic_argv(
                        td_path,
                        out_dir,
                        artifact,
                        "--role",
                        "source-fidelity",
                        "--source",
                        str(source),
                        "--source-text-origin",
                        "visually-verified-transcription",
                        "--source-provenance-evidence",
                        str(evidence),
                    )
                )
            self.assertEqual(rc, 0)
            packet = (out_dir / "inputs" / "packet.md").read_text(encoding="utf-8")
            self.assertIn("SOURCE_TEXT_ORIGIN: visually-verified-transcription", packet)
            self.assertIn(f"=== SOURCE PROVENANCE EVIDENCE: {evidence.resolve()} ===", packet)
            manifest = json.loads(
                (out_dir / "inputs" / "source_fidelity_manifest.json").read_text(
                    encoding="utf-8"
                )
            )
            self.assertEqual(manifest["source_text_origin"], "visually-verified-transcription")
            self.assertEqual(
                manifest["source_page_fidelity"],
                "claimed_by_provenance_evidence_not_machine_verified",
            )
            self.assertEqual(
                manifest["source_provenance_evidence"][0]["path"],
                str(evidence.resolve()),
            )

    def test_source_fidelity_packet_separates_source_and_target_and_records_hash(self):
        with tempfile.TemporaryDirectory() as td:
            td_path = Path(td)
            out_dir = td_path / "out"
            artifact = td_path / "artifact.md"
            source = td_path / "source.tex"
            context = td_path / "context.md"
            artifact.write_text("candidate transcription\n", encoding="utf-8")
            source_payload = "literal source equation alpha = beta  \n\n"
            source.write_text(source_payload, encoding="utf-8")
            context.write_text("context whose anchoring content is not machine classified\n", encoding="utf-8")

            with contextlib.redirect_stdout(io.StringIO()):
                rc = self.mod.main(
                    self._basic_argv(
                        td_path,
                        out_dir,
                        artifact,
                        "--role",
                        "source-fidelity",
                        "--source",
                        str(source),
                        "--context",
                        str(context),
                    )
                )
            self.assertEqual(rc, 0)
            packet = (out_dir / "inputs" / "packet.md").read_text(encoding="utf-8")
            self.assertIn(f"=== PRIMARY SOURCE: {source.resolve()} ===", packet)
            self.assertIn(f"=== ARTIFACT UNDER REVIEW: {artifact.resolve()} ===", packet)
            self.assertLess(packet.index("=== PRIMARY SOURCE:"), packet.index("=== ARTIFACT UNDER REVIEW:"))
            self.assertIn("this run is a comparison pass, not a candidate-withheld independent extraction", packet)
            self.assertIn(source_payload + "=== END PRIMARY SOURCE ===", packet)

            manifest = json.loads(
                (out_dir / "inputs" / "source_fidelity_manifest.json").read_text(encoding="utf-8")
            )
            self.assertTrue(manifest["gate_input_valid"])
            self.assertEqual(manifest["schema_version"], 2)
            self.assertEqual(manifest["candidate_visibility"], "visible_in_same_packet")
            self.assertFalse(manifest["candidate_withheld_extraction_performed_by_this_run"])
            self.assertEqual(manifest["correction_status"], "not-applicable")
            self.assertEqual(manifest["source_text_origin"], "direct-original-text")
            self.assertEqual(
                manifest["source_page_fidelity"],
                "direct_original_text_claim_not_machine_verified",
            )
            self.assertEqual(manifest["correction_sources"], [])
            self.assertEqual(manifest["primary_sources"][0]["path"], str(source.resolve()))
            self.assertEqual(len(manifest["primary_sources"][0]["sha256"]), 64)
            self.assertEqual(
                manifest["primary_sources"][0]["sha256"],
                manifest["primary_sources"][0]["embedded_text_sha256"],
            )
            self.assertEqual(manifest["target_artifacts"][0]["path"], str(artifact.resolve()))
            self.assertEqual(len(manifest["target_artifacts"][0]["sha256"]), 64)
            self.assertEqual(manifest["additional_context"]["path"], str(context.resolve()))
            self.assertEqual(manifest["additional_context_count"], 1)
            self.assertEqual(
                manifest["additional_contexts"][0]["path"], str(context.resolve())
            )
            self.assertEqual(
                manifest["additional_context_content_classification"], "not_machine_verified"
            )

    def test_repeatable_contexts_are_embedded_and_manifested_in_order(self):
        with tempfile.TemporaryDirectory() as td:
            td_path = Path(td)
            out_dir = td_path / "out"
            artifact = td_path / "artifact.md"
            source = td_path / "source.tex"
            context_a = td_path / "context-a.md"
            context_b = td_path / "context-b.md"
            artifact.write_text("candidate transcription\n", encoding="utf-8")
            source.write_text("literal source equation\n", encoding="utf-8")
            context_a.write_text("first full-file context\n", encoding="utf-8")
            context_b.write_text("second full-file context\n", encoding="utf-8")

            with contextlib.redirect_stdout(io.StringIO()):
                rc = self.mod.main(
                    self._basic_argv(
                        td_path,
                        out_dir,
                        artifact,
                        "--role",
                        "source-fidelity",
                        "--source",
                        str(source),
                        "--context",
                        str(context_a),
                        "--context",
                        str(context_b),
                    )
                )
            self.assertEqual(rc, 0)
            packet = (out_dir / "inputs" / "packet.md").read_text(encoding="utf-8")
            marker_a = f"=== ADDITIONAL CONTEXT: {context_a.resolve()} ==="
            marker_b = f"=== ADDITIONAL CONTEXT: {context_b.resolve()} ==="
            self.assertIn(marker_a, packet)
            self.assertIn(marker_b, packet)
            self.assertLess(packet.index(marker_a), packet.index(marker_b))
            self.assertEqual(packet.count("CONTEXT_FILE_SHA256:"), 2)

            manifest = json.loads(
                (out_dir / "inputs" / "source_fidelity_manifest.json").read_text(
                    encoding="utf-8"
                )
            )
            self.assertIsNone(manifest["additional_context"])
            self.assertEqual(manifest["additional_context_count"], 2)
            self.assertEqual(
                [entry["path"] for entry in manifest["additional_contexts"]],
                [str(context_a.resolve()), str(context_b.resolve())],
            )

    def test_duplicate_context_paths_are_rejected(self):
        with tempfile.TemporaryDirectory() as td:
            td_path = Path(td)
            artifact = td_path / "artifact.md"
            context = td_path / "context.md"
            artifact.write_text("candidate\n", encoding="utf-8")
            context.write_text("context\n", encoding="utf-8")
            stderr = io.StringIO()
            with contextlib.redirect_stderr(stderr), contextlib.redirect_stdout(io.StringIO()):
                rc = self.mod.main(
                    self._basic_argv(
                        td_path,
                        td_path / "out",
                        artifact,
                        "--context",
                        str(context),
                        "--context",
                        str(context),
                    )
                )
            self.assertEqual(rc, 2)
            self.assertIn("duplicate --context paths", stderr.getvalue())

    def test_non_source_role_rejects_target_reused_as_context(self):
        with tempfile.TemporaryDirectory() as td:
            td_path = Path(td)
            artifact = td_path / "artifact.md"
            artifact.write_text("candidate\n", encoding="utf-8")
            stderr = io.StringIO()
            with contextlib.redirect_stderr(stderr), contextlib.redirect_stdout(io.StringIO()):
                rc = self.mod.main(
                    self._basic_argv(
                        td_path,
                        td_path / "out",
                        artifact,
                        "--role",
                        "correctness",
                        "--context",
                        str(artifact),
                    )
                )
            self.assertEqual(rc, 2)
            self.assertIn(
                "review target and additional context must be distinct",
                stderr.getvalue(),
            )

    def test_source_fidelity_rejects_same_file_as_source_and_target(self):
        with tempfile.TemporaryDirectory() as td:
            td_path = Path(td)
            artifact = td_path / "artifact.md"
            artifact.write_text("content\n", encoding="utf-8")
            stderr = io.StringIO()
            with contextlib.redirect_stderr(stderr), contextlib.redirect_stdout(io.StringIO()):
                rc = self.mod.main(
                    self._basic_argv(
                        td_path,
                        td_path / "out",
                        artifact,
                        "--role",
                        "source-fidelity",
                        "--source",
                        str(artifact),
                    )
                )
            self.assertEqual(rc, 2)
            self.assertIn("must be distinct files", stderr.getvalue())

    def test_source_fidelity_rejects_binary_source(self):
        with tempfile.TemporaryDirectory() as td:
            td_path = Path(td)
            artifact = td_path / "artifact.md"
            source = td_path / "source.pdf"
            artifact.write_text("content\n", encoding="utf-8")
            source.write_bytes(b"%PDF-1.7\x00binary")
            stderr = io.StringIO()
            with contextlib.redirect_stderr(stderr), contextlib.redirect_stdout(io.StringIO()):
                rc = self.mod.main(
                    self._basic_argv(
                        td_path,
                        td_path / "out",
                        artifact,
                        "--role",
                        "source-fidelity",
                        "--source",
                        str(source),
                    )
                )
            self.assertEqual(rc, 2)
            self.assertIn("not a binary file", stderr.getvalue())

    def test_source_fidelity_rejects_duplicate_sources(self):
        with tempfile.TemporaryDirectory() as td:
            td_path = Path(td)
            artifact = td_path / "artifact.md"
            source = td_path / "source.tex"
            artifact.write_text("content\n", encoding="utf-8")
            source.write_text("source\n", encoding="utf-8")
            stderr = io.StringIO()
            with contextlib.redirect_stderr(stderr), contextlib.redirect_stdout(io.StringIO()):
                rc = self.mod.main(
                    self._basic_argv(
                        td_path,
                        td_path / "out",
                        artifact,
                        "--role",
                        "source-fidelity",
                        "--source",
                        str(source),
                        "--source",
                        str(source),
                    )
                )
            self.assertEqual(rc, 2)
            self.assertIn("duplicate --source paths", stderr.getvalue())

    def test_source_fidelity_rejects_source_reused_as_context(self):
        with tempfile.TemporaryDirectory() as td:
            td_path = Path(td)
            artifact = td_path / "artifact.md"
            source = td_path / "source.tex"
            artifact.write_text("content\n", encoding="utf-8")
            source.write_text("source\n", encoding="utf-8")
            stderr = io.StringIO()
            with contextlib.redirect_stderr(stderr), contextlib.redirect_stdout(io.StringIO()):
                rc = self.mod.main(
                    self._basic_argv(
                        td_path,
                        td_path / "out",
                        artifact,
                        "--role",
                        "source-fidelity",
                        "--source",
                        str(source),
                        "--context",
                        str(source),
                    )
                )
            self.assertEqual(rc, 2)
            self.assertIn("source inputs and additional context must be distinct", stderr.getvalue())

    def test_source_flag_is_rejected_for_other_roles(self):
        with tempfile.TemporaryDirectory() as td:
            td_path = Path(td)
            artifact = td_path / "artifact.md"
            source = td_path / "source.tex"
            artifact.write_text("content\n", encoding="utf-8")
            source.write_text("source\n", encoding="utf-8")
            stderr = io.StringIO()
            with contextlib.redirect_stderr(stderr), contextlib.redirect_stdout(io.StringIO()):
                rc = self.mod.main(
                    self._basic_argv(td_path, td_path / "out", artifact, "--source", str(source))
                )
            self.assertEqual(rc, 2)
            self.assertIn(
                "only valid with --role source-extraction or --role source-fidelity",
                stderr.getvalue(),
            )

    def test_source_fidelity_requires_correction_status_before_delegation(self):
        with tempfile.TemporaryDirectory() as td:
            td_path = Path(td)
            out_dir = td_path / "out"
            artifact = td_path / "artifact.md"
            source = td_path / "source.tex"
            runner = td_path / "run_codex.sh"
            artifact.write_text("candidate\n", encoding="utf-8")
            source.write_text("primary source\n", encoding="utf-8")
            _write_stub_runner(runner)

            stderr = io.StringIO()
            with contextlib.redirect_stderr(stderr), contextlib.redirect_stdout(io.StringIO()):
                rc = self.mod.main(
                    [
                        "--model",
                        "codex/default",
                        "--artifact",
                        str(artifact),
                        "--role",
                        "source-fidelity",
                        "--source",
                        str(source),
                        "--source-text-origin",
                        "direct-original-text",
                        "--codex-runner",
                        str(runner),
                        "--out-dir",
                        str(out_dir),
                    ]
                )
            self.assertEqual(rc, 2)
            self.assertIn("requires --correction-status", stderr.getvalue())
            self.assertFalse((out_dir / "meta.json").exists())

    def test_source_fidelity_embeds_correction_source_and_manifest(self):
        with tempfile.TemporaryDirectory() as td:
            td_path = Path(td)
            out_dir = td_path / "out"
            artifact = td_path / "artifact.md"
            source = td_path / "source.tex"
            correction = td_path / "erratum.tex"
            search_evidence = td_path / "correction-search.md"
            artifact.write_text("candidate\n", encoding="utf-8")
            source.write_text("printed equation\n", encoding="utf-8")
            correction.write_text("multiply equation by factor q\n", encoding="utf-8")
            search_evidence.write_text(
                "searched registry A for identifier X; erratum Y found\n",
                encoding="utf-8",
            )

            with contextlib.redirect_stdout(io.StringIO()):
                rc = self.mod.main(
                    self._basic_argv(
                        td_path,
                        out_dir,
                        artifact,
                        "--role",
                        "source-fidelity",
                        "--source",
                        str(source),
                        "--source-text-origin",
                        "direct-original-text",
                        "--correction-status",
                        "checked-corrections-included",
                        "--correction-source",
                        str(correction),
                        "--correction-search-evidence",
                        str(search_evidence),
                    )
                )
            self.assertEqual(rc, 0)
            packet = (out_dir / "inputs" / "packet.md").read_text(encoding="utf-8")
            self.assertIn("CORRECTION_STATUS: checked-corrections-included", packet)
            self.assertIn(f"=== CORRECTION SOURCE: {correction.resolve()} ===", packet)
            self.assertIn(
                f"=== CORRECTION SEARCH EVIDENCE: {search_evidence.resolve()} ===",
                packet,
            )
            manifest = json.loads(
                (out_dir / "inputs" / "source_fidelity_manifest.json").read_text(
                    encoding="utf-8"
                )
            )
            self.assertEqual(manifest["correction_status"], "checked-corrections-included")
            self.assertEqual(manifest["correction_sources"][0]["path"], str(correction.resolve()))
            self.assertEqual(len(manifest["correction_sources"][0]["sha256"]), 64)
            self.assertEqual(
                manifest["correction_search_evidence"][0]["path"],
                str(search_evidence.resolve()),
            )
            self.assertEqual(
                manifest["correction_search_evidence"][0]["content_classification"],
                "search_record_content_not_machine_verified",
            )

    def test_source_fidelity_correction_status_requires_correction_source(self):
        with tempfile.TemporaryDirectory() as td:
            td_path = Path(td)
            artifact = td_path / "artifact.md"
            source = td_path / "source.tex"
            artifact.write_text("candidate\n", encoding="utf-8")
            source.write_text("primary source\n", encoding="utf-8")
            stderr = io.StringIO()
            with contextlib.redirect_stderr(stderr), contextlib.redirect_stdout(io.StringIO()):
                rc = self.mod.main(
                    self._basic_argv(
                        td_path,
                        td_path / "out",
                        artifact,
                        "--role",
                        "source-fidelity",
                        "--source",
                        str(source),
                        "--source-text-origin",
                        "direct-original-text",
                        "--correction-status",
                        "checked-corrections-included",
                    )
                )
            self.assertEqual(rc, 2)
            self.assertIn("requires at least one --correction-source", stderr.getvalue())

    def test_source_fidelity_rejects_correction_source_without_included_status(self):
        with tempfile.TemporaryDirectory() as td:
            td_path = Path(td)
            artifact = td_path / "artifact.md"
            source = td_path / "source.tex"
            correction = td_path / "erratum.tex"
            artifact.write_text("candidate\n", encoding="utf-8")
            source.write_text("primary source\n", encoding="utf-8")
            correction.write_text("correction\n", encoding="utf-8")
            stderr = io.StringIO()
            with contextlib.redirect_stderr(stderr), contextlib.redirect_stdout(io.StringIO()):
                rc = self.mod.main(
                    self._basic_argv(
                        td_path,
                        td_path / "out",
                        artifact,
                        "--role",
                        "source-fidelity",
                        "--source",
                        str(source),
                        "--source-text-origin",
                        "direct-original-text",
                        "--correction-status",
                        "checked-none-found",
                        "--correction-source",
                        str(correction),
                    )
                )
            self.assertEqual(rc, 2)
            self.assertIn("only valid with", stderr.getvalue())

    def test_source_fidelity_rejects_same_primary_and_correction_source(self):
        with tempfile.TemporaryDirectory() as td:
            td_path = Path(td)
            artifact = td_path / "artifact.md"
            source = td_path / "source.tex"
            search_evidence = td_path / "correction-search.md"
            artifact.write_text("candidate\n", encoding="utf-8")
            source.write_text("primary and correction\n", encoding="utf-8")
            search_evidence.write_text("search record\n", encoding="utf-8")
            stderr = io.StringIO()
            with contextlib.redirect_stderr(stderr), contextlib.redirect_stdout(io.StringIO()):
                rc = self.mod.main(
                    self._basic_argv(
                        td_path,
                        td_path / "out",
                        artifact,
                        "--role",
                        "source-fidelity",
                        "--source",
                        str(source),
                        "--source-text-origin",
                        "direct-original-text",
                        "--correction-status",
                        "checked-corrections-included",
                        "--correction-source",
                        str(source),
                        "--correction-search-evidence",
                        str(search_evidence),
                    )
                )
            self.assertEqual(rc, 2)
            self.assertIn("must be distinct files", stderr.getvalue())

    def test_checked_none_found_requires_correction_search_evidence(self):
        with tempfile.TemporaryDirectory() as td:
            td_path = Path(td)
            artifact = td_path / "artifact.md"
            source = td_path / "source.tex"
            artifact.write_text("candidate\n", encoding="utf-8")
            source.write_text("primary source\n", encoding="utf-8")
            stderr = io.StringIO()
            with contextlib.redirect_stderr(stderr), contextlib.redirect_stdout(io.StringIO()):
                rc = self.mod.main(
                    self._basic_argv(
                        td_path,
                        td_path / "out",
                        artifact,
                        "--role",
                        "source-fidelity",
                        "--source",
                        str(source),
                        "--correction-status",
                        "checked-none-found",
                    )
                )
            self.assertEqual(rc, 2)
            self.assertIn("requires at least one --correction-search-evidence", stderr.getvalue())

    def test_checked_none_found_records_correction_search_evidence(self):
        with tempfile.TemporaryDirectory() as td:
            td_path = Path(td)
            out_dir = td_path / "out"
            artifact = td_path / "artifact.md"
            source = td_path / "source.tex"
            search_evidence = td_path / "correction-search.md"
            artifact.write_text("candidate\n", encoding="utf-8")
            source.write_text("primary source\n", encoding="utf-8")
            search_evidence.write_text(
                "searched registry A for identifier X; no corrections found\n",
                encoding="utf-8",
            )
            with contextlib.redirect_stdout(io.StringIO()):
                rc = self.mod.main(
                    self._basic_argv(
                        td_path,
                        out_dir,
                        artifact,
                        "--role",
                        "source-fidelity",
                        "--source",
                        str(source),
                        "--correction-status",
                        "checked-none-found",
                        "--correction-search-evidence",
                        str(search_evidence),
                    )
                )
            self.assertEqual(rc, 0)
            manifest = json.loads(
                (out_dir / "inputs" / "source_fidelity_manifest.json").read_text(
                    encoding="utf-8"
                )
            )
            self.assertEqual(manifest["correction_status"], "checked-none-found")
            self.assertEqual(manifest["correction_sources"], [])
            self.assertEqual(
                manifest["correction_search_evidence"][0]["path"],
                str(search_evidence.resolve()),
            )

    def test_corrections_included_requires_correction_search_evidence(self):
        with tempfile.TemporaryDirectory() as td:
            td_path = Path(td)
            artifact = td_path / "artifact.md"
            source = td_path / "source.tex"
            correction = td_path / "erratum.tex"
            artifact.write_text("candidate\n", encoding="utf-8")
            source.write_text("primary source\n", encoding="utf-8")
            correction.write_text("correction\n", encoding="utf-8")
            stderr = io.StringIO()
            with contextlib.redirect_stderr(stderr), contextlib.redirect_stdout(io.StringIO()):
                rc = self.mod.main(
                    self._basic_argv(
                        td_path,
                        td_path / "out",
                        artifact,
                        "--role",
                        "source-fidelity",
                        "--source",
                        str(source),
                        "--correction-status",
                        "checked-corrections-included",
                        "--correction-source",
                        str(correction),
                    )
                )
            self.assertEqual(rc, 2)
            self.assertIn("requires at least one --correction-search-evidence", stderr.getvalue())

    def test_not_applicable_rejects_correction_search_evidence(self):
        with tempfile.TemporaryDirectory() as td:
            td_path = Path(td)
            artifact = td_path / "artifact.md"
            source = td_path / "source.tex"
            search_evidence = td_path / "correction-search.md"
            artifact.write_text("candidate\n", encoding="utf-8")
            source.write_text("primary source\n", encoding="utf-8")
            search_evidence.write_text("search record\n", encoding="utf-8")
            stderr = io.StringIO()
            with contextlib.redirect_stderr(stderr), contextlib.redirect_stdout(io.StringIO()):
                rc = self.mod.main(
                    self._basic_argv(
                        td_path,
                        td_path / "out",
                        artifact,
                        "--role",
                        "source-fidelity",
                        "--source",
                        str(source),
                        "--correction-status",
                        "not-applicable",
                        "--correction-search-evidence",
                        str(search_evidence),
                    )
                )
            self.assertEqual(rc, 2)
            self.assertIn("not valid with --correction-status not-applicable", stderr.getvalue())

    def test_source_extraction_withholds_candidate_by_packet_structure(self):
        with tempfile.TemporaryDirectory() as td:
            td_path = Path(td)
            out_dir = td_path / "out"
            source = td_path / "source.tex"
            request = td_path / "neutral-request.md"
            runner = td_path / "run_codex.sh"
            source.write_text("literal source equation\n", encoding="utf-8")
            request.write_text("Extract Eq. (4) and define each symbol.\n", encoding="utf-8")
            _write_stub_runner(runner)

            with contextlib.redirect_stdout(io.StringIO()):
                rc = self.mod.main(
                    [
                        "--model",
                        "codex/default",
                        "--extraction-request",
                        str(request),
                        "--role",
                        "source-extraction",
                        "--source",
                        str(source),
                        "--source-text-origin",
                        "direct-original-text",
                        "--correction-status",
                        "not-applicable",
                        "--codex-runner",
                        str(runner),
                        "--out-dir",
                        str(out_dir),
                    ]
                )
            self.assertEqual(rc, 0)
            packet = (out_dir / "inputs" / "packet.md").read_text(encoding="utf-8")
            self.assertIn("=== SOURCE-EXTRACTION SCOPE ===", packet)
            self.assertIn(f"=== NEUTRAL EXTRACTION REQUEST: {request.resolve()} ===", packet)
            self.assertNotIn("ARTIFACT UNDER REVIEW", packet)
            manifest = json.loads(
                (out_dir / "inputs" / "source_extraction_manifest.json").read_text(
                    encoding="utf-8"
                )
            )
            self.assertEqual(manifest["role"], "source-extraction")
            self.assertEqual(manifest["candidate_visibility"], "withheld_by_packet_structure")
            self.assertTrue(manifest["candidate_withheld_packet_constructed_by_this_run"])
            self.assertFalse(manifest["candidate_withheld_extraction_performed_by_this_run"])
            self.assertEqual(
                manifest["candidate_withheld_extraction_outcome"], "not_machine_verified"
            )
            self.assertEqual(manifest["extraction_request_neutrality"], "not_machine_verified")
            self.assertEqual(manifest["source_dependency_closure"], "not_machine_verified")
            self.assertEqual(
                manifest["neutral_extraction_request"]["path"], str(request.resolve())
            )

    def test_source_extraction_requires_extraction_request_when_artifact_is_given(self):
        with tempfile.TemporaryDirectory() as td:
            td_path = Path(td)
            artifact = td_path / "candidate.md"
            source = td_path / "source.tex"
            artifact.write_text("candidate answer\n", encoding="utf-8")
            source.write_text("primary source\n", encoding="utf-8")
            stderr = io.StringIO()
            with contextlib.redirect_stderr(stderr), contextlib.redirect_stdout(io.StringIO()):
                rc = self.mod.main(
                    self._basic_argv(
                        td_path,
                        td_path / "out",
                        artifact,
                        "--role",
                        "source-extraction",
                        "--source",
                        str(source),
                        "--source-text-origin",
                        "direct-original-text",
                        "--correction-status",
                        "not-applicable",
                    )
                )
            self.assertEqual(rc, 2)
            self.assertIn("requires --extraction-request", stderr.getvalue())

    def test_source_fidelity_rejects_target_reused_as_context(self):
        with tempfile.TemporaryDirectory() as td:
            td_path = Path(td)
            artifact = td_path / "candidate.md"
            source = td_path / "source.tex"
            artifact.write_text("candidate answer\n", encoding="utf-8")
            source.write_text("primary source\n", encoding="utf-8")
            stderr = io.StringIO()
            with contextlib.redirect_stderr(stderr), contextlib.redirect_stdout(io.StringIO()):
                rc = self.mod.main(
                    self._basic_argv(
                        td_path,
                        td_path / "out",
                        artifact,
                        "--role",
                        "source-fidelity",
                        "--source",
                        str(source),
                        "--context",
                        str(artifact),
                    )
                )
            self.assertEqual(rc, 2)
            self.assertIn(
                "review target and additional context must be distinct",
                stderr.getvalue(),
            )

    def test_source_extraction_rejects_additional_context(self):
        with tempfile.TemporaryDirectory() as td:
            td_path = Path(td)
            request = td_path / "neutral-request.md"
            source = td_path / "source.tex"
            context = td_path / "context.md"
            runner = td_path / "run_codex.sh"
            request.write_text("Extract Eq. (4).\n", encoding="utf-8")
            source.write_text("primary source\n", encoding="utf-8")
            context.write_text("prior verdict\n", encoding="utf-8")
            _write_stub_runner(runner)
            stderr = io.StringIO()
            with contextlib.redirect_stderr(stderr), contextlib.redirect_stdout(io.StringIO()):
                rc = self.mod.main(
                    [
                        "--model",
                        "codex/default",
                        "--extraction-request",
                        str(request),
                        "--role",
                        "source-extraction",
                        "--source",
                        str(source),
                        "--source-text-origin",
                        "direct-original-text",
                        "--correction-status",
                        "not-applicable",
                        "--context",
                        str(context),
                        "--codex-runner",
                        str(runner),
                        "--out-dir",
                        str(td_path / "out"),
                    ]
                )
            self.assertEqual(rc, 2)
            self.assertIn("forbids --context", stderr.getvalue())

    def test_all_role_templates_carry_contract_format(self):
        for role in self.mod._ROLES:
            template = (_SKILL_ROOT / "templates" / f"{role}.md").read_text(encoding="utf-8")
            for required in (
                "VERDICT: READY",
                "VERDICT: NOT_READY",
                "## Blockers",
                "## Non-blocking",
                "## Real-research fit",
                "## Robustness & safety",
                "## Specific patch suggestions",
            ):
                self.assertIn(required, template, f"{role}.md missing {required!r}")

    def test_source_role_templates_require_dependency_closure(self):
        for role in ("source-extraction", "source-fidelity"):
            template = (_SKILL_ROOT / "templates" / f"{role}.md").read_text(
                encoding="utf-8"
            ).lower()
            self.assertIn("dependency closure", template)
            self.assertIn("correction-search", template)
            self.assertIn("source-text origin", template)
            self.assertIn("provenance", template)

    def test_correctness_template_forbids_inferring_absence_from_diff(self):
        template = (_SKILL_ROOT / "templates" / "correctness.md").read_text(
            encoding="utf-8"
        )
        self.assertIn("Do not infer absence from a diff", template)
        self.assertIn("require the full relevant file", template)
        self.assertIn("report the point as unverified", template)

    def test_artifact_embedding_hits_size_guard(self):
        with tempfile.TemporaryDirectory() as td:
            td_path = Path(td)
            out_dir = td_path / "out"
            artifact = td_path / "big.md"
            artifact.write_text("X" * 10_000, encoding="utf-8")

            stderr = io.StringIO()
            with contextlib.redirect_stderr(stderr), contextlib.redirect_stdout(io.StringIO()):
                rc = self.mod.main(
                    self._basic_argv(td_path, out_dir, artifact, "--max-prompt-bytes", "5000")
                )
            self.assertEqual(rc, 2)
            self.assertIn("exceeds configured prompt limit", stderr.getvalue())

            events = _read_trace_events(out_dir / "trace.jsonl")
            violations = [e for e in events if e.get("event") == "prompt_guard_violation"]
            self.assertTrue(violations)
            self.assertEqual(violations[-1]["label"], "prompt")
            # Refused before any delegation: no runner ran, no meta was written.
            self.assertFalse((out_dir / "meta.json").exists())

    def test_model_is_required(self):
        with tempfile.TemporaryDirectory() as td:
            td_path = Path(td)
            artifact = td_path / "artifact.md"
            artifact.write_text("content\n", encoding="utf-8")
            with contextlib.redirect_stderr(io.StringIO()):
                with self.assertRaises(SystemExit) as ctx:
                    self.mod.main(["--artifact", str(artifact)])
            self.assertEqual(ctx.exception.code, 2)

    def test_review_target_is_required_by_parser(self):
        with tempfile.TemporaryDirectory() as td:
            source = Path(td) / "source.tex"
            source.write_text("source\n", encoding="utf-8")
            with contextlib.redirect_stderr(io.StringIO()):
                with self.assertRaises(SystemExit) as ctx:
                    self.mod.main(
                        [
                            "--model",
                            "codex/default",
                            "--role",
                            "source-fidelity",
                            "--source",
                            str(source),
                        ]
                    )
            self.assertEqual(ctx.exception.code, 2)

    def test_model_rejects_multiple_specs(self):
        with tempfile.TemporaryDirectory() as td:
            td_path = Path(td)
            artifact = td_path / "artifact.md"
            artifact.write_text("content\n", encoding="utf-8")
            stderr = io.StringIO()
            with contextlib.redirect_stderr(stderr):
                rc = self.mod.main(
                    ["--model", "codex/default,gemini/default", "--artifact", str(artifact)]
                )
            self.assertEqual(rc, 2)
            self.assertIn("exactly one model spec", stderr.getvalue())

    def test_host_family_refusal_points_to_in_host_review(self):
        with tempfile.TemporaryDirectory() as td:
            td_path = Path(td)
            artifact = td_path / "artifact.md"
            artifact.write_text("content\n", encoding="utf-8")
            stderr = io.StringIO()
            with contextlib.redirect_stderr(stderr):
                rc = self.mod.main(
                    [
                        "--model",
                        "codex/default",
                        "--artifact",
                        str(artifact),
                        "--host-family",
                        "codex",
                    ]
                )
            self.assertEqual(rc, 2)
            message = stderr.getvalue()
            self.assertIn("your own (host) family", message)
            self.assertIn("in-host", message)

    def test_host_family_mismatch_runs_normally(self):
        with tempfile.TemporaryDirectory() as td:
            td_path = Path(td)
            out_dir = td_path / "out"
            artifact = td_path / "artifact.md"
            artifact.write_text("content\n", encoding="utf-8")
            with contextlib.redirect_stdout(io.StringIO()):
                rc = self.mod.main(
                    self._basic_argv(td_path, out_dir, artifact, "--host-family", "claude")
                )
            self.assertEqual(rc, 0)

    def test_diff_mode_embeds_git_diff_output(self):
        with tempfile.TemporaryDirectory() as td:
            td_path = Path(td)
            repo = td_path / "repo"
            repo.mkdir()
            git_env = {
                "GIT_AUTHOR_NAME": "t",
                "GIT_AUTHOR_EMAIL": "t@example.invalid",
                "GIT_COMMITTER_NAME": "t",
                "GIT_COMMITTER_EMAIL": "t@example.invalid",
            }

            def _git(*argv: str) -> None:
                subprocess.run(
                    ["git", *argv],
                    cwd=repo,
                    check=True,
                    capture_output=True,
                    env={**os.environ, **git_env},
                )

            _git("init", "-q")
            (repo / "f.txt").write_text("old line\n", encoding="utf-8")
            _git("add", "f.txt")
            _git("commit", "-q", "-m", "one")
            (repo / "f.txt").write_text("new marker line\n", encoding="utf-8")
            _git("add", "f.txt")
            _git("commit", "-q", "-m", "two")

            out_dir = td_path / "out"
            runner = td_path / "run_codex.sh"
            _write_stub_runner(runner)
            with _chdir(repo), contextlib.redirect_stdout(io.StringIO()):
                rc = self.mod.main(
                    [
                        "--model",
                        "codex/default",
                        "--diff",
                        "HEAD~1..HEAD",
                        "--codex-runner",
                        str(runner),
                        "--out-dir",
                        str(out_dir),
                    ]
                )
            self.assertEqual(rc, 0)
            packet = (out_dir / "inputs" / "packet.md").read_text(encoding="utf-8")
            self.assertIn("=== DIFF (HEAD~1..HEAD)", packet)
            self.assertIn("+new marker line", packet)

            source = td_path / "source.tex"
            source.write_text("primary source\n", encoding="utf-8")
            source_out = td_path / "source_out"
            with _chdir(repo), contextlib.redirect_stdout(io.StringIO()):
                source_rc = self.mod.main(
                    [
                        "--model",
                        "codex/default",
                        "--diff",
                        "HEAD~1..HEAD",
                        "--role",
                        "source-fidelity",
                        "--source",
                        str(source),
                        "--source-text-origin",
                        "direct-original-text",
                        "--correction-status",
                        "not-applicable",
                        "--codex-runner",
                        str(runner),
                        "--out-dir",
                        str(source_out),
                    ]
                )
            self.assertEqual(source_rc, 0)
            manifest = json.loads(
                (source_out / "inputs" / "source_fidelity_manifest.json").read_text(
                    encoding="utf-8"
                )
            )
            self.assertEqual(manifest["target_diff_range"], "HEAD~1..HEAD")
            self.assertEqual(len(manifest["target_diff_sha256"]), 64)
            self.assertEqual(
                manifest["target_diff_sha256"],
                manifest["target_diff_embedded_text_sha256"],
            )
            self.assertGreater(manifest["target_diff_bytes"], 0)

    def test_diff_value_starting_with_dash_is_rejected(self):
        # Injection guard: a --diff value with a leading "-" would be read by
        # git as an option (e.g. --output=PATH writes a file), not a revision
        # range. It must be refused before git ever runs.
        with tempfile.TemporaryDirectory() as td:
            td_path = Path(td)
            out_dir = td_path / "out"
            injected = td_path / "pwned.txt"
            runner = td_path / "run_codex.sh"
            _write_stub_runner(runner)

            stderr = io.StringIO()
            with contextlib.redirect_stderr(stderr), contextlib.redirect_stdout(io.StringIO()):
                rc = self.mod.main(
                    [
                        "--model",
                        "codex/default",
                        f"--diff=--output={injected}",
                        "--codex-runner",
                        str(runner),
                        "--out-dir",
                        str(out_dir),
                    ]
                )
            self.assertEqual(rc, 2)
            message = stderr.getvalue()
            self.assertIn("git option", message)
            self.assertIn("starts with '-'", message)
            # git never ran: no option-injected file, no delegation, no meta.
            self.assertFalse(injected.exists())
            self.assertFalse((out_dir / "meta.json").exists())

    def test_empty_output_retried_once_via_delegated_launcher(self):
        # review_one passes --retry-empty-output 1 explicitly (the launcher
        # default is 0): a runner that recovers on its second call must yield a
        # successful single-reviewer run with one recorded retry.
        with tempfile.TemporaryDirectory() as td:
            td_path = Path(td)
            out_dir = td_path / "out"
            artifact = td_path / "artifact.md"
            artifact.write_text("content\n", encoding="utf-8")
            runner = td_path / "run_codex.sh"
            _write_empty_then_valid_runner(runner, td_path / "state")

            with contextlib.redirect_stdout(io.StringIO()):
                rc = self.mod.main(
                    [
                        "--model",
                        "codex/default",
                        "--artifact",
                        str(artifact),
                        "--codex-runner",
                        str(runner),
                        "--out-dir",
                        str(out_dir),
                    ]
                )
            self.assertEqual(rc, 0)
            meta = json.loads((out_dir / "meta.json").read_text(encoding="utf-8"))
            agent = meta["agents"][0]
            self.assertTrue(agent["success"])
            self.assertEqual(agent["empty_output_retries"], 1)
            events = _read_trace_events(out_dir / "trace.jsonl")
            self.assertEqual(
                len([e for e in events if e.get("event") == "empty_output_retry"]), 1
            )

    def test_project_config_suppressed_by_default_and_optable(self):
        with tempfile.TemporaryDirectory() as td:
            td_path = Path(td)
            project = td_path / "project"
            (project / ".git").mkdir(parents=True)
            cfg_dir = project / ".nullius"
            cfg_dir.mkdir()
            # A config that would make any run fail its prompt-size guard: only
            # loaded when --use-project-config re-enables auto-discovery.
            (cfg_dir / "review-swarm.json").write_text(
                json.dumps({"max_prompt_bytes": 10}), encoding="utf-8"
            )
            artifact = td_path / "artifact.md"
            artifact.write_text("content\n", encoding="utf-8")
            runner = td_path / "run_codex.sh"
            _write_stub_runner(runner)

            common = [
                "--model",
                "codex/default",
                "--artifact",
                str(artifact),
                "--codex-runner",
                str(runner),
            ]
            with _temp_env(REVIEW_SWARM_NO_AUTO_CONFIG=None), _chdir(project):
                with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
                    rc_default = self.mod.main([*common, "--out-dir", str(td_path / "out_default")])
                    rc_opt_in = self.mod.main(
                        [*common, "--out-dir", str(td_path / "out_optin"), "--use-project-config"]
                    )
                env_leaked = "REVIEW_SWARM_NO_AUTO_CONFIG" in os.environ
            # Default: hermetic (config ignored) -> success.
            self.assertEqual(rc_default, 0)
            # Opt-in: config's 10-byte guard applies inside the launcher -> failure.
            self.assertEqual(rc_opt_in, 2)
            # And the default run must not leave the suppression env behind.
            self.assertFalse(env_leaked)

    def test_use_project_config_overrides_inherited_suppression_env(self):
        # If the caller's environment already carries REVIEW_SWARM_NO_AUTO_CONFIG=1
        # (as this test class itself does), --use-project-config must still win:
        # the variable is removed for the delegated run and restored afterward.
        with tempfile.TemporaryDirectory() as td:
            td_path = Path(td)
            project = td_path / "project"
            (project / ".git").mkdir(parents=True)
            cfg_dir = project / ".nullius"
            cfg_dir.mkdir()
            # Only visible to the launcher when auto-discovery is truly re-enabled.
            (cfg_dir / "review-swarm.json").write_text(
                json.dumps({"max_prompt_bytes": 10}), encoding="utf-8"
            )
            artifact = td_path / "artifact.md"
            artifact.write_text("content\n", encoding="utf-8")
            runner = td_path / "run_codex.sh"
            _write_stub_runner(runner)

            with _temp_env(REVIEW_SWARM_NO_AUTO_CONFIG="1"), _chdir(project):
                with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
                    rc_opt_in = self.mod.main(
                        [
                            "--model",
                            "codex/default",
                            "--artifact",
                            str(artifact),
                            "--codex-runner",
                            str(runner),
                            "--out-dir",
                            str(td_path / "out"),
                            "--use-project-config",
                        ]
                    )
                env_after = os.environ.get("REVIEW_SWARM_NO_AUTO_CONFIG")
            # Config's 10-byte guard applied inside the launcher -> failure,
            # proving the inherited suppression was cleared for the child run.
            self.assertEqual(rc_opt_in, 2)
            # The caller's prior value is restored afterward.
            self.assertEqual(env_after, "1")


if __name__ == "__main__":
    unittest.main()
