// アプリ本体：画面の描画とイベント処理

import { CONFIG } from './config.js';
import { Timetable, groupSlots } from './timetable.js';
import { LocalCollection, makeTask, newId } from './store.js';
import { parseQuickInput } from './parser.js';
import { googleCalendarUrl, buildIcs, downloadText } from './calendar.js';
import {
  makeShift, fromKey, occurrences, allOccurrences, summarize, findConflicts,
  shiftRuleLabel, shiftOccurrenceUrl, shiftSeriesUrl, shiftIcsLines,
} from './shifts.js';
import { parseLine, toggleLine, uncheckedItems } from './notes.js';
import { makeEvent, eventSpan, eventWhen, eventUrl, eventIcsLines, EVENT_COLORS } from './events.js';
import { collectItems, isSpanning, ALL_KINDS } from './agenda.js';
import { MonthView, renderTimeGrid, renderYear } from './calendar-view.js';
import { holidayName } from './holidays.js';
import { h, $ } from './dom.js';
import {
  DAY, HOUR, startOfDay, startOfWeek, addDays, isSameDay, fmtDate, fmtDateTime, fmtTime,
  fmtMinutes, relative, toDateInput, toTimeInput, fromInputs, WEEKDAYS,
} from './dateutil.js';

const APP_VERSION = '1.2.0';
// localStorage のキー（Firebase に移行するときは、ここから初回アップロードする）
const STORE_KEYS = {
  tasks: 'kadai-board.tasks.v1',
  shifts: 'kadai-board.shifts.v1',
  notes: 'kadai-board.notes.v1',
  courses: 'kadai-board.courses.v1',
  events: 'kadai-board.events.v1',
};
const PRIORITY_ORDER = { high: 0, mid: 1, low: 2 };
const PRIORITY_LABEL = { high: '高', mid: '中', low: '低' };

/** @type {Timetable} */
let tt;
/** @type {LocalCollection} */
let store; // タスク
/** @type {LocalCollection} */
let shiftStore; // バイトのシフト
/** @type {LocalCollection} */
let noteStore; // 今週のノート（id = 週の月曜 "YYYY-MM-DD"）
/** @type {LocalCollection} */
let courseStore; // 授業（時間割）。meta に学期名とアーカイブ
/** @type {LocalCollection} */
let eventStore; // 自分で追加した予定
let authState = null; // 段階2: Firebase のログイン状態（有効時のみ）
let gcal = null; // 段階2: Googleカレンダー同期（有効時のみ）

const loadJson = (key, fallback) => {
  try {
    return JSON.parse(localStorage.getItem(key)) ?? fallback;
  } catch {
    return fallback;
  }
};

const ui = {
  view: localStorage.getItem('kadai-board.view') || 'tasks',
  filter: 'open',
  courseFilter: null,
  editingId: null, // 編集中のタスクID（新規なら null）
  courseDialogId: null,
  courseDialogDate: null,
  shiftEditingId: null, // 編集中のシフトID（新規なら null）
  occ: null, // 操作中のシフト1回分 { shiftId, key }
  noteWeek: startOfWeek(new Date()), // ノートで表示中の週（月曜）
  noteEditing: false, // 編集中ならその週のキー
  // カレンダー：表示モード（day / week / month / year）と基準日
  cal: { mode: localStorage.getItem('kadai-board.calMode') || 'month', date: startOfDay(new Date()), monthShown: null, jump: true },
  calShow: loadJson('kadai-board.calShow', { ...ALL_KINDS }), // 表示する種類
  dayDate: null, // 一覧を開いている日
  eventEditingId: null,
  courseEditingId: null,
  slotRows: [], // 授業の編集中のコマ [{ day, from, to }]
  clashConfirmed: false,
  courseDeleteId: null,
  changeCourseId: null,
};

// ====================================================================
// 起動
// ====================================================================
async function main() {
  applyTheme(localStorage.getItem('kadai-board.theme') || 'auto');

  tt = await Timetable.load();

  if (CONFIG.storage === 'firebase') {
    // 段階2: Firestore に切り替え（firebase-store.js を読み込むのはこのときだけ）
    const { createFirebaseStores } = await import('./firebase-store.js');
    const fb = createFirebaseStores(CONFIG.firebase, STORE_KEYS);
    authState = fb.auth;
    ({ tasks: store, shifts: shiftStore, notes: noteStore, courses: courseStore, events: eventStore } = fb.cols);
  } else {
    store = new LocalCollection(STORE_KEYS.tasks);
    shiftStore = new LocalCollection(STORE_KEYS.shifts);
    noteStore = new LocalCollection(STORE_KEYS.notes);
    courseStore = new LocalCollection(STORE_KEYS.courses);
    eventStore = new LocalCollection(STORE_KEYS.events);
  }
  for (const s of [store, shiftStore, noteStore, courseStore, eventStore]) await s.init();
  await seedCourses();
  syncTimetable();
  // 授業が変わったら、時間割・カレンダー・タスクの選択肢などに反映する
  courseStore.subscribe(() => {
    syncTimetable();
    renderAll();
  });
  for (const s of [store, shiftStore, noteStore, eventStore]) s.subscribe(renderAll);

  if (CONFIG.google.clientId) {
    const { GcalSync } = await import('./gcal-sync.js');
    gcal = new GcalSync(store, tt, CONFIG.google);
  }

  bindEvents();
  setupSyncUi();
  setView(ui.view);
  renderAll();

  // 残り時間表示や「今日」の判定を更新するため 1 分ごとに再描画
  setInterval(renderAll, 60 * 1000);
  document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && renderAll());

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch((e) => console.warn('SW 登録失敗', e));
  }
}

/** 初回起動時：data/timetable.json の授業を授業コレクションに入れる（以後はアプリ上で編集する） */
async function seedCourses() {
  if (courseStore.getMeta('seeded') || courseStore.all().length) return;
  if (CONFIG.storage === 'firebase' && !authState.user) return; // 未ログインでは書き込めない
  await courseStore.replaceAll(tt.seedCourses.map(normalizeCourse));
  await courseStore.setMeta('term', tt.seedTerm);
  await courseStore.setMeta('seeded', true);
}

/** 授業コレクションの内容を時間割オブジェクトに反映 */
function syncTimetable() {
  tt.setCourses(courseStore.all().map(normalizeCourse));
  tt.setArchived((courseStore.getMeta('archives') || []).flatMap((a) => a.courses));
  tt.term = courseStore.getMeta('term') ?? tt.seedTerm;
}

// ====================================================================
// タスク操作（保存後に段階2の同期フックを呼ぶ）
// ====================================================================
async function saveTask(task, isNew) {
  try {
    const saved = isNew ? await store.add(task) : await store.update(task.id, task);
    gcal?.onSaved(saved);
    return saved;
  } catch (e) {
    toast(e.message);
    throw e;
  }
}

async function deleteTask(id) {
  const task = store.all().find((t) => t.id === id);
  if (!task) return;
  await store.remove(id);
  gcal?.onRemoved(task);
  toast('削除しました', '元に戻す', async () => {
    await saveTask({ ...task, gcalEventId: null }, true);
  });
}

async function toggleDone(id) {
  const task = store.all().find((t) => t.id === id);
  if (!task) return;
  const saved = await saveTask({ ...task, done: !task.done }, false);
  if (saved.done) toast('完了にしました', '元に戻す', () => saveTask({ ...saved, done: false }, false));
}

// ====================================================================
// 描画
// ====================================================================
function renderAll() {
  const now = new Date();
  $('#today-label').textContent = `${now.getMonth() + 1}月${now.getDate()}日(${WEEKDAYS[now.getDay()]})`;
  renderFilters(now);
  renderTaskList(now);
  renderTimetable(now);
  renderCalendar(now);
  renderNotes(now);
  renderTermInfo();
  if ($('#course-dialog').open) renderCourseDialog();
  if ($('#occ-dialog').open) renderOccDialog();
  if ($('#day-dialog').open) renderDayDialog();
  if ($('#change-dialog').open) renderChangeList();
}

const dueOf = (t) => (t.due ? new Date(t.due) : null);

/** 期限が近い順 → 優先度 → 作成順 */
function byDue(a, b) {
  const da = dueOf(a), db = dueOf(b);
  if (da && db && +da !== +db) return da - db;
  if (!da !== !db) return da ? -1 : 1; // 期限なしは最後
  return PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority] || a.createdAt.localeCompare(b.createdAt);
}

/** 期限の状態：overdue / urgent（24時間以内） / null */
function dueState(task, now) {
  const d = dueOf(task);
  if (!d || task.done) return null;
  if (d < now) return 'overdue';
  if (d - now <= DAY) return 'urgent';
  return null;
}

function filterTasks(filter, now) {
  const all = store.all();
  const open = all.filter((t) => !t.done);
  const weekStart = startOfWeek(now);
  const weekEnd = addDays(weekStart, 7);
  switch (filter) {
    case 'today':
      return open.filter((t) => t.due && isSameDay(dueOf(t), now));
    case 'week':
      return open.filter((t) => t.due && dueOf(t) >= weekStart && dueOf(t) < weekEnd);
    case 'overdue':
      return open.filter((t) => t.due && dueOf(t) < now);
    case 'course':
      return open.filter((t) => (ui.courseFilter === 'none' ? !t.courseId : t.courseId === ui.courseFilter));
    case 'done':
      return all.filter((t) => t.done);
    default:
      return open;
  }
}

function renderFilters(now) {
  for (const btn of document.querySelectorAll('#filters .chip')) {
    const f = btn.dataset.filter;
    btn.setAttribute('aria-pressed', String(ui.filter === f));
    // 件数バッジ（授業別・完了済み以外）
    btn.querySelector('.count')?.remove();
    if (['open', 'today', 'week', 'overdue'].includes(f)) {
      const n = filterTasks(f, now).length;
      if (n) btn.append(h('span', { class: 'count' }, n));
      btn.classList.toggle('alert', f === 'overdue' && n > 0);
    }
  }

  const sub = $('#course-filter');
  sub.hidden = ui.filter !== 'course';
  if (!sub.hidden) {
    if (!ui.courseFilter) ui.courseFilter = tt.courses[0].id;
    const open = store.all().filter((t) => !t.done);
    const items = [...tt.courses.map((c) => ({ id: c.id, name: c.name, color: c.color })), { id: 'none', name: '授業なし', color: null }];
    sub.replaceChildren(
      ...items.map((c) => {
        const n = open.filter((t) => (c.id === 'none' ? !t.courseId : t.courseId === c.id)).length;
        return h('button', {
          class: 'chip sm pill', style: c.color ? `--c:${c.color}` : null,
          'aria-pressed': String(ui.courseFilter === c.id),
          onclick: () => { ui.courseFilter = c.id; renderAll(); },
        }, c.name, n ? h('span', { class: 'count' }, n) : null);
      }),
    );
  }
}

/** タスク1件のカード */
function taskEl(task, now) {
  const course = tt.get(task.courseId);
  const due = dueOf(task);
  const state = dueState(task, now);
  return h('div', {
    class: ['task', `prio-${task.priority}`, state, task.done && 'done'].filter(Boolean).join(' '),
    'data-id': task.id,
  },
    h('button', { class: 'check', role: 'checkbox', 'aria-checked': String(task.done), 'aria-label': '完了' }, '✓'),
    h('div', { class: 't-body' },
      h('div', { class: 't-title' }, task.title),
      h('div', { class: 't-meta' },
        due && h('span', { class: `t-due ${state || ''}` }, `${fmtDateTime(due)}${task.done ? '' : '・' + relative(due, now)}`),
        course && h('span', { class: 'pill', style: `--c:${course.color}` }, course.name),
        task.priority !== 'mid' && h('span', { class: `prio ${task.priority}` }, `優先度${PRIORITY_LABEL[task.priority]}`),
        task.estimateMin && h('span', {}, `⏱ ${fmtMinutes(task.estimateMin)}`),
        task.gcalEventId && h('span', { title: 'Googleカレンダーと同期済み' }, '🔄'),
        taskConflictChip(task),
      ),
      task.memo && h('div', { class: 't-memo' }, task.memo),
    ),
    due && !task.done && h('button', { class: 't-cal', title: 'Googleカレンダーに追加', 'aria-label': 'Googleカレンダーに追加' }, '📅'),
  );
}

/** 期限がバイト中・授業中なら、その重なりを返す */
function taskConflicts(task) {
  if (!task.due || task.done) return [];
  const day = startOfDay(new Date(task.due));
  return findConflicts({ tt, shifts: shiftStore.all(), tasks: [task], rangeStart: day, rangeEnd: addDays(day, 1) })
    .filter((c) => c.taskIds.includes(task.id));
}

function taskConflictChip(task) {
  const c = taskConflicts(task)[0];
  if (!c) return null;
  return h('span', { class: 'warn-chip', title: c.text }, c.shiftIds.length ? '⚠ バイト中' : '⚠ 授業中');
}

/** 一覧を日付ごとに見出しを付けて描画 */
function renderGroupedList(container, tasks, now, { sortDesc = false } = {}) {
  const sorted = [...tasks].sort(byDue);
  if (sortDesc) sorted.reverse();
  if (!sorted.length) {
    container.replaceChildren(h('div', { class: 'empty' }, emptyMessage()));
    return;
  }
  const out = [];
  let lastKey = null;
  for (const t of sorted) {
    const d = dueOf(t);
    let key, label, cls = '';
    if (!d) { key = 'none'; label = '期限なし'; }
    else if (!t.done && d < now) { key = 'overdue'; label = '期限切れ'; cls = 'overdue'; }
    else {
      key = toDateInput(d);
      const diff = Math.round((startOfDay(d) - startOfDay(now)) / DAY);
      label = fmtDate(d) + (diff === 0 ? ' 今日' : diff === 1 ? ' 明日' : '');
    }
    if (key !== lastKey) {
      out.push(h('div', { class: `group-head ${cls}` }, label));
      lastKey = key;
    }
    out.push(taskEl(t, now));
  }
  container.replaceChildren(...out);
}

function emptyMessage() {
  return {
    today: '今日が期限のタスクはありません 🎉',
    week: '今週が期限のタスクはありません',
    overdue: '期限切れのタスクはありません 👍',
    done: '完了済みのタスクはまだありません',
    course: 'この授業のタスクはありません',
  }[ui.filter] || 'タスクはありません。上の入力欄から追加しましょう';
}

function renderTaskList(now) {
  renderGroupedList($('#task-list'), filterTasks(ui.filter, now), now, { sortDesc: ui.filter === 'done' });
}

// ---------- 授業カード（時間割・OD一覧） ----------

/** 授業ごとの未完了件数と「急ぎ」があるか */
function courseStats(courseId, now) {
  const open = store.all().filter((t) => !t.done && t.courseId === courseId);
  return { n: open.length, hot: open.some((t) => dueState(t, now)) };
}

function courseCell(course, now, extra = {}) {
  const { n, hot } = courseStats(course.id, now);
  return h('button', {
    class: `tt-cell ${extra.class || ''}`,
    style: `--c:${course.color};${extra.style || ''}`,
    onclick: () => openCourseDialog(course.id),
    'aria-label': `${course.name} ${course.room} 未完了${n}件`,
    title: extra.title,
  },
    // マスが狭いので short（任意）があればそちらを表示
    h('span', { class: 'n' }, extra.class?.includes('clash') ? '⚠ ' : '', extra.full ? course.name : course.short || course.name),
    h('span', { class: 'r' }, course.room),
    n ? h('span', { class: `badge ${hot ? 'hot' : ''}` }, n) : null,
  );
}

const hm = (d) => fmtTime(d);
const md = (d) => `${d.getMonth() + 1}/${d.getDate()}`;
const fmtHours = (x) => `${Math.round(x * 10) / 10}時間`;
const yen = (n) => `${n.toLocaleString('ja-JP')}円`;

// ---------- 時間割グリッド（空きコマから授業を追加できる） ----------

function renderTimetable(now) {
  $('#term-label').textContent = tt.term;
  const grid = $('#timetable');
  const todayDow = now.getDay(); // 1=月 … 5=金
  const curPeriod = tt.currentPeriod(now);
  const cells = [h('div', { class: 'tt-head', style: 'grid-row:1;grid-column:1' })];
  tt.days.forEach((d, i) => {
    cells.push(h('div', { class: `tt-head ${i + 1 === todayDow ? 'today' : ''}`, style: `grid-row:1;grid-column:${i + 2}` }, d));
  });

  for (const p of tt.periods) {
    const row = p.period + 1;
    cells.push(h('div', { class: 'tt-period', style: `grid-row:${row};grid-column:1` },
      h('b', {}, p.period), p.start, h('br'), p.end));

    for (let day = 1; day <= tt.days.length; day++) {
      const here = tt.coursesAt(day, p.period);
      const isToday = day === todayDow;
      if (!here.length) {
        cells.push(h('button', {
          class: `tt-empty ${isToday ? 'today' : ''}`,
          style: `grid-row:${row};grid-column:${day + 1}`,
          'aria-label': `${tt.days[day - 1]}曜${p.period}限に授業を追加`,
          onclick: () => openCourseEdit(null, { slots: [{ day, period: p.period }] }),
        }, '+'));
        continue;
      }
      const course = here[0];
      // 実験A のような連続コマは 1 つのマスにまとめる
      if (p.period > 1 && tt.coursesAt(day, p.period - 1)[0] === course) continue;
      let span = 1;
      while (tt.coursesAt(day, p.period + span)[0] === course) span++;
      // 同じコマに別の授業が入っていたら ⚠
      const clash = [...Array(span)].flatMap((_, i) => tt.coursesAt(day, p.period + i)).filter((c, i, a) => a.indexOf(c) === i);
      const isNow = isToday && curPeriod && curPeriod >= p.period && curPeriod < p.period + span;
      cells.push(courseCell(course, now, {
        class: [isToday && 'today', isNow && 'now', clash.length > 1 && 'clash'].filter(Boolean).join(' '),
        style: `grid-row:${row} / span ${span};grid-column:${day + 1}`,
        title: clash.length > 1 ? `重なっています: ${clash.map((c) => c.name).join(' / ')}` : null,
      }));
    }
  }
  grid.replaceChildren(...cells);
  $('#ondemand').replaceChildren(
    ...tt.onDemand.map((c) => courseCell(c, now, { full: true })),
    h('button', { class: 'tt-cell od-add', onclick: () => openCourseEdit(null, { slots: [] }) }, '＋ OD授業を追加'),
  );
}

// ---------- カレンダー（日・週・月・年） ----------

let monthView = null;
const calCtx = {
  data: () => ({ tt, tasks: store.all(), shifts: shiftStore.all(), events: eventStore.all() }),
  show: () => ui.calShow,
  onDay: (d) => openDayDialog(d),
  onDayHeader: (d) => setCalMode('day', d),
  onMonth: (d) => setCalMode('month', d),
  open: (it) => openItem(it),
};

/** 月表示で見ている月のうち、操作の基準にする日（今日がその月なら今日） */
function calBaseDate() {
  if (ui.cal.mode !== 'month' || !ui.cal.monthShown) return ui.cal.date;
  const m = ui.cal.monthShown;
  const today = new Date();
  return today.getFullYear() === m.getFullYear() && today.getMonth() === m.getMonth() ? startOfDay(today) : m;
}

function setCalMode(mode, date = calBaseDate()) {
  ui.cal.mode = mode;
  ui.cal.date = startOfDay(date);
  ui.cal.jump = true; // 月表示ではその月までスクロールする
  localStorage.setItem('kadai-board.calMode', mode);
  if (ui.view !== 'calendar') setView('calendar');
  else renderCalendar(new Date());
}

function moveCal(dir) {
  const { mode, date } = ui.cal;
  if (mode === 'month') {
    const m = ui.cal.monthShown || date;
    return setCalMode('month', new Date(m.getFullYear(), m.getMonth() + dir, 1));
  }
  if (mode === 'year') return setCalMode('year', new Date(date.getFullYear() + dir, 0, 1));
  setCalMode(mode, addDays(date, dir * (mode === 'week' ? 7 : 1)));
}

function renderCalendar(now) {
  if (ui.view !== 'calendar') return;
  const { mode, date } = ui.cal;
  for (const r of document.querySelectorAll('#cal-seg input')) r.checked = r.value === mode;
  for (const b of document.querySelectorAll('#cal-filters [data-kind]')) b.setAttribute('aria-pressed', String(!!ui.calShow[b.dataset.kind]));
  $('#cal-month-wrap').hidden = mode !== 'month';
  $('#cal-grid').hidden = mode !== 'week' && mode !== 'day';
  $('#cal-year').hidden = mode !== 'year';
  $('#cal-week-extra').hidden = mode !== 'week';
  const title = $('#cal-title');

  if (mode === 'month') {
    if (!monthView) {
      monthView = new MonthView($('#cal-month'), calCtx);
      monthView.onTitle = (m) => {
        ui.cal.monthShown = m;
        if (ui.cal.mode === 'month') title.textContent = `${m.getFullYear()}年${m.getMonth() + 1}月`;
      };
    }
    if (ui.cal.jump || !monthView.from) monthView.show(date);
    else monthView.refresh();
  } else if (mode === 'week' || mode === 'day') {
    const first = mode === 'week' ? startOfWeek(date) : startOfDay(date);
    const days = Array.from({ length: mode === 'week' ? 7 : 1 }, (_, i) => addDays(first, i));
    renderTimeGrid($('#cal-grid'), days, calCtx);
    if (mode === 'week') {
      title.textContent = `${first.getFullYear()}年 ${md(first)} – ${md(addDays(first, 6))}`;
      renderShiftSummary(first);
    } else {
      title.textContent = `${first.getMonth() + 1}月${first.getDate()}日(${WEEKDAYS[first.getDay()]})`;
    }
  } else {
    renderYear($('#cal-year'), date.getFullYear(), calCtx);
    title.textContent = `${date.getFullYear()}年`;
  }
  ui.cal.jump = false;
}

/** 週表示の上：バイトの勤務時間・収入と、重なりの警告 */
function renderShiftSummary(ws) {
  const we = addDays(ws, 7);
  const weekSum = summarize(allOccurrences(shiftStore.all(), ws, we));
  const mid = addDays(ws, 3); // 週の真ん中（木曜）の月を「この月」とする
  const monthStart = new Date(mid.getFullYear(), mid.getMonth(), 1);
  const monthSum = summarize(allOccurrences(shiftStore.all(), monthStart, new Date(mid.getFullYear(), mid.getMonth() + 1, 1)));
  const sumText = (label, sm) => h('span', {}, `${label} `, h('b', {}, fmtHours(sm.hours)),
    sm.income ? [' ・ 約', h('b', {}, yen(sm.income))] : null,
    sm.unpaidHours && sm.income ? `（時給未設定 ${fmtHours(sm.unpaidHours)}）` : null);
  $('#wk-summary').replaceChildren(...(shiftStore.all().length
    ? [h('span', {}, '💼 バイト'), sumText('この週', weekSum), sumText(`${mid.getMonth() + 1}月`, monthSum)]
    : [h('span', {}, '「＋ バイト」でシフトを登録すると、勤務時間と収入の目安がここに出ます')]));

  const conflicts = findConflicts({ tt, shifts: shiftStore.all(), tasks: store.all(), rangeStart: ws, rangeEnd: we });
  const box = $('#wk-conflicts');
  box.hidden = !conflicts.length;
  box.replaceChildren(...conflicts.map((c) => h('div', {}, c.text)));
}

/** カレンダー上の項目をタップしたとき */
function openItem(it) {
  if (it.kind === 'class') openCourseDialog(it.ref.course.id, it.ref.key);
  else if (it.kind === 'shift') openOccDialog(it.ref.shift.id, it.ref.key);
  else if (it.kind === 'event') openEventDialog(it.ref);
  else if (it.kind === 'task') openTaskDialog(it.ref);
}

/** 「＋」やその日の一覧から追加するとき */
function addOnDate(kind, date) {
  const key = toDateInput(date);
  if (kind === 'event') openEventDialog(null, { date });
  else if (kind === 'shift') openShiftDialog(null, { date: key, from: key, weekday: date.getDay() });
  else {
    const due = new Date(date);
    due.setHours(23, 59, 0, 0);
    openTaskDialog(null, { due: due.toISOString() });
  }
}

// ---------- その日の一覧（日付をタップ） ----------

const KIND_LABEL = { class: '授業', shift: 'バイト', task: 'タスク', event: '予定' };
const STATUS_LABEL = { cancelled: '休講', makeup: '補講', room: '教室変更', changed: '時間変更', overdue: '期限切れ' };

function openDayDialog(d) {
  ui.dayDate = startOfDay(d);
  renderDayDialog();
  if (!$('#day-dialog').open) $('#day-dialog').showModal();
}

function renderDayDialog() {
  const d = ui.dayDate;
  if (!d) return;
  $('#day-title').textContent = `${d.getMonth() + 1}月${d.getDate()}日(${WEEKDAYS[d.getDay()]})`;
  $('#day-holiday').textContent = holidayName(d) || '';
  const items = collectItems(calCtx.data(), d, addDays(d, 1), ALL_KINDS)
    .sort((a, b) => (isSpanning(b) - isSpanning(a)) || a.start - b.start);
  const timeOf = (it) => {
    if (it.allDay) return '終日';
    if (it.kind === 'task') return [hm(it.start), h('small', {}, '期限')];
    const s = it.start < d ? '前日〜' : hm(it.start);
    const e = it.end >= addDays(d, 1) ? '翌日' : hm(it.end);
    return [s, h('small', {}, e)];
  };
  $('#day-list').replaceChildren(...(items.length ? items.map((it) => {
    const status = it.kind === 'shift' && it.status === 'cancelled' ? '休み' : STATUS_LABEL[it.status];
    const sub = [KIND_LABEL[it.kind], status, it.kind === 'class' ? it.sub : it.kind === 'event' && it.allDay ? eventWhen(it.ref) : null, it.conflict && '⚠ 重なりあり']
      .filter(Boolean).join(' ・ ');
    return h('button', { class: `day-item k-${it.kind} ${it.status || ''}`, style: `--c:${it.color}`, onclick: () => openItem(it) },
      h('span', { class: 'di-time' }, timeOf(it)),
      h('span', { class: 'di-bar' }),
      h('span', { class: 'di-body' }, h('b', {}, (it.kind === 'task' ? '▲ ' : '') + (it.kind === 'class' ? it.ref.course.name : it.title)), h('span', { class: 'muted' }, sub)));
  }) : [h('div', { class: 'empty' }, '予定はありません')]));
}

// ---------- 自分の予定 ----------

function renderSwatches(box, name, colors, value) {
  const list = colors.includes(value) ? colors : [...colors, value];
  box.replaceChildren(
    ...list.map((c) => h('label', { class: 'sw', style: `--c:${c}`, title: c },
      h('input', { type: 'radio', name, value: c, checked: c === value }), h('span'))),
    h('label', { class: 'sw custom', title: 'ほかの色' }, h('input', { type: 'color', value: /^#[0-9a-f]{6}$/i.test(value) ? value : '#888888' })),
  );
}

/** 色の選択欄の値（カスタム色が選ばれていればそれ） */
function swatchValue(box) {
  const r = box.querySelector('input[type=radio]:checked');
  return r ? r.value : box.querySelector('input[type=color]').value;
}

function openEventDialog(ev, defaults = {}) {
  const f = $('#event-form');
  ui.eventEditingId = ev ? ev.id : null;
  $('#event-dialog-title').textContent = ev ? '予定を編集' : '予定を追加';
  let v = ev;
  if (!v) {
    // 新規：今日なら次の正時、それ以外の日は 10:00 から1時間
    const day = startOfDay(defaults.date || new Date());
    let s;
    if (isSameDay(day, new Date())) {
      s = new Date();
      s.setMinutes(0, 0, 0);
      s = new Date(+s + HOUR);
    } else {
      s = new Date(day);
      s.setHours(10, 0, 0, 0);
    }
    v = { title: '', allDay: false, start: s.toISOString(), end: new Date(+s + HOUR).toISOString(), color: EVENT_COLORS[5], memo: '' };
  }
  const { start, end } = eventSpan(v);
  f.title.value = v.title;
  f.allDay.checked = !!v.allDay;
  f.startDate.value = toDateInput(start);
  f.startTime.value = v.allDay ? '10:00' : hm(start);
  f.endDate.value = toDateInput(v.allDay ? addDays(end, -1) : end);
  f.endTime.value = v.allDay ? '11:00' : hm(end);
  f.memo.value = v.memo || '';
  renderSwatches($('#event-colors'), 'eventColor', EVENT_COLORS, v.color);
  updateAllDay();
  $('#event-delete').hidden = !ev;
  $('#event-dialog').showModal();
  if (!ev) f.title.focus();
}

function updateAllDay() {
  const allDay = $('#event-form').allDay.checked;
  for (const el of document.querySelectorAll('#event-form [data-time]')) el.hidden = allDay;
}

/** フォームの値 → 予定のフィールド（おかしければ { error }） */
function readEventForm() {
  const f = $('#event-form');
  const base = { title: f.title.value.trim(), allDay: f.allDay.checked, color: swatchValue($('#event-colors')), memo: f.memo.value.trim() };
  const sd = f.startDate.value, ed = f.endDate.value || sd;
  if (!sd) return { error: '開始日を入れてください' };
  if (base.allDay) {
    if (ed < sd) return { error: '終了日は開始日以降にしてください' };
    return { ...base, start: sd, end: ed };
  }
  const s = fromInputs(sd, f.startTime.value || '00:00');
  const e = fromInputs(ed, f.endTime.value || f.startTime.value || '00:00');
  if (!(e > s)) return { error: '終了は開始より後にしてください' };
  return { ...base, start: s.toISOString(), end: e.toISOString() };
}

async function deleteEvent(id) {
  const ev = eventStore.get(id);
  if (!ev) return;
  await eventStore.remove(id);
  toast('予定を削除しました', '元に戻す', () => eventStore.add(ev));
}

// ---------- 授業：タップしたときの操作（タスク一覧・編集・休講など・削除） ----------

const COURSE_COLORS = ['#e8833a', '#d64545', '#3a7be8', '#2fa36b', '#9b59d0', '#1e9fb0', '#c9a227', '#5566d6', '#d6559a', '#4aa3a0', '#8a8f98', '#7a9a4a'];

/** 授業データの形をそろえる（足りない項目を埋める） */
function normalizeCourse(c) {
  return { id: newId(), name: '', short: '', room: '', teacher: '', color: COURSE_COLORS[0], memo: '', syllabus: '', aliases: [], slots: [], changes: {}, makeups: [], ...c };
}

function openCourseDialog(courseId, dateKey = null) {
  ui.courseDialogId = courseId;
  ui.courseDialogDate = dateKey; // カレンダーから開いたときの日付（休講などの初期値）
  $('#course-task-pane').hidden = false;
  $('#course-act-tasks').setAttribute('aria-pressed', 'true');
  renderCourseDialog();
  if (!$('#course-dialog').open) $('#course-dialog').showModal();
}

function renderCourseDialog() {
  const now = new Date();
  const course = tt.get(ui.courseDialogId);
  if (!course) return $('#course-dialog').close();
  const current = tt.isCurrent(course.id);
  $('#course-name').textContent = course.name;
  const next = current && tt.nextClassStart(course, now);
  $('#course-meta').textContent = [tt.slotLabel(course), course.slots.length && course.room, next && `次回 ${fmtDateTime(next)}`]
    .filter(Boolean).join(' ・ ');

  // 担当教員・シラバス・メモ・これからの休講など
  const today = toDateInput(now);
  const upcoming = [
    ...Object.entries(course.changes || {}).filter(([k]) => k >= today)
      .map(([k, c]) => ({ k, text: c.cancel ? '休講' : `教室変更 → ${c.room}`, note: c.note })),
    ...(course.makeups || []).filter((m) => m.date >= today)
      .map((m) => ({ k: m.date, text: `補講 ${m.period}${m.endPeriod > m.period ? `-${m.endPeriod}` : ''}限 ${m.room || ''}`, note: m.note })),
  ].sort((a, b) => a.k.localeCompare(b.k));
  const safeUrl = /^https?:\/\//i.test(course.syllabus || '') ? course.syllabus : null;
  $('#course-info').replaceChildren(...[
    !current && h('div', { class: 'conflicts' }, h('div', {}, '過去の学期の授業です（アーカイブ）')),
    course.teacher && h('p', {}, `👤 ${course.teacher}`),
    safeUrl && h('p', {}, h('a', { href: safeUrl, target: '_blank', rel: 'noopener' }, '📄 シラバスを開く')),
    course.memo && h('p', { class: 'muted pre' }, course.memo),
    upcoming.length && h('ul', { class: 'upcoming' }, ...upcoming.map((u) => h('li', {}, `${fmtDate(fromKey(u.k))} ${u.text}${u.note ? `（${u.note}）` : ''}`))),
  ].filter(Boolean));
  for (const id of ['#course-act-edit', '#course-act-change', '#course-act-delete']) $(id).hidden = !current;

  const tasks = store.all().filter((t) => t.courseId === course.id);
  const open = tasks.filter((t) => !t.done);
  const done = tasks.filter((t) => t.done);
  const box = $('#course-tasks');
  renderGroupedList(box, open, now);
  if (!open.length) box.replaceChildren(h('div', { class: 'empty' }, '未完了のタスクはありません'));
  if (done.length) {
    box.append(h('div', { class: 'group-head' }, `完了済み（${done.length}）`), ...done.sort(byDue).reverse().map((t) => taskEl(t, now)));
  }
}

// ---------- 授業の追加・編集 ----------

function openCourseEdit(course, defaults = {}) {
  const f = $('#course-form');
  ui.courseEditingId = course ? course.id : null;
  ui.clashConfirmed = false;
  // 新規は、まだ使っていない色を選んでおく
  const used = new Set(tt.courses.map((c) => c.color));
  const v = course || normalizeCourse({ color: COURSE_COLORS.find((c) => !used.has(c)) || COURSE_COLORS[0], ...defaults });
  $('#course-edit-title').textContent = course ? '授業を編集' : '授業を追加';
  f.name.value = v.name;
  f.short.value = v.short || '';
  f.room.value = v.room || '';
  f.teacher.value = v.teacher || '';
  f.syllabus.value = v.syllabus || '';
  f.aliases.value = (v.aliases || []).join(', ');
  f.memo.value = v.memo || '';
  ui.slotRows = groupSlots(v.slots).map((g) => ({ day: g.day, from: g.from, to: g.to }));
  f.onDemand.checked = !ui.slotRows.length;
  renderSlotRows();
  renderSwatches($('#course-colors'), 'courseColor', COURSE_COLORS, v.color);
  showClash();
  $('#course-edit-dialog').showModal();
  if (!course) f.name.focus();
}

/** 曜日・時限の行（連続コマは「3〜4限」のように1行で） */
function renderSlotRows() {
  const od = $('#course-form').onDemand.checked;
  $('#slot-rows').hidden = od;
  $('#slot-add').hidden = od;
  const periodOpts = (sel) => tt.periods.map((p) => h('option', { value: p.period, selected: p.period === sel }, `${p.period}限`));
  $('#slot-rows').replaceChildren(...ui.slotRows.map((r, i) => h('div', { class: 'slot-row' },
    h('select', { 'data-i': i, 'data-f': 'day', 'aria-label': '曜日' }, ...tt.days.map((d, di) => h('option', { value: di + 1, selected: di + 1 === r.day }, `${d}曜`))),
    h('select', { 'data-i': i, 'data-f': 'from', 'aria-label': '開始時限' }, ...periodOpts(r.from)),
    h('span', {}, '〜'),
    h('select', { 'data-i': i, 'data-f': 'to', 'aria-label': '終了時限' }, ...periodOpts(r.to)),
    h('button', { type: 'button', class: 'btn icon sm', 'data-remove': i, 'aria-label': 'このコマを削除', disabled: ui.slotRows.length <= 1 }, '✕'),
  )));
}

/** フォームのコマ → [{ day, period }] */
function formSlots() {
  if ($('#course-form').onDemand.checked) return [];
  const out = [];
  for (const r of ui.slotRows) {
    for (let p = r.from; p <= r.to; p++) {
      if (!out.some((s) => s.day === r.day && s.period === p)) out.push({ day: r.day, period: p });
    }
  }
  return out.sort((a, b) => a.day - b.day || a.period - b.period);
}

/** 同じコマにほかの授業があるか */
function courseClashes() {
  const msgs = [];
  for (const s of formSlots()) {
    for (const o of tt.coursesAt(s.day, s.period)) {
      if (o.id !== ui.courseEditingId) msgs.push(`${tt.days[s.day - 1]}曜${s.period}限 には「${o.name}」が入っています`);
    }
  }
  return msgs;
}

function showClash() {
  const msgs = courseClashes();
  const box = $('#course-clash');
  box.hidden = !msgs.length;
  box.replaceChildren(...msgs.map((m) => h('div', {}, m)));
  ui.clashConfirmed = false;
  $('#course-save').textContent = '保存';
}

// ---------- 授業の削除 ----------

function openCourseDelete(courseId) {
  const course = tt.get(courseId);
  if (!course) return;
  ui.courseDeleteId = courseId;
  const n = store.all().filter((t) => t.courseId === courseId).length;
  $('#course-delete-text').textContent = n
    ? `「${course.name}」を削除します。この授業に紐づいたタスクが ${n} 件あります。タスクはどうしますか？`
    : `「${course.name}」を削除します。よろしいですか？`;
  $('#cdel-with-tasks').hidden = !n;
  $('#cdel-keep-tasks').textContent = n ? '授業なしとして残す' : '削除する';
  $('#course-delete-dialog').showModal();
}

async function deleteCourse(withTasks) {
  const course = courseStore.get(ui.courseDeleteId);
  if (!course) return;
  const linked = store.all().filter((t) => t.courseId === course.id);
  for (const t of linked) {
    if (withTasks) {
      await store.remove(t.id);
      gcal?.onRemoved(t);
    } else {
      await saveTask({ ...t, courseId: null }, false);
    }
  }
  await courseStore.remove(course.id);
  $('#course-delete-dialog').close();
  $('#course-dialog').close();
  toast(`「${course.name}」を削除しました`, '元に戻す', async () => {
    await courseStore.add(course);
    for (const t of linked) await saveTask(withTasks ? { ...t, gcalEventId: null } : t, withTasks);
  });
}

// ---------- 特定の日だけの変更（休講・補講・教室変更） ----------

function openChangeDialog(courseId, dateKey) {
  const course = courseStore.get(courseId);
  if (!course) return;
  ui.changeCourseId = courseId;
  const f = $('#change-form');
  const next = tt.nextClassStart(course);
  f.kind.value = 'cancel';
  f.date.value = dateKey || (next ? toDateInput(next) : toDateInput(new Date()));
  const opts = () => tt.periods.map((p) => h('option', { value: p.period }, `${p.period}限`));
  f.period.replaceChildren(...opts());
  f.endPeriod.replaceChildren(...opts());
  f.room.value = course.room || '';
  f.note.value = '';
  $('#change-course').textContent = `${course.name}（${tt.slotLabel(course)}）`;
  updateChangeKind();
  renderChangeList();
  $('#change-dialog').showModal();
}

function updateChangeKind() {
  const kind = $('#change-form').kind.value;
  for (const el of document.querySelectorAll('#change-form [data-for]')) el.hidden = !el.dataset.for.split(' ').includes(kind);
}

function renderChangeList() {
  const course = courseStore.get(ui.changeCourseId);
  if (!course) return;
  const today = toDateInput(new Date());
  const rows = [
    ...Object.entries(course.changes || {}).map(([k, c]) => ({ k, type: 'change', text: c.cancel ? '休講' : `教室変更 → ${c.room}`, note: c.note })),
    ...(course.makeups || []).map((m) => ({ k: m.date, type: 'makeup', id: m.id, text: `補講 ${m.period}${m.endPeriod > m.period ? `-${m.endPeriod}` : ''}限 ${m.room || ''}`, note: m.note })),
  ].sort((a, b) => a.k.localeCompare(b.k));
  $('#change-list').replaceChildren(...(rows.length ? rows.map((r) => h('div', { class: `change-row ${r.k < today ? 'past' : ''}` },
    h('span', {}, `${fmtDate(fromKey(r.k))} ${r.text}`, r.note ? h('small', { class: 'muted' }, ` ${r.note}`) : null),
    h('button', { type: 'button', class: 'btn icon sm', 'data-type': r.type, 'data-key': r.k, 'data-id': r.id || '', 'aria-label': '取り消す' }, '✕'),
  )) : [h('p', { class: 'muted' }, '登録された変更はありません')]));
}

// ---------- 学期の切り替え ----------

function renderTermInfo() {
  const input = $('#term-name');
  if (document.activeElement !== input) input.value = tt.term;
  const archives = courseStore.getMeta('archives') || [];
  $('#term-info').textContent = `授業 ${tt.courses.length} 件` + (archives.length ? ` ・ アーカイブ ${archives.length} 件（${archives.map((a) => a.term || '名前なし').join('、')}）` : '');
}

async function switchTerm({ term, start, archive }) {
  const archives = courseStore.getMeta('archives') || [];
  if (archive && courseStore.all().length) {
    archives.push({ term: tt.term, archivedAt: new Date().toISOString(), courses: courseStore.all() });
  }
  await courseStore.setMeta('archives', archives);
  await courseStore.setMeta('term', term);
  await courseStore.setMeta('seeded', true);
  // replaceAll で変更が通知され、時間割・カレンダー・選択肢が描き直される
  await courseStore.replaceAll(start === 'seed' ? tt.seedCourses.map(normalizeCourse) : []);
}

// ---------- シフトの登録・編集 ----------

function openShiftDialog(shift, defaults = {}) {
  const f = $('#shift-form');
  const today = toDateInput(new Date());
  const v = shift || { kind: 'once', date: today, weekday: new Date().getDay(), from: today, until: null, start: '18:00', end: '21:00', place: '', wage: null, memo: '', ...defaults };
  ui.shiftEditingId = shift ? shift.id : null;
  $('#shift-dialog-title').textContent = shift ? 'シフトを編集' : 'バイトを追加';
  f.kind.value = v.kind;
  f.date.value = v.date || today;
  f.weekday.value = String(v.weekday ?? new Date().getDay());
  f.from.value = v.from || today;
  f.until.value = v.until || '';
  f.start.value = v.start;
  f.end.value = v.end;
  f.place.value = v.place || '';
  f.wage.value = v.wage || '';
  f.memo.value = v.memo || '';
  // 勤務先の候補（過去に入力したもの）
  const places = [...new Set(shiftStore.all().map((s) => s.place).filter(Boolean))];
  $('#place-list').replaceChildren(...places.map((p) => h('option', { value: p })));
  $('#shift-delete').hidden = !shift;
  $('#shift-conflict').hidden = true;
  updateShiftKind();
  $('#shift-dialog').showModal();
}

/** 単発 / 毎週 で入力欄を切り替える */
function updateShiftKind() {
  const kind = $('#shift-form').kind.value;
  for (const el of document.querySelectorAll('#shift-form [data-kind]')) el.hidden = el.dataset.kind !== kind;
}

function readShiftForm() {
  const f = $('#shift-form');
  const kind = f.kind.value;
  return {
    kind,
    date: kind === 'once' ? f.date.value || null : null,
    weekday: kind === 'weekly' ? Number(f.weekday.value) : null,
    from: kind === 'weekly' ? f.from.value || toDateInput(new Date()) : null,
    until: kind === 'weekly' ? f.until.value || null : null,
    start: f.start.value,
    end: f.end.value,
    place: f.place.value.trim(),
    wage: f.wage.value ? Math.max(0, Number(f.wage.value)) || null : null,
    memo: f.memo.value.trim(),
  };
}

/** このシフトがこの先 8 週間で何かと重なっていないか */
function upcomingShiftConflicts(shiftId) {
  const from = startOfDay(new Date());
  return findConflicts({ tt, shifts: shiftStore.all(), tasks: store.all(), rangeStart: from, rangeEnd: addDays(from, 56) })
    .filter((c) => c.shiftIds.includes(shiftId));
}

async function saveShift(fields) {
  const saved = ui.shiftEditingId
    ? await shiftStore.update(ui.shiftEditingId, fields)
    : await shiftStore.add(makeShift(fields));
  const conflicts = upcomingShiftConflicts(saved.id);
  if (conflicts.length) {
    toast(`保存しました。⚠ ${conflicts.length}件の重なりがあります`, '確認', () => setCalMode('week', conflicts[0].at));
  } else {
    toast('保存しました');
  }
  return saved;
}

async function deleteShift(id) {
  const shift = shiftStore.get(id);
  if (!shift) return;
  await shiftStore.remove(id);
  toast('シフトを削除しました', '元に戻す', () => shiftStore.add(shift));
}

// ---------- シフト1回分の操作 ----------

function openOccDialog(shiftId, key) {
  ui.occ = { shiftId, key };
  renderOccDialog();
  $('#occ-dialog').showModal();
}

function currentOcc() {
  if (!ui.occ) return null;
  const shift = shiftStore.get(ui.occ.shiftId);
  if (!shift) return null;
  const day = fromKey(ui.occ.key);
  return occurrences(shift, day, addDays(day, 1))[0] || null;
}

function renderOccDialog() {
  const o = currentOcc();
  if (!o) return $('#occ-dialog').close();
  const weekly = o.shift.kind === 'weekly';
  $('#occ-title').textContent = `💼 ${o.shift.place || 'バイト'}`;
  $('#occ-meta').textContent = [
    `${fmtDate(o.start)} ${hm(o.start)}–${hm(o.end)}`,
    o.cancelled ? 'この日は休み' : o.changed ? 'この日だけ時間変更' : null,
    weekly ? shiftRuleLabel(o.shift) : null,
    o.shift.wage ? `時給 ${yen(o.shift.wage)}` : null,
  ].filter(Boolean).join(' ・ ');
  $('#occ-memo').textContent = o.memo;

  const day = fromKey(o.key);
  const conflicts = findConflicts({ tt, shifts: shiftStore.all(), tasks: store.all(), rangeStart: day, rangeEnd: addDays(day, 1) })
    .filter((c) => c.shiftIds.includes(o.shift.id));
  const cbox = $('#occ-conflict');
  cbox.hidden = !conflicts.length || o.cancelled;
  cbox.replaceChildren(...conflicts.map((c) => h('div', {}, c.text)));

  $('#occ-weekly').hidden = !weekly;
  $('#occ-start').value = hm(o.start);
  $('#occ-end').value = hm(o.end);
  const hasException = !!(o.shift.exceptions || {})[o.key];
  $('#occ-cancel').hidden = o.cancelled;
  $('#occ-reset').hidden = !hasException;
  $('#occ-gcal').hidden = o.cancelled;
  $('#occ-gcal-series').hidden = !weekly;
}

/** 毎週シフトのこの日だけの例外を設定（null で解除）。変更前の例外を返す */
async function setException(exception) {
  const o = currentOcc();
  if (!o) return null;
  const exceptions = { ...(o.shift.exceptions || {}) };
  const before = exceptions[o.key] || null;
  if (exception) exceptions[o.key] = exception;
  else delete exceptions[o.key];
  await shiftStore.update(o.shift.id, { exceptions });
  return before;
}

// ---------- 今週のノート ----------

const weekKey = (d) => toDateInput(startOfWeek(d));
let noteTimer = null;
let noteDirty = null; // 未保存の { key, text }

function renderNotes(now) {
  // 入力中は描き直さない（カーソル位置が飛ぶため）
  if (ui.noteEditing) return;
  const key = weekKey(ui.noteWeek);
  const isThisWeek = key === weekKey(now);
  const ws = fromKey(key);
  $('#view-notes h3').textContent = isThisWeek ? '今週の注意点' : 'この週の注意点';
  $('#note-range').textContent = `${md(ws)} – ${md(addDays(ws, 6))}`;
  $('#note-today').hidden = isThisWeek;

  const note = noteStore.get(key);
  const text = note?.text || '';
  const view = $('#note-view');
  $('#note-input').hidden = true;
  view.hidden = false;
  if (!text.trim()) {
    view.replaceChildren(h('span', { class: 'empty-note' }, 'タップして書く（「- 」で始めるとチェックできる項目になります）'));
  } else {
    view.replaceChildren(...text.split('\n').map((line, i) => {
      const p = parseLine(line);
      if (p.type === 'text') return h('p', {}, line);
      return h('label', { class: `note-item ${p.checked ? 'checked' : ''}`, style: `margin-left:${p.indent * 0.6}em` },
        h('input', { type: 'checkbox', 'data-line': i, checked: p.checked }),
        h('span', {}, p.text));
    }));
  }

  // 新しい週：前週の未チェック項目を引き継ぐか選べる（一度選んだら出さない）
  const carry = $('#note-carry');
  const prev = noteStore.get(toDateInput(addDays(ws, -7)));
  const items = uncheckedItems(prev?.text);
  carry.hidden = !(isThisWeek && !note?.carryDecided && items.length);
  if (!carry.hidden) {
    carry.replaceChildren(
      h('div', {}, `先週のノートに未チェックの項目が ${items.length} 件あります。今週に引き継ぎますか？`),
      h('ul', {}, ...items.map((t) => h('li', {}, t.replace(/^\s*- /, '')))),
      h('div', { class: 'btn-row' },
        h('button', { class: 'btn primary sm', onclick: () => decideCarry(key, items) }, '引き継ぐ'),
        h('button', { class: 'btn sm', onclick: () => decideCarry(key, null) }, '引き継がない')),
    );
  }
}

async function decideCarry(key, items) {
  const text = noteStore.get(key)?.text || '';
  const carried = items ? items.join('\n') : '';
  await noteStore.put({ id: key, text: [text, carried].filter((t) => t.trim()).join('\n'), carryDecided: true });
}

/** ノートを保存（自動保存・チェック切り替えから呼ばれる） */
async function saveNote(key, text) {
  const note = noteStore.get(key);
  await noteStore.put({ id: key, text, carryDecided: note?.carryDecided ?? false });
  $('#note-status').textContent = '保存しました';
}

/** 入力の途中でも、たまっている変更をすぐ保存する */
function flushNote() {
  clearTimeout(noteTimer);
  if (!noteDirty) return;
  const { key, text } = noteDirty;
  noteDirty = null;
  saveNote(key, text);
}

function fitNoteInput() {
  const input = $('#note-input');
  input.style.height = 'auto';
  input.style.height = `${Math.max(120, input.scrollHeight + 4)}px`;
}

function startNoteEdit() {
  const key = weekKey(ui.noteWeek);
  ui.noteEditing = key; // 編集中の週のキー（途中で週を切り替えても正しい週に保存する）
  const input = $('#note-input');
  input.value = noteStore.get(key)?.text || '';
  $('#note-view').hidden = true;
  input.hidden = false;
  fitNoteInput();
  input.focus();
}

// ====================================================================
// タスク編集ダイアログ
// ====================================================================
function fillCourseSelect(select, currentId) {
  const withSlots = tt.courses.filter((c) => c.slots.length);
  const archived = currentId && !tt.isCurrent(currentId) ? tt.get(currentId) : null;
  select.replaceChildren(
    h('option', { value: '' }, 'なし（個人タスク）'),
    h('optgroup', { label: '時間割' }, ...withSlots.map((c) => h('option', { value: c.id }, `${c.name}（${tt.slotLabel(c)}）`))),
    h('optgroup', { label: 'OD（オンデマンド）' }, ...tt.onDemand.map((c) => h('option', { value: c.id }, c.name))),
    archived && h('optgroup', { label: '過去の学期' }, h('option', { value: archived.id }, archived.name)),
  );
}

/**
 * @param {object|null} task 既存タスク（新規なら null）
 * @param {object} defaults 新規時の初期値
 */
function openTaskDialog(task, defaults = {}) {
  const f = $('#task-form');
  const v = task || { title: '', due: null, courseId: null, priority: 'mid', memo: '', estimateMin: null, ...defaults };
  ui.editingId = task ? task.id : null;
  $('#task-dialog-title').textContent = task ? 'タスクを編集' : '新しいタスク';
  fillCourseSelect(f.courseId, v.courseId);
  f.title.value = v.title || '';
  const due = v.due ? new Date(v.due) : null;
  f.dueDate.value = due ? toDateInput(due) : '';
  f.dueTime.value = due ? toTimeInput(due) : '';
  f.courseId.value = v.courseId || '';
  f.priority.value = v.priority || 'mid';
  f.estimateMin.value = v.estimateMin || '';
  f.memo.value = v.memo || '';
  $('#task-delete').hidden = !task;
  $('#task-dialog').showModal();
  if (!task && !v.title) f.title.focus();
}

/** フォームの値をタスクのフィールドにする */
function readTaskForm() {
  const f = $('#task-form');
  const due = fromInputs(f.dueDate.value, f.dueTime.value);
  return {
    title: f.title.value.trim(),
    due: due ? due.toISOString() : null,
    courseId: f.courseId.value || null,
    priority: f.priority.value || 'mid',
    estimateMin: f.estimateMin.value ? Math.max(0, parseInt(f.estimateMin.value, 10)) || null : null,
    memo: f.memo.value.trim(),
  };
}

function setFormDue(d) {
  const f = $('#task-form');
  f.dueDate.value = d ? toDateInput(d) : '';
  f.dueTime.value = d ? toTimeInput(d) : '';
}

// ====================================================================
// イベント
// ====================================================================
function bindEvents() {
  // タブ切り替え
  $('#tabbar').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-view]');
    if (b) setView(b.dataset.view);
  });

  // 絞り込み
  $('#filters').addEventListener('click', (e) => {
    const b = e.target.closest('[data-filter]');
    if (!b) return;
    ui.filter = b.dataset.filter;
    renderAll();
  });

  // ---- クイック入力 ----
  const qi = $('#quick-input');
  qi.addEventListener('input', () => renderPreview(qi.value));
  $('#quick-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const text = qi.value.trim();
    if (!text) return;
    const p = parseQuickInput(text, tt);
    if (!p.title) return;
    const task = await saveTask(makeTask({ ...p, due: p.due ? p.due.toISOString() : null }), true);
    qi.value = '';
    renderPreview('');
    const c = taskConflicts(task)[0];
    toast(c ? `追加しました。⚠ ${c.text}` : `「${task.title}」を追加しました`, '編集', () => openTaskDialog(store.get(task.id)));
  });
  $('#quick-detail').addEventListener('click', () => {
    const text = qi.value.trim();
    const p = text ? parseQuickInput(text, tt) : {};
    openTaskDialog(null, { ...p, due: p.due ? p.due.toISOString() : null, courseId: p.courseId || (ui.filter === 'course' && ui.courseFilter !== 'none' ? ui.courseFilter : null) });
    qi.value = '';
    renderPreview('');
  });

  // ---- タスクカード（一覧・授業ダイアログ共通、イベント委譲） ----
  const onListClick = (e) => {
    const card = e.target.closest('.task');
    if (!card) return;
    const id = card.dataset.id;
    const task = store.all().find((t) => t.id === id);
    if (!task) return;
    if (e.target.closest('.check')) toggleDone(id);
    else if (e.target.closest('.t-cal')) window.open(googleCalendarUrl(task, tt.get(task.courseId)), '_blank', 'noopener');
    else openTaskDialog(task);
  };
  $('#task-list').addEventListener('click', onListClick);
  $('#course-tasks').addEventListener('click', onListClick);

  // ---- ダイアログ共通：✕ ボタンと背景クリックで閉じる ----
  for (const dlg of document.querySelectorAll('dialog')) {
    dlg.addEventListener('click', (e) => {
      if (e.target.closest('[data-close]')) return dlg.close();
      // 背景（::backdrop）のクリックは dialog 自身へのクリックとして届くので、座標で枠外か判定する
      if (e.target !== dlg) return;
      const r = dlg.getBoundingClientRect();
      const inside = e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
      if (!inside) dlg.close();
    });
  }

  // ---- タスク編集フォーム ----
  const form = $('#task-form');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fields = readTaskForm();
    if (!fields.title) return;
    const saved = ui.editingId
      ? await saveTask({ ...store.get(ui.editingId), ...fields }, false)
      : await saveTask(makeTask(fields), true);
    $('#task-dialog').close();
    const c = taskConflicts(saved)[0];
    if (c) toast(`⚠ ${c.text}`);
  });

  form.querySelector('.quick-dates').addEventListener('click', (e) => {
    const b = e.target.closest('[data-due]');
    if (!b) return;
    const now = new Date();
    const end = (d) => { d.setHours(23, 59, 0, 0); return d; };
    switch (b.dataset.due) {
      case 'today': setFormDue(end(new Date(now))); break;
      case 'tomorrow': setFormDue(end(addDays(now, 1))); break;
      case 'week': setFormDue(end(addDays(now, 7))); break;
      case 'clear': setFormDue(null); break;
      case 'next': {
        const next = tt.nextClassStart(tt.get(form.courseId.value), now);
        if (next) setFormDue(next);
        else toast('授業（時間割にあるもの）を先に選んでください');
        break;
      }
    }
  });

  $('#task-delete').addEventListener('click', () => {
    if (!ui.editingId) return;
    deleteTask(ui.editingId);
    $('#task-dialog').close();
  });

  $('#task-gcal').addEventListener('click', () => {
    const fields = readTaskForm();
    if (!fields.due) return toast('期限を設定してください');
    window.open(googleCalendarUrl({ ...fields, title: fields.title || '課題' }, tt.get(fields.courseId)), '_blank', 'noopener');
  });

  // ---- シフトのダイアログ ----
  const sf = $('#shift-form');
  sf.addEventListener('change', (e) => { if (e.target.name === 'kind') updateShiftKind(); });
  sf.place.addEventListener('change', () => {
    // 同じ勤務先の時給を自動で入れる
    if (sf.wage.value) return;
    const prev = [...shiftStore.all()].reverse().find((s) => s.place === sf.place.value.trim() && s.wage);
    if (prev) sf.wage.value = prev.wage;
  });
  sf.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fields = readShiftForm();
    if (fields.kind === 'once' && !fields.date) return toast('日付を入れてください');
    if (!fields.start || !fields.end) return toast('時間を入れてください');
    if (fields.start === fields.end) return toast('開始と終了が同じ時刻です');
    await saveShift(fields);
    $('#shift-dialog').close();
  });
  $('#shift-delete').addEventListener('click', () => {
    if (!ui.shiftEditingId) return;
    deleteShift(ui.shiftEditingId);
    $('#shift-dialog').close();
  });

  // ---- シフト1回分 ----
  $('#occ-apply').addEventListener('click', async () => {
    const start = $('#occ-start').value, end = $('#occ-end').value;
    if (!start || !end || start === end) return toast('時間を確認してください');
    const o = currentOcc();
    // いつもと同じ時間に戻したなら例外を消す
    await setException(start === o.shift.start && end === o.shift.end ? null : { start, end });
    toast('この日だけ時間を変更しました');
  });
  $('#occ-cancel').addEventListener('click', async () => {
    const before = await setException({ cancel: true });
    toast('この日を休みにしました', '元に戻す', () => setException(before));
  });
  $('#occ-reset').addEventListener('click', async () => {
    await setException(null);
    toast('いつもの時間に戻しました');
  });
  $('#occ-gcal').addEventListener('click', () => {
    const o = currentOcc();
    if (o) window.open(shiftOccurrenceUrl(o), '_blank', 'noopener');
  });
  $('#occ-gcal-series').addEventListener('click', () => {
    const o = currentOcc();
    const url = o && shiftSeriesUrl(o.shift);
    if (!url) return;
    if (Object.keys(o.shift.exceptions || {}).length) {
      toast('休み・時間変更の日は反映されないので、追加後にカレンダー側で直してください');
    }
    window.open(url, '_blank', 'noopener');
  });
  $('#occ-edit').addEventListener('click', () => {
    const o = currentOcc();
    $('#occ-dialog').close();
    if (o) openShiftDialog(o.shift);
  });

  // ---- 今週のノート ----
  const noteInput = $('#note-input');
  $('#note-view').addEventListener('click', async (e) => {
    const cb = e.target.closest('input[type=checkbox]');
    if (cb) {
      // チェックの切り替えはその場で保存
      const key = weekKey(ui.noteWeek);
      await saveNote(key, toggleLine(noteStore.get(key)?.text || '', Number(cb.dataset.line)));
      return;
    }
    if (e.target.closest('label')) return; // 項目の文字をタップしたときはチェックの切り替えになる
    startNoteEdit();
  });
  $('#note-view').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target === $('#note-view')) { e.preventDefault(); startNoteEdit(); }
  });
  noteInput.addEventListener('input', () => {
    // 入力が 0.5 秒止まったら自動保存
    noteDirty = { key: ui.noteEditing, text: noteInput.value };
    $('#note-status').textContent = '…';
    clearTimeout(noteTimer);
    noteTimer = setTimeout(flushNote, 500);
    fitNoteInput();
  });
  noteInput.addEventListener('blur', () => {
    flushNote();
    ui.noteEditing = false;
    renderNotes(new Date());
  });
  // アプリを切り替えたとき・閉じるときにも取りこぼさず保存
  document.addEventListener('visibilitychange', () => document.visibilityState === 'hidden' && flushNote());
  window.addEventListener('pagehide', flushNote);
  const moveNote = (d) => { ui.noteWeek = d; $('#note-status').textContent = ''; renderNotes(new Date()); };
  $('#note-prev').addEventListener('click', () => moveNote(addDays(ui.noteWeek, -7)));
  $('#note-next').addEventListener('click', () => moveNote(addDays(ui.noteWeek, 7)));
  $('#note-today').addEventListener('click', () => moveNote(startOfWeek(new Date())));

  // ---- カレンダー ----
  $('#cal-seg').addEventListener('change', (e) => setCalMode(e.target.value));
  $('#cal-prev').addEventListener('click', () => moveCal(-1));
  $('#cal-next').addEventListener('click', () => moveCal(1));
  $('#cal-today').addEventListener('click', () => setCalMode(ui.cal.mode, new Date()));
  $('#cal-filters').addEventListener('click', (e) => {
    const b = e.target.closest('[data-kind]');
    if (!b) return;
    ui.calShow = { ...ui.calShow, [b.dataset.kind]: !ui.calShow[b.dataset.kind] };
    localStorage.setItem('kadai-board.calShow', JSON.stringify(ui.calShow));
    renderCalendar(new Date());
  });
  $('#cal-add').addEventListener('click', () => $('#add-dialog').showModal());
  $('#cal-add-shift').addEventListener('click', () => addOnDate('shift', calBaseDate()));
  $('#add-dialog').addEventListener('click', (e) => {
    const b = e.target.closest('[data-add]');
    if (!b) return;
    $('#add-dialog').close();
    addOnDate(b.dataset.add, calBaseDate());
  });

  // ---- その日の一覧 ----
  $('#day-open').addEventListener('click', () => {
    $('#day-dialog').close();
    setCalMode('day', ui.dayDate);
  });
  $('#day-add-event').addEventListener('click', () => addOnDate('event', ui.dayDate));
  $('#day-add-task').addEventListener('click', () => addOnDate('task', ui.dayDate));
  $('#day-add-shift').addEventListener('click', () => addOnDate('shift', ui.dayDate));

  // ---- 自分の予定 ----
  const ef = $('#event-form');
  ef.allDay.addEventListener('change', updateAllDay);
  ef.startDate.addEventListener('change', () => {
    // 終了日が開始日より前にならないように
    if (!ef.endDate.value || ef.endDate.value < ef.startDate.value) ef.endDate.value = ef.startDate.value;
  });
  ef.startTime.addEventListener('change', () => {
    // 同じ日で終了が開始以前になったら、1時間後にずらす
    if (ef.endDate.value === ef.startDate.value && ef.endTime.value <= ef.startTime.value) {
      const s = fromInputs(ef.startDate.value, ef.startTime.value);
      const e = new Date(+s + HOUR);
      ef.endDate.value = toDateInput(e);
      ef.endTime.value = hm(e);
    }
  });
  // 「ほかの色」を選んだら、丸い色の選択を外す
  for (const box of [$('#event-colors'), $('#course-colors')]) {
    box.addEventListener('input', (e) => {
      if (e.target.type === 'color') box.querySelectorAll('input[type=radio]').forEach((r) => (r.checked = false));
    });
  }
  ef.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fields = readEventForm();
    if (fields.error) return toast(fields.error);
    if (!fields.title) return toast('タイトルを入れてください');
    if (ui.eventEditingId) await eventStore.update(ui.eventEditingId, fields);
    else await eventStore.add(makeEvent(fields));
    $('#event-dialog').close();
    toast('予定を保存しました');
  });
  $('#event-delete').addEventListener('click', () => {
    if (!ui.eventEditingId) return;
    deleteEvent(ui.eventEditingId);
    $('#event-dialog').close();
  });
  $('#event-gcal').addEventListener('click', () => {
    const fields = readEventForm();
    if (fields.error) return toast(fields.error);
    window.open(eventUrl({ ...fields, title: fields.title || '予定' }), '_blank', 'noopener');
  });

  // ---- 授業：操作の選択 ----
  $('#course-act-tasks').addEventListener('click', () => {
    const pane = $('#course-task-pane');
    pane.hidden = !pane.hidden;
    $('#course-act-tasks').setAttribute('aria-pressed', String(!pane.hidden));
  });
  $('#course-act-edit').addEventListener('click', () => {
    const course = courseStore.get(ui.courseDialogId);
    $('#course-dialog').close();
    if (course) openCourseEdit(course);
  });
  $('#course-act-change').addEventListener('click', () => openChangeDialog(ui.courseDialogId, ui.courseDialogDate));
  $('#course-act-delete').addEventListener('click', () => openCourseDelete(ui.courseDialogId));
  $('#cdel-with-tasks').addEventListener('click', () => deleteCourse(true));
  $('#cdel-keep-tasks').addEventListener('click', () => deleteCourse(false));

  // ---- 授業の追加・編集 ----
  const cf = $('#course-form');
  cf.onDemand.addEventListener('change', () => {
    if (!cf.onDemand.checked && !ui.slotRows.length) ui.slotRows.push({ day: 1, from: 1, to: 1 });
    renderSlotRows();
    showClash();
  });
  $('#slot-rows').addEventListener('change', (e) => {
    const sel = e.target.closest('select[data-f]');
    if (!sel) return;
    const r = ui.slotRows[+sel.dataset.i];
    r[sel.dataset.f] = Number(sel.value);
    // 「3〜2限」のような逆転は直す
    if (r.to < r.from) {
      if (sel.dataset.f === 'from') r.to = r.from;
      else r.from = r.to;
      renderSlotRows();
    }
    showClash();
  });
  $('#slot-rows').addEventListener('click', (e) => {
    const b = e.target.closest('[data-remove]');
    if (!b) return;
    ui.slotRows.splice(+b.dataset.remove, 1);
    renderSlotRows();
    showClash();
  });
  $('#slot-add').addEventListener('click', () => {
    const last = ui.slotRows[ui.slotRows.length - 1];
    ui.slotRows.push(last ? { day: Math.min(tt.days.length, last.day + 1), from: last.from, to: last.to } : { day: 1, from: 1, to: 1 });
    renderSlotRows();
    showClash();
  });
  cf.addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = cf.name.value.trim();
    if (!name) return toast('授業名を入れてください');
    const slots = formSlots();
    if (!cf.onDemand.checked && !slots.length) return toast('曜日・時限を入れるか、オンデマンドにしてください');
    // 同じコマにほかの授業があれば、1回目は警告だけ出す
    const clashes = courseClashes();
    if (clashes.length && !ui.clashConfirmed) {
      ui.clashConfirmed = true;
      $('#course-clash').append(h('div', {}, 'このまま保存するなら、もう一度「重なっていても保存」を押してください'));
      $('#course-save').textContent = '重なっていても保存';
      return;
    }
    const fields = {
      name,
      short: cf.short.value.trim(),
      room: cf.room.value.trim(),
      teacher: cf.teacher.value.trim(),
      color: swatchValue($('#course-colors')),
      syllabus: cf.syllabus.value.trim(),
      aliases: cf.aliases.value.split(/[,、，]/).map((s) => s.trim()).filter(Boolean),
      memo: cf.memo.value.trim(),
      slots,
    };
    if (ui.courseEditingId) await courseStore.update(ui.courseEditingId, fields);
    else await courseStore.add(normalizeCourse(fields));
    $('#course-edit-dialog').close();
    toast(`「${name}」を保存しました`);
  });

  // ---- 休講・補講・教室変更 ----
  const chf = $('#change-form');
  chf.addEventListener('change', (e) => { if (e.target.name === 'kind') updateChangeKind(); });
  chf.period.addEventListener('change', () => { if (+chf.endPeriod.value < +chf.period.value) chf.endPeriod.value = chf.period.value; });
  chf.addEventListener('submit', async (e) => {
    e.preventDefault();
    const course = courseStore.get(ui.changeCourseId);
    if (!course) return;
    const kind = chf.kind.value;
    const date = chf.date.value;
    if (!date) return toast('日付を入れてください');
    const note = chf.note.value.trim();
    const room = chf.room.value.trim();
    if (kind === 'makeup') {
      const period = Number(chf.period.value);
      const endPeriod = Math.max(period, Number(chf.endPeriod.value));
      const makeups = [...(course.makeups || []), { id: newId(), date, period, endPeriod, room: room || course.room, note }];
      await courseStore.update(course.id, { makeups });
      toast('補講を追加しました');
    } else {
      // 休講・教室変更は、その授業がある曜日だけ
      const dow = fromKey(date).getDay();
      if (!course.slots.some((s) => s.day === dow)) return toast(`${WEEKDAYS[dow]}曜日はこの授業の日ではありません`);
      if (kind === 'room' && !room) return toast('変更後の教室を入れてください');
      const changes = { ...(course.changes || {}), [date]: kind === 'cancel' ? { cancel: true, note } : { room, note } };
      await courseStore.update(course.id, { changes });
      toast(kind === 'cancel' ? '休講を登録しました' : '教室変更を登録しました');
    }
    chf.note.value = '';
    renderChangeList();
  });
  $('#change-list').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-type]');
    if (!b) return;
    const course = courseStore.get(ui.changeCourseId);
    if (b.dataset.type === 'makeup') {
      await courseStore.update(course.id, { makeups: (course.makeups || []).filter((m) => m.id !== b.dataset.id) });
    } else {
      const changes = { ...(course.changes || {}) };
      delete changes[b.dataset.key];
      await courseStore.update(course.id, { changes });
    }
    renderChangeList();
  });

  // ---- 学期 ----
  $('#term-name').addEventListener('change', async (e) => {
    await courseStore.setMeta('term', e.target.value.trim());
    syncTimetable();
    renderAll();
  });
  $('#term-switch').addEventListener('click', () => {
    const f = $('#term-form');
    f.term.value = '';
    $('#term-dialog').showModal();
    f.term.focus();
  });
  $('#term-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    const term = f.term.value.trim();
    if (!term) return toast('学期の名前を入れてください');
    await switchTerm({ term, start: f.start.value, archive: f.archive.checked });
    $('#term-dialog').close();
    toast(`「${term}」に切り替えました`);
  });

  // ---- 授業ダイアログ ----
  $('#course-add').addEventListener('click', () => {
    const courseId = ui.courseDialogId;
    $('#course-dialog').close();
    openTaskDialog(null, { courseId });
  });

  // ---- 設定 ----
  $('#export-ics').addEventListener('click', () => {
    const includeDone = $('#ics-include-done').checked;
    const tasks = store.all().filter((t) => t.due && (includeDone || !t.done));
    const shifts = $('#ics-include-shifts').checked ? shiftStore.all() : [];
    const events = $('#ics-include-events').checked ? eventStore.all() : [];
    if (!tasks.length && !shifts.length && !events.length) return toast('書き出す予定がありません');
    const extra = [...shifts.flatMap(shiftIcsLines), ...events.flatMap(eventIcsLines)];
    downloadText(`kadai-${toDateInput(new Date())}.ics`, buildIcs(tasks, tt, extra), 'text/calendar;charset=utf-8');
    toast(`タスク${tasks.length}件・シフト${shifts.length}件・予定${events.length}件を書き出しました`);
  });

  $('#backup-export').addEventListener('click', () => {
    const data = {
      app: 'kadai-board', version: 3, exportedAt: new Date().toISOString(),
      tasks: store.all(), shifts: shiftStore.all(), notes: noteStore.all(), events: eventStore.all(),
      courses: courseStore.all(), term: tt.term, archives: courseStore.getMeta('archives') || [],
    };
    downloadText(`kadai-backup-${toDateInput(new Date())}.json`, JSON.stringify(data, null, 2), 'application/json');
  });

  $('#backup-import').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      // version 1 はタスクのみ（配列そのもの or { tasks }）
      const tasks = Array.isArray(data) ? data : data.tasks;
      if (!Array.isArray(tasks)) throw new Error('形式が違います');
      // version 2 でシフト・ノート、version 3 で授業・予定が加わった。ないものは今のデータを残す
      const shifts = Array.isArray(data.shifts) ? data.shifts : null;
      const notes = Array.isArray(data.notes) ? data.notes : null;
      const events = Array.isArray(data.events) ? data.events : null;
      const courses = Array.isArray(data.courses) ? data.courses : null;
      const parts = [`タスク${tasks.length}件`, shifts && `シフト${shifts.length}件`, notes && `ノート${notes.length}週分`,
        events && `予定${events.length}件`, courses && `授業${courses.length}件`].filter(Boolean).join('・');
      if (!confirm(`${parts}で現在のデータを置き換えます。よろしいですか？`)) return;
      await store.replaceAll(tasks.map((t) => makeTask(t)));
      if (shifts) await shiftStore.replaceAll(shifts.map((x) => makeShift(x)));
      if (notes) await noteStore.replaceAll(notes);
      if (events) await eventStore.replaceAll(events.map((x) => makeEvent(x)));
      if (courses) {
        await courseStore.setMeta('term', data.term ?? tt.term);
        await courseStore.setMeta('archives', data.archives || []);
        await courseStore.setMeta('seeded', true);
        await courseStore.replaceAll(courses.map(normalizeCourse));
      }
      toast('読み込みました');
    } catch (err) {
      alert('読み込めませんでした: ' + err.message);
    }
  });

  $('#clear-done').addEventListener('click', async () => {
    const done = store.all().filter((t) => t.done);
    if (!done.length) return toast('完了済みのタスクはありません');
    if (!confirm(`完了済みの ${done.length} 件を削除します。よろしいですか？`)) return;
    for (const t of done) {
      await store.remove(t.id);
      gcal?.onRemoved(t);
    }
    toast('削除しました');
  });

  $('#theme-seg').addEventListener('change', (e) => {
    localStorage.setItem('kadai-board.theme', e.target.value);
    applyTheme(e.target.value);
  });

  $('#about').textContent = `課題ボード v${APP_VERSION} ・ 保存先: ${CONFIG.storage === 'firebase' ? 'Firebase' : 'この端末'}`;
}

/** クイック入力の解析結果をチップで表示 */
function renderPreview(text) {
  const box = $('#quick-preview');
  if (!text.trim()) return box.replaceChildren();
  const p = parseQuickInput(text, tt);
  const course = tt.get(p.courseId);
  const pv = (label, value) => h('span', { class: 'pv' }, `${label} `, h('b', {}, value));
  box.replaceChildren(...[
    pv('タイトル', p.title || '（なし）'),
    p.due && pv('期限', fmtDateTime(p.due)),
    course && pv('授業', course.name),
    p.priority !== 'mid' && pv('優先度', PRIORITY_LABEL[p.priority]),
    p.estimateMin && pv('所要', fmtMinutes(p.estimateMin)),
  ].filter(Boolean));
}

function setView(view) {
  ui.view = view;
  localStorage.setItem('kadai-board.view', view);
  document.body.dataset.view = view;
  for (const b of document.querySelectorAll('#tabbar button')) {
    b.setAttribute('aria-current', b.dataset.view === view ? 'page' : 'false');
  }
  if (view === 'calendar' && tt) {
    if (monthView) ui.cal.jump = ui.cal.jump || !monthView.from;
    renderCalendar(new Date());
  }
}

function applyTheme(theme) {
  if (theme === 'auto') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = theme;
  const input = document.querySelector(`#theme-seg input[value="${theme}"]`);
  if (input) input.checked = true;
}

// ---------- トースト ----------
let toastTimer;
function toast(message, actionLabel, action) {
  const el = $('#toast');
  el.replaceChildren(
    h('span', {}, message),
    ...(actionLabel ? [h('button', { onclick: () => { el.hidden = true; action(); } }, actionLabel)] : []),
  );
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 4000);
}

// ====================================================================
// 段階2：同期まわりの UI（設定が空なら何も表示しない）
// ====================================================================
function setupSyncUi() {
  const fb = CONFIG.storage === 'firebase';
  if (!fb && !gcal) return;
  $('#sync-card').hidden = false;

  if (fb) {
    $('#sync-firebase').hidden = false;
    const refresh = () => {
      const u = authState.user;
      $('#fb-status').textContent = u ? `ログイン中: ${u.email}（スマホとPCで同期されます）` : '未ログイン：ログインするとタスクが同期されます';
      $('#fb-login').hidden = !!u;
      $('#fb-logout').hidden = !u;
    };
    authState.onAuthChange(refresh);
    $('#fb-login').addEventListener('click', () => authState.signIn().catch((e) => alert(e.message)));
    $('#fb-logout').addEventListener('click', () => authState.signOut());
    refresh();
  }

  if (gcal) {
    $('#sync-gcal').hidden = false;
    const refresh = () => {
      $('#gcal-status').textContent = gcal.connected ? `Googleカレンダー：接続済み（「${CONFIG.google.calendarName}」に自動で書き込みます）` : 'Googleカレンダー：未接続';
      $('#gcal-connect').hidden = gcal.connected;
      $('#gcal-resync').hidden = !gcal.connected;
    };
    gcal.onStatusChange = refresh;
    $('#gcal-connect').addEventListener('click', () => gcal.connect().catch((e) => alert(e.message)));
    $('#gcal-resync').addEventListener('click', async () => {
      const n = await gcal.syncAll();
      toast(`${n}件を同期しました`);
    });
    refresh();
  }
}

main().catch((e) => {
  console.error(e);
  document.body.prepend(h('p', { style: 'padding:16px;color:#b91c1c' }, `起動に失敗しました: ${e.message}`));
});
