from __future__ import annotations

from dataclasses import dataclass


PROJECT_CHARTER = "project_charter.md"
PROJECT_INDEX = "project_index.md"
RESEARCH_PLAN = "research_plan.md"
RESEARCH_NOTEBOOK = "research_notebook.md"
RESEARCH_CONTRACT = "research_contract.md"

SCAFFOLD_SUPPORT_FILES = (
    "AGENTS.md",
)

SCAFFOLD_ROOT_FILES = (
    PROJECT_CHARTER,
    PROJECT_INDEX,
    RESEARCH_PLAN,
    RESEARCH_NOTEBOOK,
    RESEARCH_CONTRACT,
)

SCAFFOLD_TEMPLATE_FILES = SCAFFOLD_ROOT_FILES + SCAFFOLD_SUPPORT_FILES
SCAFFOLD_CONTEXT_FILES = SCAFFOLD_TEMPLATE_FILES

SCAFFOLD_TEMPLATE_MAP = {
    PROJECT_CHARTER: PROJECT_CHARTER,
    PROJECT_INDEX: PROJECT_INDEX,
    RESEARCH_PLAN: RESEARCH_PLAN,
    RESEARCH_NOTEBOOK: RESEARCH_NOTEBOOK,
    RESEARCH_CONTRACT: RESEARCH_CONTRACT,
    "AGENTS.md": "AGENTS.md",
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
        rationale="project-local evidence stores are optional support surfaces; the canonical scaffold does not create them by default",
    ),
    NamingAuditDecision(
        path="prompts/",
        decision="keep_host_local",
        rationale="prompt inputs are host-local surfaces; the canonical scaffold does not create optional host/provider/support surfaces by default",
    ),
    NamingAuditDecision(
        path="team/",
        decision="keep_host_local",
        rationale="review-cycle outputs remain optional runtime artifacts rather than canonical root files",
    ),
    NamingAuditDecision(
        path="research_team_config.json",
        decision="keep_host_local",
        rationale="host-specific config is not part of the shared new-project rule",
    ),
    NamingAuditDecision(
        path="references/",
        decision="keep_optional",
        rationale="external-source snapshots remain a generic support concept but stay optional until a workflow actually needs them",
    ),
    NamingAuditDecision(
        path=".hep/",
        decision="keep_provider_local",
        rationale="provider-local state does not belong to the canonical generic scaffold",
    ),
)
