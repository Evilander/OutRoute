FROM node:22-slim AS build
WORKDIR /app
# better-sqlite3 compiles from source when no prebuilt binary matches the platform.
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
COPY package*.json ./
RUN npm ci --omit=dev

FROM node:22-slim
WORKDIR /app
RUN mkdir -p /data && chown node:node /data
COPY --from=build /app/node_modules ./node_modules
COPY package.json ./
COPY bin/ ./bin/
COPY src/ ./src/
ENV NODE_ENV=production
ENV DB_PATH=/data/prism.db
ENV HOST=0.0.0.0
ENV PORT=3080
EXPOSE 3080
USER node
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s CMD node -e "fetch('http://127.0.0.1:3080/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "src/index.js"]
