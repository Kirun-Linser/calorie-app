import { getAppState, getDailyRecord, getWeights, getStore } from '../../core/db.js';
import { predictWeight } from '../../domain/weight.js';
import { getWeekSummary } from '../../domain/state.js';
import { round1, percentOfDaily } from '../../domain/parser.js';
import { lastNDates, weekday } from '../../core/date.js';
import { toast, openSheet, esc } from '../components.js';
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
        <div class="list__meta">目标 ${r.target_kcal}</div>
      </div>
      <div class="list__value ${pct > 100 ? 'is-over' : ''}">${round1(r.total_kcal)}</div>
    </div>`;
  }).join('')}</div>` : '<div class="empty"><div class="empty__text">暂无历史</div></div>';
  container.addEventListener('click', async (e) => {
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