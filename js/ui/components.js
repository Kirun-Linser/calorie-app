// UI 组件：toast / openSheet / closeSheet / confirmSheet / el
// v2 — 抽屉叠层栈 + toast 队列

// ===== DOM 引用（仅基础层复用） =====
const baseMask = () => document.getElementById('sheetMask');
const baseSheet = () => document.getElementById('sheet');
const toastEl = () => document.getElementById('toast');

// ===== Toast 队列 =====
let toastTimer;
let toastQueue = [];
let toastActive = false;

function flushToast() {
  if (toastQueue.length === 0) { toastActive = false; return; }
  toastActive = true;
  const { msg, type } = toastQueue.shift();
  const el = toastEl();
  if (!el) return;
  el.textContent = msg;
  el.className = 'toast is-show' + (type ? ' toast--' + type : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    if (toastQueue.length === 0) {
      el.className = 'toast';
    }
    flushToast();
  }, 2200);
}

// ===== 抽屉叠层栈 =====
// 每层：{ id, mask, sheet, isBase, onClose, focusEl, keyHandler, historyPushed }
let sheetStack = [];
let nextLayerId = 0;
let skipNextPop = false;
let preSheetScrollY = 0;
let preSheetFocusEl = null;

const FOCUSABLE_SELECTOR = [
  'a[href]','area[href]',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])','textarea:not([disabled])',
  'button:not([disabled])','iframe','object','embed',
  '[contenteditable]','[tabindex]:not([tabindex="-1"])',
].join(',');

function getFocusables(sheet) {
  return Array.from(sheet.querySelectorAll(FOCUSABLE_SELECTOR))
    .filter(el => el.offsetWidth || el.offsetHeight || el === document.activeElement);
}

function handleTab(e, sheet) {
  if (e.key !== 'Tab') return;
  const focusables = getFocusables(sheet);
  if (focusables.length === 0) { e.preventDefault(); sheet.focus(); return; }
  const first = focusables[0], last = focusables[focusables.length - 1];
  if (e.shiftKey) {
    if (document.activeElement === first) { e.preventDefault(); last.focus(); }
  } else {
    if (document.activeElement === last) { e.preventDefault(); first.focus(); }
  }
}

function topLayer() {
  return sheetStack.length > 0 ? sheetStack[sheetStack.length - 1] : null;
}

// ---- 创建动态层（mask 包 sheet，与基础层结构一致） ----
function createSheetLayer() {
  const id = ++nextLayerId;
  const mask = document.createElement('div');
  mask.className = 'sheet-mask';
  mask.setAttribute('data-sheet-layer', String(id));
  mask.setAttribute('id', 'sheetMask-' + id);
  mask.style.zIndex = String(100 + id * 10);

  const sheet = document.createElement('div');
  sheet.className = 'sheet';
  sheet.setAttribute('id', 'sheet-' + id);
  sheet.setAttribute('data-sheet-layer', String(id));
  sheet.style.zIndex = String(101 + id * 10);

  mask.appendChild(sheet);
  document.body.appendChild(mask);

  return { mask, sheet, id, isBase: false };
}

function ensureLayer() {
  if (sheetStack.length === 0) {
    const m = baseMask(), s = baseSheet();
    if (!m || !s) return null;
    // 基础层也打上标记
    m.setAttribute('data-sheet-layer', '0');
    s.setAttribute('data-sheet-layer', '0');
    return { mask: m, sheet: s, id: 0, isBase: true };
  }
  return createSheetLayer();
}

// ---- history 操作 ----
function pushHistory() {
  if (typeof history !== 'undefined' && history.pushState) {
    try { history.pushState({ __calSheet: 1 }, ''); } catch (e) {}
  }
}

function backHistory() {
  skipNextPop = true;
  try { history.back(); } catch (e) { skipNextPop = false; }
}

// ---- 层隐藏 ----
function hideLayer(layer) {
  if (!layer) return;
  if (layer.keyHandler) {
    try { document.removeEventListener('keydown', layer.keyHandler); } catch (e) {}
    layer.keyHandler = null;
  }
  if (layer.mask) layer.mask.classList.remove('is-open');
  if (layer.sheet && document.activeElement && layer.sheet.contains(document.activeElement)) {
    try { document.activeElement.blur(); } catch (e) {}
  }
  if (layer.onClose) {
    try { layer.onClose(); } catch (e) {}
    layer.onClose = null;
  }
  // 动态层从 DOM 移除
  if (!layer.isBase && layer.mask && layer.mask.parentNode) {
    layer.mask.parentNode.removeChild(layer.mask);
  }
}

// ---- 层恢复（上层关闭后重新激活下层） ----
function restoreLayer(layer) {
  if (!layer) return;
  if (layer.mask) layer.mask.classList.add('is-open');
  if (layer.keyHandler) {
    try { document.removeEventListener('keydown', layer.keyHandler); } catch (e) {}
    try { document.addEventListener('keydown', layer.keyHandler); } catch (e) {}
  }
  const focusables = getFocusables(layer.sheet);
  try {
    if (focusables.length > 0) focusables[0].focus();
    else if (layer.sheet) layer.sheet.focus();
  } catch (e) {}
}

// ---- 背景滚动锁 ----
function lockBody() {
  if (typeof document !== 'undefined') {
    if (typeof window !== 'undefined' && 'scrollY' in window) {
      preSheetScrollY = window.scrollY;
    }
    preSheetFocusEl = document.activeElement || null;
    document.body.classList.add('modal-open');
  }
}

function unlockBody() {
  if (typeof document !== 'undefined') {
    document.body.classList.remove('modal-open');
    if (typeof window !== 'undefined' && 'scrollY' in window) {
      try { window.scrollTo(0, preSheetScrollY || 0); } catch (e) {}
    }
    if (preSheetFocusEl && typeof preSheetFocusEl.focus === 'function') {
      if (document.body.contains(preSheetFocusEl)) {
        try { preSheetFocusEl.focus(); } catch (e) {}
      }
    }
    preSheetFocusEl = null;
    preSheetScrollY = 0;
  }
}

function installTrap(layer) {
  if (!layer || !layer.sheet) return;
  const prev = topLayer();
  if (prev && prev.keyHandler) {
    try { document.removeEventListener('keydown', prev.keyHandler); } catch (e) {}
  }
  layer.keyHandler = (e) => handleTab(e, layer.sheet);
  try { document.addEventListener('keydown', layer.keyHandler); } catch (e) {}
  if (!layer.sheet.hasAttribute('tabindex')) layer.sheet.setAttribute('tabindex', '-1');
  const focusables = getFocusables(layer.sheet);
  try {
    if (focusables.length > 0) focusables[0].focus();
    else layer.sheet.focus();
  } catch (e) {}
}

// ---- 同步顶层焦点陷阱到当前层 ----
function syncTopTrap() {
  const prev = sheetStack.length > 1 ? sheetStack[sheetStack.length - 2] : null;
  if (prev && prev.keyHandler) {
    try { document.removeEventListener('keydown', prev.keyHandler); } catch (e) {}
  }
  const top = topLayer();
  if (top && top.keyHandler) {
    try { document.addEventListener('keydown', top.keyHandler); } catch (e) {}
  }
}

// ===== popstate：安卓返回键 / 浏览器后退 =====
if (typeof window !== 'undefined' && window.addEventListener) {
  window.addEventListener('popstate', () => {
    if (skipNextPop) { skipNextPop = false; return; }
    if (sheetStack.length > 0) {
      const layer = sheetStack.pop();
      hideLayer(layer);
      const prev = topLayer();
      if (prev) {
        restoreLayer(prev);
      } else {
        unlockBody();
      }
    }
  });
}

// ===== 导出（签名不变） =====

export function esc(v) {
  if (v == null) return '';
  return String(v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

export function toast(msg, type = '') {
  const el = toastEl();
  if (!el) return;
  toastQueue.push({ msg, type });
  if (!toastActive) flushToast();
}

export function openSheet({ title, body, footer, onClose } = {}) {
  const layer = ensureLayer();
  if (!layer) return () => {};

  if (sheetStack.length === 0) lockBody();

  pushHistory();

  layer.sheet.innerHTML = `
    <div class="sheet__handle"></div>
    <div class="sheet__head"><h3 class="sheet__title">${esc(title || '')}</h3></div>
    <div class="sheet__body">${body || ''}</div>
    ${footer ? `<div class="sheet__foot">${footer}</div>` : ''}
  `;

  layer.mask.classList.add('is-open');
  layer.onClose = onClose || null;
  layer.historyPushed = true;

  sheetStack.push(layer);
  installTrap(layer);

  // ⚠️ 2026-11-03 实测踩到：抽屉（尤其是长按后弹出的 confirmSheet）刚打开那一刻，
  // 浏览器可能紧接着为**触发本次打开的那次手势**补派一个 click。
  // 若这个 click 落在遮罩上，会立刻把刚打开的抽屉关掉 ——
  // 症状：确认框标题都渲染出来了，is-open 却是 false，用户永远点不到「确定」。
  // 修法：记录打开时间，250ms 内的遮罩点击视为"上一次手势的余波"，忽略。
  layer.openedAt = Date.now();
  layer.mask.onclick = (e) => {
    if (e.target !== layer.mask) return;
    if (Date.now() - (layer.openedAt || 0) < 250) return; // 吞掉打开瞬间的余波点击
    closeSheet();
  };

  return () => closeSheet();
}

export function closeSheet() {
  if (sheetStack.length === 0) return;
  const layer = sheetStack.pop();
  hideLayer(layer);

  if (layer.historyPushed) backHistory();

  const prev = topLayer();
  if (prev) {
    restoreLayer(prev);
  } else {
    unlockBody();
  }
}

export function confirmSheet({ title, text, okText = '确定', danger = false } = {}) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };

    const closer = openSheet({
      title: title || '确认',
      body: `<p class="confirm-text">${esc(text || '')}</p>`,
      footer: `
        <button class="btn btn--ghost" id="csCancel">取消</button>
        <button class="btn ${danger ? 'btn--danger' : 'btn--primary'}" id="csOk">${esc(okText)}</button>
      `,
      onClose: () => done(false),
    });

    // 用当前顶层 sheet 的 querySelector 避免跨层 ID 冲突
    setTimeout(() => {
      const layer = topLayer();
      const s = layer ? layer.sheet : null;
      if (!s) { done(false); return; }
      const ok = s.querySelector('#csOk');
      const cancel = s.querySelector('#csCancel');
      if (ok) ok.onclick = () => { done(true); closer(); };
      if (cancel) cancel.onclick = () => { done(false); closer(); };
    }, 0);
  });
}

export function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'class' || k === 'className') node.className = v;
      else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2).toLowerCase(), v);
      else if (v != null) node.setAttribute(k, v);
    }
  }
  const arr = Array.isArray(children) ? children : [children];
  for (const c of arr) {
    if (c == null) continue;
    if (typeof c === 'string' || typeof c === 'number') node.appendChild(document.createTextNode(String(c)));
    else node.appendChild(c);
  }
  return node;
}