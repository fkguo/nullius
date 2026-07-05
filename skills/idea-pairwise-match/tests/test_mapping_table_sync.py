"""The vote-outcome to likelihood-tier table is shared text: SKILL.md and
assemble_match.py must carry it byte-for-byte identically."""

from pathlib import Path

import assemble_match

SKILL_MD = Path(__file__).resolve().parents[1] / "SKILL.md"

START = "<!-- shared-mapping-table:start -->"
END = "<!-- shared-mapping-table:end -->"


def test_mapping_table_is_identical_in_skill_md_and_script():
    text = SKILL_MD.read_text(encoding="utf-8")
    assert START in text and END in text, "SKILL.md lost the mapping-table markers"
    block = text.split(START, 1)[1].split(END, 1)[0]
    assert block.strip() == assemble_match.MAPPING_TABLE_TEXT.strip()
