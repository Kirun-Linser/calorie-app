export function fmtDate(d) {
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function parseDate(s) {
  const [y, m, day] = s.split('-').map(Number);
  return new Date(y, m - 1, day, 0, 0, 0, 0);
}

export function todayStr(now = new Date()) {
  return fmtDate(now);
}

export function logicalDate(now = new Date()) {
  const d = new Date(now);
  if (d.getHours() < 4) d.setDate(d.getDate() - 1);
  return fmtDate(d);
}

export function addDays(s, n) {
  const d = parseDate(s);
  d.setDate(d.getDate() + n);
  return fmtDate(d);
}

export function weekday(s) {
  return parseDate(s).getDay();
}

export function lastNDates(endDate, n) {
  const out = [];
  for (let i = n - 1; i >= 0; i--) {
    out.push(addDays(endDate, -i));
  }
  return out;
}

export function diffDays(a, b) {
  const ms = parseDate(b).getTime() - parseDate(a).getTime();
  return Math.round(ms / 86400000);
}
