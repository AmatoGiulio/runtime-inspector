import { randomBytes } from "node:crypto";

/**
 * The broker listens on 0.0.0.0 and an authenticated panel can request source
 * write-back, so the session token must not be guessable: 32 random bytes
 * (256 bits), hex-encoded so it stays URL-safe in `?token=…`.
 */
export const SESSION_TOKEN_BYTES = 32;

export function createSessionToken(): string {
  return randomBytes(SESSION_TOKEN_BYTES).toString("hex");
}
