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

  // ── 配送会社の追跡ページ ───────────────────────────────────
  // 伝票番号をそのまま後ろにつなげる。
  // 佐川はURLを直接開けば配送状況が表示される（実データで確認済み）。
  // ヤマトは追跡ページを直接開いても結果が出ないため、
  // 「受け取り日時・場所の変更」ページを案内する。
  SAGAWA_TRACK_URL_PREFIX:
    process.env.SAGAWA_TRACK_URL_PREFIX ||
    'https://k2k.sagawa-exp.co.jp/p/web/okurijosearch.do?okurijoNo=',
  YAMATO_TRACK_URL_PREFIX:
    process.env.YAMATO_TRACK_URL_PREFIX ||
    'https://jizen.kuronekoyamato.co.jp/jizen/servlet/crjz.b.NQ0010?id=',

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

  // 運用専用ルーム（システムエラーと日次サマリの送信先）。
  // 業務委託者グループには絶対に流さないよう、未設定のときは
  // テストルームへ送り、それも無ければ送信しない。
  CHATWORK_ROOM_ID_ALERT: process.env.CHATWORK_ROOM_ID_ALERT || '',

  // 'task' = タスクとして作る（既定） / 'message' = 通常メッセージで送る
  CHATWORK_NOTIFY_MODE: process.env.CHATWORK_NOTIFY_MODE || 'task',

  // タスクの担当者にするアカウントID（カンマ区切り）。
  // 空にしておくと、ルームの参加者（閲覧のみを除く）全員が担当者になる。
  CHATWORK_TASK_TO_IDS: process.env.CHATWORK_TASK_TO_IDS || '',

  // 1件ずつ送るときの間隔（Chatworkの回数制限対策）
  CHATWORK_INTERVAL_MS: num(process.env.CHATWORK_INTERVAL_MS, 600),

  // 'off' にすると、検知しても通知を送らない（テスト用）
  NOTIFY: (process.env.NOTIFY || 'on') === 'on',

  // ── 異常の検知 ─────────────────────────────────────────────
  // 取得失敗がこの件数以上、またはこの割合以上になったら即座に通知する
  ERROR_ALERT_MIN_COUNT: num(process.env.ERROR_ALERT_MIN_COUNT, 3),
  ERROR_ALERT_MIN_RATIO: Number(process.env.ERROR_ALERT_MIN_RATIO || '0.3'),

  // 日次サマリを送る時刻（この時間帯の実行のあとに送る）
  DAILY_SUMMARY_HOUR: num(process.env.DAILY_SUMMARY_HOUR, 17),

  // ── 実行の保護 ─────────────────────────────────────────────
  // 値を設定すると /run?token=その値 でないと実行できなくなる（空なら無効）
  RUN_TOKEN: process.env.RUN_TOKEN || '',

  // ── デバッグ ───────────────────────────────────────────────
  // 'on' の間はページ本文をログに出す（判定の調整に使う）
  DUMP_PAGE_TEXT: (process.env.DUMP_PAGE_TEXT || 'on') === 'on',
  DUMP_LENGTH: num(process.env.DUMP_LENGTH, 4000),
};
