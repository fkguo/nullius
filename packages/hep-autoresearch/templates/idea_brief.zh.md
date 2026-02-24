# Idea brief（想法简报模板）

## 1) 一句话

（一句话描述你的想法）

## 2) 你认为的“新意点”（Novelty hypothesis）

- N1:
- N2:

## 3) 你认为最相近的工作（可选，先写 1–3 个）

- Paper / link:
- Paper / link:

## 4) 最小可验证目标（MVP）

把目标写成“可对比”的形式：
- 目标结果：图/表/关键数值（是什么、单位、在哪个条件下）
- 对比基线：哪篇论文/哪种方法/哪个公开代码
- 容差：abs/rel 或形状指标（先给一个粗容差也行）

## 5) 约束与禁区

- 不允许访问/不信任的来源：
- 不允许修改的目录/文件：
- 不允许执行的软件/脚本：

## 6) 自动化偏好（Approval policy）

建议三档：
- safe（默认）：大检索/写代码/跑算力/改论文/写结论都要问我
- interactive：只对跑算力/改论文/写结论问我
- full_auto：尽量自动（仍保留 stop file 与预算上限）

选择：safe / interactive / full_auto

预算（可选）：
- max_network_calls:
- max_runtime_minutes:

