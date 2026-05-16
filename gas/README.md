# GAS 自動化プログラム

Google Sites に Apps Script Web アプリを一度だけ埋め込み、以後は GAS とスプレッドシートで更新を回す構成です。

## 何を自動化するか

- 公式フィードから新着候補を取得
- URLで重複を除外
- サービス、分類、優先度、対象者の初期案を作成
- 候補をスプレッドシートに保存
- `sources` シートでブログ、note、ニュース、YouTubeなどの取得元を増減
- 投稿者画面で下書きを編集
- `Published` になった記事だけ社員向け画面に表示

精度を守るため、GASが取得しただけの記事は `Candidate` のままです。投稿者が元記事を確認し、`[要編集]` を消してからでないと公開できません。

## ファイル

- `Code.gs`: 取得、台帳、公開処理
- `Index.html`: 社員向けの埋め込み画面
- `Publisher.html`: 投稿者向けの確認、編集、公開画面
- `appsscript.json`: Apps Script の権限設定

## 初期設定

1. Apps Scriptで新規プロジェクトを作成
2. この `gas/` フォルダの4ファイルを追加
3. Apps Script エディタで `setup()` を実行
4. Script Properties に投稿担当者のメールを追加

```text
DISPATCH_ADMIN_EMAILS=your.name@company.co.jp
```

複数人いる場合:

```text
DISPATCH_ADMIN_EMAILS=editor1@company.co.jp,editor2@company.co.jp
```

5. `installDailyTrigger()` を実行

これで毎日9時ごろに `dailyScan()` が走り、候補が台帳に追加されます。

## 取得元を増やす

`setup()` を実行すると、スプレッドシートに `sources` シートが作られます。ここにRSS/Atomフィードを追加します。

列の意味:

```text
enabled: TRUE の行だけ取得
name: 取得元名
kind: 公式ブログ、ニュース、note、YouTube、個人ブログなど
url: RSS/AtomフィードURL
tier: official / trusted / community / watch
queryHint: 何を見るための取得元か
notes: 運用メモ
includeKeywords: 含めたい語句。カンマ区切り
excludeKeywords: 除外したい語句。カンマ区切り
tags: タグや分類メモ。フィルタにも使われる
```

例:

```text
公式ブログ: https://workspaceupdates.googleblog.com/feeds/posts/default?alt=rss
ニュース検索: https://news.google.com/rss/search?q=Google%20Workspace%20Gemini&hl=ja&gl=JP&ceid=JP:ja
note: noteユーザーやマガジンが提供しているRSS URL
YouTube: 対象チャンネルのRSS URL
```

ニュース、note、YouTube、個人ブログは発見用です。公開前に掲載文を整え、必要に応じて元情報を確認します。

## RSSを取得元に追加する

投稿者画面の `RSS登録` に、RSS/AtomフィードURLと取得元名を入力します。

```text
https://www.yoshidumi.co.jp/collaboration-lab/rss.xml
吉積情報 コラボラボ
```

登録後に `最新記事を取得` を押すと、そのRSSの新着記事が `Candidate` として台帳に入ります。

`含める語句` と `除外語句` を入れると、候補化前にタイトル、本文抜粋、カテゴリでフィルタします。

## noteを取得元に追加する

投稿者画面の `note登録` に、noteのユーザー名、クリエイターページURL、RSS URLのどれかを入力します。

```text
creator_id
https://note.com/creator_id
https://note.com/creator_id/rss
#Gemini
https://note.com/hashtag/Gemini/rss
```

登録後に `最新記事を取得` を押すと、そのnoteの新着記事が `Candidate` として台帳に入ります。

`含める語句・タグ` には、候補にしたい語句をカンマ区切りで入れます。

```text
Gemini,Google Workspace,NotebookLM,Workspace Studio,Gmail,Meet,Chat,Docs,Sheets
```

`除外語句` には、拾いたくない語句をカンマ区切りで入れます。

```text
求人,採用,株価,広告
```

## 検索語句で広く拾う

投稿者画面の `検索登録` に検索語句を入れると、Google News検索RSSとnoteタグRSSを取得元に追加します。

```text
Gemini,Google Workspace,Workspace Studio,#NotebookLM
```

登録される取得元:

```text
Google News search: Gemini / Google Workspace / Workspace Studio / #NotebookLM
note tag: Gemini
note tag: Google Workspace
note tag: Workspace Studio
note tag: NotebookLM
```

`含める語句` と `除外語句` を入れると、候補化前にタイトル、本文抜粋、カテゴリでフィルタします。

## 任意: Google Chat に候補通知

新規候補が追加されたとき、投稿担当者用スペースへ通知したい場合は、Google Chat の Incoming Webhook URL を Script Properties に追加します。

```text
DISPATCH_CHAT_WEBHOOK_URL=https://chat.googleapis.com/v1/spaces/...
```

未設定なら通知は送られません。候補取得とGoogleサイト表示だけで動きます。

## Web アプリとしてデプロイ

Apps Script の画面で:

```text
デプロイ > 新しいデプロイ > 種類: ウェブアプリ
```

推奨設定:

```text
実行ユーザー: 自分
アクセスできるユーザー: 組織内のユーザー
```

## Google Sites に埋め込む

1. デプロイ済み Web アプリ URL をコピー
2. Google Sites で `挿入 > 埋め込む > URL`
3. URL を貼る
4. 埋め込み枠の高さを調整
5. 公開

以後、Google Sites 側は基本的に触りません。`Published` の行が増えると、社員向け画面に反映されます。

## 投稿者画面

Web アプリ URL の末尾に `?mode=publisher` を付けます。

```text
https://script.google.com/.../exec?mode=publisher
```

投稿者画面でやること:

1. `最新記事を取得`
2. 公式記事を開いて内容確認
3. 掲載タイトル、3行まとめ、対象、試すこと、注意点を修正
4. `[要編集]` を削除
5. `保存して公開`

RSSに入っていない記事、note、ニュース記事、YouTube動画を見つけた場合は、投稿者画面上部の `URL追加` にURLを貼ると候補として台帳に追加できます。

## 精度を落とさないためのルール

- 公式リンクを確認するまで公開しない
- 公式以外の情報源は、必要に応じて一次情報または公式情報も確認する
- 対象エディション、管理者設定、ロールアウト時期は断言しない
- 当社環境で未確認なら「可能性があります」「確認してください」と書く
- 社外秘、個人情報、顧客情報を入力する使い方はすすめない
- 自動生成文のまま公開しない

## 補足

Google Sites 本体は自動編集しません。GAS の Web アプリを Google Sites に埋め込み、Web アプリ側の表示データを自動更新します。
