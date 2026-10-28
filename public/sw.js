/* Static app shell only. No account, API, user data or IDB access. */
const PREFIX = "ibs-marker-shell-";
const BUILD = new URL(self.location.href).searchParams.get("build") || "shell";
const CACHE = PREFIX + BUILD;
self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const response = await fetch("/asset-manifest.json", {
        cache: "no-store",
      });
      if (!response.ok) throw Error("Asset manifest unavailable");
      const manifest = await response.json();
      if (manifest.buildId !== BUILD)
        throw Error("Build changed while installing");
      const assets = manifest.assets.filter(
        (path) =>
          typeof path === "string" &&
          path.startsWith("/") &&
          !path.startsWith("//") &&
          !path.startsWith("/api/") &&
          !path.includes("?"),
      );
      const cache = await caches.open(CACHE);
      await cache.addAll(assets);
    })(),
  );
});
// Do not skipWaiting: an open editor keeps its current app version until closed.
self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      for (const key of await caches.keys())
        if (key.startsWith(PREFIX) && key !== CACHE) await caches.delete(key);
      await self.clients.claim();
    })(),
  );
});
self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (
    request.method !== "GET" ||
    url.origin !== self.location.origin ||
    /^\/(?:api|auth|rest)(?:\/|$)/.test(url.pathname)
  )
    return;
  if (request.mode === "navigate") {
    // Query strings are allowed only for the two known UI document paths.
    // Never turn API, unknown or private navigations into an app shell.
    if (url.pathname !== "/" && url.pathname !== "/index.html") return;
    event.respondWith(
      (async () => {
        try {
          const response = await fetch(request);
          if (
            response.ok &&
            /^text\/html(?:\s*;|\s*$)/i.test(response.headers.get("content-type") || "")
          )
            return response;
        } catch {
          // Network errors and non-shell responses share the static fallback.
        }
        const cache = await caches.open(CACHE);
        return (
          (await cache.match("/index.html")) ||
          (await cache.match("/")) ||
          Response.error()
        );
      })(),
    );
    return;
  }
  // Static cache keys remain exact, including the no-query restriction.
  if (url.search) return;
  if (!(
    /^\/assets\//.test(url.pathname) ||
    /^\/(?:icon(?:-192|-512)?\.(?:png|svg)|favicon\.svg|stool-forms\.svg|manifest\.webmanifest)$/.test(
      url.pathname,
    )
  ))
    return;
  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE);
      try {
        const response = await fetch(request);
        if (response.ok && response.type === "basic")
          await cache.put(request, response.clone());
        return response;
      } catch {
        return (await cache.match(request)) || Response.error();
      }
    })(),
  );
});
