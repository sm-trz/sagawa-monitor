/**
 * sagawa-monitor / src/monitor.js
 * メイン監視ロジック
 * スプレッドシートの読み取り → 佐川サイトのスクレイピング → 結果書き戻し
 */

const { fetchTrackingRows, updateRow, markAsNotified } = require('./sheets');
const { fetchAllStatuses } = require('./sagawa');
const logger = require('./logger');

/**
 * 現在の日本時間を "YYYY/MM/DD HH:mm:ss" 形式で返す
 */
function nowJST() {
  return new Date().toLocaleString('ja-JP', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

/**
 * 監視処理のメイン関数
 * index.js から呼び出される
 */
async function runMonitor() {
  const startTime = Date.now();
  logger.info('====== 監視処理開始 ======');

  // ── 1. スプレッドシートから伝票番号一覧を取得 ──────────────────────────────
  let rows;
  try {
    rows = await fetchTrackingRows();
  } catch (err) {
    logger.error('スプレッドシートの読み取りに失敗しました', { error: err.message });
    throw err;
  }

  if (rows.length === 0) {
    logger.info('処理対象の伝票番号がありませんでした。処理を終了します');
    return;
  }

  // ── 2. 佐川サイトから配送状況を一括取得 ────────────────────────────────────
  let statusResults;
  try {
    statusResults = await fetchAllStatuses(rows);
  } catch (err) {
    logger.error('配送状況の取得に失敗しました', { error: err.message });
    throw err;
  }

  // ── 3. 結果をスプレッドシートへ書き戻し ────────────────────────────────────
  const checkedAt = nowJST();
  let successCount = 0;
  let errorCount = 0;
  const returnCandidates = [];

  // trackingNo をキーにしてルックアップできるよう Map 化
  const resultMap = new Map(statusResults.map((r) => [r.trackingNo, r]));

  for (const row of rows) {
    const result = resultMap.get(row.trackingNo);
    if (!result) {
      logger.warn(`伝票 ${row.trackingNo} の結果が見つかりません（スキップ）`);
      errorCount++;
      continue;
    }

    try {
      await updateRow(row.rowIndex, {
        status: result.status,
        checkedAt,
        isReturn: result.isReturn,
      });

      // 返品候補になった行を記録（通知処理用）
      if (result.isReturn && row.notified !== 'TRUE') {
        returnCandidates.push({ ...row, status: result.status });

        // 通知済みフラグを立てる（今回は G 列を TRUE にするだけ）
        await markAsNotified(row.rowIndex);
        logger.info(`返品候補として通知済みにしました: 行=${row.rowIndex}, 注文番号=${row.orderNo}`);
      }

      successCount++;
    } catch (err) {
      logger.error(`行 ${row.rowIndex} の更新に失敗`, { error: err.message, trackingNo: row.trackingNo });
      errorCount++;
    }
  }

  // ── 4. サマリーログ ──────────────────────────────────────────────────────────
  const elapsedSec = ((Date.now() - startTime) / 1000).toFixed(1);
  logger.info('====== 監視処理完了 ======', {
    total: rows.length,
    success: successCount,
    error: errorCount,
    returnCandidates: returnCandidates.length,
    elapsedSec,
  });

  if (returnCandidates.length > 0) {
    logger.warn('返品候補が検出されました', {
      items: returnCandidates.map((r) => ({
        rowIndex: r.rowIndex,
        orderNo: r.orderNo,
        trackingNo: r.trackingNo,
        status: r.status,
      })),
    });
  }

  return {
    total: rows.length,
    success: successCount,
    error: errorCount,
    returnCandidates,
  };
}

module.exports = { runMonitor };
