// UI 组件：toast / openSheet / closeSheet / confirmSheet / el
const sheetMask = () => document.getElementById('sheetMask');
const sheetEl = () => document.getElementById('sheet');
const toastEl = () => document.getElementById('toast');

let sheetCloseCallback = null;
let toastTimer;
// 抽屉与浏览器/安卓返回键的协作状态
let sheetPushed = false;   // 是否已经为当前抽屉压过一条 history
let skipNextPop = false;   // closeSheet 自己触发的 back 引发的 popstate 要忽略

function hideSheet() {
  const mask = sheetMask();
  if (mask) mask.classList.remove('is-open');
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
  sheet.innerHTML = `
    <div class="sheet__handle"></div>
    <div class="sheet__head"><h3 class="sheet__title">${esc(title || '')}</h3></div>
    <div class="sheet__body">${body || ''}</div>
    ${footer ? `<div class="sheet__foot">${footer}</div>` : ''}
  `;
  mask.classList.add('is-open');
  sheetCloseCallback = onClose || null;
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