// 電波がなくても開けるように、ページ一式をスマホの中に置いておく。
// 開いたときは置いてあるものをすぐ出し、電波があれば裏で新しいものに入れ替える（次に開いたときに新しくなる）。
const CACHE = "set-checker-v60";
const FILES = ["./", "index.html", "manifest.webmanifest", "icon-192.png", "icon-512.png", "data/author.enc", "data/koheya.enc", "data/kronos.enc", "tour.js", "leaflet.js", "leaflet.css", "data/stores.json", "data/news.json"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES.map((f) => new Request(f, { cache: "reload" })))).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;   // Googleの保存場所などは、そのままネットへ
  const key = req.mode === "navigate" ? "index.html" : req;
  e.respondWith(
    caches.open(CACHE).then(async (c) => {
      const hit = await c.match(key, { ignoreSearch: true });
      const net = fetch(req, { cache: "no-cache" })
        .then((r) => { if (r && r.ok) c.put(key, r.clone()); return r; })
        .catch(() => null);
      if (hit) { e.waitUntil(net); return hit; }
      const r = await net;
      return r || new Response("電波がないため開けませんでした", { status: 503, headers: { "Content-Type": "text/plain; charset=utf-8" } });
    })
  );
});
