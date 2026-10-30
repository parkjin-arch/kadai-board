// 保存層（タスク・シフト・ノートで共通の「コレクション」）
// UI はこのインターフェースだけを使う。段階2では firebase-store.js の FirestoreCollection に差し替える。
//
//   init()              : 読み込み（Promise）
//   all()               : 現在の配列（同期・キャッシュから）
//   get(id)             : 1件取得（なければ null）
//   add(doc)            : 追加して保存したものを返す
//   update(id, patch)   : 部分更新して更新後のものを返す
//   put(doc)            : なければ追加・あれば上書き（ノートの自動保存用）
//   remove(id)          : 削除
//   replaceAll(docs)    : バックアップからの復元用
//   subscribe(fn)       : 変更時に fn(docs) を呼ぶ。解除関数を返す
//   getMeta(key) / setMeta(key, value) : 設定値（カレンダーIDなど）

/**
 * タスクの形
 * @typedef {Object} Task
 * @property {string} id
 * @property {string} title
 * @property {string|null} due        ISO 文字列（期限なしは null）
 * @property {string|null} courseId   timetable.json の course.id
 * @property {'high'|'mid'|'low'} priority
 * @property {string} memo
 * @property {number|null} estimateMin 所要時間（分）
 * @property {boolean} done
 * @property {string|null} gcalEventId 段階2: 同期した Google カレンダーのイベントID
 * @property {string} createdAt
 * @property {string} updatedAt
 */

export function newId() {
  return (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2)).replace(/-/g, '');
}

/** 入力値から正規化したタスクを作る */
export function makeTask(fields) {
  const now = new Date().toISOString();
  return {
    id: newId(),
    title: '',
    due: null,
    courseId: null,
    priority: 'mid',
    memo: '',
    estimateMin: null,
    done: false,
    gcalEventId: null,
    createdAt: now,
    updatedAt: now,
    ...fields,
  };
}

export class LocalCollection {
  constructor(key) {
    this.key = key;
    this.metaKey = key + '.meta';
    this.docs = [];
    this.listeners = new Set();
  }

  async init() {
    this._load();
    // 別タブで変更されたら追従する
    window.addEventListener('storage', (e) => {
      if (e.key !== this.key) return;
      this._load();
      this._emit();
    });
  }

  _load() {
    try {
      this.docs = JSON.parse(localStorage.getItem(this.key) || '[]');
    } catch {
      this.docs = [];
    }
  }

  all() {
    return this.docs;
  }

  get(id) {
    return this.docs.find((t) => t.id === id) || null;
  }

  async add(doc) {
    this.docs.push(doc);
    this._save();
    return doc;
  }

  async update(id, patch) {
    const i = this.docs.findIndex((t) => t.id === id);
    if (i < 0) return null;
    this.docs[i] = { ...this.docs[i], ...patch, updatedAt: new Date().toISOString() };
    this._save();
    return this.docs[i];
  }

  async put(doc) {
    const i = this.docs.findIndex((t) => t.id === doc.id);
    const saved = { ...doc, updatedAt: new Date().toISOString() };
    if (i < 0) this.docs.push(saved);
    else this.docs[i] = saved;
    this._save();
    return saved;
  }

  async remove(id) {
    this.docs = this.docs.filter((t) => t.id !== id);
    this._save();
  }

  async replaceAll(docs) {
    this.docs = docs;
    this._save();
  }

  subscribe(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  getMeta(key) {
    try {
      return JSON.parse(localStorage.getItem(this.metaKey) || '{}')[key] ?? null;
    } catch {
      return null;
    }
  }

  async setMeta(key, value) {
    const meta = JSON.parse(localStorage.getItem(this.metaKey) || '{}');
    meta[key] = value;
    localStorage.setItem(this.metaKey, JSON.stringify(meta));
  }

  _save() {
    localStorage.setItem(this.key, JSON.stringify(this.docs));
    this._emit();
  }

  _emit() {
    for (const fn of this.listeners) fn(this.docs);
  }
}
