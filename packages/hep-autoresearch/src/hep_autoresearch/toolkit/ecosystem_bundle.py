from __future__ import annotations

import hashlib
import json
import os
import platform
import re
import shutil
import subprocess
import tempfile
import zipfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable

from ._git import try_get_git_metadata
from ._json import write_json
from ._paths import manifest_cwd
from ._time import utc_now_iso
from .artifact_report import write_artifact_report


DEFAULT_GENERAL_SKILLS: tuple[str, ...] = (
    "review-swarm",
    "claude-cli-runner",
    "gemini-cli-runner",
    "md-toc-latex-unescape",
    "referee-review",
    "research-team",
    "research-writer",
)

DEFAULT_EXCLUDED_SKILLS: tuple[str, ...] = (
    # Large / specialized / heavy external deps (keep as add-ons for v0).
    "hep-calc",
    "deep-learning-lab",
    # Deprecated / will be removed from upstream Codex skills; never ship in the core bundle.
    "research-team-audit",
    # Repo-maintenance / niche utilities (not part of end-user core bundle).
    "hep-mcp-doc-branch-hygiene",
    "hep-mcp-integration-qa",
    "hep-mcp-tool-contract",
    "hep-mcp-worktree-sync",
)

_SECRET_ASSIGNMENT_RE = re.compile(
    r"(?im)^(?:export\s+)?(?:OPENAI_API_KEY|ANTHROPIC_API_KEY|GEMINI_API_KEY|GOOGLE_API_KEY|AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY|GITHUB_TOKEN|HF_TOKEN|HUGGINGFACEHUB_API_TOKEN)\s*=\s*\S+"
)
_PRIVATE_KEY_HEADER_RE = re.compile(r"(?m)^-----BEGIN [A-Z0-9 ]{0,64}PRIVATE KEY-----")

_SENSITIVE_EXTENSIONS = (
    ".pem",
    ".key",
    ".p12",
    ".pfx",
    ".der",
    ".crt",
    ".cer",
    ".p7b",
)

_SENSITIVE_NAME_SUBSTRINGS = (
    "id_rsa",
    "id_ed25519",
    "private_key",
    "ssh_key",
    "apikey",
    "api_key",
    "access_token",
    "refresh_token",
    "secret",
    "password",
    "passwd",
    "credential",
)


@dataclass(frozen=True)
class EcosystemBundleInputs:
    tag: str
    bundle_basename: str = "core_bundle.zip"
    hep_mcp_package_dir: str | None = None
    skills_root: str | None = None
    include_skills: tuple[str, ...] = DEFAULT_GENERAL_SKILLS
    excluded_skills: tuple[str, ...] = DEFAULT_EXCLUDED_SKILLS
    run_smoke_checks: bool = True


def _rel(repo_root: Path, p: Path) -> str:
    try:
        return os.fspath(p.relative_to(repo_root))
    except Exception:  # CONTRACT-EXEMPT: CODE-01.5 diagnostic fallthrough
        return os.fspath(p)


def _run_capture(cmd: list[str], *, cwd: Path) -> tuple[int, str]:
    p = subprocess.run(
        cmd,
        cwd=cwd,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        encoding="utf-8",
        errors="replace",
        check=False,
    )
    return int(p.returncode), p.stdout.rstrip()


def _git(repo_root: Path, args: list[str]) -> str | None:
    rc, out = _run_capture(["git"] + args, cwd=repo_root)
    if rc != 0:
        return None
    return out.strip()


def _git_remote_url(repo_root: Path) -> str | None:
    for name in ["origin", "upstream"]:
        out = _git(repo_root, ["remote", "get-url", name])
        if out:
            return out
    return None


def _git_commit(repo_root: Path) -> str | None:
    out = _git(repo_root, ["rev-parse", "HEAD"])
    return out or None


def _git_is_dirty(repo_root: Path) -> bool | None:
    out = _git(repo_root, ["status", "--porcelain"])
    if out is None:
        return None
    return bool(out.strip())


def _git_ls_files(repo_root: Path, pathspecs: list[str]) -> list[str] | None:
    cmd = ["git", "-C", os.fspath(repo_root), "ls-files", "--"] + [str(p) for p in pathspecs]
    try:
        out = subprocess.check_output(cmd, stderr=subprocess.DEVNULL).decode("utf-8", "replace")
    except Exception:  # CONTRACT-EXEMPT: CODE-01.5 graceful degradation without git
        return None
    return [ln.strip() for ln in out.splitlines() if ln.strip()]


def _fallback_list_files(repo_root: Path, pathspecs: list[str]) -> list[str]:
    repo_root_r = repo_root.resolve()
    found: set[str] = set()

    def ignore_dir_name(name: str) -> bool:
        if not name:
            return False
        if name == ".git":
            return True
        if name == "__pycache__":
            return True
        return False

    for ps in pathspecs:
        ps_path = (repo_root_r / str(ps)).resolve()
        if not ps_path.exists():
            continue
        if ps_path.is_file():
            try:
                rel = os.fspath(ps_path.relative_to(repo_root_r)).replace(os.sep, "/")
            except Exception:  # CONTRACT-EXEMPT: CODE-01.5 skip unresolvable paths
                continue
            found.add(rel)
            continue
        if ps_path.is_dir():
            for p in ps_path.rglob("*"):
                if p.is_dir():
                    if ignore_dir_name(p.name):
                        continue
                    continue
                if not p.is_file():
                    continue
                if any(ignore_dir_name(part) for part in p.parts):
                    continue
                try:
                    rel = os.fspath(p.relative_to(repo_root_r)).replace(os.sep, "/")
                except Exception:  # CONTRACT-EXEMPT: CODE-01.5 skip unresolvable paths
                    continue
                found.add(rel)

    return sorted(found)


def _is_within(child: Path, parent: Path) -> bool:
    try:
        child.resolve().relative_to(parent.resolve())
        return True
    except Exception:  # CONTRACT-EXEMPT: CODE-01.5 deny-by-default path containment
        return False
def _copy_tracked_files(
    *,
    repo_root: Path,
    pathspecs: list[str],
    dst_root: Path,
    strip_prefix: str | None = None,
    exclude_prefixes: tuple[str, ...] | None = None,
) -> list[str]:
    tracked = _git_ls_files(repo_root, pathspecs)
    if tracked is None:
        tracked = _fallback_list_files(repo_root, pathspecs)
    copied: list[str] = []
    strip = (strip_prefix or "").replace("\\", "/").lstrip("/")
    strip = strip.rstrip("/") + "/" if strip and not strip.endswith("/") else strip

    repo_root_r = repo_root.resolve()
    excludes = tuple((p.replace("\\", "/") for p in (exclude_prefixes or ())))
    for rel in tracked:
        rel_norm = str(rel).replace("\\", "/")
        if excludes and any(rel_norm.startswith(pref) for pref in excludes):
            continue
        if strip and not rel_norm.startswith(strip):
            continue
        rel_after = rel_norm[len(strip) :] if strip else rel_norm
        if not rel_after:
            continue
        src = (repo_root / rel_norm).resolve()
        if not _is_within(src, repo_root_r):
            raise ValueError(f"refusing to copy path outside repo: {rel_norm}")
        if src.is_dir():
            continue
        dst = (dst_root / rel_after).resolve()
        if not _is_within(dst, dst_root.resolve()):
            raise ValueError(f"refusing to write outside dst_root: {rel_after}")
        dst.parent.mkdir(parents=True, exist_ok=True)
        if src.is_symlink():
            target = src.resolve()
            if not _is_within(target, repo_root_r):
                raise ValueError(f"refusing to follow symlink escaping repo: {rel_norm}")
            shutil.copy2(target, dst)
        else:
            shutil.copy2(src, dst)
        copied.append(rel_after)

    copied.sort()
    return copied


def _sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def _scan_secrets(root: Path) -> dict[str, Any]:
    root_r = root.resolve()
    findings: list[dict[str, Any]] = []
    scanned_files = 0
    max_bytes = 512 * 1024

    for p in sorted(root_r.rglob("*")):
        if not p.is_file():
            continue
        scanned_files += 1
        try:
            rel = os.fspath(p.relative_to(root_r)).replace(os.sep, "/")
        except Exception:  # CONTRACT-EXEMPT: CODE-01.5 diagnostic fallthrough
            rel = os.fspath(p)
        lower = rel.lower()
        ext = Path(lower).suffix

        for tok in _SENSITIVE_NAME_SUBSTRINGS:
            if tok in lower:
                findings.append({"path": rel, "kind": "suspicious_name", "detail": tok})
                break

        if ext in _SENSITIVE_EXTENSIONS:
            findings.append({"path": rel, "kind": "sensitive_extension", "detail": ext})

        try:
            raw = p.read_bytes()
        except Exception as e:
            findings.append({"path": rel, "kind": "unreadable", "detail": str(e)})
            continue

        head = raw[: min(len(raw), max_bytes)]
        if b"\x00" in head:
            continue
        text = head.decode("utf-8", errors="replace")
        if _PRIVATE_KEY_HEADER_RE.search(text):
            findings.append({"path": rel, "kind": "private_key_block", "detail": "pem_private_key"})
            continue
        if _SECRET_ASSIGNMENT_RE.search(text):
            findings.append({"path": rel, "kind": "secret_assignment", "detail": "env_assignment"})

    ok = not findings
    return {"ok": ok, "scanned_files": scanned_files, "findings": findings[:200]}


def _resolve_default_skills_root() -> Path:
    codex_home = os.environ.get("CODEX_HOME", "").strip()
    base = Path(codex_home).expanduser().resolve() if codex_home else (Path.home() / ".codex").resolve()
    return (base / "skills").resolve()


def _resolve_default_hep_mcp_package_dir() -> Path:
    env_override = os.environ.get("HEP_MCP_PACKAGE_DIR", "").strip()
    if env_override:
        return Path(env_override).expanduser().resolve()
    repo_candidate = Path(__file__).resolve().parents[5] / "packages" / "hep-mcp"
    candidates = [
        repo_candidate,
        Path.home() / "Coding/Agents/autoresearch-lab/packages/hep-mcp",
    ]
    for cand in candidates:
        if (cand / "dist/index.js").exists():
            return cand.resolve()
    for cand in candidates:
        if cand.exists():
            return cand.resolve()
    raise FileNotFoundError("cannot find hep-mcp package dir (set $HEP_MCP_PACKAGE_DIR)")


def _read_json_maybe(path: Path) -> dict[str, Any] | None:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:  # CONTRACT-EXEMPT: CODE-01.5 best-effort optional read
        return None


def _bundle_readme_md(*, bundle_dir: str) -> str:
    lines = [
        "# hep-autoresearch ecosystem bundle (v0)",
        "",
        "This bundle packages a **core environment snapshot** for hep-autoresearch development and usage.",
        "",
        "## Quick start",
        "",
        "```bash",
        f"cd {bundle_dir}",
        "python3 bootstrap.py --check",
        "```",
        "",
        "## Policy",
        "",
        "- This bundle intentionally does **not** embed secrets.",
        "- The bootstrap will **fail-fast** if secrets-like files are detected.",
        "- Provide secrets at runtime via environment variables / mounted volumes, never by committing them into the bundle.",
        "",
        "## Contents",
        "",
        "- `bundle_manifest.json`: pinned component list (human + machine readable).",
        "- `components/`: bundled sources (hep-autoresearch, hep-mcp package, selected skills).",
        "",
    ]
    return "\n".join(lines).rstrip() + "\n"


def _bootstrap_py() -> str:
    return (
        "from __future__ import annotations\n"
        "\n"
        "import argparse\n"
        "import json\n"
        "import os\n"
        "import re\n"
        "import sys\n"
        "from pathlib import Path\n"
        "\n"
        "_SECRET_ASSIGNMENT_RE = re.compile(\n"
        "    r\"(?im)^(?:export\\\\s+)?(?:OPENAI_API_KEY|ANTHROPIC_API_KEY|GEMINI_API_KEY|GOOGLE_API_KEY|AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY|GITHUB_TOKEN|HF_TOKEN|HUGGINGFACEHUB_API_TOKEN)\\\\s*=\\\\s*\\\\S+\"\n"
        ")\n"
        "_SENSITIVE_EXTENSIONS = {\".pem\", \".key\", \".p12\", \".pfx\", \".der\", \".crt\", \".cer\", \".p7b\"}\n"
        "_SENSITIVE_NAME_SUBSTRINGS = {\n"
        "    \"id_rsa\",\n"
        "    \"id_ed25519\",\n"
        "    \"private_key\",\n"
        "    \"ssh_key\",\n"
        "    \"apikey\",\n"
        "    \"api_key\",\n"
        "    \"access_token\",\n"
        "    \"refresh_token\",\n"
        "    \"secret\",\n"
        "    \"password\",\n"
        "    \"passwd\",\n"
        "    \"credential\",\n"
        "}\n"
        "_PRIVATE_KEY_HEADER_RE = re.compile(r\"(?m)^-----BEGIN [A-Z0-9 ]{0,64}PRIVATE KEY-----\")\n"
        "\n"
        "\n"
        "def scan(root: Path) -> dict:\n"
        "    root = root.resolve()\n"
        "    findings = []\n"
        "    scanned = 0\n"
        "    for p in sorted(root.rglob(\"*\")):\n"
        "        if not p.is_file():\n"
        "            continue\n"
        "        scanned += 1\n"
        "        try:\n"
        "            rel = os.fspath(p.relative_to(root)).replace(os.sep, \"/\")\n"
        "        except Exception:\n"
        "            rel = os.fspath(p)\n"
        "        lower = rel.lower()\n"
        "        ext = Path(lower).suffix\n"
        "        for tok in _SENSITIVE_NAME_SUBSTRINGS:\n"
        "            if tok in lower:\n"
        "                findings.append({\"path\": rel, \"kind\": \"suspicious_name\", \"detail\": tok})\n"
        "                break\n"
        "        if ext in _SENSITIVE_EXTENSIONS:\n"
        "            findings.append({\"path\": rel, \"kind\": \"sensitive_extension\", \"detail\": ext})\n"
        "        try:\n"
        "            head = p.read_bytes()[: 512 * 1024]\n"
        "        except Exception as e:\n"
        "            findings.append({\"path\": rel, \"kind\": \"unreadable\", \"detail\": str(e)})\n"
        "            continue\n"
        "        if b\"\\x00\" in head:\n"
        "            continue\n"
        "        text = head.decode(\"utf-8\", errors=\"replace\")\n"
        "        if _PRIVATE_KEY_HEADER_RE.search(text):\n"
        "            findings.append({\"path\": rel, \"kind\": \"private_key_block\", \"detail\": \"pem_private_key\"})\n"
        "            continue\n"
        "        if _SECRET_ASSIGNMENT_RE.search(text):\n"
        "            findings.append({\"path\": rel, \"kind\": \"secret_assignment\", \"detail\": \"env_assignment\"})\n"
        "    return {\"ok\": not findings, \"scanned_files\": scanned, \"findings\": findings[:200]}\n"
        "\n"
        "\n"
        "def main() -> int:\n"
        "    ap = argparse.ArgumentParser(description=\"Bootstrap/check for hep-autoresearch ecosystem bundle (v0).\")\n"
        "    ap.add_argument(\"--check\", action=\"store_true\", help=\"Run secret scan + sanity checks only.\")\n"
        "    ap.add_argument(\"--json\", action=\"store_true\", help=\"Output machine-readable JSON.\")\n"
        "    args = ap.parse_args()\n"
        "\n"
        "    root = Path.cwd()\n"
        "    res = {\"secret_scan\": scan(root)}\n"
        "    ok = bool(res[\"secret_scan\"][\"ok\"])\n"
        "    if args.json:\n"
        "        print(json.dumps(res, indent=2, sort_keys=True))\n"
        "        return 0 if ok else 2\n"
        "    if ok:\n"
        "        print(\"[ok] secret scan passed\")\n"
        "        print(\"Next steps:\")\n"
        "        print(\"- install deps (python/node) as needed\")\n"
        "        print(\"- set env vars at runtime (do not bake secrets into the bundle)\")\n"
        "        return 0\n"
        "    print(\"[error] secret scan failed; refusing to bootstrap\")\n"
        "    for f in res[\"secret_scan\"][\"findings\"][:20]:\n"
        "        print(f\"- {f['kind']}: {f['path']} ({f.get('detail')})\")\n"
        "    if len(res[\"secret_scan\"][\"findings\"]) > 20:\n"
        "        print(f\"- ... ({len(res['secret_scan']['findings']) - 20} more)\")\n"
        "    return 2\n"
        "\n"
        "\n"
        "if __name__ == \"__main__\":\n"
        "    raise SystemExit(main())\n"
    )


def ecosystem_bundle_one(inps: EcosystemBundleInputs, repo_root: Path) -> dict[str, Any]:
    tag = str(inps.tag).strip()
    if not tag:
        raise ValueError("tag is required")

    created_at = utc_now_iso()
    out_dir = repo_root / "artifacts" / "runs" / tag / "ecosystem_bundle"
    out_dir.mkdir(parents=True, exist_ok=True)

    bundle_zip_path = out_dir / str(inps.bundle_basename)
    bundle_manifest_path = out_dir / "bundle_manifest.json"
    manifest_path = out_dir / "manifest.json"
    summary_path = out_dir / "summary.json"
    analysis_path = out_dir / "analysis.json"
    report_path = out_dir / "report.md"

    # Resolve sources.
    skills_root = (
        Path(inps.skills_root).expanduser().resolve()
        if inps.skills_root
        else _resolve_default_skills_root()
    )
    hep_mcp_package_dir = (
        Path(inps.hep_mcp_package_dir).expanduser().resolve()
        if inps.hep_mcp_package_dir
        else _resolve_default_hep_mcp_package_dir()
    )
    hep_mcp_repo_root = hep_mcp_package_dir.parent.parent

    # Prepare staging dir.
    stage_root = out_dir / "_stage"
    if stage_root.exists():
        shutil.rmtree(stage_root)
    stage_root.mkdir(parents=True, exist_ok=True)
    bundle_root = stage_root / "hep-autoresearch-ecosystem-bundle-v0"
    components_root = bundle_root / "components"
    components_root.mkdir(parents=True, exist_ok=True)

    # Copy hep-autoresearch (this repo) — allowlist tracked paths only.
    hepar_dst = components_root / "hep-autoresearch"
    hepar_dst.mkdir(parents=True, exist_ok=True)
    hepar_allow = [
        "src",
        "docs",
        "scripts",
        "specs",
        "workflows",
        "templates",
        "evals",
        "tests",
        "bin",
        "README.md",
        "README.zh.md",
        "project_charter.md",
        "PROJECT_CHARTER.zh.md",
        "project_index.md",
        "research_plan.md",
        "RESEARCH_PLAN.zh.md",
        "research_preflight.md",
        "TOOLKIT_API.md",
        "TOOLKIT_API.zh.md",
        "AGENTS.md",
        "project_brief.md",
        "MANIFEST.in",
        "pyproject.toml",
        "package.json",
        "research_team_config.json",
        "scan_dependency_rules.json",
    ]
    hepar_copied = _copy_tracked_files(repo_root=repo_root, pathspecs=hepar_allow, dst_root=hepar_dst)

    # Copy hep-mcp (package snapshot + lockfiles).
    hep_mcp_dst = components_root / "hep-mcp"
    hep_mcp_dst.mkdir(parents=True, exist_ok=True)
    hep_mcp_prefix = str(hep_mcp_package_dir.relative_to(hep_mcp_repo_root)).replace("\\", "/")
    hep_mcp_paths = [
        hep_mcp_prefix,
        "package.json",
        "pnpm-lock.yaml",
        "pnpm-workspace.yaml",
    ]
    hep_mcp_copied = _copy_tracked_files(
        repo_root=hep_mcp_repo_root,
        pathspecs=hep_mcp_paths,
        dst_root=hep_mcp_dst,
        strip_prefix=None,
    )
    # Also include built dist/ artifacts when present (may be gitignored but required for runtime).
    hep_mcp_dist_copied: list[str] = []
    dist_dir = (hep_mcp_package_dir / "dist").resolve()
    if dist_dir.exists() and dist_dir.is_dir():
        for p in sorted(dist_dir.rglob("*")):
            if not p.is_file():
                continue
            try:
                rel_to_repo = os.fspath(p.relative_to(hep_mcp_repo_root.resolve())).replace(os.sep, "/")
            except Exception:  # CONTRACT-EXEMPT: CODE-01.5 skip unresolvable paths
                continue
            dst = (hep_mcp_dst / rel_to_repo).resolve()
            if not _is_within(dst, hep_mcp_dst.resolve()):
                raise ValueError(f"refusing to write outside hep_mcp_dst: {rel_to_repo}")
            dst.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(p, dst)
            hep_mcp_dist_copied.append(rel_to_repo)
    hep_mcp_dist_copied.sort()

    # Copy selected skills (tracked files only).
    skills_dst = components_root / "skills"
    skills_dst.mkdir(parents=True, exist_ok=True)
    skills_included: list[dict[str, Any]] = []
    for name in inps.include_skills:
        if name in inps.excluded_skills:
            continue
        dst = skills_dst / name
        dst.mkdir(parents=True, exist_ok=True)
        src_external = (skills_root / name).resolve()
        src_internal = (repo_root / ".codex" / "skills" / name).resolve()

        skill_source = "external"
        copied: list[str] = []
        if src_external.exists() and src_external.is_dir():
            copied = _copy_tracked_files(
                repo_root=src_external,
                pathspecs=["."],
                dst_root=dst,
                exclude_prefixes=(".tmp", "team/", "artifacts/"),
            )
        elif src_internal.exists() and src_internal.is_dir():
            skill_source = "repo_internal"
            strip_prefix = ".codex/skills/" + name
            copied = _copy_tracked_files(
                repo_root=repo_root,
                pathspecs=[strip_prefix],
                dst_root=dst,
                strip_prefix=strip_prefix,
                exclude_prefixes=(".tmp", "team/", "artifacts/"),
            )
        else:
            continue
        skills_included.append(
            {
                "name": name,
                "source": skill_source,
                "commit": _git_commit(src_external if skill_source == "external" else repo_root),
                "dirty": _git_is_dirty(src_external if skill_source == "external" else repo_root),
                "remote_url": _git_remote_url(src_external if skill_source == "external" else repo_root),
                "files_copied": len(copied),
            }
        )

    # Add bundle README + bootstrap.
    (bundle_root / "README.md").write_text(
        _bundle_readme_md(bundle_dir="."), encoding="utf-8"
    )
    (bundle_root / "bootstrap.py").write_text(_bootstrap_py(), encoding="utf-8")
    (bundle_root / "bootstrap.sh").write_text(
        "#!/usr/bin/env bash\nset -euo pipefail\npython3 bootstrap.py --check\n",
        encoding="utf-8",
    )
    try:
        os.chmod(bundle_root / "bootstrap.sh", 0o755)
    except Exception:  # CONTRACT-EXEMPT: CODE-01.5 best-effort chmod
        pass

    # Add minimal add-ons note.
    addons_dir = components_root / "addons"
    addons_dir.mkdir(parents=True, exist_ok=True)
    (addons_dir / "README.md").write_text(
        "# Add-ons\n\nAdd-ons are intentionally not included in the core bundle v0.\n", encoding="utf-8"
    )

    # Bundle manifest (pinned versions + sources).
    hep_mcp_pkg = _read_json_maybe(hep_mcp_repo_root / "package.json") or {}
    bundle_manifest: dict[str, Any] = {
        "schema_version": 1,
        "created_at": created_at,
        "bundle_id": "hep-autoresearch-ecosystem-bundle-v0",
        "components": {
            "hep-autoresearch": {
                "commit": _git_commit(repo_root),
                "dirty": _git_is_dirty(repo_root),
                "remote_url": _git_remote_url(repo_root),
                "paths": hepar_allow,
                "files_copied": len(hepar_copied),
            },
            "hep-mcp": {
                "commit": _git_commit(hep_mcp_repo_root),
                "dirty": _git_is_dirty(hep_mcp_repo_root),
                "remote_url": _git_remote_url(hep_mcp_repo_root),
                "package_version": hep_mcp_pkg.get("version"),
                "package_subdir": hep_mcp_prefix,
                "files_copied": len(hep_mcp_copied),
                "dist_files_copied": len(hep_mcp_dist_copied),
            },
            "skills": {"root": "components/skills", "included": skills_included},
        },
        "policy": {
            "secrets_in_bundle": "forbidden",
            "secrets_delivery": "runtime_env_or_volumes",
        },
    }
    (bundle_root / "bundle_manifest.json").write_text(
        json.dumps(bundle_manifest, indent=2, sort_keys=True) + "\n", encoding="utf-8"
    )

    # Secret scan (stage root).
    secret_scan = _scan_secrets(bundle_root)
    demo_secret_scan: dict[str, Any] | None = None
    if inps.run_smoke_checks:
        # Demo: ensure scan detects a secrets-like file.
        demo_path = bundle_root / "DEMO_OPENAI_API_KEY.env"
        demo_path.write_text("OPENAI_API_KEY=sk-demo-should-not-ship\n", encoding="utf-8")
        demo_secret_scan = _scan_secrets(bundle_root)
        try:
            demo_path.unlink()
        except Exception:  # CONTRACT-EXEMPT: CODE-01.5 best-effort cleanup
            pass

    if not secret_scan.get("ok"):
        raise RuntimeError(f"secret scan failed; refusing to build bundle zip ({len(secret_scan.get('findings') or [])} findings)")

    # Zip bundle.
    with zipfile.ZipFile(bundle_zip_path, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        for p in sorted(bundle_root.rglob("*")):
            if p.is_dir():
                continue
            rel = os.fspath(p.relative_to(stage_root)).replace(os.sep, "/")
            zf.write(p, arcname=rel)

    # Smoke checks: run bootstrap on extracted bundle + show that secret file triggers failure.
    bootstrap_smoke: dict[str, Any] | None = None
    if inps.run_smoke_checks:
        with tempfile.TemporaryDirectory(prefix="hepar_bundle_smoke_") as td:
            td_path = Path(td)
            with zipfile.ZipFile(bundle_zip_path, "r") as zf:
                zf.extractall(td_path)
            extracted_root = td_path / "hep-autoresearch-ecosystem-bundle-v0"
            ok_rc, ok_out = _run_capture(["python3", "bootstrap.py", "--check"], cwd=extracted_root)
            # Inject a file that should be flagged.
            (extracted_root / "id_rsa").write_text("-----BEGIN PRIVATE KEY-----\nX\n-----END PRIVATE KEY-----\n", encoding="utf-8")
            bad_rc, bad_out = _run_capture(["python3", "bootstrap.py", "--check"], cwd=extracted_root)
            bootstrap_smoke = {
                "ok_rc": ok_rc,
                "ok_stdout": ok_out,
                "bad_rc": bad_rc,
                "bad_stdout": bad_out,
                "bad_expected_nonzero": bool(bad_rc != 0),
            }

    # Clean up staging to keep the evidence footprint small (zip is SSOT for the bundle payload).
    try:
        shutil.rmtree(stage_root)
    except Exception:  # CONTRACT-EXEMPT: CODE-01.5 best-effort cleanup
        pass

    bundle_bytes = int(bundle_zip_path.stat().st_size) if bundle_zip_path.exists() else 0
    bundle_sha256 = _sha256_file(bundle_zip_path) if bundle_zip_path.exists() else None

    versions: dict[str, Any] = {"python": os.sys.version.split()[0], "os": platform.platform()}
    manifest: dict[str, Any] = {
        "schema_version": 1,
        "created_at": created_at,
        "command": "python3 scripts/run_ecosystem_bundle.py",
        "cwd": manifest_cwd(repo_root=repo_root, cwd=repo_root),
        "params": {
            "tag": tag,
            "bundle_basename": str(inps.bundle_basename),
            "skills_root": os.fspath(skills_root),
            "hep_mcp_package_dir": os.fspath(hep_mcp_package_dir),
            "include_skills": list(inps.include_skills),
            "excluded_skills": list(inps.excluded_skills),
            "run_smoke_checks": bool(inps.run_smoke_checks),
        },
        "versions": versions,
        "outputs": [],
    }
    git_meta = try_get_git_metadata(repo_root)
    if git_meta:
        manifest["git"] = git_meta

    summary: dict[str, Any] = {
        "schema_version": 1,
        "created_at": created_at,
        "definitions": {"workflow": "RELEASE_ecosystem_bundle", "kind": "ecosystem_bundle"},
        "stats": {
            "skills_included": int(len(skills_included)),
            "bundle_bytes": int(bundle_bytes),
        },
        "outputs": {
            "bundle_zip": _rel(repo_root, bundle_zip_path),
            "bundle_manifest": _rel(repo_root, bundle_manifest_path),
        },
    }

    analysis: dict[str, Any] = {
        "schema_version": 1,
        "created_at": created_at,
        "inputs": {
            "tag": tag,
            "bundle_basename": str(inps.bundle_basename),
            "skills_root": os.fspath(skills_root),
            "hep_mcp_package_dir": os.fspath(hep_mcp_package_dir),
            "include_skills": list(inps.include_skills),
            "excluded_skills": list(inps.excluded_skills),
            "run_smoke_checks": bool(inps.run_smoke_checks),
        },
        "results": {
            "ok": True,
            "bundle": {
                "zip_path": _rel(repo_root, bundle_zip_path),
                "bytes": int(bundle_bytes),
                "sha256": bundle_sha256,
            },
            "components": {
                "hep-autoresearch": {
                    "files_copied": len(hepar_copied),
                    "remote_url": _git_remote_url(repo_root),
                    "commit": _git_commit(repo_root),
                },
                "hep-mcp": {
                    "files_copied": len(hep_mcp_copied),
                    "dist_files_copied": len(hep_mcp_dist_copied),
                    "remote_url": _git_remote_url(hep_mcp_repo_root),
                    "commit": _git_commit(hep_mcp_repo_root),
                    "package_version": hep_mcp_pkg.get("version"),
                    "package_subdir": hep_mcp_prefix,
                },
                "skills_included": skills_included,
            },
            "secret_scan": secret_scan,
            "secret_scan_demo": demo_secret_scan,
            "bootstrap_smoke": bootstrap_smoke,
        },
    }

    # Persist SSOT files.
    write_json(bundle_manifest_path, bundle_manifest)
    outputs: list[str] = [
        _rel(repo_root, bundle_zip_path),
        _rel(repo_root, bundle_manifest_path),
        _rel(repo_root, manifest_path),
        _rel(repo_root, summary_path),
        _rel(repo_root, analysis_path),
        _rel(repo_root, report_path),
    ]
    manifest["outputs"] = sorted(set(outputs))
    write_json(manifest_path, manifest)
    write_json(summary_path, summary)
    write_json(analysis_path, analysis)
    report_rel = write_artifact_report(
        repo_root=repo_root,
        artifact_dir=out_dir,
        manifest=manifest,
        summary=summary,
        analysis=analysis,
    )

    return {
        "artifact_dir": _rel(repo_root, out_dir),
        "artifact_paths": {
            "manifest": _rel(repo_root, manifest_path),
            "summary": _rel(repo_root, summary_path),
            "analysis": _rel(repo_root, analysis_path),
            "report": report_rel,
            "bundle_zip": _rel(repo_root, bundle_zip_path),
            "bundle_manifest": _rel(repo_root, bundle_manifest_path),
        },
    }
