import {
  AdminFeedbackListResponseSchema,
  FeedbackStatusSchema,
} from "@game/AdminApiSchemas.ts";
import { describe, expect, it } from "vitest";

/**
 * The feedback triage contract. The panel drops a response that fails to
 * parse, so a shape mismatch here would surface as an empty list with no
 * error — asserting the exact body the route builds catches that at build
 * time instead.
 */
describe("GET /admin/feedback contract", () => {
  const row = {
    id: "123e4567-e89b-12d3-a456-426614174000",
    type: "bug",
    status: "new",
    message: "the map is upside down",
    userId: "123e4567-e89b-12d3-a456-426614174001",
    username: "Boss",
    contactEmail: null,
    context: { version: "1.2.3" },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  it("accepts a populated report", () => {
    const result = AdminFeedbackListResponseSchema.safeParse({
      reports: [row],
      total: 1,
      counts: { new: 1 },
    });
    expect(result.success).toBe(true);
  });

  it("accepts a guest report, which has no user", () => {
    // Guests are identified by contactEmail; userId and username are null.
    const result = AdminFeedbackListResponseSchema.safeParse({
      reports: [
        { ...row, userId: null, username: null, contactEmail: "a@b.co" },
      ],
      total: 1,
      counts: { new: 1 },
    });
    expect(result.success).toBe(true);
  });

  it("accepts a report with no diagnostics", () => {
    const result = AdminFeedbackListResponseSchema.safeParse({
      reports: [{ ...row, context: null }],
      total: 1,
      counts: {},
    });
    expect(result.success).toBe(true);
  });

  it("accepts an empty list", () => {
    const result = AdminFeedbackListResponseSchema.safeParse({
      reports: [],
      total: 0,
      counts: {},
    });
    expect(result.success).toBe(true);
  });

  it("rejects a response missing counts", () => {
    // The filter chips read counts; without it they would silently show none.
    const result = AdminFeedbackListResponseSchema.safeParse({
      reports: [],
      total: 0,
    });
    expect(result.success).toBe(false);
  });
});

describe("FeedbackStatusSchema", () => {
  it("covers the states the schema comment reserved", () => {
    expect(FeedbackStatusSchema.options).toEqual([
      "new",
      "triaged",
      "resolved",
      "rejected",
    ]);
  });

  it("refuses an unknown status", () => {
    // The PATCH route validates with this, so a typo cannot write a state the
    // filter chips can never select again.
    expect(FeedbackStatusSchema.safeParse("done").success).toBe(false);
  });
});
