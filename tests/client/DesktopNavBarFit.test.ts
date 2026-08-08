import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The top bar has to seat the brand, eight tabs and the status cells in one
 * row. It repeatedly did not: fixed padding plus a fixed-size mark overflowed
 * the row by ~100px at 1280, which pushed the wordmark across its divider and
 * clipped the account avatar off the right edge.
 *
 * Layout itself needs a browser to verify (and is checked that way), but the
 * mechanism that keeps it fitting — fluid sizing — is asserted here so a later
 * edit back to fixed values fails loudly instead of silently clipping.
 */
const root = join(import.meta.dirname, "../..");
const navBar = readFileSync(
  join(root, "src/client/components/DesktopNavBar.ts"),
  "utf8",
);
const primitives = readFileSync(
  join(root, "src/client/styles/core/landtaker.css"),
  "utf8",
);

describe("desktop nav bar sizing", () => {
  it("scales tab padding with the viewport", () => {
    expect(primitives).toMatch(
      /\.lt-nav-item\s*\{[\s\S]*?padding:\s*0\s*clamp\(/,
    );
  });

  it("scales the brand mark instead of pinning it", () => {
    expect(navBar).toMatch(/h-\[clamp\([^\]]+\)\]\s+w-\[clamp\(/);
  });

  it("scales the wordmark", () => {
    // The class list and the LANDTAKER text sit on separate lines in the
    // template, so match across them.
    expect(navBar).toMatch(/text-\[clamp\([^\]]+\)\][\s\S]{0,200}LANDTAKER/);
  });

  it("lets the brand column give up space", () => {
    // Without `shrink`, flex refuses to compress the widest item and the row
    // overflows to the right no matter how small the tabs get.
    expect(navBar).toMatch(/border-r border-lt-700 shrink min-w-0/);
  });

  it("never wraps a tab onto a second line", () => {
    expect(primitives).toMatch(
      /\.lt-nav-item\s*\{[\s\S]*?white-space:\s*nowrap/,
    );
  });
});
