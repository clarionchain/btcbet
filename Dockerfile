FROM cashu-bark:e3d4174ca08a3c97bc23e1e73aa5332d725a7689 AS bark
FROM node:22-bookworm-slim
COPY --from=bark /usr/local/bin/bark /usr/local/bin/bark
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package*.json .npmrc ./
RUN npm ci
COPY . .
RUN DATABASE_URL=postgresql://build:build@localhost/build ADMIN_SECRET=build-only-placeholder-not-a-secret-0001 AGENT_TOKEN_PEPPER=build-only-placeholder-not-a-secret-0002 npm run build
ENV NODE_ENV=production
USER node
EXPOSE 3085
CMD ["npm","run","start"]
