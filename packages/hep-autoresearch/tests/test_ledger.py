"""Tests for H-10: Ledger event type enum."""

from __future__ import annotations

import unittest

from hep_autoresearch.toolkit.ledger import EventType, validate_event_type


class TestEventType(unittest.TestCase):
    def test_all_members_are_strings(self) -> None:
        for et in EventType:
            self.assertIsInstance(et.value, str)
            # (str, Enum) allows direct comparison with plain strings
            self.assertEqual(et, et.value)

    def test_validate_known_type(self) -> None:
        result = validate_event_type("initialized")
        self.assertEqual(result, "initialized")

    def test_validate_all_members(self) -> None:
        for et in EventType:
            self.assertEqual(validate_event_type(et.value), et.value)

    def test_validate_unknown_type_raises(self) -> None:
        with self.assertRaises(ValueError) as ctx:
            validate_event_type("bogus_event")
        self.assertIn("bogus_event", str(ctx.exception))
        self.assertIn("unknown ledger event_type", str(ctx.exception))

    def test_validate_empty_string_raises(self) -> None:
        with self.assertRaises(ValueError):
            validate_event_type("")

    def test_enum_membership(self) -> None:
        self.assertEqual(EventType.INITIALIZED, "initialized")
        self.assertEqual(EventType.COMPLETED, "completed")
        self.assertEqual(EventType.APPROVAL_TIMEOUT, "approval_timeout")
        self.assertEqual(EventType.STATE_TRANSITION, "state_transition")


if __name__ == "__main__":
    unittest.main()
