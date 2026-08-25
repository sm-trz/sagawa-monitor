/**
 * judge.js
 * 取得した配送状況から「どう扱うか」を決める。
 *
 * ── 設計の根拠（すべて実データで確認したこと）──────────────────────
 *
 * 1. 佐川は返品された荷物に「返品」と表示しない。
 *    実例では「調査中／恐れ入りますが、営業所へお問い合わせください。」で、
 *    履歴テーブルごと消えていた。
 *    → 佐川の「調査中」は"判断できない状態"として人の確認対象にする。
 *
 * 2. ヤマトは「返品」と明示的に表示する。
 *    ただし返品の"後"にも「陸・海上切替え」などの記録が続くため、
 *    履歴の最後の1行だけ見ると見逃す。
 *    → 履歴全体を確認する。
 *
 * 3. 佐川の「保管中」には2つの意味がある。
 *    実例では、営業所到着当日の一時保管のあと翌日に配達完了していた。
 *    → 「配達中」の記録が先にあれば持ち帰り、無ければ配達前の保管とみなす。
 *
 * 4. 不在 → 再配達 → 配達完了 は正常な流れ。
 *    → 最新が「配達完了」なら履歴に何があっても検知しない。
 */

const config = require('./config');
const { daysBetween, addDays, toDate } = require('./datetime');

// ── J列に入る値 ─────────────────────────────────────────────
const FLAG_NONE = '';
const FLAG_WATCH = '経過観察';   // 記録するだけ。通知しない
const FLAG_INVESTIGATE = '要調査'; // 通知する
const FLAG_RETURNED = '返品確定';  // 通知する
const FLAG_STALE = '長期未完了';   // 記録するだけ。通知しない

/** ここに来たら監視終了（もう照会しない） */
const FINISHED_STATUSES = new Set(['配達完了']);

/** 返品・返送が明示された状態 */
const RETURN_CONFIRMED = new Set(['返品', '返送', '受取拒否', '受取辞退']);

/** 配達できずに持ち帰った状態 */
const HELD_STATUSES = new Set(['持戻り', '長期不在']);

/** 正常に進行中とみなす状態 */
const IN_PROGRESS = new Set(['荷物受付', '集荷', '輸送中', '配達中']);

/** 通知の優先度。数字が大きいほど深刻 */
const FLAG_RANK = {
  '': 0,
  [FLAG_WATCH]: 0,
  [FLAG_STALE]: 0,
  [FLAG_INVESTIGATE]: 1,
  [FLAG_RETURNED]: 2,
};

function flagRank(value) {
  const s = String(value || '').trim();
  if (s === 'TRUE') return 1; // 旧仕様との互換
  return FLAG_RANK[s] || 0;
}

/** 今回の判定が、前回通知したレベルより悪化しているか */
function shouldNotify(currentFlag, notifiedValue) {
  return flagRank(currentFlag) > flagRank(notifiedValue);
}

/** 配送会社ごとの保管日数 */
function holdDays(carrierName) {
  return carrierName === 'ヤマト' ? config.YAMATO_HOLD_DAYS : config.SAGAWA_HOLD_DAYS;
}

/**
 * 持ち帰り日から返送予定日を計算する。
 * @returns {{date:string, daysLeft:number}|null}
 */
function returnDeadline(heldAt, carrierName, now = new Date()) {
  if (!heldAt) return null;
  const date = addDays(heldAt, holdDays(carrierName));
  if (!date) return null;
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const daysLeft = daysBetween(today, toDate(date));
  return { date, daysLeft };
}

/**
 * 判定する。
 *
 * @param {object} args
 * @param {string}   args.status            正規化済みの最新ステータス
 * @param {string[]} args.history           履歴のステータス一覧（古い順）
 * @param {boolean}  args.attemptedDelivery 配達を試みた記録があるか
 * @param {string}   args.heldAt            最初の持ち帰り日時
 * @param {string}   args.shipDate          集荷日
 * @param {string}   args.carrierName       佐川 / ヤマト
 * @param {boolean}  args.trustStatus       ステータス文言を信用してよいか
 * @param {Date}     args.now
 */
function judge({
  status,
  history = [],
  attemptedDelivery = false,
  heldAt = '',
  shipDate = '',
  carrierName = '',
  trustStatus = true,
  now = new Date(),
}) {
  const notes = [];
  let effectiveStatus = status;
  let flag = FLAG_NONE;

  // ① 配達完了 → 監視終了。履歴に持戻りがあっても検知しない。
  if (FINISHED_STATUSES.has(status)) {
    return { flag: FLAG_NONE, finished: true, effectiveStatus, notes, deadline: null };
  }

  const deadline = returnDeadline(heldAt, carrierName, now);

  if (!trustStatus) {
    // ヤマトの文言判定を止めている場合（YAMATO_STATUS_JUDGE=off）
    if (RETURN_CONFIRMED.has(status) || HELD_STATUSES.has(status)) {
      notes.push(`ステータス「${status}」（判定は保留中）`);
    }
    return { flag: FLAG_NONE, finished: false, effectiveStatus, notes, deadline };
  }

  // ② 返品・返送が明示された → 返品確定
  const returnedInHistory = history.find((h) => RETURN_CONFIRMED.has(h));
  if (RETURN_CONFIRMED.has(status)) {
    flag = FLAG_RETURNED;
    notes.push(`ステータス「${status}」を検知`);
  } else if (returnedInHistory) {
    flag = FLAG_RETURNED;
    effectiveStatus = returnedInHistory;
    notes.push(`履歴に「${returnedInHistory}」あり（最新の記録は「${status}」）`);
  }

  // ③ 持ち帰り → 要調査（確定したその回に通知する）
  else if (HELD_STATUSES.has(status)) {
    flag = FLAG_INVESTIGATE;
    notes.push(`ステータス「${status}」を検知`);
  }

  // ④ 保管中 → 配達を試みた記録があれば持ち帰り、無ければ配達前の一時保管
  else if (status === '保管中') {
    if (attemptedDelivery) {
      flag = FLAG_INVESTIGATE;
      notes.push('配達後の保管（持ち帰りとみなします）');
    } else {
      flag = FLAG_WATCH;
      notes.push('配達前の営業所保管とみなします');
    }
  }

  // ⑤ 調査中 → 自動では判断できない。人が確認する。
  else if (status === '調査中') {
    flag = FLAG_INVESTIGATE;
    notes.push('配送会社が「調査中」。自動では判断できません');
  }

  // ⑥ 取得できなかった
  else if (status === '取得失敗') {
    flag = FLAG_INVESTIGATE;
    notes.push('配送会社サイトから状況を読み取れませんでした');
  }

  // ⑦ 正常進行中 → 何もしない。ただし極端に長い場合は記録に残す。
  else if (IN_PROGRESS.has(status)) {
    const elapsed = shipDate ? daysBetween(shipDate, now) : null;
    if (elapsed !== null && elapsed > config.MAX_MONITOR_DAYS - 15) {
      flag = FLAG_STALE;
      notes.push(`発送から${elapsed}日経過・未完了`);
    }
  }

  // ⑧ 想定していない文言 → 気づけるように記録に残す
  else if (status) {
    flag = FLAG_INVESTIGATE;
    notes.push(`未知のステータス「${status}」`);
  }

  if (deadline && flag === FLAG_INVESTIGATE) {
    notes.push(
      deadline.daysLeft >= 0
        ? `返送予定 ${deadline.date}（あと${deadline.daysLeft}日）`
        : `返送予定日 ${deadline.date} を過ぎています`
    );
  }

  return { flag, finished: false, effectiveStatus, notes, deadline };
}

/** 監視自体をやめる期限を過ぎているか */
function isTooOld(shipDate, now = new Date()) {
  if (!shipDate) return false;
  const elapsed = daysBetween(shipDate, now);
  return elapsed !== null && elapsed > config.MAX_MONITOR_DAYS;
}

module.exports = {
  judge,
  isTooOld,
  flagRank,
  shouldNotify,
  returnDeadline,
  holdDays,
  FINISHED_STATUSES,
  FLAG_NONE,
  FLAG_WATCH,
  FLAG_INVESTIGATE,
  FLAG_RETURNED,
  FLAG_STALE,
};
