/**
 * judge.js
 * 取得したステータスと発送日から「返品候補かどうか」を判定する。
 *
 * ── 設計の考え方 ────────────────────────────────────────────
 * 実データで分かったこと：佐川は返品された荷物に「返品」と表示しません。
 * （返品確定の荷物が「調査中／営業所へお問い合わせください」だった）
 *
 * そのため、文言だけに頼らず「滞留検知」を安全網として併用します。
 *
 *   発送から STALE_DAYS 日経っても配達完了にならない
 *     → 理由が何であれ「要確認」
 *
 * この方式なら、配送会社が今後どんな文言を使っても取りこぼしません。
 */

const config = require('./config');

/** ここに来たら監視終了（もう照会しない） */
const FINISHED_STATUSES = new Set(['配達完了']);

/** 明確に返品・返送を示す文言 */
const RETURN_STRONG = new Set(['返送', '返品', '受取拒否', '受取辞退']);

/** 返品につながる可能性が高く、人の確認が必要な文言 */
const RETURN_WATCH = new Set(['調査中', '持戻り', '長期不在']);

/** 正常に進行中とみなす文言 */
const IN_PROGRESS = new Set(['荷物受付', '集荷', '輸送中', '配達中', '保管中']);

const FLAG_NONE = '';
const FLAG_WATCH = '要確認';
const FLAG_STRONG = '返品濃厚';

/**
 * "2026/08/07" や "2026-8-7" や "2026年8月7日" を Date に変換する。
 * 読み取れなければ null。
 */
function parseShipDate(value) {
  const text = String(value || '').trim();
  if (!text) return null;
  const m = text.match(/(\d{4})\s*[\/\-年.]\s*(\d{1,2})\s*[\/\-月.]\s*(\d{1,2})/);
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Number.isNaN(d.getTime()) ? null : d;
}

/** 発送日から今日までの経過日数。発送日が読めなければ null。 */
function daysSinceShip(shipDateValue, now = new Date()) {
  const shipped = parseShipDate(shipDateValue);
  if (!shipped) return null;
  const diffMs = now.getTime() - shipped.getTime();
  return Math.floor(diffMs / (24 * 60 * 60 * 1000));
}

/**
 * @param {object} args
 * @param {string} args.status       正規化済みの最新ステータス
 * @param {string[]} args.history    履歴に出てきたステータスの一覧（古い順）
 * @param {string} args.shipDate     発送日（シートの文字列）
 * @param {boolean} args.trustStatus ステータス文言を判定に使ってよいか
 * @param {Date}   args.now
 */
function judge({ status, history = [], shipDate, trustStatus = true, now = new Date() }) {
  const elapsed = daysSinceShip(shipDate, now);
  const notes = [];
  let effectiveStatus = status;

  // ① 配達完了 → 監視終了。履歴に持戻りなどがあっても関係なし。
  //    （不在→再配達→完了 は正常な流れなので誤検知してはいけない）
  if (FINISHED_STATUSES.has(status)) {
    return { flag: FLAG_NONE, finished: true, elapsed, notes: [], effectiveStatus };
  }

  let flag = FLAG_NONE;

  // ② 履歴の中に明確な返品・返送があれば、それを最新扱いにする。
  //    実例: ヤマトで「返品」の後に「陸・海上切替え」が記録されていた。
  //    最後の1行だけ見ると返品を見逃すため、履歴全体を確認する。
  const strongInHistory = history.find((h) => RETURN_STRONG.has(h));

  // ③ 文言による判定
  if (trustStatus) {
    if (RETURN_STRONG.has(status)) {
      flag = FLAG_STRONG;
      notes.push(`ステータス「${status}」を検知`);
    } else if (strongInHistory) {
      flag = FLAG_STRONG;
      effectiveStatus = strongInHistory;
      notes.push(`履歴に「${strongInHistory}」あり（最新の記録は「${status}」）`);
    } else if (RETURN_WATCH.has(status)) {
      flag = FLAG_WATCH;
      notes.push(`ステータス「${status}」を検知`);
    }
  } else if (RETURN_STRONG.has(status) || RETURN_WATCH.has(status) || strongInHistory) {
    notes.push(`ステータス「${strongInHistory || status}」（判定は保留中）`);
  }

  // ③ 滞留検知（文言に依存しない安全網）
  if (elapsed !== null && elapsed > config.STALE_DAYS) {
    if (flag === FLAG_NONE) flag = FLAG_WATCH;
    notes.push(`発送から${elapsed}日経過・未完了`);
  }

  // ④ 取得に失敗し続けている場合も人の確認対象にする
  if (status === '取得失敗' && flag === FLAG_NONE) {
    notes.push('配送会社サイトから状況を読み取れませんでした');
  }

  // ⑤ 想定していない文言が来たら、記録に残して気づけるようにする
  if (
    trustStatus &&
    status &&
    status !== '取得失敗' &&
    !IN_PROGRESS.has(status) &&
    !RETURN_STRONG.has(status) &&
    !RETURN_WATCH.has(status) &&
    !FINISHED_STATUSES.has(status)
  ) {
    if (flag === FLAG_NONE) flag = FLAG_WATCH;
    notes.push(`未知のステータス「${status}」`);
  }

  return { flag, finished: false, elapsed, notes, effectiveStatus };
}

/** 監視自体をやめる期限を過ぎているか */
function isTooOld(shipDate, now = new Date()) {
  const elapsed = daysSinceShip(shipDate, now);
  return elapsed !== null && elapsed > config.MAX_MONITOR_DAYS;
}

module.exports = {
  judge,
  isTooOld,
  daysSinceShip,
  parseShipDate,
  FINISHED_STATUSES,
  FLAG_NONE,
  FLAG_WATCH,
  FLAG_STRONG,
};
