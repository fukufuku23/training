/**
 * Service Worker — アプリシェルをキャッシュしてオフライン起動を可能にする。
 * 同一オリジンの GET だけを扱い、外部サイト（YouTube等）には介入しない。
 *
 * 注意: Service Worker は HTTPS か localhost でしか動作しない。
 * スマホから http://192.168.x.x で開くと登録されない。
 */

const CACHE = "training-log-v1";

const PRECACHE = [
  "./",
  "./index.html",
  "./manifest.json",
  "./css/style.css",
  "./js/app.js",
  "./js/storage.js",
  "./js/domain.js",
  "./js/chart.js",
  "./js/exercises.js",
  "./icons/icon.svg",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE)
      .then((cache) => cache.addAll(PRECACHE))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  // ナビゲーションはネット優先、失敗したらキャッシュのindexを返す
  if (req.mode === "navigate") {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put("./index.html", copy));
          return res;
        })
        .catch(() => caches.match("./index.html"))
    );
    return;
  }

  // その他は stale-while-revalidate:
  // キャッシュを即返しつつ裏で取り直す。デプロイのたびに CACHE 名を上げなくても
  // 次回起動時には新しい CSS/JS が反映される。
  event.respondWith(
    caches.match(req).then((cached) => {
      const network = fetch(req).then((res) => {
        if (res && res.status === 200 && res.type === "basic") {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
        }
        return res;
      }).catch(() => cached);
      return cached || network;
    })
  );
});
