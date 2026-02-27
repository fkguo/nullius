import { ProgressItem } from './adapters/progress.js';

/** Parse RESEARCH_PLAN.md task board + progress log into ProgressItem[]. */
export function parseProgressMd(md: string): ProgressItem[] {
  const lines = md.split('\n');
  const items = new Map<string, ProgressItem>();
  const milestoneTaskMap = new Map<string, string[]>(); // milestone id → task ids
  const milestoneExplicitStatus = new Set<string>(); // milestones whose status was set from log entries
  let currentMilestone: string | null = null;

  // Two passes: first collect tasks, then set milestone depends_on
  for (const line of lines) {
    // Milestone heading: ### M0 — Title
    const milestoneMatch = line.match(/^###\s+(M\d+)\s+[—–-]\s+(.+)/);
    if (milestoneMatch) {
      const [, milId, milTitle] = milestoneMatch;
      currentMilestone = milId;
      if (!items.has(milId)) {
        items.set(milId, { id: milId, type: 'milestone', title: milTitle.trim(), status: 'pending', depends_on: [] });
      }
      if (!milestoneTaskMap.has(milId)) milestoneTaskMap.set(milId, []);
      continue;
    }

    // Task board checkbox: - [x] T1: title  or  - [ ] T2: title
    const taskMatch = line.match(/^[-*]\s+\[([ xX])\]\s+(T\d+):\s*(.+)/);
    if (taskMatch) {
      const [, checked, taskId, taskTitle] = taskMatch;
      const defaultStatus = checked.trim() ? 'converged' : 'pending';
      if (!items.has(taskId)) {
        items.set(taskId, { id: taskId, type: 'task', title: taskTitle.trim(), status: defaultStatus });
      }
      if (currentMilestone) {
        const taskList = milestoneTaskMap.get(currentMilestone) ?? [];
        if (!taskList.includes(taskId)) taskList.push(taskId);
        milestoneTaskMap.set(currentMilestone, taskList);
      }
      continue;
    }

    // Progress log: - <date> tag=<TAG> status=<converged|not_converged> task=<Tn>
    const logMatch = line.match(/tag=\S+\s+status=(converged|not_converged)\s+task=(T\d+|M\d+)/);
    if (logMatch) {
      const [, statusStr, taskId] = logMatch;
      const status = statusStr === 'converged' ? 'converged' : 'active';
      const existing = items.get(taskId);
      if (existing) {
        existing.status = status;
        if (existing.type === 'milestone') milestoneExplicitStatus.add(taskId);
      }
      // milestone explicit log
      const milestoneLogMatch = line.match(/tag=\S+\s+status=(converged|not_converged)\s+task=(M\d+)/);
      if (milestoneLogMatch) {
        const [, mStatus, mId] = milestoneLogMatch;
        const mItem = items.get(mId);
        if (mItem) {
          mItem.status = mStatus === 'converged' ? 'converged' : 'active';
          milestoneExplicitStatus.add(mId);
        }
      }
    }
  }

  // Set milestone depends_on from task map and compute status
  for (const [milId, taskIds] of milestoneTaskMap) {
    const mil = items.get(milId);
    if (!mil) continue;
    mil.depends_on = taskIds;
    // Compute milestone status from tasks, but only if not explicitly set via a progress log entry.
    if (milestoneExplicitStatus.has(milId)) continue;
    const taskStatuses = taskIds.map(id => items.get(id)?.status ?? 'pending');
    if (taskStatuses.length === 0) continue;
    if (taskStatuses.some(s => s === 'blocked')) { mil.status = 'blocked'; continue; }
    if (taskStatuses.every(s => s === 'converged')) { mil.status = 'converged'; continue; }
    if (taskStatuses.some(s => s === 'active')) { mil.status = 'active'; continue; }
    if (taskStatuses.some(s => s === 'converged')) { mil.status = 'active'; continue; }
    mil.status = 'pending';
  }

  return Array.from(items.values());
}
