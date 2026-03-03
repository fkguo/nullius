#!/usr/bin/env python3
"""Information Membrane V1 — rule-based content classifier for Semi-permeable Clean Room.

Classifies text segments into PASS (safe to share) or BLOCK (would compromise
verification independence). V1 uses deterministic regex + keyword rules only.

BLOCK always takes priority over PASS (conservative-first).
"""
from __future__ import annotations

import hashlib
import json
import re
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

MEMBRANE_VERSION = "v1_rule_based"

# ---------------------------------------------------------------------------
# Content type enums
# ---------------------------------------------------------------------------

PASS_TYPES = frozenset({
    "METHOD", "REFERENCE", "CONVENTION", "PITFALL",
    "CRITERION", "TOOL", "ASSUMPTION",
})

BLOCK_TYPES = frozenset({
    "NUM_RESULT", "SYM_RESULT", "DERIV_CHAIN", "VERDICT",
    "CODE_OUTPUT", "AGREEMENT", "COMPARISON",
})


# ---------------------------------------------------------------------------
# BLOCK detection rules (order matters: first match wins)
# ---------------------------------------------------------------------------

_BLOCK_RULES: list[tuple[str, list[re.Pattern[str]]]] = [
    # 1. Numerical results
    ("NUM_RESULT", [
        re.compile(r"=\s*[+-]?[\d.]+(?:\s*[×x]\s*10\s*\^?\s*[+-]?\d+)?", re.I),
        re.compile(r"[≈≃≅~]\s*[+-]?\$?[\d.]+\$?"),
        re.compile(r"(?:result|answer|value|output)\s+(?:is|=|:|equals?)\s+", re.I),
        re.compile(r"(?:(?:I|[Ww]e)\s+(?:get|obtain|find|calculate|compute))\s+", re.I),
        re.compile(r"(?:gives?|yields?|returns?|produces?)\s+[\d.$\\]", re.I),
        # Broader: "is/equals/of <number>[unit]" pattern (e.g. "The cross section is 42 pb")
        re.compile(r"(?:is|are|was|equals?|of)\s+\$?[+-]?[\d.]+\$?(?:\s*[×x]\s*10\s*\^?\s*[+-]?\d+)?\s*(?:GeV|MeV|keV|eV|pb|fb|nb|mb|cm|mm|m\b|s\b|kg|%)", re.I),
        # "Result: <number>" pattern
        re.compile(r"(?:result|answer|output|total)\s*:\s*[+-]?[\d.]+", re.I),
        # "sigma/mass/width/... = <number>" (physics observable assignment)
        re.compile(r"(?:sigma|mass|width|lifetime|branching|cross.section|amplitude|coupling|Gamma)\s*=\s*[+-]?[\d.]+", re.I),
        # "comes out to/as <number>" pattern
        re.compile(r"(?:comes?\s+out\s+(?:to|as)|evaluates?\s+to|turns?\s+out\s+to\s+be)\s+\$?[+-]?[\d.]+", re.I),
        # Scientific notation: "4.2e-3", "+1.5E6"
        re.compile(r"(?:is|are|was|equals?|of)\s+[+-]?[\d.]+[eE][+-]?\d+", re.I),
    ]),
    # 2. Symbolic results (final expressions)
    ("SYM_RESULT", [
        re.compile(r"(?:therefore|thus|hence|so)\s+\$[^$]+\$\s*=", re.I),
        re.compile(r"(?:final|main)\s+(?:result|expression|answer)", re.I),
        # LaTeX math assignment: "$X = expr$" patterns
        re.compile(r"\$[^$]*\\?[A-Za-z]+\s*=\s*[^$]+\$"),
        # "the amplitude/matrix element is" followed by math (LaTeX macro or plain text)
        re.compile(r"(?:amplitude|matrix\s+element|propagator|self.energy)\s+(?:is|equals?)\s+(?:\$|\\[A-Za-z]|[A-Z])", re.I),
        # Plain-text symbolic assignment: "X = expr" where X is a single uppercase variable
        re.compile(r"(?:is|are|equals?)\s+[A-Z]\w*\s*=\s*\S", re.I),
        # LaTeX macro result: "\mathcal{M} = ..." or "\Gamma = ..."
        re.compile(r"\\(?:mathcal|mathrm|mathbf|mathbb|operatorname)\s*\{[^}]+\}\s*=\s*\S"),
    ]),
    # 3. Derivation chains
    ("DERIV_CHAIN", [
        re.compile(r"Step\s+\d+:.*→"),
        re.compile(r"→.*→.*→"),
        re.compile(r"(?:substitut(?:e|ing)).*(?:get|obtain|find)", re.I),
        # Comma/semicolon-separated step chains
        re.compile(r"[Ss]tep\s+1\s*:.*[Ss]tep\s+2\s*:", re.I),
        # "expand ... integrate ... simplify" derivation flow
        re.compile(r"(?:expand|integrate|simplify|differentiate|evaluate).*(?:expand|integrate|simplify|differentiate|evaluate).*(?:expand|integrate|simplify|differentiate|evaluate)", re.I),
    ]),
    # 4. Verdicts / judgments
    ("VERDICT", [
        re.compile(r"(?:I|[Ww]e)\s+(?:agree|disagree|conclude|concur)\b", re.I),
        re.compile(r"\b(?:correct|incorrect|wrong)\s+(?:in\s+the|result|derivation|calculation|approach|answer|method)", re.I),
        re.compile(r"(?:your|the)\s+(?:result|answer|calculation|derivation)\s+is\s+(?:correct|incorrect|wrong|right|valid|invalid)", re.I),
        re.compile(r"(?:my|our)\s+(?:result|answer|calculation)\s+(?:matches|agrees|is consistent)", re.I),
        re.compile(r"\b(?:CONFIRMED|CHALLENGED)\b"),
        re.compile(r"(?:this|the)\s+(?:derivation|proof|calculation|approach)\s+is\s+(?:correct|valid|sound)", re.I),
        # Hedged verdict phrasing: "looks correct", "seems wrong", "appears valid"
        re.compile(r"(?:looks|seems|appears)\s+(?:correct|incorrect|wrong|right|valid|invalid|fine|good|ok(?:ay)?)\b", re.I),
        # "validates/confirms your result"
        re.compile(r"(?:validates?|verifies?|confirms?)\s+(?:your|the|this)\s+(?:result|answer|calculation|derivation)", re.I),
    ]),
    # 5. Code output
    ("CODE_OUTPUT", [
        re.compile(r"```(?:output|result|console)", re.I),
        re.compile(r"(?:running|executing)\s+(?:the\s+)?(?:code|script|program)\s+(?:gives?|yields?|returns?|produces?|output)", re.I),
        re.compile(r"(?:program|code)\s+output\s*:", re.I),
    ]),
    # 6. Agreement statements
    ("AGREEMENT", [
        re.compile(r"(?:I|[Ww]e)\s+agree\s+with\s+(?:your|Member|member)", re.I),
        re.compile(r"(?:I|[Ww]e)\s+concur\s+with\b", re.I),
        re.compile(r"(?:confirms?|support)\s+(?:your|Member|member|the other)", re.I),
        re.compile(r"(?:same|identical)\s+(?:result|answer|value|conclusion)", re.I),
    ]),
    # 7. Comparison statements
    ("COMPARISON", [
        re.compile(r"(?:our|the)\s+results?\s+(?:differ|agree|match|are consistent)", re.I),
        re.compile(r"(?:discrepancy|deviation|difference)\s+(?:is|of)\s+[\d.]", re.I),
        re.compile(r"(?:compared?\s+(?:to|with)|relative\s+to)\s+(?:your|Member|member)", re.I),
    ]),
]

# ---------------------------------------------------------------------------
# PASS detection rules (used for audit logging, not for decision-making)
# ---------------------------------------------------------------------------

_PASS_RULES: dict[str, list[re.Pattern[str]]] = {
    "METHOD": [
        re.compile(r"(?:suggest|recommend|consider|try|use)\s+(?:using|method|algorithm|approach|technique)", re.I),
        re.compile(r"(?:Gauss-Kronrod|adaptive|Monte\s+Carlo|Vegas|quad|RK45|Runge.Kutta)", re.I),
    ],
    "REFERENCE": [
        re.compile(r"\[[\w\s.,]+\d{4}\w?\]"),
        re.compile(r"(?:see|cf\.?|following|refer\s+to)\s+(?:eq|Eq|equation|section|§|Ref)", re.I),
        re.compile(r"(?:arXiv|doi|Rev\.\s+\w+|Phys\.\s+Lett|hep-(?:ph|th|ex|lat))", re.I),
    ],
    "CONVENTION": [
        re.compile(r"(?:I\s+use|my\s+convention|in\s+the\s+\w+\s+scheme)", re.I),
        re.compile(r"(?:MS-bar|overline\{MS\}|on-shell|dimensional\s+reg)", re.I),
    ],
    "PITFALL": [
        re.compile(r"(?:watch\s+out|be\s+careful|note\s+that|beware|caution)", re.I),
        re.compile(r"(?:divergen(?:ce|t)|singular(?:ity)?|branch\s+cut|pole)", re.I),
    ],
    "CRITERION": [
        re.compile(r"(?:convergence|precision|accuracy|tolerance|grid\s+refin)", re.I),
        re.compile(r"(?:significant\s+(?:digits?|figures?))", re.I),
    ],
    "TOOL": [
        re.compile(r"(?:LoopTools|FeynCalc|FeynArts|FormCalc|scipy|numpy|Mathematica)", re.I),
        re.compile(r"(?:library|package|tool(?:kit)?|software)\s+(?:for|to)\b", re.I),
    ],
    "ASSUMPTION": [
        re.compile(r"(?:I\s+assume|assuming\s+that|we\s+assume|assumption)", re.I),
        re.compile(r"(?:in\s+the\s+limit|neglect(?:ing)?|approximat)", re.I),
    ],
}


# ---------------------------------------------------------------------------
# Data classes
# ---------------------------------------------------------------------------

@dataclass
class Signal:
    """A detected content signal (BLOCK or PASS)."""
    signal_type: str  # e.g. "NUM_RESULT", "METHOD"
    category: str     # "BLOCK" or "PASS"
    pattern_matched: str
    line_offset: int = 0


@dataclass
class BlockedSpan:
    """A segment that was blocked by the membrane."""
    original: str
    block_type: str
    replacement: str


@dataclass
class AuditEntry:
    """One audit record per segment processed."""
    segment_preview: str
    block_signals: list[Signal]
    pass_signals: list[Signal]
    decision: str  # "BLOCK" or "PASS"
    line_offset: int = 0


@dataclass
class FilterResult:
    """Result of applying the Information Membrane to a text."""
    passed_text: str = ""
    blocked_spans: list[BlockedSpan] = field(default_factory=list)
    audit_entries: list[AuditEntry] = field(default_factory=list)

    @property
    def blocked_count(self) -> int:
        return len(self.blocked_spans)

    @property
    def total_segments(self) -> int:
        return len(self.audit_entries)


# ---------------------------------------------------------------------------
# Detection functions
# ---------------------------------------------------------------------------

def detect_block_signals(text: str) -> list[Signal]:
    """Detect all BLOCK-type signals in a text segment."""
    signals: list[Signal] = []
    for block_type, patterns in _BLOCK_RULES:
        for pat in patterns:
            m = pat.search(text)
            if m:
                signals.append(Signal(
                    signal_type=block_type,
                    category="BLOCK",
                    pattern_matched=m.group(0)[:80],
                ))
                break  # one match per block type suffices
    return signals


def detect_pass_signals(text: str) -> list[Signal]:
    """Detect all PASS-type signals in a text segment."""
    signals: list[Signal] = []
    for pass_type, patterns in _PASS_RULES.items():
        for pat in patterns:
            m = pat.search(text)
            if m:
                signals.append(Signal(
                    signal_type=pass_type,
                    category="PASS",
                    pattern_matched=m.group(0)[:80],
                ))
                break
    return signals


# ---------------------------------------------------------------------------
# Text splitting
# ---------------------------------------------------------------------------

_SENTENCE_SPLIT = re.compile(
    r"(?<=[.!?])\s+(?=[A-Z$\\])"  # split after sentence-ending punctuation before uppercase/math
    r"|(?<=\n)\s*(?=[-*•])"       # split before bullet items
    r"|(?:\n\s*\n)",               # split on blank lines
)


def split_into_segments(text: str) -> list[str]:
    """Split text into segments for per-segment classification.

    Tries sentence/paragraph splitting. Returns non-empty segments only.
    """
    if not text.strip():
        return []
    # First split by paragraphs (double newline)
    paragraphs = re.split(r"\n\s*\n", text)
    segments: list[str] = []
    for para in paragraphs:
        para = para.strip()
        if not para:
            continue
        # For short paragraphs, keep as-is
        if len(para) < 200:
            segments.append(para)
            continue
        # Try sentence-level splitting for longer paragraphs
        subs = _SENTENCE_SPLIT.split(para)
        for s in subs:
            s = s.strip()
            if s:
                segments.append(s)
    return segments


# ---------------------------------------------------------------------------
# Core filter function
# ---------------------------------------------------------------------------

def filter_message(text: str) -> FilterResult:
    """Apply the Information Membrane to a text message.

    Returns a FilterResult with:
    - passed_text: content safe to share (BLOCK segments replaced with [REDACTED])
    - blocked_spans: details of what was blocked
    - audit_entries: full decision log
    """
    result = FilterResult()
    segments = split_into_segments(text)

    if not segments:
        return result

    parts: list[str] = []

    for seg in segments:
        block_signals = detect_block_signals(seg)
        pass_signals = detect_pass_signals(seg)

        if block_signals:
            # BLOCK takes priority — always
            primary_type = block_signals[0].signal_type
            replacement = f"[REDACTED — contains {primary_type}]"
            result.blocked_spans.append(BlockedSpan(
                original=seg,
                block_type=primary_type,
                replacement=replacement,
            ))
            parts.append(replacement)
        else:
            parts.append(seg)

        result.audit_entries.append(AuditEntry(
            segment_preview=seg[:120],
            block_signals=block_signals,
            pass_signals=pass_signals,
            decision="BLOCK" if block_signals else "PASS",
        ))

    result.passed_text = "\n\n".join(parts)
    return result


# ---------------------------------------------------------------------------
# Audit logging
# ---------------------------------------------------------------------------

def _sha256(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


@dataclass
class MembraneAuditRecord:
    """A single JSONL record for membrane audit logging."""
    timestamp: str
    phase: str
    source_member: str
    target_member: str
    input_hash: str
    segments_total: int
    segments_passed: int
    segments_blocked: int
    blocked_details: list[dict[str, Any]]
    membrane_version: str = MEMBRANE_VERSION


def build_audit_record(
    *,
    filter_result: FilterResult,
    input_text: str,
    phase: str,
    source_member: str = "",
    target_member: str = "",
) -> MembraneAuditRecord:
    """Build an audit record from a FilterResult."""
    blocked_details = []
    for span in filter_result.blocked_spans:
        # Find the matching audit entry for pattern info
        detail: dict[str, Any] = {"type": span.block_type}
        for entry in filter_result.audit_entries:
            if entry.decision == "BLOCK" and entry.segment_preview == span.original[:120]:
                if entry.block_signals:
                    detail["pattern_matched"] = entry.block_signals[0].pattern_matched
                break
        blocked_details.append(detail)

    passed = filter_result.total_segments - filter_result.blocked_count
    return MembraneAuditRecord(
        timestamp=datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        phase=phase,
        source_member=source_member,
        target_member=target_member,
        input_hash=f"sha256:{_sha256(input_text)}",
        segments_total=filter_result.total_segments,
        segments_passed=passed,
        segments_blocked=filter_result.blocked_count,
        blocked_details=blocked_details,
    )


def write_audit_log(
    record: MembraneAuditRecord,
    audit_dir: Path,
) -> Path:
    """Append an audit record to the appropriate JSONL file."""
    audit_dir.mkdir(parents=True, exist_ok=True)
    filename = f"{record.phase}_{record.source_member}_{record.target_member}.jsonl"
    filepath = audit_dir / filename
    line = json.dumps({
        "timestamp": record.timestamp,
        "phase": record.phase,
        "source_member": record.source_member,
        "target_member": record.target_member,
        "input_hash": record.input_hash,
        "segments_total": record.segments_total,
        "segments_passed": record.segments_passed,
        "segments_blocked": record.segments_blocked,
        "blocked_details": record.blocked_details,
        "membrane_version": record.membrane_version,
    }, ensure_ascii=False)
    with filepath.open("a", encoding="utf-8") as f:
        f.write(line + "\n")
    return filepath
