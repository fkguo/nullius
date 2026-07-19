import importlib.util
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

SCRIPT_PATH = (
    Path(__file__).resolve().parents[1] / "scripts" / "bin" / "triangulate_citation.py"
)


def _load_module():
    spec = importlib.util.spec_from_file_location("triangulate_citation", SCRIPT_PATH)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"Failed to load module spec: {SCRIPT_PATH}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


MOD = _load_module()


def _block(provider, **overrides):
    base = {
        "provider": provider,
        "title": None,
        "authors": None,
        "year": None,
        "doi": None,
        "venue": None,
        "identifier": None,
    }
    base.update(overrides)
    return base


def _write_json(directory, name, payload):
    path = Path(directory) / name
    path.write_text(json.dumps(payload), encoding="utf-8")
    return str(path)


class TitleNormalizationTests(unittest.TestCase):
    def test_latex_greek_matches_unicode_greek(self):
        latex = MOD.fold_text(r"Study of the $\alpha$ decay").replace(" ", "")
        unicode_form = MOD.fold_text("Study of the α decay").replace(" ", "")
        self.assertEqual(latex, unicode_form)

    def test_latex_superscript_matches_unicode_superscript(self):
        latex = MOD.fold_text(r"Search in $^{212}$Po decays").replace(" ", "")
        unicode_form = MOD.fold_text("Search in ²¹²Po decays").replace(" ", "")
        self.assertEqual(latex, unicode_form)

    def test_latex_accent_matches_unicode_accent(self):
        latex = MOD.fold_text(r"M\o ller scattering and Schr\"odinger dynamics")
        unicode_form = MOD.fold_text("Møller scattering and Schrödinger dynamics")
        self.assertEqual(latex, unicode_form)

    def test_case_whitespace_and_dashes_fold(self):
        first = MOD.fold_text("Electron--Positron  Annihilation")
        second = MOD.fold_text("electron–positron annihilation")
        self.assertEqual(first, second)

    def test_math_wrappers_are_dropped(self):
        wrapped = MOD.fold_text(r"The $\mathrm{X}(3872)$ state")
        plain = MOD.fold_text("The X(3872) state")
        self.assertEqual(wrapped, plain)

    def test_latex_subscript_matches_unicode_subscript(self):
        latex = MOD.fold_text(r"Properties of H$_{2}$O clusters").replace(" ", "")
        unicode_form = MOD.fold_text("Properties of H₂O clusters").replace(" ", "")
        self.assertEqual(latex, unicode_form)

    def test_empty_after_folding_is_empty_string(self):
        self.assertEqual(MOD.fold_text("$~{}$"), "")


class AuthorNormalizationTests(unittest.TestCase):
    def test_comma_and_natural_order_agree(self):
        self.assertEqual(
            MOD.extract_family_name("Smith, John"),
            MOD.extract_family_name("John Smith"),
        )

    def test_initials_and_full_given_names_agree(self):
        self.assertEqual(
            MOD.extract_family_name("J. A. Smith"),
            MOD.extract_family_name("John Albert Smith"),
        )

    def test_particles_fold_into_family(self):
        self.assertEqual(
            MOD.extract_family_name("Johannes van der Waals"),
            MOD.extract_family_name("van der Waals, Johannes"),
        )
        self.assertEqual(MOD.extract_family_name("Johannes van der Waals"), "vanderwaals")

    def test_bare_particle_family_is_kept_whole(self):
        # A lowercase particle head on a bare name marks a family name, so
        # family-only provider records agree with given-name records.
        for spelling in ("de Groot", "A. de Groot", "de Groot, A.", "Anna de Groot"):
            self.assertEqual(MOD.extract_family_name(spelling), "degroot", spelling)
        for spelling in ("von Neumann", "J. von Neumann", "von Neumann, John"):
            self.assertEqual(MOD.extract_family_name(spelling), "vonneumann", spelling)
        for spelling in ("van't Hoff", "J. van't Hoff", "van't Hoff, J.", "van 't Hoff"):
            self.assertEqual(MOD.extract_family_name(spelling), "vanthoff", spelling)

    def test_capitalized_particle_head_reads_as_given_name(self):
        # "Van" here is a given name, not a particle prefix of the family.
        self.assertEqual(MOD.extract_family_name("Van Morrison"), "morrison")
        self.assertEqual(
            MOD.extract_family_name("Van Morrison"),
            MOD.extract_family_name("Morrison, Van"),
        )

    def test_accented_family_matches_latex_family(self):
        self.assertEqual(
            MOD.extract_family_name(r"Schr\"odinger, Erwin"),
            MOD.extract_family_name("Erwin Schrödinger"),
        )

    def test_suffix_is_dropped_in_natural_order(self):
        self.assertEqual(MOD.extract_family_name("Martin Smith Jr."), "smith")

    def test_suffix_is_dropped_across_all_comma_forms(self):
        # "John Smith, Jr." is a natural-order name whose comma introduces a
        # suffix, "Smith Jr., John" is a comma form whose family part carries
        # the suffix, and "Smith, John, Jr." is a three-segment comma form.
        # All must agree with the plain forms.
        for spelling in (
            "Smith, John",
            "John Smith",
            "John Smith Jr.",
            "John Smith, Jr.",
            "Smith Jr., John",
            "Smith, John, Jr.",
            "SMITH, JOHN, JR",
        ):
            self.assertEqual(MOD.extract_family_name(spelling), "smith", spelling)

    def test_initials_only_difference_is_tolerated_by_design(self):
        # Documented limitation: family-name comparison cannot distinguish
        # two different people sharing a family name and position ("J. Smith"
        # versus "B. Smith"); the raw author rows in the report carry the
        # given names for human inspection.
        self.assertEqual(
            MOD.extract_family_name("J. Smith"),
            MOD.extract_family_name("B. Smith"),
        )


class DoiNormalizationTests(unittest.TestCase):
    def test_url_prefix_and_case_fold(self):
        self.assertEqual(
            MOD.normalize_doi("https://doi.org/10.1103/PhysRevD.104.114034"),
            MOD.normalize_doi("10.1103/physrevd.104.114034"),
        )

    def test_doi_scheme_prefix_and_trailing_dot(self):
        self.assertEqual(
            MOD.normalize_doi("doi:10.1000/ABC.123."),
            "10.1000/abc.123",
        )

    def test_url_query_and_fragment_are_transport_artifacts(self):
        self.assertEqual(
            MOD.normalize_doi("https://doi.org/10.1000/ABC?utm_source=x#frag"),
            "10.1000/abc",
        )

    def test_url_percent_encoding_is_decoded(self):
        self.assertEqual(
            MOD.normalize_doi("https://doi.org/10.1002/%28SICI%291234"),
            "10.1002/(sici)1234",
        )

    def test_bare_doi_form_keeps_question_mark(self):
        # Query stripping applies to URL forms only: a rare DOI name may
        # itself contain "?" and the doi: form is not a URL.
        self.assertEqual(MOD.normalize_doi("doi:10.1000/a?b"), "10.1000/a?b")

    def test_trailing_copy_paste_punctuation_is_stripped(self):
        self.assertEqual(MOD.normalize_doi("10.1000/xyz;"), "10.1000/xyz")

    def test_preprint_registry_version_suffix_folds(self):
        # The preprint registry's DataCite DOIs are version-agnostic: the
        # versioned and unversioned spellings denote the same work.
        self.assertEqual(
            MOD.normalize_doi("10.48550/arXiv.2109.01038v2"),
            MOD.normalize_doi("10.48550/arxiv.2109.01038"),
        )
        self.assertEqual(
            MOD.normalize_doi("https://doi.org/10.48550/arXiv.2109.01038v1"),
            "10.48550/arxiv.2109.01038",
        )
        self.assertEqual(
            MOD.normalize_doi("10.48550/arXiv.hep-ph/9901234v3"),
            MOD.normalize_doi("10.48550/arxiv.hep-ph/9901234"),
        )
        self.assertEqual(
            MOD.normalize_doi("10.48550/arXiv.2109.01038v12."),
            "10.48550/arxiv.2109.01038",
        )

    def test_version_folding_never_merges_distinct_ids(self):
        # Negative controls: folding must not make genuinely different
        # identifiers compare equal.
        self.assertNotEqual(
            MOD.normalize_doi("10.48550/arxiv.2109.01038v2"),
            MOD.normalize_doi("10.48550/arxiv.2109.01039"),
        )
        self.assertNotEqual(
            MOD.normalize_doi("10.48550/arxiv.2109.01038"),
            MOD.normalize_doi("10.48550/arxiv.2109.0103"),
        )

    def test_version_suffix_outside_preprint_registry_is_kept(self):
        # Elsewhere a trailing "v" + digits can be a legitimate part of the
        # registered DOI name, so the fold is scoped to the preprint-registry
        # prefix and must not fire on other registrants.
        self.assertEqual(MOD.normalize_doi("10.1000/xyzv2"), "10.1000/xyzv2")
        self.assertNotEqual(
            MOD.normalize_doi("10.1000/xyzv2"), MOD.normalize_doi("10.1000/xyz")
        )
        self.assertEqual(
            MOD.normalize_doi("10.5555/collection.123.v2"),
            "10.5555/collection.123.v2",
        )

    def test_bare_version_only_suffix_is_not_folded(self):
        # A degenerate "id" that is nothing but a version marker is left
        # alone rather than folded to an empty identifier.
        self.assertEqual(
            MOD.normalize_doi("10.48550/arxiv.v2"), "10.48550/arxiv.v2"
        )


class VerdictTests(unittest.TestCase):
    def _report(self, blocks, citation_key=None):
        validated = [MOD._validate_block(block, "test") for block in blocks]
        return MOD.build_report(validated, citation_key)

    def test_consistent_two_providers(self):
        report = self._report(
            [
                _block(
                    "arxiv",
                    title=r"Study of the $\alpha$ decay",
                    authors=["J. Smith", "A. de Groot"],
                    year=2021,
                    doi="10.1103/PhysRevD.104.114034",
                ),
                _block(
                    "openalex",
                    title="Study of the α decay",
                    authors=["John Smith", "Anna De Groot"],
                    year=2021,
                    doi="https://doi.org/10.1103/physrevd.104.114034",
                ),
            ]
        )
        self.assertEqual(report["verdict"], "consistent")
        self.assertEqual(report["exit_code"], 0)
        for field in ("title", "authors", "year", "doi"):
            self.assertEqual(report["fields"][field]["status"], "agree")

    def test_year_off_by_one_is_conflicted(self):
        report = self._report(
            [
                _block("arxiv", title="Same title", year=2020),
                _block("openalex", title="Same title", year=2021),
            ]
        )
        self.assertEqual(report["fields"]["year"]["status"], "disagree")
        self.assertEqual(report["verdict"], "conflicted")
        self.assertEqual(report["exit_code"], 1)

    def test_author_count_mismatch_is_conflicted(self):
        report = self._report(
            [
                _block("arxiv", authors=["J. Smith", "B. Doe"], year=2021),
                _block("inspire", authors=["J. Smith"], year=2021),
            ]
        )
        self.assertEqual(report["fields"]["authors"]["status"], "disagree")
        self.assertEqual(report["verdict"], "conflicted")

    def test_single_provider_is_insufficient(self):
        report = self._report([_block("arxiv", title="Only one record", year=2020)])
        self.assertEqual(report["verdict"], "insufficient_sources")
        self.assertEqual(report["exit_code"], 2)

    def test_all_key_fields_missing_is_insufficient(self):
        report = self._report(
            [
                _block("arxiv", venue="Some venue"),
                _block("openalex", title="Only here"),
            ]
        )
        self.assertEqual(report["verdict"], "insufficient_sources")
        self.assertEqual(report["exit_code"], 2)

    def test_partial_missing_fields_still_consistent(self):
        report = self._report(
            [
                _block("arxiv", title="Same title", year=2021),
                _block("openalex", title="Same title", doi="10.1000/xyz"),
            ]
        )
        self.assertEqual(report["fields"]["title"]["status"], "agree")
        self.assertEqual(report["fields"]["year"]["status"], "missing")
        self.assertEqual(report["fields"]["doi"]["status"], "missing")
        self.assertEqual(report["verdict"], "consistent")

    def test_doi_version_variant_is_not_a_conflict(self):
        # A versioned preprint-registry DOI and its unversioned form are the
        # same identifier; records differing only in the version suffix must
        # not read as an identifier conflict.
        report = self._report(
            [
                _block(
                    "arxiv",
                    title="Same title",
                    doi="10.48550/arXiv.2109.01038v2",
                ),
                _block(
                    "openalex",
                    title="Same title",
                    doi="10.48550/arxiv.2109.01038",
                ),
            ]
        )
        self.assertEqual(report["fields"]["doi"]["status"], "agree")
        self.assertEqual(report["verdict"], "consistent")

    def test_different_preprint_ids_still_conflict(self):
        report = self._report(
            [
                _block(
                    "arxiv",
                    title="Same title",
                    doi="10.48550/arXiv.2109.01038v2",
                ),
                _block(
                    "openalex",
                    title="Same title",
                    doi="10.48550/arxiv.2109.01039",
                ),
            ]
        )
        self.assertEqual(report["fields"]["doi"]["status"], "disagree")
        self.assertEqual(report["verdict"], "conflicted")

    def test_venue_difference_never_conflicts(self):
        report = self._report(
            [
                _block("arxiv", title="Same title", year=2021, venue="Phys. Rev. D"),
                _block(
                    "openalex",
                    title="Same title",
                    year=2021,
                    venue="Physical Review D",
                ),
            ]
        )
        self.assertEqual(report["fields"]["venue"]["status"], "reported")
        self.assertEqual(report["verdict"], "consistent")

    def test_disagreement_pairs_are_named(self):
        report = self._report(
            [
                _block("arxiv", year=2020, title="Same title"),
                _block("openalex", year=2021, title="Same title"),
                _block("inspire", year=2020, title="Same title"),
            ]
        )
        pairs = report["fields"]["year"]["disagreements"]
        self.assertIn(["arxiv", "openalex"], pairs)
        self.assertIn(["openalex", "inspire"], pairs)


class ValidationTests(unittest.TestCase):
    def _expect_input_error(self, block, fragment):
        with self.assertRaises(MOD.InputError) as ctx:
            MOD._validate_block(block, "test")
        self.assertIn(fragment, str(ctx.exception))

    def test_missing_field_key_is_rejected(self):
        block = _block("arxiv")
        del block["doi"]
        self._expect_input_error(block, "missing provider-block keys")

    def test_unknown_field_key_is_rejected(self):
        block = _block("arxiv", extra="oops")
        self._expect_input_error(block, "unknown provider-block keys")

    def test_empty_provider_is_rejected(self):
        self._expect_input_error(_block("  "), "'provider'")

    def test_bad_year_type_is_rejected(self):
        self._expect_input_error(_block("arxiv", year=20.21), "'year'")
        self._expect_input_error(_block("arxiv", year=True), "'year'")
        self._expect_input_error(_block("arxiv", year="21"), "'year'")

    def test_year_string_is_coerced(self):
        validated = MOD._validate_block(_block("arxiv", year="2021"), "test")
        self.assertEqual(validated["year"], 2021)

    def test_non_doi_string_is_rejected(self):
        self._expect_input_error(
            _block("arxiv", doi="arXiv:2109.01038"), "does not look like a DOI"
        )

    def test_empty_author_list_is_rejected(self):
        self._expect_input_error(_block("arxiv", authors=[]), "'authors'")

    def test_non_string_author_is_rejected(self):
        self._expect_input_error(_block("arxiv", authors=["Ok Name", 7]), "authors[1]")

    def test_duplicate_provider_is_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = _write_json(
                tmp,
                "dup.json",
                [_block("arxiv", year=2021), _block("ArXiv", year=2021)],
            )
            with self.assertRaises(MOD.InputError) as ctx:
                MOD.load_provider_blocks([path])
            self.assertIn("duplicate provider", str(ctx.exception))

    def test_conflicting_citation_keys_are_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            first = _write_json(
                tmp,
                "a.json",
                {"citation_key": "smith2021", "providers": [_block("arxiv", year=2021)]},
            )
            second = _write_json(
                tmp,
                "b.json",
                {"citation_key": "doe2020", "providers": [_block("openalex", year=2021)]},
            )
            with self.assertRaises(MOD.InputError) as ctx:
                MOD.load_provider_blocks([first, second])
            self.assertIn("conflicting citation_key", str(ctx.exception))

    def test_unknown_container_key_is_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = _write_json(
                tmp,
                "c.json",
                {"providers": [_block("arxiv")], "extra": 1},
            )
            with self.assertRaises(MOD.InputError) as ctx:
                MOD.load_provider_blocks([path])
            self.assertIn("unknown container keys", str(ctx.exception))

    def test_empty_providers_list_is_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = _write_json(tmp, "empty.json", {"providers": []})
            with self.assertRaises(MOD.InputError) as ctx:
                MOD.load_provider_blocks([path])
            self.assertIn("non-empty list", str(ctx.exception))

    def test_title_normalizing_to_empty_is_rejected(self):
        self._expect_input_error(
            _block("arxiv", title="$~{}$"), "normalizes to an empty string"
        )


class CliTests(unittest.TestCase):
    def _run(self, arguments, cwd):
        return subprocess.run(
            [sys.executable, str(SCRIPT_PATH)] + arguments,
            capture_output=True,
            text=True,
            cwd=cwd,
        )

    def test_consistent_run_exit_zero_and_reports_written(self):
        with tempfile.TemporaryDirectory() as tmp:
            arxiv = _write_json(
                tmp,
                "arxiv.json",
                _block(
                    "arxiv",
                    title="A shared title",
                    authors=["J. Smith"],
                    year=2021,
                    doi="10.1000/xyz123",
                ),
            )
            openalex = _write_json(
                tmp,
                "openalex.json",
                _block(
                    "openalex",
                    title="A Shared Title",
                    authors=["John Smith"],
                    year=2021,
                    doi="HTTPS://DOI.ORG/10.1000/XYZ123",
                ),
            )
            out_json = os.path.join(tmp, "out", "report.json")
            out_md = os.path.join(tmp, "out", "report.md")
            result = self._run(
                [
                    arxiv,
                    openalex,
                    "--citation-key",
                    "smith2021",
                    "--out-json",
                    out_json,
                    "--out-md",
                    out_md,
                ],
                cwd=tmp,
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn("verdict [smith2021]: consistent", result.stdout)

            report = json.loads(Path(out_json).read_text(encoding="utf-8"))
            self.assertEqual(report["verdict"], "consistent")
            self.assertEqual(report["citation_key"], "smith2021")
            self.assertEqual(report["exit_code"], 0)

            markdown = Path(out_md).read_text(encoding="utf-8")
            self.assertIn("consistent", markdown)
            self.assertIn("| title |", markdown)

            leftovers = [
                name
                for name in os.listdir(os.path.join(tmp, "out"))
                if name.startswith(".tmp-")
            ]
            self.assertEqual(leftovers, [])

    def test_conflicted_run_exit_one(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = _write_json(
                tmp,
                "both.json",
                {
                    "citation_key": "smith2021",
                    "providers": [
                        _block("arxiv", title="Same title", year=2020),
                        _block("openalex", title="Same title", year=2021),
                    ],
                },
            )
            result = self._run([path], cwd=tmp)
            self.assertEqual(result.returncode, 1)
            self.assertIn("conflicted", result.stdout)

    def test_single_provider_exit_two(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = _write_json(tmp, "one.json", _block("arxiv", year=2021))
            result = self._run([path], cwd=tmp)
            self.assertEqual(result.returncode, 2)
            self.assertIn("insufficient_sources", result.stdout)

    def test_invalid_json_exit_three(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "broken.json"
            path.write_text("{not json", encoding="utf-8")
            result = self._run([str(path)], cwd=tmp)
            self.assertEqual(result.returncode, 3)
            self.assertIn("invalid JSON", result.stderr)

    def test_missing_file_exit_three(self):
        with tempfile.TemporaryDirectory() as tmp:
            result = self._run([os.path.join(tmp, "absent.json")], cwd=tmp)
            self.assertEqual(result.returncode, 3)
            self.assertIn("cannot read input file", result.stderr)

    def test_schema_error_exit_three_and_no_outputs(self):
        with tempfile.TemporaryDirectory() as tmp:
            block = _block("arxiv", year=2021)
            del block["title"]
            path = _write_json(tmp, "bad.json", block)
            out_json = os.path.join(tmp, "report.json")
            result = self._run([path, "--out-json", out_json], cwd=tmp)
            self.assertEqual(result.returncode, 3)
            self.assertFalse(os.path.exists(out_json))

    def test_unwritable_report_path_exit_four(self):
        # An unusable output path must not surface a verdict exit code:
        # rc=1 would read as "conflicted" to automation.
        with tempfile.TemporaryDirectory() as tmp:
            path = _write_json(
                tmp,
                "both.json",
                [
                    _block("arxiv", title="Same title", year=2021),
                    _block("openalex", title="Same title", year=2021),
                ],
            )
            blocker = Path(tmp) / "not-a-dir"
            blocker.write_text("occupied", encoding="utf-8")
            out_json = os.path.join(str(blocker), "report.json")
            result = self._run([path, "--out-json", out_json], cwd=tmp)
            self.assertEqual(result.returncode, 4)
            self.assertIn("cannot write report", result.stderr)

    def test_quiet_flag_prints_only_verdict_line(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = _write_json(
                tmp,
                "both.json",
                [
                    _block("arxiv", title="Same title", year=2021),
                    _block("openalex", title="Same title", year=2021),
                ],
            )
            result = self._run([path, "--quiet"], cwd=tmp)
            self.assertEqual(result.returncode, 0)
            lines = [line for line in result.stdout.splitlines() if line.strip()]
            self.assertEqual(lines, ["verdict: consistent"])

    def test_markdown_pipes_are_escaped(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = _write_json(
                tmp,
                "both.json",
                [
                    _block("ar|xiv", title="A | B", year=2021),
                    _block("openalex", title="A | B", year=2021),
                ],
            )
            out_md = os.path.join(tmp, "report.md")
            result = self._run([path, "--out-md", out_md], cwd=tmp)
            self.assertEqual(result.returncode, 0)
            markdown = Path(out_md).read_text(encoding="utf-8")
            self.assertIn("ar\\|xiv", markdown)
            self.assertIn("A \\| B", markdown)


if __name__ == "__main__":
    unittest.main()
