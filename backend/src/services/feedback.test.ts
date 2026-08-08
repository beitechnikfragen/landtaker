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

  it("rejects a compressed address with only one known group", () => {
    // "fe80::" would be a /16 — too coarse to identify a network usefully,
    // so it is worth nothing as a stored prefix.
    expect(truncateIp("fe80::1")).toBeNull();
    expect(truncateIp("2001::1")).toBeNull();
  });

  it("keeps a compressed address with two known groups", () => {
    // A /32 rather than the usual /48: coarser than the target, which errs
    // toward more privacy, not less.
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
