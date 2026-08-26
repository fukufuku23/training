# 筋トレ・ストレッチ管理（PWA版）

モバイル主体・PCでも管理できる構成に作り替えたもの。ビルド工程なしの静的サイト。
旧デスクトップ版（`../app.py` / `../db.py` / `../www/`）はそのまま残してある。

## フェーズ1（このディレクトリ）で完成している範囲

同期以外はすべて。データはこの端末の IndexedDB にのみ保存される。

## 動かし方

Service Worker と ES Modules の都合で **サーバー経由で開く必要がある**
（`index.html` をダブルクリックしても動かない）。

```
cd pwa
python -m http.server 8000
```

→ ブラウザで `http://localhost:8000/`

### スマホの実機で確認する場合

**Service Worker は HTTPS か localhost でしか動かない。**
`http://192.168.x.x:8000` でスマホから開くと画面は出るが、オフライン動作と
ホーム画面追加の検証ができない。実機確認は次のどちらかで行う。

- GitHub Pages にプッシュして開く（推奨）
- `cloudflared tunnel --url http://localhost:8000` で HTTPS の URL を割り当てる

## GitHub Pages への公開

### 前提

GitHub の Free プランでは **Pages の公開元リポジトリは public である必要がある**
（private から公開するには Pro 以上）。さらに **公開されたサイト自体は、リポジトリが
private でも public になる**（サイトに認証をかけられるのは Enterprise Cloud のみ）。

ただしこのアプリは記録を閲覧者自身のブラウザ内にしか保存しないため、
サイトが公開されてもあなたのトレーニング記録が他人に見えることはない。
公開されるのはコードだけ。

**`workout.db`（旧デスクトップ版の体重・実施記録）は絶対にリポジトリに入れないこと。**
このディレクトリを単独のリポジトリにすれば混入しない。親ディレクトリごと管理する場合は
`../.gitignore` で除外済み。

### 手順（Windows のターミナルで実行）

1. GitHub で空のリポジトリを作る（README や .gitignore は追加しない）

2. このディレクトリを push する

**PowerShell を通常権限で開くこと。** 管理者で開くと `C:\Windows\System32` から始まる。

```
cd F:\02_Software\_development\training\pwa
pwd
```

`pwd` が `F:\02_Software\_development\training\pwa` を返すことを必ず確認してから次へ進む。

> cmd.exe を使う場合は `cd /d F:\...` と **`/d` を付ける**。`cd` だけではドライブが変わらず、
> エラーも出ないまま `C:\Windows\System32` に留まる。そこで `git init` してしまった場合は
> 管理者権限で `rmdir /s /q C:\Windows\System32\.git` を実行して削除する。
> git が提案してくる `git config --global --add safe.directory C:/Windows/System32` は
> **絶対に実行しないこと**（System32 を git の管理対象として許可してしまう）。

```
git init -b main
git add -A
git commit -m "PWA版 フェーズ1"
git remote add origin https://github.com/<ユーザー名>/<リポジトリ名>.git
git push -u origin main
```

コミットで名前とメールを聞かれたら先に設定する。

```
git config --global user.name "あなたの名前"
git config --global user.email "you@example.com"
```

3. GitHub のリポジトリ → **Settings → Pages** →
   Source を「Deploy from a branch」、Branch を `main` / `/ (root)` にして Save

4. 1〜2分待つと `https://<ユーザー名>.github.io/<リポジトリ名>/` で開ける

### 更新するとき

```
git add -A
git commit -m "変更内容"
git push
```

反映まで1〜2分。Service Worker は stale-while-revalidate なので、
**更新直後の1回は古い画面が出て、次に開くと新しくなる**。すぐ確認したい場合は
リロードを2回するか、DevTools の Application → Service Workers → Update on reload。

### スマホでの確認

公開URLをスマホで開き、ホーム画面に追加する。

- iOS Safari: 共有ボタン →「ホーム画面に追加」
- Android Chrome: メニュー →「アプリをインストール」

ホーム画面から起動するとアドレスバーのない standalone 表示になり、
`navigator.storage.persist()` も許可されやすくなる（記録が消えにくくなる）。

### サブパス配信について

`https://<ユーザー名>.github.io/<リポジトリ名>/` のようにサブディレクトリで
配信されるが、HTML/manifest/Service Worker のパスはすべて相対で書いてあるため
そのまま動く（検証済み）。リポジトリ名を変えても追従する。

## ファイル構成

```
pwa/
├── index.html          画面の骨格（人体図SVGを含む）
├── manifest.json       PWA設定（アイコン・standalone表示）
├── sw.js               Service Worker（アプリシェルをキャッシュ）
├── css/style.css       スタイル。ライト/ダーク両対応
├── js/
│   ├── app.js          画面制御。storage.js と domain.js にのみ依存
│   ├── storage.js      ★ストレージ層 — フェーズ2で差し替わる唯一の場所
│   ├── domain.js       ドメインロジック（純粋関数・DOM非依存）
│   ├── chart.js        インラインSVGのグラフ（依存ライブラリなし）
│   └── exercises.js    種目マスタ196件（../data/exercises.json から生成）
└── icons/              アプリアイコン
```

## 設計上の約束ごと

### ストレージ層は非同期インターフェースを崩さない

`js/storage.js` の公開関数はすべて Promise を返す。フェーズ2で中身を
Supabase 同期付きに置き換えるが、シグネチャは変えない。だから `app.js` は
無変更で移行できる。**localStorage の同期APIに変えてはいけない。**

```javascript
await storage.getLog(date)
await storage.saveLog(date, patch)
await storage.getHistory(days)
await storage.getStreak()
```

### データモデル

```
meta/settings         絞り込み設定・デフォルト時間
logs/{YYYY-MM-DD}     体重・コンディション・痛い部位・実施種目の配列
```

日別に分けてあるのは、複数端末で同じレコードを取り合わないようにするため。

### 種目マスタを更新したら

`js/exercises.js` を直接編集しないこと。`../data/build_exercises.py` が生成している。

```
cd ../data
python build_exercises.py
```

これ1回で `data/exercises.json` / `data/media_reference.md` / `pwa/js/exercises.js`
の3つが更新される。あとは commit して push すれば公開版に反映される。

### 種目の画像を追加する

`media/images/<種目ID>.jpg` に置き、`media/index.json` に種目IDの配列を書く。

```json
["chest_01", "back_03"]
```

`media/index.json` が無ければ画像機能は自動的に無効になる（196件分の
無駄なリクエストを避けるため、マニフェスト方式にしてある）。
種目IDの一覧は `../data/media_reference.md` を参照。

## データの持ち出し

設定タブの「エクスポート」で JSON を保存できる。別端末へは「インポート」で
取り込む。取り込みは既定でマージ（実施種目は和集合、スカラー値は更新時刻の
新しい方を採用）で、フェーズ2の同期と同じ競合解決ルールにしてある。

## 既知の制約

- 記録はこの端末のこのブラウザにしか存在しない。**スマホとPCは同期しない**
  （フェーズ2で解決する）
- iOS Safari は操作のないサイトのストレージを削除することがある。
  起動時に `navigator.storage.persist()` を呼んでいるが保証はされない。
  ホーム画面に追加しておくと許可されやすい
- 表示フォントは Archivo Black / Space Mono / Inter を指定しているが同梱して
  いないため、未インストール環境ではシステムフォントで表示される。
  外部からの読み込みはオフライン動作を壊すのであえて行っていない

## フェーズ2でやること

Supabase 同期。`js/storage.js` の内部だけを差し替える。

1. Supabase プロジェクト作成、URL と anon key を取得
2. スキーマと **RLS ポリシー**（`alter table ... enable row level security;` 必須）
3. 認証（Magic Link または Google）
4. 同期層：ローカルを真とし、変更キューをオンライン時に push → pull
5. このフェーズで貯めたローカルデータを初回ログイン時に移行
