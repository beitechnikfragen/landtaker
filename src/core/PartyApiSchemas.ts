import { z } from "zod";

/**
 * Wire contract for the party endpoints. Lives in core/ alongside the other
 * API schemas so the backend can import it too — one definition, not two that
 * drift apart.
 */

export const PartyMemberSchema = z.object({
  userId: z.string(),
  publicId: z.string(),
  // Display form as resolved by the server. Never assemble this client-side;
  // a name without a dot is what earns the verified check.
  username: z.string().nullable(),
  isLeader: z.boolean(),
  joinedAt: z.iso.datetime(),
});
export type PartyMember = z.infer<typeof PartyMemberSchema>;

export const PartySchema = z.object({
  id: z.string(),
  inviteCode: z.string(),
  isOpen: z.boolean(),
  maxMembers: z.number().int().positive(),
  leaderId: z.string(),
  members: PartyMemberSchema.array(),
  // Which member is the caller. The client must not have to infer this, and
  // user ids are not otherwise exposed to it. Optional so a response from an
  // older backend still parses (leader-only controls then stay hidden).
  viewerId: z.string().optional(),
});
export type Party = z.infer<typeof PartySchema>;

/** GET /parties/@me — `party` is null when the caller is in none. */
export const PartyResponseSchema = z.object({
  party: PartySchema.nullable(),
});
export type PartyResponse = z.infer<typeof PartyResponseSchema>;

/** Everything that mutates a party answers with the resulting state. */
export const PartyMutationResponseSchema = z.object({
  party: PartySchema,
});

/** POST /parties/leave */
export const LeavePartyResponseSchema = z.object({
  partyId: z.string(),
  deleted: z.boolean(),
});
export type LeavePartyResponse = z.infer<typeof LeavePartyResponseSchema>;

/**
 * Error codes the party routes return in `{ error }`. Kept as a union so the
 * client can map each to its own message rather than showing a raw code.
 */
export const PartyErrorSchema = z.enum([
  "already_in_party",
  "not_found",
  "party_full",
  "not_a_member",
  "not_leader",
  "closed",
]);
export type PartyErrorCode = z.infer<typeof PartyErrorSchema>;
