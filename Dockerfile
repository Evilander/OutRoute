FROM node:22-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev

FROM node:22-slim
WORKDIR /app
RUN mkdir -p /data && chown node:node /data
COPY --from=build /app/node_modules ./node_modules
COPY package.json ./
COPY src/ ./src/
ENV NODE_ENV=production
ENV DB_PATH=/data/prism.db
ENV HOST=0.0.0.0
EXPOSE 3080
USER node
CMD ["node", "src/index.js"]
