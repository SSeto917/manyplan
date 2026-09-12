const STORAGE_KEY = "life-planner:v2";

const elements = {
  count: document.querySelector("#questionCount"), tabs: document.querySelector("#subjectTabs"),
  form: document.querySelector("#questionForm"), subjectSelect: document.querySelector("#questionSubjectSelect"),
  newSubjectField: document.querySelector("#newSubjectField"), subject: document.querySelector("#questionSubject"),
  answer: document.querySelector("#questionAnswer"), raw: document.querySelector("#questionRaw"), explanation: document.querySelector("#questionExplanation"),
  preview: document.querySelector("#questionPreview"), status: document.querySelector("#questionStatus"), clear: document.querySelector("#clearQuestionForm"),
  list: document.querySelector("#questionList"), empty: document.querySelector("#questionEmpty"), label: document.querySelector("#questionListLabel"), title: document.querySelector("#questionListTitle"),
  toolbar: document.querySelector("#practiceToolbar"), progress: document.querySelector("#questionProgress"),
  prev: document.querySelector("#prevQuestion"), next: document.querySelector("#nextQuestion"), random: document.querySelector("#randomQuestion")
};

let activeSubject = "all";
let activeIndex = 0;
const answeredQuestions = new Map();

function escapeHTML(value) {
  return String(value ?? "").replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[char]);
}

function createId(prefix = "question") {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function loadState() {
  try {
    const state = JSON.parse(localStorage.getItem(STORAGE_KEY));
    const normalized = window.PlannerTasks?.normalize ? window.PlannerTasks.normalize(state) : state;
    if (normalized) return normalized;
  } catch {
  }
  return { activePeriod: "daily", history: [], incomplete: [], primogems: 0, tasks: [], projects: [], questionBank: { subjects: [], questions: [] } };
}

function ensureQuestionBank(state) {
  state.questionBank ||= { subjects: [], questions: [] };
  if (!Array.isArray(state.questionBank.subjects)) state.questionBank.subjects = [];
  if (!Array.isArray(state.questionBank.questions)) state.questionBank.questions = [];
  state.questionBank.questions.forEach((question) => {
    question.answerCount = Number.isSafeInteger(question.answerCount) && question.answerCount >= 0 ? question.answerCount : 0;
    question.explanation = String(question.explanation || "").trim();
  });
  return state.questionBank;
}

function saveState(state) {
  state.clientUpdatedAt = new Date().toISOString();
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  window.dispatchEvent(new CustomEvent("planner:state-saved", { detail: { immediate: true } }));
}

function normalizeSubject(value) {
  return String(value || "").trim().replace(/\s+/g, " ") || "未分類";
}

function parseQuestion(rawText) {
  const text = String(rawText || "").replace(/\r/g, "").trim();
  const optionPattern = /(?:^|\n)\s*[（(]\s*([A-Da-d])\s*[）)]\s*/g;
  const matches = [...text.matchAll(optionPattern)];
  if (matches.length < 4) return null;
  const options = [];
  for (let i = 0; i < matches.length; i += 1) {
    const label = matches[i][1].toUpperCase();
    const start = matches[i].index + matches[i][0].length;
    const end = i + 1 < matches.length ? matches[i + 1].index : text.length;
    if (["A", "B", "C", "D"].includes(label)) options.push({ label, text: text.slice(start, end).trim() });
  }
  const ordered = ["A", "B", "C", "D"].map((label) => options.find((option) => option.label === label));
  if (ordered.some((option) => !option || !option.text)) return null;
  const stem = text.slice(0, matches[0].index).trim();
  if (!stem) return null;
  return { stem, options: ordered };
}

function renderPreview() {
  const parsed = parseQuestion(elements.raw.value);
  if (!parsed) {
    elements.preview.hidden = true;
    elements.preview.innerHTML = "";
    return;
  }
  elements.preview.hidden = false;
  elements.preview.innerHTML = `
    <strong>解析預覽</strong>
    <p>${escapeHTML(parsed.stem)}</p>
    <div>${parsed.options.map((option) => `<span><b>${option.label}</b>${escapeHTML(option.text)}</span>`).join("")}</div>
  `;
}

function answerResult(question) {
  const selected = answeredQuestions.get(question.id);
  if (!selected) return "";
  const correct = selected === question.answer;
  return `<p class="answer-result ${correct ? "correct" : "wrong"}">${correct ? "答對了" : `答錯了，正確答案是 ${escapeHTML(question.answer || "未設定")}`}</p>`;
}

function explanationBlock(question) {
  if (!answeredQuestions.has(question.id) || !question.explanation) return "";
  return `<section class="question-explanation"><strong>詳解</strong><p>${escapeHTML(question.explanation).replace(/\n/g, "<br>")}</p></section>`;
}

function groupedSubjects(bank) {
  const subjects = new Set(bank.subjects.map(normalizeSubject));
  bank.questions.forEach((question) => subjects.add(normalizeSubject(question.subject)));
  return [...subjects].sort((a, b) => a.localeCompare(b, "zh-Hant"));
}

function renderSubjectSelect(subjects) {
  const hasSubjects = subjects.length > 0;
  const current = elements.subjectSelect.value;
  elements.subjectSelect.innerHTML = [
    ...subjects.map((subject) => `<option value="${escapeHTML(subject)}">${escapeHTML(subject)}</option>`),
    `<option value="__new__">＋新增科目</option>`
  ].join("");
  if (current && (subjects.includes(current) || current === "__new__")) elements.subjectSelect.value = current;
  else elements.subjectSelect.value = hasSubjects ? subjects[0] : "__new__";
  const addingNew = elements.subjectSelect.value === "__new__";
  elements.newSubjectField.hidden = !addingNew;
  elements.subject.required = addingNew;
}

function selectedSubject() {
  if (elements.subjectSelect.value === "__new__") return normalizeSubject(elements.subject.value);
  return normalizeSubject(elements.subjectSelect.value);
}

function filteredQuestions(bank) {
  return activeSubject === "all" ? bank.questions : bank.questions.filter((question) => normalizeSubject(question.subject) === activeSubject);
}

function clampActiveIndex(total) {
  if (total <= 0) {
    activeIndex = 0;
    return;
  }
  activeIndex = Math.max(0, Math.min(activeIndex, total - 1));
}

function renderQuestionCard(question, index, total) {
  return `
    <article class="question-card" data-id="${escapeHTML(question.id)}">
      <div class="question-card-head"><span>${escapeHTML(question.subject)}</span><small>第 ${index + 1} / ${total} 題</small></div>
      <div class="question-stats"><span>已回答 ${Number(question.answerCount) || 0} 次</span></div>
      <h3>${escapeHTML(question.stem)}</h3>
      ${question.answer ? "" : `<p class="answer-result missing">這題還沒有設定正確答案，請刪除後重新加入。</p>`}
      <div class="question-options practice-options">
        ${question.options.map((option) => {
          const selected = answeredQuestions.get(question.id);
          const isSelected = selected === option.label;
          const isCorrect = question.answer === option.label;
          const stateClass = selected ? isCorrect ? "correct" : isSelected ? "wrong" : "" : "";
          return `<button class="${stateClass}" type="button" data-answer-question="${escapeHTML(question.id)}" data-answer="${escapeHTML(option.label)}" ${question.answer ? "" : "disabled"}><b>${escapeHTML(option.label)}</b><p>${escapeHTML(option.text)}</p></button>`;
        }).join("")}
      </div>
      ${answerResult(question)}
      ${explanationBlock(question)}
      <button class="delete-question" type="button" data-delete-question="${escapeHTML(question.id)}">刪除題目</button>
    </article>
  `;
}

function render() {
  const state = loadState();
  if (!state) return;
  const bank = ensureQuestionBank(state);
  const subjects = groupedSubjects(bank);
  if (activeSubject !== "all" && !subjects.includes(activeSubject)) activeSubject = "all";
  renderSubjectSelect(subjects);
  elements.count.textContent = String(bank.questions.length);
  elements.tabs.innerHTML = `
    <button class="${activeSubject === "all" ? "active" : ""}" type="button" data-subject="all" aria-selected="${activeSubject === "all"}">全部 <small>${bank.questions.length}</small></button>
    ${subjects.map((subject) => {
      const count = bank.questions.filter((question) => normalizeSubject(question.subject) === subject).length;
      return `<button class="${activeSubject === subject ? "active" : ""}" type="button" data-subject="${escapeHTML(subject)}" aria-selected="${activeSubject === subject}">${escapeHTML(subject)} <small>${count}</small></button>`;
    }).join("")}
  `;
  const filtered = filteredQuestions(bank);
  clampActiveIndex(filtered.length);
  elements.label.textContent = activeSubject === "all" ? "ALL SUBJECTS" : "SUBJECT";
  elements.title.textContent = activeSubject === "all" ? "全部題目" : activeSubject;
  elements.empty.hidden = filtered.length > 0;
  elements.toolbar.hidden = filtered.length === 0;
  elements.list.innerHTML = filtered.length ? renderQuestionCard(filtered[activeIndex], activeIndex, filtered.length) : "";
  elements.progress.textContent = filtered.length ? `第 ${activeIndex + 1} / ${filtered.length} 題` : "第 0 / 0 題";
  elements.prev.disabled = filtered.length <= 1;
  elements.next.disabled = filtered.length <= 1;
  elements.random.disabled = filtered.length <= 1;
}

elements.raw.addEventListener("input", renderPreview);
elements.raw.addEventListener("paste", () => requestAnimationFrame(renderPreview));
elements.subjectSelect.addEventListener("change", () => {
  const addingNew = elements.subjectSelect.value === "__new__";
  elements.newSubjectField.hidden = !addingNew;
  elements.subject.required = addingNew;
  if (addingNew) elements.subject.focus();
});
elements.clear.addEventListener("click", () => {
  elements.form.reset();
  render();
  elements.preview.hidden = true;
  elements.preview.innerHTML = "";
  elements.status.textContent = "";
});
elements.form.addEventListener("submit", (event) => {
  event.preventDefault();
  const state = loadState();
  if (!state) return;
  const bank = ensureQuestionBank(state);
  const parsed = parseQuestion(elements.raw.value);
  if (!parsed) {
    elements.status.textContent = "無法解析題目，請確認有 (A)(B)(C)(D) 四個選項。";
    return;
  }
  const answer = elements.answer.value;
  if (!["A", "B", "C", "D"].includes(answer)) {
    elements.status.textContent = "請選擇正確答案。";
    return;
  }
  const subject = selectedSubject();
  const explanation = elements.explanation.value.trim();
  if (!bank.subjects.includes(subject)) bank.subjects.push(subject);
  bank.questions.unshift({ id: createId(), subject, stem: parsed.stem, options: parsed.options, answer, explanation, answerCount: 0, createdAt: new Date().toISOString() });
  activeSubject = subject;
  saveState(state);
  elements.form.reset();
  elements.preview.hidden = true;
  elements.preview.innerHTML = "";
  elements.status.textContent = "已加入題庫。";
  render();
});
elements.tabs.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-subject]");
  if (!button) return;
  activeSubject = button.dataset.subject;
  activeIndex = 0;
  render();
});
elements.prev.addEventListener("click", () => {
  const state = loadState();
  const bank = ensureQuestionBank(state);
  const total = filteredQuestions(bank).length;
  if (total <= 1) return;
  activeIndex = (activeIndex - 1 + total) % total;
  render();
});
elements.next.addEventListener("click", () => {
  const state = loadState();
  const bank = ensureQuestionBank(state);
  const total = filteredQuestions(bank).length;
  if (total <= 1) return;
  activeIndex = (activeIndex + 1) % total;
  render();
});
elements.random.addEventListener("click", () => {
  const state = loadState();
  const bank = ensureQuestionBank(state);
  const total = filteredQuestions(bank).length;
  if (total <= 1) return;
  let nextIndex = Math.floor(Math.random() * total);
  if (nextIndex === activeIndex) nextIndex = (nextIndex + 1) % total;
  activeIndex = nextIndex;
  render();
});
elements.list.addEventListener("click", (event) => {
  const answerButton = event.target.closest("button[data-answer-question]");
  if (answerButton) {
    const state = loadState();
    if (!state) return;
    const bank = ensureQuestionBank(state);
    const question = bank.questions.find((item) => item.id === answerButton.dataset.answerQuestion);
    if (!question) return;
    question.answerCount = (Number(question.answerCount) || 0) + 1;
    answeredQuestions.set(answerButton.dataset.answerQuestion, answerButton.dataset.answer);
    saveState(state);
    render();
    return;
  }
  const button = event.target.closest("button[data-delete-question]");
  if (!button) return;
  const state = loadState();
  if (!state) return;
  const bank = ensureQuestionBank(state);
  bank.questions = bank.questions.filter((question) => question.id !== button.dataset.deleteQuestion);
  bank.subjects = groupedSubjects(bank).filter((subject) => bank.questions.some((question) => normalizeSubject(question.subject) === subject));
  clampActiveIndex(filteredQuestions(bank).length);
  saveState(state);
  elements.status.textContent = "已刪除題目。";
  render();
});
window.addEventListener("planner:state-loaded", render);
window.addEventListener("storage", (event) => { if (event.key === STORAGE_KEY) render(); });
render();
