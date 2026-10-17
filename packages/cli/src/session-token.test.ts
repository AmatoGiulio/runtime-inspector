import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { SESSION_TOKEN_BYTES, createSessionToken } from "./session-token.js";

describe("createSessionToken", () => {
  it("returns 256 bits of randomness as 64 hex characters", () => {
    expect(SESSION_TOKEN_BYTES).toBe(32);
    const token = createSessionToken();
    expect(token).toMatch(/^[0-9a-f]{64}$/);
  });

  it("returns a different token on every call", () => {
    const tokens = new Set(Array.from({ length: 1000 }, () => createSessionToken()));
    expect(tokens.size).toBe(1000);
  });

  it("is the only source of the `dev` session token", () => {
    const cli = readFileSync(new URL("./index.ts", import.meta.url), "utf-8");
    expect(cli).toContain("const token = createSessionToken();");
    expect(cli).not.toMatch(/randomBytes\(/);
  });
});
