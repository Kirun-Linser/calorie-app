import { initDB, getAppState, setAppState } from './core/db.js';
import { startupAutoClose, logicalDate } from './domain/state.js';
import { logicalDate as ld } from './core/date.js';
import { mount, navigate, rerender } from './ui/app.js';
import { toast } from './ui/components.js';

try {
  initDB();
  startupAutoClose(new Date());
  mount();
} catch (e) {
  console.error(e);
  document.getElementById('app').innerHTML = `<div style="padding:20px;color:var(--danger);"><h3>启动失败</h3><pre>${e.message}</pre></div>`;
}

// 定时逻辑日检查
setInterval(() => {
  const state = getAppState();
  const nowLogical = ld(new Date());
  if (nowLogical !== state.logical_date) {
    startupAutoClose(new Date());
    rerender();
  }
}, 60000);

// PWA 更新提示
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').then(reg => {
    reg.addEventListener('updatefound', () => {
      const nw = reg.installing;
      nw.addEventListener('statechange', () => {
        if (nw.state === 'installed' && navigator.serviceWorker.controller) {
          if (window.confirm('检测到新版本，是否刷新？')) location.reload();
        }
      });
    });
  }).catch(() => {});
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
      const msg = (e && e.message ? e.message : '未知脚本错误').slice(0, 60);
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