/**
 * sagawa-monitor / src/index.js
 * Cloud Run エントリーポイント
 * - HTTP リクエストを受けて即時実行（Cloud Scheduler → Cloud Run）
 * - 環境変数 RUN_ON_STARTUP=true の場合は起動直後に実行
 */

require('dotenv').config();
const http = require('http');
const { runMonitor } = require('./monitor');
const logger = require('./logger');

const PORT = process.env.PORT || 8080;

// ── HTTP サーバー（Cloud Run はポートを Listen する必要がある） ──────────────
const server = http.createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', timestamp: new Date().toISOString() }));
    return;
  }

  if (req.method === 'POST' && req.url === '/run') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'accepted', message: '監視処理を開始しました' }));

    // レスポンス返却後に非同期で実行
    setImmediate(async () => {
      try {
        await runMonitor();
        logger.info('監視処理が正常に完了しました');
      } catch (err) {
        logger.error('監視処理でエラーが発生しました', { error: err.message, stack: err.stack });
      }
    });
    return;
  }

  // GET / → 手動トリガー（Cloud Scheduler は GET も使う場合あり）
  if (req.method === 'GET' && req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'accepted', message: '監視処理を開始しました' }));

    setImmediate(async () => {
      try {
        await runMonitor();
        logger.info('監視処理が正常に完了しました');
      } catch (err) {
        logger.error('監視処理でエラーが発生しました', { error: err.message, stack: err.stack });
      }
    });
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not Found' }));
});

server.listen(PORT, () => {
  logger.info(`サーバー起動: port=${PORT}`);

  // 起動直後に実行するオプション
  if (process.env.RUN_ON_STARTUP === 'true') {
    logger.info('RUN_ON_STARTUP=true のため起動直後に監視処理を実行します');
    runMonitor()
      .then(() => logger.info('起動時監視処理が完了しました'))
      .catch((err) => logger.error('起動時監視処理でエラー', { error: err.message }));
  }
});

// Graceful shutdown
process.on('SIGTERM', () => {
  logger.info('SIGTERM を受信しました。サーバーを停止します');
  server.close(() => {
    logger.info('サーバーを停止しました');
    process.exit(0);
  });
});
