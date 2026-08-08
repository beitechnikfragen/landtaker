import ejs from "ejs";
import type { Response } from "express";
import fs from "fs/promises";
import { type AssetManifest, buildAssetUrl } from "../core/AssetUrls";
import { setNoStoreHeaders } from "./NoStoreHeaders";
import { getRuntimeAssetManifest } from "./RuntimeAssetManifest";
import { ServerEnv } from "./ServerEnv";

const APP_SHELL_CACHE_CONTROL =
  "public, max-age=0, s-maxage=300, stale-while-revalidate=86400, stale-if-error=86400";

const appShellContentCache = new Map<string, Promise<string>>();

/**
 * The public origin this deployment answers on, e.g. "https://landtaker.io".
 *
 * Derived from DOMAIN rather than hardcoded so a staging deploy advertises
 * itself in its own canonical and og:url instead of pointing crawlers and link
 * previews at production. Falls back to a relative-safe empty string in dev,
 * where DOMAIN is often unset.
 */
function siteUrl(): string {
  const domain = ServerEnv.domain();
  if (!domain) return "";
  return `https://${domain}`;
}

/**
 * An asset URL that is safe to hand to an external scraper.
 *
 * buildAssetUrl returns a root-relative path when no CDN is configured, and a
 * root-relative og:image is dropped by every link-preview scraper — they fetch
 * it with no page context to resolve against. Prefixing with the site origin
 * makes it absolute; when CDN_BASE is set the value is already absolute and is
 * returned unchanged.
 */
function absoluteAssetUrl(
  assetPath: string,
  assetManifest: AssetManifest,
  cdnBase: string,
): string {
  const url = buildAssetUrl(assetPath, assetManifest, cdnBase);
  if (/^https?:\/\//i.test(url)) return url;
  return `${siteUrl()}${url}`;
}

export async function renderHtmlContent(htmlPath: string): Promise<string> {
  const htmlContent = await fs.readFile(htmlPath, "utf-8");
  const assetManifest = await getRuntimeAssetManifest();
  const cdnBase = ServerEnv.cdnBase();
  return ejs.render(htmlContent, {
    gitCommit: JSON.stringify(ServerEnv.gitCommit()),
    assetManifest: JSON.stringify(assetManifest),
    cdnBase: JSON.stringify(cdnBase),
    // Raw (unquoted) value for use as a URL prefix in the index.html template,
    // e.g. <script src="<%- cdnBaseRaw %>/assets/index-XXX.js">. The Vite
    // build plugin inject-cdn-base-template rewrites Vite's emitted /assets/
    // refs to use this placeholder.
    cdnBaseRaw: cdnBase,
    gameEnv: JSON.stringify(ServerEnv.gameEnvName()),
    numWorkers: JSON.stringify(ServerEnv.numWorkers()),
    turnstileSiteKey: JSON.stringify(ServerEnv.turnstileSiteKey()),
    jwtAudience: JSON.stringify(ServerEnv.jwtAudience()),
    instanceId: JSON.stringify(ServerEnv.instanceId()),
    manifestHref: buildAssetUrl("manifest.json", assetManifest, cdnBase),
    faviconHref: buildAssetUrl("images/Favicon.svg", assetManifest, cdnBase),
    siteUrl: siteUrl(),
    // Link-preview card. Absolute, because the scrapers behind Discord,
    // WhatsApp and Slack fetch og:image with no page to resolve against.
    socialImageUrl: absoluteAssetUrl(
      "images/social/og-1200x630.png",
      assetManifest,
      cdnBase,
    ),
    gameplayScreenshotUrl: buildAssetUrl(
      "images/GameplayScreenshot.png",
      assetManifest,
      cdnBase,
    ),
    // The plain terrain map, not background.webp — that one carries the old
    // hexagon overlay baked in, which the redesign drops.
    backgroundImageUrl: buildAssetUrl(
      "images/EuropeBackground.webp",
      assetManifest,
      cdnBase,
    ),
    // Our own marks in resources/. The former OpenFront.png / OF.png live in
    // proprietary/ (All Rights Reserved) and must not be used here.
    desktopLogoImageUrl: buildAssetUrl(
      "images/LandtakerLogo.svg",
      assetManifest,
      cdnBase,
    ),
    mobileLogoImageUrl: buildAssetUrl(
      "images/LandtakerMark.svg",
      assetManifest,
      cdnBase,
    ),
  });
}

export async function getAppShellContent(htmlPath: string): Promise<string> {
  let cachedContent = appShellContentCache.get(htmlPath);
  if (!cachedContent) {
    cachedContent = renderHtmlContent(htmlPath).catch((error: unknown) => {
      appShellContentCache.delete(htmlPath);
      throw error;
    });
    appShellContentCache.set(htmlPath, cachedContent);
  }
  return cachedContent;
}

export function clearAppShellContentCache(): void {
  appShellContentCache.clear();
}

export function setAppShellCacheHeaders(res: Response): void {
  res.setHeader("Cache-Control", APP_SHELL_CACHE_CONTROL);
  res.setHeader("Content-Type", "text/html");
}

export function setHtmlNoCacheHeaders(res: Response): void {
  setNoStoreHeaders(res);
  res.setHeader("ETag", "");
  res.setHeader("Content-Type", "text/html");
}

export async function renderAppShell(
  res: Response,
  htmlPath: string,
): Promise<void> {
  const rendered = await getAppShellContent(htmlPath);
  setAppShellCacheHeaders(res);
  res.send(rendered);
}
