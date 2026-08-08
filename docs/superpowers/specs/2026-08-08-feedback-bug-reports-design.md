# Feedback & Bug Reports — Design

Date: 2026-08-08
Status: Approved, ready for implementation planning

## Problem

Players have no in-game way to report a bug or suggest an idea. The only
existing channel is the GitHub issue template, which requires a GitHub account
and is invisible from inside the game.

The endpoint must be open to guests (most players in a lobby are not logged
in), which makes it a spam target. It therefore needs both a captcha and a rate
limit before it can exist at all.

## Decisions

| Decision          | Choice                                   | Rationale                                                                                                       |
| ----------------- | ---------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Storage           | Postgres only, no external delivery      | An admin area is planned; reports get a `status` and are triaged there. No webhook/GitHub/email secret to hold. |
| Who may submit    | Everyone; auth optional                  | A bug that prevents login must still be reportable.                                                             |
| Captcha           | Turnstile, guests only                   | Logged-in users already have a bannable account; a challenge buys nothing and adds a failure mode.              |
| Rate-limit key    | `userId` when present, else truncated IP | userId is exact and unspoofable. IP is the only handle on a guest.                                              |
| Limit exceeded    | 429 + `Retry-After` + honest message     | A feedback form that silently discards feedback defeats its own purpose.                                        |
| Redis unavailable | Fail open                                | A Redis blip must not block all feedback on a low-value-target endpoint.                                        |

## Architecture

```
Client                          Backend
──────                          ───────
FeedbackModal                   POST /feedback
  ├ type: bug | idea | other      ├ optionalAuth        → userId | null
  ├ message (required)            ├ verifyTurnstile()   → guests only
  ├ email (optional, guests)      ├ checkRateLimit()    → Redis, userId ?? ip
  └ auto-context                  └ insertReport()      → Postgres
                                       ↓
                                  feedback_reports (status: 'new')
                                       ↓
                                  future admin area: triage
```

### Files

| File                                | Purpose                                                    |
| ----------------------------------- | ---------------------------------------------------------- |
| `backend/src/routes/feedback.ts`    | Route, Zod body schema, HTTP semantics                     |
| `backend/src/services/feedback.ts`  | Insert + read; no HTTP knowledge                           |
| `backend/src/services/turnstile.ts` | Real `siteverify` — replaces the no-op                     |
| `backend/src/services/rateLimit.ts` | Generic Redis limiter, not feedback-specific               |
| `backend/src/plugins/auth.ts`       | Add `optionalAuth` alongside `requireAuth`                 |
| `backend/src/db/schema.ts`          | Add `feedbackReports` table                                |
| `backend/src/app.ts`                | Register the new routes                                    |
| `backend/src/config.ts`             | Add `TURNSTILE_SECRET_KEY` (optional)                      |
| `src/client/FeedbackModal.ts`       | Lit modal, extends `BaseModal`                             |
| `src/client/FeedbackApi.ts`         | Fetch wrapper, mirrors `ClanApi.ts`                        |
| `src/client/Main.ts`                | Register modal in `modalRouter`; refactor Turnstile helper |
| `src/client/HelpModal.ts`           | Entry-point button                                         |
| `resources/lang/en.json`            | New translation keys (English only)                        |

The rate limiter and the Turnstile verifier are generic and independent of
feedback. Both will be wanted on other endpoints, and neither should have to be
untangled from a feedback-shaped abstraction later.

## Database schema

```ts
export const feedbackReports = pgTable(
  "feedback_reports",
  {
    id: uuid("id").primaryKey().defaultRandom(),

    // Nullable: guests submit too. Set null rather than deleted if the account
    // goes away — the report stays useful, the link doesn't.
    userId: uuid("user_id").references(() => users.id, {
      onDelete: "set null",
    }),

    type: text("type").notNull(), // 'bug' | 'idea' | 'other'
    status: text("status").notNull().default("new"),
    // 'new' | 'triaged' | 'resolved' | 'rejected'
    message: text("message").notNull(),

    // Guests only, optional. Their sole route to a reply.
    contactEmail: text("contact_email"),

    // Auto-collected context, JSON so the shape can grow without a migration.
    context: jsonb("context"),

    // Truncated to /24 (IPv4) or /48 (IPv6). For abuse investigation only.
    submitterIp: text("submitter_ip"),

    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    // The admin area's default view: newest unhandled first.
    index("feedback_reports_status_created_idx").on(
      table.status,
      table.createdAt,
    ),
    index("feedback_reports_user_idx").on(table.userId),
  ],
);
```

- `type`/`status` are `text`, not pg enums: matches the existing schema style,
  and adding a status value once the admin area exists must not need a
  migration. Zod validates the values at the boundary.
- `context` is `jsonb`: the diagnostic shape will change; a column per field
  means a migration each time. Only a human reads it.
- `submitterIp` is truncated: enough to correlate abuse, and keeps a table that
  will accumulate for years from becoming a pile of identifying addresses.
- `updatedAt` is **not** auto-updated by a trigger. The admin area sets it on
  status change.

## API

### `POST /feedback`

Auth: optional (`optionalAuth`).

Request:

```jsonc
{
  "type": "bug", // 'bug' | 'idea' | 'other'
  "message": "…", // 10–4000 chars
  "contactEmail": "a@b.c", // optional, guests only, ignored if logged in
  "turnstileToken": "…", // required for guests when a secret is configured
  "context": {
    // all fields optional
    "clientVersion": "abc1234",
    "userAgent": "…",
    "language": "de",
    "screen": "1920x1080",
    "instanceId": "web",
    "currentPage": "help",
  },
}
```

Responses:

| Status              | Meaning                                                                        |
| ------------------- | ------------------------------------------------------------------------------ |
| 201 `{ id }`        | Stored                                                                         |
| 400                 | Body failed validation                                                         |
| 403                 | Turnstile token rejected, or absent while a secret is configured (guests only) |
| 429 + `Retry-After` | Rate limited; body carries a human message                                     |

A guest request with **no** `turnstileToken` is a 403 only when
`TURNSTILE_SECRET_KEY` is configured. With no secret there is nothing to verify
against, so the token is not required and the report is accepted — the same
fail-open rule as an unreachable siteverify. This keeps a local dev backend and
a self-hosted instance without Cloudflare fully working.
| 500 | Unexpected; nothing stored |

The 10-character message floor rejects "test" and "asd". The 4000 ceiling is
generous for a real bug report and bounds the row.

`contactEmail` is ignored for logged-in users rather than rejected — their
account is already contactable, and a 400 over a harmless extra field would be
a worse experience than dropping it.

## Rate limiting

Two windows per key, both must pass:

| Tier  | Logged-in  | Guest      |
| ----- | ---------- | ---------- |
| Burst | 3 / 10 min | 2 / 10 min |
| Daily | 20 / day   | 5 / day    |

Guests are tighter despite shared-NAT concerns: a guest IP submitting 6+ reports
a day is more likely abuse than a household of legitimate reporters, and a real
player who hits the wall has an obvious remedy — log in.

Implementation: Redis `INCR` + `EXPIRE` on first increment, key
`ratelimit:feedback:<tier>:<userId|ipPrefix>`. On any Redis error the limiter
returns "allowed" and logs a warning — fail open, as decided.

Both tiers are checked before either is incremented, so a request refused by the
daily limit does not consume burst budget.

The 429 body carries the real remaining minutes, derived from the key's TTL, so
the client can render an actionable message rather than a generic refusal. When
both tiers are exceeded, `Retry-After` reports the **longer** of the two TTLs —
the earlier one would promise a retry that is still going to be refused.

## Turnstile

`backend/src/services/turnstile.ts` calls Cloudflare `siteverify` with
`TURNSTILE_SECRET_KEY`, the token, and the client IP.

Return type is a three-state verdict, not a boolean:

- `"passed"` — verified
- `"failed"` — token rejected by Cloudflare
- `"unavailable"` — no secret configured, or siteverify unreachable/timed out

Three states because the caller must distinguish "Cloudflare said no" from "we
could not ask". A 3-second timeout applies; a hanging siteverify must not hang
a report.

Policy per caller:

- **Feedback**: `failed` → 403. `unavailable` → allow (fail open). A misconfigured
  or unreachable Cloudflare must not silently close the only feedback channel.
- **Join verify**: unchanged fail-open behaviour, but now performs a real check
  when a secret exists.

`joinVerify.ts` currently contains a long comment stating that Turnstile is
deliberately unverified and that "when a `TURNSTILE_SECRET_KEY` exists, the
check belongs exactly here". That comment is replaced along with the no-op. A
null token there still skips siteverify entirely — it means a reconnect whose
single-use token is already spent.

## Client

### Entry point

A "Report a bug or idea" button in `HelpModal`, following the path
`TroubleshootingModal` already uses. Registered as
`modalRouter.register("feedback", { tag: "feedback-modal", pageId: "page-feedback" })`
so it is also reachable by URL.

### Form

| Field   | Rules                                               |
| ------- | --------------------------------------------------- |
| Type    | Three buttons: Bug / Idea / Other. Defaults to Bug. |
| Message | Required, 10–4000 chars, live character counter.    |
| Email   | Optional, shown to guests only.                     |

### Auto-collected context

`clientVersion` (GIT_COMMIT), `userAgent`, `language`, `screen`, `instanceId`
(web/desktop/crazygames), `currentPage`.

Shown to the user in a collapsible "Technical details" block. Collecting
diagnostics is fine; collecting them invisibly is not, and a player who can see
the payload can tell you when it is wrong.

Deliberately **not** collected: game state or replay data (large, and a bug
report should not quietly ship a match transcript), and the IP — the backend
derives that from the connection, where it cannot be forged.

### Turnstile integration

Guests only, `appearance: "interaction-only"` so it stays invisible unless
Cloudflare wants a challenge.

Requires refactoring `getTurnstileToken()` in `Main.ts`, which currently
hardcodes `#turnstile-container` and would collide with the join flow's widget.
New signature takes a container selector. The existing `alert()` on error is
replaced by an inline message that disables submit; the join flow keeps its
current behaviour.

### States

`idle → submitting → success | error`

Submit is disabled while in flight, so a double-click cannot produce two
reports. Success resets the form and shows a confirmation. A 429 renders the
message with real minutes from `Retry-After`.

### i18n

Every user-visible string goes through `translateText()`, with new keys added
to `resources/lang/en.json` only. No other translation file is touched
(managed via Crowdin).

## Testing

Backend, following the existing Vitest patterns in `backend/src/services/`:

- `rateLimit.test.ts` — allows under limit; blocks at limit; TTL drives the
  retry hint; **fails open when Redis throws**.
- `turnstile.test.ts` — passed/failed/unavailable mapping; no secret configured
  → `unavailable`; siteverify timeout → `unavailable`, not `failed`.
- `feedback.test.ts` — insert round-trip; guest report stores `userId: null`;
  IP truncation for both IPv4 and IPv6; `contactEmail` dropped for logged-in
  users.
- Route-level: 400 on short message, 403 on rejected token, 429 shape includes
  `Retry-After`, 201 returns an id.

No changes to `src/core/`, so its "all changes must include tests" rule is not
triggered. Client modal logic is thin and covered by the route tests plus
manual verification via the `run-openfront` skill.

## Out of scope

- The admin area itself (reading, triaging, changing status). This design only
  ensures the data shape supports it.
- Notification of new reports (Discord webhook, email). The service is written
  so this is a small addition later.
- Attachments and screenshots.
- Applying the new rate limiter to other existing endpoints.
