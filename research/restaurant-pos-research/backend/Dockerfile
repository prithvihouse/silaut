FROM node:24-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY server.js refill_gate.js ./
COPY lua/ ./lua/
USER node
EXPOSE 3000
CMD ["node", "server.js"]
