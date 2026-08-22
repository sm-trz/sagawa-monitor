/**
 * logger.js
 * Cloud Logging へ出力するロガー。
 * Cloud Run は標準出力をそのまま Cloud Logging に送ります。
 */

const { createLogger, format, transports } = require('winston');

const logger = createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: format.combine(
    format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    format.errors({ stack: true }),
    format.json()
  ),
  transports: [new transports.Console()],
});

module.exports = logger;
