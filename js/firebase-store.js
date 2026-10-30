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
  collection, doc, onSnapshot, setDoc, updateDoc, deleteDoc, getDocs, writeBatch,
} from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js';

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
        if (user) {
          this._unsubMeta = onSnapshot(this.metaDoc(), (snap) => (this.meta = snap.data() || {}));
        }
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

  /** ログイン・ログアウトのたびに購読し直す */
  async _attach(user) {
    this._unsub?.();
    this._unsub = null;
    this.docs = [];
    if (user) {
      await this._migrateFromLocal();
      // 他の端末での変更をリアルタイムに受け取る
      this._unsub = onSnapshot(this._col(), (snap) => {
        this.docs = snap.docs.map((d) => d.data());
        this._emit();
      });
    }
    this._emit();
  }

  /** 初回ログイン時、Firestore が空なら localStorage のデータをアップロード */
  async _migrateFromLocal() {
    const flag = `kadai-board.migrated.${this.name}`;
    const local = JSON.parse(localStorage.getItem(this.localKey) || '[]');
    if (!local.length || localStorage.getItem(flag) === this.a.user.uid) return;
    const existing = await getDocs(this._col());
    if (existing.empty && confirm(`この端末の${{ tasks: 'タスク', shifts: 'シフト', notes: 'ノート', courses: '授業', events: '予定' }[this.name] || 'データ'} ${local.length} 件をアカウントに移しますか？`)) {
      const batch = writeBatch(this.a.db);
      for (const d of local) batch.set(doc(this._col(), d.id), d);
      await batch.commit();
    }
    localStorage.setItem(flag, this.a.user.uid);
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
