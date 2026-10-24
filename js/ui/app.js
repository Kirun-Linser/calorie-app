// 路由与挂载
import { logicalDate, fmtDate, addDays, lastNDates } from '../core/date.js';
import { initDB, getAppState, setAppState, getDailyRecord, getIntakeRecordsByDate, getOpenAllocation, getWeights, getStore, saveDB } from '../core/db.js';
import { closeDay, startupAutoClose, getWeekSummary } from '../domain/state.js';
import { predictWeight } from '../domain/weight.js';
import { percentOfDaily, round1 } from '../domain/parser.js';
import { toast, openSheet, closeSheet, confirmSheet, el, esc } from './components.js';
import { renderWeightTrend, renderWeekBars, destroyCharts } from './charts.js';

import * as todayView from './views/today.js';
import * as trendsView from './views/trends.js';
import * as settingsView from './views/settings.js';

let currentTab = 'today';
const tabs = ['today', 'trends', 'settings'];

export function navigate(tab) {
  if (!tabs.includes(tab)) return;
  currentTab = tab;
  rerender();
}

export function rerender() {
  const main = document.querySelector('.app-main');
  if (!main) return;
  destroyCharts(main);
  main.innerHTML = '';
  if (currentTab === 'today') main.appendChild(todayView.render());
  else if (currentTab === 'trends') main.appendChild(trendsView.render());
  else if (currentTab === 'settings') main.appendChild(settingsView.render());
  // tabbar active
  document.querySelectorAll('.tabbar__item').forEach((b) => {
    b.classList.toggle('is-active', b.dataset.tab === currentTab);
  });
}

export function mount() {
  const root = document.getElementById('app');
  root.innerHTML = `
    <div class="app-shell">
      <main class="app-main"></main>
      <nav class="tabbar">
        <button class="tabbar__item" data-tab="today"><span class="tabbar__icon">今</span><span class="tabbar__label">今日</span></button>
        <button class="tabbar__item" data-tab="trends"><span class="tabbar__icon">势</span><span class="tabbar__label">趋势</span></button>
        <button class="tabbar__item" data-tab="settings"><span class="tabbar__icon">设</span><span class="tabbar__label">设置</span></button>
      </nav>
    </div>
  `;
  document.querySelectorAll('.tabbar__item').forEach((b) => {
    b.addEventListener('click', () => navigate(b.dataset.tab));
  });
  rerender();
}

// expose
window.app = { navigate, rerender, mount };