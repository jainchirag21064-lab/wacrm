const CACHE_NAME = "wacrm-v2";
const PRECACHE = ["/icons/icon-192.png", "/icons/icon-512.png"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.addAll(PRECACHE))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((names) =>
        Promise.all(
          names
            .filter((name) => name !== CACHE_NAME)
            .map((name) => caches.delete(name)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;

  // Never intercept navigations. Pages and auth redirects (/login ↔
  // /dashboard decided by the middleware) must go straight to the
  // network; a service worker that caches page responses can serve a
  // stale logged-in view for /login or race the cookies being written
  // or cleared on the auth boundary — visible as a brief
  // ERR_TOO_MANY_REDIRECTS flash on every login/logout.
  if (request.mode === "navigate") {
    return;
  }

  // Only cache same-origin GET assets. Skip API and auth endpoints.
  if (
    request.method !== "GET" ||
    request.url.includes("/api/") ||
    request.url.includes("/auth/")
  ) {
    return;
  }

  event.respondWith(
    fetch(request)
      .then((response) => {
        if (response.ok && response.type === "basic") {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
        }
        return response;
      })
      .catch(() =>
        caches.match(request).then((cached) => cached ?? Response.error()),
      ),
  );
});