/**
 * carriers/yamato.js
 * ヤマト運輸「荷物問い合わせ」から配送状況を取得する。
 *
 * ⚠️ 重要 ⚠️
 * 佐川と違い、実際のページ本文をまだ1件も確認できていません。
 * そのため初回は「ページ本文をログに出す」ことを最優先にしています。
 * ログで実際の表示を確認したあと、判定ロジックを確定させます。
 *
 * それまでの間、環境変数 YAMATO_STATUS_JUDGE が 'on' でない限り、
 * ヤマトのステータス文言では返品判定を行いません
 * （発送からの経過日数による「滞留検知」だけが働きます）。
 * これは、間違った文言で誤検知することを防ぐための安全装置です。
 */

const logger = require('../logger');
const config = require('../config');
const { withPage } = require('../browser');

const NAME = 'ヤマト';
const SEARCH_URL = 'https://toi.kuronekoyamato.co.jp/cgi-bin/tneko';

/** ヤマト運輸で使われる荷物状況の文言（公表されている一般的な表記） */
const NORMALIZE = [
  { canonical: '配達完了', patterns: ['配達完了', 'お届け完了', '投函完了'] },
  { canonical: '配達中', patterns: ['配達中', 'お届けにあがっています'] },
  { canonical: '輸送中', patterns: ['作業店通過', '配達店到着', '輸送中', '発送'] },
  { canonical: '荷物受付', patterns: ['荷物受付', '伝票番号発行'] },
  { canonical: '保管中', patterns: ['保管', 'センター保管'] },
  { canonical: '調査中', patterns: ['調査中'] },
  { canonical: '持戻り', patterns: ['持戻り', '持ち戻り', 'ご不在', '不在'] },
  { canonical: '長期不在', patterns: ['長期不在'] },
  { canonical: '受取辞退', patterns: ['受取辞退', '受け取り辞退'] },
  { canonical: '受取拒否', patterns: ['受取拒否', '受け取り拒否'] },
  { canonical: '返送', patterns: ['返送', '転送・返送'] },
  { canonical: '返品', patterns: ['返品'] },
];

const STATUS_WORDS = NORMALIZE.flatMap((n) => n.patterns);

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

/**
 * ページ本文から、日付を含みステータス文言を含む行を集め、
 * 最後の1行（＝最新）を採用する。
 * ヤマトの履歴は上から古い順に並ぶのが一般的なため。
 */
function parsePageText(text) {
  const lines = (text || '')
    .split('\n')
    .map((l) => l.replace(/　/g, ' ').trim())
    .filter(Boolean);

  const candidates = [];
  for (const line of lines) {
    const hasDate = /\d{1,2}\s*[\/月]\s*\d{1,2}/.test(line);
    const word = STATUS_WORDS.find((w) => line.includes(w));
    if (hasDate && word) candidates.push({ line, word });
  }

  if (candidates.length === 0) {
    // 日付付きの行が見つからない場合、ステータス文言だけでも拾ってみる
    const only = lines.find((l) => STATUS_WORDS.some((w) => l.includes(w)));
    if (!only) {
      return { status: '取得失敗', detail: 'ページからステータスを読み取れませんでした', historyCount: 0 };
    }
    return { status: normalizeStatus(only), rawStatus: only, detail: only, historyCount: 0 };
  }

  const latest = candidates[candidates.length - 1];
  return {
    status: normalizeStatus(latest.word),
    rawStatus: latest.line,
    detail: latest.line,
    historyCount: candidates.length,
  };
}

async function fetchStatus(browser, trackingNo) {
  return withPage(browser, async (page) => {
    // まずは検索結果ページを直接開いてみる
    const directUrl = `${SEARCH_URL}?number00=1&number01=${encodeURIComponent(trackingNo)}`;
    await page.goto(directUrl, { waitUntil: 'domcontentloaded', timeout: config.PAGE_TIMEOUT_MS });
    await page.waitForTimeout(3000);

    let text = await page.evaluate(() => (document.body ? document.body.innerText : ''));

    // 伝票番号がページに出ていない場合は、入力フォームから検索し直す
    if (!text.includes(trackingNo)) {
      logger.info(`[ヤマト] 直接URLで結果が出ないためフォーム入力に切り替えます: ${trackingNo}`);
      try {
        await page.goto(SEARCH_URL, { waitUntil: 'domcontentloaded', timeout: config.PAGE_TIMEOUT_MS });
        await page.fill('input[name="number01"]', trackingNo, { timeout: 10000 });
        await Promise.all([
          page.waitForLoadState('domcontentloaded'),
          page.keyboard.press('Enter'),
        ]);
        await page.waitForTimeout(3000);
        text = await page.evaluate(() => (document.body ? document.body.innerText : ''));
      } catch (e) {
        logger.warn(`[ヤマト] フォーム入力に失敗: ${e.message}`);
      }
    }

    // ★初回はここが最重要。実際の表示をログに残す。
    if (config.DUMP_PAGE_TEXT) {
      logger.info(`[ヤマト] ページ本文 ${trackingNo}: ${text.substring(0, config.DUMP_LENGTH)}`);
    }

    const parsed = parsePageText(text);
    logger.info(`[ヤマト] 判定 ${trackingNo} → ${parsed.status}`, {
      rawStatus: parsed.rawStatus,
      historyCount: parsed.historyCount,
      judgeEnabled: config.YAMATO_STATUS_JUDGE,
    });
    return parsed;
  });
}

module.exports = { NAME, fetchStatus, parsePageText, normalizeStatus };
