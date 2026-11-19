# Optional all-in-one deployment (backend + front-end on ONE server). Build context is the repository root.
FROM node:22-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
COPY backend/package.json backend/package-lock.json ./backend/
RUN cd backend && npm ci --omit=dev --no-audit --no-fund
COPY backend ./backend
COPY website ./website
COPY dashboard ./dashboard
COPY vendor-portal ./vendor-portal
COPY franchise-portal ./franchise-portal
ENV DATA_DIR=/data PORT=8080 TRUST_PROXY=true
VOLUME ["/data"]
EXPOSE 8080
WORKDIR /app/backend
CMD ["node", "server.js"]
