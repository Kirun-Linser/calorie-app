// domain/allocation.js — 待分摊摄入（v1 语义 + 多分摊并存改造）
// 7.1 创建：total_kcal, start_date=当前逻辑日, status=open
// 7.2 停止：days = start_date 到停止前一日，per_day = total/days，逐天叠加到 daily_record
//          并写入 __allocated__ 记录（带 batch_id，便于精确撤销）；不调 recalcDaily 覆盖历史
// 7.3 边界：days<=0 → 全部计入起算日
// 7.4 撤销：按 batch_id 精确删该批 __allocated__ 记录，逐日减去 perDay；
//          若某日减到 0 且无其它 intake → 删除该 daily_record（不留空壳）

import {
  getAppState, getStore, getOpenAllocation, getOpenAllocations, addAllocation, updateAllocation,
  addIntakeRecord, getDailyRecord, upsertDailyRecord, deleteDailyRecord,
  getIntakeRecordsByDate, nowISO, saveDB
} from '../core/db.js';
import { fmtDate, parseDate, diffDays } from '../core/date.js';
import { recalcDaily } from './engine.js';

// 7.1 创建待分摊（旧签名：rawKj 是每 100g 的 kJ，grams 是总克数）
// ⚠️ 此函数保留是为了兼容旧测试/旧调用；today.js 等入口应改用 createAllocationFromKcal。
export function createAllocation(rawKj, grams) {
  const totalKj = rawKj * grams / 100;
  const totalKcal = totalKj / 4.184;
  const state = getAppState();
  return addAllocation(totalKcal, state.logical_date);
}

// 直接按 kcal 创建待分摊（新入口，UI 传入解析好的总 kcal）
export function createAllocationFromKcal(totalKcal) {
  const state = getAppState();
  return addAllocation(totalKcal, state.logical_date);
}

// 7.2 停止分摊（includeStopDay 默认 false）
export function stopAllocation(allocId, includeStopDay = false) {
  const store = getStore();
  const alloc = store.allocation.find(a => a.id === allocId);
  if (!alloc) throw new Error('当前没有待分摊摄入');
  if (alloc.status !== 'open') throw new Error('该分摊已停止，不可重复操作');

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

  // 逐天写入：叠加到 daily_record.total_kcal（不调 recalcDaily 覆盖历史），
  // 同时写 __allocated__ 记录并带上 batch_id，便于撤销精确定位。
  let cur = parseDate(start);
  const end = parseDate(days === 1 && diffDays(start, endDate) <= 0 ? start : endDate);
  while (cur <= end) {
    const dateStr = fmtDate(cur);
    const daily = getDailyRecord(dateStr);
    const curTotal = (daily && daily.total_kcal) || 0;
    if (!daily) {
      upsertDailyRecord({
        logical_date: dateStr,
        total_kcal: perDay,
        target_kcal: state.target_kcal,
        closed_at: null,
        close_type: null
      });
    } else {
      // 叠加，不覆盖历史 total（历史日可能是导入的汇总值，没有明细可重算）
      upsertDailyRecord({ logical_date: dateStr, total_kcal: curTotal + perDay });
    }
    addIntakeRecord({
      raw_input: '待分摊',
      kcal: perDay,
      kj: null,
      gram: null,
      food_id: '__allocated__',
      batch_id: batchId,
      logical_date: dateStr,
      created_at: nowISO(),
      undoable: 0
    });
    cur.setDate(cur.getDate() + 1);
  }

  updateAllocation(allocId, {
    status: 'stopped',
    stop_date: stopDate,
    batch_id: batchId
  });

  return { perDay, days, batchId, startDate: start, endDate };
}

// 撤销指定 batch 的分摊（按 batch_id 精确，不影响其它批）
export function undoAllocationBatch(batchId) {
  const store = getStore();
  // 只删本 batch 的 __allocated__ 记录
  const recs = store.intake_records.filter(
    r => r.food_id === '__allocated__' && r.batch_id === batchId
  );
  let removedCount = 0;
  for (const r of recs) {
    const idx = store.intake_records.indexOf(r);
    if (idx >= 0) {
      store.intake_records.splice(idx, 1);
      removedCount++;
    }
  }

  // 逐日减去 perDay（用被删记录的 kcal 之和，而不是反推 alloc，避免天数边界误差）
  const dates = [...new Set(recs.map(r => r.logical_date))];
  for (const d of dates) {
    const dayRecs = recs.filter(r => r.logical_date === d);
    const subtract = dayRecs.reduce((s, r) => s + r.kcal, 0);
    const daily = getDailyRecord(d);
    if (!daily) continue;
    const newTotal = Math.max(0, (daily.total_kcal || 0) - subtract);
    // 撤销后该日若无任何 intake_records（且 total 归零）→ 删除该日记录（不留空壳）
    // ⚠️ 但「用户手动结束过的日子」必须保留（closed_at 有值）：那是用户主动结束的历史，
    //    删掉会让他"结束的那天"直接消失（实测把 10-26 整条删了 → 重开功能直接抛"不存在"）。
    const remaining = store.intake_records.filter(r => r.logical_date === d).length;
    if (newTotal <= 0 && remaining === 0 && !daily.closed_at) {
      delete store.daily_records[d];
    } else {
      upsertDailyRecord({ logical_date: d, total_kcal: newTotal });
    }
  }

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
