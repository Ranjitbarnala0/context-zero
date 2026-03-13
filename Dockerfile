# ────────────────────────────────────────────────
# ContextZero — Production Docker Image
# Multi-stage build: compile TypeScript → slim runtime
# ────────────────────────────────────────────────

# Stage 1: Build
FROM node:22-alpine AS builder

# Build tools for tree-sitter native modules
RUN apk add --no-cache python3 make g++

WORKDIR /app

# Install dependencies first (cache layer)
COPY package.json package-lock.json ./
RUN npm ci

# Copy source and compile
COPY tsconfig.json ./
COPY src/ src/
RUN npm run build

# Prune dev dependencies
RUN npm prune --production

# Stage 2: Runtime
FROM node:22-alpine AS runtime

# Security: run as non-root
RUN addgroup -S scg && adduser -S scg -G scg

# Python for the Python adapter (optional — remove if not needed)
# curl for healthcheck probes
RUN apk add --no-cache python3 py3-pip curl

WORKDIR /app

# Copy only production artifacts
COPY --from=builder /app/dist dist/
COPY --from=builder /app/node_modules node_modules/
COPY --from=builder /app/package.json package.json

# Copy Python adapter source (not compiled by tsc)
COPY src/adapters/py/ dist/adapters/py/

# Copy database schema for migrations
COPY db/ db/

USER scg

EXPOSE 3100

HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
    CMD curl -sf http://localhost:3100/health || exit 1

CMD ["node", "dist/mcp-interface/index.js"]
