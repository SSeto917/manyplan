const STORAGE_KEY = "life-planner:v2";
const incompleteList = document.querySelector("#incompleteList");
const incompleteEmpty = document.querySelector("#incompleteEmpty");
const incompleteCount = document.querySelector("#incompleteCount");
const incompleteTabs = document.querySelector("#incompleteTabs");
const incompleteTitle = document.querySelector("#incompleteTitle");
const incompleteLabel = document.querySelector("#incompleteLabel");
const incompleteEmptyHint = document.querySelector("#incompleteEmptyHint");
let activeFilter = "daily";

const filterMeta = {
  daily: { title: "今日未完成", label: "TODAY'S UNFINISHED", hint: "今日任務清空後，未完成的一次性任務會出現在這裡。", type: "今日任務" },
  weekly: { title: "本周未完成", label: "WEEKLY UNFINISHED", hint: "本周任務清空後，未完成的一次性任務會出現在這裡。", type: "本周任務" },
  monthly: { title: "本月未完成", label: "MONTHLY UNFINISHED", hint: "本月任務清空後，未完成的一次性任務會出現在這裡。", type: "本月任務" }
};

function escapeHTML(value) {
  return String(value).replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[char]);
}

function loadState() {
  try {
    const state = window.PlannerTasks.normalize(JSON.parse(localStorage.getItem(STORAGE_KEY)));
    if (!state) return null;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    return state;
  } catch {
    return null;
  }
}

function formatDateTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "時間未記錄";
  return new Intl.DateTimeFormat("zh-TW", { month: "long", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(date);
}

function formatDue(entry) {
  const task = entry.taskSnapshot || {};
  if (!task.dueDate && !task.dueTime) return "";
  let value = task.dueDate ? task.dueDate.replaceAll("-", "/") : "未定日期";
  const compact = String(task.dueTime || "").trim().replace(/[：:]/g, "");
  const match = compact.match(/^([01]\d|2[0-3])([0-5]\d)$/);
  if (match) value += ` ${match[1]}:${match[2]}`;
  return `・截止 ${value}`;
}

function render() {
  const state = loadState();
  const allEntries = state?.incomplete || [];
  const entries = allEntries.filter((entry) => entry.period === activeFilter)
    .sort((a, b) => new Date(b.missedAt) - new Date(a.missedAt));
  const meta = filterMeta[activeFilter];
  incompleteCount.textContent = entries.length;
  incompleteEmpty.hidden = entries.length > 0;
  incompleteTitle.textContent = meta.title;
  incompleteLabel.textContent = meta.label;
  incompleteEmptyHint.textContent = meta.hint;

  document.querySelectorAll("[data-incomplete-filter]").forEach((button) => {
    const filter = button.dataset.incompleteFilter;
    const active = filter === activeFilter;
    const count = allEntries.filter((entry) => entry.period === filter).length;
    button.classList.toggle("active", active);
    button.setAttribute("aria-selected", String(active));
    button.querySelector("small").textContent = count;
    button.querySelector("small").hidden = count === 0;
  });

  incompleteList.innerHTML = entries.map((entry) => `
    <article class="history-item">
      <span class="history-check unfinished-check" aria-hidden="true">!</span>
      <div><h3>${escapeHTML(entry.title || "未命名任務")}</h3><p><span>${escapeHTML(meta.type)}</span>・清空於 ${escapeHTML(formatDateTime(entry.missedAt))}${escapeHTML(formatDue(entry))}</p></div>
      <span class="history-type">一次性</span>
      <button class="restore-task" type="button" data-restore-incomplete-id="${escapeHTML(entry.id)}" aria-label="移回任務：${escapeHTML(entry.title || "未命名任務")}">移回任務</button>
    </article>`).join("");
}

incompleteTabs.addEventListener("click", (event) => {
  const button = event.target.closest("[data-incomplete-filter]");
  if (!button) return;
  activeFilter = button.dataset.incompleteFilter;
  render();
});

incompleteList.addEventListener("click", (event) => {
  const button = event.target.closest("[data-restore-incomplete-id]");
  if (!button) return;
  const status = document.querySelector("#incompleteStatus");
  try {
    const state = window.PlannerTasks.normalize(JSON.parse(localStorage.getItem(STORAGE_KEY)));
    if (!state) throw new Error("Missing save");
    const result = window.PlannerTasks.restoreIncomplete(state, button.dataset.restoreIncompleteId);
    if (result.ok) {
      state.clientUpdatedAt = new Date().toISOString();
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
      window.dispatchEvent(new CustomEvent("planner:state-saved", { detail: { immediate: true } }));
    }
    render();
    status.textContent = result.message;
  } catch {
    status.textContent = "移回失敗，請確認瀏覽器允許儲存資料後重試。";
  }
});

render();

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => navigator.serviceWorker.register("./sw.js"));
}

window.addEventListener("pageshow", render);
window.addEventListener("storage", (event) => { if (event.key === STORAGE_KEY) render(); });
window.addEventListener("planner:state-loaded", render);
