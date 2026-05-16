# Workspace / Gemini Dispatch

Google Workspace と Gemini の更新情報を収集し、社員向けに短く展開するための Google Apps Script Web アプリです。

## 構成

- `gas/Code.gs`: 取得、台帳、公開処理
- `gas/Index.html`: 社員向け表示画面
- `gas/Publisher.html`: 投稿者向け編集・公開画面
- `gas/appsscript.json`: Apps Script 設定
- `gas/README.md`: セットアップと運用メモ

## 基本運用

1. `dailyScan()` で取得元から候補記事を収集
2. `items` シートに `Candidate` として保存
3. 投稿者画面で掲載文を整える
4. `Published` にした記事だけ社員向け画面へ表示

投稿者画面は Web アプリ URL に `?mode=publisher` を付けて開きます。

## 必要な Script Properties

```text
DISPATCH_SHEET_ID=GoogleスプレッドシートID
DISPATCH_ADMIN_EMAILS=投稿者メールアドレス
```

任意:

```text
DISPATCH_CHAT_WEBHOOK_URL=Google Chat Incoming Webhook URL
```

## デプロイ

```bash
cd gas
clasp push
```

Web アプリの公開URLに反映する場合は、Apps Script のデプロイを新しいバージョンへ更新します。
