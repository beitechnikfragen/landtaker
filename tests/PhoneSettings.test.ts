import { beforeEach, describe, expect, it } from "vitest";
import { UserSettings } from "../src/core/game/UserSettings";

describe("phone user settings", () => {
  let s: UserSettings;

  beforeEach(() => {
    localStorage.clear();
    (UserSettings as any).cache = new Map();
    s = new UserSettings();
  });

  it("defaults to normal mode (phone is on by default)", () => {
    expect(s.phoneMode()).toBe("normal");
  });

  it("round-trips the mode", () => {
    s.setPhoneMode("dnd");
    expect(s.phoneMode()).toBe("dnd");
  });

  it("falls back to normal on a corrupted value", () => {
    localStorage.setItem("settings.phoneMode", "nonsense");
    (UserSettings as any).cache = new Map();
    expect(new UserSettings().phoneMode()).toBe("normal");
  });

  it("defaults allies-only to off", () => {
    expect(s.phoneAlliesOnly()).toBe(false);
  });

  it("round-trips allies-only", () => {
    s.setPhoneAlliesOnly(true);
    expect(s.phoneAlliesOnly()).toBe(true);
  });

  it("defaults the phone volume to full", () => {
    expect(s.phoneVolume()).toBe(1);
  });

  it("round-trips the phone volume", () => {
    s.setPhoneVolume(0.4);
    expect(s.phoneVolume()).toBeCloseTo(0.4);
  });
});
