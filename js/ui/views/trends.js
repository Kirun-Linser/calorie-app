import { getAppState, getDailyRecord, getWeights, getStore, upsertDailyRecord } from '../../core/db.js';
import { predictWeight } from '../../domain/weight.js';
import { getRangeSummary, reopenDay } from '../../domain/state.js';
import { round1, percentOfDaily } from '../../domain/parser.js';
import { lastNDates, weekday } from '../../core/date.js';
import { toast, openSheet, closeSheet, confirmSheet, esc } from '../components.js';
import { syncDayTotal } from '../../domain/adjust.js';
import { renderWeightTrend, renderWeekBars } from '../../ui/charts.js';

const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

let currentRange = 'week';

// 历史每日列表的「展开全部」状态。
// 为什么要模块级：rerender() 会重建整个趋势页 DOM，
// 状态若放在渲染函数里的局部变量，一重绘就退回 30 行。
// ⚠️ 2026-11-09 位置很关键：必须在 render() **之前**声明。
//    最初写在了 render() 之后（247 行），而 render() 在 148 行就读取它
//    → TDZ（暂时性死区）ReferenceError，而 `node --check` 查不出来（见错题本）。
let historyExpanded = false;

export function render() {
  const state = getAppState();
  const date = state.logical_date;
  const weights = getWeights();
  const pred = predictWeight(state.user_profile ? JSON.parse(state.user_profile) : null);
  const container = document.createElement('div');
  container.className = 'view';
  container.innerHTML = `
    <div class="view__head"><h1 class="view__title">趋势</h1></div>
    <div class="trend-range segmented">
      <button class="segmented__item" data-range="week">本周</button>
      <button class="segmented__item" data-range="month">本月</button>
      <button class="segmented__item" data-range="all">全部</button>
    </div>
    <div class="card">
      <div class="card__head"><span class="card__title">体重</span></div>
      <div class="card__body">
        ${pred
          ? `<div class="trend-weight-sum">当前 <b>${round1(pred.latest_jin)}</b> 斤 · 预测下月 <b>${round1(pred.predicted_jin)}</b> 斤 <span class="trend-weight-unc">(±${pred.uncertainty_kg}kg)</span></div>
             <div class="chart" id="weightChart"></div>`
          /* ⚠️ 2026-11-05 截图实测：无体重数据时这里同时显示「暂无体重数据」和
             图表里的「至少记录 2 次才能看趋势」，**两条重复提示 + 一整个 120px 的
             图表占位**，把「本周摄入」整块推出首屏（实测空白约 400px）。
             改为：数据不足时只给一条紧凑提示，不渲染图表容器。 */
          : `<div class="trend-weight-empty">还没有体重记录。在「今日」页点「记体重」记 2 次以上，这里就会出现趋势线和下月预测。</div>`}
      </div>
      <div class="card__foot"><button class="btn btn--sm" data-act="weightHistory">体重历史</button></div>
    </div>
    <div class="card">
      <div class="card__head"><span class="card__title" id="rangeTitle">本周摄入</span></div>
      <div class="card__body">
        <div class="chart" id="rangeChart"></div>
        <div class="chart__legend" id="rangeLegend"></div>
        <div class="trend-summary" id="rangeSummary"></div>
      </div>
      <div class="card__foot"><button class="btn btn--sm btn--primary" data-act="rangeSummary">查看总结</button></div>
    </div>
    <div class="card">
      <div class="card__head"><span class="card__title">历史每日</span></div>
      <div class="card__body" id="historyList"></div>
    </div>
  `;
  // weight trend
  const points = weights.map(w => ({ jin: w.jin, at: w.created_at }));
  const wc = container.querySelector('#weightChart');
  if (wc) renderWeightTrend(wc, points, pred ? { prediction: { jin: pred.predicted_jin, uncertaintyKg: pred.uncertainty_kg, days: 30 } } : {});

  function paintRange(range) {
    currentRange = range;
    container.querySelectorAll('[data-range]').forEach(b => b.classList.toggle('is-active', b.dataset.range === range));
    const s = getRangeSummary(range);
    const title = container.querySelector('#rangeTitle');
    if (title) title.textContent = s.label + '摄入';

    // bars
    const chart = container.querySelector('#rangeChart');
    let days = s.days;
    let windowLabel = '';
    if (range === 'all') {
      // show last 30 days window
      const allDays = s.days;
      const tail = allDays.slice(-30);
      days = tail;
      if (allDays.length > 0) {
        const first = tail[0].logical_date.slice(5);
        const last = tail[tail.length - 1].logical_date.slice(5);
        windowLabel = `显示 ${first} ~ ${last}（最近 ${tail.length} 天）`;
      }
    }
    if (chart) {
      if (days.length === 0) {
        chart.innerHTML = '<div class="empty"><div class="empty__text">暂无数据</div></div>';
      } else {
        const barDays = days.map(d => ({ date: d.logical_date, kcal: d.total_kcal, target: d.target_kcal, isToday: d.logical_date === date }));
        renderWeekBars(chart, barDays, { compact: days.length > 14 });
      }
    }
    const legend = container.querySelector('#rangeLegend');
    if (legend) {
      if (s.day_count === 0) legend.textContent = s.label + '暂无记录';
      else legend.textContent = `${s.day_count} 天有记录 · 合计 ${round1(s.total_kcal)} kcal · 超标 ${s.over_target_days} 天${windowLabel ? ' · ' + windowLabel : ''}`;
    }
    const summary = container.querySelector('#rangeSummary');
    if (summary) {
      if (s.day_count === 0) {
        summary.innerHTML = `<div class="trend-empty">${s.label}暂无记录</div>`;
      } else {
        const span = s.start_date && s.end_date ? (s.start_date === s.end_date ? s.start_date : `${s.start_date} ~ ${s.end_date}`) : '';
        // 日均与目标的比较：两处都要 round1，且都用 target_kcal（区间内出现最多的那个目标）
        const diff = round1(Math.abs(s.avg_kcal - s.target_kcal));
        const cmpText = s.avg_kcal > s.target_kcal ? '比目标高' : '比目标低';
        // min_day 由 getRangeSummary 保证：有 recordedDays 时与 max_day 同时存在
        const extremes = s.max_day
          ? `<div class="trend-extremes">
               <span class="trend-extreme-item">最高 <b>${s.max_day.date.slice(5)}</b> ${round1(s.max_day.kcal)} kcal</span>
               <span class="trend-extreme-item">最低 <b>${s.min_day.date.slice(5)}</b> ${round1(s.min_day.kcal)} kcal</span>
             </div>`
          : '';
        summary.innerHTML = `
          <div class="trend-range-label">${span}</div>
          <div class="trend-stat-grid">
            <div class="stat"><div class="stat__label">合计</div><div class="stat__value"><span class="stat__num">${round1(s.total_kcal)}</span><span class="stat__unit">kcal</span></div></div>
            <div class="stat"><div class="stat__label">日均 · 有记录 ${s.day_count} 天</div><div class="stat__value"><span class="stat__num">${round1(s.avg_kcal)}</span><span class="stat__unit">kcal</span></div></div>
            <div class="stat"><div class="stat__label">超标 / 未超 / 无记录</div><div class="stat__value ${s.over_target_days > 0 ? 'is-over' : ''}"><span class="stat__num">${s.over_target_days}/${s.under_target_days}/${s.no_record_days}</span><span class="stat__unit">天</span></div></div>
          </div>
          ${extremes}
          <div class="trend-conclusion">${s.label} <b>${s.day_count}</b> 天有记录，日均 <b>${round1(s.avg_kcal)}</b> kcal，${cmpText} <b>${diff}</b> kcal（目标 ${s.target_kcal}）</div>
        `;
      }
    }
  }

  container.querySelectorAll('[data-range]').forEach(b => b.addEventListener('click', () => paintRange(b.dataset.range)));
  paintRange('week');

  // history list
  // ⚠️ 2026-11-09 用户要求「列表显示所有有天数的日子」：
  // 原来只筛 `r.closed_at`（已日结），于是「未结束但有记录」的日子
  // （用真实备份实测有 3 天：10-25、10-26、11-08）在列表里根本看不到、也无法点「改」。
  // 现在改为：**有天数的日子**都列出来。
  //   「有天数」= 已日结 OR 当天总额 > 0 OR 当天有摄入明细
  // 刻意**排除纯空日**（今天刚建的空壳日 total=0、无明细、未结束）——
  //   它没有任何信息，列出来只是噪音。
  const store = getStore();
  const intakeCountByDate = {};
  (store.intake_records || []).forEach(r => {
    intakeCountByDate[r.logical_date] = (intakeCountByDate[r.logical_date] || 0) + 1;
  });
  const allEligible = (store.daily_records ? Object.values(store.daily_records) : [])
    .filter(r => r.closed_at || Number(r.total_kcal) > 0 || (intakeCountByDate[r.logical_date] || 0) > 0)
    .sort((a, b) => b.logical_date.localeCompare(a.logical_date));
  // 默认只显示最近 30 天；「展开全部」后再显示所有（用户 2026-11-09 选定）。
  const HISTORY_PAGE = 30;
  const hiddenCount = Math.max(0, allEligible.length - HISTORY_PAGE);
  const allDays = historyExpanded ? allEligible : allEligible.slice(0, HISTORY_PAGE);
  const hl = container.querySelector('#historyList');
  const expandBtn = hiddenCount > 0
    ? `<button class="btn btn--ghost btn--block hist-expand" data-act="expandHistory">
         ${historyExpanded ? '收起，只看最近 30 天' : `展开全部（还有 ${hiddenCount} 天）`}
       </button>`
    : '';
  hl.innerHTML = allDays.length ? `<div class="list">${allDays.map(r => {
    const pct = percentOfDaily(r.total_kcal, r.target_kcal);
    const isOpen = !r.closed_at;
    // 状态标注：未结束的标「进行中」（与周/月回顾里的口径一致）
    const status = isOpen
      ? '<span class="hist-status hist-status--open">进行中</span>'
      : (r.close_type === 'manual' ? '<span class="hist-status">手动结束</span>' : '');
    return `<div class="list__row${isOpen ? ' is-open-day' : ''}">
      <div class="list__main">
        <div class="list__title">${r.logical_date} <span class="list__meta">${WEEKDAYS[weekday(r.logical_date)]}</span>${status}</div>
        <div class="list__meta">目标 ${r.target_kcal}</div>
      </div>
      <div class="list__value ${pct > 100 ? 'is-over' : ''}">${round1(r.total_kcal)}</div>
      <button class="btn btn--sm" data-edit-day="${r.logical_date}">改</button>
    </div>`;
  }).join('')}</div>${expandBtn}` : '<div class="empty"><div class="empty__text">暂无历史</div></div>';

  container.addEventListener('click', async (e) => {
    const editBtn = e.target.closest('[data-edit-day]');
    if (editBtn) { openEditDaySheet(editBtn.dataset.editDay); return; }
    const t = e.target.closest('[data-act]');
    if (t) {
      if (t.dataset.act === 'expandHistory') {
        historyExpanded = !historyExpanded;
        if (window.app && window.app.rerender) window.app.rerender();
        return;
      }
      if (t.dataset.act === 'rangeSummary') {
        openRangeSummarySheet(currentRange);
        return;
      }
      if (t.dataset.act === 'weightHistory') {
        openWeightHistorySheet();
        return;
      }
    }
  });
  return container;
}

function openRangeSummarySheet(range) {
  const s = getRangeSummary(range);
  const rows = s.days.length ? s.days.map(d => {
    const over = d.has_record && d.total_kcal > d.target_kcal;
    return `<div class="list__row trend-day-row${d.has_record ? '' : ' is-empty'}">
      <div class="list__main">
        <div class="list__title">${d.logical_date.slice(5)} ${WEEKDAYS[weekday(d.logical_date)]}</div>
        <div class="list__meta">${d.has_record ? (d.closed_at ? '已结束' : '进行中') : '无记录'}</div>
      </div>
      <div class="list__value ${over ? 'is-over' : ''}">${d.has_record ? round1(d.total_kcal) + ' / ' + d.target_kcal : '—'}</div>
    </div>`;
  }).join('') : '<div class="trend-empty">暂无数据</div>';
  const span = s.start_date && s.end_date ? (s.start_date === s.end_date ? s.start_date : `${s.start_date} ~ ${s.end_date}`) : '';
  openSheet({
    title: s.label + '总结',
    body: `
      <div class="trend-range-label">${span}</div>
      <div class="trend-stat-grid">
        <div class="stat"><div class="stat__label">合计</div><div class="stat__value"><span class="stat__num">${round1(s.total_kcal)}</span><span class="stat__unit">kcal</span></div></div>
        <div class="stat"><div class="stat__label">日均</div><div class="stat__value"><span class="stat__num">${round1(s.avg_kcal)}</span><span class="stat__unit">kcal</span></div></div>
        <div class="stat"><div class="stat__label">有记录</div><div class="stat__value"><span class="stat__num">${s.day_count}</span><span class="stat__unit">天</span></div></div>
      </div>
      <div class="trend-stat-grid">
        <div class="stat"><div class="stat__label">超标</div><div class="stat__value ${s.over_target_days > 0 ? 'is-over' : ''}"><span class="stat__num">${s.over_target_days}</span><span class="stat__unit">天</span></div></div>
        <div class="stat"><div class="stat__label">未超标</div><div class="stat__value"><span class="stat__num">${s.under_target_days}</span><span class="stat__unit">天</span></div></div>
        <div class="stat"><div class="stat__label">无记录</div><div class="stat__value"><span class="stat__num">${s.no_record_days}</span><span class="stat__unit">天</span></div></div>
      </div>
      ${s.max_day ? `<div class="trend-extremes">
        <span class="trend-extreme-item">最高 <b>${s.max_day.date.slice(5)}</b> ${round1(s.max_day.kcal)} kcal</span>
        <span class="trend-extreme-item">最低 <b>${s.min_day.date.slice(5)}</b> ${round1(s.min_day.kcal)} kcal</span>
      </div>` : ''}
      <div class="section-title">每日详情</div>
      <div class="list">${rows}</div>
    `,
  });
}

function openWeightHistorySheet() {
  const recs = [...getWeights()].sort((a,b) => (b.created_at||'').localeCompare(a.created_at||''));
  const rows = recs.map((r,i) => {
    const prev = recs[i+1];
    const d = prev ? ((r.kg - prev.kg)*2) : null;
    const diff = d == null ? '' : (Math.abs(d) < 0.05 ? '持平' : (d>0?'+':'')+round1(d)+' 斤');
    const cls = d == null ? 'trend-diff--flat' : (d > 0.05 ? 'trend-diff--up' : (d < -0.05 ? 'trend-diff--down' : 'trend-diff--flat'));
    return `<div class="list__row trend-weight-row"><div class="list__main"><div class="list__title">${(r.created_at||'').slice(0,16).replace('T',' ')}</div><div class="list__meta">${round1(r.jin)} 斤 · ${round1(r.kg)} kg</div></div><div class="list__value trend-diff ${cls}">${esc(diff)}</div></div>`;
  }).join('');
  openSheet({ title: '体重历史', body: recs.length ? `<div class="list">${rows}</div>` : '<div class="trend-empty">暂无体重记录</div>' });
}

function openEditDaySheet(date) {
  const rec = getDailyRecord(date);
  if (!rec) { toast('该天暂无记录', 'error'); return; }
  const wd = WEEKDAYS[weekday(date)];
  const isClosed = !!rec.closed_at;
  const body = `
    <div class="field"><div class="field__label">当天总热量（kcal）</div>
      <input class="input" id="editDayKcal" type="number" step="0.1" inputmode="decimal" value="${round1(rec.total_kcal)}"></div>
    <div class="field"><div class="field__label">当天目标（kcal）</div>
      <input class="input" id="editDayTarget" type="number" step="1" inputmode="numeric" value="${rec.target_kcal}"></div>
  `;
  const footer = `
    <div class="trend-editday-actions">
      <button class="btn btn--primary btn--block" id="editDaySave">保存</button>
      <div class="trend-editday-danger">
        <!-- ⚠️ 2026-11-05：这两个动作后果都不轻（尤其"重新打开"会把逻辑日回退到指定日期），
             原来只是灰底按钮、没有说明。补一行后果提示，点之前就知道会发生什么。 -->
        <p class="trend-editday-hint">${isClosed
          ? '重新打开 = 把逻辑日退回这一天，之后的记录仍保留。'
          : '标记结束 = 固定当天合计，之后仍可修改记录。'}</p>
        <button class="btn btn--block ${isClosed ? 'btn--ghost' : 'btn--danger'}" id="editDayToggle">${isClosed ? '重新打开该天' : '标记为已结束'}</button>
        <button class="btn btn--ghost btn--block" id="editDayClose">取消</button>
      </div>
    </div>
  `;
  openSheet({ title: `修改 ${date}（${wd}）`, body, footer });
  setTimeout(() => {
    const kcalEl = document.getElementById('editDayKcal');
    const targetEl = document.getElementById('editDayTarget');
    const save = document.getElementById('editDaySave');
    const toggle = document.getElementById('editDayToggle');
    const close = document.getElementById('editDayClose');
    if (close) close.onclick = () => closeSheet();
    if (save) save.onclick = () => {
      const kcal = parseFloat(kcalEl.value);
      const target = parseInt(targetEl.value, 10);
      if (!Number.isFinite(kcal) || kcal < 0 || kcal > 10000) { toast('热量需在 0-10000 之间', 'error'); return; }
      if (!Number.isFinite(target) || target < 500 || target > 8000) { toast('目标需在 500-8000 之间', 'error'); return; }

      // ⚠️ 2026-11-09 修「改了保存后数字对不上」：
      // 原来只写 daily.total_kcal，不动 intake_records 明细。
      // 后果①：总额 8888 与明细合计 3203.92 割裂；
      // 后果②：用户之后再记一笔 → recalcDaily 按明细重算 → 8888 被覆盖丢失。
      // 修法（用户选定）：先补齐一条「手动调整」明细，让明细合计严格等于新总额；
      // 再写 daily 记录。之后任何重算都能还原用户想要的数字。
      const sync = syncDayTotal(date, kcal);
      upsertDailyRecord(date, { total_kcal: kcal, target_kcal: target });
      toast(sync.adjusted
        ? `已保存，并补一条「${sync.record.label}」（明细合计已对齐）`
        : '已保存', 'success');
      closeSheet();
      if (window.app && window.app.rerender) window.app.rerender();
    };
    if (toggle) toggle.onclick = async () => {
      if (isClosed) {
        const ok = await confirmSheet({ title: '重新打开该天', text: `将 ${date} 重新变为可编辑的当天（日期会回退到这天）。结束时自动建出来的空日会被清除，有数据的天保留。`, okText: '重新打开', danger: true });
        if (!ok) return;
        try { const r = reopenDay(date); toast(`已回到 ${r.logical_date}，可以修改那天的记录`, 'success'); }
        catch (err) { toast('重开失败：' + (err && err.message ? err.message : '未知错误'), 'error'); return; }
      } else {
        const ok = await confirmSheet({ title: '标记为已结束', text: `把 ${date} 标记为已结束（手动）。今日总计会固定下来，之后仍可在此处修改记录。`, okText: '结束该天', danger: true });
        if (!ok) return;
        upsertDailyRecord(date, { closed_at: new Date().toISOString(), close_type: 'manual' });
        toast('已标记结束', 'success');
      }
      closeSheet();
      if (window.app && window.app.rerender) window.app.rerender();
    };
  }, 0);
}

