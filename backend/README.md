# Backend

Replacement for the closed-source API the upstream game talks to. The game
server is stateless: it keeps matches in memory and calls this service for
everything that has to persist — accounts, auth, stats, the game archive.

Currently implemented: **auth core** (JWKS, token issuing/refresh,
`/users/@me`). Everything else is listed under [Roadmap](#roadmap).

## Stack

| Piece      | Choice           | Why                                                                       |
| ---------- | ---------------- | ------------------------------------------------------------------------- |
| Runtime    | Node + TypeScript | Lets us import the game's Zod schemas directly instead of duplicating them |
| HTTP       | Fastify          | Fast, schema-first, small surface                                          |
| Database   | PostgreSQL       | Relational data (friends, parties, clans) and leaderboard aggregation      |
| ORM        | Drizzle          | SQL-shaped, no codegen step                                               |
| Cache/queue| Redis            | Party presence and matchmaking — ephemeral, high-churn                     |
| Tokens     | jose (EdDSA)     | The game verifies `algorithms: ["EdDSA"]` and accepts nothing else         |

## Quick start

```bash
npm install
npm run infra:up      # postgres on :5433, redis on :6380
npm run db:migrate
npm run dev           # http://localhost:8787
```

No `.env` is needed for local development — defaults cover everything, and an
ephemeral signing key is generated at boot. Copy `.env.example` to `.env` when
you want a key that survives restarts (`npm run keys:generate`).

Smoke test:

```bash
curl -s -X POST http://localhost:8787/auth/dev-login -H 'Content-Type: application/json' -d '{}'
```

## Endpoints

| Method | Path                      | Auth      | Notes                                |
| ------ | ------------------------- | --------- | ------------------------------------ |
| GET    | `/health`                 | —         | Liveness                             |
| GET    | `/.well-known/jwks.json`  | —         | Public verification key              |
| GET    | `/users/@me`              | Bearer    | Drives ads, ranked limits, ban screen |
| POST   | `/auth/refresh`           | —         | Rotates the refresh token            |
| POST   | `/auth/logout`            | —         | Revokes one refresh token            |
| POST   | `/auth/dev-login`         | —         | **Development only**, never registered in production |

## Things that are not negotiable

These are dictated by the game and will silently break login if changed:

- **Port 8787.** The game derives its API base from the JWT audience; for
  `localhost` that resolves to `http://localhost:8787`
  (`ServerEnv.jwtIssuer`, `src/server/ServerEnv.ts`).
- **EdDSA / Ed25519 only.** `src/server/jwt.ts` verifies with
  `algorithms: ["EdDSA"]`.
- **`sub` is a base64url-encoded UUID**, not a plain one — see
  `TokenPayloadSchema`. We encode it with the game's own `uuidToBase64url`.
- **JWKS order matters.** The game reads `keys[0]`, it does not match on `kid`.
  During a rotation the new signing key must come first.
- **`/users/@me` must satisfy `UserMeResponseSchema`.** Tests assert against
  the game's schema directly, so a drift fails the build rather than
  production.

## Shared schemas

`@game/*` maps to `../src/core/*`, so wire contracts are imported, never
copied. This is the main reason the backend lives in this repo.

The game's sources get pulled into the type program transitively. They are
checked under the game's own, looser settings, so a few strict flags are off
here (`noUncheckedIndexedAccess`, `verbatimModuleSyntax`,
`strictPropertyInitialization`) — each is commented in `tsconfig.json`.

## Security notes

- Refresh tokens are opaque random values, stored only as SHA-256 hashes, and
  rotated on every use. A reused token is rejected — that is a theft signal
  worth alerting on once monitoring exists.
- SHA-256 rather than bcrypt/argon2 is deliberate: these are 256-bit random
  values, not user-chosen passwords, so there is no dictionary to slow down.
- `/auth/dev-login` mints sessions with no authentication. It is registered
  only when `NODE_ENV !== "production"`.
- Production boot refuses to start without `JWT_PRIVATE_KEY` and a non-default
  `API_KEY`.

## Roadmap

Still served by the upstream API — each has to be reimplemented here:

- [ ] OAuth providers (Discord, Google, Steam)
- [ ] `POST/GET /game/{id}` — archive, feeds replays
- [ ] `/join_verify` — join authorization
- [ ] `/cosmetics.json`, `/reserved_clan_tags`, `/custom_tribes`
- [ ] `/matchmaking/join` (WebSocket) + `/matchmaking/checkin`
- [ ] Friends API
- [ ] ELO calculation and leaderboards
- [ ] **Parties** (new) — schema is in place, routes are not

Client-side work that does not need this backend:

- [ ] **Faster chat + emojis** (new) — today chat is reachable only through the
      radial menu (`MainRadialMenu` → `ChatIntegration.setupChatModal`), which
      costs several clicks mid-game. Wanted: a direct key/hotbar path and
      quicker emoji access. The simulation side already exists
      (`QuickChatExecution`, `EmojiExecution`), so this is mostly UI plus
      possibly new entries in `resources/QuickChat.json`.
- [ ] **More public lobbies in parallel** — the master currently schedules one
      upcoming game at a time (`MasterLobbyService.maybeScheduleLobby`).

## Tests

```bash
npm test
```

Nothing here needs a database yet. When it does, prefer a throwaway Postgres
over mocks — the game's own suite takes the same line.
