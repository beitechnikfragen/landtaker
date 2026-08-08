# Landtaker backend (accounts, ranked, social).
#
# BUILD CONTEXT IS THE REPOSITORY ROOT, not backend/ — the backend imports the
# game's shared schemas (@game/* -> ../src/core) and a few resources files, so
# both trees must be present in the image:
#
#   docker build -f backend/Dockerfile .
#
# Runs on Node's native type-stripping (no build step); migrations are applied
# on every container start before the server binds, so a deploy that carries a
# new drizzle/ file upgrades the schema itself. Migrations are additive —
# rolling the app back does not require rolling the database back.
FROM node:24-slim AS deps
WORKDIR /app/backend
ENV HUSKY=0
COPY backend/package*.json ./
# Full install, not --omit=dev: the sources import the game's shared schemas
# through the tsconfig "@game/*" path mapping, which Node's native type
# stripping does not resolve — tsx (a devDependency) is the runtime.
RUN --mount=type=cache,target=/root/.npm npm ci --ignore-scripts

FROM node:24-slim
WORKDIR /app/backend
ENV NODE_ENV=production

COPY --from=deps /app/backend/node_modules ./node_modules
COPY backend/package.json backend/tsconfig.json backend/drizzle.config.ts ./
COPY backend/drizzle ./drizzle
COPY backend/src ./src

# The game sources the backend shares types with, and the resources it serves.
COPY src/core /app/src/core
COPY resources/news.json /app/resources/news.json
COPY resources/QuickChat.json /app/resources/QuickChat.json
COPY resources/tribeNameThemes.json /app/resources/tribeNameThemes.json

# The shared game sources import jose/zod; Node resolves packages upward from
# the IMPORTING file (/app/src/core), so give that tree a node_modules.
RUN ln -s /app/backend/node_modules /app/node_modules

EXPOSE 8787

# Migrate, then serve. A failed migration must stop the deploy loudly rather
# than boot a server against a half-upgraded schema.
CMD ["sh", "-c", "./node_modules/.bin/tsx src/db/migrate.ts && exec ./node_modules/.bin/tsx src/main.ts"]
