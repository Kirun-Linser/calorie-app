// domain/engine.js — 摄入记录引擎（v1 语义原样保留）
// 记录 → 写 intake_records + 重算 daily_records.total_kcal + intake_history.use_count++
// 撤销 → 删 intake_records + 重算 + use_count--（不低于 0）
// 注意：v1 决策 2 —— 日结后仍可编辑，undoIntake 不做 closed 检查。

import {
  getAppState, getDailyRecord, upsertDailyRecord,
  addIntakeRecord, deleteIntakeRecord, getIntakeRecordsByDate,
  findHistory, upsertHistory, decrementHistory,
  saveDB, nowISO
} from '../core/db.js';
import { parseInput, percentOfDaily } from './parser.js';

// 记录一次摄入
export function recordIntake(rawInput, logicalDateOverride) {
  const parsed = parseInput(rawInput);
  const state = getAppState();
  const date = logicalDateOverride || state.logical_date;

  // 若当日 daily_records 不存在，创建
  let daily = getDailyRecord(date);
  if (!daily) {
    daily = upsertDailyRecord({
      logical_date: date,
      total_kcal: 0,
      target_kcal: state.target_kcal,
      closed_at: null,
      close_type: null
    });
  }

  const rec = addIntakeRecord({
    raw_input: rawInput.trim(),
    kcal: parsed.kcal,
    kj: parsed.kj || null,
    gram: parsed.gram || null,
    food_id: parsed.food_id || null,
    logical_date: date,
    created_at: nowISO()
  });

  // 重算当日累计（用聚合而非直接相加，避免累计误差）
  recalcDaily(date);

  // 历史复用 +1
  upsertHistory(rawInput.trim(), parsed.kcal);

  return { record: rec, daily: getDailyRecord(date), parsed };
}

// 重算某日累计
export function recalcDaily(date) {
  const recs = getIntakeRecordsByDate(date);
  const total = recs.reduce((s, r) => s + r.kcal, 0);
  const daily = getDailyRecord(date);
  if (daily) {
    upsertDailyRecord({ logical_date: date, total_kcal: total });
  }
  return total;
}

// 撤销最近一条（当日）
export function undoLastIntake(date) {
  const recs = getIntakeRecordsByDate(date).filter(r => r.undoable);
  if (recs.length === 0) {
    throw new Error('当前日没有可撤销记录');
  }
  const last = recs[recs.length - 1];
  return undoIntake(last.id);
}

// 撤销指定记录
export function undoIntake(id) {
  const rec = deleteIntakeRecord(id);
  if (!rec) throw new Error('记录不存在');

  recalcDaily(rec.logical_date);

  // 历史 use_count--（不低于 0，v1 决策 3）
  decrementHistory(rec.raw_input);

  return rec;
}

// 切换目标：不改已 closed 的历史目标（v1 5.5），但当日未关闭记录同步新目标
export function setTargetKcal(newTarget) {
  const state = getAppState();
  state.target_kcal = newTarget;
  const today = getDailyRecord(state.logical_date);
  if (today && !today.closed_at) {
    upsertDailyRecord({ logical_date: state.logical_date, target_kcal: newTarget });
  }
  saveDB();
}

// percentOfDaily 也在此 re-export（UI 从 engine 或 parser 任一处都取得到）
export { percentOfDaily };
