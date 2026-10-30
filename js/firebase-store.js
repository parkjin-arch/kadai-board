// 段階2：Firestore + Googleログインによる保存層（スマホとPCで同期）
// config.js で storage: 'firebase' にすると、store.js の LocalCollection の代わりに使われる。
// FirestoreCollection のインターフェースは LocalCollection と同じ。
//
// データ構造
//   users/{uid}/tasks/{id}      … タスク
//   users/{uid}/shifts/{id}     … バイトのシフト
//   users/{uid}/notes/{週の月曜} … 今週のノート
//   users/{uid}/courses/{id}    … 授業（時間割）
//   users/{uid}/events/{id}     … 自分で追加した予定
//   users/{uid}/meta/settings   … カレンダーID・学期名・アーカイブなどの設定

import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js';
import {
  getAuth, GoogleAuthProvider, onAuthStateChanged, signInWithPopup, signInWithRedirect, signOut,
} from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js';
import {
  initializeFirestore, persistentLocalCache, persistentMultipleTabManager,
  collection, doc, onSnapshot, setDoc, updateDoc, deleteDoc, getDoc, getDocs, writeBatch,
} from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js';

const LABEL = { tasks: 'タスク', shifts: 'シフト', notes: 'ノート', courses: '授業', events: '予定' };

/** 最初のスナップショットが届くまで待つ onSnapshot（届く前に空の状態で描くと、初期データを二重に作ってしまうため） */
function listen(ref, onData) {
  return new Promise((resolve) => {
    let first = true;
    const unsub = onSnapshot(ref, (snap) => {
      onData(snap);
      if (first) { first = false; resolve(unsub); }
    }, (err) => {
      console.error('Firestore 読み込み失敗', err);
      if (first) { first = false; resolve(unsub); }
    });
  });
}

/**
 * ログインと Firestore 接続を1つにまとめたもの
 * @param {object} firebaseConfig
 * @param {Object<string, string>} collections { tasks: 'kadai-board.tasks.v1', ... }（名前 → 移行元の localStorage キー）
 * @returns {{ auth: FirebaseAuthState, cols: Object<string, FirestoreCollection> }}
 */
export function createFirebaseStores(firebaseConfig, collections) {
  const auth = new FirebaseAuthState(firebaseConfig);
  const cols = {};
  for (const [name, localKey] of Object.entries(collections)) {
    cols[name] = new FirestoreCollection(auth, name, localKey);
  }
  auth.collections = Object.values(cols);
  return { auth, cols };
}

class FirebaseAuthState {
  constructor(firebaseConfig) {
    this.app = initializeApp(firebaseConfig);
    this.auth = getAuth(this.app);
    // オフラインでも読み書きでき、オンライン復帰時に自動で同期される
    this.db = initializeFirestore(this.app, {
      localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }),
    });
    this.user = null;
    this.meta = {};
    this.collections = [];
    this.listeners = new Set();
    this._ready = null;
    this._unsubMeta = null;
  }

  /** ログイン状態が確定するまで待つ（何度呼んでも1回だけ実行） */
  init() {
    this._ready ||= new Promise((resolve) => {
      let first = true;
      onAuthStateChanged(this.auth, async (user) => {
        this.user = user;
        this.meta = {};
        this._unsubMeta?.();
        this._unsubMeta = null;
        if (user) await this._migrateFromLocal();
        if (user) this._unsubMeta = await listen(this.metaDoc(), (snap) => (this.meta = snap.data() || {}));
        for (const c of this.collections) await c._attach(user);
        this.listeners.forEach((fn) => fn(user));
        if (first) { first = false; resolve(); }
      });
    });
    return this._ready;
  }

  metaDoc() {
    return doc(this.db, 'users', this.user.uid, 'meta', 'settings');
  }

  /**
   * はじめてログインしたとき：この端末（localStorage）のデータをアカウントに移すか、まとめて1回だけ聞く
   * アカウント側にすでにデータがある種類は上書きしない
   */
  async _migrateFromLocal() {
    const flag = 'kadai-board.migrated';
    if (localStorage.getItem(flag) === this.user.uid) return false;
    const local = this.collections
      .map((c) => ({ c, docs: JSON.parse(localStorage.getItem(c.localKey) || '[]') }))
      .filter((x) => x.docs.length);
    localStorage.setItem(flag, this.user.uid);
    if (!local.length) return false;
    const summary = local.map((x) => `${LABEL[x.c.name] || x.c.name}${x.docs.length}件`).join('・');
    if (!confirm(`この端末のデータ（${summary}）をアカウントに移しますか？
スマホとPCで同じデータが使えるようになります。`)) return false;

    for (const { c, docs } of local) {
      const existing = await getDocs(c._col());
      if (!existing.empty) continue;
      for (let i = 0; i < docs.length; i += 450) {
        const batch = writeBatch(this.db);
        for (const d of docs.slice(i, i + 450)) batch.set(doc(c._col(), d.id), d);
        await batch.commit();
      }
    }
    // 学期名・アーカイブ・カレンダーIDなどの設定も移す（アカウント側にないものだけ）
    const remote = (await getDoc(this.metaDoc())).data() || {};
    const localMeta = {};
    for (const c of this.collections) Object.assign(localMeta, JSON.parse(localStorage.getItem(c.localKey + '.meta') || '{}'));
    const add = Object.fromEntries(Object.entries(localMeta).filter(([k]) => !(k in remote)));
    if (Object.keys(add).length) await setDoc(this.metaDoc(), add, { merge: true });
    return true;
  }

  async signIn() {
    const provider = new GoogleAuthProvider();
    try {
      await signInWithPopup(this.auth, provider);
    } catch (e) {
      // iPhone のホーム画面アプリなどでポップアップが使えない場合はリダイレクト
      if (e.code === 'auth/popup-blocked' || e.code === 'auth/operation-not-supported-in-this-environment') {
        await signInWithRedirect(this.auth, provider);
      } else throw e;
    }
  }

  signOut() {
    return signOut(this.auth);
  }

  onAuthChange(fn) {
    this.listeners.add(fn);
  }
}

export class FirestoreCollection {
  constructor(authState, name, localKey) {
    this.a = authState;
    this.name = name;
    this.localKey = localKey;
    this.docs = [];
    this.listeners = new Set();
    this._unsub = null;
  }

  init() {
    return this.a.init();
  }

  _col() {
    return collection(this.a.db, 'users', this.a.user.uid, this.name);
  }

  /** ログイン・ログアウトのたびに購読し直す（最初のデータが届くまで待つ） */
  async _attach(user) {
    this._unsub?.();
    this._unsub = null;
    this.docs = [];
    if (user) {
      // 他の端末での変更をリアルタイムに受け取る
      this._unsub = await listen(this._col(), (snap) => {
        this.docs = snap.docs.map((d) => d.data());
        this._emit();
      });
    }
    this._emit();
  }

  _requireUser() {
    if (!this.a.user) throw new Error('ログインしてください（設定 → 同期）');
  }

  // Firestore の書き込み Promise はサーバーに届くまで解決しない（オフラインだと待ち続ける）。
  // ローカルキャッシュには即座に反映され onSnapshot も発火するので、ここでは待たずにエラーだけ拾う。
  _write(promise) {
    promise.catch((e) => {
      console.error('Firestore 書き込み失敗', e);
      alert('保存に失敗しました: ' + e.message);
    });
  }

  // ---- LocalCollection と同じインターフェース ----
  all() {
    return this.docs;
  }

  get(id) {
    return this.docs.find((d) => d.id === id) || null;
  }

  async add(d) {
    this._requireUser();
    this._write(setDoc(doc(this._col(), d.id), d));
    return d;
  }

  async update(id, patch) {
    this._requireUser();
    const updated = { ...this.get(id), ...patch, updatedAt: new Date().toISOString() };
    this._write(updateDoc(doc(this._col(), id), { ...patch, updatedAt: updated.updatedAt }));
    return updated;
  }

  async put(d) {
    this._requireUser();
    const saved = { ...d, updatedAt: new Date().toISOString() };
    this._write(setDoc(doc(this._col(), d.id), saved));
    return saved;
  }

  async remove(id) {
    this._requireUser();
    this._write(deleteDoc(doc(this._col(), id)));
  }

  async replaceAll(docs) {
    this._requireUser();
    // 一括書き込みは 500 件までなので分割
    const old = await getDocs(this._col());
    const ops = [
      ...old.docs.map((d) => (b) => b.delete(d.ref)),
      ...docs.map((d) => (b) => b.set(doc(this._col(), d.id), d)),
    ];
    for (let i = 0; i < ops.length; i += 450) {
      const batch = writeBatch(this.a.db);
      ops.slice(i, i + 450).forEach((op) => op(batch));
      await batch.commit();
    }
  }

  subscribe(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  // 設定値はコレクションをまたいで共有（users/{uid}/meta/settings）
  getMeta(key) {
    return this.a.meta[key] ?? null;
  }

  async setMeta(key, value) {
    this.a.meta[key] = value;
    if (this.a.user) await setDoc(this.a.metaDoc(), { [key]: value }, { merge: true });
  }

  _emit() {
    for (const fn of this.listeners) fn(this.docs);
  }
}
