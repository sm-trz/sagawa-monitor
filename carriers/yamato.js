/**
 * carriers/yamato.js
 * ヤマト運輸「荷物お問い合わせシステム」から配送状況を取得する。
 *
 * ── 実ページで確認済みの構造（2026-08 時点）─────────────────────────
 *
 *   （上部：一覧）
 *   日付
 *   配送状況
 *   08/21
 *   陸・海上切替え
 *   ...
 *   詳細確認／日時・場所変更
 *   お届け完了通知を依頼      ← ★ボタンのラベル。ステータスではない！
 *   商品名：
 *   ネコポス
 *   お届け予定日時：
 *   -
 *   （ここから履歴。3行で1セット）
 *   荷物受付
 *   08月10日 16:13
 *   埼玉日高営業所（日高中央）
 *   ...
 *   返品                       ← ★ヤマトは「返品」と明示的に表示する
 *   08月20日 14:52
 *   宜野湾営業所（大山）
 *   陸・海上切替え             ← ★返品の"後"にも記録が続く
 *   08月21日 01:58
 *   沖縄ベース
 *
 * ── 重要な注意点 ────────────────────────────────────────────────
 * 1. ステータスと日時は「別の行」にある。
 *    → 「日付とステータスが同じ行にある」前提で探すと1件も見つからない。
 * 2. ページ上部に「お届け完了通知を依頼」というボタンがある。
 *    → 全文から「お届け完了」を探すと必ずこれに誤ヒットする。
 *      （実際にこれが原因で、返品された荷物を「配達完了」と誤判定した）
 * 3. 履歴の最後が意味のあるステータスとは限らない（上記の例を参照）。
 *    → 履歴全体を judge.js へ渡して判定する。
 * 4. 検索結果の送り状番号はハイフン付き（7661-7188-8193）。
 * 5. GET で直接 URL を開いても結果が出ない。必ずフォームに入力して検索する。
 *    （直接URLを試すと18秒のタイムアウトを毎回捨てることになる）
 * 6. 検索フォームは送り状番号を複数入力できる。
 *    結果は「1件目：」「2件目：」…で区切られる。
 *    → まとめて照会することで、アクセス回数と所要時間を大幅に減らせる。
 */

const logger = require('../logger');
const config = require('../config');
const { withPage } = require('../browser');

const NAME = 'ヤマト';
const SEARCH_URL = 'https://toi.kuronekoyamato.co.jp/cgi-bin/tneko';

/** 1回の検索でまとめて照会する件数（ヤマトのフォームは最大10件） */
const BATCH_SIZE = Math.max(1, Math.min(10, config.YAMATO_BATCH_SIZE));

/** 履歴の日時行の形式（例: "08月10日 16:13"） */
const DATETIME_RE = /^\d{1,2}月\d{1,2}日\s+\d{1,2}:\d{2}$/;

/** 「1件目：7661-7188-8193」の行 */
const ITEM_HEAD_RE = /^(\d+)\s*件目\s*[：:]\s*([\d-]+)/;

/** ヤマトの表記を、社内で使う正式名称にそろえる */
const NORMALIZE = [
  { canonical: '返品', patterns: ['返品'] },
  { canonical: '返送', patterns: ['返送', '転送・返送'] },
  { canonical: '受取拒否', patterns: ['受取拒否', '受け取り拒否'] },
  { canonical: '受取辞退', patterns: ['受取辞退', '受け取り辞退'] },
  { canonical: '長期不在', patterns: ['長期不在'] },
  { canonical: '持戻り', patterns: ['持戻り', '持ち戻り', 'ご不在'] },
  { canonical: '調査中', patterns: ['調査中'] },
  { canonical: '保管中', patterns: ['保管'] },
  { canonical: '配達完了', patterns: ['配達完了', '投函完了', 'お届け完了'] },
  { canonical: '配達中', patterns: ['配達中', 'お届けにあがっています'] },
  {
    canonical: '輸送中',
    patterns: ['作業店通過', '中継店通過', '配達店到着', '発送済み', '発送', '輸送中', '陸・海上切替え', '航空搭載'],
  },
  { canonical: '荷物受付', patterns: ['荷物受付', '伝票番号発行'] },
];

function normalizeStatus(raw) {
  const text = String(raw || '').trim();
  if (!text) return '';
  for (const { canonical, patterns } of NORMALIZE) {
    for (const p of patterns) {
      if (text.includes(p)) return canonical;
    }
  }
  return text;
}

/** 766171888193 → ["766171888193", "7661-7188-8193"] */
function trackingNoVariants(trackingNo) {
  const plain = String(trackingNo || '');
  const hyphenated = plain.replace(/^(\d{4})(\d{4})(\d{4})$/, '$1-$2-$3');
  return hyphenated === plain ? [plain] : [plain, hyphenated];
}

/**
 * 検索結果を「N件目：」ごとのかたまりに分割する。
 * @returns {Array<{trackingNo:string, text:string}>}
 */
function splitByItem(text) {
  const lines = (text || '').split('\n');
  const blocks = [];
  let current = null;

  for (const line of lines) {
    const m = line.trim().match(ITEM_HEAD_RE);
    if (m) {
      current = { trackingNo: m[2].replace(/[^0-9]/g, ''), lines: [] };
      blocks.push(current);
      continue;
    }
    if (current) current.lines.push(line);
  }

  return blocks.map((b) => ({ trackingNo: b.trackingNo, text: b.lines.join('\n') }));
}

/**
 * 1件分のかたまりから履歴を取り出す。
 * 「ラベル行 → 日時行 → 営業所行」の並びだけを信用する。
 */
function parsePageText(text) {
  const lines = (text || '').split('\n').map((l) => l.replace(/　/g, ' ').trim());

  const history = [];
  for (let i = 1; i < lines.length; i++) {
    if (!DATETIME_RE.test(lines[i])) continue;

    const label = lines[i - 1];
    // ラベルは短い単語。長い文章はボタンや説明文なので除外する。
    if (!label || label.length > 16) continue;

    history.push({
      label,
      status: normalizeStatus(label),
      datetime: lines[i],
      office: (lines[i + 1] || '').trim(),
    });
  }

  if (history.length === 0) {
    return {
      status: '取得失敗',
      detail: 'ページから履歴を読み取れませんでした',
      history: [],
      historyCount: 0,
    };
  }

  const latest = history[history.length - 1];
  return {
    status: latest.status,
    rawStatus: latest.label,
    detail: `${latest.datetime} ${latest.office}`.trim(),
    history: history.map((h) => h.status),
    historyDetail: history,
    historyCount: history.length,
  };
}

/**
 * 検索フォームに送り状番号を入力して検索する。
 * @returns {{text:string, filled:string[]}} 取得した本文と、実際に入力できた番号
 */
async function runSearch(page, trackingNos) {
  await page.goto(SEARCH_URL, { waitUntil: 'domcontentloaded', timeout: config.PAGE_TIMEOUT_MS });
  await page.waitForSelector('input[name="number01"]', { timeout: 15000 });

  // フォームにある number01, number02 ... を番号順に取得する
  const fieldNames = await page.$$eval('input[name]', (els) =>
    els
      .map((e) => e.name)
      .filter((n) => /^number\d+$/.test(n) && n !== 'number00')
  );
  const uniqueSorted = [...new Set(fieldNames)].sort();

  const filled = [];
  for (let i = 0; i < trackingNos.length && i < uniqueSorted.length; i++) {
    try {
      await page.fill(`input[name="${uniqueSorted[i]}"]`, trackingNos[i], { timeout: 5000 });
      filled.push(trackingNos[i]);
    } catch (e) {
      logger.warn(`[ヤマト] ${uniqueSorted[i]} に入力できませんでした: ${e.message}`);
      break;
    }
  }

  if (filled.length === 0) {
    return { text: '', filled: [] };
  }

  await page.keyboard.press('Enter');

  // 履歴の日時が表示されるまで待つ
  try {
    await page.waitForFunction(
      () => document.body && /\d{1,2}月\d{1,2}日\s+\d{1,2}:\d{2}/.test(document.body.innerText),
      { timeout: 20000 }
    );
  } catch (_) {
    await page.waitForTimeout(3000);
  }

  const text = await page.evaluate(() => (document.body ? document.body.innerText : ''));
  return { text, filled };
}

const NOT_FOUND = {
  status: '取得失敗',
  detail: '検索結果に伝票番号が見つかりません',
  history: [],
  historyCount: 0,
};

/**
 * 1件だけ照会する（まとめ照会が失敗したときの保険にも使う）。
 */
async function fetchStatus(browser, trackingNo) {
  return withPage(browser, async (page) => {
    const { text, filled } = await runSearch(page, [trackingNo]);
    if (filled.length === 0) return { ...NOT_FOUND, detail: '検索フォームに入力できませんでした' };

    if (config.DUMP_PAGE_TEXT) {
      logger.info(`[ヤマト] ページ本文 ${trackingNo}: ${text.substring(0, config.DUMP_LENGTH)}`);
    }

    const blocks = splitByItem(text);
    const block = blocks.find((b) => b.trackingNo === trackingNo);
    if (!block) return NOT_FOUND;

    const parsed = parsePageText(block.text);
    logger.info(`[ヤマト] 判定 ${trackingNo} → ${parsed.status}`, {
      rawStatus: parsed.rawStatus,
      history: parsed.history,
    });
    return parsed;
  });
}

/**
 * 最大 BATCH_SIZE 件をまとめて照会する。
 * @returns {Promise<Map<string, object>>} 伝票番号 → 判定結果
 */
async function fetchStatusBatch(browser, trackingNos) {
  const results = new Map();
  if (!trackingNos || trackingNos.length === 0) return results;

  const { text, filled } = await withPage(browser, (page) => runSearch(page, trackingNos));

  if (config.DUMP_PAGE_TEXT) {
    logger.info(
      `[ヤマト] まとめ照会 ${filled.length}件 のページ本文: ${text.substring(0, config.DUMP_LENGTH)}`
    );
  }

  const blocks = splitByItem(text);
  for (const block of blocks) {
    const parsed = parsePageText(block.text);
    results.set(block.trackingNo, parsed);
    logger.info(`[ヤマト] 判定 ${block.trackingNo} → ${parsed.status}`, {
      rawStatus: parsed.rawStatus,
      history: parsed.history,
    });
  }

  // まとめ照会で拾えなかった番号は、1件ずつ取り直す（保険）
  const missing = trackingNos.filter((no) => !results.has(no));
  if (missing.length > 0) {
    logger.warn(
      `[ヤマト] まとめ照会で ${missing.length} 件が取得できませんでした。1件ずつ取り直します`,
      { missing, requested: trackingNos.length, parsed: blocks.length }
    );
    for (const no of missing) {
      try {
        results.set(no, await fetchStatus(browser, no));
      } catch (e) {
        logger.error(`[ヤマト] ${no} の再取得に失敗: ${e.message}`);
        results.set(no, { ...NOT_FOUND, detail: e.message });
      }
      await new Promise((r) => setTimeout(r, config.REQUEST_INTERVAL_MS));
    }
  }

  return results;
}

module.exports = {
  NAME,
  BATCH_SIZE,
  fetchStatus,
  fetchStatusBatch,
  parsePageText,
  splitByItem,
  normalizeStatus,
  trackingNoVariants,
};
