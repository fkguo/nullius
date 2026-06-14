#!/usr/bin/env python3
from __future__ import annotations

import argparse
import datetime as _dt
import json
import os
from pathlib import Path


AUTO_START = "<!-- PROJECT_INDEX_AUTO_START -->"
AUTO_END = "<!-- PROJECT_INDEX_AUTO_END -->"


def _utc_now() -> str:
    return _dt.datetime.utcnow().replace(microsecond=0).isoformat() + "Z"


def _read_text(path: Path) -> str:
    return path.read_text(encoding="utf-8", errors="replace").replace("\r\n", "\n").replace("\r", "\n")


def _write_text(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text.replace("\r\n", "\n").replace("\r", "\n"), encoding="utf-8")


def _find_project_root(seed: Path) -> Path:
    cur = seed.resolve()
    if cur.is_file():
        cur = cur.parent
    for _ in range(8):
        # Prefer the canonical scaffold markers.
        if (cur / "project_charter.md").is_file() and (cur / "research_contract.md").is_file():
            return cur
        if cur.parent == cur:
            break
        cur = cur.parent
    return seed.parent.resolve() if seed.is_file() else seed.resolve()


def _pick_latest_run_dir(team_dir: Path) -> Path | None:
    runs = team_dir / "runs"
    if not runs.is_dir():
        return None
    best: tuple[float, Path] | None = None
    for p in runs.iterdir():
        if not p.is_dir():
            continue
        try:
            mtime = p.stat().st_mtime
        except Exception:
            continue
        if best is None or mtime > best[0]:
            best = (mtime, p)
    return best[1] if best else None


def _infer_latest_tag_and_status(
    project_root: Path,
    team_dir: Path,
    tag_arg: str,
    status_arg: str,
    latest_kind: str,
) -> tuple[str, str]:
    tag = (tag_arg or "").strip()
    status = (status_arg or "").strip()

    if latest_kind == "draft":
        # Draft pointers must not infer state from generic team runs.
        return (tag, status) if tag and status else ("", "")

    if tag and status:
        return tag, status

    latest_dir = _pick_latest_run_dir(team_dir)
    if latest_dir is not None and not tag:
        tag = latest_dir.name

    if tag and not status:
        traj = team_dir / "trajectory_index.json"
        if traj.is_file():
            try:
                obj = json.loads(_read_text(traj))
                runs = obj.get("runs", []) if isinstance(obj, dict) else []
                if isinstance(runs, list):
                    # Prefer converged/not_converged for this tag; otherwise take most recent stage.
                    candidates = [r for r in runs if isinstance(r, dict) and r.get("tag") == tag]
                    stage_rank = {"converged": 3, "not_converged": 2, "member_reports": 1, "preflight_ok": 0}
                    best = None
                    for r in candidates:
                        st = str(r.get("stage") or "")
                        rank = stage_rank.get(st, -1)
                        if best is None or rank > best[0]:
                            best = (rank, st)
                    if best is not None and best[1]:
                        status = best[1]
            except Exception:
                pass

    return tag, status


def _detect_latest_artifacts_dir(project_root: Path, tag: str) -> Path | None:
    if not tag:
        return None
    cand = project_root / "artifacts" / "runs" / tag
    if cand.is_dir():
        return cand
    cand = project_root / "artifacts" / tag
    if cand.is_dir():
        return cand
    return None


def _ensure_project_map_exists(project_root: Path) -> Path:
    path = project_root / "project_index.md"
    if path.is_file():
        return path

    title = project_root.name
    lines: list[str] = []
    lines.append(f"# {title} — project_index")
    lines.append("")
    lines.append(f"Last updated: {_utc_now()}")
    lines.append("")
    lines.append("## Read first (in order)")
    lines.append("")
    lines.append("1) [project_charter.md](project_charter.md)")
    lines.append("2) [research_plan.md](research_plan.md)")
    lines.append("3) [research_notebook.md](research_notebook.md)")
    lines.append("4) [research_contract.md](research_contract.md)")
    lines.append("5) [AGENTS.md](AGENTS.md)")
    lines.append("")
    lines.append("## Core working surfaces")
    lines.append("")
    lines.append("- Human primary file: [research_notebook.md](research_notebook.md)")
    lines.append("- Machine contract: [research_contract.md](research_contract.md)")
    lines.append("- Canonical artifact root: `artifacts/runs/<run_id>/`")
    lines.append("- Run identity rule: use a safe, sortable, readable `run_id` such as `<YYYYMMDDTHHMMSSZ>-<milestone>-<short-topic>-rN`; do not use bare UUIDs or `run_<uuid>` as human-facing research run names.")
    lines.append("")
    lines.append("---")
    lines.append("")
    lines.append(AUTO_START)
    lines.append("<!-- This block is auto-generated. Do not edit by hand. -->")
    lines.append(AUTO_END)
    lines.append("")
    lines.append("## Notes (manual)")
    lines.append("")
    lines.append("-")
    _write_text(path, "\n".join(lines) + "\n")
    return path


def _replace_auto_block(text: str, new_block: str) -> str:
    if AUTO_START not in text or AUTO_END not in text:
        # Append a block if missing.
        sep = "" if text.endswith("\n") else "\n"
        return text + sep + AUTO_START + "\n" + new_block.rstrip() + "\n" + AUTO_END + "\n"
    a = text.index(AUTO_START) + len(AUTO_START)
    b = text.index(AUTO_END)
    return text[:a] + "\n" + new_block.rstrip() + "\n" + text[b:]


def _draft_template_path() -> Path:
    return Path(__file__).resolve().parents[2] / "assets" / "team_latest_draft_template.md"


def _asset_template_path(name: str) -> Path:
    return Path(__file__).resolve().parents[2] / "assets" / name


def _extract_pointer_field(text: str, prefix: str) -> str:
    needle = prefix.lower()
    for line in text.splitlines():
        stripped = line.strip()
        if stripped.lower().startswith(needle):
            return stripped.split(":", 1)[1].strip()
    return ""


def _detect_team_run_dir(team_dir: Path, tag: str) -> Path | None:
    if not _active_pointer_value(tag):
        return None
    cand = team_dir / "runs" / tag
    if cand.is_dir():
        return cand
    return None


def _matches_placeholder_template(path: Path, template_name: str, *, fallback_tokens: tuple[str, ...]) -> bool:
    if not path.is_file():
        return False
    text = _read_text(path)
    try:
        return text == _read_text(_asset_template_path(template_name))
    except Exception:
        return all(token in text for token in fallback_tokens)


def _write_team_latest_index(team_dir: Path, *, include_team: bool = False, include_draft: bool = False) -> None:
    path = team_dir / "LATEST.md"
    lines: list[str] = []
    lines.append("# Latest pointers")
    lines.append("")
    if include_team:
        lines.append("- Team cycle: [LATEST_TEAM.md](LATEST_TEAM.md)")
    if include_draft:
        lines.append("- Draft cycle: [LATEST_DRAFT.md](LATEST_DRAFT.md)")
    lines.append("- Trajectory index: [trajectory_index.json](trajectory_index.json)")
    _write_text(path, "\n".join(lines) + "\n")


def _write_latest_team_cycle(team_dir: Path, tag: str, status: str, run_dir: Path | None) -> None:
    path = team_dir / "LATEST_TEAM.md"
    lines: list[str] = []
    lines.append("# Latest Team Cycle")
    lines.append("")
    lines.append(f"Last updated: {_utc_now()}")
    lines.append("")
    lines.append(f"- Latest tag: {tag or '(none)'}")
    lines.append(f"- Status: {status or '(unknown)'}")
    if run_dir is not None and run_dir.is_dir():
        rel = os.path.relpath(run_dir, team_dir)
        if not rel.startswith("."):
            rel = "./" + rel
        lines.append(f"- Run directory: [{rel}]({rel})")
        prefix = run_dir.name
        for name, label in (
            (f"{prefix}_member_a.md", "Member A report"),
            (f"{prefix}_member_b.md", "Member B report"),
            (f"{prefix}_member_c.md", "Member C report (if enabled)"),
            (f"{prefix}_adjudication.md", "Adjudication"),
            (f"team_packet_{prefix}.txt", "Team packet"),
        ):
            p = run_dir / name
            if p.is_file():
                relp = os.path.relpath(p, team_dir)
                if not relp.startswith("."):
                    relp = "./" + relp
                lines.append(f"- {label}: [{relp}]({relp})")
    lines.append("- Trajectory index: [trajectory_index.json](trajectory_index.json)")
    _write_text(path, "\n".join(lines) + "\n")


def _write_latest_draft_cycle(team_dir: Path, tag: str, status: str, run_dir: Path | None) -> None:
    path = team_dir / "LATEST_DRAFT.md"
    lines: list[str] = []
    lines.append("# Latest Draft Cycle")
    lines.append("")
    lines.append(f"Last updated: {_utc_now()}")
    lines.append("")
    lines.append("- Draft cycle state: active")
    lines.append(f"- Latest tag: {tag}")
    lines.append(f"- Status: {status}")
    if run_dir is not None and run_dir.is_dir():
        rel = os.path.relpath(run_dir, team_dir)
        if not rel.startswith("."):
            rel = "./" + rel
        lines.append(f"- Run directory: [{rel}]({rel})")
        prefix = run_dir.name
        for name, label in (
            (f"{prefix}_draft_packet.md", "Draft packet"),
            (f"{prefix}_draft_preflight.md", "Draft preflight report"),
            (f"{prefix}_draft_structure.json", "Draft structure JSON"),
            (f"{prefix}_draft_member_a.md", "Draft reviewer A"),
            (f"{prefix}_draft_member_b.md", "Draft reviewer B"),
            (f"{prefix}_draft_member_c_leader.md", "Draft leader audit (Member C)"),
            (f"{prefix}_draft_convergence_log.md", "Draft convergence log"),
            (f"{prefix}_draft_converged_summary.md", "Draft converged summary"),
        ):
            p = run_dir / name
            if p.is_file():
                relp = os.path.relpath(p, team_dir)
                if not relp.startswith("."):
                    relp = "./" + relp
                lines.append(f"- {label}: [{relp}]({relp})")
    lines.append("- Trajectory index: [trajectory_index.json](trajectory_index.json)")
    _write_text(path, "\n".join(lines) + "\n")


def _is_disabled_draft_placeholder(path: Path) -> bool:
    if not path.is_file():
        return False
    text = _read_text(path)
    try:
        return text == _read_text(_draft_template_path())
    except Exception:
        return "treat this file as a disabled status marker" in text and "- Draft cycle state: optional / not configured" in text


def _is_default_team_placeholder(path: Path) -> bool:
    return _matches_placeholder_template(
        path,
        "team_latest_team_template.md",
        fallback_tokens=(
            "Older scaffolds created this placeholder eagerly",
            "- Latest tag: (none yet)",
            "- Status: (none yet)",
        ),
    )


def _is_default_artifacts_placeholder(path: Path) -> bool:
    return _matches_placeholder_template(
        path,
        "artifacts_latest_template.md",
        fallback_tokens=(
            "Older scaffolds created this placeholder eagerly",
            "- Latest tag: (none yet)",
            "- Artifacts directory: (none yet)",
        ),
    )


def _read_existing_team_state(team_dir: Path) -> tuple[str, str, bool]:
    path = team_dir / "LATEST_TEAM.md"
    if not path.is_file() or _is_default_team_placeholder(path):
        return "", "", False
    text = _read_text(path)
    tag = _extract_pointer_field(text, "- Latest tag:")
    status = _extract_pointer_field(text, "- Status:")
    active = _active_pointer_value(tag) and _active_pointer_value(status) and _detect_team_run_dir(team_dir, tag) is not None
    return tag, status, active


def _read_existing_draft_state(team_dir: Path) -> tuple[str, str, bool]:
    path = team_dir / "LATEST_DRAFT.md"
    if not path.is_file():
        return "", "", False
    if _is_disabled_draft_placeholder(path):
        return "", "", False
    text = _read_text(path)
    tag = _extract_pointer_field(text, "- Latest tag:")
    status = _extract_pointer_field(text, "- Status:")
    active = "- Draft cycle state: active" in text
    if not active and _active_pointer_value(tag) and _active_pointer_value(status):
        active = True
    if active and _detect_team_run_dir(team_dir, tag) is None:
        active = False
    return tag, status, active


def _remove_inactive_draft_pointer(team_dir: Path) -> bool:
    path = team_dir / "LATEST_DRAFT.md"
    if not _is_disabled_draft_placeholder(path):
        return False
    path.unlink()
    return True


def _remove_default_team_pointer(team_dir: Path) -> bool:
    path = team_dir / "LATEST_TEAM.md"
    if not _is_default_team_placeholder(path):
        return False
    path.unlink()
    return True


def _remove_default_artifacts_pointer(artifacts_dir: Path) -> bool:
    path = artifacts_dir / "LATEST.md"
    if not _is_default_artifacts_placeholder(path):
        return False
    path.unlink()
    return True


def _write_artifacts_latest(artifacts_dir: Path, tag: str, artifacts_run: Path | None) -> None:
    if artifacts_run is None or not artifacts_run.is_dir():
        return
    lines: list[str] = []
    lines.append("# Latest Artifacts")
    lines.append("")
    lines.append(f"Last updated: {_utc_now()}")
    lines.append("")
    lines.append(f"- Latest tag: {tag}")
    rel = os.path.relpath(artifacts_run, artifacts_dir)
    if not rel.startswith("."):
        rel = "./" + rel
    label = "Canonical artifacts directory" if rel.startswith("./runs/") else "Legacy/provider artifacts directory"
    lines.append(f"- {label}: [{rel}]({rel})")
    _write_text(artifacts_dir / "LATEST.md", "\n".join(lines) + "\n")


def _parse_project_map_auto_state(text: str) -> dict[str, str]:
    """
    Best-effort parse of the auto block so we can update one side (team/draft)
    without deleting the other.
    """
    out: dict[str, str] = {
        "team_tag": "",
        "team_status": "",
        "draft_tag": "",
        "draft_status": "",
    }
    if AUTO_START not in text or AUTO_END not in text:
        return out
    a = text.index(AUTO_START) + len(AUTO_START)
    b = text.index(AUTO_END)
    block = text[a:b]
    for ln in block.splitlines():
        s = ln.strip()
        if s.lower().startswith("- team latest tag:"):
            out["team_tag"] = s.split(":", 1)[1].strip()
        elif s.lower().startswith("- team latest status:"):
            out["team_status"] = s.split(":", 1)[1].strip()
        elif s.lower().startswith("- draft latest tag:"):
            out["draft_tag"] = s.split(":", 1)[1].strip()
        elif s.lower().startswith("- draft latest status:"):
            out["draft_status"] = s.split(":", 1)[1].strip()
    return out


def _active_pointer_value(value: str) -> bool:
    value = (value or "").strip()
    return bool(value) and value not in {
        "(none)",
        "(unknown)",
        "(no draft cycle has run yet)",
        "not configured",
    }


def _has_active_draft_state(team_dir: Path, state: dict[str, str]) -> bool:
    if (
        _active_pointer_value(state.get("draft_tag", ""))
        and _active_pointer_value(state.get("draft_status", ""))
        and _detect_team_run_dir(team_dir, state["draft_tag"]) is not None
    ):
        return True
    _, _, active = _read_existing_draft_state(team_dir)
    return active


def _has_live_artifacts_pointer(artifacts_dir: Path) -> bool:
    path = artifacts_dir / "LATEST.md"
    if not path.is_file() or _is_default_artifacts_placeholder(path):
        return False
    tag = _extract_pointer_field(_read_text(path), "- Latest tag:")
    return _active_pointer_value(tag) and _detect_latest_artifacts_dir(artifacts_dir.parent, tag) is not None


def main() -> int:
    ap = argparse.ArgumentParser(description="Update project_index.md + latest pointers deterministically.")
    ap.add_argument("--notes", type=Path, required=True, help="Path to research_contract.md (used to locate project root).")
    ap.add_argument("--team-dir", type=Path, default=Path("team"), help="Team output directory (default: team).")
    ap.add_argument("--latest-kind", choices=("team", "draft"), default="team", help="Which pointer to update (team or draft).")
    ap.add_argument("--tag", default="", help="Latest tag to record (optional).")
    ap.add_argument("--status", default="", help="Status/stage to record (optional).")
    ap.add_argument("--run-dir", type=Path, default=None, help="Explicit run dir for the tag (optional).")
    args = ap.parse_args()

    if not args.notes.exists():
        print(f"ERROR: notes not found: {args.notes}")
        return 2

    project_root = _find_project_root(args.notes)
    team_dir = args.team_dir if args.team_dir.is_absolute() else (project_root / args.team_dir)
    artifacts_dir = project_root / "artifacts"
    team_dir.mkdir(parents=True, exist_ok=True)
    artifacts_dir.mkdir(parents=True, exist_ok=True)

    _ensure_project_map_exists(project_root)

    map_path = project_root / "project_index.md"
    text = _read_text(map_path) if map_path.is_file() else ""
    state = _parse_project_map_auto_state(text)
    existing_team_tag, existing_team_status, existing_team_active = _read_existing_team_state(team_dir)
    if existing_team_active:
        if not _active_pointer_value(state.get("team_tag", "")):
            state["team_tag"] = existing_team_tag
        if not _active_pointer_value(state.get("team_status", "")):
            state["team_status"] = existing_team_status
    existing_draft_tag, existing_draft_status, existing_draft_active = _read_existing_draft_state(team_dir)
    if existing_draft_active:
        if not _active_pointer_value(state.get("draft_tag", "")):
            state["draft_tag"] = existing_draft_tag
        if not _active_pointer_value(state.get("draft_status", "")):
            state["draft_status"] = existing_draft_status

    kind = args.latest_kind
    tag, status = _infer_latest_tag_and_status(project_root, team_dir, args.tag, args.status, kind)
    if kind == "team":
        if tag and status:
            state["team_tag"] = tag
            state["team_status"] = status
        elif not existing_team_active:
            state["team_tag"] = ""
            state["team_status"] = ""
    else:
        if tag and status:
            state["draft_tag"] = tag
            state["draft_status"] = status
        elif not existing_draft_active:
            state["draft_tag"] = ""
            state["draft_status"] = ""

    team_run_dir = None
    if kind == "team" and _active_pointer_value(state.get("team_tag", "")) and _active_pointer_value(state.get("team_status", "")):
        team_run_dir = args.run_dir
        if team_run_dir is not None and not team_run_dir.is_dir():
            team_run_dir = None
        if team_run_dir is None:
            team_run_dir = _detect_team_run_dir(team_dir, state["team_tag"])
    team_pointer_active = (
        _active_pointer_value(state.get("team_tag", ""))
        and _active_pointer_value(state.get("team_status", ""))
        and team_run_dir is not None
    )

    draft_run_dir = None
    if kind == "draft" and _active_pointer_value(state.get("draft_tag", "")) and _active_pointer_value(state.get("draft_status", "")):
        draft_run_dir = args.run_dir
        if draft_run_dir is not None and not draft_run_dir.is_dir():
            draft_run_dir = None
        if draft_run_dir is None:
            draft_run_dir = _detect_team_run_dir(team_dir, state["draft_tag"])
    draft_pointer_active = (
        _active_pointer_value(state.get("draft_tag", ""))
        and _active_pointer_value(state.get("draft_status", ""))
        and draft_run_dir is not None
    )

    if kind == "team":
        if team_pointer_active:
            _write_latest_team_cycle(team_dir, state["team_tag"], state["team_status"], team_run_dir)
        else:
            _remove_default_team_pointer(team_dir)
    else:
        if draft_pointer_active:
            _write_latest_draft_cycle(team_dir, state["draft_tag"], state["draft_status"], draft_run_dir)
        else:
            _remove_inactive_draft_pointer(team_dir)

    # Artifacts pointer: prefer a live TEAM tag, otherwise a live DRAFT tag.
    artifacts_tag = state["team_tag"] if team_pointer_active else state["draft_tag"] if draft_pointer_active else ""
    artifacts_run = _detect_latest_artifacts_dir(project_root, artifacts_tag)
    artifacts_updated = False
    if artifacts_run is not None:
        _write_artifacts_latest(artifacts_dir, artifacts_tag, artifacts_run)
        artifacts_updated = True
    else:
        _remove_default_artifacts_pointer(artifacts_dir)

    auto_lines: list[str] = []
    auto_lines.append(f"- Auto-updated at: {_utc_now()}")
    auto_lines.append("- Latest pointers: [team/LATEST.md](team/LATEST.md)")
    if team_pointer_active:
        auto_lines.append(f"- Team latest tag: {state['team_tag']}")
        auto_lines.append(f"- Team latest status: {state['team_status']}")
        auto_lines.append("- Latest team: [team/LATEST_TEAM.md](team/LATEST_TEAM.md)")
    include_draft = _has_active_draft_state(team_dir, state)
    if include_draft:
        if not _active_pointer_value(state.get("draft_tag", "")):
            state["draft_tag"] = existing_draft_tag
        if not _active_pointer_value(state.get("draft_status", "")):
            state["draft_status"] = existing_draft_status
        auto_lines.append(f"- Draft latest tag: {state['draft_tag']}")
        auto_lines.append(f"- Draft latest status: {state['draft_status']}")
        auto_lines.append("- Latest draft: [team/LATEST_DRAFT.md](team/LATEST_DRAFT.md)")
    include_artifacts = artifacts_updated or _has_live_artifacts_pointer(artifacts_dir)
    if include_artifacts:
        auto_lines.append("- Latest artifacts: [artifacts/LATEST.md](artifacts/LATEST.md)")

    new_text = _replace_auto_block(text, "\n".join(auto_lines))
    # Keep/update a Last updated: line near the top if present.
    lines = new_text.splitlines()
    for i, ln in enumerate(lines[:15]):
        if ln.strip().lower().startswith("last updated:"):
            lines[i] = f"Last updated: {_utc_now()}"
            break
    new_text = "\n".join(lines) + "\n"
    _write_text(map_path, new_text)
    _write_team_latest_index(team_dir, include_team=team_pointer_active, include_draft=include_draft)

    print(f"[ok] updated: {map_path}")
    print(f"[ok] updated: {team_dir / 'LATEST.md'}")
    if kind == "team" and team_pointer_active:
        print(f"[ok] updated: {team_dir / 'LATEST_TEAM.md'}")
    elif kind == "team":
        print(f"[ok] skipped: {team_dir / 'LATEST_TEAM.md'} (no team tag/status)")
    elif include_draft:
        print(f"[ok] updated: {team_dir / 'LATEST_DRAFT.md'}")
    else:
        print(f"[ok] skipped: {team_dir / 'LATEST_DRAFT.md'} (no draft tag/status)")
    if include_artifacts:
        print(f"[ok] updated: {artifacts_dir / 'LATEST.md'}")
    else:
        print(f"[ok] skipped: {artifacts_dir / 'LATEST.md'} (no artifact run)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
