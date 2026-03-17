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
) -> tuple[str, str]:
    tag = (tag_arg or "").strip()
    status = (status_arg or "").strip()

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
    lines.append("- Artifact root: `artifacts/runs/<TAG>/`")
    lines.append("- Local MCP config example: [.mcp.json.example](.mcp.json.example)")
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


def _write_team_latest_index(team_dir: Path) -> None:
    path = team_dir / "LATEST.md"
    lines: list[str] = []
    lines.append("# Latest pointers")
    lines.append("")
    lines.append("- Team cycle: [LATEST_TEAM.md](LATEST_TEAM.md)")
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
    lines.append(f"- Latest tag: {tag or '(none)'}")
    lines.append(f"- Status: {status or '(unknown)'}")
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


def _write_artifacts_latest(artifacts_dir: Path, tag: str, artifacts_run: Path | None) -> None:
    lines: list[str] = []
    lines.append("# Latest Artifacts")
    lines.append("")
    lines.append(f"Last updated: {_utc_now()}")
    lines.append("")
    lines.append(f"- Latest tag: {tag or '(none)'}")
    if artifacts_run is not None and artifacts_run.is_dir():
        rel = os.path.relpath(artifacts_run, artifacts_dir)
        if not rel.startswith("."):
            rel = "./" + rel
        lines.append(f"- Artifacts directory: [{rel}]({rel})")
    else:
        lines.append("- Artifacts directory: (not found)")
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

    _write_team_latest_index(team_dir)
    _ensure_project_map_exists(project_root)

    map_path = project_root / "project_index.md"
    text = _read_text(map_path) if map_path.is_file() else ""
    state = _parse_project_map_auto_state(text)

    tag, status = _infer_latest_tag_and_status(project_root, team_dir, args.tag, args.status)
    kind = args.latest_kind
    if kind == "team":
        if tag:
            state["team_tag"] = tag
        if status:
            state["team_status"] = status
    else:
        if tag:
            state["draft_tag"] = tag
        if status:
            state["draft_status"] = status

    # Compute run_dir for the kind we are updating (only for pointer links).
    run_dir = args.run_dir
    if run_dir is None and tag:
        cand = team_dir / "runs" / tag
        run_dir = cand if cand.is_dir() else None

    if kind == "team":
        _write_latest_team_cycle(team_dir, state.get("team_tag", ""), state.get("team_status", ""), run_dir)
    else:
        _write_latest_draft_cycle(team_dir, state.get("draft_tag", ""), state.get("draft_status", ""), run_dir)

    # Artifacts pointer: prefer latest TEAM tag if present, otherwise fall back.
    artifacts_tag = state.get("team_tag") or state.get("draft_tag") or tag
    artifacts_run = _detect_latest_artifacts_dir(project_root, artifacts_tag)
    _write_artifacts_latest(artifacts_dir, artifacts_tag, artifacts_run)

    auto_lines: list[str] = []
    auto_lines.append(f"- Auto-updated at: {_utc_now()}")
    auto_lines.append(f"- Team latest tag: {state.get('team_tag') or '(none)'}")
    auto_lines.append(f"- Team latest status: {state.get('team_status') or '(unknown)'}")
    auto_lines.append(f"- Draft latest tag: {state.get('draft_tag') or '(none)'}")
    auto_lines.append(f"- Draft latest status: {state.get('draft_status') or '(unknown)'}")
    auto_lines.append("- Latest pointers: [team/LATEST.md](team/LATEST.md)")
    auto_lines.append("- Latest team: [team/LATEST_TEAM.md](team/LATEST_TEAM.md)")
    auto_lines.append("- Latest draft: [team/LATEST_DRAFT.md](team/LATEST_DRAFT.md)")
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

    print(f"[ok] updated: {map_path}")
    print(f"[ok] updated: {team_dir / 'LATEST.md'}")
    if kind == "team":
        print(f"[ok] updated: {team_dir / 'LATEST_TEAM.md'}")
    else:
        print(f"[ok] updated: {team_dir / 'LATEST_DRAFT.md'}")
    print(f"[ok] updated: {artifacts_dir / 'LATEST.md'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
