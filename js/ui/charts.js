// 图表引擎（SVG）：CSS 变量可生效；高 DPI 由 viewBox 自适应
function token(name, fallback) {
  try {
    const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return v || fallback;
  } catch (e) {
    return fallback;
  }
}

const TOKENS = {
  accent: () => token('--accent', '#2DD4BF'),
  accentStrong: () => token('--accent-strong', '#14B8A6'),
  danger: () => token('--danger', '#FB7185'),
  text: () => token('--text', '#E8EEF4'),
  text2: () => token('--text-2', '#A9B6C2'),
  text3: () => token('--text-3', '#6E7C8A'),
  line: () => token('--line', '#212B35'),
  bgElev: () => token('--bg-elev', '#11171D'),
};

const reducedMotion = () => window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

function clear(container) {
  container.innerHTML = '';
}

function ns(tag) { return document.createElementNS('http://www.w3.org/2000/svg', tag); }

function observeResize(container, renderFn) {
  if (!window.ResizeObserver) return () => {};
  const ro = new ResizeObserver(() => renderFn());
  ro.observe(container);
  return () => ro.disconnect();
}

const registry = new WeakMap(); // container -> { cleanup, lastRender }

export function destroyCharts(container) {
  const info = registry.get(container);
  if (info) {
    if (info.cleanup) info.cleanup();
    registry.delete(container);
  }
  if (container) container.innerHTML = '';
}

// 单调三次插值（Fritsch–Carlson）→ SVG cubic Bezier 的 d 字符串。
// 为什么不用普通 Catmull-Rom：体重是单调序列，普通样条在拐点会「过冲」，
// 画出数据里并不存在的回升段 —— 那是可视化错误。这里用 Fritsch–Carlson
// 对切线做限制，保证每个区间内单调、不越出相邻两点范围。
export function monotonePathD(pts) {
  const n = pts.length;
  if (n === 0) return '';
  if (n === 1) return `M${pts[0].x},${pts[0].y}`;
  if (n === 2) return `M${pts[0].x},${pts[0].y} L${pts[1].x},${pts[1].y}`;

  const dx = [], dy = [], s = [];
  for (let i = 0; i < n - 1; i++) {
    dx[i] = pts[i + 1].x - pts[i].x || 1e-6;
    dy[i] = pts[i + 1].y - pts[i].y;
    s[i] = dy[i] / dx[i];
  }
  // 初始切线：端点单侧差分，中间点取相邻斜率均值；极值点切线置 0
  const m = new Array(n);
  m[0] = s[0];
  m[n - 1] = s[n - 2];
  for (let i = 1; i < n - 1; i++) {
    m[i] = (s[i - 1] * s[i] <= 0) ? 0 : (s[i - 1] + s[i]) / 2;
  }
  // Fritsch–Carlson 限制：把切线压进「绝对值不超过 3 倍相邻斜率」的圆锥内
  for (let i = 0; i < n - 1; i++) {
    if (s[i] === 0) { m[i] = 0; m[i + 1] = 0; continue; }
    const a = m[i] / s[i];
    const b = m[i + 1] / s[i];
    const h = Math.hypot(a, b);
    if (h > 3) {
      const t = 3 / h;
      m[i] = t * a * s[i];
      m[i + 1] = t * b * s[i];
    }
  }

  let d = `M${pts[0].x},${pts[0].y}`;
  for (let i = 0; i < n - 1; i++) {
    const third = dx[i] / 3;
    const c1x = pts[i].x + third, c1y = pts[i].y + m[i] * third;
    const c2x = pts[i + 1].x - third, c2y = pts[i + 1].y - m[i + 1] * third;
    d += ` C${c1x.toFixed(2)},${c1y.toFixed(2)} ${c2x.toFixed(2)},${c2y.toFixed(2)} ${pts[i + 1].x.toFixed(2)},${pts[i + 1].y.toFixed(2)}`;
  }
  return d;
}

export function renderWeightTrend(container, points, opts = {}) {
  opts = opts || {};
  const title = opts.title;
  const formatValue = opts.formatValue || (v => String(v));
  const pred = (opts.prediction && Number.isFinite(Number(opts.prediction.jin))) ? opts.prediction : null;
  const predDays = pred && Number.isFinite(Number(pred.days)) ? Number(pred.days) : 30;
  const predUncKg = pred && Number.isFinite(Number(pred.uncertaintyKg)) ? Number(pred.uncertaintyKg) : 1.5;

  destroyCharts(container);
  container.setAttribute('role', 'img');

  if (!points || points.length < 2) {
    container.setAttribute('aria-label', '体重趋势，至少记录 2 次才能看趋势');
    const empty = document.createElement('div');
    empty.className = 'chart__empty';
    empty.textContent = '至少记录 2 次才能看趋势';
    container.appendChild(empty);
    // sr-only table (empty)
    const sr = document.createElement('table');
    sr.className = 'sr-only';
    sr.innerHTML = '<caption>体重记录</caption><thead><tr><th>日期</th><th>斤</th></tr></thead><tbody></tbody>';
    container.appendChild(sr);
    return;
  }

  const vals = points.map(p => p.jin);
  const first = points[0];
  const last = points[points.length - 1];
  const dir = last.jin < first.jin ? '降至' : (last.jin > first.jin ? '升至' : '持平');
  let ariaLabel = `体重趋势，从 ${formatValue(first.jin)} 斤${dir} ${formatValue(last.jin)} 斤，共 ${points.length} 次记录`;
  if (pred) ariaLabel += `，按当前趋势预测 ${predDays} 天后 ${formatValue(pred.jin)} 斤（误差约 ±${predUncKg}kg）`;
  container.setAttribute('aria-label', ariaLabel);

  function render() {
    const old = container.querySelector('svg.chart__svg');
    if (old) old.remove();
    const w = container.clientWidth || 320;
    const h = Math.max(170, Math.round(w * 0.6));
    const pad = { t: 20, r: 16, b: 30, l: 46 };
    const iw = w - pad.l - pad.r;
    const ih = h - pad.t - pad.b;

    // 历史段与预测段的横向分配：有预测时历史占 78%（保住曲线可读性），预测占 22%
    const histW = pred ? iw * 0.78 : iw;
    const n = points.length;
    const xOf = i => pad.l + (n > 1 ? (i / (n - 1)) * histW : histW / 2);

    // Y 轴范围**只按历史数据**算。
    // 若把 30 天预测值也纳入范围，历史段会被压成一条几乎水平的线（实测：3.3 斤变化
    // 只占 19% 高度），"加了预测反而看不清当期变化" —— 这是取舍，宁可让预测点钳在边缘。
    let min = Math.min(...vals);
    let max = Math.max(...vals);
    const span = (max - min) || 1;
    const yMin = min - span * 0.12;
    const yMax = max + span * 0.12;
    const yRange = yMax - yMin || 1;
    const yOf = v => pad.t + (1 - (v - yMin) / yRange) * ih;

    const svg = ns('svg');
    svg.setAttribute('class', 'chart__svg');
    svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
    svg.setAttribute('width', '100%');
    svg.setAttribute('height', String(h));
    svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');

    // 轴
    const axis = ns('line');
    axis.setAttribute('x1', pad.l); axis.setAttribute('x2', pad.l);
    axis.setAttribute('y1', pad.t); axis.setAttribute('y2', pad.t + ih);
    axis.setAttribute('stroke', TOKENS.line()); axis.setAttribute('stroke-width', '1');
    svg.appendChild(axis);
    const bottom = ns('line');
    bottom.setAttribute('x1', pad.l); bottom.setAttribute('x2', pad.l + iw);
    bottom.setAttribute('y1', pad.t + ih); bottom.setAttribute('y2', pad.t + ih);
    bottom.setAttribute('stroke', TOKENS.line()); bottom.setAttribute('stroke-width', '1');
    svg.appendChild(bottom);

    // Y 轴上下界标注（取整到 0.1）
    const labMin = ns('text');
    labMin.setAttribute('x', pad.l - 8); labMin.setAttribute('y', pad.t + ih);
    labMin.setAttribute('text-anchor', 'end'); labMin.setAttribute('dominant-baseline', 'middle');
    labMin.setAttribute('fill', TOKENS.text3()); labMin.setAttribute('font-size', '10');
    labMin.textContent = formatValue(Math.round(yMin * 10) / 10);
    svg.appendChild(labMin);
    const labMax = ns('text');
    labMax.setAttribute('x', pad.l - 8); labMax.setAttribute('y', pad.t);
    labMax.setAttribute('text-anchor', 'end'); labMax.setAttribute('dominant-baseline', 'middle');
    labMax.setAttribute('fill', TOKENS.text3()); labMax.setAttribute('font-size', '10');
    labMax.textContent = formatValue(Math.round(yMax * 10) / 10);
    svg.appendChild(labMax);

    // ===== 预测：锥形误差带 + 虚线（预测点超出 Y 轴范围时钳到画布边缘）=====
    const lastX = xOf(n - 1), lastY = yOf(last.jin);
    if (pred) {
      const predX = pad.l + histW + iw * 0.22;
      const rawPredY = yOf(pred.jin);
      const edgeTop = pad.t + 4, edgeBottom = pad.t + ih - 4;
      const clamped = rawPredY < edgeTop || rawPredY > edgeBottom;
      const predY = Math.max(edgeTop, Math.min(edgeBottom, rawPredY));
      // ±uncertaintyKg 换算成斤再换算成像素（jin = kg × 2）；越界时按剩余空间等比缩
      const fullHalf = Math.abs((predUncKg * 2) / yRange * ih);
      const room = Math.max(0, edgeBottom - predY);
      const bandHalf = clamped ? Math.min(fullHalf, room) : fullHalf;

      const band = ns('path');
      band.setAttribute('d', `M${lastX},${lastY} L${predX},${predY - bandHalf} L${predX},${predY + bandHalf} Z`);
      band.setAttribute('fill', TOKENS.accent());
      band.setAttribute('fill-opacity', '0.14');
      band.setAttribute('stroke', 'none');
      svg.appendChild(band);

      const pl = ns('line');
      pl.setAttribute('x1', lastX); pl.setAttribute('y1', lastY);
      pl.setAttribute('x2', predX); pl.setAttribute('y2', predY);
      pl.setAttribute('stroke', TOKENS.accent());
      pl.setAttribute('stroke-width', '2');
      pl.setAttribute('stroke-dasharray', '5 4');
      pl.setAttribute('stroke-linecap', 'round');
      svg.appendChild(pl);

      if (clamped) {
        // 预测值超出当前视图 → 画一个向下的箭头，表示"趋势还在往那边走"
        const tri = ns('polygon');
        tri.setAttribute('points', `${predX - 4},${predY - 6} ${predX + 4},${predY - 6} ${predX},${predY}`);
        tri.setAttribute('fill', TOKENS.accent());
        svg.appendChild(tri);
      } else {
        const pc = ns('circle');
        pc.setAttribute('cx', predX); pc.setAttribute('cy', predY);
        pc.setAttribute('r', '4');
        pc.setAttribute('fill', TOKENS.bgElev());
        pc.setAttribute('stroke', TOKENS.accent());
        pc.setAttribute('stroke-width', '2');
        svg.appendChild(pc);
      }

      // 标签只标天数：具体预测数值在卡片顶部文字与 sr-only 表里，
      // 不在同一张图上混排两种时间尺度（避免读者误以为预测段与历史段同刻度）。
      const pt = ns('text');
      pt.setAttribute('x', predX);
      pt.setAttribute('y', Math.max(pad.t + 10, Math.min(predY - 10, edgeBottom - 4)));
      pt.setAttribute('text-anchor', 'end');
      pt.setAttribute('fill', TOKENS.accent());
      pt.setAttribute('font-size', '10');
      pt.textContent = `+${predDays}d`;
      svg.appendChild(pt);
    }

    // ===== 历史折线（单调三次插值，平滑且不过冲）=====
    const histPts = points.map((p, i) => ({ x: xOf(i), y: yOf(p.jin) }));
    const line = ns('path');
    line.setAttribute('d', monotonePathD(histPts));
    line.setAttribute('fill', 'none');
    line.setAttribute('stroke', TOKENS.accent());
    line.setAttribute('stroke-width', '2');
    line.setAttribute('stroke-linejoin', 'round');
    line.setAttribute('stroke-linecap', 'round');
    svg.appendChild(line);

    // 数据点
    points.forEach((p, i) => {
      const cx = xOf(i), cy = yOf(p.jin);
      const c = ns('circle');
      c.setAttribute('cx', cx); c.setAttribute('cy', cy);
      const isLast = i === n - 1;
      c.setAttribute('r', isLast ? '4.5' : '2.8');
      c.setAttribute('fill', isLast ? TOKENS.accentStrong() : TOKENS.accent());
      c.setAttribute('stroke', TOKENS.bgElev());
      c.setAttribute('stroke-width', '2');
      svg.appendChild(c);
    });

    // X 轴首末日期
    const xFirst = ns('text');
    xFirst.setAttribute('x', pad.l); xFirst.setAttribute('y', h - 8);
    xFirst.setAttribute('fill', TOKENS.text3()); xFirst.setAttribute('font-size', '10');
    xFirst.textContent = String(points[0].at).slice(0, 10);
    svg.appendChild(xFirst);
    const xLast = ns('text');
    xLast.setAttribute('x', pad.l + histW); xLast.setAttribute('y', h - 8);
    xLast.setAttribute('text-anchor', 'end');
    xLast.setAttribute('fill', TOKENS.text3()); xLast.setAttribute('font-size', '10');
    xLast.textContent = String(last.at).slice(0, 10);
    svg.appendChild(xLast);

    if (title) {
      const t = ns('text');
      t.setAttribute('x', pad.l); t.setAttribute('y', 12);
      t.setAttribute('fill', TOKENS.text2()); t.setAttribute('font-size', '12');
      t.textContent = title;
      svg.appendChild(t);
    }

    container.appendChild(svg);
  }

  render();

  // sr-only 数据表（含预测行）
  const sr = document.createElement('table');
  sr.className = 'sr-only';
  let rows = '<caption>体重记录</caption><thead><tr><th>日期</th><th>斤</th></tr></thead><tbody>';
  for (const p of points) rows += `<tr><td>${String(p.at).slice(0, 10)}</td><td>${formatValue(p.jin)}</td></tr>`;
  if (pred) rows += `<tr><td>预测 ${predDays} 天后</td><td>${formatValue(pred.jin)}（误差约 ±${predUncKg}kg）</td></tr>`;
  rows += '</tbody>';
  sr.innerHTML = rows;
  container.appendChild(sr);

  const cleanup = observeResize(container, render);
  registry.set(container, { cleanup, render });
}

export function renderWeekBars(container, days, opts = {}) {
  opts = opts || {};
  const onSelect = opts.onSelect;

  destroyCharts(container);
  container.setAttribute('role', 'img');

  const overCount = days.filter(d => d.kcal > d.target).length;
  const ariaLabel = `一周热量柱状图，共 ${days.length} 天，${overCount} 天超标`;
  container.setAttribute('aria-label', ariaLabel);

  function render() {
    const old = container.querySelector('svg.chart__svg');
    if (old) old.remove();
    const w = container.clientWidth || 320;
    const h = Math.max(180, Math.round(w * 0.6));
    const pad = { t: 24, r: 12, b: 36, l: 12 };
    const iw = w - pad.l - pad.r;
    const ih = h - pad.t - pad.b;
    const n = days.length || 1;
    const gap = 6;
    const bw = (iw - gap * (n - 1)) / n;
    const maxKcal = Math.max(...days.map(d => Math.max(d.kcal, d.target)), 1);
    const yScale = ih / maxKcal;

    const svg = ns('svg');
    svg.setAttribute('class', 'chart__svg');
    svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
    svg.setAttribute('width', '100%');
    svg.setAttribute('height', String(h));

    // target dashed line (use first target)
    const target = days[0] ? days[0].target : 0;
    const ty = pad.t + ih - target * yScale;
    const tline = ns('line');
    tline.setAttribute('x1', pad.l); tline.setAttribute('x2', pad.l + iw);
    tline.setAttribute('y1', ty); tline.setAttribute('y2', ty);
    tline.setAttribute('stroke', TOKENS.text3());
    tline.setAttribute('stroke-width', '1');
    tline.setAttribute('stroke-dasharray', '4 4');
    svg.appendChild(tline);

    days.forEach((d, i) => {
      const x = pad.l + i * (bw + gap);
      const barH = d.kcal * yScale;
      const y = pad.t + ih - barH;
      const over = d.kcal > d.target;
      const rect = ns('rect');
      rect.setAttribute('x', x);
      rect.setAttribute('y', y);
      rect.setAttribute('width', bw);
      rect.setAttribute('height', barH);
      rect.setAttribute('rx', '4');
      if (d.isToday) rect.setAttribute('fill', TOKENS.accent());
      else if (over) rect.setAttribute('fill', TOKENS.danger());
      else rect.setAttribute('fill', TOKENS.text3());
      // opacity for non-today
      if (!d.isToday && !over) rect.setAttribute('fill-opacity', '0.5');
      svg.appendChild(rect);

      // over marker triangle
      if (over) {
        const tri = ns('polygon');
        const cx = x + bw / 2;
        const ty2 = y - 8;
        tri.setAttribute('points', `${cx-4},${ty2+6} ${cx+4},${ty2+6} ${cx},${ty2}`);
        tri.setAttribute('fill', TOKENS.danger());
        svg.appendChild(tri);
      }

      // kcal label on top if width >= 360
      if (w >= 360) {
        const lab = ns('text');
        lab.setAttribute('x', x + bw / 2);
        lab.setAttribute('y', y - (over ? 14 : 4));
        lab.setAttribute('text-anchor', 'middle');
        lab.setAttribute('fill', TOKENS.text2());
        lab.setAttribute('font-size', '10');
        lab.textContent = String(d.kcal);
        svg.appendChild(lab);
      }

      // date label bottom
      const dl = ns('text');
      dl.setAttribute('x', x + bw / 2);
      dl.setAttribute('y', h - 8);
      dl.setAttribute('text-anchor', 'middle');
      dl.setAttribute('fill', d.isToday ? TOKENS.accent() : TOKENS.text3());
      dl.setAttribute('font-size', '9');
      dl.textContent = d.date.slice(5);
      svg.appendChild(dl);

      // click handler area
      const hit = ns('rect');
      hit.setAttribute('x', x); hit.setAttribute('y', pad.t);
      hit.setAttribute('width', bw); hit.setAttribute('height', ih);
      hit.setAttribute('fill', 'transparent');
      hit.style.cursor = 'pointer';
      hit.addEventListener('click', () => { if (onSelect) onSelect(d.date); });
      svg.appendChild(hit);
    });

    container.appendChild(svg);
  }

  render();
  // sr-only table
  const sr = document.createElement('table');
  sr.className = 'sr-only';
  let rows = '<caption>一周热量</caption><thead><tr><th>日期</th><th>kcal</th><th>目标</th><th>超标</th></tr></thead><tbody>';
  for (const d of days) {
    const over = d.kcal > d.target ? '超标' : '';
    rows += `<tr><td>${d.date}</td><td>${d.kcal}</td><td>${d.target}</td><td>${over}</td></tr>`;
  }
  rows += '</tbody>';
  sr.innerHTML = rows;
  container.appendChild(sr);

  const cleanup = observeResize(container, render);
  registry.set(container, { cleanup, render });
}
