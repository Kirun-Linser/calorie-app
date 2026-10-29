// service worker：stale-while-revalidate
// 先返回缓存（秒开），同时后台重新 fetch 并更新缓存，下次打开即为新版
// v4：目录结构重构（css/ + js/core + js/domain + js/ui），预缓存清单必须与 index.html 实际引用一致。
// v5：备份导出 JSON 合并快捷项（js/core/db.js + js/ui/views/settings.js 内容变更）→ bump 让老客户端换新缓存。
// v6：第 1 轮优化（抽屉滚动锁/焦点、存储失败可见性、全局错误兜底）→ bump。
// v7：最近记录改为「向左滑动两次撤销」（today.js + components.css 内容变更）→ bump。
// v8：输入校验（体重 0-1000 斤、热量 ±10000 kcal）+ PWA 离线/更新提示 → bump。
// v9：日结按钮从今日页移出（防误触）→ 设置 → 当日 → 手动结束今天（二次确认）→ bump。
// v10：首次访问未受控时的「再刷新一次即可离线」提示；修首访误报「已更新到新版本」。
// v11：历史每日可编辑（总热量/目标/重开/结束）+ 修 startupAutoClose 不推进逻辑日 → bump。
// v12：今日页右上角加「刷新」按钮（清 SW 缓存后重载，解决手机上拿不到新版）→ bump。
// v13：分摊多条并存+历史占位迁移+撤销清空日、日结三连 bug、ResizeObserver 循环、tab 图标 → bump。
// v14：分摊 UI 接线（多条卡片 + createAllocationFromKcal 修正单位 + 停止后可撤销）→ bump。
// v15：应用显示名改为 K++（manifest/index.html/settings 关于）→ bump。
// v16：撤销分摊区独立渲染（有 open 也能撤）+ 负号/全角归一化（手机输入法负号）+ 负热量提示 → bump。
// v17：补种守卫 + 墓碑 + 未日结顶条 + 护栏（tests/sw-assets.test.js）→ bump。
// v18：今日页改为「账本版」（today.js + components.css + tokens.css 大改）+ 宽屏 tabbar 对齐 → bump。
// ⚠️ 改动清单或文件名时务必同步 bump CACHE 版本，否则老客户端会一直吃旧缓存。
const CACHE = 'calorie-app-v18';
const ASSETS = [
  './', './index.html', './manifest.json',

  // 样式（顺序与 index.html 的 <link> 一致）
  './css/tokens.css', './css/base.css', './css/components.css',

  // 入口
  './js/main.js',

  // 核心层
  './js/core/store.js', './js/core/migrate.js', './js/core/date.js', './js/core/db.js',

  // 领域层
  './js/domain/parser.js', './js/domain/engine.js', './js/domain/state.js',
  './js/domain/weight.js', './js/domain/allocation.js',

  // UI 层
  './js/ui/components.js', './js/ui/charts.js', './js/ui/app.js',
  './js/ui/views/today.js', './js/ui/views/trends.js', './js/ui/views/settings.js',

  // 图标
  './icons/icon-180.png', './icons/icon-192.png', './icons/icon-512.png'
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE)
      // 逐个 add 而不是 addAll：单个资源缺失不至于让整次安装失败、SW 永久停在旧版
      .then(c => Promise.all(ASSETS.map(a => c.add(a).catch(err => {
        console.warn('[sw] 预缓存失败（已跳过）:', a, err && err.message);
      }))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  // 只接管同源请求
  const url = new URL(e.request.url);
  if (url.origin !== self.location.origin) return;

  e.respondWith(
    caches.open(CACHE).then(cache =>
      cache.match(e.request).then(cached => {
        const networkFetch = fetch(e.request).then(networkRes => {
          if (networkRes && networkRes.status === 200 && networkRes.type === 'basic') {
            cache.put(e.request, networkRes.clone());
          }
          return networkRes;
        }).catch(() => cached);
        return cached || networkFetch;
      })
    )
  );
});
