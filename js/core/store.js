export const STORAGE_KEY  = 'calorie.db.v2';
export const LEGACY_KEY   = 'calorie_app_db_v1';
export const QUICK_KEY    = 'calorie.quick.v2';
export const LEGACY_QUICK = 'calorie_quick_items';

export function readRaw(key) {
  try { return localStorage.getItem(key); } catch (e) { return null; }
}

export function readJSON(key) {
  const raw = readRaw(key);
  if (raw == null) return null;
  try { return JSON.parse(raw); } catch (e) { return null; }
}

export function writeJSON(key, obj) {
  try { localStorage.setItem(key, JSON.stringify(obj)); return true; }
  catch (e) {
    if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
      try { window.dispatchEvent(new CustomEvent('calorie:storage-error', { detail: { key, message: (e && e.message) ? e.message : String(e) } })); } catch (err) {}
    }
    return false;
  }
}

export function removeKey(key) {
  try { localStorage.removeItem(key); } catch (e) {}
}

export function readLegacy() {
  const raw = localStorage.getItem(LEGACY_KEY);
  if (raw == null) throw new Error('旧数据无法解析');
  try { return JSON.parse(raw); } catch (e) { throw new Error('旧数据无法解析'); }
}

export function writeLegacy(serialized) {
  localStorage.setItem(LEGACY_KEY, serialized);
}
