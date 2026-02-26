"""Tests for artifact migration toolkit (M-20)."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from hep_autoresearch.toolkit.migrate import (
    cmd_migrate,
    detect_old_artifacts,
    load_registry,
    migrate_artifact,
)


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

REGISTRY_V1 = {
    "version": 1,
    "chains": [
        {
            "schema_id": "state",
            "current_version": 2,
            "migrations": [
                {
                    "from_version": 1,
                    "to_version": 2,
                    "operations": [
                        {"op": "add_field", "path": "meta.migrated", "value": True},
                        {"op": "set_field", "path": "schema_version", "value": 2},
                    ],
                },
            ],
        },
    ],
}


ARTIFACT_V1 = {
    "schema_version": 1,
    "run_id": "test_run_001",
    "status": "running",
}

ARTIFACT_V2_EXPECTED_KEYS = {"schema_version", "run_id", "status", "meta"}


@pytest.fixture()
def registry_path(tmp_path: Path) -> Path:
    p = tmp_path / "registry.json"
    p.write_text(json.dumps(REGISTRY_V1), encoding="utf-8")
    return p


@pytest.fixture()
def repo_root_with_artifact(tmp_path: Path) -> Path:
    ar_dir = tmp_path / ".autoresearch"
    ar_dir.mkdir()
    (ar_dir / "state.json").write_text(json.dumps(ARTIFACT_V1), encoding="utf-8")
    return tmp_path


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------


class TestLoadRegistry:
    def test_loads_valid_registry(self, registry_path: Path) -> None:
        reg = load_registry(registry_path)
        assert "state" in reg
        assert len(reg["state"]) == 1

    def test_rejects_unknown_version(self, tmp_path: Path) -> None:
        p = tmp_path / "bad.json"
        p.write_text(json.dumps({"version": 99, "chains": []}), encoding="utf-8")
        with pytest.raises(ValueError, match="unsupported"):
            load_registry(p)


class TestDetectOldArtifacts:
    def test_finds_versioned_artifact(self, repo_root_with_artifact: Path) -> None:
        artifacts = detect_old_artifacts(repo_root_with_artifact)
        assert len(artifacts) == 1
        assert artifacts[0]["schema_version"] == 1

    def test_skips_non_json(self, tmp_path: Path) -> None:
        ar_dir = tmp_path / ".autoresearch"
        ar_dir.mkdir()
        (ar_dir / "notes.txt").write_text("not json", encoding="utf-8")
        assert detect_old_artifacts(tmp_path) == []

    def test_no_autoresearch_dir(self, tmp_path: Path) -> None:
        assert detect_old_artifacts(tmp_path) == []


class TestMigrateArtifact:
    def test_upgrades_v1_to_v2(self, registry_path: Path) -> None:
        reg = load_registry(registry_path)
        data = json.loads(json.dumps(ARTIFACT_V1))
        migrated, version = migrate_artifact(data, "state", reg)
        assert version == 2
        assert migrated["schema_version"] == 2
        assert migrated["meta"]["migrated"] is True
        assert set(migrated.keys()) == ARTIFACT_V2_EXPECTED_KEYS

    def test_no_op_for_unknown_schema(self, registry_path: Path) -> None:
        reg = load_registry(registry_path)
        data = {"schema_version": 1, "foo": "bar"}
        migrated, version = migrate_artifact(data, "unknown_schema", reg)
        assert version == 1
        assert migrated == data

    def test_already_at_latest(self, registry_path: Path) -> None:
        reg = load_registry(registry_path)
        data = {"schema_version": 2, "run_id": "r1", "status": "done", "meta": {"migrated": True}}
        migrated, version = migrate_artifact(data, "state", reg)
        assert version == 2  # unchanged


class TestMigrationOperations:
    def test_rename_field(self) -> None:
        reg = {
            "test": [
                {
                    "from_version": 1,
                    "to_version": 2,
                    "operations": [
                        {"op": "rename_field", "from_path": "old_name", "path": "new_name"},
                    ],
                },
            ],
        }
        data = {"schema_version": 1, "old_name": "value123"}
        migrated, version = migrate_artifact(data, "test", reg)
        assert version == 2
        assert "old_name" not in migrated
        assert migrated["new_name"] == "value123"

    def test_remove_field(self) -> None:
        reg = {
            "test": [
                {
                    "from_version": 1,
                    "to_version": 2,
                    "operations": [
                        {"op": "remove_field", "path": "deprecated"},
                    ],
                },
            ],
        }
        data = {"schema_version": 1, "deprecated": "gone", "keep": "yes"}
        migrated, version = migrate_artifact(data, "test", reg)
        assert version == 2
        assert "deprecated" not in migrated
        assert migrated["keep"] == "yes"


class TestCmdMigrate:
    def test_migrates_artifact_file(
        self, repo_root_with_artifact: Path, registry_path: Path
    ) -> None:
        result = cmd_migrate(repo_root_with_artifact, registry_path=registry_path)
        assert result == 0

        updated = json.loads(
            (repo_root_with_artifact / ".autoresearch" / "state.json").read_text(encoding="utf-8")
        )
        assert updated["schema_version"] == 2
        assert updated["meta"]["migrated"] is True

    def test_dry_run_does_not_write(
        self, repo_root_with_artifact: Path, registry_path: Path
    ) -> None:
        result = cmd_migrate(repo_root_with_artifact, registry_path=registry_path, dry_run=True)
        assert result == 0

        original = json.loads(
            (repo_root_with_artifact / ".autoresearch" / "state.json").read_text(encoding="utf-8")
        )
        assert original["schema_version"] == 1

    def test_no_registry_file(self, repo_root_with_artifact: Path, tmp_path: Path) -> None:
        result = cmd_migrate(repo_root_with_artifact, registry_path=tmp_path / "nonexistent.json")
        assert result == 0

    def test_default_registry_autodetect(self, tmp_path: Path) -> None:
        """Default registry path is found by walking up to monorepo root (F8 coverage)."""
        # Create a fake monorepo structure with meta/schemas/migration_registry_v1.json
        mono_root = tmp_path / "monorepo"
        schemas_dir = mono_root / "meta" / "schemas"
        schemas_dir.mkdir(parents=True)
        registry_file = schemas_dir / "migration_registry_v1.json"
        registry_file.write_text(json.dumps(REGISTRY_V1), encoding="utf-8")

        # Create a project dir nested under mono_root
        project_dir = mono_root / "packages" / "myproject"
        project_dir.mkdir(parents=True)

        # Create artifact in project_dir
        ar_dir = project_dir / ".autoresearch"
        ar_dir.mkdir()
        (ar_dir / "state.json").write_text(json.dumps(ARTIFACT_V1), encoding="utf-8")

        # Run cmd_migrate without explicit registry_path — should autodetect
        result = cmd_migrate(project_dir)
        assert result == 0

        updated = json.loads(
            (ar_dir / "state.json").read_text(encoding="utf-8")
        )
        assert updated["schema_version"] == 2

    def test_version_zero_migration(self, tmp_path: Path) -> None:
        """Version 0 artifacts are correctly detected and migrated (F3 regression)."""
        registry_data = {
            "version": 1,
            "chains": [
                {
                    "schema_id": "config",
                    "current_version": 1,
                    "migrations": [
                        {
                            "from_version": 0,
                            "to_version": 1,
                            "operations": [
                                {"op": "add_field", "path": "initialized", "value": True},
                            ],
                        },
                    ],
                },
            ],
        }
        reg_path = tmp_path / "registry.json"
        reg_path.write_text(json.dumps(registry_data), encoding="utf-8")

        ar_dir = tmp_path / ".autoresearch"
        ar_dir.mkdir()
        (ar_dir / "config.json").write_text(
            json.dumps({"schema_version": 0, "name": "test"}),
            encoding="utf-8",
        )

        result = cmd_migrate(tmp_path, registry_path=reg_path)
        assert result == 0

        updated = json.loads(
            (ar_dir / "config.json").read_text(encoding="utf-8")
        )
        assert updated["schema_version"] == 1
        assert updated["initialized"] is True
