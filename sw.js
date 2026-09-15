/**
 * Service Worker — アプリシェルをキャッシュしてオフライン起動を可能にする。
 * 同一オリジンの GET だけを扱い、外部サイト（YouTube等）には介入しない。
 *
 * 注意: Service Worker は HTTPS か localhost でしか動作しない。
 * スマホから http://192.168.x.x で開くと登録されない。
 */

const CACHE = "training-log-v8";

const PRECACHE = [
  "./",
  "./index.html",
  "./manifest.json",
  "./css/style.css",
  "./js/app.js",
  "./js/storage.js",
  "./js/domain.js",
  "./js/chart.js",
  "./js/art.js",
  "./js/voice.js",
  "./js/session.js",
  "./js/guide.js",
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

  /*
   * ネットワーク優先・キャッシュフォールバック。
   *
   * 以前は「ナビゲーションはネット優先／その他はキャッシュ優先」にしていたが、
   * これだと更新直後に「新しいindex.html × 古いapp.js」という組み合わせが発生し、
   * 存在しない要素を触って起動に失敗する（実際に発生した）。
   *
   * オンラインならHTMLもJSも同じ世代がネットから来るので不整合が起きない。
   * オフラインなら両方とも同じ世代のキャッシュから来るので、やはり整合する。
   * このアプリは全部で200KB程度なので、ネット優先にしても体感差はほぼない。
   */
  /*
   * cache: "no-cache" を付けているのは、ブラウザのHTTPキャッシュ対策。
   * GitHub Pages は静的ファイルに10分程度の max-age を付けて配信するため、
   * Service Worker が fetch しても「ブラウザが持っている古いコピー」が
   * 返ってしまい、更新が反映されないことがある。
   * "no-cache" はサーバーへの再検証を強制する（変更が無ければ 304 で安価）。
   */
  event.respondWith(
    fetch(new Request(req.url, { cache: "no-cache", credentials: "same-origin" }))
      .then((res) => {
        if (res && res.status === 200 && res.type === "basic") {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
        }
        return res;
      })
      // オフライン時。バージョン印（?v=...）が付いていても当たるよう
      // ignoreSearch でクエリを無視して探す。
      .catch(() =>
        caches.match(req, { ignoreSearch: true }).then((cached) =>
          // ナビゲーションはURLが一致しないことがあるので index.html に落とす
          cached || (req.mode === "navigate" ? caches.match("./index.html") : undefined)
        )
      )
  );
});
