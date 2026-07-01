/**
 * sagawa-monitor / src/index.js
 * Cloud Run エントリーポイント
 *
 * Cloud Run はレスポンス返却後に CPU を停止するため、
 * すべての処理を HTTP リクエストのスコープ内（await）で完結させる。
 * setImmediate / バックグラウンド実行は使用しない。
 */

require('dotenv').config();
const http = require('http');
const { runMonitor } = require('./monitor');
const logger = require('./logger');

const PORT = process.env.PORT || 8080;

// ── HTTP サーバー（Cloud Run はポートを Listen する必要がある） ──────────────
const server = http.createServer(async (req, res) => {
  // ヘルスチェック: 即時応答
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', timestamp: new Date().toISOString() }));
    return;
  }

  // GET / または POST /run → 監視処理をリクエスト内で完結させてからレスポンスを返す
  if (
    (req.method === 'GET'  && req.url === '/') ||
    (req.method === 'POST' && req.url === '/run')
  ) {
    try {
      const result = await runMonitor();
      logger.info('監視処理が正常に完了しました');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', result }));
    } catch (err) {
      logger.error('監視処理でエラーが発生しました', { error: err.message, stack: err.stack });
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'error', message: err.message }));
    }
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not Found' }));
});

server.listen(PORT, () => {
  logger.info(`サーバー起動: port=${PORT}`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  logger.info('SIGTERM を受信しました。サーバーを停止します');
  server.close(() => process.exit(0));
});
