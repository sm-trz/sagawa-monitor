FROM mcr.microsoft.com/playwright:v1.45.3-jammy

WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY . .

ENV PORT=8080
CMD ["npm", "start"]
