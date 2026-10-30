# 課題ボード

授業・課題・個人タスクをまとめて管理する、スマホ優先の Web アプリ（PWA）。
ビルド不要の HTML + CSS + JavaScript（ES Modules）なので、フォルダをそのまま GitHub Pages に置けば動く。

## ファイル構成

```
index.html              画面の骨組み（タスク / 時間割 / 設定 / 編集ダイアログ）
manifest.webmanifest    PWA 設定（ホーム画面に追加したときの名前・アイコン）
sw.js                   Service Worker（オフラインで開けるようにキャッシュ）
css/style.css           スタイル（スマホ優先・ダークモード対応）
data/timetable.json     時間割データ ← 学期ごとに差し替える
icons/                  アプリアイコン
js/
  app.js                画面の描画とイベント処理
  config.js             設定（段階2の同期を有効にするときだけ編集）
  store.js              保存層（localStorage）。UI はこのインターフェースだけを使う
  parser.js             1行入力の解析
  calendar.js           Googleカレンダー追加 URL と .ics 生成
  timetable.js          時間割の読み込みと検索（次回の授業の計算など）
  dateutil.js           日付ユーティリティ
  gcal-sync.js          段階2：Calendar API 自動同期（設定したときだけ読み込まれる）
  firebase-store.js     段階2：Firestore 保存層（設定したときだけ読み込まれる）
```

**設計方針**

- 保存層は `store.js` のインターフェース（`add / update / remove / all / subscribe / getMeta / setMeta`）で抽象化している。`firebase-store.js` は同じ形で実装してあるので、`config.js` の `storage` を切り替えるだけで移行できる。
- タスクは `{ id, title, due(ISO), courseId, priority, memo, estimateMin, done, gcalEventId, createdAt, updatedAt }`。授業は `timetable.json` の `id` で参照している。
- 段階2のコードは動的 `import()` で読み込むので、使わないあいだは読み込まれず、余計な処理も走らない。

## 使い方メモ

### 1行入力

| 書き方 | 意味 |
|---|---|
| `回路理論B` `回路` `DSA` `シス解` | 授業（`timetable.json` の name / aliases） |
| `11/6` `11月6日` `2026/11/6` | 日付（時刻を書かなければ 23:59） |
| `今日` `明日` `明後日` `3日後` | 相対日付 |
| `金曜` `来週月曜` | 曜日 |
| `次回` | その授業の次のコマの開始時刻 |
| `23:59` `9時半` `2限` | 時刻 |
| `!高` `!低` `!!` `至急` | 優先度 |
| `2h` `1.5時間` `90分` | 所要時間 |

例：`アルゴリズム 小テスト 次回` → 「小テスト」／データ構造とアルゴリズム／次の月曜 17:00

入力中は、解析結果が入力欄の下にプレビューされる。`…` ボタンを押すと、解析結果を入れた状態で詳細入力ダイアログが開く。

### Googleカレンダー

- 各タスクの 📅 → Googleカレンダーの予定作成画面が開く（期限を終了時刻とし、所要時間ぶんさかのぼった時刻を開始にする。所要時間が未設定なら 30 分）
- 設定 → `.ics をエクスポート` → Googleカレンダーの「設定 → インポートとエクスポート」で読み込む。UID が固定なので、同じタスクを再インポートしても重複しない

### 時間割の差し替え

`data/timetable.json` を書き換えるだけでよい。`slots` の `day` は 1=月〜5=金。`short` はマス目に表示する短い名前（なくてもよい）。
**授業の `id` を変えると、既存タスクとのひも付けが外れる**ので、同じ授業が続く場合は `id` をそのままにしておく。

## ローカルで動かす

ES Modules と `fetch` を使っているので、`index.html` をダブルクリックで開いても動かない。ローカルサーバーを立てて開く。

```sh
cd task
python -m http.server 8000
# → http://localhost:8000
```

## デプロイ（GitHub Pages）

1. GitHub で新しいリポジトリ（例：`kadai-board`）を作る
2. このフォルダをプッシュする
   ```sh
   git init
   git add .
   git commit -m "first commit"
   git branch -M main
   git remote add origin https://github.com/<ユーザー名>/kadai-board.git
   git push -u origin main
   ```
3. リポジトリの **Settings → Pages → Build and deployment** で Source を「Deploy from a branch」、Branch を `main` / `/ (root)` にして Save
4. 1〜2分後に `https://<ユーザー名>.github.io/kadai-board/` で公開される（パスはすべて相対パスなので、サブパスでもそのまま動く）

**Vercel を使う場合**：vercel.com で GitHub リポジトリを Import → Framework Preset は「Other」、Build Command は空のまま Deploy。

### iPhone のホーム画面に追加

Safari で公開 URL を開く → 共有ボタン → 「ホーム画面に追加」。

> ⚠ localStorage は「Safari」と「ホーム画面のアプリ」で**別々に保存される**。使うのはホーム画面のアプリに統一するのがおすすめ。また PC と iPhone のデータは段階1では共有されない（段階2の Firebase で共有できるようになる）。

### 更新したとき

`sw.js` の `CACHE = 'kadai-board-v1'` の番号を上げてからデプロイする。キャッシュはバックグラウンドで更新されるので、反映は**次回アプリを開いたとき**になる。

---

## 段階2：Google Calendar API 自動同期

タスクを追加・編集・削除すると、専用カレンダー「課題」のイベントが自動で作成・更新・削除される。完了したタスクは「✓」付きのグレーのイベントになる。実装は `js/gcal-sync.js` にある。

### Google Cloud Console の設定

1. https://console.cloud.google.com/ で新しいプロジェクトを作成（例：`kadai-board`）
2. **API とサービス → ライブラリ** で「Google Calendar API」を検索 → 有効にする
3. **API とサービス → OAuth 同意画面**（「Google Auth Platform」と表示される場合もある）
   - User Type：**外部**
   - アプリ名・サポートメールを入力
   - スコープ：`https://www.googleapis.com/auth/calendar.app.created` を追加
     （このアプリが作ったカレンダーだけを操作できる、いちばん権限の狭いスコープ）
   - **テストユーザー**に自分の Gmail アドレスを追加（公開ステータスが「テスト」のままなら、審査なしで自分だけ使える）
4. **API とサービス → 認証情報 → 認証情報を作成 → OAuth クライアント ID**
   - アプリケーションの種類：**ウェブ アプリケーション**
   - 承認済みの JavaScript 生成元：
     - `https://<ユーザー名>.github.io`
     - `http://localhost:8000`（ローカルで試す用）
   - リダイレクト URI は不要（トークンモデルを使うため）
5. 発行されたクライアント ID を `js/config.js` に入れる
   ```js
   google: {
     clientId: '1234567890-xxxx.apps.googleusercontent.com',
     ...
   }
   ```
6. デプロイ → 設定画面の「Googleカレンダーに接続」→ 許可。既存タスクがまとめて同期される

**補足**

- クライアント ID は公開されても問題ない値（生成元を自分のドメインに制限しているため）。クライアント**シークレット**は使わないので、作らなくてよい。
- 公開ステータスが「テスト」のあいだは、許可が 7 日ごとに失効することがある。そのときは「接続」を押し直す。
- アクセストークンの有効期限は約1時間。切れたあとに操作すると、自動で再取得を試みる（ポップアップが一瞬表示される）。
- `calendar.app.created` スコープでは、既存の「課題」カレンダーを名前から探せない場合がある。作成したカレンダーの ID は保存しておき、次回からはその ID を使う。

## 段階2：Firebase（Firestore + Googleログイン）で端末間同期

実装は `js/firebase-store.js` にある。`LocalTaskStore` と同じインターフェースなので、UI 側の変更は不要。

### 設定手順

1. https://console.firebase.google.com/ → **プロジェクトを追加**（上で作った Google Cloud プロジェクトを選ぶと、まとめて管理できる）
2. **Authentication → 始める → Sign-in method → Google** を有効化
3. **Authentication → 設定 → 承認済みドメイン** に `<ユーザー名>.github.io` を追加
4. **Firestore Database → データベースを作成**（ロケーションは `asia-northeast1`（東京）、本番環境モード）
5. **ルール** タブに次を貼り付けて公開する（自分のデータは自分しか読み書きできない）
   ```
   rules_version = '2';
   service cloud.firestore {
     match /databases/{database}/documents {
       match /users/{uid}/{document=**} {
         allow read, write: if request.auth != null && request.auth.uid == uid;
       }
     }
   }
   ```
6. **プロジェクトの設定 → マイアプリ → ウェブアプリを追加（</>）** → 表示された `firebaseConfig` を `js/config.js` にコピーし、`storage` を `'firebase'` にする
   ```js
   storage: 'firebase',
   firebase: { apiKey: '...', authDomain: 'xxx.firebaseapp.com', projectId: 'xxx', appId: '...' },
   ```
7. デプロイ → 設定 → 「Googleでログイン」。初回ログイン時に、この端末の localStorage のタスクをアカウントへ移すか聞かれる

**しくみと注意**

- データは `users/{uid}/tasks/{taskId}` に保存される。`onSnapshot` で購読しているので、PC で追加したタスクがすぐにスマホにも表示される。
- オフラインキャッシュ（`persistentLocalCache`）を有効にしているので、電波のないところでも追加・編集でき、オンラインに戻ると同期される。
- カレンダーの ID は `users/{uid}/meta/settings` に保存されるので、PC とスマホで同じ「課題」カレンダーに書き込まれる。
- **iPhone のホーム画面アプリでのログイン**：ポップアップが使えない場合はリダイレクト方式に切り替える。ただし Safari はサードパーティの保存領域を制限しているため、GitHub Pages（`github.io`）と `firebaseapp.com` のようにドメインが分かれていると、リダイレクトでのログインがうまくいかないことがある。そのときは **Firebase Hosting でホストする**（`firebase init hosting` → `firebase deploy`）のが確実で、`authDomain` と同じドメインになるので問題が起きない。
- Firebase の apiKey も公開して問題ない値（アクセスはセキュリティルールで制御する）。

### 両方を有効にした場合

PC とスマホのどちらで編集しても、編集した端末から Calendar API が呼ばれる。イベント ID はタスクと一緒に Firestore に保存されるので、イベントが重複して作られることはない。
