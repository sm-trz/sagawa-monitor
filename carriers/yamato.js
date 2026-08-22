/**
 * carriers/yamato.js
 * ヤマト運輸「荷物お問い合わせシステム」から配送状況を取得する。
 *
 * ── 実ページで確認済みの構造（2026-08 時点）─────────────────────────
 *
 *   （上部：概要）
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
 *   発送済み
 *   08月10日 16:13
 *   埼玉日高営業所（日高中央）
 *   調査中
 *   08月19日 07:50
 *   宜野湾営業所（普天間）
 *   返品                       ← ★ヤマトは「返品」と明示的に表示する
 *   08月20日 14:52
 *   宜野湾営業所（大山）
 *   陸・海上切替え
 *   08月21日 01:58
 *   沖縄ベース
 *
 * ── 重要な注意点 ────────────────────────────────────────────────
 * 1. ステータスと日時は「別の行」にある。
 *    → 「日付とステータスが同じ行にある」前提で探すと1件も見つからない。
 * 2. ページ上部に「お届け完了通知を依頼」というボタンがある。
 *    → 全文から「お届け完了」を探すと、必ずこれに誤ヒットする。
 *      （実際にこれが原因で、返品された荷物を「配達完了」と誤判定した）
 * 3. 履歴の最後が必ずしも意味のあるステータスとは限らない。
 *    実例では「返品」の後に「陸・海上切替え」が記録されていた。
 *    → 履歴全体を見て、返品・返送があれば拾う。
 * 4. 検索結果に表示される送り状番号はハイフン付き（7661-7188-8193）。
 */

const logger = require('../logger');
const config = require('../config');
const { withPage } = require('../browser');

const NAME = 'ヤマト';
const SEARCH_URL = 'https://toi.kuronekoyamato.co.jp/cgi-bin/tneko';

/** 履歴の日時行の形式（例: "08月10日 16:13"） */
const DATETIME_RE = /^\d{1,2}月\d{1,2}日\s+\d{1,2}:\d{2}$/;

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
  { canonical: '輸送中', patterns: ['作業店通過', '中継店通過', '配達店到着', '発送済み', '発送', '輸送中', '陸・海上切替え', '航空搭載'] },
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

function pageHasTrackingNo(text, trackingNo) {
  return trackingNoVariants(trackingNo).some((v) => text.includes(v));
}

/**
 * ページ本文から履歴（3行で1セット）を取り出す。
 * 「ラベル行 → 日時行 → 営業所行」の並びだけを信用する。
 */
function parsePageText(text) {
  const lines = (text || '')
    .split('\n')
    .map((l) => l.replace(/　/g, ' ').trim());

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

async function fetchStatus(browser, trackingNo) {
  return withPage(browser, async (page) => {
    const directUrl = `${SEARCH_URL}?number00=1&number01=${encodeURIComponent(trackingNo)}`;
    await page.goto(directUrl, { waitUntil: 'domcontentloaded', timeout: config.PAGE_TIMEOUT_MS });

    try {
      await page.waitForFunction(
        () => document.body && /\d{1,2}月\d{1,2}日\s+\d{1,2}:\d{2}/.test(document.body.innerText),
        { timeout: 15000 }
      );
    } catch (_) {
      await page.waitForTimeout(3000);
    }

    let text = await page.evaluate(() => (document.body ? document.body.innerText : ''));

    // 結果が出ていない場合は、入力フォームから検索し直す
    if (!pageHasTrackingNo(text, trackingNo)) {
      logger.info(`[ヤマト] 直接URLで結果が出ないためフォーム入力に切り替えます: ${trackingNo}`);
      try {
        await page.goto(SEARCH_URL, { waitUntil: 'domcontentloaded', timeout: config.PAGE_TIMEOUT_MS });
        await page.fill('input[name="number01"]', trackingNo, { timeout: 10000 });
        await page.keyboard.press('Enter');
        await page.waitForTimeout(4000);
        text = await page.evaluate(() => (document.body ? document.body.innerText : ''));
      } catch (e) {
        logger.warn(`[ヤマト] フォーム入力に失敗: ${e.message}`);
      }
    }

    if (config.DUMP_PAGE_TEXT) {
      logger.info(`[ヤマト] ページ本文 ${trackingNo}: ${text.substring(0, config.DUMP_LENGTH)}`);
    }

    if (!pageHasTrackingNo(text, trackingNo)) {
      return { status: '取得失敗', detail: '検索結果に伝票番号が見つかりません', history: [], historyCount: 0 };
    }

    const parsed = parsePageText(text);
    logger.info(`[ヤマト] 判定 ${trackingNo} → ${parsed.status}`, {
      rawStatus: parsed.rawStatus,
      history: parsed.history,
      historyCount: parsed.historyCount,
    });
    return parsed;
  });
}

module.exports = { NAME, fetchStatus, parsePageText, normalizeStatus, trackingNoVariants };
