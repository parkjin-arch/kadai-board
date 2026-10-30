// カレンダーの描画（月・週・日・年）
// データの取得や項目タップ時の動作は app.js から ctx として受け取る
//
// ctx = {
//   data(): { tt, tasks, shifts, events }   今のデータ
//   show(): { class, shift, task, event }   表示する種類
//   onDay(date)                              日付をタップ（その日の一覧を開く）
//   onDayHeader(date)                        週表示の曜日見出しをタップ（日表示へ）
//   onMonth(date)                            年表示の月をタップ（月表示へ）
//   open(item)                               予定などをタップ
// }

import { h } from './dom.js';
import { collectItems, isSpanning } from './agenda.js';
import { holidayName } from './holidays.js';
import { DAY, HOUR, addDays, startOfDay, isSameDay, fmtTime, WEEKDAYS } from './dateutil.js';

const dayIdx = (d, first) => Math.round((startOfDay(d) - first) / DAY);
/** その日を含む週の日曜 */
export const sundayOf = (d) => addDays(startOfDay(d), -startOfDay(d).getDay());

/** 曜日・祝日による日付の色クラス */
function dayClass(d) {
  if (holidayName(d) || d.getDay() === 0) return 'sun';
  if (d.getDay() === 6) return 'sat';
  return '';
}

const KIND_ORDER = { holiday: -1, event: 0, task: 1, shift: 2, class: 3 };

/**
 * 項目を「段」に割り当てる（横に伸びるバーが重ならないように）
 * @returns {{ bars: Array<{ item, s, e, lane, contLeft, contRight }>, hidden: number[] }}
 */
export function layoutBars(items, firstDay, nDays, maxLanes) {
  const rows = items.map((item) => {
    const last = item.end > item.start ? new Date(+item.end - 1) : item.start;
    const s0 = dayIdx(item.start, firstDay), e0 = dayIdx(last, firstDay);
    return { item, s: Math.max(0, s0), e: Math.min(nDays - 1, e0), contLeft: s0 < 0, contRight: e0 > nDays - 1, spanning: isSpanning(item) };
  });
  // 複数日の予定を先に（長いものほど上）、その後は時刻順
  rows.sort((a, b) => (b.spanning - a.spanning)
    || (a.spanning ? a.s - b.s || (b.e - b.s) - (a.e - a.s) : 0)
    || a.item.start - b.item.start
    || KIND_ORDER[a.item.kind] - KIND_ORDER[b.item.kind]);
  const used = []; // used[lane][col]
  const hidden = Array(nDays).fill(0);
  const bars = [];
  for (const r of rows) {
    let lane = 0;
    while (used[lane] && [...Array(r.e - r.s + 1)].some((_, i) => used[lane][r.s + i])) lane++;
    if (lane >= maxLanes) {
      for (let c = r.s; c <= r.e; c++) hidden[c]++;
      continue;
    }
    used[lane] ||= [];
    for (let c = r.s; c <= r.e; c++) used[lane][c] = true;
    bars.push({ ...r, lane });
  }
  return { bars, hidden };
}

/** バー1本 */
function barEl(b, extraStyle = '') {
  const it = b.item;
  const cls = ['bar', `k-${it.kind}`, b.spanning && 'span', it.status, it.conflict && 'conflict', b.contLeft && 'cont-l', b.contRight && 'cont-r']
    .filter(Boolean).join(' ');
  const mark = it.kind === 'task' ? '▲ ' : it.conflict ? '⚠ ' : '';
  const label = it.kind === 'class' && it.status === 'cancelled' ? `休講 ${it.title}`
    : it.status === 'makeup' ? `補講 ${it.title}` : it.title;
  return h('div', { class: cls, style: `--c:${it.color};grid-column:${b.s + 1} / ${b.e + 2};${extraStyle}`, title: `${label} ${it.sub || ''}` }, mark + label);
}

// =====================================================================
// 月表示：上下スクロールで月が続いていく
// =====================================================================
const MONTH_LANES = 5; // 1日のマスに並べる件数（それ以上は「+n」）。style.css の .mw と合わせる

export class MonthView {
  constructor(el, ctx) {
    this.el = el;
    this.ctx = ctx;
    this.from = null; // 表示している最初の週（日曜）
    this.to = null; // 表示している最後の週の翌週（日曜）
    this.onTitle = () => {};
    // スクロール中は 50ms に1回だけ、端に近いかを調べる
    let timer = null;
    el.addEventListener('scroll', () => {
      if (timer) return;
      timer = setTimeout(() => {
        timer = null;
        if (el.scrollTop < 600) this._extend(-1);
        else if (el.scrollTop + el.clientHeight > el.scrollHeight - 600) this._extend(1);
        this._updateTitle();
      }, 50);
    }, { passive: true });
  }

  /** anchor の月を中心に前後6か月を描いて、その月までスクロール */
  show(anchor) {
    const m = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
    this.from = sundayOf(new Date(m.getFullYear(), m.getMonth() - 6, 1));
    this.to = sundayOf(new Date(m.getFullYear(), m.getMonth() + 7, 1));
    this.el.replaceChildren(this._build(this.from, this.to));
    this.scrollToMonth(m);
  }

  /** データが変わったとき：同じ範囲を描き直してスクロール位置を保つ */
  refresh() {
    if (!this.from) return;
    const top = this.el.scrollTop;
    this.el.replaceChildren(this._build(this.from, this.to));
    this.el.scrollTop = top;
    this._updateTitle();
  }

  scrollToMonth(date) {
    const key = `${date.getFullYear()}-${date.getMonth()}`;
    const head = this.el.querySelector(`[data-month="${key}"]`);
    if (!head) return this.show(date);
    this.el.scrollTop = head.offsetTop;
    this._updateTitle();
  }

  /** 端に近づいたら3か月ぶん足す */
  _extend(dir) {
    if (dir < 0) {
      const first = addDays(this.from, 6); // この週の土曜が属する月を基準に
      const newFrom = sundayOf(new Date(first.getFullYear(), first.getMonth() - 3, 1));
      const before = this.el.scrollHeight;
      this.el.prepend(this._build(newFrom, this.from));
      this.el.scrollTop += this.el.scrollHeight - before; // 見ている位置がずれないように
      this.from = newFrom;
    } else {
      const last = addDays(this.to, -1);
      const newTo = sundayOf(new Date(last.getFullYear(), last.getMonth() + 4, 1));
      this.el.append(this._build(this.to, newTo));
      this.to = newTo;
    }
  }

  _updateTitle() {
    const heads = this.el.querySelectorAll('.mh');
    let cur = heads[0];
    for (const hd of heads) {
      if (hd.offsetTop <= this.el.scrollTop + 40) cur = hd;
      else break;
    }
    if (cur) this.onTitle(new Date(+cur.dataset.y, +cur.dataset.m, 1));
  }

  _build(from, to) {
    const frag = document.createDocumentFragment();
    const today = new Date();
    for (let ws = from; ws < to; ws = addDays(ws, 7)) {
      // その週に1日があれば、月の見出しを入れる（1日の曜日の列に）
      for (let i = 0; i < 7; i++) {
        const d = addDays(ws, i);
        if (d.getDate() !== 1) continue;
        const cur = d.getFullYear() === today.getFullYear() && d.getMonth() === today.getMonth();
        frag.append(h('div', { class: 'mh', 'data-month': `${d.getFullYear()}-${d.getMonth()}`, 'data-y': d.getFullYear(), 'data-m': d.getMonth() },
          h('span', { class: cur ? 'cur' : '', style: `grid-column:${i + 1} / span 7` }, d.getMonth() === 0 ? `${d.getFullYear()}年1月` : `${d.getMonth() + 1}月`)));
      }
      frag.append(this._week(ws, today));
    }
    return frag;
  }

  _week(ws, today) {
    const items = collectItems(this.ctx.data(), ws, addDays(ws, 7), this.ctx.show());
    // 祝日は赤い文字のラベルとして一番上に出す
    for (let i = 0; i < 7; i++) {
      const d = addDays(ws, i);
      const hol = holidayName(d);
      if (hol) items.push({ kind: 'holiday', title: hol, start: d, end: addDays(d, 1), allDay: true, color: 'var(--sun)', status: null });
    }
    const { bars, hidden } = layoutBars(items, ws, 7, MONTH_LANES);
    const row = h('div', { class: 'mw' });
    for (let i = 0; i < 7; i++) {
      const d = addDays(ws, i);
      const hol = holidayName(d);
      row.append(h('button', {
        class: `md ${dayClass(d)} ${isSameDay(d, today) ? 'today' : ''}`,
        style: `grid-column:${i + 1}`,
        onclick: () => this.ctx.onDay(d),
        'aria-label': `${d.getMonth() + 1}月${d.getDate()}日${hol ? ' ' + hol : ''}`,
      },
        h('span', { class: 'dn' }, d.getDate() === 1 ? `${d.getMonth() + 1}/1` : d.getDate())));
    }
    for (const b of bars) row.append(barEl(b, `grid-row:${b.lane + 2}`));
    hidden.forEach((n, i) => n && row.append(h('div', { class: 'more', style: `grid-column:${i + 1};grid-row:${MONTH_LANES + 2}` }, `+${n}`)));
    return row;
  }
}

// =====================================================================
// 週表示・日表示：縦軸が時刻
// =====================================================================
const HOUR_PX = 56; // 1時間の高さ
const ALLDAY_LANES = 3;

/** 日をまたぐ予定を日ごとの区間に分ける */
function splitByDay(start, end) {
  const out = [];
  let s = start;
  while (s < end) {
    const dayEnd = addDays(startOfDay(s), 1);
    const e = end < dayEnd ? end : dayEnd;
    out.push({ start: s, end: e });
    s = e;
  }
  return out;
}

/** 時間が重なる予定を横に並べる（列に振り分ける） */
function layoutLanes(items) {
  items.sort((a, b) => a.top - b.top || b.bottom - a.bottom);
  let cluster = [];
  let clusterEnd = -Infinity;
  const flush = () => {
    const lanes = [];
    for (const it of cluster) {
      let i = lanes.findIndex((end) => end <= it.top);
      if (i < 0) i = lanes.length;
      lanes[i] = it.bottom;
      it.lane = i;
    }
    for (const it of cluster) it.lanes = lanes.length;
  };
  for (const it of items) {
    if (cluster.length && it.top >= clusterEnd) {
      flush();
      cluster = [];
    }
    cluster.push(it);
    clusterEnd = cluster.length === 1 ? it.bottom : Math.max(clusterEnd, it.bottom);
  }
  if (cluster.length) flush();
}

const atClock = (hhmm) => {
  const [hh, mm] = hhmm.split(':').map(Number);
  return hh + mm / 60;
};

/**
 * @param {HTMLElement} el 描画先
 * @param {Date[]} days 表示する日（週表示は7日、日表示は1日）
 */
export function renderTimeGrid(el, days, ctx) {
  const now = new Date();
  const first = startOfDay(days[0]);
  const n = days.length;
  const rangeEnd = addDays(first, n);
  const { tt } = ctx.data();
  const items = collectItems(ctx.data(), first, rangeEnd, ctx.show());
  const allDay = items.filter((it) => it.allDay);
  const timed = items.filter((it) => !it.allDay && it.kind !== 'task');
  const dues = items.filter((it) => it.kind === 'task');

  // ---- 表示する時間帯（8〜22時を基本に、はみ出す予定があれば広げる） ----
  let minH = 8, maxH = 22;
  for (const it of [...timed, ...dues]) {
    const [seg] = splitByDay(it.start, +it.end > +it.start ? it.end : new Date(+it.start + 30 * 60000));
    if (seg.start < first) continue; // 前日からの続きでは広げない（上端に寄せて描く）
    minH = Math.min(minH, seg.start.getHours());
    maxH = Math.max(maxH, isSameDay(seg.start, seg.end) ? seg.end.getHours() + (seg.end.getMinutes() ? 1 : 0) : 24);
  }
  maxH = Math.min(24, maxH);
  const H = (maxH - minH) * HOUR_PX;
  const y = (d) => ((d - startOfDay(d)) / HOUR - minH) * HOUR_PX;

  el.style.setProperty('--n', n);
  el.style.setProperty('--hour', `${HOUR_PX}px`);
  el.style.setProperty('--tg-h', `${H}px`);

  const cells = [h('div', { class: 'tg-corner' })];
  // ---- 曜日の見出し ----
  days.forEach((d) => {
    const hol = holidayName(d);
    cells.push(h('button', {
      class: `tg-head ${dayClass(d)} ${isSameDay(d, now) ? 'today' : ''}`,
      onclick: () => ctx.onDayHeader(d),
    }, h('span', { class: 'wd' }, WEEKDAYS[d.getDay()]), h('b', {}, d.getDate()), hol && h('span', { class: 'hol' }, hol)));
  });

  // ---- 終日の予定（横に伸びるバー） ----
  if (allDay.length) {
    const { bars, hidden } = layoutBars(allDay, first, n, ALLDAY_LANES);
    const strip = h('div', { class: 'tg-allday', style: `grid-template-columns:repeat(${n}, minmax(0, 1fr))` });
    for (const b of bars) {
      const el2 = barEl(b, `grid-row:${b.lane + 1}`);
      el2.addEventListener('click', () => ctx.open(b.item));
      strip.append(el2);
    }
    hidden.forEach((k, i) => k && strip.append(h('button', { class: 'more', style: `grid-column:${i + 1};grid-row:${ALLDAY_LANES + 1}`, onclick: () => ctx.onDay(addDays(first, i)) }, `+${k}`)));
    cells.push(h('div', { class: 'tg-allday-label' }, '終日'), strip);
  }

  // ---- 時刻の軸と時限の帯 ----
  const periodBox = (p) => {
    const s = atClock(p.start), e = atClock(p.end);
    return { top: (s - minH) * HOUR_PX, height: (e - s) * HOUR_PX };
  };
  const axis = h('div', { class: 'tg-axis' });
  for (let hr = minH + 1; hr < maxH; hr++) axis.append(h('span', { class: 'tg-hour', style: `top:${(hr - minH) * HOUR_PX}px` }, `${hr}`));
  for (const p of tt.periods) {
    const b = periodBox(p);
    axis.append(h('span', { class: 'tg-period', style: `top:${b.top}px;height:${b.height}px`, title: `${p.period}限 ${p.start}–${p.end}` }, p.period));
  }
  cells.push(axis);

  // ---- 日ごとの列 ----
  const perDay = Array.from({ length: n }, () => ({ blocks: [], dues: [] }));
  for (const it of timed) {
    for (const seg of splitByDay(it.start, it.end)) {
      const i = dayIdx(seg.start, first);
      if (i < 0 || i >= n) continue;
      const top = Math.max(0, y(seg.start));
      const bottom = isSameDay(seg.start, seg.end) ? y(seg.end) : (24 - minH) * HOUR_PX;
      perDay[i].blocks.push({ it, top, bottom: Math.max(bottom, top + 30) });
    }
  }
  for (const it of dues) perDay[dayIdx(it.start, first)].dues.push({ it, top: y(it.start) - 8 });

  days.forEach((d, i) => {
    const col = h('div', { class: `tg-col ${isSameDay(d, now) ? 'today' : ''}` });
    // 平日（時間割のある曜日）は時限の枠を薄く表示
    if (d.getDay() >= 1 && d.getDay() <= tt.days.length) {
      for (const p of tt.periods) {
        const b = periodBox(p);
        col.append(h('div', { class: 'tg-band', style: `top:${b.top}px;height:${b.height}px` }));
      }
    }
    const { blocks, dues: ds } = perDay[i];
    layoutLanes(blocks);
    for (const b of blocks) {
      const it = b.it;
      const label = it.kind === 'class' && it.status === 'cancelled' ? '休講' : it.status === 'makeup' ? '補講' : it.status === 'room' ? '教室変更' : null;
      col.append(h('button', {
        class: ['tg-item', `k-${it.kind}`, it.status, it.conflict && 'conflict'].filter(Boolean).join(' '),
        style: `--c:${it.color};top:${b.top}px;height:${Math.max(18, b.bottom - b.top - 1)}px;left:calc(${(b.lane / b.lanes) * 100}% + 1px);width:calc(${100 / b.lanes}% - 2px)`,
        onclick: () => ctx.open(it),
        title: `${it.title} ${fmtTime(it.start)}–${fmtTime(it.end)} ${it.sub || ''}`,
      },
        h('span', { class: 'n' }, it.conflict ? h('span', { class: 'warn' }, '⚠') : null, it.title),
        h('span', { class: 'r' }, label ? `${label} ` : '', it.kind === 'shift' ? (it.status === 'cancelled' ? '休み' : it.sub) : it.kind === 'event' ? it.sub : it.sub || '')));
    }
    // 期限は小さな札として上に重ねる（同じ時刻のものは下にずらす）
    let last = -Infinity;
    for (const dd of ds.sort((a, b) => a.top - b.top)) {
      const top = Math.max(dd.top, last);
      last = top + 17;
      const it = dd.it;
      col.append(h('button', {
        class: ['tg-due', it.status, it.conflict && 'conflict'].filter(Boolean).join(' '),
        style: `top:${top}px`,
        onclick: () => ctx.open(it),
        title: `${it.title}（${it.sub}）`,
      }, it.conflict ? '⚠ ' : '▲ ', it.title));
    }
    if (isSameDay(d, now)) {
      const top = y(now);
      if (top >= 0 && top <= H) col.append(h('div', { class: 'tg-now', style: `top:${top}px` }));
    }
    cells.push(col);
  });

  el.replaceChildren(...cells);
}

// =====================================================================
// 年表示：12か月のミニカレンダー。予定がある日に点
// =====================================================================
export function renderYear(el, year, ctx) {
  const today = new Date();
  const start = new Date(year, 0, 1);
  const end = new Date(year + 1, 0, 1);
  // 毎週の授業は点にしない（休講・補講・教室変更だけ）
  const items = collectItems(ctx.data(), start, end, { ...ctx.show(), class: ctx.show().class })
    .filter((it) => it.kind !== 'class' || it.status)
    .filter((it) => !(it.kind === 'shift' && it.status === 'cancelled'));
  const marked = new Set();
  for (const it of items) {
    const last = it.end > it.start ? new Date(+it.end - 1) : it.start;
    for (let d = startOfDay(it.start); d <= last; d = addDays(d, 1)) marked.add(d.toDateString());
  }

  const months = [];
  for (let m = 0; m < 12; m++) {
    const first = new Date(year, m, 1);
    const cur = year === today.getFullYear() && m === today.getMonth();
    const grid = h('div', { class: 'ym-days' });
    for (const w of WEEKDAYS) grid.append(h('span', { class: 'ym-wd' }, w));
    for (let i = 0; i < first.getDay(); i++) grid.append(h('span'));
    for (let d = first; d.getMonth() === m; d = addDays(d, 1)) {
      grid.append(h('span', { class: `ym-d ${dayClass(d)} ${isSameDay(d, today) ? 'today' : ''} ${marked.has(d.toDateString()) ? 'dot' : ''}` }, d.getDate()));
    }
    months.push(h('button', { class: 'ym', onclick: () => ctx.onMonth(first) },
      h('span', { class: `ym-title ${cur ? 'cur' : ''}` }, `${m + 1}月`), grid));
  }
  el.replaceChildren(...months);
}
