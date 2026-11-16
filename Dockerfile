FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY backend/package.json backend/package.json
COPY frontend/package.json frontend/package.json
RUN npm ci --no-audit --no-fund
COPY frontend/ frontend/
RUN npm run build

FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production PORT=3000
WORKDIR /app
COPY package.json package-lock.json ./
COPY backend/package.json backend/package.json
COPY frontend/package.json frontend/package.json
RUN npm ci --omit=dev --workspace backend --include-workspace-root --no-audit --no-fund && npm cache clean --force
COPY --chown=node:node backend/ backend/
COPY --chown=node:node database/ database/
COPY --chown=node:node tests/ tests/
COPY --chown=node:node scripts/ scripts/
COPY --from=build --chown=node:node /app/frontend/dist frontend/dist
USER node
EXPOSE 3000
CMD ["node","backend/server.js"]
