const STORAGE_KEY = "life-planner:v2";
const QUESTION_BACKUP_KEY = "life-planner:question-bank-backups";
const QUESTION_CLOUD_BACKUP_KIND = "midnight-question-bank";
const config = window.FIREBASE_CONFIG || {};
const configured = config.apiKey && !config.apiKey.startsWith("YOUR_") && config.projectId && !config.projectId.startsWith("YOUR_");
const elements = {
  dialog: document.querySelector("#loginDialog"), form: document.querySelector("#loginForm"),
  open: document.querySelector("#openLogin"), close: document.querySelector("#closeLogin"),
  email: document.querySelector("#loginEmail"), password: document.querySelector("#loginPassword"),
  title: document.querySelector("#loginTitle"), description: document.querySelector("#loginDescription"),
  message: document.querySelector("#loginMessage"), submit: document.querySelector("#loginSubmit"),
  status: document.querySelector("#cloudStatus"),
  save: document.querySelector("#saveToCloud"), logout: document.querySelector("#logoutButton"),
  questionBackupStatus: document.querySelector("#questionBackupStatus"),
  questionBackupMeta: document.querySelector("#questionBackupMeta"),
  questionBackupRestore: document.querySelector("#restoreQuestionCloudBackup")
};

let auth = null;
let db = null;
let currentUser = null;
let firebaseApi = null;
let unsubscribeSave = null;
let saveTimer = null;
let applyingCloudState = false;
let lastSyncedState = "";
let questionBackupTimer = null;

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
function comparableRevision(value) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : 0;
}

function taipeiDateKey(date = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Taipei",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(date);
}

function formatBackupDateTime(value) {
  const date = value?.toDate ? value.toDate() : value ? new Date(value) : null;
  if (!date || Number.isNaN(date.getTime())) return "尚未備份";
  return new Intl.DateTimeFormat("zh-TW", {
    timeZone: "Asia/Taipei",
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  }).format(date);
}

function setQuestionBackupStatus(message) {
  if (elements.questionBackupStatus) elements.questionBackupStatus.textContent = message;
}

function setQuestionBackupMeta(message) {
  if (elements.questionBackupMeta) elements.questionBackupMeta.textContent = message;
}

function scheduleMidnightQuestionBackup() {
  clearTimeout(questionBackupTimer);
  if (!currentUser || !db || !firebaseApi) return;
  const now = new Date();
  const nextMidnight = new Date(now);
  nextMidnight.setHours(24, 0, 5, 0);
  questionBackupTimer = setTimeout(async () => {
    try {
      await ensureDailyQuestionCloudBackup();
    } catch (error) {
      setQuestionBackupStatus("午夜題庫備份失敗，下一次同步會再嘗試。");
      console.error("Scheduled question cloud backup failed", error);
    } finally {
      scheduleMidnightQuestionBackup();
    }
  }, Math.max(1000, nextMidnight.getTime() - now.getTime()));
}

function getQuestionBackupPayload(state) {
  if (!state?.questionBank) return null;
  return {
    questionBank: JSON.parse(JSON.stringify(state.questionBank)),
    gameFundBalance: Number(state.gameFundBalance ?? state.genesisCrystals) || 0,
    gameFundWithdrawals: Array.isArray(state.gameFundWithdrawals) ? JSON.parse(JSON.stringify(state.gameFundWithdrawals)) : [],
    genesisCrystals: Number(state.gameFundBalance ?? state.genesisCrystals) || 0,
    shopPurchases: Array.isArray(state.gameFundWithdrawals) ? JSON.parse(JSON.stringify(state.gameFundWithdrawals)) : []
  };
}

function cloudDocRef() {
  return firebaseApi.doc(db, "users", currentUser.uid, "saves", "current");
}

function questionBackupDocRef(dateKey) {
  return firebaseApi.doc(db, "users", currentUser.uid, "questionBackups", dateKey);
}

function questionBackupCollectionRef() {
  return firebaseApi.collection(db, "users", currentUser.uid, "questionBackups");
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
      gameFundBalance: Number(state.gameFundBalance ?? state.genesisCrystals) || 0,
      gameFundWithdrawals: Array.isArray(state.gameFundWithdrawals) ? JSON.parse(JSON.stringify(state.gameFundWithdrawals)) : [],
      genesisCrystals: Number(state.gameFundBalance ?? state.genesisCrystals) || 0,
      shopPurchases: Array.isArray(state.gameFundWithdrawals) ? JSON.parse(JSON.stringify(state.gameFundWithdrawals)) : []
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

async function getLatestQuestionCloudBackup() {
  if (!currentUser || !db || !firebaseApi) return null;
  const queryRef = firebaseApi.query(
    questionBackupCollectionRef(),
    firebaseApi.orderBy("backupDate", "desc"),
    firebaseApi.limit(1)
  );
  const snapshot = await firebaseApi.getDocs(queryRef);
  if (snapshot.empty) return null;
  const doc = snapshot.docs[0];
  return { id: doc.id, data: doc.data() };
}

async function updateQuestionCloudBackupPanel() {
  if (!elements.questionBackupRestore && !elements.questionBackupMeta) return;
  if (!currentUser || !db || !firebaseApi) {
    if (elements.questionBackupRestore) elements.questionBackupRestore.disabled = true;
    setQuestionBackupMeta("登入後會每天 00:00 保留一份題庫雲端備份。");
    return;
  }
  try {
    const latest = await getLatestQuestionCloudBackup();
    if (!latest?.data?.payload?.questionBank) {
      if (elements.questionBackupRestore) elements.questionBackupRestore.disabled = true;
      setQuestionBackupMeta("尚未建立題庫雲端備份。");
      return;
    }
    if (elements.questionBackupRestore) elements.questionBackupRestore.disabled = false;
    const count = latest.data.payload.questionBank.questions?.length || 0;
    setQuestionBackupMeta(`最近備份：${latest.id}・${formatBackupDateTime(latest.data.createdAt)}・${count} 題`);
  } catch (error) {
    if (elements.questionBackupRestore) elements.questionBackupRestore.disabled = true;
    setQuestionBackupMeta("讀取題庫備份失敗。");
    console.error("Question cloud backup status failed", error);
  }
}

async function ensureDailyQuestionCloudBackup() {
  if (!currentUser || !db || !firebaseApi) return;
  try {
    const state = getLocalState();
    const payload = getQuestionBackupPayload(state);
    if (!payload) return;
    const dateKey = taipeiDateKey();
    const device = getDeviceInfo();
    let created = false;
    await firebaseApi.runTransaction(db, async (transaction) => {
      const ref = questionBackupDocRef(dateKey);
      const snapshot = await transaction.get(ref);
      if (snapshot.exists()) return;
      transaction.set(ref, {
        kind: QUESTION_CLOUD_BACKUP_KIND,
        backupDate: dateKey,
        payload,
        questionCount: payload.questionBank.questions?.length || 0,
        savedFrom: device.type,
        savedFromLabel: device.label,
        clientUpdatedAt: state.clientUpdatedAt || null,
        sourceCloudRevision: comparableRevision(state.cloudRevision),
        createdAt: firebaseApi.serverTimestamp()
      });
      created = true;
    });
    if (created) setQuestionBackupStatus(`已建立 ${dateKey} 題庫雲端備份。`);
    await updateQuestionCloudBackupPanel();
  } catch (error) {
    setQuestionBackupStatus("題庫雲端備份失敗，主存檔同步不受影響。");
    console.error("Question cloud backup failed", error);
  }
}

async function restoreLatestQuestionCloudBackup() {
  if (!currentUser || !db || !firebaseApi) return;
  const latest = await getLatestQuestionCloudBackup();
  const payload = latest?.data?.payload;
  if (!payload?.questionBank) {
    setQuestionBackupStatus("目前沒有可回復的題庫備份。");
    return;
  }
  const state = getLocalState() || {};
  backupQuestionData(state, "before-restore-cloud-question-backup");
  state.questionBank = JSON.parse(JSON.stringify(payload.questionBank));
  state.gameFundBalance = Number(payload.gameFundBalance ?? payload.genesisCrystals) || 0;
  state.gameFundWithdrawals = Array.isArray(payload.gameFundWithdrawals)
    ? JSON.parse(JSON.stringify(payload.gameFundWithdrawals))
    : Array.isArray(payload.shopPurchases) ? JSON.parse(JSON.stringify(payload.shopPurchases)) : [];
  state.genesisCrystals = state.gameFundBalance;
  state.shopPurchases = state.gameFundWithdrawals;
  state.clientUpdatedAt = new Date().toISOString();
  applyingCloudState = true;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  applyingCloudState = false;
  lastSyncedState = "";
  window.dispatchEvent(new CustomEvent("planner:state-loaded"));
  await saveCurrentStateToCloud(`已回復題庫備份 ${latest.id}`);
  setQuestionBackupStatus(`已用 ${latest.id} 的題庫備份覆蓋目前題庫。`);
  await updateQuestionCloudBackupPanel();
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
    const cloudRevision = comparableRevision(cloudData?.revision || cloudState?.cloudRevision);
    const localRevision = comparableRevision(state.cloudRevision);
    const cloudLooksNewer = cloudState && (
      cloudRevision > localRevision ||
      (cloudRevision === localRevision && (cloudTime > localTime || (!localTime && JSON.stringify(cloudState) !== serialized)))
    );
    if (cloudLooksNewer) {
      cloudWon = { data: cloudData, state: cloudState };
      return;
    }
    if (!localTime) state.clientUpdatedAt = new Date().toISOString();
    const nextRevision = Math.max(cloudRevision, localRevision) + 1;
    state.cloudRevision = nextRevision;
    serialized = JSON.stringify(state);
    transaction.set(ref, {
      state,
      schemaVersion: 4,
      revision: nextRevision,
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
    const localRevision = comparableRevision(localState?.cloudRevision);
    const cloudRevision = comparableRevision(data.revision || data.state?.cloudRevision);
    if (localRevision > cloudRevision || (!localRevision && !cloudRevision && localTime > cloudTime)) {
      lastSyncedState = "";
      await saveCurrentStateToCloud("已同步本機變更");
      await ensureDailyQuestionCloudBackup();
      return;
    }
    if (localRevision === cloudRevision && localTime === cloudTime && JSON.stringify(localState) === JSON.stringify(data.state)) {
      lastSyncedState = JSON.stringify(data.state);
      setStatus(describeCloudSave(data));
      await ensureDailyQuestionCloudBackup();
      return;
    }
    writeLocalState(data.state);
    setStatus(describeCloudSave(data));
    await ensureDailyQuestionCloudBackup();
    return;
  }
  await saveCurrentStateToCloud("已建立雲端存檔");
  await ensureDailyQuestionCloudBackup();
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

if (elements.questionBackupRestore) {
  elements.questionBackupRestore.addEventListener("click", async () => {
    if (!currentUser || !db || !firebaseApi) return;
    elements.questionBackupRestore.disabled = true;
    setQuestionBackupStatus("正在回復題庫備份…");
    try {
      await restoreLatestQuestionCloudBackup();
    } catch (error) {
      setQuestionBackupStatus("回復題庫備份失敗。");
      console.error("Question cloud backup restore failed", error);
    } finally {
      await updateQuestionCloudBackupPanel();
    }
  });
}

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
      clearTimeout(questionBackupTimer);
      window.removeEventListener("planner:state-saved", scheduleCloudSave);
      if (!user) {
        unsubscribeSave = null;
        lastSyncedState = "";
        await updateQuestionCloudBackupPanel();
        return;
      }
      window.addEventListener("planner:state-saved", scheduleCloudSave);
      unsubscribeSave = scheduleCloudSave;
      try {
        await loadCloudState();
        await updateQuestionCloudBackupPanel();
        scheduleMidnightQuestionBackup();
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











