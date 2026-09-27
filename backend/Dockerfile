# syntax=docker/dockerfile:1.7

FROM node:24-bookworm-slim AS base
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1

FROM base AS dependencies
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci --ignore-scripts

FROM dependencies AS builder
COPY . .

# Public values are compiled into the browser bundle. The Windows installer
# will build the final image with the local Supabase URL and publishable key.
ARG NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:8000
ARG NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=installer-publishable-placeholder
ENV NEXT_PUBLIC_SUPABASE_URL=$NEXT_PUBLIC_SUPABASE_URL
ENV NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=$NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY
ENV SUPABASE_SERVICE_ROLE_KEY=installer-build-secret-placeholder
ENV OPENROUTER_API_KEY=installer-build-openrouter-placeholder
ENV WORKER_SECRET=installer-build-worker-placeholder
ENV APP_BASE_URL=http://127.0.0.1:8888
RUN npm run build

FROM base AS web
ENV NODE_ENV=production
ENV HOSTNAME=0.0.0.0
ENV PORT=3000
RUN groupadd --system --gid 1001 nodejs \
  && useradd --system --uid 1001 --gid nodejs nextjs
COPY --from=builder --chown=nextjs:nodejs /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --from=builder --chown=nextjs:nodejs /app/node_modules/@napi-rs ./node_modules/@napi-rs
USER nextjs
EXPOSE 3000
CMD ["node", "server.js"]

FROM dependencies AS worker
ENV NODE_ENV=production
COPY . .
RUN npm run postinstall
RUN groupadd --system --gid 1001 nodejs \
  && useradd --system --uid 1001 --gid nodejs nextjs
USER nextjs
CMD ["./node_modules/.bin/tsx", "scripts/local-case-worker.ts"]
