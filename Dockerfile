# Playwright 公式イメージ（Chromium と必要なライブラリが最初から入っている）
# package.json の playwright のバージョンと必ず一致させること。
FROM mcr.microsoft.com/playwright:v1.61.1-jammy

WORKDIR /app

# 依存パッケージを先に入れる（コード変更だけならこの層は再利用される）
COPY package*.json ./
RUN npm ci --omit=dev || npm install --omit=dev

# アプリ本体（carriers/ フォルダを含めるため、ファイル指定ではなく丸ごとコピー）
COPY . .

ENV NODE_ENV=production
ENV PORT=8080
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

EXPOSE 8080

CMD ["node", "index.js"]
