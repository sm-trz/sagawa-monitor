/**
 * carriers/sagawa.js
 * 佐川急便「お荷物問い合わせサービス」から配送状況を取得する。
 *
 * ── 実ページで確認済みの構造（2026-08 時点）─────────────────────────
 *
 *   詳細 / お問い合せ送り状No. / 最新荷物状況
 *   詳細1
 *   <TAB>444803009836<TAB>
 *   配達完了                      ← ★最新ステータス
 *   お荷物のお届けが完了いたしました。
 *   ...
 *   荷物状況 / 日時 / 担当営業所
 *   ↓集荷      08/17 17:22  西埼玉営業所
 *   ↓輸送中    08/17 18:10  北関東中継センター
 *   ↓保管中    08/18 14:14  松江営業所
 *   ↓配達中    08/19 13:19  松江営業所
 *   ⇒配達完了  08/19 18:23  松江営業所   ← ★最新の1行だけ「⇒」が付く
 *
 * ── 重要な注意点 ────────────────────────────────────────────────
 * 1. ページ全文をキーワード検索してはいけない。
 *    「集荷に関するお問い合せ」という全ページ共通のラベルがあるため、
 *    「集荷」で必ず誤ヒットする。
 * 2. 履歴には過去の状態が全部残る。
 *    「保管中」や「持戻り」が履歴にあっても、最終的に届いていれば配達完了。
 *    → 必ず「⇒」の行だけを見る。
 * 3. 返品された荷物は「返品」と表示されない。
 *    実データでは「調査中／恐れ入りますが、営業所へお問い合わせください。」
 *    となり、履歴テーブル自体が消えていた。
 */

const logger = require('../logger');
const config = require('../config');
const { withPage } = require('../browser');
const { toDateTime } = require('../datetime');

const NAME = '佐川';
const URL_BASE = 'https://k2k.sagawa-exp.co.jp/p/web/okurijosearch.do?okurijoNo=';

/** 佐川の表記ゆれを、社内で使う正式名称にそろえる */
const NORMALIZE = [
  { canonical: '配達完了', patterns: ['配達完了', 'お届け済', '配達済'] },
  { canonical: '配達中', patterns: ['配達中', 'お届け中'] },
  { canonical: '輸送中', patterns: ['輸送中', '幹線輸送中', '配達店到着'] },
  { canonical: '集荷', patterns: ['集荷'] },
  { canonical: '保管中', patterns: ['保管中', '営業所保管'] },
  { canonical: '調査中', patterns: ['調査中'] },
  { canonical: '持戻り', patterns: ['持戻り', '持ち戻り', '不在持戻', 'ご不在'] },
  { canonical: '長期不在', patterns: ['長期不在', '長期間不在'] },
  { canonical: '受取辞退', patterns: ['受取辞退', '受け取り辞退'] },
  { canonical: '受取拒否', patterns: ['受取拒否', '受け取り拒否'] },
  { canonical: '返送', patterns: ['返送', '差出人返送', '差出人へ返送'] },
  { canonical: '返品', patterns: ['返品'] },
  { canonical: '荷物受付', patterns: ['荷物受付', '出荷情報受付'] },
];

/**
 * 生の表示文言を正式名称に変換する。
 * 一致するものが無ければ、元の文言をそのまま返す（未知の文言を記録に残すため）。
 */
function normalizeStatus(raw) {
  const text = (raw || '').trim();
  if (!text) return '';
  for (const { canonical, patterns } of NORMALIZE) {
    for (const p of patterns) {
      if (text.includes(p)) return canonical;
    }
  }
  return text;
}

/** ページ本文を行の配列にする（全角スペースは半角に寄せる） */
function toLines(text) {
  return (text || '').split('\n').map((l) => l.replace(/　/g, ' '));
}

/**
 * 「↓」「⇒」で始まる履歴行を取り出す。
 * 例: "⇒配達完了\t08/19 18:23\t松江営業所"
 */
function parseHistory(lines) {
  const history = [];
  for (const line of lines) {
    const m = line.match(/^\s*([↓⇒])\s*([^\t]+?)\s*(?:\t\s*([^\t]*?)\s*)?(?:\t\s*(.*?)\s*)?$/);
    if (!m) continue;
    const label = (m[2] || '').trim();
    if (!label) continue;
    history.push({
      isLatest: m[1] === '⇒', // ⇒
      label,
      datetime: (m[3] || '').trim(),
      office: (m[4] || '').trim(),
    });
  }
  return history;
}

/**
 * 履歴テーブルが無いページ用。
 * 「最新荷物状況」の見出しの後ろにある伝票番号の、次の行がステータス。
 */
function parseHeadline(lines, trackingNo) {
  const headIdx = lines.findIndex((l) => l.includes('最新荷物状況'));
  if (headIdx === -1) return { status: '', detail: '' };

  for (let i = headIdx + 1; i < Math.min(lines.length, headIdx + 15); i++) {
    // "\t444803002033\t" のような行（空白・タブを除くと伝票番号だけになる）
    if (lines[i].replace(/\s/g, '') !== trackingNo) continue;

    let status = '';
    let detail = '';
    for (let j = i + 1; j < Math.min(lines.length, i + 8); j++) {
      const s = lines[j].trim();
      if (!s) continue;
      if (!status) { status = s; continue; }
      detail = s;
      break;
    }
    return { status, detail };
  }
  return { status: '', detail: '' };
}

/**
 * 「出荷日 2026年08月07日」から集荷日を取り出す。
 * 佐川は年まで表示されるため、そのまま使える。
 * 返品後の「調査中」ページ（履歴が消えている）にも出荷日は残っていた。
 */
function parseShipDate(lines) {
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].includes('出荷日')) continue;
    const target = `${lines[i]}\n${lines[i + 1] || ''}`;
    const m = target.match(/(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日/);
    if (m) {
      return `${m[1]}/${String(m[2]).padStart(2, '0')}/${String(m[3]).padStart(2, '0')}`;
    }
  }
  return '';
}

/**
 * 「配達に関するお問い合せ　荒川営業所  TEL:0570-01-0659」から
 * 営業所名と電話番号を取り出す。再配達の案内先として通知に載せる。
 */
function parseOffice(lines) {
  for (const line of lines) {
    if (!line.includes('配達に関する')) continue;
    const name = (line.match(/([^\s\t]+営業所)/) || [])[1] || '';
    const tel = (line.match(/TEL[:：]\s*([0-9\-]+)/) || [])[1] || '';
    if (name || tel) return { name, tel };
  }
  return { name: '', tel: '' };
}

/** 「配達予定日」「配達完了日」など、人が見て役立つ情報を拾う */
function parseExtraInfo(lines) {
  const parts = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line.startsWith('配達予定日') || line.startsWith('配達完了日')) {
      const label = line.replace(/[\s:：]+$/, '').replace(/\s+/g, '');
      const value = (lines[i + 1] || '').trim();
      if (value) parts.push(`${label}: ${value}`);
    }
  }
  return parts.join(' / ');
}

/**
 * ページ本文（innerText）から配送状況を組み立てる。
 * ※ この関数は通信しないので、単体テストが可能です。
 */
function parsePageText(text, trackingNo) {
  const lines = toLines(text);
  const history = parseHistory(lines);
  const headline = parseHeadline(lines, trackingNo);
  const extra = parseExtraInfo(lines);
  const shipDate = parseShipDate(lines);
  const office = parseOffice(lines);

  // 最優先: 「⇒」が付いた履歴行。無ければ履歴の最後の行。
  const latestFromHistory =
    history.find((h) => h.isLatest) || history[history.length - 1] || null;

  let rawStatus = '';
  let source = '';

  if (latestFromHistory) {
    rawStatus = latestFromHistory.label;
    source = 'history';
  } else if (headline.status) {
    // 履歴テーブルが無いページ（返品後の「調査中」など）
    rawStatus = headline.status;
    source = 'headline';
  }

  if (!rawStatus) {
    return {
      status: '取得失敗',
      detail: 'ページからステータスを読み取れませんでした',
      history: [],
      historyCount: 0,
      shipDate,
      deliveredAt: '',
      heldAt: '',
      returnedAt: '',
      attemptedDelivery: false,
      office: office.name,
      officeTel: office.tel,
      source: 'none',
    };
  }

  const detailParts = [];
  if (latestFromHistory && latestFromHistory.datetime) {
    detailParts.push(`${latestFromHistory.datetime} ${latestFromHistory.office}`.trim());
  }
  if (headline.detail) detailParts.push(headline.detail);
  if (extra) detailParts.push(extra);
  if (source === 'headline') detailParts.push('※履歴テーブルなし');

  // 履歴を正規化し、必要な日時を取り出す
  const steps = history.map((h) => ({ ...h, status: normalizeStatus(h.label) }));
  const find = (set) => steps.find((s) => set.includes(s.status));

  const delivered = find(['配達完了']);
  const held = find(['持戻り', '保管中', '長期不在']);
  const returned = find(['返品', '返送', '受取拒否', '受取辞退']);

  // 「保管中」が持ち帰りなのか配達前の一時保管なのかを見分けるための材料。
  // 配達を試みた記録（配達中）があれば持ち帰りとみなす。
  const attemptedDelivery = steps.some((s) => s.status === '配達中');

  const toDT = (dt) => (dt ? toDateTime(dt, shipDate) : '');

  // 履歴が無いページでも「配達完了日　08月19日 18時23分」から拾えることがある
  let deliveredAt = toDT(delivered && delivered.datetime);
  if (!deliveredAt) {
    const m = (extra || '').match(/配達完了日[^0-9]*(\d{1,2}月\d{1,2}日\s*\d{1,2}時\d{1,2}分)/);
    if (m) deliveredAt = toDateTime(m[1], shipDate);
  }

  return {
    status: normalizeStatus(rawStatus),
    rawStatus,
    detail: detailParts.join(' / '),
    history: steps.map((s) => s.status),
    historyDetail: steps,
    historyCount: history.length,
    shipDate,
    deliveredAt,
    heldAt: toDT(held && held.datetime),
    returnedAt: toDT(returned && returned.datetime),
    attemptedDelivery,
    office: office.name,
    officeTel: office.tel,
    source,
  };
}

/**
 * 1件分の配送状況を取得する。
 */
async function fetchStatus(browser, trackingNo) {
  const url = URL_BASE + encodeURIComponent(trackingNo);

  return withPage(browser, async (page) => {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: config.PAGE_TIMEOUT_MS });

    // 佐川のページは JavaScript で描画されるため、描画完了を待つ
    try {
      await page.waitForFunction(
        () => document.body && document.body.innerText.includes('最新荷物状況'),
        { timeout: 15000 }
      );
    } catch (_) {
      // 待てなくても、その時点の本文で判定を試みる
      await page.waitForTimeout(3000);
    }

    const text = await page.evaluate(() => (document.body ? document.body.innerText : ''));

    if (config.DUMP_PAGE_TEXT) {
      logger.info(`[佐川] ページ本文 ${trackingNo}: ${text.substring(0, config.DUMP_LENGTH)}`);
    }

    if (text.includes('JavaScript対応ブラウザ')) {
      return {
        status: '取得失敗',
        detail: 'JavaScript が実行されていません',
        history: [],
        historyCount: 0,
        shipDate: '',
      };
    }

    const parsed = parsePageText(text, trackingNo);
    logger.info(`[佐川] 判定 ${trackingNo} → ${parsed.status}`, {
      rawStatus: parsed.rawStatus,
      source: parsed.source,
      historyCount: parsed.historyCount,
    });
    return parsed;
  });
}

// 佐川はURLに送り状番号を1件ずつ指定する方式のため、まとめ照会はしない
const BATCH_SIZE = 1;

module.exports = {
  NAME,
  BATCH_SIZE,
  fetchStatus,
  parsePageText,
  parseShipDate,
  parseOffice,
  normalizeStatus,
};
