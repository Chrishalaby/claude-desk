# Build context = repository root (so the hub can also serve ../client).
#   docker build -f hub/Dockerfile .
FROM node:22-bookworm-slim
WORKDIR /app/hub
COPY hub/package.json hub/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY hub/tsconfig.json ./
COPY hub/src ./src
COPY hub/public ./public
RUN npm run build && npm prune --omit=dev --no-audit --no-fund
COPY hub/packs ./packs
COPY client /app/client
# firmware/dist/claude-desk.bin + version.txt (served as /firmware/latest.json and /firmware/claude-desk.bin)
COPY firmware/dist /app/firmware/dist
ENV NODE_ENV=production DATA_DIR=/data MQTT_PORT=8883
EXPOSE 8883
CMD ["node", "dist/main.js"]
