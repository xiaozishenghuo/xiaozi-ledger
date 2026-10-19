/* ============================================================
   小资记账 · Service Worker
   ------------------------------------------------------------
   它只做两件事：
     1. 让 App 在没网时也能打开（缓存外壳文件）
     2. 让「添加到主屏幕」后的启动更快

   ⚠️ 账目数据**不在**这个缓存里。
      数据存在 localStorage，跟这里完全无关。
      清掉这个缓存最坏的后果是「没网时打不开」—— 不会丢一条账。

   更新策略：network-first（有网永远用最新的，没网才用缓存）。
   为什么不用 cache-first：那样妈妈可能连着几天都在用旧版本，
   而我看不到她的屏幕，出了问题是很难排查的。
   ============================================================ */

const CACHE = 'xiaozi-shell-v2';

/* 要缓存的外壳文件。
   注意 index.html 里引用的是 app.css?v=34 这种带 query 的地址，
   所以下面缓存的是不带 query 的版本 —— fetch 时用 ignoreSearch 匹配。 */
const SHELL = [
  './',
  './index.html',
  './app.css',
  './app.js',
  './store.js',
  './manifest.json',
  './icon-180.png',
  './icon-192.png',
  './icon-512.png'
];

// 这几个缺了离线就是白屏 —— 它们 add 失败必须让 install 失败（下次再试），
// 不能像图标那样吞掉（第三轮审查 🟡 C34）。
const CRITICAL = ['./index.html', './app.css', './app.js', './store.js'];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE)
      // 逐个 add 并各自处理：图标少一个不致命，但关键文件 404 会让离线白屏。
      .then(c => Promise.all(SHELL.map(u => c.add(u).catch(() => {
        if (CRITICAL.indexOf(u) >= 0) throw new Error('critical asset failed: ' + u);
      }))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(k => k !== CACHE).map(k => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const req = e.request;

  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;   // 只接管自己的资源

  // network-first + 2.5 秒超时：弱网时一直等网络会白屏很久，
  // 超时就直接用缓存（第三轮审查 🟡 C34）。
  const NET_TIMEOUT = 2500;
  let timer = null;
  const net = fetch(req).then(res => {
    // 有网：顺手把新的存进缓存
    if (res && res.ok && res.type === 'basic') {
      const copy = res.clone();
      // ⚠️ 键要用**不带 query** 的地址。install 时的 c.add('./app.css') 用的是
      // 不带 ?v= 的键，而这里以前用 req（带 ?v=30）—— 两者是不同条目、互不更新。
      // 结果：不带 query 的那几条只在 SW 安装时写一次，离线永远给「上次 sw.js
      // 改动那天」的版本；而且 caches.match(req, {ignoreSearch:true}) 返回的是
      // **插入最早**的那条（Cache API 实测），新内容根本轮不上。
      const bare = new Request(new URL(req.url).pathname);
      caches.open(CACHE).then(c => c.put(bare, copy)).catch(() => {});
    }
    return res;
  });

  const timeout = new Promise((_, rej) => {
    timer = setTimeout(() => rej(new Error('network timeout')), NET_TIMEOUT);
  });

  e.respondWith(
    Promise.race([net, timeout])
      .catch(() =>
        // 没网/超时：先找缓存（忽略 ?v= 这类 query），
        // 只有「页面导航」才退回 index.html ——
        // 给 JS/CSS 请求退回 HTML 会把页面直接弄坏。
        caches.match(req, { ignoreSearch: true }).then(hit => {
          if (hit) return hit;
          if (req.mode === 'navigate') return caches.match('./index.html');
          return new Response('', { status: 504, statusText: 'offline' });
        })
      )
      .finally(() => { if (timer) clearTimeout(timer); })
  );
});
