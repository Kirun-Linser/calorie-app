// domain/allocation.js — 待分摊摄入（v1 语义原样保留）
// 7.1 创建：total_kcal, start_date=当前逻辑日, status=open
// 7.2 停止：days = start_date 到停止前一日，per_day = total/days，逐天写 intake_records
// 7.3 边界：days<=0 → 全部计入起算日

import {
  getAppState, getStore, getOpenAllocation, addAllocation, updateAllocation,
  addIntakeRecord, getDailyRecord, upsertDailyRecord, nowISO,
  saveDB
} from '../core/db.js';
import { fmtDate, parseDate, diffDays } from '../core/date.js';
import { recalcDaily } from './engine.js';

// 7.1 创建待分摊
export function createAllocation(rawKj, grams) {
  const totalKj = rawKj * grams / 100;
  const totalKcal = totalKj / 4.184;
  const state = getAppState();
  return addAllocation(totalKcal, state.logical_date);
}

// 7.2 停止分摊（includeStopDay 默认 false）
export function stopAllocation(allocId, includeStopDay = false) {
  const store = getStore();
  const alloc = store.allocation.find(a => a.id === allocId);
  if (!alloc || alloc.status !== 'open') {
    throw new Error('当前没有待分摊摄入');
  }

  const state = getAppState();
  const stopDate = state.logical_date;
  const start = alloc.start_date;

  const endDate = includeStopDay ? stopDate : prevDay(stopDate);

  let days = diffDays(start, endDate) + 1; // 含首尾
  if (days <= 0) { // 7.3 边界
    days = 1;
  }

  const perDay = alloc.total_kcal / days;
  const batchId = 'alloc_' + alloc.id + '_' + Date.now();

  // 逐天写入 intake_records
  let cur = parseDate(start);
  const end = parseDate(days === 1 && diffDays(start, endDate) <= 0 ? start : endDate);
  while (cur <= end) {
    const dateStr = fmtDate(cur);
    const daily = getDailyRecord(dateStr);
    if (!daily) {
      upsertDailyRecord({
        logical_date: dateStr,
        total_kcal: 0,
        target_kcal: state.target_kcal,
        closed_at: null,
        close_type: null
      });
    }
    addIntakeRecord({
      raw_input: '待分摊',
      kcal: perDay,
      kj: null,
      gram: null,
      food_id: '__allocated__',
      logical_date: dateStr,
      created_at: nowISO()
    });
    recalcDaily(dateStr);
    cur.setDate(cur.getDate() + 1);
  }

  updateAllocation(allocId, {
    status: 'stopped',
    stop_date: stopDate,
    batch_id: batchId
  });

  return { perDay, days, batchId, startDate: start, endDate };
}

// 撤销整批分摊
export function undoAllocationBatch(batchId) {
  const store = getStore();
  const recs = store.intake_records.filter(r => r.food_id === '__allocated__' && r.raw_input === '待分摊');
  // 简化（与 v1 一致）：一次只有一个 open alloc，撤销所有 __allocated__ 记录
  let removedCount = 0;
  const dates = new Set();
  for (const r of recs) {
    dates.add(r.logical_date);
    const idx = store.intake_records.indexOf(r);
    if (idx >= 0) {
      store.intake_records.splice(idx, 1);
      removedCount++;
    }
  }
  for (const d of dates) recalcDaily(d);

  const alloc = store.allocation.find(a => a.batch_id === batchId);
  if (alloc) {
    alloc.status = 'open';
    alloc.stop_date = null;
    alloc.batch_id = null;
  }
  saveDB();
  return { removedCount };
}

function prevDay(dateStr) {
  const d = parseDate(dateStr);
  d.setDate(d.getDate() - 1);
  return fmtDate(d);
}
