# Deploying Landtaker on Coolify

The stack is four services, shipped as one Docker Compose resource
(`docker-compose.coolify.yml` at the repo root):

| Service    | What it is                                           | Domain                 |
| ---------- | ---------------------------------------------------- | ---------------------- |
| `game`     | Game server: lobbies, match relay, serves the client | `https://<DOMAIN>`     |
| `backend`  | Accounts, ranked, friends/party/chat (Fastify)       | `https://api.<DOMAIN>` |
| `postgres` | The only stateful service (persistent volume)        | internal only          |
| `redis`    | Presence/party fanout, deliberately ephemeral        | internal only          |

**The `api.` subdomain is a hard convention, not a preference.** Client and
game server both derive the API base as `https://api.<DOMAIN>` from the JWT
audience (`src/client/Api.ts` `getApiBase`, `src/server/ServerEnv.ts`
`jwtIssuer`). Point any other subdomain at the backend and every token check
fails with "invalid token".

## Setup

1. **Coolify → New resource → Docker Compose**, pick this repository and
   `docker-compose.coolify.yml`. Build context is the repo root (both images
   need it — the backend imports the game's shared schemas).
2. **Domains** (Coolify UI, per service):
   - `game` port 80 → `yourdomain.tld`
   - `backend` port 8787 → `api.yourdomain.tld`
     Coolify's traefik handles TLS for both.
3. **Environment variables** (Coolify UI, applies to the whole stack):

   | Variable               | Value                                                                                                                                                                                                                |
   | ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
   | `DOMAIN`               | `yourdomain.tld` (no scheme, no `www`)                                                                                                                                                                               |
   | `POSTGRES_PASSWORD`    | long random string                                                                                                                                                                                                   |
   | `API_KEY`              | long random string — shared game↔backend secret                                                                                                                                                                      |
   | `ADMIN_BOT_API_KEY`    | long random string                                                                                                                                                                                                   |
   | `JWT_PRIVATE_KEY`      | output of `cd backend && npm run keys:generate` (the JSON)                                                                                                                                                           |
   | `NUM_WORKERS`          | `2` to start; one game worker process each                                                                                                                                                                           |
   | `TURNSTILE_SITE_KEY`   | leave default (test key, always passes) until you register a real Cloudflare Turnstile site                                                                                                                          |
   | `TURNSTILE_SECRET_KEY` | the private half of the Turnstile pair, set on the **backend** (not the game server). Leave unset to skip verification entirely — guests can still submit feedback, and join verification behaves exactly as before. |
   | `BACKEND_NODE_ENV`     | see **Sign-in** below                                                                                                                                                                                                |
   | `GIT_COMMIT`           | optional; Coolify can inject the commit SHA                                                                                                                                                                          |

4. **Deploy.** First boot order is handled by compose: postgres → healthcheck →
   backend (runs migrations, then binds) → game.

## Sign-in (read before going public)

`POST /auth/dev-login` exists **only when `NODE_ENV !== "production"`**, and
real OAuth (Discord/Google) is not wired yet. That leaves two honest options:

- `BACKEND_NODE_ENV=production` — safe, but **nobody can sign in** until OAuth
  lands. The game itself is fully playable anonymously; ranked/friends/party
  stay dark.
- `BACKEND_NODE_ENV=development` — dev sign-in works for everyone, meaning
  **anyone can log in as any name, no password**. Acceptable for a private
  test server behind an unshared URL, unacceptable for anything public.

For a friends-only alpha: `development`, and treat every account as
throwaway. Flip to `production` the day OAuth ships.

## Versioning & rollout

**Deploys never touch the data.** A deploy builds fresh `game`/`backend`
images and swaps the containers; `postgres` keeps running on its named volume
(`postgres-data`). Nothing is wiped unless you delete that volume yourself.

**Schema changes ride the deploy.** The backend image applies pending Drizzle
migrations (`backend/drizzle/*.sql`) on every container start, before the
server binds. A commit that adds a migration upgrades the schema the moment
its container boots; a failed migration fails the deploy loudly instead of
serving against a half-upgraded schema.

Migration discipline that makes rollbacks boring:

- **Additive only.** New tables and nullable/defaulted columns. Old code runs
  fine against a newer schema, so rolling the app back = redeploying the
  previous commit, no database surgery.
- **Never edit an applied migration** — drizzle tracks them by hash in
  `drizzle.__drizzle_migrations`; generate a new one (`npm run db:generate`).
- **Destructive changes** (drop/rename) only after no deployed version
  references the old shape, as their own migration.

**Redis is disposable by design** — presence, party fanout, matchmaking
queues. A restart logs everyone's dock as offline for a heartbeat and drops
parties; that's recoverable, so it runs without persistence.

**Rollback** in Coolify = redeploy the previous image/commit. Because
migrations are additive, the old app runs against the new schema unchanged.
The database is only ever rolled back by restoring a backup — which is why
Coolify's scheduled Postgres backups should be enabled from day one
(Coolify → the postgres service → Backups; dumps land wherever you configure,
S3 works).

## After the first deploy

- `https://api.yourdomain.tld/health` → `{"status":"ok"}`
- `https://api.yourdomain.tld/.well-known/jwks.json` → your public key (the
  game server fetches this at boot to verify tokens)
- `https://yourdomain.tld` → the game

If joins fail with "Unauthorized: invalid token": the game server cached a
JWKS from before a backend key change — restart the `game` service. Keep
`JWT_PRIVATE_KEY` stable so this never happens outside of deliberate key
rotation.
