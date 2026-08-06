import { exportJWK, generateKeyPair } from "jose";

/**
 * Prints an Ed25519 private key as a single-line JWK for JWT_PRIVATE_KEY.
 * Ed25519 because the game verifies with `algorithms: ["EdDSA"]` and accepts
 * nothing else.
 */
const { privateKey } = await generateKeyPair("EdDSA", { extractable: true });
const jwk = await exportJWK(privateKey);

console.log("Add this to backend/.env (keep it secret, never commit it):\n");
console.log(
  `JWT_PRIVATE_KEY='${JSON.stringify({
    ...jwk,
    kid: "openfront-signing-key",
    alg: "EdDSA",
    use: "sig",
  })}'`,
);
