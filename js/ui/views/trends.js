import { getAppState, getDailyRecord, getWeights, getStore, upsertDailyRecord } from '../../core/db.js';
import { predictWeight } from '../../domain/weight.js';
import { getWeekSummary } from '../../domain/state.js';
import { round1, percentOfDaily } from '../../domain/parser.js';
import { lastNDates, weekday } from '../../core/date.js';
import { toast, openSheet, closeSheet, confirmSheet, esc } from '../components.js';
import { renderWeightTrend, renderWeekBars } from '../../ui/charts.js';

const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

export function render() {
  const state = getAppState();
  const date = state.logical_date;
  const weights = getWeights();
  const pred = predictWeight(state.user_profile ? JSON.parse(state.user_profile) : null);
  const container = document.createElement('div');
  container.className = 'view';
  container.innerHTML = `
    <div class="view__head"><h1 class="view__title">趋势</h1></div>
    <div class="card">
      <div class="card__head"><span class="card__title">体重</span></div>
      <div class="card__body">
        ${pred ? `<div>当前 ${round1(pred.latest_jin)} 斤 · 预测下月 ${round1(pred.predicted_jin)} 斤 (±${pred.uncertainty_kg}kg)</div>` : '<div class="empty"><div class="empty__text">暂无体重数据</div></div>'}
        <div class="chart" id="weightChart"></div>
      </div>
      <div class="card__foot"><button class="btn btn--sm" data-act="weightHistory">体重历史</button></div>
    </div>
    <div class="card">
      <div class="card__head"><span class="card__title">近 7 天摄入</span></div>
      <div class="card__body">
        <div class="chart" id="weekChart"></div>
        <div class="chart__legend" id="weekLegend"></div>
      </div>
      <div class="card__foot"><button class="btn btn--sm btn--primary" data-act="weekSummary">本周总结</button></div>
    </div>
    <div class="card">
      <div class="card__head"><span class="card__title">历史每日</span></div>
      <div class="card__body" id="historyList"></div>
    </div>
  `;
  // weight trend points（有预测时把预测区间一起画进图里）
  const points = weights.map(w => ({ jin: w.jin, at: w.created_at }));
  const wc = container.querySelector('#weightChart');
  if (wc) renderWeightTrend(wc, points, pred ? {
    prediction: { jin: pred.predicted_jin, uncertaintyKg: pred.uncertainty_kg, days: 30 },
  } : {});
  // week bars
  const days = lastNDates(date, 7).map(d => {
    const dr = getDailyRecord(d);
    return { date: d, kcal: dr ? dr.total_kcal : 0, target: dr ? dr.target_kcal : state.target_kcal, isToday: d === date };
  });
  const wk = container.querySelector('#weekChart');
  if (wk) renderWeekBars(wk, days, {});
  // 柱状图下方合计（让"这周怎么样"一眼可读，不用心算）
  const legend = container.querySelector('#weekLegend');
  if (legend) {
    const total = days.reduce((s, d) => s + d.kcal, 0);
    const overCount = days.filter(d => d.kcal > d.target).length;
    const filled = days.filter(d => d.kcal > 0).length;
    legend.textContent = filled === 0
      ? '本周还没有记录'
      : `${filled} 天合计 ${round1(total)} kcal · 超标 ${overCount} 天`;
  }
  // 历史每日：带目标与达成率（v1 的信息量，别丢）
  const closed = (getStore().daily_records ? Object.values(getStore().daily_records) : []).filter(r => r.closed_at).sort((a,b) => b.logical_date.localeCompare(a.logical_date)).slice(0,14);
  const hl = container.querySelector('#historyList');
  hl.innerHTML = closed.length ? `<div class="list">${closed.map(r => {
    const pct = percentOfDaily(r.total_kcal, r.target_kcal);
    return `<div class="list__row">
      <div class="list__main">
        <div class="list__title">${r.logical_date} <span class="list__meta">${WEEKDAYS[weekday(r.logical_date)]}</span></div>
        <div class="list__meta">目标 ${r.target_kcal}${r.close_type === 'manual' ? ' · 手动结束' : ''}</div>
      </div>
      <div class="list__value ${pct > 100 ? 'is-over' : ''}">${round1(r.total_kcal)}</div>
      <button class="btn btn--sm" data-edit-day="${r.logical_date}">改</button>
    </div>`;
  }).join('')}</div>` : '<div class="empty"><div class="empty__text">暂无历史</div></div>';
  container.addEventListener('click', async (e) => {
    const editBtn = e.target.closest('[data-edit-day]');
    if (editBtn) {
      openEditDaySheet(editBtn.dataset.editDay);
      return;
    }
    const t = e.target.closest('[data-act]');
    if (!t) return;
    if (t.dataset.act === 'weekSummary') {
      const w = getWeekSummary();
      const pct = w.target_kcal > 0 ? round1((w.avg_kcal / w.target_kcal) * 100) : 0;
      const rows = w.days.length ? w.days.map(r => {
        const over = r.total_kcal > r.target_kcal;
        return `<div class="list__row">
          <div class="list__main">
            <div class="list__title">${r.logical_date.slice(5)} ${WEEKDAYS[weekday(r.logical_date)]}</div>
            <div class="list__meta">${r.closed_at ? '已结束' : '进行中'}</div>
          </div>
          <div class="list__value ${over ? 'is-over' : ''}">${round1(r.total_kcal)} / ${r.target_kcal}</div>
        </div>`;
      }).join('') : '<div class="empty"><div class="empty__text">本周暂无数据</div></div>';
      openSheet({
        title: '本周总结',
        body: `
          <div class="hint">${w.week_start} ~ ${w.week_end}</div>
          <div class="stat-grid">
            <div class="stat"><div class="stat__label">平均（${w.closed_days} 天已结束）</div>
              <div class="stat__value">${round1(w.avg_kcal)} <span class="stat__unit">kcal · ${pct}%</span></div></div>
            <div class="stat"><div class="stat__label">本周合计</div>
              <div class="stat__value">${round1(w.total_kcal)} <span class="stat__unit">kcal</span></div></div>
            <div class="stat"><div class="stat__label">超标天数</div>
              <div class="stat__value ${w.over_target_days > 0 ? 'is-over' : ''}">${w.over_target_days} <span class="stat__unit">天</span></div></div>
          </div>
          <div class="section-title">每日详情</div>
          <div class="list">${rows}</div>
        `,
      });
      return;
    }
    if (t.dataset.act === 'weightHistory') {
      const recs = [...getWeights()].sort((a,b) => (b.created_at||'').localeCompare(a.created_at||''));
      const rows = recs.map((r,i) => {
        const prev = recs[i+1];
        const d = prev ? ((r.kg - prev.kg)*2) : null;
        const diff = d == null ? '' : (Math.abs(d) < 0.05 ? '持平' : (d>0?'+':'')+round1(d)+' 斤');
        return `<div class="list__row"><div class="list__main"><div class="list__title">${(r.created_at||'').slice(0,16).replace('T',' ')}</div><div class="list__meta">${round1(r.jin)} 斤 · ${round1(r.kg)} kg</div></div><div class="list__value">${esc(diff)}</div></div>`;
      }).join('');
      openSheet({ title: '体重历史', body: recs.length ? rows : '<div class="empty"><div class="empty__text">暂无体重记录</div></div>' });
    }
  });
  return container;
}

// 历史每日「改」：改当天总热量 / 目标 / 重开或结束当天
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
    <button class="btn btn--ghost" id="editDayClose">取消</button>
    <button class="btn ${isClosed ? 'btn--ghost' : 'btn--danger'}" id="editDayToggle">${isClosed ? '重新打开该天' : '标记为已结束'}</button>
    <button class="btn btn--primary" id="editDaySave">保存</button>
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
      upsertDailyRecord(date, { total_kcal: kcal, target_kcal: target });
      toast('已保存', 'success');
      closeSheet();
      if (window.app && window.app.rerender) window.app.rerender();
    };
    if (toggle) toggle.onclick = async () => {
      if (isClosed) {
        const ok = await confirmSheet({
          title: '重新打开该天',
          text: `将 ${date} 从「已结束」列表中移除（closed_at 清空）。它会从历史每日消失，并可能影响本周总结统计。`,
          okText: '重新打开',
          danger: true,
        });
        if (!ok) return;
        upsertDailyRecord(date, { closed_at: null, close_type: null });
        toast('已重新打开', 'success');
      } else {
        const ok = await confirmSheet({
          title: '标记为已结束',
          text: `把 ${date} 标记为已结束（手动）。今日总计会固定下来，之后仍可在此处修改记录。`,
          okText: '结束该天',
          danger: true,
        });
        if (!ok) return;
        upsertDailyRecord(date, { closed_at: new Date().toISOString(), close_type: 'manual' });
        toast('已标记结束', 'success');
      }
      closeSheet();
      if (window.app && window.app.rerender) window.app.rerender();
    };
  }, 0);
}