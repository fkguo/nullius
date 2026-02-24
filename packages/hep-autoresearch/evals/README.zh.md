# evals/

本目录用于回归评测（eval suite）。

建议布局：
- `evals/cases/<CASE_ID>/case.json`：单个评测用例配置（schema 见 `specs/eval_case.schema.json`）
- `evals/README.md`：评测运行方式与解释

注意：
- eval case 只是“规格与验收”；实现入口（Orchestrator/脚本/CI）可以后续再补齐。

