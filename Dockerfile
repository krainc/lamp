FROM node:22-slim

ENV NODE_ENV=production
WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY src ./src
COPY public ./public
COPY scripts ./scripts

# 8080 = web UI, 1883 = MQTT for the plugs. TLS is terminated at the platform
# edge (see fly.toml), so nothing in here needs a certificate.
EXPOSE 8080 1883

CMD ["node", "src/index.js"]
