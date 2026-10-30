// アプリ本体：画面の描画とイベント処理

import { CONFIG } from './config.js';
import { Timetable } from './timetable.js';
import { LocalTaskStore, makeTask } from './store.js';
import { parseQuickInput } from './parser.js';
import { googleCalendarUrl, buildIcs, downloadText } from './calendar.js';
import {
  DAY, startOfDay, startOfWeek, addDays, isSameDay, fmtDate, fmtDateTime, fmtTime,
  fmtMinutes, relative, toDateInput, toTimeInput, fromInputs, WEEKDAYS,
} from './dateutil.js';

const APP_VERSION = '1.0.0';
const PRIORITY_ORDER = { high: 0, mid: 1, low: 2 };
const PRIORITY_LABEL = { high: '高', mid: '中', low: '低' };

/** @type {Timetable} */
let tt;
/** @type {LocalTaskStore} */
let store;
let gcal = null; // 段階2: Googleカレンダー同期（有効時のみ）

const ui = {
  view: localStorage.getItem('kadai-board.view') || 'tasks',
  filter: 'open',
  courseFilter: null,
  editingId: null, // 編集中のタスクID（新規なら null）
  courseDialogId: null,
};

const $ = (sel) => document.querySelector(sel);

/** 小さな DOM ビルダー（innerHTML を使わずに XSS を避ける） */
function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style') el.style.cssText = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : String(c));
  }
  return el;
}

// ====================================================================
// 起動
// ====================================================================
async function main() {
  applyTheme(localStorage.getItem('kadai-board.theme') || 'auto');

  tt = await Timetable.load();

  if (CONFIG.storage === 'firebase') {
    // 段階2: Firestore に切り替え（firebase-store.js を読み込むのはこのときだけ）
    const { FirestoreTaskStore } = await import('./firebase-store.js');
    store = new FirestoreTaskStore(CONFIG.firebase);
  } else {
    store = new LocalTaskStore();
  }
  await store.init();
  store.subscribe(renderAll);

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
  if ($('#course-dialog').open) renderCourseDialog();
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
      ),
      task.memo && h('div', { class: 't-memo' }, task.memo),
    ),
    due && !task.done && h('button', { class: 't-cal', title: 'Googleカレンダーに追加', 'aria-label': 'Googleカレンダーに追加' }, '📅'),
  );
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

// ---------- 時間割 ----------

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
  },
    // マスが狭いので short（任意）があればそちらを表示
    h('span', { class: 'n' }, extra.full ? course.name : course.short || course.name),
    h('span', { class: 'r' }, course.room),
    n ? h('span', { class: `badge ${hot ? 'hot' : ''}` }, n) : null,
  );
}

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
      const course = tt.courseAt(day, p.period);
      const isToday = day === todayDow;
      if (!course) {
        cells.push(h('div', { class: `tt-empty ${isToday ? 'today' : ''}`, style: `grid-row:${row};grid-column:${day + 1}` }));
        continue;
      }
      // 実験A のような連続コマは 1 つのセルにまとめる
      if (p.period > 1 && tt.courseAt(day, p.period - 1) === course) continue;
      let span = 1;
      while (tt.courseAt(day, p.period + span) === course) span++;
      const isNow = isToday && curPeriod && curPeriod >= p.period && curPeriod < p.period + span;
      cells.push(courseCell(course, now, {
        class: [isToday && 'today', isNow && 'now'].filter(Boolean).join(' '),
        style: `grid-row:${row} / span ${span};grid-column:${day + 1}`,
      }));
    }
  }
  grid.replaceChildren(...cells);
  $('#ondemand').replaceChildren(...tt.onDemand.map((c) => courseCell(c, now, { full: true })));
}

// ---------- 授業ダイアログ ----------

function openCourseDialog(courseId) {
  ui.courseDialogId = courseId;
  renderCourseDialog();
  $('#course-dialog').showModal();
}

function renderCourseDialog() {
  const now = new Date();
  const course = tt.get(ui.courseDialogId);
  if (!course) return;
  $('#course-name').textContent = course.name;
  const next = tt.nextClassStart(course, now);
  $('#course-meta').textContent = [tt.slotLabel(course), course.room !== 'オンデマンド' && course.room, next && `次回 ${fmtDateTime(next)}`]
    .filter(Boolean).join(' ・ ');
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

// ====================================================================
// タスク編集ダイアログ
// ====================================================================
function fillCourseSelect(select) {
  const withSlots = tt.courses.filter((c) => c.slots.length);
  select.replaceChildren(
    h('option', { value: '' }, 'なし（個人タスク）'),
    h('optgroup', { label: '時間割' }, ...withSlots.map((c) => h('option', { value: c.id }, `${c.name}（${tt.slotLabel(c)}）`))),
    h('optgroup', { label: 'オンデマンド' }, ...tt.onDemand.map((c) => h('option', { value: c.id }, c.name))),
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
  fillCourseSelect(f.courseId);
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
    toast(`「${task.title}」を追加しました`, '編集', () => openTaskDialog(store.all().find((t) => t.id === task.id)));
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
    if (ui.editingId) {
      const cur = store.all().find((t) => t.id === ui.editingId);
      await saveTask({ ...cur, ...fields }, false);
    } else {
      await saveTask(makeTask(fields), true);
    }
    $('#task-dialog').close();
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
    if (!tasks.length) return toast('期限のあるタスクがありません');
    downloadText(`kadai-${toDateInput(new Date())}.ics`, buildIcs(tasks, tt), 'text/calendar;charset=utf-8');
    toast(`${tasks.length}件を書き出しました`);
  });

  $('#backup-export').addEventListener('click', () => {
    const data = { app: 'kadai-board', version: 1, exportedAt: new Date().toISOString(), tasks: store.all() };
    downloadText(`kadai-backup-${toDateInput(new Date())}.json`, JSON.stringify(data, null, 2), 'application/json');
  });

  $('#backup-import').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      const tasks = Array.isArray(data) ? data : data.tasks;
      if (!Array.isArray(tasks)) throw new Error('形式が違います');
      if (!confirm(`${tasks.length}件のタスクで現在のデータを置き換えます。よろしいですか？`)) return;
      await store.replaceAll(tasks);
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
    actionLabel && h('button', { onclick: () => { el.hidden = true; action(); } }, actionLabel),
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
      const u = store.user;
      $('#fb-status').textContent = u ? `ログイン中: ${u.email}（スマホとPCで同期されます）` : '未ログイン：ログインするとタスクが同期されます';
      $('#fb-login').hidden = !!u;
      $('#fb-logout').hidden = !u;
    };
    store.onAuthChange(refresh);
    $('#fb-login').addEventListener('click', () => store.signIn().catch((e) => alert(e.message)));
    $('#fb-logout').addEventListener('click', () => store.signOut());
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
