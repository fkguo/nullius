import unittest
from pathlib import Path


def _src_root() -> Path:
    return Path(__file__).resolve().parents[1] / "src"


class TestLiteratureSurvey(unittest.TestCase):
    def test_bib_contains_standard_entry_types(self) -> None:
        import sys

        sys.path.insert(0, str(_src_root()))
        from hep_autoresearch.toolkit.literature_survey import build_literature_survey

        repo_root = Path(__file__).resolve().parents[1]
        survey, _, bib_text, tex_text = build_literature_survey(
            repo_root=repo_root,
            refkeys=["recid-3112995-madagants", "arxiv-2512.19799-physmaster"],
            topic="test",
        )
        self.assertEqual(survey["stats"]["total_entries"], 2)
        self.assertIn("@article{Plehn:2026gxv", bib_text)
        self.assertIn("@article{arxiv-2512.19799-physmaster", bib_text)
        self.assertIn("\\cite{Plehn:2026gxv}", tex_text)

    def test_escapers_are_deterministic(self) -> None:
        import sys

        sys.path.insert(0, str(_src_root()))
        from hep_autoresearch.toolkit.literature_survey import _escape_latex, _md_escape_cell

        out = _escape_latex("a_b%{c}\\d&$#~^\n")
        self.assertIn(r"\_", out)
        self.assertIn(r"\%", out)
        self.assertIn(r"\{", out)
        self.assertIn(r"\}", out)
        self.assertIn(r"\textbackslash{}", out)
        self.assertIn(r"\&", out)
        self.assertIn(r"\$", out)
        self.assertIn(r"\#", out)
        self.assertIn(r"\textasciitilde{}", out)
        self.assertIn(r"\textasciicircum{}", out)
        self.assertNotIn("\n", out)

        md = _md_escape_cell("a|b\nc`d[e]")
        self.assertIn(r"\|", md)
        self.assertNotIn("\n", md)
        self.assertIn(r"\`", md)
        self.assertIn(r"\[", md)
        self.assertIn(r"\]", md)

    def test_survey_json_schema_validation_smoke(self) -> None:
        import json
        import sys

        sys.path.insert(0, str(_src_root()))
        from hep_autoresearch.toolkit.evals import _schema_for_json_path, _schema_validate
        from hep_autoresearch.toolkit.literature_survey import build_literature_survey

        repo_root = Path(__file__).resolve().parents[1]
        schema_path = repo_root / "specs" / "literature_survey.schema.json"
        schema = json.loads(schema_path.read_text(encoding="utf-8"))

        survey, _, _, _ = build_literature_survey(
            repo_root=repo_root,
            refkeys=["recid-3112995-madagants", "arxiv-2512.19799-physmaster"],
            topic="test",
        )
        errors = _schema_validate(survey, schema, "survey", root_schema=schema)
        self.assertEqual(errors, [])

        mapped = _schema_for_json_path(repo_root, "artifacts/runs/TEST/literature_survey/survey.json")
        self.assertEqual(mapped, schema_path)
