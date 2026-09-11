const STORAGE_KEY = "life-planner:v2";
const historyList = document.querySelector("#historyList");
const historyEmpty = document.querySelector("#historyEmpty");
const historyCount = document.querySelector("#historyCount");
const historyTabs = document.querySelector("#historyTabs");
const historyTitle = document.querySelector("#historyTitle");
const historyLabel = document.querySelector("#historyLabel");
const historyEmptyHint = document.querySelector("#historyEmptyHint");
let activeFilter = "daily";

const filterMeta = {
  daily: { title: "今日完成紀錄", label: "TODAY'S HISTORY", hint: "完成今日任務後，它會出現在這裡。", type: "今日任務" },
  weekly: { title: "本周完成紀錄", label: "WEEKLY HISTORY", hint: "完成本周任務後，它會出現在這裡。", type: "本周任務" },
  monthly: { title: "本月完成紀錄", label: "MONTHLY HISTORY", hint: "完成本月任務後，它會出現在這裡。", type: "本月任務" },
  yearly: { title: "今年完成紀錄", label: "YEARLY HISTORY", hint: "完成今年任務後，它會出現在這裡。", type: "今年任務" },
  projects: { title: "專案完成紀錄", label: "PROJECT HISTORY", hint: "完成專案任務後，它會出現在這裡。", type: "專案任務" }
};

function escapeHTML(value) {
  return String(value).replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[char]);
}

function loadHistory() {
  try {
    const state = window.PlannerTasks.normalize(JSON.parse(localStorage.getItem(STORAGE_KEY)));
    if (!state) return [];
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    return state.history.slice();
  } catch { return []; }
}

function dateKey(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "unknown";
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function formatDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "日期未記錄";
  return new Intl.DateTimeFormat("zh-TW", { year: "numeric", month: "long", day: "numeric", weekday: "short" }).format(date);
}

function formatTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("zh-TW", { hour: "2-digit", minute: "2-digit" }).format(date);
}

function render() {
  const allEntries = loadHistory();
  const isProjectEntry = (entry) => entry.source === "project" || Boolean(entry.projectId);
  const entries = allEntries.filter((entry) => activeFilter === "projects" ? isProjectEntry(entry) : !isProjectEntry(entry) && entry.period === activeFilter)
    .sort((a, b) => new Date(b.completedAt) - new Date(a.completedAt));
  const meta = filterMeta[activeFilter];
  historyCount.textContent = entries.length;
  historyEmpty.hidden = entries.length > 0;
  historyTitle.textContent = meta.title;
  historyLabel.textContent = meta.label;
  historyEmptyHint.textContent = meta.hint;

  document.querySelectorAll("[data-history-filter]").forEach((button) => {
    const filter = button.dataset.historyFilter;
    const active = filter === activeFilter;
    const count = allEntries.filter((entry) => filter === "projects" ? isProjectEntry(entry) : !isProjectEntry(entry) && entry.period === filter).length;
    button.classList.toggle("active", active);
    button.setAttribute("aria-selected", String(active));
    button.querySelector("small").textContent = count;
    button.querySelector("small").hidden = count === 0;
  });

  const groups = new Map();
  entries.forEach((entry) => {
    const key = dateKey(entry.completedAt);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(entry);
  });

  historyList.innerHTML = [...groups.values()].map((items) => `
    <section class="history-group">
      <div class="history-date"><span>${escapeHTML(formatDate(items[0].completedAt))}</span><i></i><small>${items.length} 件</small></div>
      <div class="history-items">
        ${items.map((entry) => `
          <article class="history-item">
            <span class="history-check" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="m5 12 4.5 4.5L19 7"/></svg></span>
            <div><h3>${escapeHTML(entry.title || "未命名任務")}</h3><p><span>${escapeHTML(isProjectEntry(entry) ? (entry.projectName || "未命名專案") : meta.type)}</span>・完成於 ${escapeHTML(formatTime(entry.completedAt))}</p></div>
            <span class="history-type ${entry.isMilestone ? "milestone" : ""}">${isProjectEntry(entry) ? (entry.isMilestone || entry.taskType === "indicator" ? "指標性任務" : entry.taskType === "recurring" ? "循環性任務" : "一次性") : meta.type}</span>
            <button class="restore-task" type="button" data-restore-id="${escapeHTML(entry.id)}" aria-label="恢復任務：${escapeHTML(entry.title || "未命名任務")}">恢復任務</button>
          </article>`).join("")}
      </div>
    </section>`).join("");
}

historyTabs.addEventListener("click", (event) => {
  const button = event.target.closest("[data-history-filter]");
  if (!button) return;
  activeFilter = button.dataset.historyFilter;
  render();
});

render();

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => navigator.serviceWorker.register("./sw.js"));
}

historyList.addEventListener("click", (event) => {
  const button = event.target.closest("[data-restore-id]");
  if (!button) return;
  const status = document.querySelector("#restoreStatus");
  try {
    const state = window.PlannerTasks.normalize(JSON.parse(localStorage.getItem(STORAGE_KEY)));
    if (!state) throw new Error("Missing save");
    const result = window.PlannerTasks.restore(state, button.dataset.restoreId);
    if (result.ok) {
      state.clientUpdatedAt = new Date().toISOString();
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
      window.dispatchEvent(new CustomEvent("planner:state-saved", { detail: { immediate: true } }));
    }
    render();
    status.textContent = result.message;
  } catch { status.textContent = "恢復失敗，請確認瀏覽器允許儲存資料後重試。"; }
});
window.addEventListener("pageshow", render);
window.addEventListener("storage", (event) => { if (event.key === STORAGE_KEY) render(); });
window.addEventListener("planner:state-loaded", render);
