import tailwindcss from "@tailwindcss/vite";
import fs from "fs";
import http from "http";
import { lookup as lookupMime } from "mrmime";
import path from "path";
import { fileURLToPath } from "url";
import { defineConfig, loadEnv, type Plugin } from "vite";
import { createHtmlPlugin } from "vite-plugin-html";
import {
  type AssetManifest,
  buildAssetUrl,
  rewriteAssetsForCdn,
} from "./src/core/AssetUrls";
import {
  buildPublicAssetManifest,
  copyRootPublicFiles,
  createHashedPublicAssetFiles,
  getBrandDir,
  getProprietaryDir,
  getResourcesDir,
  writePublicAssetManifest,
} from "./src/server/PublicAssetManifest";

// Vite already handles these, but its good practice to define them explicitly
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Serves the non-publicDir asset roots (brand/, proprietary/) in dev. In
// production these are hashed into the manifest and uploaded to the CDN
// instead; see createHashedPublicAssetFiles.
function serveExtraAssetDirs(
  extraDirs: string[],
  resourcesDir: string,
): Plugin {
  return {
    name: "serve-extra-asset-dirs",
    configureServer(server) {
      // Must run before Vite's htmlFallback; skip when resources/ has the file
      // so publicDir keeps precedence.
      server.middlewares.use((req, res, next) => {
        if (!req.url) return next();
        const rel = decodeURIComponent(
          new URL(req.url, "http://x").pathname,
        ).replace(/^\//, "");
        if (rel.includes("..")) return next();
        if (fs.existsSync(path.join(resourcesDir, rel))) return next();
        // First dir that has the file wins, matching resolveSourceDir's order.
        const filePath = extraDirs
          .map((dir) => path.join(dir, rel))
          .find((p) => fs.existsSync(p) && fs.statSync(p).isFile());
        if (!filePath) return next();
        const mime = lookupMime(filePath);
        if (mime) res.setHeader("Content-Type", mime);
        res.setHeader("Cache-Control", "no-store");
        fs.createReadStream(filePath).pipe(res);
      });
    },
  };
}

// Dev-only stand-in for the nginx random-worker routing (the openfront_workers
// upstream). Forwards these prefix-less POSTs to a randomly chosen worker port
// so the worker can mint a self-owned id. Runs as direct middleware (before
// vite's /api proxy).
const RANDOM_WORKER_PATHS = ["/api/create_game", "/api/adminbot/create_game"];
function randomWorkerCreateProxy(numWorkers: number): Plugin {
  return {
    name: "random-worker-create-proxy",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (req.method !== "POST") return next();
        const path = (req.url ?? "").split("?")[0];
        if (!RANDOM_WORKER_PATHS.includes(path)) return next();
        const port = 3001 + Math.floor(Math.random() * numWorkers);
        const proxyReq = http.request(
          {
            host: "localhost",
            port,
            path,
            method: "POST",
            headers: req.headers,
          },
          (proxyRes) => {
            res.writeHead(proxyRes.statusCode ?? 502, proxyRes.headers);
            proxyRes.pipe(res);
          },
        );
        proxyReq.on("error", (err) => {
          res.statusCode = 502;
          res.end(`create proxy error: ${err.message}`);
        });
        req.pipe(proxyReq);
      });
    },
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const isProduction = mode === "production";
  const devNumWorkers = parseInt(env.NUM_WORKERS ?? "2", 10);
  const resourcesDir = getResourcesDir(__dirname);
  const proprietaryDir = getProprietaryDir(__dirname);
  const brandDir = getBrandDir(__dirname);
  const sourceDirs = [resourcesDir, brandDir, proprietaryDir];
  const assetManifest: AssetManifest = isProduction
    ? buildPublicAssetManifest(sourceDirs)
    : {};
  const cdnBase = env.CDN_BASE ?? "";
  // Origin used in canonical/og:url. DOMAIN is unset in a plain dev checkout,
  // where the dev server is the only consumer of these tags anyway.
  const devSiteUrl = env.DOMAIN ? `https://${env.DOMAIN}` : "";
  const htmlAssetData = {
    assetManifest: JSON.stringify(assetManifest),
    cdnBase: JSON.stringify(cdnBase),
    gameEnv: JSON.stringify(env.GAME_ENV ?? "dev"),
    numWorkers: JSON.stringify(parseInt(env.NUM_WORKERS ?? "2", 10)),
    turnstileSiteKey: JSON.stringify(
      env.TURNSTILE_SITE_KEY ?? "1x00000000000000000000AA",
    ),
    jwtAudience: JSON.stringify(env.DOMAIN ?? "localhost"),
    instanceId: JSON.stringify(env.INSTANCE_ID ?? "DEV_ID"),
    manifestHref: buildAssetUrl("manifest.json", assetManifest, cdnBase),
    faviconHref: buildAssetUrl("images/Favicon.svg", assetManifest, cdnBase),
    // Mirrors RenderHtml.ts, which serves these same tags in production.
    siteUrl: devSiteUrl,
    socialImageUrl: (() => {
      const url = buildAssetUrl(
        "images/social/og-1200x630.png",
        assetManifest,
        cdnBase,
      );
      return /^https?:\/\//i.test(url) ? url : `${devSiteUrl}${url}`;
    })(),
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
  };

  // Vite's HTML transform replaces the source <script src="/src/client/Main.ts">
  // with the hashed bundle URL and injects <link rel="modulepreload"> /
  // <link rel="stylesheet"> tags. rewriteAssetsForCdn rewrites those refs to
  // an EJS placeholder so RenderHtml.ts can prefix them with CDN_BASE at
  // request time.
  const injectCdnBaseTemplate = (): Plugin => ({
    name: "inject-cdn-base-template",
    apply: "build" as const,
    enforce: "post",
    transformIndexHtml: rewriteAssetsForCdn,
  });

  let viteBundleFiles: string[] = [];
  const syncHashedPublicAssets = (): Plugin => ({
    name: "sync-hashed-public-assets",
    apply: "build" as const,
    writeBundle(_options, bundle) {
      viteBundleFiles = Object.keys(bundle);
    },
    closeBundle() {
      const outDir = path.join(__dirname, "static");
      copyRootPublicFiles(resourcesDir, outDir);
      // Run the source→hashed copy first; createHashedPublicAssetFiles iterates
      // assetManifest and expects every key to resolve to a file in resources/
      // or proprietary/. Vite's bundle output (assets/...) doesn't, so it's
      // merged in after.
      createHashedPublicAssetFiles(sourceDirs, outDir, assetManifest);
      // Track Vite's own bundle output (vendor chunks, JS, CSS, workers under
      // static/assets/) in the manifest so the deploy-time R2 upload covers
      // them alongside the hashed source assets. Skip non-assets/ emits like
      // index.html — those are served by the app, not from R2.
      for (const fileName of viteBundleFiles) {
        if (!fileName.startsWith("assets/")) continue;
        assetManifest[fileName] = `/${fileName}`;
      }
      writePublicAssetManifest(outDir, assetManifest);
    },
  });

  // In dev, redirect visits to /w*/game/* to "/" so Vite serves the index.html.
  const devGameHtmlBypass = (req?: {
    url?: string;
    method?: string;
    headers?: { accept?: string | string[] };
  }) => {
    if (req?.method !== "GET") return undefined;
    const accept = req.headers?.accept;
    const acceptValue = Array.isArray(accept)
      ? accept.join(",")
      : (accept ?? "");
    if (!acceptValue.includes("text/html")) return undefined;
    if (!req.url) return undefined;
    if (/^\/w\d+\/game\/[^/]+/.test(req.url)) {
      return "/";
    }
    return undefined;
  };

  return {
    test: {
      globals: true,
      environment: "jsdom",
      setupFiles: "./tests/setup.ts",
      // The backend is a separate project with its own vitest config, deps and
      // aliases. Without this it gets picked up here and fails against the
      // wrong module resolution. Run it with `npm test` inside backend/.
      exclude: ["**/node_modules/**", "**/dist/**", "backend/**"],
    },
    root: "./",
    base: "/",
    publicDir: isProduction ? false : "resources",

    resolve: {
      tsconfigPaths: true,
      alias: {
        resources: path.resolve(__dirname, "resources"),
      },
    },

    plugins: [
      ...(!isProduction
        ? [
            serveExtraAssetDirs([brandDir, proprietaryDir], resourcesDir),
            randomWorkerCreateProxy(devNumWorkers),
          ]
        : []),
      ...(isProduction
        ? []
        : [
            createHtmlPlugin({
              minify: false,
              entry: "/src/client/Main.ts",
              template: "index.html",
              inject: {
                data: {
                  gitCommit: JSON.stringify("DEV"),
                  ...htmlAssetData,
                },
              },
            }),
          ]),
      ...(isProduction
        ? [injectCdnBaseTemplate(), syncHashedPublicAssets()]
        : []),
      tailwindcss(),
    ],

    define: {
      __ASSET_MANIFEST__: JSON.stringify(assetManifest),
      "process.env.WEBSOCKET_URL": JSON.stringify(
        isProduction ? "" : "localhost:3000",
      ),
      "process.env.GAME_ENV": JSON.stringify(isProduction ? "prod" : "dev"),
      "process.env.STRIPE_PUBLISHABLE_KEY": JSON.stringify(
        env.STRIPE_PUBLISHABLE_KEY,
      ),
      // Force empty under vitest (mode "test") so the getApiBase localhost-
      // fallback test is deterministic regardless of any API_DOMAIN in the
      // host shell / CI environment.
      "process.env.API_DOMAIN": JSON.stringify(
        mode === "test" ? "" : (env.API_DOMAIN ?? ""),
      ),
      // Add other process.env variables if needed, OR migrate code to import.meta.env
    },

    build: {
      outDir: "static", // Webpack outputs to 'static', assuming we want to keep this.
      emptyOutDir: true,
      assetsDir: "assets", // Sub-directory for assets
      rollupOptions: {
        output: {
          manualChunks: (id) => {
            const vendorModules = ["howler", "zod"];
            if (vendorModules.some((module) => id.includes(module))) {
              return "vendor";
            }
          },
        },
      },
    },

    server: {
      port: 9000,
      host: process.env.VITE_HOST === "lan",
      // Automatically open the browser when the server starts
      open: process.env.SKIP_BROWSER_OPEN !== "true",
      proxy: {
        "/lobbies": {
          target: "ws://localhost:3000",
          ws: true,
          changeOrigin: true,
        },
        // Worker proxies
        "/w0": {
          target: "ws://localhost:3001",
          ws: true,
          secure: false,
          changeOrigin: true,
          bypass: (req) => devGameHtmlBypass(req),
          rewrite: (path) => path.replace(/^\/w0/, ""),
        },
        "/w1": {
          target: "ws://localhost:3002",
          ws: true,
          secure: false,
          changeOrigin: true,
          bypass: (req) => devGameHtmlBypass(req),
          rewrite: (path) => path.replace(/^\/w1/, ""),
        },
        // API proxies
        "/api": {
          target: "http://localhost:3000",
          changeOrigin: true,
          secure: false,
        },
      },
    },
  };
});
