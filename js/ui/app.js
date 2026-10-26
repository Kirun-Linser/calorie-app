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
        <button class="tabbar__item" data-tab="today"><span class="tabbar__icon"><svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 9h18"/><path d="M8 3v4M16 3v4"/><circle cx="12" cy="14" r="1.6"/></svg></span><span class="tabbar__label">今日</span></button>
        <button class="tabbar__item" data-tab="trends"><span class="tabbar__icon"><svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><polyline points="3 17 8 12 13 14 21 6"/><circle cx="8" cy="12" r="1.4"/><circle cx="21" cy="6" r="1.4"/></svg></span><span class="tabbar__label">趋势</span></button>
        <button class="tabbar__item" data-tab="settings"><span class="tabbar__icon"><svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 0 1-4 0v-.1a1.7 1.7 0 0 0-1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 0 1 0-4h.1a1.7 1.7 0 0 0 1.5-1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3h0a1.7 1.7 0 0 0 1-1.5V3a2 2 0 0 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8v0a1.7 1.7 0 0 0 1.5 1H21a2 2 0 0 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/></svg></span><span class="tabbar__label">设置</span></button>
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