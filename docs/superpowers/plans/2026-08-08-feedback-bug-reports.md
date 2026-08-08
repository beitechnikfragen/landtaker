# Feedback & Bug Reports Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let any player — guest or logged in — report a bug or suggest an idea from inside the game, stored in Postgres for a future admin area, protected by Cloudflare Turnstile and a Redis rate limit.

**Architecture:** A new `POST /feedback` endpoint in the `backend/` Fastify service, with auth optional so guests can submit. Guests must pass Turnstile; everyone passes a two-tier Redis rate limit keyed on userId (logged in) or truncated IP (guest). Both the rate limiter and the Turnstile verifier are written as generic services independent of feedback, because both are wanted elsewhere. The client is a Lit modal reached from the Help modal.

**Tech Stack:** Fastify 5, Drizzle ORM + PostgreSQL, ioredis, Zod 4, Vitest (backend); Lit + Tailwind 4 (client).

**Spec:** `docs/superpowers/specs/2026-08-08-feedback-bug-reports-design.md`

## Global Constraints

- **The `backend/` directory is a separate npm project.** Run all backend commands from `backend/`, not the repo root. It has its own `package.json`, `tsconfig.json`, and `vitest.config.ts`.
- **Backend imports use explicit `.ts` extensions** (`from "../db/index.ts"`) — required by `verbatimModuleSyntax`. The game's own client code does NOT do this. Match the directory you are editing.
- **Backend runs stricter TypeScript than the game**: `noUncheckedIndexedAccess` and `verbatimModuleSyntax` are on. Indexing an array yields `T | undefined`; type-only imports need `import type`.
- **All user-visible client text goes through `translateText()`**, with new keys added to `resources/lang/en.json` ONLY. Never modify another `resources/lang/*.json` — they are managed via Crowdin.
- **No changes to `src/core/`.** If a change seems to require one, stop and ask — it would trigger the determinism rules and the mandatory-test rule in CLAUDE.md.
- **Never use `npm install`** in this repo; use `npm run inst` (which is `npm ci --ignore-scripts`). The backend uses plain `npm install` — that one is fine, it is a separate project.
- **Commit after every task.** Pre-commit hooks run Prettier and will reformat files; that is expected.
- Backend tests: `cd backend && npx vitest run src/services/<name>.test.ts`
- Client tests: `npx vitest tests/<Name>.test.ts --run` from the repo root.

---

## File Structure

**Backend (`backend/`):**

| File                             | Responsibility                                             |
| -------------------------------- | ---------------------------------------------------------- |
| `src/services/rateLimit.ts`      | Generic Redis fixed-window limiter. No feedback knowledge. |
| `src/services/rateLimit.test.ts` | Limiter unit tests, including fail-open.                   |
| `src/services/turnstile.ts`      | Cloudflare `siteverify`. Three-state verdict.              |
| `src/services/turnstile.test.ts` | Verifier unit tests.                                       |
| `src/services/feedback.ts`       | Insert reports; truncate IPs. No HTTP knowledge.           |
| `src/services/feedback.test.ts`  | IP truncation + input-shaping tests.                       |
| `src/routes/feedback.ts`         | HTTP: body schema, status codes, orchestration.            |
| `src/routes/feedback.test.ts`    | Route-level tests with services mocked.                    |
| `src/plugins/auth.ts`            | _(modify)_ Add `optionalAuth`.                             |
| `src/db/schema.ts`               | _(modify)_ Add `feedbackReports` table.                    |
| `src/config.ts`                  | _(modify)_ Add `TURNSTILE_SECRET_KEY`.                     |
| `src/app.ts`                     | _(modify)_ Register feedback routes.                       |
| `src/services/joinVerify.ts`     | _(modify)_ Replace the Turnstile no-op.                    |

**Client (repo root):**

| File                          | Responsibility                                           |
| ----------------------------- | -------------------------------------------------------- |
| `src/client/FeedbackApi.ts`   | Fetch wrapper + context collection.                      |
| `src/client/Turnstile.ts`     | Extracted, reusable token helper.                        |
| `src/client/FeedbackModal.ts` | The Lit modal.                                           |
| `src/client/Main.ts`          | _(modify)_ Use extracted helper; register modal.         |
| `src/client/HelpModal.ts`     | _(modify)_ Entry-point button.                           |
| `index.html`                  | _(modify)_ Modal element + feedback Turnstile container. |
| `resources/lang/en.json`      | _(modify)_ New keys.                                     |

**Task dependency order:** Tasks 1–4 are independent backend units. Task 5 composes them into the route. Tasks 6–9 are the client. Task 10 wires Turnstile into join verification. Tasks 1, 2, and 6 could run in parallel; everything else is sequential.

---

### Task 1: Generic Redis rate limiter

**Files:**

- Create: `backend/src/services/rateLimit.ts`
- Test: `backend/src/services/rateLimit.test.ts`

**Interfaces:**

- Consumes: `redis` from `../redis.ts` (an ioredis client).
- Produces:
  ```ts
  export interface RateLimitTier {
    limit: number;
    windowSeconds: number;
  }
  export interface RateLimitResult {
    allowed: boolean;
    retryAfterSeconds: number;
  }
  export async function checkRateLimit(
    namespace: string,
    key: string,
    tiers: RateLimitTier[],
  ): Promise<RateLimitResult>;
  ```

Fixed-window counters. `INCR` then `EXPIRE` on first increment. All tiers are checked (read-only) before any is incremented, so a request refused by the daily tier does not consume burst budget. On any Redis error the limiter returns `{allowed: true, retryAfterSeconds: 0}` — fail open, per the spec.

- [ ] **Step 1: Write the failing test**

Create `backend/src/services/rateLimit.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The limiter is a thin wrapper over Redis, so these tests mock ioredis
 * rather than requiring a live server. What is worth testing is the policy:
 * when we refuse, what we report as the retry delay, and — most importantly —
 * that a Redis outage does not silently close the endpoint.
 */
const mockRedis = {
  get: vi.fn(),
  incr: vi.fn(),
  expire: vi.fn(),
  ttl: vi.fn(),
};

vi.mock("../redis.ts", () => ({ redis: mockRedis }));

const { checkRateLimit } = await import("./rateLimit.ts");

const BURST = { limit: 3, windowSeconds: 600 };
const DAILY = { limit: 20, windowSeconds: 86400 };

beforeEach(() => {
  vi.clearAllMocks();
  mockRedis.get.mockResolvedValue(null);
  mockRedis.incr.mockResolvedValue(1);
  mockRedis.expire.mockResolvedValue(1);
  mockRedis.ttl.mockResolvedValue(600);
});

describe("checkRateLimit", () => {
  it("allows a first request and starts the window", async () => {
    const result = await checkRateLimit("feedback", "user-1", [BURST]);

    expect(result.allowed).toBe(true);
    expect(mockRedis.incr).toHaveBeenCalledWith(
      "ratelimit:feedback:600:user-1",
    );
    // EXPIRE only on the first increment, or the window would slide forever.
    expect(mockRedis.expire).toHaveBeenCalledWith(
      "ratelimit:feedback:600:user-1",
      600,
    );
  });

  it("does not reset the window on later requests", async () => {
    mockRedis.get.mockResolvedValue("1");
    mockRedis.incr.mockResolvedValue(2);

    const result = await checkRateLimit("feedback", "user-1", [BURST]);

    expect(result.allowed).toBe(true);
    expect(mockRedis.expire).not.toHaveBeenCalled();
  });

  it("refuses once the limit is reached and reports the TTL", async () => {
    mockRedis.get.mockResolvedValue("3");
    mockRedis.ttl.mockResolvedValue(412);

    const result = await checkRateLimit("feedback", "user-1", [BURST]);

    expect(result.allowed).toBe(false);
    expect(result.retryAfterSeconds).toBe(412);
    // A refused request must not consume budget, or the window would extend
    // itself every time an already-blocked user retried.
    expect(mockRedis.incr).not.toHaveBeenCalled();
  });

  it("reports the longer TTL when both tiers are exhausted", async () => {
    // Burst full (10 min left) and daily full (6 h left). Advertising the
    // burst TTL would promise a retry that the daily tier still refuses.
    mockRedis.get.mockImplementation(async (key: string) =>
      key.endsWith(":600:user-1") ? "3" : "20",
    );
    mockRedis.ttl.mockImplementation(async (key: string) =>
      key.endsWith(":600:user-1") ? 600 : 21600,
    );

    const result = await checkRateLimit("feedback", "user-1", [BURST, DAILY]);

    expect(result.allowed).toBe(false);
    expect(result.retryAfterSeconds).toBe(21600);
  });

  it("fails OPEN when Redis is unavailable", async () => {
    // Deliberate policy, not an oversight: a Redis blip must not block all
    // feedback. See the spec's "Redis unavailable" decision.
    mockRedis.get.mockRejectedValue(new Error("ECONNREFUSED"));

    const result = await checkRateLimit("feedback", "user-1", [BURST]);

    expect(result.allowed).toBe(true);
    expect(result.retryAfterSeconds).toBe(0);
  });

  it("keys tiers separately so windows cannot collide", async () => {
    await checkRateLimit("feedback", "user-1", [BURST, DAILY]);

    expect(mockRedis.incr).toHaveBeenCalledWith(
      "ratelimit:feedback:600:user-1",
    );
    expect(mockRedis.incr).toHaveBeenCalledWith(
      "ratelimit:feedback:86400:user-1",
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && npx vitest run src/services/rateLimit.test.ts`
Expected: FAIL — `Cannot find module './rateLimit.ts'`

- [ ] **Step 3: Write the implementation**

Create `backend/src/services/rateLimit.ts`:

```ts
import { redis } from "../redis.ts";

/**
 * A generic fixed-window rate limiter over Redis. Deliberately knows nothing
 * about feedback: the same limiter should serve any endpoint that needs one,
 * and an abstraction shaped around its first caller is the harder one to
 * reuse later.
 *
 * Fixed windows rather than a sliding log because the counters are cheap
 * (one INCR) and the failure mode is generous: a user can send up to 2x the
 * limit across a window boundary. For feedback that is entirely acceptable —
 * the limit exists to stop floods, not to be exact.
 */

export interface RateLimitTier {
  limit: number;
  /** Doubles as part of the Redis key, so two tiers never share a counter. */
  windowSeconds: number;
}

export interface RateLimitResult {
  allowed: boolean;
  /** 0 when allowed. Otherwise the longest wait across exhausted tiers. */
  retryAfterSeconds: number;
}

function keyFor(namespace: string, tier: RateLimitTier, key: string): string {
  return `ratelimit:${namespace}:${tier.windowSeconds}:${key}`;
}

/**
 * Checks every tier before incrementing any of them.
 *
 * The two-pass shape matters: incrementing as we go would let a request that
 * is about to be refused by the daily tier still consume burst budget, so a
 * blocked user's retries would keep their burst window permanently full.
 *
 * FAILS OPEN. If Redis is unreachable the request is allowed. This endpoint is
 * a low-value target and losing all feedback during a cache blip is the worse
 * outcome; the alternative is an outage that looks like a product decision.
 */
export async function checkRateLimit(
  namespace: string,
  key: string,
  tiers: RateLimitTier[],
): Promise<RateLimitResult> {
  try {
    let worstRetry = 0;

    for (const tier of tiers) {
      const redisKey = keyFor(namespace, tier, key);
      const raw = await redis.get(redisKey);
      const used = raw === null ? 0 : Number.parseInt(raw, 10);

      // A corrupt value (NaN) is treated as "no usage" rather than as an
      // infinite count, so a bad key cannot permanently lock a user out.
      if (Number.isFinite(used) && used >= tier.limit) {
        const ttl = await redis.ttl(redisKey);
        // Report the LONGEST wait: a shorter one would promise a retry that
        // another exhausted tier is still going to refuse.
        worstRetry = Math.max(worstRetry, ttl > 0 ? ttl : tier.windowSeconds);
      }
    }

    if (worstRetry > 0) {
      return { allowed: false, retryAfterSeconds: worstRetry };
    }

    for (const tier of tiers) {
      const redisKey = keyFor(namespace, tier, key);
      const count = await redis.incr(redisKey);
      // Only the first increment sets the expiry. Doing it every time would
      // slide the window forward on each request, so an active user's window
      // would never end.
      if (count === 1) {
        await redis.expire(redisKey, tier.windowSeconds);
      }
    }

    return { allowed: true, retryAfterSeconds: 0 };
  } catch (err) {
    console.warn(
      `Rate limiter unavailable (${(err as Error).message}) — allowing request`,
    );
    return { allowed: true, retryAfterSeconds: 0 };
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && npx vitest run src/services/rateLimit.test.ts`
Expected: PASS, 6 tests

- [ ] **Step 5: Typecheck**

Run: `cd backend && npm run typecheck`
Expected: no errors

- [ ] **Step 6: Commit**

```bash
git add backend/src/services/rateLimit.ts backend/src/services/rateLimit.test.ts
git commit -m "feat(backend): add generic Redis rate limiter"
```

---

### Task 2: Turnstile verification service

**Files:**

- Create: `backend/src/services/turnstile.ts`
- Test: `backend/src/services/turnstile.test.ts`
- Modify: `backend/src/config.ts`

**Interfaces:**

- Consumes: `config` from `../config.ts`.
- Produces:
  ```ts
  export type TurnstileVerdict = "passed" | "failed" | "unavailable";
  export async function verifyTurnstileToken(
    token: string | null,
    remoteIp: string | null,
  ): Promise<TurnstileVerdict>;
  export function isTurnstileConfigured(): boolean;
  ```

Three states, not a boolean, because callers must distinguish "Cloudflare said no" from "we could not ask" — those demand opposite responses.

- [ ] **Step 1: Add the config key**

In `backend/src/config.ts`, add inside `ConfigSchema` after the `API_KEY` entry:

```ts
  // Cloudflare Turnstile secret for siteverify. Absent => tokens cannot be
  // verified at all, and every caller falls back to its documented fail-open
  // behaviour (see services/turnstile.ts). Deliberately optional: a local dev
  // backend and a self-hosted instance without a Cloudflare account must both
  // still work. The matching PUBLIC site key lives in the game's own env as
  // TURNSTILE_SITE_KEY — this is the private half and must never be sent to a
  // client.
  TURNSTILE_SECRET_KEY: z.string().optional(),
```

- [ ] **Step 2: Write the failing test**

Create `backend/src/services/turnstile.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * These tests own the mapping from Cloudflare's answer to our verdict. The
 * distinction that matters throughout is "failed" (Cloudflare rejected the
 * token) versus "unavailable" (we never got an answer) — callers respond to
 * those in opposite ways, so collapsing them into a boolean would be a bug.
 */
const mockConfig = { TURNSTILE_SECRET_KEY: undefined as string | undefined };

vi.mock("../config.ts", () => ({
  get config() {
    return mockConfig;
  },
  isProduction: false,
}));

const { verifyTurnstileToken, isTurnstileConfigured } =
  await import("./turnstile.ts");

beforeEach(() => {
  mockConfig.TURNSTILE_SECRET_KEY = "test-secret";
  vi.stubGlobal("fetch", vi.fn());
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("isTurnstileConfigured", () => {
  it("is false without a secret", () => {
    mockConfig.TURNSTILE_SECRET_KEY = undefined;
    expect(isTurnstileConfigured()).toBe(false);
  });

  it("is true with a secret", () => {
    expect(isTurnstileConfigured()).toBe(true);
  });
});

describe("verifyTurnstileToken", () => {
  it("returns unavailable when no secret is configured", async () => {
    mockConfig.TURNSTILE_SECRET_KEY = undefined;

    // Not "failed": we have no basis to reject a token we cannot check.
    expect(await verifyTurnstileToken("some-token", null)).toBe("unavailable");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("returns failed for a null token when configured", async () => {
    // A configured deployment that receives no token has been given nothing
    // to verify — that is a rejection, not an outage.
    expect(await verifyTurnstileToken(null, null)).toBe("failed");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("returns passed when Cloudflare accepts the token", async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => ({ success: true }),
    } as Response);

    expect(await verifyTurnstileToken("good-token", "203.0.113.5")).toBe(
      "passed",
    );
  });

  it("sends the secret, token and remote IP to siteverify", async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => ({ success: true }),
    } as Response);

    await verifyTurnstileToken("good-token", "203.0.113.5");

    const [url, init] = vi.mocked(fetch).mock.calls[0]!;
    expect(String(url)).toContain("challenges.cloudflare.com");
    const body = init!.body as URLSearchParams;
    expect(body.get("secret")).toBe("test-secret");
    expect(body.get("response")).toBe("good-token");
    expect(body.get("remoteip")).toBe("203.0.113.5");
  });

  it("returns failed when Cloudflare rejects the token", async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => ({
        success: false,
        "error-codes": ["invalid-input-response"],
      }),
    } as Response);

    expect(await verifyTurnstileToken("bad-token", null)).toBe("failed");
  });

  it("returns unavailable when siteverify is unreachable", async () => {
    // Cloudflare being down is our problem, not the player's.
    vi.mocked(fetch).mockRejectedValue(new Error("ENOTFOUND"));

    expect(await verifyTurnstileToken("good-token", null)).toBe("unavailable");
  });

  it("returns unavailable on a non-200 from siteverify", async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: false,
      status: 502,
      json: async () => ({}),
    } as Response);

    expect(await verifyTurnstileToken("good-token", null)).toBe("unavailable");
  });

  it("returns unavailable when siteverify times out", async () => {
    // AbortController surfaces as an AbortError from fetch; it must map to
    // unavailable rather than failed, or a slow network would look like fraud.
    vi.mocked(fetch).mockRejectedValue(
      Object.assign(new Error("aborted"), { name: "AbortError" }),
    );

    expect(await verifyTurnstileToken("good-token", null)).toBe("unavailable");
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd backend && npx vitest run src/services/turnstile.test.ts`
Expected: FAIL — `Cannot find module './turnstile.ts'`

- [ ] **Step 4: Write the implementation**

Create `backend/src/services/turnstile.ts`:

```ts
import { config } from "../config.ts";

/**
 * Cloudflare Turnstile verification.
 *
 * This replaces the deliberate no-op that lived in services/joinVerify.ts,
 * whose comment said the check belongs here once a TURNSTILE_SECRET_KEY
 * exists. It now does.
 *
 * The verdict is three-state on purpose. A boolean would force every caller to
 * decide what `false` means, and the two ways of not passing demand opposite
 * responses:
 *
 *   "failed"      Cloudflare looked at the token and rejected it. Refuse.
 *   "unavailable" We never got an answer — no secret, network error, timeout.
 *                 Refusing here would turn our outage into the player's
 *                 problem, so callers fail open and log.
 *
 * Callers own that policy; this module only reports what happened.
 */

const SITEVERIFY_URL =
  "https://challenges.cloudflare.com/turnstile/v0/siteverify";

/**
 * Short because it sits in a user-facing request path. A verification that
 * takes longer than this has already cost the user more than the check is
 * worth, and the fail-open path is the safe one.
 */
const SITEVERIFY_TIMEOUT_MS = 3000;

export type TurnstileVerdict = "passed" | "failed" | "unavailable";

export function isTurnstileConfigured(): boolean {
  return (config.TURNSTILE_SECRET_KEY ?? "").length > 0;
}

/**
 * @param token    The `cf-turnstile-response` value from the client.
 * @param remoteIp Client IP, if known. Optional per Cloudflare's API; passing
 *                 it lets Cloudflare correlate the solve with its origin.
 */
export async function verifyTurnstileToken(
  token: string | null,
  remoteIp: string | null,
): Promise<TurnstileVerdict> {
  const secret = config.TURNSTILE_SECRET_KEY;
  if (secret === undefined || secret.length === 0) {
    // No secret => siteverify is impossible. "unavailable", never "failed":
    // we have no basis on which to reject anyone.
    return "unavailable";
  }

  // A configured deployment that receives no token has been given nothing to
  // check. That is a rejection, not an outage — and short-circuiting here
  // avoids a pointless round trip.
  if (token === null || token.length === 0) {
    return "failed";
  }

  const body = new URLSearchParams({ secret, response: token });
  if (remoteIp !== null && remoteIp.length > 0) {
    body.set("remoteip", remoteIp);
  }

  try {
    const response = await fetch(SITEVERIFY_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
      signal: AbortSignal.timeout(SITEVERIFY_TIMEOUT_MS),
    });

    // A 5xx from Cloudflare is Cloudflare's problem. Treating it as a failed
    // solve would punish the player for someone else's outage.
    if (!response.ok) return "unavailable";

    const result = (await response.json()) as { success?: boolean };
    return result.success === true ? "passed" : "failed";
  } catch {
    // Network error, DNS failure, or the timeout above. All "we could not
    // ask", none of them "the token was bad".
    return "unavailable";
  }
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd backend && npx vitest run src/services/turnstile.test.ts`
Expected: PASS, 10 tests

- [ ] **Step 6: Typecheck and commit**

Run: `cd backend && npm run typecheck`

```bash
git add backend/src/services/turnstile.ts backend/src/services/turnstile.test.ts backend/src/config.ts
git commit -m "feat(backend): add Cloudflare Turnstile verification service"
```

---

### Task 3: Database schema and migration

**Files:**

- Modify: `backend/src/db/schema.ts`
- Generated: `backend/drizzle/0005_*.sql`

**Interfaces:**

- Produces: `feedbackReports` table export, consumed by Task 4.

- [ ] **Step 1: Add the table**

Append to `backend/src/db/schema.ts` (after the `leaderboardEntries` table). All the imports used here — `index`, `jsonb`, `pgTable`, `text`, `timestamp`, `uuid` — are already imported at the top of the file:

```ts
// ---------------------------------------------------------------------------
// Feedback
// ---------------------------------------------------------------------------

/**
 * In-game bug reports, ideas and other feedback.
 *
 * Submitted by guests as well as logged-in players (a bug that prevents login
 * must still be reportable), which is why `userId` is nullable and why the
 * route in front of this is gated by Turnstile and a rate limit.
 *
 * Rows are written by players and read by admins. Nothing here is ever sent
 * back to another player, so the only consumer of the shape is our own future
 * admin area.
 */
export const feedbackReports = pgTable(
  "feedback_reports",
  {
    id: uuid("id").primaryKey().defaultRandom(),

    // Null for guests. ON DELETE SET NULL rather than CASCADE: if an account
    // goes away the report is still a valid bug report, it just loses its
    // author. Deleting real feedback because someone closed their account
    // would lose information we cannot recover.
    userId: uuid("user_id").references(() => users.id, {
      onDelete: "set null",
    }),

    // 'bug' | 'idea' | 'other'. Text, not a pg enum, so the admin area can
    // grow a category without a migration. Zod validates at the boundary.
    type: text("type").notNull(),

    // 'new' | 'triaged' | 'resolved' | 'rejected'. Same reasoning; the real
    // triage vocabulary will only be known once the admin area is built.
    status: text("status").notNull().default("new"),

    message: text("message").notNull(),

    // Guests only, optional — their sole route to a reply. Logged-in users
    // have a contactable account already, so the route drops this for them.
    contactEmail: text("contact_email"),

    // Client version, user agent, screen size and similar. jsonb because the
    // diagnostic shape will change and a column per field means a migration
    // every time. Only ever read by a human.
    context: jsonb("context"),

    // Truncated to a /24 (IPv4) or /48 (IPv6) prefix — see truncateIp() in
    // services/feedback.ts. Enough to correlate an abuse pattern, without
    // this table becoming a years-long log of identifying addresses.
    submitterIp: text("submitter_ip"),

    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    // NOT maintained by a trigger. The admin area sets it when it changes
    // status; until then it equals createdAt.
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    // The admin area's default view: unhandled reports, newest first.
    index("feedback_reports_status_created_idx").on(
      table.status,
      table.createdAt,
    ),
    // "Everything this user reported" — for spotting a serial reporter.
    index("feedback_reports_user_idx").on(table.userId),
  ],
);
```

- [ ] **Step 2: Generate the migration**

Run: `cd backend && npm run db:generate`
Expected: creates `backend/drizzle/0005_<name>.sql` containing `CREATE TABLE "feedback_reports"`.

- [ ] **Step 3: Inspect the generated SQL**

Read the new file. Confirm it contains `CREATE TABLE "feedback_reports"`, both `CREATE INDEX` statements, and `ON DELETE set null` on the user FK. It must contain no `DROP TABLE` or `ALTER TABLE` against an existing table — if it does, the schema file was edited in a way that changed something else, so stop and investigate.

- [ ] **Step 4: Apply the migration**

Run: `cd backend && npm run infra:up && npm run db:migrate`
Expected: migration applies without error.

If Docker is unavailable, skip the apply and note it — the SQL is still correct and Task 5's tests do not need a live database.

- [ ] **Step 5: Typecheck and commit**

Run: `cd backend && npm run typecheck`

```bash
git add backend/src/db/schema.ts backend/drizzle/
git commit -m "feat(backend): add feedback_reports table"
```

---

### Task 4: Feedback service

**Files:**

- Create: `backend/src/services/feedback.ts`
- Test: `backend/src/services/feedback.test.ts`

**Interfaces:**

- Consumes: `db` from `../db/index.ts`, `feedbackReports` from `../db/schema.ts`.
- Produces:

  ```ts
  export const FEEDBACK_TYPES = ["bug", "idea", "other"] as const;
  export type FeedbackType = (typeof FEEDBACK_TYPES)[number];
  export function truncateIp(ip: string | null): string | null;
  export interface CreateFeedbackInput {
    userId: string | null;
    type: FeedbackType;
    message: string;
    contactEmail: string | null;
    context: Record<string, unknown> | null;
    ip: string | null;
  }
  export async function createFeedbackReport(
    input: CreateFeedbackInput,
  ): Promise<{ id: string }>;
  ```

- [ ] **Step 1: Write the failing test**

Create `backend/src/services/feedback.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { truncateIp } from "./feedback.ts";

/**
 * The database insert needs a live Postgres and is covered by the route tests
 * and manual verification. What is worth unit-testing is truncateIp: it is
 * pure, it is the one privacy guarantee this feature makes, and getting it
 * subtly wrong (an off-by-one octet) would silently store full addresses.
 */
describe("truncateIp", () => {
  it("keeps the first three octets of an IPv4 address", () => {
    expect(truncateIp("203.0.113.42")).toBe("203.0.113.0");
  });

  it("is stable for addresses already ending in zero", () => {
    expect(truncateIp("203.0.113.0")).toBe("203.0.113.0");
  });

  it("keeps the first three groups of an IPv6 address", () => {
    // A /48 is the usual site allocation — enough to identify a network,
    // not an individual interface.
    expect(truncateIp("2001:db8:abcd:1234:5678:9abc:def0:1234")).toBe(
      "2001:db8:abcd::",
    );
  });

  it("handles a compressed IPv6 address", () => {
    expect(truncateIp("2001:db8::1")).toBe("2001:db8::");
  });

  it("truncates an IPv4-mapped IPv6 address as IPv4", () => {
    // Node reports these for IPv4 clients on a dual-stack socket. Treating
    // the string as IPv6 would keep "::ffff:203" — meaningless as a prefix.
    expect(truncateIp("::ffff:203.0.113.42")).toBe("203.0.113.0");
  });

  it("returns null for null", () => {
    expect(truncateIp(null)).toBeNull();
  });

  it("returns null for something that is not an address", () => {
    // Never store an unrecognised value verbatim: the whole point is that
    // this column cannot hold a full address.
    expect(truncateIp("not-an-ip")).toBeNull();
    expect(truncateIp("")).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && npx vitest run src/services/feedback.test.ts`
Expected: FAIL — `Cannot find module './feedback.ts'`

- [ ] **Step 3: Write the implementation**

Create `backend/src/services/feedback.ts`:

```ts
import { db } from "../db/index.ts";
import { feedbackReports } from "../db/schema.ts";

/**
 * Storage for in-game feedback. No HTTP knowledge lives here — the route owns
 * status codes, this owns what a report is and how it is written down.
 */

export const FEEDBACK_TYPES = ["bug", "idea", "other"] as const;
export type FeedbackType = (typeof FEEDBACK_TYPES)[number];

/** Message bounds. The floor rejects "test"/"asd"; the ceiling bounds the row. */
export const MIN_MESSAGE_LENGTH = 10;
export const MAX_MESSAGE_LENGTH = 4000;

/**
 * Reduces an address to its network prefix: /24 for IPv4, /48 for IPv6.
 *
 * This table will accumulate for years and be browsed by an admin UI, so it
 * must not become a log of exactly who reported what from where. A prefix
 * still answers the only question we actually ask of it — "are these reports
 * coming from the same place?" — which is also all the rate limiter needs.
 *
 * An unparseable value returns null rather than passing through: storing
 * something we did not recognise would defeat the guarantee entirely.
 */
export function truncateIp(ip: string | null): string | null {
  if (ip === null) return null;
  const trimmed = ip.trim();
  if (trimmed.length === 0) return null;

  // Node hands us IPv4-mapped IPv6 (::ffff:1.2.3.4) for IPv4 clients on a
  // dual-stack socket. Unwrap first, or we would keep three meaningless
  // leading groups instead of the real network.
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(trimmed);
  const candidate = mapped?.[1] ?? trimmed;

  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(candidate);
  if (ipv4 !== null) {
    const octets = [ipv4[1], ipv4[2], ipv4[3], ipv4[4]].map((o) =>
      Number.parseInt(o!, 10),
    );
    if (octets.some((o) => o > 255)) return null;
    return `${octets[0]}.${octets[1]}.${octets[2]}.0`;
  }

  if (candidate.includes(":")) {
    const groups = candidate.split(":");
    // Need three real groups to form a /48. "::1" does not have them, and a
    // guessed prefix would be worse than none.
    const leading = groups.slice(0, 3);
    if (leading.some((g) => g.length === 0)) return null;
    if (!leading.every((g) => /^[0-9a-f]{1,4}$/i.test(g))) return null;
    return `${leading.join(":")}::`;
  }

  return null;
}

export interface CreateFeedbackInput {
  /** Null for a guest submission. */
  userId: string | null;
  type: FeedbackType;
  message: string;
  /** Ignored by the route for logged-in users; they are contactable already. */
  contactEmail: string | null;
  context: Record<string, unknown> | null;
  /** Raw client IP. Truncated here, never stored whole. */
  ip: string | null;
}

export async function createFeedbackReport(
  input: CreateFeedbackInput,
): Promise<{ id: string }> {
  const [row] = await db
    .insert(feedbackReports)
    .values({
      userId: input.userId,
      type: input.type,
      message: input.message.trim(),
      contactEmail: input.contactEmail,
      context: input.context,
      submitterIp: truncateIp(input.ip),
      // status defaults to 'new' in the schema — the admin area owns it from
      // here on.
    })
    .returning({ id: feedbackReports.id });

  // noUncheckedIndexedAccess makes this possibly-undefined. An insert with
  // RETURNING always yields a row, so this is defensive rather than expected.
  if (row === undefined) {
    throw new Error("Insert returned no row");
  }
  return row;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && npx vitest run src/services/feedback.test.ts`
Expected: PASS, 7 tests

- [ ] **Step 5: Typecheck and commit**

Run: `cd backend && npm run typecheck`

```bash
git add backend/src/services/feedback.ts backend/src/services/feedback.test.ts
git commit -m "feat(backend): add feedback service with IP truncation"
```

---

### Task 5: `optionalAuth` + the `POST /feedback` route

**Files:**

- Modify: `backend/src/plugins/auth.ts`
- Create: `backend/src/routes/feedback.ts`
- Test: `backend/src/routes/feedback.test.ts`
- Modify: `backend/src/app.ts`

**Interfaces:**

- Consumes: `checkRateLimit` (Task 1), `verifyTurnstileToken`/`isTurnstileConfigured` (Task 2), `createFeedbackReport`/`FEEDBACK_TYPES`/`MIN_MESSAGE_LENGTH`/`MAX_MESSAGE_LENGTH` (Task 4).
- Produces: `optionalAuth` preHandler; `registerFeedbackRoutes(app)`.

- [ ] **Step 1: Add `optionalAuth`**

Append to `backend/src/plugins/auth.ts`:

```ts
/**
 * Populates `request.userId` when a valid bearer token is present, and does
 * nothing at all when it is absent or bad.
 *
 * Separate from requireAuth because that one always 401s without a token,
 * which is right for a private route and wrong for one guests may use. Routes
 * using this MUST treat `request.userId === undefined` as a supported case,
 * not an error.
 *
 * An INVALID token is deliberately treated as no token rather than a 401: the
 * common cause is an access token that expired while a modal sat open, and
 * refusing a bug report over a stale credential — one the reporter cannot even
 * see — would lose the report for no benefit. The submission is simply
 * attributed to nobody.
 */
export async function optionalAuth(request: FastifyRequest): Promise<void> {
  const token = bearerToken(request);
  if (!token) return;

  try {
    const { publicKey } = await getSigningKeys();
    const { payload } = await jwtVerify(token, publicKey, {
      algorithms: [JWT_ALGORITHM],
      issuer: config.JWT_ISSUER,
      audience: config.JWT_AUDIENCE,
    });

    const sub = payload.sub;
    if (!sub) return;
    const userId = base64urlToUuid(sub);
    if (!userId) return;

    request.userId = userId;
    request.userRole = (payload.role as string | undefined) ?? null;
  } catch {
    // Anonymous, not rejected. See the note above.
  }
}
```

- [ ] **Step 2: Write the failing route test**

Create `backend/src/routes/feedback.test.ts`:

```ts
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Route-level tests: the services are mocked, so what is under test is the
 * HTTP contract — status codes, which guard runs first, and what reaches the
 * service layer. The services' own behaviour is covered by their unit tests.
 *
 * Fastify's `app.inject()` exercises the real routing, schema parsing and
 * preHandler chain without opening a socket.
 */
const mockCreateFeedbackReport = vi.fn();
const mockCheckRateLimit = vi.fn();
const mockVerifyTurnstileToken = vi.fn();
const mockIsTurnstileConfigured = vi.fn();

vi.mock("../services/feedback.ts", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../services/feedback.ts")>();
  return {
    ...actual,
    createFeedbackReport: mockCreateFeedbackReport,
  };
});

vi.mock("../services/rateLimit.ts", () => ({
  checkRateLimit: mockCheckRateLimit,
}));

vi.mock("../services/turnstile.ts", () => ({
  verifyTurnstileToken: mockVerifyTurnstileToken,
  isTurnstileConfigured: mockIsTurnstileConfigured,
}));

// Guests are the default subject here; the userId path is covered separately.
vi.mock("../plugins/auth.ts", () => ({
  optionalAuth: vi.fn(async () => {}),
  requireAuth: vi.fn(async () => {}),
  requireApiKey: vi.fn(async () => {}),
}));

const Fastify = (await import("fastify")).default;
const { registerFeedbackRoutes } = await import("./feedback.ts");

let app: FastifyInstance;

const VALID_BODY = {
  type: "bug",
  message: "The map does not load after the third round.",
  turnstileToken: "token-abc",
};

beforeEach(async () => {
  vi.clearAllMocks();
  mockCreateFeedbackReport.mockResolvedValue({ id: "report-1" });
  mockCheckRateLimit.mockResolvedValue({ allowed: true, retryAfterSeconds: 0 });
  mockVerifyTurnstileToken.mockResolvedValue("passed");
  mockIsTurnstileConfigured.mockReturnValue(true);

  app = Fastify();
  await registerFeedbackRoutes(app);
  await app.ready();
});

afterEach(async () => {
  await app.close();
});

async function post(payload: unknown) {
  return app.inject({ method: "POST", url: "/feedback", payload });
}

describe("POST /feedback validation", () => {
  it("stores a valid guest report and returns 201 with an id", async () => {
    const response = await post(VALID_BODY);

    expect(response.statusCode).toBe(201);
    expect(response.json()).toEqual({ id: "report-1" });
  });

  it("rejects a message below the minimum length", async () => {
    const response = await post({ ...VALID_BODY, message: "broken" });

    expect(response.statusCode).toBe(400);
    expect(mockCreateFeedbackReport).not.toHaveBeenCalled();
  });

  it("rejects a message above the maximum length", async () => {
    const response = await post({ ...VALID_BODY, message: "x".repeat(4001) });

    expect(response.statusCode).toBe(400);
  });

  it("rejects an unknown type", async () => {
    const response = await post({ ...VALID_BODY, type: "feature-request" });

    expect(response.statusCode).toBe(400);
  });

  it("accepts idea and other as types", async () => {
    for (const type of ["idea", "other"]) {
      const response = await post({ ...VALID_BODY, type });
      expect(response.statusCode).toBe(201);
    }
  });

  it("trims a message that is only whitespace past the minimum", async () => {
    // "     hi     " is 12 chars but 2 of content. Length is checked after
    // trimming, or padding would defeat the floor entirely.
    const response = await post({ ...VALID_BODY, message: "     hi     " });

    expect(response.statusCode).toBe(400);
  });
});

describe("POST /feedback turnstile", () => {
  it("returns 403 when the token is rejected", async () => {
    mockVerifyTurnstileToken.mockResolvedValue("failed");

    const response = await post(VALID_BODY);

    expect(response.statusCode).toBe(403);
    expect(mockCreateFeedbackReport).not.toHaveBeenCalled();
  });

  it("accepts the report when verification is unavailable", async () => {
    // Fail open: our outage must not close the only feedback channel.
    mockVerifyTurnstileToken.mockResolvedValue("unavailable");

    const response = await post(VALID_BODY);

    expect(response.statusCode).toBe(201);
  });

  it("skips verification entirely when no secret is configured", async () => {
    mockIsTurnstileConfigured.mockReturnValue(false);

    const response = await post({ type: "bug", message: VALID_BODY.message });

    expect(response.statusCode).toBe(201);
    expect(mockVerifyTurnstileToken).not.toHaveBeenCalled();
  });

  it("returns 403 for a guest with no token when configured", async () => {
    mockVerifyTurnstileToken.mockResolvedValue("failed");

    const response = await post({ type: "bug", message: VALID_BODY.message });

    expect(response.statusCode).toBe(403);
  });
});

describe("POST /feedback rate limiting", () => {
  it("returns 429 with Retry-After when limited", async () => {
    mockCheckRateLimit.mockResolvedValue({
      allowed: false,
      retryAfterSeconds: 480,
    });

    const response = await post(VALID_BODY);

    expect(response.statusCode).toBe(429);
    expect(response.headers["retry-after"]).toBe("480");
    expect(response.json().retryAfterSeconds).toBe(480);
    expect(mockCreateFeedbackReport).not.toHaveBeenCalled();
  });

  it("applies the guest limits for an unauthenticated caller", async () => {
    await post(VALID_BODY);

    const [namespace, , tiers] = mockCheckRateLimit.mock.calls[0]!;
    expect(namespace).toBe("feedback");
    expect(tiers).toEqual([
      { limit: 2, windowSeconds: 600 },
      { limit: 5, windowSeconds: 86400 },
    ]);
  });

  it("checks the rate limit before verifying Turnstile", async () => {
    // Cheap local check before a paid network round trip: a flooding client
    // must not be able to make us call Cloudflare once per request.
    mockCheckRateLimit.mockResolvedValue({
      allowed: false,
      retryAfterSeconds: 60,
    });

    await post(VALID_BODY);

    expect(mockVerifyTurnstileToken).not.toHaveBeenCalled();
  });
});

/**
 * The authenticated path. optionalAuth is mocked to populate request.userId,
 * which is exactly what the real one does when a valid bearer token arrives.
 */
describe("POST /feedback for a logged-in user", () => {
  beforeEach(async () => {
    await app.close();
    const auth = await import("../plugins/auth.ts");
    vi.mocked(auth.optionalAuth).mockImplementation(async (request: any) => {
      request.userId = "11111111-1111-1111-1111-111111111111";
    });
    app = Fastify();
    await registerFeedbackRoutes(app);
    await app.ready();
  });

  it("stores the report against the account", async () => {
    await post(VALID_BODY);

    expect(mockCreateFeedbackReport).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "11111111-1111-1111-1111-111111111111",
      }),
    );
  });

  it("skips Turnstile entirely for a member", async () => {
    // A member already has a bannable account, so the challenge buys nothing
    // and only adds a way for a genuine report to fail.
    await post(VALID_BODY);

    expect(mockVerifyTurnstileToken).not.toHaveBeenCalled();
  });

  it("drops contactEmail rather than rejecting it", async () => {
    // Their account is contactable already, so an address here is just
    // another copy of their PII. A 400 would lose the report over a field
    // the user did not even fill in deliberately.
    const response = await post({
      ...VALID_BODY,
      contactEmail: "someone@example.com",
    });

    expect(response.statusCode).toBe(201);
    expect(mockCreateFeedbackReport).toHaveBeenCalledWith(
      expect.objectContaining({ contactEmail: null }),
    );
  });

  it("applies the member limits, not the guest ones", async () => {
    await post(VALID_BODY);

    const [, key, tiers] = mockCheckRateLimit.mock.calls[0]!;
    // Keyed on the account: exact, and unaffected by an IP change or a
    // shared NAT address.
    expect(key).toBe("11111111-1111-1111-1111-111111111111");
    expect(tiers).toEqual([
      { limit: 3, windowSeconds: 600 },
      { limit: 20, windowSeconds: 86400 },
    ]);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd backend && npx vitest run src/routes/feedback.test.ts`
Expected: FAIL — `Cannot find module './feedback.ts'`

- [ ] **Step 4: Write the route**

Create `backend/src/routes/feedback.ts`:

```ts
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { optionalAuth } from "../plugins/auth.ts";
import {
  createFeedbackReport,
  FEEDBACK_TYPES,
  MAX_MESSAGE_LENGTH,
  MIN_MESSAGE_LENGTH,
} from "../services/feedback.ts";
import { checkRateLimit, type RateLimitTier } from "../services/rateLimit.ts";
import {
  isTurnstileConfigured,
  verifyTurnstileToken,
} from "../services/turnstile.ts";

/**
 * POST /feedback — in-game bug reports, ideas and other feedback.
 *
 * Unlike most routes here this one is reachable by guests, because a bug that
 * prevents logging in must still be reportable. That openness is what the
 * Turnstile check and the rate limit pay for.
 *
 * Guard order is deliberate: validate (free) → rate limit (one Redis round
 * trip) → Turnstile (a network call to Cloudflare) → insert. A client flooding
 * us must not be able to make us call Cloudflare once per request.
 */

/**
 * Diagnostics the client collects and shows the user before sending. Loose
 * and fully optional: it is written to a jsonb column that only a human reads,
 * so an unexpected extra field is worth keeping, and a missing one is never
 * worth losing a bug report over.
 */
const FeedbackContextSchema = z
  .object({
    clientVersion: z.string().max(128).optional(),
    userAgent: z.string().max(512).optional(),
    language: z.string().max(32).optional(),
    screen: z.string().max(32).optional(),
    instanceId: z.string().max(64).optional(),
    currentPage: z.string().max(128).optional(),
  })
  .loose();

const FeedbackBodySchema = z.object({
  type: z.enum(FEEDBACK_TYPES),
  // Trimmed BEFORE the length check, or "          " would pass the floor.
  message: z
    .string()
    .transform((value) => value.trim())
    .pipe(z.string().min(MIN_MESSAGE_LENGTH).max(MAX_MESSAGE_LENGTH)),
  // Guests only; dropped for authenticated users below rather than rejected.
  contactEmail: z.email().max(254).nullish(),
  turnstileToken: z.string().max(4096).nullish(),
  context: FeedbackContextSchema.nullish(),
});

/**
 * Guests are tighter than members despite shared-NAT concerns: a guest address
 * sending six reports a day is more likely abuse than a household of genuine
 * reporters, and a real player who hits the wall has an obvious remedy — log
 * in. A member is rate-limited by account, which is exact and unspoofable.
 */
const MEMBER_TIERS: RateLimitTier[] = [
  { limit: 3, windowSeconds: 600 },
  { limit: 20, windowSeconds: 86400 },
];

const GUEST_TIERS: RateLimitTier[] = [
  { limit: 2, windowSeconds: 600 },
  { limit: 5, windowSeconds: 86400 },
];

/**
 * `request.ip` already respects the proxy chain (trustProxy is on in app.ts),
 * so this is the real client address rather than nginx's.
 */
function clientIp(request: FastifyRequest): string | null {
  return request.ip.length > 0 ? request.ip : null;
}

export async function registerFeedbackRoutes(
  app: FastifyInstance,
): Promise<void> {
  app.post(
    "/feedback",
    { preHandler: optionalAuth },
    async (request, reply) => {
      const parsed = FeedbackBodySchema.safeParse(request.body ?? {});
      if (!parsed.success) {
        return reply
          .code(400)
          .send({ error: "invalid_body", issues: parsed.error.issues });
      }

      const body = parsed.data;
      const userId = request.userId ?? null;
      const ip = clientIp(request);

      // Account when we have one: it survives an IP change and cannot be shared
      // by an entire school behind one NAT address. IP is the only handle on a
      // guest, and it is the truncated prefix — the same value we store.
      const limitKey = userId ?? ip ?? "unknown";
      const limit = await checkRateLimit(
        "feedback",
        limitKey,
        userId !== null ? MEMBER_TIERS : GUEST_TIERS,
      );

      if (!limit.allowed) {
        return reply
          .code(429)
          .header("Retry-After", String(limit.retryAfterSeconds))
          .send({
            error: "rate_limited",
            retryAfterSeconds: limit.retryAfterSeconds,
          });
      }

      // Members skip the challenge: they already have a bannable account, so a
      // captcha buys nothing and adds a way for a genuine report to fail.
      if (userId === null && isTurnstileConfigured()) {
        const verdict = await verifyTurnstileToken(
          body.turnstileToken ?? null,
          ip,
        );
        if (verdict === "failed") {
          return reply.code(403).send({ error: "captcha_failed" });
        }
        if (verdict === "unavailable") {
          // Fail open, and say so loudly: a persistent stream of these means
          // the captcha is not actually protecting anything.
          request.log.warn("feedback: turnstile unavailable, accepting anyway");
        }
      }

      try {
        const { id } = await createFeedbackReport({
          userId,
          type: body.type,
          message: body.message,
          // A member's account is already contactable, so an address here adds
          // nothing but another copy of their PII. Dropped rather than 400'd —
          // a stray field is not worth losing the report.
          contactEmail: userId === null ? (body.contactEmail ?? null) : null,
          context: body.context ?? null,
          ip,
        });
        return reply.code(201).send({ id });
      } catch (err) {
        // Unlike join_verify, failing open is not an option: there is nowhere
        // to put the report. Report the failure honestly so the client can tell
        // the user their report was NOT saved.
        request.log.error({ err }, "feedback: insert failed");
        return reply.code(500).send({ error: "internal_error" });
      }
    },
  );
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd backend && npx vitest run src/routes/feedback.test.ts`
Expected: PASS, 17 tests

- [ ] **Step 6: Register the route**

In `backend/src/app.ts`, add the import alongside the others (alphabetical, after `registerCustomTribeRoutes`):

```ts
import { registerFeedbackRoutes } from "./routes/feedback.ts";
```

and the registration after `registerCustomTribeRoutes(app)`:

```ts
await registerFeedbackRoutes(app);
```

- [ ] **Step 7: Verify the whole backend suite still passes**

Run: `cd backend && npm test && npm run typecheck`
Expected: all tests pass, no type errors

- [ ] **Step 8: Commit**

```bash
git add backend/src/routes/feedback.ts backend/src/routes/feedback.test.ts backend/src/plugins/auth.ts backend/src/app.ts
git commit -m "feat(backend): add POST /feedback with rate limiting and Turnstile"
```

---

### Task 6: Extract the reusable Turnstile client helper

**Files:**

- Create: `src/client/Turnstile.ts`
- Modify: `src/client/Main.ts:1256-1292`
- Modify: `index.html`

**Interfaces:**

- Produces:
  ```ts
  export async function getTurnstileToken(
    containerSelector?: string,
  ): Promise<{ token: string; createdAt: number }>;
  ```

The existing helper in `Main.ts` hardcodes `#turnstile-container` (a single global element in `index.html:197`) and calls `alert()` on failure. Rendering a second widget into the same container from the feedback modal would fight the join flow. This task extracts it, adds a container parameter, and replaces the `alert()` with a thrown error the caller can render — the join flow keeps its current user-visible behaviour by handling that error itself.

- [ ] **Step 1: Create the extracted helper**

Create `src/client/Turnstile.ts`:

```ts
import { ClientEnv } from "./ClientEnv";

/**
 * Cloudflare Turnstile token acquisition.
 *
 * Extracted from Main.ts so more than one flow can use it. The container is a
 * parameter because Turnstile renders a real element into it: two flows
 * sharing one container would tear down each other's widget, and the join
 * flow's prefetched token is acquired long before the user might open the
 * feedback modal.
 *
 * Note this throws instead of alert()ing (which is what the original did).
 * A modal has somewhere better to put an error message, and the join flow
 * catches it to preserve its existing behaviour.
 */

declare global {
  interface Window {
    turnstile: any;
  }
}

const SCRIPT_POLL_INTERVAL_MS = 100;
const SCRIPT_POLL_ATTEMPTS = 100; // 10s total — a slow connection, not a dead one.

export const DEFAULT_TURNSTILE_CONTAINER = "#turnstile-container";

export async function getTurnstileToken(
  containerSelector: string = DEFAULT_TURNSTILE_CONTAINER,
): Promise<{ token: string; createdAt: number }> {
  // The script tag is in index.html but loads async, so a caller early in
  // startup can arrive before it is ready.
  let attempts = 0;
  while (
    typeof window.turnstile === "undefined" &&
    attempts < SCRIPT_POLL_ATTEMPTS
  ) {
    await new Promise((resolve) =>
      setTimeout(resolve, SCRIPT_POLL_INTERVAL_MS),
    );
    attempts++;
  }

  if (typeof window.turnstile === "undefined") {
    throw new Error("Failed to load Turnstile script");
  }

  const widgetId = window.turnstile.render(containerSelector, {
    sitekey: ClientEnv.turnstileSiteKey(),
    size: "normal",
    // Stays invisible unless Cloudflare actually wants a challenge.
    appearance: "interaction-only",
    theme: "light",
  });

  return new Promise((resolve, reject) => {
    window.turnstile.execute(widgetId, {
      callback: (token: string) => {
        window.turnstile.remove(widgetId);
        resolve({ token, createdAt: Date.now() });
      },
      "error-callback": (errorCode: string) => {
        window.turnstile.remove(widgetId);
        reject(new Error(`Turnstile failed: ${errorCode}`));
      },
    });
  });
}
```

- [ ] **Step 2: Remove the old helper from Main.ts**

Delete the entire `async function getTurnstileToken()` declaration at the bottom of `src/client/Main.ts` (starting at line 1256, `async function getTurnstileToken(): Promise<{`, through its closing brace). Also delete the now-duplicated `declare global { interface Window { turnstile: any } }` block around line 101 if it declares only `turnstile` — if it declares other properties too, remove just the `turnstile: any;` line.

Add the import at the top of `Main.ts` with the other `./` imports:

```ts
import { getTurnstileToken } from "./Turnstile";
```

- [ ] **Step 3: Preserve the join flow's alert behaviour**

The old helper alerted on error. Now it throws, so the join flow must alert itself. In `src/client/Main.ts`, the two call sites are inside `private async getTurnstileToken(...)` (around lines 1196 and 1214), which call the module-level function. Wrap each `return (await getTurnstileToken())?.token ?? null;` as:

```ts
try {
  return (await getTurnstileToken()).token;
} catch (err) {
  console.error("Turnstile error", err);
  alert(
    `Turnstile error: ${(err as Error).message}. Please refresh and try again.`,
  );
  return null;
}
```

Also update the prefetch at line ~261, which must not throw an unhandled rejection:

```ts
this.turnstileTokenPromise =
  ClientEnv.instanceId() === "desktop"
    ? null
    : getTurnstileToken().catch((err) => {
        console.error("Turnstile prefetch failed", err);
        return null;
      });
```

Widen the field's type at line ~192 to allow the null this can now produce:

```ts
  private turnstileTokenPromise: Promise<{
    token: string;
    createdAt: number;
  } | null> | null;
```

Then at the consumption site (~line 1199), handle a null resolution: `const token = await this.turnstileTokenPromise;` is already followed by a null check in the existing code — verify it is, and if it only checks `token === null` on the outer promise, ensure `token?.token ?? null` is used for the inner value.

- [ ] **Step 4: Add a second Turnstile container to index.html**

In `index.html`, immediately after the existing `#turnstile-container` div (line ~197), add:

```html
<div
  id="feedback-turnstile-container"
  class="fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 z-99999"
></div>
```

A separate element so the feedback modal's widget cannot collide with the join flow's prefetched one.

- [ ] **Step 5: Verify the build and lint**

Run: `npx tsc --noEmit` then `npm run lint`
Expected: no new errors

- [ ] **Step 6: Commit**

```bash
git add src/client/Turnstile.ts src/client/Main.ts index.html
git commit -m "refactor(client): extract reusable Turnstile token helper"
```

---

### Task 7: Feedback API client

**Files:**

- Create: `src/client/FeedbackApi.ts`

**Interfaces:**

- Consumes: `getApiBase` from `./Api`, `getAuthHeader`/`userAuth` from `./Auth`, `ClientEnv` from `./ClientEnv`, `getTurnstileToken` from `./Turnstile` (Task 6).
- Produces:

  ```ts
  export type FeedbackType = "bug" | "idea" | "other";
  export interface FeedbackContext {
    clientVersion?: string;
    userAgent?: string;
    language?: string;
    screen?: string;
    instanceId?: string;
    currentPage?: string;
  }
  export function collectFeedbackContext(currentPage: string): FeedbackContext;
  export type SubmitFeedbackResult =
    | { ok: true; id: string }
    | { ok: false; kind: "rate_limited"; retryAfterSeconds: number }
    | { ok: false; kind: "captcha_failed" | "invalid" | "network" | "server" };
  export async function submitFeedback(input: {
    type: FeedbackType;
    message: string;
    contactEmail: string | null;
    context: FeedbackContext;
    turnstileToken: string | null;
  }): Promise<SubmitFeedbackResult>;
  ```

- [ ] **Step 1: Write the client**

Create `src/client/FeedbackApi.ts`:

```ts
import { getApiBase } from "./Api";
import { getAuthHeader } from "./Auth";
import { ClientEnv } from "./ClientEnv";

/**
 * Client for POST /feedback.
 *
 * Returns a discriminated result rather than throwing, because every failure
 * here has a distinct thing to tell the user — "wait 8 minutes" and "the
 * captcha did not pass" are not interchangeable, and a thrown Error would
 * flatten them into one message.
 */

export type FeedbackType = "bug" | "idea" | "other";

export interface FeedbackContext {
  clientVersion?: string;
  userAgent?: string;
  language?: string;
  screen?: string;
  instanceId?: string;
  currentPage?: string;
}

export type SubmitFeedbackResult =
  | { ok: true; id: string }
  | { ok: false; kind: "rate_limited"; retryAfterSeconds: number }
  | { ok: false; kind: "captcha_failed" | "invalid" | "network" | "server" };

/**
 * Diagnostics attached to every report. Shown to the user in the modal before
 * sending — collecting this silently would be the wrong trade for a field
 * whose whole purpose is trust.
 *
 * Deliberately excludes game state and replay data (large, and a bug report
 * should not quietly ship a match transcript) and the IP (the backend takes
 * that from the connection, where it cannot be forged).
 */
export function collectFeedbackContext(currentPage: string): FeedbackContext {
  return {
    // The single most useful field: it turns "it broke" into a specific build.
    clientVersion: ClientEnv.gitCommit(),
    userAgent: navigator.userAgent,
    language: navigator.language,
    screen: `${window.screen.width}x${window.screen.height}`,
    // web | desktop | crazygames — very different environments.
    instanceId: ClientEnv.instanceId(),
    currentPage,
  };
}

export async function submitFeedback(input: {
  type: FeedbackType;
  message: string;
  contactEmail: string | null;
  context: FeedbackContext;
  turnstileToken: string | null;
}): Promise<SubmitFeedbackResult> {
  let response: Response;
  try {
    response = await fetch(`${getApiBase()}/feedback`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        // Empty for a guest; the backend's optionalAuth treats that as
        // anonymous rather than as an error.
        Authorization: await getAuthHeader(),
      },
      body: JSON.stringify({
        type: input.type,
        message: input.message,
        contactEmail: input.contactEmail,
        turnstileToken: input.turnstileToken,
        context: input.context,
      }),
    });
  } catch {
    return { ok: false, kind: "network" };
  }

  if (response.status === 201) {
    try {
      const body = (await response.json()) as { id?: string };
      return { ok: true, id: body.id ?? "" };
    } catch {
      // Stored, but we could not read the id back. Reporting failure would be
      // worse than a missing id: the user would send it again.
      return { ok: true, id: "" };
    }
  }

  if (response.status === 429) {
    // Prefer the body's value, fall back to the header, then to a sane
    // default — the user needs *some* number to act on.
    let retryAfterSeconds = 0;
    try {
      const body = (await response.json()) as { retryAfterSeconds?: number };
      retryAfterSeconds = body.retryAfterSeconds ?? 0;
    } catch {
      retryAfterSeconds = 0;
    }
    if (retryAfterSeconds <= 0) {
      retryAfterSeconds = Number.parseInt(
        response.headers.get("Retry-After") ?? "600",
        10,
      );
    }
    return {
      ok: false,
      kind: "rate_limited",
      retryAfterSeconds: Number.isFinite(retryAfterSeconds)
        ? retryAfterSeconds
        : 600,
    };
  }

  if (response.status === 403) return { ok: false, kind: "captcha_failed" };
  if (response.status === 400) return { ok: false, kind: "invalid" };
  return { ok: false, kind: "server" };
}
```

- [ ] **Step 2: Verify `ClientEnv.gitCommit()` exists**

Run: `grep -n "gitCommit\|instanceId" src/client/ClientEnv.ts`

Expected: both static accessors exist. If `gitCommit()` does not exist, check what the equivalent is (search `GIT_COMMIT` in `src/client/`) and use that accessor instead — do not invent one.

- [ ] **Step 3: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors

- [ ] **Step 4: Commit**

```bash
git add src/client/FeedbackApi.ts
git commit -m "feat(client): add feedback API client"
```

---

### Task 8: Translation keys

**Files:**

- Modify: `resources/lang/en.json`

- [ ] **Step 1: Add the keys**

In `resources/lang/en.json`, add a `"feedback_modal"` object. Keys within the file are alphabetically sorted at the top level — place it accordingly (after `"error_modal"`/before `"flag_input"`, wherever alphabetical order puts it):

```json
  "feedback_modal": {
    "title": "Send feedback",
    "intro": "Found a bug or have an idea? Tell us here.",
    "type_bug": "Bug",
    "type_idea": "Idea",
    "type_other": "Other",
    "message_label": "What happened?",
    "message_placeholder": "Describe the problem or idea. For a bug, what you did just before it happened is the most useful thing you can tell us.",
    "message_too_short": "Please add a little more detail (at least 10 characters).",
    "email_label": "Your email (optional)",
    "email_placeholder": "you@example.com",
    "email_hint": "Only needed if you want a reply.",
    "technical_details": "Technical details attached",
    "submit": "Send report",
    "submitting": "Sending…",
    "success": "Thanks — your report was received.",
    "error_rate_limited": "You've sent several reports recently. Please try again in {minutes, plural, one {# minute} other {# minutes}}.",
    "error_captcha": "The security check didn't pass. Please close this and try again.",
    "error_network": "Could not reach the server. Check your connection and try again.",
    "error_server": "Something went wrong on our side and your report was not saved. Please try again later.",
    "error_invalid": "Please check the form and try again."
  },
```

Also add to the existing `"help_modal"` object (alphabetically within it):

```json
    "feedback_desc": "Report a bug or send us an idea.",
```

and to the existing `"main"` object:

```json
    "feedback": "Send feedback",
    "go_to_feedback": "Send feedback",
```

Note `error_server` explicitly says the report was **not** saved — the user must know to keep the information rather than assume it is filed.

- [ ] **Step 2: Verify the JSON parses**

Run: `node -e "JSON.parse(require('fs').readFileSync('resources/lang/en.json','utf8')); console.log('ok')"`
Expected: `ok`

- [ ] **Step 3: Confirm no other language file was touched**

Run: `git status --short resources/lang/`
Expected: only `en.json` is modified. Any other file appearing here is a mistake — revert it.

- [ ] **Step 4: Commit**

```bash
git add resources/lang/en.json
git commit -m "feat(i18n): add feedback modal strings"
```

---

### Task 9: Feedback modal

**Files:**

- Create: `src/client/FeedbackModal.ts`
- Modify: `src/client/Main.ts`
- Modify: `src/client/HelpModal.ts`
- Modify: `index.html`

**Interfaces:**

- Consumes: `BaseModal`, `modalHeader`, `translateText`, `submitFeedback`/`collectFeedbackContext` (Task 7), `getTurnstileToken` (Task 6).

- [ ] **Step 1: Write the modal**

Create `src/client/FeedbackModal.ts`:

```ts
import { html, TemplateResult } from "lit";
import { customElement, state } from "lit/decorators.js";
import { translateText } from "../client/Utils";
import { BaseModal } from "./components/BaseModal";
import { modalHeader } from "./components/ui/ModalHeader";
import {
  collectFeedbackContext,
  type FeedbackType,
  submitFeedback,
  type SubmitFeedbackResult,
} from "./FeedbackApi";
import { getTurnstileToken } from "./Turnstile";
import { userAuth } from "./Auth";

/**
 * In-game feedback, bug reports and ideas.
 *
 * Guests may submit — a bug that prevents logging in has to be reportable —
 * so guests (and only guests) solve a Turnstile challenge before the request
 * goes out. Members are identified by their account instead.
 */

const MIN_MESSAGE_LENGTH = 10;
const MAX_MESSAGE_LENGTH = 4000;

/**
 * Its own container element, separate from the join flow's. Turnstile renders
 * a real widget into whatever it is given; sharing one node would let the two
 * flows tear down each other's widget.
 */
const TURNSTILE_CONTAINER = "#feedback-turnstile-container";

type Status =
  | { kind: "idle" }
  | { kind: "submitting" }
  | { kind: "success" }
  | { kind: "error"; message: string };

@customElement("feedback-modal")
export class FeedbackModal extends BaseModal {
  protected routerName = "feedback";

  @state() private type: FeedbackType = "bug";
  @state() private message = "";
  @state() private email = "";
  @state() private status: Status = { kind: "idle" };
  @state() private isLoggedIn = false;
  @state() private showTechnicalDetails = false;

  protected modalConfig() {
    return { maxWidth: "42rem" };
  }

  protected async onOpen(): Promise<void> {
    // Reset on every open: a stale success banner or a previous draft would
    // both be confusing.
    this.status = { kind: "idle" };
    this.message = "";
    this.email = "";
    this.type = "bug";
    this.isLoggedIn = (await userAuth()) !== false;
  }

  private get trimmedMessage(): string {
    return this.message.trim();
  }

  private get canSubmit(): boolean {
    return (
      this.status.kind !== "submitting" &&
      this.trimmedMessage.length >= MIN_MESSAGE_LENGTH &&
      this.trimmedMessage.length <= MAX_MESSAGE_LENGTH
    );
  }

  private async onSubmit(): Promise<void> {
    if (!this.canSubmit) return;
    this.status = { kind: "submitting" };

    // Guests only. A member already has a bannable account, so a challenge
    // costs them a failure mode and buys us nothing.
    let turnstileToken: string | null = null;
    if (!this.isLoggedIn) {
      try {
        turnstileToken = (await getTurnstileToken(TURNSTILE_CONTAINER)).token;
      } catch {
        this.status = {
          kind: "error",
          message: translateText("feedback_modal.error_captcha"),
        };
        return;
      }
    }

    const result = await submitFeedback({
      type: this.type,
      message: this.trimmedMessage,
      contactEmail: this.email.trim().length > 0 ? this.email.trim() : null,
      context: collectFeedbackContext(this.routerName),
      turnstileToken,
    });

    if (result.ok) {
      this.status = { kind: "success" };
      this.message = "";
      this.email = "";
      return;
    }

    this.status = { kind: "error", message: this.errorMessage(result) };
  }

  private errorMessage(
    result: Extract<SubmitFeedbackResult, { ok: false }>,
  ): string {
    switch (result.kind) {
      case "rate_limited": {
        // Round UP and floor at 1: telling someone to retry in "0 minutes"
        // would be nonsense, and rounding down would send them back early to
        // another refusal. The en.json string uses ICU plural syntax, so
        // "1 minute" vs "5 minutes" is handled by the formatter rather than
        // by branching here — which also keeps it correct in languages whose
        // plural rules are not English's.
        const minutes = Math.max(1, Math.ceil(result.retryAfterSeconds / 60));
        return translateText("feedback_modal.error_rate_limited", { minutes });
      }
      case "captcha_failed":
        return translateText("feedback_modal.error_captcha");
      case "network":
        return translateText("feedback_modal.error_network");
      case "invalid":
        return translateText("feedback_modal.error_invalid");
      case "server":
        return translateText("feedback_modal.error_server");
    }
  }

  private renderTypeButton(type: FeedbackType, labelKey: string) {
    const selected = this.type === type;
    return html`
      <button
        type="button"
        class="px-4 py-2 border transition-colors ${selected
          ? "bg-lt-accent border-lt-accent text-lt-900"
          : "bg-lt-800 border-lt-600 text-lt-100 hover:border-lt-accent"}"
        aria-pressed=${selected}
        @click=${() => {
          this.type = type;
        }}
      >
        ${translateText(labelKey)}
      </button>
    `;
  }

  private renderTechnicalDetails(): TemplateResult {
    const context = collectFeedbackContext(this.routerName);
    return html`
      <div class="mt-4">
        <button
          type="button"
          class="text-sm text-lt-300 underline"
          @click=${() => {
            this.showTechnicalDetails = !this.showTechnicalDetails;
          }}
        >
          ${translateText("feedback_modal.technical_details")}
        </button>
        ${this.showTechnicalDetails
          ? html`
              <pre
                class="mt-2 p-3 bg-lt-900 border border-lt-700 text-xs text-lt-300 overflow-x-auto whitespace-pre-wrap"
              >
${JSON.stringify(context, null, 2)}</pre
              >
            `
          : null}
      </div>
    `;
  }

  protected renderContent(): TemplateResult {
    const length = this.trimmedMessage.length;

    return html`
      ${modalHeader({
        title: translateText("feedback_modal.title"),
        onBack: () => this.close(),
      })}
      <div class="p-4 lg:p-6">
        <p class="text-lt-300 mb-4">${translateText("feedback_modal.intro")}</p>

        <div class="flex gap-2 mb-4">
          ${this.renderTypeButton("bug", "feedback_modal.type_bug")}
          ${this.renderTypeButton("idea", "feedback_modal.type_idea")}
          ${this.renderTypeButton("other", "feedback_modal.type_other")}
        </div>

        <label class="block text-lt-100 mb-1" for="feedback-message">
          ${translateText("feedback_modal.message_label")}
        </label>
        <textarea
          id="feedback-message"
          rows="6"
          maxlength=${MAX_MESSAGE_LENGTH}
          class="w-full p-3 bg-lt-900 border border-lt-600 text-lt-100 focus:border-lt-accent outline-none"
          placeholder=${translateText("feedback_modal.message_placeholder")}
          .value=${this.message}
          @input=${(e: Event) => {
            this.message = (e.target as HTMLTextAreaElement).value;
          }}
        ></textarea>
        <div class="text-xs text-lt-400 text-right">
          ${length} / ${MAX_MESSAGE_LENGTH}
        </div>

        ${this.isLoggedIn
          ? null
          : html`
              <label class="block text-lt-100 mt-4 mb-1" for="feedback-email">
                ${translateText("feedback_modal.email_label")}
              </label>
              <input
                id="feedback-email"
                type="email"
                class="w-full p-3 bg-lt-900 border border-lt-600 text-lt-100 focus:border-lt-accent outline-none"
                placeholder=${translateText("feedback_modal.email_placeholder")}
                .value=${this.email}
                @input=${(e: Event) => {
                  this.email = (e.target as HTMLInputElement).value;
                }}
              />
              <div class="text-xs text-lt-400 mt-1">
                ${translateText("feedback_modal.email_hint")}
              </div>
            `}
        ${this.renderTechnicalDetails()}
        ${this.status.kind === "success"
          ? html`<div class="mt-4 p-3 border border-green-600 text-green-400">
              ${translateText("feedback_modal.success")}
            </div>`
          : null}
        ${this.status.kind === "error"
          ? html`<div class="mt-4 p-3 border border-red-600 text-red-400">
              ${this.status.message}
            </div>`
          : null}

        <button
          type="button"
          class="mt-4 w-full py-3 bg-lt-accent text-lt-900 disabled:opacity-50 disabled:cursor-not-allowed"
          ?disabled=${!this.canSubmit}
          @click=${() => void this.onSubmit()}
        >
          ${this.status.kind === "submitting"
            ? translateText("feedback_modal.submitting")
            : translateText("feedback_modal.submit")}
        </button>
      </div>
    `;
  }
}
```

- [ ] **Step 2: Add the element to index.html**

In `index.html`, next to the `<help-modal>` block (line ~287), add:

```html
<feedback-modal
  id="page-feedback"
  inline
  class="hidden w-full h-full page-content relative z-50"
></feedback-modal>
```

- [ ] **Step 3: Register the modal in Main.ts**

Add the import with the other modal imports:

```ts
import { FeedbackModal } from "./FeedbackModal";
```

and the registration next to the `help` registration (~line 228):

```ts
modalRouter.register("feedback", {
  tag: "feedback-modal",
  pageId: "page-feedback",
});
```

Confirm `FeedbackModal` is referenced somewhere (the import must not be elided as unused — if lint complains, the registration alone may not count as a reference; in that case use `void FeedbackModal;` next to the other modal imports, matching how `HelpModal` is kept alive at `Main.ts:360`).

- [ ] **Step 4: Add the entry point to HelpModal**

In `src/client/HelpModal.ts`, copy the existing Troubleshooting section block (around lines 125–170) and add an equivalent Feedback section directly after it, using `feedback_modal.title` for the heading, `help_modal.feedback_desc` for the description, `main.go_to_feedback` for the button label, `id="feedback-button"`, and `data-page="page-feedback"`.

Add the handler method next to `openTroubleshooting()` (~line 1235):

```ts
  openFeedback() {
    const feedbackModal = document.querySelector(
      "feedback-modal",
    ) as FeedbackModal;
    if (!feedbackModal || !(feedbackModal instanceof FeedbackModal)) {
      console.warn("Feedback modal element not found");
      return;
    }
    feedbackModal.open();
  }
```

and the import:

```ts
import { FeedbackModal } from "./FeedbackModal";
```

- [ ] **Step 5: Typecheck and lint**

Run: `npx tsc --noEmit && npm run lint`
Expected: no errors. If `renderContent`/`onOpen` signatures mismatch `BaseModal`, read `src/client/components/BaseModal.ts` and match the real abstract signatures — do not change the base class.

- [ ] **Step 6: Verify in the running game**

Use the `run-openfront` skill to start the game and:

1. Open the Help modal, click the feedback button — the modal opens.
2. Type fewer than 10 characters — submit stays disabled.
3. Expand "Technical details" — the JSON payload is visible.
4. Submit as a guest with the backend running — a 201 and the success message.
5. Submit three more times quickly — a 429 with the real minutes.

If the backend is not running, verify 1–3 and note that 4–5 were not checked.

- [ ] **Step 7: Commit**

```bash
git add src/client/FeedbackModal.ts src/client/Main.ts src/client/HelpModal.ts index.html
git commit -m "feat(client): add feedback and bug report modal"
```

---

### Task 10: Wire real Turnstile into join verification

**Files:**

- Modify: `backend/src/services/joinVerify.ts`
- Modify: `backend/src/services/joinVerify.test.ts`

The existing `verifyTurnstile` there is a documented no-op whose comment says the check belongs there once a secret exists. It now does. Behaviour is unchanged when no secret is configured — this only makes the check real when one is present.

- [ ] **Step 1: Update the existing test**

In `backend/src/services/joinVerify.test.ts`, replace the `describe("turnstile", ...)` block (around line 135) with:

```ts
describe("turnstile", () => {
  /**
   * The no-op is gone: verification now delegates to services/turnstile.ts.
   * What must NOT change is the fail-open contract — a join is never refused
   * because we could not reach Cloudflare, and a null token (a reconnect
   * whose single-use token is already spent) skips siteverify entirely.
   */
  it("skips verification for a null token", async () => {
    // A re-admit has no token to redeem. Calling siteverify with null would
    // be a guaranteed rejection of a player who is already legitimately in.
    expect(await verifyTurnstile(null, null)).toBe("skipped");
  });

  it("reports unavailable when no secret is configured", async () => {
    // Default dev config has no TURNSTILE_SECRET_KEY.
    expect(await verifyTurnstile("some-token", null)).toBe("unavailable");
  });
});
```

Update the import at the top of that file if the signature changed — `verifyTurnstile` is still exported from `./joinVerify.ts`.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && npx vitest run src/services/joinVerify.test.ts`
Expected: FAIL — the current `verifyTurnstile` returns `null`, not `"skipped"`.

- [ ] **Step 3: Replace the no-op**

In `backend/src/services/joinVerify.ts`, replace the `verifyTurnstile` function (lines ~90–109) with:

```ts
/**
 * Turnstile verification for a join.
 *
 * Delegates to services/turnstile.ts, which performs the real siteverify call
 * when a TURNSTILE_SECRET_KEY is configured. This replaces the deliberate
 * no-op that lived here while no secret existed.
 *
 * "skipped" is distinct from "unavailable": a null token means the game server
 * is re-verifying an already-admitted reconnect whose single-use token is
 * spent, and it expects us to skip siteverify entirely. Passing that null to
 * Cloudflare would reject a player who is legitimately already in the match.
 */
export async function verifyTurnstile(
  token: string | null,
  ip: string | null,
): Promise<TurnstileVerdict | "skipped"> {
  if (token === null) return "skipped";
  return await verifyTurnstileToken(token, ip);
}
```

Add the import at the top of the file:

```ts
import { type TurnstileVerdict, verifyTurnstileToken } from "./turnstile.ts";
```

- [ ] **Step 4: Use the verdict at the call site**

Inside `verifyJoin` (which is already `async`), replace these three lines — currently a bare, non-awaited call whose result is discarded:

```ts
// No verdict is available (see verifyTurnstile) — the token is not a reason
// to refuse anyone today.
verifyTurnstile(input.token);
```

with:

```ts
// FAIL OPEN, deliberately and unchanged. A rejected token is logged but does
// NOT refuse the join: this endpoint sits in the join path of every player,
// and Cloudflare having a bad day must not become a game-wide outage. The
// ban check below is the one that actually decides anything.
const turnstileVerdict = await verifyTurnstile(input.token, input.ip);
if (turnstileVerdict === "failed") {
  console.warn(
    `join_verify: turnstile rejected a token for "${input.username}" — allowing anyway (fail-open)`,
  );
}
```

Note this makes the enclosing function's Turnstile step `await`ed where it previously was not — confirm `verifyJoin` is already `async` (it is; the route `await`s it).

- [ ] **Step 5: Update the file's header comment**

At the top of `joinVerify.ts`, replace item 1 of the "WHAT WE ACTUALLY CHECK" list (lines ~20–28) with:

```
 * 1. Turnstile / captcha — VERIFIED when a TURNSTILE_SECRET_KEY is configured,
 *    via services/turnstile.ts. The verdict is logged but never refuses a
 *    join: see the fail-open note at the call site. With no secret configured
 *    (the default in development) the verdict is "unavailable" and nothing
 *    changes from the behaviour that was here before.
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `cd backend && npx vitest run src/services/joinVerify.test.ts`
Expected: PASS

- [ ] **Step 7: Run the whole backend suite**

Run: `cd backend && npm test && npm run typecheck`
Expected: all pass

- [ ] **Step 8: Commit**

```bash
git add backend/src/services/joinVerify.ts backend/src/services/joinVerify.test.ts
git commit -m "feat(backend): verify Turnstile tokens in join verification"
```

---

### Task 11: Documentation

**Files:**

- Modify: `backend/README.md`
- Modify: `docs/DEPLOY.md`

- [ ] **Step 1: Add the endpoint to the backend README**

In `backend/README.md`, add to the endpoints table (after the join verification row):

```markdown
| POST | `/feedback` | Optional | Bug reports and ideas; Turnstile + rate limited |
```

And in the Roadmap/implemented section, add a line noting feedback is implemented.

- [ ] **Step 2: Document the secret in DEPLOY.md**

`docs/DEPLOY.md:38` already documents `TURNSTILE_SITE_KEY`. Add directly below it:

```markdown
| `TURNSTILE_SECRET_KEY` | the private half of the Turnstile pair, set on the **backend** (not the game server). Leave unset to skip verification entirely — guests can still submit feedback, and join verification behaves exactly as before. |
```

- [ ] **Step 3: Commit**

```bash
git add backend/README.md docs/DEPLOY.md
git commit -m "docs: document the feedback endpoint and Turnstile secret"
```

---

## Verification

After all tasks:

- [ ] `cd backend && npm test` — all backend tests pass
- [ ] `cd backend && npm run typecheck` — no type errors
- [ ] `npm test` (repo root) — no game tests broken by the Turnstile refactor
- [ ] `npx tsc --noEmit` (repo root) — no client type errors
- [ ] `npm run lint` — clean
- [ ] `git status --short resources/lang/` — only `en.json` modified
- [ ] Manual: join a singleplayer game to confirm the Turnstile refactor did not break the join flow
- [ ] Manual: submit feedback as a guest and as a logged-in user; confirm rows land in `feedback_reports` with `status = 'new'` and a truncated `submitter_ip`
