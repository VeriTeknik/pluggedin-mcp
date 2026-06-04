# Build stage
# Node 24: pnpm 11 (pinned via packageManager) requires a newer Node than 20,
# which fails with ERR_UNKNOWN_BUILTIN_MODULE. Node 24 still bundles corepack.
FROM node:24-slim AS builder

WORKDIR /app

# Enable pnpm via corepack, pinned to the version in package.json "packageManager".
# We use pnpm (not npm) so that the security overrides in pnpm-workspace.yaml are
# applied to the dependency tree — npm ignores pnpm overrides entirely.
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable

# Copy manifest + lockfile + workspace config. pnpm-workspace.yaml holds the
# dependency `overrides`; it MUST be present or --frozen-lockfile fails with a
# lockfile/config mismatch.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./

# Install all dependencies (including dev dependencies for building).
# --frozen-lockfile ensures the build matches the committed lockfile exactly.
RUN pnpm install --frozen-lockfile

# Copy source code
COPY . .

# Build the application
RUN pnpm run build

# Production stage
FROM node:24-slim

WORKDIR /app

# Enable pnpm via corepack (pinned through "packageManager" in package.json)
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable

# Copy manifest + lockfile + workspace config (overrides live in the workspace file)
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./

# Install only production dependencies. Overrides in pnpm-workspace.yaml are
# applied here, so the production image receives the patched transitive versions.
RUN pnpm install --frozen-lockfile --prod

# Copy built application from builder stage
COPY --from=builder /app/dist ./dist

# Copy required config files
COPY smithery.yaml ./

# Copy .well-known directory for Smithery discovery
COPY .well-known ./.well-known

# Copy healthcheck script
COPY scripts/healthcheck.js ./scripts/

# Set environment variables
ENV NODE_ENV=production
ENV PORT=8081
# Bind to 0.0.0.0 to allow external connections in Docker/Cloud environments
ENV BIND_HOST=0.0.0.0

# Expose Smithery's expected port (8081)
EXPOSE 8081

# Add health check for container readiness
# Checks /health endpoint every 10 seconds with 3 second timeout
# Allows 30 seconds for initial startup before first check
HEALTHCHECK --interval=10s --timeout=3s --start-period=30s --retries=3 \
  CMD node scripts/healthcheck.js

# Run the application in Streamable HTTP mode
# Respects PORT environment variable (defaults to 8081 if not set)
# Allows flexibility for custom port configuration in different deployment scenarios
CMD ["node", "dist/index.js", "--transport", "streamable-http"]
