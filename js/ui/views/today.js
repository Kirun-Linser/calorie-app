// views/today.js — 「今日」页（账本版）
// 上方深色区：今天还可以吃多少 + 记账输入；下方纸白区：一行一笔的今日台账。
// 功能：记热量（手动快速路径 + 四入口抽屉/历史/词典/快捷 + 待分摊）、记体重、快捷项增删、单条改/撤销（带二次确认）、左滑两次撤销、待分摊管理
import {
  getAppState, getDailyRecord, getIntakeRecordsByDate, getOpenAllocations, getStore,
  getWeights, searchFood, addFood, updateIntakeRecord
} from '../../core/db.js';
import { QUICK_KEY, LEGACY_QUICK, readJSON } from '../../core/store.js';
import { recordIntake, undoIntake, percentOfDaily, recalcDaily } from '../../domain/engine.js';
import { parseInput, round1 } from '../../domain/parser.js';
import { recordWeight } from '../../domain/weight.js';
import { createAllocationFromKcal, stopAllocation } from '../../domain/allocation.js';
import { weekday } from '../../core/date.js';
import { toast, openSheet, closeSheet, confirmSheet, esc } from '../components.js';

const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

// 「历史复用」列表的排序方式（模块级：关掉抽屉再打开保持上次选择）
// 'count' = 次数多→少（默认，高频更好用）；'time' = 时间新→旧
let historySortBy = 'count';

// app.js 会挂 window.app，回调里通过它重绘，避免循环 import
const rerender = () => { if (window.app && window.app.rerender) window.app.rerender(); };

// 右上角刷新：手机上 PWA 常因旧 Service Worker 缓存看不到更新。
// 联网时先清掉本应用的缓存与注册，再重载（确保拿到最新版）；离线时只重载，避免清完打不开。
async function hardRefresh() {
  const btn = document.querySelector('.view__refresh');
  if (btn) btn.classList.add('is-busy');
  try { toast('正在获取最新版本…', 'info'); } catch (e) {}
  const online = !(typeof navigator !== 'undefined' && navigator.onLine === false);
  if (online) {
    try {
      if (typeof caches !== 'undefined') {
        const keys = await caches.keys();
        await Promise.all(keys.map(k => caches.delete(k)));
      }
    } catch (e) {}
    try {
      if (navigator.serviceWorker && navigator.serviceWorker.getRegistrations) {
        const regs = await navigator.serviceWorker.getRegistrations();
        await Promise.all(regs.map(r => (r.update ? r.update().catch(() => {}) : Promise.resolve())));
      }
    } catch (e) {}
  }
  setTimeout(() => { try { location.reload(); } catch (e) {} }, 400);
}

// ===== 快捷项（独立 localStorage 键，不入 DB 备份 —— v1 决策 4 保持不变） =====
function getQuickItems() {
  const v2 = readJSON(QUICK_KEY);
  if (Array.isArray(v2)) return v2;
  const legacy = readJSON(LEGACY_QUICK);
  return Array.isArray(legacy) ? legacy : [];
}
function saveQuickItems(items) {
  try { localStorage.setItem(QUICK_KEY, JSON.stringify(items)); } catch (e) { /* 忽略配额错误 */ }
}

// ===== 主视图（账本版） =====
export function render() {
  const state = getAppState();
  const date = state.logical_date; // 一律用 04:00 逻辑日，不用真实今天
  const daily = getDailyRecord(date) || { logical_date: date, total_kcal: 0, target_kcal: state.target_kcal, closed_at: null };
  const target = daily.target_kcal;
  const eaten = daily.total_kcal;
  const pct = percentOfDaily(eaten, target);
  const left = target - eaten;            // 主数字语义：还剩多少
  const over = left < 0;
  const leftAbs = over ? -left : left;
  const recs = getIntakeRecordsByDate(date).slice().reverse(); // 最新在上
  const allocs = getOpenAllocations();
  const allocSum = allocs.reduce((s, a) => s + (a.total_kcal || 0), 0);
  const weights = getWeights();
  const todayWeight = weights.find(w => String(w.created_at).slice(0, 10) === date);
  const quickItems = getQuickItems();

  // 进度条下方状态行：空态 / 还差 / 超标
  const note = recs.length === 0
    ? '今天还没记东西'
    : over
      ? `已吃 ${round1(pct)}%，超了 ${round1(leftAbs)} kcal`
      : `已吃 ${round1(pct)}%，还差 ${round1(left)} kcal`;

  const dateLine = `${date} ${WEEKDAYS[weekday(date)]} · 第 ${state.current_day_index} 天`;

  const container = document.createElement('div');
  container.className = 'view view--ledger';
  container.innerHTML = `
    <div class="masthead">
      <div class="masthead__left">
        <h1 class="wordmark">K<span class="wordmark__plus">++</span></h1>
        <p class="masthead__date">${esc(dateLine)}</p>
      </div>
      <button class="masthead__refresh view__refresh" data-act="hardRefresh" aria-label="刷新并获取最新版本" title="刷新（清缓存后重载）">⟳</button>
    </div>

    <div class="hero ${over ? 'is-over' : ''}">
      <p class="hero__label">${over ? '今天已经超出' : '今天还可以吃'}</p>
      <p class="hero__row">
        <span class="hero__value">${round1(leftAbs)}</span>
        <span class="hero__unit">kcal</span>
      </p>
      <p class="hero__meta">已吃 ${round1(eaten)} / 目标 ${round1(target)}</p>
    </div>

    <div class="progress ${over ? 'is-over' : ''}" role="progressbar"
         aria-label="今日热量进度" aria-valuemin="0" aria-valuemax="${round1(target)}"
         aria-valuenow="${round1(eaten)}">
      <div class="progress__fill ${over ? 'is-over' : ''}" style="width:${Math.min(100, Math.max(0, pct))}%"></div>
    </div>
    <p class="progress-note">${esc(note)}</p>

    <form class="entry" autocomplete="off">
      <label class="sr-only" for="ledgerEntryInput">记一笔：写食物名和热量，或只写热量</label>
      <input class="entry__input" id="ledgerEntryInput" type="text"
             placeholder="鸡蛋 70" enterkeyhint="done" autocomplete="off">
      <button class="entry__submit" type="submit">记一笔</button>
      <button class="entry__more" type="button" data-act="intake" aria-label="打开完整记账抽屉（历史复用 / 食物词典 / 待分摊）" title="详细记录">详细▾</button>
    </form>

    <!-- 常吃按钮条：不折叠、首屏可见、横向滚动（契约 4.2 两次操作）。
         点一下 → confirmSheet 一次确认 → 落账，不再套抽屉。
         长按 500ms → 进入「整理模式」，可以像手机桌面那样左右拖动改顺序；
         松手时若没有移动（原地长按），则问是否删除该项。
         0 个常吃项时同样显示「＋ 添加常吃」入口，不留空白。 -->
    <div class="quick-rail" role="group" aria-label="常吃，点击记录，长按可拖动排序或删除">
      ${quickItems.length === 0 ? `
        <button class="rail-item rail-item--add" type="button" data-addquick="1">
          <span class="rail-item__label">＋ 添加常吃</span>
        </button>` : `
        ${quickItems.map((h, i) => `
          <button class="rail-item" type="button" data-quick="${i}" data-rail-index="${i}"
                  aria-label="记录 ${esc(h.label)} ${round1(h.kcal)} 千卡（长按可拖动排序或删除）">
            <span class="rail-item__label">${esc(h.label)}</span>
            <span class="rail-item__kcal">${round1(h.kcal)}</span>
          </button>`).join('')}
        <button class="rail-item rail-item--add" type="button" data-addquick="1" aria-label="添加常吃项">
          <span class="rail-item__label">＋</span>
        </button>`}
    </div>

    <section class="ledger ledger--inset" aria-labelledby="ledgerHead">
      <header class="ledger__head">
        <h2 class="ledger__title" id="ledgerHead">今日台账</h2>
        <p class="ledger__count">${recs.length} 笔</p>
      </header>

      ${recs.length === 0
        ? `<div class="ledger__empty">
             <p>这一页还空着。写在上面那一行，或直接点「常吃」里的任意一项。</p>
             <button class="btn btn--sm btn--primary" data-act="intake">记第一笔</button>
           </div>`
        : `<div class="list">${recs.map(r => `
            <div class="swipe-wrap">
              <span class="swipe-hint" aria-hidden="true">再滑一次撤销</span>
              <div class="list__row" data-rec-id="${r.id}">
                <div class="list__main">
                  <!-- 2026-11-06：优先显示「设定的名字」（快捷项/词典项），
                       没有名字才退回原始输入。raw_input 仍保留在记录里用于解析与历史复用。 -->
                  <div class="list__title">${esc(r.label || r.raw_input)}</div>
                  <div class="list__meta">${String(r.created_at || '').slice(11, 16)}</div>
                </div>
                <div class="list__value">${round1(r.kcal)}</div>
                <button class="list__action" data-edit="${r.id}" aria-label="修改这一笔">改</button>
                ${r.undoable ? `<button class="list__action list__del" data-undo="${r.id}" aria-label="撤销这一笔">撤销</button>` : ''}
              </div>
            </div>`).join('')}</div>`}

      <footer class="ledger__foot">
        <span class="ledger__total-label">合计</span>
        <span class="ledger__total">${round1(eaten)}</span>
        <span class="ledger__total-unit">kcal</span>
      </footer>
    </section>

    <!-- 记体重：放在台账之后，不占首屏。
         ⚠️ 2026-11-03 修复：本轮改版时这个入口的 DOM 被误删，而 openWeightSheet()
         与 click 分支都还在 —— 结果「记体重」在界面上完全消失（功能回归）。
         已补回；改今日页 DOM 时请务必保留 data-act="weight"。 -->
    <button class="weight-btn ${todayWeight ? 'is-done' : ''}" type="button" data-act="weight">
      ${todayWeight ? '已称 ' + esc(round1(todayWeight.jin)) + ' 斤 · 再记' : '记体重'}
    </button>

    ${allocs.length > 0 ? `
      <div class="card ledger__allocs">
        <div class="card__head">
          <span class="card__title"><span class="badge badge--warn">待分摊</span>
          <span style="margin-left:8px">待分摊合计 ${round1(allocSum)} kcal（${allocs.length} 条）</span></span>
        </div>
        <div class="card__body">
          <div class="list">
            ${allocs.map(a => `
              <div class="list__row" data-alloc-id="${a.id}">
                <div class="list__main">
                  <!-- 2026-11-08：名字为主、热量为辅（与今日台账一致的用户要求）。
                       旧记录没有 label → 只显示热量，保持向后兼容。 -->
                  <div class="list__title">${a.label ? esc(a.label) : round1(a.total_kcal) + ' kcal'}</div>
                  <div class="list__meta">${a.label ? round1(a.total_kcal) + ' kcal · ' : ''}起算 ${esc(a.start_date)}</div>
                </div>
                <button class="btn btn--sm btn--ok" data-act="stopAlloc" data-id="${a.id}">停止分摊</button>
              </div>`).join('')}
          </div>
        </div>
      </div>` : ''}
  `;

  // 手势滑动后吞掉浏览器随之派发的 click，否则会误触行内的「改 / 撤销」按钮
  // （实测：不拦截时第一次左滑就直接撤销了记录）
  let suppressClickUntil = 0;
  // 第二次左滑本身即确认，程序化触发的撤销不再弹 confirmSheet
  let swipeFiredUndo = false;

  // —— 常吃长按：整理模式（拖动排序）或删除，变量声明见下方 rail 段 ——

  // ===== 唯一 click 委托（契约 4.1 多级短路）=====
  container.addEventListener('click', async (e) => {
    // 1. suppressClickUntil 期间的滑动后吞点击 / 长按后吞点击
    if (Date.now() < suppressClickUntil) { e.stopPropagation(); e.preventDefault(); return; }
    // 2. 删除类 —— 必须先于记录类
    const del = e.target.closest('[data-delquick],[data-rmquick]');
    if (del) {
      e.stopPropagation();
      if (del.dataset.delquick != null) {
        const i = Number(del.dataset.delquick);
        const item = getQuickItems()[i];
        if (!item) return;
        const ok = await confirmSheet({ title: '删除快捷项', text: `删除「${item.label}」？`, danger: true });
        if (ok) { const arr = getQuickItems(); arr.splice(i, 1); saveQuickItems(arr); rerender(); }
      } else {
        const i = Number(del.dataset.rmquick);
        const arr = getQuickItems();
        if (!arr[i]) return;
        const ok = await confirmSheet({ title: '删除快捷项', text: `删除「${arr[i].label}」？`, danger: true });
        if (ok) { arr.splice(i, 1); saveQuickItems(arr); renderTab('quick', document.getElementById('intakeTabBody') || del.closest('.sheet__body')); rerender(); }
      }
      return;
    }
    // 3. 编辑类
    const ed = e.target.closest('[data-edit]');
    if (ed) { openEditIntakeSheet(Number(ed.dataset.edit)); return; }
    // 4. 记录类（data-quick / data-pickquick / data-pick / data-food）
    const q = e.target.closest('[data-quick],[data-pickquick],[data-pick],[data-food]');
    if (q) {
      if (q.dataset.quick != null) {
        const h = getQuickItems()[Number(q.dataset.quick)];
        if (!h) return;
        // 两次操作：点常吃项 → 一次确认 → 落账（契约 4.2）
        const ok = await confirmSheet({
          title: '记录常吃',
          text: `记一笔「${h.label}」${round1(h.kcal)} kcal？`,
          okText: '记录',
        });
        if (!ok) return;
        try {
          recordIntake(h.raw, undefined, h.label);
          toast(`已记录 ${h.label} ${round1(h.kcal)} kcal`, 'success');
          rerender();
        } catch (err) { toast(err.message, 'error'); }
        return;
      }
      if (q.dataset.pickquick != null) {
        const h = getQuickItems()[Number(q.dataset.pickquick)];
        if (!h) return;
        const ok = await confirmSheet({
          title: '记录快捷项',
          text: `记录「${h.label}」${round1(h.kcal)} kcal？`,
          okText: '记录',
        });
        if (!ok) return;
        try {
          recordIntake(h.raw, undefined, h.label);
          toast(`已记录 ${h.label} ${round1(h.kcal)} kcal`, 'success');
          closeSheet(); rerender();
        } catch (err) { toast(err.message, 'error'); }
        return;
      }
      if (q.dataset.pick != null) {
        try {
          recordIntake(q.dataset.pick);
          toast('已记录', 'success');
          closeSheet(); rerender();
        } catch (err) { toast(err.message, 'error'); }
        return;
      }
      if (q.dataset.food != null) {
        try {
          recordIntake(`${q.dataset.n}个${q.dataset.food}`, undefined,
                       Number(q.dataset.n) === 1 ? q.dataset.food : `${q.dataset.food} ×${q.dataset.n}`);
          toast('已记录', 'success');
          closeSheet(); rerender();
        } catch (err) { toast(err.message, 'error'); }
        return;
      }
      return;
    }
    // 5. 抽屉/动作类（data-act / data-addquick）
    const a = e.target.closest('[data-act],[data-addquick]');
    if (a) {
      if (a.dataset.addquick) { openAddQuickSheet(); return; }
      const act = a.dataset.act;
      if (act === 'hardRefresh') { await hardRefresh(); return; }
      if (act === 'intake') { openIntakeSheet(); return; }
      if (act === 'weight') { openWeightSheet(); return; }
      if (act === 'stopAlloc') {
        const al = getStore().allocation.find(x => String(x.id) === String(a.dataset.id) && x.status === 'open');
        if (!al) return;
        try {
          const r = stopAllocation(al.id);
          toast(`已分摊 ${r.days} 天，每天 ${round1(r.perDay)} kcal`, 'success');
          rerender();
        } catch (err) { toast(err.message, 'error'); }
        return;
      }
      return;
    }
    // 6. 撤销（data-undo）——显式点「撤销」要二次确认；
    //    左滑两次触发时 swipeFiredUndo=true，跳过弹窗（两次滑动本身即确认）
    const u = e.target.closest('[data-undo]');
    if (u) {
      if (!swipeFiredUndo) {
        const ok = await confirmSheet({
          title: '撤销记录',
          text: '撤销这一笔？当日合计会相应退回。',
          danger: true,
          okText: '撤销',
        });
        if (!ok) return;
      }
      try {
        const rec = undoIntake(Number(u.dataset.undo));
        toast(`已撤销 ${round1(rec.kcal)} kcal`, 'success');
        rerender();
      } catch (err) { toast(err.message, 'error'); }
    }
  }, true);

  // —— 常吃 rail：长按进入「整理模式」——
  // 用户要求（2026-11-03）：「能像手机桌面那样，长按改变位置」。
  //
  // 行为设计（两个动作共用一个长按起点，靠"长按后有没有移动"来区分）：
  //   ① 长按 500ms → 进入整理模式：该项浮起（放大 + 阴影 + 微倾斜），
  //      左右拖动 → 其它项实时让位，松手落位、顺序持久化。
  //   ② 长按后**原地不动**就松手 → 问「删除这一项？」（保留原来的长按删除能力）
  // 这样长按既有新功能、又不丢掉旧功能，且不会误触（都要先长按 500ms）。
  //
  // 与页面横向滚动的冲突：整理模式下给 rail 加 .is-sorting，
  // CSS 把 overflow-x 临时改成 visible 并禁止 scroll，否则拖动会变成滚动。
  const RAIL_HOLD_MS = 500;
  const RAIL_SLOP = 8;          // 长按判定前允许的抖动
  const RAIL_MOVE_TO_SORT = 10; // 超过这个位移才算"要排序"而不是"原地长按"
  const railHoldTimer = { id: null };
  let railHoldFired = false;
  let railDrag = null;          // { item, startX, pointerId, moved }

  // ⚠️ 这个 const 必须在下面所有用到 rail 的函数（endSorting 等）**之前**声明。
  // 2026-11-03 踩过一次：重写这一段时漏掉它，`endSorting` 里引用 rail 触发
  // 暂时性死区（TDZ）→ 运行时抛 "rail is not defined" → 整个今日页渲染失败、
  // app 显示「启动失败」。而 `node --check` 完全查不出这类错误。
  const rail = container.querySelector('.quick-rail');

  const railIndexOrder = () => [...container.querySelectorAll('.rail-item[data-rail-index]')]
    .map(el => Number(el.dataset.railIndex));

  // 把 from 位置的项移动到 to 位置（DOM 层），返回新的顺序数组
  const moveRailItem = (fromEl, toEl) => {
    if (!fromEl || !toEl || fromEl === toEl) return;
    const items = [...container.querySelectorAll('.rail-item[data-rail-index]')];
    const fromIdx = items.indexOf(fromEl);
    const toIdx = items.indexOf(toEl);
    if (fromIdx < 0 || toIdx < 0) return;
    if (fromIdx < toIdx) toEl.after(fromEl);
    else toEl.before(fromEl);
  };

  const endSorting = (commit) => {
    if (!railDrag) return;
    const { item, moved } = railDrag;
    railDrag = null;
    if (rail) rail.classList.remove('is-sorting');
    item.classList.remove('is-dragging');
    item.style.transform = '';
    item.style.zIndex = '';
    // 记录新顺序（按 DOM 里现在的出现顺序，用 label+raw 定位回原始数据）
    if (commit && moved) {
      const arr = getQuickItems();
      const newOrder = [...container.querySelectorAll('.rail-item[data-rail-index]')]
        .map(el => Number(el.dataset.railIndex));
      if (newOrder.length === arr.length) {
        const reordered = newOrder.map(i => arr[i]).filter(Boolean);
        if (reordered.length === arr.length) {
          saveQuickItems(reordered);
          toast('顺序已保存', 'success');
          rerender();
          return;
        }
      }
    }
    // 没提交顺序：把 data-rail-index 复原，避免与数据错位
    const arr = getQuickItems();
    if (!(commit && moved)) {
      [...container.querySelectorAll('.rail-item[data-rail-index]')].forEach((el, k) => {
        el.dataset.railIndex = String(k);
        el.dataset.quick = String(k);
        if (arr[k]) el.setAttribute('aria-label', `记录 ${arr[k].label} ${round1(arr[k].kcal)} 千卡（长按可拖动排序或删除）`);
      });
    }
  };

  if (rail) {
    rail.addEventListener('pointerdown', (e) => {
      const item = e.target.closest('.rail-item[data-quick]');
      if (!item) return;
      if (railDrag) return;
      railHoldFired = false;
      const startX = e.clientX;
      const startY = e.clientY;
      railDrag = { item, startX, pointerId: e.pointerId, moved: false, startY };

      railHoldTimer.id = setTimeout(() => {
        railHoldTimer.id = null;
        railHoldFired = true;
        try { if (navigator.vibrate) navigator.vibrate(12); } catch (err) {}
        if (rail) rail.classList.add('is-sorting');
        item.classList.add('is-dragging');
      }, RAIL_HOLD_MS);
    });

    rail.addEventListener('pointermove', (e) => {
      if (!railDrag) return;
      const dx = e.clientX - railDrag.startX;
      const dy = e.clientY - railDrag.startY;

      // 还没进入整理模式（未满长按时长）：
      // 位移超阈值 → 取消长按，并把这次手势当作**横向滚动**处理。
      // 为什么要自己滚：.rail-item 上写了 touch-action:pan-y，
      // 浏览器不再接管横向手势（否则长按后的拖动会被 pointercancel 掐断），
      // 代价是原生横向滚动失效，所以这里手动把位移映射成 scrollLeft。
      if (!railHoldFired) {
        if (Math.abs(dx) > RAIL_SLOP || Math.abs(dy) > RAIL_SLOP) {
          if (railHoldTimer.id) { clearTimeout(railHoldTimer.id); railHoldTimer.id = null; }
          // 垂直为主 → 让页面滚动，不接管
          if (Math.abs(dy) > Math.abs(dx)) { railDrag = null; return; }
          if (!railDrag.scrolling) {
            railDrag.scrolling = true;
            // ⚠️ 2026-11-06 修「只能滑一点点就卡住」：
            // 原来这里记 scrollStartX = e.clientX（**跨过阈值的那个瞬间**），
            // 之后用 `e.clientX - scrollStartX` 算位移 ⇒ 从手势起点到阈值点
            // 那一段位移被永久丢弃。
            // 实测证据：手指移 120px 只滚动 90px（损耗 25%），手感就是"滑一点点就卡住"。
            // 正确做法：以**手势起点** railDrag.startX 为基准，位移从头算。
            railDrag.scrollStartLeft = rail.scrollLeft;
            railDrag.scrollStartX = railDrag.startX;
            try { rail.classList.add('is-panning'); } catch (err) {}
          }
          rail.scrollLeft = railDrag.scrollStartLeft - (e.clientX - railDrag.scrollStartX);
          if (e.cancelable) e.preventDefault();
          return;
        }
        return;
      }

      // 已在整理模式：拖动该项 + 实时让位
      if (Math.abs(dx) > RAIL_MOVE_TO_SORT) railDrag.moved = true;
      railDrag.item.style.transform = `translateX(${dx}px) scale(1.06)`;
      railDrag.item.style.zIndex = '10';

      const rect = railDrag.item.getBoundingClientRect();
      const centerX = rect.left + rect.width / 2;
      const others = [...container.querySelectorAll('.rail-item[data-rail-index]')]
        .filter(el => el !== railDrag.item);
      for (const o of others) {
        const b = o.getBoundingClientRect();
        if (centerX > b.left && centerX < b.right) {
          moveRailItem(railDrag.item, o);
          break;
        }
      }
      if (e.cancelable) e.preventDefault();
    }, { passive: false });

    const finishHold = async () => {
      if (railHoldTimer.id) { clearTimeout(railHoldTimer.id); railHoldTimer.id = null; }
      if (!railDrag) return;
      const { item, moved, scrolling } = railDrag;

      // 这次手势是横向滚动（没长按就移动了）：只清状态，不记录也不删除
      if (scrolling) {
        try { rail.classList.remove('is-panning'); } catch (err) {}
        railDrag = null;
        return;
      }

      if (!railHoldFired) {          // 没到长按时长 → 交给 click 正常记录
        railDrag = null;
        return;
      }

      if (moved) {                   // 拖动过 → 保存顺序
        endSorting(true);
        return;
      }

      // 原地长按 → 删除确认（保留旧能力）
      railDrag = null;
      railHoldFired = false;
      if (rail) rail.classList.remove('is-sorting');
      item.classList.remove('is-dragging');
      const i = Number(item.dataset.railIndex);
      const h = getQuickItems()[i];
      if (!h) return;
      // ⚠️ 2026-11-03 实测踩到：confirmSheet 弹出后，浏览器紧接着为这次长按派发 click，
      // 而 openSheet 给遮罩绑了「点遮罩即关闭」—— 于是确认框刚出现就被这一下 click 关掉了
      // （症状：标题已经是「删除常吃项」但 is-open 为 false，删除永远无法确认）。
      // 修法：弹框前把这次的 click 标记为"要吞掉"，用一个短窗口拦住紧随其后的事件。
      suppressClickUntil = Date.now() + 600;
      const ok = await confirmSheet({ title: '删除常吃项', text: `删除「${h.label}」？原地长按代表删除，左右拖动则是排序。`, danger: true });
      if (ok) { const arr = getQuickItems(); arr.splice(i, 1); saveQuickItems(arr); rerender(); }
      else endSorting(false);
    };

    rail.addEventListener('pointerup', finishHold);
    rail.addEventListener('pointercancel', () => {
      if (railHoldTimer.id) { clearTimeout(railHoldTimer.id); railHoldTimer.id = null; }
      if (railDrag && railHoldFired) endSorting(false);
      railDrag = null;
    });
    // 长按触发后吞掉随之而来的 click（防止长按后误记一笔）
    rail.addEventListener('click', (e) => {
      if (railHoldFired) { e.stopImmediatePropagation(); e.preventDefault(); railHoldFired = false; }
    }, true);
    // 触摸设备：长按会触发系统 contextmenu（长按选中文字）——拦掉
    rail.addEventListener('contextmenu', (e) => { e.preventDefault(); });
    // 键盘可达性：焦点在常吃项上，Delete/Backspace 删除
    rail.addEventListener('keydown', (e) => {
      const item = e.target.closest('.rail-item[data-quick]');
      if (!item) return;
      if (e.key !== 'Delete' && e.key !== 'Backspace') return;
      e.preventDefault();
      item.dispatchEvent(new CustomEvent('raildelete', { bubbles: false }));
    });
  }

  // 记一笔：输入行手动快速路径（解析输入直接落账，复杂需求走「详细▾」完整抽屉）
  const entryForm = container.querySelector('.entry');
  const entryInput = container.querySelector('.entry__input');
  entryForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const v = entryInput.value.trim();
    if (!v) return;
    try {
      recordIntake(v);
      toast('已记录', 'success');
      entryInput.value = '';
      rerender();
    } catch (err) { toast(err.message, 'error'); }
  });

  // —— 今日台账：向左滑动两次撤销（触摸与鼠标拖拽都支持）——
  // 第一次滑过阈值 → 行停在 -88px 并显示「再滑一次撤销」；4 秒内第二次滑过阈值 → 执行撤销。
  //
  // ⚠️ 2026-11-03 修「手机上滑动莫名其妙跑偏」。用真实触摸事件探针
  // （_shots/probe-swipe.mjs，结果见 _shots/probe-swipe-result.json）量出三个真故障：
  //
  //  故障① 指针在元素外抬起 / 系统接管手势（下拉刷新、边缘返回、接电话）时，
  //        pointerup 不会派发到 container ⇒ endSwipe 永不执行 ⇒ 行**永久卡在 is-swiping
  //        与位移状态**，之后再怎么点都没反应。探针 noTouchEnd 用例实测：
  //        isSwiping=true、translateX(-90px) 一直挂着。
  //        修法：监听器改挂 window（手指移出容器也能收到），并在 pointerdown 时
  //        兜底清掉上一次的残留状态。
  //
  //  故障② 方向判定只看「第一个超过 8px 的位移样本」。真实手指第一帧往往是抖动，
  //        一个 9px 斜抖就被判成横向 ⇒ 用户明明想竖向滚动，行却被左拉一截（"跑偏"）。
  //        修法：要求连续累积位移同时满足「水平 > 10px」且「明确大于垂直 1.2 倍」，
  //        并允许在判定前后重新裁决（锁存后才不再改）。
  //
  //  故障③ 横向兜底位移夹取 SWIPE_OPEN+20=108px，但行本身没有 overscroll，
  //        超滑后松手回弹到 -88px 时视觉上有一次"跳一下"。修法：夹取到 SWIPE_OPEN，
  //        与停靠位置一致，超滑不再回跳。
  const SWIPE_TRIGGER = 56;   // 触发阈值 px
  const SWIPE_OPEN = 88;      // 第一次滑够后停住的位移
  const AXIS_MIN = 10;        // 判为横向所需的最小水平位移
  const AXIS_RATIO = 1.2;     // 水平必须是垂直的多少倍才算横向

  let swipe = null;           // { row, wrap, startX, startY, dx, axis: null|'x'|'y' }
  let armedRow = null;        // 已进入「再滑一次」状态的行
  let armedTimer = null;

  // 统一的"清掉某行的滑动残留"：位移 + is-swiping + is-armed 一起复位
  const resetRow = (row) => {
    if (!row) return;
    row.classList.remove('is-swiping');
    row.style.transform = '';
    const w = row.closest('.swipe-wrap');
    if (w) w.classList.remove('is-armed');
  };

  const clearArmed = () => {
    if (armedTimer) { clearTimeout(armedTimer); armedTimer = null; }
    if (armedRow) resetRow(armedRow);
    armedRow = null;
  };

  const onDown = (e) => {
    // 兜底：上一轮手势若因 pointerup 丢失而残留，进新手势前先清掉
    if (swipe) { resetRow(swipe.row); swipe = null; }

    // 命中行：除了行本身，还要能命中它的外层 .swipe-wrap 与右侧露出的 .swipe-hint。
    // ⚠️ 2026-11-03 实测踩到的坑：行第一次左滑后停在 -88px，左侧露出 .swipe-hint，
    // 用户第二次滑的起点常常落在 .swipe-hint 或 .swipe-wrap 上（不是 .list__row），
    // 用 `e.target.closest('.list__row[data-rec-id]')` 会返回 null ⇒ 第二次滑动被完全忽略，
    // 「两次左滑撤销」永远不生效（探针 probe-swipe3 实测：slide2 后 armed 仍为 1、记录数不变）。
    // 修法：先向上找 wrap，再从 wrap 内部取行。
    let row = null;
    const direct = e.target.closest && e.target.closest('.list__row[data-rec-id]');
    if (direct) {
      row = direct;
    } else {
      const wrap = e.target.closest && e.target.closest('.swipe-wrap');
      if (wrap) row = wrap.querySelector('.list__row[data-rec-id]');
    }
    if (!row) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;

    // 已 armed 的行再次按下，保持它的位移；其它行按下则清掉 armed（避免同时两行开着）
    if (armedRow && armedRow !== row) clearArmed();
    swipe = {
      row,
      wrap: row.closest('.swipe-wrap'),
      startX: e.clientX,
      startY: e.clientY,
      dx: 0,
      axis: null,
    };
  };

  const onMove = (e) => {
    if (!swipe) return;
    const dx = e.clientX - swipe.startX;
    const dy = e.clientY - swipe.startY;

    // 方向裁决：锁存后不再改判，避免"划到一半突然被抢走"
    if (!swipe.axis) {
      const adx = Math.abs(dx);
      const ady = Math.abs(dy);
      if (adx < AXIS_MIN && ady < AXIS_MIN) return;      // 位移太小，还判不出方向
      if (adx >= AXIS_MIN && adx > ady * AXIS_RATIO) {
        swipe.axis = 'x';
        swipe.row.classList.add('is-swiping');
      } else if (ady > adx) {
        swipe.axis = 'y';                                 // 判为垂直滚动，本轮彻底放弃
        swipe = null;
        return;
      } else {
        return;                                           // 斜向模糊（如 45°），继续观察
      }
    }
    if (swipe.axis !== 'x') return;

    swipe.dx = Math.min(0, dx);
    // 夹取到 SWIPE_OPEN：超滑松手后不再"回跳"
    const offset = Math.max(swipe.dx, -SWIPE_OPEN);
    swipe.row.style.transform = `translateX(${offset}px)`;
    if (e.cancelable) e.preventDefault();
  };

  const endSwipe = () => {
    if (!swipe) return;
    const { row, wrap, dx, axis } = swipe;
    swipe = null;
    row.classList.remove('is-swiping');

    if (axis !== 'x') {                  // 没判成横向：什么都不做（垂直滚动本来就没动过）
      row.style.transform = '';
      return;
    }
    // 只要发生了水平位移，就吞掉紧随其后的 click（含点在「撤销」上起手的情况）
    if (dx < -8) suppressClickUntil = Date.now() + 500;
    if (dx <= -SWIPE_TRIGGER) {
      if (armedRow !== row) {
        // 第一次滑够 → 进入待确认状态
        clearArmed();
        armedRow = row;
        row.style.transform = `translateX(-${SWIPE_OPEN}px)`;
        if (wrap) wrap.classList.add('is-armed');
        // 4 秒后自动复位；armed 状态下不加 is-swiping，否则 CSS 的 animation:none 会关掉过渡
        armedTimer = setTimeout(() => clearArmed(), 4000);
        return;
      }
      // 第二次滑够 → 真正撤销：标记跳过 confirmSheet（两次滑动即确认），复用按钮的撤销分支
      clearArmed();
      const btn = row.querySelector('[data-undo]');
      if (btn) {
        suppressClickUntil = 0;
        swipeFiredUndo = true;
        try { btn.click(); } finally { swipeFiredUndo = false; suppressClickUntil = Date.now() + 500; }
      }
      return;
    }
    // 没滑够：回弹
    row.style.transform = '';
    if (armedRow === row) clearArmed();
  };

  // 监听器挂 window 而非 container：手指移出容器 / 移出视口再抬起时，
  // pointerup 仍能送达，行不会永久卡住（故障① 的修法）
  window.addEventListener('pointerdown', onDown);
  window.addEventListener('pointermove', onMove, { passive: false });
  window.addEventListener('pointerup', endSwipe);
  window.addEventListener('pointercancel', () => {
    // 系统接管手势（下拉刷新 / 边缘返回 / 来电）：把行复位，但不判撤销
    if (!swipe) return;
    resetRow(swipe.row);
    swipe = null;
  });
  // 切后台 / 页面被隐藏时也复位，防止回来时行卡在位移态
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      if (swipe) { resetRow(swipe.row); swipe = null; }
      clearArmed();
    }
  });

  // 视图销毁时清掉挂在 window 上的监听器，避免重复 render 后堆叠多份处理器
  container.__cleanupSwipe = () => {
    window.removeEventListener('pointerdown', onDown);
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', endSwipe);
    if (armedTimer) { clearTimeout(armedTimer); armedTimer = null; }
  };

  return container;
}

// ===== 记热量抽屉：四个入口 =====
function openIntakeSheet() {
  openSheet({
    title: '记热量',
    body: `
      <div class="segmented" id="intakeTabs">
        <button class="segmented__item is-active" data-tab="manual">手动</button>
        <button class="segmented__item" data-tab="history">历史复用</button>
        <button class="segmented__item" data-tab="food">食物词典</button>
        <button class="segmented__item" data-tab="quick">快捷</button>
      </div>
      <div id="intakeTabBody"></div>
    `,
  });

  const tabs = document.getElementById('intakeTabs');
  const body = document.getElementById('intakeTabBody');
  if (!tabs || !body) return;

  const go = (tab) => {
    tabs.querySelectorAll('.segmented__item').forEach(b => b.classList.toggle('is-active', b.dataset.tab === tab));
    renderTab(tab, body);
  };
  tabs.addEventListener('click', (e) => {
    const b = e.target.closest('.segmented__item');
    if (b) go(b.dataset.tab);
  });
  go('manual');
}

// ===== 创建待分摊时询问名字（2026-11-08 用户要求）=====
// 返回：
//   string  → 用户填的名字（可能为空串，表示"不填"）
//   undefined → 用户取消，调用方应中止创建
function promptAllocLabel(kcal, rawInput) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };
    openSheet({
      title: '给这笔待分摊起个名字',
      body: `
        <div class="hint">这笔一共 <b>${round1(kcal)}</b> kcal，会按天分摊下去。起个名字方便以后认出它。</div>
        <div class="field">
          <div class="field__label">名字（可留空）</div>
          <input class="input" id="allocLabelInput" maxlength="24"
                 placeholder="如 一整袋鸡胸肉 / 一箱牛奶" autocomplete="off">
        </div>
        <div class="hint">留空的话，列表里只显示热量。</div>
      `,
      footer: `
        <button class="btn btn--ghost btn--block" id="allocLabelSkip">跳过，不起名</button>
        <button class="btn btn--primary btn--block" id="allocLabelOk">用这个名字</button>
      `,
      onClose: () => done(undefined),
    });
    setTimeout(() => {
      const inp = document.getElementById('allocLabelInput');
      const ok = document.getElementById('allocLabelOk');
      const skip = document.getElementById('allocLabelSkip');
      const submit = () => {
        const v = (inp && inp.value || '').trim();
        done(v);
        closeSheet();
      };
      if (ok) ok.onclick = submit;
      if (skip) skip.onclick = () => { done(''); closeSheet(); };
      if (inp) {
        inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
        inp.focus();
      }
    }, 0);
  });
}

function renderTab(tab, body) {
  if (tab === 'manual') {
    body.innerHTML = `
      <input class="input" id="intakeInput" placeholder="如 739，330 / 739kj / 6个蛋 / -500（冲销）" autocomplete="off">
      <div class="preview" id="intakePreview"></div>
      <!-- 示例 chips 提到主按钮之前：它们是"填一个试试"的快捷入口，比读说明有用 -->
      <div class="chips">
        <button class="chip" data-fill="739，330">739，330</button>
        <button class="chip" data-fill="739kj">739kj</button>
        <button class="chip" data-fill="6个蛋">6个蛋</button>
        <button class="chip" data-fill="一份烩面">一份烩面</button>
        <button class="chip" data-fill="-500">-500 冲销</button>
      </div>
      <button class="btn btn--primary btn--block" id="submitIntake">记录</button>
      <button class="btn btn--ghost btn--block" id="submitAlloc">作为待分摊（大包装 / 多日量）</button>
      <!-- ⚠️ 2026-11-05 改造：原来两段说明文字（可用格式 + 冲销说明）常驻显示，
           实测占掉约 120px 高度，把「记录」主按钮压到屏幕下半部。
           日常使用时这些说明 99% 的情况是噪音（用户早就知道怎么写）。
           改成默认折叠的一行提示，需要时点开。 -->
      <details class="intake-help">
        <summary>怎么写 · 冲销 / 纠错</summary>
        <div class="hint">可用格式：739，330（kj/100g,克）· 739kj · 6个蛋 · 一份烩面 · 烩面x2 · 6个蛋➕2个橘子 · 243kj，2500g</div>
        <div class="hint">想<b>冲销 / 纠错</b>就填<b>负数</b>：-500 表示从当天扣掉 500 kcal（总额会真的减少，可以是负的）</div>
      </details>
    `;
    const inp = document.getElementById('intakeInput');
    const preview = document.getElementById('intakePreview');
    const update = () => {
      const v = inp.value.trim();
      if (!v) { preview.textContent = ''; return; }
      try {
        const r = parseInput(v);
        preview.innerHTML = `预估 <b>${round1(r.kcal)}</b> kcal`;
      } catch (e) {
        preview.innerHTML = `<span style="color:var(--danger)">${esc(e.message)}</span>`;
      }
    };
    inp.addEventListener('input', update);
    inp.addEventListener('keydown', e => { if (e.key === 'Enter') document.getElementById('submitIntake').click(); });
    body.querySelectorAll('[data-fill]').forEach(b => b.addEventListener('click', () => {
      inp.value = b.dataset.fill; inp.focus(); update();
    }));
    document.getElementById('submitIntake').addEventListener('click', () => {
      const v = inp.value.trim();
      if (!v) return;
      try {
        recordIntake(v);
        toast('已记录', 'success');
        closeSheet();
        rerender();
      } catch (e) { toast(e.message, 'error'); }
    });
    document.getElementById('submitAlloc').addEventListener('click', async () => {
      const v = inp.value.trim();
      if (!v) return;
      try {
        const parsed = parseInput(v);
        // kcal 优先；解析结果没有 kcal 时用 kJ/4.184 兜底
        const kcal = parsed.kcal !== undefined ? parsed.kcal : parsed.kj / 4.184;
        if (!(kcal > 0)) throw new Error('待分摊需要能算出热量的输入');

        // 2026-11-08 用户要求「待分摊板块也要有名字」：
        // 创建时弹一个名字输入（可留空）。原来只存 total_kcal，
        // 列表里只能看到「5480.9 kcal」，看不出买的是什么。
        const label = await promptAllocLabel(kcal, v);
        if (label === undefined) return;   // 用户取消

        const created = createAllocationFromKcal(kcal, label);
        toast(label
          ? `已创建待分摊：${label} ${round1(created.total_kcal)} kcal`
          : `已创建待分摊：${round1(created.total_kcal)} kcal`, 'success');
        closeSheet();
        rerender();
      } catch (e) { toast(e.message, 'error'); }
    });
    setTimeout(() => inp.focus(), 60);
    return;
  }

  if (tab === 'history') {
    // 排序切换（2026-11-03 用户要求）：「按时间顺序（从新到旧）/ 次数顺序（多到少）」可在右上切换。
    // 默认仍是次数优先（高频更好用），点一下切到时间优先；选择记在模块级变量里，
    // 关掉抽屉再打开仍保持上次选择。次数相同时用另一个维度兜底，保证顺序稳定。
    const paintHistory = (sortBy) => {
      historySortBy = sortBy;
      const all = [...getStore().intake_history];
      const hist = (sortBy === 'time'
        ? all.sort((a, b) =>
            String(b.last_used_at || '').localeCompare(String(a.last_used_at || '')) ||
            (b.use_count || 0) - (a.use_count || 0))
        : all.sort((a, b) =>
            (b.use_count || 0) - (a.use_count || 0) ||
            String(b.last_used_at || '').localeCompare(String(a.last_used_at || '')))
      ).slice(0, 20);

      body.innerHTML = `
        <!-- ⚠️ 2026-11-05：原来这里左边还有一行「按使用次数」文字标签，
             而右侧 segmented 的高亮已经说明了当前排序 —— 两个元素说同一件事。
             去掉文字标签，只留 segmented，并靠右对齐。 -->
        <div class="hist-head">
          <div class="segmented hist-sort" role="group" aria-label="排序方式">
            <button class="segmented__item ${sortBy === 'count' ? 'is-active' : ''}" data-hsort="count">次数多→少</button>
            <button class="segmented__item ${sortBy === 'time' ? 'is-active' : ''}" data-hsort="time">时间新→旧</button>
          </div>
        </div>
        ${hist.length === 0
          ? `<div class="empty"><div class="empty__text">还没有历史记录</div></div>`
          : `<div class="list">${hist.map(h => `
              <div class="list__row">
                <div class="list__main">
                  <div class="list__title">${esc(h.raw_input)}</div>
                  <div class="list__meta">用过 ${h.use_count || 0} 次${h.last_used_at ? ' · ' + esc(String(h.last_used_at).slice(0, 10)) : ''}</div>
                </div>
                <div class="list__value">${round1(h.kcal)}</div>
                <button class="list__action" data-pick="${esc(h.raw_input)}">记录</button>
              </div>`).join('')}</div>`}`;

      body.querySelectorAll('[data-hsort]').forEach(btn => {
        btn.addEventListener('click', (ev) => {
          ev.stopPropagation();
          if (btn.dataset.hsort === historySortBy) return;
          paintHistory(btn.dataset.hsort);
        });
      });
      body.querySelectorAll('[data-pick]').forEach(b => b.addEventListener('click', () => {
        try {
          recordIntake(b.dataset.pick);
          toast('已记录', 'success');
          closeSheet();
          rerender();
        } catch (e) { toast(e.message, 'error'); }
      }));
    };
    paintHistory(historySortBy);
    return;
  }

  if (tab === 'food') {
    body.innerHTML = `
      <input class="input" id="foodSearch" placeholder="搜索食物…" autocomplete="off">
      <div class="list" id="foodList"></div>
      <button class="btn btn--ghost btn--block" id="openAddFood">＋ 添加自定义食物</button>
    `;
    const list = document.getElementById('foodList');
    const paint = (q) => {
      const foods = searchFood(q).slice(0, 15);
      list.innerHTML = foods.length === 0
        ? `<div class="empty"><div class="empty__text">没找到，换个词或自己添加</div></div>`
        : foods.map(f => `
            <div class="list__row food-row">
              <div class="list__main">
                <div class="list__title">${esc(f.name)}</div>
                <div class="list__meta">每份 ${f.unit_weight}g · <b>${f.unit_kcal}</b> kcal</div>
              </div>
              <!-- ⚠️ 2026-11-05 改造：原来每行并排 4 个圆形数字（1/2/3/5），
                   把行撑满、还把最常见的"记一份"埋在一排等权按钮里。
                   现在主操作是明确的「+1 份」按钮（一次点击 = 记一份），
                   份数改成点「份数」后弹出的小选择器（2/3/5 仍需一次内完成）。 -->
              <div class="food-actions">
                <button class="btn btn--sm btn--primary" data-food="${esc(f.name)}" data-n="1"
                        aria-label="记录一份 ${esc(f.name)}，${f.unit_kcal} 千卡">+1 份</button>
                <button class="btn btn--sm food-more" data-foodmore="${esc(f.name)}"
                        aria-label="选择份数：${esc(f.name)}">份数</button>
              </div>
            </div>`).join('');
    };
    paint('');
    document.getElementById('foodSearch').addEventListener('input', e => paint(e.target.value));
    list.addEventListener('click', async (e) => {
      // 份数选择：在同一抽屉内展开一行数量按钮，不叠第二层 sheet
      const more = e.target.closest('[data-foodmore]');
      if (more) {
        const name = more.dataset.foodmore;
        const row = more.closest('.food-row');
        if (!row) return;
        // ⚠️ 2026-11-05 实测踩到：展开行是用 row.after(extras) 插进去的，
        // 它是 row 的**兄弟**而不是子元素 —— 所以 `row.querySelector('.food-more-row')`
        // 永远返回 null，「已经展开就收起」这条判断失效，每次点击都新建一行。
        // 改用 nextElementSibling 判断。
        const next = row.nextElementSibling;
        if (next && next.classList.contains('food-more-row')) {
          next.remove();
          return;
        }
        // 收起其它行已展开的
        document.querySelectorAll('.food-more-row').forEach(x => x.remove());
        const extras = document.createElement('div');
        extras.className = 'food-more-row';
        extras.innerHTML = [2, 3, 5].map(n =>
          `<button class="chip" data-food="${esc(name)}" data-n="${n}">${n} 份</button>`).join('');
        row.after(extras);
        return;
      }
      const b = e.target.closest('[data-food]');
      if (!b) return;
      try {
        recordIntake(`${b.dataset.n}个${b.dataset.food}`, undefined,
                     Number(b.dataset.n) === 1 ? b.dataset.food : `${b.dataset.food} ×${b.dataset.n}`);
        toast('已记录', 'success');
        closeSheet();
        rerender();
      } catch (err) { toast(err.message, 'error'); }
    });
    document.getElementById('openAddFood').addEventListener('click', () => {
      body.innerHTML = `
        <div class="field"><div class="field__label">食物名称</div>
          <input class="input" id="foodName" placeholder="如 自制包子"></div>
        <div class="field"><div class="field__label">每份重量（克）</div>
          <input class="input" id="foodWeight" type="number" inputmode="decimal" placeholder="100"></div>
        <div class="field"><div class="field__label">每份热量（kcal）</div>
          <input class="input" id="foodKcal" type="number" inputmode="decimal" placeholder="200"></div>
        <button class="btn btn--primary btn--block" id="saveFood">保存食物</button>
        <button class="btn btn--quiet btn--block" id="cancelFood">返回词典</button>
      `;
      document.getElementById('cancelFood').addEventListener('click', () => renderTab('food', body));
      document.getElementById('saveFood').addEventListener('click', () => {
        const name = document.getElementById('foodName').value.trim();
        const w = parseFloat(document.getElementById('foodWeight').value);
        const k = parseFloat(document.getElementById('foodKcal').value);
        if (!name) return toast('请输入名称', 'error');
        if (!(w > 0)) return toast('请输入正确的重量', 'error');
        if (!(k > 0)) return toast('请输入正确的热量', 'error');
        addFood(name, w, k);
        toast(`已添加：${name}`, 'success');
        renderTab('food', body);
      });
      setTimeout(() => document.getElementById('foodName').focus(), 50);
    });
    return;
  }

  if (tab === 'quick') {
    const items = getQuickItems();
    body.innerHTML = `
      <div class="hint">点一下直接记录；点右上角 × 删除</div>
      ${items.length === 0 ? `<div class="empty"><div class="empty__text">还没有快捷项</div></div>` : `
        <div class="quick-grid">
          ${items.map((h, i) => `
            <div class="quick-item" data-pickquick="${i}" role="button" tabindex="0">
              <span class="quick-item__label">${esc(h.label)}</span>
              <span class="quick-item__kcal">${round1(h.kcal)} kcal</span>
              <button class="quick-item__del" data-rmquick="${i}" aria-label="删除">×</button>
            </div>`).join('')}
        </div>`}
      <button class="btn btn--primary btn--block" id="openAddQuick">＋ 添加快捷项</button>
    `;
    body.addEventListener('click', async (e) => {
      const rm = e.target.closest('[data-rmquick]');
      if (rm) {
        e.stopPropagation();
        const i = Number(rm.dataset.rmquick);
        const arr = getQuickItems();
        if (!arr[i]) return;
        const ok = await confirmSheet({ title: '删除快捷项', text: `删除「${arr[i].label}」？`, danger: true });
        if (ok) { arr.splice(i, 1); saveQuickItems(arr); renderTab('quick', body); rerender(); }
        return;
      }
      const pick = e.target.closest('[data-pickquick]');
      if (pick) {
        const h = getQuickItems()[Number(pick.dataset.pickquick)];
        if (!h) return;
        const ok = await confirmSheet({
          title: '记录快捷项',
          text: `记录「${h.label}」${round1(h.kcal)} kcal？`,
          okText: '记录',
        });
        if (!ok) return;
        try {
          recordIntake(h.raw, undefined, h.label);
          toast(`已记录 ${h.label} ${round1(h.kcal)} kcal`, 'success');
          closeSheet(); rerender();
        } catch (err) { toast(err.message, 'error'); }
        return;
      }
      if (e.target.closest('#openAddQuick')) openAddQuickSheet();
    });
    return;
  }
}

// ===== 添加快捷项 =====
function openAddQuickSheet(afterSave) {
  openSheet({
    title: '添加快捷项',
    body: `
      <div class="field"><div class="field__label">显示名称</div>
        <input class="input" id="quickLabel" placeholder="如 早餐蛋" autocomplete="off"></div>
      <div class="field"><div class="field__label">输入内容</div>
        <input class="input" id="quickRaw" placeholder="如 6个蛋" autocomplete="off"></div>
      <div class="preview" id="quickPreview"></div>
    `,
    footer: `<button class="btn btn--primary btn--block" id="saveQuick">保存</button>`,
  });
  const labelInp = document.getElementById('quickLabel');
  const rawInp = document.getElementById('quickRaw');
  const preview = document.getElementById('quickPreview');
  const update = () => {
    const v = rawInp.value.trim();
    if (!v) { preview.textContent = ''; return; }
    try { preview.innerHTML = `预估 <b>${round1(parseInput(v).kcal)}</b> kcal`; }
    catch (e) { preview.innerHTML = `<span style="color:var(--danger)">${esc(e.message)}</span>`; }
  };
  rawInp.addEventListener('input', update);
  document.getElementById('saveQuick').addEventListener('click', () => {
    const label = labelInp.value.trim();
    const raw = rawInp.value.trim();
    if (!label || !raw) return toast('请填写名称和内容', 'error');
    try {
      const r = parseInput(raw);
      const items = getQuickItems();
      items.push({ label, raw, kcal: r.kcal });
      saveQuickItems(items);
      toast('已添加快捷项', 'success');
      closeSheet();
      rerender();
      if (typeof afterSave === 'function') afterSave();
    } catch (e) { toast(e.message, 'error'); }
  });
  setTimeout(() => labelInp.focus(), 60);
}

// ===== 编辑一条摄入记录（只改数值，保留原始输入文字）=====
function openEditIntakeSheet(id) {
  const rec = getStore().intake_records.find(r => r.id === id);
  if (!rec) { toast('记录不存在', 'error'); return; }
  openSheet({
    title: '修改热量',
    body: `
      <div class="hint">原始输入：${esc(rec.raw_input)}</div>
      <div class="field">
        <div class="field__label">热量（kcal）</div>
        <input class="input" id="editKcal" type="number" inputmode="decimal" value="${round1(rec.kcal)}">
      </div>
      <div class="hint">只改热量数值，原始输入文字保持不变；保存后会重算当日累计。</div>
    `,
    footer: `<button class="btn btn--primary btn--block" id="saveEdit">保存</button>`,
  });
  const inp = document.getElementById('editKcal');
  setTimeout(() => { inp.focus(); inp.select(); }, 60);
  const save = () => {
    const v = parseFloat(inp.value);
    if (!(v > 0) || v > 20000) { toast('请输入 0–20000 之间的数值', 'error'); return; }
    const updated = updateIntakeRecord(id, { kcal: v });
    if (!updated) { toast('记录不存在', 'error'); return; }
    recalcDaily(updated.logical_date); // 必须重算当日累计，否则总热量对不上
    toast(`已改为 ${round1(v)} kcal`, 'success');
    closeSheet();
    rerender();
  };
  document.getElementById('saveEdit').addEventListener('click', save);
  inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') save(); });
}

// ===== 记体重 =====
function openWeightSheet() {
  const weights = getWeights();
  const last = weights.length ? round1(weights[weights.length - 1].jin) : '';
  openSheet({
    title: '记体重',
    body: `
      <div class="field"><div class="field__label">体重（裸数字按斤）</div>
        <input class="input" id="weightInput" value="${last ? esc(last) : ''}" placeholder="如 228.8 或 114.4kg" autocomplete="off"></div>
      <div class="hint">支持 228.8 / 228.8斤 / 114.4kg</div>
    `,
    footer: `<button class="btn btn--primary btn--block" id="submitWeight">记录</button>`,
  });
  const inp = document.getElementById('weightInput');
  setTimeout(() => { inp.focus(); inp.select(); }, 60);
  const submit = () => {
    const v = inp.value.trim();
    if (!v) return;
    try {
      const r = recordWeight(v);
      let msg = `记录 ${round1(r.record.jin)} 斤`;
      if (r.vs_prev != null) msg += `，较上次 ${r.vs_prev > 0 ? '+' : ''}${r.vs_prev}kg`;
      toast(msg, 'success');
      closeSheet();
      rerender();
    } catch (e) { toast(e.message, 'error'); }
  };
  document.getElementById('submitWeight').addEventListener('click', submit);
  inp.addEventListener('keydown', e => { if (e.key === 'Enter') submit(); });
}
