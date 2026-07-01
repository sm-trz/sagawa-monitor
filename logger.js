/**
 * sagawa-monitor / src/logger.js
 * Winston ロガー設定
 * Cloud Run は stdout/stderr を Cloud Logging へ自動転送する
 */

const { createLogger, format, transports } = require('winston');

const logger = createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: format.combine(
    format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    format.errors({ stack: true }),
    // Cloud Logging が JSON ログを構造化データとして扱う
    format.json()
  ),
  transports: [
    new transports.Console(),
  ],
});

module.exports = logger;
