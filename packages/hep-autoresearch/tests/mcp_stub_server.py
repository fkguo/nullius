#!/usr/bin/env python3

from __future__ import annotations

import base64
import json
import os
import sys
import time
from dataclasses import dataclass
from typing import Any


def _send(id_: int, result: dict[str, Any]) -> None:
    sys.stdout.write(json.dumps({"jsonrpc": "2.0", "id": id_, "result": result}) + "\n")
    sys.stdout.flush()


def _send_tool_result(id_: int, payload: Any, *, is_error: bool = False) -> None:
    txt = payload if isinstance(payload, str) else json.dumps(payload, indent=2, sort_keys=True)
    _send(
        id_,
        {
            "content": [{"type": "text", "text": txt}],
            "isError": bool(is_error),
        },
    )


@dataclass
class Project:
    project_id: str
    name: str
    description: str | None


@dataclass
class Run:
    run_id: str
    project_id: str
    artifacts: dict[str, bytes]


class State:
    def __init__(self) -> None:
        self.projects: list[Project] = []
        self.runs: dict[str, Run] = {}
        self._next_project = 1
        self._next_run = 1

    def create_project(self, *, name: str, description: str | None) -> Project:
        pid = f"P{self._next_project}"
        self._next_project += 1
        p = Project(project_id=pid, name=name, description=description)
        self.projects.append(p)
        return p

    def create_run(self, *, project_id: str, args_snapshot: Any) -> Run:
        rid = f"R{self._next_run}"
        self._next_run += 1
        artifacts: dict[str, bytes] = {}
        artifacts["args_snapshot.json"] = (json.dumps({"run_id": rid, "project_id": project_id, "args_snapshot": args_snapshot}, indent=2) + "\n").encode(
            "utf-8"
        )
        run = Run(run_id=rid, project_id=project_id, artifacts=artifacts)
        self.runs[rid] = run
        return run


def main() -> int:
    st = State()
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
        except Exception:
            continue
        if not isinstance(msg, dict):
            continue
        method = msg.get("method")
        msg_id = msg.get("id")

        # Notifications have no id.
        if msg_id is None:
            continue
        if not isinstance(msg_id, int):
            continue

        if method == "initialize":
            params = msg.get("params") if isinstance(msg.get("params"), dict) else {}
            requested = params.get("protocolVersion")
            forced = os.environ.get("MCP_STUB_FORCE_PROTOCOL_VERSION", "").strip()
            if forced:
                negotiated = forced
            else:
                supported = {"2025-03-26", "2024-11-05"}
                negotiated = str(requested) if requested in supported else "2024-11-05"
            _send(
                msg_id,
                {
                    "protocolVersion": negotiated,
                    "capabilities": {"tools": {}, "resources": {}},
                    "serverInfo": {"name": "stub-mcp", "version": "0.0.0"},
                },
            )
            continue
        if method == "tools/list":
            disable_inspire_search = str(os.environ.get("MCP_STUB_DISABLE_INSPIRE_SEARCH", "")).strip().lower() in {"1", "true", "yes", "on"}
            disable_topic_analysis = str(os.environ.get("MCP_STUB_DISABLE_TOPIC_ANALYSIS", "")).strip().lower() in {"1", "true", "yes", "on"}
            disable_network_analysis = str(os.environ.get("MCP_STUB_DISABLE_NETWORK_ANALYSIS", "")).strip().lower() in {"1", "true", "yes", "on"}
            tools = [
                {"name": "hep_health", "description": "stub health"},
                {"name": "hep_project_list", "description": "list projects"},
                {"name": "hep_project_create", "description": "create project"},
                {"name": "hep_run_create", "description": "create run"},
                {"name": "hep_run_stage_content", "description": "stage content"},
                {"name": "hep_run_read_artifact_chunk", "description": "read chunk"},
                {"name": "pdg_get_property", "description": "stub pdg property"},
                {"name": "inspire_find_connections", "description": "stub find connections"},
                {"name": "inspire_trace_original_source", "description": "stub trace original source"},
                {"name": "inspire_critical_analysis", "description": "stub critical analysis"},
            ]
            if not disable_inspire_search:
                tools.append({"name": "inspire_search", "description": "stub inspire search"})
            if not disable_topic_analysis:
                tools.append({"name": "inspire_topic_analysis", "description": "stub topic analysis"})
            if not disable_network_analysis:
                tools.append({"name": "inspire_network_analysis", "description": "stub network analysis"})
            _send(msg_id, {"tools": tools})
            continue
        if method == "tools/call":
            params = msg.get("params") if isinstance(msg.get("params"), dict) else {}
            name = params.get("name")
            args = params.get("arguments") if isinstance(params.get("arguments"), dict) else {}
            if name == "hep_health":
                _send_tool_result(msg_id, {"ok": True, "ts": time.time()})
                continue
            if name == "hep_project_list":
                _send_tool_result(
                    msg_id,
                    [
                        {
                            "project_id": p.project_id,
                            "name": p.name,
                            "description": p.description,
                        }
                        for p in st.projects
                    ],
                )
                continue
            if name == "hep_project_create":
                p = st.create_project(name=str(args.get("name") or ""), description=str(args.get("description") or "") or None)
                _send_tool_result(
                    msg_id,
                    {
                        "project_id": p.project_id,
                        "name": p.name,
                        "description": p.description,
                    },
                )
                continue
            if name == "hep_run_create":
                run = st.create_run(project_id=str(args.get("project_id") or ""), args_snapshot=args.get("args_snapshot"))
                _send_tool_result(
                    msg_id,
                    {
                        "manifest": {
                            "run_id": run.run_id,
                            "project_id": run.project_id,
                        },
                        "artifacts": [{"name": "args_snapshot.json", "uri": f"hep://runs/{run.run_id}/artifact/args_snapshot.json"}],
                    },
                )
                continue
            if name == "hep_run_stage_content":
                run_id = str(args.get("run_id") or "")
                run = st.runs.get(run_id)
                if run is None:
                    _send_tool_result(msg_id, {"error": "run not found"}, is_error=True)
                    continue
                content_type = str(args.get("content_type") or "section_output")
                suffix = str(args.get("artifact_suffix") or "x")
                artifact_name = f"staged_{content_type}_{suffix}.json"
                payload = {
                    "version": 1,
                    "content_type": content_type,
                    "content": str(args.get("content") or ""),
                }
                run.artifacts[artifact_name] = (json.dumps(payload, indent=2, sort_keys=True) + "\n").encode("utf-8")
                _send_tool_result(
                    msg_id,
                    {
                        "run_id": run_id,
                        "staging_uri": f"hep://runs/{run_id}/artifact/{artifact_name}",
                        "artifact_name": artifact_name,
                        "content_bytes": len(payload["content"].encode("utf-8")),
                    },
                )
                continue
            if name == "hep_run_read_artifact_chunk":
                run_id = str(args.get("run_id") or "")
                artifact_name = str(args.get("artifact_name") or "")
                run = st.runs.get(run_id)
                if run is None:
                    _send_tool_result(msg_id, {"error": "run not found"}, is_error=True)
                    continue
                blob = run.artifacts.get(artifact_name)
                if blob is None:
                    _send_tool_result(msg_id, {"error": "artifact not found"}, is_error=True)
                    continue
                offset = int(args.get("offset") or 0)
                length = int(args.get("length") or 128)
                chunk = blob[offset : offset + length]
                _send_tool_result(
                    msg_id,
                    {
                        "run_id": run_id,
                        "artifact_name": artifact_name,
                        "offset": offset,
                        "length": len(chunk),
                        "base64": base64.b64encode(chunk).decode("ascii"),
                    },
                )
                continue

            if name == "pdg_get_property":
                particle = args.get("particle") if isinstance(args.get("particle"), dict) else {}
                pname = str(particle.get("name") or "")
                prop = str(args.get("property") or "")
                # Stable toy values (GeV) for regression tests.
                if pname.lower() == "pi0" and prop == "mass":
                    value = 0.1349768
                elif pname.lower() in {"mu", "mu-", "mu+"} and prop == "mass":
                    value = 0.1056584
                else:
                    value = 1.0
                payload = {
                    "particle": {"name": pname},
                    "property": prop,
                    "value": value,
                    "unit": "GeV",
                    "uncertainty": 1e-6,
                    "locator": "stub:pdg_get_property",
                }
                _send_tool_result(msg_id, payload)
                continue

            if name == "inspire_search":
                topic = str(args.get("query") or "")
                payload = {
                    "query": topic,
                    "page": 1,
                    "size": int(args.get("size") or 25),
                    "total": 4,
                    "papers": [
                        {
                            "recid": "2001",
                            "title": f"Review: {topic}",
                            "abstract": f"A review that mentions {topic} and related methods.",
                            "year": 2018,
                            "citation_count": 120,
                        },
                        {
                            "recid": "1001",
                            "title": f"{topic} — seminal result",
                            "abstract": f"We study {topic} with a deterministic workflow.",
                            "year": 2024,
                            "citation_count": 250,
                        },
                        {
                            "recid": "1002",
                            "title": "Unrelated topic",
                            "abstract": "This paper is about something else.",
                            "year": 1999,
                            "citation_count": 3,
                        },
                        {
                            "recid": "3001",
                            "title": f"{topic} follow-up",
                            "abstract": f"Follow-up work connected to {topic}.",
                            "year": 2022,
                            "citation_count": 20,
                        },
                    ],
                }
                _send_tool_result(msg_id, payload)
                continue
            if name == "inspire_topic_analysis":
                payload = {
                    "mode": str(args.get("mode") or ""),
                    "topic": str(args.get("topic") or ""),
                    "timeline": [{"bucket": "2020-2024", "count": 1}],
                }
                _send_tool_result(msg_id, payload)
                continue
            if name == "inspire_find_connections":
                payload = {
                    "internal_edges": [],
                    "bridge_papers": [],
                    "isolated_papers": args.get("recids") if isinstance(args.get("recids"), list) else [],
                    "external_hubs": [],
                }
                _send_tool_result(msg_id, payload)
                continue
            if name == "inspire_critical_analysis":
                payload = {
                    "paper_recid": str(args.get("recid") or ""),
                    "success": True,
                    "notes": ["stub critical analysis"],
                }
                _send_tool_result(msg_id, payload)
                continue
            if name == "inspire_network_analysis":
                seed = str(args.get("seed") or "")
                payload = {
                    "mode": str(args.get("mode") or ""),
                    "seed": seed,
                    "nodes": [{"recid": seed}],
                    "edges": [],
                }
                _send_tool_result(msg_id, payload)
                continue
            if name == "inspire_trace_original_source":
                recid = str(args.get("recid") or "")
                payload = {
                    "starting_paper": {"recid": recid, "title": "Stub starting paper"},
                    "original_sources": [],
                    "trace_chain": [],
                    "stats": {"total_traced": 1, "max_depth_reached": 0, "chains_analyzed": 1},
                }
                _send_tool_result(msg_id, payload)
                continue

            _send_tool_result(msg_id, {"error": f"unknown tool: {name}"}, is_error=True)
            continue

        _send(msg_id, {})

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
