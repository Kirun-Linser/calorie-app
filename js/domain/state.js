// domain/state.js — 状态机：逻辑日 / 结束当日 / 自动结束 / 周总结（v1 语义原样保留）
// v2 适配点：daily_records 由数组变对象索引 → 遍历一律走 getAllDailyRecords()

import {
  getAppState, setAppState, getDailyRecord, upsertDailyRecord,
  getAllDailyRecords, getIntakeRecordsByDate, nowISO, saveDB
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
  while (guard < 365) {
    const state = getAppState();
    if (state.logical_date >= today) break;
    if (state.last_auto_close_date === today && state.logical_date === today) break;
    const cur = state.logical_date;
    const nxt = nextDay(cur);
    const daily = getDailyRecord(cur);
    const alreadyClosed = !!(daily && daily.closed_at);

    // 周日结束 → 周一，触发周总结
    if (weekday(cur) === 0 && weekday(nxt) === 1) {
      setAppState({ last_summary_date: cur });
    }

    // 确保当前日记录存在（缺失则补建空记录，已存在不覆盖）
    if (!daily) {
      upsertDailyRecord({
        logical_date: cur,
        total_kcal: 0,
        target_kcal: state.target_kcal,
        closed_at: null,
        close_type: null
      });
    }

    // ⚠️ 自动结束这一天：原来由 autoCloseDay→closeDay 负责，追平循环改写后必须自己补上。
    // 否则「忘了日结的那天」会永远停在未结束 → 不出现在趋势页「历史每日」，也不计入周总结的已结束天数。
    // cur 一定 < today（循环条件保证），所以把过去的日子标为已结束是安全的。
    if (!alreadyClosed) {
      // ⚠️ 不能无条件 recalcDaily：导入 / 手动编辑过的日子没有 intake_records，
      //    重算会把已有的 total_kcal 归零（实测：26 天备份里 10-24 的 1190.989 被抹成 0）。
      //    只有确实存在明细记录时才重算。
      if (getIntakeRecordsByDate(cur).length > 0) recalcDaily(cur);
      upsertDailyRecord({ logical_date: cur, closed_at: nowISO(), close_type: 'auto' });
    }

    const newIndex = state.current_day_index + 1;
    if (!getDailyRecord(nxt)) {
      upsertDailyRecord({
        logical_date: nxt,
        total_kcal: 0,
        target_kcal: state.target_kcal,
        closed_at: null,
        close_type: null
      });
    }

    setAppState({
      logical_date: nxt,
      current_day_index: newIndex
    });

    results.push({ skipped: alreadyClosed, daily: getDailyRecord(cur), newDate: nxt });
    guard++;
  }
  // 追平 last_auto_close_date
  const finalState = getAppState();
  if (finalState.last_auto_close_date !== today) {
    setAppState({ last_auto_close_date: today });
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
