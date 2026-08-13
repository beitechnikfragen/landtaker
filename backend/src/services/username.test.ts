import { describe, expect, it } from "vitest";
import {
  checkUsernameShape,
  cooldownRemaining,
  USERNAME_CHANGE_COOLDOWN_DAYS,
} from "./username.ts";

/**
 * The account name is the handle other players see in the friends list, party
 * roster and social chat, and the shape rules are what keep two accounts from
 * rendering identically — or from smuggling the verified check.
 *
 * Everything here is a pure function precisely so it can be tested: the suite
 * has no Postgres, and a name rule only exercised against a live database is a
 * rule that is not exercised.
 */

describe("checkUsernameShape", () => {
  it("accepts an ordinary name", () => {
    const result = checkUsernameShape("Commander");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.base).toBe("Commander");
  });

  it("accepts digits, underscore and hyphen", () => {
    for (const name of ["unit_01", "red-baron", "Player2"]) {
      expect(checkUsernameShape(name).ok).toBe(true);
    }
  });

  it("accepts single spaces between words", () => {
    const result = checkUsernameShape("Iron Duke");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.base).toBe("Iron Duke");
  });

  it("trims the edges rather than rejecting them", () => {
    const result = checkUsernameShape("  Commander  ");
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.base).toBe("Commander");
  });

  it("rejects consecutive spaces, which would render alike", () => {
    // "Iron  Duke" and "Iron Duke" must not be two different accounts that
    // look the same in a friends list.
    expect(checkUsernameShape("Iron  Duke").ok).toBe(false);
  });

  it("rejects a dot, which would fake the verified check", () => {
    // The dot separates base from discriminator; a base containing one renders
    // as an already-suffixed name and the client reads no-dot as verified.
    const result = checkUsernameShape("Commander.0001");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("invalid");
  });

  it("rejects names that are too short or too long", () => {
    expect(checkUsernameShape("ab").ok).toBe(false);
    expect(checkUsernameShape("a".repeat(21)).ok).toBe(false);
    // The boundaries themselves are fine.
    expect(checkUsernameShape("abc").ok).toBe(true);
    expect(checkUsernameShape("a".repeat(20)).ok).toBe(true);
  });

  it("rejects unicode and punctuation", () => {
    for (const name of ["Kömmander", "Commander!", "Command@r", "指揮官"]) {
      expect(checkUsernameShape(name).ok).toBe(false);
    }
  });

  it("rejects an empty or whitespace-only name", () => {
    expect(checkUsernameShape("").ok).toBe(false);
    expect(checkUsernameShape("     ").ok).toBe(false);
  });

  it("reports profanity distinctly from a malformed name", () => {
    // The client maps these to different messages, so they must not collapse.
    const profane = checkUsernameShape("fuck");
    expect(profane.ok).toBe(false);
    if (!profane.ok) expect(profane.error.code).toBe("profane");
  });

  it("gives a reason a player can act on", () => {
    const result = checkUsernameShape("ab");
    expect(result.ok).toBe(false);
    if (!result.ok && result.error.code === "invalid") {
      expect(result.error.reason).toMatch(/short/i);
    }
  });
});

describe("cooldownRemaining", () => {
  const now = new Date("2026-01-01T00:00:00Z");

  it("allows a change when no cooldown was ever set", () => {
    expect(cooldownRemaining(null, now)).toBeNull();
  });

  it("allows a change once the cooldown has passed", () => {
    expect(cooldownRemaining(new Date("2025-12-31T23:59:59Z"), now)).toBeNull();
  });

  it("allows a change exactly at the boundary", () => {
    // Being one tick late should not cost another full wait.
    expect(cooldownRemaining(now, now)).toBeNull();
  });

  it("reports whole seconds left while the cooldown runs", () => {
    const later = new Date(now.getTime() + 90 * 1000);
    expect(cooldownRemaining(later, now)).toBe(90);
  });

  it("rounds a partial second up, never down to zero", () => {
    // Retry-After: 0 would invite an immediate retry that fails again.
    const later = new Date(now.getTime() + 1);
    expect(cooldownRemaining(later, now)).toBe(1);
  });

  it("covers the configured cooldown window", () => {
    const later = new Date(
      now.getTime() + USERNAME_CHANGE_COOLDOWN_DAYS * 24 * 60 * 60 * 1000,
    );
    expect(cooldownRemaining(later, now)).toBe(
      USERNAME_CHANGE_COOLDOWN_DAYS * 24 * 60 * 60,
    );
  });
});
