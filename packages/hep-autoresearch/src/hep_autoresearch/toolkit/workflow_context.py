from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class WorkflowContext:
    workflow_id: str
    expected_outputs: list[str]
    plan: list[str]
    risks: list[str]
    rollback: str


def workflow_context(*, workflow_id: str, run_id: str, refkey: str | None = None) -> WorkflowContext:
    wid = str(workflow_id)
    rid = str(run_id)

    if wid == "W_compute":
        return WorkflowContext(
            workflow_id=wid,
            expected_outputs=[
                f"artifacts/runs/{rid}/run_card.json",
                f"artifacts/runs/{rid}/w_compute/manifest.json",
                f"artifacts/runs/{rid}/w_compute/summary.json",
                f"artifacts/runs/{rid}/w_compute/analysis.json",
                f"artifacts/runs/{rid}/w_compute/report.md",
                f"artifacts/runs/{rid}/w_compute/run_card.json",
                f"artifacts/runs/{rid}/w_compute/phase_state.json",
            ],
            plan=[
                "Validate run_card v2 strictly (unknown fields are errors; params resolved deterministically).",
                "Execute phases in topological order, enforcing declared inputs/outputs + provenance logs.",
                "Write manifest/summary/analysis JSON SSOT and render report.md deterministically.",
            ],
            risks=[
                "Shell commands are powerful; require explicit trust (--trust-project) and enforce path containment.",
                "Misdeclared inputs/outputs can cause silent failures; fail-fast with actionable diagnostics.",
                "Resume/crash recovery must fail closed; never mix mismatched run-cards in the same workspace.",
            ],
            rollback="Delete artifacts/runs/<run_id>/w_compute/ (no repo edits expected).",
        )

    if wid == "ADAPTER_shell_smoke":
        return WorkflowContext(
            workflow_id=wid,
            expected_outputs=[
                f"artifacts/runs/{rid}/run_card.json",
                f"artifacts/runs/{rid}/adapter_shell_smoke/manifest.json",
                f"artifacts/runs/{rid}/adapter_shell_smoke/summary.json",
                f"artifacts/runs/{rid}/adapter_shell_smoke/analysis.json",
                f"artifacts/runs/{rid}/adapter_shell_smoke/run_card.json",
                f"artifacts/runs/{rid}/adapter_shell_smoke/report.md",
                f"artifacts/runs/{rid}/adapter_shell_smoke/logs/stdout.txt",
                f"artifacts/runs/{rid}/adapter_shell_smoke/logs/stderr.txt",
            ],
            plan=[
                "Build a run-card (prompt/tools/budgets/backend config) and write it under the artifact dir.",
                "Run a deterministic local shell command and capture stdout/stderr + exit code.",
                "Write manifest/summary/analysis as JSON SSOT and render report.md deterministically.",
            ],
            risks=[
                "Shell commands are powerful; safe-by-default gating should be enforced (A3 for compute runs).",
                "If artifacts are not written on failure, regression/evals lose visibility; always write SSOT.",
            ],
            rollback="Delete artifacts/runs/<run_id>/adapter_shell_smoke/ (no repo edits expected).",
        )

    if wid == "W2_reproduce":
        return WorkflowContext(
            workflow_id=wid,
            expected_outputs=[
                f"artifacts/runs/{rid}/run_card.json",
                f"artifacts/runs/{rid}/reproduce/manifest.json",
                f"artifacts/runs/{rid}/reproduce/summary.json",
                f"artifacts/runs/{rid}/reproduce/analysis.json",
            ],
            plan=["Run W2 reproduction and write manifest/summary/analysis artifacts."],
            risks=["Numerical/dep differences across environments; overly-trivial toy agreement masking future issues."],
            rollback="Delete artifacts/runs/<run_id>/reproduce and revert repo changes via git if needed.",
        )

    if wid == "W3_revision":
        return WorkflowContext(
            workflow_id=wid,
            expected_outputs=[
                "paper/main.tex (may be edited)",
                f"artifacts/runs/{rid}/run_card.json",
                f"artifacts/runs/{rid}/revision/manifest.json",
                f"artifacts/runs/{rid}/revision/summary.json",
                f"artifacts/runs/{rid}/revision/analysis.json",
                f"artifacts/runs/{rid}/revision/diff/main.tex.diff",
                f"artifacts/runs/{rid}/revision/logs/latexmk_before.txt",
                f"artifacts/runs/{rid}/revision/logs/latexmk_after.txt",
            ],
            plan=[
                "Compile LaTeX (baseline).",
                "Apply deterministic edit(s) (v0: provenance table injection).",
                "Compile LaTeX again and write manifest/summary/analysis + diff/logs.",
            ],
            risks=["Paper edits may introduce compile/citation issues; must be reviewable via diff and compile gate."],
            rollback="Revert paper/ changes via git; delete artifacts/runs/<run_id>/revision.",
        )

    if wid == "W3_paper_reviser":
        return WorkflowContext(
            workflow_id=wid,
            expected_outputs=[
                f"artifacts/runs/{rid}/run_card.json",
                f"artifacts/runs/{rid}/paper_reviser/manifest.json",
                f"artifacts/runs/{rid}/paper_reviser/summary.json",
                f"artifacts/runs/{rid}/paper_reviser/analysis.json",
                f"artifacts/runs/{rid}/paper_reviser/report.md",
                f"artifacts/runs/{rid}/paper_reviser/round_01/run.json",
                f"artifacts/runs/{rid}/paper_reviser/round_02/run.json",
                f"artifacts/runs/{rid}/paper_reviser/verification/verification_plan.json",
                f"artifacts/runs/{rid}/paper_reviser/verification/task_state/",
                f"artifacts/runs/{rid}/paper_reviser/verification/logs/",
                f"artifacts/runs/{rid}/paper_reviser/verification/evidence_state/",
                f"artifacts/runs/{rid}/paper_reviser/verification/evidence/",
            ],
            plan=[
                "Step A: run paper-reviser on the draft .tex and write round_01/ SSOT outputs (clean.tex + diff + audit + verification requests).",
                "Step B: build a deterministic verification_plan.json pointing ALL retrieval outputs under artifacts/runs/<run_id>/paper_reviser/verification/.",
                "Step C: request A1 approval, then execute external retrieval tasks (research-team.literature_fetch) with per-task state + logs.",
                "Step D: synthesize evidence (LLM allowed) into per-VR JSON SSOT + deterministic VR-*.md notes under verification/evidence/.",
                "Step E: re-run paper-reviser once with --context-dir verification/evidence/ and write round_02/ outputs.",
            ],
            risks=[
                "Round_01/02 edits are content-changing; review diffs and compile separately before applying back to the repo.",
                "External retrieval is networked and must be A1-gated; plan/task logs are SSOT under artifacts.",
                "Optional apply-to-draft writes to the repo and is A4-gated (approval_policy dependent).",
            ],
            rollback="Delete artifacts/runs/<run_id>/paper_reviser/. If apply-to-draft was used, revert the draft .tex via git.",
        )

    if wid == "W3_literature_survey_polish":
        return WorkflowContext(
            workflow_id=wid,
            expected_outputs=[
                f"artifacts/runs/{rid}/run_card.json",
                # T30 deterministic export (input to polish)
                f"artifacts/runs/{rid}/literature_survey/manifest.json",
                f"artifacts/runs/{rid}/literature_survey/summary.json",
                f"artifacts/runs/{rid}/literature_survey/analysis.json",
                f"artifacts/runs/{rid}/literature_survey/survey.json",
                f"artifacts/runs/{rid}/literature_survey/report.md",
                f"artifacts/runs/{rid}/literature_survey/survey.tex",
                f"artifacts/runs/{rid}/literature_survey/literature_survey.bib",
                f"artifacts/runs/{rid}/literature_survey/refkey_to_citekey.json",
                f"artifacts/runs/{rid}/literature_survey/citekey_to_refkeys.json",
                # T36 research-writer polish outputs
                f"artifacts/runs/{rid}/literature_survey_polish/manifest.json",
                f"artifacts/runs/{rid}/literature_survey_polish/summary.json",
                f"artifacts/runs/{rid}/literature_survey_polish/analysis.json",
                f"artifacts/runs/{rid}/literature_survey_polish/report.md",
                f"artifacts/runs/{rid}/literature_survey_polish/paper/paper_manifest.json",
                f"artifacts/runs/{rid}/literature_survey_polish/paper/export_manifest.json",
            ],
            plan=[
                "Write deterministic KB → literature survey export (survey.json + survey.tex + bib).",
                "Trigger A4 gate before running research-writer consume (hygiene + optional compile).",
                "Run research-writer consume on a minimal paper scaffold embedding survey.tex, writing outputs under artifacts/runs/<run_id>/literature_survey_polish/.",
            ],
            risks=[
                "If TeX toolchain is missing, compile is skipped (not fatal) but must be recorded in export_manifest.json.",
                "If citekeys collide or hygiene fails, research-writer consume should fail-fast and preserve logs.",
            ],
            rollback="Delete artifacts/runs/<run_id>/{literature_survey,literature_survey_polish}/ (no repo edits expected).",
        )

    # W1_ingest (default)
    ref = refkey or "<refkey>"
    return WorkflowContext(
        workflow_id=wid,
        expected_outputs=[
            f"artifacts/runs/{rid}/run_card.json",
            f"artifacts/runs/{rid}/ingest/{ref}/manifest.json",
            f"artifacts/runs/{rid}/ingest/{ref}/summary.json",
            f"artifacts/runs/{rid}/ingest/{ref}/analysis.json",
        ],
        plan=["Run W1 ingestion for a paper id and write references/ + KB note + artifacts."],
        risks=["Potential wrong/duplicate RefKey; partial snapshots if network fails."],
        rollback="Delete newly created references/ + artifacts/ for this run; revert files via git if needed.",
    )
