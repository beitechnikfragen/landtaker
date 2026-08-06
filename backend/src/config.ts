import { z } from "zod";

/**
 * Config is parsed once at boot and fails loudly. A backend that starts with a
 * missing secret and only breaks under load is worse than one that never
 * starts.
 */
const ConfigSchema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),

  // 8787 is not arbitrary: the game server derives its API base from the JWT
  // audience, and for `localhost` that resolves to http://localhost:8787
  // (see ServerEnv.jwtIssuer in src/server/ServerEnv.ts). Keeping this port
  // means the game needs no code change to talk to us.
  PORT: z.coerce.number().int().positive().default(8787),
  HOST: z.string().default("0.0.0.0"),

  // Ports 5433/6380 (not the defaults) because docker-compose.yml maps them
  // there — a locally installed Postgres/Redis often already owns 5432/6379,
  // and connections would silently reach the wrong server.
  DATABASE_URL: z
    .string()
    .default("postgres://openfront:openfront@localhost:5433/openfront"),
  REDIS_URL: z.string().default("redis://localhost:6380"),

  // Must match the game's expectations exactly. The game verifies iss/aud, so
  // a mismatch here surfaces as "invalid token" with no further detail.
  JWT_ISSUER: z.string().default("http://localhost:8787"),
  JWT_AUDIENCE: z.string().default("localhost"),
  ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().positive().default(3600),

  // Ed25519 private key (JWK, JSON). Generate with `npm run keys:generate`.
  // Absent in development => an ephemeral key pair is created at boot, so a
  // fresh clone runs with zero setup. Tokens then die with the process.
  JWT_PRIVATE_KEY: z.string().optional(),

  // Shared secret for the game server's `x-api-key` header on server-to-server
  // routes. The dev default mirrors the game's own dev API key so `npm run dev`
  // works out of the box; it must be replaced in production.
  API_KEY: z.string().default("WARNING_DEV_API_KEY_DO_NOT_USE_IN_PRODUCTION"),

  CORS_ORIGIN: z.string().default("http://localhost:9000"),
});

export type Config = z.infer<typeof ConfigSchema>;

function load(): Config {
  const parsed = ConfigSchema.safeParse(process.env);
  if (!parsed.success) {
    console.error("Invalid configuration:\n" + z.prettifyError(parsed.error));
    process.exit(1);
  }
  const config = parsed.data;

  if (config.NODE_ENV === "production") {
    const missing: string[] = [];
    if (!config.JWT_PRIVATE_KEY) missing.push("JWT_PRIVATE_KEY");
    if (config.API_KEY.startsWith("WARNING_DEV_")) missing.push("API_KEY");
    if (missing.length > 0) {
      console.error(
        `Refusing to start in production without: ${missing.join(", ")}. ` +
          `An ephemeral signing key would invalidate every token on restart, ` +
          `and the dev API key is public.`,
      );
      process.exit(1);
    }
  }

  return config;
}

export const config = load();
export const isProduction = config.NODE_ENV === "production";
