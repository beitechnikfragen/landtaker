# Backend

Replacement for the closed-source API the upstream game talks to. The game
server is stateless: it keeps matches in memory and calls this service for
everything that has to persist — accounts, auth, stats, the game archive.

Implemented: auth (JWKS, tokens, cookie sessions), `/users/@me`, player
profiles, parties (incl. live updates over SSE), friends, the game archive,
and ranked leaderboards. Clans, the shop and cosmetics answer as placeholders
for now. What is still missing is listed under [Roadmap](#roadmap).

Run every end-to-end check at once against a running backend:

```bash
bash scripts/smoke-all.sh
```

## Stack

| Piece       | Choice            | Why                                                                        |
| ----------- | ----------------- | -------------------------------------------------------------------------- |
| Runtime     | Node + TypeScript | Lets us import the game's Zod schemas directly instead of duplicating them |
| HTTP        | Fastify           | Fast, schema-first, small surface                                          |
| Database    | PostgreSQL        | Relational data (friends, parties, clans) and leaderboard aggregation      |
| ORM         | Drizzle           | SQL-shaped, no codegen step                                                |
| Cache/queue | Redis             | Party presence and matchmaking — ephemeral, high-churn                     |
| Tokens      | jose (EdDSA)      | The game verifies `algorithms: ["EdDSA"]` and accepts nothing else         |

## Quick start

```bash
npm install
npm run infra:up # postgres on :5433, redis on :6380
npm run db:migrate
npm run dev # http://localhost:8787
```

No `.env` is needed for local development — defaults cover everything, and an
ephemeral signing key is generated at boot. Copy `.env.example` to `.env` when
you want a key that survives restarts (`npm run keys:generate`).

Smoke test:

```bash
curl -s -X POST http://localhost:8787/auth/dev-login -H 'Content-Type: application/json' -d '{}'
```

## Endpoints

| Method | Path                     | Auth    | Notes                                                |
| ------ | ------------------------ | ------- | ---------------------------------------------------- |
| GET    | `/health`                | —       | Liveness                                             |
| GET    | `/.well-known/jwks.json` | —       | Public verification key                              |
| GET    | `/users/@me`             | Bearer  | Drives ads, ranked limits, ban screen                |
| POST   | `/auth/refresh`          | —       | Rotates the refresh token                            |
| POST   | `/auth/logout`           | —       | Revokes one refresh token                            |
| POST   | `/auth/dev-login`        | —       | **Development only**, never registered in production |
| GET    | `/parties/@me`           | Bearer  | The caller's party, or null                          |
| POST   | `/parties`               | Bearer  | Create; returns the invite code                      |
| POST   | `/parties/join`          | Bearer  | Join by invite code                                  |
| POST   | `/parties/leave`         | Bearer  | Leave; transfers leadership or deletes               |
| POST   | `/parties/kick`          | Bearer  | Leader only                                          |
| GET    | `/parties/@me/fit`       | Bearer  | Can this party be seated in a lobby of that shape?   |
| GET    | `/parties/@me/events`    | Bearer  | SSE stream of party changes                          |
| GET    | `/parties/members`       | api key | Server-to-server; publicIds of a player's party      |
| GET    | `/friends`               | Bearer  | Paged friends list                                   |
| GET    | `/friends/requests`      | Bearer  | Incoming and outgoing                                |
| GET    | `/leaderboard/ranked`    | —       | Paged, elo DESC                                      |
| GET    | `/player/:publicId`      | Bearer  | Public profile                                       |
| POST   | `/game/:id`              | api key | Archive a finished match                             |
| GET    | `/game/:id`              | —       | Replay data; PII withheld without the api key        |

### Party rules

- A player is in at most one party — enforced by a unique index, not a
  check-then-insert, so concurrent joins cannot both win.
- Re-joining the party you are already in is a no-op returning 200; joining a
  _different_ one is 409. A double-clicked invite link must not error.
- When the leader leaves, leadership passes to the longest-standing member; the
  party is deleted once the last member leaves, so no orphan rows accumulate.
- Invite codes omit `0/O`, `1/I/L`, `5/S` and `8/B` — they get read aloud.
- An empty JSON body parses as `{}` rather than 400 (see the content-type
  parser in `app.ts`). Browser clients set `Content-Type: application/json`
  globally and then POST to endpoints that take no arguments; Fastify's
  default rejects that, so `/parties/leave` failed in the browser while
  passing every curl test.

Behaviour is covered end to end by `scripts/smoke-parties.sh` (needs a running
backend); the database-free invariants have unit tests.

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
- [x] `POST/GET /game/{id}` — archive, feeds replays. GET is deliberately
      unauthenticated (the browser fetches it with no credentials to start a
      replay); the api key instead decides whether `persistentID` comes back.
- [ ] `/join_verify` — join authorization
- [ ] `/cosmetics.json`, `/reserved_clan_tags`, `/custom_tribes`
- [ ] `/matchmaking/join` (WebSocket) + `/matchmaking/checkin`
- [x] Friends API — requests, accept/deny, list, remove. A mutual request
      auto-accepts, which is what the client already branches on.
- [ ] ELO calculation — the leaderboard reads `leaderboardEntries`, but
      nothing writes to it yet: match results are archived, not yet scored.
- [x] **Parties** (new) — REST routes, client UI (nav → Party), live updates
      over SSE, a join-time fit check, and party members biased onto the same
      team at match start. The seating reuses the friends path rather than the
      clan path: clan overflow is kicked, and a variable-size lobby admits a
      party of any size, so the strict path would bench someone who was
      explicitly allowed to join. The deterministic core was not modified.

Client-side work that does not need this backend:

- [x] **Faster chat + emojis** (new) — direct hotkeys (Z / X by default,
      rebindable under Settings → Keybinds → Communication). Both broadcast to
      all players; picking a single recipient stays on the radial menu.
- [x] **More public lobbies in parallel** — `LOBBIES_PER_TYPE` (default 3,
      was a hardcoded 2). Open lobbies of the same type also avoid repeating a
      map that is already listed.

## Tests

```bash
npm test
```

Nothing here needs a database yet. When it does, prefer a throwaway Postgres
over mocks — the game's own suite takes the same line.
