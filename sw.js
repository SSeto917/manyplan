const CACHE_NAME = "task-planner-v40-subtasks";
const APP_SHELL = [
  "./fonts/HYWenHei-Extended.ttf",
  "./",
  "./index.html",
  "./history.html",
  "./incomplete.html",
  "./question-bank.html",
  "./styles.css",
  "./design.css",
  "./theme.css",
  "./theme.js",
  "./app.js",
  "./task-state.js",
  "./history.js",
  "./incomplete.js",
  "./question-bank.js",
  "./firebase-config.js",
  "./firebase-sync.js",
  "./manifest.webmanifest",
  "./icons/app-icon.svg",
  "./icons/app-icon-maskable.svg"
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET" || new URL(event.request.url).origin !== self.location.origin) return;
  event.respondWith(
    caches.match(event.request).then((cached) => {
      const network = fetch(event.request).then((response) => {
        if (response.ok) caches.open(CACHE_NAME).then((cache) => cache.put(event.request, response.clone()));
        return response;
      });
      return cached || network.catch(() => caches.match("./index.html"));
    })
  );
});
