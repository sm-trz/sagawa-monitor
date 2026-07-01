# sagawa-monitor

佐川急便のお荷物問い合わせページを Playwright で開き、配送ステータスを Google スプレッドシートへ反映する Cloud Run 用ツールです。

## スプレッドシート列

シート名は初期値 `返品管理` です。

| A | B | C | D | E | F | G | H |
|---|---|---|---|---|---|---|---|
| 注文番号 | 伝票番号 | 発送日 | 最終ステータス | 最終確認日時 | 返品候補 | 通知済 | デバッグ |

入力が必要なのは A〜C 列です。D〜H 列は自動更新されます。

## Cloud Run 環境変数

必須：

- `SPREADSHEET_ID`：スプレッドシートURL内のID
- `SHEET_NAME`：例 `返品管理`

任意：

- `MAX_ROWS`：確認する最大行数。初期値 `200`
- `DAYS_TO_MONITOR`：発送日から何日間監視するか。初期値 `21`

## 実行方法

Cloud Runにデプロイ後、以下へPOSTします。

```text
POST https://xxxxx.run.app/run
```

ブラウザでトップURLを開くと `sagawa-monitor is running. Use POST /run` と表示されます。

## Google Sheetsの権限

Cloud Run のサービスアカウントのメールアドレスを、対象スプレッドシートに「編集者」として共有してください。

サービスアカウント例：

```text
xxxxx-compute@developer.gserviceaccount.com
```
