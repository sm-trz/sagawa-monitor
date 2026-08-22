/**
 * monitor.js
 * 監視処理の全体の流れ。
 *
 *   シート読み取り
 *     → 照会が必要な行だけに絞り込み
 *     → 配送会社ごとにページを取得
 *     → 返品候補かどうかを判定
 *     → シートへまとめて書き戻し
 */

const config = require('./config');
const logger = require('./logger');
const sheets = require('./sheets');
const judgeModule = require('./judge');
const { launchBrowser, closeBrowser, isAlive } = require('./browser');
const { normalizeCarrierName, getCarrier, supportedNames } = require('./carriers');

const { judge, isTooOld, FINISHED_STATUSES, FLAG_NONE } = judgeModule;

function nowJST() {
  return new Date().toLocaleString('ja-JP', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 照会が必要な行だけを選ぶ。
 * ここが「配達完了は監視終了」「古すぎるものは打ち切り」の実装。
 */
function selectTargets(rows) {
  const targets = [];
  const skipped = { finished: 0, tooOld: 0, noCarrier: 0 };
  const carrierErrors = [];

  for (const row of rows) {
    if (FINISHED_STATUSES.has(row.status)) { skipped.finished++; continue; }
    if (isTooOld(row.shipDate)) { skipped.tooOld++; continue; }

    const carrierName = normalizeCarrierName(row.carrierRaw);
    if (!carrierName) {
      skipped.noCarrier++;
      carrierErrors.push({
        rowIndex: row.rowIndex,
        status: '配送会社が未指定',
        checkedAt: nowJST(),
        returnFlag: FLAG_NONE,
        notified: row.notified,
        note: `B列に ${supportedNames().join(' または ')} と入力してください`,
      });
      continue;
    }
    targets.push({ ...row, carrierName });
  }

  return { targets, skipped, carrierErrors };
}

async function runMonitor() {
  const startedAt = Date.now();
  logger.info('====== 監視処理開始 ======', {
    staleDays: config.STALE_DAYS,
    maxMonitorDays: config.MAX_MONITOR_DAYS,
    maxPerRun: config.MAX_PER_RUN,
    yamatoStatusJudge: config.YAMATO_STATUS_JUDGE,
  });

  // ── 1. シートを読む ──────────────────────────────────────
  await sheets.checkHeader();
  const rows = await sheets.fetchRows();

  const { targets, skipped, carrierErrors } = selectTargets(rows);
  logger.info('照会対象を絞り込みました', {
    シート内の伝票: rows.length,
    照会対象: targets.length,
    配達完了で除外: skipped.finished,
    期限切れで除外: skipped.tooOld,
    配送会社未指定: skipped.noCarrier,
  });

  const limited = targets.slice(0, config.MAX_PER_RUN);
  if (targets.length > limited.length) {
    logger.warn(
      `照会対象が上限を超えたため ${targets.length - limited.length} 件を次回にまわします`,
      { maxPerRun: config.MAX_PER_RUN }
    );
  }

  const checkedAt = nowJST();
  const updates = [...carrierErrors];
  const flagged = [];
  let successCount = 0;
  let errorCount = 0;

  // ── 2. 配送会社サイトを照会 ──────────────────────────────
  // 配送会社ごとにまとめる。ヤマトは1回の検索で最大10件を照会できるため、
  // まとめられる会社はまとめて取得してアクセス回数と時間を減らす。
  const resultsByRow = new Map();

  if (limited.length > 0) {
    const groups = new Map();
    for (const row of limited) {
      if (!groups.has(row.carrierName)) groups.set(row.carrierName, []);
      groups.get(row.carrierName).push(row);
    }

    let browser = await launchBrowser();
    try {
      for (const [carrierName, carrierRows] of groups) {
        const carrier = getCarrier(carrierName);
        const canBatch = carrier.BATCH_SIZE > 1 && typeof carrier.fetchStatusBatch === 'function';
        const chunkSize = canBatch ? carrier.BATCH_SIZE : 1;

        logger.info(`[${carrierName}] ${carrierRows.length} 件を照会します`, {
          まとめ照会: canBatch ? `${chunkSize}件ずつ` : 'なし（1件ずつ）',
        });

        for (let i = 0; i < carrierRows.length; i += chunkSize) {
          const chunk = carrierRows.slice(i, i + chunkSize);

          if (!isAlive(browser)) {
            logger.warn('Chromium が落ちていたため再起動します');
            try { await closeBrowser(browser); } catch (_) { /* 無視 */ }
            browser = await launchBrowser();
          }

          let map;
          try {
            if (canBatch) {
              map = await carrier.fetchStatusBatch(browser, chunk.map((r) => r.trackingNo));
            } else {
              const one = await carrier.fetchStatus(browser, chunk[0].trackingNo);
              map = new Map([[chunk[0].trackingNo, one]]);
            }
          } catch (err) {
            logger.error(`[${carrierName}] 照会に失敗しました`, {
              error: err.message,
              trackingNos: chunk.map((r) => r.trackingNo),
            });
            map = new Map();
          }

          for (const row of chunk) {
            const result = map.get(row.trackingNo);
            if (result && result.status !== '取得失敗') {
              successCount++;
              resultsByRow.set(row.rowIndex, result);
            } else {
              errorCount++;
              resultsByRow.set(
                row.rowIndex,
                result || { status: '取得失敗', detail: '結果が返りませんでした', history: [] }
              );
            }
          }

          if (i + chunkSize < carrierRows.length) await sleep(config.REQUEST_INTERVAL_MS);
        }
      }
    } finally {
      await closeBrowser(browser);
    }
  }

  // ── 3. 返品候補かどうかを判定 ────────────────────────────
  for (const row of limited) {
    const result =
      resultsByRow.get(row.rowIndex) ||
      { status: '取得失敗', detail: '照会されませんでした', history: [] };

    // ヤマトの文言判定を止めたいときは YAMATO_STATUS_JUDGE=off にする
    const trustStatus = row.carrierName !== 'ヤマト' || config.YAMATO_STATUS_JUDGE;

    const verdict = judge({
      status: result.status,
      history: result.history || [],
      shipDate: row.shipDate,
      trustStatus,
    });

    const noteParts = [];
    if (result.detail) noteParts.push(result.detail);
    if (verdict.notes.length) noteParts.push(...verdict.notes);

    // 一度立った通知済フラグは消さない（同じ荷物で何度も通知しないため）
    const alreadyNotified = row.notified === 'TRUE';
    const notified = verdict.flag && !alreadyNotified ? 'TRUE' : row.notified;

    const displayStatus = verdict.effectiveStatus || result.status;

    updates.push({
      rowIndex: row.rowIndex,
      status: displayStatus,
      checkedAt,
      returnFlag: verdict.flag,
      notified,
      note: noteParts.join(' / ').substring(0, 480),
    });

    if (verdict.flag && !alreadyNotified) {
      flagged.push({
        rowIndex: row.rowIndex,
        orderNo: row.orderNo,
        carrier: row.carrierName,
        trackingNo: row.trackingNo,
        status: displayStatus,
        flag: verdict.flag,
        note: noteParts.join(' / '),
      });
    }
  }

  // ── 4. シートへまとめて書き戻し ──────────────────────────
  await sheets.writeRows(updates);

  // ── 5. まとめ ────────────────────────────────────────────
  const elapsedSec = ((Date.now() - startedAt) / 1000).toFixed(1);
  const summary = {
    シート内の伝票: rows.length,
    照会した件数: limited.length,
    成功: successCount,
    失敗: errorCount,
    新たに検知: flagged.length,
    配達完了で除外: skipped.finished,
    期限切れで除外: skipped.tooOld,
    配送会社未指定: skipped.noCarrier,
    所要秒数: Number(elapsedSec),
  };
  logger.info('====== 監視処理完了 ======', summary);

  if (flagged.length > 0) {
    logger.warn('★返品候補を検知しました★', { items: flagged });
  }

  return { ...summary, detected: flagged };
}

module.exports = { runMonitor, selectTargets };
