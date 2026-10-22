import importlib.util
import unittest
from pathlib import Path


_SKILLS_ROOT = Path(__file__).resolve().parents[2]


def _integrity_text() -> str:
    """research-integrity SKILL.md plus the reference file holding the extraction /
    transcription fidelity section that was moved out of it."""
    root = _SKILLS_ROOT / "research-integrity"
    return "\n".join(
        (root / rel).read_text(encoding="utf-8")
        for rel in ("SKILL.md", "references/transcription-fidelity.md")
    )


class SourceErrorProtocolTests(unittest.TestCase):
    def test_two_track_protocol_is_pinned_across_skills(self):
        extraction = (
            _SKILLS_ROOT / "review-swarm" / "templates" / "source-extraction.md"
        ).read_text(encoding="utf-8")
        fidelity = (
            _SKILLS_ROOT / "review-swarm" / "templates" / "source-fidelity.md"
        ).read_text(encoding="utf-8")
        reader_path = _SKILLS_ROOT.parent / "scripts" / "lib" / "instruction_documents.py"
        reader_spec = importlib.util.spec_from_file_location("instruction_documents", reader_path)
        reader = importlib.util.module_from_spec(reader_spec)
        reader_spec.loader.exec_module(reader)
        review_skill = reader.read_instruction_documents(_SKILLS_ROOT / "review-swarm" / "SKILL.md")
        integrity = _integrity_text()
        derivation = (_SKILLS_ROOT / "derivation-verify" / "SKILL.md").read_text(
            encoding="utf-8"
        )
        ledger = (
            _SKILLS_ROOT / "deep-literature-review" / "templates" / "extraction-ledger.md"
        ).read_text(encoding="utf-8")

        for text in (extraction, fidelity, review_skill, integrity, ledger):
            self.assertIn("PRINTED_FORM", text)
            self.assertIn("SCIENTIFIC_STATUS", text)
            self.assertIn("PROPOSED_CORRECTION", text)
        self.assertIn("source-error laundering", fidelity)
        self.assertIn("(n) stale review verdict", integrity)
        self.assertIn("(o) source-error laundering", integrity)
        self.assertIn("Literal source text:", ledger)
        self.assertIn("never overwrite `PRINTED_FORM`", ledger)
        self.assertIn("distinct from", review_skill)
        self.assertIn("downstream consequences", review_skill)
        self.assertIn("circular confirmation", derivation)
        self.assertIn("fresh\n  `PROPOSED_CORRECTION`", derivation)
        self.assertIn("do not adopt it silently", derivation)
        deep_review = (_SKILLS_ROOT / "deep-literature-review" / "SKILL.md").read_text(
            encoding="utf-8"
        )
        self.assertIn("(n) stale review verdict", deep_review)
        self.assertIn("(o) source-error laundering", deep_review)
        self.assertIn("withholding both the disputed printed expression", derivation)
        self.assertIn("independently_supported_correction", derivation)
        self.assertIn("unresolved_source_error", derivation)

    def test_no_erratum_does_not_certify_printed_correctness(self):
        extraction = (
            _SKILLS_ROOT / "review-swarm" / "templates" / "source-extraction.md"
        ).read_text(encoding="utf-8")
        fidelity = (
            _SKILLS_ROOT / "review-swarm" / "templates" / "source-fidelity.md"
        ).read_text(encoding="utf-8")
        self.assertIn("checked-none-found", extraction)
        self.assertIn("does not certify", extraction)
        self.assertIn("checked-none-found", fidelity)
        self.assertIn("not evidence", fidelity)

    def test_inferred_correction_cannot_masquerade_as_published_or_author_confirmed(self):
        derivation = (_SKILLS_ROOT / "derivation-verify" / "SKILL.md").read_text(
            encoding="utf-8"
        )
        self.assertIn("not `published_correction`", derivation)
        self.assertIn("`author_confirmed_correction`", derivation)

    def test_empirical_items_require_reproduction_not_repetition(self):
        fidelity = (
            _SKILLS_ROOT / "review-swarm" / "templates" / "source-fidelity.md"
        ).read_text(encoding="utf-8")
        integrity = _integrity_text()
        self.assertIn("underlying data", fidelity)
        self.assertIn("merely repeats the value", fidelity)
        self.assertIn("cannot be derived", integrity)
        self.assertIn("A later source that simply repeats", integrity)
        self.assertIn("independent reproduction", integrity)

    def test_non_derivable_items_cannot_be_settled_by_repetition(self):
        fidelity = (
            _SKILLS_ROOT / "review-swarm" / "templates" / "source-fidelity.md"
        ).read_text(encoding="utf-8")
        integrity = _integrity_text()
        ledger = (
            _SKILLS_ROOT / "deep-literature-review" / "templates" / "extraction-ledger.md"
        ).read_text(encoding="utf-8")
        for text in (fidelity, integrity):
            self.assertIn("non-derivable convention", text)
            self.assertIn("citation count", text)
        self.assertIn("non-derivable-convention-or-prose", ledger)


if __name__ == "__main__":
    unittest.main()
