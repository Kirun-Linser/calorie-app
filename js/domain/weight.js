// domain/weight.js — 体重记录与预测（v1 语义原样保留）
// v2 适配点：daily_records 改为对象索引，最近 14 天平均改走 getAllDailyRecords()
// v1 决策 5：裸数字 = 斤

import {
  addWeight, getWeights, getAllDailyRecords
} from '../core/db.js';
import { parseDate, diffDays } from '../core/date.js';

// 8.1 记录体重（支持 228.8 / 228.8斤 / 114.4kg）
export function recordWeight(input) {
  const text = String(input).trim();
  let jin, kg;
  if (text.endsWith('kg')) {
    kg = parseFloat(text);
    jin = kg * 2;
  } else if (text.endsWith('斤')) {
    jin = parseFloat(text);
    kg = jin / 2;
  } else {
    // 裸数字：假设是斤
    jin = parseFloat(text);
    kg = jin / 2;
  }
  if (isNaN(jin)) throw new Error('体重格式错误');

  // 体重合法范围：0 < 斤 <= 1000（即 0 < kg <= 500）
  if (!(jin > 0 && jin <= 1000)) {
    throw new Error('体重需在 0-1000 斤之间');
  }

  const rec = addWeight(jin, kg);

  // 与上次、首次、最低、最高比较
  const all = getWeights();
  const first = all[0];
  const prev = all.length >= 2 ? all[all.length - 2] : null;
  const min = all.reduce((a, b) => a.kg < b.kg ? a : b);
  const max = all.reduce((a, b) => a.kg > b.kg ? a : b);

  return {
    record: rec,
    vs_prev: prev ? round1(kg - prev.kg) : null,
    vs_first: first ? round1(kg - first.kg) : null,
    vs_min: round1(kg - min.kg),
    vs_max: round1(kg - max.kg)
  };
}

// 8.2 预测
export function predictWeight(profile = null) {
  const weights = getWeights();
  if (weights.length === 0) return null;

  const latest = weights[weights.length - 1];
  const W = latest.kg;      // 当前 kg
  const W0 = weights[0].kg; // 起始 kg
  const daysDiff = diffDays(
    String(weights[0].created_at).slice(0, 10),
    String(latest.created_at).slice(0, 10)
  );

  // 最近 14 个完整天的平均摄入
  const closed = getAllDailyRecords()
    .filter(r => r.closed_at)
    .sort((a, b) => b.logical_date.localeCompare(a.logical_date))
    .slice(0, 14);
  const A = closed.length
    ? closed.reduce((s, r) => s + r.total_kcal, 0) / closed.length
    : 0;

  let TDEE;
  if (daysDiff < 7) {
    // 数据不足 7 天 → Harris-Benedict 兜底
    TDEE = harrisBenedict(W, profile);
  } else {
    // 反推 TDEE
    TDEE = A - (W - W0) * 7700 / daysDiff;
  }

  const gainKg30 = (A - TDEE) * 30 / 7700;
  const predictedKg = W + gainKg30;

  return {
    latest_kg: W,
    latest_jin: W * 2,
    avg_intake: A,
    tdee: TDEE,
    gain_30d_kg: gainKg30,
    predicted_kg: predictedKg,
    predicted_jin: predictedKg * 2,
    uncertainty_kg: 1.5
  };
}

function harrisBenedict(W, profile) {
  // profile: {gender:'male'|'female', height_cm, age, activity_factor}
  const p = profile || { gender: 'male', height_cm: 175, age: 30, activity_factor: 1.375 };
  const H = p.height_cm || 175;
  const age = p.age || 30;
  const af = p.activity_factor || 1.375;
  let BMR;
  if (p.gender === 'female') {
    BMR = 447.593 + 9.247 * W + 3.098 * H - 4.330 * age;
  } else {
    BMR = 88.362 + 13.397 * W + 4.799 * H - 5.677 * age;
  }
  return BMR * af;
}

function round1(n) {
  return Math.round(n * 10) / 10;
}
