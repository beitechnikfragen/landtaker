import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      // Mirror the tsconfig paths so tests import the game's real schemas.
      "@game": fileURLToPath(new URL("../src/core", import.meta.url)),
      // The game resolves bare "resources/..." imports through its own Vite
      // config; Schemas.ts pulls in QuickChat.json that way.
      resources: fileURLToPath(new URL("../resources", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
