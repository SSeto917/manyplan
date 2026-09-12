const STORAGE_KEY = "life-planner:v2";
let deferredInstallPrompt = null;

const periodMeta = {
  daily: { title: "每日任務", kicker: "TODAY", description: "今天完成，就很值得。" },
  weekly: { title: "每周任務", kicker: "THIS WEEK", description: "這周結束前，想推進哪些事？" },
  monthly: { title: "每月任務", kicker: "THIS MONTH", description: "把這個月的重要目標留在眼前。" },
  yearly: { title: "今年任務", kicker: "THIS YEAR", description: "今年想成為怎樣的自己？" }
};

const seedState = {
  activePeriod: "daily",
  history: [],
  primogems: 0,
  tasks: [
    { id: "daily-room", period: "daily", title: "整理房間", note: "只要 5 分鐘，讓空間呼吸一下", done: false },
    { id: "daily-read", period: "daily", title: "閱讀", note: "翻開一頁，留 6 分鐘給新想法", done: false },
    { id: "weekly-review", period: "weekly", title: "回顧這周的進度", note: "記下完成的事，也安排下周重點", done: false },
    { id: "monthly-save", period: "monthly", title: "整理本月收支", note: "看見金錢流向，再做下一步決定", done: false },
    { id: "yearly-create", period: "yearly", title: "完成一個個人作品", note: "留下今年可以被看見的成果", done: false }
  ],
  projects: [{
    id: "project-demo", name: "個人創作計畫", projectType: "short", goal: "把腦中的想法，做成真正看得見的作品。",
    tasks: [
      { id: "project-demo-1", title: "整理想法與參考資料", taskType: "recurring", done: false },
      { id: "project-demo-2", title: "完成第一版草稿", taskType: "indicator", isMilestone: true, done: false }
    ]
  }]
};

const elements = {
  taskList: document.querySelector("#taskList"), taskEmpty: document.querySelector("#taskEmpty"),
  dailyProjectRecurring: document.querySelector("#dailyProjectRecurring"), projectRecurringList: document.querySelector("#projectRecurringList"),
  projectList: document.querySelector("#projectList"), projectEmpty: document.querySelector("#projectEmpty"),
  periodTabs: document.querySelector("#periodTabs"), periodTitle: document.querySelector("#periodTitle"),
  periodKicker: document.querySelector("#periodKicker"), periodDescription: document.querySelector("#periodDescription"),
  taskForm: document.querySelector("#taskForm"), projectForm: document.querySelector("#projectForm"),
  todayDoneCount: document.querySelector("#todayDoneCount"), timelineView: document.querySelector("#timelineView"),
  projectView: document.querySelector("#projectView"), celebration: document.querySelector("#celebration")
};
elements.viewDoneName = document.querySelector("#viewDoneName");
elements.genshinMinutes = document.querySelector("#genshinMinutes");
elements.genshinProgressBar = document.querySelector("#genshinProgressBar");
elements.playtimeTrack = document.querySelector(".playtime-track");
elements.currentTime = document.querySelector("#currentTime");
elements.challengeModeToggle = document.querySelector("#challengeModeToggle");

let state = loadState();
let activeView = "daily";
let activeProjectId = state.projects[0]?.id || null;
let lastChallengeCloudSync = 0;
state.activePeriod = "daily";

function cloneSeed() { return JSON.parse(JSON.stringify(seedState)); }

function loadState() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
    if (saved && Array.isArray(saved.tasks) && Array.isArray(saved.projects)) {
      return window.PlannerTasks.normalize(saved);
    }
  } catch {}
  const initial = cloneSeed();
  try {
    const legacyDone = new Set(JSON.parse(localStorage.getItem(`daily-tasks:${getDateKey(new Date())}`)) || []);
    initial.tasks[0].done = legacyDone.has("room");
    initial.tasks[1].done = legacyDone.has("read");
  } catch {}
  return window.PlannerTasks.normalize(initial);
}

function saveState(touch = true) {
  if (touch) state.clientUpdatedAt = new Date().toISOString();
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  window.dispatchEvent(new CustomEvent("planner:state-saved"));
}

function saveChallengeState(now) {
  state.clientUpdatedAt = now.toISOString();
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  if (now.getTime() - lastChallengeCloudSync >= 15000) {
    lastChallengeCloudSync = now.getTime();
    window.dispatchEvent(new CustomEvent("planner:state-saved"));
  }
}
function getDateKey(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function normalizeDueTime(value) {
  const text = String(value || "").trim();
  const compact = text.replace(/[：:]/g, "");
  const match = compact.match(/^([01]\d|2[0-3])([0-5]\d)$/);
  return match ? `${match[1]}:${match[2]}` : "";
}

function taskPenaltyKey(task, projectId = "") {
  return projectId ? `project:${projectId}:${task.id}` : `task:${task.id}`;
}

function dueDateTime(task, now = new Date()) {
  const dueTime = normalizeDueTime(task.dueTime);
  if (!dueTime) return null;
  const dateText = task.dueDate || getDateKey(now);
  const due = new Date(`${dateText}T${dueTime}:00`);
  return Number.isFinite(due.getTime()) ? due : null;
}

function penaltyStartMs(task, key, now) {
  const due = dueDateTime(task, now);
  if (!due || now <= due) return 0;
  const lastPenaltyAt = state.challenge?.penalties?.[key]?.lastPenaltyAt;
  const last = lastPenaltyAt ? new Date(lastPenaltyAt) : null;
  const from = last && Number.isFinite(last.getTime()) && last > due ? last : due;
  return Math.max(0, Math.floor((now - from) / 1000));
}

function collectPenaltyTargets() {
  const targets = state.tasks.map((task) => ({ task, key: taskPenaltyKey(task) }));
  state.projects.forEach((project) => {
    (project.tasks || []).forEach((task) => targets.push({ task, key: taskPenaltyKey(task, project.id) }));
  });
  return targets.filter(({ task }) => normalizeDueTime(task.dueTime));
}

function applyChallengePenalty() {
  if (!state.challenge?.enabled) return;
  const now = new Date();
  let totalPenalty = 0;
  state.challenge.penalties ||= {};
  collectPenaltyTargets().forEach(({ task, key }) => {
    const seconds = penaltyStartMs(task, key, now);
    if (seconds <= 0) return;
    totalPenalty += seconds;
    const record = state.challenge.penalties[key] || { total: 0 };
    record.total = (Number(record.total) || 0) + seconds;
    record.lastPenaltyAt = now.toISOString();
    state.challenge.penalties[key] = record;
  });
  if (totalPenalty <= 0) return;
  state.primogems = Math.max(0, state.primogems - totalPenalty);
  saveChallengeState(now);
  showPenaltyNotice(totalPenalty);
  render();
}

let penaltyNoticeTimer;
function showPenaltyNotice(amount) {
  const notice = document.querySelector("#primogemNotice");
  notice.textContent = `挑戰逾時，扣除 ${amount} 原石`;
  notice.hidden = false;
  window.clearTimeout(penaltyNoticeTimer);
  penaltyNoticeTimer = window.setTimeout(() => { notice.hidden = true; }, 1600);
}
function createId(prefix) { return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`; }
function createHistoryEntry(task, project) {
  return {
    id: createId("history"), taskId: task.id, title: task.title,
    source: "project",
    projectId: project.id, projectName: project.name, taskType: task.taskType || "once",
    isMilestone: Boolean(task.isMilestone), completedAt: new Date().toISOString()
  };
}
function createTimelineHistoryEntry(task) {
  return {
    id: createId("history"), taskId: task.id, title: task.title,
    source: "timeline", period: task.period, completedAt: new Date().toISOString()
  };
}
function escapeHTML(value) {
  return String(value).replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[char]);
}

function recurrenceLabel(task) {
  if (task.taskType !== "recurring") return "";
  return { daily: "每日循環", monthly: "每月循環", yearly: "每年循環" }[task.recurrence || "daily"] || "每日循環";
}

function formatDue(task) {
  if (!task.dueDate && !task.dueTime) return "";
  let value = task.dueDate ? task.dueDate.replaceAll("-", "/") : "未定日期";
  const dueTime = normalizeDueTime(task.dueTime);
  if (dueTime) value += ` ${dueTime}`;
  return `截止 ${value}`;
}

function subtaskMarkup(task) {
  const subtasks = Array.isArray(task.subtasks) ? task.subtasks : [];
  const done = subtasks.filter((subtask) => subtask.done).length;
  return `<div class="subtask-panel">
    <div class="subtask-summary"><span>小任務</span><small>${done} / ${subtasks.length} 完成</small></div>
    <div class="subtask-list">
      ${subtasks.map((subtask) => `<label class="subtask-item">
        <input type="checkbox" data-subtask-id="${escapeHTML(subtask.id)}" ${subtask.done ? "checked" : ""}>
        <span>${escapeHTML(subtask.title)}</span>
        <button class="delete-subtask" type="button" data-subtask-id="${escapeHTML(subtask.id)}" aria-label="刪除小任務 ${escapeHTML(subtask.title)}">×</button>
      </label>`).join("")}
    </div>
    <form class="subtask-form">
      <input name="subtaskTitle" maxlength="36" placeholder="新增更小的任務">
      <button type="submit">加入</button>
    </form>
  </div>`;
}

function taskCard(task, index, type = "timeline", projectId = "") {
  const projectTypeLabel = task.taskType === "indicator"
    ? `<span class="task-type indicator">◆ 指標性任務</span>`
    : `<span class="task-type ${task.taskType === "recurring" ? "recurring" : "once"}">${task.taskType === "recurring" ? `↻ 循環性任務・${recurrenceLabel(task)}` : "✓ 一次性任務"}</span>`;
  const due = formatDue(task);
  const note = `<span class="task-meta">${projectTypeLabel}${due ? `<span class="task-due">${escapeHTML(due)}</span>` : ""}</span>`;
  return `<article class="task-card ${task.done ? "done" : ""}" data-id="${escapeHTML(task.id)}" data-kind="${type}" ${projectId ? `data-project-id="${escapeHTML(projectId)}"` : ""}>
    <button class="task-toggle" type="button" aria-pressed="${task.done}" aria-label="${task.done ? "設為未完成" : "設為完成"}：${escapeHTML(task.title)}">
      <span class="task-number">${String(index + 1).padStart(2, "0")}</span>
      <span class="checkmark" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="m5 12 4.5 4.5L19 7"/></svg></span>
    </button>
    <span class="task-text"><strong>${escapeHTML(task.title)}</strong><small>${note}</small></span>
    <button class="icon-button delete-task" type="button" aria-label="刪除 ${escapeHTML(task.title)}" title="刪除任務"><svg viewBox="0 0 24 24"><path d="M5 7h14M9 7V4h6v3M8 10v8M12 10v8M16 10v8M6.5 7l1 14h9l1-14"/></svg></button>
    ${subtaskMarkup(task)}
  </article>`;
}

function renderTasks() {
  const meta = periodMeta[state.activePeriod] || periodMeta.daily;
  const tasks = state.tasks.filter((task) => task.period === state.activePeriod);
  const projectRecurringTasks = state.projects.flatMap((project) => (project.tasks || [])
    .filter((task) => task.taskType === "recurring")
    .map((task) => ({ project, task })));
  elements.periodTitle.textContent = meta.title;
  elements.periodKicker.textContent = meta.kicker;
  elements.periodDescription.textContent = meta.description;
  elements.taskList.innerHTML = tasks.map((task, index) => taskCard(task, index)).join("");
  elements.taskEmpty.hidden = tasks.length > 0;
  elements.dailyProjectRecurring.hidden = state.activePeriod !== "daily" || projectRecurringTasks.length === 0;
  elements.projectRecurringList.innerHTML = state.activePeriod === "daily"
    ? projectRecurringTasks.map(({ project, task }, index) => taskCard({ ...task, title: `${project.name}｜${task.title}` }, index, "project-recurring", project.id)).join("")
    : "";
  document.querySelectorAll(".period-tab").forEach((tab) => {
    const view = tab.dataset.view;
    const active = view === activeView;
    tab.classList.toggle("active", active);
    tab.setAttribute("aria-selected", String(active));
    const count = view === "projects"
      ? state.projects.length
      : state.tasks.filter((task) => task.period === view && !task.done).length;
    tab.querySelector("small").textContent = count;
    tab.querySelector("small").hidden = count === 0;
  });
}

function getProjectProgress(project) {
  if (!project) return { done: 0, total: 0, percent: 0 };
  const archived = state.history.filter((entry) => entry.projectId === project.id);
  const progressTasks = project.tasks.filter((task) => task.taskType === "indicator" || task.isMilestone);
  const archivedProgress = archived.filter((entry) => entry.taskType === "indicator" || entry.isMilestone);
  const total = progressTasks.length + archivedProgress.length;
  const done = progressTasks.filter((task) => task.done).length + archivedProgress.length;
  return { done, total, percent: total ? Math.round(done / total * 100) : 0 };
}

function renderProjects() {
  const renderProjectCards = (projects) => projects.map((project) => {
    const isShort = project.projectType !== "long";
    const { done: progressDone, total: progressTotal, percent } = getProjectProgress(project);
    return `<article class="project-card ${isShort ? "short" : "long"}" data-project-id="${escapeHTML(project.id)}">
      <div class="project-header">
        <div class="project-mark" aria-hidden="true">◇</div>
        <div class="project-copy"><div class="project-title-line"><h3>${escapeHTML(project.name)}</h3><span class="project-type ${isShort ? "short" : "long"}">${isShort ? "短期案件" : "長期技能"}</span></div></div>
        <div class="project-progress ${isShort ? "short" : "long"}"><strong>${percent}%</strong><span>${progressDone} / ${progressTotal} 指標</span></div>
        <button class="icon-button delete-project" type="button" aria-label="刪除專案 ${escapeHTML(project.name)}" title="刪除專案"><svg viewBox="0 0 24 24"><path d="M5 7h14M9 7V4h6v3M8 10v8M12 10v8M16 10v8M6.5 7l1 14h9l1-14"/></svg></button>
      </div>
      <div class="project-progress-bar ${isShort ? "short" : "long"}"><i style="width:${percent}%"></i></div>
      <div class="current-goal">
        <div class="current-goal-heading">
          <span><i aria-hidden="true">◎</i> CURRENT GOAL・當前目標</span>
          <button class="edit-goal" type="button">${project.goal ? "編輯目標" : "設定目標"}</button>
        </div>
        <p class="current-goal-text">${escapeHTML(project.goal || "尚未設定當前目標")}</p>
        <form class="goal-form" hidden>
          <input name="goalText" maxlength="80" value="${escapeHTML(project.goal || "")}" placeholder="輸入目前最重要的專案目標" aria-label="當前目標" required>
          <button class="save-goal" type="submit">儲存</button>
          <button class="cancel-goal" type="button">取消</button>
        </form>
      </div>
      <div class="project-tasks">${project.tasks.map((task, index) => taskCard(task, index, "project", project.id)).join("")}</div>
      <form class="project-task-form">
        <input name="projectTaskName" maxlength="40" placeholder="新增這個專案的下一步…" aria-label="新增專案任務" required>
        <select name="projectTaskType" aria-label="任務類型">
          <option value="once">一次性任務</option>
          <option value="recurring">循環性任務</option>
          <option value="indicator">指標性任務・計入進度</option>
        </select>
        <select name="projectTaskRecurrence" aria-label="循環頻率">
          <option value="daily">每日循環</option>
          <option value="monthly">每月循環</option>
          <option value="yearly">每年循環</option>
        </select>
        <input name="projectDueDate" type="date" aria-label="截止日期">
        <input name="projectDueTime" type="text" inputmode="numeric" maxlength="4" pattern="^([01]\d|2[0-3])[0-5]\d$" placeholder="2030" title="請輸入 4 位 24 小時制數字，例如 1205 或 2030" aria-label="截止時間，4 位數字">
        <button type="submit">加入</button>
      </form>
    </article>`;
  }).join("");

  const groups = [
    { type: "long", label: "LONG-TERM GROWTH", title: "長期技能養成", description: "持續累積，只有指標性任務會推動進度。" },
    { type: "short", label: "SHORT-TERM CASES", title: "短期案件", description: "聚焦交付，只有指標性任務會推動進度。" }
  ];
  if (!state.projects.some((project) => project.id === activeProjectId)) activeProjectId = state.projects[0]?.id || null;
  const selector = groups.map((group) => {
    const projects = state.projects.filter((project) => (project.projectType || "short") === group.type);
    if (!projects.length) return "";
    return `<section class="project-selector-group ${group.type}">
      <div class="project-selector-label"><span>${group.label}</span><strong>${group.title}</strong></div>
      <div class="project-selector-tabs" role="tablist" aria-label="${group.title}">
        ${projects.map((project) => `<button class="project-selector-tab ${project.id === activeProjectId ? "active" : ""}" type="button" role="tab" aria-selected="${project.id === activeProjectId}" data-project-tab-id="${escapeHTML(project.id)}"><span>${escapeHTML(project.name)}</span><small ${project.tasks.length === 0 ? "hidden" : ""}>${project.tasks.length}</small></button>`).join("")}
      </div>
    </section>`;
  }).join("");
  const activeProject = state.projects.find((project) => project.id === activeProjectId);
  elements.projectList.innerHTML = activeProject ? `<div class="project-selector">${selector}</div><div class="active-project-panel">${renderProjectCards([activeProject])}</div>` : "";
  elements.projectEmpty.hidden = state.projects.length > 0;
}

function renderProgress() {
  const completedTasks = state.history.filter((entry) => entry.source === "timeline" && entry.period === activeView);
  const selectedProject = state.projects.find((project) => project.id === activeProjectId);
  const projectProgress = getProjectProgress(selectedProject);
  const done = activeView === "projects" ? projectProgress.done : completedTasks.length;
  const nameMap = { daily: "今日", weekly: "本周", monthly: "本月", yearly: "今年", projects: "專案" };
  elements.viewDoneName.textContent = nameMap[activeView];
  elements.todayDoneCount.textContent = done;
}

function renderPlaytime() {
  const minutes = Math.max(0, Math.min(60, Number(state.genshinPlaytime?.minutes) || 0));
  const percent = Math.round(minutes / 60 * 100);
  elements.genshinMinutes.textContent = minutes;
  elements.genshinProgressBar.style.width = `${percent}%`;
  elements.playtimeTrack.setAttribute("aria-valuenow", String(minutes));
}

function renderVisibility() {
  const showingProjects = activeView === "projects";
  elements.timelineView.hidden = showingProjects;
  elements.projectView.hidden = !showingProjects;
}

function fitPrimogemCount() {
  const count = document.querySelector("#primogemCount");
  count.style.fontSize = "28px";
  if (count.scrollWidth > count.clientWidth && count.clientWidth > 0) {
    count.style.fontSize = `${Math.floor(28 * count.clientWidth / count.scrollWidth * 0.95)}px`;
  }
}
window.addEventListener("resize", fitPrimogemCount);
document.fonts.ready.then(fitPrimogemCount);
function renderChallengeMode() {
  const enabled = Boolean(state.challenge?.enabled);
  elements.challengeModeToggle.textContent = enabled ? "挑戰模式" : "普通模式";
  elements.challengeModeToggle.setAttribute("aria-pressed", String(enabled));
  elements.challengeModeToggle.classList.toggle("active", enabled);
}

function renderCurrentTime() {
  const now = new Date();
  const text = new Intl.DateTimeFormat("zh-TW", { hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).format(now);
  elements.currentTime.textContent = text;
  elements.currentTime.dateTime = now.toISOString();
}

function render() { document.querySelector("#primogemCount").textContent = state.primogems.toLocaleString("zh-TW"); fitPrimogemCount(); renderTasks(); if (activeView === "projects") renderProjects(); renderProgress(); renderPlaytime(); renderChallengeMode(); renderCurrentTime(); renderVisibility(); }

function mutateTask(id, projectId, mutation) {
  if (projectId) {
    const project = state.projects.find((item) => item.id === projectId);
    const task = project?.tasks.find((item) => item.id === id);
    if (task) mutation(task, project.tasks);
  } else {
    const task = state.tasks.find((item) => item.id === id);
    if (task) mutation(task, state.tasks);
  }
  saveState(); render();
}

function toggleProjectTask(projectId, taskId) {
  const completed = window.PlannerTasks.complete(state, taskId, projectId);
  if (!completed) return false;
  awardPrimogems();
  saveState(); render();
  return true;
}

function taskFromCard(card) {
  const projectId = card.dataset.projectId || "";
  if (projectId) {
    const project = state.projects.find((item) => item.id === projectId);
    return { task: project?.tasks.find((item) => item.id === card.dataset.id), projectId };
  }
  return { task: state.tasks.find((item) => item.id === card.dataset.id), projectId: "" };
}

function maybeCompleteAfterSubtasks(task, projectId) {
  const subtasks = Array.isArray(task?.subtasks) ? task.subtasks : [];
  if (subtasks.length === 0 || subtasks.some((subtask) => !subtask.done)) return false;
  const completed = window.PlannerTasks.complete(state, task.id, projectId);
  if (!completed) return false;
  awardPrimogems();
  saveState();
  render();
  launchConfetti();
  return true;
}

function showSubtaskNotice() {
  const notice = document.querySelector("#primogemNotice");
  notice.textContent = "請先完成全部小任務";
  notice.hidden = false;
  window.clearTimeout(rewardNoticeTimer);
  rewardNoticeTimer = window.setTimeout(() => { notice.hidden = true; }, 1800);
}

function handleSubtaskClick(event) {
  const card = event.target.closest(".task-card");
  if (!card) return false;
  const { task, projectId } = taskFromCard(card);
  if (!task) return false;
  if (event.target.matches(".subtask-item input[type='checkbox']")) {
    const subtask = task.subtasks.find((item) => item.id === event.target.dataset.subtaskId);
    if (!subtask) return true;
    subtask.done = event.target.checked;
    if (!maybeCompleteAfterSubtasks(task, projectId)) {
      saveState();
      render();
    }
    return true;
  }
  const deleteButton = event.target.closest(".delete-subtask");
  if (deleteButton) {
    task.subtasks = task.subtasks.filter((item) => item.id !== deleteButton.dataset.subtaskId);
    saveState();
    render();
    return true;
  }
  return false;
}

function handleSubtaskSubmit(event) {
  const form = event.target.closest(".subtask-form");
  if (!form) return false;
  event.preventDefault();
  const card = form.closest(".task-card");
  const { task } = taskFromCard(card);
  const title = form.elements.subtaskTitle.value.trim();
  if (!task || !title) return true;
  task.subtasks ||= [];
  task.subtasks.push({ id: createId("subtask"), title, done: false });
  saveState();
  render();
  return true;
}

let rewardNoticeTimer;
function awardPrimogems() {
  const notice = document.querySelector("#primogemNotice");
  notice.textContent = "任務完成！獲得 20 原石 ✦";
  notice.hidden = false;
  window.clearTimeout(rewardNoticeTimer);
  rewardNoticeTimer = window.setTimeout(() => { notice.hidden = true; }, 2600);
}

document.querySelector("#primogemHelp").addEventListener("click", () => {
  const help = document.querySelector("#primogemHelpText");
  help.hidden = !help.hidden;
  document.querySelector("#primogemHelp").setAttribute("aria-expanded", String(!help.hidden));
});

function launchConfetti() {
  // The existing reward notice is sufficient feedback; no particle loop.
  elements.celebration.setAttribute("aria-label", "太棒了，任務完成！獲得 20 原石。");
}

elements.periodTabs.addEventListener("click", (event) => {
  const tab = event.target.closest(".period-tab");
  if (!tab) return;
  activeView = tab.dataset.view;
  if (activeView !== "projects") state.activePeriod = activeView;
  elements.taskForm.hidden = true;
  render();
});

elements.challengeModeToggle.addEventListener("click", () => {
  state.challenge ||= { enabled: false, penalties: {} };
  state.challenge.enabled = !state.challenge.enabled;
  if (!state.challenge.enabled) state.challenge.penalties ||= {};
  saveState();
  render();
});

elements.taskList.addEventListener("click", (event) => {
  if (handleSubtaskClick(event)) return;
  const card = event.target.closest(".task-card");
  if (!card) return;
  if (event.target.closest(".delete-task")) {
    mutateTask(card.dataset.id, "", (_task, list) => list.splice(list.findIndex((item) => item.id === card.dataset.id), 1));
  } else if (event.target.closest(".task-toggle")) {
    const { task } = taskFromCard(card);
    if (task?.subtasks?.some((subtask) => !subtask.done)) {
      showSubtaskNotice();
      return;
    }
    if (window.PlannerTasks.complete(state, card.dataset.id)) {
      awardPrimogems();
      saveState(); render();
      launchConfetti();
    }
  }
});
elements.taskList.addEventListener("submit", handleSubtaskSubmit);

elements.projectRecurringList.addEventListener("click", (event) => {
  if (handleSubtaskClick(event)) return;
  const card = event.target.closest(".task-card");
  if (!card) return;
  if (event.target.closest(".delete-task")) {
    mutateTask(card.dataset.id, card.dataset.projectId, (_task, list) => list.splice(list.findIndex((item) => item.id === card.dataset.id), 1));
  } else if (event.target.closest(".task-toggle")) {
    const { task } = taskFromCard(card);
    if (task?.subtasks?.some((subtask) => !subtask.done)) {
      showSubtaskNotice();
      return;
    }
    if (toggleProjectTask(card.dataset.projectId, card.dataset.id)) launchConfetti();
  }
});
elements.projectRecurringList.addEventListener("submit", handleSubtaskSubmit);

elements.projectList.addEventListener("click", (event) => {
  if (handleSubtaskClick(event)) return;
  const projectTab = event.target.closest(".project-selector-tab");
  if (projectTab) {
    activeProjectId = projectTab.dataset.projectTabId;
    renderProjects(); renderProgress();
    return;
  }
  const projectCard = event.target.closest(".project-card");
  if (!projectCard) return;
  if (event.target.closest(".edit-goal")) {
    const goalBox = projectCard.querySelector(".current-goal");
    goalBox.querySelector(".current-goal-text").hidden = true;
    goalBox.querySelector(".edit-goal").hidden = true;
    goalBox.querySelector(".goal-form").hidden = false;
    goalBox.querySelector("[name='goalText']").focus();
    return;
  }
  if (event.target.closest(".cancel-goal")) {
    renderProjects();
    return;
  }
  const task = event.target.closest(".task-card");
  if (event.target.closest(".delete-project")) {
    state.projects = state.projects.filter((project) => project.id !== projectCard.dataset.projectId);
    activeProjectId = state.projects[0]?.id || null;
    saveState(); render();
  } else if (task && event.target.closest(".delete-task")) {
    mutateTask(task.dataset.id, projectCard.dataset.projectId, (_item, list) => list.splice(list.findIndex((item) => item.id === task.dataset.id), 1));
  } else if (task && event.target.closest(".task-toggle")) {
    const { task: targetTask } = taskFromCard(task);
    if (targetTask?.subtasks?.some((subtask) => !subtask.done)) {
      showSubtaskNotice();
      return;
    }
    if (toggleProjectTask(projectCard.dataset.projectId, task.dataset.id)) launchConfetti();
  }
});

elements.projectList.addEventListener("submit", (event) => {
  if (handleSubtaskSubmit(event)) return;
  const goalForm = event.target.closest(".goal-form");
  if (goalForm) {
    event.preventDefault();
    const projectId = goalForm.closest(".project-card").dataset.projectId;
    const project = state.projects.find((item) => item.id === projectId);
    const goal = goalForm.elements.goalText.value.trim();
    if (!project || !goal) return;
    project.goal = goal;
    saveState(); renderProjects();
    return;
  }
  const form = event.target.closest(".project-task-form");
  if (!form) return;
  event.preventDefault();
  const project = state.projects.find((item) => item.id === form.closest(".project-card").dataset.projectId);
  const title = form.elements.projectTaskName.value.trim();
  const allowedTypes = new Set(["once", "recurring", "indicator"]);
  const taskType = allowedTypes.has(form.elements.projectTaskType.value) ? form.elements.projectTaskType.value : "once";
  const recurrence = ["daily", "monthly", "yearly"].includes(form.elements.projectTaskRecurrence.value) ? form.elements.projectTaskRecurrence.value : "daily";
  const dueDate = form.elements.projectDueDate.value;
  const dueTime = normalizeDueTime(form.elements.projectDueTime.value);
  if (!project || !title) return;
  project.tasks.push({ id: createId("project-task"), title, taskType, recurrence, dueDate, dueTime, isMilestone: taskType === "indicator", done: false });
  saveState(); render();
});

document.querySelector("#showTaskForm").addEventListener("click", () => { elements.taskForm.hidden = false; document.querySelector("#taskName").focus(); });
document.querySelector("#cancelTask").addEventListener("click", () => { elements.taskForm.reset(); elements.taskForm.hidden = true; });
elements.taskForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const title = document.querySelector("#taskName").value.trim();
  const taskType = document.querySelector("#taskType").value === "recurring" ? "recurring" : "once";
  const recurrence = ["daily", "monthly", "yearly"].includes(document.querySelector("#taskRecurrence").value) ? document.querySelector("#taskRecurrence").value : "daily";
  const dueDate = document.querySelector("#taskDueDate").value;
  const dueTime = normalizeDueTime(document.querySelector("#taskDueTime").value);
  if (!title) return;
  state.tasks.push({ id: createId("task"), period: state.activePeriod, title, taskType, recurrence, dueDate, dueTime, done: false });
  elements.taskForm.reset(); elements.taskForm.hidden = true;
  saveState(); render();
});

document.querySelector("#showProjectForm").addEventListener("click", () => { elements.projectForm.hidden = false; document.querySelector("#projectName").focus(); });
document.querySelector("#cancelProject").addEventListener("click", () => { elements.projectForm.reset(); elements.projectForm.hidden = true; });
elements.projectForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const name = document.querySelector("#projectName").value.trim();
  const goal = document.querySelector("#projectGoal").value.trim();
  const projectType = document.querySelector("#projectType").value === "long" ? "long" : "short";
  if (!name) return;
  const project = { id: createId("project"), name, goal, projectType, tasks: [] };
  state.projects.push(project);
  activeProjectId = project.id;
  elements.projectForm.reset(); elements.projectForm.hidden = true;
  saveState(); render();
});


const installApp = document.querySelector("#installApp");
window.addEventListener("beforeinstallprompt", (event) => {
  event.preventDefault();
  deferredInstallPrompt = event;
  installApp.hidden = false;
});

installApp.addEventListener("click", async () => {
  if (!deferredInstallPrompt) return;
  deferredInstallPrompt.prompt();
  await deferredInstallPrompt.userChoice;
  deferredInstallPrompt = null;
  installApp.hidden = true;
});

window.addEventListener("appinstalled", () => {
  deferredInstallPrompt = null;
  installApp.hidden = true;
});

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => navigator.serviceWorker.register("./sw.js"));
}

const loginDialog = document.querySelector("#loginDialog");
const openLogin = document.querySelector("#openLogin");
const closeLogin = document.querySelector("#closeLogin");
const loginForm = document.querySelector("#loginForm");

openLogin.addEventListener("click", () => {
  if (location.protocol === "file:") {
    document.querySelector("#loginMessage").textContent = "請使用「啟動PWA.cmd」開啟網站後再登入。";
  }
  if (!loginDialog.open) loginDialog.showModal();
});
closeLogin.addEventListener("click", () => loginDialog.close());
loginDialog.addEventListener("click", (event) => { if (event.target === loginDialog) loginDialog.close(); });
loginForm.addEventListener("submit", (event) => event.preventDefault());

saveState(false);
render();
setInterval(() => {
  renderCurrentTime();
  applyChallengePenalty();
}, 1000);

// Refresh when history restores a task in another tab or from the back-forward cache.
function refreshSavedTasks() { state = loadState(); saveState(false); render(); scheduleDailyReset(); }
window.addEventListener("pageshow", refreshSavedTasks);
window.addEventListener("storage", (event) => { if (event.key === STORAGE_KEY) refreshSavedTasks(); });
window.addEventListener("planner:state-loaded", refreshSavedTasks);
let resetTimer;
function scheduleDailyReset() {
  clearTimeout(resetTimer);
  if (document.hidden) return;
  const now = new Date();
  const next = new Date(now);
  next.setHours(0, 0, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);
  resetTimer = setTimeout(refreshSavedTasks, next - now + 100);
}
document.addEventListener("visibilitychange", () => {
  if (document.hidden) clearTimeout(resetTimer);
  else refreshSavedTasks();
});
scheduleDailyReset();
