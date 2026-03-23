from __future__ import annotations

from dataclasses import dataclass


PROJECT_CHARTER = "project_charter.md"
PROJECT_INDEX = "project_index.md"
RESEARCH_PLAN = "research_plan.md"
RESEARCH_NOTEBOOK = "research_notebook.md"
RESEARCH_CONTRACT = "research_contract.md"
RESEARCH_PREFLIGHT = "research_preflight.md"
PROJECT_BRIEF = "project_brief.md"
IDEA_LOG = "idea_log.md"
MCP_CONFIG_EXAMPLE = ".mcp.json.example"

SCAFFOLD_SUPPORT_FILES = (
    "AGENTS.md",
    "docs/APPROVAL_GATES.md",
    "docs/ARTIFACT_CONTRACT.md",
    "docs/EVAL_GATE_CONTRACT.md",
)

MINIMAL_ROOT_FILES = (
    PROJECT_CHARTER,
    PROJECT_INDEX,
    RESEARCH_PLAN,
    RESEARCH_NOTEBOOK,
    RESEARCH_CONTRACT,
)

FULL_ROOT_FILES = MINIMAL_ROOT_FILES + (
    RESEARCH_PREFLIGHT,
    PROJECT_BRIEF,
    IDEA_LOG,
)

MINIMAL_TEMPLATE_FILES = MINIMAL_ROOT_FILES + SCAFFOLD_SUPPORT_FILES
FULL_TEMPLATE_FILES = FULL_ROOT_FILES + SCAFFOLD_SUPPORT_FILES

MINIMAL_CONTEXT_FILES = MINIMAL_TEMPLATE_FILES

SCAFFOLD_TEMPLATE_MAP = {
    PROJECT_CHARTER: PROJECT_CHARTER,
    PROJECT_INDEX: PROJECT_INDEX,
    RESEARCH_PLAN: RESEARCH_PLAN,
    RESEARCH_NOTEBOOK: RESEARCH_NOTEBOOK,
    RESEARCH_CONTRACT: RESEARCH_CONTRACT,
    RESEARCH_PREFLIGHT: RESEARCH_PREFLIGHT,
    PROJECT_BRIEF: PROJECT_BRIEF,
    IDEA_LOG: IDEA_LOG,
    "AGENTS.md": "AGENTS.md",
    "docs/APPROVAL_GATES.md": "APPROVAL_GATES.md",
    "docs/ARTIFACT_CONTRACT.md": "ARTIFACT_CONTRACT.md",
    "docs/EVAL_GATE_CONTRACT.md": "EVAL_GATE_CONTRACT.md",
}


@dataclass(frozen=True)
class NamingAuditDecision:
    path: str
    decision: str
    rationale: str


BOUNDARY_NAMING_AUDIT = (
    NamingAuditDecision(
        path="knowledge_base/",
        decision="keep_optional",
        rationale="project-local evidence base is a generic concept, but it is no longer part of the default minimal scaffold",
    ),
    NamingAuditDecision(
        path="prompts/",
        decision="keep_host_local",
        rationale="prompt inputs are research-team host-local surfaces and no longer belong to the canonical minimal project root",
    ),
    NamingAuditDecision(
        path="team/",
        decision="keep_host_local",
        rationale="review-cycle outputs are specific to the research-team host and remain optional runtime artifacts rather than canonical root files",
    ),
    NamingAuditDecision(
        path="research_team_config.json",
        decision="keep_host_local",
        rationale="the config is a research-team-specific host contract, not part of the shared new-project rule",
    ),
    NamingAuditDecision(
        path="references/",
        decision="keep_optional",
        rationale="external-source snapshots remain a generic support concept but stay optional until a workflow actually needs them",
    ),
    NamingAuditDecision(
        path=".hep/",
        decision="keep_provider_local",
        rationale="the path is still provider-local debt, but it no longer belongs to the canonical minimal scaffold in this batch",
    ),
)
