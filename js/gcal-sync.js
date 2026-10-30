// 段階2：Google Calendar API による自動同期
// config.js の google.clientId を設定すると app.js から読み込まれる。
//
// しくみ
//   - Google Identity Services（GIS）の「トークンモデル」でアクセストークンを取得（サーバー不要）
//   - 専用カレンダー「課題」を作り、その ID を設定（meta）に保存（Firebase 利用時は端末間で共有される）
//   - 同期するもの：タスクの期限 / バイトのシフト（毎週は繰り返しの予定）/ 自分の予定
//   - 「送信待ち」方式：変更されたデータには gcalDirty: true が付き、削除したものは meta の gcalDeletes に積まれる。
//     接続中ならすぐ送り、トークンが切れていれば「同期待ち N件」として残す（Firebase なら別の端末からでも送れる）
//
// 注意：ブラウザだけで動くアプリなので、アクセストークンは約1時間で切れる。
//       切れたあとは、画面上の「📅 同期待ち」を押すと（ユーザー操作なのでポップアップが開ける）再取得して送る。

import { eventTitle, eventRange, eventDescription } from './calendar.js';
import { eventSpan } from './events.js';
import { fromKey } from './shifts.js';
import { addDays, toDateInput } from './dateutil.js';

const API = 'https://www.googleapis.com/calendar/v3';
const GIS_SRC = 'https://accounts.google.com/gsi/client';
const TOKEN_KEY = 'kadai-board.gcal.token';
const TZ = 'Asia/Tokyo';

function loadScript(src) {
  return new Promise((resolve, reject) => {
    if (document.querySelector(`script[src="${src}"]`)) return resolve();
    const s = document.createElement('script');
    s.src = src;
    s.async = true;
    s.onload = resolve;
    s.onerror = () => reject(new Error('Google のスクリプトを読み込めませんでした'));
    document.head.append(s);
  });
}

/** "2026-11-02" と "18:00" → "2026-11-02T18:00:00"（タイムゾーンは別に TZ で渡す） */
const localDT = (key, hhmm) => `${key}T${hhmm}:00`;
/** 日またぎ（終了 <= 開始）なら翌日の日付 */
const endKey = (key, start, end) => (end <= start ? toDateInput(addDays(fromKey(key), 1)) : key);

export class GcalSync {
  /**
   * @param {{ task, shift, event }} stores 同期するコレクション（task の meta に設定を保存）
   * @param {import('./timetable.js').Timetable} tt
   * @param {{ clientId: string, calendarName: string, scope: string }} opts
   */
  constructor(stores, tt, opts) {
    this.stores = stores;
    this.meta = stores.task; // getMeta / setMeta 用
    this.tt = tt;
    this.opts = opts;
    this.calendarId = null;
    this.flushing = false;
    this.again = false;
    this.lastError = null;
    this.onStatusChange = () => {};
    // 一度接続したことがあるか（再取得のときに同意画面を省ける）
    this.wasConnected = localStorage.getItem('kadai-board.gcal.connected') === '1';
    // アクセストークンは1時間だけ有効。ページを開き直しても使えるよう、期限つきで覚えておく
    try {
      const t = JSON.parse(localStorage.getItem(TOKEN_KEY) || 'null');
      if (t && t.exp > Date.now()) Object.assign(this, { token: t.token, tokenExpires: t.exp });
    } catch { /* 壊れていたら無視 */ }
  }

  get connected() {
    return !!this.token && Date.now() < this.tokenExpires;
  }

  /** 送信待ちの件数 */
  get pendingCount() {
    const dirty = Object.values(this.stores).reduce((n, s) => n + s.all().filter((d) => d.gcalDirty).length, 0);
    return dirty + (this.meta.getMeta('gcalDeletes') || []).length;
  }

  // ------------------------------------------------------------------
  // トークン
  // ------------------------------------------------------------------

  /** トークンを取得（prompt: 'consent' は初回、'' は再取得）。ボタンを押したときなどユーザー操作の中で呼ぶ */
  async _requestToken(prompt) {
    await loadScript(GIS_SRC);
    return new Promise((resolve, reject) => {
      const client = google.accounts.oauth2.initTokenClient({
        client_id: this.opts.clientId,
        scope: this.opts.scope,
        callback: (res) => {
          if (res.error) return reject(new Error(res.error_description || res.error));
          this.token = res.access_token;
          this.tokenExpires = Date.now() + (res.expires_in - 60) * 1000;
          localStorage.setItem(TOKEN_KEY, JSON.stringify({ token: this.token, exp: this.tokenExpires }));
          localStorage.setItem('kadai-board.gcal.connected', '1');
          this.wasConnected = true;
          this.onStatusChange();
          resolve();
        },
        error_callback: (err) => reject(new Error(err.message || 'Google へのログインがキャンセルされました')),
      });
      client.requestAccessToken({ prompt });
    });
  }

  _dropToken() {
    this.token = null;
    this.tokenExpires = 0;
    localStorage.removeItem(TOKEN_KEY);
  }

  /** 設定画面の「接続」：同意 → 全部を送信待ちにして送る */
  async connect() {
    await this._requestToken('consent');
    await this.resyncAll();
  }

  /** 「同期待ち」ボタン：必要ならトークンを取り直してから送る */
  async syncNow() {
    if (!this.connected) await this._requestToken(this.wasConnected ? '' : 'consent');
    await this.flush();
  }

  /** すべてのデータを送信待ちにして送る（カレンダー側を作り直したいときなど） */
  async resyncAll() {
    for (const s of Object.values(this.stores)) {
      for (const d of s.all()) if (!d.gcalDirty) await s.update(d.id, { gcalDirty: true });
    }
    await this.flush();
  }

  // ------------------------------------------------------------------
  // app.js から呼ぶ
  // ------------------------------------------------------------------

  /** 削除したデータのカレンダー側の予定を、削除待ちに積む */
  async queueDelete(kind, doc) {
    const ids = idsOf(kind, doc);
    if (!ids.length) return;
    const list = [...(this.meta.getMeta('gcalDeletes') || []), ...ids];
    await this.meta.setMeta('gcalDeletes', list);
    this.flush();
  }

  /** 送信待ちをまとめて送る（接続していなければ件数を知らせるだけ） */
  async flush() {
    if (this.flushing) {
      this.again = true;
      return;
    }
    if (!this.connected) return this.onStatusChange();
    this.flushing = true;
    this.lastError = null;
    try {
      await this._ensureCalendar();
      // 削除待ち
      const deletes = this.meta.getMeta('gcalDeletes') || [];
      for (const id of deletes) await this._delete(id);
      if (deletes.length) {
        const rest = (this.meta.getMeta('gcalDeletes') || []).filter((id) => !deletes.includes(id));
        await this.meta.setMeta('gcalDeletes', rest);
      }
      // 変更されたデータ
      for (const [kind, store] of Object.entries(this.stores)) {
        for (const d of store.all().filter((x) => x.gcalDirty)) {
          const patch = await this._push(kind, d);
          // 送っている間にまた編集されていたら、送信待ちのまま残す
          const still = store.get(d.id);
          if (!still) continue;
          await store.update(d.id, { ...patch, gcalDirty: still.updatedAt !== d.updatedAt });
        }
      }
    } catch (e) {
      if (e.status === 401) this._dropToken(); // トークン切れ・取り消し
      this.lastError = e.message;
      console.warn('Googleカレンダー同期に失敗', e);
    } finally {
      this.flushing = false;
      this.onStatusChange();
      if (this.again) {
        this.again = false;
        this.flush();
      }
    }
  }

  // ------------------------------------------------------------------
  // Calendar API
  // ------------------------------------------------------------------

  async _api(method, path, body) {
    const res = await fetch(API + path, {
      method,
      headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 204) return null;
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      const err = new Error(data?.error?.message || `Calendar API エラー (${res.status})`);
      err.status = res.status;
      throw err;
    }
    return data;
  }

  /** 専用カレンダー「課題」を用意する（保存済み ID → 名前で検索 → 新規作成 の順） */
  async _ensureCalendar() {
    if (this.calendarId) return this.calendarId;
    const saved = this.meta.getMeta('gcalCalendarId');
    if (saved) {
      try {
        await this._api('GET', `/calendars/${encodeURIComponent(saved)}`);
        return (this.calendarId = saved);
      } catch (e) {
        if (e.status !== 404) throw e; // 消されていたら作り直す
      }
    }
    // calendar.app.created スコープでは一覧が取れない場合があるので失敗しても続行
    try {
      const list = await this._api('GET', '/users/me/calendarList?minAccessRole=owner');
      const found = list.items.find((c) => c.summary === this.opts.calendarName);
      if (found) {
        await this.meta.setMeta('gcalCalendarId', found.id);
        return (this.calendarId = found.id);
      }
    } catch { /* 権限不足は無視 */ }

    const cal = await this._api('POST', '/calendars', { summary: this.opts.calendarName, timeZone: TZ });
    await this.meta.setMeta('gcalCalendarId', cal.id);
    return (this.calendarId = cal.id);
  }

  _path(eventId = '') {
    return `/calendars/${encodeURIComponent(this.calendarId)}/events${eventId ? `/${encodeURIComponent(eventId)}` : ''}`;
  }

  /** あれば更新・なければ作成（カレンダー側で消されていたら作り直す）。予定のIDを返す */
  async _upsert(eventId, body) {
    if (eventId) {
      try {
        await this._api('PATCH', this._path(eventId), body);
        return eventId;
      } catch (e) {
        if (e.status !== 404 && e.status !== 410) throw e;
      }
    }
    return (await this._api('POST', this._path(), body)).id;
  }

  async _delete(eventId) {
    try {
      await this._api('DELETE', this._path(eventId));
    } catch (e) {
      if (e.status !== 404 && e.status !== 410) throw e;
    }
  }

  /** 1件を送る。データに書き戻す項目（予定のID）を返す */
  async _push(kind, d) {
    if (kind === 'task') {
      if (!d.due) {
        if (d.gcalEventId) await this._delete(d.gcalEventId);
        return { gcalEventId: null };
      }
      return { gcalEventId: await this._upsert(d.gcalEventId, this._taskBody(d)) };
    }
    if (kind === 'event') {
      return { gcalEventId: await this._upsert(d.gcalEventId, eventBody(d)) };
    }
    return { gcal: await this._pushShift(d) };
  }

  _taskBody(task) {
    const course = this.tt.get(task.courseId);
    const { start, end } = eventRange(task);
    return {
      summary: (task.done ? '✓ ' : '') + eventTitle(task, course),
      description: eventDescription(task, course),
      location: course && course.slots.length ? course.room : null,
      start: { dateTime: start.toISOString(), timeZone: TZ },
      end: { dateTime: end.toISOString(), timeZone: TZ },
      colorId: task.done ? '8' : null, // 完了したらグレー
      reminders: task.done ? { useDefault: false, overrides: [] } : { useDefault: false, overrides: [{ method: 'popup', minutes: 24 * 60 }] },
      extendedProperties: { private: { kadaiKind: 'task', kadaiId: task.id } },
    };
  }

  /**
   * シフト
   *   単発 → 予定1つ
   *   毎週 → 繰り返しの予定（休み・時間変更の日は EXDATE で外す）＋ 時間変更の日だけ別の予定
   * @returns {{ id, singles: { 'YYYY-MM-DD': eventId } }}
   */
  async _pushShift(shift) {
    const prev = shift.gcal || {};
    const base = {
      summary: `💼 ${shift.place || 'バイト'}`,
      colorId: '10', // 緑
      extendedProperties: { private: { kadaiKind: 'shift', kadaiId: shift.id } },
    };
    const desc = (memo) => [shift.wage ? `時給: ${shift.wage}円` : '', memo || ''].filter(Boolean).join('\n');
    const timed = (key, start, end) => ({
      start: { dateTime: localDT(key, start), timeZone: TZ },
      end: { dateTime: localDT(endKey(key, start, end), end), timeZone: TZ },
    });

    if (shift.kind === 'once') {
      for (const id of Object.values(prev.singles || {})) await this._delete(id);
      const id = await this._upsert(prev.id, { ...base, description: desc(shift.memo), ...timed(shift.date, shift.start, shift.end), recurrence: null });
      return { id, singles: {} };
    }

    // 毎週：開始日以降で最初のその曜日から
    const from = fromKey(shift.from);
    const firstKey = toDateInput(addDays(from, (shift.weekday - from.getDay() + 7) % 7));
    let rule = 'RRULE:FREQ=WEEKLY';
    if (shift.until) rule += `;UNTIL=${shift.until.replace(/-/g, '')}T145959Z`; // 終了日の 23:59:59（日本時間）
    const recurrence = [rule];
    const exKeys = Object.keys(shift.exceptions || {}).sort();
    if (exKeys.length) {
      // 外す日は「本来の開始時刻」で指定する
      recurrence.push(`EXDATE;TZID=${TZ}:${exKeys.map((k) => `${k.replace(/-/g, '')}T${shift.start.replace(':', '')}00`).join(',')}`);
    }
    const id = await this._upsert(prev.id, { ...base, description: desc(shift.memo), ...timed(firstKey, shift.start, shift.end), recurrence });

    // 時間変更の日：別の予定として作る（なくなった分は消す）
    const singles = {};
    for (const [key, ex] of Object.entries(shift.exceptions || {})) {
      if (ex.cancel) continue;
      const s = ex.start || shift.start, e = ex.end || shift.end;
      singles[key] = await this._upsert(prev.singles?.[key], { ...base, description: desc(ex.memo || shift.memo), ...timed(key, s, e), recurrence: null });
    }
    for (const [key, eid] of Object.entries(prev.singles || {})) {
      if (!singles[key]) await this._delete(eid);
    }
    return { id, singles };
  }
}

/** 自分の予定 → Calendar API の予定 */
function eventBody(ev) {
  const { start, end } = eventSpan(ev);
  const when = ev.allDay
    ? { start: { date: toDateInput(start) }, end: { date: toDateInput(end) } } // 終日は終了日を含まない
    : { start: { dateTime: start.toISOString(), timeZone: TZ }, end: { dateTime: end.toISOString(), timeZone: TZ } };
  return {
    summary: ev.title || '予定',
    description: ev.memo || '',
    ...when,
    extendedProperties: { private: { kadaiKind: 'event', kadaiId: ev.id } },
  };
}

/** そのデータに対応するカレンダー側の予定ID（削除用） */
function idsOf(kind, d) {
  if (kind === 'shift') return [d.gcal?.id, ...Object.values(d.gcal?.singles || {})].filter(Boolean);
  return d.gcalEventId ? [d.gcalEventId] : [];
}
