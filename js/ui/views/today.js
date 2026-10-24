// views/today.js — 「今日」页
// 功能对齐 v1：记热量（手动/历史/词典/快捷 四入口 + 待分摊）、记体重、日结、快捷项增删、撤销、待分摊管理
import {
  getAppState, getDailyRecord, getIntakeRecordsByDate, getOpenAllocation,
  getWeights, getStore, searchFood, addFood, updateIntakeRecord
} from '../../core/db.js';
import { QUICK_KEY, LEGACY_QUICK, readJSON } from '../../core/store.js';
import { recordIntake, undoIntake, percentOfDaily, recalcDaily } from '../../domain/engine.js';
import { closeDay } from '../../domain/state.js';
import { parseInput, round1 } from '../../domain/parser.js';
import { recordWeight } from '../../domain/weight.js';
import { createAllocation, stopAllocation, undoAllocationBatch } from '../../domain/allocation.js';
import { weekday } from '../../core/date.js';
import { toast, openSheet, closeSheet, confirmSheet, esc } from '../components.js';

const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

// app.js 会挂 window.app，回调里通过它重绘，避免循环 import
const rerender = () => { if (window.app && window.app.rerender) window.app.rerender(); };

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

// ===== 主视图 =====
export function render() {
  const state = getAppState();
  const date = state.logical_date;
  const daily = getDailyRecord(date) || { logical_date: date, total_kcal: 0, target_kcal: state.target_kcal, closed_at: null };
  const pct = percentOfDaily(daily.total_kcal, daily.target_kcal);
  const recs = getIntakeRecordsByDate(date).slice().reverse(); // 最新在上
  const alloc = getOpenAllocation();
  const weights = getWeights();
  const todayWeight = weights.find(w => String(w.created_at).slice(0, 10) === date);
  const quickItems = getQuickItems();

  const container = document.createElement('div');
  container.className = 'view';
  container.innerHTML = `
    <div class="view__head">
      <h1 class="view__title">今日</h1>
      <div class="view__sub">${date} ${WEEKDAYS[weekday(date)]} · 第 ${state.current_day_index} 天</div>
    </div>

    <div class="hero">
      <div class="hero__row">
        <span class="hero__value">${round1(daily.total_kcal)}</span>
        <span class="hero__unit">/ ${daily.target_kcal} kcal</span>
      </div>
      <div class="hero__meta">${round1(pct)}%${pct > 100 ? ' · 已超标' : ''}</div>
      <div class="progress">
        <div class="progress__fill ${pct > 100 ? 'is-over' : pct >= 80 ? 'is-ok' : ''}" style="width:${Math.min(100, Math.max(0, pct))}%"></div>
      </div>
    </div>

    <div class="btn-row">
      <button class="btn btn--primary btn--block" data-act="intake">记热量</button>
      <button class="btn ${todayWeight ? 'btn--ok' : 'btn--ghost'}" data-act="weight">${todayWeight ? '已称 ' + round1(todayWeight.jin) + ' 斤' : '记体重'}</button>
      <button class="btn btn--quiet" data-act="close">日结</button>
    </div>

    ${quickItems.length || true ? `
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
      </div>` : ''}

    ${alloc ? `
      <div class="card">
        <div class="card__body">
          <span class="badge badge--warn">待分摊</span>
          <span style="margin-left:8px">${round1(alloc.total_kcal)} kcal · 起算 ${alloc.start_date}</span>
        </div>
        <div class="card__foot">
          <button class="btn btn--sm btn--ok" data-act="stopAlloc">停止分摊</button>
          <button class="btn btn--sm btn--danger" data-act="undoAlloc" data-batch="${esc(alloc.batch_id)}">撤销分摊</button>
        </div>
      </div>` : ''}

    <div class="card">
      <div class="card__head"><span class="card__title">最近记录</span><span class="card__title" style="color:var(--text-3);font-weight:400">${recs.length} 条</span></div>
      <div class="card__body">
        ${recs.length === 0
          ? `<div class="empty"><div class="empty__text">今天还没记东西</div><div class="empty__action"><button class="btn btn--sm btn--primary" data-act="intake">记第一笔</button></div></div>`
          : `<div class="list">${recs.map(r => `
              <div class="list__row">
                <div class="list__main">
                  <div class="list__title">${esc(r.raw_input)}</div>
                  <div class="list__meta">${String(r.created_at || '').slice(11, 16)}</div>
                </div>
                <div class="list__value">${round1(r.kcal)}</div>
                <button class="list__action" data-edit="${r.id}">改</button>
                ${r.undoable ? `<button class="list__action" data-undo="${r.id}">撤销</button>` : ''}
              </div>`).join('')}</div>`}
      </div>
    </div>
  `;

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
    if (act === 'intake') openIntakeSheet();
    else if (act === 'weight') openWeightSheet();
    else if (act === 'close') {
      const r = closeDay(date, 'manual');
      toast(r.skipped ? '当日已结束' : (r.summaryTriggered ? '已结束 · 触发周总结' : '已结束当日'), 'success');
      rerender();
    } else if (act === 'stopAlloc') {
      const a = getOpenAllocation();
      if (!a) return;
      try {
        const r = stopAllocation(a.id);
        toast(`已分摊 ${r.days} 天，每天 ${round1(r.perDay)} kcal`, 'success');
        rerender();
      } catch (err) { toast(err.message, 'error'); }
    } else if (act === 'undoAlloc') {
      const ok = await confirmSheet({ title: '撤销分摊', text: '撤销本次分摊会删除已分摊的每日记录，确定吗？', danger: true });
      if (ok) {
        try {
          const r = undoAllocationBatch(t.dataset.batch);
          toast(`已撤销 ${r.removedCount} 条分摊记录`, 'success');
        } catch (err) { toast(err.message, 'error'); }
        rerender();
      }
    } else if (t.dataset.undo) {
      try {
        const rec = undoIntake(Number(t.dataset.undo));
        toast(`已撤销 ${round1(rec.kcal)} kcal`, 'success');
        rerender();
      } catch (err) { toast(err.message, 'error'); }
    }
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
      <input class="input" id="intakeInput" placeholder="如 739，330 / 739kj / 6个蛋" autocomplete="off">
      <div class="preview" id="intakePreview"></div>
      <div class="hint">可用格式：739，330（kj/100g,克）· 739kj · 6个蛋 · 一份烩面 · 烩面x2 · 6个蛋➕2个橘子</div>
      <div class="chips">
        <button class="chip" data-fill="739，330">739，330</button>
        <button class="chip" data-fill="739kj">739kj</button>
        <button class="chip" data-fill="6个蛋">6个蛋</button>
        <button class="chip" data-fill="一份烩面">一份烩面</button>
        <button class="chip" data-fill="243kj，2500g">243kj，2500g</button>
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
        const kj = parsed.kj !== undefined ? parsed.kj : parsed.kcal * 4.184;
        const grams = parsed.gram || 0;
        if (!grams) throw new Error('待分摊需要能算出重量的输入（如 739，330）');
        createAllocation(kj, grams);
        toast(`已创建待分摊：${round1(parsed.kcal)} kcal`, 'success');
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
