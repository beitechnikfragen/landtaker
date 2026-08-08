import { z } from "zod";

/**
 * Wire contracts for the admin panel (`<admin-modal>` in the client, the
 * `/admin/*` routes in the backend). Shared rather than duplicated so a change
 * to a field breaks both sides at compile time instead of one of them at
 * runtime.
 *
 * Everything here sits behind `requireAdmin`. Nothing in this file is served to
 * ordinary players, so unlike UserMeResponseSchema these shapes do not need to
 * stay forgiving of older servers — panel and backend ship together.
 */

// ---------------------------------------------------------------------------
// Roles
// ---------------------------------------------------------------------------

/**
 * Roles an admin may assign. `root` is deliberately absent: it is the
 * bootstrap role, granted only by a direct database write, so that a
 * compromised admin account cannot mint another root. The backend rejects it
 * again server-side — this schema is a convenience, not the enforcement.
 */
export const AssignableRoleSchema = z.enum([
  "admin",
  "mod",
  "flagged",
  "banned",
]);
export type AssignableRole = z.infer<typeof AssignableRoleSchema>;

// ---------------------------------------------------------------------------
// User search and listing
// ---------------------------------------------------------------------------

/**
 * One row in the admin user table. A summary — the fields needed to recognise
 * an account and see its standing at a glance. `AdminUserDetail` has the rest.
 */
export const AdminUserSummarySchema = z.object({
  id: z.uuid(),
  publicId: z.string(),
  email: z.string().nullable(),
  username: z.string().nullable(),
  role: z.string().nullable(),
  credits: z.number().int(),
  adfree: z.boolean(),
  unlimitedRanked: z.boolean(),
  canCreatePublicLobbies: z.boolean(),
  flareCount: z.number().int(),
  // Null when the account has never had an active ban.
  banned: z.boolean(),
  createdAt: z.iso.datetime(),
  lastSeenAt: z.iso.datetime().nullable(),
});
export type AdminUserSummary = z.infer<typeof AdminUserSummarySchema>;

export const AdminUserListResponseSchema = z.object({
  users: AdminUserSummarySchema.array(),
  /** Total matching the query, not the page size — drives the pager. */
  total: z.number().int(),
});
export type AdminUserListResponse = z.infer<typeof AdminUserListResponseSchema>;

/**
 * Query for GET /admin/users. `q` matches publicId, email, or username as a
 * case-insensitive substring; an exact UUID matches the id directly.
 */
export const AdminUserQuerySchema = z.object({
  q: z.string().trim().max(200).optional(),
  role: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});
export type AdminUserQuery = z.infer<typeof AdminUserQuerySchema>;

// ---------------------------------------------------------------------------
// User detail
// ---------------------------------------------------------------------------

export const AdminBanSchema = z.object({
  id: z.uuid(),
  category: z.string(),
  reason: z.string().nullable(),
  expiresAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
  liftedAt: z.iso.datetime().nullable(),
});
export type AdminBan = z.infer<typeof AdminBanSchema>;

export const AdminIdentitySchema = z.object({
  provider: z.string(),
  providerUserId: z.string(),
  linkedAt: z.iso.datetime(),
});
export type AdminIdentity = z.infer<typeof AdminIdentitySchema>;

export const AdminUserDetailSchema = AdminUserSummarySchema.extend({
  usernameBase: z.string().nullable(),
  usernameDiscriminator: z.string().nullable(),
  usernameStatus: z.string().nullable(),
  flares: z.string().array(),
  identities: AdminIdentitySchema.array(),
  /** Full ban history, newest first — lifted ones included. */
  bans: AdminBanSchema.array(),
});
export type AdminUserDetail = z.infer<typeof AdminUserDetailSchema>;

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

/**
 * PATCH /admin/users/:id. Every field optional: an absent key means "leave
 * alone", which is what lets the panel send only what the operator edited.
 *
 * `role: null` clears the role back to an ordinary player. That is why the
 * field is `.nullable()` rather than merely optional — omission and
 * "set to nothing" are different operations here.
 */
export const AdminUserPatchSchema = z
  .object({
    role: AssignableRoleSchema.nullable().optional(),
    credits: z.number().int().min(0).max(1_000_000_000).optional(),
    adfree: z.boolean().optional(),
    unlimitedRanked: z.boolean().optional(),
    canCreatePublicLobbies: z.boolean().optional(),
    flares: z.string().max(200).array().max(1000).optional(),
  })
  // A patch that changes nothing is far more likely to be a client bug than an
  // intent, and answering 200 to it hides that bug.
  .refine((patch) => Object.keys(patch).length > 0, {
    message: "Patch must change at least one field",
  });
export type AdminUserPatch = z.infer<typeof AdminUserPatchSchema>;

/**
 * Credit adjustment as a delta rather than an absolute. Two admins granting
 * "+100" concurrently should produce +200; two admins each PATCHing an
 * absolute 100 would produce 100 and silently lose one grant.
 */
export const AdminCreditAdjustSchema = z.object({
  delta: z.number().int().min(-1_000_000).max(1_000_000),
  reason: z.string().trim().min(1).max(500),
});
export type AdminCreditAdjust = z.infer<typeof AdminCreditAdjustSchema>;

export const AdminBanCreateSchema = z.object({
  category: z.string().trim().min(1).max(64),
  reason: z.string().trim().max(1000).optional(),
  /**
   * Absent or null is a permanent ban. A duration is easier to get right at a
   * call site than an absolute instant, and avoids the client and server
   * disagreeing about clock skew or timezone.
   */
  durationHours: z
    .number()
    .int()
    .min(1)
    .max(24 * 365 * 10)
    .nullable()
    .optional(),
});
export type AdminBanCreate = z.infer<typeof AdminBanCreateSchema>;

// ---------------------------------------------------------------------------
// Audit log
// ---------------------------------------------------------------------------

/**
 * Every admin mutation writes one of these. The panel can grant credits,
 * change roles, and issue bans; without a record of who did what there is no
 * way to answer that question later, and `root` cannot review its admins.
 */
export const AdminAuditEntrySchema = z.object({
  id: z.uuid(),
  actorId: z.uuid().nullable(),
  actorName: z.string().nullable(),
  action: z.string(),
  /** Subject of the action — a user id for user mutations. */
  targetId: z.string().nullable(),
  /** Action-specific payload; shape varies by `action`, rendered as JSON. */
  detail: z.unknown(),
  createdAt: z.iso.datetime(),
});
export type AdminAuditEntry = z.infer<typeof AdminAuditEntrySchema>;

export const AdminAuditListResponseSchema = z.object({
  entries: AdminAuditEntrySchema.array(),
  total: z.number().int(),
});
export type AdminAuditListResponse = z.infer<
  typeof AdminAuditListResponseSchema
>;
