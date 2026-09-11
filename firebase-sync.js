const STORAGE_KEY = "life-planner:v2";
const config = window.FIREBASE_CONFIG || {};
const configured = config.apiKey && !config.apiKey.startsWith("YOUR_") && config.projectId && !config.projectId.startsWith("YOUR_");
const elements = {
  dialog: document.querySelector("#loginDialog"), form: document.querySelector("#loginForm"),
  open: document.querySelector("#openLogin"), close: document.querySelector("#closeLogin"),
  email: document.querySelector("#loginEmail"), password: document.querySelector("#loginPassword"),
  title: document.querySelector("#loginTitle"), description: document.querySelector("#loginDescription"),
  message: document.querySelector("#loginMessage"), submit: document.querySelector("#loginSubmit"),
  switchMode: document.querySelector("#switchAuthMode"), status: document.querySelector("#cloudStatus"),
  save: document.querySelector("#saveToCloud"), logout: document.querySelector("#logoutButton")
};

let auth = null;
let db = null;
let currentUser = null;
let authMode = "login";
let firebaseApi = null;
let unsubscribeSave = null;
let saveTimer = null;
let applyingCloudState = false;
let lastSyncedState = "";

function showMessage(message, success = false) {
  elements.message.textContent = message;
  elements.message.classList.toggle("success", success);
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

function writeLocalState(state) {
  const normalized = window.PlannerTasks?.normalize ? window.PlannerTasks.normalize(state) : state;
  if (!normalized) return false;
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
  const serialized = JSON.stringify(state);
  if (serialized === lastSyncedState) return;
  const device = getDeviceInfo();
  await firebaseApi.setDoc(cloudDocRef(), {
    state,
    schemaVersion: 2,
    savedFrom: device.type,
    savedFromLabel: device.label,
    updatedAt: firebaseApi.serverTimestamp()
  }, { merge: true });
  lastSyncedState = serialized;
  elements.status.textContent = `${label}・${device.label}`;
}

function scheduleCloudSave() {
  if (applyingCloudState || !currentUser || !db || !firebaseApi) return;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveCurrentStateToCloud().catch((error) => {
      elements.status.textContent = "同步失敗";
      console.error("Firebase autosave failed", error);
    });
  }, 700);
}

async function loadCloudState() {
  if (!currentUser || !db || !firebaseApi) return;
  elements.status.textContent = "正在同步…";
  const snapshot = await firebaseApi.getDoc(cloudDocRef());
  if (snapshot.exists() && snapshot.data()?.state) {
    const data = snapshot.data();
    writeLocalState(data.state);
    elements.status.textContent = describeCloudSave(data);
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

function updateAuthMode() {
  const registering = authMode === "register";
  elements.title.textContent = registering ? "建立雲端帳號" : "登入雲端存檔";
  elements.description.textContent = registering ? "建立帳號後即可將所有任務存入 Firebase。" : "登入後可將目前所有內容安全存入自己的帳號。";
  elements.submit.textContent = registering ? "建立帳號" : "登入";
  elements.switchMode.textContent = registering ? "已經有帳號？返回登入" : "還沒有帳號？建立帳號";
  elements.password.autocomplete = registering ? "new-password" : "current-password";
  showMessage("");
}

elements.switchMode.addEventListener("click", () => {
  if (!firebaseApi) return;
  authMode = authMode === "login" ? "register" : "login";
  updateAuthMode();
});

elements.form.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!firebaseApi || !auth) {
    showMessage(configured ? "Firebase 尚未連線，請稍後再試。" : "請先完成 Firebase 專案設定。");
    return;
  }
  elements.submit.disabled = true;
  showMessage(authMode === "register" ? "正在建立帳號…" : "正在登入…");
  try {
    if (authMode === "register") await firebaseApi.createUserWithEmailAndPassword(auth, elements.email.value.trim(), elements.password.value);
    else await firebaseApi.signInWithEmailAndPassword(auth, elements.email.value.trim(), elements.password.value);
    elements.form.reset();
    elements.dialog.close();
  } catch (error) {
    showMessage(friendlyError(error));
  } finally {
    elements.submit.disabled = false;
  }
});

elements.save.addEventListener("click", async () => {
  if (!currentUser || !db) return;
  elements.save.classList.add("saving");
  elements.save.textContent = "正在存檔…";
  try {
    lastSyncedState = "";
    await saveCurrentStateToCloud("已存檔・剛剛");
  } catch (error) {
    elements.status.textContent = "存檔失敗";
    console.error("Firebase save failed", error);
  } finally {
    elements.save.classList.remove("saving");
    elements.save.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 18h10a4 4 0 0 0 .5-8A6 6 0 0 0 6 8.5 4.8 4.8 0 0 0 7 18Z"/><path d="m9 12 3-3 3 3M12 9v6"/></svg>存檔到雲端`;
  }
});

elements.logout.addEventListener("click", () => { if (auth && firebaseApi) firebaseApi.signOut(auth); });

if (!configured) {
  elements.status.textContent = "Firebase 尚未設定";
  elements.title.textContent = "尚未連接 Firebase";
  elements.description.textContent = "請先在 firebase-config.js 填入你的 Firebase 專案設定。";
  elements.submit.disabled = true;
  elements.switchMode.hidden = true;
} else {
  initializeFirebase();
}

async function initializeFirebase() {
  elements.status.textContent = "Firebase 連線中…";
  elements.submit.disabled = true;
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
    elements.submit.disabled = false;
    authSdk.onAuthStateChanged(auth, async (user) => {
      currentUser = user;
      elements.open.hidden = Boolean(user);
      elements.save.hidden = !user;
      elements.logout.hidden = !user;
      elements.status.textContent = user ? user.email : "尚未登入";
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
        elements.status.textContent = "同步失敗";
        console.error("Firebase load failed", error);
      }
    });
  } catch (error) {
    firebaseApi = null;
    elements.status.textContent = "Firebase 載入失敗";
    elements.title.textContent = "無法載入 Firebase";
    elements.description.textContent = "請確認網路連線，並使用「啟動PWA.cmd」開啟網站。";
    showMessage("Firebase SDK 載入失敗，登入功能目前無法使用。");
    console.error("Firebase initialization failed", error);
  }
}
