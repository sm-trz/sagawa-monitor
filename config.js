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

  // ── 実行の保護 ─────────────────────────────────────────────
  // 値を設定すると /run?token=その値 でないと実行できなくなる（空なら無効）
  RUN_TOKEN: process.env.RUN_TOKEN || '',

  // ── デバッグ ───────────────────────────────────────────────
  // 'on' の間はページ本文をログに出す（判定の調整に使う）
  DUMP_PAGE_TEXT: (process.env.DUMP_PAGE_TEXT || 'on') === 'on',
  DUMP_LENGTH: num(process.env.DUMP_LENGTH, 4000),
};
