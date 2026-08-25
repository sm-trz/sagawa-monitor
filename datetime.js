/**
 * datetime.js
 * 配送会社のページは日時に「年」を書かない（例: "08/19 18:23"）。
 * 年を補うための共通処理をここにまとめる。
 *
 * 補い方のルール（推測ではなく、必ず同じ結果になる決まった手順）:
 *   1. 基準日（集荷日）があれば、その年を使う。
 *      月が基準日より小さければ年をまたいだとみなして +1 年。
 *   2. 基準日が無ければ今年とみなし、
 *      それが「明日より未来」になるなら前年とみなす。
 */

function pad2(n) {
  return String(n).padStart(2, '0');
}

/** "2026/08/17" のような文字列を {year, month, day} にする */
function parseYmd(value) {
  const m = String(value || '').match(/(\d{4})\s*[\/\-年.]\s*(\d{1,2})\s*[\/\-月.]\s*(\d{1,2})/);
  if (!m) return null;
  return { year: Number(m[1]), month: Number(m[2]), day: Number(m[3]) };
}

/**
 * "08/19 18:23" や "08月19日 07:50" を "YYYY/MM/DD HH:MM" にする。
 * @param {string} text    ページから取れた日時（年なし）
 * @param {string} baseYmd 基準日（集荷日など）。無くてもよい
 * @param {Date}   now     現在時刻（テスト用に差し替え可能）
 */
function toDateTime(text, baseYmd, now = new Date()) {
  const m = String(text || '').match(
    /(\d{1,2})\s*[\/月]\s*(\d{1,2})\s*日?(?:\s*(\d{1,2})\s*[:時]\s*(\d{1,2}))?/
  );
  if (!m) return '';

  const month = Number(m[1]);
  const day = Number(m[2]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return '';

  const hour = m[3] === undefined ? null : Number(m[3]);
  const minute = m[4] === undefined ? null : Number(m[4]);

  let year;
  const base = parseYmd(baseYmd);

  if (base) {
    year = base.year;
    // 集荷が12月・記録が1月 → 年をまたいでいる
    if (month < base.month) year += 1;
  } else {
    year = now.getFullYear();
    const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
    if (new Date(year, month - 1, day) > tomorrow) year -= 1;
  }

  const date = `${year}/${pad2(month)}/${pad2(day)}`;
  if (hour === null) return date;
  return `${date} ${pad2(hour)}:${pad2(minute)}`;
}

/** "YYYY/MM/DD ..." を Date にする。読めなければ null */
function toDate(value) {
  const ymd = parseYmd(value);
  if (!ymd) return null;
  return new Date(ymd.year, ymd.month - 1, ymd.day);
}

/** a から b までの日数（bが後なら正） */
function daysBetween(a, b) {
  const da = a instanceof Date ? a : toDate(a);
  const db = b instanceof Date ? b : toDate(b);
  if (!da || !db) return null;
  return Math.floor((db.getTime() - da.getTime()) / (24 * 60 * 60 * 1000));
}

/** "YYYY/MM/DD" に日数を足す */
function addDays(value, days) {
  const d = toDate(value);
  if (!d) return '';
  d.setDate(d.getDate() + days);
  return `${d.getFullYear()}/${pad2(d.getMonth() + 1)}/${pad2(d.getDate())}`;
}

module.exports = { toDateTime, toDate, parseYmd, daysBetween, addDays, pad2 };
