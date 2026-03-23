from __future__ import annotations

from pathlib import Path


PROJECT_POLICY_REAL_PROJECT = "real_project"
PROJECT_POLICY_MAINTAINER_FIXTURE = "maintainer_fixture"
PROJECT_POLICY_CHOICES = (
    PROJECT_POLICY_REAL_PROJECT,
    PROJECT_POLICY_MAINTAINER_FIXTURE,
)


def dev_repo_root() -> Path:
    return Path(__file__).resolve().parents[4]


def validate_project_policy(project_policy: str | None) -> str:
    policy = (project_policy or PROJECT_POLICY_REAL_PROJECT).strip() or PROJECT_POLICY_REAL_PROJECT
    if policy not in PROJECT_POLICY_CHOICES:
        expected = ", ".join(PROJECT_POLICY_CHOICES)
        raise ValueError(f"invalid project policy: {policy} (expected: {expected})")
    return policy


def resolve_user_path(path: Path | str, *, base: Path | None = None) -> Path:
    raw = Path(path).expanduser()
    if not raw.is_absolute():
        if base is None:
            raise ValueError(f"relative path requires base: {path}")
        raw = base / raw
    return raw.resolve()


def _path_is_within(path: Path, base: Path) -> bool:
    try:
        path.resolve().relative_to(base.resolve())
        return True
    except Exception:
        return False


def maintainer_fixture_roots(*, repo_root: Path | None = None) -> tuple[Path, ...]:
    root = (repo_root or dev_repo_root()).resolve()
    return (
        root / "skills" / "research-team" / "skilldev",
        root / "skills" / "research-team" / ".tmp",
    )


def _repo_internal_path_allowed(path: Path, *, repo_root: Path, project_policy: str) -> bool:
    if not _path_is_within(path, repo_root):
        return True
    if project_policy == PROJECT_POLICY_REAL_PROJECT:
        return False
    return any(_path_is_within(path, allowed) for allowed in maintainer_fixture_roots(repo_root=repo_root))


def _policy_violation_message(*, label: str, path: Path, repo_root: Path, project_policy: str) -> str:
    if project_policy == PROJECT_POLICY_REAL_PROJECT:
        return (
            f"{label} must resolve outside the autoresearch-lab dev repo for real projects.\n"
            f"path={path}\nrepo_root={repo_root}"
        )
    allowed = ", ".join(str(item) for item in maintainer_fixture_roots(repo_root=repo_root))
    return (
        f"{label} is repo-internal but not under an allowed maintainer_fixture directory.\n"
        f"path={path}\nrepo_root={repo_root}\nallowed={allowed}"
    )


def assert_project_root_allowed(
    project_root: Path | str,
    *,
    project_policy: str | None = None,
    repo_root: Path | None = None,
) -> Path:
    repo = (repo_root or dev_repo_root()).resolve()
    root = resolve_user_path(project_root)
    policy = validate_project_policy(project_policy)
    if not _repo_internal_path_allowed(root, repo_root=repo, project_policy=policy):
        raise ValueError(
            _policy_violation_message(
                label="project root",
                path=root,
                repo_root=repo,
                project_policy=policy,
            )
        )
    return root


def assert_path_allowed(
    path: Path | str,
    *,
    project_policy: str | None = None,
    repo_root: Path | None = None,
    label: str = "path",
    base: Path | None = None,
) -> Path:
    repo = (repo_root or dev_repo_root()).resolve()
    resolved = resolve_user_path(path, base=base)
    policy = validate_project_policy(project_policy)
    if not _repo_internal_path_allowed(resolved, repo_root=repo, project_policy=policy):
        raise ValueError(
            _policy_violation_message(
                label=label,
                path=resolved,
                repo_root=repo,
                project_policy=policy,
            )
        )
    return resolved


def assert_path_within_project(path: Path | str, *, project_root: Path, label: str) -> Path:
    resolved = resolve_user_path(path)
    root = project_root.resolve()
    if not _path_is_within(resolved, root):
        raise ValueError(f"{label} must resolve inside project root.\npath={resolved}\nproject_root={root}")
    return resolved
