#!/usr/bin/env python3
"""Deterministic cross-index agreement check for one citation's metadata.

The agent fetches canonical metadata for the SAME cited work from two or more
bibliographic indexes (providers), writes each provider's record as a JSON
block conforming to the provider-block schema below, and runs this script.
The script is fully offline: it performs no network calls and compares only
the JSON it is given, so a run is reproducible from its input files.

Input forms (one or more positional JSON files; blocks are concatenated):
  - a single provider-block object,
  - a list of provider-block objects,
  - an object {"citation_key": <str|null>, "providers": [<block>, ...]}.

Provider block (v1). Every metadata field key MUST be present; a value the
provider does not supply MUST be an explicit null (never an absent key):

    {
      "provider": "arxiv",                # non-empty, unique per run
      "title": "..." | null,
      "authors": ["Family, Given", ...] | null,
      "year": 2021 | null,
      "doi": "10.1103/..." | null,
      "venue": "..." | null,              # report-only, never in verdict
      "identifier": "2109.01038" | null   # provider-native id, report-only
    }

Comparison (key fields: title, authors, year, doi):
  - title: case folding plus common LaTeX <-> Unicode symbol folding
    (accents, greek letters, dashes, math wrappers); the comparison is
    whitespace-insensitive (token boundaries differ between LaTeX markup
    and Unicode spellings, e.g. superscripts), so the normalized form is
    the concatenated token stream.
  - authors: author count plus ordered family-name sequence; given-name
    initials versus full given names are tolerated by design.
  - year: integer equality.
  - doi: case-insensitive equality after stripping URL/doi: prefixes; URL
    forms additionally lose their query/fragment tail and percent-encoding.
  - venue, identifier: reported for the human reader only; indexes disagree
    on venue naming conventions too often for venue to carry a verdict.

Per-field status: agree / disagree / missing (fewer than two providers
supplied a comparable value). Verdict:
  - consistent           all key fields free of disagreement, at least two
                         providers, and at least one key field agreeing;
  - conflicted           at least one key field disagrees;
  - insufficient_sources fewer than two providers, or no key field has two
                         comparable values.

Exit codes (fail-closed for pipeline use):
  0 consistent, 1 conflicted, 2 insufficient_sources, 3 invalid input/usage,
  4 report write failure (at least one report was not persisted).

Outputs: a JSON report and a Markdown report (both written atomically via
temp-file + rename), plus a one-line verdict on stdout.
"""

from __future__ import annotations

import argparse
import datetime as _dt
import json
import os
import re
import sys
import tempfile
import unicodedata
import urllib.parse
from typing import Any, Dict, List, Optional, Sequence, Tuple

TRIANGULATION_REPORT_VERSION = 1

KEY_FIELDS = ("title", "authors", "year", "doi")
REPORT_ONLY_FIELDS = ("venue", "identifier")
METADATA_FIELDS = KEY_FIELDS + REPORT_ONLY_FIELDS
BLOCK_KEYS = ("provider",) + METADATA_FIELDS

EXIT_CONSISTENT = 0
EXIT_CONFLICTED = 1
EXIT_INSUFFICIENT = 2
EXIT_INVALID_INPUT = 3
EXIT_WRITE_FAILURE = 4

VERDICT_EXIT_CODES = {
    "consistent": EXIT_CONSISTENT,
    "conflicted": EXIT_CONFLICTED,
    "insufficient_sources": EXIT_INSUFFICIENT,
}


class InputError(ValueError):
    """Raised for any malformed input file or provider block."""


# ---------------------------------------------------------------------------
# Normalization tables
# ---------------------------------------------------------------------------

# Canonical alphanumeric tokens shared by the LaTeX command spelling and the
# Unicode character spelling of the same symbol, so `$\alpha$` and the
# character alpha normalize identically.
_GREEK_NAMES = (
    "alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu "
    "xi omicron pi rho sigma tau upsilon phi chi psi omega"
).split()

_GREEK_LOWER = "αβγδεζηθικλμνξοπρστυφχψω"
_GREEK_UPPER = "ΑΒΓΔΕΖΗΘΙΚΛΜΝΞΟΠΡΣΤΥΦΧΨΩ"

# char -> token
_UNICODE_TOKEN_MAP: Dict[str, str] = {}
for _name, _lower, _upper in zip(_GREEK_NAMES, _GREEK_LOWER, _GREEK_UPPER):
    _UNICODE_TOKEN_MAP[_lower] = _name
    _UNICODE_TOKEN_MAP[_upper] = _name
_UNICODE_TOKEN_MAP.update(
    {
        "ς": "sigma",  # final sigma
        "ϵ": "epsilon",
        "ϑ": "theta",
        "ϕ": "phi",
        "ϱ": "rho",
        "±": "pm",
        "∓": "mp",
        "×": "times",
        "→": "to",
        "←": "from",
        "↔": "to",
        "′": "prime",
        "″": "prime prime",
        "†": "dagger",
        "‡": "ddagger",
        "√": "sqrt",
        "∗": "star",
        "★": "star",
        "☆": "star",
        "ℏ": "hbar",
        "ħ": "hbar",
        "∞": "infty",
        "°": "deg",
    }
)

# LaTeX command name -> token (matched as \name with a word boundary)
_LATEX_TOKEN_MAP: Dict[str, str] = {name: name for name in _GREEK_NAMES}
_LATEX_TOKEN_MAP.update({name.capitalize(): name for name in _GREEK_NAMES})
_LATEX_TOKEN_MAP.update(
    {
        "varepsilon": "epsilon",
        "vartheta": "theta",
        "varphi": "phi",
        "varrho": "rho",
        "varsigma": "sigma",
        "pm": "pm",
        "mp": "mp",
        "times": "times",
        "to": "to",
        "rightarrow": "to",
        "leftarrow": "from",
        "leftrightarrow": "to",
        "prime": "prime",
        "dagger": "dagger",
        "ddagger": "ddagger",
        "sqrt": "sqrt",
        "star": "star",
        "ast": "star",
        "hbar": "hbar",
        "infty": "infty",
        "degree": "deg",
    }
)

# LaTeX special-letter commands -> plain text (both cases where they exist).
_LATEX_LETTER_MAP = {
    "o": "o",
    "O": "o",
    "l": "l",
    "L": "l",
    "ss": "ss",
    "ae": "ae",
    "AE": "ae",
    "oe": "oe",
    "OE": "oe",
    "aa": "a",
    "AA": "a",
    "i": "i",
    "j": "j",
}

# Latin characters that NFKD does not decompose to ASCII.
_LATIN_FOLD_MAP = {
    "æ": "ae",
    "Æ": "ae",
    "œ": "oe",
    "Œ": "oe",
    "ø": "o",
    "Ø": "o",
    "đ": "d",
    "Đ": "d",
    "ł": "l",
    "Ł": "l",
    "ð": "d",
    "Ð": "d",
    "þ": "th",
    "Þ": "th",
}

# Style/decoration commands whose argument text is kept and whose command
# token is simply dropped ({} braces are stripped later).
_LATEX_DROP_COMMANDS = (
    "text texttt textrm textit textbf textsc textsl textup textnormal emph "
    "mathrm mathbf mathit mathcal mathsf mathtt mathbb mathfrak bm boldsymbol "
    "bar hat tilde vec dot ddot breve check acute grave mathring overline "
    "underline widetilde widehat operatorname mbox hbox ensuremath rm bf it "
    "sf tt sc sl em cal frak left right big Big bigg Bigg"
).split()

# \'e, \"o, \^a, \`e, \~n, \=o, \.z  (optionally braced argument)
_RE_ACCENT_PUNCT = re.compile(r"\\([`'\"^~=.])\s*\{?\s*([a-zA-Z])\s*\}?")
# \v{s}, \c{c}, \u{g}, \H{o}, \k{a}, \b{o}, \d{u}, \r{a}, \t{oo} (braced)
_RE_ACCENT_LETTER_BRACED = re.compile(r"\\([uvHckbdrt])\s*\{\s*([a-zA-Z]{0,2})\s*\}")
# \v s (space-separated single letter)
_RE_ACCENT_LETTER_SPACED = re.compile(r"\\([uvHckbdrt])\s+([a-zA-Z])(?![a-zA-Z])")

# TeX consumes whitespace after a control word, so `\o ller` reads "øller";
# the trailing \s* mirrors that. Letter-map replacements glue to the next
# character; token replacements re-add their own separating spaces.
_RE_LATEX_COMMAND = re.compile(r"\\([a-zA-Z]+)\*?\s*")
_RE_TOKENIZE = re.compile(r"[a-z0-9]+")


def _strip_combining(value: str) -> str:
    decomposed = unicodedata.normalize("NFKD", value)
    return "".join(ch for ch in decomposed if not unicodedata.combining(ch))


def _replace_named_latex_command(match: "re.Match[str]") -> str:
    name = match.group(1)
    if name in _LATEX_TOKEN_MAP:
        return " " + _LATEX_TOKEN_MAP[name] + " "
    if name in _LATEX_LETTER_MAP:
        return _LATEX_LETTER_MAP[name]
    if name in _LATEX_DROP_COMMANDS:
        return " "
    # Unknown command: drop the command token itself; its braced argument
    # text (if any) survives because braces are stripped afterwards.
    return " "


def fold_text(value: str) -> str:
    """Fold a title-like string to a canonical comparison form.

    Case, whitespace, accents (Unicode combining marks and LaTeX accent
    macros), common LaTeX and Unicode symbols, math wrappers, braces, and
    punctuation are all folded; the result is a space-joined sequence of
    lowercase alphanumeric tokens.
    """
    text = value

    # Unicode symbol characters -> shared canonical tokens.
    out_chars: List[str] = []
    for ch in text:
        mapped = _UNICODE_TOKEN_MAP.get(ch)
        if mapped is not None:
            out_chars.append(" " + mapped + " ")
        else:
            out_chars.append(ch)
    text = "".join(out_chars)

    # Math delimiters.
    text = text.replace("\\(", " ").replace("\\)", " ")
    text = text.replace("\\[", " ").replace("\\]", " ")
    text = text.replace("$", " ")

    # LaTeX accent macros: keep the base letter; NFKD handles the Unicode side.
    text = _RE_ACCENT_PUNCT.sub(r"\2", text)
    text = _RE_ACCENT_LETTER_BRACED.sub(r"\2", text)
    text = _RE_ACCENT_LETTER_SPACED.sub(r"\2", text)

    # Named LaTeX commands (greek/symbols -> tokens, wrappers dropped).
    text = _RE_LATEX_COMMAND.sub(_replace_named_latex_command, text)

    # Structural LaTeX leftovers.
    text = text.replace("~", " ").replace("{", "").replace("}", "")
    text = text.replace("---", "-").replace("--", "-")
    text = text.replace("\\", " ")

    # Accent folding for Unicode input, then Latin specials and case.
    text = _strip_combining(text)
    text = "".join(_LATIN_FOLD_MAP.get(ch, ch) for ch in text)
    text = text.casefold()

    return " ".join(_RE_TOKENIZE.findall(text))


# Generational suffixes, compared after stripping a trailing period, so
# "Jr", "Jr.", and "JR." all match.
_NAME_SUFFIX_BASES = {"jr", "sr", "ii", "iii", "iv", "v"}
_NAME_PARTICLES = {
    "van", "von", "der", "den", "de", "del", "della", "di", "da", "dos",
    "das", "du", "la", "le", "lo", "ter", "ten", "op", "af", "av", "zu",
    "bin", "ibn", "el", "al", "van't", "'t",
}


def _is_suffix(text: str) -> bool:
    return text.casefold().rstrip(".") in _NAME_SUFFIX_BASES


def _strip_trailing_suffix_tokens(tokens: List[str]) -> List[str]:
    while len(tokens) > 1 and _is_suffix(tokens[-1]):
        tokens = tokens[:-1]
    return tokens


def _family_from_natural_order(name: str) -> str:
    """Family part of a natural-order name ("Given [particles] Family").

    When every leading token is particle-shaped, the head token's casing
    decides: a lowercase head ("de Groot", "van der Waals") marks a bare
    family name and is kept whole, while a capitalized head ("Van
    Morrison") is read as a given name and dropped. Display-cased bare
    families with particles ("Van Der Berg" with no given part) are the
    residual ambiguity; they fail toward disagreement, and the report's
    raw author rows carry the original spellings for a human call.
    """
    tokens = _strip_trailing_suffix_tokens(name.split())
    if not tokens:
        return ""
    start = len(tokens) - 1
    while start > 0 and tokens[start - 1].casefold() in _NAME_PARTICLES:
        start -= 1
    if start == 0 and len(tokens) > 1 and tokens[0][:1].isupper():
        start = 1
    return " ".join(tokens[start:])


def extract_family_name(author: str) -> str:
    """Extract and fold the family name from one author string.

    Accepts "Family, Given" (comma form), "Given Family" (natural order),
    and bare family names, with generational suffixes tolerated in all of
    them: "Smith, John, Jr.", "John Smith, Jr.", "Smith Jr., John", and
    "John Smith Jr." all yield "smith". In natural order the family name
    is the last token extended leftwards over name particles (van, de,
    della, ...), so "A. de Groot", "de Groot, A.", and the bare "de Groot"
    all yield "degroot". Multi-token family names are folded to a single
    token: "Johannes van der Waals", "Maria Van Der Berg", and their comma
    forms agree regardless of particle casing. A BARE display-cased
    particle family ("Van Der Waals" with no given part) is the residual
    ambiguity described in _family_from_natural_order and fails toward
    disagreement.
    """
    name = author.strip()
    if "," in name:
        segments = [segment.strip() for segment in name.split(",")]
        segments = [segment for segment in segments if segment]
        if not segments:
            return ""
        # Drop pure-suffix segments ("Smith, John, Jr." or "John Smith, Jr.").
        kept = [segments[0]] + [
            segment for segment in segments[1:] if not _is_suffix(segment)
        ]
        if len(kept) == 1:
            # The comma introduced only a suffix, so the remainder is a
            # natural-order name, not a "Family, Given" form.
            family_raw = _family_from_natural_order(kept[0])
        else:
            # Comma form: the family part may itself carry a trailing
            # suffix token ("Smith Jr., John").
            family_raw = " ".join(_strip_trailing_suffix_tokens(kept[0].split()))
    else:
        family_raw = _family_from_natural_order(name)
    folded = fold_text(family_raw)
    return folded.replace(" ", "")


# (prefix, is_url_form): URL forms may carry query/fragment tails and
# percent-encoding, which are transport artifacts, not part of the DOI name.
# The bare "doi:" form gets no such stripping: a rare DOI name may itself
# contain "?" or "#".
_DOI_PREFIXES = (
    ("https://doi.org/", True),
    ("http://doi.org/", True),
    ("https://dx.doi.org/", True),
    ("http://dx.doi.org/", True),
    ("doi.org/", True),
    ("dx.doi.org/", True),
    ("doi:", False),
)


def normalize_doi(value: str) -> str:
    """Normalize a DOI to a canonical comparison form.

    Strips URL and doi: prefixes; for URL forms also strips the query and
    fragment tail and decodes percent-encoding; strips surrounding slashes
    and trailing copy-paste punctuation; casefolds (DOI names are
    case-insensitive).
    """
    doi = value.strip()
    lowered = doi.casefold()
    for prefix, is_url_form in _DOI_PREFIXES:
        if lowered.startswith(prefix):
            doi = doi[len(prefix):]
            if is_url_form:
                doi = doi.split("?", 1)[0].split("#", 1)[0]
                doi = urllib.parse.unquote(doi)
            break
    return doi.strip().strip("/").rstrip(".,;").casefold()


# ---------------------------------------------------------------------------
# Input parsing and validation
# ---------------------------------------------------------------------------

def _validate_block(block: Any, origin: str) -> Dict[str, Any]:
    if not isinstance(block, dict):
        raise InputError(f"{origin}: provider block must be a JSON object")

    unknown = sorted(set(block.keys()) - set(BLOCK_KEYS))
    if unknown:
        raise InputError(f"{origin}: unknown provider-block keys: {unknown}")
    missing = sorted(set(BLOCK_KEYS) - set(block.keys()))
    if missing:
        raise InputError(
            f"{origin}: missing provider-block keys: {missing} "
            "(a value the provider does not supply must be an explicit null)"
        )

    provider = block["provider"]
    if not isinstance(provider, str) or not provider.strip():
        raise InputError(f"{origin}: 'provider' must be a non-empty string")
    provider = provider.strip()

    title = block["title"]
    if title is not None:
        if not isinstance(title, str) or not title.strip():
            raise InputError(f"{origin}: 'title' must be a non-empty string or null")
        if not fold_text(title):
            raise InputError(f"{origin}: 'title' normalizes to an empty string")

    authors = block["authors"]
    if authors is not None:
        if not isinstance(authors, list) or not authors:
            raise InputError(
                f"{origin}: 'authors' must be a non-empty list of strings or null "
                "(use null for an unknown or truncated author list)"
            )
        for index, author in enumerate(authors):
            if not isinstance(author, str) or not author.strip():
                raise InputError(
                    f"{origin}: 'authors[{index}]' must be a non-empty string"
                )
            if not extract_family_name(author):
                raise InputError(
                    f"{origin}: 'authors[{index}]' has no extractable family name: "
                    f"{author!r}"
                )

    year = block["year"]
    if year is not None:
        if isinstance(year, bool):
            raise InputError(f"{origin}: 'year' must be an integer or null")
        if isinstance(year, str):
            if not re.fullmatch(r"\d{4}", year.strip()):
                raise InputError(
                    f"{origin}: 'year' string must be a 4-digit year, got {year!r}"
                )
            year = int(year.strip())
        if not isinstance(year, int):
            raise InputError(f"{origin}: 'year' must be an integer or null")
        if not 1000 <= year <= 9999:
            raise InputError(f"{origin}: 'year' out of range: {year}")

    doi = block["doi"]
    normalized_doi: Optional[str] = None
    if doi is not None:
        if not isinstance(doi, str) or not doi.strip():
            raise InputError(f"{origin}: 'doi' must be a non-empty string or null")
        normalized_doi = normalize_doi(doi)
        if not normalized_doi.startswith("10."):
            raise InputError(
                f"{origin}: 'doi' does not look like a DOI after normalization: "
                f"{doi!r} -> {normalized_doi!r}"
            )

    for field in REPORT_ONLY_FIELDS:
        value = block[field]
        if value is not None and (not isinstance(value, str) or not value.strip()):
            raise InputError(f"{origin}: '{field}' must be a non-empty string or null")

    return {
        "provider": provider,
        "title": title,
        "authors": authors,
        "year": year,
        "doi": doi,
        "venue": block["venue"],
        "identifier": block["identifier"],
    }


def _blocks_from_document(document: Any, origin: str) -> Tuple[List[Dict[str, Any]], Optional[str]]:
    """Extract provider blocks and an optional citation key from one file."""
    citation_key: Optional[str] = None
    if isinstance(document, dict) and "providers" in document:
        unknown = sorted(set(document.keys()) - {"citation_key", "providers"})
        if unknown:
            raise InputError(f"{origin}: unknown container keys: {unknown}")
        raw_key = document.get("citation_key")
        if raw_key is not None:
            if not isinstance(raw_key, str) or not raw_key.strip():
                raise InputError(f"{origin}: 'citation_key' must be a non-empty string or null")
            citation_key = raw_key.strip()
        raw_blocks = document["providers"]
        if not isinstance(raw_blocks, list) or not raw_blocks:
            raise InputError(f"{origin}: 'providers' must be a non-empty list")
    elif isinstance(document, list):
        if not document:
            raise InputError(f"{origin}: provider-block list is empty")
        raw_blocks = document
    elif isinstance(document, dict):
        raw_blocks = [document]
    else:
        raise InputError(f"{origin}: input must be an object or a list of objects")

    blocks = [
        _validate_block(raw, f"{origin} (block {index})")
        for index, raw in enumerate(raw_blocks)
    ]
    return blocks, citation_key


def load_provider_blocks(
    paths: Sequence[str],
    cli_citation_key: Optional[str] = None,
) -> Tuple[List[Dict[str, Any]], Optional[str]]:
    """Load, validate, and merge provider blocks from the input files."""
    blocks: List[Dict[str, Any]] = []
    file_keys: List[str] = []
    for path in paths:
        try:
            with open(path, "r", encoding="utf-8") as handle:
                document = json.load(handle)
        except OSError as exc:
            raise InputError(f"{path}: cannot read input file: {exc}") from exc
        except json.JSONDecodeError as exc:
            raise InputError(f"{path}: invalid JSON: {exc}") from exc
        file_blocks, file_key = _blocks_from_document(document, path)
        blocks.extend(file_blocks)
        if file_key is not None:
            file_keys.append(file_key)

    distinct_keys = sorted(set(file_keys))
    if len(distinct_keys) > 1:
        raise InputError(
            f"conflicting citation_key values across input files: {distinct_keys} "
            "(each run must triangulate exactly one citation)"
        )
    citation_key = cli_citation_key or (distinct_keys[0] if distinct_keys else None)

    seen: Dict[str, str] = {}
    for block in blocks:
        provider_id = block["provider"].casefold()
        if provider_id in seen:
            raise InputError(
                f"duplicate provider {block['provider']!r}: each provider may "
                "contribute exactly one canonical record per run"
            )
        seen[provider_id] = block["provider"]

    return blocks, citation_key


# ---------------------------------------------------------------------------
# Comparison
# ---------------------------------------------------------------------------

def _normalized_field_value(field: str, block: Dict[str, Any]) -> Optional[Any]:
    raw = block[field]
    if raw is None:
        return None
    if field == "title":
        # Whitespace-insensitive: LaTeX markup and Unicode spellings tokenize
        # differently around superscripts/subscripts and hyphenation, so the
        # canonical form is the concatenated token stream.
        return fold_text(raw).replace(" ", "")
    if field == "authors":
        return [extract_family_name(author) for author in raw]
    if field == "year":
        return int(raw) if not isinstance(raw, int) else raw
    if field == "doi":
        return normalize_doi(raw)
    raise ValueError(f"not a key field: {field}")


def compare_blocks(blocks: Sequence[Dict[str, Any]]) -> Dict[str, Any]:
    """Build the per-field agreement matrix and the overall verdict."""
    providers = [block["provider"] for block in blocks]
    fields: Dict[str, Any] = {}
    reasons: List[str] = []

    any_agree = False
    any_disagree = False

    for field in KEY_FIELDS:
        raw_values = {block["provider"]: block[field] for block in blocks}
        normalized = {
            block["provider"]: _normalized_field_value(field, block)
            for block in blocks
        }
        present = [
            (provider, value)
            for provider, value in normalized.items()
            if value is not None
        ]
        disagreements: List[List[str]] = []
        if len(present) < 2:
            status = "missing"
        else:
            for index_a in range(len(present)):
                for index_b in range(index_a + 1, len(present)):
                    provider_a, value_a = present[index_a]
                    provider_b, value_b = present[index_b]
                    if value_a != value_b:
                        disagreements.append([provider_a, provider_b])
            status = "disagree" if disagreements else "agree"
        if status == "agree":
            any_agree = True
        if status == "disagree":
            any_disagree = True
            pair_text = "; ".join(" vs ".join(pair) for pair in disagreements)
            reasons.append(f"key field '{field}' disagrees: {pair_text}")
        fields[field] = {
            "role": "key",
            "status": status,
            "values": raw_values,
            "normalized": normalized,
            "disagreements": disagreements,
        }

    for field in REPORT_ONLY_FIELDS:
        fields[field] = {
            "role": "report_only",
            "status": "reported",
            "values": {block["provider"]: block[field] for block in blocks},
        }

    if len(blocks) < 2:
        verdict = "insufficient_sources"
        reasons.append(
            f"only {len(blocks)} provider record(s); triangulation needs at least 2"
        )
    elif any_disagree:
        verdict = "conflicted"
    elif not any_agree:
        verdict = "insufficient_sources"
        reasons.append(
            "no key field has comparable values from at least two providers"
        )
    else:
        verdict = "consistent"

    return {
        "providers": providers,
        "fields": fields,
        "verdict": verdict,
        "verdict_reasons": reasons,
    }


def build_report(
    blocks: Sequence[Dict[str, Any]],
    citation_key: Optional[str],
) -> Dict[str, Any]:
    comparison = compare_blocks(blocks)
    generated_at = (
        _dt.datetime.now(_dt.timezone.utc).replace(microsecond=0).isoformat()
    )
    return {
        "triangulation_report_version": TRIANGULATION_REPORT_VERSION,
        "generated_at": generated_at,
        "citation_key": citation_key,
        "providers": comparison["providers"],
        "key_fields": list(KEY_FIELDS),
        "report_only_fields": list(REPORT_ONLY_FIELDS),
        "fields": comparison["fields"],
        "verdict": comparison["verdict"],
        "verdict_reasons": comparison["verdict_reasons"],
        "exit_code": VERDICT_EXIT_CODES[comparison["verdict"]],
    }


# ---------------------------------------------------------------------------
# Rendering
# ---------------------------------------------------------------------------

def _markdown_cell(value: Any) -> str:
    if value is None:
        return "(null)"
    if isinstance(value, list):
        text = "; ".join(str(item) for item in value)
    else:
        text = str(value)
    text = text.replace("|", "\\|").replace("\n", " ")
    if len(text) > 80:
        text = text[:77] + "..."
    return text


def render_markdown(report: Dict[str, Any]) -> str:
    providers = report["providers"]
    lines: List[str] = []
    title_key = report["citation_key"] or "(no citation key)"
    lines.append(f"# Citation triangulation report - {title_key}")
    lines.append("")
    lines.append(f"- generated_at: {report['generated_at']}")
    lines.append(f"- providers: {', '.join(providers)}")
    lines.append(f"- verdict: **{report['verdict']}** (exit code {report['exit_code']})")
    for reason in report["verdict_reasons"]:
        lines.append(f"- reason: {reason}")
    lines.append("")
    escaped_providers = [_markdown_cell(provider) for provider in providers]
    lines.append("| field | status | " + " | ".join(escaped_providers) + " |")
    lines.append("| --- | --- | " + " | ".join(["---"] * len(providers)) + " |")
    for field in list(KEY_FIELDS) + list(REPORT_ONLY_FIELDS):
        entry = report["fields"][field]
        row = [field, entry["status"]]
        for provider in providers:
            row.append(_markdown_cell(entry["values"].get(provider)))
        lines.append("| " + " | ".join(row) + " |")
    lines.append("")
    lines.append(
        "Key fields (title, authors, year, doi) drive the verdict; venue and "
        "identifier are reported for the reader only."
    )
    lines.append("")
    return "\n".join(lines)


def write_atomic(path: str, content: str) -> None:
    """Write content via a same-directory temp file plus atomic rename."""
    absolute = os.path.abspath(path)
    directory = os.path.dirname(absolute)
    os.makedirs(directory, exist_ok=True)
    descriptor, temp_path = tempfile.mkstemp(
        dir=directory, prefix=".tmp-" + os.path.basename(absolute) + "-"
    )
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            handle.write(content)
        os.replace(temp_path, absolute)
    except BaseException:
        try:
            os.unlink(temp_path)
        except OSError:
            pass
        raise


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="triangulate_citation.py",
        description=(
            "Offline cross-index agreement check for one citation's metadata. "
            "Reads per-provider JSON blocks, compares normalized key fields "
            "(title, authors, year, doi), and emits a JSON + Markdown report. "
            "Exit codes: 0 consistent, 1 conflicted, 2 insufficient_sources, "
            "3 invalid input, 4 report write failure."
        ),
    )
    parser.add_argument(
        "inputs",
        nargs="+",
        metavar="INPUT.json",
        help=(
            "input JSON file(s): a provider block, a list of blocks, or an "
            "object with 'citation_key' and 'providers'"
        ),
    )
    parser.add_argument(
        "--citation-key",
        default=None,
        help="label for the citation under test (overrides any file-level key)",
    )
    parser.add_argument(
        "--out-json",
        default=None,
        help="path for the JSON report (written atomically)",
    )
    parser.add_argument(
        "--out-md",
        default=None,
        help="path for the Markdown report (written atomically)",
    )
    parser.add_argument(
        "--quiet",
        action="store_true",
        help="print only the final verdict line on stdout",
    )
    return parser


def main(argv: Optional[Sequence[str]] = None) -> int:
    parser = _build_parser()
    try:
        args = parser.parse_args(argv)
    except SystemExit as exc:
        # argparse exits 2 on usage errors; fold into the invalid-input code
        # (0 for --help passes through).
        return EXIT_INVALID_INPUT if exc.code else 0

    try:
        blocks, citation_key = load_provider_blocks(
            args.inputs, cli_citation_key=args.citation_key
        )
    except InputError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return EXIT_INVALID_INPUT

    report = build_report(blocks, citation_key)

    try:
        if args.out_json:
            write_atomic(
                args.out_json,
                json.dumps(report, ensure_ascii=False, indent=2, sort_keys=False)
                + "\n",
            )
        if args.out_md:
            write_atomic(args.out_md, render_markdown(report))
    except OSError as exc:
        # A report that cannot be persisted must not surface a verdict exit
        # code: automation would misread rc=1 as "conflicted".
        print(f"error: cannot write report: {exc}", file=sys.stderr)
        return EXIT_WRITE_FAILURE

    if not args.quiet:
        for field in KEY_FIELDS:
            entry = report["fields"][field]
            print(f"{field}: {entry['status']}")
        for reason in report["verdict_reasons"]:
            print(f"reason: {reason}")
    label = f" [{citation_key}]" if citation_key else ""
    print(f"verdict{label}: {report['verdict']}")
    return report["exit_code"]


if __name__ == "__main__":
    sys.exit(main())
