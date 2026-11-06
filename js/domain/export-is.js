// domain/export-is.js —— K++ → 孤立解 的数据出口
//
// 目标（用户 2026-11-06 定）：
//   「孤立解的技术栈后续会换，你只需要关心改动小的」
//   ⇒ 本模块**只管产出稳定格式**，不对孤立解的任何实现做假设。
//     孤立解换栈（原生 JS → React/Vue/任意）后，这份 JSON 仍然能用，
//     因为契约只承诺字段名、类型、语义，不承诺实现。
//
// 设计原则：
//   1. **只导出聚合指标，不导明细** —— 明细（每笔摄入、每条体重）属于隐私，
//      孤立解要的是「一生足迹」的摘要，不是把热量账复制过去。
//   2. **本模块纯函数、无副作用** —— 不写 localStorage、不弹窗，
//      调用方拿到对象后自己决定怎么用。
//   3. **不引用孤立解的任何东西** —— 不 import 它的文件、不假设它的键名。
//      「怎么导入」是孤立解那边的事，将来它换栈时这段代码不需要跟着改。
//   4. **契约版本化** —— 带 schema 字段，将来加指标不破坏老读取方。

import { getStore, getWeights, getAppState } from '../core/db.js';
import { getRangeSummary } from './state.js';
import { round1 } from './parser.js';
import { logicalDate } from '../core/date.js';

export const IS_EXPORT_SCHEMA = 1;

/**
 * 连续记录天数：从「今天（逻辑日）」往前数，连续有记录的天数。
 *
 * ⚠️ 语义细节（孤立解那边会依赖这个）：
 *   - 以**逻辑日**（04:00 边界）为准，不是自然日 —— 与 App 内其它统计口径一致
 *   - 今天还没记录时，从昨天开始算（否则用户早上一打开就看到 streak 归零，体验差）
 *   - 「有记录」= 该日 total_kcal !== 0 或存在摄入明细（与 getRangeSummary 的 has_record 同义）
 *
 * @returns {{ days: number, from: string|null, to: string|null }}
 */
function computeStreak() {
  const s = getRangeSummary('all');
  if (!s || !Array.isArray(s.days) || s.days.length === 0) {
    return { days: 0, from: null, to: null };
  }
  const today = logicalDate(new Date());
  // 末尾对齐到今天：若末尾不是今天，先跳过（今天还没记）
  let i = s.days.length - 1;
  if (s.days[i].logical_date !== today) {
    i -= 1;
  }
  let days = 0;
  const to = i >= 0 && s.days[i] && s.days[i].has_record ? s.days[i].logical_date : null;
  let from = null;
  for (; i >= 0; i--) {
    if (!s.days[i].has_record) break;
    days += 1;
    from = s.days[i].logical_date;
  }
  return { days, from, to };
}

/**
 * 首末体重差（kg）。首末指**记录时间顺序**上的第一条与最后一条。
 * @returns {{ delta_kg: number, first_kg: number, last_kg: number, count: number } | null}
 */
function computeWeightDelta() {
  const ws = getWeights();
  if (!Array.isArray(ws) || ws.length === 0) return null;
  const first = ws[0];
  const last = ws[ws.length - 1];
  return {
    delta_kg: round1(Number(last.kg) - Number(first.kg)),
    first_kg: round1(first.kg),
    last_kg: round1(last.kg),
    count: ws.length,
  };
}

/**
 * 生成给孤立解的数据包。
 *
 * **契约（改字段名 = 破坏兼容，必须升 schema 并保留旧字段）**
 * @returns {object} 见下方 buildIsPayload 的返回注释
 */
export function buildIsPayload() {
  const state = getAppState();
  const summary = getRangeSummary('all');
  const streak = computeStreak();
  const wd = computeWeightDelta();
  const store = getStore();
  const intakeCount = Array.isArray(store.intake_records) ? store.intake_records.length : 0;

  // 无任何记录时的形态：字段齐全但值为空，让读取方不必写一堆判空
  const hasData = summary.day_count > 0;

  return {
    // ── 元信息（读取方用它判断兼容性）──
    schema: IS_EXPORT_SCHEMA,
    source: 'K++',
    exported_at: new Date().toISOString(),
    // app_version：从页面 meta 或 manifest 读，读不到就退回固定串（不强依赖）。
    // ⚠️ 之前写 window.__KPP_VERSION__ 是个从来没定义过的变量 → 永远是 null，
    //   读取方看不出数据来自哪个版本。这里改成实际可取的来源。
    app_version: (function () {
      try {
        const m = document.querySelector('meta[name="kpp-version"]');
        if (m && m.content) return m.content;
      } catch (e) {}
      return 'K++ v24';
    })(),
    logical_date: state.logical_date,

    // ── 足迹摘要（孤立解「一生足迹」主要吃这一段）──
    footprint: {
      has_data: hasData,

      // 记录跨度与量
      first_record_date: hasData ? summary.start_date : null,
      last_record_date: hasData ? summary.end_date : null,
      span_days: hasData ? summary.span_days : 0,        // 首末日跨度（含首末）
      recorded_days: hasData ? summary.day_count : 0,    // 有记录的天数
      total_entries: intakeCount,                        // 摄入明细笔数
      closed_days: hasData ? summary.closed_days : 0,    // 已日结天数

      // 连续性（孤立解可拿来发成就）
      streak: streak.days,
      streak_from: streak.from,
      streak_to: streak.to,

      // 摄入
      total_kcal: hasData ? round1(summary.total_kcal) : 0,
      avg_kcal_per_day: hasData ? round1(summary.avg_kcal) : 0,   // 分母 = recorded_days
      target_kcal: hasData ? summary.target_kcal : (state.target_kcal || 0),

      // 与目标的关系
      under_target_days: hasData ? summary.under_target_days : 0,
      over_target_days: hasData ? summary.over_target_days : 0,
      no_record_days: hasData ? summary.no_record_days : 0,

      // 极值（可能为 null）
      max_day: summary.max_day || null,      // { date, kcal }
      min_day: summary.min_day || null,

      // 体重
      weight: wd,                            // null 或 { delta_kg, first_kg, last_kg, count }
    },

    // ── 给将来扩展留的位置（现在为空，读取方应容忍未知字段）──
    extra: {},
  };
}

/**
 * 把数据包转成可下载的 JSON 文本（带缩进，方便用户肉眼核对）。
 */
export function buildIsPayloadText() {
  return JSON.stringify(buildIsPayload(), null, 2);
}

/**
 * 建议的文件名：带日期，便于用户区分多份导出。
 */
export function suggestedIsFilename(dateStr) {
  const d = dateStr || logicalDate(new Date());
  return `kpp-footprint-${d}.json`;
}
