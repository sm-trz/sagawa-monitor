/**
 * sagawa-monitor / src/sagawa.js
 * Playwright で佐川急便の荷物問い合わせページをスクレイピングする
 *
 * Cloud Run 安定化のための対応:
 *   - --single-process / --disable-gpu を削除（GPU プロセス通信エラーの原因）
 *   - ブラウザは実行全体で1インスタンスのみ起動
 *   - 伝票ごとに newContext() → newPage() → close() を try/finally で確実に実施
 *   - ブラウザが死んでいたら再起動して最大1回リトライ
 *   - 1件失敗しても次の伝票へ進む
 */

const { chromium } = require('playwright');
const logger = require('./logger');

// ── ステータス定義 ──────────────────────────────────────────────────────────
const STATUS_KEYWORDS = [
  { label: '受取拒否', keywords: ['受取拒否'] },
  { label: '受取辞退', keywords: ['受取辞退'] },
  { label: '返送',     keywords: ['返送'] },
  { label: '返品',     keywords: ['返品'] },
  { label: '長期不在', keywords: ['長期不在', '長期間不在'] },
  { label: '持戻り',   keywords: ['持戻り', '持ち戻り', '不在持戻'] },
  { label: '保管中',   keywords: ['保管中', '営業所保管'] },
  { label: '配達完了', keywords: ['配達完了', 'お届け済み', '配達済'] },
  { label: '配達中',   keywords: ['配達中', 'お届け中'] },
  { label: '輸送中',   keywords: ['輸送中', '幹線輸送中', '配達店到着'] },
  { label: '集荷',     keywords: ['集荷'] },
];

const RETURN_STATUSES = new Set(['受取拒否', '受取辞退', '返送', '返品', '長期不在', '持戻り']);

function classifyStatus(rawText) {
  if (!rawText) return '不明';
  for (const { label, keywords } of STATUS_KEYWORDS) {
    for (const kw of keywords) {
      if (rawText.includes(kw)) return label;
    }
  }
  return '不明';
}

function isReturnStatus(status) {
  return RETURN_STATUSES.has(status);
}

// ── Chromium 起動オプション ─────────────────────────────────────────────────
// --single-process : GPU コマンドバッファ通信エラー（signal 5）の原因になるため削除
// --disable-gpu    : GPU プロセス自体を無効化すると逆に IPC エラーが起きるため削除
//                    代わりに --disable-software-rasterizer で GPU 描画をスキップ
const CHROMIUM_ARGS = [
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-dev-shm-usage',       // /dev/shm が小さい Cloud Run 環境対策
  '--disable-software-rasterizer', // ソフトウェア GPU レンダラを無効化（GPU プロセスは立てない）
  '--no-first-run',
  '--no-zygote',                   // zygote プロセスを使わない（コンテナ環境向け）
  '--disable-extensions',
  '--disable-background-networking',
  '--disable-default-apps',
  '--mute-audio',
];

// ── ブラウザ起動ヘルパー ────────────────────────────────────────────────────
async function launchBrowser() {
  const browser = await chromium.launch({ headless: true, args: CHROMIUM_ARGS });
  logger.info('Chromium を起動しました');
  return browser;
}

/**
 * ブラウザが生きているか確認する
 * connected() が false ならクラッシュ済みと判断
 */
function isBrowserAlive(browser) {
  try {
    return browser.isConnected();
  } catch (_) {
    return false;
  }
}

// ── 1件スクレイピング ───────────────────────────────────────────────────────
/**
 * 佐川急便の荷物問い合わせページから配送状況を取得する
 * context / page は呼び出し側で管理せず、この関数内で完結させる
 *
 * @param {string} trackingNo
 * @param {import('playwright').Browser} browser
 * @returns {{ status: string, isReturn: boolean }}
 */
async function fetchDeliveryStatus(trackingNo, browser) {
  const url = `https://k2k.sagawa-exp.co.jp/p/web/okurijosearch.do?okurijoNo=${encodeURIComponent(trackingNo)}`;
  logger.info(`配送状況を取得中: ${trackingNo}`);

  // context・page を確実に close するため変数を外で宣言
  let context = null;
  let page    = null;

  try {
    context = await browser.newContext({
      userAgent:  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      locale:     'ja-JP',
      timezoneId: 'Asia/Tokyo',
    });

    page = await context.newPage();

    await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
    await page.waitForTimeout(2000);

    // ステータステキストの抽出（複数セレクタを試みる）
    let rawText = '';
    const tableSelectors = [
      '.tbl-okurijyoSearch',
      '.wr-okurijyo',
      '#result',
      '.resultArea',
      'table',
    ];

    for (const selector of tableSelectors) {
      try {
        const el = await page.$(selector);
        if (el) {
          const t = await el.innerText();
          if (t && t.trim().length > 0) {
            rawText = t;
            logger.debug(`セレクタ "${selector}" でテキストを取得`, { preview: rawText.slice(0, 200) });
            break;
          }
        }
      } catch (_) { /* 次のセレクタを試す */ }
    }

    // フォールバック: ページ全体テキスト
    if (!rawText || rawText.trim().length === 0) {
      rawText = await page.evaluate(() => document.body.innerText);
      logger.debug('フォールバック: ページ全体テキストを使用');
    }

    // 伝票不明判定
    if (
      rawText.includes('お問い合わせ番号が見つかりません') ||
      rawText.includes('該当する荷物が見つかりません') ||
      rawText.includes('No data')
    ) {
      logger.warn(`伝票番号 ${trackingNo} が見つかりませんでした`);
      return { status: '伝票不明', isReturn: false };
    }

    const status   = classifyStatus(rawText);
    const isReturn = isReturnStatus(status);
    logger.info(`ステータス判定完了: ${trackingNo} → ${status}`, { isReturn });
    return { status, isReturn };

  } finally {
    // page → context の順で確実に close（エラーが出ても飲み込む）
    if (page) {
      try { await page.close(); } catch (e) {
        logger.debug(`page.close() エラー（無視）: ${e.message}`);
      }
    }
    if (context) {
      try { await context.close(); } catch (e) {
        logger.debug(`context.close() エラー（無視）: ${e.message}`);
      }
    }
  }
}

// ── 全件一括取得 ────────────────────────────────────────────────────────────
/**
 * @param {Array<{ trackingNo: string }>} rows
 * @returns {Array<{ trackingNo: string, status: string, isReturn: boolean }>}
 */
async function fetchAllStatuses(rows) {
  if (rows.length === 0) return [];

  let browser = await launchBrowser();
  const results = [];

  try {
    for (const row of rows) {
      // ブラウザが死んでいたら再起動（1件目クラッシュからの復旧）
      if (!isBrowserAlive(browser)) {
        logger.warn('ブラウザがクラッシュしています。再起動します');
        try { await browser.close(); } catch (_) {}
        browser = await launchBrowser();
      }

      try {
        const result = await fetchDeliveryStatus(row.trackingNo, browser);
        results.push({ trackingNo: row.trackingNo, ...result });
      } catch (err) {
        // 1件失敗しても次の伝票へ進む
        logger.error(`伝票 ${row.trackingNo} の処理中にエラー（スキップ）`, { error: err.message });
        results.push({ trackingNo: row.trackingNo, status: 'エラー', isReturn: false });
      }

      // 連続アクセスによるブロック回避
      if (row !== rows[rows.length - 1]) {
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
  } finally {
    try {
      await browser.close();
      logger.info('ブラウザを閉じました');
    } catch (e) {
      logger.warn(`browser.close() エラー（無視）: ${e.message}`);
    }
  }

  return results;
}

module.exports = { fetchAllStatuses, classifyStatus, isReturnStatus };
