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
             placeholder="鸡蛋 70 · 或直接写 350" enterkeyhint="done" autocomplete="off">
      <button class="entry__submit" type="submit">记一笔</button>
      <button class="entry__more" type="button" data-act="intake" aria-label="打开完整记账抽屉（历史复用 / 食物词典 / 待分摊）" title="详细记录">详细▾</button>
    </form>

    <div class="quick">
      <p class="quick__head" data-quick-toggle="1" role="button" tabindex="0"
         aria-expanded="false" aria-controls="quickBoard">常吃<span class="quick__toggle">展开</span></p>
      <div class="quick__body" id="quickBoard">
        <div class="quick-grid">
          ${quickItems.map((h, i) => `
            <div class="quick-item" data-quick="${i}" role="button" tabindex="0" aria-label="记录 ${esc(h.label)} ${round1(h.kcal)} 千卡">
              <span class="quick-item__label">${esc(h.label)}</span>
              <span class="quick-item__kcal">${round1(h.kcal)} kcal</span>
              <button class="quick-item__del" data-delquick="${i}" aria-label="删除 ${esc(h.label)}" title="删除">×</button>
            </div>`).join('')}
          <div class="quick-item quick-item--add" data-addquick="1" role="button" tabindex="0" aria-label="添加快捷项">
            <span class="quick-item__label">＋ 添加</span>
          </div>
        </div>
      </div>
    </div>

    <section class="ledger ledger--inset" aria-labelledby="ledgerHead">
      <header class="ledger__head">
        <h2 class="ledger__title" id="ledgerHead">今日台账</h2>
        <p class="ledger__count">${recs.length} 笔</p>
      </header>

      ${recs.length === 0
        ? `<div class="ledger__empty">
             <p>这一页还空着。写一笔，或展开上面的「常吃」点一下。</p>
             <button class="btn btn--sm btn--primary" data-act="intake">记第一笔</button>
           </div>`
        : `<div class="list">${recs.map(r => `
            <div class="swipe-wrap">
              <span class="swipe-hint" aria-hidden="true">再滑一次撤销</span>
              <div class="list__row" data-rec-id="${r.id}">
                <div class="list__main">
                  <div class="list__title">${esc(r.raw_input)}</div>
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

    <!-- 记体重：放在台账之后，不占首屏（设计意图见 annual.css 手机重排段） -->
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
                  <div class="list__title">${round1(a.total_kcal)} kcal</div>
                  <div class="list__meta">起算 ${esc(a.start_date)}</div>
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
  container.addEventListener('click', (e) => {
    if (Date.now() < suppressClickUntil) { e.stopPropagation(); e.preventDefault(); }
  }, true);

  // 键盘可达性：role="button" 的常吃折叠头 / 快捷项用 Enter、Space 触发
  container.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    // 焦点在快捷项内的「×」删除按钮上时交给原生按钮处理，不要冒泡触发外层记录
    if (e.target.closest('.quick-item__del')) return;
    const b = e.target.closest('.quick__head[data-quick-toggle], .quick-item[data-quick], .quick-item--add');
    if (!b) return;
    e.preventDefault();
    b.click();
  });

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

  // 常吃区默认折叠：点头部展开 / 收起
  const quickBox = container.querySelector('.quick');
  const quickHead = container.querySelector('.quick__head');
  const quickToggleLabel = container.querySelector('.quick__toggle');
  const setQuickOpen = (open) => {
    quickBox.classList.toggle('is-open', open);
    quickHead.setAttribute('aria-expanded', String(open));
    if (quickToggleLabel) quickToggleLabel.textContent = open ? '收起' : '展开';
  };
  if (quickHead) {
    quickHead.addEventListener('click', (e) => {
      e.preventDefault();
      setQuickOpen(!quickBox.classList.contains('is-open'));
    });
  }

  container.addEventListener('click', async (e) => {
    const del = e.target.closest('[data-delquick]');
    if (del) { // 删除必须先于整卡点击处理，且阻止冒泡导致的误记录
      e.stopPropagation();
      const i = Number(del.dataset.delquick);
      const items = getQuickItems();
      const item = items[i];
      if (!item) return;
      const ok = await confirmSheet({ title: '删除快捷项', text: `删除「${item.label}」？`, danger: true });
      if (ok) { items.splice(i, 1); saveQuickItems(items); rerender(); }
      return;
    }

    const t = e.target.closest('[data-act],[data-quick],[data-addquick],[data-undo],[data-edit]');
    if (!t) return;

    if (t.dataset.addquick) { openAddQuickSheet(); return; }

    if (t.dataset.edit) { openEditIntakeSheet(Number(t.dataset.edit)); return; }

    if (t.dataset.quick != null) {
      const h = getQuickItems()[Number(t.dataset.quick)];
      if (!h) return;
      // 快捷项是"一点就写数据"，误触代价高 → 记录前二次确认（v1 也是这样）
      const ok = await confirmSheet({
        title: '记录快捷项',
        text: `记录「${h.label}」${round1(h.kcal)} kcal？`,
        okText: '记录',
      });
      if (!ok) return;
      try {
        recordIntake(h.raw);
        toast(`已记录 ${h.label} ${round1(h.kcal)} kcal`, 'success');
        rerender();
      } catch (err) { toast(err.message, 'error'); }
      return;
    }

    const act = t.dataset.act;
    if (act === 'hardRefresh') { await hardRefresh(); return; }
    if (act === 'intake') { openIntakeSheet(); return; }
    if (act === 'weight') { openWeightSheet(); return; }
    if (act === 'stopAlloc') {
      const a = getStore().allocation.find(x => String(x.id) === String(t.dataset.id) && x.status === 'open');
      if (!a) return;
      try {
        const r = stopAllocation(a.id);
        toast(`已分摊 ${r.days} 天，每天 ${round1(r.perDay)} kcal`, 'success');
        rerender();
      } catch (err) { toast(err.message, 'error'); }
      return;
    }
    if (t.dataset.undo) {
      // 显式点「撤销」按钮要二次确认；左滑两次触发时 swipeFiredUndo=true，跳过弹窗（两次滑动本身即确认）
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
        const rec = undoIntake(Number(t.dataset.undo));
        toast(`已撤销 ${round1(rec.kcal)} kcal`, 'success');
        rerender();
      } catch (err) { toast(err.message, 'error'); }
    }
  });

  // —— 今日台账：向左滑动两次撤销（触摸与鼠标拖拽都支持）——
  // 第一次滑过阈值 → 行停在 -88px 并显示「再滑一次撤销」；4 秒内第二次滑过阈值 → 执行撤销。
  // 垂直滚动优先（|dx| 不超过 |dy| 就放弃接管），不会干扰页面滚动。
  const SWIPE_TRIGGER = 56;   // 触发阈值 px
  const SWIPE_OPEN = 88;      // 第一次滑够后停住的位移
  let swipe = null;           // { row, wrap, startX, startY, dx, horizontal }
  let armedRow = null;        // 已进入「再滑一次」状态的行
  let armedTimer = null;

  const clearArmed = (resetTransform) => {
    if (armedTimer) { clearTimeout(armedTimer); armedTimer = null; }
    if (armedRow) {
      armedRow.classList.remove('is-swiping');
      armedRow.style.transform = '';
      const w = armedRow.closest('.swipe-wrap');
      if (w) w.classList.remove('is-armed');
    }
    armedRow = null;
  };

  container.addEventListener('pointerdown', (e) => {
    const row = e.target.closest('.swipe-wrap .list__row[data-rec-id]');
    if (!row) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    swipe = { row, wrap: row.closest('.swipe-wrap'), startX: e.clientX, startY: e.clientY, dx: 0, horizontal: false };
  });

  container.addEventListener('pointermove', (e) => {
    if (!swipe) return;
    const dx = e.clientX - swipe.startX;
    const dy = e.clientY - swipe.startY;
    if (!swipe.horizontal) {
      if (Math.abs(dx) < 8) return;
      if (Math.abs(dx) <= Math.abs(dy)) { swipe = null; return; } // 判定为垂直滚动
      swipe.horizontal = true;
      swipe.row.classList.add('is-swiping');
    }
    swipe.dx = Math.min(0, dx);
    const offset = Math.max(swipe.dx, -(SWIPE_OPEN + 20));
    swipe.row.style.transform = `translateX(${offset}px)`;
    if (e.cancelable) e.preventDefault();
  }, { passive: false });

  const endSwipe = () => {
    if (!swipe) return;
    const { row, wrap, dx } = swipe;
    swipe = null;
    row.classList.remove('is-swiping');
    // 只要发生了水平位移，就吞掉紧随其后的 click（含点在「撤销」上起手的情况）
    if (dx < -8) suppressClickUntil = Date.now() + 500;
    if (dx <= -SWIPE_TRIGGER) {
      if (armedRow !== row) {
        // 第一次滑够 → 进入待确认状态
        clearArmed(false);
        armedRow = row;
        row.style.transform = `translateX(-${SWIPE_OPEN}px)`;
        if (wrap) wrap.classList.add('is-armed');
        armedTimer = setTimeout(() => clearArmed(false), 4000);
        return;
      }
      // 第二次滑够 → 真正撤销：标记跳过 confirmSheet（两次滑动即确认），复用按钮的撤销分支
      clearArmed(false);
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
    if (armedRow === row) clearArmed(false);
  };
  container.addEventListener('pointerup', endSwipe);
  container.addEventListener('pointercancel', () => {
    if (!swipe) return;
    swipe.row.classList.remove('is-swiping');
    swipe.row.style.transform = armedRow === swipe.row ? `translateX(-${SWIPE_OPEN}px)` : '';
    swipe = null;
  });

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

function renderTab(tab, body) {
  if (tab === 'manual') {
    body.innerHTML = `
      <input class="input" id="intakeInput" placeholder="如 739，330 / 739kj / 6个蛋 / -500（冲销）" autocomplete="off">
      <div class="preview" id="intakePreview"></div>
      <div class="hint">可用格式：739，330（kj/100g,克）· 739kj · 6个蛋 · 一份烩面 · 烩面x2 · 6个蛋➕2个橘子</div>
      <div class="hint" style="color:var(--text-2)">想<b>冲销 / 纠错</b>就填<b>负数</b>：-500 表示从当天扣掉 500 kcal（总额会真的减少，可以是负的）</div>
      <div class="chips">
        <button class="chip" data-fill="739，330">739，330</button>
        <button class="chip" data-fill="739kj">739kj</button>
        <button class="chip" data-fill="6个蛋">6个蛋</button>
        <button class="chip" data-fill="一份烩面">一份烩面</button>
        <button class="chip" data-fill="243kj，2500g">243kj，2500g</button>
        <button class="chip" data-fill="-500">-500 冲销</button>
      </div>
      <button class="btn btn--primary btn--block" id="submitIntake">记录</button>
      <button class="btn btn--ghost btn--block" id="submitAlloc">作为待分摊（大包装 / 多日量）</button>
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
    document.getElementById('submitAlloc').addEventListener('click', () => {
      const v = inp.value.trim();
      if (!v) return;
      try {
        const parsed = parseInput(v);
        // kcal 优先；解析结果没有 kcal 时用 kJ/4.184 兜底
        const kcal = parsed.kcal !== undefined ? parsed.kcal : parsed.kj / 4.184;
        if (!(kcal > 0)) throw new Error('待分摊需要能算出热量的输入');
        const created = createAllocationFromKcal(kcal);
        toast(`已创建待分摊：${round1(created.total_kcal)} kcal`, 'success');
        closeSheet();
        rerender();
      } catch (e) { toast(e.message, 'error'); }
    });
    setTimeout(() => inp.focus(), 60);
    return;
  }

  if (tab === 'history') {
    const hist = [...getStore().intake_history]
      .sort((a, b) => (b.use_count || 0) - (a.use_count || 0) || String(b.last_used_at || '').localeCompare(String(a.last_used_at || '')))
      .slice(0, 20);
    body.innerHTML = hist.length === 0
      ? `<div class="empty"><div class="empty__text">还没有历史记录</div></div>`
      : `<div class="list">${hist.map(h => `
          <div class="list__row">
            <div class="list__main">
              <div class="list__title">${esc(h.raw_input)}</div>
              <div class="list__meta">用过 ${h.use_count || 0} 次</div>
            </div>
            <div class="list__value">${round1(h.kcal)}</div>
            <button class="list__action" data-pick="${esc(h.raw_input)}">记录</button>
          </div>`).join('')}</div>`;
    body.querySelectorAll('[data-pick]').forEach(b => b.addEventListener('click', () => {
      try {
        recordIntake(b.dataset.pick);
        toast('已记录', 'success');
        closeSheet();
        rerender();
      } catch (e) { toast(e.message, 'error'); }
    }));
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
            <div class="list__row">
              <div class="list__main">
                <div class="list__title">${esc(f.name)}</div>
                <div class="list__meta">每份 ${f.unit_weight}g · ${f.unit_kcal} kcal</div>
              </div>
              ${[1, 2, 3, 5].map(n => `<button class="chip" data-food="${esc(f.name)}" data-n="${n}">${n}</button>`).join('')}
            </div>`).join('');
    };
    paint('');
    document.getElementById('foodSearch').addEventListener('input', e => paint(e.target.value));
    list.addEventListener('click', (e) => {
      const b = e.target.closest('[data-food]');
      if (!b) return;
      try {
        recordIntake(`${b.dataset.n}个${b.dataset.food}`);
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
          recordIntake(h.raw);
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
