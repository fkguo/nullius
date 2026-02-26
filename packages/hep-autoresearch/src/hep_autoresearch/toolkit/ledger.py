"""Ledger event type definitions (H-10).

Canonical enumeration of all valid ledger event types.
``append_ledger_event`` rejects event types not in this enum.
"""

from __future__ import annotations

from enum import Enum


class EventType(str, Enum):
    """Strongly-typed ledger event types.

    Every ``append_ledger_event`` call must use a member of this enum as its
    ``event_type`` argument.  Unknown strings are rejected with ``ValueError``.
    """

    # Lifecycle ----------------------------------------------------------
    INITIALIZED = "initialized"
    RUN_STARTED = "run_started"
    STEP_STARTED = "step_started"
    PAUSED = "paused"
    RESUMED = "resumed"
    STOPPED = "stopped"
    CHECKPOINT = "checkpoint"
    COMPLETED = "completed"
    FAILED = "failed"
    NEEDS_RECOVERY = "needs_recovery"
    EXPORTED = "exported"

    # Branching ----------------------------------------------------------
    BRANCH_CANDIDATE_ADDED = "branch_candidate_added"
    BRANCH_SWITCHED = "branch_switched"

    # Approvals ----------------------------------------------------------
    APPROVAL_REQUESTED = "approval_requested"
    APPROVAL_APPROVED = "approval_approved"
    APPROVAL_REJECTED = "approval_rejected"
    APPROVAL_TIMEOUT = "approval_timeout"
    APPROVAL_BUDGET_EXHAUSTED = "approval_budget_exhausted"

    # Gates --------------------------------------------------------------
    GATE_SATISFIED_INVALIDATED = "gate_satisfied_invalidated"

    # Generic state transition (forward-looking) -------------------------
    STATE_TRANSITION = "state_transition"


# Fast membership check set (avoids repeated enum iteration).
_VALID_EVENT_TYPES: frozenset[str] = frozenset(e.value for e in EventType)


def validate_event_type(event_type: str) -> str:
    """Validate that *event_type* is a known ``EventType`` value.

    Returns the validated string on success.
    Raises ``ValueError`` if the string is not a recognized event type.
    """
    if event_type not in _VALID_EVENT_TYPES:
        raise ValueError(
            f"unknown ledger event_type: {event_type!r}; "
            f"must be one of {sorted(_VALID_EVENT_TYPES)}"
        )
    return event_type
