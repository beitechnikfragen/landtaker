import {
  exportJWK,
  generateKeyPair,
  importJWK,
  type CryptoKey,
  type JWK,
} from "jose";
import { config, isProduction } from "../config.ts";

/**
 * The game verifies tokens with `algorithms: ["EdDSA"]` (src/server/jwt.ts) and
 * takes the FIRST key from our JWKS (`result.data.keys[0]` in ServerEnv). So:
 * Ed25519 only, and the current signing key must be served first.
 */
export const JWT_ALGORITHM = "EdDSA";

const KEY_ID = "openfront-signing-key";

export interface SigningKeys {
  privateKey: CryptoKey;
  /** Verification key. Separate from privateKey — Ed25519 is asymmetric. */
  publicKey: CryptoKey;
  publicJwk: JWK;
}

let cached: SigningKeys | null = null;

/**
 * Loads the configured signing key, or generates an ephemeral one in
 * development. Ephemeral keys mean every restart invalidates outstanding
 * tokens — fine locally, refused at boot in production (see config.ts).
 */
export async function getSigningKeys(): Promise<SigningKeys> {
  if (cached) return cached;

  if (config.JWT_PRIVATE_KEY) {
    let jwk: JWK;
    try {
      jwk = JSON.parse(config.JWT_PRIVATE_KEY) as JWK;
    } catch {
      throw new Error(
        "JWT_PRIVATE_KEY is not valid JSON. Expected a JWK object — " +
          "generate one with `npm run keys:generate`.",
      );
    }
    if (jwk.kty !== "OKP" || jwk.crv !== "Ed25519") {
      throw new Error(
        `JWT_PRIVATE_KEY must be an Ed25519 OKP key (got kty=${jwk.kty}, ` +
          `crv=${jwk.crv}). The game only accepts EdDSA signatures.`,
      );
    }
    const privateKey = (await importJWK(jwk, JWT_ALGORITHM)) as CryptoKey;
    // Strip the private component `d` before publishing or importing as public.
    const { d: _discard, ...rest } = jwk;
    const publicJwk: JWK = {
      ...rest,
      kid: jwk.kid ?? KEY_ID,
      alg: JWT_ALGORITHM,
      use: "sig",
    };
    const publicKey = (await importJWK(publicJwk, JWT_ALGORITHM)) as CryptoKey;
    cached = { privateKey, publicKey, publicJwk };
    return cached;
  }

  if (isProduction) {
    // Unreachable: config.ts exits first. Kept so this stays true if that
    // guard is ever relaxed.
    throw new Error("JWT_PRIVATE_KEY is required in production");
  }

  const { privateKey, publicKey } = await generateKeyPair(JWT_ALGORITHM, {
    extractable: true,
  });
  const publicJwk = await exportJWK(publicKey);
  console.warn(
    "No JWT_PRIVATE_KEY set — generated an ephemeral Ed25519 key. " +
      "Tokens will not survive a restart. Run `npm run keys:generate` for a " +
      "stable local key.",
  );
  cached = {
    privateKey,
    publicKey,
    publicJwk: { ...publicJwk, kid: KEY_ID, alg: JWT_ALGORITHM, use: "sig" },
  };
  return cached;
}

/** Test seam — drops the cached key so a fresh one is built on next use. */
export function resetSigningKeysForTests(): void {
  cached = null;
}
