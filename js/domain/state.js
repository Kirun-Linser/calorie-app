// domain/state.js — 状态机：逻辑日 / 结束当日 / 自动结束 / 周总结（v1 语义原样保留）
// v2 适配点：daily_records 由数组变对象索引 → 遍历一律走 getAllDailyRecords()

import {
  getAppState, setAppState, getDailyRecord, upsertDailyRecord,
  getAllDailyRecords, nowISO, saveDB
} from '../core/db.js';
import { fmtDate, parseDate, weekday, diffDays, logicalDate } from '../core/date.js';
import { recalcDaily } from './engine.js';

// 供 UI / main.js 使用（v1 里 logicalDate 住在 db.js）
export { logicalDate };

// 5.4 结束当日
export function closeDay(logicalDateStr, closeType = 'manual') {
  const daily = getDailyRecord(logicalDateStr);
  // 1. 已 closed 则跳过
  if (daily && daily.closed_at) {
    return { skipped: true, daily };
  }

  // 确保当日记录存在
  if (!daily) {
    const state = getAppState();
    upsertDailyRecord({
      logical_date: logicalDateStr,
      total_kcal: 0,
      target_kcal: state.target_kcal,
      closed_at: null,
      close_type: null
    });
  }
  recalcDaily(logicalDateStr);

  // 2. 写入 closed_at / close_type
  upsertDailyRecord({
    logical_date: logicalDateStr,
    closed_at: nowISO(),
    close_type: closeType
  });

  const closedDaily = getDailyRecord(logicalDateStr);

  // 3. 周日结束 → 周一，触发周总结
  const oldDate = logicalDateStr;
  const newDate = nextDay(oldDate);
  let summaryTriggered = false;
  if (weekday(oldDate) === 0 && weekday(newDate) === 1) {
    summaryTriggered = true;
    setAppState({ last_summary_date: oldDate });
  }

  // 4. current_day_index++，创建新日
  const state = getAppState();
  const newIndex = state.current_day_index + 1;
  const newTarget = state.target_kcal;
  upsertDailyRecord({
    logical_date: newDate,
    total_kcal: 0,
    target_kcal: newTarget,
    closed_at: null,
    close_type: null
  });

  // 5. 更新 app_state
  setAppState({
    logical_date: newDate,
    last_auto_close_date: closeType === 'auto' ? oldDate : state.last_auto_close_date,
    current_day_index: newIndex
  });

  return { skipped: false, daily: closedDaily, summaryTriggered, newDate };
}

// 6.2 自动结束：只关当前逻辑日的前一日
export function autoCloseDay(now = new Date()) {
  const state = getAppState();
  const yesterdayLogical = prevDay(state.logical_date);
  return closeDay(yesterdayLogical, 'auto');
}

// 启动补偿循环：直到 last_auto_close_date == 今天的逻辑日
export function startupAutoClose(now = new Date()) {
  const today = logicalDateFor(now);
  const results = [];
  let guard = 0;
  while (guard < 365) { // 安全上限，防死循环
    const state = getAppState();
    if (state.last_auto_close_date === today) break;
    const r = autoCloseDay(now);
    results.push(r);
    if (r.skipped) {
      // 已关闭但 last_auto_close_date 未更新 → 强制更新
      setAppState({ last_auto_close_date: today });
      break;
    }
    guard++;
  }
  return results;
}

export function nextDay(dateStr) {
  const d = parseDate(dateStr);
  d.setDate(d.getDate() + 1);
  return fmtDate(d);
}

export function prevDay(dateStr) {
  const d = parseDate(dateStr);
  d.setDate(d.getDate() - 1);
  return fmtDate(d);
}

// 独立导出：供测试注入时间
export function logicalDateFor(now) {
  return logicalDate(now);
}

// 6.1 周总结：本周（周一~周日）的每日数据
export function getWeekSummary(referenceDate = null) {
  const state = getAppState();
  const ref = referenceDate || state.logical_date;
  const refD = parseDate(ref);
  const refWeekday = weekday(ref); // 0=Sun
  const mondayOffset = refWeekday === 0 ? -6 : 1 - refWeekday;
  const monday = new Date(refD);
  monday.setDate(monday.getDate() + mondayOffset);
  const mondayStr = fmtDate(monday);
  const sunday = new Date(monday);
  sunday.setDate(sunday.getDate() + 6);
  const sundayStr = fmtDate(sunday);

  const daily = getAllDailyRecords()
    .filter(r => r.logical_date >= mondayStr && r.logical_date <= sundayStr)
    .sort((a, b) => a.logical_date.localeCompare(b.logical_date));

  const total = daily.reduce((s, r) => s + r.total_kcal, 0);
  const closedDays = daily.filter(r => r.closed_at).length;
  const avg = closedDays > 0 ? total / closedDays : 0;
  const target = daily.length > 0 ? daily[0].target_kcal : state.target_kcal;

  return {
    week_start: mondayStr,
    week_end: sundayStr,
    days: daily,
    total_kcal: total,
    avg_kcal: avg,
    closed_days: closedDays,
    target_kcal: target,
    over_target_days: daily.filter(r => r.total_kcal > r.target_kcal).length
  };
}

// 历史平均：完整天数 ≥ 3 才算
export function historicalAverage() {
  const closed = getAllDailyRecords()
    .filter(r => r.closed_at)
    .sort((a, b) => a.logical_date.localeCompare(b.logical_date));
  if (closed.length < 3) return null;
  const avg = closed.reduce((s, r) => s + r.total_kcal, 0) / closed.length;
  return { days: closed.length, avg };
}
