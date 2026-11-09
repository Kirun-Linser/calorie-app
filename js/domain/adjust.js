// domain/adjust.js —— 「改某天总额」时同步明细的补偿逻辑
//
// 为什么需要它（2026-11-09 用户反馈「回到某一天的编辑有问题」）：
//   「修改某天」抽屉的保存只调 upsertDailyRecord({total_kcal})，
//   **不改 intake_records 明细**。于是出现：
//     daily.total = 8888，但明细合计仍是 3203.92（9 笔）
//   更糟的是：用户之后再记一笔 → engine.recalcDaily() 按明细重算总额
//   → 8888 被覆盖回 3303.92，用户的修改彻底丢失。
//
// 修法（用户 2026-11-09 选定）：**自动补一条「调整」明细**。
//   改总额时算出差额 delta = 新总额 - 明细合计，
//   若 delta 非 0 就写一条 raw_input='手动调整' 的记录，使
//   「明细合计」严格等于「用户设定的总额」。
//   这样之后任何 recalcDaily 都能还原出用户想要的数字。

import { getIntakeRecordsByDate, addIntakeRecord, nowISO, getDailyRecord } from '../core/db.js';
import { round1 } from './parser.js';

/** 调整记录固定用的 raw_input 文本（便于识别与统计时排除/合并） */
export const ADJUST_RAW = '手动调整';

/**
 * 让某天的「明细合计」等于指定总额。
 *
 * @param {string} logicalDate 逻辑日 YYYY-MM-DD
 * @param {number} desiredTotal 用户想要的总热量
 * @returns {{ adjusted: boolean, delta: number, record: object|null }}
 *   adjusted=false 表示明细本来就吻合、无需补记录
 */
export function syncDayTotal(logicalDate, desiredTotal) {
  const recs = getIntakeRecordsByDate(logicalDate);
  const detailSum = recs.reduce((s, r) => s + (Number(r.kcal) || 0), 0);
  // ⚠️ 2026-11-09 实测修正：这里原来对 delta 做了 round1（只留 1 位小数），
  // 而明细本身可能有 13 位小数（例如 3203.9263862332696）。
  // 于是 delta 被舍入后，补完的合计会漂移：目标 8888 → 实际 8888.02638623327。
  // 金额不该有这种漂移，改为保留完整精度，让合计严格相等。
  const delta = (Number(desiredTotal) || 0) - detailSum;
  // 显示用的标签才做舍入
  const deltaDisplay = round1(delta);

  // 差额小于 0.05 视为已吻合（round1 后的精度范围内）
  if (Math.abs(delta) < 0.05) {
    return { adjusted: false, delta: 0, record: null };
  }

  const rec = addIntakeRecord({
    raw_input: ADJUST_RAW,
    label: delta > 0 ? `调整 +${deltaDisplay}` : `调整 ${deltaDisplay}`,
    kcal: delta,
    kj: null,
    gram: null,
    food_id: null,
    logical_date: logicalDate,
    created_at: nowISO(),
    // 调整记录不参与「撤销上一笔」的常规路径以外的东西；
    // undoable=1 让它也能被撤销（撤销后明细回到调整前状态）
    undoable: 1,
  });

  return { adjusted: true, delta, record: rec };
}

/**
 * 某天的明细里是否含调整记录（供 UI 提示用）。
 */
export function hasAdjustRecord(logicalDate) {
  return getIntakeRecordsByDate(logicalDate).some(r => r.raw_input === ADJUST_RAW);
}
