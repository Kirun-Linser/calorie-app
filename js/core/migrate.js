import { readJSON, writeJSON, readRaw, LEGACY_KEY, STORAGE_KEY, QUICK_KEY, LEGACY_QUICK } from './store.js';

/**
 * 历史汇总占位迁移（幂等）。
 *
 * 根因：daily_records.total_kcal 是 intake_records 的聚合值，但旧导入数据
 * 只有 total、没有明细 → 任何 recalcDaily() 都会把 total 抹成 0（只剩分摊量）。
 * 解法：对每个 total_kcal>0 且无任何 intake_record 的历史日，补一条
 * food_id='__legacy__' 的占位记录，其 kcal 等于原 total。
 * 之后 recalcDaily 的聚合结果 = 原 total，语义保持一致。
 *
 * 幂等：已有任何 intake_record（含 __legacy__）的日子不再补；total<=0 的日子不补。
 * @param {object} store 已 normalize 过的 v2 store（就地修改）
 * @returns {number} 新增占位记录数
 */
export function migrateLegacyPlaceholder(store) {
  if (!store || !store.daily_records || typeof store.daily_records !== 'object') return 0;
  const hasIntake = {};
  for (const r of store.intake_records || []) hasIntake[r.logical_date] = true;

  const now = new Date().toISOString();
  let nextId = (store._seq && Number(store._seq.intake_records)) || 0;
  let added = 0;
  for (const date of Object.keys(store.daily_records)) {
    const daily = store.daily_records[date];
    if (!daily || !daily.total_kcal || daily.total_kcal <= 0) continue;
    if (hasIntake[date]) continue;
    nextId++;
    store.intake_records.push({
      id: nextId,
      raw_input: '历史汇总',
      kcal: daily.total_kcal,
      kj: null,
      gram: null,
      food_id: '__legacy__',
      logical_date: date,
      created_at: now,
      undoable: 0
    });
    added++;
  }
  if (added > 0 && store._seq) store._seq.intake_records = nextId;
  return added;
}

export function needsMigration() {
  const legacy = readRaw(LEGACY_KEY);
  if (legacy == null) return false;
  const v2 = readJSON(STORAGE_KEY);
  if (v2 == null) return true;
  if (!v2.meta || v2.meta.schema_version !== 2) return true;
  return false;
}

export function readMeta() {
  const v2 = readJSON(STORAGE_KEY);
  if (!v2 || !v2.meta) return null;
  return v2.meta;
}

function emptyV2(migratedFrom) {
  const now = new Date().toISOString();
  return {
    meta: { schema_version: 2, created_at: now, updated_at: now, migrated_from: migratedFrom },
    app_state: [],
    daily_records: {},
    intake_records: [],
    intake_history: [],
    food_dict: [],
    weight_records: [],
    allocation: [],
    _seq: { intake_records: 0, weight_records: 0, allocation: 0 }
  };
}

export function migrate() {
  const existing = readJSON(STORAGE_KEY);
  if (existing && existing.meta && existing.meta.schema_version === 2) {
    return { ok: true, skipped: true };
  }

  const legacyRaw = readRaw(LEGACY_KEY);

  // 旧键不存在 → 建空 v2
  if (legacyRaw == null) {
    const v2 = emptyV2(null);
    if (!writeJSON(STORAGE_KEY, v2)) throw new Error('写入失败');
    if (readRaw(QUICK_KEY) == null) writeJSON(QUICK_KEY, []);
    return { ok: true, from: null, to: 2, counts: { days: 0, intakes: 0, weights: 0, foods: 0, allocs: 0, quick: 0 } };
  }

  // 解析旧数据（失败抛错，不写新键）
  let old;
  try { old = JSON.parse(legacyRaw); }
  catch (e) { throw new Error('旧数据无法解析'); }
  if (!old || typeof old !== 'object' || Array.isArray(old)) throw new Error('旧数据无法解析');

  const arr = Array.isArray(old.daily_records) ? old.daily_records : [];
  const daysObj = {};
  for (const r of arr) {
    if (r && typeof r === 'object' && r.logical_date) daysObj[r.logical_date] = r;
  }

  const migratedFrom = (existing && existing.meta && existing.meta.migrated_from) ? existing.meta.migrated_from : 'v1';

  const v2 = {
    meta: {
      schema_version: 2,
      created_at: (existing && existing.meta && existing.meta.created_at) ? existing.meta.created_at : new Date().toISOString(),
      updated_at: new Date().toISOString(),
      migrated_from: migratedFrom
    },
    app_state: Array.isArray(old.app_state) ? old.app_state : [],
    daily_records: daysObj,
    intake_records: Array.isArray(old.intake_records) ? old.intake_records : [],
    intake_history: Array.isArray(old.intake_history) ? old.intake_history : [],
    food_dict: Array.isArray(old.food_dict) ? old.food_dict : [],
    weight_records: Array.isArray(old.weight_records) ? old.weight_records : [],
    allocation: Array.isArray(old.allocation) ? old.allocation : [],
    _seq: (old._seq && typeof old._seq === 'object') ? old._seq : { intake_records: 0, weight_records: 0, allocation: 0 }
  };

  if (!writeJSON(STORAGE_KEY, v2)) throw new Error('写入失败');

  // 快捷项
  let quickCount = 0;
  const legacyQuickRaw = readRaw(LEGACY_QUICK);
  let quickArr = [];
  if (legacyQuickRaw != null) {
    try {
      const q = JSON.parse(legacyQuickRaw);
      if (Array.isArray(q)) { quickArr = q; quickCount = q.length; }
    } catch (e) { quickArr = []; }
  }
  if (readRaw(QUICK_KEY) == null) writeJSON(QUICK_KEY, quickArr);

  return {
    ok: true,
    from: 'v1',
    to: 2,
    counts: {
      days: Object.keys(daysObj).length,
      intakes: v2.intake_records.length,
      weights: v2.weight_records.length,
      foods: v2.food_dict.length,
      allocs: v2.allocation.length,
      quick: quickCount
    }
  };
}
