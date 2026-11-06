# Production Dockerfile for SecureVault Backend
FROM node:20-alpine

RUN apk add --no-cache curl

WORKDIR /app

COPY package*.json ./
RUN npm ci --only=production

COPY . .

RUN mkdir -p storage/node-01 storage/node-02 storage/node-03 storage/node-04 storage/node-05 storage/node-06 data

EXPOSE 5002

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -f http://localhost:5002/api/health || exit 1

CMD ["node", "src/server.js"]
