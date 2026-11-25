# One image for every process. The command selects the role:
#   all      web app and worker
#   web      web app and API (port 8000)
#   worker   jobs, the schedule and the reads from connected apps
#   migrate  apply database migrations (taking over a database of the Django version), then exit
#   cli      operator commands, e.g. `cli settings list` (docs/deployment.md); also on the PATH

FROM node:26.13.1-bookworm-slim@sha256:5df79989ed685e09f0a98019db4cebfb22fb9df1a53c0161664a011f7ff6b0f1 AS base
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/

FROM base AS deps
RUN npm ci --no-audit --no-fund

FROM deps AS build
COPY . .
RUN npm run build
# The Deploy workflow's builds upload the source maps of the server and the
# web app to Sentry, which finds them by the debug IDs the build wrote into
# the bundles (scripts/inject-debug-ids.mjs). Without the token (the secret
# SENTRY_AUTH_TOKEN of the repository), nothing is uploaded.
ARG SENTRY_ORG=""
ARG SENTRY_PROJECT=""
RUN --mount=type=secret,id=sentry_auth_token,env=SENTRY_AUTH_TOKEN \
    if [ -n "$SENTRY_AUTH_TOKEN" ]; then \
      export SENTRY_CLI_NO_TELEMETRY=1 SENTRY_CLI_NO_UPDATE_CHECK=1 \
      && node_modules/.bin/sentry sourcemap upload apps/server/dist \
      && node_modules/.bin/sentry sourcemap upload apps/web/dist; \
    fi
# The web app's source maps would be public under /assets: they stay out of
# the image. The server's are never served.
RUN find apps/web/dist -name '*.map' -delete

FROM base AS prod-deps
# Optional packages here are build and test tools that libraries name as
# optional peers (vitest, drizzle-kit, esbuild): the server needs none of them.
RUN npm ci --omit=dev --omit=optional --workspace @iam/server --include-workspace-root=false --no-audit --no-fund

FROM node:26.13.1-bookworm-slim@sha256:5df79989ed685e09f0a98019db4cebfb22fb9df1a53c0161664a011f7ff6b0f1 AS runtime
# An unprivileged user, uid 10001 as in every earlier version of the image.
RUN groupadd --gid 10001 iam && useradd --uid 10001 --gid iam --no-create-home --shell /usr/sbin/nologin iam
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8000 \
    WORKER_ALIVE_FILE=/tmp/iam-worker-alive
WORKDIR /app
COPY --from=prod-deps --chown=iam:iam /app/node_modules ./node_modules
COPY --from=build --chown=iam:iam /app/package.json ./package.json
COPY --from=build --chown=iam:iam /app/apps/server/package.json ./apps/server/package.json
COPY --from=build --chown=iam:iam /app/apps/server/dist ./apps/server/dist
COPY --from=build --chown=iam:iam /app/apps/server/drizzle ./apps/server/drizzle
COPY --from=build --chown=iam:iam /app/apps/web/dist ./apps/web/dist
COPY --chown=iam:iam docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
COPY --chmod=755 docker-cli.sh /usr/local/bin/cli
# The Deploy workflow sets the version (the first 12 characters of the
# commit); images built from source have none.
ARG APP_VERSION=""
ENV APP_VERSION=${APP_VERSION}
USER iam
EXPOSE 8000
ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["web"]
