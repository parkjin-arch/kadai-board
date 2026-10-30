// Service Worker：オフラインでも開けるようにアプリ本体をキャッシュする
// ファイルを更新してデプロイしたら CACHE の番号を上げる（古いキャッシュが消える）
const CACHE = 'kadai-board-v3';
const ASSETS = [
  './',
  './index.html',
  './manifest.webmanifest',
  './css/style.css',
  './js/app.js',
  './js/config.js',
  './js/store.js',
  './js/parser.js',
  './js/calendar.js',
  './js/timetable.js',
  './js/dateutil.js',
  './js/shifts.js',
  './js/notes.js',
  './js/events.js',
  './js/agenda.js',
  './js/holidays.js',
  './js/calendar-view.js',
  './js/dom.js',
  './data/timetable.json',
  './icons/icon-192.png',
  './icons/apple-touch-icon.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

// 同一オリジンの GET は「キャッシュを即返し、裏でネットワークから更新」（stale-while-revalidate）
// Google / Firebase など外部への通信には手を出さない
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  e.respondWith(
    caches.open(CACHE).then(async (cache) => {
      const cached = await cache.match(e.request, { ignoreSearch: true });
      const network = fetch(e.request)
        .then((res) => {
          if (res.ok) cache.put(e.request, res.clone());
          return res;
        })
        .catch(() => cached);
      return cached || network;
    }),
  );
});
