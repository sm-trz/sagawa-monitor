# ============================================================
# sagawa-monitor / Dockerfile
# Cloud Run 向け Playwright (Chromium) 実行環境
# ============================================================

# Node.js 20 (Debian Bookworm ベース)
FROM node:20-bookworm-slim

# ── システムパッケージ（Chromium の依存ライブラリ） ──────────────────────────
RUN apt-get update && apt-get install -y --no-install-recommends \
    # Chromium 本体（Playwright がダウンロードするものを使う場合は不要だが、
    # Cloud Run の環境では playwright install のほうが確実）
    ca-certificates \
    fonts-liberation \
    fonts-ipafont-gothic \
    fonts-wqy-zenhei \
    # Chromium の共有ライブラリ群
    libasound2 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libcups2 \
    libdbus-1-3 \
    libdrm2 \
    libgbm1 \
    libgtk-3-0 \
    libnspr4 \
    libnss3 \
    libxcomposite1 \
    libxdamage1 \
    libxfixes3 \
    libxkbcommon0 \
    libxrandr2 \
    xdg-utils \
    wget \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

# ── 作業ディレクトリ ──────────────────────────────────────────────────────────
WORKDIR /app

# ── 依存パッケージのインストール ──────────────────────────────────────────────
# package.json と package-lock.json だけ先にコピーしてキャッシュを効かせる
COPY package*.json ./
RUN npm ci --omit=dev

# ── Playwright の Chromium をインストール ──────────────────────────────────────
# PLAYWRIGHT_BROWSERS_PATH を /app/.playwright に固定することで
# Cloud Run のファイルシステムに確実に配置する
ENV PLAYWRIGHT_BROWSERS_PATH=/app/.playwright
RUN npx playwright install chromium --with-deps

# ── アプリケーションコードをコピー ────────────────────────────────────────────
COPY src/ ./src/

# ── 実行ユーザー（root を避ける） ─────────────────────────────────────────────
# Playwright の --no-sandbox オプションと合わせて使用
RUN groupadd -r appuser && useradd -r -g appuser -d /app appuser \
    && chown -R appuser:appuser /app
USER appuser

# ── 環境変数 ──────────────────────────────────────────────────────────────────
ENV NODE_ENV=production \
    PORT=8080 \
    PLAYWRIGHT_BROWSERS_PATH=/app/.playwright

# ── ヘルスチェック ────────────────────────────────────────────────────────────
HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
    CMD wget -qO- http://localhost:${PORT}/health || exit 1

# ── 起動コマンド ──────────────────────────────────────────────────────────────
EXPOSE 8080
CMD ["node", "src/index.js"]
