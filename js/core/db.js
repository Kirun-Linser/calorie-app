// core/db.js — 表 CRUD（v2）
// 与 v1 的差异：daily_records 由数组改为「以 logical_date 为键的对象」；存储键改为 calorie.db.v2；
// 初始化走 migrate()（幂等、不删旧键）。业务语义与 v1 完全一致。
import { readJSON, writeJSON, STORAGE_KEY, QUICK_KEY } from './store.js';
import { migrate, migrateLegacyPlaceholder } from './migrate.js';
import { fmtDate, parseDate, logicalDate, todayStr, weekday, diffDays } from './date.js';

const SEQ_KEYS = { intake_records: 0, weight_records: 0, allocation: 0 };

let _store = null;
let _migrationError = null;

export function nowISO() {
  return new Date().toISOString();
}

function emptyStore() {
  return {
    app_state: [],
    daily_records: {},
    intake_records: [],
    intake_history: [],
    food_dict: [],
    weight_records: [],
    allocation: [],
    _seq: { ...SEQ_KEYS }
  };
}

function defaultAppState() {
  return {
    id: 1,
    target_kcal: 2300,
    logical_date: logicalDate(new Date()),
    last_auto_close_date: null,
    last_summary_date: null,
    current_day_index: 1,
    user_profile: null
  };
}

// 迁移失败时的可读原因（UI 用来提示用户，绝不静默吞掉）
export function getMigrationError() {
  return _migrationError;
}

// 补齐结构：损坏或缺失的字段就地修复，不丢已有数据
function normalize(store) {
  if (!store || typeof store !== 'object') store = emptyStore();
  if (!Array.isArray(store.app_state)) store.app_state = [];
  if (Array.isArray(store.daily_records)) {
    // 极端情况：老数据仍是数组（例如有人在 v2 键里放了 v1 结构）→ 就地转对象
    const obj = {};
    for (const r of store.daily_records) {
      if (r && r.logical_date) obj[r.logical_date] = r;
    }
    store.daily_records = obj;
  } else if (!store.daily_records || typeof store.daily_records !== 'object') {
    store.daily_records = {};
  }
  for (const k of ['intake_records', 'intake_history', 'food_dict', 'weight_records', 'allocation']) {
    if (!Array.isArray(store[k])) store[k] = [];
  }
  if (!store._seq || typeof store._seq !== 'object') store._seq = { ...SEQ_KEYS };
  for (const k of Object.keys(SEQ_KEYS)) {
    // 自增序列必须 >= 现存最大 id，避免迁移后 id 撞车
    const maxId = store[k === 'intake_records' ? 'intake_records'
      : k === 'weight_records' ? 'weight_records' : 'allocation']
      .reduce((m, r) => Math.max(m, Number(r && r.id) || 0), 0);
    if (!Number.isFinite(store._seq[k]) || store._seq[k] < maxId) store._seq[k] = maxId;
  }
  if (!store.app_state.length) store.app_state.push(defaultAppState());
  return store;
}

export function initDB() {
  if (_store) return _store;
  try {
    migrate();
  } catch (e) {
    // 旧数据损坏：**不删除旧键**，用空库继续，把原因留给 UI 提示
    _migrationError = e && e.message ? e.message : '迁移失败';
    console.warn('[calorie] 数据迁移失败，已用空库启动：', _migrationError);
    if (readJSON(STORAGE_KEY) == null) writeJSON(STORAGE_KEY, emptyStore());
  }
  _store = normalize(readJSON(STORAGE_KEY) || emptyStore());
  // 历史汇总占位迁移：对有 total 但无明细的历史日补 __legacy__ 占位记录，
  // 防止 recalcDaily 把这些日的 total 抹成 0。幂等，连跑无副作用。
  migrateLegacyPlaceholder(_store);
  seedFoodDict();
  saveDB();
  return _store;
}

export function saveDB() {
  if (!_store) return false;
  _store.meta = _store.meta || {};
  _store.meta.schema_version = 2;
  _store.meta.updated_at = nowISO();
  if (!_store.meta.created_at) _store.meta.created_at = _store.meta.updated_at;
  if (_store.meta.migrated_from === undefined) _store.meta.migrated_from = null;
  return writeJSON(STORAGE_KEY, _store);
}

export function getStore() {
  if (!_store) initDB();
  return _store;
}

// ===== 逻辑日 / 日期（转发 core/date.js，v1 里这些函数就在 db.js，旧测试仍从这里取） =====
export { logicalDate, fmtDate, parseDate, weekday, diffDays, todayStr };
export function todayLogical() {
  return logicalDate(new Date());
}

// ===== app_state =====
export function getAppState() {
  return getStore().app_state[0];
}

export function setAppState(patch) {
  Object.assign(getStore().app_state[0], patch);
  saveDB();
}

// ===== daily_records（v2：对象索引） =====
export function getDailyRecord(date) {
  const rec = getStore().daily_records[date];
  return rec || null;
}

// 兼容两种调用：upsertDailyRecord(rec) 与 upsertDailyRecord(date, patch)
export function upsertDailyRecord(dateOrRec, patch) {
  const s = getStore();
  const rec = typeof dateOrRec === 'string'
    ? { logical_date: dateOrRec, ...(patch || {}) }
    : { ...(dateOrRec || {}) };
  if (!rec.logical_date) throw new Error('upsertDailyRecord 需要 logical_date');
  const key = rec.logical_date;
  s.daily_records[key] = { ...(s.daily_records[key] || {}), ...rec };
  saveDB();
  return s.daily_records[key];
}

// 所有日记录（数组，按日期升序）—— 供 week summary / 预测之类需要遍历的场景
export function getAllDailyRecords() {
  return Object.values(getStore().daily_records)
    .sort((a, b) => String(a.logical_date).localeCompare(String(b.logical_date)));
}

// 删除某日记录（撤销分摊后该日为空、且无其它明细时使用，避免留空壳）
export function deleteDailyRecord(date) {
  const s = getStore();
  if (s.daily_records[date]) {
    delete s.daily_records[date];
    saveDB();
    return true;
  }
  return false;
}

// ===== intake_records =====
export function addIntakeRecord(rec) {
  const s = getStore();
  s._seq.intake_records++;
  const r = { id: s._seq.intake_records, ...rec, undoable: rec.undoable === undefined ? 1 : rec.undoable };
  s.intake_records.push(r);
  saveDB();
  return r;
}

export function getIntakeRecordsByDate(date) {
  return getStore().intake_records
    .filter(r => r.logical_date === date)
    .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
}

export function getIntakeRecord(id) {
  return getStore().intake_records.find(r => r.id === id) || null;
}

export function deleteIntakeRecord(id) {
  const s = getStore();
  const idx = s.intake_records.findIndex(r => r.id === id);
  if (idx >= 0) {
    const r = s.intake_records[idx];
    s.intake_records.splice(idx, 1);
    saveDB();
    return r;
  }
  return null;
}

// ===== intake_history =====
export function findHistory(raw_input) {
  return getStore().intake_history.find(h => h.raw_input === raw_input) || null;
}

export function upsertHistory(raw_input, kcal) {
  const s = getStore();
  const existing = s.intake_history.find(h => h.raw_input === raw_input);
  if (existing) {
    existing.use_count = (existing.use_count || 0) + 1;
    existing.last_used_at = nowISO();
  } else {
    s.intake_history.push({ raw_input, kcal, use_count: 1, last_used_at: nowISO() });
  }
  saveDB();
}

export function decrementHistory(raw_input) {
  const s = getStore();
  const h = s.intake_history.find(x => x.raw_input === raw_input);
  if (h) {
    h.use_count = Math.max(0, (h.use_count || 0) - 1); // 不低于 0（v1 决策 3）
    saveDB();
  }
}

// ===== food_dict =====
export function getFood(name) {
  return getStore().food_dict.find(f => f.name === name) || null;
}

export function addFood(name, unit_weight, unit_kcal) {
  const s = getStore();
  const existing = s.food_dict.find(f => f.name === name);
  if (existing) {
    existing.unit_weight = unit_weight;
    existing.unit_kcal = unit_kcal;
  } else {
    s.food_dict.push({ name, unit_weight, unit_kcal });
  }
  // 用户主动把某个种子食物加回来 → 撤销它的墓碑，否则该名字一旦因数据损坏从词典丢失，
  // 补种会被墓碑拦住、永远不恢复（审计 audit1 B6 指出的问题）。
  if (Array.isArray(s.meta && s.meta.food_seed_deleted) && s.meta.food_seed_deleted.includes(name)) {
    s.meta.food_seed_deleted = s.meta.food_seed_deleted.filter(n => n !== name);
  }
  saveDB();
}

export function searchFood(query) {
  const q = String(query || '').toLowerCase();
  if (!q) return [...getStore().food_dict];
  return getStore().food_dict.filter(f => f.name.toLowerCase().includes(q));
}

// ===== weight_records =====
export function addWeight(jin, kg) {
  const s = getStore();
  s._seq.weight_records++;
  const r = { id: s._seq.weight_records, jin, kg, created_at: nowISO() };
  s.weight_records.push(r);
  saveDB();
  return r;
}

export function getWeights() {
  return [...getStore().weight_records].sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
}

// ===== allocation =====
export function addAllocation(total_kcal, start_date) {
  const s = getStore();
  s._seq.allocation++;
  const r = {
    id: s._seq.allocation,
    total_kcal, start_date,
    status: 'open',
    stop_date: null,
    batch_id: null,
    created_at: nowISO()
  };
  s.allocation.push(r);
  saveDB();
  return r;
}

export function getOpenAllocation() {
  // ⚠️ 兼容旧调用：只返回第一条 open 分摊。
  // 现已支持多条 open 并存，新代码请用 getOpenAllocations() 取全部。
  return getStore().allocation.find(a => a.status === 'open') || null;
}

// 返回所有 status==='open' 的分摊，按 start_date 升序
export function getOpenAllocations() {
  return getStore().allocation
    .filter(a => a.status === 'open')
    .sort((a, b) => String(a.start_date).localeCompare(String(b.start_date)));
}

export function updateAllocation(id, patch) {
  const s = getStore();
  const a = s.allocation.find(x => x.id === id);
  if (a) Object.assign(a, patch);
  saveDB();
  return a || null;
}

export function findAllocationByBatch(batch_id) {
  return getStore().allocation.find(a => a.batch_id === batch_id) || null;
}

// ===== 食物词典种子（50 项，与 v1 完全一致） =====
const FOOD_SEED = [
  ['蛋', 50, 70], ['鸡蛋', 50, 70], ['橘子', 150, 60], ['苹果', 200, 100],
  ['香蕉', 120, 110], ['牛奶', 250, 150], ['面包', 80, 220], ['米饭', 150, 170],
  ['面条', 200, 220], ['馒头', 100, 220], ['包子', 100, 200], ['饺子', 20, 50],
  ['烩面', 400, 500], ['拉面', 500, 550], ['炒面', 300, 450], ['汉堡', 200, 500],
  ['披萨', 100, 270], ['炸鸡', 100, 260], ['薯条', 100, 300], ['可乐', 330, 140],
  ['咖啡', 250, 80], ['奶茶', 500, 300], ['酸奶', 150, 100], ['奶酪', 30, 120],
  ['黄油', 10, 70], ['花生', 30, 170], ['核桃', 30, 190], ['杏仁', 30, 180],
  ['牛肉', 100, 250], ['猪肉', 100, 300], ['鸡肉', 100, 165], ['鱼肉', 100, 130],
  ['虾', 100, 90], ['豆腐', 100, 80], ['白菜', 100, 20], ['菠菜', 100, 25],
  ['西红柿', 100, 20], ['黄瓜', 100, 15], ['土豆', 100, 80], ['红薯', 100, 90],
  ['玉米', 100, 110], ['燕麦', 40, 150], ['巧克力', 50, 270], ['饼干', 30, 150],
  ['蛋糕', 100, 350], ['冰淇淋', 100, 200], ['薯片', 30, 160], ['方便面', 100, 450],
  ['火腿肠', 50, 100], ['粽子', 200, 350], ['月饼', 100, 400]
];

function seedFoodDict() {
  if (!_store) return;
  if (!Array.isArray(_store.food_dict)) _store.food_dict = [];
  if (!_store.meta) _store.meta = {};
  if (!Array.isArray(_store.meta.food_seed_deleted)) _store.meta.food_seed_deleted = [];

  const existing = new Set(_store.food_dict.map(f => f.name));
  const deleted = new Set(_store.meta.food_seed_deleted);

  for (const [name, w, k] of FOOD_SEED) {
    if (existing.has(name)) continue; // 不覆盖已存在的同名项（用户改过的必须保留）
    if (deleted.has(name)) continue;  // 墓碑名单里的种子项不复活
    _store.food_dict.push({ name, unit_weight: w, unit_kcal: k });
    existing.add(name);
  }
}

// 测试用：重置为新库（只动新键，不碰旧键）
export function resetDB() {
  _store = emptyStore();
  _store.app_state.push(defaultAppState());
  seedFoodDict();
  saveDB();
  if (readJSON(QUICK_KEY) == null) writeJSON(QUICK_KEY, []);
  return _store;
}

// ===== 记录编辑与食物词典维护（v2.1 追加）=====

// 改一条摄入记录。只合并传入的字段，不清空其它字段。
// 调用方改完 kcal 后**必须自己调 recalcDaily(date)** 重算当日累计 ——
// 这里不做聚合，避免 db 层反向依赖 domain 层。
export function updateIntakeRecord(id, patch) {
  const s = getStore();
  const rec = s.intake_records.find(r => r.id === id);
  if (!rec) return null;
  Object.assign(rec, patch);
  saveDB();
  return rec;
}

// 改食物词典条目（按 name 定位）。改名不在支持范围 —— 那会让历史 food_id 失联。
export function updateFood(name, unit_weight, unit_kcal) {
  const s = getStore();
  const f = s.food_dict.find(x => x.name === name);
  if (!f) return false;
  if (Number.isFinite(unit_weight)) f.unit_weight = unit_weight;
  if (Number.isFinite(unit_kcal)) f.unit_kcal = unit_kcal;
  saveDB();
  return true;
}

// 删食物词典条目。已记录的 intake_records 里存的是当时算出的 kcal（不是引用），
// 所以删词条**不会**影响历史数据 —— UI 里要这样告诉用户。
export function deleteFood(name) {
  const s = getStore();
  const i = s.food_dict.findIndex(x => x.name === name);
  if (i < 0) return false;
  s.food_dict.splice(i, 1);
  // 种子项删除后记入墓碑，防止下次补种时被复活（用户改过的种子项按 name 判，仍视为种子名）
  const isSeedName = FOOD_SEED.some(([n]) => n === name);
  if (isSeedName) {
    if (!s.meta) s.meta = {};
    if (!Array.isArray(s.meta.food_seed_deleted)) s.meta.food_seed_deleted = [];
    if (!s.meta.food_seed_deleted.includes(name)) s.meta.food_seed_deleted.push(name);
  }
  saveDB();
  return true;
}

// ===== 备份导出 / 导入（v2.2 追加）=====
// 快捷项存在独立键 QUICK_KEY 里、**不在 _store 中** —— 导出必须显式合并，否则备份会丢快捷项。
// 备份文件形状：v2 store 的全部字段 + 顶层 `quick_items` 数组。
// ⚠️ `quick_items` 只存在于备份文件里，**绝不能写进 STORAGE_KEY**（那里是纯 store）。
// ⚠️ 旧键（calorie_app_db_v1 / calorie_quick_items）全程只读，导入也只写新键。

/** 生成备份对象。返回深拷贝，改动它不会影响运行中的 store。 */
export function exportBackup() {
  const store = getStore();
  const quick = readJSON(QUICK_KEY);
  const backup = JSON.parse(JSON.stringify(store)); // 深拷贝，切断与内存对象的引用
  delete backup.quick_items;                        // 防御：万一 store 里残留该字段
  backup.quick_items = Array.isArray(quick) ? JSON.parse(JSON.stringify(quick)) : [];
  backup.meta = { ...(backup.meta || {}), schema_version: 2, exported_at: nowISO(), app: 'calorie-app' };
  return backup;
}

/**
 * 把任意来源的备份（v1 数组 / v2 对象）规整成 v2 结构，**不写盘**。
 * 返回 { store, quickItems }；quickItems 为 null 表示该备份不含快捷项（老备份）。
 * 校验失败抛错，调用方可用它先做确认框前的预检。
 */
export function normalizeBackup(parsed) {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('不是有效的备份文件');
  let v2;
  if (parsed.meta && parsed.meta.schema_version === 2) {
    v2 = { ...parsed };
  } else if (Array.isArray(parsed.daily_records)) {
    // v1 备份 → 就地升级成 v2 结构（数组 → 以日期为键的对象）
    const days = {};
    for (const r of parsed.daily_records) if (r && r.logical_date) days[r.logical_date] = r;
    const now = nowISO();
    v2 = {
      ...parsed,
      daily_records: days,
      meta: {
        ...(parsed.meta || {}),
        schema_version: 2,
        created_at: (parsed.meta && parsed.meta.created_at) || now,
        updated_at: now,
        migrated_from: 'v1-import'
      }
    };
  } else {
    throw new Error('不是有效的备份文件');
  }
  if (!Array.isArray(v2.app_state)) throw new Error('备份缺少 app_state');
  const quickItems = Array.isArray(v2.quick_items) ? v2.quick_items : null;
  delete v2.quick_items; // 快捷项有独立键，不能塞进 STORAGE_KEY
  return { store: v2, quickItems };
}

/**
 * 应用备份：只写新键（STORAGE_KEY / QUICK_KEY），绝不碰旧键。
 * 备份不含 quick_items 时**保留**现有快捷项（不能把用户的快捷项清空）。
 * 返回 { days, quick }，quick 为 null 表示未覆盖快捷项。
 */
export function importBackup(parsed) {
  const { store, quickItems } = normalizeBackup(parsed);
  const days = Object.keys(store.daily_records || {}).length;
  if (!writeJSON(STORAGE_KEY, store)) throw new Error('写入失败（存储空间不足？）');
  if (quickItems) writeJSON(QUICK_KEY, quickItems);
  _store = null;          // 让下次 getStore() 从磁盘重读，避免内存里留着旧数据
  _migrationError = null;
  return { days, quick: quickItems ? quickItems.length : null };
}
