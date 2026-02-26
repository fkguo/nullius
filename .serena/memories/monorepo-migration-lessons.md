## [2026-02-24] NEW-05 + NEW-R13: Monorepo Migration Execution

**上下文**: Phase 0, 7 repos → autoresearch-lab/ monorepo
**发现**:
1. macOS APFS case-insensitive: Autoresearch/ 和 autoresearch/ 冲突，用 autoresearch-lab/
2. Fresh-start 比 git-subtree 更简单，原 repo 打 archive/pre-monorepo tag
3. tsbuildinfo 缓存导致 tsc 跳过 emit，必须删除后重建
4. 嵌套 .git + git add = gitlink，必须先 rm -rf .git 再 git rm --cached 后重新 add
5. @hep-research/* → @autoresearch/* sed 替换前先清 dist/
6. 两个测试硬编码旧路径需手动修
**影响**: 新对话工作目录 /home/user/Coding/Agents/autoresearch-lab/，npm scope @autoresearch/*
**关联项**: NEW-05, NEW-R13
