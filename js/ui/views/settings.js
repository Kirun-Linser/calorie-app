import {
  getAppState, setAppState, getStore,
  searchFood, addFood, getFood, updateFood, deleteFood,
  exportBackup, normalizeBackup, importBackup
} from '../../core/db.js';
import { fmtDate } from '../../core/date.js';
import { setTargetKcal } from '../../domain/engine.js';
import { closeDay } from '../../domain/state.js';
import { round1 } from '../../domain/parser.js';
import { toast, openSheet, confirmSheet, esc } from '../components.js';

export function render() {
  const state = getAppState();
  const p = state.user_profile ? JSON.parse(state.user_profile) : { gender: 'male', height_cm: 175, age: 30, activity_factor: 1.375 };
  const container = document.createElement('div');
  container.className = 'view';
  container.innerHTML = `
    <div class="view__head"><h1 class="view__title">设置</h1></div>
    <div class="card">
      <div class="card__head"><span class="card__title">每日目标</span></div>
      <div class="card__body"><input class="input" id="targetInput" type="number" value="${state.target_kcal}"></div>
      <div class="card__foot"><button class="btn btn--primary btn--sm" data-act="saveTarget">保存</button></div>
    </div>
    <div class="card">
      <div class="card__head"><span class="card__title">个人档案</span></div>
      <div class="card__body">
        <div class="field"><label class="field__label">性别</label><div class="chips">
          <button class="chip ${p.gender==='male'?'is-active':''}" data-gender="male">男</button>
          <button class="chip ${p.gender==='female'?'is-active':''}" data-gender="female">女</button>
        </div></div>
        <div class="field"><label class="field__label">身高 <span id="heightVal">${p.height_cm}</span> cm</label>
          <input type="range" min="140" max="210" value="${p.height_cm}" id="heightRange" class="input"></div>
        <div class="field"><label class="field__label">年龄 <span id="ageVal">${p.age}</span></label>
          <input type="range" min="14" max="80" value="${p.age}" id="ageRange" class="input"></div>
        <div class="field"><label class="field__label">活动量</label><div class="chips">
          ${[['久坐',1.2],['轻度',1.375],['中度',1.55],['重度',1.725]].map(([l,f])=>`<button class="chip ${p.activity_factor==f?'is-active':''}" data-act-factor="${f}">${l}</button>`).join('')}
        </div></div>
        <button class="btn btn--primary btn--block" data-act="saveProfile">保存档案</button>
      </div>
    </div>
    <div class="card">
      <div class="card__head"><span class="card__title">食物词典</span></div>
      <div class="card__body"><div class="list__meta" id="foodCount"></div></div>
      <div class="card__foot"><button class="btn btn--sm" data-act="manageFoods">管理</button></div>
    </div>
    <div class="card">
      <div class="card__head"><span class="card__title">当日</span></div>
      <div class="card__body">
        <div style="font-size:13px;color:var(--text-2);line-height:1.6;">
          每天 <b>04:00</b> 会自动结算，通常不需要手动操作。<br>
          下面这个按钮只在你想<b>提前结束今天</b>时用（已移到设置页，避免误触）。
        </div>
        <button class="btn btn--block" data-act="closeDay" style="margin-top:10px;">手动结束今天</button>
      </div>
    </div>
    <div class="card">
      <div class="card__head"><span class="card__title">数据</span></div>
      <div class="card__body">
        <button class="btn btn--block" data-act="exportJson">导出 JSON（完整备份）</button>
        <button class="btn btn--block" data-act="exportCsv">导出 CSV（每日记录）</button>
        <label class="btn btn--block" for="importFile">导入 JSON（覆盖当前数据）</label>
        <input type="file" id="importFile" accept=".json,application/json" hidden>
        <button class="btn btn--block" data-act="clearAll" style="color:var(--danger)">清空所有数据</button>
      </div>
    </div>
    <div class="card"><div class="card__body"><div class="empty"><div class="empty__text">关于：热量记录 v2</div></div></div></div>
  `;
  // 局部更新 range 数值（不重建）
  const heightRange = container.querySelector('#heightRange');
  const heightVal = container.querySelector('#heightVal');
  if (heightRange) heightRange.oninput = () => { heightVal.textContent = heightRange.value; };
  const ageRange = container.querySelector('#ageRange');
  const ageVal = container.querySelector('#ageVal');
  if (ageRange) ageRange.oninput = () => { ageVal.textContent = ageRange.value; };
  let draft = { ...p };
  container.querySelectorAll('[data-gender]').forEach(b => b.onclick = () => { draft.gender = b.dataset.gender; container.querySelectorAll('[data-gender]').forEach(x=>x.classList.toggle('is-active', x===b)); });
  container.querySelectorAll('[data-act-factor]').forEach(b => b.onclick = () => { draft.activity_factor = parseFloat(b.dataset.actFactor); container.querySelectorAll('[data-act-factor]').forEach(x=>x.classList.toggle('is-active', x===b)); });
  // 食物词典条目数（进页面时填一次；抽屉里增删改后由 openFoodManager 回调刷新）
  const foodCountEl = container.querySelector('#foodCount');
  const paintFoodCount = () => {
    if (foodCountEl) foodCountEl.textContent = `共 ${getStore().food_dict.length} 项`;
  };
  paintFoodCount();

  // JSON 导入：同时兼容 v1（daily_records 为数组）与 v2（为对象）。
  // 快捷项来自备份顶层 quick_items；老备份没有该字段时保留现有快捷项，不清空。
  // 只写新键，不碰旧键 —— 导入失败也不会破坏现有数据。
  const importInput = container.querySelector('#importFile');
  if (importInput) importInput.addEventListener('change', async (ev) => {
    const file = ev.target.files && ev.target.files[0];
    if (!file) return;
    try {
      const parsed = JSON.parse(await file.text());
      const { store, quickItems } = normalizeBackup(parsed); // 先校验再弹确认框（不写盘）
      const dayCount = Object.keys(store.daily_records || {}).length;
      const quickText = quickItems
        ? `含 ${quickItems.length} 个快捷项`
        : '备份不含快捷项，现有快捷项会保留';
      const ok = await confirmSheet({
        title: '导入备份',
        text: `将用该文件覆盖当前数据（${dayCount} 天记录；${quickText}）。建议先导出一次当前数据再导入。`,
        danger: true,
        okText: '覆盖导入',
      });
      if (!ok) return;
      importBackup(parsed);
      toast('导入成功，正在刷新…', 'success');
      setTimeout(() => location.reload(), 700);
    } catch (err) {
      toast('导入失败：' + (err && err.message ? err.message : '文件无法解析'), 'error');
    } finally {
      ev.target.value = ''; // 允许再次选择同一个文件
    }
  });

  container.addEventListener('click', async (e) => {
    const t = e.target.closest('[data-act]');
    if (!t) return;
    if (t.dataset.act === 'saveTarget') {
      const v = parseInt(container.querySelector('#targetInput').value,10);
      if (!v || v < 500 || v > 8000) { toast('请输入 500-8000', 'error'); return; }
      setTargetKcal(v); toast('目标已保存', 'success');
    } else if (t.dataset.act === 'saveProfile') {
      draft.height_cm = parseInt(container.querySelector('#heightRange').value,10);
      draft.age = parseInt(container.querySelector('#ageRange').value,10);
      setAppState({ user_profile: JSON.stringify(draft) });
      toast('档案已保存', 'success');
    } else if (t.dataset.act === 'closeDay') {
      // 手动日结：从今日页移到这里（主界面误触会提前结束当天），并强制二次确认
      // BUG-1 修复：必须用逻辑日（state.logical_date），不是真实今天；
      // 否则 logical_date 已经推进到明天时，手动结束会去关「真实今天」（已 closed → skipped），
      // 真正的逻辑今天永远关不掉。
      const st = getAppState();
      const d = st.logical_date;
      const ok = await confirmSheet({
        title: '结束今天',
        text: `把今天（${d}）标记为已结束？今日总计会固定下来，之后仍可修改记录。`,
        danger: true,
        okText: '结束今天',
      });
      if (!ok) return;
      const r = closeDay(d, 'manual');
      if (r.skipped) {
        toast(`${d} 已经结束过了`, 'error');
      } else {
        toast(r.summaryTriggered ? `已结束 ${d} · 触发周总结` : `已结束 ${d}`, 'success');
        setTimeout(() => location.reload(), 700);
      }
    } else if (t.dataset.act === 'manageFoods') {
      openFoodManager(paintFoodCount);
    } else if (t.dataset.act === 'exportJson') {
      // 完整备份 = v2 store + 顶层 quick_items（快捷项在独立键里，必须显式合并）
      const data = JSON.stringify(exportBackup());
      const blob = new Blob([data], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = `calorie-backup-${fmtDate(new Date())}.json`; a.click();
      URL.revokeObjectURL(url); toast('已导出（含快捷项）', 'success');
    } else if (t.dataset.act === 'exportCsv') {
      const store = getStore();
      const rows = [['日期','摄入(kcal)','目标(kcal)']];
      (store.daily_records ? Object.values(store.daily_records) : []).sort((a,b)=>a.logical_date.localeCompare(b.logical_date)).forEach(r => rows.push([r.logical_date, round1(r.total_kcal), r.target_kcal]));
      const csv = '\ufeff' + rows.map(r=>r.join(',')).join('\n');
      const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = `calorie-daily-${fmtDate(new Date())}.csv`; a.click();
      URL.revokeObjectURL(url); toast('已导出 CSV', 'success');
    } else if (t.dataset.act === 'clearAll') {
      const ok = await confirmSheet({ title: '清空数据', text: '确定清空所有数据？不可恢复。', danger: true, okText: '清空' });
      if (ok) { localStorage.clear(); toast('已清空', 'success'); setTimeout(() => location.reload(), 800); }
    }
  });
  return container;
}
// ===== 食物词典管理抽屉 =====
// 三种形态在同一抽屉内切换（列表 / 编辑 / 新增），不叠第二层 sheet。
function openFoodManager(onChange) {
  const body = () => document.getElementById('fdBody');
  const notify = () => { if (typeof onChange === 'function') onChange(); };
  let paintForm; // 前向引用：paintList 的事件里会调它

  const paintList = () => {
    const host = body();
    if (!host) return;
    host.innerHTML = `
      <input class="input" id="fdSearch" placeholder="搜索食物…" autocomplete="off">
      <div class="list" id="fdList"></div>
      <button class="btn btn--primary btn--block" id="fdAdd">＋ 新增食物</button>
    `;
    const list = document.getElementById('fdList');
    const paint = (q) => {
      const foods = searchFood(q).slice(0, 30);
      list.innerHTML = foods.length
        ? foods.map(f => `
          <div class="list__row">
            <div class="list__main">
              <div class="list__title">${esc(f.name)}</div>
              <div class="list__meta">每份 ${f.unit_weight}g · ${f.unit_kcal} kcal</div>
            </div>
            <button class="list__action" data-fedit="${esc(f.name)}">改</button>
            <button class="list__action" data-fdel="${esc(f.name)}">删</button>
          </div>`).join('')
        : `<div class="empty"><div class="empty__text">没有匹配的食物</div></div>`;
    };
    paint('');
    document.getElementById('fdSearch').addEventListener('input', e => paint(e.target.value));
    document.getElementById('fdAdd').addEventListener('click', () => paintForm('add'));
    list.addEventListener('click', async (e) => {
      const edit = e.target.closest('[data-fedit]');
      const del = e.target.closest('[data-fdel]');
      if (edit) { paintForm('edit', edit.dataset.fedit); return; }
      if (del) {
        const name = del.dataset.fdel;
        const ok = await confirmSheet({
          title: '删除食物',
          text: `从词典删除「${name}」？已记录的历史数据不受影响。`,
          danger: true,
          okText: '删除',
        });
        if (!ok) return;
        if (deleteFood(name)) {
          toast(`已删除 ${name}`, 'success');
          notify();
          paintList();
        } else toast('删除失败', 'error');
      }
    });
  };

  paintForm = (mode, name) => {
    const host = body();
    if (!host) return;
    const f = mode === 'edit' ? getFood(name) : null;
    if (mode === 'edit' && !f) { toast('食物不存在', 'error'); paintList(); return; }
    host.innerHTML = `
      <div class="field">
        <div class="field__label">名称</div>
        <input class="input" id="fdName" value="${f ? esc(f.name) : ''}" ${f ? 'readonly' : ''} placeholder="如 自制包子">
      </div>
      <div class="field">
        <div class="field__label">每份重量（克）</div>
        <input class="input" id="fdWeight" type="number" inputmode="decimal" value="${f ? f.unit_weight : ''}" placeholder="100">
      </div>
      <div class="field">
        <div class="field__label">每份热量（kcal）</div>
        <input class="input" id="fdKcal" type="number" inputmode="decimal" value="${f ? f.unit_kcal : ''}" placeholder="200">
      </div>
      ${f ? '<div class="hint">名称不可改 —— 历史记录按名称关联。</div>' : ''}
      <button class="btn btn--primary btn--block" id="fdSave">保存</button>
      <button class="btn btn--quiet btn--block" id="fdBack">取消</button>
    `;
    document.getElementById('fdBack').addEventListener('click', paintList);
    document.getElementById('fdSave').addEventListener('click', () => {
      const nm = document.getElementById('fdName').value.trim();
      const w = parseFloat(document.getElementById('fdWeight').value);
      const k = parseFloat(document.getElementById('fdKcal').value);
      if (!nm) return toast('请输入名称', 'error');
      if (!(w > 0)) return toast('请输入正确的重量', 'error');
      if (!(k > 0)) return toast('请输入正确的热量', 'error');
      if (mode === 'edit') {
        if (!updateFood(name, w, k)) return toast('保存失败', 'error');
        toast(`已更新 ${name}`, 'success');
      } else if (getFood(nm)) {
        if (!updateFood(nm, w, k)) return toast('保存失败', 'error');
        toast(`已更新 ${nm}（同名视为修改）`, 'success');
      } else {
        addFood(nm, w, k);
        toast(`已添加 ${nm}`, 'success');
      }
      notify();
      paintList();
    });
    setTimeout(() => { const n = document.getElementById('fdName'); if (n) n.focus(); }, 50);
  };

  openSheet({ title: '食物词典', body: '<div id="fdBody"></div>' });
  paintList();
}
