# syntax=docker/dockerfile:1.7
# Build stage: compile TypeScript with dev dependencies.
FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

# Runtime stage: production dependencies and compiled output only.
FROM node:24-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
RUN addgroup -S mcp && adduser -S -G mcp mcp
COPY --from=build --chown=mcp:mcp /app/node_modules ./node_modules
COPY --from=build --chown=mcp:mcp /app/dist ./dist
COPY --chown=mcp:mcp package.json ./
USER mcp
# The HTTP entry point binds MCP_HTTP_HOST:MCP_HTTP_PORT (default 0.0.0.0:3939 in containers).
ENV MCP_HTTP_HOST=0.0.0.0 MCP_HTTP_PORT=3939
EXPOSE 3939
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3939/healthz >/dev/null || exit 1
ENTRYPOINT ["node", "dist/http.js"]
