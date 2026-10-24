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