const STORAGE_KEY = "life-planner:v2";
const QUESTION_BACKUP_KEY = "life-planner:question-bank-backups";
const config = window.FIREBASE_CONFIG || {};
const configured = config.apiKey && !config.apiKey.startsWith("YOUR_") && config.projectId && !config.projectId.startsWith("YOUR_");
const elements = {
  dialog: document.querySelector("#loginDialog"), form: document.querySelector("#loginForm"),
  open: document.querySelector("#openLogin"), close: document.querySelector("#closeLogin"),
  email: document.querySelector("#loginEmail"), password: document.querySelector("#loginPassword"),
  title: document.querySelector("#loginTitle"), description: document.querySelector("#loginDescription"),
  message: document.querySelector("#loginMessage"), submit: document.querySelector("#loginSubmit"),
  status: document.querySelector("#cloudStatus"),
  save: document.querySelector("#saveToCloud"), logout: document.querySelector("#logoutButton")
};

let auth = null;
let db = null;
let currentUser = null;
let firebaseApi = null;
let unsubscribeSave = null;
let saveTimer = null;
let applyingCloudState = false;
let lastSyncedState = "";

function showMessage(message, success = false) {
  if (!elements.message) return;
  elements.message.textContent = message;
  elements.message.classList.toggle("success", success);
}

function setStatus(message) {
  if (elements.status) elements.status.textContent = message;
}

function getDeviceInfo() {
  const ua = navigator.userAgent || "";
  const platform = navigator.platform || "";
  const touchCapable = navigator.maxTouchPoints > 1;
  if (/iPad/i.test(ua) || (platform === "MacIntel" && touchCapable)) {
    return { type: "ipad", label: "iPad 端" };
  }
  if (/Mobi|Android|iPhone|iPod/i.test(ua)) {
    return { type: "phone", label: "手機端" };
  }
  return { type: "desktop", label: "電腦端" };
}

function formatSavedAt(value) {
  const date = value?.toDate ? value.toDate() : value ? new Date(value) : null;
  if (!date || Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("zh-TW", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  }).format(date);
}

function describeCloudSave(data) {
  const label = data?.savedFromLabel || "未知裝置";
  const time = formatSavedAt(data?.updatedAt);
  return `上一次存檔：${label}${time ? `・${time}` : ""}`;
}

function comparableTime(value) {
  const date = value ? new Date(value) : null;
  return date && Number.isFinite(date.getTime()) ? date.getTime() : 0;
}

function cloudDocRef() {
  return firebaseApi.doc(db, "users", currentUser.uid, "saves", "current");
}

function getLocalState() {
  try {
    const state = JSON.parse(localStorage.getItem(STORAGE_KEY));
    return window.PlannerTasks?.normalize ? window.PlannerTasks.normalize(state) : state;
  } catch {
    return null;
  }
}

function backupQuestionData(state, reason = "before-cloud-load") {
  if (!state?.questionBank) return;
  try {
    const backups = JSON.parse(localStorage.getItem(QUESTION_BACKUP_KEY)) || [];
    backups.unshift({
      backedUpAt: new Date().toISOString(),
      reason,
      questionBank: JSON.parse(JSON.stringify(state.questionBank)),
      genesisCrystals: Number(state.genesisCrystals) || 0,
      shopPurchases: Array.isArray(state.shopPurchases) ? JSON.parse(JSON.stringify(state.shopPurchases)) : []
    });
    localStorage.setItem(QUESTION_BACKUP_KEY, JSON.stringify(backups.slice(0, 10)));
  } catch (error) {
    console.warn("Question bank backup failed", error);
  }
}

function writeLocalState(state) {
  const normalized = window.PlannerTasks?.normalize ? window.PlannerTasks.normalize(state) : state;
  if (!normalized) return false;
  backupQuestionData(getLocalState(), "before-cloud-load");
  applyingCloudState = true;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(normalized));
  lastSyncedState = JSON.stringify(normalized);
  window.dispatchEvent(new CustomEvent("planner:state-loaded"));
  applyingCloudState = false;
  return true;
}

async function saveCurrentStateToCloud(label = "已同步・剛剛") {
  if (!currentUser || !db || !firebaseApi) return;
  const state = getLocalState();
  if (!state) return;
  let serialized = JSON.stringify(state);
  if (serialized === lastSyncedState) return;
  const device = getDeviceInfo();
  let cloudWon = null;
  let saved = false;
  await firebaseApi.runTransaction(db, async (transaction) => {
    const ref = cloudDocRef();
    const snapshot = await transaction.get(ref);
    const cloudData = snapshot.exists() ? snapshot.data() : null;
    const cloudState = cloudData?.state || null;
    const cloudTime = comparableTime(cloudData?.clientUpdatedAt || cloudState?.clientUpdatedAt);
    const localTime = comparableTime(state.clientUpdatedAt);
    if (cloudState && (cloudTime > localTime || (!localTime && JSON.stringify(cloudState) !== serialized))) {
      cloudWon = { data: cloudData, state: cloudState };
      return;
    }
    if (!localTime) {
      state.clientUpdatedAt = new Date().toISOString();
      serialized = JSON.stringify(state);
    }
    transaction.set(ref, {
      state,
      schemaVersion: 3,
      clientUpdatedAt: state.clientUpdatedAt,
      savedFrom: device.type,
      savedFromLabel: device.label,
      updatedAt: firebaseApi.serverTimestamp()
    }, { merge: true });
    saved = true;
  });
  if (cloudWon) {
    writeLocalState(cloudWon.state);
    setStatus(`已保留最新雲端・${cloudWon.data?.savedFromLabel || "未知裝置"}`);
    return;
  }
  if (saved) {
    lastSyncedState = serialized;
    setStatus(`${label}・${device.label}`);
  }
}

function scheduleCloudSave(event) {
  if (applyingCloudState || !currentUser || !db || !firebaseApi) return;
  clearTimeout(saveTimer);
  if (event?.detail?.immediate) {
    saveCurrentStateToCloud().catch((error) => {
      setStatus("同步失敗");
      console.error("Firebase autosave failed", error);
    });
    return;
  }
  saveTimer = setTimeout(() => {
    saveCurrentStateToCloud().catch((error) => {
      setStatus("同步失敗");
      console.error("Firebase autosave failed", error);
    });
  }, 700);
}

async function loadCloudState() {
  if (!currentUser || !db || !firebaseApi) return;
  setStatus("正在同步…");
  const snapshot = await firebaseApi.getDoc(cloudDocRef());
  if (snapshot.exists() && snapshot.data()?.state) {
    const data = snapshot.data();
    const localState = getLocalState();
    const localTime = comparableTime(localState?.clientUpdatedAt);
    const cloudTime = comparableTime(data.clientUpdatedAt || data.state?.clientUpdatedAt);
    if (localTime > cloudTime) {
      lastSyncedState = "";
      await saveCurrentStateToCloud("已同步本機變更");
      return;
    }
    if (localTime === cloudTime && JSON.stringify(localState) === JSON.stringify(data.state)) {
      lastSyncedState = JSON.stringify(data.state);
      setStatus(describeCloudSave(data));
      return;
    }
    writeLocalState(data.state);
    setStatus(describeCloudSave(data));
    return;
  }
  await saveCurrentStateToCloud("已建立雲端存檔");
}

function friendlyError(error) {
  const messages = {
    "auth/invalid-credential": "Email 或密碼不正確。",
    "auth/email-already-in-use": "這個 Email 已經註冊過。",
    "auth/invalid-email": "Email 格式不正確。",
    "auth/weak-password": "密碼至少需要 6 個字元。",
    "auth/too-many-requests": "嘗試次數過多，請稍後再試。"
  };
  return messages[error?.code] || "操作失敗，請確認網路與 Firebase 設定。";
}

function updateLoginText() {
  if (!elements.title || !elements.description || !elements.submit || !elements.password) return;
  elements.title.textContent = "登入雲端存檔";
  elements.description.textContent = "登入後可將目前所有內容安全存入自己的帳號。";
  elements.submit.textContent = "登入";
  elements.password.autocomplete = "current-password";
  showMessage("");
}

if (elements.form) {
  elements.form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!firebaseApi || !auth) {
      showMessage(configured ? "Firebase 尚未連線，請稍後再試。" : "請先完成 Firebase 專案設定。");
      return;
    }
    elements.submit.disabled = true;
    showMessage("正在登入…");
    try {
      await firebaseApi.signInWithEmailAndPassword(auth, elements.email.value.trim(), elements.password.value);
      elements.form.reset();
      elements.dialog.close();
    } catch (error) {
      showMessage(friendlyError(error));
    } finally {
      elements.submit.disabled = false;
    }
  });
}

if (elements.save) {
  elements.save.addEventListener("click", async () => {
    if (!currentUser || !db) return;
    elements.save.classList.add("saving");
    elements.save.textContent = "正在存檔…";
    try {
      lastSyncedState = "";
      await saveCurrentStateToCloud("已存檔・剛剛");
    } catch (error) {
      setStatus("存檔失敗");
      console.error("Firebase save failed", error);
    } finally {
      elements.save.classList.remove("saving");
      elements.save.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 18h10a4 4 0 0 0 .5-8A6 6 0 0 0 6 8.5 4.8 4.8 0 0 0 7 18Z"/><path d="m9 12 3-3 3 3M12 9v6"/></svg>存檔到雲端`;
    }
  });
}

if (elements.logout) elements.logout.addEventListener("click", () => { if (auth && firebaseApi) firebaseApi.signOut(auth); });

if (!configured) {
  setStatus("Firebase 尚未設定");
  if (elements.title) elements.title.textContent = "尚未連接 Firebase";
  if (elements.description) elements.description.textContent = "請先在 firebase-config.js 填入你的 Firebase 專案設定。";
  if (elements.submit) elements.submit.disabled = true;
} else {
  initializeFirebase();
}

async function initializeFirebase() {
  setStatus("Firebase 連線中…");
  if (elements.submit) elements.submit.disabled = true;
  try {
    const [appSdk, authSdk, firestoreSdk] = await Promise.all([
      import("https://www.gstatic.com/firebasejs/10.12.5/firebase-app.js"),
      import("https://www.gstatic.com/firebasejs/10.12.5/firebase-auth.js"),
      import("https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js")
    ]);
    firebaseApi = { ...authSdk, ...firestoreSdk };
    const app = appSdk.initializeApp(config);
    auth = authSdk.getAuth(app);
    db = firestoreSdk.getFirestore(app);
    await authSdk.setPersistence(auth, authSdk.browserLocalPersistence);
    if (elements.submit) elements.submit.disabled = false;
    updateLoginText();
    authSdk.onAuthStateChanged(auth, async (user) => {
      currentUser = user;
      if (elements.open) elements.open.hidden = Boolean(user);
      if (elements.save) elements.save.hidden = !user;
      if (elements.logout) elements.logout.hidden = !user;
      setStatus(user ? user.email : "尚未登入");
      clearTimeout(saveTimer);
      window.removeEventListener("planner:state-saved", scheduleCloudSave);
      if (!user) {
        unsubscribeSave = null;
        lastSyncedState = "";
        return;
      }
      window.addEventListener("planner:state-saved", scheduleCloudSave);
      unsubscribeSave = scheduleCloudSave;
      try {
        await loadCloudState();
      } catch (error) {
        setStatus("同步失敗");
        console.error("Firebase load failed", error);
      }
    });
  } catch (error) {
    firebaseApi = null;
    setStatus("Firebase 載入失敗");
    if (elements.title) elements.title.textContent = "無法載入 Firebase";
    if (elements.description) elements.description.textContent = "請確認網路連線，並使用「啟動PWA.cmd」開啟網站。";
    showMessage("Firebase SDK 載入失敗，登入功能目前無法使用。");
    console.error("Firebase initialization failed", error);
  }
}


