import { initDB, getAppState, setAppState } from './core/db.js';
import { startupAutoClose, logicalDate } from './domain/state.js';
import { logicalDate as ld } from './core/date.js';
import { mount, navigate, rerender } from './ui/app.js';
import { toast } from './ui/components.js';

try {
  initDB();
  // ⚠️ 2026-11-09：启动追平也要避开「重开编辑」状态。
  // 否则用户重开 11-08 编辑到一半、刷新页面 → startupAutoClose 又把逻辑日推到今天，
  // 编辑状态与正在改的那天一起丢失（与定时器那个 bug 同源，只是触发点是"刷新"）。
  const bootState = getAppState();
  const editingReopenedDay = !!(bootState.reopened_date && bootState.reopened_date === bootState.logical_date);
  if (!editingReopenedDay) {
    startupAutoClose(new Date());
  }
  mount();
} catch (e) {
  console.error(e);
  document.getElementById('app').innerHTML = `<div style="padding:20px;color:var(--danger);"><h3>启动失败</h3><pre>${e.message}</pre></div>`;
}

// 定时逻辑日检查
// ⚠️ 2026-11-09 修「回到某一天的编辑有问题」：
// 原来这个定时器每 60 秒检查 nowLogical !== state.logical_date，
// 不等就 startupAutoClose() 把逻辑日**一路追平到今天**。
// 而「重新打开某天」会把 logical_date 退回那一天 —— 于是必然触发追平，
// 用户正在编辑的那天被抢回今天（reopened_date 也被清成 null），
// 表现为「过几秒就跳回今天、正在改的那天没了」。
//
// 修法：处于「重开编辑」状态时**暂停追平**。
//   判据：state.reopened_date 存在且 === state.logical_date（即"当前正停在被重开的那天"）。
//   退出条件：用户点「标记为已结束」或手动回到今天（reopened_date 被清空）。
// 这样既保留了跨 04:00 自动切日的能力，又不会打断用户的编辑。
setInterval(() => {
  const state = getAppState();
  // 正在编辑被重开的那一天 → 不动逻辑日
  if (state.reopened_date && state.reopened_date === state.logical_date) {
    return;
  }
  const nowLogical = ld(new Date());
  if (nowLogical !== state.logical_date) {
    startupAutoClose(new Date());
    rerender();
  }
}, 60000);

// PWA 更新提示 + 离线/恢复 + 新版本就绪提示
// PWA 更新提示 + 离线/恢复 + 新版本就绪提示
if (typeof window !== 'undefined' && 'serviceWorker' in navigator) {
  let versionNotified = false;
  const notifyVersion = () => {
    if (versionNotified) return;
    versionNotified = true;
    try { toast('已更新到新版本', 'info'); } catch (err) { console.error(err); }
  };
  navigator.serviceWorker.register('sw.js').then(reg => {
    reg.addEventListener('updatefound', () => {
      const nw = reg.installing;
      if (!nw) return;
      nw.addEventListener('statechange', () => {
        try {
          if (nw.state === 'installed' && navigator.serviceWorker.controller) {
            notifyVersion();
          }
        } catch (err) { console.error(err); }
      });
    });
    // 首次访问：SW 已装好但本页还没被接管（controller=null）→ 提示再刷新一次即可离线。
    // 只提示一次（localStorage 标记）；用户清站点数据后会重新提示，符合预期。
    // ⚠️ 必须延迟再判定：serviceWorker.ready 在 activate 时就 resolve，而 clients.claim()
    //    生效有延迟（本机实测 >800ms）—— 立刻检查会在"其实已受控"时误提示（实测踩过两次）。
    navigator.serviceWorker.ready.then(() => {
      setTimeout(() => {
        try {
          if (navigator.serviceWorker.controller) return;           // 已受控，无需提示
          const KEY = 'calorie.sw-first-hint';
          if (localStorage.getItem(KEY) === '1') return;            // 已提示过
          localStorage.setItem(KEY, '1');
          toast('页面已缓存，再刷新一次即可离线使用', 'success');
        } catch (err) { console.error(err); }
      }, 2000);
    }).catch(() => {});
  }).catch(() => {});
  try {
    // ⚠️ 首次安装也会触发 controllerchange（clients.claim），那时并不存在"旧版本"。
    //    所以只有「此前已经有 controller」时才算真正的版本更新（实测踩过：首访就弹"已更新"）。
    let hadController = !!navigator.serviceWorker.controller;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (!hadController) { hadController = true; return; }
      try { notifyVersion(); } catch (err) { console.error(err); }
    });
  } catch (err) { console.error(err); }
}

// 离线 / 恢复连接提示
if (typeof window !== 'undefined') {
  let offlineNotified = false;
  try {
    window.addEventListener('offline', () => {
      try {
        if (offlineNotified) return;
        offlineNotified = true;
        toast('已离线，仍可继续记录（数据存在本机）', 'info');
      } catch (err) { console.error(err); }
    });
    window.addEventListener('online', () => {
      try {
        offlineNotified = false;
        toast('已恢复连接', 'info');
      } catch (err) { console.error(err); }
    });
  } catch (err) { console.error(err); }
}

// —— 全局错误兜底（r1-3）：未捕获异常 / 未处理拒绝 / 存储失败 ——
// 同一类（kind:message）5 秒内只提示一次，避免刷屏。
{
  const lastToast = new Map();
  const keyOf = (kind, msg) => `${kind}:${String(msg || '').slice(0, 80)}`;
  const throttleToast = (key, text) => {
    const now = Date.now();
    const prev = lastToast.get(key);
    if (prev != null && now - prev < 5000) return; // 5 秒冷却
    lastToast.set(key, now);
    toast(text, 'error');
  };
  try {
    window.addEventListener('error', (e) => {
      const rawMsg = e && e.message ? e.message : '未知脚本错误';
      // 良性警告/跨域脱敏错误：没有可操作信息，不弹 toast，仅 console.warn
      // - ResizeObserver loop ...：图表尺寸观测自激产生的浏览器警告，已在 observeResize 用尺寸差+RAF 节流抑制
      // - Script error.（或 Script error 前缀）：跨域脚本的脱敏错误，浏览器不给堆栈/行号，提示用户无意义
      if (rawMsg.indexOf('ResizeObserver loop') !== -1 || rawMsg.indexOf('Script error') === 0) {
        console.warn('[suppressed] window error:', rawMsg);
        return;
      }
      const msg = String(rawMsg).slice(0, 60);
      throttleToast(keyOf('err', msg), `出错了：${msg}`);
    });
    window.addEventListener('unhandledrejection', (e) => {
      const r = e && e.reason;
      const raw = (r && r.message) ? r.message : String(r);
      throttleToast(keyOf('rej', raw), `出错了：${String(raw).slice(0, 60)}`);
    });
    window.addEventListener('calorie:storage-error', (e) => {
      const d = (e && e.detail) || {};
      throttleToast(keyOf('stor', `${d.key || ''}:${d.message || ''}`),
        '存储空间不足，最近的修改可能没保存');
    });
  } catch (err) {
    console.error('全局错误兜底注册失败', err);
  }
}