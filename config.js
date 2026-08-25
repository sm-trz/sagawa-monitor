/**
 * config.js
 * 環境変数をまとめて読み込む場所。
 * ここに書いてある数字は、Cloud Run の「環境変数」から後で変更できます。
 */

function num(value, defaultValue) {
  const n = parseInt(value, 10);
  return Number.isFinite(n) ? n : defaultValue;
}

module.exports = {
  // ── Google スプレッドシート ────────────────────────────────
  SPREADSHEET_ID: process.env.SPREADSHEET_ID || '',
  SHEET_NAME: process.env.SHEET_NAME || '返品管理',

  // ── 判定ルール ─────────────────────────────────────────────
  // 発送から何日経っても「配達完了」にならなければ「要確認」にする
  STALE_DAYS: num(process.env.STALE_DAYS, 7),

  // 発送から何日経ったら監視自体をやめるか（打ち切り）
  MAX_MONITOR_DAYS: num(process.env.MAX_MONITOR_DAYS, 45),

  // ── アクセス制御（配送会社サイトへの負荷を抑える） ────────
  // 1件ごとの待ち時間（ミリ秒）
  REQUEST_INTERVAL_MS: num(process.env.REQUEST_INTERVAL_MS, 3000),

  // 1回の実行で照会する最大件数
  MAX_PER_RUN: num(process.env.MAX_PER_RUN, 150),

  // 1件あたりのページ表示待ち（ミリ秒）
  PAGE_TIMEOUT_MS: num(process.env.PAGE_TIMEOUT_MS, 30000),

  // ── ヤマト運輸 ─────────────────────────────────────────────
  // ヤマトのステータス文言で返品判定を行うか。
  // 実データ（返品・配達完了）で検証済みのため既定は 'on'。
  // 誤検知が出た場合は Cloud Run の環境変数で 'off' にすると
  // 滞留日数だけの判定に戻せる。
  YAMATO_STATUS_JUDGE: (process.env.YAMATO_STATUS_JUDGE || 'on') === 'on',

  // ヤマトを1回の検索で何件まとめて照会するか（1〜10）。
  // 1 にすると従来どおり1件ずつになる。
  YAMATO_BATCH_SIZE: num(process.env.YAMATO_BATCH_SIZE, 10),

  // ── 保管期限 ───────────────────────────────────────────────
  // 持ち帰り（不在）から何日で差出人へ返送されるか。
  // 公式FAQの記載に合わせて調整できるよう環境変数にしている。
  SAGAWA_HOLD_DAYS: num(process.env.SAGAWA_HOLD_DAYS, 8),
  YAMATO_HOLD_DAYS: num(process.env.YAMATO_HOLD_DAYS, 7),

  // ヤマトは追跡ページに営業所の電話番号が出ないため、固定の連絡先を設定できる
  YAMATO_CONTACT_TEL: process.env.YAMATO_CONTACT_TEL || '',

  // ── カート（管理画面）へのリンク ───────────────────────────
  // 注文番号が数字だけのときに、この後ろに注文番号をつなげて通知に載せる
  CART_URL_PREFIX:
    process.env.CART_URL_PREFIX ||
    'https://beautymakelabo.jp/admin/order/edit.php?mode=pre_edit&order_id=',

  // ── 通知（Chatwork） ───────────────────────────────────────
  // トークンは Secret Manager から環境変数として渡す。
  // 両方そろっている場合だけ通知が有効になる。
  CHATWORK_API_TOKEN: process.env.CHATWORK_API_TOKEN || '',
  CHATWORK_ROOM_ID: process.env.CHATWORK_ROOM_ID || '',

  // テスト用ルーム（/run?mode=test と /test-notify の送信先）
  CHATWORK_ROOM_ID_TEST: process.env.CHATWORK_ROOM_ID_TEST || '',

  // 'off' にすると、検知しても通知を送らない（テスト用）
  NOTIFY: (process.env.NOTIFY || 'on') === 'on',

  // ── 実行の保護 ─────────────────────────────────────────────
  // 値を設定すると /run?token=その値 でないと実行できなくなる（空なら無効）
  RUN_TOKEN: process.env.RUN_TOKEN || '',

  // ── デバッグ ───────────────────────────────────────────────
  // 'on' の間はページ本文をログに出す（判定の調整に使う）
  DUMP_PAGE_TEXT: (process.env.DUMP_PAGE_TEXT || 'on') === 'on',
  DUMP_LENGTH: num(process.env.DUMP_LENGTH, 4000),
};
