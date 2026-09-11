/* Shared completion / restoration rules for the task and history pages. */
window.PlannerTasks = (() => {
  const newId = () => `history-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
  function pending(task) {
    const copy = { ...task, done: false };
    delete copy.completionHistoryId;
    delete copy.completedAt;
    return copy;
  }
  function nextResetAt(entry) {
    const completedAt = new Date(entry.completedAt);
    if (!Number.isFinite(completedAt.getTime())) return null;
    const resetAt = new Date(completedAt);
    resetAt.setHours(5, 0, 0, 0);
    const recurrence = entry.recurrence || entry.taskSnapshot?.recurrence || 'daily';
    if (recurrence === 'monthly') resetAt.setMonth(resetAt.getMonth() + 1);
    else if (recurrence === 'yearly') resetAt.setFullYear(resetAt.getFullYear() + 1);
    else if (resetAt <= completedAt) resetAt.setDate(resetAt.getDate() + 1);
    return resetAt;
  }
  function entryFor(task, project, index, reward = 0) {
    return {
      id: newId(), taskId: task.id, title: task.title,
      source: project ? 'project' : 'timeline',
      ...(project ? { projectId: project.id, projectName: project.name,
        taskType: task.taskType || 'once', recurrence: task.recurrence || 'daily', isMilestone: Boolean(task.isMilestone),
        projectSnapshot: { id: project.id, name: project.name, goal: project.goal || '', projectType: project.projectType || 'short' }
      } : { period: task.period, taskType: task.taskType || 'once', recurrence: task.recurrence || 'daily' }),
      taskSnapshot: pending(task), originalIndex: index,
      completedAt: task.completedAt || new Date().toISOString(), reward
    };
  }
  function normalize(state, now = new Date()) {
    if (!state || !Array.isArray(state.tasks) || !Array.isArray(state.projects)) return null;
    if (!Array.isArray(state.history)) state.history = [];
    state.primogems = Number.isSafeInteger(state.primogems) && state.primogems >= 0 ? state.primogems : 0;
    function migrate(list, project) {
      list.forEach((task, index) => {
        if (project) task.taskType = task.isMilestone ? 'indicator' : task.taskType || 'once';
        if (!task.done) return;
        const existing = state.history.find(entry => task.completionHistoryId
          ? entry.id === task.completionHistoryId
          : entry.taskId === task.id && (project ? entry.projectId === project.id : entry.source === 'timeline'));
        if (existing) {
          existing.taskSnapshot = pending(task);
          existing.originalIndex = index;
          if (project) existing.projectSnapshot = entryFor(task, project, index).projectSnapshot;
        } else state.history.push(entryFor(task, project, index));
      });
      return list.filter(task => !task.done);
    }
    state.tasks = migrate(state.tasks);
    state.projects.forEach(project => {
      project.projectType ||= 'short';
      project.tasks = migrate(project.tasks || [], project);
    });
    state.history.forEach(entry => {
      if (entry.resetProcessed || entry.taskSnapshot?.taskType !== 'recurring') return;
      const resetAt = nextResetAt(entry);
      if (!resetAt) return;
      if (now < resetAt) return;
      entry.resetProcessed = true;
      const project = entry.projectId ? state.projects.find(item => item.id === entry.projectId) : null;
      if (entry.projectId && !project) return;
      const list = project ? project.tasks : state.tasks;
      if (!list.some(task => task.id === entry.taskId)) list.push(pending(entry.taskSnapshot));
    });
    return state;
  }
  function complete(state, taskId, projectId) {
    const project = projectId ? state.projects.find(item => item.id === projectId) : null;
    if (projectId && !project) return false;
    const list = project ? project.tasks : state.tasks;
    const index = list.findIndex(task => task.id === taskId);
    if (index < 0) return false;
    state.history.push(entryFor(list[index], project, index, 20));
    list.splice(index, 1);
    state.primogems += 20;
    return true;
  }
  function restore(state, historyId) {
    const index = state.history.findIndex(entry => entry.id === historyId);
    if (index < 0) return { ok: false, message: '這筆紀錄已恢復，請查看任務清單。' };
    const entry = state.history[index];
    if (entry.resetProcessed) return { ok: false, message: '這次循環已於早上 5 點重置，請查看任務清單。' };
    const isProject = entry.source === 'project' || Boolean(entry.projectId);
    let project = isProject ? state.projects.find(item => item.id === entry.projectId) : null;
    if (isProject && !project) {
      project = { ...(entry.projectSnapshot || { id: entry.projectId || newId(), name: entry.projectName || '恢復的專案', goal: '', projectType: 'short' }), tasks: [] };
    }
    const list = project ? project.tasks : state.tasks;
    if (list.some(task => task.id === entry.taskId)) return { ok: false, message: '同一個任務已在任務清單中，無需重複恢復。' };
    const task = pending(entry.taskSnapshot || {
      id: entry.taskId || newId(), title: entry.title || '未命名任務',
      ...(isProject ? { taskType: entry.taskType || 'once', isMilestone: Boolean(entry.isMilestone) } : { period: entry.period || 'daily', note: '' })
    });
    if (project && !state.projects.some(item => item.id === project.id)) state.projects.push(project);
    list.splice(Number.isInteger(entry.originalIndex) ? Math.max(0, Math.min(entry.originalIndex, list.length)) : list.length, 0, task);
    state.history.splice(index, 1);
    const refund = entry.reward === 20 ? 20 : 0;
    state.primogems = Math.max(0, state.primogems - refund);
    return { ok: true, message: `已恢復至${project ? project.name : { daily: '今日', weekly: '本周', monthly: '本月', yearly: '今年' }[task.period] || '任務'}${refund ? '，並扣回 20 原石' : ''}。` };
  }
  return { normalize, complete, restore };
})();
