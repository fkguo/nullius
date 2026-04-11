import json
import unittest
from pathlib import Path


def _plan_schema_path() -> Path:
    return (
        Path(__file__).resolve().parents[1]
        / "src"
        / "project_contracts"
        / "specs"
        / "plan.schema.json"
    )


class TestPlanSchemaTaskProjection(unittest.TestCase):
    def test_plan_step_exposes_optional_task_projection(self) -> None:
        schema = json.loads(_plan_schema_path().read_text(encoding="utf-8"))
        task_property = schema["$defs"]["plan_step"]["properties"]["task"]

        self.assertEqual(
            task_property,
            {"oneOf": [{"$ref": "#/$defs/workflow_step_task"}, {"type": "null"}]},
        )

    def test_task_projection_stays_provider_neutral(self) -> None:
        schema = json.loads(_plan_schema_path().read_text(encoding="utf-8"))
        task_def = schema["$defs"]["workflow_step_task"]

        self.assertEqual(
            task_def["required"],
            [
                "task_id",
                "task_kind",
                "task_intent",
                "title",
                "description",
                "depends_on_task_ids",
                "required_capabilities",
                "expected_artifacts",
                "preconditions",
            ],
        )
        self.assertFalse(task_def["additionalProperties"])
        self.assertNotIn("tool", task_def["properties"])
        self.assertNotIn("provider", task_def["properties"])
        self.assertNotIn("params", task_def["properties"])
        self.assertNotIn("degrade_mode", task_def["properties"])
        self.assertNotIn("consumer_hints", task_def["properties"])
