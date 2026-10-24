// UI 组件：toast / openSheet / closeSheet / confirmSheet / el
const sheetMask = () => document.getElementById('sheetMask');
const sheetEl = () => document.getElementById('sheet');
const toastEl = () => document.getElementById('toast');

let sheetCloseCallback = null;
let toastTimer;
// 抽屉与浏览器/安卓返回键的协作状态
let sheetPushed = false;   // 是否已经为当前抽屉压过一条 history
let skipNextPop = false;   // closeSheet 自己触发的 back 引发的 popstate 要忽略
// 滚动锁 + 焦点陷阱 + 焦点恢复
let sheetOpenFocusEl = null; // 打开抽屉前的焦点元素，关闭时还原
let sheetScrollY = 0;        // 打开抽屉前的页面滚动位置
let sheetKeyHandler = null;  // Tab 陷阱的 keydown 监听器（便于移除）

// 抽屉内可聚焦元素选择器（标准列表，不含 tabindex=-1 的）
const FOCUSABLE_SELECTOR = [
  'a[href]',
  'area[href]',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  'button:not([disabled])',
  'iframe',
  'object',
  'embed',
  '[contenteditable]',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

function getFocusables(sheet) {
  return Array.from(sheet.querySelectorAll(FOCUSABLE_SELECTOR))
    .filter(el => el.offsetWidth || el.offsetHeight || el === document.activeElement);
}

function handleTab(e, sheet) {
  if (e.key !== 'Tab') return;
  const focusables = getFocusables(sheet);
  if (focusables.length === 0) { e.preventDefault(); sheet.focus(); return; }
  const first = focusables[0];
  const last = focusables[focusables.length - 1];
  if (e.shiftKey) {
    if (document.activeElement === first) { e.preventDefault(); last.focus(); }
  } else {
    if (document.activeElement === last) { e.preventDefault(); first.focus(); }
  }
}

function hideSheet() {
  const mask = sheetMask();
  const sheet = sheetEl();
  if (mask) mask.classList.remove('is-open');
  // 移除 Tab 陷阱监听器
  if (sheetKeyHandler) {
    try { document.removeEventListener('keydown', sheetKeyHandler); } catch (e) {}
    sheetKeyHandler = null;
  }
  // 恢复背景滚动与滚动位置
  if (typeof document !== 'undefined') {
    document.body.classList.remove('modal-open');
    if (typeof window !== 'undefined' && 'scrollY' in window) {
      try { window.scrollTo(0, sheetScrollY || 0); } catch (e) {}
    }
  }
  // 焦点回到打开前的元素（若仍在文档中）
  if (sheetOpenFocusEl && typeof sheetOpenFocusEl.focus === 'function') {
    if (typeof document !== 'undefined' && document.body.contains(sheetOpenFocusEl)) {
      try { sheetOpenFocusEl.focus(); } catch (e) {}
    }
  }
  sheetOpenFocusEl = null;
  // 若焦点仍留在抽屉内（触发元素不可聚焦 / 程序化打开 / iOS 点击不聚焦按钮），
  // 必须移出：否则键盘与读屏用户会进到已隐藏的层里。
  if (sheet && typeof document !== 'undefined' && document.activeElement && sheet.contains(document.activeElement)) {
    try { document.activeElement.blur(); } catch (e) {}
  }
  if (sheetCloseCallback) { try { sheetCloseCallback(); } catch (e) {} }
  sheetCloseCallback = null;
}

// 安卓返回键 / 浏览器后退：抽屉开着时先关抽屉，而不是直接退出应用
if (typeof window !== 'undefined' && window.addEventListener) {
  window.addEventListener('popstate', () => {
    if (skipNextPop) { skipNextPop = false; return; }
    const m = sheetMask();
    if (m && m.classList.contains('is-open')) {
      sheetPushed = false;
      hideSheet();
    }
  });
}

export function esc(v) {
  if (v == null) return '';
  return String(v)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function toast(msg, type = '') {
  const el = toastEl();
  if (!el) return;
  el.textContent = msg;
  el.className = 'toast is-show' + (type ? ' toast--' + type : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.className = 'toast'; }, 2200);
}

export function openSheet({ title, body, footer, onClose } = {}) {
  const mask = sheetMask();
  const sheet = sheetEl();
  if (!mask || !sheet) return () => {};
  // 为这次抽屉压一条 history：安卓返回键会先关抽屉而不是退出应用
  if (!sheetPushed && typeof history !== 'undefined' && history.pushState) {
    try { history.pushState({ __calSheet: 1 }, ''); sheetPushed = true; } catch (e) {}
  }
  // 记录打开前的焦点与滚动位置（焦点恢复 + 滚动位置还原）
  if (typeof document !== 'undefined') {
    sheetOpenFocusEl = document.activeElement || null;
    if (typeof window !== 'undefined' && 'scrollY' in window) {
      sheetScrollY = window.scrollY;
    }
  }
  sheet.innerHTML = `
    <div class="sheet__handle"></div>
    <div class="sheet__head"><h3 class="sheet__title">${esc(title || '')}</h3></div>
    <div class="sheet__body">${body || ''}</div>
    ${footer ? `<div class="sheet__foot">${footer}</div>` : ''}
  `;
  // 锁定背景滚动（iOS 仍可能穿透，配合 CSS 的 touch-action:none / overscroll-behavior:contain）
  if (typeof document !== 'undefined') {
    document.body.classList.add('modal-open');
  }
  mask.classList.add('is-open');
  sheetCloseCallback = onClose || null;
  // 让抽屉容器可被程序聚焦（无 focusable 时的兜底）
  if (!sheet.hasAttribute('tabindex')) sheet.setAttribute('tabindex', '-1');
  // 安装 Tab 焦点陷阱
  if (sheetKeyHandler) {
    try { document.removeEventListener('keydown', sheetKeyHandler); } catch (e) {}
  }
  sheetKeyHandler = (e) => handleTab(e, sheet);
  try { document.addEventListener('keydown', sheetKeyHandler); } catch (e) {}
  // 焦点移到抽屉内第一个可聚焦元素（无则聚焦抽屉容器）
  const focusables = getFocusables(sheet);
  try {
    if (focusables.length > 0) focusables[0].focus();
    else sheet.focus();
  } catch (e) {}
  const close = () => closeSheet();
  mask.onclick = (e) => { if (e.target === mask) closeSheet(); };
  return close;
}

export function closeSheet() {
  hideSheet();
  if (sheetPushed) {
    sheetPushed = false;
    skipNextPop = true;
    try { history.back(); } catch (e) { skipNextPop = false; }
  }
}

export function confirmSheet({ title, text, okText = '确定', danger = false } = {}) {
  return new Promise((resolve) => {
    // 关键：closeSheet() 会触发 onClose → resolve(false)。若不先 settle 再关闭，
    // 点「确定」时 resolve(true) 会被已 settle 的 Promise 忽略，返回值恒为 false。
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };
    openSheet({
      title: title || '确认',
      body: `<p class="confirm-text">${esc(text || '')}</p>`,
      footer: `
        <button class="btn btn--ghost" id="csCancel">取消</button>
        <button class="btn ${danger ? 'btn--danger' : 'btn--primary'}" id="csOk">${esc(okText)}</button>
      `,
      onClose: () => done(false),
    });
    setTimeout(() => {
      const ok = document.getElementById('csOk');
      const cancel = document.getElementById('csCancel');
      if (ok) ok.onclick = () => { done(true); closeSheet(); };
      if (cancel) cancel.onclick = () => { done(false); closeSheet(); };
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