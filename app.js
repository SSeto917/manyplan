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
  projectList: document.querySelector("#projectList"), projectEmpty: document.querySelector("#projectEmpty"),
  periodTabs: document.querySelector("#periodTabs"), periodTitle: document.querySelector("#periodTitle"),
  periodKicker: document.querySelector("#periodKicker"), periodDescription: document.querySelector("#periodDescription"),
  taskForm: document.querySelector("#taskForm"), projectForm: document.querySelector("#projectForm"),
  todayDoneCount: document.querySelector("#todayDoneCount"), timelineView: document.querySelector("#timelineView"),
  projectView: document.querySelector("#projectView"), celebration: document.querySelector("#celebration")
};
elements.viewDoneName = document.querySelector("#viewDoneName");

let state = loadState();
let activeView = "daily";
let activeProjectId = state.projects[0]?.id || null;
state.activePeriod = "daily";

function cloneSeed() { return JSON.parse(JSON.stringify(seedState)); }

function loadState() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
    if (saved && Array.isArray(saved.tasks) && Array.isArray(saved.projects)) {
      saved.primogems = Number.isSafeInteger(saved.primogems) && saved.primogems >= 0 ? saved.primogems : 0;
      if (!Array.isArray(saved.history)) saved.history = [];
      saved.tasks.forEach((task) => {
        if (task.done && !task.completionHistoryId) {
          const existing = saved.history.find((entry) => entry.source === "timeline" && entry.taskId === task.id);
          const entry = existing || createTimelineHistoryEntry(task);
          if (!existing) saved.history.push(entry);
          task.completionHistoryId = entry.id;
          task.completedAt = entry.completedAt;
        }
      });
      saved.projects.forEach((project) => {
        if (!project.projectType) project.projectType = "short";
        project.tasks.forEach((task) => {
          if (task.isMilestone) task.taskType = "indicator";
          else if (!task.taskType) task.taskType = "once";
        });
        const completedOnce = project.tasks.filter((task) => task.taskType === "once" && task.done);
        completedOnce.forEach((task) => saved.history.push(createHistoryEntry(task, project)));
        project.tasks = project.tasks.filter((task) => !(task.taskType === "once" && task.done));
      });
      return saved;
    }
  } catch {}
  const initial = cloneSeed();
  try {
    const legacyDone = new Set(JSON.parse(localStorage.getItem(`daily-tasks:${getDateKey(new Date())}`)) || []);
    initial.tasks[0].done = legacyDone.has("room");
    initial.tasks[1].done = legacyDone.has("read");
  } catch {}
  return initial;
}

function saveState() { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); }
function getDateKey(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
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

function taskCard(task, index, type = "timeline", projectId = "") {
  const projectTypeLabel = task.taskType === "indicator"
    ? `<span class="task-type indicator">◆ 指標性任務</span>`
    : `<span class="task-type ${task.taskType === "recurring" ? "recurring" : "once"}">${task.taskType === "recurring" ? "↻ 循環性任務" : "✓ 一次性任務"}</span>`;
  const note = type === "timeline"
    ? escapeHTML(task.note || "完成它，替自己留下一個小小的進度。")
    : `<span class="task-meta">${projectTypeLabel}</span>`;
  return `<article class="task-card ${task.done ? "done" : ""}" data-id="${escapeHTML(task.id)}" data-kind="${type}" ${projectId ? `data-project-id="${escapeHTML(projectId)}"` : ""}>
    <button class="task-toggle" type="button" aria-pressed="${task.done}" aria-label="${task.done ? "設為未完成" : "設為完成"}：${escapeHTML(task.title)}">
      <span class="task-number">${String(index + 1).padStart(2, "0")}</span>
      <span class="checkmark" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="m5 12 4.5 4.5L19 7"/></svg></span>
    </button>
    <span class="task-text"><strong>${escapeHTML(task.title)}</strong><small>${note}</small></span>
    <button class="icon-button delete-task" type="button" aria-label="刪除 ${escapeHTML(task.title)}" title="刪除任務"><svg viewBox="0 0 24 24"><path d="M5 7h14M9 7V4h6v3M8 10v8M12 10v8M16 10v8M6.5 7l1 14h9l1-14"/></svg></button>
  </article>`;
}

function renderTasks() {
  const meta = periodMeta[state.activePeriod] || periodMeta.daily;
  const tasks = state.tasks.filter((task) => task.period === state.activePeriod);
  elements.periodTitle.textContent = meta.title;
  elements.periodKicker.textContent = meta.kicker;
  elements.periodDescription.textContent = meta.description;
  elements.taskList.innerHTML = tasks.map((task, index) => taskCard(task, index)).join("");
  elements.taskEmpty.hidden = tasks.length > 0;
  document.querySelectorAll(".period-tab").forEach((tab) => {
    const view = tab.dataset.view;
    const active = view === activeView;
    tab.classList.toggle("active", active);
    tab.setAttribute("aria-selected", String(active));
    tab.querySelector("small").textContent = view === "projects"
      ? state.projects.length
      : state.tasks.filter((task) => task.period === view && !task.done).length;
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
        ${projects.map((project) => `<button class="project-selector-tab ${project.id === activeProjectId ? "active" : ""}" type="button" role="tab" aria-selected="${project.id === activeProjectId}" data-project-tab-id="${escapeHTML(project.id)}"><span>${escapeHTML(project.name)}</span><small>${project.tasks.length}</small></button>`).join("")}
      </div>
    </section>`;
  }).join("");
  const activeProject = state.projects.find((project) => project.id === activeProjectId);
  elements.projectList.innerHTML = activeProject ? `<div class="project-selector">${selector}</div><div class="active-project-panel">${renderProjectCards([activeProject])}</div>` : "";
  elements.projectEmpty.hidden = state.projects.length > 0;
}

function renderProgress() {
  const allTasks = state.tasks.filter((task) => task.period === activeView);
  const selectedProject = state.projects.find((project) => project.id === activeProjectId);
  const projectProgress = getProjectProgress(selectedProject);
  const done = activeView === "projects" ? projectProgress.done : allTasks.filter((task) => task.done).length;
  const nameMap = { daily: "今日", weekly: "本周", monthly: "本月", yearly: "今年", projects: "專案" };
  elements.viewDoneName.textContent = nameMap[activeView];
  elements.todayDoneCount.textContent = done;
}

function renderVisibility() {
  const showingProjects = activeView === "projects";
  elements.timelineView.hidden = showingProjects;
  elements.projectView.hidden = !showingProjects;
}

function render() { document.querySelector("#primogemCount").textContent = state.primogems.toLocaleString("zh-TW"); renderTasks(); if (activeView === "projects") renderProjects(); renderProgress(); renderVisibility(); }

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
  const project = state.projects.find((item) => item.id === projectId);
  const taskIndex = project?.tasks.findIndex((item) => item.id === taskId) ?? -1;
  if (!project || taskIndex < 0) return false;
  const task = project.tasks[taskIndex];
  if (task.taskType !== "once") {
    task.done = !task.done;
    if (task.done) awardPrimogems();
    saveState(); render();
    return task.done;
  }
  awardPrimogems();
  state.history.push(createHistoryEntry(task, project));
  project.tasks.splice(taskIndex, 1);
  saveState(); render();
  return true;
}

let rewardNoticeTimer;
function awardPrimogems() {
  state.primogems += 20;
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

elements.taskList.addEventListener("click", (event) => {
  const card = event.target.closest(".task-card");
  if (!card) return;
  if (event.target.closest(".delete-task")) {
    mutateTask(card.dataset.id, "", (_task, list) => list.splice(list.findIndex((item) => item.id === card.dataset.id), 1));
  } else if (event.target.closest(".task-toggle")) {
    let becameDone = false;
    mutateTask(card.dataset.id, "", (task) => {
      task.done = !task.done;
      becameDone = task.done;
      if (task.done) {
        awardPrimogems();
        const entry = createTimelineHistoryEntry(task);
        state.history.push(entry);
        task.completionHistoryId = entry.id;
        task.completedAt = entry.completedAt;
      } else if (task.completionHistoryId) {
        state.history = state.history.filter((entry) => entry.id !== task.completionHistoryId);
        delete task.completionHistoryId;
        delete task.completedAt;
      }
    });
    if (becameDone) launchConfetti();
  }
});

elements.projectList.addEventListener("click", (event) => {
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
    if (toggleProjectTask(projectCard.dataset.projectId, task.dataset.id)) launchConfetti();
  }
});

elements.projectList.addEventListener("submit", (event) => {
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
  if (!project || !title) return;
  project.tasks.push({ id: createId("project-task"), title, taskType, isMilestone: taskType === "indicator", done: false });
  saveState(); render();
});

document.querySelector("#showTaskForm").addEventListener("click", () => { elements.taskForm.hidden = false; document.querySelector("#taskName").focus(); });
document.querySelector("#cancelTask").addEventListener("click", () => { elements.taskForm.reset(); elements.taskForm.hidden = true; });
elements.taskForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const title = document.querySelector("#taskName").value.trim();
  const note = document.querySelector("#taskNote").value.trim();
  if (!title) return;
  state.tasks.push({ id: createId("task"), period: state.activePeriod, title, note, done: false });
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

document.querySelector("#resetButton").addEventListener("click", () => {
  state.tasks.forEach((task) => {
    task.done = false;
    delete task.completionHistoryId;
    delete task.completedAt;
  });
  state.projects.forEach((project) => project.tasks.forEach((task) => { task.done = false; }));
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

saveState();
render();
