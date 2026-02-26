# Task Completion Checklist

After completing any code change:

1. **Build**: `pnpm -r build` — must pass with no errors
2. **Test**: `pnpm -r test` — all tests must pass
3. **Lint**: `pnpm -r lint` (if lint is configured for affected packages)
4. **Contract tests**: If tool surface was modified, verify `packages/hep-mcp/tests/toolContracts.test.ts`
5. **Architecture doc**: If architectural changes were made, update `docs/ARCHITECTURE.md`
6. **Tracker**: Update `meta/remediation_tracker_v1.json` if implementing a REDESIGN_PLAN item

## For REDESIGN_PLAN Phase 0 items specifically
- Each item has acceptance checkpoints defined in `meta/REDESIGN_PLAN.md`
- Update tracker status → "done" with completed_at date
- Commit with descriptive message referencing the item ID（不加 Co-Authored-By 行，因为开发涉及多模型协作，非单一 Claude 产出）
- **git push**: commit 后必须 `git push` 同步到 GitHub（private repo: fkguo/autoresearch-lab）。每阶段完成即推送，不要攒多个阶段再推
