# hep-calc audit report

> 语言：中文。English version: `assets/report_template.md`

本文件是 `hep-calc` 生成报告的模板/风格参考。真实报告在运行时写入 `out_dir/report/audit_report.md`。

建议结构：

- 元信息：时间、out_dir、job 指针、版本、git（若可用）
- Step 状态：env / symbolic / numeric / tex_compare（PASS/FAIL/SKIPPED/ERROR + 原因）
- Target 汇总：PASS/FAIL/SKIPPED 计数与关键差异
- 强制披露：未执行步骤原因；.nb best-effort 风险；任何假设/默认值
- 产物指针：关键 JSON、日志文件路径
