# hep-calc → hep-autoresearch adapter / eval 集成

> 语言：中文。English version: `references/hep_autoresearch_integration.md`

本文件说明：`hep-autoresearch`（或其它生态圈工具）如何把 `hep-calc` 的一次运行纳入回归评测与 provenance 体系。

## SSOT 三件套（out_dir 根目录）

`hep-calc` 每次运行都会在 `out_dir/` 根目录写入：

- `manifest.json`：输入/参数指针、环境版本、关键命令指针、输出文件清单、run-card 指针（如有）
- `summary.json`：headline（关键状态/计数/中间量）+ 定义
- `analysis.json`：更详细的对照/诊断（当前为薄包装，后续可扩展）
- `report/audit_report.md`：面向人的审计摘要（不属于 JSON ingestion contract）

## hep-autoresearch adapter 的最小调用方式

1) 运行一个 job（可以是 compute-only，也可以是 tex_audit）：

```bash
bash scripts/run_hep_calc.sh --job job.yml --out /tmp/hep_calc_run
```

2) adapter 读取 `out_dir/summary.json`（快速判定）：

- `overall_status`: `PASS|PARTIAL|FAIL|ERROR`
- `run_mode`: `compute_only|tex_audit`
- `counts`: tex 对照的 PASS/FAIL/SKIPPED 计数（compute-only 时通常为 0）
- `headline`: 提供可读的关键状态/数值（带 definition）
- `fingerprints.job_resolved_wo_meta_sha256`: 用于“同一输入配置”的稳定指纹（忽略每次 run 的 `_meta`）
- `fingerprints.outputs_files_sha256`: 输出文件列表指纹（仅基于路径列表；用于检测布局变化）

3) adapter 读取 `out_dir/manifest.json`（provenance / 证据入口）：

- `job.original` / `job.resolved`：输入卡与解析后的参数
- `inputs[]`：输入文件（best-effort sha256 + redacted source_path）
- `environment.versions`：外部依赖版本（可用于回归比较）
- `commands[]`：关键命令指针（例如 `meta/command_line.txt`）
- `outputs.files[]`：输出文件路径清单（deterministic 排序）
- `steps`：各阶段 status/reason（用于 failure triage）

## 旧 out_dir 的确定性导出（export artifacts）

如果你有旧的 out_dir（缺少根目录三件套），可执行：

```bash
python3 scripts/export_artifacts.py --out /path/to/existing_out_dir
```

该命令会基于 `job.resolved.json` + out_dir 内容重建 SSOT 三件套（deterministic：created_at 优先使用 job 的 `_meta.resolved_at`）。

## run-card（输入契约）建议

当你需要把“输入契约”从 job.yml 中拆出来（便于 L3 evolution / eval 管线复用），建议：

- 在 job 顶层设置 `run_card: run_card.yml`
- run-card 中包含：过程、约定、目标产物、对照项解释、任何显式规则（尤其是 model_build rewrite 规则的来源）

runner 会 best-effort 把 run-card 复制到 `out_dir/inputs/run_card.<ext>` 并在 `manifest.json` 中记录指针。

## 轻量示例（用于 CI/回归）

仓库提供一个最轻量的 smoke runner（不依赖 Wolfram/Julia 成功执行计算；但能产出完整审计包装）：

```bash
python3 scripts/run_min_smoke.py --out-dir /tmp/hep_calc_run
test -f /tmp/hep_calc_run/manifest.json
test -f /tmp/hep_calc_run/summary.json
test -f /tmp/hep_calc_run/analysis.json
python3 -c 'import json; json.load(open("/tmp/hep_calc_run/manifest.json")); print("ok")'
```
