import { afterEach, describe, expect, it, vi } from "vitest";
import { assetUrl, getCdnBase } from "../src/core/AssetUrls";

/**
 * Regression cover for the bug that made every deployed game fail with
 * "Worker initialization timeout".
 *
 * The game worker is created from a blob: URL, and a blob worker has no base
 * to resolve a root-relative path against — `fetch("/_assets/maps/x.json")`
 * there throws "Failed to parse URL". Without a CDN the asset URL was exactly
 * that, so map loading died and the worker never reported ready.
 *
 * Asset URLs handed to the worker must therefore be absolute.
 */
describe("asset URLs without a CDN", () => {
  afterEach(() => {
    delete globalThis.__CDN_BASE__;
    delete globalThis.__ASSET_MANIFEST__;
    vi.unstubAllGlobals();
  });

  it("falls back to the page origin so blob workers can fetch", () => {
    globalThis.__CDN_BASE__ = "";
    expect(getCdnBase()).toBe(location.origin);
  });

  it("produces an absolute, parseable map URL", () => {
    globalThis.__CDN_BASE__ = "";
    globalThis.__ASSET_MANIFEST__ = {
      "maps/scandinavia/manifest.json":
        "/_assets/maps/scandinavia/manifest.1dd9093adfee.json",
    };

    const url = assetUrl("maps/scandinavia/manifest.json");

    // The actual failure mode: `new URL(relative)` throws, which is what
    // fetch() does inside a worker with no document base.
    expect(() => new URL(url)).not.toThrow();
    expect(url).toBe(
      `${location.origin}/_assets/maps/scandinavia/manifest.1dd9093adfee.json`,
    );
  });

  it("still prefers an explicitly configured CDN", () => {
    globalThis.__CDN_BASE__ = "https://cdn.example.com";
    globalThis.__ASSET_MANIFEST__ = {
      "maps/europe/map.bin": "/_assets/maps/europe/map.abc.bin",
    };

    expect(assetUrl("maps/europe/map.bin")).toBe(
      "https://cdn.example.com/_assets/maps/europe/map.abc.bin",
    );
  });

  it("returns an empty base where there is no location at all", () => {
    globalThis.__CDN_BASE__ = "";
    vi.stubGlobal("location", undefined);
    expect(getCdnBase()).toBe("");
  });
});
