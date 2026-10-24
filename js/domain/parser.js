// domain/parser.js — 摄入输入解析器（v1 原样迁移，仅改 import 路径 + 补 percentOfDaily）
// 支持格式：
//   1. 纯数字 "739"              → 739 kcal（裸数字即 kcal，v1 决策 5）
//   2. "Xkj" / "X kJ"            → X / 4.184 kcal
//   3. "X，Y" / "X,Y"            → X kj/100g × Y g / 100 / 4.184 kcal
//   4. "Xkj，Yg"                 → 同上
//   5. "N个食物" / "N份食物"     → 食物词典 unit_kcal × N
//   6. "食物xN" / "食物×N"       → 同上
//   7. "一份食物" / "1个食物"    → N=1
//   8. 组合 "A➕B" / "A+B"       → 各项相加
//   9. 负数 "-500kj"             → 负 kcal（用于冲销/纠错）
//  10. "0kj" / "0"              → 0 kcal

import { getFood } from '../core/db.js';

const KJ_TO_KCAL = 1 / 4.184; // v1 决策 6：不可改

// 解析单个 token，返回 {kcal, raw, type, food_id?} 或抛错
function parseToken(token) {
  token = token.trim();
  if (!token) throw new Error('空输入');

  // 先提取尾部乘数 xN / ×N（如 "1份烩面x2" → base="1份烩面", mult=2）
  const xMatch = token.match(/^(.+?)\s*(?:x|×|X)\s*(-?\d+(?:\.\d+)?)$/);
  let baseToken = token;
  let mult = 1;
  if (xMatch) {
    baseToken = xMatch[1].trim();
    mult = parseFloat(xMatch[2]);
  }
  token = baseToken;

  let result;

  // 形式 3/4: Xkj，Yg  或  X,Y  或  X，Y
  const kjGram = token.match(/^(-?\d+(?:\.\d+)?)\s*(?:kj|kJ|KJ)?\s*[,，]\s*(-?\d+(?:\.\d+)?)\s*(?:g|克)?$/i);
  if (kjGram) {
    const kjPer100 = parseFloat(kjGram[1]);
    const grams = parseFloat(kjGram[2]);
    const totalKj = kjPer100 * grams / 100;
    const kcal = totalKj * KJ_TO_KCAL;
    result = { kcal, kj: totalKj, gram: grams, raw: token, type: 'kj-gram' };
  }

  // 形式 2: Xkj
  if (!result) {
    const kjOnly = token.match(/^(-?\d+(?:\.\d+)?)\s*(?:kj|kJ|KJ)$/i);
    if (kjOnly) {
      const kj = parseFloat(kjOnly[1]);
      result = { kcal: kj * KJ_TO_KCAL, kj, raw: token, type: 'kj' };
    }
  }

  // 形式 5: N个食物 / N份食物 / N只食物
  if (!result) {
    const nFood = token.match(/^(-?\d+(?:\.\d+)?)\s*(?:个|份|只|碗|盘|杯|瓶|包|块|条|片)\s*(.+)$/);
    if (nFood) {
      const n = parseFloat(nFood[1]);
      const foodName = nFood[2].trim();
      const food = getFood(foodName);
      if (!food) throw new Error(`未找到"${foodName}"，请手动输入热量或选择相近食物`);
      result = { kcal: food.unit_kcal * n, food_id: foodName, raw: token, type: 'food', gram: food.unit_weight * n };
    }
  }

  // 形式 6: 纯食物名（乘数已在前置 xMatch 提取为 mult）
  if (!result) {
    const food = getFood(token);
    if (food) {
      result = { kcal: food.unit_kcal, food_id: token, raw: token, type: 'food', gram: food.unit_weight };
    }
  }

  // 形式 7: 一份/一个 食物
  if (!result) {
    const oneFood = token.match(/^(?:一|1)\s*(?:个|份|只|碗|盘|杯|瓶|包|块|条|片)\s*(.+)$/);
    if (oneFood) {
      const foodName = oneFood[1].trim();
      const food = getFood(foodName);
      if (!food) throw new Error(`未找到"${foodName}"，请手动输入热量或选择相近食物`);
      result = { kcal: food.unit_kcal, food_id: foodName, raw: token, type: 'food', gram: food.unit_weight };
    }
  }

  // 纯数字 → kcal
  if (!result) {
    const pure = token.match(/^(-?\d+(?:\.\d+)?)$/);
    if (pure) {
      result = { kcal: parseFloat(pure[1]), raw: token, type: 'kcal' };
    }
  }

  if (!result) throw new Error('未识别。可用：739，330 / 739kj / 6个蛋 / 一份烩面');

  return applyMult(result, mult);
}

// 应用尾部乘数
function applyMult(r, mult) {
  if (mult === 1) return r;
  return {
    ...r,
    kcal: r.kcal * mult,
    kj: r.kj !== undefined ? r.kj * mult : undefined,
    gram: r.gram !== undefined ? r.gram * mult : undefined
  };
}

// 主入口：支持 ➕ / + 连接的多 token
export function parseInput(input) {
  const text = (input || '').trim();
  if (!text) throw new Error('空输入');

  const parts = text.split(/[➕+]/).map(p => p.trim()).filter(Boolean);
  if (parts.length === 0) throw new Error('空输入');

  if (parts.length === 1) {
    return parseToken(parts[0]);
  }

  // 组合：各项相加
  let totalKcal = 0;
  let totalKj = 0;
  let totalGram = 0;
  const items = [];
  for (const p of parts) {
    const r = parseToken(p);
    totalKcal += r.kcal;
    if (r.kj) totalKj += r.kj;
    if (r.gram) totalGram += r.gram;
    items.push(r);
  }
  return {
    kcal: totalKcal,
    kj: totalKj || undefined,
    gram: totalGram || undefined,
    raw: text,
    type: 'combo',
    items
  };
}

// 百分比：按当日目标（v1 5.5）。纯函数，放在这里是为了让 UI 从 parser 或 engine 任一处都能取到
export function percentOfDaily(totalKcal, targetKcal) {
  if (!targetKcal || targetKcal === 0) return 0;
  return (totalKcal / targetKcal) * 100;
}

export function round3(n) {
  return Math.round(n * 1000) / 1000;
}

export function round1(n) {
  return Math.round(n * 10) / 10;
}
