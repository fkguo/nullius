# hep-calc audit report

> Language: English. 中文版: `assets/report_template.zh.md`

This file is a style/template reference for hep-calc reports. The actual report is written at runtime to `out_dir/report/audit_report.md`.

Suggested structure:

- Metadata: time, out_dir, job pointer, versions, git info (if available)
- Step status: env / symbolic / numeric / tex_compare (PASS/FAIL/SKIPPED/ERROR + reason)
- Target summary: PASS/FAIL/SKIPPED counts and key diffs
- Required disclosures: why steps were skipped; `.nb` best-effort risks; any assumptions/defaults
- Artifact pointers: key JSON files and log paths
