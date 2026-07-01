FROM mcr.microsoft.com/playwright:v1.61.1-jammy

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

COPY *.js ./

ENV NODE_ENV=production
ENV PORT=8080
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

EXPOSE 8080

CMD ["node", "index.js"]
